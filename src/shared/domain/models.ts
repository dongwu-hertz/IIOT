/**
 * Domain models — the STABLE contract between Main Process services and the Vue UI.
 *
 * Hard rule (spec section 7, appendix C rule 2):
 *   Protocol DTO  ->  Mapper  ->  Domain Model  ->  Store  ->  UI
 *
 * Nothing in this file may mirror a firmware wire name. If the FA8 protocol
 * says `hp_spl`, the DTO holds `hp_spl` and the mapper produces `spl`.
 * Consequence: a firmware rename changes only the DTO + mapper, never the UI.
 */

/**
 * 等级是事件中心与告警共用的同一套取值，定义在 `event-center.ts`。
 *
 * 这里**只导入类型**（`import type`），所以运行时不会形成环：`event-center.ts` 反向
 * 依赖本文件的 `isRecordingContainerFormat`（值），而类型导入在编译后会被完全擦除。
 */
import type { EventSeverity } from './event-center'
/**
 * 听诊盒子族的两代协议（`auscultation` / `airSonar`）定义在 `e2.ts`：那一层同时带着
 * 端点表与判据。这里**只导入类型** —— `e2.ts` 不反向依赖本文件，所以运行时没有环。
 */
import type { E2Variant } from './e2'
import type { DeviceIngestPlan } from './iot-ingest'

// ---------------------------------------------------------------------------
// Device identity & connection
// ---------------------------------------------------------------------------

/**
 * How the Manager reaches a device.
 * V1 implements `LAN`; `REMOTE` is reserved for the future Server mode
 * (spec section 15) and must remain a first-class value so that no UI code
 * ever assumes a local IP exists.
 */
export type ConnectionType = 'LAN' | 'REMOTE'

export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'UNKNOWN'

/**
 * Pushed from the main process whenever a device's reachability changes.
 * The renderer subscribes via `window.events.onDeviceStatus`.
 */
export interface DeviceStatusEvent {
  deviceId: string
  status: DeviceStatus
  lastSeen?: number
}

/**
 * Which product family a device belongs to.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT COSMETIC
 * The families do not share an identity source or an endpoint vocabulary:
 *
 *   - **Acoustic box** (AE08/FA8): answers `GET /get_devinfo` with a Device ID/SN,
 *     which is what `Device.deviceUid` is derived from; it then exposes channels,
 *     alarm profiles and the `/features_stream` family.
 *   - **Acoustic camera** (FA371): its open interface has NO device-info endpoint
 *     at all (`docs/reference/FA371-api-spec.md` §6 — the manual documents 32
 *     endpoints and identity/version readout is not one of them). It speaks
 *     `/system/*`, `/run_mode`, `/alarm_strategy`, `/alarm_condition` and the
 *     `/turn_on_detect` detection workflow instead, and it has no channels.
 *   - **Auscultation box** (E2 / FA100 / FA110): a third protocol. It has
 *     `GET /basic` (so identity and version ARE readable, unlike the camera) but
 *     **no channel table at all** — the product is single-channel by design
 *     (manual: PCM FLOAT, channel count 1), and commands authenticate with a
 *     `POST /login` token rather than the box's session strategies.
 *
 * Every code path that says "ask the device who it is" or "read its channels"
 * therefore has to branch on this. Guessing (e.g. calling `/get_devinfo` on a
 * camera or an auscultation box) fails as "offline", which is the most misleading
 * possible symptom.
 *
 * The union members ARE the `domain.deviceKind.*` catalogue keys, so the renderer
 * needs no lookup table to display them.
 */
export type DeviceKind = 'acousticBox' | 'acousticCamera' | 'auscultationBox'

/**
 * Runtime list of every kind, for validating a value that arrived over IPC (or
 * from an older database) and for iterating catalogue keys in tests.
 */
export const DEVICE_KINDS: readonly DeviceKind[] = [
  'acousticBox',
  'acousticCamera',
  'auscultationBox'
]

/** Narrowing guard for values crossing the IPC or database boundary. */
export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === 'string' && (DEVICE_KINDS as readonly string[]).includes(value)
}

export interface Device {
  /** Local primary key. */
  id: string
  /**
   * Stable device identity (spec section 6, rule "IP is not a device identity").
   * Prefers firmware Device ID / SN; falls back to MAC while the protocol does
   * not expose an SN. This is what de-duplicates a device whose IP changed.
   *
   * For an `acousticCamera` this CANNOT come from the device — see `DeviceKind`
   * and `cameraDeviceUid()`.
   */
  deviceUid: string
  /** Product family. Determines which protocol client and UI the device gets. */
  kind: DeviceKind
  name: string
  /** Connection address. Meaningful only when connectionType === 'LAN'. */
  ip?: string
  httpPort?: number
  mac?: string
  connectionType: ConnectionType
  firmwareVersion?: string
  fpgaVersion?: string
  webVersion?: string
  status: DeviceStatus
  /** Epoch ms of the last successful contact. */
  lastSeen?: number
  /** 安装信息（见 `DeviceInstallation`）：点位 / 朝向 / 基准分贝。 */
  installation?: DeviceInstallation
  /**
   * 听诊盒子族**是哪一代**（`auscultation` = 2023 版听诊盒子，`airSonar` = SN-16 空气声呐）。
   *
   * **只有这一族有**，别的机型恒缺席。判据是设备 `/system` 的回话内容
   * （`detectE2Variant()`），**不按型号名猜**，也不让用户选。
   *
   * 为什么记在设备行上而不是每次现问设备：它决定的是**这一族给不给 PTZ 配置页**
   * （空气声呐与球机联动，2023 版没有这个概念），而设备详情页的页签必须**同步**地选出
   * 那一组；现问一次设备意味着页签会先渲染错、再变一次。缺席 = 还没读到过（不是"2023 版"）。
   */
  e2Variant?: E2Variant
  /**
   * **接入方案**（业主 2026-09-19 第 13 批第 3、4 条）：这台设备用哪种协议把数据推进来
   * （`none` / `http` / `mqtt`），以及它会推哪些遥测值（数据流接口的四个指标 ← 键，
   * 视频流接口的那一个键）。
   *
   * 可选：旧库里的行没有它（读出时由 `normaliseDeviceIngestPlan()` 补成出厂方案），
   * 而设备表、设备详情、悬停卡片都不需要它 —— 只有"添加/编辑设备"那个对话框与
   * 接入同步（决定本机要不要开监听）读它。
   *
   * **不含秘钥**：秘钥仍然只在 `devices.ingestEndpoint(id)` 那一条路上出现（v15 的口径）。
   */
  ingest?: DeviceIngestPlan
  createdAt: number
  updatedAt: number
}

/**
 * 安装信息（业主 2026-09-17 第 1 条）—— **声源定位设备**（Air Sonar / SN-16）装在哪、
 * 朝哪边、现场基准多少分贝。
 *
 * 三项都是**我们的数据模型**（手册里没有这套字段：设备的 `/system` 只给参数，不给位置），
 * 所以口径写在这里，不留给人猜：
 *   - `gisLatitude` / `gisLongitude`：**WGS84 十进制度**（不是度分秒、不是投影坐标）。
 *     地图/GIS 工具之间最通用的交换形式，也便于直接粘进坐标拾取器核对。
 *   - `azimuthDeg`：**罗盘方位角**，0 = 正北、顺时针为正、范围 `[0, 360)`。
 *     与 SN-16 报的 `horizontal`（声源方位）**同向**，两者才能直接比较。
 *   - `soundLevelDb`：**该点位的基准声压级**（dB）。用来与设备报的 `db_value` 对照；
 *     它**不是**告警门限 —— 门限在设备端的 `db_limit` 参数里。
 *
 * 全部可空：其他机型不填，界面显示「—」。
 */
export interface DeviceInstallation {
  gisLatitude?: number
  gisLongitude?: number
  azimuthDeg?: number
  soundLevelDb?: number
}

/** 安装信息的取值范围（界面与主进程共用同一套判据，见 `device-installation.ts`）。 */
export const DEVICE_INSTALLATION_LIMITS = {
  latitudeMin: -90,
  latitudeMax: 90,
  longitudeMin: -180,
  longitudeMax: 180,
  azimuthMin: 0,
  azimuthMax: 360,
  soundLevelMin: -50,
  soundLevelMax: 200
} as const

/** Version + identity block read from `GET /get_devinfo`. */
export interface DeviceInfo {
  deviceUid: string
  name: string
  mac?: string
  firmwareVersion?: string
  fpgaVersion?: string
  webVersion?: string
  channelCount: number
}

/** Values the user supplies when adding a device (spec section 6.2). */
export interface AddDeviceInput {
  ip: string
  httpPort: number
  username: string
  password: string
  /**
   * Which family is being added.
   *
   * Optional so that every existing caller and test keeps working, and because
   * an acoustic box was the only possibility before the camera existed; the main
   * process normalises it with `normaliseDeviceKind()` in exactly one place.
   */
  kind?: DeviceKind
  /** Optional user-chosen label; falls back to the device-reported name. */
  name?: string
  /**
   * 安装信息（点位 / 朝向 / 基准分贝）。**可选，且与机型无关**：声源定位设备要填，
   * 其他机型留空。校验规则见 `@shared/domain/device-installation`。
   */
  installation?: DeviceInstallation
  /**
   * 接入方案（业主 2026-09-19 第 13 批第 3、4 条）。
   *
   * 添加设备时一起定下来（选 HTTP / MQTT + 声明这台设备会推哪些遥测值）。
   * **省略 = 不动这一项**（与 `installation` 同一条规矩）：重新添加一台已知设备只是刷新地址，
   * 不该把已配好的协议与键抹回出厂值。
   */
  ingest?: DeviceIngestPlan
}

export interface UpdateDeviceInput {
  id: string
  name?: string
  ip?: string
  httpPort?: number
  /**
   * 设备侧的登录凭据（业主 2026-09-18 第 10 条：编辑设备时用户名与密码都要能改）。
   *
   * **省略 = 不动这一项**（与 `installation` 同一条规矩）：界面上的密码框是空的
   * （我们从不回显口令），空框必须读成"不改"，否则每保存一次别的字段就会把口令清掉。
   * `username` 给了就必须非空（设备侧没有匿名账号）。
   */
  username?: string
  password?: string
  /** 安装信息：**部分更新**（`undefined` = 不动这一项，`null` = 清空这一项）。 */
  installation?: Partial<Record<keyof DeviceInstallation, number | null>>
  /** 接入方案：**省略 = 不动这一项**（见 `AddDeviceInput.ingest`）。 */
  ingest?: DeviceIngestPlan
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** spec 11.1: Sensor Type 0 = Microphone, 1 = Conduction. */
export enum SensorType {
  Microphone = 0,
  Conduction = 1
}

/**
 * Stable identifiers for sensor types, matching the `domain.sensorType.*`
 * catalogue keys.
 *
 * There is deliberately NO `*_LABELS` map in the shared layer any more: a Chinese
 * map here would be unusable in an English, Spanish or Turkish UI, and keeping one
 * alive invites a page to import it instead of the catalogue. The renderer
 * translates these keys in `@renderer/lib/labels`.
 */
export const SENSOR_TYPE_KEYS: Record<SensorType, string> = {
  [SensorType.Microphone]: 'microphone',
  [SensorType.Conduction]: 'conduction'
}

/** Channel indices are fixed 0-7 in the FA8 protocol, but stored as `channelIndex`. */
export const CHANNEL_COUNT = 8

export interface Channel {
  id: string
  deviceId: string
  /** 0-7 */
  channelIndex: number
  channelName: string
  sensorType: SensorType
  enabled: boolean
  /** FK to AlarmProfile, when the firmware binds a profile to this channel. */
  alarmProfileId?: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Alarm profiles
// ---------------------------------------------------------------------------

export type DetectionType = 'Characteristic' | 'AI'

/** Stable identifiers, matching the `domain.detectionMode.*` catalogue keys. */
export const DETECTION_TYPE_KEYS: Record<DetectionType, string> = {
  Characteristic: 'characteristic',
  AI: 'ai'
}

/**
 * Alarm profile. Presentation uses friendly names only — the firmware variable
 * names (`dalFBETThre` and friends) live exclusively in `configJson` (spec 11.3).
 */
export interface AlarmProfile {
  id: string
  deviceId: string
  /** Device-side alarm parameter id, needed for /del_alarm_system. */
  remoteAlarmId?: number
  name: string
  detectionType: DetectionType
  /** Raw complex protocol parameters, kept opaque to the UI. */
  configJson: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Realtime monitoring
// ---------------------------------------------------------------------------

/**
 * Normalised realtime feature frame (spec 9.2).
 *
 * Firmware field mapping (see protocol/mappers):
 *   sound_pressure_level -> spl
 *   main_freq            -> mainFrequency
 *   smoothness           -> smoothness
 *   freq_band_energy_ratio -> bandEnergyRatio
 *   hr_f                 -> oddEvenHarmonicRatio
 *   sc_f                 -> spectralComplexity
 *   sv_f                 -> fingerprintVariation
 */
export interface RealtimeFeature {
  deviceId: string
  channelId: number
  timestamp: number
  spl: number
  mainFrequency: number
  smoothness: number
  bandEnergyRatio: number
  oddEvenHarmonicRatio?: number
  spectralComplexity?: number
  fingerprintVariation?: number
}

/** Connection state of a realtime stream, surfaced in the UI header. */
export type StreamState = 'IDLE' | 'CONNECTING' | 'STREAMING' | 'RECONNECTING' | 'STOPPED' | 'ERROR'

export interface StreamStatus {
  state: StreamState
  /** Consecutive failed reconnect attempts; 0 while healthy. */
  retries: number
  lastFrameAt?: number
  lastError?: string
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

/**
 * Alarm bit mask mapping (spec appendix B).
 * Bit0..Bit13, physical/acoustic anomaly taxonomy.
 */
export enum AlarmType {
  SPL = 0,
  MainFrequency = 1,
  BandEnergyRatio = 2,
  Smoothness = 3,
  ClampLooseness = 4,
  CoolerAnomalyA = 5,
  CoolerAnomalyB = 6,
  Overload = 7,
  ShortCircuitSurge = 8,
  SurfaceDischarge = 9,
  CoronaDischarge = 10,
  GapDischarge = 11,
  FloatingDischarge = 12,
  DCBias = 13
}

export const ALARM_TYPE_KEYS: Record<AlarmType, string> = {
  [AlarmType.SPL]: 'spl',
  [AlarmType.MainFrequency]: 'main_frequency',
  [AlarmType.BandEnergyRatio]: 'band_energy_ratio',
  [AlarmType.Smoothness]: 'smoothness',
  [AlarmType.ClampLooseness]: 'clamp_looseness',
  [AlarmType.CoolerAnomalyA]: 'cooler_anomaly_a',
  [AlarmType.CoolerAnomalyB]: 'cooler_anomaly_b',
  [AlarmType.Overload]: 'overload',
  [AlarmType.ShortCircuitSurge]: 'short_circuit_surge',
  [AlarmType.SurfaceDischarge]: 'surface_discharge',
  [AlarmType.CoronaDischarge]: 'corona_discharge',
  [AlarmType.GapDischarge]: 'gap_discharge',
  [AlarmType.FloatingDischarge]: 'floating_discharge',
  [AlarmType.DCBias]: 'dc_bias'
}

/**
 * 这条告警是**哪一套协议**报上来的。
 *
 * 为什么需要这一列（而不是"看设备类型就知道"）：两族的告警载荷**不是同一套词汇**。
 * FA8 给的是 14 位故障位图（`alarm_mask`，我们能解、能分级）；听诊盒子族给的是
 * `alarm_value`（手册只列了 6 个十六进制值）**加**一段自由文本 `alarm_reasons`。
 * 把后者的数字写进 `alarm_mask`，`decodeAlarmMask()` 会解出设备从未报过的故障类型，
 * 而 `deriveAlarmSeverity()` 会据此给出一个**编造的严重等级**。所以两套分开存。
 */
export type AlarmSource = 'fa8' | 'e2'

export const ALARM_SOURCES: readonly AlarmSource[] = ['fa8', 'e2']

/** 收窄来自 IPC / 数据库边界的取值。 */
export function isAlarmSource(value: unknown): value is AlarmSource {
  return typeof value === 'string' && (ALARM_SOURCES as readonly string[]).includes(value)
}

/**
 * Normalised alarm event (spec 10.2).
 * `alarmMask` is preserved verbatim so nothing is lost in translation;
 * `alarmTypes` is the decoded, UI-ready view of that mask.
 */
export interface AlarmEvent {
  id: string
  deviceId: string
  channelId: number
  timestamp: number
  /** 哪一套协议报的（见 `AlarmSource`）。旧行按 `'fa8'` 处理（迁移里回填过）。 */
  source: AlarmSource
  /** FA8 的 14 位故障位图。**听诊盒子族的行恒为 0**（它的数字在 `deviceAlarmValue` 里）。 */
  alarmMask: number
  alarmTypes: AlarmType[]
  spl?: number
  mainFrequency?: number
  smoothness?: number
  bandEnergyRatio?: number
  /** Device-side audio path, if the firmware reported one. */
  remoteAudioPath?: string
  /** Local recording produced by the Ring Buffer, if pre/post capture was armed. */
  localRecordingId?: string
  /**
   * 听诊盒子族原始的 `alarm_value`。
   *
   * 它**不是** `alarmMask`：手册说它是"每一位代表一个键值"的十六进制数，而**只列出了 6 个值**，
   * 且与 FA8 的 14 位分类法毫无关系。原样存下来（界面能显示它、能按已知的 6 位解释），
   * 但**不**参与故障类型解码与等级判定。
   */
  deviceAlarmValue?: number
  /**
   * 设备自己给的告警原因**文本**（听诊盒子族的 `alarm_reasons`，例："时域能量比超限，"）。
   *
   * 这是设备自己的措辞，原样保存：手册那 8 条清单里有一条重复、而且明确不是全集
   * （见 `docs/Ivms4200-UX-REFERENCE.md` §15.23.3），所以我们不把它映射成我们的枚举。
   */
  deviceReason?: string
  /**
   * 设备上那个告警文件**还在不在**（听诊盒子族的 `files_status`：1 在 / 0 已被保留策略清掉）。
   *
   * `undefined` 表示"这套协议不报这个字段"（FA8 就没有），**不是**"文件没了"。
   */
  filesStatus?: number
  /**
   * 设备原始载荷（JSON 字符串）。
   *
   * 三种模式的日志字段集合不同（`tde_ratio`/`fde_ratio`/`hpss`/`sc_ratio`/`oeh_ratio`…），
   * 给每个键开一列既臃肿又会把固件可以自由改的形状冻死。这一列保证**什么都不丢**。
   */
  deviceRaw?: string
  /**
   * 本机存这条告警**抓图**的目录（**存储根相对**路径，与 `recordings.relativePath` 同一条规矩）。
   *
   * SN-16 空气声呐每次告警带 3 张**球机抓图**（`1.jpg`…`3.jpg`，1 秒一张），2023 版听诊盒子
   * 带的是 10 张时频谱图 —— 两者都存在这个目录里，所以这一列在界面上叫「抓图」。
   *
   * `undefined` = 这条告警**没有图**（设备上本来就没有、或同步时没下）。它与
   * "有目录但文件被删了"是两件事：前者是设备事实，后者是本机事实，界面分开说。
   */
  snapshotDir?: string
  /**
   * 这条告警的等级，**入库时按位图算好并快照**（`deriveAlarmSeverity()`）。
   *
   * 为什么是必填而不是可选：`'unknown'` 本身就是一个有意义的取值（它表示"我们没判"），
   * 与"这个字段没人填"是两件事。做成可选会让读侧分不清这两种情况，而 v6 之前的旧行
   * 恰好都是 `'unknown'`——它们真的没被判过等级，不是字段缺失。
   *
   * 出处：等级划分是**本仓库自己的设计**，iVMS-4200 手册全书无此概念，设备侧也不给
   * （见 `alarm-mask.ts` 的 `ALARM_SEVERITY_BY_TYPE` 与文档 §15.5/§15.6）。
   * 听诊盒子族的行**恒为 `'unknown'`**：那套位表只有 6 个值、没有轻重之分，
   * 我们不为它发明等级。
   */
  severity: EventSeverity
  /** 操作员写的备注，最长 500 字符（`schema.ts` v6 的 CHECK）。 */
  note?: string
  acknowledged: boolean
  createdAt: number
}

export interface AlarmQuery {
  deviceId?: string
  channelId?: number
  alarmType?: AlarmType
  /** 只看某一档等级（v6 起可按等级筛选）。 */
  severity?: EventSeverity
  /** 只看某一套协议报的告警（v9 起）。 */
  source?: AlarmSource
  /** Inclusive epoch ms bounds. */
  from?: number
  to?: number
  acknowledged?: boolean
  limit?: number
  offset?: number
}

/**
 * 备注的长度上限。
 *
 * 放在域模型而不是主进程仓库里：**渲染层要用它**（在输入框上限制长度、并给出「最多 N 字」
 * 的可读提示），而渲染层不能导入 `src/main/**`。schema v6 的 CHECK 是同一个数字——
 * 刻意重复的那一处是 SQL（它必须能拦住绕过代码的写入），不是第二个 TypeScript 常量。
 */
export const ALARM_NOTE_MAX_LENGTH = 500

export interface AlarmPage {
  items: AlarmEvent[]
  total: number
  limit: number
  offset: number
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

/**
 * Recording kinds. The union members ARE the catalogue keys, so
 * `domain.recordingType.<value>` needs no lookup table — and, like the other
 * domain labels, there is no Chinese `*_LABELS` map here to import by mistake.
 */
export type RecordingType = 'alarm' | 'manual' | 'scheduled'

/**
 * Runtime list of the union above, for validating values that arrive over IPC.
 * Kept next to the type so the two cannot drift.
 */
export const RECORDING_TYPES: readonly RecordingType[] = ['alarm', 'manual', 'scheduled']

export type AudioFormat = 'wav' | 'flac'

/**
 * What the bytes on disk actually are, independent of whether they carry audio.
 *
 * Separate from `AudioFormat` because a camera's MP4 clip and a photo from the
 * device's detection library are both files this app stores and plays back, and
 * neither has an audio format. `unknown` is a legal value: an unrecognised
 * extension is recorded honestly rather than coerced into a format the app merely
 * hopes for.
 */
export type RecordingContainerFormat =
  | 'wav'
  | 'flac'
  | 'mp4'
  | 'jpg'
  | 'png'
  | 'csv'
  | 'bin'
  | 'nc'
  | 'unknown'

/**
 * Runtime list of the union above. Mirrors the CHECK on
 * `recordings.container_format` (schema migration 5), so a value that would be
 * rejected by SQLite cannot be produced by the renderer either.
 */
export const RECORDING_CONTAINER_FORMATS: readonly RecordingContainerFormat[] = [
  'wav',
  'flac',
  'mp4',
  'jpg',
  'png',
  'csv',
  'bin',
  'nc',
  'unknown'
]

export function isRecordingContainerFormat(value: unknown): value is RecordingContainerFormat {
  return typeof value === 'string' && (RECORDING_CONTAINER_FORMATS as readonly string[]).includes(value)
}

export interface Recording {
  id: string
  deviceId: string
  channelId: number
  recordingType: RecordingType
  eventType?: string
  startTime: number
  endTime?: number
  durationMs?: number
  sampleRate: number
  /**
   * Audio encoding of the file, or `null` when the file is not audio at all —
   * a camera clip or a detection-library image. It is deliberately not
   * `undefined`: the column exists and its value is known to be "none", which is
   * a different statement from "not recorded".
   */
  audioFormat: AudioFormat | null
  /** What the file actually is. Absent on rows written before migration 5. */
  containerFormat?: RecordingContainerFormat
  /** Path relative to the configured storage root — never an absolute path. */
  relativePath: string
  fileSize?: number
  /** Integrity hash, computed when the file is finalised. */
  sha256?: string
  /** Set when the file was mirrored from the device library, not captured live. */
  remoteRecordingId?: string
  createdAt: number
}

/**
 * How to label a recording's format in the UI.
 *
 * Prefers `containerFormat` and falls back to the audio format, because rows
 * written before migration 5 have no container column. Shared rather than
 * renderer-local so the recordings list and the event centre cannot disagree
 * about what the same file is.
 */
export function recordingFormatLabel(recording: Recording): string | null {
  if (recording.containerFormat) return recording.containerFormat.toUpperCase()
  if (recording.audioFormat) return recording.audioFormat.toUpperCase()
  return null
}

export interface RecordingQuery {
  deviceId?: string
  channelId?: number
  recordingType?: RecordingType
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface RecordingPage {
  items: Recording[]
  total: number
  limit: number
  offset: number
}

// ---------------------------------------------------------------------------
// Dashboard aggregates (spec 8.3)
// ---------------------------------------------------------------------------

export interface OverviewStats {
  deviceTotal: number
  deviceOnline: number
  deviceOffline: number
  activeAlarms: number
  todayRecordings: number
}

// ---------------------------------------------------------------------------
// Sample rate (spec 11.2)
// ---------------------------------------------------------------------------

export const SUPPORTED_SAMPLE_RATES = [48000, 96000, 192000] as const
export type SampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number]
