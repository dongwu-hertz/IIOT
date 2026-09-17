/**
 * 一个**不依赖任何第三方库**的 SMTP 发信实现（`node:net` + `node:tls`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么手写而不是装一个 mailer（依赖策略的结论）
 * ---------------------------------------------------------------------------
 * 任务允许「最多加一个纯 JS 的 SMTP 客户端」。结论是**不加**，理由有三条，
 * 都是可验证的而不是偏好：
 *
 *   1. **覆盖面很小**：本功能需要的是「连上、打个招呼、AUTH、发一封信（可能
 *      带一个附件）、QUIT」。EHLO / STARTTLS / AUTH PLAIN / AUTH LOGIN /
 *      MAIL FROM / RCPT TO / DATA / QUIT 这八个动词就是全部协议面，
 *      没有队列、没有 DKIM、没有 OAuth、没有连接池。
 *   2. **测试要求反过来说明成本**：任务要求「在测试里立一个本地 stub SMTP
 *      服务器，断言信封、报头和附件」。能对着 stub 断言的前提是**我们知道
 *      自己发了什么字节**；手写的这一段就是那几个字节的生成器，直接断言它
 *      比穿透一层库的模板层更准确。本文件因此约 300 行，其中一半是报头编码。
 *   3. **依赖的代价不对称**：一个 mailer 会带来自己的传递依赖、自己的
 *      版本升级节奏与自己的安全公告面；而这里真正会被用到的能力，
 *      标准的 `node:net`/`node:tls` 已经全部提供。
 *
 * 如果将来要支持 OAuth2 / DKIM / 批量投递，那时候再引一个库是合理的；
 * **现在不是**。
 *
 * ---------------------------------------------------------------------------
 * 实测过的两个行为（写在这里，免得下一个人重新踩）
 * ---------------------------------------------------------------------------
 *  - SMTP 的多行回复（`250-...` 续行 + `250 ...` 结束行）必须等到结束行才能
 *    判定成功，否则会把 `250-STARTTLS` 当成对 `EHLO` 的完整回答，
 *    进而在还没协商 TLS 时就发 `MAIL FROM`。
 *  - 服务器可以在**任何**时刻回 4xx/5xx。这里把「回复码 + 原始行」一起带出去，
 *    因为「535 认证失败」和「连接超时」对用户是完全不同的两件事，
 *    而只给一句「发送失败」等于什么都没说（任务明确要求不得静默丢弃失败）。
 */

import net from 'node:net'
import tls from 'node:tls'
import { EventEmitter } from 'node:events'
import type { LinkageEmailSendResult, LinkageSmtpSecurity } from '@shared/domain/alarm-linkage'

/** 默认超时：一次发信的正常耗时在毫秒级，20 秒已经非常宽松。 */
const DEFAULT_TIMEOUT_MS = 20_000

/** 单行回复的最大长度；防止一台坏掉的服务器把内存吃光。 */
const MAX_LINE_BYTES = 8 * 1024

/** 附件 base64 的折行宽度（RFC 2045 要求 ≤ 76）。 */
const BASE64_LINE_WIDTH = 76

export interface SmtpClientOptions {
  host: string
  port: number
  security: LinkageSmtpSecurity
  /** 留空表示不发 AUTH（部分内网中继允许匿名投递）。 */
  username?: string
  password?: string
  /**
   * 收信方的显示名用的主机名，用于生成 `Message-ID` 与 EHLO 参数。
   * 默认取 `'localhost'`：EHLO 参数用不合法的主机名会被严格的中继拒绝。
   */
  clientName?: string
  timeoutMs?: number
  /** 逐行记录协议往返；测试与失败诊断都用它。 */
  onTranscript?: (line: string) => void
}

/** 一封待发送邮件的**已展开**内容（模板展开由调用方完成）。 */
export interface SmtpEnvelope {
  from: string
  to: string[]
  /** 已经按 RFC 2047 编码过的完整报头值（编码由本文件负责）。 */
  subject: string
  text: string
  attachment?: {
    fileName: string
    contentType: string
    bytes: Uint8Array
  }
}

/** 一条 SMTP 回复。 */
interface SmtpReply {
  code: number
  lines: string[]
}

/** 连接建立阶段的内部状态机用得到的连接类型。 */
type SmtpSocket = net.Socket | tls.TLSSocket

/**
 * 极简的行协议传输层：负责「写一行」「读一条完整回复」「升级 TLS」「收尾」。
 *
 * 独立成类的原因只有一个：让上面的 `SmtpClient` 读起来是 SMTP，而不是
 * 缓冲区拼接。这里的每个方法都只做一件事。
 */
class SmtpTransport extends EventEmitter {
  private socket: SmtpSocket | undefined
  private buffer = ''
  private pending: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void } | undefined
  private closed = false
  private failure: Error | undefined

  constructor(private readonly timeoutMs: number) {
    super()
    /**
     * 把「我发了什么命令」也接进 transcript。
     *
     * 没有这一条时 transcript 里只有服务器的回复，用户看到一串 `250 OK` 却
     * 不知道对应哪条命令——诊断价值大打折扣。服务器回复由 `send()` 逐条
     * `record()`，命令则在这里统一收口，`redact` 过的 AUTH 行因此不会漏出。
     */
    this.on('sent', (line: string) => this.emit('transcript', line))
  }

  /** 建立连接（`tls` 表示隐式 TLS，即 465 那种一上来就握手）。 */
  async connect(host: string, port: number, implicitTls: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      const onConnect = (): void => resolve()

      if (implicitTls) {
        const socket = tls.connect({ host, port, servername: host }, onConnect)
        socket.once('error', onError)
        this.attach(socket)
      } else {
        const socket = net.connect({ host, port }, onConnect)
        socket.once('error', onError)
        this.attach(socket)
      }
    })
  }

  /** 把 STARTTLS 升级到位（明文连接专用）。 */
  async upgradeToTls(host: string): Promise<void> {
    const current = this.socket
    if (!current) throw new Error('SMTP 连接尚未建立')
    // 升级前先把监听摘掉：同一个缓冲区不能同时喂给两个 socket 的解析器。
    current.removeAllListeners('data')
    current.removeAllListeners('error')
    current.removeAllListeners('close')

    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({ socket: current, servername: host }, () => resolve())
      socket.once('error', reject)
      this.attach(socket)
    })
  }

  private attach(socket: SmtpSocket): void {
    this.socket = socket
    this.buffer = ''
    socket.setTimeout(this.timeoutMs)
    socket.on('data', (chunk: Buffer) => this.consume(chunk))
    socket.on('timeout', () => this.fail(new Error(`SMTP 在 ${this.timeoutMs} ms 内没有响应`)))
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => {
      this.closed = true
      if (this.pending) {
        this.fail(this.failure ?? new Error('SMTP 连接被服务器关闭'))
      }
    })
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    if (this.buffer.length > MAX_LINE_BYTES * 64) {
      this.fail(new Error('SMTP 回复过长，已放弃解析'))
      return
    }
    const reply = this.takeReply()
    if (reply && this.pending) {
      const waiter = this.pending
      this.pending = undefined
      waiter.resolve(reply)
    }
  }

  /** 从缓冲区里取出一条**完整**回复（多行回复要等到 `NNN ` 结束行）。 */
  private takeReply(): SmtpReply | undefined {
    const lines: string[] = []
    let cursor = 0
    for (;;) {
      const newline = this.buffer.indexOf('\n', cursor)
      if (newline === -1) return undefined
      const raw = this.buffer.slice(cursor, newline).replace(/\r$/, '')
      cursor = newline + 1
      lines.push(raw)
      // `250-...` 是续行，`250 ...` 是结束行；四字符以下的行按结束处理。
      if (raw.length < 4 || raw[3] !== '-') {
        this.buffer = this.buffer.slice(cursor)
        const code = Number.parseInt(raw.slice(0, 3), 10)
        return { code: Number.isFinite(code) ? code : 0, lines }
      }
    }
  }

  private fail(error: Error): void {
    this.failure = error
    const waiter = this.pending
    this.pending = undefined
    if (waiter) waiter.reject(error)
    this.emit('failure', error)
  }

  /** 读一条回复。 */
  readReply(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.reject(new Error('SMTP 连接已关闭'))
    return new Promise<SmtpReply>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  /** 发一条命令（自动补 CRLF）。`redact` 用于 AUTH 行，避免口令进日志。 */
  async command(line: string, redacted?: string): Promise<SmtpReply> {
    this.write(`${line}\r\n`, redacted !== undefined ? `C: ${redacted}` : `C: ${line}`)
    return this.readReply()
  }

  /** 发原始数据（DATA 段），不读回复。 */
  write(data: string, transcriptLine?: string): void {
    if (!this.socket) throw new Error('SMTP 连接尚未建立')
    this.emit('sent', transcriptLine ?? data.slice(0, 60))
    this.socket.write(data)
  }

  close(): void {
    try {
      this.socket?.end()
    } catch {
      // 收尾是尽力而为：连不上或已经断了都不影响调用方拿结果。
    }
    try {
      this.socket?.destroy()
    } catch {
      // 同上。
    }
  }
}

/**
 * SMTP 客户端。
 *
 * 用法：
 * ```ts
 * const result = await new SmtpClient(options).send(envelope)
 * if (!result.ok) logger.warn(result.error, result.detail)
 * ```
 */
export class SmtpClient {
  private readonly options: SmtpClientOptions
  private readonly transcript: string[] = []

  constructor(options: SmtpClientOptions) {
    this.options = options
  }

  /** 发一封信。**永不抛异常**：失败以 `{ ok: false }` + 真实原因返回。 */
  async send(envelope: SmtpEnvelope): Promise<LinkageEmailSendResult> {
    const transport = new SmtpTransport(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const record = (line: string): void => {
      this.transcript.push(line)
      this.options.onTranscript?.(line)
    }
    // 命令行的 transcript 来自传输层；打码在 `command()` 里已经做过了。
    transport.on('transcript', record)

    try {
      if (envelope.to.length === 0) {
        return { ok: false, error: '没有收件人', transcript: this.transcript }
      }

      await transport.connect(
        this.options.host,
        this.options.port,
        this.options.security === 'tls'
      )

      const greeting = await transport.readReply()
      record(`S: ${greeting.lines.join(' | ')}`)
      if (greeting.code !== 220) {
        return this.failFrom('服务器没有给出 220 问候', greeting)
      }

      const ehlo = await this.ehlo(transport)
      record(`S: ${ehlo.lines.join(' | ')}`)
      if (ehlo.code !== 250) return this.failFrom('EHLO 被拒绝', ehlo)

      const capabilities = ehlo.lines.map((line) => line.slice(4).toUpperCase())

      if (this.options.security === 'starttls') {
        if (!capabilities.some((item) => item.startsWith('STARTTLS'))) {
          return {
            ok: false,
            error: '服务器没有宣告 STARTTLS',
            detail: '把加密方式改成「隐式 TLS」或「不加密」（后者仅调试用）后重试',
            transcript: this.transcript
          }
        }
        record('C: STARTTLS')
        const started = await transport.command('STARTTLS')
        record(`S: ${started.lines.join(' | ')}`)
        if (started.code !== 220) return this.failFrom('STARTTLS 被拒绝', started)
        await transport.upgradeToTls(this.options.host)
        const reEhlo = await this.ehlo(transport)
        record(`S: ${reEhlo.lines.join(' | ')}`)
        if (reEhlo.code !== 250) return this.failFrom('STARTTLS 之后的 EHLO 被拒绝', reEhlo)
        capabilities.length = 0
        capabilities.push(...reEhlo.lines.map((line) => line.slice(4).toUpperCase()))
      }

      const username = this.options.username ?? ''
      if (username !== '') {
        const auth = await this.authenticate(transport, capabilities, record)
        if (auth) return auth
      }

      const mailFrom = await transport.command(`MAIL FROM:<${envelope.from}>`)
      record(`S: ${mailFrom.lines.join(' | ')}`)
      if (mailFrom.code !== 250) return this.failFrom('MAIL FROM 被拒绝', mailFrom)

      const accepted: string[] = []
      const refused: string[] = []
      for (const recipient of envelope.to) {
        const rcpt = await transport.command(`RCPT TO:<${recipient}>`)
        record(`S: ${rcpt.lines.join(' | ')}`)
        // 251 = 用户不在本地但会转发，也是成功。
        if (rcpt.code === 250 || rcpt.code === 251) accepted.push(recipient)
        else refused.push(`${recipient} (${rcpt.code})`)
      }

      if (accepted.length === 0) {
        return {
          ok: false,
          error: '所有收件人都被服务器拒绝',
          detail: refused.join('; '),
          transcript: this.transcript
        }
      }

      const data = await transport.command('DATA')
      record(`S: ${data.lines.join(' | ')}`)
      if (data.code !== 354) return this.failFrom('DATA 被拒绝', data)

      const payload = buildMessage(envelope, this.options.clientName ?? 'localhost')
      /**
       * 整个 DATA 段（含结尾的 `\r\n.\r\n`）一次性写出。
       *
       * 注意**不能**用 `transport.command(payload)`：那条路径会再补一个 CRLF，
       * 而 `.` 之后多出来的空行在部分中继上会被当成一条空命令并回 500。
       * `buildMessage` 已经把结束标记拼好了，这里只负责写和读回复。
       */
      transport.write(payload)
      const stored = await transport.readReply()
      record(`S: ${stored.lines.join(' | ')}`)
      if (stored.code !== 250) return this.failFrom('服务器没有接收这封信', stored)

      // QUIT 是礼貌，不是必需：失败也不影响信已经收下的事实。
      try {
        const quit = await transport.command('QUIT')
        record(`S: ${quit.lines.join(' | ')}`)
      } catch {
        // 忽略。
      }

      return { ok: true, accepted, transcript: this.transcript }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        transcript: this.transcript
      }
    } finally {
      transport.close()
    }
  }

  /** EHLO，附带客户端名。 */
  private ehlo(transport: SmtpTransport): Promise<SmtpReply> {
    return transport.command(`EHLO ${this.options.clientName ?? 'localhost'}`)
  }

  /** AUTH：优先 PLAIN，其次 LOGIN（两者都是标准且被广泛支持）。 */
  private async authenticate(
    transport: SmtpTransport,
    capabilities: string[],
    record: (line: string) => void
  ): Promise<LinkageEmailSendResult | undefined> {
    const username = this.options.username ?? ''
    const password = this.options.password ?? ''

    if (capabilities.some((item) => item === 'AUTH' || item.includes('PLAIN') || item.includes('LOGIN'))) {
      // 一条命令完成：`AUTH PLAIN <base64(\0user\0pass)>`。
      const token = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64')
      const plain = await transport.command(`AUTH PLAIN ${token}`, 'AUTH PLAIN ***')
      record(`S: ${plain.lines.join(' | ')}`)
      if (plain.code === 235) return undefined
      // 334 = 服务器要我们给凭据（这里已经给了），5xx = 拒绝。两种都试 LOGIN。
      if (plain.code >= 500 || plain.code === 334) {
        const login = await this.authenticateLogin(transport, username, password, record)
        if (login) return login
        return this.failFrom('认证失败（AUTH PLAIN 与 AUTH LOGIN 都被拒绝）', plain)
      }
      return this.failFrom('认证失败', plain)
    }

    // 服务器没有宣告任何 AUTH 机制：不发 AUTH，交给后面的 MAIL FROM 去回答
    // 「这台中继到底收不收」。硬发一条它不认识的命令只会得到一个 500，
    // 那个 500 与真正的投递失败混在一起更难查。
    return undefined
  }

  private async authenticateLogin(
    transport: SmtpTransport,
    username: string,
    password: string,
    record: (line: string) => void
  ): Promise<LinkageEmailSendResult | undefined> {
    const start = await transport.command('AUTH LOGIN')
    record(`S: ${start.lines.join(' | ')}`)
    if (start.code !== 334) return this.failFrom('服务器不支持 AUTH LOGIN', start)

    const user = await transport.command(Buffer.from(username, 'utf8').toString('base64'), 'AUTH LOGIN <user>')
    record(`S: ${user.lines.join(' | ')}`)
    if (user.code !== 334) return this.failFrom('AUTH LOGIN 用户名被拒绝', user)

    const pass = await transport.command(
      Buffer.from(password, 'utf8').toString('base64'),
      'AUTH LOGIN ***'
    )
    record(`S: ${pass.lines.join(' | ')}`)
    if (pass.code !== 235) return this.failFrom('AUTH LOGIN 口令被拒绝', pass)
    return undefined
  }

  private failFrom(reason: string, reply: SmtpReply): LinkageEmailSendResult {
    return {
      ok: false,
      error: `${reason}（${reply.code}）`,
      detail: reply.lines.join(' | '),
      transcript: this.transcript
    }
  }
}

// ---------------------------------------------------------------------------
// 报文构造（纯函数，测试直接断言）
// ---------------------------------------------------------------------------

/**
 * 构造一封 MIME 报文。
 *
 * 三个容易写错的点，都在这里处理掉：
 *   1. **行结束符必须是 CRLF**。只写 `\n` 的报文会被部分中继接受、被另一部分
 *      原样转交，然后收件方看到一个没有换行的正文。文件头与正文都要管。
 *   2. **点填充（dot-stuffing）**：正文里任何以 `.` 开头的行都必须写成 `..`，
 *      否则那一行会被当成 DATA 的结束标记，信被截断在这里。
 *   3. **非 ASCII 的主题要用 RFC 2047 编码**，否则中文主题在收件端会变成乱码。
 *      正文用 `Content-Transfer-Encoding: base64` 而不是 `8bit`：中继是否支持
 *      `8BITMIME` 要额外协商，base64 不需要，代价只是体积。
 */
export function buildMessage(envelope: SmtpEnvelope, clientName: string): string {
  const boundary = `hertzinno-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const headers: string[] = [
    `From: ${envelope.from}`,
    // 收件人列在 To 头里，但真正的投递目标是 RCPT TO——两者本文件保持一致。
    `To: ${envelope.to.join(', ')}`,
    `Subject: ${encodeHeaderValue(envelope.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${clientName}>`,
    'MIME-Version: 1.0'
  ]

  const parts: string[] = []
  if (envelope.attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    parts.push(
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        chunkBase64(Buffer.from(envelope.text, 'utf8'))
      ].join('\r\n')
    )
    const attachment = envelope.attachment
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${attachment.contentType}; name="${sanitiseFileName(attachment.fileName)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${sanitiseFileName(attachment.fileName)}"`,
        '',
        chunkBase64(Buffer.from(attachment.bytes))
      ].join('\r\n')
    )
    parts.push(`--${boundary}--`)
    const body = parts.join('\r\n')
    return `${headers.join('\r\n')}\r\n\r\n${dotStuff(body)}\r\n.\r\n`
  }

  headers.push('Content-Type: text/plain; charset=UTF-8')
  headers.push('Content-Transfer-Encoding: base64')
  const body = chunkBase64(Buffer.from(envelope.text, 'utf8'))
  return `${headers.join('\r\n')}\r\n\r\n${dotStuff(body)}\r\n.\r\n`
}

/** 按 RFC 2045 折行的 base64（每行 ≤ 76 字符）。 */
export function chunkBase64(input: Buffer, width = BASE64_LINE_WIDTH): string {
  const encoded = input.toString('base64')
  const lines: string[] = []
  for (let index = 0; index < encoded.length; index += width) {
    lines.push(encoded.slice(index, index + width))
  }
  return lines.join('\r\n')
}

/**
 * 非 ASCII 报头值用 RFC 2047 的 `B` 编码。
 *
 * 只在真的有非 ASCII 字符时才编码：一个纯 ASCII 主题被编码之后虽然合法，
 * 但在很多邮件客户端里会显示成 `=?UTF-8?B?...?=`，可读性反而更差。
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** 附件文件名不能带引号或换行，否则会把报头拆掉。 */
export function sanitiseFileName(value: string): string {
  const safe = value.replace(/[\r\n"\\]/g, '_').trim()
  return safe === '' ? 'attachment.bin' : safe
}

/** DATA 段里的点填充。 */
export function dotStuff(body: string): string {
  return body
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
}

/**
 * 解释一次失败，给界面一句人话。
 *
 * 只映射最常见的四种，其余原样带出服务器的回复——猜错的解释比原始回复更糟。
 */
export function explainSmtpFailure(result: Extract<LinkageEmailSendResult, { ok: false }>): string {
  const detail = result.detail ?? ''
  if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(`${result.error} ${detail}`)) {
    return result.error
  }
  if (/\b535\b/.test(detail) || /认证失败/.test(result.error)) {
    return `${result.error}：用户名或口令被拒绝（535）`
  }
  if (/\b5\d\d\b/.test(detail)) return `${result.error}：${detail}`
  return detail === '' ? result.error : `${result.error}：${detail}`
}
