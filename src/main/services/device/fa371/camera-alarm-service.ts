/**
 * FA371 告警模型的读写服务（§5.1.22 – §5.1.29）。
 *
 * ---------------------------------------------------------------------------
 * 职责划分
 * ---------------------------------------------------------------------------
 *   `dto.ts`            线上键名（含手册的笔误键 `diagosisn`、大写 `Times`/`Switch`）
 *   `mappers.ts`        读取侧：DTO -> 域模型（本服务直接用）
 *   **本文件**          写入侧：草稿 -> DTO，以及八个动作的编排
 *
 * 写入侧此前一直是缺的：客户端有 `createAlarmStrategy` 等方法，但没有任何地方
 * 把「界面上填的一组值」翻译成手册要求的请求体，也没有把手册明确写出的约束
 * （名称 1~20、等级写侧 1~4、检测周期 1~30 秒、灵敏度 0~1）在发出去之前拦一道。
 * 这里就是那道翻译 + 拦截，全部是可注入客户端的形式，因此**不需要真相机**也能测。
 *
 * ---------------------------------------------------------------------------
 * 不要把歧义「修掉」
 * ---------------------------------------------------------------------------
 * `buildStrategyCreateDto` 的 `diagnosisKey` 与 `buildConditionWriteDto` 的
 * 目标 id 方式都是**显式参数**，默认值取自 `shared/domain/camera-alarm.ts` 的
 * 具名候选（`diagosisn` / `id`）。手册没实测过哪一种设备认，所以本文件既不合并
 * 两个键名，也不悄悄补字段；切换候选是操作员在对话框里的显式动作。
 */

import { AppError, ErrorCodes } from '@shared/errors'
import {
  DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE,
  DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE,
  validateConditionDraft,
  validateStrategyDraft,
  type CameraAlarmConditionDraft,
  type CameraAlarmConditionIdStyle,
  type CameraAlarmDiagnosisKeyStyle,
  type CameraAlarmIssue,
  type CameraAlarmStrategyDraft
} from '@shared/domain/camera-alarm'
import type {
  Fa371AlarmCondition,
  Fa371AlarmConditionPage,
  Fa371AlarmStrategy,
  Fa371AlarmStrategyPage
} from '@shared/domain/fa371'
import { mapAlarmConditionPage, mapAlarmStrategyPage } from './mappers'
import type {
  Fa371AckDto,
  Fa371AlarmConditionPageDto,
  Fa371AlarmConditionWriteDto,
  Fa371AlarmStrategyCreateDto,
  Fa371AlarmStrategyPageDto,
  Fa371AlarmStrategyUpdateDto
} from './dto'

// ---------------------------------------------------------------------------
// 草稿 -> 请求体（纯函数）
// ---------------------------------------------------------------------------

function assertValid(issues: readonly CameraAlarmIssue[]): void {
  if (issues.length === 0) return
  throw new AppError(
    ErrorCodes.VALIDATION_ERROR,
    issues.map((issue) => issue.message).join('；'),
    issues.map((issue) => issue.field).join(',')
  )
}

export interface StrategyWriteOptions {
  /** 诊断说明落到哪个键（§8.3 C22 的三选一候选）。 */
  diagnosisKey?: CameraAlarmDiagnosisKeyStyle
}

/**
 * 新建策略的请求体（§5.1.23）。
 *
 * 键名刻意「不对称」，这是手册的原样：
 *   - 绑定条件用 `alarm_id`（读取侧才叫 `alarm_condition_id`）；
 *   - 序号用小写 `times`（读取侧是大写 `Times`）；
 *   - 诊断说明默认 `diagosisn`（笔误键，手册明确要求原样发送）。
 */
export function buildStrategyCreateDto(
  draft: CameraAlarmStrategyDraft,
  options: StrategyWriteOptions = {}
): Fa371AlarmStrategyCreateDto {
  assertValid(validateStrategyDraft(draft))
  const key = options.diagnosisKey ?? DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE

  const dto: Fa371AlarmStrategyCreateDto = {
    name: draft.name.trim(),
    alias: draft.alias.trim(),
    alarm_id: Number(draft.conditionId),
    level: Math.trunc(draft.level),
    interval_time: Math.trunc(draft.intervalTime),
    times: Math.trunc(draft.times),
    timeout_duration: Math.trunc(draft.timeoutDuration),
    // 灵敏度是 number（0~1），不取整。
    sensitivity: draft.sensitivity
  }

  const diagnosis = draft.diagnosis.trim()
  if (diagnosis !== '') {
    if (key === 'diagosisn' || key === 'both') dto.diagosisn = diagnosis
    if (key === 'diagnosis' || key === 'both') dto.diagnosis = diagnosis
  }
  return dto
}

/**
 * 修改策略的请求体（§5.1.25）：与新建同形，另加 `id`（integer）。
 *
 * 注意手册的一句话约束：**已启用的策略不能被修改**（设备以 `ret=-1` 拒绝）。
 * 本服务不预先拦它——「有没有启用」只有设备知道，凭界面上的旧值猜反而会拦住
 * 合法的修改；让设备的 `msg` 原样变成 `DEVICE_ERROR` 才是如实。
 */
export function buildStrategyUpdateDto(
  draft: CameraAlarmStrategyDraft,
  id: number,
  options: StrategyWriteOptions = {}
): Fa371AlarmStrategyUpdateDto {
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'PUT /alarm_strategy 需要一个整数 id；读取侧 id 可能是字符串（§8.3 C21），无法解析为整数时不能修改'
    )
  }
  return { ...buildStrategyCreateDto(draft, options), id }
}

/**
 * 新建/修改告警条件的请求体（§5.1.27 / §5.1.28，两节字段表相同）。
 *
 * 开关字段发 `0`/`1`（不是布尔）：手册字段表写的就是 0/1，`discharge_switch`
 * 的类型甚至标成 string，但取值同样是 `0`/`1`——发数字是最保守的共同解。
 * `discharge_*` 是**只写**字段（§8.3 C26），读取侧不会回它们，因此界面上标注
 * 「写后读不回」而不是假装能读回来。
 */
export function buildConditionWriteDto(
  draft: CameraAlarmConditionDraft
): Fa371AlarmConditionWriteDto {
  assertValid(validateConditionDraft(draft))
  return {
    name: draft.name.trim(),
    decibel_thr: draft.decibelThreshold,
    db_arithmetic_operator: Math.trunc(draft.dbOperator),
    db_switch: draft.dbSwitch ? 1 : 0,
    dominant_freq_thr: draft.dominantFreqThreshold,
    df_arithmetic_operator: Math.trunc(draft.dfOperator),
    df_switch: draft.dfSwitch ? 1 : 0,
    df_logical_operator: Math.trunc(draft.dfLogicalOperator),
    noise_comparison_file_id: Math.trunc(draft.noiseComparisonFileId),
    noise_comparison_thr: draft.ncSimilarityThreshold,
    nc_switch: draft.ncSwitch ? 1 : 0,
    nc_logical_operator: Math.trunc(draft.ncLogicalOperator),
    nc_arithmetic_operator: Math.trunc(draft.ncOperator),
    discharge_switch: draft.dischargeSwitch ? 1 : 0,
    discharge_logical_operator: Math.trunc(draft.dischargeLogicalOperator),
    discharge_type: Math.trunc(draft.dischargeType),
    notes: draft.notes.trim()
  }
}

/**
 * 读取侧的 `id` 归一化后是字符串（§8.3 C21），而 `PUT` 要求 integer。
 *
 * 只有当它能无损解析成正整数时才允许修改；否则如实拒绝，而不是发一个设备不认
 * 的形状然后报一个含糊的错误。
 */
export function strategyIdAsNumber(strategy: Pick<Fa371AlarmStrategy, 'id'>): number {
  const raw = strategy.id
  if (raw === undefined) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '该策略没有 id，无法修改（设备未回传 id）')
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `策略 id "${raw}" 不是整数，无法用于 PUT /alarm_strategy（§8.3 C21 的 id 类型冲突）`
    )
  }
  return value
}

/** 条件读取侧的 id 是 integer（§5.1.26），但同样只接受正整数。 */
export function conditionIdAsNumber(condition: Pick<Fa371AlarmCondition, 'id'>): number {
  const value = condition.id
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, '该告警条件没有可用的 id，无法修改或删除')
  }
  return value
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * 本服务需要的全部客户端能力。
 *
 * 结构化类型（而不是直接依赖 `Fa371ApiClient`）有两个好处：测试可以注入假客户端，
 * 且这里列出来的就是真正用到的八个接口——多一个都不依赖。
 */
export interface CameraAlarmOperations {
  listAlarmStrategies(page?: number): Promise<Fa371AlarmStrategyPageDto>
  createAlarmStrategy(body: Fa371AlarmStrategyCreateDto): Promise<Fa371AckDto>
  updateAlarmStrategy(body: Fa371AlarmStrategyUpdateDto): Promise<Fa371AckDto>
  deleteAlarmStrategies(ids: readonly number[]): Promise<Fa371AckDto>
  listAlarmConditions(page?: number): Promise<Fa371AlarmConditionPageDto>
  createAlarmCondition(body: Fa371AlarmConditionWriteDto): Promise<Fa371AckDto>
  updateAlarmCondition(
    body: Fa371AlarmConditionWriteDto,
    options?: { targetId?: number | string; idStyle?: CameraAlarmConditionIdStyle }
  ): Promise<Fa371AckDto>
  deleteAlarmConditions(ids: readonly number[]): Promise<Fa371AckDto>
}

export interface CameraAlarmServiceOptions {
  /** 取某台相机当前的 FA371 客户端（由 DeviceService 提供，含已解析的会话）。 */
  clientFor: (deviceId: string) => CameraAlarmOperations
  /** 诊断说明键名的默认候选（§8.3 C22）。 */
  diagnosisKey?: CameraAlarmDiagnosisKeyStyle
  /** `PUT /alarm_condition` 目标 id 方式的默认候选（§8.3 C25）。 */
  conditionIdStyle?: CameraAlarmConditionIdStyle
}

export class CameraAlarmService {
  private readonly clientFor: (deviceId: string) => CameraAlarmOperations
  readonly diagnosisKey: CameraAlarmDiagnosisKeyStyle
  readonly conditionIdStyle: CameraAlarmConditionIdStyle

  constructor(options: CameraAlarmServiceOptions) {
    this.clientFor = options.clientFor
    this.diagnosisKey = options.diagnosisKey ?? DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE
    this.conditionIdStyle = options.conditionIdStyle ?? DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE
  }

  // -- 读取（不加管理员校验：这是读，见 handlers.ts 的规则）----------------

  async listStrategies(deviceId: string, page = 1): Promise<Fa371AlarmStrategyPage> {
    const dto = await this.clientFor(deviceId).listAlarmStrategies(normalisePage(page))
    return mapAlarmStrategyPage(dto)
  }

  async listConditions(deviceId: string, page = 1): Promise<Fa371AlarmConditionPage> {
    const dto = await this.clientFor(deviceId).listAlarmConditions(normalisePage(page))
    return mapAlarmConditionPage(dto)
  }

  // -- 写入 ---------------------------------------------------------------

  async createStrategy(
    deviceId: string,
    draft: CameraAlarmStrategyDraft,
    options: StrategyWriteOptions = {}
  ): Promise<Fa371AlarmStrategyPage> {
    const body = buildStrategyCreateDto(draft, { diagnosisKey: options.diagnosisKey ?? this.diagnosisKey })
    await this.clientFor(deviceId).createAlarmStrategy(body)
    // 新建不返回 id（§8.3 C22），所以只能重读列表让操作员看到新策略。
    return this.listStrategies(deviceId, 1)
  }

  async updateStrategy(
    deviceId: string,
    draft: CameraAlarmStrategyDraft,
    options: StrategyWriteOptions = {}
  ): Promise<Fa371AlarmStrategyPage> {
    const id = draft.id
    if (id === undefined) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少要修改的策略 id')
    }
    const body = buildStrategyUpdateDto(draft, id, {
      diagnosisKey: options.diagnosisKey ?? this.diagnosisKey
    })
    await this.clientFor(deviceId).updateAlarmStrategy(body)
    return this.listStrategies(deviceId, 1)
  }

  async deleteStrategies(deviceId: string, ids: readonly number[]): Promise<Fa371AlarmStrategyPage> {
    assertIds(ids, '策略')
    await this.clientFor(deviceId).deleteAlarmStrategies(ids)
    return this.listStrategies(deviceId, 1)
  }

  async createCondition(
    deviceId: string,
    draft: CameraAlarmConditionDraft
  ): Promise<Fa371AlarmConditionPage> {
    await this.clientFor(deviceId).createAlarmCondition(buildConditionWriteDto(draft))
    return this.listConditions(deviceId, 1)
  }

  async updateCondition(
    deviceId: string,
    draft: CameraAlarmConditionDraft,
    options: { idStyle?: CameraAlarmConditionIdStyle } = {}
  ): Promise<Fa371AlarmConditionPage> {
    if (draft.id === undefined) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '缺少要修改的告警条件 id')
    }
    const idStyle = options.idStyle ?? this.conditionIdStyle
    const body = buildConditionWriteDto(draft)
    await this.clientFor(deviceId).updateAlarmCondition(body, {
      targetId: draft.id,
      // `'none'`（照字段表字面实现）由候选本身表达，不在这里替设备决定。
      idStyle
    })
    return this.listConditions(deviceId, 1)
  }

  async deleteConditions(deviceId: string, ids: readonly number[]): Promise<Fa371AlarmConditionPage> {
    assertIds(ids, '条件')
    await this.clientFor(deviceId).deleteAlarmConditions(ids)
    return this.listConditions(deviceId, 1)
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function normalisePage(page: number): number {
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.trunc(page)
}

function assertIds(ids: readonly number[], label: string): void {
  if (ids.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `请选择要删除的告警${label}`)
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, `告警${label} id 不合法：${String(id)}`)
    }
  }
}
