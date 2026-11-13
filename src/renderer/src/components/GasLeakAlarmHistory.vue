<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Channel } from '@shared/domain/models'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'

const props = defineProps<{ deviceId: string; channels: readonly Channel[] }>()
const { t } = useI18n()
const alarms = ref<AlarmEvent[]>([])
const total = ref(0)
const loading = ref(false)
const syncing = ref(false)
const notice = ref('')
const error = ref('')
const selectedRecordingId = ref('')

function wellName(channelId: number): string {
  return props.channels.find((channel) => channel.channelIndex === channelId)?.channelName?.trim() || '—'
}

async function load(): Promise<void> {
  if (props.deviceId === '') {
    alarms.value = []
    total.value = 0
    return
  }
  loading.value = true
  error.value = ''
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 100 }))
  loading.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    alarms.value = []
    total.value = 0
    return
  }
  const page = unwrap(result)
  alarms.value = page?.items ?? []
  total.value = page?.total ?? alarms.value.length
}

async function syncAudio(): Promise<void> {
  if (props.deviceId === '' || syncing.value) return
  syncing.value = true
  notice.value = ''
  error.value = ''
  const result = await callApi(() => window.api.recordings.syncDevice(props.deviceId))
  syncing.value = false
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  notice.value = t('gasLeakUi.audioSynced', { count: unwrap(result) ?? 0 })
  await load()
}

function play(alarm: AlarmEvent): void {
  if (!alarm.localRecordingId) return
  selectedRecordingId.value = selectedRecordingId.value === alarm.localRecordingId ? '' : alarm.localRecordingId
}

onMounted(() => { void load() })
watch(() => props.deviceId, () => {
  selectedRecordingId.value = ''
  notice.value = ''
  error.value = ''
  void load()
})
</script>

<template>
  <section class="card gas-leak-history" data-gas-leak-history>
    <div class="section-header">
      <h3 class="section-title">{{ t('gasLeakUi.alarmHistory') }}</h3>
      <span class="muted">{{ total }}</span>
      <div class="spacer"></div>
      <button type="button" class="btn btn--sm" :disabled="syncing" data-gas-leak-sync-audio @click="syncAudio">
        {{ syncing ? t('gasLeakUi.syncing') : t('gasLeakUi.syncAudio') }}
      </button>
    </div>

    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-if="loading" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="alarms.length === 0" class="muted">{{ t('gasLeakUi.none') }}</p>
    <ul v-else class="gas-leak-history__list">
      <li v-for="alarm in alarms" :key="alarm.id" data-gas-leak-history-row>
        <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
        <span class="badge">CH{{ alarm.channelId + 1 }}</span>
        <span>{{ wellName(alarm.channelId) }}</span>
        <span class="muted">{{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}</span>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!alarm.localRecordingId"
          :title="alarm.localRecordingId ? t('gasLeakUi.playAudio') : t('gasLeakUi.noAudio')"
          @click="play(alarm)"
        >
          {{ selectedRecordingId === alarm.localRecordingId ? t('gasLeakUi.stopAudio') : t('gasLeakUi.playAudio') }}
        </button>
      </li>
    </ul>

    <RecordingPlayer
      v-if="selectedRecordingId"
      :recording-id="selectedRecordingId"
      auto-load
    />
  </section>
</template>

<style scoped>
.gas-leak-history {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.gas-leak-history__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  font-size: 12px;
}

.gas-leak-history__list li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
}

.gas-leak-history__list li > span:nth-child(3) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>