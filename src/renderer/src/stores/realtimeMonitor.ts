/**
 * GIS 实时监测工作台的**唯一选中状态**（规格 §27 / §41）。
 *
 * 为什么必须是单独一个 store，而不是三块各自 `ref('')`：
 * GIS 标记、设备列表、告警列表都在改"当前看哪一台"，而实时区要跟着换模板。
 * 如果三处各存一份选中状态，就一定会出现"地图选 A、设备列表高亮 B、实时区显示 C"
 * 这种自相矛盾的画面（规格 §41 原话）。所以这里只保留三个字段：
 *
 *   currentDeviceId + currentEventId + monitorMode
 *
 * 另外两个 UI 状态也放这里，因为它们必须**在设备切换时归零**：
 *   - `cameraMode`：声相机显示 PD 还是 Leak 模板（默认 PD）；
 *   - `activeTab`：当前中心 Tab；切设备后由组件重新取模板默认值。
 *
 * 数据帧不在这里：拉流、离线、last-known 的判定在
 * `composables/useRealtimeMonitorFeed.ts`，这个 store 只负责"用户选中了什么"。
 * 走时器（`now`）用于 STALE 判定，由工作台挂载时启动、卸载时停止。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { AcousticCameraViewMode, RealtimeTabId } from '@shared/domain/realtime-monitor'

export type MonitorMode = 'live' | 'event'

export const useRealtimeMonitorStore = defineStore('realtimeMonitor', () => {
  /** 整个 GIS 页面只有一个当前聚焦设备（规格 §27）。 */
  const currentDeviceId = ref('')
  /** Event 模式的告警 id；Live 模式为空。 */
  const currentEventId = ref('')
  const monitorMode = ref<MonitorMode>('live')
  /** 声相机当前显示模式；不是设备事实，是操作员在看的视图。 */
  const cameraMode = ref<AcousticCameraViewMode>('pd')
  /** 当前中心 Tab；undefined = 用模板默认值。 */
  const activeTab = ref<RealtimeTabId | undefined>(undefined)
  /** 走时；每秒更新一次，驱动 STALE / DATA DELAY（规格 §31）。 */
  const now = ref(Date.now())

  let timer: number | undefined

  function startClock(): void {
    if (timer !== undefined || typeof window === 'undefined') return
    now.value = Date.now()
    timer = window.setInterval(() => {
      now.value = Date.now()
    }, 1_000)
  }

  function stopClock(): void {
    if (timer === undefined || typeof window === 'undefined') return
    window.clearInterval(timer)
    timer = undefined
  }

  /**
   * 点地图标记 / 设备列表 / 路由参数都走这里。
   *
   * 切到"同一台设备"也清 Event 状态：从 Event 模式点回当前设备的列表行，
   * 操作员的意思是"回到这一台的实时"，而不是"继续看上一条告警"。
   */
  function selectDevice(deviceId: string): void {
    currentDeviceId.value = deviceId
    currentEventId.value = ''
    monitorMode.value = 'live'
    activeTab.value = undefined
  }

  /**
   * 点告警进 Event 模式（规格 §27：Alarm -> Device selected -> Event selected）。
   *
   * 传 deviceId 是刻意的：告警行属于哪台设备由调用方（手持告警列表的视图）决定，
   * store 里没有设备列表，不能自己去查。
   */
  function selectEvent(eventId: string, deviceId: string): void {
    currentDeviceId.value = deviceId
    currentEventId.value = eventId
    monitorMode.value = 'event'
    activeTab.value = undefined
  }

  /** 「Return to Live」（规格 §28）。保留当前设备，只丢掉事件。 */
  function returnToLive(): void {
    currentEventId.value = ''
    monitorMode.value = 'live'
    activeTab.value = undefined
  }

  function setCameraMode(mode: AcousticCameraViewMode): void {
    cameraMode.value = mode
    activeTab.value = undefined
  }

  function setActiveTab(tab: RealtimeTabId | undefined): void {
    activeTab.value = tab
  }

  /** 设备被删除等场景：清空选中，回到 Empty State（规格 §35，不默认选第一台）。 */
  function clearSelection(): void {
    currentDeviceId.value = ''
    currentEventId.value = ''
    monitorMode.value = 'live'
    activeTab.value = undefined
    stopClock()
  }

  return {
    currentDeviceId,
    currentEventId,
    monitorMode,
    cameraMode,
    activeTab,
    now,
    startClock,
    stopClock,
    selectDevice,
    selectEvent,
    returnToLive,
    setCameraMode,
    setActiveTab,
    clearSelection
  }
})