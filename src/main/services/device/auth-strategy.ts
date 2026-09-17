/**
 * Device authentication strategy (spec 6.2 and risk item "登录 Token 携带方式").
 *
 * THE PROBLEM
 * The FA8 documentation states that `POST /login` returns a token, but it does
 * NOT define how subsequent requests must present that token. Guessing wrong
 * makes every other endpoint fail, and hard-coding a guess violates
 * appendix C rule 10 ("Authentication handling must remain configurable until
 * the real device token behavior is verified").
 *
 * THE DESIGN
 * Model the uncertainty explicitly instead of hiding it. A `DeviceAuthStrategy`
 * is a named, self-describing way to (a) perform login and (b) decorate a
 * request. Several candidates ship in the box; the correct one is DISCOVERED at
 * runtime by `AuthStrategyResolver` against a real device, then persisted.
 *
 * This keeps the rest of the codebase free of auth branches: services ask for
 * "the session for device X" and receive a decorator.
 */

import { createHash } from 'node:crypto'
import type { AppError } from '@shared/errors'
import type { DeviceCredential } from './credential-store'

/**
 * Fixed salt appended to the password before hashing.
 *
 * MEASURED, not inferred: the device's own web UI computes the login password as
 *   `md5(plaintext + 'lfxs')`
 * (recovered from its bundle, then confirmed by a successful login). Both the
 * algorithm and the salt are baked into the firmware.
 *
 * SECURITY NOTE: a fixed, client-visible salt provides no protection — it is a
 * protocol quirk, not a security control. It is documented here so nobody later
 * mistakes it for one. See `docs/PROTOCOL-FINDINGS.md` section 1.5.
 */
export const PASSWORD_SALT = 'lfxs'

/**
 * Derive the wire password: `md5(plaintext + 'lfxs')`, lowercase hex.
 *
 * Pure and synchronous, so it is trivially testable and safe to call per login.
 */
export function derivePassword(plaintext: string): string {
  return createHash('md5').update(`${plaintext}${PASSWORD_SALT}`, 'utf8').digest('hex')
}

/** Where the token is written on the wire. */
export type TokenCarrier =
  | { kind: 'header'; name: string; prefix: string }
  | { kind: 'query'; name: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'body'; name: string }

/** Why a strategy is or is not usable. Surfaced by the Protocol Lab. */
export interface AuthProbeOutcome {
  strategyId: string
  strategyLabel: string
  ok: boolean
  status?: number
  /** Best-effort explanation when ok === false. */
  reason?: string
  /** How long the authenticated call took, ms. */
  latencyMs?: number
}

export interface AuthStrategy {
  readonly id: string
  /** Human label shown in the Protocol Lab report. */
  readonly label: string
  /** Token carrier description, for diagnostics. */
  readonly carrier: TokenCarrier
  /**
   * The login request body. Devices differ on field names, so this is part of
   * the strategy rather than of the transport.
   */
  buildLoginBody(credential: DeviceCredential): Record<string, unknown>
  /** Which JSON field in the login response holds the token. `undefined` = try all. */
  readonly tokenFields: readonly string[]
  /** Extract a token from an arbitrary login response, or undefined. */
  extractToken(payload: unknown): string | undefined
  /** Extra headers the strategy always needs (e.g. a static API key header). */
  readonly staticHeaders?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalise a JSON field name for comparison.
 *
 * Field-name spelling varies across firmware revisions: `sessionid`,
 * `sessionId` and `session_id` are the same concept wearing three different
 * hats. Comparing normalised names keeps the alias list short while still
 * matching what a real device actually sends.
 */
function canonicalFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Search a login response for a token-ish string.
 *
 * The FA8 login payload shape is undocumented, so we search defensively:
 *   Pass 1 — the strategy's preferred field names, matched exactly.
 *   Pass 2 — the same names matched case/separator-insensitively.
 *   Pass 3 — generic token aliases, plus one level of envelope unwrapping.
 *
 * A token is never guessed from an ARBITRARY field: sending a status message as
 * an Authorization header would be worse than failing, because it produces a
 * confusing 401 instead of a clear "unrecognised login response".
 *
 * Depth-limited to avoid pathological payloads.
 */
export function findToken(
  payload: unknown,
  preferredFields: readonly string[],
  depth = 0
): string | undefined {
  if (payload === null || payload === undefined || depth > 4) return undefined

  if (typeof payload === 'string') {
    return payload.length > 0 && payload.length <= 4096 ? payload : undefined
  }

  if (typeof payload !== 'object') return undefined

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findToken(item, preferredFields, depth + 1)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  const canonicalPreferred = new Set(preferredFields.map(canonicalFieldName))

  // Pass 1: exact match on the strategy's preferred names.
  for (const field of preferredFields) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) return value
  }

  // Pass 2: normalised match, catching `session_id` vs `sessionId` and casing.
  // Field-name spelling is exactly the kind of thing an undocumented protocol
  // gets wrong, and a one-character difference must not look like an auth bug.
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (canonicalPreferred.has(canonicalFieldName(key))) return value
  }

  // Pass 3: generic aliases, plus one level of envelope unwrapping.
  const genericAliases = new Set([
    'token',
    'accesstoken',
    'authtoken',
    'sessionid',
    'sessiontoken',
    'sessionkey'
  ])

  /**
   * Container keys worth descending into.
   *
   * `msgBody` leads because it is the MEASURED envelope on real AE08 hardware:
   * the login response is `{message, msgBody:{token}, result}`, so a search that
   * does not unwrap `msgBody` reports "no token found" on a perfectly good
   * response — which then looks exactly like wrong credentials.
   */
  const containers = new Set(['msgbody', 'data', 'result', 'payload', 'body'])

  for (const [key, value] of Object.entries(record)) {
    const canonicalKey = canonicalFieldName(key)

    if (typeof value === 'string' && value.length > 0 && genericAliases.has(canonicalKey)) {
      return value
    }

    // Recurse only into plausible containers, never into arbitrary objects:
    // that is what keeps this from "finding" a token inside unrelated data.
    if (containers.has(canonicalKey)) {
      const nested = findToken(value, preferredFields, depth + 1)
      if (nested) return nested
    }
  }

  return undefined
}

/** Recursively list field names of a payload. Used by the Protocol Lab report. */
export function collectFieldNames(payload: unknown, depth = 0, into = new Set<string>()): string[] {
  if (depth > 4 || payload === null || typeof payload !== 'object') return [...into]
  if (Array.isArray(payload)) {
    for (const item of payload) collectFieldNames(item, depth + 1, into)
    return [...into]
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    into.add(key)
    collectFieldNames(value, depth + 1, into)
  }
  return [...into]
}

// ---------------------------------------------------------------------------
// Candidate strategies
// ---------------------------------------------------------------------------

/**
 * The candidate set, ordered by MEASURED likelihood rather than intuition.
 *
 * Every entry ahead of the right one costs a failed round trip on first contact
 * with a device, so the two carriers VERIFIED on AE08 firmware lead, with
 * `token-header` first because that is what the device's own web UI sends.
 *
 * `bearer-header` is retained — it is the common convention elsewhere and costs
 * nothing once the list is ordered this way — but it no longer sits in front of
 * the known-good answer. See docs/PROTOCOL-FINDINGS.md section 1.3.
 */
export const CANDIDATE_STRATEGIES: readonly AuthStrategy[] = [
  {
    id: 'token-header',
    label: 'token: <token>（AE08 实测首选）',
    carrier: { kind: 'header', name: 'token', prefix: '' },
    tokenFields: ['token', 'access_token'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['token', 'access_token'])
  },
  {
    id: 'raw-auth-header',
    label: 'Authorization: <token>（无 Bearer 前缀，AE08 亦接受）',
    carrier: { kind: 'header', name: 'Authorization', prefix: '' },
    tokenFields: ['token', 'access_token', 'accessToken'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['token', 'access_token', 'accessToken'])
  },
  {
    id: 'bearer-header',
    label: 'Authorization: Bearer <token>',
    carrier: { kind: 'header', name: 'Authorization', prefix: 'Bearer ' },
    tokenFields: ['token', 'access_token', 'accessToken'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['token', 'access_token', 'accessToken'])
  },
  {
    id: 'x-token-header',
    label: 'X-Token: <token>',
    carrier: { kind: 'header', name: 'X-Token', prefix: '' },
    tokenFields: ['token'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['token'])
  },
  {
    id: 'cookie-session',
    label: 'Cookie: session=<token>',
    carrier: { kind: 'cookie', name: 'session' },
    tokenFields: ['token', 'session', 'sessionid', 'sessionId'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['sessionid', 'sessionId', 'session', 'token'])
  },
  {
    id: 'query-token',
    label: '?token=<token>',
    carrier: { kind: 'query', name: 'token' },
    tokenFields: ['token'],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    extractToken: (payload) => findToken(payload, ['token'])
  },
  {
    id: 'body-credentials',
    label: '每次请求携带用户名密码（无 Token）',
    carrier: { kind: 'body', name: 'password' },
    tokenFields: [],
    buildLoginBody: (c) => ({ username: c.username, password: derivePassword(c.password) }),
    // Some firmware never issues a session; every call must carry credentials.
    extractToken: () => undefined
  }
]

export function findStrategy(id: string): AuthStrategy | undefined {
  return CANDIDATE_STRATEGIES.find((strategy) => strategy.id === id)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * An authenticated conversation with one device.
 * Immutable once created; the client swaps in a new session on re-login.
 */
export interface AuthSession {
  strategyId: string
  token?: string
  cookie?: string
  /** Credentials kept for strategies that re-send them (body-credentials). */
  credential?: DeviceCredential
  createdAt: number
}

export interface ApplyAuthResult {
  headers: Record<string, string>
  /** Query params to append, if the strategy carries the token in the URL. */
  query: Record<string, string>
  /** Body fields to merge, for credential-in-body firmware. */
  body?: Record<string, unknown>
}

/**
 * Decorate an outgoing request according to the session's strategy.
 * Pure and side-effect free, which is what makes it trivially testable.
 */
export function applyAuth(session: AuthSession, strategy: AuthStrategy): ApplyAuthResult {
  const headers: Record<string, string> = { ...(strategy.staticHeaders ?? {}) }
  const query: Record<string, string> = {}
  let body: Record<string, unknown> | undefined

  switch (strategy.carrier.kind) {
    case 'header': {
      if (session.token) {
        headers[strategy.carrier.name] = `${strategy.carrier.prefix}${session.token}`
      }
      break
    }
    case 'query': {
      if (session.token) query[strategy.carrier.name] = session.token
      break
    }
    case 'cookie': {
      if (session.cookie) {
        headers.Cookie = session.cookie
      } else if (session.token) {
        headers.Cookie = `${strategy.carrier.name}=${session.token}`
      }
      break
    }
    case 'body': {
      if (session.credential) {
        body = {
          username: session.credential.username,
          password: session.credential.password
        }
      }
      break
    }
  }

  return body ? { headers, query, body } : { headers, query }
}

/** Errors that mean "the token was rejected" and warrant a re-login. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}

export type { AppError }
