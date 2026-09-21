#!/usr/bin/env node
/**
 * Platform verification — the checks that can only fail on a real Windows machine.
 *
 * WHY THIS EXISTS SEPARATELY FROM `smoke-start.cjs`
 * The smoke test answers "does the application boot". This answers "does it boot
 * on THIS platform, with THIS platform's native modules and credential store".
 * Three things cannot be verified anywhere except Windows:
 *
 *   1. the native addons are built for the right ABI on win32-x64;
 *   2. DPAPI is reachable through Electron's `safeStorage`, which is what keeps
 *      device passwords encrypted rather than in plain sight;
 *   3. the OS-specific choices resolve — `D:\HertzinnoData` when D: exists, the
 *      Documents folder otherwise.
 *
 * Run it from a plain terminal, not through `npm run dev`:
 *
 *   node scripts/platform-check.cjs
 *
 * It uses the BUILT output in `out/`, so run `npm run build` first.
 */

'use strict'

const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const projectRoot = path.resolve(__dirname, '..')
const results = []

const useColour = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code, text) => (useColour ? `\u001b[${code}m${text}\u001b[0m` : text)
const green = (text) => paint(32, text)
const red = (text) => paint(31, text)
const dim = (text) => paint(2, text)
const bold = (text) => paint(1, text)

function check(label, ok, detail) {
  results.push({ label, ok })
  process.stdout.write(`  ${ok ? green('✓') : red('✗')} ${label}${detail ? `  ${dim(detail)}` : ''}\n`)
}

function section(title) {
  process.stdout.write(`\n${bold(title)}\n`)
}

function report() {
  const passed = results.filter((entry) => entry.ok).length
  const failed = results.length - passed
  process.stdout.write(
    `\n${bold('结果')}  ${green(`${passed} 通过`)}${failed > 0 ? `，${red(`${failed} 失败`)}` : ''}\n`
  )
  if (failed > 0) {
    process.stdout.write('\n失败项：\n')
    for (const entry of results.filter((item) => !item.ok)) {
      process.stdout.write(`  ${red('✗')} ${entry.label}\n`)
    }
  }
  process.stdout.write('\n')
  process.exit(failed > 0 ? 1 : 0)
}

// ---------------------------------------------------------------------------
// 1. Host and toolchain
// ---------------------------------------------------------------------------

function checkHost() {
  section('主机与工具链')

  const isWindows = process.platform === 'win32'
  const targetArch = process.arch === 'x64' || process.arch === 'arm64'
  check(
    `平台 ${process.platform} / ${process.arch}`,
    isWindows && targetArch,
    isWindows
      ? '目标平台'
      : '在非 Windows 上运行 —— DPAPI 与 win32 原生模块未覆盖'
  )

  // The workspace path must not contain a space. node-gyp cannot build native
  // addons from such a path, and the failure message points at node-gyp rather
  // than at the real cause. The prebuilt binaries make this survivable today,
  // but it breaks the moment something has to compile.
  const hasSpace = projectRoot.includes(' ')
  check(
    '仓库路径不含空格',
    !hasSpace,
    hasSpace
      ? `路径含空格：${projectRoot} —— 换到 C:\\src\\... 之类的位置`
      : projectRoot
  )

  const node = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' })
  const nodeVersion = (node.stdout ?? '').trim()
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0])
  check('Node 版本 ≥ 22', major >= 22, nodeVersion)

  // electron-vite is the build tool; a missing install makes everything below
  // meaningless, so it is checked before the electron run.
  const hasDeps = fs.existsSync(path.join(projectRoot, 'node_modules', 'electron'))
  check('依赖已安装', hasDeps, hasDeps ? 'node_modules/electron 存在' : '请先运行 npm install')
}

// ---------------------------------------------------------------------------
// 2. Brand assets
// ---------------------------------------------------------------------------

function checkBrandAssets() {
  section('品牌资源')

  const assets = [
    { file: 'build/icon.ico', note: 'Windows 应用图标（多尺寸）' },
    { file: 'build/icon.png', note: 'macOS / Linux 图标源' },
    { file: 'src/renderer/src/assets/branding/hertzinno-logo.png', note: '界面 logo' }
  ]

  for (const asset of assets) {
    const full = path.join(projectRoot, asset.file)
    const exists = fs.existsSync(full)
    const size = exists ? fs.statSync(full).size : 0
    check(asset.note, exists && size > 0, exists ? `${asset.file} · ${size} 字节` : `缺少 ${asset.file}`)
  }

  // A single-size ICO is a common mistake and Windows falls back to the default
  // Electron icon for the views it cannot satisfy, which is easy to miss because
  // the small taskbar icon still looks right.
  const icoPath = path.join(projectRoot, 'build', 'icon.ico')
  if (fs.existsSync(icoPath)) {
    const header = fs.readFileSync(icoPath).subarray(0, 6)
    const imageCount = header.readUInt16LE(4)
    check(
      'ICO 含多种尺寸（Windows 需要 256px）',
      imageCount >= 5,
      `${imageCount} 个尺寸`
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Native addons — inside Electron, not plain Node
// ---------------------------------------------------------------------------

/**
 * Run a probe in the Electron runtime and return its parsed JSON result.
 *
 * Plain Node cannot answer this: the addons are compiled for Electron's ABI
 * (`process.versions.modules` differs), so a Node-side `require` either fails or,
 * worse, succeeds against a different build than the app will load.
 */
function probeInElectron(script) {
  const probeFile = path.join(projectRoot, '.platform-probe.cjs')
  fs.writeFileSync(probeFile, script, 'utf8')

  try {
    const electronBinary = require(path.join(projectRoot, 'node_modules', 'electron'))
    if (typeof electronBinary !== 'string') {
      return { error: 'electron 模块未返回二进制路径（请在普通 Node 下运行本脚本）' }
    }

    const run = spawnSync(electronBinary, [probeFile, '--disable-gpu', '--no-sandbox'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    })

    const stdout = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    const match = /@@PROBE@@([\s\S]*?)@@END@@/.exec(stdout)
    if (!match) {
      return { error: `探针无输出。stdout/stderr:\n${stdout.slice(-800)}` }
    }
    return JSON.parse(match[1])
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    fs.rmSync(probeFile, { force: true })
  }
}

function checkNativeAddons() {
  section('原生模块（必须在 Electron 运行时内验证）')

  const probe = probeInElectron(`
const { app } = require('electron')
app.whenReady().then(() => {
  const out = {
    electron: process.versions.electron,
    node: process.versions.node,
    modules: process.versions.modules,
    platform: process.platform,
    arch: process.arch
  }

  // The probe protocol is a SINGLE @@PROBE@@...@@END@@ marker, and the reader
  // takes the first one. Both checks must therefore finish before anything is
  // written, or the earlier result wins and the later one is silently dropped.
  const emit = () => {
    process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '@@END@@')
    app.exit(0)
  }

  // ---- better-sqlite3: synchronous API -----------------------------------
  try {
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t(a INTEGER)')
    db.prepare('INSERT INTO t VALUES (?)').run(1)
    out.sqlite = 'ok'
    out.sqliteVersion = db.prepare('select sqlite_version() v').get().v
    db.close()
  } catch (error) { out.sqlite = 'FAIL: ' + error.message.split('\\n')[0] }

  // ---- DuckDB: async, Node-API ------------------------------------------
  // A hung native load must not stall the whole platform check.
  const guard = setTimeout(() => { out.duckdb = 'FAIL: 超时（15 秒）'; emit() }, 15000)

  ;(async () => {
    const { DuckDBInstance } = require('@duckdb/node-api')
    const instance = await DuckDBInstance.create(':memory:')
    try {
      const connection = await instance.connect()
      const result = await connection.runAndReadAll('SELECT 42 AS answer')
      const rows = result.getRowObjects()
      out.duckdb = 'ok'
      out.duckdbAnswer = rows[0] ? Number(rows[0].answer) : null
    } finally {
      instance.closeSync()
    }
  })()
    .catch((error) => {
      out.duckdb = 'FAIL: ' + String(error.message).split('\\n')[0]
    })
    .finally(() => {
      clearTimeout(guard)
      emit()
    })
})
`)

  if (probe.error) {
    check('Electron 探针可运行', false, probe.error)
    return
  }

  check('Electron 运行时', true, `electron ${probe.electron} · node ${probe.node} · ABI ${probe.modules}`)
  check('better-sqlite3 可加载并查询', probe.sqlite === 'ok', probe.sqlite === 'ok' ? `SQLite ${probe.sqliteVersion}` : probe.sqlite)
  check(
    'duckdb 可加载并查询',
    probe.duckdb === 'ok' && probe.duckdbAnswer === 42,
    probe.duckdb === 'ok' ? `SELECT 42 返回 ${probe.duckdbAnswer}` : probe.duckdb
  )
}

// ---------------------------------------------------------------------------
// 4. Credential store — DPAPI on Windows
// ---------------------------------------------------------------------------

function checkCredentialStore() {
  section('凭据加密（Windows 上走 DPAPI）')

  const probe = probeInElectron(`
const { app, safeStorage } = require('electron')
app.whenReady().then(() => {
  const out = {}
  try {
    out.available = safeStorage.isEncryptionAvailable()
    out.backend = typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : '(not reported on this platform)'
    if (out.available) {
      const secret = 'probe-' + Date.now()
      const encrypted = safeStorage.encryptString(secret)
      const decrypted = safeStorage.decryptString(encrypted)
      out.roundTrip = decrypted === secret
      out.encryptedBytes = encrypted.length
      // Ciphertext must not contain the plaintext, which is the whole point.
      out.leaksPlaintext = encrypted.toString('latin1').includes(secret)
    }
  } catch (error) { out.error = error.message }
  process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '@@END@@')
  app.exit(0)
})
`)

  if (probe.error) {
    check('凭据探针可运行', false, probe.error)
    return
  }

  check(
    'OS 凭据加密可用',
    probe.available === true,
    probe.available ? `后端：${probe.backend}` : '不可用 —— 应用将仅在本会话内存中保留凭据'
  )

  if (probe.available) {
    check('加解密往返一致', probe.roundTrip === true, `${probe.encryptedBytes} 字节密文`)
    check(
      '密文中不含明文',
      probe.leaksPlaintext === false,
      probe.leaksPlaintext ? '⚠ 密文包含明文，加密未生效' : ''
    )
  } else {
    // Not a failure of the build: the application degrades safely by design. But
    // it must be understood, because it changes the user experience.
    check(
      '降级行为符合设计（不落明文）',
      true,
      '凭据仅存内存，重启后需重新输入 —— 规格书 14.1 要求，不得改为明文落盘'
    )
  }
}

// ---------------------------------------------------------------------------
// 5. Storage root resolution
// ---------------------------------------------------------------------------

function checkStorageRoot() {
  section('存储目录解析')

  const probe = probeInElectron(`
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
app.whenReady().then(() => {
  const out = {}
  out.hasDDrive = fs.existsSync('D:\\\\')
  out.docsPath = app.getPath('documents')
  out.userData = app.getPath('userData')

  // Mirror the choice made in services/app-services.ts.
  const resolved = process.platform === 'win32'
    ? (out.hasDDrive ? 'D:\\\\HertzinnoData' : path.join(out.docsPath, 'HertzinnoData'))
    : 'n/a'
  out.resolved = resolved

  try {
    fs.mkdirSync(path.join(resolved, 'audio'), { recursive: true })
    const probeFile = path.join(resolved, '.write-probe')
    fs.writeFileSync(probeFile, 'ok')
    fs.unlinkSync(probeFile)
    out.writable = true
  } catch (error) { out.writable = false; out.writeError = error.message }
  process.stdout.write('@@PROBE@@' + JSON.stringify(out) + '@@END@@')
  app.exit(0)
})
`)

  if (probe.error) {
    check('存储探针可运行', false, probe.error)
    return
  }

  check('D: 盘存在性已探测', true, probe.hasDDrive ? '存在 → 使用 D:\\HertzinnoData' : '不存在 → 回退到文档目录')
  check('解析出的存储根目录', Boolean(probe.resolved), probe.resolved)
  // Spec 4.4 requires the audio root to be movable to a large disk; a
  // non-writable default would make the app useless on first run.
  check(
    '存储根目录可写',
    probe.writable === true,
    probe.writable ? '' : probe.writeError ?? ''
  )
  check('用户数据目录', Boolean(probe.userData), probe.userData)
}

// ---------------------------------------------------------------------------
// 6. Built output and application boot
// ---------------------------------------------------------------------------

function checkBuiltOutput() {
  section('构建产物')

  const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
  const preloadEntry = path.join(projectRoot, 'out', 'preload', 'index.js')
  const rendererIndex = path.join(projectRoot, 'out', 'renderer', 'index.html')

  check('主进程产物存在', fs.existsSync(mainEntry), fs.existsSync(mainEntry) ? `${fs.statSync(mainEntry).size} 字节` : '请先运行 npm run build')
  check('preload 产物存在', fs.existsSync(preloadEntry))
  check('渲染层产物存在', fs.existsSync(rendererIndex))

  // The logo must have been emitted by the bundler with a content hash; if it is
  // missing the interface renders without branding and nothing else notices.
  const assetsDir = path.join(projectRoot, 'out', 'renderer', 'assets')
  const logoFiles = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir).filter((name) => name.startsWith('hertzinno-logo-'))
    : []
  check('logo 已被打包', logoFiles.length > 0, logoFiles[0] ?? '未找到 —— 界面将缺少品牌标识')
}

/**
 * Boot the built application and confirm it reaches a usable state.
 *
 * Reuses the same probe mechanism as `smoke-start.cjs`: a blank window and a
 * healthy main process look identical from the outside, so the renderer reports
 * on itself.
 */
function checkApplicationBoots() {
  section('应用启动')

  const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainEntry)) {
    check('应用启动', false, '缺少构建产物')
    return
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertzinno-platform-'))
  const electronBinary = require(path.join(projectRoot, 'node_modules', 'electron'))

  return new Promise((resolve) => {
    const child = spawn(
      electronBinary,
      [mainEntry, `--user-data-dir=${userDataDir}`, '--disable-gpu', '--no-sandbox'],
      {
        cwd: projectRoot,
        env: { ...process.env, ELECTRON_RENDERER_URL: '', HERTZINNO_SMOKE_TEST: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )

    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })

    // `finish` is reachable from BOTH the 20 s timer and the child's exit
    // handler, so a boolean makes it run once.
    //
    // The cleanup also must not be able to fail the run: on Windows the
    // Electron profile directory can still be locked when the process has only
    // just exited, and an EPERM escaping from `rmSync` inside a timer callback
    // becomes an uncaught exception that discards the entire report — every
    // check could have passed and the script would still print a stack trace
    // and exit non-zero. Deleting a temp directory is best effort; correctness
    // of the checks is not.
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      try { child.kill() } catch { /* already gone */ }

      const loaded = output.includes('[smoke] renderer-loaded')
      const bridge = extractJsonAfter(output, '[smoke] bridge ')

      check('主进程启动', output.includes('Starting HAIS'))
      check('IPC 处理器注册', output.includes('IPC handlers registered'))
      check('渲染层加载完成', loaded)
      check('preload 桥接可用', bridge?.api === true && bridge?.events === true, bridge ? `api=${bridge.api} events=${bridge.events}` : '')
      check('Vue 应用挂载', bridge?.mounted === true)
      check('品牌 logo 渲染', bridge?.logoLoaded === true, bridge?.logoLoaded === false ? 'naturalWidth 为 0' : '')

      if (bridge?.release) {
        check(
          '版本与发布信息',
          Boolean(bridge.release.version) && bridge.release.version !== '0.0.0-dev',
          `v${bridge.release.version} (${bridge.release.releaseDate || '未声明日期'}) · ${bridge.release.homepage}`
        )
      }

      const fatal = /Uncaught Exception|A JavaScript error occurred in the main process|Startup failed/i.test(output)
      check('无致命错误', !fatal)

      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      } catch {
        // Best effort: Windows may still hold the profile directory open.
      }
      resolve()
    }

    // Boot plus a renderer load typically takes 2-5 s on Windows; 20 s leaves
    // room for a cold start without hanging the check on a wedged process.
    const timer = setTimeout(finish, 20_000)
    child.on('exit', () => {
      clearTimeout(timer)
      // An early exit is itself the answer, so evaluate immediately rather than
      // waiting out the full timeout.
      setTimeout(finish, 500)
    })
  })
}

/**
 * Pull a JSON object out of a log line by matching braces.
 *
 * A non-greedy regex stops at the first `}`, which was fine while the report was
 * flat and silently wrong once it gained a nested `release` object — the parse
 * failed and every bridge check reported `false`, blaming the application for a
 * bug in this script.
 */
function extractJsonAfter(text, marker) {
  const start = text.indexOf(marker)
  if (start === -1) return null
  const open = text.indexOf('{', start)
  if (open === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) { escaped = false; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === '"') { inString = !inString; continue }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(open, index + 1)) } catch { return null }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write(`\n${bold('平台验证')}  ${projectRoot}\n`)

  checkHost()
  checkBrandAssets()
  checkNativeAddons()
  checkCredentialStore()
  checkStorageRoot()
  checkBuiltOutput()
  await checkApplicationBoots()

  report()
}

main().catch((error) => {
  process.stderr.write(`\n验证中断：${error?.stack ?? error}\n`)
  process.exit(1)
})
