/**
 * SN-16 每秒实时值（`realtime_value` callback）的渲染层缓存。
 *
 * 主进程的 HTTP 监听收到设备 POST 后推 `E2_REALTIME_CALLBACK_VALUE`；这里只保留
 * **每台设备最近一帧**（实时区只读最新值，历史趋势在另一个系统里）。
 *
 * 订阅用引用计数：GIS 实时工作台与设备详情页的回调卡片可能同时挂载，谁先走谁
 * 都不能把别人的推送摘掉。释放后 `window.events` 上那份闭包会被退订，不留在窗口生命周期里。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { E2RealtimeValueEvent } from '@shared/domain/e2-callback'

export const useE2RealtimeStore = defineStore('e2Realtime', () => {
  /** deviceId -> 最近一帧。只保留最新，不做趋势缓冲。 */
  const latest = ref<Record<string, E2RealtimeValueEvent>>({})

  let refCount = 0
  let unsubscribe: (() => void) | undefined

  function handle(event: E2RealtimeValueEvent): void {
    latest.value = { ...latest.value, [event.deviceId]: event }
  }

  function subscribe(): void {
    if (unsubscribe !== undefined) return
    if (typeof window === 'undefined' || !window.events) return
    // 纯 Vite 预览里没有 preload 的推送桥：安静降级，不把页面弄崩。
    if (typeof window.events.onE2RealtimeValue !== 'function') return
    unsubscribe = window.events.onE2RealtimeValue(handle)
  }

  function unsubscribeBridge(): void {
    unsubscribe?.()
    unsubscribe = undefined
  }

  /** 组件挂载时调用；成对调用 `release()`。 */
  function acquire(): void {
    refCount += 1
    if (refCount === 1) subscribe()
  }

  /** 组件卸载时调用；计数归零才真正退订。 */
  function release(): void {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0) {
      unsubscribeBridge()
      // 缓存也清掉：下一个持有者看到的必须是它自己订阅之后的新数据，而不是上一轮的。
      latest.value = {}
    }
  }

  function latestFor(deviceId: string): E2RealtimeValueEvent | undefined {
    return latest.value[deviceId]
  }

  return { latest, acquire, release, latestFor }
})