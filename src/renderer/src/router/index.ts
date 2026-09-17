/**
 * Router (spec section 8.1 main navigation).
 *
 * `createWebHashHistory` is REQUIRED: packaged Electron loads the renderer from
 * `file://`, and history mode would 404 on every deep link / reload.
 *
 * Route meta drives the topbar title and the sidebar highlighting, so a new
 * page only has to be declared once.
 *
 * `titleKey` IS A TRANSLATION KEY, NOT A TITLE
 * Storing the key means the title, the window caption and the sidebar entry all
 * re-render when the language changes. A stored string would freeze at whatever
 * language was active when this module was first evaluated — which, because the
 * router module is evaluated once at startup, is always the startup language.
 */

import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { documentTitle } from '@renderer/i18n'

declare module 'vue-router' {
  interface RouteMeta {
    /** Translation key for the page title, rendered by AppTopbar. */
    titleKey: string
    /** Whether the route appears in the main sidebar navigation. */
    nav?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'overview',
    component: () => import('@renderer/views/OverviewView.vue'),
    meta: { titleKey: 'app.nav.overview', nav: true }
  },
  {
    path: '/devices',
    name: 'devices',
    component: () => import('@renderer/views/DevicesView.vue'),
    meta: { titleKey: 'app.nav.devices', nav: true }
  },
  {
    path: '/devices/:id',
    name: 'device-detail',
    component: () => import('@renderer/views/DeviceDetailView.vue'),
    props: true,
    meta: { titleKey: 'app.nav.deviceDetail' }
  },
  {
    path: '/map',
    name: 'map',
    component: () => import('@renderer/views/DeviceMapView.vue'),
    meta: { titleKey: 'app.nav.map', nav: true }
  },
  {
    path: '/monitor',
    name: 'monitor',
    component: () => import('@renderer/views/MonitorView.vue'),
    meta: { titleKey: 'app.nav.monitor', nav: true }
  },
  {
    path: '/alarms',
    name: 'alarms',
    component: () => import('@renderer/views/AlarmsView.vue'),
    meta: { titleKey: 'app.nav.alarms', nav: true }
  },
  {
    /**
     * 事件与告警中心。
     *
     * 与 `/alarms` 并列而不是替换它：那一页只是声纹设备自己的告警行，
     * 这一页把三路来源（相机检测日志 / 本机联动 / 声纹告警）合并成一条时间线。
     */
    path: '/events',
    name: 'events',
    component: () => import('@renderer/views/EventCenterView.vue'),
    meta: { titleKey: 'app.nav.events', nav: true }
  },
  {
    path: '/recordings',
    name: 'recordings',
    component: () => import('@renderer/views/RecordingsView.vue'),
    meta: { titleKey: 'app.nav.recordings', nav: true }
  },
  {
    /**
     * 本地异常声纹样本库（schema v7）。放在「录音文件」之后：这一页的内容**从录音派生**，
     * 阅读顺序也是"先看素材、再看从素材里挑出来的训练样本"。
     */
    path: '/samples',
    name: 'samples',
    component: () => import('@renderer/views/SamplesView.vue'),
    meta: { titleKey: 'app.nav.samples', nav: true }
  },
  {
    // Phase 11. `createWebHashHistory` above stays as-is: packaged Electron
    // loads from `file://`, where history mode 404s on every reload.
    path: '/trends',
    name: 'trends',
    component: () => import('@renderer/views/TrendsView.vue'),
    meta: { titleKey: 'app.nav.trends', nav: true }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@renderer/views/SettingsView.vue'),
    meta: { titleKey: 'app.nav.settings', nav: true }
  },
  {
    path: '/protocol-lab',
    name: 'protocol-lab',
    component: () => import('@renderer/views/ProtocolLabView.vue'),
    meta: { titleKey: 'app.nav.protocolLab', nav: true }
  },
  // Unknown hash (e.g. a stale bookmark) falls back to the overview rather than
  // rendering an empty shell.
  { path: '/:pathMatch(.*)*', redirect: '/' }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.afterEach((to) => {
  document.title = documentTitle(to.meta.titleKey)
})

export default router
