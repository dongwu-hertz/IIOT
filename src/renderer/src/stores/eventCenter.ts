/**
 * 事件与告警中心 store（产品要求：「设置事件和告警中心。」）。
 *
 * 形状照 `stores/alarms.ts`：查询条件与结果页放在一起，让筛选栏和表格不可能
 * 各说各话。三路来源的**合并发生在主进程**，所以这里没有「拼接三个数组」的代码，
 * 只有一次查询与一份逐来源读况。
 *
 * 两件必须在此显式建模的事：
 *   1. **截断**。每路来源都有读取上限，`truncated` 与 `sources[].truncated`
 *      原样保留给界面，绝不静默丢掉。
 *   2. **下载进度**。进度是主进程推来的**阶段**（没有百分比，因为传输层拿不到
 *      `Content-Length` 与已读字节数）。这里按 `deviceId:logId:kind` 存一份，
 *      订阅与退订由视图负责（与其它推送同一条纪律）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  EventAcknowledgeResult,
  EventCenterEntry,
  EventCenterQuery,
  EventDetectDownloadInput,
  EventDetectDownloadResult,
  EventDownloadProgress,
  EventSourceKind,
  EventSourceStatus
} from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

/** 页面使用的每页条数；同时是查询的默认 `limit`。 */
export const EVENT_PAGE_SIZE = 50

function emptyQuery(): EventCenterQuery {
  return { limit: EVENT_PAGE_SIZE, offset: 0 }
}

function emptyCounts(): Record<EventSourceKind, number> {
  return { deviceDetect: 0, linkage: 0, localAlarm: 0 }
}

/** 一次下载的稳定键：同一条日志的同一种文件只可能有一次进行中的下载。 */
export function eventDownloadKey(input: {
  deviceId: string
  logId: number
  kind: string
}): string {
  return `${input.deviceId}:${input.logId}:${input.kind}`
}

/** 进度的三个定位字段（不含阶段），避免把 `startTimeRaw` 混进进度对象。 */
function progressBase(input: {
  deviceId: string
  logId: number
  kind: EventDetectDownloadInput['kind']
}): { deviceId: string; logId: number; kind: EventDetectDownloadInput['kind'] } {
  return { deviceId: input.deviceId, logId: input.logId, kind: input.kind }
}

export const useEventCenterStore = defineStore('eventCenter', () => {
  const items = ref<EventCenterEntry[]>([])
  const total = ref(0)
  const countsBySource = ref<Record<EventSourceKind, number>>(emptyCounts())
  const sources = ref<EventSourceStatus[]>([])
  const truncated = ref(false)
  const query = ref<EventCenterQuery>(emptyQuery())
  const loading = ref(false)
  const error = ref('')
  const notice = ref('')
  const ackBusy = ref(false)
  /** 上一次确认请求的逐来源结果（含「设备侧不支持」这种事实）。 */
  const lastAcknowledge = ref<EventAcknowledgeResult | null>(null)
  /** 进行中/最近一次下载的阶段，键见 `eventDownloadKey`。 */
  const downloads = ref<Record<string, EventDownloadProgress>>({})

  const page = computed(() => ({
    limit: query.value.limit ?? EVENT_PAGE_SIZE,
    offset: query.value.offset ?? 0
  }))

  const hasMore = computed(() => (query.value.offset ?? 0) + items.value.length < total.value)

  /** 是否有任何一路来源读取失败（界面据此说明「这一路读不到」）。 */
  const hasSourceFailure = computed(() => sources.value.some((source) => !source.ok))

  async function load(): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.eventCenter.query({ ...query.value }))
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      items.value = []
      total.value = 0
      countsBySource.value = emptyCounts()
      sources.value = []
      truncated.value = false
      return
    }
    error.value = ''
    const data = unwrap(result)
    items.value = data?.items ?? []
    total.value = data?.total ?? 0
    countsBySource.value = data?.countsBySource ?? emptyCounts()
    sources.value = data?.sources ?? []
    truncated.value = data?.truncated ?? false
  }

  /** Patch the query; the caller decides when to `load()` again. */
  function setQuery(patch: Partial<EventCenterQuery>): void {
    query.value = { ...query.value, ...patch }
  }

  /** Apply a filter change and reload from the first page. */
  async function applyQuery(patch: Partial<EventCenterQuery>): Promise<void> {
    query.value = { ...query.value, ...patch, offset: 0 }
    await load()
  }

  async function resetQuery(): Promise<void> {
    query.value = emptyQuery()
    await load()
  }

  async function goToPage(offset: number): Promise<void> {
    query.value = { ...query.value, offset: Math.max(0, offset) }
    await load()
  }

  /**
   * 确认一组事件。
   *
   * 不做乐观更新：确认要按来源分派（联动 / 声纹 / 设备不支持），只有主进程知道
   * 每一条到底改动了什么，所以这里用返回的逐来源结果说话，再重读一次列表。
   */
  async function acknowledge(ids: string[]): Promise<EventAcknowledgeResult | null> {
    if (ids.length === 0) return null
    ackBusy.value = true
    const result = await callApi(() => window.api.eventCenter.acknowledge(ids))
    ackBusy.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return null
    }
    const payload = unwrap(result) ?? null
    lastAcknowledge.value = payload
    if (payload) {
      // 已经确认过的条目在列表里就地翻转，避免为了一个勾再打一次整页查询。
      const idSet = new Set(ids)
      items.value = items.value.map((item) =>
        idSet.has(item.id) ? { ...item, acknowledged: true } : item
      )
    }
    return payload
  }

  /**
   * 下载一个检测结果文件。
   *
   * 成功后重读当前页：新登记的录像行要把 `downloadedRecordingId` 带回来，
   * 否则界面会一直显示「未下载」而操作员已经在盘上有了文件。
   */
  async function download(
    input: EventDetectDownloadInput
  ): Promise<EventDetectDownloadResult | undefined> {
    const key = eventDownloadKey(input)
    downloads.value = {
      ...downloads.value,
      [key]: { ...progressBase(input), stage: 'starting' }
    }
    const result = await callApi(() => window.api.eventCenter.downloadDetectFile(input))
    if (!result.success) {
      error.value = resultMessage(result)
      downloads.value = {
        ...downloads.value,
        [key]: { ...progressBase(input), stage: 'failed', error: resultMessage(result) }
      }
      return undefined
    }
    error.value = ''
    const payload = unwrap(result)
    await load()
    return payload
  }

  /** 主进程推来的下载阶段；由视图的订阅转发到这里。 */
  function handleProgress(progress: EventDownloadProgress): void {
    const key = eventDownloadKey(progress)
    downloads.value = { ...downloads.value, [key]: progress }
  }

  /** 清掉一条已经结束的下载状态（界面提示用完之后）。 */
  function clearDownload(input: { deviceId: string; logId: number; kind: string }): void {
    const key = eventDownloadKey(input)
    if (!(key in downloads.value)) return
    const next = { ...downloads.value }
    delete next[key]
    downloads.value = next
  }

  function clearError(): void {
    error.value = ''
  }

  function clearNotice(): void {
    notice.value = ''
  }

  return {
    // state
    items,
    total,
    countsBySource,
    sources,
    truncated,
    query,
    loading,
    error,
    notice,
    ackBusy,
    lastAcknowledge,
    downloads,
    // getters
    page,
    hasMore,
    hasSourceFailure,
    // actions
    load,
    setQuery,
    applyQuery,
    resetQuery,
    goToPage,
    acknowledge,
    download,
    handleProgress,
    clearDownload,
    clearError,
    clearNotice
  }
})
