#!/usr/bin/env node
/**
 * 安装包文件名的**唯一来源**（业主 2026-09-19 第 11 批第 1 条）。
 *
 * WHY THIS FILE EXISTS
 * 业主的原话是「每个发布的软件 应该后缀发布日期，以及小版本号的变动」。这句话拆成两半，
 * 两个都不能靠人记：
 *
 *   1. **文件名带发布日期**。日期写死进 `electron-builder.yml` 就意味着"改了 package.json
 *      的 releaseDate、忘了改 yml"，而那种错误在产物上看起来完全正常 —— 只有一个写着旧日期
 *      的文件名。所以日期从 `package.json` 读，只有一处声明。
 *   2. **小版本号每次都动**。`version` 同样只在 `package.json` 里，本文件把它读出来拼进名字，
 *      于是"发了包但版本号没动"会直接表现为**文件名与上一个包重名**（electron-builder 会覆盖
 *      同一个文件，而覆盖是安静的）。
 *
 * WHY THE YAML CANNOT DO THIS ITSELF
 * `electron-builder.yml` 支持 `${env.RELEASE_DATE}` 这类宏（`app-builder-lib/out/util/
 * macroExpander.js`：未知的 env 会**抛错**而不是留空），但 yml 读不到 `package.json` 里的
 * 自定义字段 `releaseDate`。让 YAML 用 `${env.*}` 就必须在每个入口先设环境变量，
 * 而 `dist:win`（直接吃 yml）就会变成"不设变量就构建失败"。所以发布用的两份配置
 * （offline / signed）**继承 yml、只覆盖 `win.artifactName`**，覆盖值来自本文件：
 * 一份声明，两处使用，`npm run dist:win` 那条不发布的老路不受影响。
 *
 * 传出去的 `artifactName` 里保留 `${arch}` / `${ext}` 两个 electron-builder 宏
 * （它们由 electron-builder 在写文件时展开）；本文件只负责版本与日期那一段。
 *
 * 断言在 `tests/installer-name.test.ts`。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** @type {{productName?: string, name: string, version: string, releaseDate?: string}} */
const pkg = require(path.join(__dirname, '..', 'package.json'))

/**
 * 产品名从 **`electron-builder.yml`** 里读，而不是从 `package.json`。
 *
 * 理由：安装包的文件名与安装程序里显示的 `productName` 必须是同一个字符串，而
 * electron-builder 真正用的是 yml 里那一行（这个仓库的 `package.json` 里**没有**
 * `productName`）。在 stamp 里另写一遍就是"两处声明"，改了 yml、忘了这里，
 * 产物会变成一个名字写着 A、安装向导写着 B 的包。
 * 读不到时回落到 `package.json` 的 `name`（而不是抛错：那条路只在配置文件被改坏时走到，
 * 而"构建直接失败"与"文件名差一点"相比，前者更该发生 —— 所以 `tests/installer-name.test.ts`
 * 里钉了 yml 必须仍然有那一行）。
 */
function productNameFromBuilderConfig() {
  try {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    const matched = /^\s*productName:\s*(.+?)\s*$/m.exec(yml)
    if (matched && matched[1]) return matched[1].replace(/^['"]|['"]$/g, '')
  } catch {
    // 见上：回落到 package.json 的 name。
  }
  return String(pkg.productName || pkg.name).trim()
}

const VERSION = String(pkg.version || '').trim()
const RELEASE_DATE = String(pkg.releaseDate || '').trim()
const PRODUCT_NAME = productNameFromBuilderConfig()

/**
 * 形如 `HAIS-1.0.1-2026-09-19-${arch}-setup.${ext}`。
 *
 * 顺序是 产品名 → 版本 → 发布日期 → 架构 → setup：安装包在资源管理器里按名字排序时，
 * 同一个产品的多次发布就会**按版本与日期聚在一起**（这也是"后缀发布日期"这句话的用处）。
 * 日期用 `YYYY-MM-DD`：它在任何语言的排序里都单调，而 `2026年9月19日` 不是。
 */
const ARTIFACT_NAME = [PRODUCT_NAME, VERSION, RELEASE_DATE, '${arch}', 'setup.${ext}'].join('-')

module.exports = {
  productName: PRODUCT_NAME,
  version: VERSION,
  releaseDate: RELEASE_DATE,
  artifactName: ARTIFACT_NAME
}
