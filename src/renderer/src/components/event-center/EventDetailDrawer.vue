<script setup lang="ts">
/**
 * 事件详情抽屉（规格 §11）：**原位**展开的右侧面板，不换页。
 *
 * 这一版做的是 Phase 4 的两件事（规格 §18.1）：抽屉本体（400–560 可拖、不跳页、
 * Esc 关闭、↑/↓ 换条）+ 已经实现的页签内容（Overview / Evidence）。
 * Timeline / Related / Activity 属于 Phase 5（它们的素材是状态变更记录与聚合结果），
 * 所以页签条里**没有**它们 —— 画出三个永远空着的页签比不画更糟。
 *
 * ---------------------------------------------------------------------------
 * 三个刻意的决定
 * ---------------------------------------------------------------------------
 * 1. **结构在组件里，动作在页面里**。抽屉负责几何、页签、头部与键盘；确认、下载结果文件、
 *    播放这些动作仍然由 `EventCenterView.vue` 通过插槽放进来。理由：那些动作已经有一条
 *    验证过的路径（能力决定渲染 + 写完读回），把它们搬进组件只会多一层 props 转发，
 *    而不会有任何界面上的差别。
 * 2. **宽度是受控的**（`:width` + `@resize`）：偏好要落到 localStorage，而"存哪儿"
 *    是页面/store 的事（与筛选、视图模式同一条做法）。
 * 3. **↑/↓ 只在焦点位于抽屉内部时接管**。队列自己也处理 ↑/↓（它是列表的键盘入口），
 *    如果抽屉在 window 上无条件接管，一次按键会跳两条 —— 一个很难查的"跳着走"缺陷。
 *    Esc 是例外：它是覆盖层的通用关闭键，焦点在哪都该管用。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  DETAIL_DRAWER_MAX,
  DETAIL_DRAWER_MIN,
  IMPLEMENTED_DETAIL_TABS,
  clampDrawerWidth,
  detailTabLabelKey,
  statusActionsFor
} from '@shared/domain/event-view'
import type {
  AlertViewModel,
  EventDetailTab,
  EventStatusAction,
  StatusActionDescriptor
} from '@shared/domain/event-view'
import { formatRelativeTime } from '@renderer/lib/format'

const props = defineProps<{
  alert: AlertViewModel
  /** 抽屉宽度（受控；400–560，由页面夹住并存起来）。 */
  width: number
  /** 当前页签（受控，`v-model:tab`）。 */
  tab: EventDetailTab
  /**
   * 可以指派给谁。空数组（或没给）时**不出现**「指派」这个动作 ——
   * 点开只有一个空列表比没有这个按钮更糟。
   */
  assignees?: readonly { username: string; displayName?: string }[]
  /** 处置动作正在提交（禁用按钮，避免连点两次状态变更）。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'resize', width: number): void
  (event: 'update:tab', tab: EventDetailTab): void
  (event: 'prev'): void
  (event: 'next'): void
  /** 点头部那台设备的名字（跳到设备详情页；路由由页面决定）。 */
  (event: 'open-device'): void
  /**
   * 请求一次处置（状态变更 / 指派）。
   *
   * 抽屉只负责"点了哪个动作、填了什么"，**写库由页面做**：状态是页面的数据，
   * 而且写完要重查一次（页面才知道怎么刷新队列与 KPI）。
   */
  (event: 'status-action', payload: { action: EventStatusAction; assignee?: string; note?: string }): void
}>()

const { t } = useI18n()

const drawerRef = ref<HTMLElement | null>(null)
const resizing = ref(false)

const severityClass = computed(() =>
  props.alert.severityUnknown ? 'severity--unknown' : `severity--${props.alert.severity}`
)

const severityText = computed(() =>
  props.alert.severityUnknown
    ? t('eventsUi.severityUnknown')
    : t(`eventsUi.alertSeverity.${props.alert.severity}`)
)

/** 头部的副标题：来源（设备名是它前面那个可点的链接，规格 §11.2 的第二行）。 */
const sourceText = computed(() => t(`domain.eventSource.${props.alert.source}`))
const firstDetected = computed(() => formatRelativeTime(props.alert.firstDetectedAt))

const width = computed(() => clampDrawerWidth(props.width))

// ---------------------------------------------------------------------------
// 处置动作（规格 §2.2 / §11.2）
// ---------------------------------------------------------------------------

/**
 * 当前状态下能做什么（规格 §11.2：主 CTA 只有一个）。
 *
 * `statusActionsFor` 是纯函数（有单测）：它保证主 CTA 恰好一个、没有确认接口的来源里
 * 不出现「确认」、`reopen` 必须带原因、`muted` 只给一个「取消静默」。
 */
const statusActions = computed(() =>
  statusActionsFor(props.alert.status, {
    locked: props.alert.statusLocked,
    canAssign: (props.assignees?.length ?? 0) > 0
  })
)
const primaryAction = computed(() => statusActions.value.find((action) => action.primary === true))
const secondaryActions = computed(() =>
  statusActions.value.filter((action) => action.primary !== true)
)

/** 正在等一个输入的动作（指派要选人、重新开启要写原因）。 */
const pendingAction = ref<EventStatusAction | null>(null)
const assigneeDraft = ref('')
const noteDraft = ref('')
const noteMissing = ref(false)

function runAction(action: StatusActionDescriptor): void {
  if (action.id === 'assign') {
    pendingAction.value = 'assign'
    assigneeDraft.value = props.assignees?.[0]?.username ?? ''
    return
  }
  if (action.requiresNote === true) {
    pendingAction.value = action.id
    noteDraft.value = ''
    noteMissing.value = false
    return
  }
  emit('status-action', { action: action.id })
}

function confirmPending(): void {
  const action = pendingAction.value
  if (action === null) return
  if (action === 'assign') {
    if (assigneeDraft.value.trim() === '') return
    emit('status-action', { action: 'assign', assignee: assigneeDraft.value })
  } else {
    const note = noteDraft.value.trim()
    if (note === '') {
      // 规格 §2.2：重新开启要记原因。空白原因不许提交（服务端也会拒绝，这里是提前说清）。
      noteMissing.value = true
      return
    }
    emit('status-action', { action, note })
  }
  pendingAction.value = null
  noteMissing.value = false
}

function cancelPending(): void {
  pendingAction.value = null
  noteMissing.value = false
}

// 换一条事件时把没提交完的表单收掉：否则上一条的原因会挂在另一条上。
watch(
  () => props.alert.id,
  () => cancelPending()
)

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  /**
   * ↑/↓ 与 J/K：只在焦点落在抽屉里的时候接管（见文件头的第 3 条）。
   * 队列里的 ↑/↓ 是列表自己的键盘入口，两边都响应会让一次按键跳两条。
   */
  const node = event.target instanceof Node ? event.target : null
  if (!node || !drawerRef.value?.contains(node)) return
  const key = event.key
  if (key === 'ArrowUp' || key === 'k' || key === 'K') {
    event.preventDefault()
    emit('prev')
    return
  }
  if (key === 'ArrowDown' || key === 'j' || key === 'J') {
    event.preventDefault()
    emit('next')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  /**
   * 打开就把焦点收进抽屉：它是一个覆盖层（`aria-modal`），焦点留在后面的列表上
   * 会让读屏用户以为自己还在列表里，也会让 ↑/↓ 落到队列那一套处理上。
   */
  void nextTick(() => drawerRef.value?.focus())
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  stopResize()
})

// ---------------------------------------------------------------------------
// 拖拽改宽度（规格 §11.1：400–560）
// ---------------------------------------------------------------------------

/** 拖拽的起点：**用 clientX 的差值**而不是 `movementX` 累加（后者会漂）。 */
let dragStartX = 0
let dragStartWidth = 0

function onResizeMove(event: MouseEvent): void {
  // 拖左边缘：往左拖 = 变宽。
  emit('resize', clampDrawerWidth(dragStartWidth - (event.clientX - dragStartX)))
}

function stopResize(): void {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  document.body.style.userSelect = ''
}

function onResizeStart(event: MouseEvent): void {
  resizing.value = true
  dragStartX = event.clientX
  dragStartWidth = width.value
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', stopResize)
  // 拖的时候不要顺手选中面板里的文字。
  document.body.style.userSelect = 'none'
  event.preventDefault()
}

/** 键盘也能改宽度（抓手可 Tab 到；每次 16px）。 */
function onResizeKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    emit('resize', clampDrawerWidth(width.value + 16))
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    emit('resize', clampDrawerWidth(width.value - 16))
  }
}

// 换一条事件时把滚动位置拉回顶部：否则会出现"看到的是上一条的中段"。
watch(
  () => props.alert.id,
  () => {
    void nextTick(() => {
      drawerRef.value?.querySelector('.drawer__body')?.scrollTo({ top: 0 })
    })
  }
)
</script>

<template>
  <div class="drawer-overlay" @click.self="emit('close')">
    <aside
      ref="drawerRef"
      class="drawer"
      :class="[severityClass, { 'drawer--resizing': resizing }]"
      role="dialog"
      aria-modal="true"
      :aria-label="t('eventsUi.detailTitle')"
      tabindex="-1"
      :style="{ width: `${width}px` }"
    >
      <!-- 拖拽抓手：贴在抽屉左缘，只改宽度（不换页、不重排）。 -->
      <div
        class="drawer__resize"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('eventsUi.drawerResize')"
        :aria-valuenow="width"
        :aria-valuemin="DETAIL_DRAWER_MIN"
        :aria-valuemax="DETAIL_DRAWER_MAX"
        tabindex="0"
        data-action="drawer-resize"
        @mousedown="onResizeStart"
        @keydown="onResizeKeydown"
      ></div>

      <header class="drawer__header">
        <div class="drawer__heading">
          <span class="drawer__severity">{{ severityText }}</span>
          <div class="drawer__titles">
            <h3 class="drawer__title">{{ t(alert.titleKey) }}</h3>
            <p class="drawer__sub">
              <button type="button" class="link-btn" @click="emit('open-device')">
                {{ alert.deviceName }}
              </button>
              <span class="muted"> · {{ sourceText }}</span>
            </p>
            <p class="drawer__sub muted">{{ t('eventsUi.overviewFirstDetected') }} {{ firstDetected }}</p>
          </div>
        </div>
        <div class="drawer__header-actions">
          <!-- 主 CTA（规格 §11.2：一次只有一个）。没有确认接口的来源里不出现「确认」。 -->
          <button
            v-if="primaryAction"
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="busy === true"
            data-action="status-primary"
            :data-status-action="primaryAction.id"
            @click="runAction(primaryAction)"
          >
            {{ t(primaryAction.labelKey) }}
          </button>
          <button
            v-for="action in secondaryActions"
            :key="action.id"
            type="button"
            class="btn btn--sm"
            :disabled="busy === true"
            :data-status-action="action.id"
            @click="runAction(action)"
          >
            {{ t(action.labelKey) }}
          </button>
          <button
            type="button"
            class="btn btn--ghost btn--icon"
            :aria-label="t('common.close')"
            data-action="drawer-close"
            @click="emit('close')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 3l10 10M13 3L3 13"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

      <!--
        需要输入的处置动作（指派要选人、重新开启要写原因）。
        这是**行内表单**而不是弹出层：抽屉本身已经是覆盖层，再叠一层弹窗就得处理两层 Esc。
      -->
      <div v-if="pendingAction" class="drawer__action-form" data-action="status-form">
        <template v-if="pendingAction === 'assign'">
          <label class="field">
            <span class="field-label">{{ t('eventsUi.actionAssignee') }}</span>
            <select v-model="assigneeDraft" class="select" data-field="assignee">
              <option v-for="person in assignees" :key="person.username" :value="person.username">
                {{ person.displayName ?? person.username }}
              </option>
            </select>
          </label>
        </template>
        <template v-else>
          <label class="field drawer__action-note">
            <span class="field-label">{{ t('eventsUi.actionNote') }}</span>
            <input
              v-model="noteDraft"
              class="input"
              type="text"
              data-field="note"
              :placeholder="t('eventsUi.actionReopenNotePlaceholder')"
              @keydown.enter.prevent="confirmPending"
            />
          </label>
        </template>
        <div class="btn-row">
          <button
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="busy === true"
            data-action="status-confirm"
            @click="confirmPending"
          >
            {{ t('eventsUi.actionConfirm') }}
          </button>
          <button type="button" class="btn btn--sm" @click="cancelPending">
            {{ t('eventsUi.actionCancel') }}
          </button>
        </div>
        <p v-if="noteMissing" class="alert alert--warning" role="alert">
          {{ t('eventsUi.actionNoteEmpty') }}
        </p>
      </div>

      <!--
        页签（规格 §11.3）：高 40、13/500，选中项是**文字变深 + 2px 橙色下划线**，
        不是整块橙底（规格明确禁止整块橙）。
      -->
      <div class="drawer__tabs" role="tablist">
        <button
          v-for="item in IMPLEMENTED_DETAIL_TABS"
          :key="item"
          type="button"
          class="drawer__tab"
          :class="{ 'drawer__tab--active': tab === item }"
          role="tab"
          :aria-selected="tab === item"
          :data-tab="item"
          @click="emit('update:tab', item)"
        >
          {{ t(detailTabLabelKey(item)) }}
        </button>
      </div>

      <div class="drawer__body">
        <div v-show="tab === 'overview'" role="tabpanel" data-panel="overview">
          <slot name="overview" />
        </div>
        <div v-show="tab === 'evidence'" role="tabpanel" data-panel="evidence">
          <slot name="evidence" />
        </div>
        <div v-show="tab === 'timeline'" role="tabpanel" data-panel="timeline">
          <slot name="timeline" />
        </div>
        <div v-show="tab === 'related'" role="tabpanel" data-panel="related">
          <slot name="related" />
        </div>
        <div v-show="tab === 'activity'" role="tabpanel" data-panel="activity">
          <slot name="activity" />
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  justify-content: flex-end;
  background: var(--color-scrim);
}

.drawer {
  position: relative;
  /* 宽度**由组件按 `:width` 内联给出**（400–560）。这里的值是内联样式设不上时的兜底，
     同时也是 CSS 侧的声明：`main.css` 的 `--detail-panel` 就是规格的 400。
     没有这一条内联绑定，"拖了也没变宽"—— 探针第一次跑就抓到了这个缺陷。 */
  width: var(--detail-panel);
  max-width: 94vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-left: 3px solid var(--severity-accent, var(--color-border));
  background: var(--color-bg);
  box-shadow: var(--shadow-lg);
}

.drawer:focus {
  outline: none;
}

.drawer--resizing {
  cursor: col-resize;
}

/* 抓手：8px 宽，视觉上只有一条 1px 线；hover/聚焦时变橙。 */
.drawer__resize {
  position: absolute;
  top: 0;
  left: -4px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
}

.drawer__resize::after {
  content: '';
  position: absolute;
  top: 0;
  left: 3px;
  width: 1px;
  height: 100%;
  background: transparent;
}

.drawer__resize:hover::after,
.drawer__resize:focus-visible::after {
  background: var(--color-accent);
}

.drawer__resize:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.drawer__heading {
  display: flex;
  align-items: flex-start;
  flex: 1 1 280px;
  gap: var(--space-3);
  min-width: 0;
}

/* 等级：文字 + 左侧一道短色条（与队列同一套严重度 token）。 */
.drawer__severity {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--severity-soft, var(--color-bg-hover));
  color: var(--severity-accent, var(--color-text-secondary));
  font-size: var(--font-size-meta);
  font-weight: 600;
  white-space: nowrap;
}

.drawer__titles {
  flex: 1 1 auto;
  min-width: 0;
}

.drawer__title {
  margin: 0;
  font-size: var(--font-size-panel);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.drawer__sub {
  margin: 2px 0 0;
  font-size: var(--font-size-meta);
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.drawer__header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  margin-left: auto;
}

/* 需要输入的处置动作：贴在头部下面的一条行内表单。 */
.drawer__action-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
}

.drawer__action-note {
  flex: 1 1 200px;
  min-width: 0;
}

.drawer__action-form .alert {
  flex: 1 1 100%;
  margin: 0;
}

.drawer__tabs {
  display: flex;
  align-items: stretch;
  gap: var(--space-4);
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.drawer__tab {
  height: 40px;
  padding: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-small);
  font-weight: 500;
  cursor: pointer;
}

.drawer__tab--active {
  color: var(--color-text);
  border-bottom-color: var(--color-accent);
}

.drawer__tab:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.drawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
}

/* 属性网格（规格 §11.4：2 列；长字段跨两列）。 */
.drawer__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-4);
}

.drawer__field {
  min-width: 0;
}

.drawer__field--wide {
  grid-column: 1 / -1;
}
</style>
