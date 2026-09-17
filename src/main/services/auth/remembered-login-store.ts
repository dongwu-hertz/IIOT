/**
 * 「记住上次的用户名 / 记住密码」的持久化（业主 2026-09-16）。
 *
 * ---------------------------------------------------------------------------
 * 为什么密码必须走 OS 加密，而不是渲染层的 localStorage
 * ---------------------------------------------------------------------------
 * 本仓库有一条既成的硬规则（spec 14.1）：「本地凭据如需持久化，使用 Windows Credential
 * Manager / DPAPI；**不要明文存 SQLite**」。设备口令就是照这条做的
 * （`device/credential-store.ts` 用 Electron 的 `safeStorage`）。账户口令是**更强的**一个
 * 秘密 —— 它拿着整个应用，所以只能走同一条路，不能图省事塞进 localStorage（那是明文）。
 *
 * 存的位置是 `app_meta`（本装置的事实，与 install id / 账号权限同一张表），值是
 * `safeStorage.encryptString()` 之后的 base64。
 *
 * ---------------------------------------------------------------------------
 * 系统加密不可用时**失败关闭**
 * ---------------------------------------------------------------------------
 * 与设备凭据同一条取舍：`safeStorage.isEncryptionAvailable()` 为假时**只记住用户名**，
 * 密码一个字节都不落盘（宁可让用户每次输密码，也不静默写明文）。这种情况下
 * `read()` 返回的 `persistent` 是 `false`，界面据此把勾选框禁掉并说明原因。
 *
 * ---------------------------------------------------------------------------
 * 到期判定不在这一层
 * ---------------------------------------------------------------------------
 * 「三个月」的规则在 `@shared/domain/remembered-login.ts` 的纯函数里（有单元测试）；
 * 这里只负责读/写/删与加解密。判据里"自动填充不续期"这一条尤其不能写错，所以它在那一边。
 */

import { safeStorage } from 'electron'
import {
  isRememberedPasswordUsable,
  nextRememberedAt
} from '@shared/domain/remembered-login'
import type { RememberLoginInput, RememberedLoginSnapshot } from '@shared/domain/auth'
import type { AppMetaRepository } from '../database/user-repository'
import { appLog } from '../logging/logger'

/** `app_meta` 里的两个键。用户名单独一格：它不是秘密，界面要能只读它。 */
const USERNAME_KEY = 'rememberedLogin.username'
const SECRET_KEY = 'rememberedLogin.secret'

/** 加密后的口令 + 它是**什么时候被亲手输入的**。 */
interface StoredSecret {
  v: 1
  /** `safeStorage.encryptString()` 结果，base64。 */
  blob: string
  /** 用户最后一次亲手输入这个密码的时刻（epoch ms）。 */
  rememberedAt: number
}

export class RememberedLoginStore {
  constructor(
    private readonly meta: AppMetaRepository,
    private readonly now: () => number = () => Date.now()
  ) {}

  static isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  read(): RememberedLoginSnapshot {
    const username = this.meta.get(USERNAME_KEY) ?? ''
    const persistent = RememberedLoginStore.isEncryptionAvailable()
    const raw = this.meta.get(SECRET_KEY)
    if (raw === undefined || raw === '') {
      return { username, expired: false, persistent }
    }

    const stored = this.parse(raw)
    if (!stored) {
      // 内容坏了（版本不符 / JSON 截断）：删掉它，别让它每次都失败一遍。
      this.meta.remove(SECRET_KEY)
      appLog().warn('记住的密码内容无法解析，已清除')
      return { username, expired: false, persistent }
    }

    if (!isRememberedPasswordUsable(stored.rememberedAt, this.now())) {
      // 过期 ⇒ **真的删掉**：留着它只是等下一次密钥可用时被解出来，与"三个月后重新输入"相悖。
      this.meta.remove(SECRET_KEY)
      appLog().info('记住的密码已过 90 天，已清除并要求重新输入')
      return { username, expired: true, persistent }
    }

    if (!persistent) {
      // 有密文但当前解不开（密钥环暂时不可用）。**不删**：可能只是这一次不可用。
      return { username, expired: false, persistent: false }
    }

    try {
      const password = safeStorage.decryptString(Buffer.from(stored.blob, 'base64'))
      return { username, expired: false, persistent: true, password }
    } catch (error) {
      appLog().warn('记住的密码解密失败，本次不预填', {
        reason: error instanceof Error ? error.message : String(error)
      })
      return { username, expired: false, persistent: false }
    }
  }

  remember(input: RememberLoginInput): void {
    // 用户名总是记住（产品要求：「记录上次的用户名」）。
    this.meta.set(USERNAME_KEY, input.username)

    if (!input.rememberPassword || !input.password) {
      // 没勾选框、或密码为空 ⇒ 清掉旧的密文。用户取消勾选必须真的失效，而不是留着旧密码。
      this.meta.remove(SECRET_KEY)
      return
    }

    if (!RememberedLoginStore.isEncryptionAvailable()) {
      // 失败关闭：不写明文。
      this.meta.remove(SECRET_KEY)
      appLog().warn('系统加密不可用，拒绝保存账户口令（只记住了用户名）')
      return
    }

    const previous = this.currentRememberedAt()
    const rememberedAt = nextRememberedAt(previous, this.now(), input.userTypedPassword)
    if (rememberedAt === undefined) {
      // 没有可沿用的时间，而这次又是自动填充 —— 不假装有记住时间。
      this.meta.remove(SECRET_KEY)
      return
    }

    try {
      const blob = safeStorage.encryptString(input.password).toString('base64')
      const payload: StoredSecret = { v: 1, blob, rememberedAt }
      this.meta.set(SECRET_KEY, JSON.stringify(payload))
      appLog().info('已记住登录密码', {
        username: input.username,
        refreshedWindow: input.userTypedPassword
      })
    } catch (error) {
      appLog().warn('保存账户口令失败', {
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  forget(): void {
    this.meta.remove(USERNAME_KEY)
    this.meta.remove(SECRET_KEY)
  }

  /** 当前存储里的记住时间；没有或坏了就是 `undefined`。 */
  private currentRememberedAt(): number | undefined {
    const raw = this.meta.get(SECRET_KEY)
    if (raw === undefined || raw === '') return undefined
    return this.parse(raw)?.rememberedAt
  }

  private parse(raw: string): StoredSecret | undefined {
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSecret>
      if (parsed.v !== 1 || typeof parsed.blob !== 'string') return undefined
      if (typeof parsed.rememberedAt !== 'number') return undefined
      return { v: 1, blob: parsed.blob, rememberedAt: parsed.rememberedAt }
    } catch {
      return undefined
    }
  }
}
