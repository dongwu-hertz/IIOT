<script setup lang="ts">
/**
 * 网络配置（Phase 9）— the one write that can lock a device out.
 *
 * WHY THIS FORM IS SHAPED DIFFERENTLY FROM THE OTHERS
 * `PUT /set_network` changes the address the device answers on, so the connection
 * carrying the request dies the moment it applies. The main process treats it as
 * a transaction — write, reconnect on the NEW address, verify, and on failure
 * reconnect on the OLD address and restore the snapshot — which takes up to ~45 s
 * (docs/PROTOCOL-FINDINGS.md 5A.4). Three consequences drive this component:
 *
 *   1. A confirmation that states the consequence, not just "are you sure".
 *   2. Live stage narration from `window.events.onNetworkProgress`; a spinner
 *      that may never resolve is the worst possible UI for a lockout risk.
 *   3. The service's `message` is shown VERBATIM. It is the only text that
 *      distinguishes "rolled back, the device is unchanged" from "unreachable on
 *      both addresses, go and find the device".
 */
import { computed, reactive, ref, watch } from 'vue'
import type { NetworkChangeStage, NetworkConfigView } from '@renderer/types/device-config'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { useDevicesStore } from '@renderer/stores/devices'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()
const devices = useDevicesStore()

/**
 * Translation key per stage — every stage the main process can push has one.
 *
 * Keys rather than labels: this map is built once at module scope, so rendered
 * strings would freeze at the startup language.
 */
const STAGE_LABEL_KEYS: Record<NetworkChangeStage, string> = {
  applying: 'configNetwork.stageApplying',
  applied: 'configNetwork.stageApplied',
  reconnecting: 'configNetwork.stageReconnecting',
  connected: 'configNetwork.stageConnected',
  verifying: 'configNetwork.stageVerifying',
  verified: 'configNetwork.stageVerified',
  'rolling-back': 'configNetwork.stageRollingBack',
  'rolled-back': 'configNetwork.stageRolledBack',
  unreachable: 'configNetwork.stageUnreachable'
}

/** Forward progress, in order, for the stepper. Failure stages are terminal. */
const FORWARD_STAGES: readonly NetworkChangeStage[] = [
  'applying',
  'applied',
  'reconnecting',
  'connected',
  'verifying',
  'verified'
]

function emptyNetwork(): NetworkConfigView {
  return {
    mode: 'manual',
    ip: '',
    netmask: '',
    gateway: '',
    dns: '',
    httpPort: 80,
    rtspPort: 0,
    tcpPort: 0
  }
}

/**
 * The form draft.
 *
 * Mirrored into the store through `updateNetwork` so the store owns the draft
 * (that is what `networkDirty`, 撤销修改 and `changeNetwork` operate on). Both
 * watchers bail out when the two sides already agree, which is what keeps this
 * two-way sync from looping.
 */
const draft = reactive<NetworkConfigView>({ ...emptyNetwork() })

function sameAsDraft(value: NetworkConfigView): boolean {
  return (
    value.mode === draft.mode &&
    value.ip === draft.ip &&
    value.netmask === draft.netmask &&
    value.gateway === draft.gateway &&
    value.dns === draft.dns &&
    value.httpPort === draft.httpPort &&
    value.rtspPort === draft.rtspPort &&
    value.tcpPort === draft.tcpPort
  )
}

watch(
  () => config.network,
  (value) => {
    if (!value || sameAsDraft(value)) return
    // `Object.assign` rather than replacing the object: the inputs bind to these
    // properties, and swapping the object mid-edit would drop focus.
    Object.assign(draft, value)
  },
  { immediate: true }
)

watch(
  draft,
  () => {
    const current = config.network
    if (current && sameAsDraft(current)) return
    config.updateNetwork({ ...draft })
  },
  { deep: true }
)

const busy = computed(() => config.networkChanging || config.saving)

/** Device-reported mode values are the firmware's own strings (measured: "manual"). */
const MODE_OPTIONS = [
  { value: 'manual', labelKey: 'configNetwork.modeManual' },
  { value: 'dhcp', labelKey: 'configNetwork.modeDhcp' }
] as const

const modeIsUnlisted = computed(() => !MODE_OPTIONS.some((item) => item.value === draft.mode))

const confirmOpen = ref(false)
const formError = ref('')
const resultNotice = ref('')

const progress = computed(() => config.networkProgress)
const progressStage = computed<NetworkChangeStage | null>(() => progress.value?.stage ?? null)
const progressDetail = computed(() => progress.value?.detail ?? '')
const activeIndex = computed(() => {
  const stage = progressStage.value
  return stage === null ? -1 : FORWARD_STAGES.indexOf(stage)
})
const failedStage = computed(() => {
  const stage = progressStage.value
  if (stage === null) return null
  return FORWARD_STAGES.includes(stage) ? null : stage
})

function isIpv4(value: string): boolean {
  const parts = value.trim().split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const octet = Number(part)
    return octet >= 0 && octet <= 255
  })
}

function portProblem(label: string, value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return t('configNetwork.errPort', { label })
  }
  return ''
}

/** Client-side checks only — the device performs no useful validation of its own. */
function validate(): string {
  if (!isIpv4(draft.ip)) return t('configNetwork.errIp')
  if (!isIpv4(draft.netmask)) return t('configNetwork.errNetmask')
  if (draft.gateway.trim() !== '' && !isIpv4(draft.gateway)) return t('configNetwork.errGateway')
  if (draft.dns.trim() !== '' && !isIpv4(draft.dns)) return t('configNetwork.errDns')
  const portFields: Array<[string, number]> = [
    [t('configNetwork.portHttp'), draft.httpPort],
    [t('configNetwork.portRtsp'), draft.rtspPort],
    [t('configNetwork.portTcp'), draft.tcpPort]
  ]
  for (const [label, value] of portFields) {
    const problem = portProblem(label, value)
    if (problem) return problem
  }
  return ''
}

function askSave(): void {
  formError.value = ''
  resultNotice.value = ''
  const problem = validate()
  if (problem) {
    formError.value = problem
    return
  }
  confirmOpen.value = true
}

async function submit(): Promise<void> {
  const payload: NetworkConfigView = { ...draft }
  const info = await config.changeNetwork(props.deviceId, payload)
  confirmOpen.value = false

  if (!info) {
    formError.value = config.error || t('configNetwork.saveFailed')
    return
  }
  // Verbatim: the service writes this sentence for the user, including the
  // "unreachable on both addresses" case that no local wording could improve on.
  resultNotice.value = info.message
  formError.value = ''

  // The main process persists the address it actually reached the device on, so
  // the device row (and this page's header) must be re-read rather than assumed.
  await devices.load()
}

function resetDraft(): void {
  config.resetNetworkDraft()
  formError.value = ''
  resultNotice.value = ''
}

async function reload(): Promise<void> {
  formError.value = ''
  resultNotice.value = ''
  const failure = await config.loadNetwork(props.deviceId)
  if (failure) formError.value = failure
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configNetwork.title') }}</h3>
      <div class="btn-row">
        <span v-if="config.networkDirty" class="badge badge--warning">{{ t('configCommon.unsaved') }}</span>
        <button type="button" class="btn btn--sm" :disabled="config.loading || busy" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <p class="alert alert--danger" role="note">
      <span class="alert__icon" aria-hidden="true">⚠</span>
      <span class="alert__body">
        <span class="alert__title">{{ t('configNetwork.disconnectTitle') }}</span>
        <!--
          The `<strong>` stays in the template: keeping it in the catalogue would
          require `v-html`, and this project keeps a strict CSP so that rendering
          markup out of data never becomes routine.
        -->
        {{ t('configNetwork.disconnectBodyBefore') }}<strong>{{ t('configNetwork.disconnectBodyStrong') }}</strong>{{ t('configNetwork.disconnectBodyAfter') }}
        {{ t('configNetwork.disconnectWarning') }}
      </span>
    </p>

    <fieldset class="fieldset" :disabled="busy">
      <legend class="visually-hidden">{{ t('configNetwork.legend') }}</legend>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ t('configNetwork.mode') }}</span>
          <select v-model="draft.mode" class="select">
            <option v-if="modeIsUnlisted" :value="draft.mode">—</option>
            <option v-for="item in MODE_OPTIONS" :key="item.value" :value="item.value">
              {{ t(item.labelKey) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.ip') }}</span>
          <input v-model="draft.ip" class="input mono" type="text" spellcheck="false" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.netmask') }}</span>
          <input v-model="draft.netmask" class="input mono" type="text" spellcheck="false" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.gateway') }}</span>
          <input v-model="draft.gateway" class="input mono" type="text" spellcheck="false" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.dns') }}</span>
          <input v-model="draft.dns" class="input mono" type="text" spellcheck="false" />
        </label>
      </div>

      <div class="form-grid port-grid">
        <label class="field">
          <span class="field-label">{{ t('configNetwork.portHttp') }}</span>
          <input v-model.number="draft.httpPort" class="input" type="number" min="1" max="65535" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.portRtsp') }}</span>
          <input v-model.number="draft.rtspPort" class="input" type="number" min="1" max="65535" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configNetwork.portTcp') }}</span>
          <input v-model.number="draft.tcpPort" class="input" type="number" min="1" max="65535" />
        </label>
      </div>
    </fieldset>

    <!-- 进度：设备重连期间唯一可信的信息来源 -->
    <div v-if="busy || progress" class="progress-block">
      <div class="progress-head">
        <span class="section-title progress-title">{{ t('configNetwork.progressTitle') }}</span>
        <span v-if="busy" class="badge badge--accent">{{ t('configNetwork.progressRunning') }}</span>
        <span v-else class="badge">{{ t('configNetwork.progressDone') }}</span>
      </div>
      <ol class="stages">
        <li
          v-for="(stage, index) in FORWARD_STAGES"
          :key="stage"
          class="stage"
          :class="{
            'stage--done': activeIndex > index,
            'stage--active': activeIndex === index,
            'stage--failed': failedStage !== null && activeIndex === index
          }"
        >
          <span class="stage__marker" aria-hidden="true">{{
            activeIndex > index ? '✓' : activeIndex === index ? '●' : '○'
          }}</span>
          <span class="stage__label">{{ t(STAGE_LABEL_KEYS[stage]) }}</span>
        </li>
      </ol>
      <p v-if="failedStage" class="alert alert--danger stage-failure" role="alert">
        {{ t(STAGE_LABEL_KEYS[failedStage]) }}
      </p>
      <p v-if="progressDetail" class="mono progress-detail">{{ progressDetail }}</p>
    </div>

    <!-- 结果：主进程给出的原句，不做二次改写 -->
    <p
      v-if="resultNotice"
      class="alert result"
      :class="config.networkChange?.unreachable ? 'alert--danger' : config.networkChange?.success ? 'alert--success' : 'alert--warning'"
      role="status"
    >
      {{ resultNotice }}
    </p>

    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>

    <div class="btn-row actions">
      <button type="button" class="btn" :disabled="busy || !config.networkDirty" @click="resetDraft">
        {{ t('configCommon.revert') }}
      </button>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="busy || !config.networkDirty"
        @click="askSave"
      >
        {{ busy ? t('configNetwork.processing') : t('configNetwork.saveButton') }}
      </button>
    </div>
  </section>

  <AppModal v-model="confirmOpen" :title="t('configNetwork.confirmTitle')" width="520px" :close-on-overlay="false">
    <p class="confirm-text">
      {{ t('configNetwork.confirmFrom') }}
      <strong class="mono">{{ config.networkOriginal?.ip || '—' }}</strong>
      {{ t('configNetwork.confirmTo') }}
      <strong class="mono">{{ draft.ip }}</strong>
      {{ t('configNetwork.confirmPortSuffix', { port: draft.httpPort }) }}
    </p>
    <p class="alert alert--danger confirm-warning" role="note">
      {{ t('configNetwork.confirmBody') }}
      {{ t('configNetwork.confirmWarning') }}
    </p>
    <template #footer>
      <button type="button" class="btn" @click="confirmOpen = false">{{ t('common.cancel') }}</button>
      <button type="button" class="btn btn--primary" data-autofocus @click="submit">
        {{ t('configNetwork.confirmAction') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.fieldset {
  border: none;
  margin: 0;
  padding: 0;
}

.port-grid {
  margin-top: var(--space-3);
}

.actions {
  margin-top: var(--space-4);
}

.progress-block {
  margin-top: var(--space-4);
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-subtle);
}

.progress-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.progress-title {
  font-size: 12.5px;
}

.stages {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stage {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}

.stage__marker {
  width: 14px;
  text-align: center;
  font-size: 11px;
}

.stage--done {
  color: var(--color-success);
}

.stage--active {
  color: var(--color-text);
  font-weight: 600;
}

.stage--failed {
  color: var(--color-danger);
}

.stage-failure {
  margin-top: var(--space-2);
}

.progress-detail {
  margin-top: 6px;
  color: var(--color-text-secondary);
}

.result {
  margin-top: var(--space-3);
}

.confirm-text {
  font-size: 13px;
}

.confirm-warning {
  margin-top: var(--space-3);
}
</style>
