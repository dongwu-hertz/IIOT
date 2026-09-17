/**
 * Fa371StreamService —— 管理**已注册相机**的实时 WebSocket 流（手册 §5.2）。
 *
 *   渲染层（IPC）-> [本文件] 每设备一个 `Fa371WsClient`，逐路起停 + 抽稀 + 会话状态
 *                     -> `fa371-ws-client.ts` 解码后的类型化帧
 *
 * 与 AE08 的 `stream/stream-manager.ts` **分工完全对应**：
 *   - 传输/解码在客户端（对应 `WebSocketStream` + `stream-services`）；
 *   - "起停哪几路、状态怎么对账、什么推给 UI"在本文件（对应 `StreamManager`）；
 *   - 推 IPC 由 `handlers.ts` + `monitor-bridge` 的同类转发负责。
 * 之所以重新写一个而不是让 `StreamManager` 通用化：相机没有通道、没有环形缓冲、
 * 没有录音，五路的语义与 AE08 的四路没有一处重合；硬套会让两边都长出分支。
 * **但 socket 那一层是同一个类，没有第二套 WebSocket 实现。**
 *
 * ---------------------------------------------------------------------------
 * 抽稀：推给渲染层之前做了什么，以及为什么
 * ---------------------------------------------------------------------------
 * 表格里的**实测**列来自 2026-09-15 对 192.168.110.235 的 6 s 窗口测量
 * （见 `@shared/domain/fa371-stream.FA371_STREAM_MEASURED`）。mock 假设的列保留
 * 下来是为了显示两者差多远——抽稀的结论必须建立在真实速率上。
 *
 * | 通道 | mock 假设 | 真机实测 | 推 IPC 的 |
 * |---|---|---|---|
 * | `/fftData`        | 5 × 1024 B/s   | 10.06 × 2052 B/s | 1024 个整数（原样，去掉字节包装） |
 * | `/voiceprintData` | 1 × 131072 B/s | 10.07 × ~45200 B/s | 原样的 JPEG base64（设备已渲染好） |
 * | `/energyData`     | 20 B/s         | 29.92 × 20 B/s | 原样（最多 3 组目标点） |
 * | `/pcmData`        | 1 × 192000 B/s | 10 × 19200 B/s | 512 点包络 + peak/rms（原始样本留在主进程） |
 * | `/detectFeedback` | ~1 KB/次       | 6 s 内 0 帧 | 原样（检测日志对象） |
 *
 * 两条判断依据：
 *   1. **原始速率过 IPC 会打满桥**——AE08 的音频流（3.8 MB/s）已实测过这个后果。
 *      相机的 PCM 两边算下来都是 192 KB/s，但**帧率从 1 Hz 变成 10 Hz**：整块
 *      structured clone 的次数是 mock 假设的 10 倍，而界面只需要包络
 *      （谱图/示波器都画不出 4800 个点）。
 *   2. **抽稀取极值而不是均值**——与 `audio/pcm-utils.extractWaveform` 同一个理由：
 *      均值是低通滤波，正好把泄漏检测要看的瞬态（局部放电的"咔哒"）抹掉。
 *      声纹图那条只适用于**数值候选**（mock）；真机推的是 JPEG，设备自己已经
 *      做完渲染，再抽稀只会把图弄坏，所以原样转发。
 *
 * 帧本身在主进程**只解码一次**、所有订阅者共享同一对象（见 `fa371-ws-client`）；
 * 抽稀是"每通道每帧一次"的额外动作，与订阅者数量无关。
 */

import { EventEmitter } from 'node:events'
import type { Device } from '@shared/domain/models'
import {
  FA371_PCM_SAMPLE_RATE_HZ,
  FA371_STREAM_KINDS,
  type Fa371DetectFeedbackFrame,
  type Fa371DetectFeedbackPreview,
  type Fa371EnergyFrame,
  type Fa371EnergyPreview,
  type Fa371FftFrame,
  type Fa371FftPreview,
  type Fa371MonitorState,
  type Fa371PcmFrame,
  type Fa371PcmPreview,
  type Fa371StreamKind,
  type Fa371StreamPreview,
  type Fa371StreamStatus,
  type Fa371VoiceprintFrame,
  type Fa371VoiceprintPreview
} from '@shared/domain/fa371-stream'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../../logging/logger'
import { computeFrameStats, extractWaveform } from '../../audio/pcm-utils'
import { Fa371WsClient, type Fa371WsClientOptions, type Fa371DecodeOptions } from './fa371-ws-client'

/** 创建客户端时的注入项；生产环境用 `fa371StreamClientForDevice`。 */
export type Fa371StreamClientFactory = (options: Fa371WsClientOptions) => Fa371WsClient

/**
 * 服务需要的设备侧信息。
 *
 * 刻意只依赖这几个方法（而不是整个 `DeviceService`）：这样本文件可以在没有 SQLite、
 * 没有 Electron 的测试里跑，也让"服务到底拿设备做了什么"一眼可见。
 */
export interface Fa371StreamDeviceResolver {
  /** 取设备记录；不存在时抛 `AppError`。 */
  get(deviceId: string): Device
  /**
   * 复用设备已解析出的 HTTP 会话（`Fa371ApiClient.authHeaders()`）。
   *
   * **不重新登录**：401 重登、Token 携带方式的探测都已经由 HTTP 客户端完成，
   * 这里只借用它的结论。没有客户端时（例如设备还没被访问过）返回空对象，
   * 让握手候选里的 `none` 去试。
   */
  findAuthHeaders(deviceId: string): Record<string, string>
  /** 该会话当前解析出的 base URL，用来推出 ws:// 地址；没有时返回 undefined。 */
  findBaseUrl(deviceId: string): string | undefined
  /** 上次实测胜出的握手候选 id（可选；用于把它排到候选表最前）。 */
  preferredWsAuthId?(deviceId: string): string | undefined
  /**
   * 设备**自己报告**的采样率（可选）。
   *
   * 只用于给 `/fftData` 换算频率轴（`binHz`）。实测（2026-09-15）这台相机
   * 没有任何可用的 HTTP 采样率接口，因此返回 `undefined` 是**正常结果**，
   * 不是错误：界面据此显示"频率轴未知"，而不是拿 48 kHz 冒充。
   */
  deviceSampleRate?(deviceId: string): number | undefined
}

export interface Fa371StreamServiceOptions {
  resolver: Fa371StreamDeviceResolver
  /** `http(s)://` -> `ws(s)://` 的换算，注入以便测试与复用 `toWebSocketUrl`。 */
  toWebSocketUrl: (httpBaseUrl: string) => string
  /** 每路包络点数（`/pcmData`）。默认 512。 */
  waveformBuckets?: number
  /** 声纹图推 IPC 的目标尺寸。默认 64×32（源假设 256×128 的 1/4 与 1/4）。 */
  voiceprintPreview?: { width: number; height: number }
  /** `/pcmData` 环形缓冲秒数，默认 5。 */
  pcmBufferSeconds?: number
  /** 解码候选覆盖（Protocol Lab 用）。 */
  decode?: Fa371DecodeOptions
  /** 客户端工厂覆盖（测试用）。 */
  createClient?: Fa371StreamClientFactory
  /** 心跳间隔覆盖（测试用；默认见 `fa371-ws-client`）。 */
  heartbeatMs?: number
}

/** 一路通道的运行记录。 */
interface Fa371StreamSession {
  client: Fa371WsClient
  kinds: Fa371StreamKind[]
  /** 逐路订阅的退订函数，`stopChannels` 用它们精确摘掉一路。 */
  disposers: Map<Fa371StreamKind, () => void>
  /** 状态事件的退订。 */
  statusDisposer: () => void
}

/** 默认包络点数：与 AE08 的预览一致，一张图画得下、且能保住瞬态。 */
const DEFAULT_WAVEFORM_BUCKETS = 512

/** 默认声纹预览尺寸：源假设是 256×128，各方向 1/4。 */
const DEFAULT_VOICEPRINT_PREVIEW = { width: 64, height: 32 }

export class Fa371StreamService extends EventEmitter {
  private readonly options: Fa371StreamServiceOptions
  private readonly sessions = new Map<string, Fa371StreamSession>()
  private disposed = false

  constructor(options: Fa371StreamServiceOptions) {
    super()
    this.options = options
  }

  /** 正在推流的设备 id。 */
  get runningDeviceIds(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * 打开（或收窄/扩宽）一台相机的通道集合。
   *
   * 语义与 `StreamManager.start` 一致：参数是**期望的完整集合**，
   * 少了哪路就关哪路、多了哪路就开哪路，其余不动。这样 UI 反复调用、
   * 切换面板都不会留下孤儿 socket，也不会因为一次点击把所有流重启一遍。
   *
   * 幂等，且不改变已在跑的其他设备。
   */
  start(deviceId: string, kinds: readonly Fa371StreamKind[]): Fa371MonitorState {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, 'FA371 流服务已释放')

    const wanted = normaliseKinds(kinds)
    if (wanted.length === 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '请至少选择一路要接收的相机数据')
    }

    const existing = this.sessions.get(deviceId)
    if (existing) {
      this.reconcile(deviceId, existing, wanted)
      this.emitState(deviceId)
      return this.stateFor(deviceId)
    }

    const session = this.createSession(deviceId, wanted)
    this.sessions.set(deviceId, session)
    this.emitState(deviceId)

    deviceLog().info('FA371 实时流已启动', {
      deviceId,
      channels: wanted,
      decode: session.client.decodeProfileIds()
    })
    return this.stateFor(deviceId)
  }

  /**
   * 停止一台相机（或全部）的流。
   *
   * 先摘监听再 `dispose()`：与 `device-service.stopMonitoring` 同一个顺序，
   * 避免 teardown 期间到达的一帧被转发给已经离开的渲染层。
   */
  stop(deviceId?: string): void {
    const ids = deviceId ? [deviceId] : [...this.sessions.keys()]
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue
      this.sessions.delete(id)
      session.statusDisposer()
      for (const dispose of session.disposers.values()) dispose()
      session.disposers.clear()
      session.client.dispose()
      this.emitState(id)
      deviceLog().info('FA371 实时流已停止', { deviceId: id })
    }
  }

  /** 状态快照；给 deviceId 时只返回该设备（没有则空数组）。 */
  listState(deviceId?: string): Fa371MonitorState[] {
    const ids = deviceId ? [deviceId] : [...this.sessions.keys()]
    return ids
      .filter((id) => this.sessions.has(id))
      .map((id) => this.stateFor(id))
  }

  /** 释放：停掉全部设备并摘掉自己的监听。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.removeAllListeners()
    deviceLog().debug('FA371 流服务已释放')
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private createSession(deviceId: string, kinds: readonly Fa371StreamKind[]): Fa371StreamSession {
    const client = (this.options.createClient ?? defaultClientFactory)(this.clientOptions(deviceId, kinds))
    const disposers = new Map<Fa371StreamKind, () => void>()
    const session: Fa371StreamSession = {
      client,
      kinds: [...kinds],
      disposers,
      statusDisposer: () => undefined
    }

    session.statusDisposer = client.onStatus((status) => this.emit('stream-status', status))
    for (const kind of kinds) this.subscribeChannel(session, kind)
    client.connect()
    return session
  }

  /** 让一条会话的通道集合收敛到 `wanted`（只增删差异）。 */
  private reconcile(deviceId: string, session: Fa371StreamSession, wanted: readonly Fa371StreamKind[]): void {
    const target = new Set(wanted)
    const removed: Fa371StreamKind[] = []
    for (const kind of [...session.kinds]) {
      if (target.has(kind)) continue
      removed.push(kind)
    }
    const added = wanted.filter((kind) => !session.kinds.includes(kind))

    if (removed.length === 0 && added.length === 0) return

    /**
     * 一个 `Fa371WsClient` 的通道集合在**构造时固定**（每一路的解码假设与
     * 心跳内容都是构造参数），所以集合一旦变化就重建客户端：已有通道的 socket
     * 会重开一次。代价明确（一次重连），换来的是"哪一路用什么假设解码"
     * 只有一处决定，不会出现半新半旧的会话。
     */
    deviceLog().info('FA371 通道集合变化，重建客户端', { deviceId, from: session.kinds, to: wanted, removed, added })

    for (const dispose of session.disposers.values()) dispose()
    session.disposers.clear()
    session.statusDisposer()
    session.client.dispose()

    const client = (this.options.createClient ?? defaultClientFactory)(this.clientOptions(deviceId, wanted))
    session.client = client
    session.kinds = [...wanted]
    session.statusDisposer = client.onStatus((status) => this.emit('stream-status', status))
    for (const kind of wanted) this.subscribeChannel(session, kind)
    client.connect()
  }

  /**
   * 订阅一路并把帧抽稀后发出。
   *
   * 每个订阅函数只做"帧 -> 预览"这一步，且**不复制原始字节**：
   * `/pcmData` 的包络是从解码结果上算出来的新数组（不可避免，因为它就是降采样），
   * 但 192 KB 的原始样本不会被带进 IPC。
   */
  private subscribeChannel(session: Fa371StreamSession, kind: Fa371StreamKind): void {
    const deviceId = session.client.deviceId
    // 采样率在订阅时读一次：FFT 的频率轴只在预览里用，而它不会在会话中途变化
    // （改采样率会让设备重启采集，那条路径本来就会重建客户端）。
    const deviceSampleRate = this.options.resolver.deviceSampleRate?.(deviceId)
    const emit = (preview: Fa371StreamPreview): void => {
      // 预览对象里已经带了 deviceId，渲染层唯一需要的就是它。
      this.emit('preview', preview)
    }

    let dispose: () => void
    switch (kind) {
      case 'fftData':
        dispose = session.client.onFrame('fftData', (frame: Fa371FftFrame) =>
          emit(toFftPreview(deviceId, frame, deviceSampleRate))
        )
        break
      case 'voiceprintData':
        dispose = session.client.onFrame('voiceprintData', (frame: Fa371VoiceprintFrame) =>
          emit(toVoiceprintPreview(deviceId, frame, this.options.voiceprintPreview))
        )
        break
      case 'energyData':
        dispose = session.client.onFrame('energyData', (frame: Fa371EnergyFrame) => emit(toEnergyPreview(deviceId, frame)))
        break
      case 'pcmData':
        dispose = session.client.onFrame('pcmData', (frame: Fa371PcmFrame) =>
          emit(toPcmPreview(deviceId, frame, this.options.waveformBuckets ?? DEFAULT_WAVEFORM_BUCKETS))
        )
        break
      case 'detectFeedback':
        dispose = session.client.onFrame('detectFeedback', (frame: Fa371DetectFeedbackFrame) =>
          emit(toDetectFeedbackPreview(deviceId, frame))
        )
        break
    }
    session.disposers.set(kind, dispose)
  }

  private clientOptions(deviceId: string, kinds: readonly Fa371StreamKind[]): Fa371WsClientOptions {
    const device = this.options.resolver.get(deviceId)
    const httpBase = this.options.resolver.findBaseUrl(deviceId) ?? httpBaseUrlOf(device)
    if (!httpBase) {
      throw new AppError(
        ErrorCodes.DEVICE_OFFLINE,
        '无法确定相机的地址，请重新添加或刷新该设备',
        deviceId
      )
    }

    const preferredAuthId = this.options.resolver.preferredWsAuthId?.(deviceId)
    return {
      deviceId,
      baseWsUrl: this.options.toWebSocketUrl(httpBase),
      authHeaders: this.options.resolver.findAuthHeaders(deviceId),
      channels: kinds,
      ...(this.options.heartbeatMs !== undefined ? { heartbeatMs: this.options.heartbeatMs } : {}),
      ...(preferredAuthId ? { preferredAuthId } : {}),
      ...(this.options.decode ? { decode: this.options.decode } : {}),
      ...(this.options.pcmBufferSeconds !== undefined ? { pcmBufferSeconds: this.options.pcmBufferSeconds } : {})
    }
  }

  /** 组装 UI 对账用的会话状态。 */
  private stateFor(deviceId: string): Fa371MonitorState {
    const session = this.sessions.get(deviceId)
    if (!session) {
      return { deviceId, channelId: 0, running: [], recording: false, streams: [], decodeProfiles: {} }
    }

    const streams: Fa371StreamStatus[] = session.client.statusSnapshot()
    const resolved = session.client.resolvedAuthId()
    const buffer = session.client.pcmBufferState()
    const decodeProfiles: Partial<Record<Fa371StreamKind, string>> = session.client.decodeProfileIds()
    const deviceSampleRate = this.options.resolver.deviceSampleRate?.(deviceId)

    const state: Fa371MonitorState = {
      deviceId,
      // 相机没有通道（§6 用户模型）；保留字段只为与 AE08 的 MonitorState 同形。
      channelId: 0,
      running: [...session.kinds],
      recording: false,
      streams,
      decodeProfiles
    }
    if (resolved) state.handshakeAuthId = resolved
    if (deviceSampleRate !== undefined && deviceSampleRate > 0) {
      state.deviceSampleRate = deviceSampleRate
    }
    // 只有真的不一致时才带这个字段：一个"每路都正常"的空对象会让界面多一条
    // 永远为真的分支，而它真正要回答的是"现在有没有用错假设"。
    const layoutWarnings: Partial<Record<Fa371StreamKind, string>> = {}
    for (const status of streams) {
      if (status.layoutWarning) layoutWarnings[status.kind] = status.layoutWarning
    }
    if (Object.keys(layoutWarnings).length > 0) state.layoutWarnings = layoutWarnings
    if (session.kinds.includes('pcmData')) {
      state.pcm = {
        sampleRate: buffer.sampleRate,
        channels: buffer.channels,
        bufferSeconds: buffer.bufferSeconds,
        droppedFrames: buffer.droppedFrames,
        // 每帧时长按解码假设算：实测 4800 点 / 48 kHz = 100 ms。
        // 拿不到帧长时退回 0，界面显示"—"而不是编一个数。
        frameMs: buffer.frameSamples > 0 ? Math.round((buffer.frameSamples / buffer.sampleRate) * 1000) : 0
      }
    }
    return state
  }

  /** 推一次会话状态；渲染层据此对账（与 `MONITOR_STATE` 同一个用途）。 */
  private emitState(deviceId: string): void {
    this.emit('state', this.stateFor(deviceId))
  }
}

// ---------------------------------------------------------------------------
// 抽稀（纯函数，测试直接喂帧）
// ---------------------------------------------------------------------------

/**
 * `/fftData`：整数谱线去掉字节包装即可，本身已是显示尺寸（实测 1024 点）。
 *
 * `binHz` **不在这里编造**：它需要设备的采样率，而实测这台相机没有任何可用的
 * HTTP 采样率接口（`GET /get_samplingrate` 返回 Web 界面的 HTML）。拿不到就留
 * `undefined`，界面按"第 N 根谱线"标注并说明频率轴未知——一个编造的 Hz 轴比
 * 没有轴更糟。
 */
export function toFftPreview(
  deviceId: string,
  frame: Fa371FftFrame,
  deviceSampleRate?: number
): Fa371FftPreview {
  const preview: Fa371FftPreview = {
    deviceId,
    kind: 'fftData',
    timestamp: frame.receivedAt,
    bins: Array.from(frame.values),
    binCount: frame.binCount
  }
  if (deviceSampleRate !== undefined && deviceSampleRate > 0 && frame.binCount > 0) {
    preview.binHz = deviceSampleRate / 2 / frame.binCount
  }
  return preview
}

/**
 * `/voiceprintData`：**实测是 JPEG 图像**，原样转发；数值候选才做块内取最大。
 *
 * 两条路径的分界是 `frame.jpegBase64` 是否存在：
 *   - 真机（2026-09-15 实测）：设备推的是 600×400 的基线 JPEG。它已经是一张
 *     **渲染好的图**，再抽稀只会让图变糊，所以原字节直接以 base64 过 IPC
 *     （与 AE08 的时频图同一条路：`<img src="data:image/jpeg;base64,...">`）。
 *     假想的"64×32 矩阵"在这种情况下根本不存在，因此 `cells` 留空、宽高为 0——
 *     编一个尺寸出来会让界面画一张与设备无关的假图。
 *   - 数值候选（mock 与测试用）：保持原来的块内**最大幅度**抽稀。
 *
 * 取最大而不是平均的理由（只对数值那条成立）：声纹图上的"热斑"就是缺陷频率的
 * 痕迹，平均会把一个小而亮的斑点摊进周围背景，看着像没有异常。
 */
export function toVoiceprintPreview(
  deviceId: string,
  frame: Fa371VoiceprintFrame,
  target: { width: number; height: number } = DEFAULT_VOICEPRINT_PREVIEW
): Fa371VoiceprintPreview {
  if (frame.jpegBase64 !== undefined) {
    return {
      deviceId,
      kind: 'voiceprintData',
      timestamp: frame.receivedAt,
      cells: [],
      width: 0,
      height: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      decimation: 1,
      jpegBase64: frame.jpegBase64,
      jpegBytes: frame.bytes.byteLength
    }
  }

  const { values, width, height } = frame
  if (width <= 0 || height <= 0 || values.length === 0) {
    return {
      deviceId,
      kind: 'voiceprintData',
      timestamp: frame.receivedAt,
      cells: [],
      width: 0,
      height: 0,
      sourceWidth: width,
      sourceHeight: height,
      decimation: 1
    }
  }

  const outWidth = Math.max(1, Math.min(target.width, width))
  const outHeight = Math.max(1, Math.min(target.height, height))
  const cells = new Array<number>(outWidth * outHeight).fill(0)

  for (let row = 0; row < outHeight; row += 1) {
    const rowStart = Math.floor((row * height) / outHeight)
    const rowEnd = Math.max(rowStart + 1, Math.floor(((row + 1) * height) / outHeight))
    for (let column = 0; column < outWidth; column += 1) {
      const columnStart = Math.floor((column * width) / outWidth)
      const columnEnd = Math.max(columnStart + 1, Math.floor(((column + 1) * width) / outWidth))

      let extreme = Number.NEGATIVE_INFINITY
      for (let y = rowStart; y < rowEnd && y < height; y += 1) {
        const base = y * width
        for (let x = columnStart; x < columnEnd && x < width; x += 1) {
          const value = values[base + x]
          if (value === undefined) continue
          const magnitude = value < 0 ? -value : value
          if (magnitude > extreme) extreme = magnitude
        }
      }
      cells[row * outWidth + column] = extreme === Number.NEGATIVE_INFINITY ? 0 : extreme
    }
  }

  return {
    deviceId,
    kind: 'voiceprintData',
    timestamp: frame.receivedAt,
    cells,
    width: outWidth,
    height: outHeight,
    sourceWidth: width,
    sourceHeight: height,
    decimation: Math.max(1, Math.round(width / outWidth))
  }
}

/** `/energyData`：最多 3 组目标点，本身极小，不抽稀。 */
export function toEnergyPreview(deviceId: string, frame: Fa371EnergyFrame): Fa371EnergyPreview {
  return {
    deviceId,
    kind: 'energyData',
    timestamp: frame.receivedAt,
    targets: frame.targets.map((target) => ({ ...target }))
  }
}

/**
 * `/pcmData`：每帧 4800 点（实测）降为 `buckets` 点包络 + peak/rms。
 *
 * 多声道（D5 未定义）先按帧内平均下混成单声道再算包络：
 * 直接取前 N 点会只显示第一个通道，而"到底几个通道"目前只是假设，
 * 显示的波形不该依赖那个假设。
 *
 * `frameMs` 是**算出来的**（`samples / sampleRate × 1000`），不是抄手册的
 * "每秒 1 次"：实测每帧 100 ms，把它如实带出去，界面才不会把 0.1 s 显示成 1 s。
 */
export function toPcmPreview(deviceId: string, frame: Fa371PcmFrame, buckets: number): Fa371PcmPreview {
  const mono = downmixToMono(frame.samples, frame.channels)
  const stats = computeFrameStats(mono)
  const sampleRate = frame.sampleRate > 0 ? frame.sampleRate : FA371_PCM_SAMPLE_RATE_HZ
  return {
    deviceId,
    kind: 'pcmData',
    timestamp: frame.receivedAt,
    peak: stats.peak,
    rms: stats.rms,
    waveform: extractWaveform(mono, buckets),
    sampleRate,
    channels: frame.channels,
    samples: mono.length,
    frameMs: Math.round((mono.length / sampleRate) * 1000)
  }
}

/** `/detectFeedback`：已映射好的检测日志，本身很小，不抽稀。 */
export function toDetectFeedbackPreview(
  deviceId: string,
  frame: Fa371DetectFeedbackFrame
): Fa371DetectFeedbackPreview {
  const preview: Fa371DetectFeedbackPreview = {
    deviceId,
    kind: 'detectFeedback',
    timestamp: frame.receivedAt,
    logs: frame.logs
  }
  // 原样带出包络字段（手册没规定失败包的样子，见 §8.4 D7/D11）。
  if (frame.rawRet !== undefined) preview.rawRet = frame.rawRet
  if (frame.rawMsg !== undefined) preview.rawMsg = frame.rawMsg
  return preview
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 交错多声道 -> 单声道；单声道时原样返回（不复制）。 */
function downmixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples
  const frames = Math.floor(samples.length / channels)
  const mono = new Float32Array(frames)
  for (let index = 0; index < frames; index += 1) {
    let sum = 0
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[index * channels + channel] ?? 0
    }
    mono[index] = sum / channels
  }
  return mono
}

/** 去重 + 保持调用方给的顺序 + 丢掉非法的通道名。 */
function normaliseKinds(kinds: readonly Fa371StreamKind[]): Fa371StreamKind[] {
  const seen = new Set<Fa371StreamKind>()
  for (const kind of kinds) {
    if (FA371_STREAM_KINDS.includes(kind)) seen.add(kind)
  }
  return [...seen]
}

/** 设备记录里的地址 -> HTTP base URL（与 `device-service.baseUrlFor` 同一规则）。 */
function httpBaseUrlOf(device: Device): string | undefined {
  const address = device.ip?.trim()
  if (!address) return undefined
  if (/^https?:\/\//i.test(address)) return address
  const port = device.httpPort ?? 80
  return port === 80 ? `http://${address}` : `http://${address}:${port}`
}

function defaultClientFactory(options: Fa371WsClientOptions): Fa371WsClient {
  return new Fa371WsClient(options)
}
