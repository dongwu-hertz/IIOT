/**
 * 告警 → 本地联动引擎（产品要求：「告警和本地联动，录像，弹窗，提示以及邮件触发」）。
 *
 * ---------------------------------------------------------------------------
 * 触发源：**可插拔**，且今天就能工作的那一条是主源
 * ---------------------------------------------------------------------------
 * `/detectFeedback` 是一条**事件** WebSocket，而它的帧在真机上从未被观察到
 * （2026-09-15 实测：9 秒窗口 0 帧；`shared/domain/fa371-stream.ts` 的
 * `FA371_STREAM_MEASURED` 记的是 6 秒 0 帧）。因此它**不能是唯一触发源**：
 *
 *   1. `poll`      —— 轮询 `GET /detect_logs` + 游标去重。**主源**，今天可用。
 *   2. `websocket` —— `/detectFeedback` 帧。**加速器**：帧到达之前它什么都不做，
 *                     而且从设计上**不可能**压制或重复一个轮询触发的事件
 *                     （两条路径产出同一个事件身份，去重表在引擎这一层）。
 *
 * 两个源都通过 `LinkageTriggerSource` 接口接进来，引擎不认识 HTTP 也不认识
 * WebSocket；换第三个源（比如将来某个 MQTT 网关）只需要再实现这个接口。
 *
 * ---------------------------------------------------------------------------
 * 事件身份：`deviceId:logId:startTime`（理由写在 `LinkageEventIdentity` 的注释里）
 * ---------------------------------------------------------------------------
 * 去重表是一个按插入顺序淘汰的 `Map`：同一个身份第二次到达时**直接返回**，
 * 一个动作都不会再跑。这就是「轮询与 WebSocket 同时报同一事件只动作一次」的
 * 实现点，也是唯一一处。
 *
 * ---------------------------------------------------------------------------
 * 必须成立的四条「栏杆」，以及各自落在哪一行
 * ---------------------------------------------------------------------------
 *   - **冷却 / 频率上限**：`evaluateAction` 里的三张表（按规则的时间窗、
 *     离散接口格、全局窗口）。命中就 `skipped`，并且**同样计数**——
 *     一封发不出去的邮件每 10 秒重试一次，日志就是噪音。
 *   - **每个动作独立开关 + 总开关**（2026-09-23 起总开关默认开，邮件动作仍默认关）：
 *     `evaluateAction` 的第一段。
 *   - **幂等**：`seen` 去重表 + `PendingAlarmStore.upsert` 的幂等写入。
 *   - **失败隔离**：每个动作单独 `await` 并各自 `try/catch`；一个失败的邮件
 *     不会让录像回滚，一个失败的录像也不会让告警消失（告警先落待处理列表）。
 *   - **可审计**：每一次触发与每一个动作结果都过 `log` 回调，带上规则 id、
 *     事件身份、结论与原始诊断。
 */

import {
  LINKAGE_ACTION_KINDS,
  LINKAGE_COOLDOWN_PERIOD_MS,
  LINKAGE_COOLDOWN_SLOTS,
  LINKAGE_RATE_WINDOW_MS,
  linkageCooldownSlot,
  parseRecipientList,
  type AlarmLinkageConfig,
  type LinkageActionKind,
  type LinkageActionOutcome,
  type LinkageActionRecord,
  type LinkageAlarmDecision,
  type LinkageEngineStatus,
  type LinkageEventIdentity,
  type LinkageTrigger,
  type LinkageTriggerSourceKind,
  type PendingAlarmSnapshot
} from '@shared/domain/alarm-linkage'
import { appLog } from '../logging/logger'
import type { PendingAlarmStore } from './pending-alarm-store'
import type { DeviceKind } from '@shared/domain/models'
import type {
  LinkageEmailContext,
  LinkageEmailSender,
  LinkagePopupSink,
  LinkageRecorder
} from './linkage-actions'

// ---------------------------------------------------------------------------
// 触发源接口
// ---------------------------------------------------------------------------

/**
 * 一个可插拔的触发源。
 *
 * 源**只负责产生候选事件**，判定「算不算告警」由引擎的 `judge` 统一完成——
 * 否则两个源会各自长出一份判定规则，然后慢慢漂移。
 */
export interface LinkageTriggerSource {
  readonly kind: LinkageTriggerSourceKind
  /** 正在观察的设备 id。 */
  readonly deviceIds: readonly string[]
  /** 开始观察。幂等：重复调用不产生第二个定时器。 */
  start(): void
  /** 停止观察并释放定时器/socket。 */
  stop(): void
  /** 当前健康度（设置页诊断面板）。 */
  status(): { lastPollAt?: number; lastError?: string; triggers: number; frames: number; running: boolean }
  /**
   * 注册「有新的事件」回调。
   *
   * 回调是**每个候选一条**（不是一批）：轮询一次可能拿到 5 条日志，
   * 它们各自是独立的事件，各自要去重、各自要冷却。
   */
  onCandidate(listener: (candidate: LinkageCandidate) => void): () => void
}

/** 一条候选事件：源的产出，尚未判定是否算告警。 */
export interface LinkageCandidate {
  source: LinkageTriggerSourceKind
  deviceId: string
  deviceName: string
  identity: LinkageEventIdentity
  /** 事件发生时刻（有原始开始时刻就用它，否则用观察时刻）。 */
  at: number
  observedAt: number
  alarmLevelRaw?: number
  strategyId?: number
  /** 设备侧通道号（AO01 的气井告警需要它落 alarms 行；相机日志通常为 0）。 */
  channelIndex?: number
  /** 设备族；非相机没有 RTSP 视频源，联动录像动作要整条省略而不是显示失败。 */
  deviceKind?: DeviceKind
  /** 相机判定的检测模式（1 局放 / 2 泄漏 / 3 机械）与放电类型键（2026-09-23 真机字段）。 */
  detectMode?: number
  dischargeTypeKey?: string
  metrics?: { soundmapIntensity?: number; leakVolume?: number; leakCost?: number; alarmDb?: number; alarmDf?: number }
  /** 源自己知道的判定依据（`is_alarm` 存在与否）。 */
  alarmFlag?: boolean
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

export interface AlarmLinkageEngineOptions {
  /** 当前配置；每次用都重新读，所以设置页保存后立即生效。 */
  config: () => AlarmLinkageConfig
  recorder: LinkageRecorder
  popup: LinkagePopupSink
  email: LinkageEmailSender
  pending: PendingAlarmStore
  /** 抓帧；返回 `undefined` 表示这次不带附件（邮件照发）。 */
  captureFrame?: (trigger: LinkageTrigger) => Promise<LinkageEmailContext['frameRelativePath'] | undefined>
  /**
   * SMTP 口令的**唯一**来源：由组合根从 DPAPI/safeStorage 凭据库解出。
   *
   * 引擎的配置对象（来自设置表）里没有口令字段，因此口令不可能被日志、
   * 被 IPC 或被设置 JSON 带出去——这是刻意的单向依赖。
   */
  passwordFor?: (username: string) => string | undefined
  /** 全局时钟；注入以便测试精确控制冷却。 */
  now?: () => number
  /**
   * 弹窗文案的解析器。
   *
   * 引擎**不**持有任何语言的文案：它只产出目录键与参数，由组合根按当前界面
   * 语言渲染（语言是渲染层的状态，主进程不该猜）。没有解析器时退化为
   * 一段包含设备名与时刻的中性文本——弹窗本身仍然会出现，只是不翻译。
   */
  text?: (key: string, params: Record<string, string>) => string
  /** 审计日志出口；默认写应用日志，测试可以直接收集。 */
  log?: (message: string, payload: Record<string, unknown>) => void
  /**
   * 「操作员正在看告警中心」时，弹窗这个动作**直接跳过**（业主 2026-09-26 第 5 条）。
   *
   * 为什么判据放在**闸门**（`evaluateAction`）而不是放在弹窗实现里：
   * 冷却与速率预算是在闸门通过之后、执行之前扣的（见 `runAction` 里那句
   * "计数在**执行之前**"）。如果只在 `ElectronPopupSink.show()` 里返回 skipped，
   * 这一次**会白扣一次弹窗预算** —— 操作员离开告警中心之后的第一条告警就弹不出来，
   * 而屏幕上没有任何东西解释为什么。放在闸门里，被跳过的那一次不扣任何预算，
   * 与"冷却中"「未启用」这些跳过是完全同一种语义。
   *
   * 缺省（没有注入）恒为 `false`：这条通道没接上时必须**继续弹** ——
   * 漏掉一条告警比多弹一个窗口危险得多。
   */
  popupSuppressed?: () => boolean
  /** 去重表容量。默认 512。 */
  dedupeCapacity?: number
  /** 一次触发里动作的执行顺序（固定顺序让审计与测试都可预测）。 */
  actionOrder?: readonly LinkageActionKind[]
}

/** 一条动作的历史（冷却与限流用）。 */
interface ActionHistory {
  /** 每个动作最后一次真正执行（或计数）的时刻。 */
  last: Partial<Record<LinkageActionKind, number>>
  /**
   * 「窗口内上限」的计数器。
   *
   * **是桶计数，不是时间戳列表。** 这一条曾经实现成「保存最近 N 次的时间戳、
   * 每次数一下还在窗口里的有几个」，结果是：只在一分钟内均匀来 5 条时，
   * 每次检查都只看到 1 条（前一次正好卡在边界外），上限形同虚设——
   * 一个健康检查式的 1 次/分钟流量永远不会被拦住。
   * 现在改成「`floor(now / window)` 这一个窗口里有几次」，语义与名字一致：
   * **每个窗口最多 N 次**。
   */
  windowCounts: Partial<Record<LinkageActionKind, number>>
  /** 上面那个计数属于哪个窗口；换窗口时归零。 */
  windowIndex: Partial<Record<LinkageActionKind, number>>
  /** 每个动作在最近若干离散格里已用的次数（`slots` 个计数器）。 */
  slots: Partial<Record<LinkageActionKind, number[]>>
  /** 上一次命中的离散格号；换格时把那一格的计数清掉。 */
  slotIndex: Partial<Record<LinkageActionKind, number>>
}

/** 全局动作计数（速率上限用）。 */
interface GlobalHistory {
  /** 本窗口内已经发生的动作数。 */
  windowStart: number
  count: number
}

const DEFAULT_DEDUPE_CAPACITY = 512
const DEFAULT_ACTION_ORDER: readonly LinkageActionKind[] = ['record', 'popup', 'notice', 'email']

export class AlarmLinkageEngine {
  private readonly options: AlarmLinkageEngineOptions
  private readonly now: () => number
  private readonly log: (message: string, payload: Record<string, unknown>) => void
  private readonly actionOrder: readonly LinkageActionKind[]

  /**
   * 去重表。
   *
   * 用 `Map` 而不是 `Set`：`Map` 的迭代顺序是插入顺序，所以「超过容量时淘汰
   * 最旧的一条」是一行代码，而 `Set` 做不到（`Set` 同样保序，但这里还需要
   * 记录首次观察时刻以便诊断，`Map` 一举两得）。
   */
  private readonly seen = new Map<string, number>()

  /** 按规则（= 设备）分桶的动作历史。 */
  private readonly history = new Map<string, ActionHistory>()
  private readonly global: GlobalHistory = { windowStart: 0, count: 0 }

  private readonly sources = new Map<LinkageTriggerSourceKind, LinkageTriggerSource>()
  private readonly listeners = new Map<LinkageTriggerSourceKind, () => void>()

  private totalTriggers = 0
  private totalActions = 0

  constructor(options: AlarmLinkageEngineOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.actionOrder = options.actionOrder ?? DEFAULT_ACTION_ORDER
    this.log =
      options.log ??
      ((message, payload) => {
        appLog().info(message, payload)
      })
  }

  // -------------------------------------------------------------------------
  // 触发源注册
  // -------------------------------------------------------------------------

  /** 注册一个触发源；只有引擎开着的时候才真的 `start()`。 */
  registerSource(source: LinkageTriggerSource): void {
    if (this.sources.has(source.kind)) return
    this.sources.set(source.kind, source)
    this.listeners.set(
      source.kind,
      source.onCandidate((candidate) => {
        void this.observe(candidate)
      })
    )
    if (this.options.config().enabled) source.start()
  }

  /** 取消注册（应用退出）。 */
  unregisterSource(kind: LinkageTriggerSourceKind): void {
    this.sources.get(kind)?.stop()
    this.listeners.get(kind)?.()
    this.listeners.delete(kind)
    this.sources.delete(kind)
  }

  /**
   * 应用一次配置变化：引擎的启停与触发源的启停都收敛到这里。
   *
   * 设置页保存后由主进程调用；`enabled` 从 false 变 true 会启动触发源，
   * 反过来会停掉它们（但**不**清空去重表——见 `restartSources` 的说明）。
   */
  applyConfig(): void {
    const enabled = this.options.config().enabled
    for (const source of this.sources.values()) {
      if (enabled) source.start()
      else source.stop()
    }
  }

  /**
   * 重建触发源集合（设备增删时调用）。
   *
   * 去重表**刻意被保留**：重启一次触发源不应该让同一条告警再被处理一遍。
   * 见 `tests/alarm-linkage.test.ts` 的「重启不重放」用例。
   */
  restartSources(): void {
    for (const source of this.sources.values()) {
      source.stop()
      source.start()
    }
  }

  // -------------------------------------------------------------------------
  // 核心：观察一条候选事件
  // -------------------------------------------------------------------------

  /**
   * 处理一条候选事件。
   *
   * 返回本次真正执行的动作结果（空数组 = 被去重或被判定为非告警）。
   * 公开是为了让测试与未来的第三个源可以直接驱动它，而不必伪造一条 socket。
   */
  async observe(candidate: LinkageCandidate): Promise<LinkageActionOutcome[]> {
    const config = this.options.config()
    if (!config.enabled) return []

    const { identity } = candidate
    const decision = judge(config, candidate)

    if (decision === 'not-alarm' || decision === 'below-min-level') {
      this.log('告警联动：事件未通过告警判定，不联动', {
        rule: linkageRuleOf(candidate),
        eventId: identity.eventId,
        source: candidate.source,
        decision,
        alarmLevelRaw: candidate.alarmLevelRaw ?? null
      })
      // 仍然记入去重表：设备上已有一条日志被明确判为「不是告警」，
      // 反复轮询到它时不该每次都走一遍判定与日志。
      this.remember(identity.eventId)
      return []
    }

    if (this.seen.has(identity.eventId)) {
      this.log('告警联动：事件已处理过，跳过（跨源去重）', {
        rule: linkageRuleOf(candidate),
        eventId: identity.eventId,
        source: candidate.source,
        firstSeenAt: this.seen.get(identity.eventId) ?? 0
      })
      return []
    }
    this.remember(identity.eventId)
    this.totalTriggers += 1

    const trigger: LinkageTrigger = {
      identity,
      observedAt: candidate.observedAt,
      ruleId: linkageRuleOf(candidate),
      deviceId: candidate.deviceId,
      deviceName: candidate.deviceName,
      source: candidate.source,
      ...(candidate.deviceKind !== undefined ? { deviceKind: candidate.deviceKind } : {}),
      decision
    }
    if (candidate.alarmLevelRaw !== undefined) trigger.alarmLevelRaw = candidate.alarmLevelRaw
    if (candidate.strategyId !== undefined) trigger.strategyId = candidate.strategyId

    /**
     * 「提示」的记录**先落**，再跑其余动作。
     *
     * 顺序是刻意的：即使后面的录像、弹窗、邮件全部失败，这次告警也已经在待处理
     * 列表里——「失败不得丢失告警」这条栏杆就靠这一行成立。
     */
    this.options.pending.upsert({
      eventId: identity.eventId,
      deviceId: candidate.deviceId,
      deviceName: candidate.deviceName,
      at: candidate.at,
      observedAt: candidate.observedAt,
      source: candidate.source,
      ...(candidate.alarmLevelRaw !== undefined ? { alarmLevelRaw: candidate.alarmLevelRaw } : {}),
      ...(candidate.strategyId !== undefined ? { strategyId: candidate.strategyId } : {}),
      ...(candidate.detectMode !== undefined ? { detectMode: candidate.detectMode } : {}),
      ...(candidate.dischargeTypeKey !== undefined ? { dischargeTypeKey: candidate.dischargeTypeKey } : {}),
      ...(candidate.metrics !== undefined ? { metrics: candidate.metrics } : {})
    })

    this.log('告警联动：触发', {
      rule: linkageRuleOf(candidate),
      eventId: identity.eventId,
      identityKind: identity.identityKind,
      logId: identity.logId ?? null,
      startTime: identity.startTime ?? null,
      source: candidate.source,
      decision,
      deviceName: candidate.deviceName
    })

    const outcomes: LinkageActionOutcome[] = []
    for (const action of this.actionOrder) {
      // 非相机设备（AO01 等纯传感器）没有视频源：联动录像对它们不成立，
      // 整条动作省略，不要在待处理告警里显示 Recording: Failed — 无视频源。
      if (action === 'record' && trigger.deviceKind !== undefined && trigger.deviceKind !== 'acousticCamera') {
        continue
      }
      const outcome = await this.runAction(action, trigger, config)
      outcomes.push(outcome)
    }

    const execution: LinkageActionRecord[] = outcomes.map((outcome) => {
      const record: LinkageActionRecord = {
        action: outcome.action,
        at: this.now(),
        status: outcome.status
      }
      if (outcome.reason !== undefined) record.reason = outcome.reason
      if (outcome.detail !== undefined) record.detail = { ...outcome.detail }
      return record
    })
    for (const record of execution) this.options.pending.recordAction(identity.eventId, record)

    this.log('告警联动：本次动作结果', {
      rule: linkageRuleOf(candidate),
      eventId: identity.eventId,
      outcomes: outcomes.map((outcome) => ({
        action: outcome.action,
        status: outcome.status,
        reason: outcome.reason ?? null
      }))
    })

    return outcomes
  }

  // -------------------------------------------------------------------------
  // 单个动作
  // -------------------------------------------------------------------------

  private async runAction(
    action: LinkageActionKind,
    trigger: LinkageTrigger,
    config: AlarmLinkageConfig
  ): Promise<LinkageActionOutcome> {
    const rule = linkageRuleOf(trigger)
    const gate = this.evaluateAction(action, rule, config)

    if (gate !== 'allow') {
      const outcome: LinkageActionOutcome = {
        action,
        status: 'skipped',
        reason: gate,
        counted: false
      }
      this.log('告警联动：动作被跳过', {
        rule,
        eventId: trigger.identity.eventId,
        action,
        reason: gate
      })
      return outcome
    }

    // 计数在**执行之前**：一个抛异常的实现也必须被限流，否则它就是无限重试。
    this.countAction(action, rule, config)

    try {
      const outcome = await this.dispatch(action, trigger, config)
      this.log(
        outcome.status === 'success' ? '告警联动：动作成功' : '告警联动：动作未成功',
        {
          rule,
          eventId: trigger.identity.eventId,
          action,
          status: outcome.status,
          reason: outcome.reason ?? null,
          detail: outcome.detail ?? null
        }
      )
      return outcome
    } catch (error) {
      // 兜底：动作实现自己应该返回失败，但一个意外的异常**绝不能**中断其余动作。
      const reason = error instanceof Error ? error.message : String(error)
      this.log('告警联动：动作抛出异常（已隔离）', {
        rule,
        eventId: trigger.identity.eventId,
        action,
        reason
      })
      return { action, status: 'failed', reason, counted: true }
    }
  }

  private async dispatch(
    action: LinkageActionKind,
    trigger: LinkageTrigger,
    config: AlarmLinkageConfig
  ): Promise<LinkageActionOutcome> {
    switch (action) {
      case 'record':
        return this.options.recorder.record({ trigger, durationSeconds: config.recording.durationSeconds })
      case 'popup': {
        /**
         * 弹窗显示的是**当前界面语言**的文案。
         *
         * 引擎只给目录键与参数；`text` 解析器由组合根提供（它知道当前语言），
         * 没有解析器时退化为一段中性文本。这样「换语言后弹窗跟着换」不需要
         * 引擎认识任何一份目录。
         */
        const params = {
          device: trigger.deviceName,
          time: new Date(trigger.observedAt).toISOString(),
          level: trigger.alarmLevelRaw !== undefined ? String(trigger.alarmLevelRaw) : '',
          eventId: trigger.identity.eventId
        }
        const level = popupLevel(trigger)
        return this.options.popup.show({
          popupId: trigger.identity.eventId,
          messageKey: `linkage.popup.${level}`,
          params: {
            ...params,
            title: this.resolveText('linkage.popup.title', params),
            body: this.resolveText(`linkage.popup.${level}`, params)
          },
          level,
          autoDismissSeconds: config.popup.autoDismissSeconds
        })
      }
      case 'notice':
        /**
         * 「提示」= 待处理列表里的那条记录，它**已经在 `observe` 里写好了**。
         *
         * 因此这个动作成功与否不取决于「有没有新东西写进去」，而取决于那条记录
         * 还在不在：这正是「关掉弹窗、切走页面之后仍然看得见」的实现方式。
         * 记录不在了（被上限挤掉）就是失败——绝不报一个假的成功。
         */
        return this.options.pending.find(trigger.identity.eventId)
          ? {
              action: 'notice',
              status: 'success',
              detail: {
                eventId: trigger.identity.eventId,
                unacknowledged: this.options.pending.unacknowledgedCount()
              }
            }
          : { action: 'notice', status: 'failed', reason: '待处理记录未能写入（可能已被上限淘汰）', counted: false }
      case 'email': {
        const context = await this.emailContext(trigger, config)
        return this.options.email.send(trigger, context)
      }
    }
  }

  /** 组装一封邮件的上下文：配置 + （可选的）抓帧路径。 */
  private async emailContext(
    trigger: LinkageTrigger,
    config: AlarmLinkageConfig
  ): Promise<LinkageEmailContext | null> {
    const email = config.email
    if (email.host.trim() === '' || email.from.trim() === '') return null
    if (parseRecipientList(email.recipients).length === 0) return null

    const context: LinkageEmailContext = {
      config: {
        host: email.host,
        port: email.port,
        security: email.security,
        username: email.username,
        /**
         * 口令在组合根里注入（从 DPAPI 凭据库解出）。引擎的配置对象里
         * **没有**口令字段，所以它不可能被日志、被 IPC、被设置 JSON 带出去。
         */
        password: this.options.passwordFor?.(email.username) ?? '',
        from: email.from,
        recipients: email.recipients,
        subjectTemplate: email.subjectTemplate,
        bodyTemplate: email.bodyTemplate,
        attachFrame: email.attachFrame
      }
    }

    if (email.attachFrame && this.options.captureFrame) {
      try {
        const frame = await this.options.captureFrame(trigger)
        if (frame) context.frameRelativePath = frame
      } catch (error) {
        // 抓帧失败不影响发信，但要在结果里说明「本封不带附件」。
        context.detail = `抓帧失败：${error instanceof Error ? error.message : String(error)}`
      }
    }

    return context
  }

  // -------------------------------------------------------------------------
  // 栏杆：开关、冷却、频率上限
  // -------------------------------------------------------------------------

  /**
   * 判断一个动作这次能不能跑。
   *
   * 返回 `'allow'` 或一句「为什么跳过」的中文诊断（进日志与待处理记录）。
   * 顺序刻意是「开关 -> 全局上限 -> 规则冷却」：先回答「这个功能到底开没开」，
   * 再回答「现在是不是太频繁」，两者的诊断含义不同。
   */
  private evaluateAction(
    action: LinkageActionKind,
    rule: string,
    config: AlarmLinkageConfig
  ): 'allow' | string {
    if (!config.enabled) return '总开关关闭'
    if (!config.actions[action]) return `动作「${action}」未启用`

    /*
     * 「操作员正在看告警中心」：弹窗这一路让路（业主 2026-09-26 第 5 条）。
     *
     * 位置在**冷却与速率之前**是刻意的：被让路的那一次不该扣任何预算，
     * 否则离开告警中心后的第一条告警会莫名其妙弹不出来。理由详见
     * `AlarmLinkageEngineOptions.popupSuppressed`。
     *
     * 只挡弹窗：录像 / 提示 / 邮件照跑 —— 告警本身一条都不能丢。
     */
    if (action === 'popup' && this.options.popupSuppressed?.() === true) {
      return '操作员正在查看告警中心，不再弹出提示窗口'
    }

    if (!this.takeGlobalSlot(config)) {
      return `已达到全局速率上限（${config.runtime.maxActionsPerMinute} 次/分钟）`
    }

    const cooldownSeconds = cooldownSecondsFor(config, action)
    const history = this.historyFor(rule)
    const now = this.now()

    /**
     * 单动作冷却。
     *
     * 注意这里**不能**因为 `cooldownSeconds === 0` 就提前 `return 'allow'`：
     * 那是这张函数里曾经有过的一个真实缺陷——把单动作冷却设为 0 会连带把
     * 下面的「窗口上限」和「接口限流」一起跳过，于是「关掉冷却」等于
     * 「关掉所有限流」。三道闸门是独立的，必须逐个判断。
     */
    if (cooldownSeconds > 0) {
      const cooldownMs = cooldownSeconds * 1000
      const last = history.last[action]
      if (last !== undefined && now - last < cooldownMs) {
        const remaining = cooldownMs - (now - last)
        return `冷却中（同一规则 ${cooldownSeconds} 秒内已执行过，「${action}」还需 ${Math.ceil(remaining / 1000)} 秒）`
      }
    }

    const periodSeconds = config.runtime.cooldown.periodSeconds
    if (periodSeconds > 0) {
      const windowMs = periodSeconds * 1000
      const period = config.runtime.cooldown.perPeriod
      const windowIndex = Math.floor(now / windowMs)
      const used = history.windowIndex[action] === windowIndex ? history.windowCounts[action] ?? 0 : 0
      if (used >= period) {
        return `已达到窗口上限（每 ${periodSeconds} 秒「${action}」最多 ${period} 次）`
      }

      const slots = history.slots[action] ?? new Array<number>(LINKAGE_COOLDOWN_SLOTS).fill(0)
      const slotIndex = linkageCooldownSlot(now, windowMs, LINKAGE_COOLDOWN_SLOTS)
      if (history.slotIndex[action] !== slotIndex) {
        slots[slotIndex % slots.length] = 0
        history.slotIndex[action] = slotIndex
      }
      const usedInSlot = slots[slotIndex % slots.length] ?? 0
      if (usedInSlot >= config.runtime.cooldown.perInterface) {
        return `已达到接口限流（每 ${Math.round(periodSeconds / LINKAGE_COOLDOWN_SLOTS)} 秒「${action}」最多 ${
          config.runtime.cooldown.perInterface
        } 次）`
      }
    }

    return 'allow'
  }

  /** 全局窗口：一个窗口内允许的动作总数。 */
  private takeGlobalSlot(config: AlarmLinkageConfig): boolean {
    const now = this.now()
    if (now - this.global.windowStart >= LINKAGE_RATE_WINDOW_MS) {
      this.global.windowStart = now
      this.global.count = 0
    }
    return this.global.count < config.runtime.maxActionsPerMinute
  }

  /** 记一次动作（无论成功失败），三张表一起更新。 */
  private countAction(action: LinkageActionKind, rule: string, config: AlarmLinkageConfig): void {
    const now = this.now()
    const history = this.historyFor(rule)
    history.last[action] = now

    const periodSeconds = config.runtime.cooldown.periodSeconds
    if (periodSeconds > 0) {
      const windowMs = periodSeconds * 1000

      // 窗口计数器：换窗口时从 0 重新开始（语义 = 每个窗口最多 N 次）。
      const windowIndex = Math.floor(now / windowMs)
      if (history.windowIndex[action] !== windowIndex) {
        history.windowIndex[action] = windowIndex
        history.windowCounts[action] = 0
      }
      history.windowCounts[action] = (history.windowCounts[action] ?? 0) + 1

      // 接口格：仅当这一格换了才清零，否则同一个格里的计数会互相抹掉
      // （第一版就踩过：每次先清零再 +1，于是计数器永远是 1，限流从未生效）。
      const slots = history.slots[action] ?? new Array<number>(LINKAGE_COOLDOWN_SLOTS).fill(0)
      const slotIndex = linkageCooldownSlot(now, windowMs, LINKAGE_COOLDOWN_SLOTS)
      if (history.slotIndex[action] !== slotIndex) {
        slots[slotIndex % slots.length] = 0
        history.slotIndex[action] = slotIndex
      }
      slots[slotIndex % slots.length] = (slots[slotIndex % slots.length] ?? 0) + 1
      history.slots[action] = slots
    }

    this.totalActions += 1
    this.global.count += 1
  }

  /**
   * 解析一段弹窗文案。
   *
   * 有注入的解析器就用它（组合根按当前界面语言）；没有就退化为一段中性文本。
   * 退化时**不编造任何语言的句子**，只用设备名、时刻与目录键——一个中文句子
   * 出现在土耳其语界面上比一句英文更糟。
   */
  private resolveText(key: string, params: Record<string, string>): string {
    if (this.options.text) return this.options.text(key, params)
    const parts = [key, params.device, params.time].filter((part) => part !== undefined && part !== '')
    return parts.join(' · ')
  }

  private historyFor(rule: string): ActionHistory {
    const existing = this.history.get(rule)
    if (existing) return existing
    const created: ActionHistory = { last: {}, windowCounts: {}, windowIndex: {}, slots: {}, slotIndex: {} }
    this.history.set(rule, created)
    return created
  }

  // -------------------------------------------------------------------------
  // 去重表
  // -------------------------------------------------------------------------

  private remember(eventId: string): void {
    this.seen.set(eventId, this.now())
    const capacity = this.options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY
    while (this.seen.size > capacity) {
      const oldest = this.seen.keys().next()
      if (oldest.done) return
      this.seen.delete(oldest.value)
    }
  }

  /** 某个身份是否已经处理过（诊断与测试用）。 */
  hasSeen(eventId: string): boolean {
    return this.seen.has(eventId)
  }

  // -------------------------------------------------------------------------
  // 状态与待处理
  // -------------------------------------------------------------------------

  status(): LinkageEngineStatus {
    const config = this.options.config()
    const now = this.now()
    const actionsThisWindow = now - this.global.windowStart >= LINKAGE_RATE_WINDOW_MS ? 0 : this.global.count
    return {
      enabled: config.enabled,
      sources: [...this.sources.values()].map((source) => {
        const snapshot = source.status()
        const status: LinkageEngineStatus['sources'][number] = {
          kind: source.kind,
          deviceId: source.deviceIds.join(','),
          running: snapshot.running,
          triggers: snapshot.triggers,
          frames: snapshot.frames
        }
        if (snapshot.lastPollAt !== undefined) status.lastPollAt = snapshot.lastPollAt
        if (snapshot.lastError !== undefined) status.lastError = snapshot.lastError
        return status
      }),
      triggers: this.totalTriggers,
      actions: this.totalActions,
      actionsThisWindow,
      pending: this.options.pending.snapshot()
    }
  }

  pendingSnapshot(): PendingAlarmSnapshot {
    return this.options.pending.snapshot()
  }

  /** 应用退出：停源、关窗、收尾录像。 */
  dispose(): void {
    for (const kind of [...this.sources.keys()]) this.unregisterSource(kind)
    this.options.popup.closeAll()
    this.options.recorder.dispose()
  }
}

// ---------------------------------------------------------------------------
// 判定与冷却的纯函数
// ---------------------------------------------------------------------------

/** 规则 id：本功能里一条规则 = 一台设备。 */
export function linkageRuleOf(candidate: { deviceId: string }): string {
  return candidate.deviceId
}
/**
 * 「这条日志算不算告警」。
 *
 * 规则与理由写在 `LinkageAlarmDecision` 的注释里；这里是唯一的实现点，
 * 两个触发源共用，因此轮询与 WebSocket 不可能给出不同结论。
 */
export function judge(config: AlarmLinkageConfig, candidate: LinkageCandidate): LinkageAlarmDecision {
  if (candidate.alarmFlag === false) return 'not-alarm'
  if (
    config.minAlarmLevel > 0 &&
    candidate.alarmLevelRaw !== undefined &&
    candidate.alarmLevelRaw < config.minAlarmLevel
  ) {
    return 'below-min-level'
  }
  return candidate.alarmFlag === true ? 'is-alarm-flag' : 'field-absent'
}

/** 每个动作的冷却秒数来自配置的哪一格。 */
export function cooldownSecondsFor(config: AlarmLinkageConfig, action: LinkageActionKind): number {
  switch (action) {
    case 'record':
      return config.recording.cooldownSeconds
    case 'popup':
      return config.popup.cooldownSeconds
    case 'notice':
      return config.notices.cooldownSeconds
    case 'email':
      return config.email.cooldownSeconds
  }
}

/** 弹窗的严重级别；等级越高越「红」。 */
export function popupLevel(trigger: LinkageTrigger): 'info' | 'warning' | 'critical' {
  const level = trigger.alarmLevelRaw
  if (level === undefined) return 'warning'
  if (level >= 3) return 'critical'
  if (level >= 2) return 'warning'
  return 'info'
}

/** 冷却是「同一规则 + 同一动作」的，四类动作各自独立。 */
export const LINKAGE_ACTIONS: readonly LinkageActionKind[] = LINKAGE_ACTION_KINDS

/** 默认冷却周期常量在这里再导出一份，避免测试硬编码数字。 */
export const LINKAGE_COOLDOWN_DEFAULTS = {
  periodMs: LINKAGE_COOLDOWN_PERIOD_MS,
  slots: LINKAGE_COOLDOWN_SLOTS
} as const

/**
 * 单个动作的历史桶，供测试断言「冷却确实按规则分桶」。
 * 生产代码不读它。
 */
export interface LinkageActionHistoryView {
  rule: string
  last: Partial<Record<LinkageActionKind, number>>
}

/** 只读视图：测试用它确认「不同设备各算各的冷却」。 */
export function historyView(engine: AlarmLinkageEngine): LinkageActionHistoryView[] {
  const internal = engine as unknown as { history: Map<string, ActionHistory> }
  return [...internal.history.entries()].map(([rule, history]) => ({ rule, last: { ...history.last } }))
}
