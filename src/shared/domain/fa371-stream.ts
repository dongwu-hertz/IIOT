/**
 * FA371 在线声学相机 —— 实时 WebSocket 流的领域模型（手册 §5.2）。
 *
 * 契约链：WebSocket 原始字节 -> [fa371-ws-client 解码] -> 本文件 -> Store -> UI。
 * 本层只描述"主进程交给渲染层的东西"，不含任何固件键名：
 * `/detectFeedback` 的 JSON 键名留在 `device/fa371/dto.ts` + `mappers.ts`。
 *
 * ---------------------------------------------------------------------------
 * 与 AE08（`monitoring.ts`）**刻意不合并**
 * ---------------------------------------------------------------------------
 * AE08 的 `StreamKind` = features/audio/spectrum/spectrogram，订阅靠每秒一次的
 * ping，payload 形状已实测。FA371 的五路是**另一套**：路径不同、推送节奏不同、
 * 无需订阅消息、且手册把它们的数据排布全部标为未定义（规格 §8.4 D2–D6）。
 * 把两套塞进同一个联合类型会让 `hasChannel`/`profile` 这些 AE08 专属概念
 * 泄漏到相机路径，也会让"到底哪一路是未验证的"变得看不出来。
 * 因此这里是**第二套具名类型**，而不是对 `StreamKind` 的扩展。
 *
 * ---------------------------------------------------------------------------
 * 手册未定义处（规格 §8.4）在本层的体现
 * ---------------------------------------------------------------------------
 * 1) **字节序（D2）**：`endianness` 字段随每一帧一起走。默认 `little`——
 *    这仍然是**离线 mock 的选择**，不是设备给出的证据（`scripts/mock-fa371.cjs`
 *    的 WS_GUESSES 明写 "all binary payloads are LITTLE endian"）。真机实测
 *    （2026-09-15，192.168.110.235）证明大小端都能解出自洽数字，而手册对谱线
 *    的标度/单位一字未提，所以**这一点至今没有证据可判**，如实标注。
 * 2) **元素宽度/图像几何/声道数（D3–D5）**：全部由
 *    `fa371-ws-client.FA371_DECODE_CANDIDATES` 的具名候选决定，
 *    本层只把"实际用了哪一份假设"（`decodeProfile`）如实带出来。
 *    **默认候选是实测值**（见 `FA371_STREAM_MEASURED`），mock 的那份仍然作为
 *    非默认备选存在。
 * 3) **握手认证（D1）**：`Fa371StreamStatus.handshakeAuthId` 记录**哪个候选
 *    最终被接受**，未确认前是 `undefined`——UI 与 Protocol Lab 都能看到
 *    "这条连接是按哪种假设建立的"。
 * 4) **帧长校验**：`Fa371StreamStatus.layoutWarning` / `layoutNote` 记录"当前帧长
 *    与所选候选是否一致"。实测已经推翻过一份几何假设，帧长是运行期唯一能证伪
 *    假设的证据；不一致必须可见，而不是解出一堆看着合理的数字。
 */

// 复用连接状态联合类型：连接生命周期由同一个 `WebSocketStream` 实现驱动，
// 再造一个同义的联合只会让两处慢慢漂移。
import type { StreamState } from './models'
import type { Fa371DetectLog } from './fa371'

export type { StreamState }

// ---------------------------------------------------------------------------
// 通道
// ---------------------------------------------------------------------------

/**
 * 五路 WebSocket 通道的**稳定标识**。
 *
 * 取值即手册路径去掉斜杠后的 camelCase（`/fftData` -> `fftData`），
 * 这样日志、IPC 推送与 Protocol Lab 报告里的名字与手册逐字一致。
 * 这些标识符同时也是"哪一路"的枚举，**不是**可翻译文案，
 * 所以不放进 i18n catalogue。
 */
export type Fa371StreamKind = 'fftData' | 'voiceprintData' | 'energyData' | 'pcmData' | 'detectFeedback'

/**
 * 运行时清单。与联合类型写在一起，两者不可能漂移；
 * 标注为全量是为了"以后再加一路却忘了改这里"能在编译期暴露。
 */
export const FA371_STREAM_KINDS: readonly Fa371StreamKind[] = [
  'fftData',
  'voiceprintData',
  'energyData',
  'pcmData',
  'detectFeedback'
]

/** 手册 §5.2 给出的路径（大小写必须逐字一致，否则 404）。 */
export const FA371_STREAM_PATHS: Readonly<Record<Fa371StreamKind, string>> = {
  fftData: '/fftData',
  voiceprintData: '/voiceprintData',
  energyData: '/energyData',
  pcmData: '/pcmData',
  detectFeedback: '/detectFeedback'
}

/** 通道的载荷种类，供渲染层决定用哪个面板显示。 */
export type Fa371StreamPayloadKind = 'int16' | 'int32' | 'float32' | 'json'

/** 手册声明的推送节奏（`perSecond` 是**文档值**，不是实测值）。 */
export interface Fa371StreamSpec {
  kind: Fa371StreamKind
  path: string
  /** 手册声明的平均推送频率（次/秒）；`energyData` 手册只写 "regularly"。 */
  perSecond?: number
  payload: Fa371StreamPayloadKind
  /** 手册中原话的推送频率描述，用于诊断输出。 */
  cadence: string
  /** 该通道手册未定义的地方（规格 §8.4 的编号）。 */
  specRefs: string
}

/**
 * 一台真机（192.168.110.235）上**实测**到的五路参数。
 *
 * 用途有两个，都是"不要把实测结论散落在注释里"：
 *   - 离线工具与测试可以直接引用这些常量（写死数字的测试迟早会和现实脱节）；
 *   - 界面显示"实测 vs 手册"时不必再硬编码一遍。
 *
 * 测量方法：对每路单独开一个 WebSocket，6 s 窗口内统计到达帧数与总字节数，
 * 并打印每帧前 16 字节与帧长分布。测于 **2026-09-15**。
 */
export interface Fa371StreamMeasurement {
  /** 平均帧率（帧/秒）。 */
  fps: number
  /** 每帧字节数；逐帧变化时给典型值。 */
  bytesPerFrame: number
  /** `false` = 帧长逐帧变化（压缩图像）。 */
  fixedFrameBytes: boolean
  /** 该路帧长的实测说明（含推导）。 */
  layout: string
}

export const FA371_STREAM_MEASURED: Readonly<Record<Fa371StreamKind, Fa371StreamMeasurement>> = {
  fftData: {
    fps: 10.06,
    bytesPerFrame: 2052,
    fixedFrameBytes: true,
    layout: '4 字节前缀（恒为 0）+ 1024 个 int16 小端 = 2052 B'
  },
  voiceprintData: {
    fps: 10.07,
    bytesPerFrame: 45_200,
    fixedFrameBytes: false,
    layout: 'JPEG（JFIF/SOF0 600×400、3 分量、基线），逐帧 44853–45460 B'
  },
  energyData: {
    fps: 29.92,
    bytesPerFrame: 20,
    fixedFrameBytes: true,
    layout: '5 个 int32 小端（能量、像素横、像素纵、扫描角、方位角）= 20 B'
  },
  pcmData: {
    fps: 10.0,
    bytesPerFrame: 19_200,
    fixedFrameBytes: true,
    layout: '4800 个 float32 小端 = 19200 B/帧；10 帧/s → 48000 样本/s，与手册 48 kHz 自洽'
  },
  detectFeedback: {
    fps: 0,
    bytesPerFrame: 0,
    fixedFrameBytes: false,
    layout: '6 s 窗口内 0 帧（事件流：一次检测一包，无检测即无帧，实测无法判定帧类型）'
  }
}

/**
 * 手册声明的通道参数（§5.2.1 – §5.2.5）。
 *
 * 注意 `detectFeedback` 的 `payload: 'json'`：手册自相矛盾
 * （"JSON strings" vs "parsed in byte order"，D7），mock 选择推到**文本帧**。
 * 客户端两种帧都解码，所以这里的取值只影响显示提示，不影响解析路径。
 *
 * 真机实测后 `cadence` 同时写手册值与实测值：两者不一致的地方（`/energyData`
 * 实测约 30 帧/s、`/voiceprintData` 实测 10 帧/s 而不是 1 帧/s、`/pcmData`
 * 每帧 100 ms 而不是 1 s）必须一眼看得出，否则界面会照着手册的 1 Hz 去解释
 * 一个 10 Hz 的流。
 */
export const FA371_STREAM_SPECS: Readonly<Record<Fa371StreamKind, Fa371StreamSpec>> = {
  fftData: {
    kind: 'fftData',
    path: '/fftData',
    perSecond: 5,
    payload: 'int16',
    cadence: '手册 5 次/秒（§5.2.1）；实测 10.06 次/秒、2052 B/帧',
    specRefs: '§8.4 D2（字节序）、D3（"512" 是点数还是字节 —— 实测 1024 点 + 4 字节前缀）'
  },
  voiceprintData: {
    kind: 'voiceprintData',
    path: '/voiceprintData',
    perSecond: 1,
    payload: 'int32',
    cadence: '手册 1 帧/秒（§5.2.2）；实测 10.07 帧/秒、JPEG 约 45 kB/帧',
    specRefs: '§8.4 D2、D4（位宽/宽高/通道/像素格式全未定义 —— 实测推的是 JPEG 图像，不是数值矩阵）'
  },
  energyData: {
    kind: 'energyData',
    path: '/energyData',
    payload: 'int32',
    cadence: '手册只说 "regularly"（§5.2.4）；实测 29.92 帧/秒、20 B/帧',
    specRefs: '§8.4 D2、D6（周期与单位未定义）'
  },
  pcmData: {
    kind: 'pcmData',
    path: '/pcmData',
    payload: 'float32',
    perSecond: 1,
    cadence: '手册 1 次/秒、采样率 48 kHz（§5.2.5）；实测 10.00 帧/秒、19200 B/帧 = 100 ms/帧',
    specRefs: '§8.4 D2、D5（声道数与每帧点数未定义 —— 实测每帧 4800 点、10 帧/s）'
  },
  detectFeedback: {
    kind: 'detectFeedback',
    path: '/detectFeedback',
    payload: 'json',
    cadence: '每次检测结束后一包（§5.2.3）；实测 6 s 内 0 帧（事件流）',
    specRefs: '§8.4 D7（文本帧还是二进制帧未定义）、D11'
  }
}

/** 手册对 `pcmData` 明确给出的采样率；其余参数未定义。 */
export const FA371_PCM_SAMPLE_RATE_HZ = 48_000

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

/**
 * 单路通道的运行状态。
 *
 * 与 AE08 的 `StreamState` 同名同义（复用同一个联合类型，不新造一套），
 * 因为连接生命周期是**同一件事**：由同一个 `WebSocketStream` 实现驱动。
 */

/** 一次成功握手所用的认证携带方式被"确认"到什么程度。 */
export type Fa371HandshakeCertainty =
  /** 连接建立并收到过帧——最有说服力的证据。 */
  | 'confirmed-by-frame'
  /** 连接建立但还没收到帧；服务端可能仍在准备数据。 */
  | 'unconfirmed'

/**
 * "当前帧长与所选解码候选不一致"的**稳定 id**。
 *
 * 为什么不直接把一段中文/英文句子交给渲染层：告警要在四种语言里显示，文案属于
 * 目录；主进程只负责说清"是哪一类不一致"。`layoutNote` 里另有英文技术细节
 * （字节数与候选 id），那部分是数字与标识符，不需要翻译。
 */
export type Fa371LayoutWarning =
  /** 帧长与候选期望的固定几何对不上（最可能：候选选错了）。 */
  | 'frame-size-mismatch'
  /** 帧比候选声明的载荷前缀还短（连前缀都没装下）。 */
  | 'frame-too-short'
  /** 收到 0 字节的帧。 */
  | 'empty-frame'
  /** 候选声明是图像，但帧首不是 JPEG 魔数。 */
  | 'voiceprint-not-jpeg'

/** 一路通道的连接状态快照。 */
export interface Fa371StreamStatus {
  deviceId: string
  kind: Fa371StreamKind
  state: StreamState
  /** 自上次成功连接以来的重连次数。 */
  retries: number
  /** 最近一帧的到达时刻（epoch ms）。 */
  lastFrameAt?: number
  lastError?: string
  /** 已收到的帧数，用于诊断"连着但没数据"。 */
  frameCount: number
  /** 最近一帧的字节数；`voiceprintData` 用它暴露真实几何。 */
  lastFrameBytes?: number
  /**
   * 当前帧长校验的结论：`undefined` = 帧长与候选一致（或这一路本来就无法校验）。
   *
   * 这是"用错了假设"在界面上的唯一出口。没有它，错误候选的症状就是
   * "图上有一条看起来挺合理的曲线"。
   */
  layoutWarning?: Fa371LayoutWarning
  /** 技术细节（英文、含字节数与候选 id），用于日志与悬停提示。 */
  layoutNote?: string
  /** 当前这条 layoutWarning 已经命中了多少帧（结论变化时归零）。 */
  layoutMismatches?: number
  /** 实际生效的握手携带方式 id；未确认时为 undefined（§8.4 D1）。 */
  handshakeAuthId?: string
  /** 这个 id 的确认程度。 */
  handshakeCertainty?: Fa371HandshakeCertainty
}

// ---------------------------------------------------------------------------
// 解码后的帧
// ---------------------------------------------------------------------------

/** 一帧解码结果里"用了哪一套假设"的记录（规格 §8.4 D2–D6）。 */
export interface Fa371DecodeProfile {
  /** 候选 id，例如 `int16-le-512`。 */
  id: string
  /** 字节序；默认 little 来自 mock，不是设备（见本文件头部说明）。 */
  endianness: 'little' | 'big'
  /** 元素位宽。 */
  elementBits: number
  /** 元素是否有符号（float32 为 true 表示"有符号浮点"，仅为记录）。 */
  signed: boolean
}

/** `/fftData`：FFT 前半段，16-bit 整数（§5.2.1）。 */
export interface Fa371FftFrame {
  kind: 'fftData'
  /** 原始字节（视图，不复制）。 */
  bytes: Uint8Array
  /** 解码后的整数谱线（视图或一次性解码结果，不按订阅者复制）。 */
  values: Int16Array
  /** 手册说 "length of 512"；实测是 1024（D3 未定义）。 */
  binCount: number
  profile: Fa371DecodeProfile
  receivedAt: number
  /** 连接内递增序号。 */
  sequence: number
}

/**
 * `/voiceprintData`：**实测是 JPEG 图像**（§5.2.2 / D4）。
 *
 * 手册说 "int-type"，mock 据此假设 128×256×int32 幅度矩阵；真机推的是
 * 600×400 的基线 JPEG。因此本类型同时容纳两种读法，用 `jpegBase64` 是否存在
 * 区分：JPEG 候选下 `values` 为空、`width`/`height` 为 0（**不编造几何**），
 * 数值候选下反过来没有 `jpegBase64`。渲染层据此选画布或 `<img>`。
 */
export interface Fa371VoiceprintFrame {
  kind: 'voiceprintData'
  bytes: Uint8Array
  /** 解码后的幅度（`int32` 或 `float32` 候选）；JPEG 候选下为空数组。 */
  values: Int32Array | Float32Array
  /** 按假设切出的矩阵尺寸；JPEG 候选下为 0（实测不是矩阵，不猜尺寸）。 */
  width: number
  height: number
  channels: number
  /** 帧内容是 JPEG 时带出的 base64（原始字节，未重新编码）。 */
  jpegBase64?: string
  profile: Fa371DecodeProfile
  receivedAt: number
  sequence: number
}

/**
 * `/energyData` 的一个目标点（§5.2.4 原文顺序）。
 *
 * 手册明确给出每组 5 个 32-bit int 的顺序，但**单位与标度全部未定义**（D6），
 * 因此字段名只描述手册用词，不做任何换算。
 */
export interface Fa371EnergyTarget {
  /** `energy`，单位未定义（D6）。 */
  energy: number
  /** `pixel transverse coordinate`，坐标系未定义。 */
  pixelX: number
  /** `pixel longitudinal coordinate`，坐标系未定义。 */
  pixelY: number
  /** `swath angle`，单位/符号约定未定义。 */
  swathAngle: number
  /** `azimuth angle`，单位/符号约定未定义。 */
  azimuthAngle: number
}

/** `/energyData`：若干组目标点（组数 = 当前目标数量，最多 3）。 */
export interface Fa371EnergyFrame {
  kind: 'energyData'
  bytes: Uint8Array
  values: Int32Array
  /** 按 5 个一组切分出的目标点；组数由帧长决定，不假设。 */
  targets: Fa371EnergyTarget[]
  profile: Fa371DecodeProfile
  receivedAt: number
  sequence: number
}

/** `/pcmData`：48 kHz float32 实时音频（§5.2.5）。 */
export interface Fa371PcmFrame {
  kind: 'pcmData'
  bytes: Uint8Array
  /** 单声道交错样本；声道数未定义（D5），按 `channels` 解读。 */
  samples: Float32Array
  sampleRate: number
  /** 按假设解码出的声道数。 */
  channels: number
  profile: Fa371DecodeProfile
  receivedAt: number
  sequence: number
}

/**
 * `/detectFeedback`：一次检测结束后的 JSON（§5.2.3）。
 *
 * `log` 是**域模型**（`Fa371DetectLog`），不是线上 JSON——映射由
 * `mappers.mapDetectLogs` 完成，本层不碰固件键名。
 * `rawRet`/`rawMsg` 原样保留：手册没有规定失败包的形状（D7/D11），
 * 与其猜，不如把包络交给调用方判读。
 */
export interface Fa371DetectFeedbackFrame {
  kind: 'detectFeedback'
  bytes: Uint8Array
  /** 原始文本（文本帧内容，或二进制帧按 UTF-8 解出的内容）。 */
  text: string
  /** 是否由文本帧送达；`false` = 二进制帧里装 JSON（D7）。 */
  textFrame: boolean
  /** 解析出的检测日志；一条都认不出来时是空数组，绝不抛。 */
  logs: Fa371DetectLog[]
  rawRet?: unknown
  rawMsg?: unknown
  receivedAt: number
  sequence: number
}

/** 五路通道联合。判别字段是 `kind`。 */
export type Fa371Frame =
  | Fa371FftFrame
  | Fa371VoiceprintFrame
  | Fa371EnergyFrame
  | Fa371PcmFrame
  | Fa371DetectFeedbackFrame

// ---------------------------------------------------------------------------
// 送给渲染层（经 IPC）的**抽取后**载荷
// ---------------------------------------------------------------------------

/**
 * 为什么 IPC 上不是原始帧（对应任务要求的"抽稀说明"）
 *
 * 下面两列**同时给出手册/mock 的假设与真机实测**，因为两者差着一个数量级，
 * 而"为什么抽稀"的结论必须建立在真实速率上：
 *
 *   通道              mock 假设                 真机实测（2026-09-15）
 *   /pcmData          1 × 192000 B/s            10 × 19200 B/s = 192000 B/s（巧合相同）
 *   /voiceprintData   1 × 131072 B/s            10 × ~45200 B/s ≈ 452000 B/s
 *   /fftData          5 × 1024 B/s              10.06 × 2052 B/s ≈ 20643 B/s
 *   /energyData       ~20 B/s                  29.92 × 20 B/s ≈ 598 B/s
 *   /detectFeedback   ~1 KB/次                 6 s 内 0 帧（事件流）
 *
 * 推给渲染层的东西因此是：
 *   /pcmData         -> 512 点包络 + peak/rms（原始 4800 点/帧留在主进程）
 *   /voiceprintData  -> 原样的 JPEG base64（设备已经渲染好了，再抽稀只会更差）
 *   /fftData         -> 1024 个整数（本身就是显示尺寸，去掉字节包装）
 *   /energyData      -> 不抽稀
 *   /detectFeedback  -> 不抽稀
 *
 * 数字数组走 structured clone（比 base64 小 33%），且这些尺寸都已是显示尺寸，
 * 所以渲染层不需要再算一遍。**唯一走 base64 的是 JPEG**——它按定义就是字节流，
 * 渲染层的 `<img>` 直接吃它。原始 PCM 字节**永远留在主进程**（AE08 实测过
 * 3.8 MB/s 过 IPC 会直接把桥打满）。
 */
export interface Fa371FftPreview {
  deviceId: string
  kind: 'fftData'
  timestamp: number
  /** 谱线（int16 计数，未做 dB / 单位换算——手册未定义）。 */
  bins: number[]
  binCount: number
  /**
   * 每根谱线对应的频率宽度（Hz）；设备采样率不可知时为 `undefined`。
   *
   * 实测（2026-09-15）这台相机**没有任何 HTTP 接口能给出采样率**
   * （`GET /get_samplingrate` 返回 SPA 的 HTML，设备只暴露 Web 界面）。
   * 因此这里**不填一个"大概是 200 kHz"的猜测值**：渲染层拿不到 binHz 时
   * 只按"第 N 根谱线"标注坐标轴，并说明频率轴未知——一个编造的 Hz 轴比没有轴更糟。
   */
  binHz?: number
}

/**
 * `/voiceprintData` 预览。
 *
 * 两条路径互斥，取决于 `jpegBase64` 是否存在：
 *   - 真机（实测）：JPEG 图像，`jpegBase64` 有值，`cells` 为空、宽高为 0；
 *   - mock/数值候选：抽稀后的幅度矩阵，`cells` 有值、`jpegBase64` 无值。
 *
 * 之所以让两种都存在而不是删掉数值那一路：离线 mock（`scripts/mock-fa371.cjs`）
 * 仍然按矩阵造字节，测试也仍然覆盖它；而"另一种读法"随时可能是下一批固件的真相。
 */
export interface Fa371VoiceprintPreview {
  deviceId: string
  kind: 'voiceprintData'
  timestamp: number
  /** 行优先的抽稀幅度矩阵，长度 `width * height`；JPEG 帧下为空数组。 */
  cells: number[]
  width: number
  height: number
  /** 原始帧尺寸与抽稀比例，便于诊断"看到的是不是全图"（JPEG 帧下为 0）。 */
  sourceWidth: number
  sourceHeight: number
  decimation: number
  /** 设备渲染好的 JPEG（base64），存在时渲染层直接喂 `<img>`。 */
  jpegBase64?: string
  /** JPEG 原始字节数（诊断用：一帧有多大）。 */
  jpegBytes?: number
}

export interface Fa371EnergyPreview {
  deviceId: string
  kind: 'energyData'
  timestamp: number
  targets: Fa371EnergyTarget[]
}

export interface Fa371PcmPreview {
  deviceId: string
  kind: 'pcmData'
  timestamp: number
  /** 峰值，驱动电平表。 */
  peak: number
  /** RMS，驱动平均电平条。 */
  rms: number
  /** 抽稀后的有符号包络（保留极值，不平均）。 */
  waveform: number[]
  sampleRate: number
  channels: number
  /** 源帧包含的样本数（按假设解码）；实测 4800 = 48 kHz 下的 100 ms。 */
  samples: number
  /**
   * 源帧时长（毫秒），由 `samples / sampleRate` 算出。
   *
   * 界面靠它说"这一帧多长"。实测 100 ms/帧（手册的"每秒 1 次"是 mock 的误读），
   * 没有这个字段界面就只会显示样本数，操作员无法判断是 0.1 s 还是 1 s。
   */
  frameMs: number
}

export interface Fa371DetectFeedbackPreview {
  deviceId: string
  kind: 'detectFeedback'
  timestamp: number
  logs: Fa371DetectLog[]
  rawRet?: unknown
  rawMsg?: unknown
}

/** 渲染层收到的一帧（联合，判别字段 `kind`）。 */
export type Fa371StreamPreview =
  | Fa371FftPreview
  | Fa371VoiceprintPreview
  | Fa371EnergyPreview
  | Fa371PcmPreview
  | Fa371DetectFeedbackPreview

// ---------------------------------------------------------------------------
// 会话状态（UI 对账）
// ---------------------------------------------------------------------------

/**
 * 一台相机当前在推什么。
 *
 * **形状与 AE08 的 `MonitorState` 对齐但类型独立**：`running` 是 FA371 自己的
 * 五路标识。`channelId` 恒为 `0` 并保留，是因为渲染层的监视页对两种设备用同一套
 * 布局，缺字段会让那边多一个分支。
 *
 * `buffered` 说明"主进程留了多少原始数据"：只有 `/pcmData` 进环形缓冲，
 * 上限按秒数给出（见 `fa371-ws-client.Fa371WsClientOptions.pcmBufferSeconds`）。
 */
export interface Fa371MonitorState {
  deviceId: string
  /** 相机没有通道概念（§6 用户模型），恒为 0；保留以对齐 `MonitorState`。 */
  channelId: number
  /** 当前正在跑的通道。 */
  running: Fa371StreamKind[]
  recording: false
  /** 每路通道的连接状态快照，供 UI 逐路显示健康度。 */
  streams: Fa371StreamStatus[]
  /** 握手认证候选最终采用哪一个；一个都没确认时缺省（§8.4 D1）。 */
  handshakeAuthId?: string
  /** `/pcmData` 的解码假设（声道数、采样率、缓冲深度）。 */
  pcm?: {
    sampleRate: number
    channels: number
    /** 环形缓冲保留的原始秒数。 */
    bufferSeconds: number
    /** 因为缓冲已满而丢弃的最旧帧数。 */
    droppedFrames: number
    /** 实测每帧时长（毫秒）：4800 样本 / 48 kHz = 100 ms。 */
    frameMs: number
  }
  /**
   * 设备**自己报告**的采样率，如果这一批固件有接口可以读到。
   *
   * 实测（2026-09-15，192.168.110.235）：这台相机**没有任何可用的 HTTP 采样率
   * 接口**（`GET /get_samplingrate` 返回的是 Web 界面的 HTML），所以主进程
   * 留 `undefined`。字段保留是因为渲染层需要一个**诚实的空位**：拿不到就显示
   * "设备未上报"，而不是拿 `/pcmData` 的 48 kHz 去冒充 FFT 的频率轴刻度。
   */
  deviceSampleRate?: number
  /** 生效的解码候选 id（每路一个），供 Protocol Lab 报告"按哪套假设解的"。 */
  decodeProfiles: Partial<Record<Fa371StreamKind, string>>
  /**
   * 每路帧长校验的结论，只有出问题时才有条目。
   *
   * 与 `streams[].layoutWarning` 同源，这里单独给一份是为了让界面不必遍历五个
   * 状态对象才能回答"现在有没有用错假设"。
   */
  layoutWarnings?: Partial<Record<Fa371StreamKind, string>>
}

/** 启动一路或多路通道的入参（IPC 用）。 */
export interface Fa371StreamSubscription {
  deviceId: string
  kinds: Fa371StreamKind[]
}
