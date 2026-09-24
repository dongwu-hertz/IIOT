'use strict'
/*
 * GIS 服务库 + AI 服务两项新功能的 GUI 验证 driver（在应用入口之前被 require）。
 *
 * 验证清单（登录之后）：
 *   1. 设置 → 地图：GIS 服务组渲染；添加服务（预置填表）；「测试瓦片」按钮链路
 *      （无外网时 fail 也算链路通，如实记录）；保存进列表；「应用」覆盖当前配置并开开关；
 *      刷新后持久；删除（confirm 兜底）。
 *   2. 设置 → AI 服务：第 9 个页签渲染；厂家预置填表；保存进列表；单选「启用」后
 *      状态行变就绪、主进程 activeId 跟上；刷新后持久；删除。
 *   3. 四语言：en / es / tr 切换后新页签与新组标题渲染成译文（不是裸 key）。
 *
 * 注入渲染进程的片段一律单行语句 + 显式分号（demo-shot-driver 的教训）。
 */

const { app, BrowserWindow } = require('electron')

const problems = []
const notes = []
const log = (m) => process.stdout.write('[verify] ' + m + '\n')
const note = (m) => notes.push(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function probe(body) {
  return (
    '(async () => { const vz = window.__vz; try {' +
    body +
    ' } catch (e) { return JSON.stringify({ threw: String(e && e.message) }) } })()'
  )
}

async function run() {
  // 等应用把自己的窗口建出来。
  let win = null
  for (let i = 0; i < 80 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0]
    if (!win) await sleep(250)
  }
  if (!win) {
    log('FATAL: 应用没有创建 BrowserWindow')
    app.exit(1)
    return
  }
  log('window       : ' + JSON.stringify(win.getTitle()))

  // 渲染进程辅助函数。**每次渲染层重载后都要重新注入**（reload 会重建 window）。
  async function injectHelper() {
    const r = await win.webContents.executeJavaScript(
      'window.__vz = {' +
        'sleep: (ms) => new Promise((r) => setTimeout(r, ms)),' +
        'click: (sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; },' +
        'fill: (sel, value) => { const el = document.querySelector(sel); if (!el) return false; el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); return true; },' +
        'text: (sel) => { const el = document.querySelector(sel); return el ? (el.textContent || "").trim() : null; },' +
        'count: (sel) => document.querySelectorAll(sel).length' +
        '}; "vz-ready"'
    )
    log('helper       : ' + r)
  }
  await injectHelper()

  const waitShell = async (label) => {
    const r = JSON.parse(
      await win.webContents.executeJavaScript(
        probe(
          'for (let i = 0; i < 80 && !document.querySelector(".app-shell"); i += 1) await vz.sleep(250);' +
            'return JSON.stringify({ shell: !!document.querySelector(".app-shell") })'
        )
      )
    )
    if (!r.shell) problems.push(label + '：等不到 .app-shell（渲染层没起来）')
    return r.shell
  }

  /** 渲染层重载后的一套固定动作：等 shell + 重新注入 helper。 */
  const reloadPage = async (label) => {
    win.webContents.reload()
    await sleep(2600)
    await waitShell(label)
    await injectHelper()
  }

  // ---------------------------------------------------------------------------
  // 登录（出厂 admin / Hz@123456，首用强制改密——与 demo-shot-driver 同一条真实流程）
  // ---------------------------------------------------------------------------
  const signIn = JSON.parse(
    await win.webContents.executeJavaScript(
      '(async () => { try {' +
        "  const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
        "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
        '  if (login.data.mustChangePassword) {' +
        '    const changed = await window.api.auth.changePassword({' +
        "      currentPassword: 'Hz@123456'," +
        "      newPassword: 'verify-gis-ai-pass'" +
        '    });' +
        "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
        "    return JSON.stringify({ step: 'changed' });" +
        '  }' +
        "  return JSON.stringify({ step: 'already-signed-in' });" +
        ' } catch (e) {' +
        "  return JSON.stringify({ step: 'threw', message: String(e && e.message) });" +
        ' } })()'
    )
  )
  log('sign in      : ' + JSON.stringify(signIn))
  if (signIn.step !== 'changed' && signIn.step !== 'already-signed-in') {
    problems.push('登录失败：' + JSON.stringify(signIn))
    finish()
    return
  }
  await sleep(800)

  // ---------------------------------------------------------------------------
  // Drill 1 · GIS 服务库（设置 → 地图页签）
  // ---------------------------------------------------------------------------
  log('--- drill 1: GIS 服务库 ---')
  await win.webContents.executeJavaScript("location.hash = '#/settings'; true")
  await sleep(1200)

  const mapTab1 = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'if (!vz.click(\'[data-tab="map"]\')) return JSON.stringify({ tab: false });' +
          'await vz.sleep(600);' +
          'return JSON.stringify({' +
          ' tab: true,' +
          ' group: !!document.querySelector("[data-map-services]") || vz.text("[data-map-service-add]") !== null,' +
          ' addBtn: vz.text("[data-map-service-add]"),' +
          ' saveCurrentBtn: vz.text("[data-map-service-save-current]"),' +
          ' emptyHint: vz.text(".map-service-list") === null && vz.text("[data-map-service-add]") !== null' +
          '})'
      )
    )
  )
  log('map tab      : ' + JSON.stringify(mapTab1))
  if (!mapTab1.tab) problems.push('GIS：设置页找不到地图页签按钮')
  if (mapTab1.addBtn === null) problems.push('GIS：没有「添加服务」按钮')

  // 添加服务：点预置 osm 自动填模板与署名、清密钥框。
  const addGis = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'if (!vz.click("[data-map-service-add]")) return JSON.stringify({ opened: false });' +
          'await vz.sleep(400);' +
          'vz.fill("[data-map-service-name]", "验证服务OSM");' +
          'if (!vz.click(\'[data-map-service-preset="osm"]\')) return JSON.stringify({ opened: true, preset: false });' +
          'await vz.sleep(300);' +
          'return JSON.stringify({' +
          ' opened: !!document.querySelector("[data-map-service-editor]"),' +
          ' url: document.querySelector("[data-map-service-url]") && document.querySelector("[data-map-service-url]").value,' +
          ' keyCleared: document.querySelector("[data-map-service-key]").value === "",' +
          ' attribution: document.querySelector("[data-map-service-attribution]") && document.querySelector("[data-map-service-attribution]").value' +
          '})'
      )
    )
  )
  log('gis add form : ' + JSON.stringify(addGis))
  if (!addGis.opened) problems.push('GIS：点「添加服务」后编辑器没展开')
  if (addGis.opened && !/openstreetmap/.test(String(addGis.url))) {
    problems.push('GIS：点 OSM 预置后模板没填进编辑器：' + JSON.stringify(addGis.url))
  }

  // 测试瓦片：等 ok / fail 任一出现（两台结果都算按钮链路通，如实记录）。
  await win.webContents.executeJavaScript(probe('vz.click("[data-map-service-test]"); await vz.sleep(100); return "clicked"'))
  let tileTest = null
  for (let i = 0; i < 40; i += 1) {
    const r = JSON.parse(
      await win.webContents.executeJavaScript(
        probe(
          'return JSON.stringify({' +
            ' testing: vz.text("[data-map-service-test]"),' +
            ' ok: vz.count("[data-map-service-test-ok]") > 0,' +
            ' fail: vz.count("[data-map-service-test-fail]") > 0' +
            '})'
        )
      )
    )
    if (r.ok || r.fail) {
      tileTest = r
      break
    }
    await sleep(500)
  }
  log('tile test    : ' + JSON.stringify(tileTest))
  if (!tileTest || (!tileTest.ok && !tileTest.fail)) {
    problems.push('GIS：「测试瓦片」点了之后 20 秒内既没成功也没失败提示（按钮链路没反应）')
  } else {
    note('测试瓦片结果：' + (tileTest.ok ? '成功（有外网）' : '失败（无外网/被拦，按钮链路正常）'))
  }

  // 保存服务 → 列表出现一行。
  await win.webContents.executeJavaScript(probe('vz.click("[data-map-service-save]"); await vz.sleep(1400); return "saved"'))
  const gisList = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'return JSON.stringify({' +
          ' rows: vz.count("[data-map-services] li"),' +
          ' firstName: vz.text("[data-map-services] li .map-service-row__name"),' +
          ' editorClosed: vz.count("[data-map-service-editor]") === 0' +
          '})'
      )
    )
  )
  log('gis list     : ' + JSON.stringify(gisList))
  if (!(gisList.rows >= 1)) problems.push('GIS：保存后列表里没有服务行')
  if (!gisList.editorClosed) problems.push('GIS：保存后编辑器没收起')

  // 应用：当前配置被覆盖 + 开关打开。
  await win.webContents.executeJavaScript(probe('vz.click("[data-map-service-apply]"); await vz.sleep(1400); return "applied"'))
  const applied = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'const url = document.querySelector("[data-settings-map-url]");' +
          'const enabled = document.querySelector("[data-settings-map-enabled]");' +
          'return JSON.stringify({' +
          ' url: url ? url.value : null,' +
          ' enabled: enabled ? enabled.checked : null' +
          '})'
      )
    )
  )
  log('gis applied  : ' + JSON.stringify(applied))
  if (!/openstreetmap/.test(String(applied.url))) {
    problems.push('GIS：「应用」后当前配置模板没被覆盖：' + JSON.stringify(applied.url))
  }
  if (applied.enabled !== true) problems.push('GIS：「应用」后在线底图开关没打开')

  // 持久化：刷新 → 行还在 + 主进程 settings.mapServices 有 1 条。
  await reloadPage('GIS 刷新后')
  const gisPersist = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'location.hash = "#/settings"; await vz.sleep(1000);' +
          'vz.click(\'[data-tab="map"]\'); await vz.sleep(600);' +
          'const settings = await window.api.settings.get();' +
          'return JSON.stringify({' +
          ' rows: vz.count("[data-map-services] li"),' +
          ' stored: settings.success ? settings.data.mapServices.length : -1,' +
          ' mapTilesEnabled: settings.success ? settings.data.mapTiles.enabled : null' +
          '})'
      )
    )
  )
  log('gis persist  : ' + JSON.stringify(gisPersist))
  if (!(gisPersist.rows >= 1) || gisPersist.stored !== 1) {
    problems.push('GIS：刷新后服务没持久化：rows=' + gisPersist.rows + ' stored=' + gisPersist.stored)
  }

  // 删除（confirm 兜底成真）。
  const gisDelete = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'const old = window.confirm; window.confirm = () => true;' +
          'vz.click("[data-map-service-delete]"); await vz.sleep(1400);' +
          'window.confirm = old;' +
          'const settings = await window.api.settings.get();' +
          'return JSON.stringify({' +
          ' rows: vz.count("[data-map-services] li"),' +
          ' stored: settings.success ? settings.data.mapServices.length : -1' +
          '})'
      )
    )
  )
  log('gis delete   : ' + JSON.stringify(gisDelete))
  if (gisDelete.rows !== 0 || gisDelete.stored !== 0) {
    problems.push('GIS：删除后没清干净：rows=' + gisDelete.rows + ' stored=' + gisDelete.stored)
  }

  // ---------------------------------------------------------------------------
  // Drill 2 · AI 服务（设置 → AI 服务页签）
  // ---------------------------------------------------------------------------
  log('--- drill 2: AI 服务 ---')
  const aiTab1 = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'if (!vz.click(\'[data-tab="ai"]\')) return JSON.stringify({ tab: false });' +
          'await vz.sleep(800);' +
          'return JSON.stringify({' +
          ' tab: true,' +
          ' status: vz.text("[data-ai-active-status]"),' +
          ' addBtn: vz.text("[data-ai-service-add]"),' +
          ' list: vz.count("[data-ai-services] li")' +
          '})'
      )
    )
  )
  log('ai tab       : ' + JSON.stringify(aiTab1))
  if (!aiTab1.tab) problems.push('AI：设置页找不到「AI 服务」页签按钮')
  if (aiTab1.addBtn === null) problems.push('AI：没有「添加服务」按钮')

  // 添加：点 DeepSeek 预置 → 地址与模型自动填。
  const aiAdd = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'if (!vz.click("[data-ai-service-add]")) return JSON.stringify({ opened: false });' +
          'await vz.sleep(400);' +
          'if (!vz.click(\'[data-ai-preset="deepseek"]\')) return JSON.stringify({ opened: true, preset: false });' +
          'await vz.sleep(300);' +
          'vz.fill("[data-ai-service-name]", "验证DeepSeek");' +
          'return JSON.stringify({' +
          ' opened: !!document.querySelector("[data-ai-service-editor]"),' +
          ' endpoint: document.querySelector("[data-ai-service-endpoint]") && document.querySelector("[data-ai-service-endpoint]").value,' +
          ' model: document.querySelector("[data-ai-service-model]") && document.querySelector("[data-ai-service-model]").value' +
          '})'
      )
    )
  )
  log('ai add form  : ' + JSON.stringify(aiAdd))
  if (!aiAdd.opened) problems.push('AI：点「添加服务」后编辑器没展开')
  if (aiAdd.opened && !/deepseek/.test(String(aiAdd.endpoint))) {
    problems.push('AI：点 DeepSeek 预置后地址没填进编辑器：' + JSON.stringify(aiAdd.endpoint))
  }

  // 保存 → 列表出现；选用（radio）→ 状态行变就绪 + 主进程 activeId 跟上。
  await win.webContents.executeJavaScript(probe('vz.click("[data-ai-service-save]"); await vz.sleep(1400); return "saved"'))
  const aiList = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'return JSON.stringify({' +
          ' rows: vz.count("[data-ai-services] li"),' +
          ' firstName: vz.text("[data-ai-services] li .map-service-row__name"),' +
          ' keyState: vz.text("[data-ai-services] li .muted"),' +
          ' editorClosed: vz.count("[data-ai-service-editor]") === 0' +
          '})'
      )
    )
  )
  log('ai list      : ' + JSON.stringify(aiList))
  if (!(aiList.rows >= 1)) problems.push('AI：保存后列表里没有服务行')

  const aiActivate = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'const radio = document.querySelector("[data-ai-service-active]");' +
          'if (!radio) return JSON.stringify({ radio: false });' +
          'radio.click(); await vz.sleep(1400);' +
          'const status = await window.api.samples.aiServices();' +
          'return JSON.stringify({' +
          ' radio: true,' +
          ' statusLine: vz.text("[data-ai-active-status]"),' +
          ' apiActive: status.success ? status.data.activeId : null,' +
          ' apiReady: status.success ? status.data.ready : null,' +
          ' apiCount: status.success ? status.data.services.length : -1' +
          '})'
      )
    )
  )
  log('ai activate  : ' + JSON.stringify(aiActivate))
  if (!aiActivate.radio) problems.push('AI：列表里没有「启用」单选')
  if (aiActivate.radio) {
    if (aiActivate.apiReady !== true) problems.push('AI：选用后主进程 ready 不是 true：' + JSON.stringify(aiActivate))
    const activeService = aiActivate.apiActive
    if (!activeService) problems.push('AI：选用后主进程 activeId 是空的')
  }

  // 持久化：刷新 → 行还在 + activeId 保持。
  await reloadPage('AI 刷新后')
  const aiPersist = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'location.hash = "#/settings"; await vz.sleep(1000);' +
          'vz.click(\'[data-tab="ai"]\'); await vz.sleep(900);' +
          'const status = await window.api.samples.aiServices();' +
          'return JSON.stringify({' +
          ' rows: vz.count("[data-ai-services] li"),' +
          ' apiCount: status.success ? status.data.services.length : -1,' +
          ' apiActive: status.success ? status.data.activeId : null' +
          '})'
      )
    )
  )
  log('ai persist   : ' + JSON.stringify(aiPersist))
  if (aiPersist.apiCount !== 1 || !aiPersist.apiActive) {
    problems.push('AI：刷新后没持久化：' + JSON.stringify(aiPersist))
  }

  // 删除（连同密钥）。
  const aiDelete = JSON.parse(
    await win.webContents.executeJavaScript(
      probe(
        'const old = window.confirm; window.confirm = () => true;' +
          'vz.click("[data-ai-service-delete]"); await vz.sleep(1400);' +
          'window.confirm = old;' +
          'const status = await window.api.samples.aiServices();' +
          'return JSON.stringify({' +
          ' rows: vz.count("[data-ai-services] li"),' +
          ' apiCount: status.success ? status.data.services.length : -1' +
          '})'
      )
    )
  )
  log('ai delete    : ' + JSON.stringify(aiDelete))
  if (aiDelete.apiCount !== 0) problems.push('AI：删除后主进程里还有服务：' + JSON.stringify(aiDelete))

  // ---------------------------------------------------------------------------
  // Drill 3 · 四语言（en / es / tr：新页签与新组标题必须是译文，不是裸 key）
  // ---------------------------------------------------------------------------
  log('--- drill 3: 四语言 ---')
  const EXPECT = {
    en: { tab: 'AI services', group: 'AI services', gis: 'GIS services' },
    es: { tab: 'Servicios de IA', group: 'Servicios de IA', gis: 'Servicios GIS' },
    tr: { tab: 'YZ hizmetleri', group: 'YZ hizmetleri', gis: 'GIS hizmetleri' },
    ru: { tab: 'AI-сервисы', group: 'AI-сервисы', gis: 'GIS-сервисы' },
    'zh-TW': { tab: 'AI 服務', group: 'AI 服務', gis: 'GIS 服務' }
  }
  for (const lang of ['en', 'es', 'tr', 'ru', 'zh-TW']) {
    // 与 demo-shot-driver 同一套切法：先写存储，再由主进程侧重载。
    await win.webContents.executeJavaScript(
      'window.localStorage.setItem("hertzinno.locale", ' + JSON.stringify(lang) + '); true'
    )
    await reloadPage('语言 ' + lang + ' 刷新后')
    const r = JSON.parse(
      await win.webContents.executeJavaScript(
        probe(
          'location.hash = "#/settings"; await vz.sleep(1000);' +
            'const tabText = vz.text(\'[data-tab="ai"]\');' +
            'vz.click(\'[data-tab="ai"]\'); await vz.sleep(700);' +
            'const aiGroup = vz.text("[data-ai-service-group]");' +
            'vz.click(\'[data-tab="map"]\'); await vz.sleep(700);' +
            'const gisGroup = vz.text("[data-map-service-group]");' +
            'return JSON.stringify({ tab: tabText, aiGroup: aiGroup, gisGroup: gisGroup, htmlLang: document.documentElement.lang })'
        )
      )
    )
    log('lang ' + lang + '   : ' + JSON.stringify(r))
    const want = EXPECT[lang]
    if (r.htmlLang !== lang) problems.push('语言 ' + lang + '：document.lang 没变（还是 ' + r.htmlLang + '）——localStorage 写入竞态？')
    if (r.tab !== want.tab) problems.push('语言 ' + lang + '：AI 页签名不是译文「' + want.tab + '」：' + JSON.stringify(r.tab))
    if (r.aiGroup !== want.group) problems.push('语言 ' + lang + '：AI 组标题不是译文「' + want.group + '」：' + JSON.stringify(r.aiGroup))
    if (r.gisGroup !== want.gis) problems.push('语言 ' + lang + '：GIS 组标题不是译文「' + want.gis + '」：' + JSON.stringify(r.gisGroup))
  }
  // 还原中文（同一套主进程侧重载）。
  await win.webContents.executeJavaScript(
    'window.localStorage.setItem("hertzinno.locale", "zh-CN"); true'
  )
  await reloadPage('还原中文后')

  finish()
}

function finish() {
  log('notes        : ' + notes.length)
  for (const n of notes) log('  · ' + n)
  log('problems     : ' + problems.length)
  for (const p of problems) log('  ! ' + p)
  app.exit(problems.length ? 1 : 0)
}

app.whenReady().then(() =>
  run().catch((error) => {
    log('FATAL: harness threw: ' + (error && error.stack ? error.stack : String(error)))
    log('problems     : ' + (problems.length + 1) + '（含上面那条 harness 异常）')
    for (const p of problems) log('  ! ' + p)
    app.exit(1)
  })
)
