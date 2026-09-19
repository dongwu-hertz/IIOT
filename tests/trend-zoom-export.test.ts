/**
 * 历史趋势：时间轴缩放 + Y 轴弹性 + 数据导出 + 打印为 PDF（业主 2026-09-19 第 13 批第 6 条）。
 *
 * 业主原话：「所有折线图支持时间轴放大缩小与 Y 轴弹性变化；支持数据导出与打印为 PDF」。
 *
 * WHY THIS FILE EXISTS
 * 这一条里每一件事都有一个"看起来做完了"的失败形态：
 *
 *   1. **加了 `dataZoom` 却没有注册组件**：ECharts 会把那个选项**静默忽略** —— 图照画、
 *      代码里也确实写了 `dataZoom`，只是拖不动。所以这里同时断言"选项里有"与
 *      "组件注册了"。
 *   2. **缩进去之后图上看不出来**：一张只画了三分钟的图与一张画了三十天的图长得一模一样。
 *      所以缩放窗口必须换算成"第几个点到第几个点 + 哪一段时间"并写在页面上。
 *   3. **CSV 里含逗号/引号的通道名会把列错位**（Excel 不报错，只是数据塞进了后面的列），
 *      中文还需要 UTF-8 BOM 才不乱码。
 *   4. **导出写盘必须读回核对**：报给界面的字节数与行数要来自"读回来的那一份"。
 *   5. **打印要能只打印图**：`window.print()` 打的是整个界面，没有 `@media print`
 *      就会把侧边栏和筛选栏一起打出来。
 *
 * 真实窗口里那几条（滚轮真的能缩放、导出真的落盘、打印真的被调用）由
 * `scripts/demo-shot-driver.cjs` 的趋势页那一段负责。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { trendDataZoom, trendZoomIsIdentity, trendZoomWindow } from '../src/shared/domain/trend'
import {
  TREND_CSV_BOM,
  TREND_CSV_HEADER,
  buildTrendCsv,
  csvField,
  sanitiseFileSegment,
  stampForFileName,
  trendCsvFileName,
  type TrendExportRow
} from '../src/shared/domain/trend-export'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

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
const chartComponent = stripComments(read('src/renderer/src/components/EChart.vue'))
const handlers = stripComments(read('src/main/ipc/handlers.ts'))
const mainCss = read('src/renderer/src/assets/main.css')

function exportRow(overrides: Partial<TrendExportRow> = {}): TrendExportRow {
  return {
    timestamp: Date.UTC(2026, 8, 19, 7, 30),
    metric: 'spl',
    channel: 0,
    channelName: 'CH1',
    value: 62.345,
    sampleCount: 12,
    unit: 'dB',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. 时间轴缩放
// ---------------------------------------------------------------------------

describe('时间轴缩放', () => {
  it('两条通道：滚轮（inside）+ 范围条（slider），都按可见数据过滤', () => {
    const config = trendDataZoom() as Array<Record<string, unknown>>
    assert.equal(config.length, 2)
    assert.equal(config[0]?.type, 'inside')
    assert.equal(config[1]?.type, 'slider')
    // `filterMode: 'filter'` 就是"Y 轴跟着可见的那一段弹性变化"。
    assert.equal(config[0]?.filterMode, 'filter')
    assert.equal(config[1]?.filterMode, 'filter')
    /*
     * 滚轮只负责缩放，**不**让鼠标划过就平移（ECharts 的默认值是"划过即平移"）：
     * 监控台上鼠标从图上走过、时间窗口自己跑了，操作员会以为图坏了。
     */
    assert.equal(config[0]?.zoomOnMouseWheel, true)
    assert.equal(config[0]?.moveOnMouseMove, false)
    assert.equal(config[0]?.moveOnMouseWheel, false)
    // 范围条要够高才拖得动，而且要贴底（grid 的 bottom 为它留了 52px）。
    assert.ok(Number(config[1]?.height) >= 16)
  })

  it('**组件真的注册了**（不注册的话选项会被静默忽略，图照画但拖不动）', () => {
    assert.match(chartComponent, /DataZoomComponent/, 'EChart.vue 没有注册 DataZoomComponent')
    assert.match(chartComponent, /echarts\.use\(\[[\s\S]{0,400}?DataZoomComponent/)
  })

  it('每一张图都带缩放（两颗构建函数各自一处，回退图也有）', () => {
    const occurrences = viewCode.match(/dataZoom: trendDataZoom\(zoomWindow\.value \?\? undefined\)/g) ?? []
    assert.equal(occurrences.length, 2, '多通道图与回退图应当各有一处 dataZoom')
    assert.match(viewTemplate, /@datazoom="\(window\) => onChartZoom\(bundle\.metric, window\)"/)
    assert.match(viewTemplate, /@datazoom="\(window\) => onChartZoom\('fallback', window\)"/)
  })

  it('缩放窗口写进选项（重画不会把用户刚做的缩放丢掉）', () => {
    const config = trendDataZoom({ start: 25, end: 75 }) as Array<Record<string, unknown>>
    assert.equal(config[0]?.start, 25)
    assert.equal(config[0]?.end, 75)
    assert.equal(config[1]?.start, 25)
    assert.equal(config[1]?.end, 75)
    // 不给窗口时是整段。
    const full = trendDataZoom() as Array<Record<string, unknown>>
    assert.equal(full[0]?.start, 0)
    assert.equal(full[0]?.end, 100)
  })

  it('**同一次缩放只记一次**（不然就是 事件→改状态→重画→setOption→事件 的死循环）', () => {
    const fn = viewCode.slice(viewCode.indexOf('function onChartZoom('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    assert.match(body, /Math\.abs\(current\.start - next\.start\) < 0\.01/, '没有判"窗口有没有真的变"')
    assert.match(body, /if \(current === null\) return/, '同一段"没有缩放"也会再写一次状态')
    // 选项必须是 computed（稳定引用）：模板里直接调函数会让每次重渲染都造一个新选项。
    assert.match(viewCode, /const chartOptions = computed<Record<string, EChartsCoreOption>>/)
    assert.match(viewTemplate, /:option="chartOptions\[bundle\.metric\]/, '模板没有用 computed 的选项')
  })

  it('缩放窗口换算：百分比 → 桶下标（可单测）', () => {
    assert.deepEqual(trendZoomWindow(11, 0, 100), { fromIndex: 0, toIndex: 10 })
    assert.deepEqual(trendZoomWindow(11, 50, 100), { fromIndex: 5, toIndex: 10 })
    // 桶数不足两个时没有"一段"可选。
    assert.equal(trendZoomWindow(1, 0, 100), null)
    assert.equal(trendZoomWindow(0, 0, 100), null)
    // 越界的百分比收进范围（拖到两端时 ECharts 会给带小数的值）。
    assert.deepEqual(trendZoomWindow(5, -10, 140), { fromIndex: 0, toIndex: 4 })
  })

  it('"没有缩放"认得出来（两端都在整段上）', () => {
    assert.equal(trendZoomIsIdentity(0, 100), true)
    assert.equal(trendZoomIsIdentity(0.4, 99.6), true)
    assert.equal(trendZoomIsIdentity(0, 99), false)
    assert.equal(trendZoomIsIdentity(10, 100), false)
  })

  it('缩进去之后页面上必须写明"现在看的是哪一段"', () => {
    assert.match(viewCode, /const zoomHint = computed/, '没有那句提示')
    assert.match(viewTemplate, /data-trend-zoom-bar/, '没有提示行')
    assert.match(viewTemplate, /data-trend-zoom-hint/)
    // 提示里要有"第几个点到第几个点"与"哪一段时间"两件事。
    assert.match(viewCode, /t\('trendsUi\.zoomHint', \{[\s\S]{0,200}?range:/)
    assert.match(viewCode, /zoomRangeText/, '没有把下标换算回时间')
  })

  it('「重置缩放」把**所有**图拉回整段（只重置一张会让两张图显示不同范围）', () => {
    const fn = viewCode.slice(viewCode.indexOf('function resetZoom('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    assert.match(body, /Object\.values\(chartRefs\.value\)/, '没有遍历每一张图')
    assert.match(body, /fallbackChart\.value\?\.resetZoom\(\)/, '回退图没有被重置')
    assert.match(viewTemplate, /data-trend-zoom-reset/)
    // 组件那一侧：`dispatchAction` 而不是重画整张图。
    assert.match(chartComponent, /dispatchAction\(\{ type: 'dataZoom', start: 0, end: 100 \}\)/)
    assert.match(chartComponent, /defineExpose\(\{ resetZoom \}\)/)
  })
})

// ---------------------------------------------------------------------------
// 2. 数据导出
// ---------------------------------------------------------------------------

describe('数据导出（CSV）', () => {
  it('表头是稳定的英文键 + 单位，列的顺序固定', () => {
    assert.deepEqual([...TREND_CSV_HEADER], [
      'timestamp_iso',
      'timestamp_ms',
      'metric',
      'channel',
      'channel_name',
      'value',
      'unit',
      'sample_count'
    ])
  })

  it('含逗号 / 引号 / 换行的字段用双引号包起来，内部引号写两遍', () => {
    assert.equal(csvField('plain'), 'plain')
    assert.equal(csvField('1#机组, 东侧'), '"1#机组, 东侧"')
    assert.equal(csvField('他说"好"'), '"他说""好"""')
    assert.equal(csvField('两\n行'), '"两\n行"')
    assert.equal(csvField(62.3), '62.3')
  })

  it('整份 CSV 带 UTF-8 BOM 与 CRLF 行尾（Excel 认不出来的话中文就是乱码）', () => {
    const csv = buildTrendCsv([exportRow()])
    assert.ok(csv.startsWith(TREND_CSV_BOM), '没有 BOM')
    assert.ok(csv.includes('\r\n'), '行尾不是 CRLF')
    assert.equal(csv.split('\r\n')[0], TREND_CSV_BOM + TREND_CSV_HEADER.join(','))
  })

  it('一行一个读数，空桶（NaN）**不进文件**（写 0 是撒谎、写 NaN 是垃圾）', () => {
    const csv = buildTrendCsv([
      exportRow({ channel: 0, value: 62.3 }),
      exportRow({ channel: 1, value: Number.NaN }),
      exportRow({ channel: 2, value: 58.1, channelName: '1#机组, 东侧' })
    ])
    const lines = csv.split('\r\n').filter((line) => line.trim() !== '')
    // 表头 + 两行数据（NaN 那一行被跳过）。
    assert.equal(lines.length, 3)
    assert.ok(lines[2]?.includes('"1#机组, 东侧"'), '通道名没有被正确转义')
  })

  it('文件名带设备与时间范围，非法字符被替换', () => {
    const from = Date.UTC(2026, 8, 19, 7, 30)
    const to = Date.UTC(2026, 8, 19, 8, 0)
    assert.equal(
      trendCsvFileName({ deviceName: 'AE08', from, to }),
      `trend-AE08-${stampForFileName(from)}-${stampForFileName(to)}.csv`
    )
    const weird = trendCsvFileName({ deviceName: 'A/B:C*D?E"F<G>H|I', from, to })
    assert.equal(/[\\/:*?"<>|]/.test(weird), false, `文件名里还有非法字符：${weird}`)
    assert.equal(sanitiseFileSegment('   '), 'device')
    assert.equal(sanitiseFileSegment('机房 1 号'), '机房_1_号')
    // 时间戳里不能有冒号（Windows 保留字符）。
    assert.equal(/[:]/.test(stampForFileName(from)), false)
  })

  it('界面：按钮在、点了会调 IPC、成功与失败都说话', () => {
    assert.match(viewTemplate, /data-trend-export/, '没有导出按钮')
    assert.match(viewCode, /window\.api\.trends\.exportCsv\(/, '没有调用导出 IPC')
    // 导出行数/字节数报的是**读回核对**之后的结果（IPC 的返回值）。
    assert.match(viewCode, /t\('trendsUi\.exportDone', \{[\s\S]{0,200}?bytes: formatBytes\(info\.bytes\)/)
    assert.match(viewTemplate, /data-trend-export-notice/)
    assert.match(viewTemplate, /data-trend-export-error/)
    // 没有数据时不写一个只有表头的空文件。
    assert.match(viewCode, /if \(rows\.length === 0\)/, '没有拦住空导出')
    assert.match(viewCode, /t\('trendsUi\.exportNothing'\)/)
  })

  it('导出的是**看得见的通道**（和屏幕对得上）', () => {
    const fn = viewCode.slice(viewCode.indexOf('function buildExportRows('))
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
    assert.match(body, /trends\.visibleChannelIds/, '导出没有按可见通道过滤')
    assert.equal(/channelIds/.test(body.replace(/visibleChannelIds/g, '')), false, '导出了被隐藏的通道')
  })

  it('主进程：参数收窄 + 写 + **读回核对**，返回的字节数与行数来自读回的那一份', () => {
    const handler = handlers.slice(handlers.indexOf('IpcChannels.TREND_EXPORT_CSV'))
    const body = handler.slice(0, handler.indexOf('trendLog') > 0 ? 2400 : 2400)
    assert.match(handler, /requirePermission\('viewTrends'\)/, '导出没有权限校验')
    assert.match(handler, /path\.basename\(rawName\)/, '没有把文件名收成最后一段（可以写到目录之外）')
    // 一个"剥掉非法字符"的 replace（正则里的字符集不在这里逐字重写：转义一多，
    // 断言的字符串本身就成了最难读的那一行）。
    assert.match(handler, /replace\(\/\[[^\]]+\]\/g, '_'\)/, '没有剥掉非法字符')
    assert.match(handler, /await writeFile\(target, csv, 'utf8'\)/, '没有写盘')
    assert.match(handler, /const back = await readFile\(target, 'utf8'\)/, '没有读回')
    assert.match(handler, /\(await stat\(target\)\)\.size/, '字节数不是读回来的')
    assert.match(handler, /back\.split\(\/\\r\?\\n\/\)/, '行数不是从读回的文件里数的')
    void body
  })
})

// ---------------------------------------------------------------------------
// 3. 打印
// ---------------------------------------------------------------------------

describe('打印为 PDF', () => {
  it('按钮调用 `window.print()`（打印对话框里可以"另存为 PDF"）', () => {
    assert.match(viewTemplate, /data-trend-print/, '没有打印按钮')
    const fn = viewCode.slice(viewCode.indexOf('function printCharts('))
    assert.match(fn.slice(0, 200), /window\.print\(\)/, '没有调用 window.print')
  })

  it('打印时把界面收起来（打印出来的是证据，不是界面截图）', () => {
    assert.match(viewCode, /@media print \{/, '视图里没有打印样式')
    assert.match(viewCode, /\.channel-panel,[\s\S]{0,200}?display: none !important/, '没有藏起通道列等')
    // 外壳（侧边栏 / 顶栏）在 main.css 里统一藏。
    assert.match(mainCss, /@media print \{[\s\S]{0,400}?\.sidebar,[\s\S]{0,80}?\.topbar/, '外壳没有打印样式')
  })
})

// ---------------------------------------------------------------------------
// 4. 四语言词条
// ---------------------------------------------------------------------------

describe('四语言词条', () => {
  const REQUIRED = [
    'trendsUi.zoomHint',
    'trendsUi.zoomReset',
    'trendsUi.exportCsv',
    'trendsUi.exporting',
    'trendsUi.exportHint',
    'trendsUi.exportDone',
    'trendsUi.exportNothing',
    'trendsUi.exportFailed',
    'trendsUi.print',
    'trendsUi.printHint'
  ]

  it('十条新词在四本目录里都有译文，且不是照抄中文', () => {
    for (const key of REQUIRED) {
      for (const locale of Object.keys(CATALOGUES)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
      }
      const reference = messageAt('zh-CN', key) as string
      for (const locale of ['en', 'es', 'tr']) {
        assert.notEqual(messageAt(locale, key), reference, `${locale} 的 ${key} 与中文逐字相同`)
      }
    }
  })

  it('带占位符的两条在四种语言里占位符一致', () => {
    for (const key of ['trendsUi.zoomHint', 'trendsUi.exportDone']) {
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
})
