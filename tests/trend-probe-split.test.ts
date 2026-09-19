/**
 * 趋势页那一支 GUI 探针**拆成五支**之后的守卫（2026-09-19，第 32 轮）。
 *
 * WHY THIS FILE EXISTS
 * 第 28–31 轮，趋势页那一段探针（一支 240 秒的脚本）连续超时。`layout()` 超时的返回是
 * `{probeTimeout: true}` —— **这一支的所有读数一起丢掉**，`timings` 与
 * `document.body.dataset.probeStep`（那一支自己留的"卡在哪一步"）也一起丢。
 * 结果是连"卡在哪一步"都读不到，只能盲猜（先后猜过：存储根切换、`devices.list()` 排队、
 * 数据量、DuckDB 文件锁），每条都花了整整一轮。
 *
 * 修好它的办法只有一个：**把时间和读数切成小块**，每一块各有自己的上限。所以那一段拆成：
 *   measure     只读的几何/结构（一次点击都不发）
 *   toggle / range / metrics / granularity   四处交互，各一支
 * 拆开之后超时只吞掉一支，而且 `trendTimeouts` 会点名是哪一支，问题清单里直接写出来。
 *
 * 这个文件钉住的就是"拆开"这件事本身 —— 它有三个容易悄悄退化的地方：
 *   1. 五支被合回一支（下次超时又会吞掉全部读数）；
 *   2. 某支的超时被写成"给足余量"（比如 240 秒）—— 那就等于没拆；
 *   3. **拼出来的探针脚本文本有语法错误**。这一条最阴：`node --check` 只查 driver 自己的
 *      语法，查不了字符串里的 JS；而字符串里的 `SyntaxError` 在页面里的表现就是
 *      **永远不 resolve**，也就是"超时" —— 又一次变成最难查的那种故障。
 *      所以这里把五段脚本文本真的求值一次，逐段做语法检查。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')
const driver = fs.readFileSync(
  path.join(projectRoot, 'scripts', 'demo-shot-driver.cjs'),
  'utf8'
)

/**
 * 五支的名字，顺序与 driver 里的**求值顺序**一致（合并时的报告也用这个顺序）。
 *
 * 注意：`range`（换时间范围）**故意排在最后** —— 第 32 轮实测它会把渲染进程卡死，
 * 排在它后面的支拿不到任何读数（见下面那条专门的断言）。
 */
const STEP_NAMES = ['measure', 'toggle', 'metrics', 'granularity', 'range'] as const

/**
 * 切出「共用开头 + 五支」那一段源码。
 *
 * 边界用两个标记钉住（起点：`const TREND_PROBE_HEAD =`；终点：合并那一段的注释），
 * 任何一个标记被改名/删掉都**断言失败**，不会静默地切出一个空片段然后全部通过。
 */
function trendProbeSource(): string {
  const start = driver.indexOf('const TREND_PROBE_HEAD =')
  assert.ok(start >= 0, '找不到 TREND_PROBE_HEAD —— 趋势页五支探针的共用开头没了')
  const mergeMark = driver.indexOf('五支的结果合并成原来的', start)
  assert.ok(mergeMark > start, '找不到五支之后的合并注释 —— 拆分边界变了')
  const open = driver.lastIndexOf('  /*', mergeMark)
  assert.ok(open > start, '找不到合并注释的开头')
  const body = driver.slice(start, open)
  assert.ok(body.length > 2000, '切出来的这一段太短，边界标记可能被改过：' + body.length)
  return body
}

interface ProbeScript {
  route: string
  script: string
  timeoutMs: number
}

/**
 * 把这一段求值一次，把 `layout()` 换成"只把脚本收下来"，于是拿到**真正会注入页面**的五段文本。
 *
 * 段落里的 `await  layout(...)` 是顶层 await，所以外面套一个 async IIFE；
 * `layout/log/problems` 作为参数传进去，段落里引用到它们也不会炸。
 */
async function probeScripts(): Promise<ProbeScript[]> {
  const body = trendProbeSource()
  const collected: ProbeScript[] = []
  const layoutStub = async (route: string, script: string, timeoutMs: number) => {
    collected.push({ route, script, timeoutMs })
    return {}
  }
  const factory = new Function(
    'layout',
    'log',
    'problems',
    'return (async () => {\n' +
      body +
      '\nreturn { measure: trendMeasure, toggle: trendToggle, range: trendRange,' +
      ' metrics: trendMetrics, granularity: trendGranularity };\n})()'
  )
  const steps = await factory(layoutStub, () => undefined, [])
  for (const name of STEP_NAMES) {
    assert.ok(steps[name], '第 ' + name + ' 支不存在了（变量名被改过或那一支被删了）')
  }
  assert.equal(collected.length, STEP_NAMES.length, '注入页面的脚本数不是 5 段')
  return collected
}

type StepName = (typeof STEP_NAMES)[number]

/** 五支的脚本文本，按名字取（取不到就断言失败，不留 `undefined` 往下传）。 */
async function probeTexts(): Promise<Record<StepName, string>> {
  const scripts = await probeScripts()
  const texts = {} as Record<StepName, string>
  STEP_NAMES.forEach((name, index) => {
    const item = scripts[index]
    assert.ok(item, '第 ' + name + ' 支的脚本没取到')
    texts[name] = item.script
  })
  return texts
}

describe('趋势页探针：拆成五支，各有时限', () => {
  it('五支都在，而且都往 `/trends` 注入', () => {
    const body = trendProbeSource()
    for (const name of STEP_NAMES) {
      assert.ok(
        body.includes('const trend' + name.charAt(0).toUpperCase() + name.slice(1) + ' ='),
        '找不到第 ' + name + ' 支的变量声明'
      )
    }
    const calls = body.match(/await layout\('\/trends'/g) || []
    assert.equal(calls.length, STEP_NAMES.length, '`await layout(\'/trends\'` 的次数不是 5')
  })

  it('每一支都有自己的上限，而且没有一支又变成"给足余量"的 240 秒', async () => {
    const scripts = await probeScripts()
    const timeouts = scripts.map((item) => item.timeoutMs)
    assert.deepEqual(
      timeouts.every((ms) => Number.isFinite(ms) && ms > 0),
      true,
      '有哪一支没写超时（`layout()` 会退回 60 秒的默认值，但这里要求写清楚）：' +
        JSON.stringify(timeouts)
    )
    assert.ok(
      Math.max(...timeouts) <= 90_000,
      '有哪一支的上限定在了 90 秒以上（拆开的意义就是单支不会长到吞掉整轮）：' +
        JSON.stringify(timeouts)
    )
    assert.equal(
      trendProbeSource().includes('240_000'),
      false,
      '这一段里又出现了 240 秒的上限 —— 那是"整段一起跑"的写法'
    )
  })

  it('五段注入页面的脚本都能通过语法检查（字符串里的 SyntaxError 只会表现为超时）', async () => {
    const scripts = await probeScripts()
    scripts.forEach((item, index) => {
      assert.ok(item.route === '/trends', '第 ' + STEP_NAMES[index] + ' 支注入的路由不是 /trends')
      assert.ok(
        item.script.startsWith('(async () => {'),
        '第 ' + STEP_NAMES[index] + ' 支的脚本不是 async IIFE —— 里面用了 await，必须包起来'
      )
      assert.doesNotThrow(
        () => new Function(item.script),
        '第 ' + STEP_NAMES[index] + ' 支的脚本有语法错误（在页面里会表现为超时）'
      )
      // 每一支都要把 `timings` 带上：超时之外的失败也要能看出卡在哪一步。
      assert.ok(
        item.script.includes('return finish()'),
        '第 ' + STEP_NAMES[index] + ' 支没有用 `finish()` 返回（timings 就丢了）'
      )
      assert.ok(
        item.script.includes('mark("done")'),
        '第 ' + STEP_NAMES[index] + ' 支没有走到 `mark("done")`'
      )
    })
  })

  it('第 1 支是**只读**的：几何与结构那一段一次点击都不发', async () => {
    const texts = await probeTexts()
    const measure = texts.measure
    assert.equal(
      /\bclick\s*\(/.test(measure),
      false,
      '第 1 支（measure，几何/结构）里出现了点击 —— 它必须是纯读的，' +
        '否则"点坏了"和"本来就这样"分不开'
    )
    // 只读那一支要给出"通道在设备右侧 / 曲线卡片占满宽度"两条几何判据。
    assert.ok(measure.includes('panelRightOfDevice'), '第 1 支没有量"通道在设备右侧"')
    assert.ok(measure.includes('chartCardWidthRatio'), '第 1 支没有量"曲线卡片占内容宽度"')
    assert.ok(measure.includes('aggregationSelect'), '第 1 支没有量"聚合方式那个下拉框还在不在"')
    assert.ok(measure.includes('yRanges'), '第 1 支没有量声压级那张图的 Y 轴范围')
  })

  it('交互那几支各自留下还原点，互不依赖另一支先成功', async () => {
    const texts = await probeTexts()
    // 点灭再点亮：起点态与"点了之后"的态必须同一支里都记下来。
    assert.ok(texts.toggle.includes('pressedAtStart'), 'toggle 那一支没有记起点态')
    assert.ok(texts.toggle.includes('pressedAfterRestore'), 'toggle 那一支没有记还原后的态')
    // 空区间：基准行数要由这一支自己量，不能用第 1 支的读数（那一支可能超时）。
    assert.ok(
      texts.range.includes('panelRowsBeforeRange'),
      'range 那一支没有自己量基准行数 —— 第 1 支超时时会报一条假失败'
    )
    assert.ok(texts.range.includes('emptyChecksDisabled'), 'range 那一支没有量"勾选框是否禁用"')
    assert.ok(texts.metrics.includes('selectedMetricsRestored'), 'metrics 那一支没有还原')
    assert.ok(texts.granularity.includes('bucketAfterAuto'), 'granularity 那一支没有点回自动档')
    // 交互那几支都要先等控件渲染出来（这一页在设备刷新时会重渲染，控件会短暂消失）。
    for (const name of ['toggle', 'range', 'metrics', 'granularity'] as const) {
      assert.ok(texts[name].includes('waitFor('), name + ' 那一支没有等控件渲染')
    }
  })

  it('换范围那一支排在最后，而且"问页面"这件事本身有上限', async () => {
    const body = trendProbeSource()
    const rangeAt = body.indexOf('const trendRange =')
    assert.ok(rangeAt > 0, '找不到换范围那一支')
    /*
     * 第 32 轮实测：点「自定义」范围会把**渲染进程**卡死（主进程照常打日志、页面不再应答）。
     * 一旦它卡住，排在它后面的支全部拿不到读数 —— 所以它必须是最后一支。
     */
    for (const name of ['const trendMeasure =', 'const trendToggle =', 'const trendMetrics =', 'const trendGranularity =']) {
      const at = body.indexOf(name)
      assert.ok(at > 0 && at < rangeAt, '换范围那一支不再排在最后（' + name + ' 跑到它后面去了）')
    }
    const texts = await probeTexts()
    assert.ok(texts.range.includes('customPreset'), '最后一支不是"切自定义范围"那一支')
    /*
     * `waitForPageRoot()` 里那句 `executeJavaScript` 必须**自己**有上限：渲染进程不响应时，
     * 它的 Promise 永远不 settle，外面那个 `Date.now() >= deadline` 根本轮不到执行 ——
     * 整次运行会停在那里，连"超时"都报不出来（第 32 轮那次跑就是这样停住的）。
     */
    assert.ok(driver.includes('LAYOUT_PING_TIMEOUT_MS'), '没有给"问页面"这一步加超时')
    assert.ok(
      /LAYOUT_PING_TIMEOUT_MS[\s\S]{0,400}?unresponsive/.test(driver),
      '`waitForPageRoot()` 里没有把"渲染进程不响应"当成一次有界的失败'
    )
    /*
     * 反过来，页面自己也要在每一步**立刻**报一声（`console.log('[trend-probe] ...')`）：
     * 页面里的 `timings` / `dataset.probeStep` 在卡死时一个都读不到，只有 console 消息
     * 是在产生那一刻就送到主进程的 —— 这是"停在哪一步"的唯一证据。
     */
    for (const name of STEP_NAMES) {
      assert.ok(
        texts[name].includes('[trend-probe]'),
        name + ' 那一支的 `mark()` 不再往 console 报步骤 —— 卡死时就查不出停在哪一步'
      )
    }
    assert.ok(driver.includes('logProbeTrace'), 'driver 没有把页面报的步骤抄进日志')
  })

  it('合并时跳过超时那一支，并把是哪一支写进问题清单', () => {
    assert.ok(driver.includes('const trendTimeouts = []'), '没有记录"哪一支超时了"')
    assert.ok(
      driver.includes('trendTimeouts.push(step[0])'),
      '超时那一支没有被记下来（超时就会静默丢掉读数）'
    )
    assert.ok(
      driver.includes('趋势页的多通道探针有 '),
      '问题清单里没有点名是哪一支超时'
    )
    /*
     * 关键：断言块**不许**再看 `trendChannels.probeTimeout` —— 那个字段来自"整段是一支"的
     * 写法，任何一支超时都会让整个断言块跳过，等于把另外四支的读数一起扔掉。
     */
    assert.equal(
      driver.includes('if (trendChannels.probeTimeout === true)'),
      false,
      '断言块又在看 `trendChannels.probeTimeout` —— 一支超时会把五支的读数一起丢掉'
    )
    assert.ok(
      driver.includes('trendChannels.legendCount === undefined'),
      '没有"第 1 支没回来就跳过"的降级分支'
    )
    // 基准行数的用法也要跟着改（第 1 支超时时 `panelRows` 是 undefined）。
    assert.ok(driver.includes('const rowsForEmpty ='), '空区间那一段还在直接拿 panelRows 当基准')
  })
})
