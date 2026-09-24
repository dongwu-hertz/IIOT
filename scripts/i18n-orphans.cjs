#!/usr/bin/env node
/**
 * i18n 词条**双向**审计：孤儿键（目录里有、源码里没人用）与缺失键（源码里引用了、目录里没有）。
 *
 * 为什么需要它
 *   本项目的界面改过多轮，每轮都删掉一些控件，于是词条会变成孤儿；上一轮我是**手工**找出
 *   `overview` 整个块（12 个键 × 4 语言）没人引用才删掉的 —— 手工做一次可以，做成规矩不行。
 *   反方向更危险：**引用还在、键被删了**，界面会直接渲染出裸 key（`overview.recentAlarms`），
 *   那是产品事故而不是整洁问题。已有的 `i18n-progress.cjs` 只管「源码里有没有写死的中文」，
 *   这两个方向它都不管，所以这是另一件事，不是它的替代品。
 *
 * 两个方向必须用**两个不同的集合**（这是本脚本最容易做错的地方，两次都栽在这里）
 *   1. **「缺失键」要精确** ⇒ 只认**调用点**：`t('a.b')` / `te` / `tm` / `xxx.t(...)` 的第一个字面量实参，
 *      以及名字以 `Key` 结尾的属性（`labelKey` / `disabledReasonKey` / `reasonKey` …）。
 *      只有这样才能把文件路径之类的噪声（`'app.asar.unpacked'`）和注释里的字样挡在外面。
 *   2. **「孤儿键」必须宽松** ⇒ 只要源码里出现过一个**与词条完全同名的字面量**就算被引用，
 *      因为键常常是经变量/映射表/数组传进 `t()` 的（`channelStateLabelKey(state)`、
 *      `const KEYS = ['a.b', 'c.d']`），从调用点根本追不到。
 *      这里的误报方向是**漏报孤儿**——那只是少清理几个键；反过来（把还在用的键报成孤儿）会
 *      让人删掉界面正在用的词条，直接渲染出裸 key。**宁可漏报，不可误杀。**
 *
 * 第一版错在哪（留在这里，免得以后有人改回去）
 *   把「所有点号字符串字面量」当引用，且用的正则是 `"([^"]*)"`：Vue 模板里键被外层双引号包住
 *   （`:aria-label="t('cameraWallUi.layoutLabel')"`），这个字符类会**跨过里面的单引号**，
 *   把整段属性值当成一个字面量，于是那个键根本没被看见——一个明明在用的键被报成孤儿。
 *   现在两种引号的字符类互相排斥（`[^'"]`），并且 `.ts` 走 AST，注释天然不算引用。
 *
 * 用法
 *   node scripts/i18n-orphans.cjs            人读的报告；缺失键非空时 exit 1
 *   node scripts/i18n-orphans.cjs --json     机器可读
 *
 * 已知边界（报告末尾也会印）
 *   - 孤儿判定**以 `src/` 为准**；`tests/` 会**单独**扫一遍，只用来把孤儿分成
 *     「任何地方都没人用（可直接删）」与「只有测试还在断言（删键要连测试一起改）」——
 *     混在一张表里，收尾轮一定会删出失败测试。
 *   - 模板字面量无法静态求值，取其前缀列为「动态前缀」，该前缀下的键一律视为可能被引用。
 *   - `.vue` 里的注释没有做语法级排除（`.ts` 有），误差方向同样是「漏报孤儿」，安全。
 */

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const MESSAGES_DIR = path.join(ROOT, 'src', 'shared', 'i18n', 'messages')
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'es', 'tr', 'ru']
const SCAN_ROOT = path.join(ROOT, 'src')
/**
 * 测试目录：**单独**扫一遍。
 *
 * 孤儿键里有一部分只是**测试**还在断言它存在（`assert.ok(keys.has('a.b'))` 这类）。
 * 删这种键必须连测试一起改，否则会留下一个失败测试；而「任何地方都没人用」的键可以直接删。
 * 两者混在一张表里，收尾轮一定会踩坑，所以分开报。
 */
const TEST_ROOT = path.join(ROOT, 'tests')
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', '.test-build', 'release'])

const KEY_LIKE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
const TRANSLATE_CALLEES = new Set(['t', 'te', 'tm', 'tc'])
/** 模板字面量里的 `prefix.${` 形状（全局，供 matchAll 用）。 */
const DYNAMIC_HEAD = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\.\$\{/g
/**
 * `prefix_${` 形状（下划线直接连着插值）。
 *
 * 这是 2026-09-17 补的**真缺陷**：上面那条要求 `${` 前面是一个点，所以
 * `` t(`samplesUi.dimension_${dimension}`) `` 一个前缀都收不到，于是
 * `samplesUi.dimension_equipment` 被报成"任何地方都没人用（可直接删）"。
 * 当年 `labelSource_*` 没被误报只是因为那时它同时在模板里以字面量出现过 —— 纯属侥幸。
 * 前缀里已经带着分隔符，所以匹配时用"直接 startsWith"而不是再加一个点（见 `isDynamic`）。
 */
const DYNAMIC_HEAD_UNDERSCORE = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*_)\$\{/g
/** `domainLabel('domain.eventSeverity', key)`：前缀由调用点以字面量传入，AST 里看不出来。 */
const DYNAMIC_LABEL_ARG = /\bdomainLabel\(\s*'([A-Za-z][A-Za-z0-9_.]*)'/g

// ---------------------------------------------------------------------------
// 目录：把一份 TS 目录拍平成点号路径
// ---------------------------------------------------------------------------

function flattenCatalogue(file) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const keys = new Set()

  const walk = (node, prefix) => {
    if (!ts.isObjectLiteralExpression(node)) return
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = property.name
      const key = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : undefined
      if (key === undefined) continue
      const full = prefix === '' ? key : `${prefix}.${key}`
      if (ts.isObjectLiteralExpression(property.initializer)) walk(property.initializer, full)
      else keys.add(full)
    }
  }

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer) walk(declaration.initializer, '')
    }
  }
  return keys
}

// ---------------------------------------------------------------------------
// 源码：两个集合分别收集
// ---------------------------------------------------------------------------

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|vue)$/.test(entry.name)) continue
    if (entry.name.endsWith('.d.ts')) continue
    out.push(full)
  }
  return out
}

function literalOf(node) {
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

/**
 * 动态拼键的前缀：**按原文扫**，不按 AST。
 *
 * 两个理由，都是踩过的坑：
 *   1. `TemplateHead.text` **不含** `${`（它只到 `${` 之前，即 `alarms.type.`），
 *      所以 AST 侧拿不到 `prefix.${` 这个形状——曾经因此在 `.ts` 里一个前缀都收不到，
 *      把 `alarms.type.*`、`streamState.*`、`errors.*` 整批活键误判成死孤儿；
 *   2. `.vue` 模板里会出现嵌套模板（`` `${t(`domain.permissionScope.${key}`)}…` ``），
 *      按反引号成对切分会切错。
 *
 * 代价：注释里写了 `prefix.${…}` 也会被当成动态前缀。方向是安全的（宁可少报孤儿）。
 */
function noteDynamic(text, dynamicPrefixes) {
  for (const match of text.matchAll(DYNAMIC_HEAD)) dynamicPrefixes.add(match[1])
  for (const match of text.matchAll(DYNAMIC_HEAD_UNDERSCORE)) {
    /**
     * 只收**带命名空间**的（`samplesUi.dimension_`）。
     *
     * 不带点的下划线前缀满地都是（`AUDIO_FORMAT_${x}`、`PCM_${x}`、`unknown_${x}`），
     * 把它们当成"可能被引用的前缀"会把真实孤儿盖住 —— 一个只做减法、从不误报的审计脚本
     * 才是能用的审计脚本。
     */
    if (match[1].includes('.')) dynamicPrefixes.add(match[1])
  }
  for (const match of text.matchAll(DYNAMIC_LABEL_ARG)) dynamicPrefixes.add(match[1])
}

/** `.ts`：一次 AST 遍历同时收集「所有字面量」与「调用点键」；注释天然不算。 */
function scanTypeScript(text, fileName, sink) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)

  const calleeName = (expression) => {
    if (ts.isIdentifier(expression)) return expression.text
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text
    return undefined
  }

  const visit = (node) => {
    const literal = literalOf(node)
    if (literal !== undefined && KEY_LIKE.test(literal)) {
      sink.allLiterals.add(literal) // 宽松：孤儿判定用
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        // 调用点判定在下面按父节点做，这里只登记字面量本身
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name !== undefined && TRANSLATE_CALLEES.has(name) && node.arguments.length > 0) {
        const key = literalOf(node.arguments[0])
        if (key !== undefined && KEY_LIKE.test(key)) sink.callSite.add(key)
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && /Key$/.test(node.name.text)) {
      const key = literalOf(node.initializer)
      if (key !== undefined && KEY_LIKE.test(key)) sink.callSite.add(key)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/** `.vue`：两种引号的字符类互相排斥，这样模板属性里的键不会被外层引号吞掉。 */
function scanVue(text, sink) {
  // 先去 HTML 注释，减少噪声（JS 注释无法在不解析的前提下安全去掉，见文件头的边界说明）。
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of cleaned.matchAll(/'([^'"\n]*)'|"([^'"\n]*)"/g)) {
    const value = match[1] ?? match[2] ?? ''
    if (KEY_LIKE.test(value)) sink.allLiterals.add(value)
  }
  for (const match of cleaned.matchAll(/\b(t|te|tm|tc)\(\s*(['"])([^'"]+)\2/g)) {
    if (KEY_LIKE.test(match[3])) sink.callSite.add(match[3])
  }
  for (const match of cleaned.matchAll(/\b[A-Za-z]*Key\s*[:=]\s*(['"])([^'"]+)\1/g)) {
    if (KEY_LIKE.test(match[2])) sink.callSite.add(match[2])
  }
  /**
   * **前缀由 prop 传进子组件**的写法：`label-key-prefix="realtimeUi.pdClass"`。
   *
   * 这是 2026-09-20 补的**真误报**：`RealtimeProbabilityBars` 用
   * ``t(`${props.labelKeyPrefix}.${entry.key}`)`` 拼键，而模板字面量那条正则
   * （`DYNAMIC_HEAD`）看到的前缀是 `props.labelKeyPrefix` —— 一个**变量名**，
   * 不是词条前缀。于是 `realtimeUi.pdClass.creepage/suspended/noise` 三条
   * **正在界面上渲染的活键**被报成"任何地方都没人用（可直接删）"。
   * 这一段的误报方向是**要删活键**，是本脚本唯一危险的方向，所以按原文扫一遍
   * 属性的字面量值、注册成动态前缀（与 `domainLabel('a.b', key)` 同一类处理）。
   */
  for (const match of cleaned.matchAll(/\b[A-Za-z-]*[Pp]refix\s*=\s*"([^"]+)"/g)) {
    const value = match[1].trim()
    if (KEY_LIKE.test(value)) sink.dynamicPrefixes.add(value)
  }
}

function scanTree(root) {
  const files = collectSourceFiles(root)
  const sink = { callSite: new Set(), allLiterals: new Set(), dynamicPrefixes: new Set() }
  let scanned = 0

  for (const file of files) {
    if (file.startsWith(MESSAGES_DIR)) continue // 目录文件自己不算「被引用」
    const text = fs.readFileSync(file, 'utf8')
    scanned += 1
    if (file.endsWith('.vue')) scanVue(text, sink)
    else scanTypeScript(text, file, sink)
    // 动态前缀两种文件都按原文扫（见 noteDynamic 的说明）。
    noteDynamic(text, sink.dynamicPrefixes)
  }
  return { scanned, ...sink }
}

// ---------------------------------------------------------------------------

function main() {
  const asJson = process.argv.includes('--json')

  const catalogues = {}
  for (const locale of LOCALES) {
    catalogues[locale] = flattenCatalogue(path.join(MESSAGES_DIR, `${locale}.ts`))
  }

  const reference = catalogues[LOCALES[0]]
  const namespaces = new Set([...reference].map((key) => key.split('.')[0]))
  /** 顶层命名空间本身会被当参数传（`domainLabel('domain.eventSeverity', …)`），它不是词条。 */
  const isPrefixOfSomeKey = (value) => {
    for (const key of reference) if (key.startsWith(`${value}.`)) return true
    return false
  }

  const src = scanTree(SCAN_ROOT)
  const { scanned, callSite, allLiterals, dynamicPrefixes } = src
  // 测试目录单独扫：用于把孤儿键分成「可直接删」与「删键要连测试一起改」。
  const tests = scanTree(TEST_ROOT)
  const referencedByTests = (key) => tests.callSite.has(key) || tests.allLiterals.has(key)
  const inPlay = (key) => {
    for (const prefix of dynamicPrefixes) {
      /**
       * 前缀自带分隔符时（`samplesUi.dimension_`，来自 `_${` 那条正则）**直接** startsWith：
       * 再加一个点就永远匹配不上，于是那些键又会被误报成死孤儿。
       */
      if (prefix.endsWith('_') ? key.startsWith(prefix) : key.startsWith(`${prefix}.`)) return true
    }
    return false
  }

  // 缺失键：**只用调用点**（精确）
  const unknownKeys = [...callSite]
    .filter((key) => namespaces.has(key.split('.')[0]))
    .filter((key) => !reference.has(key) && !isPrefixOfSomeKey(key))
    .sort()

  // 孤儿键：**用全部字面量**（宽松）——宁可漏报，不可误杀
  const referencedSomewhere = (key) => callSite.has(key) || allLiterals.has(key) || inPlay(key)
  const orphans = [...reference].filter((key) => !referencedSomewhere(key)).sort()
  /** 任何地方都没人用 ⇒ 可以直接删。 */
  const deadOrphans = orphans.filter((key) => !referencedByTests(key))
  /** 只有测试还在引用 ⇒ 删键必须同时改那条断言，否则留下失败测试。 */
  const testOnlyOrphans = orphans.filter((key) => referencedByTests(key))

  const orphansByLocale = {}
  for (const locale of LOCALES) {
    orphansByLocale[locale] = [...catalogues[locale]].filter((key) => !referencedSomewhere(key)).sort()
  }

  const parityIssues = {}
  for (const locale of LOCALES) {
    if (locale === LOCALES[0]) continue
    const missing = [...reference].filter((key) => !catalogues[locale].has(key)).sort()
    const extra = [...catalogues[locale]].filter((key) => !reference.has(key)).sort()
    if (missing.length > 0 || extra.length > 0) parityIssues[locale] = { missing, extra }
  }

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ scannedFiles: scanned, testsScanned: tests.scanned, keys: reference.size, unknownKeys, orphans, deadOrphans, testOnlyOrphans, orphansByLocale, dynamicPrefixes: [...dynamicPrefixes].sort(), parityIssues }, null, 2)}\n`
    )
    process.exit(unknownKeys.length > 0 ? 1 : 0)
  }

  console.log(`扫描 ${scanned} 个源文件；zh-CN 词条 ${reference.size} 个。`)
  console.log(`引用证据：调用点 ${callSite.size} 个 · 任意位置字面量 ${allLiterals.size} 个（孤儿判定用后者，见文件头）。`)

  if (unknownKeys.length > 0) {
    console.log(`\n[缺失键] 调用点引用了但 zh-CN 里没有 —— 界面会渲染成裸 key，${unknownKeys.length} 个：`)
    for (const key of unknownKeys) console.log(`  ${key}`)
  } else {
    console.log('\n[缺失键] 0 个。')
  }

  console.log(`\n[孤儿键] zh-CN 里 ${orphans.length} 个在 src/ 中找不到任何引用：`)
  console.log(`  · 任何地方都没人用（可直接删）：${deadOrphans.length}`)
  console.log(`  · 只有 tests/ 还在引用（删键要连测试一起改）：${testOnlyOrphans.length}`)

  const printGroup = (title, keys) => {
    if (keys.length === 0) return
    console.log(`\n  ── ${title} ──`)
    const byNamespace = new Map()
    for (const key of keys) {
      const top = key.split('.')[0]
      if (!byNamespace.has(top)) byNamespace.set(top, [])
      byNamespace.get(top).push(key)
    }
    for (const [namespace, group] of [...byNamespace].sort()) {
      console.log(`  ${namespace} (${group.length}):`)
      for (const key of group) console.log(`    ${key}`)
    }
  }
  printGroup('任何地方都没人用', deadOrphans)
  printGroup('只有测试引用', testOnlyOrphans)

  for (const locale of LOCALES) {
    if (locale === LOCALES[0]) continue
    const same = orphansByLocale[locale].join('|') === orphans.join('|')
    console.log(`  ${locale}: ${orphansByLocale[locale].length} 个孤儿${same ? '（与 zh-CN 一致）' : '（⚠ 与 zh-CN 不一致，需人工看）'}`)
  }

  if (Object.keys(parityIssues).length > 0) {
    console.log('\n[键集不一致] 以 zh-CN 为基准：')
    for (const [locale, issue] of Object.entries(parityIssues)) {
      if (issue.missing.length > 0) console.log(`  ${locale} 缺少: ${issue.missing.join(', ')}`)
      if (issue.extra.length > 0) console.log(`  ${locale} 多出: ${issue.extra.join(', ')}`)
    }
  } else {
    console.log('\n[键集不一致] 无：四种语言键集完全相同。')
  }

  console.log('\n边界：孤儿判定以 src/ 为准；tests/ 单独扫一遍，只用于把孤儿分成「可直接删」与「删键要连测试一起改」两组。')
  console.log('动态拼键无法静态枚举，以下前缀下的键一律视为可能被引用：')
  if (dynamicPrefixes.size === 0) console.log('  （无）')
  for (const prefix of [...dynamicPrefixes].sort()) console.log(`  ${prefix}.<...>`)

  process.exit(unknownKeys.length > 0 ? 1 : 0)
}

main()
