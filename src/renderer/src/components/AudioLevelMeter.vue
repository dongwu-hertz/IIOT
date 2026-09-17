<script setup lang="ts">
/**
 * Audio level meter for the decimated realtime preview (spec 9.3).
 *
 * WHAT THE NUMBERS ARE
 * The renderer never receives raw PCM: the main process decimates each 100 ms
 * device frame into `peak`, `rms` and a short waveform preview. Both levels are
 * linear amplitudes in 0..1 (1.0 = full scale), so the readout shows the linear
 * value, its percentage, and a dBFS conversion for anyone used to reading a
 * console meter.
 *
 * PEAK-HOLD IS NOT IMPLEMENTED HERE, ON PURPOSE
 * The peak value already carries the decay applied by the main process. Adding a
 * second hold/decay in the renderer would make the marker disagree with the
 * pushed measurement — the exact kind of drift between "what was measured" and
 * "what is displayed" that this project forbids.
 *
 * "—" MEANS NO DATA
 * A missing or NaN level renders as "—", never as 0: on a monitoring console a
 * fake zero reads as "measured, and it is silent", which is a dangerous lie.
 */
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { EMPTY_VALUE, formatNumber, isMissingNumber } from '@renderer/lib/format'

const props = withDefaults(
  defineProps<{
    /** Peak amplitude of the latest frame, 0..1. */
    peak?: number
    /** RMS amplitude of the latest frame, 0..1. */
    rms?: number
    /** True while a manual recording is running. */
    recording?: boolean
    /** Milliseconds captured so far, pushed by the main process. */
    elapsedMs?: number
    /** True when the audio stream is not running; mutes the meter. */
    disabled?: boolean
    /** Verified device fact, shown as a label. */
    sampleRate?: number
    /** Verified frame duration (100 ms on measured hardware), shown as a label. */
    frameMs?: number
  }>(),
  {
    peak: undefined,
    rms: undefined,
    recording: false,
    elapsedMs: undefined,
    disabled: false,
    sampleRate: undefined,
    frameMs: undefined
  }
)

const { t } = useI18n()

function clamp01(value: number | undefined): number {
  if (isMissingNumber(value)) return 0
  return Math.min(1, Math.max(0, value as number))
}

/** dBFS, or "—" for silence/absence (log of 0 is -Infinity, not a measurement). */
function toDb(value: number | undefined): string {
  if (isMissingNumber(value)) return EMPTY_VALUE
  const linear = value as number
  if (linear <= 0) return EMPTY_VALUE
  return `${(20 * Math.log10(linear)).toFixed(1)} dBFS`
}

const peakText = computed(() => formatNumber(props.peak, 3))
const peakPercent = computed(() =>
  isMissingNumber(props.peak) ? EMPTY_VALUE : `${(clamp01(props.peak) * 100).toFixed(1)}%`
)
const peakDb = computed(() => toDb(props.peak))

const rmsText = computed(() => formatNumber(props.rms, 3))
const rmsPercent = computed(() =>
  isMissingNumber(props.rms) ? EMPTY_VALUE : `${(clamp01(props.rms) * 100).toFixed(1)}%`
)
const rmsDb = computed(() => toDb(props.rms))

/** Bar geometry. A disabled stream shows an empty bar, not a frozen level. */
const rmsWidth = computed(() => `${props.disabled ? 0 : clamp01(props.rms) * 100}%`)
const peakLeft = computed(() => `${props.disabled ? 0 : clamp01(props.peak) * 100}%`)

const rateLabel = computed(() =>
  isMissingNumber(props.sampleRate) ? EMPTY_VALUE : `${(props.sampleRate as number) / 1000} kHz`
)
const frameLabel = computed(() =>
  isMissingNumber(props.frameMs)
      ? EMPTY_VALUE
      : t('widgetsUi.millisecondsPerFrame', { value: formatNumber(props.frameMs, 0) })
)

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

/**
 * Wall clock at the moment the pushed `elapsedMs` arrived.
 *
 * `RecordingStateEvent.elapsedMs` is pushed on transitions, not on a 1 Hz tick,
 * so the label would jump in multi-second steps. Re-anchoring each push and
 * ticking locally in between gives a smooth timer that is still derived from the
 * device's own count — never from a guessed start time.
 */
const anchor = ref<{ ms: number | undefined; at: number }>({ ms: undefined, at: Date.now() })
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.elapsedMs,
  (ms) => {
    anchor.value = { ms, at: Date.now() }
    now.value = Date.now()
  },
  { immediate: true }
)

function startTimer(): void {
  if (timer !== null) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 250)
}

function stopTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

watch(
  () => props.recording,
  (active) => {
    if (active) {
      now.value = Date.now()
      startTimer()
    } else {
      stopTimer()
    }
  },
  { immediate: true }
)

// The interval MUST be cleared on unmount: a stray timer keeps the component's
// closure alive and re-renders a detached tree.
onBeforeUnmount(stopTimer)

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** `mm:ss` from the device's counter, or "—" before the first push. */
const elapsedLabel = computed(() => {
  const base = anchor.value.ms
  if (isMissingNumber(base)) return EMPTY_VALUE
  const value = base as number
  if (!props.recording) return clock(value)
  return clock(value + Math.max(0, now.value - anchor.value.at))
})
</script>

<template>
  <div class="meter" :class="{ 'meter--disabled': disabled }">
    <div class="meter__head">
      <span class="meter__title">{{ t('widgetsUi.audioLevel') }}</span>
      <span class="meter__facts">
        {{ t('widgetsUi.sampleRateAndFrame', { rate: rateLabel, frame: frameLabel }) }}
      </span>
      <span class="spacer"></span>
      <span v-if="recording" class="meter__recording" role="status">
        <span class="meter__rec-dot" aria-hidden="true"></span>
        {{ t('widgetsUi.recording', { elapsed: elapsedLabel }) }}
      </span>
      <span v-else-if="elapsedLabel !== EMPTY_VALUE" class="muted meter__last">
        {{ t('widgetsUi.lastRecording', { elapsed: elapsedLabel }) }}
      </span>
    </div>

    <!-- Visual only: the numeric readouts below are the accessible text. -->
    <div class="meter__track" aria-hidden="true">
      <div class="meter__fill" :style="{ width: rmsWidth }"></div>
      <div class="meter__peak" :style="{ left: peakLeft }"></div>
    </div>

    <div class="meter__readouts">
      <span class="meter__readout">
        <span class="meter__readout-label">{{ t('widgetsUi.peak') }}</span>
        <span class="meter__readout-value">{{ peakText }}</span>
        <span class="meter__readout-sub">{{ peakPercent }} · {{ peakDb }}</span>
      </span>
      <span class="meter__readout">
        <span class="meter__readout-label">{{ t('widgetsUi.rms') }}</span>
        <span class="meter__readout-value">{{ rmsText }}</span>
        <span class="meter__readout-sub">{{ rmsPercent }} · {{ rmsDb }}</span>
      </span>
      <span v-if="disabled" class="meter__hint">{{ t('widgetsUi.audioUnavailable') }}</span>
    </div>
  </div>
</template>

<style scoped>
.meter {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}

.meter__head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}

.meter__title {
  font-weight: 600;
}

.meter__facts {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.meter--disabled {
  opacity: 0.6;
}

.meter__recording {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-danger);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.meter__rec-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
  animation: meter-pulse 1.4s ease-in-out infinite;
}

@keyframes meter-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.meter__last {
  font-size: 11.5px;
}

.meter__track {
  position: relative;
  height: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-muted);
  overflow: hidden;
}

.meter__fill {
  height: 100%;
  background: var(--color-accent);
  transition: width 0.1s linear;
}

.meter__peak {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--color-text);
  transition: left 0.1s linear;
}

.meter__readouts {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.meter__readout {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

.meter__readout-label {
  color: var(--color-text-secondary);
}

.meter__readout-value {
  color: var(--color-text);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.meter__readout-sub {
  font-variant-numeric: tabular-nums;
}

.meter__hint {
  color: var(--color-text-secondary);
}
</style>
