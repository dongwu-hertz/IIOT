/**
 * FA371 实时 WebSocket 流测试（手册 §5.2）。
 *
 * 三类测试，边界划得很清楚：
 *
 *   1. **解码测试**：直接用手工构造的字节缓冲喂 `decode*` 函数。
 *      这里**不 mock 解码器**——被测的就是"这些字节应该变成什么数字"，
 *      mock 掉它等于什么都没测。字节序两个方向都测，因为手册只说
 *      "parse in byte order"（§8.4 D2），小端只是 mock 的选择。
 *      **真机实测后新增的那批用例用的是真实帧长**（2052 / 19200 / 20 字节，
 *      见 `FA371_STREAM_MEASURED`）：帧长是运行期唯一能证伪几何假设的证据，
 *      所以测试必须喂真尺寸，而不是喂一个"随便多大"的缓冲。
 *
 *   2. **真实 socket 测试**：在 `127.0.0.1` 的**临时端口**上自己起一个
 *      RFC6455 服务端（`node:http` + 手写握手/分帧，与 `scripts/mock-fa371.cjs`
 *      同一条代码路径），然后让真正的 `Fa371WsClient` 连上去。覆盖任务要求的四件事：
 *        - 一帧到达并被解码；
 *        - `/detectFeedback` 的**文本帧**；
 *        - clean stop（socket 关闭、定时器清除、可重新 connect）；
 *        - 服务端断开后的**重连**；
 *      外加两条本项目特有的：五路通道各自到位，以及**握手认证候选会被逐条尝试**
 *      （§8.4 D1 —— 手册完全没写 WebSocket 怎么认证）。
 *
 *   3. **帧长校验测试**：帧长与候选不符时必须被报出来（`layoutWarning`），
 *      而不是解出一堆看着合理的数字。这是实测推翻 mock 几何之后加的那道闸门。
 *
 * 确定性：不用固定 sleep 等结果，一律 `waitFor(条件)` 轮询；每个测试的
 * `finally` 都关掉服务端并销毁客户端，所以测试之间不会互相留下 socket。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  FA371_WS_AUTH_CANDIDATES,
  FA371_DEFAULT_DECODE_IDS,
  FA371_DECODE_CANDIDATES,
  FA371_HEARTBEAT_MAX_MS,
  Fa371WsClient,
  checkFrameLayout,
  decodeDetectFeedbackFrame,
  decodeEnergyFrame,
  decodeFftFrame,
  decodeFloat32,
  decodeInt16,
  decodeInt32,
  decodePcmFrame,
  decodeVoiceprintFrame,
  expectedFrameBytes,
  findDecodeCandidate,
  looksLikeJpeg,
  type Fa371DecodeCandidate
} from '../src/main/services/device/fa371/fa371-ws-client'
import {
  Fa371StreamService,
  toFftPreview,
  toPcmPreview,
  toVoiceprintPreview
} from '../src/main/services/device/fa371/fa371-stream-service'
import { toWebSocketUrl } from '../src/main/services/stream/websocket-stream'
import { FA371_STREAM_KINDS, FA371_STREAM_MEASURED } from '../src/shared/domain/fa371-stream'
import type {
  Fa371DetectFeedbackPreview,
  Fa371FftPreview,
  Fa371PcmPreview,
  Fa371StreamPreview
} from '../src/shared/domain/fa371-stream'
import type { Device } from '../src/shared/domain/models'

// ---------------------------------------------------------------------------
// 辅助：字节构造与等待
// ---------------------------------------------------------------------------

/** 按给定字节序写有符号 16 位整数。 */
function int16Buffer(values: readonly number[], little = true): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 2)
  const view = new DataView(buffer)
  values.forEach((value, index) => view.setInt16(index * 2, value, little))
  return new Uint8Array(buffer)
}

/** 按给定字节序写有符号 32 位整数。 */
function int32Buffer(values: readonly number[], little = true): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  values.forEach((value, index) => view.setInt32(index * 4, value, little))
  return new Uint8Array(buffer)
}

/** 按给定字节序写 float32。 */
function float32Buffer(values: readonly number[], little = true): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, little))
  return new Uint8Array(buffer)
}

/**
 * 造一帧**真实尺寸**的 `/fftData`：4 字节前缀 + 1024 个 int16 = 2052 字节。
 *
 * 前缀在真机上是恒为 0 的 4 个字节（40 帧连续采样确认），这里默认也填 0，
 * 但允许调用方给别的值——用来验证"前缀不是数据"的断言。
 */
function fftFrameBuffer(bins: readonly number[], little = true, header = 0): Uint8Array {
  const buffer = new ArrayBuffer(FFT_FRAME_BYTES)
  const view = new DataView(buffer)
  view.setUint32(0, header, true)
  for (let index = 0; index < FFT_BIN_COUNT; index += 1) {
    view.setInt16(4 + index * 2, bins[index] ?? 0, little)
  }
  return new Uint8Array(buffer)
}

/**
 * 造一个**真 JPEG** 帧（最小可解析的基线 JPEG 头 + EOI）。
 *
 * 真机推的是 600×400 的 JPEG，逐帧 45 kB 左右；测试不需要那份熵编码数据，
 * 只需要"魔数正确、长度逐帧可变"这两个被断言的性质，所以这里手写头部。
 */
function jpegFrameBuffer(extraBytes = 64): Uint8Array {
  const header = [
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0: 长度 17、精度 8、高 400、宽 600、3 分量
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x58, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9 // EOI
  ]
  const bytes = new Uint8Array(header.length + extraBytes)
  bytes.set(header, 0)
  // 让帧长逐帧可变，与压缩图像的真实行为一致。
  for (let index = header.length; index < bytes.length; index += 1) bytes[index] = index % 251
  return bytes
}

/** 实测帧长常量（与 `FA371_STREAM_MEASURED` 同源，测试里引用它而不是抄数字）。 */
const FFT_FRAME_BYTES = FA371_STREAM_MEASURED.fftData.bytesPerFrame
const FFT_BIN_COUNT = 1_024
const PCM_FRAME_BYTES = FA371_STREAM_MEASURED.pcmData.bytesPerFrame
const PCM_FRAME_SAMPLES = PCM_FRAME_BYTES / 4
const ENERGY_FRAME_BYTES = FA371_STREAM_MEASURED.energyData.bytesPerFrame

/** `/detectFeedback` 的文本帧内容，结构与手册 §5.2.3 的示例一致。 */
function detectFeedbackText(): string {
  return JSON.stringify({
    detect_log: {
      bin_mic_data_name: 'mic_data_2019_06_20_20_30_39_940.bin',
      data_1: 0.0,
      data_2: -1.0,
      detect_mode: 2,
      end_time: 1561033842,
      files_status: 1,
      id: 7,
      saving_path: '2019_06_20_20_30_39_940/',
      soundmap_intensity: 20.4,
      start_time: 1561033839,
      status: 1,
      wav_mic_data_name: 'mic_data_2019_06_20_20_30_39_940.wav'
    },
    msg: 'SUCCESS',
    ret: 200
  })
}

/**
 * 轮询直到条件成立。
 *
 * 刻意不用固定 sleep：固定 sleep 既慢又不可靠——短了会 flake，长了每个测试都变慢。
 */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) return
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function candidateFor(kind: Parameters<typeof findDecodeCandidate>[0], id: string): Fa371DecodeCandidate {
  return findDecodeCandidate(kind, id)
}

// ---------------------------------------------------------------------------
// 1. 解码测试（真实字节，不 mock 解码器）
// ---------------------------------------------------------------------------

describe('FA371 解码（§8.4 D2–D6）', () => {
  it('/fftData：实测 2052 字节 = 4 字节前缀 + 1024 个 int16，小端', () => {
    const values = Array.from({ length: FFT_BIN_COUNT }, (_, index) => index - 256)
    const bytes = fftFrameBuffer(values, true)

    const frame = decodeFftFrame(bytes, findDecodeCandidate('fftData'), {
      receivedAt: 1_700_000_000_000,
      sequence: 3
    })

    // 真机实测帧长：2052 = 4 + 1024 × 2。这个断言是"几何改了没改"的第一道闸门。
    assert.equal(bytes.byteLength, 2_052)
    assert.equal(bytes.byteLength, FFT_FRAME_BYTES)
    assert.equal(frame.binCount, 1_024)
    assert.equal(frame.values.length, 1_024)
    // 前缀被跳过：第一根谱线读到的就是 values[0]，不是前缀的 4 个字节。
    assert.equal(frame.values[0], -256)
    assert.equal(frame.values[1_023], 767)
    assert.equal(frame.profile.id, FA371_DEFAULT_DECODE_IDS.fftData)
    assert.equal(frame.profile.id, 'int16-le-1024-h4')
    assert.deepEqual(frame.profile, { id: 'int16-le-1024-h4', endianness: 'little', elementBits: 16, signed: true })
    assert.equal(frame.sequence, 3)
    assert.equal(frame.bytes.byteLength, 2_052)
  })

  it('/fftData：前缀的 4 个字节不是数据（把前缀填成非零，谱线不应改变）', () => {
    const values = Array.from({ length: FFT_BIN_COUNT }, (_, index) => (index % 7) - 3)
    const zeroPrefix = decodeFftFrame(fftFrameBuffer(values, true, 0), findDecodeCandidate('fftData'), {
      receivedAt: 0,
      sequence: 0
    })
    const loudPrefix = decodeFftFrame(fftFrameBuffer(values, true, 0xdeadbeef), findDecodeCandidate('fftData'), {
      receivedAt: 0,
      sequence: 0
    })

    // 真机上 40 帧连续采样里前缀恒为 00 00 00 00；即使它不是 0，也不该进入谱线。
    assert.deepEqual(Array.from(loudPrefix.values), Array.from(zeroPrefix.values))
    assert.equal(loudPrefix.values.length, 1_024)
  })

  it('/fftData：mock 的 512 点候选仍然可用，且被标记为非默认', () => {
    const mock = findDecodeCandidate('fftData', 'int16-le-512-mock')
    assert.notEqual(mock.id, FA371_DEFAULT_DECODE_IDS.fftData)
    assert.equal(mock.fftBins, 512)
    assert.equal(mock.headerBytes, undefined)
    assert.equal(expectedFrameBytes(mock), 1_024)

    const frame = decodeFftFrame(int16Buffer(new Array(512).fill(7)), mock, { receivedAt: 0, sequence: 0 })
    assert.equal(frame.values.length, 512)
    assert.equal(frame.values[0], 7)
  })

  it('/fftData：同一个字节序列按大端解读会得到不同的值（证明字节序是选项而非装饰）', () => {
    const values = [0x0102, -0x0102, 0x7fff, -0x8000]
    const bytes = int16Buffer(values, true)

    const little = decodeInt16(bytes, 'little')
    const big = decodeInt16(bytes, 'big')

    assert.deepEqual(Array.from(little), values)
    assert.notDeepEqual(Array.from(big), values)
  })

  it('/fftData：帧长超过假设时按假设截断，短于假设时如实返回短数组', () => {
    const long = decodeFftFrame(
      fftFrameBuffer(Array.from({ length: 1_200 }, () => 1)),
      findDecodeCandidate('fftData'),
      { receivedAt: 0, sequence: 0 }
    )
    const shortPad = new Uint8Array(4 + 100 * 2)
    const short = decodeFftFrame(shortPad, findDecodeCandidate('fftData'), { receivedAt: 0, sequence: 0 })

    assert.equal(long.values.length, 1_024)
    assert.equal(short.values.length, 100)
    assert.equal(short.binCount, 100)
  })

  it('/voiceprintData：实测是 JPEG 图像（600×400 JFIF），不做任何数值解码', () => {
    const bytes = jpegFrameBuffer()
    const frame = decodeVoiceprintFrame(bytes, findDecodeCandidate('voiceprintData'), {
      receivedAt: 42,
      sequence: 1
    })

    // 真机帧首 16 字节：ff d8 ff e0 00 10 4a 46 49 46 00 01 01 00 00 01
    assert.ok(looksLikeJpeg(bytes))
    assert.equal(frame.profile.id, FA371_DEFAULT_DECODE_IDS.voiceprintData)
    assert.equal(frame.profile.id, 'jpeg-image-600x400')
    // 图像被原样带出（base64），而不是被切成一个假的矩阵。
    assert.ok(frame.jpegBase64 && frame.jpegBase64.length > 0)
    assert.equal(Buffer.from(frame.jpegBase64, 'base64').byteLength, bytes.byteLength)
    assert.equal(Buffer.from(frame.jpegBase64, 'base64')[0], 0xff)
    assert.deepEqual(Array.from(frame.values), [])
    assert.equal(frame.width, 0)
    assert.equal(frame.height, 0)
    assert.equal(frame.receivedAt, 42)
  })

  it('/voiceprintData：逐帧长度可变（压缩图像），不是固定 131072 字节的矩阵', () => {
    const small = decodeVoiceprintFrame(jpegFrameBuffer(16), findDecodeCandidate('voiceprintData'), {
      receivedAt: 0,
      sequence: 0
    })
    const large = decodeVoiceprintFrame(jpegFrameBuffer(4_096), findDecodeCandidate('voiceprintData'), {
      receivedAt: 0,
      sequence: 1
    })

    // 这条断言记录的正是"mock 几何被推翻"的原因：矩阵假设下每帧必须恒为 131072 B。
    assert.notEqual(small.bytes.byteLength, large.bytes.byteLength)
    assert.notEqual(small.bytes.byteLength, 131_072)
    // 帧长可变 → 无法校验 → 不该报"帧长不符"。
    assert.equal(checkFrameLayout('voiceprintData', small.bytes, findDecodeCandidate('voiceprintData')).warning, undefined)
  })

  it('/voiceprintData：声明是图像但魔数不对时报出来，而不是当成图像显示', () => {
    const notJpeg = new Uint8Array(64).fill(0x41)
    const frame = decodeVoiceprintFrame(notJpeg, findDecodeCandidate('voiceprintData'), {
      receivedAt: 0,
      sequence: 0
    })
    const check = checkFrameLayout('voiceprintData', notJpeg, findDecodeCandidate('voiceprintData'))

    assert.equal(frame.jpegBase64, undefined)
    assert.equal(frame.width, 0)
    assert.equal(check.warning, 'voiceprint-not-jpeg')
    assert.ok(check.note && check.note.includes('ff d8 ff'))
  })

  it('/voiceprintData：mock 的 128x256 int32 候选仍然可用（数值矩阵路径）', () => {
    const candidate = findDecodeCandidate('voiceprintData', 'int32-le-128x256x1-mock')
    const values = Array.from({ length: 128 * 256 }, (_, index) => index % 255)
    const bytes = int32Buffer(values, true)

    const frame = decodeVoiceprintFrame(bytes, candidate, { receivedAt: 0, sequence: 0 })

    assert.equal(bytes.byteLength, 131_072)
    assert.equal(frame.values.length, 128 * 256)
    assert.equal(frame.width, 256)
    assert.equal(frame.height, 128)
    assert.equal(frame.channels, 1)
    assert.equal(frame.jpegBase64, undefined)
    // 值按 `index % 255` 生成，索引 256*5+3 = 1283 -> 1283 % 255 = 8。
    assert.equal(frame.values[256 * 5 + 3], 8)
    // 这个候选的帧长是固定的，所以能校验——131072 恰好符合。
    assert.equal(expectedFrameBytes(candidate), 131_072)
    assert.equal(checkFrameLayout('voiceprintData', bytes, candidate).warning, undefined)
  })

  it('/voiceprintData：float32 候选按浮点解读', () => {
    const bytes = float32Buffer([1.5, -2.25, 3.0, 4.0])
    const frame = decodeVoiceprintFrame(bytes, findDecodeCandidate('voiceprintData', 'float32-le-128x256x1-mock'), {
      receivedAt: 0,
      sequence: 0
    })

    assert.ok(frame.values instanceof Float32Array)
    assert.deepEqual(Array.from(frame.values), [1.5, -2.25, 3, 4])
    assert.equal(frame.profile.id, 'float32-le-128x256x1-mock')
  })

  it('/energyData：实测 20 字节 = 5 个 int32，顺序是手册原文（能量/横/纵/扫描角/方位角）', () => {
    // 真机的一帧：int32le = [16, 895, 85, 14, 279]。
    const bytes = int32Buffer([16, 895, 85, 14, 279], true)
    const frame = decodeEnergyFrame(bytes, findDecodeCandidate('energyData'), {
      receivedAt: 0,
      sequence: 0
    })

    assert.equal(bytes.byteLength, ENERGY_FRAME_BYTES)
    assert.equal(bytes.byteLength, 20)
    assert.deepEqual(frame.targets, [{ energy: 16, pixelX: 895, pixelY: 85, swathAngle: 14, azimuthAngle: 279 }])
    assert.equal(checkFrameLayout('energyData', bytes, findDecodeCandidate('energyData')).warning, undefined)
  })

  it('/energyData：三组目标点（手册上限）与尾部半组', () => {
    const three = decodeEnergyFrame(
      int32Buffer([100, 11, 22, 33, 44, 200, 55, 66, 77, 88, 300, 1, 2, 3, 4], true),
      findDecodeCandidate('energyData'),
      { receivedAt: 0, sequence: 0 }
    )
    assert.deepEqual(three.targets, [
      { energy: 100, pixelX: 11, pixelY: 22, swathAngle: 33, azimuthAngle: 44 },
      { energy: 200, pixelX: 55, pixelY: 66, swathAngle: 77, azimuthAngle: 88 },
      { energy: 300, pixelX: 1, pixelY: 2, swathAngle: 3, azimuthAngle: 4 }
    ])

    const partial = decodeEnergyFrame(int32Buffer([1, 2, 3, 4, 5, 6, 7, 8], true), findDecodeCandidate('energyData'), {
      receivedAt: 0,
      sequence: 0
    })
    assert.equal(partial.targets.length, 1)
    assert.deepEqual(Array.from(partial.values), [1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('/pcmData：实测 19200 字节 = 4800 个 float32（48 kHz 下的 100 ms）', () => {
    const samples = Array.from({ length: PCM_FRAME_SAMPLES }, (_, index) => Math.sin(index / 40) * 0.25)
    const bytes = float32Buffer(samples, true)

    const frame = decodePcmFrame(bytes, findDecodeCandidate('pcmData'), { receivedAt: 0, sequence: 0 })

    assert.equal(bytes.byteLength, PCM_FRAME_BYTES)
    assert.equal(bytes.byteLength, 19_200)
    assert.equal(frame.samples.length, PCM_FRAME_SAMPLES)
    assert.equal(frame.samples.length, 4_800)
    assert.equal(frame.channels, 1)
    assert.equal(frame.sampleRate, 48_000)
    assert.equal(frame.profile.id, FA371_DEFAULT_DECODE_IDS.pcmData)
    assert.equal(frame.profile.id, 'float32-le-mono-4800')
    // 10 帧/s × 4800 点 = 48000 样本/s，与手册 §5.2.5 的 48 kHz 自洽。
    assert.equal(PCM_FRAME_SAMPLES * FA371_STREAM_MEASURED.pcmData.fps, 48_000)
    assert.equal(checkFrameLayout('pcmData', bytes, findDecodeCandidate('pcmData')).warning, undefined)
  })

  it('/pcmData：mock 的整秒 48000 点候选仍可用，且帧长对不上时会被报出来', () => {
    const mock = findDecodeCandidate('pcmData', 'float32-le-mono-48000-mock')
    assert.equal(expectedFrameBytes(mock), 192_000)
    // 真机的 19200 B 帧喂给它：必须报"帧长不符"，而不是当成 1 秒音频。
    const check = checkFrameLayout('pcmData', float32Buffer(new Array(PCM_FRAME_SAMPLES).fill(0)), mock)
    assert.equal(check.warning, 'frame-size-mismatch')
    assert.equal(check.expected, 192_000)
    assert.equal(check.actual, 19_200)
  })

  it('/pcmData：大端必须逐元素转换（视图路径不可用）', () => {
    const bytes = float32Buffer([1.25, -0.75], false)
    const samples = decodeFloat32(bytes, 'big')

    assert.deepEqual(Array.from(samples), [1.25, -0.75])
    assert.notEqual(samples.buffer, bytes.buffer)
    assert.notDeepEqual(Array.from(decodeFloat32(bytes, 'little')), [1.25, -0.75])
  })

  it('整数解码器：尾部半个元素被丢弃而不是抛异常', () => {
    const bytes = new Uint8Array([1, 0, 2]) // 3 字节：一个完整 int16 + 一个残字节
    assert.equal(decodeInt16(bytes, 'little').length, 1)
    assert.equal(decodeInt32(new Uint8Array(6), 'little').length, 1)
    assert.equal(decodeFloat32(new Uint8Array(3), 'little').length, 0)
  })

  it('/detectFeedback：文本帧 JSON -> 域模型日志，ret/msg 原样带出', () => {
    const text = detectFeedbackText()
    const frame = decodeDetectFeedbackFrame(new TextEncoder().encode(text), true, {
      receivedAt: 1_700_000_000_000,
      sequence: 9
    })

    assert.equal(frame.textFrame, true)
    assert.equal(frame.logs.length, 1)
    const log = frame.logs[0]
    assert.ok(log)
    assert.equal(log.id, 7)
    assert.equal(log.detectMode, 2)
    assert.equal(log.savingPath, '2019_06_20_20_30_39_940/')
    assert.equal(log.resultFiles.wav_mic_data, 'mic_data_2019_06_20_20_30_39_940.wav')
    assert.equal(frame.rawRet, 200)
    assert.equal(frame.rawMsg, 'SUCCESS')
    assert.equal(frame.receivedAt, 1_700_000_000_000)
    assert.equal(frame.sequence, 9)
  })

  it('/detectFeedback：二进制帧里装 JSON 也解（手册一边说 JSON 一边说 byte order）', () => {
    const bytes = new TextEncoder().encode(detectFeedbackText())
    const frame = decodeDetectFeedbackFrame(bytes, false, { receivedAt: 0, sequence: 0 })

    assert.equal(frame.textFrame, false)
    assert.equal(frame.logs.length, 1)
    assert.equal(frame.logs[0]?.id, 7)
  })

  it('/detectFeedback：坏 JSON 不抛异常，返回无日志的帧', () => {
    const frame = decodeDetectFeedbackFrame(new TextEncoder().encode('{"detect_log":{'), true, {
      receivedAt: 0,
      sequence: 0
    })

    assert.deepEqual(frame.logs, [])
    assert.equal(frame.rawRet, undefined)
  })

  it('抽稀：FFT / 声纹 / PCM 预览的形状与极值语义', () => {
    const fftBins = new Array<number>(FFT_BIN_COUNT).fill(0)
    fftBins[0] = 1
    fftBins[1] = 2
    fftBins[2] = 3
    const fft = toFftPreview(
      'dev-1',
      decodeFftFrame(fftFrameBuffer(fftBins), findDecodeCandidate('fftData'), { receivedAt: 7, sequence: 0 })
    )
    assert.deepEqual(fft.bins.slice(0, 3), [1, 2, 3])
    assert.equal(fft.bins.length, 1_024)
    assert.equal(fft.binCount, 1_024)
    assert.equal(fft.timestamp, 7)
    // 设备没上报采样率时**不编造** binHz：界面据此把横轴标成谱线序号。
    assert.equal(fft.binHz, undefined)
    // 上报了才算：200 kHz / 2 / 1024。
    assert.equal(
      toFftPreview(
        'dev-1',
        decodeFftFrame(fftFrameBuffer(fftBins), findDecodeCandidate('fftData'), { receivedAt: 0, sequence: 0 }),
        200_000
      ).binHz,
      200_000 / 2 / 1_024
    )

    // 声纹（数值候选）：4x8 的源，目标 2x2 时块内取最大幅度（而不是平均）。
    const source = new Array<number>(32).fill(0)
    source[0] = 5 // 块 (0,0)
    source[9] = -9 // 行 1、列 1，仍在块 (0,0)
    source[16] = 3 // 块 (0,1)
    const voiceprint = toVoiceprintPreview(
      'dev-1',
      decodeVoiceprintFrame(int32Buffer(source, true), {
        ...candidateFor('voiceprintData', 'int32-le-128x256x1-mock'),
        voiceprintWidth: 8,
        voiceprintHeight: 4
      }, { receivedAt: 0, sequence: 0 }),
      { width: 2, height: 2 }
    )
    assert.equal(voiceprint.width, 2)
    assert.equal(voiceprint.height, 2)
    assert.equal(voiceprint.sourceWidth, 8)
    assert.equal(voiceprint.sourceHeight, 4)
    assert.equal(voiceprint.jpegBase64, undefined)
    // 行优先：源是 8 列 4 行，目标是 2x2，因此每个目标格覆盖 4 列 2 行。
    //   [0] = 源(列 0-3, 行 0-1) = max(|0|, |5|, |0|, ..., |-9|) = 9（负值取幅度）
    //   [1] = 源(列 4-7, 行 0-1) = 没有非零值 -> 0
    //   [2] = 源(列 0-3, 行 2-3) = 3
    //   [3] = 源(列 4-7, 行 2-3) = 0
    assert.deepEqual(voiceprint.cells, [9, 0, 3, 0])

    // 声纹（真机）：JPEG 原样转发，不伪造 64x32 矩阵。
    const jpegFrame = jpegFrameBuffer(128)
    const jpegPreview = toVoiceprintPreview(
      'dev-1',
      decodeVoiceprintFrame(jpegFrame, findDecodeCandidate('voiceprintData'), {
        receivedAt: 0,
        sequence: 0
      })
    )
    assert.deepEqual(jpegPreview.cells, [])
    assert.equal(jpegPreview.width, 0)
    assert.equal(jpegPreview.height, 0)
    assert.ok(jpegPreview.jpegBase64 && jpegPreview.jpegBase64.length > 0)
    assert.equal(jpegPreview.jpegBytes, jpegFrame.byteLength)

    // PCM：包络只保留 buckets 个点，且 peak/rms 来自全量样本。
    const samples = new Float32Array(PCM_FRAME_SAMPLES)
    samples[100] = 1
    const pcm = toPcmPreview(
      'dev-1',
      decodePcmFrame(float32Buffer(Array.from(samples), true), findDecodeCandidate('pcmData'), {
        receivedAt: 0,
        sequence: 0
      }),
      128
    )
    assert.equal(pcm.waveform.length, 128)
    assert.equal(pcm.peak, 1)
    // 4800 个样本里只有 1 个是 1：rms ≈ 1/√4800 ≈ 0.0144。
    assert.ok(pcm.rms > 0 && pcm.rms < 0.02)
    assert.equal(pcm.samples, PCM_FRAME_SAMPLES)
    // 4800 点 / 48 kHz = 100 ms，界面据此不会把一帧说成 1 秒。
    assert.equal(pcm.frameMs, 100)
  })
})

// ---------------------------------------------------------------------------
// 1b. 帧长校验：用错假设必须可见（实测推翻 mock 几何后加的闸门）
// ---------------------------------------------------------------------------

describe('FA371 帧长校验', () => {
  it('默认候选的期望帧长就是实测帧长', () => {
    // 只对"帧长固定且能由候选几何算出"的通道断言；energyData 的目标组数由帧长
    // 决定（手册说最多 3 组），voiceprintData 是 JPEG，两者都只能校验可整除性。
    for (const kind of ['fftData', 'pcmData'] as const) {
      const candidate = findDecodeCandidate(kind)
      assert.equal(expectedFrameBytes(candidate), FA371_STREAM_MEASURED[kind].bytesPerFrame, `${kind} 的期望帧长与实测不一致`)
    }
    assert.equal(FA371_STREAM_MEASURED.fftData.fixedFrameBytes, true)
    assert.equal(FA371_STREAM_MEASURED.pcmData.fixedFrameBytes, true)
    assert.equal(FA371_STREAM_MEASURED.energyData.fixedFrameBytes, true)
    // 逐条写清楚，避免"循环里改了什么"看不出来。
    assert.equal(expectedFrameBytes(findDecodeCandidate('fftData')), 2_052)
    assert.equal(expectedFrameBytes(findDecodeCandidate('pcmData')), 19_200)
    assert.equal(expectedFrameBytes(findDecodeCandidate('energyData')), undefined) // 组数由帧长决定
    assert.equal(expectedFrameBytes(findDecodeCandidate('voiceprintData')), undefined) // JPEG 长度可变
  })

  it('校验通过：真机帧长 + 默认候选不产生任何告警', () => {
    assert.equal(checkFrameLayout('fftData', fftFrameBuffer([]), findDecodeCandidate('fftData')).warning, undefined)
    assert.equal(
      checkFrameLayout('pcmData', float32Buffer(new Array(PCM_FRAME_SAMPLES).fill(0)), findDecodeCandidate('pcmData')).warning,
      undefined
    )
    assert.equal(
      checkFrameLayout('energyData', int32Buffer([1, 2, 3, 4, 5], true), findDecodeCandidate('energyData')).warning,
      undefined
    )
  })

  it('帧长不符时报出期望值与实际值（mock 的 1024 B 帧喂给实测候选）', () => {
    const check = checkFrameLayout('fftData', int16Buffer(new Array(512).fill(1)), findDecodeCandidate('fftData'))
    assert.equal(check.warning, 'frame-size-mismatch')
    assert.equal(check.expected, 2_052)
    assert.equal(check.actual, 1_024)
    assert.ok(check.note && check.note.includes('2052'))
  })

  it('短于声明前缀的帧报 frame-too-short，而不是把前缀当数据解', () => {
    const check = checkFrameLayout('fftData', new Uint8Array([1, 2]), findDecodeCandidate('fftData'))
    assert.equal(check.warning, 'frame-too-short')
    assert.ok(check.note && check.note.includes('4'))
    // 解码本身仍然是安全的：解出 0 条谱线，而不是越界。
    const frame = decodeFftFrame(new Uint8Array([1, 2]), findDecodeCandidate('fftData'), { receivedAt: 0, sequence: 0 })
    assert.equal(frame.values.length, 0)
  })

  it('空帧报 empty-frame', () => {
    const check = checkFrameLayout('fftData', new Uint8Array(0), findDecodeCandidate('fftData'))
    assert.equal(check.warning, 'empty-frame')
    assert.equal(check.actual, 0)
  })

  it('事件流不做固定帧长校验（一包 JSON 的长度本来就由内容决定）', () => {
    const check = checkFrameLayout('detectFeedback', new TextEncoder().encode('{"ret":200}'), findDecodeCandidate('detectFeedback'))
    assert.equal(check.warning, undefined)
    assert.equal(expectedFrameBytes(findDecodeCandidate('detectFeedback')), undefined)
  })
})

describe('FA371 握手认证候选（§8.4 D1）', () => {
  it('候选表默认从"不认证"开始，且每条都是具名的、可报告的', () => {
    assert.ok(FA371_WS_AUTH_CANDIDATES.length >= 2)
    assert.equal(FA371_WS_AUTH_CANDIDATES[0]?.id, 'none')
    for (const candidate of FA371_WS_AUTH_CANDIDATES) {
      assert.ok(candidate.id.length > 0)
      assert.ok(candidate.description.length > 0)
    }
  })

  it('心跳上限不超过手册要求的一分钟', () => {
    assert.ok(FA371_HEARTBEAT_MAX_MS <= 60_000)
    assert.ok(FA371_HEARTBEAT_MAX_MS > 0)
  })
})

// ---------------------------------------------------------------------------
// 2. 真实 socket 测试：本地 RFC6455 服务端
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 服务端帧（不掩码，RFC6455 5.1）。 */
function wsEncode(payload: string | Uint8Array, opcode: 0x1 | 0x2): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  let header: Buffer
  if (body.length < 126) {
    header = Buffer.alloc(2)
    header[1] = body.length
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, body])
}

/**
 * 升级后的连接。
 *
 * 声明成本文件实际用到的那几个成员而不是 `node:net.Socket`：`http.Server` 的
 * `upgrade` 事件在类型上给的是 `stream.Duplex`（上游类型定义如此），
 * 而运行时是一个真正的 socket。写清楚结构性需求，比到处 `as any` 诚实。
 */
interface UpgradeSocket {
  write(data: string | Uint8Array): boolean
  end(data?: Uint8Array): void
  destroy(): void
  setNoDelay(noDelay?: boolean): void
  on(event: 'data' | 'close' | 'error', listener: (...args: never[]) => void): void
}

interface WsTestClient {
  socket: UpgradeSocket
  path: string
  buffer: Buffer
  closed: boolean
}

/**
 * 测试用的最小 WebSocket 服务端。
 *
 * 与 `scripts/mock-fa371.cjs` 的 `handleUpgrade` 同一条实现路径（同样的
 * `Sec-WebSocket-Accept` 计算、同样手写分帧），差别只有两点：
 *   - **可以要求某个 query 参数**，用来验证客户端的握手候选逐条尝试；
 *   - 支持按路径 push，测试自己决定什么时候推什么。
 */
class WsTestServer {
  private readonly server = http.createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  private readonly sockets = new Map<UpgradeSocket, WsTestClient>()
  /** 每条升级请求的 pathname + 完整 URL，用于断言"客户端到底发了什么"。 */
  readonly upgradeUrls: string[] = []
  /** 要求 URL 里出现这个 query 参数才接受升级；'' = 无条件接受。 */
  requiredQuery = ''
  /** 每个连接收到的数据帧（心跳就是数据帧）数量。 */
  heartbeatFrames = 0
  port = 0

  async listen(): Promise<number> {
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head as Buffer))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`
  }

  connections(path?: string): number {
    return [...this.sockets.values()].filter((client) => (path ? client.path === path : true)).length
  }

  /** 向某个路径的所有连接推一帧。 */
  push(path: string, payload: string | Uint8Array, opcode: 0x1 | 0x2 = 0x2): void {
    for (const client of this.sockets.values()) {
      if (client.path !== path || client.closed) continue
      client.socket.write(wsEncode(payload, opcode))
    }
  }

  /** 从服务端一侧强制断开某个路径的连接（模拟设备/网络掉线）。 */
  dropConnections(path?: string): void {
    for (const client of [...this.sockets.values()]) {
      if (path && client.path !== path) continue
      client.closed = true
      client.socket.destroy()
      this.sockets.delete(client.socket)
    }
  }

  async close(): Promise<void> {
    for (const client of this.sockets.values()) client.socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private handleUpgrade(request: http.IncomingMessage, duplex: Duplex, head: Buffer): void {
    // `http.Server`'s `upgrade` event is typed as `stream.Duplex`, while the
    // object handed over at runtime is a real `net.Socket`. The cast names the
    // structural subset this file actually uses (see `UpgradeSocket`).
    const socket = duplex as unknown as UpgradeSocket
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    this.upgradeUrls.push(url.toString())

    if (this.requiredQuery && url.searchParams.get(this.requiredQuery) === null) {
      // 未认证的连接以 401 拒绝升级。客户端拿不到状态码，只能从"没开成"推断，
      // 这正是候选表存在的理由。
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n')
    )
    socket.setNoDelay(true)

    const client: WsTestClient = { socket, path: url.pathname, buffer: Buffer.alloc(0), closed: false }
    this.sockets.set(socket, client)
    if (head.length > 0) this.consume(client, head)
    socket.on('data', (chunk: Buffer) => this.consume(client, chunk))
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))
  }

  /** 只关心"客户端是否发了东西"（心跳）与关闭帧。 */
  private consume(client: WsTestClient, chunk: Buffer): void {
    client.buffer = Buffer.concat([client.buffer, chunk])
    for (;;) {
      const buffer = client.buffer
      if (buffer.length < 2) return
      const opcode = (buffer[0] as number) & 0x0f
      const masked = ((buffer[1] as number) & 0x80) !== 0
      let length = (buffer[1] as number) & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const maskLength = masked ? 4 : 0
      if (buffer.length < offset + maskLength + length) return
      client.buffer = buffer.subarray(offset + maskLength + length)
      if (opcode === 0x8) {
        client.closed = true
        client.socket.end(wsEncode(new Uint8Array(0), 0x2))
        return
      }
      if (opcode === 0x9) {
        client.socket.write(wsEncode(new Uint8Array(0), 0x2))
        continue
      }
      // 数据帧 = 心跳（手册 §5.2 引言要求每分钟至少一条任意消息）。
      this.heartbeatFrames += 1
    }
  }
}

/** 每台测试服务端在用例结束时都必须关掉。 */
const servers: WsTestServer[] = []
const clients: Fa371WsClient[] = []

async function startServer(config: (server: WsTestServer) => void = () => undefined): Promise<WsTestServer> {
  const server = new WsTestServer()
  config(server)
  await server.listen()
  servers.push(server)
  return server
}

function startClient(options: ConstructorParameters<typeof Fa371WsClient>[0]): Fa371WsClient {
  const client = new Fa371WsClient(options)
  clients.push(client)
  return client
}

after(async () => {
  for (const client of clients) client.dispose()
  for (const server of servers) await server.close()
})

describe('Fa371WsClient 真实 socket（127.0.0.1 临时端口）', () => {
  it('/fftData：一帧到达并被解码为 1024 个 int16（实测帧长 2052 B）', async () => {
    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      channels: ['fftData'],
      heartbeatMs: 1_000
    })

    const frames: Fa371FftPreview[] = []
    client.onFrame('fftData', (frame) => frames.push(toFftPreview('cam-1', frame)))
    client.connect()

    await waitFor(() => server.connections('/fftData') === 1, '客户端连上 /fftData')
    server.push('/fftData', fftFrameBuffer(Array.from({ length: FFT_BIN_COUNT }, (_, index) => index)))

    await waitFor(() => frames.length === 1, '收到一帧 FFT')
    try {
      assert.equal(frames[0]?.bins.length, 1_024)
      assert.equal(frames[0]?.bins[0], 0)
      assert.equal(frames[0]?.bins[1_023], 1_023)
      assert.equal(client.statusSnapshot()[0]?.state, 'STREAMING')
      assert.equal(client.statusSnapshot()[0]?.frameCount, 1)
      // 帧长与候选一致，因此没有任何帧长告警。
      assert.equal(client.statusSnapshot()[0]?.layoutWarning, undefined)
      assert.equal(client.statusSnapshot()[0]?.lastFrameBytes, 2_052)
    } finally {
      client.dispose()
    }
  })

  it('/detectFeedback：文本帧被解析为检测日志', async () => {
    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      channels: ['detectFeedback'],
      heartbeatMs: 1_000
    })

    const frames: Fa371DetectFeedbackPreview[] = []
    client.onFrame('detectFeedback', (frame) =>
      frames.push({
        deviceId: 'cam-1',
        kind: 'detectFeedback',
        timestamp: frame.receivedAt,
        logs: frame.logs,
        ...(frame.rawRet !== undefined ? { rawRet: frame.rawRet } : {}),
        ...(frame.rawMsg !== undefined ? { rawMsg: frame.rawMsg } : {})
      })
    )
    client.connect()

    await waitFor(() => server.connections('/detectFeedback') === 1, '客户端连上 /detectFeedback')
    server.push('/detectFeedback', detectFeedbackText(), 0x1)

    await waitFor(() => frames.length === 1, '收到一包检测结果')
    try {
      assert.equal(frames[0]?.logs.length, 1)
      assert.equal(frames[0]?.logs[0]?.id, 7)
      assert.equal(frames[0]?.rawRet, 200)
    } finally {
      client.dispose()
    }
  })

  it('五路通道同时建立，各自只收到自己路径的帧', async () => {
    const server = await startServer()
    const received: string[] = []
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      heartbeatMs: 1_000
    })
    for (const kind of FA371_STREAM_KINDS) {
      client.onFrame(kind, () => received.push(kind))
    }
    client.connect()

    await waitFor(
      () => FA371_STREAM_KINDS.every((kind) => server.connections(`/${kind}`) === 1),
      '五路都连上'
    )

    server.push('/fftData', fftFrameBuffer([1, 2]))
    server.push('/pcmData', float32Buffer([1, 2, 3, 4]))
    server.push('/energyData', int32Buffer([1, 2, 3, 4, 5]))
    // 实测：/voiceprintData 推的是 JPEG，这里也推一帧真 JPEG。
    server.push('/voiceprintData', jpegFrameBuffer(32))
    server.push('/detectFeedback', detectFeedbackText(), 0x1)

    await waitFor(() => received.length === 5, '五路各收到一帧')
    try {
      assert.deepEqual([...received].sort(), [...FA371_STREAM_KINDS].sort())
      assert.equal(server.connections(), 5)
    } finally {
      client.dispose()
    }
  })

  it('clean stop：关掉 socket、状态转为 STOPPED，并且可以再次 connect', async () => {
    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      channels: ['fftData'],
      heartbeatMs: 1_000
    })
    client.connect()
    await waitFor(() => server.connections('/fftData') === 1, '客户端连上')

    client.stop()

    // 客户端侧：状态是 STOPPED，且没有残留连接。
    assert.equal(client.statusSnapshot()[0]?.state, 'STOPPED')
    await waitFor(() => server.connections('/fftData') === 0, '服务端看到连接关闭')

    // stop() 之后仍可再次启动（而不是变成一次性对象）。
    client.connect()
    await waitFor(() => server.connections('/fftData') === 1, '重新 connect 后又连上')
    client.dispose()
  })

  it('服务端断开后自动重连，并继续收到帧', async () => {
    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      channels: ['fftData'],
      heartbeatMs: 1_000,
      // 让重连退避的下限尽量短，测试因此不必等几秒。
      maxReconnectDelayMs: 50
    })

    const frames: number[] = []
    client.onFrame('fftData', (frame) => frames.push(frame.values.length))
    client.connect()

    await waitFor(() => server.connections('/fftData') === 1, '第一次连接')
    server.push('/fftData', fftFrameBuffer(Array.from({ length: 3 }, () => 1)))
    await waitFor(() => frames.length === 1, '第一帧到达')

    // 服务端强制断开：客户端必须自己回来，而不是停在 ERROR。
    server.dropConnections('/fftData')
    await waitFor(() => server.connections('/fftData') === 1, '重连成功')

    const second = new Array<number>(FFT_BIN_COUNT).fill(0)
    second[0] = 4
    second[1] = 5
    second[2] = 6
    server.push('/fftData', fftFrameBuffer(second))
    await waitFor(() => frames.length === 2, '重连后继续收到帧')
    try {
      assert.deepEqual(frames, [1_024, 1_024])
      // 两帧都是实测帧长、都命中默认候选，因此全程没有帧长告警。
      assert.equal(client.statusSnapshot()[0]?.layoutWarning, undefined)
      assert.equal(client.statusSnapshot()[0]?.state, 'STREAMING')
    } finally {
      client.dispose()
    }
  })

  it('事件流（/detectFeedback）不会因为"一直没数据"被误判为认证失败', async () => {
    // 实测过的一个真实错误：静默候选探测把一个**可用**的候选（none）在事件流上
    // 降级了，因为两次检测之间本来就没有帧。这里把探测预算压到 30 ms，
    // 如果是"安静即降级"，候选早就换了；断言它没有换。
    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: { token: 'FA371-TEST-TOKEN' },
      channels: ['detectFeedback'],
      heartbeatMs: 1_000,
      candidateProbeMs: 30,
      maxReconnectDelayMs: 50
    })
    client.connect()

    await waitFor(() => server.connections('/detectFeedback') === 1, '事件流连上')
    await new Promise((resolve) => setTimeout(resolve, 200))

    try {
      const status = client.statusSnapshot()[0]
      assert.equal(status?.state, 'STREAMING')
      // 唯一一次升级尝试就是不认证那条，且连接一直开着。
      assert.equal(new URL(server.upgradeUrls[0] as string).search, '')
      assert.equal(status?.handshakeAuthId, 'none')
      assert.equal(server.connections('/detectFeedback'), 1)

      // 收到事件之后照常被确认。
      server.push('/detectFeedback', detectFeedbackText(), 0x1)
      await waitFor(() => (client.statusSnapshot()[0]?.frameCount ?? 0) === 1, '收到一包检测结果')
      assert.equal(client.statusSnapshot()[0]?.handshakeCertainty, 'confirmed-by-frame')
    } finally {
      client.dispose()
    }
  })

  it('心跳：连接建立后客户端至少发一条任意消息（手册要求每分钟）', async () => {    const server = await startServer()
    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: {},
      channels: ['fftData'],
      heartbeatMs: 1_000
    })
    client.connect()

    await waitFor(() => server.heartbeatFrames >= 1, '服务端收到心跳帧')
    client.dispose()
    // 心跳内容是"任意内容"，本实现发的是明确的 heartbeat JSON，而不是订阅消息：
    // 手册没有要求任何 subscribe（§5.2 引言），发一个手册没要求的东西是危险的。
    assert.ok(server.heartbeatFrames >= 1)
  })

  it('握手认证：候选逐条尝试，胜出的那条被记住并报告（§8.4 D1）', async () => {
    const server = await startServer((instance) => {
      // 只接受 ?token=... —— 前两条候选（不带认证、?Authorization=...）都会被拒。
      instance.requiredQuery = 'token'
    })

    const client = startClient({
      deviceId: 'cam-1',
      baseWsUrl: server.url,
      authHeaders: { token: 'FA371-TEST-TOKEN' },
      channels: ['fftData'],
      heartbeatMs: 1_000,
      maxReconnectDelayMs: 50,
      candidateProbeMs: 200
    })
    client.connect()

    await waitFor(() => server.connections('/fftData') === 1, '带 token 的候选最终被接受')
    try {
      /**
       * 断言升级 URL 的**序列**而不是按下标取值。
       *
       * 实测：Node 的 WebSocket（undici）在服务端用 HTTP 错误码（这里是 401）
       * 拒绝握手时会**自行重试一次**，所以每个被拒的候选会产生两条升级请求，
       * 固定下标会随运行时版本变化而失效。要断言的是
       * "依次试过：不带认证 -> ?Authorization= -> ?token="，以及最后一次成功。
       */
      const attempts = server.upgradeUrls.map((entry) => new URL(entry).search)
      const shape = attempts.filter((search, index) => index === 0 || search !== attempts[index - 1])
      assert.deepEqual(shape, ['', '?Authorization=FA371-TEST-TOKEN', '?token=FA371-TEST-TOKEN'])
      // 只有最后一种形式被接受（服务端只放行 ?token=）。
      assert.equal(new URL(server.upgradeUrls[server.upgradeUrls.length - 1] as string).searchParams.get('token'), 'FA371-TEST-TOKEN')
      assert.ok(server.connections('/fftData') === 1)

      assert.equal(client.resolvedAuthId(), 'token-query')
      const status = client.statusSnapshot()[0]
      assert.equal(status?.handshakeAuthId, 'token-query')
      // 还没有帧，所以只能算"未确认"。
      assert.equal(status?.handshakeCertainty, 'unconfirmed')

      server.push('/fftData', int16Buffer([1, 2]))
      await waitFor(() => (client.statusSnapshot()[0]?.frameCount ?? 0) === 1, '收到帧')
      assert.equal(client.statusSnapshot()[0]?.handshakeCertainty, 'confirmed-by-frame')
    } finally {
      client.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 服务层：设备解析、抽稀、会话状态、释放
// ---------------------------------------------------------------------------

function cameraDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'cam-1',
    deviceUid: 'camera:127.0.0.1',
    kind: 'acousticCamera',
    name: 'Camera 1',
    ip: '127.0.0.1',
    httpPort: 80,
    connectionType: 'LAN',
    status: 'ONLINE',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('Fa371StreamService', () => {
  it('起停一路相机流，并把抽稀后的预览推给订阅者', async () => {
    const server = await startServer()
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice(),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => server.url.replace(/^ws:/, 'http:')
      },
      createClient: (options) => {
        const client = new Fa371WsClient(options)
        clients.push(client)
        return client
      }
    })

    const previews: Fa371StreamPreview[] = []
    service.on('preview', (preview: Fa371StreamPreview) => previews.push(preview))

    const state = service.start('cam-1', ['fftData', 'pcmData'])
    try {
      assert.deepEqual(state.running, ['fftData', 'pcmData'])
      assert.equal(state.channelId, 0)
      assert.equal(state.decodeProfiles.fftData, 'int16-le-1024-h4')
      assert.equal(state.decodeProfiles.pcmData, 'float32-le-mono-4800')
      assert.equal(state.pcm?.sampleRate, 48_000)
      // 对外报的是**秒**（不是"能装几个块"）：实测帧长下 5 秒 = 50 个 100 ms 帧。
      assert.equal(state.pcm?.bufferSeconds, 5)
      // 实测每帧 4800 点 = 48 kHz 下的 100 ms；界面靠它不说"一帧 1 秒"。
      assert.equal(state.pcm?.frameMs, 100)
      // 设备没有可用的采样率接口，因此不填这个字段（界面显示"频率轴未知"）。
      assert.equal(state.deviceSampleRate, undefined)
      // 没有任何一路帧长不符：这个字段不该存在。
      assert.equal(state.layoutWarnings, undefined)

      await waitFor(
        () => server.connections('/fftData') === 1 && server.connections('/pcmData') === 1,
        '两路都连上'
      )

      server.push('/fftData', fftFrameBuffer([1, 2, 3]))
      server.push('/pcmData', float32Buffer(Array.from({ length: PCM_FRAME_SAMPLES }, (_, index) => Math.sin(index / 40) * 0.25)))

      await waitFor(() => previews.length >= 2, '两路预览都到达')

      const fft = previews.find((preview): preview is Fa371FftPreview => preview.kind === 'fftData')
      const pcm = previews.find((preview): preview is Fa371PcmPreview => preview.kind === 'pcmData')
      assert.ok(fft && pcm)
      assert.equal(fft.deviceId, 'cam-1')
      assert.equal(fft.bins.length, 1_024)
      assert.deepEqual(fft.bins.slice(0, 3), [1, 2, 3])
      // 抽稀的关键断言：19200 字节的帧没有以 4800 个样本过 IPC。
      assert.equal(pcm.waveform.length, 512)
      assert.equal(pcm.samples, PCM_FRAME_SAMPLES)
      assert.equal(pcm.frameMs, 100)
      assert.ok(pcm.peak > 0.2 && pcm.peak <= 0.25)

      // 会话状态里能读到帧计数与缓冲状态。
      const snapshot = service.listState('cam-1')[0]
      assert.ok(snapshot)
      assert.equal(snapshot.streams.find((item) => item.kind === 'pcmData')?.frameCount, 1)
      assert.equal(snapshot.pcm?.droppedFrames, 0)
      // 一帧就命中默认候选，因此不该出现帧长告警。
      assert.equal(snapshot.streams.find((item) => item.kind === 'fftData')?.layoutWarning, undefined)
    } finally {
      service.dispose()
    }
  })

  it('声纹通道转发真机 JPEG（不是数值矩阵），并带上字节数', async () => {
    const server = await startServer()
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice(),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => server.url.replace(/^ws:/, 'http:')
      }
    })

    const previews: Fa371StreamPreview[] = []
    service.on('preview', (preview: Fa371StreamPreview) => previews.push(preview))

    service.start('cam-1', ['voiceprintData'])
    try {
      await waitFor(() => server.connections('/voiceprintData') === 1, '声纹通道连上')
      const frame = jpegFrameBuffer(2_048)
      server.push('/voiceprintData', frame)
      await waitFor(() => previews.length >= 1, '声纹预览到达')

      const voiceprint = previews.find((preview) => preview.kind === 'voiceprintData')
      assert.ok(voiceprint)
      assert.ok(voiceprint.jpegBase64 && voiceprint.jpegBase64.length > 0)
      assert.equal(voiceprint.jpegBytes, frame.byteLength)
      assert.deepEqual(voiceprint.cells, [])
      assert.equal(voiceprint.width, 0)
      assert.equal(voiceprint.height, 0)
      // 一台真机的一帧就长这样：帧首是 JPEG 魔数，长度不固定。
      assert.equal(Buffer.from(voiceprint.jpegBase64, 'base64')[0], 0xff)
      assert.equal(Buffer.from(voiceprint.jpegBase64, 'base64')[1], 0xd8)
    } finally {
      service.dispose()
    }
  })

  it('帧长与候选不符时，会话状态里带出 layoutWarnings', async () => {
    const server = await startServer()
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice(),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => server.url.replace(/^ws:/, 'http:')
      },
      // 故意换成 mock 那条 512 点候选，然后喂真机尺寸（2052 B）的帧。
      decode: { fftData: 'int16-le-512-mock' }
    })

    service.start('cam-1', ['fftData'])
    try {
      await waitFor(() => server.connections('/fftData') === 1, '通道连上')
      server.push('/fftData', fftFrameBuffer([]))
      await waitFor(
        () => service.listState('cam-1')[0]?.layoutWarnings !== undefined,
        '帧长告警进入会话状态'
      )

      const state = service.listState('cam-1')[0]
      assert.ok(state)
      assert.equal(state.layoutWarnings?.fftData, 'frame-size-mismatch')
      const status = state.streams.find((item) => item.kind === 'fftData')
      assert.equal(status?.layoutWarning, 'frame-size-mismatch')
      // 细节写的是**候选期望**的字节数（mock 候选 = 1024）与实际值（真机 2052）。
      assert.ok(status?.layoutNote && status.layoutNote.includes('expected 1024 B'))
      assert.ok(status?.layoutNote && status.layoutNote.includes('got 2052 B'))
    } finally {
      service.dispose()
    }
  })

  it('叠加一路通道会收敛到目标集合，stop 之后状态为空', async () => {
    const server = await startServer()
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice(),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => server.url.replace(/^ws:/, 'http:')
      }
    })

    service.start('cam-1', ['fftData'])
    await waitFor(() => server.connections('/fftData') === 1, '仅 /fftData 连上')

    const widened = service.start('cam-1', ['fftData', 'energyData'])
    try {
      assert.deepEqual(widened.running, ['fftData', 'energyData'])
      await waitFor(
        () => server.connections('/fftData') === 1 && server.connections('/energyData') === 1,
        '扩宽后两路都连上'
      )

      service.stop('cam-1')
      assert.deepEqual(service.listState('cam-1'), [])
      await waitFor(() => server.connections() === 0, '全部 socket 已关闭')
    } finally {
      service.dispose()
    }
  })

  it('非相机设备或空通道集合会被拒绝', async () => {
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice(),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => 'http://127.0.0.1'
      }
    })
    try {
      assert.throws(() => service.start('cam-1', []), /至少选择一路/)
      assert.deepEqual(service.listState('nobody'), [])
    } finally {
      service.dispose()
    }
  })

  it('设备没有地址时抛出明确的离线错误，而不是去连一个空 URL', () => {
    const service = new Fa371StreamService({
      toWebSocketUrl,
      resolver: {
        get: () => cameraDevice({ ip: undefined }),
        findAuthHeaders: () => ({}),
        findBaseUrl: () => undefined
      }
    })
    try {
      assert.throws(() => service.start('cam-1', ['fftData']), /无法确定相机的地址/)
    } finally {
      service.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 真机实测与 mock 假设的对照（不启动进程，只断言两套几何都还在）
// ---------------------------------------------------------------------------

describe('真机实测（2026-09-15，192.168.110.235）与 mock 假设的对照', () => {
  it('默认候选 = 实测值，且每一条都有实测出处', () => {
    assert.equal(FA371_DEFAULT_DECODE_IDS.fftData, 'int16-le-1024-h4')
    assert.equal(FA371_DEFAULT_DECODE_IDS.voiceprintData, 'jpeg-image-600x400')
    assert.equal(FA371_DEFAULT_DECODE_IDS.energyData, 'int32-le-groups5')
    assert.equal(FA371_DEFAULT_DECODE_IDS.pcmData, 'float32-le-mono-4800')
    assert.equal(FA371_DEFAULT_DECODE_IDS.detectFeedback, 'json-text-frame')

    // 每一路的默认候选都必须排在候选表第一位（顺序即优先级）。
    for (const kind of FA371_STREAM_KINDS) {
      assert.equal(
        FA371_DECODE_CANDIDATES[kind][0]?.id,
        FA371_DEFAULT_DECODE_IDS[kind],
        `${kind} 的默认候选不在候选表首位`
      )
    }
  })

  it('实测帧长自洽（字节数、帧率、推导）', () => {
    // /fftData：2052 B × 10.06/s = 1024 × int16 + 4 B 前缀。
    assert.equal(4 + 1_024 * 2, FA371_STREAM_MEASURED.fftData.bytesPerFrame)
    // /pcmData：19200 B = 4800 × float32；10 帧/s → 48000 样本/s。
    assert.equal(4_800 * 4, FA371_STREAM_MEASURED.pcmData.bytesPerFrame)
    assert.equal(4_800 * FA371_STREAM_MEASURED.pcmData.fps, 48_000)
    // /energyData：20 B = 5 × int32。
    assert.equal(5 * 4, FA371_STREAM_MEASURED.energyData.bytesPerFrame)
    // /voiceprintData：JPEG，帧长不固定。
    assert.equal(FA371_STREAM_MEASURED.voiceprintData.fixedFrameBytes, false)
    // /detectFeedback：事件流，6 s 窗口内 0 帧。
    assert.equal(FA371_STREAM_MEASURED.detectFeedback.fps, 0)
  })

  it('mock 的几何仍然原样保留在候选表里（第二条读法不能被删掉）', () => {
    // mock 的 WS_GUESSES 明写：fft 512×int16、voiceprint 128×256×int32、
    // pcm 单声道 48000×float32（= 1024 / 131072 / 192000 字节）。
    const fftMock = findDecodeCandidate('fftData', 'int16-le-512-mock')
    const voiceMock = findDecodeCandidate('voiceprintData', 'int32-le-128x256x1-mock')
    const pcmMock = findDecodeCandidate('pcmData', 'float32-le-mono-48000-mock')

    assert.equal(fftMock.fftBins, 512)
    assert.equal(voiceMock.voiceprintWidth! * voiceMock.voiceprintHeight!, 128 * 256)
    assert.equal(pcmMock.pcmFrameSamples, 48_000)
    assert.equal(pcmMock.pcmChannels, 1)
    // 三条都不是默认值：默认值已经换成实测几何。
    assert.notEqual(fftMock.id, FA371_DEFAULT_DECODE_IDS.fftData)
    assert.notEqual(voiceMock.id, FA371_DEFAULT_DECODE_IDS.voiceprintData)
    assert.notEqual(pcmMock.id, FA371_DEFAULT_DECODE_IDS.pcmData)

    // 字节换算（mock 的 WS_GUESSES 原文）：
    //   voiceprint 128×256×int32 = 131072 字节/帧
    //   pcm 单声道 48000×float32 = 192000 字节/帧
    //   fft 512×int16            = 1024 字节/帧
    assert.equal(128 * 256 * 4, 131_072)
    assert.equal(48_000 * 4, 192_000)
    assert.equal(512 * 2, 1_024)
  })
})
