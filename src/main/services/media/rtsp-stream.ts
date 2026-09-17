/**
 * One live RTSP session per camera, and the loopback HTTP server that carries it to
 * the renderer.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE PROBLEM
 * ---------------------------------------------------------------------------
 * The camera publishes H.264 over RTSP. Chromium cannot play RTSP — there is no
 * demuxer for it in the browser stack, so a `<video src="rtsp://…">` fails outright
 * rather than degrading. The renderer also cannot be given a network client: the
 * renderer CSP is `connect-src 'none'` and the whole architecture forbids the UI
 * from reaching a device IP (spec appendix C rule 3).
 *
 * So the flow is:
 *
 *   camera --RTSP/TCP--> ffmpeg (-c:v copy -> fragmented MP4) --pipe--> loopback HTTP
 *                                                                          |
 *                                       renderer <video src="http://127.0.0.1:port/…">
 *
 * ffmpeg pulls and re-MUXES (never re-encodes, unless it provably cannot remux); the
 * main process never buffers the video and never writes it to disk, it only forwards
 * bytes from one pipe to one TCP connection.
 *
 * ---------------------------------------------------------------------------
 * WHY AN HTTP SERVER AT ALL, AND WHY IT IS SAFE
 * ---------------------------------------------------------------------------
 * The alternative — pushing MP4 fragments over IPC — would put a 4 Mbit/s byte
 * stream through the structured-clone channel that also carries device state and
 * UI events, and would require a MediaSource pipeline in the renderer with its own
 * buffering policy. A plain HTTP response is what `<video>` is built for and it
 * gives us the browser's own demuxer and jitter buffer.
 *
 * The server is:
 *   - bound to `127.0.0.1` ONLY, i.e. never reachable from another host, and the
 *     port is ephemeral (`listen(0)`), so nothing else can pre-bind or guess it;
 *   - protected by a random 192-bit token that is part of the PATH. That is the
 *     whole authorisation model, and it is deliberate: any process running as this
 *     user can reach loopback, so the token keeps the stream from being a stable,
 *     guessable URL that unrelated local software (or a web page the user happens to
 *     open in another browser) could pull. A wrong token is a 403, and the request is
 *     logged — a wrong token is either a bug or somebody probing.
 *   - given `Cache-Control: no-store` and no `Content-Length`: a live stream must not
 *     be cached by any layer, and it has no end.
 *
 * ---------------------------------------------------------------------------
 * LIFECYCLE
 * ---------------------------------------------------------------------------
 *   start()  -> resolves the RTSP address from `GET /system/video`, checks ffmpeg,
 *               opens the loopback server, returns the URL
 *   stop()   -> kills the child AND closes the server
 *   dispose()-> kills everything, for application teardown
 *
 * A crashed child is reported as the `error` state with ffmpeg's own stderr tail —
 * never as a silent stop. `idle` means "nobody asked for this camera"; it never
 * means "it broke".
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THE MANUAL DOES NOT SAY (docs/reference/FA371-api-spec.md §8.5 E2/E3)
 * ---------------------------------------------------------------------------
 *   1. how the URL is assembled from `video_port` + `video_url`, and
 *   2. whether RTSP needs the device account, and whether `video_port=443` implies TLS.
 *
 * Neither is guessed. `mappers.buildRtspUrlCandidates()` already turns that
 * uncertainty into a NAMED, ORDERED candidate list (plain form, credential form,
 * `rtsps://` when the port is 443), and this service walks it: the first candidate
 * that produces a byte wins, and each rejection is logged with its candidate id. The
 * same "probe rather than assume" pattern the auth carrier and the WebSocket
 * handshake already use.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS,
  cameraStreamLimitMessage,
  cameraStreamLimitReached,
  normaliseMaxConcurrentStreams,
  type CameraLiveLimits,
  type CameraLiveMode,
  type CameraLiveState
} from '@shared/domain/camera-live'
import type { Fa371RtspUrlCandidate, Fa371VideoConfig } from '@shared/domain/fa371'
import { buildRtspUrlCandidates } from '../device/fa371/mappers'
import { deviceLog } from '../logging/logger'
import {
  buildRtspRemuxArgs,
  buildRtspTranscodeArgs,
  killAllFfmpeg,
  probeFfmpeg,
  spawnFfmpeg,
  type FfmpegProcess
} from './ffmpeg'

/** Whatever `GET /system/video` reported is not enough to build an address. */
const MESSAGE_MISSING_VIDEO_CONFIG =
  '设备未上报 video_port 或 video_url，无法拼出 RTSP 地址；请在相机 Web 界面的「高级设置 → RTSP」中确认。'

/**
 * Default budget for ffmpeg to produce its first byte before a candidate is rejected.
 *
 * MEASURED: ffmpeg does NOT fail fast on an unreachable RTSP address when the
 * transport is TCP — it retries inside libavformat until this budget expires. Because
 * the candidate list can hold up to three entries (plain / with credentials / rtsps
 * when the port is 443), the honest worst case for a wrong address is
 * `candidates × this`. Enabling RTSP on the camera short-circuits before any of this
 * (see the `rtsp-disabled` state), and a camera that answers connects in well under a
 * second — so the budget only ever applies to an address that is genuinely wrong.
 */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 10_000

const STREAM_HEADERS: Record<string, string> = {
  // Fragmented MP4, produced by ffmpeg's mp4 muxer with `-movflags
  // frag_keyframe+empty_moov+default_base_moof`.
  'Content-Type': 'video/mp4',
  // A live stream must never be cached — not by Chromium, not by an intermediate
  // layer. No `Content-Length` either: the stream has no end.
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  // No CORS header is needed: `<video>` may load a cross-origin source without it.
  // CORS would only be required to READ the bytes (canvas readback), which this app
  // never does — and `connect-src 'none'` means fetch()/XHR cannot touch this URL.
  'X-Content-Type-Options': 'nosniff'
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — asserted directly by tests)
// ---------------------------------------------------------------------------

/** A per-session, unguessable path token: 24 random bytes, URL-safe base64. */
export function createSessionToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}

/** The ONE path the live server serves. */
export function streamPathFor(token: string): string {
  return `/${token}/stream.mp4`
}

/** The URL handed to the renderer. Loopback literal, never `localhost`. */
export function buildLoopbackUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}${streamPathFor(token)}`
}

/**
 * Hide any password before an RTSP URL reaches a log file or the UI.
 *
 * `buildRtspUrlCandidates` puts the device account in the URL for its second
 * candidate, and that URL is genuinely useful to display (it is the address the
 * camera answers on) — but the password must not be readable in the app log or on
 * screen. The username is kept: it is not a secret and it is what an operator checks.
 *
 * Parsed rather than regex-replaced because a password may itself contain `@`
 * (`Hz@123456` is the factory password), which makes `user:pass@host` ambiguous to a
 * lazy pattern — an earlier version of this function leaked the tail of the password
 * after the mask. The host boundary is the LAST `@` in the authority, and the user's
 * boundary is the FIRST `:` in the userinfo.
 */
export function maskRtspUrl(url: string): string {
  const parts = /^(rtsp[s]?:\/\/)([^/]*)([\s\S]*)$/i.exec(url)
  if (!parts) return url
  const scheme = parts[1] ?? ''
  const authority = parts[2] ?? ''
  const rest = parts[3] ?? ''
  const at = authority.lastIndexOf('@')
  if (at < 0) return url
  const userinfo = authority.slice(0, at)
  const host = authority.slice(at + 1)
  const colon = userinfo.indexOf(':')
  if (colon < 0) return url
  return `${scheme}${userinfo.slice(0, colon)}:***@${host}${rest}`
}

/**
 * 一台相机当前**可用**的 RTSP 源。
 *
 * `url` 含口令，只能交给 ffmpeg（或由管理员显式触发的「复制/外部播放器」），
 * 永远不进日志、不进 `CameraLiveState`；`maskedUrl` 才是可以显示的那个。
 */
export interface CameraLiveSource {
  url: string
  maskedUrl: string
  candidateId: string
  mode: CameraLiveMode
}

/** One attempt at opening the camera's stream. */
export interface StreamAttempt {
  /** 1-based position, for logs and for `CameraLiveState.attempt`. */
  index: number
  /** Stable candidate id from `mappers.buildRtspUrlCandidates`. */
  candidateId: string
  /** The URL handed to ffmpeg. MAY CONTAIN A PASSWORD — never log this. */
  url: string
  /** Log-safe description (`candidateId rtsp://host:port/path`, password masked). */
  label: string
  mode: CameraLiveMode
}

/**
 * Turn the candidate list into an ordered attempt plan.
 *
 * `preferredMode: 'transcode'` is the explicit operator override; the default is
 * remux for every candidate, with the re-encode fallback inserted lazily (see
 * `insertTranscodeFallback`) only when `copy` provably failed.
 */
export function planAttempts(
  candidates: readonly Fa371RtspUrlCandidate[],
  preferredMode: CameraLiveMode = 'remux'
): StreamAttempt[] {
  return candidates.map((candidate, index) => ({
    index: index + 1,
    candidateId: candidate.id,
    url: candidate.url,
    label: `${candidate.id} ${maskRtspUrl(candidate.url)}`,
    mode: preferredMode
  }))
}

/**
 * Insert a re-encode attempt for the SAME url directly after the failed one.
 *
 * Returns a new array; the caller advances its index by one, which lands on the
 * inserted attempt. Bounded by construction: the same (url, mode) pair can never
 * appear twice, so the attempt loop always terminates.
 */
export function insertTranscodeFallback(
  attempts: readonly StreamAttempt[],
  failedIndex: number
): StreamAttempt[] {
  const failed = attempts[failedIndex]
  if (!failed || failed.mode === 'transcode') return [...attempts]
  if (attempts.some((attempt) => attempt.url === failed.url && attempt.mode === 'transcode')) {
    return [...attempts]
  }
  const inserted: StreamAttempt = {
    ...failed,
    mode: 'transcode',
    label: `${failed.candidateId} (re-encode) ${maskRtspUrl(failed.url)}`
  }
  const next = [...attempts]
  next.splice(failedIndex + 1, 0, inserted)
  return next
}

/**
 * Does this failure mean `-c:v copy` cannot work for this stream?
 *
 * Restricted on purpose. A re-encode costs a full encode per frame, so it is only
 * worth it when the error is about CONTAINER/CODEC COMPATIBILITY rather than about
 * the network or the camera:
 *
 *   - "Could not find codec parameters" / "dimensions not set" — the elementary
 *     stream carries nothing the MP4 muxer can describe.
 *   - "non-existing PPS" / "no frame!" — no in-band parameter sets, so there is no
 *     `avcC` to write.
 *   - "Could not write header" / "muxer does not support" — the muxer refused the
 *     stream outright.
 *
 * A byte that already reached the renderer disqualifies the fallback entirely: the
 * stream WAS remuxable, so whatever happened afterwards is a different problem and
 * re-encoding would hide it. A clean exit (code 0) is the camera closing the stream,
 * not a codec problem.
 */
const COPY_FAILURE_SIGNATURES = [
  'could not find codec parameters',
  'dimensions not set',
  'non-existing pps',
  'no frame!',
  'could not write header',
  'muxer does not support',
  'codec not supported',
  'invalid data found when processing input'
] as const

export function shouldFallbackToTranscode(
  stderrTail: string,
  exitCode: number | null,
  bytesForwarded: number
): boolean {
  if (bytesForwarded > 0) return false
  if (exitCode === 0) return false
  const haystack = stderrTail.toLowerCase()
  return COPY_FAILURE_SIGNATURES.some((signature) => haystack.includes(signature))
}

/** Parse request path without trusting the Host header. */
function pathnameOf(rawUrl: string | undefined): string {
  if (!rawUrl) return '/'
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/**
 * The most informative line ffmpeg produced, for a state an operator has to read.
 *
 * ffmpeg's stderr is mostly its own banner (25 lines of build configuration) and
 * per-frame progress, so "the last line" is usually `libpostproc 55. 4.100`. Only a
 * line that actually describes a failure is worth putting in front of a user, and
 * `undefined` is returned when there is none — the caller then keeps its own
 * (better) explanation, e.g. "produced no output within 10 s".
 */
export function diagnosticLine(stderrTail: string): string | undefined {
  const lines = stderrTail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const interesting = lines.filter((line) =>
    /error|refus|timed? ?out|timeout|invalid|unable|cannot|not found|unauthor|401|403|404/i.test(line)
  )
  return interesting[interesting.length - 1]?.slice(0, 200)
}

// ---------------------------------------------------------------------------
// What the service needs from the rest of the app
// ---------------------------------------------------------------------------

export interface CameraLiveDeviceHandle {
  id: string
  /** Address of the camera's web interface; the RTSP host is the same host. */
  host: string
  /** Device account, used ONLY for the credential candidate of the RTSP URL. */
  credential?: { username: string; password: string }
}

export interface CameraLiveResolver {
  getDevice(deviceId: string): CameraLiveDeviceHandle
  /** `GET /system/video`, mapped. Throws when the camera cannot be reached. */
  getVideoConfig(deviceId: string): Promise<Fa371VideoConfig>
}

export interface RtspStreamServiceOptions {
  resolver: CameraLiveResolver
  /** Injectable for tests. Defaults to the real `spawnFfmpeg`. */
  spawn?: typeof spawnFfmpeg
  /** Injectable for tests. Defaults to the real (cached) `probeFfmpeg`. */
  probe?: typeof probeFfmpeg
  /** How long ffmpeg may take to produce a first byte before that candidate is dropped. */
  firstByteTimeoutMs?: number
  /**
   * 同时直播的路数上限。
   *
   * 写成「数字或取值函数」两种形态：生产环境传 `() => settings.get().maxConcurrentCameraStreams`
   * （改设置立刻生效，不必重建服务），测试直接传数字。
   */
  maxConcurrentStreams?: number | (() => number)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface SessionOptions {
  deviceId: string
  attempts: StreamAttempt[]
  spawnFfmpeg: typeof spawnFfmpeg
  firstByteTimeoutMs: number
  /** Masked, for the state and for every log line. */
  rtspUrl: string
}

/**
 * One camera, one server, one ffmpeg child, one viewer.
 *
 * "One viewer" is a decision, not an accident: a second request for the SAME camera
 * (the `<video>` element reloading, or a second window) replaces the first rather
 * than opening a second RTSP connection to that camera. A second DIFFERENT camera is
 * a second session — see the concurrency note on `RtspStreamService`.
 */
class CameraLiveSession {
  readonly token = createSessionToken()
  private readonly options: SessionOptions
  private attempts: StreamAttempt[]
  private attemptIndex = 0
  private server?: Server
  private viewer?: ServerResponse
  private child?: FfmpegProcess
  private firstByteTimer?: NodeJS.Timeout
  private port = 0
  private stopped = false
  private streaming = false
  private bytesSent = 0
  private status: CameraLiveState['status'] = 'starting'
  private error?: string
  /** Most recent useful failure line, so the final state can quote ffmpeg. */
  private lastDiagnostic = ''
  private mode: CameraLiveMode
  private readonly startedAt = Date.now()

  constructor(options: SessionOptions) {
    this.options = options
    this.attempts = options.attempts
    this.mode = options.attempts[0]?.mode ?? 'remux'
  }

  /** Bind the loopback server. Resolves once it is listening. */
  async listen(): Promise<void> {
    const server = createServer((request, response) => this.handleRequest(request, response))
    this.server = server

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
      // LOOPBACK ONLY + ephemeral port. `127.0.0.1` rather than `localhost` on
      // purpose: `localhost` is resolved through the hosts file and can be pointed
      // elsewhere, and a Windows firewall rule for a public interface cannot match
      // a loopback-only listener.
      server.listen(0, '127.0.0.1')
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new AppError(ErrorCodes.NETWORK_ERROR, '本地视频服务未能绑定端口')
    }
    this.port = address.port
    deviceLog().info('Camera live: loopback stream server listening', {
      deviceId: this.options.deviceId,
      port: this.port
    })
  }

  get url(): string {
    return buildLoopbackUrl(this.port, this.token)
  }

  /**
   * 这个会话是否已经占住了资源（回环服务 + ffmpeg）。
   *
   * 只回答「占没占」，不回答「出没出帧」：`starting` 同样花掉一个端口和一个
   * ffmpeg 子进程，所以它必须计入并发预算。`stop()` 之后一律为 `false`。
   */
  isActive(): boolean {
    return !this.stopped
  }

  /**
   * 当前会话真正在用的 RTSP 地址（**含口令**，可直接交给 ffmpeg）。
   *
   * 只在 `playing` 时返回：`starting` 还没有任何一帧，此时开第二个 ffmpeg 去
   * 录像会写出一个没有关键帧的空文件，抓图也必然抓空。
   *
   * 这个值**绝不能**进日志或界面——对外只有 `CameraLiveState.rtspUrl`（打码）。
   * 它存在的唯一理由是：手动录像/抓图/「在外部播放器打开」需要一个能打开的地址，
   * 而打码地址在播放器里打不开。
   */
  usableSource(): CameraLiveSource | undefined {
    if (this.stopped || this.status !== 'playing') return undefined
    const attempt = this.attempts[this.attemptIndex]
    if (!attempt) return undefined
    return {
      url: attempt.url,
      maskedUrl: maskRtspUrl(attempt.url),
      candidateId: attempt.candidateId,
      mode: attempt.mode
    }
  }

  snapshot(): CameraLiveState {
    const current = this.attempts[this.attemptIndex]
    const state: CameraLiveState = {
      deviceId: this.options.deviceId,
      status: this.stopped ? 'idle' : this.status,
      rtspUrl: this.options.rtspUrl,
      mode: this.mode,
      startedAt: this.startedAt,
      bytesSent: this.bytesSent,
      attempt: current?.index ?? this.attempts.length,
      ...(current ? { attemptId: current.candidateId } : {})
    }
    if (!this.stopped && this.status !== 'idle') state.url = this.url
    if (this.error) state.error = this.error
    return state
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearFirstByteTimer()
    this.killChild()
    this.endViewer()
    this.viewer = undefined
    this.streaming = false
    const server = this.server
    this.server = undefined
    if (server) {
      try {
        // `close()` stops accepting new connections; `closeAllConnections()` is what
        // actually releases a keep-alive socket a browser is holding open, without
        // which the port would linger until the renderer navigated away.
        server.close()
        server.closeAllConnections?.()
      } catch (error) {
        deviceLog().debug('Camera live: closing loopback server failed', {
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.status = 'idle'
    deviceLog().info('Camera live: session stopped', {
      deviceId: this.options.deviceId,
      bytesSent: this.bytesSent
    })
  }

  // -- request handling ----------------------------------------------------

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (this.stopped) {
      response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('session stopped')
      return
    }

    const pathname = pathnameOf(request.url)
    if (pathname !== streamPathFor(this.token)) {
      // The token in the path IS the authentication. Refusing here (rather than
      // serving anyway) is what keeps the camera feed from being a stable URL that
      // any local process or stray web page could pull, and logging it distinguishes
      // "our renderer used a stale URL" from "something is probing loopback".
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('forbidden')
      deviceLog().warn('Camera live: request rejected (bad token)', {
        deviceId: this.options.deviceId,
        path: pathname.slice(0, 80)
      })
      return
    }

    if (request.method !== 'GET') {
      // HEAD is refused rather than answered: there is no meaningful length, and a
      // 200 with no body would look like a working stream to anything probing.
      response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('method not allowed')
      return
    }

    // Replace any previous viewer (the <video> element reloading, a second window).
    if (this.viewer && this.viewer !== response) {
      deviceLog().debug('Camera live: replacing existing viewer', { deviceId: this.options.deviceId })
      this.killChild()
      this.endViewer()
    }

    this.viewer = response
    this.attemptIndex = 0
    this.streaming = false
    this.bytesSent = 0
    this.status = 'starting'
    this.error = undefined

    response.on('close', () => {
      if (this.viewer === response) {
        // The client went away: stop pulling from the camera immediately rather
        // than letting ffmpeg fill a pipe nobody reads.
        this.killChild()
        this.viewer = undefined
        this.streaming = false
      }
    })
    response.on('drain', () => {
      // Backpressure release: the renderer caught up, so let ffmpeg run again.
      this.child?.stdout.resume()
    })

    this.runAttempt()
  }

  // -- ffmpeg --------------------------------------------------------------

  private runAttempt(): void {
    if (this.stopped || !this.viewer) return
    const attempt = this.attempts[this.attemptIndex]
    if (!attempt) {
      // Every candidate is exhausted. Quote the last real diagnostic rather than
      // only the count: "3 candidates failed" alone tells an operator nothing about
      // whether the address was refused, unauthorised, or never answered.
      const detail = this.lastDiagnostic === '' ? '' : `（最后诊断：${this.lastDiagnostic}）`
      this.fail(
        `无法打开相机视频流：${this.attempts.length} 个 RTSP 地址候选全部失败` +
          `（最后一个候选 ${this.attempts[this.attempts.length - 1]?.candidateId ?? '?'}）${detail}`
      )
      return
    }

    this.mode = attempt.mode
    const args =
      attempt.mode === 'transcode'
        ? buildRtspTranscodeArgs(attempt.url)
        : buildRtspRemuxArgs(attempt.url)

    deviceLog().info('Camera live: starting ffmpeg', {
      deviceId: this.options.deviceId,
      attempt: attempt.index,
      candidate: attempt.candidateId,
      mode: attempt.mode,
      target: attempt.label
    })

    let child: FfmpegProcess
    try {
      child = this.options.spawnFfmpeg(args, { label: `camera-live:${this.options.deviceId}` })
    } catch (error) {
      // A missing/broken transcoder: say so, and never leave a black rectangle.
      this.status = 'ffmpeg-missing'
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }

    this.child = child
    const viewer = this.viewer
    let firstChunkSeen = false

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped || this.viewer !== viewer) return
      this.bytesSent += chunk.length
      if (!firstChunkSeen) {
        firstChunkSeen = true
        this.streaming = true
        this.clearFirstByteTimer()
        this.status = 'playing'
        this.error = undefined
        if (!viewer.headersSent) viewer.writeHead(200, STREAM_HEADERS)
        deviceLog().info('Camera live: streaming', {
          deviceId: this.options.deviceId,
          candidate: attempt.candidateId,
          mode: attempt.mode
        })
      }
      if (viewer.writableEnded || viewer.destroyed) return
      if (!viewer.write(chunk)) {
        // Bounded memory: stop PULLING from ffmpeg instead of queueing the stream in
        // this process. That is the only place latency could accumulate unauthorised.
        child.stdout.pause()
      }
    })

    child.stdout.on('end', () => {
      // END THE RESPONSE ONLY IF SOMETHING WAS ACTUALLY SENT.
      //
      // Without this guard a child that dies before producing a byte ends the
      // response here, and Node answers an ended-but-never-started response with an
      // implicit `200 OK` and an empty body — i.e. exactly the silent black
      // rectangle this whole file exists to prevent, emitted by our own server.
      // Letting `onChildExit` own that case means the next candidate is tried, and
      // the final answer is a 502 with the reason in the body.
      if (!this.streaming) return
      if (this.viewer === viewer && !viewer.writableEnded) viewer.end()
    })

    void child.exited.then(({ code, signal }) => this.onChildExit(child, code, signal))
    this.armFirstByteTimer()
  }

  private onChildExit(child: FfmpegProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = undefined
    this.clearFirstByteTimer()
    if (this.stopped || !this.viewer) return

    const tail = child.stderrTail()

    if (this.streaming) {
      // Bytes already reached the renderer, so this is a genuine mid-stream failure:
      // report it instead of silently stopping, and let the UI say what happened.
      this.status = 'error'
      this.error = `视频流中断（ffmpeg ${code === null ? `signal ${String(signal)}` : `退出码 ${code}`}）：${
        lastLine(tail) || '无 stderr 输出'
      }`
      deviceLog().warn('Camera live: stream ended unexpectedly', {
        deviceId: this.options.deviceId,
        code,
        signal,
        tail: tail.slice(-400)
      })
      this.endViewer()
      return
    }

    const attempt = this.attempts[this.attemptIndex]
    deviceLog().warn('Camera live: ffmpeg failed before producing data', {
      deviceId: this.options.deviceId,
      candidate: attempt?.candidateId ?? '(none)',
      mode: attempt?.mode ?? '(none)',
      code,
      signal,
      tail: tail.slice(-400)
    })

    // Keep the one line worth showing, if ffmpeg produced one. Otherwise the
    // timeout message (or the candidate's own rejection) stands.
    const guess = diagnosticLine(tail)
    if (guess) this.lastDiagnostic = guess

    if (attempt?.mode === 'remux' && shouldFallbackToTranscode(tail, code, this.bytesSent)) {
      // EXPLICIT, LOGGED fallback. `-c:v copy` failed for a reason that re-encoding
      // can fix (see `shouldFallbackToTranscode`); the CPU cost is accepted here and
      // nowhere else.
      deviceLog().warn('Camera live: -c:v copy cannot carry this stream, falling back to re-encode', {
        deviceId: this.options.deviceId,
        candidate: attempt.candidateId,
        reason: lastLine(tail)
      })
      this.attempts = insertTranscodeFallback(this.attempts, this.attemptIndex)
    }

    this.attemptIndex += 1
    this.runAttempt()
  }

  private armFirstByteTimer(): void {
    this.clearFirstByteTimer()
    this.firstByteTimer = setTimeout(() => {
      this.firstByteTimer = undefined
      if (this.stopped || !this.child) return
      deviceLog().warn('Camera live: ffmpeg produced no data in time', {
        deviceId: this.options.deviceId,
        timeoutMs: this.options.firstByteTimeoutMs
      })
      this.lastDiagnostic = `ffmpeg 在 ${Math.round(this.options.firstByteTimeoutMs / 1000)} 秒内没有输出（地址不可达或相机未推流）`
      // Killing it makes `onChildExit` run with `streaming === false`, which advances
      // to the next candidate.
      this.child.kill()
    }, this.options.firstByteTimeoutMs)
    // Never let a pending timeout keep the process alive on its own.
    this.firstByteTimer.unref?.()
  }

  private clearFirstByteTimer(): void {
    if (this.firstByteTimer) {
      clearTimeout(this.firstByteTimer)
      this.firstByteTimer = undefined
    }
  }

  private killChild(): void {
    const child = this.child
    this.child = undefined
    this.clearFirstByteTimer()
    child?.kill()
  }

  private endViewer(): void {
    const viewer = this.viewer
    if (!viewer) return
    if (!viewer.writableEnded) {
      if (!viewer.headersSent) {
        // Nothing was ever written: answer as a failure rather than as an empty 200,
        // so the <video> element raises `error` and the UI can explain itself.
        viewer.writeHead(502, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        })
      }
      viewer.end(this.error ?? '')
    }
  }

  private fail(reason: string): void {
    this.error = reason
    if (this.status !== 'ffmpeg-missing') this.status = 'error'
    deviceLog().error('Camera live: failed', {
      deviceId: this.options.deviceId,
      status: this.status,
      reason
    })
    this.endViewer()
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Registry of live sessions, one per camera.
 *
 * CONCURRENCY (multi-camera video wall)
 * Several DIFFERENT cameras may stream at the same time: the map is keyed by
 * `deviceId`, and every session owns its own loopback server, its own ephemeral
 * port and its own 192-bit path token, so N sessions never share an endpoint and
 * `stop(deviceId)` releases exactly one of them. The one-camera-one-cell rule the
 * product owner asked for lives in the RENDERER's wall model (`lib/cameraWall.ts`),
 * not here — the main process has no idea how many cells a page has.
 *
 * The cap that DOES live here is the local resource budget: each session is an
 * ffmpeg child, a bound socket and a re-mux buffer in THIS process, so an unbounded
 * wall would exhaust the machine long before the camera's own
 * `rtsp_client_limit` (measured 10) complained. `maxConcurrentStreams` is that
 * budget, configurable through `AppSettings`, and exceeding it is reported as the
 * honest `limit-exceeded` state rather than as an error or a silent drop.
 *
 * Deliberately NOT built on `StreamManager`/`Fa371StreamService`: those own
 * WebSocket channels carrying decimated previews, and this owns a byte pipe to an
 * ffmpeg process. Sharing them would mean one class branching on "preview or video",
 * which is how the wrong thing ends up sending the wrong payload.
 */
export class RtspStreamService {
  private readonly sessions = new Map<string, CameraLiveSession>()
  private readonly spawnImpl: typeof spawnFfmpeg
  private readonly probeImpl: typeof probeFfmpeg
  private readonly firstByteTimeoutMs: number
  private readonly maxConcurrentOption: number | (() => number)
  private disposed = false

  constructor(private readonly options: RtspStreamServiceOptions) {
    this.spawnImpl = options.spawn ?? spawnFfmpeg
    this.probeImpl = options.probe ?? probeFfmpeg
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS
    this.maxConcurrentOption = options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_CAMERA_STREAMS
  }

  /**
   * 本机同时直播的预算与用量。
   *
   * `active + 1` 是**保守**的：`starting` 的会话也在计数里（它确实已经占了一个
   * ffmpeg 子进程和一个回环服务），所以界面看到的上限判断与 `start()` 的拒绝条件
   * 完全一致，不需要渲染层自己去折算。
   */
  limits(): CameraLiveLimits {
    return { max: this.maxConcurrentStreams(), active: this.activeStreamCount() }
  }

  /** 当前上限（每次都重新问设置，改完立刻生效）。 */
  private maxConcurrentStreams(): number {
    const raw =
      typeof this.maxConcurrentOption === 'function' ? this.maxConcurrentOption() : this.maxConcurrentOption
    return normaliseMaxConcurrentStreams(raw)
  }

  /**
   * 正在直播的路数。
   *
   * 数的是**会话**，不是「有 viewer 的会话」：一个已经 `start()` 但还没有任何
   * `<video>` 连上来的会话同样持有 ffmpeg 与回环端口，把它排除在外会让上限变成
   * 「连上才计数」，而预算本来是按资源占用来定的。
   */
  private activeStreamCount(): number {
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.isActive()) count += 1
    }
    return count
  }

  /**
   * Start the live view for one camera and return its loopback URL.
   *
   * Returns a STATE rather than throwing for the two conditions that are facts
   * rather than faults — `rtsp-disabled` and `ffmpeg-missing` — because both need a
   * specific instruction on screen, and an exception would collapse them into the
   * generic error toast.
   */
  async start(deviceId: string, mode: CameraLiveMode = 'remux'): Promise<CameraLiveState> {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, '相机实时视频服务已释放')
    if (typeof deviceId !== 'string' || deviceId.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
    }

    const device = this.options.resolver.getDevice(deviceId)
    const video = await this.options.resolver.getVideoConfig(deviceId)

    // `rtsp_enabled = 0` (the value the real camera reports today) means the device's
    // own RTSP service is OFF. Spawning ffmpeg at it would produce a connection
    // timeout and an error message that blames the network, so report the device
    // fact instead — and never create a server for a stream that cannot exist.
    if (video.rtspEnabled !== true) {
      this.stop(deviceId)
      const state: CameraLiveState = {
        deviceId,
        status: 'rtsp-disabled',
        error:
          '相机的 RTSP 服务处于关闭状态（设备上报 rtsp_enabled=0）。' +
          '请在相机 Web 界面的「高级设置 → RTSP」中启用后再试。',
        mode
      }
      const address = rtspAddressOf(device, video)
      if (address) state.rtspUrl = address
      deviceLog().info('Camera live: refused because RTSP is disabled on the device', {
        deviceId,
        rtspEnabled: video.rtspEnabled ?? '(not reported)'
      })
      return state
    }

    const candidates = buildRtspUrlCandidates(device.host, video, device.credential)
    const maskedPrimary = candidates[0] ? maskRtspUrl(candidates[0].url) : undefined
    if (candidates.length === 0) {
      this.stop(deviceId)
      deviceLog().warn('Camera live: video config cannot form an RTSP address', {
        deviceId,
        rtspPort: video.rtspPort ?? '(missing)',
        rtspPath: video.rtspPath ?? '(missing)'
      })
      return { deviceId, status: 'error', error: MESSAGE_MISSING_VIDEO_CONFIG, mode }
    }

    // Verify ONCE, before any server exists: a missing transcoder has to be visible
    // as a state, not as a stream that never starts.
    const probe = await this.probeImpl()
    if (!probe.ok) {
      this.stop(deviceId)
      return {
        deviceId,
        status: 'ffmpeg-missing',
        error: probe.error ?? '内置 ffmpeg 不可用',
        ...(maskedPrimary ? { rtspUrl: maskedPrimary } : {}),
        mode
      }
    }

    // One session per camera: a repeated start replaces the previous one instead of
    // leaking a second server and a second RTSP connection.
    this.stop(deviceId)

    // 并发预算：**替换**这台相机已有的一路不算新增，所以放在 `stop(deviceId)`
    // 之后、真正新建会话之前。超出的这一路得到 `limit-exceeded` 这个状态而不是
    // 一个异常——它与 `rtsp-disabled` / `ffmpeg-missing` 一样是一条需要写在屏幕上的
    // 指令（「先停掉别的画面格」），而不是把界面炸进通用错误提示。
    const maxStreams = this.maxConcurrentStreams()
    const activeStreams = this.activeStreamCount()
    if (cameraStreamLimitReached(activeStreams, maxStreams)) {
      deviceLog().warn('Camera live: refused because the concurrency budget is full', {
        deviceId,
        activeStreams,
        maxStreams,
        mode
      })
      return {
        deviceId,
        status: 'limit-exceeded',
        error: cameraStreamLimitMessage(activeStreams, maxStreams),
        ...(maskedPrimary ? { rtspUrl: maskedPrimary } : {}),
        mode
      }
    }

    const session = new CameraLiveSession({
      deviceId,
      attempts: planAttempts(candidates, mode),
      spawnFfmpeg: this.spawnImpl,
      firstByteTimeoutMs: this.firstByteTimeoutMs,
      rtspUrl: maskedPrimary ?? ''
    })

    try {
      await session.listen()
    } catch (error) {
      session.stop()
      throw AppError.from(error, ErrorCodes.NETWORK_ERROR)
    }

    this.sessions.set(deviceId, session)
    deviceLog().info('Camera live: started', {
      deviceId,
      candidates: candidates.map((candidate) => candidate.id),
      mode,
      rtspUrl: maskedPrimary
    })
    return session.snapshot()
  }

  /** Stop one camera (or every camera). Idempotent. */
  stop(deviceId?: string): void {
    const ids = deviceId ? [deviceId] : [...this.sessions.keys()]
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue
      this.sessions.delete(id)
      session.stop()
    }
  }

  /** Snapshots; with a deviceId, that device only (empty when nothing is live). */
  listState(deviceId?: string): CameraLiveState[] {
    const ids = deviceId ? [deviceId] : [...this.sessions.keys()]
    return ids
      .map((id) => this.sessions.get(id))
      .filter((session): session is CameraLiveSession => Boolean(session))
      .map((session) => session.snapshot())
  }

  /**
   * 这台相机当前可用的 RTSP 源（含口令），供手动录像 / 抓图 / 外部播放器使用。
   *
   * 返回 `undefined` 表示**现在不能录也不能抓**（没有会话，或还没出帧）；
   * 调用方据此给出诚实的拒绝理由，而不是硬开一个 ffmpeg 去写空文件。
   */
  currentSource(deviceId: string): CameraLiveSource | undefined {
    return this.sessions.get(deviceId)?.usableSource()
  }

  /**
   * Application teardown.
   *
   * `killAllFfmpeg()` is the belt to `stop()`'s braces: every session kills its own
   * child, and this sweeps up anything that somehow outlived its session. An orphaned
   * ffmpeg holding an RTSP connection on an industrial network is invisible until the
   * camera refuses a new one (the measured `rtsp_client_limit` is 6).
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    const killed = killAllFfmpeg()
    deviceLog().info('Camera live: service disposed', { orphanedFfmpegKilled: killed })
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The address to SHOW, even when it cannot be used (password masked). */
function rtspAddressOf(device: CameraLiveDeviceHandle, video: Fa371VideoConfig): string | undefined {
  const host = device.host?.trim()
  if (!host || video.rtspPort === undefined) return undefined
  const path = (video.rtspPath ?? '').replace(/^\/+/, '')
  if (path === '') return undefined
  return `rtsp://${host}:${video.rtspPort}/${path}`
}

function lastLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return lines[lines.length - 1]?.trim().slice(0, 200) ?? ''
}
