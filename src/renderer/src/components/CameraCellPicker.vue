<script setup lang="ts">
/**
 * 画面格上的**相机选择器浮层**：一块贴在被点那一格旁边的相机清单。
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
 * 它只做三件事：把 `items` 画出来、把方向和回车翻译成 `select`、把
 * Esc / 点外面 / 滚动 / 改窗口大小翻译成 `close`。**一个字的业务判断都没有**：
 * 「哪几台相机可选」由调用方的 `optionsForCell()` 决定，「选中之后怎么办」由调用方
 * 决定（这是全仓「规则只有一处」的落地方式，与 `VideoContextMenu` 同一条规矩）。
 *
 * 文案也是调用方传进来的：本组件不碰目录，所以它不需要 `useI18n`。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { CAMERA_PICKER_GAP, placeCameraPicker, type ViewportRect } from '@renderer/lib/cameraWall'

/** 一个候选项：设备 id（回传给调用方）+ 已经渲染好的名字。 */
export interface CameraPickerItem {
  id: string
  name: string
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
}>()

const emit = defineEmits<{
  (event: 'select', deviceId: string): void
  (event: 'close'): void
}>()

const menu = ref<HTMLElement | null>(null)
/** `position: fixed` 的落点；打开时先按锚点放，量到真实尺寸后再夹紧。 */
const position = ref({ left: 0, top: 0 })
/** 高亮的候选项下标；`-1` = 一个都没有（空清单）。 */
const activeIndex = ref(-1)

/**
 * 量一次自己的尺寸再落位。
 *
 * 顺序是「先渲染 → 再量 → 再挪」，因为爬出视口的方向（上面还是下面）取决于浮层自己
 * 有多高，而那个高度只有渲染出来才知道。打开的那一帧先按锚点放，所以不会在左上角闪。
 */
async function place(): Promise<void> {
  await nextTick()
  const element = menu.value
  if (!element || !props.anchor) return
  const rect = element.getBoundingClientRect()
  const placed = placeCameraPicker(
    props.anchor,
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  )
  position.value = { left: placed.left, top: placed.top }
  element.focus()
  activeIndex.value = props.items.length > 0 ? 0 : -1
}

function close(): void {
  emit('close')
}

function choose(item: CameraPickerItem | undefined): void {
  if (!item) return
  emit('select', item.id)
}

function move(delta: number): void {
  if (props.items.length === 0) return
  activeIndex.value = (activeIndex.value + delta + props.items.length) % props.items.length
}

function onKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      close()
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
      activeIndex.value = props.items.length > 0 ? 0 : -1
      return
    case 'End':
      event.preventDefault()
      activeIndex.value = props.items.length - 1
      return
    case 'Enter':
    case ' ':
      event.preventDefault()
      choose(props.items[activeIndex.value])
      return
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
      activeIndex.value = -1
    }
  }
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', close, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menu"
      class="picker"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      data-camera-picker
      role="listbox"
      tabindex="-1"
      :aria-label="label"
      @keydown="onKeydown"
      @contextmenu.prevent
    >
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
        {{ item.name }}
      </button>
      <!--
        一台可选的相机都没有：这里必须说一句短状态词，而不是画一块空的浮层 ——
        空的浮层与「还没渲染出来」看起来一模一样。
      -->
      <p v-if="items.length === 0" class="picker__empty">{{ emptyLabel }}</p>
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

.picker__item {
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

.picker__item--active {
  background: var(--color-bg-subtle);
}

.picker__empty {
  padding: 7px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-text-muted);
}
</style>
