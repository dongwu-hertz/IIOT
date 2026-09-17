/**
 * 通道墙的显示偏好：分屏档位 + 当前页码 + 图形类型 + 是否收起。
 *
 * 为什么是 Pinia store + localStorage，而不是走 `window.api.settings`
 *   1. 这是**纯展示偏好**，不是设备配置。存进主进程的设置表意味着要加 IPC 字段、
 *      加数据库迁移、加一次跨进程往返，只为了记住“上次看的是 4 分屏”——而现在
 *      主进程里连“通道墙”这个概念都不存在，让渲染进程的排版细节去污染设备配置的
 *      契约是不划算的。
 *   2. 本仓库已经有一条“界面偏好写 localStorage”的既有约定：`composables/useLocale.ts`
 *      用 `hertzinno.locale` 记住语言，并且在 `try/catch` 里读写（无痕模式或受限
 *      profile 下读写会抛异常）。这里沿用同一套写法与同样的 `hertzinno.` 前缀，
 *      于是“本地偏好”只有一种实现方式，不会长出第二种。
 *   3. 用 store 而不是 `useLocale` 那样的模块级单例：这里有四个相互关联的值
 *      （档位、页码、图形、收起），而且组件会随路由反复挂载/卸载；store 天然是单例
 *      且响应式，组件卸载不会丢状态，也就能满足“切走再切回来还是刚才那一屏”。
 *
 * 为什么页码、图形、收起都留在这里，而不是组件里的 `ref`
 * 组件里的 `ref` 会随路由卸载一起消失，切走再切回来就会跳回第 1 页、跳回默认图形、
 * 并且把操作员刚展开的墙重新收起来 —— 而这三件事和“我在看 4 分屏”一样，都是他刚刚
 * 做过的选择。
 */

import { ref } from 'vue'
import { defineStore } from 'pinia'
import {
  DEFAULT_CHANNEL_GRAPH,
  DEFAULT_CHANNEL_WALL_LAYOUT,
  isChannelGraphKind,
  isChannelWallLayout,
  type ChannelGraphKind,
  type ChannelWallLayout
} from '@renderer/lib/channelWall'

/** localStorage 键名，沿用 `hertzinno.` 前缀（见 `shared/i18n/locales.ts`）。 */
export const CHANNEL_WALL_LAYOUT_STORAGE_KEY = 'hertzinno.channelWall.layout'
export const CHANNEL_WALL_PAGE_STORAGE_KEY = 'hertzinno.channelWall.page'
export const CHANNEL_WALL_GRAPH_STORAGE_KEY = 'hertzinno.channelWall.graph'
/**
 * 收起状态的键。
 *
 * **只在操作员真的点过之后才写入**。没写过表示“他没表过态”，此时收起与否完全由
 * `lib/channelWall.ts` 的 `defaultChannelWallCollapsed()` 依据“有没有通道在线”决定
 * （产品要求「如果没有通道在线就可以默认收起」）。把默认值也写进 localStorage 就会
 * 把这个决定冻在第一帧，之后再有没有通道在线都不会改变它。
 */
export const CHANNEL_WALL_COLLAPSED_STORAGE_KEY = 'hertzinno.channelWall.collapsed'

/**
 * 读回档位。
 *
 * 值可能来自旧版本、被手工改过、或干脆写坏；非法值一律退回默认档位，绝不让一个
 * 坏字符串流进模板（那会让分段控件一格都不高亮，看起来像坏了）。
 */
function readStoredLayout(): ChannelWallLayout {
  try {
    const raw = window.localStorage.getItem(CHANNEL_WALL_LAYOUT_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return isChannelWallLayout(parsed) ? parsed : DEFAULT_CHANNEL_WALL_LAYOUT
  } catch {
    // 无痕模式或受限 profile：退回默认档位。
    return DEFAULT_CHANNEL_WALL_LAYOUT
  }
}

/**
 * 读回图形类型。
 *
 * 与档位同一条规矩：`'16'`、`''`、被手工改坏的字符串一律退回默认图形，
 * 而不是让切换器一格都不高亮。
 */
function readStoredGraph(): ChannelGraphKind {
  try {
    const raw = window.localStorage.getItem(CHANNEL_WALL_GRAPH_STORAGE_KEY)
    return isChannelGraphKind(raw) ? raw : DEFAULT_CHANNEL_GRAPH
  } catch {
    return DEFAULT_CHANNEL_GRAPH
  }
}

/**
 * 读回收起状态。
 *
 * 三态而不是布尔：`null` = **操作员没有表过态**，收起与否交给数据决定（见
 * `CHANNEL_WALL_COLLAPSED_STORAGE_KEY` 的说明）。只有 `'true'` / `'false'` 两个字面量
 * 算表态，其余（`'1'`、`''`、被改坏的值）一律当作“没表过态”，因为“他说过要收起”和
 * “这个字符串看着像真”是两件事。
 */
function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(CHANNEL_WALL_COLLAPSED_STORAGE_KEY)
    if (raw === 'true') return true
    if (raw === 'false') return false
    return null
  } catch {
    return null
  }
}

/** 读回页码。只做“是不是正整数”的最低校验，真正的范围夹取由 `clampPage()` 负责。 */
function readStoredPage(): number {
  try {
    const raw = window.localStorage.getItem(CHANNEL_WALL_PAGE_STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  } catch {
    return 1
  }
}

function writeStored(key: string, value: string | number | boolean): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // 记不住偏好不应该让切换偏好本身失败。
  }
}

export const useChannelWallStore = defineStore('channelWall', () => {
  const layout = ref<ChannelWallLayout>(readStoredLayout())
  const page = ref<number>(readStoredPage())
  const graph = ref<ChannelGraphKind>(readStoredGraph())
  const collapsedOverride = ref<boolean | null>(readStoredCollapsed())

  /**
   * 切换档位，并回到第 1 页。
   *
   * 为什么重置页码：“8 分屏的第 3 页”与“1 分屏的第 3 页”指向的是完全不同的通道，
   * 两档之间的页码没有任何可换算的关系。回到第 1 页是唯一不会让人看错通道的映射；
   * 页码越界本来也会被 `clampPage()` 拉回来，显式重置只是让行为可预期。
   */
  function setLayout(next: ChannelWallLayout): void {
    if (!isChannelWallLayout(next)) return
    layout.value = next
    writeStored(CHANNEL_WALL_LAYOUT_STORAGE_KEY, next)
    setPage(1)
  }

  /** 记录当前页码。范围合法性由渲染时的 `clampPage()` 决定，这里只做持久化。 */
  function setPage(next: number): void {
    const normalised = Number.isFinite(next) && next >= 1 ? Math.floor(next) : 1
    page.value = normalised
    writeStored(CHANNEL_WALL_PAGE_STORAGE_KEY, normalised)
  }

  /**
   * 切换整面墙显示的图形。
   *
   * **不重置页码**（与档位不同）：页码指的是“这一批通道里的第几页”，换一种画法并
   * 不改变墙上摆的是哪几路通道，把操作员甩回第 1 页是凭空多出来的一次跳转。
   */
  function setGraph(next: ChannelGraphKind): void {
    if (!isChannelGraphKind(next)) return
    graph.value = next
    writeStored(CHANNEL_WALL_GRAPH_STORAGE_KEY, next)
  }

  /**
   * 操作员显式展开/收起这面墙。
   *
   * 写下去之后“跟随数据”的默认行为就交还给他的选择（见 `channelWallCollapsed()`）。
   */
  function setCollapsed(next: boolean): void {
    collapsedOverride.value = next === true
    writeStored(CHANNEL_WALL_COLLAPSED_STORAGE_KEY, next === true)
  }

  return {
    // state
    layout,
    page,
    graph,
    collapsedOverride,
    // actions
    setLayout,
    setPage,
    setGraph,
    setCollapsed
  }
})
