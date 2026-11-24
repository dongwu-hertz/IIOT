/**
 * 安装包文件名：后缀发布日期 + 版本号随发布递增（业主 2026-09-19 第 11 批第 1 条）。
 *
 * WHY THIS FILE EXISTS
 * 业主的原话是「每个发布的软件 应该后缀发布日期，以及小版本号的变动」。这两件事都能
 * **安静地**漏掉：日期漏了，文件名看起来照旧正常；版本号没动，electron-builder 会把新包
 * 覆盖到旧包的那个路径上（同一个文件名 = 同一个文件），于是"这次发布"只剩一个时间戳变了。
 * 所以这里钉住三件必须同时成立的事：
 *
 *   1. **文件名里真的有日期**，而且那一串日期就是 `package.json` 的 `releaseDate`；
 *   2. **版本号真的动了**（比上一次发布大，且是三段 semver）；
 *   3. **两份发布配置（离线 / 签名）用的是同一个名字**，而且都与 stamp 一致 ——
 *      三处各写一遍的话，迟早出现"签名包叫 A、离线包叫 B"。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { parsePlainDate } from '../src/shared/release'

const projectRoot = path.resolve(__dirname, '..', '..')
const require_ = createRequire(__filename)

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

interface Stamp {
  productName: string
  version: string
  releaseDate: string
  artifactName: string
}

const pkg = JSON.parse(read('package.json')) as {
  name: string
  version: string
  releaseDate?: string
}
const stamp = require_(path.join(projectRoot, 'scripts', 'release-stamp.cjs')) as Stamp
const offlineConfig = require_(path.join(projectRoot, 'scripts', 'electron-builder.offline.cjs')) as {
  extends?: string
  win?: { artifactName?: string }
}
/**
 * 签名配置在**没有证书**时会 `process.exit(1)`（那是它故意的：静默产出一个未签名的包
 * 比构建失败更糟），所以读它之前先给一个**假指纹**。这里只读配置对象，
 * 不会真的去签名 —— 也没有签名工具会被调用。
 */
process.env.HERTZINNO_CERT_SHA1 = 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF'
const signedConfig = require_(path.join(projectRoot, 'scripts', 'electron-builder.signed.cjs')) as {
  extends?: string
  win?: { artifactName?: string }
}
delete process.env.HERTZINNO_CERT_SHA1

/** 上一次发布（第 19 轮）的那个版本号。它只在这里当"参照物"，不参与任何构建。 */
const PREVIOUS_VERSION = '1.0.49'

describe('安装包文件名：后缀发布日期（业主第 11 批第 1 条）', () => {
  it('文件名里有版本号与发布日期，而且两串都来自 `package.json`', () => {
    assert.equal(stamp.version, pkg.version, 'stamp 的版本号不是 package.json 里的那一个')
    assert.equal(stamp.releaseDate, pkg.releaseDate, 'stamp 的日期不是 package.json 里的那一个')
    assert.ok(
      stamp.artifactName.includes(`-${stamp.version}-`),
      `文件名里没有版本号：${stamp.artifactName}`
    )
    assert.ok(
      stamp.artifactName.includes(`-${stamp.releaseDate}-`),
      `文件名里没有发布日期：${stamp.artifactName}`
    )
    // 顺序：产品名 → 版本 → 日期 → 架构 → setup（同产品的多次发布因此按版本+日期聚在一起）。
    // 产品名已按业主 20260921 批改为 HAIS：安装包文件名**不含公司名**（公司名留在 copyright）。
    assert.match(
      stamp.artifactName,
      /^HAIS-\d+\.\d+\.\d+-\d{4}-\d{2}-\d{2}-\$\{arch\}-setup\.\$\{ext\}$/,
      `文件名的形状不对：${stamp.artifactName}`
    )
    // 只留 electron-builder 自己的两个宏（它们由 electron-builder 展开）。
    assert.deepEqual(
      stamp.artifactName.match(/\$\{[a-z]+\}/g),
      ['${arch}', '${ext}'],
      '文件名里出现了我们自己不认识的宏'
    )
  })

  it('日期是一个能被共享解析器认出来的"纯日期"（不是 `2026年9月19日`）', () => {
    assert.match(stamp.releaseDate, /^\d{4}-\d{2}-\d{2}$/, `日期形状不对：${stamp.releaseDate}`)
    const parsed = parsePlainDate(stamp.releaseDate)
    assert.ok(parsed, `共享层解析不出这个日期：${stamp.releaseDate}`)
    // 年月日必须原样保留（`new Date('2026-09-19')` 是 UTC 午夜，西半球会渲染成前一天）。
    assert.equal(
      `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`,
      stamp.releaseDate,
      '日期在本地时区里变了日子'
    )
  })

  it('版本号随发布递增（不是又发了一次旧版本）', () => {
    const parts = stamp.version.split('.').map((part) => Number(part))
    assert.equal(parts.length, 3, `版本号不是三段 semver：${stamp.version}`)
    assert.ok(parts.every((part) => Number.isInteger(part) && part >= 0), `版本号里有非数字：${stamp.version}`)

    const previous = PREVIOUS_VERSION.split('.').map((part) => Number(part))
    /** 三段比较：先比 major、再 minor、最后 patch（不引入 semver 依赖，就这三行）。 */
    const compare = (a: number[], b: number[]): number => {
      for (let index = 0; index < 3; index += 1) {
        if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
      }
      return 0
    }
    assert.ok(
      compare(parts, previous) > 0,
      `版本号没有往前走：上次发布 ${PREVIOUS_VERSION}，现在还是 ${stamp.version}` +
        '（同名的安装包会覆盖上一次的产物）'
    )
    // 允许补丁、次版本或主版本递增：本次产品明确要求从 1.0.49 升到 1.1.0。
    assert.notDeepEqual(parts, previous)
  })

  it('离线包与签名包用同一个名字（两处都取自 stamp）', () => {
    assert.equal(
      offlineConfig.win?.artifactName,
      stamp.artifactName,
      '离线构建没有用 stamp 的文件名（那就可能没带日期）'
    )
    assert.equal(
      signedConfig.win?.artifactName,
      stamp.artifactName,
      '签名构建的文件名与离线包不一致：同一个版本会产出两个不同的安装包'
    )
    // `extends` 仍然是 yml：其余 win 选项（图标、target、签名开关）不能被这次覆盖丢掉。
    assert.equal(offlineConfig.extends, 'file:electron-builder.yml')
    assert.equal(signedConfig.extends, 'file:electron-builder.yml')
  })

  it('产品名与 `electron-builder.yml` 里的 `productName` 是同一个字符串', () => {
    // 文件名与安装向导里的产品名不一致是最难发现的那种错：两个名字都对，只是不一样。
    // 业主 20260921 批把产品名改成 HAIS（copyright 仍保留 HERTZINNO），文件名跟着它走。
    const yml = read('electron-builder.yml')
    const declared = /^\s*productName:\s*(.+?)\s*$/m.exec(yml)?.[1]
    assert.equal(declared, 'HAIS', 'yml 里的 productName 变了')
    assert.equal(stamp.productName, declared, 'stamp 里的产品名与 yml 不一致')
    assert.ok(stamp.artifactName.startsWith(`${declared}-`), '文件名不是以产品名开头')
    assert.ok(!stamp.artifactName.includes('HERTZINNO'), '安装包文件名里又出现了公司名')
  })

  it('打包校验验的是**这一版**的安装包（`release/` 里会同时躺着好几个版本）', () => {
    /*
     * 这条守卫的来历：`scripts/verify-packaged.cjs` 原来取"第一个 `-setup.exe`"。
     * `readdirSync` 的顺序不保证，而按字母序 `…-1.0.0-…` 排在 `…-1.0.1-…` 前面 ——
     * 于是报告里那行"安装包 ✓"说的可能是**上一个版本**的包。第 11 批第 1 条之后
     * （文件名带上了版本与日期）这件事从"理论问题"变成了"每发一版都会发生"。
     */
    const verifier = read('scripts/verify-packaged.cjs')
    assert.match(verifier, /function findCurrentInstaller\(root\)/, '没有按当前版本找安装包')
    assert.match(
      verifier,
      /stamp\.artifactName\.replace\('\$\{arch\}', 'x64'\)\.replace\('\$\{ext\}', 'exe'\)/,
      '没有拿 release-stamp 的名字去比对'
    )
    assert.match(verifier, /findCurrentInstaller\(path\.dirname\(dir\)\)/, '调用点没换成当前版本那一个')
    // 报告的标题里必须看得见验的是哪一个文件（否则"✓"指的是哪一版又变成了猜）。
    assert.match(verifier, /安装包  \$\{path\.basename\(setupExe\)\}/, '报告里没有写出安装包文件名')
  })

  it('安装器语言顺序：英文 → 简体中文 → 繁体中文', () => {
    const yml = read('electron-builder.yml')
    const lines = yml.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === 'installerLanguages:')
    assert.ok(start >= 0, 'installerLanguages 不见了')
    const langs: string[] = []
    for (let index = start + 1; index < lines.length; index += 1) {
      const matched = /^\s+-\s+(.+)$/.exec(lines[index] ?? '')
      if (!matched) break
      langs.push(matched[1]!.trim())
    }
    assert.deepEqual(langs.slice(0, 3), ['en_US', 'zh_CN', 'zh_TW'])
    assert.ok(langs.includes('zh_TW'), '安装向导里没有繁体中文')
  })

  it('底层的 yml 仍然有一个不带日期的兜底名字（`dist:win` 不吃独立配置）', () => {
    const yml = read('electron-builder.yml')
    assert.match(
      yml,
      /^ {2}artifactName: \$\{productName\}-\$\{version\}-\$\{arch\}-setup\.\$\{ext\}$/m,
      'yml 里的兜底 artifactName 被删掉了 —— `npm run dist:win` 会退回 electron-builder 的默认名'
    )
  })
})
