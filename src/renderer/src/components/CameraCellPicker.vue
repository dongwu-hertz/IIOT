<script setup lang="ts">
/**
 * 画面格上的**相机选择器浮层**：一块贴在被点那一格旁边的清单，**两步选择**。
 *
 * ---------------------------------------------------------------------------
 * 为什么不再用原生 `<select>` + `showPicker()`（业主 2026-09-18 报的 bug）
 * ---------------------------------------------------------------------------
 * 上一版把每一格的选择器做成一个原生 `<select>`，挂在整面墙末尾的
 * `.visually-hidden` 宿主里（1×1、`clip: rect(0 0 0 0)`），点 `+` 时用
 * `showPicker()` 打开它。两个后果：
 *   1. **原生下拉贴在它自己那个盒子的边上**，也就是「墙末尾那个 1×1 的盒子」上。
 *      那个盒子在**页面左上区**，与操作员点的那一格毫无关系 —— 真窗口里量到的数字
 *      （`scripts/demo-shot-driver.cjs` 的 `camera picker` 探针，1440×900）是：
 *      宿主 `{left:273, top:97, width:1, height:1}`，被点的那一格
 *      `{left:834, top:148, right:1389, bottom:460}` —— 相距 **561px**。于是清单弹在
 *      操作员没在看的地方（压在别的方块上），他的说法是「弹了一下 / 位置被盖住 /
 *      没有显示出来」；
 *   2. `showPicker()` 需要**真实用户手势**，拿不到时它抛异常，代码只能退回
 *      `select.focus()`：焦点落在一个被裁掉的 1×1 控件上，屏幕上什么都没发生
 *      （探针那条路就是这一种：`focusedInstead: "wall-pick-1"`）。
 * 所以浮层改成自己画：位置由 `placeCameraPicker()`（纯函数、有单测）算，永远落在
 * 被点那一格的旁边并夹进视口，`data-camera-picker` 让探针能**量**出来「在不在视口里、
 * 有没有被盖住、离那一格多远」。
 *
 * ---------------------------------------------------------------------------
 * 两步选择（业主 2026-09-21 批「同一相机的不同数据进不同窗口」）
 * ---------------------------------------------------------------------------
 * 第一步是**设备**清单；点一台**相机**进第二步「选择内容」：四个视图按钮，已经在
 * 本墙出现的 (相机, 视图) 组合禁用并标出「已在窗口」。手填的第三方 RTSP 源只有
 * 画面，点击仍是一步到位。选中后调用方决定怎么办（本组件一个字的业务判断都没有，
 * 与 `VideoContextMenu` 同一条规矩）。
 *
 * 键盘：方向键移动高亮，回车选中（第一步选中带视图的相机 = 进第二步），
 * 第二步里 Esc 退回第一步、再按 Esc 才关掉；Tab 一律关掉浮层把焦点还给调用方。
 *
 * 文案也是调用方传进来的：本组件不碰目录，所以它不需要 `useI18n`。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { CameraCellViewMode } from '@shared/domain/camera-cell-view'
import { CAMERA_PICKER_GAP, placeCameraPicker, type ViewportRect } from '@renderer/lib/cameraWall'

/**
 * 第二步里的一个视图选项。
 *
 * `label` / `inUseLabel` 都是**渲染好的文字**（调用方走目录），本组件不拿 key。
 */
export interface CameraPickerViewOption {
  mode: CameraCellViewMode
  /** 视图名（「播放」「1 秒时域图」…）。 */
  label: string
  /** 该 (相机, 视图) 已在本墙出现：禁用并标出 `inUseLabel`。 */
  inUse: boolean
  /** 「已在窗口」那句角标（仅 `inUse` 时渲染）。 */
  inUseLabel?: string
}

/** 一个候选项：设备 id（回传给调用方）+ 已经渲染好的名字。 */
export interface CameraPickerItem {
  id: string
  name: string
  /**
   * 有值 = 这是一台**相机**：点击进第二步选视图。缺省（手填 RTSP 源）= 一步到位，
   * 点击直接选中。
   */
  views?: readonly CameraPickerViewOption[]
  /** 第二步顶部那一行短标题（「显示方式」），仅 `views` 存在时使用。 */
  viewsTitle?: string
}

const props = defineProps<{
  open: boolean
  /**
   * 被点那一格的视口矩形（`getBoundingClientRect()`）。
   *
   * 浮层是**对着这一格**开的，不是对着鼠标：一格是一个明确的投放目标，而光标在
   * 空白格正中央的那个 `+` 上，对着光标放和对着格子放看起来一样，但对着格子放才
   * 经得起「格子很宽 / 窗口很窄」这两种尺寸。
   */
  anchor: ViewportRect | null
  items: CameraPickerItem[]
  /** 选项为空时那一行短状态词（例如所有相机都已经在墙上）。 */
  emptyLabel: string
  /** 无障碍名字（「选择相机」/「更换相机」），与触发它的那个按钮同一句。 */
  label: string
  /**
   * 业主 2026-09-24：选择器**铺在被点的那一格里面**（inline 覆盖层），不再是
   * 格子旁边的浮动卡片——浮在下方要挪视线，铺进播放窗口里点选就在原地。
   * inline 时由调用方把它渲染在格子内部（`position: relative` 的容器里），
   * 组件内部跳过 Teleport 与锚点测量。
   */
  inline?: boolean
}>()

const emit = defineEmits<{
  /** 手填源：只有 id（视图恒为播放）；相机：id + 选中的视图。 */
  (event: 'select', deviceId: string, view?: CameraCellViewMode): void
  (event: 'close'): void
}>()

const menu = ref<HTMLElement | null>(null)
/** `position: fixed` 的落点；打开时先按锚点放，量到真实尺寸后再夹紧。 */
const position = ref({ left: 0, top: 0 })
/**
 * 进行到第几步（`stepItemId` 是第二步里那台相机的 id）。
 * `activeItem` 找不到时（例如放置动作改写了 items）自动退回第一步渲染。
 */
const stepItemId = ref<string | null>(null)
const activeItem = computed<CameraPickerItem | undefined>(() =>
  stepItemId.value === null
    ? undefined
    : props.items.find((item) => item.id === stepItemId.value)
)
/** 当前这一步里的可选项：第二步是四个视图，第一步是设备清单。 */
const stepItems = computed<readonly (CameraPickerItem | CameraPickerViewOption)[]>(
  () => activeItem.value?.views ?? props.items
)
/** 高亮的候选项下标；`-1` = 一个都没有（空清单）。 */
const activeIndex = ref(-1)

/**
 * 量一次自己的尺寸再落位。
 *
 * 顺序是「先渲染 → 再量 → 再挪」，因为爬出视口的方向（上面还是下面）取决于浮层自己
 * 有多高，而那个高度只有渲染出来才知道。打开的那一帧先按锚点放，所以不会在左上角闪。
 * 切换步骤（设备 → 视图）高度会变，所以步骤切换后也要重新量。
 */
async function place(): Promise<void> {
  await nextTick()
  const element = menu.value
  if (!element) return
  // inline：铺满格子，没有"落点"要算；聚焦 + 高亮复位仍然要做。
  if (props.inline) {
    element.focus()
    activeIndex.value = stepItems.value.length > 0 ? 0 : -1
    return
  }
  if (!props.anchor) return
  const rect = element.getBoundingClientRect()
  const placed = placeCameraPicker(
    props.anchor,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  )
  position.value = { left: placed.left, top: placed.top }
  element.focus()
  activeIndex.value = stepItems.value.length > 0 ? 0 : -1
}

function close(): void {
  emit('close')
}

/** 选中第一步里的一项：相机进第二步，手填源一步到位。 */
function choose(item: CameraPickerItem | undefined): void {
  if (!item) return
  if (item.views !== undefined && item.views.length > 0) {
    stepItemId.value = item.id
    void place()
    return
  }
  emit('select', item.id)
}

/** 选中第二步里的一个视图（已在墙上的组合禁用，点不动）。 */
function chooseView(item: CameraPickerItem, option: CameraPickerViewOption | undefined): void {
  if (!option || option.inUse) return
  emit('select', item.id, option.mode)
}

/** 退回第一步（Esc），退回不了（已经在第一步）就由键盘处理去 `close()`。 */
function back(): void {
  if (stepItemId.value === null) return
  stepItemId.value = null
  void place()
}

function move(delta: number): void {
  if (stepItems.value.length === 0) return
  activeIndex.value = (activeIndex.value + delta + stepItems.value.length) % stepItems.value.length
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      // 第二步先退回第一步；第一步才关掉浮层。
      if (stepItemId.value !== null) back()
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
    case 'Home':
      event.preventDefault()
      activeIndex.value = stepItems.value.length > 0 ? 0 : -1
      return
    case 'End':
      event.preventDefault()
      activeIndex.value = stepItems.value.length - 1
      return
    case 'Enter':
    case ' ': {
      event.preventDefault()
      if (activeItem.value) {
        chooseView(activeItem.value, activeItem.value.views?.[activeIndex.value])
      } else {
        choose(props.items[activeIndex.value])
      }
      return
    }
    case 'Tab':
      // 浮层被 Teleport 到 `<body>` 末尾：不拦 Tab 的话焦点会跳出整个应用。
      // 关掉浮层，让调用方把焦点还给触发它的那个按钮。
      event.preventDefault()
      close()
      return
    default:
      return
  }
}

/**
 * 点外面关掉。
 *
 * `mousedown` 而不是 `click`：按住鼠标拖到浮层外再松开不会触发 `click`
 * （`VideoContextMenu` 上同一条理由）。
 *
 * **触发那一格的按钮不算「外面」**：算的话，再点一次 `+` 会变成「先关掉再打开」
 * （`mousedown` 关、随后的 `click` 又开），看起来像没反应。带
 * `data-camera-picker-trigger` 的元素由调用方标出来，这里让开，于是「再点一次 = 收起」
 * 由调用方那一个开关决定。
 */
function onDocumentMouseDown(event: MouseEvent): void {
  const target = event.target
  if (target instanceof Element && target.closest('[data-camera-picker-trigger]')) return
  if (target instanceof Node && menu.value?.contains(target)) return
  close()
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      stepItemId.value = null
      position.value = {
        left: props.anchor?.left ?? CAMERA_PICKER_GAP,
        top: (props.anchor?.bottom ?? 0) + CAMERA_PICKER_GAP
      }
      void place()
      document.addEventListener('mousedown', onDocumentMouseDown, true)
      window.addEventListener('resize', close)
      window.addEventListener('scroll', close, true)
    } else {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      stepItemId.value = null
      activeIndex.value = -1
    }
  },
  // inline 模式随格子 `v-if` 挂载：挂载即打开，watcher 不 immediate 就漏掉开场。
  { immediate: true }
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', close, true)
})
</script>

<template>
  <!-- inline 时 Teleport 停用：组件随格子渲染在 DOM 原位（格子内部），覆盖整格。 -->
  <Teleport to="body" :disabled="inline">
    <div
      v-if="open"
      ref="menu"
      class="picker"
      :class="{ 'picker--inline': inline }"
      :style="inline ? undefined : { left: `${position.left}px`, top: `${position.top}px` }"
      data-camera-picker
      role="listbox"
      tabindex="-1"
      :aria-label="label"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
      <!--
        第一步：设备清单。带 `views` 的（相机）右侧有一颗「进第二步」的箭头；
        手填 RTSP 源没有箭头，点击一步到位。
      -->
      <template v-if="!activeItem">
        <button
          v-for="(item, index) in items"
          :key="item.id"
          type="button"
          class="picker__item"
          :class="{ 'picker__item--active': index === activeIndex }"
          data-camera-picker-item
          :data-device-id="item.id"
          role="option"
          :aria-selected="index === activeIndex"
          @mouseenter="activeIndex = index"
          @click="choose(item)"
        >
          <span class="picker__item-name">{{ item.name }}</span>
          <svg
            v-if="item.views"
            class="picker__chevron"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M6 4 L10 8 L6 12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <!--
          一台可选的相机都没有：这里必须说一句短状态词，而不是画一块空的浮层 ——
          空的浮层与「还没渲染出来」看起来一模一样。
        -->
        <p v-if="items.length === 0" class="picker__empty">{{ emptyLabel }}</p>
      </template>

      <!-- 第二步：这一台相机画什么。已在墙上的 (相机, 视图) 组合禁用并标出原因。 -->
      <template v-else>
        <p class="picker__step-title">{{ activeItem.viewsTitle }}</p>
        <button
          v-for="(option, index) in activeItem.views"
          :key="option.mode"
          type="button"
          class="picker__item"
          :class="{ 'picker__item--active': index === activeIndex }"
          data-camera-picker-view
          :data-view="option.mode"
          role="option"
          :aria-selected="index === activeIndex"
          :aria-disabled="option.inUse"
          :disabled="option.inUse"
          @mouseenter="activeIndex = index"
          @click="chooseView(activeItem, option)"
        >
          <span class="picker__item-name">{{ option.label }}</span>
          <span v-if="option.inUse" class="picker__inuse">{{ option.inUseLabel }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.picker {
  position: fixed;
  z-index: 1200;
  min-width: 160px;
  max-width: 320px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-1);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  outline: none;
}

/* inline（业主 2026-09-24）：铺满被点的那一格，选相机不挪视线。 */
.picker--inline {
  position: absolute;
  inset: 0;
  z-index: 5;
  min-width: 0;
  max-width: none;
  max-height: none;
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: rgba(255, 255, 255, 0.97);
  overflow-y: auto;
}

.picker__item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

.picker__item--active {
  background: var(--color-bg-subtle);
}

/* 已在墙上的 (相机, 视图) 组合：还能看见（操作员要确认"它确实在"），但点不动。 */
.picker__item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.picker__item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__chevron {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  color: var(--color-text-muted);
}

.picker__step-title {
  margin: 0;
  padding: 5px 10px 3px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.picker__inuse {
  flex: 0 0 auto;
  padding: 1px 6px;
  font-size: 10.5px;
  border-radius: 999px;
  background: var(--color-bg-muted);
  color: var(--color-text-secondary);
}

.picker__empty {
  padding: 7px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
</style>
