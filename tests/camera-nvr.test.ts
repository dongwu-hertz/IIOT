/**
 * 相机 NVR 交互：右键菜单规则、手动录像、抓图、告警请求整形。
 *
 * 三层风险，三层测试：
 *   1. **纯规则**（无 I/O、无 ffmpeg、无相机）：菜单项何时可用、为什么不可用，以及
 *      文件名/目录的推导。这三件事都必须只有一处实现，所以直接断言它们。
 *   2. **注入假 ffmpeg 的行为**：开始两次、没开始就停、0 字节产物、应用退出时的
 *      收尾。这些路径在真机上很难稳定复现，而它们正是「文件坏了却自称成功」的来源。
 *   3. **真二进制测试**：用 `-f lavfi -i testsrc` 生成合成源录一段文件，断言产物是
 *      可播放的 MP4（`ftyp` + 非零 + `moov`）。真机 RTSP 的验证见
 *      `docs/FA371-INTEGRATION.md` §7.1 与 `.camera-nvr-live-check.cjs`。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { promises as fs, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { StorageService } from '../src/main/services/storage/storage-service'
import { RecordingRepository } from '../src/main/services/database/alarm-repository'
import { openDatabase } from '../src/main/services/database/schema'
import {
  CameraCaptureService,
  buildManualRecordArgs,
  buildSnapshotArgs,
  probeJpegFile,
  probeMp4File
} from '../src/main/services/media/camera-capture'
import {
  buildSyntheticTestArgs,
  liveFfmpegCount,
  spawnFfmpeg,
  type FfmpegChild,
  type FfmpegProcess
} from '../src/main/services/media/ffmpeg'
import {
  CAMERA_NVR_ACTIONS,
  CAMERA_NVR_SUBMENU_ACTIONS,
  buildCameraNvrMenu,
  cameraCaptureReadiness,
  cameraMediaFileName,
  type CameraNvrEnvironment
} from '../src/shared/domain/camera-nvr'
import { VideoFileServer } from '../src/main/services/media/video-file-server'
import type { CameraLiveState } from '../src/shared/domain/camera-live'
import {
  CameraAlarmService,
  buildConditionWriteDto,
  buildStrategyCreateDto,
  buildStrategyUpdateDto,
  strategyIdAsNumber,
  type CameraAlarmOperations
} from '../src/main/services/device/fa371/camera-alarm-service'
import {
  emptyConditionDraft,
  emptyStrategyDraft,
  strategyDraftFrom,
  validateStrategyDraft
} from '../src/shared/domain/camera-alarm'
import type {
  Fa371AlarmConditionPageDto,
  Fa371AlarmStrategyPageDto
} from '../src/main/services/device/fa371/dto'
import type { Database as SqliteDatabase } from 'better-sqlite3'

const DEVICE_ID = 'dev-camera-1'
const DEVICE_UID = 'FA371-TEST-0001'
const RTSP_URL = 'rtsp://192.168.110.235:443/live'

let root: string
let db: SqliteDatabase
let storage: StorageService
let recordings: RecordingRepository

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-camera-nvr-'))
  db = openDatabase({ file: ':memory:' })
  storage = new StorageService({ db, getStorageRoot: () => root, getMinFreeBytes: () => 0 })
  recordings = new RecordingRepository(db)
  // recordings.device_id 有外键约束，真实运行里设备一定存在。这里补一行，
  // 而不是把外键关掉：关掉就等于测试不再验证真实约束。
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, connection_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'LAN', 'ONLINE', ?, ?)`
  ).run(DEVICE_ID, DEVICE_UID, 'camera 1', Date.now(), Date.now())
})

after(async () => {
  try {
    db.close()
  } catch {
    // Already closed.
  }
  await fs.rm(root, { recursive: true, force: true })
  assert.equal(liveFfmpegCount(), 0, 'this suite left an ffmpeg child behind')
})

// ---------------------------------------------------------------------------
// 1. 菜单规则（纯函数）
// ---------------------------------------------------------------------------

function liveState(overrides: Partial<CameraLiveState> = {}): CameraLiveState {
  return {
    deviceId: DEVICE_ID,
    status: 'playing',
    url: 'http://127.0.0.1:5000/token/stream.mp4',
    rtspUrl: RTSP_URL,
    mode: 'remux',
    startedAt: Date.now(),
    ...overrides
  }
}

const ENV: CameraNvrEnvironment = {
  deviceName: 'camera 1',
  recording: false,
  fullscreen: false,
  hasUsableSource: true,
  // 设备族能力：声学相机有实时视频与告警模型。
  capabilities: { liveVideo: true, alarmModel: true }
}

function itemFor(
  state: CameraLiveState | null,
  action: string,
  env: CameraNvrEnvironment = ENV
) {
  const item = buildCameraNvrMenu(state, env).find((candidate) => candidate.action === action)
  assert.ok(item, `menu must contain ${action}`)
  return item
}

/** 叶子项（含二级菜单里的）：抓图与录像现在收在「抓图 / 录像」子菜单下。 */
function leafFor(state: CameraLiveState | null, action: string, env = ENV) {
  const items = buildCameraNvrMenu(state, env)
  for (const item of items) {
    if (item.action === action) return item
    const child = item.submenu?.find((candidate) => candidate.action === action)
    if (child) return child
  }
  assert.fail(`menu must contain ${action}`)
}

describe('context menu enablement (the single rule)', () => {
  it('enables recording and snapshot while playing', () => {
    assert.equal(cameraCaptureReadiness(liveState()).ready, true)
    assert.equal(leafFor(liveState(), 'toggle-recording').enabled, true)
    assert.equal(leafFor(liveState(), 'snapshot').enabled, true)
  })

  it('groups the capture variants into a depth-2 submenu', () => {
    const menu = buildCameraNvrMenu(liveState(), ENV)
    const capture = menu.find((item) => item.action === 'capture')
    assert.ok(capture?.submenu, '抓图/录像应当是二级菜单')
    assert.deepEqual(
      capture.submenu.map((child) => child.action),
      ['toggle-recording', 'snapshot']
    )
    // 菜单最深两层：子项自己不得再带子菜单。
    for (const item of menu) {
      for (const child of item.submenu ?? []) {
        assert.equal(child.submenu, undefined, `${String(child.action)} 不能有第三层`)
      }
    }
  })

  it('hides what the device family cannot do at all, instead of greying it', () => {
    // 声纹设备：没有实时视频、也没有告警策略/条件模型 —— 整份菜单应当是空的，
    // 而不是一屏「设备做不到」的灰项（参考 iVMS-4200：不可用即不出现）。
    const box = { ...ENV, capabilities: { liveVideo: false, alarmModel: false } }
    assert.deepEqual(buildCameraNvrMenu(liveState(), box), [])

    // 有视频但没有告警模型：告警配置**不出现**，其余保留。
    const noAlarm = { ...ENV, capabilities: { liveVideo: true, alarmModel: false } }
    const actions = buildCameraNvrMenu(liveState(), noAlarm).map((item) => item.action)
    assert.ok(!actions.includes('alarm-config'))
    assert.ok(actions.includes('capture'))
  })

  it('sorts the device-side action last', () => {
    const actions = buildCameraNvrMenu(liveState(), ENV).map((item) => item.action)
    // 告警配置写的是设备，其他都是本地动作，因此它必须排在最后。
    assert.equal(actions[actions.length - 1], 'alarm-config')
  })

  it('adds nothing for callers that declare only the two original capabilities', () => {
    /*
     * 回归钉子：新增「本机录像回放 / 下载检测记录」两项时，**既有页面**
     * （`MonitorView` 只声明 `liveVideo` + `alarmModel`）看到的菜单必须与扩展前
     * 逐项相同。这条断言是「新增菜单项对既有页面零影响」的唯一证据——没有它，
     * 一个新项就会在任何还没实现对应弹窗的页面上变成一个点了没反应的死项。
     */
    const actions = buildCameraNvrMenu(liveState(), ENV).map((item) => item.action)
    assert.deepEqual(actions, [
      'capture',
      'toggle-fullscreen',
      'copy-rtsp',
      'open-external',
      'alarm-config'
    ])
    assert.ok(!actions.includes('playback'))
    assert.ok(!actions.includes('download-detect'))
    // 「显示方式」同理：它是画面格的能力，这一组能力里没有声明，整项不出现。
    assert.ok(!actions.includes('display'))
  })

  it('exposes playback and detect-download only where the screen declares them', () => {
    const full = {
      ...ENV,
      capabilities: {
        liveVideo: true,
        alarmModel: true,
        localPlayback: true,
        detectDownload: true,
        tileClose: true
      }
    }
    const actions = buildCameraNvrMenu(liveState(), full).map((item) => item.action)
    assert.deepEqual(actions, [
      'capture',
      'toggle-fullscreen',
      'copy-rtsp',
      'open-external',
      'playback',
      'download-detect',
      'close-tile',
      'alarm-config'
    ])
    // 顺序规则不变：回放/下载是本机动作，仍然排在**设备侧**的告警配置之前。
    assert.equal(actions[actions.length - 1], 'alarm-config')

    /*
     * 两项都是「打开一个选择器」，而「这台相机还没有本机录像」「设备上没有检测
     * 记录」是选择器自己要说的事。本函数是纯的、不做 I/O，凭空判一个可用性就是猜，
     * 所以两项恒为可点——这里把它钉住，免得以后有人给它加一个拍脑袋的 `enabled`。
     */
    assert.equal(itemFor(liveState(), 'playback', full).enabled, true)
    assert.equal(itemFor(liveState(), 'download-detect', full).enabled, true)
    assert.equal(itemFor(liveState(), 'playback', full).separatorBefore, true)
  })

  it('keeps every emitted action inside the declared action vocabulary', () => {
    /*
     * 菜单项与派发（`onMenuSelect`）之间唯一的契约就是 action id：一个字面量打字
     * 错误会让一个菜单项永远落进 `default`（点了没反应）。这里用词汇表钉住。
     *
     * 词汇表是**两个**常量而不是一个，这一点是刻意的：
     *   - `CAMERA_NVR_ACTIONS` 是**派发**用的词表（`CameraNvrAction`，视图的 switch
     *     按它分发）；
     *   - `CAMERA_NVR_SUBMENU_ACTIONS` 只包含纯分组父项。`capture` 就是这样一个
     *     父项：`VideoContextMenu.activate()` 里 `item.submenu !== undefined` 直接
     *     return，所以它**永远不会**被派发，把它塞进 `CameraNvrAction` 反而会让
     *    视图的 switch 多出一个不可达分支。
     * 两层（父项 + 子项）都按这个合并后的词表校验。
     */
    const vocabulary: readonly string[] = [...CAMERA_NVR_ACTIONS, ...CAMERA_NVR_SUBMENU_ACTIONS]
    const full = {
      ...ENV,
      capabilities: {
        liveVideo: true,
        alarmModel: true,
        localPlayback: true,
        detectDownload: true,
        tileClose: true,
        // 画面墙那一组：把「显示方式」也点亮，否则词表里那五个 action 谁也不产出。
        cellViews: true
      }
    }
    const seen = new Set<string>()
    for (const item of buildCameraNvrMenu(liveState(), full)) {
      seen.add(item.action as string)
      for (const child of item.submenu ?? []) seen.add(child.action as string)
    }
    for (const action of seen) {
      assert.ok(vocabulary.includes(action), `${action} 不在菜单动作词表里`)
    }
    // 合并后的词表必须**全部**被用到：一个谁也不产出的词表项意味着有人删菜单项时
    // 忘了删词表，下一个人就会照着它写出一个永远不出现的分支。
    assert.deepEqual([...seen].sort(), [...vocabulary].sort())
  })

  it('disables both when RTSP is off, and carries the device fact as the reason', () => {
    const state = liveState({
      status: 'rtsp-disabled',
      error: 'camera RTSP is off (device reports rtsp_enabled=0)'
    })
    for (const action of ['toggle-recording', 'snapshot']) {
      const item = leafFor(state, action)
      assert.equal(item.enabled, false)
      assert.equal(
        item.labelKey,
        action === 'snapshot' ? 'cameraNvrUi.menuSnapshot' : 'cameraNvrUi.menuStartRecording'
      )
      assert.equal(item.disabledReasonKey, 'cameraNvrUi.reasonRtspDisabled')
      // 主进程的诊断原文必须原样带上：通用文案说不出设备到底怎么了。
      assert.match(item.disabledReasonText ?? '', /rtsp_enabled=0/)
      // P0-4：菜单项与面板按钮必须读同一份原因（`cameraCaptureReadiness`），
      // 否则同一个被挡住的动作会有两种说法，迟早漂移。
      const readiness = cameraCaptureReadiness(state)
      assert.equal(item.disabledReasonKey, readiness.reasonKey)
      assert.equal(item.disabledReasonText, readiness.reasonText)
    }
  })

  it('gives every other failure state its own reason key', () => {
    const expected: Record<string, string> = {
      idle: 'cameraNvrUi.reasonIdle',
      starting: 'cameraNvrUi.reasonStarting',
      'ffmpeg-missing': 'cameraNvrUi.reasonFfmpegMissing',
      error: 'cameraNvrUi.reasonError'
    }
    for (const [status, key] of Object.entries(expected)) {
      const state = liveState({ status: status as CameraLiveState['status'] })
      const item = leafFor(state, 'snapshot')
      assert.equal(item.enabled, false, `${status} must not allow a snapshot`)
      assert.equal(item.disabledReasonKey, key)
      assert.equal(cameraCaptureReadiness(state).ready, false)
    }
    // 没有状态（还没选设备）也必须是「不可以」，而不是「可以试试」。
    assert.equal(cameraCaptureReadiness(null).ready, false)
    assert.equal(leafFor(null, 'toggle-recording').disabledReasonKey, 'cameraNvrUi.reasonIdle')
  })

  it('reads "stop recording" while recording, and stays stoppable after a failure', () => {
    const state = liveState({ status: 'error', error: 'stream interrupted' })
    const item = leafFor(state, 'toggle-recording', { ...ENV, recording: true })
    assert.equal(item.labelKey, 'cameraNvrUi.menuStopRecording')
    assert.equal(item.enabled, true, 'recording must always be stoppable')
    // 抓图仍然按「有没有画面」判断。
    assert.equal(leafFor(state, 'snapshot', { ...ENV, recording: true }).enabled, false)
  })

  it('requires an address to copy, and a usable session for the external player', () => {
    const noAddress = liveState({ status: 'idle', rtspUrl: undefined })
    const copy = itemFor(noAddress, 'copy-rtsp', { ...ENV, hasUsableSource: false })
    assert.equal(copy.enabled, false)
    assert.equal(copy.disabledReasonKey, 'cameraNvrUi.reasonNoAddress')

    const masked = liveState({ status: 'rtsp-disabled', error: 'rtsp off' })
    assert.equal(itemFor(masked, 'copy-rtsp', { ...ENV, hasUsableSource: false }).enabled, true)

    const external = itemFor(masked, 'open-external', { ...ENV, hasUsableSource: false })
    assert.equal(external.enabled, false)
    assert.equal(external.disabledReasonKey, 'cameraNvrUi.reasonNoSource')
    assert.equal(itemFor(liveState(), 'open-external').enabled, true)
  })

  it('treats full screen as a pure UI toggle', () => {
    assert.equal(
      itemFor(liveState(), 'toggle-fullscreen', { ...ENV, fullscreen: false }).labelKey,
      'cameraNvrUi.menuFullscreen'
    )
    assert.equal(
      itemFor(liveState(), 'toggle-fullscreen', { ...ENV, fullscreen: true }).labelKey,
      'cameraNvrUi.menuExitFullscreen'
    )
    // 告警配置是设备侧配置，与视频状态无关。
    assert.equal(itemFor(null, 'alarm-config').enabled, true)
  })

  it('keeps the item order and grouping stable', () => {
    const menu = buildCameraNvrMenu(liveState(), ENV)
    // 本地动作在前、设备动作（告警配置）在后；分组线把本机组与设备组分开。
    assert.deepEqual(
      menu.map((item) => item.action),
      ['capture', 'toggle-fullscreen', 'copy-rtsp', 'open-external', 'alarm-config']
    )
    assert.deepEqual(
      menu.filter((item) => item.separatorBefore).map((item) => item.action),
      ['alarm-config']
    )
    /*
     * 声明了 `cellViews` 之后（画面墙就是这一组），「显示方式」出现在**外部播放器
     * 之后**、**不带分隔线** —— 它是"这一格怎么画"，不是"对相机做什么"。
     * 「显示/隐藏叠加信息」已按业主 2026-09-21 批整体移除（叠加条永远显示）。
     */
    const wallMenu = buildCameraNvrMenu(liveState(), {
      ...ENV,
      capabilities: { ...ENV.capabilities, cellViews: true }
    })
    assert.deepEqual(
      wallMenu.map((item) => item.action),
      [
        'capture',
        'toggle-fullscreen',
        'copy-rtsp',
        'open-external',
        'display',
        'alarm-config'
      ]
    )
    assert.deepEqual(
      wallMenu.filter((item) => item.separatorBefore).map((item) => item.action),
      ['alarm-config']
    )
  })

  it('「显示方式」：四种视图各一项，当前那一种打 ✓，不支持的灰显并写出原因', () => {
    // 一台相机（画面墙那一组能力）：四种都能画，当前是"播放"。
    const wallEnv: CameraNvrEnvironment = {
      ...ENV,
      capabilities: { ...ENV.capabilities, cellViews: true }
    }
    const camera = itemFor(liveState(), 'display', wallEnv)
    assert.deepEqual(
      (camera.submenu ?? []).map((child) => child.action),
      ['view-play', 'view-timedomain', 'view-spectrum', 'view-spectrogram']
    )
    assert.deepEqual(
      (camera.submenu ?? []).map((child) => child.labelKey),
      [
        'cameraWallUi.viewPlay',
        'cameraWallUi.viewTimedomain',
        'cameraWallUi.viewSpectrum',
        'cameraWallUi.viewSpectrogram'
      ]
    )
    assert.equal(camera.submenu?.every((child) => child.enabled), true, '相机的四种视图都该能点')
    assert.deepEqual(
      (camera.submenu ?? []).map((child) => child.checked),
      [true, false, false, false],
      '当前视图（播放）没有打 ✓'
    )
    // 切到频域图之后 ✓ 跟着走。
    const spectrum = itemFor(liveState(), 'display', { ...wallEnv, cellView: 'spectrum' })
    assert.deepEqual(
      (spectrum.submenu ?? []).map((child) => child.checked),
      [false, false, true, false]
    )
    /*
     * 手填的第三方 RTSP 源只有画面：另外三种**照旧列出、灰显、写出原因** ——
     * 这是本文件里"做不到的不出现"那条规则的一处**有意的例外**：四颗按钮刚从控制条上
     * 被移走，操作员点开菜单就是来问"那几张图去哪了"的，整项消失等于拒绝回答。
     */
    const manual = itemFor(liveState(), 'display', { ...wallEnv, availableViews: ['play'] })
    assert.deepEqual(
      (manual.submenu ?? []).map((child) => child.enabled),
      [true, false, false, false]
    )
    for (const child of (manual.submenu ?? []).slice(1)) {
      assert.equal(child.disabledReasonKey, 'cameraWallUi.viewNeedsCamera')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 命名与路径推导
// ---------------------------------------------------------------------------

describe('file naming and path derivation', () => {
  it('makes lexicographic order equal to chronological order', () => {
    // 本地时间：文件名里的日期就是用户在文件管理器里看到的日期（与音频侧同一套
    // 时间戳格式，见 `storage-service.formatFileStamp`）。
    const base = new Date(2026, 0, 2, 3, 4, 5, 6).getTime()
    const first = cameraMediaFileName({ timestamp: base, kind: 'video' })
    const later = cameraMediaFileName({ timestamp: base + 1, kind: 'video' })
    assert.ok(first < later, `${first} must sort before ${later}`)
    assert.match(first, /^2026-01-02_03-04-05-006\.mp4$/)
  })

  it('lays out kind / uid / year / month / day, like the audio side', () => {
    const target = storage.cameraMediaPaths({
      deviceUid: DEVICE_UID,
      kind: 'video',
      timestamp: Date.UTC(2026, 8, 15, 10, 0, 0, 0)
    })
    assert.equal(target.relativePath.split('/').slice(0, 2).join('/'), `video/${DEVICE_UID}`)
    assert.match(target.relativePath, /^video\/FA371-TEST-0001\/2026\/09\/15\/.+\.mp4$/)
    // 绝对路径必须在存储根内，且能被 resolve() 原样还原（规格 4.1）。
    assert.ok(target.absolutePath.startsWith(root + path.sep))
    assert.equal(storage.resolve(target.relativePath), target.absolutePath)
  })

  it('never overwrites a recording created in the same millisecond', () => {
    const timestamp = Date.UTC(2026, 8, 15, 10, 0, 0, 0)
    const base = cameraMediaFileName({ timestamp, kind: 'video' })
    assert.equal(cameraMediaFileName({ timestamp, kind: 'video', attempt: 0 }), base)
    const second = cameraMediaFileName({ timestamp, kind: 'video', attempt: 1 })
    assert.notEqual(second, base)
    assert.ok(
      second < cameraMediaFileName({ timestamp: timestamp + 1, kind: 'video' }),
      'the attempt suffix must not break chronological order'
    )
    assert.ok(cameraMediaFileName({ timestamp, kind: 'snapshot' }).endsWith('.jpg'))
  })

  it('strips unsafe characters and never lets a path segment escape the root', () => {
    const target = storage.cameraMediaPaths({
      deviceUid: 'camera 1/../etc',
      kind: 'snapshot',
      timestamp: Date.UTC(2026, 8, 15)
    })
    // 关键性质是「没有任何一个路径段是 . 或 ..」，而不是字符串里不含 '..'
    // （`camera_1_.._etc` 这样的段是安全的）。
    const segments = target.relativePath.split('/')
    assert.ok(
      segments.every((segment) => segment !== '..' && segment !== '.' && segment !== ''),
      target.relativePath
    )
    assert.match(target.relativePath, /^snapshot\/[A-Za-z0-9._-]+\//)

    // 一个恰好是 `..` 的设备 uid 必须被替换掉：否则 path.join 会写到根外面。
    const escaped = storage.cameraMediaPaths({
      deviceUid: '..',
      kind: 'video',
      timestamp: Date.UTC(2026, 8, 15)
    })
    assert.equal(escaped.relativePath.split('/')[1], 'unknown')
    assert.ok(escaped.absolutePath.startsWith(root + path.sep))
  })

  it('never passes a timeout flag on the RTSP input', () => {
    // 实测（docs/FA371-INTEGRATION.md §7.1）：本机 ffmpeg 构建会把 RTSP 输入的
    // `-timeout` 当成 listen 模式，一加就必然失败。
    const args = buildManualRecordArgs(RTSP_URL, 'C:\\tmp\\out.mp4')
    assert.ok(!args.includes('-timeout'))
    assert.ok(!args.some((arg) => arg.startsWith('-stimeout')))
    assert.deepEqual(args.slice(0, 4), ['-rtsp_transport', 'tcp', '-i', RTSP_URL])
    assert.ok(args.includes('-c:v') && args.includes('copy'))
    assert.equal(args[args.length - 1], 'C:\\tmp\\out.mp4')

    const snapshot = buildSnapshotArgs(RTSP_URL, 'C:\\tmp\\out.jpg')
    assert.ok(!snapshot.includes('-timeout'))
    assert.deepEqual(snapshot.slice(0, 4), ['-rtsp_transport', 'tcp', '-i', RTSP_URL])
  })
})

// ---------------------------------------------------------------------------
// 3. 录像 / 抓图的行为（注入假 ffmpeg）
// ---------------------------------------------------------------------------

interface FakeSpec {
  /**
   * 启动时**同步**写出目标文件的内容（模拟 ffmpeg 已经开始落盘）。
   *
   * 同步是刻意的：要断言的顺序是「ffmpeg 写了字节 -> 我们杀掉它 -> 校验」，
   * 异步写入会让「校验发生在写入之前」变成偶发失败。
   */
  writeOnSpawn?: (targetPath: string) => void
  /** 子进程是否自己退出（抓图就是这样）。默认 true。 */
  autoExit?: boolean
  stderr?: string
}

interface FakeSpawner {
  spawn: typeof spawnFfmpeg
  args: string[][]
  children: FfmpegProcess[]
}

function createFakeSpawner(spec: FakeSpec): FakeSpawner {
  const args: string[][] = []
  const children: FfmpegProcess[] = []
  const spawn = ((argv: readonly string[]): FfmpegProcess => {
    args.push([...argv])
    const target = argv[argv.length - 1] as string
    if (spec.writeOnSpawn && target) spec.writeOnSpawn(target)

    let resolveExit: (value: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveExit = resolve
    })
    let killed = false
    const child: FfmpegProcess = {
      child: {} as unknown as FfmpegChild,
      stdout: new PassThrough(),
      stderrTail: () => spec.stderr ?? '',
      exited,
      killed: () => killed,
      kill: () => {
        if (killed) return
        killed = true
        resolveExit({ code: null, signal: 'SIGKILL' })
      }
    }
    children.push(child)
    if (spec.autoExit !== false) setImmediate(() => resolveExit({ code: 0, signal: null }))
    return child
  }) as unknown as typeof spawnFfmpeg
  return { spawn, args, children }
}

function makeCapture(overrides: {
  source?: { url: string } | undefined
  fake: FakeSpawner
}): CameraCaptureService {
  return new CameraCaptureService({
    storage,
    recordings,
    resolveSource: () => overrides.source,
    resolveDevice: () => ({ deviceUid: DEVICE_UID, name: 'camera 1' }),
    spawn: overrides.fake.spawn,
    now: () => Date.now()
  })
}

/** 一段能通过校验的最小 MP4：`ftyp` 在偏移 4，`moov` 在后面。 */
function minimalMp4(): Buffer {
  const ftyp = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  const moov = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x08]), Buffer.from('moov')])
  const mdat = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from('mdat'),
    Buffer.alloc(8)
  ])
  return Buffer.concat([ftyp, moov, mdat])
}

describe('manual recording: state machine and output verification', () => {
  it('refuses to start without a usable source', async () => {
    const fake = createFakeSpawner({})
    const capture = makeCapture({ source: undefined, fake })
    await assert.rejects(() => capture.start(DEVICE_ID), /尚未开始播放/)
    assert.equal(fake.args.length, 0, 'no source must mean no ffmpeg')
    capture.dispose()
  })

  it('refuses a second start', async () => {
    const fake = createFakeSpawner({ autoExit: false })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    const state = await capture.start(DEVICE_ID)
    assert.equal(state.recording, true)
    await assert.rejects(() => capture.start(DEVICE_ID), /已经在录像中/)
    assert.equal(fake.args.length, 1)
    capture.abortAll('test over')
    capture.dispose()
  })

  it('reports stopping without a start instead of returning an empty result', async () => {
    const fake = createFakeSpawner({})
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    await assert.rejects(() => capture.stop(DEVICE_ID), /没有正在进行的录像/)
    capture.dispose()
  })

  it('deletes a zero-byte result and registers NO row', async () => {
    const fake = createFakeSpawner({
      writeOnSpawn: (target) => writeFileSync(target, Buffer.alloc(0)),
      autoExit: false
    })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    const before = recordings.query({ deviceId: DEVICE_ID }).total
    await capture.start(DEVICE_ID)
    await assert.rejects(() => capture.stop(DEVICE_ID), /录像文件为空/)
    assert.equal(recordings.query({ deviceId: DEVICE_ID }).total, before, 'an empty file is not a recording')
    for (const argv of fake.args) {
      const target = argv[argv.length - 1] as string
      await assert.rejects(() => fs.stat(target), 'the empty file must be gone')
    }
    capture.dispose()
  })

  it('deletes a truncated file with no moov, rather than claiming it is valid', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(32)
    ])
    const fake = createFakeSpawner({
      writeOnSpawn: (target) => writeFileSync(target, broken),
      autoExit: false
    })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    await capture.start(DEVICE_ID)
    await assert.rejects(() => capture.stop(DEVICE_ID), /缺少 moov/)
    capture.dispose()
  })

  it('on a normal stop registers one manual row and reports duration and size', async () => {
    const fake = createFakeSpawner({
      writeOnSpawn: (target) => writeFileSync(target, minimalMp4()),
      autoExit: false
    })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    const started = await capture.start(DEVICE_ID)
    assert.ok(started.relativePath?.endsWith('.mp4'))
    const result = await capture.stop(DEVICE_ID)

    assert.ok(result.fileSize > 0)
    assert.equal(result.relativePath, started.relativePath)
    assert.ok(result.recordingId, 'the stop must return the registered recording id')

    const row = recordings.findById(result.recordingId as string)
    assert.ok(row, 'the recording must appear in the list')
    assert.equal(row.recordingType, 'manual')
    assert.equal(row.deviceId, DEVICE_ID)
    assert.equal(row.relativePath, result.relativePath)
    assert.equal(capture.listState(DEVICE_ID)[0]?.recording, false)
    capture.dispose()
  })

  it('on shutdown kills the child, discards the unfinished file and registers nothing', async () => {
    const fake = createFakeSpawner({
      writeOnSpawn: (target) => writeFileSync(target, minimalMp4()),
      autoExit: false
    })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    const started = await capture.start(DEVICE_ID)
    const target = path.join(root, started.relativePath ?? '')

    assert.equal(capture.abortAll('app quit'), 1)
    assert.equal(fake.children[0]?.killed(), true, 'no orphan ffmpeg')
    assert.equal(capture.listState(DEVICE_ID)[0]?.recording, false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await assert.rejects(() => fs.stat(target))
    capture.dispose()
  })
})

describe('snapshot: naming and the "no frame" path', () => {
  function jpeg(): Buffer {
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64),
      Buffer.from([0xff, 0xd9])
    ])
  }

  it('writes under snapshot/<uid>/<date>/ and returns the byte count', async () => {
    const fake = createFakeSpawner({ writeOnSpawn: (target) => writeFileSync(target, jpeg()) })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    const result = await capture.snapshot(DEVICE_ID)
    assert.match(result.relativePath, /^snapshot\/FA371-TEST-0001\/\d{4}\/\d{2}\/\d{2}\/.+\.jpg$/)
    assert.ok(result.absolutePath.startsWith(root + path.sep))
    assert.equal(result.bytes, jpeg().length)
    assert.equal((await probeJpegFile(result.absolutePath)).complete, true)
    capture.dispose()
  })

  it('deletes a half-written file and reports when no frame arrived', async () => {
    const fake = createFakeSpawner({ stderr: 'rtsp://host/live: Could not find codec parameters' })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    await assert.rejects(() => capture.snapshot(DEVICE_ID), /未能从视频流抓取到画面/)
    const target = fake.args[0]?.[fake.args[0].length - 1] as string
    await assert.rejects(() => fs.stat(target))
    capture.dispose()
  })

  it('treats SOI-without-EOI as a failure too', async () => {
    const fake = createFakeSpawner({
      writeOnSpawn: (target) => writeFileSync(target, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    })
    const capture = makeCapture({ source: { url: RTSP_URL }, fake })
    await assert.rejects(() => capture.snapshot(DEVICE_ID), /未能从视频流抓取到画面/)
    capture.dispose()
  })

  it('refuses to snapshot without a usable source', async () => {
    const fake = createFakeSpawner({})
    const capture = makeCapture({ source: undefined, fake })
    await assert.rejects(() => capture.snapshot(DEVICE_ID), /尚未开始播放/)
    assert.equal(fake.args.length, 0)
    capture.dispose()
  })
})

// ---------------------------------------------------------------------------
// 4. 告警请求整形（手册的歧义原样保留）
// ---------------------------------------------------------------------------

describe('alarm request shaping keeps every documented spelling', () => {
  const draft = { ...emptyStrategyDraft(), name: 'strategy-1', alias: 's1', conditionId: 3 }

  it('sends diagosisn by default, exactly as the POST field table writes it', () => {
    const dto = buildStrategyCreateDto({ ...draft, diagnosis: 'note' })
    assert.equal(dto.diagosisn, 'note')
    assert.equal(dto.diagnosis, undefined)
    // 写入侧键名的不对称是手册原文：绑定条件用 alarm_id、序号用小写 times。
    assert.equal(dto.alarm_id, 3)
    assert.equal(dto.times, 1)
    assert.equal(dto.level, 1)
    assert.equal(dto.timeout_duration, 10)
  })

  it('can switch to diagnosis, or send both, as explicit candidates', () => {
    assert.equal(
      buildStrategyCreateDto({ ...draft, diagnosis: 'n' }, { diagnosisKey: 'diagnosis' }).diagnosis,
      'n'
    )
    const both = buildStrategyCreateDto({ ...draft, diagnosis: 'n' }, { diagnosisKey: 'both' })
    assert.equal(both.diagosisn, 'n')
    assert.equal(both.diagnosis, 'n')
    // 不填诊断说明时两个键都不出现，避免发一个空字符串。
    const none = buildStrategyCreateDto(draft)
    assert.equal(none.diagosisn, undefined)
    assert.equal(none.diagnosis, undefined)
  })

  it('adds an integer id for PUT and only accepts a losslessly parseable read-side id', () => {
    assert.equal(buildStrategyUpdateDto({ ...draft, id: 7 }, 7).id, 7)
    assert.equal(strategyIdAsNumber({ id: '7' }), 7)
    assert.throws(() => strategyIdAsNumber({ id: 'abc' }), /不是整数/)
    assert.throws(() => strategyIdAsNumber({}), /没有 id/)
  })

  it('does not silently shift the level range (read 0-3, write 1-4)', () => {
    assert.throws(() => buildStrategyCreateDto({ ...draft, level: 0 }), /1~4/)
    // 「读 0~3 / 写 1~4」是手册的冲突（§8.3 C21），本软件不做静默偏移。
    assert.equal(strategyDraftFrom({ id: '9', level: 0, name: 'x' }).level, 0)
    assert.equal(validateStrategyDraft({ ...draft, level: 0 }).length, 1)
  })

  it('sends switches as 0/1 and the write-only discharge fields verbatim', () => {
    const condition = {
      ...emptyConditionDraft(),
      name: 'condition-1',
      decibelThreshold: 55,
      dbSwitch: true,
      dominantFreqThreshold: 1200,
      dfSwitch: false,
      ncSwitch: true,
      ncSimilarityThreshold: 0.75,
      dischargeSwitch: true,
      dischargeType: 4
    }
    const dto = buildConditionWriteDto(condition)
    assert.equal(dto.db_switch, 1)
    assert.equal(dto.df_switch, 0)
    assert.equal(dto.nc_switch, 1)
    assert.equal(dto.decibel_thr, 55)
    assert.equal(dto.discharge_switch, 1)
    assert.equal(dto.discharge_type, 4)
    // 四个判据至少要开一个：全关的条件不会参与判定，本地就拦下来。
    assert.throws(
      () => buildConditionWriteDto({ ...emptyConditionDraft(), name: 'x' }),
      /至少要打开一个/
    )
    // 放电类型枚举缺 3（§8.3 C27）：照原样拒绝，不就近取整。
    assert.throws(() => buildConditionWriteDto({ ...condition, dischargeType: 3 }), /0\/1\/2\/4/)
  })
})

describe('alarm service: orchestration and candidate plumbing', () => {
  function fakeClient(): { client: CameraAlarmOperations; calls: string[] } {
    const calls: string[] = []
    const strategyPage: Fa371AlarmStrategyPageDto = {
      ret: 200,
      msg: 'SUCCESS',
      page_total: 1,
      alarm_strategy_list: [
        {
          id: '1',
          name: 'strategy-1',
          alarm_condition_id: 3,
          level: 1,
          sensitivity: 0.5,
          timeout_duration: 10,
          Times: 1,
          Switch: 1
        }
      ]
    }
    const conditionPage: Fa371AlarmConditionPageDto = {
      ret: 200,
      msg: 'SUCCESS',
      alarm_condition_list: [{ id: 3, name: 'condition-1', decibel_thr: 55, db_switch: 1 }]
    }
    const client: CameraAlarmOperations = {
      listAlarmStrategies: async () => {
        calls.push('listStrategies')
        return strategyPage
      },
      createAlarmStrategy: async () => {
        calls.push('createStrategy')
        return { ret: 200, msg: 'SUCCESS' }
      },
      updateAlarmStrategy: async () => {
        calls.push('updateStrategy')
        return { ret: 200, msg: 'SUCCESS' }
      },
      deleteAlarmStrategies: async (ids) => {
        calls.push(`deleteStrategies:${ids.join(',')}`)
        return { ret: 200, msg: 'SUCCESS' }
      },
      listAlarmConditions: async () => {
        calls.push('listConditions')
        return conditionPage
      },
      createAlarmCondition: async () => {
        calls.push('createCondition')
        return { ret: 200, msg: 'SUCCESS' }
      },
      updateAlarmCondition: async (_body, options) => {
        calls.push(`updateCondition:${String(options?.idStyle)}:${String(options?.targetId)}`)
        return { ret: 200, msg: 'SUCCESS' }
      },
      deleteAlarmConditions: async (ids) => {
        calls.push(`deleteConditions:${ids.join(',')}`)
        return { ret: 200, msg: 'SUCCESS' }
      }
    }
    return { client, calls }
  }

  it('re-reads the list after a create (the manual returns no new id) and maps Switch', async () => {
    const { client, calls } = fakeClient()
    const service = new CameraAlarmService({ clientFor: () => client })
    const page = await service.createStrategy(DEVICE_ID, {
      ...emptyStrategyDraft(),
      name: 'strategy-1',
      conditionId: 3
    })
    assert.deepEqual(calls, ['createStrategy', 'listStrategies'])
    assert.equal(page.items.length, 1)
    // `Switch` 只有读侧有（§8.3 C33）：读回来就是启用状态，界面只显示不可切换。
    assert.equal(page.items[0]?.enabled, true)
    assert.equal(page.items[0]?.id, '1')
  })

  it('passes the condition id-style candidate through', async () => {
    const { client, calls } = fakeClient()
    const service = new CameraAlarmService({ clientFor: () => client, conditionIdStyle: 'none' })
    await service.updateCondition(DEVICE_ID, {
      ...emptyConditionDraft(),
      id: 3,
      name: 'condition-1',
      dbSwitch: true
    })
    assert.ok(calls[0]?.startsWith('updateCondition:none:3'), calls.join('|'))

    const second = fakeClient()
    const other = new CameraAlarmService({ clientFor: () => second.client })
    await other.updateCondition(
      DEVICE_ID,
      { ...emptyConditionDraft(), id: 3, name: 'condition-1', dbSwitch: true },
      { idStyle: 'alarm_condition_id' }
    )
    assert.ok(second.calls[0]?.startsWith('updateCondition:alarm_condition_id:3'))
  })

  it('requires at least one valid id to delete, and sends nothing for an empty list', async () => {
    const { client, calls } = fakeClient()
    const service = new CameraAlarmService({ clientFor: () => client })
    await assert.rejects(() => service.deleteStrategies(DEVICE_ID, []), /请选择要删除/)
    await assert.rejects(() => service.deleteConditions(DEVICE_ID, [0]), /不合法/)
    assert.deepEqual(calls, [])
    await service.deleteConditions(DEVICE_ID, [3])
    assert.equal(calls[0], 'deleteConditions:3')
  })
})

// ---------------------------------------------------------------------------
// 5. 真二进制：合成源 -> 文件 -> 校验 -> 登记
// ---------------------------------------------------------------------------

/**
 * 把服务的录像参数换成合成源（相机不在这条路径上），其余一切照旧。
 *
 * `-re` 让 lavfi 按真实帧率喂数据：否则 libx264 会以 300 倍速把整段视频一口气
 * 编完并自己退出（实测 328x），测试就变成在测「杀掉一个已经结束的进程」。
 */
function syntheticSpawner(durationSeconds: number, realtime: boolean): typeof spawnFfmpeg {
  return (argv, options) => {
    const target = argv[argv.length - 1] as string
    const args = [
      ...(realtime ? ['-re'] : []),
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=10',
      '-t',
      String(durationSeconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'mp4',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      target
    ]
    return spawnFfmpeg(args, options)
  }
}

/** 轮询到某个条件成立或超时，用于等真 ffmpeg 落盘/结束。 */
async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

describe('real ffmpeg: a synthetic source becomes a playable MP4', () => {
  it('verifies ftyp/moov and registers a recording stopped while running', async () => {
    const capture = new CameraCaptureService({
      storage,
      recordings,
      resolveSource: () => ({ url: RTSP_URL }),
      resolveDevice: () => ({ deviceUid: DEVICE_UID, name: 'camera 1' }),
      spawn: syntheticSpawner(600, true)
    })

    const started = await capture.start(DEVICE_ID)
    const target = path.join(root, started.relativePath ?? '')
    const wrote = await waitFor(
      async () => (await fs.stat(target).then((stat) => stat.size).catch(() => 0)) > 0,
      20_000
    )
    assert.ok(wrote, 'the synthetic source must produce bytes')

    const result = await capture.stop(DEVICE_ID)
    assert.ok(result.fileSize > 0, `the recording must not be empty: ${result.relativePath}`)
    assert.ok(result.recordingId, 'the recording must be registered')

    const probe = await probeMp4File(target)
    assert.equal(probe.hasFtyp, true, 'ftyp box required')
    assert.equal(probe.hasMoov, true, 'moov required (fragmented MP4 writes it up front)')
    assert.equal(probe.playable, true)
    assert.ok(probe.size > 0)

    const row = recordings.findById(result.recordingId as string)
    assert.equal(row?.recordingType, 'manual')
    assert.equal(row?.fileSize, probe.size)

    capture.dispose()
    assert.equal(liveFfmpegCount(), 0, 'the real-binary test must not leave a child behind')
  })

  it('finalises and registers on its own when the stream ends', async () => {
    // `-t 1` 的合成源会在 1 秒后自己结束 —— 这正是相机掉线时发生的事。
    const capture = new CameraCaptureService({
      storage,
      recordings,
      resolveSource: () => ({ url: RTSP_URL }),
      resolveDevice: () => ({ deviceUid: DEVICE_UID, name: 'camera 1' }),
      spawn: syntheticSpawner(1, true)
    })

    await capture.start(DEVICE_ID)
    const finished = await waitFor(
      async () => capture.listState(DEVICE_ID)[0]?.recording === false,
      30_000
    )
    assert.ok(finished, 'an exited ffmpeg must be finalised, not left as "recording"')

    const rows = recordings.query({ deviceId: DEVICE_ID, recordingType: 'manual' })
    const auto = rows.items.find((item) => item.relativePath.includes('video/'))
    assert.ok(auto, 'the auto-finalised recording must be registered too')
    assert.equal((await probeMp4File(storage.resolve(auto.relativePath))).playable, true)

    capture.dispose()
    assert.equal(liveFfmpegCount(), 0)
  })

  it('keeps the synthetic-source arguments in the ffmpeg wrapper', () => {
    // 防止有人为了「顺便测一下」重新拼一份合成源参数：录像参数出自
    // `camera-capture.ts`，合成源参数出自 `ffmpeg.ts`。
    assert.deepEqual(buildSyntheticTestArgs(2).slice(0, 2), ['-f', 'lavfi'])
  })
})

// ---------------------------------------------------------------------------
// 6. 本地 MP4 的回环播放端点（D3：录像要真的能播）
// ---------------------------------------------------------------------------

describe('video playback endpoint', () => {
  it('serves the file on loopback, refuses a wrong token and honours Range', async () => {
    const file = path.join(root, 'playback-sample.mp4')
    await fs.writeFile(file, minimalMp4())
    const server = new VideoFileServer()
    const handle = await server.serve(file)
    try {
      assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\//)
      assert.ok(!handle.url.includes('localhost'), 'must use the loopback literal')

      // 令牌是这段端点唯一的授权：换一个令牌必须 403。
      const origin = new URL(handle.url).origin
      const sample = await fetchBytes(`${origin}/wrong-token/sample.mp4`)
      assert.equal(sample.status, 403)

      const whole = await fetchBytes(handle.url)
      assert.equal(whole.status, 200)
      assert.equal(whole.headers['content-type'], 'video/mp4')
      assert.equal(whole.headers['accept-ranges'], 'bytes')
      assert.equal(whole.body.length, minimalMp4().length)

      // Range 是「能拖进度条」的前提，缺了它长录像只能从头顺序读。
      const partial = await fetchBytes(handle.url, { Range: 'bytes=0-7' })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers['content-range'], `bytes 0-7/${minimalMp4().length}`)
      assert.equal(partial.body.length, 8)
      assert.equal(partial.body.subarray(4, 8).toString('ascii'), 'ftyp')
    } finally {
      server.dispose()
    }
    assert.equal(server.openCount, 0)
  })

  it('refuses an empty or missing file instead of handing out a dead URL', async () => {
    const server = new VideoFileServer()
    try {
      await assert.rejects(() => server.serve(path.join(root, 'nope.mp4')), /没有可播放的文件/)
      const empty = path.join(root, 'empty.mp4')
      await fs.writeFile(empty, Buffer.alloc(0))
      await assert.rejects(() => server.serve(empty), /没有可播放的文件/)
    } finally {
      server.dispose()
    }
  })
})

/** 取一个 URL，返回状态行、头与完整 body（只用于小文件与失败响应）。 */
async function fetchBytes(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, string>,
          body: Buffer.concat(chunks)
        })
      )
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}
