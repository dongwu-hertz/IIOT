<script setup lang="ts">
/**
 * 视频画面上的右键菜单（安全监控软件那一类交互）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是一个独立组件，而不是页面里的一段模板
 * ---------------------------------------------------------------------------
 * 右键菜单的「行为」比它的「内容」更容易出错，而这些行为与相机毫无关系：
 *   1. **不出界**：光标贴着窗口右下角时，菜单必须翻到光标左上方，否则菜单项
 *      会被裁掉，用户会以为功能不存在；
 *   2. **一定能关掉**：Escape、点击外部、窗口尺寸变化、滚动、执行完一个动作，
 *      任何一条路径都不能留下一个关不掉的浮层；
 *   3. **键盘可达**：方向键移动、Home/End、回车执行；**禁用项也要能被选中**
 *      ——否则读屏用户永远听不到「为什么不能点」。
 * 把这三件事封在一个组件里，页面就只剩下「菜单项从哪来」和「点了做什么」。
 *
 * 菜单项的启用/禁用**不在**这里判断：它由 `@shared/domain/camera-nvr` 的纯函数
 * `buildCameraNvrMenu()` 决定，菜单和面板按钮读的是同一份结果。
 * 这就是「规则只有一处」的落地方式——组件只负责画出来并如实标灰。
 *
 * 为什么菜单项的 `action` 是 `string` 而不是相机动作的联合类型
 * 位置夹紧、键盘可达、一定能关掉这三件事与「菜单里装的是什么动作」毫无关系。设备
 * 拓扑树这一轮要复用同一个菜单（设备行/通道行的右键重命名），如果在这里收窄成
 * `CameraNvrAction`，树的动作就只能靠第二份定位/键盘/关闭逻辑去画一遍 —— 那正是
 * 本仓库明令禁止的漂移。所以这里收的是**结构**（`action` / `labelKey` / `visible` /
 * `enabled` 加可选字段），相机的 `CameraNvrMenuItem` 天然满足它（`CameraNvrAction`
 * 是 `string` 的子类型），两个既有调用方一个字都不用改。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// 只为一个断言用（见 `activate()`）：事件签名保持相机动作的联合类型不变。
import type { CameraNvrAction } from '@shared/domain/camera-nvr'

/**
 * 这个组件画一行菜单需要知道的**全部**事实。
 *
 * 刻意是结构类型而不是某个领域的菜单项类型：同一块浮层既承载相机 NVR 动作，也承载
 * 拓扑树的重命名动作，而两者的动作联合类型互不相干。
 */
export interface ContextMenuEntry {
  /** 稳定 id，也是渲染的 key，以及 `select` 事件里带回去的值。 */
  action: string
  /** 目录键**名**，不是渲染后的文字：换语言时菜单必须跟着换。 */
  labelKey: string
  /**
   * 是否存在（false = 这个场景没有这个能力，整项不画）。
   *
   * 与 `enabled` 是两件事：`visible: false` 是「做不到」，`enabled: false`
   * 是「现在做不了」，后者必须带上原因。
   */
  visible: boolean
  enabled: boolean
  /** 禁用原因（目录键），仅在 `visible && !enabled` 时存在。 */
  disabledReasonKey?: string
  /** 禁用的**原始**诊断文字（设备/主进程给的），优先于上面的通用文案。 */
  disabledReasonText?: string
  /** 开关型菜单项的当前状态（叠加信息）。 */
  checked?: boolean
  /** 该组之前画一条分隔线，模仿安全监控软件的菜单分组。 */
  separatorBefore?: boolean
  /**
   * 二级菜单（最多两层，且**子项不得再带子菜单**）。
   *
   * 「同类变体」放这里，而不是摊成同级项：抓图与手动录像是同一件事的两种形态。
   * 录像的开关状态仍然在**同一个位置**翻转（子项文字变化），因此「就地翻转」
   * 这条规则没有被破坏。
   */
  submenu?: ContextMenuEntry[]
}

const props = defineProps<{
  open: boolean
  /** 视口坐标（`clientX` / `clientY`）。 */
  x: number
  y: number
  /** 菜单头部的设备名；空则不画头部。 */
  title?: string
  items: ContextMenuEntry[]
}>()

const emit = defineEmits<{
  /**
   * 派发一个被选中的叶子项。
   *
   * 事件签名**保持**相机的动作联合类型（两个既有调用方的契约），而浮层自身能承载
   * 任何菜单项 —— 这个宽窄差别由 `activate()` 的断言收口，见那里的说明。
   */
  (event: 'select', action: CameraNvrAction): void
  (event: 'close'): void
}>()

const { t } = useI18n()

const menu = ref<HTMLElement | null>(null)
const submenuEl = ref<HTMLElement | null>(null)
/** 视口内定位：先按光标放置，渲染后按实际尺寸夹紧。 */
const position = ref({ left: props.x, top: props.y })
/** 展开的子菜单在顶层列表中的下标；`null` = 没有子菜单。 */
const openSubmenu = ref<number | null>(null)
/** 子菜单是否翻到父项左侧（右侧放不下时）。 */
const submenuFlipped = ref(false)
/** 当前高亮项的下标（包含禁用项：禁用的原因也必须能被键盘读到）。 */
const activeIndex = ref(-1)
/** 子菜单内的高亮下标。 */
const subActiveIndex = ref(-1)

/** 菜单与窗口边缘之间保留的间隙。 */
const EDGE_GAP = 8

/**
 * 只有 `visible` 的项才会画出来：设备做不到的功能**不出现**，而不是灰着。
 * 这在 `buildCameraNvrMenu()` 里已经过滤过一次，这里再守一道，免得将来有人
 * 直接手写 items 时把不可用的项塞进来。
 */
const topItems = computed(() => props.items.filter((item) => item.visible))
const activeTop = computed<ContextMenuEntry | undefined>(() =>
  openSubmenu.value === null ? undefined : topItems.value[openSubmenu.value]
)

const labelOf = (item: ContextMenuEntry): string => t(item.labelKey)

const reasonOf = (item: ContextMenuEntry): string =>
  // 主进程/设备的原始诊断优先：它要么点明设备事实（`rtsp_enabled=0`），要么
  // 引用 ffmpeg 的 stderr，比一句通用文案有用得多。
  item.disabledReasonText && item.disabledReasonText.trim() !== ''
    ? item.disabledReasonText
    : item.disabledReasonKey
      ? t(item.disabledReasonKey)
      : ''

async function place(): Promise<void> {
  position.value = { left: props.x, top: props.y }
  await nextTick()
  const element = menu.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  // 有子菜单时要把它的宽度算进去，否则「贴右边缘」的父项展开后仍然会出界。
  const extra = submenuEl.value?.getBoundingClientRect().width ?? 0
  const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - extra - EDGE_GAP)
  const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP)
  position.value = {
    left: Math.min(Math.max(EDGE_GAP, props.x), maxLeft),
    top: Math.min(Math.max(EDGE_GAP, props.y), maxTop)
  }
  element.focus()
  // 默认高亮第一个可用的项；若全是禁用项，则高亮第一项（让原因可见）。
  const firstEnabled = topItems.value.findIndex((item) => item.enabled)
  activeIndex.value = firstEnabled >= 0 ? firstEnabled : topItems.value.length > 0 ? 0 : -1
}

function close(): void {
  emit('close')
}

/** 展开某个顶层项的子菜单（没有子菜单则关闭）。 */
async function openSubmenuAt(index: number): Promise<void> {
  const item = topItems.value[index]
  if (!item?.submenu || item.submenu.length === 0) {
    openSubmenu.value = null
    return
  }
  openSubmenu.value = index
  submenuFlipped.value = false
  await nextTick()
  const parent = menu.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
  const submenu = submenuEl.value
  if (parent && submenu) {
    const parentRect = parent.getBoundingClientRect()
    // 右侧放不下就翻到左边：这是「子菜单同样不越界」的唯一实现，靠 CSS 做不到
    // （CSS 不知道视口还剩多少）。
    submenuFlipped.value = parentRect.right + submenu.offsetWidth + EDGE_GAP > window.innerWidth
    submenu.style.top = `${parent.offsetTop}px`
  }
  const firstEnabled = item.submenu.findIndex((candidate) => candidate.enabled)
  subActiveIndex.value = firstEnabled >= 0 ? firstEnabled : 0
}

function closeSubmenu(): void {
  openSubmenu.value = null
  subActiveIndex.value = -1
}

/**
 * 执行一个叶子项；禁用项什么也不做（但保持菜单打开，让原因留在屏幕上）。
 *
 * `activate()` 收的是**任何**装得进这个浮层的菜单项，所以它派发的动作是 `string`。
 * 组件的公开事件仍然按相机的动作联合类型声明：这是两个既有调用方
 * （`MonitorView` / `CameraVideoWall`）的现有契约，本轮的复用没有理由把它放宽 ——
 * 放宽会让它们的事件处理器不再通过类型检查，而「让相机菜单继续工作」是这一轮的硬
 * 要求。也就是说：**浮层能装的动作比它对外声明的宽**，这个断言就是那条边界，写成
 * `as CameraNvrAction` 而不是把组件的事件签名改成 `string`，正是为了让相机的调用方
 * 一个字都不用改。
 */
function activate(item: ContextMenuEntry | undefined): void {
  if (!item || item.submenu !== undefined) return
  if (!item.enabled) return
  emit('select', item.action as CameraNvrAction)
  close()
}

function move(delta: number): void {
  const list = activeTop.value?.submenu
  if (list && openSubmenu.value !== null) {
    if (list.length === 0) return
    subActiveIndex.value = (subActiveIndex.value + delta + list.length) % list.length
    return
  }
  if (topItems.value.length === 0) return
  activeIndex.value = (activeIndex.value + delta + topItems.value.length) % topItems.value.length
}

function onKeydown(event: KeyboardEvent): void {
  const children = activeTop.value?.submenu
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      // 先收子菜单，再关菜单：两层结构下「一次 Escape 全关掉」会让人失去位置。
      if (openSubmenu.value !== null) closeSubmenu()
      else close()
      return
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      return
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      return
    case 'ArrowRight':
      event.preventDefault()
      if (children) void openSubmenuAt(activeIndex.value)
      return
    case 'ArrowLeft':
      event.preventDefault()
      if (openSubmenu.value !== null) closeSubmenu()
      return
    case 'Home':
      event.preventDefault()
      if (children) subActiveIndex.value = 0
      else activeIndex.value = 0
      return
    case 'End':
      event.preventDefault()
      if (children) subActiveIndex.value = children.length - 1
      else activeIndex.value = topItems.value.length - 1
      return
    case 'Enter':
    case ' ':
      event.preventDefault()
      if (children) {
        if (openSubmenu.value === null) void openSubmenuAt(activeIndex.value)
        else activate(children[subActiveIndex.value])
        return
      }
      activate(topItems.value[activeIndex.value])
      return
    default:
      return
  }
}

/**
 * 点击外部 / 别处再右键 / 窗口尺寸变化 / 滚动 都必须关闭。
 *
 * `mousedown` 而不是 `click`：用户按住右键拖到菜单外松开时不会触发 `click`，
 * 用 `click` 会留下一个关不掉的菜单。
 */
function onDocumentMouseDown(event: MouseEvent): void {
  const target = event.target
  if (target instanceof Node && menu.value?.contains(target)) return
  close()
}

function onViewportChange(): void {
  close()
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      openSubmenu.value = null
      subActiveIndex.value = -1
      void place()
      document.addEventListener('mousedown', onDocumentMouseDown, true)
      window.addEventListener('resize', onViewportChange)
      window.addEventListener('scroll', onViewportChange, true)
      // 右键菜单打开时再右键一次（例如点在另一个位置）应当重开而不是叠加。
      window.addEventListener('contextmenu', onViewportChange, true)
    } else {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('contextmenu', onViewportChange, true)
      activeIndex.value = -1
      closeSubmenu()
    }
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('contextmenu', onViewportChange, true)
})

const style = computed(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`
}))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="vmenu"
      :style="style"
      role="menu"
      tabindex="-1"
      :aria-label="title || undefined"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <p v-if="title" class="vmenu__title">{{ title }}</p>
      <template v-for="(item, index) in topItems" :key="item.action">
        <hr v-if="item.separatorBefore" class="vmenu__sep" />
        <button
          type="button"
          class="vmenu__item"
          :class="{
            'vmenu__item--active': index === activeIndex,
            'vmenu__item--disabled': !item.enabled
          }"
          :data-index="index"
          :data-action="item.action"
          role="menuitem"
          :aria-disabled="!item.enabled"
          :aria-checked="item.checked"
          :aria-haspopup="item.submenu ? 'menu' : undefined"
          :aria-expanded="item.submenu ? openSubmenu === index : undefined"
          :title="item.enabled ? labelOf(item) : reasonOf(item)"
          @mouseenter="
            activeIndex = index;
            item.submenu ? void openSubmenuAt(index) : closeSubmenu()
          "
          @click="item.submenu ? void openSubmenuAt(index) : activate(item)"
        >
          <span class="vmenu__label">
            <span v-if="item.checked !== undefined" class="vmenu__check" aria-hidden="true">
              {{ item.checked ? '✓' : '' }}
            </span>
            {{ labelOf(item) }}
            <span v-if="item.submenu" class="vmenu__arrow" aria-hidden="true">›</span>
          </span>
          <!--
            * 禁用原因**写在菜单里**，不是只挂在 title 上：
            * 静默的不可点等于功能不存在，这是产品要求里明确禁止的。
          -->
          <span v-if="!item.enabled" class="vmenu__reason">{{ reasonOf(item) }}</span>
        </button>
      </template>

      <!--
        * 二级菜单（同一容器内，因此「点击外部」判断天然覆盖它）。
        * 最多两层：子项自身再带子菜单是不被渲染的，`buildCameraNvrMenu` 也不产生。
      -->
      <div
        v-if="activeTop?.submenu"
        ref="submenuEl"
        class="vmenu vmenu__submenu"
        :class="{ 'vmenu__submenu--left': submenuFlipped }"
        role="menu"
      >
        <button
          v-for="(child, childIndex) in activeTop.submenu"
          :key="child.action"
          type="button"
          class="vmenu__item"
          :data-action="child.action"
          :class="{
            'vmenu__item--active': childIndex === subActiveIndex,
            'vmenu__item--disabled': !child.enabled
          }"
          role="menuitem"
          :aria-disabled="!child.enabled"
          :aria-checked="child.checked"
          :title="child.enabled ? labelOf(child) : reasonOf(child)"
          @mouseenter="subActiveIndex = childIndex"
          @click="activate(child)"
        >
          <span class="vmenu__label">
            <!--
              二级项也要能打 ✓（第 12 批的「显示方式」四个子项靠它表示当前画法）。
              一级项一直有这个 span，二级项第一版漏了 —— 探针读到 `aria-checked: null`
              才发现"菜单里根本没有勾"。
            -->
            <span v-if="child.checked !== undefined" class="vmenu__check" aria-hidden="true">
              {{ child.checked ? '✓' : '' }}
            </span>
            {{ labelOf(child) }}
          </span>
          <span v-if="!child.enabled" class="vmenu__reason">{{ reasonOf(child) }}</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vmenu {
  position: fixed;
  z-index: 1200;
  min-width: 200px;
  max-width: 360px;
  padding: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 8px);
  box-shadow: var(--shadow-lg);
  outline: none;
}

.vmenu__title {
  padding: 6px 10px 8px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
}

.vmenu__sep {
  height: 1px;
  margin: 4px 6px;
  border: 0;
  background: var(--color-border);
}

.vmenu__item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.vmenu__item--active {
  background: var(--color-bg-subtle);
}

.vmenu__item--disabled {
  cursor: not-allowed;
  color: var(--color-text-muted);
}

.vmenu__label {
  display: block;
}

/* 二级菜单：贴在父项右侧（放不下时由脚本翻到左侧并加上 --left）。 */
.vmenu__submenu {
  position: absolute;
  left: calc(100% - 4px);
  min-width: 200px;
}

.vmenu__submenu--left {
  left: auto;
  right: calc(100% - 4px);
}

.vmenu__arrow {
  float: right;
  margin-left: 8px;
  color: var(--color-text-muted);
}

.vmenu__check {
  display: inline-block;
  width: 14px;
  margin-right: 2px;
}

.vmenu__reason,
.vmenu__state {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
</style>
