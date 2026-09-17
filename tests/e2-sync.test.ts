/**
 * 听诊盒子族「拉」通道的**落库**这一半（`E2SyncService`）。
 *
 * 客户端那一半已经用真的本地 HTTP 服务测过（`e2-client.test.ts`）；这一组测的是
 * "拉回来的东西怎么落到本机库"，所以设备那一侧是**真的 HTTP 服务 + 真的 WAV 字节**，
 * 而存储用的是真的 `StorageService`（临时目录）。唯一假的是设备本身。
 *
 * 断言对准四条规矩（都写在服务层文件头）：
 *   1. `alarm_value` **不写进 `alarm_mask`**、等级**不派生**（否则会凭空出现一个严重等级）；
 *   2. **幂等**：反复同步只写一条告警、一份录音（"再同步一次"是常态操作）；
 *   3. 时间是设备给的本地时间；解不出来**跳过并计数**，不当成 0、不当成现在；
 *   4. `files_status = 0`（设备上文件已被 5000 条保留策略清掉）时**不去下载**，
 *      但**仍然登记那条告警** —— "记录在、文件没了"是预期状态。
 */

import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import Database from 'better-sqlite3'

import { E2Client } from '../src/main/services/device/e2/e2-client'
import { E2SyncService } from '../src/main/services/device/e2/e2-sync-service'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import { AlarmRepository, RecordingRepository } from '../src/main/services/database/alarm-repository'
import { openDatabase } from '../src/main/services/database/schema'
import { StorageService } from '../src/main/services/storage/storage-service'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-sync-'))
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

// ---------------------------------------------------------------------------
// 一份真的 WAV（44 字节头 + 一小段静音），用来验"表头读出来的是真数据"
// ---------------------------------------------------------------------------

function makeWav(options: { sampleRate: number; seconds: number }): Buffer {
  const channels = 1
  const bitsPerSample = 16
  const frames = Math.round(options.sampleRate * options.seconds)
  const dataBytes = frames * channels * (bitsPerSample / 8)
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(options.sampleRate, 24)
  buffer.writeUInt32LE(options.sampleRate * channels * (bitsPerSample / 8), 28)
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}

const ALARM_WAV = makeWav({ sampleRate: 48_000, seconds: 10 })

// ---------------------------------------------------------------------------
// 假设备
// ---------------------------------------------------------------------------

interface FakeDevice {
  baseUrl: string
  requests: { path: string; query: URLSearchParams }[]
  close(): Promise<void>
}

interface FakeOptions {
  logs?: unknown
  /** 每个 `file_path` 对应的字节；不在表里的回 404。 */
  files?: Record<string, Buffer>
  /**
   * `GET /system` 的回话。**决定变体判定**：给 Air Sonar 的 PTZ 参数就是 airSonar，
   * 给 `work_mode` 就是 2023 版听诊盒子（默认）。
   */
  system?: unknown
}

async function startDevice(options: FakeOptions = {}): Promise<FakeDevice> {
  const requests: FakeDevice['requests'] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push({ path: url.pathname, query: url.searchParams })

      if (url.pathname === '/login') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ token: 'tok' }))
        return
      }
      if (url.pathname === '/system') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.system ?? { work_mode: 'rotating_equipment' }))
        return
      }
      if (url.pathname === '/alarm_log_all' || url.pathname === '/get_all_alarms') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(options.logs ?? { logs_count: 0, logs: [] }))
        return
      }
      if (url.pathname === '/alarm_files' || url.pathname === '/saving_alarm_file') {
        const filePath = url.searchParams.get('file_path') ?? ''
        const bytes = options.files?.[filePath]
        if (bytes === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('not found')
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(bytes)
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

// ---------------------------------------------------------------------------
// 本机环境
// ---------------------------------------------------------------------------

interface Harness {
  db: InstanceType<typeof Database>
  alarms: AlarmRepository
  recordings: RecordingRepository
  storage: StorageService
  storageRoot: string
}

let counter = 0

function harness(): Harness {
  counter += 1
  const storageRoot = path.join(tempRoot, `storage-${counter}`)
  fs.mkdirSync(storageRoot, { recursive: true })
  const db = openDatabase({ file: path.join(tempRoot, `db-${counter}.db`) })
  db.prepare(
    `INSERT INTO devices (id, device_uid, name, status, created_at, updated_at)
     VALUES ('dev-e2', 'uid-e2', 'E2-1', 'ONLINE', 1, 1)`
  ).run()
  const storage = new StorageService({
    db,
    getStorageRoot: () => storageRoot,
    getMinFreeBytes: () => 0
  })
  return {
    db,
    alarms: new AlarmRepository(db),
    recordings: new RecordingRepository(db),
    storage,
    storageRoot
  }
}

function makeSync(fake: FakeDevice, env: Harness): E2SyncService {
  return new E2SyncService({
    client: new E2Client({
      transport: new FetchHttpTransport(3_000),
      baseUrl: fake.baseUrl,
      credentials: { username: 'admin', password: 'x' }
    }),
    alarms: env.alarms,
    recordings: env.recordings,
    storage: env.storage,
    deviceId: 'dev-e2',
    deviceUid: 'uid-e2'
  })
}

/** 一条标准的电气设备模式告警日志。 */
function logEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    time: '2022-04-16_07-51-33',
    alarm_reasons: '时域能量比超限，',
    alarm_value: 256,
    saving_path: '20220416_075133/',
    audio_name: '20220416_075133.wav',
    files_status: 1,
    db_value: 51.569347,
    main_frequency: 2785,
    fde_ratio: 0.05,
    sc_ratio: 0.85,
    oeh_ratio: 2.56,
    ...overrides
  }
}

const cleanup: Array<() => Promise<void>> = []
after(async () => {
  for (const close of cleanup) await close()
})

async function setup(options: FakeOptions = {}): Promise<{
  fake: FakeDevice
  env: Harness
  sync: E2SyncService
}> {
  const fake = await startDevice(options)
  cleanup.push(fake.close)
  const env = harness()
  return { fake, env, sync: makeSync(fake, env) }
}

// ---------------------------------------------------------------------------

describe('听诊盒子同步：告警落库', () => {
  it('写进去的行是 `source=e2`、`alarmMask=0`、等级 **unknown**（不派生）', async () => {
    const { env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry()] },
      files: { '20220416_075133/20220416_075133.wav': ALARM_WAV }
    })
    try {
      const outcome = await sync.sync({ downloadAudio: false })
      assert.equal(outcome.alarmsCreated, 1)
      assert.equal(outcome.logsSeen, 1)

      const page = env.alarms.query({ deviceId: 'dev-e2' })
      assert.equal(page.total, 1)
      const alarm = page.items[0]
      assert.ok(alarm)
      assert.equal(alarm.source, 'e2')
      // 关键：听诊盒子族的 alarm_value **没有**写进 alarm_mask。
      assert.equal(alarm.alarmMask, 0)
      // 也没有故障类型（FA8 的分类法在这里一个都不该出现）。
      assert.deepEqual(alarm.alarmTypes, [])
      // 等级是 unknown 而不是由空位图派生出来的某一档。
      assert.equal(alarm.severity, 'unknown')
      // 设备自己的数字与文本都在。
      assert.equal(alarm.deviceAlarmValue, 256)
      assert.equal(alarm.deviceReason, '时域能量比超限，')
      assert.equal(alarm.filesStatus, 1)
      // db_value → spl（分贝值就是声压级），main_frequency → mainFrequency。
      assert.equal(alarm.spl, 51.569347)
      assert.equal(alarm.mainFrequency, 2785)
      // 原始载荷整份留着（三种模式的字段集合不同）。
      const raw = JSON.parse(String(alarm.deviceRaw)) as Record<string, unknown>
      assert.equal(raw.fde_ratio, 0.05)
      assert.equal(raw.oeh_ratio, 2.56)
      // 时间按设备原文解析（本地时区）。
      assert.equal(alarm.timestamp, new Date(2022, 3, 16, 7, 51, 33, 0).getTime())
    } finally {
      env.db.close()
    }
  })

  it('**幂等**：同步两次只写一条告警、一份录音（"再同步一次"是常态）', async () => {
    const { env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry()] },
      files: { '20220416_075133/20220416_075133.wav': ALARM_WAV }
    })
    try {
      const first = await sync.sync()
      assert.equal(first.alarmsCreated, 1)
      assert.equal(first.audioSaved, 1)

      const second = await sync.sync()
      assert.equal(second.alarmsCreated, 0)
      assert.equal(second.alarmsExisting, 1)
      // 第二次**不再下载**：本地已经有那个文件了。
      assert.equal(second.audioSaved, 0)
      assert.equal(second.audioExisting, 1)

      assert.equal(env.alarms.query({ deviceId: 'dev-e2' }).total, 1)
      assert.equal(env.recordings.query({ deviceId: 'dev-e2' }).total, 1)
    } finally {
      env.db.close()
    }
  })

  it('时间解不出来的那一条**跳过并计数**，不写进库（不猜 0、不猜现在）', async () => {
    const { env, sync } = await setup({
      logs: {
        logs_count: 2,
        logs: [logEntry(), logEntry({ id: 2, time: 'not-a-time', saving_path: 'x/', audio_name: 'x.wav' })]
      }
    })
    try {
      const outcome = await sync.sync({ downloadAudio: false })
      assert.equal(outcome.skippedBadTime, 1)
      assert.equal(outcome.logsSeen, 1)
      assert.equal(env.alarms.query({ deviceId: 'dev-e2' }).total, 1)
      assert.ok(outcome.errors.some((message) => message.includes('时间无法解析')))
    } finally {
      env.db.close()
    }
  })

  it('`since` 之后的才同步，跳过的条数如实报出来', async () => {
    const { env, sync } = await setup({
      logs: {
        logs_count: 2,
        logs: [
          logEntry(),
          logEntry({
            id: 2,
            time: '2022-04-16_09-00-00',
            saving_path: '20220416_090000/',
            audio_name: '20220416_090000.wav'
          })
        ]
      }
    })
    try {
      const since = new Date(2022, 3, 16, 8, 0, 0, 0).getTime()
      const outcome = await sync.sync({ since, downloadAudio: false })
      assert.equal(outcome.skippedBySince, 1)
      assert.equal(outcome.logsSeen, 1)
      assert.equal(env.alarms.query({ deviceId: 'dev-e2' }).total, 1)
    } finally {
      env.db.close()
    }
  })

  it('`files_status = 0`：**登记那条告警**但不去下载（记录在、文件没了是预期状态）', async () => {
    const { fake, env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry({ files_status: 0 })] }
    })
    try {
      const outcome = await sync.sync()
      assert.equal(outcome.filesMissing, 1)
      assert.equal(outcome.alarmsCreated, 1)
      assert.equal(outcome.audioSaved, 0)
      assert.equal(outcome.audioFailed, 0)
      // 一次文件请求都不该发出。
      assert.equal(fake.requests.some((request) => request.path === '/alarm_files'), false)

      const alarm = env.alarms.query({ deviceId: 'dev-e2' }).items[0]
      assert.equal(alarm?.filesStatus, 0)
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子同步：Air Sonar（V3.2，另一代协议）', () => {
  /** Air Sonar 的 `/system`：PTZ 键在 ⇒ 变体判成 airSonar。 */
  const AIR_SONAR_SYSTEM = {
    cam_enable: true,
    cam_ip: '192.168.2.233',
    cam_port: 80,
    cur_realtime_channel: 2,
    db_limit: 50,
    tde_ratio_limit: 20,
    fde_ratio_limit: 0.2,
    freq_down_limit: 5000,
    freq_up_limit: 10000,
    is_save_snapshot: true,
    is_send_alarm: 1,
    samplerate: 20000
  }

  /** 一条 Air Sonar 的告警日志：**没有** alarm_value / alarm_reasons / audio_name。 */
  function airSonarEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 275,
      time: '2022-05-11_14-14-44',
      db_value: 65.07764,
      tde_ratio: 0.6642909,
      fde_ratio: 22.400711,
      horizontal: 357,
      vertical: 90,
      saving_path: '20220511_141444/',
      files_status: 1,
      ...overrides
    }
  }

  it('走 **Air Sonar 的端点**：`/get_all_alarms` + `/saving_alarm_file`，录音固定叫 `alarm.wav`', async () => {
    const { fake, env, sync } = await setup({
      system: AIR_SONAR_SYSTEM,
      logs: { logs_count: 1, logs: [airSonarEntry()] },
      files: { '20220511_141444/alarm.wav': ALARM_WAV }
    })
    try {
      const outcome = await sync.sync()
      assert.equal(outcome.alarmsCreated, 1)
      assert.equal(outcome.audioSaved, 1)

      // 端点用对了：2023 版那两个路径**一次都不该被碰**。
      const paths = fake.requests.map((request) => request.path)
      assert.ok(paths.includes('/get_all_alarms'), paths.join(','))
      assert.ok(paths.includes('/saving_alarm_file'), paths.join(','))
      assert.equal(paths.includes('/alarm_log_all'), false)
      assert.equal(paths.includes('/alarm_files'), false)

      // 文件名是设备给的还是固定的：这里设备**没有** audio_name 字段，靠变体补成 alarm.wav。
      const download = fake.requests.find((request) => request.path === '/saving_alarm_file')
      assert.equal(download?.query.get('file_path'), '20220511_141444/alarm.wav')

      const alarm = env.alarms.query({ deviceId: 'dev-e2' }).items[0]
      assert.ok(alarm)
      assert.equal(alarm.source, 'e2')
      assert.equal(alarm.alarmMask, 0)
      assert.equal(alarm.severity, 'unknown')
      // 这一代**没有** alarm_value 与原因文本：两者都**不该**被编出来。
      assert.equal(alarm.deviceAlarmValue, undefined)
      assert.equal(alarm.deviceReason, undefined)
      // 方位角在原始载荷里（那一代的特征字段）。
      const raw = JSON.parse(String(alarm.deviceRaw)) as Record<string, unknown>
      assert.equal(raw.horizontal, 357)
      assert.equal(raw.vertical, 90)
      // db_value → spl。
      assert.equal(alarm.spl, 65.07764)
    } finally {
      env.db.close()
    }
  })

  it('抓图是 **3 张**（PTZ 抓图，不是 10 张时频谱）', async () => {
    const files: Record<string, Buffer> = { '20220511_141444/alarm.wav': ALARM_WAV }
    for (const name of ['1.jpg', '2.jpg', '3.jpg']) {
      files[`20220511_141444/${name}`] = Buffer.from([0xff, 0xd8, 0xff])
    }
    const { fake, env, sync } = await setup({
      system: AIR_SONAR_SYSTEM,
      logs: { logs_count: 1, logs: [airSonarEntry()] },
      files
    })
    try {
      const outcome = await sync.sync({ downloadSpectrograms: true })
      assert.equal(outcome.spectrogramsSaved, 3)
      // **只问了 3 张**：第 4 张的问法（1..10）属于另一代。
      assert.equal(outcome.spectrogramsFailed, 0)
      const imageRequests = fake.requests.filter((request) =>
        request.query.get('file_path')?.endsWith('.jpg')
      )
      assert.equal(imageRequests.length, 3)
    } finally {
      env.db.close()
    }
  })

  it('同步前**先判变体**：一台 Air Sonar 不会被当成 2023 版去查 `/alarm_log_all`', async () => {
    const { fake, env, sync } = await setup({
      system: AIR_SONAR_SYSTEM,
      logs: { logs_count: 0, logs: [] }
    })
    try {
      await sync.sync({ downloadAudio: false })
      const paths = fake.requests.map((request) => request.path)
      // 第一次 `/system` 就是判定用的那一次。
      assert.ok(paths.includes('/system'))
      assert.equal(paths.includes('/alarm_log_all'), false)
    } finally {
      env.db.close()
    }
  })
})

describe('听诊盒子同步：录音落盘', () => {
  it('录音写进存储根、表头读出来的时长与采样率是真的', async () => {
    const { env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry()] },
      files: { '20220416_075133/20220416_075133.wav': ALARM_WAV }
    })
    try {
      const outcome = await sync.sync()
      assert.equal(outcome.audioSaved, 1)

      const page = env.recordings.query({ deviceId: 'dev-e2' })
      assert.equal(page.total, 1)
      const recording = page.items[0]
      assert.ok(recording)
      assert.equal(recording.recordingType, 'alarm')
      assert.equal(recording.eventType, 'e2_alarm')
      assert.equal(recording.audioFormat, 'wav')
      assert.equal(recording.fileSize, ALARM_WAV.byteLength)
      // 时长来自**真实表头**（10 秒），采样率也是。
      assert.equal(recording.durationMs, 10_000)
      assert.equal(recording.sampleRate, 48_000)
      assert.ok(recording.sha256 && recording.sha256.length === 64)
      // 相对路径在存储根下面，文件真的存在。
      assert.ok(recording.relativePath.length > 0)
      const absolute = path.join(env.storageRoot, ...recording.relativePath.split('/'))
      assert.equal(fs.existsSync(absolute), true)
      assert.equal(fs.statSync(absolute).size, ALARM_WAV.byteLength)

      // 告警行链到了那份录音。
      assert.equal(env.alarms.query({ deviceId: 'dev-e2' }).items[0]?.localRecordingId, recording.id)
    } finally {
      env.db.close()
    }
  })

  it('设备上没有那个文件（三条下载路径都 404）⇒ 记进"文件没了"，但**告警行照旧**、元数据行也在', async () => {
    const { env, sync } = await setup({ logs: { logs_count: 1, logs: [logEntry()] } })
    try {
      const outcome = await sync.sync()
      assert.equal(outcome.alarmsCreated, 1)
      /*
       * 2026-09-17 真机验证改了这条口径：三条**已文档化**的下载路径全 404，说明"设备上没有这个
       * 文件"（保留策略的预期结果），而不是"传输失败"。两者对操作员是两件事：
       * 前者去看保留策略，后者去看网络/权限/磁盘。原来一律记 `audioFailed`，于是真机上
       * "1001 条记录里 995 条的媒体文件已被清掉"会显示成"下载失败"，看起来像我们的问题。
       */
      assert.equal(outcome.filesMissing, 1)
      assert.equal(outcome.audioFailed, 0)
      assert.equal(outcome.audioSaved, 0)

      // 元数据行登着（relative_path 为空 = "文件还没下来"），这是与 FA8 同步同一条语义。
      const page = env.recordings.query({ deviceId: 'dev-e2' })
      assert.equal(page.total, 1)
      assert.equal(page.items[0]?.relativePath, '')
    } finally {
      env.db.close()
    }
  })

  it('下载到的不是 WAV（例如网关的 HTML）⇒ 失败计数，不写文件', async () => {
    const { env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry()] },
      files: { '20220416_075133/20220416_075133.wav': Buffer.from('<html>gateway</html>') }
    })
    try {
      const outcome = await sync.sync()
      assert.equal(outcome.audioFailed, 1)
      const recording = env.recordings.query({ deviceId: 'dev-e2' }).items[0]
      assert.equal(recording?.relativePath, '')
    } finally {
      env.db.close()
    }
  })

  it('磁盘低于安全水位 ⇒ 拒绝下载（`canRecord` 的政策，不是缺陷）', async () => {
    const fake = await startDevice({
      logs: { logs_count: 1, logs: [logEntry()] },
      files: { '20220416_075133/20220416_075133.wav': ALARM_WAV }
    })
    cleanup.push(fake.close)
    const env = harness()
    try {
      // 复制一份 storage，把"最小剩余空间"抬到不可能满足的值。
      const guarded = new StorageService({
        db: env.db,
        getStorageRoot: () => env.storageRoot,
        getMinFreeBytes: () => Number.MAX_SAFE_INTEGER
      })
      const sync = new E2SyncService({
        client: new E2Client({
          transport: new FetchHttpTransport(3_000),
          baseUrl: fake.baseUrl,
          credentials: { username: 'admin', password: 'x' }
        }),
        alarms: env.alarms,
        recordings: env.recordings,
        storage: guarded,
        deviceId: 'dev-e2',
        deviceUid: 'uid-e2'
      })

      const outcome = await sync.sync()
      assert.equal(outcome.audioFailed, 1)
      assert.equal(outcome.audioSaved, 0)

      // 下载请求发出去了（我们是在写盘前挡下的），但**一个字节都没落盘**。
      const recordings = env.recordings.query({ deviceId: 'dev-e2' })
      assert.equal(recordings.items[0]?.relativePath, '')
      const audioRoot = path.join(env.storageRoot, 'alarm')
      const written = fs.existsSync(audioRoot)
        ? fs.readdirSync(audioRoot, { recursive: true }).filter((name) => String(name).endsWith('.wav'))
        : []
      assert.deepEqual(written, [])
    } finally {
      env.db.close()
    }
  })

  it('时频谱图默认不下载；打开时按 1..10 张去取，缺图算"少几张"不是失败', async () => {
    const files: Record<string, Buffer> = {
      '20220416_075133/20220416_075133.wav': ALARM_WAV,
      '20220416_075133/1.jpg': Buffer.from([0xff, 0xd8, 0xff]),
      '20220416_075133/2.jpg': Buffer.from([0xff, 0xd8, 0xff])
    }
    const { fake, env, sync } = await setup({
      logs: { logs_count: 1, logs: [logEntry()] },
      files
    })
    try {
      const plain = await sync.sync()
      assert.equal(plain.spectrogramsSaved, 0)
      assert.equal(fake.requests.some((request) => request.query.get('file_path')?.endsWith('.jpg')), false)

      const withImages = await sync.sync({ downloadSpectrograms: true })
      // 两张有、八张缺：设备重启后不足 10 张是**正常**。
      assert.equal(withImages.spectrogramsSaved, 2)
      assert.equal(withImages.spectrogramsFailed, 8)
    } finally {
      env.db.close()
    }
  })

  it('一次最多处理 `limit` 条（分页只拉一页，界面反复点）', async () => {
    const logs = Array.from({ length: 5 }, (_, index) =>
      logEntry({
        id: index + 1,
        time: `2022-04-16_0${index}-00-00`,
        saving_path: `20220416_0${index}0000/`,
        audio_name: `20220416_0${index}0000.wav`
      })
    )
    const { env, sync } = await setup({ logs: { logs_count: 5, logs } })
    try {
      const outcome = await sync.sync({ limit: 3, downloadAudio: false })
      assert.equal(outcome.deviceLogCount, 5)
      assert.equal(outcome.logsSeen, 3)
      assert.equal(env.alarms.query({ deviceId: 'dev-e2' }).total, 3)
    } finally {
      env.db.close()
    }
  })
})
