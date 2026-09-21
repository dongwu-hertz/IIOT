/**
 * 通道数归因 —— 「界面该显示的通道数」的唯一判定处（纯函数，无 Vue、无副作用）。
 *
 * 这一组函数原本住在 `lib/channelWall.ts`（通道墙是唯一的使用方）；通道墙功能删除后
 * 迁到这里，因为 `AddDeviceDialog.vue`（探测结果里的通道数）与 `DeviceDetailView.vue`
 * （设备详情概览里的通道数）仍然依赖 `resolveChannelCount()` 的判定。判定规则与
 * 原实现逐字一致，由既有单元测试钉死。
 *
 * 依赖纪律（沿用原模块的约定）
 * 本模块运行时不导入任何东西，只从 `@shared/domain/models` 取常量与类型。
 */

import { CHANNEL_COUNT } from '@shared/domain/models'
import type { DeviceKind } from '@shared/domain/models'

/**
 * 一个「通道数」到底是怎么来的。
 *
 * 四态而不是一个数字，因为**数字相等不等于来源相同**：
 *   channelTable  已读回的通道表行数（`GET /get_passageway`）—— 权威来源；
 *   deviceReport  `GET /get_devinfo` 给的数字，而且它**不可能**是协议常量；
 *   noChannels    这台设备的家族根本没有通道（声学相机）—— `0` 是关于产品的**事实**，
 *                 不是「没读到」；
 *   unreported    没有可信的数字（什么都没读到，或者读到的正好是那个协议常量）。
 *
 * 为什么「正好等于协议常量」不算设备上报
 * 真机实测 `/get_devinfo` 的响应里**根本没有** `channel_num` 这类字段
 * （`docs/PROTOCOL-FINDINGS.md` §3.1：「也没有 `channel_num` 字段 —— 通道数需从
 * `/get_passageway` 的数组长度推导」），而 `mapDeviceInfo()` 在设备没给这个字段时会把
 * `CHANNEL_COUNT`(8) 填进 `DeviceInfo.channelCount`
 * （`src/main/services/device/protocol/mappers.ts`，那个函数自己的注释也这么写）。
 * 于是「设备上报了 8」与「设备什么都没上报」在渲染层看来是同一个 8，无法区分 ——
 * 把无法归因于设备的数字说成「设备上报的 8」，就是编造一个我们没有收到的数字。
 * 反过来，一个**不等于**协议常量的值不可能是那个兜底写出来的，它可以归因于设备。
 */
export type ChannelCountSource = 'channelTable' | 'deviceReport' | 'noChannels' | 'unreported'

export interface ChannelCountInput {
  /** 已读回的通道表行数；`null` / `0` / 负数表示这张表还没到手。 */
  channelTableCount?: number | null
  /** `GET /get_devinfo` 的 `channelCount`；`null` 表示这一次根本没读到设备信息。 */
  deviceReportedCount?: number | null
  /**
   * 设备家族。
   *
   * 声学相机**没有**通道这个概念（`DeviceKind` 的说明、`syntheticCameraInfo()` 里那个
   * `channelCount: 0`），所以它的 `0` 必须与声纹设备那条「8 只是协议兜底」的路分开：
   * 前者是产品事实，后者是缺失。
   */
  deviceKind?: DeviceKind
}

export interface ChannelCountResolution {
  /** 可以显示的通道数；`null` = 此刻没有可信的数字（界面据 `source` 说明原因）。 */
  count: number | null
  source: ChannelCountSource
}

/** 只接受真正的正整数；`0`、小数、`NaN` 一律当作「没有这个数」。 */
function positiveCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * 界面该显示的通道数（纯函数，判定只有这一处）。
 *
 * 优先级就是权威性：通道表 > 相机（没有通道，0 是事实）> 设备回报 > 没有。
 * 第一档是**通道表**，因为只有 `/get_passageway` 真的列出了通道；第三档是设备回报，
 * 但只在它不可能来自协议兜底时才算（见 `ChannelCountSource`）。
 */
export function resolveChannelCount(input: ChannelCountInput): ChannelCountResolution {
  const fromTable = positiveCount(input.channelTableCount)
  if (fromTable !== null) return { count: fromTable, source: 'channelTable' }

  // 相机没有通道：这个 0 不是「没读到」，也不是协议常量兜底出来的。
  if (input.deviceKind === 'acousticCamera') return { count: 0, source: 'noChannels' }

  const reported = positiveCount(input.deviceReportedCount)
  if (reported !== null && reported !== CHANNEL_COUNT) {
    return { count: reported, source: 'deviceReport' }
  }
  return { count: null, source: 'unreported' }
}
