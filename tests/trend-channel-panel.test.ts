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
// 2. 通道选择：判据只有一个来源（第 30 轮起它在**设备右侧**，不再是图表右侧一列）
// ---------------------------------------------------------------------------

describe('通道选择（贴着设备那一排）', () => {
  it('一行一条通道，行上带通道号的探针钩子', () => {
    assert.match(viewTemplate, /data-trend-channels/, '没有通道选择那一块（data-trend-channels）')
    assert.match(
      viewTemplate,
      /v-for="row in channelRows"[\s\S]{0,700}?:data-trend-channel-row="row\.index"/,
      '通道不是按 channelRows 逐个渲染的'
    )
    // 行数来自设备返回的通道表（8 或 2 都由它决定），不是写死的 8。
    assert.match(viewCode, /const channelRows = computed<TrendChannelRow\[\]>/)
    assert.match(viewCode, /channelOptions\.value\.map\(\(channel\) =>/)
    // 业主 20260921 批：chip 只留 颜色点 + 通道名，每行的读数（channel-chip__value）
    // 与自定义名括号一起删掉 —— "现在哪一路高"在图上直接看得见。
    assert.equal(viewTemplate.includes('channel-chip__value'), false, 'chip 上又长出了读数')
    assert.equal(viewCode.includes('.channel-chip__value'), false, '读数的样式块没有删干净')
  })

  it('「有数据」与「无数据灰显」是**同一个**判据（`hasData`）', () => {
    // 有数据 = 任一已选中的量在这一路有至少一个有限值。
    assert.match(
      viewCode,
      /hasData: trends\.metrics\.some\(\(targetMetric\) =>[\s\S]{0,200}?Number\.isFinite\(point\.value\)/,
      'hasData 不是按"这一路有没有有限值"算的'
    )
    // 灰显读的是 hasData（不是通道配置状态 —— 那是另一件事）。
    assert.match(
      viewTemplate,
      /'channel-chip-wrap--nodata': !row\.hasData/,
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

  it('通道选择排在**设备的右侧**、指标之前；趋势图占满宽度（业主最新一条）', () => {
    /*
     * 原话：「如果是声纹设备，通道的选择应该放在设备的右侧的位置，趋势图还是占右侧区域的 100%」。
     *
     * 第 25 轮那一版把通道放在**图的右侧一列**（第 13 批第 4 条的"右侧列出 8 或 2 个通道"），
     * 于是图只能拿到剩下的宽度；现在通道回到筛选栏、贴在设备后面，图自己就是那张卡片的全宽。
     */
    const device = viewTemplate.indexOf('trendsUi.filterDevice')
    const channels = viewTemplate.indexOf('data-trend-channels')
    const metrics = viewTemplate.indexOf('data-metric-picker')
    const chart = viewTemplate.indexOf('data-metric-chart')
    assert.ok(device > 0 && channels > 0 && metrics > 0 && chart > 0, '找不到设备 / 通道 / 指标 / 图')
    assert.ok(device < channels, '通道选择没有排在设备之后')
    assert.ok(channels < metrics, '通道选择没有排在指标之前（"设备的右侧"）')
    assert.ok(channels < chart, '通道选择跑到了图后面')
    // 两栏网格（图 | 通道列）**整块删掉**：图占 100% 宽度。
    assert.equal(/\.trends-body/.test(viewCode), false, '两栏网格还在（图就被挤窄了）')
    assert.equal(/\.channel-panel/.test(viewCode), false, '旧的右侧通道列样式还在')
  })

  it('旧的两栏结构（右侧一列）整块删掉了，通道现在是筛选栏里的一排 chip', () => {
    assert.equal(viewCode.includes('channel-row__'), false, '旧的行样式还在')
    assert.equal(viewCode.includes('data-channel-legend'), false, '旧图例容器还在')
    // 通道 chip 就在 `[data-trend-channels]` 那一块里（一行一条，带勾选、色点、读数、改名）。
    assert.match(viewTemplate, /class="chip-row channel-chip-row"/)
    assert.match(viewTemplate, /:data-trend-channel-check="row\.index"/)
    assert.match(viewTemplate, /:data-trend-channel-rename="row\.index"/)
    // 「全部显示」这个动作留着（它跟着通道那一排走）。
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
    'trendsUi.channelRenameHint',
    'trendsUi.channelRenameOffline',
    'trendsUi.channelRenamePlaceholder',
    'trendsUi.channelRenameFailed',
    'trendsUi.channelRenamed'
  ]

  it('八条新词在四本目录里都有译文，且不是照抄中文', () => {
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

// ---------------------------------------------------------------------------
// 5. 筛选栏的版面：通道那一排必须**留在设备右边**（第 32 轮的真窗口读数）
// ---------------------------------------------------------------------------

/**
 * 第 32 轮，趋势页那一段探针终于跑到了几何断言（第 28–31 轮都停在超时上），量到的是：
 *
 * ```
 * panelTop=168  deviceTop=120   ← 通道那一排**换到了下一行**
 * panelLeft=273 panelRight=1399 barWidth=1127   ← 它占满整行，而不是"设备的右侧"
 * deviceRight=537（下拉 265px，不是 200px）
 * ```
 *
 * 两处成因，各自都不报错、只在真窗口里看得出来，所以钉在源码这一层：
 *   1. 设备那个 `<label>` 丢了 `field--wide` → 下拉按最宽的选项自己撑到 265px；
 *   2. `.field--channels` 的 `flex: 0 1 auto` → **base size 是内容宽度**（8 路实测 1126px），
 *      而 `flex-wrap` 判断"换不换行"看的正是 base：它永远放不进设备右边那一段，
 *      于是只能另起一行。业主那条「通道的选择应该放在设备的右侧」从来没成立过。
 */
describe('筛选栏：设备进顶栏、通道在筛选栏这一排（第 32 轮的真窗口读数 + 20260921 批搬迁）', () => {
  it('设备下拉搬进顶栏那一格（Teleport），不再占筛选栏的一格', () => {
    // 业主 20260921 批：设备选择器照 MonitorView 的先例投进 `#topbar-page-slot`，
    // 筛选栏里那个 `field--wide` 控件连同它的样式一起删掉（留着指向不存在元素的规则，
    // 会让下一个人以为那东西还在）。
    const teleport = viewTemplate.slice(viewTemplate.indexOf('<Teleport to="#topbar-page-slot">'))
    assert.ok(teleport.length > 0, '找不到投往顶栏的 Teleport')
    assert.match(
      teleport,
      /<Teleport to="#topbar-page-slot">[\s\S]{0,600}?t\('trendsUi\.filterDevice'\)/,
      '顶栏那一格里没有设备下拉'
    )
    const style = viewCode.slice(viewCode.indexOf('.topbar-device {'))
    assert.match(style, /\.topbar-device \{[\s\S]*?width:\s*50%/, '顶栏下拉的 .topbar-device 样式块不见了')
    assert.equal(viewCode.includes('.field--wide'), false, '.field--wide 规则又留了回来（控件已删）')
  })

  it('通道那一排的 flex base 压到 320px（大 base 一定会换行）', () => {
    const block = /\.field--channels \{[\s\S]*?\}/.exec(viewCode)
    assert.ok(block, '找不到 `.field--channels` 的样式块')
    assert.match(block[0], /flex:\s*1 1 320px/, '`.field--channels` 的 flex 不是 `1 1 320px`')
    assert.equal(
      /flex:\s*0 1 auto/.test(block[0]),
      false,
      '`.field--channels` 又回到 `flex: 0 1 auto`：base = 内容宽度（8 路 1126px），' +
        '于是它必然换到下一行，通道就不在设备的右侧了'
    )
  })
})
