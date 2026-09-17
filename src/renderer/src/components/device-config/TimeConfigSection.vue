<script setup lang="ts">
/**
 * 时间 / NTP（Phase 9）。
 *
 * The device clock is a snapshot: the drift shown here is computed against the
 * host clock AT THE MOMENT OF THE READ (`store.timeDriftSeconds`), not against a
 * live ticking clock. Subtracting "now" from a five-minute-old reading would
 * invent drift that is really just the age of the value.
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { EMPTY_VALUE, formatDateTime } from '@renderer/lib/format'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()

interface Draft {
  ntpEnabled: boolean
  ntpServer: string
  ntpInterval: number
}

const draft = reactive<Draft>({ ntpEnabled: false, ntpServer: '', ntpInterval: 60 })

const notice = ref('')
const formError = ref('')

watch(
  () => config.time,
  (value) => {
    if (!value) return
    draft.ntpEnabled = value.ntpEnabled
    draft.ntpServer = value.ntpServer
    draft.ntpInterval = Number(value.ntpInterval)
  },
  { immediate: true }
)

/** Host clock, ticking while this section is mounted (interval cleared on unmount). */
const hostNow = ref(Date.now())
const timer = window.setInterval(() => {
  hostNow.value = Date.now()
}, 1000)
onUnmounted(() => {
  window.clearInterval(timer)
})

const deviceTimeText = computed(() =>
  config.time ? formatDateTime(config.time.deviceTime) : EMPTY_VALUE
)
const hostTimeText = computed(() => formatDateTime(hostNow.value))
const readAtText = computed(() => (config.timeReadAt ? formatDateTime(config.timeReadAt) : EMPTY_VALUE))

/** Signed drift, in seconds, with the plain-language reading operators ask for. */
const drift = computed(() => config.timeDriftSeconds)
const driftText = computed(() => {
  const value = drift.value
  if (value === null) return EMPTY_VALUE
  const magnitude = Math.abs(value)
  if (magnitude < 0.5) return t('configTime.sameAsHost')
  const seconds = magnitude >= 10 ? magnitude.toFixed(1) : magnitude.toFixed(2)
  return value > 0
    ? t('configTime.deviceAhead', { seconds })
    : t('configTime.deviceBehind', { seconds })
})

const driftClass = computed(() => {
  const value = drift.value
  if (value === null) return ''
  return Math.abs(value) < 0.5 ? 'text-success' : Math.abs(value) < 5 ? '' : 'text-warning'
})

async function save(): Promise<void> {
  notice.value = ''
  formError.value = ''

  if (!Number.isInteger(draft.ntpInterval) || draft.ntpInterval < 1) {
    formError.value = t('configTime.errInterval')
    return
  }
  if (draft.ntpEnabled && draft.ntpServer.trim() === '') {
    formError.value = t('configTime.errServerRequired')
    return
  }

  const saved = await config.updateTime(props.deviceId, {
    ntpEnabled: draft.ntpEnabled,
    ntpServer: draft.ntpServer.trim(),
    ntpInterval: Number(draft.ntpInterval)
  })
  if (!saved) {
    formError.value = config.error || t('configTime.saveFailed')
    return
  }
  notice.value = t('configTime.savedNotice', { time: formatDateTime(saved.deviceTime) })
}

async function syncNow(): Promise<void> {
  notice.value = ''
  formError.value = ''
  const synced = await config.syncTime(props.deviceId)
  if (!synced) {
    formError.value = config.error || t('configTime.syncFailed')
    return
  }
  notice.value = t('configTime.syncedNotice', { time: formatDateTime(synced.deviceTime) })
}

async function reload(): Promise<void> {
  notice.value = ''
  formError.value = ''
  const failure = await config.loadTime(props.deviceId)
  if (failure) formError.value = failure
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configTime.title') }}</h3>
      <div class="btn-row">
        <span class="muted hint">{{ t('configCommon.readAt', { time: readAtText }) }}</span>
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <dl class="kv clock">
      <div class="kv__item">
        <dt class="kv__label">{{ t('configCommon.deviceTime') }}</dt>
        <dd class="kv__value mono">{{ deviceTimeText }}</dd>
      </div>
      <div class="kv__item">
        <dt class="kv__label">{{ t('configCommon.hostTime') }}</dt>
        <dd class="kv__value mono">{{ hostTimeText }}</dd>
      </div>
      <div class="kv__item">
        <dt class="kv__label">{{ t('configCommon.drift') }}</dt>
        <dd class="kv__value" :class="driftClass">{{ driftText }}</dd>
      </div>
    </dl>

    <div class="form-grid settings">
      <div class="field">
        <span class="field-label">{{ t('configTime.ntpToggle') }}</span>
        <label class="toggle">
          <input v-model="draft.ntpEnabled" type="checkbox" />
          <span>{{ draft.ntpEnabled ? t('configCommon.enabled') : t('configCommon.disabled') }}</span>
        </label>
      </div>
      <label class="field">
        <span class="field-label">{{ t('configTime.ntpServer') }}</span>
        <input
          v-model="draft.ntpServer"
          class="input mono"
          type="text"
          spellcheck="false"
          :disabled="!draft.ntpEnabled"
          :placeholder="t('configTime.ntpServerPlaceholder')"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t('configTime.ntpInterval') }}</span>
        <input v-model.number="draft.ntpInterval" class="input" type="number" min="1" />
        <span class="field-hint">{{ t('configCommon.unitPerDevice') }}</span>
      </label>
    </div>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <div class="btn-row actions">
      <button type="button" class="btn" :disabled="config.saving" @click="syncNow">
        {{ t('configTime.syncNow') }}
      </button>
      <button type="button" class="btn btn--primary" :disabled="config.saving" @click="save">
        {{ config.saving ? t('configCommon.saving') : t('configTime.saveButton') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.hint {
  font-size: 11.5px;
}

.clock {
  margin-bottom: var(--space-4);
}

.settings {
  margin-bottom: var(--space-2);
}

.block-hint {
  display: block;
  margin: var(--space-2) 0 var(--space-3);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.actions {
  margin-top: var(--space-3);
}
</style>
