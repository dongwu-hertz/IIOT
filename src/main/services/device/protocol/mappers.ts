/**
 * DTO -> Domain Model mappers (spec section 7).
 *
 *   Protocol DTO  ->  [THIS FILE]  ->  Domain Model  ->  Store  ->  UI
 *
 * This is the ONLY place in the codebase allowed to know both vocabularies.
 * Everything downstream sees stable camelCase domain fields; everything
 * upstream (DeviceApiClient) sees firmware wire names.
 *
 * Design rules applied throughout:
 *   - Missing data yields `undefined`, never NaN or 0. A silent 0 for SPL would
 *     render as a real reading and mislead an operator.
 *   - Timestamps are normalised to epoch MILLISECONDS. Firmware variously sends
 *     seconds, milliseconds, or a string; magnitude disambiguates.
 *   - Out-of-range values are clamped where the domain has a defined range.
 */

import {
  CHANNEL_COUNT,
  SensorType,
  type Channel,
  type DetectionType,
  type DeviceInfo,
  type RealtimeFeature,
  type Recording
} from '@shared/domain/models'
import { clamp, isFiniteNumber, newRecordingId, toNumber } from '@shared/utils/id'
import type {
  AlarmAudioDto,
  AudioRecordDto,
  DeviceInfoDto,
  FeatureFrameDto,
  NetworkDto,
  PassagewayDto,
  SamplingRateDto
} from './dto'

// ---------------------------------------------------------------------------
// Field extraction helpers
// ---------------------------------------------------------------------------

/** First defined value among the candidate keys. */
function pick<T = unknown>(source: Record<string, unknown>, keys: readonly string[]): T | undefined {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value as T
  }
  return undefined
}

/** First key that parses to a finite number. */
function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = toNumber(source[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** First non-empty string among the candidate keys. */
function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const value = pick(source, keys)
  if (value === undefined) return undefined
  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

function pickBoolean(source: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  const value = pick(source, keys)
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', 'enable', 'enabled'].includes(text)) return true
  if (['0', 'false', 'off', 'no', 'disable', 'disabled'].includes(text)) return false
  return undefined
}

/**
 * Normalise a firmware timestamp to epoch milliseconds.
 *
 * Heuristic by magnitude, which is unambiguous for any plausible date:
 *   < 1e11  -> seconds  (2026 in seconds is ~1.77e9)
 *   >= 1e11 -> already milliseconds
 * Also accepts ISO-8601 strings.
 */
export function toEpochMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined

  if (typeof value === 'string') {
    const trimmed = value.trim()
    // ISO-ish strings: "2026-02-26 14:05:33" or "2026-02-26T14:05:33Z"
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const parsed = Date.parse(trimmed.replace(' ', 'T'))
      if (Number.isFinite(parsed)) return parsed
    }
    // Numeric strings fall through to the magnitude logic.
  }

  const numeric = toNumber(value)
  if (numeric === undefined || numeric <= 0) return undefined
  // 1e11 ms ≈ 1973; anything below is certainly seconds.
  return numeric < 1e11 ? Math.round(numeric * 1000) : Math.round(numeric)
}

/**
 * Normalise a duration to milliseconds.
 * Durations of a few thousand are ambiguous, so the boundary is chosen by
 * what is physically plausible for an alarm clip (1-600 s):
 *   value <= 600 -> seconds; otherwise assume milliseconds.
 */
export function toDurationMs(value: unknown): number | undefined {
  const numeric = toNumber(value)
  if (numeric === undefined || numeric < 0) return undefined
  return numeric <= 600 ? Math.round(numeric * 1000) : Math.round(numeric)
}

// ---------------------------------------------------------------------------
// Device info (GET /get_devinfo)
// ---------------------------------------------------------------------------

/**
 * Build the stable device identity (spec 6.1 `deviceUid`).
 *
 * Priority: explicit serial / device id -> **MAC** -> name.
 *
 * MEASURED BEHAVIOUR: the AE08 firmware returns NEITHER a serial NOR a
 * device_id — only `dev_mac`. So on current hardware the MAC path is the one
 * that actually executes, which is exactly the fallback spec section 6.1
 * anticipated ("无 SN 时暂用 MAC").
 *
 * The `mac:` prefix is not cosmetic: without it a MAC-shaped serial reported by
 * some future firmware would collide with a real MAC and silently merge two
 * different devices into one row.
 *
 * IP is deliberately never used, because IP is a connection address.
 * Returns undefined when the payload carries no usable identity at all, which
 * lets the caller reject the device as "not a HERTZINNO device" instead of
 * inventing a fake uid.
 */
export function resolveDeviceUid(dto: DeviceInfoDto): string | undefined {
  const source = dto as Record<string, unknown>

  // Device-reported serial, when a firmware revision provides one.
  const serial = pickString(source, [
    'device_id',
    'deviceId',
    'sn',
    'serial',
    'serial_number'
  ])
  if (serial) return serial

  // Verified path on AE08. `dev_mac` is the field the device actually sends.
  const mac = normaliseMac(pickString(source, ['dev_mac', 'mac', 'mac_address', 'macAddress']))
  if (mac) return `mac:${mac}`

  return undefined
}

/** Canonical lowercase colon-separated MAC, or undefined if it is not a MAC. */
export function normaliseMac(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hex = value.replace(/[^0-9a-fA-F]/g, '')
  if (hex.length !== 12) return undefined
  return (hex.toLowerCase().match(/.{2}/g) ?? []).join(':')
}

export function mapDeviceInfo(dto: DeviceInfoDto): DeviceInfo | undefined {
  const source = dto as Record<string, unknown>
  const deviceUid = resolveDeviceUid(dto)
  if (!deviceUid) return undefined

  const channelCountRaw = pickNumber(source, [
    'channel_num',
    'channelNum',
    'channel_count',
    'channelCount',
    'channels'
  ])
  // The AE08 does not report a channel count at all, so the default of 8 is the
  // normal path here, not an error path. The authoritative count comes from
  // GET /get_passageway, which the channel refresh uses.
  const channelCount =
    channelCountRaw && channelCountRaw > 0 && channelCountRaw <= 64
      ? Math.floor(channelCountRaw)
      : CHANNEL_COUNT

  const info: DeviceInfo = {
    // Verified device name field is `devname` (e.g. "AE08").
    name:
      pickString(source, ['devname', 'name', 'device_name', 'deviceName']) ??
      `Acoustic Box ${deviceUid}`,
    deviceUid,
    channelCount
  }

  const mac = normaliseMac(
    pickString(source, ['dev_mac', 'mac', 'mac_address', 'macAddress'])
  )
  if (mac) info.mac = mac
  // Verified firmware version field is `dev_version`.
  const firmware = pickString(source, [
    'dev_version',
    'device_version',
    'deviceVersion',
    'version',
    'firmware_version'
  ])
  if (firmware) info.firmwareVersion = firmware
  const fpga = pickString(source, ['fpga_version', 'fpgaVersion'])
  if (fpga) info.fpgaVersion = fpga
  const web = pickString(source, ['web_version', 'webVersion'])
  if (web) info.webVersion = web

  return info
}

/**
 * Does this payload look like a HERTZINNO Acoustic Box?
 * Used by network scanning (spec 13.1) to filter out unrelated HTTP servers.
 *
 * `dev_mac` / `devname` are the fields the real AE08 sends, so they are checked
 * first; the generic names keep this working across firmware revisions.
 */
export function looksLikeHertzinnoDevice(dto: unknown): boolean {
  if (!dto || typeof dto !== 'object') return false
  const source = dto as Record<string, unknown>
  const hasIdentity = Boolean(
    pickString(source, [
      'dev_mac',
      'device_id',
      'deviceId',
      'sn',
      'mac',
      'mac_address',
      'macAddress'
    ])
  )
  const hasFirmwareMarkers = Boolean(
    pickString(source, [
      'fpga_version',
      'fpgaVersion',
      'web_version',
      'webVersion',
      'dev_version',
      'device_version',
      'devname'
    ])
  )
  return hasIdentity || hasFirmwareMarkers
}

// ---------------------------------------------------------------------------
// Network (GET /get_network)
// ---------------------------------------------------------------------------

export interface NetworkConfig {
  ip?: string
  netmask?: string
  gateway?: string
  dns?: string
  httpPort?: number
  rtspPort?: number
  tcpPort?: number
  mac?: string
  /**
   * Addressing mode, verified as a STRING on the real device (`"manual"`).
   *
   * Replaces the previous boolean `dhcp` flag: a boolean cannot distinguish
   * "automatic" from "an unrecognised mode", and the firmware already models
   * this as an enum.
   */
  ipMode?: string
}

/**
 * Map `GET /get_network`.
 *
 * MEASURED: every field carries the `dsy` prefix —
 * `dsyIPAdder`, `dsyIPMask`, `dsyIPGateway`, `dsyDNSAdder`, `dsyHTTPPort`,
 * `dsyRTSPPort`, `dsyTCPPort`, `dsyIPMode`.
 *
 * RESOLVES SPEC RISK 7: on real hardware the ports are genuine values
 * (80 / 28003 / 28001), not `0`. A represented `0` is therefore preserved
 * verbatim rather than "corrected" — it may legitimately mean "unset", and
 * silently substituting a default would hide that from an operator.
 */
export function mapNetwork(dto: NetworkDto): NetworkConfig {
  const source = dto as Record<string, unknown>
  const config: NetworkConfig = {}

  const ip = pickString(source, ['dsyIPAdder', 'ip', 'ip_address', 'ipAddress'])
  if (ip) config.ip = ip
  const netmask = pickString(source, ['dsyIPMask', 'netmask', 'subnet_mask', 'subnetMask'])
  if (netmask) config.netmask = netmask
  const gateway = pickString(source, ['dsyIPGateway', 'gateway', 'gw'])
  if (gateway) config.gateway = gateway
  const dns = pickString(source, ['dsyDNSAdder', 'dns', 'dns_server'])
  if (dns) config.dns = dns
  const mac = normaliseMac(pickString(source, ['dev_mac', 'mac', 'mac_address', 'macAddress']))
  if (mac) config.mac = mac

  const httpPort = pickNumber(source, ['dsyHTTPPort', 'http_port', 'httpPort'])
  if (httpPort !== undefined) config.httpPort = httpPort
  const rtspPort = pickNumber(source, ['dsyRTSPPort', 'rtsp_port', 'rtspPort'])
  if (rtspPort !== undefined) config.rtspPort = rtspPort
  const tcpPort = pickNumber(source, ['dsyTCPPort', 'tcp_port', 'tcpPort'])
  if (tcpPort !== undefined) config.tcpPort = tcpPort

  const ipMode = pickString(source, ['dsyIPMode', 'ip_mode', 'ipMode'])
  if (ipMode) config.ipMode = ipMode
  else {
    // Legacy fallback for firmware that only exposes a boolean.
    const dhcp = pickBoolean(source, ['dhcp', 'is_dhcp'])
    if (dhcp !== undefined) config.ipMode = dhcp ? 'dhcp' : 'manual'
  }

  return config
}

// ---------------------------------------------------------------------------
// Channels (GET /get_passageway)
// ---------------------------------------------------------------------------

/** Unwrap whichever envelope the firmware used, or a bare array. */
export function extractArray<T>(payload: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (!payload || typeof payload !== 'object') return []
  const source = payload as Record<string, unknown>
  for (const key of keys) {
    const value = source[key]
    if (Array.isArray(value)) return value as T[]
  }
  // One level of envelope nesting, e.g. { data: { list: [...] } }
  for (const key of ['data', 'result']) {
    const nested = source[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = extractArray<T>(nested, keys)
      if (found.length > 0) return found
    }
  }
  return []
}

export interface ChannelConfig {
  channelIndex: number
  channelName: string
  sensorType: SensorType
  enabled: boolean
  remoteAlarmId?: number
}

export function mapChannel(dto: PassagewayDto, fallbackIndex: number): ChannelConfig | undefined {
  const source = dto as Record<string, unknown>

  // Verified field names carry the `dch` prefix: dchId, dchName, dchEn,
  // dchSensorType, dchAlarmPara.
  const rawIndex = pickNumber(source, ['dchId', 'channel_id', 'channelId', 'id', 'index'])
  const channelIndex = rawIndex !== undefined ? Math.floor(rawIndex) : fallbackIndex
  if (channelIndex < 0 || channelIndex >= CHANNEL_COUNT) return undefined

  const sensorRaw = pickNumber(source, ['dchSensorType', 'sensor_type', 'sensorType'])
  const sensorType =
    sensorRaw === SensorType.Conduction ? SensorType.Conduction : SensorType.Microphone

  const config: ChannelConfig = {
    channelIndex,
    channelName:
      pickString(source, ['dchName', 'channel_name', 'channelName', 'name']) ??
      `CH${channelIndex + 1}`,
    sensorType,
    enabled: pickBoolean(source, ['dchEn', 'enable', 'enabled']) ?? true
  }

  // `dchAlarmPara` binds the channel to an alarm profile id (`dalId`).
  const remoteAlarmId = pickNumber(source, [
    'dchAlarmPara',
    'alarm_id',
    'alarmId',
    'alarm_system_id',
    'alarmSystemId'
  ])
  if (remoteAlarmId !== undefined) config.remoteAlarmId = remoteAlarmId

  return config
}

/**
 * Map `GET /get_passageway`.
 *
 * MEASURED: the array lives under **`chinfoArray`**. The specification mentions
 * no such key, so a mapper searching only for `passageway`/`channels` silently
 * returns zero channels — a failure that looks like "device has no channels"
 * rather than "wrong key".
 */
export function mapChannels(payload: unknown): ChannelConfig[] {
  const dtos = extractArray<PassagewayDto>(payload, [
    // Verified key first.
    'chinfoArray',
    // Defensive alternatives.
    'passageway',
    'passageways',
    'channel',
    'channels',
    'data',
    'list'
  ])
  const byIndex = new Map<number, ChannelConfig>()
  dtos.forEach((dto, position) => {
    const mapped = mapChannel(dto, position)
    if (mapped && !byIndex.has(mapped.channelIndex)) byIndex.set(mapped.channelIndex, mapped)
  })
  return [...byIndex.values()].sort((a, b) => a.channelIndex - b.channelIndex)
}

/**
 * Domain Channel rows ready to persist, keeping local ids stable by index.
 * `deviceId` is not a parameter: the caller already knows which device it is
 * refreshing, and the repository scopes the write by it.
 */
export function toChannelRecords(
  configs: readonly ChannelConfig[],
  existing: readonly Channel[]
): Array<Pick<Channel, 'channelIndex' | 'channelName' | 'sensorType' | 'enabled' | 'alarmProfileId'>> {
  const byIndex = new Map(existing.map((channel) => [channel.channelIndex, channel]))
  return configs.map((config) => {
    const previous = byIndex.get(config.channelIndex)
    const record: Pick<
      Channel,
      'channelIndex' | 'channelName' | 'sensorType' | 'enabled' | 'alarmProfileId'
    > = {
      channelIndex: config.channelIndex,
      channelName: config.channelName,
      sensorType: config.sensorType,
      enabled: config.enabled
    }
    if (previous?.alarmProfileId) record.alarmProfileId = previous.alarmProfileId
    return record
  })
}

// ---------------------------------------------------------------------------
// Sample rate (GET /get_samplingrate)
// ---------------------------------------------------------------------------

/** Firmware may report Hz (48000) or kHz (48); normalise to Hz. */
export function mapSampleRate(dto: SamplingRateDto | number | string): number | undefined {
  const raw =
    typeof dto === 'object' && dto !== null
      ? pickNumber(dto as Record<string, unknown>, [
          'samplingrate',
          'sample_rate',
          'sampleRate',
          'rate',
          'value'
        ])
      : toNumber(dto)
  if (raw === undefined || raw <= 0) return undefined
  const hz = raw < 1000 ? Math.round(raw * 1000) : Math.round(raw)
  return hz
}

// ---------------------------------------------------------------------------
// Realtime features (GET /features_stream)
// ---------------------------------------------------------------------------

/** Fallback channel when the frame omits one: sequential order is the norm. */
export interface FeatureMapContext {
  deviceId: string
  /** Channel index to assume when the frame has no channel field. */
  fallbackChannelId?: number
  /** Used when the frame carries no timestamp. */
  nowMs?: number
}

/**
 * Map one feature frame from the `/features_stream` WebSocket.
 *
 * MEASURED frame: `{"cur_ch":0,"freq_band_energy_ratio":0.03,"hr_f":613.3,
 * "main_freq":0.0,"sc_f":6.5,"smoothness":1.51,"sound_pressure_level":57.1,
 * "sv_f":0.0}`
 *
 * Two things the measurement changed:
 *   1. the channel field is **`cur_ch`**, not `ch_id`;
 *   2. frames carry **no timestamp at all**, so `nowMs` is not a fallback for
 *      malformed frames — it is the normal source of the timestamp.
 *
 * Returns undefined when the frame carries no usable metric, so a keep-alive or
 * a malformed frame never becomes a zero-filled data point.
 */
export function mapFeatureFrame(
  dto: FeatureFrameDto,
  context: FeatureMapContext
): RealtimeFeature | undefined {
  const source = dto as Record<string, unknown>

  const channelRaw = pickNumber(source, [
    'cur_ch',
    'ch_id',
    'chid',
    'hp_chid',
    'channel',
    'channel_id',
    'channelId'
  ])
  const channelId =
    channelRaw !== undefined
      ? clamp(Math.floor(channelRaw), 0, CHANNEL_COUNT - 1)
      : context.fallbackChannelId
  if (channelId === undefined) return undefined

  const timestamp =
    toEpochMs(pick(source, ['time_stamp', 'timestamp', 'time', 'ts'])) ?? context.nowMs ?? Date.now()

  const spl = pickNumber(source, ['sound_pressure_level', 'spl', 'hp_spl'])
  const mainFrequency = pickNumber(source, ['main_freq', 'mainFrequency', 'hp_mainfreq'])
  const smoothness = pickNumber(source, ['smoothness', 'hp_sll'])
  const bandEnergyRatio = pickNumber(source, ['freq_band_energy_ratio', 'bandEnergyRatio', 'hp_fbet'])

  // Require at least one core metric; otherwise this is not a data frame.
  if (
    spl === undefined &&
    mainFrequency === undefined &&
    smoothness === undefined &&
    bandEnergyRatio === undefined
  ) {
    return undefined
  }

  const feature: RealtimeFeature = {
    deviceId: context.deviceId,
    channelId,
    timestamp,
    spl: spl ?? Number.NaN,
    mainFrequency: mainFrequency ?? Number.NaN,
    smoothness: smoothness ?? Number.NaN,
    bandEnergyRatio: bandEnergyRatio ?? Number.NaN
  }

  const hrF = pickNumber(source, ['hr_f', 'hrF', 'oddEvenHarmonicRatio'])
  if (hrF !== undefined) feature.oddEvenHarmonicRatio = hrF
  const scF = pickNumber(source, ['sc_f', 'scF', 'spectralComplexity'])
  if (scF !== undefined) feature.spectralComplexity = scF
  const svF = pickNumber(source, ['sv_f', 'svF', 'fingerprintVariation'])
  if (svF !== undefined) feature.fingerprintVariation = svF

  return feature
}

// ---------------------------------------------------------------------------
// Audio library (GET /get_audio, PUT /get_alarm_audio)
// ---------------------------------------------------------------------------

export interface AudioRecordConfig {
  remoteRecordingId: string
  channelIndex: number
  eventType?: string
  alarmTime?: number
  durationMs?: number
  sampleRate?: number
  spl?: number
  mainFrequency?: number
  smoothness?: number
  bandEnergyRatio?: number
  fileName?: string
  remoteAudioPath?: string
}

export function mapAudioRecord(dto: AudioRecordDto): AudioRecordConfig | undefined {
  const source = dto as Record<string, unknown>

  const idValue = pick(source, ['id', 'audio_id', 'audioId', 'record_id', 'recordId'])
  const fileName = pickString(source, ['file_name', 'fileName', 'name'])
  const remoteRecordingId = idValue !== undefined ? String(idValue) : fileName
  if (!remoteRecordingId) return undefined

  const channelRaw = pickNumber(source, ['ch_id', 'channel_id', 'channelId', 'channel'])
  // Device library rows without a channel are attributed to CH1 rather than dropped.
  const channelIndex = channelRaw !== undefined ? clamp(Math.floor(channelRaw), 0, CHANNEL_COUNT - 1) : 0

  const eventRaw = pick(source, ['abnormal_type', 'abnormalType', 'event_type', 'eventType'])
  const eventType = eventRaw !== undefined ? String(eventRaw) : undefined

  const config: AudioRecordConfig = {
    remoteRecordingId,
    channelIndex
  }

  if (eventType) config.eventType = eventType
  const alarmTime = toEpochMs(pick(source, ['alarm_time', 'alarmTime', 'start_time', 'startTime', 'time']))
  if (alarmTime !== undefined) config.alarmTime = alarmTime
  const durationMs = toDurationMs(pick(source, ['duration', 'duration_ms', 'durationMs']))
  if (durationMs !== undefined) config.durationMs = durationMs
  const sampleRate = mapSampleRate(pick(source, ['sample_rate', 'sampleRate']) as number | string)
  if (sampleRate !== undefined) config.sampleRate = sampleRate
  const spl = pickNumber(source, ['spl', 'sound_pressure_level'])
  if (spl !== undefined) config.spl = spl
  const mainFrequency = pickNumber(source, ['main_freq', 'mainFrequency'])
  if (mainFrequency !== undefined) config.mainFrequency = mainFrequency
  const smoothness = pickNumber(source, ['smoothness'])
  if (smoothness !== undefined) config.smoothness = smoothness
  const bandEnergyRatio = pickNumber(source, ['freq_band_energy_ratio', 'bandEnergyRatio'])
  if (bandEnergyRatio !== undefined) config.bandEnergyRatio = bandEnergyRatio
  if (fileName) config.fileName = fileName
  const remoteAudioPath = pickString(source, ['audio_path', 'audioPath', 'path'])
  if (remoteAudioPath) config.remoteAudioPath = remoteAudioPath

  return config
}

/**
 * Turn a device-library entry into a LOCAL `recordings` row.
 * Note `relativePath` is empty until the file is actually downloaded — the
 * metadata is synchronised eagerly, the audio lazily (spec 10.3).
 */
export function toRecording(
  deviceId: string,
  config: AudioRecordConfig,
  nowMs: number
): Recording {
  const recording: Recording = {
    id: newRecordingId(),
    deviceId,
    channelId: config.channelIndex,
    recordingType: 'alarm',
    startTime: config.alarmTime ?? nowMs,
    sampleRate: config.sampleRate ?? 48_000,
    audioFormat: 'wav',
    relativePath: '',
    remoteRecordingId: config.remoteRecordingId,
    createdAt: nowMs
  }
  if (config.eventType) recording.eventType = config.eventType
  if (config.durationMs !== undefined) {
    recording.durationMs = config.durationMs
    recording.endTime = (config.alarmTime ?? nowMs) + config.durationMs
  }
  if (config.fileName) recording.eventType = recording.eventType ?? config.fileName
  return recording
}

// ---------------------------------------------------------------------------
// Alarm mask from device event payloads
// ---------------------------------------------------------------------------

/**
 * The alarm bit mask may arrive as `alarm_type`, `abnormal_type`, or a nested
 * `alarm` field. Accepts numbers, numeric strings, and hex strings.
 */
export function mapAlarmMask(source: Record<string, unknown>): number | undefined {
  const raw = pick(source, ['alarm_mask', 'alarmMask', 'alarm_type', 'alarmType', 'abnormal_type'])
  if (raw === undefined) return undefined

  if (typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 16)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  const numeric = toNumber(raw)
  if (numeric === undefined) return undefined
  const mask = Math.floor(numeric)
  return mask >= 0 && mask < 2 ** 31 ? mask : undefined
}

/** Detection mode (spec 11.3): Characteristic / AI, tolerant of numeric forms. */
export function mapDetectionType(value: unknown): DetectionType {
  if (typeof value === 'number') return value === 1 ? 'AI' : 'Characteristic'
  const text = String(value ?? '').trim().toLowerCase()
  if (['ai', '1', 'true', 'smart', 'intelligent'].includes(text)) return 'AI'
  return 'Characteristic'
}

/** Guard used by health checks: is this HTTP status a success for the device? */
export function isHttpSuccess(status: number): boolean {
  return isFiniteNumber(status) && status >= 200 && status < 300
}

/** Device-side "code" fields are inconsistent: accept the common success values. */
export function isDeviceSuccessCode(code: unknown): boolean {
  if (code === undefined || code === null) return true
  if (typeof code === 'boolean') return code
  const numeric = toNumber(code)
  if (numeric !== undefined) return numeric === 0 || numeric === 200
  const text = String(code).trim().toLowerCase()
  return ['ok', 'success', 'true'].includes(text)
}

// ---------------------------------------------------------------------------
// Alarm recordings — PUT /get_alarm_audio   (VERIFIED on real hardware)
// ---------------------------------------------------------------------------

/**
 * Extract the recording array from a `PUT /get_alarm_audio` response.
 *
 * Verified envelope: `{ allSize: 10000, audioArray: [ ... ] }`.
 * Note the key is **`audioArray`** and the total is **`allSize`** — neither
 * appears in the specification.
 */
export function extractAlarmAudio(payload: unknown): AlarmAudioDto[] {
  if (Array.isArray(payload)) return payload as AlarmAudioDto[]
  if (!payload || typeof payload !== 'object') return []
  const source = payload as Record<string, unknown>

  // AE08 uses `audioArray`; AO01's alarm-event endpoint uses `alertArray`
  // (MEASURED 2026-11-12 on AO01 @ 192.168.110.200).
  for (const key of ['audioArray', 'alertArray', 'data', 'list', 'audio', 'records']) {
    const value = source[key]
    if (Array.isArray(value)) return value as AlarmAudioDto[]
  }

  // One level of envelope nesting.
  for (const key of ['data', 'result', 'msgBody']) {
    const nested = source[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const found = extractAlarmAudio(nested)
      if (found.length > 0) return found
    }
  }
  return []
}

export interface AlarmRecordingConfig {
  /** Record id. Monotonically increasing; informational. */
  remoteId?: number
  /** 0-7 */
  channelIndex: number
  channelName?: string
  /** Alarm bit mask (spec appendix B). */
  alarmMask: number
  /** Epoch ms. */
  alarmTime: number
  /** Duration in milliseconds. */
  durationMs: number
  sampleRate: number
  /** Download key: pass to `/download_audio/{fileName}`. */
  fileName?: string
  /** Device-local absolute path. Informational only. */
  remoteFilePath?: string
  spl?: number
  mainFrequency?: number
  bandEnergyRatio?: number
  /** Stability metric; no domain equivalent yet, kept in `eventType`. */
  stability?: number
  continuousAlert?: boolean
}

/**
 * Map one alarm recording row.
 *
 * MEASURED conversions, each of which differs from a naive reading:
 *   - `dauAlarmTime` is epoch MILLISECONDS (verified against a real timestamp);
 *   - `dauAudionLeng` is in SECONDS (a value of 10 matched a 10.00 s file);
 *   - `dauAbnoType` IS the alarm bit mask, not a channel or an event enum.
 *
 * Returns undefined when the row has no usable identity or timestamp, so a
 * malformed row cannot become a recording dated 1970.
 */
export function mapAlarmRecording(dto: AlarmAudioDto): AlarmRecordingConfig | undefined {
  const source = dto as Record<string, unknown>
  // AO01 的告警事件行用 `dal*` 字段（alertArray）；AE08 用 `dau*`（audioArray）。
  // 同一个映射器处理两种形状，靠 `dalId` 区分；AO01 的 `dalAbnoType` 是 0/1
  // 事件标志，不是 AE08 的 14 位 alarm mask，所以**不**拿它去解位。
  const isAo01Alert = pickNumber(source, ['dalId']) !== undefined

  const alarmTime = toEpochMs(
    pick(source, ['dauAlarmTime', 'dalStartTime', 'alarm_time', 'time'])
  )
  if (alarmTime === undefined) return undefined

  const channelRaw = pickNumber(source, ['dauChId', 'dalChId', 'ch_id', 'channel_id'])
  const channelIndex =
    channelRaw !== undefined ? clamp(Math.floor(channelRaw), 0, CHANNEL_COUNT - 1) : 0

  // The mask arrives as a NUMBER on AE08. `mapAlarmMask` also accepts hex and
  // decimal strings for other revisions. AO01's `dalAbnoType` is not a mask.
  const alarmMask = isAo01Alert
    ? 0
    : (mapAlarmMask({ alarm_mask: pick(source, ['dauAbnoType', 'abnormal_type']) }) ?? 0)

  // Seconds -> milliseconds.
  const durationSeconds = pickNumber(source, [
    'dauAudionLeng',
    'dalDuration',
    'dalduration',
    'duration',
    'duration_s'
  ])
  const durationMs =
    durationSeconds !== undefined && durationSeconds >= 0
      ? Math.round(durationSeconds * 1000)
      : 0

  const config: AlarmRecordingConfig = {
    channelIndex,
    alarmMask,
    alarmTime,
    durationMs,
    sampleRate: pickNumber(source, ['dauSmp', 'dalSmp', 'sample_rate']) ?? 48_000
  }

  const remoteId = pickNumber(source, ['dauId', 'dalId', 'id'])
  if (remoteId !== undefined) config.remoteId = Math.floor(remoteId)
  const channelName = pickString(source, ['dauChName', 'dalChName', 'channel_name'])
  if (channelName) config.channelName = channelName
  const fileName = pickString(source, ['dauFileName', 'dalFileName', 'file_name'])
  if (fileName) config.fileName = fileName
  const remoteFilePath = pickString(source, ['dauFilePath', 'dalFilePath', 'audio_path'])
  if (remoteFilePath) config.remoteFilePath = remoteFilePath

  const spl = pickNumber(source, ['dauSPL', 'spl'])
  if (spl !== undefined) config.spl = spl
  const mainFrequency = pickNumber(source, ['dauMainFreq', 'main_freq'])
  if (mainFrequency !== undefined) config.mainFrequency = mainFrequency
  const bandEnergyRatio = pickNumber(source, ['dauFBET', 'freq_band_energy_ratio'])
  if (bandEnergyRatio !== undefined) config.bandEnergyRatio = bandEnergyRatio
  const stability = pickNumber(source, ['dauStati', 'stability'])
  if (stability !== undefined) config.stability = stability

  const continuous = pickBoolean(source, ['ContinuousAlert'])
  if (continuous !== undefined) config.continuousAlert = continuous

  return config
}

/**
 * Pull the playable-file metadata out of AO01's `GET /audio?alert_id=<id>`.
 *
 * MEASURED response (2026-11-12):
 *   `msgBody.audioArray[0] = { dauFileName: "0_0_20261106_064212.wav",
 *     dauFilePath: "/mic/2026_11_06/", dauAudionLeng: 10, dauSmp: 48000 }`
 *
 * The download URL is `/download_audio/<dauFilePath without leading slash>/<dauFileName>`;
 * `downloadRecording()` percent-encodes the whole relative path, which the device
 * accepts (verified: HTTP 200, RIFF/WAVE, 5,760,044 bytes).
 */
export function mapAlertAudioFile(payload: unknown): {
  fileName?: string
  durationMs?: number
  sampleRate?: number
} {
  const rows = extractAlarmAudio(payload)
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return {}
  const name = pickString(row, ['dauFileName', 'file_name'])
  const dir = pickString(row, ['dauFilePath', 'audio_path'])
  const duration = pickNumber(row, ['dauAudionLeng', 'duration'])
  const rate = pickNumber(row, ['dauSmp', 'sample_rate'])
  const cleanDir = dir?.replace(/^\/+|\/+$/g, '')
  return {
    ...(name ? { fileName: cleanDir ? `${cleanDir}/${name}` : name } : {}),
    ...(duration !== undefined && duration > 0
      ? { durationMs: Math.round(duration * 1000) }
      : {}),
    ...(rate !== undefined && rate > 0 ? { sampleRate: rate } : {})
  }
}

/**
 * Build a local `recordings` row from a device alarm record.
 *
 * `relativePath` stays EMPTY: the metadata is synchronised eagerly, the audio is
 * fetched on demand. Downloading a 10000-record library up front would pull tens
 * of gigabytes the moment a user opens the Recordings page.
 */
export function toAlarmRecordingRow(
  deviceId: string,
  config: AlarmRecordingConfig,
  nowMs: number
): Recording {
  const recording: Recording = {
    id: newRecordingId(),
    deviceId,
    channelId: config.channelIndex,
    recordingType: 'alarm',
    startTime: config.alarmTime,
    sampleRate: config.sampleRate,
    audioFormat: 'wav',
    relativePath: '',
    createdAt: nowMs
  }

  if (config.durationMs > 0) {
    recording.durationMs = config.durationMs
    recording.endTime = config.alarmTime + config.durationMs
  }
  // The device record id is the natural key for idempotent sync. Fall back to
  // the filename, which is also unique per recording.
  const remoteKey = config.remoteId !== undefined ? String(config.remoteId) : config.fileName
  if (remoteKey) recording.remoteRecordingId = remoteKey

  // Human-readable event description; the mask itself is authoritative and is
  // decoded wherever it is displayed, never here.
  if (config.fileName) recording.eventType = config.fileName

  return recording
}
