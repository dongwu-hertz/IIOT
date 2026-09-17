/**
 * 账号权限的持久化（手册 §17.1 的权限复选框）。
 *
 * ---------------------------------------------------------------------------
 * 为什么权限**不**进 `settings` 表（也不进 `app_meta` 之外的任何地方）
 * ---------------------------------------------------------------------------
 * 权限是**账号的属性**，不是系统设置。而这一轮同时要实现手册 §17.2 的
 * 「一键恢复默认」——那句「restore the defaults of all the system configurations」
 * 的范围被收窄成「只重置系统设置项」。如果权限落在 `settings` 表里，
 * 一次「恢复默认」就会顺手把每个操作员被手工勾出来的权限抹掉；那是操作员看不见、
 * 也不会预期的一次权限变更。所以权限落在 `app_meta`（本装置的事实，与 install id
 * 同一张表），并且只由本文件读写。
 *
 * ---------------------------------------------------------------------------
 * 为什么是一个 `userId -> 权限键数组` 的 JSON，而不是一行一权限
 * ---------------------------------------------------------------------------
 * 一次勾选改动永远是**整体替换**（界面提交的是全量勾选态），所以按账户存一个数组
 * 正好是它的写入单位；拆成行则要在一个事务里删旧插新，还多出一套「半份权限」的
 * 中间态。未知键在读取时被丢掉（见 `readPermissionKeys`），因此旧版本写进去的
 * 权限名不会让新版本报错。
 *
 * 这里**不**存管理员的全权：管理员的权限永远由角色推出来（`normalisePermissionSet`），
 * 存一份反而会出现「库里写着没勾、实际却有」的分裂。
 */

import {
  USER_PERMISSION_KEYS,
  readPermissionKeys,
  type UserPermissionKey
} from '@shared/domain/auth'
import type { AppMetaRepository } from '../database/user-repository'
import { appLog } from '../logging/logger'

/** `app_meta` 里那一格的键名。 */
export const ACCOUNT_PERMISSIONS_META_KEY = 'account.permissions'

/** `userId -> 已勾选的权限`。没有条目的账户按角色的出厂默认处理。 */
export type AccountPermissionMap = Record<string, UserPermissionKey[]>

export class AccountPermissionStore {
  constructor(private readonly meta: AppMetaRepository) {}

  /** 全表，供界面一次性读出所有账户的权限。 */
  all(): AccountPermissionMap {
    const raw = this.meta.get(ACCOUNT_PERMISSIONS_META_KEY)
    if (!raw) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 坏 JSON 退化成「所有人都是出厂默认」，而不是让设置页打不开。
      appLog().warn('账号权限表不是合法 JSON，已按出厂默认权限处理')
      return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: AccountPermissionMap = {}
    for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const keys = readPermissionKeys(value)
      // 空数组也保留：它表示「这个操作员被明确地取消勾选了全部可选权限」，
      // 与「没有条目（用出厂默认）」是两件事。
      out[userId] = keys
    }
    return out
  }

  /** 一个账户已勾选的权限。`undefined` = 表里没有它（调用方回落到出厂默认）。 */
  forUser(userId: string): UserPermissionKey[] | undefined {
    const map = this.all()
    return Object.prototype.hasOwnProperty.call(map, userId) ? map[userId] : undefined
  }

  /** 整体替换一个账户的权限，并**读回**返回落库后的事实。 */
  set(userId: string, keys: readonly UserPermissionKey[]): UserPermissionKey[] {
    const map = this.all()
    // 按目录顺序去重，所以同一个勾选态写进去永远是同一串字节。
    const normalised = USER_PERMISSION_KEYS.filter((key) => keys.includes(key))
    map[userId] = [...normalised]
    this.persist(map)
    return this.forUser(userId) ?? []
  }

  /** 删除一个账户的条目（账户被删除时调用，避免留下孤儿权限）。 */
  remove(userId: string): void {
    const map = this.all()
    if (!Object.prototype.hasOwnProperty.call(map, userId)) return
    delete map[userId]
    this.persist(map)
  }

  private persist(map: AccountPermissionMap): void {
    this.meta.set(ACCOUNT_PERMISSIONS_META_KEY, JSON.stringify(map))
  }
}
