<script setup lang="ts">
/**
 * Top bar: current page title, the three site indicators and the manual refresh.
 *
 * "刷新" re-probes every device through the main process (`devices.refreshStatus`)
 * and bumps `refreshTick`, which the overview view watches to re-run its own
 * dashboard queries. The renderer never reaches a device itself.
 *
 * THE INDICATORS REPLACED A SENTENCE
 * The bar used to print "在线 3 / 5 台" plus a hover summary of the offline and
 * unknown counts. The product owner asked for product-style chrome instead of a
 * line of text, so the same facts are now three compact indicators — total
 * devices, online devices, unacknowledged alarms — each of which navigates to
 * the page that owns it.
 *
 * WHY THE ALARM COUNT IS NOT ON THE LINKAGE STORE
 * The pending-linkage badge (`AlarmLinkagePanel`) counts LOCAL linkage notices.
 * The bell counts what the alarm log holds, which is the number an operator acts
 * on, so it asks `alarms.query({ acknowledged: false, limit: 1 })` and reads
 * `page.total` — `limit: 1` because only the total is wanted, and no new IPC
 * channel is introduced for it. The linkage push is still used, but only as a
 * *reason to re-ask*: a fresh notice means the alarm log moved too.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useDevicesStore } from '@renderer/stores/devices'
import { useUiRefreshStore } from '@renderer/stores/uiRefresh'
import { formatDateTime } from '@renderer/lib/format'
import { documentTitle, pageTitle } from '@renderer/i18n'
import AlarmLinkagePanel from '@renderer/components/AlarmLinkagePanel.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const devices = useDevicesStore()
const uiRefresh = useUiRefreshStore()

const refreshing = ref(false)
const lastRefreshAt = ref(0)

/**
 * Page title, resolved through the translation key.
 *
 * THE `typeof` GUARD IS LOAD-BEARING, not defensive noise.
 * Before the router finishes its first resolution, `route.meta` is the empty
 * `START_LOCATION` meta, so `titleKey` is `undefined`. Passing that straight to
 * vue-i18n throws — and it throws a bare `SyntaxError: 17` with no call site,
 * which surfaces as an uncaught component error on every startup and is very
 * hard to trace back to this line. Falling back to the app name keeps the first
 * paint correct until the real route arrives, which the same computed then
 * re-evaluates against.
 */
const title = computed(() => pageTitle(route.meta.titleKey))

/** Device tooltip keeps the offline/unknown breakdown the old summary line carried. */
const devicesHint = computed(
  () =>
    `${t('widgetsUi.indicatorDevices')} · ` +
    t('widgetsUi.offlineUnknownSummary', {
      offline: devices.offlineCount,
      unknown: devices.unknownCount
    })
)

/**
 * Keep the window caption in step with the language.
 *
 * The router sets `document.title` on navigation only, so without this a user
 * who switches language while sitting on a page keeps the previous language in
 * the window caption, the taskbar entry and the alt-tab switcher — the one piece
 * of UI that is visible while the app is not.
 */
watch([locale, () => route.meta.titleKey], () => {
  document.title = documentTitle(route.meta.titleKey)
})

function go(path: string): void {
  void router.push(path)
}

async function refresh(): Promise<void> {
  refreshing.value = true
  try {
    await devices.refreshStatus()
    /*
     * 同时让**当前这一页**重读它自己的数据（业主 2026-09-19 更正第 4 条：页面里那几颗
     * 单独的刷新按钮都删掉了，顶栏这一颗成了唯一的刷新）。
     * 顶栏不认识任何一页，只把"该重读了"这件事说出去；每一页按自己的方式重读
     * （有的重查库、有的只重读诊断读数）—— 见 `stores/uiRefresh.ts`。
     */
    uiRefresh.bump()
    lastRefreshAt.value = Date.now()
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__title">
      <h1 class="topbar__heading">{{ title }}</h1>
      <span v-if="lastRefreshAt" class="topbar__timestamp">
        {{ t('widgetsUi.lastRefresh', { time: formatDateTime(lastRefreshAt) }) }}
      </span>
    </div>

    <!--
      页面自己的顶栏控件（当前只有「实时监测」的设备下拉）。
      
      为什么留一个**空容器**而不是给顶栏加一堆 prop：页面级的下拉描述的是"这一屏在看哪台设备"，
      而它必须与右侧的设备总数/在线数/告警图标同一行（业主 2026-09-17：「设备下拉移到顶栏」）。
      用容器 + `Teleport` 让页面把控件投进来，顶栏就不必知道有哪些页面、每个页面有什么控件；
      `id` 是唯一的契约，而它只在一个地方被引用（`MonitorView`）。
      
      宽度由**顶栏**决定（这一格 `flex: 1 1 50%` + `max-width: 50%`）：业主指定 50%，
      那是布局的规矩，不该由每个页面各写一遍。页面自己投进来的控件再按需在这格里收窄
      （实时监测页的设备下拉是这一格的 50%、靠右，见 `MonitorView` 的 `.topbar-device`）。
    -->
    <div id="topbar-page-slot" class="topbar__page-slot"></div>

    <div class="topbar__actions">
      <div class="indicators">
        <!-- 设备总数 -->
        <button
          type="button"
          class="indicator"
          :title="devicesHint"
          :aria-label="t('widgetsUi.indicatorDevices')"
          @click="go('/devices')"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2.2" y="3.6" width="11.6" height="8.8" rx="1.6" />
            <path d="M2.2 6.6h11.6" />
            <path d="M4.4 10.6h2.4" />
          </svg>
          <span class="indicator__value">{{ devices.devices.length }}</span>
        </button>

        <!-- 在线设备 -->
        <button
          type="button"
          class="indicator"
          :title="t('widgetsUi.indicatorOnline')"
          :aria-label="t('widgetsUi.indicatorOnline')"
          @click="go('/devices')"
        >
          <span
            class="dot"
            :class="devices.onlineCount > 0 ? 'dot--online' : 'dot--offline'"
            aria-hidden="true"
          ></span>
          <span class="indicator__value">{{ devices.onlineCount }}</span>
        </button>

        <!--
          告警：**唯一**的告警入口（产品要求：待处理告警与告警图标合在一起）。
          点它展开的是 `AlarmLinkagePanel` 那张面板：有待处理告警就列出来，没有就写
          「当前无告警」；角标数字与列表同源，面板底部有去「告警记录」页的出口。
        -->
        <AlarmLinkagePanel />
      </div>

      <!--
        刷新：只留图标（业主 2026-09-16：「大标题栏的刷新按钮中的文字删除，只需要保留图标」）。
        文字去掉之后**必须**补上 `title` 与 `aria-label` —— 一个只有图形的按钮在读屏里是
        "按钮"，而它是顶栏唯一的全局动作。旋转动画也保留：它原来与文字一起表示"正在刷新"。
      -->
      <button
        type="button"
        class="btn btn--icon"
        :title="refreshing ? t('deviceDetailUi.refreshing') : t('common.refresh')"
        :aria-label="refreshing ? t('deviceDetailUi.refreshing') : t('common.refresh')"
        :disabled="refreshing"
        @click="refresh"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          :class="{ spin: refreshing }"
          aria-hidden="true"
        >
          <path d="M13.5 8a5.5 5.5 0 11-1.9-4.15" />
          <path d="M13.6 2.4v3.4h-3.4" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  height: var(--topbar-height);
  flex: none;
  padding: 0 var(--space-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
}

.topbar__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.topbar__heading {
  font-size: 15px;
  font-weight: 600;
}

.topbar__timestamp {
  font-size: 11.5px;
  color: var(--color-text-secondary);
}

/*
 * 页面投进来的控件所在的那一格：**固定 50% 宽**（业主指定），并且可以收缩
 * （`min-width: 0`：设备名很长时下拉自己截断，而不是把右侧三个指示器挤出去）。
 *
 * `margin-left: auto` 是**载荷**：顶栏是 `space-between`，标题、这一格与右侧动作组之间
 * 会有剩余空间 —— 那些空间会平均落到两个缝里，于是这一格的右边缘离右侧动作组还差一百多像素
 * （实测 184px），业主第 6 条要的「紧挨着右侧的设备数量」就不成立。
 * 自动外边距会把剩余空间**全部**吸到这一格左边，于是它右边缘与动作组之间只剩顶栏那个 16px 间距，
 * 而标题仍然靠左、右侧动作组仍然贴在窗口右边。
 *
 * 里面没有东西时它仍然占位 —— 顶栏的高度与右侧指示器的位置因此不随页面变化而跳动，
 * 这正是"标题栏"该有的稳定性。
 */
.topbar__page-slot {
  flex: 1 1 50%;
  min-width: 0;
  max-width: 50%;
  margin-left: auto;
  display: flex;
  align-items: center;
}

.topbar__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
}

/* --- 三个指示器 ---------------------------------------------------------- */

.indicators {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-bg-subtle);
}

.indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 30px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.indicator:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.indicator:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.indicator__value {
  font-weight: 600;
  color: var(--color-text);
}

/*
 * 这里原来还有 `.indicator--bell` / `.indicator__bell` / `.indicator__badge` 三块样式，
 * 是那颗「未确认告警」铃铛的。产品要求把待处理告警并进告警图标之后，那颗铃铛被
 * `AlarmLinkagePanel` 取代，样式也跟着删掉 —— 留着它们，下一个人会以为顶栏还有第二颗铃。
 */

/*
 * 这里原来还有一条 `.topbar__error`：它把 `devices.error` 画成顶栏下面一条**绝对定位**的
 * 横幅。问题是它在每一页都在，而且盖在内容上 —— 业主 2026-09-18 要求这类应用级失败放进
 * 右上角那颗告警图标里（而不是在软件顶上再加一条信息）。现在它由 `stores/appNotices.ts`
 * 收着、在 `AlarmLinkagePanel` 的面板里列出来；那条横幅与它的样式一起删掉。
 */

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
