/**
 * Auth strategy resolver — the answer to spec section 19, risk item #1.
 *
 * PROBLEM: `/login` returns a token, but the protocol does not say how the
 * token must be presented on subsequent requests. Guessing costs days.
 *
 * SOLUTION: probe. For each candidate carrier, the resolver
 *   1. calls POST /login,
 *   2. extracts a token,
 *   3. issues one authenticated request to a known endpoint (GET /get_devinfo),
 *   4. declares success only if that call returns a plausible device payload.
 *
 * The winning strategy id is persisted per device, so the cost is paid once.
 * Everything here is observable: the resolver returns a full report, which is
 * what the Protocol Lab screen renders and what a support engineer needs when
 * a new firmware revision changes behaviour.
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import {
  applyAuth,
  CANDIDATE_STRATEGIES,
  collectFieldNames,
  findStrategy,
  type AuthSession,
  type AuthStrategy
} from './auth-strategy'
import type { HttpTransport } from './http-transport'
import type { LoginResponseDto } from './protocol/dto'
import type { DeviceCredential } from './credential-store'
import { looksLikeHertzinnoDevice } from './protocol/mappers'

export interface ResolveAuthInput {
  baseUrl: string
  credential: DeviceCredential
  timeoutMs?: number
  /** Restrict probing to a known strategy (used after the first success). */
  preferredStrategyId?: string
  signal?: AbortSignal
}

export interface StrategyAttempt {
  strategyId: string
  strategyLabel: string
  carrier: string
  loginOk: boolean
  loginStatus?: number
  /** Whether a token was successfully extracted from the login response. */
  tokenFound: boolean
  /** Whether the follow-up authenticated request was accepted. */
  verifyOk?: boolean
  verifyStatus?: number
  latencyMs: number
  error?: string
}

export interface ResolveAuthResult {
  session: AuthSession
  strategy: AuthStrategy
  attempts: StrategyAttempt[]
  /** Field names seen in the login response, for protocol documentation. */
  loginFieldNames: string[]
}

/** Endpoint used to verify a candidate: read-only and universally supported. */
const VERIFY_PATH = '/get_devinfo'

export class AuthStrategyResolver {
  constructor(private readonly transport: HttpTransport) {}

  /**
   * Field names seen in the most recent `/login` response, even when resolution
   * FAILED. Preserved because a failed login that reports `{someVendorKey: ...}`
   * is exactly the evidence needed to extend the alias list — discarding it on
   * the error path would throw the diagnosis away along with the failure.
   */
  lastLoginFieldNames: string[] = []

  /**
   * Try the preferred strategy first (a cache from a previous run), then every
   * other candidate. Throws AUTH_FAILED when nothing works.
   */
  async resolve(input: ResolveAuthInput): Promise<ResolveAuthResult> {
    const timeoutMs = input.timeoutMs ?? 8_000
    const attempts: StrategyAttempt[] = []
    let lastError: AppError | undefined
    let loginFieldNames: string[] = []

    const ordered = orderStrategies(input.preferredStrategyId)

    for (const strategy of ordered) {
      const started = performance.now()
      const attempt: StrategyAttempt = {
        strategyId: strategy.id,
        strategyLabel: strategy.label,
        carrier: describeCarrier(strategy),
        loginOk: false,
        tokenFound: false,
        latencyMs: 0
      }

      try {
        const loginResponse = await this.transport.request({
          method: 'POST',
          url: `${input.baseUrl}/login`,
          // MEASURED: the device requires the credentials wrapped in `msgBody`.
          // Posting a bare `{username, password}` is rejected with
          // `{"message":"Incorrect username or password.","result":2}` — which
          // is indistinguishable from genuinely wrong credentials, making this
          // one of the most misleading differences between the spec and the
          // real device. The strategy supplies only the inner fields.
          json: { msgBody: strategy.buildLoginBody(input.credential) },
          timeoutMs,
          signal: input.signal,
          // Inspect the status ourselves: a 401 here is an expected outcome of
          // probing, not an exception.
          throwOnHttpError: false
        })

        attempt.loginStatus = loginResponse.status
        attempt.loginOk = loginResponse.status >= 200 && loginResponse.status < 300

        if (loginResponse.json && typeof loginResponse.json === 'object') {
          // Collect field names RECURSIVELY, not just the top level.
          //
          // The measured AE08 response is `{message, msgBody:{token}, result}`,
          // so a shallow `Object.keys` reports only `message, msgBody, result`
          // and hides the one field that matters. Those names are the evidence a
          // human uses to extend the alias list when a new firmware renames the
          // token field, so losing them defeats the purpose of collecting them.
          const names = collectFieldNames(loginResponse.json)
          if (names.length > loginFieldNames.length) {
            loginFieldNames = names
            // Also retained on the instance so a FAILED resolution still yields
            // the observed payload shape to the caller / Protocol Lab.
            this.lastLoginFieldNames = names
          }
        }

        if (!attempt.loginOk) {
          attempt.error = `login HTTP ${loginResponse.status}`
          attempt.latencyMs = Math.round(performance.now() - started)
          attempts.push(attempt)
          continue
        }

        const token = strategy.extractToken(loginResponse.json as LoginResponseDto)
        attempt.tokenFound = token !== undefined

        // A strategy that carries credentials in the body needs no token; every
        // other strategy is meaningless without one.
        if (strategy.carrier.kind !== 'body' && !token) {
          attempt.error = 'login succeeded but no token field was recognised'
          attempt.latencyMs = Math.round(performance.now() - started)
          attempts.push(attempt)
          continue
        }

        const cookie = extractCookie(loginResponse.headers['set-cookie'])
        const session: AuthSession = {
          strategyId: strategy.id,
          createdAt: Date.now(),
          credential: input.credential
        }
        if (token) session.token = token
        if (cookie) session.cookie = cookie

        const verified = await this.verify(session, strategy, input.baseUrl, timeoutMs, input.signal)
        attempt.verifyOk = verified.ok
        attempt.verifyStatus = verified.status
        attempt.latencyMs = Math.round(performance.now() - started)

        if (verified.ok) {
          deviceLog().info('Auth strategy resolved', {
            baseUrl: input.baseUrl,
            strategyId: strategy.id,
            carrier: attempt.carrier,
            latencyMs: attempt.latencyMs
          })
          attempts.push(attempt)
          return { session, strategy, attempts, loginFieldNames }
        }

        attempt.error = `authenticated ${VERIFY_PATH} returned ${verified.status}`
        attempts.push(attempt)
      } catch (error) {
        attempt.latencyMs = Math.round(performance.now() - started)
        attempt.error = error instanceof Error ? error.message : String(error)
        attempts.push(attempt)

        const appError = AppError.from(error)
        lastError = appError

        // A transport-level failure is not strategy-specific: if the device is
        // unreachable, trying five more carriers just wastes the user's time.
        if (
          appError.code === ErrorCodes.NETWORK_ERROR ||
          appError.code === ErrorCodes.TIMEOUT ||
          appError.code === ErrorCodes.DEVICE_OFFLINE
        ) {
          break
        }
      }
    }

    const detail = attempts
      .map((attempt) => `${attempt.strategyId}: ${attempt.error ?? 'rejected'}`)
      .join(' | ')

    deviceLog().warn('No auth strategy succeeded', { baseUrl: input.baseUrl, attempts })

    throw new AppError(
      lastError?.code === ErrorCodes.NETWORK_ERROR || lastError?.code === ErrorCodes.TIMEOUT
        ? lastError.code
        : ErrorCodes.AUTH_FAILED,
      '认证失败：所有 Token 携带方式均被设备拒绝',
      detail
    )
  }

  /** One authenticated read against VERIFY_PATH. */
  private async verify(
    session: AuthSession,
    strategy: AuthStrategy,
    baseUrl: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number }> {
    const auth = applyAuth(session, strategy)
    const url = buildUrl(baseUrl + VERIFY_PATH, auth.query)

    const response = await this.transport.request({
      method: 'GET',
      url,
      headers: auth.headers,
      timeoutMs,
      signal,
      throwOnHttpError: false
    })

    // A 2xx is necessary but not sufficient: a firmware that answers every
    // unauthenticated request with an empty 200 must not be mistaken for a
    // working session.
    //
    // AO01 MEASURED (2026-11-12): a wrong carrier returns HTTP 200
    // `{"message":"Token is invalid","result":1}`. The old check accepted any
    // JSON body, so it happily selected the wrong carrier and every later call
    // failed with "Token is invalid". Treat the device envelope's non-zero
    // `result` (and an explicit invalid-token message) as a failed verification.
    const payload = response.json as Record<string, unknown> | undefined
    const nested = payload?.msgBody
    const payloadOk =
      looksLikeHertzinnoDevice(response.json) ||
      looksLikeHertzinnoDevice(nested)
    const resultValue = payload?.result
    const resultOk =
      resultValue === undefined ||
      resultValue === null ||
      resultValue === 0 ||
      resultValue === '0'
    const message = typeof payload?.message === 'string' ? payload.message : ''
    const messageOk = !/token\s+is\s+invalid|unauthor|forbidden|incorrect/i.test(message)
    const statusOk = response.status >= 200 && response.status < 300

    return {
      ok: statusOk && resultOk && messageOk && (payloadOk || response.json !== undefined),
      status: response.status
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Preferred strategy first, then the rest in declaration order. */
function orderStrategies(preferredId?: string): AuthStrategy[] {
  if (!preferredId) return [...CANDIDATE_STRATEGIES]
  const preferred = findStrategy(preferredId)
  if (!preferred) return [...CANDIDATE_STRATEGIES]
  return [preferred, ...CANDIDATE_STRATEGIES.filter((strategy) => strategy.id !== preferredId)]
}

function describeCarrier(strategy: AuthStrategy): string {
  const carrier = strategy.carrier
  switch (carrier.kind) {
    case 'header':
      return `header ${carrier.name}: ${carrier.prefix}<token>`
    case 'query':
      return `query ?${carrier.name}=<token>`
    case 'cookie':
      return `cookie ${carrier.name}=<token>`
    case 'body':
      return '每请求携带凭据'
  }
}

/** Parse the first name=value pair out of a Set-Cookie header. */
function extractCookie(setCookie: string | undefined): string | undefined {
  if (!setCookie) return undefined
  const first = setCookie.split(';')[0]?.trim()
  return first && first.includes('=') ? first : undefined
}

/** Append query parameters without clobbering any already present. */
export function buildUrl(url: string, query: Record<string, string>): string {
  const entries = Object.entries(query)
  if (entries.length === 0) return url
  const separator = url.includes('?') ? '&' : '?'
  const encoded = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `${url}${separator}${encoded}`
}
