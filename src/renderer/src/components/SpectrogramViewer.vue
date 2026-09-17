<script setup lang="ts">
/**
 * Spectrogram viewer — a sequence of JPEG images, NOT a chart.
 *
 * THE KEY MEASURED FACT (PROTOCOL-FINDINGS 4.3): `/time_freq_domain` does not
 * send a numeric matrix. It sends a rendered **JPEG image** (~38-40 KB, verified
 * JFIF magic) and the device's own web UI assigns it straight to an `<img>`.
 *
 * CONSEQUENCES, both deliberate:
 *   - no ECharts and no heat map: driving a chart library would draw a DIFFERENT
 *     picture from the one the firmware intends;
 *   - no local STFT: computing one would duplicate work the device already did,
 *     and would disagree with the device's own display.
 *
 * The device's UI keeps the last 5 frames, so this component does the same and
 * offers them as a thumbnail strip while showing the newest one large.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import type { SpectrogramFrameEvent } from '@shared/domain/monitoring'
import { EMPTY_VALUE, formatBytes } from '@renderer/lib/format'

const props = withDefaults(
  defineProps<{
    /** Frames in chronological order (oldest first); the last one is the newest. */
    frames: SpectrogramFrameEvent[]
    /** Height of the large image area. */
    height?: string
  }>(),
  { height: '240px' }
)

const { t } = useI18n()

/**
 * Timestamp of a pinned frame, or null to follow the newest.
 *
 * Pinning exists because a live image that is replaced ~1.5 times per second is
 * unreadable when the operator wants to inspect one moment. When the pinned
 * frame scrolls out of the 5-frame buffer the computed falls back to the newest
 * automatically, so this can never point at a frame that no longer exists.
 */
const pinnedTimestamp = ref<number | null>(null)

const newest = computed<SpectrogramFrameEvent | null>(
  () => props.frames[props.frames.length - 1] ?? null
)

const displayed = computed<SpectrogramFrameEvent | null>(() => {
  const pinned = pinnedTimestamp.value
  if (pinned === null) return newest.value
  return props.frames.find((frame) => frame.timestamp === pinned) ?? newest.value
})

const isPinned = computed(
  () => displayed.value !== null && displayed.value.timestamp !== newest.value?.timestamp
)

/** Newest first, so the freshest thumbnail sits under the operator's cursor. */
const thumbnails = computed(() => [...props.frames].reverse())

function dataUrl(frame: SpectrogramFrameEvent): string {
  // The payload is already the exact bytes the device rendered; `<img>` needs no
  // decoding step and creates no object URL to revoke.
  return `data:image/jpeg;base64,${frame.jpegBase64}`
}

function frameTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('zh-CN')
}

function pin(frame: SpectrogramFrameEvent): void {
  pinnedTimestamp.value = frame.timestamp
}

function followNewest(): void {
  pinnedTimestamp.value = null
}

// A frame that leaves the 5-frame buffer must not stay pinned by a stale
// timestamp: the computed above would fall back to the newest image, and the
// pinned flag would wrongly claim the operator is looking at history.
watch(newest, () => {
  const pinned = pinnedTimestamp.value
  if (pinned !== null && !props.frames.some((frame) => frame.timestamp === pinned)) {
    pinnedTimestamp.value = null
  }
})
</script>

<template>
  <div class="spectrogram">
    <div v-if="displayed" class="spectrogram__stage" :style="{ height }">
      <img
        class="spectrogram__image"
        :src="dataUrl(displayed)"
        :alt="t('widgetsUi.spectrogramAlt', { time: frameTime(displayed.timestamp) })"
      />
      <button
        v-if="isPinned"
        type="button"
        class="btn btn--sm spectrogram__resume"
        @click="followNewest"
      >
        {{ t('widgetsUi.backToLatest') }}
      </button>
    </div>

    <div v-else class="spectrogram__empty" :style="{ height }">
      <span class="spectrogram__empty-title">{{ t('widgetsUi.spectrogramWaiting') }}</span>
    </div>

    <div v-if="frames.length > 0" class="spectrogram__strip">
      <button
        v-for="frame in thumbnails"
        :key="frame.timestamp"
        type="button"
        class="thumb"
        :class="{ 'thumb--active': displayed?.timestamp === frame.timestamp }"
        :title="`${frameTime(frame.timestamp)} · ${formatBytes(frame.byteLength)}`"
        @click="pin(frame)"
      >
        <img class="thumb__image" :src="dataUrl(frame)" alt="" />
      </button>
      <span class="spectrogram__meta">
        {{ t('widgetsUi.spectrogramFrames', { count: frames.length }) }}<br />
        <template v-if="displayed">
          {{ frameTime(displayed.timestamp) }} · {{ formatBytes(displayed.byteLength) }}
        </template>
        <template v-else>{{ EMPTY_VALUE }}</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.spectrogram {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.spectrogram__stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  overflow: hidden;
}

.spectrogram__image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  image-rendering: auto;
}

.spectrogram__resume {
  position: absolute;
  right: 8px;
  bottom: 8px;
}

.spectrogram__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 0 20px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
  text-align: center;
}

.spectrogram__empty-title {
  font-size: 12.5px;
  color: var(--color-text);
}

.spectrogram__empty-hint,
.spectrogram__caption {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.spectrogram__strip {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.thumb {
  flex: none;
  width: 56px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
  overflow: hidden;
  cursor: pointer;
}

.thumb:hover {
  border-color: var(--color-border-strong);
}

.thumb--active {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px var(--color-accent-soft);
}

.thumb__image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.spectrogram__meta {
  font-size: 11px;
  color: var(--color-text-secondary);
  line-height: 1.4;
}
</style>
