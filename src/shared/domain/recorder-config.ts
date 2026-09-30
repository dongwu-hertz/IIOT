/**
 * 连续录像的**设置**（业主 2026-09-26 追加范围）。
 *
 * 两个字段，各自回答一个产品问题：
 *   - `enabledDeviceIds`：**哪些相机录**。空数组是默认值，含义是"谁都不录" ——
 *     装完就开始 7×24 录像的产品是缺陷：一路 2 Mbps 一天就 21 GB，用户没点过任何东西
 *     就把他的盘填满，比不录更糟。所以必须是 opt-in。
 *   - `segmentSeconds`：**一片多长**。默认 5 分钟：太短会产出海量小文件（每片一次入库、
 *     一次扫描），太长则断电时丢掉的那一段更长（最后一片没写完就没了）。
 *
 * 与 `recorder.ts`（运行期纯规则）分开：那边是"怎么录"，这边是"录不录、录多久"，
 * 而只有后者会被写进设置并跨重启保留。
 */

import { RECORDER_SEGMENT_SECONDS_DEFAULT, normalizeSegmentSeconds } from './recorder'

export interface RecorderConfig {
  /** 要求连续录像的设备 id（opt-in）。默认空。 */
  enabledDeviceIds: string[]
  /** 切片长度（秒）。 */
  segmentSeconds: number
}

export function defaultRecorderConfig(): RecorderConfig {
  return { enabledDeviceIds: [], segmentSeconds: RECORDER_SEGMENT_SECONDS_DEFAULT }
}

/** 一个设备是否被要求连续录像。 */
export function recorderEnabledFor(config: RecorderConfig, deviceId: string): boolean {
  return config.enabledDeviceIds.includes(deviceId)
}

/**
 * 归一到合法配置（设置写入路径上唯一的入口）。
 *
 * 非法值**回落到默认而不是抛错**：设置来自 IPC 与旧版本的数据库，一个畸形的切片长度
 * 不该让整个设置页保存失败 —— 但它必须被记下来（`issues`）以便排查。
 */
export function normaliseRecorderConfig(value: unknown): {
  config: RecorderConfig
  issues: string[]
} {
  const issues: string[] = []
  const source = (typeof value === 'object' && value !== null ? value : {}) as {
    enabledDeviceIds?: unknown
    segmentSeconds?: unknown
  }

  const ids: string[] = []
  if (Array.isArray(source.enabledDeviceIds)) {
    for (const entry of source.enabledDeviceIds) {
      if (typeof entry === 'string' && entry.trim() !== '') ids.push(entry.trim())
      else issues.push('enabledDeviceIds')
    }
  } else if (source.enabledDeviceIds !== undefined) {
    issues.push('enabledDeviceIds')
  }

  const raw = source.segmentSeconds
  const segmentSeconds = normalizeSegmentSeconds(raw)
  if (raw !== undefined && segmentSeconds !== raw) issues.push('segmentSeconds')

  return {
    // 去重且保持顺序：同一个设备被勾两次不该产生两条录制任务（幂等由录像器保证，
    // 这里是第二道）。
    config: { enabledDeviceIds: [...new Set(ids)], segmentSeconds },
    issues
  }
}
