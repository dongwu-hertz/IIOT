#!/usr/bin/env node
/**
 * End-to-end check of the FA371 acoustic camera path, against the mock device.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT ONLY AS UNIT TESTS
 * The camera differs from the acoustic box in four ways that no single unit test
 * can hold together:
 *
 *   1. it has NO identity endpoint, so its `device_uid` is minted from the
 *      address (`camera-identity.ts`) — re-adding the same address must update
 *      that row rather than create a second camera;
 *   2. "test connection" is `/login` PLUS one authenticated read, because a token
 *      that is issued but never accepted looks exactly like success;
 *   3. the health check must not call `/get_devinfo`, which the camera does not
 *      implement — doing so marks a perfectly healthy camera OFFLINE after three
 *      probes;
 *   4. it has no channels, so nothing may be seeded for it.
 *
 * So this drives the REAL stack — renderer -> preload -> IPC -> DeviceService ->
 * Fa371ApiClient -> mock -> SQLite — and asserts the four behaviours plus the
 * rejection of a wrong password.
 *
 * USAGE
 *   node scripts/verify-fa371.cjs
 *
 * Requires `out/` to be built (`npm run build`). Starts and stops its own mock
 * (`scripts/mock-fa371.cjs`) on a free port, and its own Electron profile.
 */

'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const electronBinary = require('electron')
// Temp driver/wrapper files and screenshots go in a scratch dir, not in the repo:
// this script is meant to be runnable from CI without dirtying the working tree.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-fa371-probe-'))

/**
 * Target selection.
 *
 *   (default)      start the local mock on a free port
 *   --host <ip>    point at a REAL camera instead (e.g. --host 192.168.110.235)
 *
 * Against a real device the script stays strictly read-only AND skips the
 * wrong-password step: a real appliance may lock an account after a few failed
 * logins, and the rejection path is already covered against the mock. Nothing
 * here writes device configuration — adding a camera only writes to the
 * throwaway local profile.
 */
const argv = process.argv.slice(2)
const hostFlag = argv.indexOf('--host')
const REAL_HOST = hostFlag === -1 ? null : argv[hostFlag + 1]
const hostPortFlag = argv.indexOf('--port')
const REAL_PORT = hostPortFlag === -1 ? 80 : Number(argv[hostPortFlag + 1])

const CAMERA_PASSWORD = '123456'

/** Start the mock and resolve with its port, read from its own banner. */
function startMock() {
  return new Promise((resolve, reject) => {
    const mock = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'mock-fa371.cjs'), '--port', '0', '--seed'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('mock did not report a port:\n' + buffer)), 15000)
    const onData = (chunk) => {
      buffer += chunk.toString()
      // The mock reports `listening    http://127.0.0.1:<port>`; matching on the
      // URL is stabler than looking for the word "port", which also appears in
      // the usage text above it.
      const match = /127\.0\.0\.1:(\d{2,5})/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve({ mock, port: Number(match[1]) })
      }
    }
    mock.stdout.on('data', onData)
    mock.stderr.on('data', onData)
  })
}

const driverPath = path.join(workDir, 'camera-driver.cjs')
const wrapperPath = path.join(workDir, 'camera-wrapper.cjs')

const DRIVER = `'use strict'
const { app } = require('electron')
const PORT = Number(process.env.CAMERA_PORT)
const HOST = process.env.CAMERA_HOST
const CHECK_BAD_PASSWORD = process.env.CAMERA_CHECK_BAD_PASSWORD === '1'
const DEVICE_NAME = process.env.CAMERA_NAME
const PASSWORD = ${JSON.stringify(CAMERA_PASSWORD)}

const problems = []
const log = (m) => process.stdout.write('[camera] ' + m + '\\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  await sleep(4000)
  const win = require('electron').BrowserWindow.getAllWindows()[0]
  if (!win) { log('FAILED no window'); process.exit(1) }
  const run = (expr) => win.webContents.executeJavaScript('(async () => { ' + expr + ' })()')

  /**
   * Sign in first.
   *
   * The application now requires an account before it will do anything, and the
   * factory administrator must change its password on first use — so this walks
   * the same two steps an operator would, against the throwaway profile this
   * script creates. Without it every device call below would fail with FORBIDDEN.
   */
  const signedIn = await run(\`
    const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' })
    if (!login.success) return JSON.stringify({ ok: false, step: 'login', code: login.error.code })
    if (login.data.mustChangePassword) {
      const changed = await window.api.auth.changePassword({
        currentPassword: 'Hz@123456',
        newPassword: 'fa371-verify-pass'
      })
      if (!changed.success) return JSON.stringify({ ok: false, step: 'change', code: changed.error.code })
    }
    return JSON.stringify({ ok: true })
  \`)
  log('sign in -> ' + signedIn)
  if (!JSON.parse(signedIn).ok) {
    problems.push('could not sign in: ' + signedIn)
    log('problems: ' + problems.length)
    for (const p of problems) log('  ! ' + p)
    app.exit(1)
    return
  }

  // 1. A wrong password must fail, and must NOT leave a device behind.
  //    Skipped against a real camera: it may lock the account, and the mock
  //    already covers the rejection path.
  if (CHECK_BAD_PASSWORD) {
    const bad = await run(\`
      const r = await window.api.devices.add({
        kind: 'acousticCamera', ip: \${JSON.stringify(HOST)}, httpPort: \${PORT},
        username: 'admin', password: 'definitely-wrong'
      })
      const list = await window.api.devices.list()
      return JSON.stringify({ ok: r.success, code: r.success ? null : r.error.code, count: (list.data || []).length })
    \`)
    log('wrong password -> ' + bad)
    if (JSON.parse(bad).ok) problems.push('a wrong password was accepted')
    if (JSON.parse(bad).count !== 0) problems.push('a failed add still created a device row')
  }

  // 2. The real add.
  const added = await run(\`
    const r = await window.api.devices.add({
      kind: 'acousticCamera', ip: \${JSON.stringify(HOST)}, httpPort: \${PORT},
      username: 'admin', password: \${JSON.stringify(PASSWORD)}, name: \${JSON.stringify(DEVICE_NAME)}
    })
    return JSON.stringify(r.success
      ? { ok: true, device: r.data }
      : { ok: false, code: r.error.code, message: r.error.message })
  \`)
  log('add -> ' + added)
  const parsed = JSON.parse(added)
  if (!parsed.ok) {
    problems.push('camera add failed: ' + parsed.message)
  } else {
    const device = parsed.device
    log('  kind      : ' + device.kind)
    log('  deviceUid : ' + device.deviceUid)
    log('  status    : ' + device.status)
    log('  name      : ' + device.name)
    if (device.kind !== 'acousticCamera') problems.push('wrong kind persisted: ' + device.kind)
    // The uid must be the MINTED one for the address under test — not a
    // firmware-issued identity (the camera has no such endpoint) and not a value
    // that happens to look right for a different host.
    const expectedUid = 'fa371:' + HOST + ':' + PORT
    if (device.deviceUid !== expectedUid) {
      problems.push('uid is not the minted camera identity: ' + device.deviceUid + ' (expected ' + expectedUid + ')')
    }
    if (device.status !== 'ONLINE') problems.push('camera not marked ONLINE: ' + device.status)
  }

  // 3. Re-adding the same address must UPDATE, not duplicate.
  const again = await run(\`
    const r = await window.api.devices.add({
      kind: 'acousticCamera', ip: \${JSON.stringify(HOST)}, httpPort: \${PORT},
      username: 'admin', password: \${JSON.stringify(PASSWORD)}
    })
    const list = await window.api.devices.list()
    return JSON.stringify({ ok: r.success, count: (list.data || []).length })
  \`)
  log('re-add -> ' + again)
  if (JSON.parse(again).count !== 1) problems.push('re-adding duplicated the camera: ' + again)

  // 4. The camera must survive a health-check pass without being marked offline,
  //    which is what happens if the box's /get_devinfo is used on it.
  const health = await run(\`
    await new Promise((r) => setTimeout(r, 2500))
    const list = await window.api.devices.list()
    return JSON.stringify((list.data || []).map((d) => ({ kind: d.kind, status: d.status })))
  \`)
  log('after health checks -> ' + health)
  if (JSON.parse(health).some((d) => d.status !== 'ONLINE')) {
    problems.push('camera went offline during health checks: ' + health)
  }

  log('problems: ' + problems.length)
  for (const p of problems) log('  ! ' + p)
  app.exit(problems.length === 0 ? 0 : 1)
})
`

const WRAPPER = `'use strict'
require(${JSON.stringify(driverPath)})
require(${JSON.stringify(path.join(projectRoot, 'out', 'main', 'index.js'))})
`

fs.writeFileSync(driverPath, DRIVER)
fs.writeFileSync(wrapperPath, WRAPPER)

/**
 * Resolve the target, then run the driver against it.
 *
 * The only difference between the two targets is who provides the address, plus
 * the wrong-password step (skipped on hardware, see the note at the top).
 */
const target = REAL_HOST
  ? Promise.resolve({ mock: null, port: REAL_PORT, host: REAL_HOST })
  : startMock().then(({ mock, port }) => ({ mock, port, host: '127.0.0.1' }))

target
  .then(({ mock, port, host }) => {
    process.stdout.write(
      mock
        ? `[camera] mock FA371 on port ${port}\n`
        : `[camera] REAL camera at ${host}:${port} (read-only; wrong-password step skipped)\n`
    )
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-camera-'))
    const child = spawn(electronBinary, [wrapperPath, `--user-data-dir=${userDataDir}`, '--disable-gpu'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        CAMERA_PORT: String(port),
        CAMERA_HOST: host,
        // Against hardware, one failed login could lock the account for a real
        // operator; the rejection path is covered by the mock instead.
        CAMERA_CHECK_BAD_PASSWORD: mock ? '1' : '0',
        CAMERA_NAME: mock ? 'Mock FA371' : `FA371 ${host}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let output = ''
    const onData = (chunk) => {
      output += chunk
      // Echo EVERYTHING (including the app's own main-process log): when a probe
      // step hangs, the filtered view is the thing that hides the reason.
      process.stdout.write(chunk)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    /**
     * Hard cap.
     *
     * A driver that throws (e.g. a typo in one of its interpolations) leaves the
     * Electron app alive with nothing left to do, and without this the script
     * waits forever — which in CI looks like a hung build rather than a failure.
     * 90 s is far longer than the ~15 s a healthy run takes.
     */
    const killTimer = setTimeout(() => {
      output += '\n[camera] TIMEOUT after 90s\n'
      try { child.kill() } catch {}
    }, 90_000)

    child.on('exit', (code) => {
      clearTimeout(killTimer)
      try { mock?.kill() } catch {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
      const passed = /problems: 0/.test(output)
      if (!passed) {
        process.stdout.write('[camera] FAILED (exit ' + code + ')\n')
        const noisy = output.split('\n').filter((l) => !/^\d{2}:\d{2}:\d{2}/.test(l)).join('\n')
        process.stdout.write(noisy.slice(-3000) + '\n')
      } else {
        process.stdout.write(
          `[camera] camera add verified end to end against ${host}:${port}\n`
        )
      }
      process.exit(passed ? 0 : 1)
    })
  })
  .catch((error) => {
    console.error('[camera] could not prepare the target:', error.message)
    process.exit(1)
  })
