/**
 * 安装信息（点位 / 朝向 / 基准分贝）的**唯一判据**。
 *
 * 为什么要有这个模块：同一套范围要在这里被三处用到 —— 添加设备对话框、设备配置页、
 * 主进程写库之前。三处各写一遍范围，迟早会出现"界面允许 400°、主进程拒绝"这种
 * 只在某一台设备上才暴露的不一致；而这两处又都不能不校验（界面是给人看的即时反馈，
 * 主进程是数据完整性的最后一道闸）。
 *
 * 三处**我们自己定的**口径（手册里没有这套字段，见 `DeviceInstallation` 的注释）：
 *   1. 经纬度用 **WGS84 十进制度**；
 *   2. 方位角 0 = 正北、顺时针为正、范围 `[0, 360)`（因此 360 被判为越界，写 0 才对）；
 *   3. `soundLevelDb` 是点位**基准声压级**，不是告警门限。
 *
 * 空值（`''` / `null` / `undefined`）一律表示**没有填**，不是 0：声纹设备与相机不填这三项，
 * 把"没填"存成 0 会让界面上显示一个看起来像实测值的数字。
 */
import {
  DEVICE_INSTALLATION_LIMITS,
  type DeviceInstallation
} from '@shared/domain/models'

/** 单个字段的取值结果：合法数值、没有填、或者不合法（带一句原因 key）。 */
export type InstallationFieldResult =
  | { ok: true; value: number | undefined }
  | { ok: false; reasonKey: InstallationErrorKey }

export type InstallationErrorKey =
  | 'installUi.errLatitude'
  | 'installUi.errLongitude'
  | 'installUi.errAzimuth'
  | 'installUi.errSoundLevel'
  | 'installUi.errFloorX'
  | 'installUi.errFloorY'

/**
 * 把输入（可能是 `''`、`'31.2'`、`null`、数字）变成一个数或"没有填"。
 *
 * 接受字符串是因为输入框给的就是字符串；`''` / `null` / `undefined` / 只有空白都算没填。
 */
export function parseInstallationNumber(input: unknown): number | undefined | null {
  if (input === null || input === undefined) return undefined
  if (typeof input === 'number') return Number.isFinite(input) ? input : null
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** 纬度：[-90, 90]（WGS84 十进制度）。 */
export function parseLatitude(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errLatitude' }
  const { latitudeMin, latitudeMax } = DEVICE_INSTALLATION_LIMITS
  if (value < latitudeMin || value > latitudeMax) return { ok: false, reasonKey: 'installUi.errLatitude' }
  return { ok: true, value }
}

/** 经度：[-180, 180]。 */
export function parseLongitude(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errLongitude' }
  const { longitudeMin, longitudeMax } = DEVICE_INSTALLATION_LIMITS
  if (value < longitudeMin || value > longitudeMax) {
    return { ok: false, reasonKey: 'installUi.errLongitude' }
  }
  return { ok: true, value }
}

/**
 * 方位角：`[0, 360)`，0 = 正北、顺时针。
 *
 * **360 被判为越界**（写 0 才对）：`horizontal` 这类设备字段报的就是 0..359，
 * 允许 360 会让我们自己的两个方位角取值域不一样。
 */
export function parseAzimuth(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errAzimuth' }
  const { azimuthMin, azimuthMax } = DEVICE_INSTALLATION_LIMITS
  if (value < azimuthMin || value >= azimuthMax) return { ok: false, reasonKey: 'installUi.errAzimuth' }
  return { ok: true, value }
}

/** 平面图横坐标：归一化 `[0, 1]`（0 = 左边缘，1 = 右边缘）。 */
export function parseFloorX(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errFloorX' }
  const { floorMin, floorMax } = DEVICE_INSTALLATION_LIMITS
  if (value < floorMin || value > floorMax) return { ok: false, reasonKey: 'installUi.errFloorX' }
  return { ok: true, value }
}

/** 平面图纵坐标：归一化 `[0, 1]`（0 = 上边缘，1 = 下边缘）。 */
export function parseFloorY(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errFloorY' }
  const { floorMin, floorMax } = DEVICE_INSTALLATION_LIMITS
  if (value < floorMin || value > floorMax) return { ok: false, reasonKey: 'installUi.errFloorY' }
  return { ok: true, value }
}
/** 基准声压级：[-50, 200] dB（范围是给"输错了"留的护栏，不是物理断言）。 */
export function parseSoundLevel(input: unknown): InstallationFieldResult {
  const value = parseInstallationNumber(input)
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: false, reasonKey: 'installUi.errSoundLevel' }
  const { soundLevelMin, soundLevelMax } = DEVICE_INSTALLATION_LIMITS
  if (value < soundLevelMin || value > soundLevelMax) {
    return { ok: false, reasonKey: 'installUi.errSoundLevel' }
  }
  return { ok: true, value }
}

export interface InstallationParseResult {
  ok: boolean
  /** 解析出来的安装信息；没填的字段**不出现**（不是 0）。 */
  installation: DeviceInstallation
  /** 第一个不合法的字段原因 key（`ok=false` 时才有）。 */
  reasonKey?: InstallationErrorKey
}

/** 四个字段一起解析（界面一次读完四个输入框）。 */
export function parseInstallation(input: {
  gisLatitude?: unknown
  gisLongitude?: unknown
  azimuthDeg?: unknown
  soundLevelDb?: unknown
  floorX?: unknown
  floorY?: unknown
}): InstallationParseResult {
  const installation: DeviceInstallation = {}
  const fields: Array<[keyof DeviceInstallation, InstallationFieldResult]> = [
    ['gisLatitude', parseLatitude(input.gisLatitude)],
    ['gisLongitude', parseLongitude(input.gisLongitude)],
    ['azimuthDeg', parseAzimuth(input.azimuthDeg)],
    ['soundLevelDb', parseSoundLevel(input.soundLevelDb)],
    ['floorX', parseFloorX(input.floorX)],
    ['floorY', parseFloorY(input.floorY)]
  ]
  for (const [key, result] of fields) {
    if (!result.ok) return { ok: false, installation, reasonKey: result.reasonKey }
    if (result.value !== undefined) installation[key] = result.value
  }
  return { ok: true, installation }
}

/**
 * 安装信息里有没有**真的填了东西**。
 *
 * 用来决定"要不要把这一组写进库"：四项全空的设备根本不该有 `installation`，
 * 而不是存一个四个字段都缺席的空对象（那会让"有没有录过点位"变成一个看不出来的问题）。
 */
export function hasInstallation(installation: DeviceInstallation | undefined): boolean {
  if (!installation) return false
  return (
    installation.gisLatitude !== undefined ||
    installation.gisLongitude !== undefined ||
    installation.azimuthDeg !== undefined ||
    installation.soundLevelDb !== undefined ||
    installation.floorX !== undefined ||
    installation.floorY !== undefined
  )
}

/** 经纬度是否**成对**给出（只给一半的点位没有意义，界面要能说出来）。 */
export function isPointComplete(installation: DeviceInstallation | undefined): boolean {
  if (!installation) return false
  const hasLat = installation.gisLatitude !== undefined
  const hasLon = installation.gisLongitude !== undefined
  return hasLat === hasLon
}
