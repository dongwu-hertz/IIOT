/**
 * 「每一路通道现在有没有告警」——判定与唯一的住处。
 *
 * 业主 2026-09-19 第 13 批第 3 条（实时监测第 3 条）要求右下角那张「每一通道的声纹特性」
 * 表在四列读数之外再加一列**是否告警**，并且「点击告警则显示详细的告警状态」。
 *
 * 数据从哪来（不新造数据源）
 *   `alarms.query({ deviceId })` —— 与「告警中心」页**同一次查询**、同一张表
 *   （`AlarmEvent` 带 `channelId`）。这一页只按通道把它分组，不自己判等级、不自己
 *   造原因文本：等级用入库时按位图算好并快照的 `severity`（`models.ts` 的注释），
 *   原因用设备自己的原话 `deviceReason`。
 *
 * 「最近 N 条」这件事必须说清楚
 *   我们取的是**最近 `limit` 条**告警（由调用方给，见 `MonitorView` 的
 *   `DEVICE_ALARM_SAMPLE`）。所以这一列回答的是"在这批最近记录里，这一路有没有告警"，
 *   而不是"历史上这一路有没有过告警"。界面上那行说明（`channelAlarmSampleHint`）
 *   就是这句话，不写就是把一个采样窗口说成了全部历史。
 *
 * 纯函数、零依赖（与 `camera-autoplay.ts` 同一条规矩）：不 import vue-i18n，
 * 也不 import 任何运行时模块，所以可以直接单测。
 */

import type { AlarmEvent } from './models'

/** 一路通道在这一批告警记录里的小结。 */
export interface ChannelAlarmSummary {
  channelId: number
  /** 这一批记录里该通道的告警条数（**采样窗口内**，不是历史总数）。 */
  count: number
  /** 其中还没确认的条数：界面上的红点只由它决定。 */
  unacknowledgedCount: number
  /** 最近一条（时间最大；时间相同时取输入里靠前的那条，保证同一输入得到同一结论）。 */
  latest: AlarmEvent
  /** 最近一条的等级（入库时按位图算好并快照，这里只转发，不重算）。 */
  severity: AlarmEvent['severity']
  /** 最近一条是否已确认。 */
  acknowledged: boolean
}

/**
 * 按通道分组，每组只留最近一条 + 条数。
 *
 * 不做排序假设：`alarms.query` 今天按时间倒序返回，但本函数按 `timestamp` 自己取最大，
 * 所以调用方换一种排序（或将来加上按等级排序）都不会让"最近一条"变成别的东西。
 */
export function groupAlarmsByChannel(
  alarms: readonly AlarmEvent[]
): Map<number, ChannelAlarmSummary> {
  const grouped = new Map<number, ChannelAlarmSummary>()
  for (const alarm of alarms) {
    const existing = grouped.get(alarm.channelId)
    if (!existing) {
      grouped.set(alarm.channelId, {
        channelId: alarm.channelId,
        count: 1,
        unacknowledgedCount: alarm.acknowledged ? 0 : 1,
        latest: alarm,
        severity: alarm.severity,
        acknowledged: alarm.acknowledged
      })
      continue
    }
    existing.count += 1
    if (!alarm.acknowledged) existing.unacknowledgedCount += 1
    if (alarm.timestamp > existing.latest.timestamp) {
      existing.latest = alarm
      existing.severity = alarm.severity
      existing.acknowledged = alarm.acknowledged
    }
  }
  return grouped
}

/**
 * 某一批告警里，这一路通道的小结；没有就返回 `null`（**不是**一个 count 为 0 的对象：
 * "没有记录"与"有记录但都是零"在界面上要分开写）。
 */
export function channelAlarmOf(
  grouped: Map<number, ChannelAlarmSummary>,
  channelId: number
): ChannelAlarmSummary | null {
  return grouped.get(channelId) ?? null
}

/**
 * 这一路在界面上算不算「告警」。
 *
 * 规则：**还有没确认的**才算告警。
 * 为什么不是"有过告警就算"：告警中心的存在意义就是"确认过的不再打断你"，如果这一列
 * 把已确认的也算成告警，那么操作员刚在告警中心确认完，回到这一页仍然是满屏红色 ——
 * 两页对同一件事给出两种答案。所以红点只由 `unacknowledgedCount` 决定，而**已确认的
 * 仍然能在详情里看到**（`latest` / `count` 照常给），不会因为不红就消失。
 */
export function channelIsAlarming(summary: ChannelAlarmSummary | null): boolean {
  return summary !== null && summary.unacknowledgedCount > 0
}

/** 详情里的等级徽标类名。与 `main.css` 里真实存在的样式一一对应。 */
export function alarmSeverityBadgeClass(severity: AlarmEvent['severity']): string {
  if (severity === 'critical') return 'badge badge--danger'
  if (severity === 'warning') return 'badge badge--warning'
  if (severity === 'info') return 'badge badge--accent'
  return 'badge'
}
