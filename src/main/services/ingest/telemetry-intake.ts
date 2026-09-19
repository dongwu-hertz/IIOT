/**
 * 收到的一行遥测 → 已有的两条写入路径（业主 2026-09-19 第 1 条）。
 *
 * ---------------------------------------------------------------------------
 * 不新开第二套存储（§15.61.3 第 4 条）
 * ---------------------------------------------------------------------------
 * 推上来的数据落进**已经存在**的两条路：
 *   - 声学量 → `TrendStorageService.append()`（历史趋势页立刻看得到，与实时流写的是同一种
 *     Parquet 行、同一天一个文件）；
 *   - 带 `alarm_mask` 的行 → `AlarmRepository.insert()`（于是"设备推来的告警上角标"
 *     这条要求**自动**成立，不需要第二条告警通道）。
 *
 * 依赖是**注入的两个函数**而不是 `TrendStorageService` / `AlarmRepository` 本身：
 * 那样这一层可以在单测里用两个数组验证"到底写了什么"，而它自己不需要磁盘、不需要 sqlite。
 *
 * ---------------------------------------------------------------------------
 * 认不出来的键怎么办
 * ---------------------------------------------------------------------------
 * **不猜、不丢、如实计数**。键名不在对照表里（或者值不是数）的行：一个数都不写，
 * 但把那些键名报出来（服务层再交给设置页显示）。这是"设备在推、但格式不对"唯一能被
 * 现场看见的方式 —— 静默丢掉会让操作员以为接入坏了。
 */

import type { RealtimeFeature } from '@shared/domain/models'
import {
  hasFeatureValues,
  interpretTelemetry,
  type TelemetryRow
} from '@shared/domain/iot-ingest'
import type { AlarmInsert } from '../database/alarm-repository'

/** 一台设备的最小事实（够写趋势与告警行）。 */
export interface IngestTargetDevice {
  /** 本机主键（告警行的 `device_id`、趋势行的 `deviceId`）。 */
  id: string
  /** 稳定标识（趋势文件的目录键）。 */
  deviceUid: string
  name: string
}

export interface TelemetryIntakeDeps {
  /** 与实时流同一条路：`TrendStorageService.append(deviceUid, feature)`。 */
  appendFeature: (deviceUid: string, feature: RealtimeFeature) => void
  /** 与同步/联动同一条路：告警仓储的插入（自带去重）。 */
  insertAlarm: (input: AlarmInsert) => { id: string; created: boolean }
  /** 设备当前的通道数（用来判断通道号合不合法）；缺席表示不判断。 */
  channelCountFor?: (deviceId: string) => number | undefined
}

export interface IntakeOutcome {
  /** 写进趋势表的行数。 */
  trendRows: number
  /** 写进告警表的行数（新建的，不含幂等命中的）。 */
  alarmRows: number
  /** 幂等命中的告警条数（设备重发同一条）。 */
  duplicateAlarms: number
  /** 一个认得出的键都没有、因此什么都没写的行数。 */
  rowsWithoutKnownKeys: number
  /** 最近一批里认不出来的键名（去重、按出现顺序，最多 12 个）。 */
  unrecognised: string[]
}

const MAX_REPORTED_KEYS = 12

/**
 * 把一批遥测写进趋势 / 告警。
 *
 * 一行里同时有量值与 `alarm_mask` 时**两件都会做**（设备常常一条消息里既报值又报故障位）。
 * 这条不变量有单测钉着。
 */
export class TelemetryIntake {
  constructor(private readonly deps: TelemetryIntakeDeps) {}

  ingest(device: IngestTargetDevice, rows: readonly TelemetryRow[]): IntakeOutcome {
    const outcome: IntakeOutcome = {
      trendRows: 0,
      alarmRows: 0,
      duplicateAlarms: 0,
      rowsWithoutKnownKeys: 0,
      unrecognised: []
    }
    const unknownKeys = new Set<string>()
    const declaredChannelCount = this.deps.channelCountFor?.(device.id)

    for (const row of rows) {
      const interpretation = interpretTelemetry(row.values)
      for (const key of interpretation.unrecognised) unknownKeys.add(key)
      const channelId = interpretation.channelId ?? 0

      // 通道号超出这台设备**实际有的**通道数时不写：趋势表按通道分开画，
      // 一个不存在的通道会凭空多出一条没人认识的曲线。设备没有通道表时（相机 / 声呐）
      // 就不做这层判断 —— 那是"我们不知道"，不是"它不合法"。
      const channelIllegal =
        declaredChannelCount !== undefined &&
        declaredChannelCount > 0 &&
        channelId >= declaredChannelCount

      if (hasFeatureValues(interpretation.features) && !channelIllegal) {
        const feature: RealtimeFeature = {
          // 趋势行里的 `deviceId` 是**稳定 uid**（目录键），不是本地主键 ——
          // 与实时流那条路逐字一致，否则推上来的历史与流出来的历史会分成两个目录。
          deviceId: device.deviceUid,
          channelId,
          timestamp: row.ts,
          // 缺席的量**不补 0**：补 0 会在趋势图上画出"设备报了 0 分贝"这种不存在的读数。
          // `NaN` 是这套 Parquet 行表示"没有"的既有方式（`append()` 里对可选量就是这么写的）。
          spl: interpretation.features.spl ?? Number.NaN,
          mainFrequency: interpretation.features.mainFrequency ?? Number.NaN,
          smoothness: interpretation.features.smoothness ?? Number.NaN,
          bandEnergyRatio: interpretation.features.bandEnergyRatio ?? Number.NaN,
          oddEvenHarmonicRatio: interpretation.features.oddEvenHarmonicRatio ?? Number.NaN,
          spectralComplexity: interpretation.features.spectralComplexity ?? Number.NaN,
          fingerprintVariation: interpretation.features.fingerprintVariation ?? Number.NaN
        }
        this.deps.appendFeature(device.deviceUid, feature)
        outcome.trendRows += 1
      } else if (channelIllegal && hasFeatureValues(interpretation.features)) {
        // 通道越界：把那个通道号也报出来，否则现场只会看到"推了但没进趋势"。
        unknownKeys.add(`channel_id=${channelId}`)
      }

      if (interpretation.alarmMask !== undefined) {
        const alarm: AlarmInsert = {
          deviceId: device.id,
          channelId: channelIllegal ? 0 : channelId,
          timestamp: row.ts,
          alarmMask: interpretation.alarmMask,
          /**
           * 来源记 `'fa8'`：`alarm_mask` 是 **FA8 那 14 位故障位图的词汇**，我们有解码器与
           * 分级规则，写进去就是如实解释它。**不新造第三种来源**：`alarms.source` 的 CHECK
           * （schema v9）只允许 `'fa8'` / `'e2'`，加第三种要重建那张被索引与父表牵着的表，
           * 而这里并没有第二套告警词汇需要区分（听诊盒子的 `alarm_value` 不在这条路上，
           * 见 `TELEMETRY_ALARM_MASK_KEYS` 的说明）。
           */
          source: 'fa8',
          // 设备原始载荷里所有认出来的量值一起带上（这才是这条告警的现场证据）。
          ...(interpretation.features.spl !== undefined
            ? { spl: interpretation.features.spl }
            : {}),
          ...(interpretation.features.mainFrequency !== undefined
            ? { mainFrequency: interpretation.features.mainFrequency }
            : {}),
          ...(interpretation.features.smoothness !== undefined
            ? { smoothness: interpretation.features.smoothness }
            : {}),
          ...(interpretation.features.bandEnergyRatio !== undefined
            ? { bandEnergyRatio: interpretation.features.bandEnergyRatio }
            : {}),
          /**
           * 原始载荷**原样存一列**（`device_raw`）。这是"什么都不丢"的那一列：
           * 认不出来的键也在里面，所以现场问题事后追得了。
           */
          deviceRaw: JSON.stringify(row.values)
        }
        const inserted = this.deps.insertAlarm(alarm)
        if (inserted.created) outcome.alarmRows += 1
        else outcome.duplicateAlarms += 1
      }

      if (!hasFeatureValues(interpretation.features) && interpretation.alarmMask === undefined) {
        outcome.rowsWithoutKnownKeys += 1
      }
    }

    outcome.unrecognised = [...unknownKeys].slice(0, MAX_REPORTED_KEYS)
    return outcome
  }
}
