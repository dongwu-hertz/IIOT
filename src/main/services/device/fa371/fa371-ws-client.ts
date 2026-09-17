/**
 * Fa371WsClient —— FA371 在线声学相机实时 WebSocket 流的客户端（手册 §5.2）。
 *
 *   手册 §5.2（5 个接口）
 *        -> [本文件] 握手认证候选 / 解码候选 / 心跳 / 重连 / 清理
 *        -> `@shared/domain/fa371-stream` 类型化帧
 *        -> `fa371-stream-service.ts` 抽稀后推渲染层
 *
 * ---------------------------------------------------------------------------
 * 1) 本文件没有第二个 socket 层
 * ---------------------------------------------------------------------------
 * 帧的搬运、状态机、指数退避 + 抖动、`stop()` 的彻底解绑，全部复用
 * `../stream/websocket-stream` 的 `WebSocketStream`（AE08 实测验证过的同一个类）。
 * 本文件只负责**相机特有的三件事**：
 *   a. 握手认证候选（手册 §8.4 D1 完全未说明）；
 *   b. 五路 payload 的解码（§8.4 D2–D6 完全未说明）；
 *   c. 心跳内容（手册只要求"每分钟至少发一条任意内容"，§8.4 D8）。
 *
 * ---------------------------------------------------------------------------
 * 2) 握手认证（D1）：候选集 + 记住胜者，而不是挑一个写死
 * ---------------------------------------------------------------------------
 * 与 `auth-strategy.ts` 建模 Token 携带方式的做法**同构**：给一个具名候选表，
 * 逐条尝试，第一条"被接受"的胜出并记住。判定"被接受"的证据只有两条，
 * 因为 Chromium/Node 的 WebSocket 不暴露被拒握手的 HTTP 状态码：
 *   - **收到第一帧** → 确认（`confirmed-by-frame`）；
 *   - 连接开着但 `candidateProbeMs` 内一帧都没有 → 视为未被真正接受，换下一条。
 * 胜出的 id 由 `WebSocketStream` 通过 `onStatus.handshakeAuthId` 带出，
 * 本文件再写进 `Fa371StreamStatus` 与日志——**未确认前不谎报**。
 *
 * ---------------------------------------------------------------------------
 * 3) 解码假设（D2–D6）：具名候选 + 显式默认，绝不藏在解码路径里
 * ---------------------------------------------------------------------------
 * 每一路的元素类型/字节序/几何都是 `Fa371DecodeOptions` 里一个**具名候选**
 * （`Fa371DecodeOptions` 的 `*_CANDIDATES`），构造时选定、实例上可读，
 * Protocol Lab 以后可以直接换一份重放同一段字节。
 *
 * **默认候选现在全部来自真机实测（2026-09-15，192.168.110.235），不再来自 mock。**
 * mock 的 WS_GUESSES 是明确标注的猜测，实测把它推翻了四处；被推翻的那份假设
 * **仍然保留在候选表里**（`*_mock` 后缀），因为它记录的是"另一种读法"，
 * 而且离线 mock（`scripts/mock-fa371.cjs`）仍然按那份假设造字节、测试也仍然喂它。
 *
 *   通道               实测（6000 ms 窗口）                 mock 的猜测
 *   /fftData           2052 B × 10.06/s = 1024×int16 + 4B 头 512×int16（1024 B）
 *   /voiceprintData    JPEG 图像 45 kB × 10.07/s，600×400      128×256×int32 幅度矩阵
 *   /energyData        20 B × 29.92/s = 5×int32（与猜测一致）  5×int32（一致）
 *   /pcmData           19200 B × 10.00/s = 4800×float32        48000×float32（192000 B）
 *   /detectFeedback    6 s 内 0 帧（事件流，无检测即无帧）      文本 JSON
 *
 * 只有字节序仍然是"沿用 mock、未经证实"的一项（D2）：真机上大小端两种读法都
 * 解得出自洽的数字，而手册对谱线标度/单位一字未提，所以换不动——这一点在
 * 下面 `endianness` 的注释里逐条说明，不假装它是实测结论。
 *
 * ---------------------------------------------------------------------------
 * 3b) 帧长不符时绝不"照解不误"
 * ---------------------------------------------------------------------------
 * 实测已经证明 mock 的几何是错的（2052 vs 1024、19200 vs 192000）。既然帧长
 * 是唯一能在运行时校验假设的证据，`checkFrameLayout()` 就把它变成一条**可见的
 * 事实**：帧长与候选期望不一致时，`Fa371StreamStatus.layoutWarning` 带出稳定的
 * 机器可读 id、`layoutNote` 带出实际字节数，界面与日志据此显示"按错误假设解的"，
 * 而不是画出一条看起来合理的假曲线。
 *
 * 需要注意**哪些不一致是允许的**：JPEG 帧长天然逐帧变化，`/pcmData` 的帧长
 * 也确实可以因设备而不同；这两种情况在候选里用 `jpeg` / `pcmFrameSamples: 0`
 * 显式声明，因此不会误报。真正会被标记的是"按固定几何解，但字节数对不上"。
 *
 * ---------------------------------------------------------------------------
 * 4) 缓冲策略（192 000 B/s 的音频）
 * ---------------------------------------------------------------------------
 * 帧**只解码一次**：`values`/`samples` 是原始 `ArrayBuffer` 上的视图或一次性
 * 解码结果，所有监听者共享同一个对象，**不按订阅者复制**。因此订阅者数量
 * 与内存无关（AE08 的 IPC 桥曾因"每订阅者一份"把内存翻倍）。
 *
 * `/pcmData` 每秒 192 000 字节，不能无界累积：本类只保留最近
 * `pcmBufferSeconds`（默认 5 秒）的原始样本，放在一个**固定容量、覆盖最旧**的
 * 环形缓冲里，容量在构造时就按 `sampleRate × channels × 4 × seconds` 算死，
 * 之后不再分配。被覆盖的旧帧计入 `droppedFrames`，通过 `pcmBufferState()`
 * 暴露给 UI/诊断——"丢了多少"必须是可见数字，而不是静默的。
 * 其余四路只有"最近一帧"有意义（FFT 是实时谱、声纹是滚动图、能量点是当前
 * 目标、检测结果是事件），因此不缓冲。
 */

import { EventEmitter } from 'node:events'
import { AppError, ErrorCodes } from '@shared/errors'
import {
  FA371_PCM_SAMPLE_RATE_HZ,
  FA371_STREAM_KINDS,
  FA371_STREAM_PATHS,
  FA371_STREAM_SPECS,
  type Fa371DecodeProfile,
  type Fa371DetectFeedbackFrame,
  type Fa371EnergyFrame,
  type Fa371EnergyTarget,
  type Fa371FftFrame,
  type Fa371Frame,
  type Fa371HandshakeCertainty,
  type Fa371LayoutWarning,
  type Fa371PcmFrame,
  type Fa371StreamKind,
  type Fa371StreamStatus,
  type Fa371VoiceprintFrame
} from '@shared/domain/fa371-stream'
import { deviceLog } from '../../logging/logger'
import { mapDetectLogs } from '../fa371/mappers'
import {
  WebSocketStream,
  type HandshakeAuthCandidate,
  type StreamFrame,
  type StreamProfile,
  type StreamStatus
} from '../../stream/websocket-stream'

// ---------------------------------------------------------------------------
// 握手认证候选（§8.4 D1）
// ---------------------------------------------------------------------------

/**
 * 一次 WebSocket 握手在"是否认证、怎么认证"上的候选。
 *
 * 排序依据是**真机实测（2026-09-15，192.168.110.235）+ 手册字面读法**：
 *   1. `none` —— 实测胜出：四个候选（不带认证 / `?token=` / `?Authorization=` /
 *      `?access_token=`）各自单独跑 6 s 窗口，结果**逐字节相同**
 *      （60 帧 / 123120 字节 / 全部 open-no-frames 然后开始推流）。
 *      也就是说这台固件的握手不需要认证，`none` 是唯一不自作主张的选项。
 *   2. `raw-auth-query` —— 手册 §2.2 的字面读法，FA371 的 HTTP 侧 §8.1 A1 也把
 *      `Authorization` 排在第一位。**保留它不是冗余**：实测只覆盖了当前这一台
 *      固件/这一批机器，换一台设备完全可能要求认证，候选表存在的意义就是不把
 *      "这一批不需要" 硬编码成 "永远不需要"。
 *   3. `token-query` —— AE08 已实测可行、且浏览器 WebSocket 唯一能自行附加的形式
 *      （`WebSocketStream` 的注释说明了为什么）。
 *
 * **`Authorization: Bearer <token>` 与自定义头 `token:` 没有列进来**：
 * 本项目的 WebSocket 实现用的是 `new WebSocket(url)`（Node 22 / Electron 38
 * 的全局实现），它**无法设置请求头**，列一个发不出去的候选只会制造
 * "试过了但其实是同一件事"的假象。真机一旦证明头是必须的，需要的是换传输实现，
 * 而不是在这里多加一行（这也正是把它建模成候选而不是写死一个值的原因）。
 */
export const FA371_WS_AUTH_CANDIDATES: readonly HandshakeAuthCandidate[] = [
  {
    id: 'none',
    description: '不带任何认证信息（mock 的行为；手册未说明如何认证）',
    kind: 'none'
  },
  {
    id: 'raw-auth-query',
    description: '?Authorization=<token>（Authorization 头在本项目 WebSocket 运行时无法发送，以同名 query 送达）',
    kind: 'query',
    name: 'Authorization'
  },
  {
    id: 'token-query',
    description: '?token=<token>（AE08 实测可行）',
    kind: 'query',
    name: 'token'
  }
]

/** 选择候选表：给未知 id 时回落到默认（配置可能来自设备记录）。 */
export function findWsAuthCandidates(
  id?: string
): readonly HandshakeAuthCandidate[] {
  if (!id || id === 'auto') return FA371_WS_AUTH_CANDIDATES
  const matched = FA371_WS_AUTH_CANDIDATES.find((candidate) => candidate.id === id)
  // 单一候选：把它排到最前，其余仍然跟在后面——"首选"不等于"只有这一条"。
  return matched
    ? [matched, ...FA371_WS_AUTH_CANDIDATES.filter((candidate) => candidate.id !== matched.id)]
    : FA371_WS_AUTH_CANDIDATES
}

// ---------------------------------------------------------------------------
// 解码候选（§8.4 D2–D6）
// ---------------------------------------------------------------------------

/** 一条解码假设：元素类型 + 字节序 + 该路的几何参数。 */
export interface Fa371DecodeCandidate {
  id: string
  description: string
  /** 手册出处 / 规格缺口编号 / 实测记录。 */
  specRef: string
  endianness: 'little' | 'big'
  elementBits: number
  signed: boolean
  /**
   * 载荷前面要跳过的字节数。
   *
   * 实测（2026-09-15）：`/fftData` 每帧恰好 2052 B = **4 + 1024×2**。
   * 前 4 字节在 40 帧连续采样里恒为 `00 00 00 00`（既不是计数器也不是时间戳，
   * 按 u32 大小端读都是 0），所以它**不是可解释的头部，只是一个必须跳过的前缀**——
   * 本文件因此不假装知道它是什么，只如实跳过并在 `layoutNote` 里说明。
   */
  headerBytes?: number
  /** `/fftData`：谱线数量。手册说 "length of 512"，实测是 1024 个 int16。 */
  fftBins?: number
  /** `/voiceprintData`：矩阵尺寸（D4 —— 全部未定义；实测根本不是矩阵，见下）。 */
  voiceprintWidth?: number
  voiceprintHeight?: number
  voiceprintChannels?: number
  /** `/voiceprintData`：元素按 int32 还是 float32 解读（手册只说 "int-type"）。 */
  voiceprintElement?: 'int32' | 'float32'
  /** `/voiceprintData`：载荷是**图像**而不是数值矩阵（实测：JPEG）。 */
  jpeg?: boolean
  /** `/energyData`：每组目标点的 32-bit int 个数。手册原文明确是 5（D6 只缺单位）。 */
  energyGroupSize?: number
  /** `/pcmData`：声道数（D5 —— 单声道还是 128 麦阵列未说明）。 */
  pcmChannels?: number
  /** `/pcmData`：每帧样本数；0 = 由帧长决定。 */
  pcmFrameSamples?: number
}

/**
 * 五路的解码候选表（**默认值 = 真机实测**，2026-09-15，192.168.110.235）。
 *
 * 每一路都保留 mock 的那条假设（id 带 `mock` 后缀）作为**非默认备选**：
 * 它不是死代码——`scripts/mock-fa371.cjs` 仍然按它造字节，测试也用它验证数值
 * 解码路径，真机换上另一批固件时它也仍然是一种可能。删掉它只会让"另一种读法"
 * 从代码里消失，然后被重新发明一遍。
 */
export const FA371_DECODE_CANDIDATES: Readonly<Record<Fa371StreamKind, readonly Fa371DecodeCandidate[]>> = {
  fftData: [
    {
      id: 'int16-le-1024-h4',
      description: '4 字节前缀 + 1024 个 int16，小端（2052 字节/帧，实测）',
      specRef: '实测 2026-09-15：2052 B × 10.06/s；缺口 §8.4 D2/D3（"length of 512" 实测不是 512 点）',
      endianness: 'little',
      elementBits: 16,
      signed: true,
      headerBytes: 4,
      fftBins: 1024
    },
    {
      id: 'int16-be-1024-h4',
      description: '4 字节前缀 + 1024 个 int16，大端（帧长同为 2052 B）',
      specRef: '§8.4 D2（手册只说 "parse in byte order"；真机大小端都解得出自洽数字，故未证实）',
      endianness: 'big',
      elementBits: 16,
      signed: true,
      headerBytes: 4,
      fftBins: 1024
    },
    {
      id: 'int16-le-512-mock',
      description: '512 个 int16，小端、无前缀（1024 字节/帧 —— mock 的猜测，真机不符）',
      specRef: '手册 §5.2.1 "length of 512" 的字面读法；缺口 §8.4 D3（mock 的 WS_GUESSES 选择）',
      endianness: 'little',
      elementBits: 16,
      signed: true,
      fftBins: 512
    },
    {
      id: 'int16-le-256-h4',
      description: '4 字节前缀 + 256 个 int16（"length of 512" 按字节读）',
      specRef: '§8.4 D3（512 是点数还是字节未说明）',
      endianness: 'little',
      elementBits: 16,
      signed: true,
      headerBytes: 4,
      fftBins: 256
    }
  ],
  voiceprintData: [
    {
      id: 'jpeg-image-600x400',
      description: 'JPEG 图像帧（实测 600×400、3 分量、基线，约 45 kB，逐帧变化）',
      specRef: '实测 2026-09-15：ff d8 ff e0 … JFIF，SOF0 600×400；缺口 §8.4 D4（手册说 "int-type"，实测是图像）',
      endianness: 'little',
      elementBits: 8,
      signed: false,
      jpeg: true
    },
    {
      id: 'int32-le-128x256x1-mock',
      description: '128×256 单通道 int32，小端（131072 字节/帧 —— mock 的猜测，真机不符）',
      specRef: '手册 §5.2.2 "int-type" 的字面读法；缺口 §8.4 D2/D4（mock 的假设）',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      voiceprintWidth: 256,
      voiceprintHeight: 128,
      voiceprintChannels: 1,
      voiceprintElement: 'int32'
    },
    {
      id: 'float32-le-128x256x1-mock',
      description: '128×256 单通道 float32，小端',
      specRef: '§8.4 D4（"int-type" 的位宽与是否浮点未说明）',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      voiceprintWidth: 256,
      voiceprintHeight: 128,
      voiceprintChannels: 1,
      voiceprintElement: 'float32'
    },
    {
      id: 'int16-le-256x256x1-mock',
      description: '256×256 单通道 int16，小端',
      specRef: '§8.4 D4（int 的位宽未知）',
      endianness: 'little',
      elementBits: 16,
      signed: true,
      voiceprintWidth: 256,
      voiceprintHeight: 256,
      voiceprintChannels: 1,
      voiceprintElement: 'int32'
    }
  ],
  energyData: [
    {
      id: 'int32-le-groups5',
      description: '每组 5 个 int32（能量、像素横、像素纵、扫描角、方位角），小端（20 字节/帧，实测）',
      specRef: '实测 2026-09-15：20 B × 29.92/s，int32le = [16,895,85,14,279] 等；手册 §5.2.4 明确给出组内顺序；缺口 §8.4 D2/D6',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      energyGroupSize: 5
    },
    {
      id: 'int32-be-groups5',
      description: '每组 5 个 int32，大端（帧长同为 20 B）',
      specRef: '§8.4 D2（真机大小端读数差异极大，但手册未定义单位，无法据此判定）',
      endianness: 'big',
      elementBits: 32,
      signed: true,
      energyGroupSize: 5
    }
  ],
  pcmData: [
    {
      id: 'float32-le-mono-4800',
      description: '单声道 float32 小端，每帧 4800 点（19200 字节/帧 = 48 kHz 下的 100 ms，实测）',
      specRef: '实测 2026-09-15：19200 B × 10.00/s = 48000 样本/s，与手册 §5.2.5 的 48 kHz 一致；缺口 §8.4 D2/D5（声道数与每帧点数手册未说明）',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      pcmChannels: 1,
      pcmFrameSamples: 4_800
    },
    {
      id: 'float32-be-mono-4800',
      description: '单声道 float32 大端，每帧 4800 点',
      specRef: '§8.4 D2（实测小端解出 peak≈2e-4 的合理音频，大端解出的值量级荒谬，但结论仍以帧长为准）',
      endianness: 'big',
      elementBits: 32,
      signed: true,
      pcmChannels: 1,
      pcmFrameSamples: 4_800
    },
    {
      id: 'float32-le-mono-48000-mock',
      description: '单声道 float32 小端，整秒 48000 点（192000 字节/帧 —— mock 的猜测，真机不符）',
      specRef: '§5.2.5（48 kHz 手册明确）；缺口 §8.4 D2/D5（mock 把"每秒 1 次"当成了"每帧 1 秒"）',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      pcmChannels: 1,
      pcmFrameSamples: 48_000
    },
    {
      id: 'float32-le-unknown',
      description: 'float32 小端，声道数按 1 读、每帧点数由帧长决定',
      specRef: '§8.4 D5（每帧采样点未说明；宽松模式，用于探测真实帧长）',
      endianness: 'little',
      elementBits: 32,
      signed: true,
      pcmChannels: 1,
      pcmFrameSamples: 0
    }
  ],
  detectFeedback: [
    {
      id: 'json-text-frame',
      description: 'JSON 文本帧；二进制帧也按 UTF-8 解（手册自相矛盾）',
      specRef: '§5.2.3；缺口 §8.4 D7。**实测未证实帧类型**：2026-09-15 的 6 s 窗口内 0 帧（事件流，无检测即无帧），故这一条仍是手册+mock 的读法',
      endianness: 'little',
      elementBits: 8,
      signed: false
    }
  ]
}

/**
 * 默认解码候选 id（与候选表顺序一致；顺序即优先级）。
 *
 * 四条来自真机实测，`detectFeedback` 那条仍是手册读法（实测期内没有检测事件，
 * 拿不到证据，所以这里如实标注而不是假装测过）。
 */
export const FA371_DEFAULT_DECODE_IDS: Readonly<Record<Fa371StreamKind, string>> = {
  fftData: 'int16-le-1024-h4',
  voiceprintData: 'jpeg-image-600x400',
  energyData: 'int32-le-groups5',
  pcmData: 'float32-le-mono-4800',
  detectFeedback: 'json-text-frame'
}

export interface Fa371DecodeOptions {
  /** 每一路用哪条解码候选；给未知 id 时回落该路的默认候选。 */
  fftData?: string
  voiceprintData?: string
  energyData?: string
  pcmData?: string
  detectFeedback?: string
}

/** 给未知 id 时回落默认，而不是抛错（配置可能来自设备记录）。 */
export function findDecodeCandidate(
  kind: Fa371StreamKind,
  id?: string
): Fa371DecodeCandidate {
  const candidates = FA371_DECODE_CANDIDATES[kind]
  const fallbackId = FA371_DEFAULT_DECODE_IDS[kind]
  return (
    candidates.find((candidate) => candidate.id === id) ??
    candidates.find((candidate) => candidate.id === fallbackId) ??
    // 候选表非空，兜底只为类型收窄成立。
    (candidates[0] as Fa371DecodeCandidate)
  )
}

// ---------------------------------------------------------------------------
// 纯解码函数（无副作用，测试直接喂字节）
// ---------------------------------------------------------------------------

/** 从 `Uint8Array` 视图上取 DataView，保留 byteOffset（WebSocket 帧可能是大缓冲的切片）。 */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * 去掉候选声明的载荷前缀，返回真正要解码的字节。
 *
 * 实测依据（2026-09-15）：`/fftData` 每帧 2052 B，前 4 字节恒为 0。
 * **前缀短于声明时如实返回短载荷**（长度 0），由 `checkFrameLayout` 报出来，
 * 而不是把 `bytes` 整体当成载荷解出一堆错位的数字。
 */
function payloadOf(bytes: Uint8Array, candidate: Fa371DecodeCandidate): Uint8Array {
  const header = candidate.headerBytes ?? 0
  if (header <= 0) return bytes
  return bytes.byteLength > header ? bytes.subarray(header) : new Uint8Array(0)
}

/** JPEG 魔数（SOI + 第一个标记）；实测 `/voiceprintData` 是 `ff d8 ff e0`。 */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

/**
 * 把字节转成 base64（`Buffer` 优先，浏览器/测试环境回落 `btoa`）。
 *
 * 与 AE08 的时频图走的是同一条路：JPEG 直接以 base64 过 IPC，渲染层丢给 `<img>`
 * 即可，不需要在渲染层重建图像，也不产生需要手工 `revoke` 的 object URL。
 * 45 kB/帧 × 10 帧/s 的 base64 膨胀（约 60 kB）只在主进程与渲染层之间发生一次。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64')
  let binary = ''
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] as number)
  }
  return btoa(binary)
}

/**
 * 读有符号 16 位整数序列。
 *
 * 用 `DataView` 而不是 `new Int16Array(buffer)` 有两个原因，都是实测踩过的：
 *   1. 帧可能是**更大 ArrayBuffer 上的视图**（`byteOffset` 非 0），直接按
 *      `.buffer` 构造会读到邻居的字节——结果是合法的整数，看起来像数据；
 *   2. 字节序必须可选（D2 未定义）。
 * 尾部不足一个元素的字节被丢弃：连接中断导致的半帧是常态，不是异常。
 */
export function decodeInt16(bytes: Uint8Array, endianness: 'little' | 'big'): Int16Array {
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Int16Array(count)
  const view = viewOf(bytes)
  const le = endianness === 'little'
  for (let index = 0; index < count; index += 1) {
    out[index] = view.getInt16(index * 2, le)
  }
  return out
}

/** 读有符号 32 位整数序列。理由同上。 */
export function decodeInt32(bytes: Uint8Array, endianness: 'little' | 'big'): Int32Array {
  const count = Math.floor(bytes.byteLength / 4)
  const out = new Int32Array(count)
  const view = viewOf(bytes)
  const le = endianness === 'little'
  for (let index = 0; index < count; index += 1) {
    out[index] = view.getInt32(index * 4, le)
  }
  return out
}

/**
 * 读 float32 序列。
 *
 * **零拷贝快路径**：小端 + 4 字节对齐时直接 `new Float32Array(buffer, offset, n)`
 * ——这是唯一能让 192 000 B/s 的音频流不产生每秒 192 KB 垃圾的做法。
 * 大端，或首字节未 4 字节对齐（此时视图根本无法构造）时回落逐元素解码。
 */
export function decodeFloat32(bytes: Uint8Array, endianness: 'little' | 'big'): Float32Array {
  const count = Math.floor(bytes.byteLength / 4)
  if (count === 0) return new Float32Array(0)

  if (endianness === 'little' && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, count)
  }

  const out = new Float32Array(count)
  const view = viewOf(bytes)
  const le = endianness === 'little'
  for (let index = 0; index < count; index += 1) {
    out[index] = view.getFloat32(index * 4, le)
  }
  return out
}

/** 依据候选表把字节解成该路该用的数值数组（16 位候选按 32 位容器承载）。 */
function decodeElements(bytes: Uint8Array, candidate: Fa371DecodeCandidate): Int32Array | Float32Array {
  if (candidate.id.startsWith('float32') || candidate.voiceprintElement === 'float32') {
    return decodeFloat32(bytes, candidate.endianness)
  }
  if (candidate.elementBits === 16) return decodeInt16(bytes, candidate.endianness) as unknown as Int32Array
  return decodeInt32(bytes, candidate.endianness)
}

function profileOf(candidate: Fa371DecodeCandidate): Fa371DecodeProfile {
  return {
    id: candidate.id,
    endianness: candidate.endianness,
    elementBits: candidate.elementBits,
    signed: candidate.signed
  }
}

/**
 * 解码 `/fftData`（§5.2.1）。
 *
 * 实测（2026-09-15）：帧长恒为 **2052 B**，前 4 字节恒为 0，其余是 1024 个 int16。
 * 因此默认候选声明 `headerBytes: 4` + `fftBins: 1024`；`values` 的**长度仍然由
 * 帧长决定**，不由假设决定——帧短于期望时如实返回短数组（少画几根谱线，而不是
 * 补零造出不存在的谱线）。
 */
export function decodeFftFrame(
  bytes: Uint8Array,
  candidate: Fa371DecodeCandidate,
  meta: { receivedAt: number; sequence: number }
): Fa371FftFrame {
  const payload = payloadOf(bytes, candidate)
  const all = decodeInt16(payload, candidate.endianness)
  const expected = candidate.fftBins ?? all.length
  const values = all.length > expected ? all.subarray(0, expected) : all
  return {
    kind: 'fftData',
    bytes,
    values,
    binCount: values.length,
    profile: profileOf(candidate),
    receivedAt: meta.receivedAt,
    sequence: meta.sequence
  }
}

/**
 * 解码 `/voiceprintData`（§5.2.2）。
 *
 * **实测（2026-09-15）把手册和 mock 一起推翻了：设备推的是 JPEG 图像，不是数值
 * 矩阵。** 证据：帧首 `ff d8 ff e0 00 10 4a 46 49 46`（JFIF）、帧尾 `ff d9`、
 * SOF0 声明 600×400 / 3 分量 / 基线、每帧约 45 kB 且逐帧长度不同（压缩使然）。
 * 手册说 "int-type"（§8.4 D4），mock 据此假设 128×256×int32 幅度矩阵——
 * 那个假设下每帧应恒为 131072 B，实测是 45000 B 上下浮动，量级与"恒定"两条都不成立。
 *
 * 因此：候选声明 `jpeg: true` 时**不做任何数值解码**，直接把原字节以 base64
 * 带出（`jpegBase64`），`values` 为空、`width`/`height` 为 0。数值几何只有在候选
 * 明确声明宽高时才计算（mock 那条仍然可用，测试与离线 mock 依赖它）。
 */
export function decodeVoiceprintFrame(
  bytes: Uint8Array,
  candidate: Fa371DecodeCandidate,
  meta: { receivedAt: number; sequence: number }
): Fa371VoiceprintFrame {
  const base = {
    kind: 'voiceprintData' as const,
    bytes,
    profile: profileOf(candidate),
    receivedAt: meta.receivedAt,
    sequence: meta.sequence
  }

  if (candidate.jpeg) {
    // 声明是图像但魔数不对：这仍然是"帧长/内容与假设不符"，交给 layoutWarning
    // 报出来，同时把字节原样带出——渲染层会显示"不是图像"，不会画出一条假曲线。
    return {
      ...base,
      values: new Int32Array(0),
      width: 0,
      height: 0,
      channels: candidate.voiceprintChannels ?? 1,
      ...(looksLikeJpeg(bytes) ? { jpegBase64: bytesToBase64(bytes) } : {})
    }
  }

  const values = decodeElements(payloadOf(bytes, candidate), candidate) as Int32Array | Float32Array
  const width = candidate.voiceprintWidth ?? values.length
  const channels = candidate.voiceprintChannels ?? 1
  const declaredHeight = candidate.voiceprintHeight ?? 0
  const derivedHeight = width * channels > 0 ? Math.floor(values.length / (width * channels)) : 0
  const height = declaredHeight > 0 ? Math.min(declaredHeight, derivedHeight) : derivedHeight
  return {
    ...base,
    values,
    width,
    height,
    channels
  }
}

/**
 * 解码 `/energyData`（§5.2.4）。
 *
 * 手册**明确**给出每组 5 个 32-bit int 的顺序（能量、像素横、像素纵、扫描角、
 * 方位角），所以字段名直接用手册用词；单位与标度未定义（D6），因此不做任何换算。
 * 尾部不足一组的元素被丢弃——半组数据画不出一个目标点。
 */
export function decodeEnergyFrame(
  bytes: Uint8Array,
  candidate: Fa371DecodeCandidate,
  meta: { receivedAt: number; sequence: number }
): Fa371EnergyFrame {
  const values = decodeInt32(bytes, candidate.endianness)
  const groupSize = candidate.energyGroupSize ?? 5
  const targets: Fa371EnergyTarget[] = []
  for (let offset = 0; offset + groupSize <= values.length; offset += groupSize) {
    targets.push({
      energy: values[offset] as number,
      pixelX: values[offset + 1] as number,
      pixelY: values[offset + 2] as number,
      swathAngle: values[offset + 3] as number,
      azimuthAngle: values[offset + 4] as number
    })
  }
  return {
    kind: 'energyData',
    bytes,
    values,
    targets,
    profile: profileOf(candidate),
    receivedAt: meta.receivedAt,
    sequence: meta.sequence
  }
}

/**
 * 解码 `/pcmData`（§5.2.5）。
 *
 * 48 kHz 是手册明确给出的；实测（2026-09-15）每帧 19200 B = **4800 个 float32**，
 * 10 帧/s → 48000 样本/s，与手册的 48 kHz 自洽。所以默认候选的
 * `pcmFrameSamples` 是 4800（100 ms/帧），不是 mock 假设的 48000。
 *
 * `samples.length` 仍然是这一帧实际解出的样本数：界面按 `sampleRate` 换算时长时
 * 才不会把 100 ms 说成 1 s。
 */
export function decodePcmFrame(
  bytes: Uint8Array,
  candidate: Fa371DecodeCandidate,
  meta: { receivedAt: number; sequence: number; sampleRate?: number }
): Fa371PcmFrame {
  const samples = decodeFloat32(payloadOf(bytes, candidate), candidate.endianness)
  const channels = candidate.pcmChannels ?? 1
  const declared = candidate.pcmFrameSamples ?? 0
  const usable = declared > 0 ? Math.min(declared * channels, samples.length) : samples.length
  return {
    kind: 'pcmData',
    bytes,
    samples: usable === samples.length ? samples : samples.subarray(0, usable),
    sampleRate: meta.sampleRate ?? FA371_PCM_SAMPLE_RATE_HZ,
    channels,
    profile: profileOf(candidate),
    receivedAt: meta.receivedAt,
    sequence: meta.sequence
  }
}

/**
 * 解码 `/detectFeedback`（§5.2.3）。
 *
 * 文本帧与二进制帧**都收**：手册一边说 "JSON strings" 一边说 "parsed in byte
 * order"（D7），mock 推文本帧。二进制帧按 UTF-8 解，解不出来就返回
 * 无日志的帧（`logs: []`）而不是抛——一次检测的推送不该因为一个坏帧丢失。
 * `ret`/`msg` 原样带出：手册没规定失败包长什么样，不猜。
 */
export function decodeDetectFeedbackFrame(
  bytes: Uint8Array,
  textFrame: boolean,
  meta: { receivedAt: number; sequence: number }
): Fa371DetectFeedbackFrame {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const text = decoder.decode(bytes)
  const frame: Fa371DetectFeedbackFrame = {
    kind: 'detectFeedback',
    bytes,
    text,
    textFrame,
    logs: [],
    receivedAt: meta.receivedAt,
    sequence: meta.sequence
  }

  const trimmed = text.trim()
  if (trimmed === '') return frame

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    // 可能是 keep-alive 或半帧。不是需要上报的错误。
    return frame
  }

  frame.logs = mapDetectLogs(payload)
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    if ('ret' in record) frame.rawRet = record.ret
    if ('msg' in record) frame.rawMsg = record.msg
  }
  return frame
}

// ---------------------------------------------------------------------------
// 帧长校验（"用错了假设"必须可见，而不是静默解出垃圾）
// ---------------------------------------------------------------------------

/**
 * 一条候选**期望的**每帧字节数；`undefined` 表示这条候选的帧长本来就由帧内容
 * 决定（JPEG 的压缩会让帧长逐帧变化，宽松 PCM 候选也是）。
 */
export function expectedFrameBytes(candidate: Fa371DecodeCandidate): number | undefined {
  const header = candidate.headerBytes ?? 0
  const bytesPerElement = Math.max(1, Math.round(candidate.elementBits / 8))

  if (candidate.jpeg) return undefined
  if (candidate.id === 'json-text-frame') return undefined

  if (candidate.fftBins !== undefined) return header + candidate.fftBins * bytesPerElement

  if (candidate.voiceprintWidth !== undefined && candidate.voiceprintHeight !== undefined) {
    return (
      header +
      candidate.voiceprintWidth *
        candidate.voiceprintHeight *
        (candidate.voiceprintChannels ?? 1) *
        bytesPerElement
    )
  }

  if (candidate.energyGroupSize !== undefined) {
    // 目标个数由帧长决定（手册说最多 3 个），所以只能校验"是不是整数个组"。
    return undefined
  }

  const declaredSamples = candidate.pcmFrameSamples ?? 0
  if (declaredSamples > 0) {
    return header + declaredSamples * (candidate.pcmChannels ?? 1) * bytesPerElement
  }
  return undefined
}

/** 帧长校验结果。`warning` 是**稳定的机器可读 id**，供 i18n 与日志使用。 */
export interface FrameLayoutCheck {
  /** 期望字节数；`undefined` = 这一路的帧长本来就由内容决定。 */
  expected?: number
  /** 实际字节数。 */
  actual: number
  /** 可翻译的告警 id；帧长符合（或无法校验）时为 `undefined`。 */
  warning?: Fa371LayoutWarning
  /** 技术细节（英文，含标识符与数字），用于日志与悬停提示。 */
  note?: string
}

/**
 * 校验一帧的字节数与所选候选是否一致。
 *
 * 为什么值得每个通道每帧算一次：实测已经推翻过一份几何假设（2052 vs 1024、
 * 45000 vs 131072、19200 vs 192000），而**帧长是运行期唯一能证伪假设的证据**。
 * 没有这一步，用错候选的症状是"图上有一条看起来挺合理的曲线"。
 */
export function checkFrameLayout(kind: Fa371StreamKind, bytes: Uint8Array, candidate: Fa371DecodeCandidate): FrameLayoutCheck {
  const actual = bytes.byteLength

  // 1) 声明是图像：魔数才是判据，帧长天然可变。
  if (candidate.jpeg) {
    if (actual === 0) return { actual, warning: 'empty-frame', note: '0 B' }
    if (!looksLikeJpeg(bytes)) {
      return {
        actual,
        warning: 'voiceprint-not-jpeg',
        note: `expected JPEG magic ff d8 ff, got ${firstBytesHex(bytes)}`
      }
    }
    return { actual }
  }

  if (kind === 'detectFeedback') return { actual }

  // 2) 声明了固定几何：帧长必须对得上。
  const expected = expectedFrameBytes(candidate)
  if (expected === undefined) {
    // 仍然报"连一个完整元素都装不下"的极端情况——那说明前缀把整个载荷吃掉了。
    if (actual > 0 && actual < Math.ceil(candidate.elementBits / 8)) {
      return { actual, warning: 'frame-too-short', note: `${actual} B < one ${candidate.elementBits}-bit element` }
    }
    return { actual }
  }

  if (actual === expected) return { actual, expected }

  // 空帧与"前缀比帧还长"分开报：前者是连接问题，后者是假设问题。
  if (actual === 0) return { actual, expected, warning: 'empty-frame', note: `0 B, expected ${expected} B` }
  if (actual < (candidate.headerBytes ?? 0)) {
    return {
      actual,
      expected,
      warning: 'frame-too-short',
      note: `${actual} B < declared ${candidate.headerBytes ?? 0} B header`
    }
  }
  if (kind === 'energyData') return { actual, expected }

  return {
    actual,
    expected,
    warning: 'frame-size-mismatch',
    note: `expected ${expected} B (${candidate.id}), got ${actual} B`
  }
}

/** 前几个字节的十六进制，用于把"内容不像假设"写进日志。 */
function firstBytesHex(bytes: Uint8Array, count = 8): string {
  const parts: string[] = []
  for (let index = 0; index < Math.min(count, bytes.byteLength); index += 1) {
    parts.push((bytes[index] as number).toString(16).padStart(2, '0'))
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/**
 * 心跳间隔（ms）。手册 §5.2 引言：客户端必须**每分钟至少发一条任意内容**的消息，
 * 否则服务端认定客户端空闲并强制断开；**内容与格式不限**（D8：阈值未说明）。
 *
 * 选 30 s：留一倍余量。若按 60 s 发，一次事件循环抖动或一次 GC 停顿就可能
 * 正好越过服务端的判定点，而症状是"每分钟断一次"——看起来像网络问题。
 * 写死的下限是 60 000 的一半，任何人把它调大都会在下面的构造函数里被拒绝。
 */
export const FA371_HEARTBEAT_INTERVAL_MS = 30_000

/** 手册允许的最慢心跳；超过它一定会在服务端超时，所以硬性封顶。 */
export const FA371_HEARTBEAT_MAX_MS = 60_000

/** 每一路的一段心跳内容：任意、可读、且绝不可能是 subscribe 语义。 */
function heartbeatBody(kind: Fa371StreamKind): string {
  // 手册明确"不需要订阅消息"，服务端连上就推。所以这里刻意不发任何
  // {type:"subscribe"} 之类的 JSON——那会给真机一个手册没要求的行为。
  return `{"type":"heartbeat","channel":"${FA371_STREAM_PATHS[kind]}"}`
}

export interface Fa371WsClientOptions {
  deviceId: string
  /** 形如 `ws://192.168.1.50`（无尾斜杠）；由 `toWebSocketUrl(httpBaseUrl)` 得来。 */
  baseWsUrl: string
  /**
   * 认证信息。`token` 优先；也接受 `Authorization`（无前缀）。
   *
   * 来源是 `Fa371ApiClient.authHeaders()`——**不重新登录**，直接复用已经解析出的
   * 会话与携带方式（`resolvedStrategyId`）。没有 token 时（例如设备压根不需要
   * 认证，或 mock）候选表里的 `none` 会胜出。
   */
  authHeaders: Record<string, string>
  /** 要启动的通道；缺省 = 全部五路。 */
  channels?: readonly Fa371StreamKind[]
  /** 心跳间隔，默认 30 s，最大 60 s（手册要求 ≥1 次/分钟）。 */
  heartbeatMs?: number
  /** 重连退避上限，默认 15 s（与 `WebSocketStream` 一致）。 */
  maxReconnectDelayMs?: number
  /** 候选握手"开了但没数据"的判定预算，默认 4 s。 */
  candidateProbeMs?: number
  /** 首选握手候选 id（上次实测胜出的那条），排到候选表最前。 */
  preferredAuthId?: string
  /** 同名解码候选 id 覆盖（Protocol Lab 用）。 */
  decode?: Fa371DecodeOptions
  /** `/pcmData` 环形缓冲保留的秒数，默认 5。 */
  pcmBufferSeconds?: number
  /** `/pcmData` 采样率覆盖（手册给 48000，仅用于其他相机型号）。 */
  pcmSampleRate?: number
  /** 为流配置额外注入（测试用；不传则用内置五路 profile）。 */
  profileOverrides?: Partial<Record<Fa371StreamKind, Partial<StreamProfile>>>
}

/** `/pcmData` 环形缓冲（固定容量，覆盖最旧，不再分配）。 */
class PcmRingBuffer {
  private readonly capacitySamples: number
  private readonly chunkSamples: number
  private chunks: Float32Array[] = []
  private writeIndex = 0
  private filled = 0
  /** 缓冲已满后被覆盖的帧数。必须可见，否则"丢数据"就是静默的。 */
  droppedFrames = 0

  constructor(capacitySamples: number, chunkSamples: number) {
    this.capacitySamples = Math.max(1, Math.floor(capacitySamples))
    this.chunkSamples = Math.max(1, Math.floor(chunkSamples))
  }

  get capacitySecondsChunks(): number {
    return Math.max(1, Math.floor(this.capacitySamples / this.chunkSamples))
  }

  push(samples: Float32Array): void {
    if (this.chunks.length < this.capacitySecondsChunks) {
      this.chunks.push(samples)
      this.writeIndex = this.chunks.length % this.capacitySecondsChunks
      this.filled = this.chunks.length
      return
    }
    this.chunks[this.writeIndex] = samples
    this.writeIndex = (this.writeIndex + 1) % this.chunks.length
    this.filled = this.chunks.length
    this.droppedFrames += 1
  }

  get retainedFrames(): number {
    return Math.min(this.filled, this.chunks.length)
  }

  get retainedSamples(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0)
  }

  clear(): void {
    this.chunks = []
    this.writeIndex = 0
    this.filled = 0
    this.droppedFrames = 0
  }
}

/**
 * 一台相机的五路 WebSocket 客户端。
 *
 * 生命周期保证（与 `WebSocketStream` 一致，附录 C 规则 12）：
 *   - `connect()` 幂等；
 *   - 每一路独立重连（退避 + 抖动），一路断不影响其余四路；
 *   - `dispose()` 关掉全部 socket、清掉全部定时器与监听，进程可正常退出。
 */
export class Fa371WsClient extends EventEmitter {
  private readonly options: Fa371WsClientOptions
  private readonly kinds: readonly Fa371StreamKind[]
  private readonly streams = new Map<Fa371StreamKind, WebSocketStream>()
  private readonly decodeCandidates = new Map<Fa371StreamKind, Fa371DecodeCandidate>()
  private readonly statuses = new Map<Fa371StreamKind, Fa371StreamStatus>()
  private readonly certainty = new Map<Fa371StreamKind, Fa371HandshakeCertainty>()
  private readonly sampleRate: number
  private readonly pcmBuffer?: PcmRingBuffer
  /**
   * `/pcmData` 环形缓冲的**秒数**（构造参数，不是"块数"）。
   *
   * 分开存是因为块容量与块大小都依赖解码候选：mock 假设下 5 秒 = 5 块，
   * 实测帧长下 5 秒 = 50 块。对外报的是秒，两者才对得上。
   */
  private readonly pcmBufferSeconds: number
  /**
   * 上一次报出的帧长校验结论（每路一条）。
   *
   * 它**与 `statuses` 分开存**，因为两者会被不同的事件改写：帧到达算一次结论，
   * 而连接状态推送（打开、重连、错误）也会重写同一路的状态对象。只存在
   * `status` 上的话，一次恰好在帧之后到达的状态推送就会把"帧长不符"擦掉——
   * 那正是"用错假设却看不见"的复现路径（实测踩过：测试里 50 ms 内就复现了）。
   * 分开存之后，`applyLayoutFacts()` 在每次状态重写后把它贴回去。
   *
   * 只用于**抑制重复日志与重复状态推送**：`/fftData` 每秒 10 帧，如果每帧都写
   * 一条"帧长不符"，日志会被同一个事实刷满，真正的新信息反而看不到。
   */
  private readonly layoutFacts = new Map<
    Fa371StreamKind,
    { warning?: Fa371LayoutWarning; note?: string; mismatches?: number }
  >()

  private running = false
  private disposed = false

  constructor(options: Fa371WsClientOptions) {
    super()
    this.options = options
    this.kinds = options.channels && options.channels.length > 0 ? [...options.channels] : [...FA371_STREAM_KINDS]
    this.sampleRate = options.pcmSampleRate ?? FA371_PCM_SAMPLE_RATE_HZ

    for (const kind of this.kinds) {
      const candidate = findDecodeCandidate(kind, options.decode?.[kind])
      this.decodeCandidates.set(kind, candidate)
      this.statuses.set(kind, { deviceId: options.deviceId, kind, state: 'IDLE', retries: 0, frameCount: 0 })
    }

    if (this.decodeCandidates.has('pcmData')) {
      const pcm = this.decodeCandidates.get('pcmData') as Fa371DecodeCandidate
      const channels = pcm.pcmChannels ?? 1
      const seconds = options.pcmBufferSeconds ?? 5
      this.pcmBufferSeconds = seconds
      // 容量按**解码假设**算死。实测默认是 4800 点/帧（100 ms），
      // 因此 48000 × 1 × 5 s 的环形缓冲正好装 50 帧；换成 mock 那条
      // 48000 点/帧的候选时，容量与块大小仍然自洽（5 块）。
      const chunkSamples = pcm.pcmFrameSamples && pcm.pcmFrameSamples > 0 ? pcm.pcmFrameSamples : this.sampleRate
      this.pcmBuffer = new PcmRingBuffer(
        Math.max(1, Math.round(this.sampleRate * channels * seconds)),
        chunkSamples * channels
      )
    } else {
      this.pcmBufferSeconds = 0
    }
  }

  get deviceId(): string {
    return this.options.deviceId
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 每路当前生效的解码候选（Protocol Lab 报告用）。 */
  decodeProfileIds(): Partial<Record<Fa371StreamKind, string>> {
    const profiles: Partial<Record<Fa371StreamKind, string>> = {}
    for (const [kind, candidate] of this.decodeCandidates) profiles[kind] = candidate.id
    return profiles
  }

  /** 最终生效的握手候选 id（取已确认的那条；都没确认时返回尝试中的那条）。 */
  resolvedAuthId(): string | undefined {
    let attempted: string | undefined
    for (const kind of this.kinds) {
      const confirmed = this.certainty.get(kind) === 'confirmed-by-frame' ? this.statuses.get(kind)?.handshakeAuthId : undefined
      if (confirmed) return confirmed
      attempted ??= this.statuses.get(kind)?.handshakeAuthId
    }
    return attempted
  }

  /** `/pcmData` 缓冲状态，供 UI 与诊断显示"主进程留了多少、丢了多少"。 */
  pcmBufferState(): {
    bufferSeconds: number
    droppedFrames: number
    retainedFrames: number
    samples: number
    sampleRate: number
    channels: number
    /** 每帧样本数（按当前候选）：实测默认 4800，即 48 kHz 下的 100 ms。 */
    frameSamples: number
  } {
    const pcm = this.decodeCandidates.get('pcmData')
    const channels = pcm?.pcmChannels ?? 1
    const frameSamples = pcm?.pcmFrameSamples ?? 0
    // 缓冲深度按**秒**给出，而不是"能装几个块"：实测帧长从 mock 假设的 48000 点
    // 变成 4800 点之后，块数翻了 10 倍，直接暴露块数会把"5 秒"报成"50"。
    return {
      bufferSeconds: this.pcmBufferSeconds,
      droppedFrames: this.pcmBuffer?.droppedFrames ?? 0,
      retainedFrames: this.pcmBuffer?.retainedFrames ?? 0,
      samples: this.pcmBuffer?.retainedSamples ?? 0,
      sampleRate: this.sampleRate,
      channels,
      frameSamples
    }
  }

  /** 五路状态快照。 */
  statusSnapshot(): Fa371StreamStatus[] {
    return this.kinds.map((kind) => ({ ...(this.statuses.get(kind) as Fa371StreamStatus) }))
  }

  /**
   * 启动五路（或构造时指定的那几路）。
   *
   * 幂等：重复调用只是重发一次状态，不会开出第二组 socket。
   */
  connect(): void {
    if (this.disposed) throw new AppError(ErrorCodes.UNKNOWN, 'FA371 WebSocket 客户端已释放')
    if (this.running) return
    this.running = true

    for (const kind of this.kinds) {
      const stream = this.createStream(kind)
      this.streams.set(kind, stream)
      stream.start()
    }

    deviceLog().info('FA371 WebSocket 通道已启动', {
      deviceId: this.deviceId,
      channels: this.kinds,
      heartbeatMs: this.heartbeatIntervalMs(),
      decode: this.decodeProfileIds()
    })
  }

  /** 停掉全部通道并释放 socket（可再次 `connect()`）。 */
  stop(): void {
    this.running = false
    for (const stream of this.streams.values()) stream.stop()
    this.streams.clear()
    for (const kind of this.kinds) {
      const status = this.statuses.get(kind)
      if (status) this.statuses.set(kind, { ...status, state: 'STOPPED', retries: 0 })
    }
    deviceLog().info('FA371 WebSocket 通道已停止', { deviceId: this.deviceId, channels: this.kinds })
  }

  /** 彻底释放：停止 + 清缓冲 + 摘掉所有监听。 */
  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.pcmBuffer?.clear()
    deviceLog().debug('FA371 WebSocket 客户端已释放', { deviceId: this.deviceId })
    this.removeAllListeners()
  }

  /** 订阅某一类型的帧。返回退订函数。 */
  onFrame<T extends Fa371Frame['kind']>(
    kind: T,
    listener: (frame: Extract<Fa371Frame, { kind: T }>) => void
  ): () => void {
    const event = `frame:${kind}`
    const handler = listener as (frame: Fa371Frame) => void
    this.on(event, handler)
    return () => this.off(event, handler)
  }

  /** 订阅状态变化。返回退订函数。 */
  onStatus(listener: (status: Fa371StreamStatus) => void): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  // -------------------------------------------------------------------------

  private heartbeatIntervalMs(): number {
    const requested = this.options.heartbeatMs ?? FA371_HEARTBEAT_INTERVAL_MS
    return Math.max(1_000, Math.min(FA371_HEARTBEAT_MAX_MS, requested))
  }

  /**
   * 为一路建一个 `WebSocketStream`。
   *
   * profile 的 `pingIntervalMs` 就是**心跳**：手册说服务端连上就推、无需订阅
   * （§5.2 引言），所以这里发的是"任意内容"的心跳，不是 subscribe 消息。
   * `carriesChannel: false` 是相机的真实情况——相机没有通道概念（§6 用户模型）。
   */
  private createStream(kind: Fa371StreamKind): WebSocketStream {
    const spec = FA371_STREAM_SPECS[kind]
    const base: StreamProfile = {
      path: spec.path,
      pingIntervalMs: this.heartbeatIntervalMs(),
      pingBody: heartbeatBody(kind),
      carriesChannel: false,
      purpose: `${spec.cadence}；${spec.specRefs}`,
      /**
       * `/detectFeedback` 是**事件流**：每完成一次检测才推一包（§5.2.3），
       * 两次检测之间可能隔几分钟。因此不能用"安静 = 握手被拒"的判据去降级它——
       * 实测（对着 `scripts/mock-fa371.cjs --ws`）正是这样把一个**可用**的
       * 候选（`none`）误判掉了。其余四路都是持续推送的，保持默认的探测行为。
       */
      probeHandshake: kind !== 'detectFeedback'
    }
    const profile: StreamProfile = { ...base, ...(this.options.profileOverrides?.[kind] ?? {}) }

    const stream = new WebSocketStream({
      baseWsUrl: this.options.baseWsUrl,
      profile,
      headers: this.options.authHeaders,
      handshakeAuth: findWsAuthCandidates(this.options.preferredAuthId),
      ...(this.options.candidateProbeMs !== undefined ? { candidateProbeMs: this.options.candidateProbeMs } : {}),
      ...(this.options.maxReconnectDelayMs !== undefined
        ? { maxReconnectDelayMs: this.options.maxReconnectDelayMs }
        : {}),
      onStatus: (status) => this.handleStatus(kind, status),
      onFrame: (frame) => this.handleFrame(kind, frame)
    })
    return stream
  }

  private handleStatus(kind: Fa371StreamKind, status: StreamStatus): void {
    const previous = this.statuses.get(kind)
    const certainty = this.certainty.get(kind)

    const next: Fa371StreamStatus = {
      deviceId: this.deviceId,
      kind,
      state: status.state,
      retries: status.retries,
      // 帧数由 `recordFrame` 就地累加（它是唯一知道帧到达的地方）。
      frameCount: previous?.frameCount ?? 0,
      ...(status.lastFrameAt !== undefined ? { lastFrameAt: status.lastFrameAt } : {}),
      ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
      ...(previous?.lastFrameBytes !== undefined ? { lastFrameBytes: previous.lastFrameBytes } : {}),
      ...(status.handshakeAuthId !== undefined ? { handshakeAuthId: status.handshakeAuthId } : {}),
      ...(status.handshakeAuthId !== undefined ? { handshakeCertainty: certainty ?? 'unconfirmed' } : {})
    }
    // 帧长结论单独存（见 `layoutFacts`），这里贴回去——连接状态变化不会改变
    // "上一个帧的字节数对不上"这个事实，所以不能因为一次重连就把它抹掉。
    this.applyLayoutFacts(kind, next)
    this.statuses.set(kind, next)
    this.emit('status', { ...next })
  }

  /** 把 `layoutFacts` 里的帧长结论贴到一个状态对象上（就地修改并返回它）。 */
  private applyLayoutFacts<T extends Fa371StreamStatus>(kind: Fa371StreamKind, status: T): T {
    const facts = this.layoutFacts.get(kind)
    if (!facts?.warning) {
      delete status.layoutWarning
      delete status.layoutNote
      delete status.layoutMismatches
      return status
    }
    status.layoutWarning = facts.warning
    if (facts.note !== undefined) status.layoutNote = facts.note
    status.layoutMismatches = facts.mismatches ?? 0
    return status
  }

  /**
   * 帧到达：**先校验帧长**，解码一次，然后交给所有监听者**同一个对象**。
   *
   * 这里没有任何"按订阅者复制"的动作，这是音频流内存不翻倍的全部原因。
   * 解码异常被吞掉并记日志：一个坏帧不能杀掉整条订阅（与
   * `stream-services.BaseStreamService.safely` 同一个策略）。
   */
  private handleFrame(kind: Fa371StreamKind, frame: StreamFrame): void {
    const candidate = this.decodeCandidates.get(kind)
    if (!candidate) return
    const meta = { receivedAt: frame.receivedAt, sequence: frame.sequence }

    // 帧长校验先于解码：结论进状态（UI 可见）与日志（可追溯），
    // 但**不阻止解码**——只有在帧长对不上时才有必要让调用方知道结果可疑，
    // 而解码本身在短帧上是安全的（如实返回短数组）。
    this.reportLayout(kind, frame.bytes, candidate)

    try {
      switch (kind) {
        case 'fftData': {
          const decoded = decodeFftFrame(frame.bytes, candidate, meta)
          this.recordFrame(kind, frame.bytes.length)
          this.emit('frame:fftData', decoded)
          break
        }
        case 'voiceprintData': {
          const decoded = decodeVoiceprintFrame(frame.bytes, candidate, meta)
          this.recordFrame(kind, frame.bytes.length)
          this.emit('frame:voiceprintData', decoded)
          break
        }
        case 'energyData': {
          const decoded = decodeEnergyFrame(frame.bytes, candidate, meta)
          this.recordFrame(kind, frame.bytes.length)
          this.emit('frame:energyData', decoded)
          break
        }
        case 'pcmData': {
          const decoded = decodePcmFrame(frame.bytes, candidate, { ...meta, sampleRate: this.sampleRate })
          // 缓冲策略：只留最近 N 秒，满了覆盖最旧并计数（见文件头第 4 节）。
          this.pcmBuffer?.push(decoded.samples)
          this.recordFrame(kind, frame.bytes.length)
          this.emit('frame:pcmData', decoded)
          break
        }
        case 'detectFeedback': {
          const decoded = decodeDetectFeedbackFrame(frame.bytes, frame.binary === false, meta)
          this.recordFrame(kind, frame.bytes.length)
          this.emit('frame:detectFeedback', decoded)
          break
        }
      }
    } catch (error) {
      deviceLog().warn('FA371 帧解码失败，已丢弃', {
        deviceId: this.deviceId,
        channel: kind,
        bytes: frame.bytes.length,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 把帧长校验结论写进状态并记日志（同一结论只报一次）。
   *
   * "同一结论只报一次"是刻意的：`/fftData` 10 帧/s、`/energyData` 30 帧/s，
   * 每帧都写一条会把日志刷满，而事实只有一个。结论**变化**时（比如换了候选、
   * 或设备换了固件）会立刻重新报一次。
   */
  private reportLayout(kind: Fa371StreamKind, bytes: Uint8Array, candidate: Fa371DecodeCandidate): void {
    const check = checkFrameLayout(kind, bytes, candidate)
    const note = check.warning ? check.note : undefined
    const previous = this.layoutFacts.get(kind)
    const unchanged = previous !== undefined && previous.warning === check.warning && previous.note === note

    if (unchanged) {
      // 结论没变：只把"命中了多少帧"往前推一格，不重发状态、不重写日志。
      previous.mismatches = (previous.mismatches ?? 0) + 1
      const current = this.statuses.get(kind)
      if (current && check.warning) current.layoutMismatches = previous.mismatches
      return
    }

    const facts = { warning: check.warning, note, mismatches: check.warning ? 1 : 0 }
    this.layoutFacts.set(kind, facts)

    const status = this.statuses.get(kind)
    if (status) {
      this.applyLayoutFacts(kind, status)
      this.emit('status', { ...status })
    }

    if (!check.warning) {
      // 从"不符"回到"一致"也是一条新信息（比如换了候选），所以也要报一次。
      if (previous?.warning) {
        deviceLog().info('FA371 帧长恢复与解码候选一致', {
          deviceId: this.deviceId,
          channel: kind,
          candidate: candidate.id,
          bytes: check.actual
        })
      }
      return
    }
    // 这是"用错假设"的直接证据，必须是 warn 级并带够判读信息：
    // 期望多少、实际多少、按哪条候选、帧首几个字节长什么样。
    deviceLog().warn('FA371 帧长与解码候选不符', {
      deviceId: this.deviceId,
      channel: kind,
      candidate: candidate.id,
      warning: check.warning,
      expectedBytes: check.expected,
      actualBytes: check.actual,
      note: check.note,
      firstBytes: firstBytesHex(bytes)
    })
  }

  /** 记一帧：帧数、字节数，并把"未确认"升级为"已确认"。 */
  private recordFrame(kind: Fa371StreamKind, byteLength: number): void {
    const status = this.statuses.get(kind)
    if (!status) return
    // 就地累加：`statusSnapshot()` 读的就是这个对象，而 `handleStatus` 会把
    // 计数一起带进下一次状态推送。放在别处累加会让 UI 永远看到 0 帧。
    status.frameCount += 1
    status.lastFrameBytes = byteLength
    // 帧长告警的计数由 `reportLayout` 维护（结论变化时归零），这里不重复累加。

    if (this.certainty.get(kind) !== 'confirmed-by-frame' && status.handshakeAuthId !== undefined) {
      this.certainty.set(kind, 'confirmed-by-frame')
      // 同步写进快照对象：`statusSnapshot()` 不经过 `handleStatus`，只有这里
      // 改了它，UI 才能立刻看到"这条握手候选已经被数据证明"，而不是等到下一次
      // 连接状态变化（那可能永远不发生）。
      status.handshakeCertainty = 'confirmed-by-frame'
      deviceLog().info('FA371 握手认证候选已被数据确认', {
        deviceId: this.deviceId,
        channel: kind,
        handshakeAuthId: status.handshakeAuthId
      })
      // 推一次状态，让 IPC 那边也立刻知道（而不是等下一帧状态事件）。
      this.emit('status', { ...status })
    }
  }
}
