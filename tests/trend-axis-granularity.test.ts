/**
 * 历史趋势：X 轴的时间颗粒度 + 声压级 Y 轴 0–100（业主 2026-09-19 第 13 批第 5 条）。
 *
 * 业主原话：「下方的指标删除聚合方式、直接呈现所有结果；声压级那四张卡片删除；
 * 只显示趋势曲线；Y 轴 0–100 dB；X 轴支持自定义缩放时间颗粒度」。
 *
 * WHY THIS FILE EXISTS
 * 这一条有四件事"改错了不会报错"：
 *
 *   1. **"删除聚合方式"不等于"删除时间桶"**。前者是"一个桶里面怎么算"（业主删掉的是那个
 *      下拉框，桶里固定按平均算，Y 轴名字里照旧写着"（平均）"）；后者是"一个桶有多宽"
 *      （业主**要**的"X 轴自定义缩放时间颗粒度"）。把这两件事当成一件事，就会连桶一起删掉
 *      —— 一个月的历史会变成一个点，而页面上看起来只是"图变平了"。
 *   2. **声压级固定 0–100，其余的量必须弹性**。给比值量也写死一根轴，变化会被压成一条直线；
 *      而固定了 min/max 之后**不能同时开 ECharts 的 `scale`**（那会得到"看起来想弹性、
 *      实际是 0–100"的半对状态）。
 *   3. **档位必须是认得出来的 key**。一个拼错的 key 如果被写进 store，
 *      就变成"点了一下什么也没发生，但桶宽已经是没人知道的数"。
 *   4. **"自动"不能是黑箱**：它决定了这张图有多细，所以界面上要把主进程实际挑的桶宽写出来。
 *
 * 真实窗口里的量（那一排按钮、切档之后桶宽真的变了、SPL 那张图的 `data-y-range`）
 * 由 `scripts/demo-shot-driver.cjs` 的趋势页那一段负责。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  SPL_AXIS_MAX,
  SPL_AXIS_MIN,
  trendAxisRange,
  trendAxisRangeText
} from '../src/shared/domain/trend'
import {
  TREND_GRANULARITY_DEFAULT_KEY,
  TREND_GRANULARITY_OPTIONS,
  granularityBucketSeconds,
  granularityKeyForSeconds,
  granularityOption
} from '../src/shared/domain/trend-granularity'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去注释之后的源码：反向断言（"某个标记还在不在"）必须读它。 */
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

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
}

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const viewSource = read('src/renderer/src/views/TrendsView.vue')
const viewCode = stripComments(viewSource)
const viewTemplate = stripComments(templateBlock(viewSource))
const storeCode = stripComments(read('src/renderer/src/stores/trends.ts'))

/** `chartOptionFor` 的函数体（声压级 Y 轴那一段就在里面）。 */
function chartOptionBody(): string {
  const start = viewCode.indexOf('function chartOptionFor(')
  assert.ok(start > 0, '找不到 chartOptionFor')
  let depth = 0
  let seen = false
  for (let index = start; index < viewCode.length; index += 1) {
    const char = viewCode[index]
    if (char === '{') {
      depth += 1
      seen = true
    } else if (char === '}') {
      depth -= 1
      if (seen && depth === 0) return viewCode.slice(start, index + 1)
    }
  }
  return viewCode.slice(start)
}

// ---------------------------------------------------------------------------
// 1. Y 轴范围：只有声压级是固定的
// ---------------------------------------------------------------------------

describe('Y 轴范围', () => {
  it('声压级就是 0–100（业主点名的两个数）', () => {
    assert.deepEqual(trendAxisRange('spl'), { min: SPL_AXIS_MIN, max: SPL_AXIS_MAX })
    assert.equal(SPL_AXIS_MIN, 0)
    assert.equal(SPL_AXIS_MAX, 100)
  })

  it('其余的量一律弹性（不写死一根轴）', () => {
    for (const metric of [
      'mainFrequency',
      'smoothness',
      'bandEnergyRatio',
      'oddEvenHarmonicRatio',
      'spectralComplexity',
      'fingerprintVariation'
    ] as const) {
      assert.deepEqual(trendAxisRange(metric), {}, `${metric} 的 Y 轴不该被写死`)
    }
  })

  it('给探针看的文本与图里那根轴同源（`0-100` / `auto`）', () => {
    assert.equal(trendAxisRangeText('spl'), '0-100')
    assert.equal(trendAxisRangeText('smoothness'), 'auto')
  })

  it('视图真的用了它，而且固定时**关掉** `scale`', () => {
    const body = chartOptionBody()
    assert.match(body, /const range = trendAxisRange\(bundle\.metric\)/, '多通道图没有用共享的轴范围')
    assert.match(body, /scale: !fixedRange/, '固定 min/max 时仍然开着 scale（半对的状态）')
    assert.match(body, /range\.min !== undefined \? \{ min: range\.min \}/, '没有把 min 交给 ECharts')
    assert.match(body, /range\.max !== undefined \? \{ max: range\.max \}/, '没有把 max 交给 ECharts')
    // 回退那张单序列图也用同一把尺子（两条路径的轴不一致是最难查的一类缺陷）。
    const fallback = viewCode.slice(viewCode.indexOf('const fallbackOption'))
    assert.match(fallback.slice(0, 900), /trendAxisRange\(trends\.metric\)/, '回退图没有用同一个轴范围')
    // 探针钩子必须来自同一个函数。
    assert.match(viewTemplate, /:data-y-range="trendAxisRangeText\(bundle\.metric\)"/)
  })
})

// ---------------------------------------------------------------------------
// 2. 时间颗粒度：档位与换算
// ---------------------------------------------------------------------------

describe('时间颗粒度', () => {
  it('第一档是"自动"，其余六档从细到粗', () => {
    assert.equal(TREND_GRANULARITY_OPTIONS[0]?.key, 'auto')
    assert.equal(TREND_GRANULARITY_OPTIONS[0]?.seconds, null)
    const fixed = TREND_GRANULARITY_OPTIONS.filter((option) => option.seconds !== null)
    assert.equal(fixed.length, 6)
    const seconds = fixed.map((option) => option.seconds as number)
    assert.deepEqual(
      seconds,
      [...seconds].sort((left, right) => left - right),
      '档位不是从细到粗'
    )
    assert.equal(new Set(TREND_GRANULARITY_OPTIONS.map((option) => option.key)).size,
      TREND_GRANULARITY_OPTIONS.length, '档位的 key 有重复')
  })

  it('默认是自动（`auto`）', () => {
    assert.equal(TREND_GRANULARITY_DEFAULT_KEY, 'auto')
    assert.ok(granularityOption(TREND_GRANULARITY_DEFAULT_KEY))
  })

  it('key → bucketSeconds：自动**不发这个字段**，固定档发秒数', () => {
    assert.equal(granularityBucketSeconds('auto'), undefined)
    assert.equal(granularityBucketSeconds('5m'), 300)
    assert.equal(granularityBucketSeconds('1d'), 86_400)
    // 认不出来的 key 一律 `undefined`（**不猜**）：猜出来的桶宽没人能解释。
    assert.equal(granularityBucketSeconds('nope'), undefined)
  })

  it('后端实际桶宽 → 界面上的档位（回显"自动挑的是哪一档"）', () => {
    assert.equal(granularityKeyForSeconds(300), '5m')
    assert.equal(granularityKeyForSeconds(1), '1s')
    // 挑中的桶宽不在这六档里（主进程那把梯子有 20 档）：给 null，界面上不加标记。
    assert.equal(granularityKeyForSeconds(15), null)
    assert.equal(granularityKeyForSeconds(undefined), null)
  })

  it('store：换档会重新查库；认不出来的 key 不写；同一档不重复查', () => {
    const fn = storeCode.slice(storeCode.indexOf('function setGranularity('))
    const body = fn.slice(0, fn.indexOf('\n  }\n') + 4)
    assert.match(body, /if \(!granularityOption\(key\)\) return/, '没有拦住认不出来的 key')
    assert.match(body, /if \(granularity\.value === key\) return/, '同一档也重新查了一次')
    assert.match(body, /granularity\.value = key/, '没有写进 store')
    assert.match(body, /query\(\)/, '换了档没有重新查（图上的桶宽不会变）')
  })

  it('查询体里带上了 bucketSeconds（发的是 undefined 时不带这个字段）', () => {
    assert.match(
      storeCode,
      /granularityBucketSeconds\(granularity\.value\) !== undefined/,
      '查询体没有按颗粒度决定要不要带 bucketSeconds'
    )
    assert.match(storeCode, /bucketSeconds: granularityBucketSeconds/, '没有把秒数发给主进程')
  })

  it('界面上是一排按钮（不是下拉框），并且把自动挑的桶宽写出来', () => {
    assert.match(viewTemplate, /data-trend-granularity/, '没有那一排颗粒度按钮')
    assert.match(viewTemplate, /:data-trend-granularity-option="option\.key"/, '按钮上没有档位钩子')
    assert.match(viewTemplate, /granularitySelection = option\.key/, '按钮没有接上 store 的动作')
    assert.match(viewCode, /granularityKeyForSeconds\(trends\.series\?\.bucketSeconds\)/, '没有回显自动挑的桶宽')
    assert.match(viewTemplate, /autoBucketText/, '自动那一档旁边没有写出实际桶宽')
  })
})

// ---------------------------------------------------------------------------
// 3. 删掉的东西：聚合方式下拉框 + 四张卡片
// ---------------------------------------------------------------------------

describe('删掉的聚合方式与四张卡片', () => {
  it('视图里没有聚合方式下拉框，也没有它的选项表', () => {
    assert.equal(viewCode.includes('aggregationSelection'), false, '聚合方式的选择器还在')
    assert.equal(viewCode.includes('TREND_AGGREGATION_OPTIONS'), false, '聚合方式的选项表还在被用')
    assert.equal(
      /t\('trendsUi\.filterAggregation'\)/.test(viewCode),
      false,
      '界面上还在渲染"聚合方式"这个标签'
    )
  })

  it('四张时间桶卡片连它们的取数一起删掉了', () => {
    for (const marker of ['card-grid--stats', 'MetricCard', 'latestBucket', 'rangeStats', 'emptyBuckets']) {
      assert.equal(viewCode.includes(marker), false, `视图里还留着 ${marker}`)
    }
  })

  it('时间桶本身**没有**被删（删的是"桶里怎么算"的选择器）', () => {
    // 诊断行与截断提示都在：图是"按桶算出来的"这件事仍然说得出来。
    assert.match(viewCode, /formatBucketSeconds\(trends\.series\.bucketSeconds\)/, '诊断行里没有桶宽')
    assert.match(viewCode, /trends\.series\?\.truncated/, '截断提示不见了')
    // Y 轴名字里仍然写着聚合方式（固定为平均）—— 不写就是把"一桶的平均"说成原始读数。
    assert.match(viewCode, /trendAxisName\(bundle\.metric, trends\.aggregation\)/)
  })

  it('store 里聚合方式仍然存在但界面上改不了（固定平均）', () => {
    assert.match(storeCode, /const aggregation = ref<TrendAggregation>\('avg'\)/)
    assert.equal(/aggregation\.value = /.test(storeCode), false, '还有地方在改聚合方式')
  })
})

// ---------------------------------------------------------------------------
// 4. 四语言词条
// ---------------------------------------------------------------------------

describe('四语言词条', () => {
  it('每一档颗粒度在四本目录里都有译文，且不是照抄中文', () => {
    for (const option of TREND_GRANULARITY_OPTIONS) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, option.labelKey)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${option.labelKey}`)
      }
      const reference = messageAt('zh-CN', option.labelKey) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, option.labelKey), reference, `${locale} 的 ${option.labelKey} 与中文相同`)
      }
    }
  })

  it('标签与两条提示四语言齐全，自动那条带 {bucket}', () => {
    const keys = ['trendsUi.granularityLabel', 'granularity.autoLabel', 'granularity.autoHint', 'granularity.fixedHint']
    for (const key of keys) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
      }
    }
    for (const locale of Object.keys(CATALOGUES)) {
      assert.ok(
        (messageAt(locale, 'granularity.autoHint') as string).includes('{bucket}'),
        `${locale} 的 autoHint 没有 {bucket}`
      )
    }
  })

  it('被删掉的五个键在四本目录里都不在', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of [
        'trendsUi.filterAggregation',
        'trendsUi.latestBucket',
        'trendsUi.rangeMinBucket',
        'trendsUi.rangeMaxBucket',
        'trendsUi.emptyBuckets'
      ]) {
        assert.equal(messageAt(locale, key), undefined, `${locale} 里还留着 ${key}`)
      }
    }
  })
})
