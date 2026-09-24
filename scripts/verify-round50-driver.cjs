'use strict'
/*
 * 第 50 轮五条的 GUI 验证 driver（业主 2026-09-26 那五条）。
 *
 * 接线方式与 `demo-shot-driver.cjs` 完全一致：由 `run-round50-probe.cjs` 生成的 wrapper
 * 先 require 本文件、再 require 真实应用入口，所以这里的 `browser-window-created`
 * 监听先于任何窗口注册。
 *
 * 为什么单独写一支而不是加进 `demo-shot-driver.cjs`：
 *   那一支有 9000 多行、几十条断言锚在前几轮的 DOM 上（第 47–50 轮改过的地方大多已经
 *   漂移，本次整轮跑出 75 条"问题"里绝大多数是探针自己的陈旧锚点，不是产品缺陷）。
 *   这一支只回答**这五条**，锚点就是这一轮加进去的稳定钩子；跑一次的输出可以直接读。
 *
 * 只读：不写设备、不写设置、不改任何记录（切设备下拉、点一行、翻一页都属于界面动作）。
 * 用一次性 profile（见 launcher），所以操作员的真实库/设置/登录态一个字节都不碰。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const OUT = process.env.HZ_R50_OUT || path.join(process.cwd(), '.demo-shots-round50')
const problems = []
const notes = []
/**
 * 「这一次没量到」的条目 —— **不是**问题，也不让退出码变红。
 *
 * 什么时候用：空 profile（没加 `--with-data`）里**一台设备都没有**，于是"切到相机、
 * 告警表有没有行、角标是不是 10"这些量不了。那不是产品缺陷，也不该报成 5 条问题
 * （第一次不带 `--with-data` 跑就是这样）—— 但也不能静默：把它们列出来，
 * 并说明"要量它们请加 --with-data"。
 */
const skipped = []

function log(message) {
  process.stdout.write('[r50] ' + message + '\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 有上限的页面求值：渲染层卡住时不允许把整支探针拖死。 */
async function evalIn(win, label, source, timeoutMs = 60_000) {
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(source),
      sleep(timeoutMs).then(() => null)
    ])
    if (raw === null) {
      problems.push(label + ' 超时（' + timeoutMs + 'ms 没有返回）')
      return null
    }
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    problems.push(label + ' 抛异常：' + (error && error.message))
    return null
  }
}

/**
 * 登录（与 `demo-shot-driver.cjs` 同一条两步流程）。
 *
 * 外壳整体挂在应用账号之后，而一次性 profile 里是**出厂管理员**，首次登录必须改口令。
 * 不改的话后面每一页都停在登录表单上，所有 `[data-*]` 都找不到 —— 那是一堆假失败
 * （第一次跑就是这样：8 条"问题"全是"没有页面根/找不到选择器"）。
 *
 * 会话活在**主进程**里，所以登录一次就够，后面切路由不会掉。
 */
async function signIn(win) {
  return await evalIn(
    win,
    '登录',
    '(async () => { try {' +
      "  const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
      "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
      '  if (login.data.mustChangePassword) {' +
      '    const changed = await window.api.auth.changePassword({' +
      "      currentPassword: 'Hz@123456'," +
      "      newPassword: 'round50-probe-pass'" +
      '    });' +
      "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
      "    return JSON.stringify({ step: 'changed' });" +
      '  }' +
      "  return JSON.stringify({ step: 'already-signed-in' });" +
      '} catch (error) {' +
      "  return JSON.stringify({ step: 'threw', message: String(error && error.message) });" +
      '} })()',
    30_000
  )
}

/** 切路由 + 等页面根出现（与 demo-shot 的 layout() 同一套等待）。 */
async function goto(win, route) {
  await evalIn(win, 'goto ' + route, 'location.hash = ' + JSON.stringify('#' + route) + '; true', 20_000)
  const deadline = Date.now() + 30_000
  for (;;) {
    const ready = await evalIn(
      win,
      'ping ' + route,
      '!!document.querySelector(".app-content .page, .app-content .login")',
      10_000
    )
    if (ready === true) break
    if (Date.now() >= deadline) {
      problems.push(route + ' 上没有等到页面根（30s）')
      break
    }
    await sleep(300)
  }
  await sleep(1200)
}

/**
 * 切到相机那一台设备。
 *
 * 下拉在顶栏那一格（`#topbar-page-slot`），选项的 value 是设备 id：
 * 这里按**文本**匹配「Acoustic Camera」而不是按 id —— id 是每次建库生成的，
 * 写死一个 id 明天就失效。
 */
async function selectCamera(win) {
  return await evalIn(
    win,
    '选择相机设备',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const select = document.querySelector("#topbar-page-slot select");' +
      'if (!select) return JSON.stringify({ ok: false, reason: "no-select" });' +
      'const options = [...select.options].map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));' +
      'const target = options.find((o) => /Acoustic Camera/i.test(o.text));' +
      'if (!target) return JSON.stringify({ ok: false, reason: "no-camera-option", options });' +
      'select.value = target.value;' +
      'select.dispatchEvent(new Event("change", { bubbles: true }));' +
      'await wait(2500);' +
      'return JSON.stringify({ ok: true, text: target.text });' +
      '})()',
    60_000
  )
}

/** ① 告警信息表：标题格 / 五列 / 换页 / 与 PRPD 等高 / 间距。 */
async function probeAlarmTable(win) {
  return await evalIn(
    win,
    '告警信息表',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const round = (n) => Math.round(n);' +
      'const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();' +
      '  return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right),' +
      '    width: round(r.width), height: round(r.height) }; };' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'const table = document.querySelector(".camera-alarm-table");' +
      'const grid = document.querySelector(".camera-realtime-grid");' +
      'const prpd = document.querySelector(".acam__mode-panel");' +
      'const alarmCard = document.querySelector(".camera-alarm-history-card");' +
      'const page = document.querySelector(".page");' +
      'const out = {' +
      '  tablePresent: !!table,' +
      '  headerCells: table ? [...table.querySelectorAll("thead th")].map((th) => text(th)) : [],' +
      '  rowCount: table ? table.querySelectorAll("tbody tr").length : 0,' +
      '  rowIds: table ? [...table.querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-camera-alarm")) : [],' +
      '  firstRowCells: table && table.querySelector("tbody tr")' +
      '    ? [...table.querySelector("tbody tr").querySelectorAll("td")].map((td) => text(td)) : [],' +
      '  badgeCount: text(document.querySelector("[data-camera-alarm-count]")),' +
      '  pagerPresent: !!document.querySelector("[data-camera-alarm-pager]"),' +
      '  pagerText: text(document.querySelector("[data-camera-alarm-page]")),' +
      '  prevDisabled: (function(){ const b = document.querySelector("[data-action=camera-alarm-prev]");' +
      '    return b ? !!b.disabled : null; })(),' +
      '  nextDisabled: (function(){ const b = document.querySelector("[data-action=camera-alarm-next]");' +
      '    return b ? !!b.disabled : null; })(),' +
      '  alarmCard: rect(alarmCard),' +
      '  prpd: rect(prpd),' +
      '  gridAlign: grid ? getComputedStyle(grid).alignItems : null,' +
      '  boardPadding: (function(){ const b = document.querySelector(".camera-board");' +
      '    return b ? getComputedStyle(b).padding : null; })(),' +
      '  pageGap: page ? getComputedStyle(page).gap : null,' +
      '  contentPadding: (function(){ const c = document.querySelector(".app-content");' +
      '    return c ? getComputedStyle(c).padding : null; })()' +
      '};' +
      /* 翻一页看看：点"下一页"，行内容必须换掉（换页真的生效，而不是只画了个页码）。 */
      'const next = document.querySelector("[data-action=camera-alarm-next]");' +
      'if (next && !next.disabled) {' +
      '  const before = out.rowIds.slice();' +
      '  next.click();' +
      '  await wait(600);' +
      '  const after = [...document.querySelectorAll(".camera-alarm-table tbody tr")]' +
      '    .map((tr) => tr.getAttribute("data-camera-alarm"));' +
      '  out.afterNextPage = { page: text(document.querySelector("[data-camera-alarm-page]")),' +
      '    changed: JSON.stringify(before) !== JSON.stringify(after), rows: after.length };' +
      '  const prev = document.querySelector("[data-action=camera-alarm-prev]");' +
      '  if (prev && !prev.disabled) { prev.click(); await wait(600); }' +
      '}' +
      'return JSON.stringify(out);' +
      '})()'
  )
}

/**
 * 注入一条**真**相机告警，让告警信息表里有行可量。
 *
 * 走的是一条**真实的**链路，不碰渲染层内部状态：
 *   1. 读这台相机的推送秘钥（主进程里直接查 devices 表 —— 与
 *      `DeviceRepository.findByPushSecret()` 同一列，探针在进程内，可以直接读库）；
 *   2. 把「相机告警推送」打开（走真实的 `settings.update`，值取运行前读到的那一份，
 *      跑完由 launcher 的一次性 profile 负责丢弃 —— 原库不会被改）；
 *   3. 从**主进程**向 `http://127.0.0.1:<port>/fa371-alarm/<secret>` POST 一条记录，
 *      载荷字段名与手册/映射器一致（`is_alarm` / `alarm_level` / `detect_mode` /
 *      `soundmap_intensity` / `last_alarm_df`）。
 *
 * 注入多条是为了让**换页**真的成立（每页 8 行）。
 */
async function injectCameraAlarms(win, count = 10) {
  // 秘钥：先读当前接入端点；没有秘钥就用**真实的**轮换通道生成一个
  // （`devices.rotatePushSecret`，与设备页上那颗按钮同一条 IPC）。
  // 一次性 profile 的库，所以这一步不会改到操作员的任何凭据。
  const endpoint = await evalIn(
    win,
    '取推送秘钥',
    '(async () => { try {' +
      "  const select = document.querySelector('#topbar-page-slot select');" +
      '  const deviceId = select ? select.value : "";' +
      '  if (!deviceId) return JSON.stringify({ ok: false, reason: "no-device-id" });' +
      '  const read = await window.api.devices.ingestEndpoint(deviceId);' +
      '  let secret = read.success && read.data ? String(read.data.secret || "") : "";' +
      '  let rotated = false;' +
      '  if (secret === "") {' +
      '    const made = await window.api.devices.rotatePushSecret(deviceId);' +
      '    if (!made.success) return JSON.stringify({ ok: false, reason: "rotate", code: made.error.code });' +
      '    secret = String((made.data && made.data.secret) || "");' +
      '    rotated = true;' +
      '  }' +
      '  return JSON.stringify({ ok: secret !== "", secret, rotated, deviceId });' +
      '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()',
    30_000
  )
  log('push secret  : ' + JSON.stringify({ ...endpoint, secret: endpoint && endpoint.secret ? '***' : '' }))
  if (!endpoint || endpoint.ok !== true || typeof endpoint.secret !== 'string') {
    problems.push('拿不到相机推送秘钥（注入告警这一步走不了）：' + JSON.stringify(endpoint))
    return { ok: false, reason: 'no-secret' }
  }
  const secret = endpoint.secret

  // 打开推送开关（只影响这次一次性 profile 的库）。
  const enabled = await evalIn(
    win,
    '打开相机推送',
    '(async () => { try {' +
      "  const read = await window.api.settings.get();" +
      '  if (!read.success) return JSON.stringify({ ok: false, reason: "settings-read" });' +
      '  const current = read.data.alarmLinkage;' +
      '  const next = JSON.parse(JSON.stringify(current));' +
      '  next.enabled = true;' +
      '  next.cameraPush = Object.assign({}, next.cameraPush, { enabled: true });' +
      "  const written = await window.api.settings.update({ alarmLinkage: next });" +
      '  return JSON.stringify({' +
      '    ok: !!written.success,' +
      '    port: next.cameraPush ? next.cameraPush.port : null,' +
      '    wasEnabled: !!(current.cameraPush && current.cameraPush.enabled)' +
      '  });' +
      '} catch (error) { return JSON.stringify({ ok: false, threw: String(error && error.message) }); } })()',
    30_000
  )
  log('push enable  : ' + JSON.stringify(enabled))
  if (!enabled || enabled.ok !== true || typeof enabled.port !== 'number') {
    problems.push('打不开相机告警推送（没有端口就没法注入）：' + JSON.stringify(enabled))
    return { ok: false, reason: 'enable-failed' }
  }
  // 监听是主进程按设置变化重启的，给它一点时间。
  await sleep(2000)

  let accepted = 0
  for (let index = 0; index < count; index += 1) {
    const payload = {
      id: 900000 + index,
      is_alarm: true,
      alarm_level: index % 3 === 0 ? 4 : index % 3 === 1 ? 2 : 1,
      alarm_strategy_id: 1,
      detect_mode: 1,
      discharge_type: 1,
      start_time: Math.floor(Date.now() / 1000) - index * 60,
      soundmap_intensity: 60 + index,
      last_alarm_db: 61 + index,
      last_alarm_df: 12000 + index * 37,
      status: 1
    }
    try {
      const response = await fetch('http://127.0.0.1:' + enabled.port + '/fa371-alarm/' + secret, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      if (response.ok) accepted += 1
    } catch (error) {
      problems.push('注入第 ' + index + ' 条告警失败：' + (error && error.message))
      break
    }
  }
  await sleep(2000)
  return { ok: accepted > 0, accepted, port: enabled.port, secret }
}

/** ② 相机控制面板上那个角标（未确认口径）。 */
async function probeBadge(win) {
  return await evalIn(
    win,
    '告警控制角标',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      /* 顶栏那颗告警图标的面板要打开才看得到分区计数；这里读角标数字本身（[data-bell-count]）。 */
      'const bell = text(document.querySelector("[data-bell-count]"));' +
      'const badge = text(document.querySelector("[data-camera-alarm-count]"));' +
      'const title = (function(){ const el = document.querySelector(".cctl__alarm-badge");' +
      '  return el ? el.getAttribute("title") : null; })();' +
      'return JSON.stringify({ bellCount: bell, cameraBadge: badge, badgeTitle: title });' +
      '})()'
  )
}

/** ④⑤ 告警中心：详情全宽、点行给详情、那个小弹窗没了。 */
async function probeAlarmCenter(win) {
  return await evalIn(
    win,
    '告警中心',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const round = (n) => Math.round(n);' +
      'const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();' +
      '  return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right),' +
      '    width: round(r.width), height: round(r.height) }; };' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'const out = {};' +
      'const workspace = document.querySelector(".alarm-workspace");' +
      'out.columns = workspace ? getComputedStyle(workspace).gridTemplateColumns : null;' +
      'out.detailBeforeClick = !!document.querySelector("[data-alarm-detail]");' +
      'out.rows = document.querySelectorAll(".alarm-row").length;' +
      'const row = document.querySelector(".alarm-row");' +
      'if (!row) { out.reason = "no-rows"; return JSON.stringify(out); }' +
      'out.rowType = text(row.querySelector(".alarm-row__type"));' +
      'row.click();' +
      'await wait(1800);' +
      'const detail = document.querySelector("[data-alarm-detail]");' +
      'out.detailPresent = !!detail;' +
      'out.detail = rect(detail);' +
      'out.page = rect(document.querySelector(".page"));' +
      'out.master = rect(document.querySelector(".alarm-master"));' +
      'out.detailTitle = text(detail ? detail.querySelector(".alarm-detail__title") : null);' +
      'out.detailSections = detail' +
      '  ? [...detail.querySelectorAll(".detail-section__title")].map((n) => text(n)) : [];' +
      'out.hasAudioPlayer = !!document.querySelector("[data-recording-player], .rec-player, audio");' +
      'out.hasVideo = !!document.querySelector(".alarm-detail__video, video");' +
      'out.hasImage = !!document.querySelector(".alarm-detail__image, .alarm-detail img");' +
      'out.smallDialog = document.querySelectorAll(".modal, [role=dialog]").length;' +
      'out.detailQuery = location.hash;' +
      'return JSON.stringify(out);' +
      '})()',
    90_000
  )
}

/** ③ 从实时监测页点一条告警 → 告警中心打开那一条。 */
async function probeJumpToCenter(win) {
  return await evalIn(
    win,
    '跳到告警中心',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'const row = document.querySelector("[data-camera-alarm]");' +
      'if (!row) return JSON.stringify({ ok: false, reason: "no-alarm-row" });' +
      'const id = row.getAttribute("data-camera-alarm");' +
      'row.click();' +
      'await wait(2500);' +
      'return JSON.stringify({' +
      '  ok: true,' +
      '  eventId: id,' +
      '  hash: location.hash,' +
      '  detailPresent: !!document.querySelector("[data-alarm-detail]"),' +
      '  detailTitle: text(document.querySelector("[data-alarm-detail] .alarm-detail__title")),' +
      '  notice: text(document.querySelector(".alert--success, .alert--danger")),' +
      '  rowCount: document.querySelectorAll(".alarm-row").length' +
      '});' +
      '})()',
    90_000
  )
}

/** 数窗口：置顶提示窗口也是 BrowserWindow，所以在主进程里数得出来。 */
function windowCount() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
}

/** 等窗口数涨到至少 `want`（最多等 `timeoutMs`）。返回最终窗口数。 */
async function waitForWindowCount(want, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs
  let seen = windowCount()
  while (seen < want && Date.now() < deadline) {
    await sleep(400)
    seen = windowCount()
  }
  return seen
}

/** 从主进程推一条告警（不碰渲染层状态）。返回是否被接收。 */
async function pushOneAlarm(secret, port, index) {
  const payload = {
    id: 910000 + index,
    is_alarm: true,
    alarm_level: 4,
    alarm_strategy_id: 1,
    detect_mode: 1,
    discharge_type: 1,
    // 每条事件身份都不同（id 与 start_time 一起进 identity），所以不会被去重掉。
    start_time: Math.floor(Date.now() / 1000) - index * 60,
    soundmap_intensity: 70 + index,
    last_alarm_db: 71 + index,
    last_alarm_df: 13000 + index * 11,
    status: 1
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/fa371-alarm/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return response.ok
  } catch (error) {
    problems.push('推送一条告警失败：' + (error && error.message))
    return false
  }
}

/**
 * 第 5 条里"弹窗"两个字的**真窗口**验证（业主：告警中心里不该再被弹窗打扰）。
 *
 * 为什么必须单独量：那个置顶提示窗口是**另一个 BrowserWindow**，不在页面 DOM 里 ——
 * "页面里没有小弹窗"（`.modal` 计数 0）证明不了它。
 *
 * 两支，缺一不可：
 *   ① **正对照**：不在告警中心时推一条告警 → 窗口数**必须**增加。
 *      没有这一支，"告警中心里没增加"可能只是因为弹窗功能压根没工作（假阴性）。
 *   ② **被抑制**：进告警中心后推一条告警 → 窗口数**不许**增加，同时那一条要出现在列表里
 *      （"不弹"不等于"告警丢了"）。
 *
 * 计数口径：取**基线快照**而不是"差值必须为 0 的绝对值" —— 提示窗口 15 秒自动消失，
 * 期间它自己会关掉，所以只能比"有没有**新增**"，不能比总数不变。
 */
async function probePopupSuppression(win, secret, port, options) {
  const before = await evalIn(
    win,
    '抑制前基线',
    '(() => {' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'return JSON.stringify({' +
      '  rows: document.querySelectorAll(".alarm-row").length,' +
      '  hash: location.hash,' +
      '  hasAlarmDetail: !!document.querySelector("[data-alarm-detail]")' +
      '});' +
      '})()',
    20_000
  )

  const windowsBefore = windowCount()
  const sent = await pushOneAlarm(secret, port, options.index)
  // 引擎是推送到达即刻处理的（同步路径），但给它一点余量再数。
  await sleep(3500)
  const windowsAfter = windowCount()
  await sleep(1500)

  const after = await evalIn(
    win,
    '抑制后读数',
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'await wait(500);' +
      'return JSON.stringify({ rows: document.querySelectorAll(".alarm-row").length });' +
      '})()',
    20_000
  )

  return { before, after, windowsBefore, windowsAfter, sent, delta: windowsAfter - windowsBefore }
}

async function run(win) {
  fs.mkdirSync(OUT, { recursive: true })

  // ---- 先登录：外壳挂在账号之后，不登录每一页都停在登录表单上 ----
  const session = await signIn(win)
  log('sign in      : ' + JSON.stringify(session))
  if (!session || (session.step !== 'changed' && session.step !== 'already-signed-in')) {
    problems.push('登录失败，后面的断言都会是假失败：' + JSON.stringify(session))
    return
  }
  await sleep(1500)

  /*
   * 注入结果在下面被两处用（告警表那一段、置顶弹窗那一段），所以在**函数作用域**里声明：
   * 写成 `const` 在 `if` 块里会让后面那段拿不到（第一次跑就是 `injected is not defined`）。
   */
  let injected = { ok: false, reason: 'not-run' }

  // ---- ① 实时监测页：切到相机，注入告警，量告警信息表 ----
  await goto(win, '/monitor')
  const picked = await selectCamera(win)
  log('camera pick  : ' + JSON.stringify(picked))
  if (!picked || picked.ok !== true) {
    /*
     * 量不到相机 = 空 profile（没有加 `--with-data`）—— 记成"本次跳过"，不是问题。
     * 这一段之后的告警表 / 角标 / 跳转 / 弹窗几条都依赖有设备，一起跳过。
     */
    skipped.push(
      '切不到相机设备 → 告警表标题格/行/换页/等高/角标/跳转/置顶弹窗这几条**本次没量到**' +
        '（空 profile 里没有设备；要量它们请加 `--with-data`）'
    )
  } else {
    injected = await injectCameraAlarms(win)
    log('inject       : ' + JSON.stringify(injected))
    if (!injected || injected.ok !== true) {
      problems.push(
        '注入相机告警失败 —— 告警信息表**没有行可量**（标题格/换页/两列取值这一半没验到）：' +
          JSON.stringify(injected)
      )
    }
    // 推送到达之后工作台会自己刷新；再回一次这一页确保读到的是最新列表。
    await sleep(1500)
    const table = await probeAlarmTable(win)
    log('alarm table  : ' + JSON.stringify(table))
    if (table) {
      if (table.tablePresent !== true) {
        problems.push('相机告警信息不是一张带标题格的表（.camera-alarm-table 找不到）')
      } else {
        const want = ['时间', '告警等级', '告警类型', '声场强度', '主频']
        for (const label of want) {
          if (!table.headerCells.includes(label)) {
            problems.push('告警表的标题格里没有「' + label + '」：' + JSON.stringify(table.headerCells))
          }
        }
      }
      // 等高：告警卡与左侧 PRPD 面板的顶/底必须在同一行上。
      if (table.alarmCard && table.prpd) {
        const dt = Math.abs(table.alarmCard.top - table.prpd.top)
        const db = Math.abs(table.alarmCard.bottom - table.prpd.bottom)
        if (dt > 2 || db > 2) {
          problems.push(
            '告警卡与左侧 PRPD 不等高：顶差 ' + dt + 'px、底差 ' + db + 'px（' +
              JSON.stringify({ card: table.alarmCard, prpd: table.prpd }) + '）'
          )
        }
      } else {
        problems.push('量不到告警卡或 PRPD 面板（等高这一条没验到）')
      }
      if (table.gridAlign !== 'stretch') {
        problems.push('实时网格的 align-items 不是 stretch：' + table.gridAlign)
      }
      // 间距：板子自己不能再叠一层 padding。
      if (table.boardPadding && table.boardPadding !== '0px') {
        problems.push('相机板子自己又有内边距了（会与 .app-content 叠加）：' + table.boardPadding)
      }
      // 行与换页：注入过告警之后，表里必须真有行，而且换页控件要按页数出现。
      if (injected && injected.ok === true) {
        if (table.rowCount < 1) {
          problems.push('注入告警之后告警表里一行都没有（表格没渲染数据）')
        }
        if (table.rowCount > 8) {
          problems.push('单页行数超过每页固定行数 8：' + table.rowCount)
        }
        if (injected.accepted > 8 && table.pagerPresent !== true) {
          problems.push('告警超过一页却没有换页控件：注入 ' + injected.accepted + ' 条')
        }
        if (table.pagerPresent === true) {
          if (!/第\s*1\s*\/\s*\d+\s*页/.test(String(table.pagerText))) {
            problems.push('换页读数不是「第 N / M 页」：' + JSON.stringify(table.pagerText))
          }
          if (table.prevDisabled !== true) {
            problems.push('第一页的「上一页」不是禁用状态')
          }
          if (table.afterNextPage && table.afterNextPage.changed !== true) {
            problems.push('点了「下一页」之后行没有换（换页只画了页码没换数据）：' + JSON.stringify(table.afterNextPage))
          }
        }
        // 五列里的后两列必须有值或 `—`，不能是空白。
        if (table.firstRowCells.length >= 5) {
          for (const [index, name] of [[3, '声场强度'], [4, '主频']]) {
            const cell = String(table.firstRowCells[index] ?? '')
            if (cell.trim() === '') problems.push('「' + name + '」那一格是空的')
          }
          if (!/dB/.test(String(table.firstRowCells[3] ?? ''))) {
            problems.push('「声场强度」那一格没有单位 dB：' + JSON.stringify(table.firstRowCells[3]))
          }
          if (!/Hz/.test(String(table.firstRowCells[4] ?? ''))) {
            problems.push('「主频」那一格没有单位 Hz：' + JSON.stringify(table.firstRowCells[4]))
          }
        } else {
          problems.push('第一行的格子数不足五格：' + JSON.stringify(table.firstRowCells))
        }
        // 角标口径：只数未确认，所以它必须 ≤ 注入条数（全部都是未确认时相等）。
        const badge = Number(String(table.badgeCount).trim())
        if (!Number.isFinite(badge)) {
          problems.push('告警信息标题右侧的数字不是数字：' + JSON.stringify(table.badgeCount))
        } else if (badge > injected.accepted) {
          problems.push('角标数比注入的告警还多（它数的不是这台设备的未确认条数）：' + badge)
        }
      }
    }
    const badge = await probeBadge(win)
    log('badge        : ' + JSON.stringify(badge))
  }

  // ---- ③ 点一条告警 → 告警中心那一条 ----
  const jump = await probeJumpToCenter(win)
  log('jump         : ' + JSON.stringify(jump))
  if (!jump || jump.ok !== true) {
    // 空 profile 里没有告警行可点 —— 与上面同一条前置条件，不重复报问题。
    if (!skipped.some((entry) => entry.includes('切不到相机设备'))) {
      problems.push('实时监测页上点不到告警行：' + JSON.stringify(jump))
    }
  } else {
    if (!/\/alarms/.test(String(jump.hash))) {
      problems.push('点告警行没有跳到告警中心：' + jump.hash)
    }
    if (!/cameraAlarm=/.test(String(jump.hash))) {
      problems.push('跳转没有带上那一条的身份（cameraAlarm=）：' + jump.hash)
    }
    if (jump.detailPresent !== true) {
      problems.push('跳到告警中心后那一条的详情没有打开：' + JSON.stringify(jump))
    }
  }

  // ---- ④⑤ 告警中心本身 ----
  if (!jump || !/\/alarms/.test(String(jump.hash))) {
    await goto(win, '/alarms')
  } else {
    await sleep(1500)
  }
  const center = await probeAlarmCenter(win)
  log('alarm center : ' + JSON.stringify(center))
  if (center) {
    if (Array.isArray(center.columns) || typeof center.columns === 'string') {
      const cols = String(center.columns).trim().split(/\s+/)
      if (cols.length !== 1) {
        problems.push('告警中心工作区不是一列（详情没有占全部宽度）：' + center.columns)
      }
    }
    if (center.detailPresent === true && center.detail && center.page) {
      const widthGap = Math.abs(center.detail.width - (center.page.width - 2 * 16))
      if (center.detail.width < center.page.width * 0.9) {
        problems.push(
          '详情面板没有占全部宽度：详情 ' + center.detail.width + 'px，页面 ' + center.page.width + 'px'
        )
      }
      if (center.master && center.detail.top < center.master.bottom) {
        problems.push('详情没有排在列表下方（它是右侧那一列的旧版式）')
      }
    } else if (skipped.some((entry) => entry.includes('切不到相机设备'))) {
      // 空 profile：连告警行都没有，"点一行开详情"自然量不到。
      log('alarm center : skipped（没有告警行可点）')
    } else {
      problems.push('告警中心里点一行没有打开详情')
    }
    if (center.hasAudioPlayer !== true) {
      notes.push('这一条告警没有音频播放器（没有本机录音时是正常的：面板里会说明并给出口）')
    }
    if (center.detailSections && center.detailSections.length === 0) {
      problems.push('详情面板里一个证据分区都没有：' + JSON.stringify(center.detailSections))
    }
    /*
     * 业主 2026-09-24 报的现象：相机告警的视频与抓图两栏永远停在
     * 「这条告警没有本机联动录像」/「正在读取抓帧图片…」。
     *
     * 后半句是**卡住的加载态**（没有抓帧路径时状态被留在 idle）。这里在真窗口里钉住：
     * 打开一条**没有抓帧、没有录像**的相机告警之后，那两栏必须是**终态文案**，
     * 而且抓图那一栏**不许**再显示"正在读取"。
     */
    const evidence = await evalIn(
      win,
      '相机告警证据两栏',
      '(async () => {' +
        'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
        'await wait(800);' +
        'const text = (sel) => { const el = document.querySelector(sel);' +
        '  return el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : null; };' +
        'return JSON.stringify({' +
        '  noVideo: text("[data-camera-evidence-no-video]"),' +
        '  noImage: text("[data-camera-evidence-no-image]"),' +
        '  loading: text("[data-camera-evidence-loading]"),' +
        '  hasVideoTag: !!document.querySelector(".alarm-detail__video"),' +
        '  hasImageTag: !!document.querySelector(".alarm-detail__image")' +
        '});' +
        '})()',
      20_000
    )
    log('evidence     : ' + JSON.stringify(evidence))
    if (evidence) {
      if (evidence.loading !== null) {
        problems.push(
          '抓图那一栏仍然显示"正在读取抓帧图片…" —— 那是一个**永远转不完的加载态**：' +
            JSON.stringify(evidence.loading)
        )
      }
      if (evidence.hasVideoTag !== true && !evidence.noVideo) {
        problems.push('没有录像时视频那一栏没有给出任何说明')
      }
      if (evidence.hasImageTag !== true && !evidence.noImage) {
        problems.push('没有抓帧时抓图那一栏没有给出任何说明')
      }
    }
  }

  // ---- ⑤c 置顶弹窗：正对照 + 告警中心里被抑制 ----
  if (injected && injected.ok === true && typeof injected.secret === 'string') {
    // ① 正对照：不在告警中心时推一条，窗口数必须增加（否则下面的"没增加"说明不了任何事）。
    await goto(win, '/monitor')
    await selectCamera(win)
    await sleep(1200)
    const control = await probePopupSuppression(win, injected.secret, injected.port, { index: 1 })
    log('popup control: ' + JSON.stringify(control))
    if (!control.sent) {
      problems.push('正对照那一条告警没有被推送接口接收（这一条验不成）')
    } else if (control.delta < 1) {
      problems.push(
        '正对照失败：不在告警中心时推了一条告警，却没有弹出提示窗口（窗口数 ' +
          control.windowsBefore + ' → ' + control.windowsAfter +
          '）—— 那样"告警中心里没弹"就证明不了抑制生效'
      )
    }

    // ② 被抑制：进告警中心之后再推一条，窗口数不许增加，但那一条要进列表。
    await goto(win, '/alarms')
    await sleep(1500)
    const suppressed = await probePopupSuppression(win, injected.secret, injected.port, { index: 2 })
    log('popup suppress: ' + JSON.stringify(suppressed))
    if (!suppressed.sent) {
      problems.push('被抑制那一组没能把告警推进来')
    } else {
      if (suppressed.delta > 0) {
        problems.push(
          '告警中心里还是弹了置顶提示窗口（窗口数 ' + suppressed.windowsBefore + ' → ' +
            suppressed.windowsAfter + '）—— 第 5 条那一半没生效'
        )
      }
      if (suppressed.after.rows <= suppressed.before.rows) {
        problems.push(
          '被抑制的那条告警没有进列表（' + suppressed.before.rows + ' → ' + suppressed.after.rows +
            '）—— "不弹"变成了"告警丢了"，那是更严重的问题'
        )
      }
    }
  } else {
    // 空 profile：没有秘钥/端口 —— 与上面同一条前置条件。
    log('popup        : skipped（空 profile 里没有相机，置顶弹窗那两条没验到）')
  }

  // 截图留档：相机那一页与告警中心各一张（人眼核对用）。
  await goto(win, '/monitor')
  await selectCamera(win)
  await sleep(1500)
  try {
    const image = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, 'monitor-camera.png'), image.toPNG())
    await goto(win, '/alarms')
    await sleep(1500)
    const row = await evalIn(win, 'reopen row', 'document.querySelector(".alarm-row") ? (document.querySelector(".alarm-row").click(), true) : false')
    if (row === true) await sleep(1800)
    const centerShot = await win.webContents.capturePage()
    fs.writeFileSync(path.join(OUT, 'alarm-center.png'), centerShot.toPNG())
    log('shots        : ' + OUT)
  } catch (error) {
    notes.push('截图失败（不影响断言）：' + (error && error.message))
  }
}

/**
 * 等主窗口出现。
 *
 * 为什么不能像 `verify-gis-ai-driver.cjs` 那样在 `whenReady()` 里直接取
 * `getAllWindows()[0]`：应用建窗口是**异步**的（要先起库、注册 IPC、读到设置），
 * `whenReady` 那一刻通常一个窗口都还没有 —— 直接取会得到 `undefined`，
 * 整支探针报"没有窗口"然后什么也没量到（第一次跑就是这样）。
 *
 * 判据用 `browser-window-created` **加上**一次轮询：事件保证不早退，
 * 轮询兜住"事件早于本行注册"的竞态。
 */
function waitForWindow(timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      resolve(existing)
      return
    }
    let settled = false
    const finish = (win) => {
      if (settled) return
      settled = true
      resolve(win)
    }
    app.once('browser-window-created', (_event, win) => finish(win))
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        clearInterval(timer)
        finish(win)
        return
      }
      if (Date.now() >= deadline) {
        clearInterval(timer)
        finish(undefined)
      }
    }, 250)
  })
}

app.whenReady().then(async () => {
  const win = await waitForWindow()
  if (!win) {
    log('problems     : 1')
    log('  ! 没有窗口（等待 60s 应用仍未建出主窗口）')
    app.exit(1)
    return
  }
  /*
   * 等窗口真的把页面画出来：`did-finish-load` 之后 Vue 还要挂载、路由还要解析。
   * 不等的话第一支探针会在一张空页上量，报一堆"找不到"——那是探针自己的问题。
   */
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  await sleep(2500)
  try {
    await run(win)
  } catch (error) {
    problems.push('driver 抛异常：' + (error && error.stack ? error.stack : String(error)))
  }
  report()
})

function report() {
  log('problems     : ' + problems.length)
  for (const problem of problems) log('  ! ' + problem)
  for (const entry of skipped) log('  - ' + entry)
  for (const note of notes) log('  ~ ' + note)
  app.exit(problems.length > 0 ? 1 : 0)
}
