<script setup lang="ts">
/**
 * Recording player panel — shared by the alarm detail drawer and the recordings
 * table so both use ONE playback implementation.
 *
 * HOW THE BYTES GET HERE (and why it is base64)
 * `window.api.playback.load(recordingId)` returns the whole clip as base64 via
 * IPC. A 10 s recording is ~3.8 MB (~5 MB as base64), which is why loading is
 * user-initiated, why the spinner exists, and why the object URL below is
 * revoked aggressively.
 *
 * OBJECT-URL LIFECYCLE — THE LEAK THIS COMPONENT EXISTS TO PREVENT
 * `URL.createObjectURL()` pins the Blob in memory until `revokeObjectURL()` is
 * called. Playing five clips without revoking keeps ~25 MB alive for the life of
 * the window. So the URL is revoked (a) immediately before creating the next
 * one, (b) whenever the requested recording id changes, and (c) on unmount.
 *
 * NOTE ON THE `<audio>` ELEMENT: the element is bound to the object URL, so the
 * URL is revoked only AFTER the element is re-pointed or destroyed — revoking
 * while it is still the active source would cut playback off mid-clip.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlaybackData } from '@shared/ipc/contract'
import type { EChartsCoreOption } from 'echarts/core'
import { EMPTY_VALUE, formatBytes, formatDuration, formatSampleRate } from '@renderer/lib/format'
import { anchorSeek } from '@renderer/lib/playbackTimeline'
import { formatHzTick, spectrumMaxHz, spectrumPoints, spectrumRangeLabel } from '@renderer/lib/spectrum'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import EChart from '@renderer/components/EChart.vue'

const props = withDefaults(
  defineProps<{
    /** Local recording id. `null`/`''` renders the "nothing to play" state. */
    recordingId?: string | null
    /** Load and start playback as soon as the panel mounts. */
    autoLoad?: boolean
    /**
     * 绝对时间轴上的**锚点**（epoch ms），通常是告警时刻。
     *
     * 传了它就表示"这一段是为了看锚点附近而播的"：加载完成后会跳到
     * `锚点 - anchorLeadMs` 的位置。缺省 `null` = 从头播（录音页面的用法）。
     */
    anchorAtMs?: number | null
    /** 锚点之前要回退多少毫秒。缺省 0 = 正好跳到锚点。 */
    anchorLeadMs?: number
  }>(),
  { recordingId: null, autoLoad: false, anchorAtMs: null, anchorLeadMs: 0 }
)

const { t } = useI18n()

type Phase = 'idle' | 'loading' | 'ready' | 'error'

const phase = ref<Phase>('idle')
const error = ref('')
const data = ref<PlaybackData | null>(null)
const objectUrl = ref('')
const audioEl = ref<HTMLAudioElement | null>(null)
/** Set when the browser refused the programmatic play() after loading. */
const autoplayBlocked = ref(false)
/**
 * 「请求的回退量没拿到」时的实话。
 *
 * 为什么必须说出来：环形缓冲区的预录时长是可配置的（默认 10 秒），而告警详情要的是
 * 「告警前 30 秒」。当片段本身只有 10 秒告警前内容时，从片段开头播**并不等于**满足了
 * 请求——静默地从头播，会让操作员以为"告警前 30 秒就是这样"，而真相是那 20 秒根本
 * 没被录下来。所以这里报告**实际拿到**的回退量。
 */
const leadShort = ref('')

/**
 * 差额小于这个值就不提。500 毫秒是**显示取整**造成的：提示里说的是整秒，所以差
 * 0.4 秒时"请求 30 秒 / 实际 30 秒"两句话自相矛盾，反而像 bug。
 */
const ANCHOR_SHORTFALL_TOLERANCE_MS = 500

const loading = computed(() => phase.value === 'loading')

/**
 * Estimated transfer size from the base64 length.
 * Shown while loading so a slow download reads as "working", not as a hang.
 */
const estimatedBytes = computed(() => Math.round((data.value?.audioBase64.length ?? 0) * 0.75))

function revokeObjectUrl(): void {
  if (!objectUrl.value) return
  URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

/**
 * Base64 -> bytes.
 *
 * The explicit `Uint8Array<ArrayBuffer>` return type (rather than the wider
 * `ArrayBufferLike`) is what makes the value acceptable as a `BlobPart`: TS 5.7+
 * distinguishes a view over a shared buffer from one over a plain ArrayBuffer,
 * and only the latter can be handed to `Blob`.
 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * 把播放位置挪到「锚点 - anchorLeadMs」。
 *
 * 该跳到哪儿、以及**实际**拿到了多少回退，由 `anchorSeek()` 算（纯函数，有单元测试）。
 * 这里只负责两件与环境有关的事：
 *   1. **元数据没到时 `currentTime` 会被忽略**（有时直接抛）。所以先等 `loadedmetadata`，
 *      但不能无限等——下载失败时那个事件永远不会来，所以与一个短超时赛跑；
 *   2. 把差额**说出来**：请求 30 秒而片段只有 10 秒告警前内容时，如实报告实际拿到的秒数，
 *      而不是假装满足了请求（那是界面说假话）。
 */
async function applyAnchor(element: HTMLAudioElement): Promise<void> {
  const anchor = props.anchorAtMs
  const start = data.value?.startTimeMs
  if (anchor === null || anchor === undefined || start === undefined) return

  if (element.readyState < 1 /* HAVE_METADATA */) {
    await Promise.race([
      new Promise<void>((resolve) => {
        element.addEventListener('loadedmetadata', () => resolve(), { once: true })
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ])
  }

  const durationMs = Number.isFinite(element.duration)
    ? element.duration * 1000
    : (data.value?.durationMs ?? 0)
  const seek = anchorSeek({
    anchorAtMs: anchor,
    clipStartMs: start,
    requestedLeadMs: props.anchorLeadMs,
    durationMs
  })

  try {
    element.currentTime = seek.seekMs / 1000
  } catch {
    // 跳不动就留在原地（元素会从头播）。下面的提示说明请求没有被满足。
  }

  if (seek.shortfallMs > ANCHOR_SHORTFALL_TOLERANCE_MS) {
    leadShort.value = t('playerUi.leadShort', {
      requested: Math.round(Math.max(0, props.anchorLeadMs) / 1000),
      actual: Math.round(seek.achievedLeadMs / 1000)
    })
  }
}

/** Load (downloading from the device first if needed) and start playing. */
async function load(): Promise<void> {
  const id = props.recordingId
  if (!id) {
    error.value = t('playerUi.errMissingFile')
    phase.value = 'error'
    return
  }

  phase.value = 'loading'
  error.value = ''
  autoplayBlocked.value = false
  leadShort.value = ''

  const result = await callApi(() => window.api.playback.load(id))
  if (!result.success) {
    error.value = resultMessage(result)
    phase.value = 'error'
    return
  }

  const payload = unwrap(result)
  if (!payload) {
    error.value = t('playerUi.errNoData')
    phase.value = 'error'
    return
  }

  // Revoke the PREVIOUS clip before pointing the element at the new one: two
  // live object URLs would double the memory for as long as the panel is open.
  revokeObjectUrl()
  data.value = payload
  try {
    const blob = new Blob([base64ToBytes(payload.audioBase64)], { type: payload.mimeType })
    objectUrl.value = URL.createObjectURL(blob)
  } catch (cause) {
    // Leave no half-loaded state behind: without an object URL the <audio>
    // element would render with an empty source.
    data.value = null
    error.value = t('playerUi.errDecode', {
      detail: cause instanceof Error ? cause.message : String(cause)
    })
    phase.value = 'error'
    return
  }
  phase.value = 'ready'

  await nextTick()
  const element = audioEl.value
  if (!element) return
  // 先对位再播：反过来的话，音频会先从头出声再跳走（能听见一声"抢拍"）。
  await applyAnchor(element)
  try {
    await element.play()
  } catch {
    // Chromium's transient-activation window can expire during a multi-second
    // download; the native controls are right there, so surface a hint instead
    // of pretending playback started.
    autoplayBlocked.value = true
  }
}

function release(): void {
  audioEl.value?.pause()
  revokeObjectUrl()
  data.value = null
  phase.value = 'idle'
  error.value = ''
  autoplayBlocked.value = false
  leadShort.value = ''
}

// A new recording id means the loaded clip (and its object URL) is stale.
watch(
  () => props.recordingId,
  () => {
    release()
    if (props.autoLoad) void load()
  },
  { immediate: true }
)

/**
 * The unmount hook is not optional: without it the Blob stays pinned by the
 * object URL for the lifetime of the window.
 */
onBeforeUnmount(revokeObjectUrl)

// ---------------------------------------------------------------------------
// Waveform preview
// ---------------------------------------------------------------------------

/**
 * SVG `points` for the static waveform strip, in a 0..100 x 0..30 viewBox with
 * `preserveAspectRatio="none"` so it scales to the panel width.
 */
const waveformPoints = computed(() => {
  const values = data.value?.waveform ?? []
  if (values.length < 2) return ''
  const center = 15
  const amplitude = 13
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0))
      return `${x.toFixed(2)},${(center - clamped * amplitude).toFixed(2)}`
    })
    .join(' ')
})

const hasWaveform = computed(() => waveformPoints.value !== '')

// ---------------------------------------------------------------------------
// Spectrum preview
// ---------------------------------------------------------------------------

const spectrumOption = computed<EChartsCoreOption>(() => {
  const magnitudes = data.value?.spectrum ?? []
  const binHz = data.value?.spectrumBinHz ?? 0
  const maxHz = spectrumMaxHz(magnitudes, binHz)
  return {
    animation: false,
    grid: { left: 46, right: 12, top: 12, bottom: 24 },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? value.toFixed(4) : String(value)
    },
    xAxis: {
      type: 'value',
      min: 0,
      max: maxHz > 0 ? maxHz : undefined,
      name: 'Hz',
      nameTextStyle: { color: '#6B7280', fontSize: 10 },
      axisLine: { lineStyle: { color: '#E5E7EB' } },
      axisLabel: { color: '#6B7280', fontSize: 10, formatter: formatHzTick }
    },
    yAxis: {
      type: 'value',
      name: t('monitorUi.chartNormalizedEnergy'),
      nameTextStyle: { color: '#6B7280', fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: '#6B7280', fontSize: 10 },
      splitLine: { lineStyle: { color: '#F1F1F2' } }
    },
    series: [
      {
        name: t('monitorUi.chartBandEnergy'),
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        data: spectrumPoints(magnitudes, binHz),
        lineStyle: { width: 1.2, color: '#FF6A1A' },
        itemStyle: { color: '#FF6A1A' },
        areaStyle: { color: '#FF6A1A', opacity: 0.12 }
      }
    ]
  }
})

const hasSpectrum = computed(() => (data.value?.spectrum?.length ?? 0) > 0)

const spectrumRange = computed(() =>
  spectrumRangeLabel(spectrumMaxHz(data.value?.spectrum ?? [], data.value?.spectrumBinHz ?? 0))
)

defineExpose({ load, release })
</script>

<template>
  <div class="player">
    <!-- Phase: nothing to play. The parent supplies the call to action. -->
    <div v-if="!recordingId" class="player__empty">
      <p class="player__empty-title">{{ t('playerUi.missingTitle') }}</p>
      <p class="player__empty-hint">
        {{ t('playerUi.missingBody') }}
      </p>
      <div v-if="$slots.action" class="player__empty-action">
        <slot name="action" />
      </div>
    </div>

    <template v-else>
      <div class="player__controls">
        <button
          type="button"
          class="btn btn--primary btn--sm"
          :disabled="loading"
          @click="load"
        >
          <span v-if="loading" class="spinner" aria-hidden="true"></span>
          {{ loading ? t('playerUi.loading') : data ? t('playerUi.reload') : t('playerUi.play') }}
        </button>
        <button v-if="data" type="button" class="btn btn--sm" @click="release">{{ t('playerUi.release') }}</button>
        <span v-if="loading" class="muted player__loading-hint">
          {{
            t('playerUi.downloading', {
              size: estimatedBytes > 0 ? formatBytes(estimatedBytes) : t('playerUi.fewMegabytes')
            })
          }}
        </span>
        <span v-else-if="autoplayBlocked" class="muted player__loading-hint">
          {{ t('playerUi.autoplayBlocked') }}
        </span>
        <span v-if="!loading && leadShort" class="muted player__loading-hint">{{ leadShort }}</span>
      </div>

      <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>

      <template v-if="data">
        <audio ref="audioEl" class="player__audio" controls :src="objectUrl"></audio>

        <dl class="kv player__facts">
          <div class="kv__item">
            <dt class="kv__label">{{ t('monitorUi.sampleRate') }}</dt>
            <dd class="kv__value">{{ formatSampleRate(data.sampleRate) }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('playerUi.channelCount') }}</dt>
            <dd class="kv__value">{{ t('playerUi.channelCountValue', { count: data.channels }) }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('recordingsUi.columnDuration') }}</dt>
            <dd class="kv__value">{{ formatDuration(data.durationMs) }}</dd>
          </div>
          <div class="kv__item">
            <dt class="kv__label">{{ t('playerUi.encoding') }}</dt>
            <dd class="kv__value">{{ data.mimeType || EMPTY_VALUE }}</dd>
          </div>
        </dl>

        <section class="player__section">
          <h4 class="player__section-title">{{ t('playerUi.waveformTitle') }}</h4>
          <svg
            v-if="hasWaveform"
            class="player__waveform"
            viewBox="0 0 100 30"
            preserveAspectRatio="none"
            role="img"
            :aria-label="t('playerUi.waveformAria')"
          >
            <line x1="0" y1="15" x2="100" y2="15" stroke="#E5E7EB" stroke-width="1" vector-effect="non-scaling-stroke" />
            <polyline
              :points="waveformPoints"
              fill="none"
              stroke="#FF6A1A"
              stroke-width="1.2"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <p v-else class="muted player__hint">{{ t('playerUi.waveformMissing') }}</p>
        </section>

        <section class="player__section">
          <h4 class="player__section-title">{{ t('playerUi.spectrumTitle') }}</h4>
          <template v-if="hasSpectrum">
            <span class="muted player__hint">{{ spectrumRange }}</span>
            <EChart :option="spectrumOption" height="160px" />
          </template>
          <p v-else class="muted player__hint">{{ t('playerUi.spectrumMissing') }}</p>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.player__empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 14px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.player__empty-title {
  font-size: 12.5px;
  font-weight: 600;
}

.player__empty-hint {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.player__empty-action {
  margin-top: 4px;
}

.player__controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.player__loading-hint {
  font-size: 11.5px;
}

.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: player-spin 0.8s linear infinite;
}

@keyframes player-spin {
  to {
    transform: rotate(360deg);
  }
}

.player__audio {
  width: 100%;
  height: 34px;
}

.player__facts {
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
}

.player__section {
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.player__section-title {
  font-size: 12.5px;
  font-weight: 600;
}

.player__waveform {
  width: 100%;
  height: 54px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.player__hint {
  font-size: 11.5px;
}
</style>
