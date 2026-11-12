/**
 * IPC contract — the ONLY surface the renderer may use to reach the outside world.
 *
 * Architectural rule (spec section 3, appendix C rules 3 & 4):
 *   Vue components must never communicate with FA8 devices directly.
 *   All device communications go through DeviceService / DeviceRepository.
 *
 * Channel names are namespaced `domain:action` so the allow-list in preload
 * stays readable and accidental wildcard exposure is obvious in review.
 */

import type { DeviceResult } from '../errors'
import type { MonitorFeatureChannel, StreamKind } from '../domain/monitoring'
import type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkChangeResult,
  NetworkChangeStage,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '../domain/device-config'

/**
 * RE-EXPORTED so the renderer can NAME these types without reaching into
 * `src/main/`.
 *
 * The contract's own method signatures already reference them, so the renderer
 * was forced to import them from the main-process module path — which meant the
 * renderer's TypeScript project had to compile main-process sources, quietly
 * dissolving the process boundary the whole architecture rests on.
 *
 * Exporting the types here keeps the dependency direction one-way:
 * renderer -> shared contract -> (type-only) main view models. No runtime import
 * is created; these are erased at build time.
 */
export type {
  AlarmProfileConfig,
  ChannelConfigView,
  ModbusConfigView,
  NetworkChangeResult,
  NetworkChangeStage,
  NetworkConfigView,
  PushConfigView,
  Rs485ConfigView,
  TimeConfigView
} from '../domain/device-config'

export type {
  TrendAggregation,
  TrendCoverage,
  TrendMetric,
  TrendPoint,
  TrendQueryBody,
  TrendSeries,
  TrendStorageStats
} from '../domain/trend'
export type { TrendExportRequest, TrendExportResult } from '../domain/trend-export'
import type {
  TrendCoverage,
  TrendQueryBody,
  TrendSeries,
  TrendStorageStats
} from '../domain/trend'
import type { TrendExportRequest, TrendExportResult } from '../domain/trend-export'
import type {
  AddDeviceInput,
  AlarmEvent,
  AlarmPage,
  AlarmQuery,
  Channel,
  Device,
  DeviceInfo,
  DeviceKind,
  OverviewStats,
  RecordingPage,
  RecordingQuery,
  UpdateDeviceInput
} from '../domain/models'
import type {
  ChangePasswordInput,
  CopyUserPermissionsInput,
  CreateUserInput,
  LoginInput,
  RecoverAccountInput,
  RememberLoginInput,
  RememberedLoginSnapshot,
  ResetUserPasswordInput,
  SessionInfo,
  UpdateUserPermissionsInput,
  UpdateUserProfileInput,
  UserRole,
  UserSummary
} from '../domain/auth'
/** 样本库的两种"来源"枚举与特征维度标识（定义在域层，这里只用于 IPC 形状）。 */
import type {
  SampleLabelDimension,
  SampleLabelSource,
  SampleSource
} from '../domain/sample-library'
import type { E2Variant, E2WorkMode } from '../domain/e2'
/**
 * PTZ（球机联动）那一组：形状与纯函数都在 `domain/e2-ptz.ts`，契约层只把它们带出去 ——
 * 渲染层与主进程用**同一个** `E2PtzConfig` / `E2PtzPatch` 形状，读回核对的结果也共用一套字段名。
 */
import type {
  E2NvtTimeSyncOutcome,
  E2PtzConfig,
  E2PtzPatch,
  E2PtzUpdateOutcome
} from '../domain/e2-ptz'
/*
 * E2 回调（SN-16 
ealtime_value）的形状与解析都在 domain/e2-callback.ts。
 * 契约层只把它带出去：渲染层订阅推送、设备面板显示状态，用的都是同一份类型。
 */
import type {
  E2RealtimeCallbackOutcome,
  E2RealtimeCallbackStatus,
  E2RealtimeValueEvent
} from '../domain/e2-callback'
import type { TrendMetric } from '../domain/trend'

/**
 * 告警声音库的类型（手册 §17.2.7）。
 *
 * 重新导出，理由与上面的 device-config 视图模型相同：渲染层的 tsconfig 不包含
 * `src/main/`，而声音库的界面要能**命名**「一条声音」「六种预定义类型」。
 */
export type {
  AlarmSoundEntry,
  AlarmSoundLibrary,
  AlarmSoundTypeKey
} from '../domain/alarm-sound'
import type { AlarmSoundLibrary } from '../domain/alarm-sound'

/**
 * 账号权限目录（手册 §17.1）。
 *
 * 同样重新导出：账号管理界面要能**渲染**每一项权限的复选框，而取值是稳定标识
 * （`domain.permission.*` 的键）。`UserPermissionKey` 已经在本文件顶部 import
 * （`UpdateUserPermissionsInput` 的签名用它），所以这里只补 `UserPermissionSet`。
 */
export type { UserPermissionSet } from '../domain/auth'

/**
 * IoT 数据接入（业主 2026-09-19 第 1 条）。
 *
 * 形状与纯规则都在 `@shared/domain/iot-ingest`，契约层只把它带出去：设置页要用**同一份**
 * 配置归一化器校验用户填的端口与绑定地址，设备对话框要用同一个「秘钥 → 推流地址」拼装。
 */
export type {
  DeviceIngestEndpoint,
  IotIngestConfig,
  IotIngestListenerStatus,
  IotIngestLocalAddress,
  IotIngestRuntimeStatus,
  IotIngestStats
} from '../domain/iot-ingest'
import type { IotIngestConfig, IotIngestRuntimeStatus } from '../domain/iot-ingest'
import type { RecorderConfig } from '../domain/recorder-config'

/**
 * 连续录像的设备状态（IPC 形态）。
 *
 * 字段与 `RtspRecorderService.status()` 一一对应，**不做加工**：界面要能说清
 * "在录 / 进程在但没数据 / 断了在等重连"，这三件事的差别就是排障的全部线索。
 */
export interface RecorderStatusView {
  deviceId: string
  enabled: boolean
  state: 'starting' | 'recording' | 'waiting' | 'backoff' | 'stopped'
  segmentSeconds: number
  runStartedAt?: number
  lastGrowthAt?: number
  lastSegment?: { name: string; startMs: number; endMs: number; bytes: number }
  registeredCount: number
  attempt: number
  lastError?: string
}

export interface RecorderSetEnabledInput {
  deviceId: string
  enabled: boolean
  /** 只改切片长度时也可以带上；不传则沿用当前设置。 */
  segmentSeconds?: number
}
import type { DeviceIngestEndpoint } from '../domain/iot-ingest'

/**
 * 在线地图底图（业主 2026-09-19 追加第 1 条；**手册未说明**）。
 *
 * 形状与纯规则在 `@shared/domain/map-tiles`：XYZ 模板、只允许 https、可选 key/子域、
 * 时区→中心、缩放 2–18。设置页与地图页引用同一份判据，契约层只负责把它带过 IPC。
 */
import type {
  MapServiceEntry,
  MapTilesConfig,
  MapTileServiceId,
  TileCacheBounds
} from '../domain/map-tiles'
import type { AiServicePresetId } from '../domain/sample-ai'

/**
 * Result of a successful login.
 *
 * `mustChangePassword` rides alongside the session rather than inside
 * `UserSummary` alone, because the login screen needs it as an INSTRUCTION ("now
 * change this password") and not merely as a property to display.
 */
export interface LoginOutcome {
  session: SessionInfo
  mustChangePassword: boolean
}

// ---------------------------------------------------------------------------
// Channel names
// ---------------------------------------------------------------------------

export const IpcChannels = {
  // App / settings
  APP_GET_INFO: 'app:get-info',
  /**
   * 渲染层上报当前界面语言（2026-09-23 告警弹窗文案修复）。
   *
   * 主进程需要它的唯一场景：联动弹窗的文案要在主进程渲染（弹窗窗口不加载应用
   * shell，拿不到 vue-i18n）。语言的唯一权威仍是渲染层（`useLocale`），这里是
   * 单向镜像；切换语言时会再报一次。
   */
  APP_SET_LOCALE: 'app:set-locale',
  /**
   * Operating-system UI languages, most preferred first.
   *
   * Exists for first-launch language detection. Electron's `app.getLocale()`
   * reports the OS setting, whereas the renderer's `navigator.language` reports
   * the Chromium bundle's own setting and can disagree with it — so the renderer
   * asks the main process rather than guessing.
   */
  APP_GET_PREFERRED_LANGUAGES: 'app:get-preferred-languages',
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_PICK_STORAGE_DIR: 'settings:pick-storage-dir',
  SETTINGS_DISK_USAGE: 'settings:disk-usage',
  /**
   * 「恢复默认值」（手册 §17.2 第 5227 行）。
   *
   * 单独一条通道，而不是让渲染层发一个「每个键都填默认值」的 patch：那样
   * **恢复的范围就由渲染层决定**了，而这件事必须只有一处定义
   * （`SettingsService.RESTORABLE_SETTING_KEYS`）。这条通道也不接受任何入参，
   * 所以它不可能被用来写别的键。
   *
   * 要求管理员：它会覆盖整页系统设置，与 `SETTINGS_UPDATE` 同一张判定表。
   */
  SETTINGS_RESTORE_DEFAULTS: 'settings:restore-defaults',
  /**
   * 为告警声音库挑一个本地音频文件（手册 §17.2.7 第 3 步的图标）。
   *
   * 对话框的过滤器**只放 `.wav`**（手册第 5448 行：The format of the audio file
   * can only be *wav），但过滤器不是校验：用户在「全部文件」里仍然能选中别的格式，
   * 所以主进程在这里、`SettingsService` 的归一化器里、以及界面上**三处**都按
   * 扩展名判一次。返回 `null` = 用户取消。
   */
  SETTINGS_PICK_ALARM_SOUND: 'settings:pick-alarm-sound',

  /**
   * 瓦片缓存下载（业主 20260921 批：设置里选服务 + 缩放级别范围 + 经纬度区域，
   * 把瓦片下载到存储根 `map-cache/<service>/z/x/y.png`，离线复用）。
   *
   * 写操作（写存储根、主动出网下载），权限与 `settings:update` 同档：管理员 +
   * `manageSystemSettings`。进度经 `PushChannels.MAP_CACHE_PROGRESS` 推送。
   */
  MAP_CACHE_TILES: 'map:cache-tiles',

  /**
   * IoT 数据接入的运行状态（业主 2026-09-19 第 1 条）。
   *
   * 它**不是**设置里那块配置的副本：配置走 `SETTINGS_GET` / `SETTINGS_UPDATE`
   * （`iotIngest` 那一个键），这里回的是**监听事实**与**收数统计** ——
   * 「开着吗 / 有人连吗 / 收的东西认出来了吗」这三件事在设置表里没有答案。
   */
  IOT_INGEST_STATUS: 'iot-ingest:status',

  /**
   * Application accounts (the software's own login, not a device's).
   *
   * The session is held by the MAIN process; the renderer's copy exists only so
   * the UI can render the right controls. Every privileged handler re-checks the
   * role here rather than trusting anything the renderer sends.
   */
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_SESSION: 'auth:session',
  /**
   * 「记住上次的用户名 / 记住密码」（业主 2026-09-16）。
   *
   * 三个通道都在**登录之前**可用（与 `AUTH_LOGIN` / `AUTH_RECOVER` 同一类：登录页要能被
   * 渲染、被预填，那时还没有会话）。名字与密码存在 `app_meta` 里，密码用 `safeStorage`
   * 加密 —— 与设备凭据同一条 spec 14.1 规则，不写明文。
   */
  AUTH_REMEMBERED_LOGIN: 'auth:remembered-login',
  AUTH_REMEMBER_LOGIN: 'auth:remember-login',
  AUTH_FORGET_REMEMBERED_LOGIN: 'auth:forget-remembered-login',
  AUTH_CHANGE_PASSWORD: 'auth:change-password',
  AUTH_RECOVER: 'auth:recover',
  AUTH_LIST_USERS: 'auth:list-users',
  AUTH_CREATE_USER: 'auth:create-user',
  AUTH_DELETE_USER: 'auth:delete-user',
  AUTH_RESET_PASSWORD: 'auth:reset-password',
  AUTH_SET_ROLE: 'auth:set-role',
  /**
   * 逐项勾选地改一个账户的权限（手册 §17.1 的复选框 / Default Permission）。
   *
   * 与 `AUTH_SET_ROLE` 分开：那一个改的是角色（管理员/操作员），这一个在该角色
   * 允许的范围内改细粒度授权。混成一个通道会让「把操作员提成管理员」与
   * 「给操作员多勾一项」在界面上无法分辨，而它们的影响面完全不同。
   */
  AUTH_SET_PERMISSIONS: 'auth:set-permissions',
  /** 「从…复制权限」（手册 §17.1 第 5 步的 Copy from 下拉框）。 */
  AUTH_COPY_PERMISSIONS: 'auth:copy-permissions',
  /**
   * 改一个账户的显示名称（手册 §17.1 的 Edit User）。
   *
   * 单独一条通道，而不是把它并进 `AUTH_CREATE_USER` 或 `AUTH_SET_ROLE`：用户名是
   * 身份、角色是授权，而显示名只是**标签** —— 三者的校验与失败模式都不一样
   * （用户名有字符集与唯一性约束、角色有「最后一个管理员」约束、显示名两者都没有）。
   */
  AUTH_UPDATE_PROFILE: 'auth:update-profile',
  /** Public: the login screen shows it so support can issue a recovery code. */
  AUTH_INSTALL_ID: 'auth:install-id',

  // Device lifecycle
  DEVICE_LIST: 'device:list',
  DEVICE_GET: 'device:get',
  DEVICE_ADD: 'device:add',
  DEVICE_UPDATE: 'device:update',
  DEVICE_REMOVE: 'device:remove',
  DEVICE_PROBE: 'device:probe',
  DEVICE_REFRESH_STATUS: 'device:refresh-status',
  DEVICE_GET_INFO: 'device:get-info',
  DEVICE_GET_CHANNELS: 'device:get-channels',
  DEVICE_OPEN_WEB_UI: 'device:open-web-ui',
  /**
   * 这台设备的**推流地址与秘钥**（业主 2026-09-18 第 10 批第 5 条：「添加设备支持
   * HTTP 推流（秘钥 + 推流地址）」）。
   *
   * 与 `DEVICE_GET` 分开是有意的：秘钥**不随设备列表走**（见 `DeviceRow.push_secret` 的
   * 说明），而"谁在什么时候要看秘钥"只有这个对话框知道。第一次读的时候会自动生成一条
   * （写库 + 读回核对），所以这个动作**可能写库**。
   */
  DEVICE_INGEST_ENDPOINT: 'device:ingest-endpoint',
  /**
   * 轮换这台设备的推流秘钥：**旧秘钥立刻失效**（设备要用新秘钥重新配置才会再推上来）。
   *
   * 单独一个通道而不是 `DEVICE_UPDATE` 的一个字段：轮换是一次明确的**凭据变更**，
   * 它必须有自己的一句话（界面上是一次确认），而且与改名/改端口这些编辑动作的失败模式
   * 完全不同。
   */
  DEVICE_ROTATE_PUSH_SECRET: 'device:rotate-push-secret',

  /**
   * Open an external URL in the system browser.
   *
   * Necessary because the renderer's CSP is `default-src 'self'`, which blocks
   * navigation to an external site, and because routing that through the main
   * process means the renderer never needs the ability to open arbitrary URLs
   * itself. The main process validates the scheme against an allow-list.
   */
  APP_OPEN_EXTERNAL: 'app:open-external',

  // Dashboard
  OVERVIEW_STATS: 'overview:stats',
  OVERVIEW_RECENT_ALARMS: 'overview:recent-alarms',

  // Alarms
  ALARM_QUERY: 'alarm:query',  ALARM_ACKNOWLEDGE: 'alarm:acknowledge',
  /**
   * v6 起：告警可以带一条操作员备注和一个等级。
   *
   * 三个通道而不是"一个 update"：改备注、改等级、取分面计数是三件独立的事，合成一个
   * 通用 update 会让权限与校验都变得含糊（备注有 500 字符上限，等级有取值枚举）。
   */
  ALARM_SET_NOTE: 'alarm:set-note',
  ALARM_SET_SEVERITY: 'alarm:set-severity',
  ALARM_COUNT_BY_SEVERITY: 'alarm:count-by-severity',

  // Recordings
  RECORDING_QUERY: 'recording:query',
  RECORDING_SYNC_DEVICE: 'recording:sync-device',
  /** 另存一条本机录音（保存对话框 + 复制文件）。权限 `viewRecordings`。 */
  RECORDING_EXPORT: 'recording:export',
  /**
   * 连续录像（RTSP 取流存储，业主 2026-09-26 追加范围）。
   *
   * 两个通道都归 `controlCameras`：开启连续录像会让相机**再多一条 RTSP 连接**
   * （实测 `rtsp_client_limit` 有限），这是对设备做动作，不是读状态。
   * 状态查询本身只读，但保持一致更省事 —— 界面上的开关与状态行本来就成对出现。
   */
  RECORDER_STATUS: 'recorder:status',
  RECORDER_SET_ENABLED: 'recorder:set-enabled',
  /**
   * 本地样本库（schema v7）。权限归 `viewRecordings` —— 这个库是从录音派生的，
   * 打标签是对派生物的注解，不动录音本身。
   */
  SAMPLE_QUERY: 'sample:query',
  SAMPLE_STATS: 'sample:stats',
  SAMPLE_ADD_FROM_ALARM: 'sample:add-from-alarm',
  SAMPLE_ADD_FROM_ALARMS: 'sample:add-from-alarms',
  SAMPLE_ADD_FROM_RECORDING: 'sample:add-from-recording',
  SAMPLE_SET_LABEL: 'sample:set-label',
  SAMPLE_REMOVE: 'sample:remove',
  SAMPLE_TRAIN: 'sample:train',
  /**
   * 标签库（两个维度：设备类型 / 故障类型，schema v8）。业主 2026-09-16：「应该有个专门的
   * 功能去做标签的添加和设备类型添加维护」。
   */
  SAMPLE_LABELS_LIST: 'sample:labels-list',
  SAMPLE_LABEL_ADD: 'sample:label-add',
  SAMPLE_LABEL_RENAME: 'sample:label-rename',
  SAMPLE_LABEL_DELETE: 'sample:label-delete',
  SAMPLE_PICK_EXPORT_DIR: 'sample:pick-export-dir',
  SAMPLE_EXPORT_DATASET: 'sample:export-dataset',
  /**
   * 可插拔 AI 标注（业主 2026-09-16）。密钥经 `safeStorage` 加密后落 `app_meta`，
   * **不经过 IPC**；这里的三条通道都归 `viewRecordings`（理由同上面的样本库）。
   */
  SAMPLE_AI_STATUS: 'sample:ai-status',
  SAMPLE_AI_SAVE_CONFIG: 'sample:ai-save-config',
  SAMPLE_AI_LABEL: 'sample:ai-label',
  /**
   * 命名的 AI 服务库（业主追加：设置里「不同 AI 服务」）。
   * 与上面三条同一权限批（`viewRecordings`）；`SAVE`/`DELETE`/`SET_ACTIVE`
   * 是写操作，参数在 handler 层收窄。**密钥本体永不经过 IPC 的读方向**——
   * `SAVE` 只收（可缺省/可 null 的）写方向密钥。
   */
  SAMPLE_AI_SERVICES: 'sample:ai-services',
  SAMPLE_AI_SERVICE_SAVE: 'sample:ai-service-save',
  SAMPLE_AI_SERVICE_DELETE: 'sample:ai-service-delete',
  SAMPLE_AI_SERVICE_SET_ACTIVE: 'sample:ai-service-set-active',

  /**
   * 听诊盒子族（E2 / FA100 / FA110）的「拉」通道（业主 2026-09-16）。
   * 权限归 `viewRecordings`：`status` 读的是设备参数与设备信息，`syncAlarms` 写的是
   * 本机的告警与录音行 —— 两件事都与"能不能看录音"同一批。
   */
  E2_STATUS: 'e2:status',
  E2_SYNC_ALARMS: 'e2:sync-alarms',

  /**
   * SN-16 空气声呐的**球机联动（PTZ）配置**（业主 2026-09-17 第 8 批）。
   *
   * 权限与前三条不同，是刻意的：
   *   - `E2_PTZ`（读）与 `E2_PTZ_UPDATE`（写）走 `configureDevices` —— 它们是**设备配置**，
   *     与 `config:*` 那一批同一件事（写的是设备本身，不是本机库）；
   *   - `E2_ALARM_SNAPSHOTS`（看某条告警的抓图）走 `viewAlarms` —— 那是**告警的附件**。
   */
  E2_PTZ: 'e2:ptz',
  E2_PTZ_UPDATE: 'e2:ptz-update',
  E2_NVT_TIME_SYNC: 'e2:nvt-time-sync',
  E2_ALARM_SNAPSHOTS: 'e2:alarm-snapshots',
  /** 关掉当前那条告警的抓图端点（界面离开时调用；TTL 是兜底）。 */
  E2_SNAPSHOT_CLOSE: 'e2:snapshot-close',

  /**
   * SN-16 空气声呐的每秒实时回调（业主规格 §20）。
   *
   * 读状态走 iewDevices（设备参数本来就是可读的）；**写回设备**走 configureDevices，
   * 与 PTZ 配置同一条规则：它会改设备自己的 
otify_url / is_send_realtime_value。
   */
  E2_REALTIME_CALLBACK: 'e2:realtime-callback',
  E2_REALTIME_CALLBACK_UPDATE: 'e2:realtime-callback-update',

  // Configuration reads used by earlier phases (kept: still referenced)
  CONFIG_GET_SAMPLE_RATE: 'config:get-sample-rate',

  // Protocol lab (spec section 19 — resolving the undocumented endpoints)
  PROTOCOL_PROBE_ENDPOINT: 'protocol:probe-endpoint',
  PROTOCOL_DIAGNOSE: 'protocol:diagnose',

  // Realtime monitoring (Phase 4-7). These are WebSocket streams on the device,
  // not HTTP endpoints — see docs/PROTOCOL-FINDINGS.md section 4.
  MONITOR_START: 'monitor:start',
  MONITOR_STOP: 'monitor:stop',
  MONITOR_STATE: 'monitor:state',
  MONITOR_START_RECORDING: 'monitor:start-recording',
  MONITOR_STOP_RECORDING: 'monitor:stop-recording',

  /**
   * FA371 acoustic camera realtime WebSocket streams (manual §5.2).
   *
   * SEPARATE FROM `MONITOR_*` ON PURPOSE. The camera's five channels share
   * nothing with the box's four: different paths, no subscribe message, no
   * channel concept, and payload layouts the manual leaves undefined
   * (§8.4 D2–D6). Reusing `MONITOR_START` would force both device families
   * through one handler that has to branch on `device.kind` — which is exactly
   * how the wrong client ends up talking to the wrong device.
   */
  FA371_STREAM_START: 'fa371-stream:start',
  FA371_STREAM_STOP: 'fa371-stream:stop',
  FA371_STREAM_STATE: 'fa371-stream:state',

  /**
   * FA371 camera LIVE VIDEO (`GET /system/video` -> RTSP -> ffmpeg -> loopback HTTP).
   *
   * A THIRD family of channels, and deliberately not folded into `FA371_STREAM_*`:
   * those carry DECIMATED JSON previews over IPC, while this one hands the renderer
   * a URL for a `<video>` element that pulls an MP4 byte stream from a loopback HTTP
   * server in the main process. Different transport, different failure modes (RTSP
   * disabled on the device, a missing transcoder), different states to report.
   */
  CAMERA_LIVE_START: 'camera-live:start',
  CAMERA_LIVE_STOP: 'camera-live:stop',
  CAMERA_LIVE_STATE: 'camera-live:state',
  /**
   * 当前会话**可用**的 RTSP 地址（含口令）。
   *
   * 为什么需要一个单独的通道：`CameraLiveState.rtspUrl` 是**打码**的（设备口令
   * 不进界面，这是刻意的），而「复制 RTSP 地址」和「在外部播放器打开」需要的是
   * 一个播放器真能打开的地址。于是把它单独做成一个**管理员**通道，并且每次调用
   * 都记日志——这是本工程里唯一一处把设备口令交给渲染层的地方，值得显式而窄。
   */
  CAMERA_LIVE_SOURCE: 'camera-live:source',
  /**
   * 同时直播的路数上限（本机主进程的预算，见 `AppSettings.maxConcurrentCameraStreams`）。
   *
   * 为什么界面要读它：视频墙必须能在**发起之前**说清楚「再加一格就会超过上限」，
   * 而不是先起一路、再收到一个失败。这是读操作，不加管理员校验。
   */
  CAMERA_LIVE_LIMITS: 'camera-live:limits',

  /**
   * 相机 NVR 交互：手动录像与抓图（产品要求「手动录像，告警配置」）。
   *
   * 与 `CAMERA_LIVE_*` 分开：那三个通道管的是「一路直播会话」，这几个管的是
   * 「落盘产物 + 录像表登记」，失败模式（磁盘满、0 字节文件、没有画面可抓）
   * 与直播完全不同，混在一个通道里只能靠一个 mode 字段去分支。
   */
  CAMERA_NVR_START_RECORDING: 'camera-nvr:start-recording',
  CAMERA_NVR_STOP_RECORDING: 'camera-nvr:stop-recording',
  CAMERA_NVR_RECORDING_STATE: 'camera-nvr:recording-state',
  CAMERA_NVR_SNAPSHOT: 'camera-nvr:snapshot',

  /**
   * 告警本地联动（产品要求：「告警和本地联动，录像，弹窗，提示以及邮件触发」）。
   *
   * 四个通道对应界面对引擎的四种操作：
   *   - `LINKAGE_GET_STATUS`  读引擎状态与触发源健康度（读，不加管理员校验）；
   *   - `LINKAGE_GET_PENDING` 读待处理告警（读）；
   *   - `LINKAGE_ACKNOWLEDGE` 确认/清除待处理告警（**写，要管理员**）；
   *   - `LINKAGE_TEST_EMAIL`  发一封测试邮件（**要管理员**，它会外发邮件）；
   *   - `LINKAGE_SET_ALARM_CENTER_OPEN` 告诉主进程「操作员正在看告警中心」（**读的镜像**，
   *     不需要管理员：它不写任何配置、不改变任何记录，只影响"要不要再弹一个提示窗口"）。
   */
  LINKAGE_GET_STATUS: 'linkage:get-status',
  LINKAGE_GET_PENDING: 'linkage:get-pending',
  LINKAGE_ACKNOWLEDGE: 'linkage:acknowledge',
  LINKAGE_TEST_EMAIL: 'linkage:test-email',
  /**
   * 渲染层 → 主进程：告警中心这一屏现在开着（业主 2026-09-26 第 5 条）。
   *
   * 为什么必须是渲染层告诉主进程：那个置顶提示窗口是主进程用 `BrowserWindow` 开的，
   * 渲染层没有关它的能力；而"哪一页在屏幕上"只有渲染层知道。
   * 挡的是**非告警类**与"已经在看告警中心"时的重复打扰，告警本身照样进列表与角标。
   */
  LINKAGE_SET_ALARM_CENTER_OPEN: 'linkage:set-alarm-center-open',
  /**
   * 取一段**手动录像**的可播放地址（本机回环 HTTP，支持 Range）。
   *
   * 为什么不复用音频那条 `playback.load`：它把整段文件 base64 推过 IPC，而一段
   * 3 分钟的 4 Mbit/s 视频约 90 MB。`<video>` 本来就能直接吃 HTTP 字节流，还带
   * Range 与缓冲；这里只把**地址**交给渲染层，字节流不过 IPC。
   */
  CAMERA_NVR_VIDEO_URL: 'camera-nvr:video-url',
  /**
   * 在系统文件管理器里定位一个文件（抓图完成后的「打开所在文件夹」）。
   *
   * 单独一个通道而不是复用 `APP_OPEN_EXTERNAL`：那个只接受 http(s)/mailto，
   * 而这里要交给 `shell.showItemInFolder` 的是**存储根内**的本地路径，主进程
   * 会先用 `StorageService.resolve()` 校验它没有越界。
   */
  APP_REVEAL_FILE: 'app:reveal-file',

  /**
   * 相机告警模型（手册 §5.1.22 – §5.1.29）：策略与条件。
   *
   * 读取不加管理员校验、写入加——沿用 `handlers.ts` 顶部那条规则（读公开、
   * 写要管理员）。八个通道一对一映射客户端已有的八个方法。
   */
  CAMERA_ALARM_LIST_STRATEGIES: 'camera-alarm:list-strategies',
  CAMERA_ALARM_CREATE_STRATEGY: 'camera-alarm:create-strategy',
  CAMERA_ALARM_UPDATE_STRATEGY: 'camera-alarm:update-strategy',
  CAMERA_ALARM_DELETE_STRATEGIES: 'camera-alarm:delete-strategies',
  CAMERA_ALARM_LIST_CONDITIONS: 'camera-alarm:list-conditions',
  CAMERA_ALARM_CREATE_CONDITION: 'camera-alarm:create-condition',
  CAMERA_ALARM_UPDATE_CONDITION: 'camera-alarm:update-condition',
  CAMERA_ALARM_DELETE_CONDITIONS: 'camera-alarm:delete-conditions',

  /**
   * 相机**控制与维护**（手册 §5.1.8/§5.1.9 检测模式、§5.1.14–§5.1.16 检测启停、
   * `GET`/`PUT /alarm_strategy_enable` 启用中的策略、版本信息与维护能力）。
   *
   * 与 `CAMERA_ALARM_*` 分开：那一组管告警模型的**内容**，这一组管
   * 「检测能不能跑起来」的**运行状态**。分成两个服务而不是一锅：告警模型内容编辑
   * 的失败模式（键名歧义、id 类型冲突）与"设备现在在做什么"完全不同。
   *
   * 读取不加管理员校验、写入（改模式 / 启停检测 / 启停策略）加 ——
   * 与 `handlers.ts` 顶部那条规则一致；判定表在
   * `camera-control-service.CAMERA_CONTROL_ADMIN_REQUIRED`。
   */
  CAMERA_CONTROL_READ_RUN_MODE: 'camera-control:read-run-mode',
  CAMERA_CONTROL_WRITE_RUN_MODE: 'camera-control:write-run-mode',
  CAMERA_CONTROL_READ_DETECT_STATUS: 'camera-control:read-detect-status',
  CAMERA_CONTROL_READ_SCAN_AREA: 'camera-control:read-scan-area',
  CAMERA_CONTROL_WRITE_SCAN_AREA: 'camera-control:write-scan-area',
  CAMERA_CONTROL_READ_REGION_METADATA: 'camera-control:read-region-metadata',
  CAMERA_CONTROL_WRITE_REGION_METADATA: 'camera-control:write-region-metadata',
  CAMERA_CONTROL_TURN_ON_DETECT: 'camera-control:turn-on-detect',
  CAMERA_CONTROL_TURN_OFF_DETECT: 'camera-control:turn-off-detect',
  CAMERA_CONTROL_READ_ENABLED_STRATEGY: 'camera-control:read-enabled-strategy',
  CAMERA_CONTROL_SET_STRATEGY_ENABLED: 'camera-control:set-strategy-enabled',
  CAMERA_CONTROL_MAINTENANCE: 'camera-control:maintenance',
  /**
   * **应用模式预设**（局部放电 / 气体泄漏 / 机械异响）。
   *
   * 厂家自己的 Quick Start 把「切换模式」写成**写成像参数**
   * （`docs/reference/api-workflow.txt` 第 55–64 行：Adjust device imaging
   * parameters; set the imaging frequency band to 20 kHz–40 kHz，
   * `PUT /system/acoustic`），所以这一对通道读写的是 `/system/acoustic` 与
   * `/system/image`。
   *
   * 它**不是**机型开关：这条通道不碰 `work_mode`（那由下面 `CAMERA_CONTROL_*WORK_MODE`
   * 那一对通道负责，两者刻意不互相调用）。
   *
   * 读不加管理员校验，应用（写）加 —— 与上面几条同一张判定表。
   */
  CAMERA_CONTROL_READ_MODE_PRESET: 'camera-control:read-mode-preset',
  CAMERA_CONTROL_APPLY_MODE_PRESET: 'camera-control:apply-mode-preset',
  CAMERA_CONTROL_RESTORE_MODE_VALUES: 'camera-control:restore-mode-values',
  /**
   * **应用模式**（这台设备在做哪种应用：局部放电 / 气体泄漏 / 机械异响）。
   *
   * ⚠ 端点 `GET` / `PUT /system` **未文档化**：它不在任何一份手册里，是设备自带
   * Web 界面的 bundle 里读出来的；所有 `*mode*` 猜想路径在真机上一律 404。
   * 真机实测（`192.168.110.235`）`work_mode` 1/2/3 三个值都读得到、写得动，
   * 所以本软件提供切换 —— 但这是"实测接口"，不是"受支持接口"：
   * 换一版固件它可能消失，所以读通道会如实回 `available: false`，界面据此不渲染控件。
   *
   * 与上面那对预设通道的区别：这条只写 `work_mode` 一个字段，**不碰**成像参数。
   *
   * 读不加管理员校验，切换加 —— 与上面几条同一张判定表。
   */
  CAMERA_CONTROL_READ_WORK_MODE: 'camera-control:read-work-mode',
  CAMERA_CONTROL_WRITE_WORK_MODE: 'camera-control:write-work-mode',
  /** `GET/PUT /system/leakage`：泄漏估算参数（局放→泄漏切换时的计算模板，2026-09-24）。 */
  CAMERA_CONTROL_READ_LEAKAGE: 'camera-control:read-leakage',
  CAMERA_CONTROL_WRITE_LEAKAGE: 'camera-control:write-leakage',

  /**
   * 相机**固件升级**（设备自带 Web 界面用的那条 HTTP 路）。
   *
   * 为什么与 `CAMERA_CONTROL_*` 分开：那一组管"检测能不能跑起来"，本组管
   * **一个几十 MB 的升级包从本机到设备**——它的失败模式（文件名校验不过、
   * 30 分钟的长上传、传到一半断网、上传成功但设备还没升级）与其它任何一个
   * 相机通道都不一样，混在一起只能靠一个 mode 字段去分支。
   *
   * 五个通道对应界面上五个动作：
   *   - `PICK_PACKAGE`   打开本机文件选择器（**不碰设备**，与
   *                      `MAINTENANCE_PICK_FIRMWARE` 同一形状，因此也不加管理员校验）；
   *   - `INSPECT_PACKAGE`读一个本地包的静态事实（大小 / sha256 / 文件名是否符合
   *                      设备规则）。只读本机文件，不碰设备；
   *   - `UPLOAD`         `POST /upload`（multipart，**要管理员**，写设备存储）；
   *   - `READ_PROGRESS`  `GET /progress`（只读，不加校验）；
   *   - `REBOOT`         `PUT /reboot`（**要管理员**，会中断设备上的一切）。
   *
   * **上传不会重启设备**：`UPLOAD` 的回包里没有任何"升级完成"的意思，重启是
   * `REBOOT` 这个独立动作，由操作员显式确认后发出。这一条是产品要求，也是这套
   * 接口本来的用法（设备自带前端也是先 `/upload`、再由人点重启）。
   */
  CAMERA_UPGRADE_PICK_PACKAGE: 'camera-upgrade:pick-package',
  CAMERA_UPGRADE_INSPECT_PACKAGE: 'camera-upgrade:inspect-package',
  CAMERA_UPGRADE_UPLOAD: 'camera-upgrade:upload',
  CAMERA_UPGRADE_READ_PROGRESS: 'camera-upgrade:read-progress',
  CAMERA_UPGRADE_REBOOT: 'camera-upgrade:reboot',

  // Recording playback (Phase 8)
  RECORDING_DOWNLOAD: 'recording:download',
  RECORDING_PLAYBACK_DATA: 'recording:playback-data',

  // Device configuration (Phase 9)
  CONFIG_GET_CHANNELS: 'config:get-channels',
  CONFIG_UPDATE_CHANNEL: 'config:update-channel',
  CONFIG_SET_SAMPLE_RATE: 'config:set-sample-rate',
  CONFIG_GET_ALARM_PROFILES: 'config:get-alarm-profiles',
  CONFIG_SAVE_ALARM_PROFILE: 'config:save-alarm-profile',
  CONFIG_DELETE_ALARM_PROFILE: 'config:delete-alarm-profile',
  CONFIG_GET_NETWORK: 'config:get-network',
  CONFIG_CHANGE_NETWORK: 'config:change-network',
  CONFIG_GET_TIME: 'config:get-time',
  CONFIG_UPDATE_TIME: 'config:update-time',
  CONFIG_SYNC_TIME: 'config:sync-time',
  CONFIG_GET_RS485: 'config:get-rs485',
  CONFIG_UPDATE_RS485: 'config:update-rs485',
  CONFIG_GET_SERIAL_PORTS: 'config:get-serial-ports',
  CONFIG_GET_MODBUS: 'config:get-modbus',
  CONFIG_UPDATE_MODBUS: 'config:update-modbus',
  CONFIG_GET_PUSH: 'config:get-push',
  CONFIG_SET_DEVICE_NAME: 'config:set-device-name',

  // Device maintenance (Phase 10) — destructive, confirmation is the UI's job
  MAINTENANCE_REBOOT: 'maintenance:reboot',
  MAINTENANCE_FACTORY_RESET: 'maintenance:factory-reset',
  MAINTENANCE_SYSTEM_UPGRADE: 'maintenance:system-upgrade',
  MAINTENANCE_PICK_FIRMWARE: 'maintenance:pick-firmware',
  MAINTENANCE_UPLOAD_FIRMWARE: 'maintenance:upload-firmware',

  // Historical trends (Phase 11). Queries run in DuckDB against Parquet files
  // written by the main process; the renderer only ever receives bucketed points.
  TREND_QUERY: 'trend:query',
  TREND_COVERAGE: 'trend:coverage',
  TREND_STATS: 'trend:stats',
  TREND_FLUSH: 'trend:flush',
  TREND_EXPORT_CSV: 'trend:export-csv',

  /**
   * 事件与告警中心（产品要求：「设置事件和告警中心。」）。
   *
   * 六个通道对应界面对这一页的六种操作：
   *   - `EVENT_CENTER_QUERY`              读合并后的分页结果（读，不加管理员校验）；
   *   - `EVENT_CENTER_DETECT_LOGS`        读一台相机的检测库（读）；
   *   - `EVENT_CENTER_ACKNOWLEDGE`        确认/清除事件（**写，要管理员**，与
   *     `ALARM_ACKNOWLEDGE` / `LINKAGE_ACKNOWLEDGE` 一致）；
   *   - `EVENT_CENTER_DOWNLOAD_DETECT_FILE` 把设备的结果文件下载到本机并登记
   *     （**写，要管理员**：它会连设备、写盘、登记录像行）；
   *   - `EVENT_CENTER_EVIDENCE_IMAGE`     把一个存储根相对路径（或一条录像行）变成
   *     回环图片地址（读；图片字节不过 IPC，与本地录像回放同一条做法）；
   *   - `EVENT_CENTER_EVIDENCE_IMAGE_CLOSE` 关掉上一次打开的图片端点（读）。
   *
   * 「合并」发生在主进程，因此界面只需要一个查询通道，不必自己拼三路来源。
   */
  EVENT_CENTER_QUERY: 'event-center:query',
  EVENT_CENTER_DETECT_LOGS: 'event-center:detect-logs',
  EVENT_CENTER_ACKNOWLEDGE: 'event-center:acknowledge',
  EVENT_CENTER_DOWNLOAD_DETECT_FILE: 'event-center:download-detect-file',
  EVENT_CENTER_EVIDENCE_IMAGE: 'event-center:evidence-image',
  EVENT_CENTER_EVIDENCE_IMAGE_CLOSE: 'event-center:evidence-image-close',
  /**
   * 处置一条事件：改工作流状态 / 指派（规格 §2.2）。**写，要管理员** ——
   * 与 `EVENT_CENTER_ACKNOWLEDGE` 同一条规则（它会写本机库、写 Activity，
   * 确认那一个动作还会连设备）。
   */
  EVENT_CENTER_CHANGE_STATUS: 'event-center:change-status',
  /** 读一条事件的处置流水（规格 §13.3）。只读。 */
  EVENT_CENTER_ACTIVITY: 'event-center:activity',
  /**
   * Incident（规格 §14.2 的 V1）。四条通道分读写两类：
   *   - `EVENT_CENTER_INCIDENTS_FOR_ALERT` / `EVENT_CENTER_INCIDENT_LIST` 只读（沿用
   *     `viewEvents`）；
   *   - 建/关联/解除**都是写**（写 `incidents` / `incident_alerts`），要管理员 ——
   *     与 `EVENT_CENTER_CHANGE_STATUS` 同一条规则。
   *
   * 为什么不合成一条"incident 操作"通道再带一个 action 字段：这三件事的**入参形状彼此
   * 不同**（一个要标题、一个要 incidentId + entryIds、一个要 incidentId + entryId），
   * 合成一条就只能靠一个联合类型去分支，权限也没法单独收紧。
   */
  EVENT_CENTER_INCIDENT_CREATE: 'event-center:incident-create',
  EVENT_CENTER_INCIDENT_LINK: 'event-center:incident-link',
  EVENT_CENTER_INCIDENT_UNLINK: 'event-center:incident-unlink',
  EVENT_CENTER_INCIDENTS_FOR_ALERT: 'event-center:incidents-for-alert',
  EVENT_CENTER_INCIDENT_LIST: 'event-center:incident-list'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/**
 * Main -> renderer push channels.
 *
 * Not in `IpcChannels` because that map is for request/response handlers;
 * these are `send`-only and never invoked by the renderer.
 *
 * Volume note: `monitor:spectrogram` carries roughly 55 KB/s as base64 JPEG and
 * `monitor:spectrum` roughly 6 KB/s. Both are far below the raw audio rate
 * because the main process decimates before pushing (see monitoring.ts).
 */
export const PushChannels = {
  DEVICE_STATUS: 'device:status-changed',
  /**
   * The application session changed.
   *
   * The session is owned by the MAIN process, so the renderer's copy is a mirror
   * and something has to keep it in step. A mirror updated only by the renderer's
   * own login call is wrong in two ways that both matter:
   *
   *   1. the main process can end a session without the renderer asking (a future
   *      idle timeout, or an administrator closing another account), and
   *   2. anything that signs in through the IPC bridge rather than through the
   *      page — which is what every headless verification script does — would
   *      leave the UI sitting on a login form for a session that already exists.
   *
   * Pushing it is the same shape as the device-status channel below, and avoids
   * the alternative a first cut used: the login screen polling `auth.session()`
   * every two seconds forever.
   */
  AUTH_SESSION: 'auth:session-changed',
  MONITOR_FEATURE: 'monitor:feature',
  MONITOR_AUDIO: 'monitor:audio',
  MONITOR_SPECTRUM: 'monitor:spectrum',
  MONITOR_SPECTROGRAM: 'monitor:spectrogram',
  MONITOR_STATUS: 'monitor:status',
  MONITOR_RECORDING_STATE: 'monitor:recording-state',
  /**
   * Authoritative session state.
   *
   * Needed because the main process can end a session BY ITSELF — the device
   * drops, a stream hits a terminal error, or shutdown releases the buffers.
   * Without a push, the renderer's session badge would stay at "running"
   * forever while no data arrives, which is worse than an error: it looks fine.
   */
  MONITOR_STATE: 'monitor:state-changed',
  /**
   * FA371 camera frames, one channel per payload kind.
   *
   * These carry DECIMATED previews, never the raw frames: `/pcmData` alone is
   * 192 000 B/s and `/voiceprintData` 131 072 B/s. What the main process
   * decimates (and why it takes the extreme rather than the mean) is documented
   * in `services/device/fa371/fa371-stream-service.ts` and in
   * `shared/domain/fa371-stream.ts`.
   */
  FA371_FFT: 'fa371-stream:fft',
  FA371_VOICEPRINT: 'fa371-stream:voiceprint',
  FA371_PRPD: 'fa371-stream:prpd',
  FA371_ENERGY: 'fa371-stream:energy',
  FA371_PCM: 'fa371-stream:pcm',
  /** 声温成像仪红外温度（手册 §5.3.6）。 */
  FA371_INFRARED: 'fa371-stream:infrared',
  FA371_DETECT_FEEDBACK: 'fa371-stream:detect-feedback',
  /** Per-channel connection state, pushed on every transition. */
  FA371_STREAM_STATUS: 'fa371-stream:status',
  /** Authoritative session state, for UI reconciliation (mirrors `MONITOR_STATE`). */
  FA371_STREAM_STATE: 'fa371-stream:state-changed',
  /**
   * Progress of a network reconfiguration.
   *
   * Needed because the operation can take ~45 s (apply, reconnect, verify, and
   * possibly roll back). A frozen button with no feedback during a step that can
   * lock a device out is the worst possible UI for it.
   */
  NETWORK_PROGRESS: 'config:network-progress',
  /**
   * 待处理告警的权威快照。
   *
   * **「提示」要能在关掉弹窗、切走页面之后仍然看得见**，所以这里推的是
   * 主进程持有的那份待处理列表，而不是「刚弹了一次窗」这种瞬时事件：
   * 渲染层在任何时刻挂载（包括刚刷新页面）都能拿到同一份真相。
   */
  LINKAGE_PENDING: 'linkage:pending-changed',
  /**
   * 检测结果文件的下载进度。
   *
   * **没有百分比**：`HttpTransport` 一次性读出响应体，中间层拿不到
   * `Content-Length` 与已读字节数（见 `EventDownloadProgress` 的说明）。
   * 推的只是「进行到哪一步」，让按钮在几十 MB 的下载期间不是死的。
   */
  EVENT_CENTER_DOWNLOAD_PROGRESS: 'event-center:download-progress',
  /**
   * 相机固件升级包**上传**的真实字节进度。
   *
   * 为什么这里敢给百分比，而下载进度（上面那条）只给阶段：升级这条路特意走
   * `node:http` 流式发送（见 `services/device/fa371/camera-upgrade-service.ts`），
   * 每个写出的 chunk 都数得到，所以百分比有真实来源；`HttpTransport` 那条路
   * 一次性读完响应，中途的字节数拿不到，编一个假进度条比没有更糟。
   */
  CAMERA_UPGRADE_PROGRESS: 'camera-upgrade:upload-progress',
  /**
   * SN-16 每秒 
ealtime_value（设备 POST 到 
otify_url）。
   *
   * 与其它遥测推送同一条理由：数据由主进程 HTTP 监听接收，渲染层只订阅；
   * 界面挂载或切换设备时先读一次状态里的最新值，之后靠这条推送同步。
   */
  E2_REALTIME_CALLBACK_VALUE: 'e2:realtime-value',
  /**
   * 瓦片缓存下载进度（业主 20260921 批）。每处理一块瓦片推一次
   * `MapTileCacheProgress`（done = 收尾那一次）；订阅方按自己发起的那一次认领
   * （同一时间只会有一个下载任务 —— 服务内部串行化）。
   */
  MAP_CACHE_PROGRESS: 'map:cache-progress'
} as const

/** One step of a network change, pushed while it runs. */
export interface NetworkProgressEvent {
  deviceId: string
  stage: NetworkChangeStage
  detail?: string
}

/** @deprecated kept for the existing preload bridge; use `PushChannels`. */
export const DEVICE_STATUS_CHANNEL = PushChannels.DEVICE_STATUS

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string
  version: string
  /** Declared release date (`YYYY-MM-DD`) from package.json. */
  releaseDate: string
  /** Date this specific build was produced. Differs from releaseDate for dev builds. */
  buildDate: string
  /** Company website. */
  homepage: string
  /** Support address. */
  supportEmail: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  arch: string
  /** Absolute path of the SQLite metadata database. */
  databasePath: string
  /** Absolute path of the audio/metrics storage root. */
  storageRoot: string
  isDev: boolean
}

export interface AppSettings {
  /** Root for audio, metrics, caches and exports. Always on a large disk. */
  storageRoot: string
  /** Days to retain alarm recordings. Manual recordings are never auto-deleted. */
  retentionDays: number
  /** Stop non-essential recording below this many free bytes. Default 10 GB. */
  minFreeBytes: number
  /** Online probe interval, default 5000 ms (spec 13.2). */
  healthCheckIntervalMs: number
  /** Consecutive probe failures before a device is declared OFFLINE (spec 13.2). */
  offlineFailureThreshold: number
  /** Per-request HTTP timeout in ms. */
  requestTimeoutMs: number
  /** Ring buffer pre-alarm capture, seconds (spec 4.3, default 10). */
  preAlarmSeconds: number
  /** Ring buffer post-alarm capture, seconds (spec 4.3, default 20). */
  postAlarmSeconds: number
  /** Total Ring Buffer depth in seconds (spec 4.3, default 60). */
  ringBufferSeconds: number
  /**
   * 打开软件时，如果相机确实在工作就自动播放实时视频（产品要求「软件打开如果是
   * 相机有在工作就自动播放视频」）。
   *
   * **默认开启**，但操作员可以关掉：自动播放会让相机打开一条 RTSP 连接（相机有
   * 有限的 `rtsp_client_limit`），在一个只看告警、不看画面的值班台上，他完全有权
   * 不要它。判定与一次启动只尝试一次的守卫见
   * `@shared/domain/camera-autoplay` 与 `renderer/stores/cameraLive.ts`。
   */
  autoPlayCameraLive: boolean
  /**
   * 同时直播的相机路数上限（多路视频墙的预算）。
   *
   * 为什么必须有这个设置：每一路直播在主进程里都是一个 ffmpeg 子进程 + 一个
   * 回环 HTTP 服务 + 一个 socket + 一份转封装缓冲，在渲染层还占一份解码与显存。
   * 设备侧的 `rtsp_client_limit`（实测 10）比本机宽裕，所以**本机主进程才是绑定
   * 约束**。与其让第 N 路悄悄把整机拖垮，不如给一个明确的数字：超出的那一路拿到
   * 如实的 `CameraLiveStatus = 'limit-exceeded'`。
   *
   * 合法区间与默认值定义在 `@shared/domain/camera-live`
   * （`normaliseMaxConcurrentStreams`），设置页与 `RtspStreamService` 引用同一处。
   */
  maxConcurrentCameraStreams: number
  /**
   * 告警联动（产品要求「告警和本地联动，录像，弹窗，提示以及邮件触发」）。
   *
   * 结构、默认值与归一化规则见 `@shared/domain/alarm-linkage` 与
   * `main/services/settings/alarm-linkage-config`。
   *
   * **SMTP 口令不在这里**：它走 `credential.smtp` 这条 DPAPI/safeStorage 加密
   * 的凭据路径（与设备口令同一套机制）。本结构里只有一个布尔事实
   * `email.smtpPasswordStored`，由主进程在返回设置时填充。
   */
  alarmLinkage: AlarmLinkageConfig
  /**
   * 告警声音库（手册 §17.2.7，p185）。
   *
   * 结构、默认值与归一化规则见 `@shared/domain/alarm-sound`。与 `alarmLinkage`
   * 分开：那一个管「告警发生时做哪些动作」，这一个管「有哪几种告警声音、
   * 各自指向哪个 `.wav` 文件」。**「哪类告警用哪个声音」的绑定不在本轮**。
   */
  alarmSounds: AlarmSoundLibrary
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条：HTTP 推流 + MQTT）。
   *
   * **手册未说明**这一节（手册里没有"IoT 接入"这一章），所以整套口径是我们定的，
   * 写在 `@shared/domain/iot-ingest`：形状照抄 ThingsBoard 的设备侧接入
   * （`/api/v1/<秘钥>/telemetry`、MQTT 用秘钥当用户名），**默认关闭**，
   * 绑定地址与两个端口可配。
   */
  iotIngest: IotIngestConfig

  /**
   * 连续录像（RTSP 取流存储，业主 2026-09-26 追加范围，见 docs/STORAGE-DESIGN.md §9）。
   *
   * **opt-in**：空列表 = 谁都不录。一路 2 Mbps 一天约 21 GB，装完就开始 7×24 录像
   * 会把用户的盘填满，比不录更糟。
   */
  recorder: RecorderConfig

  /**
   * 存储容量配额与告警保留区（业主 2026-09-30：优先级是容量）。
   *
   * `storageQuotaBytes`：录像/录音/趋势/日志/缓存**合计**的上限，界面按 GB 填，默认 50 GB。
   * `retentionAlarmReserveRatio`：其中给"warning 以上的告警录像永久保存"预留的比例，默认 0.1。
   * 两者都由 `shared/domain/retention.ts` 的纯策略消费（该模块只算不删）。
   */
  storageQuotaBytes: number
  retentionAlarmReserveRatio: number

  /**
   * 在线地图底图（业主 2026-09-19 追加第 1 条：地图 GIS 应该在设置里面配置）。
   *
   * **默认关闭**（离线优先）；只有用户显式打开后，地图页才会以 `<img>` 加载配置的
   * XYZ 瓦片。只允许 https、模板必须含 `{z}/{x}/{y}`、启用时必须填署名。
   * **手册未说明**：手册没有地图/瓦片服务这一章，整套口径见 `@shared/domain/map-tiles`。
   */
  mapTiles: MapTilesConfig

  /**
   * 命名的 GIS 服务库（业主追加：设置里「添加 GIS 服务」）。
   *
   * `mapTiles` 是"当前生效的那一份"；这里是可命名保存、一键选用的备选服务列表
   * （用户私有的瓦片服务、常切换的商业 key 等）。条目校验见
   * `@shared/domain/map-tiles` 的 `normaliseMapServices()`；上限 `MAX_MAP_SERVICES`。
   */
  mapServices: MapServiceEntry[]
}

export type AppSettingsPatch = Partial<AppSettings>

/**
 * 瓦片缓存下载请求（`MAP_CACHE_TILES` 的入参，业主 20260921 批）。
 *
 * 服务 + 模板/key/署名与 `MapTilesConfig` 同一份判据（下载器就是拿它们拼 `tileUrl()`），
 * 外加缩放级别范围与经纬度区域。主进程在 handler 层收窄未知键，服务层再按共享层
 * 判据校验一次。
 */
export interface MapTileCacheRequest {
  service: MapTileServiceId
  urlTemplate: string
  apiKey: string
  attribution: string
  minZoom: number
  maxZoom: number
  bounds: TileCacheBounds
}

/** 一次缓存下载的汇总结果（`downloaded + skipped + failed` 恒等于 total）。 */
export interface MapTileCacheResult {
  downloaded: number
  /** 磁盘上已存在而跳过（断点续下：重复下载不会重写已有瓦片）。 */
  skipped: number
  failed: number
  /** 本次真正写盘的字节数（跳过的不计）。 */
  bytes: number
}

/** 缓存下载进度推送（`MAP_CACHE_PROGRESS`）。 */
export interface MapTileCacheProgress {
  downloaded: number
  skipped: number
  failed: number
  total: number
  bytes: number
  /** 最后一次推送为真；失败中断也以 done 收尾（failed/total 如实，结果走 IPC 错误）。 */
  done: boolean
}

export interface DiskUsage {
  storageRoot: string
  totalBytes: number
  freeBytes: number
  /**
   * The settings endpoint (`quotaUsage()`) reports the whole storage root:
   * recordings, trends, logs, caches, exports and anything else the app writes
   * there. The quota is compared against THIS number so the UI cannot report
   * one figure while the retention policy enforces another. The internal hot-
   * path guard (`diskUsage()`) still fills this with the legacy audio scan and
   * leaves the quota fields below at zero; use `quotaUsage()` when displaying.
   */
  usedByAppBytes: number
  /** Configured capacity quota in bytes; 0 means unlimited (0 in quick guards). */
  quotaBytes: number
  /** `max(0, usedByAppBytes - quotaBytes)`; may be non-zero while a sweep is pending. */
  overQuotaBytes: number
  /**
   * Bytes that would remain over quota after the next capacity sweep deletes
   * every auto-deletable recording. A value > 0 means only permanent alarms,
   * manual recordings and non-recording data are left; the UI must report that
   * honestly instead of claiming the sweep cleaned everything.
   */
  remainingOverQuotaBytes: number
  /** Bytes the next capacity sweep can free: rebuildable caches first, then rolling recordings. */
  reclaimableBytes: number
  belowSafetyFloor: boolean
}

/** Result of a lightweight reachability probe, used by "Add device" preview. */
export interface ProbeResult {
  reachable: boolean
  /** Present when reachable and the payload matched the HERTZINNO shape. */
  info?: DeviceInfo
  /** True when a device with this deviceUid is already registered. */
  alreadyRegistered: boolean
  existingDeviceId?: string
  /** Round-trip time of the successful call, ms. */
  latencyMs?: number
  /** Which auth strategy succeeded, for the Protocol Lab report. */
  authStrategy?: string
  /**
   * Which family answered — reported rather than assumed.
   *
   * The Add dialog has to be able to say what it actually found, and the two
   * families answer differently: a box returns its own Device ID/SN, while a
   * camera has no identity endpoint at all.
   */
  kind?: DeviceKind
  /**
   * How identity was established.
   *
   * `device`  — read from the device (`GET /get_devinfo`).
   * `minted`  — derived from the address, because the camera cannot report one.
   *             The UI must surface this: it is why re-addressing a camera
   *             registers a second device.
   */
  identitySource?: 'device' | 'minted'
  /**
   * 听诊盒子族的**代次**（只有 `kind === 'auscultationBox'` 时可能出现）。
   *
   * 探活时本来就要读一次 `/system` 判代次（设备信息端点两代不同），所以这个答案是**顺手**
   * 得到的，不需要多一次请求。它的用处是**添加设备时就把代次落库**（v12）—— 否则一台
   * SN-16 加进来之后要等第一次读状态，界面才知道该给它「PTZ 联动」页签。
   */
  e2Variant?: E2Variant
}

/** Outcome of one raw endpoint probe in the Protocol Lab. */
export interface EndpointProbeResult {
  path: string
  method: string
  ok: boolean
  status?: number
  latencyMs?: number
  /** Content-Type as reported by the device; critical for the stream unknowns. */
  contentType?: string
  /** Whether the response looked like chunked transfer encoding. */
  chunked?: boolean
  /** First N bytes of the body, hex + ascii, for framing analysis. */
  sampleHex?: string
  sampleAscii?: string
  /** Bytes actually received before the probe stopped. */
  receivedBytes?: number
  /** Parsed JSON when the payload was JSON. */
  json?: unknown
  error?: string
}

export interface DiagnoseReport {
  deviceId: string
  startedAt: number
  finishedAt: number
  /** Which auth header form the device accepted (spec section 19, risk 1). */
  authStrategyDetected?: string
  /** Tokens discovered in the /login response, redacted to a length only. */
  loginTokenPresent: boolean
  loginFieldNames: string[]
  endpoints: EndpointProbeResult[]
  notes: string[]
}

// ---------------------------------------------------------------------------
// Monitoring (Phase 4-7)
// ---------------------------------------------------------------------------

/** Which streams to run for a device. Omitted kinds default to off. */
export interface MonitorSubscription {
  deviceId: string
  kinds: StreamKind[]
  /**
   * Channel to subscribe to.
   *
   * MEASURED: the device streams ONE channel per WebSocket connection, so
   * monitoring N channels requires N connections. See PROTOCOL-FINDINGS 4.3.
   */
  channelId?: number
  /**
   * Channels the UI wants FEATURE frames for, for the multi-channel view
   * (业主 2026-09-24).
   *
   * `channelId` is always included — it is what the primary socket already
   * streams — and each other entry gets its own `/features_stream` connection.
   * Capped at `MAX_FEATURE_CHANNELS`; omitted means "just the current channel",
   * which is exactly the behaviour before this option existed.
   */
  featureChannelIds?: number[]
}

/** What the main process is currently streaming, for UI reconciliation. */
export interface MonitorState {
  deviceId: string
  channelId: number
  running: StreamKind[]
  recording: boolean
  recordingStartedAt?: number
  recordingId?: string
  /**
   * Milliseconds captured so far.
   *
   * Audio-anchored (samples / sampleRate), NOT wall clock: measured delivery is
   * ~1.08x real time on the tested device, so a wall-clock timer would drift
   * away from the duration the saved file actually reports.
   */
  elapsedMs?: number
  /**
   * Per-channel feature-feed reality for the multi-channel view.
   *
   * Absent on an older main process, and `[]` when no feature stream runs; the
   * renderer treats a missing list as "the device only pushes the current
   * channel" rather than inventing per-channel health.
   */
  featureChannels?: MonitorFeatureChannel[]
}

export interface StartRecordingInput {
  deviceId: string
  channelId: number
}

// ---------------------------------------------------------------------------
// FA371 camera realtime streams (manual §5.2)
// ---------------------------------------------------------------------------

/**
 * RE-EXPORTED so the renderer can name these types without importing from
 * `src/main/`, exactly as the device-config view models are re-exported above.
 * The renderer's tsconfig does not include `src/main/`, and it must not.
 */
export type {
  Fa371DecodeProfile,
  Fa371DetectFeedbackPreview,
  Fa371EnergyPreview,
  Fa371EnergyTarget,
  Fa371FftPreview,
  Fa371HandshakeCertainty,
  Fa371InfraredPreview,
  Fa371MonitorState,
  Fa371PcmPreview,
  Fa371PrpdPreview,
  Fa371StreamKind,
  Fa371StreamPreview,
  Fa371StreamStatus,
  Fa371StreamSubscription,
  Fa371VoiceprintPreview
} from '../domain/fa371-stream'
import type {
  Fa371MonitorState,
  Fa371StreamKind,
  Fa371StreamStatus,
  Fa371StreamSubscription
} from '../domain/fa371-stream'

/**
 * RE-EXPORTED for the same reason as the FA371 stream previews above: the live-view
 * panel has to NAME these states (`rtsp-disabled`, `ffmpeg-missing`, …) and the
 * renderer must not import from `src/main/` to do it.
 */
export type {
  CameraLiveLimits,
  CameraLiveMode,
  CameraLiveState,
  CameraLiveStartInput,
  CameraLiveStatus
} from '../domain/camera-live'
import type {
  CameraLiveLimits,
  CameraLiveStartInput,
  CameraLiveState
} from '../domain/camera-live'

/**
 * 相机 NVR 交互（右键菜单规则、文件名与目录）与告警模型的**共享**部分。
 *
 * 全部重新导出，理由与上面 `CameraLive*` 相同：渲染层要用它们，而渲染层的
 * tsconfig 不包含 `src/main/`。菜单项的启用/禁用规则是**纯函数**，因此界面自己
 * 就能算出「哪一项为什么是灰的」，不必为一次右键多打一个 IPC 往返。
 */
export type {
  CameraCaptureReadiness,
  CameraMediaKind,
  CameraNvrAction,
  CameraNvrEnvironment,
  CameraNvrMenuItem
} from '../domain/camera-nvr'

export type {
  CameraAlarmAmbiguity,
  CameraAlarmAmbiguityId,
  CameraAlarmConditionDraft,
  CameraAlarmConditionIdStyle,
  CameraAlarmDiagnosisKeyStyle,
  CameraAlarmIssue,
  CameraAlarmStrategyDraft
} from '../domain/camera-alarm'
// 同一个文件里既导出又导入：`RendererApi` 的方法签名要用到这些名字，
// 而 `export type { … } from` 不会把它们带进本文件的词法作用域。
import type {
  CameraAlarmConditionDraft,
  CameraAlarmConditionIdStyle,
  CameraAlarmDiagnosisKeyStyle,
  CameraAlarmStrategyDraft
} from '../domain/camera-alarm'

/**
 * 读取侧的告警策略 / 条件（映射后的域模型，渲染层只读）。
 *
 * 检测模式与检测状态的域模型也在这里一起重新导出：`cameraControl` 的签名要用到
 * 它们，而 preload 与渲染层都只从本文件取类型，不直接指向 `src/main/`。
 */
export type {
  Fa371AlarmCondition,
  Fa371AlarmStrategy,
  Fa371DetectStatus,
  Fa371LeakageConfig,
  Fa371RunModeConfig,
  Fa371RunModeValue,
  Fa371ScanArea,
  Fa371WorkModeConfig,
  Fa371WorkModeValue
} from '../domain/fa371'
import type { Fa371AlarmCondition, Fa371AlarmStrategy, Fa371LeakageConfig, Fa371ScanArea } from '../domain/fa371'

/**
 * 相机控制与维护的类型。
 *
 * 同样重新导出：控制面板要能命名「写进去的值 vs 设备读回的值」
 * （`CameraRunModeWriteResult`）与「维护项为什么是灰的」
 * （`CameraMaintenanceFeature.reasonKey`），而渲染层的 tsconfig 不包含 `src/main/`。
 */
export type {
  CameraDetectAction,
  CameraDetectActionResult,
  CameraAlarmRegionMetadata,
  CameraAlarmRegionMetadataInput,
  CameraEnabledStrategyView,
  CameraLeakagePatch,
  CameraLeakageWriteResult,
  CameraMaintenanceFeature,
  CameraMaintenanceFeatureId,
  CameraMaintenanceInfo,
  CameraMaintenanceReasonKey,
  CameraMaintenanceSourceId,
  CameraRunModeWriteResult,
  CameraScanAreaWriteResult,
  CameraStrategyEnableResult,
  CameraVersionInfo,
  CameraWorkModeRead,
  CameraWorkModeWriteResult
} from '../domain/camera-control'
import type {
  CameraDetectActionResult,
  CameraAlarmRegionMetadata,
  CameraAlarmRegionMetadataInput,
  CameraEnabledStrategyView,
  CameraLeakagePatch,
  CameraLeakageWriteResult,
  CameraMaintenanceInfo,
  CameraRunModeWriteResult,
  CameraScanAreaWriteResult,
  CameraStrategyEnableResult,
  CameraWorkModeRead,
  CameraWorkModeWriteResult
} from '../domain/camera-control'

/**
 * 相机固件升级的类型（包的事实、上传结果、上传进度、设备侧进度、重启结果）。
 *
 * 同样重新导出：控制面板要能命名「这个包是什么」「传到哪了」，而渲染层的
 * tsconfig 不包含 `src/main/`。这里只导出类型，不产生任何运行时依赖。
 */
export type {
  CameraRebootResult,
  CameraUpgradePackage,
  CameraUpgradeProgress,
  CameraUpgradeProgressEvent,
  CameraUpgradeUploadResult
} from '../domain/camera-upgrade'
// 同一个文件里既导出又导入：`RendererApi` 的方法签名要用到前四个名字，
// 而 `export type { … } from` 不会把它们带进本文件的词法作用域。
import type {
  CameraRebootResult,
  CameraUpgradePackage,
  CameraUpgradeProgress,
  CameraUpgradeUploadResult
} from '../domain/camera-upgrade'

/**
 * 应用模式预设的类型。
 *
 * 同样重新导出：控制面板要能命名「当前频带」「命中的预设」
 * （`CameraModeDeviceView` / `CameraModePresetId`）与「这次写哪些字段生效了」
 * （`CameraModePresetWriteResult`），而渲染层的 tsconfig 不包含 `src/shared/`
 * 之外的实现细节 —— 这里只导出类型，不产生任何运行时依赖。
 */
export type {
  CameraModeAcousticValues,
  CameraModeAnyFieldKey,
  CameraModeDeviceView,
  CameraModeFieldResult,
  CameraModeImagingValues,
  CameraModePresetId,
  CameraModePresetRead,
  CameraModePresetWriteResult,
  CameraModeRequestedValues
} from '../domain/camera-mode-preset'
import type {
  CameraModePresetId,
  CameraModePresetRead,
  CameraModePresetWriteResult,
  CameraModeRequestedValues
} from '../domain/camera-mode-preset'
import type { Fa371DetectStatus, Fa371RunModeConfig, Fa371RunModeValue, Fa371WorkModeValue } from '../domain/fa371'

/**
 * 告警联动的类型。
 *
 * 全部重新导出，理由与上面的 FA371 类型相同：渲染层要能命名「待处理告警」
 * 「某个动作为什么失败」，而渲染层的 tsconfig 不包含 `src/main/`。
 */
export type {
  AlarmLinkageConfig,
  LinkageActionKind,
  LinkageActionOutcomeStatus,
  LinkageActionRecord,
  LinkageActionSwitches,
  LinkageAlarmDecision,
  LinkageEmailMessage,
  LinkageEmailSendResult,
  LinkageEmailSettings,
  LinkageEngineStatus,
  LinkageEventIdentity,
  LinkageEventIdentityKind,
  LinkageExecution,
  LinkageMetrics,
  LinkageNoticeSettings,
  LinkagePopupSettings,
  LinkageRecordingSettings,
  LinkageRuntimeSettings,
  LinkageSmtpSecurity,
  LinkageSourceStatus,
  LinkageTestAttachmentKind,
  LinkageTestEmailInput,
  LinkageTestEmailResult,
  LinkageTrigger,
  LinkageTriggerSourceKind,
  PendingAlarmRecord,
  PendingAlarmSnapshot
} from '../domain/alarm-linkage'
import type {
  AlarmLinkageConfig,
  LinkageEngineStatus,
  LinkageTestEmailInput,
  LinkageTestEmailResult,
  PendingAlarmSnapshot
} from '../domain/alarm-linkage'

/**
 * `EventSeverity` 在下面那个 `export type { … }` 里只是**再导出**，不进本文件作用域。
 * 而 `alarms.setSeverity()` / `countBySeverity()` 的签名要直接用它，所以这里单独导入一次。
 */
import type { EventSeverity } from '../domain/event-center'

/**
 * 处置工作流的类型（规格 §2.2 / §13.3）。
 *
 * 状态机与动作都在 `domain/event-view.ts`（纯函数、有单测）：主进程用它判定迁移合法性，
 * 渲染层用它决定"这一条事件现在能做哪些动作"。这里只是把类型带到 IPC 边界上。
 */
export type {
  EventActivityView,
  EventStatusAction,
  EventStatusChangeResult
} from '../domain/event-view'

/**
 * 同一条理由（`export type { … } from` 只再导出，不进本文件作用域）：
 * `eventCenter.changeStatus` / `activity` 的签名要直接写这几个名字。
 */
import type {
  EventActivityView,
  EventStatusAction,
  EventStatusChangeResult
} from '../domain/event-view'

/**
 * Incident 的类型（规格 §14.2 的 V1：人工创建 + 手动关联）。
 *
 * 同一套做法：领域（`domain/incident.ts`，纯函数、有单测）定义视图模型与判据，
 * 这里只把名字带到 IPC 边界上。
 */
export type { IncidentView, IncidentLinkView } from '../domain/incident'

import type { IncidentView } from '../domain/incident'

/** 建一个 Incident 的入参（`[Create Incident]`）。 */
export interface EventIncidentCreateInput {
  title: string
  note?: string
  /**
   * 一并关联的 entry id。
   *
   * 界面把「潜在关联 Incident」建议卡里那几条**预勾选**后带过来（规格 §13.2 的建议只是
   * 初值：操作员可以先去掉几条，也可以一条都不带 —— 先建事件、稍后再挂也是合法用法）。
   */
  entryIds?: string[]
}

/** 手动把一批 Alert 关联到已有 Incident 的入参。 */
export interface EventIncidentLinkInput {
  incidentId: string
  entryIds: string[]
}

/** 解除一条关联的入参。 */
export interface EventIncidentUnlinkInput {
  incidentId: string
  entryId: string
}

/** 建/关联的结果：读出库里的那一条 + 这次真正新增的关联条数（回执要用）。 */
export interface EventIncidentWriteResult {
  incident: IncidentView
  linked: number
  /** 只有 `linkAlerts` 才有：本来就已经关联过的条数（幂等命中，不是错误）。 */
  alreadyLinked?: number
}

/** 一次处置请求（`eventCenter.changeStatus` 的入参）。 */
export interface EventStatusChangeInput {
  entryId: string
  /**
   * 一起处置的其它 entry id（聚合告警：一次处置落到组内每一条触发）。
   *
   * 界面从 `AlertViewModel.members` 拿到它们；服务端在**同一个事务**里写状态与流水，
   * 要么都成、要么都不成。
   */
  entryIds?: string[]
  /** 界面上的动作；与 `status` 二选一。 */
  action?: EventStatusAction
  /** 直接给目标状态（程序化调用；界面走 `action`）。 */
  status?: 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'closed' | 'muted' | 'reopened'
  /** 指派给的账户名（`assign` 动作必填）。 */
  assignee?: string
  /** 说明/原因（`reopen` 必填；其余动作可选）。 */
  note?: string
  /**
   * 界面看到的当前状态。
   *
   * 只在一个场景里用得上：`assign` 时这一条还没有状态行，需要按当前状态建行 ——
   * 否则"指派"会把一条已确认的事件退回「待处理」（仓储层的注释写了完整推理）。
   */
  currentStatus?: 'new' | 'acknowledged' | 'investigating' | 'resolved' | 'closed' | 'muted' | 'reopened'
}

/**
 * 事件与告警中心的类型。
 *
 * 与上面的 FA371 / 联动类型同一条理由：渲染层要能命名「一条归一化事件」
 * 「哪一路来源读不到」「下载走到哪一步了」，而渲染层的 tsconfig 不包含
 * `src/main/`。这里同样只导出类型，不产生任何运行时依赖。
 */
export type {
  EventAcknowledgePerSource,
  EventAcknowledgeResult,
  EventCenterEntry,
  EventCenterPage,
  EventCenterQuery,
  EventDetectDetail,
  EventDetectDownloadInput,
  EventDetectDownloadResult,
  EventDetectFile,
  EventDetectLibraryPage,
  EventDetectLogView,
  EventDownloadProgress,
  EventDownloadStage,
  EventEvidenceImageInput,
  EventEvidenceImageView,
  EventKind,
  EventLocalAlarmDetail,
  EventMetrics,
  EventSeverity,
  EventSourceKind,
  EventSourceStatus
} from '../domain/event-center'
import type {
  EventAcknowledgeResult,
  EventCenterPage,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDetectDownloadResult,
  EventDetectLibraryPage,
  EventDownloadProgress,
  EventEvidenceImageInput,
  EventEvidenceImageView
} from '../domain/event-center'

/** 手动录像的状态（界面据此显示录制指示器）。 */
export interface CameraRecordingState {
  deviceId: string
  recording: boolean
  startedAt?: number
  /** 正在写入的文件（存储根相对路径）。 */
  relativePath?: string
}

/** 一次手动录像的收尾结果。 */
export interface CameraRecordingResult {
  deviceId: string
  recordingId?: string
  relativePath: string
  durationMs: number
  fileSize: number
  /** 录像途中码流断开时的诊断（文件已保留并登记）。 */
  warning?: string
}

/** 一次抓图的结果：路径要展示给操作员，并提供「打开所在文件夹」。 */
export interface CameraSnapshotResult {
  deviceId: string
  absolutePath: string
  relativePath: string
  bytes: number
  capturedAt: number
}

/**
 * 一段本地录像的可播放地址。
 *
 * `url` 指向主进程里只绑回环的 HTTP 端点（含每会话随机令牌），字节流不过 IPC。
 */
export interface VideoPlaybackSource {
  url: string
  fileName: string
}

/**
 * 当前可用的 RTSP 源。
 *
 * `url` **含口令**，只用于「复制」「外部播放器」这两个显式动作；界面在任何
 * 情况下都不得把它渲染成文本（要显示就打码后的 `maskedUrl`）。
 */
export interface CameraLiveSource {
  url: string
  maskedUrl: string
  candidateId: string
  mode: string
}

/** 告警策略一页 / 告警条件一页（含设备侧的分页总数）。 */
export interface CameraAlarmStrategyPage {
  items: Fa371AlarmStrategy[]
  pageTotal?: number
}

export interface CameraAlarmConditionPage {
  items: Fa371AlarmCondition[]
  pageTotal?: number
}

/** Result of a manual recording. */
export interface RecordingResult {
  recordingId: string
  /** Path relative to the storage root. */
  relativePath: string
  durationMs: number
  fileSize: number
  sampleRate: number
}

/**
 * Playable audio for one recording, prepared by the main process.
 *
 * Playback happens in the renderer, so the bytes must cross IPC. Base64 is used
 * for the same reason as the spectrogram: it survives every IPC path and drops
 * into an `<audio>` element or `decodeAudioData` without an object-URL lifecycle
 * to leak.
 *
 * Size caveat: a 10 s recording is ~3.8 MB, so ~5 MB as base64. That is a
 * deliberate, user-initiated, once-per-click cost — not a streaming path.
 */
export interface PlaybackData {
  recordingId: string
  /** Original file bytes as base64, ready for a Blob or `decodeAudioData`. */
  audioBase64: string
  mimeType: string
  sampleRate: number
  channels: number
  durationMs: number
  /**
   * 片段在**绝对时间轴**上的起点（epoch ms）。
   *
   * 为什么播放器需要它：告警记录要「从告警时刻前 N 秒开始播」，而 N 秒是相对于
   * **告警时刻**说的。只有同时知道片段的起点与告警时刻，才能算出"告警时刻落在片段里的
   * 第几毫秒"，进而决定往回跳多少。缺了它就只能从片段开头播，那与请求的秒数**是否
   * 真的被满足**就无从判断了（环形缓冲区的预录时长是可配置的，默认只有 10 秒）。
   */
  startTimeMs: number
  /** Decimated signed waveform, for the overview strip. */
  waveform: number[]
  /** Coarse frequency content of the clip, for the spectrum panel. */
  spectrum?: number[]
  /** Width of one spectrum bin in Hz. */
  spectrumBinHz?: number
}

// ---------------------------------------------------------------------------
// 本地异常声纹样本库（schema v7）
// ---------------------------------------------------------------------------

/**
 * 听诊盒子族的设备状态（`GET /workmode` + `GET /system` + `GET /basic`）。
 *
 * 三个读取**分开报告**：`/workmode` 通了但 `/system` 失败是完全可能的一件事，而把两者揉成
 * 一个"读取失败"会让界面无法说明白是设备没回还是我们没问到。所以 `paramsError` 单独一格。
 */
export interface E2DeviceStatus {
  /**
   * 这一台是**哪一代**（2026-09-17：拿到 Air Sonar V3.2 手册之后，这一族确定有两代）。
   *
   * `undefined` = 设备回话里认不出来（固件可能比手册新）。那时界面照实说"读不懂它的参数"，
   * 而不是按某一代去解释 —— 按错的端点查日志会让"设备没有日志"看起来像事实。
   */
  variant?: E2Variant
  /** 认得出来的工作模式；**Air Sonar 没有这个概念**，所以这时它缺席（`rawWorkMode` 也是空）。 */
  mode?: E2WorkMode
  rawWorkMode: string
  samplerate?: number
  stftPicHeight?: number
  stftPicWidth?: number
  /** `GET /system` 的**原样**键值对（不裁剪：设备多给或少给本身就是信息）。 */
  params: Record<string, unknown>
  /** `/system` 或 `/workmode` 失败时的原因（两者分开上报，不合成一句"读取失败"）。 */
  paramsError?: string
  basic: {
    devName?: string
    devType?: string
    devVersion?: string
    upgradeTime?: string
    webVersion?: string
    equipNumber?: string
  }
  /** 从型号字符串读出来的通道数（`AS16` ⇒ 16）；读不出来就缺席，**不猜**。 */
  channelCount?: number
  /** 设备只保留这么多条告警（手册写明 5000）。 */
  alarmLogRetention: number
  /** 一次同步最多处理多少条（界面的措辞用它，不要自己写死一个数）。 */
  maxSyncLimit: number
}

export interface E2SyncRequest {
  limit?: number
  since?: number
  downloadAudio?: boolean
  downloadSpectrograms?: boolean
  /** Air Sonar 的 dB 门槛（来自设备 /system 的 db_limit）：低于它的日志不落成告警。 */
  dbLimit?: number
}

/**
 * 一次同步的结果。
 *
 * 计数刻意分得很细：`alarmsExisting`（幂等命中）与 `audioFailed`（真失败）是两件事，
 * 而 `filesMissing`（设备上文件已被清掉）又是第三件 —— 合并成一个"跳过 N 条"
 * 会让操作员无法判断下一步该做什么。
 */
export interface E2SyncOutcome {
  deviceLogCount?: number
  logsSeen: number
  skippedBySince: number
  skippedBadTime: number
  /** Air Sonar：因 db_value 低于设备 db_limit 而未落成告警的条数。 */
  skippedByDbThreshold: number
  alarmsCreated: number
  alarmsExisting: number
  filesMissing: number
  audioSaved: number
  audioExisting: number
  audioFailed: number
  spectrogramsSaved: number
  spectrogramsFailed: number
  /**
   * 有多少条告警的**抓图目录真的落库了**（v12）。
   *
   * 与 `spectrogramsSaved` 分开报：那一项是"下载了几张图"（设备侧事实），这一项是
   * "有几条告警现在能从界面上点开看图"（本机侧结果）。两者不一致时（例如下载失败、
   * 目录写库失败）就是需要排查的错误，合成一个数会把这件事藏起来。
   */
  snapshotsLinked: number
  errors: string[]
}

/**
 * 一条告警的抓图视图（业主 2026-09-17 第 8 批第 2 条）。
 *
 * 三种情况必须分得开（这是这一块最容易骗人的地方）：
 *   - `ok`：磁盘上有图，`files` 里每条带着回环地址；
 *   - `not-captured`：**设备上本来就没有**（`alarms.snapshot_dir IS NULL`，例如同步时没打开
 *     抓图下载、或那台设备的球机没配对）—— 这是设备事实，不是我们坏了；
 *   - `files-gone`：目录记在库里，但磁盘上的文件已经不在了（换过存储根目录、被手工删掉）——
 *     这是本机事实，与上一条完全不同。
 */
export interface E2AlarmSnapshotView {
  state: 'ok' | 'not-captured' | 'files-gone'
  /** 有图时：文件名 + 可交给 `<img src>` 的回环地址。 */
  files: Array<{ name: string; url: string }>
  /** 库里的目录（存储根相对）；`not-captured` 时缺席。 */
  relativeDir?: string
}

/**
 * 一条样本在 IPC 上的形状。
 *
 * 与仓库层 `Sample` 几乎一致，但**刻意重复**了标签的两个字段而不是嵌一个对象：
 * 渲染层的表单要能分别处理"改了文字、还没选来源"这种中间状态，而 `SampleLabel`
 * 在域层是"两者必须都有"的（那是**落库**的约束，不是编辑中的约束）。
 */
export interface SampleView {
  id: string
  recordingId?: string
  deviceId: string
  channelId: number
  source: SampleSource
  capturedAt: number
  durationMs?: number
  sampleRate?: number
  relativePath?: string
  /**
   * **两个维度**的标签（业主 2026-09-16 追加）。`fault` 是 v7 那一个（设备位图的弱标签也落在
   * 这一维），`equipment` 是新的（设备从不告诉我们它装在什么设备上）。
   */
  faultLabel?: string
  faultLabelSource?: SampleLabelSource
  equipmentLabel?: string
  equipmentLabelSource?: SampleLabelSource
  /** 已有特征维度（缺失的键**不存在**，不是 0）。 */
  metrics: Partial<Record<TrendMetric, number>>
  createdAt: number
  /** 这一条够不够进训练集，以及不够的原因（界面照它说明，而不是只说"不可用"）。 */
  trainable: { usable: boolean; reason?: 'no-label' | 'missing-metrics'; missing?: TrendMetric[] }
}

/** 标签库里的一条（含**现场数出来**的引用数，界面靠它决定能不能删）。 */
export interface SampleLabelEntry {
  id: string
  name: string
  /** 有多少条样本正在用这个名字。 */
  usedBy: number
  createdAt: number
  updatedAt: number
}

export interface SampleLabelListResult {
  equipment: SampleLabelEntry[]
  fault: SampleLabelEntry[]
}

/**
 * 标签库写操作的结果。
 *
 * 失败**带原因**而不是只回 `false`：`in-use`（还有 N 条样本在用）与 `duplicate`（这一维里
 * 已经有同名）是两种完全不同的处置，界面必须能分别说话。
 */
export interface SampleLabelMutationResult {
  ok: boolean
  reason?: 'not-found' | 'duplicate' | 'in-use'
  id?: string
  name?: string
  /** `add` 时：这一次是真新增还是命中了同名（幂等）。 */
  created?: boolean
  /** 删除被拒时的引用数。 */
  usedBy?: number
  /** `rename` 时被一起改掉的样本条数。 */
  affectedSamples?: number
}

export interface SampleQuery {
  deviceId?: string
  channelId?: number
  /** 故障类型（精确匹配库里存的写法）。 */
  faultLabel?: string
  faultLabelSource?: SampleLabelSource
  /** 设备类型。 */
  equipmentLabel?: string
  equipmentLabelSource?: SampleLabelSource
  source?: SampleSource
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface SamplePage {
  items: SampleView[]
  total: number
  limit: number
  offset: number
}

export interface SampleStats {
  total: number
  /**
   * 两个维度各自每个类别各几条 —— 类别不平衡是"模型只在多数类上好看"的根源。
   *
   * 分开数而不是合成一个：故障类型通常以设备位图为主、设备类型几乎全是人工，合成一个
   * 数字之后，两边的构成都读不出来。
   */
  byFaultLabel: Record<string, number>
  byEquipmentLabel: Record<string, number>
  /** 各维度的标签来源构成（`unlabelled` 单独一档）：数据集的可信度构成。 */
  faultSource: Record<SampleLabelSource | 'unlabelled', number>
  equipmentSource: Record<SampleLabelSource | 'unlabelled', number>
  /** 有多少条**真的能进训练集**（人工故障类型 + 必报维度齐）。 */
  trainable: number
}

/**
 * 入库结果。
 *
 * `created: false` 是幂等命中（同一条录音同一时刻同一来源已经在库里），**不是失败**；
 * `metricsStored` 说明这次到底带进来了几维特征 —— 手动录音经常一维都取不到，
 * 那时界面必须说"已入库，但没有特征值，暂时不能参与训练"，而不是假装存下了全部信息。
 */
export interface SampleAddOutcome {
  id: string
  created: boolean
  metricsStored: number
  label?: string
  labelSource?: SampleLabelSource
}

/**
 * 批量入库的汇总。
 *
 * `existing` 是**幂等命中**（那条告警已经在库里了），不是失败：操作员选了 12 条、
 * 其中 3 条上次已经加过，正确的说法是"新增 9、已在库 3"，而不是"失败 3"。
 * `failed` 才是真失败（告警不存在）。
 *
 * `withMetrics` 与 `metricsStored` 分开：前者数**条数**、后者数**维度之和**。
 * 只报维度之和时"12 条全都入库了但只有 3 条带特征"这个事实读不出来。
 */
export interface SampleBulkAddOutcome {
  requested: number
  created: number
  existing: number
  failed: number
  withMetrics: number
  metricsStored: number
  labelled: number
}

/**
 * 数据集导出（供**外部**二次训练用，见 `docs/Ivms4200-UX-REFERENCE.md` §15.24）。
 *
 * 导出的是**清单**：`dataset.jsonl`（每行一条样本，含特征与标签来源）+ `labels.csv`
 * （表格软件直接能开）。音频文件**不默认复制** —— `copyAudio` 为真时才另存到
 * `<目录>/audio/`。理由：一次导出可能是几百兆，而训练常常就在同一台机器上读原路径；
 * 默认复制会让"只是导个清单"变成一次磁盘占满。
 */
export interface SampleExportRequest {
  directory: string
  copyAudio?: boolean
  /** 只导出**已标注**的样本（未标注的进不了监督训练，但清单里留着也常常有用）。 */
  onlyLabelled?: boolean
}

export interface SampleExportResult {
  directory: string
  jsonlPath: string
  csvPath: string
  /** 数据集自述文件（维度顺序、各类别条数、导出时间）—— 训练脚本靠它对齐特征。 */
  infoPath: string
  /** 写进清单的样本条数（`onlyLabelled` 时是已标注的那部分）。 */
  samples: number
  labelled: number
  /** 只导出已标注时，被这条规则挡在外面的条数（如实报，不静默丢）。 */
  skippedUnlabelled: number
  audioCopied: number
  audioMissing: number
  audioBytes: number
}

/**
 * AI 标注的状态（可插拔，业主 2026-09-16）。
 *
 * **密钥本身永不经过 IPC**：只回一个 `apiKeyStored` 布尔。渲染层没有理由拿到它，
 * 而一旦拿得到，它就会出现在某个 devtools 截图或日志里。
 *
 * `ready` 与 `blockedReason` 都由主进程按域层的纯函数算好（`describeAiReadiness()`）：
 * 界面照它说"没开 / 没填地址 / 地址不合法 / 没填模型"，而不是笼统地灰着按钮。
 */
export interface SampleAiStatus {
  enabled: boolean
  endpoint: string
  model: string
  apiKeyStored: boolean
  /** 系统加密可用时才存得下密钥（不可用时失败关闭）。 */
  canStoreApiKey: boolean
  ready: boolean
  blockedReason?: 'disabled' | 'no-endpoint' | 'bad-endpoint' | 'no-model'
  promptVersion: number
  maxBatch: number
  timeoutMs: number
}

export interface SampleAiConfigInput {
  enabled: boolean
  endpoint: string
  model: string
  /** `undefined` = 不动已存的密钥；`null` 或空串 = 清除。 */
  apiKey?: string | null
}

/**
 * 一条命名 AI 服务的对外摘要（业主追加：设置里「不同 AI 服务」）。
 *
 * **密钥本体永不出现**：只带 `apiKeyStored` 布尔（与 `SampleAiStatus` 同一纪律——
 * 渲染层没有理由拿到密钥，拿得到就会出现在某张 devtools 截图里）。
 */
export interface SampleAiServiceSummary {
  id: string
  name: string
  provider: AiServicePresetId
  endpoint: string
  model: string
  apiKeyStored: boolean
}

/**
 * 服务库 + 当前启用项的完整状态（`SAMPLE_AI_SERVICES` 通道的返回）。
 *
 * `ready`/`blockedReason` 描述的是**当前启用**那一服务（与 `SampleAiStatus` 同一份
 * `describeAiReadiness()` 判据）；没有启用任何服务时 `ready=false`、
 * `blockedReason='no-endpoint'`（照实说，不假装有一个配置）。
 */
export interface SampleAiServicesStatus {
  services: SampleAiServiceSummary[]
  activeId: string
  encryptionAvailable: boolean
  canStoreApiKey: boolean
  ready: boolean
  blockedReason?: 'disabled' | 'no-endpoint' | 'bad-endpoint' | 'no-model'
  promptVersion: number
  maxBatch: number
  timeoutMs: number
}

/** `SAMPLE_AI_SERVICE_SAVE` 的入参：新增（无 id）或更新（有 id）一条命名服务。 */
export interface SampleAiServiceInput {
  /** 更新时给；新增不传。 */
  id?: string
  name: string
  provider: AiServicePresetId
  endpoint: string
  model: string
  /**
   * 这个服务的密钥：`undefined` = 不动已存的；`null`/空串 = 清除。
   * 与 `SampleAiConfigInput.apiKey` 同一套三态语义。
   */
  apiKey?: string | null
}

/**
 * 一批 AI 标注的结果。
 *
 * 五个计数刻意分开：`skippedHuman`（人工标签，绝不覆盖）、`skippedWeak`（设备弱标签，
 * 没勾"包含弱标签"时跳过）、`unresolved`（模型自己说"未知"）、`failed`（请求或解析失败）
 * 是**四种不同的原因**，合并成一个"跳过 N 条"会让操作员无法判断下一步该做什么。
 *
 * 两个"多少条"也要分开：
 *   - `considered`：这次**看了一眼**的样本数（默认动作只扫没有人工标签的那些）；
 *   - `requested`：真的**向模型提问**的条数（= considered − skippedWeak `(+skippedHuman)`）。
 * 只报其中一个都会让人误读：报 considered 会以为发了那么多次请求，报 requested 会以为
 * 库里没有别的样本。
 */
export interface SampleAiLabelOutcome {
  considered: number
  /** 真的向模型发出去的请求数（失败的那些也算：请求发出去了）。 */
  requested: number
  labelled: number
  /** 只会在**显式指定样本**时出现：默认动作连看都不看人工标注的样本。 */
  skippedHuman: number
  skippedWeak: number
  unresolved: number
  failed: number
  /** 前几条错误原文（最多 5 条）：只说"失败 3 条"等于没说。 */
  errors: string[]
}

export interface SampleAiLabelRequest {
  /** 指定样本；不传就是"库里所有还没人工标注的"（上限见 `SampleAiStatus.maxBatch`）。 */
  sampleIds?: string[]
  /** 允许覆盖**设备弱标签**（破坏性，默认关：位图信息会被 AI 的猜测替换掉）。 */
  includeWeakLabelled?: boolean
}

/** 训练结果：指标必须带着它的**局限**一起回来（见 `sample-classifier.ts` 的注释）。 */
export interface SampleTrainingReport {
  /** 进了训练集的样本数（只算人工故障类型 + 必报维度齐的）。 */
  trained: number
  /** 库里一共几条、其中多少条被排除，以及按原因分的数量。 */
  total: number
  excluded: { noLabel: number; missingMetrics: number }
  accuracy: number
  /** 训练目标是**故障类型**（声学模型要判的就是它）。 */
  labels: string[]
  counts: Record<string, number>
  confusion: Array<{ expected: string; predicted: string; count: number }>
  /** 只有一个类别 ⇒ 准确率恒为 1，这个数字没有信息量。 */
  degenerate: boolean
  /** 每类样本数 < 2 ⇒ 留一法**结构上**评不了那一类（0% 不代表模型不行）。 */
  unassessable: string[]
  /** 有没有因为上限被截断（训练集不静默截断）。 */
  truncated: boolean
  /**
   * 设备类型的构成 —— **这是训练集质量的一部分，不是装饰**。
   *
   * 「局部放电」在变压器上和开关柜上不是同一种声学现象，而一个故障类别跨了多个设备类型时，
   * 那个类别的中心点实际上是几个不同现象的平均。界面据此提示一句，但**不**擅自阻止训练：
   * 该不该合着训是领域决定，不是程序决定。
   */
  equipment: {
    /** 每个设备类型各有多少条进了训练集（未标注的记在 `unassigned` 里）。 */
    counts: Record<string, number>
    unassigned: number
    /** 训练集里出现了不止一个设备类型（含"有未标注的"）。 */
    mixed: boolean
  }
}

// ---------------------------------------------------------------------------
// The API surface exposed on `window.api`
// ---------------------------------------------------------------------------

export interface RendererApi {
  app: {
    getInfo(): Promise<DeviceResult<AppInfo>>
    /** 上报当前界面语言（主进程的告警弹窗文案要用，见 `ui-locale.ts`）。 */
    setLocale(locale: string): Promise<DeviceResult<void>>
    /** Opens a web/mail link in the system handler; only http(s)/mailto allowed. */
    openExternal(url: string): Promise<DeviceResult<void>>
    /**
     * OS UI languages, most preferred first (e.g. `['tr-TR', 'en-US']`).
     *
     * Used once, on first launch, to pick a starting language. Optional in the
     * bridge so the renderer degrades to the product default rather than failing
     * when it is missing (a dev-server renderer, or a probe build).
     */
    getPreferredLanguages?(): Promise<DeviceResult<string[]>>
    /**
     * 在系统文件管理器中定位一个文件（抓图后的「打开所在文件夹」）。
     *
     * 只接受**存储根内**的路径：主进程会用 `StorageService.resolve()` 校验，
     * 越界一律拒绝——这个通道不能变成「打开任意本地路径」的入口。
     */
    revealFile(path: string): Promise<DeviceResult<void>>
  }

  settings: {
    get(): Promise<DeviceResult<AppSettings>>
    update(patch: AppSettingsPatch): Promise<DeviceResult<AppSettings>>
    pickStorageDir(): Promise<DeviceResult<string | null>>
    diskUsage(): Promise<DeviceResult<DiskUsage>>
    /**
     * 把**系统设置项**恢复成出厂默认值（手册 §17.2 的 Default Value）。
     *
     * **范围**只包括 `SettingsService.RESTORABLE_SETTING_KEYS` 那 13 个键；
     * 设备列表、通道、录像/录音文件、告警记录与账号不在其中，也不会被碰。
     * 界面的确认对话框逐项列出这 13 项，见 `settingsUi.restoreItems*`。
     */
    restoreDefaults(): Promise<DeviceResult<AppSettings>>
    /**
     * 打开原生文件对话框挑一个告警声音文件（只放 `.wav`）。
     *
     * 返回 `null` 表示取消。**文件内容不过 IPC**，只回一个本机绝对路径 ——
     * 试听由渲染层给 `<audio>` 一个 `file://` 地址（见 `AlarmSoundBindingSection`）。
     */
    pickAlarmSound(): Promise<DeviceResult<string | null>>
  }

  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条）。
   *
   * 只有**读**一条：配置写在 `settings.iotIngest` 里（于是"改了就生效"与其它设置同一条
   * 路径：设置一变，主进程那边重新起 / 停监听）。这里回的是监听事实与收数统计。
   */
  ingest: {
    status(): Promise<DeviceResult<IotIngestRuntimeStatus>>
  }

  /**
   * 瓦片缓存下载（业主 20260921 批）：设置「集成 → 地图」卡里发起，
   * 进度靠 `window.events.onMapTileCacheProgress` 推送。写存储根 + 出网下载，
   * 所以与 `settings:update` 同档权限。
   */
  mapTiles: {
    cacheTiles(input: MapTileCacheRequest): Promise<DeviceResult<MapTileCacheResult>>
  }

  auth: {
    login(input: LoginInput): Promise<DeviceResult<LoginOutcome>>
    logout(): Promise<DeviceResult<void>>
    /** Current session, or a successful `null` when nobody is signed in. */
    session(): Promise<DeviceResult<SessionInfo | null>>
    /** This installation's id, for requesting a recovery code. Public. */
    installId(): Promise<DeviceResult<string>>
    /**
     * 登录页要预填的用户名（总是有）与密码（勾选过、未过期、系统加密可用时才有）。
     *
     * `expired` 为真表示"曾经记住过、现在过了 90 天"——界面据此提示重新输入；
     * `persistent` 为假表示这台机器上系统加密不可用，密码不会被记住。
     */
    rememberedLogin(): Promise<DeviceResult<RememberedLoginSnapshot>>
    /** 登录成功之后调用；是否记住密码由用户那个勾选框决定。 */
    rememberLogin(input: RememberLoginInput): Promise<DeviceResult<void>>
    /** 清除记忆（用户名与密码一起）。 */
    forgetRememberedLogin(): Promise<DeviceResult<void>>
    changePassword(input: ChangePasswordInput): Promise<DeviceResult<UserSummary>>
    recover(input: RecoverAccountInput): Promise<DeviceResult<UserSummary>>
    listUsers(): Promise<DeviceResult<UserSummary[]>>
    createUser(input: CreateUserInput): Promise<DeviceResult<UserSummary>>
    deleteUser(userId: string): Promise<DeviceResult<void>>
    resetPassword(input: ResetUserPasswordInput): Promise<DeviceResult<UserSummary>>
    setRole(userId: string, role: UserRole): Promise<DeviceResult<UserSummary>>
    /** 逐项改权限（手册 §17.1）：提交的是**全量**勾选态，不是增量。 */
    setPermissions(input: UpdateUserPermissionsInput): Promise<DeviceResult<UserSummary>>
    /** 「从…复制权限」：把来源账户的生效权限搬到目标账户。 */
    copyPermissions(input: CopyUserPermissionsInput): Promise<DeviceResult<UserSummary>>
    /** 改显示名称（Edit User 的一部分；用户名与角色不走这条通道）。 */
    updateProfile(input: UpdateUserProfileInput): Promise<DeviceResult<UserSummary>>
  }

  devices: {
    list(): Promise<DeviceResult<Device[]>>
    get(id: string): Promise<DeviceResult<Device>>
    add(input: AddDeviceInput): Promise<DeviceResult<Device>>
    update(input: UpdateDeviceInput): Promise<DeviceResult<Device>>
    remove(id: string): Promise<DeviceResult<void>>
    probe(input: Omit<AddDeviceInput, 'name'>): Promise<DeviceResult<ProbeResult>>
    refreshStatus(id?: string): Promise<DeviceResult<Device[]>>
    getInfo(id: string): Promise<DeviceResult<DeviceInfo>>
    getChannels(id: string): Promise<DeviceResult<Channel[]>>
    openWebUi(id: string): Promise<DeviceResult<void>>
    /**
     * 这台设备的推流地址与秘钥（业主 2026-09-18 第 10 批第 5 条）。
     *
     * **首次读取会生成一条秘钥**（写库 + 读回核对），所以它不是一个纯读动作 ——
     * 调用点只有"添加/编辑设备"那个对话框（秘钥在那里要么给设备端配置、要么复制走）。
     */
    ingestEndpoint(id: string): Promise<DeviceResult<DeviceIngestEndpoint>>
    /** 换一条秘钥（旧的立刻失效），返回**读回来**的那一份端点信息。 */
    rotatePushSecret(id: string): Promise<DeviceResult<DeviceIngestEndpoint>>
  }

  /**
   * 听诊盒子族（E2 / FA100 / FA110）的「拉」通道（业主 2026-09-16）。
   *
   * 两条通道分工明确：`status` 只**读**（工作模式 + 参数 + 设备信息 + 保留条数），
   * `syncAlarms` 才**写**（把设备上的告警与录音拉到本机库）。
   *
   * ⚠️ 手册里的 `PUT /system`（写参数）**不在**这两条里 —— 业主这一轮要的是「按模式**读**参数」，
   * 写参数要额外决定"改了就存还是点了才存"，那是另一件事（与设置页的自动保存同一条设计问题）。
   *
   * 2026-09-17 第 8 批补：`PUT /system` 终于有了它唯一的用户 —— 空气声呐的**球机联动配置**
   * （`E2_PTZ` / `E2_PTZ_UPDATE`）。它之所以能落地，正是因为那一条需求回答了上面那个问题：
   * **只有"保存"按钮才写**（PTZ 是现场调试动作，改错一个端口会让球机失联，不能边打字边写设备）。
   * 门限参数那一组（`db_limit` 等）仍然只读 —— 要不要让它们在界面上可写是另一条需求。
   */
  e2: {
    /** 读一次设备状态。`params` 是 `GET /system` 的**原样**键值对（三种模式字段不同）。 */
    status(deviceId: string): Promise<DeviceResult<E2DeviceStatus>>
    /** 拉一批告警与录音。幂等：反复点只写一次（见 `E2SyncService` 的文件头）。 */
    syncAlarms(
      deviceId: string,
      request: E2SyncRequest
    ): Promise<DeviceResult<E2SyncOutcome>>
    /**
     * 读空气声呐的**球机联动（PTZ）配置**（业主 2026-09-17 第 8 批）。
     *
     * 只有 `airSonar` 这一代有（2023 版听诊盒子没有球机这个概念），别的机型回明确的机型错误。
     */
    ptz(deviceId: string): Promise<DeviceResult<E2PtzConfig>>
    /**
     * 写球机联动配置：**读 → 改 → 整份 `PUT /system` → 再读 → 逐项核对**。
     *
     * 返回值里的 `fields` 就是读回核对的结果（哪一项生效、哪一项没有），界面照它显示 ——
     * 不拿"请求发出去了"当成功。
     */
    updatePtz(deviceId: string, patch: E2PtzPatch): Promise<DeviceResult<E2PtzUpdateOutcome>>
    /** 与球机对时（`PUT /time_sync_with_nvt`；手册**只列了端点，没写请求体**）。 */
    syncNvtTime(deviceId: string): Promise<DeviceResult<E2NvtTimeSyncOutcome>>
    /**
     * 一条告警的**抓图**（本机文件，业主 2026-09-17 第 8 批第 2 条）。
     *
     * 返回主进程回环 HTTP 上的地址（含每会话令牌），图片字节不过 IPC —— 与本地录像回放
     * 同一条做法（`VideoFileServer`）。`state` 把三种情况分开：
     * `ok`（有图）/ `not-captured`（设备上本来就没有，`snapshot_dir IS NULL`）/
     * `files-gone`（记了目录，但文件已经不在磁盘上了）。
     */
    alarmSnapshots(
      deviceId: string,
      alarmId: string
    ): Promise<DeviceResult<E2AlarmSnapshotView>>
    /**
     * 关掉上一次打开的抓图端点。
     *
     * 界面离开这一条告警（或离开点位图）时调用：主进程一次只留一个端点，但"离开"这个动作
     * 只有界面知道，让那个端口挂到 TTL 到点（30 分钟）是一种浪费。TTL 仍然是兜底。
     */
    closeSnapshots(): Promise<DeviceResult<void>>
    /** SN-16 realtime callback status (owner spec 20). Read-only; no secret echo. */
    realtimeCallback(deviceId: string): Promise<DeviceResult<E2RealtimeCallbackStatus>>
    /** Enable/disable the local realtime_value receiver; writes notify_url + is_send_realtime_value and reads back. */
    setRealtimeCallback(
      deviceId: string,
      enabled: boolean
    ): Promise<DeviceResult<E2RealtimeCallbackOutcome>>
  }

  overview: {
    stats(): Promise<DeviceResult<OverviewStats>>
    recentAlarms(limit?: number): Promise<DeviceResult<AlarmEvent[]>>
  }

  alarms: {
    query(query: AlarmQuery): Promise<DeviceResult<AlarmPage>>
    acknowledge(ids: string[], acknowledged: boolean): Promise<DeviceResult<number>>
    /**
     * 写/清除一条告警的操作员备注。`null` 清除。
     *
     * 返回 `false` 表示**这条告警已经不在库里**（被保留策略清掉了），不是失败——
     * 界面要能区分「存下了」与「这条已经没了」。长度上限由主进程校验（500 字符），
     * 越界会以 `result.ok === false` 回来而不是抛异常。
     */
    setNote(alarmId: string, note: string | null): Promise<DeviceResult<boolean>>
    /** 人工改判等级。理由见 `alarm-repository.ts` 的 `setSeverity()`。 */
    setSeverity(alarmId: string, severity: EventSeverity): Promise<DeviceResult<boolean>>
    /** 列表页的等级分面：每一档各有多少条（与 `query` 的其余筛选条件同源）。 */
    countBySeverity(query?: AlarmQuery): Promise<DeviceResult<Record<EventSeverity, number>>>
  }

  recordings: {
    query(query: RecordingQuery): Promise<DeviceResult<RecordingPage>>
    syncDevice(deviceId: string): Promise<DeviceResult<number>>
    /**
     * 把一条本机录音**另存为**到操作员选的位置（保存对话框 + 复制文件）。
     * 返回 `{ path }`；取消对话框返回 `null`。**权限归 `viewRecordings`**。
     */
    export(recordingId: string): Promise<DeviceResult<{ path: string } | null>>
  }

  /**
   * 连续录像（RTSP 取流存储）。
   *
   * `status()` 返回**全部被要求录像的设备**（不只是正在出的帧的那些）；界面据此显示
   * "在录 / 等待 / 退避"，不需要自己记住开过哪些。
   */
  recorder: {
    status(): Promise<DeviceResult<RecorderStatusView[]>>
    setEnabled(input: RecorderSetEnabledInput): Promise<DeviceResult<RecorderStatusView | null>>
  }

  /**
   * 本地异常声纹样本库（schema v7，业主 2026-09-16）。
   *
   * 权限归 `viewRecordings`：这个库是**从录音派生的**（告警录音与手动录音都是），
   * 而打标签/删样本是**对派生物的注解**，不动录音本身、不删录音文件。给它单开一项权限
   * 会让账号管理界面多一个复选框，而那件事与"能不能看录音"是同一件事。
   */
  samples: {
    /** 列表 + 筛选 + 总数。 */
    query(query: SampleQuery): Promise<DeviceResult<SamplePage>>
    /** 统计：总数、按类别、按**标签来源**（数据集的可信度构成）。 */
    stats(): Promise<DeviceResult<SampleStats>>
    /** 把一条**告警**（它自带特征值）加进样本库，并用告警位图给一个弱标签。 */
    addFromAlarm(alarmId: string): Promise<DeviceResult<SampleAddOutcome>>
    /** 批量入库（操作员在告警中心勾一批）。汇总见 `SampleBulkAddOutcome`。 */
    addFromAlarms(alarmIds: string[]): Promise<DeviceResult<SampleBulkAddOutcome>>
    /** 把一段**录音**加进样本库（手动录音与告警录音都走这条）。 */
    addFromRecording(recordingId: string): Promise<DeviceResult<SampleAddOutcome>>
    /** 选一个导出目录（只开原生对话框，什么都不写）。取消返回 `null`。 */
    pickExportDirectory(): Promise<DeviceResult<string | null>>
    /** 把一个数据集清单写到指定目录（音频是否复制由 `copyAudio` 决定）。 */
    exportDataset(request: SampleExportRequest): Promise<DeviceResult<SampleExportResult>>
    /** AI 标注的状态（含"为什么不能用"）。密钥只回 `apiKeyStored`，不回内容。 */
    aiStatus(): Promise<DeviceResult<SampleAiStatus>>
    /** 保存 AI 配置；返回保存后的状态（界面不用自己拼一遍）。 */
    saveAiConfig(input: SampleAiConfigInput): Promise<DeviceResult<SampleAiStatus>>
    /** 命名的 AI 服务库 + 当前启用项状态（密钥只回"存没存"布尔）。 */
    aiServices(): Promise<DeviceResult<SampleAiServicesStatus>>
    /** 新增/更新一条命名服务；`input.id` 缺省 = 新增。 */
    saveAiService(input: SampleAiServiceInput): Promise<DeviceResult<SampleAiServicesStatus>>
    /** 删除一条命名服务（连同它的密钥）；删的是当前启用项则启用回落到第一条/空。 */
    deleteAiService(id: string): Promise<DeviceResult<SampleAiServicesStatus>>
    /** 选用哪条服务为当前启用（空串 = 全部不启用）。 */
    setActiveAiService(id: string): Promise<DeviceResult<SampleAiServicesStatus>>
    /**
     * 让配置好的大模型给一批样本**提候选标签**（`label_source = 'ai'`）。
     *
     * AI 标签**不**进训练集（`isTrainable()` 只认 `human`），也**不会**覆盖人工标签。
     */
    aiLabel(request: SampleAiLabelRequest): Promise<DeviceResult<SampleAiLabelOutcome>>
    /** 写某一维的标签或撤销标注（`null` = 退回未标注）。打标签时用到的新名字会自动进标签库。 */
    setLabel(
      sampleId: string,
      dimension: SampleLabelDimension,
      label: string | null,
      source: SampleLabelSource
    ): Promise<DeviceResult<boolean>>
    /** 标签库：两个维度各自的清单 + 引用数。 */
    labels(): Promise<DeviceResult<SampleLabelListResult>>
    /** 加一条（同名幂等：返回 `created: false`）。 */
    addLabel(dimension: SampleLabelDimension, name: string): Promise<DeviceResult<SampleLabelMutationResult>>
    /** 改名，并**连样本一起改**（返回 `affectedSamples`）。 */
    renameLabel(id: string, name: string): Promise<DeviceResult<SampleLabelMutationResult>>
    /** 删除；还有样本在用就拒绝并回 `in-use` + `usedBy`。 */
    removeLabel(id: string): Promise<DeviceResult<SampleLabelMutationResult>>
    remove(sampleId: string): Promise<DeviceResult<boolean>>
    /**
     * 用**人工标签**训练基线分类器并做留一法评估。
     *
     * 返回里带 `degenerate` / `unassessable` / 混淆矩阵 —— 指标必须带着它的**局限**一起回来，
     * 否则界面只能报一个孤零零的准确率。
     */
    train(): Promise<DeviceResult<SampleTrainingReport>>
  }

  /**
   * Device configuration (Phase 9).
   *
   * Every `update*`/`save*`/`set*` call performs READ-MODIFY-WRITE on the main
   * side. Callers pass only the fields they changed; the service reads the
   * current state and submits the complete object, because FA8 write endpoints
   * replace rather than patch.
   */
  config: {
    getChannels(deviceId: string): Promise<DeviceResult<ChannelConfigView[]>>
    updateChannel(
      deviceId: string,
      channelIndex: number,
      patch: Partial<Omit<ChannelConfigView, 'channelIndex'>>
    ): Promise<DeviceResult<ChannelConfigView[]>>

    getSampleRate(deviceId: string): Promise<DeviceResult<number>>
    setSampleRate(deviceId: string, sampleRate: number): Promise<DeviceResult<number>>

    getAlarmProfiles(deviceId: string): Promise<DeviceResult<AlarmProfileConfig[]>>
    saveAlarmProfile(
      deviceId: string,
      profile: AlarmProfileConfig
    ): Promise<DeviceResult<AlarmProfileConfig[]>>
    deleteAlarmProfile(deviceId: string, profileId: number): Promise<DeviceResult<AlarmProfileConfig[]>>

    getNetwork(deviceId: string): Promise<DeviceResult<NetworkConfigView>>
    /**
     * Change the device address.
     *
     * SLOW and RISKY: the main process applies the change, polls the new address
     * until the device answers, and rolls back to the snapshot if it does not.
     * Expect up to ~45 seconds and drive the UI from `onNetworkProgress` pushes.
     */
    changeNetwork(
      deviceId: string,
      next: NetworkConfigView
    ): Promise<DeviceResult<NetworkChangeResult>>

    getTime(deviceId: string): Promise<DeviceResult<TimeConfigView>>
    updateTime(
      deviceId: string,
      patch: Partial<Omit<TimeConfigView, 'deviceTime'>>
    ): Promise<DeviceResult<TimeConfigView>>
    /** Set the device clock from this host's clock. */
    syncTime(deviceId: string): Promise<DeviceResult<TimeConfigView>>

    getRs485(deviceId: string): Promise<DeviceResult<Rs485ConfigView>>
    updateRs485(
      deviceId: string,
      patch: Partial<Rs485ConfigView>
    ): Promise<DeviceResult<Rs485ConfigView>>
    getSerialPorts(deviceId: string): Promise<DeviceResult<string[]>>

    getModbus(deviceId: string): Promise<DeviceResult<ModbusConfigView>>
    updateModbus(
      deviceId: string,
      patch: Partial<ModbusConfigView>
    ): Promise<DeviceResult<ModbusConfigView>>

    getPush(deviceId: string): Promise<DeviceResult<PushConfigView>>

    setDeviceName(deviceId: string, name: string): Promise<DeviceResult<void>>
  }

  /**
   * Device maintenance (Phase 10).
   *
   * ALL THREE CONTROL OPERATIONS ARE DESTRUCTIVE. The renderer is responsible
   * for confirming with the user; these methods execute immediately. Factory
   * reset in particular should require the user to type `RESET`.
   */
  maintenance: {
    reboot(deviceId: string): Promise<DeviceResult<void>>
    factoryReset(deviceId: string): Promise<DeviceResult<void>>
    systemUpgrade(deviceId: string): Promise<DeviceResult<void>>
    /** Opens a native file dialog; returns null when the user cancels. */
    pickFirmware(): Promise<DeviceResult<string | null>>
    /** Uploads a previously picked package. Reads the file in the main process. */
    uploadFirmware(deviceId: string, filePath: string): Promise<DeviceResult<{ bytes: number }>>
  }

  /**
   * Historical trend queries (Phase 11).
   *
   * Results are ALWAYS bucketed. A day of one channel at 1 Hz is 86,400 points
   * and a month is 2.6 million; the main process picks a bucket size from the
   * requested span so a chart receives roughly 500 points. Callers pass `from`
   * and `to` and do not need to think about sampling.
   */
  trends: {
    /**
     * Query a bucketed trend series.
     *
     * Takes `deviceId` (the local row id the UI already holds), NOT `deviceUid`:
     * the uid is the on-disk directory identity, and handing it to the renderer
     * would leak the storage layout into the presentation layer. The main process
     * translates.
     */
    query(query: TrendQueryBody): Promise<DeviceResult<TrendSeries>>
    /** Time range actually covered by stored data, for bounding date pickers. */
    coverage(deviceId: string): Promise<DeviceResult<TrendCoverage>>
    /** Buffered/written counters, for the Settings diagnostics line. */
    stats(): Promise<DeviceResult<TrendStorageStats>>
    /** Force a flush; used by the Settings page and before an export. */
    flush(): Promise<DeviceResult<{ rows: number; files: number }>>
    /**
     * 把当前这一份趋势数据存成 CSV（业主 2026-09-19 第 13 批第 6 条：「支持数据导出」）。
     *
     * CSV 文本由**渲染层**拼（`@shared/domain/trend-export.ts` 是纯函数，可单测），
     * 主进程只做两件它才知道怎么做的事：挑目录、写盘并**读回核对**。
     *
     * `fileName` 只允许是一段文件名（不含路径分隔符）：真正写到哪儿由主进程决定
     * （存储根下的 `exports/trends/`），渲染层没有、也不该有"随便写一个路径"的能力。
     */
    exportCsv(input: TrendExportRequest): Promise<DeviceResult<TrendExportResult>>
  }

  protocol: {
    diagnose(deviceId: string): Promise<DeviceResult<DiagnoseReport>>
    probeEndpoint(deviceId: string, path: string, method?: string): Promise<DeviceResult<EndpointProbeResult>>
  }
  /**
   * Realtime monitoring. `start` opens WebSocket subscriptions in the main
   * process and begins pushing frames; `stop` closes them and releases the
   * Ring Buffer.
   */
  monitor: {
    start(subscription: MonitorSubscription): Promise<DeviceResult<MonitorState>>
    stop(deviceId?: string): Promise<DeviceResult<void>>
    state(deviceId?: string): Promise<DeviceResult<MonitorState[]>>
    startRecording(input: StartRecordingInput): Promise<DeviceResult<RecordingResult>>
    stopRecording(deviceId: string): Promise<DeviceResult<RecordingResult>>
  }

  /**
   * FA371 acoustic camera realtime streams (manual §5.2).
   *
   * `start` opens the camera's WebSocket channels in the main process (no
   * subscribe message — the device pushes on connect) and begins forwarding
   * DECIMATED previews on `window.events.onFa371*`.
   *
   * ADMINISTRATOR REQUIRED for start/stop. The rule stated at the top of
   * `handlers.ts` guards operations that change what the hardware does; opening
   * or closing a camera's live socket is a device operation (it makes the
   * camera push data, and it can flood the IPC bridge), while `state` is a read
   * and stays operator-visible.
   */
  fa371Stream: {
    start(subscription: Fa371StreamSubscription): Promise<DeviceResult<Fa371MonitorState>>
    stop(deviceId?: string): Promise<DeviceResult<void>>
    state(deviceId?: string): Promise<DeviceResult<Fa371MonitorState[]>>
    /** Channel kinds the camera exposes, so the UI need not hard-code them. */
    kinds(): Fa371StreamKind[]
  }

  /**
   * FA371 camera LIVE VIDEO (manual §5.1.6 -> RTSP -> ffmpeg -> loopback HTTP).
   *
   * `start` resolves the camera's RTSP address from `GET /system/video`, verifies the
   * bundled ffmpeg, opens a loopback-only HTTP server and returns the URL for a
   * `<video>` element. The stream itself never crosses IPC — only this small state.
   *
   * ADMINISTRATOR REQUIRED for start/stop, exactly like `fa371Stream`: it is a device
   * operation (it makes the camera open an RTSP connection, which counts against its
   * `rtsp_client_limit`), while `state` is a read and stays operator-visible.
   */
  cameraLive: {
    start(input: CameraLiveStartInput): Promise<DeviceResult<CameraLiveState>>
    stop(deviceId?: string): Promise<DeviceResult<void>>
    state(deviceId?: string): Promise<DeviceResult<CameraLiveState[]>>
    /**
     * 当前会话可用的 RTSP 地址（**含口令**），供「复制」「在外部播放器打开」。
     *
     * ADMINISTRATOR REQUIRED，并且每次调用都会写进应用日志：这是唯一一处把
     * 设备口令交给渲染层的地方。没有活动会话时返回 `null`（如实：没有可用的源）。
     */
    source(deviceId: string): Promise<DeviceResult<CameraLiveSource | null>>
    /**
     * 本机同时直播的预算与当前用量。
     *
     * 与 `state()` 分开：`state()` 只回答「每台相机这一路怎么样了」，而视频墙在
     * 分配格子之前要回答的是「本机还能不能再来一路」。两者都不是设备事实，
     * 但一个是逐会话的，一个是全局的，混在一个返回值里会让界面自己去求和。
     * 渲染层拿不到这个通道时（开发环境、旧 preload）退回同一个默认常量。
     */
    limits(): Promise<DeviceResult<CameraLiveLimits>>
  }

  /**
   * 相机 NVR 采集：手动录像与抓图。
   *
   * ADMINISTRATOR REQUIRED for both actions: they make the camera open ANOTHER
   * RTSP connection (its `rtsp_client_limit` is finite) and they write files into
   * the storage root. `recordingState` is a read and stays operator-visible.
   *
   * 录像**不是** UI 层的一段动画：主进程再起一个 ffmpeg，`-c:v copy` 直接写
   * MP4，停止时校验 `ftyp`/`moov` 后才登记进录像表（见 `media/camera-capture.ts`）。
   */
  cameraNvr: {
    startRecording(deviceId: string): Promise<DeviceResult<CameraRecordingState>>
    stopRecording(deviceId: string): Promise<DeviceResult<CameraRecordingResult>>
    recordingState(deviceId?: string): Promise<DeviceResult<CameraRecordingState[]>>
    snapshot(deviceId: string): Promise<DeviceResult<CameraSnapshotResult>>
    /**
     * 一段手动录像的可播放地址（回环 HTTP + Range）。
     *
     * 视频录像**不能**走 `playback.load`：那条路把整段文件 base64 推过 IPC，
     * 而它本来就是给几十 KB 的音频用的。拿不到地址时返回一个如实说明的失败
     * （文件不存在 / 不是视频），界面据此明说「无法播放」，而不是给一个空播放器。
     */
    videoUrl(recordingId: string): Promise<DeviceResult<VideoPlaybackSource>>
  }

  /**
   * 相机告警模型（手册 §5.1.22 – §5.1.29）：告警策略与告警条件。
   *
   * 读取不加管理员校验，写入加——与 `handlers.ts` 顶部的规则一致。
   * 每一个写入方法返回**重新读取后的完整列表**：手册没有规定新建时如何回传新
   * id（§8.3 C22），所以界面靠重读来认领新行，而不是猜一个 id。
   */
  cameraAlarms: {
    listStrategies(deviceId: string, page?: number): Promise<DeviceResult<CameraAlarmStrategyPage>>
    createStrategy(
      deviceId: string,
      draft: CameraAlarmStrategyDraft,
      diagnosisKey?: CameraAlarmDiagnosisKeyStyle
    ): Promise<DeviceResult<CameraAlarmStrategyPage>>
    updateStrategy(
      deviceId: string,
      draft: CameraAlarmStrategyDraft,
      diagnosisKey?: CameraAlarmDiagnosisKeyStyle
    ): Promise<DeviceResult<CameraAlarmStrategyPage>>
    deleteStrategies(deviceId: string, ids: number[]): Promise<DeviceResult<CameraAlarmStrategyPage>>

    listConditions(deviceId: string, page?: number): Promise<DeviceResult<CameraAlarmConditionPage>>
    createCondition(
      deviceId: string,
      draft: CameraAlarmConditionDraft
    ): Promise<DeviceResult<CameraAlarmConditionPage>>
    updateCondition(
      deviceId: string,
      draft: CameraAlarmConditionDraft,
      idStyle?: CameraAlarmConditionIdStyle
    ): Promise<DeviceResult<CameraAlarmConditionPage>>
    deleteConditions(
      deviceId: string,
      ids: number[]
    ): Promise<DeviceResult<CameraAlarmConditionPage>>
  }

  /**
   * 相机控制与维护：检测模式、检测启停、启用中的策略、版本信息与维护能力。
   *
   * 三条约定：
   *   1. **读公开、写要管理员**（与 `cameraAlarms` 一致）：四个读方法不校验，
   *      `writeRunMode` / `turnOnDetect` / `turnOffDetect` / `setStrategyEnabled`
   *      在 `handlers.ts` 里逐个 `requireAdministrator()`。
   *   2. **写方法返回重读结果**：本设备实测过 `ret:200` 却忽略写入的情况
   *      （`PUT /alarm_strategy {Switch:1}`），所以 `writeRunMode` 返回
   *      `{before, after, applied}` 而不是一个"成功"布尔，界面据此显示
   *      「设备应答成功但没有生效」。
   *   3. `turnOnDetect` 在设备没有可用策略时以 `ret:-1` 失败 —— 那不是传输错误，
   *      是带 `msg` 原文的 `DEVICE_ERROR`，界面照原样显示，同时用
   *      `readEnabledStrategy` 让操作员看到"没有策略启用"这个前提。
   */
  cameraControl: {
    /** `GET /run_mode`（手册字段名就是**检测模式**）：`1` 单次检测 / `-1` 智能巡航。 */
    readRunMode(deviceId: string): Promise<DeviceResult<Fa371RunModeConfig>>
    /** `PUT /run_mode` + 重读。返回写前/写后的读数与 `applied`。 */
    writeRunMode(
      deviceId: string,
      mode: Fa371RunModeValue
    ): Promise<DeviceResult<CameraRunModeWriteResult>>
    /** `GET /system/detect_status`。 */
    readDetectStatus(deviceId: string): Promise<DeviceResult<Fa371DetectStatus>>
    /** `GET /system/scan_area`：读取设备检测/告警区域。 */
    readScanArea(deviceId: string): Promise<DeviceResult<Fa371ScanArea>>
    /** `PUT /system/scan_area` + 重读：写入画面上的检测/告警区域。 */
    writeScanArea(deviceId: string, area: Fa371ScanArea): Promise<DeviceResult<CameraScanAreaWriteResult>>
    /** 本机 SQLite：读取该相机告警区域的稳定 id / 编号 / 名称元数据。 */
    readRegionMetadata(deviceId: string): Promise<DeviceResult<CameraAlarmRegionMetadata[]>>
    /** 本机 SQLite：设备区域写后读回成功后，保存与之对应的区域元数据快照。 */
    writeRegionMetadata(
      deviceId: string,
      regions: CameraAlarmRegionMetadataInput[]
    ): Promise<DeviceResult<CameraAlarmRegionMetadata[]>>
    /** `POST /turn_on_detect` + 重读状态。设备无可用策略时以带 `msg` 的失败返回。 */
    turnOnDetect(deviceId: string): Promise<DeviceResult<CameraDetectActionResult>>
    /** `POST /turn_off_detect` + 重读状态。 */
    turnOffDetect(deviceId: string): Promise<DeviceResult<CameraDetectActionResult>>
    /**
     * `GET /alarm_strategy_enable`：当前启用中的策略。
     *
     * 设备**同时只允许一条**策略启用，且开始检测要求至少有一条启用，
     * 所以界面必须拿到它来决定启停按钮是否可用。
     */
    readEnabledStrategy(deviceId: string): Promise<DeviceResult<CameraEnabledStrategyView>>
    /**
     * `PUT /alarm_strategy_enable`：启用/停用一条策略，随后重读。
     *
     * 启用目标时若已有别的策略启用，服务按手册给的顺序**先停用旧的、再启用新的**，
     * 并在 `disabledPrevious` 里如实报出那一步。
     */
    setStrategyEnabled(
      deviceId: string,
      strategyId: number,
      enable: boolean
    ): Promise<DeviceResult<CameraStrategyEnableResult>>
    /**
     * 维护：设备自报的版本 + 能力表。
     *
     * 版本来自 `GET /dev_info` / `GET /basic`（手册未收录、实测存在、设备自带 Web
     * 界面在用）；能力表说明哪些维护动作设备根本不支持（升级/回滚/重启/恢复出厂），
     * 界面据此渲染禁用控件 + 原因，而不是一个假按钮。
     */
    maintenance(deviceId: string): Promise<DeviceResult<CameraMaintenanceInfo>>
    /**
     * 应用模式预设：读当前的成像频带/目标数量，并判断命中哪个预设。
     *
     * 读的是 `GET /system/acoustic` + `GET /system/image`。界面用它显示当前频带，
     * 并在设备本来就等于某个预设时说「已经在这个模式」，而不是让操作员白点一次。
     */
    readModePreset(deviceId: string): Promise<DeviceResult<CameraModePresetRead>>
    /**
     * 应用一个应用模式预设（写 `PUT /system/acoustic` + `PUT /system/image`）。
     *
     * 只写预设**声明**的字段，写完**重读**并逐字段返回
     * `{field, requested, before, after, applied}` —— 本设备实测过 `ret:200`
     * 却忽略写入，所以成功码不是证据，界面显示的必须是 `after`。
     *
     * 预设**不含**成像阈值（手册：Set after observing ambient energy），
     * 所以这个方法永远不会写 `energy_threshold`。
     */
    applyModePreset(
      deviceId: string,
      presetId: CameraModePresetId
    ): Promise<DeviceResult<CameraModePresetWriteResult>>
    /**
     * 还原：把**之前读到**的数值写回去（「撤销刚才那次模式切换」）。
     *
     * 参数就是 `readModePreset()` 或上一次 `applyModePreset()` 返回的
     * `before`/`after` 里那几个数值本身，不重新构造。缺失的字段不写 ——
     * 补一个默认值等于凭空改设备配置。
     */
    restoreModeValues(
      deviceId: string,
      values: CameraModeRequestedValues
    ): Promise<DeviceResult<CameraModePresetWriteResult>>
    /**
     * **应用模式**（局部放电 / 气体泄漏 / 机械异响）：`GET /system`。
     *
     * ⚠ 端点**未文档化** —— 不在任何一份手册里，是设备自带 Web 界面的 bundle 里
     * 读出来的。真机实测可读（`{"msg":"SUCCESS","ret":200,"work_mode":1}`）。
     *
     * 读不到时返回 `available: false`（**不抛错**）：界面据此**不渲染**这个控件，
     * 而不是渲染一个点了必然失败的按钮。认不出的取值只保留原始值，不会就近映射成一个模式。
     *
     * 与 `readRunMode` 的区别：那是**检测模式**（单次 / 巡航，手册 §5.1.8），
     * 这是**应用模式**（这台设备在做哪种应用）。
     */
    readWorkMode(deviceId: string): Promise<DeviceResult<CameraWorkModeRead>>
    /**
     * 切换应用模式：`PUT /system {"work_mode":N}` + **重读**。
     *
     * ⚠ 同上，端点未文档化（实测可写：1/2/3 三值都生效）。
     *
     * 只写 `work_mode` 一个字段，**不碰**任何成像/声学配置 —— 那是
     * `applyModePreset` 那条通道的事。把客户现场调好的成像参数当成切换模式的副作用
     * 悄悄重写，是那种当场看不出来、下次检测结果不对的惊喜，所以两条通道刻意分开。
     *
     * 返回写前/写后的读数与 `applied`（由重读的原始值比对得出）：成功码不是证据 ——
     * 本设备实测过 `ret:200` 却忽略写入，而这个端点连手册都没有。
     */
    writeWorkMode(
      deviceId: string,
      mode: Fa371WorkModeValue
    ): Promise<DeviceResult<CameraWorkModeWriteResult>>

    /**
     * `GET /system/leakage`（§5.1.10）：泄漏估算参数的当前值。
     * 局放→泄漏切换时，计算模板拿它打底（2026-09-24）。
     */
    readLeakage(deviceId: string): Promise<DeviceResult<Fa371LeakageConfig>>
    /**
     * `PUT /system/leakage`（§5.1.11）部分字段更新 + **重读**：返回写前/写后的读数，
     * `after` 是权威值（与 writeWorkMode 同一口径）。写要管理员（它直接参与泄漏量
     * 与成本的计算口径）。
     */
    writeLeakage(deviceId: string, patch: CameraLeakagePatch): Promise<DeviceResult<CameraLeakageWriteResult>>
  }

  /**
   * 相机固件升级（设备自带 Web 界面用的那条 HTTP 路：`POST /upload` +
   * `PUT /reboot` + `GET /progress`）。
   *
   * 三条约定：
   *   1. **上传与重启是两个动作**：`upload()` 成功只说明包被设备收下了，
   *      **不会**触发重启；什么时候升级由操作员在 `reboot()` 上显式决定。
   *   2. **管理员**：`upload` / `reboot` 在 `handlers.ts` 里各自
   *      `requireAdministrator()` 并写审计日志；`inspectPackage` / `readProgress`
   *      是本地读文件与设备只读，不校验。
   *   3. **文件在主进程读**：包按几十 MB 计，渲染层只持有路径。进度通过
   *      `window.events.onCameraUpgradeProgress` 推送（真实字节数）。
   */
  cameraUpgrade: {
    /** 打开原生文件对话框选升级包；用户取消时返回 `null`。 */
    pickPackage(): Promise<DeviceResult<string | null>>
    /**
     * 读一个本地升级包的静态事实：文件名 / 大小 / sha256 / 文件名是否符合
     * **设备自己**的规则（`_V<数字>.<数字>.<数字>` 结尾）。
     *
     * 这一步不碰设备。界面据此在按下上传**之前**就拒绝一个设备必然不收的包，
     * 而不是先传几十 MB 再收一个失败。
     */
    inspectPackage(filePath: string): Promise<DeviceResult<CameraUpgradePackage>>
    /**
     * `POST /upload`：multipart/form-data，两个段 —— 一个**空字段名**携带
     * `{"file_size":N}`，一个 `file` 携带包本身（与设备自带前端逐字一致）。
     *
     * 只有 HTTP 200（且响应体不是设备的业务失败）才算成功。**不重启设备。**
     */
    upload(deviceId: string, filePath: string): Promise<DeviceResult<CameraUpgradeUploadResult>>
    /**
     * `GET /progress`：设备自报的升级进度。
     *
     * ⚠ `upgrade_progress` 的量纲与取值含义**没有文档**（实测空闲时是 `-2`），
     * 所以这里给的是**设备原样的数值**，界面不把它换算成百分比。
     */
    readProgress(deviceId: string): Promise<DeviceResult<CameraUpgradeProgress>>
    /**
     * `PUT /reboot`：重启设备。**独立动作**，由操作员确认后显式发出。
     *
     * 设备可能在应答之前就断开（它要重启了）—— 那种情况由结果里的
     * `connectionDropped` 如实报出，而不是报成"失败"。
     */
    reboot(deviceId: string): Promise<DeviceResult<CameraRebootResult>>
  }

  /** Audio playback for a stored recording (alarm or manual). */
  playback: {
    /** Download (if needed) and decode a recording for the player. */
    load(recordingId: string): Promise<DeviceResult<PlaybackData>>
  }

  /**
   * 告警本地联动（录像 / 弹窗 / 提示 / 邮件）。
   *
   * 读取不加管理员校验、写入加——与 `handlers.ts` 顶部那条规则一致。
   * 引擎**完全由主进程拥有**：界面只是它的一个观察者与配置者，没有任何一条
   * 路径能让渲染层自己触发一次联动。
   */
  linkage: {
    /** 引擎是否在跑、两个触发源的健康度、全局速率用量。 */
    status(): Promise<DeviceResult<LinkageEngineStatus>>
    /** 待处理告警（「提示」的持久化形态）。 */
    pending(): Promise<DeviceResult<PendingAlarmSnapshot>>
    /**
     * 确认待处理告警。不传 id 表示「全部确认」。
     * 返回确认后的完整快照，界面不需要自己推算。
     *
     * ADMINISTRATOR REQUIRED。
     */
    acknowledge(ids?: string[]): Promise<DeviceResult<PendingAlarmSnapshot>>
    /**
     * 发一封测试邮件，并把 SMTP 服务器的**原始回复**带回来。
     *
     * 参数里临时给的口令不会落盘（同 `settings.update` 的规则）；
     * 留空则用已保存的那个。ADMINISTRATOR REQUIRED：它会真的往外发信。
     */
    testEmail(input: LinkageTestEmailInput): Promise<DeviceResult<LinkageTestEmailResult>>
    /**
     * 告诉主进程「告警中心这一屏现在开着/已经离开」。
     *
     * 业主 2026-09-26 第 5 条：告警中心里不该再被非告警类的弹窗/提示打扰。
     * 挡的是**提示窗口的再次弹出**（那个窗口是主进程开的，渲染层关不掉），
     * 不改变任何记录：告警照样进列表、角标照样跳数字、确认照样要人工点。
     *
     * 不需要管理员：它不是写操作，只是把"哪一页在屏幕上"这件渲染层才知道的事
     * 同步给主进程。失败也不抛（返回 `success: false`），调用方据此**不做**任何补救 ——
     * 这条通道没接上时行为与改之前完全一样（会弹），比"因为一次 IPC 失败就再也不弹"安全。
     */
    setAlarmCenterOpen(open: boolean): Promise<DeviceResult<{ open: boolean }>>
  }

  /**
   * 事件与告警中心（产品要求：「设置事件和告警中心。」）。
   *
   * 读取不加管理员校验、写入加——与 `handlers.ts` 顶部那条规则一致。
   * 三路来源的合并在**主进程**完成：渲染层只发一次查询，拿到的是已经排好序、
   * 分好页、并带逐来源读况的结果（其中一路失败时另外两路照样渲染）。
   */
  eventCenter: {
    /**
     * 合并查询三路来源（相机检测日志 / 本机联动 / 声纹告警）。
     *
     * 结果里的 `truncated` 与 `sources[].truncated` 是**诚实的截断说明**：
     * 每路来源都有读取上限，超出的部分不会被静默丢掉。
     */
    query(query: EventCenterQuery): Promise<DeviceResult<EventCenterPage>>
    /**
     * 确认（或取消确认）事件。
     *
     * 按 id 的来源前缀分派：联动走引擎、声纹告警走 SQLite；
     * 设备检测日志**没有**确认接口（手册未定义），因此这类 id 会以
     * `unsupported` 如实回报，而不是被静默忽略。
     *
     * ADMINISTRATOR REQUIRED。
     */
    acknowledge(ids: string[]): Promise<DeviceResult<EventAcknowledgeResult>>
    /**
     * 读一台相机的检测库（`GET /detect_logs`）。
     *
     * 只读，且**没有服务端分页**（手册未定义该类参数）：结果里带设备自己的
     * `logs_count` 与写死的 `paging: 'none'`。
     */
    detectLogs(deviceId: string, detectId?: number): Promise<DeviceResult<EventDetectLibraryPage>>
    /**
     * 下载一个检测结果文件并登记成录像行（手册 §5.1.18）。
     *
     * 这是「视频手动下载」这条要求的实现：操作员看完一条检测，
     * 把它产出的视频/声场图/图片/WAV 取到本机。幂等——同一条日志的同一个文件
     * 第二次下载不会覆盖已存在的文件，只回报 `reused: true`。
     *
     * ADMINISTRATOR REQUIRED：它会连设备、写盘、并向录像表插入一行。
     * 进度通过 `window.events.onEventCenterDownloadProgress` 推送。
     */
    downloadDetectFile(
      input: EventDetectDownloadInput
    ): Promise<DeviceResult<EventDetectDownloadResult>>
    /**
     * 一条事件的**图片证据**（规格 §12.1 的 Visual 那一项）。
     *
     * 两种入参，二选一：
     *   - `relativePath`：存储根相对路径（联动告警的抓帧就是这种）；
     *   - `recordingId`：一条已经落到本机的录像行（相机检测日志下载下来的照片就是这种）。
     *
     * 返回主进程回环 HTTP 上的地址（含每会话令牌）。`state` 把四种情况分开：
     * `ok`（有图）/ `not-found`（既没给路径、路径也认不出来）/ `files-gone`
     * （路径在库里，但文件已经不在磁盘上）/ `not-image`（文件在，但不是能渲染的图片格式）。
     * 界面照 `state` 说人话，而不是画一个空框或者一个破图。
     */
    evidenceImage(input: EventEvidenceImageInput): Promise<DeviceResult<EventEvidenceImageView>>
    /**
     * 关掉上一次打开的图片端点（界面关抽屉或换一条事件时调用）。
     *
     * 与 `devices.closeSnapshots()` 同一条取舍：主进程一次只留一个端点，但"离开"这件事
     * 只有界面知道；让端口挂到 TTL（30 分钟）是一种浪费，TTL 仍然兜底。
     */
    closeEvidenceImage(): Promise<DeviceResult<void>>
    /**
     * 处置一条事件（规格 §2.2 的状态机 + §11.2 的动作）。
     *
     * 两种入参，二选一（都给时 `status` 优先）：`action` 是界面上的动作
     * （`acknowledge` / `investigate` / `resolve` / `close` / `reopen` / `mute` /
     * `unmute` / `assign`），`status` 是直接给目标状态。
     *
     * 拒绝的三种情况都会如实回报（不静默）：
     *   - 迁移不合法（`canTransitionStatus` 为假）—— 消息里带着允许的目标；
     *   - `reopen` 没给原因（规格要求记原因）；
     *   - `acknowledge` 而这一路来源没有确认接口（相机检测日志）—— 不替设备答应它做不到的事。
     *
     * ADMINISTRATOR REQUIRED。
     */
    changeStatus(
      input: EventStatusChangeInput
    ): Promise<DeviceResult<EventStatusChangeResult>>
    /**
     * 一条事件的处置流水（新的在前）。只读。
     */
    activity(entryId: string, limit?: number): Promise<DeviceResult<EventActivityView[]>>
    /**
     * 人工建一个 Incident 并（可选）一并关联这几条 Alert（规格 §14.2 的 V1）。
     *
     * 只建关联、**不碰任何 Alert 的状态**：规格 §13.2 明说"不自动替用户关闭/合并"。
     * ADMINISTRATOR REQUIRED。
     */
    createIncident(
      input: EventIncidentCreateInput
    ): Promise<DeviceResult<EventIncidentWriteResult>>
    /** 手动把一批 Alert 关联到已有 Incident（幂等）。ADMINISTRATOR REQUIRED。 */
    linkAlerts(input: EventIncidentLinkInput): Promise<DeviceResult<EventIncidentWriteResult>>
    /** 解除一条关联。ADMINISTRATOR REQUIRED。 */
    unlinkAlert(
      input: EventIncidentUnlinkInput
    ): Promise<DeviceResult<{ removed: boolean }>>
    /** 这一条 Alert 属于哪些 Incident（新的在前，带关联条数）。只读。 */
    incidentsForAlert(entryId: string): Promise<DeviceResult<IncidentView[]>>
    /** 库里已有的 Incident（给"关联到已有"的选择器用），新的在前。只读。 */
    listIncidents(limit?: number): Promise<DeviceResult<IncidentView[]>>
  }
}

// ---------------------------------------------------------------------------
// The push surface exposed on `window.events`
// ---------------------------------------------------------------------------

/** What every `window.events.on*` member returns. Call it on unmount. */
export type EventUnsubscribe = () => void

/** Shape shared by every push subscription on the preload bridge. */
export type EventSubscription<TEvent> = (callback: (event: TEvent) => void) => EventUnsubscribe

/**
 * Main -> renderer pushes.
 *
 * DECLARED ONCE, HERE, and referenced by both `src/preload/index.d.ts` (which
 * `tsconfig.web.json` compiles) and `src/renderer/src/types/global.d.ts`. The
 * two files describing the same bridge independently is how they drift: adding
 * a channel to one and not the other produces a renderer that compiles and a
 * subscription that never fires.
 *
 * UNSUBSCRIBE DISCIPLINE (the single most likely leak in this app): every
 * member returns an unsubscribe function, and the preload bridge holds the
 * callback in its own IPC listener list. A component that subscribes and
 * forgets to call the returned function keeps its closure — and the whole
 * decoding path behind it — alive for the lifetime of the window.
 */
export interface RendererEvents {
  /**
   * Subscribe to device online/offline transitions.
   * @returns an unsubscribe function. Call it in `onUnmounted`; the preload
   *   bridge keeps a reference to the IPC listener and leaks without it.
   */
  onDeviceStatus: EventSubscription<import('../domain/models').DeviceStatusEvent>

  /**
   * The application session changed: somebody signed in or out, or a password
   * change refreshed the user. `null` means nobody is signed in.
   */
  onAuthSession: EventSubscription<import('../domain/auth').SessionInfo | null>

  /** `/features_stream` — one feature frame per second. */
  onMonitorFeature: EventSubscription<import('../domain/monitoring').FeatureStreamEvent>

  /** `/audio_stream` — a DECIMATED preview (~10 fps), never raw PCM. */
  onMonitorAudio: EventSubscription<import('../domain/monitoring').AudioFrameEvent>

  /** `/freq_domain` — 1024 magnitude bins, `binHz` gives the frequency axis. */
  onMonitorSpectrum: EventSubscription<import('../domain/monitoring').SpectrumFrameEvent>

  /** `/time_freq_domain` — the device's own rendered JPEG, as base64. */
  onMonitorSpectrogram: EventSubscription<import('../domain/monitoring').SpectrogramFrameEvent>

  /** Per-stream connection state, pushed on every transition. */
  onMonitorStatus: EventSubscription<import('../domain/monitoring').StreamStatusEvent>

  /** Manual-recording lifecycle, drives the elapsed timer. */
  onRecordingState: EventSubscription<import('../domain/monitoring').RecordingStateEvent>

  /** Authoritative monitor session state, for UI reconciliation. */
  onMonitorState: EventSubscription<MonitorState>

  // -- FA371 acoustic camera (manual §5.2) ----------------------------------
  // Camera realtime previews. PCM now also carries the complete Float32 frame for local DSP.
  // `/fftData` — 512 integer spectrum lines, five times per second.
  onFa371Fft: EventSubscription<import('../domain/fa371-stream').Fa371FftPreview>
  // `/voiceprintData` — the decimated magnitude matrix.
  onFa371Voiceprint: EventSubscription<import('../domain/fa371-stream').Fa371VoiceprintPreview>
  // `/prpdData` — device PRPD payload mapped to phase/amplitude points.
  onFa371Prpd: EventSubscription<import('../domain/fa371-stream').Fa371PrpdPreview>
  // `/energyData` — up to three target points (energy + pixel + two angles).
  onFa371Energy: EventSubscription<import('../domain/fa371-stream').Fa371EnergyPreview>
  // `/pcmData` — preview envelope + peak/rms + complete raw Float32 frame.
  onFa371Pcm: EventSubscription<import('../domain/fa371-stream').Fa371PcmPreview>
  // /inrared_data — 4 float32 temperature fields (manual 5.3.6).
  onFa371Infrared: EventSubscription<import('../domain/fa371-stream').Fa371InfraredPreview>
  // `/detectFeedback` — the mapped detection log for one finished detection.
  onFa371DetectFeedback: EventSubscription<import('../domain/fa371-stream').Fa371DetectFeedbackPreview>
  /** Per-channel camera connection state, including which handshake auth won. */
  onFa371StreamStatus: EventSubscription<Fa371StreamStatus>
  /** Authoritative camera stream session state, for UI reconciliation. */
  onFa371StreamState: EventSubscription<Fa371MonitorState>

  onNetworkProgress: EventSubscription<NetworkProgressEvent>

  /**
   * 待处理告警发生变化（新告警到达，或某条被确认）。
   *
   * 与 `onDeviceStatus` 同一个理由：待处理列表由主进程拥有，主进程能在界面
   * 什么都没做的时候改变它（新告警到达、超限丢弃），所以只能由它推。
   * 这也是「提示」能在**导航之后**依然可见的实现方式：任何页面挂载时先读一次
   * `linkage.pending()`，之后靠这条推送保持同步。
   */
  onLinkagePending: EventSubscription<PendingAlarmSnapshot>

  /** SN-16 realtime_value pushed from the main-process callback listener. */
  onE2RealtimeValue: EventSubscription<E2RealtimeValueEvent>

  /**
   * 检测结果文件的下载进度。
   *
   * 一次下载可能几十 MB（声场视频），而 `HttpTransport` 一次读完整段响应体，
   * 所以这里推的是**阶段**（`starting` / `fetching` / `verifying` / `registering`
   * / `done` / `reused` / `failed`）而不是一个百分比：编一个假进度条比没有进度条
   * 更糟。订阅方按 `deviceId + logId + kind` 认领自己发起的那一次。
   */
  onEventCenterDownloadProgress: EventSubscription<EventDownloadProgress>

  /**
   * 相机固件升级包的上传进度（真实字节数，见 `CameraUpgradeProgressEvent`）。
   *
   * 订阅方按 `deviceId` 认领自己发起的那一次上传；`percent` 由主进程算好。
   * 与其它订阅同一条纪律：返回退订函数，卸载时必须调用。
   */
  onCameraUpgradeProgress: EventSubscription<
    import('../domain/camera-upgrade').CameraUpgradeProgressEvent
  >

  /**
   * 瓦片缓存下载进度（业主 20260921 批）：下载 n/total 实时推进，
   * 收尾那一次 `done = true`。返回退订函数，卸载时必须调用。
   */
  onMapTileCacheProgress: EventSubscription<MapTileCacheProgress>
}

