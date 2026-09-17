/**
 * ⚠️ SIMULATED realtime data — temporary scaffolding, NOT device data.
 *
 * The `/features_stream` IPC channel does not exist yet (Phase 4). Every chart
 * and metric in the monitoring view is therefore driven by this composable, and
 * the view shows a permanent amber banner saying so. Nothing here may ever be
 * mistaken for a measurement:
 *
 *   - it lives entirely in the renderer and touches no network (spec appendix C
 *     rule 3 — reinforced by the `connect-src 'none'` CSP);
 *   - it produces `RealtimeFeature` domain frames, so when the real stream lands
 *     the view code does not change — only the source of `frames` does;
 *   - it is deleted, not adapted, in Phase 4.
 *
 * The generator is deliberately smooth (random walk with bounded drift plus a
 * slow sinusoid) so the trend/spectrum/spectrogram panels behave like a real
 * machine rather than white noise.
 */

import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'
import type { RealtimeFeature } from '@shared/domain/models'

/** One simulated frame per second — the firmware's nominal feature rate. */
export const SIMULATED_FRAME_INTERVAL_MS = 1000

/** Number of FFT bins synthesised for the spectrum panel. */
export const SIMULATED_SPECTRUM_BINS = 96

/** Upper bound of the simulated spectrum, Hz. */
export const SIMULATED_SPECTRUM_MAX_HZ = 1000

export interface SimulatedRealtimeOptions {
  /** Current device id; frames are stamped with it. */
  deviceId: () => string
  /** Current 0-based channel index. */
  channelIndex: () => number
  /** Frame period, ms. */
  intervalMs?: number
  /** Rolling window kept for the trend chart. */
  historySize?: number
  /** Number of spectrum snapshots kept for the spectrogram. */
  spectrogramDepth?: number
  /** Start ticking as soon as the owning component mounts. */
  autostart?: boolean
}

export interface SimulatedRealtime {
  /** Rolling window of frames, oldest first. */
  frames: Ref<RealtimeFeature[]>
  /** Newest frame, or null before the first tick. */
  latest: ComputedRef<RealtimeFeature | null>
  /** Energy per frequency bin, 0..1, length = SIMULATED_SPECTRUM_BINS. */
  spectrum: Ref<number[]>
  /** History of spectra, oldest first, for the spectrogram heat map. */
  spectrogram: Ref<number[][]>
  running: Ref<boolean>
  /** Always true: rendered in the UI so nobody mistakes this for live data. */
  simulated: true
  start: () => void
  stop: () => void
  /** Drop all buffers (used when the monitored channel changes). */
  reset: () => void
}

/** Bounded random walk that keeps a value inside [min, max]. */
function drift(value: number, step: number, min: number, max: number): number {
  const next = value + (Math.random() - 0.5) * step
  if (next < min) return min + (min - next) * 0.5
  if (next > max) return max - (next - max) * 0.5
  return next
}

export function useSimulatedRealtime(options: SimulatedRealtimeOptions): SimulatedRealtime {
  const intervalMs = options.intervalMs ?? SIMULATED_FRAME_INTERVAL_MS
  const historySize = options.historySize ?? 120
  const spectrogramDepth = options.spectrogramDepth ?? 60

  const frames = ref<RealtimeFeature[]>([])
  const spectrum = ref<number[]>([])
  const spectrogram = ref<number[][]>([])
  const running = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null
  let tickCount = 0

  /** Per-channel generator state, so CH1..CH8 look like different sensors. */
  let state = {
    channelSeed: 0,
    spl: 62,
    mainFrequency: 50,
    smoothness: 0.72,
    bandEnergyRatio: 0.18,
    oddEvenHarmonicRatio: 1.4,
    spectralComplexity: 0.35,
    fingerprintVariation: 0.08
  }

  const latest = computed<RealtimeFeature | null>(() => frames.value[frames.value.length - 1] ?? null)

  /** Seed the walk from the channel index so each tab has a stable character. */
  function reseed(): void {
    const index = Math.max(0, Math.floor(options.channelIndex()))
    state = {
      channelSeed: index,
      spl: 58 + index * 1.6,
      mainFrequency: 42 + index * 2.4,
      smoothness: 0.7 + (index % 3) * 0.03,
      bandEnergyRatio: 0.14 + (index % 4) * 0.02,
      oddEvenHarmonicRatio: 1.2 + (index % 5) * 0.12,
      spectralComplexity: 0.3 + (index % 3) * 0.05,
      fingerprintVariation: 0.05 + (index % 4) * 0.02
    }
  }

  /**
   * Synthesise one spectrum: a resonant peak that follows the simulated main
   * frequency, a low-frequency shelf and a noise floor.
   */
  function synthesizeSpectrum(mainFrequency: number, spl: number): number[] {
    const bins = SIMULATED_SPECTRUM_BINS
    const binWidth = SIMULATED_SPECTRUM_MAX_HZ / bins
    const peakBin = Math.min(bins - 1, Math.max(0, Math.round(mainFrequency / binWidth)))
    const values: number[] = []
    for (let bin = 0; bin < bins; bin += 1) {
      const distance = Math.abs(bin - peakBin)
      const peak = Math.exp(-(distance * distance) / 6)
      const shelf = bin < 6 ? 0.35 * (1 - bin / 6) : 0
      const floor = 0.04 + Math.random() * 0.05
      const amplitude = (spl - 30) / 70
      values.push(Math.min(1, Math.max(0, (peak * 0.85 * amplitude + shelf + floor) * 1)))
    }
    return values
  }

  function tick(): void {
    tickCount += 1
    // Slow sinusoid (~50 s period) overlaid on a bounded random walk: a machine
    // warming up and cooling down rather than a jitter generator.
    const slow = Math.sin((tickCount / 50) * Math.PI * 2)

    state.spl = drift(state.spl + slow * 0.35, 1.1, 35, 105)
    state.mainFrequency = drift(state.mainFrequency + slow * 0.2, 1.6, 20, 240)
    state.smoothness = drift(state.smoothness, 0.02, 0.35, 0.99)
    state.bandEnergyRatio = drift(state.bandEnergyRatio, 0.02, 0.02, 0.75)
    state.oddEvenHarmonicRatio = drift(state.oddEvenHarmonicRatio, 0.06, 0.4, 3.2)
    state.spectralComplexity = drift(state.spectralComplexity, 0.03, 0.05, 0.9)
    state.fingerprintVariation = drift(state.fingerprintVariation, 0.02, 0, 0.5)

    const frame: RealtimeFeature = {
      deviceId: options.deviceId(),
      channelId: Math.max(0, Math.floor(options.channelIndex())),
      timestamp: Date.now(),
      spl: Number(state.spl.toFixed(2)),
      mainFrequency: Number(state.mainFrequency.toFixed(2)),
      smoothness: Number(state.smoothness.toFixed(3)),
      bandEnergyRatio: Number(state.bandEnergyRatio.toFixed(3)),
      oddEvenHarmonicRatio: Number(state.oddEvenHarmonicRatio.toFixed(3)),
      spectralComplexity: Number(state.spectralComplexity.toFixed(3)),
      fingerprintVariation: Number(state.fingerprintVariation.toFixed(3))
    }

    const nextFrames = [...frames.value, frame]
    frames.value = nextFrames.length > historySize ? nextFrames.slice(-historySize) : nextFrames

    const nextSpectrum = synthesizeSpectrum(frame.mainFrequency, frame.spl)
    spectrum.value = nextSpectrum
    const nextSpectrogram = [...spectrogram.value, nextSpectrum]
    spectrogram.value =
      nextSpectrogram.length > spectrogramDepth
        ? nextSpectrogram.slice(-spectrogramDepth)
        : nextSpectrogram
  }

  function start(): void {
    if (running.value) return
    running.value = true
    reseed()
    tick()
    timer = setInterval(tick, intervalMs)
  }

  function stop(): void {
    running.value = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function reset(): void {
    frames.value = []
    spectrum.value = []
    spectrogram.value = []
    tickCount = 0
    reseed()
  }

  if (options.autostart !== false) {
    onMounted(start)
    onBeforeUnmount(stop)
  }

  return {
    frames,
    latest,
    spectrum,
    spectrogram,
    running,
    simulated: true,
    start,
    stop,
    reset
  }
}
