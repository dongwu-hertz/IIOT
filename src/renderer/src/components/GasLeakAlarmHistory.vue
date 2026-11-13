<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Channel } from '@shared/domain/models'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import RecordingPlayer from '@renderer/components/RecordingPlayer.vue'
import MonitorRecordingTimeline from '@renderer/components/MonitorRecordingTimeline.vue'

const props = defineProps<{ deviceId: string; channels: readonly Channel[] }>()
const { t } = useI18n()
const alarms = ref<AlarmEvent[]>([])
const total = ref(0)
const loading = ref(false)
const syncing = ref(false)
const busyId = ref('')
const notice = ref('')
const error = ref('')
const selectedRecordingId = ref('')
const MARK_NOTE = 'MARKED'
let autoTimer: number | undefined

function wellName(channelId: number): string {
  return props.channels.find((channel) => channel.channelIndex === channelId)?.channelName?.trim() || '—'
}

function isMarked(alarm: AlarmEvent): boolean {
  return alarm.note === MARK_NOTE
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

async function syncAudio(manual = true): Promise<void> {
  if (props.deviceId === '' || syncing.value) return
  syncing.value = true
  if (manual) {
    notice.value = ''
    error.value = ''
  }
  const result = await callApi(() => window.api.recordings.syncDevice(props.deviceId))
  syncing.value = false
  if (!result.success) {
    if (manual) error.value = resultMessage(result)
    return
  }
  if (manual) notice.value = t('gasLeakUi.audioSynced', { count: unwrap(result) ?? 0 })
  await load()
}

function play(alarm: AlarmEvent): void {
  if (!alarm.localRecordingId) return
  selectedRecordingId.value = selectedRecordingId.value === alarm.localRecordingId ? '' : alarm.localRecordingId
}

async function download(alarm: AlarmEvent): Promise<void> {
  if (!alarm.localRecordingId || busyId.value !== '') return
  busyId.value = alarm.id
  try {
    const result = await callApi(() => window.api.recordings.export(alarm.localRecordingId as string))
    if (!result.success) error.value = resultMessage(result)
    else notice.value = t('gasLeakUi.audioSaved')
  } finally {
    busyId.value = ''
  }
}

async function remove(alarm: AlarmEvent): Promise<void> {
  if (busyId.value !== '') return
  busyId.value = alarm.id
  try {
    const result = await callApi(() => window.api.alarms.remove([alarm.id]))
    if (!result.success) error.value = resultMessage(result)
    else {
      notice.value = t('gasLeakUi.deleted')
      await load()
    }
  } finally {
    busyId.value = ''
  }
}

async function handle(alarm: AlarmEvent): Promise<void> {
  if (busyId.value !== '') return
  busyId.value = alarm.id
  try {
    const result = await callApi(() => window.api.alarms.acknowledge([alarm.id], !alarm.acknowledged))
    if (!result.success) error.value = resultMessage(result)
    else await load()
  } finally {
    busyId.value = ''
  }
}

async function mark(alarm: AlarmEvent): Promise<void> {
  if (busyId.value !== '') return
  busyId.value = alarm.id
  try {
    const result = await callApi(() => window.api.alarms.setNote(alarm.id, isMarked(alarm) ? null : MARK_NOTE))
    if (!result.success) error.value = resultMessage(result)
    else await load()
  } finally {
    busyId.value = ''
  }
}

onMounted(async () => {
  await load()
  void syncAudio(false)
  autoTimer = window.setInterval(() => void syncAudio(false), 30_000)
})

onBeforeUnmount(() => {
  if (autoTimer !== undefined) window.clearInterval(autoTimer)
})

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
      <button type="button" class="btn btn--sm" :disabled="syncing" data-gas-leak-sync-audio @click="syncAudio(true)">
        {{ syncing ? t('gasLeakUi.syncing') : t('gasLeakUi.syncAudio') }}
      </button>
    </div>

    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-if="loading && alarms.length === 0" class="muted">{{ t('common.loading') }}</p>
    <p v-else-if="alarms.length === 0" class="muted">{{ t('gasLeakUi.none') }}</p>
    <ul v-else class="gas-leak-history__list">
      <li v-for="alarm in alarms" :key="alarm.id" data-gas-leak-history-row>
        <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
        <span class="badge">CH{{ alarm.channelId + 1 }}</span>
        <span class="gas-leak-history__well">{{ wellName(alarm.channelId) }}</span>
        <span class="muted">{{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}</span>
        <span v-if="isMarked(alarm)" class="badge badge--warning">{{ t('gasLeakUi.marked') }}</span>
        <span v-else></span>
        <div class="gas-leak-history__actions">
          <button type="button" class="btn btn--sm" :disabled="!alarm.localRecordingId || busyId !== ''" @click="play(alarm)">
            {{ selectedRecordingId === alarm.localRecordingId ? t('gasLeakUi.stopAudio') : t('gasLeakUi.playAudio') }}
          </button>
          <button type="button" class="btn btn--sm" :disabled="!alarm.localRecordingId || busyId !== ''" @click="download(alarm)">
            {{ t('gasLeakUi.download') }}
          </button>
          <button type="button" class="btn btn--sm" :disabled="busyId !== ''" @click="handle(alarm)">
            {{ alarm.acknowledged ? t('gasLeakUi.handled') : t('gasLeakUi.handle') }}
          </button>
          <button type="button" class="btn btn--sm" :disabled="busyId !== ''" @click="mark(alarm)">
            {{ isMarked(alarm) ? t('gasLeakUi.unmark') : t('gasLeakUi.mark') }}
          </button>
          <button type="button" class="btn btn--sm btn--danger" :disabled="busyId !== ''" @click="remove(alarm)">
            {{ t('gasLeakUi.delete') }}
          </button>
        </div>
      </li>
    </ul>

    <RecordingPlayer v-if="selectedRecordingId" :recording-id="selectedRecordingId" auto-load />
    <MonitorRecordingTimeline :device-id="deviceId" />
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
  grid-template-columns: auto auto minmax(80px, 1fr) auto auto;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.gas-leak-history__well {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gas-leak-history__actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>