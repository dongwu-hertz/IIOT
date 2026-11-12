/**
 * DeviceApiClient — the single place that knows FA8 HTTP endpoints.
 *
 * Responsibilities (spec 5.1):
 *   - encapsulate REST calls, login, timeout, retry and response parsing
 *   - return PROTOCOL DTOs, never domain models (mapping is the mapper's job)
 *   - own the auth session lifecycle, including transparent re-login on 401
 *
 * Nothing above this class may build a device URL. That is what makes the
 * future `RemoteDeviceRepository` a drop-in swap rather than a rewrite
 * (spec section 15, appendix C rule 8).
 */

import { AppError, ErrorCodes } from '@shared/errors'
import { deviceLog } from '../logging/logger'
import { applyAuth, isAuthFailure, type AuthSession, type AuthStrategy } from './auth-strategy'
import { AuthStrategyResolver } from './auth-resolver'
import { buildUrl } from './auth-resolver'
import type { DeviceCredential } from './credential-store'
import { MAX_BUFFERED_BYTES, type HttpTransport } from './http-transport'
import type {
  AlarmAudioListDto,
  AudioListResponseDto,
  AvailableSerialDto,
  CurrentChannelDto,
  DatePushDto,
  DeleteAlarmSystemRequest,
  DeviceInfoDto,
  DownloadedRecording,
  EnvelopeDto,
  NetworkDto,
  PassagewayResponseDto,
  SamplingRateDto,
  SetAlarmSystemRequest,
  SetDatePushRequest,
  SetDeviceNameRequest,
  SetModbusRequest,
  SetNetworkRequest,
  SetPassagewayRequest,
  SetRs485Request,
  SetSamplingRateRequest,
  SetTimeSetRequest,
  SystemControlActionValue,
  SystemControlRequest
} from './protocol/dto'
import { isDeviceSuccessCode } from './protocol/mappers'
import { parseWavePayload } from '../audio/wave-parser'

/** Endpoint paths, transcribed from spec appendix A. */
export const ENDPOINTS = {
  login: '/login',
  getDevInfo: '/get_devinfo',
  /** Absent from the specification; the real device supports renaming. */
  setDevInfo: '/set_devinfo',
  getNetwork: '/get_network',
  setNetwork: '/set_network',
  getPassageway: '/get_passageway',
  setPassageway: '/set_passageway',
  getSamplingRate: '/get_samplingrate',
  setSamplingRate: '/set_samplingrate',
  getAlarmSystem: '/get_alarm_system',
  addAlarmSystem: '/add_alarm_system',
  delAlarmSystem: '/del_alarm_system',
  getTimeSet: '/get_timeset',
  setTimeSet: '/set_timeset',
  featuresStream: '/features_stream',
  audioStream: '/audio_stream',
  freqDomain: '/freq_domain',
  timeFreqDomain: '/time_freq_domain',
  getAudio: '/get_audio',
  /** AO01: GET /audio?alert_id=<dalId> returns the audio files for one alert. */
  getAudioByAlert: '/audio',
  getAlarmAudio: '/get_alarm_audio',
  deleteAudio: '/dele_audio',
  deleteAlarmAudio: '/dele_alarm_audio',
  getRs485: '/get_rs485',
  getAllAvailableSerial: '/get_all_available_serial',
  setRs485: '/set_rs485',
  getModbusPara: '/get_modbus_para',
  setModbusPara: '/set_modbus_para',
  upload: '/upload',
  systemControl: '/system_control',
  getDatePush: '/get_date_push',
  /**
   * Current channel of the DEVICE.
   *
   * GET, not PUT — verified against hardware: a PUT returns 501 Not Implemented
   * from nginx while a GET returns `{msgBody:{cur_ch:N}}`.
   */
  getCurrentChannel: '/get_cur_ch',
  /**
   * Switch the device's currently selected channel.
   *
   * MEASURED: `/features_stream` and `/freq_domain` carry NO channel argument in
   * their subscription ping — they report whichever channel the DEVICE has
   * selected. Without calling this, asking for CH2 still yields CH1's data, which
   * would make the channel tabs lie. Also valid channels only: the device rejects
   * a disabled channel.
   */
  channelSelect: '/channel_select',
  setDatePush: '/set_date_push',
  tcpPcm: '/tcp_pcm',
  voiceprintAnalyse: '/voiceprintAnalyse',
  voiceprintDataCollect: '/voiceprintDataCollect',
  /**
   * MEASURED and absent from the specification: alarm recordings are fetched by
   * FILENAME here, not via `/audio_file/{name}` as the spec's example implied.
   */
  downloadAudio: '/download_audio'
} as const

export interface DeviceApiClientOptions {
  transport: HttpTransport
  resolver: AuthStrategyResolver
  /** Base URL such as `http://192.168.1.50:80`, no trailing slash. */
  baseUrl: string
  credential: DeviceCredential
  /** Known-good strategy id, persisted per device after first resolution. */
  preferredStrategyId?: string
  timeoutMs?: number
  /** Called whenever a new session is established, so the caller can persist the strategy. */
  onSessionEstablished?: (strategyId: string) => void
}

/** Options every call accepts, so a long download can outlive the default timeout. */
export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** Cap on a buffered body. Only meaningful for binary downloads. */
  maxBytes?: number
}

export class DeviceApiClient {
  private readonly transport: HttpTransport
  private readonly resolver: AuthStrategyResolver
  private readonly credential: DeviceCredential
  private readonly timeoutMs: number
  private readonly onSessionEstablished?: (strategyId: string) => void

  private baseUrl: string
  private preferredStrategyId?: string
  private session?: AuthSession
  private strategy?: AuthStrategy
  /** De-duplicates concurrent logins: five parallel calls must not cause five /login hits. */
  private loginInFlight?: Promise<void>

  constructor(options: DeviceApiClientOptions) {
    this.transport = options.transport
    this.resolver = options.resolver
    this.credential = options.credential
    this.baseUrl = normaliseBaseUrl(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 8_000
    if (options.preferredStrategyId) this.preferredStrategyId = options.preferredStrategyId
    if (options.onSessionEstablished) this.onSessionEstablished = options.onSessionEstablished
  }

  get currentBaseUrl(): string {
    return this.baseUrl
  }

  /** Which carrier the device accepted, once known. */
  get resolvedStrategyId(): string | undefined {
    return this.strategy?.id
  }

  /**
   * Adopt a session discovered elsewhere (e.g. the "Add device" preview already
   * resolved auth, so adding it should not log in a second time).
   */
  adoptSession(session: AuthSession, strategy: AuthStrategy): void {
    this.session = session
    this.strategy = strategy
    this.preferredStrategyId = strategy.id
  }

  /** Point the client at a new address, e.g. after a network configuration change. */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normaliseBaseUrl(baseUrl)
  }

  /** Drop the session so the next call re-authenticates. */
  invalidateSession(): void {
    this.session = undefined
    this.strategy = undefined
  }

  // -------------------------------------------------------------------------
  // Core request plumbing
  // -------------------------------------------------------------------------

  /**
   * Perform an authenticated request, resolving auth on first use and
   * transparently re-logging-in once if the token is rejected mid-session.
   */
  private async call<T = unknown>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body: unknown | undefined,
    options: CallOptions = {},
    attempt = 0
  ): Promise<T> {
    await this.ensureSession(options)

    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')
    }

    const auth = applyAuth(session, strategy)
    const url = buildUrl(this.baseUrl + path, auth.query)
    const requestHeaders: Record<string, string> = { ...auth.headers }
    let requestBody: unknown = body

    // Strategies that put credentials in the body must merge them into this call.
    if (auth.body) {
      requestBody =
        body && typeof body === 'object' ? { ...(body as object), ...auth.body } : { ...auth.body }
    }

    const response = await this.transport.request({
      method,
      url,
      headers: requestHeaders,
      json: requestBody,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      throwOnHttpError: false
    })

    deviceLog().debug('Device call', {
      method,
      path,
      status: response.status,
      latencyMs: response.latencyMs,
      strategy: strategy.id
    })

    // Exactly one retry, and only for an auth failure — the token may have
    // expired. Anything else (5xx, timeout) is surfaced to the caller.
    if (isAuthFailure(response.status)) {
      if (attempt === 0) {
        deviceLog().info('Token rejected; re-authenticating once', { path, status: response.status })
        this.invalidateSession()
        return this.call<T>(path, method, body, options, attempt + 1)
      }
      throw new AppError(ErrorCodes.AUTH_FAILED, `设备拒绝认证 (HTTP ${response.status})`)
    }

    if (response.status < 200 || response.status >= 300) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `设备返回 HTTP ${response.status} (${path})`,
        response.text?.slice(0, 300)
      )
    }

    return this.unwrap<T>(response.json, path)
  }

  /**
   * Unwrap the device's response envelope.
   *
   * MEASURED wire format — used by every endpoint:
   *   `{ "message": "ok", "msgBody": { ... }, "result": 0 }`
   *
   * This differs from the specification, which assumed `{code, msg, data}`.
   * Looking for `data` on this firmware finds nothing and renders an empty
   * device, so `msgBody` is checked FIRST and `data` only as a fallback.
   *
   * Failure convention: `result !== 0`. Observed meanings:
   *   `2` on /login    -> credentials rejected
   *   `1` on /get_audio -> no records
   *
   * A bare payload is still accepted, since some endpoints may answer without
   * the envelope.
   */
  private unwrap<T>(payload: unknown, path: string): T {
    if (payload === null || payload === undefined) return undefined as T

    if (typeof payload === 'object' && !Array.isArray(payload)) {
      const envelope = payload as EnvelopeDto<T>

      const hasEnvelopeKey =
        'result' in envelope ||
        'msgBody' in envelope ||
        'message' in envelope ||
        'code' in envelope ||
        'success' in envelope

      if (hasEnvelopeKey) {
        if (!this.isSuccess(envelope)) {
          throw new AppError(
            ErrorCodes.DEVICE_ERROR,
            `设备返回错误: ${
              envelope.message ?? envelope.msg ?? String(envelope.result ?? envelope.code)
            }`,
            path
          )
        }

        // Verified success payload location.
        if ('msgBody' in envelope && envelope.msgBody !== undefined) {
          return envelope.msgBody as T
        }
        // Legacy alternatives, kept for other firmware revisions.
        if ('data' in envelope && envelope.data !== undefined) return envelope.data as T
        if ('result' in envelope && typeof envelope.result === 'object') {
          return envelope.result as T
        }
        // A success envelope with no payload key: hand back the envelope itself,
        // since some endpoints put their fields alongside `result`.
        return envelope as unknown as T
      }
    }

    return payload as T
  }

  /**
   * Decide whether an envelope means success.
   *
   * The device uses a numeric `result` where **0 means success** — a different
   * field AND a different convention from the `code` the specification assumed.
   * Getting this backwards would report every successful call as a failure, so
   * the two conventions are handled explicitly rather than by one loose check.
   */
  private isSuccess(envelope: EnvelopeDto): boolean {
    if (envelope.success === false) return false

    // Verified convention: numeric `result`, 0 = success.
    if (typeof envelope.result === 'number') return envelope.result === 0

    // `code`-style convention, retained for compatibility with other firmware.
    if (envelope.code !== undefined) return isDeviceSuccessCode(envelope.code)

    // Message-only envelope: anything other than a success word is a failure.
    if (typeof envelope.message === 'string' && envelope.message.trim() !== '') {
      const text = envelope.message.trim().toLowerCase()
      return text === 'ok' || text === 'success'
    }

    return true
  }

  /** Resolve auth exactly once, coalescing concurrent callers onto one login. */
  private async ensureSession(options: CallOptions): Promise<void> {
    if (this.session && this.strategy) return
    if (this.loginInFlight) return this.loginInFlight

    const login = async (): Promise<void> => {
      const result = await this.resolver.resolve({
        baseUrl: this.baseUrl,
        credential: this.credential,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        ...(this.preferredStrategyId ? { preferredStrategyId: this.preferredStrategyId } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      })
      this.session = result.session
      this.strategy = result.strategy
      this.preferredStrategyId = result.strategy.id
      this.onSessionEstablished?.(result.strategy.id)
    }

    this.loginInFlight = login().finally(() => {
      this.loginInFlight = undefined
    })
    return this.loginInFlight
  }

  /** Probe reachability without throwing. Used by the online-status monitor. */
  async ping(options: CallOptions = {}): Promise<boolean> {
    try {
      await this.getDeviceInfo(options)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Read endpoints
  // -------------------------------------------------------------------------

  getDeviceInfo(options: CallOptions = {}): Promise<DeviceInfoDto> {
    return this.call<DeviceInfoDto>(ENDPOINTS.getDevInfo, 'GET', undefined, options)
  }

  getNetwork(options: CallOptions = {}): Promise<NetworkDto> {
    return this.call<NetworkDto>(ENDPOINTS.getNetwork, 'GET', undefined, options)
  }

  getPassageway(options: CallOptions = {}): Promise<PassagewayResponseDto> {
    return this.call<PassagewayResponseDto>(ENDPOINTS.getPassageway, 'GET', undefined, options)
  }

  getSamplingRate(options: CallOptions = {}): Promise<SamplingRateDto> {
    return this.call<SamplingRateDto>(ENDPOINTS.getSamplingRate, 'GET', undefined, options)
  }

  getAlarmSystem(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getAlarmSystem, 'GET', undefined, options)
  }

  getTimeSet(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getTimeSet, 'GET', undefined, options)
  }

  getRs485(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getRs485, 'GET', undefined, options)
  }

  getAllAvailableSerial(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getAllAvailableSerial, 'GET', undefined, options)
  }

  getModbusPara(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getModbusPara, 'GET', undefined, options)
  }

  getDatePush(options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.getDatePush, 'GET', undefined, options)
  }

  // -------------------------------------------------------------------------
  // Push configuration (spec 11.4)
  // -------------------------------------------------------------------------

  /**
   * `PUT /set_date_push` — push (data egress) targets.
   *
   * MEASURED, and the same bug class as the two rename writes: a BARE body is
   * rejected with `Failed to set data push parameters.`; `{msgBody:<same object>}`
   * answers `{"message":"ok","result":0}` and the read-back is byte-identical.
   * The envelope is carried by the DTO — see `SetDatePushRequest`.
   */
  setDatePush(body: SetDatePushRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setDatePush, 'PUT', body, options)
  }

  /**
   * Read the device's currently selected channel.
   * Tolerates both envelope shapes seen on hardware.
   */
  async getCurrentChannel(options: CallOptions = {}): Promise<number | undefined> {
    const payload = (await this.call<CurrentChannelDto>(
      ENDPOINTS.getCurrentChannel,
      'GET',
      undefined,
      options
    )) as CurrentChannelDto
    const value = payload?.cur_ch
    if (value === undefined || value === null) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
  }

  /** Select the device's current channel; 0-7. Rejects a disabled channel. */
  channelSelect(channelId: number, options: CallOptions = {}): Promise<unknown> {
    return this.call(
      ENDPOINTS.channelSelect,
      'PUT',
      { msgBody: { cur_ch: Math.trunc(channelId) } },
      options
    )
  }

  // -------------------------------------------------------------------------
  // Device configuration writes (Phase 9)
  //
  // Every method below takes a STRICT payload type. The device replaces the
  // whole object, so a missing field resets rather than preserves — see the note
  // on the write DTOs. Services therefore read the current state, merge the
  // user's edit, and submit the complete object.
  //
  // ONE MEASURED EXCEPTION: `set_passageway` takes a SINGLE channel object and the
  // device keys it by `dchId` (the device's own UI posts one row per edit). Even
  // there, the five fields of that row all come from a read, so nothing is
  // invented — see `SetPassagewayRequest`.
  // -------------------------------------------------------------------------

  /** `PUT /set_samplingrate` — ENVELOPE MEASURED REQUIRED (see the DTO). Changing this restarts acquisition on the device. */
  setSamplingRate(body: SetSamplingRateRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setSamplingRate, 'PUT', body, options)
  }

  /**
   * `PUT /set_passageway` — rename / reconfigure ONE channel.
   *
   * MEASURED (device source map + value-preserving live probes): the body must be
   * `{ msgBody: { chinfoArray: <ONE channel object> } }`. Sending an array of all
   * eight channels, a one-element array, or no `msgBody` at all each make the
   * device answer `Failed, Please check the integrity of the data format.` The
   * device's own UI (`pages/Preference/PreferenceF.js:183-205`) posts one row.
   * The envelope is carried by the DTO, so this method passes the body through
   * unchanged — see `SetPassagewayRequest` for the full evidence.
   */
  setPassageway(body: SetPassagewayRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setPassageway, 'PUT', body, options)
  }

  /** `PUT /add_alarm_system` — creates when `dalId` is absent, updates otherwise.
   *
   * ⚠️ 信封**未验证**：真机值保持写探针下裸 `{alarmparaArray:[…]}` 与
   * `{msgBody:{alarmparaArray:[…]}}` 都失败了 —— 前者是
   * `Add/Update Alarm parameters Failed, Please check the integrity of the data format.`，
   * 后者是 `This parameter dalName is Duplicate or empty.`（错误文案变了，说明信封被接受、
   * 但内容被拒）。既没有证明带信封的形状**可用**，也没有证明它更正确，所以这里保持原样，
   * 只把结论记在 `docs/PROTOCOL-FINDINGS.md`。详见本轮报告与「未验证」清单。
   */
  setAlarmSystem(body: SetAlarmSystemRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.addAlarmSystem, 'PUT', body, options)
  }

  /** `PUT /del_alarm_system`. */
  deleteAlarmSystem(body: DeleteAlarmSystemRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.delAlarmSystem, 'PUT', body, options)
  }

  /**
   * `PUT /set_network`.
   *
   * DESTRUCTIVE TO THE SESSION: the device applies the new address immediately,
   * so the caller loses the connection it is talking over. ConfigService handles
   * the reconnect; this method deliberately does not try, because it cannot know
   * which address the caller wants to move to.
   */
  setNetwork(body: SetNetworkRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setNetwork, 'PUT', body, options)
  }

  /** `PUT /set_timeset` — ENVELOPE MEASURED REQUIRED (see the DTO). Also usable to sync the device clock to the host. */
  setTimeSet(body: SetTimeSetRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setTimeSet, 'PUT', body, options)
  }

  /** `PUT /set_rs485` — ENVELOPE MEASURED REQUIRED (see the DTO). */
  setRs485(body: SetRs485Request, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setRs485, 'PUT', body, options)
  }

  /** `PUT /set_modbus_para` — ENVELOPE MEASURED REQUIRED (see the DTO). */
  setModbusPara(body: SetModbusRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setModbusPara, 'PUT', body, options)
  }

  /**
   * `PUT /set_devinfo` — rename the device.
   *
   * MEASURED: `devname` must sit inside `msgBody` (`{msgBody:{devname}}`); a bare
   * `{devname}` is rejected with `Failed to modify device name.` The envelope is
   * carried by the DTO — see `SetDeviceNameRequest`.
   */
  setDeviceName(body: SetDeviceNameRequest, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.setDevInfo, 'PUT', body, options)
  }

  /** `PUT /get_rs485` companion: the serial ports the device can offer. */
  getAvailableSerial(options: CallOptions = {}): Promise<AvailableSerialDto> {
    return this.call<AvailableSerialDto>(ENDPOINTS.getAllAvailableSerial, 'GET', undefined, options)
  }

  /** `GET /get_date_push`. */
  getPushConfig(options: CallOptions = {}): Promise<DatePushDto> {
    return this.call<DatePushDto>(ENDPOINTS.getDatePush, 'GET', undefined, options)
  }

  // -------------------------------------------------------------------------
  // Maintenance (Phase 10)
  // -------------------------------------------------------------------------

  /**
   * `PUT /system_control` — DESTRUCTIVE.
   *
   * The UI is responsible for the confirmation guard; this method performs the
   * action and nothing else. After a factory reset or reboot the session is
   * invalid, so callers must expect the next request to need re-authentication.
   */
  systemControl(
    action: SystemControlActionValue,
    options: CallOptions = {}
  ): Promise<unknown> {
    const body: SystemControlRequest = { control_type: action }
    return this.call(ENDPOINTS.systemControl, 'PUT', body, options)
  }

  /**
   * `POST /upload` — firmware package upload.
   *
   * MEASURED: multipart/form-data with the package under the field name `file`.
   * The device's own web UI sends this with a bare XMLHttpRequest and NO
   * authentication header at all; this implementation still sends the token,
   * because the client should not depend on the device failing to check.
   *
   * NOT a JSON call: `call()` always serialises JSON, so this bypasses it and
   * goes straight to the transport. The timeout is generous because a firmware
   * image is tens of megabytes and an abort mid-upload can leave the device in
   * a bad state.
   */
  async uploadFirmware(
    fileName: string,
    bytes: Uint8Array,
    options: CallOptions & { onProgress?: (sent: number, total: number) => void } = {}
  ): Promise<unknown> {
    await this.ensureSession(options)
    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')

    const auth = applyAuth(session, strategy)
    const form = new FormData()
    // The field name is verified; a copy is made because a Uint8Array view can
    // be backed by a larger buffer, which Blob would send in full.
    const payload = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    form.append('file', new Blob([payload]), fileName)

    const url = buildUrl(this.baseUrl + ENDPOINTS.upload, auth.query)
    // Progress is reported by the transport once it supports streaming uploads;
    // for now the total is known so the UI can show an indeterminate state
    // rather than a fake percentage.
    options.onProgress?.(0, bytes.byteLength)

    const response = await this.transport.request({
      method: 'POST',
      url,
      headers: auth.headers,
      rawBody: form,
      timeoutMs: options.timeoutMs ?? 600_000,
      signal: options.signal,
      throwOnHttpError: false
    })

    if (!response.ok) {
      throw new AppError(
        ErrorCodes.DEVICE_ERROR,
        `固件上传失败 (HTTP ${response.status})`,
        response.text?.slice(0, 300)
      )
    }

    options.onProgress?.(bytes.byteLength, bytes.byteLength)
    return response.json ?? response.text
  }

  // -------------------------------------------------------------------------
  // Audio library

  // -------------------------------------------------------------------------

  /**
   * `PUT /get_alarm_audio` — alarm recordings (spec 10.3).
   *
   * MEASURED TRAP: the request body MUST be `{ msgBody: { page_start, page_size } }`.
   *   - an empty body returns `{"message":"Failed to obtain audio record.","result":1}`,
   *     which reads as "the device has no recordings" but actually means
   *     "your request was malformed";
   *   - a body without the `msgBody` wrapper returns an nginx error page.
   *
   * Both failure modes are silent from the caller's perspective, so this method
   * builds the correct envelope itself rather than trusting the caller to.
   *
   * VERIFIED response: `{ allSize: 10000, audioArray: [ ... ] }`.
   */
  queryAlarmAudio(
    page: { pageStart?: number; pageSize?: number } = {},
    options: CallOptions = {}
  ): Promise<AlarmAudioListDto> {
    return this.call<AlarmAudioListDto>(
      ENDPOINTS.getAlarmAudio,
      'PUT',
      {
        msgBody: {
          page_start: page.pageStart ?? 0,
          // The device's own UI requests 12 per page; larger pages were rejected
          // with an nginx error during probing, so this stays conservative.
          page_size: page.pageSize ?? 12
        }
      },
      // A page of alarm metadata is small, but the device is slow to enumerate
      // a 10000-record library, so this gets more headroom than a config read.
      { timeoutMs: 20_000, ...options }
    )
  }

  /**
   * `PUT /get_audio` — the generic audio library.
   *
   * MEASURED: this endpoint returns an nginx 404 for every request body tried,
   * including the `msgBody`-wrapped pagination form that `/get_alarm_audio`
   * accepts. The device's own web UI references it, but this firmware does not
   * serve it.
   *
   * It is retained rather than deleted because a different firmware revision
   * may implement it; callers must treat a failure here as expected and fall
   * back to `queryAlarmAudio`, which is the endpoint that actually works.
   */
  queryAudio(body: unknown = { msgBody: { page_start: 0, page_size: 12 } }, options: CallOptions = {}): Promise<AudioListResponseDto> {
    return this.call<AudioListResponseDto>(ENDPOINTS.getAudio, 'PUT', body, options)
  }

  /**
   * AO01: `GET /audio?alert_id=<dalId>` — audio file(s) attached to one alarm.
   *
   * Different from `queryAudio` (PUT `/get_audio`, the general library): the
   * AO01 alarm row (`alertArray`/`dal*`) does not carry a filename, only the
   * alert id. The download key lives here.
   */
  getAudioByAlert(
    alertId: number,
    options: CallOptions = {}
  ): Promise<AudioListResponseDto> {
    const query = `?alert_id=${encodeURIComponent(String(alertId))}`
    return this.call<AudioListResponseDto>(
      `${ENDPOINTS.getAudioByAlert}${query}`,
      'GET',
      undefined,
      options
    )
  }

  deleteAudio(body: unknown, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.deleteAudio, 'PUT', body, options)
  }

  deleteAlarmAudio(body: unknown, options: CallOptions = {}): Promise<unknown> {
    return this.call(ENDPOINTS.deleteAlarmAudio, 'PUT', body, options)
  }

  /**
   * Download one alarm recording.
   *
   * MEASURED (spec risk 6 — RESOLVED): the path is
   *   `GET /download_audio/{dauFileName}`
   * where `dauFileName` is the field from `/get_alarm_audio`, e.g.
   * `1_alarm_20260911134155.wav`. The filename **includes the extension**.
   *
   * The specification's `/audio_file/{filename}` does **not exist** on this
   * firmware — it returns the SPA's index.html with HTTP 200, which is the most
   * deceptive possible failure: the caller sees a successful response whose body
   * is HTML.
   *
   * VERIFIED RESULT: a valid RIFF/WAVE file, 3,840,080 bytes for 10 s of mono
   * 96 kHz 32-bit float audio. `content-type` is `application/octet-stream`, so
   * the format can only be established from the magic bytes.
   *
   * AUTHENTICATION: the device serves this endpoint WITHOUT a token. The header
   * is still sent (harmless, and required by other firmware), but the Manager
   * must not treat its own credentials as the thing protecting this data. See
   * docs/PROTOCOL-FINDINGS.md for the security note.
   */
  async downloadRecording(
    fileName: string,
    options: CallOptions = {}
  ): Promise<DownloadedRecording> {
    if (!fileName || fileName.trim() === '') {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, '录音文件名为空')
    }

    await this.ensureSession(options)
    const session = this.session
    const strategy = this.strategy
    if (!session || !strategy) throw new AppError(ErrorCodes.AUTH_FAILED, '设备会话不可用')

    const auth = applyAuth(session, strategy)
    const path = `${ENDPOINTS.downloadAudio}/${encodeURIComponent(fileName.trim())}`

    const response = await this.transport.request({
      method: 'GET',
      url: buildUrl(this.baseUrl + path, auth.query),
      headers: auth.headers,
      // A 10 s recording is ~3.8 MB; a longer one is proportionally bigger, so
      // this timeout is generous and the body is streamed to disk by the caller.
      timeoutMs: options.timeoutMs ?? 180_000,
      signal: options.signal,
      binary: true,
      // Recordings are large; raising the default 8 MB cap would let a 10-minute
      // capture exhaust memory. The caller writes chunks to disk instead.
      maxBytes: options.maxBytes ?? MAX_BUFFERED_BYTES
    })

    if (!response.ok || !response.bytes) {
      throw new AppError(ErrorCodes.DEVICE_ERROR, `下载录音失败 (HTTP ${response.status})`, fileName)
    }

    return parseWavePayload(response.bytes, response.contentType)
  }

  // -------------------------------------------------------------------------
  // Streaming URLs
  // -------------------------------------------------------------------------

  /**
   * Build an authenticated URL for a streaming endpoint.
   *
   * The stream services consume these. Header/cookie strategies are applied by
   * the caller through `authHeaderForStream()`; query strategies are baked into
   * the URL here. This indirection exists because the framing of
   * `/audio_stream` is still unverified (spec section 19, risk 2) and the
   * consumer may end up being a WebSocket, a chunked HTTP reader, or raw TCP.
   */
  buildStreamUrl(path: string): string {
    if (!this.session || !this.strategy) {
      throw new AppError(ErrorCodes.AUTH_FAILED, '需要先建立会话来构建流地址')
    }
    const auth = applyAuth(this.session, this.strategy)
    return buildUrl(this.baseUrl + path, auth.query)
  }

  authHeaderForStream(): Record<string, string> {
    if (!this.session || !this.strategy) return {}
    return applyAuth(this.session, this.strategy).headers
  }

  /** Ensure a session exists before the caller opens a stream. */
  async prepareStream(options: CallOptions = {}): Promise<void> {
    await this.ensureSession(options)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept `192.168.1.50`, `192.168.1.50:8080`, or a full URL; return a clean origin. */
export function normaliseBaseUrl(input: string, defaultPort = 80): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new AppError(ErrorCodes.VALIDATION_ERROR, '设备地址不能为空')

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    // An explicit default port is stripped so two spellings of the same device
    // do not look like two different endpoints.
    if (
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')
    ) {
      url.port = ''
    }
    if (!url.port && defaultPort !== 80 && defaultPort !== 443) url.port = String(defaultPort)
    return url.origin
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, `设备地址格式不正确: ${input}`)
  }
}
