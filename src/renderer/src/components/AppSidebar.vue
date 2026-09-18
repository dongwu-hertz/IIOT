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
 *
 * 2026-09-17（事件中心规格 §3.2/§3.3）：侧栏可折叠（232 / 64），偏好记在 localStorage；
 * 选中项改成"3px 橙色竖条 + 轻橙背景"。
 */
import { onMounted, ref } from 'vue'
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
  /**
   * 地图信息（GIS）（业主 2026-09-17 第 8 批建的页；**2026-09-18 第 10 批第 12 条改了名字与位置**）。
   *
   * 名字：从「点位图」改成「地图信息（GIS）」—— 这一页要承担的不再只是"按录入的点位画几个点"，
   * 还有 GIS 底图/平面图、设备落图与地图下方的三张列表（第 13–17 条），"点位图"这个名字
   * 已经装不下它了。（**这是我们照业主原话改的**；`docs/reference/` 里没有涉及地图的条目。）
   *
   * 位置：**设备管理之上、总览之下**。业主第 12 条的原话是「移到设备管理上方、总览下方」——
   * 它是"我的设备在哪"的地图视角，读的时候应该在"我的设备有哪些"（设备管理）之前。
   *
   * 图标仍然是地图针：这一页的入口必须看起来像"位置"。
   */
  {
    path: '/map',
    labelKey: 'app.nav.map',
    icon: 'M10 17.6s6-5.5 6-9.7a6 6 0 10-12 0c0 4.2 6 9.7 6 9.7zM10 8a1.8 1.8 0 100 3.6A1.8 1.8 0 0010 8z'
  },
  {
    path: '/devices',
    labelKey: 'app.nav.devices',
    icon: 'M4 6.5A2.5 2.5 0 016.5 4h7A2.5 2.5 0 0116 6.5v7A2.5 2.5 0 0113.5 16h-7A2.5 2.5 0 014 13.5zM7.5 16v2.5M12.5 16v2.5'
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
 * 侧栏折叠（规格 §3.2：232px / 64px；§3.3：**偏好本地保存**）。
 *
 * 为什么记在 localStorage 而不是数据库设置里：它是**这台机器上这个人的界面偏好**，
 * 与"软件怎么工作"无关（同一个 profile 换个人用，界面偏好本来就该跟着走）。
 * 仓库里已有同样的先例：频道墙的折叠状态（`stores/channelWall.ts` 的
 * `CHANNEL_WALL_COLLAPSED_STORAGE_KEY`）。
 *
 * 读不到/写不了（隐私模式、配额满、被策略禁掉）时**静默降级为展开**：一个界面偏好丢了
 * 不该让侧栏打不开，所以两个方向都不抛。
 */
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'hertzinno.sidebar.collapsed'

function readStoredCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(readStoredCollapsed())

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed.value ? '1' : '0')
  } catch {
    // 偏好存不下不影响这一次折叠本身（当前会话内仍然是对的）。
  }
}

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
  <aside class="sidebar" :class="{ 'sidebar--collapsed': collapsed }">
    <div class="sidebar__brand">
      <!--
        The official brand asset, imported so the bundler fingerprints and emits
        it — a runtime path would break inside the packaged asar.

        LOGO ONLY. The wordmark that used to sit next to it ("Acoustic Box Manager"
        over "设备管理软件") was removed by product request; the application's name is
        still carried by the window title, the About panel and the footer, so nothing
        became unfindable.

        **折叠按钮不在这一行**（业主 2026-09-18 第 4 条：移到「协议实验室」下方）。
        折叠之后 logo 从横排的图片变成**圆形**徽标（见 `.sidebar--collapsed .sidebar__logo`）：
        64px 宽的一列里，一个 32px 的圆比一条 44×24 的长条更好认，也不会把文字旁白挤没。
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
        :title="collapsed ? t(item.labelKey) : undefined"
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

      <!--
        折叠 / 展开按钮（业主 2026-09-18 第 4 条：「展开收起的按钮应放在协议实验室的下方」）。
        它原来是品牌行右侧那个图标 —— 那里离导航很远，而且折叠之后 logo 与它同处 64px 里，
        两个东西都在让位。放在最后一项之后，"把这一列收起来"就在这一列的末尾，
        位置固定、不用找；折叠状态下它和其他项一样居中（图标仍在，`title` 与
        `aria-label` 会随状态说"收起/展开"）。
      -->
      <button
        type="button"
        class="nav-item sidebar__toggle"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? t('app.expandSidebar') : t('app.collapseSidebar')"
        :title="collapsed ? t('app.expandSidebar') : t('app.collapseSidebar')"
        data-action="sidebar-toggle"
        @click="toggleCollapsed"
      >
        <!-- 展开时是「向左收」，折叠时是「向右展」：同一个按钮，两个方向。 -->
        <svg
          class="nav-item__icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path v-if="!collapsed" d="M9.5 3.5 5 8l4.5 4.5" />
          <path v-else d="M6.5 3.5 11 8l-4.5 4.5" />
        </svg>
        <span class="nav-item__label">
          {{ collapsed ? t('app.expandSidebar') : t('app.collapseSidebar') }}
        </span>
      </button>
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
/*
 * 侧栏（规格 §3.2）：展开 232px、折叠 64px，宽度做 180–220ms 的过渡
 * （`--sidebar-transition`）。折叠只改宽度与几处可见性，**不动 DOM 顺序** ——
 * 菜单项、图标、链接与展开时是同一批节点，所以 Tab 顺序与读屏结果不受折叠影响。
 */
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-subtle);
  border-right: 1px solid var(--color-border);
  transition: width var(--sidebar-transition);
  overflow: hidden;
}

.sidebar--collapsed {
  width: var(--sidebar-collapsed);
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

/*
 * 折叠 / 展开按钮（在「协议实验室」下方，见模板里的注释）。
 *
 * 它借了 `.nav-item` 那一行的形状（同样的行高、同样的 3px 左边距），所以它看起来
 * 就是导航列的最后一行；`color` 与 hover 沿用导航项那套，不另外发明一种按钮外观。
 * 那一行只有 24px 宽的图标按钮，所以自己写尺寸，不套全局 `.btn`。
 */
.sidebar__toggle {
  width: 100%;
  border: 0;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.sidebar__toggle:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.sidebar__toggle:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* 折叠后：logo 变成**圆形**徽标（业主第 4 条）、图标居中、文字隐藏。 */
.sidebar--collapsed .sidebar__brand {
  justify-content: center;
  padding: 0;
}

/*
 * 收起之后 logo 用一个 32px 的圆承载（`object-fit: contain`，不裁掉笔画）：
 * 原始素材是 224×120 的长条，直接 `border-radius: 50%` 会把它切成两半；
 * 圆底 + 圆内的完整 logo 读起来仍然是一个"圆形标识"，而且没有伪造新素材。
 * 这个判断写在 `docs/Ivms4200-UX-REFERENCE.md` §15.49。
 */
.sidebar--collapsed .sidebar__logo {
  width: 32px;
  height: 32px;
  max-width: 32px;
  padding: 5px;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-bg-subtle);
}

.sidebar--collapsed .nav-item {
  justify-content: center;
  padding: 7px 0;
}

.sidebar--collapsed .nav-item__label {
  display: none;
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
  /* 行高 40px 是规格 §3.2 给的（`--nav-row-height`），比原来的 33px 宽松：一行一个动作。 */
  min-height: var(--nav-row-height);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--font-size-small);
  font-weight: 500;
  /* 选中指示是**左侧 3px 竖条**（规格 §3.3），所以默认也占 3px 宽，选中时不会跳一格。 */
  border-left: 3px solid transparent;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: var(--color-bg-hover);
}

.nav-item__icon {
  flex: none;
  color: var(--color-text-secondary);
}

/*
 * 选中项（规格 §3.3）：3px 橙色竖条 + `#FFF5ED` 轻背景 + `#E65300` 文本。
 * **不把整块填成高饱和橙** —— 那是规格明确禁止的做法（§3.3 末句）。
 */
.nav-item--active {
  background: var(--color-accent-light);
  border-left-color: var(--color-accent);
  color: var(--color-accent-strong);
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

/* 折叠后账户名与角色标签收起来，只留头像（64px 里放不下两行文字）。 */
.sidebar--collapsed .sidebar__footer {
  padding: 10px 0;
  align-items: center;
}

.sidebar--collapsed :deep(.user__text) {
  display: none;
}
</style>
