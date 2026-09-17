<script setup lang="ts">
/**
 * 左侧栏的设备拓扑树（产品要求「在左侧栏里面有做展开拓扑，这样可以选择不同的设备」）。
 *
 * 这个组件只做三件事：画 `rows`、把点击/键盘/拖拽翻译成对 store 的调用、以及把
 * 选中结果交给 `select` 事件。**所有判断都在纯函数里**（`lib/deviceTree.ts` 负责
 * 树的摊平/筛选/键盘导航，`lib/channelState.ts` 负责通道状态），模板里没有一条
 * `if (设备在线 && 通道启用)` 这样的业务规则。
 *
 * 为什么摊平成一维数组再画
 * 递归自引用组件在 Vue 里要多一个组件、多一层 props，而树的深度在这里固定三层；
 * 摊平之后键盘导航也能直接对着同一个数组算，两者不会漂移。
 *
 * 无障碍
 * 这是一个 `role="tree"`：行是 `treeitem`，`aria-level` / `aria-expanded` /
 * `aria-selected` 都从节点本身取。整个树是**一个** Tab 停靠点（`tabindex` 只在
 * 焦点行上），方向键在行之间移动 —— 与系统里的树控件一致，也是「能用键盘操作」
 * 的最低要求。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Device } from '@shared/domain/models'
import {
  deviceIdOfNodeId,
  isTreeKey,
  navigateTree,
  treeDeviceLabel,
  type DeviceTreeNode
} from '@renderer/lib/deviceTree'
import { channelStateClass, channelStateHintKey, channelStateLabelKey } from '@renderer/lib/channelState'
import VideoContextMenu, {
  type ContextMenuEntry
} from '@renderer/components/VideoContextMenu.vue'
import { useDeviceTreeStore } from '@renderer/stores/deviceTree'
import { useDevicesStore } from '@renderer/stores/devices'
import { useCameraWallStore } from '@renderer/stores/liveWall'

const props = defineProps<{
  /** 路由/设备 store 认定的当前设备 id，用来高亮。 */
  selectedDeviceId: string
  /**
   * 是否在树头上画「添加设备」。
   *
   * 由调用方给（而不是这里读 session store）：树是**呈现组件**，它不该知道"当前账户
   * 是不是管理员"。设备管理页把 `session.isAdmin` 传进来、自己处理 `add` 事件去弹对话框，
   * 这样"谁能添加设备"这条规则只有一处在判断。
   */
  canAddDevice?: boolean
}>()

const emit = defineEmits<{
  /** 选中一台设备 —— 调用方负责 `router.push`（本组件不碰路由）。 */
  (event: 'select', deviceId: string): void
  /** 双击/回车「在视频墙中打开」。 */
  (event: 'open', deviceId: string): void
  /** 右键菜单里的「修改设备名称」；调用方负责弹对话框并落盘。 */
  (event: 'rename-device', deviceId: string): void
  /** 右键菜单里的「修改通道名称」；调用方负责弹对话框并写设备。 */
  (event: 'rename-channel', deviceId: string, channelIndex: number): void
  /**
   * 树头上的「添加设备」被点击。
   *
   * 入口放在树里（参考 ThingsBoard 的设备管理：左侧列表自带新增入口），而不是页面
   * 标题行 —— 标题行已经按产品要求删掉了，而新增设备属于**列表**这一栏的动作。
   */
  (event: 'add'): void
}>()

const { t } = useI18n()
const tree = useDeviceTreeStore()
const devices = useDevicesStore()
const wall = useCameraWallStore()

const filterInput = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

/**
 * 渲染用的行：节点本身 + 它对应的设备（如果有）。
 *
 * 在 computed 里把设备查好，而不是让模板反复调 `devices.byId()` 再断言类型：
 * 模板里的一次 `as Device` 就是一处「我知道它一定有值」的假设，而这种假设在
 * 渲染期间出错是无法测试的。这里查一次，`device` 为 `undefined` 就是正常的
 * （根/通道行），模板用 `v-if` 显式分支。
 */
interface TreeRow {
  node: DeviceTreeNode
  device?: Device
  /** 这一行是否落在视频墙上（相机行给一个「已在画面格」的标记）。 */
  wallSlot: number
}

const rows = computed<TreeRow[]>(() =>
  tree.rows.map((node) => ({
    node,
    device: node.deviceId ? devices.byId(node.deviceId) : undefined,
    wallSlot: node.deviceId ? wall.model.slots.indexOf(node.deviceId) : -1
  }))
)

/** 纯节点数组：键盘导航要的是它（`navigateTree` 只认节点）。 */
const plainRows = computed<DeviceTreeNode[]>(() => rows.value.map((row) => row.node))

const filtering = computed(() => tree.filter.trim() !== '')
/** 设备多于 `FILTER_THRESHOLD` 台时才显示筛选框（「多于一把」才需要筛选）。 */
const FILTER_THRESHOLD = 4
const showFilter = computed(() => devices.devices.length > FILTER_THRESHOLD || filtering.value)

const selectedId = computed(() => props.selectedDeviceId)

onMounted(() => {
  // 设备列表可能还没到手（页面刚启动）；到手之后再补默认展开。
  tree.ensureDefaultExpansion()
})

watch(
  () => devices.devices.length,
  () => tree.ensureDefaultExpansion()
)

// ---------------------------------------------------------------------------
// 事件 -> store
// ---------------------------------------------------------------------------

function selectNode(node: DeviceTreeNode): void {
  const deviceId = node.deviceId ?? deviceIdOfNodeId(node.id) ?? ''
  if (deviceId === '') return
  tree.setFocus(node.id)
  emit('select', deviceId)
}

/** 双击设备：放进视频墙的当前格（产品要求「双击设备 = 在视频墙打开」）。 */
function openNode(node: DeviceTreeNode): void {
  const deviceId = node.deviceId ?? deviceIdOfNodeId(node.id) ?? ''
  if (deviceId === '') return
  const device = devices.byId(deviceId)
  // 只有声学相机有视频：声纹设备双击仍然是「打开它的监控页」，而不是一个必然会
  // 失败的空画面格。
  if (device?.kind !== 'acousticCamera') {
    selectNode(node)
    return
  }
  wall.bindDevices(devices.devices)
  const slot = wall.slotForDevice(deviceId)
  wall.placeDevice(slot, deviceId)
  wall.setActive(slot)
  emit('open', deviceId)
}

/** 行首的展开箭头：只有分支行有。 */
function toggleNode(node: DeviceTreeNode): void {
  if (node.kind === 'root' || (node.kind === 'device' && node.children.length > 0)) {
    tree.toggleNode(node.id)
  }
}

function statusLabel(device: Device): string {
  if (device.status === 'ONLINE') return t('deviceTreeUi.statusOnline')
  if (device.status === 'OFFLINE') return t('deviceTreeUi.statusOffline')
  return t('deviceTreeUi.statusUnknown')
}

function kindLabel(device: Device): string {
  return device.kind === 'acousticCamera' ? t('deviceTreeUi.kindCamera') : t('deviceTreeUi.kindBox')
}

/**
 * 设备行显示的文字。
 *
 * 「声学相机的地址不进树」这条产品要求落在 `treeDeviceLabel()` 里（纯函数、可断言）：
 * 相机没有身份端点，操作员不起名字时数据库里那行名字**就是地址**，画在树上等于拿
 * 地址冒充名字。判定只看「名字是不是由这台设备的地址推出来的」，操作员自己起过的
 * 名字一个字都不会被改。
 *
 * 行的完整文字仍然保留设备家族（右侧的 `kindLabel`），所以相机的两行读起来是
 * 「Acoustic Camera 的兜底名不出现 + 声学相机」。
 */
function displayLabel(node: DeviceTreeNode, device: Device | undefined): string {
  if (!node.label) return ''
  if (!device) return node.label
  return treeDeviceLabel(device, kindLabel(device))
}

function channelHint(node: DeviceTreeNode): string {
  if (!node.channelState) return ''
  const key = channelStateHintKey(node.channelState)
  return key ? t(key) : ''
}

function channelAria(node: DeviceTreeNode): string {
  const parts = [node.channelLabel ?? '']
  if (node.label) parts.push(node.label)
  if (node.channelState) parts.push(t(channelStateLabelKey(node.channelState)))
  return parts.filter((part) => part !== '').join(' ')
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

/**
 * 方向键/回车。
 *
 * `preventDefault()` 是必须的：这棵树在侧栏里，页面本身会滚动，方向键不拦就会
 * 变成「一边移动焦点一边滚页面」。
 */
function onKeydown(event: KeyboardEvent): void {
  if (!isTreeKey(event.key)) return
  event.preventDefault()
  const navigation = navigateTree(plainRows.value, tree.focusId, event.key)
  tree.setFocus(navigation.focusId)

  if (navigation.action === 'toggle' && navigation.focusId) {
    tree.toggleNode(navigation.focusId)
    return
  }
  if (navigation.action === 'select' && navigation.focusId) {
    const row = rows.value.find((item) => item.node.id === navigation.focusId)
    if (row) selectNode(row.node)
  }
}

/**
 * 让焦点行保持在视野里。
 *
 * 没有这一步，键盘走到第 12 台设备时焦点会在滚动区外面 —— 树看起来「没反应」，
 * 而实际上只是焦点移到了看不见的地方。
 */
watch(
  () => tree.focusId,
  (id) => {
    if (!id) return
    const container = listEl.value
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }
)

// ---------------------------------------------------------------------------
// 拖拽（可选入口，不引入任何依赖）
// ---------------------------------------------------------------------------

/**
 * HTML5 拖拽只在**应用内部**使用：`dataTransfer` 里放设备 id，拖到视频墙的画面上。
 * 这是可选入口 —— 双击与下拉选择都能完成同一件事（见 `openNode()`），
 * 所以拖拽失败（某些输入设备/平台不支持）不会让任何功能不可达。
 */
function onDragStart(event: DragEvent, node: DeviceTreeNode): void {
  const deviceId = node.deviceId ?? ''
  const device = deviceId ? devices.byId(deviceId) : undefined
  if (!device || device.kind !== 'acousticCamera') {
    // 不是相机就没有画面可拖：直接取消，而不是拖出一个一定会被拒绝的幽灵。
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('text/plain', deviceId)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

// ---------------------------------------------------------------------------
// 右键菜单（产品要求：右键设备行改设备名、右键通道行改通道名）
// ---------------------------------------------------------------------------

/**
 * 右键菜单的动作 id。
 *
 * 它们**不是**相机 NVR 的动作，但复用同一个浮层组件（`VideoContextMenu`）：窗口边缘
 * 夹紧、键盘导航、一定能关掉、禁用项把原因写在菜单里，这四件事与菜单里装的是什么
 * 动作无关，复制一遍就是本仓库最反对的那种漂移。
 */
const TREE_MENU_RENAME_DEVICE = 'tree-rename-device'
const TREE_MENU_RENAME_CHANNEL = 'tree-rename-channel'

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
/** 菜单是为哪一行打开的（行 id，本身就是节点的稳定 id）。 */
const menuNodeId = ref('')

/** 菜单目标行；行被筛选掉/设备被删掉之后自动变成 `undefined`，菜单项随之消失。 */
const menuRow = computed<TreeRow | undefined>(() =>
  rows.value.find((row) => row.node.id === menuNodeId.value)
)

/**
 * 菜单里到底有哪几项 —— 规则只写在这一处。
 *
 * 「声学相机没有通道」是设备家族的事实（`lib/deviceTree.ts` 给相机只产出流节点，
 * `tests/channel-wall.test.ts` 也钉住了这一点），所以相机行上**不会**出现「修改通道
 * 名称」：一个做不到的动作不画出来，而不是灰着。设备行的重命名则两台设备都有，只是
 * 落点不同（相机只能改本机数据库），那件事由对话框当面说清楚。
 *
 * 菜单只挂在**设备行**与**真实通道行**上：
 *   - 根行是分组标题，没有名字可改；
 *   - 相机流叶子是相机的那一路视频，不是通道；
 *   - 「尚未读取到通道表」的说明行没有 `channelIndex`，改它等于给一路不存在的通道
 *     编个名字。
 */
const menuItems = computed<ContextMenuEntry[]>(() => {
  const row = menuRow.value
  if (!row) return []
  if (row.node.kind === 'device') {
    return [
      {
        action: TREE_MENU_RENAME_DEVICE,
        labelKey: 'deviceTreeUi.renameDevice',
        visible: true,
        enabled: true
      }
    ]
  }
  if (row.node.kind === 'channel' && row.node.channelIndex !== undefined) {
    return [
      {
        action: TREE_MENU_RENAME_CHANNEL,
        labelKey: 'deviceTreeUi.renameChannel',
        visible: true,
        enabled: true
      }
    ]
  }
  return []
})

/** 菜单头部：设备的完整名字（含地址）在这里出现是**对的**，它说的就是这一台。 */
const menuTitle = computed(() => {
  const row = menuRow.value
  if (!row) return ''
  const device = row.device
  if (!device) return ''
  if (row.node.kind === 'channel') {
    return `${device.name} · ${row.node.channelLabel ?? ''}`
  }
  return device.name
})

function openContextMenu(event: MouseEvent, node: DeviceTreeNode): void {
  if (node.kind !== 'device' && node.kind !== 'channel') return
  menuNodeId.value = node.id
  menuX.value = event.clientX
  menuY.value = event.clientY
  menuOpen.value = true
}

function closeContextMenu(): void {
  menuOpen.value = false
}

function onMenuSelect(action: string): void {
  const row = menuRow.value
  closeContextMenu()
  if (!row?.node.deviceId) return
  if (action === TREE_MENU_RENAME_DEVICE) {
    emit('rename-device', row.node.deviceId)
    return
  }
  if (action === TREE_MENU_RENAME_CHANNEL && row.node.channelIndex !== undefined) {
    emit('rename-channel', row.node.deviceId, row.node.channelIndex)
  }
}
</script>

<template>
  <!--
    这一块**不再有标题**（产品要求删掉「设备拓扑」这一行）。
    无障碍名字不能跟着一起消失：没有标题的 `role="tree"` 在读屏里就是一棵没有名字的
    树；但**看不见的文字不算「画在屏幕上」**，产品删掉的正是屏幕上那一行标题。所以它
    继续有一个名字，而且这个名字与里面那个筛选框说的是同一件事（「筛选设备」）——
    不再为一个看不见的标题编造一条新文案。
  -->
  <section class="device-tree" :aria-label="t('deviceTreeUi.filterLabel')">
    <div class="device-tree__head">
      <div class="device-tree__actions">
        <button
          type="button"
          class="device-tree__action"
          :title="t('deviceTreeUi.expandAll')"
          :aria-label="t('deviceTreeUi.expandAll')"
          @click="tree.expandAll()"
        >
          ＋
        </button>
        <button
          type="button"
          class="device-tree__action"
          :title="t('deviceTreeUi.collapseAll')"
          :aria-label="t('deviceTreeUi.collapseAll')"
          @click="tree.collapseAll()"
        >
          －
        </button>
      </div>

      <!--
        「添加设备」放在树头上（产品要求：从右侧内容区移进左侧拓扑树，参考 ThingsBoard）。
        带文字而不是只有一个「＋」：树头已经有一个「＋」（全部展开），两个同形图标并排
        是"猜谜"，而这一颗按下去会弹对话框、改变设备列表。
      -->
      <button
        v-if="canAddDevice"
        type="button"
        class="btn btn--primary btn--sm device-tree__add"
        @click="emit('add')"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        {{ t('devicesUi.addButton') }}
      </button>
    </div>

    <div v-if="showFilter" class="device-tree__filter">
      <input
        ref="filterInput"
        class="device-tree__input"
        type="search"
        :value="tree.filter"
        :placeholder="t('deviceTreeUi.filterPlaceholder')"
        :aria-label="t('deviceTreeUi.filterLabel')"
        @input="tree.setFilter(($event.target as HTMLInputElement).value)"
        @keydown.esc="tree.clearFilter()"
      />
      <button
        v-if="filtering"
        type="button"
        class="device-tree__clear"
        :title="t('deviceTreeUi.filterClear')"
        @click="tree.clearFilter()"
      >
        ✕
      </button>
    </div>

    <p v-if="devices.devices.length === 0" class="device-tree__empty">
      {{ t('deviceTreeUi.empty') }}
    </p>
    <p v-else-if="rows.length <= 1" class="device-tree__empty">
      {{ t('deviceTreeUi.filterEmpty', { query: tree.filter }) }}
    </p>

    <!--
      一棵 `role="tree"`：整棵树只有一个 Tab 停靠点，行之间用方向键移动。
      `aria-activedescendant` 让读屏软件知道焦点在哪一行。
    -->
    <ul
      ref="listEl"
      class="device-tree__list"
      role="tree"
      :aria-label="t('deviceTreeUi.filterLabel')"
      :aria-activedescendant="tree.focusId ?? undefined"
      :tabindex="0"
      @keydown="onKeydown"
    >
      <li
        v-for="row in rows"
        :key="row.node.id"
        class="device-tree__row"
        :class="[
          `device-tree__row--${row.node.kind}`,
          {
            'device-tree__row--selected':
              row.node.deviceId !== undefined && row.node.deviceId === selectedId,
            'device-tree__row--focused': row.node.id === tree.focusId
          }
        ]"
        role="treeitem"
        :data-node-id="row.node.id"
        :aria-level="row.node.depth + 1"
        :aria-expanded="row.node.children.length > 0 ? row.node.expanded : undefined"
        :aria-selected="row.node.selectable ? row.node.deviceId === selectedId : undefined"
        :style="{ paddingLeft: `${6 + row.node.depth * 12}px` }"
        :draggable="row.node.kind === 'device'"
        @click="selectNode(row.node)"
        @dblclick="openNode(row.node)"
        @dragstart="onDragStart($event, row.node)"
        @contextmenu.prevent="openContextMenu($event, row.node)"
      >
        <!-- 展开箭头：只有分支行画，叶子留出等宽的空位，避免文字左右跳动。 -->
        <button
          v-if="row.node.kind === 'root' || (row.node.kind === 'device' && row.node.children.length > 0)"
          type="button"
          class="device-tree__twisty"
          :title="row.node.expanded ? t('deviceTreeUi.collapseNode') : t('deviceTreeUi.expandNode')"
          :aria-label="row.node.expanded ? t('deviceTreeUi.collapseNode') : t('deviceTreeUi.expandNode')"
          @click.stop="toggleNode(row.node)"
        >
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path v-if="row.node.expanded" d="M1.5 3.2h7L5 7.4z" fill="currentColor" />
            <path v-else d="M3.2 1.5v7L7.4 5z" fill="currentColor" />
          </svg>
        </button>
        <span v-else class="device-tree__twisty device-tree__twisty--leaf" aria-hidden="true"></span>

        <!--
          根行：**只剩上面那个箭头**。

          产品要求删掉「设备拓扑」这个标题与「共 N 台设备」那一行，而这一行恰好就是
          这两句话唯一的落点（标题文字在左、设备总数在右）。整行删掉会让根节点从树上
          消失，根一消失，「全部展开/收起」就失去了作用对象，树的层级也少了一层。
          所以留下的是这个不可选中的分组行本身，它不再渲染任何文字 —— 设备总数在顶栏
          上仍然有（`AppTopbar.vue`），不在这里重复第二遍。
        -->

        <!-- 设备行：状态点 + 名称 + 家族 -->
        <template v-if="row.node.kind === 'device'">
          <span
            class="device-tree__dot"
            :class="`device-tree__dot--${(row.node.deviceStatus ?? 'UNKNOWN').toLowerCase()}`"
            :title="row.device ? statusLabel(row.device) : ''"
            aria-hidden="true"
          ></span>
          <span class="device-tree__label" :title="displayLabel(row.node, row.device)">
            {{ displayLabel(row.node, row.device) || t('deviceTreeUi.statusUnknown') }}
          </span>
          <span
            v-if="row.wallSlot >= 0"
            class="device-tree__badge"
            :title="t('deviceTreeUi.openInWall')"
            >▣</span
          >
          <span class="device-tree__meta">{{ row.device ? kindLabel(row.device) : '' }}</span>
        </template>

        <!-- 相机流叶子 -->
        <template v-else-if="row.node.kind === 'stream'">
          <span class="device-tree__leaf-icon" aria-hidden="true">▶</span>
          <span class="device-tree__label device-tree__label--muted">
            {{ t('deviceTreeUi.cameraStreamNode') }}
          </span>
        </template>

        <!-- 通道叶子：状态用 `channelState.ts` 的类名与目录键，绝不重写判定 -->
        <template v-else>
          <span
            v-if="row.node.channelState"
            class="device-tree__channel"
            :class="channelStateClass(row.node.channelState)"
            :title="channelHint(row.node) || undefined"
            :aria-label="channelAria(row.node)"
          >
            <span class="device-tree__channel-label">{{ row.node.channelLabel }}</span>
            <span v-if="row.node.label" class="device-tree__channel-name">{{ row.node.label }}</span>
            <span v-else-if="!row.node.channelLabel" class="device-tree__channel-name">
              {{ t('deviceTreeUi.channelsUnavailable') }}
            </span>
          </span>
        </template>
      </li>
    </ul>

    <!--
      右键菜单复用视频画面那一块浮层（位置夹紧 / 键盘 / 一定能关掉只有一处实现）。
      菜单项由上面的 `menuItems` 决定，这里只负责画出来与派发。
    -->
    <VideoContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :title="menuTitle"
      :items="menuItems"
      @select="onMenuSelect"
      @close="closeContextMenu"
    />
  </section>
</template>

<style scoped>
.device-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 6px;
  /*
   * 这一块现在住在设备管理页的卡片里（产品要求「设备拓扑应该在设备管理内容里面」），
   * 所以它自己**不画边框、不留侧栏内边距**：外层 `.card` 已经提供了框，
   * 再画一条 `border-top` 就会在卡片里出现一条没有含义的横线。
   */
  padding: 0;
}

/*
 * 操作工具条（全部展开 / 全部收起 + 添加设备）。
 *
 * 左边两个图标按钮与下面的树行同一个左边界；「添加设备」推到右端（`margin-left:auto`），
 * 因为它是**这一栏的动作**而不是树的操作：贴在树头的右端既不会与「＋/－」混淆，
 * 也不会随设备数量变化而移位。
 */
.device-tree__head {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  padding: 0;
}

.device-tree__add {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.device-tree__actions {
  display: flex;
  gap: 2px;
}

.device-tree__action {
  all: unset;
  cursor: pointer;
  width: 18px;
  height: 18px;
  line-height: 18px;
  text-align: center;
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.device-tree__action:hover {
  background: rgba(23, 23, 23, 0.06);
  color: var(--color-text);
}

.device-tree__filter {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0;
}

.device-tree__input {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
}

.device-tree__clear {
  all: unset;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 3px;
}

.device-tree__clear:hover {
  color: var(--color-text);
}

.device-tree__list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  max-height: 46vh;
  outline: none;
}

.device-tree__list:focus-visible {
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

.device-tree__row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-right: 8px;
  min-height: 20px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text);
  border-left: 2px solid transparent;
}

.device-tree__row:hover {
  background: rgba(23, 23, 23, 0.04);
}

.device-tree__row--focused {
  background: rgba(23, 23, 23, 0.07);
}

.device-tree__row--selected {
  background: var(--color-accent-soft);
  border-left-color: var(--color-accent);
  font-weight: 600;
}

.device-tree__row--root {
  color: var(--color-text-secondary);
  font-weight: 600;
  cursor: default;
}

.device-tree__twisty {
  all: unset;
  flex: none;
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--color-text-secondary);
  border-radius: 3px;
}

.device-tree__twisty--leaf {
  cursor: default;
}

.device-tree__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-neutral);
}

.device-tree__dot--online {
  background: var(--color-success);
}

.device-tree__dot--offline {
  background: var(--color-danger);
}

.device-tree__dot--unknown {
  background: var(--color-warning);
}

.device-tree__label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.device-tree__label--muted {
  color: var(--color-text-secondary);
}

.device-tree__meta {
  flex: none;
  font-size: 10px;
  color: var(--color-text-secondary);
}

.device-tree__badge {
  flex: none;
  font-size: 10px;
  color: var(--color-accent);
}

.device-tree__leaf-icon {
  flex: none;
  width: 12px;
  text-align: center;
  font-size: 8px;
  color: var(--color-text-secondary);
}

.device-tree__channel {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.device-tree__channel-label {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.device-tree__channel-name {
  font-size: 10.5px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 通道状态的视觉：与监控页的通道标签共用 `channel-state--*` 的语义。 */
.device-tree__channel.channel-state--disabled {
  opacity: 0.5;
}

.device-tree__channel.channel-state--disabled .device-tree__channel-label {
  color: var(--color-text-secondary);
}

.device-tree__channel.channel-state--unknown {
  color: var(--color-warning);
}

.device-tree__empty {
  padding: 0;
  font-size: 11px;
  color: var(--color-text-secondary);
  margin: 0;
}

.device-tree__hint {
  padding: 0;
  font-size: 10px;
  color: var(--color-text-secondary);
  margin: 0;
}
</style>
