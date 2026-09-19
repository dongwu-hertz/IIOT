/**
 * 每通道声纹特性表里「是否告警」这一列（业主 2026-09-19 第 13 批第 3 条）。
 *
 * WHY THIS FILE EXISTS
 * 这一列最容易做错的地方不是分组，而是**它到底在说什么**：
 *   1. `alarms.query` 返回的是**最近 N 条**（本页取 50），所以这一列是"这批最近记录里
 *      这一路有没有告警"，不是"历史上有没有过"。写成后者就是把采样说成了全部历史。
 *   2. 已经**确认过**的告警算不算"告警"？如果算，操作员刚在告警中心确认完，回到这一页
 *      仍然是满屏红色 —— 两页对同一件事给出两种答案。本仓库的判据是：**红点只由没确认的
 *      决定**，而已确认的仍然留在详情里（`latest` / `count` 照给）。
 *   3. "没有这一路的记录"与"有记录但都是零"必须分开：前者返回 `null`。
 *
 * 所以分组与判据抽成纯函数（`@shared/domain/channel-alarm.ts`），这一份逐条钉死；
 * 顺带对**真实模板**做静态检查（表头六列、行可点、告警格是详情按钮），
 * 因为这一条的界面部分（8 行 × 六列、高度与左邻一致）在无浏览器环境里只能这样验。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  alarmSeverityBadgeClass,
  channelAlarmOf,
  channelIsAlarming,
  groupAlarmsByChannel
} from '../src/shared/domain/channel-alarm'
import type { AlarmEvent } from '../src/shared/domain/models'
import { zhCN } from '../src/shared/i18n/messages/zh-CN'
import { en } from '../src/shared/i18n/messages/en'
import { es } from '../src/shared/i18n/messages/es'
import { tr } from '../src/shared/i18n/messages/tr'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

/**
 * 去注释那一份源码（HTML 注释 / 块注释 / 整行 `//`）。
 *
 * 反向断言（"某个标记还在不在"）必须读它：这一轮的注释里**点名写了被改掉的东西**
 * （"原来在卡片底部，现在缩到第一格里"），第一版就是被自己的注释绊红的（§15.29.5）。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const MONITOR_VIEW = 'src/renderer/src/views/MonitorView.vue'

const CATALOGUES: Record<string, Record<string, unknown>> = {
  'zh-CN': zhCN as unknown as Record<string, unknown>,
  en: en as unknown as Record<string, unknown>,
  es: es as unknown as Record<string, unknown>,
  tr: tr as unknown as Record<string, unknown>
}

function monitorUi(locale: string): Record<string, unknown> {
  return (CATALOGUES[locale] as { monitorUi: Record<string, unknown> }).monitorUi
}

const BASE_TIME = 1_700_000_000_000

function alarm(overrides: Partial<AlarmEvent> & { id: string }): AlarmEvent {
  return {
    deviceId: 'dev-1',
    channelId: 0,
    timestamp: BASE_TIME,
    source: 'fa8',
    alarmMask: 0,
    alarmTypes: [],
    severity: 'unknown',
    acknowledged: false,
    createdAt: BASE_TIME,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. 分组：每一路只留最近一条 + 条数
// ---------------------------------------------------------------------------

describe('按通道分组', () => {
  it('每一路只留**最近**一条，并数出条数', () => {
    const grouped = groupAlarmsByChannel([
      alarm({ id: 'a', channelId: 2, timestamp: BASE_TIME - 5000 }),
      alarm({ id: 'b', channelId: 2, timestamp: BASE_TIME }),
      alarm({ id: 'c', channelId: 5, timestamp: BASE_TIME - 1000 })
    ])

    const two = channelAlarmOf(grouped, 2)
    assert.ok(two)
    assert.equal(two.count, 2)
    assert.equal(two.latest.id, 'b')
    assert.equal(channelAlarmOf(grouped, 5)?.count, 1)
    assert.equal(channelAlarmOf(grouped, 7), null)
  })

  it('顺序由 `timestamp` 决定，不依赖上游的排序', () => {
    // 故意**升序**输入：`alarms.query` 今天给的是倒序，但界面不该依赖它。
    const grouped = groupAlarmsByChannel([
      alarm({ id: 'old', channelId: 1, timestamp: BASE_TIME - 9000 }),
      alarm({ id: 'new', channelId: 1, timestamp: BASE_TIME })
    ])
    assert.equal(channelAlarmOf(grouped, 1)?.latest.id, 'new')
  })

  it('时间完全相同时取输入里靠前的那条（同一输入必得同一结论）', () => {
    const grouped = groupAlarmsByChannel([
      alarm({ id: 'first', channelId: 3, timestamp: BASE_TIME }),
      alarm({ id: 'second', channelId: 3, timestamp: BASE_TIME })
    ])
    assert.equal(channelAlarmOf(grouped, 3)?.latest.id, 'first')
  })

  it('最近一条的等级与确认状态跟着它走，不跟着别的行', () => {
    const grouped = groupAlarmsByChannel([
      alarm({
        id: 'new',
        channelId: 4,
        timestamp: BASE_TIME,
        severity: 'critical',
        acknowledged: false
      }),
      alarm({
        id: 'old',
        channelId: 4,
        timestamp: BASE_TIME - 100,
        severity: 'info',
        acknowledged: true
      })
    ])
    const summary = channelAlarmOf(grouped, 4)
    assert.ok(summary)
    assert.equal(summary.severity, 'critical')
    assert.equal(summary.acknowledged, false)
  })

  it('空输入得到空分组（"没有记录"不是"有记录但都是零"）', () => {
    const grouped = groupAlarmsByChannel([])
    assert.equal(grouped.size, 0)
    assert.equal(channelAlarmOf(grouped, 0), null)
  })
})

// ---------------------------------------------------------------------------
// 2. 判据：红点只由**没确认的**决定
// ---------------------------------------------------------------------------

describe('这一路算不算「告警」', () => {
  it('有未确认的 → 算', () => {
    const grouped = groupAlarmsByChannel([alarm({ id: 'a', channelId: 0 })])
    assert.equal(channelIsAlarming(channelAlarmOf(grouped, 0)), true)
  })

  it('全部已确认 → **不算**（确认过的不再打断人），但小结本身还在', () => {
    const grouped = groupAlarmsByChannel([
      alarm({ id: 'a', channelId: 0, acknowledged: true }),
      alarm({ id: 'b', channelId: 0, timestamp: BASE_TIME + 1000, acknowledged: true })
    ])
    const summary = channelAlarmOf(grouped, 0)
    assert.equal(channelIsAlarming(summary), false)
    // 不红不等于消失：详情里仍然看得到（"已确认"那一档就是照这个给的）。
    assert.equal(summary?.count, 2)
    assert.equal(summary?.unacknowledgedCount, 0)
  })

  it('一条已确认 + 一条未确认 → 算（未确认的还没人处理）', () => {
    const grouped = groupAlarmsByChannel([
      alarm({ id: 'a', channelId: 1, timestamp: BASE_TIME + 1000, acknowledged: true }),
      alarm({ id: 'b', channelId: 1, timestamp: BASE_TIME, acknowledged: false })
    ])
    const summary = channelAlarmOf(grouped, 1)
    assert.equal(summary?.unacknowledgedCount, 1)
    assert.equal(channelIsAlarming(summary), true)
  })

  it('null（这一路没有任何记录）不算告警', () => {
    assert.equal(channelIsAlarming(null), false)
  })

  it('等级 → 徽标类名：critical/warning/info/unknown 四档都有落点', () => {
    assert.equal(alarmSeverityBadgeClass('critical'), 'badge badge--danger')
    assert.equal(alarmSeverityBadgeClass('warning'), 'badge badge--warning')
    assert.equal(alarmSeverityBadgeClass('info'), 'badge badge--accent')
    assert.equal(alarmSeverityBadgeClass('unknown'), 'badge')
  })
})

// ---------------------------------------------------------------------------
// 3. 界面：六列表格 + 行可点 + 告警格是详情入口
// ---------------------------------------------------------------------------

describe('实时监测页的每通道特性表', () => {
  const view = read(MONITOR_VIEW)
  const code = stripComments(view)

  it('是一张表：8 路各一行，行上带通道号的探针标记', () => {
    assert.match(code, /<table class="channel-table" data-channel-feature-table>/)
    assert.match(code, /:data-channel-feature-row="row\.index"/)
    // 数据源仍然是"每一路最后一次读数"，没有新造数据源。
    assert.match(code, /const channelFeatureRows = computed<ChannelFeatureRow\[\]>/)
    assert.match(code, /monitor\.channelFeatureOf\(tab\.index\)/)
  })

  it('表头就是业主要的那六列（通道 + 四项指标 + 告警）', () => {
    const headers = [
      'monitorUi.channelFeatureColumnChannel',
      'metrics.spl',
      'metrics.mainFrequency',
      'metrics.smoothness',
      'monitorUi.channelFeatureColumnAlarm'
    ]
    for (const key of headers) assert.ok(code.includes(`t('${key}')`), `缺少表头 ${key}`)
    // 频带能量比是第五列（`metrics.bandEnergyRatio` 在表头里出现一次）。
    assert.ok(code.includes("t('metrics.bandEnergyRatio')"))
    assert.equal(code.match(/channelFeatureColumnAlarm/g)?.length, 1)
  })

  it('整行可点 = 切这一路通道（三张图跟着走）', () => {
    assert.match(code, /@click="selectChannel\(row\.index\)"/)
    // 第一格是真按钮（键盘可达），与整行点击是同一个 `selectChannel`。
    assert.match(code, /class="channel-table__select"[\s\S]{0,400}@click\.stop="selectChannel\(row\.index\)"/)
  })

  it('告警那一格是详情入口，不会顺手把通道也切了（`.stop`）', () => {
    assert.match(code, /:data-channel-alarm="row\.index"/)
    assert.match(code, /@click\.stop="openChannelAlarmDetail\(row\.index\)"/)
    assert.match(code, /data-channel-alarm-none/)
  })

  it('详情弹窗读的是同一份告警（与那一列同源），并给出等级/类型/确认状态/设备原话', () => {
    assert.match(code, /data-channel-alarm-detail-list/)
    assert.match(code, /alarmSeverityBadgeClass\(alarm\.severity\)/)
    assert.match(code, /alarmTypesText\(alarm\)/)
    assert.match(code, /data-channel-alarm-reason/)
    assert.match(code, /channelAlarmUnacknowledgedState/)
  })

  it('位置：特性表排在频谱卡前面（"挪到当前的频谱卡片的位置"）', () => {
    const table = code.indexOf('data-channel-feature-table')
    const spectrum = code.indexOf("t('monitorUi.spectrumSection')")
    assert.ok(table > 0 && spectrum > 0)
    assert.ok(table < spectrum, '特性表必须排在频谱卡之前')
  })

  it('等高：网格不再 `align-items: start`，表体自己收放', () => {
    const grid = code.slice(code.indexOf('.graph-grid {'))
    const rule = grid.slice(0, grid.indexOf('}'))
    assert.ok(!rule.includes('align-items'), '.graph-grid 不该再写 align-items（用网格默认的 stretch）')
    assert.match(code, /\.channel-features__body \{[\s\S]{0,120}flex: 1/)
  })

  it('旧的"每通道一张小卡"样式全部删掉了（死 CSS 会让下一个人以为那块还在）', () => {
    assert.ok(!code.includes('channel-features__grid'))
    assert.ok(!code.includes('channel-card'))
  })
})

// ---------------------------------------------------------------------------
// 4. 四语言词条
// ---------------------------------------------------------------------------

describe('四语言词条', () => {
  const required = [
    'channelFeatureColumnChannel',
    'channelFeatureColumnAlarm',
    'channelAlarmYes',
    'channelAlarmAcknowledged',
    'channelAlarmNone',
    'channelAlarmOpen',
    'channelAlarmSampleHint',
    'channelAlarmDetailTitle',
    'channelAlarmAcknowledgedState',
    'channelAlarmUnacknowledgedState'
  ]

  it('四本目录都有这十个键，且都是非空字符串', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      for (const key of required) {
        const value = monitorUi(locale)[key]
        assert.equal(typeof value, 'string', `${locale}.monitorUi.${key} 缺失`)
        assert.ok((value as string).length > 0, `${locale}.monitorUi.${key} 是空串`)
      }
    }
  })

  it('采样窗口这件事写进了那句话（`{count}` 必须出现在里面）', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.ok(
        (monitorUi(locale).channelAlarmSampleHint as string).includes('{count}'),
        `${locale} 的 channelAlarmSampleHint 没有说明采样条数`
      )
    }
  })

  it('详情标题带通道插值（否则八路弹窗看起来是同一个）', () => {
    for (const locale of Object.keys(CATALOGUES)) {
      assert.ok(
        (monitorUi(locale).channelAlarmDetailTitle as string).includes('{channel}'),
        `${locale} 的 channelAlarmDetailTitle 没有 {channel}`
      )
    }
  })
})
