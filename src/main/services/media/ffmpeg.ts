/**
 * ffmpeg wrapper — the SINGLE place that knows where the binary is and how to run it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS AN ffmpeg AT ALL
 * ---------------------------------------------------------------------------
 * The FA371 camera publishes H.264 over RTSP (`rtsp://<ip>:<video_port>/<video_url>`,
 * measured on real hardware as `video_port=443`, `video_url="live"` — see
 * docs/FA371-INTEGRATION.md §5.3). Chromium/Electron CANNOT play RTSP: there is no
 * RTSP demuxer in the browser stack, so `<video src="rtsp://…">` fails outright —
 * it does not degrade to audio-only or to a still frame, it produces the black
 * rectangle the product owner complained about. Something has to pull the RTSP
 * stream and re-mux it into a container Chromium does understand (fragmented MP4
 * over a plain HTTP byte stream). That something is ffmpeg.
 *
 * ---------------------------------------------------------------------------
 * WHAT SHIPS, ITS SIZE AND ITS LICENCE (do not re-litigate this from scratch)
 * ---------------------------------------------------------------------------
 * Dependency: `@ffmpeg-installer/ffmpeg@1.1.0` (npm, `dependencies`) plus its
 * platform package `@ffmpeg-installer/win32-x64@4.1.0`, which is an
 * `optionalDependency` of the first and therefore installed automatically.
 *
 *   - It carries a PREBUILT `ffmpeg.exe` INSIDE the npm package. No GitHub release
 *     download and no C++ toolchain — both of which matter here: this environment
 *     cannot reach GitHub releases, and BUILD.md §2 records that the project has no
 *     MSVC toolchain at all. This is the same reasoning that picked
 *     `@duckdb/node-api` over `duckdb`.
 *   - SIZE: the Windows binary is ~64.5 MB (67,588,096 bytes measured on
 *     2026-09; `stat` it if you need the exact figure). It is the single largest
 *     thing in the installation and it is ~60 % of the previous 105.5 MB installer
 *     once compressed. That cost was accepted deliberately, for in-app live video.
 *   - LICENCE: the wrapper package is LGPL-2.1, but the BINARY it ships is
 *     **GPLv3**. Its own `package.json` says `"license": "GPLv3"`, and the build
 *     identity printed by `ffmpeg -version` confirms it:
 *     `--enable-gpl --enable-version3` (with `--enable-libx264`). So the shipped
 *     transcoder is a GPL build, not an LGPL one.
 *   - CONSEQUENCE: shipping it does NOT relicense this application (ffmpeg is
 *     invoked as a separate process over a pipe, which is the "mere aggregation"
 *     side of the line rather than linking), but it does mean:
 *       1. every distributed installer now contains a GPLv3 binary, so the GPLv3
 *          text and a written offer of ffmpeg's corresponding source must accompany
 *          the release; and
 *       2. the binary must not be replaced by an LGPL build without re-checking
 *          whether `libx264` is still present — the re-encode fallback below
 *          needs it.
 *     The upstream source URLs are in the platform package's `homepage`
 *     (`https://ffmpeg.zeranoe.com/builds/win64/static/`) and the build identity is
 *     reproducible from `ffmpeg -version`. Record both in the release notes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATH RESOLUTION IS NOT JUST `require('@ffmpeg-installer/ffmpeg').path`
 * ---------------------------------------------------------------------------
 * A binary CANNOT be executed from inside an asar archive: `spawn()` asks the OS to
 * create a process from a path, and the OS knows nothing about asar. The installer
 * package happily resolves a path that lives INSIDE `app.asar` (its `fs.existsSync`
 * goes through Electron's asar shim and answers "yes"), so the naive lookup returns
 * a path that exists and cannot run. The failure is an `ENOENT` at spawn time, i.e.
 * exactly the "silent black rectangle" this file exists to prevent.
 *
 * Therefore: when `app.isPackaged` is true the packaged location is preferred, and
 * every path derived from the installer is rewritten `app.asar` -> `app.asar.unpacked`
 * (matching `asarUnpack` in electron-builder.yml). In development the
 * `node_modules/…` path is used directly.
 *
 * ---------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------------
 *   resolveFfmpegPath()  pure-ish path selection (dev vs packaged), no I/O beyond existsSync
 *   probeFfmpeg()        runs `-version` ONCE, caches the outcome, never throws
 *   verifyFfmpeg()       the same probe, but throws a loggable AppError when unusable
 *   build*Args()         small pure arg builders (remux / transcode / synthetic source)
 *   spawnFfmpeg()        the only place a child is created: stderr -> log, no stdin,
 *                        kill guarantee, module-level registry so nothing is orphaned
 *
 * A missing or non-runnable transcoder must NEVER surface as a black rectangle: the
 * probe result is carried into the camera-live state so the UI can say "ffmpeg 缺失"
 * with the exact path it looked in.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'

/** npm package that carries the prebuilt binary (a `dependencies` entry). */
export const FFMPEG_NPM_PACKAGE = '@ffmpeg-installer/ffmpeg'
/** Scope of the platform packages; `@ffmpeg-installer/<platform>-<arch>` holds the exe. */
export const FFMPEG_PACKAGE_SCOPE = '@ffmpeg-installer'
/** Environment override, for support and for the packaging checks. */
export const FFMPEG_PATH_ENV = 'HERTZINNO_FFMPEG_PATH'
/** How long `-version` may take before the binary is declared unusable. */
const VERSION_PROBE_TIMEOUT_MS = 10_000
/** stderr lines kept for diagnostics (a fragment-per-keyframe stream is chatty). */
const STDERR_TAIL_LINES = 40
/** One stderr line is truncated to this before it reaches a ring buffer or the log. */
const STDERR_LINE_MAX = 400

// ---------------------------------------------------------------------------
// Where the binary lives
// ---------------------------------------------------------------------------

export type FfmpegLocationSource = 'env' | 'packaged-unpacked' | 'node_modules'

export interface FfmpegLocation {
  path: string
  source: FfmpegLocationSource
  /** Whether the chosen path exists on disk right now. */
  exists: boolean
  /** Every path considered, best first — quoted verbatim in the failure message. */
  considered: string[]
}

export interface FfmpegResolveOptions {
  /** Override for tests and for the packaging checks. */
  isPackaged?: boolean
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: string
  /** Project root used for the development fallback path. */
  appPath?: string
}

/**
 * Electron's `app`, resolved lazily and defensively.
 *
 * Under a plain Node process (unit tests, the protocol CLI) `require('electron')`
 * yields a STRING — the path to the Electron binary — so destructuring `app` at
 * module scope would be `undefined` and the first property access would throw. Same
 * pattern as `logging/logger.ts`, for the same reason: this module has to be
 * importable by `node --test`.
 */
function electronApp(): { isPackaged?: boolean } | undefined {
  try {
    const electron = require('electron') as { app?: { isPackaged?: boolean } } | string
    if (typeof electron === 'string') return undefined
    return electron.app
  } catch {
    return undefined
  }
}

/** True only when running from a packaged Electron app. */
export function isPackagedRuntime(): boolean {
  return electronApp()?.isPackaged === true
}

/** Electron's resources directory (`.../resources`), if this is an Electron run. */
function resourcesPathNow(): string | undefined {
  const value = (process as unknown as { resourcesPath?: unknown }).resourcesPath
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function ffmpegBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/** `win32-x64` — the platform package name suffix, i.e. `@ffmpeg-installer/win32-x64`. */
export function ffmpegPlatformDir(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

/**
 * `…/app.asar/…` -> `…/app.asar.unpacked/…`.
 *
 * Exported because it is the one non-obvious string transformation in the packaged
 * path resolution, and it is worth a unit test of its own.
 */
export function unpackFromAsar(filePath: string): string {
  return filePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

/** Where the installer package THINKS its binary is (may point inside app.asar). */
function reportedInstallerPath(): string | undefined {
  try {
    const installer = require(FFMPEG_NPM_PACKAGE) as { path?: unknown }
    return typeof installer?.path === 'string' && installer.path.length > 0 ? installer.path : undefined
  } catch (error) {
    deviceLog().debug('ffmpeg installer package did not resolve', {
      reason: error instanceof Error ? error.message : String(error)
    })
    return undefined
  }
}

/**
 * Choose the executable path.
 *
 * Order is deliberate:
 *   packaged  -> unpacked location (asar-internal paths cannot be executed)
 *   dev       -> whatever `@ffmpeg-installer/ffmpeg` resolved to, then the project's
 *                own `node_modules` path
 *
 * `exists` is false when NOTHING was found; the first candidate is still returned so
 * the error message can name the path that was expected.
 */
export function resolveFfmpegPath(options: FfmpegResolveOptions = {}): FfmpegLocation {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const binary = ffmpegBinaryName(platform)
  const dir = ffmpegPlatformDir(platform, arch)
  const isPackaged = options.isPackaged ?? isPackagedRuntime()
  const resourcesPath = options.resourcesPath ?? resourcesPathNow()
  const appPath = options.appPath ?? process.env.HERTZINNO_APP_PATH ?? process.cwd()

  const reported = reportedInstallerPath()
  const candidates: Array<{ path: string; source: FfmpegLocationSource }> = []

  const override = process.env[FFMPEG_PATH_ENV]
  if (override && override.trim() !== '') {
    candidates.push({ path: override.trim(), source: 'env' })
  }

  if (isPackaged) {
    // Preferred: the ASAR-UNPACKED location, derived from what the installer
    // reported so a differently-laid-out npm tree still resolves.
    if (reported) {
      candidates.push({ path: unpackFromAsar(reported), source: 'packaged-unpacked' })
    }
    if (resourcesPath) {
      candidates.push({
        path: path.join(
          resourcesPath,
          'app.asar.unpacked',
          'node_modules',
          FFMPEG_PACKAGE_SCOPE,
          dir,
          binary
        ),
        source: 'packaged-unpacked'
      })
    }
    // Last resort: the asar-internal path. It cannot be executed — naming it in the
    // error is still more useful than naming nothing, because it shows that the
    // package WAS collected and only the unpack step is missing.
    if (reported) candidates.push({ path: reported, source: 'packaged-unpacked' })
  } else {
    if (reported) candidates.push({ path: reported, source: 'node_modules' })
    candidates.push({
      path: path.join(appPath, 'node_modules', FFMPEG_PACKAGE_SCOPE, dir, binary),
      source: 'node_modules'
    })
  }

  const found = candidates.find((candidate) => existsSync(candidate.path))
  const chosen =
    found ??
    candidates[0] ?? {
      path: path.join(appPath, 'node_modules', FFMPEG_PACKAGE_SCOPE, dir, binary),
      source: 'node_modules' as const
    }

  return {
    path: chosen.path,
    source: chosen.source,
    exists: Boolean(found),
    considered: candidates.map((candidate) => candidate.path)
  }
}

// ---------------------------------------------------------------------------
// The one verification
// ---------------------------------------------------------------------------

export interface FfmpegProbeResult {
  ok: boolean
  path: string
  source: FfmpegLocationSource
  /** Version parsed from the binary's own banner (`N-92722-gf22fcd4483`). */
  version?: string
  /** First line of `ffmpeg -version`. */
  banner?: string
  /** Version declared by the npm platform package (`20181217-f22fcd4`). */
  installerVersion?: string
  /** Operator-facing reason when `ok` is false. */
  error?: string
}

export interface FfmpegInfo {
  path: string
  version: string
  banner: string
  source: FfmpegLocationSource
}

let cachedProbe: Promise<FfmpegProbeResult> | undefined

/** Drop the cached probe. Tests only (and an explicit `force` re-probe). */
export function resetFfmpegProbe(): void {
  cachedProbe = undefined
}

/**
 * Run `-version` ONCE and remember the outcome — success OR failure.
 *
 * Never rejects: the caller decides whether a missing transcoder is fatal (the IPC
 * boundary reports it) or merely a state to display (the live-view panel does).
 *
 * Caching the FAILURE is intentional: the binary cannot appear while the process
 * runs, and re-spawning a failing executable on every UI interaction would turn one
 * problem into a log storm. `force: true` exists for the packaging checks.
 */
export function probeFfmpeg(options: { force?: boolean } = {}): Promise<FfmpegProbeResult> {
  if (!cachedProbe || options.force) cachedProbe = runProbe()
  return cachedProbe
}

/** The same probe, but throwing a typed, loggable error when ffmpeg is unusable. */
export async function verifyFfmpeg(options: { force?: boolean } = {}): Promise<FfmpegInfo> {
  const probe = await probeFfmpeg(options)
  if (!probe.ok || !probe.version || !probe.banner) {
    throw new AppError(
      ErrorCodes.NOT_IMPLEMENTED,
      '内置 ffmpeg 不可用，无法把相机视频流转封装给界面播放',
      probe.error ?? probe.path
    )
  }
  return { path: probe.path, version: probe.version, banner: probe.banner, source: probe.source }
}

async function runProbe(): Promise<FfmpegProbeResult> {
  const location = resolveFfmpegPath()
  const base = { path: location.path, source: location.source }

  if (!location.exists) {
    const error =
      `找不到 ffmpeg 可执行文件：${location.path}` +
      `（打包版本必须解包到 app.asar.unpacked，见 electron-builder.yml 的 asarUnpack）` +
      `；已尝试：${location.considered.join(' | ')}`
    deviceLog().error('ffmpeg binary is missing', {
      path: location.path,
      considered: location.considered,
      packaged: isPackagedRuntime()
    })
    return { ok: false, ...base, error }
  }

  try {
    const { version, banner } = await runVersionProbe(location.path)
    const installer = installerVersion()
    deviceLog().info('ffmpeg ready', {
      path: location.path,
      source: location.source,
      version,
      installerVersion: installer ?? '(unknown)'
    })
    return {
      ok: true,
      ...base,
      version,
      banner,
      ...(installer ? { installerVersion: installer } : {})
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `ffmpeg 无法运行（${reason}）：${location.path}`
    deviceLog().error('ffmpeg -version failed', { path: location.path, reason })
    return { ok: false, ...base, error: message }
  }
}

function installerVersion(): string | undefined {
  try {
    const installer = require(FFMPEG_NPM_PACKAGE) as { version?: unknown }
    return typeof installer?.version === 'string' ? installer.version : undefined
  } catch {
    return undefined
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
}

function runVersionProbe(file: string): Promise<{ version: string; banner: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(file, buildVersionArgs(), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killChild(child)
      reject(new Error(`-version 超过 ${VERSION_PROBE_TIMEOUT_MS} ms 没有返回`))
    }, VERSION_PROBE_TIMEOUT_MS)
    // Never let the probe keep the process alive on its own.
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            `-version 退出码 ${String(code)}：${firstLine(stderr) || firstLine(stdout) || '(no output)'}`
          )
        )
        return
      }
      const banner = firstLine(stdout)
      const version = /^ffmpeg version (\S+)/.exec(banner)?.[1]
      if (!version) {
        reject(new Error(`无法解析 ffmpeg 版本信息：${banner.slice(0, 200) || '(empty stdout)'}`))
        return
      }
      resolve({ version, banner })
    })
  })
}

// ---------------------------------------------------------------------------
// Argument builders — pure, so they can be asserted without running anything
// ---------------------------------------------------------------------------

/** The probe that proves the binary runs at all. */
export function buildVersionArgs(): string[] {
  return ['-version']
}

/**
 * Primary path: REMUX (`-c:v copy`), never transcode.
 *
 * The camera already sends H.264; re-encoding it would burn CPU on every frame,
 * add a full encode latency, and lose quality for nothing. FFmpeg's MP4 muxer will
 * not accept a live stream unless it can write a `moov` up front, hence the flags:
 *
 *   frag_keyframe         emit one fragment per keyframe, so a player can start at
 *                         the next keyframe instead of waiting for a file end that
 *                         never comes
 *   empty_moov            write `moov` immediately, with no sample tables
 *   default_base_moof     give each fragment a base offset of 0 so the browser does
 *                         not need the whole prefix to resolve byte offsets
 *
 * Together with fragmented output these are the *only* buffering in the path: one
 * keyframe of latency, plus whatever the RTSP transport buffers. Nothing is written
 * to disk and nothing is queued beyond the pipe.
 */
export function buildRtspRemuxArgs(rtspUrl: string): string[] {
  return [
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-c:v',
    'copy',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]
}

/**
 * Fallback path: RE-ENCODE. Only ever used when `-c:v copy` legitimately cannot
 * work, which in practice means one of:
 *
 *   1. the elementary stream is not H.264 (or MP4 cannot carry the profile it uses),
 *   2. the stream carries no in-band parameter sets (no SPS/PPS in the bitstream and
 *      none signalled out of band), so MP4 has no codec configuration to write, or
 *   3. the muxer rejects the input's framing outright ("Could not write header").
 *
 * It is deliberately NOT the default: it costs a full encode per frame.
 *
 * `-pix_fmt yuv420p` is mandatory rather than cosmetic — Chromium's H.264 decoder
 * does not decode 4:4:4, and libx264 will happily pick a 4:4:4 chroma format for an
 * RGB-ish source, producing a stream that demuxes fine and renders nothing.
 */
export function buildRtspTranscodeArgs(rtspUrl: string): string[] {
  return [
    '-rtsp_transport',
    'tcp',
    '-i',
    rtspUrl,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  ]
}

/**
 * A synthetic source, for proving the wrapper finds, runs and pipes the REAL binary
 * without a camera anywhere in sight (`tests/rtsp-stream.test.ts`).
 *
 * `pipe:1` is the explicit form of the `-` output URL: stdout is a pipe here by
 * construction, and being explicit means the same args work when stdout is not a
 * terminal.
 */
export function buildSyntheticTestArgs(durationSeconds = 1): string[] {
  return [
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=5',
    '-t',
    String(durationSeconds),
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov',
    'pipe:1'
  ]
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export type FfmpegChild = ChildProcessByStdio<null, Readable, Readable>

export interface FfmpegProcess {
  readonly child: FfmpegChild
  /** The MP4 byte stream. The caller owns backpressure. */
  readonly stdout: Readable
  /** Last stderr lines, most recent last — the honest diagnostic. */
  stderrTail: () => string
  /** Resolves when the child is gone. Never rejects. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  /** Idempotent kill. Safe after the child has already exited. */
  kill: () => void
  killed: () => boolean
}

export interface SpawnFfmpegOptions {
  /** Log scope suffix, e.g. the device id. */
  label?: string
  /** Replace the default per-line debug logging (tests use this to collect stderr). */
  onStderrLine?: (line: string) => void
}

/**
 * Live children, so teardown can guarantee no orphan ffmpeg survives the app.
 *
 * `app.on('before-quit')` already stops every session, which kills its own child;
 * this registry is the belt to that pair of braces. An orphaned transcoder holding
 * an RTSP connection open on an industrial network is exactly the kind of thing
 * nobody notices until the camera refuses a new connection.
 */
const liveChildren = new Set<FfmpegChild>()

/** Kill every ffmpeg this process started. Returns how many were signalled. */
export function killAllFfmpeg(): number {
  const children = [...liveChildren]
  for (const child of children) {
    killChild(child)
    liveChildren.delete(child)
  }
  return children.length
}

/** How many ffmpeg children are currently alive (diagnostics and tests). */
export function liveFfmpegCount(): number {
  return liveChildren.size
}

function killChild(child: FfmpegChild): void {
  try {
    // SIGKILL is `TerminateProcess` on Windows, which is what we want: ffmpeg has
    // no graceful shutdown that matters here and a SIGTERM-like request can be
    // ignored while it is blocked writing to a full pipe.
    child.kill('SIGKILL')
  } catch {
    // Already gone, or the process object was never started.
  }
}

/**
 * Spawn ffmpeg with the ONLY stdio arrangement this app uses:
 *
 *   stdin   `ignore`  — ffmpeg must never consume the app's stdin. On Windows a
 *                       child that reads stdin from an inherited console handle can
 *                       block forever, and `-` in an argument list would make it try.
 *   stdout  `pipe`    — the MP4 byte stream, owned by the caller.
 *   stderr  `pipe`    — always wired to the device log, and kept as a bounded tail
 *                       so a crash can be explained instead of guessed at.
 *
 * The returned handle always kills the child: on `stop()`, on a crashed stream, and
 * through `killAllFfmpeg()` at application teardown.
 */
export function spawnFfmpeg(
  args: readonly string[],
  options: SpawnFfmpegOptions = {}
): FfmpegProcess {
  const location = resolveFfmpegPath()
  if (!location.exists) {
    throw new AppError(
      ErrorCodes.NOT_IMPLEMENTED,
      '内置 ffmpeg 不可用（缺少可执行文件），无法转封装相机视频流',
      location.path
    )
  }

  const label = options.label ?? 'ffmpeg'
  const log = deviceLog()
  const child = spawn(location.path, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  liveChildren.add(child)

  let killed = false
  const tail: string[] = []
  const emitLine = options.onStderrLine

  child.stderr.setEncoding('utf8')
  let pending = ''
  child.stderr.on('data', (chunk: string) => {
    pending += chunk
    // ffmpeg writes its progress as `\r`-separated updates on ONE logical line, so
    // splitting on `\n` alone would leave a single ever-growing string in memory.
    const parts = pending.split(/[\r\n]+/)
    pending = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.slice(0, STDERR_LINE_MAX).trim()
      if (line === '') continue
      tail.push(line)
      if (tail.length > STDERR_TAIL_LINES) tail.shift()
      if (emitLine) emitLine(line)
      else log.debug(`[${label}] ${line}`)
    }
  })

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error: Error) => {
      const line = `spawn failed: ${error.message}`
      tail.push(line)
      log.error(`[${label}] ${line}`, { path: location.path })
      resolve({ code: null, signal: null })
    })
    child.once('close', (code, signal) => {
      const rest = pending.trim()
      if (rest !== '') {
        tail.push(rest.slice(0, STDERR_LINE_MAX))
        if (tail.length > STDERR_TAIL_LINES) tail.shift()
        if (emitLine) emitLine(rest)
      }
      pending = ''
      liveChildren.delete(child)
      if (code !== 0 && !killed) {
        // Only interesting when nobody asked it to stop; a deliberate kill is
        // logged by the caller.
        log.warn(`[${label}] ffmpeg exited`, {
          code,
          signal,
          tail: tail.slice(-6).join(' | ')
        })
      }
      resolve({ code, signal: signal ?? null })
    })
  })

  return {
    child,
    stdout: child.stdout,
    stderrTail: () => tail.join('\n'),
    exited,
    kill: () => {
      if (killed) return
      killed = true
      killChild(child)
    },
    killed: () => killed
  }
}
