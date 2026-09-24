import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Fa371FftPreview, Fa371PcmPreview, Fa371StreamKind } from '@shared/domain/fa371-stream'
import { CAMERA_CELL_SPECTROGRAM_COLUMNS } from '@shared/domain/camera-cell-view'
import { callApi, unwrap } from '@renderer/lib/result'
import { pushCapped } from '@renderer/lib/cameraCellChart'

interface DeviceCharts {
  kinds: Fa371StreamKind[]
  refs: Partial<Record<Fa371StreamKind, number>>
  pcm: Fa371PcmPreview[]
  fft: Fa371FftPreview[]
  lastAt?: number
  error?: string
}

const PCM_HISTORY_SECONDS = 1.1
const PCM_HISTORY_MAX_FRAMES = 64
const PCM_SAMPLE_RATE_FALLBACK = 200_000

function pcmSampleCount(frame: Fa371PcmPreview): number {
  const samples = Number(frame.samples)
  if (Number.isFinite(samples) && samples > 0) return Math.floor(samples)
  const raw = frame.rawSamples as unknown
  if (ArrayBuffer.isView(raw)) return Number((raw as ArrayBufferView & { length?: number }).length ?? 0)
  if (Array.isArray(raw)) return raw.length
  return Array.isArray(frame.waveform) ? frame.waveform.length : 0
}

function pushPcmWindow(history: Fa371PcmPreview[], frame: Fa371PcmPreview): Fa371PcmPreview[] {
  const next = [...history, frame]
  const sampleRate = Number(frame.sampleRate) > 0 ? Number(frame.sampleRate) : PCM_SAMPLE_RATE_FALLBACK
  const targetSamples = Math.ceil(sampleRate * PCM_HISTORY_SECONDS)
  let accumulated = 0
  let keepFrom = Math.max(0, next.length - 1)

  for (let index = next.length - 1; index >= 0; index -= 1) {
    accumulated += pcmSampleCount(next[index]!)
    keepFrom = index
    if (accumulated >= targetSamples) break
    if (next.length - index >= PCM_HISTORY_MAX_FRAMES) break
  }

  return next.slice(Math.max(keepFrom, next.length - PCM_HISTORY_MAX_FRAMES))
}

export const useCameraCellChartsStore = defineStore('cameraCellCharts', () => {
  const devices = ref<Record<string, DeviceCharts>>({})
  const now = ref(0)
  let unsubscribers: Array<() => void> = []

  function subscribe(): void {
    if (unsubscribers.length > 0) return
    if (typeof window === 'undefined' || !window.events) return
    unsubscribers = [window.events.onFa371Pcm(handlePcm), window.events.onFa371Fft(handleFft)]
  }

  function detachListeners(): void {
    for (const releaseOne of unsubscribers) {
      try {
        releaseOne()
      } catch {
        // Continue releasing the remaining listeners.
      }
    }
    unsubscribers = []
  }

  function belongs(deviceId: string): DeviceCharts | undefined {
    return devices.value[deviceId]
  }

  function handlePcm(preview: Fa371PcmPreview): void {
    const entry = belongs(preview.deviceId)
    if (!entry) return
    entry.pcm = pushPcmWindow(entry.pcm, preview)
    entry.lastAt = preview.timestamp
    entry.error = undefined
    devices.value = { ...devices.value, [preview.deviceId]: entry }
    now.value = Date.now()
  }

  function handleFft(preview: Fa371FftPreview): void {
    const entry = belongs(preview.deviceId)
    if (!entry) return
    entry.fft = pushCapped(entry.fft, preview, CAMERA_CELL_SPECTROGRAM_COLUMNS)
    entry.lastAt = preview.timestamp
    entry.error = undefined
    devices.value = { ...devices.value, [preview.deviceId]: entry }
    now.value = Date.now()
  }

  async function require(deviceId: string, kind: Fa371StreamKind): Promise<boolean> {
    if (!deviceId) return false
    subscribe()

    const current = devices.value[deviceId]
    const currentRef = current?.refs[kind] ?? 0
    if (currentRef > 0 && current?.kinds.includes(kind)) {
      current.refs = { ...current.refs, [kind]: currentRef + 1 }
      devices.value = { ...devices.value, [deviceId]: current }
      return true
    }

    const entry: DeviceCharts = current ?? {
      kinds: [],
      refs: {},
      pcm: [],
      fft: []
    }
    const kinds = entry.kinds.includes(kind) ? entry.kinds : [...entry.kinds, kind]
    entry.kinds = kinds
    entry.refs = { ...entry.refs, [kind]: currentRef + 1 }
    entry.error = undefined
    devices.value = { ...devices.value, [deviceId]: entry }

    const result = await callApi(() => window.api.fa371Stream.start({ deviceId, kinds }))
    if (!result.success) {
      const failed = devices.value[deviceId]
      if (failed) {
        failed.error = result.error?.message ?? 'start-failed'
        const failedRefs = { ...failed.refs }
        delete failedRefs[kind]
        failed.refs = failedRefs
        failed.kinds = failed.kinds.filter((item) => item !== kind)
        devices.value = { ...devices.value, [deviceId]: failed }
      }
      return false
    }

    const state = unwrap(result)
    const started = devices.value[deviceId]
    if (started) {
      started.error = state?.streams?.some((item) => item.lastError) ? 'stream-error' : undefined
      devices.value = { ...devices.value, [deviceId]: started }
    }
    return true
  }

  function release(deviceId: string, kind: Fa371StreamKind): void {
    const current = devices.value[deviceId]
    if (!current) return

    const currentRef = current.refs[kind] ?? 0
    if (currentRef > 1) {
      current.refs = { ...current.refs, [kind]: currentRef - 1 }
      devices.value = { ...devices.value, [deviceId]: current }
      return
    }

    const refs = { ...current.refs }
    delete refs[kind]
    const kinds = current.kinds.filter((item) => item !== kind)

    if (kinds.length === 0) {
      const next = { ...devices.value }
      delete next[deviceId]
      devices.value = next
      void callApi(() => window.api.fa371Stream.stop(deviceId))
      return
    }

    devices.value = {
      ...devices.value,
      [deviceId]: { ...current, refs, kinds }
    }
    void callApi(() => window.api.fa371Stream.start({ deviceId, kinds }))
  }

  function dispose(): void {
    const ids = Object.keys(devices.value)
    devices.value = {}
    detachListeners()
    for (const deviceId of ids) void callApi(() => window.api.fa371Stream.stop(deviceId))
  }

  const deviceIds = computed(() => Object.keys(devices.value))

  return { devices, now, deviceIds, require, release, dispose }
})
