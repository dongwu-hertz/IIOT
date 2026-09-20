/**
 * FA371 camera streaming IPC — bridges the main-process camera stream service to
 * the renderer (manual §5.2).
 *
 * RESPONSIBILITY SPLIT (identical to `monitor-bridge.ts` for the acoustic box)
 *   - `handlers.ts` owns the request/response surface.
 *   - this module owns the PUSH side: subscribing to the stream service and
 *     forwarding to one renderer window.
 *
 * Keeping them apart matters because the two have different failure modes: a
 * handler that throws is reported to its caller, whereas a push that throws is
 * invisible and can silently kill a subscription. Forwarding is therefore
 * written so that no downstream error can propagate back into the WebSocket
 * frame handler.
 *
 * THROTTLING / DECIMATION
 * The service has already decimated before emitting, so nothing is throttled
 * here: `/pcmData` arrives as a 512-point envelope plus peak/rms (never the
 * 192 000 B/s of raw float32), `/voiceprintData` as a 64x32 matrix (never
 * 131 072 B/s), and `/fftData` as 512 integers (5 120 B/s). Pushing the raw
 * frames would saturate the bridge and stall the UI — measured on the acoustic
 * box, where raw audio is 3.8 MB/s. See `fa371-stream-service.ts` for what is
 * decimated and why the block extreme is kept rather than the mean.
 */

import type { BrowserWindow } from 'electron'
import { PushChannels } from '@shared/ipc/contract'
import type { Fa371MonitorState, Fa371StreamStatus } from '@shared/ipc/contract'
import type { Fa371StreamKind, Fa371StreamPreview } from '@shared/domain/fa371-stream'
import type { Fa371StreamService } from '../services/device/fa371/fa371-stream-service'
import { deviceLog } from '../services/logging/logger'

/**
 * Which push channel each channel kind travels on.
 *
 * One channel per kind rather than a single multiplexed one: a component that
 * draws the spectrum should not receive (and discard) 192 KB of audio preview
 * per second, and the preload bridge's unsubscribe discipline only works if the
 * subscription is per-datum.
 */
export const FA371_PUSH_CHANNELS: Readonly<Record<Fa371StreamKind, string>> = {
  fftData: PushChannels.FA371_FFT,
  voiceprintData: PushChannels.FA371_VOICEPRINT,
  energyData: PushChannels.FA371_ENERGY,
  pcmData: PushChannels.FA371_PCM,
  infraredData: PushChannels.FA371_INFRARED,
  detectFeedback: PushChannels.FA371_DETECT_FEEDBACK
}

/**
 * Wire a `Fa371StreamService`'s frames to one renderer window.
 *
 * @returns a disposer that detaches every listener and clears the forwarding
 *   references. The caller MUST invoke it when the window closes or streaming
 *   stops; otherwise the service keeps emitting into a destroyed webContents.
 */
export function attachFa371StreamForwarding(
  service: Fa371StreamService,
  window: BrowserWindow
): () => void {
  const disposers: Array<() => void> = []

  /**
   * Send only when the window can still receive.
   *
   * `isDestroyed()` alone is not enough: a window mid-teardown passes that check
   * and then throws on `send`. The try/catch is the actual guard, and it must
   * not rethrow — an exception here would propagate into the WebSocket frame
   * handler and tear down a healthy stream.
   */
  const send = (channel: string, payload: unknown): void => {
    if (window.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch (error) {
      deviceLog().debug('Dropped a camera frame push', {
        channel,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const onPreview = (preview: Fa371StreamPreview): void => {
    const channel = FA371_PUSH_CHANNELS[preview.kind]
    if (channel) send(channel, preview)
  }
  service.on('preview', onPreview)
  disposers.push(() => service.off('preview', onPreview))

  const onStatus = (status: Fa371StreamStatus): void => send(PushChannels.FA371_STREAM_STATUS, status)
  service.on('stream-status', onStatus)
  disposers.push(() => service.off('stream-status', onStatus))

  // Authoritative session state. Without it the renderer cannot learn that a
  // session ended on the MAIN side (device lost, every socket in ERROR,
  // shutdown), and its badge would claim "running" while nothing arrives.
  const onState = (state: Fa371MonitorState): void => send(PushChannels.FA371_STREAM_STATE, state)
  service.on('state', onState)
  disposers.push(() => service.off('state', onState))

  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}
