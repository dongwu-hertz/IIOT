#!/usr/bin/env node
/**
 * PROOF HARNESS — not part of the shipped app.
 *
 * 回答一个离线测试回答不了的问题：**这套「拉」通道在一台真设备上到底通不通**。
 *
 * 单测用的是假设备（`tests/e2-client.test.ts` / `e2-sync.test.ts`），端到端探针用的是
 * 进程内的假设备（`demo-shot-driver.cjs` 的 `startMockE2Device`）—— 两者都只能证明
 * "我们按手册发了什么"，**证明不了真机是不是这么回的**。这个脚本就是补那一段：
 * 它跑**真实构建的应用**，用真实的 `DeviceService` / `E2Client` / `E2SyncService`
 * 对着真设备走完整条链，并把每一步的原话打出来。
 *
 * 三件设计上的事，都是为了"不碰操作员的东西"：
 *   1. **一次性 profile**（`--user-data-dir=<temp>`）：不会动操作员的设备表、设置与库；
 *   2. **凭据只从命令行来**（`--password`），不读操作员 profile 里的密文 —— 两个进程
 *      之间传的是你自己的口令，不是他的；
 *   3. **下载的文件落在这一次性 profile 的存储目录里**，不会写进他的存储根目录。
 *
 * USAGE
 *   node scripts/e2-live-proof.cjs --ip 192.168.110.50 --password 123456
 *   node scripts/e2-live-proof.cjs --ip HOST --port 80 --username admin --password PW --spectrograms
 *
 * 退出码：0 = 整条链走通；1 = 有一步失败（每一步的失败原因都打在屏幕上）。
 */

'use strict'

const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const electronBinary = require('electron')
const projectRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const args = {
    ip: '',
    port: 80,
    username: 'admin',
    password: '',
    /** 连时频谱图/抓图一起下（一条告警最多 10 次请求；默认关）。 */
    spectrograms: false,
    /** 一次同步最多处理几条日志。 */
    limit: 5,
    out: path.join(projectRoot, '.e2-live-proof')
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--ip') { args.ip = value; i += 1 }
    else if (key === '--port') { args.port = Number(value); i += 1 }
    else if (key === '--username') { args.username = value; i += 1 }
    else if (key === '--password') { args.password = value; i += 1 }
    else if (key === '--limit') { args.limit = Number(value); i += 1 }
    else if (key === '--spectrograms') args.spectrograms = true
    else if (key === '--out') { args.out = path.resolve(value); i += 1 }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.ip === '' || args.password === '') {
  console.error(
    '需要设备地址与口令（凭据只从命令行来，不读操作员 profile 里的密文）：\n' +
      '  node scripts/e2-live-proof.cjs --ip 192.168.110.50 --password 123456\n' +
      '  可选：--port 80 --username admin --limit 5 --spectrograms'
  )
  process.exit(2)
}

const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  console.error(
    `Built entry not found: ${mainEntry}\n` +
      'Run: node ./node_modules/electron-vite/bin/electron-vite.js build'
  )
  process.exit(1)
}

const driver = path.join(__dirname, 'e2-live-proof-driver.cjs')
if (!fs.existsSync(driver)) {
  console.error(`Driver not found: ${driver}`)
  process.exit(1)
}

// 驱动是一个真文件，所以 `node --check` 能在花掉一次浏览器启动之前就看出语法错误。
try {
  execFileSync(process.execPath, ['--check', driver], { stdio: 'pipe' })
} catch (error) {
  console.error(`[e2] driver failed to parse: ${error.stderr ? error.stderr.toString() : error.message}`)
  process.exit(1)
}

fs.mkdirSync(args.out, { recursive: true })

// 唯一生成的文本：两行 wrapper（先挂驱动，再 require 应用入口）。
const wrapper = path.join(args.out, '_e2-live-proof-wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    `require(${JSON.stringify(driver)})\n` +
    `require(${JSON.stringify(mainEntry)})\n`
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-e2-proof-'))
console.log(`[e2] electron : ${electronBinary}`)
console.log(`[e2] device   : ${args.username}@${args.ip}:${args.port}`)
console.log(`[e2] userData : ${userDataDir}（一次性 profile：不碰操作员的库与设置）`)
console.log(`[e2] storage  : 这次下载的文件落在这个 profile 的存储目录里`)

const child = spawn(electronBinary, [wrapper, `--user-data-dir=${userDataDir}`], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HZ_E2_LIVE_PROOF: JSON.stringify({
      out: args.out,
      ip: args.ip,
      port: args.port,
      username: args.username,
      password: args.password,
      limit: args.limit,
      spectrograms: args.spectrograms,
      /** 一次性 profile 的路径：驱动用它确认存储根目录确实在临时目录里。 */
      profileDir: userDataDir
    })
  }
})

child.on('exit', (code) => {
  console.log(`[e2] electron exited with ${code}`)
  process.exit(code ?? 1)
})
