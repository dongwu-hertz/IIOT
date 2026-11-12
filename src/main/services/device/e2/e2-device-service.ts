/**
 * 听诊盒子族的**应用服务**：把「拉」通道包装成 IPC 能用的两件事（状态 / 同步）。
 *
 * 分工：
 *   - `E2Client`（`e2-client.ts`）只管 HTTP 与收窄；
 *   - `E2SyncService`（`e2-sync-service.ts`）只管把拉回来的东西落库；
 *   - 这一层负责**认设备**（是不是听诊盒子）、**要客户端**（复用 `DeviceService` 里那份
 *     带会话的缓存）、以及把三处读取（`/workmode`、`/system`、`/basic`）拼成一个视图。
 *
 * 为什么"是不是听诊盒子"检查在这里而不是在 IPC 处理器里：处理器应该只做权限与参数收窄，
 * 而机型判断是这个服务的领域知识 —— 放在两处迟早会有一处忘了改。
 */

import type { Device } from '@shared/domain/models'
import { readdir } from 'node:fs/promises'
import { e2ChannelCountFromModel, E2_AIR_SONAR_CHANNEL_COUNT, type E2Variant } from '@shared/domain/e2'
import {
  applyPtzPatch,
  buildPtzConfig,
  comparePtzPatch,
  validatePtzPatch,
  type E2NvtTimeSyncOutcome,
  type E2PtzConfig,
  type E2PtzPatch,
  type E2PtzUpdateOutcome
} from '@shared/domain/e2-ptz'
import type { E2DeviceStatus, E2SyncOutcome, E2SyncRequest, E2AlarmSnapshotView } from '@shared/ipc/contract'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  defaultDeviceIngestPlan,
  defaultIotIngestConfig,
  httpPushUrl,
  type IotIngestConfig,
  type IotIngestLocalAddress
} from '@shared/domain/iot-ingest'
import {
  pickE2CallbackAddress,
  type E2RealtimeCallbackListener,
  type E2RealtimeCallbackOutcome,
  type E2RealtimeCallbackStatus
} from '@shared/domain/e2-callback'
import { listLocalAddresses } from '../../ingest/local-addresses'
import type { AlarmRepository, RecordingRepository } from '../../database/alarm-repository'
import type { StorageService } from '../../storage/storage-service'
import type { DeviceService } from '../device-service'
import type { E2Client } from './e2-client'
import { deviceLog } from '../../logging/logger'
import { E2SyncService, E2_SYNC_DEFAULT_LIMIT } from './e2-sync-service'

/** 一次同步的硬上限：界面显示的也是它，所以它是导出常量而不是散在代码里的 1000。 */
export const E2_SYNC_MAX_LIMIT = 1000

export interface E2DeviceServiceOptions {
  devices: DeviceService
  alarms: AlarmRepository
  recordings: RecordingRepository
  storage: StorageService
  /**
   * 本机文件的回环端点（与手动录像回放**同一个实例**）。
   *
   * 复用而不是另起一个服务：那一套"只绑回环 + 路径里带每会话令牌 + 不对就 403 并记日志"
   * 的推理只需要在一处成立；两个实现就意味着两条安全边界要各自维护。
   */
  files: ImageSetServer
  /** iotIngest listener config; injected so tests do not depend on a real settings file. */
  getIngestConfig?: () => IotIngestConfig
  /** Local candidate addresses; injected for the same reason. */
  listLocalAddresses?: () => IotIngestLocalAddress[]
  /** Current HTTP listener status for the callback card. */
  getRealtimeListener?: () => E2RealtimeCallbackListener
}

/** 只需要 `serveImages`：接口写窄一点，测试里给一个假实现就够。 */
export interface ImageSetServer {
  serveImages(
    directory: string,
    names: readonly string[]
  ): Promise<{ files: Array<{ name: string; url: string }>; close: () => void }>
}

export class E2DeviceService {
  private readonly devices: DeviceService
  private readonly alarms: AlarmRepository
  private readonly recordings: RecordingRepository
  private readonly storage: StorageService
  private readonly files: ImageSetServer
  private readonly getIngestConfig: () => IotIngestConfig
  private readonly listLocalAddresses: () => IotIngestLocalAddress[]
  private readonly getRealtimeListener: () => E2RealtimeCallbackListener
  /**
   * 当前打开着的抓图端点（一次只留一个）。
   *
   * 为什么只留一个：抓图是"点开一条告警看"的临时视图，而每个端点都占一个回环端口与一个
   * 定时器；换一条告警时上一个就该关掉。留着它们没有任何用处，只会让端点数随点击次数增长。
   */
  private snapshotHandle: { close: () => void } | null = null

  constructor(options: E2DeviceServiceOptions) {
    this.devices = options.devices
    this.alarms = options.alarms
    this.recordings = options.recordings
    this.storage = options.storage
    this.files = options.files
    this.getIngestConfig = options.getIngestConfig ?? defaultIotIngestConfig
    this.listLocalAddresses = options.listLocalAddresses ?? listLocalAddresses
    this.getRealtimeListener =
      options.getRealtimeListener ?? (() => ({ enabled: false, listening: false }))
  }

  /**
   * 设备状态：**先判变体**，再按变体读该读的东西。
   *
   * 顺序不是随意的：`/system` 是两代**都有**的端点，而它的内容就是变体判据
   * （`detectE2Variant()`）。先读它有两个好处：
   *   1. 后面用哪个日志端点、要不要读 `/workmode`、录音叫什么名字，全都有依据；
   *   2. 少一次请求（否则要先猜变体再去读 `/system` 验证）。
   *
   * Air Sonar 没有 `/workmode`，所以那一步只在 2023 版执行；两代的设备信息端点也不同
   * （`/basic` vs `/get_device_basic_params`，字段一模一样）。
   */
  async status(deviceId: string): Promise<E2DeviceStatus> {
    const device = this.requireAuscultation(deviceId)
    const client = this.devices.e2ClientFor(device)

    const status: E2DeviceStatus = {
      rawWorkMode: '',
      params: {},
      basic: {},
      alarmLogRetention: client.alarmLogRetention,
      maxSyncLimit: E2_SYNC_MAX_LIMIT
    }

    try {
      status.params = await client.getSystem()
    } catch (error) {
      // 读不到参数就没法判变体，但设备信息还能读 —— 如实分开说，不整条报错。
      status.paramsError = error instanceof Error ? error.message : String(error)
    }
    const variant = client.resolvedVariant
    if (variant !== undefined) {
      status.variant = variant
      // 顺手把"设备自己说的代次"记进设备行（v12）：界面刷新/重启之后仍然知道该给哪一组页签。
      this.rememberVariant(device, variant)
    }

    if (variant !== 'airSonar') {
      try {
        const workMode = await client.getWorkMode()
        status.rawWorkMode = workMode.rawMode
        if (workMode.mode !== undefined) status.mode = workMode.mode
        if (workMode.samplerate !== undefined) status.samplerate = workMode.samplerate
        if (workMode.stftPicHeight !== undefined) status.stftPicHeight = workMode.stftPicHeight
        if (workMode.stftPicWidth !== undefined) status.stftPicWidth = workMode.stftPicWidth
      } catch (error) {
        // `/workmode` 读不到不是"整台设备不行"：参数已经在上面拿到了。
        if (status.paramsError === undefined) {
          status.paramsError = error instanceof Error ? error.message : String(error)
        }
      }
    }

    try {
      const basic = await client.getBasic()
      const fields: E2DeviceStatus['basic'] = {}
      if (basic.devName !== undefined) fields.devName = basic.devName
      if (basic.devType !== undefined) fields.devType = basic.devType
      if (basic.devVersion !== undefined) fields.devVersion = basic.devVersion
      if (basic.upgradeTime !== undefined) fields.upgradeTime = basic.upgradeTime
      if (basic.webVersion !== undefined) fields.webVersion = basic.webVersion
      if (basic.equipNumber !== undefined) fields.equipNumber = basic.equipNumber
      status.basic = fields
      // 型号字符串里带通道数（`AS16` ⇒ 16）：这是设备自己说的，不是我们猜的。
      const fromModel = e2ChannelCountFromModel(basic.devType)
      if (fromModel !== undefined) status.channelCount = fromModel
      else if (variant === 'airSonar') status.channelCount = E2_AIR_SONAR_CHANNEL_COUNT
      if (status.channelCount !== undefined) {
        this.devices.ensureAuscultationChannels(deviceId, status.channelCount)
      }
    } catch {
      // 设备信息读不到不影响参数：留空，不编默认值。
    }

    return status
  }

  /** 拉一批告警与录音。 */
  async sync(deviceId: string, request: E2SyncRequest = {}): Promise<E2SyncOutcome> {
    const device = this.requireAuscultation(deviceId)
    const service = new E2SyncService({
      // 复用 `DeviceService` 缓存的那份客户端：否则每次同步都要重新登录一次。
      client: this.devices.e2ClientFor(device),
      alarms: this.alarms,
      recordings: this.recordings,
      storage: this.storage,
      deviceId: device.id,
      deviceUid: device.deviceUid
    })
    return service.sync({
      limit: request.limit ?? E2_SYNC_DEFAULT_LIMIT,
      ...(request.since !== undefined ? { since: request.since } : {}),
      downloadAudio: request.downloadAudio !== false,
      downloadSpectrograms: request.downloadSpectrograms === true
    })
  }

  /** 机型判断：一台声学相机或声纹设备走到这里，就是一个明确的错误而不是一次 404。 */
  private requireAuscultation(deviceId: string): Device {
    const device = this.devices.get(deviceId)
    if (device.kind !== 'auscultationBox') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '该设备不是听诊盒子，没有工作模式与告警日志',
        device.id
      )
    }
    return device
  }

  /**
   * **只给空气声呐**（SN-16）：PTZ 那一组参数是"与球机联动"的配置，2023 版听诊盒子
   * 没有球机这个概念（它的 `/system` 里连 `cam_*` 都没有）。
   *
   * 判据是**设备自己说的变体**（`/system` 里有 `cam_enable` 那一组键），不按型号名猜；
   * 读到之后顺手记进设备行（v12）并**读回核对**，这样界面刷新/重启之后仍然知道该给哪一组页签。
   */
  private async requireAirSonar(device: Device): Promise<E2Client> {
    const client = this.devices.e2ClientFor(device)
    const variant = client.resolvedVariant ?? (await client.ensureVariant())
    if (variant !== 'airSonar') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '该设备不是 SN-16 空气声呐，没有球机联动（PTZ）参数',
        device.id
      )
    }
    this.rememberVariant(device, 'airSonar')
    return client
  }

  /**
   * 把"设备自己说的变体"记进设备行，并**读回核对**。
   *
   * 读回不一致只在**日志**里报（不抛）：变体记错只会让界面少给/多给一个 PTZ 页签，
   * 而抛出去会让"读设备状态"这件只读的事失败 —— 代价与收益不成比例。界面上真正的判据
   * 仍然是这一次读到的变体（`status.variant`），库里那一列是给"下次打开页面"用的。
   */
  private rememberVariant(device: Device, variant: E2Variant): void {
    const readBack = this.devices.rememberE2Variant(device.id, variant)
    if (readBack !== variant) {
      deviceLog().warn('听诊盒子代次写库后读回不一致', {
        deviceId: device.id,
        wrote: variant,
        readBack: String(readBack)
      })
    }
  }

  /**
   * 读 PTZ 联动配置（球机地址/账号/开关 + 实时通道 + 球机是否已初始化）。
   *
   * 顺带做两件事：判代次（不是空气声呐就明确报错）、把代次记进设备行。
   */
  async ptzConfig(deviceId: string): Promise<E2PtzConfig> {
    const device = this.requireAuscultation(deviceId)
    const client = await this.requireAirSonar(device)
    const params = await client.getSystem()
    let channelCount: number | undefined
    try {
      const basic = await client.getBasic()
      channelCount = e2ChannelCountFromModel(basic.devType)
      if (channelCount !== undefined) this.devices.ensureAuscultationChannels(deviceId, channelCount)
    } catch {
      // 设备信息读不到不影响参数：通道上限那时缺席，界面不做上限判断（不猜 16）。
    }
    return buildPtzConfig(params, channelCount)
  }

  /**
   * 写 PTZ 联动配置：**读 → 改 → 整份写回 → 再读 → 逐项核对**。
   *
   * 顺序里的每一步都有理由（业主的硬规矩是"每个写设备的操作必须读回验证"）：
   *   1. **先读**：手册的写示例是整份参数回写，所以底稿必须是设备**现在**那一份 ——
   *      拿旧的/自己拼的底稿会把别的参数（`db_limit`、`notify_url`…）一起改掉；
   *   2. 改动只落在这几个键上（`applyPtzPatch`），口令没改就保留设备刚给的原值；
   *   3. `PUT /system`；
   *   4. **重新 `GET /system`**（不是拿请求当结果）；
   *   5. `comparePtzPatch()` 逐项比 —— 界面拿这个结果说"哪几项生效了、哪几项没有"。
   */
  async updatePtzConfig(deviceId: string, patch: E2PtzPatch): Promise<E2PtzUpdateOutcome> {
    const device = this.requireAuscultation(deviceId)
    const client = await this.requireAirSonar(device)
    const before = await client.getSystem()
    let channelCount: number | undefined
    try {
      const basic = await client.getBasic()
      channelCount = e2ChannelCountFromModel(basic.devType)
      if (channelCount !== undefined) this.devices.ensureAuscultationChannels(deviceId, channelCount)
    } catch {
      channelCount = undefined
    }
    const validation = validatePtzPatch(patch, channelCount)
    if (!validation.ok) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, validation.reasonKey, device.id)
    }
    const merged = applyPtzPatch(before, patch)
    await client.putSystem(merged)
    const after = await client.getSystem()
    const fields = comparePtzPatch(after, patch)
    deviceLog().info('空气声呐 PTZ 配置已写入并读回', {
      deviceId: device.id,
      fields: fields.map((field) => `${field.field}:${field.ok ? 'ok' : 'mismatch'}`).join(',')
    })
    return {
      readBack: buildPtzConfig(after, channelCount),
      fields,
      allApplied: fields.every((field) => field.ok)
    }
  }


  /**
   * SN-16 realtime_value callback status.
   *
   * Read-only: current device notify_url / is_send_realtime_value, the local HTTP listener
   * state, and whether notify_url points at this machine's ingest endpoint. The secret is
   * never echoed; "points to us" is decided by comparing host + port + path prefix.
   */
  async realtimeCallbackStatus(deviceId: string): Promise<E2RealtimeCallbackStatus> {
    const device = this.requireAuscultation(deviceId)
    const client = this.devices.e2ClientFor(device)
    const params = await client.getSystem()
    const supported = client.resolvedVariant === 'airSonar'
    const notifyUrl = readString(params.notify_url)
    const flag = readInteger(params.is_send_realtime_value)
    return {
      deviceId,
      supported,
      ...(notifyUrl !== undefined ? { notifyUrl } : {}),
      ...(flag !== undefined ? { isSendRealtimeValue: flag } : {}),
      pointsToUs: supported && notifyUrl !== undefined && this.pointsToLocalListener(notifyUrl),
      listener: this.getRealtimeListener()
    }
  }

  /**
   * Enable/disable local reception of SN-16 realtime_value.
   *
   * Enable: make this device declare HTTP ingest (this is what opens the shared listener),
   * pick a local address on the device subnet, write device notify_url + is_send_realtime_value=1,
   * then GET /system and compare. Disable: write is_send_realtime_value=0 only; notify_url stays
   * because alarm callbacks may use it too.
   */
  async setRealtimeCallback(deviceId: string, enabled: boolean): Promise<E2RealtimeCallbackOutcome> {
    const device = this.requireAuscultation(deviceId)
    const client = await this.requireAirSonar(device)
    const before = await client.getSystem()
    const merged: Record<string, unknown> = { ...before, is_send_realtime_value: enabled ? 1 : 0 }

    let callbackUrl: string | undefined
    if (enabled) {
      const plan = defaultDeviceIngestPlan()
      plan.protocol = 'http'
      this.devices.update({ id: deviceId, ingest: plan })
      const endpoint = this.devices.ingestEndpoint(deviceId)
      const address = pickE2CallbackAddress(device.ip, endpoint.localAddresses)
      callbackUrl = httpPushUrl(address, endpoint.httpPort, endpoint.secret)
      merged.notify_url = callbackUrl
    }

    await client.putSystem(merged)
    const after = await client.getSystem()
    const notifyUrl = readString(after.notify_url)
    const flag = readInteger(after.is_send_realtime_value)
    const fields: E2RealtimeCallbackOutcome['fields'] = [
      ...(enabled ? [{ field: 'notifyUrl' as const, ok: notifyUrl === callbackUrl }] : []),
      { field: 'isSendRealtimeValue' as const, ok: flag === (enabled ? 1 : 0) }
    ]
    deviceLog().info('SN-16 realtime callback configured and read back', {
      deviceId,
      enabled,
      notifyUrl: notifyUrl === undefined ? '(none)' : sanitiseUrl(notifyUrl),
      fields: fields.map((entry) => `${entry.field}:${entry.ok ? 'ok' : 'mismatch'}`).join(',')
    })
    return {
      enabled,
      ...(callbackUrl !== undefined ? { callbackUrl } : {}),
      ...(notifyUrl !== undefined ? { notifyUrl } : {}),
      ...(flag !== undefined ? { isSendRealtimeValue: flag } : {}),
      fields,
      allApplied: fields.every((entry) => entry.ok)
    }
  }

  /** True when the URL targets one of this machine's addresses, the ingest HTTP port, and /api/v1/. */
  private pointsToLocalListener(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:') return false
      if (!parsed.pathname.startsWith('/api/v1/')) return false
      const wantedPort = parsed.port === '' ? 80 : Number(parsed.port)
      if (!Number.isInteger(wantedPort) || wantedPort !== this.getIngestConfig().httpPort) return false
      return this.listLocalAddresses().some((entry) => entry.address === parsed.hostname)
    } catch {
      return false
    }
  }

  /**
   * 与球机对时（`PUT /time_sync_with_nvt`）。
   *
   * 手册**只列了端点、没有写请求体**，所以这里发空对象，并把"设备接受了这次请求"与
   * 设备的原话一起交回界面 —— 界面上照实写"手册未说明请求体"，不假装知道它做了什么。
   */
  async syncTimeWithNvt(deviceId: string): Promise<E2NvtTimeSyncOutcome> {
    const device = this.requireAuscultation(deviceId)
    const client = await this.requireAirSonar(device)
    const result = await client.timeSyncWithNvt()
    return { accepted: result.status >= 200 && result.status < 300, note: result.text }
  }

  /**
   * 一条告警的**抓图**（业主 2026-09-17 第 8 批第 2 条）：本机磁盘上那几张图，经回环端点交给界面。
   *
   * 三种结果分开报（这是这一块最容易骗人的地方）：
   *   - `not-captured`：库里没有目录（`snapshot_dir IS NULL`）——设备上本来就没有图，或同步时
   *     没有打开抓图下载。**设备事实**；
   *   - `files-gone`：目录记着，但磁盘上一个图片文件都没有 —— 换过存储根目录、被手工清过。
   *     **本机事实**，与上一条完全不同；
   *   - `ok`：有几张就报几张（SN-16 手册说 3 张，实际不足是正常的：重启后可能只剩一部分）。
   *
   * 图片**不过 IPC**：返回的是回环地址（含每会话令牌），与本地录像回放同一条做法。
   */
  async alarmSnapshots(deviceId: string, alarmId: string): Promise<E2AlarmSnapshotView> {
    const device = this.requireAuscultation(deviceId)
    const alarm = this.alarms.findById(alarmId)
    if (!alarm || alarm.deviceId !== device.id) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '找不到这条告警（或它不属于这台设备）', alarmId)
    }
    const relativeDir = alarm.snapshotDir
    if (relativeDir === undefined || relativeDir === '') {
      return { state: 'not-captured', files: [] }
    }
    const directory = this.storage.resolve(relativeDir)
    let names: string[]
    try {
      names = (await readdir(directory)).filter((name) => SNAPSHOT_NAME.test(name)).sort()
    } catch {
      // 目录不在了（存储根换过、被清过）：与"设备上本来就没有图"必须分开说。
      return { state: 'files-gone', files: [], relativeDir }
    }
    if (names.length === 0) return { state: 'files-gone', files: [], relativeDir }

    // 上一组先关掉：端点与定时器都只该有一个。
    this.snapshotHandle?.close()
    this.snapshotHandle = null
    const handle = await this.files.serveImages(directory, names)
    this.snapshotHandle = handle
    return { state: 'ok', files: handle.files, relativeDir }
  }

  /** 关掉当前抓图端点（界面离开这一条告警时调用；TTL 兜底）。 */
  closeSnapshots(): void {
    this.snapshotHandle?.close()
    this.snapshotHandle = null
  }
}

/**
 * 抓图文件名：设备给的是 `1.jpg`…`3.jpg`（2023 版的时频谱图也是同一套数字名）。
 *
 * 只认"数字 + 图片扩展名"：目录里可能混着别的东西（`alarm.wav`、用户丢进来的文件），
 * 而"哪一张是设备的抓图"这件事必须有一个判据 —— 判据就是设备自己的命名规则。
 */
const SNAPSHOT_NAME = /^\d{1,3}\.(jpg|jpeg|png)$/i

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

/** Log a callback URL without the per-device secret. */
function sanitiseUrl(url: string): string {
  return url.replace(/(\/api\/v1\/)[^/]+/, '$1***')
}
