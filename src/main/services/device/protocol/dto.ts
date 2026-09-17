/**
 * FA8 / AE08 protocol DTOs — **derived from measurement, not documentation**.
 *
 * SOURCE OF TRUTH
 * These shapes were recovered by probing a real device (devname `AE08`,
 * firmware `567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8`) and by reading its own
 * web UI bundle. See `docs/PROTOCOL-FINDINGS.md` for the raw evidence.
 *
 * The specification document's assumptions differ from the real device in
 * several important ways. Where they conflict, THIS FILE FOLLOWS THE DEVICE:
 *   - requests and responses are wrapped in `msgBody` (not a bare object)
 *   - success is `result === 0` (not `code === 0`)
 *   - field names are prefixed `dev_` / `dsy*` / `dch*` / `dal*` / `modbus_*`
 *   - the password is `md5(plaintext + 'lfxs')`, not plaintext
 *
 * Firmware variable names are permitted HERE and in `mappers.ts`, and nowhere
 * else (spec appendix C rule 2).
 *
 * Every field is optional and loosely typed on purpose: firmware sends numbers
 * as strings, omits fields, and returns `null`. The DTO describes what might
 * arrive; the mapper makes sense of it.
 */

// ---------------------------------------------------------------------------
// Transport envelope
// ---------------------------------------------------------------------------

/**
 * The universal response envelope — verified on every endpoint.
 *
 *   { "message": "ok", "msgBody": { ... }, "result": 0 }
 *
 * `result === 0` means success. Observed failure values:
 *   - `2` on /login when credentials are rejected
 *   - `1` on /get_audio when no records exist
 *
 * Success payloads live under **`msgBody`**, NOT under `data` as the
 * specification assumed.
 */
export interface EnvelopeDto<T = unknown> {
  message?: string
  msgBody?: T
  result?: number
  /** Defensive: some builds may use `data` instead. */
  data?: T
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * `POST /login` request.
 *
 * The password is `md5(plaintext + 'lfxs')` — a fixed salt baked into the
 * device firmware and visible in its web UI bundle. The transformation lives in
 * `auth-strategy.ts`; this DTO only describes the wire shape.
 */
export interface LoginRequestDto {
  username: string
  password: string
}

/** `POST /login` response: `{ message, msgBody: { token }, result }`. */
export interface LoginResponseDto {
  /** Verified: the token is `md5(password + 'lfxs')` — a password derivative. */
  token?: string
  access_token?: string
  sessionid?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Device info — GET /get_devinfo
// ---------------------------------------------------------------------------

/**
 * Verified payload:
 * ```json
 * { "dev_mac":"02:EF:A2:52:F1:C5",
 *   "dev_version":"567E68F.2026-06-26_WEEK26.XSUSER.V.1.0.8",
 *   "devname":"AE08",
 *   "fpga_version":"V2.1.2_20260601.16BIT",
 *   "web_version":"V2.1.0.WEB.2025-06-05" }
 * ```
 *
 * NOTE: the device exposes **no serial number and no device_id**. The only
 * stable identity available is `dev_mac`, which is why `resolveDeviceUid()`
 * falls back to a `mac:`-prefixed uid (spec section 6.1 already anticipated
 * this fallback).
 *
 * The legacy/alternative field names are kept because firmware revisions vary.
 */
export interface DeviceInfoDto {
  /** Device name, e.g. "AE08". */
  devname?: string
  /** Firmware version string. */
  dev_version?: string
  /** MAC address — the only usable identity on this firmware. */
  dev_mac?: string
  /** FPGA build version. */
  fpga_version?: string
  /** Embedded web UI version. */
  web_version?: string

  // -- Alternative spellings retained for other firmware revisions ----------
  device_id?: string | number
  deviceId?: string | number
  sn?: string
  name?: string
  device_name?: string
  deviceName?: string
  mac?: string
  mac_address?: string
  macAddress?: string
  device_version?: string
  deviceVersion?: string
  version?: string
  webVersion?: string
  fpgaVersion?: string
  /** Not present on AE08; channel count must come from /get_passageway. */
  channel_num?: number | string
  channelNum?: number | string
  channel_count?: number | string
  channelCount?: number | string

  [key: string]: unknown
}

/** `PUT /set_devinfo` — undocumented in the spec but present on the device. */
export interface SetDeviceInfoDto {
  devname?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Network — GET /get_network, PUT /set_network
// ---------------------------------------------------------------------------

/**
 * Verified payload:
 * ```json
 * { "dsyDNSAdder":"192.0.2.53", "dsyHTTPPort":80, "dsyIPAdder":"192.168.1.50",
 *   "dsyIPGateway":"192.0.2.1", "dsyIPMask":"255.255.255.0",
 *   "dsyIPMode":"manual", "dsyRTSPPort":28003, "dsyTCPPort":28001 }
 * ```
 *
 * RESOLVES SPEC RISK 7: ports are real values (80 / 28003 / 28001), not `0`.
 * The `0` in the specification's example is most likely an "unset" placeholder.
 *
 * `dsyIPMode` is significant and was not anticipated: it distinguishes manual
 * from automatic (DHCP) addressing as a STRING, so a boolean `dhcp` flag cannot
 * represent it faithfully.
 */
export interface NetworkDto {
  dsyIPAdder?: string
  dsyIPMask?: string
  dsyIPGateway?: string
  dsyDNSAdder?: string
  dsyHTTPPort?: number | string
  dsyRTSPPort?: number | string
  dsyTCPPort?: number | string
  /** "manual" | "dhcp" (further values unverified). */
  dsyIPMode?: string

  // -- Alternative spellings ------------------------------------------------
  ip?: string
  ip_address?: string
  netmask?: string
  gateway?: string
  dns?: string
  http_port?: number | string
  httpPort?: number | string
  rtsp_port?: number | string
  tcp_port?: number | string
  dhcp?: number | boolean | string

  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Channels — GET /get_passageway
// ---------------------------------------------------------------------------

/**
 * One entry of the verified payload:
 * ```json
 * { "chinfoArray": [
 *     { "dchAlarmPara":1, "dchEn":1, "dchId":0, "dchName":"name1", "dchSensorType":0 },
 *     ... ] }
 * ```
 *
 * The array key is **`chinfoArray`**, which the specification does not mention;
 * a mapper looking for `passageway`/`channels` finds nothing.
 */
export interface PassagewayDto {
  /** Channel index 0-7. */
  dchId?: number | string
  /** Channel display name. */
  dchName?: string
  /** 0 = Microphone, 1 = Conduction (matches the spec). */
  dchSensorType?: number | string
  /** Enabled flag. */
  dchEn?: number | boolean | string
  /** Alarm parameter binding — links to `dalId` in /get_alarm_system. */
  dchAlarmPara?: number | string

  // -- Alternative spellings ------------------------------------------------
  channel_id?: number | string
  channelId?: number | string
  id?: number | string
  channel_name?: string
  channelName?: string
  name?: string
  sensor_type?: number | string
  sensorType?: number | string
  enable?: number | boolean | string
  enabled?: number | boolean | string
  alarm_id?: number | string
  alarmId?: number | string

  [key: string]: unknown
}

export interface PassagewayResponseDto {
  /** Verified array key. */
  chinfoArray?: PassagewayDto[]
  /** Defensive alternatives. */
  passageway?: PassagewayDto[]
  passageways?: PassagewayDto[]
  channel?: PassagewayDto[]
  channels?: PassagewayDto[]
  data?: PassagewayDto[]
  list?: PassagewayDto[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Sampling rate — GET /get_samplingrate
// ---------------------------------------------------------------------------

/** Verified: `{ "samplingrate": 96000 }` — Hz, matching the spec. */
export interface SamplingRateDto {
  samplingrate?: number | string
  sample_rate?: number | string
  sampleRate?: number | string
  rate?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Alarm system — GET /get_alarm_system
// ---------------------------------------------------------------------------

/**
 * Verified entry (AE08, one default profile):
 * ```json
 * { "dalId":1, "dalName":"defPara1", "dalDetecType":0, "dalDeteSen":10,
 *   "dalSensitivity":10, "dalIntInhLeve":10,
 *   "dalMainFreqEn":1, "dalMFLower":10, "dalMFUpper":5000,
 *   "dalFBETEn":1, "dalFBETThre":0.5, "dalFBETLo":15000, "dalFBETUp":24000,
 *   "dalSPLODEn":1,  "dalSPLODThre":120,   // overload
 *   "dalSPLSDDEn":0, "dalSPLSDDThre":20,   // drop
 *   "dalSPLSIDEn":0, "dalSPLSIDThre":20,   // surge
 *   "dalSPLStaDetEN":1, "dalSPLStaDetThre":150 }
 * ```
 *
 * `En` = enable, `Thre` = threshold, `Lo`/`Up` = band bounds.
 *
 * These names must NEVER reach the UI (spec 11.3); they are mapped to friendly
 * labels first.
 */
export interface AlarmParamDto {
  /** Alarm profile id. */
  dalId?: number | string
  /** Profile name. */
  dalName?: string
  /** Detection mode: 0 = Characteristic, 1 = AI (1 unverified). */
  dalDetecType?: number | string
  /** Detection sensitivity. */
  dalDeteSen?: number | string
  /** Sensitivity (second spelling on the same payload). */
  dalSensitivity?: number | string
  /** Interference suppression level. */
  dalIntInhLeve?: number | string

  /** Main frequency: enable / lower / upper. */
  dalMainFreqEn?: number | string
  dalMFLower?: number | string
  dalMFUpper?: number | string

  /** Frequency band energy ratio: enable / threshold / lower / upper. */
  dalFBETEn?: number | string
  dalFBETThre?: number | string
  dalFBETLo?: number | string
  dalFBETUp?: number | string

  /** SPL overload. */
  dalSPLODEn?: number | string
  dalSPLODThre?: number | string
  /** SPL sudden drop. */
  dalSPLSDDEn?: number | string
  dalSPLSDDThre?: number | string
  /** SPL sudden increase. */
  dalSPLSIDEn?: number | string
  dalSPLSIDThre?: number | string
  /** SPL stability detection. */
  dalSPLStaDetEN?: number | string
  dalSPLStaDetThre?: number | string

  [key: string]: unknown
}

export interface AlarmSystemDto {
  /** Verified array key. */
  alarmparaArray?: AlarmParamDto[]
  /** Defensive alternatives. */
  alarm_list?: AlarmParamDto[]
  alarmList?: AlarmParamDto[]
  data?: AlarmParamDto[]
  list?: AlarmParamDto[]
  alarmparaSize?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Time / NTP — GET /get_timeset
// ---------------------------------------------------------------------------

/**
 * Verified: `{ "cur_time":1789104356236, "dsyNTPAdder":"cn.pool.ntp.org",
 *              "dsyNTPEN":0, "dsyNTPInterval":64 }`
 *
 * `cur_time` is epoch MILLISECONDS — confirmed by magnitude.
 * `dsyNTPInterval` units are unverified (value 64).
 */
export interface TimeSetDto {
  cur_time?: number | string
  dsyNTPAdder?: string
  dsyNTPEN?: number | boolean | string
  dsyNTPInterval?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// RS485 — GET /get_rs485, GET /get_all_available_serial
// ---------------------------------------------------------------------------

/**
 * Verified: `{ "dsySeriBaud":9600, "dsySeriDateBit":8, "dsySeriMode":0,
 *              "dsySeriPortL":"", "dsySeriRserAddr":"" }`
 *
 * Note the firmware's spelling quirks: `dsySeriDateBit` (not "DataBit") and
 * `dsySeriRserAddr` (not "Rs485Addr"). Matching them exactly is mandatory.
 */
export interface Rs485Dto {
  dsySeriBaud?: number | string
  /** Firmware spelling: "DateBit". */
  dsySeriDateBit?: number | string
  dsySeriMode?: number | string
  dsySeriPortL?: string
  /** Firmware spelling: "RserAddr". */
  dsySeriRserAddr?: string
  [key: string]: unknown
}

/** Verified: `{ "all_available_dev":["/dev/ttyS3",...], "all_available_size":4 }` */
export interface AvailableSerialDto {
  all_available_dev?: string[]
  all_available_size?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Modbus — GET /get_modbus_para
// ---------------------------------------------------------------------------

/**
 * Verified: `{ "modbus_baud":9600, "modbus_crc":0, "modbus_dbit":8,
 *              "modbus_post":502, "modbus_sbit":1, "modbus_slave":200,
 *              "modbus_type":0 }`
 *
 * WATCH OUT: the TCP port field is **`modbus_post`**, not `modbus_port`.
 * That typo ships in the firmware, so it must be matched exactly.
 */
export interface ModbusDto {
  modbus_baud?: number | string
  modbus_crc?: number | string
  modbus_dbit?: number | string
  /** Firmware typo for "port". */
  modbus_post?: number | string
  modbus_sbit?: number | string
  modbus_slave?: number | string
  modbus_type?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Data push — GET /get_date_push
// ---------------------------------------------------------------------------

/**
 * Verified payload (fields abbreviated):
 * ```json
 * { "dsyAlarmInfoAdder":"http://8.153.195.75:3000/api/v1/dt_5e48c0a9.../telemetry",
 *   "dsyAlarmInfoEN":1,
 *   "dsyFeatDataAdder":"...", "dsyFeatDataEN":1,
 *   "dsyGraphDataAdder":"...", "dsyGraphDataEN":1,
 *   "dsyHeatAdder":"...", "dsyHeatContent":"HEAT", "dsyHeatEN":1,
 *   "dsyHeatInterval":60,
 *   "dsyManualRecordingAddr":"", "dsyManualRecordingEN":0 }
 * ```
 *
 * RESOLVES SPEC RISK 4 (partially): the push URL path contains a per-device
 * identifier (`dt_<32 hex>`), so a server CAN distinguish devices by URL even
 * though the payload carries no `device_id`. Adding an explicit id to the
 * payload remains the more robust option (spec 15.2).
 *
 * OPERATIONAL NOTE: on the tested unit all four push channels were ENABLED and
 * pointing at a public internet address. The Manager must surface the current
 * push targets prominently, because that is live data egress from a customer
 * site.
 */
export interface DatePushDto {
  dsyAlarmInfoAdder?: string
  dsyAlarmInfoEN?: number | boolean | string
  dsyFeatDataAdder?: string
  dsyFeatDataEN?: number | boolean | string
  dsyGraphDataAdder?: string
  dsyGraphDataEN?: number | boolean | string
  dsyHeatAdder?: string
  /** Free-form label, verified value "HEAT". */
  dsyHeatContent?: string
  dsyHeatEN?: number | boolean | string
  /** Units unverified (value 60). */
  dsyHeatInterval?: number | string
  dsyManualRecordingAddr?: string
  dsyManualRecordingEN?: number | boolean | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Current channel — PUT /get_cur_ch, PUT /channel_select
// ---------------------------------------------------------------------------

/** Verified: `{ "cur_ch": 0 }` */
export interface CurrentChannelDto {
  cur_ch?: number | string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Realtime features — WebSocket /features_stream
// ---------------------------------------------------------------------------

/**
 * NOT an HTTP endpoint. Verified WebSocket JSON frame:
 * ```json
 * {"cur_ch":0,"freq_band_energy_ratio":0.03,"hr_f":613.3,"main_freq":0.0,
 *  "sc_f":6.5,"smoothness":1.51,"sound_pressure_level":57.1,"sv_f":0.0}
 * ```
 *
 * The channel field is **`cur_ch`**, not `ch_id` as the specification assumed.
 * Frames carry **no timestamp**, so the client must stamp arrival time.
 * Sizes observed: 139-143 bytes.
 */
export interface FeatureFrameDto {
  /** Channel index. */
  cur_ch?: number | string
  sound_pressure_level?: number | string
  main_freq?: number | string
  smoothness?: number | string
  freq_band_energy_ratio?: number | string
  /** Odd-even harmonic ratio. */
  hr_f?: number | string
  /** Spectral complexity. */
  sc_f?: number | string
  /** Fingerprint variation. */
  sv_f?: number | string

  // -- Alternative spellings ------------------------------------------------
  ch_id?: number | string
  chid?: number | string
  hp_chid?: number | string
  channel?: number | string
  hp_spl?: number | string
  spl?: number | string
  hp_mainfreq?: number | string
  hp_sll?: number | string
  hp_fbet?: number | string
  time_stamp?: number | string
  timestamp?: number | string

  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Alarm library — PUT /get_alarm_audio   (VERIFIED on real hardware)
// ---------------------------------------------------------------------------

/**
 * One alarm recording, **verified against a real device**.
 *
 * ```json
 * { "ContinuousAlert": 0,
 *   "dauAbnoType": 1,
 *   "dauAlarmTime": 1789105315658,
 *   "dauAudionLeng": 10,
 *   "dauChId": 0, "dauChName": "name1", "dauChSenType": 0,
 *   "dauFBET": 0,
 *   "dauFileName": "1_alarm_20260911134155.wav",
 *   "dauFilePath": "/media/sdcard0/audio_library/auwh/audio/1_alarm_20260911134155.wav",
 *   "dauId": 39178,
 *   "dauMainFreq": 93, "dauSPL": 62.48, "dauStati": 4.88, "dauStatus": 1,
 *   "dauSmp": 96000 }
 * ```
 *
 * `dauAbnoType` IS THE ALARM BIT MASK (spec appendix B). Verified:
 *   `1` (bit 0) observed on an SPL alarm   -> Bit0 = SPL
 *   `2` (bit 1) observed on a main-frequency alarm -> Bit1 = Main Frequency
 * The remaining bits are defined by the spec but not yet observed in the field.
 *
 * ---------------------------------------------------------------------------
 * bit2–bit13 现在有**厂商 API 文档**的逐位确认（2026-09-16）
 * ---------------------------------------------------------------------------
 * `FA8 API_ 20250207_v1.0.pdf` 的 `/get_audio` 一节里有一小节叫
 * "Anomaly Type field parsing：dauAbnoType"，把这张位表**逐位写了出来**：
 *
 *   bit0 Sound pressure level | bit1 main frequency | bit2 Band energy ratio | bit3 smoothness
 *   bit4 'jsd' clip losse | bit5 'qqyx_A' cooler noise A | bit6 'qqyx_B' cooler noise B
 *   bit7 'gz' heavy overloading | bit8 'dlcj' short-circuit shock
 *   bit9 'bfd_bmfd' surface discharge | bit10 'bfd-dyfd' corona discharge
 *   bit11 'bfd_jjxfd' gap discharge | bit12 'bfd_xffd' floating discharge
 *   bit13 'lpc' Direct current magnetic bias
 *
 * 与 `ALARM_TYPE_KEYS` 的 14 位**逐位相同**，手册也只到 bit13、没有 bit14+ —— 与
 * `ALARM_MASK_BITS = 14` 一致。位4–13 那些 `'jsd'`/`'qqyx_A'` 是**固件拼音缩写**，
 * 按仓库硬规则只留在这一层，界面用的仍是语义键。整理见
 * `docs/Ivms4200-UX-REFERENCE.md` §15.22.1。
 *
 * ⚠️ 手册**没有**枚举 AI 模式（`dalDetecType = 1`）会不会推出这张表之外的新类别 ——
 * 未说明，所以未知位照旧走 `unknownAlarmBits()` / `unknown_<n>` 那条诚实路径。
 *
 * REQUEST SHAPE MATTERS: the body must be `{ msgBody: { page_start, page_size } }`.
 * An empty body returns `{"message":"Failed to obtain audio record.","result":1}`
 * — which looks like "no recordings exist" but actually means "bad request".
 * A body without the `msgBody` wrapper returns an nginx error page.
 */
export interface AlarmAudioDto {
  /** Firmware's spelling of "abnormal type". This is the alarm bit mask. */
  dauAbnoType?: number | string
  /** Record id, monotonically increasing. NOT the download key. */
  dauId?: number | string
  /** Alarm time, epoch MILLISECONDS (verified). */
  dauAlarmTime?: number | string
  /** Channel index 0-7. */
  dauChId?: number | string
  /** Channel name at the time of the alarm. */
  dauChName?: string
  /** Sensor type: 0 Microphone, 1 Conduction. */
  dauChSenType?: number | string
  /** Frequency band energy ratio. */
  dauFBET?: number | string
  /**
   * Filename, and the DOWNLOAD KEY: `/download_audio/{dauFileName}`.
   * The spec's `/audio_file/{filename}` does not exist on this firmware.
   */
  dauFileName?: string
  /**
   * Device-local absolute path, e.g.
   * `/media/sdcard0/audio_library/auwh/audio/1_alarm_20260911134155.wav`.
   * Informational only — it is not web-served.
   */
  dauFilePath?: string
  /** Duration in SECONDS (verified: 10 for a 10.00 s file). */
  dauAudionLeng?: number | string
  /** Dominant frequency, Hz. */
  dauMainFreq?: number | string
  /** Sound pressure level. */
  dauSPL?: number | string
  /** Stability metric. */
  dauStati?: number | string
  /** Record status; exact semantics unverified (observed 1). */
  dauStatus?: number | string
  /** Sample rate, Hz (verified: 96000). */
  dauSmp?: number | string
  /** Continuous-alert flag; semantics unverified (observed 0). */
  ContinuousAlert?: number | string

  // -- Defensive alternatives ----------------------------------------------
  [key: string]: unknown
}

/** Response of `PUT /get_alarm_audio`. */
export interface AlarmAudioListDto {
  audioArray?: AlarmAudioDto[]
  /** Total records available across all pages. Observed 10000. */
  allSize?: number | string
  [key: string]: unknown
}

/**
 * The list query body.
 * Verified: the parameters must be nested inside `msgBody`.
 */
export interface AlarmAudioQueryDto {
  page_start: number
  page_size: number
}

// ---------------------------------------------------------------------------
// Generic audio library — PUT /get_audio
// ---------------------------------------------------------------------------

/**
 * `PUT /get_audio` is referenced by the device's own web UI but returns
 * `404` (as an nginx error page, not even the envelope) for every request body
 * tried, including the `msgBody`-wrapped pagination form that `/get_alarm_audio`
 * accepts.
 *
 * CONCLUSION: on this firmware **`/get_alarm_audio` is the only working audio
 * library endpoint**. The spec lists both; only one exists. Code should treat a
 * failure here as expected rather than as a device fault.
 */
export interface AudioRecordDto {
  id?: number | string
  audio_id?: number | string
  record_id?: number | string
  ch_id?: number | string
  channel_id?: number | string
  abnormal_type?: number | string
  event_type?: number | string
  file_name?: string
  audio_path?: string
  alarm_time?: number | string
  duration?: number | string
  sample_rate?: number | string
  spl?: number | string
  main_freq?: number | string
  smoothness?: number | string
  freq_band_energy_ratio?: number | string
  [key: string]: unknown
}

export interface AudioListResponseDto {
  data?: AudioRecordDto[]
  list?: AudioRecordDto[]
  audio?: AudioRecordDto[]
  total?: number | string
  count?: number | string
  [key: string]: unknown
}

/**
 * A downloaded alarm recording, verified as a valid RIFF/WAVE file:
 *
 *   HTTP 200, `application/octet-stream`, 3,840,080 bytes
 *   `RIFF` / `WAVE` magic, fmt chunk: audioFormat=3 (IEEE Float),
 *   channels=1, sampleRate=96000, 32 bits, data=3,840,000 bytes = 10.00 s
 *
 * Notable properties:
 *   - **32-bit IEEE float**, not 16-bit PCM, matching the live stream encoding;
 *   - **mono**, matching the single-channel live stream;
 *   - served WITHOUT authentication — the token is not required. That is a
 *     firmware weakness worth reporting, not a convenience to rely on.
 */
export interface DownloadedRecording {
  bytes: Uint8Array
  contentType: string
  /** True when the payload starts with RIFF/WAVE. */
  isWave: boolean
  /** Parsed from the fmt chunk when available. */
  channels?: number
  sampleRate?: number
  bitsPerSample?: number
  /** IEEE float (3) or integer PCM (1). */
  audioFormat?: number
  dataBytes?: number
  durationSeconds?: number
}

// ---------------------------------------------------------------------------
// Live PCM framing — WebSocket /audio_stream  (NO DTO: it is raw binary)
// ---------------------------------------------------------------------------

/**
 * `/audio_stream` carries **raw Float32 little-endian PCM** with no header,
 * no file container and no per-frame metadata. The device's own UI reads it as
 * `new Float32Array(message.data)`.
 *
 * Verified frame size: **38400 bytes = 9600 Float32 samples, constant**.
 *
 * GEOMETRY — RESOLVED BY MEASUREMENT: **single channel, 100 ms per frame.**
 *
 * At the tested device's 96000 Hz:
 *   `38400 / 4 = 9600 samples`, and `9600 / 96000 = 0.100 s` exactly.
 *
 * Three independent observations ruled out interleaved multi-channel audio:
 *   1. the mean difference between samples 8 apart was 5.8e-4 (ch0) and
 *      1.8e-3 (ch1) — far from zero, whereas interleaved channels would be
 *      strongly correlated at that stride;
 *   2. subscribing to channel 0 versus channel 1 yielded different signals
 *      (RMS 0.001733 vs 0.002708, different sample sequences);
 *   3. the frame size stayed at 38400 for both channels, and only two of the
 *      eight channels are enabled — an interleaved frame would have varied.
 *
 * Corroborated by the alarm recordings: `/download_audio/{file}` returns a WAV
 * with `channels = 1`, `audioFormat = 3` (IEEE Float) and the same 100 ms frame
 * geometry, so live and recorded audio share one layout.
 *
 * General formula:
 *   `frameBytes = sampleRate * 0.1 * 4`
 *   48 kHz -> 19200, 96 kHz -> 38400, 192 kHz -> 76800
 *
 * CONSEQUENCE: monitoring N channels needs N WebSocket connections, each
 * subscribing to one channel. A 60 s Ring Buffer across 8 channels at 192 kHz
 * would need roughly 3.7 GB, which is why the spec limits buffering to the
 * active channel.
 *
 * The decoder therefore takes an explicit channel count rather than assuming 8:
 * guessing wrong produces noise that still "looks like" audio.
 */
export interface AudioFrameGeometry {
  /** Bytes per WebSocket binary frame. */
  frameBytes: number
  /** Float32 sample count per frame. */
  sampleCount: number
  sampleRate: number
  /** Verified as 1 on real hardware; explicit for other firmware revisions. */
  channelCount: number
  /** Frame duration in milliseconds. Verified as 100. */
  frameMs: number
}

/** Verified: frame duration is a constant 100 ms, independent of sample rate. */
export const AUDIO_FRAME_MS = 100

/**
 * Expected WebSocket frame size for a sample rate and channel count.
 * Derived rather than hard-coded so a 48 kHz or 192 kHz device is handled.
 */
export function expectedAudioFrameBytes(sampleRate: number, channelCount = 1): number {
  return Math.round((sampleRate * AUDIO_FRAME_MS) / 1000) * 4 * channelCount
}

// ---------------------------------------------------------------------------
// Spectrum / spectrogram — WebSocket, NOT HTTP
// ---------------------------------------------------------------------------

/**
 * `/freq_domain` carries raw **Float32 little-endian magnitude bins**.
 * Verified frame size: **4096 bytes = 1024 bins, constant**.
 *
 * At 96 kHz, 1024 bins gives ~93.75 Hz resolution over 0-48 kHz.
 */
export interface SpectrumFrameGeometry {
  frameBytes: number
  binCount: number
  sampleRate: number
  binHz: number
}

/**
 * `/time_freq_domain` carries a **JPEG image**, not a numeric matrix.
 *
 * Verified: frames begin `FF D8 FF E0 00 10 4A 46 49 46` (JPEG/JFIF), sized
 * ~40330-40337 bytes. The device's own UI converts each frame with
 * `readAsDataURL(blob)` and renders it as `<img src>`.
 *
 * CONSEQUENCE FOR PHASE 7: the spectrogram is rendered ON THE DEVICE. The
 * Manager must display the image sequence, not compute an STFT or drive a chart
 * library. This is a significant simplification — and the opposite of what the
 * specification's "图表：Spectrogram" wording implies.
 */
export interface SpectrogramFrameDto {
  /** JPEG bytes, ready to be wrapped in a Blob/data URL. */
  jpeg: Uint8Array
}

// ---------------------------------------------------------------------------
// Write payloads (Phase 9) — measured in docs/PROTOCOL-FINDINGS.md section 5A
// ---------------------------------------------------------------------------

/**
 * WRITE TYPES ARE STRICT, READ TYPES ARE LOOSE. That asymmetry is deliberate.
 *
 * Every read DTO above has optional fields, because firmware may omit anything.
 * A write payload is the opposite: the device replaces the whole object with what
 * it receives, so a missing field is not "leave it alone" — it is "reset it".
 * Making these fields REQUIRED turns that from a runtime surprise on a customer's
 * device into a compile error here.
 *
 * This is why the services all follow read -> merge -> write rather than
 * constructing a payload from scratch.
 *
 * 一处实测例外：`PUT /set_passageway` 的 `chinfoArray` 是**单行**的（见
 * `SetPassagewayRequest`），设备按该行的 `dchId` 合并，真机改名后其余 7 行逐字节不变。
 * 「设备到底是在合并还是整体替换」在值保持的探针里无法区分，所以这条仍是
 * **未验证**（`docs/PROTOCOL-FINDINGS.md` §7），`updateChannel()` 因此保留「先读回
 * 全部通道、只在被改行上合并用户编辑」的写法：五个字段全部来自设备。
 */

/**
 * `PUT /set_samplingrate` — 真机实测（值保持写探针）。
 *
 * 裸 `{samplingrate:96000}` → `{"message":"Failed to set sampling rate.","result":1}`；
 * `{"msgBody":{"samplingrate":96000}}` → `{"message":"ok","result":0}`，读回仍是 96000。
 * 所以信封是必需的，见 `docs/PROTOCOL-FINDINGS.md` §5A.1 的矩阵。
 */
export interface SetSamplingRateRequest {
  msgBody: {
    samplingrate: number
  }
}

/**
 * `PUT /set_passageway` — 真机实测形状（2026 年取证轮，见下）。
 *
 * 两件事都是**实测**的，不是推断：
 *   1. 根上必须有 `msgBody` 信封；
 *   2. `chinfoArray` 是**单个通道对象**，不是数组。一元素数组同样被拒。
 *
 * 依据：设备把自己的 source map 一起发布了
 * （`/static/js/main.1defb5ea.js.map`，含 1757 个原始源文件），
 * `pages/Preference/PreferenceF.js:183-205` 里设备自己的写法是
 * `record.dchName = value; setPassagewayApi({ msgBody: { chinfoArray: record } })`
 * —— `record` 是表格的一行对象；随后在真机上用值保持写入逐一试形状：
 * `{chinfoArray:[8 条]}`、`{msgBody:{chinfoArray:[8 条]}}`、
 * `{msgBody:{chinfoArray:[1 条]}}` 全部返回
 * `Failed, Please check the integrity of the data format.`，
 * 只有 `{msgBody:{chinfoArray: <单个对象>}}` 返回 `{"message":"ok","result":0}`。
 * 详细矩阵见 `docs/PROTOCOL-FINDINGS.md` §5A.2。
 *
 * 只带**被改的那一路**，其余通道由设备自己保留（真机改名探针读回：其余 7 行逐字节不变）。
 */
export interface SetPassagewayRequest {
  msgBody: {
    chinfoArray: {
      dchId: number
      dchName: string
      dchSensorType: number
      dchEn: number
      dchAlarmPara: number
    }
  }
}

/**
 * `PUT /add_alarm_system` — verified.
 *
 * `dalId` is omitted to CREATE a profile and included to UPDATE one; the device
 * distinguishes the two cases by its presence.
 */
export interface AlarmParamWrite {
  dalId?: number
  dalName: string
  dalDetecType: number
  dalDeteSen: number
  dalSensitivity: number
  dalIntInhLeve: number
  dalSPLODEn: number
  dalSPLODThre: number
  dalSPLSIDEn: number
  dalSPLSIDThre: number
  dalSPLSDDEn: number
  dalSPLSDDThre: number
  dalSPLStaDetEN: number
  dalSPLStaDetThre: number
  dalMainFreqEn: number
  dalMFLower: number
  dalMFUpper: number
  dalFBETEn: number
  dalFBETLo: number
  dalFBETUp: number
  dalFBETThre: number
}

/** `PUT /add_alarm_system` request envelope. */
export interface SetAlarmSystemRequest {
  alarmparaArray: AlarmParamWrite[]
}

/**
 * `PUT /del_alarm_system` — 删除一条告警配置。
 *
 * ⚠️ **未验证**：这一轮**没有**对它做写探针（删除会真的抹掉一条保护定值，而设备上的
 * 两条配置都在被通道引用）。同一轮里五个安全端点全部证明「必须 `msgBody`」，所以这里
 * **很可能**同样需要信封，但那个形状是**推断**，不是实测 —— 在证明之前保持原样。
 */
export interface DeleteAlarmSystemRequest {
  dalId: number
}

/**
 * `PUT /set_date_push` — 真机实测（值保持写探针）：信封必需。
 *
 * 把 `/get_date_push` 读到的十二个字段原样送回时：
 * 裸对象 → `{"message":"Failed to set data push parameters.","result":1}`；
 * `{"msgBody":<同一对象>}` → `{"message":"ok","result":0}`，读回逐字节不变。
 *
 * 十二个字段**全部必填**是写入端点的通行约定（设备整体替换对象），不是这次实测的结论 ——
 * 实测到的只是「信封必需」与「这十二个字段照原样送回不会改变任何值」。
 */
export interface SetDatePushRequest {
  msgBody: {
    dsyFeatDataEN: number
    dsyFeatDataAdder: string
    dsyAlarmInfoEN: number
    dsyAlarmInfoAdder: string
    dsyGraphDataEN: number
    dsyGraphDataAdder: string
    dsyHeatEN: number
    dsyHeatAdder: string
    dsyHeatContent: string
    dsyHeatInterval: number
    dsyManualRecordingEN: number
    dsyManualRecordingAddr: string
  }
}

/**
 * `PUT /set_network` — HIGHEST-RISK write in the application.
 *
 * ⚠️ **未验证**：信封是否必需**没有被实测过**，因为改 IP 会立刻切断当前连接
 * （见 `docs/PROTOCOL-FINDINGS.md` §5A.4 与附录）。同一轮里五个安全端点全部证明
 * 「必须 `msgBody`」，所以这里**很可能**同样需要，但在真机上证明它需要把设备搬到
 * 另一个地址、并承担失联风险 —— 不做。在证明之前不改：一次猜测的改动会让一次本就
 * 高风险的网络变更以另一种方式失败。
 *
 * Applying this drops the current connection immediately: the address the app is
 * talking to may no longer exist. The Manager warns, applies, then reconnects on
 * the new address and reports the outcome.
 */
export interface SetNetworkRequest {
  dsyIPMode: string
  dsyIPAdder: string
  dsyIPMask: string
  dsyIPGateway: string
  dsyDNSAdder: string
  dsyHTTPPort: number
  dsyRTSPPort: number
  dsyTCPPort: number
}

/**
 * `PUT /set_timeset` — 真机实测（值保持写探针）。`cur_time` 是**毫秒**时间戳，
 * 因此这个端点也可以用来把设备时钟校准到本机。
 *
 * 裸 `{cur_time,…}` → `Failed to set time parameters.`（`result:1`）；
 * `{"msgBody":{…}}` → `{"message":"ok","result":0}`，NTP 三个字段读回逐字节不变。
 * 见 `docs/PROTOCOL-FINDINGS.md` §5A.5。
 */
export interface SetTimeSetRequest {
  msgBody: {
    cur_time: number
    dsyNTPAdder: string
    dsyNTPEN: number
    dsyNTPInterval: number
  }
}

/**
 * `PUT /set_rs485` — 真机实测（值保持写探针）：信封必需。
 * 裸 `{dsySeriBaud,…}` → `Failed to set RS485 parameters.`（`result:1`）；
 * `{"msgBody":{…}}` → `{"message":"ok","result":0}`，读回逐字节不变。
 *
 * NOTE `dsySeriPortR` (the right-hand port): the READ endpoint does not return
 * it, but the WRITE endpoint expects it. A read-modify-write that rebuilds the
 * payload from the read response would drop it and clear that port's
 * configuration — so the value is carried forward explicitly even when unknown.
 */
export interface SetRs485Request {
  msgBody: {
    dsySeriBaud: number
    dsySeriDateBit: number
    dsySeriMode: number
    dsySeriPortL: string
    dsySeriPortR: string
    dsySeriRserAddr: string
  }
}

/**
 * `PUT /set_modbus_para` — 真机实测（值保持写探针）：信封必需。
 * 裸 `{modbus_post,…}` → `Failed to set Modbus parameters.`（`result:1`）；
 * `{"msgBody":{…}}` → `{"message":"ok","result":0}`，读回逐字节不变。
 *
 * `modbus_crc` appears in the read response but is NOT part of the write
 * payload. Including a read-only field can be rejected or ignored; either way it
 * is not sent.
 */
export interface SetModbusRequest {
  msgBody: {
    modbus_post: number
    modbus_type: number
    modbus_baud: number
    modbus_dbit: number
    modbus_sbit: number
    modbus_slave: number
  }
}

/**
 * `PUT /set_devinfo` — 真机实测形状，且规格书没有这个端点（只列了 `GET /get_devinfo`）。
 *
 * `devname` 必须在 `msgBody` 里面：设备自己的前端
 * （`pages/Preference/SystemSettingsF.js:753-813`）发的就是
 * `setDevinfoApi({ "msgBody": { devname: devinfoDateInfo.devname } })`。
 * 真机实测：`{"devname":"AE08"}` → `Failed to modify device name.`；
 * `{"msgBody":{"devname":"AE08"}}` → `{"message":"OK","result":0}`。
 * `fpga_version` / `dev_version` / `dev_mac` 不是必填。详见
 * `docs/PROTOCOL-FINDINGS.md` §5A.10。
 */
export interface SetDeviceNameRequest {
  msgBody: {
    devname: string
  }
}

/**
 * `PUT /system_control` — DESTRUCTIVE. Values verified against the device's own
 * UI handlers and their success messages:
 *
 *   1  factory reset   ("DeviceRecoveryInitializationSucceeded")
 *   2  reboot          ("DeviceRestartSuccessful")
 *   3  system upgrade  (handler named `Set_sys_upgrade`)
 *
 * The device clears its session storage after 1 and 2, so both invalidate the
 * current login. Each requires explicit user confirmation in the UI.
 *
 * ⚠️ **信封未验证**：`SystemControlRequest` 保持**不带** `msgBody` 的原样 —— 这一轮
 * 没有对它做写探针（重启会中断监测，恢复出厂会抹掉全部历史数据）。同一轮里五个安全
 * 端点全部证明「必须 `msgBody`」，所以这里**很可能**同样需要信封，但那是**推断**而不是
 * 实测；在证明之前不改。见 `docs/PROTOCOL-FINDINGS.md` 的「未验证」清单。
 */
export const SystemControlAction = {
  FACTORY_RESET: 1,
  REBOOT: 2,
  SYSTEM_UPGRADE: 3
} as const

export type SystemControlActionValue =
  (typeof SystemControlAction)[keyof typeof SystemControlAction]

export interface SystemControlRequest {
  control_type: SystemControlActionValue
}
