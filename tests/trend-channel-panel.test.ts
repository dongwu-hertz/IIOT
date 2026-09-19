/**
 * 历史趋势：右侧那一列通道 + 重命名（业主 2026-09-19 第 13 批第 4 条）。
 *
 * 业主原话：「历史趋势：声纹场景选设备后右侧列出 8 或 2 个通道 CH1…支持重命名、
 * 无数据灰显、有数据可勾选」。
 *
 * WHY THIS FILE EXISTS
 * 这一条里有三个"改错了不会报错"的地方，只有在源码/纯函数这一层钉住才拦得住：
 *
 *   1. **「无数据灰显」与「有数据可勾选」必须是同一个判据**。两处各算一次，迟早会出现
 *      "灰着但能勾"的行 —— 而勾上一个没有数据的通道，图上会多一条空线，
 *      空线看起来像"这一路的这些值是 0"。
 *   2. **重命名写的是设备，不是本地别名**。手册给了 `/set_passageway` 的 `dchName`，
 *      本仓库既有 `config.updateChannel()` 走的正是那条路（写后读回核对过）。
 *      另存一份"本地名字"会让"设备上叫什么"与"我们显示叫什么"长期不一致，
 *      而这种不一致最后总是由操作员来发现。
 *   3. **改名之后必须重读通道缓存**。这一列的名字来自 `devices.channelsOf()`
 *      （库里的那一份，由设备读回来），改名走的是设备配置那条路 ——
 *      少这一步就会出现"改成功了但界面上没变"。
 *
 * 真实窗口里的量（那一列在图的右边、8 行、离线设备的改名按钮置灰）由
 * `scripts/demo-shot-driver.cjs` 的 `trends channel panel` 那一段负责。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  CHANNEL_NAME_MAX_LENGTH,
  CHANNEL_NAME_PROBLEM_KEYS,
  normaliseChannelName
} from '../src/shared/domain/channel-name'
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

// ---------------------------------------------------------------------------
// 1. 改名输入的判定（纯函数）
// ---------------------------------------------------------------------------

describe('通道名判定：三条"不该写设备"的边界', () => {
  it('正常的改名：去掉首尾空白之后是干净的字符串', () => {
    assert.deepEqual(normaliseChannelName('  1#机组轴承  ', '通道 1'), {
      ok: true,
      value: '1#机组轴承'
    })
  })

  it('空名（含只有空白）→ empty，一次都不发出去', () => {
    for (const raw of ['', '   ', '\t']) {
      assert.deepEqual(normaliseChannelName(raw, '通道 1'), { ok: false, problem: 'empty' })
    }
  })

  it('长度上限：正好等于上限可以，多一个字符不行', () => {
    const atLimit = 'x'.repeat(CHANNEL_NAME_MAX_LENGTH)
    assert.equal(normaliseChannelName(atLimit, '通道 1').ok, true)
    assert.deepEqual(normaliseChannelName(atLimit + 'x', '通道 1'), {
      ok: false,
      problem: 'too-long'
    })
  })

  it('没改（连首尾空白差别都算没改）→ unchanged，不为一次无变化的操作写设备', () => {
    assert.deepEqual(normaliseChannelName('通道 1', '通道 1'), { ok: false, problem: 'unchanged' })
    assert.deepEqual(normaliseChannelName('  通道 1 ', '通道 1'), {
      ok: false,
      problem: 'unchanged'
    })
  })

  it('每条失败原因都有对应词条，且四本目录齐全', () => {
    const problems = Object.keys(CHANNEL_NAME_PROBLEM_KEYS)
    assert.deepEqual(problems.sort(), ['empty', 'too-long', 'unchanged'])
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of Object.values(CHANNEL_NAME_PROBLEM_KEYS)) {
        const message = messageAt(locale, key)
        assert.ok(message && message.trim() !== '', `${locale} 缺 ${key}`)
      }
    }
    // 长度上限那句话必须带 `{count}`（否则上限改了这个数字会说谎）。
    for (const locale of Object.keys(CATALOGUES)) {
      assert.ok(
        (messageAt(locale, 'trendsUi.channelNameError_tooLong') as string).includes('{count}'),
        `${locale} 的 channelNameError_tooLong 没有 {count}`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 右侧那一列：判据只有一个来源
// ---------------------------------------------------------------------------

describe('右侧通道列', () => {
  it('是一列 8 或 2 行的列表，行上带通道号的探针钩子', () => {
    assert.match(viewTemplate, /data-trend-channels/, '没有那一列（data-trend-channels）')
    assert.match(
      viewTemplate,
      /v-for="row in channelRows"[\s\S]{0,600}?:data-trend-channel-row="row\.index"/,
      '行不是按 channelRows 逐个渲染的'
    )
    // 行数来自设备返回的通道表（8 或 2 都由它决定），不是写死的 8。
    assert.match(viewCode, /const channelRows = computed<TrendChannelRow\[\]>/)
    assert.match(viewCode, /channelOptions\.value\.map\(\(channel\) => \{/)
  })

  it('「有数据」与「无数据灰显」是**同一个**判据（`hasData`）', () => {
    // 有数据 = 任一已选中的量在这一路有至少一个有限值。
    assert.match(
      viewCode,
      /const hasData = trends\.metrics\.some\(\(targetMetric\) =>[\s\S]{0,200}?Number\.isFinite\(point\.value\)/,
      'hasData 不是按"这一路有没有有限值"算的'
    )
    // 灰显读的是 hasData（不是通道配置状态 —— 那是另一件事）。
    assert.match(
      viewTemplate,
      /'channel-row--nodata': !row\.hasData/,
      '灰显没有绑在 hasData 上'
    )
  })

  it('勾选框只在有数据时可用（灰着的行不许能勾）', () => {
    const fn = viewCode.slice(viewCode.indexOf('function channelCheckboxDisabled'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    assert.match(body, /return !row\.hasData/, '勾选框的可否勾选不是严格看 hasData')
    // 反向：不许再放宽成"可见的也保持可用" —— 那会让一段没有数据的区间里八个框全能勾。
    assert.equal(/row\.visible/.test(body), false, '判据被放宽了（无数据的行又能勾了）')
    assert.match(viewTemplate, /:disabled="channelCheckboxDisabled\(row\)"/)
  })

  it('整页的"这一段没有数据"与那一列同一句话：所有可见通道都没数据时才出现', () => {
    // 第 25 轮探针抓到的真缺陷：store 的 `rangeIsEmpty` 只看**第一条通道**。
    assert.match(
      viewCode,
      /const rangeEmptyForChannels = computed\(\s*\(\) => trends\.rangeIsEmpty && channelsWithData\.value === 0\s*\)/,
      '没有把"整页空态"收敛到"所有可见通道都没有数据"'
    )
    assert.match(viewTemplate, /v-else-if="rangeEmptyForChannels"/, '模板仍然直接用 store 的 rangeIsEmpty')
    assert.equal(
      /v-else-if="trends\.rangeIsEmpty"/.test(viewTemplate),
      false,
      '模板里还留着按第一条通道算的空态判据'
    )
  })

  it('面板排在图的**后面**（= 窗口里在右边）', () => {
    const chart = viewCode.indexOf('data-metric-chart')
    const panel = viewCode.indexOf('data-trend-channels')
    assert.ok(chart > 0 && panel > 0, '找不到图或通道列')
    assert.ok(chart < panel, '通道列没有排在图之后（网格里它在右边）')
    // 两栏网格：左 1fr（图）、右定宽（通道列）。
    assert.match(viewCode, /\.trends-body \{[\s\S]{0,200}?grid-template-columns:/)
  })

  it('旧的"筛选栏里那一排通道 chip"整块删掉了', () => {
    assert.equal(viewCode.includes('channel-chip'), false, '通道 chip 的样式/标记还在')
    assert.equal(viewCode.includes('data-channel-legend'), false, '旧图例容器还在')
    assert.equal(viewCode.includes('field--channels'), false, '筛选栏里那一格还在')
    // 但"全部显示"这个动作留着（它现在在通道列底部）。
    assert.match(viewTemplate, /data-channel-show-all/)
  })
})

// ---------------------------------------------------------------------------
// 3. 重命名：写设备 + 重读缓存
// ---------------------------------------------------------------------------

describe('重命名', () => {
  it('走既有的设备写路径（`/set_passageway` 的 dchName），不新造本地别名', () => {
    assert.match(
      viewCode,
      /deviceConfig\.updateChannel\(selectedDeviceId\.value, index, \{\s*name: verdict\.value\s*\}\)/,
      '改名没有走 config.updateChannel（设备那条写路径）'
    )
    // 反向：视图里不许出现"本地名字"这类自造存储。
    assert.equal(/localName/.test(viewCode), false, '视图里出现了自造的本地通道名')
    assert.equal(
      /window\.api\.devices\.update/.test(viewCode),
      false,
      '改名绕开了通道接口去改设备记录'
    )
  })

  it('写的是**只改这一路**（其余字段由主进程按设备回话合并）', () => {
    // patch 里只有 name 一个字段：多发一个字段就多一次"把别的通道改回去"的机会。
    const call = viewCode.slice(viewCode.indexOf('const updated = await deviceConfig.updateChannel'))
    const patch = call.slice(0, call.indexOf('})\n') + 2)
    assert.match(patch, /name: verdict\.value/)
    assert.equal(/sensorType|enabled|alarmProfileId/.test(patch), false, 'patch 里多带了别的字段')
  })

  it('成功之后重读通道缓存（否则"改成功了但界面没变"）', () => {
    const fn = viewCode.slice(viewCode.indexOf('async function submitChannelRename'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.match(body, /await devices\.loadChannels\(selectedDeviceId\.value, true\)/, '没有强制重读通道')
    // 顺序：先写设备，再重读缓存（反过来会把旧名字当成新结果）。
    assert.ok(
      body.indexOf('deviceConfig.updateChannel') < body.indexOf('devices.loadChannels'),
      '重读缓存排在了写设备之前'
    )
  })

  it('失败时显示设备的原话（它可能有我们编不出来的限制）', () => {
    const fn = viewCode.slice(viewCode.indexOf('async function submitChannelRename'))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    assert.match(body, /deviceConfig\.error \|\| t\('trendsUi\.channelRenameFailed'\)/)
  })

  it('只有"在线的声纹设备"能改名（相机没有那个端点、声呐的通道是本地那一行）', () => {
    assert.match(
      viewCode,
      /const channelRenameAvailable = computed\(\s*\(\) =>\s*selectedDevice\.value\?\.kind === 'acousticBox' && selectedDevice\.value\?\.status === 'ONLINE'\s*\)/,
      '改名的可用条件不对'
    )
    assert.match(viewTemplate, /:disabled="!channelRenameAvailable"/)
    // 不可用时按钮上要说清为什么（置灰而没有原因的按钮就是一个谜）。
    assert.match(viewCode, /channelRenameAvailable\.value\s*\?\s*t\('trendsUi\.channelRenameHint'\)\s*:\s*t\('trendsUi\.channelRenameOffline'\)/)
  })

  it('输入框有长度上限、Esc 取消、提交走表单（键盘可用）', () => {
    assert.match(viewTemplate, /:maxlength="CHANNEL_NAME_MAX_LENGTH"/, '输入框没有长度上限')
    assert.match(viewTemplate, /@keydown\.esc="cancelChannelRename"/, 'Esc 不能取消')
    assert.match(
      viewTemplate,
      /@submit\.prevent="submitChannelRename"/,
      '提交不是表单（回车不会提交）'
    )
    assert.match(viewTemplate, /data-trend-channel-rename-input/, '缺少改名输入框的探针钩子')
  })
})

// ---------------------------------------------------------------------------
// 4. 四语言词条
// ---------------------------------------------------------------------------

describe('四语言词条', () => {
  const REQUIRED = [
    'trendsUi.channelPanelTitle',
    'trendsUi.channelPanelSummary',
    'trendsUi.channelNoData',
    'trendsUi.channelRename',
    'trendsUi.channelRenameHint',
    'trendsUi.channelRenameOffline',
    'trendsUi.channelRenamePlaceholder',
    'trendsUi.channelRenameFailed',
    'trendsUi.channelRenamed'
  ]

  it('九条新词在四本目录里都有译文，且不是照抄中文', () => {
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
    for (const key of ['trendsUi.channelPanelSummary', 'trendsUi.channelRenamed']) {
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

  it('筛选栏里那个通道标签已经删掉（四本一起删）', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.equal(
        messageAt(locale, 'trendsUi.filterChannel'),
        undefined,
        `${locale} 里还留着 trendsUi.filterChannel`
      )
    }
  })
})
