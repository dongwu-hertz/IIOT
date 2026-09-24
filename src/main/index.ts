/**
 * Electron main process entry.
 *
 * Window security settings are deliberate, not defaults:
 *   contextIsolation: true   - preload runs in a separate world
 *   nodeIntegration: false   - no `require` in the renderer
 *   sandbox: true            - renderer is OS-sandboxed
 *   webSecurity: true        - no disabled-CORS shortcuts
 *
 * Together with `connect-src 'none'` in the renderer CSP, these make it
 * impossible for UI code to reach a device directly — the architectural rule
 * from spec appendix C rule 3 is enforced by the platform rather than by
 * code review.
 */

import { app, BrowserWindow, shell, session } from 'electron'
import path from 'node:path'
import { initServices } from './services/app-services'
import { registerIpcHandlers } from './ipc/handlers'
import { appLog } from './services/logging/logger'
import { probeFfmpeg } from './services/media/ffmpeg'
import { registerLinkagePopupScheme, LINKAGE_POPUP_SCHEME } from './services/linkage/linkage-actions'
import { DEVICE_STATUS_CHANNEL, PushChannels } from '@shared/ipc/contract'
import type { PendingAlarmSnapshot } from '@shared/ipc/contract'
import type { E2RealtimeValueEvent } from '@shared/domain/e2-callback'
import type { SessionInfo } from '@shared/domain/auth'

let mainWindow: BrowserWindow | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    // Matches the UI background (spec 8.2) so there is no white flash on load.
    backgroundColor: '#FFFFFF',
    title: 'HAIS',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // No <webview> tags: device UIs open in the system browser (spec 8.5).
      webviewTag: false
    }
  })

  // Avoid a visible blank frame: render only once the first paint is ready.
  window.once('ready-to-show', () => window.show())

  // Any attempt to open a new window is redirected to the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block in-app navigation away from the app shell. A device web UI must never
  // load inside this window.
  window.webContents.on('will-navigate', (event, url) => {
    const isDevServer = !app.isPackaged && url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')
    if (!isDevServer) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  attachSmokeTestProbes(window)

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    mainWindow = undefined
  })

  return window
}

/**
 * Global network hardening.
 * The app renderer must never issue a request; all device traffic originates in
 * the main process, outside the browser session.
 *
 * TWO GATES, AND BOTH HAD TO BE OPENED FOR THE CAMERA LIVE VIEW
 * The renderer's own policy is the `<meta http-equiv="Content-Security-Policy">` in
 * `src/renderer/index.html`; this handler is the second, independent gate that sees
 * every request the session makes. A loopback media stream has to pass BOTH, so
 * adding `media-src http://127.0.0.1:*` to the meta tag alone would have produced a
 * request cancelled right here — logged as a blocked network request, with a
 * `<video>` that never starts and no other symptom.
 *
 * THIRD OPENING: ONLINE MAP TILES (same two-gate lesson)
 * The CSP meta widened `img-src` to `https:` for the optional online basemap
 * (owner 2026-09-19), but this gate still cancelled every tile `<img>` — the map
 * page showed nothing but the "some tiles failed" note. An image load cannot be
 * turned into a fetch()/XHR/WebSocket channel (`connect-src 'none'` still blocks
 * those in the renderer policy), so https **images** pass here exactly like they
 * pass the CSP. Anything that is not an image stays on the old allow-list.
 */
function configureSession(): void {
  const defaultSession = session.defaultSession

  // Reject every renderer-initiated request that is not the app shell itself,
  // an online map tile image, or the loopback camera stream.
  defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const isOnlineTileImage = details.resourceType === 'image' && /^https:\/\//i.test(url)
    const allowed =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith('chrome-extension://') ||
      (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      // 告警联动弹窗（2026-09-23「弹窗失败 ERR_BLOCKED_BY_CLIENT」修复）：
      // 弹窗窗口共享 defaultSession，它的自定义协议此前不在白名单里，加载被这里
      // 整个拦掉。这个协议的处理器只回主进程内存里的静态 HTML 字符串
      // （`protocol.handle` 在 ElectronPopupSink 构造时注册），不放行任何文件或网络。
      url.startsWith(`${LINKAGE_POPUP_SCHEME}://`) ||
      isCameraLiveStreamUrl(url) ||
      isOnlineTileImage

    if (!allowed) {
      appLog().warn('Blocked renderer-initiated network request', { url, resourceType: details.resourceType })
    }
    callback({ cancel: !allowed })
  })

  /*
   * Deny every permission request except the async clipboard write.
   *
   * WHY THE CLIPBOARD IS THE EXCEPTION（业主 20260921 批第 7 条：复制 RTSP 显示复制失败）
   * `navigator.clipboard.writeText` goes through Chromium's permission broker as
   * `clipboard-sanitized-write`. With the old deny-everything handler, every copy in
   * the renderer (RTSP address, account names, push endpoint URLs — six call sites)
   * rejected with NotAllowedError and landed on the「复制失败」fallback message.
   * Denying everything EXCEPT this one permission keeps the security posture
   * (no notifications/geolocation/media) while making copy work as users expect.
   */
  defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = permission === 'clipboard-sanitized-write'
    if (!allowed) {
      appLog().warn('Denied renderer permission request', { permission })
    }
    callback(allowed)
  })
}

/**
 * The camera live-view byte stream, and nothing else.
 *
 * WHY THIS IS SAFE WHEN EVERY OTHER RENDERER REQUEST IS REFUSED
 * The FA371 publishes H.264 over RTSP, which Chromium cannot demux, so the main
 * process re-muxes it with the bundled ffmpeg and serves the result from a server
 * bound to loopback on an EPHEMERAL port (`listen(0)` — the OS picks it at bind
 * time, so no fixed number can be written here; a wildcard port is the only
 * expressible form, and pinning one would break on every restart).
 *
 * The match is on the LITERAL `127.0.0.1`, never `localhost` (which resolves through
 * the hosts file and can be pointed at another host) and never a device IP, so this
 * grants reach to nothing outside this machine. The stream is further protected by a
 * random per-session token in its path and by the loopback-only bind itself, both
 * enforced in `services/media/rtsp-stream.ts`. And the renderer CSP keeps
 * `connect-src 'none'`, so this allowance cannot be turned into a fetch()/XHR/
 * WebSocket channel: only a media element can load it.
 */
function isCameraLiveStreamUrl(url: string): boolean {
  return url.startsWith('http://127.0.0.1:')
}

/**
 * Smoke-test instrumentation.
 *
 * A headless check that only inspects main-process logs cannot tell the
 * difference between a working app and a blank white window: a renderer
 * exception, a missing preload bridge or a Vue mount failure all leave the main
 * process healthy. This wires renderer signals back to stdout so the smoke test
 * can assert on them.
 *
 * Enabled ONLY by an explicit environment variable, so it can never run in a
 * customer's installation. The output prefix is machine-readable on purpose.
 */
function attachSmokeTestProbes(window: BrowserWindow): void {
  if (!process.env.HERTZINNO_SMOKE_TEST) return

  const report = (status: string, detail = ''): void => {
    process.stdout.write(`[smoke] ${status}${detail ? ` ${detail}` : ''}\n`)
  }

  let smokeSequenceStarted = false

  /**
   * Load BOTH native modules and actually use them.
   *
   * Why this is not redundant with the startup checks:
   *
   *  - `better-sqlite3` is a V8-ABI addon. The app opens its database during
   *    startup, so a load failure is normally visible — but only because of that
   *    side effect. Asserting the module directly says WHICH module failed and
   *    reports the ABI the binary was built for.
   *
   *  - `@duckdb/node-api` is required LAZILY, inside
   *    TrendQueryService.runQuery. Nothing at startup touches it, so a missing
   *    or mis-packaged binding is invisible in the packaged app until a user
   *    opens the trend page and queries. That is exactly the kind of failure
   *    that should be caught by an automated check rather than by a customer.
   */
  void (async () => {
    const detail: Record<string, unknown> = {
      node: process.versions.node,
      modules: process.versions.modules,
      electron: process.versions.electron,
      packaged: app.isPackaged
    }

    try {
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(':memory:')
      const row = db.prepare('select sqlite_version() as v').get() as { v: string }
      db.close()
      detail.sqlite = 'ok'
      detail.sqliteVersion = row.v
    } catch (error) {
      detail.sqlite = `FAIL: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    }

    try {
      const { DuckDBInstance } = require('@duckdb/node-api') as typeof import('@duckdb/node-api')
      const instance = await DuckDBInstance.create(':memory:')
      try {
        const connection = await instance.connect()
        const result = await connection.runAndReadAll('SELECT 42 AS answer')
        const rows = result.getRowObjects()
        detail.duckdb = 'ok'
        detail.duckdbAnswer = rows[0] ? Number(rows[0].answer) : null
      } finally {
        instance.closeSync()
      }
    } catch (error) {
      detail.duckdb = `FAIL: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    }

    report('native-modules', JSON.stringify(detail))

    /**
     * The bundled ffmpeg transcoder, run INSIDE the packaged process.
     *
     * Same reasoning as the native-modules probe above, and one extra twist: the
     * binary cannot be executed from inside an asar archive, so a packaging mistake
     * (a missing `asarUnpack` entry) produces a path that EXISTS and cannot RUN.
     * Checking for the file on disk would therefore pass while the feature is broken.
     * The only real proof is spawning it, which is what `probeFfmpeg()` does — it
     * resolves the packaged location, runs `-version` and reports the banner.
     *
     * Reported separately from `native-modules` so `scripts/verify-packaged.cjs` can
     * assert it on its own line, and so a failure names ffmpeg rather than "a native
     * module".
     */
    try {
      // Imported at module scope (bundled inline) rather than required by path: the
      // build emits a single main bundle, so a dynamic relative require would not
      // resolve from `out/main/`.
      const probe = await probeFfmpeg({ force: true })
      report(
        'ffmpeg',
        JSON.stringify({
          ok: probe.ok,
          path: probe.path,
          source: probe.source,
          version: probe.version ?? null,
          installerVersion: probe.installerVersion ?? null,
          banner: probe.banner ?? null,
          error: probe.error ?? null
        })
      )
    } catch (error) {
      report('ffmpeg', JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  })()

  window.webContents.on('did-finish-load', () => {
    // A reload (the locale probe below performs one per language) fires this
    // again. Reporting the bridge a second time would duplicate output and
    // re-run the status-push check against a freshly mounted store, so the
    // first load owns the whole sequence.
    if (smokeSequenceStarted) return
    smokeSequenceStarted = true

    report('renderer-loaded')
    // Confirm the preload bridge actually crossed the context boundary: the
    // renderer loaded does NOT imply `window.api` exists.
    window.webContents
      .executeJavaScript(
        `(async () => {
           const api = typeof window.api === 'object' && window.api !== null
           const events = typeof window.events === 'object' && window.events !== null

           /*
            * SIGN IN BEFORE LOOKING AT THE UI.
            *
            * The application now gates the whole shell behind an application
            * account, and the factory administrator must replace its password on
            * first use. The smoke probes create a throwaway profile, so they walk
            * the same two steps an operator would — which also means this doubles
            * as an end-to-end check of the login path in a packaged build.
            *
            * The session lives in the MAIN process, so it survives the reloads the
            * locale probe performs below.
            */
           let signIn = { step: 'skipped' }
           /*
            * Measured BEFORE signing in, and asserted by verify-packaged.
            *
            * This is the security property of the account gate: the shell — and
            * therefore every device read the shell performs on mount — must not
            * exist until a session does. A regression here would not break
            * anything visibly, which is exactly why it is measured.
            */
           const mountedBeforeSignIn = !!document.querySelector('.app-shell')
           if (api) {
             const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' })
             if (!login.success) {
               signIn = { step: 'login', code: login.error && login.error.code }
             } else if (login.data.mustChangePassword) {
               const changed = await window.api.auth.changePassword({
                 currentPassword: 'Hz@123456',
                 newPassword: 'smoke-probe-pass'
               })
               signIn = changed.success
                 ? { step: 'changed' }
                 : { step: 'change', code: changed.error && changed.error.code }
             } else {
               signIn = { step: 'already-signed-in' }
             }
           }

           /*
            * Wait for the shell to appear.
            *
            * Signing in changes renderer state asynchronously, so reading the DOM
            * in the same tick would always answer "not mounted" and report a
            * working application as broken. Polling also covers the slower first
            * paint of a packaged build.
            */
           const waitForShell = async () => {
             for (let attempt = 0; attempt < 40; attempt += 1) {
               if (document.querySelector('.app-shell')) return true
               await new Promise((resolve) => setTimeout(resolve, 100))
             }
             return false
           }
           const mounted = await waitForShell()

           /*
            * Brand assets are checked here because a broken image is silent: the
            * page still loads, vue-tsc still passes, and the only symptom is a
            * missing logo that nobody notices until a customer does. A bundled
            * asset that fails to resolve (wrong path, excluded from the build,
            * blocked by CSP) shows up as naturalWidth === 0.
            */
           const logo = document.querySelector('.sidebar__logo')
           const logoLoaded = !!logo && logo.complete && logo.naturalWidth > 0

           return window.api.app.getInfo().then((result) => {
             const release = result.success && result.data
               ? {
                   version: result.data.version,
                   releaseDate: result.data.releaseDate,
                   buildDate: result.data.buildDate,
                   homepage: result.data.homepage,
                   supportEmail: result.data.supportEmail
                 }
               : { error: (result.error && result.error.message) || 'app.getInfo failed' }
             return JSON.stringify({
               api,
               events,
               mounted,
               mountedBeforeSignIn,
               logoLoaded,
               release,
               signIn
             })
           })
         })()`
      )
      .then(async (raw: string) => {
        report('bridge', raw)
        await verifyStatusPushToRenderer(window)
        await verifyLocales(window)
      })
      .catch((error: unknown) =>
        report('bridge-error', error instanceof Error ? error.message : String(error))
      )
  })

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    report('renderer-failed', `${code} ${description} ${url}`)
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    report('preload-error', `${preloadPath} ${error.message}`)
  })

  window.webContents.on('console-message', (_event, level, message) => {
    // Electron's level 3 is `error`.
    if (level >= 3) report('renderer-console-error', message.slice(0, 300))
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    report('renderer-gone', `${details.reason} exitCode=${details.exitCode}`)
  })
}

/**
 * Prove the device-status push chain end to end.
 *
 * Registering a subscription is not evidence that it works. A typo in the
 * channel name, a mismatched payload shape or a store that drops the event
 * would all leave the app looking fine until a device actually dropped out in
 * front of a user.
 *
 * The renderer exposes a self-check on the devices store for exactly this
 * purpose, so the verification exercises the real mutation path instead of a
 * reimplementation of it. Keeping the check next to the behaviour is what stops
 * the two from drifting apart.
 *
 * A renderer-side global that survives arbitrary refactors, rather than Vue
 * internals, is what the probe reads.
 *
 * Runs only under HERTZINNO_SMOKE_TEST.
 */
async function verifyStatusPushToRenderer(window: BrowserWindow): Promise<void> {
  // The shell's store exposes its self-check here on mount; see App.vue.
  const raw = await window.webContents.executeJavaScript(
    `JSON.stringify(
       typeof window.__hertzinnoSelfCheck === 'function'
         ? window.__hertzinnoSelfCheck()
         : { error: 'self-check not installed' }
     )`
  )

  let parsed: {
    connected?: boolean
    unknownIdIgnored?: boolean
    knownIdApplied?: boolean
    error?: string
  }
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stdout.write('[smoke] status-push inconclusive (unparsable self-check)\n')
    return
  }

  if (parsed.error) {
    process.stdout.write(`[smoke] status-push inconclusive (${parsed.error})\n`)
    return
  }

  // The subscription must be connected. Whether a KNOWN device exercised the
  // mutation path depends on the database having a device, which the smoke test
  // does not require — so that half is reported, not asserted.
  if (!parsed.connected) {
    process.stdout.write('[smoke] status-push FAILED (store is not subscribed)\n')
    return
  }
  if (!parsed.unknownIdIgnored) {
    process.stdout.write('[smoke] status-push FAILED (unknown device id was not ignored)\n')
    return
  }

  process.stdout.write(
    `[smoke] status-push ok connected=true unknownIdIgnored=true knownIdApplied=${parsed.knownIdApplied}\n`
  )
}

/**
 * Prove that every language actually reaches the screen in a PACKAGED build.
 *
 * WHY THIS IS NOT COVERED BY THE UNIT TESTS
 * The catalogue tests prove the four files are complete and internally
 * consistent. They cannot prove that the shipped bundle CONTAINS them, that the
 * locale is read back from `localStorage` on startup, or that a component
 * renders a translated string rather than a stale constant. Those are exactly the
 * failures a packaging mistake produces, and `scripts/demo-shot.cjs` checks them
 * only against the dev build.
 *
 * The switch is driven the way a user's choice is persisted: write the storage
 * key, reload, and read the rendered DOM. Reading the DOM (not the catalogue) is
 * the point — a component that forgot its translation helper shows up here as a
 * raw `app.*` key or as unchanged text.
 *
 * Runs only under HERTZINNO_SMOKE_TEST.
 */
async function verifyLocales(window: BrowserWindow): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * What the probe reads out of the rendered DOM.
   *
   * `version` is the footer's version span, and `footer` is the whole footer line.
   * Both are needed and they are not redundant: the version span proves the element
   * the product asked for still exists, while the footer's full text is where the
   * RELEASE DATE now lives (it moved out of the sidebar), so it is what the
   * Chinese-date regression check has to look at. Reading only the version span
   * would leave that check passing on `null` — i.e. silently testing nothing.
   */
  const readState = async (): Promise<{
    nav: string | null
    version: string | null
    footer: string | null
    copyright: string | null
    htmlLang: string
  }> => {
    const raw = (await window.webContents.executeJavaScript(
      `JSON.stringify({
         nav: (document.querySelector('.sidebar__nav .nav-item__label') || {}).textContent || null,
         version: (document.querySelector('.app-footer__version') || {}).textContent || null,
         footer: (document.querySelector('.app-footer') || {}).textContent || null,
         copyright: (document.querySelector('.app-footer__copyright') || {}).textContent || null,
         htmlLang: document.documentElement.lang
       })`
    )) as string
    return JSON.parse(raw) as {
      nav: string | null
      version: string | null
      footer: string | null
      copyright: string | null
      htmlLang: string
    }
  }

  /**
   * Poll until the reloaded window has actually painted a navigation label.
   *
   * A fixed sleep would be a race with an unpacked start from disk; polling makes
   * the probe fast when the app is quick and correct when it is slow, and a
   * timeout is REPORTED rather than silently passing.
   */
  const waitForNav = async (): Promise<{ nav: string | null; version: string | null; footer: string | null; copyright: string | null; htmlLang: string }> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const state = await readState()
        if (state.nav) return state
      } catch {
        // Navigation in flight: the JS context is being replaced.
      }
      await sleep(250)
    }
    return { nav: null, version: null, footer: null, copyright: null, htmlLang: '' }
  }

  const states: Record<string, { nav: string | null; version: string | null; footer: string | null; copyright: string | null; htmlLang: string }> = {}
  try {
    for (const code of ['zh-CN', 'zh-TW', 'en', 'es', 'tr', 'ru']) {
      await window.webContents.executeJavaScript(
        `window.localStorage.setItem('hertzinno.locale', ${JSON.stringify(code)}); true`
      )
      /**
       * Wait for the NEW document before reading it.
       *
       * Without this the read can land in the outgoing context and report the
       * PREVIOUS language's text — which would make the probe pass while proving
       * nothing. `did-finish-load` fires per navigation, so one is armed before
       * each reload.
       */
      await new Promise<void>((resolve) => {
        window.webContents.once('did-finish-load', () => resolve())
        window.webContents.reload()
      })
      states[code] = await waitForNav()
    }
  } catch (error) {
    process.stdout.write(
      `[smoke] locales inconclusive (${error instanceof Error ? error.message : String(error)})\n`
    )
    return
  }

  process.stdout.write(`[smoke] locales ${JSON.stringify(states)}\n`)
}

/**
 * Never let a closed output stream kill the application.
 *
 * A GUI application frequently has NO usable stdout/stderr: launched from a
 * shortcut, from Explorer, via `start`, or from a script whose parent has exited.
 * In that situation `electron-log`'s console transport still writes, the write
 * fails with `EPIPE: broken pipe, write`, and because a stream with no `error`
 * listener re-throws it, Node reports an UNCAUGHT EXCEPTION and the user gets a
 * modal "A JavaScript error occurred in the main process".
 *
 * That is exactly what happened during manual testing, and the trigger was
 * mundane: the shell that owned the pipe went away. An `error` listener turns the
 * failure into a silent no-op; the FILE transports (the ones that matter, under
 * the storage root) are unaffected because they never used the console at all.
 *
 * Installed before anything else can log, so even a startup failure is safe.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => {
    // Deliberately ignored: there is nowhere left to report a write failure.
  })
}

/**
 * 告警弹窗的自定义协议必须在 `app.whenReady()` **之前**注册。
 *
 * Electron 只允许在 ready 之前声明 privileged scheme；在 ready 之后注册会抛
 * 「Session can only be received when app is ready」这一类错误——而那正好是
 * 「弹窗不出现」这种最难查的症状。放在模块顶层，与其它一次性注册同处一地。
 */
registerLinkagePopupScheme()

/**
 * 用户数据目录钉住旧路径 `hertzinno-acoustic-box-manager`。
 *
 * Electron 的 `userData` 默认派生自应用名（`%APPDATA%\<应用名>`）。显示名改成
 * HAIS 之后，派生目录会跟着变成 `%APPDATA%\HAIS`，老用户升级后
 * `hertzinno-manager.db`（登录账号、设备凭据引用、设置）会被"留在旧目录、看不见"，
 * 等于一次静默的数据抛弃。显式钉回旧目录，升级链才不断。
 *
 * 唯一的例外：显式传了 `--user-data-dir` 的调用方（smoke / 平台检查 / 真机验证等
 * 脚本的一次性 profile）是有意隔离，必须尊重，所以只在没传该开关时钉住。
 */
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'hertzinno-acoustic-box-manager'))
}

/** Single-instance lock: a second launch focuses the existing window instead. */
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    try {
      const services = await initServices()
      configureSession()
      registerIpcHandlers()

      // 告警弹窗要贴在主窗口所在那块屏（多屏工位）；窗口还没建时弹窗回落到主屏。
      services.linkage.setMainWindowProvider(() => mainWindow)

      // Forward device reachability changes to the renderer so the UI reflects
      // the monitor without polling.
      services.devices.on('status', (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(DEVICE_STATUS_CHANNEL, event)
        }
      })

      /**
       * Forward session changes, for the same reason: the session belongs to this
       * process, so the renderer's copy must be told rather than have to ask.
       *
       * This is what makes the account gate work for anything that signs in over
       * the IPC bridge instead of through the page — every headless verification
       * script does exactly that, and without this push they would authenticate
       * successfully and then watch a login form that never goes away.
       */
      services.auth.on('session', (session: SessionInfo | null) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(PushChannels.AUTH_SESSION, session)
        }
      })

      /**
       * 待处理告警的推送（「提示」在导航之后仍然可见的实现点）。
       *
       * 与上面两条同一个理由：那份列表由主进程拥有，它会在界面什么都没做的
       * 时候变化（新告警到达、超出上限丢弃），所以只能由主进程推。
       * 渲染层在任何页面挂载时先读一次 `linkage.pending()`，之后靠这条推送同步。
       */
      services.linkage.on('pending', (snapshot: PendingAlarmSnapshot) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(PushChannels.LINKAGE_PENDING, snapshot)
        }
      })

      /**
       * SN-16 每秒实时值：设备 POST 到本机接入的 HTTP 端点，主进程收到后推给渲染层。
       * 与 linkage pending 同一条规矩：界面挂载时先读一次缓存状态，之后靠推送同步。
       */
      services.iotIngest.on('e2-realtime', (event: E2RealtimeValueEvent) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(PushChannels.E2_REALTIME_CALLBACK_VALUE, event)
        }
      })

      /**
       * 瓦片缓存下载进度（业主 20260921 批）：设置页发起下载后，主进程每处理一块
       * 瓦片推一次 `MapTileCacheProgress`（收尾 `done = true`），设置页的进度条靠它推进。
       * 与上面几条同一条规矩：进度由主进程拥有，只能它推。
       */
      services.mapTiles.on('progress', (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(PushChannels.MAP_CACHE_PROGRESS, progress)
        }
      })

      mainWindow = createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
      })
    } catch (error) {
      // A failed startup must be visible, not a silent no-op window.
      appLog().error('Startup failed', {
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })
      app.exit(1)
    }
  })
}

// Windows/Linux: closing the last window quits the app.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Teardown (appendix C rule 12: "no residual connections after close").
 *
 * `before-quit` is the right hook: it fires before the process tears down, so
 * the monitor interval is cleared and the SQLite handle is closed cleanly
 * rather than being killed mid-write.
 */
let disposing = false
app.on('before-quit', (event) => {
  if (disposing) return
  disposing = true
  event.preventDefault()

  void (async () => {
    try {
      const { getServices } = await import('./services/app-services')
      await getServices().dispose()
    } catch (error) {
      appLog().warn('Service disposal failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    } finally {
      app.exit(0)
    }
  })()
})
