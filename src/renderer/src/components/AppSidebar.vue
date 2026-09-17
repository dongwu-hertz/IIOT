<script setup lang="ts">
/**
 * Main navigation (spec section 8.1).
 *
 * Icons are inline SVG on purpose — the spec forbids pulling in an icon
 * dependency for a handful of glyphs, and inline paths keep the CSP strict
 * (`img-src 'self' data:` still allows none of the usual icon-font tricks).
 *
 * WHAT THIS SIDEBAR OWNS, AFTER THE PRODUCT CHANGES
 *   - the brand mark (LOGO ONLY — the "Acoustic Box Manager / 设备管理软件" wordmark
 *     was removed by product request),
 *   - the page navigation,
 *   - the signed-in account menu and the online count.
 *
 * WHAT IT NO LONGER OWNS, and where each went
 *   - 设备拓扑 (the device tree)  -> `/devices`, as page content: the topology is
 *     part of device management, not of every screen.
 *   - the language picker        -> 系统设置 (`SettingsView`), next to the other
 *     application-level preferences.
 *   - the version + contact links -> the new page footer (`AppFooter.vue`), which
 *     also carries the copyright line.
 */
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useDevicesStore } from '@renderer/stores/devices'
import UserMenu from '@renderer/components/UserMenu.vue'

/**
 * Logo URL resolved by the bundler.
 *
 * `import` rather than a string path: Vite emits the file with a content hash and
 * rewrites the reference, which is what makes it survive packaging into an asar
 * archive. A hand-written `/assets/...` path would resolve in dev and 404 in the
 * installed application.
 */
import logoUrl from '@renderer/assets/branding/hertzinno-logo.png'

interface NavItem {
  path: string
  /**
   * Translation key, NOT the rendered text.
   *
   * Storing the key keeps the label reactive to a language change (a stored
   * string would freeze at whatever language was active when this array was
   * built), and it means a route and its label cannot drift apart.
   */
  labelKey: string
  /** SVG path data, 20x20 viewBox, stroked with currentColor. */
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', labelKey: 'app.nav.overview', icon: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z' },
  {
    path: '/devices',
    labelKey: 'app.nav.devices',
    icon: 'M4 6.5A2.5 2.5 0 016.5 4h7A2.5 2.5 0 0116 6.5v7A2.5 2.5 0 0113.5 16h-7A2.5 2.5 0 014 13.5zM7.5 16v2.5M12.5 16v2.5'
  },
  /**
   * 点位图（业主 2026-09-17 第 8 批）：按录入的 WGS84 点位画设备落点，点声呐看告警抓图。
   *
   * 图标是地图针：**这一页的入口必须看起来像"位置"**，否则操作员不会想到点位在这里看。
   * 放在设备管理之后、实时监测之前：它是"设备在哪"这一件事的视图，而实时监测是"看某一台"。
   */
  {
    path: '/map',
    labelKey: 'app.nav.map',
    icon: 'M10 17.6s6-5.5 6-9.7a6 6 0 10-12 0c0 4.2 6 9.7 6 9.7zM10 8a1.8 1.8 0 100 3.6A1.8 1.8 0 0010 8z'
  },
  { path: '/monitor', labelKey: 'app.nav.monitor', icon: 'M2 11h3l2.2-5.2L10 15l2.4-6.4L14 11h4' },
  {
    path: '/trends',
    labelKey: 'app.nav.trends',
    icon: 'M3.2 3v13.8h13.6M6 13.6l3.4-4 2.6 2.3 4.2-5.2'
  },
  {
    path: '/alarms',
    labelKey: 'app.nav.alarms',
    icon: 'M10 3a4.6 4.6 0 00-4.6 4.6c0 4-1.4 5.4-1.4 5.4h12s-1.4-1.4-1.4-5.4A4.6 4.6 0 0010 3zM8.4 15.6a1.8 1.8 0 003.2 0'
  },
  {
    /**
     * 事件与告警中心：三路来源合并后的一条时间线。
     *
     * 图标用「带对勾的清单」而不是重复告警铃铛：铃铛已经属于 `/alarms`
     * （只有声纹设备自己的告警行），这一页是「看全部事件并处理它」。
     */
    path: '/events',
    labelKey: 'app.nav.events',
    icon: 'M4 4.5h9.5M4 10h9.5M4 15.5h5.5M14.2 14.2l1.6 1.6 3.2-3.4'
  },
  {
    path: '/recordings',
    labelKey: 'app.nav.recordings',
    icon: 'M3 5.5A1.5 1.5 0 014.5 4h3l1.4 2h6.6A1.5 1.5 0 0117 7.5v7A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5z'
  },
  {
    path: '/settings',
    labelKey: 'app.nav.settings',
    icon: 'M4 6h12M4 10h12M4 14h12M7.5 4.2v3.6M12.5 8.2v3.6M6 12.2v3.6'
  },
  {
    path: '/protocol-lab',
    labelKey: 'app.nav.protocolLab',
    icon: 'M8 3h4M9 3v4.2L5.4 14a2 2 0 001.7 3h5.8a2 2 0 001.7-3L11 7.2V3M7.2 11.5h5.6'
  }
]

const route = useRoute()
const devices = useDevicesStore()
const { t } = useI18n()

/**
 * `/devices/:id` must keep the 设备管理 entry highlighted, so an exact path
 * comparison is not enough — hence the prefix rule (still exact for the root).
 */
function isActive(item: NavItem): boolean {
  if (item.path === '/') return route.path === '/'
  return route.path === item.path || route.path.startsWith(`${item.path}/`)
}

onMounted(async () => {
  /**
   * 设备列表仍由这里加载：侧栏在每个页面上都存在，所以它是**最早**挂载的那一块，
   * 而顶栏的三个图标（设备总数 / 在线 / 告警）读的就是这个 store。已加载过就不重复
   * 请求（store 是唯一缓存处），`AppShell` 里的那次加载因此成为幂等的第二道保险。
   */
  if (devices.devices.length === 0) await devices.load()
})
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__brand">
      <!--
        The official brand asset, imported so the bundler fingerprints and emits
        it — a runtime path would break inside the packaged asar.

        LOGO ONLY. The wordmark that used to sit next to it ("Acoustic Box Manager"
        over "设备管理软件") was removed by product request; the application's name is
        still carried by the window title, the About panel and the footer, so nothing
        became unfindable.
      -->
      <img
        class="sidebar__logo"
        :src="logoUrl"
        alt="HERTZINNO"
        width="44"
        height="24"
      />
    </div>

    <nav class="sidebar__nav" :aria-label="t('app.mainNavigation')">
      <RouterLink
        v-for="item in NAV_ITEMS"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ 'nav-item--active': isActive(item) }"
      >
        <svg
          class="nav-item__icon"
          width="18"
          height="18"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="item.icon" />
        </svg>
        <span class="nav-item__label">{{ t(item.labelKey) }}</span>
      </RouterLink>
    </nav>

    <!--
      设备拓扑树不再挂在这里：产品要求「设备拓扑应该在设备管理内容里面」，
      所以它随 `/devices` 页面渲染（见 `DevicesView.vue`）。导航（页面）与
      选择（设备）因此彻底分开：侧栏只管页面，拓扑只管设备。
    -->

    <div class="sidebar__footer">
      <!--
        这里原本还有一行「在线 X / 共 Y」。产品要求把设备总数与在线数放到右上角之后，
        侧栏这一行就成了同一组数字的第二处显示——两处数字迟早会在某一刻不一致，
        而操作员必须自己决定信哪一个。数字只留一处（顶栏的三个图标），这一格只放账户。
      -->

      <!--
        The signed-in account. It lives in the sidebar rather than the topbar
        because every destructive action in the app is authorised against this
        identity, and the sidebar is the one piece of chrome visible on every page.
      -->
      <UserMenu />
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-subtle);
  border-right: 1px solid var(--color-border);
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 9px;
  height: var(--topbar-height);
  padding: 0 14px;
  border-bottom: 1px solid var(--color-border);
}

.sidebar__logo {
  /* The asset is 224x120 with transparent padding. `object-fit: contain` plus a
     fixed height keeps the aspect ratio; the width is capped so a future asset
     swap cannot push the mark into the navigation. */
  height: 24px;
  width: auto;
  max-width: 60px;
  object-fit: contain;
  flex: none;
}

.sidebar__nav {
  flex: 1;
  overflow-y: auto;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: 12.5px;
  border-left: 2px solid transparent;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: rgba(23, 23, 23, 0.04);
}

.nav-item__icon {
  flex: none;
  color: var(--color-text-secondary);
}

.nav-item--active {
  background: var(--color-accent-soft);
  border-left-color: var(--color-accent);
  color: var(--color-accent-hover);
  font-weight: 600;
}

.nav-item--active .nav-item__icon {
  color: var(--color-accent);
}

.sidebar__footer {
  border-top: 1px solid var(--color-border);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
</style>
