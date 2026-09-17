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
 * WHY THIS IS A SEPARATE COMPONENT FROM App.vue
 * Both lifecycles are session-scoped work: loading the device list and
 * subscribing to status pushes must not happen before somebody is signed in.
 * App.vue gates with `v-if`, so this component is not mounted at all while the
 * login screen is on screen — a `v-show` (or handing the shell merely a hidden
 * class) would still run `onMounted` and reach the devices IPC before there is a
 * session to authorise it.
 */
import { onMounted, onUnmounted } from 'vue'
import AppSidebar from '@renderer/components/AppSidebar.vue'
import AppTopbar from '@renderer/components/AppTopbar.vue'
import AppFooter from '@renderer/components/AppFooter.vue'
import { useDevicesStore } from '@renderer/stores/devices'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'

const devices = useDevicesStore()
const linkage = useAlarmLinkageStore()

/**
 * Unsubscribe handle for the status push.
 * Held so `onUnmounted` can release it — the preload bridge keeps a reference
 * to the IPC listener, so an unreleased subscription leaks for the app's life.
 */
let unsubscribeStatus: (() => void) | undefined

/**
 * 待处理告警的订阅。
 *
 * 与设备状态推送同一规则，但**多一个理由**：待处理列表就是「提示」的载体，
 * 而提示必须活过页面切换。订阅挂在 shell 上（shell 与窗口同寿命），
 * 而不是任何视图的 `onMounted` 里——视图会卸载，提示不能跟着消失。
 */
let unsubscribeLinkage: (() => void) | undefined

onMounted(() => {
  // Load the device list once for the whole session: the sidebar, topbar and
  // every selector read from this store.
  void devices.load()

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
  </div>
</template>
