#!/usr/bin/env node
/**
 * electron-builder configuration for an OFFLINE Windows build.
 *
 * WHY THIS FILE EXISTS
 * `electron-builder` normally downloads the Electron binary zip (plus a checksum
 * request) from GitHub on every run, because the zip is not kept in
 * `%LOCALAPPDATA%\electron-builder\Cache` (the NSIS and winCodeSign resources are,
 * but Electron itself is not). On a machine that cannot reach GitHub this shows up
 * as:
 *
 *   • downloaded      label=electron progress=100%
 *   ⨯ Timeout awaiting 'request' for 600000ms  failedTask=build
 *
 * — i.e. the download COMPLETES and then a follow-up request hangs for ten minutes
 * before the build dies. Reproduced twice in a row on 2026-09-16.
 *
 * `electronDist` points electron-builder at an already-unpacked Electron
 * distribution instead of a zip to download. `node_modules/electron/dist` is
 * exactly that layout (it is what the `electron` npm package's own postinstall
 * fetched), so this also removes a version-drift risk: the packaged runtime is then
 * the SAME binary the probes and `electron-vite dev` use, rather than whatever the
 * zip happens to contain for the pinned range.
 *
 * USAGE
 *   npm run dist:win:offline
 *
 * This file adds nothing else. It deliberately does NOT set a certificate (see
 * `electron-builder.signed.cjs` for that, and read its header before combining the
 * two: a signed build must never be produced without a certificate).
 */

'use strict'

/**
 * 安装包文件名（业主 2026-09-19 第 11 批第 1 条：文件名后缀发布日期）。
 *
 * 日期与版本只在 `scripts/release-stamp.cjs` 里读一次 `package.json`；这里只是把它
 * 覆盖到 yml 的 `win.artifactName` 上（`extends` 是深合并，其余 win 选项照旧来自 yml）。
 * 为什么不让 yml 自己拼日期：yml 读不到 `package.json` 的 `releaseDate`，而用
 * `${env.*}` 会让不吃这份配置的 `dist:win` 变成"不设环境变量就构建失败"。
 */
const stamp = require('./release-stamp.cjs')

/** @type {import('app-builder-lib').Configuration} */
module.exports = {
  extends: 'file:electron-builder.yml',
  electronDist: 'node_modules/electron/dist',
  win: {
    artifactName: stamp.artifactName
  }
}
