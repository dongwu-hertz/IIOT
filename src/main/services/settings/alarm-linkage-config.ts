/**
 * 告警联动配置的**归一化**（`AppSettings.alarmLinkage` 的读写唯一入口）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不是一组扁平的 settings 字段
 * ---------------------------------------------------------------------------
 * `SettingsService` 的每个键都有自己的校验器，那套写法对「一个字符串、一个数字」
 * 很好用；而联动配置是嵌套的、有十几个子字段、且必须能被**部分覆盖**
 * （界面只改其中一格也要能存）。把二十多个字段摊平成 `alarmLinkageXxx` 会让
 * 设置表的键与这本功能的内部结构各写一遍，两边迟早漂移。
 *
 * 因此：设置表里只有**一个**键（`alarmLinkage`），它的值就是这个结构；
 * 而归一化的规则集中在本文件——把任意（可能来自旧版本、可能被人手改过的）
 * JSON 变成一个**每个子字段都合法**的完整对象。
 *
 * 归一化的三条硬规则：
 *   1. 任何非法值都回落到默认值，**不抛异常**（一个坏配置不能让应用起不来）；
 *   2. 数值一律被夹进各自的合法区间（时长不会变成 0 或 100 小时）；
 *   3. 非法值会被记进返回的 `issues` 里——调用方负责写日志，**绝不静默**。
 */

import {
  DEFAULT_ALARM_LINKAGE_CONFIG,
  LINKAGE_ACTION_KINDS,
  LINKAGE_PENDING_CAPACITY,
  LINKAGE_SMTP_SECURITIES,
  looksLikeEmailAddress,
  type AlarmLinkageConfig,
  type LinkageActionKind,
  type LinkageActionSwitches,
  type LinkageSmtpSecurity
} from '@shared/domain/alarm-linkage'

/** 归一化的结果：配置 + 被修正过的字段清单 + 本次提交里携带的新口令。 */
export interface NormalisedLinkageConfig {
  config: AlarmLinkageConfig
  /** 形如 `recording.durationSeconds` 的字段名，用于日志。 */
  issues: string[]
  /**
   * 本次提交里携带的 SMTP 口令。
   *
   * `undefined` = 本次没动口令；`''` = 明确删除。**它绝不进入 `config`**：
   * 调用方（`handlers.ts`）拿到之后立刻交给 DPAPI 凭据库。
   */
  smtpPassword?: string
}

/** 每个数值字段的合法区间（闭区间）。 */
const RANGES = {
  pollIntervalSeconds: [2, 3600],
  minAlarmLevel: [0, 4],
  'recording.durationSeconds': [1, 600],
  'recording.cooldownSeconds': [0, 3600],
  'popup.autoDismissSeconds': [0, 600],
  'popup.cooldownSeconds': [0, 3600],
  'popup.maxStack': [1, 10],
  'notices.pendingCapacity': [10, 1000],
  'notices.cooldownSeconds': [0, 3600],
  'email.port': [1, 65535],
  'email.cooldownSeconds': [0, 86400],
  'runtime.maxActionsPerMinute': [1, 600],
  'runtime.cooldown.periodSeconds': [0, 3600],
  'runtime.cooldown.perPeriod': [1, 1000],
  'runtime.cooldown.perInterface': [1, 100]
} as const

type RangeKey = keyof typeof RANGES

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 取一个布尔值。
 *
 * 只接受真正的 boolean：字符串 `'false'` 是 truthy，静默当成 `true` 会让
 * 「关掉总开关」这个最要紧的操作失效——所以非布尔一律回落默认值。
 */
function boolValue(
  source: Record<string, unknown>,
  key: string,
  fallback: boolean,
  path: string,
  issues: string[]
): boolean {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push(path)
    return fallback
  }
  return value
}

/** 取一个被夹进合法区间的整数。 */
function intValue(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  rangeKey: RangeKey,
  path: string,
  issues: string[]
): number {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(path)
    return fallback
  }
  const [min, max] = RANGES[rangeKey]
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) {
    issues.push(path)
    return Math.min(max, Math.max(min, rounded))
  }
  return rounded
}

/** 取一个字符串（去掉首尾空白）；非字符串回落默认值。 */
function stringValue(
  source: Record<string, unknown>,
  key: string,
  fallback: string,
  path: string,
  issues: string[]
): string {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    issues.push(path)
    return fallback
  }
  return value.trim()
}

/** 枚举取值。 */
function enumValue<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  path: string,
  issues: string[]
): T {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    issues.push(path)
    return fallback
  }
  return value as T
}

/** 三个开关：未知的键被忽略，已知的键逐个校验。 */
function normaliseActions(
  value: unknown,
  issues: string[]
): LinkageActionSwitches {
  const source = asRecord(value)
  const fallback = DEFAULT_ALARM_LINKAGE_CONFIG.actions
  if (!source) {
    if (value !== undefined) issues.push('actions')
    return { ...fallback }
  }
  const result = { ...fallback }
  for (const kind of LINKAGE_ACTION_KINDS) {
    result[kind] = boolValue(source, kind, fallback[kind], `actions.${kind}`, issues)
  }
  return result
}

/** 把任意输入归一化成一份完整、合法的联动配置。 */
export function normaliseAlarmLinkageConfig(value: unknown): NormalisedLinkageConfig {
  const issues: string[] = []
  const source = asRecord(value)
  if (!source) {
    if (value !== undefined) issues.push('(root)')
    return { config: cloneDefaults(), issues }
  }

  /**
   * 口令在**归一化之前**就被摘出来。
   *
   * 它是「只写字段」：读过一遍就必须从配置对象里消失，否则它会跟着
   * `persist()` 进 SQLite 的设置表——而这正是任务禁止的事。
   */
  const rawEmail = asRecord(source.email)
  const smtpPassword =
    rawEmail && typeof rawEmail.smtpPassword === 'string' ? rawEmail.smtpPassword : undefined

  const defaults = DEFAULT_ALARM_LINKAGE_CONFIG
  const recording = asRecord(source.recording) ?? {}
  const popup = asRecord(source.popup) ?? {}
  const notices = asRecord(source.notices) ?? {}
  const email = asRecord(source.email) ?? {}
  const runtime = asRecord(source.runtime) ?? {}
  const cooldown = asRecord(runtime.cooldown) ?? {}

  const config: AlarmLinkageConfig = {
    enabled: boolValue(source, 'enabled', defaults.enabled, 'enabled', issues),
    pollIntervalSeconds: intValue(
      source,
      'pollIntervalSeconds',
      defaults.pollIntervalSeconds,
      'pollIntervalSeconds',
      'pollIntervalSeconds',
      issues
    ),
    useDetectFeedback: boolValue(
      source,
      'useDetectFeedback',
      defaults.useDetectFeedback,
      'useDetectFeedback',
      issues
    ),
    minAlarmLevel: intValue(
      source,
      'minAlarmLevel',
      defaults.minAlarmLevel,
      'minAlarmLevel',
      'minAlarmLevel',
      issues
    ),
    actions: normaliseActions(source.actions, issues),
    recording: {
      durationSeconds: intValue(
        recording,
        'durationSeconds',
        defaults.recording.durationSeconds,
        'recording.durationSeconds',
        'recording.durationSeconds',
        issues
      ),
      cooldownSeconds: intValue(
        recording,
        'cooldownSeconds',
        defaults.recording.cooldownSeconds,
        'recording.cooldownSeconds',
        'recording.cooldownSeconds',
        issues
      ),
      skipWhenBusy: boolValue(
        recording,
        'skipWhenBusy',
        defaults.recording.skipWhenBusy,
        'recording.skipWhenBusy',
        issues
      )
    },
    popup: {
      autoDismissSeconds: intValue(
        popup,
        'autoDismissSeconds',
        defaults.popup.autoDismissSeconds,
        'popup.autoDismissSeconds',
        'popup.autoDismissSeconds',
        issues
      ),
      cooldownSeconds: intValue(
        popup,
        'cooldownSeconds',
        defaults.popup.cooldownSeconds,
        'popup.cooldownSeconds',
        'popup.cooldownSeconds',
        issues
      ),
      maxStack: intValue(popup, 'maxStack', defaults.popup.maxStack, 'popup.maxStack', 'popup.maxStack', issues)
    },
    notices: {
      pendingCapacity: intValue(
        notices,
        'pendingCapacity',
        defaults.notices.pendingCapacity,
        'notices.pendingCapacity',
        'notices.pendingCapacity',
        issues
      ),
      cooldownSeconds: intValue(
        notices,
        'cooldownSeconds',
        defaults.notices.cooldownSeconds,
        'notices.cooldownSeconds',
        'notices.cooldownSeconds',
        issues
      )
    },
    email: {
      host: stringValue(email, 'host', defaults.email.host, 'email.host', issues),
      port: intValue(email, 'port', defaults.email.port, 'email.port', 'email.port', issues),
      security: enumValue<LinkageSmtpSecurity>(
        email,
        'security',
        LINKAGE_SMTP_SECURITIES,
        defaults.email.security,
        'email.security',
        issues
      ),
      username: stringValue(email, 'username', defaults.email.username, 'email.username', issues),
      /**
       * 口令永远不会出现在设置 JSON 里。
       *
       * 这里读到的**只**允许是「凭据库里有没有口令」这个事实，且它由主进程在
       * 返回设置时填充（见 `SettingsService.describeAlarmLinkage`），
       * 界面无法通过提交设置来伪造它。
       */
      smtpPasswordStored: false,
      from: stringValue(email, 'from', defaults.email.from, 'email.from', issues),
      recipients: stringValue(email, 'recipients', defaults.email.recipients, 'email.recipients', issues),
      subjectTemplate: stringValue(
        email,
        'subjectTemplate',
        defaults.email.subjectTemplate,
        'email.subjectTemplate',
        issues
      ),
      bodyTemplate: stringValue(
        email,
        'bodyTemplate',
        defaults.email.bodyTemplate,
        'email.bodyTemplate',
        issues
      ),
      attachFrame: boolValue(email, 'attachFrame', defaults.email.attachFrame, 'email.attachFrame', issues),
      cooldownSeconds: intValue(
        email,
        'cooldownSeconds',
        defaults.email.cooldownSeconds,
        'email.cooldownSeconds',
        'email.cooldownSeconds',
        issues
      )
    },
    runtime: {
      maxActionsPerMinute: intValue(
        runtime,
        'maxActionsPerMinute',
        defaults.runtime.maxActionsPerMinute,
        'runtime.maxActionsPerMinute',
        'runtime.maxActionsPerMinute',
        issues
      ),
      cooldown: {
        periodSeconds: intValue(
          cooldown,
          'periodSeconds',
          defaults.runtime.cooldown.periodSeconds,
          'runtime.cooldown.periodSeconds',
          'runtime.cooldown.periodSeconds',
          issues
        ),
        perPeriod: intValue(
          cooldown,
          'perPeriod',
          defaults.runtime.cooldown.perPeriod,
          'runtime.cooldown.perPeriod',
          'runtime.cooldown.perPeriod',
          issues
        ),
        perInterface: intValue(
          cooldown,
          'perInterface',
          defaults.runtime.cooldown.perInterface,
          'runtime.cooldown.perInterface',
          'runtime.cooldown.perInterface',
          issues
        )
      }
    }
  }

  return {
    config,
    issues,
    ...(smtpPassword !== undefined ? { smtpPassword } : {})
  }
}

/** 结构化的深拷贝（本结构只有纯数据，没有 Date/Map）。 */
export function cloneDefaults(): AlarmLinkageConfig {
  const defaults = DEFAULT_ALARM_LINKAGE_CONFIG
  return {
    ...defaults,
    actions: { ...defaults.actions },
    recording: { ...defaults.recording },
    popup: { ...defaults.popup },
    notices: { ...defaults.notices },
    email: { ...defaults.email },
    runtime: { ...defaults.runtime, cooldown: { ...defaults.runtime.cooldown } }
  }
}

/** 只改一个动作开关，其余不动（设置页的复选框用它）。 */
export function withActionSwitch(
  config: AlarmLinkageConfig,
  kind: LinkageActionKind,
  enabled: boolean
): AlarmLinkageConfig {
  return { ...config, actions: { ...config.actions, [kind]: enabled } }
}

/** 邮箱地址的**宽松**校验：实现已移到共享层（界面与服务共用同一份）。 */
export { looksLikeEmailAddress }

/** 配置是否已经具备发邮件的最小条件（界面据此给提示，不阻止保存）。 */
export function emailConfigReady(config: AlarmLinkageConfig): boolean {
  const email = config.email
  if (email.host.trim() === '') return false
  if (!looksLikeEmailAddress(email.from)) return false
  return parseRecipients(email.recipients).length > 0
}

/** 与本文件 `parseRecipientList` 同义，但避免调用方再 import 一次领域文件。 */
function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 待处理上限的合法区间导出，给界面与测试用。 */
export const LINKAGE_PENDING_CAPACITY_RANGE = RANGES['notices.pendingCapacity']
export { LINKAGE_PENDING_CAPACITY }
