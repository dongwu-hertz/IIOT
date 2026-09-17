/**
 * Persistence for application accounts and installation metadata.
 *
 * The one rule this file exists to enforce: a password hash NEVER leaves here
 * except to the auth service that must verify it. `UserRecord` (with the hash) is
 * intentionally not the shape used across IPC — see `UserSummary` in
 * `shared/domain/auth.ts`.
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import { newDeviceId, now } from '@shared/utils/id'
import type { UserRole } from '@shared/domain/auth'

export interface UserRecord {
  id: string
  username: string
  displayName?: string
  role: UserRole
  /** Derived (scrypt), never reversible. See `auth-service.ts`. */
  passwordHash: string
  mustChangePassword: boolean
  lastLoginAt?: number
  createdAt: number
  updatedAt: number
}

interface UserRow {
  id: string
  username: string
  display_name: string | null
  role: string
  password_hash: string
  must_change_password: number
  last_login_at: number | null
  created_at: number
  updated_at: number
}

function toUser(row: UserRow): UserRecord {
  const user: UserRecord = {
    id: row.id,
    username: row.username,
    // The CHECK constraint guarantees this, but a value the union does not know
    // must not silently become an "admin" by accident of comparison: defaulting
    // to the LEAST privileged role means a corrupted row cannot grant rights.
    role: row.role === 'admin' ? 'admin' : 'operator',
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  if (row.display_name !== null) user.displayName = row.display_name
  if (row.last_login_at !== null) user.lastLoginAt = row.last_login_at
  return user
}

export class UserRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): UserRecord[] {
    return this.db
      .prepare<[], UserRow>(`SELECT * FROM users ORDER BY created_at ASC`)
      .all()
      .map(toUser)
  }

  count(): number {
    const row = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM users`).get()
    return row?.n ?? 0
  }

  findById(id: string): UserRecord | undefined {
    const row = this.db.prepare<[string], UserRow>(`SELECT * FROM users WHERE id = ?`).get(id)
    return row ? toUser(row) : undefined
  }

  /**
   * Lookup by name, case-insensitively.
   *
   * Matches the column's COLLATE NOCASE so that "who is logging in" and "is this
   * name taken" answer the same question. Looking up with `=` on a NOCASE column
   * is already case-insensitive in SQLite, but normalising here keeps the intent
   * visible and makes the behaviour independent of the schema detail.
   */
  findByUsername(username: string): UserRecord | undefined {
    const row = this.db
      .prepare<[string], UserRow>(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
      .get(username.trim())
    return row ? toUser(row) : undefined
  }

  adminCount(): number {
    const row = this.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
      .get()
    return row?.n ?? 0
  }

  insert(input: {
    username: string
    displayName?: string
    role: UserRole
    passwordHash: string
    mustChangePassword: boolean
  }): UserRecord {
    const id = newDeviceId().replace(/^dev_/, 'usr_')
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO users (
           id, username, display_name, role, password_hash, must_change_password,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.username.trim(),
        input.displayName?.trim() || null,
        input.role,
        input.passwordHash,
        input.mustChangePassword ? 1 : 0,
        timestamp,
        timestamp
      )
    const created = this.findById(id)
    if (!created) throw new Error(`User insert failed for ${input.username}`)
    return created
  }

  updatePassword(id: string, passwordHash: string, mustChangePassword: boolean): void {
    this.db
      .prepare(
        `UPDATE users
            SET password_hash = ?, must_change_password = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(passwordHash, mustChangePassword ? 1 : 0, now(), id)
  }

  updateProfile(id: string, input: { displayName?: string; role?: UserRole }): UserRecord | undefined {
    const existing = this.findById(id)
    if (!existing) return undefined
    this.db
      .prepare(
        `UPDATE users SET display_name = ?, role = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        input.displayName === undefined ? existing.displayName ?? null : input.displayName.trim() || null,
        input.role ?? existing.role,
        now(),
        id
      )
    return this.findById(id)
  }

  setLastLogin(id: string, timestamp = now()): void {
    this.db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).run(timestamp, id)
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0
  }
}

/** Key/value facts about this installation (not user preferences). */
export class AppMetaRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(key: string): string | undefined {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM app_meta WHERE key = ?`)
      .get(key)
    return row?.value
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  /**
   * 删掉一格。
   *
   * 加它是因为「记住密码」需要一个**真的删除**：过期或被用户取消勾选之后，那个加密过的
   * 口令不该继续留在库里等下一次密钥可用时被解出来（写空字符串会让"没有"与"空值"两种
   * 状态混在一起）。
   */
  remove(key: string): void {
    this.db.prepare(`DELETE FROM app_meta WHERE key = ?`).run(key)
  }
}
