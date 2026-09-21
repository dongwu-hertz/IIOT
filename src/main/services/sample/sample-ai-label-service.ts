/**
 * AI 标注服务：读配置 → 建提示词 → 调外部接口 → 按规矩落库。
 *
 * ---------------------------------------------------------------------------
 * 这一层只做三件事，判断在域层
 * ---------------------------------------------------------------------------
 * 「能不能用」是 `describeAiReadiness()`、「送什么」是 `buildLabelMessages()`、
 * 「回复怎么读」是 `parseLabelReply()` —— 全是纯函数、都有单测。这里只负责把它们
 * 串起来、发请求、写库。这样"AI 说了句没法解析的话"这种情形可以在没有网络的情况下测。
 *
 * ---------------------------------------------------------------------------
 * 覆盖规则（三条，按"谁更可信"排）
 * ---------------------------------------------------------------------------
 *   - `human`（人工确认过的真值）：**永不覆盖**，计数为 `skippedHuman`；
 *   - `device`（设备位图给的弱标签）：只有操作员**显式**勾了 `includeWeakLabelled`
 *     才覆盖 —— 那是破坏性的（位图信息会被一句猜测替换掉），所以默认跳过并计数；
 *   - `ai`（上一轮的候选）：可以覆盖，本来就是候选；
 *   - 没标签：直接写。
 *
 * 另外：AI 写进去的标签 `label_source` 恒为 `'ai'`，而 `isTrainable()` 只认 `'human'`，
 * 所以这批标签**不会**进训练集 —— 这条不需要在这里判断，域层已经保证了。
 *
 * ---------------------------------------------------------------------------
 * 网络：可注入的 fetch
 * ---------------------------------------------------------------------------
 * `fetchImpl` 是构造参数，默认用全局 `fetch`。测试里换成一个指向本地 http 服务的实现，
 * 于是"超时、非 200、choices 形状不对、正文里包了代码块"这些情形都能真的跑一遍。
 */

import {
  SAMPLE_AI_MAX_BATCH,
  SAMPLE_AI_PROMPT_VERSION,
  SAMPLE_AI_TIMEOUT_MS,
  buildChatRequest,
  buildLabelMessages,
  describeAiReadiness,
  extractReplyText,
  parseLabelReply,
  type SampleAiConfig
} from '@shared/domain/sample-ai'
import { aiLabel } from '@shared/domain/sample-library'
import type { Sample, SampleRepository } from '../database/sample-repository'
import type {
  SampleAiConfigInput,
  SampleAiLabelOutcome,
  SampleAiLabelRequest,
  SampleAiServiceInput,
  SampleAiServicesStatus,
  SampleAiStatus,
  SampleAiServiceSummary
} from '@shared/ipc/contract'
import type { SampleAiStore, StoredActiveAi } from './sample-ai-store'
import type { SampleLabelService } from './sample-label-service'
import { appLog } from '../logging/logger'

/** 最多留几条错误原文（多了界面读不完，而前几条就足够判断问题出在哪）。 */
const MAX_REPORTED_ERRORS = 5

/** 训练集一次取多少行来挑"还没人工标注的样本"。与 `SampleLibraryService` 同一个上限口径。 */
const SCAN_MAX_ITEMS = 5000

export interface SampleAiLabelOptions {
  samples: SampleRepository
  store: SampleAiStore
  /** 设备 id → 可读名字（设备可能已被删，所以可以缺席）。 */
  describeDevice: (deviceId: string) => { name?: string }
  /**
   * 标签库：两个维度的现有写法都要送给模型，AI 给出的新写法也要记进库
   * （否则人工确认时在输入框里选不到它，只能手打一遍）。
   */
  labels: SampleLabelService
  fetchImpl?: typeof fetch
}

export class SampleAiLabelService {
  private readonly samples: SampleRepository
  private readonly store: SampleAiStore
  private readonly describeDevice: (deviceId: string) => { name?: string }
  private readonly labels: SampleLabelService
  private readonly fetchImpl: typeof fetch

  constructor(options: SampleAiLabelOptions) {
    this.samples = options.samples
    this.store = options.store
    this.describeDevice = options.describeDevice
    this.labels = options.labels
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  status(): SampleAiStatus {
    return toStatus(this.store.readActive())
  }

  /**
   * 旧单配置写法的兼容层：写到 **active 服务**（endpoint/model/Key/enabled）。
   *
   * 样本页表单不改、通道不改，行为与单配置时代一致 —— "启用"开关并入 activeId：
   * 关 = 清空 activeId（配置保留），开 = 恢复指向该服务。
   */
  saveConfig(input: SampleAiConfigInput): SampleAiStatus {
    this.store.saveActiveConfig({
      enabled: input.enabled === true,
      endpoint: typeof input.endpoint === 'string' ? input.endpoint : '',
      model: typeof input.model === 'string' ? input.model : '',
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey })
    })
    return this.status()
  }

  // -------------------------------------------------------------------------
  // 命名的 AI 服务库（业主追加：设置里「不同 AI 服务」）
  // -------------------------------------------------------------------------

  /** 服务库 + active 服务就绪态（设置页 AI 页签的数据源）。 */
  servicesStatus(): SampleAiServicesStatus {
    const stored = this.store.read()
    const active = stored.services.find((service) => service.id === stored.activeId)
    // 就绪 = 全局开关开着 **且** active 服务本身配齐了。关了开关就照实说 'disabled'。
    const readiness = !stored.enabled
      ? ({ ready: false, reason: 'disabled' } as const)
      : active
        ? describeAiReadiness({ enabled: true, endpoint: active.endpoint, model: active.model })
        : ({ ready: false, reason: 'no-endpoint' } as const)
    const status: SampleAiServicesStatus = {
      services: stored.services.map(
        (service): SampleAiServiceSummary => ({
          id: service.id,
          name: service.name,
          provider: service.provider,
          endpoint: service.endpoint,
          model: service.model,
          apiKeyStored: stored.keys[service.id]?.stored === true
        })
      ),
      activeId: stored.activeId,
      encryptionAvailable: stored.encryptionAvailable,
      canStoreApiKey: stored.encryptionAvailable,
      ready: readiness.ready,
      promptVersion: SAMPLE_AI_PROMPT_VERSION,
      maxBatch: SAMPLE_AI_MAX_BATCH,
      timeoutMs: SAMPLE_AI_TIMEOUT_MS
    }
    if (!readiness.ready && 'reason' in readiness && readiness.reason !== undefined) {
      status.blockedReason = readiness.reason
    }
    return status
  }

  /** 新增/更新一条命名服务；不合法抛错（store 层给的原因照传给调用方）。 */
  saveService(input: SampleAiServiceInput): SampleAiServicesStatus {
    const result = this.store.saveService({
      ...(typeof input.id === 'string' && input.id !== '' ? { id: input.id } : {}),
      name: typeof input.name === 'string' ? input.name : '',
      endpoint: typeof input.endpoint === 'string' ? input.endpoint : '',
      model: typeof input.model === 'string' ? input.model : '',
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey })
    })
    if (result.error) throw new Error(result.error)
    return this.servicesStatus()
  }

  /** 删除一条服务（连同密钥）。删的是 active 由 store 回落，返回最新状态。 */
  deleteService(id: string): SampleAiServicesStatus {
    if (!this.store.deleteService(id)) throw new Error('要删除的服务不存在')
    return this.servicesStatus()
  }

  /** 选用哪条为当前启用（空串 = 全部不启用）。 */
  setActiveService(id: string): SampleAiServicesStatus {
    if (!this.store.setActive(id)) throw new Error('要选用的服务不存在')
    return this.servicesStatus()
  }

  /**
   * 给一批样本提候选标签。
   *
   * 没配置好就**抛错**而不是返回一个空的成功：界面在按钮禁用时就该拦住，能走到这里
   * 说明是别的调用方直接调的 —— 那时静默返回会让调用方以为"AI 看过了，没有可标的"。
   */
  async label(request: SampleAiLabelRequest = {}): Promise<SampleAiLabelOutcome> {
    const stored = this.store.readActive()
    const readiness = describeAiReadiness(stored.config)
    if (!readiness.ready) {
      throw new Error(`AI 标注未配置：${readiness.reason ?? 'unknown'}`)
    }
    const apiKey = stored.apiKey

    const candidates = this.pickCandidates(request)
    const includeWeakLabelled = request.includeWeakLabelled === true
    /**
     * 两张词表都给它：模型沿用库里的写法比每次造一个新词重要得多，而两个维度的写法
     * **必须与库里完全一致**，否则同一个类别会被它拆成两个。
     */
    const known = {
      equipment: this.labels.names('equipment'),
      fault: this.labels.names('fault')
    }

    const outcome: SampleAiLabelOutcome = {
      considered: candidates.length,
      requested: 0,
      labelled: 0,
      skippedHuman: 0,
      skippedWeak: 0,
      unresolved: 0,
      failed: 0,
      errors: []
    }

    for (const sample of candidates) {
      const existingFault = sample.faultLabel
      if (existingFault?.source === 'human') {
        outcome.skippedHuman += 1
        continue
      }
      if (existingFault?.source === 'device' && !includeWeakLabelled) {
        outcome.skippedWeak += 1
        continue
      }

      outcome.requested += 1
      const verdict = await this.askOne(stored.config, apiKey, sample, known)
      if (!verdict.ok) {
        if (verdict.kind === 'unresolved') outcome.unresolved += 1
        else {
          outcome.failed += 1
          if (outcome.errors.length < MAX_REPORTED_ERRORS) outcome.errors.push(verdict.reason)
        }
        continue
      }

      /**
       * 写的是**样本**，而不是标签库。
       *
       * 这一条是刻意的：标签库是**操作员的词表**，而 AI 给的是候选。让候选自动进词表，
       * 一个每次换一个同义词的模型就能把词表灌满噪声，而"标签库"这个功能的价值恰恰在于
       * 它是一份人工维护过的短清单。候选要进词表，走**确认**那一步（界面上把标签改成人工，
       * `SampleLibraryService.setLabel()` 会 `ensureLabel()`）。
       *
       * 写入顺序：故障类型先写（它是训练目标），设备类型只在模型真的给了时才写。
       */
      const writtenFault = this.samples.setLabel(sample.id, 'fault', aiLabel(verdict.faultLabel))
      /**
       * 设备类型那一维：模型**没提**时**不动**已有的那一格 ——
       * "这次没说"不等于"把人工标好的设备类型清掉"。
       */
      if (verdict.equipmentLabel !== undefined) {
        this.samples.setLabel(sample.id, 'equipment', aiLabel(verdict.equipmentLabel))
      }
      if (writtenFault) outcome.labelled += 1
      else outcome.failed += 1
    }

    appLog().info('AI 标注完成', {
      promptVersion: SAMPLE_AI_PROMPT_VERSION,
      considered: outcome.considered,
      requested: outcome.requested,
      labelled: outcome.labelled,
      skippedHuman: outcome.skippedHuman,
      skippedWeak: outcome.skippedWeak,
      unresolved: outcome.unresolved,
      failed: outcome.failed
    })
    return outcome
  }

  /**
   * 挑出这次要看的样本。
   *
   * 指定 `sampleIds` 时按给定的来（含人工标注的：操作员点名要看，我们就**看**，
   * 然后按规矩拒绝覆盖并计数）。
   *
   * 不指定时扫全库，取前 `maxBatch` 条**没有人工标签**的样本。这里**排除**人工标注的
   * 不是偷懒：一个上千条人工样本的库里，如果窗口按时间取前 50 条，那 50 条可能全是人工的，
   * 于是"标注一批"永远标不到任何东西。真正的判据在循环里（`skippedHuman`），
   * 这里的排除只是让窗口把配额花在**可能有活干**的样本上。
   */
  private pickCandidates(request: SampleAiLabelRequest): Sample[] {
    const limit = SAMPLE_AI_MAX_BATCH
    if (Array.isArray(request.sampleIds) && request.sampleIds.length > 0) {
      const picked: Sample[] = []
      for (const id of request.sampleIds.slice(0, limit)) {
        const sample = this.samples.findById(String(id))
        if (sample) picked.push(sample)
      }
      return picked
    }

    const { items } = this.samples.trainingRows(SCAN_MAX_ITEMS)
    const candidates: Sample[] = []
    for (const sample of items) {
      if (sample.faultLabel?.source === 'human') continue
      candidates.push(sample)
      if (candidates.length >= limit) break
    }
    return candidates
  }

  /** 问一条。**任何**失败都变成结果里的一个计数，绝不抛出去中断整批。 */
  private async askOne(
    config: SampleAiConfig,
    apiKey: string | undefined,
    sample: Sample,
    known: { equipment: string[]; fault: string[] }
  ): Promise<
    | { ok: true; faultLabel: string; equipmentLabel?: string }
    | { ok: false; kind: 'unresolved' | 'failed'; reason: string }
  > {
    const name = this.describeDevice(sample.deviceId).name
    const existingFault = sample.faultLabel
    const existingEquipment = sample.equipmentLabel
    /**
     * 提示位**必须分开**：`device_label` 是设备位图给的判定（故障那一维的事实），
     * 两个 `previous_*` 是上一轮模型的猜测。把猜测塞进"设备判定"那一格，
     * 会让模型把上一轮自己的话当成设备说的 —— 那是自证。
     */
    const messages = buildLabelMessages(
      {
        ...(name !== undefined ? { deviceName: name } : {}),
        channelIndex: sample.channelId,
        capturedAt: sample.capturedAt,
        metrics: sample.metrics,
        ...(existingFault?.source === 'device' ? { deviceLabel: existingFault.text } : {}),
        ...(existingFault?.source === 'ai' ? { previousFaultLabel: existingFault.text } : {}),
        ...(existingEquipment?.source === 'ai'
          ? { previousEquipmentLabel: existingEquipment.text }
          : {})
      },
      known.equipment,
      known.fault
    )

    let status = 0
    let body: unknown
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SAMPLE_AI_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(config.endpoint.trim(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey !== undefined && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(buildChatRequest(config, messages)),
        signal: controller.signal
      })
      status = response.status
      const text = await response.text()
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        kind: 'failed',
        reason: aborted ? `请求超时（${SAMPLE_AI_TIMEOUT_MS} ms）` : describeError(error)
      }
    } finally {
      clearTimeout(timer)
    }

    const extracted = extractReplyText(status, body)
    if (!extracted.ok) return { ok: false, kind: 'failed', reason: extracted.reason }

    const parsed = parseLabelReply(extracted.text)
    if (!parsed.ok) {
      // 模型自己说"未知"是**判不了**，不是失败：一次检修里出现几条很正常。
      const kind = parsed.reason === 'unknown-label' ? 'unresolved' : 'failed'
      return { ok: false, kind, reason: `回复无法解析（${parsed.reason}）` }
    }
    return {
      ok: true,
      faultLabel: parsed.faultLabel,
      ...(parsed.equipmentLabel !== undefined ? { equipmentLabel: parsed.equipmentLabel } : {})
    }
  }
}

/** 存储状态 → IPC 形状（**只**带"有没有密钥"，不带密钥）。 */
export function toStatus(stored: StoredActiveAi): SampleAiStatus {
  const readiness = describeAiReadiness(stored.config)
  const status: SampleAiStatus = {
    enabled: stored.config.enabled,
    endpoint: stored.config.endpoint,
    model: stored.config.model,
    apiKeyStored: stored.apiKeyStored,
    canStoreApiKey: stored.encryptionAvailable,
    ready: readiness.ready,
    promptVersion: SAMPLE_AI_PROMPT_VERSION,
    maxBatch: SAMPLE_AI_MAX_BATCH,
    timeoutMs: SAMPLE_AI_TIMEOUT_MS
  }
  if (readiness.reason !== undefined) status.blockedReason = readiness.reason
  return status
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  return String(error)
}
