#!/usr/bin/env node
/**
 * Mock FA371 online acoustic camera (leak-detection model) open interface.
 *
 * WHY THIS EXISTS
 * The FA371 client cannot be developed against real hardware on a desk, and the
 * vendor manual leaves a set of questions the client MUST be written to survive
 * - above all how the token is carried (`docs/reference/FA371-api-spec.md` §2.2
 * calls that "the number-one risk"), and a pile of fields whose only evidence is
 * a table cell (§4/§6 of the spec are full of `手册未说明`).
 *
 * A mock that quietly picks an answer for every unknown would teach the client
 * author the wrong thing. This one therefore:
 *   - carries the token in a SELECTABLE way, defaulting to the literal reading
 *     of the manual (`Authorization: <token>`, no `Bearer ` prefix),
 *   - reproduces every documented key EXACTLY, including the manual's typos
 *     (`target_numbe`, `Times`, `Switch`, `Duration`, `Notes`, `diagosisn`)
 *     because the spec forbids "fixing" them,
 *   - and lists, at startup and in comments, every value it had to guess.
 *
 * WHAT IS DELIBERATELY FAITHFUL RATHER THAN CONVENIENT
 *   - `/login` returns NO `ret`/`msg` envelope (spec §2.1).
 *   - `GET /system/detect_status` returns `{"detect_status":0}` and NOTHING else
 *     (spec §5.1.16 - the only endpoint in the set without the envelope).
 *   - `GET /system_time` returns only `sys_time` (spec §5.1.20).
 *   - `POST /turn_off_detect` returns an empty body (spec §5.1.15).
 *   - DELETE bodies accept a bare array, `{"id":[...]}` AND `?id=1,2`, because
 *     the manual never states the request field name (spec §5.1.24/29/32).
 *
 * USAGE
 *   node scripts/mock-fa371.cjs
 *   node scripts/mock-fa371.cjs --port 9100 --verbose
 *   node scripts/mock-fa371.cjs --auth-mode bearer        # exercise the other carrier
 *   node scripts/mock-fa371.cjs --persist .tmp/fa371.json --seed
 *   node scripts/mock-fa371.cjs --ws                      # also serve spec §5 WebSockets
 *
 * NOT A SINGLE DEPENDENCY: plain `node:http` + `node:crypto`, so it runs with
 * `node scripts/mock-fa371.cjs` before anything is installed.
 */

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Salt appended to the plaintext before hashing. Mirrors
 * `src/main/services/device/auth-strategy.ts` (`derivePassword`) so the fixture
 * and the client agree on what a valid login looks like; NOT imported, because
 * this file must run under plain Node with no build step and no `src/` on disk.
 * The spec's own wording (`Password + lfxs MD5 encrypted ciphertext, 32 bit
 * lowercase`, §2.1) does not say whether the salt is prepended or appended -
 * spec §8.1/A3 marks that as P0-undefined. We use the append order, which is
 * what this project already measured on the sibling device family.
 */
const PASSWORD_SALT = 'lfxs'

function derivePassword(plaintext) {
  return createHash('md5').update(`${plaintext}${PASSWORD_SALT}`, 'utf8').digest('hex')
}

const DEFAULTS = {
  port: 0, // 0 = pick a free port, like scripts/mock-device.cjs
  user: 'admin', // spec §6.3: the ONLY account, and it is not modifiable
  password: '123456', // spec §6.3: documented default password
  // Fixed and deterministic so a test can assert the exact token string.
  token: 'FA371-MOCK-TOKEN-000000000000',
  authMode: 'raw'
}

function parseArgs(argv) {
  const args = { ...DEFAULTS, persist: null, seed: false, verbose: false, ws: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const take = () => {
      index += 1
      return argv[index]
    }
    switch (flag) {
      case '--port':
        args.port = Number(take())
        break
      case '--user':
        args.user = take()
        break
      case '--password':
        args.password = take()
        break
      case '--token':
        args.token = take()
        break
      case '--auth-mode':
        args.authMode = take()
        break
      case '--persist':
        args.persist = take()
        break
      case '--seed':
        args.seed = true
        break
      case '--ws':
        args.ws = true
        break
      case '--verbose':
        args.verbose = true
        break
      case '--help':
      case '-h':
        process.stdout.write(
          [
            'node scripts/mock-fa371.cjs [options]',
            '  --port <n>              listen port (0 = first free port, default)',
            '  --user <name>           login user           (default admin)',
            '  --password <plaintext>  login password       (default 123456)',
            '  --token <value>         token handed out by /login (fixed, deterministic)',
            '  --auth-mode raw|bearer|both   how the token must be carried (default raw)',
            '  --persist <file>        load/save alarm state as JSON',
            '  --seed                  start with one example strategy + condition',
            '  --ws                    also serve the spec §5 WebSocket endpoints',
            '  --verbose               log every request line',
            ''
          ].join('\n')
        )
        process.exit(0)
        break
      default:
        // Unknown flags are fatal: silently ignoring `--authmode` (no dash) would
        // leave the operator convinced they exercised bearer mode.
        process.stderr.write(`unknown flag: ${flag} (try --help)\n`)
        process.exit(2)
    }
  }
  if (!['raw', 'bearer', 'both'].includes(args.authMode)) {
    process.stderr.write(`--auth-mode must be raw|bearer|both, got ${args.authMode}\n`)
    process.exit(2)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

// ---------------------------------------------------------------------------
// Guessed values, in one place, so the banner and the code cannot drift apart
// ---------------------------------------------------------------------------

/**
 * Every entry is a value the manual does NOT pin down. They are emitted (not
 * omitted) so the client has something realistic to parse, but they are called
 * out in the startup banner: a guessed field the client silently depends on is
 * exactly the bug this mock exists to prevent.
 */
const GUESSES = [
  'GET /system/acoustic samplerate=132000 - spec §5.1.2 example says 13200, which contradicts the legal set {96000,132000} in §5.1.3 (spec §8.3/C1)',
  'GET /system/image target_numbe - spec §5.1.4 table spells it target_numbe, the example spells it target_number; we emit BOTH (spec §8.3/C2)',
  'GET /system/image imaging_sensitivity / imaging_enhance - in the spec §5.1.4 table but absent from its example (spec §8.3/C2)',
  'PUT /system/leakage: a *_str is echoed from its numeric enum - the manual never says whether the result is device-computed (spec §8.3/C7)',
  'PUT /system/leakage: response body shape - the manual gives none for any PUT (spec §8.2/B2)',
  'GET /system/scan_area: area_height/area_width/left_top_x/left_top_y are pixel counts in the 1920x1080 frame - coordinate reference is undefined (spec §8.3/C9)',
  'GET /system_time sys_time is 13-digit epoch MILLISECONDS - the spec §5.1.20 example has 8 digits, so the unit is undefined (spec §8.3/C19)',
  'PUT /time_set_manually: `time` is interpreted as ms when >= 1e11, seconds otherwise - unit undefined (spec §8.3/C20)',
  'alarm_strategy list id is an INTEGER - the spec §5.1.22 table says string while §5.1.25 says integer (spec §8.3/C21)',
  'alarm_strategy level is echoed verbatim - read side documents 0-3, write side 1-4 (spec §8.3/C21)',
  'POST /alarm_strategy accepts BOTH diagosisn (spec §5.1.23) and diagnosis (spec §5.1.25)',
  'POST /alarm_strategy response carries the new `id` - the manual never says how a caller learns it (spec §8.3/C22)',
  'alarm_condition read-back uses capitalised Notes and name - the write side uses notes plus name; the read table is the only evidence (spec §5.1.26)',
  'PUT /alarm_condition accepts an `id` field - the spec §5.1.28 request table HAS NO id, so the target is otherwise unaddressable (spec §8.3/C25)',
  'PUT /alarm_strategy accepts `Switch` and creates fine at 0 - there is NO documented enable/disable endpoint (spec §8.3/C33)',
  'DELETE bodies accept a bare array, {"id":[...]} and ?id=1,2 - no request field name is documented (spec §8.3/C24,C29,C30)',
  'detect_logs uses the spec §5.1.17 table spelling `alarm_condition_id` (write side calls it alarm_id) and the example-side `files_status` - neither appears in both places (spec §8.3/C15,C16)',
  'page_size is 10 for alarm_strategy/alarm_condition - only §5.1.31 (nc_filelist) states a page size (spec §8.2/B4)',
  'POST /turn_on_detect returns a detect_id in BOTH run modes - undefined for cruise mode (spec §8.3/C11)'
]

const WS_GUESSES = [
  '/pcmData: 1 channel, 48000 float32 LE samples per frame = one second - channel count and frame length undefined (spec §8.4/D5)',
  '/voiceprintData: 128x256 int32 LE magnitudes = 131072 bytes/frame - width/height/channels/pixel format/bit width ALL undefined (spec §8.4/D4)',
  '/fftData: 512 int16 LE values = 1024 bytes/frame - "length of 512" could be bytes, and byte order is undefined (spec §8.4/D3)',
  '/energyData: random 32-bit LE groups of 5 - units/scales of energy and both angles undefined (spec §8.4/D6)',
  'all binary payloads are LITTLE endian - the manual only says "parse in byte order" (spec §8.4/D2)',
  '/detectFeedback is pushed as a TEXT frame - the manual says both "JSON strings" and "parsed in byte order" (spec §8.4/D7)',
  'WebSocket handshakes are NEVER rejected - the manual does not say how a WS connection authenticates (spec §8.4/D1)',
  'no idle timeout is enforced - the manual requires a client heartbeat each minute but gives no threshold (spec §8.4/D8)'
]

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------

/**
 * Config endpoints are stateful so GET reflects the last PUT: a client that
 * can only ever read a frozen fixture never exercises its own write path.
 *
 * Defaults come from the manual's own examples where they exist; the spec's
 * examples are frequently internally inconsistent (leakage_unit=1 next to
 * leakage_unit_str="l/min", §5.1.10) and are reproduced AS WRITTEN on purpose -
 * a client that cannot survive the manual's own example cannot survive the
 * device either.
 */
function defaultSystemState() {
  return {
    acoustic: { freq_up_limit: 25, freq_down_limit: 20, samplerate: 132000 },
    image: { energy_threshold: 25, target_numbe: 1, imaging_sensitivity: 1, imaging_enhance: 0 },
    video: {
      rtsp_client_limit: 6,
      rtsp_connected_num: 1,
      rtsp_enabled: 1,
      video_bit_rate: 4096,
      video_flip_model: 0,
      video_fps: 30,
      video_height: 1080,
      video_port: 443,
      video_url: 'live',
      video_width: 1920
    },
    run_mode: 1,
    leakage: {
      cost_display: 1,
      leakage_distance: 1,
      leakage_unit: 1,
      leakage_unit_str: 'l/min',
      monetary_unit: 1,
      monetary_unit_str: 'CNY',
      energy_cost: 1,
      specific_power: 1,
      value_of_gas: 1,
      working_hours: 1
    },
    scan_area: {
      areas: [
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 12, left_top_y: 12 },
        { area_height: 168, area_width: 240, detect_area_status: 1, left_top_x: 257, left_top_y: 185 }
      ],
      center_focus: 2
    },
    sys_time: null // null = "follow the host clock"; PUT pins it
  }
}

const state = {
  system: defaultSystemState(),
  strategies: [],
  conditions: [],
  ncFiles: [],
  detectLogs: [],
  nextStrategyId: 1,
  nextConditionId: 1,
  nextNcFileId: 1,
  nextDetectId: 1,
  // The id of the detection currently running. Held so that the log written at
  // turn-off carries the SAME id `/turn_on_detect` handed out: `detect_id` is
  // what the manual says the caller receives (§5.1.14) and what `detect_logs`
  // is queried by (§5.1.17), so the two must be the same number.
  currentDetectId: null,
  detecting: false
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadPersistedState() {
  if (!args.persist) return
  const file = path.resolve(args.persist)
  if (!fs.existsSync(file)) {
    if (args.seed) savePersistedState()
    return
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw.system) state.system = { ...state.system, ...raw.system }
    for (const key of ['strategies', 'conditions', 'ncFiles', 'detectLogs']) {
      if (Array.isArray(raw[key])) state[key] = raw[key]
    }
    for (const key of ['nextStrategyId', 'nextConditionId', 'nextNcFileId', 'nextDetectId']) {
      if (typeof raw[key] === 'number') state[key] = raw[key]
    }
    process.stdout.write(`[mock-fa371] restored ${file}\n`)
  } catch (error) {
    // Loud, not fatal: a corrupt fixture should be visibly replaced, not
    // silently mirrored back as if the device had returned it.
    process.stdout.write(`[mock-fa371] WARNING could not parse ${file}: ${error.message}\n`)
  }
}

function savePersistedState() {
  if (!args.persist) return
  const file = path.resolve(args.persist)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        system: state.system,
        strategies: state.strategies,
        conditions: state.conditions,
        ncFiles: state.ncFiles,
        detectLogs: state.detectLogs,
        nextStrategyId: state.nextStrategyId,
        nextConditionId: state.nextConditionId,
        nextNcFileId: state.nextNcFileId,
        nextDetectId: state.nextDetectId
        // `currentDetectId` is deliberately NOT saved: an in-flight detection is
        // not restorable, and a restart is a fresh device boot.
      },
      null,
      2
    )}\n`
  )
}

/** One example strategy + condition, so alarm flows can be exercised at once. */
function seedAlarmState() {
  const condition = {
    id: state.nextConditionId++,
    name: 'Condition 1',
    decibel_thr: 80,
    db_arithmetic_operator: 3,
    db_switch: 1,
    dominant_freq_thr: 40,
    df_arithmetic_operator: 0,
    df_switch: 1,
    df_logical_operator: 1,
    noise_comparison_file_id: 0,
    noise_comparison_thr: 0.8,
    nc_switch: 0,
    nc_logical_operator: 1,
    nc_arithmetic_operator: 0,
    Notes: 'seeded example condition'
  }
  state.conditions.push(condition)
  state.strategies.push({
    id: state.nextStrategyId++,
    name: 'Strategy One',
    alias: 'seeded',
    alarm_condition_id: condition.id,
    alarm_condition_name: condition.name,
    interval_time: 60,
    Times: 1,
    timeout_duration: 10,
    sensitivity: 0.5,
    level: 1,
    diagnosis: 'seeded example strategy',
    Switch: 0
  })
}

// ---------------------------------------------------------------------------
// Envelope helpers (spec §1)
// ---------------------------------------------------------------------------

function success(payload) {
  // The envelope is documented as `ret`/`msg` "plus" the endpoint's payload.
  // The manual never shows the merged body for any PUT/POST, so the key ORDER
  // is ours; `ret`/`msg` first matches every GET example that does exist.
  return { ret: 200, msg: 'SUCCESS', ...payload }
}

function businessFailure(message) {
  // `ret: -1` is documented in exactly three places (spec §8.2/B3): modify an
  // enabled strategy, modify a bound condition, delete a bound condition.
  return { ret: -1, msg: message }
}

function notFound(message) {
  return { ret: -1, msg: message }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}

function sendEmpty(response, status = 200) {
  response.writeHead(status, { 'Content-Length': 0 })
  response.end()
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      if (!body.trim()) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        // The manual's own examples are unparseable (spec §8.2/B1), so a client
        // ported straight from them will send garbage. Echo back exactly what we
        // received instead of pretending it was JSON - the error is the signal.
        resolve({ __unparsed: body })
      }
    })
  })
}

/**
 * Accept any of the three shapes the manual could be describing for the DELETE
 * endpoints. It never states the request field name (§5.1.24/29/32), only the
 * type `integer[]`, while the one analogous documented body (§5.1.19) uses
 * `{"id":[2,3]}` and its example is itself truncated.
 */
function extractIds(body, url) {
  const fromQuery = url.searchParams.get('id')
  if (fromQuery) {
    return fromQuery
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value))
  }
  if (Array.isArray(body)) return body.map(Number).filter(Number.isFinite)
  if (Array.isArray(body.id)) return body.id.map(Number).filter(Number.isFinite)
  if (Array.isArray(body.ids)) return body.ids.map(Number).filter(Number.isFinite)
  if (Number.isFinite(Number(body.id))) return [Number(body.id)]
  return []
}

/** Partial-update semantics: only keys present in the body change. */
function patch(target, body, numericKeys) {
  for (const [key, value] of Object.entries(body)) {
    if (key === '__unparsed') continue
    if (numericKeys.includes(key)) {
      const number = Number(value)
      if (Number.isFinite(number)) target[key] = number
    } else {
      target[key] = value
    }
  }
}

const ACOUSTIC_KEYS = ['freq_up_limit', 'freq_down_limit', 'samplerate']
const IMAGE_KEYS = ['energy_threshold', 'target_numbe', 'target_number', 'imaging_sensitivity', 'imaging_enhance']
const VIDEO_KEYS = [
  'rtsp_client_limit',
  'rtsp_connected_num',
  'rtsp_enabled',
  'video_bit_rate',
  'video_flip_model',
  'video_fps',
  'video_height',
  'video_port',
  'video_width'
]
const LEAKAGE_KEYS = [
  'cost_display',
  'leakage_distance',
  'leakage_unit',
  'monetary_unit',
  'energy_cost',
  'specific_power',
  'value_of_gas',
  'working_hours'
]

// ---------------------------------------------------------------------------
// Detect-log fixture (spec §5.1.17 / §5.2.3)
// ---------------------------------------------------------------------------

/**
 * The spec's own example, plus the fields its TABLE declares but its example
 * omits. Emitting them is the point: a client built only against the example
 * would never parse `is_alarm`, yet the table says it is there. The table
 * spelling `alarm_condition_id` is used (the write side calls the same thing
 * `alarm_id`); the example-side `files_status` is used over the table's
 * `file_status` because every GET/POST example of this record uses it.
 */
function makeDetectLog(id, runMode) {
  const start = Math.floor(Date.now() / 1000)
  const stamp = new Date(start * 1000)
    .toISOString()
    .replace(/[-:T]/g, '_')
    .slice(0, 23)
  return {
    bin_mic_data_name: `mic_data_${stamp}.bin`,
    data_1: 0.0,
    data_2: -1.0,
    data_3: 0.0,
    data_4: 0.0,
    detect_mode: runMode === 1 ? 1 : 2,
    end_time: start + 3,
    files_status: 1,
    id,
    power_spect_photo_name: `power_spectrum_${stamp}.jpg`,
    power_spect_video_name: `power_spectrum_${stamp}.mp4`,
    saving_path: `${stamp}/`,
    soundmap_intensity: 20.4,
    soundmap_photo_name: `sound_${stamp}.jpg`,
    soundmap_video_name: `sound_${stamp}.mp4`,
    start_time: start,
    status: 1,
    voiceprint_photo_name: `voiceprint_${stamp}.jpg`,
    voiceprint_video_name: `voiceprint_${stamp}.mp4`,
    wav_mic_data_name: `mic_data_${stamp}.wav`,
    // --- spec table only, never in any example (spec §8.3/C15) -------------
    alarm_strategy_id: state.strategies.length ? state.strategies[0].id : 0,
    alarm_level: state.strategies.length ? state.strategies[0].level : 0,
    nc_file: state.ncFiles.length ? state.ncFiles[0].file_name : '',
    last_alarm_db: 0,
    last_alarm_df: 0,
    last_alarm_nc: 0,
    is_alarm: 0,
    nc_file_path: '',
    nc_file_fft_photo_name: ''
  }
}

function currentSysTime() {
  // Milliseconds. See GUESSES: the manual's 8-digit example pins nothing down.
  if (state.system.sys_time !== null) return state.system.sys_time
  return Date.now()
}

// ---------------------------------------------------------------------------
// Auth (spec §2)
// ---------------------------------------------------------------------------

/**
 * The manual says only "attach token to Authorization" (§2.2) and never whether
 * a `Bearer ` prefix belongs there. `raw` is the literal reading and therefore
 * the default; the other modes exist so the client's carrier fallback can be
 * exercised without a second mock.
 */
function authFailureReason(request) {
  const header = request.headers.authorization
  if (!header) {
    return `missing Authorization header; this mock expects ${expectedAuthForm()}`
  }
  if (args.authMode === 'raw' && header !== args.token) {
    return `Authorization must be the literal token (no "Bearer " prefix); got "${header}"`
  }
  if (args.authMode === 'bearer' && header !== `Bearer ${args.token}`) {
    return `Authorization must be "Bearer <token>"; got "${header}"`
  }
  return `Authorization must be either "<token>" or "Bearer <token>"; got "${header}"`
}

const AUTH_FORMS = {
  // Placeholders, not the live token: `both` mode would otherwise render the
  // configured token into the string and read as a blank expectation.
  raw: 'Authorization: <token>',
  bearer: 'Authorization: Bearer <token>',
  both: 'Authorization: <token> or Authorization: Bearer <token>'
}

function expectedAuthForm() {
  return AUTH_FORMS[args.authMode]
}

function isAuthorized(request) {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  if (header === args.token) return true
  return args.authMode !== 'raw' && header === `Bearer ${args.token}`
}

// ---------------------------------------------------------------------------
// System configuration endpoints
// ---------------------------------------------------------------------------

function handleAcoustic(method, body, response) {
  if (method === 'GET') return sendJson(response, 200, success({ ...state.system.acoustic }))
  patch(state.system.acoustic, body, ACOUSTIC_KEYS)
  savePersistedState()
  // Fields the PUT table marks non-essential are echoed back, because the
  // response body is entirely undefined (spec §5.1.3 缺口) and a GET-shaped
  // reply is the only thing a client can defensively parse.
  return sendJson(response, 200, success({ ...state.system.acoustic }))
}

function handleImage(method, body, response) {
  if (method === 'GET') {
    // `target_number` is emitted alongside `target_numbe`: the spec's table and
    // its example disagree on the spelling and both spellings are "must match"
    // verbatim, so the mock refuses to pick a winner. See GUESSES.
    return sendJson(response, 200, success({ ...state.system.image }))
  }
  if (body.target_number !== undefined && body.target_numbe === undefined) {
    body.target_numbe = body.target_number
  }
  patch(state.system.image, body, IMAGE_KEYS)
  savePersistedState()
  return sendJson(response, 200, success({ ...state.system.image }))
}

function handleVideo(method, body, response) {
  if (method === 'GET') return sendJson(response, 200, success({ ...state.system.video }))
  patch(state.system.video, body, VIDEO_KEYS)
  // `video_url` is not numeric: the table types it integer, every example sends
  // the string "live" (spec §8.3/C4). Strings pass through untouched above.
  if (body.video_url !== undefined) state.system.video.video_url = body.video_url
  savePersistedState()
  return sendJson(response, 200, success({ ...state.system.video }))
}

function handleRunMode(method, body, response) {
  if (method === 'GET') return sendJson(response, 200, success({ run_mode: state.system.run_mode }))
  const next = Number(body.run_mode)
  // Documented domain is exactly {1, -1}; anything else is rejected with the
  // only business-failure code the manual ever defines.
  if (next !== 1 && next !== -1) {
    return sendJson(response, 200, businessFailure('run_mode must be 1 (single) or -1 (cruise)'))
  }
  state.system.run_mode = next
  savePersistedState()
  return sendJson(response, 200, success({ run_mode: state.system.run_mode }))
}

/** Enum -> display string, mirroring the manual's §5.1.10 enum tables. */
const LEAKAGE_UNIT_STR = { 0: 'l/min', 1: 'ml/s' }
const MONETARY_UNIT_STR = { 0: 'CNY', 1: 'GBP', 2: 'USD', 3: 'EUR', 4: 'RUB' }

function handleLeakage(method, body, response) {
  if (method === 'GET') return sendJson(response, 200, success({ ...state.system.leakage }))
  patch(state.system.leakage, body, LEAKAGE_KEYS)
  // The *_str pair is derived rather than accepted: the manual lists them as
  // read fields and its PUT example omits them, so whether they are writable is
  // undefined (spec §5.1.11 缺口). Deriving keeps the pair self-consistent,
  // which the manual's own GET example is not (leakage_unit=1 with "l/min").
  state.system.leakage.leakage_unit_str = LEAKAGE_UNIT_STR[state.system.leakage.leakage_unit] ?? ''
  state.system.leakage.monetary_unit_str = MONETARY_UNIT_STR[state.system.leakage.monetary_unit] ?? ''
  savePersistedState()
  return sendJson(response, 200, success({ ...state.system.leakage }))
}

const SCAN_AREA_KEYS = ['area_height', 'area_width', 'detect_area_status', 'left_top_x', 'left_top_y']

function handleScanArea(method, body, response) {
  if (method === 'GET') return sendJson(response, 200, success({ ...state.system.scan_area }))
  if (Array.isArray(body.areas)) {
    // The manual requires ALL fields on PUT, so missing sub-fields are coerced
    // to 0 rather than inherited: silently keeping a previous value would hide
    // the client's own omission.
    state.system.scan_area.areas = body.areas.map((area) => {
      const next = {}
      for (const key of SCAN_AREA_KEYS) next[key] = Number(area?.[key] ?? 0) || 0
      return next
    })
  }
  if (body.center_focus !== undefined) {
    state.system.scan_area.center_focus = Number(body.center_focus)
  }
  savePersistedState()
  return sendJson(response, 200, success({ ...state.system.scan_area }))
}

// ---------------------------------------------------------------------------
// Detection lifecycle
// ---------------------------------------------------------------------------

function handleTurnOnDetect(response) {
  // Documented `-1`: no usable strategy. Only an ENABLED strategy counts, and
  // the read side's `Switch` is the only place that state is visible (spec §7.3).
  const usable = state.strategies.filter((strategy) => Number(strategy.Switch) === 1)
  if (usable.length === 0) {
    return sendJson(response, 200, businessFailure('no available alarm strategy'))
  }
  state.detecting = true
  const detectId = state.nextDetectId++
  state.currentDetectId = detectId
  // `detect_id` is documented as returned in single-detection mode only. A
  // cruise-mode caller gets one anyway, because returning nothing leaves the
  // client with no correlation id at all (spec §8.3/C11).
  return sendJson(response, 200, success({ detect_id: detectId }))
}

function handleTurnOffDetect(response) {
  if (state.detecting) {
    state.detecting = false
    const log = makeDetectLog(state.currentDetectId ?? state.nextDetectId++, state.system.run_mode)
    state.currentDetectId = null
    state.detectLogs.unshift(log)
    pushDetectFeedback(log)
  }
  // "does not return content" (spec §5.1.15) - an empty 200, not a JSON body.
  sendEmpty(response, 200)
}

// ---------------------------------------------------------------------------
// Alarm strategy / alarm condition
// ---------------------------------------------------------------------------

const PAGE_SIZE = 10

function strategyView(strategy) {
  const condition = state.conditions.find((item) => item.id === strategy.alarm_condition_id)
  return {
    id: strategy.id,
    name: strategy.name,
    alias: strategy.alias,
    // Read side renames `alarm_id` to `alarm_condition_id` and adds the name.
    alarm_condition_id: strategy.alarm_condition_id,
    alarm_condition_name: condition ? condition.name : '',
    interval_time: strategy.interval_time,
    Times: strategy.Times, // capital T, per the spec: do not "fix" it
    timeout_duration: strategy.timeout_duration,
    sensitivity: strategy.sensitivity,
    level: strategy.level,
    diagnosis: strategy.diagnosis,
    Switch: strategy.Switch // capital S, read side only
  }
}

function conditionView(condition) {
  return {
    id: condition.id,
    name: condition.name,
    decibel_thr: condition.decibel_thr,
    db_arithmetic_operator: condition.db_arithmetic_operator,
    db_switch: condition.db_switch,
    dominant_freq_thr: condition.dominant_freq_thr,
    df_arithmetic_operator: condition.df_arithmetic_operator,
    df_switch: condition.df_switch,
    df_logical_operator: condition.df_logical_operator,
    noise_comparison_file_id: condition.noise_comparison_file_id,
    noise_comparison_thr: condition.noise_comparison_thr,
    nc_switch: condition.nc_switch,
    nc_logical_operator: condition.nc_logical_operator,
    nc_arithmetic_operator: condition.nc_arithmetic_operator,
    Notes: condition.Notes
  }
}

function paginate(items, url) {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  const start = (page - 1) * PAGE_SIZE
  return { slice: items.slice(start, start + PAGE_SIZE), pageTotal: Math.max(1, Math.ceil(items.length / PAGE_SIZE)) }
}

const STRATEGY_NUMERIC = [
  'alarm_id',
  'alarm_condition_id',
  'level',
  'interval_time',
  'times',
  'Times',
  'timeout_duration',
  'sensitivity',
  'Switch'
]

async function handleAlarmStrategy(request, method, url, response) {
  if (method === 'GET') {
    const { slice, pageTotal } = paginate(state.strategies, url)
    return sendJson(response, 200, success({ alarm_strategy_list: slice.map(strategyView), page_total: pageTotal }))
  }

  const body = await readBody(request)

  if (method === 'POST') {
    const name = String(body.name ?? '')
    if (name.length < 1 || name.length > 20) {
      return sendJson(response, 200, businessFailure('name must be 1~20 characters'))
    }
    const condition = state.conditions.find((item) => item.id === Number(body.alarm_id ?? body.alarm_condition_id))
    if (!condition) {
      return sendJson(response, 200, businessFailure('alarm_id does not reference an existing alarm condition'))
    }
    const strategy = {
      id: state.nextStrategyId++,
      name,
      alias: String(body.alias ?? ''),
      alarm_condition_id: condition.id,
      interval_time: Number(body.interval_time ?? 0) || 0,
      // Write side is lowercase `times`; the read side calls the same value
      // `Times`. Accept both so a client that mirrors one spelling still works.
      Times: Number(body.times ?? body.Times ?? 0) || 0,
      timeout_duration: Number(body.timeout_duration ?? 0) || 0,
      sensitivity: Number(body.sensitivity ?? 0) || 0,
      level: Number(body.level ?? 0) || 0,
      // POST spells it `diagosisn` (a manual typo that must be sent verbatim);
      // PUT spells it `diagnosis`. Both are accepted - see GUESSES.
      diagnosis: String(body.diagosisn ?? body.diagnosis ?? ''),
      // Not a documented write field: there is NO enable/disable endpoint, so
      // creating at 0 is the only way to obtain a modifiable strategy.
      Switch: Number(body.Switch ?? 0) || 0
    }
    state.strategies.push(strategy)
    savePersistedState()
    // The manual never says how a caller learns the new id (spec §8.3/C22);
    // returning it alongside the envelope is the only way to round-trip.
    return sendJson(response, 200, success({ id: strategy.id }))
  }

  if (method === 'PUT') {
    const strategy = state.strategies.find((item) => item.id === Number(body.id))
    if (!strategy) return sendJson(response, 200, notFound('strategy not found'))
    // "Enabled policies cannot be modified." The check runs against the state
    // as loaded - otherwise sending Switch:0 with the edit would also be a way
    // to defeat the documented rule the spec asks us to preserve.
    if (Number(strategy.Switch) === 1) {
      return sendJson(response, 200, businessFailure('the strategy is enabled and cannot be modified'))
    }
    if (body.name !== undefined) {
      const name = String(body.name)
      if (name.length < 1 || name.length > 20) {
        return sendJson(response, 200, businessFailure('name must be 1~20 characters'))
      }
      strategy.name = name
    }
    if (body.alias !== undefined) strategy.alias = String(body.alias)
    if (body.alarm_id !== undefined || body.alarm_condition_id !== undefined) {
      const conditionId = Number(body.alarm_id ?? body.alarm_condition_id)
      const condition = state.conditions.find((item) => item.id === conditionId)
      if (!condition) return sendJson(response, 200, businessFailure('alarm_id does not reference an alarm condition'))
      strategy.alarm_condition_id = condition.id
    }
    const { id: _ignoredId, ...strategyFields } = body
    patch(strategy, strategyFields, STRATEGY_NUMERIC)
    if (body.diagosisn !== undefined) strategy.diagnosis = String(body.diagosisn)
    if (body.diagnosis !== undefined) strategy.diagnosis = String(body.diagnosis)
    if (body.times !== undefined) strategy.Times = Number(body.times)
    savePersistedState()
    return sendJson(response, 200, success({ id: strategy.id }))
  }

  if (method === 'DELETE') {
    const ids = extractIds(body, url)
    if (ids.length === 0) {
      return sendJson(response, 400, businessFailure('no strategy ids supplied (bare array, {"id":[...]} or ?id=1,2)'))
    }
    let removed = 0
    for (const id of ids) {
      const index = state.strategies.findIndex((item) => item.id === id)
      if (index === -1) continue
      state.strategies.splice(index, 1)
      removed += 1
    }
    savePersistedState()
    return sendJson(response, 200, success({ deleted: removed }))
  }

  return sendJson(response, 405, { ret: 405, msg: `method ${method} not allowed on /alarm_strategy` })
}

const CONDITION_NUMERIC = [
  'decibel_thr',
  'db_arithmetic_operator',
  'db_switch',
  'dominant_freq_thr',
  'df_arithmetic_operator',
  'df_switch',
  'df_logical_operator',
  'noise_comparison_file_id',
  'noise_comparison_thr',
  'nc_switch',
  'nc_logical_operator',
  'nc_arithmetic_operator',
  // Write-only trio: present in POST/PUT, absent from the read table AND from
  // every UI description (spec §8.3/C26). Stored so a client can see them
  // survive the round trip, but never echoed by GET.
  'discharge_switch',
  'discharge_logical_operator',
  'discharge_type'
]

async function handleAlarmCondition(request, method, url, response) {
  if (method === 'GET') {
    const { slice, pageTotal } = paginate(state.conditions, url)
    return sendJson(response, 200, success({ alarm_condition_list: slice.map(conditionView), page_total: pageTotal }))
  }

  const body = await readBody(request)

  if (method === 'POST') {
    const name = String(body.name ?? '')
    if (name.length < 1 || name.length > 20) {
      return sendJson(response, 200, businessFailure('name must be 1~20 characters'))
    }
    const condition = { id: state.nextConditionId++, name, Notes: String(body.notes ?? body.Notes ?? '') }
    // Strip `id`: the POST table does not define it, and letting a client body
    // overwrite a freshly assigned id would corrupt the list it just joined.
    const { id: _ignoredPostId, ...conditionPostFields } = body
    patch(condition, conditionPostFields, CONDITION_NUMERIC)
    // discharge_switch is typed string by the manual but holds 0/1; keep
    // whatever arrived so the client's own type confusion stays visible.
    if (body.discharge_switch !== undefined) condition.discharge_switch = body.discharge_switch
    state.conditions.push(condition)
    savePersistedState()
    return sendJson(response, 200, success({ id: condition.id }))
  }

  if (method === 'PUT') {
    // The spec's §5.1.28 request table has NO `id` field, which makes the target
    // unaddressable. We accept one (and `alarm_condition_id` as an alias) and
    // fall back to the lone condition when there is exactly one - documented in
    // GUESSES as the single largest unverified assumption in this mock.
    let condition = state.conditions.find((item) => item.id === Number(body.id ?? body.alarm_condition_id))
    if (!condition && state.conditions.length === 1) condition = state.conditions[0]
    if (!condition) {
      return sendJson(response, 200, notFound('cannot identify which alarm condition to modify (spec §5.1.28 defines no id)'))
    }
    if (state.strategies.some((s) => s.alarm_condition_id === condition.id && Number(s.Switch) === 1)) {
      return sendJson(
        response,
        200,
        businessFailure('the condition is bound to an enabled strategy and cannot be modified')
      )
    }
    if (body.name !== undefined) {
      const name = String(body.name)
      if (name.length < 1 || name.length > 20) {
        return sendJson(response, 200, businessFailure('name must be 1~20 characters'))
      }
      condition.name = name
    }
    const { id: _ignoredId, ...conditionFields } = body
    patch(condition, conditionFields, CONDITION_NUMERIC)
    if (body.notes !== undefined) condition.Notes = String(body.notes)
    if (body.Notes !== undefined) condition.Notes = String(body.Notes)
    if (body.discharge_switch !== undefined) condition.discharge_switch = body.discharge_switch
    savePersistedState()
    return sendJson(response, 200, success({ id: condition.id }))
  }

  if (method === 'DELETE') {
    const ids = extractIds(body, url)
    if (ids.length === 0) {
      return sendJson(response, 400, businessFailure('no condition ids supplied (bare array, {"id":[...]} or ?id=1,2)'))
    }
    // Documented `ret: -1`: a condition bound to a strategy cannot be deleted.
    // The manual does not say "bound to an ENABLED strategy" here (§5.1.29),
    // unlike the modify rule, so any binding blocks the delete.
    const bound = ids.filter((id) => state.strategies.some((s) => s.alarm_condition_id === id))
    if (bound.length > 0) {
      return sendJson(response, 200, businessFailure(`condition ${bound.join(',')} is bound to a strategy`))
    }
    let removed = 0
    for (const id of ids) {
      const index = state.conditions.findIndex((item) => item.id === id)
      if (index === -1) continue
      state.conditions.splice(index, 1)
      removed += 1
    }
    savePersistedState()
    return sendJson(response, 200, success({ deleted: removed }))
  }

  return sendJson(response, 405, { ret: 405, msg: `method ${method} not allowed on /alarm_condition` })
}

// ---------------------------------------------------------------------------
// Comparison files (read + delete only; upload is multipart, spec §5.1.30)
// ---------------------------------------------------------------------------

function ncFileView(file) {
  return {
    id: file.id,
    file_name: file.file_name,
    file_size: file.file_size,
    samplerate: file.samplerate,
    Duration: file.Duration, // capital D
    Notes: file.Notes // capital N
  }
}

async function handleNcFile(request, method, url, response) {
  if (method === 'GET') {
    const { slice, pageTotal } = paginate(state.ncFiles, url)
    return sendJson(response, 200, success({ nc_file_list: slice.map(ncFileView), page_total: pageTotal }))
  }
  const body = await readBody(request)
  const ids = extractIds(body, url)
  if (ids.length === 0) {
    return sendJson(response, 400, businessFailure('no file ids supplied (bare array, {"id":[...]} or ?id=1,2)'))
  }
  // The manual's §5.1.32 note ("bound => cannot delete") is copied from the
  // condition text and says "strategy", which is nonsense for a file. The
  // analogous rule is "bound to a condition", which is what we enforce.
  const bound = ids.filter((id) => state.conditions.some((c) => Number(c.noise_comparison_file_id) === id))
  if (bound.length > 0) {
    return sendJson(response, 200, businessFailure(`file ${bound.join(',')} is bound to an alarm condition`))
  }
  let removed = 0
  for (const id of ids) {
    const index = state.ncFiles.findIndex((item) => item.id === id)
    if (index === -1) continue
    state.ncFiles.splice(index, 1)
    removed += 1
  }
  savePersistedState()
  return sendJson(response, 200, success({ deleted: removed }))
}

// ---------------------------------------------------------------------------
// WebSocket (spec §5) - optional, enabled with --ws
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const WS_CLIENTS = new Map()

function wsEncode(payload, opcode = 0x2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  let header
  if (body.length < 126) {
    header = Buffer.alloc(2)
    header[1] = body.length
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, body])
}

/**
 * Minimal RFC6455 parser. Incoming frames only ever matter as heartbeats (the
 * manual requires an arbitrary message at least once a minute, §5.2 引言), so
 * anything data-shaped is accepted and control frames are answered properly.
 */
function wsConsume(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk])
  for (;;) {
    const buffer = client.buffer
    if (buffer.length < 2) return
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return socketDestroy(client.socket)
      length = Number(big)
      offset = 10
    }
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return
    const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length))
    if (masked) {
      const key = buffer.subarray(offset, offset + 4)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= key[index % 4]
    }
    client.buffer = buffer.subarray(offset + maskLength + length)
    if (opcode === 0x8) {
      client.socket.end(wsEncode(Buffer.alloc(0), 0x8))
      return
    }
    if (opcode === 0x9) {
      client.socket.write(wsEncode(payload, 0xa))
      continue
    }
    // Any other frame is a heartbeat. Log it: the heartbeat requirement is the
    // one WebSocket rule the manual states unambiguously, so seeing it arrive
    // (or not) is the whole point of having these endpoints at all.
    if (args.verbose) {
      process.stdout.write(`[mock-fa371] ws heartbeat ${client.path} (${payload.length} bytes)\n`)
    }
    client.lastHeartbeat = Date.now()
  }
}

function socketDestroy(socket) {
  socket.destroy()
}

function fftFrame() {
  const buffer = Buffer.alloc(512 * 2)
  for (let index = 0; index < 512; index += 1) {
    buffer.writeInt16LE(Math.round(Math.random() * (2000 - index)), index * 2)
  }
  return buffer
}

function voiceprintFrame() {
  const buffer = Buffer.alloc(128 * 256 * 4)
  for (let index = 0; index < 128 * 256; index += 1) {
    buffer.writeInt32LE(Math.round(Math.random() * 255), index * 4)
  }
  return buffer
}

function energyFrame() {
  // [energy, pixel横坐标, pixel纵坐标, swath angle, azimuth angle] per target,
  // one group per configured target (max 3 per §5.1.5).
  const targets = Math.min(3, Math.max(1, Number(state.system.image.target_numbe) || 1))
  const buffer = Buffer.alloc(targets * 5 * 4)
  for (let index = 0; index < targets * 5; index += 1) {
    buffer.writeInt32LE(Math.round(Math.random() * 1000), index * 4)
  }
  return buffer
}

function pcmFrame() {
  // One second of 48 kHz float32 = 48000 samples; channel count is undefined
  // (spec §8.4/D5), so this mock assumes mono.
  const samples = 48000
  const buffer = Buffer.alloc(samples * 4)
  for (let index = 0; index < samples; index += 1) {
    buffer.writeFloatLE(Math.sin(index / 40) * 0.25, index * 4)
  }
  return buffer
}

function wsPush(client, payload, opcode) {
  if (client.socket.destroyed) return
  client.socket.write(wsEncode(payload, opcode))
}

/** Push to every client on one path. The payload is a FACTORY so that a frame
 *  is only built when somebody is actually listening: /pcmData frames are
 *  192 KB each and would otherwise be allocated every second for nobody. */
function wsBroadcast(path, buildPayload) {
  for (const client of WS_CLIENTS.values()) {
    if (client.path === path) wsPush(client, buildPayload())
  }
}

function pushDetectFeedback(log) {
  for (const client of WS_CLIENTS.values()) {
    if (client.path !== '/detectFeedback') continue
    // Text frame by default; the manual contradicts itself (spec §8.4/D7).
    wsPush(client, JSON.stringify({ detect_log: log, msg: 'SUCCESS', ret: 200 }), 0x1)
  }
}

function startWebSocketStreams() {
  const timers = [
    // "on average five times per second" (spec §5.2.1)
    setInterval(() => wsBroadcast('/fftData', fftFrame), 200),
    // "one frame per second" (spec §5.2.2)
    setInterval(() => wsBroadcast('/voiceprintData', voiceprintFrame), 1000),
    // "regularly" - the period is undefined (spec §8.4/D6); 1 Hz chosen.
    setInterval(() => wsBroadcast('/energyData', energyFrame), 1000),
    // "every second" (spec §5.2.5)
    setInterval(() => wsBroadcast('/pcmData', pcmFrame), 1000)
  ]
  for (const timer of timers) timer.unref?.()
}

const WS_PATHS = new Set(['/fftData', '/voiceprintData', '/detectFeedback', '/energyData', '/pcmData'])

function handleUpgrade(request, socket, head) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (!args.ws || !WS_PATHS.has(url.pathname)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const key = request.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }
  // No authentication is required: the manual never says how a WebSocket
  // connection authenticates (spec §8.4/D1), and inventing a check here would
  // make the mock reject a client that is behaving exactly as documented.
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  )
  socket.setNoDelay(true)
  const client = { socket, path: url.pathname, buffer: Buffer.alloc(0), lastHeartbeat: Date.now() }
  WS_CLIENTS.set(socket, client)
  if (head?.length) wsConsume(client, head)
  socket.on('data', (chunk) => wsConsume(client, chunk))
  const cleanup = () => WS_CLIENTS.delete(socket)
  socket.on('close', cleanup)
  socket.on('error', cleanup)
  process.stdout.write(`[mock-fa371] ws open ${url.pathname} (clients: ${WS_CLIENTS.size})\n`)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = request.method ?? 'GET'

  // ---- Login (spec §2.1) --------------------------------------------------
  if (path === '/login') {
    if (method !== 'POST') return sendJson(response, 405, { ret: 405, msg: 'POST required' })
    const body = await readBody(request)
    const username = body.username
    const supplied = String(body.password ?? '')
    // Compare the DERIVED form only: accepting the plaintext too would hide a
    // client that forgot the salt, which is the exact mistake §8.1/A3 flags.
    const accepted = username === args.user && supplied === derivePassword(args.password)
    if (!accepted) {
      // The manual does not define the failure body or even the status code
      // (spec §8.1/A7); 401 is what §2.3 says an authentication failure returns.
      return sendJson(response, 401, { ret: 401, msg: 'authentication failed' })
    }
    // NO ret/msg envelope here - this endpoint is documented as `{"token": ...}`
    // alone, and it is the one place the client must not expect an envelope.
    return sendJson(response, 200, { token: args.token })
  }

  // ---- Auth gate (spec §2.2) ---------------------------------------------
  if (!isAuthorized(request)) {
    return sendJson(response, 401, {
      ret: 401,
      msg: 'unauthorized',
      auth_mode: args.authMode,
      // The whole value of this mock is telling the client which carrier was
      // expected, since the manual refuses to.
      expected: expectedAuthForm(),
      reason: authFailureReason(request)
    })
  }

  // ---- Config -------------------------------------------------------------
  if (path === '/system/acoustic') {
    if (method === 'GET' || method === 'PUT') return handleAcoustic(method, await readBody(request), response)
  } else if (path === '/system/image') {
    if (method === 'GET' || method === 'PUT') return handleImage(method, await readBody(request), response)
  } else if (path === '/system/video') {
    if (method === 'GET' || method === 'PUT') return handleVideo(method, await readBody(request), response)
  } else if (path === '/run_mode') {
    if (method === 'GET' || method === 'PUT') return handleRunMode(method, await readBody(request), response)
  } else if (path === '/system/leakage') {
    if (method === 'GET' || method === 'PUT') return handleLeakage(method, await readBody(request), response)
  } else if (path === '/system/scan_area') {
    if (method === 'GET' || method === 'PUT') return handleScanArea(method, await readBody(request), response)
  } else if (path === '/turn_on_detect') {
    if (method === 'POST') return handleTurnOnDetect(response)
  } else if (path === '/turn_off_detect') {
    if (method === 'POST') return handleTurnOffDetect(response)
  } else if (path === '/system/detect_status') {
    if (method === 'GET') {
      // Deliberately envelope-free: the manual's only sample for this endpoint
      // is `{"detect_status": 0}` (spec §5.1.16, flagged as the one exception
      // in the whole set). A client that assumes an envelope must fail here.
      return sendJson(response, 200, { detect_status: state.detecting ? 1 : 0 })
    }
  } else if (path === '/detect_logs') {
    if (method === 'GET') {
      // `detect_id` is documented as a Query Param while `Request format` shows
      // a path segment (spec §8.3/C14). Both are honoured; page/page_size are
      // undefined (spec §8.2/B4) and therefore ignored.
      const detectId = url.searchParams.get('detect_id')
      const logs = detectId ? state.detectLogs.filter((log) => log.id === Number(detectId)) : state.detectLogs
      return sendJson(response, 200, success({ detect_logs: logs }))
    }
    if (method === 'DELETE') {
      const body = await readBody(request)
      const ids = extractIds(body, url)
      if (ids.length === 0) {
        return sendJson(response, 400, businessFailure('no log ids supplied (bare array, {"id":[...]} or ?id=1,2)'))
      }
      let removed = 0
      for (const id of ids) {
        const index = state.detectLogs.findIndex((log) => log.id === id)
        if (index === -1) continue
        state.detectLogs.splice(index, 1)
        removed += 1
      }
      savePersistedState()
      return sendJson(response, 200, success({ deleted: removed }))
    }
  } else if (path === '/system_time') {
    if (method === 'GET') return sendJson(response, 200, { sys_time: currentSysTime() })
    if (method === 'PUT') {
      // The documented path is /time_set_manually, but the manual's own
      // "Request format" row says /system_time (spec §8.3/C20). Accepting the
      // PUT here keeps a client that followed the body of the manual working.
      const body = await readBody(request)
      return applyManualTime(body, response)
    }
  } else if (path === '/time_set_manually') {
    if (method === 'PUT') return applyManualTime(await readBody(request), response)
  } else if (path === '/alarm_strategy') {
    return handleAlarmStrategy(request, method, url, response)
  } else if (path === '/alarm_condition') {
    return handleAlarmCondition(request, method, url, response)
  } else if (path === '/nc_filelist') {
    if (method === 'GET') return handleNcFile(request, method, url, response)
  } else if (path === '/nc_file') {
    if (method === 'DELETE') return handleNcFile(request, method, url, response)
  }

  // Method known but wrong verb - say so rather than 404, so a client typo is
  // not mistaken for a missing endpoint.
  return sendJson(response, 404, { ret: 404, msg: `no mock route for ${method} ${path}` })
}

function applyManualTime(body, response) {
  const raw = Number(body.time ?? body.sys_time)
  if (!Number.isFinite(raw)) return sendJson(response, 200, businessFailure('time must be a number'))
  // Read uses `sys_time`, write uses `time` (spec §8.3/C20), and the unit is
  // undefined (spec §8.3/C19). Anything that cannot be seconds is treated as ms.
  state.system.sys_time = raw >= 1e11 ? raw : raw * 1000
  savePersistedState()
  return sendJson(response, 200, success({ sys_time: state.system.sys_time }))
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadPersistedState()
if (args.seed && state.strategies.length === 0 && state.conditions.length === 0) {
  seedAlarmState()
  savePersistedState()
}

const server = http.createServer((request, response) => {
  // Request trace. A rejected login is otherwise invisible from the client
  // side, because the client only reports the response envelope.
  if (args.verbose) {
    process.stdout.write(`[mock-fa371] ${request.method} ${request.url}\n`)
  }
  route(request, response).catch((error) => {
    process.stdout.write(`[mock-fa371] ERROR ${request.method} ${request.url}: ${error.stack}\n`)
    if (!response.headersSent) sendJson(response, 500, { ret: 500, msg: error.message })
    else response.end()
  })
})

server.on('upgrade', handleUpgrade)

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address()
  if (args.ws) startWebSocketStreams()

  const lines = [
    '',
    'HERTZINNO FA371 mock device (online acoustic camera, leak-detection model)',
    `  listening    http://127.0.0.1:${address.port}`,
    `  ws           ${args.ws ? 'enabled: /fftData /voiceprintData /detectFeedback /energyData /pcmData' : 'disabled (pass --ws)'}`,
    `  login        ${args.user} / ${args.password}`,
    `  wire password ${derivePassword(args.password)}  (md5(plaintext + "${PASSWORD_SALT}"), spec §2.1)`,
    `  token        ${args.token}`,
    '',
    `  AUTH MODE    ${args.authMode}  ->  ${expectedAuthForm()}`,
    '               the manual never says whether "Bearer " belongs on the header',
    '               (spec §2.2, the number-one risk); raw = the literal reading.',
    '',
    `  stateful     alarm_strategy x${state.strategies.length}, alarm_condition x${state.conditions.length}, nc_file x${state.ncFiles.length}, detect_logs x${state.detectLogs.length}`,
    `  persistence  ${args.persist ? path.resolve(args.persist) : 'off (pass --persist <file>)'}`,
    '',
    '  GUESSED / UNVERIFIED FIELDS (the manual says 手册未说明 - do not trust these):',
    ...GUESSES.map((entry) => `    - ${entry}`)
  ]
  if (args.ws) {
    lines.push('  GUESSED / UNVERIFIED WEBSOCKET PAYLOADS:')
    lines.push(...WS_GUESSES.map((entry) => `    - ${entry}`))
  }
  lines.push(
    '',
    '  Try it:',
    `    node -e "const c=require('node:crypto');console.log(c.createHash('md5').update('${args.password}${PASSWORD_SALT}').digest('hex'))"`,
    `    curl -s -X POST http://127.0.0.1:${address.port}/login -H 'Content-Type: application/json' -d '{"username":"${args.user}","password":"<hash above>"}'`,
    `    curl -s http://127.0.0.1:${address.port}/system/acoustic -H 'Authorization: ${args.token}'`,
    ''
  )
  process.stdout.write(`${lines.join('\n')}\n`)
})

// SIGINT/SIGTERM flush the fixture, so `--persist` survives Ctrl-C.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    savePersistedState()
    process.exit(0)
  })
}
