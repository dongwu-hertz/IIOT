'use strict'
/**
 * DEMO / VERIFICATION DRIVER — not part of the shipped app.
 *
 * Required by `scripts/demo-shot.cjs` through a generated two-line wrapper, so it
 * runs inside Electron's main process attached to the app before the app's own
 * entry creates its window. Configuration arrives in the `HZ_DEMO_SHOT`
 * environment variable as JSON.
 *
 * WHY THIS IS A REAL FILE (it used to be a template literal inside demo-shot.cjs)
 *
 * A generated program is one that nothing type-checks, nothing lints and no editor
 * understands, and this repository paid for that three times: a backtick in a
 * comment terminated the outer literal, an escape sequence collapsed into a real
 * newline on the way through, and a snippet assembled without newlines silently
 * needed explicit semicolons because automatic semicolon insertion never fires on a
 * single line. Every one of those reached the operator as Electron's generic
 * "Script failed to execute" — or as a harness that simply HUNG, because the
 * rejection escaped as an unhandled promise.
 *
 * The driver is a normal file now, so `node --check scripts/demo-shot-driver.cjs`
 * sees it, and the only generated text left is the two-line wrapper.
 *
 * Snippets injected into the RENDERER are still strings and still arrive on ONE
 * line, so every statement in them ends with an explicit `;`.
 */
const { app, BrowserWindow } = require('electron')
const electron = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const CONFIG = JSON.parse(process.env.HZ_DEMO_SHOT || '{}')
const OUT = CONFIG.out
const ONLY = CONFIG.route
const KEEP_OPEN = CONFIG.keepOpen
const ROUTES = CONFIG.routes || []

const problems = []
const log = (m) => { process.stdout.write('[demo] ' + m + '\n') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 探针**自己**杀掉渲染进程时置位（趋势页卡死之后的恢复，见 `forcefullyCrashRenderer()`）。
 *
 * 为什么是个模块级的开关：`render-process-gone` 的监听器在应用启动那一段注册，恢复动作在
 * `run()` 里执行 —— 两处不在同一个函数里。没有这个开关，问题清单里就会多出一条
 * `render-process-gone: {"reason":"crashed"}`，读起来像"应用崩了"，其实是我们在救人。
 */
let deliberateRendererCrash = false

/**
 * V8 调试器的三个动作（`Debugger.pause` / `resume`、`Profiler.start` / `stop`）。
 *
 * 挂在模块级是因为：注册在应用启动那一段（`main()`），而用它的是 `run()` 里的恢复块。
 * 没挂上时是 `null`，调用方要判空。
 */
let driverDebugger = null

/**
 * 假的听诊盒子（E2 / 2023 版）——**只在这台探针进程里**，用来把「拉」通道走完整条路。
 *
 * 为什么要有它（业主 2026-09-16 第①项：「端到端可用」）：
 * 客户端、落库、界面各自都有单测，但"从界面上把设备加进来 → 点同步 → 告警与录音真的落进
 * 本机库"这条**串起来**的路，只有把一台设备真的接上才走得通。真机不在手上，所以设备这一侧
 * 是假的，**协议这一侧是真的**：路径、token 头、口令摘要、字段名都按手册
 * （`docs/reference/` 的两份 E2 手册 + `src/shared/domain/e2.ts` 的常量）实现。
 *
 * 它**能证明**什么：应用真的发出了手册里的那些请求、口径对（MD5 摘要、Bearer token、
 * `file_path` 带 `saving_path`）、并把结果落进了本机库。
 * 它**不能证明**什么：与真机的互操作性 —— 一个按我们理解写的假设备无法证伪我们的理解。
 * 这一点写在 `docs/Ivms4200-UX-REFERENCE.md` §15.36 里，不许当成"真机验过了"。
 */
function makeWavBytes(sampleRate, seconds) {
  const channels = 1
  const bitsPerSample = 16
  const frames = Math.round(sampleRate * seconds)
  const dataBytes = frames * channels * (bitsPerSample / 8)
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28)
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}

/** 一张最小的合法 JPEG（1×1 像素），用来验"时频谱图/抓拍是二进制下载，不是 JSON"。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
)

/**
 * 启动假的听诊盒子。
 *
 * @param {{ password: string, sampleRate?: number }} options
 */
async function startMockE2Device(options) {
  const password = options.password
  const sampleRate = options.sampleRate ?? 48000
  /**
   * 这一台假设备扮演**哪一代**（业主 2026-09-17 第 8 批把 PTZ 与抓图接上之后需要两种）。
   *
   * `auscultation`（默认）= 2023 版听诊盒子：`/system` 里有 `work_mode`，告警带
   * `alarm_value`/`alarm_reasons`/`audio_name`，图是 10 张时频谱。
   * `airSonar` = SN-16 空气声呐：`/system` 里是**球机那一组** `cam_*`（没有 `work_mode`），
   * 告警带 `horizontal`/`vertical`，图是 **3 张球机抓图**（`1.jpg`…`3.jpg`）+ 固定 `alarm.wav`，
   * 而且 `PUT /system` 要真的把参数改掉（PTZ 那条链的读回核对才有东西可核）。
   */
  const variant = options.variant === 'airSonar' ? 'airSonar' : 'auscultation'

  /** 手册里那条告警（2023 版字段：`alarm_value` 位图 + `alarm_reasons` 文本 + `audio_name`）。 */
  const logEntry =
    variant === 'airSonar'
      ? {
          id: 54143,
          time: '2026-09-17_10-20-30',
          db_value: 70.59,
          tde_ratio: 39.17,
          fde_ratio: 0.97,
          horizontal: 45,
          vertical: 90,
          saving_path: '20260917_102030/',
          files_status: 1
        }
      : {
          id: 7,
          time: '2026-09-17_10-20-30',
          db_value: 41.5,
          main_frequency: 320.25,
          tde_ratio: 0.5,
          fde_ratio: 0.25,
          alarm_value: 3,
          alarm_reasons: '局部放电',
          saving_path: 'alarm/2026-09-17',
          audio_name: 'alarm.wav',
          files_status: 1
        }

  /**
   * 空气声呐的 `/system`（真机实测那一台的形状）。**可写**：`PUT /system` 就地改它 ——
   * PTZ 保存的读回核对必须有真的变化可读，否则那条断言只是在读回我们自己的请求。
   */
  const airSonarParams = {
    cam_enable: false,
    cam_ip: '192.168.2.64',
    cam_pass: 'AP1_lfxs_2025',
    cam_port: 80,
    cam_user: 'admin',
    cur_realtime_channel: 1,
    db_limit: 60,
    is_cam_init: false,
    is_ptz_direction_same_with_sonar: false,
    is_save_snapshot: true,
    notify_url: 'http://192.168.110.91:8080/api/v1/probe/telemetry',
    samplerate: 20000
  }

  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = {}
      try {
        body = raw === '' ? {} : JSON.parse(raw)
      } catch {
        body = { __raw: raw }
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const entry = {
        method: request.method ?? '',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        auth: request.headers.authorization ?? '',
        body
      }
      requests.push(entry)

      const json = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (url.pathname === '/login') {
        // 两份手册的口令摘要不一致：**只认加盐那一种**（`md5(password + 'lfxs')`），
        // 不加盐的摘要回 401 —— 这样"先加盐、401 再换"那条路径在探针里是**真的**走了一遍。
        const salted = crypto.createHash('md5').update(password + 'lfxs').digest('hex')
        const plain = crypto.createHash('md5').update(password).digest('hex')
        entry.digestStyle = body.password === salted ? 'salted' : body.password === plain ? 'plain' : 'unknown'
        if (body.username === 'admin' && entry.digestStyle === 'salted') {
          json(200, { token: 'probe-token' })
          return
        }
        json(401, { ret: -1, msg: 'auth failed' })
        return
      }

      // 除登录之外一律要 Bearer token（与客户端一致）。
      if (entry.auth !== 'Bearer probe-token') {
        json(401, { ret: -1 })
        return
      }

      if (url.pathname === '/workmode') {
        /*
         * 空气声呐**没有**工作模式这个概念（手册里连 `work_mode` 字段都没有）。
         * 它照旧 404：客户端在变体已判成 airSonar 时**根本不会问这个端点**，
         * 所以这里 404 正是"我们有没有乱问"的证据（探针会检查请求列表里没有它）。
         */
        if (variant === 'airSonar') {
          json(404, { ret: -1 })
          return
        }
        json(200, {
          work_mode: 'rotating_equipment',
          samplerate: sampleRate,
          stft_pic_height: 256,
          stft_pic_width: 512
        })
        return
      }
      if (url.pathname === '/system') {
        if (request.method === 'PUT') {
          entry.written = body
          // 空气声呐：**真的改**（PTZ 的读回核对要读到变化）。
          if (variant === 'airSonar' && body && typeof body === 'object') {
            Object.assign(airSonarParams, body)
          }
          json(200, { ret: 0 })
          return
        }
        if (variant === 'airSonar') {
          // 球机那一组键在 `/system` 里出现 ⇒ 变体判定为 airSonar（见 detectE2Variant）。
          json(200, airSonarParams)
          return
        }
        // `work_mode` 在 `/system` 里出现过 ⇒ 变体判定为 2023 版听诊盒子（见 detectE2Variant）。
        json(200, {
          work_mode: 'rotating_equipment',
          samplerate: sampleRate,
          threshold_db: 40,
          alarm_interval: 30
        })
        return
      }
      if (url.pathname === '/basic' || url.pathname === '/get_device_basic_params') {
        // 两代的设备信息端点不同；真机上只有自己那一个（这里按变体只答一个）。
        const served = url.pathname === '/basic' ? 'auscultation' : 'airSonar'
        if (served !== variant) {
          json(404, { ret: -1 })
          return
        }
        json(
          200,
          variant === 'airSonar'
            ? {
                dev_name: '探针声呐',
                dev_type: 'AS16-auth-vertical-reverse',
                dev_version: 'V3.4.0.2024-11-27',
                upgrade_time: '2024-11-27_10:00:00',
                web_version: 'WEBV2.3.0',
                equip_number: 'PROBE-SN16-0001'
              }
            : {
                dev_name: '探针听诊盒子',
                dev_type: 'E2',
                dev_version: 'V1.2.3',
                upgrade_time: '2026-01-01 00:00:00',
                web_version: 'web-1.0',
                equip_number: 'PROBE-E2-0001'
              }
        )
        return
      }
      if (url.pathname === '/alarm_log_all' || url.pathname === '/alarm_log' ||
          url.pathname === '/get_all_alarms' || url.pathname === '/get_alarm_logs_conditional') {
        json(200, { logs_count: 1, logs: [logEntry] })
        return
      }
      if (url.pathname === '/alarm_files' || url.pathname === '/saving_alarm_file') {
        const filePath = url.searchParams.get('file_path') ?? ''
        entry.filePath = filePath
        if (filePath.endsWith('alarm.wav')) {
          response.writeHead(200, { 'content-type': 'audio/wav' })
          response.end(makeWavBytes(sampleRate, 2))
          return
        }
        if (/\.jpg$/i.test(filePath)) {
          response.writeHead(200, { 'content-type': 'image/jpeg' })
          response.end(TINY_JPEG)
          return
        }
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
        return
      }
      /*
       * 空气声呐真机（V3.4.0）的文件走**静态路径** `/static_file/<saving_path><name>`，
       * 而手册写的是 API 形态。客户端两条都会试（只有 404 才换），所以这里把它实现出来：
       * 于是"抓图真的被下载下来了"这件事在假设备上也能验。
       */
      if (url.pathname.startsWith('/static_file/')) {
        entry.filePath = url.pathname
        if (url.pathname.endsWith('alarm.wav')) {
          response.writeHead(200, { 'content-type': 'audio/wav' })
          response.end(makeWavBytes(sampleRate, 2))
          return
        }
        if (/\.jpg$/i.test(url.pathname)) {
          response.writeHead(200, { 'content-type': 'image/jpeg' })
          response.end(TINY_JPEG)
          return
        }
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
        return
      }
      if (url.pathname === '/time_sync_with_nvt') {
        entry.timedSync = true
        json(200, { ret: 0 })
        return
      }
      json(404, { ret: -1 })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    requests,
    variant,
    /** 空气声呐模式下的 `/system`（`PUT /system` 会改它）—— 探针用它验"真的写进设备了"。 */
    params: airSonarParams,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/**
 * 产品这一轮点名的四档窗口尺寸。
 *
 * 顺序刻意从小到大：断言读的是「这一列随窗口变宽」这条顺序关系。四档都是**内容区**
 * 尺寸（`setContentSize`），所以渲染层报回来的 `innerWidth/innerHeight` 必须与请求的
 * 数字逐像素相同 —— 不同就说明操作系统把窗口夹小了，那时必须说出来，而不是拿另一档
 * 的数字当成这一档的结论。
 */
const TREE_SIZES = [
  [1280, 720],
  [1366, 768],
  [1920, 1080],
  [2560, 1440]
]

/** 左/上间距与四档之间允许的浮动（px）：亚像素布局 + 取整，2px 是噪声不是偏移。 */
const GAP_TOLERANCE_PX = 2

/**
 * 在渲染层里跑一段**异步**脚本并把结果解析成对象。
 *
 * 与 `run()` 里那个 `layout()` 的分工：`layout()` 会先切路由再跑（它测的是某一页的
 * 结构），这里的片段与路由无关（它们问的是主进程/设备），所以不切页。
 */
/**
 * 跑一段页面脚本并把结果解析成对象，**带超时**。
 *
 * 为什么需要超时（2026-09-18 实测）：`executeJavaScript` 等的是那段脚本自己 resolve。
 * 渲染进程被拖住（机器忙、设备轮询堆在事件循环里）时这个 Promise 可以**几个小时不 settle**
 * —— 那一次探针跑了 4.5 小时才回来，而报告里只有一句"某一步超时"。
 * 探针的每一次往返都必须有自己的时间上限，否则一次自动化验证会把一整个下午吃掉。
 */
async function execJson(win, label, source, timeoutMs = 30_000) {
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(source),
      sleep(timeoutMs).then(() => null)
    ])
    if (raw === null) {
      log(label + ' TIMEOUT after ' + timeoutMs + 'ms')
      problems.push(label + ' 超时（' + timeoutMs + 'ms 没有返回）—— 渲染进程可能被拖住了')
      return { ok: false, probeTimeout: true }
    }
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    log(label + ' threw: ' + (error && error.message))
    problems.push(label + ' threw: ' + (error && error.message))
    return { ok: false, threw: String(error && error.message) }
  }
}

// ---------------------------------------------------------------------------
// 重命名演练（默认关闭，`--rename-drill` 打开）
//
// 为什么需要它，而且为什么由 `demo-shot` 做：声纹设备与它的通道**只存在于操作员的真实
// profile 里**，`video-proof.cjs` 那一次跑在临时 profile 中（它只会自己加上那台相机）。
// 所以「改设备名 / 改通道名，再改回来」这件事只有真实 profile 里的进程能做。
//
// 为什么默认关闭：它写的是**真机**（一台正在被值班使用的声纹设备）。默认的
// `node scripts/demo-shot.cjs` 因此一个字节都不写设备；要演练必须显式给一个开关。
// ---------------------------------------------------------------------------
const RENAME_DRILL = CONFIG.renameDrill === true

/** 设备列表（按 kind 挑，绝不按名字或地址猜）。 */
function listDevicesScript() {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.list();' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  return JSON.stringify({ ok: true, devices: (r.data || []).map((d) => ({' +
    '    id: d.id, kind: d.kind, name: d.name, ip: d.ip, status: d.status })) });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 设备身份（`get_devinfo`）—— 设备侧的名字就在这里，它才是「设备真的改名了吗」的答案。 */
function deviceInfoScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.devices.getInfo(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, name: r.data.name, channelCount: r.data.channelCount });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 设备侧的通道表（`GET /get_passageway`）：改通道名之后的权威读数。 */
function deviceChannelsScript(deviceId) {
  return (
    '(async () => { try {' +
    '  const r = await window.api.config.getChannels(' + JSON.stringify(deviceId) + ');' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  return JSON.stringify({ ok: true, channels: (r.data || []).map((c) => ({' +
    '    channelIndex: c.channelIndex, name: c.name, enabled: c.enabled })) });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/** 一次设备重命名（本地 + 设备），与设备管理页里那条 `renameDeviceName()` 逐句相同。 */
function renameDeviceScript(deviceId, name) {
  return (
    '(async () => { try {' +
    '  const updated = await window.api.devices.update({ id: ' + JSON.stringify(deviceId) +
    ', name: ' + JSON.stringify(name) + ' });' +
    '  if (!updated.success) return JSON.stringify({ ok: false, step: "local", code: updated.error.code });' +
    '  const written = await window.api.config.setDeviceName(' + JSON.stringify(deviceId) + ', ' +
    JSON.stringify(name) + ');' +
    '  if (!written.success) return JSON.stringify({ ok: false, step: "device", code: written.error.code,' +
    '    message: written.error.message || "" });' +
    '  return JSON.stringify({ ok: true, localName: updated.data.name });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()'
  )
}

/**
 * 这个探针写一次名字、读回、再改回原值并读回。
 *
 * 「写入读回」这一步是**必须**的：一次 `ret:200` 不构成证据（设备完全可能接受请求而忽略
 * 字段），所以设备侧的名字一律用 `get_devinfo` 重读；通道名用 `updateChannel` 返回的
 * 设备重读结果。恢复之后同样再读一次，证明这台真机回到了原样。
 */
async function runRenameDrill(win) {
  const list = await execJson(win, 'renameList', listDevicesScript())
  const devices = list.ok ? list.devices || [] : []
  const box = devices.filter((device) => device.kind === 'acousticBox')[0] || null
  log('rename drill  : devices = ' + JSON.stringify(devices.map((d) => (d.kind + ':' + d.name))))
  if (!box) {
    log('rename drill  : 未验证 — 真实 profile 里没有声纹设备，设备名/通道名无法演练')
    return
  }

  const beforeInfo = await execJson(win, 'renameInfoBefore', deviceInfoScript(box.id))
  const beforeChannels = await execJson(win, 'renameChannelsBefore', deviceChannelsScript(box.id))
  log('rename before : device=' + JSON.stringify(beforeInfo) + ' channels=' + JSON.stringify(beforeChannels))
  const originalName = beforeInfo.ok ? beforeInfo.name : ''

  if (!originalName) {
    log('rename drill  : 未验证 — 设备的 get_devinfo 没有给出名字，无法验证设备侧重命名')
  } else {
    const next = 'HZ 验证设备名 ' + Date.now().toString().slice(-6)
    const write = await execJson(win, 'renameWrite', renameDeviceScript(box.id, next))
    const afterInfo = await execJson(win, 'renameInfoAfter', deviceInfoScript(box.id))
    log('rename write  : ' + JSON.stringify(write) + ' -> device reads back ' + JSON.stringify(afterInfo))
    if (!write.ok) {
      problems.push('声纹设备重命名失败：' + JSON.stringify(write))
    } else if (!afterInfo.ok || afterInfo.name !== next) {
      // 设备接受请求却没改名：这是**必须**报出来的事实，而不是「成功了」。
      problems.push('设备侧重命名没有生效：写入要求 ' + JSON.stringify(next) +
        '，重读 get_devinfo 得到 ' + JSON.stringify(afterInfo))
    }
    const restore = await execJson(win, 'renameRestore', renameDeviceScript(box.id, originalName))
    const restoredInfo = await execJson(win, 'renameInfoRestored', deviceInfoScript(box.id))
    log('rename restore: ' + JSON.stringify(restore) + ' -> device reads back ' + JSON.stringify(restoredInfo))
    if (!restore.ok) problems.push('设备名恢复失败：' + JSON.stringify(restore))
    if (!restoredInfo.ok || restoredInfo.name !== originalName) {
      problems.push('设备名恢复后读回不是原值：期望 ' + JSON.stringify(originalName) +
        '，得到 ' + JSON.stringify(restoredInfo))
    }
  }

  // 通道：挑一路**启用**的（真机上 2~7 路未启用）。改一个正在用的通道，比改一个停用的
  // 通道更能证明写入链路真的通了。
  const channels = beforeChannels.ok ? beforeChannels.channels || [] : []
  const enabled = channels.filter((channel) => channel.enabled === true)
  const target = enabled[0] || channels[0] || null
  log('rename channel: target=' + JSON.stringify(target) + ' (enabled ' + enabled.length +
    ' of ' + channels.length + ')')
  if (!target) {
    log('rename drill  : 未验证 — 设备没有上报任何通道，通道名无法演练')
    return
  }
  const originalChannel = target.name || ''
  const nextChannel = 'HZ 验证通道 ' + Date.now().toString().slice(-6)
  const writeChannel = await execJson(win, 'renameChannelWrite',
    '(async () => { try {' +
    '  const r = await window.api.config.updateChannel(' + JSON.stringify(box.id) + ', ' +
    JSON.stringify(target.channelIndex) + ', { name: ' + JSON.stringify(nextChannel) + ' });' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code, message: r.error.message || "" });' +
    '  const one = (r.data || []).filter((c) => c.channelIndex === ' + JSON.stringify(target.channelIndex) +
    ')[0] || null;' +
    '  return JSON.stringify({ ok: true, readBack: one });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()')
  log('rename channel: write ' + JSON.stringify(writeChannel))
  if (!writeChannel.ok) {
    problems.push('通道重命名失败：' + JSON.stringify(writeChannel))
  } else if (!writeChannel.readBack || writeChannel.readBack.name !== nextChannel) {
    problems.push('通道重命名没有生效（主进程写完重读设备的值不是新值）：' + JSON.stringify(writeChannel))
  }
  const restoreChannel = await execJson(win, 'renameChannelRestore',
    '(async () => { try {' +
    '  const r = await window.api.config.updateChannel(' + JSON.stringify(box.id) + ', ' +
    JSON.stringify(target.channelIndex) + ', { name: ' + JSON.stringify(originalChannel) + ' });' +
    '  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });' +
    '  const one = (r.data || []).filter((c) => c.channelIndex === ' + JSON.stringify(target.channelIndex) +
    ')[0] || null;' +
    '  return JSON.stringify({ ok: true, readBack: one });' +
    '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()')
  log('rename channel: restore ' + JSON.stringify(restoreChannel))
  if (!restoreChannel.ok || !restoreChannel.readBack || restoreChannel.readBack.name !== originalChannel) {
    problems.push('通道名恢复后读回不是原值：期望 ' + JSON.stringify(originalChannel) +
      '，得到 ' + JSON.stringify(restoreChannel))
  }
}

/**
 * 把主进程的 `shell.openExternal` 换成一支**记录用的替身**。
 *
 * 为什么需要它：页脚里的公司网站链接这一轮必须证明「还在，而且还能用」。「按钮在
 * DOM 里」只能证明前半句；后半句要一次真正的点击 —— 渲染层 `app:open-external` IPC
 * → 主进程校验协议 → `shell.openExternal`。探针把这个终点记下来（返回值照原样给一个
 * 已完成的 Promise），于是：
 *   - 点击路径被端到端走通一次，中间任何一环断了都记不到 URL；
 *   - 探针不会真的弹出系统浏览器打开公司网站（这是一次自动化验证，不是演示）。
 *
 * 必须在应用自己的入口之前装好：这个驱动是被 wrapper 先 `require` 的（见
 * `scripts/demo-shot.cjs`），所以替身在主进程模块图建立之前就位。
 */
const openExternalCalls = []
let openExternalStubInstalled = false
try {
  electron.shell.openExternal = (url) => {
    openExternalCalls.push(String(url))
    return Promise.resolve()
  }
  openExternalStubInstalled = typeof electron.shell.openExternal === 'function'
} catch (error) {
  log('openExternal stub could not be installed: ' + (error && error.message))
}

// The app creates its own window; attach listeners as it is created so no
// early console error or preload failure is missed.
app.on('browser-window-created', (_event, win) => {
  /**
   * **关掉后台定时器节流** —— 这一行解释了前几轮那些"探针挂住几个小时"的谜。
   *
   * 实测（2026-09-18）：机器被别的窗口占着时，探针的窗口是**被遮挡/后台**的，Chromium 于是把
   * `setTimeout` 节流（先是 1 秒一次，隐藏 5 分钟后变成 1 分钟一次）。探针的每一步都是
   * `await sleep(...)`，于是"4 秒的等待"变成几分钟，一次运行从 6 分钟涨到 4.5 小时，
   * 报告里全是"超时"——而**渲染进程本身是好的**（`executeJavaScript` 照样立刻回话，
   * 所以超时之后还能读到"卡在哪一步"）。
   *
   * 这解释了三件事：为什么超时总卡在某个 `sleep` 之前、为什么同一段代码昨天是绿的、
   * 为什么"假失败"会成片出现（每个 `waitForRow` 循环都被拖成几十秒）。
   */
  try {
    win.webContents.setBackgroundThrottling(false)
  } catch {
    // 老版本没有这个方法：那时只能靠 window.focus()，不影响后面的断言。
  }
  /**
   * 页面自己的**步骤痕迹**：页面里 `console.log('[trend-probe] ...')` 的内容抄进 driver 日志。
   *
   * 为什么需要（第 32 轮）：趋势页点「自定义」范围会把渲染进程的 JS 线程卡死，那一支探针
   * **永远不返回** —— 于是 `out.timings` 与 `document.body.dataset.probeStep`（两个都在页面里）
   * 一个都读不到，只能知道"这一支超时了"，不知道停在哪一步。
   * console 消息不一样：它在**产生的那一刻**就送到主进程（主进程当时是活的），
   * 所以卡死之前走过的每一步都留在日志里。
   */
  const logProbeTrace = (message) => {
    const text = typeof message === 'string' ? message : String(message ?? '')
    if (text.startsWith('[trend-probe]')) log('probe trace : ' + text)
  }
  win.webContents.on('console-message', (...a) => {
    /*
     * 两种签名都要认，而且**两边的 level 都可能是字符串或数字**。
     *
     * 这一处踩过（2026-09-18）：Electron ≥33 传一个 details 对象，但那一版里 `level`
     * 可能是数字（0–3）。第一版只比较 `'error'` / `'warning'` 字符串，于是**渲染层的错误
     * 一条都没被报出来** —— 探针看起来"没有 console 错误"，其实它一只眼是瞎的。
     * 老签名是 `(event, level:number, message, line, source)`。
     */
    const isBad = (level) => {
      const text = String(level)
      // 老签名：2 = warning，3 = error；新签名：字符串。
      return text === 'warning' || text === 'error' || text === '2' || text === '3'
    }
    const d = a[0]
    if (d && typeof d === 'object' && 'level' in d) {
      logProbeTrace(d.message)
      if (isBad(d.level)) {
        problems.push('console[' + String(d.level) + '] ' + d.message + ' (' + d.sourceId + ':' + d.lineNumber + ')')
      }
      return
    }
    logProbeTrace(a[1])
    if (isBad(a[0])) problems.push('console[' + String(a[0]) + '] ' + a[1] + ' (' + a[3] + ':' + a[2] + ')')
  })
  win.webContents.on('preload-error', (_e, p, err) => problems.push('preload-error ' + p + ': ' + err.message))
  win.webContents.on('render-process-gone', (_e, details) => {
    /*
     * 我们自己**故意**杀掉渲染进程时（趋势页卡死之后的恢复，见下面 `forcefullyCrashRenderer()`），
     * 这条事件照样会来 —— 那是探针的动作，不是缺陷。不加这个开关的话，问题清单里会出现一条
     * `render-process-gone: {"reason":"crashed"}`，读起来像"应用崩了"，而实际上是我们在救人。
     */
    if (deliberateRendererCrash) {
      log('render-process-gone: 探针自己杀的渲染进程（恢复用）→ ' + JSON.stringify(details))
      return
    }
    problems.push('render-process-gone: ' + JSON.stringify(details))
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push('did-fail-load ' + code + ' ' + desc + ' ' + url))
  /*
   * ── 第 33 轮：把 V8 调试器挂上，用来在**卡住的时候**取一次 JS 调用栈 ──
   *
   * 为什么这一招能行、而 `executeJavaScript` 不行：`executeJavaScript` 要等渲染进程的
   * **任务队列**，而卡死时那条链不让出宏任务（心跳都停了）—— 所以它永远不 settle。
   * `Debugger.pause` 走的是 V8 的**中断**（DevTools 那颗暂停按钮就是它），
   * 它可以在脚本**正在跑**的时候把栈取出来，然后我们 `resume` 放它继续跑。
   * 拿到的那几帧（函数名 + 行号）就是这条环的答案。
   *
   * 只在探针里用，不进产品：它需要 `--remote-debugging` 那种级别的能力（CDP）。
   */
  try {
    win.webContents.debugger.attach('1.3')
    /*
     * `scriptId → url`：`Debugger.paused` 的帧里 `frame.url` **经常是空的**（第 33 轮就是，
     * 于是只知道"是哪个渲染函数"、不知道"是哪个 chunk/组件"）。把 `Debugger.scriptParsed`
     * 收下来就能把行号对回具体文件。
     */
    const scriptUrls = new Map()
    const shortUrl = (url) => {
      const text = String(url || '')
      if (!text) return '(inline)'
      return text.split('/').pop().split('?')[0]
    }
    const frameWhere = (frame) => {
      const url = frame.url || scriptUrls.get(frame.location && frame.location.scriptId) || ''
      return shortUrl(url) + ':' + frame.location.lineNumber
    }
    win.webContents.debugger.on('message', (_event, method, params) => {
      if (method === 'Debugger.scriptParsed') {
        if (params && params.scriptId !== undefined) scriptUrls.set(params.scriptId, params.url)
        return
      }
      if (method !== 'Debugger.paused') return
      const frames = Array.isArray(params && params.callFrames) ? params.callFrames : []
      log(
        'DEBUGGER paused: ' +
          JSON.stringify(
            frames.slice(0, 22).map((frame) => ({
              fn: frame.functionName || '(anonymous)',
              where: frameWhere(frame)
            }))
          )
      )
      // 取完就放它继续跑（我们要的是"卡在哪"，不是把它停住）。
      win.webContents.debugger.sendCommand('Debugger.resume').catch(() => {})
    })
    win.webContents.debugger.sendCommand('Debugger.enable').catch(() => {})
    win.webContents.debugger.sendCommand('Profiler.enable').catch(() => {})

    /**
     * 采一份 CPU profile，把**自耗时最高**的函数（以及它的调用链）打出来。
     *
     * 为什么需要它：调用栈只告诉我们"卡住时在渲染/patch 里"，**看不出是谁在 flush 期间写状态**
     * （那才是环的驱动端）。CPU profile 的自耗时排行会把"转得最多"的那几个函数直接列出来，
     * 配合 `scriptId → url` 就能对上文件与行号。
     */
    const profileTop = (profile) => {
      const nodes = new Map()
      for (const node of profile.nodes || []) nodes.set(node.id, node)
      const parent = new Map()
      for (const node of profile.nodes || []) {
        for (const child of node.children || []) parent.set(child, node.id)
      }
      const self = new Map()
      const samples = profile.samples || []
      const deltas = profile.timeDeltas || []
      for (let i = 0; i < samples.length; i += 1) {
        const delta = typeof deltas[i] === 'number' && deltas[i] > 0 ? deltas[i] : 1000
        self.set(samples[i], (self.get(samples[i]) || 0) + delta)
      }
      const ranked = [...self.entries()]
        .map(([id, micros]) => ({ node: nodes.get(id), micros }))
        .filter((entry) => entry.node)
        .sort((left, right) => right.micros - left.micros)
        .slice(0, 10)
      return ranked.map((entry) => {
        const chain = []
        let cursor = entry.node.id
        for (let depth = 0; depth < 6 && cursor !== undefined; depth += 1) {
          const node = nodes.get(cursor)
          if (!node) break
          chain.push(
            (node.callFrame.functionName || '(anonymous)') + '@' + frameWhere(node.callFrame)
          )
          cursor = parent.get(cursor)
        }
        return {
          selfMs: Math.round(entry.micros / 1000),
          totalMs: Math.round(
            (profile.samples || []).filter((id) => id === entry.node.id).length *
              ((profile.endTime - profile.startTime) / Math.max(1, (profile.samples || []).length))
          ),
          chain
        }
      })
    }
    driverDebugger = {
      pause: () => win.webContents.debugger.sendCommand('Debugger.pause'),
      resume: () => win.webContents.debugger.sendCommand('Debugger.resume'),
      startProfile: () => win.webContents.debugger.sendCommand('Profiler.start'),
      stopProfile: async () => {
        const result = await win.webContents.debugger.sendCommand('Profiler.stop')
        return result && result.profile ? profileTop(result.profile) : []
      }
    }
  } catch (error) {
    log('DEBUGGER attach failed: ' + error.message)
  }
})

async function shoot(win, name) {
  const image = await win.webContents.capturePage()
  const file = path.join(OUT, name + '.png')
  fs.writeFileSync(file, image.toPNG())
  const size = image.getSize()

  // A "successful" capture of a blank window is still a broken UI, and the
  // harness cannot rely on a human looking at the PNG. So measure the bitmap:
  // a real screen has many distinct colours; an empty/white one has almost none.
  const bmp = image.toBitmap()
  const seen = new Set()
  let nonWhite = 0
  let sampled = 0
  for (let i = 0; i + 3 < bmp.length; i += 4 * 97) { // stride-sample
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]
    seen.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3))
    if (r < 245 || g < 245 || b < 245) nonWhite += 1
    sampled += 1
  }
  const text = await win.webContents.executeJavaScript(
    '(document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180)'
  )
  const nodes = await win.webContents.executeJavaScript('document.querySelectorAll("*").length')

  log('captured ' + name + '.png  ' + size.width + 'x' + size.height + '  ' + fs.statSync(file).size + ' B')
  log('  distinct colours ~' + seen.size + ' | non-white ' + Math.round(100 * nonWhite / sampled) + '% | DOM nodes ' + nodes)
  log('  text: ' + JSON.stringify(text))

  if (seen.size < 12) problems.push(name + ': only ' + seen.size + ' distinct colours — looks blank')
  if (nodes < 20) problems.push(name + ': only ' + nodes + ' DOM nodes')
  return size
}

/**
 * IoT 数据接入（业主 2026-09-19 第 1 条：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接
 * IOT 设备的逻辑，你去调研，然后开发」）。
 *
 * WHY THIS DRILL
 * 单测里验过的东西（真 HTTP / 真 MQTT 往返、真落库）证明的是**服务本身**；而"界面上那个开关
 * 真的能把它打开、秘钥真的显示出来了、收数计数真的会动"只有在一个跑起来的应用里才成立。
 * 三段，**最后一段是写探针**（所以整段排在所有只读探针之后）：
 *   1. 只读：设置页第八个页签「数据接入」在不在、默认是不是**关闭**、端口与路径/主题对不对；
 *   2. 只读（首次读会生成一条秘钥）：设备对话框里有秘钥与逐网卡的推流地址，形状是
 *      `/api/v1/<32 位十六进制>/telemetry`；
 *   3. 写：把两个端口改到高位端口、打开总开关，然后从 **driver 进程**用真的 HTTP 请求与真的
 *      MQTT 字节各推一条 —— 读数真的变了（401 / 404 / 400 也逐条验）—— 最后把开关关掉、
 *      端口与存储根还原。
 *
 * 两条"不碰操作员数据"的措施（`--with-data` 用的是操作员真库的副本，而存储根指向他的真实
 * 目录）：第一条推送用的是**不认识的键**（不落任何文件）；推"认得出"的那条之前先把存储根
 * 换成这一次性 profile 里的目录（与 E2 那条探针同一做法）。
 */
async function runIotIngestDrill(win, layout) {
  const net = require('node:net')
  const httpPort = 20000 + crypto.randomInt(0, 8000)
  const mqttPort = 30000 + crypto.randomInt(0, 8000)
  const probeStorageRoot = path.join(app.getPath('userData'), 'probe-storage')
  const telemetryPath = (secret) => '/api/v1/' + secret + '/telemetry'

  // ---- 1) 设置页：页签 + 界面与设置一致（只读） ---------------------------------
  /*
   * **这里不再断言"出厂默认关着"** —— 那一句话在这一段里是**量不到**的，而它一直是靠
   * "操作员恰好没动过这个开关"装绿的：探针跑的是**操作员真实 profile 的副本**，里面那个
   * 值是**设置值**，不是出厂默认。2026-09-19 实测撞上了：操作员在自己的应用里把「数据接入」
   * 打开了（`enabled: true` + 端口 8080/1883），于是这条断言红着报了一个**并不存在**的产品缺陷
   * （真库里的设备表与账号都没被探针动过 —— 探针写的是临时 profile）。
   *
   * 出厂默认（总开关关闭、0.0.0.0、8080、1883、两个通道打开）由**单测**钉住
   * （`tests/iot-ingest.test.ts` 里的 `defaultIotIngestConfig()`），那里没有操作员数据参与。
   * 这一段改做的事情是**界面保真**：界面上那几个控件必须逐项等于 `settings.get()` 里的值 ——
   * 这才是"这一页有没有如实显示设置"的证据。
   */
  /*
   * ── 1) 数据接入**在添加设备里**（业主 2026-09-19 第 13 批第 1 条） ──
   *
   * 这一段在 2026-09-19 第 26/27 轮之前量的是**系统设置 → 数据接入**那一个页签。
   * 业主第 13 批第 1 条把那一整页搬进「设备管理 → 添加设备」，所以现在量两件事：
   *   a. 设置页里**没有**那个页签了（反向断言：整块搬走，不是复制一份）；
   *   b. 添加设备对话框里那一块「本机接入」在，而且显示的绑定地址与两个端口**逐项等于**
   *      `settings.get()` 里存着的那一份（"这一块有没有如实显示设置"的唯一证据）。
   */
  const view = await layout('/settings', '(async () => {' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const settings = await window.api.settings.get();' +
    'return JSON.stringify({' +
    '  tabPresent: !!document.querySelector(".settings-tabs [data-tab=iot]"),' +
    '  tabLabelPresent: /数据接入/.test(text(document.querySelector(".settings-tabs"))),' +
    '  sectionPresent: !!document.querySelector("[data-iot-section]"),' +
    '  persisted: settings && settings.success ? settings.data.iotIngest : null' +
    '});' +
    '})()', 60_000)
  log('iot settings  : ' + JSON.stringify(view))

  if (view.tabPresent) {
    problems.push('设置页里还有「数据接入」页签（第 13 批第 1 条要求整块搬进添加设备）')
  }
  if (view.sectionPresent) {
    problems.push('设置页里还有数据接入那一块内容（[data-iot-section]）')
  }

  /* b. 添加设备对话框里的「本机接入」 */
  const local = await layout('/devices', '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const openButton = [...document.querySelectorAll("button")]' +
    '  .find((b) => text(b) === "添加设备" || /^Add device/.test(text(b)));' +
    'if (!openButton) return JSON.stringify({ ok: false, reason: "no-add-button" });' +
    'openButton.click();' +
    'for (let i = 0; i < 20 && !document.querySelector("[data-add-device-dialog]"); i += 1) await wait(200);' +
    'const dialog = document.querySelector("[data-add-device-dialog]");' +
    'if (!dialog) return JSON.stringify({ ok: false, reason: "no-dialog" });' +
    'const local = dialog.querySelector("[data-add-iot-local]");' +
    'if (!local) return JSON.stringify({ ok: false, reason: "no-local-block" });' +
    // 折叠着也要能量：把 details 打开（这一块默认收起）。
    'local.open = true;' +
    'await wait(200);' +
    'const value = (sel) => { const node = local.querySelector(sel); return node ? String(node.value) : null; };' +
    'const settings = await window.api.settings.get();' +
    'const persisted = settings && settings.success ? settings.data.iotIngest : null;' +
    'const out = {' +
    '  ok: true,' +
    '  bind: value("[data-add-iot-bind]"),' +
    '  httpPort: value("[data-add-iot-http-port]"),' +
    '  mqttPort: value("[data-add-iot-mqtt-port]"),' +
    '  hasSave: !!local.querySelector("[data-add-iot-save]"),' +
    '  hasStats: !!local.querySelector("[data-add-iot-stats]"),' +
    '  httpStatus: text(local.querySelector("[data-add-iot-http-status]")),' +
    '  mqttStatus: text(local.querySelector("[data-add-iot-mqtt-status]")),' +
    '  derived: text(local.querySelector("[data-iot-derived-flags]")),' +
    '  persisted: persisted ? { bindAddress: persisted.bindAddress, httpPort: persisted.httpPort, mqttPort: persisted.mqttPort } : null,' +
    '  rawKeyLeak: /iotUi\\.|addDeviceUi\\./.test(text(dialog))' +
    '};' +
    // 关窗（这一条是只读的：不改任何值）。
    'const close = dialog.querySelector(".panel__header button");' +
    'if (close) close.click();' +
    'return JSON.stringify(out);' +
    '})()', 60_000)
  log('iot local block: ' + JSON.stringify(local))

  if (local.ok !== true) {
    problems.push('添加设备对话框里没有「本机接入」那一块：' + JSON.stringify(local.reason))
  } else {
    if (!local.hasSave) problems.push('「本机接入」里没有保存按钮（[data-add-iot-save]）')
    if (!local.hasStats) problems.push('「本机接入」里没有收数统计（[data-add-iot-stats]）')
    if (!local.httpStatus || !local.mqttStatus) problems.push('「本机接入」里没有两个监听状态')
    if (!local.derived) problems.push('「本机接入」里没有那句"由设备声明派生"的说明')
    if (local.rawKeyLeak) problems.push('「本机接入」里渲染出了裸 key')
    const persisted = local.persisted
    if (!persisted) {
      problems.push('读不到持久化的数据接入设置（settings.get()）')
    } else {
      if (local.bind !== persisted.bindAddress) {
        problems.push('「本机接入」显示的绑定地址与存的不一致：' + local.bind + ' / ' + persisted.bindAddress)
      }
      if (local.httpPort !== String(persisted.httpPort)) {
        problems.push('「本机接入」显示的 HTTP 端口与存的不一致：' + local.httpPort + ' / ' + persisted.httpPort)
      }
      if (local.mqttPort !== String(persisted.mqttPort)) {
        problems.push('「本机接入」显示的 MQTT 端口与存的不一致：' + local.mqttPort + ' / ' + persisted.mqttPort)
      }
    }
  }

  // ---- 2) 设备对话框：推流地址与秘钥（只读；首次读会生成一条秘钥） ----------------
  const endpoint = await layout('/devices', '(async () => {' +
    'const button = document.querySelector("table.devices-table [data-action=device-configure]");' +
    'if (!button) return JSON.stringify({ ok: false, reason: "no-configure-button" });' +
    'button.click();' +
    'await new Promise((r) => setTimeout(r, 600));' +
    'const block = document.querySelector("[data-device-push]");' +
    'const text = (sel) => { const node = document.querySelector(sel);' +
    '  return node ? (node.textContent || "").trim() : ""; };' +
    'return JSON.stringify({' +
    '  ok: !!block,' +
    '  secret: text("[data-push-secret]"),' +
    '  urls: [...document.querySelectorAll("[data-push-http-url] code")].map((n) => (n.textContent || "").trim()),' +
    '  targets: [...document.querySelectorAll("[data-push-mqtt-target] code")].map((n) => (n.textContent || "").trim()),' +
    '  topic: text("[data-push-mqtt-topic]"),' +
    '  rotate: !!document.querySelector("[data-action=rotate-push-secret]"),' +
    '  copyButtons: document.querySelectorAll("[data-device-push] button").length' +
    '});' +
    '})()', 90_000)
  log('iot endpoint  : ' + JSON.stringify(endpoint))

  const secret = endpoint.secret
  if (!endpoint.ok) {
    problems.push('设备对话框里没有「推流地址与秘钥」那一块（[data-device-push]）')
  } else {
    if (!/^[0-9a-f]{32}$/.test(secret)) {
      problems.push('界面显示的秘钥不是 32 位小写十六进制：' + JSON.stringify(secret))
    }
    if (endpoint.urls.length < 1) {
      problems.push('设备对话框里没有 HTTP 推流地址（本机没有可用地址？）：' + JSON.stringify(endpoint.urls))
    }
    for (const url of endpoint.urls) {
      if (!url.startsWith('http://') || url.indexOf(telemetryPath(secret)) < 0) {
        problems.push('HTTP 推流地址形状不对：' + JSON.stringify(url) + '（秘钥 ' + secret + '）')
      }
    }
    if (!endpoint.targets.length || !/^mqtt:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(endpoint.targets[0])) {
      problems.push('MQTT 地址形状不对：' + JSON.stringify(endpoint.targets))
    }
    if (endpoint.topic.indexOf('v1/devices/me/telemetry') < 0) {
      problems.push('设备对话框里没有 MQTT 主题：' + JSON.stringify(endpoint.topic))
    }
    if (!endpoint.rotate) problems.push('设备对话框里没有「轮换秘钥」按钮')
    if (endpoint.copyButtons < 3) {
      problems.push('推流那一块没有可复制的按钮（秘钥 + 地址都要能复制）：' + endpoint.copyButtons)
    }
  }

  if (!/^[0-9a-f]{32}$/.test(secret)) {
    log('iot drill     : 秘钥形状不对，跳过写探针')
    return
  }

  // ---- 3) 写探针：打开接入 → 真推 → 读数 → 关掉并还原 --------------------------
  /*
   * ⚠ 第 33 轮修的一段**探针漂移**（它让整个 D③④ 那一组红了四轮）：
   *
   * 第 13 批第 1 条把「数据接入」整块搬进「设备管理 → 添加设备 → 本机接入」，设置页那个
   * 页签删掉了 —— 但这一段探针还在**设置页**上 `clickTab("iot")` + 写
   * `[data-iot-http-port]`（两个元素都早就不存在了，`setInput(null, …)` 静默返回 false）。
   * 后果是一条链：端口没写进设置（设置里还是 8080/1883）→ 监听起在 8080 →
   * driver 却往**它自己挑的高位端口**（20000+/30000+）推 → `ECONNREFUSED` →
   * 「真 HTTP 推流没有回 200」「MQTT 没有 CONNACK」「计数是 0」「最近收到是空的」
   * 一共九条问题。**九条红的都是同一个原因**，而且界面本身没问题：
   * 「本机接入」那一块在 32 轮的只读探针里读出来是逐项正确的（`iot local block: ok=true`）。
   *
   * 现在改成走**真正的那条界面路径**（也正是业主要求的"真窗口证据"）：
   *   `/settings` 只留存储根那一件（那一页没搬走）→ 切到 `/devices` → 打开添加设备对话框 →
   *   展开「本机接入」→ 填两个端口 → 点「保存」→ 读回保存提示与端口。
   */
  const openScript = ('(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const el = (sel, root) => (root || document).querySelector(sel);' +
    'const text = (node) => (node ? (node.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const clickTab = async (id) => { const tab = el(".settings-tabs [data-tab=" + id + "]");' +
    '  if (tab) tab.click();' +
    '  await wait(300); };' +
    'const setInput = (node, value) => { if (!node) return false;' +
    '  node.value = String(value);' +
    '  node.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  return true; };' +
    /*
     * 存储根在**另一页**（存储页签）上，而这台机器的存储根指向操作员真实的目录 ——
     * 推一条"认得出"的遥测会在 flush 时往那里写一个 Parquet 文件。所以先在设置页把它换成
     * 这一次性 profile 里的目录（与 E2 那条探针同一做法）。
     */
    'await clickTab("storage");' +
    'setInput(el(".path-row .input"), __PROBE_ROOT__);' +
    'const before = await window.api.settings.get();' +
    'const alarms = await window.api.alarms.query({ acknowledged: false, limit: 1 });' +
    /*
     * ⚠ 第 36 轮补的一步：**「添加设备」按钮只在设备管理页上**。这一段原来整段跑在
     * `/settings` 上（存储根也只在那一页），于是"打开对话框"那一步必然落空 ——
     * 问题清单里那两条（`写接入端口时没打开…` / `「本机接入」里没找到保存按钮`）
     * 就是这么来的。所以：先在设置页改完存储根，**再切到设备管理页**开对话框。
     */
    'location.hash = "#/devices";' +
    'await wait(1200);' +
    /*
     * 监听设置的**两个端口**现在在「添加设备 → 本机接入」里（业主第 13 批第 1 条）。
     * 打开对话框 → 展开 details → 填端口 → 点保存（这是这一段唯一的一次界面写操作）。
     */
    'const portPlan = { http: __HTTP_PORT__, mqtt: __MQTT_PORT__, dialog: false, saved: false,' +
    '  notice: "", error: "", readBack: null };' +
    'const addButton = [...document.querySelectorAll("button")]' +
    '  .find((b) => text(b) === "添加设备" || /^Add device/.test(text(b)));' +
    'if (addButton) addButton.click();' +
    'for (let i = 0; i < 20 && !el("[data-add-iot-local]"); i += 1) await wait(200);' +
    'const iotDialog = el("[data-add-device-dialog]");' +
    'const iotLocal = el("[data-add-iot-local]", iotDialog);' +
    'if (iotLocal) {' +
    '  portPlan.dialog = true;' +
    /*
     * ⚠ 第 38 轮修的两处**探针**缺陷（都是"合成事件不够真"）：
     *   1. `local.open = true` **不会触发 `toggle` 事件** —— 而这一块很可能是在 `@toggle` 里
     *      才去读收数统计的（人点开是会触发的，程序设属性不会）；
     *   2. 端口框是 `v-model.number`，只派发 `input` 时 `iotDirty` 没有变脏 →
     *      「保存」按钮是 **disabled**（实测 `saveDisabled: true`），`.click()` 什么也不做 ——
     *      于是端口没写进去、`notice` 与 `error` 同时为空。
     * 修法：点 `<summary>` 打开（真事件）、输入时把 `input`+`change`+`blur` 都派发一遍，
     * 并且**只在按钮可用时点击**（不可用就如实记下来）。
     */
    '  const summary = iotLocal.querySelector("summary");' +
    '  if (summary) summary.click(); else iotLocal.open = true;' +
    '  await wait(300);' +
    '  const fillPort = (selector, value) => {' +
    '    const node = el(selector, iotDialog);' +
    '    if (!node) return false;' +
    '    node.focus();' +
    '    node.value = String(value);' +
    '    node.dispatchEvent(new Event("input", { bubbles: true }));' +
    '    node.dispatchEvent(new Event("change", { bubbles: true }));' +
    '    node.dispatchEvent(new Event("blur", { bubbles: true }));' +
    '    return true;' +
    '  };' +
    '  portPlan.filled = [' +
    '    fillPort("[data-add-iot-http-port]", __HTTP_PORT__),' +
    '    fillPort("[data-add-iot-mqtt-port]", __MQTT_PORT__)' +
    '  ];' +
    '  await wait(300);' +
    '  const save = el("[data-add-iot-save]", iotDialog);' +
    '  portPlan.saveDisabled = save ? save.disabled === true : null;' +
    '  if (save && !save.disabled) { save.click(); await wait(1500); portPlan.saved = true; }' +
    '  portPlan.notice = text(el("[data-add-iot-notice]", iotDialog));' +
    '  portPlan.error = text(el("[data-add-iot-error]", iotDialog));' +
    '  portPlan.readBack = {' +
    '    http: (function(){ const n = el("[data-add-iot-http-port]", iotDialog);' +
    '      return n ? String(n.value) : null; })(),' +
    '    mqtt: (function(){ const n = el("[data-add-iot-mqtt-port]", iotDialog);' +
    '      return n ? String(n.value) : null; })()' +
    '  };' +
    '  const close = el(".panel__header button", iotDialog);' +
    '  if (close) close.click();' +
    '  await wait(400);' +
    '}' +
    /*
     * **第 13 批第 1 条之后：监听由"设备声明"驱动**（界面上那几格是只读的派生显示）。
     * 所以这里不点总开关，而是走界面上同一条 IPC —— 让两台设备分别声明 HTTP 与 MQTT 接入：
     *   · 一台声明 http → 本机的 HTTP 监听应当起来；
     *   · 另一台声明 mqtt → MQTT 监听应当起来。
     * 两条都起来之后 `enabled/httpEnabled/mqttEnabled` 三个开关都该是 true（派生出来的）。
     */
    'const listed = await window.api.devices.list();' +
    'const devices = listed && listed.success ? listed.data : [];' +
    'if (devices.length < 2) return JSON.stringify({ reason: "need-two-devices" });' +
    'const httpPlan = { protocol: "http", metricKeys: [], videoKey: "video_url" };' +
    'const mqttPlan = { protocol: "mqtt", metricKeys: [], videoKey: "" };' +
    'const setHttp = await window.api.devices.update({ id: devices[0].id, ingest: httpPlan });' +
    'const setMqtt = await window.api.devices.update({ id: devices[1].id, ingest: mqttPlan });' +
    'await wait(2500);' +
    'const config = await window.api.settings.get();' +
    'const status = await window.api.ingest.status();' +
    'return JSON.stringify({' +
    '  originalRoot: before.success ? before.data.storageRoot : null,' +
    '  alarmTotalBefore: alarms.success ? alarms.data.total : null,' +
    '  portPlan,' +
    '  declaredOn: [devices[0].id, devices[1].id],' +
    '  plansWritten: {' +
    '    http: setHttp && setHttp.success ? setHttp.data.ingest : null,' +
    '    mqtt: setMqtt && setMqtt.success ? setMqtt.data.ingest : null' +
    '  },' +
    '  config: config.success ? config.data.iotIngest : null,' +
    '  status: status.success ? status.data : null' +
    '});' +
    '})()')
    .replace(/__PROBE_ROOT__/g, JSON.stringify(probeStorageRoot))
    .replace(/__HTTP_PORT__/g, String(httpPort))
    .replace(/__MQTT_PORT__/g, String(mqttPort))

  const opened = await layout('/settings', openScript, 120_000)
  log('iot opened    : ' + JSON.stringify({
    originalRoot: opened.originalRoot,
    alarmTotalBefore: opened.alarmTotalBefore,
    portPlan: opened.portPlan,
    plansWritten: opened.plansWritten,
    config: opened.config,
    http: opened.status && opened.status.http,
    mqtt: opened.status && opened.status.mqtt
  }))

  if (opened.reason === 'need-two-devices') {
    problems.push('接入探针：库里不足两台设备，没法分别声明 HTTP 与 MQTT 接入')
    return
  }
  /*
   * **端口是走界面写的**（这是"真窗口证据"的一半）：对话框在、保存点了、提示是成功、
   * 读回的两个端口就是刚填的。第 33 轮之前这一段在设置页写两个早已不存在的元素，
   * 于是"端口没写进去"，后面九条推送断言全跟着红（同一个原因）。
   */
  const portPlan = opened.portPlan || {}
  if (portPlan.dialog !== true) {
    problems.push('写接入端口时没打开「添加设备 → 本机接入」那一块（端口写不进去）')
  }
  if (portPlan.saved !== true) {
    problems.push('「本机接入」里没找到保存按钮（[data-add-iot-save]）')
  }
  if (portPlan.error) {
    problems.push('保存「本机接入」报错：' + JSON.stringify(portPlan.error))
  }
  /*
   * ⚠ 第 38 轮改成**记日志**（原来是两条 problems）：第 37 轮实测，探针在「本机接入」里
   * "填端口 → 点保存"这一步**没有真的生效**（`readBack` 是探针填的新值，但 `notice` 与 `error`
   * 同时为空、设置里仍是 8080/1883）。`saveIotSettings()` 的每条分支都会写 notice 或 error，
   * 所以看起来是**这次合成点击没有走进去**，而不是产品的校验失败 —— 而"业主手工改端口"
   * 这条路径我没有证据说它坏。把它报成产品缺陷是**把探针的局限说成产品的错**，
   * 所以降级成日志，并在文档的未验证清单里如实留着（要在真窗口里手工确认一次）。
   * 推流那九条断言现在按**应用报出来的端口**走（见下面的 `httpTargetPort`），不再被这一步拖红。
   */
  if (!portPlan.notice) {
    log(
      'iot ports     : 通过界面保存监听设置没有拿到结果提示（探针侧未生效，不是判决）；' +
        'readBack=' + JSON.stringify(portPlan.readBack || null) +
        ' notice=' + JSON.stringify(portPlan.notice) + ' error=' + JSON.stringify(portPlan.error)
    )
  }
  if (portPlan.readBack && portPlan.readBack.http !== String(httpPort)) {
    log(
      'iot ports     : 输入框里的端口与探针想填的不一致（探针侧未生效）：' +
        JSON.stringify(portPlan.readBack) + ' vs ' + httpPort + '/' + mqttPort
    )
  }  /*
   * 第 13 批第 1 条的核心断言：**设备声明 → 本机监听**。
   * 两台设备分别声明 http / mqtt 之后，三个开关都应当是派生出来的 true，而且两个监听真的起来了。
   */
  if (opened.plansWritten?.http?.protocol !== 'http' || opened.plansWritten?.mqtt?.protocol !== 'mqtt') {
    problems.push('写设备接入方式之后读回不一致：' + JSON.stringify(opened.plansWritten))
  }
  if (!opened.config || opened.config.enabled !== true) {
    problems.push('有设备声明 http/mqtt 之后，派生出来的总开关不是 true：' + JSON.stringify(opened.config))
  }
  if (opened.config && (!opened.config.httpEnabled || !opened.config.mqttEnabled)) {
    problems.push('派生出来的两个通道开关不对：' + JSON.stringify(opened.config))
  }
  if (opened.config && opened.config.httpPort !== httpPort) {
    /*
     * ⚠ 第 38 轮加了"保存按钮是不是禁用的"这个读数：第 37/38 轮都出现
     * "端口框里是新值、但 notice 与 error 同时为空、设置里还是 8080" —— 这**最像**
     * 「保存按钮是 disabled，`.click()` 什么也不做」（`saveIotSettings()` 每条分支都会
     * 写 notice 或 error，不可能两者都空）。下一轮看 `portPlan.saveDisabled` 就能判定：
     *   true  → 是"探针的合成 input 没把 `iotDraft` 改成脏"（探针的事）；
     *   false → 点击真的进去了，那就要去看 `settings.update({iotIngest})` 为什么不落库（产品的事）。
     */
    problems.push(
      '界面上改的 HTTP 端口没有写进设置：' + JSON.stringify(opened.config) +
        '；保存按钮 disabled=' + JSON.stringify(opened.portPlan && opened.portPlan.saveDisabled) +
        '（见 docs/UI-VERIFY.md 第 61 条：探针侧还是产品侧，下一轮靠这个读数分开）'
    )
  }
  if (opened.config && opened.config.storageRoot !== undefined) {
    // storageRoot 不在 iotIngest 里；这一条只是防止把两个结构看混了。
    problems.push('iotIngest 里出现了 storageRoot（结构串了）')
  }
  if (!opened.status || !opened.status.http.listening) {
    problems.push('有设备声明 HTTP 接入之后 HTTP 没有在监听：' + JSON.stringify(opened.status && opened.status.http))
  }
  if (!opened.status || !opened.status.mqtt.listening) {
    problems.push('有设备声明 MQTT 接入之后 MQTT 没有在监听：' + JSON.stringify(opened.status && opened.status.mqtt))
  }

  /*
   * ⚠ 第 38 轮：推流**用应用报出来的那个端口**，不是"探针想改成的那个"。
   *
   * 业主真正会做的事是"把界面上显示的那个地址复制出去推一条" —— 所以端到端这一条路
   * 就该按 `ingest.status()` 报的 `http.port` / `mqtt.port` 推。第 37 轮实测：
   * 探针在「本机接入」里改端口那一步**没有真的生效**（`notice`/`error` 同时为空、
   * 设置里仍是 8080），于是九条推送全打到一个没人听的端口上（`ECONNREFUSED`）——
   * 那是**探针的**问题，不该把九条断言一起拖红。"改端口"本身另有一条界面保真断言（见上）。
   */
  const reportedPort = (side, fallback) => {
    const entry = opened.status && opened.status[side]
    return entry && entry.port ? entry.port : fallback
  }
  const httpTargetPort = reportedPort('http', httpPort)
  const mqttTargetPort = reportedPort('mqtt', mqttPort)
  if (httpTargetPort !== httpPort || mqttTargetPort !== mqttPort) {
    log(
      'iot ports     : 推流改用**应用报出来的**端口 http=' + httpTargetPort +
        ' mqtt=' + mqttTargetPort + '（探针想改成的 ' + httpPort + '/' + mqttPort + ' 没生效）'
    )
  }

  // ---- 3a) 真的 HTTP 请求（从 driver 进程，不是渲染层） -----------------------
  const post = (pathName, body) => new Promise((resolve) => {
    const payload = Buffer.from(body)
    const request = http.request(
      {
        host: '127.0.0.1',
        port: httpTargetPort,
        path: pathName,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      },
      (response) => {
        let text = ''
        response.on('data', (chunk) => { text += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body: text }))
      }
    )
    request.on('error', (error) => resolve({ status: 0, body: String(error && error.message) }))
    request.write(payload)
    request.end()
  })

  const unknownKeys = await post(telemetryPath(secret), JSON.stringify({ probe_iot_key: 1 }))
  const knownKeys = await post(
    telemetryPath(secret),
    JSON.stringify({ sound_pressure_level: 61.5, channel_id: 0, smoothness: 4.25 })
  )
  const withAlarm = await post(
    telemetryPath(secret),
    JSON.stringify({ alarm_mask: 4, sound_pressure_level: 70, channel_id: 1 })
  )
  const wrongSecret = await post(telemetryPath('b'.repeat(32)), JSON.stringify({ spl: 1 }))
  const wrongPath = await post('/api/v1/' + secret, JSON.stringify({ spl: 1 }))
  log('iot http      : ' + JSON.stringify({ unknownKeys, knownKeys, withAlarm, wrongSecret, wrongPath }))

  if (unknownKeys.status !== 200) problems.push('真 HTTP 推流没有回 200：' + JSON.stringify(unknownKeys))
  if (knownKeys.status !== 200 || !/"trendRows":1/.test(knownKeys.body)) {
    problems.push('认得出的遥测没有写进趋势（响应里 trendRows 不是 1）：' + JSON.stringify(knownKeys))
  }
  if (withAlarm.status !== 200 || !/"alarmRows":1/.test(withAlarm.body)) {
    problems.push('带 alarm_mask 的遥测没有落进告警表（响应里 alarmRows 不是 1）：' + JSON.stringify(withAlarm))
  }
  if (wrongSecret.status !== 401) {
    problems.push('秘钥不对时没有回 401：' + JSON.stringify(wrongSecret))
  }
  if (wrongPath.status !== 404) {
    problems.push('路径不对时没有回 404（401 与 404 必须分得开）：' + JSON.stringify(wrongPath))
  }

  // ---- 3b) 真的 MQTT 字节 ------------------------------------------------------
  const mqttResult = await new Promise((resolve) => {
    const pushString = (parts, value) => {
      const bytes = Buffer.from(value, 'utf8')
      const length = Buffer.alloc(2)
      length.writeUInt16BE(bytes.length, 0)
      parts.push(length, bytes)
    }
    const connectParts = []
    pushString(connectParts, 'MQTT')
    connectParts.push(Buffer.from([4]))       // 3.1.1
    connectParts.push(Buffer.from([0x82]))    // clean session + username
    connectParts.push(Buffer.alloc(2))        // keepalive 0
    pushString(connectParts, 'hz-probe')
    pushString(connectParts, secret)
    const connectBody = Buffer.concat(connectParts)
    const connect = Buffer.concat([Buffer.from([0x10]), Buffer.from([connectBody.length]), connectBody])

    const topic = Buffer.from('v1/devices/me/telemetry', 'utf8')
    const topicHead = Buffer.alloc(2)
    topicHead.writeUInt16BE(topic.length, 0)
    const payload = Buffer.from(JSON.stringify({ probe_mqtt_key: 2 }))
    const publishBody = Buffer.concat([topicHead, topic, payload])
    const publish = Buffer.concat([Buffer.from([0x30]), Buffer.from([publishBody.length]), publishBody])

    const socket = net.connect(mqttTargetPort, '127.0.0.1')
    socket.resume()
    const chunks = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ connack: Buffer.concat(chunks).toString('hex'), timeout: true })
    }, 5000)
    socket.on('connect', () => {
      socket.write(connect)
      socket.write(publish)
      socket.write(Buffer.from([0xe0, 0x00])) // DISCONNECT
    })
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const joined = Buffer.concat(chunks)
      if (joined.length >= 4) {
        clearTimeout(timer)
        socket.end()
        resolve({ connack: joined.toString('hex'), timeout: false })
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      resolve({ connack: '', error: String(error && error.message) })
    })
  })
  log('iot mqtt      : ' + JSON.stringify(mqttResult))
  if (mqttResult.connack.slice(0, 8) !== '20020000') {
    problems.push('MQTT 连接没有回「接受」的 CONNACK（期望 20020000）：' + JSON.stringify(mqttResult))
  }

  // ---- 3c) 读数真的变了 + 关掉并还原 ------------------------------------------
  const closeScript = ('(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const el = (sel, root) => (root || document).querySelector(sel);' +
    'const text = (node) => (node ? (node.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const setInput = (node, value) => { if (!node) return false;' +
    '  node.value = String(value);' +
    '  node.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  return true; };' +
    'const status = await window.api.ingest.status();' +
    'const alarms = await window.api.alarms.query({ acknowledged: false, limit: 1 });' +
    /*
     * 第 13 批第 1 条之后这一段的读数在**添加设备对话框**里（设置页那个页签已经删了）。
     * 打开对话框 → 展开「本机接入」→ 点顶栏那一颗唯一的刷新 → 把收数统计逐项读出来。
     * 「服务收了 5 条」而屏幕上写着 0，是这一类改动最典型的假成功（接上了但没刷新）。
     */
    'const addButton = [...document.querySelectorAll("button")]' +
    '  .find((b) => text(b) === "添加设备" || /^Add device/.test(text(b)));' +
    'if (addButton) addButton.click();' +
    'for (let i = 0; i < 20 && !el("[data-add-iot-local]"); i += 1) await wait(200);' +
    'const dialog = el("[data-add-device-dialog]");' +
    'const local = el("[data-add-iot-local]");' +
    // 同第 38 轮那处：**点 `<summary>`** 才会触发 `toggle`（程序设 `open` 不会）。
    'if (local) {' +
    '  const localSummary = local.querySelector("summary");' +
    '  if (localSummary) localSummary.click(); else local.open = true;' +
    '}' +
    'await wait(300);' +
    'const refresh = el("[data-action=topbar-refresh]");' +
    'if (refresh) refresh.click();' +
    'const refreshFound = !!refresh;' +
    /*
     * ⚠ 第 39 轮：读数要用**这一块自己的那颗「重新读取」**（`[data-add-iot-reload]`）。
     *
     * 「本机接入」的收数统计是**打开对话框时读一次、之后不轮询**的（源码里写着这条设计），
     * 顶栏那颗刷新刷的是**设备状态**，不覆盖这块读数。第 38 轮那条
     * 「屏幕全 0 vs 服务 5/1/1/0/2/1」就是探针点错了按钮：它只点了顶栏刷新，
     * 然后等 60 秒等一块"本来就不会自己变"的读数变 —— 那是**探针的错**，不是界面的错。
     * （界面给了 refresh 的手段，只是在这一块自己身上。）
     */
    'const reloadStats = el("[data-add-iot-reload]", dialog);' +
    'if (reloadStats) reloadStats.click();' +
    'const reloadFound = !!reloadStats;' +
    /*
     * 顶栏那颗刷新先**重新探活所有设备**（`devices.refreshStatus()`，其中离线设备要等到
     * 请求超时），所以"点了之后多久读数才变"取决于现场有几台设备不通 —— 这里**自适应地等**
     * （最多 20 秒），而不是写死一个秒数：写死了就会在设备多的机器上偶发变红。
     */
    'let domStats = [];' +
    'let domStatsWaitedMs = 0;' +
    /*
     * 60 秒，而且**在循环里再点两次刷新**：顶栏那颗刷新会重新探活所有设备（离线设备要等到
     * 超时），现场设备多时 20 秒不够；只点一次的话，那一次如果落在对话框刚打开、
     * store 还没加载完的时刻，读数就会永远是 0（第 38 轮实测到的就是这一种）。
     */
    'for (let attempt = 0; attempt < 120; attempt += 1) {' +
    '  if (attempt === 8 || attempt === 30) {' +
    '    const again = el("[data-add-iot-reload]", dialog);' +
    '    if (again) again.click();' +
    '  }' +
    '  await wait(500);' +
    '  domStatsWaitedMs += 500;' +
    '  domStats = [...document.querySelectorAll("[data-add-iot-stats] .kv__item")].map((item) =>' +
    '    ((item.querySelector(".kv__value") || {}).textContent || "").trim());' +
    '  if (domStats[0] && domStats[0] !== "0") break;' +
    '}' +
    /*
     * 顺手把监听设置**保存一次**（写 + 读回核对）：把两个端口写回出厂默认值。
     * 这是这一段唯一的写操作，而且它走的就是界面上那条路（不是开发接口）。
     */
    /*
     * ⚠ 第 38 轮：还原也要用**够真的**事件序列（`input`+`change`+`blur`），否则"保存"按钮
     * 仍然是 disabled、`.click()` 什么也不做 —— 第 38 轮就是这么留下了一条
     * 「探针改过的端口没有还原」（端口还停在探针填的那两个高位端口上）。
     */
    'const fillBack = (selector, value) => {' +
    '  const node = el(selector, dialog);' +
    '  if (!node) return false;' +
    '  node.focus();' +
    '  node.value = String(value);' +
    '  node.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  node.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  node.dispatchEvent(new Event("blur", { bubbles: true }));' +
    '  return true;' +
    '};' +
    'fillBack("[data-add-iot-http-port]", 8080);' +
    'fillBack("[data-add-iot-mqtt-port]", 1883);' +
    'await wait(300);' +
    'const saveButton = el("[data-add-iot-save]", dialog);' +
    'if (saveButton && !saveButton.disabled) saveButton.click();' +
    'await wait(1500);' +
    'const saveNotice = text(el("[data-add-iot-notice]", dialog));' +
    'const saveError = text(el("[data-add-iot-error]", dialog));' +
    'const portsAfterSave = {' +
    '  http: (function(){ const n = el("[data-add-iot-http-port]", dialog); return n ? String(n.value) : null; })(),' +
    '  mqtt: (function(){ const n = el("[data-add-iot-mqtt-port]", dialog); return n ? String(n.value) : null; })()' +
    '};' +
    'const restore = await Promise.all(__DECLARED_IDS__.map((id) =>' +
    '  window.api.devices.update({ id, ingest: { protocol: "none" } })));' +
    'await wait(2500);' +
    'const after = await window.api.ingest.status();' +
    'const config = await window.api.settings.get();' +
    'const close = dialog ? el(".panel__header button", dialog) : null;' +
    'if (close) close.click();' +
    'await wait(400);' +
    // 存储根还原仍然在设置页的「存储」页签上（那一页没有搬走）。
    'location.hash = "#/settings";' +
    'await wait(1200);' +
    'const storageTab = el(".settings-tabs [data-tab=storage]");' +
    'if (storageTab) storageTab.click();' +
    'await wait(400);' +
    'setInput(el(".path-row .input"), __ORIGINAL_ROOT__);' +
    'await wait(2200);' +
    'return JSON.stringify({' +
    '  before: status.success ? status.data : null,' +
    '  alarmTotalAfter: alarms.success ? alarms.data.total : null,' +
    '  after: after.success ? after.data : null,' +
    '  config: config.success ? config.data.iotIngest : null,' +
    '  storageRoot: config.success ? config.data.storageRoot : null,' +
    '  saveNotice,' +
    '  saveError,' +
    '  portsAfterSave,' +
    '  domStatsWaitedMs,' +
    '  reloadFound,' +
    '  localBlockFound: !!local,' +
    '  restored: restore.every((result) => result && result.success),' +
    '  refreshFound,' +
    '  domStats' +
    '});' +
    '})()')
    .replace(/__ORIGINAL_ROOT__/g, JSON.stringify(opened.originalRoot || probeStorageRoot))
    .replace(/__DECLARED_IDS__/g, JSON.stringify(opened.declaredOn ?? []))

  /*
   * ⚠ 路由是 `/devices`（第 33 轮改的）：读收数统计那一块现在在「添加设备」对话框里，
   * 而「添加设备」按钮只在设备管理页上 —— 在 `/settings` 上找它必然找不到，
   * 于是这一支会报「收尾那一段没找到添加设备对话框里的『本机接入』那一块」。
   * 脚本自己在最后会 `location.hash = "#/settings"` 回去还原存储根。
   */
  const closed = await layout('/devices', closeScript, 120_000)
  log('iot closed    : ' + JSON.stringify(closed))

  const before = closed.before
  if (!before) {
    problems.push('关掉之前读不到接入状态')
  } else {
    /**
     * 这一次推了 **5 条 HTTP 请求**：不认识的键、认得出的键、带 alarm_mask 的那条、
     * 秘钥不对那条（401）、路径不对那条（404）。计数必须是 5，**一条都不能漏** ——
     * 401/404 也是"收到了一个请求"，漏掉它们会让现场无法判断设备到底有没有连上来。
     */
    if (before.stats.httpRequests < 5) {
      problems.push('HTTP 请求计数不对（这一轮发了 5 条）：' + before.stats.httpRequests)
    }
    if (before.stats.mqttMessages < 1) {
      problems.push('MQTT 报文计数不对（那一条 PUBLISH 没被记上）：' + before.stats.mqttMessages)
    }
    if (before.stats.trendRows < 2) {
      problems.push('写进趋势的行数不对（两条认得出的遥测）：' + before.stats.trendRows)
    }
    if (before.stats.alarmRows < 1) {
      problems.push('写进告警的行数不对（带 alarm_mask 的那一条）：' + before.stats.alarmRows)
    }
    if (before.stats.rejectedAuth < 1) problems.push('秘钥不对那一次没有被记成"凭据被拒"')
    if (!before.stats.lastAt) problems.push('「最近收到」是空的（收到数据却不记时间）')

    /**
     * 页面上显示的那几个数字必须与主进程报的一致（顺序见模板里那七个 `.kv__item`）。
     * 只对四个**计数**比对：最后一项是时间，字符串格式与语言有关。
     */
    const expected = [
      String(before.stats.httpRequests),
      String(before.stats.mqttMessages),
      String(before.stats.rejectedAuth),
      String(before.stats.rejectedPayload),
      String(before.stats.trendRows),
      String(before.stats.alarmRows)
    ]
    const shown = (closed.domStats || []).slice(0, expected.length)
    if (!closed.refreshFound) {
      problems.push('顶栏那颗唯一的刷新（[data-action=topbar-refresh]）不在页面上')
    } else if (closed.localBlockFound !== true) {
      problems.push('收尾那一段没找到添加设备对话框里的「本机接入」那一块')
    } else if (shown.length < expected.length) {
      problems.push('「本机接入」里那几个读数没有全部渲染出来：' + JSON.stringify(closed.domStats))
    } else if (JSON.stringify(shown) !== JSON.stringify(expected)) {
      problems.push(
        '页面上的读数与主进程报的不一致：屏幕 ' + JSON.stringify(shown) +
          ' vs 服务 ' + JSON.stringify(expected) + '（接上了但没刷新？）'
      )
    }
    /*
     * 监听设置那一次保存：它是这一段唯一的**界面写操作**（写 + 读回核对）。
     * 成功时给一句"已保存并读回核对"，失败时会有一句错误 —— 两者不许同时有、也不许都没有。
     */
    if (closed.saveError) {
      problems.push('在「本机接入」里保存监听设置报错：' + JSON.stringify(closed.saveError))
    } else if (!closed.saveNotice) {
      problems.push('在「本机接入」里保存监听设置之后没有任何结果提示')
    }
    if (closed.portsAfterSave && (closed.portsAfterSave.http !== '8080' || closed.portsAfterSave.mqtt !== '1883')) {
      problems.push('保存之后输入框里的端口不是 8080 / 1883：' + JSON.stringify(closed.portsAfterSave))
    }

    const alarmBefore = opened.alarmTotalBefore
    if (closed.alarmTotalAfter === null || alarmBefore === null || alarmBefore === undefined) {
      problems.push('读不到未确认告警的总数，无法验证"推来的告警"有没有进库')
    } else if (closed.alarmTotalAfter !== alarmBefore + 1) {
      problems.push(
        '设备推来的告警没有进库：未确认告警从 ' + alarmBefore +
          ' 变成 ' + closed.alarmTotalAfter + '（应当 +1）'
      )
    }
  }

  if (!closed.after || closed.after.http.listening || closed.after.mqtt.listening) {
    problems.push('把设备的接入方式改回 none 之后还有监听在跑：' + JSON.stringify(closed.after && {
      http: closed.after.http,
      mqtt: closed.after.mqtt
    }))
  }
  if (closed.config && (closed.config.httpPort !== 8080 || closed.config.mqttPort !== 1883)) {
    problems.push('探针改过的端口没有还原：' + JSON.stringify(closed.config))
  }
  /*
   * **这一条是第 13 批第 1 条的另一半**：把两台设备的接入方式改回 `none` 之后，
   * 派生出来的总开关应当自己关掉（本机不为没人用的协议开着端口）。
   */
  if (closed.config && closed.config.enabled !== false) {
    problems.push('没有设备声明接入之后，派生出来的总开关没有关掉：' + JSON.stringify(closed.config))
  }
  if (closed.restored !== true) {
    problems.push('探针改过的设备接入方式没有还原：' + JSON.stringify(closed.restored))
  }
}

/**
 * 手填 RTSP 地址（业主 2026-09-19 第 3 条：「② 能手填一个 RTSP 地址给第三方相机」）。
 *
 * WHY THIS DRILL
 * 这一条把"视频墙的第 2 条要求"落成一个**具体的入站源**：不是"主动去拉我们管理的设备"，
 * 而是给第三方相机手填一个地址。它有三件事只有在一个跑起来的应用里才成立：
 *   1. 标题行里那个入口在，点开是一个**真的对话框**（表单 + 列表）；
 *   2. 地址的形状判断在**输入的那一刻**就说清楚（`http://…` 被拒，而且不产生一条源）；
 *   3. 保存之后：列表里多一条、**当前格**里出现这个名字、主进程真的为它起了一路会话。
 *
 * 最后把它删掉（**探针改过的状态要还回去**），并读回确认格子回到原来的样子。
 * 因为它是写探针，所以排在所有只读探针之后（与 IoT 那条同一规矩）。
 */
/**
 * 手填 RTSP 地址（第 10 批第 2 条 / 第 11 批第 2 条：管理界面搬到实时监测页）。
 *
 * WHY THIS DRILL
 * 业主 2026-09-19 第 11 批第 2 条把「手填 RTSP 地址」的入口从画面墙搬到了实时监测页。
 * 这一趟要验的是"搬过去之后整条路还通"，而且三件事分开量：
 *   ① **实时监测页**：表单 + 列表在这儿；`http://` 当场被拒且不产生源；合法地址保存成一条；
 *      地址在列表里是**打码**的（口令不能出现在屏幕上）；
 *   ② **画面墙**（总览页）**仍然用得上**这些源：它出现在某一格的选择器里（带「手填 RTSP」后缀），
 *      放进一格之后主进程真的为它起了一路会话 —— 这一条同时验了"源活过了页面切换"
 *      （`clearAll` 以前会把源一起删掉，那是第 11 批带出来的一个真 bug）；
 *   ③ 回到实时监测页**删掉**它：列表回到 0，主进程里那一路会话也没了。
 */
async function runManualRtspDrill(win, layout) {
  const probeName = '探针手填源'
  const url = 'rtsp://127.0.0.1:8554/probe'

  // ---- ① 实时监测页：管理界面 -------------------------------------------------
  const manage = await layout('/monitor', ('(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const setInput = (el, value) => { if (!el) return false;' +
    '  el.value = value;' +
    '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  return true; };' +
    'const rows = () => document.querySelectorAll("[data-manual-rtsp-row]").length;' +
    'const out = {};' +
    'out.cardPresent = !!document.querySelector("[data-manual-rtsp-sources]");' +
    'out.openEntryOnWall = document.querySelectorAll("[data-action=manual-rtsp-open]").length;' +
    'out.rowsBefore = rows();' +
    'if (!out.cardPresent) return JSON.stringify(Object.assign(out, { reason: "no-card" }));' +
    // ①a 形状判断：`http://` 必须当场被拒，而且**不产生一条源**。
    'setInput(document.querySelector("[data-manual-rtsp-name]"), __NAME__);' +
    'setInput(document.querySelector("[data-manual-rtsp-url]"), "http://127.0.0.1/probe");' +
    'document.querySelector("[data-action=manual-rtsp-save]").click();' +
    'await sleep(400);' +
    'out.invalidError = text(document.querySelector("[data-manual-rtsp-error]"));' +
    'out.rowsAfterInvalid = rows();' +
    // ①b 合法地址：保存 → 列表出现一条，地址打码（这里本来就没有口令）
    'setInput(document.querySelector("[data-manual-rtsp-url]"), __URL__);' +
    'document.querySelector("[data-action=manual-rtsp-save]").click();' +
    'await sleep(500);' +
    'out.rowsAfterSave = rows();' +
    'out.rowName = text(document.querySelector("[data-manual-rtsp-row] .manual__name"));' +
    'out.rowUrl = text(document.querySelector("[data-manual-rtsp-row] .manual__url"));' +
    'out.errorAfterSave = text(document.querySelector("[data-manual-rtsp-error]"));' +
    'return JSON.stringify(out);' +
    '})()').replace(/__NAME__/g, JSON.stringify(probeName)).replace(/__URL__/g, JSON.stringify(url)), 120_000)
  log('manual rtsp ① : ' + JSON.stringify(manage))

  if (manage.reason === 'no-card') {
    problems.push('实时监测页没有第三方相机（手填 RTSP）那张卡（[data-manual-rtsp-sources]）')
    return
  }
  if (manage.openEntryOnWall !== 0) {
    problems.push(
      '画面墙上还留着手填入口（[data-action=manual-rtsp-open] 出现 ' + manage.openEntryOnWall + ' 次）'
    )
  }
  if (!manage.invalidError) {
    problems.push('填 http:// 开头的地址没有被当场拒绝（形状判断没生效）')
  }
  if (manage.rowsAfterInvalid !== manage.rowsBefore) {
    problems.push('被拒的地址还是产生了一条手填源：' + manage.rowsAfterInvalid)
  }
  if (manage.rowsAfterSave !== manage.rowsBefore + 1) {
    problems.push('保存之后手填源列表不是多一条：' + manage.rowsAfterSave)
  }
  if (manage.rowName !== probeName) {
    problems.push('列表里的名字不是填进去的那个：' + JSON.stringify(manage.rowName))
  }
  if (!String(manage.rowUrl || '').includes(url)) {
    problems.push('列表里的地址不对：' + JSON.stringify(manage.rowUrl))
  }

  // ---- ② 总览页：画面墙的选择器里能找到它，放进一格真的起流 --------------------
  const place = await layout('/', ('(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const out = {};' +
    'const empty = document.querySelector(".camera-wall__cell--empty");' +
    'out.hadEmptyCell = !!empty;' +
    'if (!empty) return JSON.stringify(Object.assign(out, { reason: "no-empty-cell" }));' +
    'const add = empty.querySelector(".camera-wall__add");' +
    'if (!add) return JSON.stringify(Object.assign(out, { reason: "no-add-button" }));' +
    'add.click();' +
    'await sleep(700);' +
    // 源活过了页面切换：它应当在候选里，而且带「手填 RTSP」后缀。
    'const item = [...document.querySelectorAll("[data-camera-picker-item]")]' +
    '  .find((node) => text(node).includes(__NAME__));' +
    'out.pickerHasSource = !!item;' +
    'out.pickerLabel = item ? text(item) : "";' +
    'if (!item) return JSON.stringify(Object.assign(out, { reason: "picker-missing-source" }));' +
    'item.click();' +
    'await sleep(1500);' +
    'const cell = [...document.querySelectorAll(".camera-wall__cell")]' +
    '  .find((node) => text(node).includes(__NAME__));' +
    'out.cellFound = !!cell;' +
    /*
     * 第 12 批：控制条上**只有六颗播放器控件**，而手填源不是设备 ——
     * 告警 / 切换录像 / 手动录像那三颗对它没有意义，所以它这一格只有三颗。
     * 四颗视图按钮已经不在控制条上（它们进了右键菜单的「显示方式」）。
     */
    'out.barActions = cell' +
    '  ? [...cell.querySelectorAll("[data-action^=cell-]")].map((b) => b.getAttribute("data-action"))' +
    '  : [];' +
    'out.viewButtonsOnBar = cell ? cell.querySelectorAll("[data-action^=cell-view-]").length : -1;' +
    /*
     * 放进格子只是**分配**（相机也一样）：真正起流要按这一格的播放键。
     * 业主第 11 批第 2 条把管理界面搬到实时监测页之后，"放进去就自动起流"那条路没有了
     * （它原来是对话框的 `applied` 事件干的），所以探针与操作员现在都走这一颗按钮。
     */
    'const play = cell ? cell.querySelector("[data-cell-play]") : null;' +
    'out.playButton = !!play;' +
    'if (play) { play.click(); await sleep(1200); }' +
    /*
     * 音量：**点一下才弹出竖条**（业主第 12 批：「音量大小调整应该做成点击后显示出来，
     * 上下调节的方式」）。这里量四件事：浮层开没开、滑杆是不是竖的、拖一次真的写进
     * 这一格的音量（滑杆的 value 是模型回填的）、再点一次收得掉。
     */
    'const volumeButton = cell ? cell.querySelector("[data-action=cell-volume]") : null;' +
    'out.volumeButton = !!volumeButton;' +
    'if (volumeButton) { volumeButton.click(); await sleep(500); }' +
    'const pop = cell ? cell.querySelector("[data-cell-volume-pop]") : null;' +
    'out.volumePopOpen = !!pop;' +
    'const slider = pop ? pop.querySelector("[data-cell-volume]") : null;' +
    'if (slider) {' +
    '  const style = getComputedStyle(slider);' +
    '  out.slider = { width: slider.offsetWidth, height: slider.offsetHeight,' +
    '    writingMode: style.writingMode, direction: style.direction };' +
    '  slider.value = "40";' +
    '  slider.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  await sleep(400);' +
    '  out.sliderValueAfter = slider.value;' +
    '}' +
    'const video = cell ? cell.querySelector("video") : null;' +
    'out.videoPresent = !!video;' +
    'out.videoVolume = video ? video.volume : null;' +
    'const mute = pop ? pop.querySelector("[data-action=cell-volume-mute]") : null;' +
    'out.muteButton = !!mute;' +
    'if (mute) { mute.click(); await sleep(300); }' +
    'out.audioOnAfterMute = cell ? cell.classList.contains("camera-wall__cell--audio") : null;' +
    'if (volumeButton) { volumeButton.click(); await sleep(300); }' +
    'out.volumePopClosed = cell ? !cell.querySelector("[data-cell-volume-pop]") : null;' +
    // 主进程真的为它起了一路（手填那一支与设备那一支完全分开）。
    'let session = null;' +
    'for (let attempt = 0; attempt < 24; attempt += 1) {' +
    '  const states = await window.api.cameraLive.state();' +
    '  const list = states && states.success ? states.data : [];' +
    '  session = (list || []).find((entry) => String(entry.deviceId).startsWith("rtsp:")) || null;' +
    '  if (session) break;' +
    '  await sleep(500);' +
    '}' +
    'out.session = session ? { deviceId: session.deviceId, status: session.status } : null;' +
    'return JSON.stringify(out);' +
    '})()').replace(/__NAME__/g, JSON.stringify(probeName)), 120_000)
  log('manual rtsp ② : ' + JSON.stringify(place))

  if (place.reason) {
    problems.push('把第三方源放上画面墙这一步没法开始：' + place.reason)
  } else {
    if (!place.pickerHasSource) {
      problems.push('画面墙的选择器里没有那条手填源（它没有活过页面切换？）')
    } else if (!String(place.pickerLabel || '').includes('手填 RTSP')) {
      problems.push('选择器里那条手填源没有「手填 RTSP」后缀：' + JSON.stringify(place.pickerLabel))
    }
    if (!place.cellFound) {
      problems.push('选了那条手填源之后那一格没有出现它')
    }
    if (!place.playButton) {
      problems.push('那一格上没有播放键（[data-cell-play]）—— 放进去之后没法起流')
    }
    // 第 12 批：手填源只有三颗控件（它连设备都不是）。
    if (JSON.stringify(place.barActions) !== JSON.stringify(['cell-fullscreen', 'cell-play', 'cell-volume'])) {
      problems.push('手填 RTSP 那一格的控制条不是"全屏 / 暂停 / 音量"三颗：' + JSON.stringify(place.barActions))
    }
    if (place.viewButtonsOnBar !== 0) {
      problems.push('控制条上还留着视图按钮（第 12 批已移进菜单）：' + place.viewButtonsOnBar)
    }
    /*
     * 音量浮层：点一下才出现、是竖的、拖一次真的写进模型、再点一下收得掉。
     * `sliderValueAfter` 是**模型回填**的值（`:value="volumePercent(cell.index)"`），
     * 所以它等于 40 就说明 `onVolumeInput()` 真的把这一格的音量写进去了。
     */
    if (!place.volumeButton) {
      problems.push('控制条上没有「音量」那一颗')
    }
    if (!place.volumePopOpen) {
      problems.push('点了「音量」之后没有弹出竖条浮层（[data-cell-volume-pop]）')
    }
    if (!place.slider) {
      problems.push('音量浮层里没有竖条滑杆')
    } else {
      const { width, height, writingMode, direction } = place.slider
      if (!(height > width)) {
        problems.push('音量滑杆不是竖的（' + width + '×' + height + '）')
      }
      if (!String(writingMode).startsWith('vertical')) {
        problems.push('音量滑杆没有用竖直书写模式：' + JSON.stringify(writingMode))
      }
      if (direction !== 'rtl') {
        problems.push('音量滑杆的方向不是"上大下小"：' + JSON.stringify(direction))
      }
      if (place.sliderValueAfter !== '40') {
        problems.push('拖动音量滑杆之后模型没有收下这个值：' + JSON.stringify(place.sliderValueAfter))
      }
      // 有 `<video>` 时就顺手核对一次真实元素属性（这一份数据里相机离线，多数时候没有）。
      if (place.videoPresent === true && typeof place.videoVolume === 'number') {
        if (Math.abs(place.videoVolume - 0.4) > 0.02) {
          problems.push('音量没有落到 <video>.volume 上：' + place.videoVolume)
        }
      } else {
        log('manual rtsp ② : 这一格没有 <video>（会话停在 starting / 相机离线），' +
          '`<video>.volume` 这一次没量到 —— 只验到"模型收下了 40"')
      }
    }
    if (place.muteButton && place.audioOnAfterMute !== false) {
      problems.push('浮层里那个声音开关没有把这一格的声音关掉：' + JSON.stringify(place.audioOnAfterMute))
    }
    if (place.volumePopClosed !== true) {
      problems.push('再点一次「音量」没有收起浮层：' + JSON.stringify(place.volumePopClosed))
    }
    if (!place.session) {
      problems.push('主进程没有为这条手填源起会话（cameraLive.state() 里没有 rtsp: 开头的项）')
    }
  }

  // ---- ③ 回实时监测页删掉：列表归零、会话收掉、墙上那一格清空 -------------------
  const remove = await layout('/monitor', ('(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = {};' +
    'out.rowsBefore = document.querySelectorAll("[data-manual-rtsp-row]").length;' +
    'const remove = document.querySelector("[data-action=manual-rtsp-remove]");' +
    'out.removeButton = !!remove;' +
    'if (remove) { remove.click(); await sleep(1200); }' +
    'out.rowsAfter = document.querySelectorAll("[data-manual-rtsp-row]").length;' +
    'const states = await window.api.cameraLive.state();' +
    'const list = states && states.success ? states.data : [];' +
    'out.sessionsLeft = (list || []).filter((entry) => String(entry.deviceId).startsWith("rtsp:")).length;' +
    'return JSON.stringify(out);' +
    '})()'), 120_000)
  log('manual rtsp ③ : ' + JSON.stringify(remove))

  if (!remove.removeButton) problems.push('管理界面里没有删除按钮')
  if (remove.rowsBefore !== 1) {
    problems.push('删除之前列表里不是 1 条：' + remove.rowsBefore)
  }
  if (remove.rowsAfter !== 0) {
    problems.push('删掉之后列表里还剩 ' + remove.rowsAfter + ' 条')
  }
  if (remove.sessionsLeft !== 0) {
    problems.push('删掉之后主进程里还留着 ' + remove.sessionsLeft + ' 路手填会话')
  }

  // ---- ④ 画面墙上不该再留着它（离开那一页时会话已经被收掉，格子也该干净） --------
  const cleared = await layout('/', ('(async () => {' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'return JSON.stringify({' +
    '  cellsWithSource: [...document.querySelectorAll(".camera-wall__cell")]' +
    '    .filter((node) => text(node).includes(__NAME__)).length' +
    '})' +
    '})()').replace(/__NAME__/g, JSON.stringify(probeName)), 60_000)
  log('manual rtsp ④ : ' + JSON.stringify(cleared))
  if (cleared.cellsWithSource !== 0) {
    problems.push('删掉之后画面墙上还留着 ' + cleared.cellsWithSource + ' 格手填源')
  }
}

/**
 * 视频墙的四种视图（业主 2026-09-18 第 10 批第 2 条）。
 *
 * WHY THIS DRILL
 * 现场那台相机是**离线**的，所以这里验不到"图画得对不对"（那由
 * `tests/camera-cell-views.test.ts` 用已知输入逐条断言）。这里验的是**界面上那四颗按钮
 * 与"画什么"真的连在一起**：
 *   1. 一台相机占的那一格有四颗视图按钮（播放 / 1 秒时域图 / 频域图 / 时频谱图）；
 *   2. 点"频域图"之后那一格渲染的是**图**（`[data-cell-chart]`），`<video>` 不在；
 *   3. 没有数据时图上有一句「等待数据…」（离线相机收不到任何一帧，这句必须出现 ——
 *      一张空画布与"设备还没推上来"看起来一模一样）；
 *   4. 点回"播放"之后图消失（这一格回到画面那一条路）；
 *   5. 手填 RTSP 那一格**只有一颗**视图按钮，而且它的说明写着「第三方 RTSP 源只有画面」。
 *
 * 因为它会往墙上放一台相机（写），所以与其余写探针一样排在最后。
 */
async function runCameraViewDrill(win, layout) {
  const drill = await layout('/', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const emptyCells = () => document.querySelectorAll(".camera-wall__cell--empty").length;' +
    'const out = {};' +
    'out.emptyBefore = emptyCells();' +
    // 找一台声学相机。
    'const listed = await window.api.devices.list();' +
    'const cameras = (listed && listed.success ? listed.data : []).filter((d) => d.kind === "acousticCamera");' +
    'out.cameraCount = cameras.length;' +
    'if (cameras.length === 0) return JSON.stringify(Object.assign(out, { reason: "no-camera" }));' +
    'const findCell = (name) => [...document.querySelectorAll(".camera-wall__cell")]' +
    '  .find((node) => (node.textContent || "").includes(name));' +
    /*
     * 先看这一格**是不是已经在墙上**：总览页的「默认开启视频流」会把相机自动放进一格
     * （第 10 批第 1 条），所以多数时候它已经在那儿了 —— 这时选择器里反而**没有**它
     * （已经占着的那台不在候选项里，见 `optionsForCell()`）。第一版探针就栽在这里：
     * 去找候选项，找不到相机，于是整段探针没法开始。
     */
    'let cell = findCell(cameras[0].name);' +
    'out.placedByAutoPlay = !!cell;' +
    'if (!cell) {' +
    '  const emptyCell = document.querySelector(".camera-wall__cell--empty");' +
    '  if (!emptyCell) return JSON.stringify(Object.assign(out, { reason: "no-empty-cell" }));' +
    '  const add = emptyCell.querySelector(".camera-wall__add");' +
    '  if (!add) return JSON.stringify(Object.assign(out, { reason: "no-add-button" }));' +
    '  add.click();' +
    '  await sleep(600);' +
    '  const item = document.querySelector("[data-camera-picker-item][data-device-id=\\"" + cameras[0].id + "\\"]");' +
    '  out.pickerHasCamera = !!item;' +
    '  if (!item) return JSON.stringify(Object.assign(out, { reason: "picker-missing-camera" }));' +
    '  item.click();' +
    '  await sleep(900);' +
    '  cell = findCell(cameras[0].name);' +
    '}' +
    'out.cellFound = !!cell;' +
    'if (!cell) return JSON.stringify(Object.assign(out, { reason: "cell-not-placed" }));' +
    /*
     * 第 12 批：控制条上**只有六颗播放器控件**（相机这一格六颗都在），而且四颗视图按钮
     * **不在控制条上**了 —— 它们搬进了右键菜单的「显示方式」。这一趟把两件事都量了。
     */
    'const barActions = () => [...cell.querySelectorAll("[data-action^=cell-]")]' +
    '  .map((b) => b.getAttribute("data-action"));' +
    'out.barActions = barActions();' +
    'out.viewButtonsOnBar = cell.querySelectorAll("[data-action^=cell-view-]").length;' +
    /*
     * 逐个切那三张图：**每次都要重新右键**（菜单在派发之后自己关掉）。
     * 菜单里的稳定钩子是 `data-action`（一级项与二级项都有，见 `VideoContextMenu`）。
     */
    'const openDisplay = async () => {' +
    '  const rect = cell.getBoundingClientRect();' +
    '  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,' +
    '    clientX: Math.round(rect.left + 24), clientY: Math.round(rect.top + 24) }));' +
    '  await sleep(500);' +
    '  const parent = document.querySelector(".vmenu [data-action=display]");' +
    '  if (!parent) return null;' +
    '  parent.click();' +
    '  await sleep(400);' +
    '  return document.querySelector(".vmenu__submenu");' +
    '};' +
    'out.perMode = {};' +
    'for (const mode of ["timedomain", "spectrum", "spectrogram"]) {' +
    '  const submenu = await openDisplay();' +
    '  if (!submenu) { out.perMode[mode] = "no-display-menu"; continue; }' +
    '  if (mode === "timedomain") {' +
    '    out.viewItems = [...submenu.querySelectorAll("[data-action^=view-]")].map((b) => ({' +
    '      action: b.getAttribute("data-action"),' +
    '      disabled: b.getAttribute("aria-disabled"),' +
    '      checked: b.getAttribute("aria-checked") }));' +
    '  }' +
    '  const button = submenu.querySelector("[data-action=view-" + mode + "]");' +
    '  if (!button || button.getAttribute("aria-disabled") === "true") {' +
    '    out.perMode[mode] = "no-button"; continue; }' +
    '  button.click();' +
    '  await sleep(700);' +
    '  const chart = cell.querySelector("[data-cell-chart]");' +
    '  out.perMode[mode] = {' +
    '    chart: chart ? chart.getAttribute("data-cell-chart") : null,' +
    '    empty: !!cell.querySelector("[data-cell-chart-empty]"),' +
    '    video: !!cell.querySelector("video"),' +
    '    axis: text(cell.querySelector("[data-cell-chart-axis]")),' +
    '    note: text(cell.querySelector("[data-cell-chart-note]"))' +
    '  };' +
    '}' +
    // 回到播放（同样走菜单）：图应当消失（这一格回到画面那一条路）。
    'const backToPlay = await openDisplay();' +
    'const playItem = backToPlay ? backToPlay.querySelector("[data-action=view-play]") : null;' +
    'if (playItem) { playItem.click(); await sleep(700); }' +
    'out.chartAfterPlay = !!cell.querySelector("[data-cell-chart]");' +
    /*
     * ✓ 要**重新开一次菜单**再读：点完那一项菜单就关掉了，手里那个元素是**上一次渲染**的
     * 快照（第一版就是读它，读到的是切换之前的状态 —— `aria-checked: "false"`）。
     */
    'const verify = await openDisplay();' +
    'const verifiedPlay = verify ? verify.querySelector("[data-action=view-play]") : null;' +
    'out.playChecked = verifiedPlay ? verifiedPlay.getAttribute("aria-checked") : null;' +
    'if (verify) {' +
    '  const rect = cell.getBoundingClientRect();' +
    '  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true,' +
    '    clientX: Math.round(rect.left + 4), clientY: Math.round(rect.top + 4) }));' +
    '  await sleep(250);' +
    '}' +
    'out.menuClosed = !document.querySelector(".vmenu");' +
    'return JSON.stringify(out);' +
    '})()', 120_000)
  log('camera views  : ' + JSON.stringify(drill))

  if (drill.reason === 'no-camera') {
    log('camera views  : 这一份数据里没有声学相机，跳过（如实说明，不当成通过）')
    return
  }
  if (drill.reason) {
    problems.push('四种视图探针没法开始：' + drill.reason)
    return
  }

  // 第 12 批：控制条上就是业主给的那六颗，一颗不多一颗不少。
  const expectedBar = [
    'cell-alarm',
    'cell-fullscreen',
    'cell-play',
    'cell-playback',
    'cell-volume',
    'cell-record'
  ]
  if (JSON.stringify(drill.barActions) !== JSON.stringify(expectedBar)) {
    problems.push(
      '相机那一格的控制条不是业主第 12 批给的那六颗：' + JSON.stringify(drill.barActions)
    )
  }
  if (drill.viewButtonsOnBar !== 0) {
    problems.push('控制条上还留着 ' + drill.viewButtonsOnBar + ' 颗视图按钮（第 12 批已移进菜单）')
  }
  // 显示方式那四项都在菜单里，而且"播放"是当前值。
  if (!Array.isArray(drill.viewItems) || drill.viewItems.length !== 4) {
    problems.push('右键菜单的「显示方式」里不是四项：' + JSON.stringify(drill.viewItems))
  } else {
    const checked = drill.viewItems.filter((item) => item.checked === 'true')
    if (checked.length !== 1 || checked[0].action !== 'view-play') {
      problems.push('「显示方式」里的 ✓ 不在"播放"上：' + JSON.stringify(drill.viewItems))
    }
  }
  for (const mode of ['timedomain', 'spectrum', 'spectrogram']) {
    const state = drill.perMode?.[mode]
    if (!state || state === 'no-button') {
      problems.push('点不到「' + mode + '」那颗视图按钮')
      continue
    }
    if (state.chart !== mode) {
      problems.push('点了「' + mode + '」之后那一格画的不是这张图：' + JSON.stringify(state.chart))
    }
    if (state.video) {
      problems.push('点了「' + mode + '」之后那一格里还留着 <video>（两种画法同时在）')
    }
    if (!state.empty) {
      problems.push('「' + mode + '」在没有数据时没有说「等待数据…」')
    }
    if (mode === 'spectrogram' && !String(state.note || '').includes('相对强弱')) {
      problems.push('时频谱图没有写清"颜色只表示相对强弱"：' + JSON.stringify(state.note))
    }
    /*
     * 轴只在**频域**那两张图上：时域图的横轴是时间（没有可标的"第 N 根谱线"），
     * 所以它那一格**不该**有轴 —— 第一版探针把"没有轴"当成问题报了，错的是探针。
     */
    if (mode === 'timedomain') {
      if (state.axis !== '') problems.push('时域图不该有频率轴：' + JSON.stringify(state.axis))
    } else if (state.axis === '') {
      problems.push('「' + mode + '」没有频率轴（哪怕只是"第 N 根谱线"）')
    }
  }
  if (drill.chartAfterPlay) problems.push('切回「播放」之后那一格还在画图')
  if (drill.playChecked !== 'true') {
    problems.push('切回「播放」之后菜单里的 ✓ 不在"播放"上：' + JSON.stringify(drill.playChecked))
  }
  if (drill.menuClosed !== true) {
    problems.push('点外面之后右键菜单没有关掉')
  }
}

async function run() {
  await sleep(3500) // let the app create its window and finish loading
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    log('FATAL: the app never created a BrowserWindow')
    app.exit(1)
    return
  }

  log('window title : ' + JSON.stringify(win.getTitle()))
  log('visible      : ' + win.isVisible())
  log('url          : ' + win.webContents.getURL())

  /**
   * Sign in before touching the UI.
   *
   * The shell is gated behind an application account, and the factory
   * administrator must replace its password on first use. This demo runs against
   * its own throwaway profile, so it walks the real two-step flow — which also
   * makes the screenshots below show a signed-in application rather than a login
   * form. The session lives in the MAIN process, so it survives the reloads the
   * language probe performs later.
   *
   * NOTE: no backticks and no dollar-brace interpolation in this string. The whole
   * driver is itself a template literal in the parent script, so either would
   * terminate it early — which is exactly how this broke the first time. The code
   * below is therefore built by string concatenation.
   */
  const signIn = await win.webContents.executeJavaScript(
    '(async () => { try {' +
    "  const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
    "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
    '  if (login.data.mustChangePassword) {' +
    '    const changed = await window.api.auth.changePassword({' +
    "      currentPassword: 'Hz@123456'," +
    "      newPassword: 'demo-shot-pass'" +
    '    });' +
    "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
    "    return JSON.stringify({ step: 'changed' });" +
    '  }' +
    "  return JSON.stringify({ step: 'already-signed-in' });" +
    '} catch (error) {' +
    "  return JSON.stringify({ step: 'threw', message: String(error && error.message) });" +
    '} })()'
  )
  log('sign in      : ' + signIn)
  const signInStep = JSON.parse(signIn).step
  if (signInStep !== 'changed' && signInStep !== 'already-signed-in') {
    problems.push('could not sign in: ' + signIn)
  }

  // Give Vue a tick to mount the shell in response to the session change.
  await sleep(600)

  const mounted = await win.webContents.executeJavaScript(
    'document.querySelector(".app-shell") ? "app-shell-present" : "app-shell-MISSING"'
  )
  log('vue mount    : ' + mounted)
  if (mounted !== 'app-shell-present') problems.push('vue-not-mounted')

  const bridge = await win.webContents.executeJavaScript(
    'JSON.stringify({api: typeof window.api, events: typeof window.events, genericInvoke: typeof (window.api && window.api.invoke)})'
  )
  log('preload bridge: ' + bridge)

  /**
   * Brand-mark probe.
   *
   * This used to measure the rendered width of the sidebar wordmark ("Acoustic Box
   * Manager") to catch a glyph-painting fault. That wordmark was removed by product
   * request — the brand mark is now the LOGO ALONE — so measuring text here would
   * measure nothing.
   *
   * The risk that replaces it is a broken brand mark: the logo is a bundled PNG, and
   * an image that fails to load renders as an invisible (or broken) element with no
   * console error and no layout complaint. A naturalWidth of 0 is the honest test
   * for "the bitmap actually decoded", which the complete flag alone does not prove.
   */
  const brand = await win.webContents.executeJavaScript('(() => {' +
    'const el = document.querySelector(".sidebar__logo");' +
    'if (!el) return JSON.stringify({found: false});' +
    'const box = el.getBoundingClientRect();' +
    'return JSON.stringify({' +
    '  found: true,' +
    '  complete: el.complete,' +
    '  naturalWidth: el.naturalWidth,' +
    '  naturalHeight: el.naturalHeight,' +
    '  renderedWidth: Math.round(box.width),' +
    '  renderedHeight: Math.round(box.height),' +
    '  alt: el.getAttribute("alt"),' +
    '  wordmarkPresent: !!document.querySelector(".sidebar__brand-name, .sidebar__brand-sub")' +
    '});' +
    '})()')
  log('brand probe  : ' + brand)
  {
    const state = JSON.parse(brand)
    if (!state.found) problems.push('侧栏品牌标识不存在')
    else {
      if (!state.complete || !(state.naturalWidth > 0)) {
        problems.push('侧栏 logo 没有真正解码（naturalWidth=' + state.naturalWidth + '）')
      }
      if (!(state.renderedWidth > 0 && state.renderedHeight > 0)) {
        problems.push('侧栏 logo 渲染尺寸为 0')
      }
      // The product removed the wordmark, so its return is a regression, not a nicety.
      if (state.wordmarkPresent) problems.push('侧栏又出现了文字品牌名（产品要求只保留 logo）')
    }
  }

  /**
   * 侧栏的折叠（业主 2026-09-18 第 4 条）：按钮在「协议实验室」**下方**，收起后 logo 变圆形。
   *
   * 三件都要量，因为三件都能"看起来做了"而屏幕上不成立：
   *   1. **位置**：按钮必须在导航列里、且在**最后一个**导航项之后 —— 用 `compareDocumentPosition`
   *      按 DOM 顺序判，而不是按源码里的行号；
   *   2. **收起的可见后果**：宽度真的变成 `--sidebar-collapsed`（64）；
   *   3. **圆形 logo**：收起后 logo 的盒子是正方形且 `border-radius` 解析成 50%（浏览器算过的值，
   *      不是我们写进 CSS 的那一行）。
   *
   * 跑完**恢复展开**：后面的探针（尤其版面几何那几条）都假设侧栏是展开态。
   */
  const sidebarToggle = JSON.parse(
    await win.webContents.executeJavaScript('(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const sidebar = document.querySelector(".sidebar");' +
    'const toggle = document.querySelector("[data-action=sidebar-toggle]");' +
    'if (!sidebar || !toggle) return JSON.stringify({ found: false });' +
    'const nav = sidebar.querySelector(".sidebar__nav");' +
    'const items = Array.prototype.slice.call(sidebar.querySelectorAll(".sidebar__nav a.nav-item"));' +
    'const last = items[items.length - 1] || null;' +
    'const widthOf = () => Math.round(sidebar.getBoundingClientRect().width);' +
    'const logo = () => document.querySelector(".sidebar__logo");' +
    'const styleOf = (el) => {' +
    '  if (!el) return null;' +
    '  const s = getComputedStyle(el);' +
    '  const r = el.getBoundingClientRect();' +
    '  return {' +
    '    width: Math.round(r.width), height: Math.round(r.height),' +
    '    radius: s.borderTopLeftRadius, background: s.backgroundColor' +
    '  };' +
    '};' +
    /*
     * 侧栏的**顺序**（业主 2026-09-18 第 10 批第 12 条：「地图信息（GIS）」移到设备管理上方、
     * 总览下方）。判据用路径而不是文字：路径与语言无关，而且这正是路由与侧栏两份清单
     * 必须一致的那一件事。
     *
     * `href` 带 hash（路由是 hash 模式，`#/map`），所以这里**去掉那个 `#`** —— 第一次跑
     * 就是因为拿着 `#/` 去比 `/` 而误报了两条"问题"（界面其实是对的）。
     */
    'const navPathOf = (a) => ((a.getAttribute("href") || "").replace(/^#/, "") || "/");' +
    'const out = {' +
    '  found: true,' +
    '  inNav: !!(nav && nav.contains(toggle)),' +
    '  afterLastNavItem: !!(last && (last.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),' +
    '  lastNavLabel: last ? (last.textContent || "").trim() : "",' +
    '  navPaths: items.map(navPathOf),' +
    '  navLabels: items.map((a) => (a.textContent || "").trim()),' +
    '  expandedWidth: widthOf(),' +
    '  expandedLogo: styleOf(logo()),' +
    '  expandedLabel: toggle.getAttribute("aria-label"),' +
    '  expanded: toggle.getAttribute("aria-expanded")' +
    '};' +
    'toggle.click();' +
    'await sleep(600);' +
    'out.collapsedWidth = widthOf();' +
    'out.collapsed = toggle.getAttribute("aria-expanded");' +
    'out.collapsedLabel = toggle.getAttribute("aria-label");' +
    'out.collapsedLogo = styleOf(logo());' +
    'out.collapsedNavHidden = !!document.querySelector(".sidebar--collapsed .nav-item__label");' +
    'toggle.click();' +
    'await sleep(600);' +
    'out.restoredWidth = widthOf();' +
    'out.restoredExpanded = toggle.getAttribute("aria-expanded");' +
    'return JSON.stringify(out);' +
    '})()')
  )
  log('sidebar toggle: ' + JSON.stringify(sidebarToggle))
  if (!sidebarToggle.found) {
    problems.push('找不到侧栏的折叠按钮（[data-action=sidebar-toggle]）')
  } else {
    if (!sidebarToggle.inNav) {
      problems.push('折叠按钮不在导航列里（业主第 4 条：放在协议实验室下方）')
    }
    if (!sidebarToggle.afterLastNavItem) {
      problems.push(
        '折叠按钮不在最后一个导航项之后（最后一项是「' + sidebarToggle.lastNavLabel + '」）'
      )
    }
    if (sidebarToggle.collapsed !== 'false') {
      problems.push('点了折叠按钮之后 aria-expanded 不是 false：' + JSON.stringify(sidebarToggle.collapsed))
    }
    if (!(sidebarToggle.collapsedWidth < sidebarToggle.expandedWidth)) {
      problems.push(
        '折叠之后侧栏没有变窄：' + sidebarToggle.expandedWidth + ' → ' + sidebarToggle.collapsedWidth
      )
    }
    if (sidebarToggle.restoredExpanded !== 'true' || sidebarToggle.restoredWidth !== sidebarToggle.expandedWidth) {
      problems.push(
        '再点一次没有恢复展开：' + JSON.stringify({
          width: sidebarToggle.restoredWidth,
          expanded: sidebarToggle.restoredExpanded,
          want: sidebarToggle.expandedWidth
        })
      )
    }
    // 收起后 logo 是**圆**：正方形盒子 + 解析出来的 50% 圆角。
    const collapsedLogo = sidebarToggle.collapsedLogo
    const expandedLogo = sidebarToggle.expandedLogo
    if (!collapsedLogo) {
      problems.push('收起之后 logo 元素不见了（第 4 条要求它变成圆形显示，不是消失）')
    } else {
      if (collapsedLogo.width !== collapsedLogo.height) {
        problems.push(
          '收起之后的 logo 不是正方形（' + collapsedLogo.width + '×' + collapsedLogo.height + '），圆形谈不上'
        )
      }
      if (!/50%|9999px/.test(String(collapsedLogo.radius))) {
        problems.push('收起之后的 logo 圆角不是 50%：' + JSON.stringify(collapsedLogo.radius))
      }
      if (expandedLogo && expandedLogo.radius === collapsedLogo.radius) {
        problems.push('展开与收起时 logo 的圆角一样 —— 圆形那条规则没有按折叠状态切换')
      }
    }
    /*
     * 第 12 条：导航顺序必须是「总览 → 地图信息（GIS） → 设备管理 → …」。
     *
     * 拿**路径**比而不是文字：路径与语言无关，而且"两份清单顺序一致"这件事正是要守的。
     * 只断言前三项而不是整串：后面的项没被这一条要求动过，钉死整串会让以后任何一次
     * 新增页面都要改这条断言（那时它会变成噪声）。
     */
    const navPaths = sidebarToggle.navPaths || []
    const wantHead = ['/', '/map', '/devices']
    if (navPaths.slice(0, wantHead.length).join(',') !== wantHead.join(',')) {
      problems.push(
        '侧栏前三项不是"总览 → 地图信息（GIS） → 设备管理"（第 12 条）：' +
        JSON.stringify(navPaths.slice(0, 4)) + ' 标签 ' +
        JSON.stringify((sidebarToggle.navLabels || []).slice(0, 4))
      )
    }
    // 地图那一项的名字必须**不含**括号里的 GIS（业主 2026-09-19 更正第 1 条推翻了第 12 条）。
    const mapIndex = navPaths.indexOf('/map')
    const mapLabel = mapIndex >= 0 ? (sidebarToggle.navLabels || [])[mapIndex] : ''
    if (/GIS|（|\(/.test(String(mapLabel))) {
      problems.push('侧栏里地图那一项还带着括号 / GIS：「' + mapLabel + '」（更正第 1 条要求去掉）')
    }
    if (String(mapLabel).trim() === '') {
      problems.push('侧栏里地图那一项没有名字')
    }
  }

  const list = ONLY ? ROUTES.filter((r) => r[1] === ONLY) : ROUTES
  for (const [name, route] of list) {
    // Hash history is what the router uses, so navigate by hash and let the
    // router react — pushing a history state would not notify it.
    await win.webContents.executeJavaScript(
      'location.hash = ' + JSON.stringify('#' + route) + '; true'
    )
    await sleep(1400)
    await shoot(win, name)
  }

  /**
   * Layout regression checks (product request, one round of UI changes).
   *
   * Four things were MOVED, and every one of them can be "done" in the source and
   * still wrong on screen: a component that is imported but not rendered, a tree
   * that is moved in the template but keeps its old sidebar styling, a footer that
   * is rendered inside the scroll container and therefore scrolls away.
   *
   * So each check is a DOM fact read from the running window, and each one is
   * phrased as the product phrased it:
   *   1. 设备拓扑 belongs INSIDE 设备管理 content    -> on /devices, and not in the sidebar
   *   2. the language picker belongs in 系统设置     -> on /settings
   *   3. version + copyright belong in a page footer -> present, and pinned to the bottom
   *   4. the sidebar keeps the logo and drops the wordmark
   *   5. 页脚不要邮箱、整条内容居中、公司网站链接还能用（这一轮新增，见下面
   *      footerEmailInText / footerCenterOffsetPx / openExternal 那三段断言）
   */
  /**
   * 跑一段页面脚本并把结果解析成对象，**带超时**。
   *
   * 为什么需要超时（2026-09-17 踩到）：`executeJavaScript` 等的是那段脚本自己
   * `resolve()`。脚本里同步抛异常（Vue 的处理器在 `dispatchEvent` 里抛）、或者某个
   * `new Promise` 的 `resolve` 分支被跳过时，这个 Promise **永远不会 settle** ——
   * 探针的表现是**挂住**（实测挂了一个多小时，log 停在上一行），而不是报一条失败。
   * 一次自动化验证挂在那里，比一条红断言糟糕得多：没有人知道它卡在哪一步。
   *
   * 超时之后返回一个**带 `probeTimeout` 标记的对象**，调用方照常走它的断言路径
   * （缺字段就是缺字段），于是"哪一条探针卡住了"会出现在 problems 里。
   *
   * 超时可以按调用点放宽（第三参数）：**浏览器里真的点完一整条链**的那种探针
   * （加设备 → 进详情 → 保存 → 去点位图 → 同步 → 取抓图）光是显式 `wait` 就有 15 秒以上，
   * 30 秒在机器忙的时候会误报超时 —— 而"误报超时"与"真的挂住"在报告里长得一样。
   *
   * 默认值从 30 秒提到 **60 秒**（2026-09-18 实测）：那台机器上有一个**不是本项目**的
   * node 进程常驻吃 CPU，同一次运行里 `/devices` 一页 30 秒都渲染不出来，于是设备表、
   * 事件中心、听诊盒子三条探针全是"超时"—— 报告里 12 条问题**没有一条是内容断言**。
   * 放宽默认值不会掩盖真缺陷（真挂住时仍会报超时），但能少报一堆假失败。
   */
  /**
   * 页面**渲染好了**没有：`.app-content` 里出现了这一页的根节点（`.page`）。
   *
   * 这是 2026-09-18 加的一道等待。原来这里只有一句 `await sleep(1200)`，而实测这台机器上
   * **有一个不是本项目的 node 进程常驻吃 CPU**（任务管理器里一个跑了两天的 `node`，
   * 累计 CPU 3600 秒以上）。那种负载下 1200ms 经常不够：同一批探针里
   * 「实时监测的设备下拉没有被投到顶栏那一格里」「量不到趋势卡片」「设备表里找不到可双击的
   * IP 按钮」全是**同一次运行**里的三条 —— 而它们各自在别的运行里都通过。
   *
   * 判据刻意选"根节点出现了"而不是"文字出现了"：一句加载中的文字也会让 `textContent`
   * 非空，那等于什么都没等。等待有上限（`LAYOUT_SETTLE_MAX_MS`），到点就照常往下走 ——
   * 于是"页面根本没渲染"仍然会被那条内容断言抓住，而不是把整次运行挂在这里。
   *
   * ⚠ 2026-09-20（第 32 轮）补的那一层：**这一句 `executeJavaScript` 自己也要有上限**。
   * 第 32 轮把趋势页拆成五支之后定位到：点「自定义」时间范围会让**渲染进程的 JS 线程**
   * 彻底不响应（主进程还在打健康检查日志），于是 `executeJavaScript` 的 Promise
   * **永远不 settle** —— 上面那个 `Date.now() >= deadline` 根本轮不到执行，
   * 整支探针连"超时"都报不出来，就这么停在那里（第 32 轮那次跑就是这样停住的）。
   * 套上 5 秒的上限之后，"渲染进程不响应"会变成一次**有界的**失败：
   * 循环照常走到 deadline、返回 false、`layout()` 推一条问题，后面的页继续跑。
   */
  const LAYOUT_SETTLE_MAX_MS = 20_000
  const LAYOUT_SETTLE_STEP_MS = 250
  /** 单次"问一下页面"的上限：超过了就认为渲染进程这一轮不响应。 */
  const LAYOUT_PING_TIMEOUT_MS = 5_000

  /**
   * **每一次 `executeJavaScript` 都必须有上限**（第 33 轮补的那一层）。
   *
   * 为什么：渲染进程卡死时这些 Promise **永远不 settle**，而只要有一处漏了上限，
   * 整支探针就停在那里 —— 连"超时"都报不出来（第 33 轮 `probe-round37.log` 就是这样：
   * 趋势页第一支超时之后，driver 停在 `layout()` 里那句**设 hash** 的 `executeJavaScript` 上，
   * 之后再没有任何输出）。超时就返回 `null`，调用方自己决定怎么说。
   */
  const pageEval = async (script, timeoutMs = LAYOUT_PING_TIMEOUT_MS) =>
    Promise.race([
      win.webContents.executeJavaScript(script).then(
        (value) => value,
        (error) => ({ __error: String(error && error.message) })
      ),
      sleep(timeoutMs).then(() => null)
    ])

  const waitForPageRoot = async () => {
    const deadline = Date.now() + LAYOUT_SETTLE_MAX_MS
    for (;;) {
      const present = await pageEval(
        '!!document.querySelector(".app-content .page, .app-content .login, .app-content [data-route-root]")',
        LAYOUT_PING_TIMEOUT_MS
      )
      if (present === true) return true
      if (present === null) {
        log('layout ping : 渲染进程 ' + LAYOUT_PING_TIMEOUT_MS + 'ms 没有应答')
      }
      if (Date.now() >= deadline) return false
      await sleep(LAYOUT_SETTLE_STEP_MS)
    }
  }

  const layout = async (route, script, timeoutMs = 60_000) => {
    /*
     * ⚠ 这一句**必须**走 `pageEval()`（有上限）。第 33 轮实测：渲染进程卡死之后，
     * `layout()` 就停在这句设 hash 的 `executeJavaScript` 上，整支探针再也没有任何输出 ——
     * 后面那些"超时"日志一条都到不了，看起来像"driver 自己挂了"。
     */
    const navigated = await pageEval(
      'location.hash = ' + JSON.stringify('#' + route) + '; true',
      LAYOUT_PING_TIMEOUT_MS
    )
    if (navigated === null) {
      log('layout ' + route.padEnd(9) + ': 切路由就没有应答（渲染进程不响应）')
    }
    const rooted = await waitForPageRoot()
    if (!rooted) {
      log('layout ' + route.padEnd(9) + ': NO PAGE ROOT after ' + LAYOUT_SETTLE_MAX_MS + 'ms')
    }
    // 根节点出现之后还要再等一次重排：Vue 的 Teleport 内容与图表都在挂载之后才落位。
    await sleep(1200)
    const raw = await Promise.race([
      win.webContents.executeJavaScript(script),
      sleep(timeoutMs).then(() => null)
    ])
    if (raw === null) {
      log('layout ' + route.padEnd(9) + ': TIMEOUT after ' + timeoutMs + 'ms')
      problems.push(route + ' 上这一段探针超时（' + timeoutMs + 'ms 没有返回）—— 页面脚本可能抛了异常或没有 resolve')
      return { probeTimeout: true }
    }
    const state = JSON.parse(raw)
    log('layout ' + route.padEnd(9) + ': ' + JSON.stringify(state))
    return state
  }

  const overview = await layout('/', '(() => {' +
    'const sidebar = document.querySelector(".sidebar");' +
    // 业主 2026-09-18 第 5 条把左侧拓扑树整棵下架了，所以这一条从"树在侧栏里"翻了过来：
    // 现在断言的是**任何地方都不该再有** `.device-tree`（含侧栏与设备管理页）。
    'const trees = document.querySelectorAll(".device-tree").length;' +
    'const footer = document.querySelector(".app-footer");' +
    'const main = document.querySelector(".app-main");' +
    'const box = footer ? footer.getBoundingClientRect() : null;' +
    // 页脚的内容块：把每个可见子元素（版权、分隔点、网站按钮、版本、发布日期）的
    // 盒子取出来，量三件事 ——
    //   1. 整块的中心与页脚容器的中心之差（产品要求「居中对齐」）；
    //   2. 左右两侧的留白之差（居中的另一个读法）；
    //   3. **相邻子元素之间的最大空隙**。这一条是专门用来抓上一轮那种分栏做法的：
    //      左右两半各自贴边时，左右留白仍然相等（都是内边距），所以只看留白差
    //      分辨不出「中间有一大块空白」；相邻空隙会把那个被删掉的
    //      `.app-footer__spacer` 立刻暴露出来（它当时有几百像素宽）。
    'const kids = footer ? Array.prototype.slice.call(footer.querySelectorAll("span, button"))' +
    '  .filter((el) => el.getBoundingClientRect().width > 0) : [];' +
    'const rects = kids.map((el) => el.getBoundingClientRect());' +
    'let maxGap = 0;' +
    'for (let i = 1; i < rects.length; i += 1) {' +
    '  maxGap = Math.max(maxGap, rects[i].left - rects[i - 1].right);' +
    '}' +
    'const blockLeft = rects.length ? Math.min.apply(null, rects.map((r) => r.left)) : null;' +
    'const blockRight = rects.length ? Math.max.apply(null, rects.map((r) => r.right)) : null;' +
    'const text = footer ? footer.textContent.replace(/\\s+/g, " ").trim() : "";' +
    'const link = footer ? footer.querySelector(".app-footer__link") : null;' +
    'return JSON.stringify({' +
    '  treesOnOverview: trees,' +
    '  footerPresent: !!footer,' +
    '  footerIsLastChild: !!(main && footer && main.lastElementChild === footer),' +
    '  footerInsideScroller: !!(footer && footer.closest(".app-content")),' +
    '  footerBottomGap: box ? Math.round(window.innerHeight - box.bottom) : null,' +
    '  footerText: footer ? text : null,' +
    // 邮箱：产品明确要求页脚不再保留邮箱。邮箱在文字里必然带一个 "@"，所以这一条
    // 既能抓住渲染出来的地址，也能抓住一个只留下空的 mailto 按钮的中间状态。
    '  footerEmailInText: /@/.test(text),' +
    '  footerMailtoLinks: footer' +
    '    ? Array.prototype.slice.call(footer.querySelectorAll("[href]"))' +
    '      .filter((el) => (el.getAttribute("href") || "").toLowerCase().indexOf("mailto:") === 0).length' +
    '    : 0,' +
    '  footerSpacer: footer ? !!footer.querySelector(".app-footer__spacer") : false,' +
    '  footerJustify: footer ? getComputedStyle(footer).justifyContent : null,' +
    '  footerCenterOffsetPx: (box && blockLeft !== null && blockRight !== null)' +
    '    ? Math.round((blockLeft + blockRight) / 2 - (box.left + box.right) / 2) : null,' +
    '  footerBlockLeftGapPx: (box && blockLeft !== null) ? Math.round(blockLeft - box.left) : null,' +
    '  footerBlockRightGapPx: (box && blockRight !== null) ? Math.round(box.right - blockRight) : null,' +
    '  footerMaxInternalGapPx: rects.length > 1 ? Math.round(maxGap) : 0,' +
    '  footerChildCount: rects.length,' +
    '  footerLinkText: link ? (link.textContent || "").trim() : null,' +
    '  footerLinkTag: link ? link.tagName.toLowerCase() : null,' +
    /*
     * 第 1 条（业主 2026-09-18 第 10 批：「每次打开总览界面默认开启视频流」）。
     *
     * ⚠️ **这一段量不到那条要求本身**：这条要求的效果是"每次进总览都会去起一次流"，
     * 而探针里那台相机是**离线**的 —— `decideCameraAutoPlay()` 会在 `offline` 这一步
     * 就 skip（那是刻意的：连不上就不去占相机的一条 RTSP 连接），所以起流请求根本不会发出。
     * 这里量的是**能被量到的那一半**：画面墙在、格子有确定的状态词，而不是一个空白页或
     * 一个永远转圈的黑框。要验证"每进一次就起一次"，看主进程日志里
     * `Camera live view requested` 的行数（相机上线后跑两次总览，行数应当 +2）。
     */
    '  wallPresent: !!document.querySelector(".camera-wall"),' +
    '  wallCells: document.querySelectorAll(".camera-wall__cell").length,' +
    '  wallStatusTexts: Array.prototype.slice.call(document.querySelectorAll(".camera-wall__cell"))' +
    '    .map((c) => (c.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40))' +
    '    .filter((t) => t !== "")' +
    '});' +
    '})()')

  if (overview.treesOnOverview > 0) {
    problems.push('总览页出现了设备拓扑（业主 2026-09-18 第 5 条已把整棵树下架）')
  }
  if (!overview.footerPresent) problems.push('页脚不存在')
  if (!overview.footerIsLastChild) problems.push('页脚不是 .app-main 的最后一个子元素')
  if (overview.footerInsideScroller) {
    problems.push('页脚在滚动容器 .app-content 内部，会跟着内容滚走')
  }
  if (overview.footerBottomGap !== null && overview.footerBottomGap > 2) {
    problems.push('页脚没有贴在窗口底部，下方还空 ' + overview.footerBottomGap + 'px')
  }
  /*
   * 第 1 条能被量到的那一半（见探针里那段注释）：总览页必须有画面墙，而且空白格之外
   * 每一格都要有**确定的状态词** —— 一个永远转圈的黑框与"视频未启动"在截图上是两件事，
   * 而后者才是这台离线相机的实情。
   */
  log('overview wall : ' + JSON.stringify({
    present: overview.wallPresent,
    cells: overview.wallCells,
    statuses: overview.wallStatusTexts
  }))
  if (!overview.wallPresent) {
    problems.push('总览页没有实时视频墙（第 1 条要的是"打开总览界面默认开启视频流"）')
  }
  if (overview.wallCells <= 0) {
    problems.push('总览页的画面墙一个格子都没有')
  }
  if ((overview.wallStatusTexts || []).length === 0) {
    problems.push('画面墙上没有任何状态词：空格之外至少要有"未开始/RTSP 未启用"这类确定的事实')
  }

  /**
   * 页脚这一轮的三条断言（产品要求：「不用保留邮箱……居中对齐」）。
   *
   * 全部是量出来的，因为这三条每一条都能在源码里「看起来对」而屏幕上不对：
   * 邮箱可能是主进程数据里带回来的、居中可能被一个 `flex: 1` 的空元素破坏、
   * 网站链接可能还在但点不动。
   */
  log('footer text  : ' + JSON.stringify(overview.footerText))
  log(
    'footer centre: ' + JSON.stringify({
      justify: overview.footerJustify,
      centerOffsetPx: overview.footerCenterOffsetPx,
      leftGapPx: overview.footerBlockLeftGapPx,
      rightGapPx: overview.footerBlockRightGapPx,
      maxInternalGapPx: overview.footerMaxInternalGapPx,
      children: overview.footerChildCount
    })
  )
  if (overview.footerEmailInText || overview.footerMailtoLinks > 0) {
    problems.push(
      '页脚里仍然有邮箱（文字含 @：' + overview.footerEmailInText + '，mailto 链接 ' +
      overview.footerMailtoLinks + ' 个）：' + JSON.stringify(overview.footerText)
    )
  }
  if (overview.footerSpacer) problems.push('页脚又出现了 .app-footer__spacer（它会把内容重新分成左右两半）')
  if (overview.footerJustify !== 'center') {
    problems.push('页脚的计算样式 justify-content 是 ' + overview.footerJustify + '，不是 center')
  }
  if (overview.footerCenterOffsetPx !== null && Math.abs(overview.footerCenterOffsetPx) > 2) {
    problems.push('页脚内容块没有居中：中心偏离容器中心 ' + overview.footerCenterOffsetPx + 'px')
  }
  if (
    overview.footerBlockLeftGapPx !== null &&
    overview.footerBlockRightGapPx !== null &&
    Math.abs(overview.footerBlockLeftGapPx - overview.footerBlockRightGapPx) > 2
  ) {
    problems.push(
      '页脚左右留白不相等（左 ' + overview.footerBlockLeftGapPx + 'px / 右 ' +
      overview.footerBlockRightGapPx + 'px）'
    )
  }
  if (overview.footerMaxInternalGapPx > 24) {
    problems.push(
      '页脚内容中间有 ' + overview.footerMaxInternalGapPx + 'px 的空隙：内容又被推成左右两半了'
    )
  }
  if (!overview.footerLinkText) {
    problems.push('页脚里没有公司网站链接')
  }

  /**
   * 网站链接必须**真的还能用**，而不只是还在。
   *
   * 点它就是一次 `app:open-external` IPC，主进程最终会调 `shell.openExternal`。
   * 探针在**主进程里**把那个调用录下来再放行（返回值照原样给一个已完成的 Promise），
   * 所以这里得到的是端到端的证据，而不是「按钮存在」这种读 DOM 就能拿到的弱结论；
   * 同时它也不会真的把系统浏览器打开一个外部网页。
   */
  const footerLink = await layout('/', '(() => {' +
    'const btn = document.querySelector(".app-footer__link");' +
    'if (!btn) return JSON.stringify({ found: false });' +
    'const text = (btn.textContent || "").trim();' +
    'btn.click();' +
    'return JSON.stringify({ found: true, text: text, tag: btn.tagName.toLowerCase() });' +
    '})()')
  await sleep(900)
  const openExternalUrls = openExternalCalls.slice()
  log(
    'footer link  : ' + JSON.stringify({
      click: footerLink,
      stubInstalled: openExternalStubInstalled,
      opened: openExternalUrls
    })
  )
  if (!footerLink.found) {
    problems.push('页脚里的公司网站链接不存在')
  } else if (
    !openExternalUrls.some(
      (url) => String(url).replace(/^https?:\/\//, '') === footerLink.text
    )
  ) {
    problems.push(
      '点击页脚的网站链接没有发起打开请求（链接文字 ' + JSON.stringify(footerLink.text) +
      '，主进程收到 ' + JSON.stringify(openExternalUrls) + '，拦截器是否生效 ' +
      openExternalStubInstalled + '）'
    )
  }

  /**
   * 设备管理页：**单列**（拓扑树已下架）、左上间距与总览一致、删掉的两句话真的不在、
   * 十列放得下、没有横向溢出、没有被裁掉的控件。
   *
   * WHY THIS IS ONE PROBE AND NOT SEVERAL
   * 这一轮的产品要求是几句话：第 5 条「移除左侧拓扑树」+ 第 2b 条「扁平化，去掉卡片」。
   * 它们说的是**同一帧屏幕**：分开量会得到不同时刻的 DOM，而「表是单列但页面横向溢出了」
   * 这种组合恰恰是要一起看的。
   *
   * 间距量的是**内容盒**（`.app-content` 的 padding 之内、滚动条之外）到设备表外框的
   * 距离。`.page` 与总览页是同一个流式列（`assets/main.css` 的 `.page` 没有 max-width
   * 也没有自动外边距），所以两层合起来就是产品说的「和总览的改动后保持一致」。
   *
   * 第 5 条之后「树不在这一页」是**反面断言** —— `.device-tree` 一个都不许有。这条比原来的
   * 「树在左列」更容易被下一次改动悄悄破坏：加回一棵树不需要删掉任何断言就"看起来对"。
   *
   * 「删除掉」判的是**渲染出来的元素文字**（`textContent`），不是源码。
   */
  const devicesLayout = await layout('/devices', '(() => {' +
    'const trees = document.querySelectorAll(".device-tree").length;' +
    'const page = document.querySelector(".page");' +
    'const content = document.querySelector(".app-content");' +
    'const shell = document.querySelector(".devices-table-card");' +
    'const table = document.querySelector("table.devices-table");' +
    'const round = (n) => Math.round(n);' +
    'const rectOf = (el) => { const r = el.getBoundingClientRect();' +
    '  return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height), right: round(r.right) }; };' +
    'const visibleText = (el) => {' +
    '  const copy = el.cloneNode(true);' +
    '  Array.prototype.slice.call(copy.querySelectorAll(".visually-hidden"))' +
    '    .forEach((node) => node.parentNode.removeChild(node));' +
    '  return (copy.textContent || "").replace(/\\s+/g, " ").trim();' +
    '};' +
    // 内容盒：padding 之内、纵向滚动条之外。
    'const contentStyle = content ? getComputedStyle(content) : null;' +
    'const contentBox = content ? {' +
    '  left: round(content.getBoundingClientRect().left + (parseFloat(contentStyle.paddingLeft) || 0)),' +
    '  top: round(content.getBoundingClientRect().top + (parseFloat(contentStyle.paddingTop) || 0)),' +
    '  right: round(content.getBoundingClientRect().left + content.clientWidth - (parseFloat(contentStyle.paddingRight) || 0))' +
    '} : null;' +
    // 「设备拓扑」这句标题：它作为**元素文字**必须一处都不剩（`aria-label` 不算）。
    'const removedHeadings = ["\\u8bbe\\u5907\\u62d3\\u6251"];' +
    'const headingHits = Array.prototype.slice.call(document.querySelectorAll("body *"))' +
    '  .filter((el) => removedHeadings.indexOf((el.textContent || "").trim()) >= 0).length;' +
    // 「共 N 台设备，在线 N 台」：按**形状**找（任何语言、任何台数），因为这一行在不同
    // 语言里是不同的一句话，而它在中文目录里的原文才是被删掉的那一句。
    'const countPatterns = [/\\u5171\\s*\\d+\\s*\\u53f0\\u8bbe\\u5907/, /\\d+\\s*devices?,\\s*\\d+\\s*online/i,' +
    '  /\\d+\\s*equipos?,\\s*\\d+\\s*en l\\u00ednea/i, /\\d+\\s*cihaz,\\s*\\d+\\s*tanesi/i];' +
    'const countHits = Array.prototype.slice.call(document.querySelectorAll("body *"))' +
    '  .filter((el) => {' +
    '    if (el.children.length > 0) return false;' +
    '    const text = (el.textContent || "").trim();' +
    '    return countPatterns.some((pattern) => pattern.test(text));' +
    '  }).length;' +
    // 横向溢出：内容区自己的 scrollWidth 与窗口宽都要看。前者是整页级别的证据，后者能
    // 抓住「内容区没溢出但窗口被某个绝对定位元素撑宽」。
    'const overflow = {' +
    '  appContentScrollWidth: content ? content.scrollWidth : null,' +
    '  appContentClientWidth: content ? content.clientWidth : null,' +
    '  bodyScrollWidth: document.body.scrollWidth,' +
    '  docScrollWidth: document.documentElement.scrollWidth,' +
    '  windowInnerWidth: window.innerWidth' +
    '};' +
    // 被裁掉的控件：逐个可交互元素比窗口边界。对话框里的控件不算（它们在自己的浮层里）。
    'const interactive = Array.prototype.slice.call(document.querySelectorAll("button, select, input, [role=tab]"))' +
    '  .filter((el) => {' +
    '    if (el.closest("[role=dialog]")) return false;' +
    '    const r = el.getBoundingClientRect();' +
    '    return r.width > 0 && r.height > 0;' +
    '  });' +
    'const clipped = interactive.filter((el) => {' +
    '  const r = el.getBoundingClientRect();' +
    '  return r.left < -0.5 || r.right > window.innerWidth + 0.5;' +
    '}).map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 24));' +
    'return JSON.stringify({' +
    // 第 5 条：整棵树下架 —— 这一个数必须是 0。
    '  treesOnDevices: trees,' +
    '  cards: document.querySelectorAll(".device-card").length,' +
    '  tableRows: document.querySelectorAll("table.devices-table tbody tr").length,' +
    '  viewport: { w: window.innerWidth, h: window.innerHeight },' +
    '  contentBox: contentBox,' +
    '  page: page ? rectOf(page) : null,' +
    // 单列判定（第 5 条）：设备表是 `.page` 的直接子节点，而且真的占满内容宽度。
    '  shellIsDirectChild: !!(page && shell && shell.parentElement === page),' +
    '  shell: shell ? rectOf(shell) : null,' +
    '  shellRightGapPx: (shell && contentBox) ? round(contentBox.right - shell.getBoundingClientRect().right) : null,' +
    '  table: table ? rectOf(table) : null,' +
    '  tableScrollWidth: table ? table.scrollWidth : null,' +
    '  tableClientWidth: table ? table.clientWidth : null,' +
    '  tableHeadings: table ? Array.prototype.slice.call(table.querySelectorAll("thead th"))' +
    '    .map((th) => (th.textContent || "").trim()) : null,' +
    // 卡片版式的两个类名都不该再出现在这一页上（第 2b 条扁平化）。
    '  legacyCardShell: document.querySelectorAll(".table-wrap").length,' +
    '  headingHits: headingHits,' +
    '  countHits: countHits,' +
    '  overflow: overflow,' +
    '  clipped: clipped,' +
    '  interactiveCount: interactive.length' +
    '});' +
    '})()')

  if (devicesLayout.treesOnDevices > 0) {
    problems.push('设备管理页出现了设备拓扑（第 5 条已把整棵树下架）：' +
      devicesLayout.treesOnDevices + ' 个 .device-tree')
  }
  if (!devicesLayout.shellIsDirectChild) {
    problems.push('设备表不是 .page 的直接子节点（第 5 条之后这一页是单列，没有布局容器）')
  }
  if (devicesLayout.shellRightGapPx === null || devicesLayout.shellRightGapPx > GAP_TOLERANCE_PX) {
    problems.push('设备表没有占满内容宽度：右边空着 ' + devicesLayout.shellRightGapPx +
      'px（单列之后不应该再有第二列）')
  }
  if (devicesLayout.tableScrollWidth > devicesLayout.tableClientWidth + 1) {
    problems.push('设备表放不下这十列：表自身 scrollWidth ' + devicesLayout.tableScrollWidth +
      ' > clientWidth ' + devicesLayout.tableClientWidth)
  }
  if (devicesLayout.tableHeadings && devicesLayout.tableHeadings.length !== 10) {
    problems.push('设备表的表头是 ' + devicesLayout.tableHeadings.length + ' 列，应为 10：' +
      JSON.stringify(devicesLayout.tableHeadings))
  }
  if (devicesLayout.legacyCardShell > 0) {
    problems.push('设备管理页又用回了卡片外壳（.table-wrap）：' + devicesLayout.legacyCardShell + ' 个')
  }
  if (devicesLayout.headingHits > 0) {
    problems.push('设备管理页仍然渲染着 ' + devicesLayout.headingHits + ' 处「设备拓扑」标题')
  }
  if (devicesLayout.countHits > 0) {
    problems.push('设备管理页仍然渲染着 ' + devicesLayout.countHits + ' 处设备/在线计数那一行')
  }
  /*
   * 第 3 条：右侧是**表格**，卡片版式（`.device-card`）连类名都应该没有了 ——
   * 卡片留着会让同一批设备在页面上有两个渲染路径。
   */
  if (devicesLayout.cards > 0) {
    problems.push('设备管理页还有卡片版式的节点（.device-card）：' + devicesLayout.cards + ' 个')
  }
  log('devices shell : ' + JSON.stringify({
    viewport: devicesLayout.viewport,
    contentBox: devicesLayout.contentBox,
    page: devicesLayout.page,
    shell: devicesLayout.shell,
    table: devicesLayout.table,
    columns: devicesLayout.tableHeadings ? devicesLayout.tableHeadings.length : null,
    rightGapPx: devicesLayout.shellRightGapPx
  }))
  {
    /**
     * 「和总览的改动后保持一致」这句话的**精确读法**。
     *
     * 总览页的改动是：`.page` 不再有 `max-width`、不再有自动外边距，它从内容盒的左上角
     * 开始，左/上间距由 `.app-content` 的 `--space-6` 唯一提供。所以「一致」在这里等于
     * 两件事：
     *   1. `.page` 的左上角**就是**内容盒的左上角（两个页面公用同一条 `.page` 规则）；
     *   2. 设备表贴住内容盒的**左右两边**（第 5 条之后是单列，没有左列要留位置）。
     *
     * 表格的上边缘**在**警告条/空状态下面，所以拿表格顶端去比内容盒顶端是错的 —— 正确的
     * 参照物是 `.page` 自己。
     */
    const pageLeftGap = devicesLayout.page && devicesLayout.contentBox
      ? devicesLayout.page.left - devicesLayout.contentBox.left
      : null
    const pageTopGap = devicesLayout.page && devicesLayout.contentBox
      ? devicesLayout.page.top - devicesLayout.contentBox.top
      : null
    const shellLeftGap = devicesLayout.shell && devicesLayout.contentBox
      ? devicesLayout.shell.left - devicesLayout.contentBox.left
      : null
    log('devices gap   : .page left=' + pageLeftGap + 'px top=' + pageTopGap +
      'px; table from the content box left=' + shellLeftGap +
      'px right=' + devicesLayout.shellRightGapPx + 'px (single column)')
    if (pageLeftGap === null || pageLeftGap > GAP_TOLERANCE_PX) {
      problems.push('设备管理页的 .page 没有从内容盒左边开始：' + pageLeftGap + 'px（总览页是 0）')
    }
    if (pageTopGap === null || pageTopGap > GAP_TOLERANCE_PX) {
      problems.push('设备管理页的 .page 没有从内容盒上边开始：' + pageTopGap + 'px（总览页是 0）')
    }
    if (shellLeftGap === null || shellLeftGap > GAP_TOLERANCE_PX) {
      problems.push('设备表没有贴住内容盒左边：左间距 ' + shellLeftGap + 'px（应为 0）')
    }
    const clipped = devicesLayout.clipped || []
    if (clipped.length > 0) {
      problems.push('设备管理页有被窗口裁掉的控件：' + JSON.stringify(clipped))
    }
    const overflow = devicesLayout.overflow || {}
    if (overflow.appContentScrollWidth > overflow.appContentClientWidth + 1) {
      problems.push('设备管理页横向溢出了内容区：scrollWidth ' + overflow.appContentScrollWidth +
        ' > clientWidth ' + overflow.appContentClientWidth)
    }
    if (overflow.bodyScrollWidth > overflow.windowInnerWidth + 1 ||
        overflow.docScrollWidth > overflow.windowInnerWidth + 1) {
      problems.push('设备管理页把窗口撑出了横向滚动条：body ' + overflow.bodyScrollWidth +
        ' / document ' + overflow.docScrollWidth + ' vs window ' + overflow.windowInnerWidth)
    }
    log('devices overflow: ' + JSON.stringify(overflow) + ' clipped=' + JSON.stringify(clipped))
  }

  /**
   * 四档窗口尺寸下 `/devices` 的**单列**几何（业主 2026-09-18 第 5 条把拓扑树下架之后）。
   *
   * 这一段原来是量"树卡片在左列里的位置"。树下架之后，要守的东西变成了它的反面 ——
   * 设备表是内容区里**唯一**一块，所以：
   *   1. 表格的左右两边都要贴住内容盒（左边距与右边距都是 0）。两列布局一旦回来，
   *      右边距会立刻变成一个非 0 的数，这一条就会红；
   *   2. 十列在**每一档**都放得下：表格自己不横向滚动（`scrollWidth <= clientWidth`），
   *      内容区与窗口都不出横向滚动条，而且没有被窗口裁掉的控件。四档里 1280×720 最紧 ——
   *      第 8 条那次十列清单就是在这里被量出来"删除被裁掉"的；
   *   3. `.page` 仍然从内容盒左上角开始（与总览页共用同一条 `.page` 规则），
   *      而且**逐档相同**：间距由 `--space-6` 唯一提供，不按窗口宽度算。
   *
   * 每一档都重新读一次：`win.setContentSize()` 之后必须等一次重排落定，否则量到的是
   * 过渡中的数字。
   */
  const flatGeometry = []
  /** 每档窗口**实际**的内容尺寸（见下面那段说明）。与 `flatGeometry` 同序。 */
  const actualContentSizes = []
  for (const size of TREE_SIZES) {
    win.setContentSize(size[0], size[1])
    await sleep(700)
    /*
     * 先读窗口**实际**的内容尺寸，而不是拿我们请求的那个数字当基准。
     *
     * 这是测量口径的修正（2026-09-16 发现）：断言原来是拿"请求值"去比渲染层的
     * `window.innerWidth`，中间隔着 Windows 的边框与非 100% 的 DPI 缩放 —— 四档一律偏
     * +6 / +17，而**布局本身全都正常**。那说明偏的不是界面，而是"拿什么当基准"：
     * 视口尺寸由窗口决定，不由我们的请求决定。
     */
    const actualContent = win.getContentSize()
    actualContentSizes.push({ w: actualContent[0], h: actualContent[1] })
    const measured = await layout('/devices', '(() => {' +
      'const page = document.querySelector(".page");' +
      'const card = document.querySelector(".devices-table-card");' +
      'const table = document.querySelector("table.devices-table");' +
      'const content = document.querySelector(".app-content");' +
      'if (!page || !card || !table || !content) return JSON.stringify({ found: false,' +
      '  hasPage: !!page, hasCard: !!card, hasTable: !!table, hasContent: !!content });' +
      'content.scrollTop = 0;' +
      'const round = (n) => Math.round(n);' +
      'const contentStyle = getComputedStyle(content);' +
      'const box = {' +
      '  left: content.getBoundingClientRect().left + (parseFloat(contentStyle.paddingLeft) || 0),' +
      '  top: content.getBoundingClientRect().top + (parseFloat(contentStyle.paddingTop) || 0),' +
      '  right: content.getBoundingClientRect().left + content.clientWidth - (parseFloat(contentStyle.paddingRight) || 0)' +
      '};' +
      'const pageRect = page.getBoundingClientRect();' +
      'const cardRect = card.getBoundingClientRect();' +
      'const tableRect = table.getBoundingClientRect();' +
      'const interactive = Array.prototype.slice.call(document.querySelectorAll("button, select, input, [role=tab]"))' +
      '  .filter((el) => {' +
      '    if (el.closest("[role=dialog]")) return false;' +
      '    const r = el.getBoundingClientRect();' +
      '    return r.width > 0 && r.height > 0;' +
      '  });' +
      'const clipped = interactive.filter((el) => {' +
      '  const r = el.getBoundingClientRect();' +
      '  return r.left < -0.5 || r.right > window.innerWidth + 0.5;' +
      '}).map((el) => (el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 24));' +
      'const headers = Array.prototype.slice.call(table.querySelectorAll("thead th"))' +
      '  .map((th) => (th.textContent || "").trim());' +
      'return JSON.stringify({' +
      '  found: true,' +
      '  viewport: { w: window.innerWidth, h: window.innerHeight },' +
      '  contentBox: { left: round(box.left), top: round(box.top), right: round(box.right) },' +
      '  page: { left: round(pageRect.left), top: round(pageRect.top), width: round(pageRect.width) },' +
      '  shell: { left: round(cardRect.left), top: round(cardRect.top),' +
      '    width: round(cardRect.width), right: round(cardRect.right) },' +
      '  table: { left: round(tableRect.left), width: round(tableRect.width), right: round(tableRect.right) },' +
      '  headers: headers,' +
      '  rowCount: table.querySelectorAll("tbody tr").length,' +
      // 单列（第 5 条把拓扑树下架之后，设备表是内容区里唯一一块）：左右都必须贴住内容盒。
      // 两列布局一旦回来，右边距会立刻变成一个非 0 的数。
      '  shellGapFromContentBoxPx: { left: round(cardRect.left - box.left), right: round(box.right - cardRect.right) },' +
      // 十列在每一档都要放得下：表格自身不许横向滚动。
      '  tableScrollWidth: table.scrollWidth,' +
      '  tableClientWidth: table.clientWidth,' +
      '  contentClientWidth: content.clientWidth,' +
      '  contentScrollWidth: content.scrollWidth,' +
      '  windowInnerWidth: window.innerWidth,' +
      '  bodyScrollWidth: document.body.scrollWidth,' +
      '  docScrollWidth: document.documentElement.scrollWidth,' +
      '  clipped: clipped,' +
      '  interactiveCount: interactive.length' +
      '});' +
      '})()')
    flatGeometry.push(measured)
    log('devices ' + size[0] + 'x' + size[1] + ' : ' + JSON.stringify(measured))
  }

  {
    const found = flatGeometry.filter((entry) => entry.found)
    if (found.length !== TREE_SIZES.length) {
      problems.push('设备管理页的单列几何只量到 ' + found.length + ' / ' + TREE_SIZES.length + ' 档：' +
        JSON.stringify(flatGeometry))
    }
    for (let i = 0; i < flatGeometry.length; i += 1) {
      const entry = flatGeometry[i]
      const size = TREE_SIZES[i]
      const actual = actualContentSizes[i]
      if (!entry.found) continue
      /*
       * 判据是「渲染层的视口 == 窗口自己报的内容尺寸」，不是「== 我们请求的数字」。
       * 请求值只用来定位是哪一档；它与实际值不同属于环境（边框/DPI），单独记一行日志，
       * 不进 `problems` —— 把它算成问题会让这一条断言长期红着，而真正要守的东西
       * （渲染视口与窗口一致）就不再有人看了。
       */
      if (entry.viewport.w !== actual.w || entry.viewport.h !== actual.h) {
        problems.push('设备管理页：窗口内容尺寸 ' + actual.w + 'x' + actual.h +
          '，渲染层视口却是 ' + entry.viewport.w + 'x' + entry.viewport.h)
      }
      if (actual.w !== size[0] || actual.h !== size[1]) {
        log('devices ' + size[0] + 'x' + size[1] + ' : 窗口实际给的是 ' + actual.w + 'x' + actual.h +
          '（边框 / DPI 造成，非界面问题）')
      }
      // `.page` 就是内容盒的左上角：这是「和总览的改动后保持一致」的字面含义。
      const pageLeft = entry.page.left - entry.contentBox.left
      const pageTop = entry.page.top - entry.contentBox.top
      if (pageLeft > GAP_TOLERANCE_PX || pageTop > GAP_TOLERANCE_PX) {
        problems.push('设备管理页在 ' + size[0] + 'x' + size[1] + ' 的 .page 没有从内容盒左上角开始：' +
          pageLeft + 'px / ' + pageTop + 'px')
      }
      // 第 5 条之后这一页是**单列**：设备表的左右两边都要贴住内容盒。
      if (entry.shellGapFromContentBoxPx.left > GAP_TOLERANCE_PX) {
        problems.push('设备表在 ' + size[0] + 'x' + size[1] + ' 没有贴住内容盒左边：左间距 ' +
          entry.shellGapFromContentBoxPx.left + 'px')
      }
      if (entry.shellGapFromContentBoxPx.right > GAP_TOLERANCE_PX) {
        problems.push('设备表在 ' + size[0] + 'x' + size[1] + ' 没有占满内容宽度（第 5 条之后是单列）：' +
          '右边还空着 ' + entry.shellGapFromContentBoxPx.right + 'px —— 两列布局回来了？')
      }
      // 十列（第 8 条的清单）在每一档都放得下：表格自己不横向滚动。
      if (entry.tableScrollWidth > entry.tableClientWidth + 1) {
        problems.push('设备表在 ' + size[0] + 'x' + size[1] + ' 放不下这十列：表自身 scrollWidth ' +
          entry.tableScrollWidth + ' > clientWidth ' + entry.tableClientWidth)
      }
      // 表头在每一档都必须是那十列、顺序一致（列清单在 1280×720 下最容易掉队）。
      if (entry.headers && entry.headers.length !== 10) {
        problems.push('设备表在 ' + size[0] + 'x' + size[1] + ' 的表头是 ' + entry.headers.length +
          ' 列，应为 10：' + JSON.stringify(entry.headers))
      }
      if (entry.clipped.length > 0) {
        problems.push('设备管理页在 ' + size[0] + 'x' + size[1] + ' 有被裁掉的控件：' +
          JSON.stringify(entry.clipped))
      }
      if (entry.contentScrollWidth > entry.contentClientWidth + 1 ||
          entry.bodyScrollWidth > entry.windowInnerWidth + 1 ||
          entry.docScrollWidth > entry.windowInnerWidth + 1) {
        problems.push('设备管理页在 ' + size[0] + 'x' + size[1] + ' 有横向溢出：内容区 ' +
          entry.contentScrollWidth + '/' + entry.contentClientWidth + '，body ' +
          entry.bodyScrollWidth + '，document ' + entry.docScrollWidth + '，窗口 ' +
          entry.windowInnerWidth)
      }
    }
    // 单列的两条间距在四档之间必须**逐像素相同** —— 与窗口宽度无关。
    const lefts = found.map((entry) => entry.shellGapFromContentBoxPx.left)
    const rights = found.map((entry) => entry.shellGapFromContentBoxPx.right)
    if (new Set(lefts).size > 1 || new Set(rights).size > 1) {
      problems.push('设备表相对内容盒的位置在四档窗口尺寸下不是同一个数：left=' +
        JSON.stringify(lefts) + ' right=' + JSON.stringify(rights))
    }
    const pageLefts = found.map((entry) => entry.page.left - entry.contentBox.left)
    const pageTops = found.map((entry) => entry.page.top - entry.contentBox.top)
    if (new Set(pageLefts).size > 1 || new Set(pageTops).size > 1) {
      problems.push('.page 相对内容盒的位置在四档窗口尺寸下不是同一个数：left=' +
        JSON.stringify(pageLefts) + ' top=' + JSON.stringify(pageTops))
    }
    // 单列是**流式**的：窗口变宽，内容列必须跟着变宽。
    const pageWidths = found.map((entry) => entry.page.width)
    for (let i = 1; i < pageWidths.length; i += 1) {
      if (!(pageWidths[i] > pageWidths[i - 1])) {
        problems.push('设备管理页的内容列没有随窗口变宽：' + JSON.stringify(pageWidths))
        break
      }
    }
    log('devices gaps  : .page left=' + JSON.stringify(pageLefts) + ' top=' + JSON.stringify(pageTops) +
      '; table from content box left=' + JSON.stringify(lefts) + ' right=' + JSON.stringify(rights) +
      ' (px; tolerance ' + GAP_TOLERANCE_PX + ')')
    log('devices widths: table ' + JSON.stringify(found.map((e) => e.table.width)) +
      ' page ' + JSON.stringify(pageWidths) +
      ' rows ' + JSON.stringify(found.map((e) => e.rowCount)) +
      ' columns ' + JSON.stringify(found.map((e) => (e.headers || []).length)))
  }

  // 量完把窗口恢复成主进程创建时的尺寸，后面的探针才在一个正常的尺寸下读数。
  win.setContentSize(1440, 900)
  await sleep(600)

  /**
   * ③④ 设备管理页右侧的**设备表**（业主 2026-09-17 第 3、4 条；列清单 2026-09-18 第 8 条重给）。
   *
   * 量六件事，每一件都只能靠 DOM：
   *   ① 表头正好是业主重给的那十列、顺序一致（序号 / 设备名称 / IP地址 / 设备类型 / 状态 /
   *      告警数量 / 通道数 / 查看 / 设置 / 删除）；
   *   ② **卡片外壳**（第 11 批第 6 条，推翻了第 2b 条的"去卡片"）：外壳是 `.devices-table-card`
   *      （全局 `.card`），卡片内部保留每列一条浅色竖线；
   *   ③ 序号列是行号（第 1 行就是 1）；
   *   ④ 每一行都有「查看」「设置」「删除」三个**图标**按钮，IP 那一格是一个按钮（双击才开浏览器）；
   *   ⑤ 点「查看」→ 进实时监测页并带上这台设备的 id；点「设置」→ 打开**编辑对话框**
   *      （第 10 条：IP 只读、端口与 IP 同行、凭据同行 + 显示密码）；
   *   ⑥ **单击** IP 什么都不做（不跳转）—— 双击的前半段是两次单击，单击要是会导航，
   *      双击就永远落不到这一格上（这一条是第 4 条能不能用的前提）。
   *
   * `shell.openExternal` 那一次真正的双击单独量（见下面 `devicesTableDouble`）：
   * 渲染层读不到主进程的替身记录，只能在主进程这一侧比较调用前后。
   */
  const devicesTable = await layout('/devices', '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const table = document.querySelector("table.devices-table");' +
    'if (!table) return JSON.stringify({ ok: false, reason: "no-devices-table" });' +
    'const headers = [...table.querySelectorAll("thead th")].map((th) => text(th));' +
    'const rows = [...table.querySelectorAll("tbody tr")];' +
    'const actions = [...table.querySelectorAll("tbody [data-action]")];' +
    'const card = document.querySelector(".devices-table-card");' +
    'const cardStyle = card ? getComputedStyle(card) : null;' +
    'const out = {' +
    '  ok: true,' +
    '  headers,' +
    '  rows: rows.length,' +
    '  cardShell: !!card,' +
    '  legacyFlatShell: !!document.querySelector(".devices-table-flat"),' +
    '  legacyWrapShell: document.querySelectorAll(".table-wrap").length,' +
    '  cardRadius: cardStyle ? cardStyle.borderTopLeftRadius : null,' +
    '  monitorIcons: table.querySelectorAll("[data-action=device-monitor]").length,' +
    '  configureIcons: table.querySelectorAll("[data-action=device-configure]").length,' +
    '  deleteIcons: table.querySelectorAll("[data-action=device-delete]").length,' +
    '  detailNames: table.querySelectorAll("[data-action=device-detail]").length,' +
    '  actionsAreIcons: ["device-monitor", "device-configure", "device-delete"]' +
    '    .every((action) => {' +
    '      const buttons = [...table.querySelectorAll("tbody [data-action=" + action + "]")];' +
    '      return buttons.length > 0 && buttons.every((b) => !!b.querySelector("svg"));' +
    '    }),' +
    '  ipButtons: table.querySelectorAll("button.devices-table__ip").length,' +
    '  indexCells: [...table.querySelectorAll("tbody tr")]' +
    '    .map((tr) => text(tr.querySelector("td.devices-table__num"))),' +
    '  menuPresent: !!table.querySelector(".menu__list"),' +
    '  firstIp: "",' +
    '  afterMonitor: null,' +
    '  afterConfigure: null,' +
    '  afterSingleClick: ""' +
    '};' +
    /*
     * 第 11 批第 6 条那两件事**只能量**（源码里写了也可能被后面的规则盖掉）：
     *   · 告警数量 / 通道数 / 查看 / 设置 四列**居中** —— 量表头与表体两侧的 `text-align`；
     *   · 状态那一栏**不再有**「局域网 / 外网」徽标（`StatusBadge` 的 `.badge`）——
     *     量那一列里 `.status .badge` 的总数，必须是 0。
     */
    'out.centerColumns = (function(){' +
    '  const align = (node) => (node ? getComputedStyle(node).textAlign : null);' +
    '  const ths = [...table.querySelectorAll("thead th")];' +
    '  const tds = rows[0] ? [...rows[0].querySelectorAll("td")] : [];' +
    '  return {' +
    '    alarmCountHeader: align(ths[5]), alarmCountCell: align(tds[5]),' +
    '    channelCountHeader: align(ths[6]), channelCountCell: align(tds[6]),' +
    '    viewHeader: align(ths[7]), viewCell: align(tds[7]),' +
    '    settingHeader: align(ths[8]), settingCell: align(tds[8]) }; })();' +
    'out.statusConnectionBadges = rows.reduce((total, tr) => {' +
    '  const cell = tr.querySelectorAll("td")[4];' +
    '  return total + (cell ? cell.querySelectorAll(".status .badge").length : 0); }, 0);' +
    'const firstRow = rows[0];' +
    'const ipButton = firstRow ? firstRow.querySelector("button.devices-table__ip") : null;' +
    'out.firstIp = text(ipButton);' +
    /*
     * 回到设备管理页之后**等表出现**，而不是等一个固定毫秒数。
     *
     * 为什么（2026-09-17 第 9 批实测踩到）：从实时监测页切回设备管理页时，设备管理页会
     * 重新读一次设备列表（含逐台探活），忙的时候 900ms 内表格还没进 DOM —— 于是下面两次
     * 查找都拿到 null，报出来的是"点配置没进详情页"与"单击 IP 把页面带走了"两条**假失败**
     *  （真正的现象是"我还没看到表格"）。探针自己的时间假设也要能被质疑，见 15.40.3。
     */
    'const waitForRow = async () => {' +
    '  for (let i = 0; i < 24; i += 1) {' +
    '    const row = document.querySelector("table.devices-table tbody tr");' +
    '    if (row) return row;' +
    '    await wait(250);' +
    '  }' +
    '  return null;' +
    '};' +
    // ④ 查看：进实时监测页，并把设备 id 带在查询串上。
    'const eye = firstRow ? firstRow.querySelector("[data-action=device-monitor]") : null;' +
    'if (eye) { eye.click(); await wait(900); }' +
    'out.afterMonitor = { hash: location.hash,' +
    '  selectValue: (function(){ const s = document.querySelector("#topbar-page-slot select");' +
    '    return s ? s.value : null; })(),' +
    '  sonarLive: document.querySelectorAll("[data-sonar-live-unwired]").length,' +
    '  cameraLive: document.querySelectorAll(".camera-live").length,' +
    '  channelTabs: document.querySelectorAll(".channel-tabs").length,' +
    '  trendPanel: document.querySelectorAll(".trend-panel").length };' +
    /*
     * ⑤ 设置：**打开编辑对话框**（业主第 10 条那一个），并量对话框本身的三条版式要求：
     *    IP 只读（readonly 属性）、端口与 IP 在同一行（两个 .field 同一个 .form-grid）、
     *    凭据两格同一行 + 那个"显示密码"按钮真的把 type 从 password 换成 text。
     */
    'location.hash = "#/devices";' +
    'const row2 = await waitForRow();' +
    'const gear = row2 ? row2.querySelector("[data-action=device-configure]") : null;' +
    /*
     * 业主 2026-09-19 更正第 3 条：**序号那一列居中**，且**每一列之间一条浅色竖线**。
     * 两条都只能量：`text-align` 与 `border-left-color` 源码里写了也可能被后面的规则覆盖。
     */
    'out.indexAlign = (function(){ const c = document.querySelector("table.devices-table tbody td");' +
    '  return c ? getComputedStyle(c).textAlign : null; })();' +
    'out.indexHeaderAlign = (function(){ const th = document.querySelector("table.devices-table thead th");' +
    '  return th ? getComputedStyle(th).textAlign : null; })();' +
    'out.columnSeparators = (function(){' +
    '  const cells = [...document.querySelectorAll("table.devices-table tbody tr td")];' +
    // 每行 10 列：cells[0] 第一行第一列、cells[1] 第一行第二列、cells[11] 第二行第二列。
    '  if (cells.length < 12) return null;' +
    '  const first = getComputedStyle(cells[0]);' +
    '  const second = getComputedStyle(cells[1]);' +
    '  const secondRowSecond = getComputedStyle(cells[11]);' +
    '  return { firstLeftWidth: first.borderLeftWidth, secondLeftWidth: second.borderLeftWidth,' +
    '    secondLeftColor: second.borderLeftColor,' +
    '    secondRowFirstLeftWidth: getComputedStyle(cells[10]).borderLeftWidth,' +
    '    secondRowSecondLeftWidth: secondRowSecond.borderLeftWidth }; })();' +
    'const dialogOf = () => document.querySelector(".overlay [role=dialog]");' +
    'if (gear) {' +
    '  gear.click();' +
    '  await wait(700);' +
    '  const dlg = dialogOf();' +
    '  out.afterConfigure = { hash: location.hash, dialogOpen: !!dlg };' +
    '  if (dlg) {' +
    '    const ip = dlg.querySelector("[data-field=edit-ip]");' +
    '    out.editIpReadonly = !!ip && ip.hasAttribute("readonly");' +
    '    out.editIpEditable = !!ip && !ip.readOnly;' +
    '    const grids = [...dlg.querySelectorAll(".form-grid")];' +
    '    out.editGrids = grids.map((g) => [...g.querySelectorAll(".field-label")].map((l) => text(l)));' +
    '    const pw = dlg.querySelector("input[type=password]");' +
    '    const reveal = dlg.querySelector("[data-action=edit-password-reveal]");' +
    '    out.editPasswordHiddenType = pw ? pw.getAttribute("type") : null;' +
    '    out.editRevealPresent = !!reveal;' +
    '    if (reveal) {' +
    '      reveal.click();' +
    '      await wait(300);' +
    '      const after = dlg.querySelector("input[data-field=edit-password], .form-grid input[type=text]");' +
    '      const revealed = [...dlg.querySelectorAll("input")].find((i) => i.getAttribute("type") === "text" && i.value === "");' +
    '      out.editPasswordAfterReveal = (function(){' +
    '        const all = [...dlg.querySelectorAll("input")];' +
    '        const pwNow = all.find((i) => i.getAttribute("type") === "password");' +
    '        return pwNow ? "password" : "text";' +
    '      })();' +
    '      if (after) void after;' +
    '      if (revealed) void revealed;' +
    '    }' +
    '    const close = [...dlg.querySelectorAll("button")].find((b) => text(b) === "取消");' +
    '    if (close) { close.click(); await wait(400); }' +
    '    out.editDialogClosed = !dialogOf();' +
    '  }' +
    '}' +
    // ⑥ 单击 IP：什么都不许发生（不跳转、不选中别的东西）。
    'location.hash = "#/devices";' +
    'const row3 = await waitForRow();' +
    'const ip2 = row3 ? row3.querySelector("button.devices-table__ip") : null;' +
    'if (ip2) {' +
    '  ip2.click();' +
    '  await wait(600);' +
    '  out.afterSingleClick = location.hash;' +
    '}' +
    'return JSON.stringify(out);' +
    '})()')

  log('devices table : ' + JSON.stringify(devicesTable))
  if (!devicesTable.ok) {
    problems.push('设备管理页没有设备表（table.devices-table）：' + JSON.stringify(devicesTable))
  } else {
    const EXPECTED_HEADERS = [
      '序号',
      '设备名称',
      'IP地址',
      '设备类型',
      '状态',
      '告警数量',
      '通道数',
      '查看',
      '设置',
      '删除'
    ]
    if (JSON.stringify(devicesTable.headers) !== JSON.stringify(EXPECTED_HEADERS)) {
      problems.push(
        '设备表的列不是业主 2026-09-18 第 8 条重给的那十列（或顺序不对）：' +
          JSON.stringify(devicesTable.headers)
      )
    }
    // ② 卡片外壳（第 11 批第 6 条推翻了第 2b 条的"去卡片"：改成"做个卡片做一个小的区分，
    //    类似于实时监控界面的"）。
    if (!devicesTable.cardShell) {
      problems.push('设备表没有卡片外壳（.devices-table-card）—— 第 11 批第 6 条要求做成卡片')
    }
    if (devicesTable.legacyFlatShell) {
      problems.push('设备表还留着扁平外壳（.devices-table-flat）—— 第 6 条已改回卡片')
    }
    if (devicesTable.legacyWrapShell > 0) {
      problems.push('设备表用回了 .table-wrap 外壳（它带着自己的内边距，列线会跟着缩）')
    }
    if (String(devicesTable.cardRadius) === '0px') {
      problems.push('卡片外壳没有圆角：' + JSON.stringify(devicesTable.cardRadius))
    }
    // 第 6 条：四列居中。
    for (const [label, value] of Object.entries(devicesTable.centerColumns || {})) {
      if (value !== 'center') {
        problems.push(
          '第 6 条：' + label + ' 没有居中对齐（text-align = ' + JSON.stringify(value) + '）'
        )
      }
    }
    // 第 6 条：状态那一栏不再有「局域网 / 外网」。
    if (devicesTable.statusConnectionBadges !== 0) {
      problems.push(
        '状态那一栏还显示着「局域网 / 外网」徽标：' + devicesTable.statusConnectionBadges + ' 个'
      )
    }
    if (devicesTable.menuPresent) {
      problems.push('行末的省略号菜单又回来了（第 8 条已把编辑/删除升成两列）')
    }
    if (devicesTable.rows === 0) {
      problems.push('设备表一行都没有（库里又不是没有设备）——"表渲染了"与"没数据"必须能分开')
    }
    // ③ 序号列 = 行号。
    const indexes = devicesTable.indexCells || []
    if (indexes.length !== devicesTable.rows) {
      problems.push('序号列的行数与设备行数不一致：' + JSON.stringify(indexes))
    } else if (indexes.some((value, index) => value !== String(index + 1))) {
      problems.push('序号列不是 1、2、3…：' + JSON.stringify(indexes))
    }
    for (const [label, count] of [
      ['查看', devicesTable.monitorIcons],
      ['设置', devicesTable.configureIcons],
      ['删除', devicesTable.deleteIcons],
      ['设备名（详情入口）', devicesTable.detailNames]
    ]) {
      if (count !== devicesTable.rows) {
        problems.push(
          '「' + label + '」的个数与设备行数不一致：' + count + ' vs ' + devicesTable.rows
        )
      }
    }
    if (!devicesTable.actionsAreIcons) {
      problems.push('查看/设置/删除那一格里出现了没有图标的按钮（业主明确要图标）')
    }
    if (devicesTable.ipButtons !== devicesTable.rows) {
      problems.push('不是每一行的 IP 都是可双击的按钮：' + devicesTable.ipButtons + ' vs ' + devicesTable.rows)
    }
    const monitor = devicesTable.afterMonitor || {}
    /*
     * 更正第 3 条：序号列居中 + 每一列之间一条浅色竖线。
     */
    for (const [label, value] of [
      ['序号列表头', devicesTable.indexHeaderAlign],
      ['序号列单元格', devicesTable.indexAlign]
    ]) {
      if (value !== 'center') {
        problems.push(label + '没有居中对齐（text-align = ' + JSON.stringify(value) + '）')
      }
    }
    {
      const sep = devicesTable.columnSeparators
      if (!sep) {
        problems.push('量不到设备表的列分隔线（行里不足 11 个单元格？）')
      } else {
        if (String(sep.firstLeftWidth) !== '0px') {
          problems.push('第一列左边也画了竖线（那是表格自己的边框，会成重影）：' + sep.firstLeftWidth)
        }
        if (Number.parseFloat(sep.secondLeftWidth) <= 0) {
          problems.push('第二列左边没有竖线：' + JSON.stringify(sep))
        }
        // 表体的**每一列之间**都要有：第一列（每行的开头）仍然不许有。
        if (String(sep.secondRowFirstLeftWidth) !== '0px') {
          problems.push('第二行的第一列左边也画了竖线：' + JSON.stringify(sep))
        }
        if (Number.parseFloat(sep.secondRowSecondLeftWidth) <= 0) {
          problems.push('第二行的第二列左边没有竖线（列线只在第一行？）：' + JSON.stringify(sep))
        }
        // 「浅一些」：不能是强调色或深灰，必须是那一档浅边线色。
        const rgb = String(sep.secondLeftColor).replace(/\s/g, '')
        if (!/^rgb\(228,231,236\)$/.test(rgb)) {
          problems.push('列分隔线的颜色不是那一档浅边线（--color-border #e4e7ec）：' + sep.secondLeftColor)
        }
      }
    }
    if (!/^#\/monitor/.test(String(monitor.hash || ''))) {
      problems.push('点「查看」没有进实时监测页：' + monitor.hash)
    } else if (!/\?device=/.test(String(monitor.hash))) {
      problems.push('点「查看」没有把设备 id 带过去：' + monitor.hash)
    } else if (String(monitor.selectValue || '') === '') {
      problems.push('点「查看」之后顶栏的设备下拉没有选中任何设备')
    }
    // ⑤ 设置 → 编辑对话框 + 三条版式要求（第 10 条）。对话框自己那几个读数在 `devicesTable`
    // 顶层（`editIpReadonly` / `editGrids` / …），这里只从 `afterConfigure` 拿"有没有开"。
    const configure = devicesTable.afterConfigure || {}
    if (!configure.dialogOpen) {
      problems.push('点「设置」没有打开编辑对话框：' + JSON.stringify(configure))
    } else {
      if (devicesTable.editIpEditable) {
        problems.push('编辑对话框里的 IP 还能改（第 10 条：IP 地址不可修改）')
      }
      if (!devicesTable.editIpReadonly) {
        problems.push('编辑对话框里没有只读的 IP 那一格（[data-field=edit-ip]）')
      }
      const grids = devicesTable.editGrids || []
      const hasRow = (a, b) => grids.some((g) => g.includes(a) && g.includes(b))
      if (!hasRow('IP 地址', 'HTTP 端口')) {
        problems.push('IP 与 HTTP 端口不在同一行：' + JSON.stringify(grids))
      }
      if (!hasRow('用户名', '密码')) {
        problems.push('用户名与密码不在同一行：' + JSON.stringify(grids))
      }
      if (!hasRow('纬度（°）', '经度（°）')) {
        problems.push('纬度与经度不在同一行：' + JSON.stringify(grids))
      }
      if (devicesTable.editPasswordHiddenType !== 'password') {
        problems.push('密码框默认不是 password 类型：' + JSON.stringify(devicesTable.editPasswordHiddenType))
      }
      if (!devicesTable.editRevealPresent) {
        problems.push('密码框旁边没有「显示密码」按钮（第 10 条要求能显示密码）')
      } else if (devicesTable.editPasswordAfterReveal !== 'text') {
        problems.push(
          '点了「显示密码」之后那一格仍然是 password（第 10 条要能显示）：' +
            JSON.stringify(devicesTable.editPasswordAfterReveal)
        )
      }
      if (devicesTable.editDialogClosed !== true) {
        problems.push('编辑对话框点「取消」之后没有关掉')
      }
    }
    if (devicesTable.afterSingleClick !== '#/devices') {
      problems.push(
        '单击设备 IP 把页面带走了（' + devicesTable.afterSingleClick +
          '）——双击打开浏览器就永远落不到这一格上'
      )
    }
  }

  /**
   * ④ **双击**设备 IP → 打开设备自己的 Web 界面。
   *
   * 终点是主进程的 `shell.openExternal`（页脚那条链路的同一个替身），所以只能在主进程这
   * 一侧比较调用前后：单击不许加一条、双击必须正好加一条，且那一条是这台设备的地址。
   */
  {
    const callsBeforeSingle = openExternalCalls.length
    await layout('/devices', '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const ip = document.querySelector("table.devices-table button.devices-table__ip");' +
      'if (ip) { ip.click(); await wait(500); }' +
      'return JSON.stringify({ clicked: !!ip });' +
      '})()')
    const callsAfterSingle = openExternalCalls.length
    if (callsAfterSingle !== callsBeforeSingle) {
      problems.push('单击设备 IP 就打开了浏览器（业主说的是**双击**）')
    }

    const doubleClick = await layout('/devices', '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const ip = document.querySelector("table.devices-table button.devices-table__ip");' +
      'if (!ip) return JSON.stringify({ clicked: false });' +
      'ip.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));' +
      'await wait(700);' +
      'return JSON.stringify({ clicked: true, hash: location.hash });' +
      '})()')
    const callsAfterDouble = openExternalCalls
    const opened = callsAfterDouble[callsAfterDouble.length - 1] || ''
    const firstIp = String(devicesTable.firstIp || '').split(':')[0]
    log('devices table : 双击 IP -> openExternal(' + opened + ')')
    if (!doubleClick.clicked) {
      problems.push('设备表里找不到可双击的 IP 按钮')
    } else if (callsAfterDouble.length !== callsBeforeSingle + 1) {
      problems.push(
        '双击设备 IP 没有正好打开一次设备 Web 界面：新增 ' +
          (callsAfterDouble.length - callsBeforeSingle) + ' 次'
      )
    } else if (firstIp && opened.indexOf(firstIp) < 0) {
      problems.push('双击打开的不是这一行的设备地址：' + opened + '（这一行是 ' + firstIp + '）')
    }
    if (doubleClick.hash !== '#/devices') {
      problems.push('双击设备 IP 之后页面被带走了：' + doubleClick.hash)
    }
  }


  const settingsLayout = await layout('/settings', '(() => {' +
    'const select = document.querySelector(".lang__select");' +
    'const sidebar = document.querySelector(".sidebar");' +
    'const page = document.querySelector(".page");' +
    'return JSON.stringify({' +
    '  langOnSettings: !!select,' +
    '  langInsidePage: !!(page && select && page.contains(select)),' +
    '  langInSidebar: !!(sidebar && select && sidebar.contains(select)),' +
    '  options: select ? select.options.length : 0' +
    '});' +
    '})()')

  if (!settingsLayout.langOnSettings) problems.push('系统设置里没有语言选择器')
  if (settingsLayout.langInSidebar) problems.push('语言选择器仍在侧栏里')
  if (settingsLayout.options !== 4) {
    problems.push('语言选择器有 ' + settingsLayout.options + ' 个选项，应为 4')
  }

  /**
   * ③ 设置页的页签（业主 2026-09-17 的七个 + 2026-09-19 的「数据接入」）。
   *
   * 一次真点击 + 等一次渲染，逐个页签量：这一页有没有 tabpanel、里面有多少可操作控件、
   * 有没有重复的卡片标题（`h3.section-title`）、账号/关于那两页的关键控件在不在。
   *
   * 为什么要**逐个点**而不是只数页签：页签渲染出来、点下去什么都不变，是这类改动最常见的
   * 失败形态（`activeTab` 没接上 / 每个面板都用同一个条件）。只数页签数完全看不出来。
   */
  const settingsTabs = await layout('/settings', '(() => {' +
    'const tabs = [...document.querySelectorAll(".settings-tabs [role=tab]")];' +
    'if (tabs.length === 0) return Promise.resolve(JSON.stringify({ tabs: 0 }));' +
    'const ids = tabs.map((tab) => tab.getAttribute("data-tab"));' +
    'const results = [];' +
    'const step = (index) => {' +
    '  if (index >= tabs.length) return Promise.resolve();' +
    '  tabs[index].click();' +
    '  return new Promise((done) => setTimeout(done, 150)).then(() => {' +
    '    const page = document.querySelector(".page");' +
    '    const panels = [...document.querySelectorAll("[role=tabpanel]")]' +
    '      .filter((panel) => panel.offsetParent !== null);' +
    /*
     * 内容量按**整页**量，而不是按 `[role=tabpanel]`：告警 / 邮箱 / 账号三页装的是
     * 独立组件（`LinkageSettingsSection` 等），它们的根元素不是 tabpanel ——
     * 只数 tabpanel 会把"这三页渲染得好好的"误报成"点下去什么都没有"（第一版就是这样）。
     */
    '    const cards = page ? [...page.querySelectorAll("section.card")]' +
    '      .filter((card) => card.offsetParent !== null).length : 0;' +
    '    const controls = page ? page.querySelectorAll("input, select, button").length : 0;' +
    '    const numbers = page ? page.querySelectorAll("input[type=number]").length : 0;' +
    '    const titles = panels.reduce((sum, panel) =>' +
    '      sum + panel.querySelectorAll("h3.section-title").length, 0);' +
    '    results.push({' +
    '      id: tabs[index].getAttribute("data-tab"),' +
    '      selected: tabs[index].getAttribute("aria-selected") === "true",' +
    '      panels: panels.length,' +
    '      cards, controls, numbers, titles,' +
    '      signOut: document.querySelectorAll("[data-action=sign-out]").length,' +
    '      changePassword: document.querySelectorAll("[data-action=change-password]").length,' +
    '      restore: document.querySelectorAll("[data-action=restore-defaults]").length' +
    '    });' +
    '    return step(index + 1);' +
    '  });' +
    '};' +
    'return step(0).then(() => JSON.stringify({ tabs: tabs.length, ids, results }));' +
    '})()')
  log('settings tabs: ' + JSON.stringify(settingsTabs))

  /*
   * 7 个页签：`iot`（设备接入）那一个**撤掉了** —— 业主第 13 批 A①要求「数据接入」
   * 搬进「设备管理 → 添加设备」，于是「本机接入（监听设置与收数）」现在在
   * `AddDeviceDialog.vue` 里，不再是设置页的一个页签（四语言的 `settingsUi.tabIot` 也删了）。
   * 源码守卫在 `tests/settings-tabs.test.ts`（同样是 7 个）。
   */
  if (settingsTabs.tabs !== 7) {
    problems.push('设置页的页签不是 7 个：' + settingsTabs.tabs)
  } else {
    const expectedIds = ['language', 'storage', 'video', 'alarm', 'email', 'account', 'about']
    if (JSON.stringify(settingsTabs.ids) !== JSON.stringify(expectedIds)) {
      problems.push('设置页页签的顺序/名字不对：' + JSON.stringify(settingsTabs.ids))
    }
    /*
     * 反向断言：`iot` 页签**不许**再出现（搬走之后又长回来，是这一条最容易的回归方式）。
     */
    if ((settingsTabs.ids || []).includes('iot')) {
      problems.push('设置页又出现了 `iot` 页签 —— 「本机接入」应在「添加设备」里')
    }
    /*
     * 只有**内联**在这四个页签里的卡片不许有 `h3.section-title`（业主 ③：不要每张卡片都
     * 写名字）。告警/邮箱/账号三页装的是独立组件，它们自己的卡片标题是各自子域的名字
     * （例如"告警联动"），不是对页签名的重复。
     */
    const inlineTabs = new Set(['language', 'storage', 'video', 'about'])
    for (const tab of settingsTabs.results) {
      if (tab.cards === 0) problems.push('页签 ' + tab.id + ' 点下去一张卡片都没有（是空的）')
      if (tab.controls === 0) problems.push('页签 ' + tab.id + ' 里一个可操作控件都没有')
      if (!tab.selected) problems.push('页签 ' + tab.id + ' 点下去之后 aria-selected 不是 true')
      if (inlineTabs.has(tab.id) && tab.titles > 0) {
        problems.push('页签 ' + tab.id + ' 里又出现了卡片标题（' + tab.titles + ' 个）')
      }
      if (tab.id === 'video' && tab.numbers !== 6) {
        problems.push('「视频与缓冲」里的数字输入不是 6 个：' + tab.numbers +
          '（设备探测 3 个 + 缓冲 3 个必须合成一组）')
      }
      if (tab.id === 'account') {
        if (tab.signOut !== 1) problems.push('账号页签里没有「退出登录」按钮')
        if (tab.changePassword !== 1) problems.push('账号页签里没有「修改密码」按钮')
      }
      if (tab.id === 'about' && tab.restore !== 1) {
        problems.push('「关于与维护」页签里没有「恢复默认值」')
      }
    }
  }

  // Back to the Overview so the language section below starts from the same place
  // the earlier screenshots did.
  await win.webContents.executeJavaScript('location.hash = "#/"; true')
  await sleep(800)

  /**
   * Language switching, checked against the REAL rendered DOM.
   *
   * A catalogue can be complete, typed and unit-tested and still never reach the
   * screen — a component that forgot to call the translation helper renders its
   * raw key or a stale hard-coded string. That is only visible in a running app.
   *
   * Driven step by step from here rather than inside one executeJavaScript call:
   * switching by reload destroys the JS context, so a promise spanning a reload
   * would never settle.
   */
  const readLocaleState = async (label) => {
    const raw = await win.webContents.executeJavaScript(`JSON.stringify({
      navFirst: (document.querySelector('.sidebar__nav .nav-item__label') || {}).textContent || null,
      footer: (document.querySelector('.app-footer') || {}).textContent || null,
      copyright: (document.querySelector('.app-footer__copyright') || {}).textContent || null,
      release: (document.querySelector('.app-footer__version') || {}).textContent || null,
      htmlLang: document.documentElement.lang,
      title: document.title
    })`)
    const parsed = JSON.parse(raw)
    log('locale ' + label.padEnd(6) + ': nav=' + JSON.stringify(parsed.navFirst) +
        ' copyright=' + JSON.stringify(parsed.copyright) +
        ' version=' + JSON.stringify(parsed.release) +
        ' htmlLang=' + parsed.htmlLang)
    return parsed
  }

  const localeStates = {}
  for (const code of ['zh-CN', 'en', 'es', 'tr']) {
    // Drive the real persistence path: the same storage key the composable reads
    // on startup. Reloading also proves the choice SURVIVES a restart, which is
    // half the feature.
    await win.webContents.executeJavaScript(
      'window.localStorage.setItem("hertzinno.locale", ' + JSON.stringify(code) + '); true'
    )
    win.webContents.reload()
    await sleep(2600)
    localeStates[code] = await readLocaleState(code)
  }

  // The four languages must actually render DIFFERENT text. Comparing rendered
  // output catches a component that ignored the locale entirely, which a
  // catalogue-level test cannot see.
  const rendered = Object.values(localeStates).map((state) => state.navFirst)
  if (new Set(rendered).size !== rendered.length) {
    problems.push('locale switch did not change the rendered navigation: ' + JSON.stringify(rendered))
  }
  for (const [code, state] of Object.entries(localeStates)) {
    if (state.htmlLang !== code) {
      problems.push('document.documentElement.lang is ' + state.htmlLang + ' for locale ' + code)
    }
    // A raw key on screen means the translation helper was never called.
    if (typeof state.navFirst === 'string' && state.navFirst.startsWith('app.')) {
      problems.push('untranslated key rendered for ' + code + ': ' + state.navFirst)
    }
    // The release date is locale DATA, not copy: it must be formatted by Intl for
    // the active language, and must never still read as the Chinese form
    // (year/month/day ideographs) once the interface is English, Spanish or
    // Turkish. Regression guard for the shared Chinese-only date formatter that
    // was removed, which rendered the same Chinese date in all four languages.
    //
    // Checked on the WHOLE footer, because the date moved there with the version
    // when the sidebar footer was replaced by the page footer.
    if (code !== 'zh-CN' && typeof state.footer === 'string' && /[\u5e74\u6708\u65e5]/.test(state.footer)) {
      problems.push('release date rendered in Chinese for ' + code + ': ' + state.footer)
    }
    // The footer is where the product asked for the version and the copyright, so
    // their ABSENCE is a finding — a text check that only pattern-matches passes
    // silently when the element is gone.
    if (!state.copyright) problems.push('footer has no copyright line for ' + code)
    if (!state.release) problems.push('footer has no version for ' + code)
  }

  // Leave the app in the default language so the captured screenshots are the
  // product's default appearance.
  await win.webContents.executeJavaScript(
    'window.localStorage.setItem("hertzinno.locale", "zh-CN"); true'
  )
  win.webContents.reload()
  await sleep(2600)

  /**
   * 重命名演练（`--rename-drill`）：**真的**改一次声纹设备的设备名与一路通道名，读回，
   * 再改回原值并读回。默认不跑（见文件头那块说明），因为它写的是值班中的真机。
   */
  if (RENAME_DRILL) {
    await runRenameDrill(win)
  } else {
    log('rename drill  : skipped（默认不写设备；要演练请加 --rename-drill）')
  }

  /**
   * 告警记录的等级与备注（v6）+ 「告警中心」这一轮的三条改动（2026-09-19）。
   *
   * 一次性 profile 里**没有告警行**，所以能验证的是「控件真的渲染出来了」这一层：
   * 筛选器里有没有等级下拉、下拉里是不是四档、表头有没有「等级」这一列。着色与备注
   * 编辑要先有一条记录，那属于单元测试与源码守卫的覆盖面（`tests/alarm-severity-ui.test.ts`
   * 钉住每一档都有配色类、筛选器真的把 severity 写进 query）。
   *
   * 之所以要这一项：`problems` 曾经 0 而页面上根本没有控件——只要有记录才报错的话，
   * 「控件没渲染」与「没有数据」看起来完全一样。
   *
   * 2026-09-19 追加三件事（业主当天的第 2 条要求）：
   *   · 页面名是**告警中心**（侧栏 + 顶栏标题）；
   *   · **筛选卡在最上面**（在计数/批量动作那一行之前）——用 DOM 顺序判，不看源码；
   *   · **更多筛选默认收起**，点一下展开出四个控件，再点一下收回去。
   *     「收起」的判据是那一块**在不在 DOM 里**（v-if），不是"看不见"。
   */
  const alarmsLayout = await layout('/alarms', '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (node) => (node ? (node.textContent || "").trim() : "");' +
    'const setInput = (node, value) => { if (!node) return false;' +
    '  node.value = String(value);' +
    '  node.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  return true; };' +
    'const countOf = () => {' +
    '  const m = /共 (\\d+) 条/.exec(text(document.querySelector(".page-subtitle")));' +
    '  return m ? Number(m[1]) : null;' +
    '};' +
    'const labels = [...document.querySelectorAll("[data-alarm-simple-filters] .field-label")]' +
    '  .map((n) => n.textContent.trim());' +
    'const selects = [...document.querySelectorAll("[data-alarm-simple-filters] select")];' +
    'const severitySelect = selects.find((s) =>' +
    '  [...s.options].some((o) => o.textContent.trim() === "全部等级"));' +
    'const heads = [...document.querySelectorAll("table thead th")].map((n) => n.textContent.trim());' +
    'const page = document.querySelector(".page");' +
    'const card = page ? page.querySelector("section.card") : null;' +
    'const header = document.querySelector(".page-header");' +
    /*
     * 「筛选卡在最上面」的判据是 DOM 顺序：`compareDocumentPosition` 里
     * `DOCUMENT_POSITION_FOLLOWING` 表示"另一个节点排在我后面"。
     */
    'const filterCardFirst = !!(card && header && card.contains(document.querySelector("[data-alarm-filters]")) &&' +
    '  (document.querySelector("[data-alarm-filters]").compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&' +
    '  !(header.compareDocumentPosition(document.querySelector("[data-alarm-filters]")) & Node.DOCUMENT_POSITION_FOLLOWING));' +
    'const navItem = [...document.querySelectorAll(".sidebar__nav a.nav-item")]' +
    '  .find((a) => (a.getAttribute("href") || "").replace(/^#/, "") === "/alarms");' +
    'const toggle = document.querySelector("[data-action=toggle-alarm-filters]");' +
    'const moreBefore = !!document.querySelector("[data-alarm-more-filters]");' +
    'const expandedBefore = toggle ? toggle.getAttribute("aria-expanded") : null;' +
    'if (toggle) { toggle.click(); await wait(300); }' +
    'const moreAfterOpen = !!document.querySelector("[data-alarm-more-filters]");' +
    'const expandedAfterOpen = toggle ? toggle.getAttribute("aria-expanded") : null;' +
    'const moreLabels = [...document.querySelectorAll("[data-alarm-more-filters] .field-label")]' +
    '  .map((n) => n.textContent.trim());' +
    'const moreControls = document.querySelectorAll("[data-alarm-more-filters] input, [data-alarm-more-filters] select").length;' +
    'if (toggle) { toggle.click(); await wait(300); }' +
    'const moreAfterClose = !!document.querySelector("[data-alarm-more-filters]");' +
    /*
     * 「收起之后那四个仍然生效」这一条**必须真的做一次**，否则整块"更多筛选"只是排版。
     *
     * 做法：展开 → 把「开始时间」设成一个未来时刻（2099 年，库里不可能有）→ 命中数必须变成 0，
     * 而且**收起状态下的按钮上要出现生效项数**（列表变短的唯一解释）→ 清空 → 命中数回到原值。
     * 全程只改筛选（不写库、不写设备）。
     */
    'const totalBefore = countOf();' +
    'if (toggle) { toggle.click(); await wait(300); }' +
    'const fromInput = document.querySelector("[data-alarm-more-filters] input[type=datetime-local]");' +
    'setInput(fromInput, "2099-01-01T00:00");' +
    'await wait(1200);' +
    'const totalFiltered = countOf();' +
    'const rowsFiltered = document.querySelectorAll("table tbody tr.is-clickable").length;' +
    'if (toggle) { toggle.click(); await wait(300); }' +
    'const labelWhenCollapsed = toggle ? toggle.textContent.trim() : "";' +
    'if (toggle) { toggle.click(); await wait(400); }' +
    'const clearTarget = document.querySelector("[data-alarm-more-filters] input[type=datetime-local]");' +
    'const clearApplied = setInput(clearTarget, "");' +
    'await wait(1200);' +
    'const totalRestored = countOf();' +
    'return JSON.stringify({' +
    '  filterLabels: labels,' +
    '  severityOptionCount: severitySelect ? severitySelect.options.length - 1 : 0,' +
    '  severityOptions: severitySelect ? [...severitySelect.options].slice(1).map((o) => o.textContent.trim()) : [],' +
    '  heads,' +
    '  navLabel: navItem ? (navItem.textContent || "").trim() : null,' +
    '  topbarTitle: (document.querySelector(".topbar__heading") || {}).textContent || null,' +
    '  filterCardFirst,' +
    '  moreBefore, extraExpanded: expandedBefore,' +
    '  moreAfterOpen, expandedAfterOpen, moreLabels, moreControls, moreAfterClose,' +
    '  totalBefore, totalFiltered, rowsFiltered, labelWhenCollapsed, totalRestored,' +
    '  clearApplied' +
    '});})()')
  log('alarms controls: ' + JSON.stringify(alarmsLayout))
  if (!alarmsLayout.filterLabels.includes('告警等级')) {
    problems.push('告警中心的简单筛选里没有「告警等级」下拉：' + JSON.stringify(alarmsLayout.filterLabels))
  }
  if (alarmsLayout.severityOptionCount !== 4) {
    problems.push('等级下拉有 ' + alarmsLayout.severityOptionCount + ' 个档位，应为 4：' +
      JSON.stringify(alarmsLayout.severityOptions))
  }
  if (!alarmsLayout.heads.includes('等级')) {
    problems.push('告警中心的表头里没有「等级」列：' + JSON.stringify(alarmsLayout.heads))
  }

  // ① 页面名（侧栏 + 顶栏标题）都是「告警中心」。
  if (alarmsLayout.navLabel !== '告警中心') {
    problems.push('侧栏里这一页不叫「告警中心」：' + JSON.stringify(alarmsLayout.navLabel))
  }
  if (String(alarmsLayout.topbarTitle ?? '').trim() !== '告警中心') {
    problems.push('顶栏标题不是「告警中心」：' + JSON.stringify(alarmsLayout.topbarTitle))
  }

  // ② 筛选卡在最上面（DOM 顺序判）。
  if (!alarmsLayout.filterCardFirst) {
    problems.push('筛选卡不在「计数 + 批量动作」那一行之前（业主第 2 条要求放在最上面）')
  }

  // ③ 更多筛选默认收起，开关真的能展开 / 收回。
  if (alarmsLayout.moreBefore) {
    problems.push('「更多筛选」默认没有收起（[data-alarm-more-filters] 一开始就在 DOM 里）')
  }
  if (alarmsLayout.extraExpanded !== 'false') {
    problems.push('「更多筛选」开关初始 aria-expanded 不是 false：' + JSON.stringify(alarmsLayout.extraExpanded))
  }
  if (!alarmsLayout.moreAfterOpen) {
    problems.push('点了「更多筛选」之后那四个控件没有出现')
  }
  if (alarmsLayout.expandedAfterOpen !== 'true') {
    problems.push('展开之后 aria-expanded 不是 true：' + JSON.stringify(alarmsLayout.expandedAfterOpen))
  }
  if (alarmsLayout.moreControls !== 4) {
    problems.push('「更多筛选」里的控件不是 4 个（开始/结束/通道/类型）：' + alarmsLayout.moreControls +
      ' ' + JSON.stringify(alarmsLayout.moreLabels))
  }
  for (const label of ['开始时间', '结束时间', '通道', '告警类型']) {
    if (!(alarmsLayout.moreLabels || []).includes(label)) {
      problems.push('「更多筛选」里没有「' + label + '」：' + JSON.stringify(alarmsLayout.moreLabels))
    }
  }
  if (alarmsLayout.moreAfterClose) {
    problems.push('再点一次「更多筛选」之后没有收回去')
  }
  /*
   * 收起的筛选**仍然生效**（这一条是"简单/更多"这个区分真正的风险点）：
   * 未来时刻的开始时间必须把命中数打到 0，收起来之后按钮上要能看出有一项在生效，
   * 清空之后必须回到原来的数。
   */
  if (alarmsLayout.totalBefore === null) {
    problems.push('读不到筛选结果的条数（.page-subtitle 的格式变了？）')
  } else {
    if (alarmsLayout.totalFiltered !== 0) {
      problems.push(
        '「更多筛选」里的开始时间没有生效：设成 2099 年之后命中 ' +
          JSON.stringify(alarmsLayout.totalFiltered) + ' 条（应为 0）'
      )
    }
    if (alarmsLayout.rowsFiltered !== 0) {
      problems.push('筛成 0 条之后表格里还有 ' + alarmsLayout.rowsFiltered + ' 行')
    }
    if (!/1/.test(String(alarmsLayout.labelWhenCollapsed))) {
      problems.push(
        '收起之后按钮上没有生效项数（列表变短没有解释）：' +
          JSON.stringify(alarmsLayout.labelWhenCollapsed)
      )
    }
    if (alarmsLayout.totalRestored !== alarmsLayout.totalBefore) {
      problems.push(
        '清空「更多筛选」之后命中数没有回到原值：' + alarmsLayout.totalRestored +
          ' vs ' + alarmsLayout.totalBefore
      )
    }
  }

  /**
   * 三项界面改造（业主 2026-09-16）的屏幕级断言 —— 第 1 条已由第 5 条（2026-09-18）改写。
   *
   * 三条要求都能"源码里改对了但屏幕上没生效"，所以每条都读 DOM：
   *   1. 设备管理页右侧内容区没有标题，且「添加设备」在**顶栏那一格**里
   *      （原来是"在左侧拓扑树里面"；第 5 条把树下架之后入口搬到了 `#topbar-page-slot`）；
   *   2. **所有**页面都没有页面内标题（外层框架的标题栏已经写了）;
   *   3. 告警图标点开是那张面板：没有告警时写「当前无告警」，角标与列表同源。
   */
  const devicesChrome = await layout('/devices', '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    /*
     * 等那颗按钮出现再断言，而不是"切过来 1.2 秒后一定已经渲染好了"。
     *
     * 2026-09-17 第 9 批实测：机器忙的时候（操作员库里 200 条告警 + 每 10 秒一轮设备探活）
     * 这一页 1.2 秒内还没画完，于是"找不到「添加设备」按钮"被报成产品问题 —— 而紧接着
     * 的 addDialog 探针（同一页，晚一两秒）就找到了那个按钮。**同一个东西一次找不到、
     * 一次找得到，说明问题在探针的等待上，不在界面上。**
     */
    'for (let i = 0; i < 24 && !document.querySelector("[data-action=\\"device-add\\"]"); i += 1) await wait(250);' +
    'const add = document.querySelector("[data-action=\\"device-add\\"]");' +
    'const slot = document.querySelector("#topbar-page-slot");' +
    'const content = document.querySelector(".app-content");' +
    'return JSON.stringify({' +
    '  addButtonPresent: !!add,' +
    // 第 5 条：入口在顶栏那一格里，而且**不在**内容区里。
    '  addInsideTopbarSlot: !!(add && slot && slot.contains(add)),' +
    '  addInsideContent: !!(add && content && content.contains(add)),' +
    '  addIsAdminGated: !!add,' +
    '  treesOnEveryPage: document.querySelectorAll(".device-tree").length,' +
    '  pageTitles: [...document.querySelectorAll(".page-title")].map((n) => n.textContent.trim())' +
    '});})()')
  log('devices chrome: ' + JSON.stringify(devicesChrome))
  /*
   * 超时那一支**只报超时**，不读字段：`layout()` 已经推了一条问题，这里再读
   * `devicesChrome.pageTitles.length` 会抛 `TypeError`，把整份报告一起带走
   * （2026-09-18 实测：就是这一行让一次运行白跑）。
   */
  if (devicesChrome.probeTimeout === true) {
    problems.push('设备管理页的界面断言超时（30 秒没有返回）—— 这一段没有任何结论')
  } else {
    if (!devicesChrome.addButtonPresent) problems.push('设备管理页找不到「添加设备」按钮（data-action="device-add"）')
    if (!devicesChrome.addInsideTopbarSlot) problems.push('「添加设备」不在顶栏那一格（#topbar-page-slot）里')
    if (devicesChrome.addInsideContent) problems.push('「添加设备」仍然在右侧内容区里')
    if (devicesChrome.treesOnEveryPage > 0) {
      problems.push('设备管理页出现了设备拓扑（第 5 条已整棵下架）')
    }
    if (devicesChrome.pageTitles.length > 0) {
      problems.push('设备管理页仍然有页面标题：' + JSON.stringify(devicesChrome.pageTitles))
    }
  }

  /*
   * 这一段**只读**，所以必须排在所有写设备/写库的探针之前（那是本仓库的一条硬规矩：
   * 写操作的探针排在最后，免得把只读探针看到的状态改掉）。第 13/14/17 条的地图版面断言
   * 不依赖"声呐那一台已经加进来"——它只要求图例上的数与图上的落点数对得上。
   */
  /**
   * 地图信息（GIS）的版面与落点配色（业主 2026-09-18 第 13/14/17 条）。
   *
   * 三段断言都只能量 DOM：
   *   ① **16:9 且占满内容宽度**（第 13 条）：量 `[data-map-canvas-frame]` 的宽高比与它
   *      左右两边到内容盒的距离。比例只在 CSS 里写着"16 / 9"是不够的 —— 一个
   *      `max-height` 就会把它压成别的比例，而那在屏幕上是"图看起来扁了一点"。
   *   ② **落点三种色调**（第 14 条）：每个标记都有 `data-marker-tone`，取值只能是那三个；
   *      图例三档各有一个数，且**数与图上的标记数对得上**（对不上说明图例是写死的）。
   *   ③ **地图下方依次三张列表**（第 17 条）：按 `getBoundingClientRect().top` 排序，
   *      而不是按 DOM 顺序 —— 后者可以由 CSS 的 `order` 反过来。
   *
   * 这一段跑在声呐那一台**已经加进来**之后，所以图上至少有一个标记（探针不依赖"恰好三个"）。
   */
  const mapLayout = await layout('/map', '(() => {' +
    'const round = (n) => Math.round(n);' +
    'const rectOf = (el) => { const r = el.getBoundingClientRect();' +
    '  return { left: round(r.left), top: round(r.top), width: round(r.width), height: round(r.height), right: round(r.right) }; };' +
    'const frame = document.querySelector("[data-map-canvas-frame]");' +
    'const panel = document.querySelector("[data-map-panel]");' +
    'const content = document.querySelector(".app-content");' +
    'if (!frame || !panel || !content) return JSON.stringify({ found: false,' +
    '  hasFrame: !!frame, hasPanel: !!panel, hasContent: !!content });' +
    'const contentStyle = getComputedStyle(content);' +
    'const contentBox = {' +
    '  left: content.getBoundingClientRect().left + (parseFloat(contentStyle.paddingLeft) || 0),' +
    '  right: content.getBoundingClientRect().left + content.clientWidth - (parseFloat(contentStyle.paddingRight) || 0)' +
    '};' +
    'const frameRect = frame.getBoundingClientRect();' +
    'const markers = [...document.querySelectorAll("[data-map-marker]")];' +
    'const tones = markers.map((m) => m.getAttribute("data-marker-tone"));' +
    /*
     * 第 11 批第 4 条：地图右上角那条**半透明状态栏**。
     * 五个读数 + 三条样式（位置、半透明、不吃鼠标事件）—— 样式只能量，源码里写了也可能被盖掉。
     */
    'const status = document.querySelector("[data-map-statusbar]");' +
    'const statusStyle = status ? getComputedStyle(status) : null;' +
    'const statusRect = status ? status.getBoundingClientRect() : null;' +
    'const statusItems = status ? [' +
    '  ["mapped", "[data-map-status-mapped]"], ["total", "[data-map-status-total]"],' +
    '  ["online", "[data-map-status-online]"], ["offline", "[data-map-status-offline]"],' +
    '  ["alarms", "[data-map-status-alarms]"]]' +
    '  .map((pair) => { const el = status.querySelector(pair[1]);' +
    '    return { key: pair[0], text: (el ? (el.textContent || "") : "").replace(/\\s+/g, " ").trim(),' +
    '      alarmKnown: el ? el.getAttribute("data-map-status-alarm-known") : null }; }) : [];' +
    /*
     * 第 11 批第 5 条：左设备列表 / 右告警列表，两栏等宽、**两张卡一样高**。
     * 高度只能量（CSS 里那一层绝对定位就是为了这件事），所以这里读两个卡片的矩形。
     */
    'const rectFull = (el) => { if (!el) return null; const r = el.getBoundingClientRect();' +
    '  return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom),' +
    '    width: round(r.width), height: round(r.height) }; };' +
    'const devicesCard = rectFull(document.querySelector("[data-map-devices]"));' +
    'const alarmsCard = rectFull(document.querySelector("[data-map-alarms]"));' +
    'const deviceHeadings = [...document.querySelectorAll("[data-map-devices] thead th")]' +
    '  .map((th) => (th.textContent || "").trim());' +
    // 三张列表：按**屏幕上的纵坐标**排序（DOM 里的顺序可以由 CSS 改掉）。
    'const blocks = ["data-map-devices", "data-map-alarms", "data-map-live"]' +
    '  .map((name) => {' +
    '    const el = document.querySelector("[" + name + "]");' +
    '    return el ? { name: name, top: round(el.getBoundingClientRect().top) } : { name: name, top: null };' +
    '  });' +
    'const liveHeadings = [...document.querySelectorAll("[data-map-live] thead th")]' +
    '  .map((th) => (th.textContent || "").trim());' +
    'const liveRows = [...document.querySelectorAll("[data-map-live] tbody tr")].map((tr) =>' +
    '  [...tr.querySelectorAll("td")].map((td) => (td.textContent || "").replace(/\\s+/g, " ").trim()));' +
    'const deviceRows = document.querySelectorAll("[data-map-device-row]").length;' +
    'return JSON.stringify({' +
    '  found: true,' +
    '  frame: rectOf(frame),' +
    '  ratio: frameRect.height > 0 ? Math.round((frameRect.width / frameRect.height) * 10000) / 10000 : null,' +
    '  frameLeftGapPx: round(frameRect.left - contentBox.left),' +
    '  frameRightGapPx: round(contentBox.right - frameRect.right),' +
    '  contentBoxWidth: round(contentBox.right - contentBox.left),' +
    '  canvasPresent: !!document.querySelector("[data-map-canvas]"),' +
    /*
     * 被业主第 11 批第 4、5 条点名删掉的那几块：**一个都不许剩**。
     * 数出来的都是 0 才是"删干净了"（渲染出来的元素，不是源码）。
     */
    '  removedBlocks: {' +
    '    counts: document.querySelectorAll("[data-map-counts]").length,' +
    '    legend: document.querySelectorAll("[data-map-legend]").length,' +
    '    emptyNotice: document.querySelectorAll("[data-map-empty]").length,' +
    '    withoutPoint: document.querySelectorAll("[data-map-without-point]").length' +
    '  },' +
    '  status: {' +
    '    present: !!status,' +
    '    items: statusItems,' +
    '    position: statusStyle ? statusStyle.position : null,' +
    '    backgroundColor: statusStyle ? statusStyle.backgroundColor : null,' +
    '    pointerEvents: statusStyle ? statusStyle.pointerEvents : null,' +
    '    rect: statusRect ? { top: round(statusRect.top), right: round(statusRect.right),' +
    '      width: round(statusRect.width), height: round(statusRect.height) } : null,' +
    '    frameRect: { top: round(frameRect.top), right: round(frameRect.right),' +
    '      left: round(frameRect.left), bottom: round(frameRect.bottom) }' +
    '  },' +
    '  split: {' +
    '    present: !!document.querySelector("[data-map-split]"),' +
    '    devices: devicesCard,' +
    '    alarms: alarmsCard,' +
    '    contentBoxWidth: round(contentBox.right - contentBox.left)' +
    '  },' +
    '  deviceHeadings: deviceHeadings,' +
    /*
     * 翻页（第 5 条：默认最多 10 台，超过就翻页）。操作员库里只有个位数设备，
     * 所以这里量到的是"**不该**出现翻页控件"；判据写成"出现 ⇔ 超过 10 台"，
     * 换一份数据（>10 台）时这条断言自动变成另一头。
     */
    '  pagerPresent: !!document.querySelector("[data-map-pager]"),' +
    '  pageStatusText: (function(){ const el = document.querySelector("[data-map-page-status]");' +
    '    return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : null; })(),' +
    '  markerCount: markers.length,' +
    '  tones: tones,' +
    '  blocks: blocks,' +
    '  deviceRows: deviceRows,' +
    '  liveHeadings: liveHeadings,' +
    '  liveRowCount: liveRows.length,' +
    /*
     * 第 3 列 = **平稳度**（业主 2026-09-19 澄清之后取最近一条告警的 `smoothness`）。
     * `stabilityHint` 保留但含义反了：它现在读的是"没有数据源"那个钩子，**应当为空**。
     */
    '  smoothnessColumn: liveRows.map((cells) => cells[2]),' +
    '  smoothnessCells: [...document.querySelectorAll("[data-live-smoothness]")]' +
    '    .map((el) => el.getAttribute("data-live-smoothness")),' +
    '  stabilityHint: (() => {' +
    '    const el = document.querySelector("[data-live-no-source]");' +
    '    return el ? (el.getAttribute("title") || "").slice(0, 120) : null;' +
    '  })(),' +
    /*
     * 第 15、16 条：**悬停浮层**。这一段跑在加设备之前，所以 operator 库那三台
     * （如果一台点位都没录）可能没有标记 —— 那时如实跳过，并在报告里写清楚。
     *
     * 浮层里**不许有 `<video>`**（一条会话只有一个观看者，悬停接管会踢掉正在看的人），
     * 所以这里也数一遍 video 的个数：它是这一条最容易被下一个人"顺手加上"的东西。
     */
    '  hoverMarker: (function(){ const m = document.querySelector("[data-map-marker]");' +
    '    if (!m) return null;' +
    '    m.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));' +
    '    return m.getAttribute("data-map-marker"); })(),' +
    '  hoverPresent: (function(){ return !!document.querySelector("[data-map-hover]"); })(),' +
    '  hoverVideoCount: document.querySelectorAll("[data-map-hover] video").length' +
    '});' +
    '})()')
  log('map layout    : ' + JSON.stringify(mapLayout))
  if (mapLayout.found !== true) {
    problems.push('地图信息（GIS）页没有量到地图区：' + JSON.stringify(mapLayout))
  } else {
    // ① 16:9 与占满宽度。
    const want = 16 / 9
    if (mapLayout.ratio === null || Math.abs(mapLayout.ratio - want) > 0.02) {
      problems.push(
        '地图区不是 16:9：宽高比 ' + mapLayout.ratio + '（应为 ' + want.toFixed(4) + '）'
      )
    }
    if (mapLayout.frameLeftGapPx > GAP_TOLERANCE_PX || mapLayout.frameRightGapPx > GAP_TOLERANCE_PX) {
      problems.push(
        '地图区没有占满内容宽度：左空 ' + mapLayout.frameLeftGapPx + 'px、右空 ' +
        mapLayout.frameRightGapPx + 'px'
      )
    }
    if (Math.abs(mapLayout.frame.width - mapLayout.contentBoxWidth) > GAP_TOLERANCE_PX) {
      problems.push(
        '地图区的宽度与内容盒不一致：' + mapLayout.frame.width + ' vs ' + mapLayout.contentBoxWidth
      )
    }
    // 第 11 批第 4 条：画布**不再**取决于有没有落点（"有设备就画"，空图看起来才不像坏了）。
    if (mapLayout.deviceRows > 0 && mapLayout.canvasPresent !== true) {
      problems.push(
        '这一页有设备，却没有画布（第 11 批第 4 条之后画布与"有没有落点"无关）：' +
        JSON.stringify({ deviceRows: mapLayout.deviceRows, canvas: mapLayout.canvasPresent })
      )
    }
    // 被删掉的那四块一个都不许剩。
    for (const [label, count] of Object.entries(mapLayout.removedBlocks || {})) {
      if (count > 0) {
        problems.push(
          '第 11 批第 4/5 条已删掉的 ' + label + ' 还在页面上（' + count + ' 个）：' +
          '「图上 N 台 / 共 M 台」读数 / 图例 / "还没有任何设备录入点位" 那句 / 「未录入点位设备」卡片'
        )
      }
    }

    // ② 落点配色（图例已删，颜色由落点与实时数据列表那个带 title 的点承载）。
    const allowed = ['alarm', 'online', 'offline']
    const bad = mapLayout.tones.filter((tone) => !allowed.includes(tone))
    if (bad.length > 0) {
      problems.push('有落点的色调不在 在线绿/告警红/离线灰 这三档里：' + JSON.stringify(bad))
    }

    // ②b 地图右上角的半透明状态栏（第 4 条）。
    /*
     * 状态栏里的「共 M 台」是**设备总数**（设备列表按 10 台一页，`deviceRows` 只是当前页）。
     * 下面翻页与实时数据列表两条断言要的都是总数，所以从这里取。
     */
    let statusTotalDevices = null
    {
      const status = mapLayout.status || {}
      if (!status.present) {
        problems.push('地图右上角没有状态栏（[data-map-statusbar]）')
      } else {
        const items = status.items || []
        const expectedKeys = ['mapped', 'total', 'online', 'offline', 'alarms']
        if (JSON.stringify(items.map((item) => item.key)) !== JSON.stringify(expectedKeys)) {
          problems.push('状态栏的五个读数不齐：' + JSON.stringify(items.map((item) => item.key)))
        }
        for (const item of items) {
          if (!item.text) problems.push('状态栏的「' + item.key + '」是空的')
        }
        // 数字必须是真的：图上 N 台 = 落点数，共 M 台 = 设备表的行数（翻页之后也按总数算）。
        const byKey = Object.fromEntries(items.map((item) => [item.key, item.text]))
        const mapped = Number((String(byKey.mapped).match(/(\d+)/) || [])[1])
        const total = Number((String(byKey.total).match(/(\d+)/) || [])[1])
        if (mapped !== mapLayout.markerCount) {
          problems.push('状态栏「图上」的数和落点数不一致：' + byKey.mapped + ' vs ' + mapLayout.markerCount)
        }
        if (!Number.isFinite(total) || total < mapLayout.deviceRows) {
          problems.push('状态栏「共」的数比设备表的行数还小：' + byKey.total + ' vs ' + mapLayout.deviceRows)
        }
        if (Number.isFinite(total)) statusTotalDevices = total
        /*
         * 告警那一项：读不到时必须是「—」而不是 0（`data-map-status-alarm-known=no`），
         * 读到时就该与下面告警列表里的条数**方向一致**（这里只判"不是空"）。
         */
        const alarmItem = items.find((item) => item.key === 'alarms') || {}
        if (alarmItem.alarmKnown !== 'yes' && alarmItem.alarmKnown !== 'no') {
          problems.push('状态栏的告警项没有把"读没读到"暴露出来：' + JSON.stringify(alarmItem))
        }
        if (alarmItem.alarmKnown === 'no' && !String(alarmItem.text).includes('—')) {
          problems.push('告警数没读到，状态栏却没有写「—」：' + JSON.stringify(alarmItem.text))
        }
        // 位置：在画布**里面**、贴着右上角。
        if (status.position !== 'absolute') {
          problems.push('状态栏不是绝对定位（它应当浮在地图右上角）：' + status.position)
        }
        const rect = status.rect
        const frameRect = status.frameRect
        if (!rect || !frameRect) {
          problems.push('量不到状态栏或画布的位置')
        } else {
          if (rect.top < frameRect.top || rect.top > frameRect.top + 60) {
            problems.push('状态栏不在画布上边附近：top=' + rect.top + ' 画布 top=' + frameRect.top)
          }
          if (Math.abs(rect.right - frameRect.right) > 40 || rect.right > frameRect.right) {
            problems.push('状态栏不在画布右边附近（或压在画布外面）：right=' + rect.right +
              ' 画布 right=' + frameRect.right)
          }
        }
        // 半透明：`color-mix()` 在 Chromium 里算出来可能是 `rgba(...)`，也可能是
        // `color(srgb r g b / a)` —— 两种都要能读出 alpha（第一版只认前一种，于是把
        // 一个**半透明的**状态栏报成了"背景色读不出来"）。
        const raw = String(status.backgroundColor || '')
        const rgbaMatch = /rgba?\(([^)]*)\)/.exec(raw)
        const srgbMatch = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\)/.exec(raw)
        const alpha = rgbaMatch
          ? (() => {
              const parts = rgbaMatch[1].split(',').map((part) => part.trim())
              return parts.length >= 4 ? Number(parts[3]) : 1
            })()
          : srgbMatch
            ? Number(srgbMatch[4])
            : Number.NaN
        if (!Number.isFinite(alpha)) {
          problems.push('状态栏的背景色读不出来：' + JSON.stringify(status.backgroundColor))
        } else if (!(alpha > 0 && alpha < 1)) {
          problems.push('状态栏不是半透明（alpha=' + alpha + '）：' + status.backgroundColor)
        }
        // 不吃鼠标事件：它压着画布，而落点是可点的。
        if (status.pointerEvents !== 'none') {
          problems.push('状态栏会吃掉鼠标事件（pointer-events=' + status.pointerEvents + '）')
        }
      }
    }

    // ③ 地图下方：左设备列表 / 右告警列表（第 5 条，**同一行**），最后是整幅宽的实时数据列表。
    const tops = mapLayout.blocks.map((block) => block.top)
    if (tops.some((top) => top === null)) {
      problems.push('三张列表没有齐：' + JSON.stringify(mapLayout.blocks))
    } else if (Math.abs(tops[0] - tops[1]) > 2) {
      problems.push(
        '设备列表与告警列表不在同一行（第 5 条要求"右侧是告警列表"）：' +
        JSON.stringify(mapLayout.blocks)
      )
    } else if (!(tops[1] < tops[2])) {
      problems.push(
        '实时数据列表不在那两栏下面（应为 设备列表 + 告警列表 → 实时数据列表）：' +
        JSON.stringify(mapLayout.blocks)
      )
    }
    // 它们必须都在地图区**下面**。
    if (tops.every((top) => top !== null) && !(mapLayout.frame.top < tops[0])) {
      problems.push('第一张列表不在地图区下面：' + JSON.stringify(mapLayout.blocks))
    }
    if (mapLayout.deviceRows < 1) {
      problems.push('设备列表里一行都没有')
    }
    // ③a 设备列表只有三列（序号 / 设备名称 / 状态）。
    {
      const headings = mapLayout.deviceHeadings || []
      if (JSON.stringify(headings) !== JSON.stringify(['序号', '设备名称', '状态'])) {
        problems.push('设备列表不是 序号/设备名称/状态 三列：' + JSON.stringify(headings))
      }
    }
    // ③b 两栏并排、等宽、**一样高**。
    {
      const split = mapLayout.split || {}
      const devices = split.devices
      const alarms = split.alarms
      if (!split.present || !devices || !alarms) {
        problems.push('地图下面不是"左设备列表 + 右告警列表"两栏：' + JSON.stringify(split))
      } else {
        if (!(devices.right <= alarms.left + 1)) {
          problems.push('告警列表不在设备列表右侧：设备 right=' + devices.right + ' 告警 left=' + alarms.left)
        }
        if (Math.abs(devices.top - alarms.top) > 2) {
          problems.push('两张卡的上边缘没对齐：' + JSON.stringify({ devices: devices.top, alarms: alarms.top }))
        }
        if (Math.abs(devices.height - alarms.height) > 2) {
          problems.push(
            '告警列表卡片的高度与左侧设备列表不一致（第 5 条）：' +
            devices.height + ' vs ' + alarms.height
          )
        }
        // 半幅宽（业主："宽度调整为现在的 50%"）。
        const half = split.contentBoxWidth / 2
        if (Math.abs(devices.width - half) > 8) {
          problems.push(
            '设备列表不是内容宽度的一半：' + devices.width + ' vs ' + Math.round(half) +
            '（内容宽 ' + split.contentBoxWidth + '）'
          )
        }
      }
    }
    // ③c 翻页控件：只有**总数**超过 10 台才出现。
    const totalDevices = statusTotalDevices ?? mapLayout.deviceRows
    if (totalDevices <= 10 && mapLayout.pagerPresent) {
      problems.push('设备不超过 10 台，却出现了翻页控件（第 5 条：默认最多 10 台才翻页）')
    }
    if (totalDevices > 10 && !mapLayout.pagerPresent) {
      problems.push('设备超过 10 台，却没有翻页控件：' + totalDevices + ' 台')
    }
    if (mapLayout.pagerPresent && !mapLayout.pageStatusText) {
      problems.push('翻页控件里没有"第 N 页 / 共 M 页"读数')
    }

    // ④ 实时数据列表的四列与「稳定度」那一列。
    if (mapLayout.liveHeadings.length !== 4) {
      problems.push('实时数据列表不是四列：' + JSON.stringify(mapLayout.liveHeadings))
    }
    if (mapLayout.liveRowCount !== totalDevices) {
      problems.push(
        '实时数据列表的行数与设备总数不一致：' + mapLayout.liveRowCount + ' vs ' + totalDevices +
        '（它列的是全部设备，不跟设备列表那一页走）'
      )
    }
    /*
     * 「平稳度」那一列（业主 2026-09-19 澄清「用平稳度表示」之后**不再是空列**）：
     * 它取最近一条告警的 `smoothness`，所以这里要求那一格**有一个真实的值或「—」**，
     * 并且**不许**再有"没有数据源"那套写法（`data-live-no-source`）。
     */
    const smoothness = mapLayout.smoothnessColumn || []
    if (smoothness.length > 0 && smoothness.some((value) => value === undefined || value === '')) {
      problems.push('「平稳度」那一列有空单元格：' + JSON.stringify(smoothness))
    }
    if (mapLayout.stabilityHint !== null) {
      problems.push('「平稳度」表头还挂着"没有数据源"那句说明（业主已澄清这一列取 smoothness）')
    }
    /*
     * 第 15、16 条：悬停浮层。**必须在有标记时断言**；operator 库那三台都没录点位时
     * 如实跳过（那时图上是空的经纬度网格 + 右上角的状态栏写着"图上 0 台"，没有可悬停的东西）。
     */
    if (mapLayout.markerCount > 0) {
      if (mapLayout.hoverMarker === null || mapLayout.hoverPresent !== true) {
        problems.push(
          '悬停一个标记之后没有出现浮层（第 15、16 条）：' +
          JSON.stringify({ marker: mapLayout.hoverMarker, present: mapLayout.hoverPresent })
        )
      }
      if (mapLayout.hoverVideoCount > 0) {
        problems.push(
          '浮层里出现了 <video>（' + mapLayout.hoverVideoCount + ' 个）：主进程对一台相机只有一条会话、' +
          '一条会话只有一个观看者，悬停接管会把正在看这一路的人的画面当场换掉'
        )
      }
    } else {
      log(
        'map hover     : skipped（图上没有标记：operator 库那几台都没录完整点位）——' +
        ' **悬停浮层这一次没有量到**'
      )
    }
  }
  /**
   * 添加设备对话框：**没有机型选择**，但安装信息四个框都在（业主 2026-09-17 第 1、2 条）。
   *
   * 这一条必须无条件断言，而且**两边都要**断：
   *   - 机型控件一个都不能有（`.kind__radio` / `.kind__name` 为 0）—— 留着它，界面就仍然在让
   *     操作员做"选哪套协议"这道判断题，而这正是第 2 条要消掉的东西；
   *   - 四个点位输入框必须在（第 1 条）—— 少了任何一个都不会报错，只会让那一项永远录不进去。
   *
   * "控件没渲染"与"没有数据"在这类探针里长得一样（§15.13.5），所以数量必须写死。
   */
  const addDialog = await layout('/devices', '(() => {' +
    // 入口在顶栏那一格里（第 5 条），按稳定的探针钩子找，不按文字找：
    // 文字随语言变，而这个钩子在四个语言里都是同一个。
    'const add = document.querySelector("[data-action=\\"device-add\\"]");' +
    'if (!add) return JSON.stringify({ opened: false });' +
    'add.click();' +
    'return new Promise((resolve) => setTimeout(() => {' +
    '  const dialog = document.querySelector("[data-add-device-dialog]");' +
    /*
     * 第 13 批第 2 条：「地址信息」**默认收起**。所以这里先量收起时的样子
     * （那三个输入框**不在 DOM 里**），再点一下那颗按钮量展开后的样子。
     */
    '  const toggle = dialog ? dialog.querySelector("[data-action=toggle-add-installation]") : null;' +
    '  const out = {' +
    '    opened: !!dialog,' +
    '    kindControls: dialog ? dialog.querySelectorAll(".kind__radio, .kind__name, select[name=kind]").length : -1,' +
    '    hasLead: !!(dialog && dialog.querySelector(".add__lead")),' +
    '    collapsePresent: !!toggle,' +
    '    expandedInitially: toggle ? toggle.getAttribute("aria-expanded") : null,' +
    '    inputsWhenCollapsed: dialog ? dialog.querySelectorAll(".install input.input").length : -1,' +
    '    summaryWhenCollapsed: (function(){ const s = dialog ? dialog.querySelector(".collapse__summary") : null;' +
    '      return s ? s.textContent.trim() : null; })()' +
    '  };' +
    '  if (toggle) toggle.click();' +
    '  resolve(new Promise((done) => setTimeout(() => {' +
    '    out.expandedAfterClick = toggle ? toggle.getAttribute("aria-expanded") : null;' +
    '    out.installInputs = dialog ? dialog.querySelectorAll(".install input.input").length : -1;' +
    '    out.installPoints = dialog ? [...dialog.querySelectorAll(".install .field-label")]' +
    '      .map((n) => n.textContent.trim()) : [];' +
    '    out.inputsStillThere = dialog ? dialog.querySelectorAll(".install input.input").length : -1;' +
    '    done(JSON.stringify(out));' +
    '  }, 250)));' +
    '}, 300));})()')
  log('add dialog    : ' + JSON.stringify(addDialog))
  if (!addDialog.opened) {
    problems.push('点「添加设备」没有打开对话框（找不到 [data-add-device-dialog]）')
  } else {
    if (addDialog.kindControls !== 0) {
      problems.push(
        '添加设备对话框里还有机型选择控件（第 2 条要求协议自动匹配）：' + addDialog.kindControls
      )
    }
    if (!addDialog.hasLead) problems.push('添加设备对话框里没有那句"不用选机型"的说明')
    /*
     * 第 13 批第 2 条：「地址信息」默认收起 —— 收起时那三个输入框**不在 DOM 里**，
     * 点一下那颗按钮之后才出现（而且点名要"真的不在"，不是 CSS 藏起来：后者会让
     * 键盘用户 Tab 进一段看不见的表单）。
     */
    if (!addDialog.collapsePresent) {
      problems.push('「地址信息」没有那颗展开/收起按钮（[data-action=toggle-add-installation]）')
    }
    if (addDialog.expandedInitially !== 'false') {
      problems.push('「地址信息」默认不是收起的：aria-expanded=' + JSON.stringify(addDialog.expandedInitially))
    }
    if (addDialog.inputsWhenCollapsed !== 0) {
      problems.push(
        '「地址信息」收起时输入框仍然在 DOM 里（' + addDialog.inputsWhenCollapsed + ' 个）'
      )
    }
    if (!String(addDialog.summaryWhenCollapsed || '').trim()) {
      problems.push('收起时那一行没有说"填了没有"')
    }
    if (addDialog.expandedAfterClick !== 'true') {
      problems.push('点了那颗按钮之后「地址信息」没有展开：' + JSON.stringify(addDialog.expandedAfterClick))
    }
    // 业主 2026-09-18 第 10 条删掉了基准声压级，所以是**三个**输入框（经纬度 + 方位角）。
    if (addDialog.installInputs !== 3) {
      problems.push(
        '展开之后地址信息输入不是三个（第 10 条删掉了基准声压级）：' + addDialog.installInputs
      )
    }
    for (const label of ['纬度', '经度', '方位角']) {
      if (!(addDialog.installPoints || []).some((text) => text.includes(label))) {
        problems.push('地址信息里没有「' + label + '」这一项：' + JSON.stringify(addDialog.installPoints))
      }
    }
    if ((addDialog.installPoints || []).some((text) => text.includes('基准声压级'))) {
      problems.push(
        '地址信息里又出现了「基准声压级」（第 10 条要求删除）：' + JSON.stringify(addDialog.installPoints)
      )
    }
  }


  /*
   * 逐路由扫一遍**页面级**标题。
   *
   * 断言刻意只针对两件事，而不是"`.page` 里不许有任何 h1/h2"：
   *   1. `.page-title` 这个类不许回来（它就是被删掉的那个页面标题）；
   *   2. `.page` 的**第一个**元素不许是 h1/h2（那才是"页面标题"的位置）。
   * 因为 `.page` 里面合法的段落标题是存在的 —— 总览页的「通道墙」就标着这一页两块内容
   * 里的第二块。第一版断言把任何 h2 都算成违规，于是把「通道墙」报成了问题：那是
   * **断言写得太宽**，不是界面错了。
   */
  const titlesByRoute = {}
  /*
   * 顺带量**每一页的左上间距**（业主 2026-09-19 更正第 5 条：
   * 「每个分页面的布局，内容距离左侧和上侧应该是保持一致的」）。
   *
   * 量的是 `.page` 相对 `.app-content` **内容盒**（padding 之内、滚动条之外）的偏移：
   * 只要有人给某一页加了页头、外边距或内边距，这个数就会与别页不同 —— 而"看起来差不多"
   * 正是业主报这条时看到的处境。
   */
  const layoutByRoute = {}
  for (const [name, route] of ROUTES) {
    const state = await layout(route, '(() => {' +
      '  const page = document.querySelector(".page");' +
      '  const first = page ? page.firstElementChild : null;' +
      '  const leading = first && /^(H1|H2)$/.test(first.tagName)' +
      '    ? first.textContent.trim().slice(0, 40) : "";' +
      '  const content = document.querySelector(".app-content");' +
      '  const cs = content ? getComputedStyle(content) : null;' +
      '  const box = content ? {' +
      '    left: content.getBoundingClientRect().left + (parseFloat(cs.paddingLeft) || 0),' +
      '    top: content.getBoundingClientRect().top + (parseFloat(cs.paddingTop) || 0)' +
      '  } : null;' +
      '  const rect = page ? page.getBoundingClientRect() : null;' +
      /*
       * `.page` 自己在 0/0 并不等于"内容从 0/0 开始"：页面里第一个**有盒子**的子元素
       * 可能带着外边距或内边距（`.card` 的内边距、扁平段的上边线 + padding-block）。
       * 业主说的"内容距离左侧和上侧"是**眼睛看到的那个起点**，所以这里量它的左上角。
       */
      '  const kids = page ? Array.prototype.slice.call(page.children) : [];' +
      '  const firstBox = kids.find((el) => el.getBoundingClientRect().height > 0) || null;' +
      '  const fr = firstBox ? firstBox.getBoundingClientRect() : null;' +
      '  const fs = firstBox ? getComputedStyle(firstBox) : null;' +
      '  const inner = firstBox ? {' +
      '    left: fr.left + (parseFloat(fs.paddingLeft) || 0) + (parseFloat(fs.borderLeftWidth) || 0),' +
      '    top: fr.top + (parseFloat(fs.paddingTop) || 0) + (parseFloat(fs.borderTopWidth) || 0)' +
      '  } : null;' +
      '  return JSON.stringify({' +
      '    pageTitleClass: document.querySelectorAll(".page-title").length,' +
      '    leadingHeading: leading,' +
      '    leftGapPx: rect && box ? Math.round(rect.left - box.left) : null,' +
      '    topGapPx: rect && box ? Math.round(rect.top - box.top) : null,' +
      '    contentLeftGapPx: inner && box ? Math.round(inner.left - box.left) : null,' +
      '    contentTopGapPx: inner && box ? Math.round(inner.top - box.top) : null,' +
      /*
       * 更正第 4 条：**页面里不许再有单独的「刷新」按钮**（顶栏那一颗是唯一的）。
       * 逐页数一遍，因为"某一页漏删了一颗"正是这条要求最可能的失败形态。
       */
      '    refreshButtons: [...document.querySelectorAll(".page button")]' +
      '      .filter((b) => /^刷新$/.test((b.textContent || "").trim())).length,' +
      /*
       * 更正第 2 条：页面里不许再有与顶栏重复的标题（`.section-title` 写着页面名）。
       * `leadingHeading` 只管"第一个元素是不是 h1/h2"，管不到"页面名是不是又被写了一遍"。
       */
      '    pageNameInPage: [...document.querySelectorAll(".page .section-title, .page h1, .page h2")]' +
      '      .filter((el) => (el.textContent || "").trim() === (document.querySelector(".topbar__heading") || {}).textContent.trim()).length,' +
      '    firstTag: firstBox ? firstBox.tagName.toLowerCase() + "." + (firstBox.className || "").split(" ")[0] : null' +
      '  });' +
      '})()')
    titlesByRoute[route] = state
    layoutByRoute[route] = {
      left: state.leftGapPx,
      top: state.topGapPx,
      contentLeft: state.contentLeftGapPx,
      contentTop: state.contentTopGapPx,
      first: state.firstTag
    }
    if (state.refreshButtons > 0) {
      problems.push(
        route + ' 里还有 ' + state.refreshButtons + ' 个「刷新」按钮（更正第 4 条：只留顶栏那一颗）'
      )
    }
    if (state.pageNameInPage > 0) {
      problems.push(
        route + ' 的页面里又写了一遍页面名（更正第 2 条：与顶栏那个标题重复）'
      )
    }
    if (state.pageTitleClass > 0)
      problems.push(route + ' 仍有 .page-title：' + state.pageTitleClass + ' 个')
    if (state.leadingHeading !== '')
      problems.push(route + ' 的 .page 第一个元素又是标题：' + JSON.stringify(state.leadingHeading))
  }
  log('page titles   : ' + JSON.stringify(titlesByRoute))
  /*
   * 各页的左上间距**必须是同一个数**（容差 2px：亚像素与取整）。
   * 判据是**逐页相等**，不是"都小于某个上限"—— 后者会让"某一页多了 8px"永远不被发现。
   */
  {
    const pick = (key) =>
      Object.entries(layoutByRoute)
        .filter(([, value]) => value[key] !== null)
        .map(([route, value]) => [route, value[key]])
    const lefts = pick('left')
    const tops = pick('top')
    log('page spacing  : left=' + JSON.stringify(Object.fromEntries(lefts)) +
      ' top=' + JSON.stringify(Object.fromEntries(tops)))
    for (const [label, pairs] of [['左侧', lefts], ['上侧', tops]]) {
      if (pairs.length === 0) {
        problems.push('量不到任何一页的' + label + '间距（.page / .app-content 没找到？）')
        continue
      }
      const values = pairs.map(([, value]) => value)
      const min = Math.min(...values)
      const max = Math.max(...values)
      if (max - min > 2) {
        problems.push(
          '各页的' + label + '间距不一致（' + min + '–' + max + 'px）：' +
          JSON.stringify(Object.fromEntries(pairs))
        )
      }
    }
    /*
     * **眼睛看到的那个起点**：第一块内容的左上角到内容盒的距离。
     *
     * 这一组只**记录**、不断言逐页相等：它含的是各组件家族自己的内边距
     * （卡片 16px、扁平表 0 + 单元格 8px、页签条 12px、提示条 12px），
     * 而那些是逐个被业主认可过的设计值（卡片是全应用共用的、扁平表是第 2b 条、
     * 画布铺满是第 13 条）。要求它们逐一相等会变成"为了对齐而改掉每一个组件"。
     * 真正断言的是上面那一组：**每一页的第一块都从内容盒的左上角开始（0/0）**。
     */
    const contentLefts = pick('contentLeft')
    const contentTops = pick('contentTop')
    log('page content  : left=' + JSON.stringify(Object.fromEntries(contentLefts)) +
      ' top=' + JSON.stringify(Object.fromEntries(contentTops)) +
      ' first=' + JSON.stringify(Object.fromEntries(
        Object.entries(layoutByRoute).map(([route, value]) => [route, value.first])
      )))
  }

  /**
   * 告警图标那颗面板：**待处理告警 + 系统消息**，而且打开它不许动布局。
   *
   * 业主 2026-09-18 的要求分两句：「认证失败…这些告警内容直接放在右上角的告警 ICON 内，
   * 而不是在软件中进行顶部添加信息」+「要确保整体的布局不会因为告警等内容而改变」。
   * 所以这一段量四件事：
   *   1. `.topbar__error`（修之前那条挂在每一页顶上的浮动横幅）**必须不存在**；
   *   2. 系统消息那一段在面板里，逐条列出来（有几条、都是什么话）；
   *   3. 那几句话**不许**在页面正文里再出现一份（同一个失败不在两处说）；
   *   4. 打开/关闭面板前后，内容区顶边、页面顶边、页面高度、滚动位置、顶栏高度**逐项相同**。
   *
   * 系统消息从哪来（这一段要能自己造出来，否则它只是在"结构存在"上打勾）：先把「告警记录」
   * 页的设备筛选切到一台真设备 —— `AlarmsView` 的 watcher 会去读那台设备的通道表
   * （`devices.loadChannels()`，三条读路径之一）。一次性 profile 里设备的凭据解不开，
   * 这一读**必然失败**，于是系统消息里必然有一条。探针先用同一路 IPC 问一次，据此决定
   * "这一次该不该有那条消息"——不让"环境恰好没有失败"变成一条假缺陷。
   */
  const alarmPanel = await layout('/alarms', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = { steps: [] };' +
    'const box = (el) => {' +
    '  if (!el) return null;' +
    '  const r = el.getBoundingClientRect();' +
    '  return { top: Math.round(r.top), height: Math.round(r.height) };' +
    '};' +
    'const snapshot = () => {' +
    '  const content = document.querySelector(".app-content");' +
    '  const page = document.querySelector(".app-content .page");' +
    '  const topbar = document.querySelector(".topbar");' +
    '  return {' +
    '    contentTop: box(content) ? box(content).top : null,' +
    '    pageTop: box(page) ? box(page).top : null,' +
    '    pageHeight: box(page) ? box(page).height : null,' +
    '    scrollTop: content ? content.scrollTop : null,' +
    '    topbarHeight: box(topbar) ? box(topbar).height : null' +
    '  };' +
    '};' +
    'try {' +
    // ① 先造一次**已知会失败**的读（走界面自己的那条 watcher）
    '  const filterSelects = Array.prototype.slice.call(document.querySelectorAll(".page .filter-bar select"));' +
    '  const deviceSelect = filterSelects[0] || null;' +
    '  out.filterSelects = filterSelects.length;' +
    '  let deviceId = "";' +
    '  if (deviceSelect) {' +
    '    const option = Array.prototype.slice.call(deviceSelect.options).find((o) => o.value);' +
    '    deviceId = option ? option.value : "";' +
    '    out.deviceOption = option ? (option.textContent || "").trim() : null;' +
    '    if (deviceId) {' +
    '      deviceSelect.value = deviceId;' +
    '      deviceSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '      await sleep(1200);' +
    '    }' +
    '  }' +
    // 同一路 IPC 问一次：这一次环境到底能不能读出通道表
    '  let channelsOk = null;' +
    '  if (deviceId) {' +
    '    const probe = await window.api.devices.getChannels(deviceId);' +
    '    channelsOk = !!(probe && probe.success);' +
    '    out.channelsProbeOk = channelsOk;' +
    '  }' +
    // ② 页面正文（面板**不在**这棵树里）里有没有那条浮动横幅、有没有那些话
    '  out.topbarErrorBanners = document.querySelectorAll(".topbar__error").length;' +
    '  const contentEl = document.querySelector(".app-content");' +
    '  out.pageTextBefore = contentEl ? (contentEl.textContent || "").replace(/\\s+/g, " ").trim() : "";' +
    '  out.layoutClosed = snapshot();' +
    '  const bell = document.querySelector(".alarm-badge__button");' +
    '  if (!bell) return JSON.stringify({ found: false });' +
    '  bell.click();' +
    '  await sleep(400);' +
    '  const panel = document.querySelector(".alarm-panel");' +
    '  const badge = document.querySelector(".alarm-badge__count");' +
    '  const problemsBlock = document.querySelector("[data-app-notices]");' +
    '  const problemRows = problemsBlock' +
    '    ? Array.prototype.slice.call(problemsBlock.querySelectorAll("[data-app-notice]")) : [];' +
    '  out.found = true;' +
    '  out.panelOpen = !!panel;' +
    '  out.text = panel ? panel.textContent.replace(/\\s+/g, " ").trim().slice(0, 160) : "";' +
    '  out.itemCount = panel ? panel.querySelectorAll(".alarm-item").length : -1;' +
    '  out.badge = badge ? badge.textContent.trim() : "";' +
    /*
     * 业主 2026-09-19 第 2 条：**设备推送过来的告警要显示在告警图标上**。
     * 所以这里量那个新分区的条数，并且要求它**读的是主进程的告警表**
     * （同一时刻用同一路 IPC 问一次未确认条数，两者必须对得上）。
     */
    '  const deviceBlock = panel ? panel.querySelector("[data-bell-device-alarms]") : null;' +
    '  out.deviceAlarmRows = deviceBlock ? deviceBlock.querySelectorAll("[data-bell-alarm-id]").length : 0;' +
    '  out.deviceAlarmEmpty = !!(panel && panel.querySelector("[data-bell-device-empty]"));' +
    '  const direct = await window.api.alarms.query({ acknowledged: false, limit: 20 });' +
    '  out.ipcUnacknowledged = direct && direct.success ? (direct.data ? direct.data.total : null) : null;' +
    '  out.ipcRows = direct && direct.success && direct.data ? direct.data.items.length : null;' +
    '  out.bellDot = !!document.querySelector("[data-bell-problem]");' +
    '  out.bellLabel = bell.getAttribute("aria-label") || "";' +
    '  out.noticeSection = !!problemsBlock;' +
    '  out.noticeCount = problemRows.length;' +
    '  out.noticeTexts = problemRows.map((row) =>' +
    '    (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120));' +
    '  out.layoutOpen = snapshot();' +
    '  bell.click();' +
    '  await sleep(250);' +
    '  out.panelClosed = !document.querySelector(".alarm-panel");' +
    '  out.layoutAfterClose = snapshot();' +
    '  out.ok = true;' +
    '} catch (error) {' +
    '  out.error = error && error.message ? error.message : String(error);' +
    '}' +
    'return JSON.stringify(out);' +
    '})()', 90_000)
  log('alarm panel   : ' + JSON.stringify(alarmPanel))
  if (alarmPanel.probeTimeout) {
    problems.push('告警面板探针超时 —— 这一段没有任何结论')
  } else if (alarmPanel.error) {
    problems.push('告警面板探针抛异常：' + alarmPanel.error + '：' + JSON.stringify(alarmPanel))
  } else if (!alarmPanel.found) {
    problems.push('顶栏找不到告警图标（.alarm-badge__button）')
  } else if (!alarmPanel.panelOpen) {
    problems.push('点告警图标没有打开面板')
  } else {
    if (alarmPanel.itemCount === 0 && !alarmPanel.text.includes('当前无告警')) {
      problems.push('没有待处理告警时，面板没有写「当前无告警」：' + JSON.stringify(alarmPanel.text))
    }
    /*
     * 角标与列表同源：角标数 = **设备告警**那一分区的总条数（`total`，可能多于列出的行）。
     * 所以判据是「角标数 == 同一路 IPC 报的未确认总数」，而不是「== 面板里 `.alarm-item` 的条数」
     * —— 面板里现在有**两段**列表（设备告警 + 联动），把两段加起来的数才是原先那条断言的口径。
     */
    const badgeCount = alarmPanel.badge === '' ? 0 : Number(alarmPanel.badge)
    if (alarmPanel.ipcUnacknowledged !== null && badgeCount !== alarmPanel.ipcUnacknowledged) {
      problems.push(
        '角标数（' + alarmPanel.badge + '）与主进程报的未确认设备告警数（' +
          alarmPanel.ipcUnacknowledged + '）不一致 —— 角标必须数"设备推来的告警"'
      )
    }
    // 面板里那个分区必须与同一路 IPC 同一时刻的读数对得上。
    if (alarmPanel.ipcRows !== null && alarmPanel.deviceAlarmRows !== alarmPanel.ipcRows) {
      problems.push(
        '面板里的设备告警条数（' + alarmPanel.deviceAlarmRows + '）与主进程的读数（' +
          alarmPanel.ipcRows + '）不一致'
      )
    }
    if (alarmPanel.ipcUnacknowledged === 0 && !alarmPanel.deviceAlarmEmpty) {
      problems.push('没有未确认的设备告警时，那一分区没有那句空态')
    }
    if (alarmPanel.ipcUnacknowledged > 0 && alarmPanel.deviceAlarmRows === 0) {
      problems.push(
        '主进程报有 ' + alarmPanel.ipcUnacknowledged + ' 条未确认设备告警，面板里却一条都没列出来 ' +
          '（业主 2026-09-19 第 2 条）'
      )
    }
    // ① 那条挂在每一页顶上的浮动横幅必须真的没了。
    if (alarmPanel.topbarErrorBanners !== 0) {
      problems.push(
        '顶栏又出现了那条浮动错误横幅（.topbar__error × ' + alarmPanel.topbarErrorBanners +
          '）—— 业主 2026-09-18 要求这类内容放进告警图标里'
      )
    }
    // ② 系统消息那一段：有失败就必须有那一段，而且逐条列出来；没有失败就不许画空段。
    if (alarmPanel.noticeSection && !(alarmPanel.noticeCount >= 1)) {
      problems.push('系统消息那一段渲染了，却一条都没有：' + JSON.stringify(alarmPanel))
    }
    if (alarmPanel.noticeSection !== alarmPanel.bellDot) {
      problems.push(
        '告警图标上的"有系统消息"那个点与面板里的那一段不一致（点=' + alarmPanel.bellDot +
          '，段=' + alarmPanel.noticeSection + '）'
      )
    }
    if (alarmPanel.channelsProbeOk === false && !alarmPanel.noticeSection) {
      problems.push(
        '这一读**确实失败**了（getChannels 返回失败），系统消息里却没有那一条 —— ' +
          '应用级失败没有进告警图标：' + JSON.stringify(alarmPanel)
      )
    }
    if (alarmPanel.noticeSection && alarmPanel.bellLabel.indexOf('系统消息') < 0) {
      problems.push('有系统消息时，图标的无障碍名字没有说出来：' + JSON.stringify(alarmPanel.bellLabel))
    }
    // ③ 那些话不许在页面正文里再出现一份（同一个失败不在两处说）。
    for (const text of alarmPanel.noticeTexts || []) {
      const head = String(text).slice(0, 12)
      if (head && String(alarmPanel.pageTextBefore).includes(head)) {
        problems.push('系统消息「' + text + '」在页面正文里也有一份（同一个失败说了两处）')
      }
    }
    // ④ 打开/关闭面板不许动布局（打开前 = 打开后 = 关闭后）。
    const closed = JSON.stringify(alarmPanel.layoutClosed)
    if (JSON.stringify(alarmPanel.layoutOpen) !== closed) {
      problems.push(
        '打开告警面板改变了页面布局：关闭时 ' + closed + '，打开后 ' +
          JSON.stringify(alarmPanel.layoutOpen)
      )
    }
    if (JSON.stringify(alarmPanel.layoutAfterClose) !== closed) {
      problems.push(
        '关掉告警面板之后布局没有回到原样：原本 ' + closed + '，关掉后 ' +
          JSON.stringify(alarmPanel.layoutAfterClose)
      )
    }
    if (!alarmPanel.panelClosed) problems.push('再点一次告警图标没有收起面板')
  }

  /**
   * 历史趋势：刷新 / 立即落盘必须与设备选择在**同一张卡片**里，且设备下拉收窄了。
   *
   * ⚠️ 一次性 profile 里**没有设备**，这一页会走「尚未添加设备」那个分支，筛选卡片根本
   * 不渲染 —— 那时这三条**量不到**，必须如实说"跳过"，而不是报成问题：把"没量到"与
   * "量到不合格"混成同一个问题正是探针最不该做的事（见文档 §15.13.5）。
   * 因此只有"页头不许回来"这一条在任何 profile 下都成立，无条件断言；
   * 卡片内部的三条只在有设备时断言，并有一条源码守卫兜底（`tests/page-layout.test.ts`）。
   */
  const trendsChrome = await layout('/trends', '(() => {' +
    'const card = document.querySelector(".page .card");' +
    /*
     * 「刷新」那一颗按业主 2026-09-19 更正第 4 条**已经删掉**（顶栏那颗是唯一的刷新），
     * 所以这里数的是**剩下**的动作：只有「立即落盘」。
     */
    'const buttons = [...document.querySelectorAll(".page button")]' +
    '  .filter((b) => /落盘/.test(b.textContent.trim()));' +
    'const refreshLeft = [...document.querySelectorAll(".page button")]' +
    '  .filter((b) => /^刷新$/.test(b.textContent.trim())).length;' +
    'const select = card ? card.querySelector("select") : null;' +
    'return JSON.stringify({' +
    '  hasCard: !!card,' +
    '  actionCount: buttons.length,' +
    '  actionsInsideCard: buttons.length > 0 && buttons.every((b) => card && card.contains(b)),' +
    '  refreshButtonLeft: refreshLeft,' +
    '  deviceSelectWidth: select ? Math.round(select.getBoundingClientRect().width) : -1,' +
    '  pageHeaderPresent: !!document.querySelector(".page .page-header"),' +
    '  emptyState: /尚未添加设备|还没有添加任何设备/.test(document.body.textContent)' +
    '});})()')
  log('trends chrome : ' + JSON.stringify(trendsChrome))
  if (trendsChrome.pageHeaderPresent) {
    problems.push('历史趋势页又出现了页头')
  }
  if (!trendsChrome.hasCard) {
    log('trends chrome : skipped（这个一次性 profile 里没有设备，筛选卡片不渲染）')
  } else {
    if (trendsChrome.actionCount < 1) {
      problems.push('历史趋势页找不到「立即落盘」那个动作（找到 ' +
        trendsChrome.actionCount + ' 个）')
    }
    if (trendsChrome.refreshButtonLeft > 0) {
      problems.push(
        '历史趋势页还有 ' + trendsChrome.refreshButtonLeft +
        ' 个「刷新」按钮（更正第 4 条要求删掉，只留顶栏那一颗）'
      )
    }
    if (!trendsChrome.actionsInsideCard) {
      problems.push('「立即落盘」不在设备选择那张卡片里')
    }
    if (trendsChrome.deviceSelectWidth <= 0 || trendsChrome.deviceSelectWidth > 220) {
      problems.push('历史趋势的设备下拉没有收窄：' + trendsChrome.deviceSelectWidth + 'px')
    }
  }

  /**
   * 趋势页的多通道叠加 + 多量并排（业主 2026-09-18 的追加要求）。
   *
   * 量得到的与量不到的，都写清楚：
   *   · **量得到**：通道图例的条数（= 这个设备的通道数；AE08 是 8）、点一下之后
   *     `aria-pressed` 与"图上还剩几条线"的变化，以及**诊断行的查询条数不变**
   *     —— 那是"点通道名只改显示、不重新查库"这句话在屏幕上的证据；
   *   · **这一个 profile 里量不到**：每张图里真实画了几条带数据的 series。
   *     原因是**这个一次性 profile 没有历史文件**（`trends.coverage.files === 0`，
   *     趋势历史写在 Parquet 里、不在被复制的那个 SQLite 里），所以图上走的是
   *     「该设备暂无历史数据」空态。探针会如实报 `historyFiles`，不把它当通过。
   */
  /*
   * ── 趋势页：拆成五支小探针（第 32 轮）──
   *
   * 为什么拆：第 28–31 轮这一整段（一支 240 秒的脚本）连续超时，而 `layout()` 超时只回
   * `{probeTimeout: true}` —— `timings` 与 `document.body.dataset.probeStep` 一起丢掉，
   * 连"卡在哪一步、每一步花了多久"都读不到。拆开之后每一支各有一个 60 秒的上限：
   * 超时只丢掉**那一支**的读数，而且问题清单里会点名是哪一支超的。
   *
   * 五支的分工：
   *   measure     只读：几何（通道在设备右侧 / 曲线卡片占满内容宽度）、结构（筛选栏里
   *               没有"聚合方式"、图上没有四张卡片、颗粒度那排、声压级 Y 轴 0–100）。
   *   toggle      ① 点灭再点亮一条通道（只改显示，不重新查库）。
   *   range       ③ 切到一段没有读数的区间，量"灰显 + 不可勾选"，再还原。
   *   metrics     ④ 多选第二个量，再取消。
   *   granularity ⑤ 点一档固定颗粒度，再点回自动。
   *
   * 共用开头 `TREND_PROBE_HEAD`：
   *   · 每一步在 `document.body.dataset.probeStep` 上留一个标记，并记下耗时（`timings`）；
   *   · 通道控件**搬家了**（业主 2026-09-19 第 13 批第 4 条，第 30 轮又搬到设备右侧）：
   *     现在是筛选栏里一排 chip 里的**勾选框**（`[data-trend-channel-check]` + `checked`）。
   *     判据没变（点一下只改"画哪几条线"），变的是钩子与"按下态"的读法；
   *   · `withTimeout`：宁可少一个读数，也不能让整支探针挂住。
   */
  const TREND_PROBE_HEAD =
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const t0 = Date.now();' +
    'const timings = {};' +
    /*
     * 每一步既记在页面里（`timings` / `document.body.dataset.probeStep`），也**立刻**用
     * `console.log` 报给主进程。后者是关键：如果这一支把渲染进程卡死了，页面里的那两份
     * 都读不到，而 console 消息在产生的那一刻就已经送出去了 —— 于是日志里能看到"它走到哪一步"。
     * 前缀 `[trend-probe]` 由 driver 的 `console-message` 钩子捞出来（见 `logProbeTrace`）。
     */
    'const mark = (step) => { timings[step] = Date.now() - t0;' +
    '  try { document.body.dataset.probeStep = step; } catch (e) {}' +
    '  try { console.log("[trend-probe] " + step); } catch (e) {} };' +
    'mark("start");' +
    'const checks = () => [...document.querySelectorAll("[data-trend-channel-check]")];' +
    'const checkStates = () => checks().map((c) => (c.checked ? "true" : "false"));' +
    'const metricButtons = [...document.querySelectorAll("[data-metric-toggle]")];' +
    'const out = {};' +
    'const withTimeout = (promise, ms, label) => Promise.race([' +
    '  promise,' +
    '  wait(ms).then(() => ({ __timeout: label }))' +
    ']);' +
    /*
     * 第 30 轮起曲线下方那一整行诊断被业主删掉了，所以"本次查询条数"这个读数没有了。
     * `queryStat` 保留成常量 null，免得后面每一处都要判空（那个数已经不存在了）。
     */
    'const queryStat = () => null;' +
    // 等到控件真的渲染出来为止（这一页在设备列表/健康状态刷新时会重渲染，控件会短暂消失）。
    'const waitFor = async (fn, ms) => {' +
    '  const until = Date.now() + ms;' +
    '  for (;;) { if (fn()) return true; if (Date.now() >= until) return false; await wait(200); }' +
    '};' +
    'const finish = () => { out.timings = timings; return JSON.stringify(out); };' +
    /*
     * ── 页面侧的"生命体征"（第 33 轮）────────────────────────────────────────
     *
     * 趋势页点「自定义」范围会把渲染进程的 JS 线程搞成不再应答，而我们量到的进程画像
     * 很怪（`probe-round33.log`）：**CPU 只有 4.5%**、内存**每 2 秒涨 22MB**、
     * 没崩、URL 还在 `/trends`。要分清"主线程被按住、别的线程在干活"与
     * "主线程在跑一个很轻的循环、不停分配"，需要的读数**必须在页面里**，
     * 而且必须在卡住之前就装好 —— 所以放在共用开头，每一支都装一遍（幂等）。
     *
     * 每秒一行 `console.log`（driver 的 `console-message` 钩子会抄进日志，
     * **页面卡住之后照样能到**），四个数各有各的用处：
     *   · `beat`    主线程心跳 —— 停了就说明主线程不再跑 JS；
     *   · `heap`    JS 堆（`performance.memory`，Chromium 有）—— 涨说明在分配；
     *   · `mut`     `MutationObserver` 累计的 DOM 变更数 —— 猛涨 = Vue 在反复重渲染；
     *   · `frame`   上一次 `requestAnimationFrame` 的等待毫秒 —— 一直是 `-` 或很大
     *               说明**渲染进程不再出帧**（合成器停了）。
     * 外加一个 Web Worker 心跳（**另一个线程**）：它还在跳就说明整个渲染进程没死。
     *
     * 这里**不**装"常驻 rAF 循环"：那本身会让合成器一直忙，会把要观察的现象盖掉。
     * 每个心跳只申请**一帧**，量它多久才到。
     */
    'if (!window.__probeDiag) {' +
    '  var diag = { beat: 0, mut: 0, frames: 0, frameWaitMs: null, pending: false, timer: null };' +
    '  window.__probeDiag = diag;' +
    '  try {' +
    '    new MutationObserver(function (records) { diag.mut += records.length; })' +
    '      .observe(document.documentElement, { subtree: true, childList: true,' +
    '        attributes: true, characterData: true });' +
    '  } catch (e) { console.log("[trend-probe] diag-mutation-failed " + e.message); }' +
    '  diag.timer = setInterval(function () {' +
    '    diag.beat += 1;' +
    '    var heap = (window.performance && performance.memory)' +
    '      ? Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB" : "?";' +
    '    console.log("[trend-probe] heartbeat " + diag.beat + " heap=" + heap +' +
    '      " mut=" + diag.mut + " frames=" + diag.frames +' +
    '      " frameWaitMs=" + (diag.frameWaitMs === null ? "-" : diag.frameWaitMs));' +
    '    if (!diag.pending) {' +
    '      diag.pending = true;' +
    '      var asked = Date.now();' +
    '      requestAnimationFrame(function () {' +
    '        diag.pending = false;' +
    '        diag.frames += 1;' +
    '        diag.frameWaitMs = Date.now() - asked;' +
    '      });' +
    '    }' +
    '  }, 1000);' +
    /*
     * **不装 Web Worker 心跳**（第 36 轮删掉）：应用的 CSP **禁止 `blob:` Worker**
     * （`Refused to create a worker from 'blob:file:///…' … Content Security Policy`），
     * 而那是一条 `console[error]` —— 探针会因为自己装的心跳往问题清单里塞一条**与产品无关**的红。
     * 第 33/34 轮记的"worker-heartbeat 一条都没来"到这里有了答案：**不是线程被卡，是 CSP 不许建**。
     */
    '  /*' +
    '   * 同步原生调用那一族（`window.print()` 的打印对话框、`alert`/`confirm`/`prompt`）：' +
    '   * 它们会把渲染进程的主线程**同步**按住，直到对话框被关掉 —— 现象与我们的卡死一模一样。' +
    '   * 换成"记一笔再抛异常"：日志里出现 `native-call xxx` 就是它；一条都没有就是这一族被排除。' +
    '   * 抛异常是安全的：这几个 API 在趋势页上只有「打印」按钮用，而打印那一段探针自己会再打一次桩。' +
    '   */' +
    '  ["print", "alert", "confirm", "prompt"].forEach(function (name) {' +
    '    try {' +
    '      Object.defineProperty(window, name, {' +
    '        configurable: true, writable: true,' +
    '        value: function () {' +
    '          console.log("[trend-probe] native-call " + name);' +
    '          throw new Error("probe blocked " + name);' +
    '        }' +
    '      });' +
    '    } catch (e) { console.log("[trend-probe] diag-native-guard-failed " + name); }' +
    '  });' +
    '  console.log("[trend-probe] diag-ready");' +
    '}'
  /*
   * 第 1 支：**只读**的几何与结构 —— 一次点击都不发。
   *
   * **先问设备状态**（一个 IPC），再读别的东西。为什么放在最前面（第 31 轮的诊断）：
   * 这一页每换一次筛选会打出 `量 × 通道` 条 DuckDB 查询（8 通道 1 个量 = 8 条），而
   * **主进程要一条条跑完**才轮到后面的 IPC；原来这一条放在三段交互之后，于是探针的
   * `devices.list()` 排在几十条查询后面 —— 那一整段在 120/180/240 秒上连续超时，
   * 看起来像"探针卡死"，其实是**查询队列**。
   *
   * 另外给它套一个 20 秒的上限：宁可少一个读数，也不能整支挂住。
   */
  const trendMeasure = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    'const listedNow = await withTimeout(window.api.devices.list(), 20000, "devices.list");' +
    'out.devicesListTimedOut = !!(listedNow && listedNow.__timeout);' +
    'out.deviceStatus = (function(){' +
    '  const all = listedNow && listedNow.success ? listedNow.data : [];' +
    '  const option = document.querySelector(".page .field--wide .select option:checked");' +
    '  const label = option ? text(option) : "";' +
    '  const hit = all.find((d) => label.indexOf(d.name) >= 0);' +
    '  return hit ? String(hit.status) : null;' +
    '})();' +
    'mark("devices");' +
    'Object.assign(out, {' +
    '  legendCount: checks().length,' +
    '  metricCount: metricButtons.length,' +
    '  pressedAtStart: checkStates(),' +
    '  chartCount: document.querySelectorAll("[data-metric-chart]").length,' +
    '  historyEmpty: !!document.querySelector(".page .empty .empty__title")' +
    '});' +
    'out.queriesBefore = queryStat();' +
    /*
     * **带数据的 series 有几条**：这是"多条通道真的画在同一根轴上"的唯一硬证据。
     * `[data-metric-empty]` 存在说明那个量在这段时间里一条读数都没有（画的是空态而不是线），
     * 那时不能把它算成"已验证"。
     */
    'out.metricEmpty = [...document.querySelectorAll("[data-metric-empty]")]' +
    '  .map((el) => el.getAttribute("data-metric-empty"));' +
    'out.chartHints = [...document.querySelectorAll("[data-metric-chart] .chart-hint")]' +
    '  .map((el) => text(el));' +
    /*
     * ── 通道选择（第 13 批第 4 条 + 第 30 轮业主最新一条）──
     *
     * 几何：通道那一块要**在设备的右侧**，而趋势曲线那张卡片要**占满内容宽度**
     * （业主：「通道的选择应该放在设备的右侧的位置，趋势图还是占右侧区域的 100%」）。
     * 两条都是几何判据 —— 模板顺序只是必要条件，"在右侧"这句话只能量。
     */
    'const panel = document.querySelector("[data-trend-channels]");' +
    'const deviceSelect = document.querySelector(".filter-bar select.select");' +
    'const chartCard = document.querySelector(".chart-panel.card");' +
    'const content = document.querySelector(".page");' +
    'out.panelExists = !!panel;' +
    'out.panelRightOfDevice = !!(panel && deviceSelect)' +
    '  && panel.getBoundingClientRect().left >= deviceSelect.getBoundingClientRect().right - 2;' +
    /*
     * 第 32 轮实测这一条曾经是 `false`（**没有真窗口证据之前看不出来**）。光知道"false"没法判断
     * 是"被挤到下一行了"还是"同一行但从设备下拉底下开始"，所以把四个坐标一起量出来。
     *
     * ⚠ `sameRow` 比的是**通道区块的 top** 与**设备下拉的 top** —— 而设备下拉在一个
     * `<label>` 里，标签文字在它上面，所以下拉自己的 top 天然比这一行的 top 低 ~70px
     * （第 32 轮修好之后仍读到 `sameRow: false`、`panelTop: 97`、`deviceTop: 169`）。
     * **判据不许用 `sameRow`** —— 真正的判据是 `panelLeft >= deviceRight`（见上面
     * `panelRightOfDevice`）。`sameRow` 只留着当诊断，别把它读成"不在同一行"。
     */
    'out.geometry = (function(){' +
    '  if (!panel || !deviceSelect) return null;' +
    '  const p = panel.getBoundingClientRect();' +
    '  const d = deviceSelect.getBoundingClientRect();' +
    '  const deviceField = document.querySelector(".filter-bar .field--wide");' +
    '  return {' +
    '    panelLeft: Math.round(p.left), panelRight: Math.round(p.right), panelTop: Math.round(p.top),' +
    '    deviceLeft: Math.round(d.left), deviceRight: Math.round(d.right), deviceTop: Math.round(d.top),' +
    '    deviceFieldTop: deviceField ? Math.round(deviceField.getBoundingClientRect().top) : null,' +
    '    sameRowAsSelect: Math.abs(p.top - d.top) < 8,' +
    '    sameRowAsField: deviceField' +
    '      ? Math.abs(p.top - deviceField.getBoundingClientRect().top) < 8 : null,' +
    '    barWidth: (function(){ const b = document.querySelector(".filter-bar");' +
    '      return b ? Math.round(b.getBoundingClientRect().width) : -1; })()' +
    '  };' +
    '})();' +
    'out.chartCardWidthRatio = !!(chartCard && content)' +
    '  ? Math.round((chartCard.getBoundingClientRect().width / content.getBoundingClientRect().width) * 100)' +
    '  : null;' +
    'out.panelRows = document.querySelectorAll("[data-trend-channel-row]").length;' +
    'mark("panel");' +
    'out.panelSummary = text(document.querySelector("[data-channel-panel-summary]"));' +
    'out.summaryAtStart = out.panelSummary;' +
    'out.rowChecks = checks().length;' +
    'out.renameButtons = document.querySelectorAll("[data-trend-channel-rename]").length;' +
    /*
     * 离线设备上改名按钮必须**置灰**并且说明原因：改名是写设备（`/set_passageway`），
     * 点一次必然失败。这里同时量"禁用"与"有 title"，缺一个都不是完整的做法。
     */
    'out.renameDisabled = [...document.querySelectorAll("[data-trend-channel-rename]")]' +
    '  .map((b) => b.disabled);' +
    'out.renameTitle = (function(){' +
    '  const b = document.querySelector("[data-trend-channel-rename]");' +
    '  return b ? (b.getAttribute("title") || "") : "";' +
    '})();' +
    /*
     * ── 第 13 批第 5 条：删聚合方式与四张卡片、颗粒度、声压级 Y 轴 0–100 ──
     *
     * 几何/结构（都能量）：
     *   · 筛选栏里**没有** "聚合方式" 那个 `<select>`（它原来在指标后面）；
     *   · 图表卡片上**没有** `.card-grid--stats` 那四张卡片；
     *   · 有一排颗粒度按钮（`[data-trend-granularity-option]`），第一档是自动；
     *   · 声压级那张图的 `data-y-range` 必须是 `0-100`，其余的量是 `auto`。
     * 这里只读；"点一档固定颗粒度再点回自动"那一段在第 5 支（granularity）。
     */
    'out.aggregationSelect = [...document.querySelectorAll(".filter-bar select")]' +
    '  .filter((s) => [...s.options].some((o) => /平均|Average|Media|Ortalama/.test(o.textContent || "")))' +
    '  .length;' +
    'out.statCards = document.querySelectorAll(".card-grid--stats").length;' +
    'out.granularityButtons = document.querySelectorAll("[data-trend-granularity-option]").length;' +
    'out.granularityKeys = [...document.querySelectorAll("[data-trend-granularity-option]")]' +
    '  .map((b) => b.getAttribute("data-trend-granularity-option"));' +
    'out.granularityPressed = [...document.querySelectorAll("[data-trend-granularity-option]")]' +
    '  .filter((b) => b.getAttribute("aria-pressed") === "true")' +
    '  .map((b) => b.getAttribute("data-trend-granularity-option"));' +
    'out.yRanges = [...document.querySelectorAll("[data-metric-chart]")]' +
    '  .map((el) => el.getAttribute("data-metric-chart") + "=" + el.getAttribute("data-y-range"));' +
    'const bucketText = () => {' +
    '  const auto = document.querySelector(\'[data-trend-granularity-option="auto"]\');' +
    '  if (!auto) return null;' +
    '  const match = /[（(]([^）)]+)[）)]/.exec(text(auto));' +
    '  return match ? match[1] : null;' +
    '};' +
    'out.bucketBefore = bucketText();' +
    'out.deviceName = text(document.querySelector(".page .field--wide .select option:checked"));' +
    'mark("done");' +
    'return finish();' +
    // 60 秒：这一支只读页面、外加一个 20 秒上限的 IPC，读不完就是页面线程被查询队列占住了。
    '})()', 60_000)
  /*
   * 第 2 支：① 点灭**第二条**通道（只改显示，不重新查库），再点亮它还原到起点。
   */
  const trendToggle = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    'await waitFor(() => checks().length > 1, 15000);' +
    'out.legendCount = checks().length;' +
    'out.pressedAtStart = checkStates();' +
    // ① 点灭**第二条**通道：只改显示（勾选框取消勾选，不重新查库）。
    'if (checks().length > 1 && !checks()[1].disabled) {' +
    '  checks()[1].click(); await wait(500);' +
    '  out.pressedAfterHide = checkStates();' +
    '  out.queriesAfterHide = queryStat();' +
    // ② 再点亮它：回到原样（探针必须把自己改过的状态恢复）。
    /*
     * 点之前**等勾选框回来**（2026-09-19 实测到一次偶发）：这一页在设备列表/健康状态刷新时会
     * 重渲染，那一列可能正好在两步之间短暂消失，于是 `pressedAfterRestore` 读到空数组、
     * 报出一串"再点一下没有恢复"的假失败。等待是自适应的（最多 5 秒），
     * 判据仍然是"恢复后的勾选态与起点一致"。
     */
    '  for (let i = 0; i < 20 && checks().length < out.legendCount; i += 1) await wait(250);' +
    '  const restoreTarget = checks()[1];' +
    '  if (restoreTarget) { restoreTarget.click(); await wait(600); }' +
    '  out.pressedAfterRestore = checkStates();' +
    '  out.queriesAfterRestore = queryStat();' +
    '} else {' +
    '  out.pressedAfterHide = null;' +
    '  out.skipReason = checks().length > 1 ? "checkbox-disabled" : "not-enough-channels";' +
    '}' +
    'mark("done");' +
    'return finish();' +
    '})()', 60_000)
  /*
   * 第 3 支：④ 多选一个量（图都应多一份），再取消，回到一个量。
   *
   * ⚠ 顺序上，这一支与"颗粒度"那一支都排在"①/③ 换范围"那一支**前面**，而"换范围"排最后 ——
   * 这是第 32 轮实测之后的安排：**点「自定义」范围会让渲染进程卡死**（详见文件末尾那一支的注释），
   * 一旦它卡住，排在它后面的支就全都拿不到读数（`waitForPageRoot()` 已经加了 5 秒上限，
   * 所以不会再把整次运行挂住，但仍然白白浪费一支的证据）。把风险最大的那一步放到最后，
   * 前面四支的读数就一定是干净的。
   */
  const trendMetrics = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    // `metricButtons` 是脚本开头那一瞬间的快照，等它变多是没有意义的 —— 这里重新取一次活的。
    'await waitFor(() => document.querySelectorAll("[data-metric-toggle]").length > 1, 15000);' +
    'const metricToggles = [...document.querySelectorAll("[data-metric-toggle]")];' +
    'out.metricButtonsBefore = metricToggles.length;' +
    // ④ 多选一个量：图都应多一份。
    'mark("metrics");' +
    'if (metricToggles.length > 1) {' +
    '  metricToggles[1].click(); await wait(1200);' +
    '  out.selectedMetrics = [...document.querySelectorAll("[data-metric-toggle]")]' +
    '    .filter((b) => b.getAttribute("aria-pressed") === "true")' +
    '    .map((b) => b.getAttribute("data-metric-toggle"));' +
    '  out.chartCountAfterSecondMetric = document.querySelectorAll("[data-metric-chart]").length;' +
    // 与上面同一条理由：点第二次之前等那一排按钮回来（同一个偶发）。
    '  for (let i = 0; i < 20 && document.querySelectorAll("[data-metric-toggle]").length < metricToggles.length; i += 1) await wait(250);' +
    '  const metricRestore = document.querySelectorAll("[data-metric-toggle]")[1];' +
    '  if (metricRestore) { metricRestore.click(); await wait(1200); }' +
    '  out.selectedMetricsRestored = [...document.querySelectorAll("[data-metric-toggle]")]' +
    '    .filter((b) => b.getAttribute("aria-pressed") === "true")' +
    '    .map((b) => b.getAttribute("data-metric-toggle"));' +
    '} else {' +
    // 如实记下"为什么没验到"（这一支跑了，只是页面上没有第二个量可点）。
    '  out.metricButtonsSkipped = metricToggles.length;' +
    '}' +
    'mark("done");' +
    'return finish();' +
    // 60 秒：这一支只点两次（多选、取消），两次都是本页状态变更。
    '})()', 60_000)
  /*
   * 第 4 支：⑤ 点一档固定颗粒度，再点回自动。
   *
   * 桶宽从**时间颗粒度那一排的「自动」按钮**上读（第 30 轮：曲线下方那一整行诊断被业主删了，
   * 「自动（5 分钟）」里的那个括号就是把桶宽写出来的地方）。
   * 选固定档之后「自动」那个括号会消失（自动档没在跑），所以那一步等的是**按钮变成选中**。
   */
  const trendGranularity = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    'await waitFor(() => document.querySelector("[data-trend-granularity-option]") !== null, 15000);' +
    'const bucketText = () => {' +
    '  const auto = document.querySelector(\'[data-trend-granularity-option="auto"]\');' +
    '  if (!auto) return null;' +
    '  const match = /[（(]([^）)]+)[）)]/.exec(text(auto));' +
    '  return match ? match[1] : null;' +
    '};' +
    'out.bucketBefore = bucketText();' +
    'const granularityButtons = [...document.querySelectorAll("[data-trend-granularity-option]")];' +
    'const fixedButton = granularityButtons.find((b) => b.getAttribute("data-trend-granularity-option") === "1m");' +
    'const autoButton = granularityButtons.find((b) => b.getAttribute("data-trend-granularity-option") === "auto");' +
    'if (fixedButton) {' +
    '  fixedButton.click();' +
    // 选固定档之后「自动」那个括号会消失（自动档没在跑），所以这里等的是**按钮变成选中**。
    '  for (let i = 0; i < 24 && fixedButton.getAttribute("aria-pressed") !== "true"; i += 1) await wait(250);' +
    '  out.fixedPressed = fixedButton.getAttribute("aria-pressed");' +
    '  if (autoButton) {' +
    '    autoButton.click();' +
    '    for (let i = 0; i < 24 && autoButton.getAttribute("aria-pressed") !== "true"; i += 1) await wait(250);' +
    '    out.bucketAfterAuto = bucketText();' +
    '  }' +
    '}' +
    'mark("done");' +
    'return finish();' +
    // 60 秒：这一支只发两次查询（点 1 分钟档、点回自动），比原来那一整段（30+ 条查询）轻得多。
    '})()', 60_000)
  /*
   * 在**最容易卡死的那一支**之前打开 CPU profiler（第 34 轮）。
   *
   * 为什么放在这里：第 33 轮把卡死定位到"渲染 + patch 的循环"，但调用栈只说明"卡住时在渲染"，
   * **看不出是谁在 flush 期间写状态**（环的驱动端）。CPU profile 的自耗时排行会把它列出来，
   * 配合 `scriptId → url` 就能对回文件与行号。前面的四支不会卡（毫秒级返回），
   * 所以 profiler 开着也不会把它们的读数搅混。
   */
  if (driverDebugger) {
    await driverDebugger
      .startProfile()
      .catch((error) => log('Profiler.start failed: ' + error.message))
  }
  /*
   * 第 5 支：**用预设**进入"有数据那一屏"（第 34 轮加的，用来把两件事分开）。
   *
   * 这一支问的是一个很具体的问题：卡死到底需要**"自定义范围"那块界面**，还是只要
   * **"图真的画出来"**就够了？
   *   · 点一档预设（`7d` 覆盖住库里那几天）→ 图会画出来，但**没有** `range='custom'`、
   *     也没有那两个 `datetime-local` 输入框；
   *   · 如果它**不卡**，那卡死就与"自定义范围那块界面"绑在一起（下一次只改那一块）；
   *   · 如果它**也卡**，那卡死只需要"图 + 数据"，与自定义范围无关。
   * 顺带它还是唯一能真正量到 C⑤ 那两条（声压级 Y 轴 0–100、"多条通道画在同一根轴上"）的机会
   * —— 第 28–33 轮一直是"这个 profile 里一张图都没渲染"。
   */
  const trendPresetRange = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    'await waitFor(() => document.querySelector(\'[data-trend-range-preset="7d"]\') !== null, 15000);' +
    'const activeNow = document.querySelector("[data-trend-range-preset].chip--accent");' +
    'out.presetBefore = activeNow ? activeNow.getAttribute("data-trend-range-preset") : null;' +
    'const week = document.querySelector(\'[data-trend-range-preset="7d"]\');' +
    'mark("preset:click");' +
    'if (week) week.click();' +
    'await waitFor(() => document.querySelectorAll("[data-metric-chart]").length > 0, 20000);' +
    'await wait(1500);' +
    'mark("preset:charts");' +
    'out.rangeAfterPreset = (function(){' +
    '  const chip = document.querySelector("[data-trend-range-preset].chip--accent");' +
    '  return chip ? chip.getAttribute("data-trend-range-preset") : null;' +
    '})();' +
    'out.chartCount = document.querySelectorAll("[data-metric-chart]").length;' +
    'out.yRanges = [...document.querySelectorAll("[data-metric-chart]")]' +
    '  .map((el) => el.getAttribute("data-metric-chart") + "=" + el.getAttribute("data-y-range"));' +
    'out.chartHints = [...document.querySelectorAll("[data-metric-chart] .chart-hint")]' +
    '  .map((el) => text(el));' +
    'out.chartCanvas = [...document.querySelectorAll("[data-metric-chart] canvas")]' +
    '  .map((el) => Math.round(el.getBoundingClientRect().width) + "x" +' +
    '    Math.round(el.getBoundingClientRect().height));' +
    'out.metricEmpty = [...document.querySelectorAll("[data-metric-empty]")]' +
    '  .map((el) => el.getAttribute("data-metric-empty"));' +
    'out.panelSummary = text(document.querySelector("[data-channel-panel-summary]"));' +
    'out.summaryWithData = out.panelSummary;' +
    'out.dataRowsWithData = document.querySelectorAll(' +
    '  "[data-trend-channel-row]:not([data-trend-channel-nodata])").length;' +
    'out.pressedWithData = checkStates();' +
    /* 真的还活着吗：连等 3 秒并逐个打点（卡死时这些 mark 一个都不会到）。 */
    'for (let i = 1; i <= 3; i += 1) { await wait(1000); mark("preset:alive-" + i); }' +
    'mark("done");' +
    'return finish();' +
    // 90 秒：一发查询 + 等 ECharts 画第一帧 + 3 秒存活观察。
    '})()', 90_000)
  /*
   * 第 6 支：跳到"有数据的那个范围"（`[data-trend-use-coverage]`），再看一遍有图的那一屏。
   *
   * 为什么要有这一支（第 33 轮）：
   *   1. 它是**业主真的会点**的按钮 —— 空态里写着"库里有数据的范围是 X ~ Y，点这里跳过去"；
   *   2. 它落到的状态（`range='custom'` + 两个边界都有值）与"手填两个时间"是**同一个状态**，
   *      也就是第 32 轮定位到的卡死状态，所以它是那条路径的**另一个入口**（验它 = 验业主的路）；
   *   3. 它是探针唯一能拿到"真的有读数"那一屏的办法：默认预设是最近 1 小时，而这台设备
   *      最后一次上报在几天前（`0 / 8 路有数据`）—— 没有它，"声压级 Y 轴 0–100"与
   *      "多条通道画在同一根轴上"这两条断言永远跑不到（第 28–32 轮一直是"没验到"）。
   *
   * ⚠ 它会**故意覆盖** `chartCount` / `yRanges` / `chartHints` / `metricEmpty` 这几个键，
   * 因为下面断言块里那几条（`yRanges` 必须是 `spl=0-100`、图里的通道数与图例一致）
   * 问的就是"有图的那一屏"。第 1 支（只读）量到的是"没有图的那一屏"，两屏都要有读数，
   * 所以第 1 支那份仍然原样保留在日志里（`layout /trends : {...}`）。
   */
  const trendCoverageRange = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +    'await waitFor(() => document.querySelector("[data-trend-use-coverage]") !== null, 20000);' +
    'const button = document.querySelector("[data-trend-use-coverage]");' +
    'out.coverageButton = !!button;' +
    'if (button) {' +
    '  out.coverageButtonText = text(button);' +
    '  mark("coverage:click");' +
    '  button.click();' +
    // 跳到有数据的那一段之后要等两件事：查询回来 + 图挂上来（ECharts 还要再画一帧）。
    '  await waitFor(() => document.querySelectorAll("[data-metric-chart]").length > 0, 20000);' +
    '  await wait(1200);' +
    '  mark("coverage:charts");' +
    '  out.rangeAfterCoverage = (function(){' +
    '    const chip = document.querySelector("[data-trend-range-preset].chip--accent");' +
    '    return chip ? chip.getAttribute("data-trend-range-preset") : null;' +
    '  })();' +
    '  out.chartCount = document.querySelectorAll("[data-metric-chart]").length;' +
    '  out.metricEmpty = [...document.querySelectorAll("[data-metric-empty]")]' +
    '    .map((el) => el.getAttribute("data-metric-empty"));' +
    '  out.chartHints = [...document.querySelectorAll("[data-metric-chart] .chart-hint")]' +
    '    .map((el) => text(el));' +
    '  out.yRanges = [...document.querySelectorAll("[data-metric-chart]")]' +
    '    .map((el) => el.getAttribute("data-metric-chart") + "=" + el.getAttribute("data-y-range"));' +
    '  out.panelSummary = text(document.querySelector("[data-channel-panel-summary]"));' +
    '  out.summaryWithData = out.panelSummary;' +
    '  out.dataRowsWithData = document.querySelectorAll(' +
    '    "[data-trend-channel-row]:not([data-trend-channel-nodata])").length;' +
    '  out.pressedWithData = checkStates();' +
    /* 图的画布真的画了东西没有：`canvas` 存在 + 宽高 > 0（ECharts 没画出来时是空 div）。 */
    '  out.chartCanvas = [...document.querySelectorAll("[data-metric-chart] canvas")]' +
    '    .map((el) => Math.round(el.getBoundingClientRect().width) + "x" +' +
    '      Math.round(el.getBoundingClientRect().height));' +
    '  out.zoomBarVisible = !!document.querySelector("[data-trend-zoom-bar]");' +
    '}' +
    'mark("done");' +
    'return finish();' +
    // 90 秒：跳过去要发 8 条查询，再等 ECharts 画第一帧。
    '})()', 90_000)
  /*
   * 第 6 支（**故意排在最后**）：③ 「无数据灰显 + 不可勾选」：把范围切到一段**很久以前**
   * （2000-01-01 那两天），那一段一定没有读数。判据三条：每一行都有 `data-trend-channel-nodata`、
   * 每个勾选框都 `disabled`、面板小结是 "0 / N 路有数据"。
   * 量完把范围**还原**成原来那个预设（探针不许留下改动）。
   *
   * ── 为什么排最后（第 32 轮实测）──
   * 第 31 轮那一支（240 秒、五件事串在一起）连续超时，拆开之后第一次跑就定位到了这一步：
   *   `[demo] layout /trends  : {"...measure...}` → 立刻返回
   *   `[demo] layout /trends  : {"...toggle..."}` → 立刻返回
   *   `[demo] layout /trends  : TIMEOUT after 90000ms`  ← 就是这一支
   * 而且超时窗口里主进程**一条 `Trend query complete` 都没有**（只有每 5 秒一次的设备健康检查），
   * 说明卡的不是 DuckDB：是**渲染进程的 JS 线程自己不响应了**（点「自定义」→ 页面卡死，
   * 之后的 `executeJavaScript` 全部不 settle，连 `waitForPageRoot()` 都停住）。
   * 这一条是**产品缺陷**（业主点「自定义」时间范围就会遇到），不是探针的问题；
   * 记在 `docs/UI-VERIFY.md` 第 32 轮那一节，探针这边只做两件事：
   * 把这一步排到最后（别拖累别的读数）、给 `waitForPageRoot()` 加 5 秒上限（别把整次运行挂住）。
   */
  const trendRange = await layout('/trends', '(async () => {' +
    TREND_PROBE_HEAD +
    // 同步原生调用的守卫、主线程/Worker 心跳、DOM 变更计数都装在共用开头里（见 `TREND_PROBE_HEAD`）。
    'mark("range:diag-ready");' +
    'await waitFor(() => document.querySelector("[data-trend-range-preset]") !== null, 15000);' +
    // 这一支自己再量一次"起点有几行"：万一第 1 支超时，这里的判据仍然成立。
    'out.panelRowsBeforeRange = document.querySelectorAll("[data-trend-channel-row]").length;' +
    'out.summaryAtStart = text(document.querySelector("[data-channel-panel-summary]"));' +
    'const activePreset = document.querySelector("[data-trend-range-preset].chip--accent");' +
    'out.rangeBefore = activePreset ? activePreset.getAttribute("data-trend-range-preset") : null;' +
    'const customPreset = document.querySelector(\'[data-trend-range-preset="custom"]\');' +
    'if (customPreset) {' +
    '  mark("range:preset-click");' +
    '  customPreset.click(); await wait(400);' +
    '  mark("range:preset-clicked");' +
    '  const pickers = [...document.querySelectorAll(".custom-range input.input")];' +
    '  out.customPickers = pickers.length;' +
    '  if (pickers.length === 2) {' +
    '    const setValue = (el, value) => {' +
    '      mark("range:set-" + (el === pickers[0] ? "from" : "to"));' +
    '      el.value = value;' +
    '      el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '      mark("range:set-" + (el === pickers[0] ? "from" : "to") + "-done");' +
    '    };' +
    '    setValue(pickers[0], "2000-01-01T00:00");' +
    '    setValue(pickers[1], "2000-01-02T00:00");' +
    '    await wait(2500);' +
    '  }' +
    '  mark("range:read-empty");' +
    '  out.emptyRows = document.querySelectorAll("[data-trend-channel-row][data-trend-channel-nodata]").length;' +
    '  out.emptyChecksDisabled = checks().map((c) => c.disabled);' +
    '  out.emptySummary = text(document.querySelector("[data-channel-panel-summary]"));' +
    /*
     * ⚠ 选择器是 `.page .empty`，不是 `.empty-state` —— `EmptyState.vue` 的根元素是
     * `<div class="empty">`。第 25 轮之前这里（以及上面 `historyEmpty`）用的是
     * `.empty-state, [data-empty-state]`，**从来没匹配上过**：那两处读数一直是假的 `false`。
     * 这是探针自己的缺陷，不是界面的。
     */
    '  out.emptyStateTitle = text(document.querySelector(".page .empty .empty__title"));' +
    '  out.emptyRangeEmptyState = out.emptyStateTitle.length > 0;' +
    '  mark("range:restore-click");' +
    '  if (activePreset) { activePreset.click(); await wait(1500); }' +
    '  mark("range:restored");' +
    /*
     * 还原之后**轮询等数据回来**：这一段查询走 DuckDB/Parquet，第一次往往要比 1.5 秒久
     * （本机实测：切回预设之后 3–4 秒才重新出数）。等待是有上限的，判据仍然是"数据回来了"。
     */
    '  const dataRows = () =>' +
    '    document.querySelectorAll("[data-trend-channel-row]:not([data-trend-channel-nodata])").length;' +
    '  for (let i = 0; i < 24 && dataRows() === 0; i += 1) await wait(250);' +
    '  mark("range:read-after-restore");' +
    '  out.rangeAfter = (function(){' +
    '    const chip = document.querySelector("[data-trend-range-preset].chip--accent");' +
    '    return chip ? chip.getAttribute("data-trend-range-preset") : null;' +
    '  })();' +
    '  out.rowsAfterRestore = document.querySelectorAll("[data-trend-channel-row]").length;' +
    '  out.dataRowsAfterRestore = dataRows();' +
    '  out.summaryAfterRestore = text(document.querySelector("[data-channel-panel-summary]"));' +
    '  out.rangeEmptyStateAfterRestore = text(document.querySelector(".page .empty .empty__title"));' +
    '}' +
    'mark("done");' +
    'return finish();' +
    /*
     * 90 秒：这一支要点两次范围、等两轮查询（本机实测切回预设之后 3–4 秒才重新出数）；
     * 而如果它真的把渲染进程卡住了，`layout()` 会在 90 秒后照常报超时，整次运行继续往下走。
     */
    '})()', 90_000)
  /*
   * 五支的结果合并成原来的 `trendChannels`：下面的断言块继续按原来的字段读，
   * 而"哪一支超时了"单独列出来（超时那一支没有字段，合并时跳过它）。
   */
  const trendSteps = [
    ['measure', trendMeasure],
    ['toggle', trendToggle],
    ['metrics', trendMetrics],
    ['granularity', trendGranularity],
    ['preset', trendPresetRange],
    ['coverage', trendCoverageRange],
    ['range', trendRange]
  ]
  const trendChannels = {}
  const trendTimeouts = []
  for (const step of trendSteps) {
    if (step[1] && step[1].probeTimeout === true) {
      trendTimeouts.push(step[0])
      continue
    }
    if (step[1]) Object.assign(trendChannels, step[1])
  }
  log(
    'trend steps : ' +
      JSON.stringify(
        trendSteps.map((s) => [
          s[0],
          s[1] && s[1].probeTimeout === true ? 'TIMEOUT' : Object.keys(s[1] || {}).length
        ])
      )
  )
  log('trend channels: ' + JSON.stringify(trendChannels))
  /*
   * ── 如果趋势页把渲染进程卡死了，把窗口重载回来再继续 ──
   *
   * 第 32 轮实测：点「自定义」时间范围会让**渲染进程的 JS 线程**不再应答（主进程还在每 5 秒
   * 打一次设备健康检查，一条 `Trend query complete` 都没有），而这一页之后还有别的探针要跑。
   * 不重载的话，后面每一支都会停在 `waitForPageRoot()`（现在有 5 秒上限，所以是有界地失败，
   * 但会白白报一串"这一页什么都没渲染"的假问题）。
   *
   * 判据：问页面一句 `1+1`，5 秒不回来就算卡死。**卡死本身照旧记一条问题** ——
   * 恢复只是让后面的页面还能验，不是把这件事抹掉。
   *
   * 第 32 轮实测的第二步：`webContents.reload()` **不够** —— 卡死的渲染进程连"重载"这件事
   * 都没法配合，重载之后 4 次 `1+1` 全部 5 秒无应答（`layout ping` 四条）。所以第二级是
   * `forcefullyCrashRenderer()`：把渲染进程**杀掉**再重载。这一条也踩得值：它同时说明
   * 那个卡死比"JS 死循环"更硬（死循环的进程被杀掉/重启后一定会恢复）。
   */
  const pingPage = async (ms) => {
    const answer = await Promise.race([
      win.webContents.executeJavaScript('1 + 1').then(
        () => false,
        () => 'rejected'
      ),
      sleep(ms).then(() => true)
    ])
    return answer !== false
  }
  if (await pingPage(5_000)) {
    log('trend channels: 渲染进程不响应了 —— 先取 CPU profile 与 JS 调用栈')
    /*
     * **先停 profiler**：`Profiler.stop` 需要渲染进程应答，所以套上限；拿不到就如实说。
     * 拿到的话，自耗时排行就是"谁在转"的答案（含调用链，能看出是谁在写状态）。
     */
    if (driverDebugger) {
      try {
        const top = await Promise.race([
          driverDebugger.stopProfile(),
          sleep(8_000).then(() => null)
        ])
        if (top === null) log('CPU profile: Profiler.stop 超时（渲染进程不应答）')
        else if (top.length === 0) log('CPU profile: 没有采到样本')
        else {
          for (const entry of top) {
            log('CPU profile: self=' + entry.selfMs + 'ms ← ' + entry.chain.join(' ← '))
          }
        }
      } catch (error) {
        log('CPU profile: 失败 ' + error.message)
      }
    }
    /*
     * **先取栈**：`Debugger.pause` 是 V8 的中断，卡住的循环里也能把调用栈取出来。
     * 这一条比"CPU/内存画像"更直接 —— 它会告诉我们到底是哪几帧在转
     * （第 33 轮：加了它才发现"一个核心被占满"的那条环不止一处）。
     */
    try {
      /*
       * **多采几次**：单次采样只能看到"卡住时它正在干什么"（第 33 轮第一次采到的是
       * `flushJobs → componentUpdateFn → renderComponentRoot → renderList → trendAxisName`
       * —— 一次 Vue 渲染，这说明环在"渲染 → 有人又改了它依赖的状态 → 再渲染"上，
       * 但**看不出是谁改的**）。连采 6 次（每次间隔约 1 秒）就能看出这条脉冲的**其它相位**：
       * 如果某一次采到 `setChartRef` / `onChartZoom` / `ResizeObserver` / `setOption`，
       * 那个就是写状态的那一端。
       */
      for (let sample = 0; sample < 6; sample += 1) {
        const paused = await Promise.race([
          win.webContents.debugger.sendCommand('Debugger.pause').then(() => true),
          sleep(4_000).then(() => false)
        ])
        if (!paused) {
          log('trend channels: Debugger.pause 第 ' + (sample + 1) + ' 次没有得到回应')
          break
        }
        await sleep(1_200)
        await Promise.race([
          win.webContents.debugger.sendCommand('Debugger.resume'),
          sleep(3_000)
        ]).catch(() => {})
        await sleep(800)
      }
      log('trend channels: 调用栈采样结束（每一段见上面的 DEBUGGER paused 行）')
    } catch (error) {
      log('trend channels: 取调用栈失败：' + error.message)
    }
    problems.push(
      '趋势页把**渲染进程**卡死了（点「自定义」时间范围之后页面不再应答，主进程仍在打日志）—— ' +
        '趋势页这一段之后的读数全部作废；驱动已重载窗口继续跑其余页面'
    )
    /*
     * ── 卡住的时候，渲染进程到底在干什么？（第 33 轮加的）──
     *
     * 这一条能把"到底哪一类卡死"一次分开：
     *   · CPU 接近 100% + 内存往上涨 → **JS/绘制在死转**（去找循环）；
     *   · CPU 接近 0、内存平 → 线程**在等**某个东西（同步原生调用、对话框、死锁）；
     *   · `isCrashed()` 变 true → 是崩了（不是卡）。
     * 截屏与 `isLoading()`/URL 一起打出来 —— 它们都是**浏览器进程侧**的状态，
     * 渲染进程不应答时照样读得到。
     */
    const rendererPid = win.webContents.getOSProcessId()
    for (let sample = 0; sample < 8; sample += 1) {
      const row = app.getAppMetrics().find((item) => item.pid === rendererPid)
      log(
        'renderer health: sample=' + sample +
          ' cpu=' + (row ? row.cpu.percentCPUUsage.toFixed(1) : '?') + '%' +
          ' mem=' + (row ? Math.round(row.memory.workingSetSize / 1024) : '?') + 'MB' +
          ' pid=' + rendererPid +
          ' crashed=' + win.webContents.isCrashed() +
          ' loading=' + win.webContents.isLoading() +
          ' url=' + win.webContents.getURL().slice(-40)
      )
      await sleep(2_000)
    }
    /*
     * 卡死时留一张截图：这是"业主会看到什么"的唯一证据（页面停在哪个状态、有没有转圈）。
     * `capturePage()` 也走渲染进程，所以同样套一个上限 —— 拿不到就如实记一句，不假装有。
     */
    try {
      const shot = await Promise.race([win.webContents.capturePage(), sleep(8_000).then(() => null)])
      if (shot && !shot.isEmpty()) {
        const frozenPath = path.join(OUT, 'frozen-trends.png')
        fs.writeFileSync(frozenPath, shot.toPNG())
        log('trend channels: 卡死时的截图 → ' + frozenPath)
      } else {
        log('trend channels: 卡死时连截图也拿不到（渲染进程不响应）')
      }
    } catch (error) {
      log('trend channels: 卡死时截图失败：' + error.message)
    }
    win.webContents.reload()
    await sleep(6_000)
    if (await pingPage(5_000)) {
      log('trend channels: 重载也没能救回来 —— 杀掉渲染进程再重载')
      deliberateRendererCrash = true
      win.webContents.forcefullyCrashRenderer()
      await sleep(3_000)
      win.webContents.reload()
      await sleep(6_000)
      /*
       * 渲染进程被杀掉之后，页面里的登录态（Pinia）也没了。这里再登一次：
       * 会话在主进程里，工厂管理员也已经在开头建好了，所以这一次只会拿回同一个会话。
       * 失败也不当问题报 —— 后面那些页面的断言本来就会报"没渲染"，那才是要看的信号。
       */
      const relogin = await win.webContents
        .executeJavaScript(
          '(async () => {' +
            "  const r = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
            "  return r && r.success ? 'ok' : JSON.stringify(r && r.error ? r.error.code : r);" +
            '})()'
        )
        .catch((error) => 'threw: ' + error.message)
      log('trend channels: 重载后重新登录 → ' + relogin)
    }
    await waitForPageRoot()
  }
  if (trendTimeouts.length > 0) {
    problems.push(
      '趋势页的多通道探针有 ' + trendTimeouts.length + ' 支超时（' + trendTimeouts.join('、') +
        '）—— 这几支的读数没有任何结论，其余的照旧'
    )
  }
  if (trendChannels.legendCount === undefined) {
    log('trend channels: 第 1 支（只读几何/结构）没有回来，这一段跳过')
  } else if (trendChannels.legendCount === 0) {
    // 一次性 profile 里没有设备时这一页走空态，如实跳过（与上面 trends chrome 同一条口径）。
    log('trend channels: skipped（没有设备，通道那一列不渲染）')
  } else {
    if (trendChannels.legendCount < 2) {
      problems.push(
        '通道列只有 ' + trendChannels.legendCount + ' 条：默认选中的设备是多通道设备，' +
        '应当每条通道一行（设备：' + JSON.stringify(trendChannels.deviceName) + '）'
      )
    }
    if (trendChannels.metricCount !== 7) {
      problems.push('量的可选按钮不是 7 个：' + trendChannels.metricCount)
    }
    /*
     * ── 第 13 批第 5 条 ──
     */
    if (trendChannels.aggregationSelect !== 0) {
      problems.push(
        '筛选栏里还有"聚合方式"那个下拉框（' + trendChannels.aggregationSelect +
          ' 个）—— 业主第 5 条要求删除聚合方式'
      )
    }
    if (trendChannels.statCards !== 0) {
      problems.push(
        '图表上方还有四张时间桶卡片（.card-grid--stats 出现 ' + trendChannels.statCards +
          ' 次）—— 业主第 5 条要求删掉、只留趋势曲线'
      )
    }
    if (trendChannels.granularityButtons < 2) {
      problems.push('找不到 X 轴的时间颗粒度按钮：' + trendChannels.granularityButtons)
    }
    const pressedGranularity = trendChannels.granularityPressed || []
    if (pressedGranularity.length !== 1) {
      problems.push('颗粒度按钮里选中的不是恰好一个：' + JSON.stringify(pressedGranularity))
    } else if (pressedGranularity[0] !== 'auto') {
      problems.push('颗粒度的默认档不是"自动"：' + JSON.stringify(pressedGranularity))
    }
    /*
     * 声压级 Y 轴 0–100：只在"图的提示里确实有 spl 那张"时才断言（没有数据的 profile 上
     * 一张图都不渲染，那时量不到不是缺陷，如实记日志）。
     */
    const yRanges = trendChannels.yRanges || []
    if (yRanges.length === 0) {
      log('trend channels/⑤: 这个 profile 里一张图都没渲染，"声压级 Y 轴 0–100"没验到')
    } else {
      const splEntry = yRanges.find((entry) => String(entry).startsWith('spl='))
      if (!splEntry) {
        problems.push('没有量到声压级那张图的 Y 轴范围：' + JSON.stringify(yRanges))
      } else if (!String(splEntry).endsWith('=0-100')) {
        problems.push('声压级那张图的 Y 轴不是 0–100：' + JSON.stringify(splEntry))
      }
      for (const entry of yRanges) {
        if (String(entry).startsWith('spl=')) continue
        if (!String(entry).endsWith('=auto')) {
          problems.push('非声压级的量不该固定 Y 轴：' + JSON.stringify(entry))
        }
      }
    }
    if (trendChannels.bucketBefore || trendChannels.fixedPressed !== undefined) {
      /*
       * "换了颗粒度真的重查了一次"这件事的证据，第 30 轮之后是**「自动」那一档的括号变了**
       * （它读的是查询回话里的桶宽）：选固定档之后括号消失（自动档没在跑）、点回自动又出现。
       * 再钉一条"点下去那一档真的被选中"。
       */
      if (trendChannels.fixedPressed !== 'true') {
        problems.push(
          '点了"1 分钟"这一档之后它没有被选中：' + JSON.stringify(trendChannels.fixedPressed)
        )
      }
      if (
        trendChannels.bucketBefore &&
        trendChannels.bucketAfterAuto &&
        trendChannels.bucketAfterAuto !== trendChannels.bucketBefore
      ) {
        problems.push(
          '点回"自动"之后桶宽没有还原：' + JSON.stringify(trendChannels.bucketAfterAuto) +
            '（应为 ' + JSON.stringify(trendChannels.bucketBefore) + '）'
        )
      }
      log(
        'trend channels/⑤: 桶宽（自动档）' + JSON.stringify(trendChannels.bucketBefore) +
          ' → 点 1 分钟档后的选中态 ' + JSON.stringify(trendChannels.fixedPressed) +
          ' → 点回自动 ' + JSON.stringify(trendChannels.bucketAfterAuto) +
          '；Y 轴 ' + JSON.stringify(yRanges)
      )
    } else {
      log(
        'trend channels/⑤: 量不到「自动（桶宽）」那个括号（这一段没有数据），' +
          '换颗粒度那一步没验到'
      )
    }
    /*
     * ── 通道选择（第 13 批第 4 条 + 第 30 轮业主最新一条） ──
     *
     * 全部**无条件**断言（除"改名按钮置灰"那一条要按设备在线状态分档，见下）。
     */
    if (trendChannels.panelExists !== true) {
      problems.push('趋势页没有通道选择那一块（[data-trend-channels]）')
    }
    if (trendChannels.panelRightOfDevice !== true) {
      problems.push(
        '通道选择不在设备的右侧（业主最新一条：「通道的选择应该放在设备的右侧的位置」）；' +
          '实测几何（判据是 `panelLeft >= deviceRight`；`sameRowAsSelect` 只作诊断，' +
          '下拉在一个带标签文字的 label 里，top 天然更低）' +
          JSON.stringify(trendChannels.geometry)
      )
    }
    if (trendChannels.chartCardWidthRatio !== null && trendChannels.chartCardWidthRatio < 95) {
      problems.push(
        '趋势曲线卡片没有占满内容宽度：' + trendChannels.chartCardWidthRatio +
          '%（业主：「趋势图还是占右侧区域的 100%」）'
      )
    }
    if (trendChannels.panelRows !== trendChannels.legendCount) {
      problems.push(
        '通道行数与勾选框数不一致：行 ' + trendChannels.panelRows +
          ' vs 勾选框 ' + trendChannels.legendCount
      )
    }
    if (trendChannels.panelRows < 2) {
      problems.push('通道只有 ' + trendChannels.panelRows + ' 行（多通道设备应当列出每一路）')
    }
    if (trendChannels.renameButtons !== trendChannels.panelRows) {
      problems.push(
        '改名按钮数（' + trendChannels.renameButtons + '）与通道行数（' +
          trendChannels.panelRows + '）不一致'
      )
    }
    /*
     * 改名是**写设备**：设备不在线时必须置灰并且给出原因。
     * 这一条按在线状态分档 —— 在线设备上按钮该是可用的（那种情况下探针不点它，
     * 因为点一下会真的改设备上的名字）。
     */
    const renameDisabled = trendChannels.renameDisabled || []
    if (String(trendChannels.deviceStatus || '').toUpperCase() === 'ONLINE') {
      if (renameDisabled.some(Boolean)) {
        log(
          'trend channels: 注意 —— 设备在线而改名按钮是禁用的：' +
            JSON.stringify(trendChannels.renameTitle)
        )
      }
    } else if (renameDisabled.length > 0 && renameDisabled.some((flag) => flag !== true)) {
      problems.push('设备离线时改名按钮仍然可用（点一次必然失败的按钮）')
    }
    if (renameDisabled.length > 0 && String(trendChannels.renameTitle || '').trim() === '') {
      problems.push('改名按钮没有说明"为什么不能改"（置灰而没有原因的按钮就是一个谜）')
    }
    if (trendChannels.rangeBefore !== null && trendChannels.rangeBefore !== undefined) {
      /*
       * 基准行数取自**第 3 支自己**测到的那个数（`panelRowsBeforeRange`）：五支是分开跑的，
       * 万一第 1 支（只读几何）超时，`panelRows` 就没有值，那时拿它当基准会立刻报一条假失败。
       */
      const rowsForEmpty = trendChannels.panelRowsBeforeRange || trendChannels.panelRows
      // 「无数据灰显 + 不可勾选」：切到 2000 年那一段之后，每一行都该是灰的且勾不动。
      if (rowsForEmpty > 0 && trendChannels.emptyRows !== rowsForEmpty) {
        problems.push(
          '把范围切到一段没有数据的区间之后，灰显的行数是 ' + trendChannels.emptyRows +
            '（应为 ' + rowsForEmpty + '）—— 「无数据灰显」没有按 hasData 走'
        )
      }
      if ((trendChannels.emptyChecksDisabled || []).some((flag) => flag !== true)) {
        problems.push(
          '没有数据的那几路勾选框仍然可勾（勾上只会画出一条空线）：' +
            JSON.stringify(trendChannels.emptyChecksDisabled)
        )
      }
      if (!/^0\s*\//.test(String(trendChannels.emptySummary || ''))) {
        problems.push('空区间的面板小结不是 "0 / N 路有数据"：' + JSON.stringify(trendChannels.emptySummary))
      }
      /*
       * 整页的"这一段没有数据"必须与那一列**同一句话**：所有可见通道都没数据时才该出现。
       * 这一条是第 25 轮探针抓到的真缺陷：`rangeIsEmpty` 原来只看**第一条通道**，
       * 于是"8 路里只有一路有读数（而那一路不是第一条）"时，页面左边说"这一段没有数据"、
       * 右边说"1 / 8 路有数据"。
       */
      if (trendChannels.emptyRangeEmptyState !== true) {
        problems.push('所有通道都没有数据的区间里，页面没有给出"这一段没有数据"的空态')
      } else if (/暂无历史数据|no history/i.test(String(trendChannels.emptyStateTitle || ''))) {
        problems.push(
          '这一段没有数据，页面却说"该设备暂无历史数据"（两句话说的是不同的事实）：' +
            JSON.stringify(trendChannels.emptyStateTitle)
        )
      }
      // 还原：范围回到原来那个预设，读数行也回来了。
      if (trendChannels.rangeAfter !== trendChannels.rangeBefore) {
        problems.push(
          '探针没有把时间范围还原：' + trendChannels.rangeBefore + ' → ' + trendChannels.rangeAfter
        )
      }
      if (trendChannels.rowsAfterRestore !== rowsForEmpty) {
        problems.push(
          '还原范围之后通道行数不对：' + trendChannels.rowsAfterRestore + '/' + rowsForEmpty
        )
      }
      /*
       * 数据回没回来：起点有几路有数据，还原之后就该有几路 —— 拿"起点小结"当基准，
       * 这样在"这个 profile 本来就没有读数"的机器上不会假红（那种情况只记日志）。
       */
      const startHadData = !/^0\s*\//.test(String(trendChannels.summaryAtStart || ''))
      if (!startHadData) {
        log(
          'trend channels: 注意 —— 这个 profile 起点就没有读数（' + trendChannels.summaryAtStart +
            '），"还原之后数据回来"这一条没验到'
        )
      } else if (trendChannels.dataRowsAfterRestore === 0) {
        problems.push(
          '还原时间范围之后一路数据都没有（起点 ' + trendChannels.summaryAtStart + '，还原后 ' +
            trendChannels.summaryAfterRestore + '）'
        )
      } else if (trendChannels.rangeEmptyStateAfterRestore) {
        problems.push(
          '还原时间范围之后页面仍然显示空态（' + trendChannels.rangeEmptyStateAfterRestore +
            '），而那一列说有数据'
        )
      } else {
        log(
          'trend channels/④: 空区间 0/N → 灰显 ' + trendChannels.emptyRows + ' 行、勾选框禁用 ' +
            JSON.stringify(trendChannels.emptyChecksDisabled) + '；还原后 ' + trendChannels.summaryAfterRestore
        )
      }
    }
    // ① 点灭一条通道：只有它变 false，其余不变。
    if (trendChannels.pressedAfterHide) {      const before = trendChannels.pressedAtStart || []
      const after = trendChannels.pressedAfterHide
      const turnedOff = after.filter((value, index) => before[index] === 'true' && value === 'false')
      if (turnedOff.length !== 1) {
        problems.push('点一下通道名没有恰好点灭一条：' + JSON.stringify({ before, after }))
      }
      if (JSON.stringify(after) === JSON.stringify(before)) {
        problems.push('点通道名之后 aria-pressed 一个都没变（那一下点了没反应）')
      }
      /*
       * ② 关键：**点通道名只改显示、不重新查库**。
       *
       * 第 30 轮之前这一条是看诊断行里的「本次查询条数」有没有变；那一行被业主删掉之后，
       * 真窗口里**不再有**这个读数（如实记在 UI-VERIFY 的未验证清单里）。
       * 现在这一条只由源码守卫钉住（`toggleChannel()` 里没有 `query()`，见
       * `tests/trend-channels.test.ts`），这里补一条**行为上的旁证**：点一下之后
       * 图上的点数（`data-metric-chart` 那张卡的 series 长度）不该变 —— 由探针的
       * "多点一次恢复原状"那一条覆盖。
       */
      if (JSON.stringify(trendChannels.pressedAfterRestore) !== JSON.stringify(trendChannels.pressedAtStart)) {
        problems.push('再点一下没有恢复：' + JSON.stringify(trendChannels.pressedAfterRestore))
      }
    }
    // ③ 多选一个量：选中集合确实多了一个，恢复后回到起点。
    if (trendChannels.selectedMetrics) {
      if (trendChannels.selectedMetrics.length !== 2) {
        problems.push('多选一个量之后选中的不是 2 个：' + JSON.stringify(trendChannels.selectedMetrics))
      }
      if (!Array.isArray(trendChannels.selectedMetricsRestored) ||
          trendChannels.selectedMetricsRestored.length !== 1) {
        problems.push('取消多选之后没有回到一个量：' + JSON.stringify(trendChannels.selectedMetricsRestored))
      }
    } else if (trendChannels.metricButtonsSkipped !== undefined) {
      log(
        'trend channels/④: 注意 —— 量的按钮只有 ' + trendChannels.metricButtonsSkipped +
          ' 个（这一支跑了，只是页面上没有第二个量可点），多选这一条没验到'
      )
    }
    if (trendChannels.chartCount === 0) {
      log(
        'trend channels: ⚠️ 这一个 profile 里一张图都没渲染（没有落在这一段范围里的读数；' +
          'historyEmpty=' + trendChannels.historyEmpty + '），' +
          '**"多条通道真的画在同一根轴上"这一条本机未验证**。'
      )
    } else {
      // 图渲染了：每张图的提示里写着"N 条通道"，那个数必须等于通道数。
      const hints = trendChannels.chartHints || []
      for (const hint of hints) {
        const match = /(\d+)\s*(条通道|channel)/.exec(String(hint))
        if (!match) {
          problems.push('图的提示行里没有"N 条通道"：' + JSON.stringify(hint))
          continue
        }
        if (Number(match[1]) !== trendChannels.legendCount) {
          problems.push(
            '图里的通道数与图例不一致：' + match[1] + ' vs ' + trendChannels.legendCount +
            '（两条线少了/多了一条而图例没跟着变）'
          )
        }
      }
      if ((trendChannels.metricEmpty || []).length > 0) {
        log(
          'trend channels: 注意 —— 有 ' + trendChannels.metricEmpty.length +
          ' 个量在这段时间里没有读数（画的是空态）：' + JSON.stringify(trendChannels.metricEmpty)
        )
      }
    }
  }

  /**
   * 第 13 批第 6 条：时间轴缩放 / 数据导出 / 打印为 PDF。
   *
   * WHY A SEPARATE DRILL
   * 这三件事都要**动手**（滚轮、点击、调 IPC），而上一版把它们塞进趋势页那一段之后，
   * 一卡住整段就只剩 `{"probeTimeout":true}` —— 连带着把已经量到的通道列、颗粒度那些读数
   * 全丢了。分开之后：这一段挂了，那一段的证据还在。
   *
   * 每一步都在 `document.body.dataset.probeStep` 上留一个标记：万一这一段自己挂了，
   * 下一条（很短、很快）能读回"卡在哪一步"，而不是只有一句"超时"。
   */
  const trendZoom = await layout('/trends', '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = {};' +
    'const mark = (step) => { try { document.body.dataset.probeStep = step; } catch (e) {} };' +
    'mark("start");' +
    'const withTimeout = (promise, ms, label) => Promise.race([' +
    '  promise,' +
    '  wait(ms).then(() => ({ success: false, error: { message: label + " 超时" } }))' +
    ']);' +
    'out.exportButton = document.querySelectorAll("[data-trend-export]").length;' +
    'out.printButton = document.querySelectorAll("[data-trend-print]").length;' +
    /*
     * 打印：把 `window.print` **换成桩**再点 —— 真点会弹出系统打印对话框（模态窗口），
     * 探针会永远等下去。而且**先确认桩装上了再点**：装不上就不点，如实记
     * `printStubActive: false`。宁可这一条"没验到"，也不能让探针卡在一个对话框上。
     */
    'const realPrint = window.print;' +
    'let printStub = null;' +
    'try {' +
    '  printStub = function () { out.printCalls += 1; };' +
    '  window.print = printStub;' +
    '} catch (error) { printStub = null; }' +
    'out.printCalls = 0;' +
    'out.printStubActive = printStub !== null && window.print === printStub;' +
    'if (out.printStubActive) {' +
    '  const printButton = document.querySelector("[data-trend-print]");' +
    '  if (printButton) printButton.click();' +
    '}' +
    'window.print = realPrint;' +
    'mark("print");' +
    /*
     * 缩放：图旁边真的滚一下滚轮（`dataZoom: inside` 认的就是这个），看那一行提示出不出来。
     * 没有图的 profile 上如实记 null（这一条只在有历史数据时才谈得上）。
     */
    'out.zoomBarBefore = document.querySelectorAll("[data-trend-zoom-bar]").length;' +
    'out.zoomCanvas = !!document.querySelector("[data-metric-chart] canvas, .chart__canvas canvas");' +
    'out.zoomBarAfterWheel = null;' +
    'out.zoomBarAfterReset = null;' +
    'if (out.zoomCanvas) {' +
    '  const canvas = document.querySelector("[data-metric-chart] canvas, .chart__canvas canvas");' +
    '  const rect = canvas.getBoundingClientRect();' +
    '  canvas.dispatchEvent(new WheelEvent("wheel", {' +
    '    bubbles: true, cancelable: true, deltaY: -240,' +
    '    clientX: Math.round(rect.left + rect.width / 2),' +
    '    clientY: Math.round(rect.top + rect.height / 2)' +
    '  }));' +
    '  for (let i = 0; i < 12 && document.querySelectorAll("[data-trend-zoom-bar]").length === 0; i += 1) {' +
    '    await wait(200);' +
    '  }' +
    '  out.zoomBarAfterWheel = document.querySelectorAll("[data-trend-zoom-bar]").length;' +
    '  out.zoomHintText = (function(){' +
    '    const el = document.querySelector("[data-trend-zoom-hint]");' +
    '    return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "";' +
    '  })();' +
    '  const reset = document.querySelector("[data-trend-zoom-reset]");' +
    '  if (reset) { reset.click(); await wait(500); }' +
    '  out.zoomBarAfterReset = document.querySelectorAll("[data-trend-zoom-bar]").length;' +
    '}' +
    'mark("wheel");' +
    /*
     * 导出：**直接调 IPC**（不经按钮，所以与"这一屏有没有数据"无关），写完由 driver
     * 去磁盘上核对。写的是**当前配置的**导出目录（`存储根/exports/trends/`）——
     * 刻意**不切存储根**：切根会触发一次存储迁移，而 `--with-data` 用的是操作员真库的副本、
     * 指向他真实的存储目录（第 27 轮第一版就是那样卡住的）。driver 核对完会把这两个文件删掉。
     */
    'const csvText = "\\uFEFFtimestamp_iso,timestamp_ms,metric,channel,channel_name,value,unit,sample_count\\r\\n" +' +
    '  "2026-09-19T07:30:00.000Z,1758267000000,spl,0,CH1,62.3,dB,12\\r\\n" +' +
    '  "2026-09-19T07:30:00.000Z,1758267000000,spl,1,\\"1#机组, 东侧\\",58.1,dB,11\\r\\n";' +
    'const exported = await withTimeout(window.api.trends.exportCsv({' +
    '  fileName: "probe-trend-export.csv", csv: csvText' +
    '}), 20000, "导出");' +
    'out.exportOk = !!(exported && exported.success);' +
    'out.exportError = exported && !exported.success ? String(exported.error && exported.error.message) : null;' +
    'out.exportPath = exported && exported.success ? exported.data.path : null;' +
    'out.exportBytes = exported && exported.success ? exported.data.bytes : null;' +
    'out.exportRows = exported && exported.success ? exported.data.rows : null;' +
    'const escaped = await withTimeout(window.api.trends.exportCsv({' +
    '  fileName: "..\\\\..\\\\probe-escape.csv", csv: csvText' +
    '}), 20000, "导出（越界文件名）");' +
    'out.escapeOk = !!(escaped && escaped.success);' +
    'out.escapePath = escaped && escaped.success ? escaped.data.path : null;' +
    'out.exportDir = out.exportPath ? out.exportPath.slice(0, out.exportPath.lastIndexOf("\\\\")) : null;' +
    'out.escapeInsideDir = !!(out.escapePath && out.exportDir &&' +
    '  out.escapePath.slice(0, out.escapePath.lastIndexOf("\\\\")) === out.exportDir);' +
    'mark("export");' +
    'return JSON.stringify(out);' +
    '})()', 60_000)
  log('trend zoom/export: ' + JSON.stringify(trendZoom))

  if (trendZoom.probeTimeout === true) {
    /*
     * 这一段自己挂了：读回它留的标记，至少说清卡在哪一步（下一条很短，所以即使上一条
     * 是被拖垮的，这一条通常还能返回）。
     */
    const marker = await layout('/trends', '(() => JSON.stringify({' +
      '  step: document.body.dataset.probeStep || null' +
      '}))()', 20_000)
    problems.push(
      '第 6 条那一组探针超时（卡在 ' + JSON.stringify(marker.step) + ' 那一步）—— ' +
        '"时间轴缩放 / 导出 / 打印"这三条没有任何结论'
    )
  } else {
    if (trendZoom.exportButton !== 1) {
      problems.push('图表卡片上没有「导出数据」按钮：' + trendZoom.exportButton)
    }
    if (trendZoom.printButton !== 1) {
      problems.push('图表卡片上没有「打印 / 存为 PDF」按钮：' + trendZoom.printButton)
    }
    if (trendZoom.printStubActive === false) {
      log('trend zoom/export: window.print 换不成桩，打印这一条**没验到**（不点它，免得弹出对话框）')
    } else if (trendZoom.printCalls !== 1) {
      problems.push(
        '点了「打印 / 存为 PDF」之后 window.print 被调用了 ' + trendZoom.printCalls +
          ' 次（应为 1 次）—— 按钮没有接上打印'
      )
    }
    if (trendZoom.zoomCanvas !== true) {
      log('trend zoom/export: 这个 profile 里一张图都没渲染，"滚轮缩放"没验到')
    } else {
      /*
       * ⚠ 第 37 轮加的一步：**用可信滚轮再量一次**。
       *
       * 上面那次是页面里 `canvas.dispatchEvent(new WheelEvent(...))` —— 合成事件，
       * `isTrusted === false`。它量不到"滚轮缩放"有两个完全不同的可能：zrender 不认合成事件，
       * 或者第 34 轮加的**手势闸门**（只在捕获阶段的真实 `wheel`/`pointerdown` 上记一次手势）
       * 把这次缩放丢掉了。判据分不开这两者，而它们的修法完全不同。
       * 所以这里从**浏览器进程**发一次真滚轮（`webContents.sendInputEvent`，它产生的是
       * `isTrusted === true` 的事件，位置取画面中央）——这才是操作员真的滚一下。
       */
      const wheelProbe = await layout('/trends', '(() => {' +
        'const canvas = document.querySelector("[data-metric-chart] canvas, .chart__canvas canvas");' +
        'if (!canvas) return JSON.stringify({ ok: false });' +
        'const rect = canvas.getBoundingClientRect();' +
        'return JSON.stringify({ ok: true, x: Math.round(rect.left + rect.width / 2),' +
        '  y: Math.round(rect.top + rect.height / 2),' +
        '  before: document.querySelectorAll("[data-trend-zoom-bar]").length });' +
        '})()', 30_000)
      if (wheelProbe.ok === true) {
        win.webContents.sendInputEvent({
          type: 'mouseWheel',
          x: wheelProbe.x,
          y: wheelProbe.y,
          deltaX: 0,
          deltaY: -240,
          wheelTicksX: 0,
          wheelTicksY: 3,
          canScroll: false
        })
        await sleep(900)
        const trusted = await layout('/trends', '(() => JSON.stringify({' +
          '  bars: document.querySelectorAll("[data-trend-zoom-bar]").length,' +
          '  hint: (document.querySelector("[data-trend-zoom-hint]") || {}).textContent || ""' +
          '}))()', 30_000)
        log(
          'trend zoom/export: 可信滚轮（浏览器进程发出）→ 提示行 ' + trusted.bars +
            ' 条，文本 ' + JSON.stringify(String(trusted.hint).trim())
        )
        if (trusted.bars !== 1) {
          problems.push(
            '**可信**滚轮（`sendInputEvent`）之后仍然没有"当前显示第 a–b 个点"那一行（' +
              JSON.stringify({ bars: trusted.bars, before: wheelProbe.before }) +
              '）—— 合成事件那一次的失败因此不是"事件不可信"，要去看手势闸门与 zrender 的滚轮处理'
          )
        }
      } else {
        log('trend zoom/export: 可信滚轮没验到（这一屏没有画布）')
      }
      /*
       * ⚠ 合成滚轮那一次**不是**判据（第 37 轮实测）：页面里 `dispatchEvent(new WheelEvent(…))`
       * 产生的是 `isTrusted === false` 的事件，**zrender 不认它**（所以提示行一直是 0）——
       * 这是探针的局限，不是产品缺陷。真正可信的那一次（上面 `sendInputEvent`）在
       * `probe-round53.log` 里量到了：
       * `当前显示第 2–17 个点（共 19 点）：2026/9/14 10:30 ~ 2026/9/17 18:00`
       * —— 既证明了滚轮缩放能出提示行，也证明了**提示写的是时间范围**（X 轴真的是时间轴）。
       * 所以这里只记日志，不断言。
       */
      log(
        'trend zoom/export: 合成滚轮（页面派发，isTrusted=false）→ 提示行 ' +
          trendZoom.zoomBarAfterWheel + '（zrender 不认合成事件，这一条不作判据）'
      )
      if (trendZoom.zoomBarAfterReset !== 0) {
        problems.push('点了「重置缩放」之后提示行还在：' + trendZoom.zoomBarAfterReset)
      }
      log(
        'trend zoom/export: 滚轮前 ' + trendZoom.zoomBarBefore + ' → 滚轮后 ' +
          trendZoom.zoomBarAfterWheel + ' → 重置后 ' + trendZoom.zoomBarAfterReset +
          '；提示 ' + JSON.stringify(trendZoom.zoomHintText)
      )
    }
    if (trendZoom.exportOk !== true) {
      problems.push('导出 CSV 的 IPC 失败了：' + JSON.stringify(trendZoom.exportError))
    } else {
      if (trendZoom.exportRows !== 2) {
        problems.push(
          '导出返回的数据行数不是 2：' + JSON.stringify(trendZoom.exportRows) +
            '（返回的行数必须来自**读回**的那一份文件）'
        )
      }
      if (!trendZoom.exportPath || !trendZoom.exportPath.includes('exports')) {
        problems.push('导出的路径不在导出目录里：' + JSON.stringify(trendZoom.exportPath))
      }
      if (trendZoom.escapeInsideDir !== true) {
        problems.push(
          '文件名里的 `..\\..\\` 没被收掉（可以写到导出目录之外）：' +
            JSON.stringify({ path: trendZoom.escapePath, dir: trendZoom.exportDir })
        )
      }
      // driver 侧核对：文件真的在磁盘上、内容真的能读回来（写后读回核对的最后一环）。
      try {
        const bytes = fs.statSync(trendZoom.exportPath).size
        const text = fs.readFileSync(trendZoom.exportPath, 'utf8')
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
        if (bytes !== trendZoom.exportBytes) {
          problems.push('导出报的字节数与磁盘上的不一致：' + trendZoom.exportBytes + ' vs ' + bytes)
        }
        if (lines.length !== 3) {
          problems.push('导出的文件里不是"表头 + 2 行"：' + JSON.stringify(lines.length))
        }
        if (!text.startsWith('\uFEFF')) {
          problems.push('导出的 CSV 没有 UTF-8 BOM（Excel 打开中文会乱码）')
        }
        if (!text.includes('"1#机组, 东侧"')) {
          problems.push('含逗号的通道名没有被引号包起来（列会错位）')
        }
        log(
          'trend zoom/export: 导出落盘 ' + bytes + ' 字节 / ' + (lines.length - 1) +
            ' 行数据 → ' + trendZoom.exportPath + '；打印调用 ' + trendZoom.printCalls + ' 次'
        )
      } catch (error) {
        problems.push('导出的文件读不回来：' + (error instanceof Error ? error.message : String(error)))
      }
    }
    /*
     * 收尾：把两个探针文件删掉，再试着删掉那个（可能）空掉的导出目录。
     * 写入用的是**当前配置的**存储根，那在 `--with-data` 下就是操作员真实的存储目录 ——
     * 探针不该在他的机器上留文件。删完**读回确认**（`existsSync` 为 false）。
     */
    for (const file of [trendZoom.exportPath, trendZoom.escapePath]) {
      if (!file) continue
      try {
        fs.rmSync(file, { force: true })
      } catch (error) {
        log('trend zoom/export: 探针文件删不掉：' + file + '（' + String(error) + '）')
      }
    }
    const leftovers = [trendZoom.exportPath, trendZoom.escapePath].filter(
      (file) => !!file && fs.existsSync(file)
    )
    if (leftovers.length > 0) {
      problems.push('导出探针在自己机器上留下了文件：' + JSON.stringify(leftovers))
    }
    if (trendZoom.exportDir) {
      try {
        if (fs.readdirSync(trendZoom.exportDir).length === 0) fs.rmdirSync(trendZoom.exportDir)
      } catch {
        // 目录不空或删不掉都无所谓：它本来就是应用的导出目录。
      }
    }
  }

  /**
   * 本地样本库（schema v7）与 AI 标注：**控件真的在**这一层。
   *
   * 一次性 profile 里没有样本行、也没有配置过 AI，所以能验证的是：
   *   - 两个入口按钮存在（告警中心的批量「加入样本库」、录音文件的「加入样本库」列）；
   *   - 样本库页有导出卡片与 AI 卡片；
   *   - AI 未配置时**如实说原因**（不是笼统的"不可用"）且「让 AI 标注」按钮是**禁用**的
   *     —— "按钮在但点了没反应"是最坏的形态：用户会以为 AI 看过一遍什么都没发现。
   */
  const alarmsSampleEntry = await layout('/alarms', '(() => {' +
    'const buttons = [...document.querySelectorAll(".page button")].map((b) => b.textContent.trim());' +
    'const addButton = [...document.querySelectorAll(".page button")]' +
    '  .find((b) => b.textContent.trim() === "加入样本库");' +
    'return JSON.stringify({' +
    '  hasAdd: !!addButton,' +
    '  addDisabled: addButton ? addButton.disabled : null,' +
    '  labels: buttons.slice(0, 12)' +
    '});})()')
  log('samples entry : ' + JSON.stringify(alarmsSampleEntry))
  if (!alarmsSampleEntry.hasAdd) {
    problems.push('告警中心没有「加入样本库」按钮：' + JSON.stringify(alarmsSampleEntry.labels))
  } else if (alarmsSampleEntry.addDisabled !== true) {
    // 没勾任何记录时它必须是灰的：否则一点就是"入库 0 条"这种没意义的回执。
    problems.push('没有勾选记录时「加入样本库」不是禁用状态')
  }

  const recordingsSampleColumn = await layout('/recordings', '(() => {' +
    'const heads = [...document.querySelectorAll("table thead th")].map((n) => n.textContent.trim());' +
    'return JSON.stringify({ heads });})()')
  log('recordings col: ' + JSON.stringify(recordingsSampleColumn))
  if (!recordingsSampleColumn.heads.includes('样本库')) {
    problems.push('录音文件的表头里没有「样本库」列：' + JSON.stringify(recordingsSampleColumn.heads))
  }

  const samplesChrome = await layout('/samples', '(() => {' +
    'const titles = [...document.querySelectorAll(".page .section-title")].map((n) => n.textContent.trim());' +
    'const state = document.querySelector(".ai-state");' +
    'const runButton = [...document.querySelectorAll(".page button")]' +
    '  .find((b) => b.textContent.trim() === "让 AI 标注");' +
    'const rows = document.querySelectorAll("table tbody tr").length;' +
    'const heads = [...document.querySelectorAll("table thead th")].map((n) => n.textContent.trim());' +
    'const columns = [...document.querySelectorAll(".label-column__head")].map((n) => n.textContent.trim());' +
    'return JSON.stringify({' +
    '  titles,' +
    '  aiState: state ? state.textContent.trim() : "",' +
    '  runFound: !!runButton,' +
    '  runDisabled: runButton ? runButton.disabled : null,' +
    '  heads,' +
    '  labelColumns: columns,' +
    '  rows' +
    '});})()')
  log('samples chrome: ' + JSON.stringify(samplesChrome))
  if (!samplesChrome.titles.includes('导出数据集')) {
    problems.push('样本库页没有「导出数据集」卡片：' + JSON.stringify(samplesChrome.titles))
  }
  if (!samplesChrome.titles.includes('AI 标注（可选）')) {
    problems.push('样本库页没有 AI 标注卡片：' + JSON.stringify(samplesChrome.titles))
  }
  // 标签库（两个维度）必须**同时**在：只渲染一维就等于"故障类型没有设备类型可配"。
  if (!samplesChrome.titles.includes('标签库')) {
    problems.push('样本库页没有「标签库」卡片：' + JSON.stringify(samplesChrome.titles))
  }
  for (const dimension of ['设备类型', '故障类型']) {
    if (!samplesChrome.labelColumns.includes(dimension)) {
      problems.push('标签库里没有「' + dimension + '」一栏：' + JSON.stringify(samplesChrome.labelColumns))
    }
    if (!samplesChrome.heads.includes(dimension)) {
      problems.push('样本表里没有「' + dimension + '」列：' + JSON.stringify(samplesChrome.heads))
    }
  }
  // 未配置时必须说出**具体**原因，而不是"不可用"三个字。
  if (!/未启用|未填接口地址|接口地址不合法|未填模型名|已配置/.test(samplesChrome.aiState)) {
    problems.push('AI 状态行没有说出具体原因：' + JSON.stringify(samplesChrome.aiState))
  }
  if (!samplesChrome.runFound) {
    problems.push('样本库页找不到「让 AI 标注」按钮')
  } else if (samplesChrome.runDisabled !== true) {
    problems.push('AI 未配置时「让 AI 标注」按钮不是禁用的（点了会失败，用户却以为它跑过了）')
  }

  /**
   * 实时监测页的结构（业主 2026-09-17 的第②批：③④⑦）。
   *
   * 一次性 profile 里两台设备都在（一台声纹设备、一台相机），但**都离线**，所以量得到的是
   * 布局事实而不是数据流：
   *   - 设备下拉**在顶栏那一格里**（`#topbar-page-slot`），且宽度约为顶栏的一半；
   *   - 「数据流状态」与「当前帧」两张卡片**不在了**（`.stream-strip` 为 0）；
   *   - 实时视频墙与相机声学数据卡片**不在了**（页面上不再有它们的根节点）。
   *
   * 这三条都必须**按 DOM 断言**：源码里删掉一个组件而它在别处又被挂回来，是这套代码里
   * 最容易发生的事（同一个组件在总览页还在用）。
   */
  const monitorChrome = await layout('/monitor', '(() => {' +
    'const slot = document.querySelector("#topbar-page-slot");' +
    'const select = slot ? slot.querySelector("select") : null;' +
    'const topbar = document.querySelector(".topbar");' +
    'const topbarWidth = topbar ? topbar.getBoundingClientRect().width : 0;' +
    'const slotWidth = slot ? slot.getBoundingClientRect().width : 0;' +
    /*
     * 第 6 条（业主 2026-09-17）：下拉宽度是那一格的 50%、靠右，**紧挨着**右侧的设备数量。
     * 三件事都只能量：宽度比（50%）、它右边到那一格右边缘的缝（靠右 = 缝≈0）、
     * 以及它右边到 `.indicators`（里面第一个就是设备总数）的距离（就是顶栏的 16px 间距）。
     */
    'const selectRect = select ? select.getBoundingClientRect() : null;' +
    'const slotRect = slot ? slot.getBoundingClientRect() : null;' +
    'const indicators = document.querySelector(".topbar .indicators");' +
    'const indicatorsRect = indicators ? indicators.getBoundingClientRect() : null;' +
    'return JSON.stringify({' +
    '  slotExists: !!slot,' +
    '  selectInSlot: !!(select && slot && slot.contains(select)),' +
    '  selectWidth: selectRect ? Math.round(selectRect.width) : -1,' +
    '  slotRatio: topbarWidth > 0 ? Math.round((slotWidth / topbarWidth) * 100) : -1,' +
    '  selectRatio: slotWidth > 0 && selectRect ? Math.round((selectRect.width / slotWidth) * 100) : -1,' +
    '  selectRightGapToSlot: slotRect && selectRect ? Math.round(slotRect.right - selectRect.right) : null,' +
    '  selectToIndicatorsGap: indicatorsRect && selectRect ? Math.round(indicatorsRect.left - selectRect.right) : null,' +
    /*
     * 业主 2026-09-18 第 19 条：设备在不在线**用绿点/灰点在选择设备时表示**，
     * 并且删掉了那一句"实时流未接入"。两件都能量：
     *   - `[data-device-status-dot]` 在、而且它的类是 online/offline 之一；
     *   - 下拉里每一项前面带 `●`/`○`（原生 option 画不出颜色，见 MonitorView 的注释）；
     *   - 那句已删除说明的容器一个都不许再有。
     */
    '  deviceStatusDot: (() => {' +
    '    const dot = slot ? slot.querySelector("[data-device-status-dot]") : null;' +
    '    if (!dot) return null;' +
    '    return { online: dot.classList.contains("dot--online"), offline: dot.classList.contains("dot--offline") };' +
    '  })(),' +
    '  deviceOptionMarks: select' +
    '    ? Array.prototype.slice.call(select.options).map((o) => (o.textContent || "").trim().charAt(0))' +
    '    : [],' +
    '  sonarLiveUnwired: document.querySelectorAll("[data-sonar-live-unwired]").length,' +
    '  streamStrip: document.querySelectorAll(".stream-strip").length,' +
    '  videoWall: document.querySelectorAll(".video-wall, .camera-video-wall").length,' +
    '  alarmEntry: document.querySelectorAll(".camera-alarm-entry").length,' +
    /*
     * ② 每通道声纹特性：2026-09-19 第 13 批第 3 条把它从"每通道一张小卡"改成了
     * **一张表**，并且加了"是否告警"一列与详情弹窗。这一段的量法整块搬到了下面那条
     * `monitor table/autostart` 探针里（表头六列 / 行数 / 告警格 / 等高 / 点行切通道），
     * 因为那一条还要做**交互**（点行、点告警），而这一段只取快照。
     * 这里只留通道页签数：下面的版式断言用它确认"这一页确实是声纹那一支"。
     */
    '  channelTabs: document.querySelectorAll(".channel-tab").length,' +
    '  playButton: document.querySelectorAll(".audio-bar__play").length,' +
    '  playDisabled: (function(){ const b = document.querySelector(".audio-bar__play");' +
    '    return b ? b.disabled : null; })(),' +
    '  volumeSlider: document.querySelectorAll(".audio-bar__slider").length,' +
    '  volumeValue: (function(){ const s = document.querySelector(".audio-bar__slider");' +
    '    return s ? s.value : null; })(),' +
    '  previewHint: document.querySelectorAll(".audio-bar__hint").length,' +
    /*
     * ③b 版式：趋势置顶、其下四张图谱卡片、再下面时间轴回放。
     * 量的是**几何**（谁在谁上面），因为这一条改动只有版式：顺序一被改回去，
     * 页面照样能看，只是"一进页面要先滚动才看得到趋势"。
     */
    '  layout3b: (function(){' +
    '    const rect = (el) => (el ? el.getBoundingClientRect() : null);' +
    '    const trend = rect(document.querySelector(".trend-panel"));' +
    '    const grid = document.querySelector(".graph-grid");' +
    '    const gridRect = rect(grid);' +
    '    const cards = grid ? [...grid.querySelectorAll(":scope > .card")] : [];' +
    '    const track = rect(document.querySelector(".mtl__track"));' +
    '    return {' +
    '      trendTop: trend ? Math.round(trend.top) : null,' +
    '      trendHeight: trend ? Math.round(trend.height) : null,' +
    '      gridTop: gridRect ? Math.round(gridRect.top) : null,' +
    '      gridCards: cards.length,' +
    '      gridCardWidths: cards.map((card) => Math.round(card.getBoundingClientRect().width)),' +
    '      gridCardHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),' +
    '      timelineTop: track ? Math.round(track.top) : null,' +
    '      timelineTrackWidth: track ? Math.round(track.width) : null,' +
    '      timelineSegments: document.querySelectorAll(".mtl__segment").length,' +
    '      timelineTicks: document.querySelectorAll(".mtl__tick").length,' +
    '      timelineEmptyShown: document.querySelectorAll(".mtl__state").length > 0,' +
    '      timelineLocalOnly: document.querySelectorAll(".mtl__hint").length' +
    '    };' +
    '  })(),' +
    '});})()')
  log('monitor chrome: ' + JSON.stringify(monitorChrome))
  if (!monitorChrome.slotExists) {
    problems.push('顶栏没有页面控件那一格（#topbar-page-slot）')
  } else if (!monitorChrome.selectInSlot) {
    problems.push('实时监测的设备下拉没有被投到顶栏那一格里')
  } else {
    // 业主指定 50%。给一个宽容带：40–60% 都算"一半"，因为顶栏还有内边距与两侧内容。
    if (monitorChrome.slotRatio < 40 || monitorChrome.slotRatio > 60) {
      problems.push('顶栏那一格不是约 50% 宽：' + monitorChrome.slotRatio + '%')
    }
    /*
     * 第 6 条：下拉本身是那一格的 50%（不是填满那一格），且靠右、紧挨设备数量。
     * 上界给到 60%（含 select 自身的 1px 边框与亚像素取整）；下界 40% 同理由。
     */
    if (monitorChrome.selectRatio < 40 || monitorChrome.selectRatio > 60) {
      problems.push(
        '实时监测页的设备下拉不是那一格的约 50%：' + monitorChrome.selectRatio + '%（第 6 条）'
      )
    }
    if (
      monitorChrome.selectRightGapToSlot === null ||
      monitorChrome.selectRightGapToSlot > 2
    ) {
      problems.push(
        '设备下拉没有靠右：它右边到那一格右边缘还有 ' + monitorChrome.selectRightGapToSlot + 'px'
      )
    }
    if (
      monitorChrome.selectToIndicatorsGap === null ||
      monitorChrome.selectToIndicatorsGap < 0 ||
      monitorChrome.selectToIndicatorsGap > 24
    ) {
      problems.push(
        '设备下拉没有紧挨着「设备数量」那组指示器：间距 ' +
          monitorChrome.selectToIndicatorsGap + 'px'
      )
    }
    /*
     * 业主 2026-09-18 第 19 条：选设备时用绿点/灰点说在线与否，
     * 并且那一段"实时流尚未接入"的说明已经删掉。
     */
    const dot = monitorChrome.deviceStatusDot
    if (!dot) {
      problems.push('设备下拉旁边没有在线状态点（[data-device-status-dot]）—— 第 19 条')
    } else if (!dot.online && !dot.offline) {
      problems.push('在线状态点既不是绿点也不是灰点：' + JSON.stringify(dot))
    }
    if ((monitorChrome.deviceOptionMarks || []).length === 0) {
      problems.push('设备下拉里一个选项都没有（这一条只能在有设备时量）')
    } else if (
      !(monitorChrome.deviceOptionMarks || []).every((mark) => mark === '●' || mark === '○')
    ) {
      problems.push(
        '设备下拉的选项没有 ●/○ 标记：' + JSON.stringify(monitorChrome.deviceOptionMarks)
      )
    }
    if (monitorChrome.sonarLiveUnwired !== 0) {
      problems.push(
        '「实时音频/时频流尚未接入…」那段说明又出现了（' +
          monitorChrome.sonarLiveUnwired + ' 处）—— 业主第 19 条要求删掉'
      )
    }
  }
  if (monitorChrome.streamStrip > 0) {
    problems.push('实时监测页还有「数据流状态」那条（.stream-strip 出现了 ' + monitorChrome.streamStrip + ' 次）')
  }
  if (monitorChrome.videoWall > 0) {
    problems.push('实时监测页还有视频墙（.video-wall 出现了 ' + monitorChrome.videoWall + ' 次）')
  }

  /*
   * ② 每通道声纹特性卡片（只在声纹设备那一支上有；上面那次 /monitor 打开时选中的就是它）。
   *
   * 全部是**无条件**断言：卡片数、每张卡片的"值/时间/状态"三件套、播放与音量控件。
   * 数据是真是假此刻量不出来（这台设备离线），所以只断言结构 —— 但"卡片一个都没渲染"
   * 与"数据没来"必须能分开：前者是数量对不上，后者是卡片显示"未读取"。
   */
  {
    /*
     * ② 的"每通道一张卡片"那一套断言**整块搬走**了（2026-09-19 第 13 批第 3 条把它改成
     * 一张表）：表头六列 / 行数 / 告警格 / 等高 / 点行切通道 / 点告警开详情，现在由下面那条
     * `monitor table/autostart` 探针负责（它还要做交互，而这里只取快照）。
     * 这里只留音频条那三件（与表无关，仍然是这一支的控件）。
     */
    if (monitorChrome.playButton !== 1) {
      problems.push('实时监测页的音频播放按钮不是恰好一个：' + monitorChrome.playButton)
    }
    if (monitorChrome.volumeSlider !== 1) {
      problems.push('实时监测页的音量滑杆不是恰好一个：' + monitorChrome.volumeSlider)
    }
    if (monitorChrome.previewHint !== 1) {
      problems.push('播放按钮旁边没有那句"播的是什么"的说明（.audio-bar__hint）：' +
        monitorChrome.previewHint)
    }
    log(
      'monitor chrome/②: 通道页签 ' + monitorChrome.channelTabs + ' 个，播放按钮 disabled=' +
        monitorChrome.playDisabled + '（无预览帧时应当为 true），音量 ' + monitorChrome.volumeValue + '%'
    )
  }

  /*
   * ③b 版式：趋势置顶 → 其下四张图谱卡片 → 再下面时间轴回放。
   *
   * 全部是**无条件**断言：量不到（null）就是问题 —— "这一块没渲染"与"版式对了"在一份
   * 只列 problems 的报告里长得一样（§15.13.5）。
   */
  {
    const info = monitorChrome.layout3b || {}
    if (info.trendTop === null || info.gridTop === null) {
      problems.push('量不到趋势卡片或四张图谱卡片：' + JSON.stringify(info))
    } else {
      if (!(info.gridTop > info.trendTop)) {
        problems.push('四张图谱卡片不在趋势下面：趋势 top ' + info.trendTop + '，卡片 top ' + info.gridTop)
      }
      if (info.trendHeight === null || info.trendHeight < 120) {
        problems.push('趋势卡片的高度不合理：' + info.trendHeight)
      }
    }
    if (info.gridCards !== 4) {
      problems.push('四张图谱卡片不是恰好四张：' + info.gridCards + '（' + JSON.stringify(info.gridCardWidths) + '）')
    } else {
      const narrowest = Math.min(...info.gridCardWidths)
      if (narrowest < 400) {
        problems.push('四张图谱卡片里有卡片被压得太窄：' + narrowest + 'px（' + JSON.stringify(info.gridCardWidths) + '）')
      }
      const flat = info.gridCardHeights.filter((height) => height < 100)
      if (flat.length > 0) {
        problems.push('四张图谱卡片里有卡片没有高度：' + JSON.stringify(info.gridCardHeights))
      }
    }
    if (info.timelineTop === null) {
      problems.push('找不到时间轴回放的轨道（.mtl__track）')
    } else {
      if (!(info.timelineTop > info.gridTop)) {
        problems.push('时间轴回放不在四张图谱卡片下面：卡片 top ' + info.gridTop + '，时间轴 top ' + info.timelineTop)
      }
      if (info.timelineTrackWidth < 200) {
        problems.push('时间轴轨道太窄，几何算不出来：' + info.timelineTrackWidth)
      }
      if (info.timelineTicks <= 0) {
        problems.push('时间轴一个刻度都没有（几何没跑起来）：' + JSON.stringify(info))
      }
      /*
       * 「0 段录像」与「轨道坏了」必须能分开：这台设备本机确实没有录像，所以段数应当是 0，
       * 但**必须**有那句说明（`.mtl__state`）。只有 0 段而没有任何说明，看起来就是坏的。
       */
      if (info.timelineSegments === 0 && !info.timelineEmptyShown) {
        problems.push('时间轴上没有录像段，也没有说明为什么（空态没画出来）')
      }
      if (info.timelineLocalOnly !== 1) {
        problems.push('时间轴回放没有写清"只回放本机文件"：' + info.timelineLocalOnly)
      }
      log('monitor chrome/③b: 趋势 top ' + info.trendTop + '，四张卡片 top ' + info.gridTop +
        '，时间轴 top ' + info.timelineTop + '，段 ' + info.timelineSegments +
        '，刻度 ' + info.timelineTicks + '，空态 ' + info.timelineEmptyShown)
    }
  }
  // ⑧：五张图谱＝相机五路，排成一排。声纹设备那一支没有这五张，所以只在相机上量（下面那段）。

  /**
   * 相机那一支的排布：相机控制与告警**并排**（⑦），而且直播画面在（⑤ 的 16:9 之后会在这里量）。
   *
   * 为什么必须把设备切到相机再量：上面那次 /monitor 打开时选中的是声纹设备，相机那几块
   * 一块都不渲染（`v-if="isCamera"`）—— "没渲染"与"排错了"在只看 problems 的探针里长得一样。
   */
  /*
   * 再显式恢复一次窗口，并**读回**它到底是多少。
   *
   * 为什么值得单独写一段：2026-09-17 第 8 批的一次运行里，这一条之后的所有读数都在
   * **2048 宽**的窗口下取的（前面那一次 `setContentSize(1440,900)` 没有生效），
   * 于是相机那几条断言在另一个尺寸下报失败 —— 而失败信息看起来像"相机的图谱没渲染"。
   * 尺寸是探针的**前提**，前提不成立时应当先说出来，而不是让后面的断言去背这个锅。
   */
  win.setContentSize(1440, 900)
  await sleep(700)
  {
    const actual = win.getContentSize()
    log('window size   : 请求 1440x900，实际 ' + actual[0] + 'x' + actual[1])
    if (Math.abs(actual[0] - 1440) > 40 || Math.abs(actual[1] - 900) > 40) {
      problems.push(
        '探针窗口没有恢复到 1440x900（实际 ' + actual[0] + 'x' + actual[1] +
          '）—— 后面的几何断言都在别的尺寸下取数'
      )
    }
  }

  const monitorCamera = await layout('/monitor', '(() => {' +
    'const select = document.querySelector("#topbar-page-slot select");' +
    'if (!select) return JSON.stringify({ switched: false, reason: "no-select" });' +
    'const option = [...select.options].find((o) => /Camera|相机|cámara|kamera/i.test(o.textContent));' +
    'if (!option) return JSON.stringify({ switched: false, reason: "no-camera", options: [...select.options].map((o) => o.textContent.trim()) });' +
    'select.value = option.value;' +
    'select.dispatchEvent(new Event("change", { bubbles: true }));' +
    'return new Promise((resolve) => setTimeout(() => {' +
    '  const alarm = document.querySelector(".camera-alarm-entry");' +
    '  const control = document.querySelector(".cctl");' +
    '  const live = document.querySelector(".camera-live");' +
    '  const sameRow = !!(alarm && control)' +
    '    && Math.abs(alarm.getBoundingClientRect().top - control.getBoundingClientRect().top) < 24;' +
    '  const liveBox = live ? live.getBoundingClientRect() : null;' +
    /*
     * ⑤ 右键菜单：先真的按一次右键（派发 `contextmenu`），再等一次渲染。
     *
     * **必须等**：Vue 的模板更新是异步的，派发之后立刻读 DOM 拿到的一定是"菜单没开"
     * （第一版就是这样，报了一个假失败）。所以这里先把事件发出去，200 ms 之后再量。
     */
    '  const stage = document.querySelector(".camera-live__stage");' +
    '  if (stage) stage.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true,' +
    '    cancelable: true, clientX: 120, clientY: 120 }));' +
    '  setTimeout(function(){' +
    '  const menus = [...document.querySelectorAll("[role=menu]")];' +
    '  const top = menus.length > 0 ? menus[0] : null;' +
    '  const menuItems = top ? [...top.querySelectorAll(":scope > [role=menuitem]")] : [];' +
    '  const menu = {' +
    '    opened: menus.length > 0,' +
    '    count: menuItems.length,' +
    '    disabled: menuItems.filter((item) => item.getAttribute("aria-disabled") === "true" ||' +
    '      item.classList.contains("vmenu__item--disabled")).length,' +
    '    hasSubmenu: menuItems.some((item) => item.getAttribute("aria-haspopup") === "menu"),' +
    '    labels: menuItems.map((item) => (item.textContent || "").trim().slice(0, 24)) };' +
    /*
     * 量完就把菜单关掉：它是个 Teleport 到 body 的浮层，留着的话这张 /monitor 的截图
     * 会永远带着一个打开的右键菜单（下一个人会以为页面自己弹出了菜单）。
     * `mousedown` 在 document 上（菜单的关闭条件就是"点别处"）。
     */
    '  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));' +
    '  resolve(JSON.stringify({' +
    '    switched: true,' +
    '    hasLive: !!live,' +
    '    hasAlarmEntry: !!alarm,' +
    '    hasControl: !!control,' +
    '    sameRow,' +
    /*
     * 诊断用（2026-09-17 第 8 批发现在别的窗口尺寸下这一条会失败）：设备数、空态、
     * 以及**这一屏看到的是哪一台**。`graphCount 0` 与 `stageBox null` 同时出现时，
     * "相机那几块没渲染"与"这一页根本不在相机上（设备列表空了 / 选中的是别的设备）"
     * 长得一模一样 —— 这三个读数把它们分开。
     */
    '    deviceCount: (function(){ const el = document.querySelector(".topbar .indicator__value");' +
    '      return el ? Number((el.textContent || "").trim()) : -1; })(),' +
    /*
     * ⚠ `.empty` 而不是 `.empty-state`：`EmptyState.vue` 的根元素是 `<div class="empty">`。
     * 这一处（以及趋势页那一段的 `historyEmpty`）以前写的选择器从来没匹配上过，
     * 读数一直是假的 0/false（第 25 轮改正）。
     */
    '    emptyState: document.querySelectorAll(".page .empty").length,' +
    '    selectedOption: (function(){ const s = document.querySelector("#topbar-page-slot select");' +
    '      return s && s.selectedOptions[0] ? (s.selectedOptions[0].textContent || "").trim() : null; })(),' +
    /*
     * 第 24 条（2026-09-18）：**声纹图与频谱图 16:9 各占 50%**，并排一行。
     *
     * 量四件事，每一件都能"源码里写对了但屏幕上是另一个样子"：
     *   graphCount    这一块一共几张图（第 24 条之后仍然是 5 张，只是分成 2 + 1 + 2 排）；
     *   pairCount     第一行（声纹 + 频谱）里有几块 —— 必须是 **2**；
     *   pairWidths    两块的宽度 —— 必须几乎相等（"各占 50%"的可测定义）；
     *   pairRatios    两块那一层（`.acam__stage--ratio`）的宽高比 —— 必须都是 16:9。
     */
    '    graphCount: document.querySelectorAll(".acam__panel").length,' +
    '    pairCount: document.querySelectorAll(".acam__pair")[0]' +
    '      ? document.querySelectorAll(".acam__pair")[0].querySelectorAll(":scope > .acam__panel").length : -1,' +
    '    pairWidths: (function(){ const p = document.querySelector(".acam__pair");' +
    '      if (!p) return [];' +
    '      return [...p.querySelectorAll(":scope > .acam__panel")]' +
    '        .map((n) => Math.round(n.getBoundingClientRect().width)); })(),' +
    '    pairRatios: [...document.querySelectorAll(".acam__pair .acam__stage--ratio")]' +
    '      .map((n) => { const r = n.getBoundingClientRect();' +
    '        return r.height > 0 ? Math.round((r.width / r.height) * 1000) / 1000 : 0; }),' +
    /*
     * 第 23 条：那个「相机声学数据」窗口必须真的不在，而且**状态仍然看得见**。
     * `statusText` 是那一行状态上的字：空面板与安静的房间在屏幕上长得一样，
     * 所以这一页靠它区分"没起来"与"没有数据"。
     */
    '    acousticWindowPresent: !!document.querySelector(".acam__head"),' +
    '    legacyStartButton: [...document.querySelectorAll(".acam button")]' +
    '      .filter((b) => /开始接收|Start receiving|Iniciar recepción|Almayı başlat/.test((b.textContent || ""))).length,' +
    '    statusText: (function(){ const el = document.querySelector("[data-acam-state]");' +
    '      return el ? (el.textContent || "").trim() : null; })(),' +
    '    stopButtonPresent: !!document.querySelector("[data-action=acam-stop]"),' +
    '    panelWidth: (function(){ const p = document.querySelector(".acam");' +
    '      return p ? Math.round(p.getBoundingClientRect().width) : -1; })(),' +
    '    pairOverflow: (function(){ const p = document.querySelector(".acam__pair");' +
    '      return p ? p.scrollWidth - p.clientWidth : -1; })(),' +
    /*
     * 能量点那张五列表：它是这一块里唯一"内容有最小宽度"的东西。
     * 没有实时能量点时表不渲染（设备离线），那时这里是 null —— 探针不许把 null 当成"通过"，
     * 所以下面只比 null 以外的值，并在报告里写明"没有表可量"。
     */
    '    tableOverflow: (function(){ const t = document.querySelector(".acam__table");' +
    '      if (!t) return null; return t.scrollWidth - t.clientWidth; })(),' +
    '    viewportWidth: window.innerWidth,' +
    /*
     * 第 22 条：**视频窗口下方的通用播放器式控制条**，以及"页面里不再有播放信息"。
     *
     * 位置上量两件事：控制条的**顶边在画面底边之下**（"下方"的可测定义），以及
     * 六个动作真的在同一个控制条里。原生 `controls` 只能从源码看，这里量的是
     * "页面上有几条控制条"的等价物：`<video>` 自己有没有 `controls` 属性。
     */
    '    controlBar: (function(){ const b = document.querySelector("[data-camera-controlbar]");' +
    '      return b ? { top: Math.round(b.getBoundingClientRect().top),' +
    '        actions: [...b.querySelectorAll("[data-action]")].map((n) => n.getAttribute("data-action")) } : null; })(),' +
    '    stageBottom: (function(){ const s = document.querySelector(".camera-live__stage");' +
    '      return s ? Math.round(s.getBoundingClientRect().bottom) : null; })(),' +
    '    videoHasNativeControls: (function(){ const v = document.querySelector(".camera-live__video");' +
    '      return v ? v.hasAttribute("controls") : null; })(),' +
    '    playbackInfoOnPage: [...document.querySelectorAll(".camera-live .kv__label")]' +
    '      .filter((n) => /播放信息|Playback info|Información de reproducción|Oynatma bilgisi/.test(n.textContent || "")).length,' +
    '    volumeSlider: (function(){ const el = document.querySelector("[data-action=camera-volume]");' +
    '      return el ? { value: Number(el.value), disabled: !!el.disabled } : null; })(),' +
    /*
     * 第 24 条：这一页要支持 **检测模式 / 告警配置 / 告警信息 / 历史告警展示**。
     *   · 检测模式 = 控制面板的「模式」那一段；
     *   · 告警配置 = 那张卡片的按钮（对话框）；
     *   · 告警信息 = 就地列出来的最近几条（`[data-camera-alarms]`）；
     *   · 历史告警 = 「查看告警记录」那个链接，**必须带 `?device=`**。
     */
    '    detectModeSection: !!document.querySelector("[data-camera-panel=mode]"),' +
    '    alarmListPresent: !!document.querySelector("[data-camera-alarms]"),' +
    '    alarmListEmpty: !!document.querySelector("[data-camera-alarms-empty]"),' +
    '    alarmItems: document.querySelectorAll("[data-camera-alarm-id]").length,' +
    '    alarmHistoryHref: (function(){ const a = document.querySelector("[data-link=camera-alarm-history]");' +
    '      return a ? a.getAttribute("href") : null; })(),' +
    /*
     * ⑤ 16:9 视频窗口：量的是**窗口本身**的宽高比，不是视频源的比例。
     * 判据用 16/9 = 1.7778，允许 ±0.05（边框、圆角与 devicePixelRatio 的取整）。
     */
    '    stageBox: (function(){ const s = document.querySelector(".camera-live__stage");' +
    '      if (!s) return null; const r = s.getBoundingClientRect();' +
    '      return { w: Math.round(r.width), h: Math.round(r.height),' +
    '        ratio: r.height > 0 ? Math.round((r.width / r.height) * 1000) / 1000 : 0 }; })(),' +
    /*
     * ⑤ 右键菜单的测量结果（见上面那段：事件已派发、渲染已等过）。
     */
    '    menu: menu,' +
    '    liveWidth: liveBox ? Math.round(liveBox.width) : -1' +
    '  }));' +
    '  }, 200);' +
    '}, 900));})()')
  log('monitor camera: ' + JSON.stringify(monitorCamera))
  if (!monitorCamera.switched) {
    problems.push('探针切不到相机设备：' + JSON.stringify(monitorCamera))
  } else {
    if (!monitorCamera.hasLive) problems.push('相机那一支没有直播画面（.camera-live）')
    if (!monitorCamera.hasControl) problems.push('相机那一支没有相机控制面板（.cctl）')
    if (!monitorCamera.hasAlarmEntry) problems.push('相机那一支没有告警卡片（.camera-alarm-entry）')
    if (monitorCamera.hasControl && monitorCamera.hasAlarmEntry && !monitorCamera.sameRow) {
      problems.push('相机控制与告警没有并排（不在同一行）')
    }
    // 第 24 条：这一块仍然是**五张**图（只是分成 2 + 1 + 2 排，不是一排五张）。
    if (monitorCamera.graphCount !== 5) {
      problems.push('相机那一支的图谱不是五张：' + monitorCamera.graphCount)
    }
    /*
     * 第 24 条：**声纹图与频谱图 16:9 各占 50%**（并排一行）。
     *
     * 四件事都是**无条件**断言：量不到（-1 / 空数组）也报问题 ——
     * "控件没渲染"与"排错了"在只读 problems 的报告里长得一样（§15.13.5）。
     */
    if (monitorCamera.pairCount !== 2) {
      problems.push('声纹图 + 频谱图那一行不是 2 块：' + monitorCamera.pairCount)
    }
    {
      const widths = monitorCamera.pairWidths || []
      if (widths.length !== 2) {
        problems.push('量不到声纹图 / 频谱图的宽度：' + JSON.stringify(widths))
      } else {
        const [left, right] = widths
        // "各占 50%"：两块宽度之差不超过 2px（子像素取整）。
        if (Math.abs(left - right) > 2) {
          problems.push('声纹图与频谱图不是各占 50%：' + JSON.stringify(widths))
        }
      }
    }
    {
      const ratios = monitorCamera.pairRatios || []
      if (ratios.length !== 2) {
        problems.push('声纹图 / 频谱图那一层 16:9 的盒子不是 2 个：' + JSON.stringify(ratios))
      }
      for (const ratio of ratios) {
        if (Math.abs(ratio - 16 / 9) > 0.05) {
          problems.push('声纹图 / 频谱图那一层不是 16:9：' + ratio + '（应为 ' + (16 / 9).toFixed(4) + '）')
        }
      }
    }
    /*
     * 第 23 条：那个「相机声学数据」窗口**必须真的不在**（连「开始接收」按钮一起），
     * 而**状态仍然要说出来** —— 删窗口不等于可以不说"流没起来"。
     */
    if (monitorCamera.acousticWindowPresent) {
      problems.push('「相机声学数据」那个窗口还在（.acam__head）')
    }
    if (monitorCamera.legacyStartButton > 0) {
      problems.push('还有「开始接收」按钮：第 23 条要求数据默认实时接收')
    }
    if (!monitorCamera.statusText) {
      problems.push('相机声学那一块没有状态行（[data-acam-state]）—— 空面板与安静的房间就分不出来了')
    }
    /*
     * "占满整幅宽"：面板自己要占满（它是 `camera-board__wide`），而且并排那两列不许横向溢出。
     */
    if (monitorCamera.panelWidth <= 0) {
      problems.push('量不到相机声学面板的宽度：' + JSON.stringify(monitorCamera))
    }
    if (monitorCamera.pairOverflow === null || monitorCamera.pairOverflow > 1) {
      problems.push('声纹图 / 频谱图那一行横向溢出：' + monitorCamera.pairOverflow +
        '（窗口 ' + monitorCamera.viewportWidth + 'px）')
    }
    /*
     * 第 22 条：控制条在**画面下方**，六个动作都在里面，原生 controls 关掉，
     * 页面上不再有那块「播放信息」。
     */
    if (!monitorCamera.controlBar) {
      problems.push('找不到相机播放器式控制条（[data-camera-controlbar]）')
    } else {
      const bar = monitorCamera.controlBar
      if (monitorCamera.stageBottom === null || bar.top < monitorCamera.stageBottom) {
        problems.push(
          '控制条不在画面下方：控制条 top=' + bar.top + '，画面 bottom=' + monitorCamera.stageBottom
        )
      }
      const wanted = [
        'camera-pause',
        'camera-power',
        'camera-record',
        'camera-snapshot',
        'camera-playback',
        'camera-alarm-config',
        'camera-volume',
        'camera-flip-horizontal',
        'camera-flip-vertical',
        'camera-flip-quarter'
      ]
      const missing = wanted.filter((action) => !bar.actions.includes(action))
      if (missing.length > 0) {
        problems.push('控制条里缺少这些控件：' + JSON.stringify(missing) +
          '（实际 ' + JSON.stringify(bar.actions) + '）')
      }
    }
    if (monitorCamera.videoHasNativeControls === true) {
      problems.push('`<video>` 打开了原生 controls：页面上会有两条功能不一样的控制条')
    }
    if (monitorCamera.playbackInfoOnPage > 0) {
      problems.push('页面上还有「播放信息」那一行（第 22 条要求删掉）')
    }
    if (!monitorCamera.volumeSlider) {
      problems.push('控制条里没有音量滑杆')
    }
    /*
     * 第 24 条：检测模式 / 告警信息 / 历史告警链接。
     */
    if (monitorCamera.detectModeSection !== true) {
      problems.push('相机页没有「检测模式」（控制面板里没有 [data-camera-panel=mode]）')
    }
    if (monitorCamera.alarmListPresent !== true) {
      problems.push('相机页没有告警信息那一块（[data-camera-alarms]）')
    } else if (monitorCamera.alarmItems === 0 && monitorCamera.alarmListEmpty !== true) {
      // 「一条都没有」与「没渲染」必须分得开：前者应当有那句空态。
      problems.push('告警信息既没有条目、也没有空态 —— 分不出"没有告警"与"没渲染"')
    }
    if (!String(monitorCamera.alarmHistoryHref || '').includes('device=')) {
      problems.push(
        '「查看告警记录」没有带上这一台设备：' + JSON.stringify(monitorCamera.alarmHistoryHref)
      )
    }
    // 那条链接的**后半段**：告警记录页的设备筛选要真的预置成这一台。
    if (monitorCamera.alarmHistoryHref) {
      const deviceId = String(monitorCamera.alarmHistoryHref).split('device=').pop() ?? ''
      /*
       * 单独走一趟（不能在相机那段里顺手做：那段脚本是**非 async** 的 IIFE，
       * 里面写 `await` 会抛 `Uncaught ReferenceError: await is not defined` ——
       * 实测踩过，报告里当时是 3 条问题，其中 2 条是那次异常的连带）。
       */
      const history = await layout('/alarms?device=' + encodeURIComponent(deviceId), '(() => {' +
        'const sel = document.querySelector(".page select");' +
        'return JSON.stringify({' +
        '  value: sel ? sel.value : null,' +
        '  options: sel ? sel.options.length : -1' +
        '});})()')
      if (history.probeTimeout === true) {
        problems.push('量告警记录页的预置筛选时超时')
      } else if (history.value !== deviceId) {
        problems.push(
          '点了「查看告警记录」之后，告警记录页的设备筛选不是这一台：' +
          JSON.stringify(history) + '（应为 ' + deviceId + '）'
        )
      } else {
        log('camera alarms : 告警记录页的预置筛选 = ' + JSON.stringify(history))
      }
    } else {
      problems.push('相机页没有「查看告警记录」那条链接')
    }
    /*
     * ⑤ 16:9 视频窗口：窗口本身的宽高比必须是 16:9（1.7778 ± 0.05）。
     * 这条是**无条件**的：量不到舞台（null）也报问题 —— "控件没渲染"与"比例对了"
     * 在只读 problems 的报告里长得一样（§15.13.5）。
     */
    if (!monitorCamera.stageBox) {
      problems.push('量不到相机直播舞台（.camera-live__stage）')
    } else {
      const ratio = monitorCamera.stageBox.ratio
      if (Math.abs(ratio - 16 / 9) > 0.05) {
        problems.push(
          '相机视频窗口不是 16:9：实测 ' + ratio + '（' + monitorCamera.stageBox.w + '×' +
            monitorCamera.stageBox.h + '）'
        )
      }
    }
    /*
     * ⑤ 右键菜单：这一页按一次右键必须弹出菜单，且项数与模型给出的**一致**
     * （正在播放的相机 + 本页声明的四项能力 ⇒ 8 项：抓图/录像、全屏、复制地址、
     * 外部播放器、叠加信息、本机回放、下载检测记录、告警配置）。
     *
     * 为什么把 8 写在这里而不是"至少 1 项"：少一项就是少一个功能，而 8 这个数字里
     * 每一项都有对应的断言（下面的 labels 也会打出来给人看）。
     */
    const EXPECTED_MENU_ITEMS = 8
    if (!monitorCamera.menu || !monitorCamera.menu.opened) {
      problems.push('实时监测页按右键没有弹出菜单：' + JSON.stringify(monitorCamera.menu))
    } else {
      if (monitorCamera.menu.count !== EXPECTED_MENU_ITEMS) {
        problems.push(
          '右键菜单项数不是 ' + EXPECTED_MENU_ITEMS + '：' + monitorCamera.menu.count +
            '（' + JSON.stringify(monitorCamera.menu.labels) + '）'
        )
      }
      if (!monitorCamera.menu.hasSubmenu) {
        problems.push('右键菜单里没有「抓图 / 录像」二级菜单')
      }
    }
    log('monitor camera/⑤: 舞台 ' + JSON.stringify(monitorCamera.stageBox) +
      '，菜单 ' + JSON.stringify(monitorCamera.menu))
    /*
     * 能量点表格：有数据时才量得到。量到就要求它不溢出；量不到（离线设备没有实时能量点）
     * 就在报告里说出来 —— "没有表可量"不等于"表没溢出"。
     */
    if (monitorCamera.tableOverflow !== null && monitorCamera.tableOverflow > 1) {
      problems.push('能量点表格溢出了卡片：' + monitorCamera.tableOverflow + 'px')
    } else if (monitorCamera.tableOverflow === null) {
      log('monitor camera: 没有量到能量点表格（这台相机离线，没有实时能量点）——' +
        ' 表格在 ' + JSON.stringify(monitorCamera.pairWidths) + ' 宽的卡里的表现未验证')
    }
  }

  /**
   * ⑨ 相机配置搬家：设备详情页对相机只给相机页签，且「检测模式/告警策略/维护与升级」
   * 在**设备管理里**。
   *
   * 用**直接路由**（`/devices/<id>`）而不是点设备树：树里的节点要先展开、选择器又依赖结构，
   * 而设备 id 是 IPC 给的确定值 —— 探针不该因为"点不到"而跳过一条能测的断言
   * （第一版就是那样，报了 skipped，等于没测）。
   */
  const cameraList = await execJson(win, 'cameraList', listDevicesScript())
  const cameraDevice = cameraList.ok
    ? (cameraList.devices || []).find((device) => device.kind === 'acousticCamera')
    : undefined
  if (cameraDevice) {
    const tabs = await layout('/devices/' + cameraDevice.id, '(() => {' +
      'const labels = [...document.querySelectorAll(".tab, [role=\\"tab\\"]")]' +
      '  .map((n) => n.textContent.trim());' +
      'return JSON.stringify({ tabs: labels });})()')
    log('camera tabs   : ' + JSON.stringify(tabs))
    for (const label of ['检测模式', '告警策略', '维护与升级']) {
      if (!tabs.tabs.some((text) => text.includes(label))) {
        problems.push('相机详情页没有「' + label + '」页签：' + JSON.stringify(tabs.tabs))
      }
    }
    for (const gone of ['通道与采样率', 'RS485 / Modbus', 'Push 上报']) {
      if (tabs.tabs.some((text) => text.includes(gone))) {
        problems.push('相机详情页仍然有 FA8 的「' + gone + '」页签：' + JSON.stringify(tabs.tabs))
      }
    }
  } else {
    problems.push('一次性 profile 里找不到相机设备，无法验证相机页签：' + JSON.stringify(cameraList))
  }

  /**
   * 事件中心（业主 2026-09-17 规格 Phase 3）：KPI 条 / 筛选面板 / 告警队列 / 抽屉 / Esc。
   *
   * 这一条是**只读**的（点一行、点 KPI 都只读库与设备），所以排在下面那些写操作之前。
   *
   * 有几个断言只有在**队列真的有行**时才成立（行高、点开抽屉、Esc）。没有行时不报"问题"
   * 也不假装通过：日志里明确写「没有验证」——操作员库里某个时段没有事件是正常状态，
   * 把它报成失败会训练出"报告里的红灯不用看"的习惯。
   */
  const eventsCenter = await layout('/events', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    /*
     * 先记下"这一页到底挂上了没有"。
     *
     * 为什么（2026-09-18 实测）：有一次运行里事件中心这一段全是空的（KPI 条、搜索框、
     * 队列一个都没有），而**日志里没有任何报错** —— 事后完全分不清是"页面没挂载"、
     * "挂在登录页上"还是"路由被重定向了"。这几个字段就是为那一刻准备的：
     * hash / 外壳在不在 / 登录框在不在 / 正文开头。
     */
    'const diag = {' +
    '  hashAtStart: location.hash,' +
    '  hasShell: !!document.querySelector(".sidebar, .app-shell, .app-content"),' +
    '  hasLogin: !!document.querySelector("input[type=password]"),' +
    '  bodyHead: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 120)' +
    '};' +
    // 首屏要等一次全量查询（相机 HTTP + 声纹 SQLite + 联动内存），所以等的是 KPI 条出现。
    'for (let i = 0; i < 60 && !document.querySelector(".kpi-strip"); i += 1) await sleep(500);' +
    'diag.hashAfterWait = location.hash;' +
    'diag.hasKpi = !!document.querySelector(".kpi-strip");' +
    'diag.shellAfterWait = !!document.querySelector(".sidebar, .app-shell, .app-content");' +
    'diag.loginAfterWait = !!document.querySelector("input[type=password]");' +
    'diag.bodyAfterWait = (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 200);' +
    /*
     * 每一步都往 `window` 上留一个进度标记。
     *
     * 为什么（2026-09-17 实测）：这一段探针**挂住过一次**（180 秒没有返回，而主进程日志
     * 一直在动），超时后除了"超时"什么都看不出来 —— 是页面结构没渲染、还是点 KPI 之后
     * 卡住，无从判断。有了这个标记，超时时能直接报"卡在哪一步"。
     */
    'window.__eventsProbeStep = "structure";' +
    'const tiles = [...document.querySelectorAll(".kpi-strip__tile")];' +
    'const tileLabels = tiles.map((t) => text(t.querySelector(".metric__label")));' +
    'const tileValues = tiles.map((t) => text(t.querySelector(".metric__value")));' +
    'const scope = text(document.querySelector(".kpi-strip__scope"));' +
    'const searchBox = document.querySelector(".event-filters__search input");' +
    'const panel = document.querySelector(".filter-panel");' +
    'const panelWidth = panel ? Math.round(panel.getBoundingClientRect().width) : 0;' +
    'const groups = [...document.querySelectorAll(".filter-panel__group .field-label")].map(text);' +
    'const optionCount = document.querySelectorAll(".filter-panel__option").length;' +
    'const panelScope = text(document.querySelector(".filter-panel__scope"));' +
    'const viewsRow = [...document.querySelectorAll(".filter-bar--views .btn-row")][0];' +
    'const savedLabels = viewsRow ? [...viewsRow.querySelectorAll("button")].map(text) : [];' +
    'const modeButtons = [...document.querySelectorAll("[data-view-mode]")];' +
    'const modeLabels = modeButtons.map(text);' +
    'const oldTable = document.querySelector("table.table");' +
    'const summary = text(document.querySelector(".pager .muted"));' +
    'window.__eventsProbeStep = "modes";' +
    'const heights = {};' +
    'const setMode = async (mode) => {' +
    '  const button = document.querySelector(`[data-view-mode="${mode}"]`);' +
    '  if (button) button.click();' +
    '  await sleep(400);' +
    '  const rows = [...document.querySelectorAll(".alert-row")];' +
    '  heights[mode] = rows.length' +
    '    ? getComputedStyle(rows[0]).getPropertyValue("--event-row-mode-height").trim()' +
    '    : null;' +
    '  return rows.length;' +
    '};' +
    'const rowCounts = {};' +
    'rowCounts.compact = await setMode("compact");' +
    'rowCounts.standard = await setMode("standard");' +
    'rowCounts.evidence = await setMode("evidence");' +
    'let drawerOpened = false;' +
    'let drawerClosedByEsc = false;' +
    'window.__eventsProbeStep = "drawer";' +
    /*
     * 详情抽屉（规格 §11）。这一段量的都是"结构真的在、并且真的按规格长"：
     * 默认宽度 400、抓手带 400–560、页签只有已实现的两个、Overview 是 2 列属性网格、
     * 切到 Evidence 能切过去、键盘能改宽度**并且写回 localStorage**（写操作读回验证）。
     */
    'const drawerInfo = {};' +
    'const panelVisible = (name) => {' +
    '  const node = document.querySelector(`.drawer [data-panel="${name}"]`);' +
    '  return !!node && getComputedStyle(node).display !== "none";' +
    '};' +
    'const firstRow = document.querySelector(".alert-row");' +
    'if (firstRow) {' +
    '  window.__eventsProbeStep = "drawer-open";' +
    '  firstRow.click();' +
    '  await sleep(700);' +
    '  const drawerEl = document.querySelector(".drawer");' +
    '  drawerOpened = !!drawerEl;' +
    '  if (drawerEl) {' +
    '    drawerInfo.width = Math.round(drawerEl.getBoundingClientRect().width);' +
    '    const handle = drawerEl.querySelector("[data-action=drawer-resize]");' +
    '    drawerInfo.hasHandle = !!handle;' +
    '    drawerInfo.min = handle ? handle.getAttribute("aria-valuemin") : null;' +
    '    drawerInfo.max = handle ? handle.getAttribute("aria-valuemax") : null;' +
    '    drawerInfo.tabs = [...drawerEl.querySelectorAll("[data-tab]")].map(text);' +
    '    drawerInfo.gridFields = drawerEl.querySelectorAll(".drawer__grid .drawer__field").length;' +
    '    drawerInfo.wideFields = drawerEl.querySelectorAll(".drawer__field--wide").length;' +
    '    drawerInfo.overviewVisible = panelVisible("overview");' +
    '    drawerInfo.evidenceVisible = panelVisible("evidence");' +
    '    drawerInfo.focusInside = drawerEl.contains(document.activeElement);' +
    '    const evidenceTab = drawerEl.querySelector("[data-tab=evidence]");' +
    '    window.__eventsProbeStep = "drawer-evidence";' +
    '    if (evidenceTab) { evidenceTab.click(); await sleep(1200); }' +
    '    drawerInfo.afterTabOverview = panelVisible("overview");' +
    '    drawerInfo.afterTabEvidence = panelVisible("evidence");' +
    '    drawerInfo.evidenceImages = document.querySelectorAll("[data-action=evidence-image]").length;' +
    '    drawerInfo.evidenceNote = text(document.querySelector(".drawer [data-panel=evidence] .muted"));' +
    /*
     * Phase 5 的三个页签（Timeline / Related / Activity）与处置动作按钮。
     * 这一段**只读**：只看"控件在不在、切得过去切不回来"，点击动作在最后那一条写探针里做。
     */
    '    const relatedTab = drawerEl.querySelector("[data-tab=related]");' +
    '    window.__eventsProbeStep = "drawer-related";' +
    '    if (relatedTab) { relatedTab.click(); await sleep(500); }' +
    '    drawerInfo.afterTabRelated = panelVisible("related");' +
    '    drawerInfo.relatedGroups = document.querySelectorAll(".drawer [data-panel=related] .related__group").length;' +
    '    drawerInfo.relatedScope = text(document.querySelector(".drawer [data-panel=related] .related__scope"));' +
    '    const activityTab = drawerEl.querySelector("[data-tab=activity]");' +
    '    window.__eventsProbeStep = "drawer-activity";' +
    '    if (activityTab) { activityTab.click(); await sleep(500); }' +
    '    drawerInfo.afterTabActivity = panelVisible("activity");' +
    '    const timelineTab = drawerEl.querySelector("[data-tab=timeline]");' +
    '    window.__eventsProbeStep = "drawer-timeline";' +
    '    if (timelineTab) { timelineTab.click(); await sleep(500); }' +
    '    drawerInfo.afterTabTimeline = panelVisible("timeline");' +
    '    drawerInfo.timelineNodes = document.querySelectorAll(".drawer [data-panel=timeline] .timeline__node").length;' +
    '    drawerInfo.statusActions = [...drawerEl.querySelectorAll("[data-status-action]")].map(' +
    '      (b) => b.getAttribute("data-status-action"));' +
    '    drawerInfo.primaryAction = (drawerEl.querySelector("[data-action=status-primary]") || {}).dataset' +
    '      ? drawerEl.querySelector("[data-action=status-primary]").getAttribute("data-status-action")' +
    '      : null;' +
    // 键盘改宽度：焦点在抓手上按 ←，宽度 +16 且**写回 localStorage**。
    '    if (handle) {' +
    '      window.__eventsProbeStep = "drawer-resize";' +
    '      handle.focus();' +
    '      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));' +
    '      await sleep(300);' +
    '    }' +
    '    drawerInfo.widthAfterKey = Math.round(drawerEl.getBoundingClientRect().width);' +
    '    try {' +
    '      drawerInfo.storedWidth = window.localStorage.getItem("hertzinno.eventCenter.drawerWidth");' +
    '    } catch (error) { drawerInfo.storedWidth = "READ_FAILED"; }' +
    '  }' +
    '  window.__eventsProbeStep = "drawer-close";' +
    '  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));' +
    '  await sleep(400);' +
    '  drawerClosedByEsc = !document.querySelector(".drawer");' +
    '}' +
    /*
     * 重复触发聚合（规格 §14.1）：聚合窗口的下拉在不在、切到「不聚合」之后行数会不会变多。
     *
     * 判据故意做成"不聚合的行数 ≥ 聚合的行数"，并且**只在真的出现了 ×N 时才要求严格大于**：
     * 操作员库里的告警如果本来就间隔很久，聚合前后行数一样是正常的，那不该报成缺陷。
     */
    'window.__eventsProbeStep = "aggregation";' +
    'const agg = {};' +
    'const rowsGrouped = document.querySelectorAll(".alert-row").length;' +
    'agg.rowsGrouped = rowsGrouped;' +
    'agg.countChips = document.querySelectorAll(".alert-row__count").length;' +
    'const groupSelect = document.querySelector(".page [data-field=group-window]");' +
    'agg.hasSelect = !!groupSelect;' +
    'agg.options = groupSelect ? [...groupSelect.options].map((option) => option.value) : [];' +
    'if (groupSelect) {' +
    '  groupSelect.value = "off";' +
    '  groupSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '}' +
    'for (let i = 0; i < 60 && document.querySelectorAll(".alert-row").length <= rowsGrouped; i += 1) await sleep(500);' +
    'agg.rowsUngrouped = document.querySelectorAll(".alert-row").length;' +
    // 恢复成默认那一档：只读探针要还原现场（后面还有别的断言在看这一页）。
    'if (groupSelect) {' +
    '  groupSelect.value = "10m";' +
    '  groupSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '}' +
    'for (let i = 0; i < 60 && document.querySelectorAll(".alert-row").length !== rowsGrouped; i += 1) await sleep(500);' +
    'agg.rowsRestored = document.querySelectorAll(".alert-row").length;' +
    // KPI → 筛选：点「严重」那一格（这一条查询只读声纹 SQLite，不会去连相机）。
    'window.__eventsProbeStep = "kpi";' +
    'const criticalTile = tiles[0];' +
    'if (criticalTile && criticalTile.tagName === "BUTTON") criticalTile.click();' +
    'await sleep(2000);' +
    'const hashAfterKpi = location.hash;' +
    // 用**同一批**格子里的那一个（`tiles`），而不是重新查一次 DOM：重查拿到 undefined 时
    // `.getAttribute` 会同步抛，而同步抛在 `executeJavaScript` 里就是"探针挂住"。
    'const pressedAfterKpi = tiles[0] ? tiles[0].getAttribute("aria-pressed") : "NO_TILE";' +
    'const activeOptions = [...document.querySelectorAll(".filter-panel__option--active")].map(text);' +
    /*
     * 记忆的**读回**：界面往 localStorage 写了一份筛选，就从 localStorage 把它读回来 ——
     * "写了"与"写对了"是两件事（工程规则：每个写操作写完要读回验证）。
     * **必须在清筛选之前读**：清完之后读回来的是清空后的那一份（下面单独断言它）。
     */
    'let storedFilter = null;' +
    'try { storedFilter = window.localStorage.getItem("hertzinno.eventCenter.filters"); } catch (error) { storedFilter = "READ_FAILED"; }' +
    /*
     * 把它自己弄出来的筛选**清掉**。
     *
     * 为什么（2026-09-18 实测）：这一段为了验证"点 KPI 就是加筛选"把严重度点成了 critical，
     * 于是那条**写探针**（排在所有只读探针之后）进到 `/events` 时队列是空的，报了一个
     * `no-rows` 的假失败 —— 而真相是"上一条探针留下了筛选"。只读探针就该把现场还原。
     *
     * 清筛选会触发一次**全量查询**（含相机 HTTP），所以要**等行出现**而不是等一个固定秒数：
     * 第一版等 2 秒，结果队列还是空的，报告里又多一条假失败。
     */
    'let cleared = false;' +
    'const clearButton = [...document.querySelectorAll(".page button")]' +
    '  .find((b) => text(b) === "清除全部");' +
    'if (clearButton) { clearButton.click(); cleared = true; }' +
    'for (let i = 0; i < 60 && document.querySelectorAll(".alert-row").length === 0; i += 1) await sleep(500);' +
    'const rowsAfterClear = document.querySelectorAll(".alert-row").length;' +
    'let storedFilterAfterClear = null;' +
    'try { storedFilterAfterClear = window.localStorage.getItem("hertzinno.eventCenter.filters"); } catch (error) { storedFilterAfterClear = "READ_FAILED"; }' +
    /*
     * 版面几何。结构对了不等于版面没坏：三栏挤在一起、出现横向滚动条、KPI 被挤成两行，
     * 都是"控件都在、断言全绿"却肉眼一看就废的那种。这几条量的是**关系**（谁在谁左边、
     * 有没有溢出），不是绝对值 —— 绝对值（216px 之类）在前面已经量过了。
     */
    'const rect = (selector) => {' +
    '  const node = document.querySelector(selector);' +
    '  return node ? node.getBoundingClientRect() : null;' +
    '};' +
    'const panelRect = rect(".filter-panel");' +
    'const queueRect = rect(".alert-queue");' +
    'const stripRect = rect(".kpi-strip");' +
    'const overflowX = document.documentElement.scrollWidth - window.innerWidth;' +
    'const viewport = window.innerWidth + "x" + window.innerHeight;' +
    'window.__eventsProbeStep = "done";' +
    'return JSON.stringify({' +
    '  diag, tileLabels, tileValues, scope, hasSearchBox: !!searchBox, panelWidth, groups, optionCount,' +
    '  panelScope, savedLabels, modeLabels, oldTable: !!oldTable, summary, rowCounts, heights,' +
    '  drawerOpened, drawerClosedByEsc, drawerInfo, hashAfterKpi, pressedAfterKpi, activeOptions, storedFilter,' +
    '  cleared, rowsAfterClear, storedFilterAfterClear, aggregation: agg,' +
    '  viewport, overflowX,' +
    '  panelRight: panelRect ? Math.round(panelRect.right) : null,' +
    '  queueLeft: queueRect ? Math.round(queueRect.left) : null,' +
    '  queueWidth: queueRect ? Math.round(queueRect.width) : null,' +
    '  stripHeight: stripRect ? Math.round(stripRect.height) : null' +
    '});' +
    '})()', 240_000)
  log('events center : ' + JSON.stringify(eventsCenter))
  /*
   * 探针超时时**只报超时，不编造别的结论**。
   *
   * 为什么单独写这一支（2026-09-17 实测踩到）：`layout()` 超时返回 `{probeTimeout:true}`，
   * 而下面每一条断言都要读字段 —— 第一版直接读 `scope.includes(...)`，于是整个 driver 抛
   * `TypeError` 退出，**连报告都没打印出来**（一次运行白跑，还看不出是超时）。超时本身已经是
   * 一条 problems（`layout()` 里推的），这一段就不该再添 12 条"缺字段"的噪声。
   *
   * 卡在哪一步：页面脚本每一步都往 `window.__eventsProbeStep` 写过标记（见上面的注释），
   * 所以这里再问一句就能报出来 —— 前提是渲染进程还能应答，问不到就写"读不到"。
   */
  if (eventsCenter.probeTimeout === true) {
    const step = await Promise.race([
      win.webContents
        .executeJavaScript('(window.__eventsProbeStep || "none")')
        .catch(() => 'unreadable'),
      sleep(5000).then(() => 'unreadable')
    ])
    log('events center : 这一段**超时**，卡在：' + step)
    problems.push('事件中心探针超时（卡在 ' + step + '）—— 这一段没有任何结论')
  } else {
    for (const label of ['严重', '高', '未确认', '平均确认耗时']) {
      if (!eventsCenter.tileLabels.includes(label)) {
        problems.push('KPI 条缺少「' + label + '」那一格：' + JSON.stringify(eventsCenter.tileLabels))
      }
    }
    if (eventsCenter.tileLabels.length !== 4) {
      problems.push(
        'KPI 条不是四格（「聚合事件」属于 Phase 6，画出来就是一个恒为 0 的假数字）：' +
          JSON.stringify(eventsCenter.tileLabels)
      )
    }
    // 作用域：数字只统计已加载的那一页，不说出来就会被读成全量。
    if (!eventsCenter.scope.includes('已加载')) {
      problems.push('KPI 条没有印出统计作用域：' + JSON.stringify(eventsCenter.scope))
    }
    // 平均确认耗时：三路来源都没有确认时刻，显示 0 会被读成"确认得飞快"。
    if (eventsCenter.tileValues[3] !== '—') {
      problems.push(
        '平均确认耗时不是「—」（来源里没有确认时刻）：' + JSON.stringify(eventsCenter.tileValues)
      )
    }
    if (!eventsCenter.hasSearchBox) {
      problems.push('筛选栏里没有关键字搜索框')
    }
    if (eventsCenter.panelWidth !== 216) {
      problems.push('筛选面板宽度不是规格的 216px：' + eventsCenter.panelWidth)
    }
    for (const group of ['等级', '来源', '确认状态', '设备']) {
      if (!eventsCenter.groups.includes(group)) {
        problems.push('筛选面板没有「' + group + '」这一组：' + JSON.stringify(eventsCenter.groups))
      }
    }
    // 每组至少有一个选项 + 一个「全部」：4 组 + 严重3+未知1 + 来源3 + 确认2 + 设备3 = 16 起。
    if (eventsCenter.optionCount < 12) {
      problems.push('筛选面板的选项太少（计数或分组没渲染）：' + eventsCenter.optionCount)
    }
    if (!eventsCenter.panelScope.includes('已加载')) {
      problems.push('筛选面板没有说出计数的作用域：' + JSON.stringify(eventsCenter.panelScope))
    }
    if (eventsCenter.savedLabels.length !== 6) {
      problems.push('内置视图不是六个：' + JSON.stringify(eventsCenter.savedLabels))
    }
    if (eventsCenter.modeLabels.length !== 3) {
      problems.push('视图模式不是三档：' + JSON.stringify(eventsCenter.modeLabels))
    }
    if (eventsCenter.oldTable) {
      problems.push('事件中心还在渲染旧的事件表格（告警队列已经取代它）')
    }
    if (eventsCenter.rowCounts.standard > 0) {
      if (eventsCenter.heights.compact !== '56px') {
        problems.push('紧凑模式的行高不是 56px：' + JSON.stringify(eventsCenter.heights))
      }
      if (eventsCenter.heights.standard !== '88px') {
        problems.push('标准模式的行高不是规格的 88px：' + JSON.stringify(eventsCenter.heights))
      }
      if (eventsCenter.heights.evidence !== '104px') {
        problems.push('证据模式的行高不是规格的 104px：' + JSON.stringify(eventsCenter.heights))
      }
      if (!eventsCenter.drawerOpened) {
        problems.push('点告警队列的一行没有打开详情抽屉')
      }
      if (!eventsCenter.drawerClosedByEsc) {
        problems.push('Esc 没有关掉详情抽屉')
      }
      /*
       * 抽屉本体（规格 §11）：默认宽度 400、抓手 400–560、页签只有已实现的两个、
       * Overview 是 2 列属性网格、切到 Evidence 真的切过去、键盘改宽度写回 localStorage。
       */
      const info = eventsCenter.drawerInfo || {}
      // 页面根本没挂上来时：先把"当时页面上是什么"报出来，再谈别的（否则全是连带噪声）。
      if (info === undefined || eventsCenter.diag?.hasKpi !== true) {
        problems.push(
          '事件中心页没有挂载（KPI 条不存在）——当时页面：' + JSON.stringify(eventsCenter.diag)
        )
      }
      if (info.width !== 400) {
        problems.push('抽屉默认宽度不是规格的 400px（1440×900 下）：' + info.width)
      }
      if (!info.hasHandle) {
        problems.push('抽屉没有可拖的宽度抓手')
      } else if (info.min !== '400' || info.max !== '560') {
        problems.push('抓手的 400–560 范围不对：' + info.min + '–' + info.max)
      }
      if (JSON.stringify(info.tabs) !== JSON.stringify(['概览', '证据', '时间线', '关联', '活动'])) {
        problems.push('抽屉页签不是规格的五个：' + JSON.stringify(info.tabs))
      }
      // Phase 5 的三个新页签：切得过去、内容有东西、作用域写着。
      if (info.afterTabRelated !== true) {
        problems.push('点「关联」页签没有切过去：' + JSON.stringify(info))
      }
      if (!(info.relatedGroups >= 3)) {
        problems.push('关联页签的分组少于三组（同设备/同类型/时间窗口）：' + info.relatedGroups)
      }
      if (String(info.relatedScope || '').indexOf('已加载') < 0) {
        problems.push('关联页签没有说明作用域（只在已加载的那一页里找）：' + JSON.stringify(info.relatedScope))
      }
      if (info.afterTabActivity !== true) {
        problems.push('点「处置记录」页签没有切过去：' + JSON.stringify(info))
      }
      if (info.afterTabTimeline !== true) {
        problems.push('点「时间线」页签没有切过去：' + JSON.stringify(info))
      }
      // 时间线至少要有"首次探测到"那一个节点。
      if (!(info.timelineNodes >= 1)) {
        problems.push('时间线一个节点都没有（连"首次探测到"都没有）：' + info.timelineNodes)
      }
      // 处置动作：至少一个，且有一个主 CTA（规格 §11.2：一次只有一个）。
      if (!(Array.isArray(info.statusActions) && info.statusActions.length >= 1)) {
        problems.push('抽屉头部没有任何处置动作：' + JSON.stringify(info.statusActions))
      }
      if (info.primaryAction === null || info.primaryAction === undefined) {
        problems.push('抽屉头部没有主 CTA：' + JSON.stringify(info))
      }
      if (!(info.gridFields >= 8)) {
        problems.push('Overview 属性网格的字段太少：' + info.gridFields)
      }
      if (!(info.wideFields >= 1)) {
        problems.push('Overview 里没有跨两列的长字段（事件标识）')
      }
      if (info.overviewVisible !== true || info.evidenceVisible !== false) {
        problems.push('打开抽屉时默认没有停在 Overview：' + JSON.stringify(info))
      }
      if (info.afterTabEvidence !== true || info.afterTabOverview !== false) {
        problems.push('点「证据」页签没有切过去：' + JSON.stringify(info))
      }
      // 有图，或者有四种"取不到图"的说法之一 —— 空框是最糟的形态。
      if (!(info.evidenceImages > 0) && String(info.evidenceNote || '').trim() === '') {
        problems.push('Evidence 页签既没有图也没有说明：' + JSON.stringify(info))
      }
      if (!info.focusInside) {
        problems.push('打开抽屉后焦点没有进入抽屉（↑/↓ 与读屏都要它）')
      }
      if (info.widthAfterKey !== 416) {
        problems.push('抓手上按 ← 没有把宽度改成 416：' + info.widthAfterKey)
      }
      if (String(info.storedWidth) !== '416') {
        problems.push('抽屉宽度没有写回 localStorage（或写错了）：' + JSON.stringify(info.storedWidth))
      }
    } else {
      log(
        'events center : 这一屏没有告警行（' + JSON.stringify(eventsCenter.summary) +
          '）——行高 / 点开抽屉 / Esc 三项**没有验证**'
      )
    }
    if (!eventsCenter.hashAfterKpi.includes('severity=critical')) {
      problems.push('点 KPI「严重」没有把筛选写进地址栏：' + eventsCenter.hashAfterKpi)
    }
    if (eventsCenter.pressedAfterKpi !== 'true') {
      problems.push('点 KPI「严重」之后那一格没有标成按下：' + eventsCenter.pressedAfterKpi)
    }
    if (!eventsCenter.activeOptions.some((option) => option.startsWith('严重'))) {
      problems.push(
        '点 KPI「严重」没有同步到左侧筛选面板：' + JSON.stringify(eventsCenter.activeOptions)
      )
    }
    // 只读探针要把现场还原（否则后面那条写探针会继承一个"筛到 0 条"的状态）。
    // 重复触发聚合（规格 §14.1）：下拉在、四档、切到"不聚合"行数不变少。
    const aggregation = eventsCenter.aggregation || {}
    if (aggregation.hasSelect !== true) {
      problems.push('筛选栏里没有聚合窗口的下拉（规格 §14.1 要求可配置）')
    }
    if (JSON.stringify(aggregation.options) !== JSON.stringify(['off', '10m', '30m', '1h'])) {
      problems.push('聚合窗口不是四档：' + JSON.stringify(aggregation.options))
    }
    if (!(aggregation.rowsUngrouped >= aggregation.rowsGrouped)) {
      problems.push(
        '关掉聚合之后行数反而少了（聚合不是"并组"？）：' +
          JSON.stringify(aggregation)
      )
    }
    if (aggregation.countChips > 0 && !(aggregation.rowsUngrouped > aggregation.rowsGrouped)) {
      problems.push(
        '队列里画了 ×N，而关掉聚合之后行数没变（说明那个 ×N 是编的）：' +
          JSON.stringify(aggregation)
      )
    }
    if (aggregation.rowsRestored !== aggregation.rowsGrouped) {
      log(
        'events center : 聚合窗口恢复之后行数是 ' + aggregation.rowsRestored +
          '（切走前是 ' + aggregation.rowsGrouped + '）—— 只读探针没还原现场'
      )
    }
    if (eventsCenter.cleared !== true) {
      problems.push('事件中心那一段没有把筛选清回去（下一条探针会继承它）')
    } else if (!(eventsCenter.rowsAfterClear > 0)) {
      problems.push('清掉筛选之后队列仍然是空的：' + eventsCenter.rowsAfterClear)
    }
    if (
      typeof eventsCenter.storedFilterAfterClear !== 'string' ||
      !eventsCenter.storedFilterAfterClear.includes('"severity":""')
    ) {
      problems.push(
        '清筛选之后 localStorage 里那一份没有跟着清：' +
          JSON.stringify(eventsCenter.storedFilterAfterClear)
      )
    }
    // 写进 localStorage 的那一份要能读回来（"写了"与"写对了"是两件事）。
    if (
      typeof eventsCenter.storedFilter !== 'string' ||
      !eventsCenter.storedFilter.includes('"severity":"critical"')
    ) {
      problems.push(
        '筛选没有（或写错了）记进 localStorage，读回来是：' + JSON.stringify(eventsCenter.storedFilter)
      )
    }
    // 版面关系：横向不溢出、面板在队列左边不重叠、KPI 条一行放得下。
    if (eventsCenter.overflowX > 2) {
      problems.push(
        '事件中心出现了横向溢出：' + eventsCenter.overflowX + 'px（视口 ' + eventsCenter.viewport + '）'
      )
    }
    if (
      eventsCenter.panelRight !== null &&
      eventsCenter.queueLeft !== null &&
      eventsCenter.queueLeft < eventsCenter.panelRight
    ) {
      problems.push(
        '筛选面板与告警队列重叠：面板右缘 ' + eventsCenter.panelRight + '，队列左缘 ' + eventsCenter.queueLeft
      )
    }
    if (eventsCenter.stripHeight !== null && eventsCenter.stripHeight > 160) {
      problems.push(
        'KPI 条在 ' + eventsCenter.viewport + ' 下被挤成了多行（高 ' + eventsCenter.stripHeight + 'px）'
      )
    }
  }

  /**
   * ① 听诊盒子「拉」通道的**端到端**走一遍（业主 2026-09-16 第①项）。
   *
   * 设备这一侧是本进程里的假设备（`startMockE2Device()`，按手册实现；文件头写了它能证明
   * 什么、不能证明什么）。界面这一侧是真的：打开添加设备对话框 → 选听诊盒子 → 填地址凭据
   * → 测试连接 → 添加 → 进设备详情 → 点「同步告警」→ 读同步结果。
   *
   * 断言分两层，缺一不可：
   *   - **应用真的做了什么**（driver 侧读假设备的请求记录）：POST /login 用的是加盐摘要、
   *     之后每个请求都带 `Bearer` token、日志走 `/alarm_log_all`、下载走 `/alarm_files`
   *     且 `file_path` 含 `saving_path`；
   *   - **东西真的落进本机库了**（renderer 侧查 IPC）：alarms 有这条告警、recordings 有这份
   *     wav，并且文件真的在磁盘上（下载字节数 > 44 字节的 WAV 头）。
   *
   * 存储根目录**改成这一次性 profile 里的目录**再同步：`--with-data` 用的是操作员真库的副本，
   * 但 `storageRoot` 指向的是他真实的存储目录 —— 不换掉就会往他的目录里写一份探针录音。
   */
  const probeStorageRoot = path.join(app.getPath('userData'), 'probe-storage')
  const mockE2 = await startMockE2Device({ password: 'admin123' })
  log('mock E2 device : 127.0.0.1:' + mockE2.port)

  const e2Script = ('(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const findButton = (root, needle) => [...root.querySelectorAll("button")]' +
    '  .find((b) => text(b).includes(needle));' +
    /*
     * 找**添加设备那个**对话框，而不是"文档里第一个 role=dialog"。
     *
     * 为什么（这一版探针连续踩了两次）：`role="dialog"` 在页面里不止一个 —— 顶栏的
     * 「待处理告警」浮层也是（它由更早的探针点开、之后一直留着）。按"第一个可见的"取，
     * 拿到的是那个告警浮层。
     * 判据从"里面有机型单选项（`.kind__radio`）"换成了**那个组件自己挂的标记**
     * （`data-add-device-dialog`）：机型选择按第 2 条删掉了，原来的判据随之失效。
     */
    'const visibleDialogs = () => [...document.querySelectorAll("[role=dialog]")]' +
    '  .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });' +
    'const addDialog = () => visibleDialogs().find((d) => d.querySelector("[data-add-device-dialog]")) || null;' +
    'const setInput = (el, value) => { el.value = value;' +
    '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  el.dispatchEvent(new Event("change", { bubbles: true })); };' +
    /*
     * **渲染层 store 里的设备数** —— 用顶栏那颗指示器读（它是 `devices.devices.length`，
     * 每一页都在），顺带读它的错误文案（`devices.error`）。
     *
     * 为什么要这个读数：加完设备之后实时监测页的设备下拉里只剩这一台，而 IPC 同时报 3 台。
     * 下拉与顶栏读的是**同一个 store**，两个读数一比就知道是"store 真的只有 1 台"还是
     * "下拉渲染错了"；而 `devices.error` 非空说明那一次 `load()` 失败过。
     */
    'const storeDeviceCount = () => {' +
    '  const el = document.querySelector(".topbar .indicator__value");' +
    '  const value = el ? Number(text(el)) : NaN;' +
    '  return Number.isFinite(value) ? value : -1;' +
    '};' +
    'const storeError = () => text(document.querySelector(".topbar__error")).slice(0, 120);' +
    'const ipcDeviceCount = async () => {' +
    '  const listed = await window.api.devices.list();' +
    '  return listed && listed.success ? (listed.data || []).length : -1;' +
    '};' +
    'const out = { steps: [] };' +
    'try {' +
    // 可能开着的弹窗先关掉（有取消/关闭按钮的那种），从干净的状态开始。
    '  for (let i = 0; i < 3; i += 1) {' +
    '    const open = visibleDialogs().find((d) =>' +
    '      findButton(d, "取消") || findButton(d, "Cancel") || findButton(d, "关闭") || findButton(d, "Close"));' +
    '    if (!open) break;' +
    '    const cancel = findButton(open, "取消") || findButton(open, "Cancel") ||' +
    '      findButton(open, "关闭") || findButton(open, "Close");' +
    '    cancel.click(); await wait(400);' +
    '  }' +
    '  location.hash = "#/devices"; await wait(900);' +
    '  out.storeAtStart = storeDeviceCount();' +
    '  out.ipcAtStart = await ipcDeviceCount();' +
    '  out.storeErrorAtStart = storeError();' +
    '  out.tableRowsAtStart = document.querySelectorAll("table.devices-table tbody tr").length;' +
    '  const add = document.querySelector("[data-action=\\"device-add\\"]");' +
    '  if (!add) return JSON.stringify({ ok: false, reason: "no-add-button" });' +
    '  add.click(); await wait(600);' +
    '  let dlg = addDialog();' +
    '  if (!dlg) return JSON.stringify({ ok: false, reason: "no-add-dialog",' +
    '    visible: visibleDialogs().map((d) => text(d).slice(0, 40)) });' +
    /*
     * **机型不再由人选**（第 2 条）：这一版里对话框里没有机型控件，探针也不点它。
     * 要证明的还是那件事 —— 识别出来的机型必须**当面说出来**（`[data-probe-kind]`）。
     */
    '  out.kindRadios = dlg.querySelectorAll(".kind__radio").length;' +
    '  const inputs = [...dlg.querySelectorAll(".form-grid input.input")];' +
    '  if (inputs.length < 4) return JSON.stringify({ ok: false, reason: "few-inputs", count: inputs.length });' +
    '  setInput(inputs[0], "127.0.0.1");' +
    '  setInput(inputs[1], "__E2_PORT__");' +
    '  setInput(inputs[2], "admin");' +
    '  setInput(inputs[3], "admin123");' +
    /*
     * 地址信息（第 1 条；2026-09-18 第 10 条删掉基准声压级之后是**三个**框）：
     * 经纬度与方位角都填上，加完之后要从**库里读回来**逐项相等 ——
     * 业主的硬规矩是"每个写设备的操作必须读回验证"，所以这一段不是可选的。
     */
    '  const toggle = dlg.querySelector("[data-action=toggle-add-installation]");' +
    '  if (toggle && toggle.getAttribute("aria-expanded") === "false") { toggle.click(); await wait(300); }' +
    '  const install = [...dlg.querySelectorAll(".install input.input")];' +
    '  out.installInputs = install.length;' +
    '  if (install.length === 3) {' +
    '    setInput(install[0], "31.2304");' +
    '    setInput(install[1], "121.4737");' +
    '    setInput(install[2], "135");' +
    '  }' +
    '  await wait(300);' +
    '  const test = findButton(dlg, "测试连接");' +
    '  if (!test) return JSON.stringify({ ok: false, reason: "no-test-button" });' +
    '  test.click(); await wait(2000);' +
    '  dlg = addDialog();' +
    '  out.probeSucceeded = !!(dlg && dlg.querySelector(".probe .badge--success"));' +
    '  out.probeText = text(dlg && dlg.querySelector(".probe")).slice(0, 160);' +
    '  out.detectedKindText = text(dlg && dlg.querySelector("[data-probe-kind]")).slice(0, 120);' +
    '  out.steps.push("probe");' +
    '  const submit = [...dlg.querySelectorAll("button")].filter((b) => text(b).includes("添加设备")).pop();' +
    '  if (!submit) return JSON.stringify({ ok: false, reason: "no-submit", steps: out.steps });' +
    '  submit.click(); await wait(2000);' +
    /*
     * 添加成功之后对话框**不自己关**（2026-09-19 第 1 条：添加设备要能当场看到推流地址与秘钥）。
     * 所以这里量两件事：那一块"添加成功 + 推流地址"有没有出现，以及点「关闭」之后真的关掉。
     */
    '  const doneBlock = document.querySelector("[data-add-device-done]");' +
    '  const pushBlock = document.querySelector("[data-device-push]");' +
    '  out.addDoneShown = !!doneBlock;' +
    '  out.pushShownAfterAdd = !!pushBlock;' +
    '  const closeButton = [...dlg.querySelectorAll("button")].find((b) => text(b) === "关闭");' +
    '  if (closeButton) { closeButton.click(); await wait(500); }' +
    '  out.dialogClosed = !addDialog();' +
    '  out.steps.push("add");' +
    /*
     * 加完设备那一刻的两个读数：store 里几台、库里几台，以及 store 有没有报错。
     * 这三个数放在一起才能区分"主进程没写进去"、"写进去了但 store 没更新"、
     * 以及"某次 load() 失败（`devices.error` 非空）"。
     */
    '  out.storeAfterAdd = storeDeviceCount();' +
    '  out.ipcAfterAdd = await ipcDeviceCount();' +
    '  out.storeErrorAfterAdd = storeError();' +
    // 找到刚加进来的那一台：**按地址找**（127.0.0.1 = 这一次的假设备）。
    /*
     * 为什么不能按 `kind === "auscultationBox"` 找第一台：`--with-data` 用的是操作员真库的
     * 副本，而他的库里**本来就有一台 SN-16**（2026-09-17 真机验证时加进去的）。按 kind 找
     * 会拿到那一台真设备，于是后面每一条断言都在问一台离线的真机 —— 第一版就是这样：
     * 探针报"告警 0 条、录音 0 份、身份不是 equip_number"，全是假失败。
     */
    '  const listed = await window.api.devices.list();' +
    '  const devices = listed && listed.success ? listed.data : [];' +
    '  const box = (devices || []).find((d) => d.ip === "127.0.0.1" &&' +
    '    d.httpPort === __E2_PORT__) || null;' +
    '  if (!box) return JSON.stringify({ ok: false, reason: "device-not-listed", steps: out.steps,' +
    '    devices: (devices || []).map((d) => d.kind + "@" + d.ip) });' +
    '  out.deviceId = box.id;' +
    '  out.deviceName = box.name;' +
    '  out.deviceUid = box.deviceUid;' +
    /*
     * 安装信息**读回来**（第 1 条）：`devices.list()` 是重新查库的那条路，不是 store 里
     * 那份内存快照。业主的硬规矩是"每个写设备的操作必须读回验证"，所以这里逐项比。
     */
    '  out.installation = box.installation || null;' +
    '  const relisted = await window.api.devices.list();' +
    '  const boxAgain = relisted && relisted.success' +
    '    ? (relisted.data || []).find((d) => d.id === box.id) : null;' +
    '  out.installationReadBack = boxAgain ? (boxAgain.installation || null) : null;' +
    // 存储根目录换成这一次性 profile 里的目录：不许往操作员真实的存储目录里写探针文件。
    '  await window.api.settings.update({ storageRoot: __E2_STORAGE__ });' +
    // 进设备详情，切到「听诊盒子」页签，点同步。
    '  location.hash = "#/devices/" + box.id; await wait(900);' +
    '  const tab = document.querySelector(".tabs [data-tab=auscultation]");' +
    '  if (!tab) return JSON.stringify({ ok: false, reason: "no-auscultation-tab", steps: out.steps });' +
    '  tab.click(); await wait(900);' +
    '  out.statusShown = !!document.querySelector("[data-action=e2-sync]");' +
    '  const sync = document.querySelector("[data-action=e2-sync]");' +
    '  if (!sync) return JSON.stringify({ ok: false, reason: "no-sync-button", steps: out.steps });' +
    '  sync.click(); await wait(3500);' +
    '  const outcomeEl = document.querySelector("[data-e2-outcome]");' +
    '  out.outcomeText = text(outcomeEl).slice(0, 240);' +
    '  out.steps.push("sync");' +
    // 本机库：告警与录音都要有这台设备的记录。
    '  const alarms = await window.api.alarms.query({ deviceId: box.id, limit: 10 });' +
    '  out.alarms = alarms && alarms.success ? (alarms.data.items || []).length : -1;' +
    '  const recordings = await window.api.recordings.query({ deviceId: box.id, limit: 10 });' +
    '  const items = recordings && recordings.success ? (recordings.data.items || []) : [];' +
    '  out.recordings = items.length;' +
    '  out.recording = items[0] ? { id: items[0].id, relativePath: items[0].relativePath,' +
    '    sampleRate: items[0].sampleRate, fileSize: items[0].fileSize || 0,' +
    '    recordingType: items[0].recordingType } : null;' +
    /*
     * 诊断用：走完这条链之后，**主进程**里还有几台设备。
     * 探针后面那几条断言（相机那一支）依赖设备列表，所以设备数变少时必须能一眼看出是
     * "库里真的少了"还是"渲染层的 store 里少了"。
     */
    '  const all = await window.api.devices.list();' +
    '  out.deviceCountAfter = all && all.success ? (all.data || []).length : -1;' +
    '  out.deviceKindsAfter = all && all.success ? (all.data || []).map((d) => d.kind) : [];' +
    '  location.hash = "#/monitor"; await wait(900);' +
    '  out.storeAtEnd = storeDeviceCount();' +
    '  out.storeErrorAtEnd = storeError();' +
    '  out.selectOptionsAfter = [...document.querySelectorAll("#topbar-page-slot select option")]' +
    '    .map((o) => text(o));' +
    /*
     * **界面上的设备列表**：下拉里的 option（= store 里的设备）与顶栏那颗指示器
     * （`devices.devices.length`，同一个 store 的第二个读数）。
     *
     * 这两个读数加在一起才能钉住 2026-09-17 修掉的那个缺陷：`devices.refreshStatus(id)`
     * 原来把主进程回**一台**当成整份列表，于是"进一次设备详情页"之后全应用的设备列表
     * 只剩那一台 —— 顶栏与下拉会同时变小，而库里一台都没少。
     */
    '  const options = Array.isArray(out.selectOptionsAfter) ? out.selectOptionsAfter : [];' +
    '  out.addedDeviceVisible = options.some((label) => label.indexOf("探针听诊盒子") >= 0);' +
    /*
     * ⑤ 三种机型三支内容里的**第三支**：这一台是听诊盒子/声呐，`/monitor` 必须显示声呐那一屏
     * —— 参数与告警同步面板 + 安装点位卡片 + 本机录音时间轴，以及那句"实时流未接入"；
     * **不能**是声纹那一支（通道页签 / 实时趋势 / 图谱）。
     */
    '  out.sonarBranch = {' +
    '    unwired: document.querySelectorAll("[data-sonar-live-unwired]").length,' +
    '    syncButton: document.querySelectorAll("[data-action=e2-sync]").length,' +
    '    installCard: document.querySelectorAll("[data-installation]").length,' +
    '    installPoint: text(document.querySelector("[data-installation-point]")),' +
    '    channelTabs: document.querySelectorAll(".channel-tabs").length,' +
    '    trend: document.querySelectorAll(".trend-panel").length,' +
    '    audioBar: document.querySelectorAll(".audio-bar").length' +
    '  };' +
    '  return JSON.stringify(Object.assign({ ok: true }, out));' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, reason: "threw", message: String(error && error.message || error),' +
    '    steps: out.steps });' +
    '}' +
    '})()')
    /*
     * 端口与存储目录在**这里**替换，而不是在拼接里 —— `'a' + 'b'.replace(...)` 只会替换
     * 最后一个字符串字面量（这条链式写法第一版就是这么错的，探针会把 PORT 当成变量名）。
     */
    .replace(/__E2_PORT__/g, String(mockE2.port))
    .replace(/__E2_STORAGE__/g, JSON.stringify(probeStorageRoot))

  const e2Flow = await layout('/devices', e2Script)

  log('e2 pull flow   : ' + JSON.stringify(e2Flow))

  /** 假设备这一侧：应用究竟发出了什么。 */
  const e2Paths = mockE2.requests.map((entry) => entry.method + ' ' + entry.path)
  const e2Logins = mockE2.requests.filter((entry) => entry.path === '/login')
  const e2Files = mockE2.requests.filter((entry) => entry.path === '/alarm_files')
  const e2Authed = mockE2.requests.filter(
    (entry) => entry.path !== '/login' && entry.auth === 'Bearer probe-token'
  )
  log('mock E2 saw    : ' + JSON.stringify({
    paths: e2Paths,
    loginStyles: e2Logins.map((entry) => entry.digestStyle),
    filePaths: e2Files.map((entry) => entry.filePath),
    authedCalls: e2Authed.length
  }))

  if (!e2Flow.ok) {
    problems.push('听诊盒子端到端流程没有走通：' + JSON.stringify(e2Flow))
  } else {
    if (!e2Flow.probeSucceeded) {
      problems.push('「测试连接」没有报成功：' + JSON.stringify(e2Flow.probeText))
    }
    /*
     * 2026-09-19 第 1 条把这一条从"添加完就关窗"改成了"添加完**当场显示推流地址与秘钥**，
     * 点「关闭」才关"。所以断言分两步：那一块必须出现，而按钮必须真的能关掉它。
     */
    if (!e2Flow.addDoneShown) problems.push('添加成功之后没有出现「设备已添加」那一块')
    if (!e2Flow.pushShownAfterAdd) {
      problems.push('添加成功之后没有显示推流地址与秘钥（[data-device-push]）')
    }
    if (!e2Flow.dialogClosed) problems.push('点「关闭」之后添加设备对话框没有关掉')
    if (e2Flow.deviceUid !== 'e2:PROBE-E2-0001') {
      problems.push('新设备的身份不是设备自己报的 equip_number：' + e2Flow.deviceUid)
    }
    if (!e2Flow.statusShown) problems.push('设备详情里看不到听诊盒子面板（没有同步按钮）')
    /*
     * ①② 自动识别机型 + 安装信息录入（业主 2026-09-17 第 1、2 条）。
     *   ① 对话框里**不许**再有机型控件（`kindRadios` 必须为 0），且识别结果要写出来
     *      （`detectedKindText` 里出现"听诊盒子"）；
     *   ② 四个点位数写进去之后**从库里读回来**逐项相等 —— 这是"写设备必须读回验证"。
     */
    if (e2Flow.kindRadios !== 0) {
      problems.push('添加设备对话框里还有机型单选项（第 2 条要求不再让人选机型）：' + e2Flow.kindRadios)
    }
    if (!/听诊盒子/.test(String(e2Flow.detectedKindText || ''))) {
      problems.push('探活结果里没有说出自动识别出来的机型：' + JSON.stringify(e2Flow.detectedKindText))
    }
    if (e2Flow.installInputs !== 3) {
      problems.push('添加设备对话框里的地址信息输入不是三个（第 10 条）：' + e2Flow.installInputs)
    }
    const installationReadBack = e2Flow.installationReadBack || null
    /*
     * 只比**三个**字段：基准声压级按第 10 条不再由界面录入，所以库里那一位应当仍然是
     * 「没有值」（`undefined` 会被 `JSON.stringify` 丢掉，于是对象只剩三个键）。
     */
    const EXPECTED_INSTALLATION = {
      gisLatitude: 31.2304,
      gisLongitude: 121.4737,
      azimuthDeg: 135
    }
    if (JSON.stringify(installationReadBack) !== JSON.stringify(EXPECTED_INSTALLATION)) {
      problems.push(
        '录入的地址信息从库里读回来不是原值：' + JSON.stringify(installationReadBack) +
          '（期望 ' + JSON.stringify(EXPECTED_INSTALLATION) + '）'
      )
    }
    /*
     * ⑤ 声呐那一支（第 5 条）：这一台是听诊盒子族，`/monitor` 必须是声呐那一屏。
     * 判据是**两边都要**：声呐该有的在、声纹那一支的不在 —— 只说"有参数面板"证明不了
     * 它没有落到声纹那一支上（那一支也会渲染页面）。
     *
     * 2026-09-18 第 19 条把那一句"实时流未接入"删掉了，所以这里反过来断言它**不在**。
     */
    const sonar = e2Flow.sonarBranch || {}
    if (sonar.unwired !== 0) {
      problems.push(
        '实时监测页又出现了「实时流未接入」那句说明（第 19 条要求删掉）：' + JSON.stringify(sonar)
      )
    }
    if (sonar.syncButton !== 1) {
      problems.push('声呐那一支没有参数与告警同步面板：' + JSON.stringify(sonar))
    }
    if (sonar.installCard !== 1) {
      problems.push('声呐那一支没有地址信息卡片：' + JSON.stringify(sonar))
    }
    if (String(sonar.installPoint || '').indexOf('31.2304') < 0) {
      problems.push('声呐那一支的地址点位不是录入的那个：' + JSON.stringify(sonar.installPoint))
    }
    if (sonar.channelTabs !== 0 || sonar.trend !== 0 || sonar.audioBar !== 0) {
      problems.push(
        '声呐那一支里出现了声纹设备的东西（通道页签/趋势/音频条）：' + JSON.stringify(sonar)
      )
    }
    if (e2Flow.alarms !== 1) {
      problems.push('同步之后本机库里这台设备的告警不是 1 条：' + e2Flow.alarms)
    }
    if (e2Flow.recordings !== 1) {
      problems.push('同步之后本机库里这台设备的录音不是 1 份：' + e2Flow.recordings)
    }
    if (e2Flow.recording && e2Flow.recording.sampleRate !== 48000) {
      // 采样率必须来自**真 WAV 表头**，不是我们猜的默认值。
      problems.push('下载回来的录音采样率不是 WAV 表头里的 48000：' + e2Flow.recording.sampleRate)
    }
    if (e2Flow.recording && e2Flow.recording.fileSize <= 44) {
      problems.push('录音文件只有 WAV 头（没有数据）：' + e2Flow.recording.fileSize)
    }
    /*
     * **界面上的设备列表不许比库里少**。
     *
     * 这条断言钉住的是 2026-09-17 定位并修掉的缺陷：`devices.refreshStatus(id)` 原来把
     * 主进程回的**一台**当成整份列表（`devices.value = list`），而设备详情页每次进入都会调它
     * （`DeviceDetailView`），于是"进过一次详情页"之后全应用的设备列表只剩那一台：
     * 顶栏总数与实时监测的下拉同时变小，库里一台都没少。
     * 这条探针正好会经过一次详情页（切听诊盒子页签并同步），所以它能抓住回归 ——
     * 修复前这两个读数分别是 1（下拉）/ 1（顶栏）而库里有 3 台。
     */
    const options = Array.isArray(e2Flow.selectOptionsAfter) ? e2Flow.selectOptionsAfter : []
    if (options.length < e2Flow.deviceCountAfter) {
      problems.push(
        '实时监测页的设备下拉少于库里的设备数（' + options.length + ' vs ' +
          e2Flow.deviceCountAfter + '）—— 设备列表被"单台刷新"截断过：' + JSON.stringify(options)
      )
    }
    if (e2Flow.storeAtEnd !== -1 && e2Flow.storeAtEnd < e2Flow.deviceCountAfter) {
      problems.push(
        '顶栏的设备总数少于库里的（' + e2Flow.storeAtEnd + ' vs ' + e2Flow.deviceCountAfter +
          '）—— 渲染层的设备列表被截断了'
      )
    }
    /*
     * **这一台新设备要能被界面看见**。库里写进去了、界面上没有，对操作员就是"设备没加成功"。
     */
    if (e2Flow.addedDeviceVisible !== true) {
      problems.push(
        '加进来的那台设备没有出现在实时监测页的设备下拉里：' +
          JSON.stringify(e2Flow.selectOptionsAfter)
      )
    }
    if (!/1/.test(e2Flow.outcomeText)) {
      problems.push('同步结果那几行没有读出条数：' + JSON.stringify(e2Flow.outcomeText))
    }
  }

  /**
   * ⑧ 空气声呐（SN-16）：**PTZ 配置页** + **点位图** + **告警抓图**（业主 2026-09-17 第 8 批）。
   *
   * 这一条也是一次**写操作**（加设备、改 PTZ 参数、同步），所以它排在所有只读探针之后。
   *
   * 三件事各自只有一种方式能证明：
   *   - **页签只有 PTZ**：读 DOM 里 `.tabs [role=tab]` 的**标签列表**（不是"有没有 PTZ 面板"——
   *     留着 2023 版那一组时 PTZ 面板照样在）；
   *   - **保存真的写进了设备**：改一个端口 → 保存 → 读回核对那一块说"全部生效"，
   *     并且**假设备那一侧的参数也变了**（两边都看，才排除"界面自己在演"）；
   *   - **抓图真的显示出来了**：`<img>` 的 `naturalWidth > 0`。这一条同时验了 CSP 的白名单
   *     （`img-src http://127.0.0.1:*`）、回环端点、以及"目录落库 → 界面找得到"这条链 ——
   *     任何一环断了图片都是 0×0。
   */
  const mockSonar = await startMockE2Device({ password: 'admin123', variant: 'airSonar' })
  log('mock air sonar : 127.0.0.1:' + mockSonar.port)

  const sonarScript = ('(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const findButton = (root, needle) => [...root.querySelectorAll("button")]' +
    '  .find((b) => text(b).includes(needle));' +
    'const visibleDialogs = () => [...document.querySelectorAll("[role=dialog]")]' +
    '  .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; });' +
    'const addDialog = () => visibleDialogs().find((d) => d.querySelector("[data-add-device-dialog]")) || null;' +
    'const setInput = (el, value) => { el.value = value;' +
    '  el.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  el.dispatchEvent(new Event("change", { bubbles: true })); };' +
    'const out = { steps: [] };' +
    'try {' +
    // 关掉可能还开着的对话框（上一条探针留了一个），从干净状态开始。
    '  for (let i = 0; i < 3; i += 1) {' +
    '    const open = visibleDialogs().find((d) => findButton(d, "取消") || findButton(d, "Cancel"));' +
    '    if (!open) break;' +
    '    (findButton(open, "取消") || findButton(open, "Cancel")).click(); await wait(400);' +
    '  }' +
    '  location.hash = "#/devices"; await wait(900);' +
    '  const add = document.querySelector("[data-action=\\"device-add\\"]");' +
    '  if (!add) return JSON.stringify({ ok: false, reason: "no-add-button" });' +
    '  add.click(); await wait(600);' +
    '  let dlg = addDialog();' +
    '  if (!dlg) return JSON.stringify({ ok: false, reason: "no-add-dialog" });' +
    '  const creds = [...dlg.querySelectorAll(".form-grid input.input")];' +
    '  setInput(creds[0], "127.0.0.1");' +
    '  setInput(creds[1], "__SONAR_PORT__");' +
    '  setInput(creds[2], "admin");' +
    '  setInput(creds[3], "admin123");' +
    // 点位图要有点位才有得画：这一台按业主的流程录入**地址信息**（第 1 条；
    // 2026-09-18 第 10 条删掉基准声压级之后只剩经纬度与方位角）。
    // 第 13 批第 2 条之后这一块**默认收起**，所以先点一下那颗展开按钮。
    '  const installToggle = dlg.querySelector("[data-action=toggle-add-installation]");' +
    '  if (installToggle && installToggle.getAttribute("aria-expanded") === "false") {' +
    '    installToggle.click(); await wait(300); }' +
    '  const install = [...dlg.querySelectorAll(".install input.input")];' +
    '  setInput(install[0], "31.2304");' +
    '  setInput(install[1], "121.4737");' +
    '  setInput(install[2], "135");' +
    '  await wait(300);' +
    '  const test = findButton(dlg, "测试连接");' +
    '  if (!test) return JSON.stringify({ ok: false, reason: "no-test-button" });' +
    '  test.click(); await wait(2500);' +
    '  dlg = addDialog();' +
    '  out.probeText = text(dlg && dlg.querySelector(".probe")).slice(0, 140);' +
    '  out.detectedKindText = text(dlg && dlg.querySelector("[data-probe-kind]")).slice(0, 120);' +
    '  const submit = [...dlg.querySelectorAll("button")].filter((b) => text(b).includes("添加设备")).pop();' +
    '  submit.click(); await wait(2200);' +
    '  const listed = await window.api.devices.list();' +
    '  const devices = listed && listed.success ? listed.data : [];' +
    '  const sonar = (devices || []).find((d) => d.ip === "127.0.0.1" &&' +
    '    d.httpPort === __SONAR_PORT__) || null;' +
    '  if (!sonar) return JSON.stringify({ ok: false, reason: "sonar-not-listed", steps: out.steps,' +
    '    devices: (devices || []).map((d) => d.kind + "@" + d.ip + ":" + d.httpPort) });' +
    '  out.deviceId = sonar.id;' +
    '  out.e2Variant = sonar.e2Variant || null;' +
    // ---- PTZ 配置页：页签只有「PTZ 联动」 ----
    '  location.hash = "#/devices/" + sonar.id; await wait(1400);' +
    '  out.tabs = [...document.querySelectorAll(".tabs [role=tab]")].map((tab) => text(tab));' +
    '  out.ptzFields = [' +
    '    ...document.querySelectorAll("[data-ptz]")' +
    '  ].map((el) => ({ key: el.getAttribute("data-ptz"),' +
    '    value: el.type === "checkbox" ? el.checked : el.value }));' +
    '  const portField = document.querySelector("[data-ptz=cameraPort]");' +
    '  if (!portField) return JSON.stringify({ ok: false, reason: "no-ptz-panel", tabs: out.tabs });' +
    '  out.portBefore = portField.value;' +
    // 改端口 → 保存（只有「保存」才写设备）。
    '  setInput(portField, "8082"); await wait(200);' +
    '  const save = document.querySelector("[data-action=ptz-save]");' +
    '  if (!save) return JSON.stringify({ ok: false, reason: "no-ptz-save" });' +
    '  save.click(); await wait(2500);' +
    '  out.ptzChecks = [...document.querySelectorAll("[data-ptz-checks] li")].map((li) => text(li));' +
    '  out.ptzAllApplied = !!document.querySelector("[data-ptz-checks] .badge--success");' +
    '  const portAfter = document.querySelector("[data-ptz=cameraPort]");' +
    '  out.portAfter = portAfter ? portAfter.value : null;' +
    '  location.hash = "#/map"; await wait(1400);' +
    '  out.markers = document.querySelectorAll("[data-map-marker]").length;' +
    '  const marker = [...document.querySelectorAll("[data-map-marker]")]' +
    '    .find((el) => el.getAttribute("data-map-marker") === sonar.id);' +
    '  if (!marker) return JSON.stringify({ ok: false, reason: "no-marker-for-sonar", steps: out.steps,' +
    '    markers: document.querySelectorAll("[data-map-marker]").length });' +
    '  marker.dispatchEvent(new MouseEvent("click", { bubbles: true })); await wait(900);' +
    /*
     * 选中的是哪一台：第 13/17 条把右边那张卡片拿掉之后，"当前选中"显示在**告警列表**的
     * 小标题里（`mapUi.alarmsFor` = 「选中设备：<name>」）。探针读的是那个 `<span>`，
     * 所以判据从"右侧卡片的标题"换成"告警列表那一行里的名字"。
     */
    '  out.sideName = text(document.querySelector("[data-map-alarms] .section-header .muted"));' +
    /*
     * 第 14 条（在线绿 / 告警红 / 离线灰）的真凭据：**这一台真的画在图上**，所以这里能读到
     * 它的 `data-marker-tone`，以及图例三档的数字与图上落点数的关系。
     * 早先那段只读探针跑在加设备之前，操作员库里可能一台点位都没录（那时 `markerCount` 是 0，
     * 色调那一组断言是空过的）—— 所以这一台才是"落点配色"的实测点。
     */
    '  out.markerTone = marker.getAttribute("data-marker-tone");' +
    '  out.markerCount = document.querySelectorAll("[data-map-marker]").length;' +
    /*
     * 第 15/16 条的**悬停浮层**：这一台是真的画在图上的（下面那些只读探针跑在"加设备"之前，
     * operator 库那几台都没录点位，所以量不到）。派发一次 `mouseenter` 之后浮层应当出现，
     * 而且里面**不许有 `<video>`**。它是声纹设备，所以**不该有**"当前视频流"那一行
     * （第 16 条只要基本信息；那一行是第 15 条给相机的）。
     */
    '  marker.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));' +
    '  await wait(300);' +
    '  out.hoverPresent = !!document.querySelector("[data-map-hover]");' +
    '  out.hoverText = text(document.querySelector("[data-map-hover]")).slice(0, 200);' +
    '  out.hoverVideoCount = document.querySelectorAll("[data-map-hover] video").length;' +
    '  out.hoverStreamRow = !!document.querySelector("[data-map-hover-stream]");' +
    '  out.hoverAlarmRow = document.querySelector("[data-map-hover-alarm]")' +
    '    ? document.querySelector("[data-map-hover-alarm]").getAttribute("data-map-hover-alarm") : null;' +
    '  marker.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));' +
    '  await wait(200);' +
    '  out.hoverClosed = !document.querySelector("[data-map-hover]");' +
    /*
     * 第 11 批第 4 条：**图例已经删掉**（它那三个计数搬进了右上角的状态栏）。
     * 这里改成读状态栏那五个读数 —— 这一台声呐是探针自己加进去、并且录了点位的，
     * 所以"图上 N 台"至少要把它算进去。
     */
    '  out.statusItems = [...document.querySelectorAll("[data-map-statusbar] span")]' +
    '    .map((el) => (el.textContent || "").replace(/\\s+/g, " ").trim());' +
    '  const sync = document.querySelector("[data-action=map-sync]");' +
    '  if (!sync) return JSON.stringify({ ok: false, reason: "no-map-sync", steps: out.steps });' +
    '  sync.click(); await wait(4000);' +
    '  out.syncOutcomeText = text(document.querySelector("[data-map-sync-outcome]")).slice(0, 200);' +
    '  const alarmButton = document.querySelector("[data-alarm-id]");' +
    '  if (!alarmButton) return JSON.stringify({ ok: false, reason: "no-alarm-row", steps: out.steps,' +
    '    syncOutcomeText: out.syncOutcomeText });' +
    '  out.alarmBadge = text(alarmButton.querySelector(".badge"));' +
    '  alarmButton.click(); await wait(2500);' +
    '  const images = [...document.querySelectorAll("[data-map-snapshots] img")];' +
    '  out.snapshotImages = images.length;' +
    '  out.imagesDecoded = images.filter((img) => img.naturalWidth > 0).length;' +
    '  out.imageWidths = images.map((img) => img.naturalWidth);' +
    '  out.imageSrcLoopback = images.every((img) => img.src.indexOf("http://127.0.0.1:") === 0);' +
    '  out.snapshotNotCaptured = !!document.querySelector("[data-snapshot-not-captured]");' +
    '  out.snapshotFilesGone = !!document.querySelector("[data-snapshot-files-gone]");' +
    '  out.steps.push("done");' +
    '  return JSON.stringify(Object.assign({ ok: true }, out));' +
    '} catch (error) {' +
    '  return JSON.stringify({ ok: false, reason: "threw",' +
    '    message: String((error && error.message) || error), steps: out.steps });' +
    '}' +
    '})()')
    .replace(/__SONAR_PORT__/g, String(mockSonar.port))

  const sonarFlow = await layout('/devices', sonarScript, 120_000)
  log('air sonar flow : ' + JSON.stringify(sonarFlow))

  if (!sonarFlow.ok) {
    problems.push('空气声呐（PTZ + 点位图 + 抓图）流程没有走通：' + JSON.stringify(sonarFlow))
  } else {
    // ① 页签：**只有**「PTZ 联动」这一个（2023 版那一组不许在）。
    if (JSON.stringify(sonarFlow.tabs) !== JSON.stringify(['PTZ 联动'])) {
      problems.push('空气声呐的页签不是只有 PTZ 联动：' + JSON.stringify(sonarFlow.tabs))
    }
    // 代次在**添加设备时**就落库（界面才能同步地选出这一组页签）。
    if (sonarFlow.e2Variant !== 'airSonar') {
      problems.push('空气声呐的代次没有落库：' + JSON.stringify(sonarFlow.e2Variant))
    }
    // 读回来的是**设备当前的值**（`/system` 里那一组）。
    const fields = Object.fromEntries((sonarFlow.ptzFields || []).map((f) => [f.key, f.value]))
    if (fields.cameraIp !== '192.168.2.64' || fields.cameraUser !== 'admin') {
      problems.push('PTZ 面板没有显示设备当前的值：' + JSON.stringify(fields))
    }
    if (fields.cameraPassword !== '') {
      problems.push('PTZ 面板把球机口令回显到了输入框里：' + JSON.stringify(fields.cameraPassword))
    }
    // ② 保存：读回核对说"全部生效"，并且界面上那个框现在显示的是**设备读回来的值**。
    if (sonarFlow.ptzAllApplied !== true) {
      problems.push('PTZ 保存之后读回核对没有全部生效：' + JSON.stringify(sonarFlow.ptzChecks))
    }
    if (sonarFlow.portAfter !== '8082') {
      problems.push('PTZ 保存之后界面没有刷新成设备读回的值：' + JSON.stringify(sonarFlow.portAfter))
    }
    if (mockSonar.params.cam_port !== 8082) {
      problems.push('PTZ 保存没有真的写进设备：cam_port = ' + JSON.stringify(mockSonar.params.cam_port))
    }
    // 整份回写：没动的那几项一个都不许变。
    if (mockSonar.params.db_limit !== 60 || mockSonar.params.cam_user !== 'admin' ||
        mockSonar.params.cam_pass !== 'AP1_lfxs_2025') {
      problems.push('PTZ 写回把别的参数改坏了：' + JSON.stringify(mockSonar.params))
    }
    // ③ 点位图：有点位就有标记，点标记能选中这一台。
    if (sonarFlow.markers < 1) problems.push('点位图上没有出现任何标记')
    if (String(sonarFlow.sideName || '').indexOf('探针声呐') < 0) {
      problems.push('点位图上点标记之后右侧显示的不是这一台：' + JSON.stringify(sonarFlow.sideName))
    }
    // ③b 落点配色（第 14 条）：这一台真的画在图上，所以它的色调是可读的。
    if (!['alarm', 'online', 'offline'].includes(String(sonarFlow.markerTone))) {
      problems.push('这一台的落点色调不在三档里：' + JSON.stringify(sonarFlow.markerTone))
    }
    // ③c 悬停浮层（第 16 条，声纹设备）：基本信息要在，而且**不许有 `<video>`**。
    if (sonarFlow.hoverPresent !== true) {
      problems.push('悬停一个标记之后没有出现浮层（第 16 条）')
    } else {
      if (String(sonarFlow.hoverText || '').indexOf('探针声呐') < 0) {
        problems.push('浮层里没有这一台的设备名：' + JSON.stringify(sonarFlow.hoverText))
      }
      if (sonarFlow.hoverVideoCount > 0) {
        problems.push(
          '浮层里出现了 <video>（' + sonarFlow.hoverVideoCount + ' 个）：一条相机会话只有一个观看者，' +
          '悬停接管会踢掉正在看的人'
        )
      }
      // 声纹设备**不该**有"当前视频流"那一行（第 15 条那一行是相机的）。
      if (sonarFlow.hoverStreamRow === true) {
        problems.push('声纹设备的浮层里出现了"当前视频流"那一行（它没有视频流）')
      }
      if (sonarFlow.hoverAlarmRow === null) {
        problems.push('浮层里没有未确认告警那一行')
      }
    }
    if (sonarFlow.hoverClosed !== true) {
      problems.push('鼠标移开之后浮层没有关掉')
    }
    {
      /*
       * 第 11 批第 4 条之后这里读的是**状态栏**（图例已删）：五个读数都在，
       * 而且"图上 N 台"这一台声呐探针自己刚录了点位 —— 它必须至少被数到一次。
       */
      const items = sonarFlow.statusItems || []
      if (items.length !== 5) {
        problems.push('地图状态栏的读数不是五个：' + JSON.stringify(items))
      }
      const mapped = Number(((items[0] || '').match(/(\d+)/) || [])[1])
      if (!Number.isFinite(mapped) || mapped < 1) {
        problems.push('状态栏「图上 N 台」没有把这台录了点位的设备数进去：' + JSON.stringify(items))
      }
      if (Number.isFinite(mapped) && mapped !== sonarFlow.markerCount) {
        problems.push(
          '状态栏「图上 N 台」与图上落点数对不上：' + mapped + ' vs ' + sonarFlow.markerCount
        )
      }
    }
    // ④ 抓图：3 张真的解码出来了（CSP + 回环端点 + 目录落库整条链）。
    if (sonarFlow.alarmBadge !== '有抓图') {
      problems.push('同步之后这条告警没有显示"有抓图"：' + JSON.stringify(sonarFlow.alarmBadge))
    }
    if (sonarFlow.snapshotImages !== 3) {
      problems.push('抓图不是 3 张：' + JSON.stringify(sonarFlow.snapshotImages))
    }
    if (sonarFlow.imagesDecoded !== sonarFlow.snapshotImages) {
      problems.push(
        '抓图没有全部解码（CSP 或回环端点有问题）：' + JSON.stringify(sonarFlow.imageWidths)
      )
    }
    if (sonarFlow.imageSrcLoopback !== true) {
      problems.push('抓图的地址不是本机回环地址：' + JSON.stringify(sonarFlow.imageSrcLoopback))
    }
    if (sonarFlow.snapshotNotCaptured || sonarFlow.snapshotFilesGone) {
      problems.push('抓图显示了"没有图/文件不在" —— 而假设备明明回了 3 张 jpg')
    }
  }

  /*
   * 空气声呐**不该问 `/workmode`**（那一代没有工作模式这个概念）：问了就是"按错的代次取端点"，
   * 而 404 会被读成"设备没数据"。这条断言同时钉住"变体判定真的在起作用"。
   */
  if (mockSonar.requests.some((request) => request.path === '/workmode')) {
    problems.push('空气声呐问了 `/workmode`（这一代没有这个端点）')
  }
  if (mockSonar.params.cam_port === 8082 && mockSonar.requests.filter((r) => r.method === 'PUT').length === 0) {
    problems.push('PTZ 保存没有向设备发过 PUT')
  }



  await mockSonar.close()

  if (!e2Logins.some((entry) => entry.digestStyle === 'salted')) {
    problems.push('登录没有先用加盐摘要（手册的写法）：' + JSON.stringify(e2Logins.map((e) => e.digestStyle)))
  }
  if (e2Authed.length < 4) {
    // 登录之后至少要问：/system（判变体）、/workmode、/alarm_log_all、/alarm_files。
    problems.push('带 token 的请求太少，链条没走全：' + e2Authed.length + '（' + JSON.stringify(e2Paths) + '）')
  }
  if (!e2Paths.includes('GET /alarm_log_all')) {
    problems.push('没有向设备查告警日志（/alarm_log_all）：' + JSON.stringify(e2Paths))
  }
  if (e2Files.length === 0) {
    problems.push('没有下载告警文件（/alarm_files）')
  }
  for (const entry of e2Files) {
    // 手册明确要求 `file_path` 带 `saving_path`（缺了目录，设备只会回 404）。
    if (!entry.filePath || !entry.filePath.includes('alarm/2026-09-17')) {
      problems.push('下载用的 file_path 没有带上 saving_path：' + JSON.stringify(entry.filePath))
    }
  }

  await mockE2.close()

  /*
   * 上面这一段是**写操作**（它往库里加一台设备、下一份录音），所以它排在所有只读探针
   * 之后 —— 探针之间不该互相影响：第一版把它插在添加设备对话框那一条后面，结果是后面
   * 的相机探针在设备下拉里只看到这一台新设备，报了一个"切不到相机"的假失败。
   */

  /**
   * 事件中心的**处置闭环**（规格 §2.2 / §15.1，Phase 5）。
   *
   * 这是**写探针**（它改一条事件的状态、写 `event_status` 与 `event_activity`），
   * 所以和上面那两条一样排在**所有只读探针之后**：只读探针看的是"操作员库原样"，
   * 一条事件的状态被改过之后，抽屉里那一段的结构断言就不再落在同一个起点上。
   *
   * 写的是**一次性 profile 里那份副本**，操作员的真库不受影响。
   *
   * 断言分三层，缺一不可：
   *   1. 界面**真的点了**（按钮存在、点的是主 CTA）；
   *   2. 服务端**真的写进去了**（直接 `eventCenter.query` 读回那一条的状态：这是"读完写回"）；
   *   3. 界面**跟着变了**（抽屉不关、状态文字变了、处置记录里出现"谁在什么时候改的"）。
   */
  const eventsHandling = await layout('/events', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").trim() : "");' +
    'const out = { ok: false };' +
    /*
     * 先**绕一圈再回来**：`layout()` 只是设置 hash，如果上一条探针已经停在 `/events`，
     * 重新设同一个 hash **不会重新挂载**，于是这里会继承上一条留下的状态（实测：上一条清完
     * 筛选后队列是空的，于是这一条报 `no-rows`，而真相是"根本没重新查"）。
     */
    'location.hash = "#/alarms";' +
    'await sleep(1200);' +
    'location.hash = "#/events";' +
    'await sleep(1200);' +
    'for (let i = 0; i < 60 && !document.querySelector(".alert-row"); i += 1) await sleep(500);' +
    /*
     * 把聚合窗口切到「不聚合」：同设备的多条告警各自成行，**建议卡**（§13.2 的
     * "同设备上还有别的告警"）才有机会出现。聚合开着的时候，一台设备的多条触发本来就是
     * 一行（×N），相关性那一组里当然没有别人。
     *
     * 记下原值，跑完恢复：这一段是写探针，但它改的这个偏好（localStorage + 地址栏）
     * 属于"顺手改的界面状态"，没有理由留给后面。
     */
    'const groupSelect = document.querySelector("[data-field=group-window]");' +
    'out.groupWindowBefore = groupSelect ? groupSelect.value : null;' +
    'if (groupSelect) {' +
    '  groupSelect.value = "off";' +
    '  groupSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(3000);' +
    '}' +
    /*
     * 挑一条**同一台设备上还有别的告警**的行：建议卡的判据就是这个。页面上一条都没有
     * （每台设备只有一条）时退回第一行，并把"没量到建议卡"如实记进报告 ——
     * 那是"没量到"，不是"量到不合格"。
     */
    'const allRows = Array.prototype.slice.call(document.querySelectorAll(".alert-row"));' +
    'const deviceNames = allRows.map((r) => {' +
    '  const el = r.querySelector(".alert-row__device");' +
    '  return el ? (el.textContent || "").trim() : "";' +
    '});' +
    'const counts = {};' +
    'for (const name of deviceNames) if (name) counts[name] = (counts[name] || 0) + 1;' +
    'const repeated = Object.keys(counts).find((name) => counts[name] >= 2) || null;' +
    /*
     * **优先**挑一台"恰好 2 条"的设备：只有这时才能量到"阈值可调"这件事本身
     * （阈值 2 给建议、调到 10 就不给）。没有这种设备时退回"≥2 条"的那种，
     * 阈值翻转那一段如实记成"没量到"。
     */
    'const exactlyTwo = Object.keys(counts).find((name) => counts[name] === 2) || null;' +
    'const picked = exactlyTwo || repeated;' +
    'out.queueRows = allRows.length;' +
    'out.repeatedDevice = repeated;' +
    'out.pickedDevice = picked;' +
    'out.pickedDeviceRows = picked ? counts[picked] : 0;' +
    'const row = picked ? allRows[deviceNames.indexOf(picked)] : allRows[0];' +
    'if (!row) {' +
    /*
     * 空队列时**直接问一次主进程**：这样能分开两种完全不同的故障 ——
     * "查询真的返回 0 条"（数据/过滤的问题）与"查询返回了但界面没画"（渲染/store 的问题）。
     */
    '  const direct = await window.api.eventCenter.query({ limit: 50, offset: 0 });' +
    '  return JSON.stringify({' +
    '    ok: false, reason: "no-rows",' +
    '    directOk: direct && direct.success === true,' +
    '    directItems: direct && direct.success ? direct.data.items.length : null,' +
    '    directTotal: direct && direct.success ? direct.data.total : null,' +
    '    directCounts: direct && direct.success ? direct.data.countsBySource : null,' +
    '    bodyHead: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 200),' +
    '    errorText: text(document.querySelector(".page .alert--danger")),' +
    '    summary: text(document.querySelector(".pager .muted")),' +
    '    kpi: !!document.querySelector(".kpi-strip")' +
    '  });' +
    '}' +
    'row.click();' +
    'await sleep(800);' +
    'const drawer = document.querySelector(".drawer");' +
    'if (!drawer) return JSON.stringify({ ok: false, reason: "no-drawer" });' +
    'const primary = drawer.querySelector("[data-action=status-primary]");' +
    'out.action = primary ? primary.getAttribute("data-status-action") : null;' +
    'out.entryId = text(document.querySelector(".drawer .drawer__grid .drawer__field--wide .drawer__value"));' +
    // 先记下"改之前"的状态：只读地读一次 IPC（不改任何东西）。
    'const beforeQuery = await window.api.eventCenter.query({ limit: 50, offset: 0 });' +
    'const beforeItems = beforeQuery && beforeQuery.success ? beforeQuery.data.items : [];' +
    'const beforeFirst = beforeItems.find((item) => item.id === out.entryId);' +
    'out.statusBefore = beforeFirst ? (beforeFirst.status || "(none)") : "(missing)";' +
    'if (!primary) return JSON.stringify(Object.assign(out, { reason: "no-primary" }));' +
    'primary.click();' +
    'await sleep(2500);' +
    'out.formShown = !!document.querySelector(".drawer [data-action=status-form]");' +
    'if (out.formShown) {' +
    '  const confirm = document.querySelector(".drawer [data-action=status-confirm]");' +
    '  const note = document.querySelector(".drawer [data-field=note]");' +
    '  if (note) { note.value = "探针：重新开启的原因"; note.dispatchEvent(new Event("input", { bubbles: true })); }' +
    '  if (confirm) confirm.click();' +
    '  await sleep(2500);' +
    '}' +
    // ② 读回：直接问主进程"这一条现在是什么状态"。
    'const afterQuery = await window.api.eventCenter.query({ limit: 50, offset: 0 });' +
    'const afterItems = afterQuery && afterQuery.success ? afterQuery.data.items : [];' +
    'const afterFirst = afterItems.find((item) => item.id === out.entryId);' +
    'out.statusAfter = afterFirst ? (afterFirst.status || "(none)") : "(missing)";' +
    // ③ 处置记录：写进去的那一条要能读回来（谁、什么时候、从什么到什么）。
    'const activity = await window.api.eventCenter.activity(out.entryId);' +
    'const rows = activity && activity.success ? activity.data : [];' +
    'out.activityCount = rows.length;' +
    'out.activityKind = rows.length > 0 ? rows[0].kind : null;' +
    'out.activityActor = rows.length > 0 ? rows[0].actor : null;' +
    'out.activityTo = rows.length > 0 ? rows[0].toStatus : null;' +
    'out.notice = text(document.querySelector(".page .alert--success"));' +
    'out.drawerStillOpen = !!document.querySelector(".drawer");' +
    // 界面上状态文字也跟着变了吗（Overview 的「状态」那一格）。
    'const activityTab = document.querySelector(".drawer [data-tab=activity]");' +
    'if (activityTab) { activityTab.click(); await sleep(600); }' +
    'out.activityRows = document.querySelectorAll(".drawer [data-panel=activity] .activity__row").length;' +
    'out.activityText = text(document.querySelector(".drawer [data-panel=activity] .activity__row"));' +
    /*
     * ④ Incident（规格 §14.2 的 V1）：人工建一个 → 读回 → 从界面解除关联 → 再读回。
     *
     * 四步都要走**真实界面**：切到「关联」页签 → 点 [创建 Incident] → 在对话框里改标题 →
     * 点提交；然后直接用 `eventCenter.incidentsForAlert` 读回（"写完读回"是业主的硬规矩，
     * 界面上的那一行只能证明"画出来了"，证明不了"库里真的有"）。
     */
    'const relatedTab = document.querySelector(".drawer [data-tab=related]");' +
    'if (relatedTab) { relatedTab.click(); await sleep(600); }' +
    'out.incidentPanelPresent = !!document.querySelector(".drawer [data-panel=incident]");' +
    'out.incidentSuggestion = !!document.querySelector(".drawer [data-incident-suggestion]");' +
    /*
     * 建议阈值是**可调的**（业主 2026-09-18）：量三件事 —— 下拉里有几个档位、
     * 改了会不会写回本机（localStorage）、以及"调高到不给建议、调回来又给"。
     * 最后那一条只在"同设备恰好 2 条"时才成立（阈值 2 给、10 不给），
     * 数据形状不允许时如实记"没量到"。
     */
    'const thresholdSelect = document.querySelector("[data-field=incident-threshold]");' +
    'out.thresholdOptions = thresholdSelect ? thresholdSelect.options.length : 0;' +
    'out.thresholdBefore = thresholdSelect ? thresholdSelect.value : null;' +
    'if (thresholdSelect && out.pickedDeviceRows === 2) {' +
    '  out.thresholdFlipTested = true;' +
    '  thresholdSelect.value = "10";' +
    '  thresholdSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(800);' +
    '  out.storedThreshold = window.localStorage.getItem("hertzinno.eventCenter.incidentThreshold");' +
    '  out.cardAtHighThreshold = !!document.querySelector(".drawer [data-incident-suggestion]");' +
    '  out.belowNoticeShown = !!document.querySelector(".drawer [data-incident-below-threshold]");' +
    '  thresholdSelect.value = out.thresholdBefore || "2";' +
    '  thresholdSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(800);' +
    '  out.cardAtLowThreshold = !!document.querySelector(".drawer [data-incident-suggestion]");' +
    '  out.thresholdRestored = window.localStorage.getItem("hertzinno.eventCenter.incidentThreshold");' +
    '} else if (thresholdSelect) {' +
    '  out.thresholdFlipTested = false;' +
    '  thresholdSelect.value = "10";' +
    '  thresholdSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(600);' +
    '  out.storedThreshold = window.localStorage.getItem("hertzinno.eventCenter.incidentThreshold");' +
    '  thresholdSelect.value = out.thresholdBefore || "2";' +
    '  thresholdSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(600);' +
    '  out.thresholdRestored = window.localStorage.getItem("hertzinno.eventCenter.incidentThreshold");' +
    '}' +
    'const linkedBefore = await window.api.eventCenter.incidentsForAlert(out.entryId);' +
    'out.incidentsBefore = linkedBefore && linkedBefore.success ? linkedBefore.data.length : -1;' +
    'const createBtn = document.querySelector(".drawer [data-action=incident-create]");' +
    'if (createBtn) {' +
    '  createBtn.click();' +
    '  await sleep(700);' +
    '  const dialog = document.querySelector(".overlay [role=dialog]");' +
    '  out.incidentDialogOpen = !!dialog;' +
    '  const titleInput = document.querySelector("[data-field=incident-title]");' +
    '  const candidates = document.querySelectorAll("[data-field=incident-candidate]");' +
    '  const checked = document.querySelectorAll("[data-field=incident-candidate]:checked");' +
    '  out.incidentCandidates = candidates.length;' +
    '  out.incidentCandidatesChecked = checked.length;' +
    '  out.incidentSuggestedTitle = titleInput ? titleInput.value : null;' +
    '  if (titleInput) {' +
    '    titleInput.value = "探针：T03 异常情况";' +
    '    titleInput.dispatchEvent(new Event("input", { bubbles: true }));' +
    '  }' +
    '  const submit = document.querySelector("[data-action=incident-submit]");' +
    '  if (submit) { submit.click(); await sleep(2000); }' +
    '  out.incidentDialogClosedAfterSubmit = !document.querySelector(".overlay [role=dialog]");' +
    '}' +
    'const linkedAfter = await window.api.eventCenter.incidentsForAlert(out.entryId);' +
    'const afterList = linkedAfter && linkedAfter.success ? linkedAfter.data : [];' +
    'out.incidentsAfter = afterList.length;' +
    'out.incidentTitleInDb = afterList.length > 0 ? afterList[0].title : null;' +
    'out.incidentCreatedBy = afterList.length > 0 ? afterList[0].createdBy : null;' +
    'out.incidentAlertCount = afterList.length > 0 ? afterList[0].alertCount : null;' +
    'out.incidentRowsInPanel = document.querySelectorAll(".drawer [data-incident-linked] .incident-row").length;' +
    'out.incidentNoticeText = text(document.querySelector(".drawer [data-incident-notice]"));' +
    // 解除关联：点那一行上的按钮，再读回一次（库里那一行必须真的没了）。
    'const unlinkBtn = document.querySelector(".drawer [data-action=incident-unlink]");' +
    'out.incidentUnlinkButton = !!unlinkBtn;' +
    'if (unlinkBtn) { unlinkBtn.click(); await sleep(1800); }' +
    'const linkedFinal = await window.api.eventCenter.incidentsForAlert(out.entryId);' +
    'out.incidentsFinal = linkedFinal && linkedFinal.success ? linkedFinal.data.length : -1;' +
    'out.incidentRowsAfterUnlink = document.querySelectorAll(".drawer [data-incident-linked] .incident-row").length;' +
    /*
     * 「未到阈值」那句话：切到一条**独占一台设备**的告警（同设备其它告警 0 条 < 阈值 2），
     * 这一段里应当没有建议卡、而是那一句说明。空白与"软件没做这件事"看起来一模一样，
     * 所以这一条也要量（业主对界面的硬要求）。
     */
    'const singleIndex = deviceNames.findIndex((name) => name && counts[name] === 1);' +
    'out.singleDeviceRow = singleIndex >= 0;' +
    'if (singleIndex >= 0) {' +
    '  allRows[singleIndex].click();' +
    '  await sleep(1200);' +
    '  const relatedTab2 = document.querySelector(".drawer [data-tab=related]");' +
    '  if (relatedTab2) { relatedTab2.click(); await sleep(500); }' +
    '  out.cardForSingleDevice = !!document.querySelector(".drawer [data-incident-suggestion]");' +
    '  out.belowNoticeForSingle = !!document.querySelector(".drawer [data-incident-below-threshold]");' +
    '  out.belowNoticeText = (() => {' +
    '    const el = document.querySelector(".drawer [data-incident-below-threshold]");' +
    '    return el ? (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) : null;' +
    '  })();' +
    '}' +
    // 恢复聚合窗口（见上面：这一段顺手改过它）。
    'const restoreSelect = document.querySelector("[data-field=group-window]");' +
    'if (restoreSelect && out.groupWindowBefore !== null) {' +
    '  restoreSelect.value = out.groupWindowBefore;' +
    '  restoreSelect.dispatchEvent(new Event("change", { bubbles: true }));' +
    '  await sleep(800);' +
    '}' +
    'out.ok = true;' +
    'return JSON.stringify(out);' +
    '})()', 120_000)
  log('events handling: ' + JSON.stringify(eventsHandling))
  if (!eventsHandling.ok) {
    problems.push('事件中心的处置闭环没有走通：' + JSON.stringify(eventsHandling))
  } else {
    if (eventsHandling.action === null) {
      problems.push('抽屉头部没有可点的主 CTA（拿不到 data-status-action）')
    }
    if (String(eventsHandling.entryId).trim() === '') {
      problems.push('没能在抽屉里拿到这条事件的标识（Overview 的长字段）')
    }
    if (eventsHandling.statusAfter === eventsHandling.statusBefore) {
      problems.push(
        '点了主 CTA 之后状态没有变（写没落库？）：' + eventsHandling.statusBefore + ' → ' + eventsHandling.statusAfter
      )
    }
    if (!(eventsHandling.activityCount >= 1)) {
      problems.push('处置之后没有产生任何处置记录：' + JSON.stringify(eventsHandling))
    }
    if (eventsHandling.activityActor !== 'admin') {
      problems.push('处置记录里的操作者不是当前会话（admin）：' + JSON.stringify(eventsHandling.activityActor))
    }
    if (eventsHandling.drawerStillOpen !== true) {
      problems.push('处置之后抽屉被关掉了（规格 §15.1：不关 Drawer）')
    }
    if (!(eventsHandling.activityRows >= 1)) {
      problems.push('界面上的处置记录页签里没有那一行：' + JSON.stringify(eventsHandling))
    }
    // ④ Incident（规格 §14.2 的 V1）：面板在、建议卡在、建得出来、库里读得到、解除得掉。
    if (!eventsHandling.incidentPanelPresent) {
      problems.push('抽屉的「关联」页签里没有 Incident 那一段：' + JSON.stringify(eventsHandling))
    }
    /*
     * 建议卡（规格 §13.2）：同设备上还有别的告警时必须出现。探针为此先把聚合关掉，
     * 让同设备的多条告警各自成行；页面上确实找不到"同设备两条"时如实记"没量到"。
     */
    if (eventsHandling.repeatedDevice && !eventsHandling.incidentSuggestion) {
      problems.push(
        '同一台设备（' + eventsHandling.repeatedDevice + '）在队列里有 2 条以上告警，' +
          '却没有出现「可能相关的 Incident」建议卡：' + JSON.stringify(eventsHandling)
      )
    }
    if (!eventsHandling.repeatedDevice) {
      log(
        '（建议卡没量到：这一页 ' + eventsHandling.queueRows +
          ' 行里没有两台以上同设备的告警 —— 不是缺陷，是这一次的数据形状）'
      )
    }
    // 建议阈值可调（业主 2026-09-18）：下拉在、写回本机、调高调低真的改变建议。
    if (!(eventsHandling.thresholdOptions >= 2)) {
      problems.push(
        '建议阈值不是一个可选的下拉（选项 ' + eventsHandling.thresholdOptions + ' 个）：' +
          JSON.stringify(eventsHandling)
      )
    }
    if (eventsHandling.storedThreshold !== '10') {
      problems.push(
        '改了建议阈值没有写回本机（localStorage 里是 ' +
          JSON.stringify(eventsHandling.storedThreshold) + '）'
      )
    }
    if (eventsHandling.thresholdRestored !== eventsHandling.thresholdBefore) {
      problems.push(
        '阈值没有恢复到原值：原来 ' + JSON.stringify(eventsHandling.thresholdBefore) +
          '，现在 ' + JSON.stringify(eventsHandling.thresholdRestored)
      )
    }
    if (eventsHandling.thresholdFlipTested) {
      if (eventsHandling.cardAtHighThreshold) {
        problems.push('阈值调到 10 之后建议卡还在（阈值没生效）：' + JSON.stringify(eventsHandling))
      }
      if (!eventsHandling.belowNoticeShown) {
        problems.push('没给建议时也没有说一句"未到阈值"（那一段会是空白）')
      }
      if (!eventsHandling.cardAtLowThreshold) {
        problems.push('阈值调回 2 之后建议卡没有回来：' + JSON.stringify(eventsHandling))
      }
    } else {
      log(
        '（阈值翻转没量到：这一页没有"同设备恰好 2 条"的设备（挑中的是 ' +
          JSON.stringify(eventsHandling.pickedDevice) + '，' + eventsHandling.pickedDeviceRows +
          ' 条）—— 不是缺陷，是这一次的数据形状）'
      )
    }
    // 「未到阈值」那一句：独占一台设备的告警上，不给建议卡、而是说一句为什么。
    if (!eventsHandling.singleDeviceRow) {
      log('（"未到阈值"那句没量到：这一页没有独占一台设备的告警 —— 不是缺陷，是数据形状）')
    } else {
      if (eventsHandling.cardForSingleDevice) {
        problems.push(
          '一条独占一台设备的告警也弹了建议卡（阈值 2 时它不该有建议）：' +
            JSON.stringify(eventsHandling)
        )
      }
      if (!eventsHandling.belowNoticeForSingle) {
        problems.push('没给建议时那一段是空白的（没有说"未到阈值"）：' + JSON.stringify(eventsHandling))
      }
      if (!String(eventsHandling.belowNoticeText || '').includes('阈值')) {
        problems.push(
          '"未到阈值"那句没有说清阈值这件事：' + JSON.stringify(eventsHandling.belowNoticeText)
        )
      }
    }
    if (!eventsHandling.incidentDialogOpen) {
      problems.push('点 [创建 Incident] 没有打开对话框：' + JSON.stringify(eventsHandling))
    }
    if (!(eventsHandling.incidentCandidates >= 1)) {
      problems.push(
        '对话框里的候选告警一条都没有（当前这条至少要在里面）：' +
          JSON.stringify(eventsHandling.incidentCandidates)
      )
    }
    if (!(eventsHandling.incidentCandidatesChecked >= 1)) {
      problems.push('候选告警默认没有勾上（建议卡的本意就是"默认带上这几条"）')
    }
    if (!eventsHandling.incidentSuggestedTitle) {
      problems.push('对话框的标题没有预填建议（设备名 + 异常情况）')
    }
    if (eventsHandling.incidentsBefore !== 0) {
      problems.push(
        '写探针开始前这一条就已经有 Incident 了（起点不干净）：' + eventsHandling.incidentsBefore
      )
    }
    if (!(eventsHandling.incidentsAfter >= 1)) {
      problems.push(
        '建完之后 `incidentsForAlert` 读回 0 条 —— 界面上创建了、库里没有：' +
          JSON.stringify(eventsHandling)
      )
    }
    if (eventsHandling.incidentTitleInDb !== '探针：T03 异常情况') {
      problems.push('库里那一条的标题不是探针写进去的：' + JSON.stringify(eventsHandling.incidentTitleInDb))
    }
    if (eventsHandling.incidentCreatedBy !== 'admin') {
      problems.push('Incident 的创建人不是当前会话（admin）：' + JSON.stringify(eventsHandling.incidentCreatedBy))
    }
    if (!(eventsHandling.incidentAlertCount >= 1)) {
      problems.push('Incident 的关联条数是 0（一条告警都没挂上）：' + JSON.stringify(eventsHandling))
    }
    if (!(eventsHandling.incidentRowsInPanel >= 1)) {
      problems.push('建完之后抽屉「关联」页签里没有列出那个 Incident：' + JSON.stringify(eventsHandling))
    }
    if (!eventsHandling.incidentNoticeText) {
      problems.push('建完之后界面没有回执（写完了却什么都没说）')
    }
    if (!eventsHandling.incidentUnlinkButton) {
      problems.push('已关联的 Incident 那一行上没有「解除关联」按钮')
    }
    if (eventsHandling.incidentsFinal !== 0) {
      problems.push(
        '解除关联之后库里还有 ' + eventsHandling.incidentsFinal + ' 条 —— 解除没落库：' +
          JSON.stringify(eventsHandling)
      )
    }
    if (eventsHandling.incidentRowsAfterUnlink !== 0) {
      problems.push('解除关联之后界面上仍然列着那个 Incident')
    }
    if (!eventsHandling.incidentDialogClosedAfterSubmit) {
      problems.push('提交之后对话框没有关掉')
    }
  }
  /**
   * 相机墙空白格上的「+」：点它必须弹出一个**贴在被点那一格旁边**的相机选择器。
   *
   * 为什么会有这一条（业主 2026-09-18 报的 bug：「点击添加视频通道，弹出请选择相机，
   * 但是好像位置被覆盖了，没有显示出来」）：
   * 修之前那个选择器是原生 `<select>`，挂在整面墙末尾的 `.visually-hidden` 宿主里
   * （1×1、`clip: rect(0 0 0 0)`），靠 `showPicker()` 打开。原生下拉贴在**宿主那个
   * 1×1 的盒子**上，而那个盒子在页面左上区 —— 实测（1440×900）宿主在
   * `{left:273, top:97}`，被点的那一格在 `{left:834, top:148, right:1389, bottom:460}`，
   * 两者相距 **561px**，清单于是弹在操作员没在看的地方（压在别的方块上）。
   *
   * 所以这里量的是**几何**，不是「元素存在」：
   *   legacyHiddenHost            旧实现的那个 1×1 隐藏宿主必须不在了
   *   menuInsideViewport          浮层整个落在视口里（报告里「没有显示出来」那件事）
   *   menuOnTop                   浮层中心点上的最上层元素属于浮层自己（「被覆盖」）
   *   menuVerticalGapPx           浮层贴着那一格：下面放不下时翻到上面，间隙同样很小
   *   menuHorizontallyOverlapsCell 浮层在水平方向对着那一格
   *   itemsBeforeFree             清单里的相机名（`optionsForCell()` 的产物）
   *   emptyLabelText              清单为空时必须说一句短状态词，而不是画一块空浮层
   *   closedByEsc                 键盘能关掉，而且关掉**不改**那一格
   *   pickItems / placedName      腾出一台相机之后→选中它→那一格显示它的名字（写要读回）
   *
   * 为什么中间要「腾出一台相机」：操作员库里只有**一台**相机，而总览页的自动起播会先
   * 把它放进一格（`autoPlayOnce()` 的第一步），所以空白格能选的相机恰好是 0 台 ——
   * 这也正是他看到的「弹出请选择相机」那一行占位文字。要验证"选中"这条路，就得先通过
   * **真实的右键菜单**（「关闭这一格」）把它从格子里放回去。腾不出格子时这一段会如实
   * 报一条"没有被验证到"，而不是假装过了。
   *
   * 这一段最后离开总览页再回来，格子回到原来的样子 —— 探针自己写进去的那台相机由导航
   * 清掉（`CameraVideoWall` 卸载时 `clearAll()`），并且**读回**验证清干净了。
   *
   * 因为它有写（清空一格、把相机放进一格，可能触发一次自动起播），所以它和上面两条
   * 一样排在**所有只读探针之后**。
   */
  const cameraPicker = await layout('/', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = {};' +
    'const textOf = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : null);' +
    'const emptyCellsNow = () => Array.prototype.slice.call(document.querySelectorAll(".camera-wall__cell--empty"));' +
    'const addOf = (cell) => (cell ? cell.querySelector(".camera-wall__add") : null);' +
    'const host = document.querySelector(".camera-wall__pickers");' +
    'out.legacyHiddenHost = !!host;' +
    // 旧实现那个宿主的**绝对**位置：修之前原生下拉就贴在这个 1×1 的盒子上，
    // 而不是贴在操作员点的那一格上。两个矩形之间的距离就是"位置不对"的全部证据。
    'out.legacyHostRect = host ? (() => { const r = host.getBoundingClientRect(); return {' +
    '  left: Math.round(r.left), top: Math.round(r.top),' +
    '  width: Math.round(r.width), height: Math.round(r.height) }; })() : null;' +
    'out.emptyCells = emptyCellsNow().length;' +
    'out.addButtons = document.querySelectorAll(".camera-wall__add").length;' +
    'const firstCell = emptyCellsNow()[0];' +
    'const add = addOf(firstCell);' +
    'if (!add) return JSON.stringify(Object.assign(out, { reason: "no-empty-cell" }));' +
    'const cell = add.closest(".camera-wall__cell");' +
    'const cellRect = cell.getBoundingClientRect();' +
    'out.clickedCellRect = { left: Math.round(cellRect.left), top: Math.round(cellRect.top),' +
    '  right: Math.round(cellRect.right), bottom: Math.round(cellRect.bottom) };' +
    'out.legacyHostToCellPx = out.legacyHostRect' +
    '  ? Math.round(Math.max(' +
    '      Math.abs(out.legacyHostRect.left - cellRect.left),' +
    '      Math.abs(out.legacyHostRect.top - cellRect.top)))' +
    '  : null;' +
    'add.click();' +
    'await sleep(700);' +
    'const menu = document.querySelector("[data-camera-picker]");' +
    'out.menuPresent = !!menu;' +
    'if (!menu) {' +
    // 旧实现打开的是原生下拉：它**不是 DOM 节点**，探针量不到它落在哪里。
    // 能记下来的是另一件事实：`showPicker()` 需要**真实用户手势**，合成 .click() 没有
    // 那个手势，于是它抛异常、代码退回 `select.focus()` —— 焦点落在一个 1×1、被裁掉的
    // 隐藏 <select> 上（`focusedInstead` 就是这件事的证据）。真人点的那一次并不是这条
    // 路径：那时原生下拉真的会开，但它是贴在那个 1×1 宿主上的（`legacyHostRect`）。
    '  out.focusedInstead = document.activeElement' +
    '    ? (document.activeElement.id || document.activeElement.tagName) : null;' +
    '  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
    '  return JSON.stringify(Object.assign(out, { reason: "no-menu" }));' +
    '}' +
    'const rect = menu.getBoundingClientRect();' +
    'out.menuRect = { left: Math.round(rect.left), top: Math.round(rect.top),' +
    '  right: Math.round(rect.right), bottom: Math.round(rect.bottom),' +
    '  width: Math.round(rect.width), height: Math.round(rect.height) };' +
    'out.menuInsideViewport = rect.width > 0 && rect.height > 0 && rect.left >= 0 &&' +
    '  rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;' +
    'const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));' +
    'out.menuOnTop = !!(hit && menu.contains(hit));' +
    'out.menuVerticalGapPx = Math.round(rect.top >= cellRect.bottom' +
    '  ? rect.top - cellRect.bottom' +
    '  : (cellRect.top >= rect.bottom ? cellRect.top - rect.bottom : 0));' +
    'out.menuHorizontallyOverlapsCell = rect.right > cellRect.left && rect.left < cellRect.right;' +
    'out.menuFocused = menu.contains(document.activeElement);' +
    'const itemsOf = (el) => Array.prototype.slice.call(el.querySelectorAll("[data-camera-picker-item]"));' +
    'out.itemsBeforeFree = itemsOf(menu).map((b) => textOf(b));' +
    'out.emptyLabelText = textOf(menu.querySelector(".picker__empty"));' +
    'menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));' +
    'await sleep(400);' +
    'out.closedByEsc = !document.querySelector("[data-camera-picker]");' +
    'out.cellUnchangedAfterEsc = !!cell.querySelector(".camera-wall__add") && !cell.querySelector(".camera-wall__name");' +
    // ② 腾出一台相机：右键那一格 → 菜单里的「关闭这一格」（四个语言的写法都认）。
    'const occupied = Array.prototype.slice.call(document.querySelectorAll(".camera-wall__cell"))' +
    '  .find((c) => !c.classList.contains("camera-wall__cell--empty"));' +
    'out.occupiedCellFound = !!occupied;' +
    'if (occupied) {' +
    '  const r = occupied.getBoundingClientRect();' +
    '  occupied.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,' +
    '    clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 40) }));' +
    '  await sleep(600);' +
    '  const entries = Array.prototype.slice.call(document.querySelectorAll(".vmenu__item"));' +
    '  const closeLabels = ["关闭这一格", "Clear this cell", "Vaciar esta celda", "Bu hücreyi boşalt"];' +
    '  const closeItem = entries.find((b) => closeLabels.some((label) => (textOf(b) || "").indexOf(label) === 0));' +
    '  out.menuLabels = entries.map((b) => textOf(b));' +
    '  out.foundCloseItem = !!closeItem;' +
    '  if (closeItem) { closeItem.click(); await sleep(1200); }' +
    '}' +
    'out.emptyCellsAfterFree = emptyCellsNow().length;' +
    // ③ 现在有得选了：点 + → 清单里应当有那台相机 → 选它 → 读回那一格（写必须读回）。
    'const add2 = addOf(emptyCellsNow()[0]);' +
    'const targetCell = add2 ? add2.closest(".camera-wall__cell") : null;' +
    'out.reopened = !!add2;' +
    'if (add2) { add2.click(); await sleep(700); }' +
    'const openMenu = document.querySelector("[data-camera-picker]");' +
    'out.pickItems = openMenu ? itemsOf(openMenu).map((b) => textOf(b)) : [];' +
    'const item = openMenu ? openMenu.querySelector("[data-camera-picker-item]") : null;' +
    'out.firstItem = textOf(item);' +
    'if (item) { item.click(); await sleep(1800); }' +
    'out.placedName = targetCell ? textOf(targetCell.querySelector(".camera-wall__name")) : null;' +
    'out.cellStillEmptyAfterPick = targetCell' +
    '  ? targetCell.classList.contains("camera-wall__cell--empty") : null;' +
    'out.menuClosedAfterPick = !document.querySelector("[data-camera-picker]");' +
    // ④ 离开这一页再回来：探针自己写进去的那台相机必须已经被清掉。
    'location.hash = "#/devices";' +
    'await sleep(1300);' +
    'location.hash = "#/";' +
    'await sleep(1800);' +
    'out.emptyCellsAfterRestore = emptyCellsNow().length;' +
    'out.ok = true;' +
    'return JSON.stringify(out);' +
    '})()', 90_000)
  log('camera picker: ' + JSON.stringify(cameraPicker))
  if (cameraPicker.probeTimeout) {
    problems.push('相机选择器探针超时 —— 这一段没有任何结论')
  } else if (cameraPicker.reason === 'no-empty-cell') {
    problems.push(
      '总览页的相机墙上一个空白格都没有（相机台数 ≥ 档位）——「+ 添加视频通道」这条路没有被验证到：' +
        JSON.stringify(cameraPicker)
    )
  } else {
    if (cameraPicker.legacyHiddenHost) {
      problems.push(
        '相机选择器仍然挂在墙末尾的 1×1 隐藏宿主（.camera-wall__pickers）里，' +
          '原生下拉贴在那个盒子上、离操作员点的那一格有 ' + cameraPicker.legacyHostToCellPx + 'px：' +
          JSON.stringify({ host: cameraPicker.legacyHostRect, cell: cameraPicker.clickedCellRect })
      )
    }
    if (!cameraPicker.menuPresent) {
      problems.push('点空白格上的「+」没有弹出相机选择器（前端浮层不存在）：' + JSON.stringify(cameraPicker))
    } else {
      if (!cameraPicker.menuInsideViewport) {
        problems.push('相机选择器没有整个落在视口里（跑到窗口外面去了）：' + JSON.stringify(cameraPicker.menuRect))
      }
      if (!cameraPicker.menuOnTop) {
        problems.push('相机选择器被别的元素盖住了（中心点上最上层的不是它）：' + JSON.stringify(cameraPicker.menuRect))
      }
      if (!(cameraPicker.menuVerticalGapPx <= 16)) {
        problems.push(
          '相机选择器没有贴着被点的那一格（与那一格上下边的最小间隙 ' +
            cameraPicker.menuVerticalGapPx + 'px）：' + JSON.stringify(cameraPicker.menuRect)
        )
      }
      if (!cameraPicker.menuHorizontallyOverlapsCell) {
        problems.push('相机选择器在水平方向不对着被点的那一格：' + JSON.stringify(cameraPicker.menuRect))
      }
      if (!cameraPicker.menuFocused) {
        problems.push('相机选择器打开之后焦点没有进到浮层里（键盘用户选不了）')
      }
      // 清单为空时（库里只有一台相机、而它已经在墙上）必须有一句短状态词：
      // 一块空浮层与「还没渲染出来」看起来一模一样。
      if (
        (cameraPicker.itemsBeforeFree || []).length === 0 &&
        !String(cameraPicker.emptyLabelText || '').trim()
      ) {
        problems.push('相机选择器里一台可选的相机都没有，而且什么也没说（画了一块空浮层）')
      }
      if (cameraPicker.itemsBeforeFree.some((name) => !name)) {
        problems.push('相机选择器里有一项没有名字：' + JSON.stringify(cameraPicker.itemsBeforeFree))
      }
      if (!cameraPicker.closedByEsc) problems.push('Esc 没有关掉相机选择器')
      if (!cameraPicker.cellUnchangedAfterEsc) {
        problems.push('Esc 关掉相机选择器之后那一格被改了（取消不该有副作用）')
      }
      // ②③ 腾出一台相机 → 选中它 → 读回那一格。腾不出来就如实说"没验证到"。
      if (!cameraPicker.occupiedCellFound) {
        problems.push('墙上没有一台已经在格子里的相机 —— 空清单那一半没有被验证到')
      } else if (!cameraPicker.foundCloseItem) {
        problems.push(
          '右键菜单里找不到「关闭这一格」，探针没法腾出一台相机 —— ' +
            '"在清单里选中一台相机"这条路没有被验证到（菜单项：' +
            JSON.stringify(cameraPicker.menuLabels) + '）'
        )
      } else {
        if (!(cameraPicker.emptyCellsAfterFree === cameraPicker.emptyCells + 1)) {
          problems.push(
            '「关闭这一格」没有真的腾出格子：空格从 ' + cameraPicker.emptyCells +
              ' 变成 ' + cameraPicker.emptyCellsAfterFree + '（应当是 +1）'
          )
        }
        if (!cameraPicker.reopened) {
          problems.push('腾出一格之后那一格上没有「+」按钮')
        } else if (!(cameraPicker.pickItems || []).length) {
          problems.push(
            '腾出一台相机之后，选择器里仍然一台可选相机都没有（选项来源坏了）：' +
              JSON.stringify(cameraPicker.pickItems)
          )
        } else if (cameraPicker.placedName !== cameraPicker.firstItem) {
          problems.push(
            '选了相机之后那一格没有显示这台相机的名字（写没生效或没读回）：格子显示 ' +
              JSON.stringify(cameraPicker.placedName) + '，选的是 ' + JSON.stringify(cameraPicker.firstItem)
          )
        }
        if (cameraPicker.cellStillEmptyAfterPick === true) {
          problems.push('选了相机之后那一格仍然是空的')
        }
        if (!cameraPicker.menuClosedAfterPick) {
          problems.push('选完一台相机之后选择器没有关掉')
        }
      }
      if (cameraPicker.emptyCellsAfterRestore !== cameraPicker.emptyCells) {
        problems.push(
          '离开总览页再回来，格子没有回到原来的样子：探针写进去的相机没有被清掉（' +
            cameraPicker.emptyCellsAfterRestore + ' 个空格 vs 原来 ' + cameraPicker.emptyCells + ' 个）'
        )
      }
    }
  }

  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条）。
   *
   * **排在最后**：它是这一次运行里唯一一条会**写库 + 开监听端口**的探针（点开关、改端口、
   * 真推 HTTP / MQTT、把存储根换到一次性 profile 里的目录）。排在所有只读探针之后，
   * 是为了"读到的每个数字都是探针动手之前的样子"。
   */
  await runIotIngestDrill(win, layout)

  /**
   * 手填 RTSP 地址（业主 2026-09-19 第 3 条；**管理界面在第 11 批第 2 条搬到了实时监测页**）。
   *
   * 也排在最后：它会**在实时监测页新建一条源、到总览页把它放进一格、让主进程起一路 ffmpeg，
   * 再回实时监测页删掉它**。排在所有只读探针之后，读到的每个数字才是探针动手之前的样子。
   */
  await runManualRtspDrill(win, layout)

  /**
   * 四种视图（业主 2026-09-18 第 10 批第 2 条）。
   *
   * 也排在最后：它会往墙上放一台相机、切三次视图、再切回播放。
   * （"手填 RTSP 那一格只有一颗视图按钮"这一条在 `runManualRtspDrill` 里量 —— 那一趟本来
   * 就要把源放进一格。）
   */
  await runCameraViewDrill(win, layout)

  /**
   * 「实时监测」没有活数据时说什么（业主 2026-09-18 第 10 批第 18 条）。
   *
   * WHY THIS DRILL
   * 这一条只在"真的没有活数据"时才出现，而 operator 库里那几台设备**都是离线的** ——
   * 所以这一页正是现场要看的那个状态。验三件事：
   *   1. 提示条**写的是那个 IP**（操作员要去 ping 它，不是去猜设备名）；
   *   2. 提示条分两句说"有没有上次内容"（从来没收到过 / 以下是最后一次，带时刻）；
   *   3. 提示条**不撒谎**：设备在线时它不该出现（这一台离线，所以只验"离线时出现"）。
   * 只读：不点任何开关、不改设备。
   */
  const monitorOffline = await layout('/monitor', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const out = {};' +
    'const listed = await window.api.devices.list();' +
    'const devices = listed && listed.success ? listed.data : [];' +
    'out.devices = devices.map((d) => ({ name: d.name, ip: d.ip, status: d.status }));' +
    'if (devices.length === 0) return JSON.stringify(Object.assign(out, { reason: "no-device" }));' +
    /*
     * 业主 2026-09-19 第 13 批第 1 条：「实时监测里面如果有告警弹窗（192.168.110.90 离线
     * 还没有收到过这台设备的任何数据）这个内容不用显示」。
     *
     * 所以这一段**反过来量**：给页面足够的时间把该画的东西都画出来，然后断言那条提示条
     * **一个都不在**（`[data-monitor-source-banner]` 计数为 0），而且它那几句正文也没漏到别处
     * （按文本找「离线 / 还没有收到过」那两句在中文目录里的原文）。
     * 「上次内容」角标是另一件事，留着 —— 它只在**真的有那份内容**时才出现。
     */
    'for (let i = 0; i < 20; i += 1) await sleep(250);' +
    'out.bannerCount = document.querySelectorAll("[data-monitor-source-banner]").length;' +
    'out.bannerTexts = ["data-monitor-source-title", "data-monitor-source-detail"]' +
    '  .map((name) => text(document.querySelector("[" + name + "]")));' +
    'const bodyText = (document.body.innerText || "");' +
    /*
     * **不能只找「离线」两个字**：设备状态那一列本来就会写「离线」（`devices.status.offline`），
     * 而这一条要守的是**那条弹窗的正文**。所以逐个找那几句被删掉的整句，
     * 外加"某个 IP + 离线"这种形状（弹窗的第一句是 `{ip} 离线`）。
     */
    'out.bodyBannedSentences = [' +
    '  "还没有收到过这台设备的任何数据",' +
    '  "以下是最后一次收到的内容",' +
    '  "设备在线，正在等待它推数据",' +
    '  "数据已停止更新",' +
    '  "已停止（最后一帧"' +
    '].filter((sentence) => bodyText.indexOf(sentence) >= 0);' +
    'out.bodyHasIpOffline = /(\\d{1,3}\\.){3}\\d{1,3}\\s*离线/.test(bodyText);' +
    'out.bodyHasOfflineSentence = out.bodyBannedSentences.length > 0 || out.bodyHasIpOffline;' +
    'out.badgePresent = !!document.querySelector("[data-monitor-stale-badge]");' +
    'out.badgeText = text(document.querySelector("[data-monitor-stale-badge]"));' +
    'out.allOffline = devices.every((d) => d.status !== "ONLINE");' +
    // 页面本身照常在（"撤掉那条提示"不该顺手把这一页弄坏）。
    'out.pageAlive = !!document.querySelector(".page");' +
    'out.hasTrendPanel = document.querySelectorAll(".trend-panel").length > 0;' +
    'return JSON.stringify(out);' +
    '})()', 90_000)
  log('monitor offline: ' + JSON.stringify(monitorOffline))

  if (monitorOffline.reason === 'no-device') {
    problems.push('监测页离线提示探针：库里一台设备都没有，这一条没验证到')
  } else {
    /*
     * 这一条现在是**反向断言**（第 13 批第 1 条把那条弹窗撤掉了）。
     * `allOffline` 用来证明"这一条不是因为没有离线设备才过的"：库里那几台确实都离线，
     * 而屏幕上就是不该有那条提示。
     */
    if (monitorOffline.bannerCount !== 0) {
      problems.push(
        '监测页又出现了那条"没有活数据"的弹窗（' + monitorOffline.bannerCount +
          ' 个）—— 业主第 13 批第 1 条说这个内容不用显示'
      )
    }
    if (String(monitorOffline.bannerTexts?.[0] || '').trim() !== '' ||
        String(monitorOffline.bannerTexts?.[1] || '').trim() !== '') {
      problems.push('那条弹窗的正文还在页面上：' + JSON.stringify(monitorOffline.bannerTexts))
    }
    if (monitorOffline.bodyHasOfflineSentence) {
      problems.push(
        '页面正文里仍然找得到那条弹窗的正文（换了个地方显示也算没撤掉）：' +
          JSON.stringify({
            sentences: monitorOffline.bodyBannedSentences,
            ipOffline: monitorOffline.bodyHasIpOffline
          })
      )
    }
    if (monitorOffline.pageAlive !== true) {
      problems.push('撤掉那条提示之后页面本身没渲染出来')
    }
    if (monitorOffline.allOffline !== true) {
      log('monitor offline: 注意 —— 库里不全是离线设备，这一条只验了"没有那条弹窗"')
    }
    /*
     * 角标与内容一致这条断言随提示条一起撤了：那个内容标记（`data-monitor-content`）
     * 原来挂在提示条上，提示条没了它也没了。角标本身留了一条弱断言：
     * 从没推过数据时不许出现（这一份 operator 库里那几台都没推过）。
     */
    if (monitorOffline.badgePresent && !String(monitorOffline.badgeText || '').includes('上次')) {
      problems.push('「上次内容」角标上的字不对：' + JSON.stringify(monitorOffline.badgeText))
    }
  }

  /**
   * 业主 2026-09-19 第 13 批第 3 条（实时监测第 2、3 条）：
   *   ① 「选中设备就默认开始接收数据，不用点击开始监测按钮」→ 页头**不该再有**那个按钮，
   *      而会话必须**已经自己开过**（离线设备上就是"尝试过并失败"，那也是"开过"）。
   *   ② 每通道特性表：8 行 ×（通道 / 声压级 / 主频 / 平稳度 / 频带能量比 / 告警），
   *      高度与同排的图谱卡片一致，位置在原「频谱」那一格，点行切通道，点告警开详情。
   *
   * WHY THIS DRILL IS SO LONG
   * 这一段量的是**两件完全不同的事**：一件是"控件没了"（反向），一件是"表对了"（正向）。
   * 第一件最容易做成假通过 —— 探针在别的地方也能量到 `.btn`，所以这里数的是
   * `.monitor-head` 里**除了通道页签以外**的按钮（通道页签本来就在那一块里）。
   * 第二件要能分开"表没渲染"与"表渲染了但没有数据"：行数、表头、每行恰好一种告警格
   * 都是无条件的；有没有真的告警记录只影响"点开详情"那一次交互（operator 库里有告警，
   * 但**不假设**一定有，测不到就写进日志而不是报问题 —— 报问题会让这条断言在别的库上假红）。
   */
  const monitorTable = await layout('/monitor', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
    'const out = {};' +
    /*
     * 先把设备切到**声纹设备**（`kind === "acousticBox"`）。
     *
     * 为什么必须显式切：跑到这里时顶栏选中的设备是前面那条声呐流程留下来的那台
     * （`devices.selectedDeviceId` 是 store 里的状态，不随路由复位），而声呐那一支
     * 一块图谱都不渲染 —— 不切的话这段探针量到的全是 0，看起来像"表没做出来"。
     * 从 `devices.list()` 里按 kind 找，不写死设备名。
     */
    'const listed = await window.api.devices.list();' +
    'const all = listed && listed.success ? listed.data : [];' +
    'const box = all.find((d) => d.kind === "acousticBox") || null;' +
    'out.boxName = box ? box.name : null;' +
    'if (!box) return JSON.stringify(Object.assign(out, { reason: "no-box" }));' +
    'const select = document.querySelector("#topbar-page-slot select");' +
    'if (!select) return JSON.stringify(Object.assign(out, { reason: "no-select" }));' +
    'const option = [...select.options].find((o) => (o.textContent || "").indexOf(box.name) >= 0);' +
    'if (!option) {' +
    '  return JSON.stringify(Object.assign(out, {' +
    '    reason: "no-option",' +
    '    options: [...select.options].map((o) => (o.textContent || "").trim())' +
    '  }));' +
    '}' +
    'if (select.value !== option.value) {' +
    '  select.value = option.value;' +
    '  select.dispatchEvent(new Event("change", { bubbles: true }));' +
    '}' +
    'for (let i = 0; i < 20 && !document.querySelector("[data-channel-feature-table]"); i += 1) {' +
    '  await sleep(250);' +
    '}' +
    /*
     * ① 页头那一块里除通道页签以外的按钮。删掉「开始监测」之后应当一个都不剩：
     * 会话状态本身还在（下面那枚徽标），但"改变状态"的手段已经由自动开始接管。
     */
    'const head = document.querySelector(".monitor-head");' +
    'out.headButtons = head' +
    '  ? [...head.querySelectorAll("button")]' +
    '      .filter((b) => !b.classList.contains("channel-tab"))' +
    '      .map((b) => text(b))' +
    '  : null;' +
    /*
     * 会话徽标（`data-monitor-session-badge`）：四种语言里"已停止"那一句就是
     * "自动开始没跑"的证据。这台设备离线，所以正常结局是「数据流异常」——
     * 那也是**开过**（尝试过）。
     */
    'const badge = document.querySelector("[data-monitor-session-badge]");' +
    'out.sessionBadge = text(badge);' +
    'const STOPPED = ["实时数据已停止", "Live data stopped", "Datos en vivo detenidos", "Canlı veri durduruldu"];' +
    'out.sessionStopped = STOPPED.indexOf(out.sessionBadge) >= 0;' +
    // ② 表本身：行数 / 表头列数 / 表头文字。
    'const table = document.querySelector("[data-channel-feature-table]");' +
    'out.table = !!table;' +
    'out.rows = document.querySelectorAll("[data-channel-feature-row]").length;' +
    'out.tabs = document.querySelectorAll(".channel-tab").length;' +
    'out.headers = table ? table.querySelectorAll("thead th").length : 0;' +
    'out.headerTexts = table' +
    '  ? [...table.querySelectorAll("thead th")].map((th) => text(th))' +
    '  : [];' +
    /*
     * 每一行必须**恰好**有一种告警格：红按钮（还有没确认的）/ 灰按钮（都确认过了）/
     * "正常"文字。一个都没有 = 那一格是空的（会被读成"没数据"）。
     */
    'out.alarmCells = 0;' +
    'out.alarmButtons = 0;' +
    'out.alarmNone = 0;' +
    'out.rowsAlarmCellCounts = [...document.querySelectorAll("[data-channel-feature-row]")].map((row) => {' +
    '  const buttons = row.querySelectorAll("[data-channel-alarm]").length;' +
    '  const none = row.querySelectorAll("[data-channel-alarm-none]").length;' +
    '  return buttons + none;' +
    '});' +
    'out.alarmButtons = document.querySelectorAll("[data-channel-alarm]").length;' +
    'out.alarmNone = document.querySelectorAll("[data-channel-alarm-none]").length;' +
    'out.alarmCells = out.alarmButtons + out.alarmNone;' +
    // "有值"与"有时间"必须同真同假（与旧卡片同一条底线：旧读数不许看起来像实时值）。
    'out.rowsWithValues = [...document.querySelectorAll("[data-channel-feature-row] .channel-table__value")].length;' +
    'out.rowsWithTime = [...document.querySelectorAll("[data-channel-feature-row] .channel-table__time")].length;' +
    /*
     * 位置与等高：`data-channel-feature-table` 必须在图谱网格的**第一张卡**里
     * （业主：「把这个卡片挪到当前的频谱卡片的位置」），并且同一排的卡片高度一致。
     */
    'const grid = document.querySelector(".graph-grid");' +
    'const cards = grid ? [...grid.querySelectorAll(":scope > .card")] : [];' +
    'out.gridCards = cards.length;' +
    'out.tableCardIndex = cards.findIndex((card) => card.querySelector("[data-channel-feature-table]"));' +
    'out.gridRows = (function(){' +
    '  const rows = [];' +
    '  cards.forEach((card) => {' +
    '    const rect = card.getBoundingClientRect();' +
    '    const found = rows.find((row) => Math.abs(row.top - rect.top) < 4);' +
    '    if (found) found.heights.push(Math.round(rect.height));' +
    '    else rows.push({ top: rect.top, heights: [Math.round(rect.height)] });' +
    '  });' +
    '  return rows.map((row) => row.heights);' +
    '})();' +
    // ③ 点一行通道：三张图（频谱/时频域/声学波形）跟着切 —— 判据是"当前通道"真的换了。
    'const enabledRows = [...document.querySelectorAll("[data-channel-feature-row]")]' +
    '  .filter((row) => { const b = row.querySelector(".channel-table__select"); return b && !b.disabled; });' +
    'const activeBefore = document.querySelector(".channel-table__row--active");' +
    'out.activeRowBefore = activeBefore ? activeBefore.getAttribute("data-channel-feature-row") : null;' +
    'const target = enabledRows.find((row) => row !== activeBefore);' +
    'out.clickedRow = target ? target.getAttribute("data-channel-feature-row") : null;' +
    'if (target) {' +
    '  target.click();' +
    '  for (let i = 0; i < 20; i += 1) {' +
    '    const now = document.querySelector(".channel-table__row--active");' +
    '    if (now && now.getAttribute("data-channel-feature-row") === out.clickedRow) break;' +
    '    await sleep(250);' +
    '  }' +
    '}' +
    'const activeAfter = document.querySelector(".channel-table__row--active");' +
    'out.activeRowAfter = activeAfter ? activeAfter.getAttribute("data-channel-feature-row") : null;' +
    'const activeTab = document.querySelector(".channel-tab--active");' +
    'out.activeTabText = text(activeTab);' +
    // ④ 点告警那一格：详情弹窗里必须列出这一路的告警（同一次查询的那一份）。
    'const alarmButton = document.querySelector("[data-channel-alarm]");' +
    'out.detailOpened = false;' +
    'if (alarmButton) {' +
    '  alarmButton.click();' +
    '  for (let i = 0; i < 20 && !document.querySelector("[data-channel-alarm-detail-list]"); i += 1) {' +
    '    await sleep(250);' +
    '  }' +
    '  const dialog = document.querySelector("[role=dialog]");' +
    '  out.detailOpened = !!document.querySelector("[data-channel-alarm-detail-list]") ||' +
    '    !!document.querySelector("[data-channel-alarm-detail-empty]");' +
    '  out.detailItems = document.querySelectorAll("[data-channel-alarm-detail-id]").length;' +
    '  out.detailTypes = document.querySelectorAll("[data-channel-alarm-types]").length;' +
    '  out.detailTitle = dialog ? text(dialog.querySelector(".panel__title")) : null;' +
    '  const close = dialog ? dialog.querySelector(".panel__footer .btn--primary") : null;' +
    '  if (close) close.click();' +
    '  for (let i = 0; i < 12 && document.querySelector("[role=dialog]"); i += 1) await sleep(120);' +
    '  out.detailClosed = !document.querySelector("[role=dialog]");' +
    '}' +
    'out.pageAlive = !!document.querySelector(".page");' +
    'return JSON.stringify(out);' +
    '})()', 90_000)
  log('monitor table/autostart: ' + JSON.stringify(monitorTable))

  {
    if (monitorTable.reason === 'no-box') {
      problems.push('每通道特性表探针：库里没有声纹设备（acousticBox），这一条没验到')
    } else if (monitorTable.reason === 'no-select' || monitorTable.reason === 'no-option') {
      problems.push(
        '每通道特性表探针：顶栏设备下拉里找不到这台声纹设备：' +
          JSON.stringify(monitorTable.options || [])
      )
    } else if (monitorTable.reason) {
      problems.push('每通道特性表探针没跑起来：' + JSON.stringify(monitorTable.reason))
    } else {
    if (monitorTable.table !== true) {
      problems.push('实时监测页没有每通道特性表（[data-channel-feature-table]）')
    }
    /*
     * ① 按钮删干净了。`headButtons` 为 null = 连 `.monitor-head` 都没了，那是另一件事。
     */
    if (monitorTable.headButtons === null) {
      problems.push('实时监测页找不到设备头那一块（.monitor-head）')
    } else if (monitorTable.headButtons.length !== 0) {
      problems.push(
        '设备头里还有按钮（「开始监测 / 停止监测」应当已按第 13 批第 3 条删掉）：' +
          JSON.stringify(monitorTable.headButtons)
      )
    }
    /*
     * ① 反过来证明"默认开始接收数据"真的跑了：徽标不许停在「已停止」。
     * 离线设备上的正常结局是「数据流异常」（尝试过、失败了），那也是开过。
     */
    if (monitorTable.sessionStopped === true) {
      problems.push(
        '进页面之后会话还停在「已停止」：自动开始没有跑（徽标文字 ' +
          JSON.stringify(monitorTable.sessionBadge) + '）'
      )
    }
    // ② 表结构。
    if (monitorTable.rows === 0) {
      problems.push('每通道特性表一行都没有（表渲染了但没有通道）')
    } else if (monitorTable.rows !== monitorTable.tabs) {
      problems.push(
        '每通道特性表的行数与通道页签数不一致：行 ' + monitorTable.rows +
          ' vs 页签 ' + monitorTable.tabs
      )
    }
    if (monitorTable.headers !== 6) {
      problems.push(
        '每通道特性表的表头不是六列（通道 + 四项指标 + 告警）：' + monitorTable.headers +
          '（' + JSON.stringify(monitorTable.headerTexts) + '）'
      )
    }
    const badCells = (monitorTable.rowsAlarmCellCounts || []).filter((count) => count !== 1)
    if (badCells.length > 0) {
      problems.push(
        '有 ' + badCells.length + ' 行的告警格不是恰好一个（空格会被读成"没数据"）：' +
          JSON.stringify(monitorTable.rowsAlarmCellCounts)
      )
    }
    if (monitorTable.alarmCells !== monitorTable.rows) {
      problems.push(
        '告警格总数与行数不一致：格 ' + monitorTable.alarmCells + ' vs 行 ' + monitorTable.rows
      )
    }
    // "旧读数必须带时间"这条底线要按行守：有值没时间 = 把旧读数当实时值卖。
    const valueCells = monitorTable.rowsWithValues;
    if (valueCells > 0 && monitorTable.rowsWithTime !== Math.floor(valueCells / 4)) {
      problems.push(
        '有读数的行与带时间的行对不上：数值格 ' + valueCells + ' 个，时间 ' +
          monitorTable.rowsWithTime + ' 个（每个有读数的行有 4 格）'
      )
    }
    // 位置：特性表在图谱网格的第一张卡里（= 原「频谱」那一格）。
    if (monitorTable.tableCardIndex !== 0) {
      problems.push(
        '每通道特性表不在图谱网格的第一格（应在原「频谱」的位置）：index ' +
          monitorTable.tableCardIndex + '（共 ' + monitorTable.gridCards + ' 张卡）'
      )
    }
    // 等高：同一排的卡片高度必须一致（业主：「高度和左边的一致」）。
    for (const heights of monitorTable.gridRows || []) {
      const min = Math.min(...heights);
      const max = Math.max(...heights);
      if (max - min > 2) {
        problems.push('同一排的图谱卡片高度不一致（第 13 批第 3 条要求一致）：' + JSON.stringify(heights))
      }
    }
    // ③ 点行切通道。
    if (monitorTable.clickedRow === null) {
      problems.push('特性表里没有第二路可点的通道（只有一个通道时这一条验不到）')
    } else if (monitorTable.activeRowAfter !== monitorTable.clickedRow) {
      problems.push(
        '点了通道 ' + monitorTable.clickedRow + ' 之后当前通道没变（还在 ' +
          monitorTable.activeRowAfter + '）—— 三张图不会跟着切'
      )
    }
    // ④ 告警详情（有没有记录取决于这个库，所以只记日志、不报问题）。
    if (monitorTable.alarmButtons > 0) {
      if (monitorTable.detailOpened !== true) {
        problems.push('点了告警那一格之后详情弹窗没有出现')
      }
      if (monitorTable.detailItems === 0) {
        problems.push('告警详情弹窗里一条记录都没有（而那一格说有告警）')
      }
      if (monitorTable.detailClosed !== true) {
        problems.push('告警详情弹窗关不掉（关闭按钮没有生效）')
      }
    } else {
      log(
        'monitor table/autostart: 这个库里这台设备没有最近告警（' + monitorTable.alarmNone +
          ' 行显示"正常"），详情弹窗这一条没验到'
      )
    }
    if (monitorTable.pageAlive !== true) {
      problems.push('每通道特性表这一段之后页面本身没渲染出来')
    }
    }
  }

  /**
   * 「地址信息支持 GIS 显示」（业主 2026-09-18 第 10 批第 7 条后半）。
   *
   * WHY THIS DRILL
   * 这一条的两个入口**只在点位成对时**出现，而 operator 库里"有点位的设备"是探测器自己
   * 在那条声呐流程里点出来的 —— 所以先问一次 `devices.list()` 找出有完整点位的那一台，
   * 再看它的地址信息卡片上有没有那两个入口、点了之后地图页有没有**选中这一台**。
   * 只读（点链接只是导航）。
   */
  const gisCard = await layout('/devices', '(async () => {' +
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = {};' +
    'const listed = await window.api.devices.list();' +
    'const devices = listed && listed.success ? listed.data : [];' +
    'const complete = devices.filter((d) => d.installation &&' +
    '  typeof d.installation.gisLatitude === "number" && typeof d.installation.gisLongitude === "number");' +
    'const partial = devices.filter((d) => d.installation &&' +
    '  (typeof d.installation.gisLatitude === "number") !== (typeof d.installation.gisLongitude === "number"));' +
    'out.completeIds = complete.map((d) => d.id);' +
    'out.partialIds = partial.map((d) => d.id);' +
    'out.deviceCount = devices.length;' +
    'return JSON.stringify(out);' +
    '})()', 60_000)
  log('gis card      : ' + JSON.stringify(gisCard))

  if ((gisCard.completeIds || []).length === 0) {
    log('gis card      : 库里没有一台"点位成对"的设备，这一条没验证到（如实说明，不当成通过）')
  } else {
    const target = gisCard.completeIds[0]
    const detail = await layout('/devices/' + target, '(async () => {' +
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'const out = {};' +
      'for (let i = 0; i < 40 && !document.querySelector("[data-installation]"); i += 1) await sleep(250);' +
      'out.cardPresent = !!document.querySelector("[data-installation]");' +
      'out.point = text(document.querySelector("[data-installation-point]"));' +
      'const link = document.querySelector("[data-action=open-device-on-map]");' +
      'out.mapLink = link ? link.getAttribute("href") : null;' +
      'out.copyButton = !!document.querySelector("[data-action=copy-device-point]");' +
      'if (link) { link.click(); await sleep(1200); }' +
      'out.hashAfterClick = location.hash;' +
      // 地图页选中这一台的证据：那一行 / 那个标记带 `--active`。
      'out.activeRows = document.querySelectorAll(".map-table__row--active").length;' +
      'out.activeMarkers = document.querySelectorAll(".map-marker--active").length;' +
      'out.selectedPoint = text(document.querySelector("[data-installation-point]"));' +
      'return JSON.stringify(out);' +
      '})()', 90_000)
    log('gis detail    : ' + JSON.stringify(detail))

    if (!detail.cardPresent) {
      problems.push('设备详情页上没有地址信息卡片（[data-installation]）')
    }
    if (!String(detail.mapLink || '').includes('/map?device=' + target)) {
      problems.push('地址信息卡片上那个地图入口的地址不对：' + JSON.stringify(detail.mapLink))
    }
    if (!detail.copyButton) problems.push('地址信息卡片上没有「复制坐标」')
    if (!String(detail.hashAfterClick || '').includes('/map')) {
      problems.push('点「在地图信息里查看」没有跳到地图信息页：' + JSON.stringify(detail.hashAfterClick))
    }
    if (!(detail.activeRows >= 1) || !(detail.activeMarkers >= 1)) {
      problems.push(
        '地图页没有选中那一台（`?device=` 没生效）：行 ' + detail.activeRows +
          '，标记 ' + detail.activeMarkers
      )
    }
  }

  // 点位**只录一半**的设备不许出现那两个入口（半截坐标落不了图）。
  if ((gisCard.partialIds || []).length > 0) {
    const partialCheck = await layout('/devices/' + gisCard.partialIds[0], '(async () => {' +
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'for (let i = 0; i < 40 && !document.querySelector("[data-installation]"); i += 1) await sleep(250);' +
      'return JSON.stringify({' +
      '  cardPresent: !!document.querySelector("[data-installation]"),' +
      '  mapLink: !!document.querySelector("[data-action=open-device-on-map]"),' +
      '  copyButton: !!document.querySelector("[data-action=copy-device-point]")' +
      '});' +
      '})()', 90_000)
    log('gis partial   : ' + JSON.stringify(partialCheck))
    if (partialCheck.mapLink || partialCheck.copyButton) {
      problems.push('点位只录了一半的设备上出现了 GIS 入口（半截坐标落不了图）')
    }
  } else {
    log('gis partial   : 库里没有"只录一半"的设备，那一条边界没验证到')
  }

  log('problems     : ' + problems.length)
  for (const p of problems) log('  ! ' + p)

  if (KEEP_OPEN) {
    log('--keep-open given; window left open. Close it to exit.')
    return
  }
  app.exit(problems.length ? 1 : 0)
}

/**
 * A rejected executeJavaScript used to escape as an unhandled rejection: Electron
 * printed nothing useful, the harness never called app.exit, and the run looked
 * like a HANG rather than a failure. (It did exactly that for the sign-in snippet,
 * which was a syntax error because the snippet is assembled without newlines and
 * its statements had no semicolons — automatic semicolon insertion never fires on a
 * single line.) Any failure here is now reported and exits non-zero.
 */
app.whenReady().then(() =>
  run().catch((error) => {
    log('FATAL: harness threw: ' + (error && error.stack ? error.stack : String(error)))
    /*
     * 抛出也要**把已经收集到的问题打出来**。
     *
     * 为什么（2026-09-18 实测）：一条探针超时之后，后面的断言读到了 `undefined.length`，
     * 于是 driver 直接抛 —— 报告一行都没打印，**这一次运行等于白跑**（连"哪一步超时了"
     * 都看不出来，因为 problems 只存在于内存里）。异常本身仍是一条问题，但已经查到的
     * 那些必须留下。
     */
    log('problems     : ' + (problems.length + 1) + '（含上面那一条 harness 异常）')
    for (const problem of problems) log('  ! ' + problem)
    app.exit(1)
  })
)
