#!/usr/bin/env node
/**
 * Preflight for the SIGNED build: is the cloud signing certificate actually here?
 *
 * WHY THIS EXISTS
 * The certificate for a cloud service (SimplySign Desktop and friends) lives on a
 * VIRTUAL CARD that only exists in the Windows certificate store while the desktop
 * client is installed AND logged in. When the session is gone, the certificate is
 * simply not there — and electron-builder only finds that out AFTER it has packed
 * the app, i.e. two minutes into the release build, with the message:
 *
 *   Cannot find certificate <subject>, all certs: ...
 *
 * This runs the same lookup electron-builder performs
 * (`Get-ChildItem -Recurse Cert: -CodeSigningCert`, see
 * app-builder-lib/out/codeSign/windowsSignToolManager.js) BEFORE the build starts,
 * and it also checks `HasPrivateKey`: a certificate can be present in the store
 * while its private key is unreachable, which produces a different and even more
 * confusing failure inside signtool.
 *
 * USAGE
 *   node scripts/sign-preflight.cjs          # reads the same env vars as the config
 *   npm run dist:win:signed                  # runs this first
 */

'use strict'

const { execFileSync } = require('node:child_process')

const readEnv = (name) => (process.env[name] || '').trim()

const subject = readEnv('HERTZINNO_CERT_SUBJECT')
const sha1 = readEnv('HERTZINNO_CERT_SHA1').replace(/[\s\u200e\u200f]/g, '').toUpperCase()

if (!subject && !sha1) {
  console.error(
    [
      '[sign:preflight] 未指定证书。',
      '',
      "  $env:HERTZINNO_CERT_SUBJECT = 'HERTZINNO'   # 证书「颁发给」，或",
      "  $env:HERTZINNO_CERT_SHA1    = 'A1B2...'    # 证书指纹（空格可保留）",
      '',
      '未签名包请用 npm run dist:win。'
    ].join('\n')
  )
  process.exit(1)
}

if (process.platform !== 'win32') {
  console.error('[sign:preflight] 只能在本机证书存储中查找证书：签名必须在一台 Windows 出包机上完成。')
  process.exit(1)
}

/**
 * Enumerate code-signing certificates exactly the way electron-builder does.
 *
 * `-Recurse Cert:` covers both CurrentUser and LocalMachine, which matters because
 * a virtual-card client may install into either one.
 */
const script = [
  // PowerShell 5.1 writes redirected stdout in the console codepage (GBK on a
  // Chinese Windows), which garbles a Chinese certificate subject on the way into
  // Node — and the subject is what gets MATCHED, so the check would fail for a
  // perfectly valid certificate. Force UTF-8 on the way out.
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  "$ErrorActionPreference='Stop'",
  // One pipeline, so it must stay a single statement — a `;` after a trailing `|`
  // is an "empty pipe element" parse error. The date is formatted HERE because
  // ConvertTo-Json emits a DateTime as `/Date(1819...)`, not as text.
  "Get-ChildItem -Recurse Cert: -CodeSigningCert | Select-Object Subject, Thumbprint, @{n='NotAfter';e={$_.NotAfter.ToString('yyyy-MM-dd')}}, HasPrivateKey, PSParentPath | ConvertTo-Json -Compress"
].join('; ')

let raw = ''
try {
  raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })
} catch (error) {
  console.error(`[sign:preflight] 无法读取证书存储：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

let certificates = []
try {
  const parsed = raw.trim() === '' ? [] : JSON.parse(raw)
  certificates = Array.isArray(parsed) ? parsed : [parsed]
} catch {
  certificates = []
}

const matches = certificates.filter((cert) => {
  const thumbprint = String(cert.Thumbprint || '').toUpperCase()
  const certSubject = String(cert.Subject || '')
  if (sha1 && thumbprint !== sha1) return false
  if (subject && !certSubject.includes(subject)) return false
  return true
})

/**
 * Pull the CN out of a subject DN.
 *
 * Cloud certificates often arrive with the CN QUOTED —
 * `CN="Shanghai Hertzinno Technology Co., Ltd.", O="..."` — so a naive
 * `replace(/^CN=/, '')` leaves the quotes and the rest of the DN behind.
 */
function commonName(subject) {
  const match = /CN=("([^"]*)"|[^,]*)/.exec(String(subject || ''))
  return (match?.[2] ?? match?.[1] ?? '').trim()
}

const describe = (cert) =>
  [
    commonName(cert.Subject),
    `指纹 ${cert.Thumbprint}`,
    `到期 ${String(cert.NotAfter || '').slice(0, 10)}`,
    cert.HasPrivateKey ? '含私钥' : '不含私钥',
    String(cert.PSParentPath || '').split('::').pop()
  ]
    .filter(Boolean)
    .join(' · ')

if (certificates.length === 0) {
  console.error(
    [
      '[sign:preflight] 本机证书存储里没有任何代码签名证书。',
      '',
      'SimplySign 这类云签名需要先满足：',
      '  1. 已安装 SimplySign Desktop 客户端',
      '  2. 客户端已用「邮箱 + 手机 APP 上显示的 token」登录（登录后最小化到托盘）',
      '  3. 托盘图标右键 → Manage certificates → Certificate list 里能看到证书',
      '',
      '未登录时证书不会出现在存储里，因此 signtool 一定会报',
      '"No certificates were found that met all the given criteria"。'
    ].join('\n')
  )
  process.exit(1)
}

if (matches.length === 0) {
  console.error(
    [
      `[sign:preflight] 找到了 ${certificates.length} 张代码签名证书，但没有一张匹配：`,
      subject ? `  HERTZINNO_CERT_SUBJECT = ${subject}` : `  HERTZINNO_CERT_SHA1 = ${sha1}`,
      '',
      '本机现有的：',
      ...certificates.map((cert) => `  - ${describe(cert)}`),
      '',
      '提示：主体名必须与证书「颁发给」完全一致（含空格与后缀）；也可以改用指纹。'
    ].join('\n')
  )
  process.exit(1)
}

const withoutKey = matches.filter((cert) => !cert.HasPrivateKey)
if (withoutKey.length === matches.length) {
  console.error(
    [
      '[sign:preflight] 证书存在，但取不到私钥。',
      ...withoutKey.map((cert) => `  - ${describe(cert)}`),
      '',
      '云签名（SimplySign）的私钥在 CA 的 HSM 中，需要客户端处于登录状态才会暴露给 CryptoAPI。',
      '请确认 SimplySign Desktop 已登录，然后重试。'
    ].join('\n')
  )
  process.exit(1)
}

/**
 * Ambiguity is an ERROR, not a warning.
 *
 * electron-builder takes the FIRST certificate whose subject contains the given
 * name. When an organization has renewed its certificate, both the old and the new
 * one sit in the store with the same CN — and the old one may expire next month.
 * Worse, SmartScreen reputation accrues to the CERTIFICATE IDENTITY, so silently
 * alternating between two certificates fragments it. Pinning the thumbprint costs
 * one environment variable, so the build stops here instead.
 */
if (matches.length > 1) {
  console.error(
    [
      `[sign:preflight] 匹配到 ${matches.length} 张证书，无法确定用哪一张：`,
      ...matches.map((cert) => `  - ${describe(cert)}`),
      '',
      'electron-builder 会静默取第一张（可能是即将过期的那张），而 SmartScreen 声誉是按',
      '证书身份累积的 —— 在两张证书之间来回签会把它摊薄。请改用指纹明确指定：',
      '',
      `  $env:HERTZINNO_CERT_SHA1 = '${matches[0].Thumbprint}'`
    ].join('\n')
  )
  process.exit(1)
}

console.log('[sign:preflight] 证书已就绪：')
for (const cert of matches) console.log(`  ✓ ${describe(cert)}`)
