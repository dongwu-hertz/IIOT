<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Channel, RecordingPage } from '@shared/domain/models'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime } from '@renderer/lib/format'
import MonitorRecordingTimeline from '@renderer/components/MonitorRecordingTimeline.vue'

const props = defineProps<{ deviceId: string; channels: readonly Channel[] }>()
const { t } = useI18n()
const page = ref<RecordingPage | null>(null)
const loading = ref(false)
const syncing = ref(false)
const notice = ref('')
const noticeKind = ref<'success' | 'danger'>('success')
const timelineKey = ref(0)
const total = computed(() => page.value?.total ?? 0)
const latest = computed(() => page.value?.items[0]?.startTime)
const enabledChannels = computed(() => props.channels.filter((channel) => channel.enabled).length)
const alarms = ref<AlarmEvent[]>([])
const alarmsLoading = ref(false)

function wellName(channelId: number): string {
  return props.channels.find((channel) => channel.channelIndex === channelId)?.channelName?.trim() || '—'
}

async function loadAlarms(): Promise<void> {
  if (props.deviceId === '') { alarms.value = []; return }
  alarmsLoading.value = true
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 50 }))
  alarmsLoading.value = false
  alarms.value = result.success ? (unwrap(result)?.items ?? []) : []
}

async function load(): Promise<void> {
  if (props.deviceId === '') { page.value = null; return }
  loading.value = true
  const result = await callApi(() => window.api.recordings.query({ deviceId: props.deviceId, limit: 5, offset: 0 }))
  loading.value = false
  if (!result.success) { page.value = null; return }
  page.value = unwrap(result) ?? null
}

async function sync(): Promise<void> {
  if (props.deviceId === '' || syncing.value) return
  syncing.value = true
  notice.value = ''
  const result = await callApi(() => window.api.recordings.syncDevice(props.deviceId))
  syncing.value = false
  if (!result.success) {
    noticeKind.value = 'danger'
    notice.value = t('gasLeakUi.syncFailed', { reason: resultMessage(result) })
    return
  }
  noticeKind.value = 'success'
  notice.value = t('gasLeakUi.synced', { count: unwrap(result) ?? 0 })
  await load()
  await loadAlarms()
  timelineKey.value += 1
}

onMounted(() => { void load(); void loadAlarms() })
watch(() => props.deviceId, () => { notice.value = ''; void load(); void loadAlarms() })
</script>

<template>
  <section class="card gas-leak" data-gas-leak-panel>
    <header class="section-header gas-leak__header">
      <h3 class="section-title">{{ t('gasLeakUi.title') }}</h3>
      <span class="badge">{{ t('gasLeakUi.badge') }}</span>
      <div class="spacer"></div>
      <button type="button" class="btn btn--sm" :disabled="syncing" @click="sync">
        {{ syncing ? t('gasLeakUi.syncing') : t('gasLeakUi.sync') }}
      </button>
      <RouterLink class="btn btn--sm" to="/recordings">{{ t('gasLeakUi.goRecordings') }}</RouterLink>
    </header>

    <p class="muted gas-leak__description">{{ t('gasLeakUi.noLiveStream') }}</p>

    <dl class="gas-leak__facts">
      <div class="gas-leak__fact">
        <dt>{{ t('gasLeakUi.alarmCount') }}</dt>
        <dd>{{ loading ? '—' : total }}</dd>
      </div>
      <div class="gas-leak__fact">
        <dt>{{ t('gasLeakUi.latestAlarm') }}</dt>
        <dd>{{ latest === undefined ? t('gasLeakUi.none') : formatDateTime(latest) }}</dd>
      </div>
      <div class="gas-leak__fact">
        <dt>{{ t('gasLeakUi.channels') }}</dt>
        <dd>{{ enabledChannels }} / {{ channels.length }}</dd>
      </div>

    </dl>

    <div class="gas-leak__alarms" data-gas-leak-alarms>
      <div class="section-header">
        <h4 class="section-title">{{ t('gasLeakUi.alarmHistory') }}</h4>
        <span class="muted">{{ alarms.length }}</span>
      </div>
      <p v-if="alarmsLoading" class="muted">{{ t('common.loading') }}</p>
      <p v-else-if="alarms.length === 0" class="muted">{{ t('gasLeakUi.none') }}</p>
      <ul v-else class="gas-leak__alarm-list">
        <li v-for="alarm in alarms.slice(0, 20)" :key="alarm.id" data-gas-leak-alarm-row>
          <span class="muted">{{ formatDateTime(alarm.timestamp) }}</span>
          <span class="badge">CH{{ alarm.channelId + 1 }}</span>
          <span>{{ wellName(alarm.channelId) }}</span>
          <span class="muted">{{ alarm.spl === undefined ? '—' : `${alarm.spl.toFixed(1)} dB` }}</span>
        </li>
      </ul>
    </div>

    <p v-if="notice" class="alert" :class="`alert--${noticeKind}`" role="status">{{ notice }}</p>
  </section>

  <MonitorRecordingTimeline :key="timelineKey" :device-id="deviceId" />
</template>

<style scoped>
.gas-leak { display: flex; flex-direction: column; gap: var(--space-3); }
.gas-leak__header { flex-wrap: wrap; gap: var(--space-2); }
.gas-leak__description { margin: 0; max-width: 90ch; line-height: 1.6; }
.gas-leak__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); margin: 0; }
.gas-leak__fact { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-raised, var(--color-surface)); }
.gas-leak__fact dt { margin-bottom: 6px; font-size: 12px; color: var(--color-text-tertiary); }
.gas-leak__fact dd { margin: 0; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gas-leak__alarms {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.gas-leak__alarm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
}

.gas-leak__alarm-list li {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-2);
}
</style>
