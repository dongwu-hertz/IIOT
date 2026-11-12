/**
 * 设备归属与自定义属性的归一化。
 *
 * 这些字段是**操作员手工录入**的元数据，不是设备协议事实：界面、IPC、数据库三处都要
 * 用同一套判据，否则同一条属性在编辑框里能存进去、在主进程里变成另一个样子。所以
 * 解析/裁剪/去重只写在这里，`DevicesView` 与 `DeviceRepository` 都调用它。
 *
 * 存储形态：部门是一列文本；属性是 JSON 数组（`[{key,value}]`）。属性列表保持输入顺序，
 * 同名 key 只保留第一次出现的那一条（后出现的视为重复，不静默覆盖）。
 */
import type { DeviceAttribute } from './models'

export const DEVICE_DEPARTMENT_MAX_LENGTH = 100
export const DEVICE_ATTRIBUTE_MAX_COUNT = 50
export const DEVICE_ATTRIBUTE_KEY_MAX_LENGTH = 64
export const DEVICE_ATTRIBUTE_VALUE_MAX_LENGTH = 256

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 部门：空串 = 没填，`undefined`；否则裁到上限。 */
export function normaliseDepartment(value: unknown): string | undefined {
  const text = asText(value)
  return text === '' ? undefined : text.slice(0, DEVICE_DEPARTMENT_MAX_LENGTH)
}

/**
 * 属性列表：只接受 `{ key, value }` 对象数组。
 *
 * - key 为空白的行丢弃（界面上刚点"添加属性"还没填的那一行不应写进库）；
 * - key 裁剪到 64、value 裁剪到 256；
 * - 同名 key 保留第一次出现的值；
 * - 最多 50 条，超出部分丢弃而不是让整次保存失败。
 */
export function normaliseDeviceAttributes(value: unknown): DeviceAttribute[] {
  if (!Array.isArray(value)) return []
  const result: DeviceAttribute[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = asText(record.key).slice(0, DEVICE_ATTRIBUTE_KEY_MAX_LENGTH)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      value: asText(record.value).slice(0, DEVICE_ATTRIBUTE_VALUE_MAX_LENGTH)
    })
    if (result.length >= DEVICE_ATTRIBUTE_MAX_COUNT) break
  }
  return result
}

/** 从数据库的 `attributes_json` 列读；坏 JSON 当空列表，绝不让设备列表读不出来。 */
export function parseDeviceAttributes(raw: unknown): DeviceAttribute[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    return normaliseDeviceAttributes(JSON.parse(raw))
  } catch {
    return []
  }
}

/** 写数据库前的序列化；空列表写成空串（与"没配过"同一形态）。 */
export function serialiseDeviceAttributes(value: unknown): string {
  const attributes = normaliseDeviceAttributes(value)
  return attributes.length === 0 ? '' : JSON.stringify(attributes)
}
