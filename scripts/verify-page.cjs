'use strict'
/*
 * 单页 GUI 冒烟：进一条路由，检查若干选择器**真的渲染出来了**，并把页面量到的事实打出来。
 *
 * WHY THIS EXISTS
 * 仓库里那 100 多个守卫测试大多是**把 `.vue` 当文本读**（`tests/page-layout.test.ts` 一类）。
 * 那种断言有个天然上限，这一轮清陈旧守卫时被反复撞到：
 *   · 它对**空白与容器类名极其敏感** —— 一次缩进重排、一次"把卡片包进 section"，
 *     就整批死在"找不到 X 的终点"上，而报出来的是断言失败，看起来像产品坏了；
 *   · 它证明不了"屏幕上真的有这个东西" —— 同一个选择器写在模板里，也可能被
 *     `v-if` 关着、被上层组件从没挂载、或者样式把它藏起来。
 *
 * 这个脚本补的就是后者：**真窗口里查 DOM**。用法是给一条路由 + 一组选择器，
 * 它登录、切路由、等元素出现，然后逐个告诉你"在不在、有几条、第一条的文本是什么"。
 *
 * 它**不替代**那些守卫（守卫能在构建前、无窗口时跑，跑得也快）；它替代的是
 * "为了证明屏幕上真有某个东西，去写一条对空白敏感的源码断言"这个做法。
 *
 * 用法
 *   node scripts/verify-page.cjs --route /monitor --wait ".camera-board" --check "[data-camera-panel=mode]"
 *   node scripts/verify-page.cjs --route /alarms --check ".alarm-workspace" --check "[data-alarm-detail]"
 *   node scripts/verify-page.cjs --route /monitor --text "应用场景"          # 正文里有没有这句话
 *   node scripts/verify-page.cjs --route /monitor --absent ".cctl__presets"  # 某个东西**不该**在
 *   node scripts/verify-page.cjs --route /monitor --select "Acoustic Camera" --check "[data-camera-pan
el=mode]"
 *
 * 参数
 *   --route  <path>      要进的路由（必填）
 *   --check  <selector>  必须存在（可重复）
 *   --absent <selector>  必须不存在（可重复）
 *   --text   <string>    页面正文里必须出现（可重复）
 *   --wait   <selector>  先等这个出现再开始查（默认等 `.app-content .page`）
 *   --select <name>      先在顶栏设备下拉里按名字选一台（可重复不了，只取第一个）
 *   --with-data          复制真实数据库（否则一次性 profile 里没有设备）
 *   --keep-open          查完不退出，留着窗口给人看
 *
 * 退出码：有任何一条不满足就是 1。**只跑得动真窗口的环境**才有意义（本机已可跑）。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
const driver = path.join(__dirname, 'verify-page-driver.cjs')

function parseArgs(argv) {
  const args = {
    route: '',
    checks: [],
    absents: [],
    texts: [],
    wait: '',
    select: '',
    all: false,
    withData: false,
    keepOpen: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--route') args.route = argv[++i] ?? ''
    else if (key === '--check') args.checks.push(argv[++i] ?? '')
    else if (key === '--absent') args.absents.push(argv[++i] ?? '')
    else if (key === '--text') args.texts.push(argv[++i] ?? '')
    else if (key === '--wait') args.wait = argv[++i] ?? ''
    else if (key === '--select') args.select = argv[++i] ?? ''
    else if (key === '--all') args.all = true
    else if (key === '--with-data') args.withData = true
    else if (key === '--keep-open') args.keepOpen = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const wantsAll = args.all === true
if (args.route === '' && !wantsAll) {
  console.error('[page] 需要 --route <path>（例如 --route /monitor），或者用 --all 跑全部路由')
  process.exit(2)
}
if (!fs.existsSync(mainEntry)) {
  console.error('[page] 构建产物不存在：' + mainEntry + '\n先跑 npm run build')
  process.exit(1)
}

/* ---- 语法检查：子进程优先，被拒时退回进程内编译（同 demo-shot.cjs） ---- */
try {
  spawnSync(process.execPath, ['--check', driver], { stdio: 'pipe' })
} catch (error) {
  if (error && error.code === 'EPERM') {
    try {
      // eslint-disable-next-line no-new
      new (require('node:vm').Script)(fs.readFileSync(driver, 'utf8'), { filename: driver })
    } catch (parseError) {
      console.error('[page] driver 语法检查失败：' + parseError.message)
      process.exit(1)
    }
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-page-'))
const wrapper = path.join(workDir, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// driver 必须先挂上：它的 browser-window-created 监听要早于任何窗口。\n' +
    'require(' + JSON.stringify(driver) + ')\n' +
    'require(' + JSON.stringify(mainEntry) + ')\n'
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-page-profile-'))
const storageRoot = path.join(userDataDir, 'HertzinnoData')
fs.mkdirSync(storageRoot, { recursive: true })

if (args.withData) {
  const sourceDir =
    process.env.HZ_DATA_DIR || path.join(process.env.APPDATA || '', 'hertzinno-acoustic-box-manager')
  let copied = 0
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(sourceDir, `hertzinno-manager.db${suffix}`)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(userDataDir, `hertzinno-manager.db${suffix}`))
    copied += 1
  }
  if (copied === 0) {
    console.error('[page] --with-data：在 ' + sourceDir + ' 里没找到 hertzinno-manager.db')
    process.exit(2)
  }
  try {
    const Database = require('better-sqlite3')
    const copy = new Database(path.join(userDataDir, 'hertzinno-manager.db'))
    copy.prepare('DELETE FROM users').run()
    copy.close()
  } catch (error) {
    console.error('[page] --with-data：清账号失败：' + (error?.message ?? String(error)))
    process.exit(2)
  }
  console.log('[page] with-data : 从 ' + sourceDir + ' 复制了 ' + copied + ' 个文件（只读复制）')
}

const electronBinary = require('electron')
const isWindows = process.platform === 'win32'
const child = spawnSync(electronBinary, [wrapper, '--user-data-dir=' + userDataDir], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HERTZINNO_STORAGE_ROOT: storageRoot,
    HZ_PAGE_JOB: JSON.stringify({
      route: args.route,
      checks: args.checks,
      absents: args.absents,
      texts: args.texts,
      wait: args.wait,
      select: args.select,
      all: wantsAll,
      keepOpen: args.keepOpen
    })
  },
  shell: isWindows && /\.(cmd|bat)$/i.test(electronBinary)
})

if (child.error) {
  console.error('[page] 启动 electron 失败：' + child.error.message)
  process.exit(1)
}
process.exit(child.status ?? 1)
