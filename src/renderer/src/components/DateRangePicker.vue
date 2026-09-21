<script setup lang="ts">
/**
 * 日历范围选择器（业主：「把开始时间和结束时间做到一个日历中」）。
 *
 * 一个按钮（显示当前范围）+ 一个弹层：快捷档 + **单个月历网格**（点一下 = 开始，
 * 再点一下 = 结束，中间区间高亮）+ 起止时刻两个输入框。确定/清除时把结果交出去。
 *
 * 与工业软件（iVMS-4200 事件检索那一类）一致的时间口径：
 *   - 快捷档按**整天/整小时**取（「今天」= 今天 00:00 起）；
 *   - 自定义时日期从日历取、时刻从两个输入框取（结束默认 23:59）。
 *
 * 值协议：与外界交换的是 `datetime-local` 格式的字符串（空串 = 不限），与两个页面的
 * 筛选状态（`filters.from/to`）同形 —— 序列化到 URL / localStorage 的那条路不用改。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fromDateTimeLocalValue, toDateTimeLocalValue } from '@renderer/lib/format'

const props = defineProps<{
  from: string
  to: string
}>()

const emit = defineEmits<{
  (event: 'apply', value: { from: string; to: string }): void
}>()

const { t } = useI18n()

const open = ref(false)
/** 弹层锚点（按钮），弹层绝对定位在它下面。 */
const rootRef = ref<HTMLElement | null>(null)

// ---------------------------------------------------------------------------
// 内部草稿状态：只在校准时改动，确定时才发 apply
// ---------------------------------------------------------------------------

interface Draft {
  start: Date | null
  end: Date | null
  viewYear: number
  viewMonth: number
}

const now = new Date()
const draft = reactive<Draft>({
  start: null,
  end: null,
  viewYear: now.getFullYear(),
  viewMonth: now.getMonth()
})

/** 按钮上的摘要文案：「2026/9/1 00:00 ~ 2026/9/2 23:59」，没选全就显示已选的那一半。 */
const summary = computed(() => {
  const from = fromDateTimeLocalValue(props.from)
  const to = fromDateTimeLocalValue(props.to)
  if (from === undefined && to === undefined) return ''
  const fmt = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const left = from !== undefined ? fmt(from) : '…'
  const right = to !== undefined ? fmt(to) : '…'
  return `${left} ~ ${right}`
})

const WEEKDAY_KEYS = ['picker.sun', 'picker.mon', 'picker.tue', 'picker.wed', 'picker.thu', 'picker.fri', 'picker.sat'] as const

interface DayCell {
  date: Date
  inMonth: boolean
}

/** 六行七列的月历网格（周一起排，与中国工业软件习惯一致）。 */
const grid = computed<DayCell[]>(() => {
  const year = draft.viewYear
  const month = draft.viewMonth
  const first = new Date(year, month, 1)
  //周一=0 … 周日=6（getDay 周日=0，左移一位）。
  const lead = (first.getDay() + 6) % 7
  const start = new Date(year, month, 1 - lead)
  const cells: DayCell[] = []
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    cells.push({ date, inMonth: date.getMonth() === month })
  }
  return cells
})

const viewLabel = computed(() => `${draft.viewYear}/${draft.viewMonth + 1}`)

function sameDay(a: Date | null, b: Date | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function dayState(date: Date): 'start' | 'end' | 'in-range' | '' {
  const start = draft.start
  const end = draft.end
  if (sameDay(date, start)) return 'start'
  if (sameDay(date, end)) return 'end'
  if (start && end && date > start && date < end) return 'in-range'
  if (start && !end && date > start && date < new Date()) return 'in-range'
  return ''
}

/** 点一天：没开始 → 开始；有开始没结束 → 结束（早于开始则交换）；都有 → 重新从开始。 */
function pickDay(date: Date): void {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
  if (!draft.start || (draft.start && draft.end)) {
    draft.start = dayStart
    draft.end = null
    return
  }
  if (dayStart < draft.start) {
    draft.end = draft.start
    draft.start = dayStart
    return
  }
  // 结束日默认 23:59:59.999（整天）；时刻输入框再细化。
  draft.end = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 23, 59)
}

function shiftMonth(delta: number): void {
  const next = new Date(draft.viewYear, draft.viewMonth + delta, 1)
  draft.viewYear = next.getFullYear()
  draft.viewMonth = next.getMonth()
}

// ---------------------------------------------------------------------------
// 快捷档：立刻算出 from/to（整天/整小时口径）并发出
// ---------------------------------------------------------------------------

function applyRange(fromMs: number | undefined, toMs: number | undefined): void {
  const from = fromMs !== undefined ? toDateTimeLocalValue(fromMs) : ''
  const to = toMs !== undefined ? toDateTimeLocalValue(toMs) : ''
  syncDraft(from, to)
  emit('apply', { from, to })
}

function presetToday(): void {
  const d = new Date()
  applyRange(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), undefined)
}

function presetLastHours(hours: number): void {
  const to = Date.now()
  applyRange(to - hours * 3600_000, to)
}

function presetAll(): void {
  applyRange(undefined, undefined)
}

// ---------------------------------------------------------------------------
// 确定 / 清除
// ---------------------------------------------------------------------------

/** 时刻输入框（HH:mm）绑的是这两个 ref，确定时并回 start/end。 */
const startTime = ref('00:00')
const endTime = ref('23:59')

function timeToParts(value: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const h = match ? Number(match[1]) : 0
  const m = match ? Number(match[2]) : 0
  return { h: Math.min(23, Math.max(0, h)), m: Math.min(59, Math.max(0, m)) }
}

function confirm(): void {
  if (!draft.start) return
  const s = timeToParts(startTime.value)
  const from = new Date(draft.start.getFullYear(), draft.start.getMonth(), draft.start.getDate(), s.h, s.m)
  let toMs: number | undefined
  if (draft.end) {
    const e = timeToParts(endTime.value)
    toMs = new Date(draft.end.getFullYear(), draft.end.getMonth(), draft.end.getDate(), e.h, e.m).getTime()
  }
  applyRange(from.getTime(), toMs)
  open.value = false
}

function clear(): void {
  applyRange(undefined, undefined)
  open.value = false
}

// ---------------------------------------------------------------------------
// 打开弹层时把外界的值灌进草稿（双向同步只在打开这一瞬间发生）
// ---------------------------------------------------------------------------

function syncDraft(from: string, to: string): void {
  const fromMs = fromDateTimeLocalValue(from)
  const toMs = fromDateTimeLocalValue(to)
  draft.start = fromMs !== undefined ? new Date(fromMs) : null
  draft.end = toMs !== undefined ? new Date(toMs) : null
  const anchor = draft.start ?? draft.end ?? new Date()
  draft.viewYear = anchor.getFullYear()
  draft.viewMonth = anchor.getMonth()
  if (fromMs !== undefined) {
    const d = new Date(fromMs)
    startTime.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (toMs !== undefined) {
    const d = new Date(toMs)
    endTime.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    syncDraft(props.from, props.to)
    document.addEventListener('mousedown', onOutside)
  } else {
    document.removeEventListener('mousedown', onOutside)
  }
})

/** 点弹层外面收起（mousedown 先于 click，菜单内的点击不会误关）。 */
function onOutside(event: MouseEvent): void {
  if (!rootRef.value) return
  if (!rootRef.value.contains(event.target as Node)) open.value = false
}
</script>

<template>
  <div ref="rootRef" class="range-picker" data-range-picker>
    <button
      type="button"
      class="input range-picker__button"
      :class="{ 'range-picker__button--active': open || summary !== '' }"
      data-range-picker-toggle
      :aria-expanded="open"
      @click="open = !open"
    >
      <span v-if="summary" class="range-picker__summary">{{ summary }}</span>
      <span v-else class="range-picker__placeholder">{{ t('picker.placeholder') }}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <rect x="2" y="3" width="12" height="11" rx="1.5" />
        <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
      </svg>
    </button>

    <div v-if="open" class="range-picker__popover" data-range-picker-popover @mousedown.stop>
      <div class="range-picker__presets">
        <button type="button" class="btn btn--sm" data-preset="all" @click="presetAll()">{{ t('picker.presetAll') }}</button>
        <button type="button" class="btn btn--sm" data-preset="today" @click="presetToday()">{{ t('picker.presetToday') }}</button>
        <button type="button" class="btn btn--sm" data-preset="1h" @click="presetLastHours(1)">{{ t('picker.preset1h') }}</button>
        <button type="button" class="btn btn--sm" data-preset="24h" @click="presetLastHours(24)">{{ t('picker.preset24h') }}</button>
        <button type="button" class="btn btn--sm" data-preset="7d" @click="presetLastHours(168)">{{ t('picker.preset7d') }}</button>
      </div>

      <div class="range-picker__calendar">
        <div class="range-picker__month-bar">
          <button type="button" class="btn btn--sm btn--ghost" data-nav="prev" :aria-label="t('picker.prevMonth')" @click="shiftMonth(-1)">‹</button>
          <span class="range-picker__month-label" data-month-label>{{ viewLabel }}</span>
          <button type="button" class="btn btn--sm btn--ghost" data-nav="next" :aria-label="t('picker.nextMonth')" @click="shiftMonth(1)">›</button>
        </div>
        <div class="range-picker__weekdays">
          <span v-for="key in WEEKDAY_KEYS" :key="key">{{ t(key) }}</span>
        </div>
        <div class="range-picker__grid" data-calendar-grid>
          <button
            v-for="(cell, index) in grid"
            :key="index"
            type="button"
            class="range-picker__day"
            :class="{
              'range-picker__day--outside': !cell.inMonth,
              'range-picker__day--start': dayState(cell.date) === 'start',
              'range-picker__day--end': dayState(cell.date) === 'end',
              'range-picker__day--in': dayState(cell.date) === 'in-range'
            }"
            :data-day="`${cell.date.getFullYear()}-${cell.date.getMonth() + 1}-${cell.date.getDate()}`"
            @click="pickDay(cell.date)"
          >
            {{ cell.date.getDate() }}
          </button>
        </div>
      </div>

      <div class="range-picker__times">
        <label class="range-picker__time">
          <span>{{ t('picker.startTime') }}</span>
          <input v-model="startTime" class="input" type="time" data-start-time />
        </label>
        <label class="range-picker__time">
          <span>{{ t('picker.endTime') }}</span>
          <input v-model="endTime" class="input" type="time" data-end-time />
        </label>
      </div>

      <div class="range-picker__actions">
        <button type="button" class="btn btn--sm" data-action="clear" @click="clear()">{{ t('picker.clear') }}</button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          data-action="confirm"
          :disabled="!draft.start"
          @click="confirm()"
        >
          {{ t('picker.confirm') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.range-picker {
  position: relative;
  min-width: 220px;
}

.range-picker__button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  cursor: pointer;
  text-align: left;
}

.range-picker__placeholder {
  color: var(--color-text-secondary, #777);
}

.range-picker__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.range-picker__popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  width: 300px;
  padding: 10px;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, rgba(0, 0, 0, 0.15));
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.range-picker__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.range-picker__month-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.range-picker__month-label {
  font-weight: 600;
}

.range-picker__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  font-size: 11px;
  color: var(--color-text-secondary, #777);
  text-align: center;
  margin-bottom: 2px;
}

.range-picker__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.range-picker__day {
  height: 30px;
  border: none;
  background: transparent;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.range-picker__day:hover {
  background: rgba(0, 0, 0, 0.06);
}

.range-picker__day--outside {
  color: var(--color-text-secondary, #aaa);
}

.range-picker__day--in {
  background: rgba(46, 125, 50, 0.12);
  border-radius: 0;
}

.range-picker__day--start,
.range-picker__day--end {
  background: var(--color-primary, #2e7d32);
  color: #fff;
}
</style>
