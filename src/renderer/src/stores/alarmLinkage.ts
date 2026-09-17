/**
 * 告警联动 store（录像 / 弹窗 / 提示 / 邮件）。
 *
 * ---------------------------------------------------------------------------
 * 「提示」为什么活在这里
 * ---------------------------------------------------------------------------
 * 产品要求提示要能在导航之后仍然看得见。做法不是「在某个页面里挂一条通知」，
 * 而是：
 *   1. 真正的那份列表在**主进程**（`services/linkage/pending-alarm-store.ts`），
 *      已经落盘、带确认状态；
 *   2. 这个 store 只是它在渲染层的镜像，`App.vue` 之上的 shell 持有一次订阅；
 *   3. shell 里的角标与面板读的是同一份镜像，所以任何页面被销毁、重建、
 *      甚至整页刷新，都只影响「谁在画」，不影响「有没有」。
 *
 * 因此这个 store 的 `subscribe()` 必须由 shell 调用一次并且**常驻**，
 * 而不是由某个视图在 `onMounted` 里注册（那样切页就丢了）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  LinkageEngineStatus,
  PendingAlarmRecord,
  PendingAlarmSnapshot
} from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

export const useAlarmLinkageStore = defineStore('alarmLinkage', () => {
  const pending = ref<PendingAlarmRecord[]>([])
  const dropped = ref(0)
  const status = ref<LinkageEngineStatus | null>(null)
  const error = ref('')
  const loading = ref(false)
  const loaded = ref(false)

  /** 未确认条数：顶栏角标读它。 */
  const unacknowledged = computed(() => pending.value.filter((item) => !item.acknowledged))
  const unacknowledgedCount = computed(() => unacknowledged.value.length)

  /** 最新的一条未确认告警（面板折叠时显示的一句话）。 */
  const latest = computed<PendingAlarmRecord | null>(() => {
    const sorted = [...pending.value].sort((left, right) => right.at - left.at)
    return sorted[0] ?? null
  })

  function apply(snapshot: PendingAlarmSnapshot): void {
    pending.value = snapshot.items
    dropped.value = snapshot.dropped
    loaded.value = true
  }

  /** 读一次权威快照。任何时刻调用都安全（幂等）。 */
  async function load(): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.linkage.pending())
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    error.value = ''
    const snapshot = unwrap(result)
    if (snapshot) apply(snapshot)
  }

  /** 读引擎状态（设置页的诊断面板）。 */
  async function loadStatus(): Promise<void> {
    const result = await callApi(() => window.api.linkage.status())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    const value = unwrap(result)
    if (!value) return
    status.value = value
    // 状态里也带一份快照，顺手用它（少一次往返，且两者本来就是同一时刻的）。
    apply(value.pending)
  }

  /**
   * 确认告警。不传 `ids` 表示全部确认。
   * 返回值是确认后的权威快照，因此界面不需要自己推算。
   */
  async function acknowledge(ids?: string[]): Promise<boolean> {
    const result = await callApi(() => window.api.linkage.acknowledge(ids))
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    const snapshot = unwrap(result)
    if (snapshot) apply(snapshot)
    return true
  }

  /**
   * 订阅主进程的推送。
   *
   * 返回退订函数：shell 必须在 `onUnmounted` 里调用它——预载桥持有一份回调
   * 引用，不退订就是一次永久的泄漏（与 `devices.subscribeToStatus` 同一规则）。
   */
  function subscribe(): () => void {
    if (typeof window.events?.onLinkagePending !== 'function') return () => undefined
    return window.events.onLinkagePending((snapshot) => {
      apply(snapshot)
    })
  }

  return {
    // state
    pending,
    dropped,
    status,
    error,
    loading,
    loaded,
    // getters
    unacknowledged,
    unacknowledgedCount,
    latest,
    // actions
    load,
    loadStatus,
    acknowledge,
    subscribe
  }
})
