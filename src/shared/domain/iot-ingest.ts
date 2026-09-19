/**
 * 物联网设备接入（业主 2026-09-19：「HTTP 推流和 MQTT 是类似于 thingsboard 平台接 IOT
 * 设备的逻辑，你去调研，然后开发」）。
 *
 * ---------------------------------------------------------------------------
 * 这一层只放**纯粹的判定**，不碰网络、不碰磁盘、不碰数据库
 * ---------------------------------------------------------------------------
 * 它被三处引用，而且必须是同一份：
 *   1. 主进程的接入服务（`main/services/ingest/*`）—— 判断秘钥格式、解析载荷、归一化配置；
 *   2. 界面（设置页的接入卡片、设备对话框里的推流地址）—— 校验用户填的端口 / 绑定地址、
 *      拼出给设备用的 URL；
 *   3. 单元测试 —— 全部是纯函数，不需要起服务、不需要连库。
 *
 * ---------------------------------------------------------------------------
 * 为什么路径形状照抄 ThingsBoard
 * ---------------------------------------------------------------------------
 * 调研结论（出处见 `docs/Ivms4200-UX-REFERENCE.md` §15.61.3）：ThingsBoard 的设备侧接入是
 * **access token 放在 URL 路径里**（`/api/v1/$ACCESS_TOKEN/telemetry`）、MQTT 用 token 当
 * **用户名**。照抄这两个形状有一个很实际的好处：现场那台 FA8 声纹设备**自己的 Push 配置
 * 就是这个形状** —— `GET /get_date_push` 实测回来的四个地址都是
 * `http://8.153.195.75:3000/api/v1/dt_<32位十六进制>/telemetry`
 * （见 `docs/PROTOCOL-FINDINGS.md` §3.9）。所以「我们的设备能推上来」与「第三方的
 * ThingsBoard 设备也能推上来」是同一套形状，不需要两套接收端。
 *
 * ---------------------------------------------------------------------------
 * 秘钥的口径（**我们自己的设计**）
 * ---------------------------------------------------------------------------
 * 手册**没有**这一节（「添加设备支持 HTTP 推流（秘钥 + 推流地址）」是业主 2026-09-18 第 10 批
 * 第 5 条，手册里没有对应章节），所以下面这些规矩是我们定的，写清楚免得被当成手册事实：
 *   - 秘钥是 **32 位小写十六进制**（16 字节随机数）。选这个形状有两个理由：它与现场那个
 *     `dt_<32位十六进制>` 同形（设备端固件里占位符长度对得上），也不需要转义就能放进 URL。
 *   - 秘钥**按设备一条**，可以轮换（与 ThingsBoard「每台设备一条 access token，可在设备详情里
 *     查看 / 轮换」同一件事）。
 *   - 它不是登录口令：它只允许**往本机写遥测**这一件事，不给任何读接口、不给设备管理能力。
 */

/** 秘钥的字节数（16 字节 ⇒ 32 个十六进制字符）。 */
export const PUSH_SECRET_BYTES = 16

/**
 * 设备的**接入方式**（业主 2026-09-19 第 13 批第 1 条：「增加通过 HTTP， MQTT 方式接入」）。
 *
 * 三种取值，而且**每台设备只选一种**：
 *   - `none`（默认）：这台设备不走推流接入 —— 它由我们主动去连（既有的那几族协议）。
 *   - `http`：设备往本机的 `POST /api/v1/<秘钥>/telemetry` 推。
 *   - `mqtt`：设备连本机的 MQTT broker，往 `v1/devices/me/telemetry` 发。
 *
 * 为什么是"一种"而不是"两种都开"：接入方式是**设备侧固件决定**的（现场那台要么会发 HTTP、
 * 要么会发 MQTT）。让操作员两个都勾，界面就在暗示"两条路都通"，而设备只会走其中一条 ——
 * 另一条的监听会一直是"开了但没人连"。要换方式就再选一次，不是多加一条。
 *
 * 它也决定**监听什么时候开**：本机不为没人用的协议开着端口（离线优先），
 * 所以"有没有设备声明了 http/mqtt"就是那个总开关（见 `IotIngestService.syncFromDevices()`）。
 */
export const INGEST_PROTOCOLS = ['none', 'http', 'mqtt'] as const

export type IngestProtocol = (typeof INGEST_PROTOCOLS)[number]

export function isIngestProtocol(value: unknown): value is IngestProtocol {
  return typeof value === 'string' && (INGEST_PROTOCOLS as readonly string[]).includes(value)
}

/**
 * 把来路不明的值修成一个合法的接入方式。
 *
 * 坏值（`undefined`、旧库里的空串、被人手改过的 JSON）一律归 `none` —— 那是**最保守**的一档：
 * 归成 http/mqtt 会让一台根本没配过的设备在界面上显示"已接入"，而本机会为它开一个端口。
 */
export function normaliseIngestProtocol(value: unknown): IngestProtocol {
  return isIngestProtocol(value) ? value : 'none'
}

/** 这台设备是不是**走推流接入**（`none` 之外都算）。 */
export function usesIngest(protocol: IngestProtocol): boolean {
  return protocol !== 'none'
}

// ---------------------------------------------------------------------------
// 接入方案：数据流接口 + 视频流接口（业主 2026-09-19 第 13 批第 4 条）
// ---------------------------------------------------------------------------

/**
 * **能显示出来**的四个指标。
 *
 * 它们与 `RealtimeFeature` 的四个量、趋势页那四条曲线、实时监测页那四张卡一一对应 ——
 * 也就是说：数据流接口只能声明"哪个键送的是这四个量里的哪一个"，**不是**让操作员随便加一个
 * 我们画不出来的键。这是有意的：
 *
 *   - 本机的趋势表（Parquet）列是**固定 7 个量**（`RealtimeFeature`），声明一个表里没有的键，
 *     除了"收下了但画不出来"之外什么都得不到；
 *   - 一句"支持增加不同的遥测值"如果落成"随便填"，界面就在承诺一件做不到的事。
 *
 * 想加**第五个量**需要的是趋势表的列 + 一条曲线 + 一个单位，那是另一件事（见 §15.77 的说明）。
 */
export const INGEST_DISPLAY_METRICS = ['spl', 'mainFrequency', 'smoothness', 'bandEnergyRatio'] as const

export type IngestDisplayMetric = (typeof INGEST_DISPLAY_METRICS)[number]

/** 数据流接口的一行：**这个指标**由载荷里的**哪个键**送来。 */
export interface IngestMetricKey {
  metric: IngestDisplayMetric
  key: string
}

/**
 * 出厂默认：别名表（`TELEMETRY_FEATURE_KEYS`）里那几个**规范名**。
 *
 * 默认值与别名表**不是**两份规则：别名表说的是"收到这些写法都认"，这一份说的是"这台设备
 * 声明它将用哪一个规范名"。默认给出规范名，所以"不改就是能用的"。
 */
export function defaultIngestMetricKeys(): IngestMetricKey[] {
  return [
    { metric: 'spl', key: 'sound_pressure_level' },
    { metric: 'mainFrequency', key: 'main_freq' },
    { metric: 'smoothness', key: 'smoothness' },
    { metric: 'bandEnergyRatio', key: 'freq_band_energy_ratio' }
  ]
}

/** 视频流接口的默认键：设备推一个 RTSP / HTTP 地址过来。 */
export const DEFAULT_INGEST_VIDEO_KEY = 'video_url'

/**
 * 键名的形状：`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`。
 *
 * 与 ThingsBoard 的遥测键同一个形状（它也是"一段不含空白与引号的短名字"），而且与我们的
 * 别名表里的写法一致。**不允许空白与逗号**：界面上那几个键是以逗号拼给设备的示例，
 * 一个带空格的键会让示例变成一个能被读成两个键的东西。
 */
const INGEST_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/

export function isIngestKey(value: unknown): value is string {
  return typeof value === 'string' && INGEST_KEY_PATTERN.test(value)
}

/** 数据流接口最多这么多行（四个指标各一条已经够用，留出改名的余地）。 */
export const MAX_INGEST_METRIC_KEYS = 12

/**
 * 一台设备的**接入方案**（业主第 13 批第 3、4 条）。
 *
 * 它回答三件事，而且都在**添加/编辑设备**那一个对话框里：
 *   1. 用哪种协议接（`protocol`）；
 *   2. **数据流接口**：四个可显示的指标各由哪个键送来（`metricKeys`）；
 *   3. **视频流接口**：哪个键装的是视频地址（`videoKey`，空串 = 不要这一路）。
 *
 * 参考 ThingsBoard：那边"设备"与"它会上报哪些键"是两件事（`Device profile` + 遥测键），
 * 遥测本身是**无模式**的（任何键都能发，能不能显示由仪表盘决定）。我们没有仪表盘，
 * 所以把"这台设备会发哪几个键"显式记下来 —— 它就是那份"仪表盘配置"，也是现场与设备之间
 * 唯一一份可以核对的清单。
 */
export interface DeviceIngestPlan {
  protocol: IngestProtocol
  /** 数据流接口：指标 ← 键。 */
  metricKeys: IngestMetricKey[]
  /** 视频流接口：哪一个键装的是视频地址（空串 = 这台设备不推视频）。 */
  videoKey: string
}

export function defaultDeviceIngestPlan(): DeviceIngestPlan {
  return {
    protocol: 'none',
    metricKeys: defaultIngestMetricKeys(),
    videoKey: DEFAULT_INGEST_VIDEO_KEY
  }
}

/**
 * 把来路不明的值修成一个合法的接入方案（旧库、手改过的 JSON、IPC 传进来的坏对象）。
 *
 * 三条规则：
 *   1. 协议坏值 → `none`（最保守，见 `normaliseIngestProtocol()`）；
 *   2. 指标行逐条校验（指标名必须在四个里、键名必须合法），**同一个指标只留最后一条**
 *      （两条抢同一个指标时，"哪一条生效"必须只有一个答案）；
 *   3. 一整行都没有 → 回默认那四行（`none` 的设备也带着默认清单：操作员切到 http 时
 *      不必先把四个键敲一遍）。
 */
export function normaliseDeviceIngestPlan(value: unknown): DeviceIngestPlan {
  const raw = (value ?? {}) as Partial<DeviceIngestPlan>
  const protocol = normaliseIngestProtocol(raw.protocol)

  const byMetric = new Map<IngestDisplayMetric, string>()
  const input = Array.isArray(raw.metricKeys) ? raw.metricKeys : []
  for (const entry of input.slice(0, MAX_INGEST_METRIC_KEYS * 2)) {
    const row = (entry ?? {}) as Partial<IngestMetricKey>
    if (!(INGEST_DISPLAY_METRICS as readonly string[]).includes(String(row.metric))) continue
    if (!isIngestKey(row.key)) continue
    // 同一个指标后写的赢（界面上的编辑顺序就是覆盖顺序），同一个键只留第一次出现的指标。
    byMetric.set(row.metric as IngestDisplayMetric, row.key)
  }
  const metricKeys =
    byMetric.size > 0
      ? [...byMetric.entries()].map(([metric, key]) => ({ metric, key }))
      : defaultIngestMetricKeys()

  const videoKey = isIngestKey(raw.videoKey) ? raw.videoKey : raw.videoKey === '' ? '' : DEFAULT_INGEST_VIDEO_KEY

  return { protocol, metricKeys, videoKey }
}

/**
 * 界面上的即时校验：返回**问题**（空数组 = 没问题）。
 *
 * 与 `normaliseDeviceIngestPlan()` 是两件事：那个负责"把坏值修好"，这个负责"说出来哪里不对"。
 * 只留前者，操作员会看到自己填的键被悄悄改掉。
 */
export function deviceIngestPlanProblems(plan: DeviceIngestPlan): string[] {
  const problems: string[] = []
  if (!isIngestProtocol(plan.protocol)) problems.push('protocol')
  if (plan.metricKeys.length === 0) problems.push('metric-keys-empty')
  if (plan.metricKeys.length > MAX_INGEST_METRIC_KEYS) problems.push('metric-keys-too-many')
  const seenMetrics = new Set<string>()
  const seenKeys = new Set<string>()
  for (const row of plan.metricKeys) {
    if (!(INGEST_DISPLAY_METRICS as readonly string[]).includes(row.metric)) problems.push('metric-unknown')
    if (!isIngestKey(row.key)) problems.push('key-invalid')
    if (seenMetrics.has(row.metric)) problems.push('metric-duplicate')
    if (seenKeys.has(row.key)) problems.push('key-duplicate')
    seenMetrics.add(row.metric)
    seenKeys.add(row.key)
  }
  if (plan.videoKey !== '' && !isIngestKey(plan.videoKey)) problems.push('video-key-invalid')
  return problems
}

/** 秘钥的字符长度。 */
export const PUSH_SECRET_LENGTH = PUSH_SECRET_BYTES * 2

/**
 * 秘钥的形状：**恰好 32 位小写十六进制**。
 *
 * 只认小写：大写十六进制在 URL 里与路径匹配是大小写敏感的，允许两种大小写会让「同一台设备
 * 两条秘钥」在库里看起来不一样、在比较时又相等 —— 那是自找的麻烦。写入侧一律小写。
 */
const PUSH_SECRET_PATTERN = /^[0-9a-f]{32}$/

export function isPushSecret(value: unknown): value is string {
  return typeof value === 'string' && PUSH_SECRET_PATTERN.test(value)
}

/**
 * 把随机字节转成秘钥串。
 *
 * 随机性**从外面传进来**（而不是在这个模块里 import `node:crypto`）：这个文件同时被浏览器侧
 * 的界面编译，`node:crypto` 在渲染进程里不存在，而让界面依赖一个 Node 模块正是这个仓库
 * 一直避免的事。主进程那边传 `randomBytes(PUSH_SECRET_BYTES)`。
 */
export function pushSecretFromBytes(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** 秘钥在 URL 路径里的位置：`/api/v1/<秘钥>/telemetry`（ThingsBoard 的形状）。 */
export const TELEMETRY_PATH_PREFIX = '/api/v1'
export const TELEMETRY_PATH_SUFFIX = '/telemetry'
/** 属性通道：**只实现读取**（回一个空对象），见 `IotIngestService` 的说明。 */
export const ATTRIBUTES_PATH_SUFFIX = '/attributes'

export function telemetryPath(secret: string): string {
  return `${TELEMETRY_PATH_PREFIX}/${secret}${TELEMETRY_PATH_SUFFIX}`
}

export function attributesPath(secret: string): string {
  return `${TELEMETRY_PATH_PREFIX}/${secret}${ATTRIBUTES_PATH_SUFFIX}`
}

/** MQTT 的默认遥测主题（ThingsBoard 的形状：不以 `/` 开头，设备名恒为 `me`）。 */
export const MQTT_TELEMETRY_TOPIC = 'v1/devices/me/telemetry'

/**
 * 从一行请求行 / 主题里认出秘钥。
 *
 * 返回 `undefined` 表示**路径不对**（服务端回 404），`''` 表示路径形状对但秘钥是空的
 * （按秘钥无效处理）。这两种必须分开：混在一起的话，一个拼错路径的设备会看到 401，
 * 而排查方向会被引到凭据上去。
 */
export function secretFromTelemetryPath(pathname: string): string | undefined {
  const prefix = `${TELEMETRY_PATH_PREFIX}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  const suffix = rest.endsWith('/') ? rest.slice(0, -1) : rest
  const marker = suffix.lastIndexOf('/')
  if (marker < 0) return undefined
  const tail = suffix.slice(marker + 1)
  if (tail !== 'telemetry') return undefined
  const secret = suffix.slice(0, marker)
  // 秘钥里不可能有 `/`：多一段路径就是**路径不对**（404），不是秘钥不对（401）。
  return secret.includes('/') ? undefined : secret
}

/** 路径是不是属性通道（`GET /api/v1/<秘钥>/attributes`）。 */
export function secretFromAttributesPath(pathname: string): string | undefined {
  const prefix = `${TELEMETRY_PATH_PREFIX}/`
  if (!pathname.startsWith(prefix)) return undefined
  const rest = pathname.slice(prefix.length)
  const suffix = rest.endsWith('/') ? rest.slice(0, -1) : rest
  const marker = suffix.lastIndexOf('/')
  if (marker < 0) return undefined
  return suffix.slice(marker + 1) === 'attributes' ? suffix.slice(0, marker) : undefined
}

// ---------------------------------------------------------------------------
// 遥测载荷
// ---------------------------------------------------------------------------

/** 一个键的值：只接受**标量**。 */
export type TelemetryValue = number | string | boolean

export interface TelemetryRow {
  /** 毫秒时间戳。载荷没给就用服务端时间（ThingsBoard 的语义）。 */
  ts: number
  values: Record<string, TelemetryValue>
}

export type TelemetryParseResult =
  | { ok: true; rows: TelemetryRow[]; /** 值不是标量、被丢掉的键数（如实报出来）。 */ ignoredValues: number }
  | { ok: false; reason: TelemetryParseFailure }

export type TelemetryParseFailure =
  | 'not-an-object'
  | 'empty-payload'
  | 'too-many-rows'
  | 'bad-ts'

/**
 * 一次请求最多接受多少行。
 *
 * 有这个上限是因为**入站服务是暴露在网络上的**：没有上限时，一个 `[ … ]` 里有十万行的请求
 * 会把它们全部推进趋势缓冲区（并且占着内存直到下一次 flush）。200 行够现场任何一台设备
 * 一次批量上报，超出的部分**明确拒绝**（`too-many-rows`），不是悄悄丢掉一半。
 */
export const IOT_INGEST_LIMITS = {
  maxRowsPerRequest: 200,
  /** 请求体上限 1 MiB。 */
  maxBodyBytes: 1024 * 1024,
  /** MQTT 单条 PUBLISH 的载荷上限（同样的理由）。 */
  maxMqttPayloadBytes: 1024 * 1024,
  minPort: 1,
  maxPort: 65535,
  /** 绑定地址允许的取值：全网卡 / 仅本机 / 一个 IPv4 字面量（见 `isBindAddress`）。 */
  defaultHttpPort: 8080,
  defaultMqttPort: 1883
} as const

/** 时间戳的合理范围：2001-09-09 ~ 2100 年。超出的一律不认（见 `parseTimestamps`）。 */
const MIN_TIMESTAMP = 1_000_000_000_000
const MAX_TIMESTAMP = 4_102_444_800_000

function isScalar(value: unknown): value is TelemetryValue {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
}

function readValues(raw: unknown): { values: Record<string, TelemetryValue>; ignored: number } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const values: Record<string, TelemetryValue> = {}
  let ignored = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isScalar(value)) values[key] = value
    // 嵌套对象 / 数组 / null **丢掉并计数**：把它们序列化成字符串塞进去会让"这个键是什么"
    // 变得无法回答（读回来的是一个 JSON 字符串，不是那个数）。
    else ignored += 1
  }
  return { values, ignored }
}

function readTimestamp(raw: unknown, now: number): number | undefined {
  if (raw === undefined || raw === null) return now
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  // 秒 / 毫秒都见过（ThingsBoard 用毫秒）。小于下界的一律按**秒**放大一次：
  // 这不是猜——它只有一种解释方式，而且放大之后仍然落在合理区间里。
  const ms = value < MIN_TIMESTAMP ? value * 1000 : value
  if (ms < MIN_TIMESTAMP || ms > MAX_TIMESTAMP) return undefined
  return Math.round(ms)
}

/**
 * 解析一次 HTTP 推流的载荷。
 *
 * 接受的三种形状（第三种是前两种的"带时间戳"版本，都是 ThingsBoard 的设备侧 HTTP API
 * 文档里列的形状，见 §15.61.3 的调研表）：
 *
 *   1. `{"key": "value", …}`                        —— 一行，时间戳取服务端当前时间
 *   2. `[{"key": "value"}, …]`                      —— 多行，每一行取服务端当前时间
 *   3. `{"ts": 1451649600512, "values": {…}}`       —— 一行，带设备自己的时间
 *      以及 `[{…}, {…}]`（每一项都可以是上面第 1 或第 3 种）
 *
 * **数组元素是混合的**：现场设备常常第一条带 ts、后面几条不带，所以逐项判断而不是整包判断。
 */
export function parseTelemetryPayload(payload: unknown, now: number): TelemetryParseResult {
  const items: unknown[] = Array.isArray(payload) ? payload : [payload]
  if (items.length === 0) return { ok: false, reason: 'empty-payload' }
  if (items.length > IOT_INGEST_LIMITS.maxRowsPerRequest) {
    return { ok: false, reason: 'too-many-rows' }
  }

  const rows: TelemetryRow[] = []
  let ignoredValues = 0

  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'not-an-object' }
    }
    const record = item as Record<string, unknown>
    const hasEnvelope = record.values !== undefined && typeof record.values === 'object'
    const rawValues = hasEnvelope ? record.values : record
    const parsedValues = readValues(rawValues)
    if (!parsedValues) return { ok: false, reason: 'not-an-object' }
    ignoredValues += parsedValues.ignored
    if (Object.keys(parsedValues.values).length === 0) {
      // 整包里一行有效值都没有 —— 这是"载荷不对"，不是"收到了一条空数据"。
      if (rows.length === 0 && items.length === 1) return { ok: false, reason: 'empty-payload' }
      continue
    }
    const ts = readTimestamp(hasEnvelope ? record.ts : undefined, now)
    if (ts === undefined) return { ok: false, reason: 'bad-ts' }
    rows.push({ ts, values: parsedValues.values })
  }

  if (rows.length === 0) return { ok: false, reason: 'empty-payload' }
  return { ok: true, rows, ignoredValues }
}

// ---------------------------------------------------------------------------
// 收到的那一堆键里，哪些是我们认识的声学量
// ---------------------------------------------------------------------------

/**
 * 键名到 `RealtimeFeature` 字段的对照表。
 *
 * 左边那一列**不是我们编的**：FA8 固件的字段名来自规格（`models.ts` 的 `RealtimeFeature`
 * 注释里就写着 `sound_pressure_level -> spl` 这一组映射），右边那列是我们领域模型的字段名。
 * 之所以两种写法都收（`main_freq` 与 `mainFrequency`）：设备端固件用下划线，
 * 而任何用 ThingsBoard 示例代码拼出来的第三方设备会跟着我们的驼峰（或者它自己的驼峰）。
 * **没有第三种猜测**：不在这张表里的键一律不解释（只计数、不当成声学量）。
 */
export const TELEMETRY_FEATURE_KEYS: Record<string, keyof TelemetryFeatureValues> = {
  // 声压级
  sound_pressure_level: 'spl',
  spl: 'spl',
  // 主频
  main_freq: 'mainFrequency',
  main_frequency: 'mainFrequency',
  mainFrequency: 'mainFrequency',
  // 平稳度
  smoothness: 'smoothness',
  // 频带能量比
  freq_band_energy_ratio: 'bandEnergyRatio',
  band_energy_ratio: 'bandEnergyRatio',
  bandEnergyRatio: 'bandEnergyRatio',
  // 奇偶次谐波能量比
  hr_f: 'oddEvenHarmonicRatio',
  odd_even_harmonic_ratio: 'oddEvenHarmonicRatio',
  oddEvenHarmonicRatio: 'oddEvenHarmonicRatio',
  // 频谱复杂度
  sc_f: 'spectralComplexity',
  spectral_complexity: 'spectralComplexity',
  spectralComplexity: 'spectralComplexity',
  // 指纹变化度
  sv_f: 'fingerprintVariation',
  fingerprint_variation: 'fingerprintVariation',
  fingerprintVariation: 'fingerprintVariation'
}

/** 通道号：三种写法都收（设备端固件用 `channel_id`）。 */
export const TELEMETRY_CHANNEL_KEYS = ['channel_id', 'channelId', 'channel'] as const

/**
 * 告警位图：**只有这一个键**会把一条遥测变成告警行。
 *
 * 为什么只认 `alarm_mask`：它是 FA8 那 14 位故障位图的词汇（`AlarmType`），我们有解码器与
 * 分级规则，能如实写进 `alarms` 表。听诊盒子族的 `alarm_value`（手册只列了 6 个十六进制值）
 * **不在这里** —— 那是另一套词汇，靠猜着解释它会让 `decodeAlarmMask()` 解出设备从来没报过的
 * 故障类型（正是 `models.ts` 里把两套分开存的原因）。
 *
 * 「越过阈值的进告警表」这半句**没有做**，而且是刻意的：门限在**设备端**的告警档位里
 * （`CONFIG_*_ALARM_PROFILE`），本机没有第二份门限；自己造一份门限就会与本机"手册未说明
 * 的一律不编"的规矩冲突，也会与设备上的档位打架。推上来的数据是否已经是告警，只有推的
 * 那一方知道，所以它要自己给 `alarm_mask`。
 */
export const TELEMETRY_ALARM_MASK_KEYS = ['alarm_mask', 'alarmMask'] as const

/** FA8 位图的位数（`AlarmType` 有 14 位）。 */
export const ALARM_MASK_BITS = 14

/**
 * 通道号的上界（**含**）。
 *
 * 为什么是 15 而不是 `CHANNEL_COUNT - 1`（7）：接入这一侧**不知道对面是哪一族**。
 * FA8 是 8 路（0..7），SN-16 空气声呐是 16 路（0..15），所以按最宽的那一族判。
 * 更宽的一律**不认**（那一行进不了趋势表，并且原样计数）—— 宁可拒绝，也不要把数据写到
 * 一个本机根本不存在的通道上（那会让趋势图上凭空多出一条没人认识的曲线）。
 */
export const TELEMETRY_MAX_CHANNEL_INDEX = 15

export interface TelemetryFeatureValues {
  spl: number
  mainFrequency: number
  smoothness: number
  bandEnergyRatio: number
  oddEvenHarmonicRatio: number
  spectralComplexity: number
  fingerprintVariation: number
}

export interface TelemetryInterpretation {
  /** 认出来的声学量（缺席的**不写 0**，由调用方决定用什么表示"没有"）。 */
  features: Partial<TelemetryFeatureValues>
  channelId?: number
  alarmMask?: number
  /** 键名认不出来、或者值不是数的键（如实报给界面与日志）。 */
  unrecognised: string[]
}

function toNumber(value: TelemetryValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value ? 1 : 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 把一行的键值解释成我们认识的声学量与告警位图。
 *
 * 纯函数，没有副作用：**收下什么、解释成什么，全在这里**，服务层只负责把它写进已有的
 * 两条路（趋势 + 告警）。
 */
export function interpretTelemetry(values: Record<string, TelemetryValue>): TelemetryInterpretation {
  const features: Partial<TelemetryFeatureValues> = {}
  const unrecognised: string[] = []
  let channelId: number | undefined
  let alarmMask: number | undefined

  for (const [key, raw] of Object.entries(values)) {
    const featureKey = TELEMETRY_FEATURE_KEYS[key]
    if (featureKey) {
      const parsed = toNumber(raw)
      if (parsed === undefined) unrecognised.push(key)
      else features[featureKey] = parsed
      continue
    }
    if ((TELEMETRY_CHANNEL_KEYS as readonly string[]).includes(key)) {
      const parsed = toNumber(raw)
      // 通道号必须是 0..`TELEMETRY_MAX_CHANNEL_INDEX` 的整数；越界/非整数**不认**
      // （当没给，落到 0 号通道，而不是把它截断成一个看起来合法的通道 ——
      // 那会把数据写到别的通道上）。
      if (
        parsed !== undefined &&
        Number.isInteger(parsed) &&
        parsed >= 0 &&
        parsed <= TELEMETRY_MAX_CHANNEL_INDEX
      ) {
        channelId = parsed
      } else unrecognised.push(key)
      continue
    }
    if ((TELEMETRY_ALARM_MASK_KEYS as readonly string[]).includes(key)) {
      const parsed = toNumber(raw)
      if (
        parsed !== undefined &&
        Number.isInteger(parsed) &&
        parsed >= 0 &&
        parsed < 1 << ALARM_MASK_BITS
      ) {
        alarmMask = parsed
      } else unrecognised.push(key)
      continue
    }
    unrecognised.push(key)
  }

  const result: TelemetryInterpretation = { features, unrecognised }
  if (channelId !== undefined) result.channelId = channelId
  if (alarmMask !== undefined) result.alarmMask = alarmMask
  return result
}

/** 这一行里有没有任何一个我们认识的声学量（没有的话它进不了趋势表）。 */
export function hasFeatureValues(features: Partial<TelemetryFeatureValues>): boolean {
  return Object.keys(features).length > 0
}

// ---------------------------------------------------------------------------
// 接入服务的配置（**我们自己的设计**，手册未说明）
// ---------------------------------------------------------------------------

export interface IotIngestConfig {
  /**
   * 总开关。
   *
   * **默认关闭**：装了软件就在局域网里开一个监听端口是缺陷（离线优先的部署里更是如此）。
   * 打开之后才起 HTTP / MQTT 两个监听。
   */
  enabled: boolean
  /** HTTP 推流通道（ThingsBoard 形状的 `/api/v1/<秘钥>/telemetry`）。 */
  httpEnabled: boolean
  httpPort: number
  /** MQTT 通道（最小 broker，秘钥当用户名）。 */
  mqttEnabled: boolean
  mqttPort: number
  /**
   * 绑定地址。
   *
   * 允许三个取值：`0.0.0.0`（所有网卡，设备才能连上来 —— 现场默认要的就是这个）、
   * `127.0.0.1`（只本机，用于"我只想用本机脚本试一下"），以及一个具体的 IPv4 字面量
   * （一台机器多网卡、只想在其中一张上开的时候）。**不收主机名**：绑定的语义就是绑到一个
   * 本机地址上，写主机名要解析，而解析结果可能不是本机 —— 那会以"监听失败"的形式出现，
   * 排查方向完全不对。
   */
  bindAddress: string
}

export function defaultIotIngestConfig(): IotIngestConfig {
  return {
    enabled: false,
    httpEnabled: true,
    httpPort: IOT_INGEST_LIMITS.defaultHttpPort,
    mqttEnabled: true,
    mqttPort: IOT_INGEST_LIMITS.defaultMqttPort,
    bindAddress: '0.0.0.0'
  }
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isIpv4Literal(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = IPV4_PATTERN.exec(value)
  if (!match) return false
  return match.slice(1, 5).every((part) => Number(part) <= 255)
}

/** 绑定地址的三个合法形状（见 `IotIngestConfig.bindAddress`）。 */
export function isBindAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value === '0.0.0.0' || value === '127.0.0.1') return true
  return isIpv4Literal(value)
}

export function isPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= IOT_INGEST_LIMITS.minPort &&
    value <= IOT_INGEST_LIMITS.maxPort
  )
}

export interface NormalisedIotIngestConfig {
  config: IotIngestConfig
  /** 哪些字段非法、回落到了默认值（写日志用，也用于界面的提示）。 */
  issues: string[]
  /**
   * 两个通道同时开启却用了同一个端口 —— 这不是"非法值"，而是**冲突**：
   * 后起的那个会以 `EADDRINUSE` 失败。归一化器**不替用户改端口**（改哪一个都是猜测），
   * 只把冲突如实报出来，由服务分别报告各自的监听错误。
   */
  portConflict: boolean
}

/**
 * 把一份来路不明的配置归一化成合法的完整对象（与告警联动那一块同一套做法）。
 *
 * 逐字段回落：一个坏字段不该让整块配置作废（那会把用户配好的端口、绑定地址一起清掉）。
 */
export function normaliseIotIngestConfig(value: unknown): NormalisedIotIngestConfig {
  const defaults = defaultIotIngestConfig()
  const issues: string[] = []
  const record = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  const bool = (key: keyof IotIngestConfig, fallback: boolean): boolean => {
    const raw = record[key]
    if (raw === undefined) return fallback
    if (typeof raw === 'boolean') return raw
    issues.push(String(key))
    return fallback
  }
  const port = (key: 'httpPort' | 'mqttPort'): number => {
    const raw = record[key]
    if (raw === undefined) return defaults[key]
    if (isPort(raw)) return raw
    issues.push(key)
    return defaults[key]
  }
  const bindAddress = ((): string => {
    const raw = record.bindAddress
    if (raw === undefined) return defaults.bindAddress
    if (isBindAddress(raw)) return raw
    issues.push('bindAddress')
    return defaults.bindAddress
  })()

  const config: IotIngestConfig = {
    enabled: bool('enabled', defaults.enabled),
    httpEnabled: bool('httpEnabled', defaults.httpEnabled),
    httpPort: port('httpPort'),
    mqttEnabled: bool('mqttEnabled', defaults.mqttEnabled),
    mqttPort: port('mqttPort'),
    bindAddress
  }

  return {
    config,
    issues,
    portConflict: config.httpEnabled && config.mqttEnabled && config.httpPort === config.mqttPort
  }
}

/**
 * 给设备用的推流地址（界面与文档共用同一份拼装）。
 *
 * `host` 是**本机在局域网里的地址**（`0.0.0.0` 不能给设备用 —— 那不是一个可以连的目标），
 * 所以调用方用 `localAddresses()` 枚举出来的候选逐个拼。
 */
export function httpPushUrl(host: string, port: number, secret: string): string {
  return `http://${host}:${port}${telemetryPath(secret)}`
}

export function mqttPushTarget(host: string, port: number): string {
  return `mqtt://${host}:${port}`
}

/**
 * 一次接入的统计（设置页那张卡片就是照它显示的）。
 *
 * 这是**界面能拿到的唯一证据**：服务开没开、有没有人连上来、收到的东西认不认得出来。
 * 「开了但一条都没收到」与「收到了但一个键都不认识」是两种完全不同的现场问题，
 * 所以这两件事分开计数。
 */
export interface IotIngestStats {
  httpRequests: number
  mqttMessages: number
  /** 秘钥不对被拒的次数（HTTP 401 / MQTT CONNACK 拒绝）。 */
  rejectedAuth: number
  /** 载荷解析失败被拒的次数。 */
  rejectedPayload: number
  /** 写进趋势表的行数。 */
  trendRows: number
  /** 写进告警表的行数。 */
  alarmRows: number
  lastAt?: number
  lastDeviceId?: string
  /** 最近一行里**认不出来**的键（最多 12 个），界面据此说"收到了但格式不匹配"。 */
  lastUnrecognised?: string[]
  lastSource?: 'http' | 'mqtt'
}

/** 一个监听端口的运行状态（界面照它显示"监听中 / 起不来，原因是…"）。 */
export interface IotIngestListenerStatus {
  enabled: boolean
  listening: boolean
  address?: string
  port?: number
  /** 起不来的原因（`EADDRINUSE` 端口被占 / `EADDRNOTAVAIL` 地址不属于本机）。 */
  error?: string
}

/** 本机可用于"设备往这里推"的一个地址。 */
export interface IotIngestLocalAddress {
  address: string
  iface: string
}

/**
 * 设置页那张接入卡片能看到的全部事实。
 *
 * 里面**没有一个"估计值"**：监听状态来自真实的 `listen()` 回调，统计来自每一次真实的
 * 请求/报文。界面据此能回答现场唯一想知道的三个问题 ——「开着吗」「有人连吗」「收的东西
 * 认出来了吗」。
 */
export interface IotIngestRuntimeStatus {
  config: IotIngestConfig
  http: IotIngestListenerStatus
  mqtt: IotIngestListenerStatus
  stats: IotIngestStats
  localAddresses: IotIngestLocalAddress[]
  /** 已经有秘钥的设备台数（"能不能接"这件事的前一半）。 */
  devicesWithSecret: number
}

/**
 * 「添加设备支持 HTTP 推流（秘钥 + 推流地址）」——设备对话框要显示的**全部**内容。
 *
 * 之所以把地址表也一起回：`0.0.0.0` 不能给设备用（那不是一个可以连的目标），所以界面必须
 * 逐网卡给出候选地址，由现场那个人挑设备真正能连上的那一条。让渲染层自己拼地址是错的 ——
 * 「端口是多少、路径是什么形状」这两件事只能有一处定义（这个模块的 `httpPushUrl()`）。
 */
export interface DeviceIngestEndpoint {
  deviceId: string
  deviceName: string
  secret: string
  /** 总开关关着时地址仍然显示（它是配置），但界面要明说"监听没开"。 */
  serviceEnabled: boolean
  httpEnabled: boolean
  httpPort: number
  mqttEnabled: boolean
  mqttPort: number
  /** MQTT 的发布主题（固定 `v1/devices/me/telemetry`）。 */
  mqttTopic: string
  localAddresses: IotIngestLocalAddress[]
}
