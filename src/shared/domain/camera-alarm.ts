/**
 * FA371 相机**告警模型**（告警策略 + 告警条件）的共享草稿类型、候选与校验。
 *
 * ---------------------------------------------------------------------------
 * 为什么有「草稿」这一层
 * ---------------------------------------------------------------------------
 * 设备侧的请求体（`Fa371AlarmStrategyCreateDto` 等）住在 `src/main/.../dto.ts`，
 * 渲染层看不到、也不该看到（进程边界）。但告警配置对话框必须能编辑这些字段，
 * 所以这里给出**与线上格式无关**的草稿模型：字段名用域语义（`conditionId`、
 * `timeoutDuration`），由主进程负责翻译成手册要求的线上键名与类型。
 *
 * ---------------------------------------------------------------------------
 * 手册的歧义：**建模，不修正**
 * ---------------------------------------------------------------------------
 * `docs/reference/FA371-api-spec.md` §5.1.22–§5.1.29 与 §6/§8.3 记录了一批
 * 冲突与缺口。它们不是「待修的 bug」，而是**未经实测的事实**：客户端已经把
 * 每一种可能建成具名候选（`diagosisn` / `diagnosis` / 两个都发；
 * `PUT /alarm_condition` 带 `id` / 不带 / 用 `alarm_condition_id`），
 * 界面要做的不是替设备猜一个，而是让操作员**看见哪一项未经验证**并能切换候选。
 * `CAMERA_ALARM_AMBIGUITIES` 就是那份清单的机器可读版本。
 */

// ---------------------------------------------------------------------------
// 候选（对应 main 侧 dto.ts 里的同名候选表）
// ---------------------------------------------------------------------------

/**
 * 写策略时「诊断说明」用哪个键（§8.3 C22，P0）。
 *
 * `POST /alarm_strategy` 的字段表写 `diagosisn`（手册明确要求按原样发送），
 * 而 `PUT /alarm_strategy` 写 `diagnosis`。同一个语义两个键名，手册没说设备是否
 * 两个都认，所以这是一个可切换的候选。
 */
export type CameraAlarmDiagnosisKeyStyle = 'diagosisn' | 'diagnosis' | 'both'

export const CAMERA_ALARM_DIAGNOSIS_KEY_STYLES: readonly CameraAlarmDiagnosisKeyStyle[] = [
  'diagosisn',
  'diagnosis',
  'both'
]

/** 默认沿用 `POST` 字面（手册明文）：`diagosisn`。 */
export const DEFAULT_CAMERA_ALARM_DIAGNOSIS_KEY_STYLE: CameraAlarmDiagnosisKeyStyle = 'diagosisn'

/**
 * `PUT /alarm_condition` 用什么方式指出「要改哪一条」（§8.3 C25，P0）。
 *
 * 手册这一节的请求字段表里**根本没有 `id`**，因此无法从手册得知目标标识方式。
 * 默认沿用 `PUT /alarm_strategy` 的先例（带 `id`），另外两种保留为候选。
 */
export type CameraAlarmConditionIdStyle = 'id' | 'none' | 'alarm_condition_id'

export const CAMERA_ALARM_CONDITION_ID_STYLES: readonly CameraAlarmConditionIdStyle[] = [
  'id',
  'alarm_condition_id',
  'none'
]

export const DEFAULT_CAMERA_ALARM_CONDITION_ID_STYLE: CameraAlarmConditionIdStyle = 'id'

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/** 一条告警策略的草稿（可新建、可编辑）。 */
export interface CameraAlarmStrategyDraft {
  /** 编辑现有策略时的设备侧 id；新建时为 `undefined`。 */
  id?: number
  /** 策略名，手册要求 1~20 字符。 */
  name: string
  alias: string
  /** 关联的告警条件 id（写入侧键名是 `alarm_id`，读取侧是 `alarm_condition_id`）。 */
  conditionId: number | null
  /**
   * 告警等级。
   *
   * §8.3 C21（P0）：**读侧字段表写 `0,1,2,3`、写侧写 `1,2,3,4`**。本软件不做
   * 任何静默偏移——写出去的就是这里填的值（1~4），读回来的原样显示。
   */
  level: number
  /** 两次告警之间的间隔长度（单位未说明，§8.3）。 */
  intervalTime: number
  /** 手册里的「序号」（写入侧小写 `times`，读取侧大写 `Times`）。 */
  times: number
  /** 检测周期，手册写明 1~30 秒。 */
  timeoutDuration: number
  /** 灵敏度 0~1。 */
  sensitivity: number
  /** 诊断说明；键名按上面的候选选择。 */
  diagnosis: string
}

/** 一条告警条件的草稿。三分支分别对应 dB / 主频 / 频谱比对。 */
export interface CameraAlarmConditionDraft {
  id?: number
  name: string
  /** dB 告警值（范围/单位手册未说明，§8.3 C28）。 */
  decibelThreshold: number
  /** `0`=>`>`、`1`=`<`、`2`=`=`、`3`=`>=`、`4`=`<=`（读侧字段表如此声明）。 */
  dbOperator: number
  dbSwitch: boolean
  /** 主频告警值（Hz 还是 kHz 手册未说明，§8.3 C28）。 */
  dominantFreqThreshold: number
  dfOperator: number
  dfSwitch: boolean
  /** 主频与 dB 之间的逻辑运算：`0` = `||`，`1` = `&&`。 */
  dfLogicalOperator: number
  /** 频谱比对的样本文件 id（由 `POST /upload_nc` 上传得到）。 */
  noiseComparisonFileId: number
  /** 相似度阈值 0~1。 */
  ncSimilarityThreshold: number
  ncSwitch: boolean
  ncLogicalOperator: number
  /** NC 算术运算符：写入侧明确只有 `0` = `>`、`1` = `<`。 */
  ncOperator: number
  /**
   * 放电判据三兄弟 —— **只存在于写入接口**（§8.3 C26，P0：读取侧字段表与
   * §4.4 的 UI 描述里都没有）。所以它们在界面上要标注「写后读不回」。
   */
  dischargeSwitch: boolean
  dischargeLogicalOperator: number
  /** `0` 电晕 / `1` 悬浮 / `2` 沿面 / `4` 放电（§8.3 C27：枚举**缺 `3`**）。 */
  dischargeType: number
  notes: string
}

export function emptyStrategyDraft(): CameraAlarmStrategyDraft {
  return {
    name: '',
    alias: '',
    conditionId: null,
    // 写侧取值是 1~4，默认给最低等级 1（而不是读侧的 0）。
    level: 1,
    intervalTime: 0,
    times: 1,
    timeoutDuration: 10,
    sensitivity: 0.5,
    diagnosis: ''
  }
}

export function emptyConditionDraft(): CameraAlarmConditionDraft {
  return {
    name: '',
    decibelThreshold: 0,
    dbOperator: 0,
    dbSwitch: false,
    dominantFreqThreshold: 0,
    dfOperator: 0,
    dfSwitch: false,
    dfLogicalOperator: 0,
    noiseComparisonFileId: 0,
    ncSimilarityThreshold: 0.8,
    ncSwitch: false,
    ncLogicalOperator: 0,
    ncOperator: 0,
    dischargeSwitch: false,
    dischargeLogicalOperator: 0,
    dischargeType: 0,
    notes: ''
  }
}

/** 从读取侧的域模型回填草稿（编辑用）。 */
export function strategyDraftFrom(draft: {
  id?: string
  name?: string
  alias?: string
  alarmConditionId?: number
  level?: number
  intervalTime?: number
  times?: number
  timeoutDuration?: number
  sensitivity?: number
  diagnosis?: string
}): CameraAlarmStrategyDraft {
  const base = emptyStrategyDraft()
  return {
    ...base,
    ...(draft.name !== undefined ? { name: draft.name } : {}),
    ...(draft.alias !== undefined ? { alias: draft.alias } : {}),
    conditionId: draft.alarmConditionId ?? null,
    // 读侧可能给 0（读侧枚举是 0~3），而写侧只接受 1~4。**不偏移**：原样带进
    // 草稿，由校验规则告诉操作员「这个级别在写侧不合法」——静默 +1 会把语义改掉。
    ...(draft.level !== undefined ? { level: draft.level } : {}),
    ...(draft.intervalTime !== undefined ? { intervalTime: draft.intervalTime } : {}),
    ...(draft.times !== undefined ? { times: draft.times } : {}),
    ...(draft.timeoutDuration !== undefined ? { timeoutDuration: draft.timeoutDuration } : {}),
    ...(draft.sensitivity !== undefined ? { sensitivity: draft.sensitivity } : {}),
    ...(draft.diagnosis !== undefined ? { diagnosis: draft.diagnosis } : {})
  }
}

// ---------------------------------------------------------------------------
// 校验（纯函数：主进程与对话框用同一份规则）
// ---------------------------------------------------------------------------

export interface CameraAlarmIssue {
  /** 草稿字段名，界面据此高亮输入框。 */
  field: string
  /** 目录键，界面用它本地化。 */
  messageKey: string
  /** 中文原文：主进程抛 `AppError` 时用（主进程没有目录）。 */
  message: string
}

/** 值必须是有限数字且在区间内；手册未给区间的字段不做臆测。 */
function rangeIssue(
  field: string,
  value: unknown,
  min: number,
  max: number,
  messageKey: string,
  message: string
): CameraAlarmIssue | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return { field, messageKey, message }
  }
  return undefined
}

/**
 * 策略草稿校验。
 *
 * 只校验**手册明确写了的**约束：名称 1~20、等级 1~4（写侧）、检测周期 1~30 秒、
 * 灵敏度 0~1、必须绑定一个条件。`interval_time` / `times` 的取值范围手册没写，
 * 因此只要求是非负有限数，不编造上限。
 */
export function validateStrategyDraft(draft: CameraAlarmStrategyDraft): CameraAlarmIssue[] {
  const issues: CameraAlarmIssue[] = []
  const name = draft.name.trim()
  if (name.length < 1 || name.length > 20) {
    issues.push({
      field: 'name',
      messageKey: 'cameraAlarmUi.issueName',
      message: '策略名必须为 1~20 个字符'
    })
  }
  if (draft.conditionId === null || !Number.isInteger(draft.conditionId) || draft.conditionId <= 0) {
    issues.push({
      field: 'conditionId',
      messageKey: 'cameraAlarmUi.issueCondition',
      message: '请选择该策略要绑定的告警条件（一条策略只能关联一个条件）'
    })
  }
  const level = rangeIssue(
    'level',
    draft.level,
    1,
    4,
    'cameraAlarmUi.issueLevel',
    '告警等级在写入侧只接受 1~4（读取侧文档写 0~3，两套取值不一致，本软件不做偏移）'
  )
  if (level) issues.push(level)
  const cycle = rangeIssue(
    'timeoutDuration',
    draft.timeoutDuration,
    1,
    30,
    'cameraAlarmUi.issueCycle',
    '检测周期必须为 1~30 秒'
  )
  if (cycle) issues.push(cycle)
  const sensitivity = rangeIssue(
    'sensitivity',
    draft.sensitivity,
    0,
    1,
    'cameraAlarmUi.issueSensitivity',
    '灵敏度必须为 0~1'
  )
  if (sensitivity) issues.push(sensitivity)
  const interval = rangeIssue(
    'intervalTime',
    draft.intervalTime,
    0,
    Number.MAX_SAFE_INTEGER,
    'cameraAlarmUi.issueInterval',
    '间隔时间必须是不小于 0 的整数'
  )
  if (interval) issues.push(interval)
  const times = rangeIssue(
    'times',
    draft.times,
    0,
    Number.MAX_SAFE_INTEGER,
    'cameraAlarmUi.issueTimes',
    '序号必须是不小于 0 的整数'
  )
  if (times) issues.push(times)
  return issues
}

/** 条件草稿校验：阈值范围手册未说明，只约束「至少打开一个判据」和相似度 0~1。 */
export function validateConditionDraft(draft: CameraAlarmConditionDraft): CameraAlarmIssue[] {
  const issues: CameraAlarmIssue[] = []
  const name = draft.name.trim()
  if (name.length < 1 || name.length > 64) {
    issues.push({
      field: 'name',
      messageKey: 'cameraAlarmUi.issueConditionName',
      message: '条件名称不能为空（不超过 64 个字符）'
    })
  }
  if (!draft.dbSwitch && !draft.dfSwitch && !draft.ncSwitch && !draft.dischargeSwitch) {
    issues.push({
      field: 'switches',
      messageKey: 'cameraAlarmUi.issueNoBranch',
      message: '四个判据（dB / 主频 / 频谱比对 / 放电）至少要打开一个，否则这条条件不会参与判定'
    })
  }
  const similarity = rangeIssue(
    'ncSimilarityThreshold',
    draft.ncSimilarityThreshold,
    0,
    1,
    'cameraAlarmUi.issueSimilarity',
    '噪声相似度必须为 0~1'
  )
  if (similarity) issues.push(similarity)
  if (![0, 1, 2, 4].includes(draft.dischargeType)) {
    issues.push({
      field: 'dischargeType',
      messageKey: 'cameraAlarmUi.issueDischargeType',
      message: '放电类型只定义了 0/1/2/4（手册缺 3），请选择已定义的取值'
    })
  }
  return issues
}

// ---------------------------------------------------------------------------
// 手册歧义清单（界面显式展示，不隐藏）
// ---------------------------------------------------------------------------

export type CameraAlarmAmbiguityId =
  | 'diagnosisKey'
  | 'conditionUpdateId'
  | 'levelRange'
  | 'strategySwitch'
  | 'dischargeFields'
  | 'thresholdUnits'
  | 'deleteBody'
  | 'createReturnsId'

export interface CameraAlarmAmbiguity {
  id: CameraAlarmAmbiguityId
  /** 标题目录键。 */
  labelKey: string
  /** 说明目录键（**必须**说清「未实测/手册未定义」，不能写成确定行为）。 */
  noteKey: string
  /** 该歧义对应的规格条目，界面上直接引用，便于对照手册。 */
  specRef: string
} 

/**
 * 手册没说清、且本软件**不替设备决定**的地方。
 *
 * 对话框把这些逐条列在「未验证项」区域：与其让操作员以为下拉框里的值是设备
 * 确认过的，不如直说它是候选。
 */
export const CAMERA_ALARM_AMBIGUITIES: readonly CameraAlarmAmbiguity[] = [
  {
    id: 'diagnosisKey',
    labelKey: 'cameraAlarmUi.ambiguityDiagnosisLabel',
    noteKey: 'cameraAlarmUi.ambiguityDiagnosisNote',
    specRef: '§5.1.23 / §5.1.25 / §8.3 C22'
  },
  {
    id: 'conditionUpdateId',
    labelKey: 'cameraAlarmUi.ambiguityConditionIdLabel',
    noteKey: 'cameraAlarmUi.ambiguityConditionIdNote',
    specRef: '§5.1.28 / §8.3 C25'
  },
  {
    id: 'levelRange',
    labelKey: 'cameraAlarmUi.ambiguityLevelLabel',
    noteKey: 'cameraAlarmUi.ambiguityLevelNote',
    specRef: '§5.1.22 / §5.1.23 / §8.3 C21'
  },
  {
    id: 'strategySwitch',
    labelKey: 'cameraAlarmUi.ambiguitySwitchLabel',
    noteKey: 'cameraAlarmUi.ambiguitySwitchNote',
    // 旧规格把"策略启停"记成缺口 C33（"开放接口里没有启停端点"），
    // 2026-09 的新手册第 340–346 行给出 `GET`/`PUT /alarm_strategy_enable`
    // 把它证伪了（更正见 `docs/FA371-API-DELTA.md` §1）。启停现在由
    // `camera-control-service.setStrategyEnabled` 实现，读侧 `Switch` 只是列表副本。
    specRef: 'api-workflow.txt §Enable/Disable Alarm Strategy（GET/PUT /alarm_strategy_enable）；旧 §8.3 C33 已更正'
  },
  {
    id: 'dischargeFields',
    labelKey: 'cameraAlarmUi.ambiguityDischargeLabel',
    noteKey: 'cameraAlarmUi.ambiguityDischargeNote',
    specRef: '§5.1.27 / §8.3 C26 / C27'
  },
  {
    id: 'thresholdUnits',
    labelKey: 'cameraAlarmUi.ambiguityUnitsLabel',
    noteKey: 'cameraAlarmUi.ambiguityUnitsNote',
    specRef: '§5.1.26 / §8.3 C28'
  },
  {
    id: 'deleteBody',
    labelKey: 'cameraAlarmUi.ambiguityDeleteLabel',
    noteKey: 'cameraAlarmUi.ambiguityDeleteNote',
    specRef: '§5.1.24 / §5.1.29 / §8.3 C24 / C29'
  },
  {
    id: 'createReturnsId',
    labelKey: 'cameraAlarmUi.ambiguityCreateIdLabel',
    noteKey: 'cameraAlarmUi.ambiguityCreateIdNote',
    specRef: '§5.1.23 / §8.3 C22'
  }
]
