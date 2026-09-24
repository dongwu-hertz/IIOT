/*
 * 构建验证（沙箱友好）：三段 electron-vite 配置逐个过一遍可用的构建路径。
 *
 * WHY THIS EXISTS
 * `npm run build` = `npm run typecheck && electron-vite build`，它在**正常环境里是首选**
 * （能出 `out/`，安装包打的就是它）。但在本项目的受限环境里这条路会断在 esbuild 上：
 * Vite 的 TS 转换会**开一个 esbuild 子进程**（`spawn EPERM`），看起来像"代码构建不过"，
 * 实际只是这一步跑不动。第 40、41 轮都撞在这里，当时是在沙箱外/临时脚本里手工把三段配置
 * 喂给 Vite，那份做法没有落进仓库 —— 这个脚本就是它。
 *
 * 每一段先试**真构建**（`vite build()`，Rollup 纯 JS）；只有当失败原因是"不许起子进程"
 * 时，才退回一段**说明清楚它证明了什么**的替代验证：入口 + 模块图由 TypeScript 自己在
 * 进程内转译并解析一遍（相对导入与 `@main` / `@shared` / `@renderer` 别名都真的解一次）。
 * 渲染层那一段的模块图只有 1 个文件（入口是 `index.html`，`.vue` 的编译归 `vue-tsc`
 * 与真正的构建管线），所以渲染层的替代验证**只**说明"配置与入口找得到"。
 *
 * 所以本脚本**永远不动 `out/`**（真构建的产物写到 `.test-build/build-check/<段>`）。
 * 要能打包的产物，仍然在正常桌面会话里跑 `npm run build`。类型检查不在这里做 ——
 * 它走 `npm run typecheck`（`tsc` + `vue-tsc`），`vue-tsc` 才看得懂 `.vue`。
 *
 * ---------------------------------------------------------------------------
 * 除了三段构建，本脚本还会逐文件**编译每个 `.vue` 的模板**（见 checkTemplates）
 * ---------------------------------------------------------------------------
 * 2026-09-26 加的这一段，起因是一次真实的漏网：第 50 轮改 `AlarmsView.vue` 的模板时多留了
 * 一个 `<template v-if>`，于是 `npm run build` 报
 * `[vue:vue] AlarmsView.vue: Element is missing end tag`。
 * 而当时能跑的**每一道静态闸门都是绿的**：`vue-tsc` 不看模板结构、单测只做源码字符串断言、
 * 这个脚本当时又不编译 `.vue` —— 缺陷只有"真的构建一次"或者"真的开一次窗口"才现形。
 * 模板是 `.vue` 的半条命，一道闸门都不该漏掉它。
 *
 * 用法
 *   node scripts/build-check.cjs
 *   node scripts/build-check.cjs --verbose
 */
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const OUT_ROOT = path.join(ROOT, '.test-build', 'build-check')
const verbose = process.argv.includes('--verbose')

/**
 * 逐文件编译 `.vue` 的模板，把**模板层面的错**（标签不闭合、指令写错、`v-for` 少 key 之类）
 * 在构建之前就报出来。
 *
 * 用 `@vue/compiler-sfc`（Vue 自己的编译器，`vue-tsc` 与 Vite 用的同一套前端）：
 * `parse()` 拆出 SFC，`compileTemplate()` 编译模板。**在进程内跑**，不起子进程、不碰 `out/`。
 */
function checkTemplates() {
  const { parse, compileTemplate } = require('@vue/compiler-sfc')
  const failures = []
  let files = 0

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.vue')) continue
      files += 1
      const source = fs.readFileSync(full, 'utf8')
      const relative = path.relative(ROOT, full)
      const { descriptor, errors } = parse(source, { filename: full })
      for (const error of errors) {
        failures.push(`${relative}: ${error.message}`)
      }
      if (!descriptor.template) continue
      const compiled = compileTemplate({
        source: descriptor.template.content,
        filename: full,
        id: relative,
        compilerOptions: { mode: 'module' }
      })
      for (const error of compiled.errors ?? []) {
        failures.push(`${relative}: ${typeof error === 'string' ? error : error.message}`)
      }
    }
  }

  walk(path.join(ROOT, 'src'))
  return { files, failures }
}

/** 受限环境里 esbuild 的报错形状：不许起子进程，不是代码有问题。 */
function isSpawnRefusal(error) {
  const message = String((error && error.message) || error || '')
  return /spawn EPERM|EACCES|Failed to run dependency scan/i.test(message)
}

/**
 * 载入项目自己的 `electron.vite.config.ts`。
 *
 * 为什么不 `import()`：那是 ESM，文件里却用了 `__dirname`（CJS 才有的全局）。
 * 为什么不用 `vite` 的 `loadConfigFromFile()`：它用 esbuild 转译配置 —— 又是子进程。
 * 这里用 `typescript`（devDependency）在**进程内**转成 CommonJS 再求值：
 * 配置内容没有被改写，`require` 是真的，`defineConfig` 是恒等函数。
 */
function loadSections() {
  const { createRequire } = require('node:module')
  const configPath = path.join(ROOT, 'electron.vite.config.ts')
  const source = fs
    .readFileSync(configPath, 'utf8')
    .replace(/^export default /m, 'exports.default = ')
    // `import.meta.url` 在 CJS 里没有意义（配置只用它给 createRequire 定位）。
    .replace(/import\.meta\.url/g, '__filename')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: configPath
  })
  const factory = new Function('exports', 'module', 'require', '__dirname', '__filename', outputText)
  const moduleShim = { exports: {} }
  factory(moduleShim.exports, moduleShim, createRequire(configPath), ROOT, configPath)
  return moduleShim.exports.default ?? moduleShim.exports
}

/** 真构建（Rollup，纯 JS，不起子进程）。 */
async function realBuild(name, section, options = {}) {
  const { build } = require('vite')
  const outDir = path.join(OUT_ROOT, name)
  fs.rmSync(outDir, { recursive: true, force: true })
  const started = Date.now()
  /*
   * Node 内置模块在**非渲染层**那两段里必须外部化。
   *
   * 为什么这里要显式写：正常情况下 `electron-vite` 会替我们做这件事（它按段设置 target /
   * ssr / external），而本脚本为了绕开 esbuild 子进程**没有**用 electron-vite ——
   * 少了这一层，Vite 会把 `node:crypto` 当成浏览器依赖，于是报
   * `"randomUUID" is not exported by "__vite-browser-external"`，
   * 而 `npm run build` 明明是过的（实测过）。这是**替代跑法自己的差异**，
   * 不是我藏起来的失败：它的方向是"多报"，所以修掉它不会掩盖产品问题。
   */
  const isMainLike = options.nodeTarget === true
  const externals = isMainLike
    ? (id) => id.startsWith('node:') || require('node:module').builtinModules.includes(id)
    : undefined
  await build({
    ...section,
    configFile: false, // 配置已由 loadSections() 载入
    root: section.root ? path.resolve(ROOT, section.root) : ROOT,
    // 主进程 / preload 是 Electron 的 Node 端代码，按 SSR 构建才不会被当成浏览器包
    // （这正是 electron-vite 替我们做的那一层，见上面那段注释）。
    ...(isMainLike ? { ssr: true } : {}),
    build: {
      ...(section.build ?? {}),
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      ...(externals
        ? {
            rollupOptions: {
              ...(section.build?.rollupOptions ?? {}),
              external: externals
            }
          }
        : {})
    },
    logLevel: verbose ? 'info' : 'warn'
  })
  return { kind: 'build', ms: Date.now() - started, outDir: path.relative(ROOT, outDir) }
}

/**
 * 替代验证：入口能编译、模块图解得开。
 *
 * 走的是 TypeScript 自己的解析器 + 编译器，所以相对导入与 `paths` 别名都会被真的解一次；
 * 解不开的导入会**在构建前**就报出来（这正是"构建失败"最常见的原因）。
 */
function transpileGraph(entry, labelToPaths) {
  const cache = new Map()
  const seen = new Set()
  const failures = []
  let files = 0
  let bytes = 0

  const resolveSpecifier = (specifier, fromFile) => {
    if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier)
    for (const [alias, target] of Object.entries(labelToPaths)) {
      if (specifier === alias || specifier.startsWith(`${alias}/`)) {
        const rest = specifier.slice(alias.length).replace(/^\//, '')
        return path.join(target, rest)
      }
    }
    return null // 裸包名：externalizeDepsPlugin 会把它外部化，这里不追。
  }

  const withExtensions = (base) => {
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.vue`,
      path.join(base, 'index.ts')
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    return null
  }

  const visit = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    files += 1
    bytes += text.length
    const { outputText } = ts.transpileModule(text, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.Preserve,
        esModuleInterop: true
      },
      fileName: file,
      reportDiagnostics: true
    })
    if (!outputText) failures.push(`${path.relative(ROOT, file)}：转译没有产出代码`)

    /*
     * 用 TS 的 AST 取 import / export-from 的说明符（正则会在注释与字符串上误判）。
     */
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const specifiers = []
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifiers.push(statement.moduleSpecifier.text)
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    }
    for (const specifier of specifiers) {
      const base = resolveSpecifier(specifier, file)
      if (base === null) continue
      const resolved = withExtensions(base)
      if (resolved === null) {
        failures.push(`${path.relative(ROOT, file)} → 解析不到 "${specifier}"`)
        continue
      }
      const key = resolved
      if (cache.has(key)) continue
      cache.set(key, true)
      visit(resolved)
    }
  }

  visit(entry)
  return { files, bytes, failures }
}

async function main() {
  const sections = Object.entries(loadSections()).filter(
    ([, value]) => value && typeof value === 'object'
  )
  if (sections.length === 0) {
    console.error('[build-check] electron.vite.config.ts 里没有可用的段')
    process.exit(1)
  }

  const results = []
  let failed = 0

  for (const [name, section] of sections) {
    try {
      // 渲染层那一段跑在浏览器环境里，Node 内置模块**不能**外部化（它本来就该报错）。
      const result = await realBuild(name, section, { nodeTarget: name !== 'renderer' })
      results.push({ name, ok: true, ...result })
      console.log(`✔ ${name.padEnd(9)} 真构建 ${result.ms}ms → ${result.outDir}`)
    } catch (error) {
      if (!isSpawnRefusal(error)) {
        failed += 1
        results.push({ name, ok: false })
        console.error(`✖ ${name.padEnd(9)} 真构建失败：${error && error.message}`)
        if (verbose && error && error.stack) console.error(error.stack)
        continue
      }
      /*
       * 到了这里说明：环境不许 Vite 起 esbuild 子进程。退回替代验证，
       * 并把"它证明了什么、没证明什么"逐条打出来 —— 不许静默降级。
       */
      const alias = section.resolve?.alias ?? {}
      const labelToPaths = {}
      for (const [key, value] of Object.entries(alias)) {
        labelToPaths[key] = Array.isArray(value) ? value[0] : value
      }
      const entry =
        section.build?.rollupOptions?.input?.index ??
        (typeof section.build?.rollupOptions?.input === 'string'
          ? section.build.rollupOptions.input
          : null)
      if (!entry) {
        failed += 1
        results.push({ name, ok: false })
        console.error(`✖ ${name.padEnd(9)} 找不到入口，无法替代验证`)
        continue
      }
      const graph = transpileGraph(path.resolve(entry), labelToPaths)
      if (graph.failures.length > 0) {
        failed += 1
        results.push({ name, ok: false })
        console.error(`✖ ${name.padEnd(9)} 模块图有问题：`)
        for (const failure of graph.failures.slice(0, 20)) console.error(`    ${failure}`)
        continue
      }
      results.push({ name, ok: true, kind: 'graph', ...graph })
      console.log(
        `~ ${name.padEnd(9)} 真构建被环境挡住（esbuild 不许起子进程）→ 替代验证通过：` +
          `入口 + 模块图 ${graph.files} 个文件可转译、导入全部解析`
      )
    }
  }

  /*
   * 模板编译：`.vue` 的**模板**是 `vue-tsc` 与单测都看不见的那一半（见文件头那段）。
   */
  try {
    const templates = checkTemplates()
    if (templates.failures.length > 0) {
      failed += 1
      console.error(`✖ 模板编译 ${templates.failures.length} 处失败：`)
      for (const failure of templates.failures.slice(0, 20)) console.error(`    ${failure}`)
    } else {
      console.log(`✔ 模板编译    ${templates.files} 个 .vue 的模板全部通过（@vue/compiler-sfc）`)
    }
  } catch (error) {
    failed += 1
    console.error('✖ 模板编译这一步自己失败了：' + (error && error.message))
  }

  /*
   * 类型检查**不在这里做**：它由 `npm run typecheck`（`tsc` + `vue-tsc`）负责，
   * 而 `vue-tsc` 才能看懂 `.vue` —— TypeScript 的编译 API 单跑会报十几个
   * "Cannot find module './App.vue'"，那是工具口径不同，不是类型错。
   */
  console.log(
    `[build-check] ${sections.length} 段 · 通过 ${sections.length - failed} / 失败 ${failed}` +
      '（真构建的产物在 .test-build/build-check/，**没有**动 out/；类型检查走 npm run typecheck）'
  )
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error('[build-check] FATAL: ' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
