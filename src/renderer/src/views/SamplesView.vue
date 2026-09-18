<script setup lang="ts">
/**
 * 本地异常声纹样本库（业主 2026-09-16）。
 *
 * 这一页把 `docs/Ivms4200-UX-REFERENCE.md` §15.24/§15.25/§15.26 写下的口径**摆在界面上**：
 *
 *   - 每条样本带**两个维度**的标签：**设备类型**与**故障类型**（同一日追加的要求），
 *     两者各自记录**是谁给的**（设备弱标签 / 人工真值 / AI 候选）；
 *   - 不能进训练集的样本要**说出原因**（没故障类型 / 缺必报维度），而不是笼统地灰着；
 *   - 训练结果带着**局限**一起显示（只有一个类别、某些类别样本不足、被上限截断、
 *     以及训练集里混了几种设备类型 —— 那会让一个故障中心点变成几个现象的平均）；
 *   - 标签库有**专门的一处**维护：加、改名（连样本一起改）、删除（有人在用就拒绝）。
 *
 * 这一页不自己判断"能不能训练"：`SampleView.trainable` 是主进程按 `isTrainable()` 算好给的；
 * "这个标签能不能删"也是主进程数出来的（`SampleLabelEntry.usedBy`）。渲染层再判一次
 * 就会出现两个版本的口径。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SampleAiLabelOutcome, SampleExportResult, SampleView } from '@shared/ipc/contract'
import type {
  SampleLabelDimension,
  SampleLabelSource,
  SampleSource
} from '@shared/domain/sample-library'
import { SAMPLE_LABEL_DIMENSIONS, SAMPLE_LABEL_SOURCES } from '@shared/domain/sample-library'
import { EMPTY_VALUE, formatBytes, formatDateTime, formatNumber } from '@renderer/lib/format'
import { useSamplesStore } from '@renderer/stores/samples'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { useDevicesStore } from '@renderer/stores/devices'

const { t } = useI18n()
const samples = useSamplesStore()
const uiRefresh = useUiRefreshStore()
const devices = useDevicesStore()

type SourceFilter = '' | SampleSource
type LabelSourceFilter = '' | SampleLabelSource

const filters = ref<{
  source: SourceFilter
  faultSource: LabelSourceFilter
  equipmentSource: LabelSourceFilter
  faultLabel: string
  equipmentLabel: string
}>({
  source: '',
  faultSource: '',
  equipmentSource: '',
  faultLabel: '',
  equipmentLabel: ''
})

/**
 * 正在编辑标签的那一条（只允许一条，避免多点几行之后不知道自己在改哪个）。
 *
 * 两个维度**一份草稿**：界面上一次保存两个维度，所以草稿也只有一个"当前在改的样本"。
 * 空字符串在这里表示**清掉这一维**（`''` → `null`），不做"没改就不动"的推断 ——
 * 那需要记住打开时的值，而记住之后"我清空了它"就永远存不下去。
 */
const editingId = ref('')
const draftFault = ref('')
const draftEquipment = ref('')
const notice = ref('')

const rows = computed(() => samples.items)

function query(): Parameters<typeof samples.load>[0] {
  const value: Parameters<typeof samples.load>[0] = {}
  if (filters.value.source !== '') value.source = filters.value.source
  if (filters.value.faultSource !== '') value.faultLabelSource = filters.value.faultSource
  if (filters.value.equipmentSource !== '') value.equipmentLabelSource = filters.value.equipmentSource
  if (filters.value.faultLabel !== '') value.faultLabel = filters.value.faultLabel
  if (filters.value.equipmentLabel !== '') value.equipmentLabel = filters.value.equipmentLabel
  return value
}

const faultOptions = computed(() => samples.labelOptions('fault'))
const equipmentOptions = computed(() => samples.labelOptions('equipment'))


/**
 * 顶栏那颗唯一的刷新（业主 2026-09-19 更正第 4 条）：这一页自己那颗「刷新」已经删掉，
 * 重读数据由它触发 —— 调用的还是原来那个函数。
 */
watch(
  () => uiRefresh.tick,
  () => {
    void applyFilters()
  }
)

onMounted(async () => {
  if (devices.devices.length === 0) await devices.load()
  await samples.refresh(query())
  await loadAi()
})

async function applyFilters(): Promise<void> {
  await samples.load(query())
}

function startEdit(sample: SampleView): void {
  editingId.value = sample.id
  draftFault.value = sample.faultLabel ?? ''
  draftEquipment.value = sample.equipmentLabel ?? ''
}

function cancelEdit(): void {
  editingId.value = ''
  draftFault.value = ''
  draftEquipment.value = ''
}

/**
 * 保存两个维度。
 *
 * 人工改标一律**记成人工**：操作员确认过的标签就是真值，哪怕它和设备说的一样。
 * 空字符串传 `null`（清掉这一维），不传 `undefined` —— 界面上"我把这格清空了"是一个
 * 明确的意思，不是"我没动它"。
 */
async function saveLabels(sample: SampleView): Promise<void> {
  const fault = draftFault.value.trim()
  const equipment = draftEquipment.value.trim()
  const ok = await samples.setLabels(sample.id, {
    fault: fault === '' ? null : fault,
    equipment: equipment === '' ? null : equipment
  })
  if (ok) {
    notice.value = t('samplesUi.labelSaved')
    cancelEdit()
  }
}

/** 撤销某一维的标注（另一维不动：两个维度是两件事）。 */
async function clearLabel(sample: SampleView, dimension: SampleLabelDimension): Promise<void> {
  const ok = await samples.setLabel(sample.id, dimension, null, 'human')
  if (ok) {
    notice.value = t('samplesUi.labelCleared')
    cancelEdit()
  }
}

async function remove(sample: SampleView): Promise<void> {
  const ok = await samples.remove(sample.id)
  if (ok) notice.value = t('samplesUi.removed')
}

async function train(): Promise<void> {
  const report = await samples.train()
  if (report) notice.value = ''
}

/** 这一条为什么不能训练（界面照它说话，而不是只说"不可用"）。 */
function blockedReason(sample: SampleView): string {
  if (sample.trainable.usable) return ''
  if (sample.trainable.reason === 'no-label') return t('samplesUi.blockedNoLabel')
  const missing = (sample.trainable.missing ?? []).map((metric) => t(`metrics.${metric}`))
  return t('samplesUi.blockedMissingMetrics', { metrics: missing.join(' / ') })
}

/** 特征维度里"有值"的那几维，用于在列表上显示这一条的信息量。 */
function metricCount(sample: SampleView): number {
  return Object.keys(sample.metrics).length
}

/**
 * 三个动态键表。
 *
 * 写成显式映射而不是 `` t(`samplesUi.dimension_${dimension}`) ``：后者让"这些键到底存不存在"
 * 只能靠运行时才知道，而这里的键名同时是 i18n 审计脚本的证据（`scripts/i18n-orphans.cjs`），
 * 一个拼出来的键会被报成"没人用"。表本身也是文档：这两个维度、三种来源、三种来源各自
 * 有哪几个词。
 */
const DIMENSION_KEYS: Record<SampleLabelDimension, string> = {
  equipment: 'samplesUi.dimension_equipment',
  fault: 'samplesUi.dimension_fault'
}

const LABEL_SOURCE_KEYS: Record<SampleLabelSource, string> = {
  human: 'samplesUi.labelSource_human',
  device: 'samplesUi.labelSource_device',
  ai: 'samplesUi.labelSource_ai'
}

const SOURCE_KEYS: Record<SampleSource, string> = {
  alarm: 'samplesUi.source_alarm',
  manual: 'samplesUi.source_manual',
  import: 'samplesUi.source_import'
}

function sourceLabel(source: SampleSource): string {
  return t(SOURCE_KEYS[source])
}

function labelSourceLabel(source: SampleLabelSource): string {
  return t(LABEL_SOURCE_KEYS[source])
}

function dimensionLabel(dimension: SampleLabelDimension): string {
  return t(DIMENSION_KEYS[dimension])
}

const training = computed(() => samples.training)

/**
 * 标签库的维护草稿。
 *
 * 三个维度各自一份输入框：`newName` 是"加一条"，`renameId`/`renameName` 是"正在改名的那一条"。
 * 一次只允许改一条，理由与样本的标签编辑相同 —— 多点几下之后没人知道自己在改哪个。
 */
const labelDraft = ref<{ newName: Record<SampleLabelDimension, string>; renameId: string; renameName: string }>({
  newName: { equipment: '', fault: '' },
  renameId: '',
  renameName: ''
})

async function addLabel(dimension: SampleLabelDimension): Promise<void> {
  const name = labelDraft.value.newName[dimension].trim()
  if (name === '') return
  const result = await samples.addLabel(dimension, name)
  if (!result) return
  labelDraft.value.newName[dimension] = ''
  notice.value = result.created
    ? t('samplesUi.labelAdded', { name: result.name ?? name })
    : t('samplesUi.labelExists', { name: result.name ?? name })
}

function startRename(id: string, name: string): void {
  labelDraft.value.renameId = id
  labelDraft.value.renameName = name
}

function cancelRename(): void {
  labelDraft.value.renameId = ''
  labelDraft.value.renameName = ''
}

async function saveRename(): Promise<void> {
  const name = labelDraft.value.renameName.trim()
  if (name === '') return
  const result = await samples.renameLabel(labelDraft.value.renameId, name)
  if (!result) return
  if (!result.ok) {
    notice.value = t('samplesUi.labelRenameFailed')
    return
  }
  cancelRename()
  notice.value = t('samplesUi.labelRenamed', {
    name: result.name ?? name,
    count: result.affectedSamples ?? 0
  })
}

async function removeLabel(id: string, name: string): Promise<void> {
  const result = await samples.removeLabel(id)
  if (!result) return
  if (!result.ok) {
    notice.value =
      result.reason === 'in-use'
        ? t('samplesUi.labelInUse', { name, count: result.usedBy ?? 0 })
        : t('samplesUi.labelRemoveFailed')
    return
  }
  if (labelDraft.value.renameId === id) cancelRename()
  notice.value = t('samplesUi.labelRemoved', { name })
}

/**
 * AI 标注（可选）。
 *
 * 三件在这一屏必须成立的事：
 *   - **没配置就说没配置**：状态行照主进程给的 `blockedReason` 说话，按钮据此禁用；
 *   - **密钥从不回显**：只显示"已保存 / 未保存"，输入框留空即"不改动"；
 *   - **结果是候选**：文案里明说 AI 标签不进训练集、也不会覆盖人工标注。
 */
const aiDraft = ref({ enabled: false, endpoint: '', model: '', apiKey: '' })
const aiOutcome = ref<SampleAiLabelOutcome | null>(null)
const aiIncludeWeak = ref(false)
const aiSaved = ref(false)

async function loadAi(): Promise<void> {
  await samples.loadAiStatus()
  const status = samples.aiStatus
  if (status) {
    aiDraft.value = {
      enabled: status.enabled,
      endpoint: status.endpoint,
      model: status.model,
      apiKey: ''
    }
  }
}

async function saveAi(): Promise<void> {
  aiSaved.value = false
  // 输入框留空 = **不动**已存的密钥（`undefined`），而不是"清除"。
  const apiKey = aiDraft.value.apiKey === '' ? undefined : aiDraft.value.apiKey
  const ok = await samples.saveAiConfig({
    enabled: aiDraft.value.enabled,
    endpoint: aiDraft.value.endpoint,
    model: aiDraft.value.model,
    ...(apiKey === undefined ? {} : { apiKey })
  })
  if (ok) {
    aiSaved.value = true
    aiDraft.value.apiKey = ''
  }
}

async function clearAiKey(): Promise<void> {
  const ok = await samples.saveAiConfig({
    enabled: aiDraft.value.enabled,
    endpoint: aiDraft.value.endpoint,
    model: aiDraft.value.model,
    apiKey: null
  })
  if (ok) {
    aiSaved.value = true
    aiDraft.value.apiKey = ''
  }
}

async function runAiLabel(): Promise<void> {
  aiOutcome.value = null
  const outcome = await samples.aiLabel(
    aiIncludeWeak.value ? { includeWeakLabelled: true } : {}
  )
  if (outcome) aiOutcome.value = outcome
}

/** 状态行：**具体**原因，不是笼统的"不可用"。 */
const aiBlockedText = computed(() => {
  const status = samples.aiStatus
  if (!status) return t('samplesUi.aiUnknown')
  if (status.ready) return t('samplesUi.aiReady')
  switch (status.blockedReason) {
    case 'no-endpoint':
      return t('samplesUi.aiBlockedNoEndpoint')
    case 'bad-endpoint':
      return t('samplesUi.aiBlockedBadEndpoint')
    case 'no-model':
      return t('samplesUi.aiBlockedNoModel')
    default:
      return t('samplesUi.aiBlockedDisabled')
  }
})

/**
 * 导出选项与结果。
 *
 * 「只导出已标注」与「复制音频」都默认**关**：前者因为未标注的素材对某些流程仍然有用，
 * 后者因为一次导出可能是几百兆 —— 默认复制会把"我只想导个清单"变成一次磁盘写满。
 */
const exportOptions = ref({ copyAudio: false, onlyLabelled: false })
const exportResult = ref<SampleExportResult | null>(null)

async function exportDataset(): Promise<void> {
  const directory = await samples.pickExportDirectory()
  if (directory === null) return
  const result = await samples.exportDataset({
    directory,
    copyAudio: exportOptions.value.copyAudio,
    onlyLabelled: exportOptions.value.onlyLabelled
  })
  if (result) {
    exportResult.value = result
    notice.value = ''
  }
}
</script>

<template>
  <div class="page">
    <p v-if="samples.error" class="alert alert--danger" role="alert">{{ samples.error }}</p>
    <p v-else-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <!-- 统计：总数 / 能训练 / 两个维度各自的来源构成 -->
    <section class="card">
      <div class="sample-stats">
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.total }}</span>
          <span class="sample-stat__label">{{ t('samplesUi.statTotal') }}</span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.trainable }}</span>
          <span class="sample-stat__label">{{ t('samplesUi.statTrainable') }}</span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.faultSource.human }}</span>
          <span class="sample-stat__label">
            {{ t('samplesUi.statFaultHuman') }}
          </span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.equipmentSource.human }}</span>
          <span class="sample-stat__label">
            {{ t('samplesUi.statEquipmentHuman') }}
          </span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.faultSource.device }}</span>
          <span class="sample-stat__label">{{ t('samplesUi.statFaultDevice') }}</span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.faultSource.ai }}</span>
          <span class="sample-stat__label">{{ t('samplesUi.statFaultAi') }}</span>
        </div>
        <div class="sample-stat">
          <span class="sample-stat__value">{{ samples.stats.equipmentSource.unlabelled }}</span>
          <span class="sample-stat__label">{{ t('samplesUi.statEquipmentUnlabelled') }}</span>
        </div>
      </div>
    </section>

    <!-- 筛选 + 训练 -->
    <section class="card">
      <div class="filter-bar">
        <label class="field">
          <span class="field-label">{{ t('samplesUi.filterSource') }}</span>
          <select v-model="filters.source" class="select" @change="applyFilters">
            <option value="">{{ t('samplesUi.filterAll') }}</option>
            <option value="alarm">{{ t('samplesUi.source_alarm') }}</option>
            <option value="manual">{{ t('samplesUi.source_manual') }}</option>
            <option value="import">{{ t('samplesUi.source_import') }}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('samplesUi.filterEquipmentLabel') }}</span>
          <select v-model="filters.equipmentLabel" class="select" @change="applyFilters">
            <option value="">{{ t('samplesUi.filterAll') }}</option>
            <option v-for="option in equipmentOptions" :key="option.name" :value="option.name">
              {{ option.name }}（{{ option.usedBy }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('samplesUi.filterFaultLabel') }}</span>
          <select v-model="filters.faultLabel" class="select" @change="applyFilters">
            <option value="">{{ t('samplesUi.filterAll') }}</option>
            <option v-for="option in faultOptions" :key="option.name" :value="option.name">
              {{ option.name }}（{{ option.usedBy }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{{ t('samplesUi.filterLabelSource') }}</span>
          <select v-model="filters.faultSource" class="select" @change="applyFilters">
            <option value="">{{ t('samplesUi.filterAll') }}</option>
            <option v-for="value in SAMPLE_LABEL_SOURCES" :key="value" :value="value">
              {{ labelSourceLabel(value) }}
            </option>
          </select>
        </label>

        <div class="btn-row sample-actions">
          <button type="button" class="btn btn--primary" :disabled="samples.busy" @click="train">
            {{ t('samplesUi.trainButton') }}
          </button>
        </div>
      </div>
    </section>

    <!-- 标签库：两个维度各自的维护（加 / 改名 / 删除） -->
    <section class="card">
      <div class="section-header">
        <h3 class="section-title">{{ t('samplesUi.labelsTitle') }}</h3>
        <span class="muted label-hint">{{ t('samplesUi.labelsHint') }}</span>
      </div>

      <div class="label-library">
        <div v-for="dimension in SAMPLE_LABEL_DIMENSIONS" :key="dimension" class="label-column">
          <div class="label-column__head">{{ dimensionLabel(dimension) }}</div>

          <ul class="label-list">
            <li v-if="samples.labelEntries(dimension).length === 0" class="muted label-empty">
              {{ t('samplesUi.labelsEmpty') }}
            </li>
            <li v-for="entry in samples.labelEntries(dimension)" :key="entry.id" class="label-item">
              <template v-if="labelDraft.renameId === entry.id">
                <input v-model="labelDraft.renameName" class="input label-rename-input" type="text" />
                <button type="button" class="btn btn--sm" :disabled="samples.labelBusy" @click="saveRename">
                  {{ t('common.save') }}
                </button>
                <button type="button" class="btn btn--sm" @click="cancelRename">
                  {{ t('common.cancel') }}
                </button>
              </template>
              <template v-else>
                <span class="label-item__name">{{ entry.name }}</span>
                <span class="label-item__count muted">
                  {{ t('samplesUi.labelUsedBy', { count: entry.usedBy }) }}
                </span>
                <button
                  type="button"
                  class="btn btn--sm"
                  @click="startRename(entry.id, entry.name)"
                >
                  {{ t('samplesUi.labelRename') }}
                </button>
                <button
                  type="button"
                  class="btn btn--sm"
                  :disabled="samples.labelBusy"
                  @click="removeLabel(entry.id, entry.name)"
                >
                  {{ t('common.delete') }}
                </button>
              </template>
            </li>
          </ul>

          <div class="btn-row label-add">
            <input
              v-model="labelDraft.newName[dimension]"
              class="input"
              type="text"
              :placeholder="t('samplesUi.labelNewPlaceholder')"
              @keyup.enter="addLabel(dimension)"
            />
            <button
              type="button"
              class="btn btn--sm"
              :disabled="samples.labelBusy || labelDraft.newName[dimension].trim() === ''"
              @click="addLabel(dimension)"
            >
              {{ t('samplesUi.labelAdd') }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 训练结果：指标必须带着局限一起显示 -->
    <section v-if="training" class="card">
      <div class="section-header">
        <h3 class="section-title">{{ t('samplesUi.trainingTitle') }}</h3>
      </div>
      <dl class="kv">
        <div class="kv__item">
          <dt class="kv__label">{{ t('samplesUi.trainingSamples') }}</dt>
          <dd class="kv__value">{{ training.trained }} / {{ training.total }}</dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('samplesUi.trainingAccuracy') }}</dt>
          <dd class="kv__value">
            {{ training.degenerate ? EMPTY_VALUE : formatNumber(training.accuracy * 100, 1) + '%' }}
          </dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('samplesUi.trainingExcluded') }}</dt>
          <dd class="kv__value">
            {{ t('samplesUi.trainingExcludedValue', {
              noLabel: training.excluded.noLabel,
              missingMetrics: training.excluded.missingMetrics
            }) }}
          </dd>
        </div>
        <div class="kv__item">
          <dt class="kv__label">{{ t('samplesUi.trainingEquipment') }}</dt>
          <dd class="kv__value">
            {{ t('samplesUi.trainingEquipmentValue', {
              kinds: Object.keys(training.equipment.counts).length,
              unassigned: training.equipment.unassigned
            }) }}
          </dd>
        </div>
      </dl>

      <!-- 四条"这个数字不能照字面读"的说明，各说各的原因 -->
      <p v-if="training.degenerate" class="alert alert--warning" role="note">
        {{ t('samplesUi.trainingDegenerate') }}
      </p>
      <p v-if="training.unassessable.length > 0" class="alert alert--warning" role="note">
        {{ t('samplesUi.trainingUnassessable', { labels: training.unassessable.join(' / ') }) }}
      </p>
      <p v-if="training.equipment.mixed" class="alert alert--warning" role="note">
        {{ t('samplesUi.trainingMixedEquipment') }}
      </p>
      <p v-if="training.truncated" class="alert alert--warning" role="note">
        {{ t('samplesUi.trainingTruncated') }}
      </p>

      <div v-if="training.confusion.length > 0" class="sample-confusion">
        <span class="field-label">{{ t('samplesUi.trainingConfusion') }}</span>
        <ul class="sample-confusion__list">
          <li
            v-for="entry in training.confusion"
            :key="`${entry.expected}->${entry.predicted}`"
            :class="{ 'sample-confusion__item--wrong': entry.expected !== entry.predicted }"
          >
            {{ t('samplesUi.trainingConfusionRow', {
              expected: entry.expected,
              predicted: entry.predicted,
              count: entry.count
            }) }}
          </li>
        </ul>
      </div>
    </section>

    <!-- AI 标注（可选、可插拔）：没配置就照实说，绝不假装调用过 -->
    <section class="card">
      <div class="section-header">
        <h3 class="section-title">{{ t('samplesUi.aiTitle') }}</h3>
        <span class="ai-state" :class="samples.aiStatus?.ready ? 'ai-state--ok' : 'ai-state--blocked'">
          {{ aiBlockedText }}
        </span>
      </div>

      <div class="filter-bar">
        <label class="field checkbox-field">
          <input v-model="aiDraft.enabled" type="checkbox" />
          <span class="field-label">{{ t('samplesUi.aiEnabled') }}</span>
        </label>
        <label class="field ai-endpoint">
          <span class="field-label">{{ t('samplesUi.aiEndpoint') }}</span>
          <input
            v-model="aiDraft.endpoint"
            class="input"
            type="text"
            :placeholder="t('samplesUi.aiEndpointPlaceholder')"
          />
        </label>
        <label class="field ai-model">
          <span class="field-label">{{ t('samplesUi.aiModel') }}</span>
          <input
            v-model="aiDraft.model"
            class="input"
            type="text"
            :placeholder="t('samplesUi.aiModelPlaceholder')"
          />
        </label>
        <label class="field ai-key">
          <span class="field-label">
            {{ t('samplesUi.aiApiKey') }}
            <template v-if="samples.aiStatus?.apiKeyStored">（{{ t('samplesUi.aiKeyStored') }}）</template>
            <template v-else>（{{ t('samplesUi.aiKeyAbsent') }}）</template>
          </span>
          <input
            v-model="aiDraft.apiKey"
            class="input"
            type="password"
            autocomplete="off"
            :disabled="samples.aiStatus !== null && !samples.aiStatus.canStoreApiKey"
            :placeholder="t('samplesUi.aiApiKeyPlaceholder')"
          />
        </label>
      </div>

      <p v-if="samples.aiStatus && !samples.aiStatus.canStoreApiKey" class="ai-note muted">
        {{ t('samplesUi.aiNoEncryption') }}
      </p>

      <div class="btn-row ai-actions">
        <button type="button" class="btn" :disabled="samples.aiSaving" @click="saveAi">
          {{ t('samplesUi.aiSave') }}
        </button>
        <button
          v-if="samples.aiStatus?.apiKeyStored"
          type="button"
          class="btn btn--sm"
          :disabled="samples.aiSaving"
          @click="clearAiKey"
        >
          {{ t('samplesUi.aiClearKey') }}
        </button>
        <span v-if="aiSaved" class="muted ai-saved">{{ t('samplesUi.aiSaved') }}</span>
      </div>

      <div class="btn-row ai-actions">
        <label class="field checkbox-field">
          <input v-model="aiIncludeWeak" type="checkbox" />
          <span class="field-label">{{ t('samplesUi.aiIncludeWeak') }}</span>
        </label>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="samples.aiBusy || !samples.aiStatus?.ready"
          @click="runAiLabel"
        >
          {{ samples.aiBusy ? t('samplesUi.aiRunning') : t('samplesUi.aiRun') }}
        </button>
      </div>

      <p class="ai-note muted">{{ t('samplesUi.aiCandidateNote') }}</p>
      <p v-if="aiIncludeWeak" class="ai-note ai-note--warning">
        {{ t('samplesUi.aiOverwriteWarning') }}
      </p>

      <template v-if="aiOutcome">
        <p class="export-line" role="status">
          {{ t('samplesUi.aiOutcome', {
            considered: aiOutcome.considered,
            requested: aiOutcome.requested,
            labelled: aiOutcome.labelled
          }) }}
        </p>
        <p class="export-line muted">
          {{ t('samplesUi.aiOutcomeBreakdown', {
            human: aiOutcome.skippedHuman,
            weak: aiOutcome.skippedWeak,
            unresolved: aiOutcome.unresolved,
            failed: aiOutcome.failed
          }) }}
        </p>
        <ul v-if="aiOutcome.errors.length > 0" class="ai-errors">
          <li v-for="(message, index) in aiOutcome.errors" :key="index">{{ message }}</li>
        </ul>
      </template>
    </section>

    <!-- 导出：给**外部**二次训练用的清单（音频复制与否由操作员选） -->
    <section class="card">
      <div class="section-header">
        <h3 class="section-title">{{ t('samplesUi.exportTitle') }}</h3>
      </div>
      <div class="filter-bar">
        <label class="field checkbox-field">
          <input v-model="exportOptions.onlyLabelled" type="checkbox" />
          <span class="field-label">{{ t('samplesUi.exportOnlyLabelled') }}</span>
        </label>
        <label class="field checkbox-field">
          <input v-model="exportOptions.copyAudio" type="checkbox" />
          <span class="field-label">{{ t('samplesUi.exportCopyAudio') }}</span>
        </label>
        <div class="btn-row sample-actions">
          <button
            type="button"
            class="btn btn--primary"
            :disabled="samples.exporting"
            @click="exportDataset"
          >
            {{ samples.exporting ? t('samplesUi.exporting') : t('samplesUi.exportButton') }}
          </button>
        </div>
      </div>

      <template v-if="exportResult">
        <p class="export-line" role="status">
          {{ t('samplesUi.exportDone', {
            samples: exportResult.samples,
            labelled: exportResult.labelled
          }) }}
        </p>
        <p class="export-line muted export-path">{{ exportResult.directory }}</p>
        <p v-if="exportResult.skippedUnlabelled > 0" class="export-line muted">
          {{ t('samplesUi.exportSkipped', { count: exportResult.skippedUnlabelled }) }}
        </p>
        <p v-if="exportOptions.copyAudio" class="export-line muted">
          {{ t('samplesUi.exportAudio', {
            copied: exportResult.audioCopied,
            bytes: formatBytes(exportResult.audioBytes)
          }) }}
        </p>
        <p v-else class="export-line muted">{{ t('samplesUi.exportAudioSkipped') }}</p>
        <p v-if="exportResult.audioMissing > 0" class="export-line export-warning">
          {{ t('samplesUi.exportAudioMissing', { count: exportResult.audioMissing }) }}
        </p>
        <p class="export-line muted">{{ t('samplesUi.exportFiles') }}</p>
      </template>
    </section>

    <!-- 样本列表 -->
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('samplesUi.columnTime') }}</th>
            <th>{{ t('samplesUi.columnDevice') }}</th>
            <th>{{ t('samplesUi.columnChannel') }}</th>
            <th>{{ t('samplesUi.columnSource') }}</th>
            <th>{{ t('samplesUi.columnEquipment') }}</th>
            <th>{{ t('samplesUi.columnFault') }}</th>
            <th>{{ t('samplesUi.columnMetrics') }}</th>
            <th>{{ t('samplesUi.columnActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="8" class="table-empty">
              {{ samples.loading ? t('samplesUi.loading') : t('samplesUi.empty') }}
            </td>
          </tr>
          <tr v-for="sample in rows" :key="sample.id">
            <td class="nowrap">{{ formatDateTime(sample.capturedAt) }}</td>
            <td class="nowrap">{{ devices.nameById(sample.deviceId) }}</td>
            <td class="nowrap">CH{{ sample.channelId + 1 }}</td>
            <td class="nowrap">{{ sourceLabel(sample.source) }}</td>

            <!-- 设备类型 -->
            <td>
              <template v-if="editingId === sample.id">
                <!-- 可选可新建：datalist 里是标签库的现有写法，直接打新的就是"新建" -->
                <input
                  v-model="draftEquipment"
                  class="input sample-label-input"
                  type="text"
                  list="sample-equipment-options"
                />
              </template>
              <template v-else-if="sample.equipmentLabel">
                <span class="sample-label">{{ sample.equipmentLabel }}</span>
                <span class="badge" :class="`badge--label-${sample.equipmentLabelSource}`">
                  {{ sample.equipmentLabelSource ? labelSourceLabel(sample.equipmentLabelSource) : '' }}
                </span>
              </template>
              <span v-else class="muted">{{ t('samplesUi.unlabelled') }}</span>
            </td>

            <!-- 故障类型 -->
            <td>
              <template v-if="editingId === sample.id">
                <input
                  v-model="draftFault"
                  class="input sample-label-input"
                  type="text"
                  list="sample-fault-options"
                />
              </template>
              <template v-else-if="sample.faultLabel">
                <span class="sample-label">{{ sample.faultLabel }}</span>
                <span class="badge" :class="`badge--label-${sample.faultLabelSource}`">
                  {{ sample.faultLabelSource ? labelSourceLabel(sample.faultLabelSource) : '' }}
                </span>
              </template>
              <span v-else class="muted">{{ t('samplesUi.unlabelled') }}</span>
            </td>

            <td class="nowrap">
              <span :title="t('samplesUi.metricsHint')">
                {{ t('samplesUi.metricsCount', { count: metricCount(sample) }) }}
              </span>
              <span v-if="!sample.trainable.usable" class="sample-blocked" :title="blockedReason(sample)">
                {{ blockedReason(sample) }}
              </span>
            </td>
            <td class="nowrap">
              <div class="btn-row">
                <template v-if="editingId === sample.id">
                  <button type="button" class="btn btn--sm" :disabled="samples.busy" @click="saveLabels(sample)">
                    {{ t('common.save') }}
                  </button>
                  <button type="button" class="btn btn--sm" @click="cancelEdit">
                    {{ t('common.cancel') }}
                  </button>
                </template>
                <template v-else>
                  <button type="button" class="btn btn--sm" @click="startEdit(sample)">
                    {{ t('samplesUi.editLabel') }}
                  </button>
                  <button
                    v-if="sample.equipmentLabel"
                    type="button"
                    class="btn btn--sm"
                    @click="clearLabel(sample, 'equipment')"
                  >
                    {{ t('samplesUi.clearEquipment') }}
                  </button>
                  <button
                    v-if="sample.faultLabel"
                    type="button"
                    class="btn btn--sm"
                    @click="clearLabel(sample, 'fault')"
                  >
                    {{ t('samplesUi.clearFault') }}
                  </button>
                  <button type="button" class="btn btn--sm" @click="remove(sample)">
                    {{ t('common.delete') }}
                  </button>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 两个维度的候选清单：打标签时"选一个"或"打一个新的"，不需要先回标签库建好 -->
      <datalist id="sample-equipment-options">
        <option v-for="option in equipmentOptions" :key="option.name" :value="option.name" />
      </datalist>
      <datalist id="sample-fault-options">
        <option v-for="option in faultOptions" :key="option.name" :value="option.name" />
      </datalist>
    </div>

    <p class="pager">
      <span class="muted">{{ t('samplesUi.pagerRange', { shown: rows.length, total: samples.total }) }}</span>
    </p>
  </div>
</template>

<style scoped>
.sample-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
}

.sample-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 64px;
}

.sample-stat__value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sample-stat__label {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

.sample-actions {
  margin-left: auto;
}

/*
 * 标签来源的三个配色刻意**不同权重**：人工是真值（成功色），设备是弱标签（中性），
 * AI 是候选（警示色，等人工确认）。三色相同会让人以为它们可信度一样。
 */
.badge--label-human {
  background: var(--color-success-soft);
  color: var(--color-success);
  border: 1px solid var(--color-success-border);
}

.badge--label-device {
  background: var(--color-neutral-soft);
  color: var(--color-neutral);
  border: 1px solid var(--color-neutral-border);
}

.badge--label-ai {
  background: var(--color-warning-soft);
  color: var(--color-warning);
  border: 1px solid var(--color-warning-border);
}

.sample-label {
  margin-right: 6px;
}

.sample-label-input {
  width: 100%;
  margin-bottom: 4px;
}

/* 「为什么不能训练」不必抢眼，但必须读得到。 */
.sample-blocked {
  display: block;
  font-size: 11px;
  color: var(--color-warning);
}

/* 标签库：两个维度并排，各自一张清单。 */
.label-library {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.label-column__head {
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 6px;
}

.label-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.label-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}

.label-item__name {
  font-size: 12.5px;
}

.label-item__count {
  font-size: 11px;
  margin-right: auto;
}

.label-rename-input {
  max-width: 160px;
}

.label-empty {
  font-size: 11.5px;
}

.label-add {
  margin-top: 6px;
}

.label-hint {
  margin-left: auto;
  font-size: 11.5px;
}

.sample-confusion {
  margin-top: var(--space-3);
}

.sample-confusion__list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 11.5px;
}

/* 判错的行用危险色：混淆矩阵的价值就在这几行上。 */
.sample-confusion__item--wrong {
  color: var(--color-danger);
}

.pager {
  margin-top: var(--space-3);
  font-size: 12px;
}

.export-line {
  margin: 4px 0 0;
  font-size: 12px;
}

/* 导出目录是要被复制走的，用等宽字体并允许折行，别让人抄错。 */
.export-path {
  font-family: var(--font-mono, monospace);
  word-break: break-all;
}

.export-warning {
  color: var(--color-warning);
}

.checkbox-field {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

/* 状态行：可用了是中性色，"为什么不能用"才需要醒目。 */
.ai-state {
  font-size: 12px;
}

.ai-state--ok {
  color: var(--color-success);
}

.ai-state--blocked {
  color: var(--color-text-secondary);
}

.ai-endpoint {
  flex: 2 1 260px;
}

.ai-model {
  flex: 1 1 140px;
}

.ai-key {
  flex: 1 1 160px;
}

.ai-actions {
  margin-top: var(--space-2);
  align-items: center;
}

.ai-saved {
  font-size: 12px;
}

.ai-note {
  margin: 4px 0 0;
  font-size: 11.5px;
}

.ai-note--warning {
  color: var(--color-warning);
}

.ai-errors {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: var(--color-danger);
}
</style>
