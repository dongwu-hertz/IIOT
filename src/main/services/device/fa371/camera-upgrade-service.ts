/**
 * FA371 声学相机 —— **固件升级**服务。
 *
 * ---------------------------------------------------------------------------
 * 这一项为什么以前不做、现在做了
 * ---------------------------------------------------------------------------
 * 厂家给的升级流程（`docs/reference/fe128-upgrade-procedure.txt`）是 SSH/SFTP +
 * 自解压脚本，那种东西不适合做进桌面软件，所以本软件先前**刻意不做**升级，
 * 只在维护区给一个禁用控件 + 原因。现在确认**设备自带 Web 界面那条路是纯 HTTP**，
 * 于是照着做：
 *
 *   POST /upload    multipart/form-data，两个段（一个**空字段名** + 一个 `file`），
 *                   设备自带前端把超时设成 1800 秒
 *   PUT  /reboot    重启设备（`en('/reboot')`；`en` 是 PUT 封装，GET 用的是 `Qt`）
 *   GET  /progress  升级进度
 *
 * 三个接口都是从设备自带前端的 bundle 里读出来的（`/static/js/main.<hash>.js`），
 * **不在任何一份手册里** —— 所以本服务把它们当"实测接口"对待：拿不准的地方
 * 如实说不懂，绝不编一个数字。
 *
 * ---------------------------------------------------------------------------
 * 三条贯穿全文件的规则
 * ---------------------------------------------------------------------------
 * 1) **上传与重启是两个动作，本文件里没有任何从上传通向重启的路径。**
 *    `upload()` 只发 `POST /upload`；`reboot()` 只发 `PUT /reboot`。产品的硬要求是
 *    「上传成功后由操作员决定什么时候重启」，而这一条在代码里是**结构性**的：
 *    想自动重启就必须新写一条调用（`test/camera-upgrade.test.ts` 里有一条测试
 *    专门盯着"上传期间设备没有收到任何 PUT /reboot"）。
 *
 * 2) **不把整个包读进内存。** 包按几十 MB 计（真实包 `75382932` 字节），桌面进程
 *    里一次性 `readFile` 会多出一份等大的 Buffer，还要在 multipart 编码时再复制一遍。
 *    所以这里**自己拼 multipart 报文**（几十行，形状已知且有测试盯着）并用
 *    `node:http` 流式写出：`createReadStream` + 背压（`write()` 返回 `false` 就等
 *    `drain`），任何时刻内存里只有几个 64 KiB 的 chunk。进度因此也是**真实的**
 *    ——数的是真的写出去的字节数，而不是按文件大小跑的动画。
 *
 * 3) **成功码不是证据。** 实测：未认证时设备回的是 **HTTP 200** +
 *    `{"msg":"No Auth","ret":401}`。所以 2xx 之后还要看正文里的 `ret`：
 *    设备说 no auth 的时候，这里必须报失败，而不是"上传成功"。
 *
 * 全部依赖以**结构化类型**注入（`CameraUpgradeOperations`），因此测试不需要真机、
 * 也不需要 Electron：测试起一个本地 `node:http` 桩服务，让真实的上传代码把包发给它，
 * 再对**收到的原始字节**逐段断言。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  cameraUpgradeSuffix,
  isAcceptableCameraUpgradePackageName,
  type CameraRebootResult,
  type CameraUpgradePackage,
  type CameraUpgradeProgress,
  type CameraUpgradeProgressEvent,
  type CameraUpgradeUploadResult
} from '@shared/domain/camera-upgrade'
import { deviceLog } from '../../logging/logger'
import type { Fa371UpgradeProgressDto } from './dto'
import { fa371ErrorMessage, isFa371Success } from './mappers'

// ---------------------------------------------------------------------------
// 线上常量（逐字来自设备自带前端）
// ---------------------------------------------------------------------------

/** `POST /upload`（bundle 里 `Zt({url:'/upload', method:'post', ...})`）。 */
export const CAMERA_UPGRADE_UPLOAD_PATH = '/upload'

/**
 * 元数据段的字段名 —— **空字符串**。
 *
 * 设备自带前端的原文是 `fd.append('', '{"file_size":' + f[0].size + '}')`。
 * 一个空的 `name` 看着像 bug，但那是设备后端认的形状，**不要"修正"它**：
 * 改成 `metadata` 之类的名字，设备能不能解析完全未知，而代价是几十 MB 的白传。
 */
export const CAMERA_UPGRADE_META_FIELD = ''

/** 包本身的字段名（`fd.append('file', f[0])`）。 */
export const CAMERA_UPGRADE_FILE_FIELD = 'file'

/**
 * 上传超时：**1800 秒**，与设备自带前端一致（`timeout: 18e5`）。
 *
 * 不缩短：真实包 75 MB，现场是相机直连的百兆口或更慢的链路时，几十秒到几分钟都
 * 有可能；比设备自己还急的客户端只会把一次本来能成的上传掐断。
 */
export const CAMERA_UPGRADE_UPLOAD_TIMEOUT_MS = 1_800_000

/** 读文件的块大小。内存里同时只有一两个这么大的 buffer（见文件头规则 2）。 */
const UPLOAD_CHUNK_BYTES = 64 * 1024

/** 设备应答最多保留这么多字节（诊断用的一句 `msg` 而已）。 */
const MAX_RESPONSE_SNIPPET_BYTES = 4 * 1024

/** 进度推送的密度上限：整段上传最多推这么多次。 */
const MAX_PROGRESS_EVENTS = 100

// ---------------------------------------------------------------------------
// multipart 报文（自己拼，形状与设备自带前端逐字一致）
// ---------------------------------------------------------------------------

export interface UpgradeMultipartPlan {
  boundary: string
  /** 起始块：元数据段（空字段名）+ 文件段的头部。 */
  header: Buffer
  /** 结束块：`\r\n--<boundary>--\r\n`。 */
  footer: Buffer
  /** 请求体总字节数 = header + 包的大小 + footer。用来设置 `Content-Length`。 */
  contentLength: number
}

/** 生成一个 multipart 边界。随机十六进制，与包内容撞车的概率可以忽略。 */
export function newUpgradeBoundary(): string {
  return `----NodeFormBoundary${randomBytes(12).toString('hex')}`
}

/**
 * 拼出上传报文的骨架。
 *
 * 段的**顺序**与设备自带前端一致（元数据在先、包在后），这是照抄而不是选择：
 * 设备后端会不会先读元数据再收包没有文档，唯一已知能工作的顺序就是这一种。
 *
 * 报文形状（`\r\n` 是 CRLF）：
 * ```
 * --B
 * Content-Disposition: form-data; name=""
 *
 * {"file_size":75382932}
 * --B
 * Content-Disposition: form-data; name="file"; filename="FE128_..._v2.0.11"
 * Content-Type: application/octet-stream
 *
 * <包字节>
 * --B--
 * ```
 * 元数据段**不带** `Content-Type`：浏览器对 `FormData.append(name, string)` 也不带，
 * 而设备前端就是这么发的。
 */
export function buildUpgradeMultipartPlan(options: {
  boundary: string
  fileName: string
  sizeBytes: number
}): UpgradeMultipartPlan {
  const { boundary, sizeBytes } = options
  // 设备自带前端的字面拼接：'{"file_size":' + size + '}'
  const metadata = `{"file_size":${sizeBytes}}`

  const header = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, 'utf8'),
    Buffer.from(
      `Content-Disposition: form-data; name="${CAMERA_UPGRADE_META_FIELD}"\r\n\r\n`,
      'utf8'
    ),
    Buffer.from(`${metadata}\r\n`, 'utf8'),
    Buffer.from(`--${boundary}\r\n`, 'utf8'),
    Buffer.from(
      `Content-Disposition: form-data; name="${CAMERA_UPGRADE_FILE_FIELD}"; filename="${quoteFileName(options.fileName)}"\r\n`,
      'utf8'
    ),
    Buffer.from('Content-Type: application/octet-stream\r\n\r\n', 'utf8')
  ])

  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')

  return {
    boundary,
    header,
    footer,
    contentLength: header.length + sizeBytes + footer.length
  }
}

/**
 * 文件名放进 `Content-Disposition` 时要做的最小处理。
 *
 * 三个字符有实际后果：`"` 会提前结束引号、`\` 是转义符、CR/LF 可以**注入一个新头**。
 * 真实的升级包名是 ASCII（设备规则要求以 `_v<数字>.<数字>.<数字>` 结尾），
 * 所以这里不做 RFC 5987 编码，只保证不破坏报文结构。
 */
function quoteFileName(fileName: string): string {
  return fileName.replace(/\\/g, '\\\\').replace(/"/g, '%22').replace(/[\r\n]/g, '')
}

// ---------------------------------------------------------------------------
// 上传目标（node:http 直连，绕开 HttpTransport）
// ---------------------------------------------------------------------------

export interface UpgradeUploadTarget {
  protocol: 'http:' | 'https:'
  hostname: string
  port: number
}

/**
 * 把客户端解析出来的基地址变成直连参数。
 *
 * **为什么不复用 `HttpTransport`**：它一次性把请求体交给 `fetch`（`FormData` 会被
 * 整个编码进内存），也拿不到中间写出的字节数 —— 而"真实的字节级进度"与"不把
 * 75 MB 读进内存"正是这一项的两条硬要求。所以这一条路径自己走 `node:http`，
 * 只借用客户端已经解析好的**会话凭据**（`authHeaders()`）与基地址。
 */
export function resolveUpgradeUploadTarget(baseUrl: string): UpgradeUploadTarget {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备地址无法解析：${baseUrl}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `设备地址的协议不支持升级上传：${parsed.protocol}（只接受 http/https）`
    )
  }
  return {
    protocol: parsed.protocol,
    // IPv6 地址在 URL 里带方括号，而 `http.request` 要的是不带方括号的 host。
    hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  }
}

export interface UpgradeUploadRequest {
  target: UpgradeUploadTarget
  /** 已认证的请求头（来自客户端的 `authHeaders()`）。 */
  headers: Record<string, string>
  plan: UpgradeMultipartPlan
  filePath: string
  timeoutMs: number
  /** 每写出一段就回调一次，参数是**累计写出的请求体字节数**。 */
  onProgress: (sentBytes: number) => void
}

export interface UpgradeUploadResponse {
  status: number
  bodyText: string
  elapsedMs: number
}

/**
 * 流式发出一次升级包上传，返回设备的应答。
 *
 * 内存：`header`（几百字节）+ 一个 64 KiB 的读块；包**从不**整体进内存。
 * 背压：`write()` 返回 `false` 就等 `drain`，所以慢链路不会把包堆在 socket 缓冲里。
 */
export async function sendUpgradeUpload(
  request: UpgradeUploadRequest
): Promise<UpgradeUploadResponse> {
  const { target, plan } = request
  const transport = target.protocol === 'https:' ? https : http
  const started = performance.now()

  const clientRequest = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: CAMERA_UPGRADE_UPLOAD_PATH,
    method: 'POST',
    headers: {
      ...request.headers,
      // 边界必须出现在 Content-Type 里，否则服务端无法解析分段。
      'Content-Type': `multipart/form-data; boundary=${plan.boundary}`,
      // 长度已知（header + 文件大小 + footer），所以不用 chunked 传输编码：
      // 设备后端的 multipart 解析器面对一个长度确定的请求体是最省事的情况。
      'Content-Length': String(plan.contentLength)
    }
  })

  clientRequest.setTimeout(request.timeoutMs, () => {
    clientRequest.destroy(
      new AppError(
        ErrorCodes.TIMEOUT,
        `升级包上传超时（${Math.round(request.timeoutMs / 1000)} 秒）`
      )
    )
  })

  /**
   * 应答用一个显式的 Promise 接，**两个监听器都在这里、同步挂上**。
   *
   * 不能等到写完之后再 `once(request, 'response')`：连接被拒（设备不在、网线掉了）
   * 时 Node 会在写体期间就 emit `error`，而那一刻如果**没有任何** `error` 监听器，
   * 它就是一个未捕获异常 —— 在一个长期运行的桌面主进程里，那意味着整个应用崩掉，
   * 而用户只是点了一次上传。这条正是测试（"设备不可达"）逼出来的。
   */
  const responsePromise = new Promise<UpgradeUploadResponse>((resolve, reject) => {
    clientRequest.on('response', (response: http.IncomingMessage) => {
      void readResponseSnippet(response).then(
        (bodyText) =>
          resolve({
            status: response.statusCode ?? 0,
            bodyText,
            elapsedMs: Math.round(performance.now() - started)
          }),
        reject
      )
    })
    clientRequest.on('error', reject)
  })
  // 写体失败时这个 Promise 也会被拒；先挂一个空的处理，避免"未处理的拒绝"。
  responsePromise.catch(() => undefined)

  try {
    await writeUpgradeBody(clientRequest, request)
    return await responsePromise
  } catch (error) {
    clientRequest.destroy()
    throw normaliseUploadError(
      error,
      `${target.protocol}//${target.hostname}:${target.port}${CAMERA_UPGRADE_UPLOAD_PATH}`
    )
  }
}

/** 写出请求体：元数据段 + 文件流 + 结束边界，边写边报进度。 */
async function writeUpgradeBody(
  clientRequest: http.ClientRequest,
  request: UpgradeUploadRequest
): Promise<void> {
  const { plan, filePath, onProgress } = request
  let sentBytes = 0
  let lastEmitted = 0

  // 每 1% 或每 256 KiB（取大者）推一次：75 MB / 64 KiB 约 1150 个 chunk，
  // 逐个推会在几秒内往 IPC 里灌上千条事件，而界面根本画不出这么多帧。
  const step = Math.max(Math.ceil(plan.contentLength / MAX_PROGRESS_EVENTS), UPLOAD_CHUNK_BYTES * 4)

  const report = (): void => {
    if (sentBytes - lastEmitted >= step || sentBytes >= plan.contentLength) {
      onProgress(sentBytes)
      lastEmitted = sentBytes
    }
  }

  /**
   * 请求体做成一个可读流：起始块 → 包（64 KiB 一块）→ 结束块。
   *
   * 计数发生在**交给 socket 的那一刻**，而 `pipeline` 会尊重背压（读端只在写端
   * 收得下时才继续拉），所以内存里始终只有几个 64 KiB 的块，进度也真的是写出去的
   * 字节数 —— 不是按文件大小跑的动画。
   */
  async function* bodyChunks(): AsyncGenerator<Buffer> {
    sentBytes += plan.header.length
    report()
    yield plan.header

    const file = createReadStream(filePath, { highWaterMark: UPLOAD_CHUNK_BYTES })
    try {
      for await (const chunk of file) {
        const buffer = chunk as Buffer
        sentBytes += buffer.length
        report()
        yield buffer
      }
    } finally {
      // 出错时也要把文件句柄放掉：这个进程是长期运行的桌面进程。
      file.destroy()
    }

    sentBytes += plan.footer.length
    report()
    yield plan.footer
  }

  /**
   * 用 `pipeline` 而不是手写 `write()` + `once(request, 'drain')` 循环。
   *
   * 理由是**测试逼出来的**：连接被拒（设备不在、网线掉了）时 Node 会在写体期间就
   * emit `error`，而那时手写的 `once(request, 'drain')` 会永远等下去 —— 那个 `drain`
   * 再也不会来了。表现就是"上传卡死"，而桌面主进程里卡住的是整个应用。
   * `pipeline` 会把两头一起销毁并把错误抛出来。
   */
  await pipeline(Readable.from(bodyChunks()), clientRequest)
}

/** 读设备应答的正文，最多保留 `MAX_RESPONSE_SNIPPET_BYTES`。 */
async function readResponseSnippet(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const buffer = chunk as Buffer
    if (total < MAX_RESPONSE_SNIPPET_BYTES) {
      chunks.push(buffer)
      total += buffer.length
    }
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_SNIPPET_BYTES)
}

/** 把传输层的失败翻译成统一的错误分类（与 `HttpTransport.normaliseError` 同一套口径）。 */
function normaliseUploadError(error: unknown, url: string): AppError {
  if (error instanceof AppError) return error

  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string } | undefined)?.code
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) {
    return new AppError(ErrorCodes.TIMEOUT, `升级包上传超时：${url}`, message)
  }
  return new AppError(
    ErrorCodes.NETWORK_ERROR,
    `升级包上传时无法连接到设备：${url}`,
    code ?? message
  )
}

// ---------------------------------------------------------------------------
// 客户端能力（结构化类型，测试可注入假实现）
// ---------------------------------------------------------------------------

/**
 * 本服务真正用到的设备能力，一个不多。
 *
 * 形状本身就是"这个服务依赖什么"的文档：一个已认证的基地址 + 认证头，以及
 * 升级进度与重启两个请求。上传**不走这里**（它要流式发送，见文件头规则 2），
 * 只借这条路拿凭据。
 */
export interface CameraUpgradeOperations {
  /** 已认证会话的基地址，形如 `http://192.168.2.168`（无尾斜杠）。 */
  readonly currentBaseUrl: string
  /** 当前会话的认证头（未登录时为空对象）。 */
  authHeaders(): Record<string, string>
  /** 确保有会话（懒登录，与其它通道共用同一份会话）。 */
  ensureSession(): Promise<void>
  /** `GET /progress`。 */
  getUpgradeProgress(): Promise<Fa371UpgradeProgressDto>
  /** `PUT /reboot`。 */
  reboot(): Promise<void>
}

export interface CameraUpgradeServiceOptions {
  /** 取某台相机当前的 FA371 客户端（由 DeviceService 提供，含已解析的会话）。 */
  clientFor: (deviceId: string) => CameraUpgradeOperations
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class CameraUpgradeService {
  private readonly clientFor: (deviceId: string) => CameraUpgradeOperations

  constructor(options: CameraUpgradeServiceOptions) {
    this.clientFor = options.clientFor
  }

  // -- 本机：读一个包的事实 -------------------------------------------------

  /**
   * 读一个升级包在**本机**的事实：文件名、大小、sha256、文件名是否符合设备规则。
   *
   * 这一步**不碰设备**，所以它在按上传之前就能回答"这个包设备会不会收"。
   * sha256 是流式算的（`createReadStream` + `createHash`）：75 MB 的包不会因此
   * 多出一份内存拷贝。
   */
  async inspectPackage(filePath: string): Promise<CameraUpgradePackage> {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '未选择升级包文件')
    }

    let sizeBytes: number
    try {
      const stats = await stat(filePath)
      if (!stats.isFile()) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `升级包不是一个文件：${filePath}`)
      }
      sizeBytes = stats.size
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `无法读取升级包：${filePath}`,
        error instanceof Error ? error.message : String(error)
      )
    }

    const fileName = path.basename(filePath)
    return {
      path: filePath,
      fileName,
      sizeBytes,
      sha256: await sha256File(filePath),
      suffix: cameraUpgradeSuffix(fileName),
      nameAccepted: isAcceptableCameraUpgradePackageName(fileName)
    }
  }

  // -- 设备：上传 -----------------------------------------------------------

  /**
   * `POST /upload` —— 把升级包发给设备。**不重启设备。**
   *
   * 前置校验：文件名不符合设备自己的规则时**直接拒绝**，不发一个字节。设备会用
   * 同一套规则拒绝它，先传几十 MB 再拿一个失败没有任何意义。
   *
   * 成功判定见 `assertUploadAccepted`：2xx **之外还要看正文的 `ret`**，因为实测
   * 未认证时设备回的是 200 + `{"msg":"No Auth","ret":401}`。
   *
   * 进度通过 `onProgress` 回调（由 IPC 层推给渲染层），如果给了的话。
   */
  async upload(
    deviceId: string,
    filePath: string,
    onProgress?: (event: CameraUpgradeProgressEvent) => void
  ): Promise<CameraUpgradeUploadResult> {
    if (typeof deviceId !== 'string' || deviceId === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
    }

    const pkg = await this.inspectPackage(filePath)
    if (!pkg.nameAccepted) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `升级包文件名不符合设备要求：按 "_" 切开的最后一段必须是 V<数字>.<数字>.<数字>（当前是 "${pkg.suffix}"），设备会拒绝这个包`
      )
    }

    const client = this.clientFor(deviceId)
    // 与其它通道共用同一份会话：另发一次 /login 只会多一次认证探测。
    await client.ensureSession()

    const plan = buildUpgradeMultipartPlan({
      boundary: newUpgradeBoundary(),
      fileName: pkg.fileName,
      sizeBytes: pkg.sizeBytes
    })

    deviceLog().warn('相机升级包开始上传（设备自带前端的 POST /upload）', {
      deviceId,
      fileName: pkg.fileName,
      sizeBytes: pkg.sizeBytes,
      sha256: pkg.sha256,
      baseUrl: client.currentBaseUrl
    })

    const response = await sendUpgradeUpload({
      target: resolveUpgradeUploadTarget(client.currentBaseUrl),
      headers: client.authHeaders(),
      plan,
      filePath: pkg.path,
      timeoutMs: CAMERA_UPGRADE_UPLOAD_TIMEOUT_MS,
      onProgress: (sentBytes) => {
        onProgress?.({
          deviceId,
          sentBytes,
          totalBytes: plan.contentLength,
          packageBytes: pkg.sizeBytes,
          percent:
            plan.contentLength > 0
              ? Math.round((100 * sentBytes) / plan.contentLength)
              : 100
        })
      }
    })

    assertUploadAccepted(response)

    deviceLog().warn('相机升级包已上传（设备尚未升级：重启是另一个动作）', {
      deviceId,
      fileName: pkg.fileName,
      status: response.status,
      elapsedMs: response.elapsedMs
    })

    const snippet = response.bodyText.trim()
    return {
      deviceId,
      fileName: pkg.fileName,
      sizeBytes: pkg.sizeBytes,
      sha256: pkg.sha256,
      status: response.status,
      elapsedMs: response.elapsedMs,
      ...(snippet !== '' ? { responseSnippet: snippet.slice(0, 300) } : {})
    }
  }

  // -- 设备：读进度 ---------------------------------------------------------

  /**
   * `GET /progress` —— 设备自报的升级进度。
   *
   * **只把设备原样的数值交出去**：`upgrade_progress` 的量纲与取值含义没有文档
   * （真机空闲时是 `-2.0`），所以这里不换算、也不猜它是不是百分比。
   */
  async readProgress(deviceId: string): Promise<CameraUpgradeProgress> {
    const dto = await this.clientFor(deviceId).getUpgradeProgress()
    const raw = typeof dto?.upgrade_progress === 'number' ? dto.upgrade_progress : undefined
    const message = typeof dto?.msg === 'string' && dto.msg !== '' ? dto.msg : undefined
    return {
      ...(raw !== undefined ? { raw } : {}),
      ...(message !== undefined ? { deviceMessage: message } : {})
    }
  }

  // -- 设备：重启（**独立动作**） -------------------------------------------

  /**
   * `PUT /reboot` —— 重启设备。**只有这一个方法会重启设备，而上传不会调用它。**
   *
   * 设备重启时可能**在应答之前就断开连接**：那会以 `NETWORK_ERROR` / `TIMEOUT`
   * 冒到这里。那种情况**不报成失败**——请求确实发出去了，报"失败"会让操作员再点
   * 一次，而他面对是一台正在重启的相机。所以结果里区分
   * `acknowledged`（收到 2xx）与 `connectionDropped`（发出去了、没拿到应答）。
   */
  async reboot(deviceId: string): Promise<CameraRebootResult> {
    if (typeof deviceId !== 'string' || deviceId === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
    }

    const client = this.clientFor(deviceId)
    try {
      await client.reboot()
      return { deviceId, acknowledged: true, connectionDropped: false }
    } catch (error) {
      const appError = AppError.from(error)
      if (appError.code === ErrorCodes.NETWORK_ERROR || appError.code === ErrorCodes.TIMEOUT) {
        deviceLog().warn('相机重启指令已发出但设备未回执（重启时连接断开是常见形状）', {
          deviceId,
          reason: appError.message
        })
        return { deviceId, acknowledged: false, connectionDropped: true }
      }
      throw appError
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 设备是否收下了这个包。
 *
 * 三层判定，顺序有原因：
 *   1. 非 2xx → 直接是 `DEVICE_ERROR`，把状态码与正文带出去（设备自带前端也是
 *      以 `200 === res.status` 判成功）；
 *   2. 正文是网页 → `INVALID_RESPONSE`。这台设备对**不认识的路径**会回
 *      HTTP 200 + SPA 的 `index.html`（实测），那种"成功"必须被认出来；
 *   3. 正文是 JSON 而 `ret` 不是 200 → `DEVICE_ERROR`，带出设备自己的 `msg`。
 *      **这一层是实测逼出来的**：未认证时 `/progress` 回的就是
 *      `200 {"msg":"No Auth","ret":401}`，只看状态码会把"根本没认证"报成成功。
 */
export function assertUploadAccepted(response: UpgradeUploadResponse): void {
  const snippet = response.bodyText.trim()

  if (response.status < 200 || response.status >= 300) {
    throw new AppError(
      ErrorCodes.DEVICE_ERROR,
      `升级包上传失败 (HTTP ${response.status})`,
      snippet.slice(0, 300) === '' ? undefined : snippet.slice(0, 300)
    )
  }

  if (/^<(!doctype|html)/i.test(snippet)) {
    throw new AppError(
      ErrorCodes.INVALID_RESPONSE,
      `设备返回的是网页而不是接口响应：${CAMERA_UPGRADE_UPLOAD_PATH} 在这台设备上可能不存在`,
      snippet.slice(0, 200)
    )
  }

  const parsed = parseJsonObject(snippet)
  if (parsed !== undefined && !isFa371Success(parsed)) {
    throw new AppError(
      ErrorCodes.DEVICE_ERROR,
      `升级包上传被设备拒绝：${fa371ErrorMessage(parsed) ?? '业务失败'}`,
      snippet.slice(0, 300)
    )
  }
}

/** 只在正文确实是一个 JSON 对象时解析；其它一律返回 `undefined`（不猜）。 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 流式算 sha256：75 MB 的包不会因此多出一份等大的内存。 */
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
    }
  } finally {
    stream.destroy()
  }
  return hash.digest('hex')
}
