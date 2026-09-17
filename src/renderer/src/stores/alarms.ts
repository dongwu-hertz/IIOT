/**
 * Alarm store (spec section 10).
 *
 * Holds the query state (`AlarmQuery`) next to the result page so the filter bar
 * and the table can never drift apart. Bit decoding is NEVER done here — the
 * domain model already carries `alarmTypes`, and views render the mask through
 * `describeAlarmMask` from @shared/domain/alarm-mask.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AlarmEvent, AlarmQuery } from '@shared/domain/models'
import type { EventSeverity } from '@shared/domain/event-center'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

/** Page size used by the alarms table; also the store's default `limit`. */
export const ALARM_PAGE_SIZE = 50

/**
 * 一次写入操作的三态结果（备注 / 等级）。
 *
 * `{ ok: true, saved: false }` 是一个**必须被说出来**的结果：写操作语法上成功了，但
 * 一行都没改到——这条告警已经不在库里（被保留策略清掉）。把它压成布尔就会让界面把
 * "没保存" 显示成 "已保存"，那是界面说假话。
 */
export type AlarmWriteOutcome = { ok: true; saved: boolean } | { ok: false; message: string }

function emptyQuery(): AlarmQuery {
  return { limit: ALARM_PAGE_SIZE, offset: 0 }
}

export const useAlarmsStore = defineStore('alarms', () => {
  const items = ref<AlarmEvent[]>([])
  const total = ref(0)
  const query = ref<AlarmQuery>(emptyQuery())
  const loading = ref(false)
  const error = ref('')
  /** Alarms fetched for the dashboard "最近告警" panel. */
  const recent = ref<AlarmEvent[]>([])

  const page = computed(() => ({
    limit: query.value.limit ?? ALARM_PAGE_SIZE,
    offset: query.value.offset ?? 0
  }))

  const hasMore = computed(() => (query.value.offset ?? 0) + items.value.length < total.value)

  async function load(): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.alarms.query({ ...query.value }))
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
  }

  /** Patch the query; the caller decides when to `load()` again. */
  function setQuery(patch: Partial<AlarmQuery>): void {
    query.value = { ...query.value, ...patch }
  }

  /** Apply a filter change and reload from the first page. */
  async function applyQuery(patch: Partial<AlarmQuery>): Promise<void> {
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

  /** Acknowledge (or un-acknowledge) a set of alarms. Returns affected rows. */
  async function acknowledge(ids: string[], value: boolean): Promise<number> {
    if (ids.length === 0) return 0
    const result = await callApi(() => window.api.alarms.acknowledge(ids, value))
    if (!result.success) {
      error.value = resultMessage(result)
      return 0
    }
    error.value = ''
    const affected = unwrap(result) ?? 0
    const idSet = new Set(ids)
    // Optimistic local update so the table reflects the change immediately; the
    // next `load()` re-reads the authoritative rows from SQLite.
    items.value = items.value.map((item) =>
      idSet.has(item.id) ? { ...item, acknowledged: value } : item
    )
    recent.value = recent.value.map((item) =>
      idSet.has(item.id) ? { ...item, acknowledged: value } : item
    )
    return affected
  }

  /** Dashboard panel: the newest N alarms regardless of the table filters. */
  async function loadRecent(limit = 10): Promise<void> {
    const result = await callApi(() => window.api.overview.recentAlarms(limit))
    if (!result.success) {
      error.value = resultMessage(result)
      recent.value = []
      return
    }
    recent.value = unwrap(result) ?? []
  }

  /**
   * 把一条已写成功的补丁同时落到表格与总览面板上（乐观更新，下一次 `load()` 会以
   * SQLite 里的权威行为准）。
   */
  function patchRow(alarmId: string, patch: (item: AlarmEvent) => AlarmEvent): void {
    items.value = items.value.map((item) => (item.id === alarmId ? patch(item) : item))
    recent.value = recent.value.map((item) => (item.id === alarmId ? patch(item) : item))
  }

  /**
   * 写/清除备注。
   *
   * 返回三态而不是布尔：`{ ok: true, saved: false }` 意思是**这条告警已经不在库里**
   * （保留策略把它清掉了）。它既不是失败也不是成功——界面必须把这句话说出来，而不是
   * 静默地当成写成功了。
   */
  async function setNote(alarmId: string, note: string | null): Promise<AlarmWriteOutcome> {
    const result = await callApi(() => window.api.alarms.setNote(alarmId, note))
    if (!result.success) {
      error.value = resultMessage(result)
      return { ok: false, message: error.value }
    }
    error.value = ''
    const saved = unwrap(result) ?? false
    if (saved) {
      patchRow(alarmId, (item) => {
        const next: AlarmEvent = { ...item }
        // 用 `delete` 而不是写 `undefined`：`note` 是可选字段，「没有备注」在模型里
        // 就是**没有这个键**，不是"键在、值为 undefined"。
        if (note === null) delete next.note
        else next.note = note
        return next
      })
    }
    return { ok: true, saved }
  }

  /** 人工改判等级（写入的是这条记录的快照，理由见仓库层 `setSeverity()`）。 */
  async function setSeverity(
    alarmId: string,
    severity: EventSeverity
  ): Promise<AlarmWriteOutcome> {
    const result = await callApi(() => window.api.alarms.setSeverity(alarmId, severity))
    if (!result.success) {
      error.value = resultMessage(result)
      return { ok: false, message: error.value }
    }
    error.value = ''
    const saved = unwrap(result) ?? false
    if (saved) patchRow(alarmId, (item) => ({ ...item, severity }))
    return { ok: true, saved }
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    // state
    items,
    total,
    query,
    loading,
    error,
    recent,
    // getters
    page,
    hasMore,
    // actions
    load,
    setQuery,
    applyQuery,
    resetQuery,
    goToPage,
    acknowledge,
    setNote,
    setSeverity,
    loadRecent,
    clearError
  }
})
