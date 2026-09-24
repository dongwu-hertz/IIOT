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
 * 歧义的处理方式（2026-09-23 更新）
 * ---------------------------------------------------------------------------
 * `buildConditionWriteDto` 的目标 id 方式仍是**显式参数**（手册未给验证手段，
 * 默认值取自 `shared/domain/camera-alarm.ts` 的具名候选）。
 *
 * 诊断说明键名（§8.3 C22）**不再让操作员手选**：`createStrategy`/`updateStrategy`
 * 缺省走 `writeStrategyWithVerifiedKey` —— 按手册口径先选键、写入后**读回验证**、
 * 换候选重试并记住胜者。显式传 `options.diagnosisKey`（测试 / Protocol Lab）时
 * 仍照发不探测。
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
import { deviceLog } from '../../logging/logger'
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
  /**
   * 诊断说明键名的**显式覆盖**（§8.3 C22）：给了就照发，不做探测（测试与
   * Protocol Lab 用）。**不给时**（界面走这条路）：服务按手册口径先选默认键
   * （新建 `diagosisn` / 修改 `diagnosis`），写完后**读回验证**——文本原样回来
   * 即该键被设备接受；没回来就换候选重试、`both` 保底，并把胜者记住。
   * 操作员不再需要在界面里替设备猜键名（业主 2026-09-23）。
   */
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
 * `discharge_*` 是**只写**字段（§8.3 C26）。产品侧现在把“放电类型”定义为异常
 * 发生后的诊断结论，而不是告警成立的前置门槛，因此这里固定关闭 discharge 判据。
 * 这样 dB / 主频 / 频谱比对中的任意已启用异常条件仍可独立触发告警，后续再由
 * PRPD/诊断链路给出放电类型结论。
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
    discharge_switch: 0,
    discharge_logical_operator: 0,
    discharge_type: 0,
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
  /**
   * 每台相机**实测胜出**的诊断说明键（读回验证记住）。
   *
   * 键名探测每个设备一生只做一两次（第一次保存策略时），之后沿用手册口径 +
   * 这个胜者，不再重复写两遍。进程重启后重新探测一次 —— 探测的代价是一次额外
   * 的 PUT + GET，用它换"永远按设备实测行为写"是值得的。
   */
  private readonly resolvedDiagnosisKeys = new Map<string, CameraAlarmDiagnosisKeyStyle>()

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
    // 显式指定键名（测试/Protocol Lab）→ 照发不探测；否则走自动判定（读回验证）。
    if (options.diagnosisKey !== undefined) {
      const body = buildStrategyCreateDto(draft, { diagnosisKey: options.diagnosisKey })
      await this.clientFor(deviceId).createAlarmStrategy(body)
      return this.listStrategies(deviceId, 1)
    }
    return this.writeStrategyWithVerifiedKey(deviceId, draft, 'create')
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
    if (options.diagnosisKey !== undefined) {
      const body = buildStrategyUpdateDto(draft, id, { diagnosisKey: options.diagnosisKey })
      await this.clientFor(deviceId).updateAlarmStrategy(body)
      return this.listStrategies(deviceId, 1)
    }
    return this.writeStrategyWithVerifiedKey(deviceId, draft, 'update')
  }

  /**
   * 写策略并自动判定诊断说明键（§8.3 C22，2026-09-23 取代操作员手选）。
   *
   * 手册自身在这个键名上就是矛盾的：§5.1.23（新建）字段表写 `diagosisn`（笔误键，
   * 手册要求原样发送），§5.1.25（修改）写 `diagnosis`。设备到底认哪个，手册没说 ——
   * 但**读侧会带回诊断说明文本**（`mapAlarmStrategy` 认两个键），所以这件事可以
   * 用"写入 → 重读列表 → 看文本是否原样回来"实测出来，而不必让操作员在界面里
   * 替设备做协议选择题。
   *
   * 候选顺序：上次实测胜出的键 → 手册口径默认（新建 diagosisn / 修改 diagnosis）→
   * 另一个单键 → `both` 保底。验证通过即记住胜者；全部候选都没读回时如实返回
   * 最后一次写入后的列表（写入可能已生效，只是无法验证 —— 不假装知道）。
   *
   * 诊断说明为空时键名无关紧要，一次写入直接返回。
   */
  private async writeStrategyWithVerifiedKey(
    deviceId: string,
    draft: CameraAlarmStrategyDraft,
    mode: 'create' | 'update'
  ): Promise<Fa371AlarmStrategyPage> {
    const client = this.clientFor(deviceId)
    const diagnosis = draft.diagnosis.trim()
    // update 的 id 合法性由 buildStrategyUpdateDto 复验（同一道校验，不重复实现）。
    const id = mode === 'update' ? (draft.id as number) : undefined

    if (diagnosis === '') {
      const body =
        mode === 'create'
          ? buildStrategyCreateDto(draft, { diagnosisKey: 'diagosisn' })
          : buildStrategyUpdateDto(draft, id as number, { diagnosisKey: 'diagnosis' })
      if (mode === 'create') await client.createAlarmStrategy(body as Fa371AlarmStrategyCreateDto)
      else await client.updateAlarmStrategy(body as Fa371AlarmStrategyUpdateDto)
      return this.listStrategies(deviceId, 1)
    }

    const manualDefault: CameraAlarmDiagnosisKeyStyle = mode === 'create' ? 'diagosisn' : 'diagnosis'
    const other: CameraAlarmDiagnosisKeyStyle = manualDefault === 'diagosisn' ? 'diagnosis' : 'diagosisn'
    const candidates = [
      this.resolvedDiagnosisKeys.get(deviceId),
      manualDefault,
      other,
      'both'
    ].filter((key, index, list): key is CameraAlarmDiagnosisKeyStyle =>
      key !== undefined && list.indexOf(key) === index
    )

    /**
     * 新建第一次 POST 之后记下刚创建那条的 id：若键不对，后续候选改用 PUT **修正**
     * 这条策略，而不是再 POST 出一条同名副本（设备列表里堆重复策略比一次修正难看得多）。
     * 按 名称+等级+绑定条件 认这条策略，三个字段同时相同才动手，避免改到同名的另一条。
     */
    let createdId: number | undefined

    for (const key of candidates) {
      if (createdId === undefined) {
        await client.createAlarmStrategy(
          buildStrategyCreateDto(draft, { diagnosisKey: key }) as Fa371AlarmStrategyCreateDto
        )
      } else {
        await client.updateAlarmStrategy(
          buildStrategyUpdateDto(draft, createdId, { diagnosisKey: key }) as Fa371AlarmStrategyUpdateDto
        )
      }

      const match = await this.readBackStrategy(deviceId, draft, mode, createdId)
      if (match?.diagnosis === diagnosis) {
        if (this.resolvedDiagnosisKeys.get(deviceId) !== key) {
          this.resolvedDiagnosisKeys.set(deviceId, key)
          deviceLog().info('FA371 诊断说明键已按读回验证确定', { deviceId, diagnosisKey: key, mode })
        }
        return this.listStrategies(deviceId, 1)
      }
      if (createdId === undefined) {
        createdId = this.identifyCreatedStrategy(match, draft)
      }
      deviceLog().warn('FA371 诊断说明键未通过读回验证，尝试下一个候选', {
        deviceId,
        mode,
        diagnosisKey: key
      })
    }

    deviceLog().warn('FA371 诊断说明键全部候选均未读回（写入可能已生效但无法验证）', {
      deviceId,
      mode,
      tried: candidates
    })
    return this.listStrategies(deviceId, 1)
  }

  /**
   * 重读策略列表，找回刚写入的那条。
   *
   * 修改模式按 id 认；新建模式第一次读回按名称+等级+绑定条件认（新建没有 id 可拿，
   * §8.3 C22），并把它的 id 交出去供后续候选 PUT 修正。
   */
  private async readBackStrategy(
    deviceId: string,
    draft: CameraAlarmStrategyDraft,
    mode: 'create' | 'update',
    createdId: number | undefined
  ): Promise<Fa371AlarmStrategy | undefined> {
    const page = mapAlarmStrategyPage(await this.clientFor(deviceId).listAlarmStrategies(1))
    if (mode === 'update') {
      return page.items.find((item) => item.id !== undefined && Number(item.id) === Number(createdId ?? draft.id))
    }
    return page.items.find(
      (item) =>
        item.name === draft.name.trim() &&
        item.level === Math.trunc(draft.level) &&
        Number(item.alarmConditionId) === Number(draft.conditionId)
    )
  }

  /** 从读回匹配里取出整数 id（PUT 修正要用）；取不到就返回 undefined（后续候选会再 POST）。 */
  private identifyCreatedStrategy(
    match: Fa371AlarmStrategy | undefined,
    draft: CameraAlarmStrategyDraft
  ): number | undefined {
    const raw = match?.id
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
      deviceLog().warn('FA371 新建策略的读回 id 不是正整数，无法按 id 修正键名，后续候选将重新新建', {
        name: draft.name,
        rawId: raw
      })
      return undefined
    }
    return value
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
