#!/usr/bin/env node
/**
 * DEMO / VERIFICATION HARNESS — not part of the shipped app.
 *
 * Boots the REAL built application (`out/main/index.js`) and captures PNG
 * screenshots of the actual rendered UI, so a demo can be checked against what
 * the renderer truly paints instead of against "the build succeeded". It also runs
 * the layout regression checks described in the driver's own header.
 *
 * WHY A GENERATED WRAPPER ENTRY
 * Electron has no flag for "run this extra code inside the main process", and the
 * app's own entry does not import anything test-related. So this script writes ONE
 * throwaway file next to the screenshots:
 *
 *   _wrapper.cjs  requires the driver FIRST, then the real app entry, and Electron
 *                 is launched against this file instead
 *
 * That two-line wrapper is the ONLY generated text. The driver itself is
 * `scripts/demo-shot-driver.cjs` — an ordinary file, because generating a whole
 * program as a template literal is a program that no tool can see, and this
 * harness proved that three times over (see that file's header). Its configuration
 * travels in the `HZ_DEMO_SHOT` environment variable.
 *
 * Renderer console errors and preload failures are collected too, because from the
 * outside a blank window and a healthy main process look identical — the same
 * reasoning `scripts/smoke-start.cjs` is built on.
 *
 * USAGE
 *   node scripts/demo-shot.cjs                      # every route
 *   node scripts/demo-shot.cjs --route /devices     # one route
 *   node scripts/demo-shot.cjs --keep-open          # leave the window up
 *   node scripts/demo-shot.cjs --rename-drill       # 真的改一次设备名/通道名，再改回来
 *
 * `--rename-drill` 是**显式**开关：它写的是操作员 profile 里的**真机**（改声纹设备的
 * 设备名与一路通道名，然后都改回原值）。默认那次运行一个字节都不写设备。
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
    out: path.join(projectRoot, '.demo-shots'),
    route: null,
    keepOpen: false,
    renameDrill: false,
    /** 把真实数据库复制进一次性 profile，让截图里有真设备（见下面那段说明）。 */
    withData: false,
    dataDir: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = path.resolve(argv[i + 1])
      i += 1
    } else if (argv[i] === '--route') {
      args.route = argv[i + 1]
      i += 1
    } else if (argv[i] === '--keep-open') {
      args.keepOpen = true
    } else if (argv[i] === '--rename-drill') {
      args.renameDrill = true
    } else if (argv[i] === '--with-data') {
      args.withData = true
    } else if (argv[i] === '--data-dir') {
      args.dataDir = path.resolve(argv[i + 1])
      i += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

/**
 * The routes to capture, in the order the sidebar lists them.
 *
 * The driver receives this list rather than hard-coding its own copy, so adding a
 * page here is the only edit needed.
 */
const ROUTES = [
  ['01-overview', '/'],
  ['02-devices', '/devices'],
  ['03-monitor', '/monitor'],
  ['04-events', '/events'],
  ['05-alarms', '/alarms'],
  ['06-recordings', '/recordings'],
  ['07-trends', '/trends'],
  ['08-protocol-lab', '/protocol-lab'],
  ['09-settings', '/settings'],
  // 本地样本库（schema v7，业主 2026-09-16）：导入导出 + AI 标注都在这一页。
  ['10-samples', '/samples'],
  /*
   * 点位图（业主 2026-09-17 第 8 批）：设备按录入的经纬度落点，点声呐看告警与抓图。
   *
   * 放在最后（而不是按侧栏顺序插在设备管理后面）：出图的编号是**历史稳定性**的一部分 ——
   * `01-…` 到 `10-…` 这一套名字在过去几轮里被引用过，重排会让旧截图与旧记录对不上号。
   */
  ['11-map', '/map']
]

const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  console.error(
    `Built entry not found: ${mainEntry}\n` +
      'Run: node ./node_modules/electron-vite/bin/electron-vite.js build'
  )
  process.exit(1)
}

const driver = path.join(__dirname, 'demo-shot-driver.cjs')
if (!fs.existsSync(driver)) {
  console.error(`Driver not found: ${driver}`)
  process.exit(1)
}

// The driver is a real module, so `node --check` can reject it before a browser
// launch is spent on it. A syntax error inside a GENERATED driver used to surface
// only as Electron's "App threw an error during load", pointing at a file nobody
// wrote.
try {
  execFileSync(process.execPath, ['--check', driver], { stdio: 'pipe' })
} catch (error) {
  console.error(
    `[demo] driver failed to parse: ${error.stderr ? error.stderr.toString() : error.message}`
  )
  process.exit(1)
}

fs.mkdirSync(args.out, { recursive: true })

const wrapper = path.join(args.out, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// Attach the demo driver BEFORE the real app entry runs, so its\n' +
    '// browser-window-created listener is registered before any window exists.\n' +
    `require(${JSON.stringify(driver)})\n` +
    `require(${JSON.stringify(mainEntry)})\n`
)

// A throwaway profile keeps the demo from touching the developer's real app data
// (database, logs, settings).
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-demo-'))

/**
 * `--with-data`：把**真实**数据库**复制**进这个一次性 profile。
 *
 * 为什么需要它（业主 2026-09-16 要求人工辅助验证 UI）：
 * 空 profile 里一台设备都没有，于是设备树、设备卡片、趋势筛选卡片全都走空态分支 ——
 * 截图上看不到这次改动真正要给人看的东西（两栏布局、树的层级、离线状态、通道行）。
 * 复制一份真实数据之后，截图里就是**操作员自己那两台设备**，人眼一比对就知道对不对。
 *
 * 只**复制**，绝不回写：原库属于操作员，而且他的应用可能正在运行。WAL 模式下必须把
 * `-wal` / `-shm` 一起带上，否则复制出来的是缺了最近提交的旧快照 —— 那种"看起来对、
 * 数据却是旧的"最难查。
 */
if (args.withData) {
  const sourceDir = args.dataDir || path.join(process.env.APPDATA || '', 'hertzinno-acoustic-box-manager')
  const copied = []
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(sourceDir, `hertzinno-manager.db${suffix}`)
    if (!fs.existsSync(from)) continue
    const to = path.join(userDataDir, `hertzinno-manager.db${suffix}`)
    fs.copyFileSync(from, to)
    copied.push(path.basename(to))
  }
  if (copied.length === 0) {
    console.error(`[demo] --with-data 找不到数据库：${path.join(sourceDir, 'hertzinno-manager.db')}`)
    process.exit(2)
  }
  /*
   * 把**副本**里的账号清掉，让应用自己重建出厂管理员（`admin` / `Hz@123456`，首次登录
   * 强制改密 —— 这是 `AuthService.ensureSeedAccount()` 每次启动都会做的：用户表为空才建）。
   *
   * 为什么必须这么做：真实库里的管理员密码是操作员自己改过的，探针不知道也不该知道它。
   * 而登录是后面所有页面断言的前提 —— 第一次带 `--with-data` 跑就是卡在
   * `AUTH_FAILED` 上，然后 32 个"问题"全是"页面根本没挂载"的连带噪声。
   *
   * 清的是**副本**：设备、通道、设置、告警全都留着，所以截图里仍然是操作员的真数据。
   */
  try {
    const Database = require('better-sqlite3')
    const copy = new Database(path.join(userDataDir, 'hertzinno-manager.db'))
    const removed = copy.prepare('DELETE FROM users').run().changes
    copy.close()
    console.log(`[demo] with-data  : 副本里清掉 ${removed} 个账号（应用会重建出厂管理员 admin）`)
  } catch (error) {
    console.error('[demo] with-data  : 清账号失败：' + (error?.message ?? String(error)))
    process.exit(2)
  }
  console.log(`[demo] with-data  : 从 ${sourceDir} 复制了 ${copied.join(', ')}（只读复制，不动原库）`)
}

console.log(`[demo] electron   : ${electronBinary}`)
console.log(`[demo] entry      : ${wrapper}`)
console.log(`[demo] driver     : ${driver}`)
console.log(`[demo] userData   : ${userDataDir}`)
console.log(`[demo] screenshots: ${args.out}`)

const child = spawn(electronBinary, [wrapper, `--user-data-dir=${userDataDir}`], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HZ_DEMO_SHOT: JSON.stringify({
      out: args.out,
      route: args.route,
      keepOpen: args.keepOpen,
      renameDrill: args.renameDrill,
      routes: ROUTES
    })
  }
})

child.on('exit', (code) => {
  console.log(`[demo] electron exited with ${code}`)
  process.exit(code ?? 1)
})
