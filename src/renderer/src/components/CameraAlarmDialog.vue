<script setup lang="ts">
/**
 * 相机告警配置对话框（手册 §5.1.22 – §5.1.29）。
 *
 * ---------------------------------------------------------------------------
 * 它做什么
 * ---------------------------------------------------------------------------
 *   - 列出设备上的**告警策略**，并通过 `GET/PUT /alarm_strategy_enable` 直接启停；
 *   - 列出**告警条件**：dB / 主频 / 频谱比对等判据的阈值、运算符、开关与逻辑；
 *   - 读取/编辑 `/system/scan_area`，并在本机 SQLite 为每个区域保存稳定 id 与名称；
 *   - 三部分在同一个 Alarm Configuration 页面内完成，不再把策略启用拆回 Camera Control。
 *
 * 职责边界（与 `CameraControlPanel` 不重叠）：
 *   本对话框管**告警配置**（策略 + 条件 + 区域 + 当前启用策略）；
 *   `CameraControlPanel` 只管相机**检测运行**（Detection Mode / Operation / 频带 / 阈值 /
 *   Start/Stop）。设备同时只允许一条策略启用，所以切换策略时服务层会先停旧策略再启新策略。
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
  emptyConditionDraft,
  emptyStrategyDraft,
  strategyDraftFrom,
  validateConditionDraft,
  validateStrategyDraft,
  type CameraAlarmConditionDraft,
  type CameraAlarmConditionIdStyle,
  type CameraAlarmIssue,
  type CameraAlarmStrategyDraft
} from '@shared/domain/camera-alarm'
import type { Fa371AlarmCondition, Fa371AlarmStrategy, Fa371ScanArea } from '@shared/domain/fa371'
import type { CameraLiveState } from '@shared/domain/camera-live'
import type {
  CameraAlarmRegionMetadata,
  CameraAlarmRegionMetadataInput
} from '@shared/domain/camera-control'
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
  /**
   * Realtime Monitoring opens the three alarm configuration types independently.
   * `all` is retained for the legacy video-wall entry point.
   */
  section?: 'conditions' | 'strategies' | 'regions' | 'all'
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  /**
   * 告警区域页签**采用了**（不是自己起的）一路正在播放的视频会话，弹窗现已关闭。
   * 对话框里的 <video> 接管过这一路（单观看者规则），父页面需要 reload 自己的
   * <video> 才能恢复出画面（`MonitorView` / `CameraVideoWall` 各自监听）。
   */
  (event: 'region-video-released'): void
}>()

const { t } = useI18n()
const session = useSessionStore()

// 业主 2026-09-23 第 4 条：告警调节（条件）、告警策略、告警区域**同页展示**，不再分页。
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')

const strategies = ref<Fa371AlarmStrategy[]>([])
const conditions = ref<Fa371AlarmCondition[]>([])

const strategyDraft = ref<CameraAlarmStrategyDraft | null>(null)
const conditionDraft = ref<CameraAlarmConditionDraft | null>(null)
const strategySensitivityText = ref('')
const spectrumSimilarityText = ref('')
const issues = ref<CameraAlarmIssue[]>([])

/**
 * 手册歧义的两处候选里，目标 id 方式仍由操作员在编辑条件时显式选择；
 * 诊断说明键名已改为服务层自动判定（读回验证），这里不再持有该状态。
 */
const conditionIdStyle = ref<CameraAlarmConditionIdStyle>(DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE)

const canWrite = computed(() => session.isAdmin)
const activeSection = computed(() => props.section ?? 'all')
const showConditions = computed(() => activeSection.value === 'all' || activeSection.value === 'conditions')
const showStrategies = computed(() => activeSection.value === 'all' || activeSection.value === 'strategies')
const showRegions = computed(() => activeSection.value === 'all' || activeSection.value === 'regions')
const modalTitle = computed(() => {
  if (activeSection.value === 'conditions') return t('cameraAlarmUi.tabConditions')
  if (activeSection.value === 'strategies') return t('cameraAlarmUi.tabStrategies')
  if (activeSection.value === 'regions') return t('cameraAlarmUi.tabRegions')
  return t('cameraAlarmUi.title')
})
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

/** 策略行上的「条件」列：设备只回 id 和名称，两者都没有时如实留空。 */
function conditionLabel(strategy: Fa371AlarmStrategy): string {
  if (strategy.alarmConditionName) return strategy.alarmConditionName
  if (strategy.alarmConditionId !== undefined) return `#${strategy.alarmConditionId}`
  return '—'
}

/**
 * 启用状态（业主 2026-09-23 第 1 条：启停进了本对话框）。
 *
 * 判定只认 `GET /alarm_strategy_enable` 的读数（`enabledIds`）——策略列表里的
 * `Switch` 只是副本；读不到 id 的策略如实显示「未知」。停用按钮常驻（停用与
 * 当前状态取反），已启用的高亮。
 */
function enabledLabel(strategy: Fa371AlarmStrategy): string {
  const raw = strategy.id
  if (raw === undefined) return t('cameraAlarmUi.stateUnknown')
  return strategyIsEnabled(strategy)
    ? t('cameraAlarmUi.stateEnabled')
    : t('cameraAlarmUi.stateDisabled')
}

function enabledClass(strategy: Fa371AlarmStrategy): string {
  const raw = strategy.id
  if (raw === undefined) return 'badge'
  return strategyIsEnabled(strategy) ? 'badge badge--success' : 'badge'
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
    /*
     * 相机 HTTP 栈在同时处理直播/检测时会偶发 401：这里一次只发一个请求，
     * 且 AUTH_FAILED 只重试一次。旧版本同时发两个请求，任何一个瞬时被拒都会
     * 把「认证失败，请检查用户名和密码」留在对话框里，而设备其实在线。
     */
    let strategyResult = await callApi(() => window.api.cameraAlarms.listStrategies(deviceId))
    if (!strategyResult.success && strategyResult.error?.code === 'AUTH_FAILED') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      strategyResult = await callApi(() => window.api.cameraAlarms.listStrategies(deviceId))
    }
    if (!strategyResult.success) {
      error.value = resultMessage(strategyResult)
      strategies.value = []
    } else {
      strategies.value = unwrap(strategyResult)?.items ?? []
    }

    let conditionResult = await callApi(() => window.api.cameraAlarms.listConditions(deviceId))
    if (!conditionResult.success && conditionResult.error?.code === 'AUTH_FAILED') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      conditionResult = await callApi(() => window.api.cameraAlarms.listConditions(deviceId))
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
/** 刷新按钮：四份数据一起回设备重读。 */
async function reloadAll(): Promise<void> {
  await load()
  await loadEnabledStrategies()
  await loadRegions()
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
    if (deviceId !== '') {
      void (async () => {
        await load()
        await loadEnabledStrategies()
        if (showRegions.value) {
          await loadRegions()
          await refreshRegionVideoState()
        }
      })()
    }
  }
)

// ---------------------------------------------------------------------------
// 启用中的告警策略（业主 2026-09-23 第 1 条：启停放进告警配置）
//
// 启停走 `PUT /alarm_strategy_enable`（设备同时只允许一条启用；启用另一条时服务层
// 会先停用当前那条）。「哪条启用」以该端点的读数为准（真机实测：响应项不一定带
// Switch 标记，出现在该端点即启用 —— 见 mappers.mapEnabledStrategyView）。
// ---------------------------------------------------------------------------

const enabledIds = ref<string[]>([])
const strategyBusyId = ref('')

async function loadEnabledStrategies(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  const result = await callApi(() => window.api.cameraControl.readEnabledStrategy(deviceId))
  if (!result.success) return
  enabledIds.value = unwrap(result)?.ids ?? []
}

/** 读取侧的 id 可能是字符串（§8.3 C21），写入口径只接受正整数。 */
function strategyWritableId(strategy: Fa371AlarmStrategy): number | undefined {
  const raw = strategy.id
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function strategyIsEnabled(strategy: Fa371AlarmStrategy): boolean {
  const raw = strategy.id
  return raw !== undefined && enabledIds.value.includes(String(raw))
}

async function toggleStrategyEnabled(strategy: Fa371AlarmStrategy): Promise<void> {
  const deviceId = props.deviceId
  const id = strategyWritableId(strategy)
  if (deviceId === '' || id === undefined || strategyBusyId.value !== '') return
  strategyBusyId.value = String(strategy.id)
  error.value = ''
  notice.value = ''
  try {
    const result = await callApi(() =>
      window.api.cameraControl.setStrategyEnabled(deviceId, id, !strategyIsEnabled(strategy))
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    notice.value = t('cameraAlarmUi.strategyEnableSaved')
  } finally {
    strategyBusyId.value = ''
    await load()
  await loadEnabledStrategies()
  }
}

function startNewStrategy(): void {
  conditionDraft.value = null
  const draft = emptyStrategyDraft()
  // 只有一条条件时直接选中它：省一次点击，也避免「忘了选条件」这种必然失败。
  const only = conditions.value[0]
  if (conditions.value.length === 1 && only?.id !== undefined) draft.conditionId = only.id
  strategyDraft.value = draft
  setStrategySensitivityText(draft.sensitivity)
  issues.value = []
}

function startEditStrategy(strategy: Fa371AlarmStrategy): void {
  conditionDraft.value = null
  strategyDraft.value = strategyDraftFrom(strategy)
  setStrategySensitivityText(strategyDraft.value.sensitivity)
  issues.value = []
}

function startNewCondition(): void {
  strategyDraft.value = null
  conditionDraft.value = emptyConditionDraft()
  setSpectrumSimilarityText(conditionDraft.value.ncSimilarityThreshold)
  issues.value = []
}

function startEditCondition(condition: Fa371AlarmCondition): void {
  strategyDraft.value = null
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
  setSpectrumSimilarityText(conditionDraft.value.ncSimilarityThreshold)
  issues.value = []
}

function cancelEdit(): void {
  strategyDraft.value = null
  conditionDraft.value = null
  issues.value = []
}

async function saveStrategy(showNotice = true): Promise<boolean> {
  const draft = strategyDraft.value
  const deviceId = props.deviceId
  if (!draft || deviceId === '' || saving.value) return false
  normaliseStrategySensitivity()
  issues.value = validateStrategyDraft(draft)
  if (issues.value.length > 0) return false

  saving.value = true
  error.value = ''
  if (showNotice) notice.value = ''
  try {
    const result = await callApi(() =>
      draft.id === undefined
        ? window.api.cameraAlarms.createStrategy(deviceId, draft)
        : window.api.cameraAlarms.updateStrategy(deviceId, draft)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    strategies.value = unwrap(result)?.items ?? []
    strategyDraft.value = null
    if (showNotice) notice.value = t('cameraAlarmUi.savedStrategy')
    return true
  } finally {
    saving.value = false
  }
}

async function saveCondition(showNotice = true): Promise<boolean> {
  const draft = conditionDraft.value
  const deviceId = props.deviceId
  if (!draft || deviceId === '' || saving.value) return false
  normaliseSpectrumSimilarity()
  issues.value = validateConditionDraft(draft)
  if (issues.value.length > 0) return false

  saving.value = true
  error.value = ''
  if (showNotice) notice.value = ''
  try {
    const result = await callApi(() =>
      draft.id === undefined
        ? window.api.cameraAlarms.createCondition(deviceId, draft)
        : window.api.cameraAlarms.updateCondition(deviceId, draft, conditionIdStyle.value)
    )
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    conditions.value = unwrap(result)?.items ?? []
    conditionDraft.value = null
    if (showNotice) notice.value = t('cameraAlarmUi.savedCondition')
    return true
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

  error.value = ''
  notice.value = ''

  // A condition can be referenced by an enabled strategy. The device requires that
  // strategy to be stopped first, so deletion performs that prerequisite for the user.
  const linkedEnabled = strategies.value.filter((strategy) =>
    Number(strategy.alarmConditionId) === id && strategyIsEnabled(strategy)
  )
  for (const strategy of linkedEnabled) {
    const strategyId = strategyWritableId(strategy)
    if (strategyId === undefined) {
      error.value = t('cameraAlarmUi.missingId')
      return
    }
    const disableResult = await callApi(() =>
      window.api.cameraControl.setStrategyEnabled(props.deviceId, strategyId, false)
    )
    if (!disableResult.success) {
      error.value = resultMessage(disableResult)
      return
    }
  }

  if (linkedEnabled.length > 0) await loadEnabledStrategies()

  const result = await callApi(() => window.api.cameraAlarms.deleteConditions(props.deviceId, [id]))
  if (!result.success) {
    error.value = resultMessage(result)
    return
  }
  conditions.value = unwrap(result)?.items ?? []
  await load()
  await loadEnabledStrategies()
  notice.value = linkedEnabled.length > 0
    ? t('cameraAlarmUi.deletedConditionAfterDisable')
    : t('cameraAlarmUi.deleted')
}

function close(): void {
  emit('update:modelValue', false)
}

// ---------------------------------------------------------------------------
// 告警区域（= 设备的检测区域，/system/scan_area）
//
// 业主 2026-09-22 第 1 条：告警配置里要能做告警区域选择。这里与实时监测页视频上
// 的框选编辑器**读写同一份设备数据**；对话框里没有视频画面，所以用百分比坐标
// （0–100，相对视频画面）编辑，写设备时按参考分辨率 1920×1080 换算成像素 ——
// 与 `MonitorView.scanAreaReferenceSize()` 在拿不到视频尺寸时的口径一致。
// ---------------------------------------------------------------------------

interface RegionRow {
  /** 软件侧稳定 id；与数组下标无关。 */
  id: string
  /** 操作员可读名称；与矩形一起持久化到本机 SQLite。 */
  name: string
  /** 百分比坐标（0–100，相对视频画面）。 */
  x: number
  y: number
  width: number
  height: number
}

function newRegionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `region-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function defaultRegionName(index: number): string {
  return t('cameraAlarmUi.regionDefaultName', { n: index + 1 })
}

const REGION_REFERENCE_WIDTH = 1920
const REGION_REFERENCE_HEIGHT = 1080
const REGION_MATCH_TOLERANCE_PX = 12

const regionRows = ref<RegionRow[]>([])
const regionMetadata = ref<CameraAlarmRegionMetadata[]>([])
const selectedRegionId = ref('')
const selectedRegion = computed(() =>
  regionRows.value.find((row) => row.id === selectedRegionId.value) ?? null
)
const regionsBusy = ref(false)
const regionsError = ref('')
const regionsNotice = ref('')
const regionsLoadedDeviceId = ref('')
const regionsBaseline = ref('')

function serialiseRegionRows(rows: readonly RegionRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    name: row.name,
    x: round1(row.x),
    y: round1(row.y),
    width: round1(row.width),
    height: round1(row.height)
  })))
}

const regionsDirty = computed(() =>
  regionsLoadedDeviceId.value === props.deviceId &&
  serialiseRegionRows(regionRows.value) !== regionsBaseline.value
)

const hasPendingChanges = computed(() =>
  strategyDraft.value !== null || conditionDraft.value !== null || regionsDirty.value
)

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Operator-entered 0..1 values are always normalised to two decimal places. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function fixed2(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—'
}

function setStrategySensitivityText(value: number): void {
  strategySensitivityText.value = Number.isFinite(value) ? value.toFixed(2) : ''
}

function setSpectrumSimilarityText(value: number): void {
  spectrumSimilarityText.value = Number.isFinite(value) ? value.toFixed(2) : ''
}

function normaliseStrategySensitivity(): void {
  if (!strategyDraft.value) return
  const parsed = Number(strategySensitivityText.value.trim())
  strategyDraft.value.sensitivity = Number.isFinite(parsed) ? round2(parsed) : Number.NaN
  if (Number.isFinite(parsed)) setStrategySensitivityText(strategyDraft.value.sensitivity)
}

function normaliseSpectrumSimilarity(): void {
  if (!conditionDraft.value) return
  const parsed = Number(spectrumSimilarityText.value.trim())
  conditionDraft.value.ncSimilarityThreshold = Number.isFinite(parsed) ? round2(parsed) : Number.NaN
  if (Number.isFinite(parsed)) setSpectrumSimilarityText(conditionDraft.value.ncSimilarityThreshold)
}

function geometryKey(input: {
  leftTopX?: number
  leftTopY?: number
  width?: number
  height?: number
}): string {
  return [input.leftTopX, input.leftTopY, input.width, input.height]
    .map((value) => Math.round(Number(value ?? -1)))
    .join(':')
}

function geometryDistance(
  meta: CameraAlarmRegionMetadata,
  area: { leftTopX?: number; leftTopY?: number; width?: number; height?: number }
): number {
  return Math.max(
    Math.abs(meta.leftTopX - Number(area.leftTopX ?? -99999)),
    Math.abs(meta.leftTopY - Number(area.leftTopY ?? -99999)),
    Math.abs(meta.width - Number(area.width ?? -99999)),
    Math.abs(meta.height - Number(area.height ?? -99999))
  )
}

/**
 * Device geometry is authoritative; local metadata contributes only stable id + name.
 * Match by geometry first, then by current index within a small read-back tolerance.
 */
function scanAreaToRows(
  area: Fa371ScanArea | null | undefined,
  metadata: readonly CameraAlarmRegionMetadata[] = regionMetadata.value
): RegionRow[] {
  if (!area) return []

  const exact = new Map(metadata.map((item) => [geometryKey(item), item]))
  const usedIds = new Set<string>()
  const activeAreas = area.areas.filter((item) => item.drawStatus !== 0)

  return activeAreas.flatMap((item, index) => {
    if (
      item.leftTopX === undefined || item.leftTopY === undefined ||
      item.width === undefined || item.height === undefined
    ) return []

    let match = exact.get(geometryKey(item))
    if (match && usedIds.has(match.id)) match = undefined

    if (!match) {
      const byIndex = metadata.find((candidate) =>
        !usedIds.has(candidate.id) &&
        candidate.areaIndex === index &&
        geometryDistance(candidate, item) <= REGION_MATCH_TOLERANCE_PX
      )
      if (byIndex) match = byIndex
    }

    if (match) usedIds.add(match.id)
    return [{
      id: match?.id ?? newRegionId(),
      name: match?.name.trim() || defaultRegionName(index),
      x: round1((item.leftTopX / REGION_REFERENCE_WIDTH) * 100),
      y: round1((item.leftTopY / REGION_REFERENCE_HEIGHT) * 100),
      width: round1((item.width / REGION_REFERENCE_WIDTH) * 100),
      height: round1((item.height / REGION_REFERENCE_HEIGHT) * 100)
    }]
  })
}

async function loadRegions(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  regionsBusy.value = true
  regionsError.value = ''
  regionsNotice.value = ''
  selectedRegionId.value = ''
  try {
    const [scanResult, metadataResult] = await Promise.all([
      callApi(() => window.api.cameraControl.readScanArea(deviceId)),
      callApi(() => window.api.cameraControl.readRegionMetadata(deviceId))
    ])
    if (!scanResult.success) {
      regionRows.value = []
      regionsBaseline.value = serialiseRegionRows([])
      regionsError.value = resultMessage(scanResult)
      return
    }

    const metadata = metadataResult.success ? (unwrap(metadataResult) ?? []) : []
    regionMetadata.value = metadata
    regionRows.value = scanAreaToRows(unwrap(scanResult), metadata)
    regionsLoadedDeviceId.value = deviceId
    regionsBaseline.value = serialiseRegionRows(regionRows.value)
    if (!metadataResult.success) regionsError.value = resultMessage(metadataResult)
  } finally {
    regionsBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// 区域页签里的实时视频 + 框选（业主 2026-09-23：告警区域要能在视频画面上直接框选）
//
// 会话语义必须和「一路会话一个观看者」一致（`RtspStreamService`）：
//   - 页面上**已有**会话在播（监测页/画面墙）→ 直接采用它的回环地址；对话框里
//     的 <video> 连接会按既有规则接管这一路（页面那颗在弹窗背后停住）；
//   - 没有会话 → 由对话框自己 start 一路，**关闭时由对话框负责停掉**；
//   - 采用（而非拥有）的会话在弹窗关闭时交给父页面重连：父组件监听
//     `region-video-released` 事件后 reload 自己的 <video>。
// ---------------------------------------------------------------------------

const regionVideo = ref<CameraLiveState | null>(null)
const regionVideoBusy = ref(false)
/** 这一路视频是不是对话框自己 start 的（是 → 关闭时归对话框停）。 */
let regionVideoOwned = false
const regionDrawMode = ref(false)
const regionDraft = ref<RegionRow | null>(null)
const regionStageEl = ref<HTMLDivElement | null>(null)
let regionDragStart: { x: number; y: number } | null = null

const regionVideoUrl = computed(() =>
  regionVideo.value?.status === 'starting' || regionVideo.value?.status === 'playing'
    ? (regionVideo.value.url ?? '')
    : ''
)

async function refreshRegionVideoState(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '') return
  const result = await callApi(() => window.api.cameraLive.state(deviceId))
  regionVideo.value = result.success ? (unwrap(result)?.[0] ?? null) : null
}

/** 切到「告警区域」页签时按需加载区域数据 + 视频会话状态；离开页签就收视频。 */
// （2026-09-23 同页化之后没有页签切换了：打开弹窗统一加载、关闭弹窗统一收视频，
// 见 modelValue 的 watch 与 releaseRegionVideo。）

async function startRegionVideo(): Promise<void> {
  const deviceId = props.deviceId
  if (deviceId === '' || regionVideoBusy.value) return
  regionVideoBusy.value = true
  regionsError.value = ''
  try {
    const result = await callApi(() => window.api.cameraLive.start({ deviceId }))
    if (!result.success) {
      regionsError.value = resultMessage(result)
      return
    }
    regionVideo.value = unwrap(result) ?? null
    regionVideoOwned = true
  } finally {
    regionVideoBusy.value = false
  }
}

/** 关闭弹窗：自己起的那路归自己停；采用的那路交给父页面重连。 */
function releaseRegionVideo(adopted: boolean): void {
  if (regionVideoOwned) {
    const deviceId = props.deviceId
    regionVideoOwned = false
    if (deviceId !== '') void callApi(() => window.api.cameraLive.stop(deviceId))
  } else if (adopted && regionVideo.value !== null) {
    emit('region-video-released')
  }
  regionVideo.value = null
  regionDrawMode.value = false
  regionDraft.value = null
}

/** 弹窗关闭（任何途径）：视频收线。 */
watch(
  () => props.modelValue,
  (open, wasOpen) => {
    if (wasOpen && !open) releaseRegionVideo(true)
  }
)

// -- 框选（归一化坐标，与 `MonitorView` 检测区编辑器同一套数学） ----------------

function regionStagePoint(event: PointerEvent): { x: number; y: number } | null {
  const stage = regionStageEl.value
  if (!stage) return null
  const rect = stage.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  // RegionRow uses 0..100 percentages everywhere (table, CSS and device conversion).
  return {
    x: Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
  }
}

function beginRegionDraw(event: PointerEvent): void {
  if (!regionDrawMode.value) return
  const point = regionStagePoint(event)
  if (!point) return
  event.preventDefault()
  regionDragStart = point
  regionDraft.value = { id: 'draft', name: '', x: point.x, y: point.y, width: 0, height: 0 }
  regionStageEl.value?.setPointerCapture?.(event.pointerId)
}

function updateRegionDraw(event: PointerEvent): void {
  if (!regionDrawMode.value || !regionDragStart || !regionDraft.value) return
  const point = regionStagePoint(event)
  if (!point) return
  regionDraft.value = {
    id: 'draft',
    name: '',
    x: Math.min(regionDragStart.x, point.x),
    y: Math.min(regionDragStart.y, point.y),
    width: Math.abs(point.x - regionDragStart.x),
    height: Math.abs(point.y - regionDragStart.y)
  }
}

function finishRegionDraw(event: PointerEvent): void {
  if (!regionDragStart || !regionDraft.value) return
  updateRegionDraw(event)
  const draft = regionDraft.value
  if (draft.width >= 1.5 && draft.height >= 1.5) {
    const row: RegionRow = {
      ...draft,
      id: newRegionId(),
      name: defaultRegionName(regionRows.value.length)
    }
    regionRows.value.push(row)
    selectedRegionId.value = row.id
    regionsNotice.value = ''
  }
  regionDragStart = null
  regionDraft.value = null
  regionStageEl.value?.releasePointerCapture?.(event.pointerId)
}

function addRegion(): void {
  const offset = Math.min(50, 10 + regionRows.value.length * 3)
  const row: RegionRow = {
    id: newRegionId(),
    name: defaultRegionName(regionRows.value.length),
    x: offset,
    y: offset,
    width: 20,
    height: 20
  }
  regionRows.value.push(row)
  selectedRegionId.value = row.id
  regionsNotice.value = ''
}

function selectRegion(id: string): void {
  selectedRegionId.value = id
}

function clearRegionSelection(): void {
  selectedRegionId.value = ''
}

function removeRegion(row: RegionRow): void {
  regionRows.value = regionRows.value.filter((item) => item.id !== row.id)
  if (selectedRegionId.value === row.id) selectedRegionId.value = ''
  regionsNotice.value = ''
}

function removeSelectedRegion(): void {
  if (!selectedRegion.value) return
  removeRegion(selectedRegion.value)
}

/** Clear all changes the draft only; the camera and SQLite are untouched until Save. */
function clearRegions(): void {
  regionRows.value = []
  selectedRegionId.value = ''
  regionsNotice.value = t('cameraAlarmUi.regionCleared')
}

function regionRowsValid(): boolean {
  return regionRows.value.every((row) =>
    row.name.trim().length > 0 && row.name.trim().length <= 64 &&
    row.x >= 0 && row.x <= 100 && row.y >= 0 && row.y <= 100 &&
    row.width > 0 && row.height > 0 &&
    row.x + row.width <= 100.5 && row.y + row.height <= 100.5
  )
}

function metadataInputsFromReadBack(
  after: Fa371ScanArea,
  drafts: readonly RegionRow[]
): CameraAlarmRegionMetadataInput[] {
  return after.areas
    .filter((item) => item.drawStatus !== 0)
    .flatMap((area, index) => {
      const draft = drafts[index]
      if (
        !draft || area.leftTopX === undefined || area.leftTopY === undefined ||
        area.width === undefined || area.height === undefined
      ) return []
      return [{
        id: draft.id,
        areaIndex: index,
        name: draft.name.trim() || defaultRegionName(index),
        leftTopX: Math.round(area.leftTopX),
        leftTopY: Math.round(area.leftTopY),
        width: Math.round(area.width),
        height: Math.round(area.height)
      }]
    })
}

async function saveRegions(showNotice = true): Promise<boolean> {
  const deviceId = props.deviceId
  if (deviceId === '' || regionsBusy.value) return false
  if (!regionRowsValid()) {
    regionsError.value = t('cameraAlarmUi.regionInvalid')
    return false
  }

  const drafts = regionRows.value.map((row) => ({ ...row }))
  regionsBusy.value = true
  regionsError.value = ''
  regionsNotice.value = ''
  try {
    /**
     * 业主 2026-09-23：一个区域都没画时**默认全画面告警**——写一个覆盖整帧的
     * 区域，而不是把空数组交给设备（空数组的设备侧语义手册未定义，不能赌）。
     */
    const area: Fa371ScanArea = {
      centerFocusCode: 2,
      coordinateSpace: 'pixel_video_frame',
      areas:
        drafts.length > 0
          ? drafts.map((row) => ({
              leftTopX: Math.round((row.x / 100) * REGION_REFERENCE_WIDTH),
              leftTopY: Math.round((row.y / 100) * REGION_REFERENCE_HEIGHT),
              width: Math.round((row.width / 100) * REGION_REFERENCE_WIDTH),
              height: Math.round((row.height / 100) * REGION_REFERENCE_HEIGHT),
              drawStatus: 1
            }))
          : [
              {
                leftTopX: 0,
                leftTopY: 0,
                width: REGION_REFERENCE_WIDTH,
                height: REGION_REFERENCE_HEIGHT,
                drawStatus: 1
              }
            ]
    }

    const result = await callApi(() => window.api.cameraControl.writeScanArea(deviceId, area))
    if (!result.success) {
      regionsError.value = resultMessage(result)
      return false
    }

    const write = unwrap(result)
    if (!write) {
      regionsError.value = t('cameraAlarmUi.regionNotApplied')
      return false
    }

    // The device read-back is authoritative. Never persist names for a draft the
    // camera rejected; otherwise a later GET could attach the name to the wrong box.
    if (!write.applied) {
      regionRows.value = scanAreaToRows(write.after, regionMetadata.value)
      selectedRegionId.value = ''
      regionsError.value = t('cameraAlarmUi.regionNotApplied')
      return false
    }

    const metadataInput = metadataInputsFromReadBack(write.after, drafts)
    const metadataResult = await callApi(() =>
      window.api.cameraControl.writeRegionMetadata(deviceId, metadataInput)
    )
    if (!metadataResult.success) {
      // Geometry is already on the camera, so show the verified rectangles but
      // report that their operator-facing names were not persisted locally.
      regionRows.value = scanAreaToRows(write.after, regionMetadata.value)
      selectedRegionId.value = ''
      regionsError.value = t('cameraAlarmUi.regionMetadataSaveFailed', {
        reason: resultMessage(metadataResult)
      })
      return false
    }

    regionMetadata.value = unwrap(metadataResult) ?? []
    regionRows.value = scanAreaToRows(write.after, regionMetadata.value)
    selectedRegionId.value = ''
    regionsLoadedDeviceId.value = deviceId
    regionsBaseline.value = serialiseRegionRows(regionRows.value)
    if (showNotice) regionsNotice.value = t('cameraAlarmUi.regionSaved')
    return true
  } finally {
    regionsBusy.value = false
  }
}
function cancelSectionAndClose(): void {
  cancelEdit()
  // Region edits are local until Save. Closing discards them by reloading next time.
  selectedRegionId.value = ''
  close()
}

async function saveSectionAndClose(): Promise<void> {
  /**
   * 业主 2026-09-23：「配置好保存，页面应该自动关闭」。
   *
   * 三个区块在同一页上，所以「保存」= 把**所有**待保存的改动一起写
   * （条件草稿 → 策略草稿 → 区域，沿用 saveAll 的顺序与互斥规则），
   * 全部成功才关闭——只存当前区块会把另外两块画好的区域/填好的策略静默留在
   * 内存里，页面一关就没了。任一失败则不关：那一块的错误提示得有人看见。
   */
  if (!canWrite.value || saving.value || regionsBusy.value || !hasPendingChanges.value) return
  error.value = ''
  notice.value = ''
  regionsError.value = ''
  regionsNotice.value = ''

  if (conditionDraft.value) {
    if (!(await saveCondition(false))) return
  } else if (strategyDraft.value) {
    if (!(await saveStrategy(false))) return
  }
  if (regionsDirty.value) {
    if (!(await saveRegions(false))) return
  }
  close()
}

const sectionSaveDisabled = computed(() => {
  if (!canWrite.value || saving.value || regionsBusy.value) return true
  if (activeSection.value === 'conditions') return conditionDraft.value === null
  if (activeSection.value === 'strategies') return strategyDraft.value === null
  if (activeSection.value === 'regions') return !regionsDirty.value
  return !hasPendingChanges.value
})

</script>

<template>
  <AppModal
    :model-value="modelValue"
    :title="modalTitle"
    width="880px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="!canWrite" class="alert alert--warning" role="note">{{ t('cameraAlarmUi.adminOnly') }}</p>

    <p v-if="loading" class="muted" role="status">{{ t('cameraAlarmUi.loading') }}</p>
    <p v-if="error" class="alert alert--danger" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert alert--success" role="status">{{ notice }}</p>

    <!-- ---- 告警调节（条件） -------------------------------------------- -->
    <section v-if="showConditions" class="alarm-section" data-section="conditions">
      <div class="alarm-section__header">
        <h4 class="alarm-section__title">{{ t('cameraAlarmUi.tabConditions') }}</h4>
        <button
          type="button"
          class="btn btn--sm btn--icon btn--primary"
          :disabled="!canWrite"
          :aria-label="t('cameraAlarmUi.newCondition')"
          :title="t('cameraAlarmUi.newCondition')"
          @click="startNewCondition"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
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
              {{ condition.ncSwitch ? '✓' : '✗' }} {{ fixed2(condition.ncSimilarityThreshold) }}
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
            <input
              v-model="spectrumSimilarityText"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              @change="normaliseSpectrumSimilarity"
              @blur="normaliseSpectrumSimilarity"
            />
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

        <fieldset class="branch branch--diagnosis">
          <legend>{{ t('cameraAlarmUi.branchDischarge') }}</legend>
          <p class="muted">{{ t('cameraAlarmUi.dischargeDiagnosisHint') }}</p>
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
          <button type="button" class="btn btn--sm" @click="cancelEdit">{{ t('cameraAlarmUi.cancel') }}</button>
        </div>
      </section>
    </section>

    <!-- ---- 告警策略 ---------------------------------------------------- -->
    <section v-if="showStrategies" class="alarm-section" data-section="strategies">
      <div class="alarm-section__header">
        <h4 class="alarm-section__title">{{ t('cameraAlarmUi.tabStrategies') }}</h4>
        <div class="section-actions">
          <button
            type="button"
            class="btn btn--sm btn--icon btn--primary"
            :disabled="!canWrite || conditions.length === 0"
            :aria-label="t('cameraAlarmUi.newStrategy')"
            :title="t('cameraAlarmUi.newStrategy')"
            @click="startNewStrategy"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            class="btn btn--sm btn--icon"
            :disabled="loading || regionsBusy"
            :aria-label="t('cameraAlarmUi.refreshIcon')"
            :title="t('cameraAlarmUi.refreshIcon')"
            @click="reloadAll"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 6.3" />
              <path d="M20 4v7h-7" />
            </svg>
          </button>
        </div>
      </div>
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
            <td>{{ fixed2(strategy.sensitivity) }}</td>
            <td>{{ strategy.timeoutDuration ?? '—' }}</td>
            <td>{{ conditionLabel(strategy) }}</td>
            <td><span :class="enabledClass(strategy)">{{ enabledLabel(strategy) }}</span></td>
            <td class="nowrap">
              <button
                type="button"
                class="btn btn--sm"
                :class="{ 'btn--primary': !strategyIsEnabled(strategy) }"
                :disabled="!canWrite || strategyWritableId(strategy) === undefined || strategyBusyId !== ''"
                @click="toggleStrategyEnabled(strategy)"
              >
                {{ strategyIsEnabled(strategy) ? t('cameraAlarmUi.strategyDisable') : t('cameraAlarmUi.strategyEnable') }}
              </button>
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
            <input
              v-model="strategySensitivityText"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              @change="normaliseStrategySensitivity"
              @blur="normaliseStrategySensitivity"
            />
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
            <span>{{ t('cameraAlarmUi.fieldDiagnosis') }}</span>
            <input v-model="strategyDraft.diagnosis" type="text" />
            <!--
              键名不再让操作员选（2026-09-23）：§5.1.23 写 diagosisn、§5.1.25 写
              diagnosis，是手册自己的矛盾。服务层现在写入后读回验证、自动判定并记住
              胜者（`camera-alarm-service.writeStrategyWithVerifiedKey`），界面只填内容。
            -->
          </label>
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn--sm" @click="cancelEdit">{{ t('cameraAlarmUi.cancel') }}</button>
        </div>
      </section>
    </section>

    <!-- ---- 告警区域（业主 2026-09-23：视频画面上直接框选） ----------------- -->
    <section v-if="showRegions" class="alarm-section" data-section="regions">
      <div class="alarm-section__header">
        <h4 class="alarm-section__title">{{ t('cameraAlarmUi.tabRegions') }}</h4>
        <button type="button" class="btn btn--sm" :disabled="regionsBusy" @click="loadRegions">
          {{ t('cameraAlarmUi.regionReload') }}
        </button>
      </div>

      <!--
        视频 + 框选舞台。归一化坐标画框，分辨率/尺寸变化不会让区域跑偏。
        没有会话时给一颗「开启视频」按钮（对话框自己起的那路在关闭时自动停）；
        已有会话在播时直接采用它的地址（接管这一路，关闭后父页面负责重连）。
      -->
      <div
        ref="regionStageEl"
        class="region-stage"
        :class="{ 'region-stage--drawing': regionDrawMode }"
        @pointerdown="beginRegionDraw"
        @pointermove="updateRegionDraw"
        @pointerup="finishRegionDraw"
        @pointercancel="finishRegionDraw"
      >
        <video
          v-if="regionVideoUrl"
          class="region-stage__video"
          :src="regionVideoUrl"
          autoplay
          muted
          playsinline
        ></video>
        <div v-else class="region-stage__placeholder">
          <button
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="regionVideoBusy || !canWrite"
            @click.stop="startRegionVideo"
          >
            {{ t('cameraAlarmUi.regionVideoStart') }}
          </button>
          <span v-if="regionVideo?.error" class="region-stage__error">{{ regionVideo.error }}</span>
        </div>

        <button
          v-for="(row, index) in regionRows"
          :key="row.id"
          type="button"
          class="region-stage__rect"
          :class="{ 'region-stage__rect--selected': selectedRegionId === row.id }"
          :style="{
            left: `${row.x}%`,
            top: `${row.y}%`,
            width: `${row.width}%`,
            height: `${row.height}%`
          }"
          :aria-label="`#${index + 1} ${row.name}`"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @click.stop="selectRegion(row.id)"
        >
          <span class="region-stage__label">#{{ index + 1 }} · {{ row.name }}</span>
        </button>
        <span
          v-if="regionDraft"
          class="region-stage__rect region-stage__rect--draft"
          :style="{
            left: `${regionDraft.x}%`,
            top: `${regionDraft.y}%`,
            width: `${regionDraft.width}%`,
            height: `${regionDraft.height}%`
          }"
        ></span>
      </div>

      <div class="btn-row">
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': regionDrawMode }"
          :disabled="!regionVideoUrl"
          @click="regionDrawMode = !regionDrawMode"
        >
          {{ regionDrawMode ? t('cameraAlarmUi.regionDrawing') : t('cameraAlarmUi.regionDraw') }}
        </button>
        <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="addRegion">
          {{ t('cameraAlarmUi.regionAdd') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!canWrite || !selectedRegion"
          @click="removeSelectedRegion"
        >
          {{ t('cameraAlarmUi.regionDeleteSelected') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!selectedRegion"
          @click="clearRegionSelection"
        >
          {{ t('cameraAlarmUi.regionClearSelection') }}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :disabled="!canWrite || regionRows.length === 0"
          @click="clearRegions"
        >
          {{ t('cameraAlarmUi.regionClear') }}
        </button>
      </div>

      <table v-if="regionRows.length > 0" class="table">
        <thead>
          <tr>
            <th>{{ t('cameraAlarmUi.regionColIndex') }}</th>
            <th>{{ t('cameraAlarmUi.regionColName') }}</th>
            <th>{{ t('cameraAlarmUi.regionColX') }}</th>
            <th>{{ t('cameraAlarmUi.regionColY') }}</th>
            <th>{{ t('cameraAlarmUi.regionColW') }}</th>
            <th>{{ t('cameraAlarmUi.regionColH') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, index) in regionRows"
            :key="row.id"
            :class="{ 'region-table-row--selected': selectedRegionId === row.id }"
            @click="selectRegion(row.id)"
          >
            <td class="region-index">#{{ index + 1 }}</td>
            <td><input v-model="row.name" type="text" maxlength="64" class="region-name" @focus="selectRegion(row.id)" /></td>
            <td><input v-model.number="row.x" type="number" min="0" max="100" step="0.1" class="region-input" /></td>
            <td><input v-model.number="row.y" type="number" min="0" max="100" step="0.1" class="region-input" /></td>
            <td><input v-model.number="row.width" type="number" min="0" max="100" step="0.1" class="region-input" /></td>
            <td><input v-model.number="row.height" type="number" min="0" max="100" step="0.1" class="region-input" /></td>
            <td class="nowrap">
              <button type="button" class="btn btn--sm" :disabled="!canWrite" @click="removeRegion(row)">
                {{ t('cameraAlarmUi.delete') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!regionsBusy" class="muted">{{ t('cameraAlarmUi.regionEmpty') }}</p>

      <p v-if="regionsError" class="alert alert--danger" role="alert">{{ regionsError }}</p>
      <p v-else-if="regionsNotice" class="alert alert--success" role="status">{{ regionsNotice }}</p>
    </section>

    <!--
      这里原本有一个「未验证项」小节，逐条列出手册的缺口与自相矛盾（8 条，合计约 600 字）。
      产品要求删除软件里的解释性内容，所以可见的清单去掉了；**手册歧义本身没有消失**：
      每条歧义仍然以 badge 的 `title` 形式挂在它影响的那个字段上（悬停可见），
      完整清单仍在 `CAMERA_ALARM_AMBIGUITIES`（`shared/domain/camera-alarm.ts`）里，
      连同规格书的条目号 —— 那是给维护者看的，不是给操作员看的。
    -->

    <template #footer>
      <button type="button" class="btn" @click="cancelSectionAndClose">{{ t('cameraAlarmUi.cancel') }}</button>
      <button
        type="button"
        class="btn btn--primary"
        :disabled="sectionSaveDisabled"
        @click="saveSectionAndClose"
      >
        {{ t('cameraAlarmUi.saveToCamera') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
/* 同页三区块（业主 2026-09-23 第 4 条）：区块之间一条分隔线 + 每块一个头部行。 */
.alarm-section {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
}

.alarm-section:first-of-type {
  border-top: 0;
  padding-top: 0;
  margin-top: 0;
}

.alarm-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: 8px;
}

.alarm-section__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.section-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.region-index {
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}

.region-name {
  width: 120px;
  padding: 4px 6px;
  font: inherit;
  color: inherit;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
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

.region-input {
  width: 72px;
  padding: 4px 6px;
  font: inherit;
  color: inherit;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

/* 视频 + 框选舞台（告警区域页签）。 */
.region-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  margin: 8px 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg-subtle);
  touch-action: none;
}

.region-stage--drawing {
  cursor: crosshair;
}

.region-stage__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.region-stage__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.region-stage__error {
  max-width: 80%;
  font-size: 11px;
  color: var(--color-danger);
}

.region-stage__rect {
  position: absolute;
  margin: 0;
  padding: 0;
  border: 2px solid var(--color-accent, #2563eb);
  border-radius: 3px;
  background: color-mix(in srgb, var(--color-accent, #2563eb) 12%, transparent);
  color: inherit;
  appearance: none;
  cursor: pointer;
  text-align: left;
  overflow: visible;
}

.region-stage__rect--selected {
  border-width: 3px;
  background: color-mix(in srgb, var(--color-accent, #2563eb) 20%, transparent);
}

.region-stage__label {
  position: absolute;
  top: 2px;
  left: 2px;
  max-width: min(260px, 36vw);
  padding: 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-bg) 88%, transparent);
  border: 1px solid var(--color-border);
  font-size: 11px;
  line-height: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.region-stage__rect--draft {
  border-style: dashed;
  background: transparent;
  pointer-events: none;
}

.region-table-row--selected td {
  background: var(--color-bg-subtle);
}
</style>
