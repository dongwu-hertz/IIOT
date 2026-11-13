<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent } from '@shared/domain/models'
import { callApi, unwrap } from '@renderer/lib/result'

const props = defineProps<{ alarm?: AlarmEvent }>()
const { t } = useI18n()
const audioUrl = ref('')
const peaks = ref<number[]>([])
const loading = ref(false)
const error = ref('')

function revoke(): void {
  if (audioUrl.value !== '') {
    URL.revokeObjectURL(audioUrl.value)
    audioUrl.value = ''
  }
}

async function load(): Promise<void> {
  revoke()
  peaks.value = []
  error.value = ''
  const recordingId = props.alarm?.localRecordingId
  if (!recordingId) return
  loading.value = true
  try {
    const result = await callApi(() => window.api.playback.load(recordingId))
    const payload = result.success ? unwrap(result) : undefined
    if (!payload || payload.audioBase64 === '') {
      error.value = t('sonarUi.noAudio')
      return
    }
    const bytes = Uint8Array.from(atob(payload.audioBase64), (char) => char.charCodeAt(0))
    audioUrl.value = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }))
    const context = new AudioContext()
    try {
      const buffer = await context.decodeAudioData(bytes.buffer.slice(0))
      const data = buffer.getChannelData(0)
      const buckets = 120
      const size = Math.max(1, Math.floor(data.length / buckets))
      const next: number[] = []
      for (let bucket = 0; bucket < buckets; bucket += 1) {
        let peak = 0
        const start = bucket * size
        const end = Math.min(data.length, start + size)
        for (let index = start; index < end; index += 1) {
          peak = Math.max(peak, Math.abs(data[index] ?? 0))
        }
        next.push(peak)
      }
      const max = Math.max(...next, 0.001)
      peaks.value = next.map((value) => Math.max(0.04, value / max))
    } finally {
      await context.close()
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

watch(() => props.alarm?.localRecordingId, () => void load(), { immediate: true })
onBeforeUnmount(revoke)
</script>

<template>
  <div class="sonar-waveform" data-sonar-waveform>
    <span class="sonar-preview-label">{{ t('sonarUi.waveformPreview') }}</span>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="muted">{{ error }}</p>
    <div v-else-if="peaks.length > 0" class="sonar-waveform__bars" aria-hidden="true">
      <span v-for="(peak, index) in peaks" :key="index" :style="{ height: `${Math.round(peak * 100)}%` }"></span>
    </div>
    <p v-else class="muted">{{ t('sonarUi.noWaveform') }}</p>
    <audio v-if="audioUrl" class="sonar-waveform__audio" :src="audioUrl" controls></audio>
  </div>
</template>

<style scoped>
.sonar-waveform {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sonar-preview-label {
  color: var(--color-text-secondary);
  font-size: 11px;
}

.sonar-waveform__bars {
  height: 48px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 3px 0;
}

.sonar-waveform__bars span {
  flex: 1;
  min-width: 1px;
  max-width: 4px;
  border-radius: 1px;
  background: var(--color-accent);
}

.sonar-waveform__audio {
  width: 100%;
  height: 28px;
}
</style>