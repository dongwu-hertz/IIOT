/**
 * 事件与告警中心：领域纯函数 + 两个新服务。
 *
 * WHY THIS FILE EXISTS
 * 「事件与告警中心」把三路互不相干的来源（相机检测日志 / 本机联动内存列表 /
 * 本地 SQLite 告警行）合并成一条时间线。合并的正确性、截断的诚实性、确认的分派
 * 与「下载到本机后能不能播、再下一次会不会覆盖」，都是**只有测试能钉住**的性质：
 * 真机上这三路里有两路现在是空的（相机 `detect_logs` 为 0 条，联动默认关闭）。
 *
 * 全部用注入的假实现驱动，不连真机：
 *   - 设备侧：一个假的检测库（返回固定日志、记录下载调用）；
 *   - 联动侧：一个假的待处理列表（可断言「谁被确认了」）；
 *   - 本地侧：真实的 SQLite（`:memory:`）、真实的 `AlarmRepository` /
 *     `RecordingRepository` / `DeviceRepository` / `StorageService`（临时目录），
 *     因为「登记了什么」正是要断言的对象，用假仓库会把这件事测掉。
 *
 * 设备行必须真实存在：`alarms.device_id` 与 `recordings.device_id` 都有指向
 * `devices(id)` 的外键，凭空编一个 id 会被 SQLite 直接拒绝——这本身也是一条
 * 值得被测试踩到的约束（第一次写这个文件时就踩到了）。
 */

import { strict as assert } from 'node:assert'
import { after, before, beforeEach, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database as SqliteDatabase } from 'better-sqlite3'

import { openDatabase } from '../src/main/services/database/schema'
import { AlarmRepository, RecordingRepository } from '../src/main/services/database/alarm-repository'
import { DeviceRepository } from '../src/main/services/database/device-repository'
import { EventStatusRepository } from '../src/main/services/database/event-status-repository'
import { IncidentRepository } from '../src/main/services/database/incident-repository'
import { StorageService } from '../src/main/services/storage/storage-service'
import { DetectLibraryService } from '../src/main/services/device/fa371/detect-library-service'
import {
  EventCenterService
} from '../src/main/services/events/event-center-service'
import type { EventCenterImageServer } from '../src/main/services/events/event-center-service'
import { AppError, ErrorCodes } from '../src/shared/errors'
import {
  deriveRecordingContainer,
  detectRemoteRecordingId,
  deviceDetectEntryId,
  eventCenterPerSourceCap,
  eventSourceFromEntryId,
  isEventSourceKind,
  linkageEntryId,
  localAlarmEntryId
} from '../src/shared/domain/event-center'
import type {
  EventCenterEntry,
  EventDetectLibraryPage,
  EventDetectLogView
} from '../src/shared/domain/event-center'
import type { PendingAlarmRecord, PendingAlarmSnapshot } from '../src/shared/domain/alarm-linkage'
import { INCIDENT_NOTE_MAX_LENGTH, INCIDENT_TITLE_MAX_LENGTH } from '../src/shared/domain/incident'
import type { Fa371DownloadedFile } from '../src/main/services/device/fa371/dto'

// ---------------------------------------------------------------------------
// Shared local stack (real SQLite + real storage, in a throwaway directory)
// ---------------------------------------------------------------------------

let root: string
let db: SqliteDatabase
let storage: StorageService
let alarms: AlarmRepository
let recordings: RecordingRepository
let devicesRepo: DeviceRepository
/** 处置工作流（schema v13）：聚合那一组用例要直接往里写一条状态。 */
let statuses: EventStatusRepository
/** Incident 与它的关联（schema v14）：人工创建 + 手动关联那一组要直接读库核对。 */
let incidents: IncidentRepository

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hz-event-center-'))
  db = openDatabase({ file: ':memory:' })
  storage = new StorageService({ db, getStorageRoot: () => root, getMinFreeBytes: () => 0 })
  alarms = new AlarmRepository(db)
  recordings = new RecordingRepository(db)
  devicesRepo = new DeviceRepository(db)
  statuses = new EventStatusRepository(db)
  incidents = new IncidentRepository(db)
})

after(async () => {
  try {
    db.close()
  } catch {
    // Already closed.
  }
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * Isolate the tests from each other.
 *
 * Several cases deliberately query WITHOUT a device filter (that is the merged
 * page), so rows left behind by an earlier case would change their totals. The
 * seeded device rows stay: they are the foreign-key targets, they are keyed by
 * tag, and re-creating them per test would only add noise.
 */
beforeEach(() => {
  db.prepare('DELETE FROM recordings').run()
  db.prepare('DELETE FROM alarms').run()
  /*
   * 处置状态也要清：聚合那一组用例会往组里写一条状态，留着它会让后面
   * "这一条还没有状态" 的断言（`status: undefined`）时对时错。
   */
  db.prepare('DELETE FROM event_status').run()
  db.prepare('DELETE FROM event_activity').run()
  /*
   * Incident 也要清（schema v14）：`incident_alerts` 先删 —— 它对 `incidents` 有外键，
   * 反过来删会被 SQLite 拒绝（这本身说明外键真的在管）。
   */
  db.prepare('DELETE FROM incident_alerts').run()
  db.prepare('DELETE FROM incidents').run()
})

/** Real, persisted device rows (the FK targets), memoised per tag. */
const boxIds = new Map<string, string>()
const cameraIds = new Map<string, string>()

function box(tag: string): string {
  const existing = boxIds.get(tag)
  if (existing) return existing
  const { device } = devicesRepo.upsertByIdentity(
    { ip: `10.1.0.${boxIds.size + 1}`, httpPort: 80, username: 'admin', password: 'pw' },
    { deviceUid: `box-uid-${tag}`, name: `Box ${tag}`, channelCount: 8 }
  )
  boxIds.set(tag, device.id)
  return device.id
}

function camera(tag: string): string {
  const existing = cameraIds.get(tag)
  if (existing) return existing
  const { device } = devicesRepo.upsertCamera(
    { ip: `10.2.0.${cameraIds.size + 1}`, httpPort: 80, username: 'admin', password: 'pw' },
    { deviceUid: `cam-uid-${tag}`, name: `Camera ${tag}` }
  )
  cameraIds.set(tag, device.id)
  return device.id
}

// ---------------------------------------------------------------------------
// Fakes for the two remote-ish sources
// ---------------------------------------------------------------------------

interface DetectFakeState {
  logs: EventDetectLogView[]
  logsCount?: number
  /** 设定后 `list()` 抛出这条消息（模拟相机离线）。 */
  fail?: string
  downloads: Array<{ deviceId: string; logId: number; kind: string }>
}

function createDetectFake(state: DetectFakeState) {
  return {
    async list(deviceId: string): Promise<EventDetectLibraryPage> {
      if (state.fail) throw new Error(state.fail)
      // A real device only returns ITS OWN logs, so the fake filters too:
      // without this a query over two cameras would see the same log twice.
      const items = state.logs.filter((log) => log.deviceId === deviceId)
      const page: EventDetectLibraryPage = { deviceId, items, paging: 'none' }
      if (state.logsCount !== undefined) page.logsCount = state.logsCount
      return page
    },
    // Present only so the shape matches `EventCenterDetectLibrary`: the merge
    // tests never download through the fake.
    async download(): Promise<never> {
      throw new Error('the fake detect library never downloads')
    }
  }
}

interface LinkageFakeState {
  items: PendingAlarmRecord[]
  dropped: number
  acknowledgedCalls: string[][]
}

function createLinkageFake(state: LinkageFakeState) {
  return {
    pendingSnapshot(): PendingAlarmSnapshot {
      return { items: state.items, dropped: state.dropped }
    },
    acknowledge(ids: readonly string[]): PendingAlarmSnapshot {
      state.acknowledgedCalls.push([...ids])
      const set = new Set(ids)
      state.items = state.items.map((item) =>
        set.has(item.eventId) ? { ...item, acknowledged: true } : item
      )
      return { items: state.items, dropped: state.dropped }
    }
  }
}

/** Two camera devices and one box, as the `listDevices()` dependency. */
const DEVICES = [
  { id: 'cam-1', name: 'Camera one', kind: 'acousticCamera' as const },
  { id: 'cam-2', name: 'Camera two', kind: 'acousticCamera' as const },
  { id: 'box-fake', name: 'Box fake', kind: 'acousticBox' as const }
]

function logView(partial: {
  deviceId: string
  logId: number
  startTimeRaw?: number
  savingPath?: string
  files?: EventDetectLogView['files']
  isAlarm?: boolean
}): EventDetectLogView {
  const view: EventDetectLogView = {
    deviceId: partial.deviceId,
    logId: partial.logId,
    atApproximate: true,
    timeUnit: 'epoch_seconds',
    files: partial.files ?? []
  }
  if (partial.startTimeRaw !== undefined) {
    view.startTimeRaw = partial.startTimeRaw
    view.startTimeMs = partial.startTimeRaw * 1000
  }
  if (partial.savingPath !== undefined) view.savingPath = partial.savingPath
  if (partial.isAlarm !== undefined) view.isAlarm = partial.isAlarm
  return view
}

function pendingRecord(
  overrides: Partial<PendingAlarmRecord> & { eventId: string; at: number }
): PendingAlarmRecord {
  return {
    eventId: overrides.eventId,
    deviceId: overrides.deviceId ?? 'cam-1',
    deviceName: overrides.deviceName ?? 'Camera one',
    at: overrides.at,
    observedAt: overrides.observedAt ?? overrides.at,
    source: overrides.source ?? 'poll',
    actions: overrides.actions ?? [],
    acknowledged: overrides.acknowledged ?? false,
    ...(overrides.recordingId !== undefined ? { recordingId: overrides.recordingId } : {}),
    ...(overrides.alarmLevelRaw !== undefined ? { alarmLevelRaw: overrides.alarmLevelRaw } : {}),
    ...(overrides.detectMode !== undefined ? { detectMode: overrides.detectMode } : {}),
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {})
  }
}

/** A fixed clock so the fallback time of an untimed log is predictable. */
const FIXED_NOW = 1_700_000_000_000

/**
 * 图片端点（回环 HTTP）的假实现（规格 §12.1 的 Visual）。
 *
 * 不真的起 HTTP：单测要证明的是**服务把哪个目录、哪个文件名交了出去**，
 * 以及"该关的时候关掉了"，端口与字节是 `VideoFileServer` 自己的测试对象。
 * 存储解析用**真的** `StorageService`：越界保护正是要断言的性质之一。
 */
interface ImageFakeState {
  calls: Array<{ directory: string; names: string[] }>
  closed: number
  /** 设定后 `serveImages` 抛这条消息（模拟"这一组里没有可用的图片文件"）。 */
  fail?: string
}

function createImageFake(state: ImageFakeState): EventCenterImageServer {
  return {
    async serveImages(directory, names) {
      state.calls.push({ directory, names: [...names] })
      if (state.fail) throw new AppError(ErrorCodes.STORAGE_ERROR, state.fail)
      return {
        files: names.map((name) => ({ name, url: `http://127.0.0.1:9/tok/${name}` })),
        close: () => {
          state.closed += 1
        }
      }
    }
  }
}

interface ServiceFixture {
  service: EventCenterService
  detectState: DetectFakeState
  linkageState: LinkageFakeState
  imageState: ImageFakeState
}

function createService(options: {
  detect?: DetectFakeState
  linkage?: LinkageFakeState
  devices?: typeof DEVICES
  detectLogLimit?: number
  image?: ImageFakeState
} = {}): ServiceFixture {
  const detectState = options.detect ?? { logs: [], downloads: [] }
  const linkageState = options.linkage ?? { items: [], dropped: 0, acknowledgedCalls: [] }
  const imageState = options.image ?? { calls: [], closed: 0 }
  const service = new EventCenterService({
    listDevices: () => options.devices ?? DEVICES,
    detectLibrary: createDetectFake(detectState),
    linkage: createLinkageFake(linkageState),
    alarms,
    recordings: {
      findById: (id) => recordings.findById(id),
      listByDevice: (deviceId) => recordings.query({ deviceId, limit: 1000, offset: 0 }).items
    },
    images: createImageFake(imageState),
    storage,
    statuses: new EventStatusRepository(db),
    incidents,
    now: () => FIXED_NOW,
    ...(options.detectLogLimit !== undefined ? { detectLogLimit: options.detectLogLimit } : {})
  })
  return { service, detectState, linkageState, imageState }
}

// ---------------------------------------------------------------------------
// Extension -> container, identifiers, caps
// ---------------------------------------------------------------------------

describe('deriveRecordingContainer', () => {
  it('maps the extensions the detection library actually produces', () => {
    assert.equal(deriveRecordingContainer('power_spect.png'), 'png')
    assert.equal(deriveRecordingContainer('soundmap.mp4'), 'mp4')
    assert.equal(deriveRecordingContainer('mic.wav'), 'wav')
    assert.equal(deriveRecordingContainer('data.bin'), 'bin')
    assert.equal(deriveRecordingContainer('mic_csv.csv'), 'csv')
    assert.equal(deriveRecordingContainer('noise.nc'), 'nc')
  })

  it('is case-insensitive and ignores surrounding whitespace', () => {
    assert.equal(deriveRecordingContainer('  MIC.WAV  '), 'wav')
    assert.equal(deriveRecordingContainer('SoundMap.MP4'), 'mp4')
  })

  it('treats jpeg as jpg (the same format, spelled differently)', () => {
    assert.equal(deriveRecordingContainer('photo.jpeg'), 'jpg')
  })

  it('returns unknown for an unrecognised or missing extension, never a guess', () => {
    assert.equal(deriveRecordingContainer('mystery.weird'), 'unknown')
    assert.equal(deriveRecordingContainer('no-extension'), 'unknown')
    assert.equal(deriveRecordingContainer('archive.tar.gz'), 'unknown')
    assert.equal(deriveRecordingContainer(''), 'unknown')
  })

  it('keeps the source identifiers readable from an entry id', () => {
    assert.equal(isEventSourceKind('deviceDetect'), true)
    assert.equal(isEventSourceKind('nope'), false)
    assert.equal(eventSourceFromEntryId(deviceDetectEntryId('d', 1, 2)), 'deviceDetect')
    assert.equal(eventSourceFromEntryId(linkageEntryId('d:1:2')), 'linkage')
    assert.equal(eventSourceFromEntryId(localAlarmEntryId('alm_1')), 'localAlarm')
    assert.equal(eventSourceFromEntryId('mystery:1'), undefined)
  })

  it('derives the per-source cap from the requested page', () => {
    assert.equal(eventCenterPerSourceCap(50, 0), 50)
    assert.equal(eventCenterPerSourceCap(50, 50), 100)
    assert.equal(eventCenterPerSourceCap(10_000, 0), 500)
  })
})

// ---------------------------------------------------------------------------
// Merge, order, filters, honest empty state
// ---------------------------------------------------------------------------

describe('EventCenterService.query', () => {
  it('renders an honest empty page when all three sources are empty', async () => {
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0 })

    assert.deepEqual(page.items, [])
    assert.equal(page.total, 0)
    assert.equal(page.truncated, false)
    assert.deepEqual(page.countsBySource, { deviceDetect: 0, linkage: 0, localAlarm: 0, deviceStatus: 0 })
    // Every source reports itself as read-and-empty rather than being absent:
    // "we looked and there was nothing" is a different statement from silence.
    assert.equal(page.sources.length, 3) // 本测试不注入 deviceStatus：没接线的那一路不报状态
    for (const status of page.sources) {
      assert.equal(status.ok, true)
      assert.equal(status.items, 0)
    }
  })

  it('merges three sources into one list ordered newest first', async () => {
    const boxId = box('merge')
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 3_000, alarmMask: 1 })
    const { service } = createService({
      detect: {
        logs: [logView({ deviceId: 'cam-1', logId: 11, startTimeRaw: 2 })],
        downloads: []
      },
      linkage: {
        items: [pendingRecord({ eventId: 'cam-1:9:4', at: 4_000, deviceId: 'cam-1' })],
        dropped: 0,
        acknowledgedCalls: []
      }
    })

    const page = await service.query({ limit: 50, offset: 0 })

    assert.equal(page.items.length, 3)
    assert.deepEqual(
      page.items.map((item) => item.source),
      ['linkage', 'localAlarm', 'deviceDetect']
    )
    assert.deepEqual(
      page.items.map((item) => item.at),
      [4_000, 3_000, 2_000]
    )
    assert.deepEqual(page.countsBySource, { deviceDetect: 1, linkage: 1, localAlarm: 1, deviceStatus: 0 })
    assert.equal(page.total, 3)
    assert.equal(page.truncated, false)
  })

  it('联动记录：模式未知的占位 leakVolume=0 不进事件指标，其余指标照旧', async () => {
    const { service } = createService({
      linkage: {
        items: [
          pendingRecord({
            eventId: 'cam-1:20:30',
            at: 30_000,
            deviceId: 'cam-1',
            metrics: { soundmapIntensity: 26.45, leakVolume: 0 }
          })
        ],
        dropped: 0,
        acknowledgedCalls: []
      }
    })

    const page = await service.query({ sources: ['linkage'], limit: 50, offset: 0 })

    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.metrics?.leakVolume, undefined)
    assert.equal(page.items[0]?.metrics?.soundmapIntensity, 26.45)
  })

  it('联动记录：泄漏模式的 0 与未知模式的非零读数都保留', async () => {
    const { service } = createService({
      linkage: {
        items: [
          pendingRecord({ eventId: 'cam-1:21:31', at: 31_000, deviceId: 'cam-1', detectMode: 2, metrics: { leakVolume: 0 } }),
          pendingRecord({ eventId: 'cam-1:22:32', at: 32_000, deviceId: 'cam-1', metrics: { leakVolume: 4.5 } })
        ],
        dropped: 0,
        acknowledgedCalls: []
      }
    })

    const page = await service.query({ sources: ['linkage'], limit: 50, offset: 0 })

    assert.equal(page.items.find((item) => item.at === 31_000)?.metrics?.leakVolume, 0)
    assert.equal(page.items.find((item) => item.at === 32_000)?.metrics?.leakVolume, 4.5)
  })

  it('marks device timestamps as approximate and box timestamps as exact', async () => {
    const boxId = box('approx')
    alarms.insert({ deviceId: boxId, channelId: 1, timestamp: 5_555, alarmMask: 1 << 9 })
    const { service } = createService({
      detect: {
        logs: [logView({ deviceId: 'cam-1', logId: 1, startTimeRaw: 10 })],
        downloads: []
      }
    })

    const boxPage = await service.query({ deviceId: boxId, limit: 50, offset: 0 })
    assert.equal(boxPage.items.length, 1)
    const boxEntry = boxPage.items[0] as EventCenterEntry
    assert.equal(boxEntry.atApproximate, false)
    assert.equal(boxEntry.severity, 'warning')
    assert.equal(boxEntry.kind, 'localAlarm')
    assert.deepEqual(boxEntry.localAlarm?.alarmTypes, [9])

    const detectPage = await service.query({ deviceId: 'cam-1', limit: 50, offset: 0 })
    const detectEntry = detectPage.items[0] as EventCenterEntry
    assert.equal(detectEntry.atApproximate, true)
    assert.equal(detectEntry.at, 10_000)
    // The camera's alarm_level has never been observed, so the level is unknown
    // rather than being invented as a warning.
    assert.equal(detectEntry.severity, 'unknown')
    assert.equal(detectEntry.kind, 'deviceDetect')
  })

  it('does not invent a device time for a log that carries none', async () => {
    const { service } = createService({
      detect: { logs: [logView({ deviceId: 'cam-1', logId: 3 })], downloads: [] }
    })
    const page = await service.query({ deviceId: 'cam-1', limit: 50, offset: 0 })
    const entry = page.items[0] as EventCenterEntry
    assert.equal(entry.at, FIXED_NOW)
    assert.equal(entry.atApproximate, true)
    assert.equal(entry.detect?.startTimeRaw, undefined)
    assert.equal(page.sources.find((status) => status.source === 'deviceDetect')?.untimed, 1)
  })

  it('applies the device filter per source', async () => {
    const boxA = box('filter-a')
    const boxB = box('filter-b')
    alarms.insert({ deviceId: boxA, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    alarms.insert({ deviceId: boxB, channelId: 0, timestamp: 2_000, alarmMask: 1 })
    const { service } = createService({
      detect: {
        logs: [
          logView({ deviceId: 'cam-1', logId: 1, startTimeRaw: 3 }),
          logView({ deviceId: 'cam-2', logId: 2, startTimeRaw: 4 })
        ],
        downloads: []
      }
    })

    const page = await service.query({ deviceId: 'cam-1', limit: 50, offset: 0 })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0]?.deviceId, 'cam-1')
    assert.deepEqual(page.countsBySource, { deviceDetect: 1, linkage: 0, localAlarm: 0, deviceStatus: 0 })

    const justBoxA = await service.query({ deviceId: boxA, limit: 50, offset: 0 })
    assert.deepEqual(justBoxA.items.map((item) => item.deviceId), [boxA])
  })

  it('applies the source, time and acknowledgement filters', async () => {
    const boxId = box('filters')
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 10_000, alarmMask: 1 })
    const acked = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 20_000, alarmMask: 2 })
    alarms.acknowledge([acked.id], true)

    const { service } = createService({
      linkage: {
        items: [
          pendingRecord({ eventId: 'cam-1:1:1', at: 15_000, deviceId: 'cam-1' }),
          pendingRecord({ eventId: 'cam-1:2:2', at: 30_000, deviceId: 'cam-1', acknowledged: true })
        ],
        dropped: 0,
        acknowledgedCalls: []
      }
    })

    const localOnly = await service.query({
      deviceId: boxId,
      sources: ['localAlarm'],
      limit: 50,
      offset: 0
    })
    assert.deepEqual(localOnly.items.map((item) => item.source), ['localAlarm', 'localAlarm'])

    const unacked = await service.query({
      sources: ['localAlarm', 'linkage'],
      acknowledged: false,
      limit: 50,
      offset: 0
    })
    assert.deepEqual(
      unacked.items.map((item) => item.at).sort((left, right) => left - right),
      [10_000, 15_000]
    )

    const timeWindow = await service.query({ from: 12_000, to: 25_000, limit: 50, offset: 0 })
    assert.deepEqual(
      timeWindow.items.map((item) => item.at).sort((left, right) => left - right),
      [15_000, 20_000]
    )

    // Only the box carries a definite level, so a severity filter of `warning`
    // must exclude the linkage entry (whose level is unknown) entirely.
    const warningOnly = await service.query({ severity: 'warning', limit: 50, offset: 0 })
    assert.deepEqual(warningOnly.items.map((item) => item.source), ['localAlarm', 'localAlarm'])
    assert.deepEqual(warningOnly.countsBySource, { deviceDetect: 0, linkage: 0, localAlarm: 2, deviceStatus: 0 })

    const unknownOnly = await service.query({ severity: 'unknown', limit: 50, offset: 0 })
    assert.deepEqual(unknownOnly.items.map((item) => item.source), ['linkage', 'linkage'])
  })

  it('paginates the merged page and states the cap that applies to each page', async () => {
    const boxId = box('paging')
    for (const timestamp of [1_000, 2_000, 3_000, 4_000, 5_000]) {
      alarms.insert({ deviceId: boxId, channelId: 0, timestamp, alarmMask: 1 })
    }
    const { service } = createService()

    /**
     * The per-source cap is `limit + offset`, so a page reads exactly as deep as
     * it needs to and no deeper. Consequence worth pinning: page 1 reads two rows
     * and therefore reports `total: 2` with `truncated: true` — the pool is a
     * lower bound while it is capped, which is what `EventCenterPage.total`
     * documents. Page 2 reads four rows, so its pool reaches [5,4,3,2] and the
     * slice starts at 2.
     */
    const first = await service.query({ deviceId: boxId, limit: 2, offset: 0 })
    assert.deepEqual(first.items.map((item) => item.at), [5_000, 4_000])
    assert.equal(first.total, 2)
    assert.equal(first.truncated, true)

    const second = await service.query({ deviceId: boxId, limit: 2, offset: 2 })
    assert.deepEqual(second.items.map((item) => item.at), [3_000, 2_000])
    assert.equal(second.total, 4)

    // A page wide enough to hold everything is complete and says so.
    const all = await service.query({ deviceId: boxId, limit: 50, offset: 0 })
    assert.deepEqual(all.items.map((item) => item.at), [5_000, 4_000, 3_000, 2_000, 1_000])
    assert.equal(all.total, 5)
    assert.equal(all.truncated, false)
  })

  it('sets truncated when a per-source cap bites, and says by how much', async () => {
    const boxId = box('cap')
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 2_000, alarmMask: 1 })
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 3_000, alarmMask: 1 })
    const { service } = createService({
      linkage: {
        items: [
          pendingRecord({ eventId: 'cam-1:1:1', at: 4_000 }),
          pendingRecord({ eventId: 'cam-1:2:2', at: 5_000 })
        ],
        dropped: 7,
        acknowledgedCalls: []
      }
    })

    // limit 1 + offset 0 => each source is read with a cap of 1.
    const first = await service.query({ deviceId: boxId, limit: 1, offset: 0 })
    const local = first.sources.find((status) => status.source === 'localAlarm')
    assert.equal(local?.items, 1)
    assert.equal(local?.truncated, 2, 'SQL knows the real total, so the cut is exact')

    const all = await service.query({ limit: 1, offset: 0 })
    const linkage = all.sources.find((status) => status.source === 'linkage')
    assert.equal(linkage?.items, 1)
    // One entry cut by the cap plus the seven the engine itself dropped.
    assert.equal(linkage?.truncated, 1 + 7)
    assert.equal(all.truncated, true)
  })

  it('caps how many detection logs are read per camera', async () => {
    const { service } = createService({
      detect: {
        logs: [
          logView({ deviceId: 'cam-1', logId: 1, startTimeRaw: 1 }),
          logView({ deviceId: 'cam-1', logId: 2, startTimeRaw: 2 }),
          logView({ deviceId: 'cam-1', logId: 3, startTimeRaw: 3 })
        ],
        downloads: []
      },
      detectLogLimit: 2
    })
    const page = await service.query({ deviceId: 'cam-1', limit: 50, offset: 0 })
    // The two NEWEST survive the cap; the oldest is the one dropped.
    assert.deepEqual(page.items.map((item) => item.detect?.logId), [3, 2])
    assert.equal(page.sources.find((status) => status.source === 'deviceDetect')?.truncated, 1)
    assert.equal(page.truncated, true)
  })

  it('keeps the other two sources when one source fails', async () => {
    const boxId = box('degrade')
    alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const { service } = createService({
      detect: { logs: [], downloads: [], fail: 'socket hang up' },
      linkage: {
        items: [pendingRecord({ eventId: 'cam-1:1:1', at: 2_000 })],
        dropped: 0,
        acknowledgedCalls: []
      }
    })

    const page = await service.query({ from: 500, to: 2_500, limit: 50, offset: 0 })
    assert.equal(page.items.length, 2, 'the two healthy sources still render')
    assert.deepEqual(page.items.map((item) => item.source), ['linkage', 'localAlarm'])

    const detect = page.sources.find((status) => status.source === 'deviceDetect')
    assert.equal(detect?.ok, false)
    assert.match(detect?.error ?? '', /socket hang up/)
    assert.equal(page.sources.find((status) => status.source === 'localAlarm')?.ok, true)
  })
})

// ---------------------------------------------------------------------------
// Acknowledge dispatch
// ---------------------------------------------------------------------------

describe('EventCenterService.acknowledge', () => {
  it('dispatches each id to its own owner and reports the unsupported source', async () => {
    const boxId = box('ack')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const linkageState: LinkageFakeState = {
      items: [pendingRecord({ eventId: 'cam-1:5:6', at: 2_000 })],
      dropped: 0,
      acknowledgedCalls: []
    }
    const { service } = createService({ linkage: linkageState })

    const result = await service.acknowledge([
      localAlarmEntryId(inserted.id),
      linkageEntryId('cam-1:5:6'),
      deviceDetectEntryId('cam-1', 5, 6),
      'mystery:42'
    ])

    assert.equal(result.acknowledged, 2)
    assert.equal(result.unrecognised, 1)

    const local = result.perSource.find((entry) => entry.source === 'localAlarm')
    assert.equal(local?.acknowledged, 1)
    const linkage = result.perSource.find((entry) => entry.source === 'linkage')
    assert.equal(linkage?.acknowledged, 1)
    const detect = result.perSource.find((entry) => entry.source === 'deviceDetect')
    assert.equal(detect?.acknowledged, 0)
    assert.equal(detect?.unsupported, true)

    // The linkage owner receives the RAW event identity, not the prefixed id.
    assert.deepEqual(linkageState.acknowledgedCalls, [['cam-1:5:6']])
    // The SQLite row really flipped.
    const row = alarms.query({ deviceId: boxId, limit: 10, offset: 0 }).items[0]
    assert.equal(row?.acknowledged, true)
  })

  it('does not call the linkage owner at all when no linkage id was requested', async () => {
    const linkageState: LinkageFakeState = { items: [], dropped: 0, acknowledgedCalls: [] }
    const { service } = createService({ linkage: linkageState })
    const result = await service.acknowledge([deviceDetectEntryId('cam-1', 1, 1)])
    assert.deepEqual(
      linkageState.acknowledgedCalls,
      [],
      'an empty list must never mean "acknowledge all"'
    )
    assert.equal(result.acknowledged, 0)
    assert.equal(result.unrecognised, 0)
  })

  it('reports a failing owner instead of throwing away the other owner result', async () => {
    const boxId = box('ack-broken')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    // A broken linkage owner: the alarm owner must still be reported.
    const broken = new EventCenterService({
      listDevices: () => DEVICES,
      detectLibrary: createDetectFake({ logs: [], downloads: [] }),
      linkage: {
        pendingSnapshot: () => ({ items: [], dropped: 0 }),
        acknowledge: () => {
          throw new Error('linkage store is gone')
        }
      },
      alarms,
      recordings: {
        findById: (id) => recordings.findById(id),
        listByDevice: (deviceId) => recordings.query({ deviceId, limit: 1000, offset: 0 }).items
      },
      images: createImageFake({ calls: [], closed: 0 }),
      storage,
      statuses: new EventStatusRepository(db),
      incidents
    })

    const result = await broken.acknowledge([
      localAlarmEntryId(inserted.id),
      linkageEntryId('cam-1:1:1')
    ])
    assert.equal(result.acknowledged, 1)
    const linkage = result.perSource.find((entry) => entry.source === 'linkage')
    assert.match(linkage?.error ?? '', /linkage store is gone/)
    assert.equal(result.perSource.find((entry) => entry.source === 'localAlarm')?.acknowledged, 1)
  })
})

// ---------------------------------------------------------------------------
// Detect library: download, containers, idempotence
// ---------------------------------------------------------------------------

interface FakeClientState {
  payload: unknown
  bytes: Uint8Array
  downloadCalls: Array<{ savingPath: string; fileName: string }>
}

function createFakeClient(state: FakeClientState) {
  return {
    async getDetectLogs(): Promise<never> {
      return state.payload as never
    },
    async downloadDetectFile(savingPath: string, fileName: string): Promise<Fa371DownloadedFile> {
      state.downloadCalls.push({ savingPath, fileName })
      return { bytes: state.bytes, contentType: 'application/octet-stream', status: 200 }
    }
  }
}

function createLibrary(state: FakeClientState): DetectLibraryService {
  return new DetectLibraryService({
    clientFor: () => createFakeClient(state),
    storage,
    recordings
  })
}

/** A detect-log response in the shape the device documents (§5.1.17). */
function detectLogsPayload(overrides: Record<string, unknown>): unknown {
  return {
    detect_logs: [
      {
        id: 7,
        start_time: 1_561_033_839,
        saving_path: '2019_06_20_20_30_39_940/',
        ...overrides
      }
    ],
    logs_count: 1
  }
}

describe('DetectLibraryService', () => {
  it('泄漏量按检测模式取舍：局放的 data_1=0 是占位，泄漏模式与未知非零值保留', async () => {
    const deviceId = camera('dl-leak-gate')

    const pdState: FakeClientState = {
      payload: detectLogsPayload({ detect_mode: 1, data_1: 0 }),
      bytes: new Uint8Array(),
      downloadCalls: []
    }
    const pdPage = await createLibrary(pdState).list(deviceId)
    assert.equal(pdPage.items[0]?.detectMode, 1)
    assert.equal(pdPage.items[0]?.metrics?.leakVolume, undefined)

    const leakState: FakeClientState = {
      payload: detectLogsPayload({ detect_mode: 2, data_1: 0 }),
      bytes: new Uint8Array(),
      downloadCalls: []
    }
    const leakPage = await createLibrary(leakState).list(deviceId)
    assert.equal(leakPage.items[0]?.metrics?.leakVolume, 0)

    const oldFirmwareState: FakeClientState = {
      payload: detectLogsPayload({ data_1: 4.5 }),
      bytes: new Uint8Array(),
      downloadCalls: []
    }
    const oldFirmwarePage = await createLibrary(oldFirmwareState).list(deviceId)
    assert.equal(oldFirmwarePage.items[0]?.metrics?.leakVolume, 4.5)
  })

  it('registers a WAV result file with the right container and audio format', async () => {
    const deviceId = camera('dl-wav')
    const state: FakeClientState = {
      payload: detectLogsPayload({ wav_mic_data_name: 'mic_01.wav' }),
      bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
      downloadCalls: []
    }
    const library = createLibrary(state)

    const page = await library.list(deviceId)
    assert.equal(page.paging, 'none', 'the manual defines no paging for /detect_logs')
    assert.equal(page.logsCount, 1)
    assert.equal(page.items[0]?.startTimeMs, 1_561_033_839_000)
    assert.equal(page.items[0]?.atApproximate, true)
    assert.equal(page.items[0]?.files[0]?.container, 'wav')

    const result = await library.download(deviceId, {
      deviceId,
      logId: 7,
      startTimeRaw: 1_561_033_839,
      kind: 'wav_mic_data'
    })

    assert.equal(result.reused, false)
    assert.equal(result.container, 'wav')
    assert.equal(result.audioFormat, 'wav')
    assert.equal(result.bytes, state.bytes.length)
    assert.deepEqual(state.downloadCalls, [
      { savingPath: '2019_06_20_20_30_39_940/', fileName: 'mic_01.wav' }
    ])

    // The bytes really landed under the storage root, unchanged.
    const absolute = storage.resolve(result.relativePath)
    const written = new Uint8Array(await fs.readFile(absolute))
    assert.deepEqual([...written], [...state.bytes])
    assert.equal(result.relativePath, `detect/${deviceId}/7-wav_mic_data.wav`)

    const row = recordings.findById(result.recordingId)
    assert.ok(row)
    assert.equal(row.containerFormat, 'wav')
    assert.equal(row.audioFormat, 'wav')
    assert.equal(row.remoteRecordingId, detectRemoteRecordingId(7, 'wav_mic_data'))
    assert.equal(row.relativePath, result.relativePath)
    assert.equal(row.fileSize, state.bytes.length)
    // The operator asked for this file, so it must not be auto-deleted by the
    // alarm retention sweep (`recording_type = 'alarm'` is the only swept kind).
    assert.equal(row.recordingType, 'manual')
  })

  it('is idempotent on a second call and never clobbers the existing file', async () => {
    const deviceId = camera('dl-idem')
    const state: FakeClientState = {
      payload: detectLogsPayload({ soundmap_video_name: 'soundmap.mp4' }),
      bytes: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      downloadCalls: []
    }
    const library = createLibrary(state)

    const first = await library.download(deviceId, {
      deviceId,
      logId: 7,
      kind: 'soundmap_video'
    })
    assert.equal(first.reused, false)
    assert.equal(first.container, 'mp4')
    assert.equal(first.audioFormat, null, 'an MP4 has no audio format, and null says exactly that')

    // Second call: same row, same file, and the device is NOT asked again.
    const second = await library.download(deviceId, {
      deviceId,
      logId: 7,
      kind: 'soundmap_video'
    })
    assert.equal(second.reused, true)
    assert.equal(second.recordingId, first.recordingId)
    assert.equal(second.relativePath, first.relativePath)
    assert.equal(state.downloadCalls.length, 1, 'the second call must not re-download')

    const rows = recordings.query({ deviceId, limit: 100, offset: 0 }).items
    assert.equal(rows.length, 1, 'idempotence means one row, not two')
  })

  it('records an unrecognised extension as unknown rather than guessing', async () => {
    const deviceId = camera('dl-unknown')
    const state: FakeClientState = {
      payload: detectLogsPayload({ voiceprint_photo_name: 'voiceprint.weird' }),
      bytes: new Uint8Array([1, 2, 3]),
      downloadCalls: []
    }
    const library = createLibrary(state)

    const result = await library.download(deviceId, {
      deviceId,
      logId: 7,
      kind: 'voiceprint_photo'
    })

    assert.equal(result.container, 'unknown')
    assert.equal(result.audioFormat, null)
    // The device's own extension is kept on disk (the file IS what the device
    // served); only the container column says "we cannot tell".
    assert.equal(result.relativePath, `detect/${deviceId}/7-voiceprint_photo.weird`)

    const row = recordings.findById(result.recordingId)
    assert.equal(row?.containerFormat, 'unknown')
    assert.equal(row?.audioFormat, null)
  })

  it('refuses a zero-byte download and registers no file', async () => {
    const deviceId = camera('dl-zero')
    const state: FakeClientState = {
      payload: detectLogsPayload({ power_spect_photo_name: 'spectrum.jpg' }),
      bytes: new Uint8Array(0),
      downloadCalls: []
    }
    const library = createLibrary(state)

    await assert.rejects(
      () => library.download(deviceId, { deviceId, logId: 7, kind: 'power_spectrum_photo' }),
      /0 字节/
    )

    const rows = recordings.query({ deviceId, limit: 100, offset: 0 }).items
    assert.equal(rows.length, 1, 'the metadata row exists so the attempt is auditable')
    assert.equal(rows[0]?.relativePath, '', 'but no file is claimed to be local')
  })

  it('reports progress stages without inventing a percentage', async () => {
    const deviceId = camera('dl-progress')
    const state: FakeClientState = {
      payload: detectLogsPayload({ bin_mic_data_name: 'mic.bin' }),
      bytes: new Uint8Array([9, 9, 9]),
      downloadCalls: []
    }
    const library = createLibrary(state)
    const stages: string[] = []

    await library.download(
      deviceId,
      { deviceId, logId: 7, kind: 'bin_mic_data' },
      (progress) => {
        stages.push(progress.stage)
        assert.equal('progress' in progress, false, 'no fake percentage is reported')
      }
    )

    assert.deepEqual(stages, ['starting', 'fetching', 'verifying', 'registering', 'done'])
  })

  it('refuses to download a log the device no longer lists', async () => {
    const deviceId = camera('dl-gone')
    const state: FakeClientState = {
      payload: { detect_logs: [], logs_count: 0 },
      bytes: new Uint8Array([1]),
      downloadCalls: []
    }
    const library = createLibrary(state)
    await assert.rejects(
      () => library.download(deviceId, { deviceId, logId: 99, kind: 'wav_mic_data' }),
      /找不到这条记录/
    )
  })

  it('lists the eight documented file kinds exactly once each', async () => {
    const deviceId = camera('dl-eight')
    const state: FakeClientState = {
      payload: detectLogsPayload({
        power_spect_photo_name: 'a.jpg',
        power_spect_video_name: 'b.mp4',
        soundmap_photo_name: 'c.jpg',
        soundmap_video_name: 'd.mp4',
        voiceprint_photo_name: 'e.jpg',
        voiceprint_video_name: 'f.mp4',
        bin_mic_data_name: 'g.bin',
        wav_mic_data_name: 'h.wav'
      }),
      bytes: new Uint8Array([1]),
      downloadCalls: []
    }
    const library = createLibrary(state)
    const page = await library.list(deviceId)
    const kinds = page.items[0]?.files.map((file) => file.kind) ?? []
    assert.equal(kinds.length, 8)
    assert.equal(new Set(kinds).size, 8, 'each kind appears exactly once')
  })
})

// ---------------------------------------------------------------------------
// 图片证据（规格 §12.1 的 Visual，Phase 4）
// ---------------------------------------------------------------------------

describe('重复触发聚合（规格 §14.1，主进程侧）', () => {
  /** 往同一台设备写 N 条告警，时刻按分钟递增。 */
  function seedAlarms(deviceId: string, minutes: number[]): void {
    for (const minute of minutes) {
      alarms.insert({
        deviceId,
        channelId: 0,
        timestamp: FIXED_NOW + minute * 60_000,
        alarmMask: 1
      })
    }
  }

  it('默认（显式给 10 分钟窗口）把连续触发并成一条告警，总数也是告警数', async () => {
    const deviceId = box('group-1')
    seedAlarms(deviceId, [0, 2, 5])
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0, groupWindowMs: 10 * 60_000 })
    assert.equal(page.items.length, 1, '三条连续触发没有并成一条')
    assert.equal(page.total, 1, '总数应该是告警数（聚合之后）')
    const item = page.items[0]
    assert.ok(item)
    assert.equal(item.occurrenceCount, 3)
    assert.equal(item.firstDetectedAt, FIXED_NOW)
    assert.equal(item.lastDetectedAt, FIXED_NOW + 5 * 60_000)
    // 代表是最新那一条；组的稳定标识是最早那一条。
    assert.equal(item.at, FIXED_NOW + 5 * 60_000)
    assert.notEqual(item.groupId, item.id)
    assert.equal(item.groupMembers?.length, 3)
    // 来源计数仍然是**原始事件数**（那一路读到了几条），与告警数不是一回事。
    assert.equal(page.countsBySource.localAlarm, 3)
  })

  it('API 的**缺省是不聚合**（窗口由调用方显式给；界面永远会给）', async () => {
    const deviceId = box('group-1b')
    seedAlarms(deviceId, [0, 2, 5])
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0 })
    assert.equal(page.items.length, 3, '缺省不该悄悄聚合')
    for (const item of page.items) {
      assert.equal(item.occurrenceCount, undefined)
      assert.equal(item.groupId, undefined)
    }
  })

  it('`groupWindowMs: 0`（界面上的"不聚合"）时每条自己一行', async () => {
    const deviceId = box('group-2')
    seedAlarms(deviceId, [0, 2, 5])
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0, groupWindowMs: 0 })
    assert.equal(page.items.length, 3)
    assert.equal(page.total, 3)
    assert.equal(page.items[0]?.occurrenceCount, undefined, '不聚合时不该带上组字段')
  })

  it('超过窗口的两段触发是两条告警（"连续"的边界）', async () => {
    const deviceId = box('group-3')
    seedAlarms(deviceId, [0, 3, 40])
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0, groupWindowMs: 10 * 60_000 })
    assert.equal(page.total, 2)
    assert.deepEqual(
      page.items.map((item) => item.occurrenceCount),
      [1, 2]
    )
  })

  it('不同设备的触发不并（分组键含设备）', async () => {
    seedAlarms(box('group-4a'), [0, 2])
    seedAlarms(box('group-4b'), [1])
    const { service } = createService()
    const page = await service.query({ limit: 50, offset: 0, groupWindowMs: 10 * 60_000 })
    assert.equal(page.total, 2)
  })

  it('处置状态按**组**合并：组内任何一条被处置过，整条告警就算处置过', async () => {
    const deviceId = box('group-5')
    seedAlarms(deviceId, [0, 2, 5])
    const { service } = createService()
    const first = await service.query({ limit: 50, offset: 0, groupWindowMs: 10 * 60_000 })
    const item = first.items[0]
    assert.ok(item)
    // 只处置**中间**那一条（不是代表、也不是最早那条）。
    const middle = item.groupMembers?.[1]
    assert.ok(middle)
    statuses.setStatus({ entryId: middle.id, status: 'resolved', actor: 'admin', at: FIXED_NOW })
    const second = await service.query({ limit: 50, offset: 0, groupWindowMs: 10 * 60_000 })
    assert.equal(second.items[0]?.status, 'resolved')
  })

  it('窗口被夹到 24 小时上限（"窗口 = 一周"不是聚合，是把数据藏起来）', async () => {
    const deviceId = box('group-6')
    // 两条相差 25 小时：即便传一个巨大的窗口，也必须分成两条。
    seedAlarms(deviceId, [0, 25 * 60])
    const { service } = createService()
    const page = await service.query({
      limit: 50,
      offset: 0,
      groupWindowMs: 7 * 24 * 60 * 60 * 1000
    })
    assert.equal(page.total, 2)
  })
})

describe('事件中心的图片证据（详情抽屉 Evidence 页签）', () => {  /** 在存储根下写一个**真的**文件：`evidenceImage` 会去磁盘上确认它在不在。 */
  async function writeEvidenceFile(relativePath: string, bytes = [0xff, 0xd8, 0xff]): Promise<void> {
    const absolute = path.join(root, relativePath)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, Buffer.from(bytes))
  }

  it('相对路径 → 回环地址，且交出去的正是那一个文件（目录 + 文件名）', async () => {
    const { service, imageState } = createService()
    await writeEvidenceFile('linkage/frames/a.jpg')
    const view = await service.evidenceImage({ relativePath: 'linkage/frames/a.jpg' })
    assert.equal(view.state, 'ok')
    assert.equal(view.name, 'a.jpg')
    assert.ok(String(view.url).includes('/a.jpg'), '回环地址里没有那个文件名')
    assert.equal(imageState.calls.length, 1)
    assert.equal(imageState.calls[0]?.names.length, 1, '一次只该服务一张图')
    assert.equal(
      imageState.calls[0]?.directory,
      path.join(root, 'linkage', 'frames'),
      '交给端点的目录不是那个文件所在的目录'
    )
  })

  it('录像行 id 优先：路径由库回答（相机检测日志下载下来的照片走这条）', async () => {
    const { service } = createService()
    await writeEvidenceFile('recordings/photo.jpg')
    const deviceId = camera('evidence-rec')
    const row = recordings.insert({
      deviceId,
      channelId: 1,
      recordingType: 'manual',
      startTime: FIXED_NOW,
      sampleRate: 0,
      audioFormat: null,
      containerFormat: 'jpg',
      relativePath: 'recordings/photo.jpg'
    })
    // 同时给一个**错的**相对路径：必须用库里的那一条。
    const view = await service.evidenceImage({
      recordingId: row.id,
      relativePath: 'recordings/does-not-exist.jpg'
    })
    assert.equal(view.state, 'ok')
    assert.equal(view.name, 'photo.jpg')
  })

  it('录像行查不到（id 拼错/行被删）→ not-found，而不是去猜路径', async () => {
    const { service, imageState } = createService()
    const view = await service.evidenceImage({ recordingId: 'rec_missing' })
    assert.equal(view.state, 'not-found')
    assert.equal(imageState.calls.length, 0, '认不出路径时不该去开端点')
  })

  it('既没给 id 也没给路径 → not-found', async () => {
    const { service } = createService()
    assert.equal((await service.evidenceImage({})).state, 'not-found')
    assert.equal((await service.evidenceImage({ relativePath: '   ' })).state, 'not-found')
  })

  it('路径在库里、文件不在磁盘 → files-gone（换过存储根/被手工删掉，与"不是图片"不同）', async () => {
    const { service, imageState } = createService()
    const view = await service.evidenceImage({ relativePath: 'linkage/frames/gone.jpg' })
    assert.equal(view.state, 'files-gone')
    assert.equal(imageState.calls.length, 0, '文件不在时不该去开端点')
  })

  it('越界的相对路径被存储层拒绝 → not-found（不抛给界面）', async () => {
    const { service, imageState } = createService()
    const view = await service.evidenceImage({ relativePath: '../../etc/passwd.jpg' })
    assert.equal(view.state, 'not-found')
    assert.equal(imageState.calls.length, 0)
  })

  it('绝对路径不受理（存储根可以搬家，绝对路径会随之失效）', async () => {
    const { service, imageState } = createService()
    const view = await service.evidenceImage({ relativePath: path.join(root, 'linkage', 'a.jpg') })
    assert.equal(view.state, 'not-found')
    assert.equal(imageState.calls.length, 0)
  })

  it('文件在但不是能渲染的图片 → not-image（把 mp4 当图片取）', async () => {
    const image = { calls: [], closed: 0, fail: '这一组里没有可用的图片文件' }
    const { service } = createService({ image })
    await writeEvidenceFile('linkage/frames/b.mp4', [0x00, 0x00, 0x00, 0x18])
    const view = await service.evidenceImage({ relativePath: 'linkage/frames/b.mp4' })
    assert.equal(view.state, 'not-image')
  })

  it('一次只留一个端点：开新的会关掉旧的，closeEvidenceImage() 也能关', async () => {
    const { service, imageState } = createService()
    await writeEvidenceFile('linkage/frames/one.jpg')
    await writeEvidenceFile('linkage/frames/two.jpg')
    await service.evidenceImage({ relativePath: 'linkage/frames/one.jpg' })
    assert.equal(imageState.closed, 0, '第一张图不该被提前关掉')
    await service.evidenceImage({ relativePath: 'linkage/frames/two.jpg' })
    assert.equal(imageState.closed, 1, '开第二张时没有关掉第一张（端口会一直挂着）')
    service.closeEvidenceImage()
    assert.equal(imageState.closed, 2)
    // 再关一次不该出错（界面可能连关两次：换事件 + 关抽屉）。
    service.closeEvidenceImage()
    assert.equal(imageState.closed, 2)
  })

  it('取图失败（not-image / files-gone）时不会把上一个端点关掉 —— 界面上那张图还在', async () => {
    const image = { calls: [], closed: 0 }
    const { service } = createService({ image })
    await writeEvidenceFile('linkage/frames/keep.jpg')
    await service.evidenceImage({ relativePath: 'linkage/frames/keep.jpg' })
    const missing = await service.evidenceImage({ relativePath: 'linkage/frames/nope.jpg' })
    assert.equal(missing.state, 'files-gone')
    assert.equal(image.closed, 0, '失败的取图把已经在显示的那张图关掉了')
  })
})

// ---------------------------------------------------------------------------
// Incident（规格 §14.2 的 V1：人工创建 + 手动关联）
// ---------------------------------------------------------------------------

/**
 * 这一组的重点不在"能建出来"，而在三件规格明确要求或明确禁止的事：
 *   - §14.2 的 V1 是**人工**创建 + **手动**关联：没有第二条自动路径；
 *   - §13.2 的"不自动替用户关闭/合并"：建 Incident **不碰任何 Alert 的状态**；
 *   - 幂等：同一个关联点两次不该产生两条链接（主键 + INSERT OR IGNORE）。
 */
describe('Incident：人工创建 + 手动关联（规格 §14.2 V1）', () => {
  const ACTOR = 'admin'

  it('建一个并一并关联几条：写完读回，条数与标题都对得上（标题两端空格会去掉）', async () => {
    const { service } = createService()
    const boxId = box('inc-create')
    const first = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const second = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 2_000, alarmMask: 2 })
    const entryIds = [localAlarmEntryId(first.id), localAlarmEntryId(second.id)]

    const result = await service.createIncident({
      title: '  1 号风机异常情况  ',
      note: '  现场看了一眼  ',
      entryIds,
      actor: ACTOR
    })

    assert.equal(result.incident.title, '1 号风机异常情况')
    assert.equal(result.incident.note, '现场看了一眼')
    assert.equal(result.incident.createdBy, ACTOR)
    assert.equal(result.linked, 2)
    assert.equal(result.incident.alertCount, 2)
    assert.equal(incidents.count(), 1, '库里应当恰好一行')

    // 读回：两条 Alert 都指向这**一个** Incident，条数也是 2。
    for (const entryId of entryIds) {
      const linked = service.incidentsForEntry(entryId)
      assert.equal(linked.length, 1)
      assert.equal(linked[0]?.id, result.incident.id)
      assert.equal(linked[0]?.alertCount, 2)
    }
  })

  it('标题必填、有长度上限；备注也有上限（拒绝时带上原因键，界面据此提示）', async () => {
    const { service } = createService()
    const rejects = async (input: { title: unknown; note?: unknown }, reason: string) => {
      await assert.rejects(
        () => service.createIncident({ ...input, actor: ACTOR }),
        (error: unknown) => {
          const app = error as AppError
          assert.equal(app.code, ErrorCodes.VALIDATION_ERROR)
          assert.equal(app.detail, reason)
          return true
        }
      )
    }
    await rejects({ title: '   ' }, 'title-required')
    await rejects({ title: 'x'.repeat(INCIDENT_TITLE_MAX_LENGTH + 1) }, 'title-too-long')
    await rejects(
      { title: '正常标题', note: 'y'.repeat(INCIDENT_NOTE_MAX_LENGTH + 1) },
      'note-too-long'
    )
    assert.equal(incidents.count(), 0, '被拒绝的草稿不该留下任何行')
  })

  it('认不出前缀的 entry id 一律拒绝（不许写下一条永远对不上的关联）', async () => {
    const { service } = createService()
    await assert.rejects(
      () => service.createIncident({ title: '正常标题', entryIds: ['dev_123'], actor: ACTOR }),
      /认不出这条事件来自哪一路/
    )
    assert.equal(incidents.count(), 0)
  })

  it('先建一个空的 Incident 是合法的（稍后再挂告警）', async () => {
    const { service } = createService()
    const created = await service.createIncident({ title: '只有标题', actor: ACTOR })
    assert.equal(created.linked, 0)
    assert.equal(created.incident.alertCount, 0)
    assert.deepEqual(
      service.listIncidents().map((item) => item.id),
      [created.incident.id]
    )
  })

  it('手动关联是幂等的：第二次点只算 alreadyLinked，不产生第二条链接', async () => {
    const { service } = createService()
    const boxId = box('inc-link')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const entryId = localAlarmEntryId(inserted.id)
    const created = await service.createIncident({ title: 'A', actor: ACTOR })

    const first = await service.linkAlerts({
      incidentId: created.incident.id,
      entryIds: [entryId],
      actor: ACTOR
    })
    assert.equal(first.linked, 1)
    assert.equal(first.alreadyLinked, 0)
    assert.equal(first.incident.alertCount, 1)

    const second = await service.linkAlerts({
      incidentId: created.incident.id,
      entryIds: [entryId],
      actor: ACTOR
    })
    assert.equal(second.linked, 0)
    assert.equal(second.alreadyLinked, 1)
    assert.equal(second.incident.alertCount, 1, '重复关联把条数算成 2 了')
    assert.equal(incidents.links(created.incident.id).length, 1)
  })

  it('关联到一个不存在的 Incident 如实拒绝（不静默成功）', async () => {
    const { service } = createService()
    const boxId = box('inc-missing')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    await assert.rejects(
      () =>
        service.linkAlerts({
          incidentId: 'inc_不存在',
          entryIds: [localAlarmEntryId(inserted.id)],
          actor: ACTOR
        }),
      /不存在/
    )
  })

  it('至少要选一条告警才叫"关联"', async () => {
    const { service } = createService()
    const created = await service.createIncident({ title: 'A', actor: ACTOR })
    await assert.rejects(
      () => service.linkAlerts({ incidentId: created.incident.id, entryIds: [], actor: ACTOR }),
      /至少要选一条告警/
    )
  })

  it('解除关联：真的删掉返回 true；没关联过返回 false（不是错误）', async () => {
    const { service } = createService()
    const boxId = box('inc-unlink')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const entryId = localAlarmEntryId(inserted.id)
    const created = await service.createIncident({
      title: 'A',
      entryIds: [entryId],
      actor: ACTOR
    })

    assert.deepEqual(await service.unlinkAlert({ incidentId: created.incident.id, entryId }), {
      removed: true
    })
    assert.deepEqual(service.incidentsForEntry(entryId), [])
    assert.deepEqual(await service.unlinkAlert({ incidentId: created.incident.id, entryId }), {
      removed: false
    })
    // Incident 本身留着（解除关联不是删事件），条数回到 0。
    assert.equal(service.listIncidents()[0]?.alertCount, 0)
  })

  it('建 Incident 不碰任何 Alert 的状态，也不写处置流水（规格 §13.2：不自动关闭/合并）', async () => {
    const { service } = createService()
    const boxId = box('inc-status')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const entryId = localAlarmEntryId(inserted.id)

    await service.createIncident({ title: 'A', entryIds: [entryId], actor: ACTOR })

    assert.equal(statuses.find(entryId), undefined, '建 Incident 顺手写了一条状态行')
    assert.equal(service.activity(entryId).length, 0, '建 Incident 顺手写了一条 Activity')
  })

  it('一个 Alert 可以同时属于两个 Incident（人工关联没有被做成"只能有一个"）', async () => {
    const { service } = createService()
    const boxId = box('inc-two')
    const inserted = alarms.insert({ deviceId: boxId, channelId: 0, timestamp: 1_000, alarmMask: 1 })
    const entryId = localAlarmEntryId(inserted.id)
    const first = await service.createIncident({ title: 'A', entryIds: [entryId], actor: ACTOR })
    const second = await service.createIncident({ title: 'B', entryIds: [entryId], actor: ACTOR })

    const linked = service.incidentsForEntry(entryId)
    assert.equal(linked.length, 2)
    assert.deepEqual(
      linked.map((item) => item.id).sort(),
      [first.incident.id, second.incident.id].sort()
    )
  })
})

