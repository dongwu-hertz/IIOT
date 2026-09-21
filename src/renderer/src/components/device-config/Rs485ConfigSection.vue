<script setup lang="ts">
/**
 * RS485 配置（Phase 9）。
 *
 * THE TRAP THIS FORM WORKS AROUND
 * `portRight` (右端口) is REQUIRED by the write endpoint but is NOT returned by
 * the read endpoint (PROTOCOL-FINDINGS 5A.6). The device replaces the whole
 * object on write, so a form that submits "everything it can see" would clear a
 * right port it never saw. Two rules follow, and both matter:
 *
 *   1. The empty field is labelled as UNKNOWN, not as "empty", because that is
 *      what it means — the device never told us.
 *   2. 保存 sends only the fields the user actually changed, so an untouched
 *      `portRight` is passed through by the service exactly as it read it.
 */
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import type { Rs485ConfigView } from '@renderer/types/device-config'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { useDeviceDetailDirtyStore } from '@renderer/stores/deviceDetailDirty'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()
const dirtyRegistry = useDeviceDetailDirtyStore()

const BAUD_RATES: readonly number[] = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]
const DATA_BITS: readonly number[] = [5, 6, 7, 8]
/** The device does not document its mode values; only the label is ours. */
/** The device does not document its mode values; only the label is ours. */
const MODES = [{ value: 0 }, { value: 1 }] as const

interface Draft {
  baud: number
  dataBits: number
  mode: number
  portLeft: string
  portRight: string
  address: string
}

const draft = reactive<Draft>({
  baud: 9600,
  dataBits: 8,
  mode: 0,
  portLeft: '',
  portRight: '',
  address: ''
})

const notice = ref('')
const formError = ref('')

/** The value last read from the device; the diff in `save()` is against this. */
const original = ref<Rs485ConfigView | null>(null)

watch(
  () => config.rs485,
  (value) => {
    if (!value) return
    original.value = { ...value }
    draft.baud = Number(value.baud)
    draft.dataBits = Number(value.dataBits)
    draft.mode = Number(value.mode)
    draft.portLeft = value.portLeft
    draft.portRight = value.portRight
    draft.address = value.address
  },
  { immediate: true }
)

/** Serial ports the device offers, plus whatever is currently configured. */
const portOptions = computed(() => {
  const options = [...config.serialPorts]
  if (draft.portLeft !== '' && !options.includes(draft.portLeft)) options.unshift(draft.portLeft)
  return options
})

const portLeftUnlisted = computed(() => draft.portLeft !== '' && !config.serialPorts.includes(draft.portLeft))

/** True when the device never told us what the right port is. */
const portRightUnknown = computed(() => (original.value?.portRight ?? '') === '')

/**
 * Only the fields the user changed.
 *
 * Not an optimisation: submitting an unchanged `portRight` is precisely how a
 * configured-but-unreadable serial port gets cleared.
 */
function buildPatch(): Partial<Rs485ConfigView> {
  const before = original.value
  const patch: Partial<Rs485ConfigView> = {}
  if (!before) return patch
  if (draft.baud !== before.baud) patch.baud = Number(draft.baud)
  if (draft.dataBits !== before.dataBits) patch.dataBits = Number(draft.dataBits)
  if (draft.mode !== before.mode) patch.mode = Number(draft.mode)
  if (draft.portLeft !== before.portLeft) patch.portLeft = draft.portLeft
  if (draft.portRight !== before.portRight) patch.portRight = draft.portRight
  if (draft.address !== before.address) patch.address = draft.address
  return patch
}

const dirty = computed(() => Object.keys(buildPatch()).length > 0)

/*
 * 脏标记同步给详情页的未保存确认（切页签 / 关弹窗时拦人）。本地 `dirty` 仍是
 * 徽标与按钮 disabled 的来源 —— 登记处只是它的回声。卸载（切走 serial 页签 /
 * 关弹窗）时置回 false：草稿随组件销毁，脏标记不能比草稿活得长。
 */
watch(dirty, (value) => dirtyRegistry.mark('rs485', value), { immediate: true })
onUnmounted(() => dirtyRegistry.mark('rs485', false))

function resetDraft(): void {
  const before = original.value
  if (!before) return
  draft.baud = Number(before.baud)
  draft.dataBits = Number(before.dataBits)
  draft.mode = Number(before.mode)
  draft.portLeft = before.portLeft
  draft.portRight = before.portRight
  draft.address = before.address
  formError.value = ''
  notice.value = ''
}

async function save(): Promise<void> {
  notice.value = ''
  formError.value = ''
  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    notice.value = t('configCommon.noChanges')
    return
  }
  const saved = await config.updateRs485(props.deviceId, patch)
  if (!saved) {
    formError.value = config.error || t('configRs485.saveFailed')
    return
  }
  notice.value = t('configRs485.savedNotice')
}

async function reload(): Promise<void> {
  notice.value = ''
  formError.value = ''
  const failure = await config.loadRs485(props.deviceId)
  if (failure) {
    formError.value = failure
    return
  }
  await config.loadSerialPorts(props.deviceId)
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configRs485.title') }}</h3>
      <div class="btn-row">
        <span v-if="dirty" class="badge badge--warning">{{ t('configCommon.unsaved') }}</span>
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('configCommon.baudRate') }}</span>
        <select v-model.number="draft.baud" class="select">
          <option v-if="!BAUD_RATES.includes(draft.baud)" :value="draft.baud">—</option>
          <option v-for="rate in BAUD_RATES" :key="rate" :value="rate">{{ rate }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configCommon.dataBits') }}</span>
        <select v-model.number="draft.dataBits" class="select">
          <option v-if="!DATA_BITS.includes(draft.dataBits)" :value="draft.dataBits">
            —
          </option>
          <option v-for="bits in DATA_BITS" :key="bits" :value="bits">{{ bits }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configRs485.mode') }}</span>
        <select v-model.number="draft.mode" class="select">
          <option v-if="!MODES.some((item) => item.value === draft.mode)" :value="draft.mode">
            —
          </option>
          <option v-for="item in MODES" :key="item.value" :value="item.value">
            {{ t('configRs485.modeOption', { n: item.value }) }}
          </option>
        </select>
        <span class="field-hint">{{ t('configCommon.deviceWordingPrivate') }}</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configRs485.portLeft') }}</span>
        <select v-model="draft.portLeft" class="select">
          <option value="">{{ t('configRs485.unused') }}</option>
          <option v-for="port in portOptions" :key="port" :value="port">{{ port }}</option>
        </select>
        <span v-if="portLeftUnlisted" class="field-hint">
          {{ t('configRs485.portNotInList') }}
        </span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configRs485.portRight') }}</span>
        <input
          v-model="draft.portRight"
          class="input mono"
          type="text"
          spellcheck="false"
          :placeholder="portRightUnknown ? t('configRs485.portUnknown') : ''"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t('configRs485.deviceAddress') }}</span>
        <input v-model="draft.address" class="input mono" type="text" spellcheck="false" />
      </label>
    </div>

    <p v-if="formError" class="alert alert--danger actions" role="alert">{{ formError }}</p>
    <p v-else-if="notice" class="alert alert--success actions" role="status">{{ notice }}</p>

    <div class="btn-row actions">
      <button type="button" class="btn" :disabled="config.saving || !dirty" @click="resetDraft">
        {{ t('configCommon.revert') }}
      </button>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="config.saving || !dirty"
        @click="save"
      >
        {{ config.saving ? t('configCommon.saving') : t('configRs485.saveButton') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.actions {
  margin-top: var(--space-3);
}
</style>
