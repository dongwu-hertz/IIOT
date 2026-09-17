#!/usr/bin/env node
/**
 * 探针：登录页的「记住上次的用户名 / 记住密码 / 每三个月重新输入」（业主 2026-09-16）。
 *
 * 为什么值得一个单独的探针：这条链路横跨渲染层表单 → IPC → `safeStorage` 加密 →
 * `app_meta` 落盘 → 重新加载时的解密与预填。任何一处断了，源码看起来都"有实现"，而
 * 单测只能覆盖其中**纯策略**那一段（90 天规则，见 `tests/remembered-login.test.ts`）。
 *
 * USAGE
 *   node scripts/remember-login-proof.cjs
 *   node scripts/remember-login-proof.cjs --keep-open
 *
 * 一次性 profile：不碰操作员真实数据（与 `scripts/demo-shot.cjs` 同一条纪律）。
 */

'use strict'

const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const electronBinary = require('electron')
const projectRoot = path.resolve(__dirname, '..')

const keepOpen = process.argv.includes('--keep-open')

const mainEntry = path.join(projectRoot, 'out', 'main', 'index.js')
if (!fs.existsSync(mainEntry)) {
  console.error(
    `Built entry not found: ${mainEntry}\n` +
      'Run: node ./node_modules/electron-vite/bin/electron-vite.js build'
  )
  process.exit(1)
}

const driver = path.join(__dirname, 'remember-login-driver.cjs')
try {
  execFileSync(process.execPath, ['--check', driver], { stdio: 'pipe' })
} catch (error) {
  console.error(
    `[remember] driver failed to parse: ${error.stderr ? error.stderr.toString() : error.message}`
  )
  process.exit(1)
}

const out = path.join(projectRoot, '.remember-proof')
fs.mkdirSync(out, { recursive: true })
const wrapper = path.join(out, '_wrapper.cjs')
fs.writeFileSync(
  wrapper,
  "'use strict'\n" +
    '// Attach the driver BEFORE the real app entry runs.\n' +
    `require(${JSON.stringify(driver)})\n` +
    `require(${JSON.stringify(mainEntry)})\n`
)

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-remember-'))
console.log(`[remember] electron : ${electronBinary}`)
console.log(`[remember] userData : ${userDataDir}`)

const child = spawn(electronBinary, [wrapper, `--user-data-dir=${userDataDir}`], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    HZ_REMEMBER_PROOF: JSON.stringify({ keepOpen })
  }
})

child.on('exit', (code) => {
  console.log(`[remember] electron exited with ${code}`)
  process.exit(code ?? 1)
})
