/**
 * 告警联动的领域模型（main / preload / renderer 三方共用的**唯一**一份）。
 *
 * 产品要求原文：「应该支持告警和本地联动，录像，弹窗，提示以及邮件触发」。
 *
 * 契约链：FA371 `/detect_logs` + `/detectFeedback` -> 事件身份（本文件）
 *         -> `main/services/linkage/alarm-linkage-engine` 执行四个动作
 *         -> 本文件的记录类型 -> IPC -> 界面。
 *
 * 为什么放在 `shared/domain` 而不是主进程里：渲染层必须能**命名**
 * 「待处理告警」「某个动作失败的原因」「邮件为什么没发出去」这些概念，
 * 而渲染层的 tsconfig 不包含 `src/main/`（这是本工程的进程边界规则）。
 * 这里没有一行运行时逻辑，也就没有把主进程代码拖进渲染层包里的风险。
 */

// ---------------------------------------------------------------------------
// 稳定标识（同时是 i18n 目录键的取值，绝不是显示文案）
// ---------------------------------------------------------------------------

/**
 * 可独立开关的四个动作。
 *
 * 取值同时是 `linkage.action.<value>` 与 `linkage.actionState.<value>.*`
 * 目录键的取值，因此界面不需要任何查表。
 */
export type LinkageActionKind = 'record' | 'popup' | 'notice' | 'email'

export const LINKAGE_ACTION_KINDS: readonly LinkageActionKind[] = [
  'record',
  'popup',
  'notice',
  'email'
]

/** 触发的来源。多个源可以同时报同一个事件，靠事件身份去重。 */
export type LinkageTriggerSourceKind = 'poll' | 'websocket' | 'push'

export const LINKAGE_TRIGGER_SOURCE_KINDS: readonly LinkageTriggerSourceKind[] = [
  'poll',
  'websocket',
  // 相机主动 HTTP 推送（/push_config，2026-09-24 真机实测端点）：手册「Alarm push」
  // 推荐的无人值守接收方式。与另外两个源共用同一个事件身份与去重表。
  'push'
]

/**
 * 触发事件的身份构成方式。
 *
 * **这是本功能的去重契约，写在类型里而不是注释里**（详见 `LinkageEventIdentity`）。
 */
export type LinkageEventIdentityKind = 'device:logId:startTime'

/** 一次动作的执行结果。 */
export type LinkageActionOutcomeStatus = 'success' | 'failed' | 'skipped'

/** 同一条通知在一个周期内的聚合计为 1 次动作。 */
export const LINKAGE_COOLDOWN_PERIOD_MS = 60_000

/** 「按接口限流」把 60 秒切成 6 格，即每格 10 秒。 */
export const LINKAGE_COOLDOWN_SLOTS = 6

/** 待处理告警的内存上限（超出时丢最旧的并计入 `dropped`）。 */
export const LINKAGE_PENDING_CAPACITY = 200

/** 全局速率上限的窗口长度；`maxActionsPerMinute` 指的就是这个窗口。 */
export const LINKAGE_RATE_WINDOW_MS = 60_000

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 每个动作各自的开关；整个引擎另外有一个总开关。 */
export interface LinkageActionSwitches {
  record: boolean
  popup: boolean
  notice: boolean
  email: boolean
}

export interface LinkageRecordingSettings {
  /** 联动录像时长（秒）。1~600。 */
  durationSeconds: number
  /** 同一条规则两次联动录像之间的最短间隔（秒）。 */
  cooldownSeconds: number
  /** 录像正在进行时不排队、直接跳过并记日志（相机只能开有限路 RTSP）。 */
  skipWhenBusy: boolean
}

export interface LinkagePopupSettings {
  /** 弹窗自动消失时间（秒）。0 = 不自动消失，只能手动关。 */
  autoDismissSeconds: number
  /** 同一条规则两次弹窗之间的最短间隔（秒）。 */
  cooldownSeconds: number
  /** 屏幕上同时存在的弹窗上限；超出时关掉最旧的一个。 */
  maxStack: number
}

export interface LinkageNoticeSettings {
  /** 待处理告警保留上限；超出时丢最旧的并记日志（绝不静默）。 */
  pendingCapacity: number
  /**
   * 同一条规则两次「提示」之间的最短间隔（秒）。
   *
   * 提示本身是幂等的（同一个事件身份只有一条待处理记录），这个冷却只用来
   * 决定「要不要因为这条新事件再推一次未读计数」。
   */
  cooldownSeconds: number
}

export interface LinkageEmailSettings {
  /** 真正的 SMTP 服务器；密码**不在设置里**（见 `smtpPasswordStored`）。 */
  host: string
  port: number
  /** 连接安全方式：STARTTLS / 隐式 TLS（465）/ 明文（仅调试）。 */
  security: LinkageSmtpSecurity
  username: string
  /** 是否已经在凭据库里存了口令；口令本身永不经过本结构。 */
  smtpPasswordStored: boolean
  /**
   * **只写字段**：SMTP 口令。
   *
   * 设置页保存时把它一起提交，主进程会立刻把它交给 DPAPI/safeStorage 凭据库
   * （key `smtp`），**然后从设置 JSON 里丢掉它**。因此：
   *   - 读回来的设置里它永远是 `undefined`（归一化器不认这个字段）；
   *   - 空的字符串表示「删除已保存的口令」；
   *   - 它绝不会出现在日志、SQLite 设置表或 IPC 回包里。
   * 之所以做成同一个结构里的字段而不是另开一个 IPC 通道：设置页的「保存」是
   * 一次操作，拆成两个通道就会出现「改了口令但没保存主机」的半保存状态。
   */
  smtpPassword?: string
  /** 发件人地址。 */
  from: string
  /** 收件人列表（逗号分隔）。 */
  recipients: string
  /** 主题模板，支持 `{device}` `{time}` `{count}` 占位符。 */
  subjectTemplate: string
  /** 正文模板，支持 `{device}` `{time}` `{count}` `{identity}` 占位符。 */
  bodyTemplate: string
  /** 有抓帧可用时是否作为附件发出（iVMS-4200 就是这么做的）。 */
  attachFrame: boolean
  /** 同一条规则两次邮件之间的最短间隔（秒）。 */
  cooldownSeconds: number
}

/**
 * 连接的加密方式。
 *
 * 三个取值对应三件**不同**的事，互换会直接连不上，所以界面必须显式选：
 *   - `'none'`     —— 明文（只用于本机 stub 或调试）；
 *   - `'tls'`      —— **隐式 TLS**：一连上就握手（465 那种）。手册 §17.2.8 第 5472 行
 *                     的「Enable SSL」说的就是它，界面上的选项文字因此就叫 SSL；
 *   - `'starttls'` —— 先明文打招呼、再升级加密（25/587 那种）。
 *
 * 默认 `'starttls'`：它在本机不需要预先开加密端口，并且是**升级**而不是降级。
 */
export type LinkageSmtpSecurity = 'starttls' | 'tls' | 'none'

export const LINKAGE_SMTP_SECURITIES: readonly LinkageSmtpSecurity[] = ['starttls', 'tls', 'none']

/**
 * 邮箱地址的**宽松**校验：只要求 `a@b.c` 的形状，不做 RFC 5322 全解析。
 *
 * 放在 `shared/domain` 而不是主进程里，是因为**界面与服务都要用它**：
 * 服务用它决定"配置够不够发信"，界面用它把明显打错的地址在保存之前指出来。
 * 让界面 import 主进程的实现会把主进程代码拖进渲染层包里（本工程的进程边界规则）。
 */
export function looksLikeEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/** 冷却的时间窗（秒）。 */
export interface LinkageCooldown {
  /**
   * 窗口长度。0 = 不使用时间窗。
   *
   * 为什么同时提供「时间窗」和「离散格」两种：`perPeriod` 保证「一分钟内最多
   * N 次」，`perInterface` 把一分钟切成 6 格、每格最多 M 次，用来压平
   * 「一分钟的头 5 秒里集中来 10 条」这种尖峰。两者都由同一张动作状态表实现。
   */
  periodSeconds: number
  perPeriod: number
  perInterface: number
}

export interface LinkageRuntimeSettings {
  /** 全局速率上限：每 `maxActionsPerMinute` 分钟内的动作总数（含被跳过的）。 */
  maxActionsPerMinute: number
  cooldown: LinkageCooldown
}

/**
 * 联动引擎的全部可调项。
 *
 * ---------------------------------------------------------------------------
 * 这里**故意没有**布防时间表（arming schedule）——是有意不做，不是遗漏
 * ---------------------------------------------------------------------------
 * iVMS-4200 手册 §6.15 有「每天 ≤8 段」的布防时间表。业主已决定本产品**24 小时检测**，
 * 因此不实现它，依据见 `docs/Ivms4200-UX-REFERENCE.md` §15.9 与 §15.15：
 *
 *   - 设备侧本来就没有时段概念，本机时间表只能闸门**我们自己的反应**（录像/弹窗/提示/
 *     邮件），不会让设备少检测一次；
 *   - 而「本机因为时段外不响应」在值班台上与「没有告警」**无法区分**——那是界面说假话，
 *     与本仓库的诚实原则冲突。
 *
 * 所以这个接口里不会出现 `schedule` / `armingPeriod` 之类字段，也不要在将来"顺手补上"：
 * 真要引入时间维度，先按 §15.9 的四条约束设计（告警记录绝不因时段被丢弃、记录上要能看出
 * 落在时段内外、界面要说明它不改变设备侧行为），那是产品决策而不是补一个字段。
 */
export interface AlarmLinkageConfig {
  /**
   * 总开关。**默认 true**（业主 2026-09-23：「告警信息应该默认开启」）——
   * 装完软件、相机在跑局放模板，告警就该弹窗提示，不需要先去设置里翻开关。
   * 仍然是一个可关的设置：用户在设置页关掉后，保存的值优先于这里的出厂值。
   * 注意默认开的是**引擎与本地动作**；邮件仍然默认关闭（`actions.email`），
   * 装完就往外发邮件是缺陷，不是功能。
   */
  enabled: boolean
  /** 轮询 `/detect_logs` 的间隔（秒）。这是今天就能工作的主触发源。 */
  pollIntervalSeconds: number
  /** 是否启用 `/detectFeedback` 加速器（帧真的到达之前不会做任何事）。 */
  useDetectFeedback: boolean
  /**
   * 最低告警等级；0 = 不过滤。
   *
   * 只有在设备真的回了 `alarm_level` 时才生效——手册 §8.3 C21 说读侧是
   * `0,1,2,3`、写侧是 `1,2,3,4`，所以这个数字只与设备回的值直接比较，
   * 不做任何偏移换算。
   */
  minAlarmLevel: number
  actions: LinkageActionSwitches
  recording: LinkageRecordingSettings
  popup: LinkagePopupSettings
  notices: LinkageNoticeSettings
  email: LinkageEmailSettings
  runtime: LinkageRuntimeSettings
  /**
   * 相机主动 HTTP 推送（手册「Alarm push」；端点 `/push_config`，2026-09-24 实测）。
   *
   * **默认关闭**：开它意味着在本机局域网端口上起一个监听，默认开监听是缺陷
   * （与 IoT 接入默认关同一条理由）。用户在设置里打开后，软件把各相机的
   * `push_url` 写到本机监听地址（写后读回验证）。
   */
  cameraPush: LinkageCameraPushSettings
}

/** 相机推送接收的配置。 */
export interface LinkageCameraPushSettings {
  /** 总开关：关 = 不监听、不写相机。 */
  enabled: boolean
  /** 本机监听端口（推送 URL 里的端口）。 */
  port: number
}

/** 相机推送监听的出厂端口（IoT 接入用 8080/1883，错开）。 */
export const LINKAGE_CAMERA_PUSH_DEFAULT_PORT = 8099

/** 出厂的完整默认值。引擎默认**开启**（业主 2026-09-23），邮件默认关闭。 */
export const DEFAULT_ALARM_LINKAGE_CONFIG: AlarmLinkageConfig = {
  enabled: true,
  pollIntervalSeconds: 10,
  useDetectFeedback: true,
  minAlarmLevel: 0,
  actions: { record: true, popup: true, notice: true, email: false },
  recording: { durationSeconds: 30, cooldownSeconds: 30, skipWhenBusy: true },
  popup: { autoDismissSeconds: 15, cooldownSeconds: 10, maxStack: 3 },
  notices: { pendingCapacity: LINKAGE_PENDING_CAPACITY, cooldownSeconds: 0 },
  email: {
    host: '',
    /**
     * 端口默认 **25**，来自手册 §17.2.8 第 5466 行：
     * 「Port: Input the communication port of email service. The port is 25 by default.」
     *
     * 本仓库原来默认 587（STARTTLS 的习惯端口）。改成 25 是**照手册**，并且它才是
     * 那个"什么都不填也能用"的出厂值：25/STARTTLS 组合在大多数服务器上成立，
     * 而 587/STARTTLS 需要服务器确实开了那个端口。端口与加密方式在界面上是两个
     * 独立字段（手册的字段表就是如此），所以选 SSL 时要自己把端口改成 465——
     * 界面在那一行给了提示（`emailUi.portHint`），不替用户改写他填过的数字。
     */
    port: 25,
    security: 'starttls',
    username: '',
    smtpPasswordStored: false,
    from: '',
    recipients: '',
    subjectTemplate: '',
    bodyTemplate: '',
    attachFrame: true,
    cooldownSeconds: 60
  },
  runtime: { maxActionsPerMinute: 20, cooldown: { periodSeconds: 60, perPeriod: 10, perInterface: 2 } },
  cameraPush: { enabled: false, port: LINKAGE_CAMERA_PUSH_DEFAULT_PORT }
}

/**
 * 2026-09-23 之前**唯一的**出厂配置：与现在的默认逐字段相同，只是 `enabled: false`。
 *
 * 为什么需要认出它：设置服务的 `persist()` 是**整包写入**——任何一次设置保存
 * （哪怕只是改了存储路径）都会把当时的 `alarmLinkage` 默认值一起落库。于是老装上
 * 很多库里躺着一份「用户从未碰过联动设置、但 `enabled: false` 已持久化」的记录，
 * 只改出厂默认值对它们不生效。
 *
 * 识别规则因此非常窄：**归一化后与这份旧默认逐字段完全相等**才视为「用户没碰过」，
 * 允许设置服务把它升级成新默认；任何字段被用户改过（哪怕只改了一秒冷却），都视为
 * 用户的选择，原样保留。
 */
const LEGACY_DEFAULT_ALARM_LINKAGE_CONFIG: AlarmLinkageConfig = {
  ...DEFAULT_ALARM_LINKAGE_CONFIG,
  enabled: false,
  actions: { ...DEFAULT_ALARM_LINKAGE_CONFIG.actions },
  recording: { ...DEFAULT_ALARM_LINKAGE_CONFIG.recording },
  popup: { ...DEFAULT_ALARM_LINKAGE_CONFIG.popup },
  notices: { ...DEFAULT_ALARM_LINKAGE_CONFIG.notices },
  email: { ...DEFAULT_ALARM_LINKAGE_CONFIG.email },
  runtime: {
    ...DEFAULT_ALARM_LINKAGE_CONFIG.runtime,
    cooldown: { ...DEFAULT_ALARM_LINKAGE_CONFIG.runtime.cooldown }
  }
}

/** 深度相等（键序无关）。这两个配置对象都是纯 JSON 形状，不含函数与循环引用。 */
function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null || typeof left !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepEqualJson(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => key in rightRecord && deepEqualJson(leftRecord[key], rightRecord[key]))
}

/**
 * 一份（已归一化的）配置是不是「旧出厂默认」——即用户从未改过联动设置的老装。
 * 设置服务在读取路径上用它把这类记录升级到 `enabled: true` 的新默认。
 */
export function isLegacyDefaultAlarmLinkageConfig(config: AlarmLinkageConfig): boolean {
  return deepEqualJson(config, LEGACY_DEFAULT_ALARM_LINKAGE_CONFIG)
}

/** 邮件模板的默认值；界面用它们填占位，而不是展示空框。 */
export const LINKAGE_EMAIL_TEMPLATE_DEFAULTS = {
  subject: '[HAIS] {device} 告警 ({count})',
  body: '{device} 在 {time} 触发告警。\n事件标识：{identity}\n本邮件由本地联动引擎自动发送。'
} as const

/** 配置里可选的模板占位符（界面照它渲染说明，测试照它断言）。 */
export const LINKAGE_TEMPLATE_PLACEHOLDERS: readonly string[] = [
  '{device}',
  '{time}',
  '{count}',
  '{identity}'
]

/**
 * 「有字段就判，没有就按声明的规则判」的告警判定规则。
 *
 * 手册 §8.3 C15（P0）说明 `is_alarm` / `alarm_level` 这些字段**表格里有、
 * 两处示例里一个都没有**。因此判定必须能回答「这条日志算不算告警」，
 * 且必须能说清「是按哪个字段判的」：
 *   - `is_alarm` 存在且为 false -> 不是告警（`not-alarm`）；
 *   - `is_alarm` 存在且为 true  -> 是告警（`is-alarm-flag`）；
 *   - 字段缺失                  -> 按「每条完成的检测日志都是一次告警事件」
 *                                 处理（`field-absent`），并在审计日志里写明。
 * 第三条是刻意的：在一个「告警联动」功能里，漏报比误报糟得多，而设备上真的
 * 有告警时必然留下一条检测日志。
 */
export type LinkageAlarmDecision =
  | 'is-alarm-flag'
  | 'field-absent'
  | 'not-alarm'
  | 'below-min-level'

// ---------------------------------------------------------------------------
// 事件身份（去重的唯一依据）
// ---------------------------------------------------------------------------

/**
 * 一个告警事件的**稳定身份**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 `deviceId + logId + startTime`，而不是别的
 * ---------------------------------------------------------------------------
 * 1) **不用「事件到达时刻」**：那不是事件的属性，是观察者的属性。轮询在
 *    T1 看到、WebSocket 在 T2 又推一次，两者会得到不同身份，去重直接失效。
 *
 * 2) **以 `id`（检测日志编号）为主键**。它是设备自己给的、跨源一致的编号：
 *    `GET /detect_logs` 的每条日志与 `/detectFeedback` 的 `detect_log` 都带它
 *    （手册 §5.1.17 / §5.2.3），所以轮询与 WebSocket 推的同一个检测结果
 *    必然对出同一个身份。
 *
 * 3) **`start_time` 作为第二个分量，而不是唯一键**。原因是那个 `id` 的语义
 *    没有被完全钉死：手册 §5.1.17 把它描述成「检测日志 id」，而 §5.1.17 的
 *    `detect_id` 查询参数是「检测编号」——两者是不是同一套编号，手册没说，
 *    实测这台设备上也还没有任何一条日志可看（见下面的实测记录）。设备只保留
 *    最近 100 条（§8.5 E11）并在超限时**回收编号**，所以一个纯 `id` 身份在
 *    长时间运行后可能撞上一条完全不同的旧日志。加上 `start_time` 之后，
 *    「同一个编号 + 同一个开始时刻」几乎不可能是两次不同的检测，而
 *    「同一个编号 + 不同开始时刻」会被正确地当成两件事。
 *
 * 4) **`deviceId` 必须在内**：多台相机各有各的编号空间。
 *
 * 5) 归一化后的字符串进 `Set` 去重，因此调用方拿到的 `eventId` 已经是
 *    `deviceId:logId:startTime` 的形状；`logId` / `startTime` 缺失时用 `-`，
 *    此时身份退化为「设备 + 可用字段」。**退化也在代码里，不在注释里。**
 *
 * 实测记录（2026-09-15，192.168.110.235）：`GET /detect_logs` 返回
 * `{"detect_logs":[],"logs_count":0}`，`/detectFeedback` 在 9 秒窗口内 0 帧，
 * 所以上面的字段名来自手册而不是真机样本——这也是为什么 `startTime` 被一起
 * 纳入身份，而不是只信任 `id`。
 */
export interface LinkageEventIdentity {
  deviceId: string
  /** 归一化后的去重字符串。 */
  eventId: string
  /** 检测日志编号；设备没给时为 undefined。 */
  logId?: number
  /** 检测开始时刻（原始未换算的时间戳）；设备没给时为 undefined。 */
  startTime?: number
  /** 这个身份是怎么拼出来的，写死在类型里以便审计与测试。 */
  identityKind: LinkageEventIdentityKind
}

/** 一次触发的完整快照，四个动作与审计日志都用它。 */
export interface LinkageTrigger {
  identity: LinkageEventIdentity
  /** 首次观察到该事件的时刻（epoch ms，本地时钟）。 */
  observedAt: number
  /** 规则 id（本功能里一条规则 = 一台设备）。冷却与限流按它分桶。 */
  ruleId: string
  deviceId: string
  deviceName: string
  /** 设备回告的原始告警等级（未做偏移换算）。 */
  alarmLevelRaw?: number
  /** 设备回告的告警策略 id。 */
  strategyId?: number
  source: LinkageTriggerSourceKind
  /** 判定依据，进审计日志。 */
  decision: LinkageAlarmDecision
}

// ---------------------------------------------------------------------------
// 执行记录
// ---------------------------------------------------------------------------

/** 体检指标；进「提示」这条待处理记录，供界面直接显示。 */
export interface LinkageMetrics {
  soundmapIntensity?: number
  leakVolume?: number
  /** 泄漏价格（`data_2`，仅泄漏模式携带，2026-09-24）。 */
  leakCost?: number
  /** 告警时刻的声压级 dB（`last_alarm_db`，2026-09-23 真机实测存在）。 */
  alarmDb?: number
  /** 告警时刻的主频 Hz（`last_alarm_df`）。 */
  alarmDf?: number
}

/**
 * `data_1`/`data_2`（泄漏量 / 泄漏价格）什么时候能当泄漏读数携带与展示。
 *
 * 设备在非泄漏记录里会把 `data_1` 写成占位 0（2026-09-24 真机：局放告警 `data_1=0`；
 * 本机 200 条历史里 147 条没有 `detect_mode` 的局放记录全是 `leakVolume: 0`）。
 * 把占位的 0 印成「泄漏量 0」，等于替设备说了一个它没说的读数，所以：
 *   · 模式明确不是泄漏（1 局放 / 3 机械）：不携带；
 *   · 模式未知（老固件不回 `detect_mode`）：只保留**非零**值 —— 非零才像真实读数；
 *   · 模式是泄漏（2）：原样保留，包括 0（那是设备在这个模式下给的读数）。
 *
 * 一处规则，四处共用：三个触发源（轮询 / 推送 / WebSocket）、检测库事件与告警文案。
 */
export function leakMetricsForMode(
  mode: number | undefined,
  volume: number | undefined,
  cost: number | undefined
): Pick<LinkageMetrics, 'leakVolume' | 'leakCost'> {
  if (mode !== undefined && mode !== 2) return {}
  const out: Pick<LinkageMetrics, 'leakVolume' | 'leakCost'> = {}
  if (volume !== undefined && (mode === 2 || volume !== 0)) out.leakVolume = volume
  if (cost !== undefined && (mode === 2 || cost !== 0)) out.leakCost = cost
  return out
}

/**
 * 告警事件的设备侧语义（相机自己判定的结果，2026-09-23 真机字段实测）。
 *
 * 「检测与判断都在相机上、软件只接收」是产品口径：这两个字段就是相机判定结论的
 * 一部分（什么模式、哪种放电类型），软件**不重新推导**，只如实携带与展示。
 */
export interface LinkageAlarmSemantics {
  /** 检测模式原始值（1 局放 / 2 泄漏 / 3 机械——与 work_mode 同一取值域）。 */
  detectMode?: number
  /** 放电类型稳定键（`FA371_DISCHARGE_TYPE_KEYS`；未知取值不携带）。 */
  dischargeTypeKey?: string
}

export interface LinkageActionOutcome {
  action: LinkageActionKind
  status: LinkageActionOutcomeStatus
  /** 失败/跳过的原因（原始诊断文本），成功时通常缺省。 */
  reason?: string
  /** 产物：录像行 id、抓帧路径、收件人数……失败时缺省。 */
  detail?: Record<string, unknown>
  /**
   * 失败/跳过是否计入冷却。
   *
   * 冷却的作用是「别对操作员轰炸」，所以失败与跳过**同样计数**：一封发不出去
   * 的邮件如果每 10 秒重试一次，日志和界面上都会变成噪音。
   */
  counted?: boolean
}

/** 一条动作的完整执行记录（审计单位）。 */
export interface LinkageActionRecord {
  action: LinkageActionKind
  /** 记录创建时刻。 */
  at: number
  status: LinkageActionOutcomeStatus
  reason?: string
  detail?: Record<string, unknown>
  /** 结束时是否处于冷却中（跳过的原因之一）。 */
  cooldownRemainingMs?: number
}

/** 一次触发引发的全部动作结果。 */
export interface LinkageExecution {
  eventId: string
  at: number
  outcomes: LinkageActionOutcome[]
}

// ---------------------------------------------------------------------------
// 待处理告警（「提示」的持久化形态）
// ---------------------------------------------------------------------------

/** 一条待处理告警。 `notice` 动作写入，操作员确认后消失。 */
export interface PendingAlarmRecord {
  eventId: string
  deviceId: string
  deviceName: string
  /** 事件发生时刻（有 `start_time` 就用它换算，否则用首次观察时刻）。 */
  at: number
  /** 首次观察时刻。 */
  observedAt: number
  /** 触发源（两个源都报了就是先到的那一个）。 */
  source: LinkageTriggerSourceKind
  alarmLevelRaw?: number
  strategyId?: number
  /** 相机判定的检测模式与放电类型（2026-09-23；含义见 `LinkageAlarmSemantics`）。 */
  detectMode?: number
  dischargeTypeKey?: string
  metrics?: LinkageMetrics
  /** 联动录像的 id（录像动作成功时）。 */
  recordingId?: string
  /** 抓帧的存储根相对路径（抓帧成功时）。 */
  frameRelativePath?: string
  /** 四个动作各自的结果，界面直接显示「录像失败：…」。 */
  actions: LinkageActionRecord[]
  acknowledged: boolean
  acknowledgedAt?: number
}

/** 一次查询的结果，带「因为超出上限被丢掉多少条」的诚实计数。 */
export interface PendingAlarmSnapshot {
  items: PendingAlarmRecord[]
  /** 累计因为超出上限而被丢弃的条数。绝不静默。 */
  dropped: number
}

// ---------------------------------------------------------------------------
// 引擎状态（设置页的诊断面板）
// ---------------------------------------------------------------------------

export interface LinkageSourceStatus {
  kind: LinkageTriggerSourceKind
  deviceId: string
  running: boolean
  lastPollAt?: number
  lastError?: string
  /** 轮询源累计产生的触发数。 */
  triggers: number
  /** WebSocket 源累计收到的帧数（0 = 至今没有帧，这本身是结论）。 */
  frames: number
}

export interface LinkageEngineStatus {
  enabled: boolean
  sources: LinkageSourceStatus[]
  /** 本次运行累计的触发数（去重后）。 */
  triggers: number
  /** 累计的动作数（含失败与跳过）。 */
  actions: number
  /** 全局速率上限当前窗口内的用量。 */
  actionsThisWindow: number
  pending: PendingAlarmSnapshot
}

// ---------------------------------------------------------------------------
// 邮件
// ---------------------------------------------------------------------------

/** 一封外发邮件的内容（`LinkageEmailSender` 的入参）。 */
export interface LinkageEmailMessage {
  from: string
  to: string[]
  subject: string
  text: string
  attachment?: {
    fileName: string
    contentType: string
    bytes: Uint8Array
  }
}

/** 一次 SMTP 交互的结果。失败时**必须**带上真实原因，绝不吞。 */
export type LinkageEmailSendResult =
  | { ok: true; accepted: string[]; transcript: string[] }
  | { ok: false; error: string; detail?: string; transcript: string[] }

/** 设置页「测试邮件」的入参：口令可以临时给，不必先保存。 */
export interface LinkageTestEmailInput {
  host: string
  port: number
  security: LinkageSmtpSecurity
  username: string
  /** 留空表示「用已保存的那个口令」。 */
  password?: string
  from: string
  recipients: string
  subject: string
  body: string
  /**
   * 附带帧：
   *   - `'none'`     不附；
   *   - `'synthetic'` 附一段内置的 1×1 PNG（用于验证附件编码本身）；
   *   - `'camera'`   取指定设备的最新一帧（该设备当前有可用 RTSP 源时）。
   */
  attach: LinkageTestAttachmentKind
  /** `attach === 'camera'` 时使用。 */
  deviceId?: string
}

export type LinkageTestAttachmentKind = 'none' | 'synthetic' | 'camera'

export const LINKAGE_TEST_ATTACHMENT_KINDS: readonly LinkageTestAttachmentKind[] = [
  'none',
  'synthetic',
  'camera'
]

/** 测试邮件的结果：把 SMTP 自己的话原样带出来。 */
export interface LinkageTestEmailResult {
  ok: boolean
  /** 人类可读的一句话（四种语言渲染时只用它做降级，主文案在界面里）。 */
  error?: string
  /** SMTP 服务器的原始回复，逐行；诊断时比一句话有用得多。 */
  detail?: string
  transcript: string[]
}

// ---------------------------------------------------------------------------
// 身份归一的纯函数
// ---------------------------------------------------------------------------

/** 身份字符串的分隔符。`: ` 会出现在设备名里，`:` 不会出现在这些数字字段里。 */
const IDENTITY_SEPARATOR = ':'

/** 把可能缺失的数字字段渲染成身份字符串的一段。 */
function identitySegment(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '-'
  return String(Math.trunc(value))
}

/**
 * 由设备 id + 日志 id + 开始时刻拼出一个**稳定**的事件身份。
 *
 * 纯函数，两个触发源与测试共用同一份实现，因此「轮询和 WebSocket 报的是不是
 * 同一个事件」这个问题只有一个答案。
 */
export function linkAgeEventIdentity(
  deviceId: string,
  logId: number | undefined,
  startTime: number | undefined
): LinkageEventIdentity {
  const identity: LinkageEventIdentity = {
    deviceId,
    eventId: [deviceId, identitySegment(logId), identitySegment(startTime)].join(IDENTITY_SEPARATOR),
    identityKind: 'device:logId:startTime'
  }
  if (logId !== undefined && Number.isFinite(logId)) identity.logId = Math.trunc(logId)
  if (startTime !== undefined && Number.isFinite(startTime)) identity.startTime = Math.trunc(startTime)
  return identity
}

/** 从任意字符串还原身份的各个分量（审计日志与待处理记录用）。 */
export function parseLinkageEventIdentity(eventId: string): LinkageEventIdentity {
  const parts = eventId.split(IDENTITY_SEPARATOR)
  const deviceId = parts[0] ?? ''
  const logIdRaw = parts[1]
  const startRaw = parts[2]
  const logId = logIdRaw !== undefined && logIdRaw !== '-' ? Number(logIdRaw) : undefined
  const startTime = startRaw !== undefined && startRaw !== '-' ? Number(startRaw) : undefined
  return linkAgeEventIdentity(
    deviceId,
    logId !== undefined && Number.isFinite(logId) ? logId : undefined,
    startTime !== undefined && Number.isFinite(startTime) ? startTime : undefined
  )
}

/**
 * 冷却计数器的取值：`floor(now / window) % slots`。
 *
 * 离散成格而不是滑动窗口，是为了让「每分钟最多 N 次」这个语义可以被一句话
 * 说清、也能被测试直接断言：第 k 格与第 k+1 格之间的边界处，计数归零。
 */
export function linkageCooldownSlot(now: number, windowMs: number, slots: number): number {
  const safeWindow = windowMs > 0 ? windowMs : LINKAGE_RATE_WINDOW_MS
  const safeSlots = slots > 0 ? Math.trunc(slots) : 1
  return Math.floor(now / safeWindow) % safeSlots
}

/** 把逗号/分号/换行分隔的收件人列表切成数组，并丢掉空项。 */
export function parseRecipientList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}
