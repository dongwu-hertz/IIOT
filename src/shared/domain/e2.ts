/**
 * E2 / 听诊盒子族（HZ-FA-100 / FA110 / E2）的**「拉」通道**协议。
 *
 * ---------------------------------------------------------------------------
 * 资料来源（三份，都是主源）—— **它们不是同一代协议**
 * ---------------------------------------------------------------------------
 *   - `API_doc_En听诊盒子API接口20231222.docx`（2023 版：`work_mode` + `alarm_value` 位表）
 *   - `API documents_ Acoustic Box FA110_20240312.docx`（与上面**同一套**，英文版）
 *   - `Air Sonar User Manual 241128.pdf`（**V3.2，另一代**：16 通道、PTZ 相机、
 *     没有 `work_mode`、没有 `alarm_value`/`alarm_reasons`）
 *
 * 业主 2026-09-17 澄清了第三份资料的**产品身份**：那是他们的一款 **SN-16 空气声呐**，
 * 用途是**声源定位**（不是"再一款听诊盒子"）。手册里的示例型号串写的是 `AS16`，
 * 产品名是 SN-16 —— 所以 `e2ChannelCountFromModel()` 两种写法都认（见那里的注释），
 * 界面上的代次名也按 SN-16 写。**变体键仍然是 `airSonar`**：它出现在 IPC 形状与落库数据里，
 * 为了让名字更好听去改键，只会让旧数据与旧日志对不上（键不是给人看的，标签才是）。
 *
 * 2026-09-17 拿到第三份之后，"这一族只有一套协议"这句话就不成立了。两份的差别不是措辞，
 * 是**字段与端点都换了**（详见 `docs/Ivms4200-UX-REFERENCE.md` §15.28 的对照表）：
 *
 * | | 听诊盒子（2023 版，`auscultation`） | 空气声呐 SN-16（V3.2，`airSonar`） |
 * |---|---|---|
 * | 工作模式 | `work_mode`（三种） | **没有**（单一用途：声源定位 + PTZ 联动） |
 * | 通道 | 1 | **16**（`dev_type` = `AS16` 或 `SN-16`，`/realtime_chan` 1..16） |
 * | 日志接口 | `/alarm_log_all`、`/alarm_log` | `/get_all_alarms`、`/get_alarm_logs_conditional` |
 * | 日志字段 | `alarm_value`（位表）+ `alarm_reasons` 文本 + `audio_name` | 无位图、无原因文本；有 `horizontal`/`vertical` 方位角 |
 * | 录音文件名 | `audio_name` 给（时间戳） | **固定 `alarm.wav`** |
 * | 图 | 10 张时频谱图（`1..10.jpg`） | **3 张 PTZ 抓图**（`1..3.jpg`） |
 * | 下载 | `/alarm_files` | `/saving_alarm_file` |
 * | 口令 | 手册只写 "MD5, 32 characters" | **`lfxs` + MD5** |
 *
 * 所以这一层现在有**两个变体**：`E2Variant`。变体**靠设备自己的回话判定**
 * （`detectE2Variant()`：`/system` 里有 `cam_enable`/`cur_realtime_channel` 就是 Air Sonar，
 * 有 `work_mode` 就是听诊盒子），不靠型号名猜、也不让用户选。
 */

// ---------------------------------------------------------------------------
// 变体
// ---------------------------------------------------------------------------

/** 听诊盒子族的两代协议。 */
export type E2Variant = 'auscultation' | 'airSonar'

export const E2_VARIANTS: readonly E2Variant[] = ['auscultation', 'airSonar']

export function isE2Variant(value: unknown): value is E2Variant {
  return typeof value === 'string' && (E2_VARIANTS as readonly string[]).includes(value)
}

/**
 * 从 `GET /system` 的回话判定变体。
 *
 * 判据是**字段本身**，不是型号名：
 *   - 有 `cam_enable` / `cur_realtime_channel` / `is_save_snapshot` ⇒ 空气声呐 SN-16（V3.2）
 *     （那几个键是它的 PTZ 联动参数，2023 版一个都没有）；
 *   - 有 `work_mode` ⇒ 2023 版听诊盒子。
 *
 * 两个都没有 ⇒ `undefined`（"认不出"）。那**不是**错误：一台固件比手册新的设备应当被如实
 * 报成"读不懂它的参数"，而不是被硬塞进某个变体里、然后按错的端点去查日志。
 */
export function detectE2Variant(system: Record<string, unknown> | undefined): E2Variant | undefined {
  if (!system) return undefined
  const airSonarKeys = ['cam_enable', 'cur_realtime_channel', 'is_save_snapshot', 'is_send_realtime_value']
  if (airSonarKeys.some((key) => key in system)) return 'airSonar'
  if ('work_mode' in system) return 'auscultation'
  return undefined
}

/**
 * 由设备型号字符串推通道数：`AS16` / `SN-16` / `SN16` / `AS16-auth-vertical-reverse` ⇒ 16。
 * 推不出来就 `undefined`（不猜）。
 *
 * 三种写法都要认，而且**允许后缀**（业主 2026-09-17 澄清 + 同日真机验证）：
 *   - 那份 API 文档对应的是他们的一款 **SN-16 空气声呐**（做**声源定位**），
 *     而手册示例里 `dev_type` 写的是 `AS16`；
 *   - 真机（固件 V3.4.0）实测报的是 **`AS16-auth-vertical-reverse`** ——
 *     前缀是型号，后缀是**这一台的配置**（`auth`、云台竖直反向）。第一版的正则要求
 *     "前缀 + 数字 + 结尾"，于是这台 16 通道的设备被判成"读不出通道数"，
 *     界面显示"未上报通道数"（那看起来像设备没回这条信息）。
 *
 * 形状：`AS`/`SN` + 可选连字符 + 1..3 位数字，**数字后面不许再跟数字**（`AS1600` 不许被读成 16），
 * 后面跟什么后缀都行。范围 1..64，超出就返回 `undefined` —— 不拿 16 当默认值：
 * 编出来的通道数会被当成设备事实。
 */
export function e2ChannelCountFromModel(devType: unknown): number | undefined {
  if (typeof devType !== 'string') return undefined
  const match = /^(?:AS|SN)-?(\d{1,3})(?![0-9])/i.exec(devType.trim())
  if (!match) return undefined
  const count = Number(match[1])
  return Number.isInteger(count) && count > 0 && count <= 64 ? count : undefined
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

/**
 * 两个变体各自的端点表。
 *
 * 用一个 `Record<E2Variant, …>` 而不是在两个函数里写 if：端点名的差异一旦散开，
 * 就会有一处忘了改 —— 而"忘了改"的表现是 404，也就是设备"离线"。
 */
export const E2_ENDPOINTS_BY_VARIANT: Record<E2Variant, {
  login: string
  system: string
  basic: string
  alarmLogAll: string
  alarmLogConditional: string
  alarmFile: string
  hbSettings: string
  heartbeat: string
  reboot: string
}> = {
  auscultation: {
    login: '/login',
    system: '/system',
    basic: '/basic',
    alarmLogAll: '/alarm_log_all',
    alarmLogConditional: '/alarm_log',
    alarmFile: '/alarm_files',
    hbSettings: '/hb_settings',
    heartbeat: '/heartbeat',
    reboot: '/reboot'
  },
  airSonar: {
    login: '/login',
    system: '/system',
    basic: '/get_device_basic_params',
    alarmLogAll: '/get_all_alarms',
    alarmLogConditional: '/get_alarm_logs_conditional',
    alarmFile: '/saving_alarm_file',
    hbSettings: '/hb_settings',
    heartbeat: '/heartbeat',
    reboot: '/reboot'
  }
}

/** 认证与实时流是两代共用的（路径一样，语义一样）。 */
export const E2_ENDPOINTS = {
  login: '/login',
  system: '/system',
  heartbeat: '/heartbeat',
  reboot: '/reboot'
} as const

/** Air Sonar 专有：PTZ 参数 / 实时通道号 / PTZ 时间同步 / 全通道流。 */
export const E2_AIR_SONAR_ENDPOINTS = {
  nvtConfig: '/NVTconfig',
  realtimeChannel: '/realtime_chan',
  timeSyncWithNvt: '/time_sync_with_nvt',
  allChannelsStream: '/all_chns_stream'
} as const

/** 实时流（WebSocket，不在「拉」通道里，但 2023 版的 `/workmode` 会返回它们的地址）。 */
export const E2_STREAM_PATHS = { audio: '/audio_stream', stft: '/stft_stream' } as const

// ---------------------------------------------------------------------------
// 工作模式
// ---------------------------------------------------------------------------

export type E2WorkMode = 'burst_of_loud_sound' | 'rotating_equipment' | 'electrical_power_equipment'

export const E2_WORK_MODES: readonly E2WorkMode[] = [
  'burst_of_loud_sound',
  'rotating_equipment',
  'electrical_power_equipment'
]

/** 收窄来自设备 / IPC / 数据库的取值（与 `isDeviceKind()` 同一条规矩）。 */
export function isE2WorkMode(value: unknown): value is E2WorkMode {
  return typeof value === 'string' && (E2_WORK_MODES as readonly string[]).includes(value)
}

/**
 * 每种模式的**阈值参数**（2023 版听诊盒子）。
 *
 * 键名与手册一致（`db_limit`、`hpss_limit`…），**默认值不是我们定的** —— 界面里显示的
 * 默认值只能来自一次真实读取，永远不要在这里写一份"出厂默认"（那会变成我们编的数）。
 * `notify_url` / `is_send_alarm` / `is_send_fft` 三种模式都有，所以单列。
 */
export const E2_COMMON_PARAMS: readonly string[] = ['notify_url', 'is_send_alarm', 'is_send_fft']

/**
 * Air Sonar V3.2 的参数（`GET /system` 原样键名）。
 *
 * 与上面那一族**没有交集**（除了 `notify_url`/`is_send_alarm` 这两个语义相同的）。
 * `cam_pass` 在列表里但界面**不显示它的值**（那是 PTZ 相机口令）——见 `E2_SENSITIVE_PARAMS`。
 */
export const E2_AIR_SONAR_PARAMS: readonly string[] = [
  'cam_enable',
  'cam_ip',
  'cam_port',
  'cam_user',
  'cur_realtime_channel',
  'db_limit',
  'tde_ratio_limit',
  'fde_ratio_limit',
  'freq_down_limit',
  'freq_up_limit',
  'is_cam_init',
  'is_ptz_direction_same_with_sonar',
  'is_save_snapshot',
  'is_send_alarm',
  'is_send_realtime_value',
  'notify_url',
  'samplerate'
]

/**
 * 读回来了但**不显示值**的参数（只显示"已设置"）。
 *
 * `cam_pass` 是 PTZ 相机的口令：它出现在设备状态里的唯一原因是设备把它回给了我们，
 * 那不是把它显示在屏幕上的理由。这一条是本仓库既有的纪律（设备口令进 `safeStorage`、
 * 不进日志），PTZ 口令同样。
 */
export const E2_SENSITIVE_PARAMS: readonly string[] = ['cam_pass']

/**
 * 参数按键的取值形状（用于界面分组，不是语义枚举）。
 *
 * 分成「阈值」「相机」「开关」「其它」四组：Air Sonar 一次回 18 个键，平铺一列没法看。
 */
export const E2_PARAM_GROUPS: Record<string, 'threshold' | 'camera' | 'switch' | 'other'> = {
  db_limit: 'threshold',
  tde_ratio_limit: 'threshold',
  fde_ratio_limit: 'threshold',
  freq_down_limit: 'threshold',
  freq_up_limit: 'threshold',
  main_freq_limit: 'threshold',
  hpss_limit: 'threshold',
  sc_ratio_limit: 'threshold',
  sc_ratio_threshold: 'threshold',
  samplerate: 'other',
  notify_url: 'other',
  cam_enable: 'camera',
  cam_ip: 'camera',
  cam_port: 'camera',
  cam_user: 'camera',
  cam_pass: 'camera',
  cur_realtime_channel: 'camera',
  is_cam_init: 'switch',
  is_ptz_direction_same_with_sonar: 'switch',
  is_save_snapshot: 'switch',
  is_send_alarm: 'switch',
  is_send_realtime_value: 'switch',
  is_send_fft: 'switch'
}

export const E2_MODE_PARAMS: Record<E2WorkMode, readonly string[]> = {
  burst_of_loud_sound: [
    'samplerate',
    'db_limit',
    'tde_ratio_limit',
    'fde_ratio_limit',
    'freq_down_limit',
    'freq_up_limit'
  ],
  rotating_equipment: ['db_limit', 'hpss_limit'],
  electrical_power_equipment: [
    'samplerate',
    'db_limit',
    'fde_ratio_limit',
    'freq_down_limit',
    'freq_up_limit',
    'main_freq_limit',
    'sc_ratio_limit',
    'sc_ratio_threshold'
  ]
}

/** 一种模式要读/写的全部参数键（模式专有 + 三种共用），顺序稳定便于界面逐个渲染。 */
export function e2ParamKeys(mode: E2WorkMode): string[] {
  return [...E2_MODE_PARAMS[mode], ...E2_COMMON_PARAMS]
}

// ---------------------------------------------------------------------------
// alarm_value：手册列了 6 个值（不是 8 条告警类型）
// ---------------------------------------------------------------------------

export interface E2AlarmBit {
  /** 手册给的十六进制值（每个值是一个独立的十六进制"位"）。 */
  value: number
  /** 稳定键（渲染层翻译成文案，域层不留界面语言）。 */
  key: string
}

/**
 * 手册 §"Note" 列出的对应关系，逐条照抄。
 *
 * 注意最后一条：手册写的告警类型列表里有"奇偶谐波比超限"，但**这张位表里没有它**，
 * 也没有对应的阈值参数。所以奇偶谐波比落在"未说明的位"里，不猜。
 */
export const E2_ALARM_BITS: readonly E2AlarmBit[] = [
  { value: 0x00000001, key: 'db_limit' },
  { value: 0x00000010, key: 'main_freq_limit' },
  { value: 0x00000100, key: 'tde_ratio_limit' },
  { value: 0x00001000, key: 'fde_ratio_limit' },
  { value: 0x00010000, key: 'hpss_limit' },
  { value: 0x00100000, key: 'sc_ratio_limit' }
]

export interface E2AlarmValueDecoded {
  /** 认出来的阈值键（顺序按位值从小到大）。 */
  keys: string[]
  /** **手册未说明**的置位（原始位值），如实列出。 */
  unknownBits: number[]
  /** 原始整数（设备给什么就存什么，界面可以显示它）。 */
  raw: number
}

/**
 * 解 `alarm_value`。
 *
 * 手册的原话是"一个十六进制数，**每一位**代表一个键值，超限则那一位是 1" —— 所以那些值是
 * `1`、`0x10`、`0x100`… 这样的稀疏十六进制位。这里逐位扫描：认得的按位表归类，**认不得的
 * 单独列出来**（而不是丢掉、也不是当成 FA8 的 14 位位图去解 —— 两者不是一套东西）。
 *
 * 实测自洽的一点：手册示例 `alarm_value: 256`（= 0x100）配的 `alarm_reasons` 正是
 * "时域能量比超限，" —— 与位表里 0x100 = 时域能量比一致，这张表是可信的。
 */
export function decodeE2AlarmValue(raw: unknown): E2AlarmValueDecoded {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0
  const keys: string[] = []
  const unknownBits: number[] = []

  for (let bit = 0; bit < 32; bit += 1) {
    const mask = 2 ** bit
    if ((value & mask) === 0) continue
    const known = E2_ALARM_BITS.find((entry) => entry.value === mask)
    if (known) keys.push(known.key)
    else unknownBits.push(mask)
  }

  return { keys, unknownBits, raw: value }
}

// ---------------------------------------------------------------------------
// 时间字符串（设备没有时区信息）
// ---------------------------------------------------------------------------

export interface E2ParsedTime {
  /** epoch ms（按**本机本地时区**解释）。 */
  ms: number
  /** 设备原文给出的样式：日志是 `long`，回调是 `compact`。 */
  style: 'long' | 'compact'
  /**
   * 设备有没有给出时区：**恒为 `false`**。
   *
   * 这一位不是装饰：它让调用方（界面）能说出"设备时间按本机时区解释"，而不是把一个
   * 不知道时区的时间当成绝对时刻展示。
   */
  offsetKnown: false
  /** 原样保留的字符串，排查时不必再去反推。 */
  raw: string
}

/** `yyyy-MM-dd_HH-mm-SS`（告警日志用的那个）。 */
const LONG_TIME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/
/** `yyyyMMdd_HHmmSS`（告警回调用的那个）。 */
const COMPACT_TIME = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/

/**
 * 解设备的时间字符串。两种样式都认（日志与回调不一样）。
 *
 * 解析失败返回 `undefined`：一个解不出来的时间**不该**被当成 0 或"现在" —— 那会让告警
 * 排到时间轴的两端，而这种错看起来像"设备时钟不对"。
 */
export function parseE2Timestamp(value: unknown): E2ParsedTime | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()

  const long = LONG_TIME.exec(text)
  if (long) {
    return build(long, 'long', text)
  }
  const compact = COMPACT_TIME.exec(text)
  if (compact) {
    return build(compact, 'compact', text)
  }
  return undefined
}

function build(match: RegExpExecArray, style: 'long' | 'compact', raw: string): E2ParsedTime | undefined {
  const [, year, month, day, hour, minute, second] = match
  const parts = {
    year: Number(year),
    month: Number(month) - 1,
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second)
  }
  const date = new Date(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  )
  if (Number.isNaN(date.getTime())) return undefined

  /**
   * **回读校验**：`new Date(2022, 12, 45, 99, 99, 99)` 不会报错，它会**滚动进位**
   * （13 月 → 次年 1 月、45 日 → 再往后几天）。不回读的话，一个设备写错的日期会被
   * 悄悄变成一个看起来完全正常的时间 —— 那正是"编造一个测量值"。
   */
  if (
    date.getFullYear() !== parts.year ||
    date.getMonth() !== parts.month ||
    date.getDate() !== parts.day ||
    date.getHours() !== parts.hour ||
    date.getMinutes() !== parts.minute ||
    date.getSeconds() !== parts.second
  ) {
    return undefined
  }

  return { ms: date.getTime(), style, offsetKnown: false, raw }
}

// ---------------------------------------------------------------------------
// 告警文件路径
// ---------------------------------------------------------------------------

/** 告警录音默认是**前 5 秒 + 后 5 秒**（两份手册都写明）。 */
export const E2_ALARM_PRE_SECONDS = 5
export const E2_ALARM_POST_SECONDS = 5
export const E2_ALARM_CLIP_SECONDS = E2_ALARM_PRE_SECONDS + E2_ALARM_POST_SECONDS

/**
 * 时频谱图最多 **10 张**（`1.jpg`…`10.jpg`）—— **只有 2023 版听诊盒子**是这样。
 *
 * 上限而不是保证：手册说设备重启后告警前的数据可能不足 5 秒、图也可能少于 10 张，
 * 而且**那是正常**。所以这一层给出上限与文件名规则，下载端按"能下几张下几张"处理。
 */
export const E2_SPECTROGRAM_COUNT = 10

/**
 * Air Sonar V3.2 的告警图是 PTZ 相机的**抓图**，固定 **3 张**（`1.jpg`…`3.jpg`）。
 *
 * 与上一条不是"数量不同"，是**东西不同**：那 10 张是声学时频谱图，这 3 张是可见光抓图，
 * 而且要 PTZ 相机信息配对了、抓图开关开着、相机支持抓图才会有。所以界面上的措辞也不同。
 */
export const E2_AIR_SONAR_SNAPSHOT_COUNT = 3

/** Air Sonar 的录音文件名**固定**是 `alarm.wav`（2023 版是 `audio_name` 给的时间戳名）。 */
export const E2_AIR_SONAR_AUDIO_NAME = 'alarm.wav'

/** 手册让**客户端**每 50 秒给实时流的 WebSocket 发一次心跳（内容不限）。 */
export const E2_STREAM_HEARTBEAT_SECONDS = 50

/** 设备只保留 **5000** 条告警记录，超出时删最早的**文件**并把那条的 `files_status` 置 0。 */
export const E2_ALARM_LOG_RETENTION = 5000

/** `saving_path` + 文件名 → `file_path` 查询参数（手册要求两者都在）。 */
export function e2FilePath(savingPath: unknown, fileName: unknown): string | undefined {
  const folder = typeof savingPath === 'string' ? savingPath.trim() : ''
  const name = typeof fileName === 'string' ? fileName.trim() : ''
  if (folder === '' || name === '') return undefined
  // 手册的示例里 saving_path 自带尾斜杠（`20220416_075133/`），但不保证；补齐一次即可。
  const normalized = folder.endsWith('/') ? folder : `${folder}/`
  return `${normalized}${name}`
}

/** 第 n 张时频谱图在这一条告警的文件名（`n` 从 1 开始）。 */
export function e2SpectrogramName(index: number): string {
  return `${index}.jpg`
}

/** 一条告警可能的时频谱图文件名（1..10）。 */
export function e2SpectrogramNames(): string[] {
  return Array.from({ length: E2_SPECTROGRAM_COUNT }, (_, index) => e2SpectrogramName(index + 1))
}

/** Air Sonar 的告警抓图文件名（`1.jpg`…`3.jpg`）。 */
export function e2AirSonarSnapshotNames(): string[] {
  return Array.from(
    { length: E2_AIR_SONAR_SNAPSHOT_COUNT },
    (_, index) => e2SpectrogramName(index + 1)
  )
}

// ---------------------------------------------------------------------------
// 回调（**这一轮不实现接收端**，但把手册写明的形状记在这里，免得下一轮再翻文档）
// ---------------------------------------------------------------------------

/**
 * 设备主动 POST 到 `notify_url` 的四种消息。
 *
 * ⚠️ 上一轮（`docs/Ivms4200-UX-REFERENCE.md` §15.22.4）写着"回调体格式手册未说明" ——
 * 那句只对 2024 年 3 月那份 FA110 文档成立；同族的这份 API 文档把四种消息都写全了。
 */
export const E2_CALLBACK_MESSAGE_TYPES = {
  /** 告警：`message_type` 为 `alarm_msg`，字段见 15.27 的表。 */
  alarm: 'alarm_msg',
  /** 告警文件保存完成：**参数表写 `alarm_files_save_report`，示例写 `wav_save_report`**，两个都收。 */
  filesSaved: 'alarm_files_save_report',
  filesSavedAlias: 'wav_save_report',
  /** 每秒一次的计算结果。2023 版叫 `fft_data`（带定长 4096 的 `fft_array`），Air Sonar 叫 `realtime_value`（`max_db_chn`/`max_db_value`/`max_fdr_value`/`max_tdr_value`）。 */
  fft: 'fft_data',
  realtimeValue: 'realtime_value',
  /** 定时心跳。 */
  heartbeat: 'heart_beat_message'
} as const

/** 回调 `message_type` 收窄（含手册内部不一致的那个别名）。 */
export function isE2CallbackType(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return Object.values(E2_CALLBACK_MESSAGE_TYPES).includes(
    value as (typeof E2_CALLBACK_MESSAGE_TYPES)[keyof typeof E2_CALLBACK_MESSAGE_TYPES]
  )
}
