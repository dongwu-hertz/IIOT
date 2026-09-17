/**
 * 设备树（左侧栏）的界面状态：展开、筛选、焦点。
 *
 * 为什么是 Pinia store + localStorage
 *   1. **展开状态与筛选是纯展示偏好**，不是设备配置。存进主进程的设置表意味着加
 *      IPC 字段、加数据库迁移、加一次跨进程往返，只为记住「哪几台设备是展开的」。
 *   2. 本仓库已有「界面偏好写 localStorage」的既有约定（`composables/useLocale.ts`
 *      的 `hertzinno.locale`、`stores/channelWall.ts` 的两个键），这里沿用同一个
 *      `hertzinno.` 前缀与同样的 `try/catch` 写法（无痕模式或受限 profile 下读写
 *      会抛异常），于是「本地偏好」仍然只有一种实现方式。
 *   3. 用 store 而不是组件里的 `ref`：`AppSidebar` 会随路由反复挂载/卸载，
 *      组件里的状态一卸载就没了，而「我刚展开的那台设备」不该因为切页丢掉。
 *
 * 与 `stores/channelWall.ts` 的分工
 * 那个管的是总览页的通道墙；这个管的是侧栏的树。两者的**档位词汇**各自独立，
 * 互不 import（见 `lib/cameraWall.ts` 的说明）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useDevicesStore } from '@renderer/stores/devices'
import {
  DEVICE_TREE_ROOT_ID,
  defaultExpandedIds,
  expandAllIds,
  flattenDeviceTree,
  monitorRouteForDevice,
  pruneExpandedIds,
  selectedDeviceForRoute,
  toggleExpanded,
  type DeviceTreeNode,
  type FlattenedTree
} from '@renderer/lib/deviceTree'

/** localStorage 键名，沿用 `hertzinno.` 前缀（见 `shared/i18n/locales.ts`）。 */
export const DEVICE_TREE_EXPANDED_STORAGE_KEY = 'hertzinno.deviceTree.expanded'
export const DEVICE_TREE_FILTER_STORAGE_KEY = 'hertzinno.deviceTree.filter'

/**
 * 读回展开集合。
 *
 * 值可能来自旧版本、被手工改过、或干脆写坏；任何非字符串数组一律退回空数组，
 * 由 `pruneExpandedIds()` 在设备列表到达后补上默认展开，绝不让一个坏值让树
 * 一格都不显示。`null` 与 `'[]'` 都是合法状态（「我全收起来了」）。
 */
function readStoredExpanded(): string[] {
  try {
    const raw = window.localStorage.getItem(DEVICE_TREE_EXPANDED_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function readStoredFilter(): string {
  try {
    return window.localStorage.getItem(DEVICE_TREE_FILTER_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // 记不住偏好不应该让切换偏好本身失败。
  }
}

export const useDeviceTreeStore = defineStore('deviceTree', () => {
  const devices = useDevicesStore()

  const expanded = ref<string[]>(readStoredExpanded())
  const filter = ref<string>(readStoredFilter())
  const focusId = ref<string | null>(null)
  /** 「这一次会话里用户是否动过展开状态」——动过之后就不再套用默认展开。 */
  const expandedTouched = ref(false)

  /**
   * 已经退回默认值的标记。
   *
   * 第一次拿到设备列表时，如果用户从来没有手动展开过（localStorage 里没有键），
   * 默认展开所有设备 —— 一进应用就看到通道，比看到一列折叠的设备有用。
   * 一旦写回存储，就再也不覆盖用户的选择。
   */
  function ensureDefaultExpansion(): void {
    const list = devices.devices
    if (list.length === 0) return
    const pruned = pruneExpandedIds(expanded.value, list)
    if (!expandedTouched.value && expanded.value.length === 0) {
      const defaults = [DEVICE_TREE_ROOT_ID, ...defaultExpandedIds(list)]
      expanded.value = defaults
      writeStored(DEVICE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(defaults))
      return
    }
    if (pruned.length !== expanded.value.length) {
      expanded.value = pruned
      writeStored(DEVICE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(pruned))
    }
  }

  /** 树上所有可见行（模板唯一的渲染输入）。 */
  const flattened = computed<FlattenedTree>(() =>
    flattenDeviceTree({
      devices: devices.devices,
      channels: devices.channels,
      expanded: new Set(expanded.value),
      filter: filter.value
    })
  )

  const rows = computed<DeviceTreeNode[]>(() => flattened.value.rows)
  const visibleIds = computed<string[]>(() => flattened.value.visibleIds)

  /**
   * 当前应当高亮的设备 id。
   *
   * 来源就是「路由查询串 > store 里记住的 > 第一台」，与 `selectedDeviceForRoute()`
   * 一处一致；`routeDeviceId` 由 `AppSidebar` 从 `route.query.device` 传进来。
   */
  function selectedForRoute(routeDeviceId: unknown): string {
    return selectedDeviceForRoute(routeDeviceId, devices.selectedDeviceId, devices.devices)
  }

  function isExpanded(nodeId: string): boolean {
    return expanded.value.includes(nodeId)
  }

  /** 展开/收起一个节点。筛选生效时展开状态不起作用，但仍然记录（清掉筛选后生效）。 */
  function toggleNode(nodeId: string): void {
    expandedTouched.value = true
    expanded.value = toggleExpanded(expanded.value, nodeId)
    writeStored(DEVICE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(expanded.value))
  }

  function expandAll(): void {
    expandedTouched.value = true
    expanded.value = expandAllIds(devices.devices)
    writeStored(DEVICE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(expanded.value))
  }

  function collapseAll(): void {
    expandedTouched.value = true
    expanded.value = []
    writeStored(DEVICE_TREE_EXPANDED_STORAGE_KEY, JSON.stringify(expanded.value))
  }

  /** 筛选关键字。写进 localStorage：操作员常常整班都在筛同一批设备。 */
  function setFilter(next: string): void {
    filter.value = next
    writeStored(DEVICE_TREE_FILTER_STORAGE_KEY, next)
    // 筛选之后原来的焦点行可能已经不可见：直接丢掉，让下一次方向键落在第一行。
    if (focusId.value !== null && !flattened.value.visibleIds.includes(focusId.value)) {
      focusId.value = null
    }
  }

  function clearFilter(): void {
    setFilter('')
  }

  function setFocus(nodeId: string | null): void {
    focusId.value = nodeId
  }

  /** 选中一台设备：记住它，并交出要跳的路由（调用方负责 `router.push`）。 */
  function selectDevice(deviceId: string): { path: string; query: Record<string, string> } {
    devices.select(deviceId)
    return monitorRouteForDevice(deviceId)
  }

  return {
    // state
    filter,
    focusId,
    // getters
    expanded,
    rows,
    visibleIds,
    // actions
    ensureDefaultExpansion,
    isExpanded,
    toggleNode,
    expandAll,
    collapseAll,
    setFilter,
    clearFilter,
    setFocus,
    selectedForRoute,
    selectDevice
  }
})
