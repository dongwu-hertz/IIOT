/**
 * 本地样本库的 store（schema v8）。
 *
 * 与其它 store 同一条纪律：**判断不在这里**。哪一条能进训练集由主进程按
 * `isTrainable()` 算好（`SampleView.trainable`），标签库的"能不能删"也由主进程算
 * （`SampleLabelEntry.usedBy`）—— 渲染层再判一次就会出现两个版本的口径，而它们迟早不一致。
 *
 * 两个维度（设备类型 / 故障类型）在这一层**并排**处理，不合成一个"标签"：
 * 合成之后，"没标设备类型但有故障类型"这种状态就没法表达，而这恰好是最常见的中间状态。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  SampleAddOutcome,
  SampleAiConfigInput,
  SampleAiLabelOutcome,
  SampleAiLabelRequest,
  SampleAiStatus,
  SampleBulkAddOutcome,
  SampleExportRequest,
  SampleExportResult,
  SampleLabelEntry,
  SampleLabelListResult,
  SampleLabelMutationResult,
  SamplePage,
  SampleQuery,
  SampleStats,
  SampleTrainingReport,
  SampleView
} from '@shared/ipc/contract'
import type {
  SampleLabelDimension,
  SampleLabelSource,
  SampleSource
} from '@shared/domain/sample-library'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

export const SAMPLE_PAGE_SIZE = 100

/**
 * 空统计：**每一个**字段都要有值。
 *
 * "没有数据"与"没读到"在界面上不该长得一样，所以缺一个字段就会让统计格显示成空白而不是 0。
 */
function emptyStats(): SampleStats {
  return {
    total: 0,
    byFaultLabel: {},
    byEquipmentLabel: {},
    faultSource: { device: 0, human: 0, ai: 0, unlabelled: 0 },
    equipmentSource: { device: 0, human: 0, ai: 0, unlabelled: 0 },
    trainable: 0
  }
}

function emptyLabelLibrary(): SampleLabelListResult {
  return { equipment: [], fault: [] }
}

export const useSamplesStore = defineStore('samples', () => {
  const items = ref<SampleView[]>([])
  const total = ref(0)
  const limit = ref(SAMPLE_PAGE_SIZE)
  const offset = ref(0)
  const loading = ref(false)
  const error = ref('')
  const stats = ref<SampleStats>(emptyStats())
  const training = ref<SampleTrainingReport | null>(null)
  const busy = ref(false)
  const exporting = ref(false)
  const aiStatus = ref<SampleAiStatus | null>(null)
  const aiSaving = ref(false)
  const aiBusy = ref(false)
  /** 标签库：两个维度各自的词表 + 引用数。 */
  const labelLibrary = ref<SampleLabelListResult>(emptyLabelLibrary())
  const labelBusy = ref(false)

  const page = computed<SamplePage>(() => ({
    items: items.value,
    total: total.value,
    limit: limit.value,
    offset: offset.value
  }))

  async function load(query: SampleQuery = {}): Promise<void> {
    loading.value = true
    const result = await callApi(() =>
      window.api.samples.query({ limit: SAMPLE_PAGE_SIZE, ...query })
    )
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      items.value = []
      total.value = 0
      return
    }
    error.value = ''
    const data = unwrap(result)
    items.value = data?.items ?? []
    total.value = data?.total ?? 0
    limit.value = data?.limit ?? SAMPLE_PAGE_SIZE
    offset.value = data?.offset ?? 0
  }

  async function loadStats(): Promise<void> {
    const result = await callApi(() => window.api.samples.stats())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    stats.value = unwrap(result) ?? emptyStats()
  }

  /** 标签库（两个维度）。筛选下拉、打标签的候选、维护界面都读它。 */
  async function loadLabels(): Promise<void> {
    const result = await callApi(() => window.api.samples.labels())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    labelLibrary.value = unwrap(result) ?? emptyLabelLibrary()
  }

  /** 刷新列表 + 统计 + 标签库（任何会改变库的操作之后都调用它，不靠本地猜测）。 */
  async function refresh(query: SampleQuery = {}): Promise<void> {
    await Promise.all([load(query), loadStats(), loadLabels()])
  }

  /**
   * 入库。
   *
   * 返回**主进程的原始结果**而不是布尔：`metricsStored` 是"这次到底带进来几维特征"，
   * 而手动录音经常是 0 —— 界面必须能说出"已入库，但没有特征值，暂时不能参与训练"，
   * 而不是一句笼统的"已添加"。
   */
  async function addFromAlarm(alarmId: string): Promise<SampleAddOutcome | undefined> {
    busy.value = true
    const result = await callApi(() => window.api.samples.addFromAlarm(alarmId))
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await refresh()
    return unwrap(result)
  }

  async function addFromRecording(recordingId: string): Promise<SampleAddOutcome | undefined> {
    busy.value = true
    const result = await callApi(() => window.api.samples.addFromRecording(recordingId))
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await refresh()
    return unwrap(result)
  }

  /**
   * 批量入库。返回值里有 `existing`（幂等命中）与 `failed`（告警不存在）两组数，
   * 界面照它们说话 —— 把"上次已经加过"报成失败会让操作员去查一个不存在的问题。
   */
  async function addFromAlarms(alarmIds: string[]): Promise<SampleBulkAddOutcome | undefined> {
    if (alarmIds.length === 0) return undefined
    busy.value = true
    const result = await callApi(() => window.api.samples.addFromAlarms(alarmIds))
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await refresh()
    return unwrap(result)
  }

  /** 选导出目录。取消返回 `null`（不是错误，界面不该弹红条）。 */
  async function pickExportDirectory(): Promise<string | null> {
    const result = await callApi(() => window.api.samples.pickExportDirectory())
    if (!result.success) {
      error.value = resultMessage(result)
      return null
    }
    error.value = ''
    return unwrap(result) ?? null
  }

  async function exportDataset(
    request: SampleExportRequest
  ): Promise<SampleExportResult | undefined> {
    exporting.value = true
    const result = await callApi(() => window.api.samples.exportDataset(request))
    exporting.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    return unwrap(result)
  }

  /**
   * AI 标注（可选，业主 2026-09-16）。
   *
   * 状态**从主进程读**而不是在渲染层从草稿推：`ready` 与 `blockedReason` 是域层
   * `describeAiReadiness()` 的判断结果，渲染层再算一遍就会有两个版本的口径。
   */
  async function loadAiStatus(): Promise<void> {
    const result = await callApi(() => window.api.samples.aiStatus())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    aiStatus.value = unwrap(result) ?? null
  }

  async function saveAiConfig(input: SampleAiConfigInput): Promise<boolean> {
    aiSaving.value = true
    const result = await callApi(() => window.api.samples.saveAiConfig(input))
    aiSaving.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    // 用主进程回的状态覆盖本地：密钥"到底存上没有"只有它知道（系统加密可能不可用）。
    aiStatus.value = unwrap(result) ?? aiStatus.value
    return true
  }

  async function aiLabel(request: SampleAiLabelRequest): Promise<SampleAiLabelOutcome | undefined> {
    aiBusy.value = true
    const result = await callApi(() => window.api.samples.aiLabel(request))
    aiBusy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await refresh()
    return unwrap(result)
  }

  /**
   * 写**某一维**的标签（`null` = 撤销这一维的标注）。
   *
   * 成功后整体刷新：新名字可能刚被 `ensureLabel` 记进标签库，本地自己拼一份会漏掉它。
   */
  async function setLabel(
    sampleId: string,
    dimension: SampleLabelDimension,
    label: string | null,
    source: SampleLabelSource
  ): Promise<boolean> {
    busy.value = true
    const result = await callApi(() =>
      window.api.samples.setLabel(sampleId, dimension, label, source)
    )
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    await refresh()
    return unwrap(result) ?? false
  }

  /**
   * 一次写两个维度（界面上一行只有一个"保存"）。
   *
   * 只动**传了值**的那一维：`undefined` 是"不改"，`null` 才是"清掉"。两者差一个语义，
   * 而默认清掉会让"只改故障类型"顺手毁掉已有的设备类型。
   */
  async function setLabels(
    sampleId: string,
    input: { fault?: string | null; equipment?: string | null }
  ): Promise<boolean> {
    let changed = false
    if (input.fault !== undefined) {
      changed = (await setLabel(sampleId, 'fault', input.fault, 'human')) || changed
    }
    if (input.equipment !== undefined) {
      changed = (await setLabel(sampleId, 'equipment', input.equipment, 'human')) || changed
    }
    return changed
  }

  async function remove(sampleId: string): Promise<boolean> {
    busy.value = true
    const result = await callApi(() => window.api.samples.remove(sampleId))
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    await refresh()
    return unwrap(result) ?? false
  }

  async function train(): Promise<SampleTrainingReport | undefined> {
    busy.value = true
    const result = await callApi(() => window.api.samples.train())
    busy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    training.value = unwrap(result) ?? null
    return training.value ?? undefined
  }

  /** 标签库：加一条。同名幂等（`created: false`），界面据此说"已存在"而不是"失败"。 */
  async function addLabel(
    dimension: SampleLabelDimension,
    name: string
  ): Promise<SampleLabelMutationResult | undefined> {
    labelBusy.value = true
    const result = await callApi(() => window.api.samples.addLabel(dimension, name))
    labelBusy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await loadLabels()
    return unwrap(result)
  }

  /** 标签库：改名（主进程会把样本里引用的旧名字一起改掉，返回值带 `affectedSamples`）。 */
  async function renameLabel(
    id: string,
    name: string
  ): Promise<SampleLabelMutationResult | undefined> {
    labelBusy.value = true
    const result = await callApi(() => window.api.samples.renameLabel(id, name))
    labelBusy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await refresh()
    return unwrap(result)
  }

  /** 标签库：删除。还有样本在用会被拒（`in-use` + `usedBy`），界面照它说话。 */
  async function removeLabel(id: string): Promise<SampleLabelMutationResult | undefined> {
    labelBusy.value = true
    const result = await callApi(() => window.api.samples.removeLabel(id))
    labelBusy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    await loadLabels()
    return unwrap(result)
  }

  /** 某一维的标签清单（筛选下拉与打标签的候选都用它）。 */
  function labelEntries(dimension: SampleLabelDimension): SampleLabelEntry[] {
    return dimension === 'equipment' ? labelLibrary.value.equipment : labelLibrary.value.fault
  }

  /** 某一维按样本数从多到少（下拉里最常用的排前面）。 */
  function labelOptions(dimension: SampleLabelDimension): Array<{ name: string; usedBy: number }> {
    return labelEntries(dimension)
      .map((entry) => ({ name: entry.name, usedBy: entry.usedBy }))
      .sort((left, right) => right.usedBy - left.usedBy || left.name.localeCompare(right.name))
  }

  function clearTraining(): void {
    training.value = null
  }

  return {
    items,
    total,
    page,
    loading,
    busy,
    exporting,
    aiStatus,
    aiSaving,
    aiBusy,
    labelLibrary,
    labelBusy,
    error,
    stats,
    training,
    load,
    loadStats,
    loadLabels,
    refresh,
    addFromAlarm,
    addFromAlarms,
    addFromRecording,
    pickExportDirectory,
    exportDataset,
    loadAiStatus,
    saveAiConfig,
    aiLabel,
    setLabel,
    setLabels,
    remove,
    train,
    addLabel,
    renameLabel,
    removeLabel,
    labelEntries,
    labelOptions,
    clearTraining
  }
})

export type { SampleSource }
