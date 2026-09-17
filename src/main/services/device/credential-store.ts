/**
 * Device credential storage (spec 14.1).
 *
 * Requirement: "本地凭据如需持久化，使用 Windows Credential Manager / DPAPI；
 * 不要明文存 SQLite."
 *
 * Implementation choice: Electron's `safeStorage`, which is the supported
 * cross-platform binding to exactly those OS facilities (DPAPI on Windows,
 * Keychain on macOS). Credentials are encrypted before they touch SQLite, so
 * the database file alone never yields a password.
 *
 * If the OS keyring is unavailable, we FAIL CLOSED and degrade to a memory-only
 * store for the session rather than silently writing plaintext.
 */

import { safeStorage } from 'electron'
import type { Database as SqliteDatabase } from 'better-sqlite3'
import { appLog } from '../logging/logger'

export interface DeviceCredential {
  username: string
  password: string
}

export interface CredentialStore {
  /** Whether secrets survive an app restart. */
  readonly persistent: boolean
  set(deviceId: string, credential: DeviceCredential): void
  get(deviceId: string): DeviceCredential | undefined
  delete(deviceId: string): void
  /** Storage key used for the credential, supporting legacy/per-device migration. */
  keys(): string[]
}

const KEY_PREFIX = 'credential.'
/** Shape stored in the settings table after encryption. */
interface StoredCredential {
  v: 1
  /** base64 of the OS-encrypted blob. */
  blob: string
  /** Username is kept outside the blob for display; it is not a secret. */
  username: string
}

/**
 * SQLite-backed credential store using OS-level encryption.
 * Falls back to `MemoryCredentialStore` when encryption is unavailable.
 */
export class SafeStorageCredentialStore implements CredentialStore {
  readonly persistent = true

  constructor(private readonly db: SqliteDatabase) {}

  static isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  set(deviceId: string, credential: DeviceCredential): void {
    const encrypted = safeStorage.encryptString(credential.password)
    const payload: StoredCredential = {
      v: 1,
      blob: encrypted.toString('base64'),
      username: credential.username
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(KEY_PREFIX + deviceId, JSON.stringify(payload))
  }

  get(deviceId: string): DeviceCredential | undefined {
    const row = this.db
      .prepare<[string], { value: string | null }>(`SELECT value FROM settings WHERE key = ?`)
      .get(KEY_PREFIX + deviceId)
    if (!row?.value) return undefined

    try {
      const parsed = JSON.parse(row.value) as StoredCredential
      if (parsed.v !== 1 || typeof parsed.blob !== 'string') return undefined
      const password = safeStorage.decryptString(Buffer.from(parsed.blob, 'base64'))
      return { username: parsed.username, password }
    } catch (error) {
      appLog().warn('Credential decrypt failed; treating device as unauthenticated', {
        deviceId,
        reason: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  delete(deviceId: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(KEY_PREFIX + deviceId)
  }

  keys(): string[] {
    const rows = this.db
      .prepare<[string], { key: string }>(`SELECT key FROM settings WHERE key LIKE ?`)
      .all(`${KEY_PREFIX}%`)
    return rows.map((row) => row.key.slice(KEY_PREFIX.length))
  }
}

/** Session-only fallback. Never writes a secret to disk. */
export class MemoryCredentialStore implements CredentialStore {
  readonly persistent = false
  private readonly store = new Map<string, DeviceCredential>()

  set(deviceId: string, credential: DeviceCredential): void {
    this.store.set(deviceId, credential)
  }

  get(deviceId: string): DeviceCredential | undefined {
    return this.store.get(deviceId)
  }

  delete(deviceId: string): void {
    this.store.delete(deviceId)
  }

  keys(): string[] {
    return [...this.store.keys()]
  }
}

/**
 * Pick the strongest available store and report the outcome so the UI can warn
 * the user that credentials will not be remembered.
 */
export function createCredentialStore(db: SqliteDatabase): {
  store: CredentialStore
  persistent: boolean
  reason?: string
} {
  if (SafeStorageCredentialStore.isAvailable()) {
    return { store: new SafeStorageCredentialStore(db), persistent: true }
  }
  appLog().warn(
    'OS encryption unavailable (safeStorage); credentials will be kept in memory for this session only'
  )
  return {
    store: new MemoryCredentialStore(),
    persistent: false,
    reason: 'OS_KEYRING_UNAVAILABLE'
  }
}
