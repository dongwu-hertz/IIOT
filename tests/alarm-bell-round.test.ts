/**
 * 顶栏那颗告警图标：**设备推送过来的告警**必须显示在上面（业主 2026-09-19 第 2 条）。
 *
 * 业主原话：「告警条目是指其他设备推送到来的告警都应该显示在右上方那个告警图标按钮上。」
 *
 * WHY THIS FILE EXISTS
 * 这条要求把角标的**数据源**换了一个：
 *   · 原来数的是**联动引擎**的待处理项（`linkage.unacknowledgedCount`）—— 那是"我们为一条
 *     告警做了什么"（录像 / 抓帧 / 声光），不是告警本身；
 *   · 现在数的是**告警表里未确认的行**（`alarms`，来源只有 `fa8` / `e2`，都是设备推上来的）。
 * 一个数字换了来源，而"数字与列表必须同源"这条规矩还在，所以这里把三件事一起钉住：
 *   1. 角标读的是设备告警的 `total`，不是联动那一份；
 *   2. 面板里**真的有**那一段列表，而且每一行能就地确认；
 *   3. 联动那一份**仍然列出来**（它是另一个问题：动作有没有做成），但不进角标 ——
 *      两份列表合成一个数字正是这个仓库最反对的那种"界面说假话"。
 *
 * 顺带钉住业主同一天给的**用词**澄清：「用平稳度表示」——`metrics.smoothness` 与地图页
 * 那一列都叫平稳度，而"没有数据源"那套写法必须消失（那一列现在取最近一条告警的
 * `smoothness`）。
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

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/** 去掉注释（`<!-- -->`、块注释、`//`）：断言的是代码，不是散文。 */
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

const CATALOGUES: Record<string, unknown> = { 'zh-CN': zhCN, en, es, tr }

function messageAt(locale: string, key: string): string | undefined {
  let cursor: unknown = CATALOGUES[locale]
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

const panel = read('src/renderer/src/components/AlarmLinkagePanel.vue')
const panelCode = stripComments(panel)
const panelTemplate = stripComments(templateBlock(panel))
const mapView = read('src/renderer/src/views/DeviceMapView.vue')
const mapCode = stripComments(mapView)
const adaptersCode = stripComments(read('src/renderer/src/lib/realtimeAdapters.ts'))

describe('告警图标数的是**设备推来的告警**（业主 2026-09-19 第 2 条）', () => {
  it('角标读设备告警的 total，而不是联动那一份', () => {
    // 角标里的数与「面板里那个分区的 total」同一个来源。
    assert.match(
      panelCode,
      /const bellCount = computed\(\(\) => deviceAlarmTotal\.value\)/,
      '角标不是读设备告警的总数'
    )
    assert.match(
      panelTemplate,
      /v-if="bellCount > 0"[\s\S]{0,120}data-bell-count/,
      '角标没有稳定的探针钩子，或它不是由 bellCount 驱动的'
    )
    // 联动那一份**不许**再出现在角标里（那会让一个数字配两份列表）。
    assert.equal(
      /alarm-badge__count[\s\S]{0,200}linkage\.unacknowledgedCount/.test(panelTemplate),
      false,
      '角标又回去数联动待处理项了'
    )
  })

  it('面板里真的有那一段列表，而且每一行能就地确认', () => {
    assert.ok(panelTemplate.includes('data-bell-device-alarms'), '面板里没有设备告警那一段')
    assert.ok(panelTemplate.includes('data-bell-alarm-id'), '那一段里的行没有探针钩子')
    assert.ok(panelTemplate.includes('data-bell-device-empty'), '那一段没有空态')
    assert.match(
      panelCode,
      /window\.api\.alarms\.query\(\{ acknowledged: false, limit: 20 \}\)/,
      '那一段不是"未确认的告警"（那样角标与列表会对不上）'
    )
    assert.match(
      panelCode,
      /window\.api\.alarms\.acknowledge\(\[id\], true\)/,
      '行内的「确认」没有真的写回去'
    )
  })

  it('联动那一份仍然列出来，只是不进角标（两份列表合成一个数字是不许的）', () => {
    assert.ok(
      panelTemplate.includes("t('linkage.pendingTitle')"),
      '联动那一段被删掉了：动作做成没做成仍然要看得到'
    )
    // 变更是**行为**上的：角标数与联动条数**必须可以不同**（同一个数只可能来自同一个源）。
    assert.match(
      panelCode,
      /const deviceAlarmTotal = ref\(0\)/,
      '设备告警的总数是另一个 ref（与联动分开）'
    )
  })

  it('读不到时不写成"没有告警"（那是把失败说成事实）', () => {
    const load = panelCode.slice(panelCode.indexOf('async function loadDeviceAlarms('))
    const body = load.slice(0, load.indexOf('\n}'))
    assert.match(body, /if \(!result\.success\)/, '没有处理查询失败那条路')
    assert.match(
      body,
      /if \(!result\.success\) \{[\s\S]{0,120}return/,
      '失败之后继续写列表：会把"读不到"显示成"没有告警"'
    )
  })

  it('五条新文案在四种语言里齐全，`bellTitle` 的占位符一致', () => {
    const REQUIRED = [
      'linkage.bellTitle',
      'linkage.deviceAlarmsTitle',
      'linkage.deviceAlarmsEmpty',
      'linkage.deviceAlarmAcknowledge',
      'linkage.deviceAlarmsMore'
    ]
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
    for (const key of ['linkage.bellTitle', 'linkage.deviceAlarmsMore']) {
      const reference = (messageAt('zh-CN', key) as string).match(/\{(\w+)\}/g)?.sort()
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

describe('用词：「平稳度」（业主 2026-09-19 第 4 条）', () => {
  it('四种语言的指标名都是"平稳度"，而且不再叫平滑度', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      const metrics = (CATALOGUES[locale] as { metrics: Record<string, string> }).metrics
      assert.ok(
        typeof metrics.smoothness === 'string' && metrics.smoothness.trim() !== '',
        `${locale} 缺 metrics.smoothness`
      )
    }
    assert.equal(String(messageAt('zh-CN', 'metrics.smoothness')), '平稳度', '中文指标名不是"平稳度"')
    // 告警类型那一条**不动**：它命名的是一种告警条件，不是这个量。
    //（键在 `alarms.type.*` 那一组里，与 `metrics.smoothness` 不是同一个。）
    assert.equal(
      String(messageAt('zh-CN', 'alarms.type.smoothness')),
      '平滑度异常',
      '告警类型那一条被误改了（它命名的是一种条件）'
    )
  })

  it('「没有数据源」那套写法消失，平稳度改经适配层进入实时工作台', () => {
    assert.equal(
      /stabilityNoSourceHint/.test(mapView),
      false,
      '地图页还留着"这一列没有数据源"的说明（业主已澄清取 smoothness）'
    )
    assert.match(mapView, /facts\.latestSmoothness/, '平稳度没有从最近一条告警里取')
    /*
     * 2026-09-20 的实时工作台改造：页面不再自己写一个 `liveSmoothness()` 填表格，
     * 而是把最近一条告警交给 `RealtimeMonitor`，再由适配层把 `smoothness` 归一进
     * `FeatureSource` / `RealtimeFrame`。出处没有变，读数的位置换了。
     */
    assert.equal(
      /function liveSmoothness\(/.test(mapCode),
      false,
      '旧的 liveSmoothness() 还留在页面里（实时表格应该已经换成工作台）'
    )
    assert.match(adaptersCode, /function featureSourceOfAlarm/, '适配层没有告警 -> FeatureSource 的入口')
    assert.match(adaptersCode, /alarm\.smoothness/, '适配层没有取告警的 smoothness')
    assert.match(adaptersCode, /featureMetric\(source, 'smoothness'/, 'FA8 七项特征里没有平稳度')
  })
})