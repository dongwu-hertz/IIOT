#!/usr/bin/env node
/**
 * `npm run smoke` entry point.
 *
 * WHY A WRAPPER
 * The smoke test needs the renderer built with `VITE_SMOKE_PROBE=1` so the
 * status-push self-check is compiled in. Setting an environment variable inline
 * (`VAR=1 npm run build`) works in bash but NOT in cmd.exe or PowerShell, and
 * this project is developed on macOS while shipping to Windows — a script that
 * only works on one of them is a trap for whoever builds next.
 *
 * Setting `env` on a child process works identically on every platform, so the
 * whole sequence lives here instead of in package.json.
 *
 * Steps:
 *   1. build everything with the probe enabled
 *   2. run the headless startup check against that build
 *   3. rebuild WITHOUT the probe, so a probe-enabled bundle is never the
 *      artifact left on disk afterwards
 */

'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function run(label, command, args, env) {
  process.stdout.write(`\n═══ ${label} ═══\n`)

  // On Windows `npm` is a batch shim (npm.cmd). Node refuses to spawn a `.cmd`
  // directly — it throws EINVAL on every Node >= 20 — unless a shell interprets
  // it. Without this the smoke test dies at step 1 with "Failed to run npm.cmd"
  // and never boots the app.
  //
  // `shell` must be set ONLY for those shims. Enabling it unconditionally routes
  // an ordinary executable through cmd.exe, which then splits the command on
  // its spaces: spawning `C:\Program Files\nodejs\node.exe` becomes
  // `'C:\Program' is not recognized as an internal or external command`, so the
  // real startup check dies before it can run while every npm call still works.
  const isBatchShim = isWindows && /\.(cmd|bat)$/i.test(command)

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: isBatchShim
  })
  if (result.error) {
    process.stderr.write(`Failed to run ${command}: ${result.error.message}\n`)
    return 1
  }
  const status = result.status ?? 1
  // Surface every step's exit code. The individual checks print their own
  // results, but a non-zero that comes from the orchestration itself (rather
  // than from a failed assertion) is otherwise invisible: the run just ends
  // with a bare exit code and no failing line to point at.
  process.stdout.write(`─── ${label}: exit ${status} (signal ${result.signal ?? 'none'})\n`)
  return status
}

// 1. Build WITH the self-check probe compiled in.
const buildStatus = run('build (probe enabled)', npmCmd, ['run', 'build'], {
  VITE_SMOKE_PROBE: '1'
})
if (buildStatus !== 0) {
  process.stderr.write('\n✗ Build failed; not running the smoke test.\n')
  process.exit(buildStatus)
}

// 2. Run the headless check.
const smokeStatus = run('headless startup check', process.execPath, [
  path.join(__dirname, 'smoke-start.cjs')
])

// 3. Always restore a clean, probe-free build, even when the check failed —
//    otherwise the next developer inspects an instrumented bundle.
run('rebuild (probe removed)', npmCmd, ['run', 'build'], { VITE_SMOKE_PROBE: '0' })

process.exit(smokeStatus)
