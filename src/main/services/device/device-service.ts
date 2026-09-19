/**
 * DeviceService — the single business entry point for device lifecycle
 * (spec 5.1, appendix C rule 4).
 *
 * Everything above this class (IPC handlers, and therefore the entire UI) is
 * forbidden from building a device URL or holding a session. That constraint is
 * what makes the future `RemoteDeviceRepository` swap a configuration change
 * rather than a refactor.
 *
 * Also owns the online-status monitor implementing spec 13.2:
 *   - light health check every N seconds (default 5 s)
 *   - a single timeout does NOT mark a device offline
 *   - three CONSECUTIVE failures flip it to OFFLINE
 *   - recovery flips it straight back to ONLINE and refreshes lastSeen
 */

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { AppError, ErrorCodes } from '@shared/errors'
import { now } from '@shared/utils/id'
import type {
  AddDeviceInput,
  Channel,
  Device,
  DeviceInfo,
  DeviceKind,
  DeviceStatusEvent,
  UpdateDeviceInput
} from '@shared/domain/models'
import type { MonitorState, ProbeResult } from '@shared/ipc/contract'
import { shouldMarkOffline } from '@shared/domain/device-status'
import type { StreamKind } from '@shared/domain/monitoring'
import { ConfigService } from './config-service'
import { normaliseBaseUrl } from './device-api-client'
import { applyNetworkChange, type NetworkChangeInput, type NetworkChangeResult } from './network-change'
import { readFile } from 'node:fs/promises'
import { SystemControlAction } from './protocol/dto'
import { toWebSocketUrl } from '../stream/websocket-stream'
import type { StreamManager, StreamManagerOptions } from '../stream/stream-manager'
import { appLog, deviceLog } from '../logging/logger'
import { DeviceApiClient } from './device-api-client'
import { Fa371ApiClient } from './fa371/fa371-api-client'
import { mapDetectLogs, mapVideoConfig } from './fa371/mappers'
import type { Fa371DetectLog, Fa371VideoConfig } from '@shared/domain/fa371'
import { cameraDeviceUid, cameraFallbackName, auscultationFallbackName, e2DeviceUid, e2FallbackUid } from './camera-identity'
import { E2Client } from './e2/e2-client'
import { AuthStrategyResolver } from './auth-resolver'
import { FetchHttpTransport, type HttpTransport } from './http-transport'
import type { CredentialStore } from './credential-store'
import {
  looksLikeHertzinnoDevice,
  mapChannels,
  mapDeviceInfo,
  mapSampleRate,
  type ChannelConfig
} from './protocol/mappers'
import type { DeviceRepository, ChannelRepository } from '../database/device-repository'
import { AUSCULTATION_CHANNEL_COUNT } from '../database/device-repository'
import { e2ChannelCountFromModel, type E2Variant } from '@shared/domain/e2'
import { parseInstallation } from '@shared/domain/device-installation'
import {
  MQTT_TELEMETRY_TOPIC,
  PUSH_SECRET_BYTES,
  defaultIotIngestConfig,
  pushSecretFromBytes,
  type DeviceIngestEndpoint,
  type IotIngestConfig,
  type IotIngestLocalAddress
} from '@shared/domain/iot-ingest'
import { listLocalAddresses } from '../ingest/local-addresses'

/**
 * 自动识别机型时试家系的顺序（业主 2026-09-17 第 2 条：添加设备不再让人选机型）。
 *
 * 顺序不是随意的：**先试端点数最少、判据最硬的那一家**。
 *   - 声纹设备（FA8）：一次认证解析 + 一次 `/get_devinfo`，身份来自设备自己；
 *   - 听诊盒子族（E2 / SN-16）：登录 + `/system` + 设备信息，身份来自 `equip_number`；
 *   - 声学相机（FA371）：登录 + 一次认证读，**它没有身份端点**（`identitySource: 'minted'`），
 *     所以放最后 —— 它最"宽容"，放在前面会把别的设备误判成相机。
 */
const AUTO_PROBE_ORDER: readonly DeviceKind[] = [
  'acousticBox',
  'auscultationBox',
  'acousticCamera'
]

/** 这一家的探活结果算不算"真的认出了这台设备"（见 `probe()` 的注释）。 */
function matchesFamily(kind: DeviceKind, result: ProbeResult): boolean {
  if (kind === 'acousticCamera') return result.reachable === true
  // 另外两家必须拿到**设备自己的身份**才算匹配：地址通了但没有身份，说明协议不对。
  return result.info !== undefined
}

/** 日志里用的中文家系名（**不进界面**：界面文案一律走四语言目录）。 */
function kindLabelForLog(kind: DeviceKind): string {
  if (kind === 'acousticCamera') return '声学相机'
  if (kind === 'auscultationBox') return '听诊盒子/空气声呐'
  return '声纹设备'
}

export interface DeviceServiceOptions {
  devices: DeviceRepository
  channels: ChannelRepository
  credentials: CredentialStore
  transport?: HttpTransport
  settings: () => {
    requestTimeoutMs: number
    healthCheckIntervalMs: number
    offlineFailureThreshold: number
    ringBufferSeconds: number
    preAlarmSeconds: number
    postAlarmSeconds: number
  }
  /**
   * Builds a StreamManager for a device.
   *
   * Injected rather than constructed here because a manager needs the storage
   * and recording services, and DeviceService must not depend on them — that
   * would invert the dependency direction and make the device layer untestable
   * without a filesystem.
   */
  createStreamManager?: (options: StreamManagerOptions) => StreamManager
  /**
   * IoT 接入配置（业主 2026-09-19 第 1 条）。
   *
   * 设备对话框要显示"设备该往哪个端口推"，而端口是设置里的一项。默认给出厂那一份
   * （接入关闭、8080 / 1883），这样测试里构造 `DeviceService` 不必先造一个设置服务。
   */
  getIngestConfig?: () => IotIngestConfig
  /**
   * 本机可用于设备的地址表。
   *
   * 注入口而不是在这里 `import os`：测试机器上有几张网卡、地址是什么，与"秘钥怎么生成、
   * 地址怎么拼"无关，而写死成真实网卡会让断言变成"跑在什么机器上"的函数。
   */
  listLocalAddresses?: () => IotIngestLocalAddress[]
}

/**
 * Consecutive-failure counter and live client per device.
 * The client is cached so a session (and the resolved auth strategy) survives
 * across calls instead of re-authenticating on every poll.
 */
interface DeviceRuntime {
  /** Acoustic box client. Never set for a camera, and vice versa: each family has
   *  its own protocol, and handing one's client to the other is a type error
   *  waiting to be a runtime error. */
  client?: DeviceApiClient
  /** FA371 acoustic camera client. */
  cameraClient?: Fa371ApiClient
  /**
   * 听诊盒子族（E2 / FA100 / FA110）的客户端。
   *
   * 它与其他两族不同的地方在于**会话在客户端里**：每个请求都要带
   * `Authorization: Bearer <token>`，而 token 是 `POST /login` 拿到的。所以缓存这个对象
   * 就等于缓存会话 —— 每调用一次 new 一个，就会每调用一次重新登录。
   */
  e2Client?: E2Client
  consecutiveFailures: number
  /** Last observed status, to detect transitions worth emitting. */
  lastStatus: Device['status']
  /**
   * 这个**进程**里是否亲眼见过它在线。
   *
   * 与 `lastStatus` 的区别很重要：`lastStatus` 是从数据库里读出来的，可能是一次
   * **上次会话**留下的 `ONLINE`。而"离线判定要不要等够失败次数"这件事取决于我们有没有
   * 真实证据说它刚才还在——见 `markFailed()`。
   */
  observedOnline: boolean
}

export class DeviceService extends EventEmitter {
  private readonly devices: DeviceRepository
  private readonly channels: ChannelRepository
  private readonly credentials: CredentialStore
  private readonly transport: HttpTransport
  private readonly getSettings: DeviceServiceOptions['settings']
  private readonly resolver: AuthStrategyResolver
  private readonly runtime = new Map<string, DeviceRuntime>()

  private monitorTimer?: NodeJS.Timeout
  private monitorRunning = false
  private disposed = false

  /**
   * Live realtime stream managers, keyed by device id.
   *
   * One per device rather than one global: the device streams a SINGLE channel
   * per WebSocket connection (verified — PROTOCOL-FINDINGS 4.3), so the socket
   * count scales with devices, and grouping them makes teardown per device
   * obvious.
   */
  private readonly streamManagers = new Map<string, StreamManager>()
  /**
   * Listeners bridging each manager's events onto this service.
   *
   * Kept so `stopMonitoring` can detach them. Without the pairing, a manager
   * would keep re-emitting into a disposed DeviceService after a stop, and the
   * trend writer would receive events for a device that is no longer streaming.
   */
  private readonly streamBridges = new Map<string, () => void>()
  private readonly createStreamManager?: (options: StreamManagerOptions) => StreamManager
  /** IoT 接入配置与地址表（见 `DeviceServiceOptions` 里那两项的说明）。 */
  private readonly getIngestConfig: () => IotIngestConfig
  private readonly listLocalAddresses: () => IotIngestLocalAddress[]

  constructor(options: DeviceServiceOptions) {
    super()
    this.devices = options.devices
    this.channels = options.channels
    this.credentials = options.credentials
    this.transport = options.transport ?? new FetchHttpTransport(options.settings().requestTimeoutMs)
    this.getSettings = options.settings
    if (options.createStreamManager) this.createStreamManager = options.createStreamManager
    this.getIngestConfig = options.getIngestConfig ?? defaultIotIngestConfig
    this.listLocalAddresses = options.listLocalAddresses ?? listLocalAddresses
    this.resolver = new AuthStrategyResolver(this.transport)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(): Device[] {
    return this.devices.list()
  }

  get(id: string): Device {
    const device = this.devices.findById(id)
    if (!device) throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备不存在: ${id}`)
    return device
  }

  getChannels(deviceId: string): Channel[] {
    return this.channels.listByDevice(deviceId)
  }

  findClient(deviceId: string): DeviceApiClient | undefined {
    return this.runtime.get(deviceId)?.client
  }

  // -------------------------------------------------------------------------
  // 推流秘钥（业主 2026-09-18 第 10 批第 5 条 / 2026-09-19 第 1 条）
  // -------------------------------------------------------------------------

  /**
   * 这台设备的推流端点：秘钥 + 本机候选地址 + 两个端口。
   *
   * **没秘钥就当场生成一条**（写库 + 读回核对，见 `DeviceRepository.setPushSecret`）。
   * 为什么是"读的时候生成"而不是"添加设备时生成"：
   *   - 秘钥只在这一个对话框里被需要，而"每台设备都有一条秘钥"会在库里留下一堆没人用过的
   *     凭据（现场 3 台设备、其中 2 台永远不会推数据）；
   *   - 生成是一条幂等的写（已经有就返回已有的），所以反复打开对话框不会换掉秘钥 ——
   *     那是最糟的行为：用户复制走一条、再打开一次发现变了。
   *
   * 返回的秘钥是**从库里读回来的**，不是刚生成的那个字面量。
   */
  ingestEndpoint(deviceId: string): DeviceIngestEndpoint {
    const device = this.get(deviceId)
    const existing = this.devices.getPushSecret(deviceId)
    const secret = existing ?? this.mintPushSecret(deviceId)
    return this.describeIngestEndpoint(device, secret)
  }

  /**
   * 换一条秘钥（**旧的立刻失效**）。
   *
   * 轮换的意义是把一条已经泄漏（截图、贴进邮件）的秘钥作废，所以它必须真的换一个新的、
   * 而且**不能**碰巧生成同一条 —— 概率上不可能，但读回核对的返回值就是证据。
   */
  rotatePushSecret(deviceId: string): DeviceIngestEndpoint {
    const device = this.get(deviceId)
    const secret = this.mintPushSecret(deviceId)
    return this.describeIngestEndpoint(device, secret)
  }

  private mintPushSecret(deviceId: string): string {
    // 16 字节随机数（`pushSecretFromBytes` 转成 32 位小写十六进制）。`randomBytes` 是
    // 密码学安全的：这条秘钥是**唯一**的凭据，`Math.random()` 在这里是不合格的。
    const stored = this.devices.setPushSecret(
      deviceId,
      pushSecretFromBytes(randomBytes(PUSH_SECRET_BYTES))
    )
    if (!stored) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '生成推流秘钥失败：设备不存在', deviceId)
    }
    return stored
  }

  private describeIngestEndpoint(device: Device, secret: string): DeviceIngestEndpoint {
    const config = this.getIngestConfig()
    return {
      deviceId: device.id,
      deviceName: device.name,
      secret,
      serviceEnabled: config.enabled,
      httpEnabled: config.httpEnabled,
      httpPort: config.httpPort,
      mqttEnabled: config.mqttEnabled,
      mqttPort: config.mqttPort,
      mqttTopic: MQTT_TELEMETRY_TOPIC,
      localAddresses: this.listLocalAddresses()
    }
  }
  /**
   * 已经有推流秘钥的设备台数（设置页那张接入卡片显示它）。
   *
   * 单独一个方法而不是把仓库挂到 `AppServices` 上：那一个数字的语义是"接过几台设备"，
   * 而界面除此之外不需要 `devices` 表的任何东西。
   */
  countIngestSecrets(): number {
    return this.devices.countWithPushSecret()
  }

  // -------------------------------------------------------------------------
  // Client construction
  // -------------------------------------------------------------------------

  /**
   * Build (or reuse) an API client for a stored device.
   * Credentials are fetched from the OS-encrypted store on demand and never
   * held in a field of this service beyond the client's own lifetime.
   */
  private clientFor(device: Device): DeviceApiClient {
    const existing = this.runtime.get(device.id)
    if (existing?.client && existing.client.currentBaseUrl === this.baseUrlFor(device)) {
      return existing.client
    }

    const credential = this.credentials.get(device.id)
    if (!credential) {
      throw new AppError(
        ErrorCodes.AUTH_FAILED,
        '未找到该设备的登录凭据，请重新添加设备',
        device.id
      )
    }

    const client = new DeviceApiClient({
      transport: this.transport,
      resolver: this.resolver,
      baseUrl: this.baseUrlFor(device),
      credential,
      ...(this.devices.getAuthStrategy(device.id)
        ? { preferredStrategyId: this.devices.getAuthStrategy(device.id) as string }
        : {}),
      timeoutMs: this.getSettings().requestTimeoutMs,
      // Persist the discovered carrier so the next start skips the probe.
      onSessionEstablished: (strategyId) => {
        try {
          this.devices.setAuthStrategy(device.id, strategyId)
        } catch (error) {
          deviceLog().warn('Failed to persist auth strategy', {
            deviceId: device.id,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })

    this.setRuntime(device.id, {
      ...(existing ?? { consecutiveFailures: 0, lastStatus: device.status, observedOnline: false }),
      client
    })
    return client
  }

  private baseUrlFor(device: Device): string {
    if (device.connectionType !== 'LAN') {
      throw new AppError(
        ErrorCodes.NOT_IMPLEMENTED,
        '远程（Server）模式尚未实现，V1 仅支持局域网设备'
      )
    }
    if (!device.ip) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备未配置 IP 地址', device.id)
    }
    return `${device.ip}${device.httpPort ? `:${device.httpPort}` : ''}`
  }

  private setRuntime(deviceId: string, runtime: DeviceRuntime): void {
    this.runtime.set(deviceId, runtime)
  }

  private runtimeFor(deviceId: string, status: Device['status']): DeviceRuntime {
    const existing = this.runtime.get(deviceId)
    if (existing) return existing
    // `observedOnline: false` —— 刚建出来的运行时还没有任何本进程的观察。数据库里那个
    // `status` 可能是一次旧会话留下的 `ONLINE`，它是**历史**，不是"它刚才还在"。
    const created: DeviceRuntime = {
      consecutiveFailures: 0,
      lastStatus: status,
      observedOnline: false
    }
    this.runtime.set(deviceId, created)
    return created
  }

  // -------------------------------------------------------------------------
  // Probe (used by "Add device" before anything is persisted)
  // -------------------------------------------------------------------------

  /**
   * Verify an address really is a HERTZINNO device and resolve auth, WITHOUT
   * writing anything. This is what lets the Add Device dialog say
   * "this device is already registered at a different IP" before committing.
   *
   * **`kind` 可以不给**（业主 2026-09-17 第 2 条：添加设备不再让人选机型）：
   * 不给就按 `AUTO_PROBE_ORDER` 逐个家系试，返回第一个**真的认得出这台设备**的结果，
   * `result.kind` 说明它匹配到了哪一家。
   *
   * 判"匹配"的标准是**该家系自己的身份证据**，不是"有东西回应"：
   *   - 声纹设备（FA8）：`/get_devinfo` 里能映射出 `deviceUid`（`info` 非空）；
   *   - 听诊盒子族（E2 / SN-16）：登录 + `/system` + 设备信息读通（`info` 非空）；
   *   - 声学相机（FA371）：登录 + 一次认证读成功（它没有身份端点，`identitySource: 'minted'`）。
   * 三家都失败就把三句失败原因**一起**报出来 —— "自动识别失败"四个字对排查毫无用处，
   * 而三句原因能立刻区分"地址不通"与"协议不对"。
   */
  async probe(input: Omit<AddDeviceInput, 'name'>): Promise<ProbeResult> {
    if (input.kind !== undefined) return this.probeForKind(input.kind, input)

    const failures: string[] = []
    for (const kind of AUTO_PROBE_ORDER) {
      try {
        const result = await this.probeForKind(kind, input)
        if (matchesFamily(kind, result)) return { ...result, kind }
        failures.push(`${kindLabelForLog(kind)}：有响应但不符合该机型的身份特征`)
      } catch (error) {
        failures.push(`${kindLabelForLog(kind)}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new AppError(
      ErrorCodes.DEVICE_ERROR,
      `自动识别机型失败（三种协议都试过了）：${failures.join('；')}`
    )
  }

  /** 按指定家系探活（`probe()` 的"人工指定"分支与自动识别的每一步都走它）。 */
  private async probeForKind(
    kind: DeviceKind,
    input: Omit<AddDeviceInput, 'name'>
  ): Promise<ProbeResult> {
    if (kind === 'acousticCamera') return this.probeCamera(input)
    if (kind === 'auscultationBox') return this.probeAuscultation(input)
    return this.probeAcousticBox(input)
  }

  /** 声纹设备（FA8）的探活：解析认证策略 → `/get_devinfo` → 身份。 */
  private async probeAcousticBox(input: Omit<AddDeviceInput, 'name'>): Promise<ProbeResult> {
    const timeoutMs = this.getSettings().requestTimeoutMs
    // MUST be a full URL: the auth resolver and the HTTP transport both need a
    // scheme, and `normaliseAddress` alone yields a bare `host:port`. Passing the
    // bare form made every "test connection" / "add device" attempt fail with
    // "无法连接到设备", which reads like a network fault rather than a bug.
    const baseUrl = normaliseBaseUrl(normaliseAddress(input.ip, input.httpPort))

    const credential = { username: input.username, password: input.password }
    const started = Date.now()

    const resolution = await this.resolver.resolve({ baseUrl, credential, timeoutMs })
    const client = new DeviceApiClient({
      transport: this.transport,
      resolver: this.resolver,
      baseUrl,
      credential,
      preferredStrategyId: resolution.strategy.id,
      timeoutMs
    })
    client.adoptSession(resolution.session, resolution.strategy)

    const latencyMs = Date.now() - started
    const raw = await client.getDeviceInfo()

    if (!looksLikeHertzinnoDevice(raw)) {
      return { reachable: true, alreadyRegistered: false }
    }

    const info = mapDeviceInfo(raw)
    if (!info) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        '设备响应中缺少可用的设备标识（Device ID / SN / MAC）'
      )
    }

    const existing = this.devices.findByUid(info.deviceUid)

    return {
      reachable: true,
      info,
      latencyMs,
      authStrategy: resolution.strategy.id,
      alreadyRegistered: existing !== undefined,
      ...(existing ? { existingDeviceId: existing.id } : {})
    }
  }

  // -------------------------------------------------------------------------
  // Add / update / remove (spec 6.2)
  // -------------------------------------------------------------------------

  /**
   * Probe an FA371 acoustic camera.
   *
   * DIFFERENT FROM A BOX IN TWO WAYS THAT MATTER
   *  1. "Is it there and are the credentials good" cannot be answered with one
   *     call: `/login` returning a token proves the password, but not that the
   *     token is accepted anywhere. So the client logs in AND performs one cheap
   *     authenticated read (`GET /system/detect_status`), which is the only thing
   *     that proves the session actually works. Getting this wrong is how you end
   *     up "connected" to a device that 401s on every real request.
   *  2. There is no identity to fetch, so `alreadyRegistered` is decided by the
   *     MINTED address uid (see camera-identity.ts). The result says so, via
   *     `identitySource`, rather than pretending the device identified itself.
   */
  private async probeCamera(input: Omit<AddDeviceInput, 'name'>): Promise<ProbeResult> {
    const timeoutMs = this.getSettings().requestTimeoutMs
    const baseUrl = normaliseBaseUrl(normaliseAddress(input.ip, input.httpPort))
    const credential = { username: input.username, password: input.password }
    const started = Date.now()

    const client = new Fa371ApiClient({ transport: this.transport, baseUrl, credential, timeoutMs })
    await client.ensureSession()
    await client.getDetectStatus()

    const latencyMs = Date.now() - started
    const deviceUid = cameraDeviceUid(input.ip, input.httpPort)
    const existing = this.devices.findByUid(deviceUid)
    const strategyId = client.resolvedStrategyId

    return {
      reachable: true,
      kind: 'acousticCamera',
      identitySource: 'minted',
      alreadyRegistered: existing !== undefined,
      latencyMs,
      ...(existing ? { existingDeviceId: existing.id } : {}),
      ...(strategyId ? { authStrategy: strategyId } : {})
    }
  }

  /**
   * Probe an auscultation box (E2 / FA100 / FA110).
   *
   * 与相机同样的两点理由（"登录成功"不等于"会话可用"），但**身份来源不同**：
   * 这一族有 `GET /basic`，其中的 `equip_number`（手册："Device identifier code, not
   * modifiable"）就是设备自己的标识。有它就用它做 uid —— 那样换 IP 之后仍然是同一台设备；
   * 没有（固件没填）才退回到按地址编一个，并且**在结果里说明**（`identitySource`）。
   */
  private async probeAuscultation(input: Omit<AddDeviceInput, 'name'>): Promise<ProbeResult> {
    const timeoutMs = this.getSettings().requestTimeoutMs
    const baseUrl = normaliseBaseUrl(normaliseAddress(input.ip, input.httpPort))
    const started = Date.now()

    const client = new E2Client({
      transport: this.transport,
      baseUrl,
      credentials: { username: input.username, password: input.password },
      timeoutMs
    })
    // 登录 + 一次**真的**认证读：`/login` 回了 token 只证明口令对，
    // 只有带上 token 读一次才能证明会话可用（与 `probeCamera` 同一条教训）。
    await client.login()
    /*
     * **先判代次，再读设备信息**（2026-09-17 真机验证发现的缺陷）。
     *
     * 这一族有两代，而设备信息端点是**按代次不同**的：2023 版是 `GET /basic`，
     * SN-16 空气声呐（手册里的 Air Sonar V3.2）是 `GET /get_device_basic_params`。
     * `getBasic()` 按 `this.variant` 取路径，而变体只有读过 `/system` 才知道 ——
     * 所以原来"直接 getBasic()"在一台 SN-16 上会去打 `/basic`、吃一个 404、
     * 探活失败，表现是**这台设备根本加不进来**（而登录明明成功了，看起来像权限/口令问题）。
     *
     * `ensureVariant()` 读的 `/system` 两代都有，读不到就保持 `undefined`（按文档最全的
     * 那一代取端点）；那时 404 会照实报出来，而不是被伪装成"设备离线"。
     */
    await client.ensureVariant()
    const basic = await client.getBasic()

    const latencyMs = Date.now() - started
    const equipNumber = basic.equipNumber?.trim()
    const identitySource: 'device' | 'minted' = equipNumber ? 'device' : 'minted'
    const deviceUid = equipNumber ? e2DeviceUid(equipNumber) : e2FallbackUid(input.ip, input.httpPort)
    const existing = this.devices.findByUid(deviceUid)
    const name = basic.devName?.trim()
    /*
     * 名字可以是空的，**身份不能跟着一起丢**（2026-09-17 真机验证）。
     *
     * 这台 SN-16 的 `dev_name` 就是空字符串（设备没起名）。第一版把整个 `info` 挂在
     * `name ? … : {}` 上，于是：`info` 为 `null` → 添加对话框里没有设备名也没有通道数，
     * 而且**身份退回了按地址编的 `e2ip:…`**，尽管设备明明给了 `equip_number`。
     * 一台设备换 IP 之后就变成"另一台"，这是身份模型最不该出的错。
     * 所以 `info` 总是给，名字缺席就不带 `name` 字段。
     *
     * 通道数：**设备型号能说的就听设备的**（`AS16` / `SN-16` /
     * `AS16-auth-vertical-reverse` ⇒ 16），说不出来才是这一族的产品事实
     * （`AUSCULTATION_CHANNEL_COUNT` = 1）。原来这里恒等于 1，于是一台 16 通道的 SN-16
     * 在添加对话框里显示"通道数 1"、而同一条设备的详情页显示 16 —— 同一条事实两个答案。
     */
    const info: NonNullable<ProbeResult['info']> = {
      deviceUid,
      // `name` 在这个形状里是必填的，而设备可能没起名 —— 那就交空串（"设备没给"），
      // 由界面显示它的兜底名；**不拿地址去冒充设备名**。
      name: name ?? '',
      channelCount: e2ChannelCountFromModel(basic.devType) ?? AUSCULTATION_CHANNEL_COUNT
    }
    if (basic.devVersion) info.firmwareVersion = basic.devVersion
    if (basic.webVersion) info.webVersion = basic.webVersion

    return {
      reachable: true,
      kind: 'auscultationBox',
      identitySource,
      alreadyRegistered: existing !== undefined,
      latencyMs,
      ...(existing ? { existingDeviceId: existing.id } : {}),
      // 代次是探活**顺手**读到的（判代次是读设备信息的前置步骤），交给上层落库。
      ...(client.resolvedVariant ? { e2Variant: client.resolvedVariant } : {}),
      info
    }
  }

  /** Persist an auscultation box, storing its credentials under the local device id. */
  private async addAuscultation(input: AddDeviceInput): Promise<Device> {
    const probe = await this.probeAuscultation({
      ip: input.ip,
      httpPort: input.httpPort,
      username: input.username,
      password: input.password,
      kind: 'auscultationBox'
    })

    // 身份：**优先设备自己给的** `equip_number`；探针里已经算过一遍，这里按同一个规则重算
    // （探针不写库，所以 uid 得在这一步重新确定，不能从 `probe.info` 里"猜"回来）。
    const deviceUid =
      probe.identitySource === 'device' && probe.info
        ? probe.info.deviceUid
        : e2FallbackUid(input.ip, input.httpPort)

    const { device, created } = this.devices.upsertAuscultation(input, {
      deviceUid,
      name: input.name?.trim() || probe.info?.name || auscultationFallbackName(input.ip),
      ...(probe.info?.firmwareVersion ? { firmwareVersion: probe.info.firmwareVersion } : {}),
      ...(probe.info?.webVersion ? { webVersion: probe.info.webVersion } : {}),
      /*
       * 通道行的条数跟着设备回话走（16 通道的 SN-16 就该有 16 行）。探针已经算好了这个数
       * （`e2ChannelCountFromModel(dev_type)`，算不出来才是 1），不传的话设备表会显示 1 路，
       * 而同一台设备的详情页显示 16 —— 同一条事实两个答案。
       */
      ...(probe.info?.channelCount !== undefined ? { channelCount: probe.info.channelCount } : {})
    })

    this.credentials.set(device.id, { username: input.username, password: input.password })

    /*
     * 代次**在添加时就落库**（v12）：界面给不给「PTZ 联动」页签取决于它，而等到第一次读状态
     * 才知道答案的话，一台刚加进来的 SN-16 会先显示成 2023 版那一组页签。
     * 写完之后读回核对（业主的硬规矩）：不一致时记日志，但不让"添加设备"失败 ——
     * 那一步已经成功了，代次记错只影响页签。
     */
    if (probe.e2Variant !== undefined) {
      const readBack = this.devices.updateE2Variant(device.id, probe.e2Variant)
      if (readBack !== probe.e2Variant) {
        deviceLog().warn('听诊盒子代次写库后读回不一致', {
          deviceId: device.id,
          wrote: probe.e2Variant,
          readBack: String(readBack)
        })
      }
    }

    this.emit('changed')
    deviceLog().info(created ? 'Auscultation box added' : 'Auscultation box address updated', {
      deviceId: device.id,
      deviceUid,
      ip: input.ip,
      identitySource: probe.identitySource
    })

    return this.get(device.id)
  }

  /** Persist a camera, storing its credentials under the local device id. */
  private async addCamera(input: AddDeviceInput): Promise<Device> {
    const probe = await this.probeCamera({
      ip: input.ip,
      httpPort: input.httpPort,
      username: input.username,
      password: input.password,
      kind: 'acousticCamera'
    })

    const deviceUid = cameraDeviceUid(input.ip, input.httpPort)
    const { device, created } = this.devices.upsertCamera(input, {
      deviceUid,
      name: input.name?.trim() || cameraFallbackName(input.ip)
    })

    this.credentials.set(device.id, { username: input.username, password: input.password })

    // Remember which carrier the camera accepted, so the next start skips the
    // probe. Best effort: a failure here costs one extra login, nothing more.
    if (probe.authStrategy) {
      try {
        this.devices.setAuthStrategy(device.id, probe.authStrategy)
      } catch (error) {
        deviceLog().warn('Failed to persist camera auth strategy', {
          deviceId: device.id,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    this.emit('changed')
    deviceLog().info(created ? 'Acoustic camera added' : 'Acoustic camera address updated', {
      deviceId: device.id,
      deviceUid,
      ip: input.ip,
      authStrategy: probe.authStrategy
    })

    return this.get(device.id)
  }

  /**
   * Add a device.
   *
   * Flow from spec 6.2: login -> get_devinfo -> de-duplicate by identity ->
   * persist -> start status monitoring. Step 4 is the subtle one: a device that
   * already exists is UPDATED, never inserted twice, because its identity is
   * the device uid and not the IP.
   */
  async add(input: AddDeviceInput): Promise<Device> {
    validateAddInput(input)

    /*
     * 没给机型就**自动识别**（业主 2026-09-17 第 2 条）。识别走的就是 `probe()`，
     * 所以"添加"与"测试连接"用的是同一套判据 —— 两处各写一套判据迟早会不一致。
     */
    let kind: DeviceKind = input.kind ?? 'acousticBox'
    if (input.kind === undefined) {
      const detected = await this.probe({
        ip: input.ip,
        httpPort: input.httpPort,
        username: input.username,
        password: input.password
      })
      kind = detected.kind ?? 'acousticBox'
      deviceLog().info('添加设备：自动识别到机型', { ip: input.ip, kind })
    }
    const resolved: AddDeviceInput = { ...input, kind }

    if (kind === 'acousticCamera') return this.addCamera(resolved)
    if (kind === 'auscultationBox') return this.addAuscultation(resolved)

    const probe = await this.probe({
      ip: input.ip,
      httpPort: input.httpPort,
      username: input.username,
      password: input.password,
      kind: 'acousticBox'
    })

    if (!probe.info) {
      throw new AppError(
        ErrorCodes.INVALID_RESPONSE,
        '目标地址响应但不符合 HERTZINNO 设备结构，可能不是 Acoustic Box 设备'
      )
    }

    const { device, created } = this.devices.upsertByIdentity(input, probe.info)

    // Credentials live in the OS keyring, keyed by the LOCAL device id, so they
    // can only be stored after the row exists (spec 14.1).
    this.credentials.set(device.id, { username: input.username, password: input.password })

    // Seed/refresh the channel list from the device rather than assuming 8.
    await this.refreshChannels(device.id).catch((error) => {
      deviceLog().warn('Channel refresh during add failed; seeded defaults kept', {
        deviceId: device.id,
        reason: error instanceof Error ? error.message : String(error)
      })
    })

    this.emit('changed')
    deviceLog().info(created ? 'Device added' : 'Device address updated (existing identity)', {
      deviceId: device.id,
      deviceUid: probe.info.deviceUid,
      ip: input.ip,
      authStrategy: probe.authStrategy
    })

    return this.get(device.id)
  }

  update(input: UpdateDeviceInput): Device {
    /*
     * 安装信息在**写库之前**过一遍与界面同一套判据（`parseInstallation()`）：
     * IPC 是能被直接调用的，把范围校验只放在界面上等于没有校验。
     */
    let resolved = input
    if (input.installation !== undefined) {
      const parsed = parseInstallation(input.installation)
      if (!parsed.ok) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `安装信息不合法：${parsed.reasonKey ?? 'unknown'}`
        )
      }
      resolved = { ...input, installation: { ...input.installation } }
    }
    /*
     * 凭据（业主 2026-09-18 第 10 条）：用户名与密码都能改，**省略 = 不动**。
     *
     * 三条判断：
     *   1. 用户名给了就必须非空（设备侧没有匿名账号）；空串按"没给"处理，理由与
     *      `UpdateDeviceInput.username` 的注释同一条；
     *   2. 密码只在**给了非空**时覆盖 —— 界面从不回显口令，空框必须读成"不改"，
     *      否则改一次端口就会把口令清掉；
     *   3. 凭据变了**必须丢掉这个设备的运行时客户端**（`runtime` 里那一个拿着旧 token 的
     *      会话）：不丢的话，后面的请求会继续用旧凭据，界面显示"改成功了"而设备侧
     *      看到的还是旧账号 —— 那是本仓库最不能接受的那种"界面说假话"。
     */
    const nextUsername = input.username?.trim()
    const nextPassword = input.password
    const wantsCredentialChange =
      (nextUsername !== undefined && nextUsername !== '') ||
      (nextPassword !== undefined && nextPassword !== '')
    if (wantsCredentialChange) {
      const current = this.credentials.get(input.id)
      if (!current) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备不存在或没有凭据: ${input.id}`)
      }
      this.credentials.set(input.id, {
        username: nextUsername === undefined || nextUsername === '' ? current.username : nextUsername,
        password: nextPassword === undefined || nextPassword === '' ? current.password : nextPassword
      })
      this.runtime.delete(input.id)
      deviceLog().info('Device credentials updated', {
        deviceId: input.id,
        usernameChanged: nextUsername !== undefined && nextUsername !== '' && nextUsername !== current.username,
        passwordChanged: nextPassword !== undefined && nextPassword !== ''
      })
    }
    const updated = this.devices.update(resolved)
    if (!updated) throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备不存在: ${input.id}`)
    // A changed address invalidates the cached client.
    this.runtime.delete(input.id)
    this.emit('changed')
    return updated
  }

  remove(id: string): void {
    this.runtime.delete(id)
    this.credentials.delete(id)
    const removed = this.devices.remove(id)
    if (!removed) throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备不存在: ${id}`)
    this.emit('changed')
    appLog().info('Device removed', { deviceId: id })
  }

  // -------------------------------------------------------------------------
  // Device reads
  // -------------------------------------------------------------------------

  async getInfo(id: string): Promise<DeviceInfo> {
    const device = this.get(id)
    if (device.kind === 'acousticCamera') return this.syntheticCameraInfo(device)
    if (device.kind === 'auscultationBox') return this.auscultationInfo(device)
    const raw = await this.withStatusTracking(device, () => this.clientFor(device).getDeviceInfo())
    const info = mapDeviceInfo(raw)
    if (!info) {
      throw new AppError(ErrorCodes.INVALID_RESPONSE, '设备信息中缺少设备标识')
    }
    this.devices.updateInfo(id, info)
    return info
  }

  /**
   * What "device info" means for a camera, which has no endpoint for it.
   *
   * Synthesised from the LOCAL row rather than fetched, and deliberately so: the
   * FA371 documents 32 open-interface endpoints and none of them returns identity
   * or version (`docs/reference/FA371-api-spec.md` §6). Calling `/get_devinfo` on
   * it — which is what the shared code would otherwise do — returns 404 and is
   * then reported as the device being offline, the most misleading symptom
   * available. `channelCount: 0` is a fact about the product, not a placeholder.
   */
  private syntheticCameraInfo(device: Device): DeviceInfo {
    const info: DeviceInfo = {
      deviceUid: device.deviceUid,
      name: device.name,
      channelCount: 0
    }
    if (device.mac) info.mac = device.mac
    if (device.firmwareVersion) info.firmwareVersion = device.firmwareVersion
    return info
  }

  /**
   * 听诊盒子的设备信息：**真的读**（不像相机那样只能编）。
   *
   * `GET /basic`（SN-16 空气声呐是 `GET /get_device_basic_params`）给 `dev_name` /
   * `dev_type` / `dev_version` / `upgrade_time` / `web_version` / `equip_number`，
   * 所以这里的每个字段都有出处。
   *
   * 通道数按**同一套规则**取：型号串能说就说（`AS16` / `SN-16` ⇒ 16），说不出来才是这一族的
   * 产品事实（1）。2026-09-17 改：原来这里恒等于 1，而 `/system` 那条详情（`E2DeviceService`）
   * 是按型号串算的 —— 同一条事实两个答案（探针里实测到"添加对话框 1 / 详情页 16"）。
   *
   * 一个诚实的空缺：这一族**没有** FPGA 版本字段，所以 `fpgaVersion` 不填 —— 不拿 web_version 顶替。
   */
  private async auscultationInfo(device: Device): Promise<DeviceInfo> {
    const basic = await this.withStatusTracking(device, () =>
      this.e2ClientFor(device).getBasic({ timeoutMs: this.getSettings().requestTimeoutMs })
    )
    const info: DeviceInfo = {
      deviceUid: device.deviceUid,
      name: basic.devName?.trim() || device.name,
      channelCount: e2ChannelCountFromModel(basic.devType) ?? AUSCULTATION_CHANNEL_COUNT
    }
    if (basic.devVersion) info.firmwareVersion = basic.devVersion
    if (basic.webVersion) info.webVersion = basic.webVersion
    // 设备自己报了名字就顺手把本地行刷新一遍（与 FA8 的 `updateInfo` 同一条行为）。
    this.devices.updateInfo(device.id, info)
    return info
  }

  /** Refresh the cached channel rows from GET /get_passageway (spec 11.1). */
  async refreshChannels(id: string): Promise<Channel[]> {
    const device = this.get(id)
    // A camera exposes no channel list at all; the box's endpoint does not exist
    // on it. Returning the (empty) local rows is the truthful answer.
    if (device.kind === 'acousticCamera') return this.channels.listByDevice(id)
    /**
     * 听诊盒子也没有通道**接口** —— 但它**有**通道（协议就是单通道）。所以这里不去问设备
     * （`/get_passageway` 在那台设备上不存在，问了就是 404 → 被当成离线），而是把本地那一条
     * 通道行读回来。行是 `upsertAuscultation` 建出来的，所以"读回来"与"设备有一路"是一致的。
     */
    if (device.kind === 'auscultationBox') return this.channels.listByDevice(id)
    const raw = await this.withStatusTracking(device, () => this.clientFor(device).getPassageway())
    const configs: ChannelConfig[] = mapChannels(raw)
    if (configs.length === 0) return this.channels.listByDevice(id)

    // replaceForDevice uses ON CONFLICT (device_id, channel_index), so local
    // rows — and any alarm_profile_id links on them — survive the refresh.
    return this.channels.replaceForDevice(id, configs)
  }

  async getSampleRate(id: string): Promise<number> {
    const device = this.get(id)
    const raw = await this.withStatusTracking(device, () => this.clientFor(device).getSamplingRate())
    const rate = mapSampleRate(raw)
    if (rate === undefined) {
      throw new AppError(ErrorCodes.INVALID_RESPONSE, '无法解析设备采样率')
    }
    return rate
  }

  /**
   * `GET /system/video` for a CAMERA (manual §5.1.6).
   *
   * Public and camera-only because the RTSP address used for live video can ONLY be
   * assembled from this response (`video_port` + `video_url`), and the live-view
   * service must not build a second FA371 client to read it — `cameraClientFor`
   * already owns the credential lookup, the persisted auth strategy and the runtime
   * cache, and a second client would both re-login and lose the resolved token
   * carrier.
   *
   * A BOX never reaches here: `clientFor` builds `DeviceApiClient` for boxes, whose
   * `/system/video` does not exist, so the kind is checked rather than guessed.
   */
  async getCameraVideoConfig(deviceId: string): Promise<Fa371VideoConfig> {
    const device = this.get(deviceId)
    if (device.kind !== 'acousticCamera') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '该设备不是声学相机，没有视频与 RTSP 配置',
        deviceId
      )
    }
    const raw = await this.withStatusTracking(device, () =>
      this.cameraClientFor(device).getVideoConfig()
    )
    return mapVideoConfig(raw)
  }

  // -------------------------------------------------------------------------
  // Configuration (Phase 9)
  // -------------------------------------------------------------------------

  /**
   * 相机告警模型（§5.1.22–§5.1.29）所需的 FA371 客户端。
   *
   * 与 `getCameraVideoConfig` 同样只对相机开放，并且复用 `cameraClientFor`：
   * 凭据、已持久化的认证方式、运行时缓存都在那里，另建一个客户端只会重复登录。
   * 这里**不**额外做一次探活——调用本身就会懒登录（`Fa371ApiClient.call()` 内
   * 会 `ensureSession()`），再插一次心跳只会让每次打开对话框多一个来回。
   */
  cameraAlarmOperations(deviceId: string): Fa371ApiClient {
    const device = this.get(deviceId)
    if (device.kind !== 'acousticCamera') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '该设备不是声学相机，没有告警策略与告警条件',
        deviceId
      )
    }
    return this.cameraClientFor(device)
  }

  /**
   * 相机**维护**（固件升级 / 重启）所需的 FA371 客户端。
   *
   * 与 `cameraAlarmOperations` 同一条路径、同一个理由（凭据、已持久化的认证方式、
   * 运行时缓存都在 `cameraClientFor` 里），只换一句错误说明：升级与重启跟"告警策略"
   * 没有关系，拿错消息排查会绕远路。
   *
   * 升级服务只从它这里取**基地址与已认证的请求头**：上传本身要流式发送，走
   * `node:http`（见 `camera-upgrade-service.ts` 文件头规则 2），但它必须与其它通道
   * 共用同一份会话，否则同一台相机会被登录两次。
   */
  cameraMaintenanceOperations(deviceId: string): Fa371ApiClient {
    const device = this.get(deviceId)
    if (device.kind !== 'acousticCamera') {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '该设备不是声学相机，没有固件升级与重启接口',
        deviceId
      )
    }
    return this.cameraClientFor(device)
  }

  /**
   * 读一批检测日志（手册 §5.1.17），映射成域模型。
   *
   * 为什么放在 `DeviceService` 而不是让告警联动服务自己建客户端：与
   * `cameraAlarmOperations` 同样的理由——凭据、已持久化的认证方式、运行时
   * 缓存都在 `cameraClientFor` 里。告警联动每分钟要读一次，另建一个客户端会
   * 变成第二次认证探测加第二份会话状态。
   *
   * `detect_id` 固定传 `1`：手册 §5.1.17 说这个参数是 non-essential、
   * 默认值就是 `1`，而设备实测返回的是**整批**日志
   * （`{"detect_logs":[],"logs_count":0}`）——按 id 过滤的行为至今没有样本，
   * 所以这里不去猜一个"取全部"的取值，用文档默认值。
   *
   * 时间戳单位刻意**不假设**（§8.2 B5）：`mapDetectLogs` 只产出 `*Raw`，
   * 于是事件身份里的 `startTime` 永远是设备原样的值，轮询与 WebSocket
   * 两个源因此必然拼出同一个身份。
   */
  async cameraDetectLogs(deviceId: string): Promise<Fa371DetectLog[]> {
    const device = this.get(deviceId)
    if (device.kind !== 'acousticCamera') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '该设备不是声学相机，没有检测日志', deviceId)
    }
    const raw = await this.withStatusTracking(device, () =>
      this.cameraClientFor(device).getDetectLogs(1)
    )
    return mapDetectLogs(raw)
  }

  /**
   * A ConfigService bound to a live session for this device.
   *
   * Constructed per call rather than cached because it wraps a specific client,
   * and a client is discarded whenever the address changes. Caching one would
   * leave it holding a stale client after a network reconfiguration.
   */
  async configFor(deviceId: string): Promise<ConfigService> {
    const device = this.get(deviceId)
    const client = this.clientFor(device)
    await this.withStatusTracking(device, () => client.getDeviceInfo())
    return new ConfigService(client)
  }

  /**
   * Apply a network change with reconnection and rollback.
   *
   * Delegates to `applyNetworkChange`, which owns the transaction. This wrapper
   * exists so the persistence layer learns the device's new address: without
   * that, the next app start would try the OLD address from SQLite and report a
   * working device as offline.
   */
  async changeNetwork(deviceId: string, input: NetworkChangeInput): Promise<NetworkChangeResult> {
    const device = this.get(deviceId)
    const client = this.clientFor(device)
    const config = new ConfigService(client)

    const result = await applyNetworkChange(client, () => config.getNetwork(), input)

    if (result.success || result.rolledBack === false) {
      // Record where the device actually is now, even on a partial failure:
      // the UI needs to show the truth, and a later refresh will reconcile it.
      const nextIp = extractHost(result.address)
      if (nextIp && nextIp !== device.ip) {
        this.devices.update({ id: deviceId, ip: nextIp })
        // The cached client belongs to the old address and must not be reused.
        this.runtime.delete(deviceId)
        appLog().info('Device address updated after a network change', {
          deviceId,
          from: device.ip,
          to: nextIp
        })
      }
    }

    this.emit('changed')
    return result
  }

  // -------------------------------------------------------------------------
  // Maintenance (Phase 10)
  // -------------------------------------------------------------------------

  /**
   * Reboot, factory reset or start a system upgrade.
   *
   * The UI owns the confirmation guard; this method only performs the action and
   * records it. After a reset or reboot the device invalidates the session, so
   * the cached client is dropped rather than reused with a dead token.
   */
  async systemControl(
    deviceId: string,
    action: (typeof SystemControlAction)[keyof typeof SystemControlAction]
  ): Promise<void> {
    const device = this.get(deviceId)
    const client = this.clientFor(device)

    appLog().warn('Destructive device operation requested', {
      deviceId,
      ip: device.ip,
      action
    })

    await client.systemControl(action)

    // The device clears its session for reset and reboot, so the cached token is
    // stale by definition. Dropping the client forces a clean re-login.
    this.runtime.delete(deviceId)
    this.devices.setStatus(deviceId, 'UNKNOWN')
    this.emitStatus({ deviceId, status: 'UNKNOWN' })
    this.emit('changed')
  }

  /**
   * Upload a firmware package.
   *
   * Reads the file here rather than accepting bytes over IPC: a firmware image
   * is tens of megabytes, and serialising that through the IPC bridge would
   * allocate it several times over for no benefit — the renderer only needs to
   * know which file the user picked.
   */
  async uploadFirmware(
    deviceId: string,
    filePath: string,
    onProgress?: (sent: number, total: number) => void
  ): Promise<{ bytes: number }> {
    const device = this.get(deviceId)
    const client = this.clientFor(device)

    let bytes: Uint8Array
    try {
      const buffer = await readFile(filePath)
      bytes = new Uint8Array(buffer)
    } catch (error) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `无法读取固件文件：${filePath}`,
        error instanceof Error ? error.message : String(error)
      )
    }

    if (bytes.byteLength === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '固件文件为空')
    }

    appLog().warn('Firmware upload started', {
      deviceId,
      file: filePath,
      bytes: bytes.byteLength
    })

    await client.uploadFirmware(basename(filePath), bytes, {
      ...(onProgress ? { onProgress } : {})
    })

    appLog().info('Firmware upload completed', { deviceId, bytes: bytes.byteLength })
    return { bytes: bytes.byteLength }
  }

  // -------------------------------------------------------------------------
  // Realtime monitoring (Phase 4-7)
  // -------------------------------------------------------------------------

  /**
   * Start the requested realtime streams for a device.
   *
   * The device's sample rate is read FIRST, because the audio frame geometry and
   * the spectrum frequency axis both derive from it. Starting a stream with the
   * wrong rate produces charts that are wrong by a constant factor — plausible
   * but incorrect, which is the worst kind of wrong for a monitoring tool.
   */
  async startMonitoring(
    deviceId: string,
    kinds: readonly StreamKind[],
    channelId = 0
  ): Promise<MonitorState> {
    const device = this.get(deviceId)
    if (!this.createStreamManager) {
      throw new AppError(ErrorCodes.NOT_IMPLEMENTED, '实时监测服务未装配')
    }

    const client = this.clientFor(device)
    // Fail fast and loudly if the device is unreachable, rather than opening
    // sockets that will silently retry forever.
    await this.withStatusTracking(device, () => client.getDeviceInfo())
    await client.prepareStream()

    const sampleRate = await this.getSampleRate(deviceId).catch(() => 48_000)

    let manager = this.streamManagers.get(deviceId)
    if (!manager) {
      manager = this.createStreamManager({
        deviceId,
        baseWsUrl: toWebSocketUrl(client.currentBaseUrl),
        headers: client.authHeaderForStream(),
        sampleRate,
        ringBufferSeconds: this.getSettings().ringBufferSeconds,
        preAlarmSeconds: this.getSettings().preAlarmSeconds,
        postAlarmSeconds: this.getSettings().postAlarmSeconds,
        /**
         * Select the channel on the DEVICE before the streams (re)open.
         *
         * `/features_stream` and `/freq_domain` carry no channel in their
         * subscription, so without this a user clicking CH2 would still be shown
         * CH1's data under a CH2 heading.
         *
         * Failure is non-fatal: the streams still open, and the manager logs that
         * features follow the device instead. A device that refuses (e.g. the
         * channel is disabled) must not block monitoring entirely.
         */
        selectChannel: async (channelId: number) => {
          const active = this.clientFor(device)
          // Verify the channel exists and is enabled first: the device rejects a
          // disabled channel, and finding out here yields a clear message rather
          // than a stream that silently reports a different channel.
          const raw = await active.getPassageway()
          const channels = mapChannels(raw)
          const target = channels.find((channel) => channel.channelIndex === channelId)
          if (!target) {
            throw new AppError(
              ErrorCodes.VALIDATION_ERROR,
              `设备未上报通道 ${channelId + 1}，无法切换`
            )
          }
          if (!target.enabled) {
            throw new AppError(
              ErrorCodes.VALIDATION_ERROR,
              `通道 ${channelId + 1} 未启用，无法切换（请先在设备配置中启用）`
            )
          }
          await active.channelSelect(channelId)
        },
        canRecord: () => Promise.resolve(true),
        persistRecording: () =>
          Promise.reject(
            new AppError(ErrorCodes.NOT_IMPLEMENTED, '录音持久化未装配')
          )
      })
      this.streamManagers.set(deviceId, manager)
      this.streamBridges.set(deviceId, this.bridgeManagerEvents(deviceId, manager))
    }

    manager.start(kinds, channelId)
    return this.monitorStateFor(deviceId, manager)
  }

  /** The manager for a device, when one is running. */
  findStreamManager(deviceId: string): StreamManager | undefined {
    return this.streamManagers.get(deviceId)
  }

  /**
   * Re-emit a manager's stream events on this service.
   *
   * WHY THIS EXISTS
   * The IPC bridge and the trend writer both subscribe to DeviceService, not to
   * the individual managers, so that neither has to know how many devices are
   * streaming or when a manager is replaced. Without this bridge, feature events
   * stopped at the StreamManager: the trend store therefore received nothing and
   * the long-term history silently stayed empty while everything looked healthy.
   *
   * @returns a disposer that removes every listener this method added.
   */
  private bridgeManagerEvents(deviceId: string, manager: StreamManager): () => void {
    // Events that carry data forward. `status` is deliberately absent: the IPC
    // bridge already receives per-stream status from the monitor bridge, and
    // duplicating it here would double every status push.
    const forwarded = ['feature', 'audio', 'spectrum', 'spectrogram', 'state', 'recording-state']
    const listeners: Array<{ event: string; handler: (payload: unknown) => void }> = []

    for (const event of forwarded) {
      const handler = (payload: unknown): void => {
        this.emit(event, payload)
      }
      manager.on(event, handler)
      listeners.push({ event, handler })
    }

    deviceLog().debug('Stream events bridged to DeviceService', { deviceId, events: forwarded })

    return () => {
      for (const { event, handler } of listeners) manager.off(event, handler)
      listeners.length = 0
    }
  }

  /** Stop streams for one device, or all of them when `deviceId` is omitted. */
  async stopMonitoring(deviceId?: string): Promise<void> {
    if (deviceId) {
      const manager = this.streamManagers.get(deviceId)
      if (manager) {
        // Detach BEFORE disposing: a frame emitted during teardown would
        // otherwise be forwarded to the trend writer for a device that has
        // already stopped streaming.
        this.streamBridges.get(deviceId)?.()
        this.streamBridges.delete(deviceId)
        await manager.dispose()
        this.streamManagers.delete(deviceId)
      }
      return
    }

    for (const dispose of this.streamBridges.values()) dispose()
    this.streamBridges.clear()
    await Promise.all([...this.streamManagers.values()].map((manager) => manager.dispose()))
    this.streamManagers.clear()
  }

  /** Snapshot of what is currently streaming, for UI reconciliation. */
  listMonitorState(deviceId?: string): MonitorState[] {
    if (deviceId) {
      const manager = this.streamManagers.get(deviceId)
      return manager ? [this.monitorStateFor(deviceId, manager)] : []
    }
    return [...this.streamManagers.entries()].map(([id, manager]) =>
      this.monitorStateFor(id, manager)
    )
  }

  private monitorStateFor(deviceId: string, manager: StreamManager): MonitorState {
    const state: MonitorState = {
      deviceId,
      channelId: manager.currentChannelId,
      running: manager.runningKinds,
      recording: manager.isRecording
    }
    // Audio-anchored elapsed time, so a caller that polls `state()` agrees with
    // the pushed recording-state events rather than inventing a wall-clock value.
    const elapsed = manager.recordingElapsedMs
    if (elapsed !== undefined) state.elapsedMs = elapsed
    return state
  }

  // -------------------------------------------------------------------------
  // Online status monitor (spec 13.2)
  // -------------------------------------------------------------------------

  startMonitor(): void {
    if (this.monitorTimer || this.disposed) return
    const interval = this.getSettings().healthCheckIntervalMs
    this.monitorTimer = setInterval(() => {
      void this.runHealthCheck()
    }, interval)
    // Do not keep the process alive purely for the monitor.
    this.monitorTimer.unref?.()
    // An immediate first pass means the UI shows live status without waiting.
    void this.runHealthCheck()
  }

  stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = undefined
    }
  }

  /**
   * One health-check sweep over every known device.
   * Public so the UI can force a refresh on demand.
   */
  async runHealthCheck(): Promise<void> {
    if (this.monitorRunning || this.disposed) return
    this.monitorRunning = true
    try {
      const devices = this.devices.list()
      // Sequential rather than parallel: a LAN full of sleeping boxes should not
      // produce a thundering herd of concurrent sockets from one desktop app.
      for (const device of devices) {
        if (this.disposed) break
        await this.checkOne(device)
      }
    } finally {
      this.monitorRunning = false
    }
  }

  private async checkOne(device: Device): Promise<void> {
    const runtime = this.runtimeFor(device.id, device.status)

    try {
      if (device.kind === 'acousticCamera') {
        // `GET /system/detect_status` is the camera's cheapest authenticated read
        // and it exists in every documented mode. `/get_devinfo` — which the box
        // path uses — does not exist on a camera at all, so reusing it here would
        // mark every healthy camera OFFLINE after three probes.
        await this.cameraClientFor(device).getDetectStatus({
          timeoutMs: this.getSettings().requestTimeoutMs
        })
      } else if (device.kind === 'auscultationBox') {
        /**
         * `/workmode` 是**2023 版**这一族最便宜的认证读（手册把它列在 `/basic` 之前，且三个
         * 模式都有）。`/get_devinfo` 在这台设备上不存在 —— 用它探活会把一台健康的盒子在三轮
         * 之后标成离线。
         *
         * ⚠️ **SN-16 空气声呐没有 `/workmode`**（那一代没有"工作模式"这个概念），而它是不是
         * 空气声呐**只有读过 `/system` 才知道**。所以这里必须先 `ensureVariant()`：
         * 客户端是新的（进程刚起、地址刚改过）时 `variant` 还是 `undefined`，直接调
         * `getWorkMode()` 就会对一台空气声呐发一个必然 404 的请求，然后
         * `markFailed()` 把一个**健康的设备**记成失败 —— 三轮之后它显示离线。
         * 这正是 2026-09-17 第 8 批的 GUI 探针抓到的：假空气声呐收到了 `/workmode` 请求。
         *
         * `ensureVariant()` 自己读 `/system`（两代都有），所以健康检查的代价仍然是**一次**
         * 认证读；认出 airSonar 之后 `getWorkMode()` 直接返回空视图，一次请求都不发。
         */
        const client = this.e2ClientFor(device)
        const variant = await client.ensureVariant({ timeoutMs: this.getSettings().requestTimeoutMs })
        if (variant !== 'airSonar') {
          await client.getWorkMode({ timeoutMs: this.getSettings().requestTimeoutMs })
        }
      } else {
        const client = this.clientFor(device)
        await client.getDeviceInfo({ timeoutMs: this.getSettings().requestTimeoutMs })
      }
      this.markOnline(device, runtime)
    } catch (error) {
      this.markFailed(device, runtime, error)
    }
  }

  /**
   * Build (or reuse) an FA371 client for a stored camera.
   *
   * Mirrors `clientFor` for boxes, including the credential lookup and the
   * persisted-strategy preference: the only real difference is which client class
   * is constructed. Kept separate rather than branching inside `clientFor` so that
   * neither family's runtime cache can be populated with the other's client.
   */
  private cameraClientFor(device: Device): Fa371ApiClient {
    const existing = this.runtime.get(device.id)
    if (existing?.cameraClient && existing.cameraClient.currentBaseUrl === this.baseUrlFor(device)) {
      return existing.cameraClient
    }

    const credential = this.credentials.get(device.id)
    if (!credential) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '未找到该设备的登录凭据，请重新添加设备', device.id)
    }

    const client = new Fa371ApiClient({
      transport: this.transport,
      baseUrl: normaliseBaseUrl(this.baseUrlFor(device)),
      credential,
      timeoutMs: this.getSettings().requestTimeoutMs,
      ...(this.devices.getAuthStrategy(device.id)
        ? { preferredStrategyId: this.devices.getAuthStrategy(device.id) as string }
        : {}),
      onSessionEstablished: (strategyId) => {
        try {
          this.devices.setAuthStrategy(device.id, strategyId)
        } catch (error) {
          deviceLog().warn('Failed to persist camera auth strategy', {
            deviceId: device.id,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
    })

    this.setRuntime(device.id, {
      ...(existing ?? { consecutiveFailures: 0, lastStatus: device.status, observedOnline: false }),
      cameraClient: client
    })
    return client
  }

  /**
   * 建（或复用）一台听诊盒子的客户端。
   *
   * 与 `cameraClientFor` 同一形状，**但缓存的是 token 会话**：这一族的每个请求都要带
   * `Authorization: Bearer`，重新 new 一个客户端就等于每次重新登录。三族的客户端各存各的字段，
   * 谁也不会把别人的客户端拿去用（那是"类型上过得去、运行时炸"的典型）。
   */
  e2ClientFor(device: Device): E2Client {
    const existing = this.runtime.get(device.id)
    if (existing?.e2Client && existing.e2Client.currentBaseUrl === this.baseUrlFor(device)) {
      return existing.e2Client
    }
    const credential = this.credentials.get(device.id)
    if (!credential) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '未找到该设备的登录凭据，请重新添加设备', device.id)
    }

    const client = new E2Client({
      transport: this.transport,
      baseUrl: normaliseBaseUrl(this.baseUrlFor(device)),
      credentials: credential,
      timeoutMs: this.getSettings().requestTimeoutMs
    })

    this.setRuntime(device.id, {
      ...(existing ?? { consecutiveFailures: 0, lastStatus: device.status, observedOnline: false }),
      e2Client: client
    })
    return client
  }

  /**
   * 记住听诊盒子族的**代次**（v12），返回**从库里读回来**的值。
   *
   * 为什么这件事在 `DeviceService` 而不是 `E2DeviceService`：设备行的写入只有仓库层的
   * 一个入口（`DeviceRepository.updateE2Variant`），而 `E2DeviceService` 手里只有
   * `DeviceService` 这个门面 —— 让它自己去拿仓库，等于把"谁能写设备行"这件事放开。
   *
   * 调用方（`E2DeviceService`）负责比对读回值：不一致时记日志，但**不抛** —— 代次记错
   * 只会让界面少给一个 PTZ 页签，而抛出去会让一次只读的"读状态"失败。
   */
  rememberE2Variant(deviceId: string, variant: E2Variant): E2Variant | undefined {
    return this.devices.updateE2Variant(deviceId, variant)
  }

  private markOnline(device: Device, runtime: DeviceRuntime): void {    runtime.consecutiveFailures = 0
    // 本进程**亲眼**见过它在线了。从现在起"离线判定"才可以走那条防抖动的延迟规则。
    runtime.observedOnline = true
    const timestamp = now()
    // Recovery is immediate on a single success (spec 13.2).
    if (device.status !== 'ONLINE' || runtime.lastStatus !== 'ONLINE') {
      this.devices.setStatus(device.id, 'ONLINE', timestamp)
      runtime.lastStatus = 'ONLINE'
      this.emitStatus({ deviceId: device.id, status: 'ONLINE', lastSeen: timestamp })
    } else {
      // Still online: refresh lastSeen silently, no event storm.
      this.devices.setStatus(device.id, 'ONLINE', timestamp)
    }
  }

  private markFailed(device: Device, runtime: DeviceRuntime, error: unknown): void {
    runtime.consecutiveFailures += 1
    const threshold = this.getSettings().offlineFailureThreshold

    deviceLog().debug('Health check failed', {
      deviceId: device.id,
      consecutiveFailures: runtime.consecutiveFailures,
      threshold,
      observedOnline: runtime.observedOnline,
      reason: error instanceof Error ? error.message : String(error)
    })

    /*
     * 「单次超时不许翻离线」（spec 13.2）防的是**抖动**：一台刚才还在线的设备因为一次
     * 超时被写成离线、下一轮又变回在线，界面上就会闪。但那条规则的前提是"我们见过它在线"。
     *
     * 一台本进程从未见它在线的设备没有可抖动的状态：要么是刚添加的、要么上次会话就已经
     * 不在了。让它继续显示「未知」只是把"我们还没打听到"当成一种状态 —— 产品要求是
     * 「离线的设备直接显示离线」。
     *
     * 判断本身在纯函数 `shouldMarkOffline()` 里（可测）；这里只负责把三个输入凑齐。
     * 注意第二个输入是 `observedOnline` 而不是 `lastStatus`：后者是从数据库读出来的，
     * 可能是一次**旧会话**留下的 `ONLINE`。
     */
    if (
      !shouldMarkOffline({
        observedOnline: runtime.observedOnline,
        consecutiveFailures: runtime.consecutiveFailures,
        threshold
      })
    ) {
      return
    }

    if (runtime.lastStatus !== 'OFFLINE') {
      this.devices.setStatus(device.id, 'OFFLINE')
      runtime.lastStatus = 'OFFLINE'
      this.emitStatus({ deviceId: device.id, status: 'OFFLINE' })
      deviceLog().warn('Device marked OFFLINE', {
        deviceId: device.id,
        consecutiveFailures: runtime.consecutiveFailures,
        threshold
      })
    }
  }

  /** Run an operation while feeding its outcome into the failure counter. */
  private async withStatusTracking<T>(device: Device, operation: () => Promise<T>): Promise<T> {
    const runtime = this.runtimeFor(device.id, device.status)
    try {
      const result = await operation()
      this.markOnline(device, runtime)
      return result
    } catch (error) {
      this.markFailed(device, runtime, error)
      throw error
    }
  }

  private emitStatus(event: DeviceStatusEvent): void {
    this.emit('status', event)
  }

  // -------------------------------------------------------------------------
  // Teardown (appendix C rule 12: clean up on app exit)
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopMonitor()
    // Streams are closed BEFORE the runtime map is cleared: a manager holds an
    // authenticated URL, and leaving one alive past teardown would keep a
    // socket open after the window is gone (appendix C rule 12).
    await this.stopMonitoring()
    this.runtime.clear()
    this.removeAllListeners()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the host portion of a `host:port` address. */
function extractHost(address: string): string | undefined {
  const trimmed = address.trim()
  if (trimmed === '') return undefined
  // IPv6 literals are bracketed; a naive split on ':' would truncate them.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed)
  if (bracketed) return bracketed[1]
  const [host] = trimmed.split(':')
  return host && host !== '' ? host : undefined
}

/** File name portion of a path, without pulling in the whole path module. */
function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

/**
 * Combine address + port into `host:port`.
 *
 * NOT a URL — it has no scheme. Anything that is going to make a request must
 * pass this through `normaliseBaseUrl` first; see `probe()` for the failure this
 * caused when it did not.
 */
export function normaliseAddress(ip: string, httpPort?: number): string {
  const trimmed = ip.trim()
  if (trimmed === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, 'IP 地址不能为空')
  // An address that already carries a port wins over the separate field.
  if (/:\d+$/.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
  return httpPort && httpPort !== 80 ? `${trimmed}:${httpPort}` : trimmed
}

/** Client-side validation, mirroring spec 6.2 step 1. */
export function validateAddInput(input: AddDeviceInput): void {
  if (!input.ip || input.ip.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'IP 地址不能为空')
  }
  if (input.httpPort !== undefined) {
    if (!Number.isInteger(input.httpPort) || input.httpPort < 1 || input.httpPort > 65535) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '端口必须在 1-65535 之间')
    }
  }
  if (!input.username || input.username.trim() === '') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '用户名不能为空')
  }
  if (!input.password) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '密码不能为空')
  }
}

/** True when the IPv4/hostname literal is plausible. Deliberately permissive. */
export function isPlausibleHost(value: string): boolean {
  const host = value.trim().replace(/^https?:\/\//i, '').split(':')[0] ?? ''
  if (host === '') return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((octet) => {
      const numeric = Number(octet)
      return numeric >= 0 && numeric <= 255
    })
  }
  return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)
}
