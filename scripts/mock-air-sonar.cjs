#!/usr/bin/env node
/**
 * PROOF FIXTURE — not part of the shipped app.
 *
 * Mock **SN-16 空气声呐**（Air Sonar）设备，只实现「拉」通道 + 球机联动（PTZ）用到的那几个端点。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（而不是用 `scripts/demo-shot-driver.cjs` 里那个假设备）
 * ---------------------------------------------------------------------------
 * 那个假设备活在 Electron 的渲染层进程里，只能证明**界面**那一半。而 `e2-live-proof.cjs`
 * 走的是**真应用的主进程**（真 `DeviceService` / `E2Client` / `E2SyncService` / 存储与回环端点），
 * 它需要一台**独立的 HTTP 设备**。真机不在手上的时候，只有这个 fixture 能让那条链先跑通 ——
 * 否则"真机一上线就跑"的那一步本身**从没被执行过**（第一次跑可能就是坏的）。
 *
 * 它按**真机 V3.4.0 实测过的形状**实现（见 `docs/Ivms4200-UX-REFERENCE.md` §15.37.4）：
 *   - 登录：`md5(password + 'lfxs')`，只认加盐那一种（不加盐回 401）；
 *   - 设备信息：真机是 `GET /basic`（手册写 `/get_device_basic_params`）—— **两条都实现**，
 *     因为客户端的回退逻辑就是为这件事写的；
 *   - 日志：真机是 `GET /alarm_log_all`（手册写 `/get_all_alarms`）—— 同样两条都答；
 *   - 文件：真机走静态路径 `/static_file/<saving_path><name>`，手册写 `/saving_alarm_file`；
 *   - `PUT /system`：**真的改**自己的参数（PTZ 的读回核对要读到变化）；
 *   - `GET /system`：球机那一组（`cam_*` 等），**没有** `work_mode` ⇒ 变体判成 airSonar。
 *
 * USAGE
 *   node scripts/mock-air-sonar.cjs                 # 随机端口
 *   node scripts/mock-air-sonar.cjs --port 9100
 *
 * 然后把真机验证指向它：
 *   node scripts/e2-live-proof.cjs --ip 127.0.0.1 --port <打印出来的端口> --password secret --spectrograms
 */

'use strict'

const http = require('node:http')
const { createHash, randomBytes } = require('node:crypto')

const PASSWORD_SALT = 'lfxs'
const SAMPLE_RATE = 20000

function parseArgs(argv) {
  const args = { port: 0, password: 'secret' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--port') {
      args.port = Number(argv[index + 1])
      index += 1
    } else if (flag === '--password') {
      args.password = argv[index + 1]
      index += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const TOKEN = 'mock-air-sonar-token'

/** 设备当前的 `/system`（`PUT /system` 会就地改它 —— 这是我们唯一"有状态"的地方）。 */
const params = {
  cam_enable: false,
  cam_ip: '192.168.2.64',
  cam_pass: 'AP1_lfxs_2025',
  cam_port: 80,
  cam_user: 'admin',
  cur_realtime_channel: 1,
  db_limit: 60,
  is_cam_init: false,
  is_ptz_direction_same_with_sonar: false,
  is_save_snapshot: true,
  notify_url: 'http://192.168.110.91:8080/api/v1/mock/telemetry',
  samplerate: SAMPLE_RATE
}

/** 一条告警（真机字段：`horizontal`/`vertical` 方位，`saving_path` 目录，固定 `alarm.wav`）。 */
const logEntry = {
  id: 54143,
  time: '2026-09-17_10-20-30',
  db_value: 70.59,
  tde_ratio: 39.17,
  fde_ratio: 0.97,
  horizontal: 45,
  vertical: 90,
  saving_path: '20260917_102030/',
  files_status: 1
}

/** 2 秒 16 位单声道 WAV（真 WAV 头，客户端会读表头拿采样率）。 */
function makeWavBytes(sampleRate, seconds) {
  const samples = sampleRate * seconds
  const data = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(12000 * Math.sin((index / sampleRate) * 2 * Math.PI * 440)), index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** 1×1 的合法 JPEG（抓图只要"能解码"就够了，内容无关）。 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
)

const server = http.createServer((request, response) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try {
      body = raw === '' ? {} : JSON.parse(raw)
    } catch {
      body = { __raw: raw }
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    console.log(`[mock-air-sonar] ${request.method} ${url.pathname}${url.search}`)

    const json = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    const file = (contentType, bytes) => {
      response.writeHead(200, { 'content-type': contentType })
      response.end(bytes)
    }

    // ---- 登录（只认加盐摘要） -------------------------------------------------
    if (url.pathname === '/login') {
      const salted = createHash('md5').update(args.password + PASSWORD_SALT).digest('hex')
      const plain = createHash('md5').update(args.password).digest('hex')
      const style = body.password === salted ? 'salted' : body.password === plain ? 'plain' : 'unknown'
      console.log(`[mock-air-sonar] login style: ${style}`)
      if (body.username === 'admin' && style === 'salted') return json(200, { token: TOKEN })
      return json(401, { ret: -1, msg: 'auth failed' })
    }

    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { ret: -1 })

    // ---- 参数：读 + 写（真的改） ----------------------------------------------
    if (url.pathname === '/system') {
      if (request.method === 'PUT') {
        console.log(`[mock-air-sonar] PUT /system body: ${JSON.stringify(body)}`)
        if (body && typeof body === 'object') Object.assign(params, body)
        return json(200, { ret: 0 })
      }
      return json(200, params)
    }

    // ---- 设备信息（两代路径都答：真机是 /basic） ------------------------------
    if (url.pathname === '/basic' || url.pathname === '/get_device_basic_params') {
      return json(200, {
        dev_name: 'Mock SN-16',
        dev_type: 'AS16-auth-vertical-reverse',
        dev_version: 'V3.4.0.2024-11-27',
        upgrade_time: '2024-11-27_10:00:00',
        web_version: 'WEBV2.3.0',
        equip_number: 'MOCK-SN16-0001'
      })
    }

    // ---- 日志（两代路径都答：真机是 /alarm_log_all） --------------------------
    if (
      url.pathname === '/alarm_log_all' ||
      url.pathname === '/alarm_log' ||
      url.pathname === '/get_all_alarms' ||
      url.pathname === '/get_alarm_logs_conditional'
    ) {
      return json(200, { logs_count: 1, logs: [logEntry] })
    }

    // ---- 文件：API 形态（手册）+ 静态形态（真机） -----------------------------
    if (url.pathname === '/alarm_files' || url.pathname === '/saving_alarm_file') {
      const filePath = url.searchParams.get('file_path') ?? ''
      if (filePath.endsWith('alarm.wav')) return file('audio/wav', makeWavBytes(SAMPLE_RATE, 2))
      if (/\.jpg$/i.test(filePath)) return file('image/jpeg', TINY_JPEG)
      return json(404, { ret: -1 })
    }
    if (url.pathname.startsWith('/static_file/')) {
      if (url.pathname.endsWith('alarm.wav')) return file('audio/wav', makeWavBytes(SAMPLE_RATE, 2))
      if (/\.jpg$/i.test(url.pathname)) return file('image/jpeg', TINY_JPEG)
      return json(404, { ret: -1 })
    }

    // ---- 与球机对时（手册没写请求体） -----------------------------------------
    if (url.pathname === '/time_sync_with_nvt') {
      console.log('[mock-air-sonar] time sync with NVT accepted')
      return json(200, { ret: 0 })
    }

    // ---- 空气声呐**没有**工作模式：这一条必须 404 ------------------------------
    if (url.pathname === '/workmode') {
      console.log('[mock-air-sonar] /workmode requested — 空气声呐没有这个端点（这一行不该出现）')
      return json(404, { ret: -1 })
    }

    return json(404, { ret: -1 })
  })
})

server.listen(args.port, '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(
    [
      '[mock-air-sonar] SN-16 空气声呐 fixture 已启动',
      `  baseUrl     http://127.0.0.1:${address.port}`,
      `  login       admin / ${args.password}（加盐 md5(${PASSWORD_SALT})）`,
      `  dev_type    AS16-auth-vertical-reverse（⇒ 16 通道）`,
      `  非接的端点  /workmode 会 404（那一代没有工作模式）`,
      `  真机验证    node scripts/e2-live-proof.cjs --ip 127.0.0.1 --port ${address.port} --password ${args.password} --spectrograms`,
      ''
    ].join('\n')
  )
  // 给脚本一个可读的"随机端口"，便于 shell 抓取。
  void randomBytes
})
