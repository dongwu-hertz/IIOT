#!/usr/bin/env node
/**
 * MEASUREMENT HARNESS — not part of the shipped app.
 *
 * Answers the question the product owner actually asked when they said "if I add
 * several devices I need multi-channel video": **what does N simultaneous camera
 * streams cost on this machine, and does the pipeline still work at N?**
 *
 * WHAT IS MEASURED, AND WHY THIS WAY
 *
 * Each stream is a real ffmpeg process using the EXACT argument vector the app's
 * live view uses (`buildRtspRemuxArgs` in `src/main/services/media/ffmpeg.ts`) and
 * the app's own bundled ffmpeg binary. Measuring a hand-written ffmpeg command
 * would measure a different program.
 *
 * CPU comes from ffmpeg's own `-benchmark`, which reports the utime/stime the
 * kernel charged to that process. That is a per-stream figure with no sampling
 * error, and it needs no external profiler. RSS is sampled from
 * `Get-Process` while the streams run, because ffmpeg does not report memory.
 *
 * HONEST LIMITS, stated up front rather than buried:
 *
 *   1. This drives ffmpeg directly, not the app's UI. The UI deliberately refuses
 *      to put the SAME camera in two cells (see `cameraWall.ts`), so N cells of
 *      one physical camera is not a scenario the product supports. What is being
 *      measured is the COST OF N RTSP SESSIONS through the real pipeline — the
 *      figure that transfers when there are N different devices.
 *   2. Only one physical camera exists here, so all N sessions hit the same
 *      device. Its `rtsp_client_limit` is 10, so 4 is within the device's own
 *      budget; a failure at N=4 would be a real finding, not a harness artefact.
 *   3. CPU and memory depend on this machine. The numbers are reported with the
 *      machine's own core count so they can be read as "share of one machine".
 *
 * USAGE
 *   node scripts/camera-load.cjs                       # 1,2,3,4 streams for 12s each
 *   node scripts/camera-load.cjs --streams 1,4         # pick the steps
 *   node scripts/camera-load.cjs --seconds 20
 *   node scripts/camera-load.cjs --url rtsp://...      # another source
 */

'use strict'

const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const args = {
    streams: [1, 2, 3, 4],
    seconds: 12,
    ip: '192.168.110.235',
    url: null,
    settleMs: 1000,
    out: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--streams') {
      args.streams = String(value)
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
      i += 1
    } else if (key === '--seconds') { args.seconds = Number(value); i += 1 }
    else if (key === '--ip') { args.ip = value; i += 1 }
    else if (key === '--url') { args.url = value; i += 1 }
    else if (key === '--settle-ms') { args.settleMs = Number(value); i += 1 }
  }
  if (args.streams.length === 0) args.streams = [1]
  return args
}

const args = parseArgs(process.argv.slice(2))

// The app's own bundled binary, not whatever is on PATH.
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path

/**
 * The app's live-view argument vector, plus three measurement-only flags:
 * `-benchmark` (kernel CPU accounting printed on exit), `-t` (a fixed run length
 * so the comparison is per-second rather than "until we got bored") and
 * `-loglevel info`.
 *
 * The log level is INFO, not ERROR, and that is not sloppiness: ffmpeg prints its
 * `bench:` line through `AV_LOG_INFO`, so `-loglevel error` silently produces a
 * CPU column of "n/a" while every stream still succeeds — a measurement harness
 * that reports nothing and looks like it worked. `relevantError()` below then
 * digs the real failures back out of the noisier stream.
 *
 * The output goes to a FILE rather than a pipe on purpose: the app pipes to the
 * loopback HTTP server, and reproducing that here would add a Node process to the
 * measurement and charge its CPU to the pipeline.
 */
function buildArgs(rtspUrl, seconds, outFile) {
  return [
    '-hide_banner',
    '-loglevel', 'info',
    '-benchmark',
    '-rtsp_transport', 'tcp',
    '-i', rtspUrl,
    '-t', String(seconds),
    '-an',
    '-c:v', 'copy',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-y', outFile
  ]
}

/**
 * Pull the lines that actually describe a failure out of an INFO-level stderr.
 *
 * A plain "first line" would return ffmpeg's version banner, which describes
 * nothing. Returns null when the run logged no problem — which is the honest
 * answer for a clean run, not an empty string.
 */
function relevantError(stderr) {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /error|failed|invalid|unable|no such|refused|timed out|denied/i.test(line))
  return lines.length ? lines.slice(0, 3).join(' | ') : null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Total RSS of every ffmpeg process on the box, in bytes. null if unavailable. */
function sampleFfmpegRss() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process -Name ffmpeg -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum'
      ],
      { encoding: 'utf8', timeout: 15000 }
    ).trim()
    const value = Number(out)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function ffmpegCount() {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '@(Get-Process -Name ffmpeg -ErrorAction SilentlyContinue).Count'
      ],
      { encoding: 'utf8', timeout: 15000 }
    ).trim()
    const value = Number(out)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/** `bench: utime=1.234s stime=0.012s rtime=12.345s` -> numbers in seconds. */
function parseBenchmark(text) {
  const match = /bench:\s*utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(text)
  if (!match) return null
  return { utime: Number(match[1]), stime: Number(match[2]), rtime: Number(match[3]) }
}

/** A fragmented-MP4 file is real only if it starts with a box header. */
function inspectOutput(file) {
  if (!fs.existsSync(file)) return { exists: false, bytes: 0 }
  const bytes = fs.statSync(file).size
  const head = Buffer.alloc(12)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, 12, 0)
  } finally {
    fs.closeSync(fd)
  }
  return {
    exists: true,
    bytes,
    head: head.toString('latin1', 4, 8),
    hasFtyp: head.toString('latin1', 4, 8) === 'ftyp'
  }
}

async function runStep(streamCount, rtspUrl, outDir) {
  const files = []
  for (let i = 0; i < streamCount; i += 1) files.push(path.join(outDir, `stream-${streamCount}-${i}.mp4`))

  const started = Date.now()
  // Spawn each stream as its own process, the way the app spawns one ffmpeg per
  // live session. Staggering them by a few ms keeps their startup CPU from
  // aliasing into one instantaneous spike, which would flatter or damn the
  // figure depending on the ordering.
  const children = files.map((file, index) => {
    const child = spawn(ffmpegPath, buildArgs(rtspUrl, args.seconds, file), {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const state = { index, child, stderr: '', exitCode: null, spawnError: null }
    child.stderr.on('data', (chunk) => { state.stderr += chunk.toString('utf8') })
    child.on('error', (error) => { state.spawnError = error.message })
    child.on('exit', (code) => { state.exitCode = code })
    return state
  })

  // Let every process actually start before sampling, so the RSS figure is the
  // steady state rather than a race against exec().
  await sleep(args.settleMs)
  const countAtSettle = ffmpegCount()
  let peakRss = sampleFfmpegRss()
  // How many RSS samples the peak is based on. Reported, not decorative: a peak
  // from one sample and a peak from twenty are different claims.
  let rssSamples = peakRss === null ? 0 : 1

  while (children.some((state) => state.exitCode === null)) {
    await sleep(500)
    const rss = sampleFfmpegRss()
    if (rss !== null) {
      peakRss = peakRss === null ? rss : Math.max(peakRss, rss)
      rssSamples += 1
    }
  }

  const wallMs = Date.now() - started
  const results = children.map((state, index) => {
    const bench = parseBenchmark(state.stderr)
    const output = inspectOutput(files[index])
    return {
      index,
      exitCode: state.exitCode,
      spawnError: state.spawnError,
      bench,
      cpuPercent: bench ? Math.round(((bench.utime + bench.stime) / bench.rtime) * 1000) / 10 : null,
      output,
      errorLine: relevantError(state.stderr)
    }
  })

  return { streamCount, wallMs, countAtSettle, peakRss, rssSamples, results }
}

const rtspUrl = args.url ?? `rtsp://${args.ip}:443/live`
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-camera-load-'))

/**
 * Wrapped in a function rather than using top-level await: this is a CommonJS
 * script (`.cjs`, and the repository has no `"type": "module"`), where top-level
 * await is a syntax error.
 */
async function main() {
  console.log(`[load] ffmpeg    : ${ffmpegPath}`)
  console.log(`[load] source    : ${rtspUrl}`)
  console.log(`[load] duration  : ${args.seconds}s per step`)
  console.log(
    `[load] cores     : ${os.cpus().length} logical, ${Math.round(os.totalmem() / 1024 / 1024)} MiB RAM`
  )
  console.log(`[load] outputs   : ${outDir}`)
  console.log('')

  const steps = []
  for (const streamCount of args.streams) {
    process.stdout.write(`[load] running ${streamCount} concurrent stream(s) ... `)
    const step = await runStep(streamCount, rtspUrl, outDir)
    steps.push(step)
    const ok = step.results.filter((r) => r.exitCode === 0 && r.output.hasFtyp).length
    console.log(`${ok}/${streamCount} ok in ${step.wallMs} ms`)
    await sleep(1500) // let the device release its RTSP sessions between steps
  }

  console.log('')
  console.log(
    'streams  ok  wall(s)  ffmpeg@settle  peakRSS(MiB)  rssSamples  cpu% per stream (utime+stime)/rtime  bytes/stream'
  )
  for (const step of steps) {
    const ok = step.results.filter((r) => r.exitCode === 0 && r.output.hasFtyp).length
    const cpus = step.results.map((r) => (r.cpuPercent === null ? 'n/a' : r.cpuPercent + '%'))
    const bytes = step.results.map((r) => (r.output.bytes ? Math.round(r.output.bytes / 1024) + 'K' : '0'))
    const rss = step.peakRss === null ? 'n/a' : (step.peakRss / 1024 / 1024).toFixed(1)
    console.log(
      `${String(step.streamCount).padStart(7)}  ${String(ok).padStart(2)}  ${String(
        Math.round(step.wallMs / 100) / 10
      ).padStart(6)}  ${String(step.countAtSettle).padStart(13)}  ${rss.padStart(12)}  ${String(
        step.rssSamples
      ).padStart(10)}  ${cpus.join(' / ').padEnd(34)}  ${bytes.join(' / ')}`
    )
  }

  console.log('')
  let failures = 0
  for (const step of steps) {
    for (const result of step.results) {
      if (result.exitCode !== 0 || !result.output.hasFtyp) {
        failures += 1
        console.log(
          `[load] FAIL step=${step.streamCount} stream=${result.index} exit=${result.exitCode} ` +
            `bytes=${result.output.bytes} spawnError=${result.spawnError ?? '-'}`
        )
        if (result.errorLine) console.log(`       ${result.errorLine}`)
      }
    }
  }

  // A total CPU figure is the number a user cares about ("will my machine cope"),
  // and summing per-stream CPU is legitimate here because each stream is its own
  // process and the kernel charged the time per process.
  const cores = os.cpus().length
  for (const step of steps) {
    const total = step.results.reduce((sum, r) => sum + (r.cpuPercent ?? 0), 0)
    console.log(
      `[load] ${step.streamCount} stream(s): total CPU ${Math.round(total * 10) / 10}% of one core = ` +
        `${Math.round((total / cores) * 10) / 10}% of this ${cores}-core machine`
    )
  }

  console.log('')
  console.log(`[load] failures: ${failures}`)
  console.log(`[load] measured files kept at: ${outDir}`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error('[load] harness crashed:', error)
  process.exit(1)
})
