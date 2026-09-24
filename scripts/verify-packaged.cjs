#!/usr/bin/env node
/**
 * Verify the PACKAGED application, not the development build.
 *
 * WHY THIS IS A SEPARATE SCRIPT
 * `scripts/platform-check.cjs` boots `out/main/index.js` with the development
 * Electron binary. That exercises none of the packaging-specific failure modes,
 * and this project has at least two that only appear after packing:
 *
 *   1. NATIVE MODULES. A `.node` binary cannot be loaded from inside an asar
 *      archive — the OS loader maps it into the address space and does not
 *      understand asar. `better-sqlite3` is loaded during startup, so a broken
 *      `asarUnpack` shows up immediately as a database that is never created.
 *
 *   2. LAZY NATIVE MODULES. `@duckdb/node-api` is required lazily inside
 *      TrendQueryService.runQuery, i.e. only when the user opens the trend page
 *      and queries. A missing or wrongly-unpacked binding therefore CANNOT be
 *      caught by any startup check — the app boots, every smoke assertion
 *      passes, and the feature fails in front of a customer. So this script
 *      verifies the binding's presence on disk in the unpacked tree explicitly.
 *      (Loading it inside the packaged process is not possible from outside:
 *      that would require executing arbitrary code in the packaged main process.
 *      Verifying the artefact landed where the loader looks, next to a passing
 *      startup that proves the loader works, is the strongest check available
 *      from outside the app.)
 *
 * USAGE
 *   node scripts/verify-packaged.cjs
 *   node scripts/verify-packaged.cjs --dir release/win-unpacked
 */

'use strict'

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

/**
 * Whether a missing signature is a FAILURE or a reported state.
 *
 * Off by default so the check is useful on a developer machine that has no
 * certificate (it prints the consequence instead of failing), on in CI and in
 * the release checklist so a signing regression cannot ship.
 */
const REQUIRE_SIGNATURE = process.env.HERTZINNO_REQUIRE_SIGNATURE === '1'
/** Expected CN, e.g. `HERTZINNO`. Empty means "do not check the publisher". */
const EXPECTED_PUBLISHER = process.env.HERTZINNO_EXPECTED_PUBLISHER || ''

function parseArgs(argv) {
  let dir = path.join(projectRoot, 'release', 'win-unpacked')
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') {
      dir = path.resolve(projectRoot, argv[i + 1])
      i += 1
    }
  }
  return { dir }
}

const { dir } = parseArgs(process.argv.slice(2))

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`)
}

/** Recursively find a file by name, bounded so a huge tree cannot hang the check. */
function findFile(root, name, maxDepth = 8) {
  const walk = (current, depth) => {
    if (depth > maxDepth) return null
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isFile() && entry.name === name) return full
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return walk(root, 0)
}

/** A Windows PE binary starts with 'MZ'; anything else is the wrong platform. */
function isWindowsBinary(file) {
  try {
    const handle = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(2)
    fs.readSync(handle, buffer, 0, 2, 0)
    fs.closeSync(handle)
    return buffer[0] === 0x4d && buffer[1] === 0x5a
  } catch {
    return false
  }
}

/**
 * Read the Authenticode signature OF THE FILE.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE REPLACED BY READING THE BUILD LOG
 * `electron-builder` prints `signing with signtool.exe <path>` for every file it
 * walks, whether or not a certificate is configured — the log line reports the
 * INTENT, not the outcome. This project produced a 105 MB installer whose log
 * showed four `signing with signtool.exe` lines while `Get-AuthenticodeSignature`
 * reported `NotSigned` on the artefact. Only the signature embedded in the file
 * settles the question, so it is read from the file here.
 *
 * Returns null when the state cannot be read at all (not Windows, no PowerShell).
 */
function readSignature(file) {
  if (process.platform !== 'win32') return null
  const literal = file.replace(/'/g, "''")
  const script = [
    // PowerShell 5.1 writes redirected stdout in the console codepage (GBK on a
    // Chinese Windows), which would garble a Chinese certificate subject before the
    // publisher comparison ever sees it.
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "$ErrorActionPreference='Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'`,
    '$c = $s.SignerCertificate',
    '$t = $s.TimeStamperCertificate',
    '$subject = $null; $thumb = $null; $notAfter = $null; $stamp = $null',
    "if ($c) { $subject = $c.Subject; $thumb = $c.Thumbprint; $notAfter = $c.NotAfter.ToString('yyyy-MM-dd') }",
    'if ($t) { $stamp = $t.Subject }',
    '[pscustomobject]@{ status = $s.Status.ToString(); subject = $subject; thumbprint = $thumb; notAfter = $notAfter; timestamper = $stamp } | ConvertTo-Json -Compress'
  ].join('; ')

  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

/** One-line human summary of a signature, for the check detail column. */
function describeSignature(info) {
  const commonName = /CN=([^,]+)/.exec(info.subject ?? '')?.[1]
  const parts = [info.status]
  if (commonName || info.subject) parts.push(`CN=${commonName ?? info.subject}`)
  if (info.thumbprint) parts.push(`指纹 ${String(info.thumbprint).slice(-8)}`)
  if (info.notAfter) parts.push(`证书到期 ${info.notAfter}`)
  parts.push(info.timestamper ? `已加时间戳（${String(info.timestamper).slice(0, 40)}）` : '未加时间戳')
  return parts.join(' · ')
}

/**
 * Assert the signature state of one artefact.
 *
 * POLICY
 *  - `Valid` is the only acceptable signed state. A `HashMismatch`/`NotTrusted`
 *    signature is WORSE than none: it looks signed to a human and is rejected by
 *    Windows, so it always fails.
 *  - A valid signature without a TIMESTAMP always fails. Signing without one is
 *    the quietest way to break a shipped installer: the signature is valid only
 *    until the certificate expires, and every copy already downloaded stops
 *    verifying on that day.
 *  - Unsigned is reported, not failed, unless HERTZINNO_REQUIRE_SIGNATURE=1.
 */
function checkSignature(label, file) {
  if (!file) {
    check(`代码签名（${label}）`, false, '未找到可执行文件')
    return
  }

  const info = readSignature(file)
  if (!info) {
    check(`代码签名（${label}）`, !REQUIRE_SIGNATURE, '无法读取签名状态')
    return
  }

  if (info.status === 'NotSigned') {
    check(
      `代码签名（${label}）`,
      !REQUIRE_SIGNATURE,
      REQUIRE_SIGNATURE
        ? '未签名，但 HERTZINNO_REQUIRE_SIGNATURE=1'
        : '未签名 —— SmartScreen 会提示"未识别"，Windows 11 Smart App Control 可直接阻止运行'
    )
    return
  }

  const problems = []
  if (info.status !== 'Valid') problems.push(`状态为 ${info.status}`)
  if (!info.timestamper) problems.push('没有 RFC3161 时间戳，证书过期后签名即失效')
  if (EXPECTED_PUBLISHER && !String(info.subject ?? '').includes(EXPECTED_PUBLISHER)) {
    problems.push(`发布者不是 ${EXPECTED_PUBLISHER}`)
  }

  check(
    `代码签名（${label}）`,
    problems.length === 0,
    problems.length ? `${describeSignature(info)} — ${problems.join('；')}` : describeSignature(info)
  )
}

/** First file in `root` (non-recursive) ending with `suffix`, or null. */
function findArtifact(root, suffix) {
  try {
    const hit = fs.readdirSync(root).find((name) => name.endsWith(suffix))
    return hit ? path.join(root, hit) : null
  } catch {
    return null
  }
}

/**
 * 这一版**刚打出来的**那个安装包（业主 2026-09-19 第 11 批第 1 条之后 `release/` 里会同时躺着
 * 好几个版本：文件名带上了版本与日期）。
 *
 * 为什么不能再用"第一个 `-setup.exe`"：`readdirSync` 的顺序不保证，而按字母序 `1.0.0` 排在
 * `1.0.1` 前面 —— 于是这一步会去**验证上一个版本**的包，报告里却是"安装包 ✓"。
 * 判据是 `scripts/release-stamp.cjs` 那个名字（它才是打包时写进文件名的那一个），
 * 展开 `${arch}` / `${ext}` 之后逐字比较；找不到就回落到旧行为并在日志里说清楚。
 */
function findCurrentInstaller(root) {
  try {
    const stamp = require(path.join(__dirname, 'release-stamp.cjs'))
    const wanted = stamp.artifactName.replace('${arch}', 'x64').replace('${ext}', 'exe')
    const hit = fs.readdirSync(root).find((name) => name === wanted)
    if (hit) return { path: path.join(root, hit), exact: true, wanted }
    return { path: findArtifact(root, '-setup.exe'), exact: false, wanted }
  } catch {
    return { path: findArtifact(root, '-setup.exe'), exact: false, wanted: null }
  }
}

async function main() {
  console.log('打包产物验证\n')
  console.log(`目录  ${dir}\n`)

  if (!fs.existsSync(dir)) {
    check('打包目录存在', false, `未找到 ${dir}，请先运行 npm run pack:dir`)
    report()
    return
  }
  check('打包目录存在', true, dir)

  // ---- The executables ----------------------------------------------------
  // productName 已改为 HAIS（业主 20260921）：exe 名随 electron-builder 的 productName。
  const exe = findFile(dir, 'HAIS.exe') ?? findFile(dir, 'HERTZINNO Acoustic Box Manager.exe')
  check('主程序存在', Boolean(exe), exe ? path.basename(exe) : '未找到 .exe')

  // ---- asar must be present (files are packed, not loose) -----------------
  const asar = path.join(dir, 'resources', 'app.asar')
  check('app.asar 存在', fs.existsSync(asar), fs.existsSync(asar) ? `${(fs.statSync(asar).size / 1024 / 1024).toFixed(1)} MB` : '')

  // ---- Native modules must be UNPACKED, not inside the archive ------------
  const unpackedRoot = path.join(dir, 'resources', 'app.asar.unpacked')
  check('asar.unpacked 目录存在', fs.existsSync(unpackedRoot))

  // `better-sqlite3` 13.x is Node-API based, and its resolver prefers
  // `prebuilds/<platform>-<arch>.node` over a compiled `build/Release` artefact
  // (see lib/binding.js). So the prebuilt binary IS the expected shipping form —
  // asserting on `better_sqlite3.node` would demand a file the package is
  // designed not to produce. What matters is that the file which WILL be loaded
  // exists and is a Windows binary. The in-process probe below then proves it
  // actually loads.
  const isPrebuiltFallback = (file) => /[\\/]prebuilds[\\/]/.test(file)

  const collectByName = (root, name) => {
    const found = []
    const walk = (dir, depth) => {
      if (depth > 10) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isFile() && entry.name === name) found.push(full)
        else if (entry.isDirectory()) walk(full, depth + 1)
      }
    }
    walk(root, 0)
    return found
  }

  const sqlitePrebuild = collectByName(unpackedRoot, 'win32-x64.node').find(isPrebuiltFallback)
  check(
    'better-sqlite3 运行时会加载的二进制已就位',
    Boolean(sqlitePrebuild) && isWindowsBinary(sqlitePrebuild),
    sqlitePrebuild
      ? path.relative(dir, sqlitePrebuild)
      : '未找到 prebuilds/win32-x64.node，且无 build/Release/better_sqlite3.node'
  )

  // The lazy-loaded binding. Its absence is invisible until the trend page is
  // opened, which is precisely why it is asserted here.
  const duckdbBinding = findFile(unpackedRoot, 'duckdb.node')
  check(
    'duckdb (惰性加载) 已解包',
    Boolean(duckdbBinding) && isWindowsBinary(duckdbBinding),
    duckdbBinding
      ? `${path.relative(dir, duckdbBinding)} · ${(fs.statSync(duckdbBinding).size / 1024 / 1024).toFixed(1)} MB`
      : '未找到 duckdb.node —— 历史趋势页会在客户现场失败'
  )

  /**
   * The bundled ffmpeg transcoder.
   *
   * WHY A FILE CHECK IS NOT ENOUGH HERE
   * An executable cannot be started from inside an asar archive, so if `asarUnpack`
   * were missing the binary would still be *findable* (Electron's asar shim answers
   * existsSync inside the archive) and could not be *run*. `spawn()` would fail with
   * ENOENT and the user would see a black rectangle. So this inspects the unpacked
   * artefact AND the probe below proves the packaged process actually executes it —
   * the same two-layer argument as better-sqlite3.
   */
  const ffmpegBinary = collectByName(unpackedRoot, 'ffmpeg.exe').find((file) =>
    /[\\/]@ffmpeg-installer[\\/]/.test(file)
  )
  check(
    'ffmpeg 已解包（可从 app.asar.unpacked 执行）',
    Boolean(ffmpegBinary) && isWindowsBinary(ffmpegBinary),
    ffmpegBinary
      ? `${path.relative(dir, ffmpegBinary)} · ${(fs.statSync(ffmpegBinary).size / 1024 / 1024).toFixed(1)} MB`
      : '未找到 app.asar.unpacked/.../@ffmpeg-installer/**/ffmpeg.exe —— 相机实时视频会失败'
  )

  // ---- Authenticode signatures -------------------------------------------
  // Both artefacts matter and they are signed SEPARATELY: the installer that the
  // customer downloads, and the executable that ends up on disk (Windows judges
  // the reputation of each independently). The NSIS installer is only present
  // after `dist:win`, so a `pack:dir` run reports the inner exe alone.
  checkSignature('应用主程序', exe)
  const installer = findCurrentInstaller(path.dirname(dir))
  const setupExe = installer.path
  if (setupExe) {
    // 名字写进报告：`release/` 里可能同时有多个版本，必须看得见验的是哪一个。
    console.log(
      `\n安装包  ${path.basename(setupExe)}` +
        (installer.exact
          ? `（与 release-stamp 的当前版本一致）\n`
          : `（**不是**当前版本 ${installer.wanted} —— 可能还没打包，或者文件名变了）\n`)
    )
    if (!installer.exact) {
      /*
       * ⚠ 这里是**一个真缺陷的修复点**（2026-09-24）：原来写的是
       * `problems.push(...)`，而 `problems` 只在 `checkSignature()` 里声明过 ——
       * 也就是说**这条分支一走到就 ReferenceError**，脚本以"验证脚本自身失败"退出，
       * 上面那些已经查出来的结果全部作废。
       *
       * 它一直没被发现，是因为要走到这里需要"`release/` 里的安装包不是当前版本" ——
       * 而出包与验证通常是同一轮连着做的。这一轮我换了一个输出目录（旧目录被别的进程
       * 占着），正好撞上：报告里其实已经说得清清楚楚，脚本却崩在最后一步。
       *
       * 修法：这类"该失败但只是提示"的发现一律进 `check()`，与其它判据同一条口径，
       * 于是它既进报告、也进退出码。
       */
      check(
        '安装包是当前版本',
        false,
        `期望 ${installer.wanted}，实际 ${path.basename(setupExe)}`
      )
    } else {
      check('安装包是当前版本', true, path.basename(setupExe))
    }
    checkSignature('安装包', setupExe)
  }

  if (!exe) {
    report()
    return
  }

  // ---- Boot the packaged app ---------------------------------------------
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hertzinno-packaged-'))
  const storageRoot = path.join(userDataDir, 'HertzinnoData')

  console.log('\n启动打包应用…\n')

  const child = spawn(exe, [`--user-data-dir=${userDataDir}`, '--disable-gpu', '--no-sandbox'], {
    cwd: dir,
    env: {
      ...process.env,
      // The probe is guarded by a runtime env check (main/index.ts
      // attachSmokeTestProbes), so the SHIPPED bundle supports it without being
      // built differently — no instrumented artifact is needed to test what
      // ships.
      HERTZINNO_SMOKE_TEST: '1',
      HERTZINNO_STORAGE_ROOT: storageRoot,
      ELECTRON_RENDERER_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })

  const finished = await new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearInterval(poll)
      try { child.kill() } catch { /* gone */ }
      resolve(true)
    }
    /**
     * Stop as soon as the last probe has spoken.
     *
     * The probes run in sequence (native modules → bridge → status push →
     * locales), so the locale report is the app's own "I am done" signal. Waiting
     * for the hard cap instead would make every verification run a minute long
     * for no added confidence.
     */
    const poll = setInterval(() => {
      if (output.includes('[smoke] locales ')) setTimeout(finish, 500)
      if (output.includes('[smoke] locales inconclusive')) finish()
    }, 400)
    // Hard cap: the packaged app unpacks and starts from disk on first run, and
    // the locale probe reloads the window once per language.
    setTimeout(finish, 60_000)
    child.on('exit', () => setTimeout(finish, 800))
  })
  void finished

  // ---- Native modules, as reported BY THE PACKAGED PROCESS ------------------
  // This is the decisive check. It runs inside the packaged app, so it proves
  // the bindings load from the packed/unpacked layout rather than merely that
  // some file exists. Anything the app reports here outranks the on-disk
  // artefact inspection above.
  const nativeMatch = /\[smoke\] native-modules (\{.*\})/.exec(output)
  let native = null
  if (nativeMatch) {
    try {
      native = JSON.parse(nativeMatch[1])
    } catch {
      native = null
    }
  }
  check(
    'better-sqlite3 在打包进程内可用',
    native?.sqlite === 'ok',
    native ? `ABI ${native.modules} · SQLite ${native.sqliteVersion}` : '未取得原生模块探针输出'
  )
  check(
    'DuckDB 在打包进程内可用（惰性加载，dev 检查覆盖不到）',
    native?.duckdb === 'ok' && native?.duckdbAnswer === 42,
    native ? `SELECT 42 → ${native.duckdbAnswer}` : '未取得原生模块探针输出'
  )
  check('确认运行的是打包构建', native?.packaged === true)

  /**
   * ffmpeg, as reported BY THE PACKAGED PROCESS.
   *
   * The decisive check for the live-view dependency: `services/media/ffmpeg.ts`
   * resolves the packaged location and runs `-version` inside the app, so this
   * asserts that the binary was unpacked AND is executable AND is the one the loader
   * actually found. On-disk inspection alone cannot distinguish "present" from
   * "present but still inside app.asar", which is the failure that produces a black
   * video rectangle with nothing in the log.
   */
  const ffmpegMatch = /\[smoke\] ffmpeg (\{.*\})/.exec(output)
  let ffmpeg = null
  if (ffmpegMatch) {
    try {
      ffmpeg = JSON.parse(ffmpegMatch[1])
    } catch {
      ffmpeg = null
    }
  }
  check(
    '打包进程内可运行内置 ffmpeg（-version 探针）',
    ffmpeg?.ok === true && Boolean(ffmpeg?.version),
    ffmpeg
      ? ffmpeg.ok
        ? `${ffmpeg.version} · ${ffmpeg.source} · ${path.relative(dir, ffmpeg.path)}`
        : `失败：${ffmpeg.error ?? '未知原因'}`
      : '未取得 ffmpeg 探针输出（[smoke] ffmpeg）'
  )
  // A path that names app.asar without the `.unpacked` suffix cannot be executed.
  check(
    'ffmpeg 来自 app.asar.unpacked（不是 asar 内部）',
    ffmpeg?.ok === true && /app\.asar\.unpacked/.test(String(ffmpeg.path)),
    ffmpeg?.ok === true ? String(ffmpeg.path) : '未取得探针输出'
  )

  check('渲染层加载完成', output.includes('[smoke] renderer-loaded'))

  const bridgeMatch = /\[smoke\] bridge (\{.*\})/.exec(output)
  let bridge = null
  if (bridgeMatch) {
    try {
      bridge = JSON.parse(bridgeMatch[1])
    } catch {
      bridge = null
    }
  }
  // The application account gate is part of the packaged smoke path now: the shell
  // only mounts once somebody is signed in, and the factory password must be
  // replaced on first use. Reporting the step reached turns "the shell did not
  // mount" into "the sign-in path broke" — very different bugs.
  const signIn = bridge?.signIn
  check(
    '打包后可用出厂账户登录并完成首次改密',
    signIn?.step === 'changed' || signIn?.step === 'already-signed-in',
    signIn ? `step=${signIn.step}${signIn.code ? ` code=${signIn.code}` : ''}` : '未取得登录探针输出'
  )

  check('preload 桥接 + Vue 挂载', Boolean(bridge?.api && bridge?.events && bridge?.mounted))

  // The account gate itself, in a packaged build: before signing in there must be
  // no shell, and therefore no device read. Asserted because a regression here
  // breaks nothing visibly.
  check(
    '登录前不挂载外壳（未登录不读取任何设备）',
    bridge?.mountedBeforeSignIn === false,
    bridge?.mountedBeforeSignIn === undefined ? '未取得测量值' : `mountedBeforeSignIn=${bridge.mountedBeforeSignIn}`
  )
  check('品牌 logo 渲染', bridge?.logoLoaded === true)
  check('应用内信息可用', Boolean(bridge?.release?.version), bridge?.release?.version ?? '')

  // The database proves the storage layer ran end to end. Its location cannot be
  // assumed: `--user-data-dir` is not the only input — Electron names the profile
  // after the app, and the storage root is resolved separately (and can differ in
  // a packaged build). So search for it rather than guess one path.
  const findDatabase = () => {
    const roots = [userDataDir, path.dirname(userDataDir), storageRoot]
    for (const root of roots) {
      const hit = collectByName(root, 'hertzinno-manager.db')[0]
      if (hit) return hit
    }
    return null
  }
  const dbFile = findDatabase()
  check(
    'better-sqlite3 在打包进程内加载成功（数据库已创建）',
    Boolean(dbFile),
    dbFile ? `${path.relative(dir, dbFile)} · ${fs.statSync(dbFile).size} 字节` : '未找到 hertzinno-manager.db'
  )

  // Log files prove the logging layout was created AND that the logger can write.
  const findLogs = () => {
    const found = []
    const walk = (dir, depth) => {
      if (depth > 6) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isFile() && /^(app|device|storage)-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) {
          found.push(path.join(dir, entry.name))
        } else if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), depth + 1)
        }
      }
    }
    for (const root of [userDataDir, storageRoot]) walk(root, 0)
    return found
  }
  const logs = findLogs()
  check('日志可写', logs.length > 0, logs.map((f) => path.basename(f)).join(', '))

  // The startup/IPC lines go to the console transport in development but the
  // packaged app routes them differently, so they are deliberately NOT asserted
  // here — `native-modules`, the bridge report and the database are the
  // meaningful evidence, and all three are independent of log routing.
  check('IPC 桥接可用（渲染层实际拿到 api/events）', Boolean(bridge?.api && bridge?.events))

  // ---- Four languages, rendered by the PACKAGED bundle ----------------------
  // The catalogue tests prove the four files are complete; only a running build
  // proves they were PACKAGED and that a component actually renders them. The
  // probe reloads once per language and reports the rendered DOM, so a stale
  // constant or a raw `app.*` key fails here rather than in front of a customer.
  const localesMatch = /\[smoke\] locales (\{.*\})/.exec(output)
  let locales = null
  if (localesMatch) {
    try {
      locales = JSON.parse(localesMatch[1])
    } catch {
      locales = null
    }
  }

  const LOCALE_CODES = ['zh-CN', 'zh-TW', 'en', 'es', 'tr', 'ru']
  if (!locales) {
    check('六种语言在打包构建里渲染', false, '未取得语言探针输出（[smoke] locales）')
  } else {
    const navs = LOCALE_CODES.map((code) => locales[code]?.nav)
    const problems = []
    if (navs.some((nav) => !nav)) problems.push('有语言没有渲染出导航文案: ' + JSON.stringify(navs))
    if (new Set(navs).size !== LOCALE_CODES.length) {
      problems.push('六种语言渲染出相同文案: ' + JSON.stringify(navs))
    }
    for (const code of LOCALE_CODES) {
      const state = locales[code] ?? {}
      if (state.htmlLang !== code) problems.push(`${code} 的 htmlLang 是 ${state.htmlLang}`)
      if (typeof state.nav === 'string' && state.nav.startsWith('app.')) {
        problems.push(`${code} 渲染了未翻译的键名: ${state.nav}`)
      }
      // The footer is where the product asked for the version and the copyright.
      // Asserting they are PRESENT matters as much as asserting they are
      // translated: a probe that only pattern-matches text passes silently on
      // `null`, which is exactly how a removed element weakens a test.
      if (!state.version) problems.push(`${code} 的页脚没有版本号`)
      else if (state.version.startsWith('app.')) {
        problems.push(`${code} 的页脚版本号渲染了未翻译的键名: ${state.version}`)
      }
      if (!state.footer) problems.push(`${code} 的页脚没有渲染`)
      else if (!/HERTZINNO/.test(state.footer)) problems.push(`${code} 的页脚没有公司名: ${state.footer}`)
      if (!state.copyright) problems.push(`${code} 的页脚没有版权行`)
      else if (state.copyright.startsWith('app.')) {
        problems.push(`${code} 的版权行渲染了未翻译的键名: ${state.copyright}`)
      }
      // The release date is locale DATA: the Simplified-Chinese form (年/月/日)
      // must not survive a switch to another language. Checked on the WHOLE footer,
      // because the date moved out of the version span when the sidebar footer was
      // replaced. zh-TW is exempt: `Intl` formats a Traditional-Chinese date as
      // `2026年9月21日` too — 年月日 IS the correct zh-TW rendering.
      if (
        code !== 'zh-CN' &&
        code !== 'zh-TW' &&
        typeof state.footer === 'string' &&
        /[\u5e74\u6708\u65e5]/.test(state.footer)
      ) {
        problems.push(`${code} 的页脚仍是中文日期: ${state.footer}`)
      }
    }
    check(
      '六种语言在打包构建里渲染',
      problems.length === 0,
      problems.length ? problems.join(' | ') : LOCALE_CODES.map((c) => `${c}=${locales[c]?.nav}`).join(' · ')
    )
  }

  const fatal = /Uncaught Exception|A JavaScript error occurred in the main process|Startup failed/i.test(output)
  check('无致命错误', !fatal)

  if (fatal || process.env.HERTZINNO_VERIFY_VERBOSE) {
    console.log(`\n--- 打包应用输出 ---\n${output.slice(-6000)}`)
  }

  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // Best effort; a leftover temp profile is not worth failing over.
  }

  report()
}

function report() {
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n结果  ${checks.length - failed.length} 通过 / ${failed.length} 失败`)
  if (failed.length > 0) {
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  ${f.detail}` : ''}`)
  }
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('验证脚本自身失败:', error)
  process.exit(1)
})
