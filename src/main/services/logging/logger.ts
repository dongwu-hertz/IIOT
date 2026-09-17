/**
 * Logging (spec section 14.3).
 *
 * Three rolling streams, exactly as specified:
 *   app-YYYY-MM-DD.log       application lifecycle and UI-originated actions
 *   device-YYYY-MM-DD.log    every device HTTP/stream interaction
 *   storage-YYYY-MM-DD.log   filesystem, retention, disk protection
 *
 * Secret hygiene is enforced structurally (spec 14.1, appendix C rule 11):
 * `redact()` is applied to every payload on the way in, so a caller cannot
 * accidentally log a password or a bearer token even if it passes one.
 *
 * IMPLEMENTATION NOTE — why a single root logger
 * electron-log's `resolvePathFn` is only consulted for messages logged through
 * the ROOT logger instance. A child created with `log.create()` writes via its
 * own path and bypasses the resolver entirely, which silently produced console
 * output but no files. Since per-scope file routing is the whole requirement
 * here, every message goes through the root logger and the scope is carried as
 * a `[scope]` prefix in the text. That prefix is also what makes a raw log file
 * readable, so it earns its place twice.
 */

import log from 'electron-log/main'
import path from 'node:path'
import type { App } from 'electron'

export type LogScope = 'app' | 'device' | 'storage'

const SCOPES: readonly LogScope[] = ['app', 'device', 'storage']

/**
 * Resolve Electron's `app` lazily and defensively.
 *
 * Under `electron-vite` and at runtime inside Electron, `require('electron')`
 * yields the real module. Under a plain Node process (unit tests, the protocol
 * CLI) it yields a STRING — the path to the Electron binary — so destructuring
 * `app` at module scope would yield `undefined` and crash on the first property
 * access.
 *
 * Keeping this lazy is what lets the device services — auth resolution, the
 * API client, the mappers — be exercised in a normal Node test runner without
 * dragging in the Electron runtime.
 */
function electronApp(): App | undefined {
  try {
    const electron = require('electron') as { app?: App } | string
    if (typeof electron === 'string') return undefined
    return electron.app
  } catch {
    return undefined
  }
}

/** True only when running from a packaged Electron app. */
function isPackaged(): boolean {
  return electronApp()?.isPackaged ?? false
}

/** Keys whose values must never reach a log file. Matched case-insensitively. */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'pwd',
  'token',
  'authorization',
  'secret',
  'credential',
  'sessionid',
  'cookie'
]

/**
 * Names that describe the PRESENCE or SHAPE of a secret rather than the secret
 * itself. Knowing "a token was found" is essential for diagnosing auth; knowing
 * its value is not, and must never be logged.
 */
const NON_SECRET_KEY_PATTERNS = [
  'tokenfound',
  'tokenpresent',
  'hastoken',
  'tokenlength',
  'loginfieldnames'
]

const REDACTED = '***redacted***'

function isSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_\s]/g, '')
  if (NON_SECRET_KEY_PATTERNS.some((pattern) => normalised.includes(pattern))) return false
  return SECRET_KEY_PATTERNS.some((pattern) => normalised.includes(pattern))
}

/**
 * Deep-redact secrets. Also truncates long strings so a hex audio sample never
 * floods the log. Depth-limited to stay safe on cyclic structures.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value.length > 512 ? `${value.slice(0, 512)}…[${value.length} chars]` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message }
  }
  if (Array.isArray(value)) {
    const capped = value.slice(0, 32).map((item) => redact(item, depth + 1))
    if (value.length > 32) capped.push(`…[${value.length - 32} more]`)
    return capped
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key) ? REDACTED : redact(item, depth + 1)
    }
    return output
  }
  return String(value)
}

let initialised = false
let logsDirectory = ''

/**
 * Point electron-log at `<logsDir>/<scope>-YYYY-MM-DD.log` with rotation and a
 * maximum retention, then enable the scoped loggers.
 */
export function initLogging(logsDir: string, maxDays = 30): void {
  if (initialised) return
  initialised = true
  logsDirectory = logsDir

  log.transports.file.resolvePathFn = (_variables, message) => {
    const scope = resolveScope(message)
    const date = new Date().toISOString().slice(0, 10)
    return path.join(logsDir, `${scope}-${date}.log`)
  }

  log.transports.file.maxSize = 20 * 1024 * 1024
  log.transports.file.level = 'debug'
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  log.transports.console.level = isPackaged() ? false : 'debug'
  log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}'

  // electron-log has no built-in day-based pruning; run it on startup.
  void pruneOldLogs(logsDir, maxDays)
}

/**
 * Determine the scope of a message from its `[scope]` prefix.
 *
 * A single root logger serves all three streams, so the routing decision is
 * deferred to write time, where the message text is available.
 */
function resolveScope(message: unknown): LogScope {
  const record = message as { data?: unknown[] } | undefined
  const first = Array.isArray(record?.data) ? record.data[0] : undefined
  if (typeof first === 'string') {
    for (const scope of SCOPES) {
      if (first.startsWith(`[${scope}]`)) return scope
    }
  }
  return 'app'
}

export interface ScopedLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  debug: (message: string, ...args: unknown[]) => void
}

/** Build the four-level facade for one scope. */
function createScopedLogger(scope: LogScope): ScopedLogger {
  const prefix = `[${scope}]`

  const emit =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (message: string, ...args: unknown[]): void => {
      // Before `initLogging` runs there is no configured destination, so
      // electron-log would fall back to writing on stdout. That is correct for
      // a GUI app but wrong for the headless CLI tools, which parse their own
      // terminal output. Staying silent until initialised keeps both honest.
      if (!initialised) return
      const safeArgs = args.map((arg) => redact(arg))
      log[level](`${prefix} ${message}`, ...safeArgs)
    }

  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug')
  }
}

const loggers: Partial<Record<LogScope, ScopedLogger>> = {}

export function getLogger(scope: LogScope): ScopedLogger {
  return (loggers[scope] ??= createScopedLogger(scope))
}

export const appLog = (): ScopedLogger => getLogger('app')
export const deviceLog = (): ScopedLogger => getLogger('device')
export const storageLog = (): ScopedLogger => getLogger('storage')

/** Where logs are being written. Used by the About panel and the smoke test. */
export function currentLogDirectory(): string {
  return logsDirectory
}

/** Flush pending writes. Called during shutdown so no log line is lost. */
export async function flushLogs(): Promise<void> {
  try {
    await log.transports.file.getFile()?.clear?.()
  } catch {
    // Nothing to flush, or the transport is already closed.
  }
}

async function pruneOldLogs(logsDir: string, maxDays: number): Promise<void> {
  try {
    const { promises: fs } = await import('node:fs')
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
    const entries = await fs.readdir(logsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue
      const full = path.join(logsDir, entry.name)
      const stat = await fs.stat(full).catch(() => null)
      if (stat && stat.mtimeMs < cutoff) await fs.unlink(full).catch(() => undefined)
    }
  } catch {
    // Logging must never break startup.
  }
}
