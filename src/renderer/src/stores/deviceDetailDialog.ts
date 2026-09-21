/**
 * 设备详情**弹窗**的打开状态（业主 20260921：设备详情从整页改为弹窗）。
 *
 * 设备管理 / 地图 / 告警 / 事件中心四处入口不再 `router.push('/devices/:id')`，而是
 * `show(id, name)` 在这里登记一台设备；真正的弹窗宿主只有一个（`AppShell` 挂的
 * `DeviceDetailDialog`），任何页面想打开详情都走这一条 —— 否则每页各自包一个
 * AppModal，打开状态就有好几份，"详情弹窗开着"这件事就没有一处能查。
 *
 * `/devices/:id` 路由**保留**（深链直达仍然是整页），所以这份状态只管弹窗：
 * 全页路由语境不读它。与 `stores/uiRefresh.ts` 同一条理由用 Pinia 而不是模块级 ref：
 * 它被多个互不相关的组件共享，生命周期比组件长、比进程短。
 *
 * 三个字段各司其职：
 *   - `open`：AppModal 的 v-model 本体；
 *   - `deviceId`：弹窗里那份 `DeviceDetailView` 的 `:id`（弹窗打开期间不变）；
 *   - `title`：弹窗标题栏写的设备名 —— 标题是**打开那一刻**的事实，调用方手里
 *     正好有这台设备，顺手传进来，弹窗宿主就不必为拿一个名字再读一次设备列表。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useDeviceDetailDialogStore = defineStore('deviceDetailDialog', () => {
  const open = ref(false)
  const deviceId = ref('')
  const title = ref('')

  function show(id: string, deviceTitle = ''): void {
    deviceId.value = id
    title.value = deviceTitle
    open.value = true
  }

  function close(): void {
    open.value = false
  }

  return { open, deviceId, title, show, close }
})
