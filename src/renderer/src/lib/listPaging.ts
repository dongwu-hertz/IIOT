/**
 * 列表翻页的**纯函数**（业主 2026-09-19 第 11 批第 5 条：
 * 「设备列表默认最大显示 10 个设备，超过 10 个设备则翻页」）。
 *
 * WHY IT IS A SEPARATE MODULE
 * "第几页"是一个**可以被问坏**的状态：设备从 23 台删到 3 台之后，页码还停在 5 ——
 * 屏幕上就会是一张空表，而数据一条不少。所以页码不直接存，而是**每次都夹一遍**
 * （`clampPage`），并且只在这一处算这个夹取。渲染层（`DeviceMapView`）只读结果。
 *
 * 纯函数、无 DOM：`tests/device-map-paging.test.ts` 直接断言。
 */

/** 设备列表每页最多几台（业主给的就是 10）。 */
export const DEVICE_MAP_PAGE_SIZE = 10

/** 一共几页。0 台也算 1 页 —— "第 1 页 / 共 1 页"比"第 0 页 / 共 0 页"好读。 */
export function listPageCount(total: number, size: number = DEVICE_MAP_PAGE_SIZE): number {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const perPage = Number.isFinite(size) && size >= 1 ? Math.floor(size) : DEVICE_MAP_PAGE_SIZE
  return Math.max(1, Math.ceil(count / perPage))
}

/**
 * 把页码夹进 `1..pageCount`。
 *
 * 非数字（`NaN`、`undefined`）与小数都归一到 1：页码来自界面，坏值是常态而不是意外。
 */
export function clampListPage(
  page: number,
  total: number,
  size: number = DEVICE_MAP_PAGE_SIZE
): number {
  const pages = listPageCount(total, size)
  if (!Number.isFinite(page)) return 1
  const rounded = Math.floor(page)
  if (rounded < 1) return 1
  return rounded > pages ? pages : rounded
}

/** 这一页要显示的那几条（越界的页码先夹一遍，所以永远不会返回空页）。 */
export function listPageSlice<T>(
  items: readonly T[],
  page: number,
  size: number = DEVICE_MAP_PAGE_SIZE
): T[] {
  const perPage = Number.isFinite(size) && size >= 1 ? Math.floor(size) : DEVICE_MAP_PAGE_SIZE
  const current = clampListPage(page, items.length, perPage)
  const start = (current - 1) * perPage
  return items.slice(start, start + perPage)
}
