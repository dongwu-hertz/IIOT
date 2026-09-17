/**
 * HTTP transport for device communication.
 *
 * Deliberately thin and injectable: `HttpTransport` is an interface so the
 * resolver, API client and tests can swap in a fake without a network. Every
 * request is bounded by an AbortController so a dead device can never hang the
 * UI (spec 14.4 / acceptance "网络请求超时不会导致 UI 卡死").
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'

/**
 * Request body accepted by the transport.
 * Typed locally rather than reusing the DOM's `BodyInit`, because the main
 * process compiles against `lib: ES2023` with Node types only.
 */
/**
 * Body shapes the transport will send.
 *
 * Typed locally rather than reusing the DOM's `BodyInit`: this file compiles
 * against `lib: ES2023` with Node types, whose `fetch` accepts a narrower set
 * than the browser's. `FormData` is included because firmware upload
 * (`POST /upload`) is multipart, which is the one call that is not JSON.
 */
export type RequestBody = string | Uint8Array | ArrayBuffer | Blob | FormData

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  /** JSON body. Mutually exclusive with `rawBody`. */
  json?: unknown
  /** Pre-encoded body (e.g. firmware upload streams). */
  rawBody?: RequestBody
  timeoutMs?: number
  /** Caller cancellation, chained with the timeout signal. */
  signal?: AbortSignal
  /** When false, a non-2xx status is returned rather than thrown. */
  throwOnHttpError?: boolean
  /**
   * Cap on the buffered body size. Defaults to `MAX_BUFFERED_BYTES`.
   * Set for calls that only need the status/headers (e.g. probing a download
   * endpoint) so a large file is never materialised in memory.
   */
  maxBytes?: number
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  contentType: string
  /** Parsed JSON when the body was JSON, otherwise undefined. */
  json?: unknown
  /** Body as text when it was not JSON and `readBody` was requested. */
  text?: string
  /** Raw bytes, populated only when `binary: true`. */
  bytes?: Uint8Array
  latencyMs: number
}

/**
 * Signature of a response that never terminates.
 *
 * A streaming endpoint (`/audio_stream`, `/features_stream`) delivers bytes
 * until the connection closes, so `await response.text()` would block forever.
 * Waiting for completion is not merely slow — it is impossible, which means the
 * naive approach loses exactly the evidence needed to choose a decoder.
 *
 * The fix is to read a BOUNDED prefix and then deliberately abandon the
 * response. Everything needed to determine the framing — content type, chunked
 * flag, and the first bytes — arrives in that prefix.
 */
export interface StreamSignature {
  status: number
  ok: boolean
  contentType: string
  headers: Record<string, string>
  chunked: boolean
  bytes: Uint8Array
  latencyMs: number
  /** True when the stream ended on its own before the byte cap was reached. */
  completed: boolean
  error?: string
}

export interface HttpTransport {
  request(options: HttpRequestOptions & { binary?: boolean }): Promise<HttpResponse>
  /**
   * Read a bounded prefix of a streaming response and abandon it.
   * Distinct from `request()` because the semantics genuinely differ: the
   * correct outcome here is "captured enough, then stopped", not "read to end".
   */
  captureStream(options: HttpRequestOptions & { maxBytes: number }): Promise<StreamSignature>
}

/**
 * Hard ceiling on any single buffered response body.
 *
 * An unbounded `arrayBuffer()` is a memory bomb: a 500 MB device recording
 * would be materialised in the main process in one allocation. Probing a
 * download endpoint only needs the status line, the headers and a few bytes of
 * magic number, so the body is truncated well before that becomes a risk.
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/**
 * fetch-based transport.
 *
 * `redirect: 'manual'` is intentional: a device that 302s to a login page would
 * otherwise turn an auth failure into a misleading HTML 200.
 */
export class FetchHttpTransport implements HttpTransport {
  constructor(private readonly defaultTimeoutMs = 8_000) {}

  async request(options: HttpRequestOptions & { binary?: boolean }): Promise<HttpResponse> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const maxBytes = options.maxBytes ?? MAX_BUFFERED_BYTES
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)

    // Chain the caller's signal so cancellation and timeout compose.
    const onAbort = (): void => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    let body: RequestBody | undefined

    if (options.rawBody !== undefined) {
      body = options.rawBody
    } else if (options.json !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
      body = JSON.stringify(options.json)
    }

    const started = performance.now()

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers,
        // The cast bridges two legitimate definitions of the same runtime value:
        // Node's `fetch` accepts every member of `RequestBody`, but the compiler
        // cannot unify it with the DOM `BodyInit` this `RequestInit` is typed
        // against. Casting the BODY (not the whole init) keeps the method,
        // headers and signal checked.
        //
        // Do NOT be tempted to cast `body` to `undefined`: that type-checks and
        // then silently drops the request body at runtime.
        body: body as never,
        redirect: 'manual',
        signal: controller.signal
      })

      const latencyMs = Math.round(performance.now() - started)
      const contentType = response.headers.get('content-type') ?? ''
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value
      })

      const result: HttpResponse = {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: responseHeaders,
        contentType,
        latencyMs
      }

      // Read the body ONCE as bytes, then derive whatever representations the
      // caller asked for. Reading via `response.text()` or `response.arrayBuffer()`
      // separately would make the two mutually exclusive, and a caller that
      // wants both the raw bytes AND the parsed JSON (the Protocol Lab does)
      // would silently get only one of them.
      //
      // The read is also bounded: a truncated body is far better than an
      // out-of-memory crash when a device serves a multi-hundred-megabyte file.
      const declaredLength = Number(responseHeaders['content-length'] ?? '0')
      const capped = declaredLength > maxBytes && maxBytes > 0
      const raw = await readBounded(response, maxBytes)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(raw)

      if (capped) {
        deviceLog().warn('Response body truncated at the buffering limit', {
          url: options.url,
          declaredLength,
          capturedBytes: raw.length,
          limit: maxBytes
        })
      }

      if (options.binary) {
        result.bytes = raw
      }

      if (contentType.includes('json')) {
        result.text = text
        try {
          result.json = text.length > 0 ? JSON.parse(text) : undefined
        } catch {
          // A device advertising JSON but sending something else is a protocol
          // smell worth logging, but the raw text is still returned.
          deviceLog().debug('Response advertised JSON but failed to parse', {
            url: options.url,
            sample: text.slice(0, 200)
          })
          result.json = undefined
        }
      } else if (!options.binary) {
        result.text = text
      } else {
        // Binary was requested but the payload is short enough to be worth
        // keeping as text too — this is what makes framing analysis possible.
        result.text = text.length <= 8192 ? text : undefined
      }

      if (options.throwOnHttpError !== false && !result.ok) {
        throw new AppError(
          ErrorCodes.DEVICE_ERROR,
          `设备返回 HTTP ${response.status}`,
          result.text?.slice(0, 300)
        )
      }

      return result
    } catch (error) {
      throw this.normaliseError(error, options.url)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Read up to `maxBytes` of a streaming response, then abandon it.
   *
   * Implementation notes:
   *   - The timeout is NOT an error here. A stream that is still producing
   *     bytes when the deadline fires has already given us its signature, so
   *     the partial result is returned as a success. Only a failure to connect
   *     at all is reported as an error.
   *   - Reading is done with a streaming reader rather than `response.text()`,
   *     because the latter waits for the body to END. For an endless PCM feed
   *     that never happens, which is precisely how a naive probe ends up with
   *     no data and no conclusion.
   */
  async captureStream(options: HttpRequestOptions & { maxBytes: number }): Promise<StreamSignature> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('capture-window-elapsed')), timeoutMs)

    const started = performance.now()

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        ...(options.json !== undefined
          ? { body: JSON.stringify(options.json), headers: { ...options.headers, 'Content-Type': 'application/json' } }
          : {}),
        redirect: 'manual',
        signal: controller.signal
      })

      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })

      const contentType = headers['content-type'] ?? ''
      const transferEncoding = headers['transfer-encoding'] ?? ''
      // Absent transfer-encoding on an HTTP/1.1 streaming response effectively
      // means the server closes to signal end, which is still "streamed".
      const chunked = transferEncoding.includes('chunked') || transferEncoding === ''

      const collected: Uint8Array[] = []
      let total = 0
      let completed = false

      const body = response.body
      if (body) {
        const reader = body.getReader()
        try {
          while (total < options.maxBytes) {
            const chunk = await reader.read()
            if (chunk.done) {
              completed = true
              break
            }
            if (chunk.value && chunk.value.length > 0) {
              collected.push(chunk.value)
              total += chunk.value.length
            }
          }
        } catch (error) {
          // An abort mid-read is the EXPECTED exit for an endless stream.
          // Anything else is surfaced, but the bytes already collected are kept.
          const message = error instanceof Error ? error.message : String(error)
          if (!/capture-window-elapsed|abort/i.test(message)) {
            deviceLog().debug('Stream capture ended with an error', { url: options.url, message })
          }
        } finally {
          // Deliberately abandon the rest of the body.
          void reader.cancel().catch(() => undefined)
        }
      } else {
        completed = true
      }

      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        contentType,
        headers,
        chunked,
        bytes: concatBytes(collected, options.maxBytes),
        latencyMs: Math.round(performance.now() - started),
        completed
      }
    } catch (error) {
      const appError = this.normaliseError(error, options.url)
      // Distinguish "never connected" from "connected, then we stopped reading".
      return {
        status: 0,
        ok: false,
        contentType: '',
        headers: {},
        chunked: false,
        bytes: new Uint8Array(0),
        latencyMs: Math.round(performance.now() - started),
        completed: false,
        error: appError.message
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Translate transport-level failures into the unified error taxonomy. */
  private normaliseError(error: unknown, url: string): AppError {
    if (error instanceof AppError) return error

    if (error instanceof Error) {
      if (error.name === 'AbortError' || error.message === 'timeout') {
        return new AppError(ErrorCodes.TIMEOUT, `请求超时: ${url}`)
      }
      // Node fetch surfaces transport problems as TypeError with a cause.
      const cause = (error as { cause?: { code?: string } }).cause
      if (error.name === 'TypeError') {
        return new AppError(
          ErrorCodes.NETWORK_ERROR,
          `无法连接到设备: ${url}`,
          cause?.code ?? error.message
        )
      }
      return new AppError(ErrorCodes.NETWORK_ERROR, error.message)
    }

    return new AppError(ErrorCodes.UNKNOWN, String(error))
  }
}

/** Concatenate captured chunks, truncating to the requested cap. */
function concatBytes(chunks: readonly Uint8Array[], maxBytes: number): Uint8Array {
  const total = Math.min(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    maxBytes
  )
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    if (offset >= total) break
    const remaining = total - offset
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    output.set(slice, offset)
    offset += slice.length
  }
  return output
}

/**
 * Read a response body, stopping at `maxBytes`.
 *
 * Uses a streaming reader rather than `arrayBuffer()` so that a huge or endless
 * body cannot be fully materialised. When the cap is reached the remaining
 * stream is cancelled — we already have everything the caller needs.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (maxBytes <= 0) return new Uint8Array(0)

  const body = response.body
  if (!body) return new Uint8Array(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (total < maxBytes) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (chunk.value && chunk.value.length > 0) {
        chunks.push(chunk.value)
        total += chunk.value.length
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }

  return concatBytes(chunks, maxBytes)
}
