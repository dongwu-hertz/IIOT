/**
 * 监测页图表批（业主 2026-09-21 第二批：Item 16 / 19 / 20 / 24）。
 *
 * WHY THIS FILE EXISTS
 * 这四条全是"图表怎么配"的改动，而每一类改动都有一个"看起来做完了"的失败形态：
 *
 *   1. **Item 16（dataZoom）**：选项里写了 `dataZoom` 却不写回声防护 → 渲染进程一个核
 *      被"事件→改状态→重画→setOption→事件"的环占满（第 28–36 轮的定位过程钉在
 *      `tests/trend-zoom-export.test.ts`）。所以这里照那一套的写法断言：
 *      `userDriven` 闸门排在最前、写入时刻是普通变量（不是 ref）、有爆发安全阀。
 *   2. **Item 20（70/30 + 右侧四行）**：MetricCard 卡片删不干净（或 import 留着）就会
 *      被下一次"顺手用回来"，同一个事实画两遍。
 *   3. **Item 19（时间轴并入趋势卡）**：组件挂回独立卡片位置，页面看起来一样能回放，
 *      但版式回到了"两块分开" —— 业主的原话是「合并到实时趋势里面的」。
 *   4. **Item 24（检测模式）**：最大的风险是**编造数据源** —— 设备一次只开一路流
 *      （PROTOCOL-FINDINGS 4.3），不存在"8 路同步实时特征"。检测卡的数据只能来自
 *      "每通道各自的时间线"（`channelFeatureHistory`），所以这里同时钉 store 的
 *      生命周期（切通道保留、换设备清空）与纯函数的边界（封顶、乱序不收）。
 *
 * 词条说明：本批新增的 `monitorUi.modeSingle` / `modeDetect` / `detectSpl` /
 * `detectSmoothness` / `detectEnergyRatio` / `detectDominantFreq` / `detectLegendChannel` /
 * `detectDataNote` / `viewMode` 由词条批统一进四本目录，这里**不**对目录做存在性断言
 * （那在 `tests/i18n.test.ts` 的 key parity 里自然被钉住）。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  recordChannelFeatureHistory,
  type ChannelFeatureHistoryMap
} from '../src/renderer/src/lib/channelFeatures'
import { trendDataZoom } from '../src/shared/domain/trend'
import type { RealtimeFeature } from '../src/shared/domain/models'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉 `.vue` 里的全部注释（HTML / CSS / 行注释），与 `tests/page-layout.test.ts` 同一套。 */
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

/** 取出一对标记之间的源码；找不到就断言失败（改名/删除必须报出来，不能静默通过）。 */
function between(source: string, open: string, close: string, label: string): string {
  const start = source.indexOf(open)
  assert.ok(start >= 0, `找不到 ${label} 的起点：${open}`)
  const end = source.indexOf(close, start + open.length)
  assert.ok(end > start, `找不到 ${label} 的终点：${close}`)
  return source.slice(start, end)
}

/** 取出一条 CSS 规则的花括号内容（选择器被改名/删除时测试必须报出来）。 */
function ruleBody(css: string, selector: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = source.indexOf(`${selector} {`)
  assert.ok(start >= 0, `没有找到规则 ${selector}`)
  const end = source.indexOf('}', start)
  assert.ok(end > start, `规则 ${selector} 没有闭合`)
  return source.slice(start, end)
}

const viewSource = read('src/renderer/src/views/MonitorView.vue')
const viewCode = stripComments(viewSource)
const viewTemplate = stripComments(templateBlock(viewSource))
const storeCode = stripComments(read('src/renderer/src/stores/monitor.ts'))

function frame(channelId: number, timestamp: number, spl = 42): RealtimeFeature {
  return {
    deviceId: 'dev-1',
    channelId,
    timestamp,
    spl,
    mainFrequency: 100,
    smoothness: 0.5,
    bandEnergyRatio: 0.25
  }
}

// ---------------------------------------------------------------------------
// Item 20：趋势卡 70% 图 + 右侧当前值四行，删掉四张 MetricCard
// ---------------------------------------------------------------------------

describe('Item 20：趋势卡 70/30 + 右侧当前值四行', () => {
  it('四张 MetricCard 与 .card-grid--stats 删干净了（连 import 一起）', () => {
    assert.equal(viewCode.includes('card-grid--stats'), false, '.card-grid--stats 还在（统计卡区块应已删除）')
    assert.equal(viewCode.includes('<MetricCard'), false, 'MetricCard 还在被渲染（右栏已取代它）')
    assert.equal(viewCode.includes('MetricCard.vue'), false, 'MetricCard 的 import 还留着（没人用就会被下一次挂回来）')
  })

  it('右栏四行就是业主点名的四项，值取 monitor.latest，无数据显示 —（不是 0）', () => {
    assert.match(viewCode, /const trendStatRows = computed/, '没有右栏四行的取数')
    const rowsBlock = between(viewCode, 'const trendStatRows = computed', '\n})', '右栏四行')
    // 业主点名的顺序：声压级 / 主频 / 频带能量比 / 平稳度。
    const order = ['metrics.spl', 'metrics.mainFrequency', 'metrics.bandEnergyRatio', 'metrics.smoothness']
    let cursor = 0
    for (const key of order) {
      const index = rowsBlock.indexOf(`labelKey: '${key}'`)
      assert.ok(index > cursor, `右栏四行里 ${key} 不在应该在的位置（顺序或缺失）`)
      cursor = index
    }
    assert.match(rowsBlock, /value: frame\?\.spl/, '声压级没有取 features 最后一帧')
    assert.match(viewTemplate, /data-trend-stat="row\.key"/, '模板里没有逐行的 data-trend-stat 钩子')
    // 无数据显示 —：写 0 是撒谎，空格会被读成 0。
    assert.match(viewTemplate, /<template v-else>—<\/template>/, '无数据时没有渲染 —')
  })

  it('版式：图 70% + 右栏占余量，窄屏（<900px）回落上下排列', () => {
    assert.match(ruleBody(viewSource, '.trend-panel__body'), /display:\s*flex/)
    assert.match(ruleBody(viewSource, '.trend-panel__chart'), /flex:\s*0 0 70%/, '趋势图不是 70% 宽')
    assert.match(ruleBody(viewSource, '.trend-panel__stats'), /flex:\s*1/, '右栏没有吃掉剩余 30%')
    const media = viewSource.replace(/\/\*[\s\S]*?\*\//g, '').match(/@media \(max-width: 900px\)[\s\S]*$/)
    assert.ok(media, '没有 <900px 的媒体查询')
    assert.match(media[0], /\.trend-panel__body\s*\{[^}]*flex-direction:\s*column/, '窄屏没有回落上下排列')
  })

  it('扩展指标（存在才画）以小号排在四行之后', () => {
    assert.match(viewCode, /trend-stats__row--extended/, '扩展指标行没有单独的（小号）样式钩子')
    assert.match(viewTemplate, /v-for="metric in extendedMetrics"/, '扩展指标没有排在四行之后')
    // 数据源仍是同一帧的扩展字段：oddEven / spectralComplexity / fingerprintVariation。
    assert.match(viewCode, /frame\.oddEvenHarmonicRatio/, '奇偶谐波比不再从最新帧取数')
    assert.match(viewCode, /frame\.spectralComplexity/, '频谱复杂度不再从最新帧取数')
    assert.match(viewCode, /frame\.fingerprintVariation/, '指纹变化度不再从最新帧取数')
  })
})

// ---------------------------------------------------------------------------
// Item 16：趋势图 X 轴缩放/平移（dataZoom），回声防护照抄 TrendsView 第 36 轮
// ---------------------------------------------------------------------------

describe('Item 16：趋势图 dataZoom 与回声防护', () => {
  it('trendOption 带缩放（inside 滚轮 + slider 范围条），窗口写进选项', () => {
    assert.match(
      viewCode,
      /dataZoom: trendDataZoom\(trendZoom\.value \?\? undefined\)/,
      '趋势图没有带缩放（或窗口没有写进选项 —— 重画会丢缩放）'
    )
    // 底边给 slider 留了位置（与 `trendDataZoom()` 的 height 18 / bottom 4 配套）。
    const option = between(viewCode, 'const trendOption = computed', '\n})', '趋势图选项')
    assert.match(option, /grid: \{ left: 46, right: 16, top: 24, bottom: 52 \}/, 'grid 底边没给 slider 留位置')
    // 共享配置本身：两条通道、filter 模式、滚轮只缩放不平移（与历史趋势同一套）。
    const config = trendDataZoom() as Array<Record<string, unknown>>
    assert.equal(config.length, 2)
    assert.equal(config[0]?.type, 'inside')
    assert.equal(config[1]?.type, 'slider')
    // 模板上接的是 EChart 的 datazoom 事件。
    assert.match(viewTemplate, /@datazoom="onTrendZoom"/, '趋势图没有接 datazoom 事件')
  })

  it('只有用户手势引起的缩放才记状态（userDriven 闸门排最前）', () => {
    const fn = viewCode.slice(viewCode.indexOf('function onTrendZoom('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    assert.match(body, /if \(window\.userDriven !== true\) return/, '没有 userDriven 闸门 —— 回声会驱动状态')
    assert.ok(
      body.indexOf('userDriven !== true') < body.indexOf('trendZoomShouldRecord('),
      'userDriven 闸门必须排在"猜回声"的判据前面'
    )
    assert.match(
      body,
      /trendZoomShouldRecord\(trendZoom\.value, window, msSinceWrite, trendZoomWriteTarget\)/,
      '没有把"最后写进去的窗口"传给纯函数 —— 回声环可能回来'
    )
    assert.match(body, /trendZoomWrittenAt = Date\.now\(\)/, '没有记"刚写过选项"的时刻')
    assert.match(body, /trendZoomWriteTarget = next/, '没有记"最后写进选项的窗口"')
    assert.match(
      body,
      /trendZoomBurstExceeded\(trendZoomAcceptedAt, Date\.now\(\)\)/,
      '没有装爆发安全阀（残余的环会一直转）'
    )
  })

  it('写入时刻/目标窗口/接受队列是普通变量（放进 ref 会自己触发重渲染，多一条环）', () => {
    assert.match(viewCode, /let trendZoomWrittenAt = 0/, '`trendZoomWrittenAt` 必须是普通变量')
    assert.match(viewCode, /let trendZoomWriteTarget/, '`trendZoomWriteTarget` 必须是普通变量')
    assert.match(viewCode, /const trendZoomAcceptedAt: number\[\] = \[\]/, '`trendZoomAcceptedAt` 必须是普通数组')
    // 窗口本身是响应式 ref（选项的输入），但渲染路径不许在 patch 期间写别的 ref。
    assert.match(
      viewCode,
      /const trendZoom = ref<\{ start: number; end: number \} \| null>\(null\)/,
      '缩放窗口没有做成响应式状态'
    )
  })
})

// ---------------------------------------------------------------------------
// Item 19：时间轴回放 —— 声纹趋势卡内那一处已删（X 轴缩放覆盖），仅声呐分支保留一处
// ---------------------------------------------------------------------------

describe('Item 19：时间轴回放（仅声呐分支一处）', () => {
  it('声纹趋势卡内**没有** MonitorRecordingTimeline（业主 20260921 批：X 轴缩放已覆盖）', () => {
    const trend = between(
      viewTemplate,
      '<section class="chart-panel card trend-panel">',
      '\n      </section>',
      '趋势卡'
    )
    assert.equal(
      trend.includes('<MonitorRecordingTimeline'),
      false,
      '声纹趋势卡里又长出了时间轴回放（业主：X 轴缩放已覆盖，卡内那一处删掉）'
    )
    // ⓘ info 钩子（检测模式的数据口径悬停说明）在趋势卡头。
    assert.ok(trend.includes('data-trend-info'), '趋势卡头没有 ⓘ 说明钩子（data-trend-info）')
  })

  it('全页恰好一处时间轴：声呐（原位）；声纹卡内那一处已删', () => {
    const occurrences = viewTemplate.match(/<MonitorRecordingTimeline/g) ?? []
    assert.equal(occurrences.length, 1, '时间轴应当是"仅声呐分支一处"')
    // 声纹页头里也有一枚 `v-else-if="isSonar"` 的机型徽标模板，声呐**页面分支**取最后一处。
    const sonarStart = viewTemplate.lastIndexOf('<template v-else-if="isSonar">')
    assert.ok(sonarStart > 0, '找不到声呐分支')
    const sonar = viewTemplate.slice(sonarStart, viewTemplate.indexOf('</template>', sonarStart))
    assert.ok(sonar.includes('<MonitorRecordingTimeline'), '声呐分支的时间轴不在原位（那一支没有趋势卡）')
  })
})

// ---------------------------------------------------------------------------
// Item 24：检测模式 —— 四张指标卡 × 每通道一色（2×2）
// ---------------------------------------------------------------------------

describe('Item 24：检测模式', () => {
  it('segmented 切换（单通道 / 检测），选择只记组件 ref、不持久化', () => {
    assert.match(viewTemplate, /data-view-mode="single"/, '没有「单通道」切换按钮')
    assert.match(viewTemplate, /data-view-mode="detect"/, '没有「检测」切换按钮')
    assert.match(viewTemplate, /:aria-pressed="viewMode === 'single'"/, '切换按钮没有 aria-pressed（读屏器看不见状态）')
    assert.match(viewCode, /const viewMode = ref<'single' \| 'detect'>\('single'\)/, '视图选择没有记在组件 ref')
    assert.equal(/localStorage/.test(viewCode), false, '视图选择被持久化了（业主明确要求不持久化）')
  })

  it('检测模式隐藏单通道四卡、显示 2×2 检测卡', () => {
    assert.match(
      viewTemplate,
      /<div v-show="viewMode === 'single'" class="graph-grid">/,
      '单通道四卡没有随视图切换隐藏'
    )
    assert.match(
      viewTemplate,
      /<div v-show="viewMode === 'detect'" class="detect-grid">/,
      '检测卡网格没有随视图切换显示'
    )
    // 每行最多 2 张（业主点名的 2×2）：固定两列，不用 auto-fit（超宽屏会并出 4 列）。
    assert.match(
      ruleBody(viewSource, '.detect-grid'),
      /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
      '检测卡网格不是"每行最多 2 张"'
    )
    const grid = between(viewTemplate, 'class="detect-grid">', '\n      </div>', '检测卡网格')
    // 四张卡 = 业主点名的四行：声压级 / 平稳度 / 能量比 / 主频。
    for (const key of ['monitorUi.detectSpl', 'monitorUi.detectSmoothness', 'monitorUi.detectEnergyRatio', 'monitorUi.detectDominantFreq']) {
      assert.ok(grid.includes(`t(metric.labelKey)`) && viewCode.includes(`'${key}'`), `检测卡少了 ${key}`)
    }
  })

  it('每张检测卡：line、动画关、lttb、时间轴说真话、每通道一色 + 图例标通道号', () => {
    const block = between(viewCode, 'const detectOptions = computed', '\n})', '检测卡选项')
    assert.match(block, /animation: false/, '检测卡开着动画（监控台上的动画意味着"数据是活的"，假动作）')
    assert.match(block, /sampling: 'lttb'/, '检测卡没有 lttb 抽样')
    assert.match(block, /type: 'time'/, '检测卡没有用时间轴（跨通道不同步这件事要由轴本身说真话）')
    assert.match(block, /data: frames\.map\(\(frame\) => \[frame\.timestamp, frame\[metric\.key\]\]\)/, '数据点没有带各自的时间戳')
    // 每通道一色：与历史趋势页"多通道同坐标"同一套调色板（TREND_CHANNEL_COLORS，8 色）。
    assert.match(block, /trendChannelColor\(tab\.index\)/, '通道颜色没有走 trendChannelColor')
    assert.match(block, /type: 'scroll'/, '通道图例没有做成可滚（8 路在窄卡里会溢出）')
    assert.match(block, /t\('monitorUi\.detectLegendChannel', \{ channel: tab\.label \}\)/, '图例名没有标注通道号')
    // 无面积（或极淡面积）：这一批没有面积 —— 8 条叠在一起，面积只会糊成一片。
    assert.equal(/areaStyle/.test(block), false, '检测卡加了面积样式（8 条叠绘会糊）')
  })

  it('数据来源口径写在卡下：每通道各自的时间线，跨通道不同步', () => {
    assert.match(viewTemplate, /t\('monitorUi\.detectDataNote'\)/, '检测卡网格下没有那句口径说明')
    assert.match(viewCode, /monitor\.channelFeatureHistory/, '检测卡没有读 store 的每通道时间线')
  })
})

// ---------------------------------------------------------------------------
// store：每通道时间线的生命周期（切通道保留、换设备清空、帧到达即记录）
// ---------------------------------------------------------------------------

describe('store：每通道时间线（channelFeatureHistory）', () => {
  it('帧到达时记进时间线；clearBuffers 不清（切通道要留住），selectDevice 清空（那是另一台设备）', () => {
    const handleFeature = between(storeCode, 'function handleFeature', 'function handleAudio', '特征帧处理')
    assert.ok(
      handleFeature.includes('recordChannelFeatureHistory('),
      '特征帧没有追加进每通道时间线'
    )
    const clearBuffers = between(storeCode, 'function clearBuffers', '}', '清缓冲函数')
    assert.equal(
      clearBuffers.includes('channelFeatureHistory'),
      false,
      'clearBuffers() 清掉了每通道时间线 —— 切一次通道，检测卡就全空'
    )
    const selectDevice = between(storeCode, 'function selectDevice', 'function channelFeatureOf', '选设备函数')
    assert.ok(
      selectDevice.includes('channelFeatureHistory.value = {}'),
      '换设备时没有清空每通道时间线（新设备会显示上一台的信号）'
    )
    assert.match(
      storeCode,
      /recordChannelFeatureHistory\([\s\S]*?FEATURE_HISTORY_LIMIT/,
      '每通道时间线没有封顶（无界内存）'
    )
  })
})

// ---------------------------------------------------------------------------
// 纯函数：recordChannelFeatureHistory 的边界
// ---------------------------------------------------------------------------

describe('recordChannelFeatureHistory：每通道时间线的边界', () => {
  it('按通道号各记各的，超出 limit 丢最旧的', () => {
    let map: ChannelFeatureHistoryMap = {}
    for (let stamp = 1; stamp <= 5; stamp += 1) map = recordChannelFeatureHistory(map, frame(1, stamp), 3)
    assert.deepEqual(
      map[1]?.map((item) => item.timestamp),
      [3, 4, 5],
      '没有按 limit 封顶'
    )
    map = recordChannelFeatureHistory(map, frame(2, 6), 3)
    assert.deepEqual(
      map[2]?.map((item) => item.timestamp),
      [6],
      '通道之间互相污染了'
    )
    assert.equal(map[1]?.length, 3, '别的通道进帧把已封顶的序列又顶长了')
  })

  it('畸形通道号不收（同一个引用 = 不触发响应式更新）', () => {
    const empty: ChannelFeatureHistoryMap = {}
    assert.equal(recordChannelFeatureHistory(empty, frame(64, 1), 3), empty)
    assert.equal(recordChannelFeatureHistory(empty, frame(-1, 1), 3), empty)
    assert.equal(recordChannelFeatureHistory(empty, { ...frame(1, 1), channelId: '1' as never }, 3), empty)
  })

  it('乱序的旧帧不追加（时间线按时间单调，倒序会让图倒退）', () => {
    const first = recordChannelFeatureHistory({}, frame(2, 2000, 40), 3)
    const older = recordChannelFeatureHistory(first, frame(2, 1000, 99), 3)
    assert.equal(older, first, '旧帧被追加了')
    assert.equal(older[2]?.[0]?.spl, 40)
    // 时间戳相同：后来的那一帧算数（同一毫秒里的重发不应当被当成倒序）。
    const same = recordChannelFeatureHistory(first, frame(2, 2000, 41), 3)
    assert.equal(same[2]?.length, 1)
    assert.equal(same[2]?.[0]?.spl, 41)
  })
})
