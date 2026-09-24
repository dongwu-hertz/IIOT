<script setup lang="ts">
/**
 * Application shell: fixed sidebar + topbar + routed content.
 *
 * The shell owns nothing but layout — page data lives in the views and their
 * stores, so a view can be reloaded/replaced without touching the chrome.
 *
 * It does own exactly two session-scoped lifecycles, because they must live
 * precisely as long as the window does:
 *   1. the initial device list load (every selector reads from that store), and
 *   2. the device-status push subscription from the main-process health monitor.
 *
 * 它还负责一件**应用级**的事吗？不 —— 那件事现在住在 store 里：设备侧的三条**读**路径
 * （设备列表 / 通道表 / 状态刷新）各自把失败报进「系统消息」（`stores/devices.ts` 的
 * `reportReadError()`，显示在顶栏那颗告警图标的面板里）。放在 store 而不是 shell：只有
 * 读路径该报（增删改那类是你刚点的那一下的结果，由对话框就地说明），而"这是不是一次读"
 * 只有 store 最清楚。业主 2026-09-18 要求这类内容进那颗图标、不要挂在页面顶上。
 *
 * WHY THIS IS A SEPARATE COMPONENT FROM App.vue
 * Both lifecycles are session-scoped work: loading the device list and
 * subscribing to status pushes must not happen before somebody is signed in.
 * App.vue gates with `v-if`, so this component is not mounted at all while the
 * login screen is on screen — a `v-show` (or handing the shell merely a hidden
 * class) would still run `onMounted` and reach the devices IPC before there is a
 * session to authorise it.
 */
import { onMounted, onUnmounted, watch } from 'vue'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import AppTopbar from '@renderer/components/AppTopbar.vue'
import AppFooter from '@renderer/components/AppFooter.vue'
import DeviceDetailDialog from '@renderer/components/DeviceDetailDialog.vue'
import { useDevicesStore } from '@renderer/stores/devices'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'
import { useSettingsStore } from '@renderer/stores/settings'
import { useAlarmCenterModeStore } from '@renderer/stores/alarmCenterMode'
import { playAlarmPopupSound } from '@renderer/lib/alarmSoundPlayer'

const devices = useDevicesStore()
const linkage = useAlarmLinkageStore()
const settingsStore = useSettingsStore()
const alarmCenter = useAlarmCenterModeStore()

/**
 * 待处理告警的订阅。
 *
 * 与设备状态推送同一规则，但**多一个理由**：待处理列表就是「提示」的载体，
 * 而提示必须活过页面切换。订阅挂在 shell 上（shell 与窗口同寿命），
 * 而不是任何视图的 `onMounted` 里——视图会卸载，提示不能跟着消失。
 */
let unsubscribeLinkage: (() => void) | undefined

/**
 * 告警提示音（业主 2026-09-23：「告警默认开启，并且默认弹窗和播放声音」+
 * 「一直不处理就持续播放，直到处理或手动关闭弹窗」）。
 *
 * 挂在 shell 上的理由与订阅相同：提示音属于**这次告警**，不属于某个页面——
 * 操作员切到设置页时来的告警照样该响。弹窗窗口本身播不了声音（它只有一行
 * 关闭用的内联脚本，见 `linkage-actions.ts`），所以声音由主窗口播放。
 *
 * 两条机制：
 *   1. **新告警到达立即响一次**（按 eventId 记账，同一条不重响；首次快照只记账
 *      不响——开机把积压告警挨个播一遍是噪音）；
 *   2. **只要还有未确认的告警，每 4 秒重复响一次**——直到用户在铃铛面板确认
 *      （unacknowledgedCount 归零）或手动关掉告警弹窗（主进程把那条事件确认掉，
 *      快照推送回来这里自然停）。
 */
const soundedAlarmIds = new Set<string>()
let alarmSoundPrimed = false
let alarmSoundTimer: ReturnType<typeof setInterval> | undefined

/** 未确认告警的持续提示间隔（`playAlarmPopupSound` 自己还有一道 1.5 s 节流）。 */
const ALARM_SOUND_REPEAT_MS = 4_000

watch(
  () => linkage.pending,
  (items) => {
    const fresh = items.filter((item) => !item.acknowledged && !soundedAlarmIds.has(item.eventId))
    for (const item of items) soundedAlarmIds.add(item.eventId)
    // 淘汰掉的 id 允许以后再次发声：容量有限，集合不能无界增长。
    if (soundedAlarmIds.size > 1024) {
      const live = new Set(items.map((item) => item.eventId))
      for (const id of [...soundedAlarmIds]) if (!live.has(id)) soundedAlarmIds.delete(id)
    }
    if (!alarmSoundPrimed) {
      alarmSoundPrimed = true
      return
    }
    if (fresh.length > 0) playAlarmPopupSound(settingsStore.settings?.alarmSounds)
  }
)

watch(
  () => linkage.unacknowledgedCount,
  (count) => {
    /*
     * 告警中心这一屏上**不重复催办**（业主 2026-09-26 第 5 条：「告警中心中应该支持
     * 非告警弹窗的问题」）。那一页的中心就是一整幅宽的告警详情，告警本身已经在眼前，
     * 每 4 秒再响一次是同一个事实的第二个提醒。
     *
     * 只挡"持续催办"，不挡下面那个"新告警到达响一次" —— 那一条是告警本身的通知，
     * 在任何页面上都该响。
     */
    if (alarmCenter.quietForNotifications) {
      if (alarmSoundTimer !== undefined) {
        clearInterval(alarmSoundTimer)
        alarmSoundTimer = undefined
      }
      return
    }
    if (count > 0 && alarmSoundTimer === undefined) {
      alarmSoundTimer = setInterval(() => {
        playAlarmPopupSound(settingsStore.settings?.alarmSounds)
      }, ALARM_SOUND_REPEAT_MS)
    } else if (count === 0 && alarmSoundTimer !== undefined) {
      clearInterval(alarmSoundTimer)
      alarmSoundTimer = undefined
    }
  },
  // 进出告警中心时也要重新判一次：那一刻 count 没变，但"要不要响"变了。
  { immediate: true }
)

/** 进出告警中心：把正在跑的那条催办定时器按新状态收掉或放开。 */
watch(
  () => alarmCenter.onScreen,
  (onScreen) => {
    if (onScreen && alarmSoundTimer !== undefined) {
      clearInterval(alarmSoundTimer)
      alarmSoundTimer = undefined
      return
    }
    if (!onScreen && linkage.unacknowledgedCount > 0 && alarmSoundTimer === undefined) {
      alarmSoundTimer = setInterval(() => {
        playAlarmPopupSound(settingsStore.settings?.alarmSounds)
      }, ALARM_SOUND_REPEAT_MS)
    }
  }
)

/**
 * Unsubscribe handle for the status push.
 * Held so `onUnmounted` can release it — the preload bridge keeps a reference
 * to the IPC listener, so an unreleased subscription leaks for the app's life.
 */
let unsubscribeStatus: (() => void) | undefined

onMounted(() => {
  // Load the device list once for the whole session: the sidebar, topbar and
  // every selector read from this store.
  void devices.load()

  // 告警提示音要读声音库绑定（`alarmSounds.popup`）；设置页没打开过时这里补一次加载。
  if (!settingsStore.loaded) void settingsStore.load()

  // Then let the main process tell us when a device goes offline or comes back,
  // instead of polling it a second time from the renderer (spec 13.2).
  unsubscribeStatus = devices.subscribeToStatus()

  /**
   * 先读一次权威快照再订阅推送。
   *
   * 顺序是刻意的：反过来会丢掉「读取请求在途时到达的那一条告警」。
   * 两个方向都覆盖的方式是「订阅 + 读取」，读取的结果覆盖镜像，
   * 而推送里带的**也是**完整快照（不是增量），所以两者不会互相污染。
   */
  unsubscribeLinkage = linkage.subscribe()
  void linkage.load()
  void linkage.loadStatus()

  // Verifying that a subscription WORKS requires a way to observe it from the
  // outside. This installs a probe on `window` so the headless smoke test can
  // confirm the push channel is live and that an unknown device id is ignored.
  //
  // Gated on an explicit flag rather than always-on: a probe that exposes store
  // internals has no business existing in a shipped build, and leaving one
  // permanently attached would be exactly the kind of thing that later gets
  // reachable from a device's own web page.
  if (import.meta.env.VITE_SMOKE_PROBE === '1') {
    ;(window as unknown as { __hertzinnoSelfCheck?: () => unknown }).__hertzinnoSelfCheck = () =>
      devices.statusPushSelfCheck()
  }
})

onUnmounted(() => {
  unsubscribeStatus?.()
  unsubscribeStatus = undefined
  unsubscribeLinkage?.()
  unsubscribeLinkage = undefined
  // 持续提示音的定时器随外壳一起收（外壳与窗口同寿命，正常不会触发，保险起见）。
  if (alarmSoundTimer !== undefined) {
    clearInterval(alarmSoundTimer)
    alarmSoundTimer = undefined
  }
})
</script>

<template>
  <div class="app-shell">
    <AppSidebar />
    <div class="app-main">
      <AppTopbar />
      <main class="app-content">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
      <!--
        页脚在 `.app-content` **之外**：内容区是滚动容器，页脚放进去会跟着内容滚走，
        而「页脚」的定义就是它一直在底部。外层 `.app-main` 用 flex 把它按住。
      -->
      <AppFooter />
    </div>
    <!--
      设备详情弹窗的全局宿主（业主 20260921）：设备管理 / 地图 / 告警 / 事件中心
      四处入口经 `stores/deviceDetailDialog` 打开它，打开状态只有这一份。
      放在 `.app-main` 之外、`.app-shell` 之下：遮罩是 `position: fixed`，
      挂哪都一样盖住整个窗口，而详情路由（`/devices/:id` 整页）不经过它。
    -->
    <DeviceDetailDialog />
  </div>
</template>
