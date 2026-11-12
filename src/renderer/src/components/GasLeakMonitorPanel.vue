<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Channel, RecordingPage } from '@shared/domain/models'
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
  timelineKey.value += 1
}

onMounted(() => { void load() })
watch(() => props.deviceId, () => { notice.value = ''; void load() })
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
</style>
