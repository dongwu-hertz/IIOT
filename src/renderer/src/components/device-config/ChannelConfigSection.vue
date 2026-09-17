<script setup lang="ts">
/**
 * 通道配置 + 采样率（Phase 9）。
 *
 * THE ONE THING TO KNOW BEFORE EDITING THIS FILE
 * The device replaces the whole channel array on write: submitting one channel
 * resets the other seven (PROTOCOL-FINDINGS 5A.2). This table therefore looks
 * like a per-row form but is not one on the wire — one row's 保存 sends only that
 * row's changed fields to the main process, which re-reads the device and submits
 * all eight rows itself (see `stores/deviceConfig.ts`).
 *
 * Drafts are local: typing must not mutate store state, or a background refresh
 * would silently commit half-typed values into the object that gets written.
 */
import { computed, reactive, ref, watch } from 'vue'
import type { ChannelConfigView } from '@renderer/types/device-config'
import { SAMPLE_RATE_OPTIONS, useDeviceConfigStore } from '@renderer/stores/deviceConfig'
import { useI18n } from 'vue-i18n'
import {
  channelState,
  channelStateClass,
  channelStateHintKey,
  channelStateLabelKey,
  type ChannelState
} from '@renderer/lib/channelState'
import { channelLabel, formatSampleRate } from '@renderer/lib/format'
import AppModal from '@renderer/components/AppModal.vue'
import EmptyState from '@renderer/components/EmptyState.vue'

const props = defineProps<{ deviceId: string }>()

const { t } = useI18n()
const config = useDeviceConfigStore()

/**
 * Sensor types: 0 = microphone, 1 = conduction (`ChannelConfigView.sensorType`).
 *
 * Keys rather than labels so the option text follows a language change; the
 * names themselves come from the shared `domain.sensorType` block, which the
 * device detail page also uses, so one quantity has one name.
 */
const SENSOR_TYPES = [
  { value: 0, labelKey: 'domain.sensorType.microphone' },
  { value: 1, labelKey: 'domain.sensorType.conduction' }
] as const

interface RowDraft {
  name: string
  sensorType: number
  enabled: boolean
  alarmProfileId: number
}

/** A device channel paired with its local edit buffer. */
interface Row {
  channel: ChannelConfigView
  draft: RowDraft
  /**
   * 设备侧的通道状态。
   *
   * 变灰只表达实时状态，不锁定配置：未启用的通道仍然必须能被管理员改名、
   * 换传感器类型或重新打开（否则一旦关掉就再也开不回来了）。
   */
  state: ChannelState
}

/** Local drafts, keyed by channel index (0-based; displayed as CH1..CH8). */
const drafts = reactive<Record<number, RowDraft>>({})
const rowError = ref<Record<number, string>>({})
const rowNotice = ref<Record<number, string>>({})
const savingRow = ref<number | null>(null)
const channelsNotice = ref('')

/** Re-seed the drafts whenever the store receives a fresh authoritative list. */
function seedDrafts(): void {
  for (const key of Object.keys(drafts)) delete drafts[Number(key)]
  for (const channel of config.channels) {
    drafts[channel.channelIndex] = {
      name: channel.name,
      sensorType: channel.sensorType,
      enabled: channel.enabled,
      alarmProfileId: channel.alarmProfileId
    }
  }
}

watch(() => config.channels, seedDrafts, { immediate: true })

const rows = computed<Row[]>(() =>
  config.channels.flatMap((channel) => {
    const draft = drafts[channel.channelIndex]
    return draft ? [{ channel, draft, state: channelState(channel) }] : []
  })
)

/**
 * 整行变灰的悬停/读屏解释。
 *
 * 提示里只说状态，不说“不可编辑”：本表里的控件始终可用，写进“不可编辑”会让
 * 管理员以为设备拒绝修改，而真正的事实是那一路当前没开。
 */
function rowHint(row: Row): string {
  const key = channelStateHintKey(row.state)
  return key ? t(key) : ''
}

/** 状态徽标色调。只影响配色，不参与状态判定（判定在 lib/channelState.ts）。 */
function stateBadgeTone(state: ChannelState): string {
  if (state === 'enabled') return 'badge--success'
  if (state === 'unknown') return 'badge--warning'
  return ''
}

/** Alarm profiles selectable for a channel. A profile without an id cannot be bound. */
const alarmOptions = computed(() =>
  config.alarmProfiles.flatMap((profile) =>
    profile.id === undefined ? [] : [{ id: profile.id, name: profile.name }]
  )
)

function isDirty(row: Row): boolean {
  return (
    row.draft.name !== row.channel.name ||
    row.draft.sensorType !== row.channel.sensorType ||
    row.draft.enabled !== row.channel.enabled ||
    row.draft.alarmProfileId !== row.channel.alarmProfileId
  )
}

async function saveRow(row: Row): Promise<void> {
  const index = row.channel.channelIndex
  const trimmed = row.draft.name.trim()
  if (trimmed === '') {
    rowError.value = { ...rowError.value, [index]: t('configChannels.errNameRequired') }
    return
  }

  // ONLY the changed fields. The service merges them over a fresh device read and
  // submits the COMPLETE eight-channel array — see the file header.
  const patch: Partial<Omit<ChannelConfigView, 'channelIndex'>> = {}
  if (trimmed !== row.channel.name) patch.name = trimmed
  if (row.draft.sensorType !== row.channel.sensorType) patch.sensorType = row.draft.sensorType
  if (row.draft.enabled !== row.channel.enabled) patch.enabled = row.draft.enabled
  if (row.draft.alarmProfileId !== row.channel.alarmProfileId) {
    patch.alarmProfileId = row.draft.alarmProfileId
  }

  rowError.value = { ...rowError.value, [index]: '' }
  rowNotice.value = { ...rowNotice.value, [index]: '' }

  if (Object.keys(patch).length === 0) {
    rowNotice.value = { ...rowNotice.value, [index]: t('configCommon.noChanges') }
    return
  }

  savingRow.value = index
  const updated = await config.updateChannel(props.deviceId, index, patch)
  savingRow.value = null

  if (!updated) {
    rowError.value = { ...rowError.value, [index]: config.error || t('configChannels.saveFailed') }
    return
  }
  rowNotice.value = { ...rowNotice.value, [index]: t('configCommon.saved') }
}

async function reloadChannels(): Promise<void> {
  channelsNotice.value = ''
  const failure = await config.loadChannels(props.deviceId)
  channelsNotice.value = failure
  if (!failure) seedDrafts()
}

// ---------------------------------------------------------------------------
// 采样率
// ---------------------------------------------------------------------------

const rateDraft = ref<number | null>(null)
const rateConfirmOpen = ref(false)
const rateNotice = ref('')
const rateError = ref('')

watch(
  () => config.sampleRate,
  (value) => {
    rateDraft.value = value
  },
  { immediate: true }
)

/** True when the device reported a rate outside the three supported values. */
const rateIsUnlisted = computed(
  () => typeof rateDraft.value === 'number' && !SAMPLE_RATE_OPTIONS.includes(rateDraft.value)
)

const rateChanged = computed(
  () => typeof rateDraft.value === 'number' && rateDraft.value !== config.sampleRate
)

function askApplyRate(): void {
  rateError.value = ''
  rateNotice.value = ''
  // `typeof` rather than `=== null`: an emptied select can bind `undefined`, and
  // sending that to the device would be rejected as an unparseable rate.
  if (typeof rateDraft.value !== 'number' || !rateChanged.value) {
    rateError.value = t('configChannels.errRateSame')
    return
  }
  rateConfirmOpen.value = true
}

async function applyRate(): Promise<void> {
  const next = rateDraft.value
  if (typeof next !== 'number') return
  const applied = await config.setSampleRate(props.deviceId, next)
  rateConfirmOpen.value = false
  if (applied === undefined) {
    rateError.value = config.error || t('configChannels.errRateFailed')
    return
  }
  rateNotice.value = t('configChannels.rateApplied', { rate: formatSampleRate(applied) })
}
</script>

<template>
  <section class="card card--flush">
    <div class="section-header section-header--inset">
      <h3 class="section-title">{{ t('configChannels.title') }}</h3>
      <div class="btn-row">
        <span class="muted hint">{{ t('configChannels.countHint', { count: config.channels.length }) }}</span>
        <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reloadChannels">
          {{ t('configCommon.reload') }}
        </button>
      </div>
    </div>

    <p v-if="channelsNotice" class="alert alert--danger inset-alert" role="alert">
      {{ channelsNotice }}
    </p>

    <EmptyState
      v-if="rows.length === 0"
      :title="t('configChannels.unavailableTitle')"
    >
      <button type="button" class="btn btn--sm" :disabled="config.loading" @click="reloadChannels">
        {{ t('configCommon.reload') }}
      </button>
    </EmptyState>

    <div v-else class="table-wrap table-wrap--flush">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('configChannels.columnChannel') }}</th>
            <th>{{ t('configChannels.columnName') }}</th>
            <th>{{ t('configChannels.columnSensorType') }}</th>
            <th>{{ t('configChannels.columnEnabled') }}</th>
            <th>{{ t('configChannels.columnAlarmProfile') }}</th>
            <th>{{ t('configChannels.columnActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.channel.channelIndex"
            :class="channelStateClass(row.state)"
            :title="rowHint(row) || undefined"
          >
            <td class="nowrap mono">
              {{ channelLabel(row.channel.channelIndex) }}
              <!-- 状态徽标：开关只能表达“开/关”，未读到的状态必须单独说明。 -->
              <span
                class="badge channel-state__badge"
                :class="[channelStateClass(row.state), stateBadgeTone(row.state)]"
              >
                {{ t(channelStateLabelKey(row.state)) }}
              </span>
            </td>
            <td>
              <input
                v-model="row.draft.name"
                class="input input--cell"
                type="text"
                maxlength="32"
                spellcheck="false"
                :aria-label="t('configChannels.ariaName', { channel: channelLabel(row.channel.channelIndex) })"
              />
            </td>
            <td>
              <select
                v-model.number="row.draft.sensorType"
                class="select input--cell"
                :aria-label="t('configChannels.ariaSensorType', { channel: channelLabel(row.channel.channelIndex) })"
              >
                <option
                  v-if="!SENSOR_TYPES.some((item) => item.value === row.draft.sensorType)"
                  :value="row.draft.sensorType"
                >
                  —
                </option>
                <option v-for="item in SENSOR_TYPES" :key="item.value" :value="item.value">
                  {{ item.value }} {{ t(item.labelKey) }}
                </option>
              </select>
            </td>
            <td>
              <label class="toggle">
                <input
                  v-model="row.draft.enabled"
                  type="checkbox"
                  :aria-label="t('configChannels.ariaEnabled', { channel: channelLabel(row.channel.channelIndex) })"
                />
                <span>{{ row.draft.enabled ? t('configChannels.enableOn') : t('configChannels.enableOff') }}</span>
              </label>
            </td>
            <td>
              <select
                v-model.number="row.draft.alarmProfileId"
                class="select input--cell"
                :aria-label="t('configChannels.ariaAlarmProfile', { channel: channelLabel(row.channel.channelIndex) })"
              >
                <option :value="0">{{ t('configChannels.unbound') }}</option>
                <option v-for="profile in alarmOptions" :key="profile.id" :value="profile.id">
                  {{ profile.name }}
                </option>
                <option
                  v-if="
                    row.draft.alarmProfileId !== 0 &&
                    !alarmOptions.some((item) => item.id === row.draft.alarmProfileId)
                  "
                  :value="row.draft.alarmProfileId"
                >
                  —
                </option>
              </select>
            </td>
            <td>
              <div class="row-action">
                <button
                  type="button"
                  class="btn btn--sm"
                  :class="{ 'btn--primary': isDirty(row) }"
                  :disabled="savingRow !== null || !isDirty(row)"
                  @click="saveRow(row)"
                >
                  {{ savingRow === row.channel.channelIndex ? t('configCommon.saving') : t('common.save') }}
                </button>
                <span v-if="rowError[row.channel.channelIndex]" class="text-danger row-msg">
                  {{ rowError[row.channel.channelIndex] }}
                </span>
                <span v-else-if="rowNotice[row.channel.channelIndex]" class="text-success row-msg">
                  {{ rowNotice[row.channel.channelIndex] }}
                </span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="section-header">
      <h3 class="section-title">{{ t('configChannels.sampleRateTitle') }}</h3>
      <span class="muted hint">{{ t('configChannels.sampleRateCurrent', { rate: formatSampleRate(config.sampleRate) }) }}</span>
    </div>

    <p class="alert alert--warning" role="note">
      {{ t('configChannels.sampleRateWarningBefore') }}<strong>{{ t('configChannels.sampleRateWarningStrong') }}</strong>{{ t('configChannels.sampleRateWarningAfter') }}
    </p>

    <div class="rate-row">
      <label class="field rate-field">
        <span class="field-label">{{ t('configChannels.sampleRateLabel') }}</span>
        <select v-model.number="rateDraft" class="select">
          <!-- Placeholder for a rate outside the three supported values: shown, but
               not selectable, so it can never be submitted back as a change. -->
          <option v-if="rateIsUnlisted" :value="rateDraft" disabled>—</option>
          <option v-for="rate in SAMPLE_RATE_OPTIONS" :key="rate" :value="rate">
            {{ formatSampleRate(rate) }}（{{ rate }} Hz）
          </option>
        </select>
      </label>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="config.saving || !rateChanged"
        @click="askApplyRate"
      >
        {{ t('configChannels.applyRate') }}
      </button>
    </div>

    <p v-if="rateError" class="alert alert--danger" role="alert">{{ rateError }}</p>
    <p v-else-if="rateNotice" class="alert alert--success" role="status">{{ rateNotice }}</p>

    <AppModal
      v-model="rateConfirmOpen"
      :title="t('configChannels.confirmTitle')"
      width="460px"
      :close-on-overlay="false"
    >
      <p class="confirm-text">
        {{ t('configChannels.confirmFrom') }}
        <strong>{{ formatSampleRate(config.sampleRate) }}</strong>
        {{ t('configChannels.confirmTo') }}
        <strong>{{ formatSampleRate(rateDraft) }}</strong>
      </p>
      <p class="alert alert--warning confirm-warning" role="note">
        {{ t('configChannels.confirmBody') }}
      </p>
      <template #footer>
        <button type="button" class="btn" @click="rateConfirmOpen = false">{{ t('common.cancel') }}</button>
        <button
          type="button"
          class="btn btn--primary"
          data-autofocus
          :disabled="config.saving"
          @click="applyRate"
        >
          {{ config.saving ? t('configChannels.applying') : t('configChannels.confirmApply') }}
        </button>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.section-header--inset {
  padding: 12px 14px 10px;
  margin-bottom: 0;
  border-bottom: 1px solid var(--color-border);
}

.table-wrap--flush {
  border: none;
  border-radius: 0;
}

.inset-alert {
  margin: 10px 14px;
}

.input--cell {
  min-width: 96px;
  height: 28px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
}

/* --- 通道状态：未启用 / 状态未知 --------------------------------------- */

/*
 * 未启用的通道整行压暗，但行内控件必须继续可用：灰色表达的是“设备端这一路没开”，
 * 不是“禁止改配置”。所以这里绝不使用 pointer-events: none，也不禁用开关。
 */
tr.channel-state--disabled td {
  opacity: 0.55;
}

/* 悬停或把焦点放进单元格时恢复正常对比度，管理员得看清自己在改什么。 */
tr.channel-state--disabled:hover td,
tr.channel-state--disabled td:focus-within {
  opacity: 1;
}

/* 状态未知：警告底色，读完状态之前与“明确关闭”的灰明显不同。 */
tr.channel-state--unknown td {
  background: var(--color-warning-soft);
}

.channel-state__badge {
  margin-left: 6px;
}

.row-action {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
}

.row-msg {
  font-size: 11.5px;
}

.hint {
  font-size: 11.5px;
}

.rate-row {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  margin: var(--space-3) 0;
}

.rate-field {
  width: 220px;
}

.confirm-text {
  font-size: 13px;
}

.confirm-warning {
  margin-top: var(--space-3);
}
</style>
