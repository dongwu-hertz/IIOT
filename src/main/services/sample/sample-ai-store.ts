/**
 * AI 标注配置的持久化（`app_meta` + OS 加密的口令）。
 *
 * 与 `remembered-login-store.ts` 同一条纪律：**地址与模型名不是秘密**（明文放 `app_meta`），
 * **密钥是秘密**（`safeStorage` 加密后 base64 落盘；系统加密不可用时失败关闭 —— 只保存
 * 地址与模型，密钥一个字节都不写，并把"当前存不了密钥"如实报给界面）。
 *
 * ---------------------------------------------------------------------------
 * 多命名服务（业主追加：设置里「不同 AI 服务」）
 * ---------------------------------------------------------------------------
 * `app_meta` 现在的键位：
 *   - `sampleAi.services`   JSON 数组：`AiServiceEntry[]`（id/name/provider/endpoint/model）；
 *   - `sampleAi.activeId`   当前启用那条的 id（空串 = 全部不启用）；
 *   - `sampleAi.key.<id>`   每服务一条、safeStorage 加密的密钥。
 *
 * 「当前启用那一份」不再有自己的独立键 —— 它就是 `activeId` 指向的服务。渲染层样本页
 * 的旧三通道（STATUS/SAVE_CONFIG/LABEL）全部读写 active 服务，行为与单配置时代一致。
 *
 * **迁移**：读时若 `sampleAi.services` 不存在而旧单配置键（`sampleAi.endpoint`）存在，
 * 就把旧配置合成一条「默认服务」入列、设为 active、写回新键并删除旧键 —— 一次完成，
 * 不留双份真相。
 *
 * 这一层不做任何能力判断：`describeAiReadiness()` 在域层（纯函数、有单测），
 * 这里只读、写、加解密。
 */

import { safeStorage } from 'electron'
import {
  EMPTY_AI_CONFIG,
  isAcceptableAiEndpoint,
  newAiServiceId,
  normaliseAiEndpoint,
  normaliseAiServices,
  type AiServiceEntry,
  type SampleAiConfig
} from '@shared/domain/sample-ai'
import type { AppMetaRepository } from '../database/user-repository'
import { appLog } from '../logging/logger'

const SERVICES_KEY = 'sampleAi.services'
const ACTIVE_ID_KEY = 'sampleAi.activeId'
/**
 * 全局启用开关。**沿用旧单配置的键名**：迁移前后它就是同一个布尔，旧代码写的值
 * 直接成为新语义下的开关，不需要搬。
 */
const ENABLED_KEY = 'sampleAi.enabled'
const LEGACY_ENDPOINT_KEY = 'sampleAi.endpoint'
const LEGACY_MODEL_KEY = 'sampleAi.model'
const LEGACY_API_KEY_KEY = 'sampleAi.apiKey'

function keyOf(serviceId: string): string {
  return `sampleAi.key.${serviceId}`
}

/** 一条服务的密钥状态（"盘上有没有"与"这次解没解开"分开）。 */
export interface StoredAiKeyState {
  stored: boolean
  /** 解出来的密钥；没有或解不开就是 `undefined`。 */
  value?: string
}

export interface StoredAiSettings {
  services: AiServiceEntry[]
  /** 当前选用的服务 id；空串 = 没选任何服务。 */
  activeId: string
  /** 全局启用开关（旧单配置的 `enabled` 键，迁移前后同一个）。 */
  enabled: boolean
  /** 每服务一条密钥状态（map 里没有的 id = 没存过）。 */
  keys: Record<string, StoredAiKeyState>
  encryptionAvailable: boolean
}

/** 兼容旧单配置读法：`SampleAiLabelService` 只关心 active 服务。 */
export interface StoredActiveAi {
  config: SampleAiConfig
  apiKey?: string
  apiKeyStored: boolean
  encryptionAvailable: boolean
}

/** 保存服务时对密钥的三种意图（与旧 `SaveAiSettingsInput.apiKey` 同一语义）。 */
export interface SaveAiServiceInput {
  /** 更新时给；新增不传。 */
  id?: string
  name: string
  endpoint: string
  model: string
  /** `undefined` = 不动已存的密钥；`null` 或空串 = 清除。 */
  apiKey?: string | null
}

export class SampleAiStore {
  constructor(private readonly meta: AppMetaRepository) {}

  static isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** 读完整库（服务列表 + activeId + 每服务密钥状态）。迁移在这一步完成。 */
  read(): StoredAiSettings {
    this.migrateLegacySingleConfig()
    const encryptionAvailable = SampleAiStore.isEncryptionAvailable()
    const rawServices = this.meta.get(SERVICES_KEY)
    let services: AiServiceEntry[] = []
    if (rawServices !== undefined) {
      try {
        const parsed: unknown = JSON.parse(rawServices)
        const normalised = normaliseAiServices(parsed)
        if (normalised.issues.length > 0) {
          appLog().warn('AI 服务库存在非法条目，已丢弃', { issues: normalised.issues })
        }
        services = normalised.services
      } catch {
        appLog().warn('AI 服务库 JSON 损坏，按空库处理')
      }
    }
    const storedActiveId = this.meta.get(ACTIVE_ID_KEY) ?? ''
    const activeId = services.some((service) => service.id === storedActiveId) ? storedActiveId : ''
    const keys: Record<string, StoredAiKeyState> = {}
    for (const service of services) {
      keys[service.id] = this.readKey(service.id, encryptionAvailable)
    }
    return {
      services,
      activeId,
      enabled: this.meta.get(ENABLED_KEY) === 'true',
      keys,
      encryptionAvailable
    }
  }

  /** 兼容旧调用：active 服务的单配置视图（`SampleAiLabelService` 用）。 */
  readActive(): StoredActiveAi {
    const stored = this.read()
    const active = stored.services.find((service) => service.id === stored.activeId)
    if (!active) {
      return {
        config: { ...EMPTY_AI_CONFIG },
        apiKeyStored: false,
        encryptionAvailable: stored.encryptionAvailable
      }
    }
    const keyState = stored.keys[active.id]
    return {
      config: { enabled: stored.enabled, endpoint: active.endpoint, model: active.model },
      ...(keyState?.value !== undefined ? { apiKey: keyState.value } : {}),
      apiKeyStored: keyState?.stored === true,
      encryptionAvailable: stored.encryptionAvailable
    }
  }

  /**
   * 新增/更新一条命名服务。返回 { id, error }：error 非空 = 拒绝（地址不合法、重名 id
   * 不存在、库已满）。写之前先校验 —— 一个不合法的地址存进去之后，界面每次都要重新
   * 解释"为什么按钮是灰的"，而错误本该在保存那一刻就被挡住。
   */
  saveService(input: SaveAiServiceInput): { id: string; error?: string } {
    const endpoint = normaliseAiEndpoint(input.endpoint)
    if (endpoint === '' || !isAcceptableAiEndpoint(endpoint)) {
      return { id: '', error: 'AI 接口地址必须以 http:// 或 https:// 开头' }
    }
    const name = input.name.trim()
    if (name === '') return { id: '', error: '服务名称不能为空' }
    const model = input.model.trim()

    const stored = this.read()
    const isUpdate = typeof input.id === 'string' && input.id !== ''
    if (isUpdate && !stored.services.some((service) => service.id === input.id)) {
      return { id: '', error: '要更新的服务不存在' }
    }
    if (!isUpdate && stored.services.length >= 20) {
      return { id: '', error: 'AI 服务数量已达上限' }
    }

    const id = isUpdate ? (input.id as string) : newAiServiceId()
    const next: AiServiceEntry[] = isUpdate
      ? stored.services.map((service) =>
          service.id === id ? { ...service, name, endpoint, model } : service
        )
      : [...stored.services, { id, name, provider: 'custom', endpoint, model }]
    this.writeServices(next, stored.activeId)

    if (input.apiKey !== undefined) {
      const key = input.apiKey === null ? '' : input.apiKey
      if (key === '') {
        this.meta.remove(keyOf(id))
      } else if (!SampleAiStore.isEncryptionAvailable()) {
        // 失败关闭：不写明文。调用方会从 stored=false 看出这次没存上。
        this.meta.remove(keyOf(id))
        appLog().warn('系统加密不可用，拒绝保存 AI 服务密钥')
      } else {
        try {
          this.meta.set(keyOf(id), safeStorage.encryptString(key).toString('base64'))
        } catch (error) {
          this.meta.remove(keyOf(id))
          appLog().warn('保存 AI 服务密钥失败', {
            reason: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    return { id }
  }

  /** 删除一条服务（连同它的密钥——真删除，不留密文等下一次密钥可用）。 */
  deleteService(id: string): boolean {
    const stored = this.read()
    if (!stored.services.some((service) => service.id === id)) return false
    const services = stored.services.filter((service) => service.id !== id)
    // 删的是当前选用项：回落到第一条；库里空了就是空串（照实说"没有选用任何服务"）。
    const activeId = stored.activeId === id ? (services[0]?.id ?? '') : stored.activeId
    this.meta.remove(keyOf(id))
    this.writeServices(services, activeId)
    return true
  }

  /**
   * 选用哪条（空串 = 不选任何服务）。id 必须存在（或为空串）。
   *
   * 选用一条**同时打开全局开关**（「选它就是为了用它」）；取消选用（空串）不动开关——
   * 开关归 `enabled` 键管，两个语义分开，避免"取消选用"把用户明确开过的总开关偷关掉。
   */
  setActive(id: string): boolean {
    const stored = this.read()
    if (id !== '' && !stored.services.some((service) => service.id === id)) return false
    this.meta.set(ACTIVE_ID_KEY, id)
    if (id !== '') this.meta.set(ENABLED_KEY, 'true')
    return true
  }

  /**
   * 旧三通道（SAVE_CONFIG）的落点：改 active 服务的 endpoint/model/Key + 全局开关。
   *
   * **库里一条服务都没有时**（全新安装、用户还没进过设置页）：照用户这次填的内容
   * 创建一条「默认服务」并选用 —— 样本页表单是老入口，"填了却静默丢掉"是最坏的回归。
   */
  saveActiveConfig(input: {
    enabled: boolean
    endpoint: string
    model: string
    apiKey?: string | null
  }): void {
    const endpoint = normaliseAiEndpoint(input.endpoint)
    if (endpoint !== '' && !isAcceptableAiEndpoint(endpoint)) {
      throw new Error('AI 接口地址必须以 http:// 或 https:// 开头')
    }
    const stored = this.read()
    const existing = stored.services.find((service) => service.id === stored.activeId)
    let activeIdFinal: string
    if (!existing) {
      // 自动创建只在"真的填了地址"时发生：地址为空 = 用户想表达"没配置"，
      // 此时创建一条空服务条目反而会让列表里多出一行看不见意义的记录。
      if (endpoint === '') {
        this.meta.set(ENABLED_KEY, input.enabled ? 'true' : 'false')
        return
      }
      const created = {
        id: newAiServiceId(),
        name: '默认服务',
        provider: 'custom' as const,
        endpoint,
        model: input.model.trim()
      }
      activeIdFinal = created.id
      this.writeServices([...stored.services, created], activeIdFinal)
    } else {
      activeIdFinal = existing.id
      const services = stored.services.map((service) =>
        service.id === existing.id ? { ...service, endpoint, model: input.model.trim() } : service
      )
      this.writeServices(services, activeIdFinal)
    }
    if (input.apiKey !== undefined) {
      if (input.apiKey === null || input.apiKey === '') {
        this.meta.remove(keyOf(activeIdFinal))
      } else {
        this.saveKey(activeIdFinal, input.apiKey)
      }
    }
    // 全局开关照写（沿用旧键）：它与"选哪条"是两件事，互不牵连。
    this.meta.set(ENABLED_KEY, input.enabled ? 'true' : 'false')
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private readKey(serviceId: string, encryptionAvailable: boolean): StoredAiKeyState {
    const raw = this.meta.get(keyOf(serviceId))
    const stored = raw !== undefined && raw !== ''
    const state: StoredAiKeyState = { stored }
    if (!stored || !encryptionAvailable) return state
    try {
      const value = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      if (value !== '') state.value = value
    } catch (error) {
      // 解不开**不删**：可能只是这一次密钥环不可用。界面会看到 stored=true 但没有可用密钥。
      appLog().warn('AI 服务密钥解密失败', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    return state
  }

  private saveKey(serviceId: string, key: string): void {
    if (!SampleAiStore.isEncryptionAvailable()) {
      this.meta.remove(keyOf(serviceId))
      appLog().warn('系统加密不可用，拒绝保存 AI 服务密钥')
      return
    }
    try {
      this.meta.set(keyOf(serviceId), safeStorage.encryptString(key).toString('base64'))
    } catch (error) {
      this.meta.remove(keyOf(serviceId))
      appLog().warn('保存 AI 服务密钥失败', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private writeServices(services: AiServiceEntry[], activeId: string): void {
    this.meta.set(SERVICES_KEY, JSON.stringify(services))
    this.meta.set(ACTIVE_ID_KEY, activeId)
  }

  /**
   * 旧单配置 → 服务库的一次性迁移。只在本文件内做：外部永远看到新形状。
   *
   * `enabled` 键沿用（见 ENABLED_KEY 注释）：迁移只搬"选哪条 + 地址/模型/密钥"，
   * 开关原样保留。旧 `enabled=false` 也照实迁 —— 配置是用户的，开关状态不重置。
   */
  private migrateLegacySingleConfig(): void {
    if (this.meta.get(SERVICES_KEY) !== undefined) return
    const endpoint = this.meta.get(LEGACY_ENDPOINT_KEY)
    if (endpoint === undefined) {
      // 全新安装：把空库写下去，免得每次启动都走一遍迁移判断。
      this.writeServices([], '')
      return
    }
    const model = this.meta.get(LEGACY_MODEL_KEY) ?? ''
    const id = newAiServiceId()
    const services: AiServiceEntry[] = [
      { id, name: '默认服务', provider: 'custom', endpoint: endpoint.trim(), model: model.trim() }
    ]
    const legacyKey = this.meta.get(LEGACY_API_KEY_KEY)
    if (legacyKey !== undefined && legacyKey !== '') {
      if (SampleAiStore.isEncryptionAvailable()) {
        try {
          // 密文原样搬运（同机同用户，safeStorage 密文可以直接重存）。
          this.meta.set(keyOf(id), legacyKey)
        } catch {
          // 搬不动就算了：用户重填一次 Key 即可，配置本体已迁。
        }
      }
    }
    this.writeServices(services, id)
    this.meta.remove(LEGACY_ENDPOINT_KEY)
    this.meta.remove(LEGACY_MODEL_KEY)
    this.meta.remove(LEGACY_API_KEY_KEY)
    appLog().info('AI 标注配置已迁移为命名服务', {
      serviceId: id,
      enabled: this.meta.get(ENABLED_KEY) === 'true'
    })
  }
}
