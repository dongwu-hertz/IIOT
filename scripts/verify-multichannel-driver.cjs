'use strict'
/*
 * 多通道同时显示的 GUI 验证 driver（业主 2026-09-24）。
 *
 * 接线方式与 `verify-round50-driver.cjs` / `demo-shot-driver.cjs` 一致：由 launcher
 * 生成的 wrapper 先 require 本文件、再 require 真实应用入口，所以这里的
 * `browser-window-created` 监听先于任何窗口注册。
 *
 * 它回答的问题只有一条：**勾选多路之后，界面有没有如实说出每一路到底是收到了还是没收到。**
 * 设备侧由 `scripts/mock-device.cjs --ws-binding <mode>` 扮演两种固件行为：
 *
 *   follow-current（实测行为）：/features_stream 只推设备当前通道，ping 里的 channel 被忽略。
 *     期望：勾了 3 路 -> 表格里出现 3 行，其中**只有当前那一路是"实时"**，另外两行写
 *     "未收到这一路"，而且悬停说明指出"这条连接推的是 CHx"（帧里自称的 cur_ch）。
 *   per-connection（假设行为，真机未验证）：固件按连接绑通道。
 *     期望：勾了 3 路 -> 3 行都是"实时"，每行都有迷你趋势。
 *
 * 两种模式都必须满足的同一条：**行数 = 勾选路数**，且没有任何一行拿别的通道的读数顶替
 * （`data-multi-channel-state` 与行里的读数都来自该行自己的帧）。
 *
 * 只读：只在一次性 profile 里加设备、开流、点勾选框；不写操作员的任何数据。
 */

const { app, BrowserWindow } = require('electron')

const PORT = Number(process.env.HZ_MC_PORT)
const BINDING = process.env.HZ_MC_BINDING || 'follow-current'
const DEVICE_NAME = 'MC PROBE'

const problems = []
const skipped = []
const notes = []

function log(message) {
  process.stdout.write('[mc] ' + message + '\n')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

/** 登录（一次性 profile 里是出厂管理员，首次登录必须改口令）。 */
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
      "      newPassword: 'mc-probe-pass'" +
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

/** 表格快照：每一行的通道号 / 状态 / 有没有迷你趋势 / 行内文字。 */
const TABLE_SNAPSHOT =
  "JSON.stringify(Array.from(document.querySelectorAll('[data-multi-channel-row]')).map((row) => ({" +
  '  channel: Number(row.getAttribute("data-multi-channel-row")),' +
  '  state: row.getAttribute("data-multi-channel-state"),' +
  '  ageMs: row.getAttribute("data-multi-channel-age"),' +
  '  hint: (row.querySelector(".multi-channel__state") || {}).title || "",' +
  '  spark: !!row.querySelector(".multi-channel__spark path"),' +
  '  text: (row.textContent || "").replace(/\\s+/g, " ").trim()' +
  '})))'

/** 勾选框快照：通道号 + 是否勾上 + 是否禁用。 */
const WATCH_SNAPSHOT =
  "JSON.stringify(Array.from(document.querySelectorAll('[data-multi-channel-watch]')).map((box) => ({" +
  '  channel: Number(box.getAttribute("data-multi-channel-watch")),' +
  '  checked: box.checked,' +
  '  disabled: box.disabled' +
  '})))'

app.whenReady().then(async () => {
  await sleep(4000)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    log('FAILED no window')
    app.exit(1)
    return
  }
  log('binding   : ' + BINDING)
  log('mock port : ' + PORT)

  const session = await signIn(win)
  log('sign in   : ' + JSON.stringify(session))
  if (!session || session.step === 'login' || session.step === 'change' || session.step === 'threw') {
    problems.push('登录失败，后面的断言都会是假失败：' + JSON.stringify(session))
    for (const problem of problems) log('  ! ' + problem)
    app.exit(1)
    return
  }

  // ---- 1. 把 mock 当成一台声纹盒加进来 ------------------------------------
  const added = await evalIn(
    win,
    '添加设备',
    '(async () => { try {' +
      '  const r = await window.api.devices.add({' +
      "    kind: 'acousticBox'," +
      "    ip: '127.0.0.1'," +
      '    httpPort: ' +
      PORT +
      ',' +
      "    username: 'admin'," +
      "    password: 'secret'," +
      '    name: ' +
      JSON.stringify(DEVICE_NAME) +
      '  });' +
      '  return JSON.stringify(r.success' +
      '    ? { ok: true, id: r.data.id, status: r.data.status, kind: r.data.kind }' +
      "    : { ok: false, code: r.error.code, message: r.error.message });" +
      '} catch (error) {' +
      "  return JSON.stringify({ ok: false, message: String(error && error.message) });" +
      '} })()',
    90_000
  )
  log('add       : ' + JSON.stringify(added))
  if (!added || !added.ok) {
    problems.push('设备添加失败（后面量不了）：' + JSON.stringify(added))
    for (const problem of problems) log('  ! ' + problem)
    app.exit(1)
    return
  }
  const deviceId = added.id

  // 设备必须先 ONLINE：MonitorView 的自动开会跳过离线设备（那会得到一堆"没有实时数据"）。
  let online = false
  for (let attempt = 0; attempt < 20 && !online; attempt += 1) {
    const status = await evalIn(
      win,
      '设备状态 ' + attempt,
      '(async () => {' +
        '  const list = await window.api.devices.list();' +
        '  const hit = (list.data || []).find((d) => d.id === ' +
        JSON.stringify(deviceId) +
        ');' +
        '  return JSON.stringify({ status: hit ? hit.status : null });' +
        '})()',
      30_000
    )
    online = status && status.status === 'ONLINE'
    if (!online) await sleep(1500)
  }
  log('online    : ' + online)
  if (!online) {
    skipped.push('设备没有进 ONLINE，实时那几条量不了（mock 的 /get_devinfo 可能没被认出来）')
  }

  // ---- 2. 打开实时监测页并切到「检测」模式 --------------------------------
  await evalIn(win, 'goto monitor', "location.hash = '#/monitor?device=" + deviceId + "'; true", 20_000)
  let ready = false
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    ready = await evalIn(
      win,
      '等页面根 ' + attempt,
      "JSON.stringify({ root: !!document.querySelector('[data-view-mode=\"detect\"]') })",
      20_000
    ).then((value) => Boolean(value && value.root))
    if (!ready) await sleep(750)
  }
  if (!ready) {
    problems.push('/monitor 上没有等到视图切换按钮（页面根没渲染出来）')
  } else {
    await evalIn(
      win,
      '切到检测模式',
      "document.querySelector('[data-view-mode=\"detect\"]').click(); true",
      20_000
    )
    let cardReady = false
    for (let attempt = 0; attempt < 30 && !cardReady; attempt += 1) {
      cardReady = await evalIn(
        win,
        '等多通道卡 ' + attempt,
        "JSON.stringify({ card: !!document.querySelector('[data-multi-channel]') })",
        20_000
      ).then((value) => Boolean(value && value.card))
      if (!cardReady) await sleep(500)
    }
    if (!cardReady) {
      problems.push('检测模式里没有出现多通道读数卡（[data-multi-channel] 找不到）')
    } else {
      // ---- 3. 勾选之前：只有当前通道一行 ---------------------------------
      const before = await evalIn(win, '勾选前快照', TABLE_SNAPSHOT, 20_000)
      const watchBefore = await evalIn(win, '勾选框快照', WATCH_SNAPSHOT, 20_000)
      log('rows before: ' + JSON.stringify(before))
      log('watch     : ' + JSON.stringify(watchBefore))

      if (!Array.isArray(watchBefore) || watchBefore.length === 0) {
        problems.push('多通道卡里一个勾选框都没有')
      }
      const current = (watchBefore || []).find((box) => box.disabled)
      if (!current) {
        problems.push('当前通道的勾选框没有被禁用（它必须始终显示，取消勾选只会少一行）')
      } else if (!current.checked) {
        problems.push('当前通道的勾选框没有勾上')
      }
      if (!Array.isArray(before) || before.length !== 1) {
        problems.push('没有勾选额外通道时表格不是 1 行（实际 ' + (before || []).length + ' 行）')
      }

      // ---- 4. 勾两路额外通道 ---------------------------------------------
      const wanted = [3, 4]
      for (const channel of wanted) {
        const clicked = await evalIn(
          win,
          '勾选 CH' + (channel + 1),
          '(function () {' +
            '  const box = document.querySelector(\'[data-multi-channel-watch="' +
            channel +
            '"]\');' +
            "  if (!box) return JSON.stringify({ ok: false, why: 'no-box' });" +
            '  if (box.disabled) return JSON.stringify({ ok: false, why: \'disabled\' });' +
            '  box.click();' +
            '  return JSON.stringify({ ok: true, checked: box.checked });' +
            '})()',
          20_000
        )
        log('tick CH' + (channel + 1) + ' : ' + JSON.stringify(clicked))
        if (!clicked || !clicked.ok) problems.push('勾选 CH' + (channel + 1) + ' 失败：' + JSON.stringify(clicked))
      }

      // 特征帧是 1 Hz：给足时间让每一路都至少走几帧。
      await sleep(9000)

      const after = await evalIn(win, '勾选后快照', TABLE_SNAPSHOT, 20_000)
      const watchAfter = await evalIn(win, '勾选后勾选框', WATCH_SNAPSHOT, 20_000)
      log('rows after : ' + JSON.stringify(after))
      log('watch after: ' + JSON.stringify(watchAfter))

      const state = await evalIn(
        win,
        '主进程会话状态',
        '(async () => { const r = await window.api.monitor.state(' +
          JSON.stringify(deviceId) +
          ');' +
          // 这个端点返回的是**会话数组**（一台设备一条），不是单个对象。
          "  if (!r.success) return JSON.stringify({ ok: false, code: r.error.code });" +
          '  const list = Array.isArray(r.data) ? r.data : [];' +
          '  const mine = list.find((entry) => entry.deviceId === ' +
          JSON.stringify(deviceId) +
          ') || list[0];' +
          '  return JSON.stringify({ ok: true, data: mine || null });' +
          '})()',
        30_000
      )
      const feeds = state && state.ok && state.data ? state.data.featureChannels || [] : []
      log('main feeds : ' + JSON.stringify(feeds))

      // 再隔几秒取一次：用来分辨"这一路停了"与"这一路慢了"（帧计数会说话）。
      await sleep(4000)
      const feedsLater =
        (await evalIn(
          win,
          '主进程会话状态（4 秒后）',
          '(async () => { const r = await window.api.monitor.state(' +
            JSON.stringify(deviceId) +
            ');' +
            "  if (!r.success) return JSON.stringify({ ok: false });" +
            '  const list = Array.isArray(r.data) ? r.data : [];' +
            '  const mine = list.find((entry) => entry.deviceId === ' +
            JSON.stringify(deviceId) +
            ') || list[0];' +
            '  return JSON.stringify({ ok: true, feeds: (mine && mine.featureChannels) || [] });' +
            '})()',
          30_000
        )) || {}
      log('main feeds+4s: ' + JSON.stringify(feedsLater.feeds || []))
      const after2 = await evalIn(win, '勾选后快照（4 秒后）', TABLE_SNAPSHOT, 20_000)
      log('rows +4s   : ' + JSON.stringify(after2))

      // ---- 5. 判据 -------------------------------------------------------
      const rows = Array.isArray(after) ? after : []
      if (rows.length !== 1 + wanted.length) {
        problems.push(
          '勾了 ' + wanted.length + ' 路之后表格不是 ' + (1 + wanted.length) + ' 行（实际 ' + rows.length + ' 行）'
        )
      }
      for (const channel of wanted) {
        if (!rows.some((row) => row.channel === channel)) {
          problems.push('CH' + (channel + 1) + ' 勾上了但表格里没有这一行')
        }
        const feed = feeds.find((entry) => entry.channelId === channel)
        if (!feed) {
          problems.push('主进程没有为 CH' + (channel + 1) + ' 报订阅状态（说明那条连接没建）')
          continue
        }
        if (feed.primary !== false) {
          problems.push('CH' + (channel + 1) + ' 被标成了主连接（额外通道必须各是一条连接）')
        }
        if (BINDING === 'per-connection') {
          /*
           * 假设行为：固件按连接绑通道 —— 这一路应该真的有帧，且帧里自称的通道
           * 就是它自己（`cur_ch` 是设备的原话，不是我们的推断）。
           */
          if (feed.frames <= 0) {
            problems.push('per-connection 模式下 CH' + (channel + 1) + ' 一帧都没收到')
          } else if (feed.observedChannelId !== channel) {
            problems.push(
              'per-connection 模式下 CH' +
                (channel + 1) +
                ' 的帧自称通道是 ' +
                feed.observedChannelId +
                '（应当等于 ' +
                channel +
                '）'
            )
          }
          const row = rows.find((entry) => entry.channel === channel)
          if (row && row.state !== 'live') {
            problems.push('per-connection 模式下 CH' + (channel + 1) + ' 这一行不是实时：' + row.state)
          }
          if (row && !row.spark) {
            problems.push('per-connection 模式下 CH' + (channel + 1) + ' 这一行没有迷你趋势')
          }
        } else {
          /*
           * 实测行为：这条连接推的是**设备当前通道**，不是我们请求的那一路。
           * 界面此时唯一正确的表现就是"没收到这一路"—— 拿当前那一路的读数填进去
           * 才是这条功能最危险的失败（数字看起来完全正常，但它属于另一路信号）。
           */
          if (feed.frames > 0 && feed.observedChannelId === channel) {
            problems.push('follow-current 模式下 CH' + (channel + 1) + ' 却收到了自己的帧（mock 行为不对）')
          }
          const row = rows.find((entry) => entry.channel === channel)
          if (row && row.state === 'live') {
            problems.push('follow-current 模式下 CH' + (channel + 1) + ' 被显示成实时（这一路没有帧）')
          }
          if (row && row.spark) {
            problems.push('follow-current 模式下 CH' + (channel + 1) + ' 画出了迷你趋势（没有帧可画）')
          }
          /*
           * 悬停说明必须说出**为什么**没收到：设备把这条连接推到了另一路上
           * （`observedChannelId` 是帧里自称的 cur_ch，设备的原话）。
           * 只写"未收到"就是把一条可排障的事实丢掉了。
           */
          if (
            row &&
            feed.observedChannelId !== undefined &&
            feed.observedChannelId !== channel &&
            !row.hint.includes('CH' + (feed.observedChannelId + 1))
          ) {
            problems.push(
              'follow-current 模式下 CH' +
                (channel + 1) +
                ' 的说明没有点出设备实际推的是 CH' +
                (feed.observedChannelId + 1) +
                '：' +
                JSON.stringify(row.hint)
            )
          }
        }
      }

      // 当前那一路永远在表格里，而且它应当是实时（mock 每秒推一帧）。
      const activeRow = rows.find((row) => row.channel === 0)
      if (!activeRow) {
        problems.push('当前通道 CH1 不在表格里')
      } else if (activeRow.state !== 'live') {
        notes.push('当前通道 CH1 这一行不是实时（' + activeRow.state + '）：mock 没在推或会话没起来')
      }

      const liveRows = rows.filter((row) => row.state === 'live')
      log('live rows  : ' + liveRows.map((row) => 'CH' + (row.channel + 1)).join(', '))
      const unreadRows = rows.filter((row) => row.state === 'unread')
      log('unread rows: ' + unreadRows.map((row) => 'CH' + (row.channel + 1)).join(', '))
    }
  }

  // ---- 结果 ---------------------------------------------------------------
  log('')
  log('binding   : ' + BINDING)
  if (notes.length > 0) {
    log('notes (' + notes.length + ')：')
    for (const note of notes) log('  - ' + note)
  }
  if (skipped.length > 0) {
    log('skipped (' + skipped.length + ')：')
    for (const entry of skipped) log('  - ' + entry)
  }
  log('problems  : ' + problems.length)
  for (const problem of problems) log('  ! ' + problem)

  app.exit(problems.length > 0 ? 1 : 0)
})
