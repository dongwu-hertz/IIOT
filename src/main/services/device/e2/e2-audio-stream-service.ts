/**
 * SN-16 实时音频（`/audio_stream` WebSocket）—— 只服务 Air Sonar。
 *
 * 设备实测格式：单声道 16-bit 小端 PCM，10 Hz 一帧（4096 字节），采样率 20 kHz。
 * `WebSocketStream` 只负责连接、100 ms ping、重连与关停；这里负责把 PCM 解码成
 * 归一化 Float32 并推给渲染层播放。渲染层只负责 AudioContext 排包，不直接接触设备网络。
 */
import { EventEmitter } from 'node:events'
import type { DeviceService } from '../device-service'
import type { E2AudioFrameEvent } from '@shared/domain/e2-callback'
import { WebSocketStream } from '../../stream/websocket-stream'
import { deviceLog } from '../../logging/logger'

export class E2AudioStreamService extends EventEmitter {
  private readonly devices: DeviceService
  private readonly streams = new Map<string, WebSocketStream>()

  constructor(options: { devices: DeviceService }) {
    super()
    this.devices = options.devices
  }

  async start(deviceId: string): Promise<void> {
    if (this.streams.has(deviceId)) return
    const device = this.devices.get(deviceId)
    if (device.kind !== 'auscultationBox') {
      throw new Error('该设备不是听诊盒子族，没有实时音频流')
    }
    const client = this.devices.e2ClientFor(device)
    const descriptor = await client.audioStreamDescriptor()

    const stream = new WebSocketStream({
      baseWsUrl: descriptor.wsBaseUrl,
      profile: {
        path: '/audio_stream',
        pingIntervalMs: 100,
        pingBody: '{"type": "ping", "channel": "0"}',
        carriesChannel: false,
        purpose: 'SN-16 live PCM audio'
      },
      headers: { token: descriptor.token },
      onFrame: (frame) => {
        if (!frame.binary) return
        const byteCount = frame.bytes.byteLength - (frame.bytes.byteLength % 2)
        const samples = new Array<number>(byteCount / 2)
        if (byteCount === 0) return
        const view = new DataView(frame.bytes.buffer, frame.bytes.byteOffset, byteCount)
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = view.getInt16(index * 2, true) / 32768
        }
        const event: E2AudioFrameEvent = {
          deviceId,
          at: frame.receivedAt,
          sampleRate: descriptor.sampleRate,
          samples
        }
        this.emit('frame', event)
      }
    })
    this.streams.set(deviceId, stream)
    stream.start()
    deviceLog().info('SN-16 live audio stream started', {
      deviceId,
      sampleRate: descriptor.sampleRate
    })
  }

  stop(deviceId: string): void {
    const stream = this.streams.get(deviceId)
    if (!stream) return
    stream.stop()
    this.streams.delete(deviceId)
    deviceLog().info('SN-16 live audio stream stopped', { deviceId })
  }

  dispose(): void {
    for (const stream of this.streams.values()) stream.stop()
    this.streams.clear()
  }
}
