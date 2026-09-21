/**
 * 可插拔 AI 标注（业主 2026-09-16：「可以把 AI 大模型引入」）。
 *
 * ---------------------------------------------------------------------------
 * 这一层只做**纯函数**：能力判定、提示词、回复解析
 * ---------------------------------------------------------------------------
 * 同本仓库一贯的分工：判断在域层（有单测）、网络在服务层、界面只照结果说话。
 *
 * ---------------------------------------------------------------------------
 * 三条必须写死的规矩
 * ---------------------------------------------------------------------------
 * 1. **AI 给的是候选，不是真值**。落库时 `label_source = 'ai'`，而
 *    `isTrainable()` 只认 `'human'` —— 所以一条没有被人工确认的 AI 标签
 *    **不会**进训练集。这不是保守，是因为一个自己标自己训的模型会放大自己的错。
 * 2. **绝不覆盖人工标签**。人的判定是真值；覆盖它等于把已经确认过的东西改回猜测。
 *    设备弱标签**可以**被覆盖，但那要操作员**显式**勾选（那是破坏性的：位图信息会丢）。
 * 3. **没配置就说没配置**。`describeAiReadiness()` 给出具体原因（没开 / 没填地址 /
 *    地址不合法 / 没填模型），界面照它显示并禁用按钮 —— 绝不退化成"假装调用了一下"。
 *
 * ---------------------------------------------------------------------------
 * 送给模型的只有数值，没有音频
 * ---------------------------------------------------------------------------
 * 请求体里是那 7 维特征、设备自身的弱标签、来源与时间，**不含音频**。理由有两条：
 * 一是把音频塞进请求要 base64 编码，一次几十兆，而接口形状取决于对面的服务；
 * 二是设备报的这 7 维本来就是它自己的特征口径，传原始波形反而让第三方模型去猜
 * 一个我们没定义过的预处理。这条边界如果以后要改，改的应该是这一层的文档。
 */

import type { SampleMetrics } from './sample-library'
import { SAMPLE_FEATURE_METRICS, normaliseSampleLabel } from './sample-library'

/** 一处配置。密钥**不在**这个对象里：它是秘密，单独走 OS 加密存（见主进程的 store）。 */
export interface SampleAiConfig {
  enabled: boolean
  /** 兼容 OpenAI `/chat/completions` 的完整地址，例如 `https://host/v1/chat/completions`。 */
  endpoint: string
  model: string
}

export const EMPTY_AI_CONFIG: SampleAiConfig = { enabled: false, endpoint: '', model: '' }

/** 一次最多标多少条：这是个**外部服务**，一次几百条既慢又容易被对面的限额挡住。 */
export const SAMPLE_AI_MAX_BATCH = 50

/** 单次请求超时（毫秒）。外部服务的慢不该把主进程拖住。 */
export const SAMPLE_AI_TIMEOUT_MS = 20_000

/** 提示词版本：写进日志用，便于事后知道"这批标签是哪一版提示词给的"。 */
export const SAMPLE_AI_PROMPT_VERSION = 1

export type AiBlockedReason = 'disabled' | 'no-endpoint' | 'bad-endpoint' | 'no-model'

export interface AiReadiness {
  ready: boolean
  reason?: AiBlockedReason
}

/** 地址合法：http(s) 且不是空的。这一条与"能不能连通"是两件事，这里只判前者。 */
export function isAcceptableAiEndpoint(value: string): boolean {
  const text = value.trim()
  if (text === '') return false
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 规整地址：去空白、去尾斜杠。**不补全**路径 —— 补一个猜出来的路径比报错更糟。 */
export function normaliseAiEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** 能不能用，以及不能用的**具体**原因（界面照它说，而不是笼统地灰着）。 */
export function describeAiReadiness(config: SampleAiConfig): AiReadiness {
  if (!config.enabled) return { ready: false, reason: 'disabled' }
  if (config.endpoint.trim() === '') return { ready: false, reason: 'no-endpoint' }
  if (!isAcceptableAiEndpoint(config.endpoint)) return { ready: false, reason: 'bad-endpoint' }
  if (config.model.trim() === '') return { ready: false, reason: 'no-model' }
  return { ready: true }
}

/** 提示词里的一条消息。与 OpenAI 的形状一致，但不 import 任何网络类型。 */
export interface AiChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 送给模型的那一条样本（**只有数值与元数据**，见文件头）。 */
export interface AiLabelInput {
  deviceName?: string
  channelIndex: number
  capturedAt: number
  metrics: SampleMetrics
  /** 设备位图给的**弱标签**（故障那一维）；没有就不传。它来自设备，不是上一轮 AI 的猜测。 */
  deviceLabel?: string
  /** 上一轮 AI 已经给过的**故障类型**候选（让模型可以沿用同一个说法，而不是每次换个同义词）。 */
  previousFaultLabel?: string
  /** 上一轮 AI 已经给过的**设备类型**候选。 */
  previousEquipmentLabel?: string
}

const SYSTEM_PROMPT = [
  '你是旋转机械与电气设备的声学故障诊断助手。只能依据给出的特征数值与设备自身的告警判定，给出**设备类型**与**故障类型**两个标签。',
  '规则：',
  '1. 只输出一个 JSON 对象，不要任何解释性文字，不要代码块标记。',
  '2. `equipment_label` 是这台设备装在什么设备上（如「电力变压器」「开关柜」「电机」），`fault_label` 是故障类别（如「局部放电」「轴承故障」）。两者都不超过 12 个汉字。',
  '3. 若「现有设备类型」/「现有故障类型」里有语义相同的，直接沿用它的写法；都不合适时给出新短语。',
  '4. 缺失的数值表示该维度**没有测到**，不要当成 0，也不要据此下结论。',
  '5. 特征不足以判断时，对应的标签用「未知」。',
  '输出格式：{"equipment_label":"...","fault_label":"...","confidence":0.0,"rationale":"..."}，其中 confidence 是 0~1 的小数，rationale 是一句不超过 30 字的中文理由。'
].join('\n')

/**
 * 建提示词。
 *
 * 数值按 `SAMPLE_FEATURE_METRICS` 的固定顺序输出，并且**缺的维度写 `null`**：
 * 与数据集导出同一条口径 —— 缺失必须能看出来是缺失，不能看起来像一个 0。
 *
 * 两个维度各给一份"现有清单"：模型沿用已有写法比每次造一个新词重要得多，
 * 而两张词表的写法必须与库里**完全一致**，否则同一个类别会被它拆成两个。
 */
export function buildLabelMessages(
  input: AiLabelInput,
  knownEquipmentLabels: string[] = [],
  knownFaultLabels: string[] = []
): AiChatMessage[] {
  const metrics: Record<string, number | null> = {}
  for (const metric of SAMPLE_FEATURE_METRICS) {
    const value = input.metrics[metric]
    metrics[metric] = typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  const payload: Record<string, unknown> = {
    captured_at: new Date(input.capturedAt).toISOString(),
    channel_index: input.channelIndex,
    metrics,
    device_label: input.deviceLabel ?? null,
    previous_fault_label: input.previousFaultLabel ?? null,
    previous_equipment_label: input.previousEquipmentLabel ?? null,
    existing_equipment_labels: knownEquipmentLabels.slice(0, 50),
    existing_fault_labels: knownFaultLabels.slice(0, 50)
  }
  if (input.deviceName !== undefined && input.deviceName !== '') payload.device_name = input.deviceName

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `样本（JSON）：\n${JSON.stringify(payload)}\n\n只回一个 JSON 对象。`
    }
  ]
}

/** 解析成功时的内容（单独一个形状，便于在函数里逐项往里填，而不是去改一个联合类型）。 */
export interface AiLabelSuccess {
  /** 故障类型（**必须**有：它是训练目标，没有它这条解析就没有意义）。 */
  faultLabel: string
  /** 设备类型（可选：模型可能说不出装在哪，那就不该编一个）。 */
  equipmentLabel?: string
  confidence?: number
  rationale?: string
}

/** 解析结果：要么给了可用的标签，要么说清为什么没用。 */
export type AiLabelParseResult =
  | ({ ok: true } & AiLabelSuccess)
  | { ok: false; reason: 'no-json' | 'no-label' | 'unknown-label' }

/** 模型自己给出"未知"时的标记：这不是一个类别，不该写进库里。 */
const UNKNOWN_LABELS = new Set(['未知', 'unknown', 'n/a', 'none', '无法判断'])

function isUnknownLabel(text: string): boolean {
  return UNKNOWN_LABELS.has(text) || UNKNOWN_LABELS.has(text.toLowerCase())
}

/**
 * 解析模型回复。
 *
 * 现实里模型经常把 JSON 包在 ```json 代码块里、或前后带一句话，所以先**取出第一个
 * 平衡的花括号片段**再解析，而不是要求整段就是 JSON（那会让"能用"的回复被丢掉）。
 * 但取不到 JSON、或取到的 JSON 里没有可用的**故障类型**时**报错**，不猜。
 *
 * 两个维度的宽容度**刻意不同**：
 *   - 故障类型必填（它是训练目标），且"未知"不算（写进去会多出一个假类）；
 *   - 设备类型**可选**：模型说不出装在哪很正常，那时就不写这一维，而不是编一个"未知"。
 */
export function parseLabelReply(text: string): AiLabelParseResult {
  const json = extractJsonObject(text)
  if (json === undefined) return { ok: false, reason: 'no-json' }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'no-json' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'no-json' }
  }

  const record = parsed as Record<string, unknown>
  // 兼容 `label` 这个旧字段名：换提示词之前配好的端点可能仍按旧格式回话。
  const faultLabel = normaliseSampleLabel(record.fault_label ?? record.label)
  if (faultLabel === undefined) return { ok: false, reason: 'no-label' }
  if (isUnknownLabel(faultLabel)) {
    // 「未知」是模型在说"判不了"，把它写成一个类别会让库多出一个假类。
    return { ok: false, reason: 'unknown-label' }
  }

  const success: AiLabelSuccess = { faultLabel }
  const equipmentLabel = normaliseSampleLabel(record.equipment_label ?? record.device_type)
  // 设备类型为空或"未知"就是没有这一维，不是错误。
  if (equipmentLabel !== undefined && !isUnknownLabel(equipmentLabel)) {
    success.equipmentLabel = equipmentLabel
  }

  const confidence = record.confidence
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    // 夹到 0~1：模型给 95 或 -1 都不该被当成概率用。
    success.confidence = Math.min(1, Math.max(0, confidence))
  }
  const rationale = record.rationale
  if (typeof rationale === 'string' && rationale.trim() !== '') {
    success.rationale = rationale.trim().slice(0, 200)
  }
  return { ok: true, ...success }
}

/** 取第一个**括号平衡**的 `{...}` 片段（跳过字符串里的花括号）。 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** 请求体（纯数据，便于单测断言形状）。 */
export function buildChatRequest(
  config: SampleAiConfig,
  messages: AiChatMessage[]
): Record<string, unknown> {
  return {
    model: config.model.trim(),
    messages,
    // 0 而不是默认值：标注要的是**可复现**，不是文采。
    temperature: 0,
    // 兼容接口里这是"请回 JSON"的标准字段；对面不支持时报错会走 `extractReplyText`。
    response_format: { type: 'json_object' }
  }
}

/** 从响应里取正文，并**分别**说清 HTTP 失败与形状不符。 */
export function extractReplyText(
  status: number,
  body: unknown
): { ok: true; text: string } | { ok: false; reason: string } {
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `HTTP ${status}${errorDetail(body)}` }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: '响应不是 JSON 对象' }
  }
  const choices = (body as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: '响应里没有 choices' }
  }
  const first = choices[0] as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, reason: '响应里没有正文' }
  }
  return { ok: true, text: content }
}

/** 把响应体里的错误信息摘出来（有就说，没有就算了）。 */
function errorDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const error = (body as Record<string, unknown>).error
  if (typeof error === 'string') return `：${error}`
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return `：${message}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// 命名的 AI 服务库（业主追加：设置里「不同 AI 服务」）
// ---------------------------------------------------------------------------

/** 库里最多存几条命名服务（与 GIS 服务库同一口径）。 */
export const MAX_AI_SERVICES = 20
/** 服务显示名长度上限。 */
export const MAX_AI_SERVICE_NAME = 64

/**
 * 常见厂家的 OpenAI 兼容预置（业主追加：设置里支持不同 AI 服务）。
 *
 * 全部走 `/chat/completions` 兼容协议 —— 与 `buildChatRequest()` 已经发出的请求形状
 * 一致，运行时**不按 provider 分支**：provider 只是保存预置名与「点选后填哪两个框」。
 * endpoint 都是完整地址（本软件不猜路径，见 `normaliseAiEndpoint()` 的注释）。
 *
 * 模型名写的是各家**当前文档里的入门档**：够用、便宜、限额宽；换更强模型改「模型」框即可。
 */
export const AI_SERVICE_PRESETS = [
  { id: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { id: 'deepseek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  { id: 'moonshot', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
  { id: 'zhipu', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash' },
  { id: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
  { id: 'ollama', endpoint: 'http://localhost:11434/v1/chat/completions', model: 'qwen2.5:7b' },
  { id: 'custom', endpoint: '', model: '' }
] as const
export type AiServicePresetId = (typeof AI_SERVICE_PRESETS)[number]['id']

export function isAiServicePreset(value: unknown): value is AiServicePresetId {
  return typeof value === 'string' && AI_SERVICE_PRESETS.some((preset) => preset.id === value)
}

/**
 * 一条**命名的** AI 服务（设置 → AI 服务库）。
 *
 * 与 GIS 服务库同一哲学：`SampleAiConfig` 是"**当前启用**的那一份"，`AiServiceEntry`
 * 是可命名保存、随时选用的备选库。条目不带 enabled（启用在选用那一刻发生），也**不带
 * 密钥** —— 密钥是秘密，按服务 id 单独走 OS 加密存储（`sampleAi.key.<id>`）。
 */
export interface AiServiceEntry {
  id: string
  name: string
  provider: AiServicePresetId
  endpoint: string
  model: string
}

/** 新条目 id。渲染层（添加）与主进程（迁移/兜底）都用它。 */
export function newAiServiceId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * 把任意输入归一化成 AI 服务库；坏条目**逐条丢弃**并记 issues（索引:问题码形状，
 * 与 `normaliseMapServices()` 同一套约定）。endpoint 用 `isAcceptableAiEndpoint()` 判
 * （http/https 且非空——空 endpoint 的条目存着没有意义）。
 */
export function normaliseAiServices(value: unknown): { services: AiServiceEntry[]; issues: string[] } {
  const empty = { services: [] as AiServiceEntry[], issues: [] as string[] }
  if (!Array.isArray(value)) return empty
  const services: AiServiceEntry[] = []
  const issues: string[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (services.length >= MAX_AI_SERVICES) {
      issues.push(`${index}:too-many`)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push(`${index}:shape`)
      continue
    }
    const record = raw as Record<string, unknown>
    const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
    if (endpoint === '' || !isAcceptableAiEndpoint(endpoint)) {
      issues.push(`${index}:bad-endpoint`)
      continue
    }
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_AI_SERVICE_NAME) : ''
    if (name === '' || name.length > MAX_AI_SERVICE_NAME) {
      issues.push(`${index}:bad-name`)
      continue
    }
    const entry: AiServiceEntry = {
      id:
        typeof record.id === 'string' && record.id.trim() !== ''
          ? record.id.trim()
          : newAiServiceId(),
      name,
      provider: isAiServicePreset(record.provider) ? record.provider : 'custom',
      endpoint: normaliseAiEndpoint(endpoint),
      model: typeof record.model === 'string' ? record.model.trim() : ''
    }
    if (seen.has(entry.id)) {
      issues.push(`${index}:duplicate-id`)
      continue
    }
    seen.add(entry.id)
    services.push(entry)
  }
  return { services, issues }
}
