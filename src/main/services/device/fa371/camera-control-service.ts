/**
 * FA371 声学相机 —— **控制与维护**服务。
 *
 * ---------------------------------------------------------------------------
 * 职责
 * ---------------------------------------------------------------------------
 *   - 检测模式：`GET` / `PUT /run_mode`（手册里的字段名叫**检测模式**：`1` 单次检测、
 *     `-1` 智能巡航）；
 *   - 检测启停：`POST /turn_on_detect`、`POST /turn_off_detect`，状态读
 *     `GET /system/detect_status`；
 *   - 启用中的告警策略：`GET` / `PUT /alarm_strategy_enable`
 *     （新手册 `docs/reference/api-workflow.txt` 第 129–134、340–346 行）；
 *   - 维护能力：版本信息读取与「升级」等动作的能力表。
 *
 * ---------------------------------------------------------------------------
 * 为什么单独一个服务，而不是并进 `camera-alarm-service.ts`
 * ---------------------------------------------------------------------------
 * `CameraAlarmService` 拥有告警模型的**内容**（策略/条件的新建、修改、删除），
 * 本服务拥有「检测能不能跑起来」所需的**运行状态**：检测模式、检测启停、
 * 当前启用的是哪条策略。两者的分界线是产品语义而不是文件大小 ——
 * 新手册明确「Before calling the start-detection interface, make sure that one alarm
 * strategy is enabled」，且设备**同时只允许一条策略启用**，所以「启用中的策略」
 * 是开始检测的**前提条件**，必须和启停按钮读同一份状态、一起刷新。
 * 策略/条件的内容编辑仍在 `cameraAlarms` 通道里，两处不重复。
 *
 * ---------------------------------------------------------------------------
 * 两条贯穿全文件的规则
 * ---------------------------------------------------------------------------
 * 1) **写后重读**：本设备上 `PUT /alarm_strategy {Switch:1}` 已被实测为应答
 *    `ret:200` 却完全不生效（`docs/FA371-API-DELTA.md` §1）。所以每个写操作都返回
 *    **重新读到的设备事实** + 一个 `applied` 标志，绝不把成功码当成生效。
 * 2) **不猜**：`run_mode` 既不是 `1` 也不是 `-1` 时只保留原始值（`mapRunMode`），
 *    `applied` 保持 `false`；设备没回的版本字段保持缺省。
 *
 * 全部依赖以**结构化类型**注入（`CameraControlOperations`），因此测试不需要真机，
 * 也不需要 Electron。
 */

import { AppError, ErrorCodes } from '@shared/errors'
import {
  cameraMaintenanceFeatures,
  type CameraDetectActionResult,
  type CameraEnabledStrategyView,
  type CameraMaintenanceInfo,
  type CameraMaintenanceSourceId,
  type CameraRunModeWriteResult,
  type CameraStrategyEnableResult,
  type CameraWorkModeRead,
  type CameraWorkModeWriteResult
} from '@shared/domain/camera-control'
import {
  cameraModeDeviceView,
  cameraModeMatchedPresetIds,
  cameraModeMatchesPreset,
  cameraModePreset,
  fieldApplied,
  type CameraModeAcousticValues,
  type CameraModeAnyFieldKey,
  type CameraModeDeviceView,
  type CameraModeFieldResult,
  type CameraModeImagingValues,
  type CameraModePresetId,
  type CameraModePresetRead,
  type CameraModePresetWriteResult,
  type CameraModeRequestedValues
} from '@shared/domain/camera-mode-preset'
import {
  Fa371RunMode,
  FA371_WORK_MODES,
  type Fa371AcousticConfig,
  type Fa371DetectStatus,
  type Fa371ImagingConfig,
  type Fa371RunModeConfig,
  type Fa371RunModeValue,
  type Fa371WorkModeValue
} from '@shared/domain/fa371'
import {
  mapAcousticConfig,
  mapCameraVersionInfo,
  mapDetectStatus,
  mapDetectionResult,
  mapEnabledStrategyView,
  mapImagingConfig,
  mapRunMode,
  mapWorkMode
} from './mappers'
import type {
  Fa371AckDto,
  Fa371AcousticDto,
  Fa371AcousticWriteDto,
  Fa371AlarmStrategyEnableWriteDto,
  Fa371AlarmStrategyPageDto,
  Fa371BasicInfoDto,
  Fa371DetectStatusDto,
  Fa371ImagingDto,
  Fa371ImagingWriteDto,
  Fa371RunModeDto,
  Fa371RunModeWriteDto,
  Fa371SystemDto,
  Fa371TurnOnDetectDto,
  Fa371VersionInfoDto,
  Fa371WorkModeWriteDto
} from './dto'

// ---------------------------------------------------------------------------
// 客户端能力（结构化类型，测试可注入假实现）
// ---------------------------------------------------------------------------

/**
 * 本服务真正用到的接口，一个不多。
 *
 * 与 `CameraAlarmOperations` 同样的理由：测试注入的假客户端只要满足这个形状，
 * 而形状本身就是「这个服务依赖哪些设备能力」的文档。
 */
export interface CameraControlOperations {
  getRunMode(): Promise<Fa371RunModeDto>
  setRunMode(body: Fa371RunModeWriteDto): Promise<Fa371AckDto>
  getDetectStatus(): Promise<Fa371DetectStatusDto>
  startDetection(): Promise<Fa371TurnOnDetectDto>
  stopDetection(): Promise<void>
  getEnabledAlarmStrategies(): Promise<Fa371AlarmStrategyPageDto>
  setAlarmStrategyEnabled(body: Fa371AlarmStrategyEnableWriteDto): Promise<Fa371AckDto>
  getVersionInfo(): Promise<Fa371VersionInfoDto>
  getBasicInfo(): Promise<Fa371BasicInfoDto>
  /** `GET /system/acoustic`（§5.1.2）。应用模式预设读写的就是这一对。 */
  getAcousticConfig(): Promise<Fa371AcousticDto>
  /** `PUT /system/acoustic`（§5.1.3）。手册标 non-essential：支持只发部分字段。 */
  setAcousticConfig(body: Fa371AcousticWriteDto): Promise<Fa371AckDto>
  /** `GET /system/image`（§5.1.4）。 */
  getImagingConfig(): Promise<Fa371ImagingDto>
  /**
   * `PUT /system/image`（§5.1.5）。
   *
   * `targetCount` 走 `Fa371ApiClient.setImagingConfig` 的候选机制
   * （`DEFAULT_FA371_IMAGING_TARGET_KEY`），本服务**不自己拼** `target_number` /
   * `target_numbe` 这两个键 —— 真实拼写尚未定论（§8.3 C2）。
   */
  setImagingConfig(
    body: Fa371ImagingWriteDto,
    options?: { targetCount?: number }
  ): Promise<Fa371AckDto>
  /**
   * `GET /system` —— 应用模式（局部放电 / 气体泄漏 / 机械异响）。
   *
   * **⚠ 端点未文档化**（不在任何一份手册里，是设备自带 Web 界面的 bundle 里读出来的；
   * 见 `fa371-api-client.ts` 的 `FA371_ENDPOINTS.system` 与 `dto.ts` 的实测记录）。
   * 本服务的读方法把它当"实测接口"对待：**读不到就不渲染控件**，而不是假设它一定在。
   */
  getWorkMode(): Promise<Fa371SystemDto>
  /**
   * `PUT /system` —— 切换应用模式。**⚠ 同样未文档化。**
   *
   * 只发 `{work_mode}` 一个字段；成像参数（`/system/acoustic`、`/system/image`）
   * 不在这一次请求里，由另一条通道（应用模式预设）单独负责。
   */
  setWorkMode(body: Fa371WorkModeWriteDto): Promise<Fa371AckDto>
}

// ---------------------------------------------------------------------------
// 应用模式（`GET` / `PUT /system`）—— ⚠ 端点未文档化，真机实测可读可写
// ---------------------------------------------------------------------------
//
// 与「应用模式预设」（本文件最后一节，写 `/system/acoustic` + `/system/image`）
// **刻意分开，两条路互不调用，方法体里也互不引用**：
//   - 这里写的是 `work_mode` —— 这台设备在做哪种应用；
//   - 预设写的是成像参数（频带 / 目标数量 / 灵敏度 / 增强）。
// 切换应用模式**绝不**顺带改成像参数：把客户现场调好的频带当成切换模式的副作用
// 悄悄重写，是那种"当场看不出来、下一次检测结果不对"的惊喜。反过来也一样，
// 应用预设不碰 `work_mode`。
//
// 端点本身的性质见 `fa371-api-client.ts` 的 `FA371_ENDPOINTS.system`：
// 实测存在、可读可写，但**不在任何一份手册里**，所以本服务把"读不到"当成
// 一等公民（`available: false`），而不是假设它一定在。

// ---------------------------------------------------------------------------
// 管理员校验的单一出处
// ---------------------------------------------------------------------------

/**
 * 本服务暴露的每个动作。
 *
 * 名字与 IPC 通道一一对应（`handlers.ts`），也是下表的键。
 */
export type CameraControlAction =
  | 'readRunMode'
  | 'writeRunMode'
  | 'readDetectStatus'
  | 'turnOnDetect'
  | 'turnOffDetect'
  | 'readEnabledStrategy'
  | 'setStrategyEnabled'
  | 'readMaintenance'
  | 'readModePreset'
  | 'applyModePreset'
  | 'readWorkMode'
  | 'writeWorkMode'

/**
 * 哪些动作需要管理员权限。
 *
 * 规则沿用 `handlers.ts` 顶部那条：**读公开、写要管理员**。
 *   - `writeRunMode`：改的是设备的行为方式（单次/巡航），与 `cameraAlarms` 的四个
 *     写操作同级 —— 那些写操作改的是"判定什么算告警"，这条改的是"检测怎么跑"；
 *   - `turnOnDetect` / `turnOffDetect`：让硬件**真的开始/停止一次检测**
 *     （单次检测会占用设备一个检测周期，1~30 秒），与 `cameraLive.start` /
 *     `fa371Stream.start` 属于同一类「会让相机做事」的操作，同样要管理员；
 *   - `setStrategyEnabled`：写设备配置，且设备**同时只允许一条策略启用**，
 *     启用它等于改掉智能巡航的判定依据；与 `cameraAlarms` 的写操作一致要管理员。
 *   - `applyModePreset`：改的是**设备成像参数**（频带 / 目标数量 / 增强），
 *     它决定现场看到的声场图长什么样，与 `cameraAlarms` 的写操作同级；
 *     而且厂家自己的 Quick Start 就是把它摆在「开始检测」之前的一步
 *     （`docs/reference/api-workflow.txt` 第 60 行），所以同样要管理员。
 *   - `writeWorkMode`：改的是这台设备**在做哪种应用**（局部放电 / 气体泄漏 /
 *     机械异响）。它比改成像参数更重 —— 成像参数是"按场景调参"，而这一条改的是
 *     设备自报的机型状态，现场据此判断该用哪套参数、该不该照当前读数下结论。
 *     端点还**没有文档**（实测可写），所以更要由管理员来动。
 *
 * 六个读操作不校验：它们只是读设备状态。
 *
 * 这张表是这条规则的**单一出处**，由 `tests/camera-control.test.ts` 守护；
 * `handlers.ts` 里每个写通道仍显式写一行 `requireAdministrator()`（与相邻的
 * `cameraAlarms` 通道一致，让看代码的人一眼看到校验在哪里）。
 */
export const CAMERA_CONTROL_ADMIN_REQUIRED: Readonly<Record<CameraControlAction, boolean>> = {
  readRunMode: false,
  writeRunMode: true,
  readDetectStatus: false,
  turnOnDetect: true,
  turnOffDetect: true,
  readEnabledStrategy: false,
  setStrategyEnabled: true,
  readMaintenance: false,
  readModePreset: false,
  applyModePreset: true,
  readWorkMode: false,
  writeWorkMode: true
}

/** 供调用方（以及测试）查询某个动作是否需要管理员。 */
export function cameraControlRequiresAdministrator(action: CameraControlAction): boolean {
  return CAMERA_CONTROL_ADMIN_REQUIRED[action] === true
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface CameraControlServiceOptions {
  /** 取某台相机当前的 FA371 客户端（由 DeviceService 提供，含已解析的会话）。 */
  clientFor: (deviceId: string) => CameraControlOperations
  /**
   * 设备是否在线（本地记录的状态，不额外探活）。
   *
   * 只用于维护能力表里的「打开设备 Web 界面」：离线时那个按钮只会把操作员送到
   * 浏览器的错误页，所以渲染成禁用 + 原因。缺省视为在线（开发环境/测试）。
   */
  isOnline?: (deviceId: string) => boolean
}

export class CameraControlService {
  private readonly clientFor: (deviceId: string) => CameraControlOperations
  private readonly isOnline: (deviceId: string) => boolean

  constructor(options: CameraControlServiceOptions) {
    this.clientFor = options.clientFor
    this.isOnline = options.isOnline ?? (() => true)
  }

  // -- 检测模式 -----------------------------------------------------------

  async readRunMode(deviceId: string): Promise<Fa371RunModeConfig> {
    return mapRunMode(await this.clientFor(deviceId).getRunMode())
  }

  /**
   * 改检测模式：写 → **重读** → 返回设备事实。
   *
   * 只接受手册定义的 `1` / `-1`：`run_mode` 的其它取值手册没有定义，
   * 发一个猜出来的数字比拒绝更糟。
   */
  async writeRunMode(deviceId: string, mode: Fa371RunModeValue): Promise<CameraRunModeWriteResult> {
    if (mode !== Fa371RunMode.SingleDetection && mode !== Fa371RunMode.IntelligentCruise) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `检测模式只能是 ${Fa371RunMode.SingleDetection}（单次检测）或 ${Fa371RunMode.IntelligentCruise}（智能巡航），收到 ${String(mode)}`
      )
    }

    const client = this.clientFor(deviceId)
    const before = mapRunMode(await client.getRunMode())
    await client.setRunMode({ run_mode: mode })
    const after = mapRunMode(await client.getRunMode())

    return {
      requested: mode,
      before,
      after,
      // 读回值无法识别（既不是 1 也不是 -1）时同样是 false —— 不猜设备改成了什么。
      applied: after.mode === mode
    }
  }

  // -- 检测启停 -----------------------------------------------------------

  async readDetectStatus(deviceId: string): Promise<Fa371DetectStatus> {
    return mapDetectStatus(await this.clientFor(deviceId).getDetectStatus())
  }

  /**
   * 开始检测（`POST /turn_on_detect`），随后重读状态。
   *
   * 设备在没有可用策略时回 `ret:-1`，`Fa371ApiClient` 会把它变成带 `msg` 原文的
   * `DEVICE_ERROR` —— 这个异常**原样向上抛**：界面要看到的是设备说的那句话
   * （"没有可用的策略"），而不是被这里改写过的版本。
   */
  async turnOnDetect(deviceId: string): Promise<CameraDetectActionResult> {
    const client = this.clientFor(deviceId)
    const result = mapDetectionResult(await client.startDetection())
    const status = mapDetectStatus(await client.getDetectStatus())
    return {
      action: 'turn_on',
      status,
      applied: status.detecting,
      ...(result.detectId !== undefined ? { detectId: result.detectId } : {})
    }
  }

  /**
   * 停止检测（`POST /turn_off_detect`，无响应内容），随后重读状态。
   *
   * 新手册提醒：单次检测在策略周期结束时**自己会停**，那时不必再调停用接口
   * （`api-workflow.txt` 第 186 行）。所以界面上"停止"按钮只在设备仍报检测中时
   * 才有意义；服务这一层不去替设备判断，照发请求并按读回值作答。
   */
  async turnOffDetect(deviceId: string): Promise<CameraDetectActionResult> {
    const client = this.clientFor(deviceId)
    await client.stopDetection()
    const status = mapDetectStatus(await client.getDetectStatus())
    return { action: 'turn_off', status, applied: !status.detecting }
  }

  // -- 启用中的告警策略 ---------------------------------------------------

  async readEnabledStrategy(deviceId: string): Promise<CameraEnabledStrategyView> {
    return mapEnabledStrategyView(await this.clientFor(deviceId).getEnabledAlarmStrategies())
  }

  /**
   * 启用/停用一条策略（`PUT /alarm_strategy_enable`）。
   *
   * 手册给的顺序（`api-workflow.txt` 第 129–134 行场景 2）：设备**同时只允许一条
   * 策略启用**，所以要启用 B 而当前启用着 A 时，必须**先停用 A、再启用 B**。
   * 本方法就按这个顺序执行，并把那次额外停用如实报出来（`disabledPrevious`）。
   *
   * 返回的 `after` 是**重读**得到的启用集合：`ret:200` 不等于生效，本设备有先例。
   */
  async setStrategyEnabled(
    deviceId: string,
    strategyId: number,
    enable: boolean
  ): Promise<CameraStrategyEnableResult> {
    if (!Number.isInteger(strategyId) || strategyId <= 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `告警策略 id 必须是正整数（收到 ${String(strategyId)}）；读取侧的 id 可能是字符串，无法解析时不能用于 PUT /alarm_strategy_enable`
      )
    }

    const client = this.clientFor(deviceId)
    const beforeView = await this.clientEnabled(client)
    const targetId = String(strategyId)

    let disabledPrevious: number | undefined
    if (enable && beforeView.ids.length > 0 && !beforeView.ids.includes(targetId)) {
      const previous = parsePositiveId(beforeView.ids[0])
      if (previous === undefined) {
        throw new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `设备当前启用着 id "${String(beforeView.ids[0])}" 的策略，但它不是整数，无法按手册顺序先停用它`
        )
      }
      await client.setAlarmStrategyEnabled({ switch: 0, id: previous })
      disabledPrevious = previous
    }

    await client.setAlarmStrategyEnabled({ switch: enable ? 1 : 0, id: strategyId })

    // 重读：`ret:200` 不等于生效（本设备有 `PUT /alarm_strategy {Switch:1}` 的先例）。
    const afterView = mapEnabledStrategyView(await client.getEnabledAlarmStrategies())

    return {
      requested: { id: strategyId, enable },
      before: beforeView.ids,
      ...(disabledPrevious !== undefined ? { disabledPrevious } : {}),
      after: afterView.ids,
      applied: enable ? afterView.ids.includes(targetId) : !afterView.ids.includes(targetId)
    }
  }

  // -- 应用模式（`GET` / `PUT /system`，⚠ 端点未文档化）-------------------

  /**
   * 读应用模式（`GET /system`）。
   *
   * 与 `readMaintenance` 的"读失败只影响该字段"不同：这里**读失败就是不可用**。
   * 理由是这个端点没有文档 —— 换一版固件它可能就没了，而一个"点了必然失败"的按钮
   * 比没有按钮更糟。所以异常被收成 `available: false` 交给界面（界面据此**不渲染**
   * 这个控件），而不是抛出去让整张面板变成一条错误。
   *
   * 异常不吞掉信息：它会经 `deviceLog` 记录（由客户端那一层做），而缺字段与整体
   * 失败在界面上是同一件事（控件不出现），所以这里不需要区分。
   */
  async readWorkMode(deviceId: string): Promise<CameraWorkModeRead> {
    const selectable = FA371_WORK_MODES
    try {
      const view = mapWorkMode(await this.clientFor(deviceId).getWorkMode())
      return { available: view.raw !== undefined, view, selectable }
    } catch {
      // 未文档化端点：读不到 = 这台设备这一版固件不提供，界面上就是不出现。
      return { available: false, view: {}, selectable }
    }
  }

  /**
   * 切换应用模式：读 → 写 → **重读** → 比对（`{requested, before, after, applied}`）。
   *
   * 只接受 `1` / `2` / `3`（真机实测过的三个值）：`work_mode` 在设备前端里的兜底是
   * "非 1 非 2 都当机械异响"，但**没有任何文档**说明其它数字是什么，发一个猜出来的
   * 数字过去还不如直接拒绝。
   *
   * 只写 `work_mode` 一个字段，**不碰**声学与成像配置（那是应用模式预设那条通道的
   * 事，`applyModePreset`）。这是刻意的边界，不是遗漏。
   *
   * `applied` 按**原始值**比对：读回来一个认不出的数字时它是 `false`，
   * 而不是"反正读到了就当成功"。
   */
  async writeWorkMode(
    deviceId: string,
    mode: Fa371WorkModeValue
  ): Promise<CameraWorkModeWriteResult> {
    if (!FA371_WORK_MODES.includes(mode)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `应用模式只能是 ${FA371_WORK_MODES.join(' / ')}（真机实测过的取值），收到 ${String(mode)}`
      )
    }

    const client = this.clientFor(deviceId)
    const before = mapWorkMode(await client.getWorkMode())
    // 只发 work_mode 一个字段：`/system` 有没有部分字段更新语义完全没有文档，
    // 多发一个字段就是拿设备配置赌一次。
    await client.setWorkMode({ work_mode: mode })
    // 重读：`ret:200` 不是证据，而这里连手册都没有 —— 界面显示的是这个 `after`。
    const after = mapWorkMode(await client.getWorkMode())

    return {
      requested: mode,
      before,
      after,
      applied: after.raw === mode
    }
  }

  // -- 维护 ---------------------------------------------------------------

  /**
   * 维护信息：设备自报的版本 + 能力表。
   *
   * 版本来自两个**手册未收录、实测存在**的只读接口（`GET /dev_info`、
   * `GET /basic`），任一路失败都只影响它自己负责的字段 —— 界面据此显示
   * 「这一项没读到」，而不是把整张维护卡变成一句错误。
   */
  async readMaintenance(deviceId: string): Promise<CameraMaintenanceInfo> {
    const client = this.clientFor(deviceId)
    const [version, basic] = await Promise.allSettled([client.getVersionInfo(), client.getBasicInfo()])

    const unreadable: CameraMaintenanceSourceId[] = []
    if (version.status === 'rejected') unreadable.push('dev_info')
    if (basic.status === 'rejected') unreadable.push('basic')

    return {
      version: mapCameraVersionInfo(
        version.status === 'fulfilled' ? version.value : undefined,
        basic.status === 'fulfilled' ? basic.value : undefined
      ),
      unreadable,
      features: cameraMaintenanceFeatures({ deviceOnline: this.isOnline(deviceId) })
    }
  }

  // -- 应用模式预设（`/system/acoustic` + `/system/image`）-----------------

  /**
   * 读设备当前的成像参数，并判断它命中哪个应用模式预设。
   *
   * 两个读接口并行发：它们互相独立，串行只是多等一个往返。
   * 读失败**不吞**：界面拿不到频带时应该显示"没读到"，而不是显示一个空频带 ——
   * 所以这里让异常往上抛，由渲染层按 `DeviceResult` 的失败显示。
   */
  async readModePreset(deviceId: string): Promise<CameraModePresetRead> {
    const view = await this.readModeDeviceView(this.clientFor(deviceId))
    return { view, matchedPresetIds: cameraModeMatchedPresetIds(view) }
  }

  /**
   * 应用一个应用模式预设。
   *
   * 顺序（**每一步都是手册说的**）：
   *   1. 先读当前声学 + 成像配置 —— 既是为了 `before`，也是为了知道哪些字段
   *      本来就不存在（那种字段不写）；
   *   2. 只写预设**声明**的字段（`PUT /system/acoustic` + `PUT /system/image`，
   *      手册标 non-essential，支持部分字段）；
   *   3. **重读**两份配置 —— 本设备有 `ret:200` 却完全不生效的先例
   *      （`PUT /alarm_strategy {Switch:1}`），所以成功码不是证据；
   *   4. 逐字段给出 `{field, requested, before, after, applied}`。
   *
   * **不写 `energy_threshold`**：三个模式在手册里的推荐值都是同一句话
   * 「Set after observing ambient energy.」（`practical-guide.txt` 第 366 行等），
   * 预设里根本没有这个字段，所以预设路径永远碰不到它。
   *
   * 不碰 `work_mode`（这台设备**在做哪种应用**）：那是**另一个通道**
   * （`readWorkMode` / `writeWorkMode`，`GET`/`PUT /system`）。
   * 这条边界是双向的，两边都刻意不调用对方 —— 把客户的成像参数当成"切换应用模式"
   * 的副作用悄悄重写（或反过来），是那种当场看不出来、下次检测结果不对的惊喜。
   * 注：`/system` 端点此前被判定为"只能读"，该结论已被真机实测证伪（可读**也可写**），
   * 但它是**未文档化**的端点，与这里的成像参数写入没有关系。
   *
   * 本方法也不碰 `run_mode` 与告警策略启停 —— 它们是另外的通道。
   */
  async applyModePreset(deviceId: string, presetId: CameraModePresetId): Promise<CameraModePresetWriteResult> {
    const preset = cameraModePreset(presetId)
    if (!preset) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `未知的应用模式预设 id：${String(presetId)}`
      )
    }

    const requested: CameraModeRequestedValues = {
      acoustic: {
        // 手册单位就是 kHz，原样发出去，不做任何换算。
        lowerKhz: preset.values.band.lowerKhz,
        upperKhz: preset.values.band.upperKhz
      },
      imaging: {
        targetCount: preset.values.targetCount,
        ...(preset.values.imagingSensitivity !== undefined
          ? { imagingSensitivity: preset.values.imagingSensitivity }
          : {}),
        ...(preset.values.imagingEnhance !== undefined
          ? { imagingEnhance: preset.values.imagingEnhance }
          : {})
      }
    }

    const write = await this.writeModeValues(this.clientFor(deviceId), requested)
    const after = write.after
    return {
      ...write,
      kind: 'preset',
      presetId: preset.id,
      matches: cameraModeMatchesPreset(after, preset)
    }
  }

  /**
   * 还原：把**之前读到的**数值写回去（「撤销」路径）。
   *
   * 与预设路径共用实现，区别只有两点：要写什么由调用方给（都是设备读过的事实），
   * 以及 `kind` 是 `restore` 而不是 `preset`。
   *
   * 只还原 `requested` 里**确实有值**的字段：没读到的字段不补默认值 ——
   * 补一个数字就等于凭空改设备配置，比不还原更糟。
   * `energyThreshold` 允许出现在这里（唯一去处就是"写之前读到的那个值"），
   * 但预设路径永远不会传它。
   */
  async restoreModeValues(
    deviceId: string,
    values: CameraModeRequestedValues
  ): Promise<CameraModePresetWriteResult> {
    const write = await this.writeModeValues(this.clientFor(deviceId), values)
    return { ...write, kind: 'restore', matches: false }
  }

  /** 读一次「声学 + 成像」的事实（并行，两个接口互不依赖）。 */
  private async readModeDeviceView(client: CameraControlOperations): Promise<CameraModeDeviceView> {
    return (await this.readModeDeviceSnapshot(client)).view
  }

  /**
   * 读一次并同时交出**归一化视图**与**映射后的两份配置**。
   *
   * 为什么要两份：视图是给界面与逐字段比对用的扁平形状，而写请求的字段取舍要看
   * 原始读数（例如"设备本来就没回这个字段"）。两者来自同一次读，不重复请求。
   */
  private async readModeDeviceSnapshot(
    client: CameraControlOperations
  ): Promise<{ view: CameraModeDeviceView; acoustic: Fa371AcousticConfig; imaging: Fa371ImagingConfig }> {
    const [acousticDto, imagingDto] = await Promise.all([
      client.getAcousticConfig(),
      client.getImagingConfig()
    ])
    const acoustic = mapAcousticConfig(acousticDto)
    const imaging = mapImagingConfig(imagingDto)
    return { view: cameraModeDeviceView(acoustic, imaging), acoustic, imaging }
  }

  /**
   * 预设与还原共用的写路径：读 → 只写声明的字段 → 重读 → 逐字段比对。
   *
   * 拆出来是因为两条路径**必须**共用同一套"什么算生效"的判定：如果还原走另一份
   * 实现，两份 `applied` 迟早会说不同的话。
   */
  private async writeModeValues(
    client: CameraControlOperations,
    requested: CameraModeRequestedValues
  ): Promise<Omit<CameraModePresetWriteResult, 'kind' | 'matches'>> {
    const { view: before } = await this.readModeDeviceSnapshot(client)

    const acousticBody = buildAcousticWriteBody(requested.acoustic)
    const imagingBody = buildImagingWriteBody(requested.imaging)
    const hasAcoustic = Object.keys(acousticBody).length > 0
    const hasImaging = Object.keys(imagingBody).length > 0

    if (!hasAcoustic && !hasImaging) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        '没有可写的字段：预设或还原请求至少要给出一个数值'
      )
    }

    // 两条 PUT 串行发：它们各自很短，而设备是同一台，并发写只会让排查更难。
    if (hasAcoustic) await client.setAcousticConfig(acousticBody)
    if (hasImaging) {
      await client.setImagingConfig(imagingBody, {
        // 目标数量的键名歧义（§8.3 C2）交给客户端已有的候选机制，本服务不碰键名。
        ...(requested.imaging.targetCount !== undefined
          ? { targetCount: requested.imaging.targetCount }
          : {})
      })
    }

    const after = await this.readModeDeviceView(client)

    const acousticFields: CameraModeFieldResult[] = []
    if (requested.acoustic.lowerKhz !== undefined) {
      acousticFields.push(
        fieldResult('freq_down_limit', requested.acoustic.lowerKhz, before.lowerKhz, after.lowerKhz)
      )
    }
    if (requested.acoustic.upperKhz !== undefined) {
      acousticFields.push(
        fieldResult('freq_up_limit', requested.acoustic.upperKhz, before.upperKhz, after.upperKhz)
      )
    }

    const imagingFields: CameraModeFieldResult[] = []
    if (requested.imaging.targetCount !== undefined) {
      imagingFields.push(
        fieldResult('target_count', requested.imaging.targetCount, before.targetCount, after.targetCount)
      )
    }
    if (requested.imaging.imagingSensitivity !== undefined) {
      imagingFields.push(
        fieldResult(
          'imaging_sensitivity',
          requested.imaging.imagingSensitivity,
          before.imagingSensitivity,
          after.imagingSensitivity
        )
      )
    }
    if (requested.imaging.imagingEnhance !== undefined) {
      imagingFields.push(
        fieldResult(
          'imaging_enhance',
          requested.imaging.imagingEnhance,
          before.imagingEnhance,
          after.imagingEnhance
        )
      )
    }
    if (requested.imaging.energyThreshold !== undefined) {
      // 只有还原路径会走到这里，字段名刻意不在 `CameraModeFieldKey` 里：
      // 预设**不写**阈值，所以它不该出现在"预设改了哪些字段"的清单上。
      imagingFields.push({
        field: 'energy_threshold',
        requested: requested.imaging.energyThreshold,
        ...(before.energyThreshold !== undefined ? { before: before.energyThreshold } : {}),
        ...(after.energyThreshold !== undefined ? { after: after.energyThreshold } : {}),
        applied: fieldApplied(requested.imaging.energyThreshold, after.energyThreshold)
      })
    }

    const all = [...acousticFields, ...imagingFields]
    return {
      requested,
      before,
      after,
      acousticFields,
      imagingFields,
      applied: all.every((field) => field.applied)
    }
  }

  /** 读一次启用集合（私有：只做类型收窄，避免每处都写一遍）。 */
  private async clientEnabled(client: CameraControlOperations): Promise<CameraEnabledStrategyView> {
    return mapEnabledStrategyView(await client.getEnabledAlarmStrategies())
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 读取侧 id 可能是字符串；只有能无损解析成正整数时才可用于写入。 */
function parsePositiveId(raw: unknown): number | undefined {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) return undefined
  return value
}

/**
 * 域模型的声学数值 → `PUT /system/acoustic` 的请求体。
 *
 * **线上键名只出现在这里**（以及 `dto.ts`），域模型与界面都不认键名。
 * 值为 `undefined` 的字段**不进请求体**：手册标 non-essential 支持部分字段，
 * 而发一个 `undefined` 或补一个默认值都可能被设备当成"要改成这个"。
 *
 * 注意 `samplerate`（§8.3 C1）：它的单位与合法值互相矛盾，所以本服务**不主动
 * 改**采样率；还原路径若确实把读到的原值给了它，也只是原样搬回去。
 *
 * 实测（`192.168.110.235`，2026-09）：只发频带两个字段的 `PUT /system/acoustic`
 * 应答 `{"msg":"SUCCESS","ret":200}`，重读时设备原有的 `samplerate: 200000`
 * **原样还在** —— 也就是说部分字段写入不会把没发的字段清掉（`GET` 那一侧
 * 的 `samplerate` 与合法值 96000/132000 的矛盾见 §8.3 C1，与这件事无关）。
 * 这条实测是"预设只写它声明的字段"能否成立的前提。
 */
function buildAcousticWriteBody(values: CameraModeAcousticValues): Fa371AcousticWriteDto {
  const body: Fa371AcousticWriteDto = {}
  if (values.lowerKhz !== undefined) body.freq_down_limit = values.lowerKhz
  if (values.upperKhz !== undefined) body.freq_up_limit = values.upperKhz
  if (values.sampleRateRaw !== undefined) body.samplerate = values.sampleRateRaw
  return body
}

/**
 * 域模型的成像数值 → `PUT /system/image` 的请求体。
 *
 * **目标数量不在这里落键**：它的真实拼写（`target_number` vs `target_numbe`）
 * 在手册里就自相矛盾（§8.3 C2），由 `Fa371ApiClient.setImagingConfig` 的
 * `targetCount` 选项按 `DEFAULT_FA371_IMAGING_TARGET_KEY` 决定。
 * 本函数只放**没有歧义**的三个字段。
 *
 * 三个预设都不带 `energyThreshold`，所以预设路径下这个函数永远收不到它；
 * 只有还原路径可能把它搬回去（写之前读到的那个值）。
 */
function buildImagingWriteBody(values: CameraModeImagingValues): Fa371ImagingWriteDto {
  const body: Fa371ImagingWriteDto = {}
  if (values.energyThreshold !== undefined) body.energy_threshold = values.energyThreshold
  if (values.imagingSensitivity !== undefined) body.imaging_sensitivity = values.imagingSensitivity
  if (values.imagingEnhance !== undefined) body.imaging_enhance = values.imagingEnhance
  return body
}

/**
 * 造一条逐字段结果。
 *
 * `applied` 一律来自**重读**（`fieldApplied`），不来自成功码 —— 本设备的
 * `PUT /alarm_strategy {Switch:1}` 应答过 `ret:200` 而字段纹丝不动。
 * `before`/`after` 读不到时**不填**，而不是填 0：界面上"没读到"与"读到了 0"
 * 是两件事。
 */
function fieldResult(
  field: CameraModeAnyFieldKey,
  requested: number,
  before: number | undefined,
  after: number | undefined
): CameraModeFieldResult {
  return {
    field,
    requested,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    applied: fieldApplied(requested, after)
  }
}
