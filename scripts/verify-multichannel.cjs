#!/usr/bin/env node
'use strict'
/*
 * 多通道同时显示的验证 launcher（业主 2026-09-24）。
 *
 * 它做四件事：
 *   1. 起一台 `scripts/mock-device.cjs`（带 WebSocket 实时流），端口随机；
 *   2. 生成一个一次性 Electron profile（**绝不动操作员的真实数据目录**）与一个
 *      wrapper（先 require driver 再 require 真实入口）；
 *   3. 跑真实应用，让 driver 在窗口里加设备、开流、勾选多路、读界面；
 *   4. 把 mock 侧记下的 WS 连接账（开了几条 / 每条要的是哪一路 / 设备当前通道怎么切）
 *      打在最后 —— 界面说"没收到这一路"时，这一份账就是它为什么没收到的证据。
 *
 * USAGE
 *   node scripts/verify-multichannel.cjs                         # follow-current（实测行为）
 *   node scripts/verify-multichannel.cjs --binding per-connection # 假设固件按连接绑通道
 *   node scripts/verify-multichannel.cjs --keep-log               # 保留日志文件路径打印
 *
 * 退出码：0 = 两种模式下所有判据都成立；1 = 有问题。
 *
 * ⚠️ 这是**模拟设备**，不是真机。它能验证"客户端与界面在两种固件行为下各自对不对"，
 * 不能证明真机属于哪一种 —— 真机（192.168.110.90）当时不可达。真机结论见
 * docs/PROTOCOL-FINDINGS.md §4B.4 的"未验证"清单。
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
const driver = path.join(projectRoot, 'scripts', 'verify-multichannel-driver.cjs')
const mockScript = path.join(projectRoot, 'scripts', 'mock-device.cjs')

/** 解析 `--binding <mode>` 等参数。 */
function parseArgs(argv) {
  const args = { binding: 'follow-current', keepLog: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--binding') {
      args.binding = argv[index + 1]
      index += 1
    } else if (flag === '--keep-log') {
      args.keepLog = true
    }
  }
  if (args.binding !== 'follow-current' && args.binding !== 'per-connection') {
    console.error('[mc] --binding 只支持 follow-current / per-connection')
    process.exit(2)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (!fs.existsSync(mainEntry)) {
  console.error('[mc] 没有构建产物：' + mainEntry + '（先 npm run build）')
  process.exit(2)
}

/** 语法检查（与 round50 同一条理由：driver 里的模板字符串很容易写坏）。 */
function parseCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  if (result.status === 0) return null
  return result.stderr ? result.stderr.toString() : 'exit ' + result.status
}

for (const file of [driver, mockScript]) {
  const error = parseCheck(file)
  if (error) {
    console.error('[mc] 语法检查失败：' + path.basename(file) + '\n' + error)
    process.exit(2)
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-mc-'))
const wsLog = path.join(workDir, 'ws.log')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-mc-profile-'))
const storageRoot = path.join(userDataDir, 'HertzinnoData')
fs.mkdirSync(storageRoot, { recursive: true })

/** 起 mock，并从它自己的 banner 里读出端口（比猜端口稳）。 */
function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [mockScript, '--port', '0', '--ws-binding', args.binding, '--ws-log', wsLog],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error('mock 没有在 15 秒内报出端口：\n' + buffer))
    }, 15_000)
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = /listening\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.stdout.on('data', (data) => {
          if (args.keepLog) process.stdout.write('[mock] ' + data.toString())
        })
        resolve({ child, port: Number(match[1]) })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', (data) => process.stderr.write('[mock:err] ' + data.toString()))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('mock 退出了，code=' + code + '\n' + buffer))
    })
  })
}

/** 读 mock 记下的连接账：开了几条 features 连接、每条请求了哪一路。 */
function readWsLog() {
  if (!fs.existsSync(wsLog)) return []
  return fs
    .readFileSync(wsLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

startMock()
  .then(({ child, port }) => {
    console.log('[mc] mock      : 127.0.0.1:' + port + '（binding=' + args.binding + '）')

    const wrapper = path.join(workDir, '_wrapper.cjs')
    fs.writeFileSync(
      wrapper,
      "'use strict'\n" +
        '// driver 的 browser-window-created 监听必须先于真实入口注册。\n' +
        'require(' + JSON.stringify(driver) + ')\n' +
        'require(' + JSON.stringify(mainEntry) + ')\n'
    )

    const electronBinary = require('electron')
    console.log('[mc] electron  : ' + electronBinary)
    console.log('[mc] userData  : ' + userDataDir)

    const isWindows = process.platform === 'win32'
    const result = spawnSync(electronBinary, [wrapper, '--user-data-dir=' + userDataDir], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        HERTZINNO_STORAGE_ROOT: storageRoot,
        HZ_MC_PORT: String(port),
        HZ_MC_BINDING: args.binding,
        MOCK_TRACE: ''
      },
      shell: isWindows && /\.(cmd|bat)$/i.test(electronBinary)
    })

    child.kill()

    const events = readWsLog()
    const opened = events.filter((event) => event.event === 'open')
    const features = opened.filter((event) => event.path === '/features_stream')
    const channelSelects = events.filter((event) => event.event === 'channel-select')
    const pingChannels = events.filter((event) => event.event === 'ping-channel')

    console.log('')
    console.log('[mc] ---- 设备侧连接账（mock 记的，不是界面说的）----')
    console.log('[mc] WS 连接总数        : ' + opened.length)
    console.log(
      '[mc] /features_stream   : ' +
        features.length +
        ' 条（主连接 1 条 + 每勾一路 1 条）'
    )
    console.log(
      '[mc] PUT /channel_select: ' +
        channelSelects.length +
        ' 次 -> ' +
        channelSelects.map((event) => 'CH' + (event.channel + 1)).join(' ')
    )
    console.log(
      '[mc] 带通道的订阅 ping  : ' +
        pingChannels.length +
        ' 次 -> ' +
        pingChannels.map((event) => 'CH' + (event.requested + 1)).join(' ')
    )
    console.log('[mc] 其它流             : ' + opened.filter((event) => event.path !== '/features_stream').length + ' 条')

    if (features.length < 1) {
      console.log('[mc] ✗ 一条 /features_stream 都没开：客户端在这台 mock 上就没能开流')
      process.exit(1)
    }
    if (features.length < 3) {
      console.log(
        '[mc] ✗ 只开了 ' +
          features.length +
          ' 条 /features_stream：勾了两路额外通道，应当是 3 条（主连接 + 2 条额外）'
      )
      process.exit(1)
    }

    if (result.error) {
      console.error('[mc] 启动 electron 失败：' + result.error.message)
      process.exit(1)
    }
    console.log('[mc] electron exit     : ' + result.status)
    if (args.keepLog) console.log('[mc] mock ws log       : ' + wsLog)
    process.exit(result.status ?? 1)
  })
  .catch((error) => {
    console.error('[mc] ' + (error && error.message ? error.message : String(error)))
    process.exit(1)
  })
