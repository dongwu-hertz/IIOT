'use strict'
/*
 * 第 50 轮五条的 GUI 验证 launcher（业主 2026-09-26 那五条）。
 *
 * 与 `scripts/verify-gis-ai.cjs` / `demo-shot.cjs` 同一套接线：本文件是**包装器**
 * （检查构建产物、生成把 driver 挂在应用入口之前的 wrapper、mkdtemp 一次性 profile、
 * 起 electron），断言都在 `verify-round50-driver.cjs` 里。
 *
 * 一次性 profile：不碰操作员的真实数据库 / 设置 / 登录态。
 *
 * 用法
 *   npm run build                    # 先出 out/（这条探针跑的是构建产物，不是源码）
 *   node scripts/verify-round50.cjs
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
const driver = path.join(__dirname, 'verify-round50-driver.cjs')

if (!fs.existsSync(mainEntry)) {
  console.error('[r50] 构建产物不存在：' + mainEntry + '\n先跑 npm run build')
  process.exit(1)
}
if (!fs.existsSync(driver)) {
  console.error('[r50] driver 不存在：' + driver)
  process.exit(1)
}

/** 语法检查：子进程优先，被拒时退回进程内编译（同 `demo-shot.cjs`）。 */
function parseCheck(file) {
  try {
    spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return null
  } catch (error) {
    if (error && error.code === 'EPERM') {
      try {
        // eslint-disable-next-line no-new
        new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file })
        return null
      } catch (parseError) {
        return String(parseError && parseError.message)
      }
    }
    return error.stderr ? error.stderr.toString() : error.message
  }
}
const parseError = parseCheck(driver)
if (parseError) {
  console.error('[r50] driver 语法检查失败：' + parseError)
  process.exit(1)
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-r50-'))
const wrapper = path.join(workDir, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// 在真实应用入口之前挂上 driver：它的 browser-window-created 监听必须先注册。\n' +
    'require(' + JSON.stringify(driver) + ')\n' +
    'require(' + JSON.stringify(mainEntry) + ')\n'
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-r50-profile-'))
// 存储根指到一次性 profile：绝不写操作员的真实数据目录（与 smoke 同一条规矩）。
const storageRoot = path.join(userDataDir, 'HertzinnoData')
fs.mkdirSync(storageRoot, { recursive: true })

/*
 * `--with-data`：把**真实数据库复制**进一次性 profile。
 *
 * 为什么需要它：空 profile 里一台设备都没有，实时监测页的设备下拉是空的、
 * 告警信息表也就没有任何行 —— "标题格 / 换页 / 与 PRPD 等高"这几条**量不出来**
 * （第一次跑就是 4 条假失败）。真实库里有那台声学相机与历史告警，量到的才是真东西。
 *
 * **只复制，绝不回写**：原库属于操作员，而且他的应用可能正在运行。
 * WAL 模式下 `-wal` / `-shm` 必须一起带上，否则复制出来的是缺了最近提交的旧快照。
 * 用户表清 0：一次性 profile 里让应用重建出厂管理员，探针自己登录（同 demo-shot）。
 */
if (process.argv.includes('--with-data')) {
  const sourceDir =
    process.env.HZ_DATA_DIR || path.join(process.env.APPDATA || '', 'hertzinno-acoustic-box-manager')
  const copied = []
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(sourceDir, `hertzinno-manager.db${suffix}`)
    if (!fs.existsSync(from)) continue
    const to = path.join(userDataDir, `hertzinno-manager.db${suffix}`)
    fs.copyFileSync(from, to)
    copied.push(path.basename(to))
  }
  if (copied.length === 0) {
    console.error('[r50] --with-data：在 ' + sourceDir + ' 里没找到 hertzinno-manager.db')
    process.exit(2)
  }
  try {
    const Database = require('better-sqlite3')
    const copy = new Database(path.join(userDataDir, 'hertzinno-manager.db'))
    // 待处理告警列表也一起带过来：告警信息表与告警中心的相机行都读它。
    copy.prepare('DELETE FROM users').run()
    copy.close()
  } catch (error) {
    console.error('[r50] --with-data：清账号失败：' + (error?.message ?? String(error)))
    process.exit(2)
  }
  console.log('[r50] with-data  : 从 ' + sourceDir + ' 复制了 ' + copied.join(', '))
}

const electronBinary = require('electron')
console.log('[r50] electron : ' + electronBinary)
console.log('[r50] userData : ' + userDataDir)
console.log('[r50] storage  : ' + storageRoot)

const isWindows = process.platform === 'win32'
const child = spawnSync(electronBinary, [wrapper, '--user-data-dir=' + userDataDir], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HERTZINNO_STORAGE_ROOT: storageRoot,
    HZ_R50_OUT: path.join(projectRoot, '.demo-shots-round50')
  },
  shell: isWindows && /\.(cmd|bat)$/i.test(electronBinary)
})

if (child.error) {
  console.error('[r50] 启动 electron 失败：' + child.error.message)
  process.exit(1)
}
console.log('[r50] electron exited with ' + child.status)
process.exit(child.status ?? 1)
