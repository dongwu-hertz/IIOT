/**
 * IPC handlers — the trust boundary.
 *
 * Every renderer-initiated action enters here. Two invariants hold for all
 * handlers:
 *
 *   1. They return `DeviceResult<T>`, never a thrown exception. A rejected
 *      promise crossing IPC loses its structure and surfaces as an opaque
 *      "Error invoking remote method", which is precisely the raw-exception
 *      display spec 14.2 forbids.
 *   2. They do no business logic. They validate shape, delegate to a service,
 *      and normalise the outcome. The renderer cannot reach a device except
 *      through a service.
 */

import { ipcMain, shell, dialog, BrowserWindow, app } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { IpcChannels } from '@shared/ipc/contract'
import type { RecorderSetEnabledInput, RecorderStatusView } from '@shared/ipc/contract'
import type {
  AddDeviceInput,
  UpdateDeviceInput
} from '@shared/domain/models'
import type {
  AppInfo,
  AppSettings,
  CameraAlarmConditionDraft,
  CameraAlarmConditionIdStyle,
  CameraAlarmRegionMetadataInput,
  CameraAlarmDiagnosisKeyStyle,
  CameraAlarmStrategyDraft,
  CameraLeakagePatch,
  CameraLiveStartInput,
  CameraLiveState,
  CameraModePresetId,
  CameraModeRequestedValues,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventEvidenceImageInput,
  EventIncidentCreateInput,
  EventIncidentLinkInput,
  EventIncidentUnlinkInput,
  EventStatusChangeInput,
  Fa371MonitorState,
  Fa371RunModeValue,
  Fa371ScanArea,
  Fa371StreamKind,
  Fa371StreamSubscription,
  Fa371WorkModeValue,
  LinkageTestEmailInput,
  MonitorState,
  MonitorSubscription,
  AppSettingsPatch,
  DiskUsage,
  EndpointProbeResult,
  ProbeResult as ProbeResultContract,
  SampleAiConfigInput,
  SampleAiLabelRequest,
  SampleAiServiceInput,
  SampleExportRequest,
  E2SyncRequest,
  /** IoT 接入的读数（业主 2026-09-19 第 1 条）：监听事实 + 收数统计。 */
  IotIngestRuntimeStatus,
  /** 瓦片缓存下载（业主 20260921 批）：入参收窄后的形状 + 返回类型。 */
  MapTileCacheRequest,
  MapTileCacheResult
} from '@shared/ipc/contract'
import { isAiServicePreset } from '@shared/domain/sample-ai'
import { MAX_FEATURE_CHANNELS } from '@shared/domain/monitoring'
import { normaliseRecorderConfig } from '@shared/domain/recorder-config'
import { AppError, ErrorCodes, toResult, type DeviceResult } from '@shared/errors'
import type {
  ChangePasswordInput,
  CopyUserPermissionsInput,
  CreateUserInput,
  LoginInput,
  RecoverAccountInput,
  ResetUserPasswordInput,
  UpdateUserPermissionsInput,
  UpdateUserProfileInput,
  UserPermissionKey,
  UserRole
} from '@shared/domain/auth'
import { RELEASE } from '@shared/release'
import { attachStreamForwarding } from './monitor-bridge'
import { attachFa371StreamForwarding } from './fa371-stream-bridge'
import { FA371_ALL_STREAM_KINDS } from '@shared/domain/fa371-stream'
import { PushChannels } from '@shared/ipc/contract'
import type { ConfigService } from '../services/device/config-service'
import { E2_SYNC_MAX_LIMIT } from '../services/device/e2/e2-device-service'
import type { E2PtzPatch } from '@shared/domain/e2-ptz'
import type { AlarmProfileConfig } from '../services/device/config-service'
import type { TrendQueryBody } from '@shared/domain/trend'
import type { TrendExportRequest, TrendExportResult } from '@shared/domain/trend-export'
import { SystemControlAction } from '../services/device/protocol/dto'
import { EVENT_CENTER_DEFAULT_LIMIT, type EventSeverity } from '@shared/domain/event-center'
import type { RememberLoginInput } from '@shared/domain/auth'
import { isSampleLabelDimension, isSampleLabelSource, type SampleLabelSource } from '@shared/domain/sample-library'
import { getServices } from '../services/app-services'
import { appLog, deviceLog } from '../services/logging/logger'
import { setUiLocale } from '../services/ui-locale'
import { normaliseBaseUrl } from '../services/device/device-api-client'
import { listLocalAddresses } from '../services/ingest/local-addresses'

/**
 * Register every handler exactly once.
 * Called after `app.whenReady()` and after services are initialised.
 */
/**
 * Live push-forwarding disposers, keyed by device id.
 *
 * Without this map, calling `monitor.start` twice would attach two sets of
 * listeners and every frame would be sent to the renderer twice — which on a
 * chart looks like doubled frequency content rather than an obvious bug.
 */
const streamForwarding = new Map<string, () => void>()

/**
 * Live push-forwarding disposers for the FA371 camera streams, keyed by device.
 *
 * The same reason as `streamForwarding` above: attaching twice would push every
 * camera frame to the renderer twice, which on a spectrum chart looks like
 * doubled frequency content rather than an obvious bug.
 */
const fa371Forwarding = new Map<string, () => void>()


/**
 * Authorisation guards used INSIDE handlers.
 *
 * They throw `AppError`, which `toResult` turns into the same `DeviceResult`
 * envelope as every other failure — so an unauthorised call is a normal, typed
 * error the UI can render, not a protocol-level rejection.
 *
 * WHY GUARDS RATHER THAN A WRAPPER
 * A wrapper (`guardAdmin(handler)`) reads nicely but hides the check from the
 * handler body, and the failure mode of forgetting it is silent. These are called
 * as the first statement of the handlers that need them, where a reviewer looking
 * at a handler can see whether it is guarded.
 */
function requireAdministrator(): void {
  getServices().auth.requireAdministrator()
}

/**
 * 要求当前会话持有某一项**逐项勾选**的权限（手册 §17.1 的复选框）。
 *
 * 与 `requireAdministrator()` 的关系：那一条是**角色**层面的硬规则，这一条是角色
 * 之上细粒度授权。它紧跟在每一条 `requireAdministrator()` **之后**出现，因此：
 *
 *   - 管理员照旧全部通过（`AuthService.requirePermission` 对管理员直接放行），
 *     所以给既有写路径加这一条不会改变今天任何一条真实行为；
 *   - 操作员照旧被 `requireAdministrator()` 拒绝，但拒绝的理由现在可以精确到
 *     「缺 `configureDevices`」这一项，而且这个理由是**可测**的
 *     （`tests/account-settings-round.test.ts` 用一个操作员会话逐项验证）。
 *
 * 换言之：勾选框不是装饰 —— 它管的通道写在共享层的 `PERMISSION_OPERATIONS` 里，
 * 判定在服务里，两者由测试对齐。
 */
function requirePermission(permission: UserPermissionKey): void {
  getServices().auth.requirePermission(permission)
}

/**
 * 相机告警通道的入参校验：设备 id 必须是非空字符串。
 *
 * **不**在这里判断设备族（`acousticCamera`）：那要读数据库，而 `DeviceService`
 * 已经拥有「这台设备是不是相机」的唯一判断（`cameraAlarmOperations` 会在非相机
 * 时抛出一句明确的话）。校验形状在这里、校验事实在服务里。
 */
function requireCameraDeviceId(deviceId: unknown): asserts deviceId is string {
  if (typeof deviceId !== 'string' || deviceId.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
  }
}

/**
 * 还原请求的入参校验：只接受**数值**，其余一律丢掉。
 *
 * 为什么在这里再洗一遍而不是信任渲染层：还原的输入来自"上一次读到的设备事实"，
 * 它要原样写回设备。多一个键就多写一个字段，所以只放行下面列出的那几个名字，
 * 且值必须是有限数。一个 `undefined` 不会被补成 0，而是整项不写
 * （`buildAcousticWriteBody` / `buildImagingWriteBody` 只发有值的字段）。
 */
function sanitiseModeValues(values: unknown): CameraModeRequestedValues {
  const source = (values ?? {}) as { acoustic?: unknown; imaging?: unknown }
  return {
    acoustic: pickModeNumbers(source.acoustic, ['lowerKhz', 'upperKhz', 'sampleRateRaw']) as CameraModeRequestedValues['acoustic'],
    imaging: pickModeNumbers(source.imaging, [
      'targetCount',
      'imagingSensitivity',
      'imagingEnhance',
      'energyThreshold'
    ]) as CameraModeRequestedValues['imaging']
  }
}

function pickModeNumbers(source: unknown, keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  if (source === null || typeof source !== 'object') return out
  const record = source as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * PTZ 补丁的收窄（渲染层送什么都不会把主控权拿走）。
 *
 * 规则与本仓库其他"从 IPC 进来的形状"一致：**只认已知的键、只认对应的类型**，其余丢掉。
 * 丢掉的两种可能都要在这里挡住，因为它们都会造成"看起来保存成功了"的假象：
 *   - 未知键（例如以后界面加了一个字段而这里没跟上）—— 丢掉之后服务层读回核对会说"没生效"；
 *   - 类型不对（例如把 `cam_port` 送成字符串）—— 丢掉之后那一项根本没写，而写回核对会如实报出来。
 *
 * 范围校验（端口 1..65535、通道 1..通道数、球机地址形状）**不在这里**：那套判据与界面共用
 * 同一个 `validatePtzPatch()`，放在服务层一处，免得出现"界面允许、主进程拒绝"这种只有某台
 * 设备上才暴露的不一致。
 */
/**
 * 瓦片缓存下载入参的收窄（渲染层送什么都不会把主控权拿走）。
 *
 * 与 `normalisePtzPatch()` 同一套纪律：**只认已知键、只认对应类型**，其余丢掉或给 NaN
 * （服务层的 `validateRequest()` 会按共享层判据再拒绝一次）。范围校验不在这里 ——
 * 缩放级别区间、区域「南 < 北」这些判据与界面共用一份，放在服务层一处。
 */
function sanitiseTileCacheRequest(input: unknown): MapTileCacheRequest {
  if (input === null || typeof input !== 'object') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '缓存下载参数不合法')
  }
  const source = input as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
  const rawBounds =
    source.bounds !== null && typeof source.bounds === 'object'
      ? (source.bounds as Record<string, unknown>)
      : {}
  return {
    service: text(source.service) as MapTileCacheRequest['service'],
    urlTemplate: text(source.urlTemplate),
    apiKey: text(source.apiKey),
    attribution: text(source.attribution),
    minZoom: num(source.minZoom),
    maxZoom: num(source.maxZoom),
    bounds: {
      minLat: num(rawBounds.minLat),
      minLon: num(rawBounds.minLon),
      maxLat: num(rawBounds.maxLat),
      maxLon: num(rawBounds.maxLon)
    }
  }
}

function normalisePtzPatch(input: unknown): E2PtzPatch {
  const out: E2PtzPatch = {}
  if (input === null || typeof input !== 'object') return out
  const source = input as Record<string, unknown>
  for (const key of ['enabled', 'directionSameAsSonar', 'saveSnapshot'] as const) {
    if (typeof source[key] === 'boolean') out[key] = source[key]
  }
  for (const key of ['cameraIp', 'cameraUser', 'cameraPassword'] as const) {
    if (typeof source[key] === 'string') out[key] = source[key]
  }
  for (const key of ['cameraPort', 'realtimeChannel'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/**
 * WHAT IS AND IS NOT GUARDED, STATED PLAINLY
 *
 * Guarded (administrator required): account management, device add/update/remove,
 * every device CONFIGURATION write, and everything under Maintenance. Those are
 * the operations that change what the hardware does or who may use the software.
 *
 * NOT guarded: reads. Listing devices, querying alarms and recordings, reading
 * configuration, running the protocol lab. This is deliberate rather than an
 * oversight:
 *
 *   - The renderer is our own bundle, loaded from disk, behind a strict CSP with
 *     no remote content, and it does not render anything until a session exists —
 *     so the login screen, not a handler guard, is what keeps an unauthenticated
 *     person out of the UI.
 *   - Requiring a session on ~40 read handlers would mean 40 places to forget one,
 *     and a forgotten read guard is invisible whereas a forgotten write guard is
 *     a real escalation. Concentrating the checks on the operations that matter
 *     keeps the ones that exist reviewable.
 *
 * The honest limitation: a hostile renderer could still READ. If this app ever
 * gains a remote-access mode, reads must be guarded too — the session already
 * lives in the main process, so that change is additive.
 */
function actor(): string {
  return getServices().auth.currentSession()?.user.username ?? 'anonymous'
}


export function registerIpcHandlers(): void {
  // -------------------------------------------------------------------------
  // App
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.APP_SET_LOCALE, (_event, locale: unknown): Promise<DeviceResult<void>> =>
    toResult(async () => {
      // 界面语言的单向镜像（渲染层是权威）：主进程只用它渲染告警弹窗文案。
      setUiLocale(typeof locale === 'string' ? locale : '')
    })
  )

  ipcMain.handle(IpcChannels.APP_GET_INFO, (): Promise<DeviceResult<AppInfo>> =>
    toResult(async () => {
      const services = getServices()
      return {
        name: 'HAIS',
        /*
         * NOT `app.getVersion()`.
         *
         * Unpackaged, Electron returns ITS OWN version there — the smoke test
         * caught the About panel reporting 38.8.6 for a 1.0.0 application. The
         * bundled value comes from the same package.json that electron-builder
         * stamps into the installer, so it is correct in both dev and release,
         * and it cannot disagree with the filename of the artifact.
         */
        version: RELEASE.version,
        releaseDate: RELEASE.releaseDate,
        buildDate: RELEASE.buildDate,
        homepage: RELEASE.homepage,
        supportEmail: RELEASE.supportEmail,
        electronVersion: process.versions.electron,
        chromeVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        databasePath: path.join(app.getPath('userData'), 'hertzinno-manager.db'),
        storageRoot: services.settings.get().storageRoot,
        isDev: !app.isPackaged
      }
    })
  )

  /**
   * OS UI languages, most preferred first.
   *
   * `app.getPreferredSystemLanguages()` is the accurate source: it returns what
   * the user configured in Windows, in their order of preference, and keeps the
   * region (`tr-TR`, not just `tr`). `app.getLocale()` is kept as a fallback for
   * Electron builds where the plural accessor is unavailable.
   *
   * Read-only and cheap, so it needs no service and no caching; the renderer
   * calls it once on first launch.
   */
  ipcMain.handle(
    IpcChannels.APP_GET_PREFERRED_LANGUAGES,
    (): Promise<DeviceResult<string[]>> =>
      toResult(async () => {
        const preferred =
          typeof app.getPreferredSystemLanguages === 'function'
            ? app.getPreferredSystemLanguages()
            : []
        if (preferred.length > 0) return preferred
        const single = app.getLocale()
        return single ? [single] : []
      })
  )

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Open an external link in the system handler.
   *
   * SCHEME ALLOW-LIST, deliberately narrow. This handler is reachable from the
   * renderer, and `shell.openExternal` will happily hand `file://`, `smb://` or a
   * custom protocol to the OS. Restricting it to the two schemes this app
   * actually needs means a compromised renderer cannot use it to launch
   * arbitrary local handlers.
   */
  ipcMain.handle(IpcChannels.APP_OPEN_EXTERNAL, (_event, rawUrl: string) =>
    toResult(async () => {
      if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '链接地址为空')
      }
      const target = rawUrl.trim()

      let parsed: URL
      try {
        parsed = new URL(target)
      } catch {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `链接格式不正确: ${target}`)
      }

      /**
       * `rtsp:` / `rtsps:` 是**为相机新增**的，且仍然刻意排除了 `file:`/`smb:`。
       *
       * 为什么可以放开：这两个 scheme 交给操作系统时只会启动一个已注册的媒体
       * 播放器（RTSP 客户端的注册项），不像 `file://`/`smb://` 那样能触发本地
       * 可执行文件或网络共享挂载；地址本身来自设备配置（`GET /system/video`），
       * 由管理员显式点击「在外部播放器打开」才发出。渲染层的 CSP 仍然禁止它
       * 自己发起任何网络请求，所以这条通道不会变成任意网络访问。
       */
      const allowed = ['https:', 'http:', 'mailto:', 'rtsp:', 'rtsps:']
      if (!allowed.includes(parsed.protocol)) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `不允许打开该类型的链接: ${parsed.protocol}`
        )
      }

      await shell.openExternal(target)
      appLog().info('Opened external link', { protocol: parsed.protocol, host: parsed.host })
      return undefined
    })
  )

  /**
   * 在系统文件管理器里定位一个文件（抓图完成后的「打开所在文件夹」）。
   *
   * 与上面的外部打开相反：这里**只**接受存储根内的本地路径。校验用
   * `StorageService.resolve()`——它已经承担了「相对/绝对都归一化 + 越界即抛」
   * 的职责（见 `tests/storage-paths.test.ts`），在这里再写一遍路径判断只会
   * 多一处可能写错的地方。
   */
  ipcMain.handle(IpcChannels.APP_REVEAL_FILE, (_event, rawPath: string) =>
    toResult(async () => {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '文件路径为空')
      }
      const absolute = getServices().storage.resolve(rawPath.trim())
      shell.showItemInFolder(absolute)
      appLog().info('Revealed file in the system file manager', { path: absolute })
      return undefined
    })
  )

  // -------------------------------------------------------------------------
  // Application accounts
  //
  // Login and recovery are reachable WITHOUT a session — that is what they are
  // for. Everything that manages accounts requires an administrator, and the
  // checks are re-done here rather than trusted from the renderer.
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.AUTH_LOGIN, (_event, input: LoginInput) =>
    toResult(async () => getServices().auth.login(input))
  )

  ipcMain.handle(IpcChannels.AUTH_LOGOUT, () =>
    toResult(async () => {
      getServices().auth.logout()
    })
  )

  /**
   * Current session, or `null`.
   *
   * Success-with-null rather than an error: "nobody is signed in" is the normal
   * state on every start, and modelling it as a failure would mean the login
   * screen is reached through an error path.
   */
  ipcMain.handle(IpcChannels.AUTH_SESSION, () =>
    toResult(async () => getServices().auth.currentSession() ?? null)
  )

  ipcMain.handle(IpcChannels.AUTH_INSTALL_ID, () =>
    toResult(async () => getServices().auth.installId())
  )

  /**
   * 「记住上次的用户名 / 记住密码」（业主 2026-09-16）。
   *
   * 三个都没有权限守卫，与 `AUTH_LOGIN` / `AUTH_RECOVER` 同一类：登录页要在**没有会话**的
   * 时候被预填，那时没有可检查的身份。这不是放宽了权限模型 —— 能读回记住的密码的只有本应用
   * 自己的渲染进程，而它在用户输入密码时本来就会拿到同一个字符串。
   *
   * 落盘的部分由 `RememberedLoginStore` 负责：`safeStorage` 加密之后才写 `app_meta`，
   * 系统加密不可用时只记用户名（spec 14.1：不得明文存 SQLite）。
   */
  ipcMain.handle(IpcChannels.AUTH_REMEMBERED_LOGIN, () =>
    toResult(async () => getServices().auth.rememberedLogin())
  )

  ipcMain.handle(IpcChannels.AUTH_REMEMBER_LOGIN, (_event, input: RememberLoginInput) =>
    toResult(async () => {
      getServices().auth.rememberLogin({
        username: String(input?.username ?? ''),
        ...(input?.password ? { password: String(input.password) } : {}),
        rememberPassword: input?.rememberPassword === true,
        userTypedPassword: input?.userTypedPassword === true
      })
    })
  )

  ipcMain.handle(IpcChannels.AUTH_FORGET_REMEMBERED_LOGIN, () =>
    toResult(async () => {
      getServices().auth.forgetRememberedLogin()
    })
  )

  ipcMain.handle(IpcChannels.AUTH_CHANGE_PASSWORD, (_event, input: ChangePasswordInput) =>
    toResult(async () => getServices().auth.changePassword(input))
  )

  ipcMain.handle(IpcChannels.AUTH_RECOVER, (_event, input: RecoverAccountInput) =>
    toResult(async () => getServices().auth.recoverAccount(input))
  )

  ipcMain.handle(IpcChannels.AUTH_LIST_USERS, () =>
    toResult(async () => getServices().auth.listUsers())
  )

  ipcMain.handle(IpcChannels.AUTH_CREATE_USER, (_event, input: CreateUserInput) =>
    toResult(async () => getServices().auth.createUser(input))
  )

  ipcMain.handle(IpcChannels.AUTH_DELETE_USER, (_event, userId: string) =>
    toResult(async () => {
      getServices().auth.deleteUser(userId)
    })
  )

  ipcMain.handle(
    IpcChannels.AUTH_RESET_PASSWORD,
    (_event, input: ResetUserPasswordInput) =>
      toResult(async () => getServices().auth.resetUserPassword(input))
  )

  ipcMain.handle(IpcChannels.AUTH_SET_ROLE, (_event, userId: string, role: UserRole) =>
    toResult(async () => getServices().auth.setUserRole(userId, role))
  )

  /**
   * 账号权限（手册 §17.1）。两条都**只**要求管理员，服务里还会再判一次目标角色
   * （管理员的权限恒为全权，不能逐项改）。
   */
  ipcMain.handle(
    IpcChannels.AUTH_SET_PERMISSIONS,
    (_event, input: UpdateUserPermissionsInput) =>
      toResult(async () => getServices().auth.updateUserPermissions(input))
  )

  ipcMain.handle(
    IpcChannels.AUTH_COPY_PERMISSIONS,
    (_event, input: CopyUserPermissionsInput) =>
      toResult(async () => getServices().auth.copyPermissions(input))
  )

  ipcMain.handle(
    IpcChannels.AUTH_UPDATE_PROFILE,
    (_event, input: UpdateUserProfileInput) =>
      toResult(async () => getServices().auth.updateUserProfile(input))
  )

  ipcMain.handle(IpcChannels.SETTINGS_GET, (): Promise<DeviceResult<AppSettings>> =>
    toResult(async () => {
      const services = getServices()
      /**
       * 回给渲染层的设置里，`alarmLinkage.email.smtpPasswordStored` 是**主进程
       * 填的**：口令在 DPAPI 凭据库里，设置表里没有它，而界面必须能回答
       * 「现在到底存没存」。渲染层提交回来的这个字段会被归一化器丢掉，
       * 所以它无法被伪造（见 `SettingsService.describeAlarmLinkage`）。
       */
      return {
        ...services.settings.get(),
        alarmLinkage: services.settings.describeAlarmLinkage(
          services.linkage.smtpPasswordStored()
        )
      }
    })
  )

  ipcMain.handle(
    IpcChannels.SETTINGS_UPDATE,
    (_event, patch: AppSettingsPatch): Promise<DeviceResult<AppSettings>> =>
      toResult(async () => {
        // 写系统设置（手册 §17.1 的「系统设置写入」）。这里是 `manageSystemSettings`
        // 的**主入口**，另外两处是恢复默认值与告警声音文件选择。
        //
        // 两条守卫都在：`requireAdministrator()` 是仓库原有的角色规则（这一步**没有**
        // 放宽），`requirePermission()` 是手册的逐项授权。管理员永远同时通过两条，
        // 所以对今天的行为没有影响。
        requireAdministrator()
        requirePermission('manageSystemSettings')
        const services = getServices()
        const { settings, rejected, smtpPassword } = services.settings.update(patch)
        if (rejected.length > 0) {
          // Report rather than silently coerce: a user who typed 0 for the
          // retention window must be told it was refused.
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            `以下设置值不合法，已忽略：${rejected.join(', ')}`
          )
        }
        // A new storage root needs its directory skeleton immediately.
        await services.storage.ensureLayout(settings.storageRoot)

        /**
         * SMTP 口令是设置里**唯一**的只写字段：它已经从设置对象里被摘掉了
         * （因此不会进 SQLite），这里把它交给 DPAPI/safeStorage 凭据库。
         *
         * 顺序在 `settings.update()` 之后：先落设置再落口令，失败的话用户会看到
         * 一个明确的错误，而不是「设置没保存但口令悄悄存了」。
         */
        if (smtpPassword !== undefined) {
          services.linkage.setSmtpPassword(smtpPassword)
          appLog().info('SMTP 口令已更新', {
            stored: smtpPassword !== '',
            by: actor()
          })
        }

        return {
          ...settings,
          alarmLinkage: services.settings.describeAlarmLinkage(
            services.linkage.smtpPasswordStored()
          )
        }
      })
  )

  ipcMain.handle(
    IpcChannels.SETTINGS_PICK_STORAGE_DIR,
    (event): Promise<DeviceResult<string | null>> =>
      toResult(async () => {
        const window = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: '选择音频存储目录',
          properties: ['openDirectory', 'createDirectory'] as const,
          buttonLabel: '使用此目录'
        }
        const result = window
          ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
          : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0] ?? null
      })
  )

  ipcMain.handle(IpcChannels.SETTINGS_DISK_USAGE, (): Promise<DeviceResult<DiskUsage>> =>
    toResult(async () => getServices().storage.quotaUsage())
  )

  /**
   * 告警声音库的文件选择（手册 §17.2.7）。
   *
   * 与 `SETTINGS_PICK_STORAGE_DIR` 同一形状：只打开原生对话框、回一个路径，
   * 什么都不写。加管理员校验的理由与 `SETTINGS_UPDATE` 相同 —— 这条路径只服务于
   * 一个会写系统设置的界面。
   *
   * 对话框的过滤器只列 `.wav`（手册第 5448 行的硬约束），但**选中之后不在这里判
   * 扩展名**：判断只在共享层的 `isAcceptableAlarmSoundFile()` 一处，界面据此明确
   * 说「只支持 .wav」并拒绝把不合格的路径写进草稿。悄悄吞掉一个 `.mp3` 会让用户
   * 以为是自己点错了。
   */
  ipcMain.handle(
    IpcChannels.SETTINGS_PICK_ALARM_SOUND,
    (event): Promise<DeviceResult<string | null>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('manageSystemSettings')
        const window = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: '选择告警声音文件',
          properties: ['openFile'] as const,
          filters: [
            { name: 'WAV 音频', extensions: ['wav'] },
            { name: '全部文件', extensions: ['*'] }
          ]
        }
        const result = window
          ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
          : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0] ?? null
      })
  )

  /**
   * 「恢复默认值」（手册 §17.2 的 Default Value）。
   *
   * 要求管理员（与 `SETTINGS_UPDATE` 一致），并且**不接受任何入参** ——
   * 被重置的键由 `SettingsService.RESTORABLE_SETTING_KEYS` 定义，渲染层只能请求
   * 这件事发生，不能决定它覆盖什么。
   *
   * 范围收窄并写在契约里：只重置系统设置项。设备列表、通道、录像/录音文件、
   * 告警记录与账号住在别的表里，本处理器根本拿不到它们。
   */
  ipcMain.handle(
    IpcChannels.SETTINGS_RESTORE_DEFAULTS,
    (): Promise<DeviceResult<AppSettings>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('manageSystemSettings')
        const services = getServices()
        const { settings, rejected } = services.settings.restoreDefaults()
        if (rejected.length > 0) {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            `以下设置项的默认值不合法，未能恢复：${rejected.join(', ')}`
          )
        }
        // 默认的存储根可能还不存在（第一次恢复默认时多半如此）。
        await services.storage.ensureLayout(settings.storageRoot)
        appLog().info('系统设置已恢复默认值', { by: actor() })
        return {
          ...settings,
          alarmLinkage: services.settings.describeAlarmLinkage(
            services.linkage.smtpPasswordStored()
          )
        }
      })
  )

  ipcMain.handle(
    IpcChannels.IOT_INGEST_STATUS,
    (): Promise<DeviceResult<IotIngestRuntimeStatus>> =>
      toResult(async () => {
        // 与写接入配置同一档权限：这一份读数里有监听地址与端口、以及"哪台设备推过数据"，
        // 它属于系统设置页的那张卡片。
        requireAdministrator()
        requirePermission('manageSystemSettings')
        const services = getServices()
        return {
          ...services.iotIngest.status,
          localAddresses: listLocalAddresses(),
          devicesWithSecret: services.devices.countIngestSecrets()
        }
      })
  )

  /**
   * 瓦片缓存下载（业主 20260921 批）。写存储根 + 主动出网下载，所以与
   * `SETTINGS_UPDATE` 同档：管理员 + `manageSystemSettings`。进度经
   * `PushChannels.MAP_CACHE_PROGRESS` 推送，结果在这里同步返回。
   */
  ipcMain.handle(
    IpcChannels.MAP_CACHE_TILES,
    (_event, rawInput: unknown): Promise<DeviceResult<MapTileCacheResult>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('manageSystemSettings')
        return getServices().mapTiles.cacheTiles(sanitiseTileCacheRequest(rawInput))
      })
  )

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.DEVICE_LIST, () =>
    toResult(async () => {
      requirePermission('viewDevices')
      return getServices().devices.list()
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_GET, (_event, id: string) =>
    toResult(async () => {
      requirePermission('viewDevices')
      return getServices().devices.get(id)
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_ADD, (_event, input: AddDeviceInput) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      return getServices().devices.add(input)
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_UPDATE, (_event, input: UpdateDeviceInput) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      return getServices().devices.update(input)
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_REMOVE, (_event, id: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      getServices().devices.remove(id)
      return undefined
    })
  )

  ipcMain.handle(
    IpcChannels.DEVICE_PROBE,
    (_event, input: Omit<AddDeviceInput, 'name'>): Promise<DeviceResult<ProbeResultContract>> =>
      toResult(async () => getServices().devices.probe(input))
  )

  ipcMain.handle(IpcChannels.DEVICE_REFRESH_STATUS, (_event, id?: string) =>
    toResult(async () => {
      const services = getServices()
      if (id) {
        await services.devices.runHealthCheck()
        return [services.devices.get(id)]
      }
      await services.devices.runHealthCheck()
      return services.devices.list()
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_GET_INFO, (_event, id: string) =>
    toResult(async () => {
      requirePermission('viewDevices')
      return getServices().devices.getInfo(id)
    })
  )

  ipcMain.handle(IpcChannels.DEVICE_GET_CHANNELS, (_event, id: string) =>
    toResult(async () => {
      requirePermission('viewDevices')
      return getServices().devices.refreshChannels(id)
    })
  )

  /**
   * 这台设备的推流地址与秘钥（业主 2026-09-18 第 10 批第 5 条）。
   *
   * 权限用的是 `manageDevices`（与编辑设备同一档）而不是 `viewDevices`：**首次读取会生成
   * 一条秘钥**，那是一次写库；而"谁能看到还没被设备用起来的凭据"在这里与"谁能改设备"
   * 是同一件事。
   *
   * `describeIngestEndpoint` 里的地址表来自真实的网卡枚举，`serviceEnabled` / 端口来自设置 ——
   * 所以这个返回值把「设备该往哪推」与「本机现在到底有没有在听」两件事一起说清楚了。
   */
  ipcMain.handle(IpcChannels.DEVICE_INGEST_ENDPOINT, (_event, id: string) =>
    toResult(async () => {
      requireAdministrator()
      requirePermission('manageDevices')
      return getServices().devices.ingestEndpoint(id)
    })
  )

  /**
   * 轮换推流秘钥。
   *
   * 与 `DEVICE_INGEST_ENDPOINT` 分开一个通道，理由在契约里：轮换是一次**凭据变更**，
   * 旧秘钥立刻失效（设备必须重新配置才会再推上来），所以它值得界面上一次明确确认与
   * 自己的日志行。日志里**不写秘钥本身**，只写设备与操作人。
   */
  ipcMain.handle(IpcChannels.DEVICE_ROTATE_PUSH_SECRET, (_event, id: string) =>
    toResult(async () => {
      requireAdministrator()
      requirePermission('manageDevices')
      const services = getServices()
      const endpoint = services.devices.rotatePushSecret(id)
      appLog().info('已轮换设备推流秘钥', { deviceId: id, by: actor() })
      return endpoint
    })
  )

  /**
   * Open the device's own web UI in the SYSTEM browser (spec 8.5).
   * Deliberately not an iframe or a secondary BrowserWindow: the spec is
   * explicit ("不使用 iframe"), and a system browser keeps device credentials
   * in a context the Manager does not control.
   */
  ipcMain.handle(IpcChannels.DEVICE_OPEN_WEB_UI, (_event, id: string) =>
    toResult(async () => {
      requirePermission('manageDevices')
      const device = getServices().devices.get(id)
      if (!device.ip) throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备未配置 IP 地址')
      const url = normaliseBaseUrl(`${device.ip}${device.httpPort ? `:${device.httpPort}` : ''}`)
      await shell.openExternal(url)
      appLog().info('Opened device web UI in system browser', { deviceId: id, url })
      return undefined
    })
  )

  // -------------------------------------------------------------------------
  // Overview
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.OVERVIEW_STATS, () =>
    toResult(async () => getServices().overview.stats())
  )

  ipcMain.handle(IpcChannels.OVERVIEW_RECENT_ALARMS, (_event, limit?: number) =>
    toResult(async () => getServices().alarms.recent(limit ?? 10))
  )

  // -------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.ALARM_QUERY, (_event, query) =>
    toResult(async () => {
      requirePermission('viewAlarms')
      return getServices().alarms.query(query ?? {})
    })
  )

  ipcMain.handle(
    IpcChannels.ALARM_ACKNOWLEDGE,
    (_event, ids: string[], acknowledged: boolean) =>
      toResult(async () => getServices().alarms.acknowledge(ids ?? [], acknowledged !== false))
  )

  /**
   * 备注与等级（v6）。三件事分三个通道，守卫统一走 `viewAlarms`——它们是值守动作，
   * 只改这条告警记录自己的注解（理由见 `auth.ts` 里 `viewAlarms` 的说明）。
   *
   * 备注长度上限（500）与等级取值枚举都在仓库层校验，越界以 `ok === false` 回来，
   * 而不是让异常穿过 IPC：界面需要读到原因，而不是一个没有上下文的 rejection。
   */
  ipcMain.handle(
    IpcChannels.ALARM_SET_NOTE,
    (_event, alarmId: string, note: string | null) =>
      toResult(async () => {
        requirePermission('viewAlarms')
        return getServices().alarms.setNote(String(alarmId), note === undefined ? null : note)
      })
  )

  ipcMain.handle(
    IpcChannels.ALARM_SET_SEVERITY,
    (_event, alarmId: string, severity: EventSeverity) =>
      toResult(async () => {
        requirePermission('viewAlarms')
        return getServices().alarms.setSeverity(String(alarmId), severity)
      })
  )

  ipcMain.handle(IpcChannels.ALARM_COUNT_BY_SEVERITY, (_event, query) =>
    toResult(async () => {
      requirePermission('viewAlarms')
      return getServices().alarms.countBySeverity(query ?? {})
    })
  )

  // -------------------------------------------------------------------------
  // Recordings
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.RECORDING_QUERY, (_event, query) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().recordings.query(query ?? {})
    })
  )

  ipcMain.handle(IpcChannels.RECORDING_SYNC_DEVICE, (_event, deviceId: string) =>
    toResult(async () => getServices().recordings.syncDeviceRecordings(deviceId))
  )

  /**
   * 另存一条本机录音（业主：告警中心右键「下载告警」）。
   *
   * 主进程负责全部三件事：定位行 → 保存对话框 → 复制文件。渲染层只拿到**保存后的
   * 绝对路径**（用于一句成功提示）；取消对话框返回 `null`，不是错误。
   * 复制用 `copyFile`（同一磁盘内是廉价元数据操作），写失败留下的部分文件被删掉 ——
   * 与 `storage-service` 下载路径同一条「不留半截文件」纪律。
   */
  ipcMain.handle(IpcChannels.RECORDING_EXPORT, (event, recordingId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const id = String(recordingId ?? '').trim()
      if (id === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少录像 ID')
      const services = getServices()
      const row = services.recordingRepo.findById(id)
      if (!row) throw new AppError(ErrorCodes.VALIDATION_ERROR, '找不到该录像记录', id)
      const absolute = services.storage.resolve(row.relativePath)
      if (!existsSync(absolute)) {
        throw new AppError(ErrorCodes.STORAGE_ERROR, '该录像只有元数据，本地没有文件', row.relativePath)
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: '下载告警录音',
        defaultPath: row.relativePath.split('/').pop() ?? 'recording.wav',
        filters: [{ name: '全部文件', extensions: ['*'] }]
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      try {
        await copyFile(absolute, result.filePath)
      } catch (error) {
        await rm(result.filePath, { force: true }).catch(() => undefined)
        throw new AppError(
          ErrorCodes.STORAGE_ERROR,
          '文件复制失败',
          error instanceof Error ? error.message : String(error)
        )
      }
      return { path: result.filePath }
    })
  )

  // -------------------------------------------------------------------------
  // 本地异常声纹样本库（schema v7，业主 2026-09-16）
  // -------------------------------------------------------------------------

  /**
   * 全部走 `viewRecordings`：这个库是**从录音派生的**，打标签是对派生物的注解，
   * 不动录音本身、也不删录音文件（理由写在 `auth.ts` 的 `viewRecordings` 上）。
   */
  ipcMain.handle(IpcChannels.SAMPLE_QUERY, (_event, query) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLibrary.query(query ?? {})
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_STATS, () =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLibrary.stats()
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_ADD_FROM_ALARM, (_event, alarmId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const outcome = getServices().sampleLibrary.addFromAlarm(String(alarmId))
      if (!outcome) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `告警不存在: ${String(alarmId)}`)
      }
      return outcome
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_ADD_FROM_RECORDING, (_event, recordingId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const outcome = getServices().sampleLibrary.addFromRecording(String(recordingId))
      if (!outcome) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `录音不存在: ${String(recordingId)}`)
      }
      return outcome
    })
  )

  /**
   * 批量入库（告警中心勾一批）。
   *
   * 参数收窄在**这一层**：渲染层可以送任何东西进来，而一个不是数组的参数会让
   * `for...of` 直接抛一个读不懂的错。送空数组是合法请求（返回一排 0），不是错误。
   */
  ipcMain.handle(IpcChannels.SAMPLE_ADD_FROM_ALARMS, (_event, alarmIds: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const ids = Array.isArray(alarmIds) ? alarmIds.map((id) => String(id)) : []
      return getServices().sampleLibrary.addFromAlarms(ids)
    })
  )

  /**
   * 导出目录只开原生对话框、回一个路径，什么都不写（与 `SETTINGS_PICK_STORAGE_DIR` 同形）。
   */
  ipcMain.handle(
    IpcChannels.SAMPLE_PICK_EXPORT_DIR,
    (event): Promise<DeviceResult<string | null>> =>
      toResult(async () => {
        requirePermission('viewRecordings')
        const window = BrowserWindow.fromWebContents(event.sender)
        const options = {
          title: '选择数据集导出目录',
          properties: ['openDirectory', 'createDirectory'] as const,
          buttonLabel: '导出到此目录'
        }
        const result = window
          ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
          : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0] ?? null
      })
  )

  /**
   * 写数据集清单（可带音频）。
   *
   * 目录由渲染层从 `SAMPLE_PICK_EXPORT_DIR` 拿来 —— 这条路径也是会写盘的入口，所以
   * 与其它写操作一样做参数收窄；但**不做**"必须是用户刚选过的目录"这种一次性校验：
   * 那需要在这里保存上一轮选择的状态，而状态一旦过期，用户重试导出就会莫名其妙被拒。
   */
  ipcMain.handle(IpcChannels.SAMPLE_EXPORT_DATASET, (_event, request: SampleExportRequest) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const directory = typeof request?.directory === 'string' ? request.directory.trim() : ''
      if (directory === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '导出目录为空')
      }
      const normalised: SampleExportRequest = { directory }
      if (request?.copyAudio === true) normalised.copyAudio = true
      if (request?.onlyLabelled === true) normalised.onlyLabelled = true
      return getServices().sampleExport.export(normalised)
    })
  )

  ipcMain.handle(
    IpcChannels.SAMPLE_SET_LABEL,
    (_event, sampleId: string, dimension: string, label: string | null, source: SampleLabelSource) =>
      toResult(async () => {
        requirePermission('viewRecordings')
        // 维度来自渲染层，所以要收窄：不认识的维度**抛错**而不是默认写故障类型 ——
        // 一个静默的默认值会让"设备类型没存上"看起来像"存上了只是没显示"。
        if (!isSampleLabelDimension(dimension)) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知的标签维度: ${String(dimension)}`)
        }
        // 来源只在**有标签**时有意义；`null` 就是撤销标注（服务层会把两者一起清）。
        const resolved: SampleLabelSource = isSampleLabelSource(source) ? source : 'human'
        return getServices().sampleLibrary.setLabel(
          String(sampleId),
          dimension,
          label === null || label === undefined ? null : String(label),
          resolved
        )
      })
  )

  ipcMain.handle(IpcChannels.SAMPLE_REMOVE, (_event, sampleId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLibrary.remove(String(sampleId))
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_TRAIN, () =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLibrary.train()
    })
  )

  /**
   * 标签库四条通道（业主 2026-09-16：「应该有个专门的功能去做标签的添加和设备类型添加维护」）。
   *
   * 四条都归 `viewRecordings`：标签库是这个库的**词表**，读它与读样本是同一件事；
   * 改名会连样本一起改、删除有引用检查，所以它们也不是"改系统设置"。
   * 写入参数在这一层收窄（维度未知/名字为空由服务层拒绝并报出原因）。
   */
  ipcMain.handle(IpcChannels.SAMPLE_LABELS_LIST, () =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLabels.list()
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_LABEL_ADD, (_event, dimension: unknown, name: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLabels.add(dimension, name)
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_LABEL_RENAME, (_event, id: unknown, name: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLabels.rename(String(id), name)
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_LABEL_DELETE, (_event, id: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleLabels.remove(String(id))
    })
  )

  /**
   * AI 标注三条通道。
   *
   * `SAMPLE_AI_SAVE_CONFIG` 与其它写操作同一条纪律：**参数在这一层收窄**。
   * 密钥允许是 `undefined`（不动已存的）、`null`（清除）或字符串；其余类型一律当"不动"，
   * 而不是把 `{}` 或数字悄悄变成字符串存进去。
   */
  ipcMain.handle(IpcChannels.SAMPLE_AI_STATUS, () =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleAi.status()
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_AI_SAVE_CONFIG, (_event, input: SampleAiConfigInput) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const normalised: SampleAiConfigInput = {
        enabled: input?.enabled === true,
        endpoint: typeof input?.endpoint === 'string' ? input.endpoint : '',
        model: typeof input?.model === 'string' ? input.model : ''
      }
      if (input?.apiKey === null) normalised.apiKey = null
      else if (typeof input?.apiKey === 'string') normalised.apiKey = input.apiKey
      return getServices().sampleAi.saveConfig(normalised)
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_AI_LABEL, (_event, request: SampleAiLabelRequest) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const normalised: SampleAiLabelRequest = {}
      if (Array.isArray(request?.sampleIds)) {
        normalised.sampleIds = request.sampleIds.map((id) => String(id))
      }
      if (request?.includeWeakLabelled === true) normalised.includeWeakLabelled = true
      return getServices().sampleAi.label(normalised)
    })
  )

  /**
   * 命名的 AI 服务库四条通道（业主追加：设置里「不同 AI 服务」）。
   *
   * 与上面三条同一权限批（`viewRecordings`）。写通道在**这一层收窄参数**：
   * 名称/地址/模型只收字符串，provider 只收预置枚举（其余落到 'custom'），
   * 密钥沿用三态（undefined 不动 / null 清除 / 字符串写入）。
   */
  ipcMain.handle(IpcChannels.SAMPLE_AI_SERVICES, () =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleAi.servicesStatus()
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_AI_SERVICE_SAVE, (_event, input: SampleAiServiceInput) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      const normalised: SampleAiServiceInput = {
        name: typeof input?.name === 'string' ? input.name : '',
        provider: isAiServicePreset(input?.provider) ? input.provider : 'custom',
        endpoint: typeof input?.endpoint === 'string' ? input.endpoint : '',
        model: typeof input?.model === 'string' ? input.model : ''
      }
      if (typeof input?.id === 'string' && input.id !== '') normalised.id = input.id
      if (input?.apiKey === null) normalised.apiKey = null
      else if (typeof input?.apiKey === 'string') normalised.apiKey = input.apiKey
      return getServices().sampleAi.saveService(normalised)
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_AI_SERVICE_DELETE, (_event, id: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleAi.deleteService(String(id ?? ''))
    })
  )

  ipcMain.handle(IpcChannels.SAMPLE_AI_SERVICE_SET_ACTIVE, (_event, id: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().sampleAi.setActiveService(String(id ?? ''))
    })
  )

  /**
   * 听诊盒子族的「拉」通道两条。
   *
   * 领域判断（是不是听诊盒子、三处读取怎么拼）在 `E2DeviceService` 里；这里只做两件事：
   * **权限**与**参数收窄**。`syncAlarms` 的 `limit` 夹到 1..1000、布尔只认 `true`，
   * 渲染层送什么都不会把主控权拿走。
   */
  ipcMain.handle(IpcChannels.E2_STATUS, (_event, deviceId: unknown) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      return getServices().e2.status(String(deviceId))
    })
  )

  ipcMain.handle(
    IpcChannels.E2_SYNC_ALARMS,
    (_event, deviceId: unknown, request: E2SyncRequest | undefined) =>
      toResult(async () => {
        requirePermission('viewRecordings')
        const normalised: E2SyncRequest = {}
        if (typeof request?.limit === 'number' && Number.isFinite(request.limit)) {
          normalised.limit = Math.min(E2_SYNC_MAX_LIMIT, Math.max(1, Math.trunc(request.limit)))
        }
        if (typeof request?.since === 'number' && Number.isFinite(request.since)) {
          normalised.since = Math.trunc(request.since)
        }
        if (request?.downloadAudio === false) normalised.downloadAudio = false
        if (request?.downloadSpectrograms === true) normalised.downloadSpectrograms = true
        return getServices().e2.sync(String(deviceId), normalised)
      })
  )

  /**
   * 空气声呐的**球机联动（PTZ）配置**（业主 2026-09-17 第 8 批第 1 条）。
   *
   * 权限是 `configureDevices`（与 `config:*` 那一批同一条）：这三条动的是**设备配置**，
   * 而 `E2_STATUS` / `E2_SYNC_ALARMS` 动的是本机库（`viewRecordings`）。
   * 读写分开两条通道，是因为它们在权限模型里就是两件事 —— 能看设备状态不等于能改它的球机地址。
   *
   * 参数收窄在这里做（渲染层送什么都不会把主控权拿走）：只认已知的键、只认对应的类型，
   * 范围与语义判据在 `E2DeviceService`（与界面共用 `validatePtzPatch()`）。
   */
  ipcMain.handle(IpcChannels.E2_PTZ, (_event, deviceId: unknown) =>
    toResult(async () => {
      requirePermission('configureDevices')
      return getServices().e2.ptzConfig(String(deviceId))
    })
  )

  ipcMain.handle(IpcChannels.E2_PTZ_UPDATE, (_event, deviceId: unknown, patch: unknown) =>
    toResult(async () => {
      requirePermission('configureDevices')
      return getServices().e2.updatePtzConfig(String(deviceId), normalisePtzPatch(patch))
    })
  )

  ipcMain.handle(IpcChannels.E2_NVT_TIME_SYNC, (_event, deviceId: unknown) =>
    toResult(async () => {
      requirePermission('configureDevices')
      return getServices().e2.syncTimeWithNvt(String(deviceId))
    })
  )

  /**
   * 一条告警的抓图（本机文件）。权限归 `viewAlarms`：这是**告警的附件**，不是设备配置。
   */
  ipcMain.handle(
    IpcChannels.E2_ALARM_SNAPSHOTS,
    (_event, deviceId: unknown, alarmId: unknown) =>
      toResult(async () => {
        requirePermission('viewAlarms')
        return getServices().e2.alarmSnapshots(String(deviceId), String(alarmId))
      })
  )

  ipcMain.handle(IpcChannels.E2_SNAPSHOT_CLOSE, () =>
    toResult(async () => {
      // 读权限就够：这只是关掉一个**本机**回环端点，什么设备都不碰。
      requirePermission('viewAlarms')
      getServices().e2.closeSnapshots()
      return undefined
    })
  )
  /*
   * SN-16 realtime_value (owner spec 20).
   *
   * status is a READ of device parameters -> viewDevices; set writes the device's own
   * notify_url / is_send_realtime_value -> administrator + configureDevices, exactly like
   * E2_PTZ_UPDATE. The shared HTTP ingest listener is managed by the existing device-ingest
   * reconciliation; this channel only writes the device side and reads it back.
   */
  ipcMain.handle(IpcChannels.E2_REALTIME_CALLBACK, (_event, deviceId: unknown) =>
    toResult(async () => {
      requirePermission('viewDevices')
      return getServices().e2.realtimeCallbackStatus(String(deviceId))
    })
  )

  ipcMain.handle(
    IpcChannels.E2_REALTIME_CALLBACK_UPDATE,
    (_event, deviceId: unknown, enabled: unknown) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('configureDevices')
        return getServices().e2.setRealtimeCallback(String(deviceId), enabled === true)
      })
  )

  // -------------------------------------------------------------------------
  // Protocol Lab (spec section 19)
  // -------------------------------------------------------------------------
  ipcMain.handle(IpcChannels.PROTOCOL_DIAGNOSE, (_event, deviceId: string) =>
    toResult(async () => {
      const services = getServices()
      const device = services.devices.get(deviceId)
      deviceLog().info('Protocol diagnosis requested', { deviceId, ip: device.ip })

      // Ensure a session exists (this also resolves and caches the auth
      // carrier), then hand the LIVE client to the lab so the diagnosis reuses
      // it instead of logging in a second time.
      let client = services.devices.findClient(deviceId)
      if (!client) {
        await services.devices.getInfo(deviceId)
        client = services.devices.findClient(deviceId)
      }

      return services.protocolLab.diagnose(device, client)
    })
  )

  ipcMain.handle(
    IpcChannels.PROTOCOL_PROBE_ENDPOINT,
    (
      _event,
      deviceId: string,
      rawPath: string,
      method: 'GET' | 'POST' | 'PUT' = 'GET'
    ): Promise<DeviceResult<EndpointProbeResult>> =>
      toResult(async () => {
        const services = getServices()

        // Reuse the device's live session so the probe inherits the resolved
        // auth carrier; establishing one first if necessary.
        let client = services.devices.findClient(deviceId)
        if (!client) {
          await services.devices.getInfo(deviceId)
          client = services.devices.findClient(deviceId)
        }
        if (!client) throw new AppError(ErrorCodes.DEVICE_OFFLINE, '无法建立设备会话')

        if (typeof rawPath !== 'string' || rawPath.trim() === '') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '请填写要探测的路径')
        }
        if (!['GET', 'POST', 'PUT'].includes(method)) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, `不支持的请求方法: ${method}`)
        }
        // Only same-origin device paths: a probe must not become an SSRF vector.
        if (/^[a-z]+:\/\//i.test(rawPath)) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '只允许探测设备本机的相对路径')
        }

        deviceLog().info('Ad-hoc endpoint probe', { deviceId, path: rawPath, method })
        return services.protocolLab.probeCustomPath(client, rawPath.trim(), method)
      })
  )

  // -------------------------------------------------------------------------
  // 连续录像（RTSP 取流存储，业主 2026-09-26 追加范围）
  // -------------------------------------------------------------------------

  /**
   * 现在在录什么（只读）。
   *
   * 返回的是**录像器自己的话**：`recording` 要求"观察到文件在变大"，`waiting` 是
   * "进程在但没数据"，`backoff` 是"断了在等重连"。界面不许把这些合成一句"已开启"。
   */
  ipcMain.handle(IpcChannels.RECORDER_STATUS, () =>
    toResult(async () => getServices().recorder.status())
  )

  /**
   * 开/关一台相机的连续录像。
   *
   * 顺序有意如此：**先解析地址、再落库、最后拉起**。
   *   - 解析失败（`rtsp-disabled` / `missing-video-config`）直接报错、**不写设置** ——
   *     否则界面显示"已开启"而设备侧根本没有地址，用户以为在录；
   *   - 落库在拉起之前：录像器万一启动失败，设置里仍然是"用户要录"，重启后会再试，
   *     而不是静默丢掉用户的意愿。
   */
  ipcMain.handle(
    IpcChannels.RECORDER_SET_ENABLED,
    (_event, input: RecorderSetEnabledInput): Promise<DeviceResult<RecorderStatusView | null>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        const services = getServices()
        if (!input || typeof input.deviceId !== 'string' || input.deviceId === '') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
        }
        const current = services.settings.get().recorder
        const segmentSeconds =
          input.segmentSeconds === undefined
            ? current.segmentSeconds
            : normaliseRecorderConfig({ ...current, segmentSeconds: input.segmentSeconds }).config
                .segmentSeconds
        const enabledIds = input.enabled
          ? [...new Set([...current.enabledDeviceIds, input.deviceId])]
          : current.enabledDeviceIds.filter((id) => id !== input.deviceId)

        if (input.enabled) {
          const source = await services.cameraLive.resolveRecorderSource(input.deviceId)
          if (!source.ok) {
            throw new AppError(
              ErrorCodes.VALIDATION_ERROR,
              source.reason === 'rtsp-disabled'
                ? '相机的 RTSP 服务处于关闭状态，无法连续录像；请在相机 Web 界面启用 RTSP'
                : source.reason === 'missing-video-config'
                  ? '相机未上报视频端口/路径，无法拼出 RTSP 地址'
                  : '找不到这台设备，无法开始连续录像'
            )
          }
          const device = services.devices.get(input.deviceId)
          await services.recorder.start(
            { deviceId: input.deviceId, deviceUid: device.deviceUid, rtspUrl: source.url },
            segmentSeconds
          )
        } else {
          await services.recorder.stop(input.deviceId)
        }

        services.settings.update({
          recorder: { enabledDeviceIds: enabledIds, segmentSeconds }
        })
        appLog().info('Continuous recording toggled', {
          deviceId: input.deviceId,
          enabled: input.enabled,
          segmentSeconds,
          actor: actor()
        })
        return services.recorder.statusOfDevice(input.deviceId) ?? null
      })
  )

  // -------------------------------------------------------------------------
  // Realtime monitoring (Phase 4-7)
  // -------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.MONITOR_START,
    (event, subscription: MonitorSubscription): Promise<DeviceResult<MonitorState>> =>
      toResult(async () => {
        const services = getServices()
        if (!subscription || typeof subscription.deviceId !== 'string') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
        }
        const kinds = Array.isArray(subscription.kinds) ? subscription.kinds : []
        if (kinds.length === 0) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '请至少选择一路要监测的数据')
        }

        /*
         * 多通道同时显示（业主 2026-09-24）：勾选的每一路额外通道 = 一条额外
         * `/features_stream` 连接，所以这里必须**截断**而不是照单全收 —— 渲染层
         * 用同一个上限（`MAX_FEATURE_CHANNELS`）画勾选框，两边不许各说各的。
         * 畸形的值（字符串、负数、1e9）直接丢掉：它们只可能来自坏掉的调用方。
         */
        const featureChannelIds = (Array.isArray(subscription.featureChannelIds)
          ? subscription.featureChannelIds
          : []
        )
          .filter(
            (channel): channel is number =>
              typeof channel === 'number' && Number.isInteger(channel) && channel >= 0 && channel <= 63
          )
          .slice(0, MAX_FEATURE_CHANNELS)

        const state = await services.devices.startMonitoring(
          subscription.deviceId,
          kinds,
          subscription.channelId ?? 0,
          featureChannelIds
        )

        // Attach forwarding to the window that asked, so frames go to the
        // renderer that is actually displaying the monitor page.
        const window = BrowserWindow.fromWebContents(event.sender)
        const manager = services.devices.findStreamManager(subscription.deviceId)
        if (window && manager) {
          // replace any previous attachment for this device
          streamForwarding.get(subscription.deviceId)?.()
          streamForwarding.set(
            subscription.deviceId,
            attachStreamForwarding(manager, window)
          )
        }

        appLog().info('Monitoring started', {
          deviceId: subscription.deviceId,
          kinds,
          channelId: subscription.channelId ?? 0,
          featureChannels: featureChannelIds
        })
        return state
      })
  )

  ipcMain.handle(
    IpcChannels.MONITOR_STOP,
    (_event, deviceId?: string): Promise<DeviceResult<void>> =>
      toResult(async () => {
        const services = getServices()

        const detach = (id: string): void => {
          streamForwarding.get(id)?.()
          streamForwarding.delete(id)
        }

        // Detach BEFORE disposing the manager: a frame emitted during teardown
        // would otherwise be pushed to a renderer that has already moved on.
        if (deviceId) detach(deviceId)
        else for (const id of [...streamForwarding.keys()]) detach(id)

        await services.devices.stopMonitoring(deviceId)
        appLog().info('Monitoring stopped', { deviceId: deviceId ?? '(all)' })
        return undefined
      })
  )

  ipcMain.handle(IpcChannels.MONITOR_STATE, (_event, deviceId?: string) =>
    toResult(async () => getServices().devices.listMonitorState(deviceId))
  )

  ipcMain.handle(
    IpcChannels.MONITOR_START_RECORDING,
    (event, input: { deviceId: string; channelId: number }) =>
      toResult(async () => {
        const services = getServices()
        const manager = services.devices.findStreamManager(input.deviceId)
        if (!manager) {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            '请先启动实时监测，再开始录音'
          )
        }

        const started = await manager.startRecording(input.channelId)
        // The renderer needs the recording-state pushes, which arrive through
        // the same forwarding attachment as the monitor page.
        const window = BrowserWindow.fromWebContents(event.sender)
        if (window && !streamForwarding.has(input.deviceId)) {
          streamForwarding.set(
            input.deviceId,
            attachStreamForwarding(manager, window)
          )
        }

        return {
          recordingId: started.recordingId,
          relativePath: '',
          durationMs: 0,
          fileSize: 0,
          sampleRate: 0
        }
      })
  )

  ipcMain.handle(
    IpcChannels.MONITOR_STOP_RECORDING,
    (_event, deviceId: string) =>
      toResult(async () => {
        const manager = getServices().devices.findStreamManager(deviceId)
        if (!manager) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '该设备没有正在进行的录音')
        }

        const stopped = await manager.stopRecording()
        if (!stopped) {
          // Stopping twice is harmless; report an empty result rather than an
          // error, because the UI cannot know a recording already ended.
          return { recordingId: '', relativePath: '', durationMs: 0, fileSize: 0, sampleRate: 0 }
        }

        appLog().info('Manual recording finished', {
          deviceId,
          recordingId: stopped.recordingId,
          durationMs: stopped.durationMs,
          samples: stopped.sampleCount
        })

        return {
          recordingId: stopped.recordingId,
          relativePath: stopped.relativePath,
          durationMs: stopped.durationMs,
          fileSize: 0,
          sampleRate: 0
        }
      })
  )

  // -------------------------------------------------------------------------
  // FA371 camera realtime streams (manual §5.2)
  // -------------------------------------------------------------------------

  /**
   * Start (or narrow/extend) a camera's WebSocket channels.
   *
   * ADMINISTRATOR REQUIRED. The rule stated at the top of this file guards
   * operations that change what the hardware does. Opening these sockets makes
   * the camera stream continuously and pushes up to ~330 KB/s into this
   * process, which is a device operation — not a read. `state` below stays
   * operator-visible, exactly like the other reads.
   *
   * The payload is validated here rather than in the service because it arrives
   * from the renderer: an unknown channel name must be rejected at the trust
   * boundary, not silently filtered deep inside a socket loop.
   */
  ipcMain.handle(
    IpcChannels.FA371_STREAM_START,
    (event, subscription: Fa371StreamSubscription): Promise<DeviceResult<Fa371MonitorState>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')

        const services = getServices()
        if (!subscription || typeof subscription.deviceId !== 'string' || subscription.deviceId === '') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
        }

        const kinds = Array.isArray(subscription.kinds) ? subscription.kinds : []
        if (kinds.length === 0) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '请至少选择一路要接收的相机数据')
        }
        const valid: Fa371StreamKind[] = []
        for (const kind of kinds) {
          if (!FA371_ALL_STREAM_KINDS.includes(kind)) {
            throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知的相机数据通道: ${String(kind)}`)
          }
          if (!valid.includes(kind)) valid.push(kind)
        }

        // Fail loudly for a box: this handler opens CAMERA sockets, and a box
        // has none of these paths. Silently retrying a 404-style upgrade
        // forever is the failure mode that looks like a healthy stream.
        const device = services.devices.get(subscription.deviceId)
        if (device.kind !== 'acousticCamera') {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            '该设备不是声学相机，无法接收相机实时数据',
            subscription.deviceId
          )
        }

        /*
         * 顺序是关键：**先接转发，再启动**。
         *
         * `start()` 会在内部**同步**发出这条会话的权威状态
         * （`fa371-stream-service.ts` 的 `start()` 里直接调 `emitState()`），而
         * `attachFa371StreamForwarding()` 只是**订阅** —— 它不会补发当前状态。
         * 所以「先 start 再接转发」会把这一次 `state` 推送丢掉：帧照到，渲染层的
         * store 却停在 `idle`（真机实测：流已经在跑，总览那一格却显示「未监测」）。
         *
         * 失败时要把刚接上的转发摘掉：一个没人持有的 disposer 会一直往这个窗口
         * 发推送，等到窗口关闭才暴露。
         */
        const window = BrowserWindow.fromWebContents(event.sender)
        let detach: (() => void) | undefined
        if (window) {
          fa371Forwarding.get(subscription.deviceId)?.()
          detach = attachFa371StreamForwarding(services.fa371Streams, window)
          fa371Forwarding.set(subscription.deviceId, detach)
        }

        let state: Fa371MonitorState
        try {
          state = services.fa371Streams.start(subscription.deviceId, valid)
        } catch (error) {
          if (detach) {
            detach()
            if (fa371Forwarding.get(subscription.deviceId) === detach) {
              fa371Forwarding.delete(subscription.deviceId)
            }
          }
          throw error
        }

        appLog().info('FA371 camera streams started', {
          deviceId: subscription.deviceId,
          channels: valid,
          actor: actor(),
          handshakeAuthId: state.handshakeAuthId ?? '(unconfirmed)',
          decodeProfiles: state.decodeProfiles
        })
        return state
      })
  )

  ipcMain.handle(
    IpcChannels.FA371_STREAM_STOP,
    (_event, deviceId?: string): Promise<DeviceResult<void>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')

        const services = getServices()
        const detach = (id: string): void => {
          fa371Forwarding.get(id)?.()
          fa371Forwarding.delete(id)
        }

        // Detach BEFORE disposing: a frame emitted during teardown would
        // otherwise be pushed to a renderer that has already moved on.
        if (deviceId) detach(deviceId)
        else for (const id of [...fa371Forwarding.keys()]) detach(id)

        services.fa371Streams.stop(deviceId)
        appLog().info('FA371 camera streams stopped', { deviceId: deviceId ?? '(all)', actor: actor() })
        return undefined
      })
  )

  // Read-only: unguarded, on purpose (see "WHAT IS AND IS NOT GUARDED" above).
  ipcMain.handle(IpcChannels.FA371_STREAM_STATE, (_event, deviceId?: string) =>
    toResult(async () => getServices().fa371Streams.listState(deviceId))
  )

  // -------------------------------------------------------------------------
  // FA371 camera LIVE VIDEO (`GET /system/video` -> RTSP -> ffmpeg -> loopback)
  // -------------------------------------------------------------------------

  /**
   * Start the live view for one camera.
   *
   * ADMINISTRATOR REQUIRED, on the same rule as `FA371_STREAM_START` above: this
   * makes the camera open an RTSP connection, and the camera has a finite
   * `rtsp_client_limit` (measured default 6), so it changes what the hardware does.
   * `state` below stays a read.
   *
   * `/system/video` is read in the SERVICE rather than here, because the RTSP address
   * can only be assembled from that response and the service must refuse to start
   * when the device reports `rtsp_enabled = 0`.
   */
  ipcMain.handle(
    IpcChannels.CAMERA_LIVE_START,
    (_event, input: CameraLiveStartInput): Promise<DeviceResult<CameraLiveState>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')

        const mode = input?.mode ?? 'remux'
        if (mode !== 'remux' && mode !== 'transcode') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知的视频模式: ${String(input?.mode)}`)
        }

        /*
         * 两种来源**恰好给一个**（业主 2026-09-19 第 3 条：手填 RTSP 地址给第三方相机）。
         *
         * 两个都给是调用方在猜"以哪个为准"，两个都不给没有可拉的源 —— 两条都要当场拒掉，
         * 而不是让后面某一步悄悄按其中一个跑。
         */
        const wantsManual = typeof input?.url === 'string' && input.url.trim() !== ''
        const wantsDevice = typeof input?.deviceId === 'string' && input.deviceId.trim() !== ''
        if (wantsManual === wantsDevice) {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            wantsManual ? 'deviceId 与 url 只能给一个' : '缺少设备 ID 或手填的 RTSP 地址'
          )
        }

        const services = getServices()

        if (wantsManual) {
          const sourceId = typeof input?.sourceId === 'string' ? input.sourceId : ''
          const state = await services.cameraLive.startManual(sourceId, String(input?.url), mode)
          // 日志里只写打码之后的地址（`state.rtspUrl` 已经由服务打码）。
          appLog().info('Camera live view requested (manual RTSP source)', {
            sourceId,
            mode,
            status: state.status,
            rtspUrl: state.rtspUrl,
            actor: actor()
          })
          return state
        }

        // Fail loudly for a box: this handler opens CAMERA video, and a box has no
        // RTSP service at all. Silently retrying an address that cannot exist is the
        // failure mode that looks like a slow stream.
        const deviceId = String(input?.deviceId)
        const device = services.devices.get(deviceId)
        if (device.kind !== 'acousticCamera') {
          throw new AppError(
            ErrorCodes.VALIDATION_ERROR,
            '该设备不是声学相机，无法查看相机实时视频',
            deviceId
          )
        }

        const state = await services.cameraLive.start(deviceId, mode)
        appLog().info('Camera live view requested', {
          deviceId,
          mode,
          status: state.status,
          url: state.url,
          rtspUrl: state.rtspUrl,
          actor: actor()
        })
        return state
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_LIVE_STOP,
    (_event, deviceId?: string): Promise<DeviceResult<void>> =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        getServices().cameraLive.stop(deviceId)
        appLog().info('Camera live view stopped', { deviceId: deviceId ?? '(all)', actor: actor() })
        return undefined
      })
  )

  // Read-only: unguarded, on purpose (see "WHAT IS AND IS NOT GUARDED" above).
  ipcMain.handle(IpcChannels.CAMERA_LIVE_STATE, (_event, deviceId?: string) =>
    toResult(async () => getServices().cameraLive.listState(deviceId))
  )

  /**
   * 当前会话可用的 RTSP 地址（**含口令**）。
   *
   * ADMINISTRATOR REQUIRED，并且不同于 `CAMERA_LIVE_STATE`——这**不是**一次
   * 普通的读：它把设备口令交出去给「复制地址 / 外部播放器」用。那条「读不设防」
   * 的规则针对的是状态与配置，而一个凭据不是状态。每次调用都记日志，因为
   * 「谁在什么时候把口令复制走了」是应当可追溯的。
   */
  ipcMain.handle(IpcChannels.CAMERA_LIVE_SOURCE, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
      requirePermission('controlCameras')
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
      }
      const source = getServices().cameraLive.currentSource(deviceId)
      if (!source) return null
      appLog().info('Camera live: usable RTSP source handed to the renderer', {
        deviceId,
        candidate: source.candidateId,
        mode: source.mode,
        actor: actor()
      })
      return source
    })
  )

  /**
   * 多路直播的并发预算（上限 + 当前用量）。
   *
   * Read-only: unguarded, on purpose, exactly like `CAMERA_LIVE_STATE` — it reports
   * a number, it does not change what the hardware does. The video wall reads it
   * before assigning a cell so that "再加一格就超上限" is said BEFORE the attempt,
   * instead of being discovered as a failed start.
   */
  ipcMain.handle(IpcChannels.CAMERA_LIVE_LIMITS, () =>
    toResult(async () => getServices().cameraLive.limits())
  )

  // -------------------------------------------------------------------------
  // 相机 NVR 采集：手动录像与抓图
  //
  // 两者都要求管理员：它们让相机**再开一条 RTSP 连接**（`rtsp_client_limit`
  // 是有限的，实测默认 6），并把文件写进存储根。`recording-state` 是读，保持
  // 普通用户可见，界面靠它校准录制指示器。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_NVR_START_RECORDING, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('controlCameras')
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
      }
      const state = await getServices().cameraCapture.start(deviceId)
      appLog().info('Camera NVR: manual recording started', { deviceId, actor: actor() })
      return state
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_NVR_STOP_RECORDING, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('controlCameras')
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
      }
      const result = await getServices().cameraCapture.stop(deviceId)
      appLog().info('Camera NVR: manual recording stopped', {
        deviceId,
        recordingId: result.recordingId,
        durationMs: result.durationMs,
        fileSize: result.fileSize,
        actor: actor()
      })
      return result
    })
  )

  // 读：不设防（见文件顶部的规则）。
  ipcMain.handle(IpcChannels.CAMERA_NVR_RECORDING_STATE, (_event, deviceId?: string) =>
    toResult(async () => getServices().cameraCapture.listState(deviceId))
  )

  ipcMain.handle(IpcChannels.CAMERA_NVR_SNAPSHOT, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('controlCameras')
      if (typeof deviceId !== 'string' || deviceId === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
      }
      const result = await getServices().cameraCapture.snapshot(deviceId)
      appLog().info('Camera NVR: snapshot captured', {
        deviceId,
        relativePath: result.relativePath,
        bytes: result.bytes,
        actor: actor()
      })
      return result
    })
  )

  /**
   * 一段手动录像的可播放地址（本机回环 HTTP + Range）。
   *
   * 读操作：不设管理员校验（见文件顶部的规则），它只是把**已经落盘**的录像交给
   * 界面播放。三步都必须做，缺一步都会让界面拿到一个打不开的地址：
   *   1. 按 id 取元数据行（没有就是没有）；
   *   2. 校验它是**视频**录像（`.mp4`）——音频录像要交给音频播放器，
   *      两者混在一起正是「0 Hz / WAV 的视频行」那条缺陷的来源；
   *   3. `StorageService.resolve()` 归一化并拒绝越界，再确认文件真的存在。
   */
  ipcMain.handle(IpcChannels.CAMERA_NVR_VIDEO_URL, (_event, recordingId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      if (typeof recordingId !== 'string' || recordingId.trim() === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少录像 ID')
      }
      const services = getServices()
      const row = services.recordingRepo.findById(recordingId.trim())
      if (!row) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '找不到该录像记录', recordingId)
      }
      if (!/\.mp4$/i.test(row.relativePath)) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          '该录像不是视频文件，请用音频播放器打开',
          row.relativePath
        )
      }
      const absolute = services.storage.resolve(row.relativePath)
      if (!existsSync(absolute)) {
        throw new AppError(
          ErrorCodes.STORAGE_ERROR,
          '该录像只有元数据，本地没有可播放的文件',
          row.relativePath
        )
      }
      // 契约 `VideoPlaybackSource` 只有 {url, fileName}：句柄里的 `close` 是函数，
      // 过 IPC 结构化克隆会抛 DataCloneError（「An object could not be cloned」），
      // 三个播放入口会因此全挂，而且每个被打开的会话都泄漏一个回环端点（等 30 分钟 TTL）。
      // 端点有 TTL 兜底，主进程侧不需要渲染层来关。
      const handle = await services.videoFiles.serve(absolute)
      return { url: handle.url, fileName: handle.fileName }
    })
  )

  // -------------------------------------------------------------------------
  // 相机告警模型（手册 §5.1.22 – §5.1.29）
  //
  // 读取不加校验、写入加 `requireAdministrator()`，与文件顶部的规则一致：
  // 这四个写操作会改变设备在智能巡航模式下**判定什么算告警**。
  // -------------------------------------------------------------------------

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_LIST_STRATEGIES,
    (_event, deviceId: string, page?: number) =>
      toResult(async () => {
        requireCameraDeviceId(deviceId)
        return getServices().cameraAlarms.listStrategies(deviceId, page ?? 1)
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_CREATE_STRATEGY,
    (_event, deviceId: string, draft: CameraAlarmStrategyDraft, diagnosisKey?: CameraAlarmDiagnosisKeyStyle) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.createStrategy(deviceId, draft, {
          ...(diagnosisKey ? { diagnosisKey } : {})
        })
        appLog().warn('Camera alarm strategy created', { deviceId, by: actor() })
        return page
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_UPDATE_STRATEGY,
    (_event, deviceId: string, draft: CameraAlarmStrategyDraft, diagnosisKey?: CameraAlarmDiagnosisKeyStyle) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.updateStrategy(deviceId, draft, {
          ...(diagnosisKey ? { diagnosisKey } : {})
        })
        appLog().warn('Camera alarm strategy updated', { deviceId, id: draft?.id, by: actor() })
        return page
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_DELETE_STRATEGIES,
    (_event, deviceId: string, ids: number[]) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.deleteStrategies(deviceId, Array.isArray(ids) ? ids : [])
        appLog().warn('Camera alarm strategies deleted', { deviceId, ids, by: actor() })
        return page
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_LIST_CONDITIONS,
    (_event, deviceId: string, page?: number) =>
      toResult(async () => {
        requireCameraDeviceId(deviceId)
        return getServices().cameraAlarms.listConditions(deviceId, page ?? 1)
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_CREATE_CONDITION,
    (_event, deviceId: string, draft: CameraAlarmConditionDraft) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.createCondition(deviceId, draft)
        appLog().warn('Camera alarm condition created', { deviceId, by: actor() })
        return page
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_UPDATE_CONDITION,
    (_event, deviceId: string, draft: CameraAlarmConditionDraft, idStyle?: CameraAlarmConditionIdStyle) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.updateCondition(deviceId, draft, {
          ...(idStyle ? { idStyle } : {})
        })
        appLog().warn('Camera alarm condition updated', { deviceId, id: draft?.id, idStyle, by: actor() })
        return page
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_ALARM_DELETE_CONDITIONS,
    (_event, deviceId: string, ids: number[]) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const page = await getServices().cameraAlarms.deleteConditions(deviceId, Array.isArray(ids) ? ids : [])
        appLog().warn('Camera alarm conditions deleted', { deviceId, ids, by: actor() })
        return page
      })
  )

  // -------------------------------------------------------------------------
  // 相机控制与维护（检测模式 / 检测启停 / 启用中的策略 / 维护能力）
  //
  // 读不加校验、写加 `requireAdministrator()`，与文件顶部的规则一致：
  // 四个写操作会改变硬件在做什么（检测怎么跑、是否开始检测、哪条策略在生效）。
  // 判定表的单一出处是 `camera-control-service.CAMERA_CONTROL_ADMIN_REQUIRED`，
  // 由 `tests/camera-control.test.ts` 守护；这里仍逐个显式调用，便于就地审查。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_RUN_MODE, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readRunMode(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_WRITE_RUN_MODE,
    (_event, deviceId: string, mode: Fa371RunModeValue) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        // 服务返回的是**重读后**的读数与 applied；这里只记审计日志。
        const result = await getServices().cameraControl.writeRunMode(deviceId, mode)
        appLog().warn('Camera detection mode written', {
          deviceId,
          requested: mode,
          applied: result.applied,
          readBack: result.after.raw,
          by: actor()
        })
        return result
      })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_DETECT_STATUS, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readDetectStatus(deviceId)
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_SCAN_AREA, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readScanArea(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_WRITE_SCAN_AREA,
    (_event, deviceId: string, area: Fa371ScanArea) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const result = await getServices().cameraControl.writeScanArea(deviceId, area)
        appLog().warn('Camera detection area written', {
          deviceId,
          applied: result.applied,
          areaCount: result.after.areas.length,
          by: actor()
        })
        return result
      })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_REGION_METADATA, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readRegionMetadata(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_WRITE_REGION_METADATA,
    (_event, deviceId: string, regions: CameraAlarmRegionMetadataInput[]) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const saved = getServices().cameraControl.writeRegionMetadata(deviceId, regions)
        appLog().warn('Camera alarm region metadata written', {
          deviceId,
          areaCount: saved.length,
          by: actor()
        })
        return saved
      })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_TURN_ON_DETECT, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('controlCameras')
      requireCameraDeviceId(deviceId)
      const result = await getServices().cameraControl.turnOnDetect(deviceId)
      appLog().warn('Camera detection started', {
        deviceId,
        applied: result.applied,
        detectId: result.detectId,
        by: actor()
      })
      return result
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_TURN_OFF_DETECT, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('controlCameras')
      requireCameraDeviceId(deviceId)
      const result = await getServices().cameraControl.turnOffDetect(deviceId)
      appLog().warn('Camera detection stopped', {
        deviceId,
        applied: result.applied,
        by: actor()
      })
      return result
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_ENABLED_STRATEGY, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readEnabledStrategy(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_SET_STRATEGY_ENABLED,
    (_event, deviceId: string, strategyId: number, enable: boolean) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const result = await getServices().cameraControl.setStrategyEnabled(
          deviceId,
          strategyId,
          enable === true
        )
        appLog().warn('Camera alarm strategy enable state written', {
          deviceId,
          strategyId,
          enable,
          disabledPrevious: result.disabledPrevious,
          after: result.after,
          by: actor()
        })
        return result
      })
  )

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_MAINTENANCE, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readMaintenance(deviceId)
    })
  )

  // -------------------------------------------------------------------------
  // 应用模式预设（局部放电 / 气体泄漏 / 机械异响）
  //
  // 厂家自己的 Quick Start 把「切换模式」写成**写成像参数**
  // （`docs/reference/api-workflow.txt` 第 55–64 行），所以这里读写的对象是
  // `GET/PUT /system/acoustic` 与 `GET/PUT /system/image`。
  //
  // 这里**没有**机型开关：`work_mode` 走下面那一组独立通道（端点 `/system`）。
  // 两条通道刻意互不调用 —— 切换应用模式不重写成像参数，写成像参数不改应用模式。
  //
  // 读不加校验；应用与还原都写设备配置，所以都要管理员（判定表里
  // `applyModePreset` 为 true，由 `tests/camera-control.test.ts` 守护）。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_MODE_PRESET, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readModePreset(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_APPLY_MODE_PRESET,
    (_event, deviceId: string, presetId: CameraModePresetId) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        // 服务返回的是**重读**后的逐字段结果；这里只记审计日志。
        const result = await getServices().cameraControl.applyModePreset(deviceId, presetId)
        appLog().warn('Camera mode preset applied', {
          deviceId,
          presetId,
          applied: result.applied,
          matches: result.matches,
          after: result.after,
          by: actor()
        })
        return result
      })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_RESTORE_MODE_VALUES,
    (_event, deviceId: string, values: CameraModeRequestedValues) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const result = await getServices().cameraControl.restoreModeValues(
          deviceId,
          sanitiseModeValues(values)
        )
        appLog().warn('Camera mode values restored', {
          deviceId,
          applied: result.applied,
          after: result.after,
          by: actor()
        })
        return result
      })
  )

  // -------------------------------------------------------------------------
  // 应用模式（这台设备在做哪种应用：局部放电 / 气体泄漏 / 机械异响）
  //
  // ⚠ 端点 `GET` / `PUT /system` **未文档化**：不在任何一份手册里，是设备自带
  // Web 界面的 bundle 里读出来的（设备自家 UI 甚至没有切换控件），所有 `*mode*`
  // 猜想路径在真机上一律 404。真机实测 `work_mode` 1/2/3 三值都可读可写，
  // 所以这里提供切换 —— 但读通道会如实回 `available: false`，界面据此不渲染控件。
  //
  // 与上面那组「应用模式预设」是两条通道：这里只写 `work_mode`，
  // **不碰** `/system/acoustic` 与 `/system/image`。
  //
  // 读不加校验；切换写设备状态，要管理员（判定表里 `writeWorkMode` 为 true，
  // 由 `tests/camera-control.test.ts` 守护）。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_WORK_MODE, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readWorkMode(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_WRITE_WORK_MODE,
    (_event, deviceId: string, mode: Fa371WorkModeValue) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        // 服务返回的是**重读后**的读数与 applied；这里只记审计日志。
        const result = await getServices().cameraControl.writeWorkMode(deviceId, mode)
        appLog().warn('Camera application mode written', {
          deviceId,
          requested: mode,
          applied: result.applied,
          readBack: result.after.raw,
          before: result.before.raw,
          by: actor()
        })
        return result
      })
  )

  // -------------------------------------------------------------------------
  // 泄漏估算参数（§5.1.10/§5.1.11，业主 2026-09-24：局放→泄漏切换要填计算模板）。
  // 读公开；写要管理员（它直接参与泄漏量/成本的计算口径），并写审计日志。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_CONTROL_READ_LEAKAGE, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraControl.readLeakage(deviceId)
    })
  )

  ipcMain.handle(
    IpcChannels.CAMERA_CONTROL_WRITE_LEAKAGE,
    (_event, deviceId: string, patch: CameraLeakagePatch) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('controlCameras')
        requireCameraDeviceId(deviceId)
        const result = await getServices().cameraControl.writeLeakage(deviceId, patch)
        appLog().warn('Camera leakage estimation settings written', {
          deviceId,
          fields: Object.keys(patch),
          by: actor()
        })
        return result
      })
  )

  // -------------------------------------------------------------------------
  // 相机固件升级（设备自带 Web 界面用的那条 HTTP 路）
  //
  // 端点 `POST /upload` / `PUT /reboot` / `GET /progress` **都不在任何一份手册里**，
  // 是从设备自带前端的 bundle 里读出来的。所以这一组通道的措辞一律是"实测存在"，
  // 不写成"受支持"，界面上开着的控件也都会说明这一点。
  //
  // 判定：
  //   - `PICK_PACKAGE` / `INSPECT_PACKAGE` 只碰本机文件（与 `MAINTENANCE_PICK_FIRMWARE`
  //     同一形状），**不**加管理员校验 —— 它们不连设备；
  //   - `READ_PROGRESS` 是设备只读；
  //   - `UPLOAD` / `REBOOT` 都写设备状态，**各自** `requireAdministrator()` 并写审计
  //     日志（`warn` 级：升级包能改设备固件，重启能中断现场正在跑的检测）。
  //
  // **上传不会重启设备**：`UPLOAD` 里没有任何 `reboot()` 调用，重启是下面那个通道
  // 的事，由操作员单独确认。
  //
  // 上传进度走 `PushChannels.CAMERA_UPGRADE_PROGRESS` 推给发起调用的那个窗口
  // （`event.sender`）：进度是**这次调用**的产物，不该广播给所有窗口。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.CAMERA_UPGRADE_PICK_PACKAGE, (event) =>
    toResult(async () => {
      // 与 `SETTINGS_PICK_STORAGE_DIR` / `MAINTENANCE_PICK_FIRMWARE` 同一形状：
      // 只打开原生对话框并回一个路径，设备那边什么都还没发生。
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: '选择相机固件升级包',
        properties: ['openFile'] as const,
        filters: [
          { name: '升级包', extensions: ['bin', 'img', 'tar', 'gz', 'zip', 'pkg', 'upgrade'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const result = window
        ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_UPGRADE_INSPECT_PACKAGE, (_event, filePath: string) =>
    toResult(async () => {
      // 本机文件读取：文件名 / 大小 / sha256 / 文件名是否符合设备规则。
      // 不连设备，所以不加管理员校验（也不该在这里判断设备族）。
      return getServices().cameraUpgrade.inspectPackage(filePath)
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_UPGRADE_UPLOAD, (event, deviceId: string, filePath: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      requireCameraDeviceId(deviceId)
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '未选择升级包文件')
      }

      appLog().warn('Camera firmware package upload started', {
        deviceId,
        fileName: path.basename(filePath),
        by: actor()
      })

      const result = await getServices().cameraUpgrade.upload(deviceId, filePath, (progress) => {
        // 只推给发起这次上传的窗口：进度是这次调用的产物。
        if (!event.sender.isDestroyed()) {
          event.sender.send(PushChannels.CAMERA_UPGRADE_PROGRESS, progress)
        }
      })

      appLog().warn('Camera firmware package uploaded (device NOT rebooted)', {
        deviceId,
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        status: result.status,
        elapsedMs: result.elapsedMs,
        by: actor()
      })
      return result
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_UPGRADE_READ_PROGRESS, (_event, deviceId: string) =>
    toResult(async () => {
      requireCameraDeviceId(deviceId)
      return getServices().cameraUpgrade.readProgress(deviceId)
    })
  )

  ipcMain.handle(IpcChannels.CAMERA_UPGRADE_REBOOT, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      requireCameraDeviceId(deviceId)
      // 服务只发 `PUT /reboot`；"设备未回执"由结果里的 `connectionDropped` 如实报出，
      // 这里照原样写进日志，不把它改写成成功或失败。
      const result = await getServices().cameraUpgrade.reboot(deviceId)
      appLog().warn('Camera reboot issued (device web path PUT /reboot)', {
        deviceId,
        acknowledged: result.acknowledged,
        connectionDropped: result.connectionDropped,
        by: actor()
      })
      return result
    })
  )

  // -------------------------------------------------------------------------
  // Playback (Phase 8)
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.RECORDING_PLAYBACK_DATA, (_event, recordingId: string) =>
    toResult(async () => {
      requirePermission('viewRecordings')
      if (typeof recordingId !== 'string' || recordingId.trim() === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少录音 ID')
      }
      return getServices().playback.load(recordingId)
    })
  )

  // -------------------------------------------------------------------------
  // 告警本地联动（录像 / 弹窗 / 提示 / 邮件）
  // -------------------------------------------------------------------------
  //
  // 读不加管理员校验、写加——与文件顶部那条规则一致。
  // 注意这里**没有**「手动触发一次联动」的通道：引擎完全由主进程拥有，
  // 渲染层只能读状态、读待处理、确认，以及发一封测试邮件。

  ipcMain.handle(IpcChannels.LINKAGE_GET_STATUS, () =>
    toResult(async () => {
      requirePermission('viewAlarms')
      return getServices().linkage.status()
    })
  )

  ipcMain.handle(IpcChannels.LINKAGE_GET_PENDING, () =>
    toResult(async () => {
      requirePermission('viewAlarms')
      return getServices().linkage.pendingSnapshot()
    })
  )

  ipcMain.handle(IpcChannels.LINKAGE_ACKNOWLEDGE, (_event, ids?: unknown) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('viewAlarms')
      /**
       * 形状校验在这里、业务在服务里：不传 / 传空数组都是「全部确认」
       * （返回快照而不是条数，界面就不必自己推算确认后的状态）。
       */
      const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      const snapshot = getServices().linkage.acknowledge(list)
      appLog().info('告警联动：待处理告警已确认', { count: list.length, by: actor() })
      return snapshot
    })
  )

  ipcMain.handle(IpcChannels.LINKAGE_TEST_EMAIL, (_event, input: LinkageTestEmailInput) =>
    toResult(async () => {
      requireAdministrator()
      return getServices().linkage.testEmail(input)
    })
  )

  /*
   * 「操作员正在看告警中心」（业主 2026-09-26 第 5 条）。
   *
   * 不需要管理员、也不写任何记录：它只是把"哪一页在屏幕上"这件**只有渲染层知道**的事
   * 同步给主进程 —— 那个置顶提示窗口是主进程开的，渲染层没有关它的能力。
   * 挡住的是"再看一遍同一个告警"的重复打扰，告警本身照样进列表与角标。
   *
   * 形状校验在边界上做完（非 boolean 一律当 false = 照常弹），因为这条通道
   * **失败的方向必须是"继续弹"**：漏弹一条告警比多弹一个窗口危险得多。
   */
  ipcMain.handle(IpcChannels.LINKAGE_SET_ALARM_CENTER_OPEN, (_event, open?: unknown) =>
    toResult(async () => {
      const value = open === true
      getServices().linkage.setAlarmCenterOpen(value)
      return { open: value }
    })
  )

  // -------------------------------------------------------------------------
  // Configuration (Phase 9)
  // -------------------------------------------------------------------------

  /** Helper: resolve a ConfigService for the device, establishing a session. */
  const withConfig = async <T>(deviceId: string, action: (config: ConfigService) => Promise<T>): Promise<T> => {
    const config = await getServices().devices.configFor(deviceId)
    return action(config)
  }

  ipcMain.handle(IpcChannels.CONFIG_GET_CHANNELS, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getChannels()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_UPDATE_CHANNEL,
    (_event, deviceId: string, channelIndex: number, patch: Record<string, unknown>) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) =>
          config.updateChannel(channelIndex, patch as never)
        )
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_SAMPLE_RATE, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getSampleRate()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_SET_SAMPLE_RATE,
    (_event, deviceId: string, sampleRate: number) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('configureDevices')
        const services = getServices()
        // Changing the sample rate restarts acquisition, which breaks any live
        // stream. Stopping first means the UI reconnects cleanly instead of
        // holding sockets the device has already invalidated.
        await services.devices.stopMonitoring(deviceId)
        return withConfig(deviceId, (config) => config.setSampleRate(sampleRate))
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_ALARM_PROFILES, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getAlarmProfiles()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_SAVE_ALARM_PROFILE,
    (_event, deviceId: string, profile: AlarmProfileConfig) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) => config.saveAlarmProfile(profile))
      })
  )

  ipcMain.handle(
    IpcChannels.CONFIG_DELETE_ALARM_PROFILE,
    (_event, deviceId: string, profileId: number) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) => config.deleteAlarmProfile(profileId))
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_NETWORK, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getNetwork()))
  )

  /**
   * Network change with live progress.
   *
   * The progress channel matters more here than anywhere else: this operation
   * takes up to ~45 s and can leave a device unreachable, so the user must see
   * which stage it reached rather than a spinner that might never resolve.
   */
  ipcMain.handle(
    IpcChannels.CONFIG_CHANGE_NETWORK,
    (event, deviceId: string, next: unknown) =>
      toResult(async () => {
        // A network change can leave the device unreachable, so it is one of the
        // operations that must not be available to an operator account.
        requireAdministrator()
        requirePermission('configureDevices')
        const window = BrowserWindow.fromWebContents(event.sender)
        const services = getServices()

        // Streams are bound to the old address and cannot survive the change.
        await services.devices.stopMonitoring(deviceId)

        const result = await services.devices.changeNetwork(deviceId, {
          next: next as never,
          onProgress: (stage, detail) => {
            if (window && !window.isDestroyed()) {
              window.webContents.send(PushChannels.NETWORK_PROGRESS, {
                deviceId,
                stage,
                ...(detail ? { detail } : {})
              })
            }
          }
        })

        appLog().info('Network change finished', {
          deviceId,
          success: result.success,
          stage: result.stage,
          address: result.address
        })
        return result
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_TIME, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getTime()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_UPDATE_TIME,
    (_event, deviceId: string, patch: Record<string, unknown>) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) => config.updateTime(patch as never))
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_SYNC_TIME, (_event, deviceId: string) =>
    toResult(() => {
      requireAdministrator()
        requirePermission('configureDevices')
      return withConfig(deviceId, (config) => config.syncDeviceTime())
    })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_RS485, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getRs485()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_UPDATE_RS485,
    (_event, deviceId: string, patch: Record<string, unknown>) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) => config.updateRs485(patch as never))
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_SERIAL_PORTS, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getAvailableSerialPorts()))
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_MODBUS, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getModbus()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_UPDATE_MODBUS,
    (_event, deviceId: string, patch: Record<string, unknown>) =>
      toResult(() => {
        requireAdministrator()
        requirePermission('configureDevices')
        return withConfig(deviceId, (config) => config.updateModbus(patch as never))
      })
  )

  ipcMain.handle(IpcChannels.CONFIG_GET_PUSH, (_event, deviceId: string) =>
    toResult(() => withConfig(deviceId, (config) => config.getPushConfig()))
  )

  ipcMain.handle(
    IpcChannels.CONFIG_SET_DEVICE_NAME,
    (_event, deviceId: string, name: string) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('configureDevices')
        await withConfig(deviceId, (config) => config.setDeviceName(name))
        // Refresh the cached name so the device list reflects the change without
        // waiting for the next health check.
        await getServices().devices.getInfo(deviceId)
        return undefined
      })
  )

  // -------------------------------------------------------------------------
  // Maintenance (Phase 10)
  //
  // Every one of these is destructive. The renderer confirms with the user
  // BEFORE calling; these handlers execute immediately and log at warn level so
  // a destructive action is always traceable in the app log. They additionally
  // require an administrator: a confirmation dialog is a courtesy to the person
  // in front of the screen, not an authorisation check.
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.MAINTENANCE_REBOOT, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      await getServices().devices.stopMonitoring(deviceId)
      await getServices().devices.systemControl(deviceId, SystemControlAction.REBOOT)
      appLog().warn('Device reboot issued', { deviceId, by: actor() })
      return undefined
    })
  )

  ipcMain.handle(IpcChannels.MAINTENANCE_FACTORY_RESET, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      await getServices().devices.stopMonitoring(deviceId)
      await getServices().devices.systemControl(deviceId, SystemControlAction.FACTORY_RESET)
      appLog().warn('Factory reset issued', { deviceId, by: actor() })
      return undefined
    })
  )

  ipcMain.handle(IpcChannels.MAINTENANCE_SYSTEM_UPGRADE, (_event, deviceId: string) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('manageDevices')
      await getServices().devices.stopMonitoring(deviceId)
      await getServices().devices.systemControl(deviceId, SystemControlAction.SYSTEM_UPGRADE)
      appLog().warn('System upgrade issued', { deviceId, by: actor() })
      return undefined
    })
  )

  ipcMain.handle(IpcChannels.MAINTENANCE_PICK_FIRMWARE, (event) =>
    toResult(async () => {
      // Deliberately NOT guarded: this only opens a local file picker and returns
      // a path. Nothing reaches the device until the upload, which is guarded.
      const window = BrowserWindow.fromWebContents(event.sender)
      const options = {
        title: '选择固件升级包',
        properties: ['openFile'] as const,
        filters: [
          { name: '固件包', extensions: ['bin', 'img', 'tar', 'gz', 'zip', 'pkg'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      }
      const result = window
        ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })

      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0] ?? null
    })
  )

  ipcMain.handle(
    IpcChannels.MAINTENANCE_UPLOAD_FIRMWARE,
    (_event, deviceId: string, filePath: string) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('manageDevices')
        if (typeof filePath !== 'string' || filePath.trim() === '') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '未选择固件文件')
        }
        appLog().warn('Firmware upload started', { deviceId, by: actor() })
        // The main process reads the file: a firmware image is tens of megabytes
        // and pushing it through IPC just to hand it back would copy it twice.
        return getServices().devices.uploadFirmware(deviceId, filePath)
      })
  )

  // -------------------------------------------------------------------------
  // Historical trends (Phase 11)
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.TREND_QUERY, (_event, query: TrendQueryBody) =>
    toResult(async () => {
      requirePermission('viewTrends')
      const services = getServices()
      if (!query || typeof query.deviceId !== 'string' || query.deviceId === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少设备 ID')
      }

      // Translate the local row id into the storage identity here, so the
      // renderer never needs to know how history is laid out on disk.
      const device = services.devices.get(query.deviceId)
      const { deviceId: _ignored, ...rest } = query
      return services.trendQuery.query({ deviceUid: device.deviceUid, ...rest })
    })
  )

  ipcMain.handle(IpcChannels.TREND_COVERAGE, (_event, deviceId: string) =>
    toResult(async () => {
      requirePermission('viewTrends')
      const services = getServices()
      // The directory layout is keyed by the STABLE uid, so translate the local
      // row id the UI holds into the identity the files are stored under.
      const device = services.devices.get(deviceId)
      return services.trendQuery.getCoverage(device.deviceUid)
    })
  )

  ipcMain.handle(IpcChannels.TREND_STATS, () =>
    toResult(async () => {
      requirePermission('viewTrends')
      return getServices().trends.stats
    })
  )

  ipcMain.handle(IpcChannels.TREND_FLUSH, () =>
    toResult(async () => getServices().trends.flush())
  )

  /**
   * 趋势数据导出成 CSV（业主 2026-09-19 第 13 批第 6 条：「支持数据导出」）。
   *
   * 三件事都在这一层做，因为它们是"落盘"这件事的一部分：
   *   1. **参数收窄**：文件名只取最后一段（`path.basename`）、剥掉非法字符，CSV 必须是字符串。
   *      渲染层送进来的任何东西都不能让它写到 `exports/trends/` 之外；
   *   2. **写**：先 `mkdir -p`，再写文件（UTF-8，内容里已经带 BOM）；
   *   3. **读回核对**（仓库里每一条写路径的规矩）：`stat` 拿真实字节数、把文件重新读出来
   *      数一遍数据行 —— 返回给界面的 `bytes` / `rows` 都来自**读回的那一份**，
   *      而不是我们以为自己写了多少。
   *
   * 权限用 `viewTrends`（与查趋势同一档）：导出的是这个操作员本来就能看到的数据，
   * 它写的是**我们自己的**导出目录，不改设备也不改库。
   */
  ipcMain.handle(IpcChannels.TREND_EXPORT_CSV, (_event, request: TrendExportRequest) =>
    toResult(async (): Promise<TrendExportResult> => {
      requirePermission('viewTrends')
      const rawName = typeof request?.fileName === 'string' ? request.fileName : ''
      const csv = typeof request?.csv === 'string' ? request.csv : ''
      if (csv === '') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '导出内容为空')
      }
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_').trim()
      if (safeName === '' || safeName === '.' || safeName === '..') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '导出文件名不合法')
      }

      const directory = path.join(getServices().settings.get().storageRoot, 'exports', 'trends')
      await mkdir(directory, { recursive: true })
      const target = path.join(directory, safeName)
      await writeFile(target, csv, 'utf8')

      // 读回核对：字节数与数据行数都数**读回来的那一份**。
      const back = await readFile(target, 'utf8')
      const bytes = (await stat(target)).size
      const rows = back.split(/\r?\n/).filter((line, index) => index > 0 && line.trim() !== '').length
      appLog().info('Trend CSV exported', { path: target, bytes, rows })
      return { path: target, bytes, rows }
    })
  )

  // -------------------------------------------------------------------------
  // 事件与告警中心（产品要求「设置事件和告警中心」）
  //
  // 读不加管理员校验、写加——与文件顶部那条规则一致：
  // 「确认」与「下载设备结果文件」都会改变本机状态（写 SQLite / 写盘 / 连设备），
  // 因此它们跟 `ALARM_ACKNOWLEDGE`、`LINKAGE_ACKNOWLEDGE` 一样要求管理员。
  // -------------------------------------------------------------------------

  ipcMain.handle(IpcChannels.EVENT_CENTER_QUERY, (_event, query: EventCenterQuery) =>
    toResult(async () => {
      requirePermission('viewEvents')
      /**
       * 形状兜底在这里，业务在服务里：`limit`/`offset` 缺失时用文档默认值，
       * 其余筛选字段原样透传（服务会把无法识别的取值过滤掉）。
       * 这个查询**不是**特权操作：它只读三路来源，与「列出告警」同级。
       */
      const input: EventCenterQuery = query ?? {
        limit: EVENT_CENTER_DEFAULT_LIMIT,
        offset: 0
      }
      return getServices().eventCenter.query(input)
    })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_DETECT_LOGS, (_event, deviceId: string, detectId?: number) =>
    toResult(async () => {
      requirePermission('viewEvents')
      requireCameraDeviceId(deviceId)
      return getServices().eventCenter.listDetectLogs(
        deviceId,
        typeof detectId === 'number' && Number.isFinite(detectId) ? detectId : undefined
      )
    })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_ACKNOWLEDGE, (_event, ids: unknown) =>
    toResult(async () => {
      requireAdministrator()
        requirePermission('viewEvents')
      const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
      const result = await getServices().eventCenter.acknowledge(list)
      appLog().info('事件中心：确认事件', {
        requested: list.length,
        acknowledged: result.acknowledged,
        unrecognised: result.unrecognised,
        by: actor()
      })
      return result
    })
  )

  /**
   * 事件的图片证据（规格 §12.1 的 Visual）。
   *
   * **只读**：它把库里的一条相对路径变成回环地址，不连设备、不写盘、不写库 ——
   * 所以与 `EVENT_CENTER_QUERY` 同级，不要管理员（抽屉一打开就要取图，
   * 让它是特权操作只会让普通账户看到一个永远空的证据页）。
   */
  ipcMain.handle(IpcChannels.EVENT_CENTER_EVIDENCE_IMAGE, (_event, input: EventEvidenceImageInput) =>
    toResult(async () => {
      requirePermission('viewEvents')
      const request: EventEvidenceImageInput = input ?? {}
      return getServices().eventCenter.evidenceImage(request)
    })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_EVIDENCE_IMAGE_CLOSE, () =>
    toResult(async () => {
      requirePermission('viewEvents')
      getServices().eventCenter.closeEvidenceImage()
    })
  )

  /**
   * 处置一条事件（规格 §2.2）：改工作流状态 / 指派 / 留言。
   *
   * **写** —— 与 `EVENT_CENTER_ACKNOWLEDGE` 同一档：它写本机库、写 Activity，
   * `acknowledge` 那一个动作还会连设备（来源侧的确认）。所以同样要求管理员。
   * 操作者是谁由**会话**决定（`actor()`），不接受请求里自带一个名字：
   * Activity 的价值就在"谁做的"这一列，让它由调用方自报就等于没有这一列。
   */
  ipcMain.handle(IpcChannels.EVENT_CENTER_CHANGE_STATUS, (_event, input: EventStatusChangeInput) =>
    toResult(async () => {
      requireAdministrator()
      requirePermission('viewEvents')
      if (input === null || typeof input !== 'object') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少处置参数')
      }
      const result = await getServices().eventCenter.changeStatus({
        entryId: String(input.entryId ?? ''),
        ...(Array.isArray(input.entryIds)
          ? { entryIds: input.entryIds.filter((id): id is string => typeof id === 'string') }
          : {}),
        ...(input.action !== undefined ? { action: input.action } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.assignee !== undefined ? { assignee: String(input.assignee) } : {}),
        ...(input.note !== undefined ? { note: String(input.note) } : {}),
        ...(input.currentStatus !== undefined ? { currentStatus: input.currentStatus } : {}),
        actor: actor()
      })
      return result
    })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_ACTIVITY, (_event, entryId: unknown, limit: unknown) =>
    toResult(async () => {
      requirePermission('viewEvents')
      return getServices().eventCenter.activity(
        String(entryId ?? ''),
        typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
      )
    })
  )

  /**
   * Incident（规格 §14.2 的 V1）：人工创建 + 手动关联。
   *
   * 两条读沿用 `viewEvents`（与 `query` 同级）；三条写**另外**要求管理员 —— 与
   * `EVENT_CENTER_CHANGE_STATUS` 完全同一条规则（它们写本机库，且"谁把这几条告警并成
   * 一个事件"在事后是要追责的）。
   *
   * 创建人/关联人一律取**会话**（`actor()`），不接受请求里自带一个名字 ——
   * 与 Activity 同一条推理：那一列的价值就在"谁做的"。
   */
  ipcMain.handle(
    IpcChannels.EVENT_CENTER_INCIDENT_CREATE,
    (_event, input: EventIncidentCreateInput) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('viewEvents')
        if (input === null || typeof input !== 'object') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少 Incident 参数')
        }
        return getServices().eventCenter.createIncident({
          title: input.title,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(Array.isArray(input.entryIds)
            ? { entryIds: input.entryIds.filter((id): id is string => typeof id === 'string') }
            : {}),
          actor: actor()
        })
      })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_INCIDENT_LINK, (_event, input: EventIncidentLinkInput) =>
    toResult(async () => {
      requireAdministrator()
      requirePermission('viewEvents')
      if (input === null || typeof input !== 'object') {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少关联参数')
      }
      return getServices().eventCenter.linkAlerts({
        incidentId: String(input.incidentId ?? ''),
        entryIds: Array.isArray(input.entryIds)
          ? input.entryIds.filter((id): id is string => typeof id === 'string')
          : [],
        actor: actor()
      })
    })
  )

  ipcMain.handle(
    IpcChannels.EVENT_CENTER_INCIDENT_UNLINK,
    (_event, input: EventIncidentUnlinkInput) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('viewEvents')
        if (input === null || typeof input !== 'object') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少解除关联参数')
        }
        return getServices().eventCenter.unlinkAlert({
          incidentId: String(input.incidentId ?? ''),
          entryId: String(input.entryId ?? '')
        })
      })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_INCIDENTS_FOR_ALERT, (_event, entryId: unknown) =>
    toResult(async () => {
      requirePermission('viewEvents')
      return getServices().eventCenter.incidentsForEntry(String(entryId ?? ''))
    })
  )

  ipcMain.handle(IpcChannels.EVENT_CENTER_INCIDENT_LIST, (_event, limit: unknown) =>
    toResult(async () => {
      requirePermission('viewEvents')
      return getServices().eventCenter.listIncidents(
        typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
      )
    })
  )

  /**
   * 下载一个检测结果文件（手册 §5.1.18）。
   *
   * 进度用 `event.sender` 对应的窗口推回去，而不是从 `main/index.ts` 全局广播：
   * 发起下载的是**这一个**窗口，把进度发给别的窗口只会让另一处界面出现一个
   * 它没有发起过的进度。
   */
  ipcMain.handle(
    IpcChannels.EVENT_CENTER_DOWNLOAD_DETECT_FILE,
    (event, input: EventDetectDownloadInput) =>
      toResult(async () => {
        requireAdministrator()
        requirePermission('downloadDetectFiles')
        if (input === null || typeof input !== 'object') {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少下载参数')
        }
        requireCameraDeviceId(input.deviceId)
        if (!Number.isFinite(input.logId)) {
          throw new AppError(ErrorCodes.VALIDATION_ERROR, '检测日志编号必须是整数')
        }

        const window = BrowserWindow.fromWebContents(event.sender)
        appLog().info('事件中心：开始下载检测结果文件', {
          deviceId: input.deviceId,
          logId: input.logId,
          kind: input.kind,
          by: actor()
        })

        return getServices().eventCenter.download(input, (progress) => {
          if (window && !window.isDestroyed()) {
            window.webContents.send(PushChannels.EVENT_CENTER_DOWNLOAD_PROGRESS, progress)
          }
        })
      })
  )

  appLog().info('IPC handlers registered')
}
