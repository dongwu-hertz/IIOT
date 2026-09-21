'use strict'
/*
 * GIS 服务库 + AI 服务两项新功能的 GUI 验证（业主追加功能的人工辅助验证）。
 *
 * 接线方式与 `scripts/demo-shot.cjs` 完全一致：本文件是**包装器**（检查构建产物、
 * 生成把 driver 挂在应用入口之前的 wrapper、mkdtemp 一次性 profile、spawn electron），
 * 真正的断言都在 `verify-gis-ai-driver.cjs` 里。
 *
 * 一次性 profile：不碰操作员的真实数据库 / 设置 / 登录态。
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
const driver = path.join(__dirname, 'verify-gis-ai-driver.cjs')

if (!fs.existsSync(mainEntry)) {
  console.error('[verify] 构建产物不存在：' + mainEntry + '\n先跑 npm run build')
  process.exit(1)
}
if (!fs.existsSync(driver)) {
  console.error('[verify] driver 不存在：' + driver)
  process.exit(1)
}

// 与 demo-shot 同一套 parse check（子进程优先，EPERM 时退回进程内 vm.Script）。
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
  console.error('[verify] driver 语法检查失败：' + parseError)
  process.exit(1)
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-verify-gis-ai-'))
const wrapper = path.join(outDir, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// 在真实应用入口之前挂上 driver，让它的 browser-window-created 监听先于任何窗口注册。\n' +
    'require(' + JSON.stringify(driver) + ')\n' +
    'require(' + JSON.stringify(mainEntry) + ')\n'
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-verify-profile-'))

// 存储根：优先一次性 profile（绝不写操作员的真实数据目录）。
const storageRoot = path.join(userDataDir, 'HertzinnoData')
fs.mkdirSync(storageRoot, { recursive: true })

const electronBinary = require('electron')
console.log('[verify] electron   : ' + electronBinary)
console.log('[verify] userData   : ' + userDataDir)
console.log('[verify] storage    : ' + storageRoot)

const isWindows = process.platform === 'win32'
const child = spawnSync(electronBinary, [wrapper, '--user-data-dir=' + userDataDir], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HERTZINNO_STORAGE_ROOT: storageRoot
  },
  // Windows 上 electron 是 .cmd shim 时需要 shell 解释（与 smoke.cjs 同一判据）。
  shell: isWindows && /\.(cmd|bat)$/i.test(electronBinary)
})

if (child.error) {
  console.error('[verify] 启动 electron 失败：' + child.error.message)
  process.exit(1)
}
console.log('[verify] electron exited with ' + child.status)
process.exit(child.status ?? 1)
