/**
 * 「地图信息」页的**定位入口**（业主 2026-09-18 第 10 批第 7 条后半：地址信息要「支持 GIS 显示」）。
 *
 * ---------------------------------------------------------------------------
 * "支持 GIS 显示"在我们的架构里是什么
 * ---------------------------------------------------------------------------
 * 本机**不联网取瓦片**（离线优先；`renderer` 的 CSP 也把它挡在外面），所以"GIS 显示"不是
 * 嵌一张在线地图，而是：**把录进去的点位真正画到「地图信息」页上，并且能从别处一键定位到它**。
 * 这条路由参数就是那个"一键"：地址信息卡片上那句「在地图信息里查看」→ `/map?device=<id>`
 * → 地图页选中这一台、把它的悬停卡打开、把它的那一行滚到视野里。
 *
 * 三件事写成纯函数（而不是散在两个组件里）：
 *   1. **只有点位成对**（`hasMapPoint`）才给这个入口 —— 半截坐标落不了图，
 *      给一个点了什么也没有的链接比不给更糟；
 *   2. 参数解析**只认字符串**：`?device=` 可能缺失、可能是数组（重复参数）、可能是别的东西，
 *      把 `undefined` 当成设备 id 会让地图页去查一台叫 "undefined" 的设备；
 *   3. 生成的链接形状只有一处 —— 两处各拼一次字符串，改路由名时必漏一处。
 */

import type { DeviceInstallation } from '@shared/domain/models'
import { hasMapPoint } from '@shared/domain/device-map'

/** 「地图信息」页的路由路径（`app.nav.map` 那一页）。 */
export const DEVICE_MAP_ROUTE = '/map'

/**
 * 这一台能不能落图：经纬度**成对**才算。
 *
 * 直接引用共享层的 `hasMapPoint()`，不在这里重写一遍判据 —— 地图页用什么判"有点位"，
 * 这里就必须用什么判"给不给入口"，否则会出现"卡片上有链接、点过去那一台不在图上"。
 */
export function isMappable(installation: DeviceInstallation | undefined): boolean {
  if (!installation) return false
  // `hasMapPoint()` 只用到 latitude / longitude，其余字段（id / name）是它的入参形状带来的；
  // 这里给两个占位值，**不复制**它那条"成对且有限"的判据（那正是要分开的唯一原因）。
  return hasMapPoint({
    id: '',
    name: '',
    latitude: installation.gisLatitude,
    longitude: installation.gisLongitude
  })
}

/** 地址信息卡片上那个入口的跳转目标（只在 `isMappable()` 为真时有意义）。 */
export function deviceMapLink(deviceId: string): { path: string; query: { device: string } } {
  return { path: DEVICE_MAP_ROUTE, query: { device: deviceId } }
}

/**
 * 从路由 query 里读出要定位的设备 id；没有/不合法就是空串。
 *
 * 重复参数在 vue-router 里是**数组**，那种情况也当"没给"：猜一个"第一个"来定位，
 * 会让"两个 device 参数"这种明显坏掉的链接表现得像正常链接。
 */
export function deviceMapFocusId(query: unknown): string {
  if (query === null || typeof query !== 'object') return ''
  const value = (query as Record<string, unknown>).device
  if (typeof value !== 'string') return ''
  return value.trim()
}
