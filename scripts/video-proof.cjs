#!/usr/bin/env node
/**
 * PROOF HARNESS — not part of the shipped app.
 *
 * Answers one question no amount of offline testing can answer: **does the camera
 * video actually DECODE on screen?** Everything up to that point is measurable
 * without a browser — that ffmpeg accepts the RTSP URL, that the remuxed bytes
 * start with `ftyp`, that the loopback server serves them with Range support, that
 * the preload bridge hands the renderer a URL. None of that proves the renderer
 * turned those bytes into pictures, and a `<video>` with a valid `src` that never
 * decodes looks identical to a working one from the main process.
 *
 * So this boots the REAL built app against a THROWAWAY profile, adds the real
 * camera, starts the live session the same way the UI does, and then reads
 * Chromium's own numbers out of the page:
 *
 *   readyState          >= 2 means the demuxer has data for the current position
 *   videoWidth/Height   non-zero means a frame was DECODED and its size is known
 *   totalVideoFrames    the decoder's own frame counter
 *   currentTime         advances only while frames are actually being rendered
 *   <video>.error       a MediaError code, if the pipeline failed
 *
 * A throwaway profile is deliberate: it cannot disturb the operator's real device
 * list, database or settings, and it makes the add-device path run for real
 * instead of relying on a device row somebody left behind.
 *
 * The driver that runs inside Electron lives in `scripts/video-proof-driver.cjs`
 * as an ordinary file. It used to be generated as text from a template literal
 * here, which broke four different ways and could not be seen by any tool; see
 * that file's header for the full story. All this script generates now is a
 * two-line wrapper.
 *
 * USAGE
 *   node scripts/video-proof.cjs                 # add the default camera, prove playback
 *   node scripts/video-proof.cjs --ip HOST       # another camera
 *   node scripts/video-proof.cjs --route /       # prove the Overview window instead
 *   node scripts/video-proof.cjs --seconds 25    # longer observation window
 *   node scripts/video-proof.cjs --route /devices --box-ip HOST --box-rename-drill
 *
 * `--box-ip` 默认**关**：在临时 profile 里多登记一台声纹设备，就是在真机上多一次登录与
 * 一次探活。只有需要演练「改设备名 / 改通道名」时才给（那两个写入只能对着真实的声纹设备
 * 验证），而且还要再给 `--box-rename-drill` 才会真的写。
 *
 * `--box-rename-drill` 现在多做三件事（都在**临时 profile** 里，设备侧改动全部还原并读回）：
 *   1. 走**真实界面**改一次设备名（右键箱子行 → 修改设备名称 → 保存）再改回来：验证对话框
 *      真的关掉、成功提示、树上的字、以及 `get_devinfo` 的读回；
 *   2. 走**真实界面**改一次通道名（右键通道行 → 修改通道名称 → 保存）再改回来：读回**整张**
 *      通道表，确认其余七路逐字节不变；
 *   3. 回滚演练：把这一行临时指向一个**关着的端口**（地址仍是那台真机，一个字节都不会发到
 *      设备上），于是设备侧写入必然失败 —— 断言对话框留着、提示说明「本机名称已恢复原名」、
 *      本机那一行**真的**回到原名、树上不显示测试名字；最后把端口恢复并读回。
 */

'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const electronBinary = require('electron')
const projectRoot = path.resolve(__dirname, '..')

function parseArgs(argv) {
  const args = {
    ip: '192.168.110.235',
    port: 80,
    user: 'admin',
    password: '123456',
    /** 声纹设备（真机 `devname: AE08`）。空串 = 不登记。 */
    boxIp: '',
    boxPort: 80,
    boxUser: 'admin',
    boxPassword: '123456',
    /** 只有它为真时才会真的改设备名/通道名（并改回来）。 */
    boxRenameDrill: false,
    route: '/monitor',
    seconds: 20,
    observeOnly: false,
    out: path.join(projectRoot, '.demo-shots')
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--ip') { args.ip = value; i += 1 }
    else if (key === '--port') { args.port = Number(value); i += 1 }
    else if (key === '--user') { args.user = value; i += 1 }
    else if (key === '--password') { args.password = value; i += 1 }
    else if (key === '--box-ip') { args.boxIp = value; i += 1 }
    else if (key === '--box-port') { args.boxPort = Number(value); i += 1 }
    else if (key === '--box-user') { args.boxUser = value; i += 1 }
    else if (key === '--box-password') { args.boxPassword = value; i += 1 }
    else if (key === '--box-rename-drill') { args.boxRenameDrill = true }
    else if (key === '--route') { args.route = value; i += 1 }
    else if (key === '--seconds') { args.seconds = Number(value); i += 1 }
    else if (key === '--observe-only') { args.observeOnly = true }
    else if (key === '--out') { args.out = path.resolve(value); i += 1 }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  console.error(
    `Built entry not found: ${mainEntry}\n` +
      'Run: node ./node_modules/electron-vite/bin/electron-vite.js build'
  )
  process.exit(1)
}

const driver = path.join(__dirname, 'video-proof-driver.cjs')
if (!fs.existsSync(driver)) {
  console.error(`Driver not found: ${driver}`)
  process.exit(1)
}

// The driver is a real module, so `node --check` can see it before a browser
// launch is spent on it.
try {
  require('node:child_process').execFileSync(process.execPath, ['--check', driver], {
    stdio: 'pipe'
  })
} catch (error) {
  console.error(`[video] driver failed to parse: ${error.stderr ? error.stderr.toString() : error.message}`)
  process.exit(1)
}

fs.mkdirSync(args.out, { recursive: true })

// The ONLY generated text left: attach the driver before the app's own entry, so
// the driver's listeners exist before the app creates its window.
const wrapper = path.join(args.out, '_video-proof-wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    `require(${JSON.stringify(driver)})\n` +
    `require(${JSON.stringify(mainEntry)})\n`
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-video-proof-'))
console.log(`[video] electron : ${electronBinary}`)
console.log(`[video] camera   : ${args.user}@${args.ip}:${args.port}`)
console.log(`[video] box      : ${args.boxIp === '' ? '(not registered)' : args.boxUser + '@' + args.boxIp + ':' + args.boxPort}`)
console.log(`[video] route    : ${args.route}`)
console.log(`[video] userData : ${userDataDir}`)

const child = spawn(electronBinary, [wrapper, `--user-data-dir=${userDataDir}`], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HZ_VIDEO_PROOF: JSON.stringify({
      out: args.out,
      ip: args.ip,
      port: args.port,
      user: args.user,
      password: args.password,
      boxIp: args.boxIp,
      boxPort: args.boxPort,
      boxUser: args.boxUser,
      boxPassword: args.boxPassword,
      boxRenameDrill: args.boxRenameDrill,
      route: args.route,
      seconds: args.seconds,
      observeOnly: args.observeOnly
    })
  }
})

child.on('exit', (code) => {
  console.log(`[video] electron exited with ${code}`)
  process.exit(code ?? 1)
})
