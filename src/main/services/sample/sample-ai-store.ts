/**
 * AI 标注配置的持久化（`app_meta` + OS 加密的口令）。
 *
 * 与 `remembered-login-store.ts` 同一条纪律：**地址与模型名不是秘密**（明文放 `app_meta`），
 * **密钥是秘密**（`safeStorage` 加密后 base64 落盘；系统加密不可用时失败关闭 —— 只保存
 * 地址与模型，密钥一个字节都不写，并把"当前存不了密钥"如实报给界面）。
 *
 * 这一层不做任何能力判断：`describeAiReadiness()` 在域层（纯函数、有单测），
 * 这里只读、写、加解密。
 */

import { safeStorage } from 'electron'
import {
  EMPTY_AI_CONFIG,
  isAcceptableAiEndpoint,
  normaliseAiEndpoint,
  type SampleAiConfig
} from '@shared/domain/sample-ai'
import type { AppMetaRepository } from '../database/user-repository'
import { appLog } from '../logging/logger'

const ENABLED_KEY = 'sampleAi.enabled'
const ENDPOINT_KEY = 'sampleAi.endpoint'
const MODEL_KEY = 'sampleAi.model'
const API_KEY_KEY = 'sampleAi.apiKey'

export interface StoredAiSettings {
  config: SampleAiConfig
  /** 解出来的密钥；没有或解不开就是 `undefined`。 */
  apiKey?: string
  /** 盘上**有没有**密文（与"这次解没解开"分开：密钥环暂时不可用时它仍是 true）。 */
  apiKeyStored: boolean
  encryptionAvailable: boolean
}

/** 保存时对密钥的三种意图。 */
export interface SaveAiSettingsInput {
  enabled: boolean
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

  read(): StoredAiSettings {
    const encryptionAvailable = SampleAiStore.isEncryptionAvailable()
    const config: SampleAiConfig = {
      enabled: this.meta.get(ENABLED_KEY) === 'true',
      endpoint: this.meta.get(ENDPOINT_KEY) ?? EMPTY_AI_CONFIG.endpoint,
      model: this.meta.get(MODEL_KEY) ?? EMPTY_AI_CONFIG.model
    }

    const raw = this.meta.get(API_KEY_KEY)
    const apiKeyStored = raw !== undefined && raw !== ''
    const result: StoredAiSettings = { config, apiKeyStored, encryptionAvailable }
    if (!apiKeyStored || !encryptionAvailable) return result

    try {
      const apiKey = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      if (apiKey !== '') result.apiKey = apiKey
    } catch (error) {
      // 解不开**不删**：可能只是这一次密钥环不可用。界面会看到 apiKeyStored=true 但没有可用密钥。
      appLog().warn('AI 标注密钥解密失败', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
    return result
  }

  /**
   * 写入。**先校验再写**：一个不合法的地址存进去之后，界面每次都要重新解释一遍
   * "为什么按钮是灰的"，而错误本该在保存的那一刻就被挡住。
   */
  save(input: SaveAiSettingsInput): void {
    const endpoint = normaliseAiEndpoint(input.endpoint)
    if (endpoint !== '' && !isAcceptableAiEndpoint(endpoint)) {
      throw new Error('AI 接口地址必须以 http:// 或 https:// 开头')
    }

    this.meta.set(ENABLED_KEY, input.enabled ? 'true' : 'false')
    this.meta.set(ENDPOINT_KEY, endpoint)
    this.meta.set(MODEL_KEY, input.model.trim())

    if (input.apiKey === undefined) return

    const key = input.apiKey === null ? '' : input.apiKey
    if (key === '') {
      this.meta.remove(API_KEY_KEY)
      return
    }

    if (!SampleAiStore.isEncryptionAvailable()) {
      // 失败关闭：不写明文。调用方会从 `read().apiKeyStored === false` 看出这次没存上。
      this.meta.remove(API_KEY_KEY)
      appLog().warn('系统加密不可用，拒绝保存 AI 标注密钥')
      return
    }

    try {
      this.meta.set(API_KEY_KEY, safeStorage.encryptString(key).toString('base64'))
    } catch (error) {
      appLog().warn('保存 AI 标注密钥失败', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
