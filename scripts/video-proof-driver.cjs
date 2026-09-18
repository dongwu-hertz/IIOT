'use strict'
/**
 * PROOF HARNESS DRIVER — not part of the shipped app, and not loaded by it.
 *
 * This file is required by `scripts/video-proof.cjs` through a generated wrapper,
 * so it runs INSIDE Electron's main process, attached to the app before the app's
 * own entry creates its window. Configuration arrives in the
 * `HZ_VIDEO_PROOF` environment variable as JSON.
 *
 * WHY THIS IS A REAL FILE AND NOT A STRING
 *
 * It used to be a big template literal inside `video-proof.cjs`, which generated
 * this program as text at run time. That design failed four times in a row, each
 * time differently, and every failure was invisible to every tool:
 *
 *   1. A backtick inside a comment here terminated the outer template literal, so
 *      the harness file itself stopped parsing.
 *   2. `\n` written for the RENDERER collapsed into a real newline on the way
 *      through, producing an unterminated string in the injected snippet.
 *   3. Snippets assembled by concatenation arrived as ONE line, so automatic
 *      semicolon insertion never fired and `return x  if (y)` became a syntax
 *      error rather than two statements.
 *   4. Electron reports any of those as "Script failed to execute, this normally
 *      means an error was thrown", which named neither the snippet nor the cause.
 *
 * A generated program is a program that nothing type-checks, nothing lints and no
 * editor understands. So it is a normal file now: `node --check` sees it, the
 * editor sees it, and the only text still generated is the two-line wrapper.
 *
 * Snippets injected into the RENDERER are still built by joining strings (they
 * have to be strings), and they still arrive on one line — so every statement in
 * them ends with an explicit `;`, and `evalInPage()` compiles each one before it
 * is sent.
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const net = require('node:net')

const CONFIG = JSON.parse(process.env.HZ_VIDEO_PROOF || '{}')
const OUT = CONFIG.out
const IP = CONFIG.ip
const PORT = CONFIG.port
const USER = CONFIG.user
const PASSWORD = CONFIG.password
const ROUTE = CONFIG.route
const SECONDS = CONFIG.seconds
/**
 * When true, the harness observes only and NEVER presses anything.
 *
 * This exists to test auto-play as the product specifies it: "if the camera is
 * working when the software opens, start the video by itself". A harness that
 * always clicks its own play button cannot tell auto-play from a manual start, and
 * would report a passing feature while the operator still has to press a button.
 */
const OBSERVE_ONLY = CONFIG.observeOnly === true
/**
 * 声纹设备（可选）。临时 profile 里本来只有那台相机自己加进来的一行，而「改设备名 /
 * 改通道名」这两个写入只能对着**真实的声纹设备**验证，所以由 `--box-ip` 显式登记。
 */
const BOX_IP = CONFIG.boxIp || ''
const BOX_PORT = CONFIG.boxPort || 80
const BOX_USER = CONFIG.boxUser || 'admin'
const BOX_PASSWORD = CONFIG.boxPassword || '123456'
/** 只有它为真时才真的写设备（并改回来）。 */
const BOX_RENAME_DRILL = CONFIG.boxRenameDrill === true

const problems = []
/**
 * **实测事实**（不是缺陷）。
 *
 * 为什么需要第二个列表：这一轮的探针会主动去问硬件「这个写入能不能做」，而答案是
 * 「设备明确拒绝」时 —— 那不是软件的缺陷，而是**被测量出来的设备事实**（本轮之前
 * 项目里没有任何一次 `set_passageway` 真机写入，见 `docs/PROTOCOL-FINDINGS.md` §6）。
 * 把它算成 `problems` 会让「界面/几何/媒体链路全部正常」这件事被一条设备能力结论淹没；
 * 把它悄悄丢掉则是本仓库最反对的那种「没有测量就没有结论」。
 *
 * 所以：**设备拒绝写入 = findings**（如实打印，出原文），而「写入报成功但读回不是新值」
 * 「失败之后真机留下了测试名字」这类**不一致**才是 problems。
 */
const findings = []
const log = (message) => {
  process.stdout.write('[video] ' + message + '\n')
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 右键菜单在四种语言下的**期望标签**。
 *
 * 这些值不是从应用里读出来的（读出来再和自己比等于什么都没验），而是独立写下的
 * 期望值，每一个都对应 `src/shared/i18n/messages/*.ts` 里的一条词条。菜单少一项、
 * 顺序变了、某个语言漏了翻译、或者键名打错导致界面渲染出一串裸 key —— 任何一样
 * 都会让下面的断言失败。
 *
 * 文件是 UTF-8：Node 按 UTF-8 读取源码，而这些字符串是**渲染出来的元素文本**，
 * 只有逐字节相同才算通过（转义写法和字面量在这里是同一件事，字面量可读性更好）。
 */
const MENU_LABELS = {
  'zh-CN': {
    capture: '抓图 / 录像',
    startRecording: '手动录像',
    stopRecording: '停止录像',
    snapshot: '抓图',
    fullscreen: '全屏',
    copyRtsp: '复制 RTSP 地址',
    openExternal: '在外部播放器打开',
    hideOverlay: '隐藏叠加信息',
    showOverlay: '显示叠加信息',
    playback: '回放本机录像',
    downloadDetect: '下载检测记录',
    closeTile: '关闭这一格',
    alarmConfig: '告警配置…',
    reasonIdle: '视频尚未启动：请先点击「开始视频」，画面出现后才能录像或抓图。'
  },
  en: {
    capture: 'Snapshot / recording',
    startRecording: 'Start manual recording',
    stopRecording: 'Stop recording',
    snapshot: 'Snapshot',
    fullscreen: 'Full screen',
    copyRtsp: 'Copy RTSP address',
    openExternal: 'Open in external player',
    hideOverlay: 'Hide overlay',
    showOverlay: 'Show overlay',
    playback: 'Play local recordings',
    downloadDetect: 'Download detection records',
    closeTile: 'Clear this cell',
    alarmConfig: 'Alarm configuration…',
    reasonIdle: 'Video is not started: click Start video first, then record or take a snapshot.'
  },
  es: {
    capture: 'Captura / grabación',
    startRecording: 'Iniciar grabación manual',
    stopRecording: 'Detener grabación',
    snapshot: 'Captura',
    fullscreen: 'Pantalla completa',
    copyRtsp: 'Copiar dirección RTSP',
    openExternal: 'Abrir en un reproductor externo',
    hideOverlay: 'Ocultar superposición',
    showOverlay: 'Mostrar superposición',
    playback: 'Reproducir grabaciones locales',
    downloadDetect: 'Descargar registros de detección',
    closeTile: 'Vaciar esta celda',
    alarmConfig: 'Configuración de alarmas…',
    reasonIdle: 'El vídeo no está iniciado: pulse Iniciar vídeo y después grabe o capture.'
  },
  tr: {
    capture: 'Ekran görüntüsü / kayıt',
    startRecording: 'Elle kaydı başlat',
    stopRecording: 'Kaydı durdur',
    snapshot: 'Ekran görüntüsü',
    fullscreen: 'Tam ekran',
    copyRtsp: 'RTSP adresini kopyala',
    openExternal: 'Harici oynatıcıda aç',
    hideOverlay: 'Bilgi katmanını gizle',
    showOverlay: 'Bilgi katmanını göster',
    playback: 'Yerel kayıtları oynat',
    downloadDetect: 'Algılama kayıtlarını indir',
    closeTile: 'Bu hücreyi boşalt',
    alarmConfig: 'Alarm yapılandırması…',
    reasonIdle: 'Video başlatılmadı: önce Videoyu başlat düğmesine basın, görüntü geldikten sonra kaydedin.'
  }
}

function menuLabels(locale) {
  return MENU_LABELS[locale] || MENU_LABELS['zh-CN']
}

/**
 * 通道墙有关的文案，四种语言各一份（这一轮加了通道状态、最近告警与声压单位）。
 *
 * 为什么要把译文再抄一遍（而不是只断言“有文字就行”）：`deviceHasNoData` 是一条
 * **结构性的事实**（这台设备的家族根本没有这种载荷），它必须与「未监测」「尚无数据」
 * 读起来是不同的话。如果只断言“角注非空”，一句写错的「未监测」也会通过，而那句话
 * 恰好会把“相机没有时频通道”说成“没有在监测这一路” —— 这就是本轮最要防的那种谎话。
 *
 * 这一轮新抄进来的几条各有各的用处：
 *   - `stateEnabled/Disabled/Unknown`：格子上那个徽标必须与**设备端读回的通道表**一致
 *     （真机 8 路里 ch0/ch1 启用、ch2–ch7 未启用），只断言“有徽标”看不出对错；
 *   - `alarmRecent / alarmNone`：措辞必须是「最近告警」+「无告警记录」，**不能**是
 *     「正在告警」—— 契约里没有每通道的实时告警推送（见本轮 `startPushProbe` 的实测）；
 *   - `splUnit`：那个 `dB` 必须来自目录而不是模板里的字面量，探针读到的就是目录里的值。
 */
const CHANNEL_WALL_GRAPH_LABELS = {
  'zh-CN': {
    noSuchData: '该设备不提供这种数据',
    notMonitored: '未监测',
    expand: '展开通道墙',
    collapse: '收起通道墙',
    stateEnabled: '已启用',
    stateDisabled: '未启用',
    stateUnknown: '状态未知',
    alarmRecent: '最近告警',
    alarmNone: '无告警记录',
    alarmLoading: '读取中…',
    alarmFailed: '告警记录读取失败',
    ackAcknowledged: '已确认',
    ackUnacknowledged: '未确认',
    splUnit: 'dB'
  },
  en: {
    noSuchData: 'This device does not provide this kind of data',
    notMonitored: 'Not monitored',
    expand: 'Expand the channel wall',
    collapse: 'Collapse the channel wall',
    stateEnabled: 'Enabled',
    stateDisabled: 'Disabled',
    stateUnknown: 'Status unknown',
    alarmRecent: 'Latest alarm',
    alarmNone: 'No alarm records',
    alarmLoading: 'Reading…',
    alarmFailed: 'Could not read the alarm records',
    ackAcknowledged: 'Acknowledged',
    ackUnacknowledged: 'Unacknowledged',
    splUnit: 'dB'
  },
  es: {
    noSuchData: 'Este dispositivo no proporciona este tipo de datos',
    notMonitored: 'Sin monitorear',
    expand: 'Expandir el muro de canales',
    collapse: 'Contraer el muro de canales',
    stateEnabled: 'Habilitado',
    stateDisabled: 'Deshabilitado',
    stateUnknown: 'Estado desconocido',
    alarmRecent: 'Última alarma',
    alarmNone: 'Sin registros de alarma',
    alarmLoading: 'Leyendo…',
    alarmFailed: 'No se pudieron leer los registros de alarma',
    ackAcknowledged: 'Confirmadas',
    ackUnacknowledged: 'Sin confirmar',
    splUnit: 'dB'
  },
  tr: {
    noSuchData: 'Bu cihaz bu tür veri sağlamıyor',
    notMonitored: 'İzlenmiyor',
    expand: 'Kanal duvarını genişlet',
    collapse: 'Kanal duvarını daralt',
    stateEnabled: 'Etkin',
    stateDisabled: 'Devre dışı',
    stateUnknown: 'Durum bilinmiyor',
    alarmRecent: 'En son alarm',
    alarmNone: 'Alarm kaydı yok',
    alarmLoading: 'Okunuyor…',
    alarmFailed: 'Alarm kayıtları okunamadı',
    ackAcknowledged: 'Onaylandı',
    ackUnacknowledged: 'Onaylanmadı',
    splUnit: 'dB'
  }
}

function channelWallLabels(locale) {
  return CHANNEL_WALL_GRAPH_LABELS[locale] || CHANNEL_WALL_GRAPH_LABELS['zh-CN']
}

/**
 * 一个**正在播放、没有录像、叠加信息可见**的画面格上，右键菜单的顶层顺序。
 *
 * 顺序来自冻结的模型 `buildCameraNvrMenu()`（`tests/camera-nvr.test.ts` 钉住了
 * 它），这里独立写一遍正是为了让「界面渲染出来的顺序」与「模型说的顺序」成为
 * 两个可以互相印证的来源。
 */
function expectedTopLevel(locale) {
  const l = menuLabels(locale)
  return [
    l.capture,
    l.fullscreen,
    l.copyRtsp,
    l.openExternal,
    l.hideOverlay,
    l.playback,
    l.downloadDetect,
    l.closeTile,
    l.alarmConfig
  ]
}

/**
 * Compile and run ONE snippet in the renderer, naming it in every failure.
 *
 * The compile step is the important half. A malformed snippet makes
 * `executeJavaScript` reject with a message that names neither the snippet nor
 * the reason, and no try/catch INSIDE the snippet can help, because a syntax
 * error never enters the function body. `vm.Script` parses it here instead, and
 * the offending source is printed rather than guessed at.
 */
async function evalInPage(win, label, source) {
  try {
    new vm.Script(source, { filename: label + '.renderer.js' })
  } catch (error) {
    log(label + ' snippet is not valid JavaScript: ' + error.message)
    log(label + ' source: ' + source)
    problems.push(label + ' snippet is not valid JavaScript: ' + error.message)
    return null
  }
  try {
    return await win.webContents.executeJavaScript(source)
  } catch (error) {
    log(label + ' threw in the renderer: ' + (error && error.message))
    log(label + ' source: ' + source)
    problems.push(label + ' threw in the renderer: ' + (error && error.message))
    return null
  }
}

app.on('browser-window-created', (_event, win) => {
  win.webContents.on('console-message', (...args) => {
    // Electron >= 33 passes a single details object; older versions pass
    // (event, level, message, line, source). Support both.
    const details = args[0]
    const isObject = details && typeof details === 'object' && 'level' in details
    const level = isObject ? String(details.level) : String(args[0])
    const text = isObject ? String(details.message) : String(args[1])
    if (level === 'error' || level === '2' || level === '3') {
      problems.push('console[' + level + '] ' + text)
    }
  })
  win.webContents.on('preload-error', (_e, p, err) =>
    problems.push('preload-error ' + p + ': ' + err.message)
  )
  win.webContents.on('render-process-gone', (_e, details) =>
    problems.push('render-process-gone: ' + JSON.stringify(details))
  )
})

/**
 * Wait until the renderer has a usable preload bridge.
 *
 * Touching `window.api` before the preload script has run throws inside the
 * renderer and, without this wait, the harness reports only Electron's generic
 * message. Waiting explicitly also turns "the bridge never appeared" into its own
 * distinct, reportable finding.
 */
async function waitForApi(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evalInPage(
      win,
      'bridgeProbe',
      'JSON.stringify({' +
        ' api: typeof window.api,' +
        ' auth: typeof (window.api && window.api.auth),' +
        ' devices: typeof (window.api && window.api.devices),' +
        ' cameraLive: typeof (window.api && window.api.cameraLive),' +
        ' hash: location.hash' +
        '})'
    )
    if (last === null) return null
    const state = JSON.parse(last)
    if (state.auth === 'object' && state.devices === 'object' && state.cameraLive === 'object') {
      return state
    }
    await sleep(400)
  }
  return last
}

/**
 * Read everything Chromium is willing to tell us about the video elements.
 *
 * Returned as a JSON string because executeJavaScript must serialise across the
 * context bridge. A missing element is reported as `found: false` rather than as
 * a pipeline failure: "the UI never rendered a player" and "the player is black"
 * are different bugs and must not be conflated.
 */
function probeScript() {
  return (
    '(() => {' +
    ' const vids = Array.prototype.slice.call(document.querySelectorAll("video"));' +
    ' const withSrc = vids.filter((v) => v.currentSrc || v.src);' +
    // The wall's AUDIO facts, counted over every <video> on the page: how many are not
    // muted (the owner's invariant is "at most one cell may produce sound"), how many
    // still carry the browser's own controls (this round must render zero: the cell has
    // exactly ONE control bar and it is ours), and each element's real `.volume`.
    // These do not depend on which element is decoding, so they are reported even when
    // no player exists at all.
    ' const audio = {' +
    '   videoElements: vids.length,' +
    '   unmuted: vids.filter((x) => !x.muted).length,' +
    '   muted: vids.filter((x) => x.muted).length,' +
    '   nativeControls: vids.filter((x) => x.controls === true || x.hasAttribute("controls")).length,' +
    '   volumes: vids.map((x) => Math.round(x.volume * 100) / 100)' +
    ' };' +
    ' const v = withSrc[0] || vids[0] || null;' +
    ' if (!v) return JSON.stringify({ found: false, audio: audio, videoElements: vids.length });' +
    ' const q = (typeof v.getVideoPlaybackQuality === "function") ? v.getVideoPlaybackQuality() : null;' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   audio: audio,' +
    '   videoElements: vids.length,' +
    '   withSrc: withSrc.length,' +
    '   srcScheme: (v.currentSrc || v.src || "").split(":")[0],' +
    '   srcLength: (v.currentSrc || v.src || "").length,' +
    '   readyState: v.readyState,' +
    '   networkState: v.networkState,' +
    '   videoWidth: v.videoWidth,' +
    '   videoHeight: v.videoHeight,' +
    '   currentTime: Math.round(v.currentTime * 100) / 100,' +
    '   duration: v.duration,' +
    '   paused: v.paused,' +
    '   muted: v.muted,' +
    '   volume: Math.round(v.volume * 100) / 100,' +
    '   controls: v.controls === true,' +
    '   hasControlsAttribute: v.hasAttribute("controls"),' +
    '   ended: v.ended,' +
    '   buffered: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1) * 100) / 100 : 0,' +
    '   totalVideoFrames: q ? q.totalVideoFrames : null,' +
    '   droppedVideoFrames: q ? q.droppedVideoFrames : null,' +
    '   error: v.error ? { code: v.error.code, message: v.error.message } : null' +
    ' });' +
    '})()'
  )
}

/**
 * 设备管理页（`/devices`）在四档窗口尺寸下的几何。
 *
 * 与总览页那一组（`REQUESTED_SIZES`，定义在 `run()` 里）刻意是两个常量：两个页面的
 * 测量是**两件事**（一个是内容列本身，一个是这一页左列的树），共用一组数字会让「这一档
 * 被漏量了」这种错看不出来。
 */
const DEVICE_TREE_SIZES = [
  [1280, 720],
  [1366, 768],
  [1920, 1080],
  [2560, 1440]
]

/** One JSON round-trip through the renderer for an arbitrary async snippet. */
async function evalJson(win, label, source, fallback) {
  const raw = await evalInPage(win, label, source)
  if (raw === null) return Object.assign({ probeFailed: true }, fallback)
  try {
    return JSON.parse(raw)
  } catch (error) {
    return Object.assign({ parseFailed: String(error && error.message), raw: String(raw).slice(0, 200) }, fallback)
  }
}

/** One JSON round-trip through the renderer for the video-element probe. */
async function probe(win) {
  const raw = await evalInPage(win, 'videoProbe', probeScript())
  return raw === null ? { found: false, probeFailed: true } : JSON.parse(raw)
}

/**
 * 设备列表里的一台设备（**按 `kind` 选，不按名字或地址猜**）。
 *
 * 名字与地址在这台真机上是可以变的（这一轮就专门在改名字），而 `kind` 是设备家族的
 * 事实：`'acousticBox' | 'acousticCamera'`。所以整套探针只按它挑设备。
 */
function listDevicesScript() {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.list();' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  return JSON.stringify({ ok: true, devices: (r.data || []).map((d) => ({' +
    '    id: d.id, kind: d.kind, name: d.name, ip: d.ip, status: d.status' +
    '  })) });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 设备的身份信息（`get_devinfo`）；设备侧的名字就在这里。 */
function deviceInfoScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.getInfo(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, info: { name: r.data.name, deviceUid: r.data.deviceUid,' +
    '    channelCount: r.data.channelCount, firmwareVersion: r.data.firmwareVersion || null } });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 本机数据库里的设备行（与上一条分开：一个说「设备说它叫什么」，一个说「我们记的什么」）。 */
function deviceRowScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.list();' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  const one = (r.data || []).filter((d) => d.id === ' + JSON.stringify(deviceId) + ')[0] || null;' +
    '  if (!one) return JSON.stringify({ ok: true, row: null });' +
    '  return JSON.stringify({ ok: true, row: { id: one.id, kind: one.kind, name: one.name, ip: one.ip,' +
    '    httpPort: one.httpPort } });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 改本机那一行（ip / httpPort / 名字）。回滚探针用它把设备侧写入指向一个关着的端口。 */
function updateDeviceRowScript(deviceId, patch) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.update(Object.assign({ id: ' + JSON.stringify(deviceId) + ' },' +
    JSON.stringify(patch) + '));' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, row: { id: r.data.id, name: r.data.name, ip: r.data.ip,' +
    '    httpPort: r.data.httpPort } });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 页面上正在显示的成功提示（`.alert--success`）；没有就是空串。 */
function noticeScript() {
  return (
    '(() => {' +
    ' const el = document.querySelector(".alert--success");' +
    ' return JSON.stringify({ text: el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "" });' +
    '})()'
  )
}

/**
 * 设备侧的通道表（`GET /get_passageway`）。
 *
 * 这是**权威**读数：`config.updateChannel` 写完会重新读设备，所以「改通道名」这件事
 * 到底成没成，只有这一条能回答。同时它也是挑「哪一路可以改」的依据 —— 真机上
 * 2~7 路是未启用的，改一个未启用的通道比改启用的风险小得多。
 */
function deviceChannelsScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.config.getChannels(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, channels: (r.data || []).map((c) => ({' +
    '    channelIndex: c.channelIndex, name: c.name, enabled: c.enabled, sensorType: c.sensorType' +
    '  })) });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/**
 * 一次**真的**设备重命名：先写本机数据库（`devices.update`），再写设备本身
 * （`config.setDeviceName`）—— 与设备管理页里那条 `renameDeviceName()` 逐句相同。
 *
 * 为什么探针要自己调这两个 IPC 而不是驱动对话框：对话框要先把输入框填好再点保存，
 * 而这里的目的是**证明写入链路的落点与读回**（本机 + 设备），不是证明对话框能打字。
 * 右键菜单能不能弹出、「修改设备名称」在不在菜单里，由上面的右键探针单独证明。
 */
function renameDeviceScript(deviceId, name) {
  return (
    '(async () => { try {' +
    '  const updated = await window.api.devices.update({ id: ' + JSON.stringify(deviceId) +
    ', name: ' + JSON.stringify(name) + ' });' +
    '  if (!updated.success) return JSON.stringify({ ok: false, step: "local", code: updated.error.code,' +
    '    message: updated.error.message || "" });' +
    '  const written = await window.api.config.setDeviceName(' + JSON.stringify(deviceId) +
    ', ' + JSON.stringify(name) + ');' +
    '  if (!written.success) return JSON.stringify({ ok: false, step: "device", code: written.error.code,' +
    '    message: written.error.message || "", localName: updated.data.name });' +
    '  return JSON.stringify({ ok: true, localName: updated.data.name });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 一次**只写设备**的通道重命名（`config.updateChannel` 在主进程里是读-改-写）。 */
function renameChannelScript(deviceId, channelIndex, name) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.config.updateChannel(' + JSON.stringify(deviceId) + ', ' +
    JSON.stringify(channelIndex) + ', { name: ' + JSON.stringify(name) + ' });' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  const one = (r.data || []).filter((c) => c.channelIndex === ' + JSON.stringify(channelIndex) + ')[0] || null;' +
    '  return JSON.stringify({ ok: true, readBack: one });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/**
 * 整棵树上每一行的文字。
 *
 * 这一条是「相机的地址不进树」的**实据**：它读的是渲染出来的 `textContent`，不是样式
 * 表里写了什么。`title` 也一起读出来 —— 一个把地址藏在 tooltip 里的实现同样会让操作员
 * 看到地址，只是要多悬停一次。
 */
function treeRowsScript() {
  return (
    '(() => {' +
    ' const tree = document.querySelector(".device-tree");' +
    ' if (!tree) return JSON.stringify({ found: false });' +
    ' const rows = Array.prototype.slice.call(tree.querySelectorAll(".device-tree__row"));' +
    ' return JSON.stringify({ found: true, rows: rows.map((row) => {' +
    '   const label = row.querySelector(".device-tree__label");' +
    '   return {' +
    '     kind: (row.className.match(/device-tree__row--(\\w+)/) || [])[1] || "",' +
    '     node: row.getAttribute("data-node-id") || "",' +
    '     text: (row.textContent || "").replace(/\\s+/g, " ").trim(),' +
    '     title: label ? (label.getAttribute("title") || "") : "",' +
    '     meta: row.querySelector(".device-tree__meta")' +
    '       ? (row.querySelector(".device-tree__meta").textContent || "").trim() : "",' +
    '     channelLabel: row.querySelector(".device-tree__channel-label")' +
    '       ? (row.querySelector(".device-tree__channel-label").textContent || "").trim() : "",' +
    '     channelName: row.querySelector(".device-tree__channel-name")' +
    '       ? (row.querySelector(".device-tree__channel-name").textContent || "").trim() : ""' +
    '   };' +
    ' })});' +
    '})()'
  )
}

/**
 * 在**设备行** / **通道行**上真的派发一次右键，然后读菜单。
 *
 * `nodeId` 给了就按 `data-node-id` **精确**选那一行（`device:<id>` /
 * `channel:<id>:<index>`）。多台设备时按 `which` 取第一行会点错对象 —— 相机与声纹设备
 * 同时在树上时就会发生，而「改错设备的名字」是这个探针最不能犯的错。
 */
function treeRightClickScript(which, nodeId) {
  return (
    '(() => {' +
    ' const tree = document.querySelector(".device-tree");' +
    ' if (!tree) return JSON.stringify({ found: false });' +
    ' const want = ' + JSON.stringify(which) + ';' +
    ' const nodeId = ' + JSON.stringify(nodeId === undefined ? null : nodeId) + ';' +
    ' const row = Array.prototype.slice.call(tree.querySelectorAll(".device-tree__row"))' +
    '   .filter((candidate) => {' +
    '     if (nodeId) return candidate.getAttribute("data-node-id") === nodeId;' +
    '     if (want === "channel") return candidate.classList.contains("device-tree__row--channel") &&' +
    '       !!candidate.querySelector(".device-tree__channel-label") &&' +
    '       !!candidate.querySelector(".device-tree__channel-name");' +
    '     return candidate.classList.contains("device-tree__row--" + want);' +
    '   })[0] || null;' +
    ' if (!row) return JSON.stringify({ found: false, rows: Array.prototype.slice.call(' +
    '   tree.querySelectorAll(".device-tree__row")).map((r) => r.getAttribute("data-node-id")) });' +
    ' const rect = row.getBoundingClientRect();' +
    ' const x = Math.round(rect.left + Math.min(rect.width / 2, 60));' +
    ' const y = Math.round(rect.top + rect.height / 2);' +
    ' row.dispatchEvent(new MouseEvent("contextmenu", {' +
    '   bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: x, clientY: y' +
    ' }));' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   row: (row.textContent || "").replace(/\\s+/g, " ").trim(),' +
    '   node: row.getAttribute("data-node-id") || "",' +
    '   x: x, y: y' +
    ' });' +
    '})()'
  )
}

/** 在菜单外面按一下鼠标（组件监听 document 上的 mousedown，捕获阶段）。 */
function dismissMenuScript() {
  return (
    '(() => {' +
    ' const openBefore = !!document.querySelector(".vmenu");' +
    ' document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));' +
    ' return JSON.stringify({ openBefore: openBefore, openAfter: !!document.querySelector(".vmenu") });' +
    '})()'
  )
}

/** 页面内容列与树的几何（`/monitor` 与 `/devices` 共用同一套读数）。 */
function treeGeometryScript() {
  return (
    '(() => {' +
    ' const tree = document.querySelector(".device-tree");' +
    ' const page = document.querySelector(".page");' +
    ' const card = document.querySelector(".devices-topology");' +
    ' const content = document.querySelector(".app-content");' +
    ' if (!tree || !page || !card || !content) return JSON.stringify({ found: false });' +
    ' content.scrollTop = 0;' +
    ' const round = (n) => Math.round(n);' +
    ' const contentStyle = getComputedStyle(content);' +
    ' const box = {' +
    '   left: content.getBoundingClientRect().left + (parseFloat(contentStyle.paddingLeft) || 0),' +
    '   top: content.getBoundingClientRect().top + (parseFloat(contentStyle.paddingTop) || 0),' +
    '   right: content.getBoundingClientRect().left + content.clientWidth' +
    '     - (parseFloat(contentStyle.paddingRight) || 0)' +
    ' };' +
    ' const cardRect = card.getBoundingClientRect();' +
    ' const treeRect = tree.getBoundingClientRect();' +
    ' const row = tree.querySelector(".device-tree__row");' +
    ' const rowRect = row ? row.getBoundingClientRect() : null;' +
    ' const interactive = Array.prototype.slice.call(' +
    '   document.querySelectorAll("button, select, input, [role=tab]")' +
    ' ).filter((el) => {' +
    '   if (el.closest("[role=dialog]")) return false;' +
    '   const r = el.getBoundingClientRect();' +
    '   return r.width > 0 && r.height > 0;' +
    ' });' +
    ' const clipped = interactive.filter((el) => {' +
    '   const r = el.getBoundingClientRect();' +
    '   return r.left < -0.5 || r.right > window.innerWidth + 0.5;' +
    ' }).map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 24));' +
    ' const layoutEl = document.querySelector(".devices-layout");' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   viewport: { w: window.innerWidth, h: window.innerHeight },' +
    '   contentBox: { left: round(box.left), top: round(box.top), right: round(box.right) },' +
    '   card: { left: round(cardRect.left), top: round(cardRect.top), width: round(cardRect.width) },' +
    '   tree: { left: round(treeRect.left), top: round(treeRect.top), width: round(treeRect.width) },' +
    '   firstRow: rowRect ? { left: round(rowRect.left), top: round(rowRect.top) } : null,' +
    '   firstChildIsCard: !!(layoutEl && layoutEl.firstElementChild === card),' +
    '   gapFromContentBoxPx: { left: round(cardRect.left - box.left), top: round(cardRect.top - box.top) },' +
    '   page: { left: round(page.getBoundingClientRect().left), width: round(page.getBoundingClientRect().width),' +
    '     height: round(page.getBoundingClientRect().height),' +
    '     top: round(page.getBoundingClientRect().top) },' +
    '   contentClientWidth: content.clientWidth,' +
    '   contentScrollWidth: content.scrollWidth,' +
    '   windowInnerWidth: window.innerWidth,' +
    '   bodyScrollWidth: document.body.scrollWidth,' +
    '   docScrollWidth: document.documentElement.scrollWidth,' +
    '   clipped: clipped' +
    ' });' +
    '})()'
  )
}

/** 从设备列表里挑出这一轮需要的两台设备（按 `kind`，绝不按名字或地址猜）。 */
function pickByKind(list) {
  const devices = Array.isArray(list) ? list : []
  return {
    camera: devices.filter((device) => device.kind === 'acousticCamera')[0] || null,
    box: devices.filter((device) => device.kind === 'acousticBox')[0] || null
  }
}

/**
 * 在**临时 profile** 里登记那台真实的声纹设备（`--box-ip` 给了才做）。
 *
 * 为什么必须显式登记：这个探针跑在一次性 profile 里，声纹设备只存在于操作员的真实
 * profile 中。而「改设备名写进设备了吗」「改通道名写进设备了吗」这两个问题**只能**对着
 * 真实设备回答（`setDeviceName` / `updateChannel` 都是设备侧写入）。相机是由探针自己
 * `devices.add` 加进来的，声纹设备同理。
 *
 * 登记之后**不**会去拉它的实时流：那会打扰正在值班的那台设备。这里只做身份读取与
 * （可选的）重命名演练。
 */
async function ensureBox(win) {
  if (BOX_IP === '') return { step: 'not-requested' }
  const source =
    '(async () => { try {' +
    '  const list = await window.api.devices.list();' +
    '  if (!list.success) return JSON.stringify({ step: "list", code: list.error.code });' +
    '  const existing = (list.data || []).filter((d) => d.kind === "acousticBox");' +
    '  if (existing.length > 0) return JSON.stringify({ step: "existing", id: existing[0].id, name: existing[0].name, ip: existing[0].ip });' +
    '  const added = await window.api.devices.add({' +
    '    ip: ' + JSON.stringify(BOX_IP) + ',' +
    '    httpPort: ' + JSON.stringify(BOX_PORT) + ',' +
    '    username: ' + JSON.stringify(BOX_USER) + ',' +
    '    password: ' + JSON.stringify(BOX_PASSWORD) + ',' +
    '    kind: "acousticBox"' +
    '  });' +
    '  if (!added.success) return JSON.stringify({ step: "add", code: added.error.code, message: added.error.message || "" });' +
    '  return JSON.stringify({ step: "added", id: added.data.id, name: added.data.name, ip: added.data.ip });' +
    '} catch (error) {' +
    '  return JSON.stringify({ step: "threw", message: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'ensureBox', source)
  return raw === null ? { step: 'snippet-failed' } : JSON.parse(raw)
}

/** 读一棵树上的行文字。 */
async function readTreeRows(win) {
  return evalJson(win, 'treeRows', treeRowsScript(), { found: false })
}

/**
 * 本轮：设备管理页（`/devices`）—— 树的左列/间距、相机行不带地址、右键菜单。
 *
 * 为什么这些必须在真实窗口里量：`/devices` 是唯一一个「树在左、卡片在右」的页面，而
 * 「靠左、和总览保持一致」是一句**几何**结论；「相机的地址不在树上」是一句**渲染结
 * 果**（模板插值、title、aria-label 任何一处漏了都会让地址出现在屏幕上）。两者都无法
 * 从源码读出来。
 */
async function measureDevicesRoute(win, camera, box) {
  log('--- /devices：树、右键菜单、重命名 ---')

  const rows = await readTreeRows(win)
  log('tree rows     : ' + JSON.stringify(rows))
  if (!rows.found) {
    problems.push('设备管理页没有渲染设备树（.device-tree）')
    return
  }

  const deviceRows = rows.rows.filter((row) => row.kind === 'device')
  const cameraRow = deviceRows.filter((row) => row.meta === '声学相机')[0] || null
  const boxRow = deviceRows.filter((row) => row.meta === '声纹设备')[0] || null

  /**
   * 相机的地址**不能出现在树上**。
   *
   * 判据是这一行的**全部可见文字**与那个 `title`：地址可能被藏在标签里、也可能被藏在
   * tooltip 里，两种都会让操作员看到它。`ip` 取自设备列表（真机上是
   * `192.168.110.235`），所以这一条对着的是真实的那个数字，不是猜的。
   */
  if (!cameraRow) {
    problems.push('设备树上没有相机行（设备列表里有一台相机，树上却没有）：' + JSON.stringify(deviceRows))
  } else {
    log('camera row    : ' + JSON.stringify(cameraRow.row || cameraRow))
    log('camera row text: ' + JSON.stringify(cameraRow.text))
    if (camera.ip && cameraRow.text.includes(camera.ip)) {
      problems.push('相机的地址出现在树的相机行上：' + JSON.stringify(cameraRow.text))
    }
    if (camera.ip && (cameraRow.title || '').includes(camera.ip)) {
      problems.push('相机的地址出现在相机行的 title 上：' + JSON.stringify(cameraRow.title))
    }
    // 相机只有那一路视频叶子，而它是**设备行的子节点**：设备行收起时它不渲染。
    // 所以「叶子在不在」是展开状态，不是这一轮的结论；这里只记录。
    const streamRow = (rows.rows || []).filter((row) => row.kind === 'stream')[0] || null
    log('camera stream : ' + JSON.stringify(streamRow))
    // 相机的**名字**：操作员没起名字时数据库里那行就是 `Acoustic Camera <ip>`，树上
    // 显示的是本地语言的家族名 —— 那正是「地址不进树」的表现，不是丢了名字。
    const nameWithoutIp = camera.name.replace(camera.ip, '').trim()
    if (nameWithoutIp === '' || nameWithoutIp === 'Acoustic Camera') {
      log('camera row    : 设备名本身就是由地址推出来的（' + JSON.stringify(camera.name) +
        '），树上显示为 ' + JSON.stringify(cameraRow.text) + '（对的）')
    } else if (!cameraRow.text.includes(nameWithoutIp)) {
      problems.push('相机行没有显示操作员给的设备名 ' + JSON.stringify(nameWithoutIp) +
        '：' + JSON.stringify(cameraRow.text))
    }
  }

  if (!boxRow) {
    /**
     * 这个探针跑在自己的**临时 profile** 里，而声纹设备是操作员在真实 profile 里登记的；
     * 只有相机是这个探针自己 `devices.add` 加进来的。所以「没有声纹设备行」是**本次运行
     * 的前置条件不成立**，不是这一页的缺陷 —— 关于声纹设备行与通道的结论由
     * `scripts/demo-shot.cjs` 那一次（真实 profile，两台设备都在）承担。
     */
    log('box row       : 未验证 — 本次运行的临时 profile 里没有声纹设备（只有相机），' +
      '声纹设备行与通道行由 demo-shot 那一次负责')
  } else {
    log('box row       : ' + JSON.stringify(boxRow))
    log('box row text  : ' + JSON.stringify(boxRow.text))
    if (box.name && !boxRow.text.includes(box.name)) {
      // 箱子不是相机，地址规则不适用于它：它的名字必须原样显示。
      problems.push('声纹设备行没有显示设备名 ' + JSON.stringify(box.name) + '：' + JSON.stringify(boxRow.text))
    }
  }

  // --- 右键：设备行与通道行都真的能弹出菜单 ------------------------------
  const deviceClick = await evalJson(win, 'treeRightClickDevice', treeRightClickScript('device'), {
    found: false
  })
  log('right-click   : device row -> ' + JSON.stringify(deviceClick))
  if (!deviceClick.found) {
    problems.push('设备行上找不到可以右键的行：' + JSON.stringify(deviceClick))
  } else {
    await sleep(400)
    const menu = await probeMenu(win)
    log('device menu   : ' + JSON.stringify(menu))
    if (!menu.open) {
      problems.push('在设备行上右键没有打开菜单')
    } else {
      const labels = (menu.items || []).map((item) => item.label)
      if (labels.indexOf('修改设备名称') === -1) {
        problems.push('设备行的右键菜单里没有「修改设备名称」：' + JSON.stringify(labels))
      }
      const clickable = (menu.items || []).filter((item) => !item.disabled)
      if (clickable.length === 0) {
        problems.push('设备行的右键菜单里没有任何可点的项：' + JSON.stringify(menu.items))
      }
      if (menu.role !== 'menu') {
        problems.push('设备行的右键菜单没有 role=menu：' + menu.role)
      }
    }
    const dismissed = await evalJson(win, 'dismissMenu', dismissMenuScript(), {})
    log('menu dismiss  : ' + JSON.stringify(dismissed))
  }

  const channelClick = await evalJson(win, 'treeRightClickChannel', treeRightClickScript('channel'), {
    found: false
  })
  log('right-click   : channel row -> ' + JSON.stringify(channelClick))
  if (!channelClick.found) {
    // 通道行的前提是「通道表已经读到并且这一路有名字」；没读到就不是这一轮的失败。
    log('right-click   : 通道行不存在（通道表还没读到或这一路没有名字），通道菜单未验证')
  } else {
    await sleep(400)
    const menu = await probeMenu(win)
    log('channel menu  : ' + JSON.stringify(menu))
    if (!menu.open) {
      problems.push('在通道行上右键没有打开菜单')
    } else {
      const labels = (menu.items || []).map((item) => item.label)
      if (labels.indexOf('修改通道名称') === -1) {
        problems.push('通道行的右键菜单里没有「修改通道名称」：' + JSON.stringify(labels))
      }
    }
    await evalJson(win, 'dismissMenu2', dismissMenuScript(), {})
  }

  // --- 四档窗口尺寸下的几何 ----------------------------------------------
  const measured = []
  for (const size of DEVICE_TREE_SIZES) {
    win.setContentSize(size[0], size[1])
    await sleep(700)
    const geometry = await evalJson(win, 'treeGeometry', treeGeometryScript(), { found: false })
    measured.push({ size: size, geometry: geometry })
    log('/devices ' + size[0] + 'x' + size[1] + ' : ' + JSON.stringify(geometry))
  }
  win.setContentSize(1440, 900)
  await sleep(600)

  const found = measured.filter((entry) => entry.geometry.found)
  if (found.length !== DEVICE_TREE_SIZES.length) {
    problems.push('/devices 的树几何只量到 ' + found.length + ' / ' + DEVICE_TREE_SIZES.length + ' 档')
  }
  for (const entry of measured) {
    const g = entry.geometry
    if (!g.found) continue
    if (g.viewport.w !== entry.size[0] || g.viewport.h !== entry.size[1]) {
      problems.push('/devices：请求 ' + entry.size[0] + 'x' + entry.size[1] + '，渲染层报回来 ' +
        g.viewport.w + 'x' + g.viewport.h)
    }
    // 「和总览保持一致」= `.page` 从内容盒左上角开始（两个页面共用同一条 .page 规则）。
    const pageLeft = g.page.left - g.contentBox.left
    const pageTop = g.page.top - g.contentBox.top
    if (pageLeft > 1 || pageTop > 1) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] +
        ' 的 .page 没有从内容盒左上角开始：' + pageLeft + 'px / ' + pageTop + 'px')
    }
    if (g.gapFromContentBoxPx.left > 1) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] +
        ' 树没贴住内容盒左边：' + g.gapFromContentBoxPx.left + 'px')
    }
    if (g.gapFromContentBoxPx.top <= 0 || g.gapFromContentBoxPx.top > 120) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] +
        ' 树的上间距不是布局给的：' + g.gapFromContentBoxPx.top + 'px')
    }
    if (!g.firstChildIsCard) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] + ' 拓扑不是左列第一个子元素')
    }
    if (g.clipped.length > 0) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] + ' 有被裁掉的控件：' +
        JSON.stringify(g.clipped))
    }
    if (g.contentScrollWidth > g.contentClientWidth + 1 ||
        g.bodyScrollWidth > g.windowInnerWidth + 1 ||
        g.docScrollWidth > g.windowInnerWidth + 1) {
      problems.push('/devices 在 ' + entry.size[0] + 'x' + entry.size[1] + ' 有横向溢出：内容区 ' +
        g.contentScrollWidth + '/' + g.contentClientWidth + '，body ' + g.bodyScrollWidth +
        '，document ' + g.docScrollWidth + '，窗口 ' + g.windowInnerWidth)
    }
  }
  const lefts = found.map((entry) => entry.geometry.gapFromContentBoxPx.left)
  const tops = found.map((entry) => entry.geometry.gapFromContentBoxPx.top)
  if (new Set(lefts).size > 1 || new Set(tops).size > 1) {
    problems.push('/devices 相对内容盒的位置在四档尺寸下不是同一个数：left=' + JSON.stringify(lefts) +
      ' top=' + JSON.stringify(tops))
  }
  const pageLefts = found.map((entry) => entry.geometry.page.left - entry.geometry.contentBox.left)
  const pageTops = found.map((entry) => entry.geometry.page.top - entry.geometry.contentBox.top)
  if (new Set(pageLefts).size > 1 || new Set(pageTops).size > 1) {
    problems.push('/devices 的 .page 相对内容盒的位置在四档尺寸下不是同一个数：left=' +
      JSON.stringify(pageLefts) + ' top=' + JSON.stringify(pageTops))
  }
  const cardWidths = found.map((entry) => entry.geometry.card.width)
  if (new Set(cardWidths).size > 1) {
    problems.push('/devices 左列宽度在四档尺寸下变了：' + JSON.stringify(cardWidths))
  }
  const pageWidths = found.map((entry) => entry.geometry.page.width)
  for (let i = 1; i < pageWidths.length; i += 1) {
    if (!(pageWidths[i] > pageWidths[i - 1])) {
      problems.push('/devices 的内容列没有随窗口变宽：' + JSON.stringify(pageWidths))
      break
    }
  }
  log('/devices gaps : .page left=' + JSON.stringify(pageLefts) + ' top=' + JSON.stringify(pageTops) +
    '; card left=' + JSON.stringify(lefts) + ' top=' + JSON.stringify(tops) +
    ' cardWidths=' + JSON.stringify(cardWidths) + ' pageWidths=' + JSON.stringify(pageWidths))
}

/**
 * 通过**真正的界面路径**改一次名字：右键设备行 → 点菜单项 → 在对话框里填新名字 → 保存。
 *
 * 为什么不用 IPC 直接写：`devices.update` 绕过渲染层的 Pinia store，界面上的树会继续
 * 显示旧名字 —— 那是探针自己造出来的假问题。而这条界面路径同时证明了四件事：右键菜单
 * 真的打开、菜单项真的可点、对话框真的出现、保存之后树**真的**换字。
 *
 * 菜单项与按钮按**渲染出来的文字**匹配：硬编码的是目录里那两句（`修改设备名称` /
 * `common.save` 的中文），所以界面一旦少了一项或者文字没渲染出来，这里会立刻失败。
 *
 * `options`：
 *   - `which` / `nodeId`：右键哪一行（`'device'` / `'channel'` + `data-node-id`）。
 *     多台设备时按「第一台设备行」会点错对象，所以默认按 id **精确**选。
 *   - `menuLabel`：点菜单里的哪一项（`修改设备名称` / `修改通道名称`）。
 *   - `settleTimeoutMs`：等这次保存落定的上限。
 *
 * 返回值里的 `settled` 是这次保存的**结局**：`'closed'`（成功，对话框关掉）、
 * `'error'`（失败，对话框留着并显示错误文字）、`'timeout'`（两者都没等到）。
 */
async function renameThroughUi(win, deviceId, newName, options) {
  const settings = options || {}
  const which = settings.which || 'device'
  const nodeId = settings.nodeId || (which + ':' + deviceId)
  const menuLabel = settings.menuLabel || '修改设备名称'
  // 1) 右键那一行（按 data-node-id 精确选：树上有相机与声纹设备两台时，
  //    「第一台设备行」会点错对象）。
  const clicked = await evalJson(win, 'uiRenameRightClick', treeRightClickScript(which, nodeId), { found: false })
  if (!clicked.found) return { ok: false, step: 'right-click', nodeId: nodeId, detail: clicked }
  await sleep(400)
  // 2) 菜单项必须存在且可点。
  const menu = await probeMenu(win)
  if (!menu.open) return { ok: false, step: 'menu-open', detail: menu }
  const item = (menu.items || []).filter((entry) => entry.label === menuLabel)[0] || null
  if (!item) return { ok: false, step: 'menu-item', labels: (menu.items || []).map((e) => e.label) }
  if (item.disabled) return { ok: false, step: 'menu-item-disabled', detail: item }
  // 3) 点它，然后填对话框。
  const opened = await evalJson(win, 'uiRenameOpenDialog', clickMenuLabelScript(menuLabel), {
    clicked: false
  })
  await sleep(500)
  const filled = await evalJson(win, 'uiRenameFill', fillRenameDialogScript(newName), { ok: false })
  if (!filled.ok) return { ok: false, step: 'fill', detail: filled, opened: opened }
  const saved = await evalJson(win, 'uiRenameSave', clickRenameSaveScript(), { clicked: false })
  if (!saved.clicked) return { ok: false, step: 'save', detail: saved, filled: filled }
  // 保存是异步的：等它落定（对话框关掉 = 成功；出现错误文字 = 失败）。
  const settled = await waitForRenameSettled(win, settings.settleTimeoutMs)
  return {
    ok: settled.settled !== 'timeout',
    step: 'saved',
    settled: settled.settled,
    state: settled.state,
    clicked: clicked,
    menu: (menu.items || []).map((e) => e.label),
    filled: filled
  }
}

/** 点菜单里那一项（按渲染出来的标签）。 */
function clickMenuLabelScript(label) {
  return (
    '(() => {' +
    ' const menu = document.querySelector(".vmenu");' +
    ' if (!menu) return JSON.stringify({ clicked: false, reason: "no menu" });' +
    ' const labelOf = (item) => {' +
    '   const el = item.querySelector(".vmenu__label");' +
    '   if (!el) return "";' +
    '   let out = "";' +
    '   Array.prototype.slice.call(el.childNodes).forEach((node) => {' +
    '     if (node.nodeType === 3) out += node.nodeValue || "";' +
    '   });' +
    '   return out.replace(/\\s+/g, " ").trim();' +
    ' };' +
    ' const items = Array.prototype.slice.call(menu.querySelectorAll(":scope > button.vmenu__item"));' +
    ' const target = items.filter((item) => labelOf(item) === ' + JSON.stringify(label) + ')[0] || null;' +
    ' if (!target) return JSON.stringify({ clicked: false, reason: "label not found", labels: items.map(labelOf) });' +
    ' target.click();' +
    ' return JSON.stringify({ clicked: true, label: labelOf(target) });' +
    '})()'
  )
}

/** 把重命名对话框里那个输入框填成新名字（走 setter + input 事件，Vue 才看得到）。 */
function fillRenameDialogScript(name) {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ ok: false, why: "no dialog" });' +
    ' const panel = panels[panels.length - 1];' +
    ' const input = panel.querySelector("input[type=text]");' +
    ' if (!input) return JSON.stringify({ ok: false, why: "no text input",' +
    '   body: (panel.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200) });' +
    ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    ' setter.call(input, ' + JSON.stringify(name) + ');' +
    ' input.dispatchEvent(new Event("input", { bubbles: true }));' +
    ' return JSON.stringify({ ok: true, value: input.value,' +
    '   title: (panel.querySelector(".panel__title") || {}).textContent || "",' +
    '   hint: (panel.querySelector(".rename-form__hint") || {}).textContent || "" });' +
    '})()'
  )
}

/** 点对话框页脚里的「保存」（按渲染出来的文字，避免点错按钮）。 */
function clickRenameSaveScript() {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ clicked: false, why: "no dialog" });' +
    ' const panel = panels[panels.length - 1];' +
    ' const footer = panel.querySelector(".panel__footer");' +
    ' const buttons = Array.prototype.slice.call((footer || panel).querySelectorAll("button"));' +
    ' const save = buttons.filter((b) => (b.textContent || "").trim() === "保存")[0] || null;' +
    ' if (!save) return JSON.stringify({ clicked: false, why: "no save button",' +
    '   labels: buttons.map((b) => (b.textContent || "").trim()) });' +
    ' if (save.disabled) return JSON.stringify({ clicked: false, why: "save is disabled" });' +
    ' save.click();' +
    ' return JSON.stringify({ clicked: true });' +
    '})()'
  )
}

/** 对话框此刻还开着吗？错误文字是什么？（保存之后用来判断成败。） */
function renameDialogStateScript() {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ open: false });' +
    ' const panel = panels[panels.length - 1];' +
    ' const input = panel.querySelector("input[type=text]");' +
    ' return JSON.stringify({ open: true, value: input ? input.value : null,' +
    '   error: (panel.querySelector(".alert") || {}).textContent || "" });' +
    '})()'
  )
}

/**
 * 等这次保存**落定**。
 *
 * 判据只有两条：对话框**关掉**了（成功），或者里面出现了**错误文字**（失败）。
 *
 * 为什么必须等（这一条是踩过的坑）：`button.click()` 只是派发一次点击，真正的写入是
 * 异步的 —— 一次 IPC 往返、一次设备 HTTP 往返、失败时还要回滚本机那一半。点完立刻读
 * 对话框 / 树 / 设备，读到的是「还没写」的状态，于是探针会报出一串**自己造出来的**失败
 * （第一次跑就是这样：设备上其实已经改名成功，探针却读到旧值）。
 */
async function waitForRenameSettled(win, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000)
  let last = { open: true }
  while (Date.now() < deadline) {
    last = await evalJson(win, 'uiRenameSettled', renameDialogStateScript(), { open: true })
    if (!last.open) return { settled: 'closed', state: last }
    if (last.error && String(last.error).trim() !== '') return { settled: 'error', state: last }
    await sleep(300)
  }
  return { settled: 'timeout', state: last }
}

// ---------------------------------------------------------------------------
// 这一轮新增：**走真实界面**的箱子改名 / 通道改名，以及失败回滚
// ---------------------------------------------------------------------------

/**
 * 声纹设备改名：**走界面**（右键箱子行 → 修改设备名称 → 填 → 保存），再改回来。
 *
 * 为什么必须再走一遍界面：`renameDeviceScript()`（上面那条）证明的是「写入链路的落点与
 * 读回」，走的是 IPC。而操作员真正会走的是**对话框**那条路 —— 右键的那一行是不是这台
 * 设备、菜单项在不在、保存之后对话框关不关、树**真的**换成新字、成功提示说的是什么，
 * 这四件事只有驱动界面才能回答。第 5 项（失败之后本机是否回滚）由
 * `exerciseRenameRollback()` 单独证明。
 */
async function exerciseBoxRenameUi(win, box) {
  log('--- 声纹设备改名：真实界面（右键 → 修改设备名称 → 保存）---')

  const infoBefore = await evalJson(win, 'boxUiInfoBefore', deviceInfoScript(box.id), { ok: false })
  const rowBefore = await evalJson(win, 'boxUiRowBefore', deviceRowScript(box.id), { ok: false })
  log('box ui before : device=' + JSON.stringify(infoBefore) + ' local=' + JSON.stringify(rowBefore))
  const deviceName = infoBefore.ok && infoBefore.info ? infoBefore.info.name : ''
  if (!deviceName) {
    log('box ui rename : 未验证 — get_devinfo 没有给出设备名，界面改名无法验证')
    return
  }

  const tempName = 'HZ 界面验证 ' + Date.now().toString().slice(-6)
  const step = await renameThroughUi(win, box.id, tempName)
  log('box ui rename : ' + JSON.stringify(step) + ' menu=' + JSON.stringify(step.menu))
  if (!step.ok) {
    problems.push('声纹设备的界面改名没有走通（' + step.step + '）：' + JSON.stringify(step))
    return
  }
  const filled = step.filled || {}
  log('box ui dialog : 标题=' + JSON.stringify(filled.title) + ' 说明=' + JSON.stringify(filled.hint))
  // 箱子那一句必须说「同时写入本机与设备」（与相机的「只保存本机」分开）。
  if (!/设备自身|本机数据库/.test(String(filled.hint))) {
    problems.push('箱子改名对话框没说清名字写到哪两处：' + JSON.stringify(filled.hint))
  }

  log('box ui settle : ' + JSON.stringify(step.state))
  if (step.settled !== 'closed') {
    problems.push('箱子改名保存之后对话框没有落到「已关闭」（settled=' + step.settled + '）：' +
      JSON.stringify(step.state))
  }

  const notice = await evalJson(win, 'boxUiNotice', noticeScript(), { text: '' })
  log('box ui notice : ' + JSON.stringify(notice))
  if (!notice.text.includes(tempName) || !/设备自身/.test(notice.text)) {
    problems.push('箱子改名的成功提示没说清「已写入设备自身」或没带新名字：' + JSON.stringify(notice.text))
  }

  // 权威判据：**重读设备**（`get_devinfo`），不是看提示。
  const infoAfter = await evalJson(win, 'boxUiInfoAfter', deviceInfoScript(box.id), { ok: false })
  log('box ui device : ' + JSON.stringify(infoAfter))
  if (!infoAfter.ok || !infoAfter.info || infoAfter.info.name !== tempName) {
    problems.push('界面改名报成成功，但重读设备的 devname 不是新值：期望 ' + JSON.stringify(tempName) +
      '，得到 ' + JSON.stringify(infoAfter))
  }
  const rowsAfter = await readTreeRows(win)
  const boxRowAfter = (rowsAfter.rows || []).filter((row) => row.node === 'device:' + box.id)[0] || null
  log('box ui tree   : ' + JSON.stringify(boxRowAfter))
  if (!boxRowAfter || !boxRowAfter.text.includes(tempName)) {
    problems.push('界面改名之后树上的箱子行没有显示新名字：' + JSON.stringify(boxRowAfter))
  }

  // 恢复：走**同一条界面路径**（恢复也必须是操作员真正会走的那条路）。
  const restore = await renameThroughUi(win, box.id, deviceName)
  log('box ui restore: ' + JSON.stringify(restore))
  if (!restore.ok) {
    problems.push('箱子改名的界面恢复没有走通（' + restore.step + '）：' + JSON.stringify(restore))
  }
  const infoRestored = await evalJson(win, 'boxUiInfoRestored', deviceInfoScript(box.id), { ok: false })
  const rowRestored = await evalJson(win, 'boxUiRowRestored', deviceRowScript(box.id), { ok: false })
  log('box ui final  : device=' + JSON.stringify(infoRestored) + ' local=' + JSON.stringify(rowRestored))
  if (!infoRestored.ok || !infoRestored.info || infoRestored.info.name !== deviceName) {
    problems.push('箱子设备名恢复后读回不是原值：期望 ' + JSON.stringify(deviceName) +
      '，得到 ' + JSON.stringify(infoRestored))
  }
  const rowsRestored = await readTreeRows(win)
  const boxRowRestored = (rowsRestored.rows || []).filter((row) => row.node === 'device:' + box.id)[0] || null
  if (!boxRowRestored || !boxRowRestored.text.includes(deviceName)) {
    problems.push('恢复之后树上的箱子行没有回到原名：' + JSON.stringify(boxRowRestored))
  }
}

/**
 * 通道改名：**走界面**（右键通道行 → 修改通道名称 → 填 → 保存），再改回来。
 *
 * 读回的权威来源是 `GET /get_passageway`（`config.getChannels`），而且是**整张表**：
 * 「其余 7 行逐字节不变」这句话只有对着整张表比较才算证明。
 */
async function exerciseChannelRenameUi(win, box, target) {
  log('--- 通道改名：真实界面（右键通道行 → 修改通道名称 → 保存）---')
  if (!target) {
    log('channel ui    : 未验证 — 设备没有上报任何通道')
    return
  }
  const before = await evalJson(win, 'channelUiBefore', deviceChannelsScript(box.id), { ok: false })
  log('channel ui bef: ' + JSON.stringify(before))
  const baseline = before.ok ? before.channels || [] : []
  const original = target.name || ''
  const tempName = 'HZ 通道界面验证 ' + Date.now().toString().slice(-6)
  const nodeId = 'channel:' + box.id + ':' + target.channelIndex

  const step = await renameThroughUi(win, box.id, tempName, {
    which: 'channel',
    nodeId: nodeId,
    menuLabel: '修改通道名称'
  })
  log('channel ui    : ' + JSON.stringify(step) + ' menu=' + JSON.stringify(step.menu))
  if (!step.ok) {
    problems.push('通道的界面改名没有走通（' + step.step + '）：' + JSON.stringify(step))
    return
  }
  const filled = step.filled || {}
  log('channel ui dlg: 标题=' + JSON.stringify(filled.title) + ' 说明=' + JSON.stringify(filled.hint))
  if (!/声纹设备/.test(String(filled.hint))) {
    problems.push('通道改名对话框没说清名字写在设备上：' + JSON.stringify(filled.hint))
  }
  log('channel ui stl: ' + JSON.stringify(step.state))
  if (step.settled !== 'closed') {
    problems.push('通道改名保存之后对话框没有落到「已关闭」（settled=' + step.settled + '）：' +
      JSON.stringify(step.state))
  }
  const notice = await evalJson(win, 'channelUiNotice', noticeScript(), { text: '' })
  log('channel ui not: ' + JSON.stringify(notice))
  if (!notice.text.includes(tempName)) {
    problems.push('通道改名的成功提示里没有新名字：' + JSON.stringify(notice.text))
  }

  // 权威判据：重读**整张**通道表。
  const afterDevice = await evalJson(win, 'channelUiAfter', deviceChannelsScript(box.id), { ok: false })
  log('channel ui dev: ' + JSON.stringify(afterDevice))
  const rows = afterDevice.ok ? afterDevice.channels || [] : []
  const edited = rows.filter((row) => row.channelIndex === target.channelIndex)[0] || null
  if (!edited || edited.name !== tempName) {
    problems.push('界面改名报成成功，但重读设备的通道名不是新值：期望 ' + JSON.stringify(tempName) +
      '，得到 ' + JSON.stringify(edited))
  }
  // 其余行必须逐字节不变（单行写入**不得**清空/改动其它通道）。
  const others = rows.filter((row) => row.channelIndex !== target.channelIndex)
  const othersBefore = baseline.filter((row) => row.channelIndex !== target.channelIndex)
  if (JSON.stringify(others) !== JSON.stringify(othersBefore)) {
    problems.push('改一路通道名之后，其余通道变了：before=' + JSON.stringify(othersBefore) +
      ' after=' + JSON.stringify(others))
  } else {
    log('channel ui dev: 其余 ' + others.length + ' 路逐字节不变')
  }
  const treeRows = await readTreeRows(win)
  const treeRow = (treeRows.rows || []).filter((row) => row.node === nodeId)[0] || null
  log('channel ui tree: ' + JSON.stringify(treeRow))
  if (!treeRow || treeRow.channelName !== tempName) {
    problems.push('界面改名之后树上的通道行没有显示新名字：' + JSON.stringify(treeRow))
  }

  // 恢复 + 读回整张表与基线一致。
  const restore = await renameThroughUi(win, box.id, original, {
    which: 'channel',
    nodeId: nodeId,
    menuLabel: '修改通道名称'
  })
  log('channel ui res: ' + JSON.stringify(restore))
  if (!restore.ok) {
    problems.push('通道改名的界面恢复没有走通（' + restore.step + '）：' + JSON.stringify(restore))
  }
  const finalDevice = await evalJson(win, 'channelUiFinal', deviceChannelsScript(box.id), { ok: false })
  log('channel ui fin: ' + JSON.stringify(finalDevice))
  const finalRows = finalDevice.ok ? finalDevice.channels || [] : []
  if (JSON.stringify(finalRows) !== JSON.stringify(baseline)) {
    problems.push('通道表恢复后与基线不一致：baseline=' + JSON.stringify(baseline) +
      ' final=' + JSON.stringify(finalRows))
  }
}

/**
 * 回滚：设备侧写入**失败**时，本机那一半必须回到原名。
 *
 * 怎么把失败造出来（诚实地说清）：把这一行登记在**一个关着的端口**上
 * （`httpPort: 9`，地址仍是那台真机）。`clientFor()` 会因此重建一个指向该端口的客户端，
 * 设备侧写入必然连不上 —— 而那个端口后面没有任何服务，所以**没有一个字节发到真机上**。
 * 端口在探针结束时恢复原值，并读回证明。
 *
 * 四件事分开断言，因为它们会各自出错：
 *   1. 对话框**留着**（一次失败的写入不能看起来像成功）；
 *   2. 提示文字说明「本机名称已恢复为原名」（这一轮新加的那句话）；
 *   3. 本机数据库那一行**真的**回到了原名（权威判据）；
 *   4. 树上不显示那个测试名字。
 */
async function exerciseRenameRollback(win, box) {
  log('--- 回滚：设备侧写入失败时本机必须恢复原名 ---')

  const rowBefore = await evalJson(win, 'rbRowBefore', deviceRowScript(box.id), { ok: false })
  log('rollback bef  : ' + JSON.stringify(rowBefore))
  const originalName = rowBefore.ok && rowBefore.row ? rowBefore.row.name : ''
  const originalPort = rowBefore.ok && rowBefore.row ? rowBefore.row.httpPort : undefined
  if (!originalName) {
    log('rollback      : 未验证 — 本机没有这台设备的那一行')
    return
  }

  const pointed = await evalJson(
    win,
    'rbClosedPort',
    updateDeviceRowScript(box.id, { httpPort: 9 }),
    { ok: false }
  )
  log('rollback port : 把这一行指向关着的端口 9 -> ' + JSON.stringify(pointed))
  if (!pointed.ok) {
    problems.push('回滚探针无法把设备行指向关着的端口：' + JSON.stringify(pointed))
    return
  }

  const tempName = 'HZ 回滚验证 ' + Date.now().toString().slice(-6)
  const ui = await renameThroughUi(win, box.id, tempName)
  log('rollback ui   : ' + JSON.stringify(ui))
  if (!ui.ok) {
    problems.push('回滚探针的界面路径没有走通（' + ui.step + '）：' + JSON.stringify(ui))
  } else {
    // 失败时对话框必须**留着**，而且错误文字必须是那条「本机已恢复原名」。
    log('rollback dlg  : ' + JSON.stringify(ui.state))
    if (ui.settled !== 'error') {
      problems.push('设备侧写入失败时对话框没有停下来报错（settled=' + ui.settled + '）：' +
        JSON.stringify(ui.state))
    }
    const message = String((ui.state && ui.state.error) || '')
    if (!message.includes(originalName) || !/恢复/.test(message)) {
      problems.push('失败提示没有说清「本机名称已恢复为原名」：' + JSON.stringify(message))
    }
  }

  // 权威判据：本机数据库那一行。
  const rowAfter = await evalJson(win, 'rbRowAfter', deviceRowScript(box.id), { ok: false })
  log('rollback local: ' + JSON.stringify(rowAfter))
  if (!rowAfter.ok || !rowAfter.row || rowAfter.row.name !== originalName) {
    problems.push('设备侧写入失败之后，本机那一行没有回到原名：期望 ' + JSON.stringify(originalName) +
      '，得到 ' + JSON.stringify(rowAfter))
  }
  const rows = await readTreeRows(win)
  const treeRow = (rows.rows || []).filter((row) => row.node === 'device:' + box.id)[0] || null
  log('rollback tree : ' + JSON.stringify(treeRow))
  if (treeRow && treeRow.text.includes(tempName)) {
    problems.push('回滚之后树上仍然显示那个测试名字：' + JSON.stringify(treeRow))
  }
  if (treeRow && !treeRow.text.includes(originalName)) {
    problems.push('回滚之后树上没有显示原名：' + JSON.stringify(treeRow))
  }

  // 设备侧的名字必须一个字都没变（写入根本没到设备）。
  const info = await evalJson(win, 'rbInfo', deviceInfoScript(box.id), { ok: false })
  log('rollback dev  : ' + JSON.stringify(info))

  // 关掉那个留着错误的对话框，别让后面的探针撞上它。
  const closed = await closeDialogByCancel(win, '取消')
  log('rollback close: ' + JSON.stringify(closed))
  const stillOpen = await evalJson(win, 'rbAfterClose', renameDialogStateScript(), { open: true })
  if (stillOpen.open) {
    problems.push('回滚探针结束时那个对话框没关掉：' + JSON.stringify(stillOpen))
  }

  // 恢复端口，并读回证明。
  const restored = await evalJson(
    win,
    'rbRestorePort',
    updateDeviceRowScript(box.id, { httpPort: originalPort === undefined ? 80 : originalPort }),
    { ok: false }
  )
  const verified = await evalJson(win, 'rbPortReadBack', deviceRowScript(box.id), { ok: false })
  log('rollback portR: ' + JSON.stringify(restored) + ' readBack ' + JSON.stringify(verified))
  if (!restored.ok || !verified.ok || !verified.row ||
      verified.row.httpPort !== originalPort || verified.row.name !== originalName) {
    problems.push('回滚探针没有把设备行恢复原样：期望 ' +
      JSON.stringify({ name: originalName, httpPort: originalPort }) + '，得到 ' +
      JSON.stringify(verified))
  }
}


/**
 * 本轮：**真的**改一次名字，再改回来。
 *
 * 三件事必须靠一次真机写入回答：
 *   1. 声纹设备的设备名是不是**真的**写进了设备（`setDeviceName` 之后重读
 *      `get_devinfo`，看 `devname` 是不是新值）。一次 `ret:200` 不构成证据 —— 设备完全
 *      可能接受请求而忽略字段。
 *   2. 通道名是不是真的写进了设备（`updateChannel` 在主进程里写完会重读设备，返回的
 *      就是设备上的新值）。
 *   3. 相机**没有**设备名端点：`config.setDeviceName` 对相机必须被拒绝，而且拒绝的理由
 *      必须说清是「这台设备没有这个能力」，而不是一句通用的失败。
 *
 * 全部改动都会在最后恢复，并**重读证明恢复成功**：这台机器是产品负责人在用的真机。
 *
 * `drill` 为假时**一个字节都不写设备**：设备名与通道名都只在日志里报成「未验证」，
 * 因为它们是设备侧写入，而这一次运行没有被授权动硬件。
 */
async function exerciseRenames(win, camera, box, drill) {
  log('--- 重命名：真机写入 / 读回 / 恢复 ---')

  if (!box) {
    log('rename        : 未验证 — 设备列表里没有声纹设备，无法演练设备名与通道名' +
      (BOX_IP === '' ? '（本次运行没有给 --box-ip，临时 profile 里不会有它）' : ''))
  } else if (!drill) {
    log('rename        : 未验证 — 没有给 --box-rename-drill，本次运行不写真实设备（设备名与通道名）')
  } else {
    const beforeInfo = await evalJson(win, 'boxInfoBefore', deviceInfoScript(box.id), { ok: false })
    const beforeRow = await evalJson(win, 'boxRowBefore', deviceRowScript(box.id), { ok: false })
    const beforeChannels = await evalJson(win, 'boxChannelsBefore', deviceChannelsScript(box.id), {
      ok: false
    })
    log('box before    : device=' + JSON.stringify(beforeInfo) + ' local=' + JSON.stringify(beforeRow))
    log('box channels  : ' + JSON.stringify(beforeChannels))

    const originalDeviceName =
      beforeInfo.ok && beforeInfo.info ? beforeInfo.info.name : ''
    const originalLocalName = beforeRow.ok && beforeRow.row ? beforeRow.row.name : ''

    // 选一路**启用**的通道（真机上 2~7 路未启用）：改一个正在用的通道，比改一个停用的
    // 通道更能证明写入链路真的通了。
    const channels = beforeChannels.ok ? beforeChannels.channels || [] : []
    const enabled = channels.filter((channel) => channel.enabled === true)
    const target = enabled[0] || channels[0] || null
    log('rename target : ' + JSON.stringify(target) + ' (enabled channels: ' + enabled.length +
      ' of ' + channels.length + ')')

    if (!originalDeviceName) {
      log('rename        : 未验证 — 设备的 get_devinfo 没有给出名字，无法验证设备侧重命名')
    } else {
      const renamedName = 'HZ 重命名验证 ' + Date.now().toString().slice(-6)
      const write = await evalJson(win, 'renameDevice', renameDeviceScript(box.id, renamedName), {
        ok: false
      })
      log('rename write  : ' + JSON.stringify(write))

      if (!write.ok) {
        /**
         * 设备拒绝了改名。**本机那一行已经被 `devices.update` 改过了**（那是这条路径的
         * 第一步），所以这里必须把它恢复回原值 —— 一次失败的写入不能把测试名字留在
         * 操作员的数据库里。恢复走的是同一个 `devices.update`（本机那一半）。
         */
        findings.push('声纹设备**拒绝**了改设备名（设备的原文）：' + JSON.stringify(write))
        if (originalLocalName) {
          const undoLocal = await evalJson(win, 'renameDeviceUndoLocal',
            '(async () => { try {' +
            '  const r = await window.api.devices.update({ id: ' + JSON.stringify(box.id) +
            ', name: ' + JSON.stringify(originalLocalName) + ' });' +
            '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
            '  return JSON.stringify({ ok: true, name: r.data.name });' +
            '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()',
            { ok: false })
          const undoRow = await evalJson(win, 'boxRowUndone', deviceRowScript(box.id), { ok: false })
          log('rename undo   : ' + JSON.stringify(undoLocal) + ' local reads back ' + JSON.stringify(undoRow))
          if (!undoLocal.ok || !undoRow.ok || !undoRow.row || undoRow.row.name !== originalLocalName) {
            problems.push('设备拒绝改名之后，本机那一行没有恢复成原值：期望 ' +
              JSON.stringify(originalLocalName) + '，得到 ' + JSON.stringify(undoRow))
          }
        }
      } else {
        const afterInfo = await evalJson(win, 'boxInfoAfter', deviceInfoScript(box.id), { ok: false })
        const afterRow = await evalJson(win, 'boxRowAfter', deviceRowScript(box.id), { ok: false })
        log('box after     : device=' + JSON.stringify(afterInfo) + ' local=' + JSON.stringify(afterRow))
        // 设备侧读回才是「设备真的改名了吗」的答案。一次 ret:200 不算证据。
        if (!afterInfo.ok || !afterInfo.info || afterInfo.info.name !== renamedName) {
          problems.push('设备侧重命名报成成功但读回不是新值：写入要求 ' + JSON.stringify(renamedName) +
            '，重读 get_devinfo 得到 ' + JSON.stringify(afterInfo))
        }
        const localAfter = afterRow.ok && afterRow.row ? afterRow.row.name : null
        if (localAfter !== renamedName) {
          problems.push('本机数据库的设备名没有更新：期望 ' + JSON.stringify(renamedName) +
            '，得到 ' + JSON.stringify(localAfter))
        }

        // 恢复设备名（走同一条路径：本地 + 设备）。
        const restore = await evalJson(win, 'renameDeviceRestore',
          renameDeviceScript(box.id, originalDeviceName), { ok: false })
        const restoredInfo = await evalJson(win, 'boxInfoRestored', deviceInfoScript(box.id), {
          ok: false
        })
        const restoredRow = await evalJson(win, 'boxRowRestored', deviceRowScript(box.id), {
          ok: false
        })
        log('box restore   : ' + JSON.stringify(restore) + ' device=' + JSON.stringify(restoredInfo) +
          ' local=' + JSON.stringify(restoredRow))
        if (!restore.ok) problems.push('设备名恢复失败：' + JSON.stringify(restore))
        if (!restoredInfo.ok || !restoredInfo.info || restoredInfo.info.name !== originalDeviceName) {
          problems.push('设备名恢复后读回不是原值：期望 ' + JSON.stringify(originalDeviceName) +
            '，得到 ' + JSON.stringify(restoredInfo))
        }
        if (originalLocalName &&
            (!restoredRow.ok || !restoredRow.row || restoredRow.row.name !== originalLocalName)) {
          problems.push('本机设备名恢复后读回不是原值：期望 ' + JSON.stringify(originalLocalName) +
            '，得到 ' + JSON.stringify(restoredRow))
        }
      }
    }

    if (!target) {
      log('rename channel: 未验证 — 设备没有上报任何通道')
    } else {
      const originalChannelName = target.name || ''
      const renamedChannel = 'CHAN 验证 ' + Date.now().toString().slice(-6)
      const write = await evalJson(win, 'renameChannel',
        renameChannelScript(box.id, target.channelIndex, renamedChannel), { ok: false })
      log('channel write : ' + JSON.stringify(write))
      if (!write.ok) {
        /**
         * 设备拒绝了这次写。**不能**把「设备拒绝」说成「探针失败」：这一条要如实报出
         * 设备自己的原文，因为它是「改通道名在这台设备上到底能不能做」的唯一答案。
         * 而且因为整个对象都被拒绝，设备的通道名根本没有变（下面读回证明这一点），
         * 所以不存在「需要恢复」的状态。
         */
        findings.push('通道重命名被设备**拒绝**（设备的原文，这是本轮的实测结论）：' +
          JSON.stringify(write))
        const afterChannels = await evalJson(win, 'boxChannelsAfterReject',
          deviceChannelsScript(box.id), { ok: false })
        const stillThere = afterChannels.ok
          ? (afterChannels.channels || []).filter((c) => c.channelIndex === target.channelIndex)[0] || null
          : null
        log('channel after : ' + JSON.stringify(stillThere))
        if (!stillThere || stillThere.name !== originalChannelName) {
          problems.push('设备拒绝了通道写入，但通道名却变了（这说明写入是部分生效的）：期望 ' +
            JSON.stringify(originalChannelName) + '，得到 ' + JSON.stringify(stillThere))
        } else {
          log('channel after : 设备没有改动通道名（' + JSON.stringify(originalChannelName) +
            '），无需恢复')
        }
      } else {
        if (!write.readBack || write.readBack.name !== renamedChannel) {
          problems.push('通道重命名报成成功但重读设备的值不是新值：' + JSON.stringify(write))
        }
        const restore = await evalJson(win, 'renameChannelRestore',
          renameChannelScript(box.id, target.channelIndex, originalChannelName), { ok: false })
        log('channel restore: ' + JSON.stringify(restore))
        if (!restore.ok || !restore.readBack || restore.readBack.name !== originalChannelName) {
          problems.push('通道名恢复后读回不是原值：期望 ' + JSON.stringify(originalChannelName) +
            '，得到 ' + JSON.stringify(restore))
        }
      }
      // 树上的通道名必须与设备上的一致（不管写入成功还是被拒绝）。
      const rowsAfter = await readTreeRows(win)
      const channelRow = (rowsAfter.rows || []).filter((row) =>
        row.node === 'channel:' + box.id + ':' + target.channelIndex)[0] || null
      log('channel row   : ' + JSON.stringify(channelRow))
      if (channelRow && write.ok && channelRow.channelName !== originalChannelName) {
        problems.push('树上那一行通道名没有恢复到原值：' + JSON.stringify(channelRow))
      }
      // 树的通道行文字必须与设备侧读回一致：界面不能自己编一个名字。
      const deviceChannelsNow = await evalJson(win, 'boxChannelsNow', deviceChannelsScript(box.id), {
        ok: false
      })
      const deviceChannel = deviceChannelsNow.ok
        ? (deviceChannelsNow.channels || []).filter((c) => c.channelIndex === target.channelIndex)[0] || null
        : null
      if (channelRow && deviceChannel && channelRow.channelName !== deviceChannel.name) {
        problems.push('树上的通道名与设备上的不一致：树=' + JSON.stringify(channelRow.channelName) +
          ' 设备=' + JSON.stringify(deviceChannel.name))
      }
    }

    /**
     * 上面两条走的是 IPC。**操作员走的是界面**，所以这一轮再走一遍真正的界面路径：
     * 右键 → 菜单项 → 对话框 → 保存，并读回树与设备。
     *
     * 顺序：箱子改名 → 通道改名 → 回滚（回滚会把这一行指向一个关着的端口，所以放最后，
     * 并且结束前恢复端口并读回）。
     */
    await exerciseBoxRenameUi(win, box)
    await exerciseChannelRenameUi(win, box, target)
    await exerciseRenameRollback(win, box)
  }

  /**
   * 相机：设备名端点**不存在**。
   *
   * 这一条探针问的是主进程「你能不能给这台相机改名」，而答案必须是一个**明确的拒绝**：
   * FA371 的开放接口里没有设备名称端点（`docs/reference/FA371-api-spec.md` §3 的表后注
   * 把「设备重命名」列为「UI 有、Open Interface 未开放」；§5.1.2–§5.1.32 共 32 个接口
   * 里没有一个是改名字的）。所以本机能做的只有改自己数据库里的那一行。
   *
   * 顺序是刻意的：**先**试设备侧（会失败），**再**改本机那一行并立刻恢复。反过来的话，
   * 一次失败的设备侧写入会把新名字留在本机数据库里 —— 一次探针绝不该在真机数据上留下
   * 痕迹。
   */
  if (!camera) {
    log('camera rename : 未验证 — 设备列表里没有声学相机')
    return
  }
  // 原值从**数据库当前那一行**读，而不是从设备列表里带进来的快照：恢复必须回到此刻的
  // 真实值，而不是回到探针启动时看到的值。
  const cameraRowBefore = await evalJson(win, 'cameraRowBefore', deviceRowScript(camera.id), { ok: false })
  const restoredLocalName = cameraRowBefore.ok && cameraRowBefore.row
    ? cameraRowBefore.row.name
    : camera.name
  log('camera before : ' + JSON.stringify(cameraRowBefore))
  const cameraIp = cameraRowBefore.ok && cameraRowBefore.row ? cameraRowBefore.row.ip : camera.ip

  if (!drill) {
    log('camera rename : 未验证 — 没有给 --box-rename-drill，本次运行连相机都不试设备侧写入' +
      '（这一步会先改本机那一行再去问设备，属于写操作）')
  } else {
    const deviceSide = await evalJson(win, 'cameraDeviceRename',
      renameDeviceScript(camera.id, 'HZ 相机改名验证'), { ok: false })
    log('camera rename : 设备侧改名请求 -> ' + JSON.stringify(deviceSide))
    if (deviceSide.ok) {
      // 如果真的成功了，必须立刻改回来：这台相机不需要一个测试名字。
      log('camera rename : UNEXPECTED SUCCESS — 设备侧居然接受了改名，立刻恢复')
      const undo = await evalJson(win, 'cameraRenameRestore',
        renameDeviceScript(camera.id, restoredLocalName), { ok: false })
      log('camera rename : 恢复 -> ' + JSON.stringify(undo))
      problems.push('相机的设备侧重命名居然成功了：本轮的前提（FA371 没有设备名端点）需要重新测量')
    } else if (deviceSide.step === 'device') {
      // 本机行已经被那一次调用改过了（`devices.update` 是先走的那一步），所以下面必须
      // 把它恢复，再单独做一次「只改本机」的验证。
      log('camera rename : 设备侧被拒绝（' + JSON.stringify(deviceSide.code) + '）：' +
        JSON.stringify(deviceSide.message) + '；本机那一行已被这一步改过，后面会恢复')
    } else {
      log('camera rename : 未验证 — 写入在 ' + JSON.stringify(deviceSide.step) + ' 之前就失败了')
    }
  }

  /**
   * 相机改名**能**做到的那一半：只改本机数据库。
   *
   * 这一段是产品要求的核心（「相机的设备名只能改本地，界面必须说清」），所以它走的是
   * **真正的界面路径**（右键 → 菜单项 → 对话框 → 保存），而不是 IPC：
   *   - 右键与菜单项真的存在且可点；
   *   - 对话框里那句话必须点明「只保存在本机数据库」（`deviceRename.cameraHint`）；
   *   - 保存之后**树上的名字真的换了**（只有界面那一半也走通才会有这个结果）；
   *   - 再把它改回原值，并读回证明恢复成功。
   */
  const localName = 'HZ 相机本地验证 ' + Date.now().toString().slice(-6)
  const uiRename = await renameThroughUi(win, camera.id, localName)
  log('camera ui rename: ' + JSON.stringify(uiRename))
  if (!uiRename.ok) {
    problems.push('相机的界面重命名没有走通（' + uiRename.step + '）：' + JSON.stringify(uiRename))
  } else {
    const hint = (uiRename.filled && uiRename.filled.hint) || ''
    log('camera ui hint  : ' + JSON.stringify(hint))
    // 「只保存到本机」这件事必须写在对话框里，而不是只写在报告里。
    if (!/本机数据库/.test(hint) || !/没有.*端点/.test(hint)) {
      problems.push('相机的重命名对话框没有说清「只保存在本机数据库」与「相机没有该端点」：' +
        JSON.stringify(hint))
    }
    const dialogAfter = await evalJson(win, 'uiRenameDialogAfter', renameDialogStateScript(), { open: true })
    log('camera ui after : ' + JSON.stringify(dialogAfter))
    if (dialogAfter.open) {
      problems.push('相机的界面重命名保存之后对话框没有关闭：' + JSON.stringify(dialogAfter))
    }
    const localRowAfterUi = await readTreeRows(win)
    const rowAfterUi = (localRowAfterUi.rows || [])
      .filter((row) => row.node === 'device:' + camera.id)[0] || null
    log('camera ui row   : ' + JSON.stringify(rowAfterUi))
    if (!rowAfterUi || !rowAfterUi.text.includes(localName)) {
      problems.push('界面重命名保存之后树上的相机行没有显示新名字：' + JSON.stringify(rowAfterUi))
    }
    if (rowAfterUi && cameraIp && rowAfterUi.text.includes(cameraIp)) {
      problems.push('界面重命名之后相机的地址出现在树上：' + JSON.stringify(rowAfterUi))
    }
  }

  const localReadBack = await evalJson(win, 'cameraLocalReadBack', deviceRowScript(camera.id), { ok: false })
  log('camera local  : readBack after the UI rename ' + JSON.stringify(localReadBack))
  if (!uiRename.ok) {
    log('camera local  : 界面路径没走通，跳过「本机数据库是否真的改了」这一步')
  } else if (!localReadBack.ok || !localReadBack.row || localReadBack.row.name !== localName) {
    problems.push('界面重命名之后本机数据库里的名字不是新值：期望 ' + JSON.stringify(localName) +
      '，读回 ' + JSON.stringify(localReadBack))
  }

  // 用同一条界面路径改回原值：恢复也必须是操作员真正会走的那条路。
  const uiRestore = await renameThroughUi(win, camera.id, restoredLocalName)
  log('camera ui restore: ' + JSON.stringify(uiRestore))
  if (!uiRestore.ok) {
    problems.push('相机的界面改名没有恢复回原值（' + uiRestore.step + '）：' + JSON.stringify(uiRestore))
  }
  const restoredReadBack = await evalJson(win, 'cameraLocalRestored', deviceRowScript(camera.id), { ok: false })
  log('camera restore: readBack ' + JSON.stringify(restoredReadBack))
  if (!restoredReadBack.ok || !restoredReadBack.row ||
      restoredReadBack.row.name !== restoredLocalName) {
    problems.push('相机的本机名字恢复后读回不是原值：期望 ' +
      JSON.stringify(restoredLocalName) + '，得到 ' + JSON.stringify(restoredReadBack))
  }
}



/**
 * Describe the live-video UI as the operator sees it.
 *
 * Three routes carry a camera player and they are DIFFERENT components:
 *   /         OverviewView     -> CameraVideoWall, classes `camera-wall__*`
 *   /monitor  MonitorView      -> its own card,     classes `camera-live__*`
 *
 * All three shape sets are matched here. Getting this wrong is not a cosmetic
 * harness bug: with only the `/` selectors, `/monitor` reported "no stage, no
 * video, no control", which reads exactly like a broken player. It cost a full
 * 25-second run plus a screenshot nobody could interpret before the selectors
 * were suspected. The Overview used to render `CameraLiveSection` (`live__*`);
 * it now renders the multi-cell wall, so the wall's cell structure is reported
 * too — "cells rendered vs cells with a video vs placeholder cells" is the only
 * way to tell "the wall is empty" from "the wall is there but nothing plays".
 *
 * Reporting the stage's own text is what turns a bare `videoElements: 0` into a
 * diagnosis, because "no player" has several very different causes: the section is
 * not mounted, it is showing a status sentence, or it refuses to show a player
 * because it believes another page owns the session.
 */
function uiScript() {
  return (
    '(() => {' +
    ' const stage = document.querySelector(".live__stage, .camera-live__stage");' +
    ' const controls = Array.prototype.slice.call(document.querySelectorAll(' +
    '   ".live__actions .btn, .camera-live .btn-row .btn, .camera-wall__bar .camera-wall__bar-btn"' +
    ' ));' +
    ' const placeholder = document.querySelector(".live__placeholder, .camera-live__placeholder");' +
    ' const alerts = Array.prototype.slice.call(document.querySelectorAll(".alert"))' +
    '   .map((el) => (el.textContent || "").trim()).filter(Boolean);' +
    // The camera wall's own structure. `cells` is what the layout produced,
    // `videos` counts cells that actually hold a <video> element, and
    // `placeholders` counts cells showing the framed empty region instead. The two
    // must add up to `cells` — a cell that is neither is a bug the numbers expose.
    //
    // The layout switch is reported as a SHAPE and not as text, because it is
    // ICON-ONLY: there is no label to read any more. `label` (aria-label), `title`,
    // `pressed` and `svg` are then the only things that say which layout a button
    // selects, `inHeader` proves the switch really lives in the title row — a control
    // that renders twice, or stays where it was, looks identical in a screenshot of a
    // header that happens to be tall — and `rightGapPx` proves it is pushed to the
    // RIGHT of that row (the owner's「切换窗口右对齐」), not merely somewhere in it.
    ' const wall = document.querySelector(".camera-wall");' +
    ' const wallHeader = wall ? wall.querySelector(".section-header") : null;' +
    ' const wallGroup = wall ? wall.querySelector(".segment") : null;' +
    ' const layoutShape = (group, header) => {' +
    '   const buttons = group ? Array.prototype.slice.call(group.querySelectorAll("button")) : [];' +
    '   return {' +
    '     groupLabel: group ? (group.getAttribute("aria-label") || "") : null,' +
    '     inHeader: !!(group && header && header.contains(group)),' +
    '     rightGapPx: (group && header)' +
    '       ? Math.round(header.getBoundingClientRect().right - group.getBoundingClientRect().right)' +
    '       : null,' +
    '     buttons: buttons.map((b) => {' +
    '       const rects = Array.prototype.slice.call(b.querySelectorAll("svg rect"));' +
    '       const xOf = (r) => r.getAttribute("x");' +
    '       const yOf = (r) => r.getAttribute("y");' +
    '       return {' +
    '         label: b.getAttribute("aria-label") || "",' +
    '         title: b.getAttribute("title") || "",' +
    '         pressed: b.getAttribute("aria-pressed") === "true",' +
    '         svg: !!b.querySelector("svg"),' +
    '         inHeader: !!(header && header.contains(b)),' +
    '         text: (b.textContent || "").trim(),' +
    // The icon's OWN geometry: how many little boxes it draws and how many distinct
    // rows/columns they sit in. "contains an <svg>" alone would pass for four
    // identical single squares; this is what proves the 16-up icon is a 4x4 grid.
    '         cells: rects.length,' +
    '         iconColumns: new Set(rects.map(xOf)).size,' +
    '         iconRows: new Set(rects.map(yOf)).size,' +
    // The ACTIVE state, as the browser resolved it (not as the class name suggests):
    // an icon-only switch is useless if the current layout is not visibly different.
    '         paint: getComputedStyle(b).backgroundColor + " / " + getComputedStyle(b).borderTopColor' +
    '       };' +
    '     })' +
    '   };' +
    ' };' +
    ' const wallCells = wall ? Array.prototype.slice.call(wall.querySelectorAll(".camera-wall__cell")) : [];' +
    ' const wallPlaceholders = wallCells.filter((c) => c.querySelector(".camera-wall__body"));' +
    // The empty cell, as the owner specified it THIS round: ONE large `+` in the MIDDLE
    // of the cell and no words at all. (The previous round had the `+` flush against the
    // right-hand edge; the owner reversed that decision, so the probe measures the
    // centre offset instead of the right gap — see `emptyCellProblems()`.)
    // `texts` is the whole visible text of each empty cell (so it must be exactly "+"),
    // `addLabels` is the accessible name of that +, and `visibleSelects` counts the empty
    // cells that still show a bordered <select> the owner removed.
    ' const emptyCells = wallCells.filter((c) => c.classList.contains("camera-wall__cell--empty"));' +
    ' const emptyButtons = emptyCells.map((c) => c.querySelector(".camera-wall__add")).filter(Boolean);' +
    // The REAL grid, measured from where the browser put the cells: distinct left edges
    // = columns, distinct top edges = rows. This is what the icon of the active layout
    // button has to agree with, and it is the only way to prove "9 分屏 is 3x3" — counting
    // cells cannot tell 3x3 from 9x1.
    //
    // `boxes` is each cell's rendered box. The owner also asked for 16:9 cells, and a
    // ratio is only ever provable by measuring the boxes the browser actually laid out.
    ' const boxOf = (el) => {' +
    '   const r = el.getBoundingClientRect();' +
    '   return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };' +
    ' };' +
    ' const grid = {' +
    '   cells: wallCells.length,' +
    '   columns: wallCells.length ? new Set(wallCells.map((c) => Math.round(c.getBoundingClientRect().left))).size : 0,' +
    '   rows: wallCells.length ? new Set(wallCells.map((c) => Math.round(c.getBoundingClientRect().top))).size : 0,' +
    '   boxes: wallCells.map(boxOf),' +
    '   cellAspectRatio: (() => { const s = getComputedStyle(wallCells[0] || document.body); return s.aspectRatio; })()' +
    ' };' +
    ' const cameraWall = wall ? {' +
    '   cells: wallCells.length,' +
    '   videos: wallCells.filter((c) => c.querySelector("video")).length,' +
    '   placeholders: wallPlaceholders.length,' +
    '   placeholderTexts: wallPlaceholders.map((c) => (c.textContent || "").replace(/\\s+/g, " ").trim())' +
    '     .filter(Boolean).slice(0, 4),' +
    '   placeholderStateWords: wallPlaceholders' +
    '     .filter((c) => !c.classList.contains("camera-wall__cell--empty"))' +
    '     .map((c) => { const b = c.querySelector(".badge"); return b ? (b.textContent || "").trim() : ""; }),' +
    '   empty: {' +
    '     cells: emptyCells.length,' +
    '     addButtons: emptyButtons.length,' +
    '     addLabels: emptyButtons.map((b) => b.getAttribute("aria-label") || ""),' +
    '     addTitles: emptyButtons.map((b) => b.getAttribute("title") || ""),' +
    // Visible words only. The `.visually-hidden` strip is kept as a belt-and-braces
    // measure: the picker used to be a hidden <select> and `textContent` would have
    // counted its <option> labels as cell text. Since 2026-09-18 the picker is an
    // overlay teleported to <body> (`CameraCellPicker`), so there is nothing hidden
    // inside the cell to strip — the numbers below must be zero either way.
    '     texts: emptyCells.map((c) => {' +
    '       const copy = c.cloneNode(true);' +
    '       Array.prototype.slice.call(copy.querySelectorAll(".visually-hidden"))' +
    '         .forEach((node) => node.parentNode.removeChild(node));' +
    '       return (copy.textContent || "").replace(/\\s+/g, " ").trim();' +
    '     }),' +
    // WHERE the `+` sits, in the cell's own coordinates (the owner's requirement is
    // about the CELL, not about the page):
    //   addCenterOffsetXPx : signed horizontal distance from the +'s centre to the
    //                        cell's centre. 0 = centred; half the cell width = flush
    //                        against one edge (the sign says which). This REPLACES the
    //                        old `addRightGapPx` assertion — the requirement it pinned
    //                        (「放在右侧」) was reversed by the owner, not forgotten.
    //   addCenterOffsetYPx : the same on the vertical axis (the + must be centred in
    //                        both directions now that it is the cell's only content).
    //   addRightGapPx / addLeftGapPx : kept for the report, so a reader can see the two
    //                                  numbers that used to be the assertion.
    '     addCenterOffsetXPx: emptyButtons.map((b) => {' +
    '       const br = b.getBoundingClientRect();' +
    '       const cr = (b.closest(".camera-wall__cell") || b).getBoundingClientRect();' +
    '       return Math.round((br.left + br.width / 2) - (cr.left + cr.width / 2));' +
    '     }),' +
    '     addCenterOffsetYPx: emptyButtons.map((b) => {' +
    '       const br = b.getBoundingClientRect();' +
    '       const cr = (b.closest(".camera-wall__cell") || b).getBoundingClientRect();' +
    '       return Math.round((br.top + br.height / 2) - (cr.top + cr.height / 2));' +
    '     }),' +
    '     addCellWidthPx: emptyButtons.map((b) => Math.round((b.closest(".camera-wall__cell") || b).getBoundingClientRect().width)),' +
    '     addRightGapPx: emptyButtons.map((b) => Math.round(b.getBoundingClientRect().right' +
    '       - (b.closest(".camera-wall__cell") || b).getBoundingClientRect().right))' +
    '       .map((gap) => Math.abs(gap)),' +
    '     addLeftGapPx: emptyButtons.map((b) => Math.round(b.getBoundingClientRect().left' +
    '       - (b.closest(".camera-wall__cell") || b).getBoundingClientRect().left))' +
    '       .map((gap) => Math.abs(gap)),' +
    // A bordered <select> occupies real pixels; the hidden one must not.
    '     visibleSelects: emptyCells' +
    '       .filter((c) => Array.prototype.slice.call(c.querySelectorAll("select"))' +
    '         .some((s) => { const r = s.getBoundingClientRect(); return r.width > 4 || r.height > 4; })).length,' +
    // The strictest reading of the owner's requirement, and the one this probe now
    // measures: the empty cell must contain **zero text nodes** and **zero <select>**
    // elements. The picker is an overlay rendered on <body> (it used to be a hidden
    // wall-level <select>, see the 2026-09-18 bug in `CameraCellPicker.vue`), so there
    // is nothing for the cell to hide. `texts` (above) strips hidden subtrees and could
    // therefore never prove this on its own.
    '     textNodeCounts: emptyCells.map((c) => {' +
    '       const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, null);' +
    '       let textNodes = 0;' +
    '       let node = walker.nextNode();' +
    '       while (node) { if ((node.nodeValue || "").trim() !== "") { textNodes += 1; } node = walker.nextNode(); }' +
    '       return textNodes;' +
    '     }),' +
    '     selectCounts: emptyCells.map((c) => c.querySelectorAll("select").length),' +
    // The `+` itself: two SVG strokes (one horizontal, one vertical) and how large the
    // browser actually painted it. Text would be a text node; a `+` glyph that is too
    // small is not the "large plus" the owner asked for.
    '     plusStrokes: emptyButtons.map((b) => b.querySelectorAll("svg line").length),' +
    '     plusHorizontal: emptyButtons.map((b) => Array.prototype.slice.call(b.querySelectorAll("svg line"))' +
    '       .filter((l) => l.getAttribute("y1") === l.getAttribute("y2")).length),' +
    '     plusVertical: emptyButtons.map((b) => Array.prototype.slice.call(b.querySelectorAll("svg line"))' +
    '       .filter((l) => l.getAttribute("x1") === l.getAttribute("x2")).length),' +
    '     plusWidthPx: emptyButtons.map((b) => {' +
    '       const svg = b.querySelector("svg");' +
    '       return svg ? Math.round(svg.getBoundingClientRect().width) : 0;' +
    '     }),' +
    '   },' +
    // The bottom control bar, one per assigned cell. This is the owner's replacement for
    // the buttons that used to sit on the top overlay: play/stop, fullscreen, the volume
    // icon and the volume slider. `overlayButtons` and `legacyButtons` are the evidence
    // that the old row is GONE rather than merely restyled, and `controls` carries each
    // control's accessible name, tooltip, disabled state and pressed state.
    '   bar: {' +
    '     assignedCells: wallCells.filter((c) => !c.classList.contains("camera-wall__cell--empty")).length,' +
    '     emptyCells: emptyCells.length,' +
    '     bars: wallCells.filter((c) => c.querySelector(".camera-wall__bar")).length,' +
    '     overlayButtons: wall ? wall.querySelectorAll(".camera-wall__overlay button").length : 0,' +
    // The buttons the owner deleted were ACTION buttons (停止 / 关闭声音 / 全屏 / 关闭). The
    // device name in that strip is a deliberate entry point to the camera picker this round
    // (it replaced the per-cell <select> so the empty cell can hold no text at all), so it
    // is the ONE button allowed to remain there. Counting it separately keeps the claim
    // precise instead of quietly relaxing it: "no action control is back on the top strip".
    '     overlayActionButtons: wall' +
    '       ? wall.querySelectorAll(".camera-wall__overlay button:not(.camera-wall__name--action)").length' +
    '       : 0,' +
    '     legacyButtons: wall ? wall.querySelectorAll(".camera-wall__btn").length : 0,' +
    '     controls: wallCells' +
    '       .map((c) => c.querySelector(".camera-wall__bar"))' +
    '       .filter(Boolean)' +
    '       .map((bar) => Array.prototype.slice.call(bar.querySelectorAll("button, input")).map((el) => ({' +
    '         tag: el.tagName.toLowerCase(),' +
    '         type: el.getAttribute("type") || "",' +
    '         label: el.getAttribute("aria-label") || "",' +
    '         title: el.getAttribute("title") || "",' +
    '         disabled: el.disabled === true,' +
    '         pressed: el.getAttribute("aria-pressed"),' +
    '         text: (el.textContent || "").trim()' +
    '       })))' +
    '   },' +
    '   layoutHeaderText: wallHeader ? (wallHeader.textContent || "").replace(/\\s+/g, " ").trim() : null,' +
    '   grid: grid,' +
    '   layout: layoutShape(wallGroup, wallHeader)' +
    ' } : null;' +
    // The channel wall is the SECOND wall on the Overview. It carries the same kind
    // of layout switch PLUS the new graph-type switch, a disclosure that can hide it
    // all, and — with a real data source — the graph each tile actually drew. All of
    // that is read here, in one pass, so the numbers in the report and the assertions
    // below come from the same DOM snapshot.
    //
    // `resolvedColumns` is what makes this measurable at all: with ONE tile on the
    // wall, counting distinct cell edges can never show more than one column, so the
    // "2-up is two columns" claim is checked against the grid the browser actually
    // resolved (`grid-template-columns` track count), not against how many cells
    // happen to be filled.
    ' const textOf = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    ' const channelWallSection = document.querySelector(".card.wall");' +
    ' const channelWallGroup = channelWallSection ? channelWallSection.querySelector(".wall__layout") : null;' +
    ' const channelWallHeader = channelWallGroup ? channelWallGroup.closest(".section-header") : null;' +
    ' const channelWallGrid = channelWallSection ? channelWallSection.querySelector(".wall__grid") : null;' +
    ' const channelWallTiles = channelWallGrid' +
    '   ? Array.prototype.slice.call(channelWallGrid.querySelectorAll(".wall-tile"))' +
    '   : [];' +
    ' const channelWallDisclosure = channelWallSection' +
    '   ? channelWallSection.querySelector(".wall__disclosure")' +
    '   : null;' +
    ' const channelWallGraphGroup = channelWallSection' +
    '   ? channelWallSection.querySelector(".wall__graph")' +
    '   : null;' +
    ' const groupShape = (group, header) => ({' +
    '   groupLabel: group ? (group.getAttribute("aria-label") || "") : null,' +
    '   inHeader: !!(group && header && header.contains(group)),' +
    '   buttons: group' +
    '     ? Array.prototype.slice.call(group.querySelectorAll("button")).map((b) => ({' +
    '         label: b.getAttribute("aria-label") || "",' +
    '         title: b.getAttribute("title") || "",' +
    '         pressed: b.getAttribute("aria-pressed") === "true",' +
    '         svg: !!b.querySelector("svg"),' +
    '         text: (b.textContent || "").trim()' +
    '       }))' +
    '     : []' +
    ' });' +
    ' const gridColumnsOf = (grid) => {' +
    '   if (!grid) return 0;' +
    '   const tracks = getComputedStyle(grid).gridTemplateColumns;' +
    '   return tracks ? tracks.split(" ").filter((track) => track !== "").length : 0;' +
    ' };' +
    ' const channelWall = channelWallSection ? {' +
    '   collapsed: !channelWallGrid,' +
    '   summary: textOf(channelWallSection.querySelector(".wall__summary")),' +
    '   collapsedHint: textOf(channelWallSection.querySelector(".wall__collapsed-hint")),' +
    '   disclosure: channelWallDisclosure ? {' +
    '     expanded: channelWallDisclosure.getAttribute("aria-expanded"),' +
    '     label: channelWallDisclosure.getAttribute("aria-label") || "",' +
    '     title: channelWallDisclosure.getAttribute("title") || "",' +
    '     svg: !!channelWallDisclosure.querySelector("svg"),' +
    '     inHeader: !!(channelWallHeader && channelWallHeader.contains(channelWallDisclosure))' +
    '   } : null,' +
    '   graph: groupShape(channelWallGraphGroup, channelWallHeader),' +
    '   grid: channelWallGrid ? {' +
    '     cells: channelWallTiles.length,' +
    '     resolvedColumns: gridColumnsOf(channelWallGrid),' +
    '     columns: channelWallTiles.length' +
    '       ? new Set(channelWallTiles.map((c) => Math.round(c.getBoundingClientRect().left))).size' +
    '       : 0,' +
    '     rows: channelWallTiles.length' +
    '       ? new Set(channelWallTiles.map((c) => Math.round(c.getBoundingClientRect().top))).size' +
    '       : 0' +
    '   } : null,' +
    // Per-tile: which of the three shapes it rendered (device JPEG / SVG polyline /
    // an honest note). A tile holding NONE of them is a blank cell, which is the one
    // outcome the wall must never produce, so the probe reports all three.
    '   tiles: channelWallTiles.map((c) => ({' +
    '     device: textOf(c.querySelector(".wall-tile__device")),' +
    '     label: textOf(c.querySelector(".wall-tile__label")),' +
    '     camera: c.classList.contains("wall-tile--camera"),' +
    // 通道状态徽标（这一轮）：文字 + title（title 只有未知/未启用两态才有）。
    '     state: textOf(c.querySelector(".wall-tile__badge")),' +
    '     stateTitle: (c.querySelector(".wall-tile__badge") || {}).title || "",' +
    // 最近告警那一行（这一轮）：标签、值、以及读库失败时的诊断原文（title）。
    '     alarmLabel: textOf(c.querySelector(".wall-tile__alarm-label")),' +
    '     alarmValue: textOf(c.querySelector(".wall-tile__alarm-value")),' +
    '     alarmTitle: (c.querySelector(".wall-tile__alarm") || {}).title || "",' +
    '     alarmPresent: !!c.querySelector(".wall-tile__alarm"),' +
    // 实时数值：读数本身与它的单位（`dB` 必须来自目录，出处挂在 title 上）。
    '     metricValues: Array.prototype.slice.call(c.querySelectorAll(".wall-tile__metric-value")).map((m) => textOf(m)),' +
    '     metricTitle: (c.querySelector(".wall-tile__metric") || {}).title || "",' +
    '     unitTitles: Array.prototype.slice.call(c.querySelectorAll(".wall-tile__metric-unit")).map((u) => u.getAttribute("title") || ""),' +
    '     wholeText: textOf(c),' +
    '     image: (() => {' +
    '       const img = c.querySelector("img.wall-tile__image");' +
    '       if (!img) return null;' +
    '       const src = img.getAttribute("src") || "";' +
    '       return {' +
    '         prefix: src.slice(0, 22),' +
    '         bytes: src.length,' +
    '         decoded: img.naturalWidth > 0,' +
    '         width: img.naturalWidth,' +
    '         height: img.naturalHeight' +
    '       };' +
    '     })(),' +
    '     linePoints: (() => {' +
    '       const line = c.querySelector("polyline.wall-graph__line");' +
    '       if (!line) return 0;' +
    '       return (line.getAttribute("points") || "").split(" ").filter(Boolean).length;' +
    '     })(),' +
    '     caption: textOf(c.querySelector(".wall-graph__caption")),' +
    '     note: textOf(c.querySelector(".wall-tile__note")),' +
    '     metrics: !!c.querySelector(".wall-tile__metrics")' +
    '   }))' +
    ' } : null;' +
    // The heading this change deletes, in every locale it could have been rendered
    // in. Escapes keep this file ASCII-only; the probe compares ELEMENT TEXT, so an
    // `aria-label` that legitimately still says the same words does not count.
    ' const oldLayoutHeadings = ["\\u5206\\u5c4f\\u6863\\u4f4d", "Cell layout", "Disposici\\u00f3n de celdas", "H\\u00fccre d\\u00fczeni"];' +
    ' const oldLayoutHeadingHits = Array.prototype.slice.call(document.querySelectorAll("body *"))' +
    '   .filter((el) => oldLayoutHeadings.indexOf((el.textContent || "").trim()) >= 0).length;' +
    ' return JSON.stringify({' +
    '   hash: location.hash,' +
    '   pageTitle: (document.querySelector(".page-title") || {}).textContent || null,' +
    '   cards: document.querySelectorAll(".card").length,' +
    '   hasStage: !!stage,' +
    '   hasVideo: !!document.querySelector("video"),' +
    '   placeholderText: placeholder ? placeholder.textContent.trim() : null,' +
    '   actionLabels: controls.map((b) => b.textContent.trim()),' +
    '   disabledControls: controls.filter((b) => b.disabled).map((b) => b.textContent.trim()),' +
    '   alerts: alerts.slice(0, 4),' +
    '   cameraWall: cameraWall,' +
    '   channelWall: channelWall,' +
    '   channelWallLayout: channelWallGroup ? layoutShape(channelWallGroup, channelWallHeader) : null,' +
    '   oldLayoutHeadingHits: oldLayoutHeadingHits,' +
    '   layoutFieldLabels: wall ? wall.querySelectorAll(".field-label").length : 0,' +
    '   videoWallCells: document.querySelectorAll(".wall__cell").length,' +
    '   bodyHead: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 240)' +
    ' });' +
    '})()'
  )
}

/** Describe the live-video UI. Returns {} when the probe itself failed. */
async function probeUi(win) {
  const raw = await evalInPage(win, 'uiProbe', uiScript())
  return raw === null ? {} : JSON.parse(raw)
}

/**
 * 那一格 16:9 的比例公差。
 *
 * 允许 2% 的相对误差：格子的宽度是 `1fr` 分出来的（可能带小数），而且边框、行高都由
 * 浏览器算到亚像素；2% 远小于「4:3 被当成 16:9」（误差 25%）这种真错，也远大于
 * 取整噪声。测到的真实数字会一起打出来，所以公差是**有证据的**，不是猜的。
 */
const CELL_RATIO_TOLERANCE = 0.02

/** 16:9 的比值。写成常量，免得断言里出现一个魔数 1.777…。 */
const CELL_RATIO_16_9 = 16 / 9

/** `+` 与格子中心允许的偏差（px）：亚像素布局 + 取整，1~2px 是噪声不是偏移。 */
const CENTRE_TOLERANCE_PX = 2

/** 从一次 `probeUi()` 的结果里读出「现在压着的是几档」，读不到就是 null。 */
function pressedLayoutCount(ui) {
  const shape = ui && ui.cameraWall ? ui.cameraWall.layout : null
  if (!shape) return null
  const pressed = (shape.buttons || []).filter((button) => button.pressed)[0]
  if (!pressed) return null
  const match = /^(\d+)/.exec(pressed.label || '')
  return match ? Number(match[1]) : null
}

/** 每一格的「宽 x 高 = 比例」报告，断言失败时人和日志看的是同一组数字。 */
function cellRatioReport(grid) {
  return (grid && grid.boxes ? grid.boxes : []).map((box, index) => ({
    index: index,
    width: box.width,
    height: box.height,
    ratio: box.height > 0 ? Math.round((box.width / box.height) * 1000) / 1000 : null,
    relativeError:
      box.height > 0
        ? Math.round((Math.abs(box.width / box.height - CELL_RATIO_16_9) / CELL_RATIO_16_9) * 10000) / 10000
        : null
  }))
}

/**
 * `.page` 的几何：它与内容区（`.app-content`）、内容主列（`.app-main`）的左/上间距，
 * 以及它自己的宽度。
 *
 * 三个参考系都量，是因为「和左边、上边保持固定的距离」这句话里的「边」可以是窗口、
 * 也可以是侧栏右侧的内容主列：只要这三个间距在四档窗口尺寸下都一模一样，无论按哪个
 * 读法结论都成立。`scrollTop` 归零是必须的 —— `.app-content` 是滚动容器，页面滚过之后
 * `top` 反映的是滚动位置而不是上边距。
 *
 * 右边距要区分两种读法，因为这一页常常比视口高，纵向滚动条会占掉右边 10px：
 *   - `gapFromContentPx` 是相对内容区 **padding box** 的原始间距：左边 24px（就是内边距），
 *     右边 24px + 滚动条 10px = 34px。把它当成「内容被推到了左边」是误读；
 *   - `gapFromContentBoxPx` 是相对**内容盒**（padding 之内、滚动条之外）的间距：流式列
 *     填满时左右都是 0。定宽居中列在这里会得到两个相等且大于 0 的数。
 * `scrollbarPx` 一起报出来，读者能看见那 10px 是什么。
 */
function pageGeometryScript() {
  return (
    '(() => {' +
    ' const page = document.querySelector(".page");' +
    ' const content = document.querySelector(".app-content");' +
    ' const main = document.querySelector(".app-main");' +
    ' if (!page || !content || !main) return JSON.stringify({ found: false,' +
    '   hasPage: !!page, hasContent: !!content, hasMain: !!main });' +
    ' content.scrollTop = 0;' +
    ' const p = page.getBoundingClientRect();' +
    ' const c = content.getBoundingClientRect();' +
    ' const m = main.getBoundingClientRect();' +
    ' const style = getComputedStyle(page);' +
    ' const contentStyle = getComputedStyle(content);' +
    ' const paddingLeft = parseFloat(contentStyle.paddingLeft) || 0;' +
    ' const paddingRight = parseFloat(contentStyle.paddingRight) || 0;' +
    // 内容盒（padding 之内、滚动条之外）的左右边界。`.page` 流式填满时，它的左右边界
    // 与这两个值**重合**（下面 gapFromContentBoxPx 两项都是 0）；如果它变回一个定宽居中
    // 列，这两项会相等且大于 0 —— 「居中」在数字上就是这个样子。
    ' const contentBoxLeft = c.left + paddingLeft;' +
    ' const contentBoxRight = c.left + content.clientWidth - paddingRight;' +
    ' const round = (n) => Math.round(n);' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   viewport: { w: window.innerWidth, h: window.innerHeight },' +
    '   devicePixelRatio: window.devicePixelRatio,' +
    '   page: { left: round(p.left), top: round(p.top), width: round(p.width), right: round(p.right) },' +
    '   gapFromContentPx: {' +
    '     left: round(p.left - c.left),' +
    '     top: round(p.top - c.top),' +
    '     right: round(c.right - p.right)' +
    '   },' +
    '   gapFromContentBoxPx: {' +
    '     left: round(p.left - contentBoxLeft),' +
    '     right: round(contentBoxRight - p.right)' +
    '   },' +
    '   gapFromMainPx: { left: round(p.left - m.left), top: round(p.top - m.top) },' +
    '   gapFromViewportPx: { left: round(p.left), top: round(p.top) },' +
    '   contentClientWidth: content.clientWidth,' +
    '   contentPaddingLeft: contentStyle.paddingLeft,' +
    '   contentPaddingRight: contentStyle.paddingRight,' +
    '   scrollbarPx: content.offsetWidth - content.clientWidth,' +
    '   pageMaxWidth: style.maxWidth,' +
    '   pageMarginLeft: style.marginLeft,' +
    '   pageMarginRight: style.marginRight' +
    ' });' +
    '})()'
  )
}

/** 一次 `.page` 几何读数。探针本身失败时返回 `{ found: false }`。 */
async function probePageGeometry(win) {
  const raw = await evalInPage(win, 'pageGeometry', pageGeometryScript())
  return raw === null ? { found: false, probeFailed: true } : JSON.parse(raw)
}

/**
 * Click the section's play control, which is the REAL user action.
 *
 * Calling `cameraLive.start` over IPC instead is not equivalent: the renderer
 * store tracks sessions IT started (`ownSessions`), and a session it did not start
 * is treated as belonging to another page and deliberately rendered as an
 * explanation rather than a player. Driving the button is what exercises the path
 * an operator actually takes.
 */
async function clickPlay(win) {
  const source =
    '(() => {' +
    ' const legacy = Array.prototype.slice.call(document.querySelectorAll(' +
    '   ".live__actions .btn, .camera-live .btn-row .btn"' +
    ' ));' +
    ' const byText = legacy.find((b) => !b.disabled && /start|play|开始|重试|retry|başlat|iniciar|reintentar/i.test(b.textContent));' +
    // The camera wall's control bar is ICON-ONLY: there is no text to match. Its
    // play/stop control is the FIRST control of the bar by construction, and this
    // function is only ever called when the cell has no address yet (so the first
    // enabled bar button in document order is 「开始」/「重试」, never 「停止」).
    ' const barButtons = Array.prototype.slice.call(' +
    '   document.querySelectorAll(".camera-wall__bar .camera-wall__bar-btn"));' +
    ' const byPosition = barButtons.filter((b) => !b.disabled)[0] || null;' +
    ' const button = byText || byPosition;' +
    ' if (!button) return JSON.stringify({' +
    '   clicked: false,' +
    '   reason: "no enabled play control",' +
    '   labels: Array.prototype.concat(' +
    '     legacy.map((b) => b.textContent.trim() + (b.disabled ? " (disabled)" : "")),' +
    '     barButtons.map((b) => (b.getAttribute("aria-label") || "") + (b.disabled ? " (disabled)" : ""))' +
    '   )' +
    ' });' +
    ' const label = byText ? button.textContent.trim() : (button.getAttribute("aria-label") || "");' +
    ' const from = byText ? "text" : "bar-position";' +
    ' button.click();' +
    ' return JSON.stringify({ clicked: true, label: label, from: from });' +
    '})()'
  const raw = await evalInPage(win, 'clickPlay', source)
  return raw === null ? { clicked: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * Move one cell's volume slider to `percent` and report what Chromium then holds.
 *
 * THE POINT IS THE PROPERTY, NOT THE WIDGET. Only the event is dispatched plus, for a
 * range input, the value is set the way a real drag sets it; what is read back is
 * `<video>.volume` and `<video>.muted` — the DOM properties the browser actually reads.
 * A component that keeps its own `ref` in sync but never writes the element would pass
 * any screenshot and fail this.
 */
async function setVolumeSlider(win, slot, percent) {
  const source =
    '(() => {' +
    ' const bars = Array.prototype.slice.call(document.querySelectorAll(".camera-wall__bar"));' +
    // The FIRST bar whose slider can actually act: a cell with no picture has its
    // volume controls disabled on purpose (it cannot produce sound), so driving that one
    // would measure a disabled widget instead of the audio pipeline.
    ' const usable = bars.findIndex((b) => {' +
    '   const s = b.querySelector(".camera-wall__volume");' +
    '   return !!s && s.disabled !== true;' +
    ' });' +
    ' const index = usable >= 0 ? usable : ' + JSON.stringify(slot) + ';' +
    ' const bar = bars[index] || null;' +
    ' if (!bar) return JSON.stringify({ found: false, bars: bars.length });' +
    ' const slider = bar.querySelector(".camera-wall__volume");' +
    ' if (!slider) return JSON.stringify({ found: false, reason: "no slider in this bar" });' +
    // A range input is driven the way a drag drives it: set `value` through the prototype
    // setter (so Vue's own listener sees a real change) and dispatch `input`.
    ' const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;' +
    ' setter.call(slider, String(' + JSON.stringify(percent) + '));' +
    ' slider.dispatchEvent(new Event("input", { bubbles: true }));' +
    ' const vids = Array.prototype.slice.call(document.querySelectorAll("video"));' +
    ' const v = vids[0] || null;' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   barIndex: index,' +
    '   bars: bars.length,' +
    '   sliderDisabled: slider.disabled === true,' +
    '   sliderValue: slider.value,' +
    '   sliderLabel: slider.getAttribute("aria-label") || "",' +
    '   videoVolume: v ? Math.round(v.volume * 100) / 100 : null,' +
    '   videoMuted: v ? v.muted : null,' +
    '   unmuted: vids.filter((x) => !x.muted).length,' +
    '   muted: vids.filter((x) => x.muted).length,' +
    '   volumes: vids.map((x) => Math.round(x.volume * 100) / 100)' +
    ' });' +
    '})()'
  const raw = await evalInPage(win, 'setVolumeSlider', source)
  return raw === null ? { found: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * Press the play/stop control: the FIRST control of the first cell's control bar.
 *
 * It is found by POSITION, not by text, because the bar is icon-only by design; the
 * caller decides the direction (a live cell stops, an assigned non-live cell starts) and
 * the reported `labelBefore` is what makes the direction auditable.
 */
async function pressBarPlayback(win) {
  const source =
    '(() => {' +
    ' const bars = Array.prototype.slice.call(document.querySelectorAll(".camera-wall__bar"));' +
    ' const bar = bars[0] || null;' +
    ' if (!bar) return JSON.stringify({ pressed: false, reason: "no control bar" });' +
    ' const button = bar.querySelector(".camera-wall__bar-btn");' +
    ' if (!button) return JSON.stringify({ pressed: false, reason: "no play control" });' +
    ' const before = button.getAttribute("aria-label") || "";' +
    ' if (button.disabled) {' +
    '   return JSON.stringify({ pressed: false, reason: "play control is disabled", labelBefore: before });' +
    ' }' +
    ' button.click();' +
    ' return JSON.stringify({' +
    '   pressed: true,' +
    '   labelBefore: before,' +
    '   bars: bars.length,' +
    '   videoElements: document.querySelectorAll("video").length' +
    ' });' +
    '})()'
  const raw = await evalInPage(win, 'pressBarPlayback', source)
  return raw === null ? { pressed: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/** Wait until the wall holds NO `<video>` at all (the stop direction). */
async function waitForNoVideo(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = await probe(win)
  while (Date.now() < deadline) {
    if (!last.found || last.videoElements === 0) return last
    await sleep(400)
    last = await probe(win)
  }
  return last
}

/** Wait until a frame is decoded again (the start direction). */
async function waitForDecoded(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = await probe(win)
  while (Date.now() < deadline) {
    if (last.found && last.readyState >= 2 && last.videoWidth > 0) return last
    await sleep(700)
    last = await probe(win)
  }
  return last
}

// ---------------------------------------------------------------------------
// 画面格右键菜单（NVR 式）
// ---------------------------------------------------------------------------

/**
 * 读出右键菜单此刻的样子。
 *
 * 标签取的是 `.vmenu__label` 里的**文本节点**（把 ✓ 勾与 › 箭头那两个 span 排掉），
 * 因为那正是操作员读到的东西；`title` 只是同一件事的第二种写法（灰显项的 title
 * 是**原因**），两者都带上，就可以断言「禁用的项把原因画在了菜单里」。
 */
function menuProbeScript() {
  return (
    '(() => {' +
    ' const menu = document.querySelector(".vmenu");' +
    ' if (!menu) return JSON.stringify({ open: false });' +
    ' const labelOf = (item) => {' +
    '   const label = item.querySelector(".vmenu__label");' +
    '   if (!label) return "";' +
    '   let out = "";' +
    '   Array.prototype.slice.call(label.childNodes).forEach((node) => {' +
    '     if (node.nodeType === 3) out += node.nodeValue || "";' +
    '   });' +
    '   return out.replace(/\\s+/g, " ").trim();' +
    ' };' +
    ' const shape = (item, index) => {' +
    '   const reasonEl = item.querySelector(".vmenu__reason");' +
    '   const rect = item.getBoundingClientRect();' +
    '   return {' +
    '     index: index,' +
    '     label: labelOf(item),' +
    '     title: item.getAttribute("title") || "",' +
    '     disabled: item.getAttribute("aria-disabled") === "true",' +
    '     checked: item.getAttribute("aria-checked"),' +
    '     expanded: item.getAttribute("aria-expanded"),' +
    '     hasSubmenu: item.getAttribute("aria-haspopup") === "menu",' +
    '     separatorBefore: !!(item.previousElementSibling && item.previousElementSibling.tagName === "HR"),' +
    '     reason: reasonEl ? (reasonEl.textContent || "").replace(/\\s+/g, " ").trim() : "",' +
    '     width: Math.round(rect.width),' +
    '     height: Math.round(rect.height)' +
    '   };' +
    ' };' +
    ' const top = Array.prototype.slice.call(menu.querySelectorAll(":scope > button.vmenu__item"));' +
    ' const sub = menu.querySelector(".vmenu__submenu");' +
    ' const rect = menu.getBoundingClientRect();' +
    ' const titleEl = menu.querySelector(".vmenu__title");' +
    ' return JSON.stringify({' +
    '   open: true,' +
    '   title: titleEl ? (titleEl.textContent || "").trim() : "",' +
    '   ariaLabel: menu.getAttribute("aria-label") || "",' +
    '   role: menu.getAttribute("role") || "",' +
    '   left: Math.round(rect.left),' +
    '   top: Math.round(rect.top),' +
    '   width: Math.round(rect.width),' +
    '   height: Math.round(rect.height),' +
    '   viewport: { w: window.innerWidth, h: window.innerHeight },' +
    '   items: top.map(shape),' +
    '   submenuOpen: !!sub,' +
    '   subItems: sub ? Array.prototype.slice.call(sub.querySelectorAll("button.vmenu__item")).map(shape) : []' +
    ' });' +
    '})()'
  )
}

async function probeMenu(win) {
  const raw = await evalInPage(win, 'menuProbe', menuProbeScript())
  return raw === null ? { open: false, probeFailed: true } : JSON.parse(raw)
}

/** 在画面格上真的派发一次右键（`which` = `assigned` | `empty`）。 */
async function rightClickCell(win, which) {
  const source =
    '(() => {' +
    ' const cells = Array.prototype.slice.call(document.querySelectorAll(".camera-wall__cell"));' +
    ' const wantEmpty = ' + JSON.stringify(which === 'empty') + ';' +
    ' const cell = cells.find((candidate) => wantEmpty' +
    '   ? candidate.classList.contains("camera-wall__cell--empty")' +
    '   : !candidate.classList.contains("camera-wall__cell--empty")) || null;' +
    ' if (!cell) return JSON.stringify({ found: false, cells: cells.length });' +
    ' const nameEl = cell.querySelector(".camera-wall__name");' +
    ' const rect = cell.getBoundingClientRect();' +
    ' const x = Math.round(rect.left + Math.min(Math.max(rect.width / 2, 40), 120));' +
    ' const y = Math.round(rect.top + 24);' +
    ' cell.dispatchEvent(new MouseEvent("contextmenu", {' +
    '   bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: x, clientY: y' +
    ' }));' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   wantEmpty: wantEmpty,' +
    '   cellIndex: cells.indexOf(cell),' +
    '   cells: cells.length,' +
    '   deviceName: nameEl ? (nameEl.textContent || "").trim() : "",' +
    '   x: x,' +
    '   y: y' +
    ' });' +
    '})()'
  const raw = await evalInPage(win, 'rightClickCell', source)
  return raw === null ? { found: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/** 点一个菜单项（`scope` = `top` | `sub`），按**渲染出来的标签**匹配。 */
async function clickMenuLabel(win, label, scope) {
  const root = scope === 'sub' ? 'menu.querySelector(".vmenu__submenu")' : 'menu'
  const source =
    '(() => {' +
    ' const menu = document.querySelector(".vmenu");' +
    ' if (!menu) return JSON.stringify({ clicked: false, reason: "no menu" });' +
    ' const root = ' + root + ';' +
    ' if (!root) return JSON.stringify({ clicked: false, reason: "no submenu" });' +
    ' const labelOf = (item) => {' +
    '   const el = item.querySelector(".vmenu__label");' +
    '   if (!el) return "";' +
    '   let out = "";' +
    '   Array.prototype.slice.call(el.childNodes).forEach((node) => {' +
    '     if (node.nodeType === 3) out += node.nodeValue || "";' +
    '   });' +
    '   return out.replace(/\\s+/g, " ").trim();' +
    ' };' +
    ' const items = Array.prototype.slice.call(root.querySelectorAll(":scope > button.vmenu__item"));' +
    ' const target = items.find((item) => labelOf(item) === ' + JSON.stringify(label) + ') || null;' +
    ' if (!target) return JSON.stringify({ clicked: false, reason: "label not found", labels: items.map(labelOf) });' +
    ' const found = labelOf(target);' +
    // 灰显项**不点**（组件本来就会忽略它），而且如实报成「没点成」：一个被点下去的
    // 禁用项如果报告 clicked:true，调用方会以为动作发生过了。
    ' if (target.getAttribute("aria-disabled") === "true") {' +
    '   return JSON.stringify({ clicked: false, reason: "item is disabled", label: found });' +
    ' }' +
    ' target.click();' +
    ' return JSON.stringify({ clicked: true, label: found });' +
    '})()'
  const raw = await evalInPage(win, 'clickMenuLabel', source)
  return raw === null ? { clicked: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * 等到「抓图 / 录像」真的可点（也就是主进程把这一路报成 `playing`）。
 *
 * 为什么需要这一步：`start` 交回的是 `starting`，第一帧到达之后状态才变成
 * `playing`；模型的 `cameraCaptureReadiness()` 只认 `playing`。所以「画面已经出帧」
 * 与「现在能录像」之间隔着一次状态补读。这里等的是**菜单项真的可点**，而不是睡一个
 * 猜出来的秒数 —— 它测的正是操作员会看到的那件事。
 *
 * 成功时菜单保持打开，调用方可以直接展开子菜单。
 */
async function waitForCaptureReady(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = { open: false }
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    await rightClickCell(win, 'assigned')
    await sleep(400)
    last = await probeMenu(win)
    const capture = last.open ? last.items[0] : null
    if (capture && capture.disabled === false) {
      return { ready: true, attempts: attempts, menu: last }
    }
    await pressEscapeOnMenu(win)
    await sleep(700)
  }
  return { ready: false, attempts: attempts, menu: last }
}

/** 在菜单上按 Escape（事件直接派发到菜单元素上，它的 keydown 处理器在那里）。 */
async function pressEscapeOnMenu(win) {
  const source =
    '(() => {' +
    ' const menu = document.querySelector(".vmenu");' +
    ' if (!menu) return JSON.stringify({ pressed: false, reason: "no menu" });' +
    ' menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));' +
    ' return JSON.stringify({ pressed: true });' +
    '})()'
  const raw = await evalInPage(win, 'pressEscape', source)
  return raw === null ? { pressed: false, reason: 'snippet-failed' } : JSON.parse(raw)
}

/** 在菜单外部按一下鼠标（组件监听的是 document 上的 mousedown，含捕获阶段）。 */
async function clickOutsideMenu(win) {
  const source =
    '(() => {' +
    ' const openBefore = !!document.querySelector(".vmenu");' +
    ' document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));' +
    ' return JSON.stringify({ dispatched: true, openBefore: openBefore });' +
    '})()'
  const raw = await evalInPage(win, 'clickOutside', source)
  return raw === null ? { dispatched: false } : JSON.parse(raw)
}

/** 读每一格的录像指示器与逐格结果条（这就是「动作有没有看得见的结果」的证据）。 */
async function readCellNvr(win) {
  const source =
    '(() => {' +
    ' const cells = Array.prototype.slice.call(document.querySelectorAll(".camera-wall__cell"));' +
    ' return JSON.stringify({' +
    '   cells: cells.length,' +
    '   videos: document.querySelectorAll("video").length,' +
    '   badges: cells.map((cell) => {' +
    '     const el = cell.querySelector(".camera-wall__overlay .badge");' +
    '     return el ? (el.textContent || "").trim() : "";' +
    '   }),' +
    '   rec: cells.map((cell) => {' +
    '     const el = cell.querySelector(".camera-wall__rec");' +
    '     return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "";' +
    '   }),' +
    '   notices: cells.map((cell) => {' +
    '     const el = cell.querySelector(".camera-wall__nvr");' +
    '     if (!el) return null;' +
    '     return {' +
    '       text: (el.textContent || "").replace(/\\s+/g, " ").trim(),' +
    '       role: el.getAttribute("role") || "",' +
    '       tone: el.className' +
    '     };' +
    '   })' +
    ' });' +
    '})()'
  const raw = await evalInPage(win, 'readCellNvr', source)
  return raw === null ? { cells: 0, videos: 0, badges: [], rec: [], notices: [] } : JSON.parse(raw)
}

/**
 * 主进程对这台相机的**权威**会话状态。
 *
 * 这是区分两种完全不同的故障的唯一办法：界面说「正在启动」而主进程说 `playing`
 * 是渲染层没刷新（界面在说假话）；主进程也说 `starting` 才是真的还没出帧（此时
 * 抓图/录像被禁用是对的）。没有这次读，两种情况在屏幕上长得一模一样。
 */
async function readLiveStatus(win, deviceId) {
  const source =
    '(async () => { try {' +
    '  const r = await window.api.cameraLive.state(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  const list = r.data || [];' +
    '  return JSON.stringify({' +
    '    ok: true,' +
    '    states: list.map((s) => ({ status: s.status, hasUrl: !!s.url, bytes: s.bytesSent || 0, error: s.error || null }))' +
    '  });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  const raw = await evalInPage(win, 'liveStatus', source)
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/** 当前语言（`document.documentElement.lang`，四种语言各一个标签表）。 */
async function readLocale(win) {
  const raw = await evalInPage(
    win,
    'localeProbe',
    'JSON.stringify({ lang: document.documentElement.lang || "", titles: Array.prototype.slice.call(document.querySelectorAll(".vmenu__title")).length })'
  )
  if (raw === null) return { lang: '' }
  return JSON.parse(raw)
}

/**
 * Describe the camera control panel (`CameraControlPanel.vue`, root class `.cctl`).
 *
 * WHY THIS IS HERE AND NOT IN A UNIT TEST
 * The component was written by one agent and wired into `MonitorView.vue` by
 * another, so neither of them ever saw it render — and an SFC that is imported but
 * never mounted type-checks, builds and is simply absent. Only a running window
 * answers "is it on the screen", which is the same reason this harness exists for
 * `<video>`.
 *
 * It doubles as a real-device read: the mode buttons' `btn--primary` state comes
 * from `GET /run_mode`, so the reported mode is the device's actual setting rather
 * than the component's opinion of it.
 */
function panelScript() {
  return (
    '(() => {' +
    ' const panel = document.querySelector(".cctl");' +
    ' if (!panel) return JSON.stringify({ found: false });' +
    ' const cards = Array.prototype.slice.call(panel.querySelectorAll(".cctl__card"));' +
    ' const buttons = Array.prototype.slice.call(panel.querySelectorAll("button"));' +
    ' const primary = buttons.filter((b) => b.classList.contains("btn--primary"))' +
    '   .map((b) => b.textContent.trim());' +
    ' const disabled = buttons.filter((b) => b.disabled).map((b) => b.textContent.trim());' +
    ' const titles = buttons.map((b) => b.getAttribute("title") || "").filter(Boolean);' +
    ' return JSON.stringify({' +
    '   found: true,' +
    '   cards: cards.length,' +
    '   sectionTitles: Array.prototype.slice.call(panel.querySelectorAll(".section-title"))' +
    '     .map((el) => el.textContent.trim()),' +
    // Row labels are the structural fingerprint of the panel: each control group is a
    // `.cctl__row` with a `.cctl__label`. Reporting them (rather than asserting one
    // hard-coded translated string) keeps this probe locale-independent while still
    // showing a human which controls actually rendered.
    '   rowLabels: Array.prototype.slice.call(panel.querySelectorAll(".cctl__label"))' +
    '     .map((el) => el.textContent.trim()),' +
    '   buttonLabels: buttons.map((b) => b.textContent.trim()).filter(Boolean),' +
    '   primaryButtons: primary,' +
    '   disabledButtons: disabled,' +
    '   buttonTitles: titles.slice(0, 4),' +
    '   alerts: Array.prototype.slice.call(panel.querySelectorAll(".alert"))' +
    '     .map((el) => el.textContent.trim()).slice(0, 3),' +
    '   warnLines: document.querySelectorAll(".cctl__meta--warn").length,' +
    '   text: (panel.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 600)' +
    ' });' +
    '})()'
  )
}

/** One JSON round-trip for the control panel. */
async function probePanel(win) {
  const raw = await evalInPage(win, 'cameraPanel', panelScript())
  return raw === null ? { found: false, probeFailed: true } : JSON.parse(raw)
}

// ---------------------------------------------------------------------------
// 本轮（相机界面）新增的探针：排布几何、应用模式确认框、告警对话框的一行工具栏
//
// 为什么这些也必须在真实窗口里量：本轮三件事里有两件（重排、一行工具栏）是**纯几何**
// 断言。"源码里写了 grid"不等于"屏幕上并排了"，更不等于"窄窗口下没有被裁掉"。
// ---------------------------------------------------------------------------

/**
 * 告警对话框里那一行提示的原文（zh-CN 目录里的 `cameraAlarmUi.subtitle`）。
 *
 * 产品要求把这句话删掉，所以这一轮之后它不应再出现在任何界面里。期望值在这里独立
 * 写一遍：从应用里读出来再和自己比等于什么都没验。
 */
const ALARM_SUBTITLE_ZH_CN = '设备 {name}：告警策略与告警条件（一条策略只关联一个条件）。'

/** 应用模式确认框里的那句正文（同样独立写一遍期望值）。 */
const APP_MODE_WARNING_ZH_CN = '切换模式会清空全部的存储数据，是否继续？'

/**
 * 应用模式确认框的两个按钮文字，四种语言各一份。
 *
 * 与 `MENU_LABELS` 同一条理由：这些值是**独立写下的期望值**，不是为了断言就从应用里
 * 读出来（读出来再和自己比等于什么都没验）。`common.cancel` 在仓库里各语言是：
 * zh-CN 取消 / en Cancel / es Cancelar / tr İptal。
 */
const APP_MODE_DIALOG_LABELS = {
  'zh-CN': { cancel: '取消', warning: APP_MODE_WARNING_ZH_CN },
  en: { cancel: 'Cancel', warning: 'Switching the mode erases all stored data. Continue?' },
  es: { cancel: 'Cancelar', warning: 'Al cambiar el modo se borrarán todos los datos almacenados. ¿Continuar?' },
  tr: { cancel: 'İptal', warning: 'Mod değiştirildiğinde tüm saklanan veriler silinir. Devam edilsin mi?' }
}

function appModeDialogLabels(locale) {
  return APP_MODE_DIALOG_LABELS[locale] || APP_MODE_DIALOG_LABELS['zh-CN']
}

/**
 * 面板的排布几何 + 横向溢出 + 控件裁切。
 *
 * 量的是浏览器算出来的盒子，不是样式表里的声明：
 *   - `boardColumns` 是 `.cctl__board` 解析出来的 `grid-template-columns` 里**实际的
 *     轨道数**（用 `getComputedStyle` 的字符串切出来），它就是"分了几列"的答案；
 *   - `sections` 是每一块的 `x/width`：两块的 `x` 不同 ⇒ 它们在同一行（并排）；
 *     `x` 相同 ⇒ 上下排列。这比读类名可靠得多；
 *   - `overflow` 量的是"有没有横向溢出"：`appContent.scrollWidth > clientWidth` 是
 *     整页级别的证据，`bodyScrollWidth > window.innerWidth` 是窗口级别的；
 *   - `clipped` 逐个可交互控件比 `getBoundingClientRect()` 与窗口边界：宽窗口下被
 *     裁掉的按钮在截图里看不见，只能靠这个数出来。
 */
function layoutScript() {
  return (
    '(() => {' +
    ' const appContent = document.querySelector(".app-content");' +
    ' const page = document.querySelector(".page");' +
    ' const board = document.querySelector(".cctl__board, .camera-board");' +
    ' const round = (n) => Math.round(n);' +
    ' const trackCount = (value) => String(value || "").trim().split(/\\s+/).filter(Boolean).length;' +
    // 一个元素的**内容盒**边界（padding 之内、滚动条之外）。产品要求的"靠左/贴右"
    // 指的是内容盒，不是 padding 盒：padding 盒会把内边距与滚动条算成"空白"。
    ' const contentBox = (el) => {' +
    '   const rect = el.getBoundingClientRect();' +
    '   const style = getComputedStyle(el);' +
    '   const left = rect.left + (parseFloat(style.paddingLeft) || 0);' +
    '   const right = rect.left + el.clientWidth - (parseFloat(style.paddingRight) || 0);' +
    '   return { left: round(left), right: round(right), paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };' +
    ' };' +
    ' const box = (el, name) => {' +
    '   const r = el.getBoundingClientRect();' +
    '   const style = getComputedStyle(el);' +
    '   return {' +
    '     name: name || (el.className || el.tagName).toString().slice(0, 40),' +
    '     label: (el.querySelector("h3, h4, .section-title, .cctl__section-title") || el)' +
    '       .textContent.trim().slice(0, 30),' +
    '     x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height),' +
    '     right: round(r.right), centerY: round(r.top + r.height / 2),' +
    '     gridColumn: style.gridColumnStart + " / " + style.gridColumnEnd' +
    '   };' +
    ' };' +
    ' const boxes = (selector) =>' +
    '   Array.prototype.slice.call(document.querySelectorAll(selector)).map((el) => box(el));' +
    ' const pageRect = page ? page.getBoundingClientRect() : null;' +
    ' const pageBox = page ? contentBox(page) : null;' +
    // 内容盒的左右边界：与 `pageGeometryScript()` 用的是同一个算法（`.page` 自己没有
    // 内边距，所以它的 padding box 就等于内容盒）。与 `.app-content` 比是错的 ——
    // 那个 24px 正是 `.app-content` 的内边距本身。
    ' const appBox = appContent ? {' +
    '   left: round(appContent.getBoundingClientRect().left + (parseFloat(getComputedStyle(appContent).paddingLeft) || 0)),' +
    '   right: round(appContent.getBoundingClientRect().left + appContent.clientWidth' +
    '     - (parseFloat(getComputedStyle(appContent).paddingRight) || 0)),' +
    '   paddingLeft: getComputedStyle(appContent).paddingLeft,' +
    '   paddingRight: getComputedStyle(appContent).paddingRight' +
    ' } : null;' +
    ' const interactive = Array.prototype.slice.call(' +
    '   document.querySelectorAll("button, select, input, [role=tab]")' +
    ' ).filter((el) => {' +
    '   if (el.closest("[role=dialog]")) return false;' +
    '   const r = el.getBoundingClientRect();' +
    '   return r.width > 0 && r.height > 0;' +
    ' });' +
    ' const clipped = interactive.filter((el) => {' +
    '   const r = el.getBoundingClientRect();' +
    '   return r.left < -0.5 || r.right > window.innerWidth + 0.5;' +
    ' }).map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 24));' +
    ' const boardStyle = board ? getComputedStyle(board) : null;' +
    ' const columns = board ? trackCount(boardStyle.gridTemplateColumns) : 0;' +
    ' const boardBox = board ? contentBox(board) : null;' +
    ' return JSON.stringify({' +
    '   found: !!(page && appContent),' +
    '   viewport: { w: window.innerWidth, h: window.innerHeight },' +
    '   page: pageRect ? { left: round(pageRect.left), top: round(pageRect.top), width: round(pageRect.width) } : null,' +
    '   pageContentBox: pageBox,' +
    '   appContentBox: appBox,' +
    '   gapFromContentBoxPx: pageBox && appBox' +
    '     ? { left: pageBox.left - appBox.left, right: appBox.right - pageBox.right } : null,' +
    '   gapFromContentPx: pageRect && appContent' +
    '     ? { left: round(pageRect.left - appContent.getBoundingClientRect().left),' +
    '         top: round(pageRect.top - appContent.getBoundingClientRect().top) }' +
    '     : null,' +
    '   contentClientWidth: appContent ? appContent.clientWidth : null,' +
    '   board: board ? {' +
    '     className: board.className,' +
    '     columns: columns,' +
    '     gridTemplateColumns: boardStyle.gridTemplateColumns,' +
    '     width: round(board.getBoundingClientRect().width),' +
    '     contentBox: boardBox' +
    '   } : null,' +
    '   sections: boxes(".cctl__section"),' +
    '   monitorCards: boxes(".camera-board > .card"),' +
    '   boardChildren: board ? Array.prototype.slice.call(board.children).map((el) => box(el)) : [],' +
    '   panels: boxes(".camera-board__panel"),' +
    '   panelTops: Array.from(new Set(Array.prototype.slice.call(document.querySelectorAll(".camera-board__panel"))' +
    '     .map((el) => round(el.getBoundingClientRect().top)))),' +
    '   sectionColumns: (() => {' +
    '     const map = {};' +
    '     for (const el of document.querySelectorAll(".cctl__section")) {' +
    '       const r = el.getBoundingClientRect();' +
    '       const key = "\u00a7" + round(r.top);' +
    '       map[key] = (map[key] || 0) + 1;' +
    '     }' +
    '     return map;' +
    '   })(),' +
    '   interactiveCount: interactive.length,' +
    '   clipped: clipped,' +
    '   overflow: {' +
    '     appContentScrollWidth: appContent ? appContent.scrollWidth : null,' +
    '     appContentClientWidth: appContent ? appContent.clientWidth : null,' +
    '     bodyScrollWidth: document.body.scrollWidth,' +
    '     windowInnerWidth: window.innerWidth,' +
    '     docScrollWidth: document.documentElement.scrollWidth' +
    '   }' +
    ' });' +
    '})()'
  )
}

/** 一次排布读数。 */
async function probeLayout(win) {
  const raw = await evalInPage(win, 'layout', layoutScript())
  return raw === null ? { found: false, probeFailed: true } : JSON.parse(raw)
}

/**
 * 「应用模式」那三个按钮：找到它们、报告设备当时的 `work_mode`、并**按下去**。
 *
 * 定位方式不靠按钮文字（「局部放电」在页面上出现三次：应用模式按钮、应用场景按钮、
 * 确认框正文）。做法是：先按**已经高亮**的那个按钮落进行，再在该行里找
 * `.cctl__label` —— 那一行就是应用模式那一行。找不到就如实返回 `found:false`，
 * 不去猜第二个候选。
 */
function appModeScript(clickIndex) {
  return (
    '(() => {' +
    ' const panel = document.querySelector(".cctl");' +
    ' if (!panel) return JSON.stringify({ found: false, why: "no .cctl" });' +
    ' const primary = Array.prototype.slice.call(panel.querySelectorAll("button.btn--primary"));' +
    ' let row = null;' +
    ' let label = "";' +
    ' for (const button of primary) {' +
    '   const candidate = button.closest(".cctl__row");' +
    '   if (!candidate) continue;' +
    '   const text = (candidate.querySelector(".cctl__label") || {}).textContent || "";' +
    '   if (text.indexOf("应用模式") !== -1) { row = candidate; label = text.trim(); break; }' +
    ' }' +
    ' if (!row) return JSON.stringify({' +
    '   found: false,' +
    '   why: "no row whose label is 应用模式",' +
    '   primaryLabels: primary.map((b) => b.textContent.trim()),' +
    '   rowLabels: Array.prototype.slice.call(panel.querySelectorAll(".cctl__label")).map((el) => el.textContent.trim())' +
    ' });' +
    ' const buttons = Array.prototype.slice.call(row.querySelectorAll(".cctl__modes button"));' +
    ' const shapes = buttons.map((b) => ({' +
    '   text: b.textContent.trim(),' +
    '   pressed: b.classList.contains("btn--primary"),' +
    '   disabled: b.disabled,' +
    '   title: b.getAttribute("title") || ""' +
    ' }));' +
    ' if (' + clickIndex + ' < 0) return JSON.stringify({ found: true, label: label, buttons: shapes });' +
    ' if (!buttons[' + clickIndex + ']) return JSON.stringify({ found: true, label: label, buttons: shapes, clicked: false });' +
    ' const target = buttons[' + clickIndex + '];' +
    ' target.setAttribute("data-hz-probe", "1");' +
    ' target.click();' +
    ' return JSON.stringify({ found: true, label: label, buttons: shapes, clicked: true, clickedText: target.textContent.trim() });' +
    '})()'
  )
}

async function probeAppMode(win, clickIndex) {
  const raw = await evalInPage(win, 'appMode', appModeScript(clickIndex))
  return raw === null ? { found: false, probeFailed: true } : JSON.parse(raw)
}

/** 确认框出现了吗？正文是哪一句？按钮是什么？ */
function appModeDialogScript() {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ open: false });' +
    ' const panel = panels[panels.length - 1];' +
    ' const body = Array.prototype.slice.call(panel.querySelectorAll("p"))' +
    '   .map((p) => p.textContent.trim()).filter(Boolean);' +
    ' const buttons = Array.prototype.slice.call(panel.querySelectorAll("button"))' +
    '   .map((b) => ({ text: b.textContent.trim(), label: b.getAttribute("aria-label") || "", disabled: b.disabled,' +
    // 确认按钮按**危险样式**而不是文字定位：这个框里有三个按钮（标题栏的关闭图标、
    // 取消、继续切换），文字匹配会挑到标题栏那个空文字的图标按钮。
    '     danger: b.classList.contains("btn--danger"),' +
    '     ghostIcon: b.classList.contains("btn--ghost") && b.classList.contains("btn--icon"),' +
    '     inFooter: !!(panel.querySelector(".panel__footer") && panel.querySelector(".panel__footer").contains(b)) }));' +
    ' const footer = panel.querySelector(".panel__footer");' +
    ' const focused = document.activeElement ?' +
    '   ((document.activeElement.textContent || "").trim().slice(0, 24) || document.activeElement.tagName) : null;' +
    ' return JSON.stringify({' +
    '   open: true,' +
    '   title: (panel.querySelector(".panel__title") || {}).textContent ? panel.querySelector(".panel__title").textContent.trim() : "",' +
    '   body: body,' +
    '   buttons: buttons,' +
    '   footer: !!footer,' +
    '   focused: focused,' +
    '   insideDialog: !!(document.activeElement && panel.contains(document.activeElement))' +
    ' });' +
    '})()'
  )
}

async function probeAppModeDialog(win) {
  const raw = await evalInPage(win, 'appModeDialog', appModeDialogScript())
  return raw === null ? { open: false, probeFailed: true } : JSON.parse(raw)
}

/** 点确认框里那个按钮（**按文字**找，找不到就报出来）。 */
function clickDialogButtonScript(text) {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ clicked: false, why: "no dialog" });' +
    ' const panel = panels[panels.length - 1];' +
    ' const buttons = Array.prototype.slice.call(panel.querySelectorAll("button"));' +
    ' const wanted = ' + JSON.stringify(text) + ';' +
    ' const button = buttons.filter((b) => b.textContent.trim() === wanted)[0];' +
    ' if (!button) return JSON.stringify({' +
    '   clicked: false, why: "no button with that text",' +
    '   labels: buttons.map((b) => b.textContent.trim())' +
    ' });' +
    ' button.click();' +
    ' return JSON.stringify({ clicked: true, text: button.textContent.trim(), fromFooter: !!(panel.querySelector(".panel__footer") && panel.querySelector(".panel__footer").contains(button)) });' +
    '})()'
  )
}

async function clickDialogButton(win, text) {
  const raw = await evalInPage(win, 'clickDialogButton', clickDialogButtonScript(text))
  return raw === null ? { clicked: false, why: 'snippet-failed' } : JSON.parse(raw)
}

/** 应用模式是否仍然弹确认框（取消之后要能再弹一次）。 */
function dialogOpenScript() {
  return 'JSON.stringify({ open: !!document.querySelector("[role=dialog]") })'
}

async function probeDialogOpen(win) {
  const raw = await evalInPage(win, 'dialogOpen', dialogOpenScript())
  return raw === null ? { open: null } : JSON.parse(raw)
}

/** Escape 关掉当前对话框（键盘可操作性的一条证据）。 */
function pressEscapeScript() {
  return (
    '(() => {' +
    ' const before = !!document.querySelector("[role=dialog]");' +
    ' document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
    ' return JSON.stringify({ before: before });' +
    '})()'
  )
}

async function pressEscapeOnDialog(win) {
  const raw = await evalInPage(win, 'pressEscapeDialog', pressEscapeScript())
  return raw === null ? { before: null } : JSON.parse(raw)
}

/**
 * 设备当前的 `work_mode`，**走真机读通道**（不是界面上的文字）。
 *
 * 取消之后必须证明"设备一个字节都没变"，那就只能问设备：界面上的高亮可能只是
 * 上一次读数的副本。返回值里带 `raw` 与归一化后的 `mode`。
 */
function workModeReadScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.cameraControl.readWorkMode(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  const view = (r.data && r.data.view) || {};' +
    '  return JSON.stringify({ ok: true, raw: view.raw === undefined ? null : view.raw, mode: view.mode === undefined ? null : view.mode, available: r.data ? r.data.available : null });' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, threw: String(error && error.message) });' +
    '} })()'
  )
}

async function readWorkMode(win, deviceId) {
  const raw = await evalInPage(win, 'readWorkMode', workModeReadScript(deviceId))
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * 打开告警配置对话框（「告警配置…」按钮就在单路直播那一排里）。
 *
 * 不借用右键菜单：菜单项只在"画面已经解码"时才可用（`captureReadiness`），
 * 那会给这个探针加上一个与它无关的前提。按钮与菜单项走的是同一个
 * `alarmDialogOpen = true`。
 */
function openAlarmDialogScript(label) {
  return (
    '(() => {' +
    ' const buttons = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    ' const button = buttons.filter((b) => b.textContent.trim() === ' + JSON.stringify(label) + ')[0];' +
    ' if (!button) return JSON.stringify({' +
    '   clicked: false,' +
    '   labels: buttons.map((b) => b.textContent.trim()).filter(Boolean).slice(0, 40)' +
    ' });' +
    ' button.click();' +
    ' return JSON.stringify({ clicked: true, text: button.textContent.trim() });' +
    '})()'
  )
}

async function openAlarmDialog(win, label) {
  const raw = await evalInPage(win, 'openAlarmDialog', openAlarmDialogScript(label))
  return raw === null ? { clicked: false, why: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * 告警对话框的几何：那一行工具栏里三个控件的**盒子**，以及刷新图标的位置。
 *
 * 三件事必须靠测量：
 *   1. 「三个控件在同一行」= 三个盒子（切换器那一组、新建按钮、刷新按钮）的垂直中心
 *      相差在容差以内，**而且**每个控件自己内部也没有折行（`topCount === 1`）；
 *   2. 「刷新在最右」= 刷新按钮的右边缘贴着对话框内容区右边缘，而它左边还有那两个；
 *   3. 「图标按钮」= 它没有文字、有一个 `<svg>`、`aria-label` 与 `title` 完全一致。
 * 顺带把对话框的 `subtitle` 证据取出来：内容区里所有 `<p>` 的文本都报出来，
 * 断言层再与那句原文比对（这里不做判断，只把事实带回去）。
 */
function alarmDialogScript() {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ open: false });' +
    ' const panel = panels[panels.length - 1];' +
    ' const round = (n) => Math.round(n);' +
    ' const body = panel.querySelector(".panel__body");' +
    ' const bodyRect = body.getBoundingClientRect();' +
    ' const toolbar = body.querySelector(".toolbar");' +
    ' if (!toolbar) {' +
    '   return JSON.stringify({ open: true, hasToolbar: false, paragraphs: Array.prototype.slice.call(body.querySelectorAll("p")).map((p) => p.textContent.trim()) });' +
    ' }' +
    ' const toolbarRect = toolbar.getBoundingClientRect();' +
    ' const box = (el) => {' +
    '   const r = el.getBoundingClientRect();' +
    '   return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height),' +
    '     centerY: round(r.top + r.height / 2), right: round(r.right) };' +
    ' };' +
    ' const tabsGroup = toolbar.querySelector(".tabs");' +
    ' const tabs = Array.prototype.slice.call(toolbar.querySelectorAll(".tabs button"));' +
    ' const create = Array.prototype.slice.call(toolbar.querySelectorAll("button"))' +
    '   .filter((b) => !b.closest(".tabs") && !b.classList.contains("toolbar__refresh"))[0] || null;' +
    ' const refresh = toolbar.querySelector(".toolbar__refresh");' +
    ' const controls = [];' +
    ' if (tabsGroup) controls.push({ name: "tabs", ...box(tabsGroup) });' +
    ' for (const tab of tabs) controls.push({ name: "tab:" + tab.textContent.trim(), ...box(tab) });' +
    ' if (create) controls.push({ name: "create:" + create.textContent.trim(), ...box(create) });' +
    ' if (refresh) controls.push({ name: "refresh", ...box(refresh) });' +
    ' const rowTops = new Set(controls.map((c) => c.centerY));' +
    ' const refresh2 = refresh ? {' +
    '   text: refresh.textContent.trim(),' +
    '   ariaLabel: refresh.getAttribute("aria-label") || "",' +
    '   title: refresh.getAttribute("title") || "",' +
    '   svgCount: refresh.querySelectorAll("svg").length,' +
    '   pathCount: refresh.querySelectorAll("svg path").length,' +
    '   disabled: refresh.disabled,' +
    // 贴右对齐是相对**内容盒**的：padding 盒会把 body 的内边距（和可能的滚动条）
    // 算成"空白"，那样量到的 14px 其实是 `padding-right: 14px`，不是没对齐。
    '   rightGapPx: round((body.getBoundingClientRect().left + body.clientWidth' +
    '     - (parseFloat(getComputedStyle(body).paddingRight) || 0))' +
    '     - refresh.getBoundingClientRect().right),' +
    '   topGapPx: round(refresh.getBoundingClientRect().top - toolbarRect.top)' +
    ' } : null;' +
    ' return JSON.stringify({' +
    '   open: true,' +
    '   hasToolbar: true,' +
    '   title: (panel.querySelector(".panel__title") || {}).textContent' +
    '     ? panel.querySelector(".panel__title").textContent.trim() : "",' +
    '   controls: controls,' +
    '   centerYs: Array.from(rowTops),' +
    '   rowCount: rowTops.size,' +
    '   toolbarHeight: round(toolbarRect.height),' +
    '   refresh: refresh2,' +
    '   svgInDialog: panel.querySelectorAll("svg").length,' +
    '   paragraphs: Array.prototype.slice.call(body.querySelectorAll("p")).map((p) => p.textContent.trim()),' +
    '   bodyText: (body.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 400)' +
    ' });' +
    '})()'
  )
}

async function probeAlarmDialog(win) {
  const raw = await evalInPage(win, 'alarmDialog', alarmDialogScript())
  return raw === null ? { open: false, probeFailed: true } : JSON.parse(raw)
}

/**
 * 点一下刷新图标，并报出它在按之前/之后的 DOM（"真的重读了"要靠这两次读数）。
 *
 * 「按下去之后按钮变 disabled」是 `load()` 真的在跑的**可观察**证据（`loading` 为真）。
 * 但不能在同一帧里读：Vue 的 DOM 更新是异步批处理的，`loading.value = true` 要等一个
 * 微任务/下一次绘制才落到 DOM 上。所以这里用 `requestAnimationFrame` 等一帧再读，
 * 并且把这一次读数与"读完之后 loading 是否回落"一起报出来 —— 两个值合起来才能说明
 * "起了一次异步工作，然后它结束了"。
 */
function clickRefreshScript() {
  return (
    '(async () => {' +
    ' const button = document.querySelector(".toolbar__refresh");' +
    ' if (!button) return JSON.stringify({ clicked: false, why: "no .toolbar__refresh" });' +
    ' const beforeDisabled = button.disabled;' +
    ' const beforeText = (document.querySelector(".panel__body") || {}).textContent || "";' +
    ' button.click();' +
    ' await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));' +
    ' const afterFrameDisabled = button.disabled;' +
    ' return JSON.stringify({' +
    '   clicked: true,' +
    '   beforeDisabled: beforeDisabled,' +
    '   disabledAfterOneFrame: afterFrameDisabled,' +
    '   releasedLater: !button.disabled,' +
    '   beforeTextLength: beforeText.length' +
    ' });' +
    '})()'
  )
}

async function clickAlarmRefresh(win) {
  const raw = await evalInPage(win, 'clickRefresh', clickRefreshScript())
  return raw === null ? { clicked: false, why: 'snippet-failed' } : JSON.parse(raw)
}

/** 关掉最上层那个对话框（点它的取消按钮）。 */
function closeDialogByCancelScript(cancelText) {
  return (
    '(() => {' +
    ' const panels = Array.prototype.slice.call(document.querySelectorAll("[role=dialog]"));' +
    ' if (panels.length === 0) return JSON.stringify({ closed: true, why: "already closed" });' +
    ' const panel = panels[panels.length - 1];' +
    ' const buttons = Array.prototype.slice.call(panel.querySelectorAll("button"));' +
    ' const button = buttons.filter((b) => b.textContent.trim() === ' + JSON.stringify(cancelText) + ')[0];' +
    ' if (!button) return JSON.stringify({ closed: false, why: "no cancel button", labels: buttons.map((b) => b.textContent.trim()) });' +
    ' button.click();' +
    ' return JSON.stringify({ closed: true });' +
    '})()'
  )
}

async function closeDialogByCancel(win, cancelText) {
  const raw = await evalInPage(win, 'closeDialogCancel', closeDialogByCancelScript(cancelText))
  return raw === null ? { closed: false } : JSON.parse(raw)
}

// ---------------------------------------------------------------------------
// 本轮三个阶段（各自一个函数，`run()` 只负责按顺序调用）
// ---------------------------------------------------------------------------

/** 四档窗口尺寸：大到小都是**请求**值，渲染层报回来的 `innerWidth/Height` 会一起比。 */
const LAYOUT_SIZES = [
  [1280, 720],
  [1366, 768],
  [1920, 1080],
  [2560, 1440]
]

/**
 * 两块屏幕在四档窗口尺寸下的排布几何。
 *
 * 产品要求「重新排布一下」+「用掉可用宽度」+「自适应窗口大小」，这三句话都只能靠
 * 真实窗口里的测量回答：
 *   - 「并排」= 两块的 `x` 不同（同一行）；`x` 相同就是上下堆着；
 *   - 「用掉宽度」= 板子解析出来的轨道数 > 1，最宽那一档必须比最窄那一档多；
 *   - 「没有被裁掉」= 每一个可交互控件的盒子都在窗口内，且整页没有横向溢出；
 *   - 「靠左、与左/上边缘固定距离」= `.page` 与内容盒左边缘的间距（内容盒的内边距）
 *     在四档之间是同一个数，且 `.page` 的左边没有多余的空白。
 *
 * `--observe-only` 那一次**不量**：那一次要证明的是"一个控件都没按，画面自己出来了"，
 * 改窗口大小会把结论搅浑（与 `.page` 四档测量同一条纪律）。
 */
async function measureLayoutSweep(win, panel) {
  if (OBSERVE_ONLY) {
    log('layout sweep  : not measured (--observe-only): this run must not resize the window')
    return
  }
  if (!ROUTE.startsWith('/monitor') || !panel || !panel.found) {
    log('layout sweep  : not measured — no camera control panel on this route')
    return
  }
  const sweep = []
  for (const size of LAYOUT_SIZES) {
    win.setContentSize(size[0], size[1])
    // 一次重排 + 一次布局落定：改分辨率会触发整个内容列的重新计算，读数必须落在稳定
    // 之后，否则量到的是过渡中的数字。
    await sleep(700)
    const measured = await probeLayout(win)
    // 同一档再量一次：两次读数必须一致（除了滚动条相关的取整），否则量到的是"还在
    // 变的布局"，那些数字不能用来下结论。相机页的卡片高度由 `<video>` 的 62vh 与
    // 图表容器一起决定，是这一页最可能"还在变"的地方，所以在这里显式验一次。
    await sleep(900)
    const repeat = await probeLayout(win)
    const stable = JSON.stringify(measured.boardChildren.map((child) => child.height)) ===
      JSON.stringify(repeat.boardChildren.map((child) => child.height))
    if (!stable) {
      problems.push(
        'the ' + size[0] + 'x' + size[1] + ' layout did not settle: two probes 900ms apart report ' +
        'different block heights ' + JSON.stringify(measured.boardChildren.map((child) => child.height)) +
        ' vs ' + JSON.stringify(repeat.boardChildren.map((child) => child.height))
      )
    }
    log(
      'layout ' + size[0] + 'x' + size[1] + ' stable: ' + stable +
      ' (' + JSON.stringify(measured.boardChildren.map((child) => child.height)) + ')'
    )
    log('layout ' + size[0] + 'x' + size[1] + ' : ' + JSON.stringify(measured))
    sweep.push(measured)
  }
  win.setContentSize(1440, 900)
  await sleep(600)

  const leftGaps = []
  for (let i = 0; i < sweep.length; i += 1) {
    const measured = sweep[i]
    const size = LAYOUT_SIZES[i]
    const where = size[0] + 'x' + size[1]
    if (!measured.found) {
      problems.push('the .page/.app-content pair was not found at ' + where + ': ' + JSON.stringify(measured))
      continue
    }
    if (measured.viewport.w !== size[0] || measured.viewport.h !== size[1]) {
      problems.push(
        'asked for a ' + where + ' window but the renderer reports ' +
        measured.viewport.w + 'x' + measured.viewport.h
      )
    }
    // 「靠左」：容器相对**内容盒**没有额外的左边距（多出来的那一截才是居中列的空白）。
    // 用的是 `gapFromContentBoxPx` 而不是 `gapFromContentPx` —— 后者算的是相对
    // `.app-content` **padding 盒**的间距，那个 24px 就是内边距本身（与 `.page` 四档
    // 测量用的是同一个口径）。
    if (measured.gapFromContentBoxPx) leftGaps.push(measured.gapFromContentBoxPx.left)
    if (measured.gapFromContentBoxPx && measured.gapFromContentBoxPx.left > 1) {
      problems.push(
        'at ' + where + ' the .page is pushed ' + measured.gapFromContentBoxPx.left +
        'px away from the content box (left gap), which is where a centred column shows up'
      )
    }
    if (!measured.board) {
      problems.push('at ' + where + ' neither .cctl__board nor .camera-board was found')
    } else if (measured.board.columns < 1) {
      problems.push('at ' + where + ' the layout board resolved to ' + measured.board.columns + ' column(s)')
    }
    // 横向溢出：内容区与文档两个口径都看。
    const overflow = measured.overflow
    if (overflow.appContentScrollWidth > overflow.appContentClientWidth + 1) {
      problems.push(
        'at ' + where + ' the content area overflows horizontally: scrollWidth ' +
        overflow.appContentScrollWidth + ' > clientWidth ' + overflow.appContentClientWidth
      )
    }
    if (overflow.docScrollWidth > overflow.windowInnerWidth + 1) {
      problems.push(
        'at ' + where + ' the document is ' + overflow.docScrollWidth + 'px wide in a ' +
        overflow.windowInnerWidth + 'px window (horizontal scrollbar)'
      )
    }
    // 控件裁切：任何一个可交互控件的盒子越出窗口左右边界都算。
    if (measured.clipped.length > 0) {
      problems.push(
        'at ' + where + ' ' + measured.clipped.length + ' control(s) are clipped by the window edge: ' +
        JSON.stringify(measured.clipped)
      )
    }
    log(
      'layout ' + where + ' counts: ' + JSON.stringify({
        sections: measured.sections.length,
        columns: measured.board ? measured.board.columns : null,
        interactive: measured.interactiveCount,
        clipped: measured.clipped.length
      })
    )
  }
  if (new Set(leftGaps).size > 1) {
    problems.push('the .page left gap from the content box is not constant across window sizes: ' + JSON.stringify(leftGaps))
  }
  const columns = sweep.filter((m) => m.found && m.board).map((m) => m.board.columns)
  log('layout columns: ' + JSON.stringify(columns) + ' for widths ' + JSON.stringify(LAYOUT_SIZES.map((s) => s[0])))
  if (columns.length > 1 && !(columns[columns.length - 1] > columns[0])) {
    problems.push(
      'the layout board did not gain a column with the window: columns ' + JSON.stringify(columns) +
      ' for widths ' + JSON.stringify(LAYOUT_SIZES.map((s) => s[0]))
    )
  }
  // 并排的证据：在**最宽**那一档上，声学图与相机控制这两块面板必须落在**同一行**
  // （`y` 相同、`x` 不同）。只数"板子有几列"是不够的：一列里的两张卡也会让列数看着
  // 正常。所以直接量那两块面板的盒子。
  const widest = sweep[sweep.length - 1]
  const widestSize = LAYOUT_SIZES[LAYOUT_SIZES.length - 1]
  if (widest && widest.found) {
    const panels = widest.panels || []
    if (panels.length < 2) {
      log(
        'side by side  : 未验证 — fewer than two .camera-board__panel elements were found (' +
        panels.length + '); the probes could not identify the two panels'
      )
    } else {
      // 「同一行」量的是 `top`，**不是** `centerY`：`align-items: start` 让同一行里两块
      // 各自按内容高（实测刻意如此），所以高度不同、中心线也不同，但 `top` 相同。
      // 这恰好也是"两块并排"的正确判据。
      const sameRow = new Set(panels.map((panel) => panel.y)).size === 1
      const distinctX = new Set(panels.map((panel) => panel.x)).size === panels.length
      log(
        'side by side  : ' + (sameRow && distinctX) + ' at ' + widestSize.join('x') +
        ' (panel x=' + JSON.stringify(panels.map((panel) => panel.x)) +
        ', y=' + JSON.stringify(panels.map((panel) => panel.y)) +
        ', width=' + JSON.stringify(panels.map((panel) => panel.width)) + ')'
      )
      if (!sameRow || !distinctX) {
        problems.push(
          'at ' + widestSize.join('x') + ' the two camera panels are NOT side by side: ' +
          JSON.stringify(panels.map((panel) => ({ x: panel.x, y: panel.y, width: panel.width })))
        )
      }
    }
  }
}

/**
 * 应用模式切换的确认框：真按按钮、真读设备。
 *
 * 四步都要有证据：
 *   1. 点「应用模式」的**另一个**模式 -> 出现确认框，正文逐字是产品指定的那句；
 *   2. 取消 -> **设备一个字节都没变**（重读 `GET /system` 的 raw 值比对）；
 *   3. 再点一次仍然弹框；这一档用 Escape 关掉 —— 键盘可用，而且 Escape 也不许写设备；
 *   4. 确认 -> 真的写下去（读回来对照）；写完**必须还原**成开始那个值，并重读证明。
 *
 * 取消按钮的文字随当前语言变（`APP_MODE_DIALOG_LABELS`），所以先把语言读出来。
 * 确认按钮的文字不写死：取框里除取消之外第一个可用按钮 —— 但它必须是**页脚里**那个，
 * 否则说明框的结构变了。
 */
async function driveAppModeConfirmation(win, deviceId) {
  const locale = await readLocale(win)
  const labels = appModeDialogLabels(locale.lang === '' ? 'zh-CN' : locale.lang)
  const appMode = await probeAppMode(win, -1)
  log('app mode      : ' + JSON.stringify(appMode))
  if (!appMode.found) {
    problems.push('the 应用模式 (application mode) row was not found: ' + JSON.stringify(appMode))
    return
  }
  const current = appMode.buttons.filter((button) => button.pressed)[0] || null
  const others = appMode.buttons.filter((button) => !button.pressed && !button.disabled)
  const before = await readWorkMode(win, deviceId)
  log('work_mode bef : ' + JSON.stringify(before))
  if (!before.ok) {
    problems.push('could not read work_mode before the dialog test: ' + JSON.stringify(before))
  }
  if (!current) {
    problems.push(
      'no application-mode button is highlighted, so the device value could not be established: ' +
      JSON.stringify(appMode.buttons)
    )
  }
  if (others.length === 0) {
    problems.push('there is no second application mode to switch to: ' + JSON.stringify(appMode.buttons))
  }
  if (!current || others.length === 0) return

  const target = others[0]
  const targetIndex = appMode.buttons.indexOf(target)

  // --- 1) 点它：必须弹确认框，而且正文是产品那一句 --------------------
  await probeAppMode(win, targetIndex)
  await sleep(700)
  const dialog = await probeAppModeDialog(win)
  log('app mode dlg  : ' + JSON.stringify(dialog))
  if (!dialog.open) {
    problems.push('pressing the application-mode button 「' + target.text + '」 did NOT open a confirmation dialog')
  } else {
    if (dialog.body.indexOf(labels.warning) === -1) {
      problems.push(
        'the confirmation dialog does not carry the product wording ' + JSON.stringify(labels.warning) +
        '; it reads ' + JSON.stringify(dialog.body)
      )
    }
    if (!dialog.footer) problems.push('the confirmation dialog has no footer holding the buttons')
    if (!dialog.insideDialog) {
      problems.push('focus is outside the confirmation dialog after it opened: ' + JSON.stringify(dialog.focused))
    }
    log(
      'app mode focus: ' + JSON.stringify({ focused: dialog.focused, insideDialog: dialog.insideDialog })
    )
  }

  // --- 2) 取消：设备必须一个字节都不变 -------------------------------
  const cancelled = await clickDialogButton(win, labels.cancel)
  log('app mode canc : ' + JSON.stringify(cancelled))
  await sleep(1500)
  const stillOpen = await probeDialogOpen(win)
  if (stillOpen.open) problems.push('the confirmation dialog did not close when cancelled')
  const afterCancel = await readWorkMode(win, deviceId)
  log('work_mode canc: ' + JSON.stringify(afterCancel))
  if (!afterCancel.ok) {
    problems.push('could not read work_mode after cancelling: ' + JSON.stringify(afterCancel))
  } else if (afterCancel.raw !== before.raw) {
    problems.push(
      'CANCELLING the dialog changed the device: work_mode ' + String(before.raw) +
      ' -> ' + String(afterCancel.raw)
    )
  }

  // --- 3) 再点一次，用 Escape 关掉 -----------------------------------
  const reopened = await probeAppMode(win, targetIndex)
  await sleep(700)
  const dialog2 = await probeAppModeDialog(win)
  log('app mode dlg2 : ' + JSON.stringify({ clicked: reopened.clicked, open: dialog2.open }))
  if (!dialog2.open) {
    problems.push('the confirmation dialog did not appear the second time')
  } else {
    await pressEscapeOnDialog(win)
    await sleep(900)
    const closedByEscape = await probeDialogOpen(win)
    log('app mode esc  : ' + JSON.stringify(closedByEscape))
    if (closedByEscape.open) problems.push('Escape did not close the confirmation dialog')
    const afterEscape = await readWorkMode(win, deviceId)
    log('work_mode esc : ' + JSON.stringify(afterEscape))
    if (afterEscape.ok && afterEscape.raw !== before.raw) {
      problems.push(
        'closing the dialog with Escape changed the device: work_mode ' + String(before.raw) +
        ' -> ' + String(afterEscape.raw)
      )
    }
  }

  // --- 4) 确认：真的写；写完还原 -------------------------------------
  await probeAppMode(win, targetIndex)
  await sleep(700)
  const dialog3 = await probeAppModeDialog(win)
  if (!dialog3.open) {
    problems.push('the confirmation dialog did not appear before the confirmed write')
    return
  }
  const confirmButton = dialog3.buttons.filter((button) => button.danger && !button.disabled)[0]
  if (!confirmButton) {
    problems.push(
      'the confirmation dialog has no enabled destructive (btn--danger) confirm button: ' +
      JSON.stringify(dialog3.buttons)
    )
    return
  }
  const confirmed = await clickDialogButton(win, confirmButton.text)
  log('app mode conf : ' + JSON.stringify({ label: confirmButton.text, result: confirmed }))
  await sleep(7000)
  const afterConfirm = await readWorkMode(win, deviceId)
  log(
    'work_mode     : ' + String(before.raw) + ' -> requested "' + String(target.text) +
    '" -> device ' + String(afterConfirm.raw)
  )
  log('work_mode conf: ' + JSON.stringify(afterConfirm))
  if (!confirmed.clicked) {
    problems.push('the confirm button could not be pressed: ' + JSON.stringify(confirmed))
  }
  if (afterConfirm.ok && afterConfirm.raw === before.raw) {
    // 不是失败：设备可以拒绝这次写入。但必须**说出来**，因为"确认之后真的写了"
    // 这句话在这种情况下并没有被证明。
    log(
      'app mode write: NOT APPLIED — the device still reports work_mode ' + String(before.raw) +
      ' after the confirmed write; the request path was driven but the device did not change'
    )
  }

  // --- 还原：把开始那个值写回去，并重读证明 ---------------------------
  if (before.raw === null || before.raw === undefined) {
    log('app mode rest : 未验证 — the original work_mode was never read, so nothing could be restored')
    return
  }
  const restoreEntry = appMode.buttons
    .map((button, index) => ({ button, index }))
    .filter((entry) => entry.button.text === current.text)[0]
  if (!restoreEntry) {
    problems.push(
      'could not find the original application-mode button to restore (' + JSON.stringify(current.text) + ')'
    )
    return
  }
  await probeAppMode(win, restoreEntry.index)
  await sleep(700)
  const restoreDialog = await probeAppModeDialog(win)
  if (!restoreDialog.open) {
    // 已经回到原值：组件对"已经在这个模式上"直接返回，本来就不该弹框。这不是失败。
    log('app mode rest : no dialog — the panel already reads the original mode')
  } else {
    const restoreButton = restoreDialog.buttons.filter(
      (button) => button.danger && !button.disabled
    )[0]
    if (!restoreButton) {
      problems.push('the restore confirmation has no enabled destructive confirm button: ' + JSON.stringify(restoreDialog.buttons))
      return
    }
    await clickDialogButton(win, restoreButton.text)
    await sleep(7000)
  }
  const restored = await readWorkMode(win, deviceId)
  log('work_mode back: ' + JSON.stringify(restored))
  if (!restored.ok) {
    problems.push('could not read work_mode after restoring: ' + JSON.stringify(restored))
  } else if (restored.raw !== before.raw) {
    problems.push(
      'THE DEVICE WAS NOT RESTORED: work_mode was ' + String(before.raw) +
      ' at the start and is ' + String(restored.raw) + ' after the restore write'
    )
  }
}

/**
 * 告警配置对话框：提示删掉了、三个控件一行、刷新在最右。
 *
 * 「一行」是**几何**：所有控件的垂直中心必须落在同一条线上（容差 4px），而且切换器
 * 那一组内部的两个按钮也不能折行。刷新图标的证据是 `aria-label === title`、恰好一个
 * `<svg>`、两条 `path`，以及它是那一行里**最靠右**的控件、右边缘贴着对话框内容区。
 *
 * 「刷新真的回设备重读」的证据：按下去之后组件会重新发 IPC（`cameraAlarms.*`），
 * 所以量的是**按之前/之后那两份读数的来源**，不是按钮自己的动画。
 */
async function measureAlarmDialog(win, deviceId) {
  const locale = await readLocale(win)
  const alarmLabel = menuLabels(locale.lang).alarmConfig
  const opened = await openAlarmDialog(win, alarmLabel)
  log('alarm open    : ' + JSON.stringify(opened))
  if (!opened.clicked) {
    problems.push('the 「' + alarmLabel + '」 button was not found, so the dialog could not be measured')
    return
  }
  await sleep(1800)
  const dialog = await probeAlarmDialog(win)
  log('alarm toolbar : ' + JSON.stringify(dialog))
  if (!dialog.open || !dialog.hasToolbar) {
    problems.push('the alarm dialog rendered no .toolbar row: ' + JSON.stringify(dialog))
    return
  }
  const cancelText = (locale.lang === 'zh-CN' ? '取消' : appModeDialogLabels(locale.lang).cancel)
  // 删掉的那一行提示：正文里不许再有它（中文界面按原文比对；其它语言按结构比对 ——
  // 正文段落里不应有任何一句带「设备 …：」前缀的说明）。
  if (locale.lang === 'zh-CN' && dialog.bodyText.indexOf(ALARM_SUBTITLE_ZH_CN) !== -1) {
    problems.push('the alarm dialog still renders the removed notice line: ' + dialog.bodyText.slice(0, 140))
  }
  for (const paragraph of dialog.paragraphs || []) {
    if (paragraph.indexOf('告警策略与告警条件') !== -1) {
      problems.push('an element in the alarm dialog still carries the removed notice line: ' + paragraph)
    }
  }
  const names = dialog.controls.map((control) => control.name)
  for (const wanted of ['tabs', 'refresh']) {
    if (!names.includes(wanted)) {
      problems.push('the alarm toolbar has no ' + wanted + ' control: ' + JSON.stringify(names))
    }
  }
  if (!names.filter((name) => name.indexOf('create:') === 0)[0]) {
    problems.push('the alarm toolbar has no 新建 (create) control: ' + JSON.stringify(names))
  }
  const centers = dialog.controls.map((control) => control.centerY)
  const spread = Math.max.apply(null, centers) - Math.min.apply(null, centers)
  log('alarm row     : ' + JSON.stringify({ centers: centers, rowCount: dialog.rowCount, spreadPx: spread }))
  if (dialog.rowCount !== 1 || spread > 4) {
    problems.push(
      'the alarm toolbar controls are NOT on one row: ' + dialog.rowCount + ' distinct centre line(s), spread ' +
      spread + 'px for ' + JSON.stringify(dialog.controls.map((c) => ({ name: c.name, centerY: c.centerY })))
    )
  }
  const refresh = dialog.refresh
  if (!refresh) {
    problems.push('the alarm toolbar has no .toolbar__refresh button')
    await closeDialogByCancel(win, cancelText)
    return
  }
  if (refresh.text !== '') {
    problems.push('the refresh control still renders text: ' + JSON.stringify(refresh.text))
  }
  if (refresh.ariaLabel === '' || refresh.ariaLabel !== refresh.title) {
    problems.push(
      'the refresh icon has no accessible name, or aria-label and title disagree: ' +
      JSON.stringify({ ariaLabel: refresh.ariaLabel, title: refresh.title })
    )
  }
  if (refresh.svgCount !== 1) {
    problems.push('the refresh control holds ' + refresh.svgCount + ' <svg> element(s), expected exactly 1')
  }
  if (refresh.pathCount < 2) {
    problems.push('the refresh glyph draws ' + refresh.pathCount + ' path(s); a circular arrow needs 2')
  }
  const refreshBox = dialog.controls.filter((box) => box.name === 'refresh')[0]
  const others = dialog.controls.filter((box) => box.name !== 'refresh')
  const rightMost = others.every((box) => box.right <= refreshBox.right)
  log(
    'alarm refresh : ' + JSON.stringify({
      ariaLabel: refresh.ariaLabel,
      title: refresh.title,
      svgCount: refresh.svgCount,
      pathCount: refresh.pathCount,
      rightGapPx: refresh.rightGapPx,
      refreshRight: refreshBox.right,
      othersRight: others.map((box) => box.right)
    })
  )
  if (!rightMost) {
    problems.push(
      'the refresh icon is not at the RIGHT end of the row: its right edge is ' + refreshBox.right +
      ', the other controls end at ' + JSON.stringify(others.map((box) => box.right))
    )
  }
  if (refresh.rightGapPx > 2) {
    problems.push(
      'the refresh icon is ' + refresh.rightGapPx + 'px from the dialog\'s right edge, so it is not flush right'
    )
  }
  // 刷新真的回设备重读：这里的证据是**按下那一同步帧的状态变化**（`load()` 立刻把按钮
  // 置为 disabled，而一次真机往返需要时间）。
  //
  // 为什么不用"给 IPC 装计数器"这种更强的证据：`window.api.cameraAlarms` 是 contextBridge
  // 交出来的**冻结对象**（用一次性探针实测：`Object.isFrozen === true`、`Object.isExtensible
  // === false`，赋值与新增属性都静默失败），渲染层无法插桩。这条限制如实写在这里，免得
  // 下一个人再花一轮去试。
  const deviceRead = await evalInPage(
    win,
    'alarmDeviceRead',
    '(async () => {' +
      ' const s = await window.api.cameraAlarms.listStrategies(' + JSON.stringify(deviceId) + ');' +
      ' const c = await window.api.cameraAlarms.listConditions(' + JSON.stringify(deviceId) + ');' +
      ' return JSON.stringify({' +
      '   ok: s.success && c.success,' +
      '   strategies: s.success ? (s.data.items || []).length : null,' +
      '   conditions: c.success ? (c.data.items || []).length : null' +
      ' });' +
      '})()'
  )
  const clicked = await clickAlarmRefresh(win)
  await sleep(1500)
  const after = await probeAlarmDialog(win)
  log(
    'alarm refresh2: ' + JSON.stringify({
      clicked: clicked,
      stillOpen: after.open,
      paragraphs: after.paragraphs
    })
  )
  log('alarm device  : ' + String(deviceRead))
  if (!clicked.clicked) problems.push('the refresh icon could not be pressed: ' + JSON.stringify(clicked))
  if (!after.open) {
    problems.push('the alarm dialog closed when the refresh icon was pressed')
  }
  // 「回设备重读」的可观察证据：按下去之后**下一帧**按钮必须是 disabled（`load()` 的
  // `loading` 为真），说明这次点击起了异步工作而不是重画一次列表。
  if (clicked.clicked && !clicked.disabledAfterOneFrame) {
    log(
      'alarm re-read  : 未验证 — the refresh button was not disabled on the frame after the click; ' +
      'the device read may already have finished. `window.api.cameraAlarms` is FROZEN (measured: ' +
      'Object.isFrozen === true), so the IPC calls cannot be counted from the renderer either.'
    )
  } else if (clicked.clicked) {
    log(
      'alarm re-read  : the refresh button went disabled on the frame after the click (a device read is ' +
      'in flight: listStrategies + listConditions); `releasedLater` in the line above says whether that ' +
      'read had already finished when the next probe ran'
    )
  }
  const closed = await closeDialogByCancel(win, cancelText)
  log('alarm close   : ' + JSON.stringify(closed))
  await sleep(500)
  if (!closed.closed) {
    problems.push('the alarm dialog could not be closed with its cancel button: ' + JSON.stringify(closed))
  }
}

/** Signed-in session: the real first-run flow, including the forced change. */
async function signIn(win) {
  const source =
    '(async () => { try {' +
    "  const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
    "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
    '  if (!login.data) return JSON.stringify({ step: "no-data", raw: JSON.stringify(login).slice(0, 200) });' +
    '  if (login.data.mustChangePassword) {' +
    '    const changed = await window.api.auth.changePassword({' +
    "      currentPassword: 'Hz@123456', newPassword: 'video-proof-pass' });" +
    "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
    '    return JSON.stringify({ step: "changed" });' +
    '  }' +
    '  return JSON.stringify({ step: "already-signed-in" });' +
    '} catch (error) {' +
    '  return JSON.stringify({' +
    '    step: "threw",' +
    '    message: String(error && error.message),' +
    '    stack: String(error && error.stack).split(String.fromCharCode(10)).slice(0, 4).join(" | ")' +
    '  });' +
    '} })()'
  const raw = await evalInPage(win, 'signIn', source)
  return raw === null ? JSON.stringify({ step: 'snippet-failed' }) : raw
}

/**
 * Add the camera, or return the existing row.
 *
 * A camera's uid is minted from ip:port (it has no identity endpoint), so against
 * a fresh throwaway profile the add path is the normal one and a duplicate is the
 * exception. A failed add is reported with its real error code, never smoothed
 * over — "the camera is not there" must not be mistaken for "video is broken".
 */
async function ensureCamera(win) {
  const source =
    '(async () => { try {' +
    '  const list = await window.api.devices.list();' +
    '  if (!list.success) return JSON.stringify({ step: "list", code: list.error.code });' +
    '  const existing = (list.data || []).filter((d) => d.kind === "acousticCamera");' +
    '  if (existing.length > 0) return JSON.stringify({ step: "existing", id: existing[0].id, name: existing[0].name });' +
    '  const added = await window.api.devices.add({' +
    '    ip: ' + JSON.stringify(IP) + ',' +
    '    httpPort: ' + JSON.stringify(PORT) + ',' +
    '    username: ' + JSON.stringify(USER) + ',' +
    '    password: ' + JSON.stringify(PASSWORD) + ',' +
    '    kind: "acousticCamera"' +
    '  });' +
    '  if (!added.success) return JSON.stringify({ step: "add", code: added.error.code, message: added.error.message || "" });' +
    '  return JSON.stringify({ step: "added", id: added.data.id, name: added.data.name });' +
    '} catch (error) {' +
    '  return JSON.stringify({ step: "threw", message: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'ensureCamera', source)
  return raw === null ? { step: 'snippet-failed' } : JSON.parse(raw)
}

/** Ask the main process for a live session, the same call the UI's button makes. */
async function startStream(win, deviceId) {
  const source =
    '(async () => { try {' +
    '  const r = await window.api.cameraLive.start({ deviceId: ' + JSON.stringify(deviceId) + ' });' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, status: r.data.status, url: r.data.url || null });' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, threw: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'startStream', source)
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * Reload the renderer and wait until the shell is mounted with a loaded device list.
 *
 * This is the step that makes the auto-play test MEANINGFUL, and it took a
 * misleading run to find. The camera is added through the IPC bridge, which
 * bypasses the renderer's Pinia store — so the already-mounted shell keeps showing
 * "no devices added" and every camera-dependent section stays empty. That looked
 * exactly like "auto-play is broken", but it was the harness testing a UI that had
 * never been told the camera exists.
 *
 * Reloading gives a fresh renderer over the SAME main process — which is precisely
 * what launching the application is: the session lives in the main process and
 * survives, the stores re-read from the real database, and auto-play gets to run
 * under the conditions the product describes ("if a camera is working when the
 * software opens, start its video").
 */
async function reloadAndSettle(win, timeoutMs) {
  win.webContents.reload()
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    await sleep(500)
    const bridge = await waitForApi(win, 4000)
    if (bridge === null) continue
    last = await evalInPage(
      win,
      'shellProbe',
      'JSON.stringify({' +
        ' shell: !!document.querySelector(".app-shell"),' +
        ' navItems: document.querySelectorAll(".sidebar__nav .nav-item").length,' +
        ' devices: (document.querySelector(".tree") || {}).textContent' +
        '   ? document.querySelector(".tree").textContent.replace(/\\s+/g, " ").trim().slice(0, 120)' +
        '   : null' +
        '})'
    )
    if (last === null) continue
    const state = JSON.parse(last)
    if (state.shell && state.navItems > 0) return state
  }
  // Always return a parsed object, never a raw string: returning the object on
  // success and the string on timeout is how the caller ended up doing
  // JSON.parse(object) — which fails with the wonderfully unhelpful
  // '"[object Object]" is not valid JSON'.
  return last === null ? null : JSON.parse(last)
}

/**
 * Press one of the wall's layout buttons and report the grid that came back.
 *
 * The owner's request names 1/4/16 explicitly, and a button that renders but changes
 * nothing looks identical to a working one from the outside. So this presses the
 * button, waits a tick for Vue to patch the grid, and re-reads the cell structure.
 *
 * The buttons carry NO TEXT any more (they are grid icons), so the lookup is by
 * ACCESSIBLE NAME: every locale's label starts with the count — `16 分屏`,
 * `16 cells`, `16 celdas`, `16 hücre` — and the leading integer is what is compared.
 * Matching on a text prefix would silently click nothing (or, for `1`, the `16`
 * button); `labelOf` falls back to `title` and to text so an unlabelled icon button
 * is reported as "no button for this layout" rather than as a layout bug.
 */
async function clickLayoutTab(win, count) {
  const source =
    '(() => {' +
    ' const tabs = Array.prototype.slice.call(document.querySelectorAll(".camera-wall .segment__item"));' +
    ' const labelOf = (b) => (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();' +
    ' const countOf = (b) => { const m = /^(\\d+)/.exec(labelOf(b)); return m ? Number(m[1]) : -1; };' +
    ' const tab = tabs.find((b) => countOf(b) === ' + JSON.stringify(count) + ');' +
    ' if (!tab) return JSON.stringify({ clicked: false, labels: tabs.map(labelOf) });' +
    ' const label = labelOf(tab);' +
    ' tab.click();' +
    ' return JSON.stringify({ clicked: true, label: label });' +
    '})()'
  const raw = await evalInPage(win, 'clickLayoutTab', source)
  const result = raw === null ? { clicked: false } : JSON.parse(raw)
  if (!result.clicked) return result
  await sleep(700)
  const ui = await probeUi(win)
  return Object.assign({}, result, ui.cameraWall || {})
}

// ---------------------------------------------------------------------------
// The channel wall's own controls (layout / graph type / disclosure)
// ---------------------------------------------------------------------------

/**
 * Press one of the channel wall's layout buttons, by the layout count.
 *
 * Same lookup rule as the camera wall's (leading integer of the accessible name, so
 * it works in all four locales), but scoped to `.wall__layout` — the graph-type
 * group sits next to it and its labels also start with a digit in some locales.
 */
async function clickChannelLayout(win, count) {
  const source =
    '(() => {' +
    ' const group = document.querySelector(".wall__layout");' +
    ' if (!group) return JSON.stringify({ clicked: false, labels: [] });' +
    ' const tabs = Array.prototype.slice.call(group.querySelectorAll("button"));' +
    ' const labelOf = (b) => (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();' +
    ' const countOf = (b) => { const m = /^(\\d+)/.exec(labelOf(b)); return m ? Number(m[1]) : -1; };' +
    ' const tab = tabs.find((b) => countOf(b) === ' + JSON.stringify(count) + ');' +
    ' if (!tab) return JSON.stringify({ clicked: false, labels: tabs.map(labelOf) });' +
    ' const label = labelOf(tab);' +
    ' tab.click();' +
    ' return JSON.stringify({ clicked: true, label: label });' +
    '})()'
  const raw = await evalInPage(win, 'clickChannelLayout', source)
  const result = raw === null ? { clicked: false } : JSON.parse(raw)
  if (!result.clicked) return result
  await sleep(700)
  const ui = await probeUi(win)
  return Object.assign({}, result, {
    channelWall: ui.channelWall || null,
    channelWallLayout: ui.channelWallLayout || null
  })
}

/**
 * Press one of the channel wall's graph-type buttons, BY INDEX.
 *
 * Index rather than label on purpose: the four labels are translated, but the ORDER
 * is `CHANNEL_GRAPH_KINDS` (声纹图 / 声压线 / 频谱图 / 时谱图) in every locale, and
 * the probe logs the labels it actually found so the report can be read without
 * trusting the order. `expectedLabel` is compared only as evidence, never as a
 * requirement (a translator may reword it).
 */
async function clickChannelGraph(win, index) {
  const source =
    '(() => {' +
    ' const group = document.querySelector(".wall__graph");' +
    ' if (!group) return JSON.stringify({ clicked: false, labels: [] });' +
    ' const tabs = Array.prototype.slice.call(group.querySelectorAll("button"));' +
    ' const labels = tabs.map((b) => (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim());' +
    ' const tab = tabs[' + JSON.stringify(index) + '];' +
    ' if (!tab) return JSON.stringify({ clicked: false, labels: labels });' +
    ' tab.click();' +
    ' return JSON.stringify({ clicked: true, label: labels[' + JSON.stringify(index) + '] || "", labels: labels });' +
    '})()'
  const raw = await evalInPage(win, 'clickChannelGraph', source)
  const result = raw === null ? { clicked: false } : JSON.parse(raw)
  if (!result.clicked) return result
  await sleep(700)
  const ui = await probeUi(win)
  return Object.assign({}, result, { channelWall: ui.channelWall || null })
}

/**
 * Press the channel wall's disclosure (收起 / 展开).
 *
 * The button is icon-only, so this reads `aria-expanded` BEFORE and AFTER and
 * returns both: "the wall collapsed" is a state, "pressing it changed the state" is
 * the thing that makes the control work, and one number cannot show both.
 */
async function pressChannelDisclosure(win) {
  const source =
    '(() => {' +
    ' const button = document.querySelector(".card.wall .wall__disclosure");' +
    ' if (!button) return JSON.stringify({ pressed: false });' +
    ' const before = button.getAttribute("aria-expanded");' +
    ' const labelBefore = button.getAttribute("aria-label") || "";' +
    ' button.click();' +
    ' return JSON.stringify({ pressed: true, before: before, labelBefore: labelBefore });' +
    '})()'
  const raw = await evalInPage(win, 'pressChannelDisclosure', source)
  const result = raw === null ? { pressed: false } : JSON.parse(raw)
  if (!result.pressed) return result
  await sleep(500)
  const ui = await probeUi(win)
  const wall = ui.channelWall || null
  return Object.assign({}, result, {
    after: wall && wall.disclosure ? wall.disclosure.expanded : null,
    labelAfter: wall && wall.disclosure ? wall.disclosure.label : '',
    collapsed: wall ? wall.collapsed : null,
    cells: wall && wall.grid ? wall.grid.cells : 0
  })
}

/**
 * «有没有「这一路此刻正在告警」的实时推送» —— 在真实窗口里测一遍。
 *
 * 为什么必须实测：这一轮格子上写的是「**最近**告警」（读本地告警库），而不是
 * 「**正在**告警」。这个措辞本身是一个关于**契约**的断言：如果设备/主进程其实推了
 * 每通道的告警状态，那句措辞就保守得没必要；如果没推，写「正在告警」就是编造。
 * 读源码（`PushChannels`、`DeviceStatusEvent`）已经有了答案，但源码不是运行时证据，
 * 所以这里**订阅 `window.events` 上全部推送**，把这一趟真正到达渲染层的每一条都
 * 记下它的**字段名集合**与计数。
 *
 * 订阅的是 preload 已经暴露的那一组（不是新加的接口），每个订阅各自 try/catch：
 * 一路订阅不上不该影响其它路，也不该让这一段成为探针的失败点。
 */
async function startPushProbe(win) {
  const source =
    '(() => { try {' +
    '  const keysOf = (o) => (o && typeof o === "object") ? Object.keys(o).sort() : [];' +
    '  const seen = {};' +
    '  const names = Object.keys(window.events || {}).sort();' +
    '  window.__hzPushProbe = { names: names, seen: seen };' +
    '  for (const name of names) {' +
    '    try {' +
    '      window.events[name]((payload) => {' +
    '        const entry = seen[name] || (seen[name] = { count: 0, keySets: [], sample: null, itemKeys: "" });' +
    '        entry.count += 1;' +
    '        const ks = keysOf(payload).join(",");' +
    '        if (entry.keySets.indexOf(ks) === -1) entry.keySets.push(ks);' +
    '        if (entry.sample === null) {' +
    '          entry.itemKeys = keysOf((payload && payload.items && payload.items[0]) || null).join(",");' +
    '          try { entry.sample = JSON.stringify(payload).slice(0, 200); } catch (e) { entry.sample = "unserialisable"; }' +
    '        }' +
    '      });' +
    '    } catch (error) { seen[name] = { count: -1, keySets: [], sample: "subscribe-failed", itemKeys: "" }; }' +
    '  }' +
    '  return JSON.stringify({ ok: true, names: names });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  const raw = await evalInPage(win, 'startPushProbe', source)
  return raw === null ? { ok: false } : JSON.parse(raw)
}

/** 把 push 探针这一趟收到的推送读回来（字段名集合 + 计数）。 */
async function readPushProbe(win) {
  const source =
    '(() => { try {' +
    '  if (!window.__hzPushProbe) return JSON.stringify({ ok: false, why: "not-installed" });' +
    '  return JSON.stringify({ ok: true, names: window.__hzPushProbe.names, seen: window.__hzPushProbe.seen });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  const raw = await evalInPage(win, 'readPushProbe', source)
  return raw === null ? { ok: false } : JSON.parse(raw)
}

/**
 * 报告 push 探针的读数：一条一条打印**字段名集合**，并给出「有没有每通道告警字段」的结论。
 *
 * **必须在页面刷新之前调用**：偏好持久化那一段会 `location.reload()`，渲染层里装的订阅
 * 会随页面一起消失（`window.__hzPushProbe` 也没了）。`pushProbeReported` 保证只写一条
 * finding，`--observe-only`（不刷新）在收尾时再调一次。
 */
let pushProbeReported = false
async function reportPushProbe(win, when) {
  if (pushProbeReported) return null
  pushProbeReported = true

  const pushReport = await readPushProbe(win)
  log('push seen (' + when + '): ' + JSON.stringify(pushReport))
  if (!pushReport.ok) {
    log('push seen     : 未验证 — push 探针没有装起来或读不回来：' + JSON.stringify(pushReport))
    return pushReport
  }

  /**
   * 判据要分清两件事：**带通道号**不等于**带每通道告警状态**。
   *
   * 相机那几路帧（`fa371-stream:*`）本来就带 `channelId`/`channels`（相机推的是某一路的
   * 预览），它们与「这一路此刻在不在告警」毫无关系。真正要问的是：有没有哪一条推送
   * **同时**带通道号和告警字段（`alarm*` / `abno*`）。只有那种才说明「正在告警」可写。
   */
  const channelOnly = []
  const alarmPush = []
  const entries = Object.entries(pushReport.seen || {})
  for (const [name, entry] of entries) {
    const keySets = (entry && entry.keySets) || []
    const alarmish = /alarm|abno/i
    const channelish = /channel|ch_id|chid/i
    const hasAlarm = keySets.some((keySet) => alarmish.test(keySet)) || alarmish.test(entry.sample || '')
    const hasChannel = keySets.some((keySet) => channelish.test(keySet))
    const described = name + ' -> [' + keySets.join(' | ') + ']'
    if (hasAlarm && hasChannel) alarmPush.push(described)
    else if (hasChannel) channelOnly.push(described)
    log('  push ' + name + ': ' + entry.count + ' frame(s), key set(s) [' + keySets.join(' | ') + ']' +
      (entry.itemKeys ? ', item keys [' + entry.itemKeys + ']' : '') +
      ', first=' + JSON.stringify(String(entry.sample || '').slice(0, 120)))
  }

  if (entries.length === 0) {
    log('push seen     : 未验证 — 本趟运行一条推送都没收到（可能没有发生状态变化）')
    return pushReport
  }
  if (alarmPush.length === 0) {
    findings.push(
      '本趟运行没有任何一条推送**同时**带通道号与告警字段：' +
      entries.map(([name, entry]) => name + '(' + entry.count + ')').join(', ') +
      (channelOnly.length > 0
        ? '；只带通道号的那几条是相机帧、与告警无关（' + channelOnly.join(' ; ') + '）'
        : '') +
      ' —— 与「通道墙上只能写最近告警、不能写正在告警」一致（每通道实时告警状态在契约里没有来源）'
    )
  } else {
    findings.push('有推送同时带了通道号与告警字段，需要重新判断「正在告警」是否可写：' + alarmPush.join(' ; '))
  }
  return pushReport
}

/**
 * 通道墙该渲染哪几档 —— 按**设备真实的通道数**（`GET /get_passageway` 的行数）。
 *
 * 与 `lib/channelWall.ts` 的 `channelWallLayouts()` 是同一套规则，这里**故意独立写
 * 一遍**：让「界面渲染出来的档位」与「探针从通道表算出来的档位」成为两个可以互相
 * 印证的来源（写死成 [1,2,4,8] 就永远发现不了裁剪那件事）。
 *
 * `channelCount` 为 0 / undefined（本次运行里没有声纹设备）时返回全部档位：未知不裁剪。
 */
function expectedChannelLayouts(channelCount) {
  const all = [1, 2, 4, 8]
  const count = Number(channelCount)
  if (!Number.isFinite(count) || count <= 0) return all
  const options = all.filter((layout) => layout <= count)
  const covering = all.find((layout) => layout >= count)
  if (covering !== undefined && options.indexOf(covering) === -1) options.push(covering)
  return options
}

/** 布局按钮的无障碍名字里的前导数字（`2 分屏` / `2 panes` / …）。 */
function layoutCountOf(label) {
  const match = /^(\d+)/.exec(String(label || '').trim())
  return match ? Number(match[1]) : -1
}

/**
 * 等分段控件把档位渲染到应有的那一组。
 *
 * 刷新之后通道表要重新读一遍（`stores/devices.ts` 的 `loadChannels()`，主进程还要
 * 去设备上取一次通道表），档位集合在那一刻会先短暂地是「全部档位」再收窄。不等它
 * 稳定就断言，会把一次正常的异步过程报成「档位不对」。
 */
async function waitForLayoutOptions(win, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const ui = await probeUi(win)
    last = ui.channelWallLayout
    const counts = last ? last.buttons.map((button) => layoutCountOf(button.label)) : []
    if (counts.join(',') === expected.join(',')) return { ok: true, layout: last, counts: counts }
    await sleep(500)
  }
  return {
    ok: false,
    layout: last,
    counts: last ? last.buttons.map((button) => layoutCountOf(button.label)) : []
  }
}

/**
 * Start the camera's acoustic WebSocket session — the SAME IPC call the 相机声学数据
 * panel's own 「开始接收」 button makes, and the only way this wall can be given real
 * voiceprint / FFT data to draw.
 *
 * The WALL never does this (it is a read-only surface; opening a device socket is a
 * device operation with an administrator guard in the main process). The harness does
 * it because the owner's question for this round is "which graph types can actually
 * be produced from live data" and that cannot be answered with the session stopped.
 * It is deliberately NOT done under `--observe-only`: that run promises that no
 * control was pressed and that the Overview's own auto-play produced the picture.
 */
async function startCameraAcoustic(win, deviceId) {
  const source =
    '(async () => { try {' +
    '  const kinds = window.api.fa371Stream.kinds();' +
    '  const r = await window.api.fa371Stream.start({ deviceId: ' + JSON.stringify(deviceId) + ', kinds: kinds });' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, running: r.data.running });' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, threw: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'startCameraAcoustic', source)
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/** The camera's acoustic session as the MAIN process reports it (frame counts included). */
async function readCameraAcoustic(win, deviceId) {
  const source =
    '(async () => { try {' +
    '  const r = await window.api.fa371Stream.state(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  const one = (r.data || [])[0] || null;' +
    '  if (!one) return JSON.stringify({ ok: true, session: null });' +
    '  return JSON.stringify({ ok: true, session: {' +
    '    running: one.running,' +
    '    streams: one.streams.map((s) => ({ kind: s.kind, state: s.state, frames: s.frameCount, error: s.lastError || "" }))' +
    '  } });' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, threw: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'readCameraAcoustic', source)
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/** Stop the camera's acoustic session again (leave no socket open behind the run). */
async function stopCameraAcoustic(win, deviceId) {
  const source =
    '(async () => { try {' +
    '  const r = await window.api.fa371Stream.stop(' + JSON.stringify(deviceId) + ');' +
    '  return JSON.stringify({ ok: r.success === true, code: r.success ? "" : r.error.code });' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, threw: String(error && error.message) });' +
    '} })()'
  const raw = await evalInPage(win, 'stopCameraAcoustic', source)
  return raw === null ? { ok: false, threw: 'snippet-failed' } : JSON.parse(raw)
}

/**
 * The frame count the main process reports for one stream kind, or -1 when the
 * session/stream is not there. Used to decide what a tile MUST show: with frames
 * arriving, an empty tile would be a defect; without them, an honest note is right.
 */
function acousticFrames(state, kind) {
  const streams = state && state.session ? state.session.streams || [] : []
  const found = streams.find((stream) => stream.kind === kind)
  return found ? found.frames : -1
}

/**
 * Poll the renderer until `check(channelWall)` says yes, or the budget runs out.
 *
 * Returns the last channel-wall snapshot (and the layout control beside it) either
 * way, so a failure prints the DOM it ended on instead of just a timeout.
 */
async function waitForChannelWall(win, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let last = null
  let layout = null
  while (attempts === 0 || Date.now() < deadline) {
    attempts += 1
    const ui = await probeUi(win)
    last = ui.channelWall || null
    layout = ui.channelWallLayout || null
    if (last && check(last)) return { ok: true, wall: last, layout: layout, attempts: attempts }
    if (Date.now() >= deadline) break
    await sleep(500)
  }
  return { ok: false, wall: last, layout: layout, attempts: attempts }
}

/**
 * The whole run, in one try/catch.
 *
 * executeJavaScript rejects opaquely and, with no catch, the rejection escapes
 * `whenReady().then(...)` as an unhandled rejection: the harness then prints
 * nothing useful and never exits, which looks exactly like a hang.
 */
/**
 * 一个**真的** TCP SMTP 服务器，只在探针进程里活着（一次性 profile，端口随机）。
 *
 * 为什么不用真 SMTP 服务器：本机没有凭据，而"测试邮件按钮到底通没通"是一个必须
 * 有人回答的问题。立一个真的 stub 就能回答它并且**如实**：信封里的收件人、DATA 段
 * 的字节、SMTP 的逐行回复都读得回来，所以报告里写的是"这封邮件真的发到了 127.0.0.1
 * 的这个端口"，而不是"按钮点下去了"。
 *
 * 与 `tests/alarm-linkage.test.ts` 里那个 stub 同一套协议（EHLO/MAIL/RCPT/DATA/QUIT），
 * 但这里是主进程里的独立实现：探针不 import 测试代码。
 */
function startStubSmtp() {
  const sessions = []
  const server = net.createServer((socket) => {
    const session = { commands: [], data: '' }
    sessions.push(session)
    let inData = false
    let buffer = ''
    socket.write('220 probe-stub ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\r\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 OK queued\r\n')
            continue
          }
          session.data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
          continue
        }
        session.commands.push(line)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) {
          socket.write('250-probe-stub\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n')
        } else if (upper.startsWith('HELO')) {
          socket.write('250 probe-stub\r\n')
        } else if (upper.startsWith('AUTH PLAIN') || upper.startsWith('AUTH LOGIN')) {
          socket.write('235 2.7.0 accepted\r\n')
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n')
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n')
        } else if (upper === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else if (upper.startsWith('RSET') || upper.startsWith('NOOP')) {
          socket.write('250 OK\r\n')
        } else {
          socket.write('500 unrecognised\r\n')
        }
      }
    })
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        sessions,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

/**
 * 把一个**完整的函数表达式**（`(async () => { … })()` 那种）交给页面执行。
 *
 * `fnBody` 由调用方写成 `(...)()` —— 不再包一层，否则会出现 `(() => {…})())()`
 * 这种括号不匹配的源码，而 `vm.Script` 会在探针**自己**的日志里报一句
 * "Script failed to execute"，看不出是哪一段。这个包装同时把失败收敛成
 * `{ probeFailed: true, error }`，让一次探针跑完剩下的检查，而不是在第一个
 * 语法错误处中断（中断会掩盖后面那些**已经测到**的事实）。
 */
async function measure(win, label, source, fallback) {
  const raw = await evalInPage(win, label, String(source))
  if (raw === null) return Object.assign({ probeFailed: true }, fallback || {})
  try {
    return JSON.parse(raw)
  } catch (error) {
    return Object.assign(
      { parseFailed: String(error && error.message), raw: String(raw).slice(0, 200) },
      fallback || {}
    )
  }
}

/**
 * 点一个选择器指向的元素（先滚进视野，让点击落在它真在的位置上）。
 *
 * 用 `el.click()` 而不是合成鼠标事件：这些控件都是原生 `<button>` / `<input>`，
 * `click()` 会触发与真实鼠标点击相同的默认行为，而 Vue 的 `@click` 监听器在冒泡阶段
 * 收到它。滚动是为了让 `getBoundingClientRect()` 有意义 —— 探针报告的是"按钮在不在、
 * 可不可用"，而不是"它在不在视口内"。
 */
function clickSelectorScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ clicked: false, reason: 'not found', selector: ${JSON.stringify(selector)} });
    el.scrollIntoView({ block: 'center' });
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const rect = el.getBoundingClientRect();
    if (!disabled) el.click();
    return JSON.stringify({
      clicked: !disabled,
      disabled: disabled,
      visible: rect.width > 0 && rect.height > 0,
      title: el.getAttribute('title') || '',
      selector: ${JSON.stringify(selector)}
    });
  })()`
}

/**
 * 通过**真正的键盘事件**往一个输入框里打字：聚焦 -> 全选 -> 逐个字符 `sendInputEvent`。
 *
 * ⚠ 为什么不用「原生 setter + dispatchEvent」那套（踩过一次，浪费了一轮）：
 * Vue 的 `v-model` 在 `input` 事件里先比 `el._value === el.value`，相等就不发
 * `update:modelValue`；而 `HTMLInputElement` 的 value setter **同时会更新 `_value`**。
 * 结果那套写法在 v-model 上是**静默失效**的：DOM 里是新值、Vue 状态里还是旧值。
 * 探针因此在「密码长度」上读到上一次尝试留下的 5，并把一次本来合法的提交报成
 * 「密码不能包含用户名」。
 *
 * `webContents.sendInputEvent` 是 Chromium 自己的输入路径：按键真的走一遍
 * beforeinput/input，Vue 看到的就是它在真实使用中会看到的东西。代价是只能
 * 逐个字符地送，而且非 ASCII 字符的 `keyCode` 要单独给 —— 见下面。
 */
async function typeInto(win, label, selector, value, index) {
  const useIndex = typeof index === 'number'
  const locate = useIndex
    ? `const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];`
    : `const el = document.querySelector(${JSON.stringify(selector)});`
  const focused = await evalJson(
    win,
    label + '_focus',
    `(() => {
      ${locate}
      if (!el) return JSON.stringify({ ok: false, reason: 'not found', selector: ${JSON.stringify(selector)}, index: ${useIndex ? index : 'null'} });
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (typeof el.select === 'function') el.select();
      return JSON.stringify({ ok: true, focused: document.activeElement === el, before: el.value });
    })()`,
    {}
  )
  if (focused.ok !== true) return { ok: false, step: 'focus', detail: focused }

  /**
   * 空字符串 = **清空**（`el.select()` 之后按一次 Delete）。
   *
   * 没有这一步的话，「打 0 个字符」什么也不做，而调用方会以为字段被清空了 ——
   * 一个"清空收件人 2"的探针就会静默地留下 `from` 事件之前的值。
   */
  if (String(value) === '') {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' })
    await sleep(150)
    const cleared = await evalJson(
      win,
      label + '_cleared',
      `(() => {
        ${locate}
        return JSON.stringify({ ok: true, value: el ? el.value : null, length: el ? el.value.length : 0 });
      })()`,
      {}
    )
    return Object.assign({ ok: true, typed: 0, before: focused.before }, cleared)
  }

  for (const character of String(value)) {
    const upper = character.toUpperCase()
    /**
     * `keyCode` 对一个 ASCII 字符就是它自己（大写）；其它字符（中文、空格用 'Space'）
     * 走单独的分支。`char` 才是真正被插入的文本，所以非 ASCII 也能打进去。
     */
    let keyCode = character
    if (character === ' ') keyCode = 'Space'
    else if (upper.length === 1 && upper >= 'A' && upper <= 'Z') keyCode = upper
    else if (character >= '0' && character <= '9') keyCode = character
    else if (upper.length === 1 && ',./;[]-=`'.includes(character)) keyCode = 'OEM'
    else keyCode = 'Unidentified'
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'char', keyCode: character })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(12)
  }
  await sleep(120)
  const after = await evalJson(
    win,
    label + '_after',
    `(() => {
      ${locate}
      return JSON.stringify({ ok: true, value: el ? el.value : null, length: el ? el.value.length : 0 });
    })()`,
    {}
  )
  return Object.assign({ ok: true, typed: String(value).length, before: focused.before }, after)
}

/**
 * 往**新增账户表单**里打字：按 `form` 内部的输入框**下标**定位。
 *
 * 为什么不用 CSS 选择器：那套 `[data-permissions=create] input[type=text]` 在这个页面上
 * 一次都没匹配到（`data-permissions` 那个 div 与它所在的 `<form>` 之间没有嵌套关系，
 * 见模板里 `form > .form-grid > .permissions`），而按下标定位不需要猜结构：
 * 第 0 个是用户名、第 1 个是显示名、最后一个是密码。
 */
async function typeIntoCreateForm(win, label, index, value) {
  return typeInto(win, label, '[data-section=account-management] form input', value, index)
}

/** 新增账户表单是否开着（一个 `[data-permissions=create]` 元素就够了）。 */
async function createFormOpen(win, label) {
  return measure(
    win,
    label,
    `(async () => {
      const form = document.querySelector('[data-permissions=create]');
      const list = await window.api.auth.listUsers();
      return JSON.stringify({
        open: !!form,
        inputs: form ? form.closest('form').querySelectorAll('input').length : 0,
        userCount: list.success ? (list.data || []).length : -1
      });
    })()`,
    {}
  )
}

/**
 * 往一个 Vue 绑定的输入框里写值：用原生 setter + input/change 事件。
 *
 * 只用于**探针不想依赖键盘**的场合（例如一个 `v-model` 之外的普通输入）。v-model
 * 的输入框请用 `typeInto`（见它上面那段说明）。
 */
function setInputScript(selector, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: 'not found', selector: ${JSON.stringify(selector)} });
    el.scrollIntoView({ block: 'center' });
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: true, value: el.value });
  })()`
}

/** 勾/取消勾一个复选框，并把它的新状态读回来。 */
function setCheckboxScript(selector, checked) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: 'not found', selector: ${JSON.stringify(selector)} });
    el.scrollIntoView({ block: 'center' });
    if (el.checked !== ${checked ? 'true' : 'false'}) el.click();
    return JSON.stringify({ ok: true, checked: el.checked, disabled: el.disabled === true });
  })()`
}

/**
 * 这一轮：设置页（`/settings`）—— 账号管理、告警声音库、邮件设置、恢复默认。
 *
 * 为什么每一件事都要在**真实窗口**里量：这四块全是"画出来 + 真的写进主进程"的功能。
 * 一个权限复选框可以渲染得很好而根本不落库；一个"发送测试邮件"按钮可以在没有服务器时
 * 也弹一个绿色提示（本探针就是用一个真的本地 SMTP stub 来排除这种可能）；一个"恢复默认"
 * 可以把设备一起清掉而对话框上写着不会。这些只有读 DOM + 读 IPC 回包 + 读数据库侧事实
 * 才能分辨。
 *
 * 所有会改到**用户配置**的动作都遵守同一条纪律：先记原值，做完立刻还原，再读回证明。
 * 这个探针跑在一次性 profile 里，但同一套纪律对真实 profile 也成立。
 */
async function measureSettingsRoute(win, camera) {
  log('--- /settings：账号管理、告警声音库、邮件设置、恢复默认 ---')

  // --- 1) 页面结构 ------------------------------------------------------
  const page = await measure(
    win,
    'settingsPage',
    `(async () => { try {
      const q = (s) => document.querySelector(s);
      const vis = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { width: Math.round(r.width), height: Math.round(r.height), display: style.display, visibility: style.visibility };
      };
      const payload = {
        title: q('.page-title') ? String(q('.page-title').textContent).trim() : '',
        accountCard: vis(q('[data-section=account-management]')),
        soundCard: vis(q('[data-section=alarm-sound]')),
        emailCard: vis(q('[data-section=email-settings]')),
        restoreButton: vis(q('[data-action=restore-defaults]')),
        accountTable: !!q('[data-table=accounts]'),
        soundTable: !!q('[data-table=alarm-sounds]'),
        soundRows: document.querySelectorAll('[data-table=alarm-sounds] tbody tr').length,
        portValue: q('[data-field=smtp-port]') ? String(q('[data-field=smtp-port]').value) : null,
        securityValue: q('[data-field=smtp-security]') ? String(q('[data-field=smtp-security]').value) : null,
        receivers: document.querySelectorAll('[data-field^=smtp-receiver-]').length,
        audioElements: document.querySelectorAll('audio').length,
        videoElements: document.querySelectorAll('video').length,
        videoWithSrc: Array.prototype.slice.call(document.querySelectorAll('video')).filter((v) => v.currentSrc || v.src).length
      };
      return JSON.stringify(payload);
    } catch (error) { return JSON.stringify({ threw: String(error && error.message) }); } })()`,
    {}
  )
  log('settings page : ' + JSON.stringify(page))
  if (!page.accountCard || page.accountCard.height === 0) problems.push('/settings 没有渲染账号管理卡片')
  if (!page.soundCard || page.soundCard.height === 0) problems.push('/settings 没有渲染告警声音库卡片')
  if (!page.emailCard || page.emailCard.height === 0) problems.push('/settings 没有渲染邮件设置卡片')
  if (!page.restoreButton || page.restoreButton.height === 0) problems.push('/settings 没有渲染「恢复默认值」按钮')
  if (page.soundRows !== 6) problems.push('告警声音库应有 6 种预定义声音，实际 ' + page.soundRows + ' 行')
  if (page.receivers !== 3) problems.push('邮件收件人应为 3 个槽位，实际 ' + page.receivers)
  if (String(page.portValue) !== '25') problems.push('邮件端口默认应为 25（手册第 5466 行），实际 ' + page.portValue)
  // 每个 <video> 都必须有地址（本页没有播放器，所以这一条本来就是 0/0）。
  if (page.videoElements !== page.videoWithSrc) {
    problems.push('设置页有 ' + page.videoElements + ' 个 <video>，其中 ' + page.videoWithSrc + ' 个有地址')
  }
  if (page.audioElements > 1) {
    problems.push('没有点试听时页面上不应有 <audio>（地址守卫失守）：' + page.audioElements)
  }

  // --- 2) 账号列表渲染 ---------------------------------------------------
  const accountsBefore = await measure(
    win,
    'accountsBefore',
    `(async () => {
      const r = await window.api.auth.listUsers();
      if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });
      const rows = Array.prototype.slice.call(document.querySelectorAll('[data-table=accounts] tbody tr[data-account]'));
      const adminRow = rows.filter((tr) => tr.getAttribute('data-account') === 'admin')[0] || null;
      const adminDelete = adminRow ? adminRow.querySelector('[data-delete-account=admin]') : null;
      const adminDeleteStyle = adminDelete ? getComputedStyle(adminDelete) : null;
      return JSON.stringify({
        ok: true,
        apiCount: (r.data || []).length,
        renderedRows: rows.map((tr) => tr.getAttribute('data-account')),
        adminDeleteDisabled: adminDelete ? adminDelete.disabled === true : null,
        adminDeleteTitle: adminDelete ? (adminDelete.getAttribute('title') || '') : '',
        adminDeleteOpacity: adminDeleteStyle ? adminDeleteStyle.opacity : null,
        adminDeleteCursor: adminDeleteStyle ? adminDeleteStyle.cursor : null
      });
    })()`,
    {}
  )
  log('accounts      : ' + JSON.stringify(accountsBefore))
  if (!accountsBefore.ok) problems.push('账号列表读不到：' + JSON.stringify(accountsBefore))
  else {
    if (accountsBefore.apiCount < 1) problems.push('账号列表为空（应至少有出厂管理员）')
    if (accountsBefore.renderedRows.indexOf('admin') === -1) {
      problems.push('账号表格里没有 admin 行：' + JSON.stringify(accountsBefore.renderedRows))
    }
    if (accountsBefore.adminDeleteDisabled !== true) {
      problems.push('内置管理员的删除按钮应是禁用的，实际 disabled=' + accountsBefore.adminDeleteDisabled)
    }
    if (!accountsBefore.adminDeleteTitle) problems.push('内置管理员删除按钮没有说明原因（title 为空）')
  }

  // --- 3) 新增账户（用户名非法 / 密码过短 / 成功） -------------------------
  const openCreate = await evalJson(win, 'openCreate', clickSelectorScript('[data-section=account-management] .section-header .btn--primary'), {})
  log('open create   : ' + JSON.stringify(openCreate))
  await sleep(300)

  const badName = await measure(
    win,
    'createBadName',
    `(async () => {
      const form = document.querySelector('[data-permissions=create]').closest('form');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const write = (el, value) => {
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      write(form.querySelector('input[type=text]'), 'bad/name');
      write(form.querySelector('input[type=password]'), 'good-password');
      form.querySelector('button[type=submit]').click();
      await new Promise((done) => setTimeout(done, 500));
      const alert = document.querySelector('[data-section=account-management] .alert--danger');
      const list = await window.api.auth.listUsers();
      return JSON.stringify({
        message: alert ? alert.textContent.trim() : '',
        formStillOpen: !!document.querySelector('[data-permissions=create]'),
        count: list.success ? (list.data || []).length : -1
      });
    })()`,
    {}
  )
  log('bad username  : ' + JSON.stringify(badName))
  if (!badName.message) problems.push('含 "/" 的用户名没有被拒绝（界面上没有出现错误提示）')
  if (badName.count !== accountsBefore.apiCount) {
    problems.push('含非法字符的用户名被创建了：账号数 ' + accountsBefore.apiCount + ' -> ' + badName.count)
  }

  /**
   * 上一次提交被拒绝之后新增表单仍然开着（错误提示就在它旁边）。这里**先确认它开着**，
   * 而不是假设 —— 一个被拒绝的提交如果顺带把表单收起来，后面的赋值会写到一个
   * 不存在的输入框上，而那些失败看起来会像"密码规则没生效"。
   */
  const ensureCreateOpen = await measure(
    win,
    'ensureCreateOpen',
    `(() => {
      const open = !!document.querySelector('[data-permissions=create]');
      if (open) return JSON.stringify({ opened: true, clicked: false });
      const button = document.querySelector('[data-section=account-management] .section-header .btn--primary');
      if (!button) return JSON.stringify({ opened: false, clicked: false });
      button.click();
      return JSON.stringify({ opened: true, clicked: true });
    })()`,
    {}
  )
  log('create form   : ' + JSON.stringify(ensureCreateOpen))
  await sleep(300)

  /** 新增表单里的输入框清单（按**渲染顺序**），下标由它决定而不是猜。 */
  const createInputs = await measure(
    win,
    'createInputs',
    `(() => {
      const panel = document.querySelector('[data-permissions=create]');
      if (!panel) return JSON.stringify({ found: false });
      const form = panel.closest('form');
      const inputs = Array.prototype.slice.call(form.querySelectorAll('input'));
      return JSON.stringify({
        found: true,
        total: inputs.length,
        inputs: inputs.map((el, index) => ({
          index: index,
          type: el.type,
          model: el.getAttribute('data-permission') || (el.getAttribute('v-model') || ''),
          name: el.name || '',
          checked: el.type === 'checkbox' ? el.checked : null,
          valueLength: el.type === 'checkbox' ? null : el.value.length
        }))
      });
    })()`,
    { found: false }
  )
  log('create inputs : ' + JSON.stringify(createInputs))
  const CREATE_INDEX = {}
  if (createInputs.found) {
    // 用户名/显示名 = 前两个 text；密码 = **最后一个** password。
    const texts = createInputs.inputs.filter((entry) => entry.type === 'text')
    const passwords = createInputs.inputs.filter((entry) => entry.type === 'password')
    CREATE_INDEX.username = texts[0] ? texts[0].index : 0
    CREATE_INDEX.displayName = texts[1] ? texts[1].index : 1
    CREATE_INDEX.password = passwords.length ? passwords[passwords.length - 1].index : createInputs.total - 1
  }
  log('create index  : ' + JSON.stringify(CREATE_INDEX))

  const shortPassword = await (async () => {
    // 前一次的提交让用户名留着 `bad/name`，先清空再真的用键盘打字（见 `typeInto`）。
    const clearedUser = await typeIntoCreateForm(win, 'shortPwdClearUser', CREATE_INDEX.username, '')
    const typedUser = await typeIntoCreateForm(win, 'shortPwdUser', CREATE_INDEX.username, 'probe-acc')
    const typedPassword = await typeIntoCreateForm(win, 'shortPwdPassword', CREATE_INDEX.password, '12345')
    const submitted = await measure(
      win,
      'createShortPassword',
      `(async () => {
        const form = document.querySelector('[data-permissions=create]').closest('form');
        form.querySelector('button[type=submit]').click();
        await new Promise((done) => setTimeout(done, 500));
        const alert = document.querySelector('[data-section=account-management] .alert--danger');
        const list = await window.api.auth.listUsers();
        return JSON.stringify({
          message: alert ? alert.textContent.trim() : '',
          formStillOpen: !!document.querySelector('[data-permissions=create]'),
          count: list.success ? (list.data || []).length : -1
        });
      })()`,
      {}
    )
    return Object.assign({ clearedUser, typedUser, typedPassword }, submitted)
  })()
  log('short pwd     : ' + JSON.stringify(shortPassword))
  if (!shortPassword.message) problems.push('5 位密码没有被拒绝（界面上没有出现错误提示）')
  if (shortPassword.count !== accountsBefore.apiCount) {
    problems.push('5 位密码的账户被创建了：账号数 ' + accountsBefore.apiCount + ' -> ' + shortPassword.count)
  }

  // 勾一项写入类权限，再提交一个合法账户。
  const granted = await evalJson(
    win,
    'createGrantPermission',
    setCheckboxScript('[data-permissions=create] input[data-permission=configureDevices]', true),
    {}
  )
  log('grant perm    : ' + JSON.stringify(granted))
  if (granted.ok !== true) problems.push('新增表单里的权限复选框点不动：' + JSON.stringify(granted))

  const typedValid = await typeIntoCreateForm(win, 'createValidPassword', CREATE_INDEX.password, 'pr0be-str0ng-pass')
  const typedValidUser = await typeIntoCreateForm(win, 'createValidUser', CREATE_INDEX.username, 'probe-acc')
  const created = await measure(
    win,
    'createValid',
    `(async () => {
      const form = document.querySelector('[data-permissions=create]') ? document.querySelector('[data-permissions=create]').closest('form') : null;
      if (!form) return JSON.stringify({ step: 'no-form' });
      const password = form.querySelector('input[type=password]');
      const text = form.querySelector('input[type=text]');
      const values = {
        username: text ? text.value : null,
        passwordLength: password ? password.value.length : null
      };
      const disabledBefore = form.querySelector('button[type=submit]').disabled;
      form.querySelector('button[type=submit]').click();
      await new Promise((done) => setTimeout(done, 1200));
      const bad = document.querySelector('[data-section=account-management] .alert--danger');
      const good = document.querySelector('[data-section=account-management] .alert--success');
      const list = await window.api.auth.listUsers();
      const users = list.success ? (list.data || []) : [];
      const one = users.filter((u) => u.username === 'probe-acc')[0] || null;
      const rows = Array.prototype.slice.call(document.querySelectorAll('[data-table=accounts] tbody tr[data-account]'));
      return JSON.stringify({
        values: values,
        submitDisabledBefore: disabledBefore,
        error: bad ? bad.textContent.trim() : '',
        notice: good ? good.textContent.trim() : '',
        formStillOpen: !!document.querySelector('[data-permissions=create]'),
        count: users.length,
        created: !!one,
        configureDevices: one && one.permissions ? one.permissions.configureDevices : null,
        viewDevices: one && one.permissions ? one.permissions.viewDevices : null,
        manageDevices: one && one.permissions ? one.permissions.manageDevices : null,
        rendered: rows.map((tr) => tr.getAttribute('data-account'))
      });
    })()`,
    { rendered: [] }
  )
  log('created       : ' + JSON.stringify(created))
  if (!created.created) problems.push('合法账户没有被创建：' + JSON.stringify(created))
  if (typedValid.ok !== true || typedValid.value !== 'pr0be-str0ng-pass') {
    problems.push('探针没能把密码打进输入框：' + JSON.stringify(typedValid))
  }
  if (created.configureDevices !== true) {
    problems.push('新增时勾选的 configureDevices 没有生效：' + String(created.configureDevices))
  }
  if (created.viewDevices !== true) problems.push('操作员的只读默认权限 viewDevices 没有生效')
  if (created.manageDevices !== false) problems.push('操作员不该默认拥有 manageDevices')
  if (!Array.isArray(created.rendered) || created.rendered.indexOf('probe-acc') === -1) {
    problems.push('新增的账户没有出现在表格里：' + JSON.stringify(created.rendered))
  }

  // --- 4) 编辑：权限勾选、从…复制权限、恢复默认权限 ------------------------
  const editOpen = await evalJson(
    win,
    'openEdit',
    `(() => {
      const row = document.querySelector('[data-table=accounts] tbody tr[data-account=probe-acc]');
      if (!row) return JSON.stringify({ clicked: false, reason: 'no row' });
      const buttons = Array.prototype.slice.call(row.querySelectorAll('button'));
      const target = buttons[0];
      target.scrollIntoView({ block: 'center' });
      target.click();
      return JSON.stringify({ clicked: true, label: target.textContent.trim() });
    })()`,
    {}
  )
  log('open edit     : ' + JSON.stringify(editOpen))
  await sleep(400)
  const editorOpen = await measure(
    win,
    'editorOpen',
    `(() => JSON.stringify({
      editor: !!document.querySelector('[data-editor=probe-acc]'),
      checkboxes: document.querySelectorAll('[data-permissions=edit] input[data-permission]').length,
      copySelect: !!document.querySelector('[data-copy-from]')
    }))()`,
    {}
  )
  log('editor        : ' + JSON.stringify(editorOpen))
  if (!editorOpen.editor) problems.push('点「编辑账户」没有展开编辑器')
  if (editorOpen.checkboxes !== 12) {
    problems.push('权限复选框应有 12 项，实际 ' + editorOpen.checkboxes)
  }
  if (!editorOpen.copySelect) problems.push('编辑器里没有「从…复制权限」下拉框')

  const toggleOn = await evalJson(
    win,
    'togglePermission',
    setCheckboxScript('[data-permissions=edit] input[data-permission=deleteRecordings]', true),
    {}
  )
  await sleep(200)
  const toggleOff = await evalJson(
    win,
    'togglePermissionOff',
    setCheckboxScript('[data-permissions=edit] input[data-permission=deleteRecordings]', false),
    {}
  )
  log('toggle perm   : on=' + JSON.stringify(toggleOn) + ' off=' + JSON.stringify(toggleOff))
  if (toggleOn.ok !== true || toggleOn.checked !== true) problems.push('权限复选框勾不上')
  if (toggleOff.ok !== true || toggleOff.checked !== false) problems.push('权限复选框取消勾选无效')

  // 「从…复制权限」：从 admin 复制（管理员专属项按规则进不来）。
  const copyFrom = await measure(
    win,
    'copyFromAdmin',
    `(() => {
      const select = document.querySelector('[data-copy-from]');
      if (!select) return JSON.stringify({ ok: false, reason: 'no select' });
      const option = Array.prototype.slice.call(select.options).filter((o) => o.value !== '')[0] || null;
      if (!option) return JSON.stringify({ ok: false, reason: 'no option' });
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-permissions=edit] .permissions__head button'));
      const copyButton = buttons.filter((b) => b.textContent.indexOf('复制') !== -1)[0] || null;
      if (!copyButton) return JSON.stringify({ ok: false, reason: 'copy button disabled', labels: buttons.map((b) => b.textContent.trim()) });
      copyButton.click();
      return JSON.stringify({ ok: true, from: option.textContent.trim(), button: copyButton.textContent.trim() });
    })()`,
    {}
  )
  await sleep(300)
  const afterCopy = await measure(
    win,
    'afterCopy',
    `(() => {
      const checked = (key) => {
        const el = document.querySelector('[data-permissions=edit] input[data-permission=' + key + ']');
        return el ? el.checked : null;
      };
      const notice = document.querySelector('[data-section=account-management] .alert--success');
      const danger = document.querySelector('[data-section=account-management] .alert--danger');
      return JSON.stringify({
        manageAccounts: checked('manageAccounts'),
        manageSystemSettings: checked('manageSystemSettings'),
        configureDevices: checked('configureDevices'),
        controlCameras: checked('controlCameras'),
        deleteRecordings: checked('deleteRecordings'),
        notice: notice ? notice.textContent.trim() : '',
        danger: danger ? danger.textContent.trim() : '',
        allChecked: Array.prototype.slice.call(document.querySelectorAll('[data-permissions=edit] input[data-permission]')).map((el) => el.getAttribute('data-permission') + '=' + el.checked)
      });
    })()`,
    {}
  )
  log('copy from     : ' + JSON.stringify(copyFrom) + ' -> ' + JSON.stringify(afterCopy))
  if (copyFrom.ok !== true) problems.push('「从…复制权限」点不动：' + JSON.stringify(copyFrom))
  if (afterCopy.manageAccounts === true || afterCopy.manageSystemSettings === true) {
    problems.push('从管理员复制把「管理员专属」权限勾给了操作员：' + JSON.stringify(afterCopy))
  }
  if (afterCopy.controlCameras !== true) problems.push('从管理员复制没有勾上 controlCameras（管理员是全权）')

  // 「恢复该用户默认权限」：回到只读四项。
  const restorePerm = await measure(
    win,
    'restoreDefaultPermission',
    `(() => {
      const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-permissions=edit] .permissions__head button'));
      const target = buttons.filter((b) => b.textContent.indexOf('默认') !== -1)[0] || buttons[1] || null;
      if (!target) return JSON.stringify({ ok: false, reason: 'no button' });
      target.click();
      const checked = (key) => {
        const el = document.querySelector('[data-permissions=edit] input[data-permission=' + key + ']');
        return el ? el.checked : null;
      };
      return JSON.stringify({
        ok: true,
        button: target.textContent.trim(),
        viewDevices: checked('viewDevices'),
        controlCameras: checked('controlCameras'),
        configureDevices: checked('configureDevices')
      });
    })()`,
    {}
  )
  log('default perm  : ' + JSON.stringify(restorePerm))
  if (restorePerm.ok !== true) problems.push('「恢复该用户默认权限」点不动：' + JSON.stringify(restorePerm))
  if (restorePerm.controlCameras !== false || restorePerm.configureDevices !== false) {
    problems.push('恢复默认权限之后写入类权限仍然勾着：' + JSON.stringify(restorePerm))
  }
  if (restorePerm.viewDevices !== true) problems.push('恢复默认权限之后只读权限丢了')

  // 保存这次编辑（把 deleteRecordings 勾上并落库），再读回证明。
  await evalJson(
    win,
    'editGrantAgain',
    setCheckboxScript('[data-permissions=edit] input[data-permission=deleteRecordings]', true),
    {}
  )
  const saved = await evalJson(win, 'saveAccount', clickSelectorScript('[data-save-account=probe-acc]'), {})
  log('save account  : ' + JSON.stringify(saved))
  await sleep(900)
  const afterSave = await measure(
    win,
    'afterSave',
    `(async () => {
      const r = await window.api.auth.listUsers();
      const one = (r.success ? r.data : []).filter((u) => u.username === 'probe-acc')[0] || null;
      return JSON.stringify({
        deleteRecordings: one && one.permissions ? one.permissions.deleteRecordings : null,
        viewDevices: one && one.permissions ? one.permissions.viewDevices : null,
        editorStillOpen: !!document.querySelector('[data-editor=probe-acc]')
      });
    })()`,
    {}
  )
  log('after save    : ' + JSON.stringify(afterSave))
  if (afterSave.deleteRecordings !== true) {
    problems.push('编辑保存之后 deleteRecordings 没有落库：' + String(afterSave.deleteRecordings))
  }
  if (afterSave.editorStillOpen) problems.push('保存之后编辑器没有收起')

  // --- 5) 删除账户 -------------------------------------------------------
  const deleteOpen = await evalJson(win, 'askDelete', clickSelectorScript('[data-delete-account=probe-acc]'), {})
  await sleep(300)
  const deleteConfirmOpen = await measure(
    win,
    'deleteConfirmOpen',
    `(() => JSON.stringify({ open: !!document.querySelector('[data-delete-confirm=probe-acc]') }))()`,
    {}
  )
  const deleteDone = await measure(
    win,
    'confirmDelete',
    `(async () => {
      const row = document.querySelector('[data-delete-confirm=probe-acc]');
      if (!row) return JSON.stringify({ ok: false, reason: 'no confirm row' });
      row.querySelector('.btn--danger').click();
      await new Promise((done) => setTimeout(done, 900));
      const r = await window.api.auth.listUsers();
      const users = r.success ? (r.data || []) : [];
      return JSON.stringify({
        stillThere: users.filter((u) => u.username === 'probe-acc').length > 0,
        count: users.length,
        rendered: Array.prototype.slice.call(document.querySelectorAll('[data-table=accounts] tbody tr[data-account]')).map((tr) => tr.getAttribute('data-account'))
      });
    })()`,
    {}
  )
  log('delete        : ' + JSON.stringify(deleteOpen) + ' ' + JSON.stringify(deleteConfirmOpen) + ' ' + JSON.stringify(deleteDone))
  if (deleteOpen.clicked !== true) problems.push('删除按钮点不动：' + JSON.stringify(deleteOpen))
  if (deleteConfirmOpen.open !== true) problems.push('删除没有弹出确认行')
  if (deleteDone.stillThere) problems.push('删除之后账户仍然存在')
  if (Array.isArray(deleteDone.rendered) && deleteDone.rendered.indexOf('probe-acc') !== -1) {
    problems.push('删除之后表格里仍然有那一行')
  }
  if (deleteDone.count !== accountsBefore.apiCount) {
    problems.push('删除之后的账号数与开始时不一致：' + accountsBefore.apiCount + ' -> ' + deleteDone.count)
  }

  // --- 6) 告警声音库：选择 .wav、试听、Add 自定义、删除自定义 ----------------
  // 真的写两个 WAV 文件到磁盘（一个合法、一个非 wav），这样"选择文件"与"试听"是在
  // 真东西上做的。文件写在探针的输出目录里，用完删掉。
  const wavDir = path.join(OUT, '_alarm-sound')
  fs.mkdirSync(wavDir, { recursive: true })
  const goodWav = path.join(wavDir, 'probe-tone.wav')
  const badFile = path.join(wavDir, 'probe-tone.mp3')
  writeProbeWav(goodWav)
  fs.writeFileSync(badFile, 'not a wav at all')

  // 「选择文件」走的是原生对话框，探针**不能**替用户点它；所以这里直接把设置对象
  // 提交上去，再用界面读回 —— 界面的"选文件"按钮本身只证明它可点（下面 report 里说明）。
  const soundPickable = await measure(
    win,
    'soundPickable',
    `(() => {
      const buttons = Array.prototype.slice.call(document.querySelectorAll('[data-table=alarm-sounds] [data-pick-sound]'));
      const previews = Array.prototype.slice.call(document.querySelectorAll('[data-table=alarm-sounds] [data-preview-sound]'));
      const clears = Array.prototype.slice.call(document.querySelectorAll('[data-table=alarm-sounds] [data-clear-sound]'));
      const deletes = Array.prototype.slice.call(document.querySelectorAll('[data-table=alarm-sounds] [data-delete-sound]'));
      const customs = document.querySelectorAll('[data-sound-custom=yes]').length;
      return JSON.stringify({
        pick: buttons.length,
        pickEnabled: buttons.filter((b) => !b.disabled).length,
        preview: previews.length,
        previewDisabledBeforeFile: previews.filter((b) => b.disabled).length,
        clearDisabledBeforeFile: clears.filter((b) => b.disabled).length,
        deleteEnabled: deletes.filter((b) => !b.disabled).length,
        customs: customs
      });
    })()`,
    {}
  )
  log('sound buttons : ' + JSON.stringify(soundPickable))
  if (soundPickable.pick !== 6) problems.push('六种预定义声音每行都应有「选择文件」，实际 ' + soundPickable.pick)
  if (soundPickable.previewDisabledBeforeFile !== 6) {
    problems.push('没有文件时试听按钮应该是禁用的（否则会出现一个没有源的播放器）')
  }
  if (soundPickable.deleteEnabled !== 0) {
    problems.push('预定义声音的删除按钮应全部禁用，实际可点 ' + soundPickable.deleteEnabled + ' 个')
  }

  const setSound = await measure(
    win,
    'setSoundFile',
    `(async () => {
      const r = await window.api.settings.get();
      if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });
      const library = JSON.parse(JSON.stringify(r.data.alarmSounds));
      const item = library.items.filter((i) => i.id === 'motionDetection')[0];
      item.filePath = ${JSON.stringify(goodWav)};
      item.fileName = ${JSON.stringify(path.basename(goodWav))};
      const saved = await window.api.settings.update({ alarmSounds: library });
      if (!saved.success) return JSON.stringify({ ok: false, step: 'update', code: saved.error.code });
      return JSON.stringify({ ok: true, filePath: saved.data.alarmSounds.items.filter((i) => i.id === 'motionDetection')[0].filePath });
    })()`,
    {}
  )
  log('set sound     : ' + JSON.stringify(setSound))
  if (setSound.ok !== true) problems.push('写入告警声音文件失败：' + JSON.stringify(setSound))

  // 非 .wav：主进程的归一化器必须把那一格清掉。
  const rejectNonWav = await measure(
    win,
    'rejectNonWav',
    `(async () => {
      const r = await window.api.settings.get();
      const library = JSON.parse(JSON.stringify(r.data.alarmSounds));
      const item = library.items.filter((i) => i.id === 'videoLoss')[0];
      item.filePath = ${JSON.stringify(badFile)};
      item.fileName = ${JSON.stringify(path.basename(badFile))};
      const saved = await window.api.settings.update({ alarmSounds: library });
      if (!saved.success) return JSON.stringify({ ok: false, code: saved.error.code });
      const after = saved.data.alarmSounds.items.filter((i) => i.id === 'videoLoss')[0];
      return JSON.stringify({ ok: true, filePath: after.filePath, fileName: after.fileName });
    })()`,
    {}
  )
  log('non-wav       : ' + JSON.stringify(rejectNonWav))
  if (rejectNonWav.filePath !== '') {
    problems.push('非 .wav 的文件被写进了设置：' + JSON.stringify(rejectNonWav))
  }

  await reloadAndSettle(win, 20000)
  await sleep(1200)

  const preview = await measure(
    win,
    'previewSound',
    `(async () => {
      const button = document.querySelector('[data-table=alarm-sounds] [data-preview-sound=motionDetection]');
      if (!button) return JSON.stringify({ ok: false, reason: 'no preview button' });
      if (button.disabled) return JSON.stringify({ ok: false, reason: 'disabled' });
      button.scrollIntoView({ block: 'center' });
      button.click();
      await new Promise((done) => setTimeout(done, 1200));
      const audio = document.querySelector('[data-preview-player]');
      return JSON.stringify({
        ok: true,
        audioRendered: !!audio,
        srcScheme: audio ? (audio.src || '').split(':')[0] : '',
        srcHasWav: audio ? (audio.src || '').toLowerCase().indexOf('.wav') !== -1 : false,
        errorCode: audio && audio.error ? audio.error.code : null,
        paused: audio ? audio.paused : null,
        readyState: audio ? audio.readyState : null,
        videosWithoutSrc: Array.prototype.slice.call(document.querySelectorAll('video')).filter((v) => !v.currentSrc && !v.src).length
      });
    })()`,
    {}
  )
  log('preview       : ' + JSON.stringify(preview))
  if (preview.ok !== true) problems.push('试听点不动：' + JSON.stringify(preview))
  if (preview.ok === true && !preview.audioRendered) problems.push('点试听之后没有渲染出 <audio> 播放器')
  if (preview.ok === true && !preview.srcHasWav) problems.push('试听播放器的地址不是那个 .wav：' + String(preview.srcScheme))

  // Add 自定义 + 双击改名 + 删除。
  const addCustom = await evalJson(win, 'addCustomSound', clickSelectorScript('[data-action=add-custom-sound]'), {})
  await sleep(400)
  const renameState = await measure(
    win,
    'customRenameState',
    `(() => {
      const input = document.querySelector('[data-rename-input]');
      const customs = Array.prototype.slice.call(document.querySelectorAll('[data-sound-custom=yes]'));
      return JSON.stringify({
        renameInputRendered: !!input,
        customs: customs.length,
        customId: customs.length ? customs[0].getAttribute('data-sound-id') : null,
        deleteEnabled: customs.length ? !customs[0].querySelector('[data-delete-sound]').disabled : null
      });
    })()`,
    {}
  )
  log('add custom    : ' + JSON.stringify(addCustom) + ' ' + JSON.stringify(renameState))
  if (addCustom.clicked !== true) problems.push('「添加自定义声音」点不动：' + JSON.stringify(addCustom))
  if (!renameState.renameInputRendered) problems.push('新增自定义声音之后没有进入改名输入框')
  if (renameState.deleteEnabled !== true) problems.push('自定义声音的删除按钮应是可用的')

  const renamed = await (async () => {
    // 真的用键盘打字（见 `typeInto` 上关于 `v-model` 的说明），再用回车提交改名。
    const typed = await typeInto(win, 'renameCustomSound', '[data-rename-input]', 'probe-custom-sound')
    await evalJson(
      win,
      'renameCustomCommit',
      `(() => {
        const input = document.querySelector('[data-rename-input]');
        if (!input) return JSON.stringify({ ok: false, reason: 'input gone (already committed)' });
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return JSON.stringify({ ok: true });
      })()`,
      {}
    )
    // 提交之后那一行变回 `<span data-rename-target>`；等一次渲染再读它。
    await sleep(400)
    const read = await measure(
      win,
      'renameCustomRead',
      `(() => {
        const target = document.querySelector('[data-rename-target]');
        const input = document.querySelector('[data-rename-input]');
        return JSON.stringify({
          ok: true,
          name: target ? target.textContent.trim() : null,
          inputStillOpen: !!input
        });
      })()`,
      {}
    )
    return Object.assign({ typed: typed.value }, read)
  })()
  log('rename custom : ' + JSON.stringify(renamed))
  if (renamed.name !== 'probe-custom-sound') {
    problems.push('自定义声音改名没有生效：' + JSON.stringify(renamed))
  }

  // 保存库（把自定义项落库），再读回。
  const saveSounds = await evalJson(win, 'saveAlarmSounds', clickSelectorScript('[data-action=save-alarm-sounds]'), {})
  log('save sounds   : ' + JSON.stringify(saveSounds))
  await sleep(900)
  const soundsSaved = await measure(
    win,
    'soundsSaved',
    `(async () => {
      const r = await window.api.settings.get();
      const items = r.success ? r.data.alarmSounds.items : [];
      const custom = items.filter((i) => i.type === null);
      return JSON.stringify({
        total: items.length,
        customLabels: custom.map((i) => i.label),
        predefined: items.filter((i) => i.type !== null).length,
        motionFile: (items.filter((i) => i.id === 'motionDetection')[0] || {}).filePath || ''
      });
    })()`,
    { customLabels: [], predefined: -1, motionFile: '' }
  )
  log('sounds saved  : ' + JSON.stringify(soundsSaved))
  if (soundsSaved.predefined !== 6) problems.push('保存之后预定义声音不再是 6 项')
  if (soundsSaved.customLabels.indexOf('probe-custom-sound') === -1) {
    problems.push('自定义声音没有落库：' + JSON.stringify(soundsSaved.customLabels))
  }
  if (soundsSaved.motionFile !== goodWav) problems.push('预定义声音选的文件没有落库：' + String(soundsSaved.motionFile))

  // 删除自定义项并保存。
  const removeCustom = await measure(
    win,
    'removeCustomSound',
    `(async () => {
      const custom = document.querySelector('[data-sound-custom=yes]');
      if (!custom) return JSON.stringify({ ok: false, reason: 'no custom row' });
      const button = custom.querySelector('[data-delete-sound]');
      button.scrollIntoView({ block: 'center' });
      button.click();
      await new Promise((done) => setTimeout(done, 300));
      const save = document.querySelector('[data-action=save-alarm-sounds]');
      save.click();
      await new Promise((done) => setTimeout(done, 900));
      const r = await window.api.settings.get();
      const items = r.success ? r.data.alarmSounds.items : [];
      return JSON.stringify({
        ok: true,
        customs: items.filter((i) => i.type === null).length,
        total: items.length
      });
    })()`,
    { customs: -1 }
  )
  log('del custom    : ' + JSON.stringify(removeCustom))
  if (removeCustom.customs !== 0) problems.push('删除自定义声音之后它仍然在库里：' + String(removeCustom.customs))

  // --- 7) 邮件设置：真的发一封测试邮件到本地 stub -------------------------
  const smtp = await startStubSmtp()
  const mailBefore = await measure(
    win,
    'mailBefore',
    `(async () => {
      const r = await window.api.settings.get();
      return JSON.stringify({ ok: r.success, email: r.success ? r.data.alarmLinkage.email : null });
    })()`,
    {}
  )
  log('mail before   : ' + JSON.stringify(mailBefore))
  const originalEmail = mailBefore.ok ? mailBefore.email : null

  /**
   * 填邮件表单：**真的用键盘打字**（见 `typeInto` 上那段 `v-model` 的说明）。
   *
   * 这里踩过一次：用「setter + dispatchEvent」时 DOM 里全是新值，而 Vue 的草稿还是旧的
   * ——于是「发送测试邮件」在校验阶段报「发件人地址格式不正确」（它校验的是**空**的
   * `draft.from`），看起来像校验写错了，其实是探针没把值送进去。
   */
  const filledHost = await typeInto(win, 'fillEmailHost', '[data-field=smtp-host]', '127.0.0.1')
  const filledPort = await typeInto(win, 'fillEmailPort', '[data-field=smtp-port]', String(smtp.port))
  const filledSecurity = await measure(
    win,
    'fillEmailSecurity',
    `(() => {
      const el = document.querySelector('[data-field=smtp-security]');
      if (!el) return JSON.stringify({ ok: false, reason: 'not found' });
      el.value = 'none';
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return JSON.stringify({ ok: true, security: el.value });
    })()`,
    {}
  )
  const filledFrom = await typeInto(win, 'fillEmailFrom', '[data-field=smtp-from]', 'probe@example.com')
  const filledReceiver1 = await typeInto(win, 'fillEmailReceiver1', '[data-field=smtp-receiver-1]', 'ops@example.com')
  const filledReceiver2 = await typeInto(win, 'fillEmailReceiver2', '[data-field=smtp-receiver-2]', '')
  const filledReceiver3 = await typeInto(win, 'fillEmailReceiver3', '[data-field=smtp-receiver-3]', '')
  const filled = {
    host: filledHost.value,
    port: filledPort.value,
    security: filledSecurity.security,
    from: filledFrom.value,
    r1: filledReceiver1.value,
    r2: filledReceiver2.value,
    r3: filledReceiver3.value
  }
  log('fill email    : ' + JSON.stringify(filled))
  if (filled.host !== '127.0.0.1' || String(filled.port) !== String(smtp.port) || filled.from !== 'probe@example.com') {
    problems.push('邮件表单没有填进去：' + JSON.stringify(filled))
  }

  const testSent = await measure(
    win,
    'sendTestEmail',
    `(async () => {
      const readFields = () => {
        const value = (selector) => {
          const el = document.querySelector(selector);
          return el ? el.value : null;
        };
        return {
          host: value('[data-field=smtp-host]'),
          port: value('[data-field=smtp-port]'),
          security: value('[data-field=smtp-security]'),
          from: value('[data-field=smtp-from]'),
          r1: value('[data-field=smtp-receiver-1]'),
          disabled: Array.prototype.slice.call(document.querySelectorAll('[data-section=email-settings] input, [data-section=email-settings] select')).map((el) => el.disabled)
        };
      };
      const before = readFields();
      const draftBefore = document.querySelector('[data-section=email-settings] [data-draft]');
      before.draft = draftBefore ? draftBefore.getAttribute('data-draft') : null;
      const button = document.querySelector('[data-action=send-test-email]');
      if (!button) return JSON.stringify({ ok: false, reason: 'no button' });
      button.scrollIntoView({ block: 'center' });
      button.click();
      // 等到出现结果（成功或失败）为止，最多 12 秒。
      const deadline = Date.now() + 12000;
      let kind = null;
      let text = '';
      while (Date.now() < deadline) {
        const ok = document.querySelector('[data-section=email-settings] .alert--success');
        const bad = document.querySelector('[data-section=email-settings] .alert--danger');
        const alert = bad || ok;
        if (alert && alert.textContent.trim()) {
          kind = bad ? 'danger' : 'success';
          text = alert.textContent.replace(/\\s+/g, ' ').trim();
          break;
        }
        await new Promise((done) => setTimeout(done, 250));
      }
      const detail = document.querySelector('[data-section=email-settings] .smtp-detail');
      return JSON.stringify({ kind: kind, text: text, detail: detail ? detail.textContent.trim().slice(0, 400) : '', before: before, after: readFields() });
    })()`,
    {}
  )
  log('test email    : ' + JSON.stringify(testSent))
  if (testSent.kind === null) problems.push('点「发送测试邮件」之后 12 秒内没有任何结果提示')
  if (testSent.kind === 'danger') problems.push('测试邮件失败：' + testSent.text + ' / ' + testSent.detail)
  log(
    'smtp sessions : ' + smtp.sessions.length +
    ' commands=' + JSON.stringify((smtp.sessions[0] || { commands: [] }).commands.slice(0, 8))
  )
  if (smtp.sessions.length === 0) problems.push('测试邮件报告成功，但本地 SMTP stub 一个连接都没收到')
  else {
    const commands = smtp.sessions[0].commands.join(' | ')
    if (commands.indexOf('MAIL FROM') === -1) problems.push('SMTP 会话里没有 MAIL FROM：' + commands)
    if (commands.indexOf('<ops@example.com>') === -1) problems.push('SMTP 信封里没有收件人 ops@example.com：' + commands)
  }
  await smtp.close()

  // 还原邮件设置。
  if (originalEmail) {
    const restoredEmail = await measure(
      win,
      'restoreEmail',
      `(async () => {
        const r = await window.api.settings.get();
        const current = JSON.parse(JSON.stringify(r.data.alarmLinkage));
        current.email.host = ${JSON.stringify(originalEmail.host)};
        current.email.port = ${JSON.stringify(originalEmail.port)};
        current.email.security = ${JSON.stringify(originalEmail.security)};
        current.email.username = ${JSON.stringify(originalEmail.username)};
        current.email.from = ${JSON.stringify(originalEmail.from)};
        current.email.recipients = ${JSON.stringify(originalEmail.recipients)};
        delete current.email.smtpPassword;
        const saved = await window.api.settings.update({ alarmLinkage: current });
        return JSON.stringify({ ok: saved.success, host: saved.success ? saved.data.alarmLinkage.email.host : null });
      })()`,
      {}
    )
    log('mail restore  : ' + JSON.stringify(restoredEmail))
  }

  // --- 8) 一键恢复默认：确认对话框 + 只重置系统设置项 ----------------------
  // 先记下原值，并把它们改成可辨认的非默认值，这样"被重置了"才有证据。
  const beforeRestore = await measure(
    win,
    'beforeRestore',
    `(async () => {
      const r = await window.api.settings.get();
      if (!r.success) return JSON.stringify({ ok: false });
      const devices = await window.api.devices.list();
      const users = await window.api.auth.listUsers();
      const recordings = await window.api.recordings.query({ page: 1, pageSize: 5 });
      const original = {
        retentionDays: r.data.retentionDays,
        storageRoot: r.data.storageRoot,
        healthCheckIntervalMs: r.data.healthCheckIntervalMs
      };
      const patched = await window.api.settings.update({
        retentionDays: 42,
        healthCheckIntervalMs: 7777
      });
      return JSON.stringify({
        ok: patched.success,
        original: original,
        changed: patched.success ? { retentionDays: patched.data.retentionDays, healthCheckIntervalMs: patched.data.healthCheckIntervalMs } : null,
        deviceNames: devices.success ? (devices.data || []).map((d) => d.kind + ':' + d.name).sort() : [],
        usernames: users.success ? (users.data || []).map((u) => u.username).sort() : [],
        recordingsTotal: recordings.success ? recordings.data.total : null
      });
    })()`,
    {}
  )
  log('before restore: ' + JSON.stringify(beforeRestore))

  const dialog = await measure(
    win,
    'restoreDialog',
    `(async () => {
      const button = document.querySelector('[data-action=restore-defaults]');
      if (!button) return JSON.stringify({ ok: false, reason: 'no button' });
      button.scrollIntoView({ block: 'center' });
      button.click();
      await new Promise((done) => setTimeout(done, 400));
      const panel = document.querySelector('[role=dialog]');
      const items = document.querySelectorAll('[data-restore-items] li');
      const confirm = document.querySelector('[data-action=confirm-restore-defaults]');
      return JSON.stringify({
        ok: true,
        dialogOpen: !!panel,
        title: panel ? (panel.querySelector('.panel__title') || {}).textContent : '',
        itemCount: items.length,
        items: Array.prototype.slice.call(items).map((li) => li.textContent.trim()),
        keepsText: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(-160) : '',
        confirmEnabled: confirm ? !confirm.disabled : null
      });
    })()`,
    {}
  )
  log('restore dialog: ' + JSON.stringify(dialog))
  if (dialog.dialogOpen !== true) problems.push('「恢复默认值」没有弹出确认对话框')
  if (dialog.itemCount !== 13) problems.push('确认对话框列出的项应为 13 项，实际 ' + dialog.itemCount)
  if (dialog.confirmEnabled !== true) problems.push('确认对话框里的确认按钮不可用')

  const afterRestore = await measure(
    win,
    'confirmRestore',
    `(async () => {
      const confirm = document.querySelector('[data-action=confirm-restore-defaults]');
      if (!confirm) return JSON.stringify({ ok: false, reason: 'no confirm button' });
      confirm.click();
      const deadline = Date.now() + 15000;
      let closed = false;
      while (Date.now() < deadline) {
        if (!document.querySelector('[data-action=confirm-restore-defaults]')) { closed = true; break; }
        await new Promise((done) => setTimeout(done, 250));
      }
      const r = await window.api.settings.get();
      const devices = await window.api.devices.list();
      const users = await window.api.auth.listUsers();
      const recordings = await window.api.recordings.query({ page: 1, pageSize: 5 });
      const soundFiles = r.success ? r.data.alarmSounds.items.filter((i) => i.filePath !== '').length : -1;
      return JSON.stringify({
        closed: closed,
        retentionDays: r.success ? r.data.retentionDays : null,
        healthCheckIntervalMs: r.success ? r.data.healthCheckIntervalMs : null,
        storageRoot: r.success ? r.data.storageRoot : null,
        soundFiles: soundFiles,
        deviceNames: devices.success ? (devices.data || []).map((d) => d.kind + ':' + d.name).sort() : [],
        usernames: users.success ? (users.data || []).map((u) => u.username).sort() : [],
        recordingsTotal: recordings.success ? recordings.data.total : null
      });
    })()`,
    {}
  )
  log('after restore : ' + JSON.stringify(afterRestore))
  if (afterRestore.closed !== true) problems.push('确认恢复之后对话框没有关闭')
  if (afterRestore.retentionDays !== 30) {
    problems.push('恢复默认之后 retentionDays 应为 30，实际 ' + afterRestore.retentionDays)
  }
  if (afterRestore.healthCheckIntervalMs !== 5000) {
    problems.push('恢复默认之后 healthCheckIntervalMs 应为 5000，实际 ' + afterRestore.healthCheckIntervalMs)
  }
  if (afterRestore.soundFiles !== 0) {
    problems.push('恢复默认之后告警声音库里仍有 ' + afterRestore.soundFiles + ' 个文件被指向')
  }
  // 范围之外的一切必须逐字未变。
  if (JSON.stringify(afterRestore.deviceNames) !== JSON.stringify(beforeRestore.deviceNames)) {
    problems.push('恢复默认改了设备列表：' + JSON.stringify(beforeRestore.deviceNames) + ' -> ' + JSON.stringify(afterRestore.deviceNames))
  }
  if (JSON.stringify(afterRestore.usernames) !== JSON.stringify(beforeRestore.usernames)) {
    problems.push('恢复默认改了账号列表：' + JSON.stringify(beforeRestore.usernames) + ' -> ' + JSON.stringify(afterRestore.usernames))
  }
  if (afterRestore.recordingsTotal !== beforeRestore.recordingsTotal) {
    problems.push('恢复默认改了录像记录数：' + beforeRestore.recordingsTotal + ' -> ' + afterRestore.recordingsTotal)
  }

  // 还原用户原来的系统设置（一次性 profile 里也照做：同一套纪律对真实 profile 成立）。
  const restored = await measure(
    win,
    'restoreOriginalSettings',
    `(async () => {
      const saved = await window.api.settings.update({
        retentionDays: ${JSON.stringify(beforeRestore.original ? beforeRestore.original.retentionDays : 30)},
        healthCheckIntervalMs: ${JSON.stringify(beforeRestore.original ? beforeRestore.original.healthCheckIntervalMs : 5000)},
        storageRoot: ${JSON.stringify(beforeRestore.original ? beforeRestore.original.storageRoot : '')}
      });
      if (!saved.success) return JSON.stringify({ ok: false, code: saved.error.code });
      return JSON.stringify({
        ok: true,
        retentionDays: saved.data.retentionDays,
        healthCheckIntervalMs: saved.data.healthCheckIntervalMs,
        storageRoot: saved.data.storageRoot
      });
    })()`,
    {}
  )
  log('settings back : ' + JSON.stringify(restored))
  if (restored.ok !== true) problems.push('探针没能把用户的系统设置还原：' + JSON.stringify(restored))

  // 清理探针写下的音频文件。
  try {
    fs.rmSync(wavDir, { recursive: true, force: true })
  } catch (error) {
    log('cleanup       : ' + String(error && error.message))
  }
  log('camera        : ' + (camera ? camera.name : '(none)'))
}

/**
 * 写一个**真的** 8 kHz 单声道 16 位 PCM WAV（0.25 秒的 1 kHz 正弦）。
 *
 * 为什么探针要自己造一个：试听那一步要证明"给 `<audio>` 一个本机 `.wav` 地址之后
 * 它真的能解码"，而这需要一个格式正确的文件。用一段固定字节而不是随机噪声，
 * 是为了失败时能一眼看出是文件不对还是链路不对。
 *
 * `_alarm-sound` 目录在探针结束时删掉。
 */
function writeProbeWav(file) {
  const sampleRate = 8000
  const seconds = 0.25
  const samples = Math.floor(sampleRate * seconds)
  const dataBytes = samples * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 1000 * index) / sampleRate) * 12000)
    buffer.writeInt16LE(value, 44 + index * 2)
  }
  fs.writeFileSync(file, buffer)
}

/** 「保存告警声音库」按钮的选择器（单独抽出来，免得两处写歪）。 */
function clickSelectorSelector() {
  return clickSelectorScript('[data-action=save-alarm-sounds]')
}

async function run() {
  await sleep(3500)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    log('FATAL: the app never created a BrowserWindow')
    app.exit(1)
    return
  }

  const bridge = await waitForApi(win, 20000)
  log('preload bridge: ' + JSON.stringify(bridge))
  if (!(typeof bridge === 'object' && bridge !== null && bridge.auth === 'object')) {
    problems.push('preload bridge never became usable: ' + JSON.stringify(bridge))
  }

  const signed = await signIn(win)
  log('sign in       : ' + signed)
  const signInStep = JSON.parse(signed).step
  if (signInStep === 'login' || signInStep === 'change' || signInStep === 'threw' || signInStep === 'snippet-failed') {
    problems.push('could not sign in: ' + signed)
  }
  await sleep(600)

  const camera = await ensureCamera(win)
  log('camera        : ' + JSON.stringify(camera))
  /**
   * 设置页这一轮**不需要相机**：它要证明的是账号、声音库、邮件与恢复默认四件事，
   * 全部是本机行为。所以这一页在没有相机时继续跑（其他路由仍然照旧要求一台相机，
   * 因为它们的结论是关于视频链路的）。
   */
  if (!camera.id && ROUTE !== '/settings') {
    problems.push('no camera device available: ' + JSON.stringify(camera))
    log('problems      : ' + problems.length)
    for (const p of problems) log('  ! ' + p)
    app.exit(1)
    return
  }

  // 声纹设备（可选，`--box-ip`）：登记它只为了「重命名演练」能对着真实设备做。它的
  // 实时流**不会**被拉起来 —— 那台设备正在值班。
  const boxRegistration = await ensureBox(win)
  log('box           : ' + JSON.stringify(boxRegistration))
  if (BOX_IP !== '' && !boxRegistration.id) {
    log('box           : 未验证 — 声纹设备没有登记成功，重命名演练会被跳过')
  }

  // The device was added over IPC, which the already-mounted renderer store never
  // saw. Reload so the UI re-reads the real device list — see reloadAndSettle().
  const settled = await reloadAndSettle(win, 25000)
  log('after reload  : ' + JSON.stringify(settled))
  if (!(settled && settled.shell)) {
    problems.push('the shell did not come back after a reload: ' + JSON.stringify(settled))
  }
  // A device list that is still empty means everything below would be testing a UI
  // that does not know the camera exists — the exact false negative this reload
  // step was added to remove.
  if (settled && settled.devices !== null && /共 0|of 0|0 \/ 共 0/.test(settled.devices)) {
    problems.push('the device list is still empty after the reload: ' + settled.devices)
  }

  // Navigate the way the router wants: hash history, so a hash change is what
  // notifies it. The device query param is what the device tree uses to select a
  // camera, so this drives the path an operator drives.
  //
  // `/settings` 上没有设备树，也不依赖某台相机：地址是**不带** query 的那一个。
  const routeWithDevice = ROUTE === '/settings' ? ROUTE : ROUTE + '?device=' + camera.id
  const hashBefore = await evalInPage(win, 'hashBefore', 'JSON.stringify({ hash: location.hash })')
  let currentHash = ''
  try {
    currentHash = JSON.parse(hashBefore || '{}').hash || ''
  } catch (error) {
    currentHash = ''
  }
  if (currentHash !== '#' + routeWithDevice) {
    await evalInPage(win, 'navigate', 'location.hash = ' + JSON.stringify('#' + routeWithDevice) + '; true')
    await sleep(2500)
  } else {
    log('navigate      : already at ' + currentHash + '（刷新之后 hash 还在，不需要再跳）')
  }

  log('route         : ' + routeWithDevice)

  /**
   * 「有没有每通道的实时告警推送」——在真实窗口里量，而不是从源码推断。
   *
   * 必须在**页面刷新之后**安装（刷新会把渲染层的订阅全部丢掉），所以位置就在这里：
   * 刷新已完成、页面已就绪、而下面还要跑几十秒，足够收到设备状态那一类推送。
   * 这一趟收到的每一条推送的**字段名集合**会在最后被打出来（见 readPushProbe）。
   */
  const pushProbe = await startPushProbe(win)
  log('push probe    : ' + JSON.stringify(pushProbe))

  /**
   * 这一轮：设备管理页的树、右键菜单与重命名。
   *
   * 为什么放在**录像/播放之前**：重命名是设备写入，会短暂打扰设备的健康监测；而探针
   * 后面还要拉一路实时视频看它能不能解码。先把写入与读回做完、恢复完，再去碰媒体链路，
   * 两件事的结论就不会互相污染。
   *
   * `--observe-only` 那一次**一个字节都不写设备**：那一次运行要证明的是「一个控件都没按，
   * 画面自己出来了」，任何设备写入都可能把结论搅浑。
   */
  const deviceList = await evalJson(win, 'listDevices', listDevicesScript(), { ok: false })
  const picks = pickByKind(deviceList.ok ? deviceList.devices : [])
  log('device kinds  : ' + JSON.stringify(picks))
  if (ROUTE === '/devices') {
    await measureDevicesRoute(win, picks.camera || { id: camera.id, kind: 'acousticCamera', name: camera.name || '', ip: IP }, picks.box)
    if (!OBSERVE_ONLY) {
      await exerciseRenames(win, picks.camera, picks.box, BOX_RENAME_DRILL)
    } else {
      log('rename        : skipped (--observe-only): 这一次运行不写设备')
    }
  }

  /**
   * 设置页（`/settings`）：账号管理、告警声音库、邮件设置与「恢复默认值」。
   *
   * 与设备页同一个位置（媒体链路之前）：这一轮要发一封**真的**测试邮件、并且
   * 完整走一遍「恢复默认 -> 还原」，把它们放在前面，后面那些只读的视频结论就不会
   * 与这些写入互相污染。
   */
  if (ROUTE === '/settings') {
    await measureSettingsRoute(win, picks.camera)
  }

  const uiBefore = await probeUi(win)
  log('ui before     : ' + JSON.stringify(uiBefore))

  const first = await probe(win)
  log('before start  : ' + JSON.stringify(first))

  // Auto-play is on by default and only fires when the camera is genuinely
  // working, so a missing player here is not yet a failure. Drive the real play
  // control, which is what makes the renderer store the owner of the session.
  //
  // 设备管理页（`/devices`）上**没有**播放器：那一页是设备与拓扑管理，产品没有要求它
  // 放视频。没有播放器就不能用界面驱动，但**更不能**退回去调 IPC `cameraLive.start` ——
  // 主进程每台相机只维持一路会话，那个调用会顶掉操作员正在看的画面，然后把「我自己
  // 顶掉的会话」报成「画面没解出来」。所以这一页明确跳过媒体链路，并把它说成
  // 未验证，而不是失败。
  const VIDEO_ROUTE = ROUTE === '/' || ROUTE.startsWith('/monitor')
  if (!VIDEO_ROUTE) {
    log('click play    : skipped — ' + ROUTE + ' 上没有播放器，本次运行只验证该页的结构')
  } else if (!first.found || first.withSrc === 0 || !(first.videoWidth > 0)) {
    if (OBSERVE_ONLY) {
      // Do NOT fail here: auto-play may still be deciding. Let the poll below run
      // its full budget, and report the placeholder it ended on if nothing plays.
      log('observe only  : the play control was deliberately NOT pressed')
    } else if (first.found && first.withSrc > 0) {
      /**
       * A player is ALREADY holding a loopback address; it just has not decoded a
       * frame yet. Pressing nothing is the correct action here, and the IPC
       * fallback below must NOT run: the main process keeps ONE session per
       * camera, so `cameraLive.start` would REPLACE the very session the player on
       * screen is watching — the harness would then be polling a player bound to a
       * dead address and report a failure it caused itself. The poll below decides
       * whether the existing player decodes.
       */
      log('click play    : skipped — a player already holds an address; an IPC start would replace its session')
    } else {
      const clicked = await clickPlay(win)
      log('click play    : ' + JSON.stringify(clicked))
      if (!clicked.clicked) {
        // No control on this route at all: fall back to the IPC call so the harness
        // still exercises the media pipeline, but say plainly that the UI path was
        // not what was tested.
        const started = await startStream(win, camera.id)
        log('start request : ' + JSON.stringify(started))
        if (!started.ok) problems.push('cameraLive.start failed: ' + JSON.stringify(started))
        if (uiBefore.hasStage) {
          problems.push('the live section rendered no play control, so the UI path could not be driven')
        }
      }
    }
  }

  /**
   * Poll until a frame is decoded or the budget runs out.
   *
   * Polling rather than one long sleep is the point: readyState and currentTime
   * tell us WHEN it succeeded, and an early success is a different result from a
   * success at the last second. Each sample is kept so the report shows the
   * pipeline progressing instead of one terminal state.
   */
  const samples = []
  const deadline = Date.now() + SECONDS * 1000
  let decoded = null
  // `/devices` 上没有播放器：那一页不参与「画面能不能解出来」这件事，所以这一轮不
  // 空转等 25 秒，也不把「没有 <video>」报成失败（下面用 `VIDEO_ROUTE` 分开处理）。
  while (VIDEO_ROUTE && Date.now() < deadline) {
    const sample = await probe(win)
    samples.push({
      t: Math.round((SECONDS * 1000 - (deadline - Date.now())) / 100) / 10,
      p: sample
    })
    if (sample.found && sample.readyState >= 2 && sample.videoWidth > 0) {
      decoded = sample
      break
    }
    await sleep(1000)
  }

  // Observe a further two seconds so currentTime and the decoder's frame counter
  // are shown to ADVANCE — a single non-zero reading could be a frozen first frame.
  let advanced = null
  if (decoded) {
    const startedAt = Date.now()
    const before = decoded
    await sleep(2200)
    const after = await probe(win)
    advanced = {
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      currentTimeDelta: Math.round((after.currentTime - before.currentTime) * 100) / 100,
      framesDelta:
        after.totalVideoFrames !== null && before.totalVideoFrames !== null
          ? after.totalVideoFrames - before.totalVideoFrames
          : null,
      after
    }
  }

  log('samples       : ' + samples.length)
  for (const sample of samples) {
    log(
      '  t=' + sample.t + 's readyState=' + sample.p.readyState +
      ' net=' + sample.p.networkState +
      ' size=' + sample.p.videoWidth + 'x' + sample.p.videoHeight +
      ' currentTime=' + sample.p.currentTime + ' paused=' + sample.p.paused +
      (sample.p.error ? ' error=' + JSON.stringify(sample.p.error) : '')
    )
  }

  if (!decoded) {
    const last = samples.length ? samples[samples.length - 1].p : null
    const uiAfter = await probeUi(win)
    log('ui after      : ' + JSON.stringify(uiAfter))
    if (!VIDEO_ROUTE) {
      // 这一页没有播放器（见上面 `VIDEO_ROUTE` 的说明）：媒体链路在这里**未验证**，
      // 而不是失败 —— 这一页要证明的是树、间距与重命名。
      log('DECODED       : 未验证 — ' + ROUTE + ' 上没有播放器，本次运行不验证媒体链路')
    } else {
      problems.push('NO FRAME DECODED in ' + SECONDS + 's; last probe = ' + JSON.stringify(last))
      if (!uiAfter.hasVideo && uiAfter.placeholderText) {
        problems.push('the live section showed this instead of a player: ' + uiAfter.placeholderText)
      }
    }
  } else {
    log('DECODED       : ' + JSON.stringify(decoded))
    log('advance       : ' + JSON.stringify(advanced))
    if (advanced && advanced.currentTimeDelta <= 0) {
      problems.push('currentTime did not advance: playback is stalled on a frozen frame')
    }
    if (advanced && advanced.framesDelta !== null && advanced.framesDelta <= 0) {
      problems.push('decoder frame counter did not advance')
    }
    if (decoded.srcScheme !== 'http') {
      problems.push('unexpected video src scheme: ' + decoded.srcScheme)
    }
  }

  // The camera wall's cell structure, read AFTER the poll: this is what separates
  // "the wall rendered nothing" from "the wall rendered cells and one of them is
  // playing". The Overview is the route that carries the wall as its only camera
  // surface, so the structure is asserted there and merely reported elsewhere.
  const uiFinal = await probeUi(win)
  const wall = uiFinal.cameraWall
  if (wall) {
    log(
      'wall cells    : ' + wall.cells + ' cells, ' + wall.videos + ' with <video>, ' +
      wall.placeholders + ' placeholder(s)'
    )
    log('wall header   : ' + JSON.stringify(wall.layoutHeaderText))
    log('wall layout   : ' + JSON.stringify(wall.layout))
    if (wall.layout) {
      log(
        'wall icons    : ' +
          wall.layout.buttons
            .map((b) => b.label + ' -> ' + b.cells + ' box(es) in ' + b.iconColumns + 'x' + b.iconRows)
            .join(' | ')
      )
    }
    log('wall placeholder text: ' + JSON.stringify(wall.placeholderTexts))
  } else {
    log('wall cells    : no .camera-wall on this route')
  }
  log('channel layout: ' + JSON.stringify(uiFinal.channelWallLayout))
  if (uiFinal.channelWallLayout) {
    log(
      'channel icons : ' +
        uiFinal.channelWallLayout.buttons
          .map((b) => b.label + ' -> ' + b.cells + ' box(es) in ' + b.iconColumns + 'x' + b.iconRows)
          .join(' | ')
    )
  }
  log('old heading   : ' + uiFinal.oldLayoutHeadingHits + ' element(s) still render a removed layout heading; .field-label in wall: ' + uiFinal.layoutFieldLabels)

  /**
   * The layout switch lives in the title row, is pushed to the RIGHT of it and is
   * icon-only, so assert the shape of the control itself and not just the grid it
   * produces:
   *   - the group and every button are inside the wall's `.section-header` (not
   *     duplicated, not left behind in a row of its own);
   *   - the group is at the header's right edge (`rightGapPx`), which is the owner's
   *     「切换窗口右对齐」 — "inside the header" alone would also pass for a switch
   *     sitting on the left, right after the title;
   *   - every button has an accessible name, and the SAME text as its tooltip;
   *   - every button contains an inline `<svg>` (the project draws icons itself; a
   *     text-only or empty button would render as a blank square);
   *   - exactly one button is pressed, before any of the layout presses below.
   * The same shape is required of the channel wall, which shares this page: two walls
   * with two different controls on one screen was the thing being fixed.
   */
  /**
   * The grid each icon is expected to draw, keyed by the layout it selects. The two
   * walls have DIFFERENT sets and this table says so explicitly:
   *   camera wall  1/4/9/16 -> 1x1, 2x2, 3x3, 4x4  (`cameraWallColumns()`)
   *   channel wall 1/2/4/8  -> 1x1, 2x1, 2x2, 4x2  (`layoutColumns()`, 8 = AE08 channels)
   * Stating it here is the point — "the button contains an <svg>" would pass for four
   * identical single squares. The channel wall's 2-up entry is [2, 1]: two columns in
   * ONE row, which is what 「2 通道」 means on screen (a single column of two rows is
   * just a stretched 1-up).
   */
  const CAMERA_ICON_SHAPES = { 1: [1, 1], 4: [2, 2], 9: [3, 3], 16: [4, 4] }
  const CHANNEL_ICON_SHAPES = { 1: [1, 1], 2: [2, 1], 4: [2, 2], 8: [4, 2] }

  function layoutProblems(name, shape, expected, shapes) {
    if (!shape) {
      problems.push('the ' + name + ' layout control is not rendered')
      return
    }
    if (!shape.groupLabel) problems.push('the ' + name + ' layout group (role=group) has no accessible name')
    if (!shape.inHeader) problems.push('the ' + name + ' layout control is not inside its .section-header')
    if (shape.rightGapPx === null || shape.rightGapPx > 8) {
      problems.push(
        'the ' + name + ' layout control is not right-aligned in the header: ' +
          shape.rightGapPx + 'px of space to its right'
      )
    }
    if (shape.buttons.length !== expected) {
      problems.push('the ' + name + ' layout control has ' + shape.buttons.length + ' buttons, expected ' + expected)
    }
    for (const button of shape.buttons) {
      const which = name + ' layout button "' + button.label + '"'
      if (!button.label) problems.push('a ' + name + ' layout button has no accessible name (aria-label)')
      if (button.label !== button.title) {
        problems.push(which + ': aria-label and title disagree (' + button.title + ')')
      }
      if (!button.svg) problems.push(which + ': no <svg> icon')
      if (!button.inHeader) problems.push(which + ' is outside the .section-header')
      // Text in the button would mean the old labelled row crept back.
      if (button.text) problems.push(which + ': still renders text (' + button.text + ')')
      const count = Number((/^(\d+)/.exec(button.label) || [])[1])
      const wanted = shapes[count]
      if (!wanted) {
        problems.push(which + ': no expected icon shape for this label')
      } else {
        if (button.cells !== count) {
          problems.push(which + ': icon draws ' + button.cells + ' cell(s), expected ' + count)
        }
        if (button.iconColumns !== wanted[0] || button.iconRows !== wanted[1]) {
          problems.push(
            which + ': icon is ' + button.iconColumns + 'x' + button.iconRows +
            ', expected ' + wanted[0] + 'x' + wanted[1]
          )
        }
      }
    }
    const pressed = shape.buttons.filter((button) => button.pressed)
    if (pressed.length !== 1) {
      problems.push('the ' + name + ' layout control has ' + pressed.length + ' active buttons, expected exactly 1')
    } else {
      // "Unmistakable" checked against the browser's own resolved colours: the active
      // button must PAINT differently from the inactive ones. A rule that lost its
      // variable, or an `--active` class nothing styles, would otherwise look correct
      // in the class list and be invisible on screen.
      const inactive = shape.buttons.filter((button) => !button.pressed)
      if (inactive.length > 0 && !inactive.some((button) => button.paint !== pressed[0].paint)) {
        problems.push(
          'the ' + name + ' active layout button paints exactly like the inactive ones (' +
            pressed[0].paint + ')'
        )
      }
      log('  ' + name + ' active paint: ' + pressed[0].paint)
    }
  }

  /**
   * The empty cell: one large `+` in the MIDDLE of the cell, no words, and no visible
   * <select>. Asserted separately from the layout control because it is a different
   * promise: "加了相机" must still be reachable (a real button, with a name) while every
   * word the owner asked to delete really is gone.
   *
   * THE CENTRE ASSERTION REPLACES A REVERSED ONE. The previous round had the `+` flush
   * against the right edge and this function asserted "≤ 24px from the right edge". The
   * owner has since said 「加号应该在窗口中心」, so the requirement itself changed; the
   * assertion is retargeted rather than deleted, and the two numbers it prints (the
   * signed offset from the centre and the gaps to both edges) are what makes
   * "centred" checkable instead of a claim about a stylesheet.
   */
  function emptyCellProblems(name, empty) {
    if (!empty) return
    if (empty.cells < 1) {
      problems.push('the ' + name + ' rendered no empty cell, so the + affordance was not verified')
      return
    }
    if (empty.addButtons !== empty.cells) {
      problems.push(
        'only ' + empty.addButtons + ' of ' + empty.cells + ' empty cells render a + affordance'
      )
    }
    for (const label of empty.addLabels) {
      if (!label) problems.push('an empty-cell + button has no accessible name (aria-label)')
    }
    for (let i = 0; i < empty.addLabels.length; i += 1) {
      if (empty.addLabels[i] !== empty.addTitles[i]) {
        problems.push('an empty-cell + has aria-label "' + empty.addLabels[i] + '" but title "' + empty.addTitles[i] + '"')
      }
    }
    // NO TEXT AT ALL, counted as TEXT NODES. "只有一个加号，不要任何文字说明" is not
    // satisfied by hiding text: a visually-hidden <select> inside the cell would still
    // put its `<option>` labels in the DOM. The picker is an overlay on <body> since
    // 2026-09-18, so the cell has nothing to hide in the first place.
    for (const count of empty.textNodeCounts || []) {
      if (count !== 0) problems.push('an empty cell still contains ' + count + ' text node(s)')
    }
    for (const text of empty.texts || []) {
      if (text !== '') problems.push('an empty cell still renders text: ' + JSON.stringify(text))
    }
    for (const count of empty.selectCounts || []) {
      if (count !== 0) problems.push('an empty cell contains ' + count + ' <select> element(s)')
    }
    if (empty.visibleSelects > 0) {
      problems.push(empty.visibleSelects + ' empty cell(s) still render a visible <select>')
    }
    // The `+` is DRAWN — two SVG strokes, one horizontal and one vertical — not typed.
    const horizontals = empty.plusHorizontal || []
    const verticals = empty.plusVertical || []
    for (const strokes of empty.plusStrokes || []) {
      if (strokes !== 2) problems.push('an empty-cell + is not two SVG strokes (found ' + strokes + ')')
    }
    for (let i = 0; i < horizontals.length; i += 1) {
      if (horizontals[i] !== 1 || verticals[i] !== 1) {
        problems.push('an empty-cell + is not exactly one horizontal plus one vertical stroke')
      }
    }
    for (const width of empty.plusWidthPx || []) {
      if (width < 24) problems.push('the empty-cell + is not LARGE: the browser painted it ' + width + 'px wide')
    }
    // CENTRED, measured against the cell the `+` lives in. A `+` still parked on the
    // right would report roughly half the cell width here (and the same number with the
    // opposite sign for a left-parked one), so the sign is checked as well.
    const offsetsX = empty.addCenterOffsetXPx || []
    const offsetsY = empty.addCenterOffsetYPx || []
    const cellWidths = empty.addCellWidthPx || []
    for (let i = 0; i < offsetsX.length; i += 1) {
      if (Math.abs(offsetsX[i]) > CENTRE_TOLERANCE_PX) {
        problems.push(
          'the empty-cell + is not horizontally centred: its centre is ' + offsetsX[i] +
          'px from the cell centre of a ' + cellWidths[i] + 'px-wide cell (left gap ' +
          (empty.addLeftGapPx || [])[i] + 'px, right gap ' + (empty.addRightGapPx || [])[i] + 'px)'
        )
      }
    }
    for (let i = 0; i < offsetsY.length; i += 1) {
      if (Math.abs(offsetsY[i]) > CENTRE_TOLERANCE_PX) {
        problems.push(
          'the empty-cell + is not vertically centred: its centre is ' + offsetsY[i] +
          'px from the cell centre'
        )
      }
    }
  }

  /**
   * 每一格都必须是 16:9（产品要求：「总览界面，四个窗口默认是 16:9 的比例」）。
   *
   * 量的是**浏览器排出来的盒子**（`grid.boxes`），不是样式表里的 `aspect-ratio`
   * 声明：`aspect-ratio` 会被网格的行高、最小高度、或者一个显式高度悄悄盖掉，而
   * 声明还在。每一格单独比，并打出「宽 x 高 = 比例」与相对误差，所以「4:3 被当成
   * 16:9 通过了」这种假通过不可能发生（4:3 的相对误差是 25%，公差是 2%）。
   */
  function cellRatioProblems(name, grid) {
    const boxes = (grid && grid.boxes) || []
    if (boxes.length === 0) {
      problems.push('the ' + name + ' reported no cell box, so the 16:9 ratio could not be measured')
      return
    }
    for (const entry of cellRatioReport(grid)) {
      if (!(entry.ratio > 0)) {
        problems.push('the ' + name + ' cell ' + entry.index + ' has no measurable box')
        continue
      }
      if (entry.relativeError > CELL_RATIO_TOLERANCE) {
        problems.push(
          'the ' + name + ' cell ' + entry.index + ' is ' + entry.width + 'x' + entry.height +
          ' = ' + entry.ratio + ':1, not 16:9 (' + Math.round(CELL_RATIO_16_9 * 1000) / 1000 +
          ':1); relative error ' + Math.round(entry.relativeError * 10000) / 100 + '%'
        )
      }
    }
  }

  /**
   * `.page` 在四档窗口尺寸下的对齐与宽度（产品要求：靠左、与左/上边缘固定距离、
   * 并且随分辨率自适应）。
   *
   * 四条断言分别对着产品那三句话：
   *   1. 左边距/上边距在四档尺寸下**逐像素相同** —— 这就是「和左边和上边保持固定的
   *      距离」；只要有一条不同的值，居中的定宽列（或任何一种按窗口宽度算出来的
   *      外边距）就会露出来；
   *   2. 内容列在内容盒里**左右都贴边**（`gapFromContentBoxPx` 两项都是 0）—— 居中的
   *      定宽列在这里会给出两个相等且大于 0 的数；
   *   3. 宽度随窗口**严格变宽**，而且每一档都等于内容区宽度减去左右内边距 —— 这就是
   *      「自适应窗口大小」，1440px 定宽列在这里一定失败（2560 那一档会卡在 1440）；
   *   4. 计算样式里 `max-width` 是 `none`、左右 `margin` 是 `0px`。
   * 请求的尺寸与渲染层报回来的 `innerWidth/innerHeight` 也一起比：如果操作系统把窗口
   * 夹小了，这里必须说出来，而不是拿另一个尺寸的数字当成这一档的结论。
   */
  function pageGeometryProblems(measured, requested) {
    if (measured.length === 0) {
      problems.push('the .page geometry was measured at no window size')
      return
    }
    for (let i = 0; i < measured.length; i += 1) {
      const entry = measured[i]
      const size = requested[i]
      if (!entry.found) {
        problems.push(
          'the .page container was not found at ' + size[0] + 'x' + size[1] + ': ' + JSON.stringify(entry)
        )
        continue
      }
      if (entry.viewport.w !== size[0] || entry.viewport.h !== size[1]) {
        problems.push(
          'asked for a ' + size[0] + 'x' + size[1] + ' window but the renderer reports ' +
          entry.viewport.w + 'x' + entry.viewport.h + ' (dpr ' + entry.devicePixelRatio + ')'
        )
      }
      if (entry.pageMaxWidth !== 'none') {
        problems.push('the .page still has a max-width (' + entry.pageMaxWidth + '): that is the fixed centred column')
      }
      if (entry.pageMarginLeft !== '0px' || entry.pageMarginRight !== '0px') {
        problems.push(
          'the .page still has auto/unequal margins (' + entry.pageMarginLeft + ' / ' +
          entry.pageMarginRight + '): that is what centres it'
        )
      }
      const fluidWidth =
        entry.contentClientWidth -
        parseFloat(entry.contentPaddingLeft) -
        parseFloat(entry.contentPaddingRight)
      if (Math.abs(entry.page.width - fluidWidth) > 1) {
        problems.push(
          'at ' + size[0] + 'x' + size[1] + ' the .page is ' + entry.page.width +
          'px wide but the content box allows ' + Math.round(fluidWidth) + 'px: the column is not fluid'
        )
      }
      if (
        Math.abs(entry.gapFromContentBoxPx.left - entry.gapFromContentBoxPx.right) > 1 ||
        entry.gapFromContentBoxPx.left > 1
      ) {
        problems.push(
          'at ' + size[0] + 'x' + size[1] + ' the .page does not fill the content box from the left: ' +
          'gap inside the content box ' + entry.gapFromContentBoxPx.left + 'px left / ' +
          entry.gapFromContentBoxPx.right + 'px right (raw gaps from the padding box: ' +
          entry.gapFromContentPx.left + 'px / ' + entry.gapFromContentPx.right +
          'px, scrollbar ' + entry.scrollbarPx + 'px) — equal non-zero gaps are exactly what a ' +
          'centred column looks like'
        )
      }
    }
    const gapsOf = (key, axis) =>
      measured.filter((entry) => entry.found).map((entry) => entry[key][axis])
    for (const [key, label] of [['gapFromMainPx', 'content column'], ['gapFromViewportPx', 'viewport']]) {
      for (const axis of ['left', 'top']) {
        const values = gapsOf(key, axis)
        if (new Set(values).size > 1) {
          problems.push(
            'the .page ' + axis + ' gap from the ' + label + ' is not constant across window sizes: ' +
            JSON.stringify(values)
          )
        }
      }
    }
    const widths = measured.filter((entry) => entry.found).map((entry) => entry.page.width)
    for (let i = 1; i < widths.length; i += 1) {
      if (!(widths[i] > widths[i - 1])) {
        problems.push(
          'the .page did not get wider with the window: ' + JSON.stringify(widths) +
          ' (asked for ' + requested.map((size) => size[0]).join('/') + ')'
        )
        break
      }
    }
    const widest = measured.filter((entry) => entry.found)[measured.filter((entry) => entry.found).length - 1]
    if (widest && widest.page.width <= 1440) {
      problems.push(
        'the widest window renders a ' + widest.page.width +
        'px column: the removed 1440px cap still decides the layout'
      )
    }
  }

  /**
   * The bottom control bar: ONE per assigned cell, exactly four controls, every control
   * with an accessible name AND the same tooltip, and the old top row really gone.
   *
   * Why "the old top row really gone" needs measuring rather than trusting the source:
   * the buttons were removed by this round, and a leftover `camera-wall__btn` would be
   * invisible in a screenshot of a cell that happens to be showing a picture.
   */
  function barProblems(name, bar) {
    if (!bar) {
      problems.push('the ' + name + ' reported no control-bar structure')
      return
    }
    if (bar.overlayActionButtons !== 0) {
      problems.push(
        'the ' + name + ' top overlay still renders ' + bar.overlayActionButtons +
        ' action button(s); the removed row must not come back'
      )
    }
    if (bar.legacyButtons !== 0) {
      problems.push(
        'the ' + name + ' still renders ' + bar.legacyButtons + ' of the removed top-bar buttons (.camera-wall__btn)'
      )
    }
    if (bar.bars !== bar.assignedCells) {
      problems.push(
        'the ' + name + ' renders ' + bar.bars + ' control bar(s) for ' + bar.assignedCells +
        ' assigned cell(s); every assigned cell must carry exactly one'
      )
    }
    for (const controls of bar.controls || []) {
      if (controls.length !== 4) {
        problems.push('a ' + name + ' control bar has ' + controls.length + ' controls, expected exactly 4')
      }
      const sliders = controls.filter((control) => control.type === 'range').length
      if (sliders !== 1) {
        problems.push('a ' + name + ' control bar has ' + sliders + ' volume slider(s), expected 1')
      }
      for (const control of controls) {
        if (!control.label) {
          problems.push('a ' + name + ' control-bar <' + control.tag + '> has no accessible name')
        }
        if (control.label !== control.title) {
          problems.push(
            'a ' + name + ' control-bar control is named "' + control.label +
            '" but titled "' + control.title + '"'
          )
        }
        // Icon-only by design: text here would mean a second, textual control row.
        if (control.text) {
          problems.push('a ' + name + ' control-bar control renders text: ' + JSON.stringify(control.text))
        }
      }
      const pressed = controls.filter((control) => control.pressed !== null)
      if (pressed.length !== 1) {
        problems.push(
          'a ' + name + ' control bar marks ' + pressed.length + ' controls as pressed, expected 1 (the volume toggle)'
        )
      }
    }
  }

  if (ROUTE === '/') {
    const oldHeadings = uiFinal.oldLayoutHeadingHits
    if (oldHeadings > 0) {
      problems.push(oldHeadings + ' element(s) still render a removed layout heading text')
    }
    if (uiFinal.layoutFieldLabels > 0) {
      problems.push('the camera wall still renders ' + uiFinal.layoutFieldLabels + ' .field-label row(s)')
    }
    layoutProblems('camera wall', wall && wall.layout, 4, CAMERA_ICON_SHAPES)
    layoutProblems('channel wall', uiFinal.channelWallLayout, 4, CHANNEL_ICON_SHAPES)

    if (!wall) {
      problems.push('the Overview rendered no camera wall (.camera-wall)')
    } else {
      if (wall.cells < 1) problems.push('the camera wall rendered no cell at all')
      if (wall.videos + wall.placeholders !== wall.cells) {
        problems.push(
          'a wall cell is neither a <video> nor a placeholder: ' +
            wall.videos + ' + ' + wall.placeholders + ' != ' + wall.cells
        )
      }
      // The whole point of the Overview surface: the cell that is playing must be a
      // wall cell, not some other player on the page.
      if (decoded && wall.videos < 1) {
        problems.push('a frame decoded but no wall cell holds a <video> element')
      }
      emptyCellProblems('camera wall', wall.empty)
      barProblems('camera wall', wall.bar)
      // A cell that HAS a camera but no picture must still say why in a word
      // (设备离线 / RTSP 未启用 / 流错误 …): "no text" was about the empty cell only.
      for (const word of wall.placeholderStateWords || []) {
        if (!word) problems.push('a non-empty cell with no picture shows no state word')
      }
      log(
        'wall empty cells: ' + JSON.stringify(wall.empty) +
          ' non-empty placeholder words: ' + JSON.stringify(wall.placeholderStateWords)
      )
      log('wall bars     : ' + JSON.stringify(wall.bar))
      log('wall grid     : ' + JSON.stringify(wall.grid))
      // The audio rule, measured on the live DOM: at most ONE `<video>` may be unmuted,
      // and none of them may still carry the browser's own controls.
      const audioFinal = await probe(win)
      const audioFacts = audioFinal.audio || { videoElements: 0, unmuted: 0, nativeControls: 0 }
      log('wall audio    : ' + JSON.stringify(audioFacts))
      if (audioFacts.unmuted > 1) {
        problems.push(
          audioFacts.unmuted + ' <video> elements are unmuted: at most one cell may produce sound'
        )
      }
      if (audioFacts.nativeControls > 0) {
        problems.push(
          audioFacts.nativeControls + ' <video> element(s) still carry the native controls attribute'
        )
      }
      if (OBSERVE_ONLY && audioFacts.unmuted !== 0) {
        // No control was pressed in this run: auto-play must produce a picture, not sound.
        problems.push(
          'observe-only run: ' + audioFacts.unmuted +
          ' <video>(s) are unmuted although no control was pressed'
        )
      }
    }
  }

  // A picture that decodes but paints nothing is still a broken feature, so keep
  // a PNG of the actual stage as evidence a human can look at.
  try {
    const image = await win.webContents.capturePage()
    const file = path.join(OUT, 'video-proof.png')
    fs.writeFileSync(file, image.toPNG())
    const size = image.getSize()
    log(
      'screenshot    : ' + file + ' (' + fs.statSync(file).size + ' B, ' +
      size.width + 'x' + size.height + ')'
    )
  } catch (error) {
    problems.push('screenshot failed: ' + (error && error.message))
  }

  // The volume slider must move the REAL `<video>.volume`, and moving it must leave
  // exactly one cell audible. Deliberately skipped under `--observe-only`: that mode
  // exists to prove auto-play produced the picture with NO control touched, so pressing
  // one here would destroy the very claim the run is making.
  if (wall && ROUTE === '/' && !OBSERVE_ONLY) {
    const quiet = await setVolumeSlider(win, 0, 30)
    log('volume 30%    : ' + JSON.stringify(quiet))
    if (!quiet.found) {
      problems.push('could not drive the volume slider: ' + JSON.stringify(quiet))
    } else {
      if (quiet.sliderDisabled) {
        problems.push('the volume slider of the playing cell is disabled: nothing can set the volume')
      }
      if (quiet.videoVolume !== 0.3) {
        problems.push(
          'the volume slider did not reach the element: slider=' + quiet.sliderValue +
          ' but <video>.volume=' + quiet.videoVolume
        )
      }
      if (quiet.unmuted !== 1) {
        problems.push(
          'moving the volume slider left ' + quiet.unmuted + ' cell(s) audible, expected exactly 1'
        )
      }
    }
    const loud = await setVolumeSlider(win, 0, 100)
    log('volume 100%   : ' + JSON.stringify(loud))
    if (loud.found && loud.videoVolume !== 1) {
      problems.push('the volume slider did not restore full volume: <video>.volume=' + loud.videoVolume)
    }
    if (loud.found && loud.unmuted > 1) {
      problems.push(loud.unmuted + ' cells are unmuted after the volume round-trip')
    }
  } else if (ROUTE === '/') {
    log('volume        : not pressed (--observe-only): the auto-play claim stays clean')
  }

  // The play/stop control, in BOTH directions. The owner's promise is about the control,
  // not about a screenshot: stopping a live cell must clear the address (the invariant
  // this round must not weaken — no `<video>` without a URL), and starting an assigned but
  // non-live cell must bring the picture back. Result of this block: the DOM is left with
  // a PLAYING cell again, so the layout sweep below still exercises a live wall.
  if (wall && ROUTE === '/' && !OBSERVE_ONLY && decoded) {
    const stopped = await pressBarPlayback(win)
    log('bar stop      : ' + JSON.stringify(stopped))
    if (!stopped.pressed) {
      problems.push('could not press the play/stop control: ' + JSON.stringify(stopped))
    } else {
      const afterStop = await waitForNoVideo(win, 15000)
      log('after stop    : ' + JSON.stringify(afterStop))
      if (afterStop.found || afterStop.videoElements !== 0) {
        problems.push(
          'the <video> element survived a stop: a non-playing cell must hold no player at all — ' +
          JSON.stringify(afterStop)
        )
      }
      const started = await pressBarPlayback(win)
      log('bar start     : ' + JSON.stringify(started))
      if (!started.pressed) {
        problems.push('could not press the play control again: ' + JSON.stringify(started))
      } else if (started.labelBefore === stopped.labelBefore) {
        problems.push(
          'the play/stop control still says "' + started.labelBefore +
          '" after the cell stopped: its name must follow the cell state'
        )
      } else {
        const afterStart = await waitForDecoded(win, 30000)
        log('after start   : ' + JSON.stringify(afterStart))
        if (!(afterStart.found && afterStart.videoWidth > 0)) {
          problems.push(
            'the picture did not come back after pressing the play control: ' + JSON.stringify(afterStart)
          )
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 画面格右键菜单（NVR 式）
  //
  // 这一段全部是**真实 DOM 上的测量**：真的派发 contextmenu、真的点菜单项、真的按
  // Escape / 点外部，然后把渲染出来的标签、顺序、菜单标题、灰显原因读回来。菜单是
  // NVR 式交互里最容易「看起来有、其实点不动」的一块，所以它值得一次完整走查。
  //
  // 刻意放在档位扫描**之前**：那时墙还是默认的 4 档（1 个有相机的格 + 3 个空白格），
  // 「空白格不打开相机菜单」这条才有格子可测。
  // -------------------------------------------------------------------------
  if (wall && ROUTE === '/' && !OBSERVE_ONLY && decoded) {
    const localeState = await readLocale(win)
    const locale = localeState.lang === '' ? 'zh-CN' : localeState.lang
    const expected = expectedTopLevel(locale)
    log('menu locale   : ' + JSON.stringify(localeState))

    // 1) 在**有相机**的那一格上按右键：菜单要在光标处打开，标题是那一格的设备名。
    const hit = await rightClickCell(win, 'assigned')
    log('right-click   : ' + JSON.stringify(hit))
    await sleep(400)
    const menu = await probeMenu(win)
    log('menu opened   : ' + JSON.stringify(menu))
    if (!hit.found) {
      problems.push('the wall rendered no assigned cell to right-click: ' + JSON.stringify(hit))
    } else if (!menu.open) {
      problems.push('right-clicking an assigned cell did not open the context menu')
    } else {
      if (menu.role !== 'menu') {
        problems.push('the context menu has role "' + menu.role + '", expected "menu"')
      }
      if (hit.deviceName === '' || menu.title !== hit.deviceName) {
        problems.push(
          'the menu title is "' + menu.title + '" but the right-clicked cell\'s device name is "' +
          hit.deviceName + '"'
        )
      }
      if (menu.ariaLabel !== hit.deviceName) {
        problems.push('the menu aria-label is "' + menu.ariaLabel + '", expected the device name')
      }
      const nearCursor =
        menu.left <= hit.x + 1 &&
        menu.top <= hit.y + 1 &&
        hit.x - menu.left <= 320 &&
        hit.y - menu.top <= 320
      if (!nearCursor) {
        problems.push(
          'the menu did not open at the cursor: menu ' + menu.left + ',' + menu.top +
          ' vs cursor ' + hit.x + ',' + hit.y
        )
      }
      if (
        menu.left < 0 || menu.top < 0 ||
        menu.left + menu.width > menu.viewport.w ||
        menu.top + menu.height > menu.viewport.h
      ) {
        problems.push('the menu leaves the viewport: ' + JSON.stringify(menu))
      }

      // 标签与顺序：逐项比较整个数组（少一项、换顺序、漏翻译都会在这里失败）。
      const labels = menu.items.map((item) => item.label)
      log('menu labels   : ' + JSON.stringify(labels))
      if (JSON.stringify(labels) !== JSON.stringify(expected)) {
        problems.push(
          'the context menu labels/order are wrong for ' + locale + ': got ' +
          JSON.stringify(labels) + ' expected ' + JSON.stringify(expected)
        )
      }
      // 三个新入口必须在**当前语言**下出现，而且按 回放 -> 下载 -> 关闭 的顺序。
      const l = menuLabels(locale)
      const newLabels = [l.playback, l.downloadDetect, l.closeTile]
      for (const label of newLabels) {
        if (!labels.includes(label)) {
          problems.push('locale ' + locale + ' does not render the new menu item "' + label + '"')
        }
      }
      const order = newLabels.map((label) => labels.indexOf(label))
      if (!(order[0] >= 0 && order[0] < order[1] && order[1] < order[2])) {
        problems.push(
          'the three new items are not in the order playback -> download-detect -> close-tile: ' +
          JSON.stringify(order.map((index, position) => newLabels[position] + ' @' + index))
        )
      }
      // 每一项都要有名字；灰显项必须把原因**画在菜单里**，而且 title 与它是同一句话。
      for (const item of menu.items) {
        if (!item.label) problems.push('a menu item at index ' + item.index + ' has no label')
        if (item.disabled) {
          if (!item.reason) {
            problems.push('the disabled menu item "' + item.label + '" renders NO reason')
          }
          if (item.title !== item.reason) {
            problems.push(
              'the disabled item "' + item.label + '" is titled "' + item.title +
              '" but explains "' + item.reason + '"'
            )
          }
        }
      }
      const capture = menu.items[0]
      if (!capture || !capture.hasSubmenu) {
        problems.push('the first menu item is not the capture submenu parent')
      }

      // 2) 展开二级菜单：点父项，子项应当出现「手动录像 / 抓图」。
      const expandClick = await clickMenuLabel(win, expected[0], 'top')
      log('submenu click : ' + JSON.stringify(expandClick))
      await sleep(350)
      const expanded = await probeMenu(win)
      log('submenu open  : ' + JSON.stringify({ open: expanded.open, submenuOpen: expanded.submenuOpen, subItems: expanded.subItems }))
      if (!expanded.open || !expanded.submenuOpen) {
        problems.push('clicking the capture item did not expand its submenu')
      } else {
        const subLabels = expanded.subItems.map((item) => item.label)
        if (JSON.stringify(subLabels) !== JSON.stringify([l.startRecording, l.snapshot])) {
          problems.push(
            'the capture submenu is wrong: got ' + JSON.stringify(subLabels) +
            ' expected ' + JSON.stringify([l.startRecording, l.snapshot])
          )
        }
      }

      // 3) Escape：两层结构下先收子菜单，再关菜单（一次全关会让人失去位置）。
      if (expanded.open && expanded.submenuOpen) {
        await pressEscapeOnMenu(win)
        await sleep(300)
        const afterFirstEscape = await probeMenu(win)
        if (!afterFirstEscape.open) {
          problems.push('the first Escape closed the whole menu instead of just the submenu')
        } else if (afterFirstEscape.submenuOpen) {
          problems.push('the first Escape did not close the submenu')
        }
      }
      await pressEscapeOnMenu(win)
      await sleep(300)
      const afterEscape = await probeMenu(win)
      log('escape close  : ' + JSON.stringify(afterEscape))
      if (afterEscape.open) problems.push('Escape did not close the context menu')
    }

    // 4) 再右键一次会重开，然后点击外部必须关掉它。
    await rightClickCell(win, 'assigned')
    await sleep(350)
    const reopened = await probeMenu(win)
    if (!reopened.open) problems.push('the menu did not reopen on a second right-click')
    const outsideClick = await clickOutsideMenu(win)
    await sleep(300)
    const afterOutside = await probeMenu(win)
    log('outside close : ' + JSON.stringify({ click: outsideClick, menuOpen: afterOutside.open }))
    if (afterOutside.open) problems.push('a click outside the menu did not close it')

    // 5) 空白格**不**打开相机菜单（模型对一台不存在的相机只会给一屏灰项）。
    //
    // 这一步有一个**前提**：墙上得真的有一个没分配相机的格子，而它取决于当前档位
    // （1 分屏下那一格就是相机，一个空格都没有）。前提不成立时**不许**把它报成产品
    // 缺陷——那等于把「没测到」说成「测出来是坏的」。
    //
    // 偶发过一次：档位是 1，于是这里报出「no empty cell」，而日志里没有任何档位证据，
    // 事后完全无法判断是产品变了还是探针走错了。所以现在先把前提**建立起来**（没有
    // 空格就切到 4 分屏：一台相机 ⇒ 三个空格），并把当时的档位原样记下来；
    // 只有在切过去之后仍然没有空格，才算真的测不到，并且带上证据。
    let emptyHit = await rightClickCell(win, 'empty')
    if (!emptyHit.found) {
      const before = await probeUi(win)
      const pressedTabs = ((before.cameraWall && before.cameraWall.layout
        ? before.cameraWall.layout.buttons
        : []) || [])
        .filter((button) => button.pressed)
        .map((button) => button.label)
      log(
        'empty cell    : no empty cell at the current layout ' +
        JSON.stringify({
          cells: before.cameraWall ? before.cameraWall.cells : null,
          videos: before.cameraWall ? before.cameraWall.videos : null,
          pressedTabs: pressedTabs
        })
      )
      const relaxed = await clickLayoutTab(win, 4)
      if (relaxed.clicked) {
        await sleep(300)
        emptyHit = await rightClickCell(win, 'empty')
        log('empty cell    : switched to 4-up to establish the precondition -> ' + JSON.stringify(emptyHit))
      }
    }
    await sleep(350)
    const emptyMenu = await probeMenu(win)
    log('empty cell    : ' + JSON.stringify(emptyHit) + ' -> menu ' + JSON.stringify(emptyMenu))
    if (!emptyHit.found) {
      problems.push(
        'the wall rendered no empty cell even after switching to 4-up, so the empty-cell rule ' +
        'could not be measured: ' + JSON.stringify(emptyHit)
      )
    } else if (emptyMenu.open) {
      problems.push('right-clicking an EMPTY cell opened a camera menu (there is no camera in that cell)')
    }

    // 6) 灰显项的原因：把这一格停掉（没有画面 => 抓图/录像不可用），从 DOM 里把原因读出来。
    const stopped2 = await pressBarPlayback(win)
    log('nvr stop      : ' + JSON.stringify(stopped2))
    if (stopped2.pressed) {
      const noVideo = await waitForNoVideo(win, 15000)
      log('nvr idle      : ' + JSON.stringify({ found: noVideo.found, videoElements: noVideo.videoElements }))
      const idleHit = await rightClickCell(win, 'assigned')
      await sleep(400)
      const idleMenu = await probeMenu(win)
      if (!idleHit.found || !idleMenu.open) {
        problems.push('the menu did not open on an assigned cell with no picture: ' + JSON.stringify({ idleHit, idleMenu }))
      } else {
        const disabled = idleMenu.items.filter((item) => item.disabled)
        log(
          'nvr disabled  : ' +
          JSON.stringify(disabled.map((item) => ({ label: item.label, reason: item.reason })))
        )
        if (disabled.length === 0) {
          problems.push('no menu item is disabled while the cell has no picture')
        }
        for (const item of disabled) {
          if (!item.reason) {
            problems.push('the disabled item "' + item.label + '" renders NO reason (a greyed item must explain itself)')
          }
        }
        const l = menuLabels(locale)
        const idleCapture = idleMenu.items[0]
        if (!idleCapture || !idleCapture.disabled) {
          problems.push('the capture item is not disabled while the cell has no picture')
        } else if (idleCapture.reason !== l.reasonIdle) {
          problems.push(
            'the disabled capture item explains "' + idleCapture.reason +
            '", expected the locale\'s idle reason "' + l.reasonIdle + '"'
          )
        }
      }
      await pressEscapeOnMenu(win)
      await sleep(250)
      const started2 = await pressBarPlayback(win)
      const back = await waitForDecoded(win, 30000)
      log(
        'nvr restart   : ' + JSON.stringify({ pressed: started2.pressed, label: started2.labelBefore, decoded: !!(back.found && back.videoWidth > 0) })
      )
      if (!(back.found && back.videoWidth > 0)) {
        problems.push('the picture did not come back after the disabled-item probe')
      }
    }

    // 7) 录像：从菜单里真的开始一次，再真的停止。
    const beforeRec = await probe(win)
    if (beforeRec.found && beforeRec.videoWidth > 0) {
      const l = menuLabels(locale)
      // 「有画面」不等于「现在能录」：模型的判据是主进程报的 `playing`，而 `start`
      // 之后那一次补读要过一会儿才发生。等的是**菜单项真的可点**，不是睡一个猜的秒数。
      const ready = await waitForCaptureReady(win, 20000)
      const liveStatus = await readLiveStatus(win, camera.id)
      const wallState = await readCellNvr(win)
      log('record ready  : ' + JSON.stringify({ ready: ready.ready, attempts: ready.attempts, captureDisabled: ready.menu && ready.menu.items && ready.menu.items[0] ? ready.menu.items[0].disabled : null }))
      log('record status : ' + JSON.stringify({ process: liveStatus, badges: wallState.badges, videos: wallState.videos }))
      // 界面与主进程必须说同一件事：主进程说 playing，界面就不能还挂着「正在启动」。
      const processPlaying = !!(liveStatus.ok && liveStatus.states.some((s) => s.status === 'playing'))
      if (processPlaying && !ready.ready) {
        problems.push(
          'the main process reports "playing" but the wall still greys out the capture items: ' +
          JSON.stringify({ process: liveStatus, badges: wallState.badges })
        )
      }
      if (!ready.ready) {
        problems.push(
          'the capture menu item never became clickable within 20s: ' +
          JSON.stringify({
            capture: ready.menu && ready.menu.items ? ready.menu.items[0] : ready.menu,
            process: liveStatus,
            badges: wallState.badges
          })
        )
      }
      const startClick = { clicked: false, reason: 'capture item never became clickable', label: '' }
      let startResult = startClick
      if (ready.ready) {
        // 菜单此刻是开着的（`waitForCaptureReady` 成功时保持打开）：先展开子菜单，
        // 再点「手动录像」。
        await clickMenuLabel(win, l.capture, 'top')
        await sleep(350)
        startResult = await clickMenuLabel(win, l.startRecording, 'sub')
      }
      log('record start  : ' + JSON.stringify(startResult))
      // 给录像那个 ffmpeg 足够的时间：它要**另开**一条 RTSP 连接、等第一个关键帧，
      // 分片 MP4 才会真的写出字节。停得太早会得到一个 0 字节的文件，而那说明不了
      // 「录像不能用」，只能说明探针太急。
      await sleep(8000)
      const during = await readCellNvr(win)
      const recBadge = during.rec.find((text) => text !== '') || ''
      const duringNotices = during.notices.filter(Boolean).map((entry) => entry.text)
      log('record during : ' + JSON.stringify({ badge: recBadge, notices: duringNotices, videos: during.videos }))
      if (!startResult.clicked) {
        problems.push('could not start manual recording from the menu: ' + JSON.stringify(startResult))
      } else if (recBadge === '' && duringNotices.length === 0) {
        // 静默的 no-op 是这里唯一不可接受的结果：管理员拒绝也必须看得见。
        problems.push('manual recording produced no visible outcome at all (no REC indicator, no notice)')
      }
      // 停止：再来一次右键，并从子菜单里点「停止录像」。
      await rightClickCell(win, 'assigned')
      await sleep(400)
      const menuDuring = await probeMenu(win)
      const captureDuring = menuDuring.open ? menuDuring.items[0] : null
      if (captureDuring && captureDuring.label !== l.capture) {
        problems.push('the capture item changed its label while recording: ' + captureDuring.label)
      }
      await clickMenuLabel(win, l.capture, 'top')
      await sleep(350)
      const stopClick = await clickMenuLabel(win, l.stopRecording, 'sub')
      log('record stop   : ' + JSON.stringify(stopClick))
      await sleep(1400)
      const after = await readCellNvr(win)
      const stillRec = after.rec.find((text) => text !== '') || ''
      log(
        'record after  : ' +
        JSON.stringify({ badge: stillRec, notices: after.notices.filter(Boolean).map((entry) => entry.text) })
      )
      if (!stopClick.clicked) {
        problems.push('the recording could not be stopped from the menu: ' + JSON.stringify(stopClick))
      }
      if (recBadge !== '' && stillRec !== '') {
        problems.push('the REC indicator survived a stop: ' + stillRec)
      }
    } else {
      log('record        : skipped — no decoded picture to record')
    }
  } else if (ROUTE === '/') {
    log('nvr menu      : not exercised (' + (OBSERVE_ONLY ? '--observe-only' : 'no decoded picture') + ')')
  }

  // Every layout option is pressed, not just the two ends, and each one has to produce
  // exactly its own number of cells. The camera wall's set is 1 / 4 / 9 / 16 (9 = 3x3;
  // the channel wall's set is 1 / 2 / 4 / 8 and is swept in its own block above — its
  // grid is driven by the tiles an AE08 reports, not by a camera). This runs AFTER the
  // screenshot on purpose: changing the layout re-keys every cell, so the <video> is
  // remounted and the PNG above would catch it mid-decode if this ran first.
  //
  // Pressing them in increasing order also exercises BOTH directions of the eviction
  // rule: growing keeps the assigned cameras, and the shrink from 16 back to 1 is the
  // direction that has to stop streams and must not leave a stale grid or a stale
  // <video> behind.
  //
  // Counting cells is NOT enough — 9 cells in one row would pass that and is not what
  // 「9 分屏」means — so each press also has to produce the right GRID and the icon of
  // the button that was pressed has to describe that same grid.
  //
  // `--observe-only` skips this for the same reason as the volume slider: it must not
  // press anything.
  if (wall && ROUTE === '/' && !OBSERVE_ONLY) {
    for (const count of [1, 4, 9, 16]) {
      const pressed = await clickLayoutTab(win, count)
      log('wall layout ' + count + '-up: ' + JSON.stringify(pressed))
      if (!pressed.clicked) {
        problems.push('the wall rendered no ' + count + '-cell layout button: ' + JSON.stringify(pressed.labels))
        continue
      }
      if (pressed.cells !== count || pressed.videos + pressed.placeholders !== count) {
        problems.push('the ' + count + '-cell layout did not produce ' + count + ' cells: ' + JSON.stringify(pressed))
        continue
      }
      log(
        'wall ' + count + '-up cells: ' + pressed.cells + ' cell(s), ' + pressed.videos +
        ' with <video>, ' + pressed.placeholders + ' placeholder(s)'
      )
      const wanted = CAMERA_ICON_SHAPES[count]
      if (pressed.grid && wanted) {
        if (pressed.grid.columns !== wanted[0] || pressed.grid.rows !== wanted[1]) {
          problems.push(
            'the ' + count + '-cell layout rendered a ' + pressed.grid.columns + 'x' +
            pressed.grid.rows + ' grid, expected ' + wanted[0] + 'x' + wanted[1]
          )
        } else {
          log('wall ' + count + '-up grid : ' + pressed.grid.columns + 'x' + pressed.grid.rows)
        }
      }
      // 16:9 也在每一档上量一次。产品点名的是 4 分屏（「四个窗口默认是 16:9」），但比例
      // 是同一处 CSS 给的，四档全对才说明它来自 `aspect-ratio`；只有 4 分屏对，说明它
      // 只是 4 分屏那一档的巧合（例如被某个只在这一档不生效的最小高度顶住）。
      const layoutRatios = cellRatioReport(pressed.grid)
      log('wall ' + count + '-up ratio: ' + JSON.stringify(layoutRatios))
      cellRatioProblems('camera wall ' + count + '-up', pressed.grid)
      // The icon that was just pressed must describe the grid it produced: both are
      // drawn from the same inputs (`cameraWallColumns()`), so a disagreement here means
      // the switch and the wall have drifted apart.
      const active = pressed.layout
        ? pressed.layout.buttons.filter((button) => button.pressed)[0] || null
        : null
      if (active && pressed.grid) {
        if (
          active.cells !== pressed.grid.cells ||
          active.iconColumns !== pressed.grid.columns ||
          active.iconRows !== pressed.grid.rows
        ) {
          problems.push(
            'the ' + count + '-up icon (' + active.cells + ' box(es) in ' + active.iconColumns +
            'x' + active.iconRows + ') disagrees with the grid it produced (' +
            pressed.grid.cells + ' cells in ' + pressed.grid.columns + 'x' + pressed.grid.rows + ')'
          )
        }
      }
    }
  } else if (wall && ROUTE === '/') {
    // Nothing was pressed, but the icon of the ACTIVE layout can still be compared with
    // the grid that is on screen right now.
    const active = wall.layout
      ? wall.layout.buttons.filter((button) => button.pressed)[0] || null
      : null
    if (active && wall.grid) {
      const agrees =
        active.cells === wall.grid.cells &&
        active.iconColumns === wall.grid.columns &&
        active.iconRows === wall.grid.rows
      log(
        'layout icon   : active icon ' + active.cells + ' in ' + active.iconColumns + 'x' +
        active.iconRows + ' vs grid ' + wall.grid.cells + ' in ' + wall.grid.columns + 'x' +
        wall.grid.rows + ' -> ' + (agrees ? 'agrees' : 'DISAGREES')
      )
      if (!agrees) {
        problems.push(
          'the active layout icon disagrees with the grid on screen: ' + JSON.stringify({ active: active, grid: wall.grid })
        )
      }
    }
    log('wall layout   : not pressed (--observe-only)')
  }

  // -------------------------------------------------------------------------
  // 画面格 16:9、空白格 `+` 居中，以及 .page 在四档窗口尺寸下的对齐与宽度
  //
  // 这三件事都是**几何**，所以全部靠测量：
  //   - 16:9 只有量格子真正的盒子才算数（`aspect-ratio` 声明可能被行高或最小高度盖掉）；
  //   - 「+ 在窗口中心」只有量 `+` 的中心与格子的中心之差才算数；
  //   - 「靠左、和左边/上边保持固定距离、随分辨率自适应」只有真的把窗口改成四种尺寸、
  //     每一档都量一次 `.page` 的左边距/上边距/宽度才算数（这是产品负责人这一轮唯一
  //     无法从源码读出来的那条要求）。
  //
  // 4 分屏是产品点名的档位（「四个窗口默认是 16:9」），所以比例与居中都先在 4 分屏上
  // 再量一次：档位扫描留在 16 分屏，而比较必须在同一个档位下进行。
  //
  // `--observe-only` 那一次只做**不改动界面**的测量：它不按档位、也不改窗口大小，
  // 因为那一次运行要证明的是「一个控件都没按，画面自己出来了」，任何重排都可能把
  // 结论搅浑。所以观察模式下只报告当场那一档（新档位的默认就是 4 分屏）的数字。
  // -------------------------------------------------------------------------
  if (wall && ROUTE === '/') {
    // 读一次**当下**的 DOM：上面的档位扫描已经把墙换成 16 分屏，而 `wall` 是那之前
    // 的快照。用快照判断「现在是不是 4 分屏」会得出相反的结论，量出来的也会是旧盒子。
    const current = await probeUi(win)
    let fourUpWall = current.cameraWall
    let fourUpCount = pressedLayoutCount(current)
    if (fourUpCount !== 4 && !OBSERVE_ONLY) {
      const pressed = await clickLayoutTab(win, 4)
      log('ratio layout  : pressed 4-up -> ' + JSON.stringify({ clicked: pressed.clicked, grid: pressed.grid }))
      if (pressed.clicked) {
        fourUpCount = 4
        const after = await probeUi(win)
        fourUpWall = after.cameraWall
      }
    }
    if (fourUpWall && fourUpCount === 4) {
      const ratios = cellRatioReport(fourUpWall.grid)
      log('wall cell ratio: ' + JSON.stringify(ratios))
      cellRatioProblems('camera wall 4-up', fourUpWall.grid)
      // 空白格在这个档位上一定有（本机只有一台相机）：3 个空格各自量一次。
      emptyCellProblems('camera wall 4-up (re-measured)', fourUpWall.empty)
      log(
        'wall + centre : ' + JSON.stringify({
          offsetsX: fourUpWall.empty.addCenterOffsetXPx,
          offsetsY: fourUpWall.empty.addCenterOffsetYPx,
          cellWidths: fourUpWall.empty.addCellWidthPx,
          leftGaps: fourUpWall.empty.addLeftGapPx,
          rightGaps: fourUpWall.empty.addRightGapPx,
          tolerancePx: CENTRE_TOLERANCE_PX
        })
      )
    } else {
      log(
        'wall cell ratio: 未验证 — the wall is not at the 4-up layout (count=' + fourUpCount +
        ') and --observe-only must not press the layout switch'
      )
    }

    /**
     * 四档窗口尺寸下的 `.page` 几何。
     *
     * 顺序是刻意的（从小到大），因为「内容宽度随窗口变宽」这条断言读的是数组顺序；
     * 量完恢复 1440x900（主进程创建窗口时的尺寸），免得后面的面板探针在一个奇怪的
     * 尺寸下读数。
     */
    if (!OBSERVE_ONLY) {
      const REQUESTED_SIZES = [
        [1280, 720],
        [1366, 768],
        [1920, 1080],
        [2560, 1440]
      ]
      const measured = []
      for (const size of REQUESTED_SIZES) {
        win.setContentSize(size[0], size[1])
        // 一次重排 + 一次布局落定：分辨率改变会触发整个内容列的重新计算，读数必须
        // 落在稳定之后，否则量到的是过渡中的数字。
        await sleep(700)
        const geometry = await probePageGeometry(win)
        measured.push(geometry)
        log('page ' + size[0] + 'x' + size[1] + ' : ' + JSON.stringify(geometry))
      }
      pageGeometryProblems(measured, REQUESTED_SIZES)
      win.setContentSize(1440, 900)
      await sleep(600)
    } else {
      log(
        'page geometry : not measured (--observe-only): this run must not resize the window, ' +
        'the four-size measurement is part of the normal run'
      )
    }
  }

  // The camera control panel lives only on the route that shows a camera. Report it
  // even when video worked, because "video plays" and "the new panel is on screen"
  // are independent facts and the panel is the newer of the two.
  const panel = await probePanel(win)
  log('camera panel  : ' + JSON.stringify(panel))
  if (ROUTE.startsWith('/monitor')) {
    if (!panel.found) {
      problems.push('the camera control panel (.cctl) is not rendered on ' + ROUTE)
    } else {
      if (panel.cards < 1) problems.push('the camera control panel rendered no card')
      if (panel.primaryButtons.length === 0) {
        problems.push('no detection mode is shown as active — GET /run_mode was not reflected')
      }
      if (panel.sectionTitles.length === 0) {
        problems.push('the camera control panel rendered no section title')
      }
    }
  }

  // -------------------------------------------------------------------------
  // 本轮：两块屏幕在**四档窗口尺寸**下的排布几何
  //
  // 产品要求「重新排布一下」+「用掉可用宽度」+「自适应窗口大小」，这三句话都只能
  // 靠真实窗口里的测量回答。函数体在 `measureLayoutSweep()` 里。
  // -------------------------------------------------------------------------
  await measureLayoutSweep(win, panel)

  // -------------------------------------------------------------------------
  // 本轮 C：「应用模式」切换前的确认框（真按按钮、真读设备）。
  // -------------------------------------------------------------------------
  if (ROUTE.startsWith('/monitor') && !OBSERVE_ONLY) await driveAppModeConfirmation(win, camera.id)

  // -------------------------------------------------------------------------
  // 本轮 A：告警配置对话框 —— 提示删掉了、三个控件一行、刷新在最右。
  // -------------------------------------------------------------------------
  if (ROUTE.startsWith('/monitor') && !OBSERVE_ONLY) await measureAlarmDialog(win, camera.id)

  // -------------------------------------------------------------------------
  // 通道墙（这一轮）：1/2/4/8 档位的图标 vs 真实网格、图形切换器、默认收起，
  // 以及四种图形**到底画了什么**。
  //
  // 为什么每一条都必须测量：
  //   - 「2 分屏」是两列还是两行，只有读浏览器算出来的 `grid-template-columns` 才算数：
  //     本机只有一个设备，墙上只有一格，数格子的左边缘永远只数出“一列”；
  //   - 「没有通道在线就默认收起」只有在真的没有在线通道时才成立，所以先把前提建立
  //     起来（读设备列表），再断言 `aria-expanded` 与网格在不在；
  //   - 「画的是真实数据还是如实说明」只有把每一格渲染出的三种形态都读出来才能回答：
  //     设备 JPEG 要看 `naturalWidth`（有没有真的解码）、折线要看 `points` 的个数、
  //     说明要看当前语言里那句话到底是哪一句。
  //
  // `--observe-only` 那一次**只读不按**：它要证明的是“一个控件都没按，画面自己出来了”，
  // 所以这里只报告当时的收起状态，不展开、不切档位、不切图形、也绝不开相机会话。
  // -------------------------------------------------------------------------
  if (ROUTE === '/') {
    const cwLocale = await readLocale(win)
    const cwLang = cwLocale.lang === '' ? 'zh-CN' : cwLocale.lang
    const cwLabels = channelWallLabels(cwLang)

    const deviceRows = await evalInPage(
      win,
      'listDevices',
      '(async () => { try {' +
        '  const r = await window.api.devices.list();' +
        '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
        '  return JSON.stringify({ ok: true, devices: (r.data || []).map((d) => ({ kind: d.kind, status: d.status })) });' +
        '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
    )
    const deviceList = deviceRows === null ? { ok: false } : JSON.parse(deviceRows)
    const onlineBoxes = deviceList.ok
      ? deviceList.devices.filter((d) => d.kind === 'acousticBox' && d.status === 'ONLINE')
      : []
    log('channel devices: ' + JSON.stringify(deviceList))

    const cwBefore = await probeUi(win)
    const cw0 = cwBefore.channelWall
    if (!cw0) {
      problems.push('the Overview rendered no channel wall (.card.wall)')
    } else {
      log('channel wall  : ' + JSON.stringify(cw0))
      log('channel graph : ' + JSON.stringify(cw0.graph ? cw0.graph.buttons.map((b) => (b.pressed ? '*' : ' ') + b.label) : null))

      // --- 1) 没有在线通道时默认收起，而且收起状态是可被读出来的 ---------
      if (!deviceList.ok) {
        log('channel collapse: 未验证 — the device list could not be read, so "no channel is online" could not be established')
      } else if (onlineBoxes.length === 0) {
        if (cw0.collapsed !== true) {
          problems.push(
            'no channel is online but the channel wall is NOT collapsed by default: ' + JSON.stringify(cw0)
          )
        }
        if (!cw0.disclosure) {
          problems.push('the channel wall has no disclosure control, so a collapsed wall cannot be expanded')
        } else {
          if (cw0.disclosure.expanded !== 'false') {
            problems.push(
              'the collapsed channel wall does not announce itself as collapsed: aria-expanded=' +
              cw0.disclosure.expanded
            )
          }
          if (cw0.disclosure.label !== cwLabels.expand) {
            problems.push(
              'the collapsed channel wall\'s control is named "' + cw0.disclosure.label +
              '", expected the locale\'s "expand" wording "' + cwLabels.expand + '"'
            )
          }
          if (!cw0.disclosure.svg) problems.push('the channel wall disclosure has no icon')
          if (!cw0.disclosure.inHeader) {
            problems.push('the channel wall disclosure is not inside its .section-header')
          }
        }
        if (cw0.grid !== null) {
          problems.push('the collapsed channel wall still rendered its grid')
        }
        if (!cw0.collapsedHint) {
          problems.push(
            'the collapsed channel wall says nothing about why it is empty: an online-less wall must not look broken'
          )
        }
        log(
          'channel collapse: collapsed=' + cw0.collapsed +
          ' aria-expanded=' + (cw0.disclosure ? cw0.disclosure.expanded : null) +
          ' label=' + JSON.stringify(cw0.disclosure ? cw0.disclosure.label : null) +
          ' hint=' + JSON.stringify(cw0.collapsedHint) +
          ' summary=' + JSON.stringify(cw0.summary)
        )
      } else {
        log(
          'channel collapse: not asserted — an ONLINE acoustic box exists (' + onlineBoxes.length +
          '), so "no channel is online" is not the situation on screen'
        )
      }

      if (OBSERVE_ONLY) {
        log('channel wall  : layout / graph / disclosure NOT pressed (--observe-only)')
      } else {
        /**
         * --- 2) 收起 / 展开：两个方向都要真的能用 -------------------------
         *
         * **不能假设它一开始是收起的**：产品的默认行为是「没有通道在线就收起」，所以
         * 只有相机（或设备离线）时它默认收起，而有一台在线声纹设备时它默认展开。
         * 这一轮之前这里写死了「先按一下 => 一定变成展开状态」，于是**只有**在临时
         * profile 里另外登记了声纹设备（`--route / --box-ip …`）时整段会错位：第一次
         * 按下其实是把它收起来，后面所有测量都对着一个没有网格的收起状态做，最后刷一次
         * 页面还会把「操作员展开过」判成丢失。现在先读当前状态，再按，断言**按一下真的
         * 翻转了**，两个方向各测一次，并保证收尾时是展开的（后面的测量需要网格）。
         */
        const startWall = (await probeUi(win)).channelWall
        const startExpanded = !!(
          startWall && startWall.disclosure && startWall.disclosure.expanded === 'true'
        )
        log('channel start : disclosure ' + (startExpanded ? 'expanded' : 'collapsed') +
          ', collapsed flag=' + (startWall ? startWall.collapsed : null))

        const flipDisclosure = async (label) => {
          const press = await pressChannelDisclosure(win)
          log('channel ' + label + ': ' + JSON.stringify(press))
          if (!press.pressed) {
            problems.push('the channel wall has no disclosure button to press')
            return null
          }
          const wanted = press.before === 'true' ? 'false' : 'true'
          const wantedCollapsed = wanted === 'false'
          if (press.after !== wanted) {
            problems.push(
              'pressing the channel wall disclosure did not flip aria-expanded: ' +
              press.before + ' -> ' + press.after
            )
          }
          if (press.collapsed !== wantedCollapsed) {
            problems.push(
              'the channel wall reports collapsed=' + press.collapsed +
              ' after the press left aria-expanded=' + press.after
            )
          }
          if (wantedCollapsed) {
            if (press.cells !== 0) {
              problems.push('the collapsed channel wall still rendered its grid: ' + press.cells + ' tile(s)')
            }
            if (press.labelAfter !== cwLabels.expand) {
              problems.push(
                'the collapsed channel wall\'s control is named "' + press.labelAfter +
                '", expected the locale\'s "expand" wording "' + cwLabels.expand + '"'
              )
            }
          } else {
            if (press.cells < 1) {
              problems.push('the expanded channel wall rendered no tile: ' + JSON.stringify(press))
            }
            if (press.labelAfter !== cwLabels.collapse) {
              problems.push(
                'the expanded channel wall\'s control is named "' + press.labelAfter +
                '", expected "' + cwLabels.collapse + '"'
              )
            }
          }
          return press
        }

        await flipDisclosure('flip 1')
        await flipDisclosure('flip 2')
        if (!startExpanded) {
          // 两次翻转回到起点（收起）：再按一次，收尾必须是展开的。
          await flipDisclosure('flip 3')
        }
        const settledWall = (await probeUi(win)).channelWall
        log('channel end   : collapsed=' + (settledWall ? settledWall.collapsed : null) +
          ', aria-expanded=' + (settledWall && settledWall.disclosure ? settledWall.disclosure.expanded : null) +
          ', tiles=' + (settledWall && settledWall.grid ? settledWall.grid.cells : null))
        if (!settledWall || settledWall.collapsed !== false) {
          problems.push(
            'the channel wall is not expanded after the disclosure exercise, so the measurements ' +
            'below would run against a collapsed wall: ' + JSON.stringify(settledWall)
          )
        }

        // --- 3) 档位：**设备真实通道数**决定控件里有哪几档 ----------------
        //
        // 这一轮之前这里写死遍历 [1,2,4,8]，于是「2 路盒子也给出 8 分屏」这件事
        // 测不出来。现在两步都要：
        //   a) 先量设备端**真实**的通道表（`GET /get_passageway`）与启用/禁用分布；
        //   b) 再由通道数算出该有哪几档（`expectedChannelLayouts()`，与纯函数同规则），
        //      断言控件渲染出来的**正是**那一组（多一档、少一档都算错）；
        //   c) 然后每一档都真的按一下，量浏览器排出来的列数。
        const boxDevice = picks.box || null
        let boxChannels = null
        if (!boxDevice) {
          log('channel box   : 未验证 — 本次运行的临时 profile 里没有声纹设备' +
            (BOX_IP === '' ? '（没有给 --box-ip）' : '（--box-ip 给了但登记失败）') +
            '，所以「真实通道数 → 档位」只用相机墙那一侧的量法')
        } else {
          boxChannels = await evalJson(win, 'boxChannelsForWall', deviceChannelsScript(boxDevice.id), {
            ok: false
          })
          const rows = boxChannels.ok ? boxChannels.channels || [] : []
          const enabledRows = rows.filter((channel) => channel.enabled === true)
          log(
            'channel box   : ' + JSON.stringify({
              device: boxDevice.name,
              channels: rows.length,
              enabled: enabledRows.map((channel) => channel.channelIndex),
              disabled: rows.filter((channel) => channel.enabled === false).map((c) => c.channelIndex),
              unknown: rows.filter((c) => c.enabled !== true && c.enabled !== false).map((c) => c.channelIndex),
              probeFailed: !boxChannels.ok
            })
          )
          if (!boxChannels.ok) {
            problems.push(
              'the box channel table could not be read, so the trimmed layout set could not be ' +
              'checked against the device: ' + JSON.stringify(boxChannels)
            )
          }
        }

        const renderedLayoutCounts = cwBefore.channelWallLayout
          ? cwBefore.channelWallLayout.buttons.map((button) => layoutCountOf(button.label))
          : []
        const expectedLayouts = expectedChannelLayouts(
          boxChannels && boxChannels.ok ? (boxChannels.channels || []).length : 0
        )
        log(
          'channel layout set: rendered ' + JSON.stringify(renderedLayoutCounts) +
          ', expected from the device channel table ' + JSON.stringify(expectedLayouts)
        )
        if (renderedLayoutCounts.join(',') !== expectedLayouts.join(',')) {
          problems.push(
            'the channel wall layout control offers ' + JSON.stringify(renderedLayoutCounts) +
            ', but the device channel table gives ' + JSON.stringify(expectedLayouts) +
            ' (a 2-channel box must not offer 4 or 8)'
          )
        }
        const trimmedByDevice = boxChannels && boxChannels.ok && (boxChannels.channels || []).length > 0 &&
          renderedLayoutCounts.join(',') !== '1,2,4,8'
        if (trimmedByDevice) {
          log('channel layout set: trimmed by the device\'s real channel count (not the protocol constant 8)')
        }

        /**
         * 通道墙的**格子数**与**通道数**是两件事，这里必须分开算。
         *
         * 这段代码原先直接拿「共 N 路通道」里的 N 当**格子总数**用，于是「相机格算不算
         * 通道」这件事一旦纠正（`channelTileCount()`：相机不是通道），只有相机的墙上
         * N=0 而格子=1，探针就会报出四个**自己造出来的**失败。
         *
         * 现在的算法照着界面自己的规则来：
         *   格子数 = 通道数（= 通道表行数，由摘要文字确认）+ 相机台数 × 1
         * 相机固定占一格（`buildTiles()`：相机没有通道），所以「相机台数」就是它贡献的
         * 格子数，来源是设备列表里的真实设备，不是猜的。
         */
        const channelCount = Number((/(\d+)/.exec(cw0.summary) || [])[1])
        const knownCount = Number.isFinite(channelCount) ? channelCount : -1
        const cameraDevices = deviceList.ok
          ? (deviceList.devices || []).filter((device) => device.kind === 'acousticCamera').length
          : 0
        const expectedTileCount = knownCount >= 0 ? knownCount + cameraDevices : -1
        // 摘要说的必须是**通道**，不是格子：声纹设备的通道数就是它通道表的行数，
        // 没有声纹设备时是 0（相机一格都不算）。
        const boxRowCount = boxChannels && boxChannels.ok ? (boxChannels.channels || []).length : 0
        if (knownCount !== boxRowCount) {
          problems.push(
            'the channel wall summary says ' + JSON.stringify(cw0.summary) + ' (' + knownCount +
            '), but the device reports ' + boxRowCount + ' channel row(s) — the number must count ' +
            'channels, and a camera tile is not a channel'
          )
        }
        log(
          'channel tiles  : summary says ' + knownCount + ' channel(s), device reports ' + boxRowCount +
          ' row(s); camera tiles ' + cameraDevices + ' => expected tiles ' + expectedTileCount
        )
        for (const count of renderedLayoutCounts) {
          const pressed = await clickChannelLayout(win, count)
          const cw = pressed.channelWall
          const wanted = CHANNEL_ICON_SHAPES[count]
          if (!pressed.clicked) {
            problems.push(
              'the channel wall rendered no ' + count + '-cell layout button: ' + JSON.stringify(pressed.labels)
            )
            continue
          }
          const active = pressed.channelWallLayout
            ? pressed.channelWallLayout.buttons.filter((button) => button.pressed)[0] || null
            : null
          log(
            'channel ' + count + '-up  : ' + JSON.stringify({
              label: pressed.label,
              grid: cw ? cw.grid : null,
              icon: active
                ? { cells: active.cells, columns: active.iconColumns, rows: active.iconRows }
                : null
            })
          )
          if (!active) {
            problems.push('the channel wall has no pressed layout button after pressing ' + count + '-up')
          } else {
            if (active.cells !== count) {
              problems.push('the ' + count + '-up icon draws ' + active.cells + ' cell(s), expected ' + count)
            }
            if (!wanted) {
              problems.push('no expected icon shape is known for the ' + count + '-up layout')
            } else if (active.iconColumns !== wanted[0] || active.iconRows !== wanted[1]) {
              problems.push(
                'the ' + count + '-up icon is ' + active.iconColumns + 'x' + active.iconRows +
                ', expected ' + wanted[0] + 'x' + wanted[1]
              )
            }
          }
          if (!cw || !cw.grid) {
            problems.push('the expanded channel wall reported no grid after pressing ' + count + '-up')
            continue
          }
          if (!wanted) {
            problems.push('the ' + count + '-up layout has no known column count to check')
          } else if (cw.grid.resolvedColumns !== wanted[0]) {
            problems.push(
              'the channel wall ' + count + '-up layout resolves to ' + cw.grid.resolvedColumns +
              ' column(s) in the browser, but its icon (and `layoutColumns()`) says ' + wanted[0] +
              ' — ' + JSON.stringify(cw.grid)
            )
          }
          if (expectedTileCount >= 0) {
            const expectedCells = Math.min(expectedTileCount, count)
            if (cw.grid.cells !== expectedCells) {
              problems.push(
                'the ' + count + '-up layout rendered ' + cw.grid.cells + ' tile(s) for ' +
                expectedTileCount + ' tile(s) of content (' + knownCount + ' channel(s) + ' +
                cameraDevices + ' camera tile(s)), expected ' + expectedCells
              )
            }
          }
          log(
            'channel ' + count + '-up grid: ' + cw.grid.resolvedColumns + ' resolved column(s), ' +
            cw.grid.columns + ' occupied column(s), ' + cw.grid.rows + ' row(s), ' +
            cw.grid.cells + ' cell(s)'
          )
        }

        // --- 3b) 每一格的**通道状态**与**最近告警**（这一轮的新内容）---------
        //
        // 两句都必须对着**设备端读回的通道表**核，而不是「有徽标就算过」：
        //   - 状态徽标：真机 8 路里 ch0/ch1 启用、ch2–ch7 未启用，徽标必须一模一样；
        //   - 最近告警：标签固定是「最近告警」（不是「正在告警」），值只能是
        //     「无告警记录」/「读取中…」/「读取失败」/「类型 · 时间 · 确认状态」之一。
        // 另外钉住「没有数据就不显示 0」：一格没有实时数值时，`.wall-tile__metrics`
        // 与 `.wall-tile__metric-value` 都不该存在。
        // 最近告警是**异步**读回来的（每路一次本地库查询）：先等它落地，再断言。
        // 等不到也会用最后那一份快照继续断言，于是「一直卡在读取中」会以问题的形式出现，
        // 而不是被这段等待悄悄吞掉。
        //
        // 只有设备端**确实有通道**时才等：临时 profile 里没有盒子时根本没有等待对象，
        // 那种情况下无条件轮询 15 秒只会把一次正常的运行写成「没稳定下来」。
        const expectBoxTiles = !!(boxChannels && boxChannels.ok && (boxChannels.channels || []).length > 0)
        const tilesSettled = expectBoxTiles
          ? await waitForChannelWall(
              win,
              (facts) =>
                facts.tiles.some((tile) => !tile.camera) &&
                facts.tiles.every((tile) => tile.camera || tile.alarmValue !== cwLabels.alarmLoading),
              15000
            )
          : { ok: true, attempts: 0, wall: (await probeUi(win)).channelWall }
        if (!tilesSettled.ok) {
          log(
            'channel tiles : the alarm reading did not settle within ' + tilesSettled.attempts +
            ' probe(s); the tiles below are what it actually rendered'
          )
        }
        const tileSnapshot = tilesSettled.wall
        const wallTiles = tileSnapshot ? tileSnapshot.tiles : []
        const channelRows = boxChannels && boxChannels.ok ? boxChannels.channels || [] : []
        let boxTilesSeen = 0
        for (const tile of wallTiles) {
          // 相机格没有通道：它既不该有状态徽标，也不该有告警那一行。
          if (tile.camera) {
            if (tile.state) problems.push('a camera tile rendered a channel state badge: ' + JSON.stringify(tile))
            if (tile.alarmPresent) {
              problems.push('a camera tile rendered a "latest alarm" row although it has no channel: ' + JSON.stringify(tile))
            }
            continue
          }
          boxTilesSeen += 1
          log(
            'channel tile  : ' + JSON.stringify({
              device: tile.device,
              label: tile.label,
              state: tile.state,
              stateTitle: tile.stateTitle,
              alarmLabel: tile.alarmLabel,
              alarmValue: tile.alarmValue,
              alarmTitle: tile.alarmTitle,
              metricValues: tile.metricValues,
              metricTitle: tile.metricTitle
            })
          )
          if (!tile.state) {
            problems.push('a box channel tile rendered no channel state badge: ' + JSON.stringify(tile))
          } else {
            const allowed = [cwLabels.stateEnabled, cwLabels.stateDisabled, cwLabels.stateUnknown]
            if (allowed.indexOf(tile.state) === -1) {
              problems.push(
                'a box channel tile says "' + tile.state + '", which is not one of the locale\'s ' +
                'channel states ' + JSON.stringify(allowed)
              )
            }
            // 与设备端通道表逐路对齐：索引从格子标签 `CH3` 反推（0 基）。
            const index = Number((/^CH(\d+)$/.exec(tile.label) || [])[1]) - 1
            const row = channelRows.filter((channel) => channel.channelIndex === index)[0] || null
            if (boxChannels && boxChannels.ok && !row) {
              problems.push(
                'the channel wall rendered a tile for ' + tile.label + ', which the device channel table ' +
                'does not contain: ' + JSON.stringify(channelRows)
              )
            } else if (row) {
              const wanted = row.enabled === true
                ? cwLabels.stateEnabled
                : row.enabled === false
                  ? cwLabels.stateDisabled
                  : cwLabels.stateUnknown
              if (tile.state !== wanted) {
                problems.push(
                  tile.label + ' renders the state "' + tile.state + '" but the device channel table says ' +
                  '"' + wanted + '" (enabled=' + JSON.stringify(row.enabled) + ')'
                )
              }
            }
          }
          if (tile.alarmLabel !== cwLabels.alarmRecent) {
            problems.push(
              'a box channel tile labels its alarm line "' + tile.alarmLabel + '", expected the locale\'s ' +
              'latest-alarm wording "' + cwLabels.alarmRecent + '" (never "alarming now": there is no ' +
              'per-channel live alarm push)'
            )
          }
          if (!tile.alarmValue) {
            problems.push('a box channel tile rendered an empty alarm value: ' + JSON.stringify(tile))
          } else if (tile.alarmValue === cwLabels.alarmNone) {
            log('  ' + tile.label + ' alarm: ' + JSON.stringify(tile.alarmValue) + ' (本地库这一路没有记录)')
          } else if (tile.alarmValue === cwLabels.alarmLoading) {
            problems.push(tile.label + ' still says "' + cwLabels.alarmLoading + '" after the wall settled')
          } else if (tile.alarmValue === cwLabels.alarmFailed) {
            log('  ' + tile.label + ' alarm: 读取失败 ' + JSON.stringify(tile.alarmTitle))
          } else if (!/ · /.test(tile.alarmValue)) {
            problems.push(
              tile.label + ' alarm value "' + tile.alarmValue + '" is neither a record nor a known state'
            )
          } else {
            log('  ' + tile.label + ' alarm: ' + JSON.stringify(tile.alarmValue))
          }
          // 没有实时数值时不许出现一个裸 0：`.wall-tile__metric-value` 应当不存在。
          if (tile.metricValues.length > 0) {
            log('  ' + tile.label + ' live metric(s): ' + JSON.stringify(tile.metricValues) +
              ' unitTitle=' + JSON.stringify(tile.metricTitle || tile.unitTitles))
          } else if (/(^|[^0-9.])0([^0-9.]|$)/.test(tile.wholeText.replace(/\bCH\d+\b/g, ''))) {
            problems.push(
              'a box channel tile without live data still renders a bare 0: ' + JSON.stringify(tile.wholeText)
            )
          }
        }
        log('channel tiles : ' + boxTilesSeen + ' box channel tile(s), ' + wallTiles.length + ' tile(s) on this page')
        if (boxTilesSeen === 0) {
          if (expectBoxTiles) {
            // 设备端有通道、墙上却没有通道格：这是缺陷，不是「本次运行没有盒子」。
            problems.push(
              'the device reports ' + (boxChannels.channels || []).length + ' channel(s) but this page rendered ' +
              'no box channel tile, so the state/alarm reading could not be checked'
            )
          } else {
            log('channel tiles : 未验证 — 临时 profile 里没有声纹设备，所以没有声纹通道格可量')
          }
        }

        // --- 4) 图形切换器 --------------------------------------------------
        if (!cw0.graph || cw0.graph.buttons.length !== 4) {
          problems.push(
            'the channel wall graph selector has ' +
            (cw0.graph ? cw0.graph.buttons.length : 0) + ' buttons, expected 4'
          )
        } else {
          if (!cw0.graph.groupLabel) {
            problems.push('the channel wall graph group (role=group) has no accessible name')
          }
          if (!cw0.graph.inHeader) {
            problems.push('the channel wall graph selector is not inside its .section-header')
          }
          for (const button of cw0.graph.buttons) {
            if (!button.label) problems.push('a channel wall graph button has no accessible name')
            if (button.label !== button.title) {
              problems.push(
                'a channel wall graph button is named "' + button.label + '" but titled "' + button.title + '"'
              )
            }
            if (!button.svg) problems.push('a channel wall graph button has no <svg> icon')
            if (button.text) {
              problems.push('a channel wall graph button renders text: ' + JSON.stringify(button.text))
            }
          }
          const pressedCount = cw0.graph.buttons.filter((button) => button.pressed).length
          if (pressedCount !== 1) {
            problems.push(
              'the channel wall graph selector marks ' + pressedCount + ' options as pressed, expected exactly 1'
            )
          }
        }

        /**
         * 真实数据：把相机的声学会话打开。
         *
         * 通道墙自己**绝不**开这个会话（它是只读的展示面，而开设备 socket 是硬件操作，
         * 主进程里还有管理员守卫）；这里由探针调**产品自己那个按钮调的同一个 IPC**，
         * 因为本轮的问题“哪几种图形真的能从实时数据里画出来”在没有会话时无法回答。
         * 会话在测量结束后会被停掉，不留一条 socket 给值班的窗口。
         */
        let acousticStart = { ok: false, skipped: true }
        let acousticState = { ok: false }
        if (!camera.id) {
          log('camera acoustc : 未验证 — the harness has no camera device id')
        } else {
          acousticStart = await startCameraAcoustic(win, camera.id)
          log('camera acoustc : ' + JSON.stringify(acousticStart))
          if (acousticStart.ok) {
            const deadline = Date.now() + 20000
            acousticState = await readCameraAcoustic(win, camera.id)
            while (
              Date.now() < deadline &&
              (acousticFrames(acousticState, 'voiceprintData') <= 0 ||
                acousticFrames(acousticState, 'fftData') <= 0)
            ) {
              await sleep(1000)
              acousticState = await readCameraAcoustic(win, camera.id)
            }
            log('acoustic state : ' + JSON.stringify(acousticState))
          } else {
            log('camera acoustc : NOT started, so the graph types could only be checked for their honest "no data" wording')
          }
        }

        // --- 5) 每种图形：一格到底画了什么 ---------------------------------
        const GRAPH_ORDER = ['voiceprint', 'spl', 'spectrum', 'spectrogram']
        for (let index = 0; index < GRAPH_ORDER.length; index += 1) {
          const name = GRAPH_ORDER[index]
          const pressed = await clickChannelGraph(win, index)
          if (!pressed.clicked) {
            problems.push(
              'the channel wall graph selector has no option at index ' + index + ': ' +
              JSON.stringify(pressed.labels)
            )
            continue
          }
          let cw = pressed.channelWall
          if (!cw) {
            problems.push('the channel wall disappeared after pressing the ' + name + ' graph option')
            continue
          }
          log('graph ' + name + ' : pressed ' + JSON.stringify(pressed.label) + ' (index ' + index + ')')

          // 有真实帧时，格子必须在几秒内出现那种形态（掉帧/重建都需要一拍）。
          const framesOfKind =
            name === 'voiceprint'
              ? acousticFrames(acousticState, 'voiceprintData')
              : name === 'spectrum'
                ? acousticFrames(acousticState, 'fftData')
                : -1
          if (framesOfKind > 0) {
            const wantShape =
              name === 'voiceprint'
                ? (wallFacts) => wallFacts.tiles.some((tile) => tile.camera && tile.image && tile.image.decoded)
                : (wallFacts) => wallFacts.tiles.some((tile) => tile.camera && tile.linePoints > 1)
            const settled = await waitForChannelWall(win, wantShape, 8000)
            if (settled.wall) cw = settled.wall
            if (!settled.ok) {
              log(
                'graph ' + name + ' : the camera tile did not reach the drawn shape within ' +
                settled.attempts + ' probe(s); the tiles below are what it actually rendered'
              )
            }
          }

          const onePressed = cw.graph ? cw.graph.buttons.filter((button) => button.pressed) : []
          if (onePressed.length !== 1 || cw.graph.buttons.indexOf(onePressed[0]) !== index) {
            problems.push(
              'after pressing the ' + name + ' option, the pressed one is ' +
              JSON.stringify(onePressed.map((button) => button.label)) + ' (expected index ' + index + ')'
            )
          }
          if (cw.tiles.length === 0) {
            problems.push('the channel wall rendered no tile while the ' + name + ' graph was selected')
          }
          for (const tile of cw.tiles) {
            const shapes = [
              tile.image ? 'image' : '',
              tile.linePoints > 0 ? 'line' : '',
              tile.note ? 'note' : ''
            ].filter(Boolean)
            log(
              '  tile ' + name + ': ' + JSON.stringify({
                device: tile.device,
                camera: tile.camera,
                shapes: shapes,
                image: tile.image,
                linePoints: tile.linePoints,
                caption: tile.caption,
                note: tile.note
              })
            )
            // 一格只能是三种形态中的**一种**：画得出图就不再写说明，画不出就必须说
            // 出是哪一种原因；一格空白是这个墙唯一不能产生的形状。
            if (shapes.length !== 1) {
              problems.push(
                'a ' + name + ' tile rendered ' + shapes.length +
                ' of the three shapes (image/line/note): ' + JSON.stringify(tile)
              )
            }
          }

          // 相机格：声纹图与频谱图有真实载荷，声压线与时谱图在相机上**根本不存在**。
          const cameraTiles = cw.tiles.filter((tile) => tile.camera)
          if (cameraTiles.length === 0) {
            problems.push('no camera tile on the channel wall, so the ' + name + ' graph was not checked against a device')
          }
          for (const tile of cameraTiles) {
            if (name === 'spl' || name === 'spectrogram') {
              if (tile.image || tile.linePoints > 0) {
                problems.push(
                  'the camera tile drew a ' + name + ' graph although the camera pushes no such payload: ' +
                  JSON.stringify(tile)
                )
              }
              if (tile.note !== cwLabels.noSuchData) {
                problems.push(
                  'the camera tile for ' + name + ' says ' + JSON.stringify(tile.note) +
                  ', expected the locale\'s structural reason ' + JSON.stringify(cwLabels.noSuchData)
                )
              }
            }
            if (name === 'voiceprint') {
              if (framesOfKind > 0 && !(tile.image && tile.image.decoded)) {
                problems.push(
                  'the main process received ' + framesOfKind + ' voiceprint frame(s) but the tile shows no decoded JPEG: ' +
                  JSON.stringify(tile)
                )
              }
              if (framesOfKind <= 0 && !tile.note) {
                problems.push('the camera tile shows neither a voiceprint image nor a reason: ' + JSON.stringify(tile))
              }
            }
            if (name === 'spectrum') {
              if (framesOfKind > 0 && !(tile.linePoints > 1)) {
                problems.push(
                  'the main process received ' + framesOfKind + ' FFT frame(s) but the tile drew no polyline: ' +
                  JSON.stringify(tile)
                )
              }
              if (framesOfKind <= 0 && !tile.note) {
                problems.push('the camera tile shows neither a spectrum line nor a reason: ' + JSON.stringify(tile))
              }
            }
          }
        }

        // --- 6) 偏好持久化：真的刷新一次页面 -------------------------------
        // 先把图形停在**非默认**的那一档，否则“记不住”与“记住了默认值”看起来一样。
        const before = await probeUi(win)
        const graphBefore = before.channelWall && before.channelWall.graph
          ? before.channelWall.graph.buttons.findIndex((button) => button.pressed)
          : -1
        const layoutBefore = before.channelWallLayout
          ? before.channelWallLayout.buttons.findIndex((button) => button.pressed)
          : -1
        if (graphBefore !== 2) {
          const parked = await clickChannelGraph(win, 2)
          log('channel park   : ' + JSON.stringify({ clicked: parked.clicked, label: parked.label }))
        }
        // 档位停在**最大**的那一档（不是写死的 8）：这一档在裁剪后的集合里一定存在，
        // 而且它是最容易被误当成默认值的那一档（「记住了默认 4」需要一个非默认值来区分）。
        const parkCount = renderedLayoutCounts.length > 0
          ? renderedLayoutCounts[renderedLayoutCounts.length - 1]
          : 4
        const parkIndex = renderedLayoutCounts.indexOf(parkCount)
        const layoutParked = await clickChannelLayout(win, parkCount)
        log('channel park   : layout ' + parkCount + '-up pressed=' + layoutParked.clicked)
        // 刷新之前先把这一趟收到的推送读回来（刷新会把渲染层的订阅清掉）。
        await reportPushProbe(win, 'before the reload')
        const settledReload = await reloadAndSettle(win, 25000)
        log('channel reload : ' + JSON.stringify(settledReload))
        const afterReload = await waitForChannelWall(win, (wallFacts) => !!wallFacts.disclosure, 20000)
        // 刷新后通道表要重新读一次，档位集合会先短暂地是「全部档位」再收窄：先等它稳定。
        const layoutSettled = await waitForLayoutOptions(win, expectedLayouts, 20000)
        log('channel reload : layout options after the reload ' + JSON.stringify(layoutSettled.counts))
        const cwAfter = afterReload.wall
        if (!cwAfter) {
          problems.push('the channel wall did not come back after a reload')
        } else {
          const graphAfter = cwAfter.graph
            ? cwAfter.graph.buttons.findIndex((button) => button.pressed)
            : -1
          const layoutAfter = layoutSettled.layout
            ? layoutSettled.layout.buttons.findIndex((button) => button.pressed)
            : -1
          log(
            'channel persist: graph index ' + graphBefore + ' -> ' + graphAfter +
            ', layout index ' + layoutBefore + ' -> ' + layoutAfter +
            ' (parked ' + parkCount + '-up at index ' + parkIndex + ')' +
            ', collapsed=' + cwAfter.collapsed +
            ', aria-expanded=' + (cwAfter.disclosure ? cwAfter.disclosure.expanded : null)
          )
          // 图形停在索引 2（频谱图）：刷新后它必须还在，否则“记住偏好”没有实现。
          if (graphAfter !== 2) {
            problems.push(
              'the graph type was not remembered across a reload: pressed index ' + graphAfter + ', expected 2'
            )
          }
          if (layoutAfter !== parkIndex) {
            problems.push(
              'the ' + parkCount + '-up layout was not remembered across a reload: pressed index ' +
              layoutAfter + ', expected ' + parkIndex
            )
          }
          // 刷新后档位集合必须还是裁剪后的那一组（通道表重新读到之前不许永久变成全部档位）。
          if (layoutSettled.counts.join(',') !== expectedLayouts.join(',')) {
            problems.push(
              'after the reload the layout control offers ' + JSON.stringify(layoutSettled.counts) +
              ', expected the device-trimmed set ' + JSON.stringify(expectedLayouts)
            )
          }
          // 操作员展开过：刷新后默认行为（没有在线通道就收起）不许把它收回去。
          if (cwAfter.collapsed !== false || !cwAfter.disclosure || cwAfter.disclosure.expanded !== 'true') {
            problems.push(
              'the operator\'s expansion was forgotten across a reload: ' + JSON.stringify(cwAfter.disclosure)
            )
          }
        }

        // 收摊：把探针打开的相机会话关掉，别把一条 socket 留在值守的窗口后面。
        if (acousticStart.ok && camera.id) {
          const acousticStop = await stopCameraAcoustic(win, camera.id)
          log('camera acoustc : stopped ' + JSON.stringify(acousticStop))
          if (!acousticStop.ok) {
            problems.push('could not stop the camera acoustic session the probe started: ' + JSON.stringify(acousticStop))
          }
        }
      }
    }

    // `--observe-only` 不刷新页面，所以推送订阅还活着，可以在这里收尾读一次
    // （交互式那一次已经在刷新之前读过了，见 `reportPushProbe()`）。
    await reportPushProbe(win, OBSERVE_ONLY ? 'observe-only, end of run' : 'end of run')
  }

  log('findings      : ' + findings.length)
  for (const f of findings) log('  * ' + f)
  log('problems      : ' + problems.length)
  for (const p of problems) log('  ! ' + p)
  app.exit(problems.length ? 1 : 0)
}

app.whenReady().then(() =>
  run().catch((error) => {
    log('FATAL: harness threw: ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  })
)
