<script setup lang="ts">
/**
 * 告警参数配置（Phase 9）。
 *
 * Every field of `AlarmProfileConfig` is editable here, grouped the way an
 * operator thinks about a detector (基本信息 / 声压级 / 主频 / 频带能量比) rather
 * than the order the firmware happens to return them.
 *
 * The device REPLACES a profile wholesale: a request that changes only one
 * threshold still has to carry every other field, which is why the whole object
 * is always submitted and why the editor holds a complete draft rather than a
 * diff (see `ConfigService.saveAlarmProfile`). Field names never appear in the
 * UI — only 中文 labels — so a firmware rename cannot leak into the interface.
 */
import { computed, ref } from 'vue'
import type { AlarmProfileConfig } from '@renderer/types/device-config'
import { useI18n } from 'vue-i18n'
import { useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import AppModal from '@renderer/components/AppModal.vue'
import EmptyState from '@renderer/components/EmptyState.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()

/**
 * Detection modes: 0 = characteristic, 1 = AI.
 *
 * Keys rather than labels, and the names come from the shared `domain.detectionMode`
 * block so the value has one name across the app.
 */
const DETECTION_TYPES = [
  { value: 0, labelKey: 'domain.detectionMode.characteristic' },
  { value: 1, labelKey: 'domain.detectionMode.ai' }
] as const

/** Numeric fields, with the label used when one is left empty or non-numeric. */
type NumericField =
  | 'sensitivity'
  | 'interferenceSuppression'
  | 'splOverloadThreshold'
  | 'splSurgeThreshold'
  | 'splDropThreshold'
  | 'splStabilityThreshold'
  | 'mainFrequencyLower'
  | 'mainFrequencyUpper'
  | 'bandEnergyRatioLower'
  | 'bandEnergyRatioUpper'
  | 'bandEnergyRatioThreshold'

/**
 * Translation keys for the numeric fields, used when one is left empty or is not
 * a number. A key (not the text) so the validation message follows the language.
 */
const NUMERIC_FIELD_LABEL_KEYS: Record<NumericField, string> = {
  sensitivity: 'configAlarms.fieldSensitivity',
  interferenceSuppression: 'configAlarms.fieldInterferenceSuppression',
  splOverloadThreshold: 'configAlarms.fieldSplOverloadThreshold',
  splSurgeThreshold: 'configAlarms.fieldSplSurgeThreshold',
  splDropThreshold: 'configAlarms.fieldSplDropThreshold',
  splStabilityThreshold: 'configAlarms.fieldSplStabilityThreshold',
  mainFrequencyLower: 'configAlarms.fieldMainFrequencyLower',
  mainFrequencyUpper: 'configAlarms.fieldMainFrequencyUpper',
  bandEnergyRatioLower: 'configAlarms.fieldBandEnergyRatioLower',
  bandEnergyRatioUpper: 'configAlarms.fieldBandEnergyRatioUpper',
  bandEnergyRatioThreshold: 'configAlarms.fieldBandEnergyRatioThreshold'
}

const NUMERIC_FIELDS = Object.keys(NUMERIC_FIELD_LABEL_KEYS) as NumericField[]

/** A profile that has not been created on the device yet. */
function blankProfile(): AlarmProfileConfig {
  return {
    name: '',
    detectionType: 0,
    sensitivity: 10,
    interferenceSuppression: 10,
    splOverloadEnabled: false,
    splOverloadThreshold: 0,
    splSurgeEnabled: false,
    splSurgeThreshold: 0,
    splDropEnabled: false,
    splDropThreshold: 0,
    splStabilityEnabled: false,
    splStabilityThreshold: 0,
    mainFrequencyEnabled: false,
    mainFrequencyLower: 0,
    mainFrequencyUpper: 0,
    bandEnergyRatioEnabled: false,
    bandEnergyRatioLower: 0,
    bandEnergyRatioUpper: 0,
    bandEnergyRatioThreshold: 0
  }
}

const draft = ref<AlarmProfileConfig>(blankProfile())
const editorOpen = ref(false)
const formError = ref('')
const savingForm = ref(false)
const notice = ref('')

const pendingDelete = ref<AlarmProfileConfig | null>(null)
const deleteError = ref('')
const deleting = ref(false)

const isEditingExisting = computed(() => draft.value.id !== undefined)

function openCreate(): void {
  draft.value = blankProfile()
  formError.value = ''
  notice.value = ''
  editorOpen.value = true
}

function openEdit(profile: AlarmProfileConfig): void {
  // A copy: cancelling the dialog must not have already changed the table.
  draft.value = { ...profile }
  formError.value = ''
  notice.value = ''
  editorOpen.value = true
}

/**
 * Validate and coerce the draft into a payload.
 *
 * The coercion is not cosmetic: an emptied `<input type="number">` binds an
 * empty string, which would otherwise reach the device as `""` for a threshold
 * the firmware expects to be numeric.
 */
function buildPayload(): { payload?: AlarmProfileConfig; error?: string } {
  const payload: AlarmProfileConfig = { ...draft.value, name: draft.value.name.trim() }

  if (payload.name === '') return { error: t('configAlarms.errNameRequired') }

  for (const field of NUMERIC_FIELDS) {
    const parsed = Number(payload[field])
    if (!Number.isFinite(parsed)) {
      return { error: t('configAlarms.errNumeric', { field: t(NUMERIC_FIELD_LABEL_KEYS[field] as never) }) }
    }
    payload[field] = parsed
  }

  if (payload.sensitivity < 0 || payload.sensitivity > 100) {
    return { error: t('configAlarms.errSensitivityRange') }
  }
  if (payload.mainFrequencyEnabled && payload.mainFrequencyLower >= payload.mainFrequencyUpper) {
    return { error: t('configAlarms.errMainFrequencyRange') }
  }
  if (
    payload.bandEnergyRatioEnabled &&
    payload.bandEnergyRatioLower >= payload.bandEnergyRatioUpper
  ) {
    return { error: t('configAlarms.errBandEnergyRange') }
  }
  return { payload }
}

async function submit(): Promise<void> {
  const { payload, error } = buildPayload()
  if (!payload) {
    formError.value = error ?? t('configAlarms.errFormInvalid')
    return
  }

  savingForm.value = true
  const rows = await config.saveAlarmProfile(props.deviceId, payload)
  savingForm.value = false

  if (!rows) {
    formError.value = config.error || t('configAlarms.saveProfile')
    return
  }
  editorOpen.value = false
  notice.value =
      payload.id === undefined
        ? t('configAlarms.notifyCreated', { name: payload.name })
        : t('configAlarms.notifySaved', { name: payload.name })
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  if (!target || target.id === undefined) return
  deleting.value = true
  const rows = await config.deleteAlarmProfile(props.deviceId, target.id)
  deleting.value = false
  if (!rows) {
    deleteError.value = config.error || t('common.delete')
    return
  }
  pendingDelete.value = null
  deleteError.value = ''
  notice.value = t('configAlarms.notifyDeleted', { name: target.name })
}

/** Which detectors a profile currently has switched on, for the table. */
function enabledDetectors(profile: AlarmProfileConfig): string[] {
  const labels: string[] = []
  if (profile.splOverloadEnabled) labels.push(t('configAlarms.ruleOverload'))
  if (profile.splSurgeEnabled) labels.push(t('configAlarms.ruleSurge'))
  if (profile.splDropEnabled) labels.push(t('configAlarms.ruleDrop'))
  if (profile.splStabilityEnabled) labels.push(t('configAlarms.ruleStability'))
  if (profile.mainFrequencyEnabled) labels.push(t('configAlarms.ruleMainFrequency'))
  if (profile.bandEnergyRatioEnabled) labels.push(t('configAlarms.ruleBandEnergy'))
  return labels
}

function detectionLabel(value: number): string {
  const found = DETECTION_TYPES.find((item) => item.value === value)
  return found ? t(found.labelKey) : '—'
}

function askDelete(profile: AlarmProfileConfig): void {
  deleteError.value = ''
  notice.value = ''
  pendingDelete.value = profile
}

async function reload(): Promise<void> {
  notice.value = ''
  const failure = await config.loadAlarmProfiles(props.deviceId)
  if (failure) notice.value = failure
}
</script>

<template>
  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configAlarms.title') }}</h3>
      <div class="btn-row">
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reload">
          {{ t('configCommon.reload') }}
        </button>
        <button type="button" class="btn btn--sm btn--primary" @click="openCreate">{{ t('configAlarms.addProfile') }}</button>
      </div>
    </div>

    <p v-if="notice" class="alert alert--success notice" role="status">{{ notice }}</p>

    <EmptyState
      v-if="config.alarmProfiles.length === 0"
      :title="t('configAlarms.unavailableTitle')"
    >
      <button type="button" class="btn btn--sm btn--primary" @click="openCreate">
        {{ t('configAlarms.addProfile') }}
      </button>
    </EmptyState>

    <div v-else class="table-wrap table-scroll">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('configAlarms.columnName') }}</th>
            <th>{{ t('configAlarms.columnMode') }}</th>
            <th>{{ t('configAlarms.columnSensitivity') }}</th>
            <th>{{ t('configAlarms.columnInterference') }}</th>
            <th>{{ t('configAlarms.columnEnabledRules') }}</th>
            <th>{{ t('configAlarms.columnActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="profile in config.alarmProfiles" :key="profile.id ?? profile.name">
            <td>{{ profile.name || '—' }}</td>
            <td class="nowrap">{{ detectionLabel(profile.detectionType) }}</td>
            <td>{{ profile.sensitivity }}</td>
            <td>{{ profile.interferenceSuppression }}</td>
            <td>
              <div v-if="enabledDetectors(profile).length > 0" class="chip-row">
                <span v-for="label in enabledDetectors(profile)" :key="label" class="chip">
                  {{ label }}
                </span>
              </div>
              <span v-else class="muted">{{ t('configAlarms.allDisabled') }}</span>
            </td>
            <td>
              <div class="btn-row">
                <button type="button" class="btn btn--sm" @click="openEdit(profile)">{{ t('common.edit') }}</button>
                <button type="button" class="btn btn--sm btn--danger" @click="askDelete(profile)">
                  {{ t('common.delete') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 编辑 / 新增 -->
  <AppModal
    v-model="editorOpen"
    :title="isEditingExisting ? t('configAlarms.editProfile') : t('configAlarms.createProfile')"
    width="680px"
    :close-on-overlay="false"
  >
    <p v-if="formError" class="alert alert--danger" role="alert">{{ formError }}</p>

    <section class="group">
      <h4 class="group__title">{{ t('configAlarms.groupBasics') }}</h4>
      <div class="form-grid">
        <label class="field">
          <span class="field-label">{{ t('configAlarms.columnName') }}</span>
          <input v-model="draft.name" class="input" type="text" maxlength="64" spellcheck="false" />
        </label>
        <label class="field">
          <span class="field-label">{{ t('configAlarms.columnMode') }}</span>
          <select v-model.number="draft.detectionType" class="select">
            <option
              v-if="!DETECTION_TYPES.some((item) => item.value === draft.detectionType)"
              :value="draft.detectionType"
            >
              —
            </option>
            <option v-for="item in DETECTION_TYPES" :key="item.value" :value="item.value">
              {{ item.value }} {{ t(item.labelKey) }}
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('configAlarms.fieldSensitivity') }}</span>
          <input v-model.number="draft.sensitivity" class="input" type="number" min="0" max="100" />
          <span class="field-hint">0-100</span>
        </label>
        <label class="field">
          <span class="field-label">{{ t('configAlarms.fieldInterferenceSuppression') }}</span>
          <input v-model.number="draft.interferenceSuppression" class="input" type="number" min="0" />
        </label>
      </div>
    </section>

    <section class="group">
      <h4 class="group__title">{{ t('configAlarms.groupSpl') }}</h4>
      <div class="param-grid">
        <div class="param-row">
          <label class="toggle">
            <input v-model="draft.splOverloadEnabled" type="checkbox" />
            <span>{{ t('configAlarms.ruleOverload') }}</span>
          </label>
          <input
            v-model.number="draft.splOverloadThreshold"
            class="input"
            type="number"
            :disabled="!draft.splOverloadEnabled"
            :aria-label="t('configAlarms.fieldSplOverloadThreshold')"
          />
        </div>
        <div class="param-row">
          <label class="toggle">
            <input v-model="draft.splSurgeEnabled" type="checkbox" />
            <span>{{ t('configAlarms.ruleSurge') }}</span>
          </label>
          <input
            v-model.number="draft.splSurgeThreshold"
            class="input"
            type="number"
            :disabled="!draft.splSurgeEnabled"
            :aria-label="t('configAlarms.fieldSplSurgeThreshold')"
          />
        </div>
        <div class="param-row">
          <label class="toggle">
            <input v-model="draft.splDropEnabled" type="checkbox" />
            <span>{{ t('configAlarms.ruleDrop') }}</span>
          </label>
          <input
            v-model.number="draft.splDropThreshold"
            class="input"
            type="number"
            :disabled="!draft.splDropEnabled"
            :aria-label="t('configAlarms.fieldSplDropThreshold')"
          />
        </div>
        <div class="param-row">
          <label class="toggle">
            <input v-model="draft.splStabilityEnabled" type="checkbox" />
            <span>{{ t('configAlarms.ruleStability') }}</span>
          </label>
          <input
            v-model.number="draft.splStabilityThreshold"
            class="input"
            type="number"
            :disabled="!draft.splStabilityEnabled"
            :aria-label="t('configAlarms.fieldSplStabilityThreshold')"
          />
        </div>
      </div>
    </section>

    <section class="group">
      <h4 class="group__title">{{ t('configAlarms.groupMainFrequency') }}</h4>
      <div class="param-grid">
        <div class="param-row param-row--wide">
          <label class="toggle">
            <input v-model="draft.mainFrequencyEnabled" type="checkbox" />
            <span>{{ t('configAlarms.labelEnable') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('configAlarms.labelLower') }}</span>
            <input
              v-model.number="draft.mainFrequencyLower"
              class="input"
              type="number"
              :disabled="!draft.mainFrequencyEnabled"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('configAlarms.labelUpper') }}</span>
            <input
              v-model.number="draft.mainFrequencyUpper"
              class="input"
              type="number"
              :disabled="!draft.mainFrequencyEnabled"
            />
          </label>
        </div>
      </div>
    </section>

    <section class="group">
      <h4 class="group__title">{{ t('configAlarms.groupBandEnergy') }}</h4>
      <div class="param-grid">
        <div class="param-row param-row--wide">
          <label class="toggle">
            <input v-model="draft.bandEnergyRatioEnabled" type="checkbox" />
            <span>{{ t('configAlarms.labelEnable') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('configAlarms.labelLower') }}</span>
            <input
              v-model.number="draft.bandEnergyRatioLower"
              class="input"
              type="number"
              :disabled="!draft.bandEnergyRatioEnabled"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('configAlarms.labelUpper') }}</span>
            <input
              v-model.number="draft.bandEnergyRatioUpper"
              class="input"
              type="number"
              :disabled="!draft.bandEnergyRatioEnabled"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('configAlarms.labelThreshold') }}</span>
            <input
              v-model.number="draft.bandEnergyRatioThreshold"
              class="input"
              type="number"
              step="0.1"
              :disabled="!draft.bandEnergyRatioEnabled"
            />
          </label>
        </div>
      </div>
    </section>

    <template #footer>
      <button type="button" class="btn" @click="editorOpen = false">{{ t('common.cancel') }}</button>
      <button type="button" class="btn btn--primary" :disabled="savingForm" @click="submit">
        {{ savingForm ? t('configCommon.saving') : t('configAlarms.saveProfile') }}
      </button>
    </template>
  </AppModal>

  <!-- 删除确认 -->
  <AppModal
    :model-value="pendingDelete !== null"
    :title="t('configAlarms.deleteConfirmTitle')"
    width="460px"
    :close-on-overlay="false"
    @update:model-value="pendingDelete = null"
  >
    <p class="confirm-text">
      {{ t('configAlarms.deleteConfirmBody', { name: pendingDelete?.name || '—' }) }}
    </p>
    <p class="alert alert--warning confirm-warning" role="note">
      {{ t('configAlarms.deleteWarning') }}
    </p>
    <p v-if="deleteError" class="alert alert--danger confirm-warning" role="alert">
      {{ deleteError }}
    </p>
    <template #footer>
      <button type="button" class="btn" @click="pendingDelete = null">{{ t('common.cancel') }}</button>
      <button
        type="button"
        class="btn btn--danger"
        :disabled="deleting"
        data-autofocus
        @click="confirmDelete"
      >
        {{ deleting ? t('configAlarms.deleting') : t('devicesUi.confirmDelete') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.hint {
  font-size: 11.5px;
}

.notice {
  margin-top: var(--space-3);
}

.table-scroll {
  margin-top: var(--space-3);
}

.group {
  margin-bottom: var(--space-4);
}

.group__title {
  font-size: 12.5px;
  font-weight: 600;
  padding-bottom: 6px;
  margin-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border);
}

.group__hint {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  margin-bottom: var(--space-2);
}

.param-grid {
  display: grid;
  gap: var(--space-2) var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}

.param-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.param-row--wide {
  flex-wrap: wrap;
}

.param-row .input {
  max-width: 140px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 92px;
  cursor: pointer;
}

.confirm-text {
  font-size: 13px;
}

.confirm-warning {
  margin-top: var(--space-3);
}
</style>
