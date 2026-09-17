'use strict'
/**
 * 探针驱动：「记住上次的用户名 / 记住密码 / 每三个月重新输入」（业主 2026-09-16）。
 *
 * 这是**行为**验证，不是源码守卫：它在真实构建里走完
 * 「登录 → 记住 → 登出 → 重新加载登录页 → 检查预填」这一整条路。
 * 与 `scripts/demo-shot-driver.cjs` 同样的接线方式（本文件在应用入口之前被 require）。
 *
 * 为什么必须端到端跑一遍：这条链路跨了五个地方 —— 渲染层的表单、IPC、`safeStorage`
 * 加密、`app_meta` 落盘、以及再次启动时的解密与预填。任何一处断了，源码看起来都"有实现"。
 *
 * 注意：本文件里不出现反引号与 `${`，理由同 demo-shot-driver（它在父脚本里曾是模板字面量）。
 * 现在它是一个真实文件，但保持同一纪律省得下次被嵌回去时炸掉。
 */

const { app } = require('electron')

const CONFIG = JSON.parse(process.env.HZ_REMEMBER_PROOF || '{}')
const problems = []

function log(message) {
  console.log('[remember] ' + message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 出厂口令 → 首次登录强制改密 → 之后用这个新口令。 */
const FACTORY_PASSWORD = 'Hz@123456'
const NEW_PASSWORD = 'remember-proof-pass'

/**
 * 等窗口出现。
 *
 * **不能用 `app.whenReady()`**：本文件在应用入口之前被 require，所以它的 whenReady 回调
 * 排在应用自己的前面 —— 那时窗口还没建，`BrowserWindow.getAllWindows()` 是空的（第一次
 * 跑就是这样：报「没有窗口」）。`browser-window-created` 才是"窗口真的建出来了"的那一刻，
 * 而它也是 demo 驱动用的同一条路子。
 */
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    void run(win)
  })
})

/** 兜底：窗口在本文件被 require 之前就已存在（热重载/resume 之类）。 */
app.whenReady().then(() => {
  const { BrowserWindow } = require('electron')
  const existing = BrowserWindow.getAllWindows()[0]
  if (existing && !existing.webContents.isLoading()) {
    void run(existing)
  }
})

async function run(win) {
  const evaluate = (script) => win.webContents.executeJavaScript(script)

  // 登录页先挂载出来。
  await sleep(2500)

  // 1) 登录页上有「记住密码」勾选框（产品要求的第 2 条）。
  const chrome = JSON.parse(
    await evaluate(
      '(() => {' +
        '  const box = document.querySelector(".login__remember input");' +
        '  const label = document.querySelector(".login__remember");' +
        '  return JSON.stringify({' +
        '    hasCheckbox: !!box,' +
        '    checked: box ? box.checked : null,' +
        '    disabled: box ? box.disabled : null,' +
        '    label: label ? label.textContent.trim() : "",' +
        '    usernameValue: (document.querySelector(".login__form input[type=text]") || {}).value || ""' +
        '  });' +
        '})()'
    )
  )
  log('login chrome : ' + JSON.stringify(chrome))
  if (!chrome.hasCheckbox) problems.push('登录页上没有「记住密码」勾选框')
  if (chrome.checked === true) problems.push('「记住密码」默认就是勾上的（应当默认不勾）')

  // 2) 登录（含首次强制改密）——和 demo 探针同一套流程。
  const signIn = JSON.parse(
    await evaluate(
      '(async () => { try {' +
        "  const login = await window.api.auth.login({ username: 'admin', password: '" + FACTORY_PASSWORD + "' });" +
        "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
        '  if (login.data.mustChangePassword) {' +
        '    const changed = await window.api.auth.changePassword({' +
        "      currentPassword: '" + FACTORY_PASSWORD + "'," +
        "      newPassword: '" + NEW_PASSWORD + "'" +
        '    });' +
        "    if (!changed.success) return JSON.stringify({ step: 'change', code: changed.error.code });" +
        "    return JSON.stringify({ step: 'changed' });" +
        '  }' +
        "  return JSON.stringify({ step: 'already-signed-in' });" +
        '} catch (error) {' +
        "  return JSON.stringify({ step: 'threw', message: String(error && error.message) });" +
        '} })()'
    )
  )
  log('sign in      : ' + JSON.stringify(signIn))
  if (signIn.step !== 'changed' && signIn.step !== 'already-signed-in') {
    problems.push('登录失败：' + JSON.stringify(signIn))
  }

  const activePassword = signIn.step === 'changed' ? NEW_PASSWORD : FACTORY_PASSWORD

  // 3) 记住：勾了、并且是**用户亲手输入**的（`userTypedPassword: true`）。
  await evaluate(
    '(async () => {' +
      '  await window.api.auth.rememberLogin({' +
      "    username: 'admin'," +
      "    password: '" + activePassword + "'," +
      '    rememberPassword: true,' +
      '    userTypedPassword: true' +
      '  });' +
      '  return true;' +
      '})()'
  )
  await sleep(400)

  // 4) 读回来：用户名与密码都要在（加密 → 落盘 → 解密这一圈真的走通了）。
  const stored = JSON.parse(
    await evaluate(
      '(async () => {' +
      '  const result = await window.api.auth.rememberedLogin();' +
      '  if (!result.success) return JSON.stringify({ ok: false });' +
      '  const data = result.data;' +
      '  return JSON.stringify({' +
      '    ok: true,' +
      '    username: data.username,' +
      '    hasPassword: typeof data.password === "string" && data.password.length > 0,' +
      '    passwordMatches: data.password === ' + JSON.stringify(activePassword) + ',' +
      '    expired: data.expired,' +
      '    persistent: data.persistent' +
      '  });' +
      '})()'
    )
  )
  log('remembered   : ' + JSON.stringify(stored))
  if (!stored.ok) problems.push('读回记住的登录信息失败')
  else {
    if (stored.username !== 'admin') problems.push('用户名没有被记住：' + JSON.stringify(stored.username))
    if (!stored.hasPassword) problems.push('密码没有被记住')
    if (stored.hasPassword && !stored.passwordMatches) problems.push('读回的密码与输入的不一致')
    if (stored.expired) problems.push('刚记住就被判为过期')
    if (!stored.persistent) problems.push('系统加密报告为不可用，密码不该被记住')
  }

  // 5) 登出 + 重新加载 → 登录页应当**预填**用户名与密码，且勾选框是勾上的。
  await evaluate('(async () => { await window.api.auth.logout(); return true; })()')
  await sleep(500)
  win.webContents.reload()
  await sleep(3000)

  const prefilled = JSON.parse(
    await evaluate(
      '(() => {' +
      '  const user = document.querySelector(".login__form input[type=text]");' +
      '  const pass = document.querySelector(".login__form input[type=password]");' +
      '  const box = document.querySelector(".login__remember input");' +
      '  return JSON.stringify({' +
      '    onLoginScreen: !!user,' +
      '    username: user ? user.value : null,' +
      '    passwordLength: pass ? pass.value.length : null,' +
      '    passwordMatches: pass ? pass.value === ' + JSON.stringify(activePassword) + ' : null,' +
      '    rememberChecked: box ? box.checked : null' +
      '  });' +
      '})()'
    )
  )
  log('prefilled    : ' + JSON.stringify(prefilled))
  if (!prefilled.onLoginScreen) {
    problems.push('登出并重新加载之后没有回到登录页')
  } else {
    if (prefilled.username !== 'admin') {
      problems.push('登录页没有预填上次的用户名：' + JSON.stringify(prefilled.username))
    }
    if (prefilled.passwordMatches !== true) {
      problems.push('登录页没有预填记住的密码')
    }
    if (prefilled.rememberChecked !== true) {
      problems.push('预填了密码却没勾上「记住密码」（下一次登录会把记忆清掉）')
    }
  }

  /*
   * 6) 取消勾选必须真的失效。
   *
   * 这一条防的是"取消勾选只是界面上不勾、密文还留在库里"——那等于用户以为删掉了、实际没有。
   */
  await evaluate(
    '(async () => {' +
      '  await window.api.auth.rememberLogin({' +
      "    username: 'admin'," +
      '    rememberPassword: false,' +
      '    userTypedPassword: false' +
      '  });' +
      '  return true;' +
      '})()'
  )
  await sleep(400)
  const afterUncheck = JSON.parse(
    await evaluate(
      '(async () => {' +
      '  const result = await window.api.auth.rememberedLogin();' +
      '  return JSON.stringify({' +
      '    username: result.success ? result.data.username : null,' +
      '    hasPassword: result.success ? typeof result.data.password === "string" : null' +
      '  });' +
      '})()'
    )
  )
  log('unchecked    : ' + JSON.stringify(afterUncheck))
  if (afterUncheck.hasPassword === true) {
    problems.push('取消勾选「记住密码」之后密码仍然留在库里')
  }
  if (afterUncheck.username !== 'admin') {
    problems.push('取消勾选密码时把用户名也一起丢了（用户名应当总是记住）')
  }

  log('problems     : ' + problems.length)
  for (const problem of problems) log('  ! ' + problem)

  if (CONFIG.keepOpen) {
    log('--keep-open given; window left open. Close it to exit.')
    return
  }
  app.exit(problems.length ? 1 : 0)
}
