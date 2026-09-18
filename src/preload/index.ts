/**
 * Preload — the ONLY bridge between the renderer and the main process.
 *
 * Security posture:
 *   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
 *   - the renderer receives a hand-written, explicitly enumerated API object
 *   - NO generic `invoke(channel, ...)` escape hatch is exposed, because that
 *     would let a compromised renderer call any handler, including ones added
 *     later by someone who assumed the allow-list was enforced here
 *
 * Architectural consequence (spec appendix C rule 3): because the renderer has
 * no network access and no generic IPC, it is structurally incapable of talking
 * to a device directly. The rule is enforced by the platform, not by convention.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, PushChannels } from '@shared/ipc/contract'
import { FA371_STREAM_KINDS } from '@shared/domain/fa371-stream'
import type {
  CameraAlarmConditionDraft,
  CameraAlarmConditionIdStyle,
  CameraAlarmDiagnosisKeyStyle,
  CameraAlarmStrategyDraft,
  CameraLiveStartInput,
  CameraModePresetId,
  CameraModeRequestedValues,
  CameraUpgradeProgressEvent,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDownloadProgress,
  EventEvidenceImageInput,
  EventStatusChangeInput,
  Fa371DetectFeedbackPreview,
  Fa371EnergyPreview,
  Fa371FftPreview,
  Fa371MonitorState,
  Fa371PcmPreview,
  Fa371RunModeValue,
  Fa371StreamKind,
  Fa371StreamStatus,
  Fa371StreamSubscription,
  Fa371VoiceprintPreview,
  Fa371WorkModeValue,
  LinkageTestEmailInput,
  MonitorState,
  MonitorSubscription,
  NetworkProgressEvent,
  PendingAlarmSnapshot,
  RendererApi,
  StartRecordingInput
} from '@shared/ipc/contract'
import type {
  AudioFrameEvent,
  FeatureStreamEvent,
  RecordingStateEvent,
  SpectrogramFrameEvent,
  SpectrumFrameEvent,
  StreamStatusEvent
} from '@shared/domain/monitoring'
import type {
  AddDeviceInput,
  AlarmQuery,
  DeviceStatusEvent,
  RecordingQuery,
  UpdateDeviceInput
} from '@shared/domain/models'
import type {
  ChangePasswordInput,
  CopyUserPermissionsInput,
  CreateUserInput,
  LoginInput,
  RecoverAccountInput,
  RememberLoginInput,
  ResetUserPasswordInput,
  SessionInfo,
  UpdateUserPermissionsInput,
  UpdateUserProfileInput,
  UserRole
} from '@shared/domain/auth'
import type { AppSettingsPatch } from '@shared/ipc/contract'
import type { EventSeverity } from '@shared/domain/event-center'
import type { SampleLabelDimension, SampleLabelSource } from '@shared/domain/sample-library'
import type {
  SampleAiConfigInput,
  SampleAiLabelRequest,
  SampleExportRequest,
  SampleQuery,
  E2SyncRequest
} from '@shared/ipc/contract'
import type { E2PtzPatch } from '@shared/domain/e2-ptz'

const api: RendererApi = {
  app: {
    getInfo: () => ipcRenderer.invoke(IpcChannels.APP_GET_INFO),
    openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.APP_OPEN_EXTERNAL, url),
    getPreferredLanguages: () =>
      ipcRenderer.invoke(IpcChannels.APP_GET_PREFERRED_LANGUAGES),
    // 只接受存储根内的路径；主进程用 StorageService.resolve() 校验越界。
    revealFile: (path: string) => ipcRenderer.invoke(IpcChannels.APP_REVEAL_FILE, path)
  },

  settings: {
    get: () => ipcRenderer.invoke(IpcChannels.SETTINGS_GET),
    update: (patch: AppSettingsPatch) => ipcRenderer.invoke(IpcChannels.SETTINGS_UPDATE, patch),
    pickStorageDir: () => ipcRenderer.invoke(IpcChannels.SETTINGS_PICK_STORAGE_DIR),
    diskUsage: () => ipcRenderer.invoke(IpcChannels.SETTINGS_DISK_USAGE),
    // 恢复默认：**不接受入参**，被重置的键由主进程定义（见 contract 的说明）。
    restoreDefaults: () => ipcRenderer.invoke(IpcChannels.SETTINGS_RESTORE_DEFAULTS),
    // 告警声音库的文件选择：只回一个本机路径，字节流不过 IPC。
    pickAlarmSound: () => ipcRenderer.invoke(IpcChannels.SETTINGS_PICK_ALARM_SOUND)
  },

  auth: {
    login: (input: LoginInput) => ipcRenderer.invoke(IpcChannels.AUTH_LOGIN, input),
    logout: () => ipcRenderer.invoke(IpcChannels.AUTH_LOGOUT),
    session: () => ipcRenderer.invoke(IpcChannels.AUTH_SESSION),
    installId: () => ipcRenderer.invoke(IpcChannels.AUTH_INSTALL_ID),
    rememberedLogin: () => ipcRenderer.invoke(IpcChannels.AUTH_REMEMBERED_LOGIN),
    rememberLogin: (input: RememberLoginInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_REMEMBER_LOGIN, input),
    forgetRememberedLogin: () => ipcRenderer.invoke(IpcChannels.AUTH_FORGET_REMEMBERED_LOGIN),
    changePassword: (input: ChangePasswordInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_CHANGE_PASSWORD, input),
    recover: (input: RecoverAccountInput) => ipcRenderer.invoke(IpcChannels.AUTH_RECOVER, input),
    listUsers: () => ipcRenderer.invoke(IpcChannels.AUTH_LIST_USERS),
    createUser: (input: CreateUserInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_CREATE_USER, input),
    deleteUser: (userId: string) => ipcRenderer.invoke(IpcChannels.AUTH_DELETE_USER, userId),
    resetPassword: (input: ResetUserPasswordInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_RESET_PASSWORD, input),
    setRole: (userId: string, role: UserRole) =>
      ipcRenderer.invoke(IpcChannels.AUTH_SET_ROLE, userId, role),
    // 权限复选框（手册 §17.1）：提交的是全量勾选态。
    setPermissions: (input: UpdateUserPermissionsInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_SET_PERMISSIONS, input),
    copyPermissions: (input: CopyUserPermissionsInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_COPY_PERMISSIONS, input),
    updateProfile: (input: UpdateUserProfileInput) =>
      ipcRenderer.invoke(IpcChannels.AUTH_UPDATE_PROFILE, input)
  },

  devices: {
    list: () => ipcRenderer.invoke(IpcChannels.DEVICE_LIST),
    get: (id: string) => ipcRenderer.invoke(IpcChannels.DEVICE_GET, id),
    add: (input: AddDeviceInput) => ipcRenderer.invoke(IpcChannels.DEVICE_ADD, input),
    update: (input: UpdateDeviceInput) => ipcRenderer.invoke(IpcChannels.DEVICE_UPDATE, input),
    remove: (id: string) => ipcRenderer.invoke(IpcChannels.DEVICE_REMOVE, id),
    probe: (input: Omit<AddDeviceInput, 'name'>) =>
      ipcRenderer.invoke(IpcChannels.DEVICE_PROBE, input),
    refreshStatus: (id?: string) => ipcRenderer.invoke(IpcChannels.DEVICE_REFRESH_STATUS, id),
    getInfo: (id: string) => ipcRenderer.invoke(IpcChannels.DEVICE_GET_INFO, id),
    getChannels: (id: string) => ipcRenderer.invoke(IpcChannels.DEVICE_GET_CHANNELS, id),
    openWebUi: (id: string) => ipcRenderer.invoke(IpcChannels.DEVICE_OPEN_WEB_UI, id)
  },

  overview: {
    stats: () => ipcRenderer.invoke(IpcChannels.OVERVIEW_STATS),
    recentAlarms: (limit?: number) => ipcRenderer.invoke(IpcChannels.OVERVIEW_RECENT_ALARMS, limit)
  },

  alarms: {
    query: (query: AlarmQuery) => ipcRenderer.invoke(IpcChannels.ALARM_QUERY, query),
    acknowledge: (ids: string[], acknowledged: boolean) =>
      ipcRenderer.invoke(IpcChannels.ALARM_ACKNOWLEDGE, ids, acknowledged),
    setNote: (alarmId: string, note: string | null) =>
      ipcRenderer.invoke(IpcChannels.ALARM_SET_NOTE, alarmId, note),
    setSeverity: (alarmId: string, severity: EventSeverity) =>
      ipcRenderer.invoke(IpcChannels.ALARM_SET_SEVERITY, alarmId, severity),
    countBySeverity: (query?: AlarmQuery) =>
      ipcRenderer.invoke(IpcChannels.ALARM_COUNT_BY_SEVERITY, query)
  },

  /** 听诊盒子族（E2 / FA100 / FA110）的「拉」通道。 */
  e2: {
    status: (deviceId: string) => ipcRenderer.invoke(IpcChannels.E2_STATUS, deviceId),
    syncAlarms: (deviceId: string, request: E2SyncRequest) =>
      ipcRenderer.invoke(IpcChannels.E2_SYNC_ALARMS, deviceId, request),
    /** 空气声呐的球机联动（PTZ）配置：读 / 写并读回 / 与球机对时。 */
    ptz: (deviceId: string) => ipcRenderer.invoke(IpcChannels.E2_PTZ, deviceId),
    updatePtz: (deviceId: string, patch: E2PtzPatch) =>
      ipcRenderer.invoke(IpcChannels.E2_PTZ_UPDATE, deviceId, patch),
    syncNvtTime: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.E2_NVT_TIME_SYNC, deviceId),
    /** 某条告警的抓图（本机文件，回环地址）+ 关掉端点。 */
    alarmSnapshots: (deviceId: string, alarmId: string) =>
      ipcRenderer.invoke(IpcChannels.E2_ALARM_SNAPSHOTS, deviceId, alarmId),
    closeSnapshots: () => ipcRenderer.invoke(IpcChannels.E2_SNAPSHOT_CLOSE)
  },

  recordings: {
    query: (query: RecordingQuery) => ipcRenderer.invoke(IpcChannels.RECORDING_QUERY, query),
    syncDevice: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.RECORDING_SYNC_DEVICE, deviceId)
  },

  /** 本地异常声纹样本库（schema v7）。 */
  samples: {
    query: (query: SampleQuery) => ipcRenderer.invoke(IpcChannels.SAMPLE_QUERY, query),
    stats: () => ipcRenderer.invoke(IpcChannels.SAMPLE_STATS),
    addFromAlarm: (alarmId: string) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_ADD_FROM_ALARM, alarmId),
    addFromAlarms: (alarmIds: string[]) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_ADD_FROM_ALARMS, alarmIds),
    addFromRecording: (recordingId: string) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_ADD_FROM_RECORDING, recordingId),
    pickExportDirectory: () => ipcRenderer.invoke(IpcChannels.SAMPLE_PICK_EXPORT_DIR),
    exportDataset: (request: SampleExportRequest) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_EXPORT_DATASET, request),
    aiStatus: () => ipcRenderer.invoke(IpcChannels.SAMPLE_AI_STATUS),
    saveAiConfig: (input: SampleAiConfigInput) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_AI_SAVE_CONFIG, input),
    aiLabel: (request: SampleAiLabelRequest) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_AI_LABEL, request),
    setLabel: (
      sampleId: string,
      dimension: SampleLabelDimension,
      label: string | null,
      source: SampleLabelSource
    ) => ipcRenderer.invoke(IpcChannels.SAMPLE_SET_LABEL, sampleId, dimension, label, source),
    labels: () => ipcRenderer.invoke(IpcChannels.SAMPLE_LABELS_LIST),
    addLabel: (dimension: SampleLabelDimension, name: string) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_LABEL_ADD, dimension, name),
    renameLabel: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannels.SAMPLE_LABEL_RENAME, id, name),
    removeLabel: (id: string) => ipcRenderer.invoke(IpcChannels.SAMPLE_LABEL_DELETE, id),
    remove: (sampleId: string) => ipcRenderer.invoke(IpcChannels.SAMPLE_REMOVE, sampleId),
    train: () => ipcRenderer.invoke(IpcChannels.SAMPLE_TRAIN)
  },

  config: {
    getChannels: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_CHANNELS, deviceId),
    updateChannel: (deviceId: string, channelIndex: number, patch: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_UPDATE_CHANNEL, deviceId, channelIndex, patch),

    getSampleRate: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_GET_SAMPLE_RATE, deviceId),
    setSampleRate: (deviceId: string, sampleRate: number) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_SET_SAMPLE_RATE, deviceId, sampleRate),

    getAlarmProfiles: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_GET_ALARM_PROFILES, deviceId),
    saveAlarmProfile: (deviceId: string, profile: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_SAVE_ALARM_PROFILE, deviceId, profile),
    deleteAlarmProfile: (deviceId: string, profileId: number) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_DELETE_ALARM_PROFILE, deviceId, profileId),

    getNetwork: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_NETWORK, deviceId),
    changeNetwork: (deviceId: string, next: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_CHANGE_NETWORK, deviceId, next),

    getTime: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_TIME, deviceId),
    updateTime: (deviceId: string, patch: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_UPDATE_TIME, deviceId, patch),
    syncTime: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_SYNC_TIME, deviceId),

    getRs485: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_RS485, deviceId),
    updateRs485: (deviceId: string, patch: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_UPDATE_RS485, deviceId, patch),
    getSerialPorts: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_GET_SERIAL_PORTS, deviceId),

    getModbus: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_MODBUS, deviceId),
    updateModbus: (deviceId: string, patch: unknown) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_UPDATE_MODBUS, deviceId, patch),

    getPush: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CONFIG_GET_PUSH, deviceId),

    setDeviceName: (deviceId: string, name: string) =>
      ipcRenderer.invoke(IpcChannels.CONFIG_SET_DEVICE_NAME, deviceId, name)
  },

  trends: {
    query: (query: unknown) => ipcRenderer.invoke(IpcChannels.TREND_QUERY, query),
    coverage: (deviceId: string) => ipcRenderer.invoke(IpcChannels.TREND_COVERAGE, deviceId),
    stats: () => ipcRenderer.invoke(IpcChannels.TREND_STATS),
    flush: () => ipcRenderer.invoke(IpcChannels.TREND_FLUSH)
  },

  maintenance: {
    reboot: (deviceId: string) => ipcRenderer.invoke(IpcChannels.MAINTENANCE_REBOOT, deviceId),
    factoryReset: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.MAINTENANCE_FACTORY_RESET, deviceId),
    systemUpgrade: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.MAINTENANCE_SYSTEM_UPGRADE, deviceId),
    pickFirmware: () => ipcRenderer.invoke(IpcChannels.MAINTENANCE_PICK_FIRMWARE),
    uploadFirmware: (deviceId: string, filePath: string) =>
      ipcRenderer.invoke(IpcChannels.MAINTENANCE_UPLOAD_FIRMWARE, deviceId, filePath)
  },

  protocol: {
    diagnose: (deviceId: string) => ipcRenderer.invoke(IpcChannels.PROTOCOL_DIAGNOSE, deviceId),
    probeEndpoint: (deviceId: string, path: string, method?: string) =>
      ipcRenderer.invoke(IpcChannels.PROTOCOL_PROBE_ENDPOINT, deviceId, path, method)
  },

  monitor: {
    start: (subscription: MonitorSubscription) =>
      ipcRenderer.invoke(IpcChannels.MONITOR_START, subscription),
    stop: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.MONITOR_STOP, deviceId),
    state: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.MONITOR_STATE, deviceId),
    startRecording: (input: StartRecordingInput) =>
      ipcRenderer.invoke(IpcChannels.MONITOR_START_RECORDING, input),
    stopRecording: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.MONITOR_STOP_RECORDING, deviceId)
  },

  fa371Stream: {
    start: (subscription: Fa371StreamSubscription) =>
      ipcRenderer.invoke(IpcChannels.FA371_STREAM_START, subscription),
    stop: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.FA371_STREAM_STOP, deviceId),
    state: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.FA371_STREAM_STATE, deviceId),
    /**
     * A constant, not an IPC round trip: the channel list is part of the
     * contract and the renderer already links against it. Going through a
     * handler would make the UI's own type union depend on the main process
     * being initialised.
     */
    kinds: (): Fa371StreamKind[] => [...FA371_STREAM_KINDS]
  },

  cameraLive: {
    start: (input: CameraLiveStartInput) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_LIVE_START, input),
    stop: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.CAMERA_LIVE_STOP, deviceId),
    state: (deviceId?: string) => ipcRenderer.invoke(IpcChannels.CAMERA_LIVE_STATE, deviceId),
    source: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CAMERA_LIVE_SOURCE, deviceId),
    // 多路直播的预算：视频墙在分配画面格之前先问它。
    limits: () => ipcRenderer.invoke(IpcChannels.CAMERA_LIVE_LIMITS)
  },

  cameraNvr: {
    startRecording: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_NVR_START_RECORDING, deviceId),
    stopRecording: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_NVR_STOP_RECORDING, deviceId),
    recordingState: (deviceId?: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_NVR_RECORDING_STATE, deviceId),
    snapshot: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_NVR_SNAPSHOT, deviceId),
    // 只把回环地址交给 <video>；字节流不过 IPC（见 contract 里的说明）。
    videoUrl: (recordingId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_NVR_VIDEO_URL, recordingId)
  },

  cameraAlarms: {
    listStrategies: (deviceId: string, page?: number) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_LIST_STRATEGIES, deviceId, page),
    createStrategy: (deviceId: string, draft: CameraAlarmStrategyDraft, diagnosisKey?: CameraAlarmDiagnosisKeyStyle) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_CREATE_STRATEGY, deviceId, draft, diagnosisKey),
    updateStrategy: (deviceId: string, draft: CameraAlarmStrategyDraft, diagnosisKey?: CameraAlarmDiagnosisKeyStyle) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_UPDATE_STRATEGY, deviceId, draft, diagnosisKey),
    deleteStrategies: (deviceId: string, ids: number[]) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_DELETE_STRATEGIES, deviceId, ids),

    listConditions: (deviceId: string, page?: number) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_LIST_CONDITIONS, deviceId, page),
    createCondition: (deviceId: string, draft: CameraAlarmConditionDraft) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_CREATE_CONDITION, deviceId, draft),
    updateCondition: (deviceId: string, draft: CameraAlarmConditionDraft, idStyle?: CameraAlarmConditionIdStyle) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_UPDATE_CONDITION, deviceId, draft, idStyle),
    deleteConditions: (deviceId: string, ids: number[]) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_ALARM_DELETE_CONDITIONS, deviceId, ids)
  },

  /**
   * 相机控制与维护（检测模式 / 检测启停 / 启用中的策略 / 维护能力）。
   *
   * 与 `cameraAlarms` 同一个形状：读方法直接转发，写方法同样**只转发**——
   * 「写后重读」「先停用再启用」都在主进程的服务里，渲染层拿到的就是设备事实。
   */
  cameraControl: {
    readRunMode: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_READ_RUN_MODE, deviceId),
    writeRunMode: (deviceId: string, mode: Fa371RunModeValue) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_WRITE_RUN_MODE, deviceId, mode),
    readDetectStatus: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_READ_DETECT_STATUS, deviceId),
    turnOnDetect: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_TURN_ON_DETECT, deviceId),
    turnOffDetect: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_TURN_OFF_DETECT, deviceId),
    readEnabledStrategy: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_READ_ENABLED_STRATEGY, deviceId),
    setStrategyEnabled: (deviceId: string, strategyId: number, enable: boolean) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_SET_STRATEGY_ENABLED, deviceId, strategyId, enable),
    maintenance: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_MAINTENANCE, deviceId),
    /**
     * 应用模式预设（局部放电 / 气体泄漏 / 机械异响）。
     *
     * 与上面三条写方法同一个形状：preload **只转发**，「写后重读」「逐字段比对」
     * 全在主进程的服务里，渲染层拿到的就是设备事实。
     */
    readModePreset: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_READ_MODE_PRESET, deviceId),
    applyModePreset: (deviceId: string, presetId: CameraModePresetId) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_APPLY_MODE_PRESET, deviceId, presetId),
    restoreModeValues: (deviceId: string, values: CameraModeRequestedValues) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_RESTORE_MODE_VALUES, deviceId, values),
    /**
     * 应用模式（局部放电 / 气体泄漏 / 机械异响）：`GET` / `PUT /system`。
     *
     * ⚠ 端点**未文档化**（不在任何一份手册里，实测可读可写）。preload 仍然只转发：
     * "读不到就不渲染"的能力判定与"写后重读"都在主进程的服务里，渲染层拿到的
     * 是设备事实 + 一个 `applied`。
     *
     * 与上面 `readModePreset` / `applyModePreset`（成像参数）是两条通道，互不调用。
     */
    readWorkMode: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_READ_WORK_MODE, deviceId),
    writeWorkMode: (deviceId: string, mode: Fa371WorkModeValue) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_CONTROL_WRITE_WORK_MODE, deviceId, mode)
  },

  /**
   * 相机固件升级（设备自带 Web 界面用的那条 HTTP 路）。
   *
   * preload 只转发：文件名的设备规则校验、multipart 报文的拼装、流式上传与
   * "上传**不**重启设备"都在主进程的服务里。渲染层拿到的是事实
   * （包的大小 / sha256 / 名字收不收 / 上传结果），进度靠推送。
   */
  cameraUpgrade: {
    pickPackage: () => ipcRenderer.invoke(IpcChannels.CAMERA_UPGRADE_PICK_PACKAGE),
    inspectPackage: (filePath: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_UPGRADE_INSPECT_PACKAGE, filePath),
    upload: (deviceId: string, filePath: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_UPGRADE_UPLOAD, deviceId, filePath),
    readProgress: (deviceId: string) =>
      ipcRenderer.invoke(IpcChannels.CAMERA_UPGRADE_READ_PROGRESS, deviceId),
    reboot: (deviceId: string) => ipcRenderer.invoke(IpcChannels.CAMERA_UPGRADE_REBOOT, deviceId)
  },

  playback: {
    load: (recordingId: string) =>
      ipcRenderer.invoke(IpcChannels.RECORDING_PLAYBACK_DATA, recordingId)
  },

  /**
   * 告警本地联动（录像 / 弹窗 / 提示 / 邮件）。
   *
   * 渲染层**没有**任何「触发一次联动」的能力：引擎完全由主进程拥有，
   * 这里只有「读状态」「读待处理」「确认」「发测试邮件」四件事。
   */
  linkage: {
    status: () => ipcRenderer.invoke(IpcChannels.LINKAGE_GET_STATUS),
    pending: () => ipcRenderer.invoke(IpcChannels.LINKAGE_GET_PENDING),
    acknowledge: (ids?: string[]) => ipcRenderer.invoke(IpcChannels.LINKAGE_ACKNOWLEDGE, ids),
    testEmail: (input: LinkageTestEmailInput) =>
      ipcRenderer.invoke(IpcChannels.LINKAGE_TEST_EMAIL, input)
  },

  /**
   * 事件与告警中心。
   *
   * 三路来源的合并在主进程完成（三个所有者、三种传输，见
   * `services/events/event-center-service.ts`），所以这里只有一个查询方法。
   */
  eventCenter: {
    query: (query: EventCenterQuery) => ipcRenderer.invoke(IpcChannels.EVENT_CENTER_QUERY, query),
    acknowledge: (ids: string[]) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_ACKNOWLEDGE, ids),
    detectLogs: (deviceId: string, detectId?: number) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_DETECT_LOGS, deviceId, detectId),
    downloadDetectFile: (input: EventDetectDownloadInput) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_DOWNLOAD_DETECT_FILE, input),
    evidenceImage: (input: EventEvidenceImageInput) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_EVIDENCE_IMAGE, input),
    closeEvidenceImage: () =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_EVIDENCE_IMAGE_CLOSE),
    changeStatus: (input: EventStatusChangeInput) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_CHANGE_STATUS, input),
    activity: (entryId: string, limit?: number) =>
      ipcRenderer.invoke(IpcChannels.EVENT_CENTER_ACTIVITY, entryId, limit)
  }
}

/**
 * Realtime frame subscriptions.
 *
 * Each returns an unsubscribe function. Every one of these MUST be released on
 * unmount: the underlying IPC listener holds a closure over the callback, so an
 * unsubscribed stream keeps the component alive and keeps decoding frames.
 *
 * The raw `IpcRendererEvent` is deliberately not forwarded — passing it to the
 * renderer would expose the sender and defeat context isolation.
 */
type Unsubscribe = () => void

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const onDeviceStatus = (callback: (event: DeviceStatusEvent) => void): Unsubscribe =>
  subscribe(PushChannels.DEVICE_STATUS, callback)

const onMonitorFeature = (callback: (event: FeatureStreamEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_FEATURE, callback)

const onMonitorAudio = (callback: (event: AudioFrameEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_AUDIO, callback)

const onMonitorSpectrum = (callback: (event: SpectrumFrameEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_SPECTRUM, callback)

const onMonitorSpectrogram = (callback: (event: SpectrogramFrameEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_SPECTROGRAM, callback)

const onMonitorStatus = (callback: (event: StreamStatusEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_STATUS, callback)

const onRecordingState = (callback: (event: RecordingStateEvent) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_RECORDING_STATE, callback)

const onMonitorState = (callback: (event: MonitorState) => void): Unsubscribe =>
  subscribe(PushChannels.MONITOR_STATE, callback)

/**
 * FA371 camera frames.
 *
 * The main process pushes five TYPED previews, one per channel, so a component
 * subscribes only to what it displays instead of decoding a discriminated union
 * on every frame. Every one of these must be released on unmount — see the note
 * above `subscribe`.
 */
const onFa371Fft = (callback: (event: Fa371FftPreview) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_FFT, callback)

const onFa371Voiceprint = (callback: (event: Fa371VoiceprintPreview) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_VOICEPRINT, callback)

const onFa371Energy = (callback: (event: Fa371EnergyPreview) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_ENERGY, callback)

const onFa371Pcm = (callback: (event: Fa371PcmPreview) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_PCM, callback)

const onFa371DetectFeedback = (
  callback: (event: Fa371DetectFeedbackPreview) => void
): Unsubscribe => subscribe(PushChannels.FA371_DETECT_FEEDBACK, callback)

const onFa371StreamStatus = (callback: (event: Fa371StreamStatus) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_STREAM_STATUS, callback)

const onFa371StreamState = (callback: (event: Fa371MonitorState) => void): Unsubscribe =>
  subscribe(PushChannels.FA371_STREAM_STATE, callback)

const onNetworkProgress = (callback: (event: NetworkProgressEvent) => void): Unsubscribe =>
  subscribe(PushChannels.NETWORK_PROGRESS, callback)

/**
 * 待处理告警快照。
 *
 * 「提示」要能在关掉弹窗、切走页面之后仍然看得见，所以推的是主进程持有的
 * 那份列表本身，而不是「刚弹了一次窗」这种瞬时事件——任何页面挂载时先读一次
 * `linkage.pending()`，之后靠这条推送保持同步。
 */
const onLinkagePending = (callback: (event: PendingAlarmSnapshot) => void): Unsubscribe =>
  subscribe(PushChannels.LINKAGE_PENDING, callback)

/**
 * 检测结果文件的下载进度（阶段，不是百分比）。
 *
 * 与其它订阅同一条纪律：返回退订函数，调用方必须在卸载时释放，
 * 否则 IPC 监听器里那份闭包会把组件（以及它持有的状态）留到窗口关闭。
 */
const onEventCenterDownloadProgress = (
  callback: (event: EventDownloadProgress) => void
): Unsubscribe => subscribe(PushChannels.EVENT_CENTER_DOWNLOAD_PROGRESS, callback)

/**
 * 相机固件升级包的上传进度。
 *
 * 这里给的是**真实的字节数**（`sentBytes` / `totalBytes` / `percent`），不是不定
 * 进度条：升级这条路走 `node:http` 流式发送，每个 chunk 都数得到（与
 * `onEventCenterDownloadProgress` 那条只有阶段的通道不同，理由见 contract）。
 */
const onCameraUpgradeProgress = (
  callback: (event: CameraUpgradeProgressEvent) => void
): Unsubscribe => subscribe(PushChannels.CAMERA_UPGRADE_PROGRESS, callback)

/**
 * The application session changed (login, logout, password change).
 *
 * `null` means nobody is signed in. The renderer keeps a mirror only for
 * rendering; the main process remains the authority.
 */
const onAuthSession = (callback: (session: SessionInfo | null) => void): Unsubscribe =>
  subscribe(PushChannels.AUTH_SESSION, callback)

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('events', {
  onDeviceStatus,
  onMonitorFeature,
  onMonitorAudio,
  onMonitorSpectrum,
  onMonitorSpectrogram,
  onMonitorStatus,
  onRecordingState,
  onMonitorState,
  onFa371Fft,
  onFa371Voiceprint,
  onFa371Energy,
  onFa371Pcm,
  onFa371DetectFeedback,
  onFa371StreamStatus,
  onFa371StreamState,
  onNetworkProgress,
  onLinkagePending,
  onEventCenterDownloadProgress,
  onCameraUpgradeProgress,
  onAuthSession
})
