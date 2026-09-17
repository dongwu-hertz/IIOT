/**
 * 空气声呐（SN-16）与**球机联动**的参数（PTZ）—— 业主 2026-09-17 第 8 批第 1 条。
 *
 * ---------------------------------------------------------------------------
 * 这些键来自哪儿
 * ---------------------------------------------------------------------------
 * 全部来自 `Air Sonar User Manual 241128.pdf` 的 **`/system` 参数表**（不是我们发明的字段），
 * 手册给的键名原样在这里出现一次，然后被映射成 camelCase 的视图/补丁形状：
 *
 * | 手册键（`/system`） | 我们的字段 | 类型 |
 * |---|---|---|
 * | `cam_enable` | `enabled` | 开关（球机联动总开关） |
 * | `cam_ip` / `cam_port` / `cam_user` / `cam_pass` | `cameraIp` / `cameraPort` / `cameraUser` / `cameraPassword` | 球机地址与账号；**口令只写不读** |
 * | `is_ptz_direction_same_with_sonar` | `directionSameAsSonar` | 开关：球机朝向与声呐一致 |
 * | `is_save_snapshot` | `saveSnapshot` | 开关：告警时存抓图 |
 * | `cur_realtime_channel` | `realtimeChannel` | 1..通道数（声呐的实时监听通道） |
 * | `is_cam_init` | `cameraInitialised` | **只读**：球机是否已初始化（设备状态，不是设置项） |
 *
 * ---------------------------------------------------------------------------
 * 三条纪律
 * ---------------------------------------------------------------------------
 * 1. **写是"整份回写"**（read-modify-write）。手册的写示例就是把整个参数对象发回去，所以
 *    `applyPtzPatch()` 拿"设备刚回的整份 `/system`"做底、只改动我们要改的那几个键 ——
 *    不认识的键（`db_limit`、`notify_url`…）原样带着走，**一个都不丢**。
 * 2. **口令只写不读**：`cam_pass` 设备会明文回给我们（真机实测 `"AP1_lfxs_2025"`），但界面
 *    只显示「已设置」，永远不回显内容 —— 与设备口令、账户口令同一条纪律。
 *    没有改口令时，写回的是**设备刚给的那一份原值**，不是空值（写空会把球机口令清掉）。
 * 3. **读回核对**：`comparePtzPatch()` 把"我要求的值"与"写完之后设备再回的 `/system`"逐项比。
 *    设备把 `true` 回成 `1`、把端口回成字符串都是正常的，所以比较发生在**归一化之后**；
 *    归一化不了的取值算不一致（那是要报出来的事，不是"大概一样"）。
 */

/** 开关型取值：`true`/`1`/`'1'`/`'true'` 都算开。归一化不了返回 `undefined`（不猜）。 */
export function normaliseSwitch(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === '1' || text === 'true' || text === 'on') return true
    if (text === '0' || text === 'false' || text === 'off') return false
  }
  return undefined
}

/** 数字型取值：只认有限数（字符串要先能整个读成数）。 */
export function normaliseNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 文本型取值：非空字符串（空白算空）。 */
export function normaliseText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 手册里这一组键的名字（`/system` 的原样键名）。**只在这里出现一次**。 */
export const E2_PTZ_KEYS = {
  enabled: 'cam_enable',
  cameraIp: 'cam_ip',
  cameraPort: 'cam_port',
  cameraUser: 'cam_user',
  cameraPassword: 'cam_pass',
  directionSameAsSonar: 'is_ptz_direction_same_with_sonar',
  saveSnapshot: 'is_save_snapshot',
  realtimeChannel: 'cur_realtime_channel',
  cameraInitialised: 'is_cam_init'
} as const

/** 界面上能改的那几个字段（`cameraInitialised` 是只读状态，不在里面）。 */
export type E2PtzField =
  | 'enabled'
  | 'cameraIp'
  | 'cameraPort'
  | 'cameraUser'
  | 'cameraPassword'
  | 'directionSameAsSonar'
  | 'saveSnapshot'
  | 'realtimeChannel'

export const E2_PTZ_FIELDS: readonly E2PtzField[] = [
  'enabled',
  'cameraIp',
  'cameraPort',
  'cameraUser',
  'cameraPassword',
  'directionSameAsSonar',
  'saveSnapshot',
  'realtimeChannel'
]

/** 一次要写回去的改动（字段缺席 = 不动这一项）。 */
export type E2PtzPatch = Partial<{
  enabled: boolean
  cameraIp: string
  cameraPort: number
  cameraUser: string
  cameraPassword: string
  directionSameAsSonar: boolean
  saveSnapshot: boolean
  realtimeChannel: number
}>

/** 界面上看到的 PTZ 状态。 */
export interface E2PtzConfig {
  enabled?: boolean
  cameraIp?: string
  cameraPort?: number
  cameraUser?: string
  /** **只回"设没设"**，口令内容永远不出主进程。 */
  cameraPasswordSet: boolean
  directionSameAsSonar?: boolean
  saveSnapshot?: boolean
  realtimeChannel?: number
  /** 设备状态（只读）：球机是否已初始化。 */
  cameraInitialised?: boolean
  /**
   * 这台设备的通道数（来自 `dev_type`，`AS16` ⇒ 16）：给"实时通道"定上限用。
   * 读不出来就缺席 —— 界面那时不做上限判断，而不是拿 1 或 16 当默认值。
   */
  channelCount?: number
  /** `/system` 里**不属于这一组**的键名（写回时原样带着走，这里只报出来给排查用）。 */
  otherKeys: string[]
}

/** 一个字段的读回核对结果。 */
export interface E2PtzFieldCheck {
  field: E2PtzField
  ok: boolean
  /** 我们要求的值（归一化后的文字形式）。 */
  expected: string
  /** 设备写完之后再读回来的值（文字形式；缺席就是"设备没回这个键"）。 */
  actual: string
}

export interface E2PtzUpdateOutcome {
  /** 写完之后**重新读**到的整份 PTZ 状态（界面用它刷新，不拿我们自己的请求当结果显示）。 */
  readBack: E2PtzConfig
  /** 逐项核对；`allApplied` 是它们的与。 */
  fields: E2PtzFieldCheck[]
  allApplied: boolean
}

function text(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

/** 读侧：把设备 `/system` 的回话收窄成 PTZ 视图。 */
export function buildPtzConfig(
  raw: Record<string, unknown> | undefined,
  channelCount?: number
): E2PtzConfig {
  const source = raw ?? {}
  const config: E2PtzConfig = {
    // 口令：设备回的是明文，但我们**只看它在不在**，内容不进这个结构。
    cameraPasswordSet: normaliseText(source[E2_PTZ_KEYS.cameraPassword]) !== undefined,
    otherKeys: Object.keys(source).filter(
      (key) => !(Object.values(E2_PTZ_KEYS) as string[]).includes(key)
    )
  }

  const enabled = normaliseSwitch(source[E2_PTZ_KEYS.enabled])
  if (enabled !== undefined) config.enabled = enabled
  const cameraIp = normaliseText(source[E2_PTZ_KEYS.cameraIp])
  if (cameraIp !== undefined) config.cameraIp = cameraIp
  const cameraPort = normaliseNumber(source[E2_PTZ_KEYS.cameraPort])
  if (cameraPort !== undefined) config.cameraPort = cameraPort
  const cameraUser = normaliseText(source[E2_PTZ_KEYS.cameraUser])
  if (cameraUser !== undefined) config.cameraUser = cameraUser
  const direction = normaliseSwitch(source[E2_PTZ_KEYS.directionSameAsSonar])
  if (direction !== undefined) config.directionSameAsSonar = direction
  const saveSnapshot = normaliseSwitch(source[E2_PTZ_KEYS.saveSnapshot])
  if (saveSnapshot !== undefined) config.saveSnapshot = saveSnapshot
  const realtimeChannel = normaliseNumber(source[E2_PTZ_KEYS.realtimeChannel])
  if (realtimeChannel !== undefined) config.realtimeChannel = realtimeChannel
  const initialised = normaliseSwitch(source[E2_PTZ_KEYS.cameraInitialised])
  if (initialised !== undefined) config.cameraInitialised = initialised
  if (channelCount !== undefined) config.channelCount = channelCount
  return config
}

/**
 * 写侧：拿设备刚回的整份 `/system` 做底，改动要改的那几项，返回**要 PUT 回去的整份对象**。
 *
 * `cameraPassword` 只有**显式给了非空值**才覆盖；没给时保留底稿里的原值（设备刚回的那一份），
 * 这样一次"只改端口"的保存不会把球机口令清掉。
 */
export function applyPtzPatch(
  raw: Record<string, unknown>,
  patch: E2PtzPatch
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw }
  if (patch.enabled !== undefined) next[E2_PTZ_KEYS.enabled] = patch.enabled
  if (patch.cameraIp !== undefined) next[E2_PTZ_KEYS.cameraIp] = patch.cameraIp
  if (patch.cameraPort !== undefined) next[E2_PTZ_KEYS.cameraPort] = patch.cameraPort
  if (patch.cameraUser !== undefined) next[E2_PTZ_KEYS.cameraUser] = patch.cameraUser
  if (patch.cameraPassword !== undefined && patch.cameraPassword !== '') {
    next[E2_PTZ_KEYS.cameraPassword] = patch.cameraPassword
  }
  if (patch.directionSameAsSonar !== undefined) {
    next[E2_PTZ_KEYS.directionSameAsSonar] = patch.directionSameAsSonar
  }
  if (patch.saveSnapshot !== undefined) next[E2_PTZ_KEYS.saveSnapshot] = patch.saveSnapshot
  if (patch.realtimeChannel !== undefined) {
    next[E2_PTZ_KEYS.realtimeChannel] = patch.realtimeChannel
  }
  return next
}

/** 逐项核对：设备**写完之后再读回来**的值，与我们要的值是否一致。 */
export function comparePtzPatch(
  readBack: Record<string, unknown> | undefined,
  patch: E2PtzPatch
): E2PtzFieldCheck[] {
  const source = readBack ?? {}
  const checks: E2PtzFieldCheck[] = []

  const push = (field: E2PtzField, ok: boolean, expected: unknown, actual: unknown): void => {
    checks.push({ field, ok, expected: text(expected), actual: text(actual) })
  }

  if (patch.enabled !== undefined) {
    const actual = normaliseSwitch(source[E2_PTZ_KEYS.enabled])
    push('enabled', actual === patch.enabled, patch.enabled, actual)
  }
  if (patch.cameraIp !== undefined) {
    const actual = normaliseText(source[E2_PTZ_KEYS.cameraIp])
    push('cameraIp', actual === patch.cameraIp, patch.cameraIp, actual)
  }
  if (patch.cameraPort !== undefined) {
    const actual = normaliseNumber(source[E2_PTZ_KEYS.cameraPort])
    push('cameraPort', actual === patch.cameraPort, patch.cameraPort, actual)
  }
  if (patch.cameraUser !== undefined) {
    const actual = normaliseText(source[E2_PTZ_KEYS.cameraUser])
    push('cameraUser', actual === patch.cameraUser, patch.cameraUser, actual)
  }
  if (patch.cameraPassword !== undefined && patch.cameraPassword !== '') {
    /*
     * 口令**不能**用"读回来等于我写的"来核对：设备回的是它自己那份明文，而我们根本不把
     * 内容带回来。所以这里只核对**这一项现在是"已设置"**；读回明文是否等于我们写的那个，
     * 只能由设备行为（球机能否取到流）证明 —— 那不在这一层，界面会如实说"已写入，未比对内容"。
     */
    const set = normaliseText(source[E2_PTZ_KEYS.cameraPassword]) !== undefined
    push('cameraPassword', set, '已设置', set ? '已设置' : '')
  }
  if (patch.directionSameAsSonar !== undefined) {
    const actual = normaliseSwitch(source[E2_PTZ_KEYS.directionSameAsSonar])
    push('directionSameAsSonar', actual === patch.directionSameAsSonar, patch.directionSameAsSonar, actual)
  }
  if (patch.saveSnapshot !== undefined) {
    const actual = normaliseSwitch(source[E2_PTZ_KEYS.saveSnapshot])
    push('saveSnapshot', actual === patch.saveSnapshot, patch.saveSnapshot, actual)
  }
  if (patch.realtimeChannel !== undefined) {
    const actual = normaliseNumber(source[E2_PTZ_KEYS.realtimeChannel])
    push('realtimeChannel', actual === patch.realtimeChannel, patch.realtimeChannel, actual)
  }
  return checks
}

/** 界面上那一组字段的范围校验（与主进程共用同一套判据）。 */
export type E2PtzErrorKey =
  | 'ptzUi.errCameraIp'
  | 'ptzUi.errCameraPort'
  | 'ptzUi.errCameraUser'
  | 'ptzUi.errRealtimeChannel'

export function validatePtzPatch(
  patch: E2PtzPatch,
  channelCount?: number
): { ok: true } | { ok: false; reasonKey: E2PtzErrorKey } {
  if (patch.cameraIp !== undefined && !isHostLike(patch.cameraIp)) {
    return { ok: false, reasonKey: 'ptzUi.errCameraIp' }
  }
  if (patch.cameraPort !== undefined) {
    const port = patch.cameraPort
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reasonKey: 'ptzUi.errCameraPort' }
    }
  }
  if (patch.cameraUser !== undefined && patch.cameraUser.trim() === '') {
    return { ok: false, reasonKey: 'ptzUi.errCameraUser' }
  }
  if (patch.realtimeChannel !== undefined) {
    const channel = patch.realtimeChannel
    // 上限用**设备说的通道数**（`dev_type`）；读不出来时只做"正整数"这一层，不编上限。
    const max = channelCount ?? 64
    if (!Number.isInteger(channel) || channel < 1 || channel > max) {
      return { ok: false, reasonKey: 'ptzUi.errRealtimeChannel' }
    }
  }
  return { ok: true }
}

/**
 * 球机地址：IPv4 或主机名（与添加设备那边的判据同一条口径）。
 *
 * 为什么不接受空串：空串在 `applyPtzPatch()` 里会被写成一个空地址，而设备那时会把
 * "球机地址为空"当成配置完成 —— 界面上必须由用户明确填写或明确清空（清空走 `cameraIp: ''`
 * 也会被这里拒掉，与"关闭联动"是同一个动作：把 `enabled` 关掉）。
 */
export function isHostLike(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  const isIpv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(trimmed)
  if (isIpv4) {
    return trimmed.split('.').every((part) => Number(part) <= 255)
  }
  return /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(trimmed)
}

/** `/time_sync_with_nvt` 的结果：手册**没有**写这个端点的请求体，所以只报"设备接受了没有"。 */
export interface E2NvtTimeSyncOutcome {
  accepted: boolean
  /** 设备回了什么（截断后的文字），排查用。 */
  note: string
}

/** 与球机对时的请求体：**手册未说明**，所以我们发一个空对象并把这件事写进结果里。 */
export const E2_NVT_TIME_SYNC_BODY_UNSPECIFIED = true
