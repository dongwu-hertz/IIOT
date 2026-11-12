<script setup lang="ts">
/**
 * 待处理告警面板（「提示」的界面部分）。
 *
 * ---------------------------------------------------------------------------
 * 为什么它挂在 shell 的顶栏上，而不是某个页面里
 * ---------------------------------------------------------------------------
 * 产品要求提示要能在导航之后仍然看得见。挂在页面里做不到这一点：切页即卸载，
 * 提示就没了，操作员会以为告警已经处理过。挂在 shell 上之后：
 *
 *   - 顶栏角标在任何页面都可见（未确认条数直接显示在角标上）；
 *   - 面板展开后可以逐条确认，也可以「全部确认」；
 *   - 数据来自 store，而 store 的真相在主进程并已落盘，所以刷新页面也不丢。
 *
 * 面板只做**呈现与派发**：排序、过滤、格式化都在这里，任何判断（比如
 * 「这条为什么没有录像」）读的都是主进程给的 `actions[]`，界面不重新推断。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAlarmLinkageStore } from '@renderer/stores/alarmLinkage'
import { useAppNoticesStore } from '@renderer/stores/appNotices'
import { useDevicesStore } from '@renderer/stores/devices'
import { callApi, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import type { AlarmEvent } from '@shared/domain/models'
import type { LinkageActionRecord, PendingAlarmRecord } from '@shared/ipc/contract'
import { linkageDischargeText, linkageMetricsText } from '@renderer/lib/linkageText'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const linkage = useAlarmLinkageStore()
const devices = useDevicesStore()
/**
 * 应用级的失败与提示（「认证失败，请检查用户名与密码」这一类）。
 *
 * 业主 2026-09-18：这类内容放在**告警图标**里，不要挂在页面顶上 —— 面板是浮层，出现
 * 与消失都不动布局。来源与口径见 `stores/appNotices.ts` 的文件头。
 */
const notices = useAppNoticesStore()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const acknowledging = ref(false)

/**
 * **设备推送过来的告警**（业主 2026-09-19 第 2 条：「告警条目是指其他设备推送到来的告警
 * 都应该显示在右上方那个告警图标按钮上」）。
 *
 * 来源是**告警表**（`alarms`，`ALARM_SOURCES = ['fa8','e2']`）里还没有确认的那些行 ——
 * 也就是设备自己推上来的告警。**不是**联动那一份：联动记录说的是"我们为这条告警做了什么"
 * （见下面那个分区），两者不是同一种东西。
 *
 * 角标口径（2026-09-24 改）：两路都数——设备告警 + 相机联动待处理。此前角标只数设备
 * 告警，相机报警时铃铛一动不动，正是业主报的"不同步"。两路不重叠（相机告警不进告警表、
 * 盒子告警不进联动列表），相加不会重复计数；面板里两个分区也都在，数字与内容同源。
 */
const deviceAlarms = ref<AlarmEvent[]>([])
const deviceAlarmTotal = ref(0)
const deviceAlarmsLoading = ref(false)

async function loadDeviceAlarms(): Promise<void> {
  deviceAlarmsLoading.value = true
  const result = await callApi(() => window.api.alarms.query({ acknowledged: false, limit: 20 }))
  deviceAlarmsLoading.value = false
  if (!result.success) {
    // 读不到就**不动**上一次的数字与列表：把失败显示成"没有告警"是本仓库最反对的那种假话。
    return
  }
  const page = unwrap(result)
  deviceAlarms.value = page?.items ?? []
  deviceAlarmTotal.value = page?.total ?? 0
}

/** 角标上的数：未确认的**设备告警**条数 + 未确认的**相机联动告警**条数（2026-09-24 同步修复）。 */
const bellCount = computed(() => deviceAlarmTotal.value + linkage.unacknowledgedCount)

/**
 * 图标红点（业主 2026-09-24）：有未确认的**高级**（3 级及以上 / critical）告警。
 * 两路来源都数：相机联动记录按 `alarmLevelRaw` ≥3，声纹设备告警按 severity=critical。
 */
const hasHighLevelAlarm = computed(
  () =>
    linkage.unacknowledged.some((item) => (item.alarmLevelRaw ?? 0) >= 3) ||
    deviceAlarms.value.some((alarm) => alarm.severity === 'critical')
)

async function acknowledgeDeviceAlarm(id: string): Promise<void> {
  acknowledging.value = true
  const result = await callApi(() => window.api.alarms.acknowledge([id], true))
  acknowledging.value = false
  if (!result.success) return
  await loadDeviceAlarms()
  await linkage.load()
}

async function acknowledgeAllDeviceAlarms(): Promise<void> {
  acknowledging.value = true
  const ids = deviceAlarms.value.map((alarm) => alarm.id)
  const result = await callApi(() => window.api.alarms.acknowledge(ids, true))
  acknowledging.value = false
  if (!result.success) return
  await loadDeviceAlarms()
  await linkage.load()
}

/** 面板打开那一刻重读一次（角标与列表都要是**此刻**的事实）。 */
function toggle(): void {
  open.value = !open.value
  if (open.value) void loadDeviceAlarms()
}

/** 点击其他页面/侧栏/空白处时收起面板；路由变化也收起，避免顶栏浮层跨页残留。 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && root.value && !root.value.contains(target)) open.value = false
}

watch(
  () => route.fullPath,
  () => {
    open.value = false
  }
)
let unsubscribe: (() => void) | undefined

onMounted(() => {
  void loadDeviceAlarms()
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  /*
   * 联动引擎推来一条待处理时也重读一次设备告警：设备推来的那条告警很可能就是这同一条事件
   * 引起的，早一次读到，角标就早一格正确。
   */
  unsubscribe = linkage.subscribe()
})

onUnmounted(() => {
  unsubscribe?.()
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

/**
 * 图标按钮的无障碍名字。
 *
 * 角标里的数是**未确认的设备告警条数**（`bellCount`，与面板里那个分区同源），
 * 系统消息只用一个**点**表示"有东西要看"。把两者加起来写进同一个数字，就是
 * 本仓库最反对的"一个数字配一份别的列表"。
 */
const bellLabel = computed(() =>
  notices.count > 0
    ? t('noticesUi.bellWithProblems', { count: notices.count })
    : t('linkage.bellTitle', { count: bellCount.value })
)

/**
 * 未确认的排前面，其余按时间倒序。
 *
 * 排序刻意不按「到达顺序」：一份落盘的列表在重启之后到达顺序已经没有意义了，
 * 而时间戳是事件自己的属性。
 */
const rows = computed<PendingAlarmRecord[]>(() =>
  [...linkage.pending].sort((left, right) => {
    if (left.acknowledged !== right.acknowledged) return left.acknowledged ? 1 : -1
    return right.at - left.at
  })
)

/** 一条动作结果的中文/英文/… 一行说明。 */
/**
 * AO01 等纯传感器设备没有 RTSP 视频源：联动录像动作不适用。旧版本可能已经把
 * 一条 failed 的 record 动作写进待处理快照，界面也必须过滤掉。
 */
function actionsForRow(row: PendingAlarmRecord): LinkageActionRecord[] {
  const device = devices.byId(row.deviceId)
  if (device && device.kind !== 'acousticCamera') {
    return row.actions.filter((action) => action.action !== 'record')
  }
  return row.actions
}

function actionLine(record: LinkageActionRecord): string {
  const state = t(`linkage.actionState.${record.status}`)
  const name = t(`linkage.action.${record.action}`)
  return record.reason ? `${name}: ${state} — ${record.reason}` : `${name}: ${state}`
}

/** 动作结果的样式（成功绿、失败红、跳过灰）。 */
function actionClass(record: LinkageActionRecord): string {
  return `action-line action-line--${record.status}`
}

/**
 * 一条告警的设备侧指标（按检测模式取舍，2026-09-23）。
 * 实现搬去 `lib/linkageText.ts`（铃铛面板 / 监测页告警卡 / 告警中心相机区块共用）。
 */
function metrics(record: PendingAlarmRecord): string {
  return linkageMetricsText(t, record)
}

/** 放电类型的翻译键；未知取值不显示（宁缺毋假）。 */
function dischargeLabel(record: PendingAlarmRecord): string {
  return linkageDischargeText(t, record)
}

async function acknowledgeOne(eventId: string): Promise<void> {
  acknowledging.value = true
  await linkage.acknowledge([eventId])
  acknowledging.value = false
}

async function acknowledgeAll(): Promise<void> {
  acknowledging.value = true
  await linkage.acknowledge()
  acknowledging.value = false
}

/** 面板底部的出口：去告警记录页看全部记录。关掉面板，否则它会留在新页面顶上。 */
function goToAlarms(): void {
  open.value = false
  void router.push('/alarms')
}
</script>

<template>
  <div ref="root" class="alarm-badge">
    <!--
      这一颗就是顶栏的**告警图标**（产品要求：待处理告警与告警图标合在一起）。
      以前它旁边还另有一个「待处理告警」按钮 + 一颗只显示未确认告警数的铃铛，两处说的是
      同一类事、数字却来自两个不同的源 —— 合并之后**只有一个入口、一个数字**：
      角标数 = 下面面板里列出的待处理告警条数（`unacknowledgedCount`）。数字与列表必须
      同源，否则就是本仓库最反对的那种「界面说假话」。
    -->
    <button
      type="button"
      class="alarm-badge__button"
      :class="{ 'alarm-badge__button--active': bellCount > 0 }"
      :title="t('linkage.pendingShow')"
      :aria-label="bellLabel"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="alarm-badge__icon" aria-hidden="true">
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M8 2.3a3.7 3.7 0 00-3.7 3.7c0 3.1-1.3 4.1-1.3 4.1h10s-1.3-1-1.3-4.1A3.7 3.7 0 008 2.3z" />
          <path d="M6.6 12.3a1.5 1.5 0 002.8 0" />
        </svg>
      </span>
      <!--
        系统消息的标记是一个**点**，不是数字：数字位置已经被"待处理告警条数"占了，
        两者相加或互相替换都会让角标说出一个不对的数（见 `bellLabel`）。
      -->
      <span
        v-if="notices.count > 0"
        class="alarm-badge__problem"
        data-bell-problem
        aria-hidden="true"
      ></span>
      <!--
        高级告警红点（业主 2026-09-24）：有未确认的 3 级及以上告警时，图标右上角
        一颗红点——只回答"有没有要紧的"，不抢数字角标的位置。
      -->
      <span
        v-if="hasHighLevelAlarm"
        class="alarm-badge__critical"
        data-bell-critical
        aria-hidden="true"
      ></span>
      <span v-if="bellCount > 0" class="alarm-badge__count" data-bell-count>
        {{ bellCount }}
      </span>
    </button>

    <!-- 面板：绝对定位在顶栏之下，不参与页面布局（否则打开面板会挤动内容）。 -->
    <div v-if="open" class="alarm-panel" role="dialog" :aria-label="t('linkage.pendingTitle')">
      <!--
        系统消息在最上面：它们是**应用级**的失败（设备列表读不出来、设置读不出来……），
        操作员点开这颗图标最可能就是来找它们的。没有的时候整块不画 —— 一条空标题
        只会让人以为下面那些告警属于它。
      -->
      <section v-if="notices.count > 0" class="alarm-panel__problems" data-app-notices>
        <div class="alarm-panel__problems-head">
          <strong>{{ t('noticesUi.title') }}</strong>
          <button type="button" class="btn btn--sm" @click="notices.clearAll()">
            {{ t('noticesUi.clearAll') }}
          </button>
        </div>
        <ul class="problem-list">
          <li
            v-for="problem in notices.items"
            :key="problem.id"
            class="problem"
            :class="`problem--${problem.kind}`"
            data-app-notice
          >
            <span class="problem__text">{{ problem.text }}</span>
            <span class="problem__time">{{ formatDateTime(problem.at) }}</span>
            <button
              type="button"
              class="problem__dismiss"
              :title="t('noticesUi.dismiss')"
              :aria-label="t('noticesUi.dismiss')"
              @click="notices.clear(problem.id)"
            >
              ×
            </button>
          </li>
        </ul>
      </section>

      <div class="alarm-panel__head">
        <strong>{{ t('linkage.deviceAlarmsTitle') }}</strong>
        <button
          v-if="deviceAlarms.length > 0"
          type="button"
          class="btn btn--sm"
          :disabled="acknowledging"
          @click="acknowledgeAllDeviceAlarms"
        >
          {{ t('linkage.pendingAcknowledgeAll') }}
        </button>
      </div>

      <!--
        设备推送过来的告警（业主 2026-09-19 第 2 条）。**这一段的条数就是角标上的数**
        （角标读 `total`，这里最多列 20 条；超过时下面那句写明"还有多少条"）。
      -->
      <p v-if="deviceAlarmsLoading" class="muted alarm-panel__empty">
        {{ t('common.loading') }}
      </p>
      <p v-else-if="deviceAlarms.length === 0" class="alarm-panel__empty" data-bell-device-empty>
        {{ t('linkage.deviceAlarmsEmpty') }}
      </p>
      <ul v-else class="alarm-list" data-bell-device-alarms>
        <li
          v-for="alarm in deviceAlarms"
          :key="alarm.id"
          class="alarm-item"
          :data-bell-alarm-id="alarm.id"
        >
          <div class="alarm-item__head">
            <span class="alarm-item__device">{{ devices.nameById(alarm.deviceId) }}</span>
            <span class="alarm-item__time">{{ formatDateTime(alarm.timestamp) }}</span>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="acknowledging"
              :data-action="`bell-ack-${alarm.id}`"
              @click="acknowledgeDeviceAlarm(alarm.id)"
            >
              {{ t('linkage.deviceAlarmAcknowledge') }}
            </button>
          </div>
          <div class="alarm-item__meta">
            <span v-if="alarm.spl !== undefined">{{ formatNumber(alarm.spl, 1) }} dB</span>
            <span v-if="alarm.deviceReason">{{ alarm.deviceReason }}</span>
            <span v-else-if="alarm.alarmTypes.length > 0">
              {{ alarm.alarmTypes.map((type) => t(`alarmType.${type}`)).join(' · ') }}
            </span>
          </div>
        </li>
      </ul>
      <p v-if="deviceAlarmTotal > deviceAlarms.length" class="muted alarm-panel__empty">
        {{ t('linkage.deviceAlarmsMore', { count: deviceAlarmTotal - deviceAlarms.length }) }}
      </p>

      <!--
        联动那一份**单独一段**：它说的是"我们为这些告警做了什么"（录像 / 抓帧 / 声光…），
        不是告警本身 —— 所以它**不进角标**（角标只数设备推来的告警）。
      -->
      <div class="alarm-panel__head">
        <strong>{{ t('linkage.pendingTitle') }}</strong>
        <button
          v-if="linkage.unacknowledgedCount > 0"
          type="button"
          class="btn btn--sm"
          :disabled="acknowledging"
          @click="acknowledgeAll"
        >
          {{ t('linkage.pendingAcknowledgeAll') }}
        </button>
      </div>

      <p v-if="linkage.dropped > 0" class="alarm-panel__dropped">
        {{ t('linkage.pendingDropped', { count: linkage.dropped }) }}
      </p>
      <p v-if="!linkage.status?.enabled" class="alarm-panel__off">
        {{ t('linkage.pendingEngineOff') }}
      </p>

      <p v-if="rows.length === 0" class="alarm-panel__empty">{{ t('linkage.pendingEmpty') }}</p>

      <ul v-else class="alarm-list">
        <li
          v-for="row in rows"
          :key="row.eventId"
          class="alarm-item"
          :class="{ 'alarm-item--ack': row.acknowledged }"
        >
          <div class="alarm-item__head">
            <span class="alarm-item__device">{{ row.deviceName }}</span>
            <span class="alarm-item__time">{{ formatDateTime(row.at) }}</span>
            <span
              v-if="row.acknowledged"
              class="alarm-item__tag alarm-item__tag--ack"
            >{{ t('linkage.pendingAcknowledged') }}</span>
            <span v-else class="alarm-item__tag">{{ t(`linkage.source${row.source === 'poll' ? 'Poll' : row.source === 'push' ? 'Push' : 'Websocket'}`) }}</span>
          </div>

          <div class="alarm-item__meta">
            <span v-if="row.alarmLevelRaw !== undefined">
              {{ t('linkage.pendingLevel') }}: {{ row.alarmLevelRaw }}
            </span>
            <span v-if="row.strategyId !== undefined">
              {{ t('linkage.pendingStrategy') }}: {{ row.strategyId }}
            </span>
            <span v-if="dischargeLabel(row)">{{ dischargeLabel(row) }}</span>
            <span v-if="metrics(row)">{{ metrics(row) }}</span>
          </div>

          <p v-if="actionsForRow(row).length === 0" class="alarm-item__actions muted">
            {{ t('linkage.pendingNoActions') }}
          </p>
          <ul v-else class="alarm-item__actions">
            <li v-for="action in actionsForRow(row)" :key="action.action" :class="actionClass(action)">
              {{ actionLine(action) }}
            </li>
          </ul>

          <div class="alarm-item__foot">
            <span class="alarm-item__event mono">{{ row.eventId }}</span>
            <button
              v-if="!row.acknowledged"
              type="button"
              class="btn btn--sm"
              :disabled="acknowledging"
              @click="acknowledgeOne(row.eventId)"
            >
              {{ t('linkage.pendingAcknowledge') }}
            </button>
          </div>
        </li>
      </ul>

      <!--
        合并之前这颗铃铛是**跳转**到告警列表去的。现在它改成了下拉，所以那个出口必须
        在这里补回来，否则「看全部告警记录」这件事就没有入口了 —— 面板只装得下待处理
        的几条，历史记录在告警记录页。
      -->
      <div class="alarm-panel__foot">
        <button type="button" class="btn btn--sm" @click="goToAlarms">
          {{ t('app.nav.alarms') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alarm-badge {
  position: relative;
}

/*
 * 这一颗是**顶栏的纯图标按钮**（业主 2026-09-21 第二批第 15 条）：只要铃铛 + 红点数角标。
 * 白底、边框、固定高度全部去掉（底色/边框会把它画成一颗药丸，而它在这里只是一枚图标）；
 * 悬停只变色、不给底框；有待处理告警时整颗变危险色。
 */
.alarm-badge__button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.alarm-badge__button:hover {
  color: var(--color-text);
}

.alarm-badge__button--active {
  color: var(--color-danger);
}

/* 图标容器只负责居中那个 SVG：以前它画的是一个白字「!」的实心圆。 */
.alarm-badge__icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.alarm-badge__count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--color-danger);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  text-align: center;
}

/*
 * 系统消息的标记：铃铛图标的右上角一个小点，**不是数字**（数字位置属于待处理告警条数，
 * 两个数混在一起就再也说不清那个数是什么）。挂在图标上而不是按钮上：按钮右侧可能还有
 * 角标，两个标记叠在一起谁都读不出来。
 */
.alarm-badge__problem {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow: 0 0 0 1.5px var(--color-bg);
}

/* 高级告警红点（左上，与右上角的系统消息点、数字角标错开位置）。 */
.alarm-badge__critical {
  position: absolute;
  top: -3px;
  left: -4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-danger);
  box-shadow: 0 0 0 1.5px var(--color-bg), 0 0 6px var(--color-danger);
}

/* 面板底部的出口（去告警记录页）：与面板同宽、靠右，与头部那条分隔线呼应。 */
.alarm-panel__foot {
  display: flex;
  justify-content: flex-end;
  padding: 8px 10px;
  border-top: 1px solid var(--color-border);
}

.alarm-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  width: 420px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  box-shadow: 0 8px 24px rgb(15 23 42 / 18%);
}

.alarm-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

/* --- 系统消息（应用级失败） ------------------------------------------------ */

/*
 * 这一块在面板里，而面板是浮层（`.alarm-panel` 是 `position: absolute`），所以它出现
 * 或消失**不会**推动页面：这正是业主 2026-09-18 要求的那件事。
 */
.alarm-panel__problems {
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}

.alarm-panel__problems-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.problem-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.problem {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
  font-size: 12px;
}

.problem--warning {
  border-left-color: var(--color-warning, #b45309);
  background: var(--color-warning-soft, #fff7e6);
}

/* 文案可能很长（错误码那一串），换行而不是把面板撑宽。 */
.problem__text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
  color: var(--color-text);
}

.problem__time {
  flex: none;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.problem__dismiss {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.problem__dismiss:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.alarm-panel__dropped,
.alarm-panel__off {
  margin: 6px 0 0;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-warning-soft, #fff7e6);
  color: var(--color-warning, #b45309);
  font-size: 11.5px;
}

.alarm-panel__empty {
  margin: 8px 0;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.alarm-panel__note {
  margin: 8px 0 0;
  font-size: 11px;
}

.alarm-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.alarm-item {
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-danger);
  border-radius: var(--radius-sm);
}

.alarm-item--ack {
  border-left-color: var(--color-border-strong);
  opacity: 0.72;
}

.alarm-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.alarm-item__device {
  font-weight: 600;
}

.alarm-item__time {
  color: var(--color-text-secondary);
}

.alarm-item__tag {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 10.5px;
}

.alarm-item__tag--ack {
  background: var(--color-success-soft, #ecfdf5);
  color: var(--color-success, #047857);
}

.alarm-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 11px;
}

.alarm-item__actions {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.action-line {
  word-break: break-word;
}

.action-line--success {
  color: var(--color-success, #047857);
}

.action-line--failed {
  color: var(--color-danger);
}

.action-line--skipped {
  color: var(--color-text-secondary);
}

.alarm-item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.alarm-item__event {
  font-size: 10.5px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
