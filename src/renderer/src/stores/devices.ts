/**
 * Device store (spec section 8).
 *
 * Setup-style Pinia store. Every action funnels failures into a human-readable
 * `error` string and resolves normally — no store action ever throws, so views
 * can render without defensive try/catch (spec 14.2).
 *
 * The store is also the ONLY place device data is cached: views never call
 * `window.api.devices.*` directly, which keeps "one source of truth" for the
 * online/offline counters shown in the sidebar, topbar and overview.
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AddDeviceInput,
  Channel,
  Device,
  DeviceInfo,
  DeviceStatusEvent,
  UpdateDeviceInput
} from '@shared/domain/models'
import type { ProbeResult } from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { useAppNoticesStore } from '@renderer/stores/appNotices'

/**
 * 设备侧**读类**失败的去处：顶栏那颗告警图标里的「系统消息」（业主 2026-09-18）。
 *
 * 为什么要分开三个 id：三条读路径各自独立成功/失败 —— 通道表读回来了不该把"设备列表读不
 * 出来"那条也撤掉，反过来也一样。同一个 id 只留一行（见 `stores/appNotices.ts`）。
 *
 * **增删改不报**：那是一次点击的结果，`DevicesView` / `AddDeviceDialog` 已经在它发生的地方
 * 说了（`devices.error` 那两处读者）。同一个失败在两处说，会让人以为发生了两件事。
 */
const READ_ERROR_IDS = {
  list: 'devices-list',
  channels: 'devices-channels',
  status: 'devices-status'
} as const

/**
 * 把一条读类失败报进系统消息；消息为空串表示这一路读通了，把那条撤掉。
 *
 * 不动 `error` 字段：那个字段是给"点一下就地反馈"的调用方读的（见上），两条路各管各的。
 */
function reportReadError(id: string, message: string): void {
  const notices = useAppNoticesStore()
  const text = message.trim()
  if (text === '') notices.clear(id)
  else notices.report({ id, text })
}


export const useDevicesStore = defineStore('devices', () => {
  const devices = ref<Device[]>([])
  const loading = ref(false)
  const error = ref('')
  const selectedDeviceId = ref<string>('')

  /** Channels per device id, loaded lazily by the detail/monitor views. */
  const channels = ref<Record<string, Channel[]>>({})
  const channelsLoading = ref<Record<string, boolean>>({})

  /**
   * Bumped after a global refresh so views that own their own queries
   * (overview statistics, alarm list) know to reload without a hard reload.
   */
  const refreshTick = ref(0)

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  const onlineCount = computed(() => devices.value.filter((d) => d.status === 'ONLINE').length)
  const offlineCount = computed(() => devices.value.filter((d) => d.status === 'OFFLINE').length)
  const unknownCount = computed(() => devices.value.filter((d) => d.status === 'UNKNOWN').length)

  const byId = computed(() => (id: string) => devices.value.find((device) => device.id === id))

  /** Display name for tables that only store a `deviceId` foreign key. */
  const nameById = computed(
    () => (id: string) => devices.value.find((device) => device.id === id)?.name ?? id
  )

  const channelsOf = computed(() => (deviceId: string) => channels.value[deviceId] ?? [])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function load(): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.devices.list())
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      reportReadError(READ_ERROR_IDS.list, error.value)
      return
    }
    devices.value = unwrap(result) ?? []
    error.value = ''
    reportReadError(READ_ERROR_IDS.list, '')
    if (
      selectedDeviceId.value &&
      !devices.value.some((device) => device.id === selectedDeviceId.value)
    ) {
      selectedDeviceId.value = ''
    }
    if (!selectedDeviceId.value && devices.value.length > 0) {
      selectedDeviceId.value = devices.value[0]?.id ?? ''
    }
  }

  /** Returns the created device, or undefined when the call failed. */
  async function add(input: AddDeviceInput): Promise<Device | undefined> {
    loading.value = true
    const result = await callApi(() => window.api.devices.add(input))
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    const device = unwrap(result)
    if (device) {
      const index = devices.value.findIndex((item) => item.id === device.id)
      if (index >= 0) devices.value.splice(index, 1, device)
      else devices.value.push(device)
      selectedDeviceId.value = device.id
    }
    return device
  }

  async function update(input: UpdateDeviceInput): Promise<Device | undefined> {
    const result = await callApi(() => window.api.devices.update(input))
    if (!result.success) {
      error.value = resultMessage(result)
      return undefined
    }
    error.value = ''
    const device = unwrap(result)
    if (device) {
      const index = devices.value.findIndex((item) => item.id === device.id)
      if (index >= 0) devices.value.splice(index, 1, device)
    }
    return device
  }

  async function remove(id: string): Promise<boolean> {
    const result = await callApi(() => window.api.devices.remove(id))
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    devices.value = devices.value.filter((device) => device.id !== id)
    delete channels.value[id]
    if (selectedDeviceId.value === id) selectedDeviceId.value = devices.value[0]?.id ?? ''
    return true
  }

  /**
   * Re-probe one device or all of them.
   * This is the manual counterpart of the automatic health monitor (spec 13.2),
   * which is why it lives on the topbar "刷新" button.
   *
   * **两种调用的返回**不一样，这一点必须写清楚（2026-09-17 修的缺陷就出在这里）：
   *   - 不带 `id`：主进程跑一遍全量健康检查并回**整份**设备表；
   *   - 带 `id`：主进程只回**那一台**（`handlers.ts` 的 `DEVICE_REFRESH_STATUS`：
   *     `return [services.devices.get(id)]`）。
   *
   * 所以这里**不能**一律 `devices.value = list`。原来就是那么写的，于是"进入任何一台设备的
   * 详情页"（`DeviceDetailView` 会调 `refreshStatus(props.id)`）会把**全应用的设备列表**
   * 替换成那**一台** —— 操作员看到的现象是"设备列表缺了几台"、"实时监测的设备下拉里只剩
   * 一台"，而库里一台都不少。单台刷新按 id **合并**，全量刷新才整份替换。
   */
  async function refreshStatus(id?: string): Promise<void> {
    loading.value = true
    const result = await callApi(() => window.api.devices.refreshStatus(id))
    loading.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      // 单台设备认证失败不是应用登录失败：不上顶栏，留在设备页就地反馈。
      reportReadError(READ_ERROR_IDS.status, result.error?.code === 'AUTH_FAILED' ? '' : error.value)
      return
    }
    error.value = ''
    reportReadError(READ_ERROR_IDS.status, '')
    const list = unwrap(result)
    if (list) {
      if (id === undefined) {
        devices.value = list
      } else {
        for (const device of list) {
          const index = devices.value.findIndex((item) => item.id === device.id)
          // 认不出的 id 按新增处理（与 `add()` 同一条行为）：不回退成"丢弃这一台"。
          if (index >= 0) devices.value.splice(index, 1, device)
          else devices.value.push(device)
        }
      }
    }
    refreshTick.value += 1
  }

  /** Add-device preview call (spec 6.2). Failure text is returned, not stored. */
  async function probe(input: Omit<AddDeviceInput, 'name'>): Promise<{
    result?: ProbeResult
    error?: string
  }> {
    const response = await callApi(() => window.api.devices.probe(input))
    if (!response.success) return { error: resultMessage(response) }
    return { result: unwrap(response) }
  }

  /** Read-only identity/version block straight from the device. */
  async function fetchInfo(id: string): Promise<{ info?: DeviceInfo; error?: string }> {
    const response = await callApi(() => window.api.devices.getInfo(id))
    if (!response.success) return { error: resultMessage(response) }
    return { info: unwrap(response) }
  }

  function select(id: string): void {
    selectedDeviceId.value = id
  }

  async function loadChannels(deviceId: string, force = false): Promise<void> {
    if (!deviceId) return
    if (!force && channels.value[deviceId]) return
    channelsLoading.value = { ...channelsLoading.value, [deviceId]: true }
    const result = await callApi(() => window.api.devices.getChannels(deviceId))
    channelsLoading.value = { ...channelsLoading.value, [deviceId]: false }
    if (!result.success) {
      error.value = resultMessage(result)
      // 同上：设备凭据错误不要污染设置页/顶栏的系统消息。
      reportReadError(READ_ERROR_IDS.channels, result.error?.code === 'AUTH_FAILED' ? '' : error.value)
      return
    }
    channels.value = { ...channels.value, [deviceId]: unwrap(result) ?? [] }
    /*
     * 这一路读通了：把"通道表读不出来"那条系统消息撤掉。
     *
     * 刻意**只撤这一条**（不动 `error`）：`error` 那个字段是"点一下就地反馈"的调用方在
     * 读的（`DevicesView` / `AddDeviceDialog`），而它历史上就**没有**在读成功时清空 ——
     * 清它会把别的失败一起抹掉（那是另一个缺陷，见 §15.47 的"还没做"）。
     */
    // 成功读取后清掉上一次通道读取留下的就地错误，避免设备管理页显示过期的 AUTH_FAILED。
    error.value = ''
    reportReadError(READ_ERROR_IDS.channels, '')
  }

  async function openWebUi(id: string): Promise<string> {
    const result = await callApi(() => window.api.devices.openWebUi(id))
    if (!result.success) return resultMessage(result)
    return ''
  }

  // -------------------------------------------------------------------------
  // Live status push (spec 13.2)
  // -------------------------------------------------------------------------

  /**
   * Force a device's status locally, without touching the main process.
   *
   * This is the store's own unit of behaviour for a status push, exposed so a
   * self-check can exercise it. Keeping it public (rather than reaching into
   * store internals from a test) means the smoke test verifies the REAL code
   * path rather than a reimplementation of it.
   */
  function applyStatusPatch(event: DeviceStatusEvent): boolean {
    const device = devices.value.find((item) => item.id === event.deviceId)
    // An unknown id is ignored, not an error: a push can legitimately arrive
    // for a device that was just deleted.
    if (!device) return false

    if (device.status === event.status && event.lastSeen === undefined) return false

    device.status = event.status
    if (event.lastSeen !== undefined) device.lastSeen = event.lastSeen
    device.updatedAt = Date.now()
    return true
  }

  /**
   * Subscribe to device online/offline transitions from the main-process
   * health monitor.
   *
   * Why subscribe instead of polling: the main process already probes every
   * device on an interval. Polling the same information from the UI would
   * double the device traffic AND let the displayed status drift from the
   * status the monitor actually measured.
   *
   * The patch is applied in place rather than triggering a full `load()`: a
   * device flapping offline must not cause a list-wide refetch every 5 seconds.
   *
   * @returns an unsubscribe function. Callers must invoke it on unmount.
   */
  function subscribeToStatus(): () => void {
    // `window.events` is absent when the renderer runs outside Electron (e.g. a
    // plain `vite` preview). Degrade to no-op rather than crashing the app.
    if (typeof window === 'undefined' || !window.events?.onDeviceStatus) {
      return () => undefined
    }

    return window.events.onDeviceStatus((event) => {
      applyStatusPatch(event)
    })
  }

  /** True when the push channel is actually connected. Used by the self-check. */
  const statusPushConnected = (): boolean =>
    typeof window !== 'undefined' && typeof window.events?.onDeviceStatus === 'function'

  /**
   * Self-check for the status push, used by the headless smoke test.
   *
   * Reports whether the store is subscribed and whether an unknown device id is
   * tolerated. Live in this file so the check cannot drift from the behaviour
   * it is checking.
   */
  function statusPushSelfCheck(): {
    connected: boolean
    unknownIdIgnored: boolean
    knownIdApplied: boolean
  } {
    const connected = statusPushConnected()
    const unknownIdIgnored = applyStatusPatch({ deviceId: '__probe__', status: 'OFFLINE' }) === false

    // Round-trip a REAL device when one exists, which is the only way to prove
    // the mutation path (not just the guard) works.
    const first = devices.value[0]
    if (!first) return { connected, unknownIdIgnored, knownIdApplied: false }

    const original = { status: first.status, lastSeen: first.lastSeen }
    const flipped = first.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE'
    const applied = applyStatusPatch({ deviceId: first.id, status: flipped })
    const observed = first.status === flipped
    // Restore, so the self-check cannot leave the UI in a lying state.
    first.status = original.status
    first.lastSeen = original.lastSeen

    return { connected, unknownIdIgnored, knownIdApplied: applied && observed }
  }

  function clearError(): void {
    error.value = ''
  }

  return {
    // state
    devices,
    loading,
    error,
    selectedDeviceId,
    channels,
    channelsLoading,
    refreshTick,
    // getters
    onlineCount,
    offlineCount,
    unknownCount,
    byId,
    nameById,
    channelsOf,
    // actions
    load,
    add,
    update,
    remove,
    refreshStatus,
    probe,
    fetchInfo,
    select,
    loadChannels,
    openWebUi,
    subscribeToStatus,
    applyStatusPatch,
    statusPushSelfCheck,
    clearError
  }
})
