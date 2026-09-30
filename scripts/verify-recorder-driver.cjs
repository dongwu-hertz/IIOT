'use strict'
/*
 * 连续录像（S1）真窗口 driver。
 *
 * 由 launcher 的 wrapper 先 require 本文件、再 require 真实应用入口，所以这里的
 * `app.whenReady()` 排在应用启动之后 —— 那时 `getServices()` 已经有录像器实例了。
 *
 * 直接驱动**主进程里的录像器**（而不是走界面）：这一轮要验的是"录像器在真实时序下对不对"，
 * 而界面还没做。IPC 那两条通道由 `verify-page` 之类的冒烟覆盖形状，这里不重复。
 *
 * 量到的东西都写进 stdout，退出码 = 问题数（0 = 全过）。
 */

const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const problems = []
const log = (message) => process.stdout.write('[rec] ' + message + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const STORAGE_ROOT = process.env.HZ_RECORDER_PROBE_ROOT || process.env.HERTZINNO_STORAGE_ROOT
const DEVICE = { deviceId: 'probe-device', deviceUid: 'PROBE-CAM', rtspUrl: 'rtsp://127.0.0.1:1/none' }
/** 切片取 10 秒：探针要在一分钟内看到"多片 + 登记 + 收尾"，不能等 5 分钟。 */
const SEGMENT_SECONDS = 10

/** 片段文件是不是**真的能播**：读文件头，必须出现 `ftyp` box。 */
function probePlayable(file) {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    fs.closeSync(fd)
    const size = fs.statSync(file).size
    // 判据只看**结构**：第一个 box 必须是 `ftyp`（`00000018 66747970`）。
    // 不用"大小 > N 字节"当判据 —— 第一跑就是被这条误判的（文件头完全正确）。
    const hasFtyp = head.subarray(4, 8).toString('latin1') === 'ftyp'
    return { ok: hasFtyp && size > 0, size, head: head.subarray(0, 16).toString('hex') }
  } catch (error) {
    return { ok: false, size: 0, error: String(error && error.message) }
  }
}

/** 列出存储根下这一台设备的所有片段（按时间升序）。 */
function listSegments() {
  const root = path.join(STORAGE_ROOT, 'video', DEVICE.deviceUid)
  if (!fs.existsSync(root)) return []
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/.test(entry.name)) {
        found.push({ file: full, name: entry.name, ...probePlayable(full) })
      }
    }
  }
  walk(root)
  return found.sort((left, right) => left.name.localeCompare(right.name))
}

app.whenReady().then(async () => {
  await sleep(6_000) // 等应用把服务树建好（数据库、设置、存储根）

  // 主进程被 electron-vite 打包成单个 index.js，所以探针从 `globalThis` 拿服务树
  // （`HZ_RECORDER_PROBE=1` 时 app-services 会挂上去；见那段注释）。
  const services = globalThis.__HZ_SERVICES__
  if (!services || !services.recorder) {
    log('FAILED 拿不到主进程服务树（HZ_RECORDER_PROBE 没生效？）')
    app.exit(1)
    return
  }

  // 录像表对 `devices` 有外键（`ON DELETE CASCADE`），所以探针必须**先建一台设备行**再录。
  // 第一跑就是漏了这一步：登记被外键挡下（日志里 `FOREIGN KEY constraint failed`），
  // 库里 0 行 —— 而那其实是数据库在正常工作。
  services.db
    .prepare(
      `INSERT OR IGNORE INTO devices (id, device_uid, name, connection_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'LAN', 'ONLINE', ?, ?)`
    )
    .run(DEVICE.deviceId, DEVICE.deviceUid, 'RECORDER PROBE', Date.now(), Date.now())

  const recorder = services.recorder
  const recordings = services.recordingRepo
  log('storage root : ' + STORAGE_ROOT)
  log('segment      : ' + SEGMENT_SECONDS + 's（探针用短切片）')

  // ---- 1. 开录：真的起 ffmpeg（合成源）、真的切片 ---------------------------
  await recorder.start(DEVICE, SEGMENT_SECONDS)
  await sleep(26_000)

  const segments = listSegments()
  const unplayable = segments.filter((segment) => !segment.ok)
  log('segments     : ' + segments.length + '（不可播 ' + unplayable.length + '）')
  if (segments.length < 2) problems.push('26 秒里没有产出至少 2 个片段（实际 ' + segments.length + '）')
  if (unplayable.length > 0) {
    problems.push('有片段打不开（缺 ftyp）：' + unplayable.map((s) => s.name + ' ' + (s.error ?? s.head)).join(', '))
  }

  const statusAfterStart = recorder.statusOfDevice(DEVICE.deviceId)
  log('status       : ' + JSON.stringify(statusAfterStart))
  if (statusAfterStart?.state !== 'recording') {
    problems.push('文件在长的时候状态不是 recording，而是 ' + String(statusAfterStart?.state))
  }

  const rows = services.db
    .prepare(`SELECT COUNT(*) AS total FROM recordings WHERE recording_type = 'scheduled'`)
    .get()
  const scheduledTotal = Number(rows?.total ?? 0)
  log('db rows      : ' + scheduledTotal + ' 条 scheduled')
  if (scheduledTotal === 0) problems.push('库里一条 scheduled 切片都没有（登记没跑通）')

  // ---- 2. 断流：杀掉 ffmpeg，验证看门狗 → 退避 → 重连 ------------------------
  // 用 ffmpeg 模块自己的注册表杀（与"应用退出时统一收口"是同一条路径），
  // 于是录像器看到的正是"进程没了、文件不长"这个真实场景。
  // 主进程被整体打包，`killAllFfmpeg()` 拿不到，所以按进程名杀 —— 效果与"码流断了、
  // ffmpeg 退出"完全一样（录像器只看"进程在不在 + 文件还长不长"）。
  const killResult = require('node:child_process').spawnSync(
    process.platform === 'win32' ? 'taskkill' : 'pkill',
    process.platform === 'win32' ? ['/F', '/IM', 'ffmpeg.exe'] : ['-f', 'ffmpeg'],
    { encoding: 'utf8' }
  )
  const killOutput = String(killResult.stdout ?? '') + String(killResult.stderr ?? '')
  // Windows 的 taskkill: 0 = 杀到了，128 = 没找到进程。**不能**去数输出里出现几次
  // "ffmpeg"：失败信息里也有这个词（第一跑就是这么把 0 报成 1 的）。
  const killedAny = killResult.status === 0
  log('killed       : ' + (killedAny ? '已杀掉 ffmpeg' : '没有 ffmpeg 可杀') + '（' + killOutput.trim().split('\n')[0] + '）')
  if (!killedAny) {
    problems.push('没有 ffmpeg 可杀 —— 录像器没在跑（或 ffmpeg 已经退出）')
  }

  const afterKill = recorder.statusOfDevice(DEVICE.deviceId)
  log('status(kill) : ' + JSON.stringify(afterKill))

  // 看门狗阈值 20 秒 + 退避，给足时间让它重启一轮。
  await sleep(30_000)
  const recovered = recorder.statusOfDevice(DEVICE.deviceId)
  log('status(+30s) : ' + JSON.stringify(recovered))
  /*
   * 判据是**"换了一轮并且重新在长"**，不是 `attempt >= 1`：
   * 退避档位在"文件重新变大"时会被主动归零（那是设计），所以重连成功后 attempt 反而是 0。
   * 第一跑就是拿 attempt 当判据，把一个正常工作的重连判成了失败。
   */
  const restarted = (recovered?.runStartedAt ?? 0) > (afterKill?.runStartedAt ?? 0)
  if (!restarted) {
    problems.push('杀掉 ffmpeg 之后没有重新拉起一轮（runStartedAt 没变）')
  }
  const afterRecover = listSegments()
  const newest = afterRecover[afterRecover.length - 1]
  const grewAgain =
    recovered?.state === 'recording' && (recovered?.lastGrowthAt ?? 0) > (recovered?.runStartedAt ?? 0)
  log('segments(+30s): ' + afterRecover.length + '（最新 ' + String(newest?.name) + '）')
  if (!grewAgain) problems.push('重连之后没有再观察到文件在长（状态 ' + String(recovered?.state) + '）')

  // ---- 3. 停止：最后一片必须被登记（这条曾经真的丢过）-----------------------
  const beforeStop = Number(
    services.db
      .prepare(`SELECT COUNT(*) AS total FROM recordings WHERE recording_type = 'scheduled'`)
      .get()?.total ?? 0
  )
  await recorder.stop(DEVICE.deviceId)
  const filesOnDisk = listSegments()
  const afterStop = Number(
    services.db
      .prepare(`SELECT COUNT(*) AS total FROM recordings WHERE recording_type = 'scheduled'`)
      .get()?.total ?? 0
  )
  log('stop         : 盘上 ' + filesOnDisk.length + ' 片 / 库里 ' + beforeStop + ' → ' + afterStop + ' 条')
  if (afterStop < filesOnDisk.length) {
    problems.push(
      '停完之后库里比盘上少 ' +
        (filesOnDisk.length - afterStop) +
        ' 片（最后那一片没被登记 —— 正是要防的那个缺陷）'
    )
  }
  const stillPlayable = filesOnDisk.filter((segment) => !segment.ok)
  if (stillPlayable.length > 0) {
    problems.push('停止后有片段打不开：' + stillPlayable.map((s) => s.name).join(', '))
  }

  log('')
  log('problems     : ' + problems.length)
  for (const problem of problems) log('  ! ' + problem)
  app.exit(problems.length > 0 ? 1 : 0)
})
