/**
 * 声学相机（FA371）**控制与维护**的领域模型。
 *
 * 契约链（规格 §7 / 附录 C 规则 2）：
 *   协议 DTO  ->  Mapper  ->  [本文件]  ->  Store  ->  UI
 *
 * 硬规则：本文件不出现任何固件/手册的线上键名，也不放人类可读文案 ——
 * 不可用原因只给稳定的 KEY（`CameraMaintenanceReasonKey`），渲染层用
 * `cameraControlUi.*` 去翻译。这条规则由 `tests/i18n.test.ts` 守护。
 *
 * 与 `camera-alarm.ts` 的分工：那个管**告警模型的内容**（策略/条件的新建、
 * 修改、删除），本文件管**检测能不能跑起来**（检测模式、检测启停、当前启用的
 * 策略、维护能力）。
 */

import type {
  Fa371AlarmStrategy,
  Fa371DetectStatus,
  Fa371LeakageConfig,
  Fa371RunModeConfig,
  Fa371ScanArea,
  Fa371RunModeValue,
  Fa371WorkModeConfig,
  Fa371WorkModeValue
} from './fa371'

// ---------------------------------------------------------------------------
// 运行方式（`run_mode`：Single Detection / Smart Patrol）
// ---------------------------------------------------------------------------

/**
 * 一次「改运行方式」的完整结果。
 *
 * **为什么写完之后还要再读一遍**：本设备上 `PUT /alarm_strategy {Switch:1}`
 * 已被实测为应答 `ret:200` 却完全不生效（见 `docs/FA371-API-DELTA.md` §1）。
 * 所以「设备应答了」不等于「设备改了」。`after` 是写完之后重新读到的设备事实，
 * 界面显示的就是它；`applied` 由 `after.mode === requested` 得出 ——
 * 为 `false` 时界面必须说「设备没有接受这次修改」，而不是把控件翻到请求值。
 */
export interface CameraRunModeWriteResult {
  /** 请求写入的运行方式。 */
  requested: Fa371RunModeValue
  /** 写之前设备的读数。 */
  before: Fa371RunModeConfig
  /** 写之后重新读取的读数 —— **权威值**。 */
  after: Fa371RunModeConfig
  /**
   * 设备是否真的切到了 `requested`。
   * 读回来的值既不是 1 也不是 -1 时同样是 `false`（不猜，见 `mapRunMode`）。
   */
  applied: boolean
}

/**
 * 泄漏估算参数的写结果（§5.1.11，业主 2026-09-24：局放→泄漏切换要填计算模板）。
 * 部分字段更新，写完重读——`after` 是权威值（与 run_mode 同一口径）。
 */
export interface CameraLeakageWriteResult {
  /** 这次写入的部分字段（原样回显）。 */
  requested: CameraLeakagePatch
  before: Fa371LeakageConfig
  after: Fa371LeakageConfig
}

/**
 * 泄漏估算参数的写入补丁（线上键名与 §5.1.11 一致；只带要改的字段）。
 * 渲染层与主进程共用这一个定义（过 IPC 的就是它）。
 */
export interface CameraLeakagePatch {
  /** V2.0 新增：现场校正系数。 */
  correction_rate?: number
  /** `0` 不展示 / `1` 展示泄漏成本。 */
  cost_display?: number
  /** 泄漏估算距离，1–50 米。 */
  leakage_distance?: number
  /** `0` = l/min，`1` = ml/s。 */
  leakage_unit?: number
  /** `0` ¥ / `1` £ / `2` $ / `3` € / `4` ₽。 */
  monetary_unit?: number
  value_of_gas?: number
  energy_cost?: number
  specific_power?: number
  working_hours?: number
}

// ---------------------------------------------------------------------------
// 检测模式（`work_mode`，`GET` / `PUT /system`）—— 与 run_mode 运行方式是两件事
// ---------------------------------------------------------------------------
//
// ⚠ 名字警告：本文件上面那个 `CameraRunModeWriteResult` 是**运行方式**
// （`/run_mode`，手册 §5.1.8：单次检测 / 智能巡航）；下面这个是**检测模式**
// （这台设备在做哪种应用：局部放电 / 气体泄漏 / 机械异响），端点 `/system`
// **不在任何一份手册里**。两者只差一个词，看清楚再改。
//
// 下面这一组与 `CameraRunModeWriteResult` 是**并列关系**，本文件不合并它们：
// 端点不同（`/run_mode` vs `/system`）、手册地位不同（手册接口 vs 实测接口）、
// 失败时操作员的下一步也不同。合并只会让"哪个是文档说的"变得不可读。

/**
 * 一次「读检测模式（work_mode）」的结果。
 *
 * `available` 是**能力门**，不是装饰：`/system` 是未文档化端点，固件换一版就可能
 * 消失或不再回 `work_mode`。读不到时界面**不渲染**这个控件（而不是渲染一个点了
 * 必然失败的按钮）—— 这与本面板维护区"做不到的不渲染"是同一条规则。
 *
 * 注意 `before`/`after` 里认不出的取值：`mode`/`key` 保持缺省，`raw` 如实带着数字，
 * 界面据此显示"设备返回了 N"（见 `mapWorkMode`，它不做"未知 → 机械异响"的兜底）。
 */
export interface CameraWorkModeRead {
  /**
   * 本次读取是否拿到了可用的读数。
   *
   * `false` 有两种来源，界面**不区分**：设备没回 `work_mode`（`view.raw` 也在此时
   * 缺省），或者主进程那次读整体失败 —— 两种情况下这个控件都点不了。
   */
  available: boolean
  /** 设备自报的检测模式（原始值 + 可能命中的枚举与稳定 label KEY）。 */
  view: Fa371WorkModeConfig
  /** 可以写入的三个值，按界面顺序给出（`1`/`2`/`3`）。 */
  selectable: readonly Fa371WorkModeValue[]
}

/**
 * 一次「切换检测模式（work_mode）」的完整结果。
 *
 * 与 `CameraRunModeWriteResult` 同一条规矩，理由在本设备上同样成立（而且更强）：
 * **写完之后必须再读一遍**。本设备实测过 `PUT /alarm_strategy {Switch:1}` 应答
 * `ret:200` 却完全不生效（`docs/FA371-API-DELTA.md` §1），而 `/system` 这个端点
 * 连手册都没有，成功码能说明的东西更少。所以 `after` 是写完之后重新读到的设备事实，
 * 界面显示它；`applied` 由 `after.raw === requested` 得出。
 *
 * `applied === false` 时界面必须说「设备应答成功但没有生效」，而不是把控件翻到请求值。
 *
 * **本次写入只碰 `work_mode` 一个字段**：`/system/acoustic` 与 `/system/image`
 * （成像频带、目标数量、灵敏度、增强、阈值）属于另一条通道（`camera-mode-preset.ts`），
 * 切换应用模式**不会**顺带改写它们。这是刻意的：把客户的成像参数当成切换模式的
 * 副作用悄悄重写，是那种"当场看不出来、下次检测结果不对"的惊喜。
 */
export interface CameraWorkModeWriteResult {
  /** 请求写入的检测模式（`1`/`2`/`3`，实测过的三个值）。 */
  requested: Fa371WorkModeValue
  /** 写之前设备的读数。 */
  before: Fa371WorkModeConfig
  /** 写之后重新读取的读数 —— **权威值**。 */
  after: Fa371WorkModeConfig
  /**
   * 设备是否真的切到了 `requested`。
   *
   * 按**原始值**比对（`after.raw === requested`），不是按映射后的枚举：读回来一个
   * 认不出的数字时 `after.mode` 是 `undefined`，而 `raw` 仍然如实带着那个数字，
   * 于是"设备改成了一个我不认识的模式"会被判成 `false`（没按请求生效）而不是被
   * 悄悄算成成功。
   */
  applied: boolean
}

// ---------------------------------------------------------------------------
// 检测区域（`GET` / `PUT /system/scan_area`）
// ---------------------------------------------------------------------------

/**
 * 一次检测区域写入的结果。
 *
 * `requested` 是渲染层在视频画面上绘制后换算出的设备坐标；`after` 是 PUT 之后
 * 再次 GET 到的设备事实。与其它 FA371 写操作保持同一条规则：HTTP 成功不等于设备
 * 已经采用配置，所以界面只用 `after` 作为最终显示，并通过 `applied` 明确告知结果。
 */
export interface CameraScanAreaWriteResult {
  requested: Fa371ScanArea
  before: Fa371ScanArea
  after: Fa371ScanArea
  applied: boolean
}

/**
 * 软件侧的告警区域元数据。
 *
 * 相机 `/system/scan_area` 只保存矩形坐标与 draw_status，没有稳定 id / 名称；
 * 因此编号与名称必须由桌面软件自己持久化。`id` 是稳定主键，`areaIndex` 只是
 * 当前下发到相机数组里的顺序，删除中间一项后可以变化，二者绝不能混为一谈。
 */
export interface CameraAlarmRegionMetadata {
  id: string
  deviceId: string
  /** 当前相机区域数组中的 0-based 顺序。 */
  areaIndex: number
  name: string
  leftTopX: number
  leftTopY: number
  width: number
  height: number
  createdAt: number
  updatedAt: number
}

/** 渲染层保存区域元数据时使用的输入；主进程补 deviceId / createdAt / updatedAt。 */
export interface CameraAlarmRegionMetadataInput {
  /** 已存在的区域带稳定 id；新区域可以省略，由主进程生成。 */
  id?: string
  areaIndex: number
  name: string
  leftTopX: number
  leftTopY: number
  width: number
  height: number
}

/**
 * 一个坐标点命中的本地区域。
 *
 * 这是给后续“告警记录显示区域名称”预留的纯函数：当设备告警能提供 pixelX/pixelY
 * 时，事件链可以直接调用，不必再次复制矩形判断逻辑。多个区域重叠时返回面积最小
 * 的那个（更具体的区域优先）。
 */
export function cameraAlarmRegionAtPoint(
  regions: readonly CameraAlarmRegionMetadata[],
  x: number,
  y: number
): CameraAlarmRegionMetadata | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return regions
    .filter((region) =>
      x >= region.leftTopX &&
      y >= region.leftTopY &&
      x <= region.leftTopX + region.width &&
      y <= region.leftTopY + region.height
    )
    .sort((a, b) => a.width * a.height - b.width * b.height)[0]
}

// ---------------------------------------------------------------------------
// 检测启停（`POST /turn_on_detect` / `POST /turn_off_detect`）
// ---------------------------------------------------------------------------

export type CameraDetectAction = 'turn_on' | 'turn_off'

/**
 * 一次检测启停的结果。
 *
 * 与改模式同理：`applied` 来自动作**之后**重新读取的 `GET /system/detect_status`，
 * 而不是 HTTP 200 或 `ret:200`。手册 §8.3 C12 说重复调用、未在检测中调用的行为
 * 都未定义，所以只有读回值能当事实。
 */
export interface CameraDetectActionResult {
  action: CameraDetectAction
  /** 动作之后重新读取的检测状态。 */
  status: Fa371DetectStatus
  /** 设备是否真的进入了（`turn_on`）或退出了（`turn_off`）检测。 */
  applied: boolean
  /** `POST /turn_on_detect` 返回的 `detect_id`；巡航模式下可能没有。 */
  detectId?: number
}

// ---------------------------------------------------------------------------
// 启用中的告警策略（`GET`/`PUT /alarm_strategy_enable`）
// ---------------------------------------------------------------------------

/**
 * 当前处于启用状态的策略。
 *
 * 为什么这份数据在「控制」而不是「告警模型」里：新手册明确
 * 「Before calling the start-detection interface, make sure that one alarm strategy is
 * enabled」，且设备**同时只允许一条策略启用**。也就是说启用状态是
 * 「开始检测」这个动作的**前提条件**，界面必须拿它来决定启停按钮是否可用。
 */
export interface CameraEnabledStrategyView {
  /** 设备自报的启用中策略（`alarm_strategy_list`，与 `/alarm_strategy` 同形）。 */
  items: Fa371AlarmStrategy[]
  /** 派生：启用中的策略 id（字符串形式，与 `Fa371AlarmStrategy.id` 一致）。 */
  ids: string[]
}

/**
 * 一次「启用/停用策略」的结果。
 *
 * 设备最多只允许一条策略启用，所以启用目标时若已有别的策略启用，
 * 必须按手册给的顺序**先停用旧的、再启用新的**。`disabledPrevious`
 * 就是那次额外停用，界面上要如实说明做过这一步。
 */
export interface CameraStrategyEnableResult {
  requested: { id: number; enable: boolean }
  /** 写入前设备自报的启用集合。 */
  before: string[]
  /** 为启用目标而额外停用的策略 id；没有这一步时缺省。 */
  disabledPrevious?: number
  /** 重新读取后的启用集合 —— **权威值**。 */
  after: string[]
  /** 目标的启停状态是否真的与请求一致。 */
  applied: boolean
}

/** 派生 id 列表，供界面直接判断「有没有启用」与「是不是这一条」。 */
export function enabledStrategyIds(items: readonly Fa371AlarmStrategy[]): string[] {
  const ids: string[] = []
  for (const item of items) {
    if (item.enabled === true && item.id !== undefined) ids.push(item.id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// 维护：设备自报的版本信息（只读）
// ---------------------------------------------------------------------------

/**
 * 设备自报的版本信息。
 *
 * 来源是两个**手册未收录、实测存在**的只读接口（`GET /dev_info` 与 `GET /basic`），
 * 它们正是设备自带 Web 界面在用的接口（固化在 `main.<hash>.js` 里）。
 * 手册与旧规格都写着「系统信息读取只有 UI、开放接口未开放」，实测把它们推翻了：
 * `GET /dev_info` 回 `device_version` / `sdk_version`，`GET /basic` 回
 * `web_version` / `upgrade_time`。
 *
 * 缺字段一律 `undefined` —— 界面据此说「这一项没读到」，而不是显示空字符串或 0。
 */
export interface CameraVersionInfo {
  /** 固件版本（`GET /dev_info` 的 `device_version`）。 */
  firmwareVersion?: string
  /** SDK 版本（`GET /dev_info` 的 `sdk_version`）。 */
  sdkVersion?: string
  /** 设备自带 Web 界面版本（`GET /basic` 的 `web_version`）。 */
  webVersion?: string
  /** 上次升级时刻（`GET /basic` 的 `upgrade_time`）。**设备原样的字符串**，不做解析或换算。 */
  lastUpgradeTime?: string
}

/** 版本信息的来源，供界面区分「这个来源没读到」。 */
export type CameraMaintenanceSourceId = 'dev_info' | 'basic'

export const CAMERA_MAINTENANCE_SOURCE_IDS: readonly CameraMaintenanceSourceId[] = ['dev_info', 'basic']

// ---------------------------------------------------------------------------
// 维护：能做与不能做的能力表
// ---------------------------------------------------------------------------

/**
 * 维护动作的稳定标识。
 *
 * ---------------------------------------------------------------------------
 * 这一张表在一次决定之后改过一次，改动的理由写在这里
 * ---------------------------------------------------------------------------
 * 旧结论：「升级 / 回滚 / 重启 / 恢复出厂**没有开放接口**」——两份手册
 * （`api-workflow.txt`、`practical-guide.txt`）都只把升级放在设备自己的 Web 界面里，
 * 而 `GET /system/upgrade`、`/system/version`、`/system/reboot`、
 * `/system/factory_reset` 在真机上一律 **HTTP 404**。基于这个结论，本软件**刻意不做**
 * 升级，只给禁用控件 + 原因，并保留「打开设备 Web 界面」这条路。
 *
 * 现在：厂家自己的升级流程（`docs/reference/fe128-upgrade-procedure.txt`）是
 * SSH/SFTP + 自解压脚本，确实不适合做进桌面软件；但**设备自带 Web 界面那条路是纯
 * HTTP**（`POST /upload` multipart + `PUT /reboot` + `GET /progress`，全部从设备的
 * `main.<hash>.js` 里读出来，真机只读复核过 `/progress`）。所以：
 *
 *   - `firmware_upgrade` 与 `reboot` **现在可用**（设备在线时），走的就是设备自己的
 *     那两个接口 —— 它们是**未文档化**的接口，界面上开着的控件都会说明这一点；
 *   - `rollback` 与 `factory_reset` **仍然不可用**：没有任何实测或文档依据。
 *     设备 bundle 里出现过一条 `/recovery` 路径，但它的语义完全未经验证
 *     （"恢复"可能是恢复配置、也可能是恢复出厂），不去猜，也不接线。
 */
export type CameraMaintenanceFeatureId =
  | 'firmware_upgrade'
  | 'rollback'
  | 'reboot'
  | 'factory_reset'
  | 'device_web_ui'

export const CAMERA_MAINTENANCE_FEATURE_IDS: readonly CameraMaintenanceFeatureId[] = [
  'firmware_upgrade',
  'rollback',
  'reboot',
  'factory_reset',
  'device_web_ui'
]

/**
 * 不可用的原因，稳定 KEY（渲染层翻成 `cameraControlUi.reason*`）。
 *
 * `not_in_open_interface` 与 `device_offline` 分开，是因为两者对操作员的下一步
 * 不同：前者「设备根本不支持」，后者「先把设备弄上线」。
 *
 * 注：曾经还有一个 `upgrade_only_in_device_web_ui`（"升级去设备 Web 界面做，
 * 本软件不代传固件包"）。升级已经实装，那句话不再成立，所以连同它的文案一起删掉了 ——
 * 留着一个永远不可达、且内容与软件实际行为相反的原因，比没有它更糟。
 */
export type CameraMaintenanceReasonKey = 'not_in_open_interface' | 'device_offline'

export interface CameraMaintenanceFeature {
  id: CameraMaintenanceFeatureId
  /** 现在能不能用。`false` 时界面渲染**禁用**控件，并把 `reasonKey` 放进 title。 */
  available: boolean
  reasonKey?: CameraMaintenanceReasonKey
}

export interface CameraMaintenanceInfo {
  version: CameraVersionInfo
  /** 没读到版本的来源；空数组表示两个来源都读到了。 */
  unreadable: CameraMaintenanceSourceId[]
  features: CameraMaintenanceFeature[]
}

/**
 * 维护能力表（纯函数，可测）。
 *
 * 唯一的外部输入是「设备现在在不在线」。在线的意义对五项是一样的：升级要连设备
 * 上传几十 MB，重启要连设备发一条 PUT，打开设备 Web 界面要一个能连上的设备 ——
 * 离线时它们都只是通往错误页的按钮，所以一律禁用 + 原因。
 *
 * `rollback` / `factory_reset` 与在线状态**无关**：它们在**任何**状态下都没有
 * 可用的接口，原因固定。
 */
export function cameraMaintenanceFeatures(options: { deviceOnline: boolean }): CameraMaintenanceFeature[] {
  const online = options.deviceOnline
  return [
    online
      ? { id: 'firmware_upgrade', available: true }
      : { id: 'firmware_upgrade', available: false, reasonKey: 'device_offline' },
    { id: 'rollback', available: false, reasonKey: 'not_in_open_interface' },
    online
      ? { id: 'reboot', available: true }
      : { id: 'reboot', available: false, reasonKey: 'device_offline' },
    { id: 'factory_reset', available: false, reasonKey: 'not_in_open_interface' },
    online
      ? { id: 'device_web_ui', available: true }
      : { id: 'device_web_ui', available: false, reasonKey: 'device_offline' }
  ]
}

/** 按 id 取一项能力；缺失时返回 `undefined`（界面据此不渲染该控件）。 */
export function maintenanceFeature(
  info: Pick<CameraMaintenanceInfo, 'features'>,
  id: CameraMaintenanceFeatureId
): CameraMaintenanceFeature | undefined {
  return info.features.find((feature) => feature.id === id)
}
