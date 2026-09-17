<script setup lang="ts">
/**
 * Modbus 配置（Phase 9）。
 *
 * The slave id is validated here as well as in the service: the device answers a
 * bad value with a generic connection error, so a specific message before the
 * request is worth the duplicated rule.
 *
 * `modbus_crc` is read-only on the device and is deliberately neither shown nor
 * sent — the write endpoint does not accept it.
 */
import { computed, reactive, ref, watch } from 'vue'
import type { ModbusConfigView } from '@renderer/types/device-config'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()

const BAUD_RATES: readonly number[] = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]
const DATA_BITS: readonly number[] = [5, 6, 7, 8]
const STOP_BITS: readonly number[] = [1, 2]
/**
 * The device does not document its type values, so only the label is ours.
 *
 * The label is resolved with `t()` at render time rather than stored, so it
 * follows a language change.
 */
const TYPES = [{ value: 0 }, { value: 1 }] as const

interface Draft {
  port: number
  type: number
  baud: number
  dataBits: number
  stopBits: number
  slaveId: number
}

const draft = reactive<Draft>({ port: 502, type: 0, baud: 9600, dataBits: 8, stopBits: 1, slaveId: 1 })
const original = ref<ModbusConfigView | null>(null)

const notice = ref('')
const formError = ref('')

watch(
  () => config.modbus,
  (value) => {
    if (!value) return
    original.value = { ...value }
    draft.port = Number(value.port)
    draft.type = Number(value.type)
    draft.baud = Number(value.baud)
    draft.dataBits = Number(value.dataBits)
    draft.stopBits = Number(value.stopBits)
    draft.slaveId = Number(value.slaveId)
  },
  { immediate: true }
)

/** Only the changed fields; the service merges them over a fresh device read. */
function buildPatch(): Partial<ModbusConfigView> {
  const before = original.value
  const patch: Partial<ModbusConfigView> = {}
  if (!before) return patch
  if (Number(draft.port) !== before.port) patch.port = Number(draft.port)
  if (Number(draft.type) !== before.type) patch.type = Number(draft.type)
  if (Number(draft.baud) !== before.baud) patch.baud = Number(draft.baud)
  if (Number(draft.dataBits) !== before.dataBits) patch.dataBits = Number(draft.dataBits)
  if (Number(draft.stopBits) !== before.stopBits) patch.stopBits = Number(draft.stopBits)
  if (Number(draft.slaveId) !== before.slaveId) patch.slaveId = Number(draft.slaveId)
  return patch
}

const dirty = computed(() => Object.keys(buildPatch()).length > 0)

function resetDraft(): void {
  const before = original.value
  if (!before) return
  draft.port = Number(before.port)
  draft.type = Number(before.type)
  draft.baud = Number(before.baud)
  draft.dataBits = Number(before.dataBits)
  draft.stopBits = Number(before.stopBits)
  draft.slaveId = Number(before.slaveId)
  formError.value = ''
  notice.value = ''
}

async function save(): Promise<void> {
  notice.value = ''
  formError.value = ''

  const port = Number(draft.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    formError.value = t('configModbus.errPort')
    return
  }
  const slaveId = Number(draft.slaveId)
  if (!Number.isInteger(slaveId) || slaveId < 1 || slaveId > 247) {
    formError.value = t('configModbus.errSlaveId')
    return
  }

  const patch = buildPatch()
  if (Object.keys(patch).length === 0) {
    notice.value = t('configCommon.noChanges')
    return
  }

  const saved = await config.updateModbus(props.deviceId, patch)
  if (!saved) {
    formError.value = config.error || t('configModbus.saveFailed')
    return
  }
  notice.value = t('configModbus.savedNotice')
}

async function reload(): Promise<void> {
  notice.value = ''
  formError.value = ''
  const failure = await config.loadModbus(props.deviceId)
  if (failure) formError.value = failure
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configModbus.title') }}</h3>
      <div class="btn-row">
        <span v-if="dirty" class="badge badge--warning">{{ t('configCommon.unsaved') }}</span>
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <div class="form-grid">
      <label class="field">
        <span class="field-label">{{ t('configModbus.port') }}</span>
        <input v-model.number="draft.port" class="input" type="number" min="1" max="65535" />
        <span class="field-hint">1-65535</span>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configModbus.type') }}</span>
        <select v-model.number="draft.type" class="select">
          <option v-if="!TYPES.some((item) => item.value === draft.type)" :value="draft.type">
            —
          </option>
          <option v-for="item in TYPES" :key="item.value" :value="item.value">
            {{ t('configModbus.typeOption', { n: item.value }) }}
          </option>
        </select>
        <span class="field-hint">{{ t('configCommon.deviceWordingPrivate') }}</span>
      </label>
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
          <option v-if="!DATA_BITS.includes(draft.dataBits)" :value="draft.dataBits">—</option>
          <option v-for="bits in DATA_BITS" :key="bits" :value="bits">{{ bits }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configCommon.stopBits') }}</span>
        <select v-model.number="draft.stopBits" class="select">
          <option v-if="!STOP_BITS.includes(draft.stopBits)" :value="draft.stopBits">—</option>
          <option v-for="bits in STOP_BITS" :key="bits" :value="bits">{{ bits }}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{{ t('configModbus.slaveId') }}</span>
        <input v-model.number="draft.slaveId" class="input" type="number" min="1" max="247" />
        <span class="field-hint">1-247</span>
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
        {{ config.saving ? t('configCommon.saving') : t('configModbus.saveButton') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.actions {
  margin-top: var(--space-3);
}
</style>
