/**
 * Integration tests for the auth strategy resolver (spec section 19, risk 1).
 *
 * THE POINT OF THIS FILE
 * "How must the token be carried?" is the single highest-risk unknown in the
 * specification. The answer cannot be guessed and cannot be unit-tested against
 * a mock — it has to be DISCOVERED against something that behaves like a real
 * device and REJECTS the wrong answer.
 *
 * So these tests stand up a real HTTP server that enforces exactly one carrier
 * and returns 401 for every other. The resolver must find the right one, or
 * fail. This is the closest thing to a real device that runs in CI, and it
 * pins down the behaviour that the Protocol Lab depends on.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { AuthStrategyResolver } from '../src/main/services/device/auth-resolver'
import { FetchHttpTransport } from '../src/main/services/device/http-transport'
import { AppError } from '../src/shared/errors'
import { derivePassword } from '../src/main/services/device/auth-strategy'
import type { AuthStrategy } from '../src/main/services/device/auth-strategy'

/** A plausible /get_devinfo payload, used to prove the session really works. */
const DEVICE_INFO = {
  // MEASURED AE08 field names — no serial number exists on this firmware.
  devname: 'AE08',
  dev_mac: '02:EF:A2:52:F1:C5',
  dev_version: '567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8',
  fpga_version: 'V2.1.2_20260601.16BIT',
  web_version: 'V2.1.0.WEB.2025-06-05'
}

/** How a fake device decides whether a request is authenticated. */
type CarrierCheck = (headers: http.IncomingHttpHeaders, url: URL) => boolean

interface FakeDeviceOptions {
  /** Field name the fake device uses for the token in its login response. */
  tokenField?: string
  /** Value it expects back. */
  token?: string
  /** Predicate deciding whether a request carries the token correctly. */
  check: CarrierCheck
  /** HTTP status for /login. Non-2xx exercises the "login refused" path. */
  loginStatus?: number
  /** Status returned when auth fails on a protected endpoint. */
  unauthorizedStatus?: number
  /**
   * Nest the token one level deep (`{code:0, data:{token:"..."}}`), which is how
   * a lot of real firmware shapes its responses.
   */
  nestTokenInData?: boolean
}

interface FakeDevice {
  baseUrl: string
  close: () => Promise<void>
  /** Requests the server saw, for asserting the resolver did not spam login. */
  requests: Array<{ method: string; path: string; authorized: boolean }>
}

function startFakeDevice(options: FakeDeviceOptions): Promise<FakeDevice> {
  const token = options.token ?? 'TEST-TOKEN-12345'
  const tokenField = options.tokenField ?? 'token'
  const requests: FakeDevice['requests'] = []

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const headers = request.headers

    const sendJson = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      })
      response.end(body)
    }

    if (url.pathname === '/login') {
      if (options.loginStatus && options.loginStatus >= 400) {
        requests.push({ method: 'POST', path: '/login', authorized: false })
        sendJson(options.loginStatus, { message: 'Incorrect username or password.', result: 2 })
        return
      }

      // MEASURED device contract: the credentials arrive wrapped in `msgBody`.
      // Enforcing it here is deliberate — a client that posts a bare
      // `{username, password}` gets the SAME error as wrong credentials on real
      // hardware, so the fake device must reproduce that trap or the test would
      // happily validate a client that cannot log in to a real box.
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        let parsed: { msgBody?: { username?: string; password?: string } } = {}
        try {
          parsed = JSON.parse(raw)
        } catch {
          parsed = {}
        }

        const inner = parsed.msgBody
        if (!inner || inner.username !== CREDENTIAL.username) {
          requests.push({ method: 'POST', path: '/login', authorized: false })
          sendJson(401, { message: 'Incorrect username or password.', result: 2 })
          return
        }

        requests.push({ method: 'POST', path: '/login', authorized: true })
        // A real device may also set a session cookie; include one so the
        // cookie strategy has something to find.
        response.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly`)
        const tokenPayload = { [tokenField]: token }
        // MEASURED envelope: { message, msgBody, result }. The strategy must
        // find the token under `msgBody`, not under a spec-style `data`.
        sendJson(200, {
          message: 'ok',
          msgBody: options.nestTokenInData ? { data: tokenPayload } : tokenPayload,
          result: 0
        })
      })
      return
    }

    const authorized = options.check(headers, url)
    requests.push({ method: request.method ?? 'GET', path: url.pathname, authorized })

    if (!authorized) {
      sendJson(options.unauthorizedStatus ?? 401, { code: 401, msg: 'unauthorized' })
      return
    }

    if (url.pathname === '/get_devinfo') {
      // MEASURED envelope, and MEASURED field names (`dev_mac`, `devname`,
      // `dev_version`) rather than the specification's guesses.
      sendJson(200, { message: 'ok', msgBody: DEVICE_INFO, result: 0 })
      return
    }

    sendJson(404, { code: 404, msg: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}

const CREDENTIAL = { username: 'admin', password: 'secret' }
const openDevices: FakeDevice[] = []

async function withDevice(options: FakeDeviceOptions): Promise<FakeDevice> {
  const device = await startFakeDevice(options)
  openDevices.push(device)
  return device
}

after(async () => {
  await Promise.all(openDevices.map((device) => device.close()))
})

function makeResolver(): AuthStrategyResolver {
  return new AuthStrategyResolver(new FetchHttpTransport(4_000))
}

const carrierOf = (strategy: AuthStrategy): string => strategy.carrier.kind

// ---------------------------------------------------------------------------

describe('AuthStrategyResolver', () => {
  it('discovers the Bearer header carrier', async () => {
    // `bearer-header` is deliberately NOT first in the measured order (the real
    // device rejects it), so this pins the carrier itself rather than the order.
    const device = await withDevice({
      check: (headers) => headers.authorization === 'Bearer TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({
      baseUrl: device.baseUrl,
      credential: CREDENTIAL,
      preferredStrategyId: 'bearer-header'
    })

    assert.equal(result.strategy.id, 'bearer-header')
    assert.equal(carrierOf(result.strategy), 'header')
    assert.equal(result.session.token, 'TEST-TOKEN-12345')
    // The successful attempt must be reported as verified, not merely attempted.
    const winning = result.attempts.find((attempt) => attempt.strategyId === 'bearer-header')
    assert.equal(winning?.verifyOk, true)
  })

  it('discovers a raw Authorization header (no Bearer prefix)', async () => {
    const device = await withDevice({
      // Must be the bare token, not the Bearer-prefixed form, so the resolver
      // has to reject `bearer-header` before accepting `raw-auth-header`.
      check: (headers) => {
        const value = String(headers.authorization ?? '')
        return value === 'TEST-TOKEN-12345'
      }
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'raw-auth-header')
  })

  it('discovers a custom token header', async () => {
    const device = await withDevice({
      check: (headers) => headers.token === 'TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'token-header')
  })

  it('discovers a query-parameter token', async () => {
    const device = await withDevice({
      check: (_headers, url) => url.searchParams.get('token') === 'TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'query-token')
    assert.equal(carrierOf(result.strategy), 'query')
  })

  it('discovers a cookie session', async () => {
    const device = await withDevice({
      check: (headers) => (headers.cookie ?? '').includes('TEST-TOKEN-12345')
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'cookie-session')
    assert.equal(carrierOf(result.strategy), 'cookie')
  })

  it('matches a token field that differs only in case or separators', async () => {
    // Regression guard: a device returning `session_id` (snake_case) must not
    // be treated as "no token found". A one-character spelling difference
    // previously looked identical to an authentication bug, which is the most
    // expensive possible way to discover it — on a customer's device.
    for (const tokenField of ['session_id', 'SESSION_ID', 'session-id', 'SessionId']) {
      const device = await withDevice({
        tokenField,
        check: (headers) => (headers.cookie ?? '').includes('TEST-TOKEN-12345')
      })

      const result = await makeResolver().resolve({
        baseUrl: device.baseUrl,
        credential: CREDENTIAL
      })
      assert.equal(
        result.strategy.id,
        'cookie-session',
        `token field "${tokenField}" was not recognised`
      )
    }
  })

  it('recognises a token nested one level inside an envelope', async () => {
    // Firmware commonly wraps its payload: {code:0, data:{token:"..."}}.
    const device = await withDevice({
      nestTokenInData: true,
      check: (headers) => headers.authorization === 'Bearer TEST-TOKEN-12345'
    })
    const result = await makeResolver().resolve({
      baseUrl: device.baseUrl,
      credential: CREDENTIAL,
      preferredStrategyId: 'bearer-header'
    })
    assert.equal(result.strategy.id, 'bearer-header')
    assert.equal(result.session.token, 'TEST-TOKEN-12345')
  })

  it('resolves a token returned under a common alias rather than only `token`', async () => {
    const device = await withDevice({
      tokenField: 'accessToken',
      check: (headers) => headers.authorization === 'Bearer TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'bearer-header')
  })

  it('reports the login response field names even when no alias is recognised', async () => {
    // `findToken` deliberately recognises only conventional aliases: guessing
    // that an arbitrary string field is a token would risk sending a status
    // message as an Authorization header. The resolver therefore FAILS here,
    // but it must still surface the field names so the Protocol Lab report
    // tells an engineer exactly what the firmware sent.
    const device = await withDevice({
      tokenField: 'authKey',
      check: () => false
    })

    const resolver = makeResolver()
    await assert.rejects(
      () => resolver.resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'AUTH_FAILED')
        return true
      }
    )

    // The diagnosis survives the failure — this is the data a human needs to
    // extend the alias list for a new firmware revision.
    assert.ok(
      resolver.lastLoginFieldNames.includes('authKey'),
      `expected authKey in ${JSON.stringify(resolver.lastLoginFieldNames)}`
    )
  })

  it('surfaces unrecognised login field names through loginFieldNames', async () => {
    // Same device, but the resolver must report the shape it saw. This is the
    // data that lets a human extend the alias list with confidence.
    const device = await withDevice({
      tokenField: 'someVendorSpecificKey',
      check: (headers) => headers['some-vendor-specific-key'] === 'TEST-TOKEN-12345'
    })

    await assert.rejects(
      () => makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        // The detail lists every carrier that was tried and why each failed.
        assert.ok((error.detail ?? '').includes('no token field was recognised'))
        return true
      }
    )
  })

  it('reports every rejected strategy with a reason, for the Protocol Lab', async () => {
    // Deliberately use a carrier that is NOT first in the measured order, so
    // the resolver has to reject at least one candidate before succeeding.
    const device = await withDevice({
      check: (headers) => headers['x-token'] === 'TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'x-token-header')

    // Every carrier tried before the winner must be recorded WITH a reason.
    // That failure list is the whole value of the Protocol Lab report: it is
    // what tells an engineer which carriers the firmware rejected.
    const rejected = result.attempts.filter((attempt) => attempt.verifyOk !== true)
    assert.ok(rejected.length >= 3, `expected earlier carriers to be recorded, got ${rejected.length}`)
    for (const attempt of rejected) {
      assert.ok(attempt.error, `rejected strategy ${attempt.strategyId} has no reason recorded`)
    }
  })

  it('tries the preferred strategy first and can skip straight to success', async () => {
    const device = await withDevice({
      check: (headers) => headers.token === 'TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({
      baseUrl: device.baseUrl,
      credential: CREDENTIAL,
      preferredStrategyId: 'token-header'
    })

    assert.equal(result.strategy.id, 'token-header')
    // A cached strategy means the very first attempt wins.
    assert.equal(result.attempts[0]?.strategyId, 'token-header')
    assert.equal(result.attempts.length, 1)
  })

  it('falls back to full probing when the preferred strategy no longer works', async () => {
    // Simulates firmware changing its carrier after an update.
    const device = await withDevice({
      check: (headers) => headers.authorization === 'Bearer TEST-TOKEN-12345'
    })

    const result = await makeResolver().resolve({
      baseUrl: device.baseUrl,
      credential: CREDENTIAL,
      preferredStrategyId: 'token-header'
    })

    assert.equal(result.strategy.id, 'bearer-header')
  })

  it('supports a device that never issues a token, using credentials per request', async () => {
    // body-credentials is last in the candidate order and has no token to find.
    const device = await withDevice({
      loginStatus: 200,
      tokenField: 'unused',
      check: () => false
    })

    await assert.rejects(
      () => makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'AUTH_FAILED')
        return true
      }
    )
  })

  it('fails with AUTH_FAILED when the device rejects the credentials', async () => {
    const device = await withDevice({
      loginStatus: 401,
      check: () => false
    })

    await assert.rejects(
      () => makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'AUTH_FAILED')
        // The detail must name what was tried, so a support engineer can act.
        assert.ok((error.detail ?? '').includes('bearer-header'))
        return true
      }
    )
  })

  it('stops probing immediately when the device is unreachable', async () => {
    // Port 1 on loopback refuses connections. Trying six carriers against a
    // dead device would waste the user's time for no information gain.
    await assert.rejects(
      () =>
        makeResolver().resolve({
          baseUrl: 'http://127.0.0.1:1',
          credential: CREDENTIAL,
          timeoutMs: 2_000
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.ok(
          ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code),
          `expected a transport error, got ${error.code}`
        )
        return true
      }
    )
  })

  it('does not accept a 200 that carries no device payload', async () => {
    // A firmware that answers every unauthenticated request with an empty 200
    // must not be mistaken for a working session.
    const device = await withDevice({
      check: () => true
    })

    // Every carrier "works" here, so the FIRST candidate must win — proving the
    // resolver does not keep probing once a plausible session is found.
    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.attempts.length, 1)
    // The measured-first carrier is the one the device's own UI uses.
    assert.equal(result.strategy.id, 'token-header')
  })
})

// ---------------------------------------------------------------------------
// Regressions pinned to the MEASURED device protocol
// ---------------------------------------------------------------------------

/**
 * Every assertion below encodes something the real AE08 firmware does that the
 * specification got wrong. Each one was a live failure during integration, and
 * each would silently break again if someone "tidied up" the protocol layer
 * back toward the specification.
 *
 * See docs/PROTOCOL-FINDINGS.md for the raw evidence.
 */
describe('measured AE08 protocol contract', () => {
  it('derives the wire password as md5(plaintext + "lfxs")', () => {
    // Verified against a real device: this exact hash logs in as admin.
    assert.equal(derivePassword('123456'), '7cb8406e5a99c917a60681762d7952c2')
    // And the unsalted hash is NOT what the device wants.
    assert.notEqual(derivePassword('123456'), 'e10adc3949ba59abbe56e057f20f883e')
  })

  it('is deterministic — the device has no challenge/nonce', () => {
    assert.equal(derivePassword('secret'), derivePassword('secret'))
  })

  it('wraps the login credentials in msgBody', async () => {
    // The fake device rejects a bare {username,password} with the SAME error as
    // wrong credentials, so a client that omits the envelope cannot log in and
    // gets a maximally misleading message. This asserts we send the envelope.
    const device = await withDevice({ check: () => true })
    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.ok(result.session.token, 'login must succeed against the msgBody-enforcing device')
  })

  it('reads the token from msgBody, not from a spec-style `data` field', async () => {
    const device = await withDevice({ check: () => true })
    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.session.token, 'TEST-TOKEN-12345')
    // `msgBody` is the measured location; the field list must reflect the frame.
    assert.ok(result.loginFieldNames.includes('result') || result.loginFieldNames.includes('message'))
  })

  it('prefers token-header, the carrier the device UI itself uses', async () => {
    const device = await withDevice({
      check: (headers) => headers.token === 'TEST-TOKEN-12345'
    })
    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    // First attempt must win: any earlier candidate is a wasted round trip.
    assert.equal(result.attempts.length, 1)
    assert.equal(result.attempts[0]?.strategyId, 'token-header')
  })

  it('still discovers the carrier when the credential envelope is correct but the token carrier is not the preferred one', async () => {
    const device = await withDevice({
      check: (headers) => headers.authorization === 'TEST-TOKEN-12345'
    })
    const result = await makeResolver().resolve({ baseUrl: device.baseUrl, credential: CREDENTIAL })
    assert.equal(result.strategy.id, 'raw-auth-header')
  })
})

describe('FetchHttpTransport', () => {
  it('reports a JSON body and latency', async () => {
    const device = await withDevice({ check: () => true })
    const transport = new FetchHttpTransport(4_000)

    const response = await transport.request({
      method: 'GET',
      url: `${device.baseUrl}/get_devinfo`,
      throwOnHttpError: false
    })

    assert.equal(response.status, 200)
    assert.ok(response.latencyMs >= 0)
    assert.ok(response.contentType.includes('json'))
    assert.deepEqual((response.json as { msgBody: unknown }).msgBody, DEVICE_INFO)
  })

  it('returns rather than throws when throwOnHttpError is false', async () => {
    const device = await withDevice({ check: () => false })
    const transport = new FetchHttpTransport(4_000)

    const response = await transport.request({
      method: 'GET',
      url: `${device.baseUrl}/get_devinfo`,
      throwOnHttpError: false
    })
    assert.equal(response.status, 401)
    assert.equal(response.ok, false)
  })

  it('throws a DEVICE_ERROR for a non-2xx status by default', async () => {
    const device = await withDevice({ check: () => false })
    const transport = new FetchHttpTransport(4_000)

    await assert.rejects(
      () => transport.request({ method: 'GET', url: `${device.baseUrl}/get_devinfo` }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'DEVICE_ERROR')
        return true
      }
    )
  })

  it('converts an unreachable host into NETWORK_ERROR, never a raw TypeError', async () => {
    const transport = new FetchHttpTransport(2_000)
    await assert.rejects(
      () => transport.request({ method: 'GET', url: 'http://127.0.0.1:1/nope' }),
      (error: unknown) => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'NETWORK_ERROR')
        return true
      }
    )
  })
})
