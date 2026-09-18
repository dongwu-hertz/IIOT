/**
 * 系统消息（应用级失败与提示）——住在顶栏那颗**告警图标**后面的面板里。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这一份，以及为什么不再往页首放横幅
 * ---------------------------------------------------------------------------
 * 业主 2026-09-18 的原话：「认证失败，检测用户名和密码 这些告警内容，直接放在右上角的告警
 * ICON 内，而不是在软件中进行顶部添加信息。要确保整体的布局不会因为告警等内容而改变」。
 *
 * 在这之前，同一个失败会**同时**出现在两个地方：
 *   1. 顶栏下面那条浮动横幅（`AppTopbar` 的 `.topbar__error`，读 `devices.error`）——
 *      它在每一页都在，一条「认证失败，请检查用户名和密码（AUTH_FAILED）」就这样挂在
 *      所有页面的顶上；它是绝对定位的，所以不推内容，但**盖在内容上**；
 *   2. 各页面自己把 store 的错误画在 `.page` 的第一行（`alarms.error` / `samples.error` /
 *      `store.error` / `monitor.error` / `settings.error` …）—— 这些是**在流里**的，
 *      出现与消失会把整页往下推或往上收。
 * 两个都不对：那是**应用级**的事实（设备列表读不出来、设置读不出来），不是「这一页的内容」，
 * 而它出现在哪一页纯属偶然。
 *
 * 现在的口径（这一份就是那条口径的实现）：
 *   - **应用级失败进这里**，在告警图标的面板里逐条列出（可以逐条忽略，也可以一次清掉）；
 *   - 面板是浮层（`position: absolute`），所以它的出现与消失**不改变任何布局**；
 *   - 页面自己的**就地反馈**（表单校验、对话框里的失败、你刚点的那一下的结果、卡片自身的
 *     说明）**不进来** —— 那些话属于它发生的地方，搬到这里反而让人找不到。
 *
 * 一条问题只留一行（按 `id` 合并）：同一个来源再次报到时**只更新文案**，不追加第二行 ——
 * 一个每 30 秒失败一次的链路不该把面板刷成一片同样的字。`at` 记的是**第一次**被看到的时刻，
 * 同一条反复出现不会把它刷成"刚刚"（那会让一个存在了一小时的故障看起来刚发生）。
 * 问题消失（来源重新读成功）时由调用方 `clear(id)` 撤掉；操作员也可以自己忽略。
 *
 * **谁来报**：设备侧那三条**读**路径（设备列表 / 通道表 / 状态刷新）在 `stores/devices.ts`
 * 里各报一条（三个独立 id，各自读成功时各自撤掉）。增删改那一类**不报** —— 那是一次点击的
 * 结果，它已经在对话框/页面里就地说明过了；两处说同一句话会让人以为发生了两件事。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/** 只有两种：失败与「要你知道但不一定是错」。成功反馈不进这里（那属于点它的地方）。 */
export type AppNoticeKind = 'error' | 'warning'

export interface AppNotice {
  /** 稳定标识（页面/来源），同 id 只留一条。 */
  id: string
  kind: AppNoticeKind
  text: string
  /** **第一次**被观察到的时刻。 */
  at: number
}

/**
 * 最多留几条。
 *
 * 上限存在的理由不是美观：一个在渲染循环里失败的调用会不停 `report()`，没有上限的面板
 * 会变成一张无限长的名单。超出时丢**最早**的那条。
 */
export const MAX_APP_NOTICES = 12

/** 首次报到时的时刻（同一条再次出现不刷新它，见文件头）。 */
export interface AppNoticeInput {
  id: string
  text: string
  kind?: AppNoticeKind
  at?: number
}

export const useAppNoticesStore = defineStore('appNotices', () => {
  const entries = ref<AppNotice[]>([])

  /** 面板里逐条列出来的那些，最新的在最上面。 */
  const items = computed(() => [...entries.value].sort((left, right) => right.at - left.at))
  const count = computed(() => entries.value.length)

  /** 报一条（同 id 覆盖文案）。空白文案与空白 id 一律忽略：那是调用方的 bug，不是消息。 */
  function report(input: AppNoticeInput): void {
    const id = input.id.trim()
    const text = input.text.trim()
    if (id === '' || text === '') return
    const existing = entries.value.find((entry) => entry.id === id)
    if (existing) {
      /*
       * 同一条问题**再次**被观察到：文案可能变了（例如从"读取失败"变成具体的错误码），
       * 时间保持第一次那一刻。写成整条替换会让 `at` 一直往现在跑。
       */
      entries.value = entries.value.map((entry) =>
        entry.id === id ? { ...entry, text, kind: input.kind ?? entry.kind } : entry
      )
      return
    }
    const next: AppNotice = {
      id,
      kind: input.kind ?? 'error',
      text,
      at: input.at ?? Date.now()
    }
    const list = [...entries.value, next]
    entries.value = list.slice(Math.max(0, list.length - MAX_APP_NOTICES))
  }

  /** 撤掉一条（问题解决了，或操作员点了忽略）。 */
  function clear(id: string): void {
    entries.value = entries.value.filter((entry) => entry.id !== id)
  }

  function clearAll(): void {
    entries.value = []
  }

  return { items, count, report, clear, clearAll }
})
