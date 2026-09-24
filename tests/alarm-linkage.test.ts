/**
 * 告警本地联动（录像 / 弹窗 / 提示 / 邮件）的测试。
 *
 * ---------------------------------------------------------------------------
 * 这一组测试要证明什么，以及每一条对应产品要求里的哪句话
 * ---------------------------------------------------------------------------
 *   「一次触发只跑一次已开启的动作」 -> 引擎：动作与开关
 *   「冷却 / 限流：告警风暴不得产生 200 封邮件」 -> 引擎：冷却与频率上限
 *   「失败隔离」 -> 引擎：失败隔离
 *   「幂等：轮询与 WebSocket 报同一个事件只动作一次」 -> 引擎：跨源去重
 *   「游标：只报新事件、重启不重放、日志轮转有空洞」 -> 轮询游标
 *   「邮件：对着本地 stub SMTP 断言信封、报头与附件；连接被拒要有真实原因」 -> SMTP 客户端
 *   「录像：用注入的录制器断言时长与产物登记」 -> 录像动作
 *
 * 全部注入假实现：没有 Electron、没有 ffmpeg、没有相机、没有真实网络。
 * 唯一的例外是 stub SMTP —— 那是一个**真的 TCP 服务器**（`node:net`），
 * 因为「对着一个假对象断言」证明不了我们发到线上的字节是对的。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  linkAgeEventIdentity,
  parseLinkageEventIdentity,
  parseRecipientList,
  linkageCooldownSlot,
  DEFAULT_ALARM_LINKAGE_CONFIG,
  isLegacyDefaultAlarmLinkageConfig,
  LINKAGE_ACTION_KINDS,
  type AlarmLinkageConfig,
  type LinkageActionOutcome,
  type LinkageEmailMessage,
  type LinkageTrigger
} from '../src/shared/domain/alarm-linkage'
import {
  AlarmLinkageEngine,
  judge,
  popupLevel,
  type LinkageCandidate,
  type LinkageTriggerSource
} from '../src/main/services/linkage/alarm-linkage-engine'
import { PendingAlarmStore } from '../src/main/services/linkage/pending-alarm-store'
import {
  DetectLogsPollSource,
  MemoryPollCursorStore,
  pollDetectLogs
} from '../src/main/services/linkage/detect-logs-poll-source'
import { DetectFeedbackTriggerSource } from '../src/main/services/linkage/detect-feedback-source'
import {
  buildMessage,
  chunkBase64,
  dotStuff,
  encodeHeaderValue,
  SmtpClient,
  sanitiseFileName
} from '../src/main/services/linkage/smtp-client'
import {
  buildAlarmRecordArgs,
  expandTemplate,
  SmtpLinkageEmailSender,
  type LinkageEmailContext,
  type LinkagePopupRequest,
  type LinkagePopupSink,
  type LinkageRecorder,
  type LinkageRecordingRequest
} from '../src/main/services/linkage/linkage-actions'
import {
  normaliseAlarmLinkageConfig,
  cloneDefaults
} from '../src/main/services/settings/alarm-linkage-config'

// ---------------------------------------------------------------------------
// 共用夹具
// ---------------------------------------------------------------------------

/** 一套「全部打开」的配置，冷却为 0，和真实默认值分开写清楚。 */
function openConfig(overrides: Partial<AlarmLinkageConfig> = {}): AlarmLinkageConfig {
  const config = cloneDefaults()
  config.enabled = true
  config.actions = { record: true, popup: true, notice: true, email: true }
  config.recording = { durationSeconds: 30, cooldownSeconds: 0, skipWhenBusy: true }
  config.popup = { autoDismissSeconds: 15, cooldownSeconds: 0, maxStack: 3 }
  config.notices = { pendingCapacity: 200, cooldownSeconds: 0 }
  config.email = {
    ...config.email,
    host: 'smtp.test',
    port: 2525,
    security: 'none',
    username: '',
    smtpPasswordStored: false,
    from: 'manager@test',
    recipients: 'ops@test',
    subjectTemplate: 'alarm {device}',
    bodyTemplate: 'device={device} id={identity}',
    attachFrame: false,
    cooldownSeconds: 0
  }
  config.runtime = {
    maxActionsPerMinute: 1000,
    cooldown: { periodSeconds: 0, perPeriod: 1000, perInterface: 1000 }
  }
  return { ...config, ...overrides }
}

/** 计数器型假动作。 */
class FakeRecorder implements LinkageRecorder {
  readonly requests: LinkageRecordingRequest[] = []
  busy = false
  /** 一个动作返回的失败原因；`undefined` = 成功。 */
  failWith: string | undefined
  /** 每次调用要等多久（用来构造「同时到达」的场景）。 */
  delayMs = 0
  disposed = false

  isBusy(): boolean {
    return this.busy
  }

  async record(request: LinkageRecordingRequest): Promise<LinkageActionOutcome> {
    this.requests.push(request)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (this.failWith) {
      return { action: 'record', status: 'failed', reason: this.failWith, counted: true }
    }
    return {
      action: 'record',
      status: 'success',
      detail: { recordingId: `rec-${this.requests.length}`, requestedSeconds: request.durationSeconds }
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

class FakePopupSink implements LinkagePopupSink {
  readonly shown: LinkagePopupRequest[] = []
  failWith: string | undefined
  closed = false

  openCount(): number {
    return this.shown.length
  }

  async show(request: LinkagePopupRequest): Promise<LinkageActionOutcome> {
    this.shown.push(request)
    if (this.failWith) {
      return { action: 'popup', status: 'failed', reason: this.failWith, counted: true }
    }
    return { action: 'popup', status: 'success', detail: { popupId: request.popupId } }
  }

  closeAll(): void {
    this.closed = true
  }
}

class FakeEmailSender {
  readonly messages: Array<{ trigger: LinkageTrigger; context: LinkageEmailContext | null }> = []
  failWith: string | undefined

  async send(
    trigger: LinkageTrigger,
    context: LinkageEmailContext | null
  ): Promise<LinkageActionOutcome> {
    this.messages.push({ trigger, context })
    if (this.failWith) {
      return { action: 'email', status: 'failed', reason: this.failWith, counted: true }
    }
    return { action: 'email', status: 'success', detail: { accepted: ['ops@test'] } }
  }
}

/** 一次触发的候选事件。 */
function candidate(
  logId: number,
  startTime: number,
  overrides: Partial<LinkageCandidate> = {}
): LinkageCandidate {
  return {
    source: 'poll',
    deviceId: 'dev-1',
    deviceName: 'Camera 1',
    identity: linkAgeEventIdentity('dev-1', logId, startTime),
    at: startTime * 1000,
    observedAt: Date.now(),
    ...overrides
  }
}

/** 一个可控时钟。 */
function fakeClock(start = 1_700_000_000_000): {
  now: () => number
  advance: (ms: number) => void
} {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

interface EngineFixture {
  engine: AlarmLinkageEngine
  recorder: FakeRecorder
  popup: FakePopupSink
  email: FakeEmailSender
  pending: PendingAlarmStore
  logs: Array<{ message: string; payload: Record<string, unknown> }>
  config: AlarmLinkageConfig
  clock: ReturnType<typeof fakeClock>
  dir: string
}

/** 建一个全注入的引擎。 */
async function makeEngine(
  options: { config?: Partial<AlarmLinkageConfig>; dedupeCapacity?: number } = {}
): Promise<EngineFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-linkage-test-'))
  // 先归一化再交给引擎：测试里改一个子字段时，其余字段与生产路径一致
  // （生产路径上的配置来自 SettingsService，它总是先过归一化器）。
  const config = normaliseAlarmLinkageConfig(openConfig(options.config)).config
  const clock = fakeClock()
  const recorder = new FakeRecorder()
  const popup = new FakePopupSink()
  const email = new FakeEmailSender()
  const logs: Array<{ message: string; payload: Record<string, unknown> }> = []
  const pending = new PendingAlarmStore({
    directory: dir,
    capacity: () => config.notices.pendingCapacity,
    now: clock.now
  })
  await pending.load()

  const engine = new AlarmLinkageEngine({
    config: () => config,
    recorder,
    popup,
    email: email as never,
    pending,
    now: clock.now,
    dedupeCapacity: options.dedupeCapacity,
    log: (message, payload) => logs.push({ message, payload })
  })

  return { engine, recorder, popup, email, pending, logs, config, clock, dir }
}

// ---------------------------------------------------------------------------
// 引擎：动作与开关
// ---------------------------------------------------------------------------

describe('引擎：动作与开关', () => {
  it('默认配置：引擎默认开启（业主 2026-09-23），邮件仍默认关闭', () => {
    // 「告警信息应该默认开启」与「装完就往外发邮件的应用是缺陷」——两条都在这句断言里。
    assert.equal(DEFAULT_ALARM_LINKAGE_CONFIG.enabled, true)
    assert.equal(DEFAULT_ALARM_LINKAGE_CONFIG.actions.email, false)
    assert.equal(DEFAULT_ALARM_LINKAGE_CONFIG.email.host, '')
  })

  it('旧出厂默认（enabled:false 的整包落库）能被识别并升级，用户改过的不能', () => {
    // 没碰过联动设置的老装：与旧默认逐字段相等 → 允许设置服务升级。
    const legacy = { ...DEFAULT_ALARM_LINKAGE_CONFIG, enabled: false }
    assert.equal(isLegacyDefaultAlarmLinkageConfig(legacy), true)
    // 新默认本身不是「旧默认」。
    assert.equal(isLegacyDefaultAlarmLinkageConfig(DEFAULT_ALARM_LINKAGE_CONFIG), false)
    // 用户改过任何一格（哪怕只是一秒冷却）→ 尊重用户，不升级。
    const touched = { ...legacy, popup: { ...legacy.popup, cooldownSeconds: 9 } }
    assert.equal(isLegacyDefaultAlarmLinkageConfig(touched), false)
    const touchedEmail = { ...legacy, email: { ...legacy.email, host: 'smtp.example.com' } }
    assert.equal(isLegacyDefaultAlarmLinkageConfig(touchedEmail), false)
  })

  it('总开关关闭时一个动作都不跑，甚至不进去重表', async () => {
    const fixture = await makeEngine({ config: { enabled: false } })
    const outcomes = await fixture.engine.observe(candidate(1, 1000))
    assert.deepEqual(outcomes, [])
    assert.equal(fixture.recorder.requests.length, 0)
    assert.equal(fixture.popup.shown.length, 0)
    assert.equal(fixture.email.messages.length, 0)
    assert.equal(fixture.engine.hasSeen('dev-1:1:1000'), false)
  })

  it('一次触发把四个已开启的动作各跑一次', async () => {
    const fixture = await makeEngine()
    const outcomes = await fixture.engine.observe(candidate(7, 1700))

    assert.deepEqual(
      outcomes.map((outcome) => outcome.action),
      ['record', 'popup', 'notice', 'email']
    )
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ['success', 'success', 'success', 'success']
    )
    assert.equal(fixture.recorder.requests.length, 1)
    assert.equal(fixture.popup.shown.length, 1)
    assert.equal(fixture.email.messages.length, 1)
    const record = fixture.pending.find('dev-1:7:1700')
    assert.ok(record)
    assert.equal(record.actions.length, 4)
    assert.equal(record.recordingId, 'rec-1')
  })

  it('关掉的动作完全不被调用，也不产生任何副作用', async () => {
    const fixture = await makeEngine()
    fixture.config.actions = { record: false, popup: false, notice: true, email: false }
    const outcomes = await fixture.engine.observe(candidate(8, 1800))

    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ['skipped', 'skipped', 'success', 'skipped']
    )
    assert.equal(fixture.recorder.requests.length, 0)
    assert.equal(fixture.popup.shown.length, 0)
    assert.equal(fixture.email.messages.length, 0)
    // 「提示」仍然写入：四个动作里唯一不能关掉「告警还在」的那一个。
    assert.ok(fixture.pending.find('dev-1:8:1800'))
  })

  it('录像动作把配置的时长原样传下去', async () => {
    const fixture = await makeEngine()
    fixture.config.recording.durationSeconds = 45
    await fixture.engine.observe(candidate(9, 1900))
    assert.equal(fixture.recorder.requests[0]?.durationSeconds, 45)
  })

  it('弹窗请求带目录键、参数与自动关闭时长，且弹窗 id 是事件身份', async () => {
    const fixture = await makeEngine()
    fixture.config.popup.autoDismissSeconds = 7
    await fixture.engine.observe(candidate(10, 2000, { alarmLevelRaw: 4 }))
    const request = fixture.popup.shown[0]
    assert.ok(request)
    assert.equal(request.popupId, 'dev-1:10:2000')
    assert.equal(request.autoDismissSeconds, 7)
    assert.equal(request.level, 'critical')
    assert.equal(request.messageKey, 'linkage.popup.critical')
    assert.equal(request.params.device, 'Camera 1')
  })

  it('每一次触发与每一个动作结果都进审计日志', async () => {
    const fixture = await makeEngine()
    await fixture.engine.observe(candidate(11, 2100))
    const messages = fixture.logs.map((entry) => entry.message)
    assert.ok(messages.some((message) => message.includes('触发')))
    assert.ok(messages.some((message) => message.includes('动作成功')))
    const trigger = fixture.logs.find((entry) => entry.message.includes('触发'))
    assert.equal(trigger?.payload.eventId, 'dev-1:11:2100')
    assert.equal(trigger?.payload.rule, 'dev-1')
    assert.equal(trigger?.payload.decision, 'field-absent')
  })
})

// ---------------------------------------------------------------------------
// 引擎：冷却与频率上限
// ---------------------------------------------------------------------------

describe('引擎：冷却与频率上限', () => {
  it('同一规则在冷却期内不再重复执行，并如实给出剩余秒数', async () => {
    const fixture = await makeEngine()
    fixture.config.recording.cooldownSeconds = 30
    fixture.config.actions = { record: true, popup: false, notice: true, email: false }

    await fixture.engine.observe(candidate(1, 1000))
    fixture.clock.advance(5_000)
    const outcomes = await fixture.engine.observe(candidate(2, 1001))

    const record = outcomes.find((outcome) => outcome.action === 'record')
    assert.equal(record?.status, 'skipped')
    assert.match(String(record?.reason), /冷却中/)
    assert.match(String(record?.reason), /25 秒/)
    assert.equal(fixture.recorder.requests.length, 1)

    // 冷却过去之后照常执行。
    fixture.clock.advance(30_000)
    const after = await fixture.engine.observe(candidate(3, 1002))
    assert.equal(after.find((outcome) => outcome.action === 'record')?.status, 'success')
    assert.equal(fixture.recorder.requests.length, 2)
  })

  it('冷却是按规则（设备）分桶的：另一台相机不受影响', async () => {
    const fixture = await makeEngine()
    fixture.config.recording.cooldownSeconds = 60
    fixture.config.actions = { record: true, popup: false, notice: false, email: false }

    await fixture.engine.observe(candidate(1, 1000))
    const other: LinkageCandidate = {
      ...candidate(1, 1000),
      deviceId: 'dev-2',
      deviceName: 'Camera 2',
      identity: linkAgeEventIdentity('dev-2', 1, 1000)
    }
    const outcomes = await fixture.engine.observe(other)
    assert.equal(outcomes.find((outcome) => outcome.action === 'record')?.status, 'success')
    assert.equal(fixture.recorder.requests.length, 2)
  })

  it('窗口上限：每个 60 秒窗口内同一动作最多 N 次', async () => {
    const fixture = await makeEngine()
    fixture.config.actions = { record: false, popup: true, notice: false, email: false }
    fixture.config.popup.cooldownSeconds = 0
    fixture.config.runtime.cooldown = { periodSeconds: 60, perPeriod: 2, perInterface: 100 }

    // 全部落在**同一个窗口**（每次推进 1 秒，窗口是 60 秒）。
    for (let index = 0; index < 5; index += 1) {
      fixture.clock.advance(1_000)
      await fixture.engine.observe(candidate(100 + index, 3000 + index))
    }
    assert.equal(fixture.popup.shown.length, 2, '同一个窗口内第 3~5 条必须被挡住')

    // 窗口滑过去之后重新可用。
    fixture.clock.advance(61_000)
    await fixture.engine.observe(candidate(200, 4000))
    assert.equal(fixture.popup.shown.length, 3)
  })

  it('接口限流：一分钟被切成 6 片，每片最多 M 次（压平尖峰）', async () => {
    const fixture = await makeEngine()
    fixture.config.actions = { record: false, popup: true, notice: false, email: false }
    fixture.config.popup.cooldownSeconds = 0
    // perPeriod 放到很大：这条只考察「接口格」那一道闸门。
    fixture.config.runtime.cooldown = { periodSeconds: 60, perPeriod: 1000, perInterface: 1 }
    fixture.config.runtime.maxActionsPerMinute = 1000

    // 三条落在同一片 -> 只有第一条通过。
    for (let index = 0; index < 3; index += 1) {
      await fixture.engine.observe(candidate(300 + index, 5000 + index))
    }
    assert.equal(fixture.popup.shown.length, 1)

    /**
     * 跳到**下一个时间片**。
     *
     * `linkageCooldownSlot` = `floor(now / window) % slots`，片起点是
     * `window * k + slot * (window / slots)`——片长 10 秒，但锚点落在
     * 60 秒窗口的整数倍上（0/10/20/30/40/50 秒）。所以「+10 秒」或「+11 秒」
     * 都可能还留在同一片里（实测 1,700,000,000,000 正是这种情况）。
     *
     * 这里不去推算片起点，而是直接**推进一个完整窗口**：`floor(now / window)`
     * 必然加一，片号必然改变。这条用例考察的是「换片之后重新放行」，
     * 不是「怎么算片起点」——后者已经由 `联动工具函数` 那一组单独断言。
     */
    const before = linkageCooldownSlot(fixture.clock.now(), 60_000, 6)
    fixture.clock.advance(60_000)
    assert.notEqual(linkageCooldownSlot(fixture.clock.now(), 60_000, 6), before, '推进一个窗口必须换片')

    const after = await fixture.engine.observe(candidate(310, 5100))
    assert.equal(
      fixture.popup.shown.length,
      2,
      `新的一格必须重新放行一次；outcomes=${JSON.stringify(after)}`
    )
  })

  it('并发到达时全局上限是保守的（可能少放一次，但绝不会失控）', async () => {
    /**
     * 一个**刻意**的语义断言。
     *
     * 全局窗口是「先判断、后计数」的：`takeGlobalSlot()` 只看当前计数，
     * 而计数发生在动作真正开始之后。因此 N 条触发**同时**进来时（轮询一次
     * 拉到 N 条新日志就是这种情形），后面几条可能看到一个还没更新的计数而
     * 多跑一次。也就是说这个上限是「不超过很多」而不是「严格不超过 N」。
     *
     * 这条断言把真实的语义写下来，免得下一个人以为它是一道精确的闸门；
     * 而它保护的**不是**上限本身，是「告警风暴不会变成 40 封邮件」这件事：
     * 40 次请求被削到个位数才是这条栏杆要的效果。
     */
    const fixture = await makeEngine()
    fixture.config.runtime.maxActionsPerMinute = 8
    fixture.config.runtime.cooldown = { periodSeconds: 0, perPeriod: 1000, perInterface: 1000 }
    fixture.recorder.delayMs = 5

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        fixture.engine.observe(candidate(400 + index, 6000 + index))
      )
    )

    const executed =
      fixture.recorder.requests.length + fixture.popup.shown.length + fixture.email.messages.length
    assert.ok(executed > 0, '必须至少放行一次')
    assert.ok(executed < 40, `40 次请求必须被削平，实际 ${executed}`)
    assert.ok(executed <= 8 * 4, `全局上限失控：${executed}`)
  })

  it('每条事件最多触发一次：10 条突发最多 10 封邮件', async () => {
    // 这条与上一条是同一件事的两个方向：冷却保证「每条事件最多一次」，
    // 全局上限保证「总量有天花板」。两条都要成立。
    const fixture = await makeEngine()
    fixture.config.actions = { record: false, popup: false, notice: false, email: true }
    // perPeriod 放到足够大，单独考察「每条事件一次」这一条。
    fixture.config.runtime.cooldown = { periodSeconds: 60, perPeriod: 1000, perInterface: 1000 }
    fixture.config.runtime.maxActionsPerMinute = 1000
    fixture.config.email.cooldownSeconds = 0

    for (let index = 0; index < 10; index += 1) {
      fixture.clock.advance(1_000)
      await fixture.engine.observe(candidate(500 + index, 7000 + index))
    }
    assert.equal(fixture.email.messages.length, 10)
    // 事件身份各不相同，所以邮件里的 id 也必须各不相同。
    const ids = new Set(fixture.email.messages.map((entry) => entry.trigger.identity.eventId))
    assert.equal(ids.size, 10)
  })

  it('邮件冷却生效时，同一台相机的 10 条突发只产生 1 封', async () => {
    const fixture = await makeEngine()
    fixture.config.actions = { record: false, popup: false, notice: false, email: true }
    fixture.config.runtime.cooldown = { periodSeconds: 60, perPeriod: 1000, perInterface: 1000 }
    fixture.config.email.cooldownSeconds = 60

    for (let index = 0; index < 10; index += 1) {
      fixture.clock.advance(1_000)
      await fixture.engine.observe(candidate(600 + index, 8000 + index))
    }
    assert.equal(fixture.email.messages.length, 1)
  })
})

// ---------------------------------------------------------------------------
// 引擎：失败隔离
// ---------------------------------------------------------------------------

describe('引擎：失败隔离', () => {
  it('邮件失败不影响录像与弹窗，并且待处理记录里保留全部四条结果', async () => {
    const fixture = await makeEngine()
    fixture.email.failWith = 'SMTP 535 认证失败'

    const outcomes = await fixture.engine.observe(candidate(21, 2200))
    assert.equal(outcomes.find((outcome) => outcome.action === 'record')?.status, 'success')
    assert.equal(outcomes.find((outcome) => outcome.action === 'popup')?.status, 'success')
    const email = outcomes.find((outcome) => outcome.action === 'email')
    assert.equal(email?.status, 'failed')
    assert.equal(email?.reason, 'SMTP 535 认证失败')

    const record = fixture.pending.find('dev-1:21:2200')
    assert.ok(record, '告警本身必须在待处理列表里，与动作成败无关')
    assert.equal(record.actions.length, 4)
    assert.equal(record.actions.find((action) => action.action === 'email')?.status, 'failed')
  })

  it('录像失败不影响弹窗与邮件，且待处理记录仍然是告警', async () => {
    const fixture = await makeEngine()
    fixture.recorder.failWith = 'ffmpeg 退出码 1'

    const outcomes = await fixture.engine.observe(candidate(22, 2300))
    assert.equal(outcomes.find((outcome) => outcome.action === 'record')?.status, 'failed')
    assert.equal(outcomes.find((outcome) => outcome.action === 'popup')?.status, 'success')
    assert.equal(outcomes.find((outcome) => outcome.action === 'email')?.status, 'success')
    assert.ok(fixture.pending.find('dev-1:22:2300'))
  })

  it('一个抛出异常的动作被隔离，其余动作照常完成', async () => {
    const fixture = await makeEngine()
    const brokenRecorder: LinkageRecorder = {
      isBusy: () => false,
      record: async () => {
        throw new Error('录制器内部炸了')
      },
      dispose: () => undefined
    }
    const engine = new AlarmLinkageEngine({
      config: () => fixture.config,
      recorder: brokenRecorder,
      popup: fixture.popup,
      email: fixture.email as never,
      pending: fixture.pending,
      now: fixture.clock.now,
      log: () => undefined
    })

    const outcomes = await engine.observe(candidate(23, 2400))
    const record = outcomes.find((outcome) => outcome.action === 'record')
    assert.equal(record?.status, 'failed')
    assert.match(String(record?.reason), /内部炸了/)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'success').length, 3)
    assert.ok(fixture.pending.find('dev-1:23:2400'))
  })

  it('全部动作都失败时告警仍然进入待处理列表（「失败不得丢失告警」）', async () => {
    const fixture = await makeEngine()
    fixture.recorder.failWith = '磁盘满'
    fixture.popup.failWith = '窗口创建失败'
    fixture.email.failWith = '连接被拒'
    // notice 是唯一不会失败的：它只是「那条记录还在不在」。
    const outcomes = await fixture.engine.observe(candidate(24, 2500))
    assert.equal(outcomes.filter((outcome) => outcome.status === 'failed').length, 3)
    assert.equal(outcomes.find((outcome) => outcome.action === 'notice')?.status, 'success')

    const snapshot = fixture.pending.snapshot()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0]?.eventId, 'dev-1:24:2500')
    assert.equal(snapshot.dropped, 0)
  })

  it('待处理列表超出上限时丢最旧的并如实计数，绝不静默', async () => {
    const fixture = await makeEngine()
    fixture.config.notices.pendingCapacity = 2
    fixture.config.actions = { record: false, popup: false, notice: true, email: false }

    for (let index = 0; index < 5; index += 1) {
      await fixture.engine.observe(candidate(700 + index, 9000 + index))
    }
    const snapshot = fixture.pending.snapshot()
    assert.equal(snapshot.items.length, 2)
    assert.equal(snapshot.dropped, 3)
    // 留下的是最新的两条。
    assert.deepEqual(
      snapshot.items.map((item) => item.eventId).sort(),
      ['dev-1:703:9003', 'dev-1:704:9004']
    )
  })
})

// ---------------------------------------------------------------------------
// 引擎：跨源去重
// ---------------------------------------------------------------------------

describe('引擎：跨源去重', () => {
  it('轮询与 WebSocket 报同一个事件（同一身份）时只动作一次', async () => {
    const fixture = await makeEngine()
    const first = await fixture.engine.observe(candidate(31, 3100, { source: 'poll' }))
    const second = await fixture.engine.observe(candidate(31, 3100, { source: 'websocket' }))

    assert.equal(first.length, 4)
    assert.deepEqual(second, [], '第二次必须一个动作都不跑')
    assert.equal(fixture.recorder.requests.length, 1)
    assert.equal(fixture.popup.shown.length, 1)
    assert.equal(fixture.email.messages.length, 1)
    assert.equal(fixture.pending.snapshot().items.length, 1, '界面上只能出现一行')
  })

  it('反过来的顺序（先 WebSocket 后轮询）同样只动作一次', async () => {
    const fixture = await makeEngine()
    await fixture.engine.observe(candidate(32, 3200, { source: 'websocket' }))
    const second = await fixture.engine.observe(candidate(32, 3200, { source: 'poll' }))
    assert.deepEqual(second, [])
    assert.equal(fixture.recorder.requests.length, 1)
  })

  it('第二次的日志说明「已处理过」，并带上后到的来源', async () => {
    const fixture = await makeEngine()
    await fixture.engine.observe(candidate(33, 3300, { source: 'poll' }))
    await fixture.engine.observe(candidate(33, 3300, { source: 'websocket' }))
    const skipped = fixture.logs.find((entry) => entry.message.includes('已处理过'))
    assert.ok(skipped)
    assert.equal(skipped.payload.source, 'websocket')
  })

  it('身份是 deviceId:logId:startTime，同一日志编号配不同开始时刻算两件事', () => {
    const first = linkAgeEventIdentity('dev-1', 7, 1000)
    const second = linkAgeEventIdentity('dev-1', 7, 2000)
    const otherDevice = linkAgeEventIdentity('dev-2', 7, 1000)
    assert.notEqual(first.eventId, second.eventId)
    assert.notEqual(first.eventId, otherDevice.eventId)
    assert.equal(first.identityKind, 'device:logId:startTime')

    // 缺字段时用 `-`，身份退化但仍然是稳定的。
    const degraded = linkAgeEventIdentity('dev-1', undefined, undefined)
    assert.equal(degraded.eventId, 'dev-1:-:-')
    assert.equal(degraded.logId, undefined)

    const parsed = parseLinkageEventIdentity('dev-1:7:1000')
    assert.equal(parsed.deviceId, 'dev-1')
    assert.equal(parsed.logId, 7)
    assert.equal(parsed.startTime, 1000)
  })

  it('去重表有上限：超出后最旧的身份被淘汰（内存不会无界增长）', async () => {
    const fixture = await makeEngine({ dedupeCapacity: 3 })
    fixture.config.actions = { record: false, popup: false, notice: true, email: false }
    for (let index = 0; index < 5; index += 1) {
      await fixture.engine.observe(candidate(800 + index, 10_000 + index))
    }
    assert.equal(fixture.engine.hasSeen('dev-1:800:10000'), false)
    assert.equal(fixture.engine.hasSeen('dev-1:804:10004'), true)
  })

  it('告警判定：is_alarm=false 不触发，字段缺失按「是告警」处理', () => {
    const config = openConfig()
    assert.equal(judge(config, candidate(1, 1000, { alarmFlag: false })), 'not-alarm')
    assert.equal(judge(config, candidate(1, 1000, { alarmFlag: true })), 'is-alarm-flag')
    assert.equal(judge(config, candidate(1, 1000)), 'field-absent')

    const filtered: AlarmLinkageConfig = { ...config, minAlarmLevel: 3 }
    assert.equal(judge(filtered, candidate(1, 1000, { alarmLevelRaw: 1 })), 'below-min-level')
    assert.equal(judge(filtered, candidate(1, 1000, { alarmLevelRaw: 3 })), 'field-absent')
  })

  it('被判为「不是告警」的事件不跑动作，但会被记进去重表', async () => {
    const fixture = await makeEngine()
    const outcomes = await fixture.engine.observe(candidate(34, 3400, { alarmFlag: false }))
    assert.deepEqual(outcomes, [])
    assert.equal(fixture.pending.snapshot().items.length, 0)
    assert.equal(fixture.engine.hasSeen('dev-1:34:3400'), true)
  })

  it('弹窗级别由告警等级决定', () => {
    const base = candidate(1, 1000)
    const trigger = (level?: number): LinkageTrigger => ({
      identity: base.identity,
      observedAt: base.observedAt,
      ruleId: 'dev-1',
      deviceId: 'dev-1',
      deviceName: 'Camera 1',
      source: 'poll',
      decision: 'field-absent',
      ...(level !== undefined ? { alarmLevelRaw: level } : {})
    })
    assert.equal(popupLevel(trigger()), 'warning')
    assert.equal(popupLevel(trigger(1)), 'info')
    assert.equal(popupLevel(trigger(2)), 'warning')
    assert.equal(popupLevel(trigger(4)), 'critical')
  })
})

// ---------------------------------------------------------------------------
// 轮询游标
// ---------------------------------------------------------------------------

describe('轮询游标', () => {
  const device = { id: 'dev-1', name: 'Camera 1' }

  function options(
    logs: unknown[],
    overrides: Partial<Parameters<typeof pollDetectLogs>[2]> = {}
  ): Parameters<typeof pollDetectLogs>[2] {
    return {
      devices: () => [{ id: 'dev-1', name: 'Camera 1', kind: 'acousticCamera' as const }],
      fetchLogs: async () => logs as never,
      intervalMs: () => 10_000,
      cursors: new MemoryPollCursorStore(),
      now: () => 1_700_000_000_000,
      ...overrides
    }
  }

  it('首次运行只建立基线，不对历史记录联动', async () => {
    const result = await pollDetectLogs(
      device,
      undefined,
      options([
        { id: 1, startTimeRaw: 100, timeUnit: 'unknown', resultFiles: {} },
        { id: 2, startTimeRaw: 200, timeUnit: 'unknown', resultFiles: {} }
      ])
    )
    assert.equal(result.baselineEstablished, true)
    assert.equal(result.candidates.length, 0)
    assert.equal(result.cursor.logId, 2)
    assert.equal(result.cursor.startTime, 200)
  })

  it('只报比游标新的日志', async () => {
    const result = await pollDetectLogs(
      device,
      { logId: 2, startTime: 200, updatedAt: 0 },
      options([
        { id: 1, startTimeRaw: 100, timeUnit: 'unknown', resultFiles: {} },
        { id: 2, startTimeRaw: 200, timeUnit: 'unknown', resultFiles: {} },
        { id: 3, startTimeRaw: 300, timeUnit: 'unknown', resultFiles: {} }
      ])
    )
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.identity.eventId, 'dev-1:3:300')
    assert.equal(result.gap, false)
    assert.equal(result.cursor.logId, 3)
  })

  it('重启不重放：同一批日志第二次轮询不产生候选', async () => {
    const cursors = new MemoryPollCursorStore()
    const logs = [
      { id: 10, startTimeRaw: 1000, timeUnit: 'unknown', resultFiles: {} },
      { id: 11, startTimeRaw: 1100, timeUnit: 'unknown', resultFiles: {} }
    ]
    const opts = options(logs, { cursors })

    // 第一轮：建立基线（没有候选），游标落盘。
    const first = await pollDetectLogs(device, cursors.load('dev-1'), opts)
    cursors.save('dev-1', first.cursor)
    assert.equal(first.candidates.length, 0)

    // 模拟进程重启：内存全部丢掉，只从磁盘读游标。
    const second = await pollDetectLogs(device, cursors.load('dev-1'), opts)
    assert.equal(second.candidates.length, 0, '重启之后同一批历史日志不得再触发')
    assert.equal(second.baselineEstablished, false)
  })

  it('有新日志时才产生候选，并推进游标', async () => {
    const cursors = new MemoryPollCursorStore()
    cursors.save('dev-1', { logId: 11, startTime: 1100, updatedAt: 0 })
    const result = await pollDetectLogs(
      device,
      cursors.load('dev-1'),
      options([
        { id: 11, startTimeRaw: 1100, timeUnit: 'unknown', resultFiles: {} },
        { id: 12, startTimeRaw: 1200, timeUnit: 'unknown', resultFiles: {} }
      ])
    )
    assert.equal(result.candidates.length, 1)
    assert.equal(result.cursor.logId, 12)
  })

  it('日志轮转（设备只留最近 100 条）造成的空洞被明确报告', async () => {
    const result = await pollDetectLogs(
      device,
      { logId: 5, startTime: 500, updatedAt: 0 },
      options([
        { id: 101, startTimeRaw: 1010, timeUnit: 'unknown', resultFiles: {} },
        { id: 102, startTimeRaw: 1020, timeUnit: 'unknown', resultFiles: {} }
      ])
    )
    assert.equal(result.gap, true, '游标编号不在这一批里 = 中间有记录被设备删掉了')
    assert.equal(result.candidates.length, 2, '空洞时宁可多报也不漏报')
    assert.equal(result.cursor.logId, 102)
  })

  it('设备清空日志时不报空洞也不报事件', async () => {
    const result = await pollDetectLogs(
      device,
      { logId: 5, startTime: 500, updatedAt: 0 },
      options([])
    )
    assert.equal(result.gap, false)
    assert.equal(result.candidates.length, 0)
    assert.equal(result.cursor.logId, 5, '游标保持不变，等设备重新产生日志')
  })

  it('没有 id 的日志被跳过（身份会退化到撞车），并如实计数', async () => {
    const result = await pollDetectLogs(
      device,
      { logId: 1, startTime: 100, updatedAt: 0 },
      options([
        { startTimeRaw: 900, timeUnit: 'unknown', resultFiles: {} },
        { id: 2, startTimeRaw: 200, timeUnit: 'unknown', resultFiles: {} }
      ])
    )
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.identity.eventId, 'dev-1:2:200')
    assert.equal(result.fetched, 2)
  })

  it('推送源：相机的告警记录映射成同一个事件身份（与轮询/WS 去重契约一致）', async () => {
    const { toPushCandidate } = await import('../src/main/services/linkage/camera-push-source')
    const { mapDetectLog } = await import('../src/main/services/device/fa371/mappers')
    // 2026-09-24 真机 /detect_logs 的实际字段形状（局放告警）。
    const log = mapDetectLog({
      id: 8,
      start_time: 1790152618,
      is_alarm: true,
      alarm_level: 2,
      alarm_strategy_id: 1,
      detect_mode: 1,
      discharge_type: 4,
      last_alarm_db: 42.47,
      last_alarm_df: 24218,
      data_1: 0.0
    })
    const candidate = toPushCandidate({ id: 'cam-1', name: 'Acoustic Camera' }, log, 5000)
    assert.ok(candidate)
    assert.equal(candidate.source, 'push')
    assert.equal(candidate.alarmFlag, true)
    assert.equal(candidate.alarmLevelRaw, 2)
    assert.equal(candidate.detectMode, 1)
    assert.equal(candidate.dischargeTypeKey, 'discharge')
    assert.equal(candidate.metrics?.alarmDb, 42.47)
    // 局放记录里的 data_1=0 只是占位：泄漏量不得出现在局放告警上。
    assert.equal(candidate.metrics?.leakVolume, undefined)
    // 没有 id 的记录产不出事件（身份会撞车，宁可不报）。
    assert.equal(toPushCandidate({ id: 'cam-1', name: 'C' }, mapDetectLog({}), 5000), undefined)
  })

  it('候选事件带上设备给的可选字段（等级、策略、指标）', async () => {
    const result = await pollDetectLogs(
      device,
      { logId: 1, startTime: 100, updatedAt: 0 },
      options([
        {
          id: 2,
          startTimeRaw: 200,
          timeUnit: 'unknown',
          resultFiles: {},
          isAlarm: true,
          alarmLevelRaw: 3,
          alarmStrategyId: 9,
          soundmapIntensity: 20.4,
          leakVolume: 0.5
        }
      ])
    )
    const event = result.candidates[0]
    assert.ok(event)
    assert.equal(event.alarmFlag, true)
    assert.equal(event.alarmLevelRaw, 3)
    assert.equal(event.strategyId, 9)
    assert.equal(event.metrics?.soundmapIntensity, 20.4)
    assert.equal(event.metrics?.leakVolume, 0.5)
    assert.equal(event.source, 'poll')
  })

  it('轮询源把候选交给监听者，并在某台设备读取失败时不影响其它设备', async () => {
    const cursors = new MemoryPollCursorStore()
    cursors.save('dev-1', { logId: 0, startTime: 0, updatedAt: 0 })
    cursors.save('dev-2', { logId: 0, startTime: 0, updatedAt: 0 })

    const source = new DetectLogsPollSource({
      devices: () => [
        { id: 'dev-1', name: 'Camera 1', kind: 'acousticCamera' as const },
        { id: 'dev-2', name: 'Camera 2', kind: 'acousticCamera' as const }
      ],
      fetchLogs: async (deviceId: string) => {
        if (deviceId === 'dev-1') throw new Error('设备不可达')
        return [{ id: 1, startTimeRaw: 100, timeUnit: 'unknown', resultFiles: {} }] as never
      },
      intervalMs: () => 10_000,
      cursors
    })

    const received: LinkageCandidate[] = []
    source.onCandidate((event) => received.push(event))
    await source.tickAll()

    assert.equal(received.length, 1, '一台设备失败不得让另一台的事件丢失')
    assert.equal(received[0]?.deviceId, 'dev-2')
    assert.match(String(source.status().lastError), /不可达/)
    source.dispose()
  })

  it('轮询源只观察声学相机（声纹设备没有检测日志）', async () => {
    const source = new DetectLogsPollSource({
      devices: () => [
        { id: 'box-1', name: 'Box', kind: 'acousticBox' as const },
        { id: 'cam-1', name: 'Camera', kind: 'acousticCamera' as const }
      ],
      fetchLogs: async () => [],
      intervalMs: () => 10_000,
      cursors: new MemoryPollCursorStore()
    })
    assert.deepEqual(source.deviceIds, ['cam-1'])
    source.dispose()
  })

  it('游标存储是幂等的：同一台设备重复保存只留最新值', () => {
    const store = new MemoryPollCursorStore()
    store.save('dev-1', { logId: 1, startTime: 100, updatedAt: 1 })
    store.save('dev-1', { logId: 2, startTime: 200, updatedAt: 2 })
    assert.equal(store.load('dev-1')?.logId, 2)
    assert.equal(store.load('dev-2'), undefined)
  })
})

// ---------------------------------------------------------------------------
// WebSocket 加速器
// ---------------------------------------------------------------------------

describe('/detectFeedback 加速器', () => {
  /** 一个最小的事件源，测试直接喂帧。 */
  class FakeStreams {
    private handlers = new Set<(preview: unknown) => void>()
    on(_event: 'preview', listener: (preview: unknown) => void): unknown {
      this.handlers.add(listener)
      return this
    }
    off(_event: 'preview', listener: (preview: unknown) => void): unknown {
      this.handlers.delete(listener)
      return this
    }
    emit(preview: unknown): void {
      for (const handler of this.handlers) handler(preview)
    }
    get subscriberCount(): number {
      return this.handlers.size
    }
  }

  it('收到帧之前不做任何事，status 里 frames=0 是一个结论', () => {
    const streams = new FakeStreams()
    const source = new DetectFeedbackTriggerSource({
      streams,
      devices: () => [{ id: 'cam-1', name: 'Camera', kind: 'acousticCamera' as const }]
    })
    const received: LinkageCandidate[] = []
    source.onCandidate((event) => received.push(event))
    source.start()

    assert.equal(source.status().frames, 0)
    assert.equal(source.status().running, true)
    assert.equal(received.length, 0)
    assert.equal(source.status().triggers, 0)
    source.stop()
  })

  it('帧到达时产出与轮询源同构的候选（同一事件身份）', () => {
    const streams = new FakeStreams()
    const source = new DetectFeedbackTriggerSource({
      streams,
      devices: () => [{ id: 'cam-1', name: 'Camera', kind: 'acousticCamera' as const }]
    })
    const received: LinkageCandidate[] = []
    source.onCandidate((event) => received.push(event))
    source.start()

    streams.emit({
      kind: 'detectFeedback',
      deviceId: 'cam-1',
      timestamp: 123,
      logs: [{ id: 42, startTimeRaw: 1700, timeUnit: 'unknown', resultFiles: {}, isAlarm: true }]
    })

    assert.equal(received.length, 1)
    assert.equal(received[0]?.identity.eventId, 'cam-1:42:1700')
    assert.equal(received[0]?.source, 'websocket')
    assert.equal(source.status().frames, 1)
    source.stop()
    assert.equal(streams.subscriberCount, 0, '停止时必须摘掉监听，否则是永久泄漏')
  })

  it('非 detectFeedback 的预览被忽略（同一个 preview 事件上还跑着另外四路）', () => {
    const streams = new FakeStreams()
    const source = new DetectFeedbackTriggerSource({
      streams,
      devices: () => [{ id: 'cam-1', name: 'Camera', kind: 'acousticCamera' as const }]
    })
    const received: LinkageCandidate[] = []
    source.onCandidate((event) => received.push(event))
    source.start()

    streams.emit({ kind: 'fftData', deviceId: 'cam-1', timestamp: 1, bins: [], binCount: 0 })
    streams.emit({ kind: 'pcmData', deviceId: 'cam-1', timestamp: 1, peak: 0, rms: 0, waveform: [] })
    assert.equal(received.length, 0)
    assert.equal(source.status().frames, 0)
    source.stop()
  })

  it('加速器与轮询源产出同一个身份：引擎只动作一次', async () => {
    const fixture = await makeEngine()
    const streams = new FakeStreams()
    const source = new DetectFeedbackTriggerSource({
      streams,
      devices: () => [{ id: 'dev-1', name: 'Camera 1', kind: 'acousticCamera' as const }]
    })
    const received: LinkageCandidate[] = []
    source.onCandidate(async (event) => {
      received.push(event)
      await fixture.engine.observe(event)
    })
    source.start()

    // 轮询先到。
    await fixture.engine.observe(candidate(77, 7700, { source: 'poll' }))
    // 加速器随后推同一件检测结果。
    streams.emit({
      kind: 'detectFeedback',
      deviceId: 'dev-1',
      timestamp: 1,
      logs: [{ id: 77, startTimeRaw: 7700, timeUnit: 'unknown', resultFiles: {} }]
    })
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(received.length, 1)
    assert.equal(fixture.recorder.requests.length, 1, '同一个事件只能录一次像')
    assert.equal(fixture.email.messages.length, 1)
    assert.equal(fixture.pending.snapshot().items.length, 1)
    source.stop()
  })
})

// ---------------------------------------------------------------------------
// SMTP 客户端（对着一个真实的本地 stub 服务器）
// ---------------------------------------------------------------------------

interface StubSession {
  commands: string[]
  /** 收到的完整 DATA 段（原始文本，含报头）。 */
  data: string
  auth?: string
}

interface StubServer {
  port: number
  sessions: StubSession[]
  close: () => Promise<void>
}

/**
 * 一个**真的** TCP SMTP 服务器。
 *
 * 为什么要立一个真的：任务明确要求「不许 presumed works」。一个假对象只能证明
 * 我们调用了某个方法，证明不了发到线上的字节是对的——而报头折行、点填充、
 * 附件 base64 这些恰恰只有把字节读回来才能验证。
 */
async function startStubSmtp(
  options: { rejectAuth?: boolean; rejectRecipient?: string } = {}
): Promise<StubServer> {
  const sessions: StubSession[] = []
  const server = net.createServer((socket) => {
    const session: StubSession = { commands: [], data: '' }
    sessions.push(session)
    let inData = false
    let buffer = ''
    let authStage = 0

    socket.write('220 stub ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\r\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)

        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 OK queued\r\n')
            continue
          }
          // 反转点填充，拿回调用方真正写下的内容。
          session.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`
          continue
        }

        session.commands.push(line)
        const upper = line.toUpperCase()

        if (upper.startsWith('EHLO')) {
          socket.write('250-stub greets you\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n')
          continue
        }
        if (upper.startsWith('AUTH PLAIN')) {
          session.auth = 'PLAIN'
          if (options.rejectAuth) {
            socket.write('535 5.7.8 authentication failed\r\n')
            continue
          }
          socket.write('235 2.7.0 accepted\r\n')
          continue
        }
        if (upper.startsWith('AUTH LOGIN')) {
          session.auth = 'LOGIN'
          authStage = 1
          socket.write('334 VXNlcm5hbWU6\r\n')
          continue
        }
        if (authStage === 1) {
          authStage = 2
          socket.write('334 UGFzc3dvcmQ6\r\n')
          continue
        }
        if (authStage === 2) {
          authStage = 0
          if (options.rejectAuth) {
            socket.write('535 5.7.8 authentication failed\r\n')
            continue
          }
          socket.write('235 2.7.0 accepted\r\n')
          continue
        }
        if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n')
          continue
        }
        if (upper.startsWith('RCPT TO')) {
          if (options.rejectRecipient && line.includes(options.rejectRecipient)) {
            socket.write('550 5.1.1 no such user\r\n')
            continue
          }
          socket.write('250 OK\r\n')
          continue
        }
        if (upper === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          continue
        }
        if (upper === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
          continue
        }
        if (upper.startsWith('RSET') || upper.startsWith('NOOP')) {
          socket.write('250 OK\r\n')
          continue
        }
        socket.write('500 unrecognised\r\n')
      }
    })
    socket.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

/** 从这个 STUB 服务器取回最后一封信的 DATA 段。 */
function lastMessage(server: StubServer): string {
  const session = server.sessions[server.sessions.length - 1]
  return session?.data ?? ''
}

/** 把一封信的 DATA 段拆成「报头 map + 正文」。 */
function parseMessage(data: string): { headers: Map<string, string>; body: string } {
  const separator = data.indexOf('\r\n\r\n')
  const head = separator === -1 ? data : data.slice(0, separator)
  const body = separator === -1 ? '' : data.slice(separator + 4)
  const headers = new Map<string, string>()
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
  }
  return { headers, body }
}

describe('SMTP 客户端', () => {
  const servers: StubServer[] = []

  after(async () => {
    for (const server of servers) await server.close()
  })

  async function stub(
    options: { rejectAuth?: boolean; rejectRecipient?: string } = {}
  ): Promise<StubServer> {
    const server = await startStubSmtp(options)
    servers.push(server)
    return server
  }

  it('普通投递：信封、报头与正文都对，并逐行留下 transcript', async () => {
    const server = await stub()
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'none' })
    const result = await client.send({
      from: 'manager@test',
      to: ['ops@test', 'oncall@test'],
      subject: 'alarm Camera 1',
      text: 'plain body\nsecond line'
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    const session = server.sessions[0]
    assert.ok(session)
    assert.ok(session.commands.some((line) => line.startsWith('MAIL FROM:<manager@test>')))
    assert.ok(session.commands.some((line) => line.includes('RCPT TO:<ops@test>')))
    assert.ok(session.commands.some((line) => line.includes('RCPT TO:<oncall@test>')))
    assert.ok(session.commands.includes('DATA'))
    assert.ok(session.commands.includes('QUIT'))

    const message = parseMessage(lastMessage(server))
    assert.equal(message.headers.get('from'), 'manager@test')
    assert.equal(message.headers.get('to'), 'ops@test, oncall@test')
    assert.equal(message.headers.get('subject'), 'alarm Camera 1')
    assert.equal(message.headers.get('mime-version'), '1.0')
    assert.ok(message.headers.get('message-id'))
    assert.equal(message.headers.get('content-transfer-encoding'), 'base64')

    // 正文是 base64，解回来要一模一样。
    const decoded = Buffer.from(message.body.replace(/\r\n/g, ''), 'base64').toString('utf8')
    assert.equal(decoded, 'plain body\nsecond line')

    if (result.ok) {
      assert.deepEqual(result.accepted, ['ops@test', 'oncall@test'])
      assert.ok(result.transcript.length > 0)
    }
  })

  it('附件：multipart 边界、Content-Disposition、base64 内容逐字节一致', async () => {
    const server = await stub()
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'none' })
    // 一段二进制：含 NUL 与高位字节，能证明走的是 base64 而不是被当成文本。
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

    const result = await client.send({
      from: 'manager@test',
      to: ['ops@test'],
      subject: 'with frame',
      text: 'see attachment',
      attachment: { fileName: 'alarm.jpg', contentType: 'image/jpeg', bytes }
    })
    assert.equal(result.ok, true, JSON.stringify(result))

    const message = parseMessage(lastMessage(server))
    const contentType = message.headers.get('content-type') ?? ''
    assert.match(contentType, /^multipart\/mixed; boundary="/)
    const boundary = /boundary="([^"]+)"/.exec(contentType)?.[1]
    assert.ok(boundary)

    const body = lastMessage(server)
    assert.ok(body.includes(`--${boundary}`))
    assert.ok(body.includes(`--${boundary}--`), '结束边界不能少')
    assert.ok(body.includes('Content-Disposition: attachment; filename="alarm.jpg"'))
    assert.ok(body.includes('Content-Type: image/jpeg; name="alarm.jpg"'))

    // 取回附件那一段并解码。
    const attachmentIndex = body.indexOf('filename="alarm.jpg"')
    assert.ok(attachmentIndex > 0)
    const afterHeader = body.slice(body.indexOf('\r\n\r\n', attachmentIndex) + 4)
    const attachmentBody = afterHeader.slice(0, afterHeader.indexOf(`--${boundary}`))
    const decoded = Buffer.from(attachmentBody.replace(/\r\n/g, ''), 'base64')
    assert.deepEqual([...decoded], [...bytes], '附件必须逐字节一致')
  })

  it('认证：AUTH PLAIN 一次成功，且口令不进 transcript', async () => {
    const server = await stub()
    const transcript: string[] = []
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: server.port,
      security: 'none',
      username: 'manager',
      password: 's3cret-token',
      onTranscript: (line) => transcript.push(line)
    })
    const result = await client.send({
      from: 'manager@test',
      to: ['ops@test'],
      subject: 'auth',
      text: 'x'
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(server.sessions[0]?.auth, 'PLAIN')
    assert.equal(
      transcript.some((line) => line.includes('s3cret-token')),
      false,
      '口令绝不能出现在 transcript 里'
    )
    assert.ok(
      transcript.some((line) => line === 'C: AUTH PLAIN ***'),
      `transcript 里要有被打码的 AUTH 行，实际：${JSON.stringify(transcript.slice(0, 8))}`
    )
  })

  it('认证被拒：返回真实原因（535），而不是一句「发送失败」', async () => {
    const server = await stub({ rejectAuth: true })
    const client = new SmtpClient({
      host: '127.0.0.1',
      port: server.port,
      security: 'none',
      username: 'manager',
      password: 'wrong'
    })
    const result = await client.send({
      from: 'manager@test',
      to: ['ops@test'],
      subject: 'x',
      text: 'y'
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.detail ?? '', /535/)
      // 具体是 PLAIN 还是 LOGIN 被拒由服务器决定，两者都必须指向 535。
      assert.match(result.error, /认证失败|口令被拒绝/)
    }
  })

  it('收件人被拒：报告哪一个被拒、哪一个被接受', async () => {
    const server = await stub({ rejectRecipient: 'ghost@test' })
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'none' })
    const result = await client.send({
      from: 'manager@test',
      to: ['ops@test', 'ghost@test'],
      subject: 'x',
      text: 'y'
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.accepted, ['ops@test'])
  })

  it('所有收件人都被拒 -> 失败，且不发送 DATA', async () => {
    const server = await stub({ rejectRecipient: 'ghost@test' })
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'none' })
    const result = await client.send({
      from: 'manager@test',
      to: ['ghost@test'],
      subject: 'x',
      text: 'y'
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /所有收件人/)
    assert.equal(server.sessions[0]?.commands.includes('DATA'), false)
  })

  it('连接被拒（端口没人监听）时给出真实的错误，而不是静默', async () => {
    // 先起一个服务器拿一个空闲端口，再把它关掉。
    const temporary = await startStubSmtp()
    const port = temporary.port
    await temporary.close()

    const client = new SmtpClient({ host: '127.0.0.1', port, security: 'none', timeoutMs: 3_000 })
    const result = await client.send({ from: 'a@test', to: ['b@test'], subject: 'x', text: 'y' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.length > 0, '必须有原因')
      assert.match(result.error, /ECONNREFUSED|connect|拒绝|refused/i)
    }
  })

  it('服务器没有宣告 STARTTLS 时，失败原因指向 STARTTLS 而不是「发送失败」', async () => {
    const server = await stub()
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'starttls' })
    const result = await client.send({ from: 'a@test', to: ['b@test'], subject: 'x', text: 'y' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /STARTTLS/)
    assert.equal(server.sessions[0]?.commands.includes('DATA'), false)
  })

  it('没有收件人时不连服务器', async () => {
    const server = await stub()
    const client = new SmtpClient({ host: '127.0.0.1', port: server.port, security: 'none' })
    const result = await client.send({ from: 'a@test', to: [], subject: 'x', text: 'y' })
    assert.equal(result.ok, false)
    assert.equal(server.sessions.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 报文构造（纯函数）
// ---------------------------------------------------------------------------

describe('MIME 报文构造', () => {
  it('非 ASCII 主题走 RFC 2047，纯 ASCII 主题原样保留', () => {
    assert.equal(encodeHeaderValue('plain ascii subject'), 'plain ascii subject')
    const encoded = encodeHeaderValue('告警：主变压器')
    assert.match(encoded, /^=\?UTF-8\?B\?/)
    const base64 = encoded.slice('=?UTF-8?B?'.length, -2)
    assert.equal(Buffer.from(base64, 'base64').toString('utf8'), '告警：主变压器')
  })

  it('正文里以点开头的行被点填充，避免提前结束 DATA', () => {
    const stuffed = dotStuff('line1\r\n.\r\n..already')
    assert.equal(stuffed, 'line1\r\n..\r\n...already')
  })

  it('附件文件名里的引号与换行被替换（否则会拆掉报头）', () => {
    assert.equal(sanitiseFileName('a"b\nc.jpg'), 'a_b_c.jpg')
    assert.equal(sanitiseFileName('   '), 'attachment.bin')
  })

  it('base64 按 76 字符折行', () => {
    const lines = chunkBase64(Buffer.alloc(200, 1)).split('\r\n')
    assert.ok(lines.length > 1)
    for (const line of lines) assert.ok(line.length <= 76, `行过长：${line.length}`)
  })

  it('带附件的报文有结束边界，且正文与附件都在', () => {
    const message = buildMessage(
      {
        from: 'a@test',
        to: ['b@test'],
        subject: '中文主题',
        text: 'body',
        attachment: {
          fileName: 'f.jpg',
          contentType: 'image/jpeg',
          bytes: Uint8Array.from([1, 2, 3])
        }
      },
      'stub'
    )
    assert.match(message, /multipart\/mixed/)
    assert.match(message, /--hertzinno-[^\r\n]+--/)
    assert.ok(message.endsWith('.\r\n'), 'DATA 必须以 <CRLF>.<CRLF> 结束')
    assert.match(message, /Subject: =\?UTF-8\?B\?/)
  })
})

// ---------------------------------------------------------------------------
// 录像动作
// ---------------------------------------------------------------------------

describe('录像动作', () => {
  it('联动录像的 ffmpeg 参数：定长、不重编码、分片 MP4，且不带 RTSP timeout', () => {
    const args = buildAlarmRecordArgs('rtsp://192.168.110.235:443/live', 'C:/tmp/x.mp4', 30)
    assert.deepEqual(args.slice(0, 3), ['-rtsp_transport', 'tcp', '-i'])
    assert.equal(args[3], 'rtsp://192.168.110.235:443/live')
    const t = args.indexOf('-t')
    assert.equal(args[t + 1], '30')
    const copy = args.indexOf('-c:v')
    assert.equal(args[copy + 1], 'copy')
    assert.ok(args.includes('frag_keyframe+empty_moov+default_base_moof'))
    // 实测约束：本机这台相机上 `-timeout` 会被 ffmpeg 当成 RTSP listen 模式。
    assert.equal(args.includes('-timeout'), false)
    assert.equal(args.includes('-rw_timeout'), false)
  })

  it('时长为 0 或负数时被夹到至少 1 秒（否则 ffmpeg 会立刻退出，留下 0 字节文件）', () => {
    const args = buildAlarmRecordArgs('rtsp://x/live', 'x.mp4', 0)
    assert.equal(args[args.indexOf('-t') + 1], '1')
  })

  it('引擎把配置的时长交给录制器，并保留它登记的录像 id', async () => {
    const fixture = await makeEngine()
    fixture.config.recording.durationSeconds = 12
    const outcomes = await fixture.engine.observe(candidate(41, 4100))
    const record = outcomes.find((outcome) => outcome.action === 'record')
    assert.equal(record?.status, 'success')
    assert.equal(record?.detail?.requestedSeconds, 12)
    assert.equal(record?.detail?.recordingId, 'rec-1')
    assert.equal(fixture.pending.find('dev-1:41:4100')?.recordingId, 'rec-1')
  })

  it('录像进行中时跳过录像，但不影响其它动作', async () => {
    const fixture = await makeEngine()
    const busyRecorder: LinkageRecorder = {
      isBusy: () => true,
      record: async () => ({
        action: 'record',
        status: 'skipped',
        reason: '已有一路联动录像在进行',
        counted: true
      }),
      dispose: () => undefined
    }
    const engine = new AlarmLinkageEngine({
      config: () => fixture.config,
      recorder: busyRecorder,
      popup: fixture.popup,
      email: fixture.email as never,
      pending: fixture.pending,
      now: fixture.clock.now,
      log: () => undefined
    })
    const outcomes = await engine.observe(candidate(42, 4200))
    assert.equal(outcomes.find((outcome) => outcome.action === 'record')?.status, 'skipped')
    assert.equal(outcomes.find((outcome) => outcome.action === 'email')?.status, 'success')
  })
})

// ---------------------------------------------------------------------------
// 邮件动作（模板与附件路径）
// ---------------------------------------------------------------------------

describe('邮件动作', () => {
  it('模板占位符被展开；未知占位符原样保留（不静默吞掉）', () => {
    assert.equal(
      expandTemplate('{device} 在 {time} 告警 {unknown}', { device: 'Camera', time: 'T' }),
      'Camera 在 T 告警 {unknown}'
    )
  })

  it('配置不完整（没有主机）时邮件动作被跳过，而不是报一个假失败', async () => {
    const sender = new SmtpLinkageEmailSender({ readFile: async () => new Uint8Array() })
    const trigger: LinkageTrigger = {
      identity: linkAgeEventIdentity('dev-1', 1, 1),
      observedAt: 1,
      ruleId: 'dev-1',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      source: 'poll',
      decision: 'field-absent'
    }
    const outcome = await sender.send(trigger, null)
    assert.equal(outcome.status, 'skipped')
  })

  it('抓帧存在时作为附件读出，收件人与模板都按配置展开', async () => {
    const server = await startStubSmtp()
    try {
      const messages: LinkageEmailMessage[] = []
      const context: LinkageEmailContext = {
        config: {
          host: '127.0.0.1',
          port: server.port,
          security: 'none',
          username: '',
          password: '',
          from: 'manager@test',
          recipients: 'ops@test',
          subjectTemplate: 'alarm {device}',
          bodyTemplate: 'id={identity}',
          attachFrame: true
        },
        frameRelativePath: 'snapshot/frame.jpg'
      }
      const sender = new SmtpLinkageEmailSender({
        readFile: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
        transportFactory: (transport) => ({
          send: async (message) => {
            messages.push(message)
            const client = new SmtpClient({
              host: transport.host,
              port: transport.port,
              security: transport.security
            })
            return client.send(message)
          }
        })
      })

      const trigger: LinkageTrigger = {
        identity: linkAgeEventIdentity('dev-1', 5, 55),
        observedAt: 1_700_000_000_000,
        ruleId: 'dev-1',
        deviceId: 'dev-1',
        deviceName: 'Camera 1',
        source: 'poll',
        decision: 'field-absent'
      }
      const outcome = await sender.send(trigger, context)
      assert.equal(outcome.status, 'success', JSON.stringify(outcome))
      assert.equal(messages.length, 1)
      assert.equal(messages[0]?.to[0], 'ops@test')
      assert.equal(messages[0]?.subject, 'alarm Camera 1')
      assert.equal(messages[0]?.text, 'id=dev-1:5:55')
      assert.equal(messages[0]?.attachment?.fileName, 'frame.jpg')
      const body = lastMessage(server)
      assert.ok(body.includes('Content-Disposition: attachment; filename="frame.jpg"'))
    } finally {
      await server.close()
    }
  })

  it('附件读取失败时邮件照发，并在结果里说明「本封不带附件」', async () => {
    const server = await startStubSmtp()
    try {
      const sender = new SmtpLinkageEmailSender({
        readFile: async () => {
          throw new Error('文件不见了')
        },
        transportFactory: (transport) => ({
          send: async (message) => {
            const client = new SmtpClient({
              host: transport.host,
              port: transport.port,
              security: transport.security
            })
            return client.send(message)
          }
        })
      })
      const outcome = await sender.send(
        {
          identity: linkAgeEventIdentity('dev-1', 5, 55),
          observedAt: 1,
          ruleId: 'dev-1',
          deviceId: 'dev-1',
          deviceName: 'Camera 1',
          source: 'poll',
          decision: 'field-absent'
        },
        {
          config: {
            host: '127.0.0.1',
            port: server.port,
            security: 'none',
            username: '',
            password: '',
            from: 'manager@test',
            recipients: 'ops@test',
            subjectTemplate: 's',
            bodyTemplate: 'b',
            attachFrame: true
          },
          frameRelativePath: 'snapshot/frame.jpg'
        }
      )
      assert.equal(outcome.status, 'success')
      assert.match(String(outcome.detail?.attachment), /附件读取失败/)
      assert.equal(server.sessions.length, 1, '邮件仍然发了出去')
    } finally {
      await server.close()
    }
  })

  it('SMTP 失败时把原始回复与 transcript 一起带出去（绝不静默丢弃）', async () => {
    const server = await startStubSmtp({ rejectAuth: true })
    try {
      const sender = new SmtpLinkageEmailSender({
        readFile: async () => new Uint8Array(),
        transportFactory: (transport) => ({
          send: async (message) => {
            const client = new SmtpClient({
              host: transport.host,
              port: transport.port,
              security: transport.security,
              username: 'manager',
              password: 'wrong'
            })
            return client.send(message)
          }
        })
      })
      const outcome = await sender.send(
        {
          identity: linkAgeEventIdentity('dev-1', 6, 66),
          observedAt: 1,
          ruleId: 'dev-1',
          deviceId: 'dev-1',
          deviceName: 'Camera',
          source: 'poll',
          decision: 'field-absent'
        },
        {
          config: {
            host: '127.0.0.1',
            port: server.port,
            security: 'none',
            username: 'manager',
            password: 'wrong',
            from: 'manager@test',
            recipients: 'ops@test',
            subjectTemplate: 's',
            bodyTemplate: 'b',
            attachFrame: false
          }
        }
      )
      assert.equal(outcome.status, 'failed')
      assert.match(String(outcome.reason), /认证失败|口令被拒绝/)
      assert.ok(Array.isArray(outcome.detail?.transcript))
      assert.ok((outcome.detail?.transcript as string[]).length > 0)
    } finally {
      await server.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 配置归一化
// ---------------------------------------------------------------------------

describe('配置归一化', () => {
  it('非法输入回落到默认值，并把被修正的字段名交回来', () => {
    const { config, issues } = normaliseAlarmLinkageConfig({
      enabled: 'yes',
      pollIntervalSeconds: -5,
      recording: { durationSeconds: 10_000 },
      popup: { maxStack: 0 },
      runtime: { cooldown: { perInterface: 9999 } }
    })
    assert.equal(config.enabled, DEFAULT_ALARM_LINKAGE_CONFIG.enabled)
    // `-5` 落在合法区间 [2, 3600] 的下方 -> 被夹到下限 2，而不是回落到默认值。
    assert.equal(config.pollIntervalSeconds, 2, '低于下限被夹到 2')
    assert.ok(
      DEFAULT_ALARM_LINKAGE_CONFIG.pollIntervalSeconds >= 2,
      '默认轮询间隔本身必须在合法区间内'
    )
    assert.equal(config.recording.durationSeconds, 600, '超上限被夹到 600（合法区间 1~600）')
    assert.equal(config.popup.maxStack, 1, '低于下限被夹到 1')
    assert.equal(config.runtime.cooldown.perInterface, 100)
    assert.ok(issues.includes('enabled'))
    assert.ok(issues.includes('pollIntervalSeconds'))
    assert.ok(issues.includes('recording.durationSeconds'))
    assert.ok(issues.includes('popup.maxStack'))
    assert.ok(issues.includes('runtime.cooldown.perInterface'))
  })

  it('缺字段时补默认值，绝不返回半个对象', () => {
    const { config, issues } = normaliseAlarmLinkageConfig({})
    assert.deepEqual(issues, [])
    assert.deepEqual(config, cloneDefaults())
  })

  it('口令被摘出来，永远不进配置对象（因此不会进设置表）', () => {
    const { config, smtpPassword } = normaliseAlarmLinkageConfig({
      email: { host: 'smtp.test', smtpPassword: 'top-secret' }
    })
    assert.equal(smtpPassword, 'top-secret')
    assert.equal(config.email.host, 'smtp.test')
    assert.equal(
      JSON.stringify(config).includes('top-secret'),
      false,
      '序列化后的设置里不得出现口令'
    )
    assert.equal('smtpPassword' in config.email, false)
  })

  it('smtpPasswordStored 永远归一化成 false（渲染层无法伪造它）', () => {
    const { config } = normaliseAlarmLinkageConfig({ email: { smtpPasswordStored: true } })
    assert.equal(config.email.smtpPasswordStored, false)
  })
})

// ---------------------------------------------------------------------------
// 待处理列表的落盘与恢复
// ---------------------------------------------------------------------------

describe('待处理告警列表', () => {
  it('落盘之后能被一个新的实例读回来（应用重启不丢提示）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-pending-test-'))
    const first = new PendingAlarmStore({ directory: dir, capacity: () => 50 })
    await first.load()
    first.upsert({
      eventId: 'dev-1:1:100',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      at: 100,
      observedAt: 200,
      source: 'poll'
    })
    first.acknowledge(['dev-1:1:100'], true)
    await new Promise((resolve) => setTimeout(resolve, 80))

    const second = new PendingAlarmStore({ directory: dir, capacity: () => 50 })
    await second.load()
    const snapshot = second.snapshot()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0]?.acknowledged, true)
    assert.equal(second.unacknowledgedCount(), 0)
  })

  it('同一个事件身份重复写入是更新而不是插入（界面上只有一行）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-pending-test-'))
    const store = new PendingAlarmStore({ directory: dir, capacity: () => 50 })
    await store.load()
    store.upsert({
      eventId: 'dev-1:1:100',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      at: 100,
      observedAt: 200,
      source: 'poll'
    })
    store.upsert({
      eventId: 'dev-1:1:100',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      at: 100,
      observedAt: 300,
      source: 'websocket',
      alarmLevelRaw: 3
    })
    const snapshot = store.snapshot()
    assert.equal(snapshot.items.length, 1)
    assert.equal(snapshot.items[0]?.alarmLevelRaw, 3, '后到的源补上缺失的字段')
    assert.equal(snapshot.items[0]?.source, 'poll', '但不覆盖先到的结论')
  })

  it('确认全部：`ids` 为空表示全部确认', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-pending-test-'))
    const store = new PendingAlarmStore({ directory: dir, capacity: () => 50 })
    await store.load()
    for (let index = 0; index < 3; index += 1) {
      store.upsert({
        eventId: `dev-1:${index}:${index}`,
        deviceId: 'dev-1',
        deviceName: 'Camera',
        at: index,
        observedAt: index,
        source: 'poll'
      })
    }
    assert.equal(store.acknowledge([], true), 3)
    assert.equal(store.unacknowledgedCount(), 0)
  })

  it('变更会通知监听者，退订之后不再收到', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-pending-test-'))
    const store = new PendingAlarmStore({ directory: dir, capacity: () => 50 })
    await store.load()
    const seen: number[] = []
    const off = store.onChange((snapshot) => seen.push(snapshot.items.length))
    store.upsert({
      eventId: 'dev-1:1:1',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      at: 1,
      observedAt: 1,
      source: 'poll'
    })
    off()
    store.upsert({
      eventId: 'dev-1:2:2',
      deviceId: 'dev-1',
      deviceName: 'Camera',
      at: 2,
      observedAt: 2,
      source: 'poll'
    })
    assert.deepEqual(seen, [1], '退订之后不应再收到通知')
  })
})

// ---------------------------------------------------------------------------
// 纯工具
// ---------------------------------------------------------------------------

describe('联动工具函数', () => {
  it('收件人列表支持逗号、分号与换行', () => {
    assert.deepEqual(parseRecipientList('a@x, b@x;c@x\nd@x'), ['a@x', 'b@x', 'c@x', 'd@x'])
    assert.deepEqual(parseRecipientList('  ,, '), [])
  })

  it('冷却时间片的下标是 (now / window) % slots', () => {
    assert.equal(linkageCooldownSlot(0, 60_000, 6), 0)
    // 每片 10 秒（60000 / 6）：0~9999 ms 都还在第 0 片。
    assert.equal(linkageCooldownSlot(9_999, 60_000, 6), 0)
    assert.equal(linkageCooldownSlot(10_000, 60_000, 6), 0)
    assert.equal(linkageCooldownSlot(60_000, 60_000, 6), 1)
    // 第 60~70 秒是第 1 片（6 片一轮）。
    assert.equal(linkageCooldownSlot(66_000, 60_000, 6), 1)
    // 第 120~130 秒回到第 0 片。
    assert.equal(linkageCooldownSlot(6 * 60_000, 60_000, 6), 0)
    assert.equal(linkageCooldownSlot(6 * 60_000 + 66_000, 60_000, 6), 1)
    // 片数不同则片长不同：3 片 -> 每片 20 秒。
    assert.equal(linkageCooldownSlot(19_999, 60_000, 3), 0)
    assert.equal(linkageCooldownSlot(20_000, 60_000, 3), 0)
    assert.equal(linkageCooldownSlot(66_000, 60_000, 3), 1)
  })

  it('四个动作的种类与目录键一一对应', () => {
    assert.deepEqual([...LINKAGE_ACTION_KINDS], ['record', 'popup', 'notice', 'email'])
  })
})

// ---------------------------------------------------------------------------
// 触发源注册（引擎的接线）
// ---------------------------------------------------------------------------

describe('引擎的触发源接线', () => {
  class CountSource implements LinkageTriggerSource {
    readonly kind = 'poll' as const
    started = 0
    stopped = 0
    private listeners = new Set<(candidate: LinkageCandidate) => void>()
    get deviceIds(): readonly string[] {
      return []
    }
    start(): void {
      this.started += 1
    }
    stop(): void {
      this.stopped += 1
    }
    status(): { triggers: number; frames: number; running: boolean } {
      return { triggers: 0, frames: 0, running: this.started > this.stopped }
    }
    onCandidate(listener: (candidate: LinkageCandidate) => void): () => void {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }
    emit(candidate: LinkageCandidate): void {
      for (const listener of this.listeners) listener(candidate)
    }
  }

  it('引擎关闭时不启动触发源；打开之后才启动（不会自己连出去）', async () => {
    const fixture = await makeEngine({ config: { enabled: false } })
    const source = new CountSource()
    fixture.engine.registerSource(source)
    assert.equal(source.started, 0)

    fixture.config.enabled = true
    fixture.engine.applyConfig()
    assert.equal(source.started, 1)

    fixture.config.enabled = false
    fixture.engine.applyConfig()
    assert.equal(source.stopped, 1)
  })

  it('源报上来的候选会被引擎处理（引擎不认识 HTTP 也不认识 WebSocket）', async () => {
    const fixture = await makeEngine()
    const source = new CountSource()
    fixture.engine.registerSource(source)
    source.emit(candidate(91, 9100))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fixture.recorder.requests.length, 1)
  })

  it('dispose 会停源、关窗、收尾录像', async () => {
    const fixture = await makeEngine()
    const source = new CountSource()
    fixture.engine.registerSource(source)
    fixture.engine.dispose()
    assert.equal(source.stopped, 1)
    assert.equal(fixture.popup.closed, true)
    assert.equal(fixture.recorder.disposed, true)
  })
})
