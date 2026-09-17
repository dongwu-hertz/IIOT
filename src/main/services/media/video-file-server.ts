/**
 * 单个录像文件的**回环**播放端点（手动录像的 MP4）。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 手动录像落盘的是 MP4，而渲染层没有任何办法读本地文件：
 * `contextIsolation` 之下没有 `fs`，CSP 也禁止 `file://`。音频那条路
 * （`playback.load` 把整段 WAV 以 base64 推过 IPC）在这里不成立——一段 3 分钟
 * 的 4 Mbit/s 视频约 90 MB，base64 之后 120 MB，还要在渲染层重新组装成
 * Blob；而 `<video>` 本来就能直接吃一个 HTTP 字节流，还自带 Range 请求与缓冲。
 *
 * 所以复用 `rtsp-stream.ts` 已经验证过的那套做法：
 *   - 只绑 `127.0.0.1`，端口 `listen(0)` 由系统临时分配；
 *   - 路径里带每会话随机令牌，令牌不对 = 403 并记日志；
 *   - `Content-Type: video/mp4`，`Cache-Control: no-store`；
 *   - **支持 Range**（`206 Partial Content`）。没有 Range 的 `<video>` 不能拖动
 *     进度条，浏览器也只能从头顺序读——对一段长录像这是不可接受的。
 *
 * 与直播那条路的关键区别：直播没有结束、没有长度、不支持 Range；这里是**文件**，
 * 有长度、可随机访问，因此 `Content-Length` 与 Range 都是必须的。
 */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'

export interface VideoPlaybackHandle {
  /** 交给渲染层 `<video src>` 的地址。 */
  url: string
  /** 文件名（界面提示用，路径本身不出主进程）。 */
  fileName: string
  /** 关闭这个端点（关掉之后 URL 立即失效）。 */
  close: () => void
}

/**
 * 一组图片（一条告警的抓图）的回环端点。
 *
 * 与 `VideoPlaybackHandle` 分开的理由：抓图是**一组文件**，界面要一次拿到全部地址，
 * 而"关掉这一组"是一个动作（换一条告警时把上一组关掉）。一个端点服务一组，
 * 而不是每张图开一个端口 —— 3 张图开 3 个端口会让端口与定时器成倍增长。
 */
export interface ImageSetHandle {
  files: Array<{ name: string; url: string }>
  close: () => void
}

/** 抓图只认这几种扩展名（设备给的是 jpg；png 留给将来）。 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

/** 一个端点的存活时间上限：长时间挂着不用的端口没有意义。 */
const DEFAULT_TTL_MS = 30 * 60 * 1000

interface Session {
  token: string
  filePath: string
  fileName: string
  server: Server
  timer?: NodeJS.Timeout
  /**
   * 这一组要服务的文件（**抓图**那一组用；单个录像时为 `undefined`）。
   *
   * 用一张白名单表而不是"按 URL 拼路径"：请求里的文件名只允许是**我们列出来的**这些，
   * 于是路径穿越（`../../`）在结构上就不可能 —— 与"校验 basename"相比，
   * 白名单不依赖校验写对。
   */
  allowed?: Map<string, string>
}

export function createVideoToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

export function videoPathFor(token: string, fileName: string): string {
  // 文件名只用于让 URL 可读（以及浏览器的下载名），令牌才是授权。
  return `/${token}/${encodeURIComponent(path.basename(fileName))}`
}

/**
 * Range 头解析。
 *
 * 只实现浏览器真正会发的两种形式：`bytes=start-` 与 `bytes=start-end`。
 * 后缀形式（`bytes=-N`）也支持，因为媒体播放器在探时长时会用到。
 * 返回 `undefined` 表示"整份文件"。
 */
export function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | undefined {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (startRaw === '' && endRaw === '') return undefined

  if (startRaw === '') {
    // `bytes=-N`：最后 N 个字节。
    const length = Number(endRaw)
    if (!Number.isFinite(length) || length <= 0) return undefined
    return { start: Math.max(0, size - length), end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isFinite(start) || start >= size) return undefined
  const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
  if (!Number.isFinite(end) || end < start) return undefined
  return { start, end }
}

export class VideoFileServer {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number
  private disposed = false

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  /** 给一个已存在的 MP4 开一个回环端点。 */
  async serve(absolutePath: string): Promise<VideoPlaybackHandle> {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '视频播放服务已释放')

    const stat = await fs.stat(absolutePath).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) {
      throw new AppError(
        ErrorCodes.STORAGE_ERROR,
        '该录像在本地没有可播放的文件（只有元数据，或文件已为空）',
        absolutePath
      )
    }

    const token = createVideoToken()
    const fileName = path.basename(absolutePath)
    const session: Session = {
      token,
      filePath: absolutePath,
      fileName,
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      server: undefined as unknown as Server
    }

    const server = createServer((request, response) => {
      void this.handle(session, request.headers.range, request.method ?? 'GET', request.url ?? '/', response)
    })
    session.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // 只回环 + 临时端口，与直播同一条安全推理。
      server.listen(0, '127.0.0.1')
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new AppError(ErrorCodes.NETWORK_ERROR, '视频播放端点未能绑定端口')
    }

    session.timer = setTimeout(() => this.closeToken(token), this.ttlMs)
    session.timer.unref?.()
    this.sessions.set(token, session)

    const url = `http://127.0.0.1:${address.port}${videoPathFor(token, fileName)}`
    deviceLog().info('Video playback endpoint opened', { fileName, bytes: stat.size })
    return { url, fileName, close: () => this.closeToken(token) }
  }

  /**
   * 给**一组图片**（一条告警的抓图）开一个回环端点。
   *
   * 与 `serve()` 同一条安全推理（只绑回环、路径里带每会话令牌、令牌不对 403 并记日志），
   * 差别只有两点：一个端点服务**一组**文件（URL 是 `/<token>/<文件名>`），
   * 以及 `Content-Type` 按扩展名给（`image/jpeg`）。
   *
   * 传进来的 `names` 就是**全部**允许访问的文件（白名单），调用方负责先确认它们在磁盘上
   * 存在 —— 少一个文件就意味着那一次告警少一张图，而那是要如实报出来的（不是 404 了事）。
   */
  async serveImages(directory: string, names: readonly string[]): Promise<ImageSetHandle> {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '本地文件服务已释放')
    const allowed = new Map<string, string>()
    for (const name of names) {
      // 只接受"文件名"，路径分隔符一律拒绝：白名单表里不该出现子目录。
      if (name === '' || path.basename(name) !== name) continue
      if (!(path.extname(name).toLowerCase() in IMAGE_CONTENT_TYPES)) continue
      allowed.set(name, path.join(directory, name))
    }
    if (allowed.size === 0) {
      throw new AppError(ErrorCodes.STORAGE_ERROR, '这一组里没有可用的图片文件', directory)
    }

    const first = [...allowed.keys()][0] as string
    const token = createVideoToken()
    const session: Session = {
      token,
      filePath: [...allowed.values()][0] as string,
      fileName: first,
      allowed,
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      server: undefined as unknown as Server
    }
    const server = createServer((request, response) => {
      void this.handle(session, request.headers.range, request.method ?? 'GET', request.url ?? '/', response)
    })
    session.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new AppError(ErrorCodes.NETWORK_ERROR, '抓图端点未能绑定端口')
    }

    session.timer = setTimeout(() => this.closeToken(token), this.ttlMs)
    session.timer.unref?.()
    this.sessions.set(token, session)

    const files = [...allowed.keys()].map((name) => ({
      name,
      url: `http://127.0.0.1:${address.port}/${token}/${encodeURIComponent(name)}`
    }))
    deviceLog().info('Alarm snapshot endpoint opened', { directory, files: files.length })
    return { files, close: () => this.closeToken(token) }
  }

  /** 关掉一个端点（或用全部）。 */
  closeToken(token: string): void {    const session = this.sessions.get(token)
    if (!session) return
    this.sessions.delete(token)
    if (session.timer) clearTimeout(session.timer)
    try {
      session.server.close()
      session.server.closeAllConnections?.()
    } catch {
      // 已经关掉了。
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const token of [...this.sessions.keys()]) this.closeToken(token)
  }

  /** 当前打开的端点数（诊断与测试）。 */
  get openCount(): number {
    return this.sessions.size
  }

  private async handle(
    session: Session,
    rangeHeader: string | undefined,
    method: string,
    rawUrl: string,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    const pathname = rawUrl.split('?')[0] ?? '/'
    /*
     * 抓图那一组：URL 是 `/<token>/<文件名>`，文件名必须在**白名单**里。
     * 录像那一组：URL 是 `/<token>/<那个文件名>`，只有那一个文件。
     */
    let filePath = session.filePath
    let contentType = 'video/mp4'
    if (session.allowed) {
      const prefix = `/${session.token}/`
      if (!pathname.startsWith(prefix)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        deviceLog().warn('Snapshot request rejected (bad token)', { path: pathname.slice(0, 80) })
        return
      }
      const requested = decodeURIComponent(pathname.slice(prefix.length))
      const allowedPath = session.allowed.get(requested)
      if (allowedPath === undefined) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('not found')
        deviceLog().warn('Snapshot request rejected (not in this set)', {
          requested: requested.slice(0, 80)
        })
        return
      }
      filePath = allowedPath
      contentType =
        IMAGE_CONTENT_TYPES[path.extname(requested).toLowerCase()] ?? 'application/octet-stream'
    } else {
      const expected = videoPathFor(session.token, session.fileName)
      if (pathname !== expected) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        deviceLog().warn('Video playback request rejected (bad token)', {
          path: pathname.slice(0, 80)
        })
        return
      }
    }
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('method not allowed')
      return
    }

    const stat = await fs.stat(filePath).catch(() => null)
    if (!stat) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      // 这是本机文件，但仍然不允许任何一层缓存它：文件可能被保留策略删掉。
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    }

    const range = parseRange(rangeHeader, stat.size)
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
      headers['Content-Length'] = String(range.end - range.start + 1)
      response.writeHead(206, headers)
      if (method === 'HEAD') {
        response.end()
        return
      }
      createReadStream(filePath, { start: range.start, end: range.end })
        .on('error', () => response.destroy())
        .pipe(response)
      return
    }

    headers['Content-Length'] = String(stat.size)
    response.writeHead(200, headers)
    if (method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(filePath)
      .on('error', () => response.destroy())
      .pipe(response)
  }
}
