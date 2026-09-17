/**
 * Monitoring IPC — bridges the main-process stream services to the renderer.
 *
 * RESPONSIBILITY SPLIT
 *   - `handlers.ts` owns the request/response surface.
 *   - this module owns the PUSH side: subscribing to stream events and
 *     forwarding them to the renderer's webContents.
 *
 * Keeping them apart matters because the two have different failure modes. A
 * handler that throws is reported to the caller; a push that throws is invisible
 * and can silently kill a stream subscription. Push forwarding is therefore
 * written so that no downstream error can propagate back into the stream.
 *
 * THROTTLING
 * The device's audio stream delivers ~10 frames/s and the spectrogram ~1.5/s.
 * Those are already display rates, so no further throttling is applied — but the
 * audio payload forwarded here is the DECIMATED preview (peak, RMS, ~128
 * waveform points), never raw PCM. At 3.8 MB/s the raw stream would saturate the
 * IPC bridge and stall the UI.
 */

import type { BrowserWindow } from 'electron'
import { PushChannels } from '@shared/ipc/contract'
import type {
  AudioFrameEvent,
  RecordingStateEvent,
  SpectrogramFrameEvent,
  SpectrumFrameEvent,
  StreamStatusEvent
} from '@shared/domain/monitoring'
import type { FeatureStreamEvent } from '@shared/domain/monitoring'
import type { MonitorState } from '@shared/ipc/contract'
import type { StreamManager } from '../services/stream/stream-manager'
import { deviceLog } from '../services/logging/logger'

/**
 * Wire a StreamManager's events to a renderer window.
 *
 * @returns a disposer that detaches every listener and clears the forwarding
 *   references. The caller MUST invoke it when the window closes or monitoring
 *   stops; otherwise the manager keeps emitting into a destroyed webContents.
 */
export function attachStreamForwarding(manager: StreamManager, window: BrowserWindow): () => void {
  const disposers: Array<() => void> = []

  /**
   * Send only when the window can still receive.
   *
   * `isDestroyed()` alone is not enough: a window mid-teardown passes that check
   * and then throws on `send`. The try/catch is the actual guard, and it must not
   * rethrow — an exception here would propagate into the WebSocket frame handler
   * and tear down a healthy stream.
   */
  const send = (channel: string, payload: unknown): void => {
    if (window.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch (error) {
      deviceLog().debug('Dropped a renderer push', {
        channel,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Subscribe a manager event to a push channel. */
  const forward = <T>(event: string, channel: string): void => {
    const listener = (payload: T): void => send(channel, payload)
    manager.on(event, listener)
    disposers.push(() => manager.off(event, listener))
  }

  // The manager re-emits service events; see `services` below for the sources.
  forward<FeatureStreamEvent>('feature', PushChannels.MONITOR_FEATURE)
  forward<AudioFrameEvent>('audio', PushChannels.MONITOR_AUDIO)
  forward<SpectrumFrameEvent>('spectrum', PushChannels.MONITOR_SPECTRUM)
  forward<SpectrogramFrameEvent>('spectrogram', PushChannels.MONITOR_SPECTROGRAM)
  forward<StreamStatusEvent>('stream-status', PushChannels.MONITOR_STATUS)
  forward<RecordingStateEvent>('recording-state', PushChannels.MONITOR_RECORDING_STATE)
  // Authoritative session state. Without it the renderer cannot learn that a
  // session ended on the MAIN side (device lost, terminal stream error,
  // shutdown), and its badge would claim "running" while nothing arrives.
  forward<MonitorState>('state', PushChannels.MONITOR_STATE)

  return () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}
