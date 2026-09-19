#!/usr/bin/env node
/**
 * electron-builder configuration for the SIGNED Windows build.
 *
 * WHY THIS IS A SECOND CONFIG FILE AND NOT PART OF `electron-builder.yml`
 * `win.signtoolOptions.certificateSubjectName` is not a hint — when it is set and
 * no matching certificate exists in the Windows certificate store,
 * electron-builder THROWS and the build fails:
 *
 *   "Cannot find certificate <subject>, all certs: ..."
 *
 * (verified in app-builder-lib/out/codeSign/windowsSignToolManager.js: the store
 * lookup is only swallowed when a custom `sign` hook is also configured).
 *
 * The cloud signer is installed on the release machine, not on every development
 * machine, so putting the certificate identity in the shared config would mean
 * `npm run dist:win` could no longer build an unsigned installer anywhere else —
 * including on the machine that produced the current release. Hence:
 *
 *   electron-builder.yml           unsigned, builds anywhere
 *   electron-builder.signed.cjs    adds the certificate (this file)
 *
 * USAGE
 *   $env:HERTZINNO_CERT_SUBJECT = 'HERTZINNO'          # or HERTZINNO_CERT_SHA1
 *   npm run dist:win:signed
 *
 * `extends: file:...` is resolved by electron-builder against the project
 * directory and deep-merged with THIS object winning, so icon, NSIS options,
 * asarUnpack and the rest keep coming from the YAML (verified against
 * app-builder-lib/out/util/config/config.js getConfig + loadParentConfig).
 */

'use strict'

const readEnv = (name) => (process.env[name] || '').trim()

const subject = readEnv('HERTZINNO_CERT_SUBJECT')
/** Thumbprints are copied out of certmgr with spaces every second byte. */
const sha1 = readEnv('HERTZINNO_CERT_SHA1').replace(/[\s\u200e\u200f]/g, '').toUpperCase()
/**
 * Omitted unless explicitly provided, deliberately.
 *
 * `publisherName` must match the certificate CN exactly. Hard-coding a guess here
 * (the product name, say) would be worse than leaving it out: when it is absent,
 * electron-builder reads the CN off the certificate itself
 * (`lazyCertInfo` -> `certInfo.bloodyMicrosoftSubjectDn`), which cannot be wrong.
 * It only matters for `verifyUpdateCodeSignature`, and this app ships with
 * `publish: null` (no update server), so deriving it is the safe default.
 */
const publisher = readEnv('HERTZINNO_PUBLISHER')
const timestampServer = readEnv('HERTZINNO_TIMESTAMP_SERVER') || 'http://timestamp.digicert.com'

if (!subject && !sha1) {
  console.error(
    [
      '[sign] 未指定证书，拒绝构建。',
      '',
      '这是一个"签名构建"，静默地产出未签名安装包比构建失败更糟 —— 日志里照样会打印',
      'signing with signtool.exe，而产物是 NotSigned。请设置其中一个：',
      '',
      "  $env:HERTZINNO_CERT_SHA1    = 'A1B2...'    # 推荐：证书指纹（空格可保留）",
      "  $env:HERTZINNO_CERT_SUBJECT = 'Shanghai ...'  # 或证书「颁发给」，需完全一致",
      '',
      '只想出未签名包时请用 npm run dist:win。'
    ].join('\n')
  )
  process.exit(1)
}

/** @type {import('app-builder-lib').Configuration} */
module.exports = {
  extends: 'file:electron-builder.yml',
  win: {
    /** 与离线包同一个文件名（见 `release-stamp.cjs`）：签名与不签名只差签名，不差名字。 */
    artifactName: require('./release-stamp.cjs').artifactName,
    signtoolOptions: {
      // Selecting by subject/thumbprint keeps the private key wherever the CA put
      // it. Nothing is imported into a .pfx, which is the point of cloud signing.
      ...(subject ? { certificateSubjectName: subject } : {}),
      ...(sha1 ? { certificateSha1: sha1 } : {}),
      // Only present when explicitly requested; otherwise electron-builder reads
      // the CN from the certificate. See the note on `publisher` above.
      ...(publisher ? { publisherName: publisher } : {}),
      // Default is ['sha1', 'sha256']. The SHA-1 pass appends a second, deprecated
      // signature to every binary: no client needs it, and SHA-1 is being retired
      // by the CAs. One SHA-256 signature is what a modern Windows expects.
      signingHashAlgorithms: ['sha256'],
      // RFC 3161. This is what keeps an ALREADY DISTRIBUTED installer verifiable
      // after the certificate expires — without it, every copy in the field stops
      // verifying on the expiry date. Never build a release with
      // ELECTRON_BUILDER_OFFLINE=true: that silently skips timestamping.
      rfc3161TimeStampServer: timestampServer
    }
  }
}
