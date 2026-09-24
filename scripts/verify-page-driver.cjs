'use strict'
/*
 * `verify-page.cjs` 的 driver：登录 → 进路由 → 等元素 → 逐个查选择器/文本。
 *
 * 为什么单独一个 driver：判据必须在**渲染进程**里量（`document.querySelector`），
 * 而 driver 由 launcher 生成的 wrapper 挂在应用入口之前，所以它拿得到主窗口。
 * 配置走 `HZ_PAGE_JOB` 环境变量（与 `demo-shot.cjs` 同一套做法）。
 */

const { app, BrowserWindow } = require('electron')

const JOB = JSON.parse(process.env.HZ_PAGE_JOB || '{}')
const failures = []

function log(message) {
  process.stdout.write('[page] ' + message + '\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 有上限的页面求值：渲染层卡住时不允许把整支探针拖死。 */
async function evalIn(win, label, source, timeoutMs = 30_000) {
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(source),
      sleep(timeoutMs).then(() => null)
    ])
    if (raw === null) {
      failures.push(label + ' 超时（' + timeoutMs + 'ms 没有返回）')
      return null
    }
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    failures.push(label + ' 抛异常：' + (error && error.message))
    return null
  }
}

/** 等主窗口出现（应用建窗口是异步的，`whenReady` 那一刻通常还没有）。 */
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

/** 登录（出厂管理员，首次必须改口令）—— 与 demo-shot / verify-round50 同一套两步流程。 */
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
      "      newPassword: 'verify-page-pass'" +
      '    });' +
      "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
      "    return JSON.stringify({ step: 'changed' });" +
      '  }' +
      "  return JSON.stringify({ step: 'already-signed-in' });" +
      '} catch (error) {' +
      "  return JSON.stringify({ step: 'threw', message: String(error && error.message) });" +
      '} })()'
  )
}

async function goto(win, route) {
  await evalIn(win, 'goto', 'location.hash = ' + JSON.stringify('#' + route) + '; true', 20_000)
  const deadline = Date.now() + 30_000
  for (;;) {
    const ready = await evalIn(
      win,
      'ping',
      '!!document.querySelector(".app-content .page, .app-content .login")',
      10_000
    )
    if (ready === true) break
    if (Date.now() >= deadline) break
    await sleep(300)
  }
  await sleep(1200)
}

/** 等某个选择器出现（页面数据是异步来的，不等就会把"还没渲染"报成"没有"）。 */
async function waitFor(win, selector, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await evalIn(
      win,
      'wait ' + selector,
      'document.querySelectorAll(' + JSON.stringify(selector) + ').length',
      8_000
    )
    if (typeof found === 'number' && found > 0) return true
    if (Date.now() >= deadline) return false
    await sleep(400)
  }
}

/**
 * 在顶栏设备下拉里按**名字**选一台（可选的 `--select`）。
 *
 * 为什么按名字而不是按 id：id 是每次建库生成的，写死一个明天就失效；
 * 名字是操作员看得见的那个（例如「Acoustic Camera」）。
 *
 * 页面上有好几个 `<select>`，所以优先找**顶栏那一格**里的那个（`#topbar-page-slot`），
 * 找不到再退回整页第一个 —— 与 `verify-round50-driver.cjs` 同一套判据。
 */
async function selectDevice(win, name) {
  return await evalIn(
    win,
    '选设备 ' + name,
    '(async () => {' +
      'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
      'const select = document.querySelector("#topbar-page-slot select") || document.querySelector("select");' +
      'if (!select) return JSON.stringify({ ok: false, reason: "no-select" });' +
      'const options = [...select.options].map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));' +
      'const want = ' + JSON.stringify(name) + '.toLowerCase();' +
      'const target = options.find((o) => o.text.toLowerCase().includes(want));' +
      'if (!target) return JSON.stringify({ ok: false, reason: "no-option", options });' +
      'select.value = target.value;' +
      'select.dispatchEvent(new Event("change", { bubbles: true }));' +
      'await wait(2500);' +
      'return JSON.stringify({ ok: true, text: target.text });' +
      '})()',
    60_000
  )
}

async function run(win) {
  const session = await signIn(win)
  log('sign in      : ' + JSON.stringify(session))
  if (!session || (session.step !== 'changed' && session.step !== 'already-signed-in')) {
    failures.push('登录失败：' + JSON.stringify(session))
    return
  }
  await sleep(1200)

  await goto(win, JOB.route)
  const waitSelector = JOB.wait || '.app-content .page'
  const ready = await waitFor(win, waitSelector, 25_000)
  log('route        : ' + JOB.route + '（等 ' + waitSelector + ' → ' + (ready ? '出现' : '**没出现**') + '）')
  if (!ready) failures.push('等了 25s，' + waitSelector + ' 仍然没有出现')

  /* 可选：先切到某一台设备（按名字），例如 --select "Acoustic Camera" */
  if (typeof JOB.select === 'string' && JOB.select !== '') {
    const picked = await selectDevice(win, JOB.select)
    log('select       : ' + JOB.select + ' → ' + JSON.stringify(picked))
    if (!picked || picked.ok !== true) {
      failures.push('切不到设备「' + JOB.select + '」：' + JSON.stringify(picked))
    }
    await sleep(1200)
  }

  /* 必须存在的选择器 */
  for (const selector of JOB.checks ?? []) {
    const present = await waitFor(win, selector, 8_000)
    const info = await evalIn(
      win,
      'check ' + selector,
      '(() => {' +
        'const nodes = [...document.querySelectorAll(' + JSON.stringify(selector) + ')];' +
        'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
        'return JSON.stringify({' +
        '  count: nodes.length,' +
        '  firstText: text(nodes[0]).slice(0, 120),' +
        '  visible: nodes.filter((el) => {' +
        '    const r = el.getBoundingClientRect();' +
        '    const s = getComputedStyle(el);' +
        '    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";' +
        '  }).length' +
        '});' +
        '})()',
      10_000
    )
    log('check        : ' + selector + ' → ' + JSON.stringify(info))
    if (!present || !info || info.count === 0) {
      failures.push('必须有、但没有：' + selector)
    } else if (info.visible === 0) {
      failures.push('有 ' + info.count + ' 个但一个都没显示（display/尺寸为 0）：' + selector)
    }
  }

  /* 必须不存在的选择器 */
  for (const selector of JOB.absents ?? []) {
    const info = await evalIn(
      win,
      'absent ' + selector,
      'document.querySelectorAll(' + JSON.stringify(selector) + ').length',
      10_000
    )
    log('absent       : ' + selector + ' → ' + info)
    if (typeof info === 'number' && info > 0) failures.push('必须没有、但出现了 ' + info + ' 个：' + selector)
  }

  /* 正文里必须出现的话 */
  for (const text of JOB.texts ?? []) {
    const found = await evalIn(
      win,
      'text ' + text,
      '(() => { const body = (document.body.textContent || "").replace(/\\s+/g, " ");' +
        'return JSON.stringify({ found: body.includes(' + JSON.stringify(text) + ') }); })()',
      10_000
    )
    log('text         : ' + JSON.stringify(text) + ' → ' + JSON.stringify(found))
    if (!found || found.found !== true) failures.push('正文里没有这句话：' + text)
  }

  /* 页面整体状态：有没有报错横幅、路由对不对 */
  const overview = await evalIn(
    win,
    '页面状态',
    '(() => {' +
      'const text = (el) => (el ? (el.textContent || "").replace(/\\s+/g, " ").trim() : "");' +
      'return JSON.stringify({' +
      '  hash: location.hash,' +
      '  pagePresent: !!document.querySelector(".app-content .page"),' +
      '  loginPresent: !!document.querySelector(".app-content .login"),' +
      '  alerts: [...document.querySelectorAll(".alert--danger")].map(text).slice(0, 3),' +
      '  firstTag: (function(){ const el = document.querySelector(".app-content .page");' +
      '    return el && el.firstElementChild ? el.firstElementChild.className : null; })()' +
      '});' +
      '})()',
    10_000
  )
  log('overview     : ' + JSON.stringify(overview))
  if (overview && overview.loginPresent === true) failures.push('进了登录页而不是目标路由（会话没建立）')
  if (overview && Array.isArray(overview.alerts) && overview.alerts.length > 0) {
    log('  ~ 页面上有错误横幅（不判失败，但值得看一眼）：' + JSON.stringify(overview.alerts))
  }
}

app.whenReady().then(async () => {
  const win = await waitForWindow()
  if (!win) {
    log('problems     : 1')
    log('  ! 没有窗口（等待 60s 应用仍未建出主窗口）')
    app.exit(1)
    return
  }
  if (win.webContents.isLoading()) {
    await new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  }
  await sleep(2000)
  try {
    await run(win)
  } catch (error) {
    failures.push('driver 抛异常：' + (error && error.stack ? error.stack : String(error)))
  }
  log('problems     : ' + failures.length)
  for (const failure of failures) log('  ! ' + failure)
  if (JOB.keepOpen) {
    log('--keep-open：窗口留着，关掉它才退出')
    return
  }
  app.exit(failures.length > 0 ? 1 : 0)
})
