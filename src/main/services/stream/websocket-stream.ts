/**
 * WebSocket transport for the realtime streams.
 *
 * THE FINDING THAT FORCED THIS FILE
 * The specification lists `/features_stream`, `/audio_stream`, `/freq_domain`
 * and `/time_freq_domain` as HTTP `GET` endpoints. Measured against real AE08
 * hardware, all four return **HTTP 404** — they are **WebSocket** endpoints.
 * See `docs/PROTOCOL-FINDINGS.md` section 4.
 *
 * Building them as HTTP would have produced four features that simply never
 * work, with a 404 as the only clue.
 *
 * SUBSCRIPTION MODEL
 * The device does NOT push autonomously. The client must send a small JSON
 * ping on an interval, and the interval is per-endpoint:
 *
 *   /features_stream    1000 ms   {"type": "ping", }
 *   /audio_stream        100 ms   {"type": "ping", "channel": "0"}
 *   /freq_domain        1000 ms   {"type": "ping", "channel": "0"}
 *   /time_freq_domain   1000 ms   {"type": "ping", "channel": "0"}
 *
 * Note the audio ping is ten times faster, and that `channel` is a STRING.
 *
 * FRAMING
 * Every stream delivers **binary** frames. `binaryType` is set to
 * `arraybuffer` because Node's WebSocket hands binary frames over as `Blob` by
 * default, and a Blob cannot be inspected or decoded without an extra await.
 * Getting this wrong yields a confusing `ERR_INVALID_ARG_TYPE` from
 * `Buffer.from` rather than anything resembling a protocol error.
 */

import { EventEmitter } from 'node:events'
import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'

/** Per-endpoint subscription cadence, measured from the device's own UI. */
export interface StreamProfile {
  path: string
  /** Interval between subscription pings. */
  pingIntervalMs: number
  /** Exact ping payload the device expects. */
  pingBody: string
  /** Whether the subscription needs a channel argument. */
  carriesChannel: boolean
  /** Human description, used in diagnostics. */
  purpose: string
  /**
   * Whether the handshake candidate may be demoted for delivering NO frame.
   *
   * Defaults to `true` (an always-pushing stream is the common case), and is
   * deliberately overridable because the two are not the same thing:
   *
   *   - an open socket on a stream that pushes every second and delivers
   *     nothing is indistinguishable from a server that accepted the upgrade
   *     and then ignored an unauthorised client;
   *   - an open socket on an EVENT stream — FA371's `/detectFeedback` pushes one
   *     frame per finished detection, which may be minutes apart — is perfectly
   *     healthy while silent. MEASURED against `scripts/mock-fa371.cjs`: with
   *     the probe armed, the client demoted a WORKING candidate (`none`) on the
   *     event channel purely because no detection had finished.
   *
   * So an event-only stream sets this to `false` and is never demoted for
   * silence; it is still demoted if the socket itself fails to open.
   */
  probeHandshake?: boolean
}

/**
 * The measured profiles.
 *
 * `channel` is deliberately a STRING in the JSON — the device's own UI sends
 * `"0"`, not `0`. Whether the firmware would accept a number is untested, so
 * the known-good form is used.
 */
export const STREAM_PROFILES: Readonly<Record<string, StreamProfile>> = Object.freeze({
  features: {
    path: '/features_stream',
    pingIntervalMs: 1000,
    pingBody: '{"type": "ping", }',
    carriesChannel: false,
    purpose: '实时特征（JSON 帧装在二进制消息里）'
  },
  audio: {
    path: '/audio_stream',
    pingIntervalMs: 100,
    pingBody: '{"type": "ping", "channel": "0"}',
    carriesChannel: true,
    purpose: '实时 PCM（Float32 小端，无头部）'
  },
  spectrum: {
    path: '/freq_domain',
    pingIntervalMs: 1000,
    pingBody: '{"type": "ping", "channel": "0"}',
    carriesChannel: true,
    purpose: '频域（Float32 数组，1024 个频点）'
  },
  spectrogram: {
    path: '/time_freq_domain',
    pingIntervalMs: 1000,
    pingBody: '{"type": "ping", "channel": "0"}',
    carriesChannel: true,
    purpose: '时频图（JPEG 图像）'
  }
})

/** One message from a stream. */
export interface StreamFrame {
  /** Monotonic sequence number within this connection. */
  sequence: number
  /** Always true on the measured device; kept explicit so a text frame is visible. */
  binary: boolean
  /** Raw payload bytes. */
  bytes: Uint8Array
  /** Arrival time, epoch ms. The feature frames carry NO timestamp of their own. */
  receivedAt: number
}

export type StreamState =
  | 'IDLE'
  | 'CONNECTING'
  | 'STREAMING'
  | 'RECONNECTING'
  | 'STOPPED'
  | 'ERROR'

/**
 * One way of presenting the session token during the WebSocket HAND SHAKE.
 *
 * WHY THIS IS A NAMED SET RATHER THAN A BOOLEAN
 * The FA371 manual never says how a WebSocket connection authenticates
 * (`docs/reference/FA371-api-spec.md` §8.4 D1) — not whether the token travels
 * in a header, in the URL query, or not at all. Picking one and hard-coding it
 * is exactly the mistake `auth-strategy.ts` exists to prevent on the HTTP side,
 * so the socket side models it the same way: an ordered list of named
 * candidates that is tried until one is ACCEPTED, with the winner remembered.
 *
 * A candidate is "accepted" when the server completes the upgrade
 * (`onopen`). Chromium and Node expose no HTTP status for a rejected handshake,
 * so the only reliable discriminator is whether the socket opened at all —
 * which is why the list is ordered by likelihood and why trying the next one
 * only happens after the previous one failed to open.
 *
 * MEASURED CAVEAT, because it doubles the cost of a wrong guess: Node's
 * WebSocket (the global backed by undici) RETRIES the handshake ONCE by itself
 * when the server answers with an HTTP error status instead of 101. A rejected
 * candidate therefore costs two upgrade attempts, not one. That is undici's
 * behaviour, not ours, and it is harmless — but it is the reason a Probe on a
 * server that rejects with 401 shows each failed candidate twice.
 */
export interface HandshakeAuthCandidate {
  /** Stable id, remembered and reported (never a credential). */
  id: string
  /** Human description for logs and the Protocol Lab report. */
  description: string
  /** Where the token goes. `none` = let the server decide (no auth at all). */
  kind: 'header' | 'query' | 'none'
  /** Header or query-parameter name. Unused when `kind` is `none`. */
  name?: string
  /** Prefix placed before the token, e.g. `'Bearer '`. */
  prefix?: string
}

export interface StreamStatus {
  state: StreamState
  retries: number
  lastFrameAt?: number
  lastError?: string
  /** Id of the handshake-auth candidate that opened the current socket. */
  handshakeAuthId?: string
}

export interface WebSocketStreamOptions {
  /** Base WebSocket URL, e.g. `ws://192.168.1.50`. */
  baseWsUrl: string
  profile: StreamProfile
  /** Auth headers. The device accepts `token` and `Authorization`. */
  headers: Record<string, string>
  /** Channel to subscribe to, for profiles that carry one. */
  channel?: number
  /**
   * Send `channel` in the subscription ping even though the profile says the
   * endpoint carries none.
   *
   * WHY THIS EXISTS — an UNVERIFIED experiment, isolated behind one flag
   * `/features_stream`'s measured ping is `{"type": "ping", }`: no channel. The
   * frame it pushes is whatever channel the DEVICE has selected (PROTOCOL-FINDINGS
   * 4B), so on the measured firmware N connections all report the same channel.
   *
   * `/audio_stream` and `/time_freq_domain` DO carry a per-connection `channel`,
   * so the firmware demonstrably routes some streams per connection. Whether
   * `/features_stream` also honours a `channel` field — as opposed to ignoring it
   * — has never been tried, because the device's own UI never needs to.
   *
   * So: the flag is only set for the EXTRA channels of a multi-channel view, never
   * for the channel the operator is actually watching. Worst case the field is
   * ignored, the socket still opens and still pushes the device's current channel;
   * the frame's own `cur_ch` is what labels the data, so a wrong guess produces a
   * visible "未收到这一路" rather than a mislabelled reading. Best case the device
   * routes per connection and multiple channels stream at once.
   */
  channelInPing?: boolean
  /** Reconnect backoff ceiling. */
  maxReconnectDelayMs?: number
  /**
   * Ordered handshake-auth candidates, for devices whose WebSocket
   * authentication is undocumented (FA371, spec §8.4 D1).
   *
   * ABSENT = the measured AE08 behaviour, unchanged: the token goes into the
   * `token` query parameter (some deployments gate the upgrade on it) while
   * `headers` carries it as well. Nothing about the existing device family is
   * affected by this option existing.
   *
   * PRESENT = candidates are tried in order until one OPENS, and an open socket
   * is reported through `StreamStatus.handshakeAuthId`. A candidate that opens
   * but delivers no frame within `candidateProbeMs` is treated as a rejection
   * and the next candidate is tried, because a handshake the server accepts and
   * then ignores would otherwise leave a silently empty stream.
   */
  handshakeAuth?: readonly HandshakeAuthCandidate[]
  /** How long a candidate must deliver a frame before it is trusted. */
  candidateProbeMs?: number
  /** Invoked for every frame. Must not throw; a throw is caught and logged. */
  onFrame?: (frame: StreamFrame) => void
  /** Invoked on every state transition, including reconnects. */
  onStatus?: (status: StreamStatus) => void
}

/**
 * A self-healing subscription to one device stream.
 *
 * Lifecycle guarantees (spec appendix C rule 12 — every network stream must
 * implement timeout, reconnect, cancellation and cleanup on app exit):
 *   - `start()` is idempotent
 *   - reconnects use exponential backoff with a ceiling
 *   - `stop()` cancels timers, closes the socket and removes all listeners, so
 *     nothing keeps the process alive after the window closes
 */
export class WebSocketStream extends EventEmitter {
  private readonly options: WebSocketStreamOptions
  private socket?: WebSocket
  private pingTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  private sequence = 0
  private retries = 0
  private stopped = true
  private status: StreamStatus = { state: 'IDLE', retries: 0 }

  /** Rolling frame counter, used by the diagnostics to report a rate. */
  private framesReceived = 0
  private firstFrameAt?: number

  /**
   * The handshake-auth candidates, when the caller supplied any.
   *
   * `index` is the ONE piece of state the candidate probing needs: it advances
   * only when a candidate is proven wrong, and once a candidate has delivered a
   * frame the index stops moving (the winner is remembered for the life of this
   * object). Because the index is never reset by a reconnect, a reconnect after
   * a network drop reuses the known-good carrier instead of re-probing.
   */
  private readonly candidates: readonly HandshakeAuthCandidate[] | undefined
  private candidateIndex = 0
  /** Set once a candidate has delivered a frame: it is no longer a guess. */
  private candidateConfirmed = false
  /** Timer that demotes an open-but-silent candidate. */
  private candidateTimer?: NodeJS.Timeout
  /** True while a socket opened with a candidate that has not yet produced a frame. */
  private probingCandidate = false
  /**
   * Set while the timed-out candidate is being torn down.
   *
   * WITHOUT THIS the loop skips a candidate. Demoting a silent socket means
   * closing it, which fires `onclose`, which would advance the candidate list a
   * SECOND time — measured: `none`, `?Authorization=`, `?token=` collapsed into
   * `none`, `?token=`. The flag makes the deliberate close only trigger the
   * reconnect, never another advance.
   */
  private demotingCandidate = false
  /** Set by `stop()` so an intentional close never triggers a retry. */
  private closingIntentionally = false

  constructor(options: WebSocketStreamOptions) {
    super()
    this.options = options
    if (options.handshakeAuth && options.handshakeAuth.length > 0) {
      this.candidates = options.handshakeAuth
    }
  }

  get currentStatus(): StreamStatus {
    return { ...this.status }
  }

  /**
   * Id of the handshake-auth candidate currently in use, or `undefined`.
   *
   * Exposed (rather than only logged) because it is a PROTOCOL FINDING: the
   * first time a real FA371 answers, this value is the measurement.
   */
  get handshakeAuthId(): string | undefined {
    return this.candidates?.[this.candidateIndex]?.id
  }

  /** True when the current candidate has been proven by at least one frame. */
  get handshakeAuthConfirmed(): boolean {
    return this.candidateConfirmed
  }

  get frameCount(): number {
    return this.framesReceived
  }

  /** Frames per second since the first frame, or undefined before any arrive. */
  get frameRate(): number | undefined {
    if (!this.firstFrameAt || this.framesReceived < 2) return undefined
    const elapsedSeconds = (Date.now() - this.firstFrameAt) / 1000
    return elapsedSeconds > 0 ? this.framesReceived / elapsedSeconds : undefined
  }

  start(): void {
    this.stopped = false
    if (this.status.state === 'STREAMING' || this.status.state === 'CONNECTING') return
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.closingIntentionally = true
    this.clearTimers()

    const socket = this.socket
    this.socket = undefined
    if (socket) {
      // Detach before closing so a close event cannot trigger a reconnect.
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        // Already closing.
      }
    }

    this.setStatus('STOPPED')
    this.removeAllListeners()
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    const { baseWsUrl, profile, headers, channel } = this.options
    const { socket: url, auth } = this.buildHandshake(baseWsUrl, profile.path, headers, channel)

    this.setStatus(this.retries > 0 ? 'RECONNECTING' : 'CONNECTING')

    let socket: WebSocket
    try {
      socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error))
      return
    }

    this.socket = socket
    this.probingCandidate = auth?.probe === true
    this.closingIntentionally = false
    this.demotingCandidate = false

    socket.onopen = () => {
      this.retries = 0
      this.setStatus('STREAMING')
      deviceLog().info('Stream connected', {
        url: url.toString(),
        path: profile.path,
        ...(auth ? { handshakeAuth: auth.id, handshakeAuthDescription: auth.description } : {})
      })

      // A candidate that opens but never delivers is indistinguishable from a
      // server that accepted the upgrade and then ignored an unauthorised
      // client. Arm the silent-candidate timer BEFORE the first frame, so a
      // stream that produces nothing still advances the candidate list — but
      // only when a next candidate actually exists (probing the last one just
      // churns the connection) and only for a stream expected to push (see
      // `StreamProfile.probeHandshake`).
      const lastCandidate = (this.candidates?.length ?? 1) - 1
      if (
        auth?.probe === true &&
        profile.probeHandshake !== false &&
        this.candidateIndex < lastCandidate
      ) {
        this.armCandidateProbe(socket)
      }

      const body = this.pingBodyFor(channel)

      // Send immediately, then on the measured cadence: waiting a full interval
      // for the first frame would make every stream look slow to start.
      const ping = (): void => {
        if (socket.readyState === 1) socket.send(body)
      }
      ping()
      this.pingTimer = setInterval(ping, profile.pingIntervalMs)
      this.pingTimer.unref?.()
    }

    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event)
    }

    socket.onerror = () => {
      // The WebSocket error event carries no useful detail in Node or Chromium,
      // so the close event is where the real reason is reported.
      deviceLog().debug('Stream socket error', { path: profile.path })
    }

    socket.onclose = (event: { code: number; reason?: string }) => {
      if (this.stopped) return
      // A candidate that closed before it was confirmed gets one chance to
      // explain itself: if the socket died while still a guess, the next
      // candidate is the more likely explanation.
      const reason = event.reason ? `${event.code} ${event.reason}` : `code ${event.code}`
      this.advanceCandidateAfterFailure(socket, reason)
      this.scheduleReconnect(reason)
    }
  }

  /**
   * Build the handshake URL (and the description of what was used).
   *
   * With no candidates this is byte-for-byte the measured AE08 behaviour, so
   * the existing device family cannot be affected by this code path.
   */
  private buildHandshake(
    baseWsUrl: string,
    path: string,
    headers: Record<string, string>,
    channel: number | undefined
  ): { socket: URL; auth?: { id: string; description: string; probe: boolean } } {
    const url = new URL(baseWsUrl.replace(/\/+$/, '') + path)
    const candidates = this.candidates

    if (!candidates) {
      // The auth token is passed as a query parameter as well as a header: the
      // browser WebSocket API cannot set arbitrary headers, and some deployments
      // gate the HTTP upgrade on the query form. Sending both is harmless and
      // maximises the chance of the upgrade succeeding.
      const token = headers.token ?? headers.Authorization
      if (token) url.searchParams.set('token', token)
      void channel
      return { socket: url }
    }

    const candidate = candidates[Math.min(this.candidateIndex, candidates.length - 1)]
    if (!candidate || candidate.kind === 'none') {
      return { socket: url, ...(candidate ? { auth: candidateInfo(candidate, true) } : {}) }
    }

    const token = headers.token ?? headers.Authorization ?? headers['X-Token']
    if (token && candidate.name) {
      // NOTE: the WebSocket API this project uses (`new WebSocket(url)`, the
      // global available in Node 22 and Electron 38 — see the file header)
      // CANNOT set request headers. A candidate named `header` is therefore
      // carried as a same-named QUERY parameter, which is the only form a
      // browser-like runtime can actually put on the wire. Whether a real
      // FA371 wants a header can only be answered by a runtimes that can set
      // one; the candidate is kept distinct so the finding is not lost.
      url.searchParams.set(candidate.name, token)
    }

    return { socket: url, auth: candidateInfo(candidate, !this.candidateConfirmed) }
  }

  /**
   * Arm the "opened but silent" timer for a candidate.
   *
   * The budget is deliberately generous: `/voiceprintData` and `/pcmData` push
   * once per second per the manual, so a healthy socket always delivers well
   * inside it, while a wrong-token socket that the server left open produces
   * nothing at all and is caught.
   */
  private armCandidateProbe(socket: WebSocket): void {
    if (this.candidateTimer) clearTimeout(this.candidateTimer)
    const budget = this.options.candidateProbeMs ?? 4_000
    this.candidateTimer = setTimeout(() => {
      this.candidateTimer = undefined
      if (this.stopped || this.candidateConfirmed) return
      if (this.socket !== socket) return
      deviceLog().warn('Handshake candidate opened but delivered nothing; trying the next one', {
        path: this.options.profile.path,
        candidate: this.handshakeAuthId,
        budgetMs: budget
      })
      this.candidateIndex = Math.min(this.candidateIndex + 1, (this.candidates?.length ?? 1) - 1)
      // The close below fires `onclose`; the flag keeps it from advancing the
      // candidate list a second time (see `demotingCandidate`).
      this.demotingCandidate = true
      this.closingIntentionally = true
      try {
        socket.close()
      } catch {
        // Already closing. The probe timer already recorded the advance, so
        // there is nothing to undo here.
        this.closingIntentionally = false
      }
    }, budget)
    this.candidateTimer.unref?.()
  }

  /** Advance past a candidate that failed, unless it was already proven. */
  private advanceCandidateAfterFailure(socket: WebSocket, reason: string): void {
    if (!this.candidates || this.candidateConfirmed) return
    if (this.socket !== socket) return
    if (this.demotingCandidate) return
    const last = this.candidates.length - 1
    if (this.candidateIndex >= last) return
    deviceLog().info('Handshake candidate rejected; trying the next one', {
      path: this.options.profile.path,
      candidate: this.handshakeAuthId,
      reason
    })
    this.candidateIndex += 1
  }

  /**
   * Rewrite the profile's ping body with the requested channel.
   *
   * `channelInPing` can force the channel into a profile that normally carries
   * none — see the option's comment: that is the `/features_stream`
   * multi-channel experiment, and it is the ONLY caller of the flag.
   */
  private pingBodyFor(channel: number | undefined): string {
    const { profile, channelInPing } = this.options
    const carries = profile.carriesChannel || channelInPing === true
    if (!carries || channel === undefined) return profile.pingBody
    // `channel` must be a STRING — that is what the device's own UI sends.
    return `{"type": "ping", "channel": "${channel}"}`
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data

    let bytes: Uint8Array
    let binary = true

    if (typeof data === 'string') {
      binary = false
      bytes = new TextEncoder().encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (data instanceof Blob) {
      // Should not happen: binaryType is set to arraybuffer. Handled anyway so a
      // runtime that ignores the hint degrades to working rather than silent.
      void data.arrayBuffer().then((buffer) => {
        this.emitFrame(new Uint8Array(buffer), true)
      })
      return
    } else {
      deviceLog().warn('Stream produced an unsupported frame type', {
        path: this.options.profile.path,
        type: typeof data
      })
      return
    }

    this.emitFrame(bytes, binary)
  }

  private emitFrame(bytes: Uint8Array, binary: boolean): void {
    this.framesReceived += 1
    if (!this.firstFrameAt) this.firstFrameAt = Date.now()

    // A frame is the proof that the handshake candidate was right. Confirm it
    // BEFORE announcing the frame, so a consumer reacting to the frame already
    // sees a confirmed carrier. `setStatus` is deliberately NOT called again
    // here: the caller can read `handshakeAuthConfirmed`, and re-emitting the
    // same state on every first frame would double the status pushes for no
    // new information (the frame itself is the signal).
    if (this.probingCandidate && !this.candidateConfirmed) {
      this.candidateConfirmed = true
      this.probingCandidate = false
      if (this.candidateTimer) {
        clearTimeout(this.candidateTimer)
        this.candidateTimer = undefined
      }
      const candidate = this.candidates?.[this.candidateIndex]
      if (candidate) {
        deviceLog().info('WebSocket handshake auth resolved', {
          path: this.options.profile.path,
          handshakeAuthId: candidate.id,
          handshakeAuth: candidate.description
        })
      }
    }

    const frame: StreamFrame = {
      sequence: this.sequence++,
      binary,
      bytes,
      receivedAt: Date.now()
    }

    this.status.lastFrameAt = frame.receivedAt

    try {
      this.options.onFrame?.(frame)
    } catch (error) {
      // A consumer bug must not kill the subscription.
      deviceLog().warn('Stream frame handler threw', {
        path: this.options.profile.path,
        reason: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimers()
    if (this.stopped) return
    // A close we asked for (a demoted candidate) is not a transport failure, so
    // it must not consume a backoff step: the next candidate is tried at once.
    if (this.closingIntentionally) {
      this.closingIntentionally = false
      this.connect()
      return
    }

    this.retries += 1
    const ceiling = this.options.maxReconnectDelayMs ?? 15_000
    // Exponential backoff with jitter: several devices dropping at once must not
    // reconnect in lockstep and hammer the network.
    const base = Math.min(500 * 2 ** (this.retries - 1), ceiling)
    const delay = Math.round(base * (0.75 + Math.random() * 0.5))

    this.setStatus('RECONNECTING', reason)
    deviceLog().warn('Stream disconnected; will retry', {
      path: this.options.profile.path,
      retries: this.retries,
      delayMs: delay,
      reason
    })

    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.candidateTimer) {
      clearTimeout(this.candidateTimer)
      this.candidateTimer = undefined
    }
  }

  private setStatus(state: StreamState, lastError?: string): void {
    const handshakeAuthId = this.handshakeAuthId
    this.status = {
      state,
      retries: this.retries,
      ...(this.status.lastFrameAt !== undefined ? { lastFrameAt: this.status.lastFrameAt } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(handshakeAuthId !== undefined ? { handshakeAuthId } : {})
    }
    this.options.onStatus?.(this.currentStatus)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Describe a candidate for the `connected` log line and the status payload. */
function candidateInfo(
  candidate: HandshakeAuthCandidate,
  probe: boolean
): { id: string; description: string; probe: boolean } {
  return { id: candidate.id, description: candidate.description, probe }
}

/** Derive the WebSocket origin from a device's HTTP base URL. */
export function toWebSocketUrl(httpBaseUrl: string): string {
  const trimmed = httpBaseUrl.trim().replace(/\/+$/, '')
  if (/^wss?:\/\//i.test(trimmed)) return trimmed
  if (/^https:\/\//i.test(trimmed)) return trimmed.replace(/^https:/i, 'wss:')
  if (/^http:\/\//i.test(trimmed)) return trimmed.replace(/^http:/i, 'ws:')
  return `ws://${trimmed}`
}

/**
 * Subscribe to a stream for a bounded window and report what arrived.
 *
 * This is the measurement primitive the Protocol Lab uses. It exists because a
 * stream that never terminates cannot be characterised by a request/response
 * probe — the only way to learn its framing is to subscribe, watch, and stop.
 */
export async function sampleStream(options: {
  baseWsUrl: string
  profile: StreamProfile
  headers: Record<string, string>
  channel?: number
  durationMs?: number
  /** Cap on captured frames; the audio stream delivers ten per second. */
  maxFrames?: number
}): Promise<{
  connected: boolean
  frameCount: number
  binaryFrames: number
  textFrames: number
  firstFrame?: StreamFrame
  frameSizes: number[]
  frameRate?: number
  error?: string
}> {
  const durationMs = options.durationMs ?? 3000
  const maxFrames = options.maxFrames ?? 30
  const frames: StreamFrame[] = []
  let connected = false
  let error: string | undefined

  const stream = new WebSocketStream({
    baseWsUrl: options.baseWsUrl,
    profile: options.profile,
    headers: options.headers,
    ...(options.channel !== undefined ? { channel: options.channel } : {}),
    onStatus: (status) => {
      if (status.state === 'STREAMING') connected = true
      if (status.state === 'RECONNECTING' && status.lastError) error = status.lastError
    },
    onFrame: (frame) => {
      if (frames.length < maxFrames) frames.push(frame)
    }
  })

  stream.start()
  await new Promise((resolve) => setTimeout(resolve, durationMs))

  const frameRate = stream.frameRate
  stream.stop()

  const binaryFrames = frames.filter((frame) => frame.binary).length
  const result: {
    connected: boolean
    frameCount: number
    binaryFrames: number
    textFrames: number
    firstFrame?: StreamFrame
    frameSizes: number[]
    frameRate?: number
    error?: string
  } = {
    connected,
    frameCount: frames.length,
    binaryFrames,
    textFrames: frames.length - binaryFrames,
    frameSizes: [...new Set(frames.map((frame) => frame.bytes.length))].sort((a, b) => a - b),
    ...(frames[0] ? { firstFrame: frames[0] } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(error !== undefined ? { error } : {})
  }

  return result
}

/** Guard used when a caller needs a stream profile that may not exist. */
export function requireProfile(key: keyof typeof STREAM_PROFILES): StreamProfile {
  const profile = STREAM_PROFILES[key]
  if (!profile) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `未知的流配置: ${String(key)}`)
  }
  return profile
}
