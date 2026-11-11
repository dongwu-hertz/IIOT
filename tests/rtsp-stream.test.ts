/**
 * Camera live video: the ffmpeg wrapper and the RTSP -> loopback streaming session.
 *
 * WHAT THESE TESTS ARE FOR
 * Everything on this path is invisible when it breaks. A wrong RTSP URL produces a
 * `<video>` that never starts, a missing binary produces the same, and a loopback
 * server with a weak token produces nothing at all until somebody else finds it. So
 * the tests come in two flavours:
 *
 *   PURE   — URL construction, argument lists, token shape, the `rtsp_enabled = 0`
 *            device fact, and the `-c:v copy` fallback rule. Fast, deterministic, no
 *            camera and no ffmpeg.
 *   REAL   — ONE test that runs the bundled binary against a synthetic source
 *            (`testsrc`) and asserts the bytes it pipes start with an MP4 `ftyp`
 *            box. That is the only way to prove the wrapper FINDS, RUNS and PIPES
 *            the actual executable rather than merely naming a path that exists.
 *
 * Everything that spawns a process is killed before the test ends; the suite must
 * never leave an ffmpeg (or a bound loopback port) behind.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import http from 'node:http'
import { PassThrough } from 'node:stream'

import {
  buildRtspRemuxArgs,
  buildRtspTranscodeArgs,
  buildSyntheticTestArgs,
  buildVersionArgs,
  ffmpegBinaryName,
  ffmpegPlatformDir,
  liveFfmpegCount,
  probeFfmpeg,
  resolveFfmpegPath,
  spawnFfmpeg,
  unpackFromAsar,
  type FfmpegChild,
  type FfmpegProcess,
  type SpawnFfmpegOptions
} from '../src/main/services/media/ffmpeg'
import {
  buildLoopbackUrl,
  createSessionToken,
  diagnosticLine,
  insertTranscodeFallback,
  maskRtspUrl,
  planAttempts,
  RtspStreamService,
  shouldFallbackToTranscode,
  streamPathFor,
  type CameraLiveResolver
} from '../src/main/services/media/rtsp-stream'
import { buildRtspUrlCandidates } from '../src/main/services/device/fa371/mappers'
import { AppError, ErrorCodes } from '../src/shared/errors'
import type { Fa371RtspUrlCandidate, Fa371VideoConfig } from '../src/shared/domain/fa371'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CREDENTIAL = { username: 'admin', password: 'Hz@123456' }

/** The real camera's measured answer: `video_port=443`, `video_url="live"`. */
const MEASURED_VIDEO_CONFIG: Fa371VideoConfig = {
  rtspEnabled: true,
  rtspPort: 443,
  rtspPath: 'live'
}

/** The MP4 init segment as ffmpeg writes it: 4-byte box size, then 'ftyp'. */
const FAKE_MP4_HEAD = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d
])

function candidatesFor(video: Fa371VideoConfig, withCredentials = false): Fa371RtspUrlCandidate[] {
  return buildRtspUrlCandidates('192.168.110.235', video, withCredentials ? CREDENTIAL : undefined)
}

/**
 * Read a response to completion.
 *
 * Only ever used against a stream that the fake child ENDS, or against a short
 * failure body — a live stream has no end, and waiting for one would hang the suite.
 */
function httpGet(
  url: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, headers: { connection: 'close' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      )
      response.on('error', reject)
    })
    request.on('error', reject)
  })
}

interface FakeFfmpeg {
  spawn: typeof spawnFfmpeg
  children: FfmpegProcess[]
  outputs: PassThrough[]
  args: string[][]
}

/**
 * A stand-in for the real child, used by the session tests.
 *
 * `makePayload` decides what (if anything) ffmpeg "produces". A PassThrough buffers
 * whatever is written before the session attaches its listener, so a payload can be
 * written at spawn time without racing the consumer. `endAfterPayload` makes the
 * child's stdout end, which ends the HTTP response — without it a live stream never
 * completes and a test reading it would wait forever.
 */
function createFakeFfmpeg(
  makePayload: () => Buffer,
  options: { endAfterPayload?: boolean } = {}
): FakeFfmpeg {
  const children: FfmpegProcess[] = []
  const outputs: PassThrough[] = []
  const args: string[][] = []

  const impl = (argv: readonly string[], _spawnOptions?: SpawnFfmpegOptions): FfmpegProcess => {
    args.push([...argv])
    const stdout = new PassThrough()
    outputs.push(stdout)
    let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve
    })
    let killed = false
    const ff: FfmpegProcess = {
      // Never touched by the session; only the streams are.
      child: {} as unknown as FfmpegChild,
      stdout,
      stderrTail: () => '',
      exited,
      killed: () => killed,
      kill: () => {
        if (killed) return
        killed = true
        stdout.end()
        resolveExit({ code: null, signal: 'SIGKILL' })
      }
    }
    children.push(ff)
    const payload = makePayload()
    if (payload.length > 0) stdout.write(payload)
    if (options.endAfterPayload) stdout.end()
    return ff
  }

  return { spawn: impl as unknown as typeof spawnFfmpeg, children, outputs, args }
}

const probeOk = (async () => ({
  ok: true,
  path: 'C:\\fake\\ffmpeg.exe',
  source: 'node_modules' as const,
  version: 'test',
  banner: 'ffmpeg version test'
})) as unknown as typeof probeFfmpeg

const probeMissing = (async () => ({
  ok: false,
  path: 'C:\\missing\\ffmpeg.exe',
  source: 'packaged-unpacked' as const,
  error: '找不到 ffmpeg 可执行文件：C:\\missing\\ffmpeg.exe'
})) as unknown as typeof probeFfmpeg

function resolverFor(video: Fa371VideoConfig, credential = false): CameraLiveResolver {
  return {
    getDevice: () => ({
      id: 'dev-camera-1',
      host: '192.168.110.235',
      ...(credential ? { credential: CREDENTIAL } : {})
    }),
    getVideoConfig: async () => video
  }
}

/**
 * A resolver for SEVERAL cameras.
 *
 * The multi-camera tests need more than one device on the other side; every device
 * answers with the same video config, which is what a rack of identical cameras does.
 */
function multiResolverFor(deviceIds: readonly string[], video: Fa371VideoConfig): CameraLiveResolver {
  const hosts = new Map(deviceIds.map((id, index) => [id, `192.168.110.${100 + index}`]))
  return {
    getDevice: (deviceId) => ({
      id: deviceId,
      host: hosts.get(deviceId) ?? '192.168.110.235'
    }),
    getVideoConfig: async () => video
  }
}

/** Services created by a test, stopped afterwards so no port or child survives. */
const services: RtspStreamService[] = []
after(() => {
  for (const service of services) service.stop()
  assert.equal(liveFfmpegCount(), 0, 'a test left an ffmpeg child alive')
})

function makeService(
  video: Fa371VideoConfig,
  fake: FakeFfmpeg,
  options: {
    credential?: boolean
    probe?: typeof probeFfmpeg
    firstByteTimeoutMs?: number
    /** 多相机场景：不传就是单相机 `dev-camera-1`。 */
    cameraIds?: readonly string[]
    /** 并发上限：数字（固定）或取值函数（模拟「改设置立刻生效」）。 */
    maxConcurrentStreams?: number | (() => number)
  } = {}
): RtspStreamService {
  const service = new RtspStreamService({
    resolver:
      options.cameraIds && options.cameraIds.length > 0
        ? multiResolverFor(options.cameraIds, video)
        : resolverFor(video, options.credential ?? false),
    spawn: fake.spawn,
    probe: options.probe ?? probeOk,
    firstByteTimeoutMs: options.firstByteTimeoutMs ?? 5_000,
    ...(options.maxConcurrentStreams !== undefined
      ? { maxConcurrentStreams: options.maxConcurrentStreams }
      : {})
  })
  services.push(service)
  return service
}

// ---------------------------------------------------------------------------
// Where the binary is, in dev and in a packaged app
// ---------------------------------------------------------------------------

describe('ffmpeg path resolution', () => {
  it('rewrites an asar-internal path to the unpacked location', () => {
    // A binary cannot be executed from inside an asar archive, so this one
    // transformation is what makes the packaged app work at all.
    assert.equal(
      unpackFromAsar(
        'C:\\app\\resources\\app.asar\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe'
      ),
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe'
    )
    assert.equal(
      unpackFromAsar('/opt/app/resources/app.asar/node_modules/x/ffmpeg'),
      '/opt/app/resources/app.asar.unpacked/node_modules/x/ffmpeg'
    )
  })

  it('leaves a development path alone', () => {
    const dev = 'C:\\proj\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe'
    assert.equal(unpackFromAsar(dev), dev)
  })

  it('uses the node_modules location in development', () => {
    const location = resolveFfmpegPath({ isPackaged: false, appPath: 'C:\\proj' })
    assert.equal(location.source, 'node_modules')
    assert.match(location.path.replace(/\\/g, '/'), /node_modules\/@ffmpeg-installer\//)
  })

  it('prefers the unpacked location when packaged, and never an asar-internal one', () => {
    const resources = 'C:\\app\\resources'
    const location = resolveFfmpegPath({
      isPackaged: true,
      resourcesPath: resources,
      platform: 'win32',
      arch: 'x64'
    })
    assert.equal(location.source, 'packaged-unpacked')
    const expected = `${resources}\\app.asar.unpacked\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe`
    assert.ok(
      location.considered.includes(expected),
      `expected the unpacked candidate among:\n${location.considered.join('\n')}`
    )
    assert.ok(
      !/app\.asar[\\/](?!unpacked)/.test(location.path),
      `chosen path points inside the archive: ${location.path}`
    )
  })

  it('names the platform package the way npm does', () => {
    assert.equal(ffmpegBinaryName('win32'), 'ffmpeg.exe')
    assert.equal(ffmpegBinaryName('linux'), 'ffmpeg')
    assert.equal(ffmpegPlatformDir('win32', 'x64'), 'win32-x64')
  })
})

// ---------------------------------------------------------------------------
// The command lines actually used
// ---------------------------------------------------------------------------

describe('ffmpeg argument builders', () => {
  const url = 'rtsp://192.168.110.235:443/live'

  it('probes the binary with -version', () => {
    assert.deepEqual(buildVersionArgs(), ['-version'])
  })

  it('remuxes rather than transcodes on the primary path', () => {
    assert.deepEqual(buildRtspRemuxArgs(url), [
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-c:v',
      'copy',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    ])
  })

  it('carries the flags that make a live stream playable without a file end', () => {
    const args = buildRtspRemuxArgs(url)
    const movflags = args[args.indexOf('-movflags') + 1] ?? ''
    // empty_moov + frag_keyframe: the moov is written up front and a fragment is
    // emitted per keyframe, which is the whole reason a browser can start playing.
    assert.ok(movflags.includes('frag_keyframe'))
    assert.ok(movflags.includes('empty_moov'))
    assert.ok(movflags.includes('default_base_moof'))
    // Nothing may write the stream to a file.
    assert.equal(args[args.length - 1], 'pipe:1')
  })

  it('re-encodes with ultrafast/zerolatency and a browser-decodable pixel format', () => {
    assert.deepEqual(buildRtspTranscodeArgs(url), [
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
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
    ])
  })

  it('generates the synthetic source used by the real-binary test', () => {
    assert.deepEqual(buildSyntheticTestArgs(2), [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=5',
      '-t',
      '2',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov',
      'pipe:1'
    ])
  })
})

// ---------------------------------------------------------------------------
// RTSP address candidates, attempt planning, fallback rule
// ---------------------------------------------------------------------------

describe('RTSP address and attempt planning', () => {
  it('builds the documented URL form from the video config', () => {
    const candidates = candidatesFor(MEASURED_VIDEO_CONFIG)
    assert.equal(candidates[0]?.id, 'rtsp_without_credentials')
    assert.equal(candidates[0]?.url, 'rtsp://192.168.110.235:443/live')
    // Port 443 is also offered as rtsps (the manual never says whether it is TLS).
    assert.ok(candidates.some((candidate) => candidate.url === 'rtsps://192.168.110.235:443/live'))
  })

  it('adds the credential form only when an account is available', () => {
    const withAccount = candidatesFor(MEASURED_VIDEO_CONFIG, true)
    assert.ok(
      withAccount.some(
        (candidate) => candidate.id === 'rtsp_with_credentials' && candidate.assumeCredentials
      )
    )
    assert.ok(!candidatesFor(MEASURED_VIDEO_CONFIG).some((candidate) => candidate.assumeCredentials))
  })

  it('makes no address at all when the device did not report a port or a path', () => {
    assert.deepEqual(buildRtspUrlCandidates('10.0.0.1', { rtspPath: 'live' }), [])
    assert.deepEqual(buildRtspUrlCandidates('10.0.0.1', { rtspPort: 554 }), [])
    assert.deepEqual(buildRtspUrlCandidates('', MEASURED_VIDEO_CONFIG), [])
  })

  it('plans one attempt per candidate, in order, remux first', () => {
    const attempts = planAttempts(candidatesFor(MEASURED_VIDEO_CONFIG, true))
    assert.deepEqual(
      attempts.map((attempt) => attempt.index),
      [1, 2, 3]
    )
    assert.ok(attempts.every((attempt) => attempt.mode === 'remux'))
    assert.equal(attempts[0]?.candidateId, 'rtsp_without_credentials')
  })

  it('never puts a password in a log-safe attempt label', () => {
    const attempts = planAttempts(candidatesFor(MEASURED_VIDEO_CONFIG, true))
    const withCredential = attempts.find((attempt) => attempt.candidateId === 'rtsp_with_credentials')
    assert.ok(withCredential, 'expected the credential candidate')
    assert.ok(!withCredential.label.includes(CREDENTIAL.password), withCredential.label)
    assert.ok(withCredential.label.includes('admin:***@'), withCredential.label)
    // The URL handed to ffmpeg, by contrast, must still carry it.
    assert.ok(withCredential.url.includes(CREDENTIAL.password))
  })

  it('masks a password but keeps the address readable', () => {
    assert.equal(
      maskRtspUrl('rtsp://admin:Hz@123456@192.168.110.235:443/live'),
      'rtsp://admin:***@192.168.110.235:443/live'
    )
    assert.equal(maskRtspUrl('rtsp://192.168.110.235:443/live'), 'rtsp://192.168.110.235:443/live')
  })

  it('inserts the re-encode fallback for the SAME url, once', () => {
    const attempts = planAttempts(candidatesFor(MEASURED_VIDEO_CONFIG, false))
    const once = insertTranscodeFallback(attempts, 0)
    assert.equal(once.length, attempts.length + 1)
    assert.equal(once[1]?.mode, 'transcode')
    assert.equal(once[1]?.url, attempts[0]?.url)
    // Idempotent: a second call cannot add a second transcode attempt.
    assert.equal(insertTranscodeFallback(once, 1).length, once.length)
  })

  it('falls back to re-encoding only for a copy-compatibility failure', () => {    // Codec/container failures: yes.
    assert.equal(
      shouldFallbackToTranscode('Could not find codec parameters for stream 0', 1, 0),
      true
    )
    assert.equal(shouldFallbackToTranscode('non-existing PPS 0 referenced', 1, 0), true)
    assert.equal(shouldFallbackToTranscode('Could not write header for output file', 1, 0), true)
    // A network problem is not a codec problem.
    assert.equal(shouldFallbackToTranscode('Connection refused', 1, 0), false)
    assert.equal(shouldFallbackToTranscode('Operation timed out', 1, 0), false)
    // Already streaming: whatever happened next, the remux path worked.
    assert.equal(shouldFallbackToTranscode('Could not find codec parameters', 1, 4096), false)
    // A clean exit is the camera closing the stream.
    assert.equal(shouldFallbackToTranscode('Could not find codec parameters', 0, 0), false)
  })
})

// ---------------------------------------------------------------------------
// Diagnostics: what the operator is actually told
// ---------------------------------------------------------------------------

describe('ffmpeg diagnostics', () => {
  const banner = [
    'ffmpeg version N-92722-gf22fcd4483 Copyright (c) 2000-2018 the FFmpeg developers',
    '  configuration: --enable-gpl --enable-version3 --enable-libx264',
    'libavutil      56. 24.101 / 56. 24.101',
    'libpostproc    55.  4.100 / 55.  4.100'
  ].join('\n')

  it('does not mistake the build banner for a failure', () => {
    // ffmpeg prints ~25 lines of configuration on every start. Quoting the last line
    // would tell the user "libpostproc 55.4.100", which is worse than saying nothing.
    assert.equal(diagnosticLine(banner), undefined)
  })

  it('extracts the line that explains the failure', () => {
    assert.equal(
      diagnosticLine(`${banner}\n[tcp @ 0x1] Connection refused`),
      '[tcp @ 0x1] Connection refused'
    )
    assert.equal(
      diagnosticLine('rtsp://x: Invalid data found when processing input\nframe= 0 fps=0'),
      'rtsp://x: Invalid data found when processing input'
    )
  })
})

// ---------------------------------------------------------------------------
// Per-session token and loopback URL
// ---------------------------------------------------------------------------

describe('loopback stream URL', () => {
  it('is loopback-only and carries an unguessable token in the path', () => {
    const token = createSessionToken()
    const url = buildLoopbackUrl(51321, token)
    assert.equal(url, `http://127.0.0.1:51321/${token}/stream.mp4`)
    assert.equal(streamPathFor(token), `/${token}/stream.mp4`)
    // `localhost` is resolved through the hosts file and can be pointed elsewhere.
    assert.ok(!url.includes('localhost'))
  })

  it('produces URL-safe tokens that do not collide', () => {
    const tokens = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const token = createSessionToken()
      assert.match(token, /^[A-Za-z0-9_-]{32}$/)
      tokens.add(token)
    }
    assert.equal(tokens.size, 200)
  })

  it('shortens the token when asked, for tests', () => {
    assert.equal(createSessionToken(8).length, 11)
  })
})

// ---------------------------------------------------------------------------
// The service: device facts and failure states (no camera, no real ffmpeg)
// ---------------------------------------------------------------------------

describe('camera live service states', () => {
  it('reports RTSP as disabled instead of spawning ffmpeg at nothing', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD)
    // The value the real FA371 reports today (docs/FA371-INTEGRATION.md §5.3).
    const service = makeService({ ...MEASURED_VIDEO_CONFIG, rtspEnabled: false }, fake)

    const state = await service.start('dev-camera-1')

    assert.equal(state.status, 'rtsp-disabled')
    assert.equal(fake.children.length, 0, 'ffmpeg must not be started when RTSP is off')
    assert.ok(state.error?.includes('rtsp_enabled=0'))
    // The address is still reported, so the operator can see what WOULD be used.
    assert.equal(state.rtspUrl, 'rtsp://192.168.110.235:443/live')
    // No URL means no <video> source, i.e. no black rectangle to stare at.
    assert.equal(state.url, undefined)
    assert.deepEqual(service.listState('dev-camera-1'), [])
  })

  it('treats an unreported rtsp_enabled as "not enabled" rather than guessing', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD)
    const service = makeService({ rtspPort: 554, rtspPath: 'live' }, fake)
    const state = await service.start('dev-camera-1')
    assert.equal(state.status, 'rtsp-disabled')
    assert.equal(fake.children.length, 0)
  })

  it('reports a missing transcoder as a state, never as a black rectangle', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD)
    const service = makeService(MEASURED_VIDEO_CONFIG, fake, { probe: probeMissing })

    const state = await service.start('dev-camera-1')

    assert.equal(state.status, 'ffmpeg-missing')
    assert.ok(state.error?.includes('C:\\missing\\ffmpeg.exe'))
    assert.equal(fake.children.length, 0)
  })

  it('reports an unusable video config instead of inventing an address', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD)
    // Enabled, but no port and no path: nothing can be assembled from this.
    const service = makeService({ rtspEnabled: true }, fake)

    const state = await service.start('dev-camera-1')

    assert.equal(state.status, 'error')
    assert.ok(state.error?.includes('video_port'))
    assert.equal(fake.children.length, 0)
  })

  it('rejects a start with no device id', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD)
    const service = makeService(MEASURED_VIDEO_CONFIG, fake)
    await assert.rejects(() => service.start('  '), /设备 ID/)
  })
})

describe('camera live loopback server', () => {
  it('serves the MP4 stream on loopback and refuses a wrong token', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake)

    const started = await service.start('dev-camera-1')
    assert.equal(started.status, 'starting')
    const url = started.url
    assert.ok(url, 'start must return the URL the renderer plays')
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/stream\.mp4$/)

    // A wrong token is rejected: the token in the path is the only authorisation
    // there is, so this is the security property of the whole endpoint.
    const origin = new URL(url).origin
    const forbidden = await httpGet(`${origin}/not-the-token/stream.mp4`)
    assert.equal(forbidden.status, 403)
    assert.equal(fake.children.length, 0, 'a rejected request must not start ffmpeg')

    const response = await httpGet(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'video/mp4')
    assert.equal(
      response.headers['cache-control'],
      'no-store, no-cache, must-revalidate, max-age=0'
    )
    assert.equal(response.headers['content-length'], undefined, 'a live stream has no length')
    assert.ok(response.body.length >= FAKE_MP4_HEAD.length)
    assert.equal(response.body.subarray(4, 8).toString('ascii'), 'ftyp')

    // The command line really used is the remux one, not a re-encode.
    assert.deepEqual(fake.args[0], buildRtspRemuxArgs('rtsp://192.168.110.235:443/live'))

    const live = service.listState('dev-camera-1')
    assert.equal(live.length, 1)
    assert.equal(live[0]?.status, 'playing')
    assert.ok((live[0]?.bytesSent ?? 0) > 0)
    assert.equal(live[0]?.rtspUrl, 'rtsp://192.168.110.235:443/live')

    service.stop('dev-camera-1')
    assert.equal(fake.children[0]?.killed(), true, 'stop() must kill the child')
    assert.deepEqual(service.listState('dev-camera-1'), [])
    // The server is closed with the session.
    await assert.rejects(() => httpGet(url))
  })

  it('exposes hasActiveSession so the health check can skip HTTP while the wall streams', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake)

    assert.equal(service.hasActiveSession('dev-camera-1'), false)
    const started = await service.start('dev-camera-1')
    assert.equal(started.status, 'starting')
    assert.equal(service.hasActiveSession('dev-camera-1'), true)

    service.stop('dev-camera-1')
    assert.equal(service.hasActiveSession('dev-camera-1'), false)
  })

  it('falls back to the last known video config when /system/video times out', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    let reads = 0
    const resolver: CameraLiveResolver = {
      getDevice: () => ({ id: 'dev-camera-1', host: '192.168.110.235' }),
      getVideoConfig: async () => {
        reads += 1
        if (reads > 1) throw new AppError(ErrorCodes.TIMEOUT, '请求超时: /system/video')
        return MEASURED_VIDEO_CONFIG
      }
    }
    const service = new RtspStreamService({
      resolver,
      spawn: fake.spawn,
      probe: probeOk,
      firstByteTimeoutMs: 5_000
    })
    services.push(service)

    const first = await service.start('dev-camera-1')
    assert.equal(first.status, 'starting')
    service.stop('dev-camera-1')

    // 第二台/第二次上墙时相机 HTTP 栈不应答：仍应能用上一次读到的地址开流。
    const second = await service.start('dev-camera-1')
    assert.equal(second.status, 'starting')
    assert.equal(second.rtspUrl, 'rtsp://192.168.110.235:443/live')
    assert.equal(service.hasActiveSession('dev-camera-1'), true)
    service.stop('dev-camera-1')
  })

  it('does not hide a device/auth rejection behind the cached video config', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    let reads = 0
    const resolver: CameraLiveResolver = {
      getDevice: () => ({ id: 'dev-camera-1', host: '192.168.110.235' }),
      getVideoConfig: async () => {
        reads += 1
        if (reads > 1) throw new AppError(ErrorCodes.AUTH_FAILED, '设备拒绝认证')
        return MEASURED_VIDEO_CONFIG
      }
    }
    const service = new RtspStreamService({ resolver, spawn: fake.spawn, probe: probeOk })
    services.push(service)

    const first = await service.start('dev-camera-1')
    assert.equal(first.status, 'starting')
    service.stop('dev-camera-1')

    // 认证/业务错误是设备明确给的新事实，不能拿旧配置盖过去。
    await assert.rejects(() => service.start('dev-camera-1'), (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'AUTH_FAILED')
      return true
    })
  })

  it('keeps one session per camera', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake)

    const first = await service.start('dev-camera-1')
    const second = await service.start('dev-camera-1')

    assert.notEqual(first.url, second.url, 'a restart is a new session with a new token')
    assert.equal(service.listState().length, 1)
    assert.equal(fake.children.length, 0, 'no child exists until the renderer connects')

    // Connecting to the first session's URL must fail: that server is gone.
    const firstUrl = first.url
    assert.ok(firstUrl)
    await assert.rejects(() => httpGet(firstUrl))

    service.stop()
    assert.deepEqual(service.listState(), [])
  })

  /**
   * 多路直播：**不同的**相机可以同时各自一路。
   *
   * 这是本特性的核心断言 —— 会话表按设备 id 索引，每一路有自己的回环地址与令牌，
   * 停掉一路不会碰到另一路。与之相对的是「同一台相机两路」：那一路上面的
   * 「keeps one session per camera」已经钉住了（`start` 是替换而不是新增）。
   */
  it('streams several DIFFERENT cameras at once, each with its own endpoint', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake)
    const ids = ['dev-camera-1', 'dev-camera-2', 'dev-camera-3']

    const started = []
    for (const id of ids) started.push(await service.start(id))

    assert.equal(service.listState().length, 3)
    assert.equal(new Set(started.map((state) => state.url)).size, 3, 'three distinct endpoints')
    for (const state of started) {
      assert.equal(state.status, 'starting')
      assert.match(state.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/stream\.mp4$/)
    }

    // 三路各自可拉，互不影响。
    for (const state of started) {
      const response = await httpGet(state.url ?? '')
      assert.equal(response.status, 200)
      assert.equal(response.body.subarray(4, 8).toString('ascii'), 'ftyp')
    }

    // 停掉一路：另外两路照旧。
    service.stop('dev-camera-2')
    assert.deepEqual(
      service.listState().map((state) => state.deviceId).sort(),
      ['dev-camera-1', 'dev-camera-3']
    )
    const survivor = service.listState('dev-camera-1')[0]
    assert.equal(survivor?.status, 'playing')

    service.stop()
    assert.deepEqual(service.listState(), [])
  })

  /**
   * 并发上限：超出预算的那一路得到 `limit-exceeded`，而且**不新建会话**。
   *
   * 上限的意义是把「一路 ffmpeg + 一个回环服务 + 一份缓冲」的本地资源占用限制在
   * 一个明确的数字内；设备侧的 `rtsp_client_limit`（实测 10）比本机宽裕，所以
   * 绑定约束在这里。返回状态而不是抛异常，是因为界面要把「先停掉别的画面格」
   * 这句话写在屏幕上。
   */
  it('refuses a start beyond the concurrency budget with an honest state', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake, {
      cameraIds: ['dev-camera-1', 'dev-camera-2', 'dev-camera-3'],
      maxConcurrentStreams: 2
    })

    assert.deepEqual(service.limits(), { max: 2, active: 0 })

    const first = await service.start('dev-camera-1')
    const second = await service.start('dev-camera-2')
    assert.equal(first.status, 'starting')
    assert.equal(second.status, 'starting')
    assert.deepEqual(service.limits(), { max: 2, active: 2 })

    const refused = await service.start('dev-camera-3')
    assert.equal(refused.status, 'limit-exceeded')
    assert.equal(refused.url, undefined, 'a refused stream must not hand out a loopback URL')
    assert.match(refused.error ?? '', /2/)
    // 关键：被拒绝的那一路没有占据第三格会话。
    assert.equal(service.listState().length, 2)
    assert.deepEqual(service.limits(), { max: 2, active: 2 })

    // 停掉一路之后，同一个设备可以真的开始（上限是「现在几路」而不是终身配额）。
    service.stop('dev-camera-1')
    assert.deepEqual(service.limits(), { max: 2, active: 1 })
    const retried = await service.start('dev-camera-3')
    assert.equal(retried.status, 'starting')
    assert.ok(retried.url)

    service.stop()
  })

  /**
   * 上限是**每次 start 重新读**的：设置改完立刻生效，不需要重建服务。
   */
  it('reads the concurrency budget on every start, so a settings change takes effect at once', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    let cap = 1
    const service = makeService(MEASURED_VIDEO_CONFIG, fake, {
      cameraIds: ['dev-camera-1', 'dev-camera-2'],
      maxConcurrentStreams: () => cap
    })

    await service.start('dev-camera-1')
    const refused = await service.start('dev-camera-2')
    assert.equal(refused.status, 'limit-exceeded')

    // 操作员把上限调到 2：同一个服务，下一次 start 就能过。
    cap = 2
    assert.deepEqual(service.limits(), { max: 2, active: 1 })
    const allowed = await service.start('dev-camera-2')
    assert.equal(allowed.status, 'starting')

    service.stop()
  })

  /**
   * 替换同一台相机的一路不算「新增一路」：上限是 1 时也必须能重启它。
   */
  it('replacing the same camera never counts against the budget', async () => {
    const fake = createFakeFfmpeg(() => FAKE_MP4_HEAD, { endAfterPayload: true })
    const service = makeService(MEASURED_VIDEO_CONFIG, fake, { maxConcurrentStreams: 1 })

    const first = await service.start('dev-camera-1')
    assert.equal(first.status, 'starting')
    const second = await service.start('dev-camera-1')
    assert.equal(second.status, 'starting', 'a restart of the SAME camera is a replacement')
    assert.notEqual(first.url, second.url)
    assert.deepEqual(service.limits(), { max: 1, active: 1 })

    service.stop()
  })

  it('walks every RTSP candidate and answers 502 when none produces a frame', async () => {
    // Nothing is ever produced, so each candidate fails on the first-byte timeout.
    const fake = createFakeFfmpeg(() => Buffer.alloc(0))
    const service = makeService(MEASURED_VIDEO_CONFIG, fake, {
      credential: true,
      firstByteTimeoutMs: 20
    })

    const started = await service.start('dev-camera-1')
    assert.ok(started.url)
    const response = await httpGet(started.url)

    assert.equal(response.status, 502, 'a stream that never starts must not answer 200')
    assert.ok(response.body.toString('utf8').includes('候选全部失败'))
    // The state must carry the reason, not just the count: the first-byte budget is
    // the honest explanation here (no bytes at all from any candidate).
    assert.ok(response.body.toString('utf8').includes('最后诊断'))
    // 3 candidates (plain / credentials / rtsps) — each was actually tried.
    assert.equal(fake.children.length, 3)
    assert.ok(fake.children.every((child) => child.killed()))
  })

  it('escalates to a re-encode, logged, when -c:v copy cannot carry the stream', async () => {
    let attempt = 0
    const output = new PassThrough()
    const fake: FakeFfmpeg = {
      args: [],
      children: [],
      outputs: [],
      spawn: ((argv: readonly string[]) => {
        attempt += 1
        fake.args.push([...argv])
        const isRemux = argv.includes('copy')
        let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void =
          () => {}
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            resolveExit = resolve
          }
        )
        const ff: FfmpegProcess = {
          child: {} as unknown as FfmpegChild,
          stdout: isRemux ? new PassThrough() : output,
          stderrTail: () =>
            isRemux ? 'Could not find codec parameters for stream 0 (Video: none)' : '',
          exited,
          killed: () => false,
          kill: () => resolveExit({ code: null, signal: 'SIGKILL' })
        }
        fake.children.push(ff)
        if (isRemux) {
          // A remux that rejects the stream: exits without a single byte.
          setImmediate(() => resolveExit({ code: 1, signal: null }))
        } else {
          output.write(FAKE_MP4_HEAD)
          output.end()
        }
        return ff
      }) as unknown as typeof spawnFfmpeg
    }

    const service = makeService(MEASURED_VIDEO_CONFIG, fake, { firstByteTimeoutMs: 5_000 })
    const started = await service.start('dev-camera-1')
    assert.ok(started.url)
    const response = await httpGet(started.url)

    assert.equal(response.status, 200)
    assert.equal(response.body.subarray(4, 8).toString('ascii'), 'ftyp')
    assert.equal(attempt, 2, 'exactly one fallback attempt')
    assert.ok(fake.args[0]?.includes('copy'))
    assert.ok(fake.args[1]?.includes('libx264'))
    service.stop()
  })
})

// ---------------------------------------------------------------------------
// The real binary
// ---------------------------------------------------------------------------

describe('bundled ffmpeg binary', () => {
  it('finds and runs the bundled binary', async () => {
    const probe = await probeFfmpeg()
    assert.equal(probe.ok, true, probe.error ?? 'ffmpeg probe failed')
    assert.match(probe.banner ?? '', /^ffmpeg version /)
    assert.ok(probe.path.length > 0)
  })

  it('pipes a real fragmented MP4 for a synthetic source', async () => {
    // NO CAMERA IS INVOLVED. `testsrc` is generated inside ffmpeg, and the assertion
    // is on the actual bytes: an MP4 stream starts with a `ftyp` box at offset 4.
    // This is the test that proves the wrapper finds, runs and pipes the real binary.
    const ff = spawnFfmpeg(buildSyntheticTestArgs(), { onStderrLine: () => {} })
    try {
      const chunks: Buffer[] = []
      ff.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      const result = await ff.exited
      const bytes = Buffer.concat(chunks)

      assert.equal(result.code, 0, `ffmpeg failed: ${ff.stderrTail()}`)
      assert.ok(bytes.length > 100, `expected a stream, got ${bytes.length} bytes`)
      assert.equal(bytes.subarray(4, 8).toString('ascii'), 'ftyp')
      // `empty_moov` means the movie header is present in the FIRST fragment, which
      // is what lets a <video> element start without an end-of-file.
      assert.ok(bytes.includes(Buffer.from('moov')), 'expected an empty moov in the first fragment')
    } finally {
      ff.kill()
      await ff.exited
    }
    assert.equal(liveFfmpegCount(), 0, 'the real-binary test must not leave a child behind')
  })
})
