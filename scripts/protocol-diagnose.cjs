/**
 * Standalone protocol diagnostic CLI.
 *
 * WHY THIS EXISTS
 * Spec section 19 lists five protocol behaviours that are documented nowhere.
 * Resolving them requires a real device, and requiring a working GUI before you
 * can measure anything is backwards — especially since the answers determine
 * how the GUI must be built.
 *
 * This tool therefore talks to a device directly from Node, with no Electron
 * and no database. It answers the same questions as the Protocol Lab screen and
 * prints a report that can be pasted into a bug tracker or the spec's risk
 * table.
 *
 * It is READ-ONLY. No endpoint that mutates device state is ever called, so it
 * is safe to run against a production box.
 *
 * USAGE
 *   node scripts/protocol-diagnose.cjs --ip 192.168.1.50 --user admin --pass secret
 *   node scripts/protocol-diagnose.cjs --ip 192.168.1.50 --user admin --pass secret --port 8080
 *   node scripts/protocol-diagnose.cjs --help
 *
 * The password may also come from the ACOUSTIC_BOX_PASSWORD environment
 * variable, which keeps it out of the shell history and out of `ps` output.
 */

'use strict'

const path = require('node:path')
const fs = require('node:fs')

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { port: undefined, user: undefined, pass: undefined, ip: undefined, timeout: 8000 }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]
    switch (token) {
      case '--ip':
        args.ip = next
        index += 1
        break
      case '--port':
        args.port = Number(next)
        index += 1
        break
      case '--user':
      case '--username':
        args.user = next
        index += 1
        break
      case '--pass':
      case '--password':
        args.pass = next
        index += 1
        break
      case '--timeout':
        args.timeout = Number(next)
        index += 1
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        break
    }
  }
  return args
}

function usage() {
  process.stdout.write(`
HERTZINNO Acoustic Box 协议诊断工具（只读）

用法：
  node scripts/protocol-diagnose.cjs --ip <设备IP> --user <用户名> --pass <密码> [选项]

选项：
  --ip <addr>        设备 IP 地址（必填，可带端口，如 192.168.1.50:8080）
  --port <n>         HTTP 端口，默认 80
  --user <name>      登录用户名（必填）
  --pass <secret>    登录密码（必填；也可用环境变量 ACOUSTIC_BOX_PASSWORD）
  --timeout <ms>     单请求超时，默认 8000
  -h, --help         显示本帮助

说明：
  本工具只调用只读端点，不会修改设备任何配置，可安全用于生产设备。
  诊断结果用于确定规格书 §19 中未定义的协议行为。
`)
}

// ---------------------------------------------------------------------------
// Bundle discovery
// ---------------------------------------------------------------------------

/**
 * Locate the compiled diagnostic bundle.
 *
 * The CLI reuses the SAME code as the app (transport, auth resolver, protocol
 * lab) rather than reimplementing it. Keeping one implementation is the point:
 * a diagnostic tool that drifts from the product is worse than none.
 */
function resolveBundle() {
  const candidates = [
    path.join(__dirname, '..', '.test-build', 'src', 'main', 'services', 'device', 'protocol-lab.js')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const RED = '\u001b[31m'
const GREEN = '\u001b[32m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'

const supportsColour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (supportsColour ? `${code}${text}${RESET}` : text)

function heading(text) {
  process.stdout.write(`\n${paint(BOLD, text)}\n${paint(DIM, '─'.repeat(text.length + 8))}\n`)
}

function statusMark(ok) {
  return ok ? paint(GREEN, '✓') : paint(RED, '✗')
}

function printEndpoint(result, purposeByPath) {
  const purpose = purposeByPath.get(result.path)
  process.stdout.write(`\n  ${statusMark(result.ok)} ${paint(BOLD, result.path)} ${paint(DIM, `[${result.method}]`)}\n`)
  if (purpose) process.stdout.write(`      ${paint(DIM, purpose)}\n`)

  const facts = []
  if (result.status !== undefined) facts.push(`HTTP ${result.status}`)
  if (result.latencyMs !== undefined) facts.push(`${result.latencyMs}ms`)
  if (result.contentType) facts.push(result.contentType)
  if (result.chunked !== undefined) facts.push(result.chunked ? 'chunked' : 'non-chunked')
  if (result.receivedBytes !== undefined) facts.push(`${result.receivedBytes}B`)
  if (facts.length > 0) process.stdout.write(`      ${facts.join('  ·  ')}\n`)

  if (result.error) process.stdout.write(`      ${paint(YELLOW, result.error)}\n`)

  if (result.sampleAscii) {
    process.stdout.write(`      ${paint(DIM, 'ascii:')} ${result.sampleAscii.slice(0, 96)}\n`)
  }
  if (result.sampleHex) {
    process.stdout.write(`      ${paint(DIM, 'hex:  ')} ${result.sampleHex.slice(0, 96)}\n`)
  }
  if (result.json !== undefined) {
    const serialised = JSON.stringify(result.json)
    process.stdout.write(
      `      ${paint(DIM, 'json: ')} ${serialised.length > 400 ? `${serialised.slice(0, 400)}…` : serialised}\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help || (!args.ip && !process.argv.includes('--ip'))) {
    usage()
    process.exit(args.help ? 0 : 2)
  }

  const password = args.pass ?? process.env.ACOUSTIC_BOX_PASSWORD
  const missing = []
  if (!args.ip) missing.push('--ip')
  if (!args.user) missing.push('--user')
  if (!password) missing.push('--pass（或设置 ACOUSTIC_BOX_PASSWORD）')

  if (missing.length > 0) {
    process.stderr.write(`${paint(RED, '缺少必填参数：')}${missing.join(', ')}\n`)
    usage()
    process.exit(2)
  }

  const bundlePath = resolveBundle()
  if (!bundlePath) {
    process.stderr.write(
      `${paint(RED, '未找到已编译的诊断模块。')}\n` +
        `请先运行：${paint(BOLD, 'npm run test:build')}\n` +
        `该命令会把源码编译到 .test-build/ 供本工具使用。\n`
    )
    process.exit(3)
  }

  // Load the compiled shared + device modules.
  const buildRoot = path.join(__dirname, '..', '.test-build', 'src')
  const { ProtocolLab } = require(bundlePath)
  const { FetchHttpTransport } = require(path.join(buildRoot, 'main/services/device/http-transport.js'))
  const { AuthStrategyResolver } = require(path.join(buildRoot, 'main/services/device/auth-resolver.js'))
  const { DeviceApiClient, normaliseBaseUrl } = require(
    path.join(buildRoot, 'main/services/device/device-api-client.js')
  )
  const { CANDIDATE_STRATEGIES } = require(path.join(buildRoot, 'main/services/device/auth-strategy.js'))

  // Reuse the product's own URL normalisation so the CLI and the app agree on
  // what "192.168.1.50:8080" means.
  const rawTarget = args.port && args.port !== 80 ? `${args.ip}:${args.port}` : args.ip
  let baseUrl
  try {
    baseUrl = normaliseBaseUrl(rawTarget)
  } catch (error) {
    process.stderr.write(`${paint(RED, '设备地址无效：')}${error.message}\n`)
    process.exit(2)
  }
  const credential = { username: args.user, password }

  process.stdout.write(`\n${paint(BOLD + CYAN, 'HERTZINNO Acoustic Box 协议诊断')}\n`)
  process.stdout.write(`${paint(DIM, '目标')}  ${baseUrl}\n`)
  process.stdout.write(`${paint(DIM, '用户')}  ${args.user}\n`)
  process.stdout.write(`${paint(DIM, '模式')}  只读诊断（不会修改设备配置）\n`)

  const transport = new FetchHttpTransport(args.timeout)
  const resolver = new AuthStrategyResolver(transport)

  // ---- Step 1: auth carrier (spec section 19, risk 1) ---------------------
  heading('1. 认证方式探测（风险 1：Token 携带方式）')

  let client
  try {
    const resolution = await resolver.resolve({
      baseUrl,
      credential,
      timeoutMs: args.timeout
    })

    process.stdout.write(`  ${statusMark(true)} 认证成功\n`)
    process.stdout.write(`      策略 id   ${paint(BOLD, resolution.strategy.id)}\n`)
    process.stdout.write(`      载体      ${resolution.strategy.label}\n`)
    process.stdout.write(`      Token     ${resolution.session.token ? '已获取' : '无（每请求携带凭据）'}\n`)
    if (resolution.loginFieldNames.length > 0) {
      process.stdout.write(`      登录字段  ${resolution.loginFieldNames.join(', ')}\n`)
    }

    client = new DeviceApiClient({
      transport,
      resolver,
      baseUrl,
      credential,
      preferredStrategyId: resolution.strategy.id,
      timeoutMs: args.timeout
    })
    client.adoptSession(resolution.session, resolution.strategy)
  } catch (error) {
    process.stdout.write(`  ${statusMark(false)} 认证失败：${error.message}\n`)
    if (resolver.lastLoginFieldNames.length > 0) {
      process.stdout.write(
        `      登录响应字段：${resolver.lastLoginFieldNames.join(', ')}\n` +
          `      ${paint(YELLOW, '若其中有疑似 Token 字段但不在已知别名内，请扩展 auth-strategy.ts')}\n`
      )
    }
    process.stdout.write(
      `\n  ${paint(YELLOW, '已尝试的载体：')}\n` +
        CANDIDATE_STRATEGIES.map((strategy) => `      · ${strategy.id.padEnd(20)} ${strategy.label}`).join('\n') +
        '\n'
    )
    process.stdout.write(`\n${paint(DIM, '未建立会话，后续诊断无法进行。请先确认 IP、端口、用户名与密码。')}\n\n`)
    process.exit(1)
  }

  // ---- Step 2: full read-only diagnosis -----------------------------------
  // `credentials: null` is safe because we pass the already-authenticated
  // client below, which is the branch that does not consult the store.
  const lab = new ProtocolLab({ transport, credentials: null, timeoutMs: args.timeout })

  const device = {
    id: 'cli',
    deviceUid: 'cli',
    name: 'CLI target',
    ip: args.ip,
    ...(args.port ? { httpPort: args.port } : {}),
    connectionType: 'LAN',
    status: 'ONLINE',
    createdAt: Date.now(),
    updatedAt: Date.now()
  }

  heading('2. 端点探测')
  // Reuse the session established in step 1 rather than authenticating twice.
  const report = await lab.diagnose(device, client)

  // Group results so the report reads top-down rather than as a flat dump.
  const purposeByPath = new Map([
    ['/get_devinfo', '设备身份与版本'],
    ['/get_network', '网络参数（风险 7：端口字段语义）'],
    ['/get_passageway', '8 通道配置'],
    ['/get_samplingrate', '采样率单位'],
    ['/get_alarm_system', '告警参数真实字段名'],
    ['/get_timeset', '时间 / NTP'],
    ['/get_rs485', 'RS485 配置'],
    ['/get_modbus_para', 'Modbus 配置'],
    ['/get_date_push', 'Push 配置（风险 4：设备标识）'],
    ['/get_audio', '音频库结构（风险 6：下载路径）'],
    ['/get_alarm_audio', '告警录音结构'],
    ['/features_stream', '实时特征 framing（风险 2）'],
    ['/audio_stream', '实时 PCM framing（风险 2，最高优先级）'],
    ['/freq_domain', '频域数据 schema（风险 3）'],
    ['/time_freq_domain', '时频域数据 schema（风险 3）']
  ])

  process.stdout.write(`\n  ${paint(DIM, '结构化端点')}\n`)
  for (const result of report.endpoints) {
    if (result.path.startsWith('/audio_file/')) continue
    if (purposeByPath.get(result.path)?.includes('framing') || purposeByPath.get(result.path)?.includes('schema')) {
      continue
    }
    printEndpoint(result, purposeByPath)
  }

  process.stdout.write(`\n  ${paint(DIM, '流式端点（不主动结束，仅采样签名）')}\n`)
  for (const result of report.endpoints) {
    const purpose = purposeByPath.get(result.path) ?? ''
    if (!purpose.includes('framing') && !purpose.includes('schema')) continue
    printEndpoint(result, purposeByPath)
  }

  const download = report.endpoints.find((result) => result.path.startsWith('/audio_file/'))
  if (download) {
    process.stdout.write(`\n  ${paint(DIM, '录音下载（风险 6）')}\n`)
    printEndpoint(download, purposeByPath)
  }

  // ---- Step 3: conclusions ------------------------------------------------
  heading('3. 结论')
  for (const note of report.notes) {
    process.stdout.write(`  · ${note}\n`)
  }

  // ---- Step 4: machine-readable artifact ----------------------------------
  const outputPath = path.join(process.cwd(), `protocol-report-${Date.now()}.json`)
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        target: baseUrl,
        generatedAt: new Date().toISOString(),
        authStrategy: report.authStrategyDetected,
        loginFieldNames: report.loginFieldNames,
        endpoints: report.endpoints,
        notes: report.notes
      },
      null,
      2
    )
  )

  process.stdout.write(`\n${paint(GREEN, '完整报告已保存：')} ${outputPath}\n`)
  process.stdout.write(
    `${paint(DIM, '请将上面的"结论"回填到 README 第 6 节的协议未知项表格。')}\n\n`
  )
}

main().catch((error) => {
  process.stderr.write(`\n${paint(RED, '诊断过程中发生未预期的错误：')}\n${error?.stack ?? error}\n\n`)
  process.exit(1)
})
