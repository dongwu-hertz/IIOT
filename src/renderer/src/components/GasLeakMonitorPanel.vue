<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Channel } from '@shared/domain/models'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime } from '@renderer/lib/format'

const props = defineProps<{ deviceId: string; channels: readonly Channel[] }>()
const { t } = useI18n()
const alarms = ref<AlarmEvent[]>([])
const alarmTotal = ref(0)
const loading = ref(false)
const syncing = ref(false)
const notice = ref('')

const latest = computed(() => alarms.value[0]?.timestamp)
const enabledChannels = computed(() => props.channels.filter((channel) => channel.enabled).length)


async function loadAlarms(): Promise<void> {
  if (props.deviceId === '') {
    alarms.value = []
    alarmTotal.value = 0
    return
  }
  loading.value = true
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 100 }))
  loading.value = false
  if (!result.success) {
    alarms.value = []
    alarmTotal.value = 0
    return
  }
  const page = unwrap(result)
  alarms.value = page?.items ?? []
  alarmTotal.value = page?.total ?? alarms.value.length
}

async function manualRecording(): Promise<void> {
  if (props.deviceId === '' || syncing.value) return
  syncing.value = true
  notice.value = ''
  const result = await callApi(() => window.api.recordings.syncDevice(props.deviceId))
  syncing.value = false
  if (!result.success) {
    notice.value = t('gasLeakUi.syncFailed', { reason: resultMessage(result) })
    return
  }
  notice.value = t('gasLeakUi.synced', { count: unwrap(result) ?? 0 })
  await loadAlarms()
}

onMounted(() => { void loadAlarms() })
watch(() => props.deviceId, () => { notice.value = ''; void loadAlarms() })
</script>

<template>
  <section class="card gas-leak" data-gas-leak-panel>
    <header class="section-header gas-leak__header">
      <h3 class="section-title">{{ t('gasLeakUi.panelTitle') }}</h3>
    </header>

    <dl class="gas-leak__facts">
      <div class="gas-leak__fact">
        <dt>{{ t('gasLeakUi.alarmCount') }}</dt>
        <dd>{{ loading ? '—' : alarmTotal }}</dd>
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

    <button type="button" class="btn btn--primary gas-leak__record-button" :disabled="syncing" data-gas-leak-manual-recording @click="manualRecording">
      {{ syncing ? t('gasLeakUi.syncing') : t('gasLeakUi.manualRecording') }}
    </button>

    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.gas-leak { display: flex; flex-direction: column; gap: var(--space-3); }
.gas-leak__header { flex-wrap: wrap; gap: var(--space-2); }
.gas-leak__facts { display: grid; grid-template-columns: 1fr; gap: var(--space-2); margin: 0; }
.gas-leak__fact { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface-raised, var(--color-surface)); }
.gas-leak__fact dt { margin-bottom: 6px; font-size: 12px; color: var(--color-text-tertiary); }
.gas-leak__fact dd { margin: 0; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gas-leak__record-button { min-height: 40px; align-self: flex-start; }
</style>
