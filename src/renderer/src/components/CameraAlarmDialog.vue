<script setup lang="ts">
/**
 * 相机告警配置对话框（手册 §5.1.22 – §5.1.29）。
 *
 * ---------------------------------------------------------------------------
 * 它做什么
 * ---------------------------------------------------------------------------
 *   - 列出设备上的**告警策略**：名称、等级、灵敏度、检测周期、绑定的条件、
 *     启用状态（`Switch` 只是列表页的副本，启停请用 `CameraControlPanel`）；
 *   - 列出**告警条件**：dB / 主频 / 频谱比对三条判据的阈值、运算符、开关与逻辑；
 *   - 新建 / 修改 / 删除两者，并把「一个策略绑定一个条件」这条手册约束做成
 *     一个下拉框（而不是让操作员手填一个 id）。
 *
 * 职责边界（与 `CameraControlPanel` 不重叠）：
 *   本对话框管告警模型的**内容**（策略/条件的新建改删）；
 *   `CameraControlPanel` 管**运行状态**（检测模式、检测启停、哪条策略启用中、
 *   版本与维护）。启停策略需要走 `PUT /alarm_strategy_enable`，而且设备
 *   **同时只允许一条策略启用** —— 那是"检测能不能开始"的前提，所以放在那边。
 *   手册已启用的策略/条件**不能修改或删除**，必须先停用：这正是两个面板要并存的原因。
 *
 * ---------------------------------------------------------------------------
 * 它**不**做什么：替设备猜手册的歧义
 * ---------------------------------------------------------------------------
 * 手册在这一组接口上有若干处自相矛盾或缺失（键名 `diagosisn` vs `diagnosis`、
 * PUT 条件没有 `id`、等级读 0~3/写 1~4、`discharge_*` 只写不读）。
 * 客户端已把它们建模成具名候选；这个对话框把候选做成**可选的下拉框**并逐条列出
 * 「为什么未验证」，而不是选一个看起来合理的值然后当作事实。
 * 因此下面这些字符串（`unverified`、`ambiguity*`）是功能的一部分，不是说明文字。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE,
  DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE,
  emptyConditionDraft,
  emptyStrategyDraft,
  strategyDraftFrom,
  validateConditionDraft,
  validateStrategyDraft,
  type CameraAlarmConditionDraft,
  type CameraAlarmConditionIdStyle,
  type CameraAlarmDiagnosisKeyStyle,
  type CameraAlarmIssue,
  type CameraAlarmStrategyDraft
} from '@shared/domain/camera-alarm'
import type { Fa371AlarmCondition, Fa371AlarmStrategy } from '@shared/domain/fa371'
import { useSessionStore } from '@renderer/stores/session'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import AppModal from '@renderer/components/AppModal.vue'

const props = defineProps<{
  modelValue: boolean
  deviceId: string
  /**
   * 设备名。
   *
   * 原本用于那一行「设备 {name}：…」提示，产品要求删掉提示之后本组件不再渲染它。
   * 属性**保留**：调用点（`CameraVideoWall` / `MonitorView`）仍在传，删掉会让这次
   * 纯界面改动变成一个跨组件的接口改动；也留着给未来一个不叫"提示"的位置用。
   */
  deviceName: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const { t } = useI18n()
const session = useSessionStore()

type Tab = 'strategies' | 'conditions'
const tab = ref<Tab>('strategies')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const strategies = ref<Fa371AlarmStrategy[]>([])
const conditions = ref<Fa371AlarmCondition[]>([])

const strategyDraft = ref<CameraAlarmStrategyDraft | null>(null)
const conditionDraft = ref<CameraAlarmConditionDraft | null>(null)
const issues = ref<CameraAlarmIssue[]>([])

/** 手册歧义的两处候选：诊断说明键名、PUT 条件的目标标识方式。 */
const diagnosisKey = ref<CameraAlarmDiagnosisKeyStyle>(DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE)
const conditionIdStyle = ref<CameraAlarmConditionIdStyle>(DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE)

const canWrite = computed(() => session.isAdmin)
const isEditingStrategy = computed(() => (strategyDraft.value?.id ?? undefined) !== undefined)
const isEditingCondition = computed(() => (conditionDraft.value?.id ?? undefined) !== undefined)

const OPERATOR_KEYS: Record<number, string> = {
  0: 'cameraAlarmUi.operatorGt',
  1: 'cameraAlarmUi.operatorLt',
  2: 'cameraAlarmUi.operatorEq',
  3: 'cameraAlarmUi.operatorGe',
  4: 'cameraAlarmUi.operatorLe'
}

/**
 * 读取侧给的运算符是**稳定 KEY**（`greater_than` …）而不是数字，因为 §8.3 C28
 * 指出读取侧手册只写了符号、没给枚举。这里把它翻回文案；查不到就返回空串，
 * 让界面上只出现那个原始数字，而不是一个编出来的运算符名。
 */
const OPERATOR_LABEL_KEYS: Record<string, string> = {
  greater_than: 'cameraAlarmUi.operatorGt',
  less_than: 'cameraAlarmUi.operatorLt',
  equal: 'cameraAlarmUi.operatorEq',
  greater_or_equal: 'cameraAlarmUi.operatorGe',
  less_or_equal: 'cameraAlarmUi.operatorLe'
}

function operatorLabel(key: string | undefined): string {
  if (key === undefined) return ''
  const catalogueKey = OPERATOR_LABEL_KEYS[key]
  return catalogueKey ? t(catalogueKey) : ''
}

const DISCHARGE_OPTIONS: readonly number[] = [0, 1, 2, 4]
const DISCHARGE_KEYS: Record<number, string> = {
  0: 'cameraAlarmUi.dischargeCorona',
  1: 'cameraAlarmUi.dischargeSuspension',
  2: 'cameraAlarmUi.dischargeSurface',
  4: 'cameraAlarmUi.dischargeDischarge'
}

/** 策略行上的「条件」列：设备只回 id 和名称，两者都没有时如实留空。 */
function conditionLabel(strategy: Fa371AlarmStrategy): string {
  if (strategy.alarmConditionName) return strategy.alarmConditionName
  if (strategy.alarmConditionId !== undefined) return `#${strategy.alarmConditionId}`
  return '—'
}

/**
 * 启用状态。
 *
 * §8.3 C33：`Switch` **只出现在读取侧**，开放接口里没有启停端点。所以这里只显示，
 * 并且用一个专门的「未知」文案，而不是把 undefined 当成「未启用」——那会是一条
 * 凭空捏造的状态。
 */
function enabledLabel(strategy: Fa371AlarmStrategy): string {
  if (strategy.enabled === undefined) return t('cameraAlarmUi.stateUnknown')
  return strategy.enabled ? t('cameraAlarmUi.stateEnabled') : t('cameraAlarmUi.stateDisabled')
}

function enabledClass(strategy: Fa371AlarmStrategy): string {
  if (strategy.enabled === undefined) return 'badge'
  return strategy.enabled ? 'badge badge--success' : 'badge'
}

function issueFor(field: string): string {
  const issue = issues.value.find((candidate) => candidate.field === field)
  return issue ? t(issue.messageKey) : ''
}

async function load(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  loading.value = true
  error.value = ''
  try {
    const [strategyResult, conditionResult] = await Promise.all([
      callApi(() => window.api.cameraAlarms.listStrategies(deviceId)),
      callApi(() => window.api.cameraAlarms.listConditions(deviceId))
    ])
    if (!strategyResult.success) {
      error.value = resultMessage(strategyResult)
      strategies.value = []
    } else {
      strategies.value = unwrap(strategyResult)?.items ?? []
    }
    if (!conditionResult.success) {
      if (error.value === '') error.value = resultMessage(conditionResult)
      conditions.value = []
    } else {
      conditions.value = unwrap(conditionResult)?.items ?? []
    }
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.deviceId] as const,
  ([open, deviceId]) => {
    if (!open) return
    strategyDraft.value = null
    conditionDraft.value = null
    issues.value = []
    notice.value = ''
    error.value = ''
    if (deviceId !== '') void load()
  }
)

function startNewStrategy(): void {
  const draft = emptyStrategyDraft()
  // 只有一条条件时直接选中它：省一次点击，也避免「忘了选条件」这种必然失败。
  const only = conditions.value[0]
  if (conditions.value.length === 1 && only?.id !== undefined) draft.conditionId = only.id
  strategyDraft.value = draft
  issues.value = []
}

function startEditStrategy(strategy: Fa371AlarmStrategy): void {
  strategyDraft.value = strategyDraftFrom(strategy)
  issues.value = []
}

function startNewCondition(): void {
  conditionDraft.value = emptyConditionDraft()
  issues.value = []
}

function startEditCondition(condition: Fa371AlarmCondition): void {
  const base = emptyConditionDraft()
  conditionDraft.value = {
    ...base,
    ...(condition.id !== undefined ? { id: condition.id } : {}),
    ...(condition.name !== undefined ? { name: condition.name } : {}),
    ...(condition.decibelThreshold !== undefined ? { decibelThreshold: condition.decibelThreshold } : {}),
    ...(condition.dominantFreqThreshold !== undefined
      ? { dominantFreqThreshold: condition.dominantFreqThreshold }
      : {}),
    ...(condition.noiseComparisonFileId !== undefined
      ? { noiseComparisonFileId: condition.noiseComparisonFileId }
      : {}),
    ...(condition.ncSimilarityThreshold !== undefined
      ? { ncSimilarityThreshold: condition.ncSimilarityThreshold }
      : {}),
    ...(condition.notes !== undefined ? { notes: condition.notes } : {}),
    dbSwitch: condition.dbSwitch === true,
    dfSwitch: condition.dfSwitch === true,
    ncSwitch: condition.ncSwitch === true
  }
  issues.value = []
}

function cancelEdit(): void {
  strategyDraft.value = null
  conditionDraft.value = null
  issues.value = []
}

async function saveStrategy(): Promise<void> {
  const draft = strategyDraft.value
  const deviceId = props.deviceId
  if (!draft || deviceId === '' || saving.value) return
  issues.value = validateStrategyDraft(draft)
  if (issues.value.length > 0) return

  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await callApi(() =>
      draft.id === undefined
        ? window.api.cameraAlarms.createStrategy(deviceId, draft, diagnosisKey.value)
        : window.api.cameraAlarms.updateStrategy(deviceId, draft, diagnosisKey.value)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    strategies.value = unwrap(result)?.items ?? []
    strategyDraft.value = null
    notice.value = t('cameraAlarmUi.savedStrategy')
  } finally {
    saving.value = false
  }
}

async function saveCondition(): Promise<void> {
  const draft = conditionDraft.value
  const deviceId = props.deviceId
  if (!draft || deviceId === '' || saving.value) return
  issues.value = validateConditionDraft(draft)
  if (issues.value.length > 0) return

  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await callApi(() =>
      draft.id === undefined
        ? window.api.cameraAlarms.createCondition(deviceId, draft)
        : window.api.cameraAlarms.updateCondition(deviceId, draft, conditionIdStyle.value)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    conditions.value = unwrap(result)?.items ?? []
    conditionDraft.value = null
    notice.value = t('cameraAlarmUi.savedCondition')
  } finally {
    saving.value = false
  }
}

/** 删除策略：手册明确「已启用的策略不能修改」，删除同样受设备侧约束，故照实提示。 */
async function removeStrategy(strategy: Fa371AlarmStrategy): Promise<void> {
  const id = Number(strategy.id)
  if (!Number.isInteger(id) || id <= 0) {
    // 没有可用 id 时如实拒绝：发一个设备不认的形状只会换来一句含糊的设备错误。
    error.value = t('cameraAlarmUi.missingId')
    return
  }
  const name = strategy.name ?? `#${id}`
  if (!window.confirm(t('cameraAlarmUi.confirmDelete', { name }))) return
  const result = await callApi(() => window.api.cameraAlarms.deleteStrategies(props.deviceId, [id]))
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  strategies.value = unwrap(result)?.items ?? []
  notice.value = t('cameraAlarmUi.deleted')
}

async function removeCondition(condition: Fa371AlarmCondition): Promise<void> {
  const id = condition.id
  if (id === undefined || !Number.isInteger(id) || id <= 0) return
  const name = condition.name ?? `#${id}`
  if (!window.confirm(t('cameraAlarmUi.confirmDelete', { name }))) return
  const result = await callApi(() => window.api.cameraAlarms.deleteConditions(props.deviceId, [id]))
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  conditions.value = unwrap(result)?.items ?? []
  notice.value = t('cameraAlarmUi.deleted')
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="t('cameraAlarmUi.title')"
    width="880px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="!canWrite" class="alert alert--warning" role="note">{{ t('cameraAlarmUi.adminOnly') }}</p>

    <!--
      一行工具栏 = 视图切换器 + 新建 + 刷新。
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      产品原话：「告警策略，告警调节(条件)，新建告警放在同一行，右侧是一个刷新的 ICON」。

      **我对这句话的读法**（写在这里是为了让下一次改动可以便宜地纠正它）：
        - 这个对话框里「告警策略」与「告警条件」本来就是**两个互斥的视图**（同一份
          设备数据的两半：策略引用条件，一条策略只关联一个条件）。所以把它们放在
          同一行、左右紧挨着，就是**用这一行当视图切换器**（两个 `role=tab`），
          而不是把两张表上下堆在一屏里；
        - 「新建告警」= 当前视图对应的新建按钮：在策略页是「新建策略」，在条件页是
          「新建条件」。它是**一个**按钮，跟着切换器走，文案随当前视图变；
          （如果原意其实是两个按钮并排，改这一处即可 —— 下面的 `v-if` 换成两个按钮。）
        - 「刷新的 ICON 在最右」= 这一行的最右端，用一个只有图标的按钮，`margin-left:
          auto` 把它推到行尾；图标是内联 SVG 圆弧箭头（本项目不允许新增图标依赖）。
          它调用的是同一个 `load()`：**真的回设备重读**策略与条件两份列表，而不是
          重新渲染一遍内存里的旧数据。
    -->
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': tab === 'strategies' }"
          role="tab"
          :aria-selected="tab === 'strategies'"
          @click="tab = 'strategies'"
        >
          {{ t('cameraAlarmUi.tabStrategies') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': tab === 'conditions' }"
          role="tab"
          :aria-selected="tab === 'conditions'"
          @click="tab = 'conditions'"
        >
          {{ t('cameraAlarmUi.tabConditions') }}
        </button>
      </div>

      <button
        v-if="tab === 'strategies'"
        type="button"
        class="btn btn--sm btn--primary"
        :disabled="!canWrite || conditions.length === 0"
        @click="startNewStrategy"
      >
        {{ t('cameraAlarmUi.newStrategy') }}
      </button>
      <button
        v-else
        type="button"
        class="btn btn--sm btn--primary"
        :disabled="!canWrite"
        @click="startNewCondition"
      >
        {{ t('cameraAlarmUi.newCondition') }}
      </button>

      <button
        type="button"
        class="btn btn--sm btn--icon toolbar__refresh"
        :disabled="loading"
        :aria-label="t('cameraAlarmUi.refreshIcon')"
        :title="t('cameraAlarmUi.refreshIcon')"
        @click="load"
      >
        <!-- 内联 SVG：一个圆弧箭头（顺时针）。`aria-hidden` 是因为按钮本身已有名字。 -->
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 11a8 8 0 1 0-2.3 6.3" />
          <path d="M20 4v7h-7" />
        </svg>
      </button>
    </div>

    <p v-if="loading" class="muted" role="status">{{ t('cameraAlarmUi.loading') }}</p>
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <!-- ---- 告警策略 ---------------------------------------------------- -->
    <template v-if="tab === 'strategies'">
      <p v-if="conditions.length === 0" class="muted" role="note">
        {{ t('cameraAlarmUi.noConditions') }}
      </p>

      <table v-if="strategies.length > 0" class="table">
        <thead>
          <tr>
            <th>{{ t('cameraAlarmUi.fieldName') }}</th>
            <th>{{ t('cameraAlarmUi.fieldLevel') }}</th>
            <th>{{ t('cameraAlarmUi.fieldSensitivity') }}</th>
            <th>{{ t('cameraAlarmUi.fieldCycle') }}</th>
            <th>{{ t('cameraAlarmUi.fieldCondition') }}</th>
            <th>{{ t('cameraAlarmUi.stateEnabled') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="strategy in strategies" :key="strategy.id ?? strategy.name">
            <td>
              {{ strategy.name || '—' }}
              <span v-if="strategy.alias" class="muted"> · {{ strategy.alias }}</span>
            </td>
            <td>
              <!--
                * 读侧 0~3 / 写侧 1~4：显示设备**原样**给的值。读侧 0 没有对应的
                * 等级名称，所以只显示数字，不猜一个等级。
              -->
              {{ strategy.level ?? '—' }}
            </td>
            <td>{{ strategy.sensitivity ?? '—' }}</td>
            <td>{{ strategy.timeoutDuration ?? '—' }}</td>
            <td>{{ conditionLabel(strategy) }}</td>
            <td><span :class="enabledClass(strategy)">{{ enabledLabel(strategy) }}</span></td>
            <td class="nowrap">
              <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="startEditStrategy(strategy)">
                {{ t('cameraAlarmUi.edit') }}
              </button>
              <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="removeStrategy(strategy)">
                {{ t('cameraAlarmUi.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loading" class="muted">{{ t('cameraAlarmUi.empty') }}</p>

      <!-- 策略表单 -->
      <section v-if="strategyDraft" class="card form">
        <h4 class="section-title">
          {{ isEditingStrategy ? t('cameraAlarmUi.editStrategy') : t('cameraAlarmUi.newStrategy') }}
        </h4>
        <div class="grid">
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldName') }}</span>
            <input v-model="strategyDraft.name" type="text" maxlength="20" data-autofocus />
            <small v-if="issueFor('name')" class="issue">{{ issueFor('name') }}</small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldAlias') }}</span>
            <input v-model="strategyDraft.alias" type="text" maxlength="20" />
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldCondition') }}</span>
            <select v-model.number="strategyDraft.conditionId">
              <option :value="null" disabled>{{ t('cameraAlarmUi.selectCondition') }}</option>
              <option v-for="condition in conditions" :key="condition.id ?? condition.name" :value="condition.id">
                {{ condition.name || `#${condition.id}` }}
              </option>
            </select>
            <small v-if="issueFor('conditionId')" class="issue">{{ issueFor('conditionId') }}</small>
          </label>
          <label class="field">
            <span>
              {{ t('cameraAlarmUi.fieldLevel') }}
              <em class="badge" :title="t('cameraAlarmUi.ambiguityLevelNote')">
                {{ t('cameraAlarmUi.unverified') }}
              </em>
            </span>
            <select v-model.number="strategyDraft.level">
              <option v-for="level in [1, 2, 3, 4]" :key="level" :value="level">{{ level }}</option>
            </select>
            <small v-if="issueFor('level')" class="issue">{{ issueFor('level') }}</small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldCycle') }}</span>
            <input v-model.number="strategyDraft.timeoutDuration" type="number" min="1" max="30" />
            <small v-if="issueFor('timeoutDuration')" class="issue">{{ issueFor('timeoutDuration') }}</small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldSensitivity') }}</span>
            <input v-model.number="strategyDraft.sensitivity" type="number" min="0" max="1" step="0.05" />
            <small v-if="issueFor('sensitivity')" class="issue">{{ issueFor('sensitivity') }}</small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldInterval') }}</span>
            <input v-model.number="strategyDraft.intervalTime" type="number" min="0" />
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldTimes') }}</span>
            <input v-model.number="strategyDraft.times" type="number" min="0" />
          </label>
          <label class="field field--wide">
            <span>
              {{ t('cameraAlarmUi.fieldDiagnosis') }}
              <em class="badge" :title="t('cameraAlarmUi.ambiguityDiagnosisNote')">
                {{ t('cameraAlarmUi.unverified') }}
              </em>
            </span>
            <input v-model="strategyDraft.diagnosis" type="text" />
          </label>
          <label class="field field--wide">
            <span>{{ t('cameraAlarmUi.diagnosisKeyLabel') }}</span>
            <select v-model="diagnosisKey">
              <option value="diagosisn">{{ t('cameraAlarmUi.diagnosisKeyDiagosisn') }}</option>
              <option value="diagnosis">{{ t('cameraAlarmUi.diagnosisKeyDiagnosis') }}</option>
              <option value="both">{{ t('cameraAlarmUi.diagnosisKeyBoth') }}</option>
            </select>
          </label>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn--sm btn--primary" :disabled="saving" @click="saveStrategy">
            {{ t('cameraAlarmUi.save') }}
          </button>
          <button type="button" class="btn btn--sm" @click="cancelEdit">{{ t('cameraAlarmUi.cancel') }}</button>
        </div>
      </section>
    </template>

    <!-- ---- 告警条件 ---------------------------------------------------- -->
    <template v-else>
      <table v-if="conditions.length > 0" class="table">
        <thead>
          <tr>
            <th>{{ t('cameraAlarmUi.fieldName') }}</th>
            <th>{{ t('cameraAlarmUi.branchDecibel') }}</th>
            <th>{{ t('cameraAlarmUi.branchDominantFreq') }}</th>
            <th>{{ t('cameraAlarmUi.branchComparison') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="condition in conditions" :key="condition.id ?? condition.name">
            <td>{{ condition.name || '—' }} <span class="muted">#{{ condition.id ?? '—' }}</span></td>
            <td>
              {{ condition.dbSwitch ? '✓' : '✗' }} {{ condition.decibelThreshold ?? '—' }}
              {{ operatorLabel(condition.dbOperatorKey) }}
            </td>
            <td>
              {{ condition.dfSwitch ? '✓' : '✗' }} {{ condition.dominantFreqThreshold ?? '—' }}
              {{ operatorLabel(condition.dfOperatorKey) }}
            </td>
            <td>
              {{ condition.ncSwitch ? '✓' : '✗' }} {{ condition.ncSimilarityThreshold ?? '—' }}
              <span class="muted">files#{{ condition.noiseComparisonFileId ?? '—' }}</span>
            </td>
            <td class="nowrap">
              <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="startEditCondition(condition)">
                {{ t('cameraAlarmUi.edit') }}
              </button>
              <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="removeCondition(condition)">
                {{ t('cameraAlarmUi.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!loading" class="muted">{{ t('cameraAlarmUi.empty') }}</p>
      <p class="muted" role="note">{{ t('cameraAlarmUi.conditionHint') }}</p>

      <section v-if="conditionDraft" class="card form">
        <h4 class="section-title">
          {{ isEditingCondition ? t('cameraAlarmUi.editCondition') : t('cameraAlarmUi.newCondition') }}
        </h4>
        <label class="field">
          <span>{{ t('cameraAlarmUi.fieldName') }}</span>
          <input v-model="conditionDraft.name" type="text" maxlength="64" data-autofocus />
          <small v-if="issueFor('name')" class="issue">{{ issueFor('name') }}</small>
        </label>

        <fieldset class="branch">
          <legend>{{ t('cameraAlarmUi.branchDecibel') }}</legend>
          <label class="check">
            <input v-model="conditionDraft.dbSwitch" type="checkbox" />
            <span>{{ t('cameraAlarmUi.fieldDbSwitch') }}</span>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDbThreshold') }}</span>
            <input v-model.number="conditionDraft.decibelThreshold" type="number" step="0.1" />
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDbOperator') }}</span>
            <select v-model.number="conditionDraft.dbOperator">
              <option v-for="(labelKey, numericKey) in OPERATOR_KEYS" :key="numericKey" :value="Number(numericKey)">
                {{ t(labelKey) }}
              </option>
            </select>
          </label>
        </fieldset>

        <fieldset class="branch">
          <legend>{{ t('cameraAlarmUi.branchDominantFreq') }}</legend>
          <label class="check">
            <input v-model="conditionDraft.dfSwitch" type="checkbox" />
            <span>{{ t('cameraAlarmUi.fieldDfSwitch') }}</span>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDfThreshold') }}</span>
            <input v-model.number="conditionDraft.dominantFreqThreshold" type="number" step="1" />
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDfOperator') }}</span>
            <select v-model.number="conditionDraft.dfOperator">
              <option v-for="(labelKey, numericKey) in OPERATOR_KEYS" :key="numericKey" :value="Number(numericKey)">
                {{ t(labelKey) }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDfLogical') }}</span>
            <select v-model.number="conditionDraft.dfLogicalOperator">
              <option :value="0">{{ t('cameraAlarmUi.logicalOr') }}</option>
              <option :value="1">{{ t('cameraAlarmUi.logicalAnd') }}</option>
            </select>
          </label>
        </fieldset>

        <fieldset class="branch">
          <legend>{{ t('cameraAlarmUi.branchComparison') }}</legend>
          <label class="check">
            <input v-model="conditionDraft.ncSwitch" type="checkbox" />
            <span>{{ t('cameraAlarmUi.fieldNcSwitch') }}</span>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldNcFileId') }}</span>
            <input v-model.number="conditionDraft.noiseComparisonFileId" type="number" min="0" />
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldNcThreshold') }}</span>
            <input v-model.number="conditionDraft.ncSimilarityThreshold" type="number" min="0" max="1" step="0.05" />
            <small v-if="issueFor('ncSimilarityThreshold')" class="issue">
              {{ issueFor('ncSimilarityThreshold') }}
            </small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldNcOperator') }}</span>
            <select v-model.number="conditionDraft.ncOperator">
              <option :value="0">{{ t('cameraAlarmUi.operatorGt') }}</option>
              <option :value="1">{{ t('cameraAlarmUi.operatorLt') }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldNcLogical') }}</span>
            <select v-model.number="conditionDraft.ncLogicalOperator">
              <option :value="0">{{ t('cameraAlarmUi.logicalOr') }}</option>
              <option :value="1">{{ t('cameraAlarmUi.logicalAnd') }}</option>
            </select>
          </label>
        </fieldset>

        <fieldset class="branch">
          <legend>
            {{ t('cameraAlarmUi.branchDischarge') }}
            <em class="badge" :title="t('cameraAlarmUi.ambiguityDischargeNote')">
              {{ t('cameraAlarmUi.unverified') }}
            </em>
          </legend>
          <label class="check">
            <input v-model="conditionDraft.dischargeSwitch" type="checkbox" />
            <span>{{ t('cameraAlarmUi.fieldDischargeSwitch') }}</span>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDischargeType') }}</span>
            <select v-model.number="conditionDraft.dischargeType">
              <option v-for="value in DISCHARGE_OPTIONS" :key="value" :value="value">
                {{ t(DISCHARGE_KEYS[value] ?? 'cameraAlarmUi.unverified') }}
              </option>
            </select>
            <small v-if="issueFor('dischargeType')" class="issue">{{ issueFor('dischargeType') }}</small>
          </label>
          <label class="field">
            <span>{{ t('cameraAlarmUi.fieldDischargeLogical') }}</span>
            <select v-model.number="conditionDraft.dischargeLogicalOperator">
              <option :value="0">{{ t('cameraAlarmUi.logicalOr') }}</option>
              <option :value="1">{{ t('cameraAlarmUi.logicalAnd') }}</option>
            </select>
          </label>
        </fieldset>

        <small v-if="issueFor('switches')" class="issue">{{ issueFor('switches') }}</small>
        <label class="field">
          <span>{{ t('cameraAlarmUi.fieldNotes') }}</span>
          <input v-model="conditionDraft.notes" type="text" />
        </label>

        <label v-if="isEditingCondition" class="field">
          <span>{{ t('cameraAlarmUi.conditionIdStyleLabel') }}</span>
          <select v-model="conditionIdStyle">
            <option value="id">{{ t('cameraAlarmUi.conditionIdStyleId') }}</option>
            <option value="alarm_condition_id">{{ t('cameraAlarmUi.conditionIdStyleAlarmConditionId') }}</option>
            <option value="none">{{ t('cameraAlarmUi.conditionIdStyleNone') }}</option>
          </select>
        </label>

        <div class="btn-row">
          <button type="button" class="btn btn--sm btn--primary" :disabled="saving" @click="saveCondition">
            {{ t('cameraAlarmUi.save') }}
          </button>
          <button type="button" class="btn btn--sm" @click="cancelEdit">{{ t('cameraAlarmUi.cancel') }}</button>
        </div>
      </section>
    </template>

    <!--
      这里原本有一个「未验证项」小节，逐条列出手册的缺口与自相矛盾（8 条，合计约 600 字）。
      产品要求删除软件里的解释性内容，所以可见的清单去掉了；**手册歧义本身没有消失**：
      每条歧义仍然以 badge 的 `title` 形式挂在它影响的那个字段上（悬停可见），
      完整清单仍在 `CAMERA_ALARM_AMBIGUITIES`（`shared/domain/camera-alarm.ts`）里，
      连同规格书的条目号 —— 那是给维护者看的，不是给操作员看的。
    -->

    <template #footer>
      <button type="button" class="btn" @click="close">{{ t('cameraAlarmUi.cancel') }}</button>
    </template>
  </AppModal>
</template>

<style scoped>
/*
 * 一行工具栏：切换器 / 新建 在左，刷新图标被推到**最右**。
 *
 * `margin-left: auto` 是按产品要求「右侧是一个刷新的 ICON」的落地方式：它吃掉的
 * 是行内剩余空间，所以无论切换器与新建按钮后面还剩多少像素，刷新图标都贴在右边缘。
 */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 12px 0;
  flex-wrap: wrap;
}

.toolbar__refresh {
  margin-left: auto;
}

.tabs {
  display: inline-flex;
  gap: var(--space-2);
}

.table {
  width: 100%;
  margin: 8px 0;
  font-size: 12px;
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
}

.form {
  margin-top: 12px;
  padding: 12px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}

.field--wide {
  grid-column: 1 / -1;
}

.field input,
.field select {
  padding: 5px 6px;
  font: inherit;
  color: inherit;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.branch {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin: 10px 0;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.branch legend {
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
}

.issue {
  color: var(--color-danger, #c0392b);
}
</style>
