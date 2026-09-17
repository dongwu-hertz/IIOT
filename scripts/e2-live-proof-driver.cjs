'use strict'
/**
 * PROOF DRIVER — 在 Electron 主进程里跑，被 `scripts/e2-live-proof.cjs` 通过两行 wrapper 挂上。
 *
 * 它只做一件事：等窗口起来之后，在**渲染层**用应用自己的 IPC 桥（`window.api.*`）对着
 * 一台**真设备**走完「拉」通道，并把每一步的原话打出来：
 *
 *   devices.probe        → 登录 + `/get_device_basic_params`（这一步就验了口令摘要）
 *   devices.add          → 真落库（落进这一次性 profile 的库）
 *   e2.status            → `/system` 判代次 + `/workmode` + 设备信息 + 通道数
 *   e2.syncAlarms        → 告警日志 + 录音下载（幂等）
 *   alarms/recordings    → 读回本机库，确认"真的落进去了"
 *
 * 为什么走 IPC 而不是直接 new 服务：这一条链的每一环（权限、凭据、落库、存储护栏）都在
 * IPC 后面；绕过去就少验了一半。渲染层里也没有任何"测试专用"代码 —— 用的就是界面用的那几个方法。
 */

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const CONFIG = JSON.parse(process.env.HZ_E2_LIVE_PROOF || '{}')
const OUT = CONFIG.out
const problems = []
const log = (message) => process.stdout.write('[e2] ' + message + '\n')

/** 出厂账号 + 首次改密：一次性 profile 起来时还没有任何会话，写操作需要管理员会话。 */
function buildSignInScript() {
  return (
    '(async () => { try {' +
    "  const login = await window.api.auth.login({ username: 'admin', password: 'Hz@123456' });" +
    "  if (!login.success) return JSON.stringify({ step: 'login', code: login.error.code });" +
    '  if (login.data.mustChangePassword) {' +
    '    const changed = await window.api.auth.changePassword({' +
    "      currentPassword: 'Hz@123456'," +
    "      newPassword: 'e2-live-proof-pass'" +
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

/** 渲染层脚本：所有等待都在里面，返回一个 JSON。 */
function buildScript() {
  return (
    '(async () => {' +
    'const wait = (ms) => new Promise((r) => setTimeout(r, ms));' +
    'const out = { steps: [] };' +
    'const unwrap = (result) => (result && result.success ? result.data : undefined);' +
    'const reason = (result) => (result && result.success ? "" : JSON.stringify(result && result.error));' +
    'try {' +
    /*
     * 0) **先确认存储根目录在这一次性 profile 里**，不在就换掉。
     *    这一步是给操作员的存储目录上的一道保险：真机验证要下载录音，而"下载到别人的库里"
     *    是不可接受的副作用。一次性 profile 的存储根本来就应该在临时目录里 —— 万一不是
     *    （例如某个默认值指向固定路径），这里显式改成 SAFE_STORAGE，并如实报出来。
     */
    '  const settingsBefore = unwrap(await window.api.settings.get());' +
    '  out.storageRootBefore = settingsBefore ? settingsBefore.storageRoot : null;' +
    '  if (!out.storageRootBefore || out.storageRootBefore.indexOf(PROFILE_DIR) !== 0) {' +
    '    const moved = await window.api.settings.update({ storageRoot: SAFE_STORAGE });' +
    '    out.storageRootMoved = !!(moved && moved.success);' +
    '    out.storageRootAfter = SAFE_STORAGE;' +
    '  } else {' +
    '    out.storageRootMoved = false;' +
    '    out.storageRootAfter = out.storageRootBefore;' +
    '  }' +
    '  out.steps.push("storage");' +
    // 1) 探活：这一步就把"口令摘要到底是哪一种"验掉了（客户端先加盐、401 再不加盐）。
    /*
     * **不带 `kind`**（业主 2026-09-17 第 2 条）：界面不再让人选机型，探活自己按
     * `AUTO_PROBE_ORDER`（声纹 → 听诊盒子族 → 相机）依次试，所以真机上这一条验的是
     * **自动识别到底认不认得出这台 SN-16**。识别结果由 `probe.kind` 报回来。
     */
    '  const probed = await window.api.devices.probe({' +
    '    ip: TARGET_IP, httpPort: TARGET_PORT,' +
    '    username: TARGET_USER, password: TARGET_PASSWORD });' +
    '  out.probeOk = !!(probed && probed.success);' +
    '  out.probeError = reason(probed);' +
    '  const probe = unwrap(probed);' +
    '  out.probe = probe ? { reachable: probe.reachable, latencyMs: probe.latencyMs,' +
    '    authStrategy: probe.authStrategy, alreadyRegistered: probe.alreadyRegistered,' +
    '    kind: probe.kind || null, info: probe.info || null } : null;' +
    '  out.steps.push("probe");' +
    '  if (!out.probeOk) return JSON.stringify(out);' +
    // 2) 加进来（真落库；落进一次性 profile 的库）；安装信息一起录（第 1 条）。
    '  const installInput = {' +
    '    gisLatitude: 31.2304, gisLongitude: 121.4737, azimuthDeg: 135, soundLevelDb: 63.5 };' +
    '  const added = await window.api.devices.add({' +
    '    ip: TARGET_IP, httpPort: TARGET_PORT,' +
    '    username: TARGET_USER, password: TARGET_PASSWORD,' +
    '    installation: installInput });' +
    '  out.addOk = !!(added && added.success);' +
    '  out.addError = reason(added);' +
    '  const device = unwrap(added);' +
    '  out.device = device ? { id: device.id, name: device.name, kind: device.kind,' +
    '    deviceUid: device.deviceUid, kindNote: device.connectionType || null,' +
    '    installation: device.installation || null } : null;' +
    '  out.steps.push("add");' +
    '  if (!out.addOk || !device) return JSON.stringify(out);' +
    /*
     * 2b) **读回安装信息**（业主的硬规矩：每个写设备的操作必须读回验证）。
     *     `devices.list()` 是重新查库的那条路，不是 store 里的内存快照。
     */
    '  const relisted = unwrap(await window.api.devices.list()) || [];' +
    '  const again = relisted.find((d) => d.id === device.id) || null;' +
    '  out.installationReadBack = again ? (again.installation || null) : null;' +
    '  out.steps.push("installation-readback");' +
    // 3) 状态：/system 判代次 + /workmode + basic + 通道数
    '  const statusResult = await window.api.e2.status(device.id);' +
    '  out.statusOk = !!(statusResult && statusResult.success);' +
    '  out.statusError = reason(statusResult);' +
    '  const status = unwrap(statusResult);' +
    '  out.status = status || null;' +
    '  out.steps.push("status");' +
    // 4) 同步：告警日志 + 录音（默认不下时频谱图，一条告警最多 10 次请求）
    '  const synced = await window.api.e2.syncAlarms(device.id, {' +
    '    limit: SYNC_LIMIT, downloadAudio: true, downloadSpectrograms: WITH_SPECTROGRAMS });' +
    '  out.syncOk = !!(synced && synced.success);' +
    '  out.syncError = reason(synced);' +
    '  out.outcome = unwrap(synced) || null;' +
    '  out.steps.push("sync");' +
    // 5) 读回本机库：告警与录音
    '  const alarms = await window.api.alarms.query({ deviceId: device.id, limit: 20 });' +
    '  const alarmPage = unwrap(alarms);' +
    '  out.alarms = alarmPage ? alarmPage.items.length : -1;' +
    '  out.firstAlarm = alarmPage && alarmPage.items[0] ? {' +
    '    id: alarmPage.items[0].id, source: alarmPage.items[0].source,' +
    '    severity: alarmPage.items[0].severity, timestamp: alarmPage.items[0].timestamp,' +
    '    deviceAlarmValue: alarmPage.items[0].deviceAlarmValue ?? null,' +
    '    deviceRaw: alarmPage.items[0].deviceRaw ? String(alarmPage.items[0].deviceRaw).slice(0, 200) : null' +
    '  } : null;' +
    '  const recordings = await window.api.recordings.query({ deviceId: device.id, limit: 20 });' +
    '  const page = unwrap(recordings);' +
    '  out.recordings = page ? page.items.length : -1;' +
    '  out.firstRecording = page && page.items[0] ? {' +
    '    id: page.items[0].id, relativePath: page.items[0].relativePath,' +
    '    recordingType: page.items[0].recordingType, sampleRate: page.items[0].sampleRate,' +
    '    fileSize: page.items[0].fileSize || 0, containerFormat: page.items[0].containerFormat || null' +
    '  } : null;' +
    '  out.steps.push("readback");' +
    /*
     * 5b) **告警抓图**（业主 2026-09-17 第 8 批第 2 条）：这一条验的是「抓图路径真的落库了、
     *     而且能按告警取回来」—— 也就是点位图上"点声呐看截图"所依赖的那条链。
     *
     * 三步各自能单独坏掉，所以分开报：
     *   - `snapshot_dir` 有没有写进库（`out.snapshotStates[0]`）；
     *   - 目录里的图还在不在（`state !== 'files-gone'`）；
     *   - 主进程有没有为它们开出可用的回环地址（`files[*].url`）。
     * 张数**不硬编码 3**：手册说最多 3 张，重启后可能只剩一部分，少于 3 张是正常的 ——
     * 这条链要证明的是"有几张就能取几张"，不是"一定有 3 张"。
     */
    '  out.snapshotStates = [];' +
    '  out.snapshotFiles = 0;' +
    '  if (out.firstAlarm && out.firstAlarm.id) {' +
    '    const shots = await window.api.e2.alarmSnapshots(device.id, out.firstAlarm.id);' +
    '    out.snapshotOk = !!(shots && shots.success);' +
    '    out.snapshotError = reason(shots);' +
    '    const view = unwrap(shots) || null;' +
    '    out.snapshotView = view ? { state: view.state, relativeDir: view.relativeDir || null,' +
    '      files: (view.files || []).map((f) => ({ name: f.name, loopback: f.url.indexOf("http://127.0.0.1:") === 0 }))' +
    '    } : null;' +
    '    if (view) {' +
    '      out.snapshotStates.push(view.state);' +
    '      out.snapshotFiles = (view.files || []).length;' +
    '    }' +
    '    await window.api.e2.closeSnapshots();' +
    '    out.steps.push("snapshots");' +
    '  }' +
    /*
     * 6) **PTZ 球机联动**：读一次 → 把**当前值原样写回** → 再读回来比对（业主 2026-09-17 第 8 批
     *    明确同意在真机上做这一次写入）。
     *
     * 为什么"原样写回"是有意义的验证：`PUT /system` 是**整份参数回写**，而这一条同时证明了
     * 三件事 —— 写通道在真机上通（不是 404/400）、整份回写**没有把别的参数改坏**（写前写后
     * 逐键比）、以及写完之后 `GET /system` 读回来的就是我们要求的值（读回核对在真机上成立）。
     * 语义上什么都没改：写进去的就是设备当时给的那一份。
     */
    '  const ptzBefore = unwrap(await window.api.e2.ptz(device.id));' +
    '  out.ptzBefore = ptzBefore || null;' +
    '  out.steps.push("ptz-read");' +
    '  if (ptzBefore) {' +
    '    const patch = {};' +
    '    if (ptzBefore.enabled !== undefined) patch.enabled = ptzBefore.enabled;' +
    '    if (ptzBefore.cameraIp !== undefined) patch.cameraIp = ptzBefore.cameraIp;' +
    '    if (ptzBefore.cameraPort !== undefined) patch.cameraPort = ptzBefore.cameraPort;' +
    '    if (ptzBefore.cameraUser !== undefined) patch.cameraUser = ptzBefore.cameraUser;' +
    '    if (ptzBefore.directionSameAsSonar !== undefined)' +
    '      patch.directionSameAsSonar = ptzBefore.directionSameAsSonar;' +
    '    if (ptzBefore.saveSnapshot !== undefined) patch.saveSnapshot = ptzBefore.saveSnapshot;' +
    '    if (ptzBefore.realtimeChannel !== undefined)' +
    '      patch.realtimeChannel = ptzBefore.realtimeChannel;' +
    '    const ptzWrite = await window.api.e2.updatePtz(device.id, patch);' +
    '    out.ptzWriteOk = !!(ptzWrite && ptzWrite.success);' +
    '    out.ptzWriteError = reason(ptzWrite);' +
    '    const ptzOutcome = unwrap(ptzWrite);' +
    '    out.ptzOutcome = ptzOutcome || null;' +
    '    out.steps.push("ptz-write");' +
    '  }' +
    '  await wait(200);' +
    '  return JSON.stringify(out);' +
    '} catch (error) {' +
    '  out.threw = String((error && error.message) || error);' +
    '  return JSON.stringify(out);' +
    '}' +
    '})()'
  )
    .replace(/TARGET_IP/g, JSON.stringify(CONFIG.ip))
    .replace(/TARGET_PORT/g, String(Number(CONFIG.port) || 80))
    .replace(/TARGET_USER/g, JSON.stringify(CONFIG.username))
    .replace(/TARGET_PASSWORD/g, JSON.stringify(CONFIG.password))
    .replace(/SYNC_LIMIT/g, String(Number(CONFIG.limit) || 5))
    .replace(/WITH_SPECTROGRAMS/g, CONFIG.spectrograms === true ? 'true' : 'false')
    .replace(/PROFILE_DIR/g, JSON.stringify(CONFIG.profileDir || ''))
    .replace(/SAFE_STORAGE/g, JSON.stringify(path.join(CONFIG.profileDir || OUT, 'e2-proof-storage')))
}

/** 把下载到的文件（在这一次性 profile 的存储目录里）报出来，含它在磁盘上的真实大小。 */
function reportFiles(storageRoot) {
  if (typeof storageRoot !== 'string' || storageRoot === '') {
    log('storage    : 没读到存储根目录')
    return
  }
  const root = path.join(storageRoot, 'audio')
  if (!fs.existsSync(root)) {
    log('storage    : ' + storageRoot + ' 下没有 audio 目录（这一台可能没有录音文件可下）')
    return
  }
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push({ file: path.relative(storageRoot, full), bytes: fs.statSync(full).size })
    }
  }
  walk(root)
  log('storage    : ' + storageRoot)
  log('files      : ' + JSON.stringify(found))
}

app.whenReady().then(async () => {
  try {
    const window = await new Promise((resolve) => {
      const existing = BrowserWindow.getAllWindows()[0]
      if (existing) return resolve(existing)
      const timer = setInterval(() => {
        const first = BrowserWindow.getAllWindows()[0]
        if (first) {
          clearInterval(timer)
          resolve(first)
        }
      }, 200)
    })

    // 等一次加载完成 + 会话恢复（探针里用的就是界面用的那几个 IPC）。
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // 一次性 profile 起来时还没有会话：写操作（加设备/同步）要管理员会话，先登进去。
    const signIn = JSON.parse(await window.webContents.executeJavaScript(buildSignInScript()))
    log('sign in    : ' + JSON.stringify(signIn))
    if (signIn.step !== 'changed' && signIn.step !== 'already-signed-in') {
      problems.push('在一次性 profile 里登录失败：' + JSON.stringify(signIn))
    }
    await new Promise((resolve) => setTimeout(resolve, 600))

    const raw = await window.webContents.executeJavaScript(buildScript())
    const result = JSON.parse(raw)

    log('device     : ' + CONFIG.username + '@' + CONFIG.ip + ':' + CONFIG.port)
    log('probe      : ' + JSON.stringify({ ok: result.probeOk, error: result.probeError, probe: result.probe }))
    log('add        : ' + JSON.stringify({ ok: result.addOk, error: result.addError, device: result.device }))
    log('install    : ' + JSON.stringify({
      typed: {
        gisLatitude: 31.2304,
        gisLongitude: 121.4737,
        azimuthDeg: 135,
        soundLevelDb: 63.5
      },
      readBack: result.installationReadBack
    }))
    log('status     : ' + JSON.stringify({ ok: result.statusOk, error: result.statusError }))
    if (result.status) {
      log('  variant  : ' + String(result.status.variant))
      log('  mode     : ' + JSON.stringify({ mode: result.status.mode, raw: result.status.rawWorkMode }))
      log('  channels : ' + JSON.stringify({ channelCount: result.status.channelCount, retention: result.status.alarmLogRetention }))
      log('  basic    : ' + JSON.stringify(result.status.basic))
      log('  params   : ' + JSON.stringify(result.status.params))
      if (result.status.paramsError) log('  paramsError: ' + result.status.paramsError)
    }
    log('sync       : ' + JSON.stringify({ ok: result.syncOk, error: result.syncError }))
    if (result.outcome) log('  outcome  : ' + JSON.stringify(result.outcome))
    log('readback   : ' + JSON.stringify({
      alarms: result.alarms,
      recordings: result.recordings,
      firstAlarm: result.firstAlarm,
      firstRecording: result.firstRecording
    }))
    if (result.threw) log('threw      : ' + result.threw)
    log('snapshots  : ' + JSON.stringify({
      ok: result.snapshotOk,
      error: result.snapshotError,
      states: result.snapshotStates,
      files: result.snapshotFiles,
      view: result.snapshotView
    }))
    log('ptz before : ' + JSON.stringify(result.ptzBefore))
    log('ptz write  : ' + JSON.stringify({ ok: result.ptzWriteOk, error: result.ptzWriteError }))
    if (result.ptzOutcome) {
      log('  applied  : ' + result.ptzOutcome.allApplied)
      log('  fields   : ' + JSON.stringify(result.ptzOutcome.fields))
      log('  readBack : ' + JSON.stringify(result.ptzOutcome.readBack))
    }
    log('steps      : ' + JSON.stringify(result.steps))
    log('storage    : ' + JSON.stringify({
      before: result.storageRootBefore,
      moved: result.storageRootMoved,
      after: result.storageRootAfter
    }))
    reportFiles(result.storageRootAfter)

    if (!result.probeOk) problems.push('探活失败：' + result.probeError)
    if (!result.addOk) problems.push('加设备失败：' + result.addError)
    if (result.probe && result.probe.reachable === false) {
      problems.push('设备不可达（探活回了 reachable:false）')
    }
    /*
     * 第 2 条：**探活没带 kind**，所以这一条验的是"自动识别到底认不认得出这台设备"。
     * 认错了后果很重（整套协议不对 → 表现成"设备没响应"，操作员会去查网线），
     * 所以这里要求它**恰好**认出 `auscultationBox`，而不是"不报错就行"。
     */
    if (result.probe && result.probe.kind !== 'auscultationBox') {
      problems.push(
        '自动识别没有认出这是听诊盒子族（第 2 条）：probe.kind = ' + JSON.stringify(result.probe.kind)
      )
    }
    /*
     * 第 1 条：安装信息**写进去之后从库里读回来**必须逐项相等（业主的硬规矩：
     * 每个写设备的操作必须读回验证）。读回走的是 `devices.list()`（重新查库那条路）。
     */
    {
      const typed = {
        gisLatitude: 31.2304,
        gisLongitude: 121.4737,
        azimuthDeg: 135,
        soundLevelDb: 63.5
      }
      if (JSON.stringify(result.installationReadBack) !== JSON.stringify(typed)) {
        problems.push(
          '安装信息读回不是录入的值：' + JSON.stringify(result.installationReadBack) +
            '（期望 ' + JSON.stringify(typed) + '）'
        )
      }
    }
    if (result.statusOk !== true) problems.push('读状态失败：' + result.statusError)
    if (result.syncOk !== true) problems.push('同步失败：' + result.syncError)
    /*
     * 抓图（第 8 批第 2 条）：`state` 只有两种可接受的结果 ——
     *   - `ok`：库里有目录、磁盘上有图、每张都有回环地址；
     *   - `not-captured`：**设备上本来就没有**（这台设备没开"告警时保存抓图"、
     *     球机没配对，或同步时没打开抓图下载）—— 那是设备事实，不是我们的失败。
     * `files-gone`（库里记着、文件不在）是**必须报出来**的：那说明存储被动过。
     */
    if (result.firstAlarm && result.firstAlarm.id) {
      const states = Array.isArray(result.snapshotStates) ? result.snapshotStates : []
      const state = states[0]
      if (result.snapshotOk !== true) {
        problems.push('取抓图失败：' + result.snapshotError)
      } else if (state === 'files-gone') {
        problems.push('库里记着这条告警有抓图，但磁盘上的文件不见了（换过存储根目录或被清理）')
      } else if (state === 'ok') {
        if (!(result.snapshotFiles > 0)) problems.push('抓图状态是 ok 却一张图都没有')
        const view = result.snapshotView || {}
        const allLoopback = (view.files || []).every((file) => file.loopback === true)
        if (!allLoopback) {
          problems.push('抓图的地址不是本机回环地址：' + JSON.stringify(view.files))
        }
        log('note       : 抓图 ' + result.snapshotFiles + ' 张，目录 ' + JSON.stringify(view.relativeDir))
      } else if (state !== 'not-captured') {
        problems.push('抓图状态看不懂：' + JSON.stringify(states))
      } else {
        log('note       : 这条告警在设备上没有抓图（设备事实）—— 点位图上会照实这么说')
      }
    }
    if (result.alarms === 0 && result.outcome && result.outcome.logsSeen > 0) {
      problems.push('设备报了日志，但本机库一条告警都没有 —— 解析或落库有问题')
    }
    /*
     * 录音：**分两种情况说**，不能一律要求"有文件"。
     *
     * 有的设备上媒体文件已经被保留策略清掉了（2026-09-17 实测那台 SN-16：1001 条记录里
     * 只有 6 条 `files_status=1`，而这 6 条的音频/抓图也全 404 —— 设备自己的网页播放器同样
     * 取不到）。那时正确的行为是**如实报"文件没了"**，而不是把探针判成失败。
     * 但如果它下了文件（`audioSaved > 0`），那就必须是一段真 WAV（表头读得出采样率与长度）。
     */
    const outcome = result.outcome || {}
    if (outcome.audioSaved > 0 && result.firstRecording) {
      if (result.firstRecording.fileSize <= 44) {
        problems.push('录音文件只有 WAV 头：' + result.firstRecording.fileSize)
      }
      if (!(result.firstRecording.sampleRate > 0)) {
        problems.push('录音的采样率没读到（应当是 WAV 表头里的值）')
      }
    } else if (outcome.logsSeen > 0 && !(outcome.filesMissing + outcome.audioFailed + outcome.audioExisting > 0)) {
      // 有日志、却一个文件都没下、也没说为什么 —— 那是静默失败（最坏的一种）。
      problems.push('同步既没下到录音，也没报告为什么：' + JSON.stringify(outcome))
    } else if (outcome.filesMissing > 0) {
      log(
        'note       : 这台设备上有 ' + outcome.filesMissing +
          ' 条告警的媒体文件已经不在了（保留策略/未落盘）；本机只登记了告警行与待认领的录音行'
      )
    }
    /*
     * **存储根目录必须在这一次性 profile 里**：真机验证会下载录音，落到操作员的真实
     * 存储目录里是不可接受的副作用。这一条是那道保险的守卫。
     */
    const profileDir = CONFIG.profileDir || ''
    if (typeof result.storageRootAfter !== 'string' || result.storageRootAfter.indexOf(profileDir) !== 0) {
      problems.push(
        '存储根目录不在这一次性 profile 里（' + result.storageRootAfter +
          '）：真机验证会往别的地方写文件'
      )
    }

    log('problems   : ' + problems.length)
    for (const problem of problems) log('  ! ' + problem)

    // 报告也落一份盘：真机验证的结果常常要贴给别人看。
    fs.writeFileSync(
      path.join(OUT, 'e2-live-proof.json'),
      JSON.stringify({ at: new Date().toISOString(), device: CONFIG.ip, result, problems }, null, 2),
      'utf8'
    )

    app.exit(problems.length ? 1 : 0)
  } catch (error) {
    log('FATAL: ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
