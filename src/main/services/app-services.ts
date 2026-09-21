/**
 * Application service container and composition root.
 *
 * Everything is constructed once, in dependency order, and disposed in reverse.
 * Keeping this in one file makes the dependency graph — and therefore the
 * process boundary from spec section 3.2 — auditable at a glance.
 *
 * Ordering matters for one subtle reason: `SettingsService` must exist before
 * the storage layout can be resolved (the storage root is a user setting), and
 * logging must be initialised before anything that might log.
 */

import { app } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import type { RealtimeFeature } from '@shared/domain/models'

import { openDatabase, SCHEMA_VERSION } from './database/schema'
import {
  ChannelRepository,
  DeviceRepository
} from './database/device-repository'
import { AlarmRepository, RecordingRepository } from './database/alarm-repository'
import { DeviceStatusEventRepository } from './database/device-status-event-repository'
import { EventStatusRepository } from './database/event-status-repository'
import { IncidentRepository } from './database/incident-repository'
import { SampleRepository } from './database/sample-repository'
import { SampleLibraryService } from './sample/sample-library-service'
import { SampleLabelService } from './sample/sample-label-service'
import { SampleLabelRepository } from './database/sample-label-repository'
import { E2DeviceService } from './device/e2/e2-device-service'
import { SampleDatasetExporter } from './sample/sample-dataset-export'
import { SampleAiLabelService } from './sample/sample-ai-label-service'
import { SampleAiStore } from './sample/sample-ai-store'
import { AppMetaRepository, UserRepository } from './database/user-repository'
import { AuthService } from './auth/auth-service'
import { AccountPermissionStore } from './auth/account-permission-store'
import { SettingsService } from './settings/settings-service'
import { StorageService } from './storage/storage-service'
import { DeviceService } from './device/device-service'
import { ProtocolLab } from './device/protocol-lab'
import { FetchHttpTransport } from './device/http-transport'
import { createCredentialStore, type CredentialStore } from './device/credential-store'
import { RememberedLoginStore } from './auth/remembered-login-store'
import {
  AlarmService,
  OverviewService,
  RecordingService
} from './alarm/alarm-service'
import { StreamManager, type FinishedCapture } from './stream/stream-manager'
import { toWebSocketUrl } from './stream/websocket-stream'
import { Fa371StreamService } from './device/fa371/fa371-stream-service'
import { Fa371ApiClient } from './device/fa371/fa371-api-client'
import { RtspStreamService } from './media/rtsp-stream'
import { CameraCaptureService } from './media/camera-capture'
import { CameraAlarmService } from './device/fa371/camera-alarm-service'
import { CameraControlService } from './device/fa371/camera-control-service'
import { CameraUpgradeService } from './device/fa371/camera-upgrade-service'
import { DetectLibraryService } from './device/fa371/detect-library-service'
import { EventCenterService } from './events/event-center-service'
import { AlarmLinkageService } from './linkage/alarm-linkage-service'
import { VideoFileServer } from './media/video-file-server'
import { PlaybackService } from './audio/playback-service'
import { TrendStorageService } from './trend/trend-storage-service'
import { TrendQueryService } from './trend/trend-query-service'
import { AudioRecordingService } from './audio/recording-service'
import { IotIngestService } from './ingest/iot-ingest-service'
import { TelemetryIntake } from './ingest/telemetry-intake'
import { listLocalAddresses } from './ingest/local-addresses'
import { appLog, initLogging, storageLog } from './logging/logger'

/** Default storage root. Windows users are expected to move this to a data disk. */
function defaultStorageRoot(): string {
  // Verification hook. Lets the smoke / packaging checks redirect the storage
  // root — and therefore the log directory, which lives under it — into a
  // throwaway profile. Without it those checks assert on a path the app never
  // writes to on Windows, where the storage root is an absolute D:\ location
  // rather than a child of userData.
  //
  // Gated on the SAME condition as the rest of the smoke probes
  // (`attachSmokeTestProbes` in main/index.ts) rather than on `isPackaged`. The
  // earlier `!app.isPackaged` guard made the hook silently inert in a packaged
  // build, so the packaging check looked for logs in a directory the app had no
  // intention of using and reported a working logger as broken. The channel is
  // still impossible to reach in a customer install: setting the environment
  // variable is a deliberate act, exactly like HERTZINNO_SMOKE_TEST.
  if (process.env.HERTZINNO_SMOKE_TEST && process.env.HERTZINNO_STORAGE_ROOT) {
    return process.env.HERTZINNO_STORAGE_ROOT
  }
  /*
   * 同一件事的**第二个门**，给"不能开 SMOKE_TEST 的验证进程"用。
   *
   * `demo-shot`（人工辅助验证 UI 的截图探针）不能开 `HERTZINNO_SMOKE_TEST`：
   * 那一套探针会登录、切语言并**重载渲染层**，把探针正在导航的窗口当场换掉。
   * 但它在受限环境里跑时默认存储根（Windows 上是 `D:\HertzinnoData`）可能不可写，
   * 于是应用在启动阶段就报 `Storage root is not writable` 并退出 —— 一个字都量不到。
   *
   * 所以把这个门**独立**出来：只要显式给了 `HERTZINNO_STORAGE_ROOT`，就按它走。
   * 这没有削弱原来那条保护 —— 原来防的是"打包后的客户安装里有人误用"，而
   * "进程里存在这个环境变量"本身就是刻意的动作（与 HERTZINNO_SMOKE_TEST 同级），
   * 客户安装里不会有人设它。存储根本来就是一个可配置的位置（见下面 D: 的注释）。
   */
  if (process.env.HERTZINNO_STORAGE_ROOT) {
    return process.env.HERTZINNO_STORAGE_ROOT
  }
  if (process.platform === 'win32') {
    // Spec 4.4: audio must be able to live on a large disk. D: is the common
    // choice, but never assume it exists.
    if (existsSync('D:\\')) return 'D:\\HertzinnoData'
    return path.join(app.getPath('documents'), 'HertzinnoData')
  }
  // Non-Windows development fallback, kept out of the repo tree.
  return path.join(app.getPath('userData'), 'HertzinnoData')
}

export interface AppServices {
  db: SqliteDatabase
  settings: SettingsService
  storage: StorageService
  credentials: CredentialStore
  credentialsPersistent: boolean
  /** Application accounts + the current session. See `auth/auth-service.ts`. */
  auth: AuthService
  devices: DeviceService
  /**
   * FA371 camera realtime WebSocket streams (manual §5.2).
   *
   * A SEPARATE service rather than another `StreamManager` because the camera's
   * five channels share nothing with the acoustic box's four (no channels, no
   * subscribe message, undefined payload layouts). It is registered here, at
   * the composition root, so the IPC layer can reach it without `DeviceService`
   * learning about camera sockets.
   */
  fa371Streams: Fa371StreamService
  /**
   * FA371 camera LIVE VIDEO: RTSP -> ffmpeg -> a loopback-only HTTP server.
   *
   * A fourth service rather than part of `Fa371StreamService`, because the two share
   * no transport: that one owns WebSocket channels carrying decimated previews over
   * IPC, this one owns an ffmpeg process and an HTTP byte stream the renderer's
   * `<video>` element pulls. Merging them would mean one class branching on
   * "preview or video", which is how the wrong payload ends up on the wrong channel.
   */
  cameraLive: RtspStreamService
  /**
   * 相机 NVR 采集：手动录像（MP4）与抓图（JPEG）。
   *
   * 与 `cameraLive` 分开而不是并进它：后者拥有「一路直播会话 + 回环 HTTP」，
   * 这个拥有「落盘产物 + 录像表登记 + 磁盘策略」。把两者合在一起，就会有一个
   * 同时管字节流和文件生命周期的类，而这两件事的失败模式完全不同。
   */
  cameraCapture: CameraCaptureService
  /**
   * 相机告警模型（手册 §5.1.22 – §5.1.29）：策略与条件的读写。
   *
   * 只服务 `acousticCamera`：声纹设备的告警档位是另一套（`CONFIG_*_ALARM_PROFILE`），
   * 两者的字段、约束和歧义都不共享，合并会让两边都变模糊。
   */
  cameraAlarms: CameraAlarmService
  /**
   * 相机控制与维护：检测模式（单次/智能巡航）、检测启停、当前启用的告警策略、
   * 版本信息与维护能力表。
   *
   * 与 `cameraAlarms` 分开：那个管告警模型的**内容**（策略/条件的新建改删），
   * 这个管「检测能不能跑起来」的**运行状态** —— 新手册明确开始检测要求先有一条
   * 策略处于启用状态，所以启用状态必须和启停按钮读同一份、一起刷新。
   */
  cameraControl: CameraControlService
  /**
   * 相机固件升级：选包、读包的事实、上传（`POST /upload`）、读进度（`GET /progress`）、
   * 重启（`PUT /reboot`）。
   *
   * 与 `cameraControl` 分开：那一个管「检测能不能跑起来」与维护**能力表**，这一个
   * 管一个几十 MB 的包怎么安全地送到设备上 —— 失败模式（文件名校验不过、长上传、
   * 传到一半断网、上传成功但设备尚未升级）与其它任何一个相机通道都不共享。
   * 上传与重启是**两个动作**：本服务里没有任何从上传通向重启的调用路径。
   */
  cameraUpgrade: CameraUpgradeService
  /**
   * 本地录像文件的回环播放端点（手动录像的 MP4）。
   *
   * 与 `cameraLive` 同构（只绑 127.0.0.1、临时端口、每会话令牌），但服务的是**文件**
   * 而不是直播：有长度、支持 Range，因此 `<video>` 能拖动进度条。
   */
  videoFiles: VideoFileServer
  /**
   * 录像元数据仓库。
   *
   * 暴露在这里而不是包一层服务：视频播放端点需要按 id 取一行、取出它的
   * `relative_path` 再交给 `StorageService.resolve()` 校验越界，这三步都是**读**，
   * 而且必须与写入用的是同一张表、同一套路径约定。
   */
  recordingRepo: RecordingRepository
  /**
   * 本地异常声纹样本库（schema v7，业主 2026-09-16）。
   *
   * 与 `recordingRepo` 并列暴露，理由同它：样本记录**引用**录音文件，而"这个文件在哪、
   * 还在不在"只能问存储层与录音表 —— 样本库自己不该知道磁盘布局。
   */
  sampleRepo: SampleRepository
  /** 样本库的服务层：入库（告警/录音两个来源）、打标签、训练与评估。 */
  sampleLibrary: SampleLibraryService
  /** 样本库 → 外部训练数据集（清单 + 可选复制音频）。 */
  sampleExport: SampleDatasetExporter
  /** 标签库（两个维度：设备类型 / 故障类型）的维护与使用。 */
  sampleLabels: SampleLabelService
  /** 听诊盒子族（E2 / FA100 / FA110）的「拉」通道：状态与告警同步。 */
  e2: E2DeviceService
  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条）：HTTP 推流 + 最小 MQTT broker。
   *
   * 它**只负责收**：秘钥 → 设备、SSL 无关、把收到的行交给 `TelemetryIntake`。
   * 落库那一步走的是 `trends` 与 `alarmRepo`（同一个实例，不新开第二套存储），
   * 所以历史趋势页与告警列表**立刻**能看到推上来的数据。
   *
   * **默认关闭**（设置里的 `iotIngest.enabled`）：装了软件就在局域网里开监听端口是缺陷。
   */
  iotIngest: IotIngestService
  /** 可插拔 AI 标注（配置 + 让大模型给候选标签）。 */
  sampleAi: SampleAiLabelService
  /**
   * 告警本地联动（产品要求「告警和本地联动，录像，弹窗，提示以及邮件触发」）。
   *
   * 单独一个服务而不是并进 `cameraAlarms`：后者是设备侧告警模型的**读写**
   * （策略 / 条件），而这个拥有「触发源 + 四个本地动作 + 冷却 + 审计」。
   * 两者的失败模式与依赖（磁盘、ffmpeg、SMTP、窗口）完全不共享。
   */
  linkage: AlarmLinkageService
  /**
   * 相机检测库（手册 §5.1.17 / §5.1.18）：读检测日志、下载结果文件。
   *
   * 与 `cameraAlarms` 分开：那个是设备侧告警模型的**读写**（策略/条件），
   * 这个拥有「设备产出的文件」——读取、下载、落盘、登记录像行。
   * 与事件中心服务也分开：「设备上有哪些检测」与「发生过哪些事件」是两个问题，
   * 分开之后检测库读失败可以被事件中心如实降级成一路来源的状态。
   */
  detectLibrary: DetectLibraryService
  /**
   * 事件与告警中心：把三路来源合并成一个按时间倒序的分页。
   *
   * 三个所有者（设备 HTTP / 内存待处理列表 / 本地 SQLite）都各自被别的服务
   * 持有，这里只做装配与合并，不复制任何一份数据。
   */
  eventCenter: EventCenterService
  alarms: AlarmService
  recordings: RecordingService
  overview: OverviewService
  protocolLab: ProtocolLab
  playback: PlaybackService
  trends: TrendStorageService
  trendQuery: TrendQueryService
  transport: FetchHttpTransport
  dispose: () => Promise<void>
}

let services: AppServices | undefined

export async function initServices(): Promise<AppServices> {
  if (services) return services

  const isDev = !app.isPackaged

  // ---- Storage root resolution -------------------------------------------
  // A bootstrap settings pass is needed before logging, because the log
  // directory lives UNDER the storage root (spec 4.4).
  const bootstrapRoot = defaultStorageRoot()
  const userDataDir = app.getPath('userData')
  const dbPath = path.join(userDataDir, 'hertzinno-manager.db')

  // Open the DB early with a minimal logger; the real one starts below.
  const db = openDatabase({ file: dbPath })

  const settings = new SettingsService({ db, defaultStorageRoot: bootstrapRoot })
  const storageRoot = settings.get().storageRoot

  await new StorageService({
    db,
    getStorageRoot: () => settings.get().storageRoot,
    getMinFreeBytes: () => settings.get().minFreeBytes
  }).ensureLayout(storageRoot)

  // ---- Logging (spec 14.3) -----------------------------------------------
  initLogging(path.join(storageRoot, 'logs'), 30)
  appLog().info('Starting HAIS', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform}/${process.arch}`,
    isDev,
    dbPath,
    storageRoot,
    schemaVersion: SCHEMA_VERSION
  })

  // ---- Credentials (spec 14.1) -------------------------------------------
  const credentialResult = createCredentialStore(db)
  if (!credentialResult.persistent) {
    appLog().warn(
      'Running with in-memory credentials only; devices will require re-authentication after restart'
    )
  }

  // ---- Transport + repositories ------------------------------------------
  const transport = new FetchHttpTransport(settings.get().requestTimeoutMs)

  const deviceRepo = new DeviceRepository(db)
  const channelRepo = new ChannelRepository(db)
  const alarmRepo = new AlarmRepository(db)
  const recordingRepo = new RecordingRepository(db)
  /** 设备上线 / 离线事件（schema v17，业主：事件中心把设备离线纳入时间线）。 */
  const deviceStatusEventRepo = new DeviceStatusEventRepository(db)
  /** 处置工作流（状态 + Activity，schema v13）：事件中心自己的两张表。 */
  const eventStatusRepo = new EventStatusRepository(db)
  /** Incident 与它的关联（schema v14）：人工创建 + 手动关联，规格 §14.2 的 V1。 */
  const incidentRepo = new IncidentRepository(db)
  /**
   * 本地异常声纹样本库（schema v7）。
   *
   * 建在这里而不是某个服务内部：样本来自**两条互不相干的路**（告警联动产出的录音、操作员
   * 手动录音），以后还会有第三条（导入外部音频）。让一个仓库实例服务那几条路，比它们各自
   * `new` 一个更不容易出现"两个连接、两种口径"。
   */
  const sampleRepo = new SampleRepository(db)
  const sampleLabelRepo = new SampleLabelRepository(db)
  /**
   * 标签库服务（schema v8 的两个维度：设备类型 / 故障类型）。
   *
   * 在样本库服务**之前**建：打标签时的"或新建"（`ensureLabel`）要它，而改名要连样本一起改，
   * 所以它反过来也依赖 `sampleRepo` —— 两个服务共用同一批仓库实例，不是一个依赖另一个。
   */
  const sampleLabels = new SampleLabelService({ labels: sampleLabelRepo, samples: sampleRepo })
  /**
   * 样本库服务：把"样本从哪来"收敛成一处（告警带特征、录音只有素材），
   * 并且是唯一训练/评估的入口。理由见 `sample/sample-library-service.ts` 的文件头。
   */
  const sampleLibrary = new SampleLibraryService({
    samples: sampleRepo,
    alarms: alarmRepo,
    recordings: recordingRepo,
    labels: sampleLabels
  })

  /**
   * 账号权限表（手册 §17.1 的权限复选框）。
   *
   * 在 `AuthService` **之前**构造：那一个构造参数就是它，而账号管理界面读回来的
   * `UserSummary.permissions` 也来自它。
   */
  const appMeta = new AppMetaRepository(db)
  const accountPermissions = new AccountPermissionStore(appMeta)

  /**
   * Application accounts.
   *
   * Built early, and the factory administrator is created here rather than lazily
   * on the first login attempt: the login screen has to be renderable before
   * anybody is signed in, so the account must already exist by then. It is created
   * at most once — `ensureSeedAccount` is a no-op as soon as any account exists,
   * which is what stops a subsequent start from resurrecting a deleted `admin`.
   */
  const auth = new AuthService({
    users: new UserRepository(db),
    meta: appMeta,
    /**
     * 账号权限表（手册 §17.1）。与 `meta` 共用 `app_meta` 表，理由是
     * 「权限是账号的事实，不是系统设置」—— 见 `account-permission-store.ts`。
     */
    permissions: accountPermissions,
    /**
     * 「记住上次的用户名 / 记住密码」。与设备凭据同一套底层：`safeStorage` 加密之后才落
     * `app_meta`，系统加密不可用时只记用户名（见 `remembered-login-store.ts`）。
     */
    rememberedLogin: new RememberedLoginStore(appMeta)
  })
  auth.ensureSeedAccount()

  const storage = new StorageService({
    db,
    getStorageRoot: () => settings.get().storageRoot,
    getMinFreeBytes: () => settings.get().minFreeBytes
  })

  // Built before DeviceService: the stream-manager factory closes over it.
  const audioRecording = new AudioRecordingService({
    storage,
    recordings: recordingRepo
  })

  /**
   * 设备声明 → 本机监听（业主 2026-09-19 第 13 批第 1 条：把"数据接入"的开关搬进添加设备）。
   *
   * **为什么是 late-bound 的**：`DeviceService` 在接入服务**之前**构造，而"加了一台声明
   * HTTP 的设备要不要开端口"这件事只有接入服务存在之后才答得上来。所以这里先给一个空实现，
   * 接入服务建好之后再把它接上（下面那一段）。缺省实现什么都不做，所以中间那一段窗口里
   * 加设备也不会崩。
   */
  let syncIngestFromDevices: (need: { http: boolean; mqtt: boolean }) => void = () => {}

  const deviceService = new DeviceService({
    devices: deviceRepo,
    channels: channelRepo,
    credentials: credentialResult.store,
    transport,
    syncIngest: (need) => syncIngestFromDevices(need),
    settings: () => ({
      requestTimeoutMs: settings.get().requestTimeoutMs,
      healthCheckIntervalMs: settings.get().healthCheckIntervalMs,
      offlineFailureThreshold: settings.get().offlineFailureThreshold,
      ringBufferSeconds: settings.get().ringBufferSeconds,
      preAlarmSeconds: settings.get().preAlarmSeconds,
      postAlarmSeconds: settings.get().postAlarmSeconds
    }),
    /**
     * IoT 接入的两项（业主 2026-09-19 第 1 条）。
     *
     * 从设置里**现读**（每次调用都读，不缓存）：端口改完的下一刻，设备对话框里显示的
     * 推流地址就该是新的。地址表用真的网卡枚举 —— 界面必须给出设备**连得上**的地址，
     * 而 `0.0.0.0` 不是一个可以连的目标。
     */
    getIngestConfig: () => settings.get().iotIngest,
    listLocalAddresses,
    /** 设备状态翻转落事件（schema v17）：`record` 同步落库，失败由 DeviceService 兜住记日志。 */
    deviceStatusEvents: {
      record: (input) => {
        deviceStatusEventRepo.record(input)
      }
    },

    /**
     * Build a StreamManager for one device.
     *
     * The two callbacks are where the storage and database layers meet the
     * streaming layer. They are supplied here, at the composition root, so that
     * DeviceService and StreamManager stay free of filesystem and SQL concerns —
     * which is what makes both of them testable without either.
     */
    createStreamManager: (options) =>
      new StreamManager({
        ...options,
        // Spec 14.4: below the free-space floor, non-essential recording stops.
        // Routed through the storage service so the policy lives in one place.
        canRecord: (recordingType) => storage.canRecord(recordingType),

        /**
         * Persist a finished capture.
         *
         * Delegates to `AudioRecordingService` rather than inlining the work:
         * that service owns the pre-encode free-space guard the specification
         * requires, and duplicating the encode/write/hash/insert sequence here
         * would mean the guard silently did not apply to live recordings.
         *
         * NOTE: `saveRecording` THROWS `AppError(DISK_FULL)` when the guard
         * trips, so this callback rejects rather than returning a soft failure.
         * `StreamManager.stopRecording()` and `dispose()` both tolerate that.
         */
        persistRecording: async (capture: FinishedCapture) => {
          const device = deviceRepo.findById(capture.deviceId)
          const recording = await audioRecording.saveRecording({
            deviceId: capture.deviceId,
            // The on-disk layout is keyed by the STABLE uid, not the local id,
            // so a device re-added under a new row still finds its audio.
            deviceUid: device?.deviceUid ?? capture.deviceId,
            channelIndex: capture.channelIndex,
            recordingType: capture.recordingType,
            startedAt: capture.startedAt,
            endedAt: capture.endedAt,
            samples: capture.samples,
            sampleRate: capture.sampleRate,
            channelCount: capture.channelCount,
            ...(capture.eventType ? { eventType: capture.eventType } : {})
          })

          return { recordingId: recording.id, relativePath: recording.relativePath }
        }
      })
  })

  // ---- Application services ----------------------------------------------
  // Built AFTER DeviceService, because they depend on it.

  const alarmService = new AlarmService({ alarms: alarmRepo })
  const recordingService = new RecordingService({
    recordings: recordingRepo,
    devices: deviceService,
    storage
  })
  const overviewService = new OverviewService({
    devices: deviceService,
    alarms: alarmService,
    recordings: recordingRepo
  })

  // Playback needs the device client for on-demand downloads, which is why it is
  // built after the device service rather than alongside storage.
  const playbackService = new PlaybackService({
    storage,
    recordings: recordingRepo,
    devices: deviceService
  })

  // Long-term trend history (spec 12). Buffered in memory and flushed in batches
  // so the feature-stream hot path never performs disk I/O per sample.
  const trends = new TrendStorageService({ storage })
  const trendQuery = new TrendQueryService({ storage })

  /**
   * IoT 数据接入（业主 2026-09-19 第 1 条）：HTTP 推流 + 最小 MQTT broker。
   *
   * 建在这里（`trends` 与 `alarmRepo` 之后）是因为它**必须**把收到的数据交给那两个已有的
   * 所有者 —— 自己 new 一个趋势写入器或告警仓储，就会出现"推上来的历史与流出来的历史在
   * 两个文件里"这种事，而现场看到的只是"趋势图少了一段"。
   *
   * 依赖都写成薄薄的适配器，服务本身不认识 SQLite / Parquet：
   *   - `appendFeature` 与实时流走**同一个** `trends.append(deviceUid, feature)`；
   *   - `insertAlarm` 就是 `alarmRepo.insert`（它自带去重，设备重发不会产生第二条）；
   *   - `channelCountFor` 用来拒绝越界通道号（写到一个不存在的通道上会让趋势图凭空
   *     多出一条没人认识的曲线）；
   *   - `onTelemetry` 把"收到合法遥测"递给设备服务（业主 20260921 第 12 条：推送设备
   *     靠遥测上线/续命 lastSeen，健康检查对它们不做 HTTP 轮询）。
   */
  const iotIngest = new IotIngestService({
    getConfig: () => settings.get().iotIngest,
    resolveDevice: (secret) => {
      const device = deviceRepo.findByPushSecret(secret)
      return device ? { id: device.id, deviceUid: device.deviceUid, name: device.name } : undefined
    },
    intake: new TelemetryIntake({
      appendFeature: (deviceUid, feature) => trends.append(deviceUid, feature),
      insertAlarm: (input) => alarmRepo.insert(input),
      channelCountFor: (deviceId) => channelRepo.listByDevice(deviceId).length,
      onTelemetry: (deviceId) => deviceService.markOnlineFromTelemetry(deviceId)
    }),
    log: {
      info: (message, meta) => appLog().info(message, meta),
      warn: (message, meta) => appLog().warn(message, meta)
    }
  })

  /**
   * 设置一变就重新对账监听（改端口 / 开总开关都不需要重启应用）。
   *
   * `applyConfig()` 内部串行化并且是幂等的：设置页连着敲两下数字会触发两次，而"关旧监听 +
   * 起新监听"不是一个原子操作 —— 不排队就会留下一个没人持有句柄的监听（端口被占）。
   */
  settings.on('changed', () => {
    void iotIngest.applyConfig()
  })

  /**
   * 把"设备声明"翻译成设置里那三个开关，然后让接入服务对账（第 13 批第 1 条）。
   *
   * 三条口径：
   *   1. **操作员不再管总开关**：`enabled` = 有没有任何设备声明了 http/mqtt；
   *      `httpEnabled` / `mqttEnabled` = 有没有设备声明**那一种**。于是"给一台设备选了 HTTP 接入"
   *      就等于"本机在 8080 上听着"，而"把最后一台这样的设备删掉"就等于"关掉端口"
   *      （离线优先：本机不为没人用的协议开着监听）。
   *   2. **端口与绑定地址仍然是设置**（在这一版里由添加设备那个对话框编辑）：
   *      它们说的是"怎么听"，与"谁在推"是两件事。
   *   3. 只在**真的变了**的时候写设置：`settings.update()` 会广播 `changed`，而每一次广播
   *      都会让接入服务重新对账（停旧监听再起新的）—— 一次多余的广播就是一次无谓的抖动。
   */
  syncIngestFromDevices = (need: { http: boolean; mqtt: boolean }): void => {
    const current = settings.get().iotIngest
    const enabled = need.http || need.mqtt
    if (
      current.enabled === enabled &&
      current.httpEnabled === need.http &&
      current.mqttEnabled === need.mqtt
    ) {
      // 开关没变，但监听可能还没起来（启动那一刻）—— 对账一次是幂等的。
      void iotIngest.applyConfig()
      return
    }
    settings.update({
      iotIngest: { ...current, enabled, httpEnabled: need.http, mqttEnabled: need.mqtt }
    })
    appLog().info('本机接入监听跟着设备声明走', {
      enabled,
      http: need.http,
      mqtt: need.mqtt
    })
  }

  /**
   * 样本库 → 外部训练数据集。与 `SampleLibraryService` 分开：那一个只管"库里有什么"，
   * 这个要碰文件系统（清单、可选复制音频），而"会不会写盘"是会出错的边界，单独一层
   * 更容易在测试里给它一个临时目录。理由与取舍写在 `sample-dataset-export.ts` 文件头。
   */
  const sampleExport = new SampleDatasetExporter({
    samples: sampleRepo,
    // 相对路径 → 绝对路径，并且越界检查在 `StorageService.resolve()` 里只做一次。
    resolveAudioPath: (relativePath) => storage.resolve(relativePath),
    describeDevice: (deviceId) => {
      const device = deviceRepo.findById(deviceId)
      // 设备可能已经被删掉，而它的样本还在库里：那时名字缺席，不是错误。
      return device ? { name: device.name, kind: device.kind } : {}
    },
    appVersion: app.getVersion()
  })

  /**
   * 可插拔 AI 标注（业主 2026-09-16）。配置走 `app_meta` + `safeStorage` 加密的密钥，
   * 网络调用可注入 fetch（测试里指向本地 http 服务）。三条覆盖规矩与服务分层见
   * `sample-ai-label-service.ts` 文件头。
   */
  const sampleAi = new SampleAiLabelService({
    samples: sampleRepo,
    store: new SampleAiStore(appMeta),
    labels: sampleLabels,
    describeDevice: (deviceId) => {
      const device = deviceRepo.findById(deviceId)
      return device ? { name: device.name } : {}
    }
  })

  /**
   * 本机文件的回环端点（手动录像回放 + 告警抓图）。纯本地文件服务，没有设备参与。
   *
   * 建在 `e2` **之前**：告警抓图（SN-16 的 3 张球机抓图）也由它开端点，而两处必须是
   * **同一个实例** —— 端口与每会话令牌那套安全推理只该在一处成立。
   */
  const videoFiles = new VideoFileServer()

  /**
   * 听诊盒子族（E2 / FA100 / FA110）的「拉」通道（业主 2026-09-16）。
   *
   * 建在 `deviceService` 之后：它复用那边缓存的**带会话客户端**（token 在客户端里），
   * 自己 new 一个就等于每次同步都重新登录一次。
   */
  const e2 = new E2DeviceService({
    devices: deviceService,
    alarms: alarmRepo,
    recordings: recordingRepo,
    storage,
    files: videoFiles,
    // SN-16 realtime_value callback: reuse the shared HTTP ingest listener, so the
    // callback card needs the same port/bind/address inputs the device-ingest UI uses.
    getIngestConfig: () => settings.get().iotIngest,
    listLocalAddresses,
    getRealtimeListener: () => iotIngest.status.http
  })

  const protocolLab = new ProtocolLab({
    transport,
    credentials: credentialResult.store,
    timeoutMs: settings.get().requestTimeoutMs
  })

  /**
   * FA371 camera realtime streams.
   *
   * The resolver borrows the device's EXISTING HTTP session
   * (`Fa371ApiClient.authHeaders()` / `resolvedStrategyId`) instead of logging
   * in again: the token carrier was already discovered by the HTTP client, and
   * a second login would both waste a round trip and risk the device treating
   * the two sessions differently.
   *
   * When no client exists yet the service falls back to the device record's own
   * address and an empty header map, which lets the socket's `none` handshake
   * candidate do the talking — the FA371 manual never says how a WebSocket
   * authenticates (spec §8.4 D1), so "no auth" has to be a real, testable
   * possibility rather than a failure.
   */
  const fa371Streams = new Fa371StreamService({
    toWebSocketUrl,
    resolver: {
      get: (deviceId) => deviceService.get(deviceId),
      findAuthHeaders: (deviceId) => {
        // `findClient` returns the BOX client for a box and the CAMERA client
        // for a camera — the two families keep separate runtime caches, on
        // purpose. The double cast only expresses that: the two classes are not
        // structurally related, so neither `instanceof` nor a plain cast
        // type-checks, while at runtime this is exactly one or the other. Only
        // `Fa371ApiClient` exposes `authHeaders()`, and a box never reaches
        // this service (the IPC handler rejects a non-camera first).
        const client = deviceService.findClient(deviceId) as unknown as Fa371ApiClient | undefined
        return client && typeof client.authHeaders === 'function' ? client.authHeaders() : {}
      },
      findBaseUrl: (deviceId) => deviceService.findClient(deviceId)?.currentBaseUrl
    }
  })

  /**
   * Camera LIVE VIDEO (manual §5.1.6): RTSP in, fragmented MP4 over loopback out.
   *
   * The resolver reads the RTSP address from `GET /system/video` through
   * `DeviceService.getCameraVideoConfig`, i.e. through the camera client that already
   * holds the resolved auth strategy — this service must never log in to the device
   * itself. The device ACCOUNT is passed along only so the second RTSP URL candidate
   * (the form with credentials) can be tried: the manual never says whether RTSP is
   * authenticated, so that is a candidate rather than a guess (see `mappers`).
   */
  const cameraLive = new RtspStreamService({
    resolver: {
      getDevice: (deviceId) => {
        const device = deviceService.get(deviceId)
        const credential = credentialResult.store.get(deviceId)
        return {
          id: device.id,
          host: device.ip ?? '',
          ...(credential ? { credential } : {})
        }
      },
      getVideoConfig: (deviceId) => deviceService.getCameraVideoConfig(deviceId)
    },
    /**
     * 并发上限来自设置，并且**每次 start 都重新读**：改完设置的下一刻就生效，
     * 不需要重启应用，也不需要重建这个服务（`SettingsService.get()` 是内存读）。
     */
    maxConcurrentStreams: () => settings.get().maxConcurrentCameraStreams
  })

  /**
   * 相机 NVR 采集（手动录像 / 抓图）。
   *
   * `resolveSource` 直接问 `cameraLive` 要**当前可用的 RTSP 源**（含口令）：
   * 只有它知道这一路直播会话是否真的在出帧，也只有它持有未打码的地址。
   * 让采集服务自己去拼地址是错的——那会绕开已实测的候选顺序与认证假设。
   */
  const cameraCapture = new CameraCaptureService({
    storage,
    recordings: recordingRepo,
    resolveSource: (deviceId) => cameraLive.currentSource(deviceId),
    resolveDevice: (deviceId) => {
      const device = deviceService.get(deviceId)
      return { deviceUid: device.deviceUid, name: device.name }
    }
  })

  /**
   * 相机告警模型（策略 / 条件）。
   *
   * 客户端按需从 `DeviceService` 取，而不是在这里缓存一个：设备地址一变，
   * 缓存里的客户端就指向旧地址了。
   */
  const cameraAlarms = new CameraAlarmService({
    clientFor: (deviceId) => deviceService.cameraAlarmOperations(deviceId)
  })

  /**
   * 相机控制与维护。
   *
   * 客户端同样按需从 `DeviceService` 取（与 `cameraAlarms` 同一条路径：
   * 凭据、已持久化的认证方式、运行时缓存都在那里）。
   * `isOnline` 只读本地记录的状态，**不**额外探活 —— 维护卡里那个
   * 「打开设备 Web 界面」按钮只需要知道设备现在是否可达。
   */
  const cameraControl = new CameraControlService({
    clientFor: (deviceId) => deviceService.cameraAlarmOperations(deviceId),
    isOnline: (deviceId) => deviceService.get(deviceId).status === 'ONLINE'
  })

  /**
   * 相机固件升级（设备自带 Web 界面用的那条 HTTP 路）。
   *
   * 客户端按需从 `DeviceService` 取，理由与 `cameraControl` 相同：凭据、已持久化的
   * 认证方式与运行时缓存都在 `cameraClientFor` 那条路径上。升级服务只用它拿基地址
   * 与已认证的请求头；**上传本身走 `node:http` 流式发送**，不经过 `HttpTransport`
   * （那条路会把整个请求体交给 fetch，几十 MB 的包会整体进内存，也拿不到中途字节数）。
   */
  const cameraUpgrade = new CameraUpgradeService({
    clientFor: (deviceId) => deviceService.cameraMaintenanceOperations(deviceId)
  })

  /**
   * 告警本地联动（录像 / 弹窗 / 提示 / 邮件）。
   *
   * 全部依赖从**已经建好的**服务里取，不新建第二个：
   *   - RTSP 源问 `cameraLive.currentSource()` —— 只有它知道这一路会话是否在出帧，
   *     也只有它持有未打码的地址（联动录像与抓帧都走它）；
   *   - 检测日志问 `deviceService.cameraDetectLogs()` —— 复用同一个 HTTP 客户端的
   *     会话与认证结论，不重复登录；
   *   - `/detectFeedback` 加速器挂在 `fa371Streams` 的 `preview` 事件上，
   *     **不自己开 socket**（相机的连接数是有限的，操作员的实时画面优先）。
   *
   * `text` 是弹窗文案的解析器。这里给的是**主进程能给出的最诚实的答案**：
   * 主进程不持有界面语言，所以只把设备名、时刻与目录键拼成一段中性文本；
   * 渲染层的待处理列表用的是完整翻译的文案（它有语言）。
   */
  const linkage = new AlarmLinkageService({
    settings,
    secrets: credentialResult.store,
    userDataDir,
    storage,
    recordings: recordingRepo,
    devices: deviceService,
    resolveSource: (deviceId) => cameraLive.currentSource(deviceId),
    streamEvents: fa371Streams,
    text: (key, params) => {
      // 目录键 + 设备名 + 时刻；不含任何中文句子，所以不会在英语界面上
      // 冒出一句中文。
      return [key, params.device, params.time].filter((part) => part && part !== '').join(' · ')
    }
  })

  /**
   * 相机检测库（读检测日志 + 下载结果文件）。
   *
   * 客户端复用 `deviceService.cameraAlarmOperations()`：凭据、已持久化的认证
   * 方式与运行时缓存都在那一条路径上，另建一个客户端意味着第二次认证探测与
   * 第二份会话状态。该方法在非相机设备上会抛出一句明确的话，这也正是
   * 「这台设备没有检测日志」应有的答复。
   */
  const detectLibrary = new DetectLibraryService({
    clientFor: (deviceId) => deviceService.cameraAlarmOperations(deviceId),
    storage,
    recordings: recordingRepo
  })

  /**
   * 事件与告警中心：三路来源的合并处。
   *
   * `recordings.listByDevice` 走仓库自己的一页查询（上限由仓库夹紧）：
   * `recordings` 表没有以 `remote_recording_id` 为键的索引，而这些文件在总数里
   * 占比很小，所以扫一页比加索引/改表（表结构对本次改动是冻结的）更合适。
   */
  const eventCenter = new EventCenterService({
    listDevices: () =>
      deviceService.list().map((device) => ({
        id: device.id,
        name: device.name,
        kind: device.kind
      })),
    detectLibrary,
    linkage,
    alarms: alarmRepo,
    deviceStatus: deviceStatusEventRepo,
    recordings: {
      findById: (id) => recordingRepo.findById(id),
      listByDevice: (deviceId) => recordingRepo.query({ deviceId, limit: 1000, offset: 0 }).items
    },
    // 图片证据：回环端点用与录像回放**同一个**实例（那一套"只绑回环 + 每会话令牌 +
    // 不对就 403 并记日志"的推理只需要在一处成立），路径解析用存储服务（内含越界保护）。
    images: videoFiles,
    storage,
    // 处置工作流（schema v13）：状态与 Activity 在我们自己的表里，与三路来源解耦。
    statuses: eventStatusRepo,
    // Incident（schema v14）：同样是**我们自己的**关联记录，按同一套 entry id 存。
    incidents: incidentRepo
  })

  // ---- Startup tasks ------------------------------------------------------
  // Verify the storage root is usable and report rather than crash.
  storage.assertWritable().catch((error: unknown) => {
    storageLog().error('Storage root is not writable', {
      root: settings.get().storageRoot,
      reason: error instanceof Error ? error.message : String(error)
    })
  })

  // Retention sweep runs once at startup, never on a timer: deleting files
  // while the user is browsing recordings is worse than a slightly late sweep.
  storage
    .enforceRetention(settings.get().retentionDays)
    .then((result) => {
      if (result.deletedFiles > 0) {
        storageLog().info('Retention sweep complete', result)
      }
    })
    .catch((error: unknown) => {
      storageLog().warn('Retention sweep failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    })

  deviceService.startMonitor()

  /**
   * IoT 接入：启动时按**库里那几台设备的声明**对齐一次。
   *
   * 为什么不是"读设置里那个开关"：第 13 批第 1 条之后那个开关是**派生**的
   * （`syncIngestFromDevices()` 写的）。应用上一次退出时留下的值可能与库里的设备对不上
   * （例如上一次是在加完设备之后被强杀的），而库里的声明才是真相。所以这里从设备表算一遍，
   * 再对账 —— 磁盘上那个开关只会被这一次计算覆盖。
   *
   * **不 await**：`listen()` 失败（端口被占/地址不属于本机）不该拦住应用启动，
   * 而状态里的 `error` 就是给界面看的。
   */
  {
    const declared = deviceRepo.listIngestProtocols()
    syncIngestFromDevices({
      http: declared.includes('http'),
      mqtt: declared.includes('mqtt')
    })
  }
  void iotIngest.applyConfig()

  /**
   * 告警联动服务在这里启动：它必须在 IPC 处理器注册**之前**就绪，
   * 否则设置页第一次打开会读到一个还没连上触发源的引擎。
   */
  linkage.start()

  /**
   * Feed realtime features into long-term trend storage (spec 12).
   *
   * Wired here, at the composition root, because DeviceService owns the streams
   * and TrendStorageService owns Parquet, and neither should know about the
   * other. The handler is deliberately synchronous and allocation-light: it only
   * pushes onto an in-memory buffer, so a slow disk can never delay frame
   * processing on the feature stream.
   */
  deviceService.on('feature', (event: { deviceId: string; feature: RealtimeFeature }) => {
    try {
      const device = deviceRepo.findById(event.deviceId)
      // Directory layout is keyed by the stable uid, so history survives a device
      // being removed and re-added under a new local row id.
      const deviceUid = device?.deviceUid ?? event.deviceId
      trends.append(deviceUid, event.feature)
    } catch (error) {
      // Never let a trend-write problem surface as a stream failure.
      appLog().warn('Trend append failed', {
        deviceId: event.deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  })

  services = {
    db,
    settings,
    storage,
    credentials: credentialResult.store,
    credentialsPersistent: credentialResult.persistent,
    auth,
    devices: deviceService,
    fa371Streams,
    cameraLive,
    cameraCapture,
    cameraAlarms,
    cameraControl,
    cameraUpgrade,
    linkage,
    detectLibrary,
    eventCenter,
    videoFiles,
    recordingRepo,
    /**
     * 本地样本库的仓库（schema v7）。单独挂出来是给**导出**用的：清单要按库的顺序读全表，
     * 而"从告警/录音入库"那两条路走的是 `sampleLibrary`。挂同一个实例，避免两个连接两种口径。
     */
    sampleRepo,
    sampleLibrary,
    sampleLabels,
    sampleExport,
    sampleAi,
    e2,
    iotIngest,
    alarms: alarmService,
    recordings: recordingService,
    overview: overviewService,
    protocolLab,
    playback: playbackService,
    trends,
    trendQuery,
    transport,
    dispose: async () => {
      appLog().info('Shutting down services')
      // Order: stop network activity first, then close the database, so no
      // in-flight write can hit a closed handle (appendix C rule 12).
      // The camera sockets are closed FIRST and synchronously: they belong to a
      // different device family, and leaving them open while the box streams
      // unwind would keep the process alive after the window closes.
      fa371Streams.dispose()
      // 采集服务自己的子进程与未收尾的录像文件先处理：它登记录像行时需要
      // 数据库还活着（在 db.close() 之前），也需要在 ffmpeg 全量清扫之前收尾，
      // 否则一个正在录像的 ffmpeg 会被 killAllFfmpeg 直接杀掉而没有登记。
      cameraCapture.dispose()
      // 播放端点先关：它与 ffmpeg 无关，但会占着端口与文件句柄。
      videoFiles.dispose()
      // 告警联动：先停触发源（否则轮询定时器会在服务拆解期间继续读设备），
      // 再收尾可能正在跑的联动录像与弹窗。它自己也会 kill 掉 ffmpeg 子进程，
      // 所以顺序必须在 `killAllFfmpeg` 之前。
      linkage.dispose()
      // 入站接入服务：先停监听（不再收新数据），再让下面的趋势 flush 把已经收到的写出去。
      // 反过来的话，关库期间到达的一条推送会撞上已经关掉的 SQLite 句柄。
      await iotIngest.dispose()
      // Same reason, and more urgently: this one owns ffmpeg child processes. An
      // orphaned transcoder would keep an RTSP connection open on the camera (its
      // measured client limit is 6) and hold this process alive.
      cameraLive.dispose()
      await deviceService.dispose()

      // Flush AFTER the streams stop, so no new rows arrive mid-write, and
      // BEFORE the database closes. Up to 60 seconds of buffered history would
      // otherwise be lost on every shutdown.
      await trends.dispose().catch((error: unknown) => {
        appLog().warn('Trend flush on shutdown failed', {
          reason: error instanceof Error ? error.message : String(error)
        })
      })
      try {
        db.close()
      } catch (error) {
        appLog().warn('Database close failed', {
          reason: error instanceof Error ? error.message : String(error)
        })
      }
      services = undefined
    }
  }

  return services
}

export function getServices(): AppServices {
  if (!services) throw new Error('Services are not initialised')
  return services
}
