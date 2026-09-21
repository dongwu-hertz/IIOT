#!/usr/bin/env node
/**
 * Headless startup smoke test.
 *
 * A green build proves the code COMPILES. It does not prove the app can boot:
 * database creation, migrations, logging, IPC registration, preload bridging,
 * renderer load and Vue mount can each fail at runtime while the bundle builds
 * perfectly. A blank white window and a healthy main process look identical
 * from the outside, so this checks both halves.
 *
 * It boots the REAL built app with a temporary user-data directory, watches for
 * main-process and renderer failures, and exits non-zero on any startup
 * problem. It is the cheapest possible guard against "it built, therefore it
 * works".
 *
 * BUILD PRECONDITION
 * The device-status push verification needs a self-check probe compiled into
 * the renderer, which only exists when the build ran with `VITE_SMOKE_PROBE=1`.
 * Running this against a normal build would silently downgrade that check to
 * "inconclusive" — a trap for whoever runs the script directly. So the script
 * DETECTS a probe-less build and says plainly how to get a full run, rather
 * than quietly reporting less than it appears to.
 *
 * USAGE
 *   npm run smoke                    # recommended: builds with the probe, then runs this
 *   node scripts/smoke-start.cjs     # against an existing build (warns if probe-less)
 */

'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..')
const electronBinary = require('electron')

if (typeof electronBinary !== 'string') {
  console.error('This script must run under plain Node (it spawns Electron itself).')
  process.exit(1)
}

const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  console.error(`Built entry not found: ${mainEntry}\nRun "npm run build" first.`)
  process.exit(1)
}

/**
 * Detect whether the renderer bundle was built with the self-check probe.
 *
 * Reported up front rather than discovered at the end, so the scope of what
 * this run can actually verify is stated before it runs.
 */
function probeIsCompiledIn() {
  const rendererDir = path.join(projectRoot, 'out', 'renderer')
  if (!fs.existsSync(rendererDir)) return false
  const walk = (dir, depth = 0) => {
    if (depth > 4) return false
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (walk(full, depth + 1)) return true
      } else if (entry.name.endsWith('.js')) {
        try {
          if (fs.readFileSync(full, 'utf8').includes('__hertzinnoSelfCheck')) return true
        } catch {
          // Unreadable file: treat as no probe.
        }
      }
    }
    return false
  }
  return walk(rendererDir)
}

const probeAvailable = probeIsCompiledIn()
if (!probeAvailable) {
  process.stdout.write(
    '\n⚠ This build has no status-push probe, so that ONE check will be skipped.\n' +
      '  For a full verification run:  npm run smoke\n\n'
  )
}

// Isolate all app state so the smoke test never touches the developer's real
// devices, settings or database.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertzinno-smoke-'))

/**
 * Crash diagnostics.
 *
 * A failure that happens OUTSIDE `evaluate()` (a spawn error, an unexpected
 * throw during boot) prints a stack trace and exits non-zero without ever
 * running the report, which makes the cause invisible to a wrapper that only
 * sees the exit code. These handlers mirror the error into the same report file
 * so the reason survives regardless of where the failure occurred.
 */
function writeCrashReport(label, detail) {
  const target = process.env.HERTZINNO_SMOKE_REPORT
  if (!target) return
  try {
    fs.writeFileSync(target, `✗ ${label}\n\n${detail}\n`)
  } catch {
    // Diagnostics must never be the thing that fails.
  }
}

process.on('uncaughtException', (error) => {
  writeCrashReport('uncaughtException', error && error.stack ? error.stack : String(error))
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  writeCrashReport('unhandledRejection', reason && reason.stack ? reason.stack : String(reason))
  process.exit(1)
})

// The app resolves the log directory as `<storageRoot>/logs`. On Windows the
// default storage root is D:\HertzinnoData, so it is deliberately pinned inside
// the throwaway profile (see HERTZINNO_STORAGE_ROOT below) and BOTH the spawn
// env and the assertions must read the same value.
const storageRootDir = path.join(userDataDir, 'HertzinnoData')

const args = [
  mainEntry,
  `--user-data-dir=${userDataDir}`,
  // Force a software renderer: CI machines and headless shells have no GPU,
  // and a GPU crash would be indistinguishable from an application crash.
  '--disable-gpu',
  '--no-sandbox',
  '--in-process-gpu'
]

const child = spawn(electronBinary, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    // Never let the smoke test inherit a dev-server URL: it must load the
    // built renderer from disk, which is what ships.
    ELECTRON_RENDERER_URL: '',
    // Ask the main process to report renderer health on stdout.
    HERTZINNO_SMOKE_TEST: '1',
    // Pin the storage root inside the throwaway profile.
    //
    // The log directory lives UNDER the storage root, and the storage root is
    // NOT derived from userData on Windows — it defaults to D:\HertzinnoData
    // (`defaultStorageRoot`). Without this the "logger wrote" assertion looks in
    // the wrong tree, fails, and reports a logger that is working perfectly as
    // broken. On macOS the two paths happen to coincide, which is why the check
    // could pass there and only break on Windows.
    HERTZINNO_STORAGE_ROOT: storageRootDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
let finished = false

/** Human-readable problems found; any entry makes the run fail. */
const problems = []

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
})
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

/**
 * Signals that mean "the app came up".
 * The main process logs a startup line via electron-log, which writes to the
 * storage root under the temporary user-data directory.
 */
function findStartupEvidence(problems) {
  const combined = `${stdout}\n${stderr}`
  const evidence = []

  if (combined.includes('Starting HAIS')) {
    evidence.push('main process logged startup')
  }
  if (combined.includes('IPC handlers registered')) {
    evidence.push('IPC handlers registered')
  }

  // The database is the first thing created; its presence proves migrations ran.
  const dbFile = path.join(userDataDir, 'hertzinno-manager.db')
  if (fs.existsSync(dbFile)) {
    evidence.push(`database created (${fs.statSync(dbFile).size} bytes)`)
  }

  // Log files prove the storage layout was created AND that the logger can
  // actually write — a path mistake here would ship as "no logs" in production.
  //
  // The pattern is specific on purpose: SQLite's WAL sidecar is also named
  // `<n>.log`, and counting it would make this check pass while the real logger
  // wrote nothing at all.
  const logFiles = findFiles(
    storageRootDir,
    (name) => /^(app|device|storage)-\d{4}-\d{2}-\d{2}\.log$/.test(name)
  )
  if (logFiles.length > 0) {
    evidence.push(`logger wrote: ${logFiles.map((f) => path.basename(f)).join(', ')}`)
  }

  // SQLite in WAL mode creates a -wal sidecar; its presence confirms the
  // pragmas were applied rather than silently skipped.
  if (fs.existsSync(`${dbFile}-wal`)) {
    evidence.push('WAL mode active')
  }

  // ---- Renderer health, reported by the main process ----------------------
  // The main process can be perfectly healthy while the window is blank, so
  // these signals are what turn "it booted" into "it actually renders".
  if (combined.includes('[smoke] renderer-loaded')) {
    evidence.push('renderer finished loading')
  }

  const bridgeMatch = /\[smoke\] bridge (\{.*\})/.exec(combined)
  if (bridgeMatch) {
    try {
      const bridge = JSON.parse(bridgeMatch[1])
      if (bridge.api && bridge.events && bridge.mounted) {
        evidence.push('preload bridge exposed + Vue shell mounted')
      } else {
        problems.push(
          `renderer bridge incomplete (api=${bridge.api} events=${bridge.events} mounted=${bridge.mounted})`
        )
      }
    } catch {
      problems.push(`could not parse bridge report: ${bridgeMatch[1]}`)
    }
  } else if (combined.includes('IPC handlers registered')) {
    // The bridge probe is only expected once the window has loaded; its absence
    // after a successful boot means the renderer never got that far.
    problems.push('renderer never reported that it loaded')
  }

  for (const pattern of RENDERER_FAILURE_PATTERNS) {
    const match = pattern.exec(combined)
    if (match) problems.push(`renderer failure: ${match[0]}`)
  }

  const detail = (marker) =>
    new RegExp(`\\[smoke\\] ${marker} (.+)`).exec(combined)?.[1] ?? ''
  if (combined.includes('[smoke] renderer-failed')) {
    problems.push(`renderer failed to load: ${detail('renderer-failed')}`)
  }
  if (combined.includes('[smoke] preload-error')) {
    problems.push(`preload error: ${detail('preload-error')}`)
  }
  if (combined.includes('[smoke] renderer-gone')) {
    problems.push(`renderer process died: ${detail('renderer-gone')}`)
  }
  const consoleErrors = combined.match(/\[smoke\] renderer-console-error/g)
  if (consoleErrors && consoleErrors.length > 0) {
    problems.push(`${consoleErrors.length} renderer console error(s)`)
  }

  // ---- Release metadata ----------------------------------------------------
  // Read straight through the real IPC handler, so a broken handler or a missing
  // bundler define is caught here rather than discovered on the About panel.
  const releaseMatch = /\[smoke\] bridge \{[\s\S]*?"release":(\{[^}]*\})/.exec(combined)
  if (releaseMatch) {
    try {
      const release = JSON.parse(releaseMatch[1])
      // The build's own version, read from package.json, so this cannot pass by
      // comparing against a value the app itself produced.
      const expectedVersion = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
      ).version

      const missing = ['version', 'homepage', 'supportEmail'].filter((key) => !release[key])
      if (missing.length > 0) {
        problems.push(`release metadata incomplete: missing ${missing.join(', ')}`)
      } else if (release.version !== expectedVersion) {
        // Guards the exact bug this check was written after: `app.getVersion()`
        // returns Electron's version when the app is not packaged.
        problems.push(
          `version mismatch: app reports ${release.version}, package.json says ${expectedVersion}`
        )
      } else {
        evidence.push(
          `release ${release.version} (${release.releaseDate || 'no date'}) · ${release.homepage}`
        )
      }
    } catch {
      problems.push(`could not parse release metadata: ${releaseMatch[1]}`)
    }
  }

  // ---- Branding ------------------------------------------------------------
  // A missing logo is invisible to every other gate: the page renders, the types
  // check and the build succeeds. Only the DOM knows.
  const logoMatch = /\[smoke\] bridge \{.*?"logoLoaded":(true|false)/.exec(combined)
  if (logoMatch) {
    if (logoMatch[1] === 'true') evidence.push('brand logo rendered')
    else problems.push('brand logo did not load (naturalWidth === 0)')
  }

  // ---- Device-status push chain (spec 13.2) -------------------------------
  if (combined.includes('[smoke] status-push ok')) {
    evidence.push('device-status push channel verified')
  } else if (combined.includes('[smoke] status-push FAILED')) {
    problems.push(
      `device-status push broken: ${/\[smoke\] status-push FAILED \((.+)\)/.exec(combined)?.[1] ?? ''}`
    )
  } else if (combined.includes('[smoke] status-push inconclusive')) {
    // Only acceptable when the probe was never compiled in. If the probe IS
    // present and the check still could not run, that is a real defect.
    const reason = /\[smoke\] status-push inconclusive \((.+)\)/.exec(combined)?.[1] ?? ''
    if (probeAvailable) {
      problems.push(`device-status push check could not run: ${reason}`)
    } else {
      evidence.push('device-status push SKIPPED (probe not compiled in)')
    }
  }

  return evidence
}

/** Recursively collect file paths under `dir` whose basename matches `predicate`. */
function findFiles(dir, predicate, depth = 0, into = []) {
  if (depth > 6) return into
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return into
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(full, predicate, depth + 1, into)
    else if (predicate(entry.name)) into.push(full)
  }
  return into
}

/** Runtime failures we treat as fatal, matched against stderr. */
const FATAL_PATTERNS = [
  /Uncaught Exception/i,
  /A JavaScript error occurred in the main process/i,
  /Error: Cannot find module/i,
  /Startup failed/i,
  /Failed to load/i
]

/**
 * Renderer failures.
 *
 * The main process can boot perfectly while the UI is a blank white window —
 * a renderer exception, a missing preload bridge or a Vue mount error would all
 * leave the smoke test green. These patterns close that blind spot, because
 * "the app started" is not the same claim as "the app works".
 */
const RENDERER_FAILURE_PATTERNS = [
  /Unable to load preload script/i,
  /Error in mounted hook/i,
  /\[Vue warn\]/i,
  /Uncaught TypeError/i,
  /Uncaught ReferenceError/i,
  /Failed to fetch dynamically imported module/i
]

function evaluate() {
  if (finished) return
  finished = true

  clearTimeout(deadline)
  child.kill('SIGTERM')
  // Give Electron a moment to exit cleanly before force-killing.
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL')
  }, 2000).unref()

  const evidence = findStartupEvidence(problems)
  const fatal = FATAL_PATTERNS.filter((pattern) => pattern.test(stderr) || pattern.test(stdout))

  // The report normally goes to stdout. When that stdout is inherited by a
  // wrapper (npm run smoke spawns this with stdio:'inherit'), the lines are
  // written into whatever stream the wrapper holds, which can make a failing
  // assertion invisible to the caller. This escape hatch mirrors the report to
  // a file so a failure is always inspectable.
  const report = []
  const emit = (line) => {
    report.push(line)
    process.stdout.write(line + '\n')
  }

  emit('')
  emit('──────────── smoke test result ────────────')
  for (const item of evidence) emit(`  ✓ ${item}`)
  for (const item of problems) emit(`  ✗ ${item}`)

  const flush = () => {
    const target = process.env.HERTZINNO_SMOKE_REPORT
    if (!target) return
    try {
      fs.writeFileSync(
        target,
        `${report.join('\n')}\n--- stdout ---\n${stdout.slice(-4000)}\n--- stderr ---\n${stderr.slice(-4000)}\n`
      )
    } catch {
      // Reporting must never be the thing that fails the run.
    }
  }

  if (problems.length > 0) {
    emit(`\n✗ Renderer/app health problems detected.`)
    emit(`--- stdout ---\n${stdout.slice(-2500)}`)
    emit(`--- stderr ---\n${stderr.slice(-2500)}`)
    flush()
    cleanup()
    process.exit(1)
  }

  if (fatal.length > 0) {
    emit(`\n✗ FATAL patterns matched:`)
    for (const pattern of fatal) emit(`    ${pattern}`)
    emit(`\n--- stderr ---\n${stderr.slice(-3000)}`)
    flush()
    cleanup()
    process.exit(1)
  }

  if (evidence.length === 0) {
    emit(`\n✗ No startup evidence found.`)
    emit(`--- stdout ---\n${stdout.slice(-2000)}`)
    emit(`--- stderr ---\n${stderr.slice(-3000)}`)
    flush()
    cleanup()
    process.exit(1)
  }

  // Require the strong signals, not merely "something was logged": a boot that
  // creates a database but never registers IPC would leave a frozen UI, and one
  // that never writes a log would ship without diagnostics.
  const required = ['database created', 'IPC handlers registered', 'logger wrote']
  const missing = required.filter((token) => !evidence.some((item) => item.includes(token)))
  if (missing.length > 0) {
    emit(`\n✗ Missing required startup signals: ${missing.join(', ')}`)
    emit(`--- stdout ---\n${stdout.slice(-2000)}`)
    emit(`--- stderr ---\n${stderr.slice(-3000)}`)
    flush()
    cleanup()
    process.exit(1)
  }

  emit('\n✓ main process booted successfully')
  flush()
  cleanup()
  process.exit(0)
}

function cleanup() {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Best effort; a leftover temp directory is not worth failing over.
  }
}

// Boot usually completes in 1-3 seconds. Wait long enough to catch a late
// renderer error, then evaluate on a clean timeout.
const deadline = setTimeout(evaluate, 9000)

child.on('exit', (code) => {
  if (finished) return
  // An early exit is itself a failure signal — unless it exited 0 having done
  // its work, which a GUI app should not do on its own.
  if (code !== 0 && code !== null) {
    process.stdout.write(`\n✗ Electron exited early with code ${code}\n`)
  }
  evaluate()
})

child.on('error', (error) => {
  process.stderr.write(`Failed to spawn Electron: ${error.message}\n`)
  cleanup()
  process.exit(1)
})
