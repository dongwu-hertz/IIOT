/**
 * 趋势页的**多通道叠加 + 多量并排**（业主 2026-09-18 的追加要求，不在这 24 条里）。
 *
 * 业主原话：「对于 2 通道，和八通道的设备，应该支持 平稳度、声压级、频带能量比、
 * 奇偶次谐波能量比这些数值的趋势变化的同时显示，用不同颜色的折线将多个通道的信号
 * 显示在同一个坐标轴上，只是通过点击通道名称实现是显示这个通道还是隐藏这个通道。」
 *
 * WHY THIS FILE EXISTS
 * 这一条有四件事"改错了不会报错"，只有在源码结构上钉住才能提前拦住：
 *
 *   1. **点通道名不能触发查询**。它只改"画哪几条线"（数据在查询时已经一次全取回来）。
 *      一旦有人在 `toggleChannel` 里加一句 `query()`，点一下通道就会打出一串 DuckDB 扫描
 *      —— 界面看起来还是对的，只是那次点击开始变慢、并且每点一次都变慢。
 *   2. **至少留一个量、至少留一条通道**。全关掉之后图上什么都没有，而"空图"看起来像
 *      "这个设备没有历史数据" —— 那是界面在说一句错话。
 *   3. **多条通道必须落在同一根轴上、颜色来自同一个来源**。两处各取一次颜色（图例一处、
 *      图一处）迟早会不一致，而"图例上的颜色对不上图上的线"比没有颜色更糟。
 *   4. **每个量一根自己的 Y 轴（即一张自己的图）**。声压级是 dB、另外三个是无量纲比值，
 *      共用一根轴时两条线的高低关系是刻度造出来的，不是数据说的。
 *
 * 真正跑起来的样子由 `scripts/demo-shot-driver.cjs` 在真实窗口里量（图例条数、点击前后的
 * 可见线数、每张图里有几条 series）。这一层与那一层的分工见 `tests/page-layout.test.ts` 的文件头。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'
import {
  TREND_CHANNEL_COLORS,
  TREND_METRIC_MAX_SELECTED,
  trendChannelColor
} from '../src/shared/domain/trend'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释（`<!-- -->`、块注释、`//`）之后的源码：断言的是代码，不是散文。 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'))
    })
    .join('\n')
}

function templateBlock(source: string): string {
  const open = source.indexOf('<template>')
  const close = source.lastIndexOf('</template>')
  return open >= 0 && close > open ? source.slice(open, close) : ''
}

/** 一个具名函数/方法的函数体（从签名到下一个同缩进的 `}`）。 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, `没有找到 ${signature}`)
  let depth = 0
  let seenBrace = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === '{') {
      depth += 1
      seenBrace = true
    } else if (char === '}') {
      depth -= 1
      if (seenBrace && depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const storeSource = stripComments(read('src/renderer/src/stores/trends.ts'))
const viewSource = read('src/renderer/src/views/TrendsView.vue')
const viewCode = stripComments(viewSource)
const viewTemplate = stripComments(templateBlock(viewSource))

describe('通道配色：不同颜色，而且不与状态色打架', () => {
  it('至少 8 种颜色，且互不相同（2 通道与 8 通道的设备都要能不重色）', () => {
    assert.ok(TREND_CHANNEL_COLORS.length >= 8, `调色板只有 ${TREND_CHANNEL_COLORS.length} 色`)
    assert.equal(
      new Set(TREND_CHANNEL_COLORS).size,
      TREND_CHANNEL_COLORS.length,
      '调色板里有重复的颜色'
    )
  })

  it('第一色就是单条曲线原来的颜色（只看一条通道时颜色不该变）', () => {
    assert.equal(trendChannelColor(0), '#FF6A1A')
  })

  it('顺序固定、超出调色板时循环（16 通道的 SN-16 仍然画得出来）', () => {
    assert.equal(trendChannelColor(3), TREND_CHANNEL_COLORS[3])
    assert.equal(
      trendChannelColor(TREND_CHANNEL_COLORS.length),
      TREND_CHANNEL_COLORS[0],
      '超出调色板时没有循环，第 9 条通道会没有颜色'
    )
    // 负数与小数不该算出 `undefined`（那会让 ECharts 拿到一个空色）。
    assert.equal(trendChannelColor(-1), TREND_CHANNEL_COLORS[0])
    assert.equal(trendChannelColor(1.7), TREND_CHANNEL_COLORS[1])
  })

  it('不用红/绿这两档状态色：一条红线看起来像"这条通道有故障"', () => {
    const stateColors = ['#b91c1c', '#12b76a', '#dc2626', '#16a34a']
    for (const color of TREND_CHANNEL_COLORS) {
      assert.equal(
        stateColors.includes(color.toLowerCase()),
        false,
        `调色板里出现了状态色 ${color}`
      )
    }
  })

  it('图例与折线用同一个来源，视图里没有第二份颜色表', () => {
    assert.match(viewCode, /trendChannelColor\(channel\.index\)/, '图例的色点不是来自共享函数')
    // 图上的每条线也用同一个函数（`buildBundle` 里那一次）。
    assert.match(viewCode, /color: trendChannelColor\(entry\.index\)/, '折线的颜色不是来自共享函数')
    // 视图里不许出现十六进制颜色（这个仓库只有 assets/main.css 与 trendMetrics.ts 写颜色）。
    assert.equal(
      /#[0-9a-fA-F]{6}\b/.test(viewTemplate),
      false,
      '模板里出现了硬编码颜色'
    )
  })
})

describe('点通道名 = 只改显示，不重新查库', () => {
  const toggle = bodyOf(storeSource, 'function toggleChannel(')

  it('`toggleChannel` 里没有 query（点一下就打一串 DuckDB 扫描是这里最容易犯的错）', () => {
    assert.equal(
      /query\(/.test(toggle),
      false,
      'toggleChannel 触发了查询：它应当只改"画哪几条线"'
    )
    assert.match(toggle, /hiddenChannelIds\.value/, 'toggleChannel 没有改隐藏状态')
  })

  it('隐藏是纯状态：查询时**全部通道**都取回来（所以点开是瞬时的）', () => {
    const run = bodyOf(storeSource, 'async function runQuery(')
    // 循环的输入是 channelIds（全部通道），不是 visibleChannelIds（可见的）。
    assert.match(
      run,
      /for \(const channel of channelIds\.value\)/,
      '查询只取了可见通道：那样点亮一条被隐藏的通道就没有数据可画'
    )
    assert.equal(
      /for \(const channel of visibleChannelIds\.value\)/.test(run),
      false,
      '查询按"可见通道"取数：点开一条通道会画出一条空线'
    )
  })

  it('最后一条可见的通道点不掉（全关掉会看起来像"没有历史数据"）', () => {
    assert.match(
      toggle,
      /visibleChannelIds\.value\.length <= 1/,
      '没有拦住"把最后一条通道也隐藏掉"'
    )
  })

  it('`setChannels` 会清掉已经不存在的通道的隐藏状态', () => {
    const set = bodyOf(storeSource, 'function setChannels(')
    assert.match(
      set,
      /hiddenChannelIds\.value = hiddenChannelIds\.value\.filter\(\(id\) => next\.includes\(id\)\)/,
      '换设备之后旧的隐藏状态会被带到新设备上（新设备的某条通道一进来就是灰的）'
    )
  })

  it('通道表没变时 `setChannels` 不查库（`watch` 带 immediate，第一次一定会调）', () => {
    const set = bodyOf(storeSource, 'function setChannels(')
    assert.match(set, /if \(same\) return/, 'setChannels 没有"没变就不查"的短路')
    assert.match(set, /query\(\)/, 'setChannels 变了之后没有重新查')
  })
})

describe('量可以多选，但至少留一个、最多 4 个', () => {
  const toggle = bodyOf(storeSource, 'function toggleMetric(')

  it('最后一个量点不掉，而且上限就是业主点名的四个', () => {
    assert.equal(TREND_METRIC_MAX_SELECTED, 4, '量的上限不是 4（业主点名的正好四个）')
    assert.match(toggle, /metrics\.value\.length === 1\) return/, '没有拦住"把最后一个量也关掉"')
    assert.match(
      toggle,
      /metrics\.value\.length >= TREND_METRIC_MAX_SELECTED\) return/,
      '没有拦住超过上限'
    )
  })

  it('量的排列按稳定顺序，不按点击先后（同一组选中项永远长成同一个样子）', () => {
    assert.match(toggle, /TREND_METRIC_ORDER\.filter/, '插入位置不是稳定顺序')
  })

  it('每个量一张图：视图按 `trends.metrics` 渲染，而不是一个量', () => {
    assert.match(viewCode, /trends\.metrics\.map\(/, 'chartBundles 没有按选中的量逐个建')
    assert.match(viewTemplate, /data-metric-chart/, '模板里没有"每个量一张图"的钩子')
  })

  it('每张图有自己的 Y 轴名与自己的 series（不共用一根轴）', () => {
    const fn = bodyOf(viewCode, 'function chartOptionFor(')
    assert.match(fn, /trendAxisName\(bundle\.metric/, '轴名不是按这一张图的量算的')
    assert.match(fn, /series: bundle\.lines\.map/, 'series 不是这一张图里的通道线')
    // ECharts 自带的图例必须关掉：页面上的通道按钮才是唯一的图例（两份会行为不一致）。
    assert.match(fn, /legend: \{ show: false \}/, 'ECharts 自带的图例打开了（会与通道按钮重复）')
  })

  it('同一个坐标轴：一条通道一条 series，颜色来自调色板', () => {
    const fn = bodyOf(viewCode, 'function chartOptionFor(')
    /*
     * 第 31 轮：X 轴换成**时间轴**（业主最新一条第 5 条），所以 series 的数据从
     * "纯数值数组 + 轴上的类目标签"变成 `[时间戳, 值]` 对 —— 判据仍然是"按通道来的"。
     */
    assert.match(
      fn,
      /data: bundle\.timestamps\.map\(\(stamp, index\) => \[stamp, line\.values\[index\] \?\? null\]\)/,
      'series 的数据不是按通道 + 时间戳来的'
    )
    assert.match(fn, /color: line\.color/, 'series 没有用调色板里的颜色')
    // 缺口保持缺口（绝不画成 0）——这一条在叠加之后同样成立。
    assert.match(fn, /connectNulls: false/, '叠加之后把缺口连起来了（会把"没数据"画成有数据）')
  })
})

describe('不知道通道时退回单条聚合线（设备没返回通道表的那些）', () => {
  it('`channelIds` 为空时查一条聚合序列', () => {
    const run = bodyOf(storeSource, 'async function runQuery(')
    assert.match(run, /if \(channelIds\.value\.length > 0\)/, '没有按"知不知道通道"分叉')
    assert.match(run, /queryOne\(primaryMetric, channelId\.value\)/, '不知道通道时没有查聚合序列')
  })

  it('视图在那种情况下用 `fallbackOption`（一条线），而不是空图', () => {
    // 第 26/27 轮给这张回退图加了缩放与 ref，属性因此分行写 —— 判据仍然是
    // "最后那一支（v-else）画的是 fallbackOption"。
    assert.match(
      viewTemplate,
      /<EChart\s+v-else\s+ref="fallbackChart"\s+:option="fallbackOption"/,
      '没有通道信息时模板没有退回单序列'
    )
  })
})

describe('文案：新词四种语言齐全，旧的下拉框文案已删', () => {
  const REQUIRED = [
    'trendsUi.channelHide',
    'trendsUi.channelShow',
    'trendsUi.channelShowAll',
    'trendsUi.channelLines',
    'trendsUi.metricLimit',
    'trendsUi.metricMultiHint',
    'trendsUi.metricNoData'
    /*
     * `trendsUi.statQueries`（以及曲线下方那一整行诊断的其余七个键）**在第 30 轮删掉了**：
     * 业主 2026-09-19 最新一条要求「曲线下方的返回点数，这些内容移除」。
     * 死键不留在目录里，所以它也不在这张清单上。
     */
  ]

  it('每一条在四本目录里都有译文，而且不是照抄中文', () => {
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
        assert.equal(message.includes('@'), false, `${locale} 的 ${key} 含裸 @`)
      }
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
  })

  it('带占位符的句子在四种语言里占位符一致', () => {
    for (const key of [
      'trendsUi.channelLines',
      'trendsUi.metricLimit',
      'trendsUi.metricMultiHint'
    ]) {
      const reference = (messageAt('zh-CN', key) as string).match(/\{(\w+)\}/g)?.sort()
      assert.ok(reference && reference.length > 0, `${key} 没有占位符`)
      for (const locale of ['en', 'es', 'tr']) {
        assert.deepEqual(
          (messageAt(locale, key) as string).match(/\{(\w+)\}/g)?.sort(),
          reference,
          `${locale} 的 ${key} 占位符不一致`
        )
      }
    }
  })

  it('通道下拉框没了，它的目录键也不留（留着会把那个下拉画回来）', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'trendsUi.filterAllChannels'),
        undefined,
        `${locale} 里仍然存在已删除的 trendsUi.filterAllChannels`
      )
      // 告警/录音那两页的**同名键是另一个组的**，必须还在（第一次改错的就是它）。
      assert.ok(
        messageAt(locale, 'alarmsUi.filterAllChannels'),
        `${locale} 缺少 alarmsUi.filterAllChannels（告警页与录音页还在用）`
      )
    }
    assert.equal(
      /channelSelection/.test(viewCode),
      false,
      '视图里仍然引用着已删掉的 channelSelection'
    )
  })
})
