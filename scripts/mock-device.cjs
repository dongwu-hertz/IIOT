#!/usr/bin/env node
/**
 * Mock FA8 device server.
 *
 * WHY THIS EXISTS
 * The most valuable parts of this codebase — auth strategy discovery, the
 * endpoint probes, the framing signature capture — cannot be validated by unit
 * tests alone, because their whole purpose is to cope with a device whose
 * behaviour is undocumented. A pure mock would just encode our assumptions
 * back at us.
 *
 * This server is therefore deliberately AWKWARD: it picks a non-obvious token
 * carrier, returns envelopes in inconsistent shapes, mixes seconds and
 * milliseconds, sends numbers as strings, and serves a stream that never ends.
 * If the diagnostic tool can describe THIS device correctly, it can describe a
 * real one.
 *
 * The carrier is selectable so every candidate strategy can be exercised.
 *
 * USAGE
 *   node scripts/mock-device.cjs                        # Bearer header (default)
 *   node scripts/mock-device.cjs --auth token-header    # custom `token` header
 *   node scripts/mock-device.cjs --auth query-token     # ?token=...
 *   node scripts/mock-device.cjs --auth cookie-session  # cookie
 *   node scripts/mock-device.cjs --port 9000
 */

'use strict'

const http = require('node:http')
const { createHash } = require('node:crypto')

/**
 * Salt used by the real firmware to derive the wire password: it sends
 * `md5(plaintext + "lfxs")`, not the plaintext. Mirrors
 * `src/main/services/device/auth-strategy.ts` so the fixture and the client
 * agree on what a valid login looks like.
 */
const PASSWORD_SALT = 'lfxs'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { auth: 'bearer-header', port: 0, token: 'MOCK-TOKEN-abcdef123456' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--auth') {
      args.auth = argv[index + 1]
      index += 1
    } else if (flag === '--port') {
      args.port = Number(argv[index + 1])
      index += 1
    } else if (flag === '--token') {
      args.token = argv[index + 1]
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

/** Does this request carry the token the way the configured strategy requires? */
function isAuthorized(request, url) {
  const headers = request.headers
  const token = args.token

  switch (args.auth) {
    case 'bearer-header':
      return headers.authorization === `Bearer ${token}`
    case 'raw-auth-header':
      return headers.authorization === token
    case 'token-header':
      return headers.token === token
    case 'x-token-header':
      return headers['x-token'] === token
    case 'cookie-session':
      return (headers.cookie ?? '').includes(token)
    case 'query-token':
      return url.searchParams.get('token') === token
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Fixture data — intentionally messy, mirroring real firmware quirks
// ---------------------------------------------------------------------------

const DEVICE_INFO = {
  // Identity is present, as it must be for the Manager to register the device.
  device_id: 'FA8-MOCK-0001',
  name: 'Mock Acoustic Box',
  mac: 'AA:BB:CC:DD:EE:FF',
  fpga_version: '1.4.2',
  device_version: '2.1.0',
  web_version: '1.0.7',
  // Deliberately a STRING, because real firmware does this.
  channel_num: '8'
}

const PASSAGEWAY = {
  // Envelope key differs from the documented one on purpose.
  passageways: [
    { channel_id: 0, channel_name: 'CH1 HV Winding', sensor_type: 0, enable: 1, alarm_id: 1 },
    { channel_id: 1, channel_name: 'CH2 LV Winding', sensor_type: 0, enable: 1, alarm_id: 1 },
    { channel_id: 2, channel_name: 'CH3 Core', sensor_type: 1, enable: 0, alarm_id: 2 },
    { channel_id: 3, channel_name: 'CH4 Tank', sensor_type: 1, enable: 1, alarm_id: 2 },
    { channel_id: 4, channel_name: 'CH5 Fan A', sensor_type: 0, enable: 1, alarm_id: 3 },
    { channel_id: 5, channel_name: 'CH6 Fan B', sensor_type: 0, enable: 1, alarm_id: 3 },
    { channel_id: 6, channel_name: 'CH7 OLTC', sensor_type: 0, enable: 1, alarm_id: 4 },
    { channel_id: 7, channel_name: 'CH8 Spare', sensor_type: 0, enable: 0, alarm_id: 4 }
  ]
}

// Port 0 present on purpose: this is the spec section 19 risk-7 evidence.
const NETWORK = {
  ip: '192.168.1.50',
  netmask: '255.255.255.0',
  gateway: '192.168.1.1',
  dns: '8.8.8.8',
  http_port: 80,
  rtsp_port: 554,
  tcp_port: 0,
  mac: 'AA:BB:CC:DD:EE:FF',
  dhcp: 0
}

const ALARM_SYSTEM = {
  // The real firmware variable names, which must never reach the UI.
  alarm_list: [
    {
      alarm_id: 1,
      alarm_name: 'Winding discharge',
      dalFBETThre: 0.45,
      dalSPLThre: 78.5,
      dalMainFreqThre: 120.0,
      detection_mode: 1
    }
  ]
}

const AUDIO_LIBRARY = {
  data: [
    {
      id: 1001,
      ch_id: 0,
      abnormal_type: 5,
      file_name: '20260226_140533_ch0.wav',
      audio_path: '/mnt/sdcard/audio/20260226_140533_ch0.wav',
      // Seconds, not milliseconds — the mapper must detect this by magnitude.
      alarm_time: 1772114733,
      duration: 30,
      sample_rate: 48000,
      spl: 81.2,
      main_freq: 119.8,
      smoothness: 0.72,
      freq_band_energy_ratio: 0.38
    },
    {
      id: 1002,
      ch_id: 2,
      abnormal_type: 68,
      file_name: '20260226_141210_ch2.wav',
      audio_path: '/mnt/sdcard/audio/20260226_141210_ch2.wav',
      alarm_time: 1772115130000,
      duration: 30000,
      sample_rate: '96000',
      spl: 66.4,
      main_freq: 240.1,
      smoothness: 0.88,
      freq_band_energy_ratio: 0.21
    }
  ],
  total: 2
}

const DATE_PUSH = {
  // Note the ABSENCE of a stable device_id — this is risk-4 evidence.
  feature_push: { enable: 1, url: 'http://192.168.1.100:8080/push/feature' },
  spectrum_push: { enable: 0, url: '' },
  alarm_push: { enable: 1, url: 'http://192.168.1.100:8080/push/alarm' },
  heartbeat: { enable: 1, interval: 30 }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  })
  response.end(body)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Request trace. Without this, a rejected login is invisible from the client
  // side — the client only reports the response envelope, so there is no way to
  // tell "wrong body shape" apart from "never arrived".
  if (process.env.MOCK_TRACE) {
    console.log(`[mock] ${request.method} ${path}`)
  }

  // ---- Login --------------------------------------------------------------
  if (path === '/login') {
    if (request.method !== 'POST') {
      sendJson(response, 405, { code: 405, msg: 'method not allowed' })
      return
    }

    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = {}
      }

      // Accept BOTH envelope shapes.
      //
      // The real AE08 firmware (and therefore the client, per
      // docs/PROTOCOL-FINDINGS.md) requires the credentials nested inside
      // `msgBody`. Several of this mock's other endpoints deliberately insist on
      // the wrapper because that is a real trap. /login is NOT one of them: it
      // is the entry point of the documented offline workflow, so rejecting the
      // wrapped form made `npm run mock-device` + `npm run diagnose` fail with
      // "all token carriers rejected" against a mock that was behaving exactly
      // as the client was told to speak. A mock that only speaks the
      // documentation is useless for validating the client's measured
      // behaviour, so this endpoint accepts either.
      // The wire password is NOT the plaintext password.
      //
      // Measured on real AE08 hardware (docs/PROTOCOL-FINDINGS.md): the client
      // sends `md5(plaintext + "lfxs")` as lowercase hex, and the client here
      // does the same. A mock that compares the plaintext therefore rejects
      // every carrier with "invalid credentials", which the diagnostic reports
      // as "all token carriers rejected" — pointing at the auth resolver when
      // the real cause is the fixture. Accept the derived form (and the
      // plaintext, so the mock still tolerates a client built before the
      // derivation was measured).
      const credentials = parsed.msgBody ?? parsed
      const supplied = String(credentials.password ?? '')
      const accepted =
        credentials.username === 'admin' &&
        (supplied === 'secret' ||
          supplied === createHash('md5').update('secret' + PASSWORD_SALT, 'utf8').digest('hex'))

      if (!accepted) {
        sendJson(response, 401, { code: 1, msg: 'invalid credentials' })
        return
      }

      // Deliberately NOT the documented `token` field name for some modes, to
      // prove the alias search works. Also sets a cookie so the cookie strategy
      // has something to find.
      response.setHeader('Set-Cookie', `session=${args.token}; Path=/; HttpOnly`)
      const payload = { code: 0, msg: 'ok' }
      if (args.auth === 'cookie-session') {
        payload.session_id = args.token
      } else if (args.auth === 'token-header' || args.auth === 'x-token-header') {
        payload.token = args.token
      } else {
        payload.access_token = args.token
      }
      sendJson(response, 200, payload)
    })
    return
  }

  // ---- Auth gate ----------------------------------------------------------
  if (!isAuthorized(request, url)) {
    sendJson(response, 401, { code: 401, msg: 'unauthorized' })
    return
  }

  // ---- Streaming endpoints (never terminate) ------------------------------
  if (path === '/features_stream') {
    // Chunked JSON lines — one plausible real-world framing.
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' })
    let channel = 0
    const timer = setInterval(() => {
      if (response.writableEnded) {
        clearInterval(timer)
        return
      }
      const frame = {
        ch_id: channel,
        sound_pressure_level: 60 + Math.random() * 20,
        main_freq: 100 + Math.random() * 100,
        smoothness: 0.7 + Math.random() * 0.25,
        freq_band_energy_ratio: 0.2 + Math.random() * 0.4,
        hr_f: Math.random(),
        sc_f: Math.random(),
        sv_f: Math.random(),
        time_stamp: Math.floor(Date.now() / 1000)
      }
      response.write(`${JSON.stringify(frame)}\n`)
      channel = (channel + 1) % 8
    }, 1000)

    request.on('close', () => clearInterval(timer))
    return
  }

  if (path === '/audio_stream') {
    // Raw binary PCM — a DIFFERENT framing from /features_stream, which is
    // exactly the kind of inconsistency the diagnostic tool must reveal.
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked'
    })
    const timer = setInterval(() => {
      if (response.writableEnded) {
        clearInterval(timer)
        return
      }
      // 100 ms of 8-channel Float32 at 48 kHz = 4800 samples * 8 * 4 bytes.
      const frame = Buffer.alloc(4800 * 8 * 4)
      for (let index = 0; index < frame.length; index += 4) {
        frame.writeFloatLE(Math.sin(index / 100) * 0.1, index)
      }
      response.write(frame)
    }, 100)

    request.on('close', () => clearInterval(timer))
    return
  }

  if (path === '/freq_domain') {
    // A schema nobody documented: bare array of magnitude bins.
    const bins = Array.from({ length: 512 }, (_unused, index) => Math.random() * (1 - index / 512))
    sendJson(response, 200, { code: 0, data: bins })
    return
  }

  if (path === '/time_freq_domain') {
    // A different shape again: 2D matrix under an unexpected key.
    const matrix = Array.from({ length: 32 }, () =>
      Array.from({ length: 64 }, () => Math.random())
    )
    sendJson(response, 200, { code: 0, spectrogram: matrix, rows: 32, cols: 64 })
    return
  }

  // ---- Recording download (risk 6) ---------------------------------------
  const downloadMatch = /^\/audio_file\/(.+)$/.exec(path)
  if (downloadMatch) {
    const filename = decodeURIComponent(downloadMatch[1])
    // Serve a minimal but VALID 44-byte WAV header so a real player can open it.
    const sampleRate = 48_000
    const seconds = 1
    const dataBytes = sampleRate * seconds * 2
    const buffer = Buffer.alloc(44 + dataBytes)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataBytes, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataBytes, 40)
    for (let index = 0; index < dataBytes; index += 2) {
      buffer.writeInt16LE(Math.round(Math.sin(index / 20) * 8000), 44 + index)
    }
    response.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="${filename}"`
    })
    response.end(buffer)
    return
  }

  // ---- Structured endpoints ----------------------------------------------
  switch (path) {
    case '/get_devinfo':
      sendJson(response, 200, { code: 0, data: DEVICE_INFO })
      return
    case '/get_network':
      sendJson(response, 200, { code: 0, data: NETWORK })
      return
    case '/get_passageway':
      sendJson(response, 200, { code: 0, data: PASSAGEWAY })
      return
    case '/get_samplingrate':
      // kHz, not Hz — another unit quirk the mapper must absorb.
      sendJson(response, 200, { code: 0, data: { samplingrate: 48 } })
      return
    case '/get_alarm_system':
      sendJson(response, 200, { code: 0, data: ALARM_SYSTEM })
      return
    case '/get_timeset':
      sendJson(response, 200, { code: 0, data: { ntp_enable: 1, ntp_server: 'pool.ntp.org', timezone: 8 } })
      return
    case '/get_rs485':
      sendJson(response, 200, { code: 0, data: { baudrate: 9600, databits: 8, stopbits: 1, parity: 0 } })
      return
    case '/get_all_available_serial':
      sendJson(response, 200, { code: 0, data: ['/dev/ttyS0', '/dev/ttyS1'] })
      return
    case '/get_modbus_para':
      sendJson(response, 200, { code: 0, data: { enable: 1, slave_id: 1, port: 502 } })
      return
    case '/get_date_push':
      sendJson(response, 200, { code: 0, data: DATE_PUSH })
      return
    case '/get_audio':
    case '/get_alarm_audio':
      sendJson(response, 200, AUDIO_LIBRARY)
      return
    default:
      sendJson(response, 404, { code: 404, msg: `unknown endpoint: ${path}` })
      return
  }
})

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(
    [
      '',
      'HERTZINNO FA8 mock device',
      `  listening   http://127.0.0.1:${address.port}`,
      `  auth mode   ${args.auth}`,
      `  token       ${args.token}`,
      `  login       admin / secret`,
      '',
      'Diagnose it with:',
      `  node scripts/protocol-diagnose.cjs --ip 127.0.0.1 --port ${address.port} --user admin --pass secret`,
      ''
    ].join('\n')
  )
})
