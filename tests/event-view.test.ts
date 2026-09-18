/**
 * 事件中心视图模型 / 筛选 / 聚合的纯函数（`src/shared/domain/event-view.ts`）。
 *
 * 为什么这些断言值得写：它们守的是**换算与口径**，而这两样算错了界面上看不出来 ——
 *   1. **等级换算**：我们的四级（`'unknown'` 是合法取值）与规格 §2.3 的五级之间有一个
 *      展示层适配器。哪一个领域取值落到哪一档、`'unknown'` 有没有被偷偷装成 `'info'`，
 *      只能靠断言钉住；Phase 5 做等级迁移时，这个文件就是"改对了没有"的判据。
 *   2. **计数口径**：KPI 与筛选面板算的都是**已加载的这一页**。把「没有确认能力的来源」
 *      算进「未确认」、把「等级未知」混进「提示」，都会让操作员盯着一个永远清不掉的数字。
 *   3. **存取容错**：筛选要从 localStorage 与手改过的 URL 里读回来。坏值必须退回默认，
 *      而不是让页面打不开 —— 这条路径平时不会有人走，所以必须由测试走。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'assert'
import { describe, it } from 'node:test'

import { EVENT_SEVERITIES, EVENT_SOURCE_KINDS } from '../src/shared/domain/event-center'
import type { EventCenterEntry } from '../src/shared/domain/event-center'
import {
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  DETAIL_DRAWER_DEFAULT,
  DETAIL_DRAWER_MAX,
  DETAIL_DRAWER_MIN,
  DETAIL_DRAWER_WIDE_VIEWPORT,
  DRAWER_WIDTH_STORAGE_KEY,
  EMPTY_EVENT_FILTER,
  EVENT_DETAIL_TABS,
  EVENT_SAVED_VIEWS,
  EVENT_SEVERITY_FILTERS,
  EVENT_VIEW_MODES,
  EVENT_ROW_HEIGHT,
  EVENT_FILTER_STORAGE_KEY,
  EVENT_FILTER_QUERY_KEYS,
  EVENT_VIEW_MODE_STORAGE_KEY,
  IMPLEMENTED_DETAIL_TABS,
  RELATED_TIME_WINDOW_MS,
  VISIBLE_ALERT_SEVERITIES,
  ackFilterToQuery,
  activityKindLabelKey,
  activityRows,
  alertMetrics,
  alertOverviewFields,
  alertSeverityLabelKey,
  alertSeverityOf,
  alertStatusLabelKey,
  alertTimeline,
  clampDrawerWidth,
  detailTabLabelKey,
  drawerWidthForViewport,
  eventFilterCounts,
  eventFilterFromQuery,
  eventFilterToQuery,
  eventKpis,
  evidenceImageSource,
  hasEventFilterQuery,
  isEventDetailTab,
  isEventFilterActive,
  isSeverityUnknown,
  matchEventSearch,
  parseDrawerWidth,
  parseEventFilter,
  parseEventViewMode,
  querySeverityFor,
  relatedGroups,
  savedViewFromMs,
  serializeEventFilter,
  severityFilterFor,
  statusActionsFor,
  statusForAction,
  toAlertViewModel,
  toAlertViewModels
} from '../src/shared/domain/event-view'
import type {
  AlertViewModel,
  EventActivityView,
  EventQueueFilter
} from '../src/shared/domain/event-view'

/** 最小可用的事件样本：只给断言用得上的字段，其余按接口要求补默认值。 */
function entry(overrides: Partial<EventCenterEntry> = {}): EventCenterEntry {
  return {
    id: 'alarm:1',
    source: 'localAlarm',
    deviceId: 'dev-1',
    deviceName: '听诊盒子 1',
    at: 1_700_000_000_000,
    atApproximate: false,
    severity: 'warning',
    kind: 'localAlarm',
    acknowledged: false,
    ...overrides
  }
}

function view(overrides: Partial<EventCenterEntry> = {}): AlertViewModel {
  return toAlertViewModel(entry(overrides))
}

describe('等级换算：领域四级 → 规格五级（规格 §2.3）', () => {
  it('四个领域取值都落到规格五级之内（Phase 5 若加取值，这里会先报）', () => {
    for (const severity of EVENT_SEVERITIES) {
      const mapped = alertSeverityOf(severity)
      assert.ok(
        (ALERT_SEVERITIES as readonly string[]).includes(mapped),
        `${severity} 映射出了规格之外的等级 ${mapped}`
      )
    }
  })

  it('逐条对应，且 `unknown` **不**被算成一个等级', () => {
    assert.equal(alertSeverityOf('critical'), 'critical')
    assert.equal(alertSeverityOf('warning'), 'high')
    assert.equal(alertSeverityOf('info'), 'info')
    assert.equal(isSeverityUnknown('unknown'), true)
    assert.equal(isSeverityUnknown('warning'), false)
    // `unknown` 映射到 info 只是为了让色带有个中性色，界面必须靠 `severityUnknown` 说真话。
    assert.equal(alertSeverityOf('unknown'), 'info')
  })

  it('`medium` / `low` 不在"会出现"的等级里（当前没有代码路径能产生它们）', () => {
    assert.deepEqual([...VISIBLE_ALERT_SEVERITIES], ['critical', 'high', 'info'])
    assert.equal(querySeverityFor('medium'), undefined)
    assert.equal(querySeverityFor('low'), undefined)
  })

  it('界面等级 → 查询等级 → 界面等级是**往返一致**的', () => {
    for (const value of EVENT_SEVERITY_FILTERS) {
      const query = querySeverityFor(value)
      assert.notEqual(query, undefined, `${value} 没有对应的查询等级`)
      assert.equal(severityFilterFor(query as never), value, `${value} 往返之后变了`)
    }
    assert.equal(querySeverityFor(''), undefined)
  })

  it('`high` 查的是领域里的 `warning`（设备的非零告警位），不是别的', () => {
    assert.equal(querySeverityFor('high'), 'warning')
    assert.equal(querySeverityFor('critical'), 'critical')
    assert.equal(querySeverityFor('info'), 'info')
    assert.equal(querySeverityFor('unknown'), 'unknown')
  })

  it('等级与状态的标签键都指向 `eventsUi.*`', () => {
    for (const severity of ALERT_SEVERITIES) {
      assert.equal(alertSeverityLabelKey(severity), `eventsUi.alertSeverity.${severity}`)
    }
    for (const status of ALERT_STATUSES) {
      assert.equal(alertStatusLabelKey(status), `eventsUi.alertStatus.${status}`)
    }
  })
})

describe('视图模型：状态、证据摘要、指标', () => {
  it('状态由 `acknowledged` 推出来（Phase 5 才有状态列）', () => {
    assert.equal(view({ acknowledged: false }).status, 'new')
    assert.equal(view({ acknowledged: true }).status, 'acknowledged')
  })

  it('相机检测日志**没有确认能力**：状态锁住，且不计入「未确认」', () => {
    const detect = view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    assert.equal(detect.statusLocked, true)
    assert.equal(detect.status, 'new')
    assert.equal(view({ source: 'linkage', kind: 'linkageAlarm' }).statusLocked, false)
    assert.equal(view({ source: 'localAlarm', kind: 'localAlarm' }).statusLocked, false)
  })

  it('标题键按种类生成（渲染层只查目录，不自己判断）', () => {
    assert.equal(view({ kind: 'deviceDetectAlarm' }).titleKey, 'domain.eventKind.deviceDetectAlarm')
  })

  it('证据摘要：有没有录像 / 抓帧 / 几个结果文件', () => {
    const plain = view()
    assert.equal(plain.hasRecording, false)
    assert.equal(plain.hasFrame, false)
    assert.equal(plain.evidenceFileCount, 0)

    const rich = view({
      source: 'deviceDetect',
      kind: 'deviceDetect',
      severity: 'unknown',
      recordingId: 'rec-1',
      frameRelativePath: 'linkage/frames/a.jpg',
      detect: {
        timeUnit: 'epoch_milliseconds',
        files: [
          { kind: 'power_spectrum_photo', fileName: 'a.jpg', container: 'jpg' },
          { kind: 'soundmap_video', fileName: 'b.mp4', container: 'mp4' }
        ]
      }
    })
    assert.equal(rich.hasRecording, true)
    assert.equal(rich.hasFrame, true)
    assert.equal(rich.evidenceFileCount, 2)
  })

  it('聚合次数在 Phase 6 之前恒为 1（是事实，不是占位符）', () => {
    assert.equal(view().occurrenceCount, 1)
  })

  it('指标：只产出真的存在的字段，**绝不补 0**', () => {
    assert.deepEqual(alertMetrics(entry()), [])
    const metrics = alertMetrics(entry({ metrics: { spl: 61.25 } }))
    assert.equal(metrics.length, 1)
    const [first] = metrics
    assert.ok(first)
    assert.equal(first.field, 'spl')
    assert.equal(first.value, 61.25)
    assert.equal(first.unit, 'dB')
    assert.equal(first.digits, 2)
    assert.equal(first.labelKey, 'metrics.spl')
  })

  it('指标：NaN / Infinity 不算"设备报了这个数"', () => {
    const metrics = alertMetrics(
      entry({ metrics: { spl: Number.NaN, mainFrequency: Number.POSITIVE_INFINITY, smoothness: 0.5 } })
    )
    assert.deepEqual(
      metrics.map((metric) => metric.field),
      ['smoothness']
    )
  })

  it('指标的固定小数位与既有页面一致（同一指标印成同一个样子）', () => {
    const byField = new Map(alertMetrics(
      entry({
        metrics: {
          spl: 1,
          mainFrequency: 2,
          smoothness: 3,
          bandEnergyRatio: 4,
          soundmapIntensity: 5,
          leakVolume: 6,
          leakCost: 7
        }
      })
    ).map((metric) => [metric.field, metric.digits]))
    assert.deepEqual(
      [...byField.entries()],
      [
        ['spl', 2],
        ['mainFrequency', 2],
        ['smoothness', 3],
        ['bandEnergyRatio', 3],
        ['soundmapIntensity', 2],
        ['leakVolume', 3],
        ['leakCost', 3]
      ]
    )
  })

  it('批量换算保持顺序', () => {
    const views = toAlertViewModels([entry({ id: 'a' }), entry({ id: 'b' })])
    assert.deepEqual(
      views.map((item) => item.id),
      ['a', 'b']
    )
  })
})

describe('KPI（规格 §8）', () => {
  it('按等级与"等着人确认"分别计数', () => {
    const kpis = eventKpis([
      view({ id: 'a', severity: 'critical', source: 'linkage', kind: 'linkageAlarm' }),
      view({ id: 'b', severity: 'warning', source: 'linkage', kind: 'linkageAlarm' }),
      view({ id: 'c', severity: 'unknown', source: 'deviceDetect', kind: 'deviceDetect' }),
      view({ id: 'd', severity: 'warning', acknowledged: true })
    ])
    assert.equal(kpis.total, 4)
    assert.equal(kpis.critical, 1)
    assert.equal(kpis.high, 2)
    assert.equal(kpis.unknownSeverity, 1)
    // 只有 a、b 两条是"能确认但还没确认"；c 没有确认接口，d 已经确认。
    assert.equal(kpis.unacknowledged, 2)
  })

  it('没有确认能力的来源不计入「未确认」（否则那个数字永远清不掉）', () => {
    const kpis = eventKpis([
      view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' }),
      view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    ])
    assert.equal(kpis.total, 2)
    assert.equal(kpis.unacknowledged, 0)
  })

  it('平均确认耗时与聚合事件数都是 `null`（来源里没有这两样东西）', () => {
    const kpis = eventKpis([view()])
    assert.equal(kpis.avgAckMs, null)
    assert.equal(kpis.incidents, null)
  })

  it('空列表给出全 0（界面据此显示 0 而不是"—"）', () => {
    const kpis = eventKpis([])
    assert.equal(kpis.total, 0)
    assert.equal(kpis.critical, 0)
    assert.equal(kpis.high, 0)
    assert.equal(kpis.unknownSeverity, 0)
    assert.equal(kpis.unacknowledged, 0)
  })
})

describe('筛选：激活判定与查询换算', () => {
  it('空筛选不算激活；只打空格也不算；时间、来源、确认状态都算', () => {
    assert.equal(isEventFilterActive(EMPTY_EVENT_FILTER), false)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, search: '   ' }), false)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, search: 'x' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, deviceId: 'dev-1' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, source: 'linkage' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, severity: 'high' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, from: '2026-09-17T00:00' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, to: '2026-09-17T00:00' }), true)
    assert.equal(isEventFilterActive({ ...EMPTY_EVENT_FILTER, ack: 'unacknowledged' }), true)
  })

  it('确认状态换算成查询里的布尔（`all` → 不带这个参数）', () => {
    assert.equal(ackFilterToQuery('all'), undefined)
    assert.equal(ackFilterToQuery('unacknowledged'), false)
    assert.equal(ackFilterToQuery('acknowledged'), true)
  })

  it('关键字匹配：设备名、事件标题、标识、指标值都能搜到', () => {
    const alert = view({ deviceName: 'AE08 北侧', metrics: { spl: 61.25 } })
    assert.equal(matchEventSearch(alert, '', '声纹告警'), true)
    assert.equal(matchEventSearch(alert, '   ', '声纹告警'), true)
    assert.equal(matchEventSearch(alert, 'ae08', '声纹告警'), true)
    assert.equal(matchEventSearch(alert, '北侧', '声纹告警'), true)
    assert.equal(matchEventSearch(alert, '声纹告警', '声纹告警'), true)
    assert.equal(matchEventSearch(alert, '61.25', ''), true)
    assert.equal(matchEventSearch(alert, '不存在的词', '声纹告警'), false)
  })

  it('事件标题由调用方查好目录再传进来（本模块不认识 i18n）', () => {
    const alert = view({ deviceName: 'AE08', kind: 'localAlarm' })
    // 调用方没给标题文本时，标题搜不到 —— 这不是 bug，是"标题不在这个模型里"。
    assert.equal(matchEventSearch(alert, '声纹告警', ''), false)
    assert.equal(matchEventSearch(alert, '声纹告警', '声纹告警'), true)
  })

  it('关键字匹配区分"没搜到"与"事件没有这个字段"', () => {
    const bare = view()
    assert.equal(matchEventSearch(bare, 'spl', '声纹告警'), false)
    assert.equal(matchEventSearch(bare, 'alarm:1', '声纹告警'), true)
  })
})

describe('筛选面板计数（口径：已加载的这一页）', () => {
  it('等级分布里**不含**"等级未知"，它单独一档', () => {
    const counts = eventFilterCounts([
      view({ severity: 'critical', source: 'linkage', kind: 'linkageAlarm' }),
      view({ severity: 'warning' }),
      view({ severity: 'unknown', source: 'deviceDetect', kind: 'deviceDetect' })
    ])
    assert.equal(counts.bySeverity.critical, 1)
    assert.equal(counts.bySeverity.high, 1)
    assert.equal(counts.bySeverity.info, 0)
    assert.equal(counts.bySeverity.medium, 0)
    assert.equal(counts.bySeverity.low, 0)
    assert.equal(counts.unknownSeverity, 1)
  })

  it('三路来源都有键（某一路为 0 也要能显示"读到了 0 条"）', () => {
    const counts = eventFilterCounts([view({ source: 'linkage', kind: 'linkageAlarm' })])
    assert.deepEqual(Object.keys(counts.bySource).sort(), [...EVENT_SOURCE_KINDS].sort())
    assert.equal(counts.bySource.linkage, 1)
    assert.equal(counts.bySource.deviceDetect, 0)
    assert.equal(counts.bySource.localAlarm, 0)
  })

  it('确认状态的分组计数与 KPI 同一口径（相机检测日志不算"未确认"）', () => {
    const counts = eventFilterCounts([
      view({ id: 'a', acknowledged: true }),
      view({ id: 'b' }),
      view({ id: 'c', source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    ])
    assert.equal(counts.acknowledged, 1)
    assert.equal(counts.unacknowledged, 1)
  })

  it('按设备的计数只包含**这一页里出现过的**设备（没出现的按 0 显示，不是"不存在"）', () => {
    const counts = eventFilterCounts([
      view({ id: 'a', deviceId: 'dev-1' }),
      view({ id: 'b', deviceId: 'dev-1' }),
      view({ id: 'c', deviceId: 'dev-2' })
    ])
    assert.equal(counts.byDevice['dev-1'], 2)
    assert.equal(counts.byDevice['dev-2'], 1)
    assert.equal(counts.byDevice['dev-3'] ?? 0, 0)
  })
})

describe('存取与容错（localStorage / URL）', () => {
  const filter: EventQueueFilter = {
    search: '声纹',
    deviceId: 'dev-1',
    source: 'localAlarm',
    severity: 'high',
    from: '2026-09-17T08:00',
    to: '2026-09-17T18:00',
    ack: 'unacknowledged'
  }

  it('序列化 → 反序列化是往返一致的', () => {
    assert.deepEqual(parseEventFilter(serializeEventFilter(filter)), filter)
  })

  it('坏 JSON / 非对象 / 空串都退回默认，不抛错', () => {
    for (const raw of ['', '   ', '{不是 JSON', '[]', '42', 'null', '"字符串"']) {
      assert.deepEqual(parseEventFilter(raw), EMPTY_EVENT_FILTER, `坏值 ${raw} 没有退回默认`)
    }
    assert.deepEqual(parseEventFilter(undefined), EMPTY_EVENT_FILTER)
  })

  it('逐字段收窄：认不出的来源 / 等级 / 确认状态退回默认', () => {
    const parsed = parseEventFilter({
      search: 'x',
      deviceId: 'dev-2',
      source: '声纹设备',
      severity: 'medium',
      from: '',
      to: '',
      ack: 'yes'
    })
    assert.equal(parsed.search, 'x')
    assert.equal(parsed.deviceId, 'dev-2')
    assert.equal(parsed.source, '')
    assert.equal(parsed.severity, '')
    assert.equal(parsed.ack, 'all')
  })

  it('能认的来源与等级被保留', () => {
    for (const source of EVENT_SOURCE_KINDS) {
      assert.equal(parseEventFilter({ source }).source, source)
    }
    for (const severity of EVENT_SEVERITY_FILTERS) {
      assert.equal(parseEventFilter({ severity }).severity, severity)
    }
  })

  it('进 URL 只写非默认字段，且能原样读回来', () => {
    const query = eventFilterToQuery(filter)
    assert.deepEqual(Object.keys(query).sort(), [
      'ack',
      'device',
      'from',
      'search',
      'severity',
      'source',
      'to'
    ])
    assert.deepEqual(eventFilterToQuery(EMPTY_EVENT_FILTER), {})
    assert.deepEqual(eventFilterFromQuery(query), filter)
  })

  it('URL 里的未知键忽略，坏值退回默认（手改地址栏不会把页面弄坏）', () => {
    const parsed = eventFilterFromQuery({
      search: 'x',
      severity: 'critical',
      source: 'nope',
      ack: 'maybe',
      page: '3'
    })
    assert.equal(parsed.search, 'x')
    assert.equal(parsed.severity, 'critical')
    assert.equal(parsed.source, '')
    assert.equal(parsed.ack, 'all')
    assert.deepEqual(eventFilterFromQuery(null), EMPTY_EVENT_FILTER)
  })

  it('区分「地址里没写筛选」与「地址里写了空筛选」（否则清空后刷新会被旧条件顶回来）', () => {
    assert.equal(hasEventFilterQuery({}), false)
    assert.equal(hasEventFilterQuery(null), false)
    assert.equal(hasEventFilterQuery({ search: '' }), false)
    assert.equal(hasEventFilterQuery({ page: '3' }), false)
    assert.equal(hasEventFilterQuery({ search: 'x' }), true)
    assert.equal(hasEventFilterQuery({ severity: 'high' }), true)
    assert.equal(hasEventFilterQuery({ search: ['a'] }), true)
    assert.equal(hasEventFilterQuery({ search: [] }), false)
    // 写出去的那套键名与"认哪些键"必须对得上。
    for (const key of Object.keys(eventFilterToQuery(filter))) {
      assert.ok(EVENT_FILTER_QUERY_KEYS.includes(key), `${key} 不在 URL 键白名单里`)
    }
  })

  it('视图偏好：容错到 `standard`，三个模式的行高符合规格', () => {
    assert.equal(parseEventViewMode('compact'), 'compact')
    assert.equal(parseEventViewMode('evidence'), 'evidence')
    assert.equal(parseEventViewMode('标准'), 'standard')
    assert.equal(parseEventViewMode(undefined), 'standard')
    assert.deepEqual([...EVENT_VIEW_MODES], ['compact', 'standard', 'evidence'])
    assert.equal(EVENT_ROW_HEIGHT.standard, 88)
    assert.equal(EVENT_ROW_HEIGHT.evidence, 104)
    assert.ok(EVENT_ROW_HEIGHT.compact < EVENT_ROW_HEIGHT.standard)
  })

  it('两个 localStorage 键带 `hertzinno.` 前缀（与侧栏折叠同一套命名）', () => {
    assert.equal(EVENT_FILTER_STORAGE_KEY, 'hertzinno.eventCenter.filters')
    assert.equal(EVENT_VIEW_MODE_STORAGE_KEY, 'hertzinno.eventCenter.viewMode')
  })
})

describe('内置视图（规格 §9.4）', () => {
  it('id 唯一、标签键都在 `eventsUi.savedView.*` 下', () => {
    const ids = EVENT_SAVED_VIEWS.map((view) => view.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const view of EVENT_SAVED_VIEWS) {
      assert.ok(view.labelKey.startsWith('eventsUi.savedView.'), `${view.id} 的标签键不对`)
    }
  })

  it('视图里的等级都是界面上真的能选的那些', () => {
    for (const view of EVENT_SAVED_VIEWS) {
      if (view.severity === undefined) continue
      assert.ok(
        (EVENT_SEVERITY_FILTERS as readonly string[]).includes(view.severity),
        `${view.id} 的等级 ${view.severity} 不在筛选取值里`
      )
      assert.notEqual(querySeverityFor(view.severity), undefined)
    }
  })

  it('时间窗口是从"现在"往前推的毫秒数（不掺时区）', () => {
    const now = 1_700_000_000_000
    const day = EVENT_SAVED_VIEWS.find((view) => view.id === 'last24h')
    const week = EVENT_SAVED_VIEWS.find((view) => view.id === 'last7d')
    assert.ok(day)
    assert.ok(week)
    assert.equal(savedViewFromMs(day, now), now - 24 * 3_600_000)
    assert.equal(savedViewFromMs(week, now), now - 7 * 24 * 3_600_000)
    const plain = EVENT_SAVED_VIEWS[0]
    assert.ok(plain)
    assert.equal(savedViewFromMs(plain, now), undefined)
  })
})

describe('详情抽屉（规格 §11）', () => {
  it('页签条列的是**已经做出来**的页签（Phase 5 起是五个）', () => {
    assert.deepEqual(
      [...IMPLEMENTED_DETAIL_TABS],
      ['overview', 'evidence', 'timeline', 'related', 'activity']
    )
    for (const tab of IMPLEMENTED_DETAIL_TABS) {
      assert.ok((EVENT_DETAIL_TABS as readonly string[]).includes(tab), `${tab} 不在规格的五个页签里`)
    }
    assert.deepEqual(
      [...EVENT_DETAIL_TABS],
      ['overview', 'evidence', 'timeline', 'related', 'activity']
    )
    assert.equal(detailTabLabelKey('evidence'), 'eventsUi.detailTab.evidence')
    assert.equal(isEventDetailTab('overview'), true)
    assert.equal(isEventDetailTab('Overview'), false)
  })

  it('抽屉宽度：400–560 之间的取值被夹住，坏值退回默认（不许变成 12px 或半屏）', () => {
    assert.equal(clampDrawerWidth(300), DETAIL_DRAWER_MIN)
    assert.equal(clampDrawerWidth(900), DETAIL_DRAWER_MAX)
    assert.equal(clampDrawerWidth(487.6), 488)
    assert.equal(clampDrawerWidth(Number.NaN), DETAIL_DRAWER_DEFAULT)
    assert.equal(parseDrawerWidth('520'), 520)
    assert.equal(parseDrawerWidth('  480  '), 480)
    assert.equal(parseDrawerWidth(505), 505)
    assert.equal(parseDrawerWidth('abc'), DETAIL_DRAWER_DEFAULT)
    assert.equal(parseDrawerWidth(''), DETAIL_DRAWER_DEFAULT)
    assert.equal(parseDrawerWidth(null), DETAIL_DRAWER_DEFAULT)
    assert.equal(parseDrawerWidth('900'), DETAIL_DRAWER_MAX)
    assert.equal(parseDrawerWidth('100'), DETAIL_DRAWER_MIN)
    // 存坏了也不许把抽屉顶到窗口外面：默认值本身也要被夹一遍。
    assert.equal(parseDrawerWidth(null, 999), DETAIL_DRAWER_MAX)
  })

  it('大屏默认 440、普通屏默认 400（规格 §11.1），断点与 §4.1 的内边距同一条线', () => {
    assert.equal(drawerWidthForViewport(1440), 400)
    assert.equal(drawerWidthForViewport(DETAIL_DRAWER_WIDE_VIEWPORT - 1), 400)
    assert.equal(drawerWidthForViewport(DETAIL_DRAWER_WIDE_VIEWPORT), 440)
    assert.equal(drawerWidthForViewport(1920), 440)
    assert.ok(DETAIL_DRAWER_MIN < DETAIL_DRAWER_MAX)
    assert.equal(DRAWER_WIDTH_STORAGE_KEY, 'hertzinno.eventCenter.drawerWidth')
  })

  it('视图模型带上规格 §16.2 的三个聚合字段（Phase 6 只改适配器）', () => {
    const alert = view({ at: 1_700_000_000_000 })
    assert.equal(alert.firstDetectedAt, 1_700_000_000_000)
    assert.equal(alert.lastDetectedAt, 1_700_000_000_000)
    assert.equal(alert.durationMs, 0)
    assert.equal(alert.occurrenceCount, 1)
  })
})

describe('Overview 字段（规格 §11.4）', () => {
  it('只列我们真的有数据的字段：没有 AI 置信度、没有资产（那是别人的模型）', () => {
    const fields = alertOverviewFields(view())
    const labels = fields.map((field) => field.labelKey)
    assert.ok(labels.includes('eventsUi.detailSeverity'), '没有等级')
    assert.ok(labels.includes('eventsUi.overviewStatus'), '没有状态')
    assert.ok(labels.includes('eventsUi.overviewFirstDetected'), '没有首次探测时间')
    assert.ok(labels.includes('eventsUi.overviewLastDetected'), '没有最后探测时间')
    assert.ok(labels.includes('eventsUi.overviewDuration'), '没有持续时长')
    assert.ok(labels.includes('eventsUi.overviewOccurrences'), '没有次数')
    assert.equal(
      labels.some((label) => /confidence|aiConfidence/i.test(label)),
      false,
      '出现了我们拿不到的 AI 置信度字段'
    )
    assert.equal(labels.some((label) => /asset/i.test(label)), false, '出现了我们不存在的资产字段')
  })

  it('持续时长在聚合之前是「—」而不是 0 秒（0 秒会被读成"持续了 0 秒"）', () => {
    const fields = alertOverviewFields(view())
    const duration = fields.find((field) => field.labelKey === 'eventsUi.overviewDuration')
    assert.ok(duration)
    assert.deepEqual(duration.value, { kind: 'empty' })
  })

  it('没有确认能力的来源，状态是「—」而不是一个点不掉的「待处理」', () => {
    const detect = alertOverviewFields(
      view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    )
    const status = detect.find((field) => field.labelKey === 'eventsUi.overviewStatus')
    assert.ok(status)
    assert.deepEqual(status.value, { kind: 'empty' })
    const linkage = alertOverviewFields(view({ source: 'linkage', kind: 'linkageAlarm' }))
    const linkageStatus = linkage.find((field) => field.labelKey === 'eventsUi.overviewStatus')
    assert.ok(linkageStatus)
    assert.equal(linkageStatus.value.kind, 'label')
  })

  it('等级未知走「等级未知」这一档，不是「提示」', () => {
    const fields = alertOverviewFields(
      view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    )
    const severity = fields.find((field) => field.labelKey === 'eventsUi.detailSeverity')
    assert.ok(severity)
    assert.deepEqual(severity.value, {
      kind: 'label',
      labelKey: 'eventsUi.severityUnknown',
      unknown: true
    })
  })

  it('事件标识是长字段（跨两列），设备名是普通字段', () => {
    const fields = alertOverviewFields(view({ id: 'linkage:abc' }))
    const id = fields.find((field) => field.labelKey === 'eventsUi.detailEventId')
    assert.ok(id)
    assert.equal(id.wide, true)
    assert.deepEqual(id.value, { kind: 'text', text: 'linkage:abc', mono: true })
  })

  it('指标按各自的单位与小数位出现在字段里', () => {
    const fields = alertOverviewFields(view({ metrics: { spl: 61.25, leakCost: 3.5 } }))
    const spl = fields.find((field) => field.labelKey === 'metrics.spl')
    assert.ok(spl)
    assert.deepEqual(spl.value, { kind: 'number', value: 61.25, digits: 2, unit: 'dB' })
    const cost = fields.find((field) => field.labelKey === 'eventsUi.metricLeakCost')
    assert.ok(cost)
    assert.deepEqual(cost.value, { kind: 'number', value: 3.5, digits: 3, unit: '' })
  })

  it('设备回的原始等级只有真的回过才出现（未换算，是一条证据）', () => {
    const without = alertOverviewFields(view())
    assert.equal(without.some((field) => field.labelKey === 'eventsUi.detailAlarmLevel'), false)
    const withRaw = alertOverviewFields(view({ alarmLevelRaw: 3 }))
    const raw = withRaw.find((field) => field.labelKey === 'eventsUi.detailAlarmLevel')
    assert.ok(raw)
    assert.deepEqual(raw.value, { kind: 'number', value: 3, digits: 0, unit: '' })
  })
})

describe('Evidence 的图片从哪来（规格 §12.1）', () => {
  it('联动告警用抓帧的相对路径（要走新的回环图片接口）', () => {
    const alert = view({
      source: 'linkage',
      kind: 'linkageAlarm',
      frameRelativePath: 'linkage/frames/2026-09-17/a.jpg'
    })
    assert.deepEqual(evidenceImageSource(alert), {
      kind: 'frame',
      relativePath: 'linkage/frames/2026-09-17/a.jpg'
    })
  })

  it('声纹告警用**已有**的抓图接口（告警 id 从条目 id 里取），不重复造一个', () => {
    const alert = view({ id: 'alarm:alm_123', source: 'localAlarm', kind: 'localAlarm' })
    assert.deepEqual(evidenceImageSource(alert), { kind: 'alarm-snapshot', alarmId: 'alm_123' })
    // 机型已知且**不是**听诊盒子那一族时，这台设备根本没有抓图：返回 null（说"没有图片证据"），
    // 而不是去问一个不存在的接口、再在界面上报一句假故障。
    assert.equal(evidenceImageSource(alert, 'acousticBox'), null)
    assert.deepEqual(evidenceImageSource(alert, 'auscultationBox'), {
      kind: 'alarm-snapshot',
      alarmId: 'alm_123'
    })
  })

  it('相机检测日志没有"一张图"这条路：图是设备侧文件，要先下载到本机', () => {
    const alert = view({ source: 'deviceDetect', kind: 'deviceDetect', severity: 'unknown' })
    assert.equal(evidenceImageSource(alert), null)
  })

  it('联动告警没抓到帧时返回 null（界面显示"没有图片证据"，不画空框）', () => {
    assert.equal(evidenceImageSource(view({ source: 'linkage', kind: 'linkageAlarm' })), null)
    assert.equal(
      evidenceImageSource(
        view({ source: 'linkage', kind: 'linkageAlarm', frameRelativePath: '   ' })
      ),
      null
    )
  })
})

describe('状态机与处置动作（规格 §2.2 / §11.2）', () => {
  it('每个状态都能说出「现在能做什么」，且只有一个主 CTA', () => {
    for (const status of ALERT_STATUSES) {
      const actions = statusActionsFor(status)
      assert.ok(actions.length > 0, `${status} 下一个动作都没有（界面会变成一个死结）`)
      const primaries = actions.filter((action) => action.primary === true)
      assert.equal(primaries.length, 1, `${status} 的主 CTA 不是恰好一个：${primaries.length}`)
    }
  })

  it('`new`：主 CTA 是确认，另外还能直接开始调查或静默', () => {
    const actions = statusActionsFor('new')
    const primary = actions.find((action) => action.primary)
    assert.equal(primary?.id, 'acknowledge')
    assert.equal(primary?.to, 'acknowledged')
    assert.deepEqual(
      actions.map((action) => action.id).sort(),
      ['acknowledge', 'investigate', 'mute']
    )
  })

  it('没有确认能力的来源（相机检测日志）里**不出现**「确认」这个动作', () => {
    const actions = statusActionsFor('new', { locked: true })
    assert.equal(actions.some((action) => action.id === 'acknowledge'), false, '画了一个点不动的确认')
    assert.equal(actions.find((action) => action.primary)?.id, 'investigate')
  })

  it('静默中：主 CTA 是「取消静默」，其余迁移照旧可选', () => {
    const actions = statusActionsFor('muted')
    const primary = actions.find((action) => action.primary)
    assert.equal(primary?.id, 'unmute')
    assert.equal(primary?.to, 'acknowledged')
    assert.ok(actions.some((action) => action.to === 'investigating'))
    /*
     * `muted → new` 在状态表里是允许的（取消静默后回到"谁都没动过"），但**不作为按钮出现**：
     * 两个都叫「取消静默」、只有落点不同的按钮没人分得清。这条迁移留给程序化调用。
     */
    assert.equal(
      actions.some((action) => action.to === 'new'),
      false,
      '界面上出现了两个「取消静默」'
    )
    assert.equal(
      actions.filter((action) => action.id === 'unmute').length,
      1,
      '「取消静默」出现了不止一次'
    )
  })

  it('已关闭：只能重新开启，而且**必须**填原因（规格 §2.2）', () => {
    const actions = statusActionsFor('closed')
    assert.deepEqual(
      actions.map((action) => action.id),
      ['reopen']
    )
    assert.equal(actions[0]?.requiresNote, true)
    assert.equal(actions[0]?.primary, true)
  })

  it('有可指派的账户时才给「指派」，且它不是主 CTA', () => {
    const without = statusActionsFor('new')
    assert.equal(without.some((action) => action.id === 'assign'), false)
    const withAssign = statusActionsFor('new', { canAssign: true })
    const assign = withAssign.find((action) => action.id === 'assign')
    assert.ok(assign)
    assert.equal(assign.primary, undefined)
    assert.equal(assign.to, undefined, '指派不该改状态')
  })

  it('动作 → 目标状态是一处定义（主进程与界面共用它）', () => {
    assert.equal(statusForAction('acknowledge'), 'acknowledged')
    assert.equal(statusForAction('investigate'), 'investigating')
    assert.equal(statusForAction('resolve'), 'resolved')
    assert.equal(statusForAction('close'), 'closed')
    assert.equal(statusForAction('reopen'), 'reopened')
    assert.equal(statusForAction('mute'), 'muted')
    assert.equal(statusForAction('unmute'), 'acknowledged')
    assert.equal(statusForAction('assign'), undefined)
  })

  it('两个新状态也有标签键（少一个名字，界面就会印出裸 key）', () => {
    assert.equal(alertStatusLabelKey('muted'), 'eventsUi.alertStatus.muted')
    assert.equal(alertStatusLabelKey('reopened'), 'eventsUi.alertStatus.reopened')
    assert.equal(activityKindLabelKey('assign'), 'eventsUi.activityKind.assign')
  })
})

describe('Activity / Timeline（规格 §13.3 / §13.1）', () => {
  const activity = (overrides: Partial<EventActivityView>): EventActivityView => ({
    id: overrides.id ?? 'act-1',
    entryId: 'alarm:1',
    at: overrides.at ?? 1_000,
    actor: 'admin',
    kind: overrides.kind ?? 'status',
    ...overrides
  })

  it('三种记录各自成行，**新的在前**', () => {
    const rows = activityRows([
      activity({ id: 'a', kind: 'status', at: 100, fromStatus: 'new', toStatus: 'acknowledged' }),
      activity({ id: 'b', kind: 'assign', at: 300, assignee: 'zhang' }),
      activity({ id: 'c', kind: 'note', at: 200, note: '现场已看' })
    ])
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['assign', 'note', 'status']
    )
    assert.deepEqual(rows.map((row) => row.at), [300, 200, 100])
  })

  it('坏记录**不产出行**（宁可少一行，也不在时间线上印一个空的"→"）', () => {
    const rows = activityRows([
      // 状态字符串坏了。
      activity({ id: 'a', kind: 'status', fromStatus: 'nope' as never, toStatus: 'acknowledged' }),
      // 指派没给账户名。
      activity({ id: 'b', kind: 'assign', assignee: '   ' }),
      // 留言是空的。
      activity({ id: 'c', kind: 'note', note: '   ' }),
      // kind 不认识。
      activity({ id: 'd', kind: 'approve' as never }),
      // 一条好的。
      activity({ id: 'e', kind: 'status', fromStatus: 'new', toStatus: 'resolved' })
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'status')
  })

  it('时间线：从"首次探测到"开始，Activity 与联动动作混在同一条线上（早的在前）', () => {
    const alert = view({ at: 1_000 })
    const nodes = alertTimeline(
      alert,
      [
        activity({ id: 'a', kind: 'status', at: 2_000, fromStatus: 'new', toStatus: 'acknowledged' })
      ],
      [{ at: 1_500, action: 'record', status: 'failed', reason: '磁盘满' }]
    )
    assert.deepEqual(
      nodes.map((node) => node.kind),
      ['detected', 'linkage-action', 'status']
    )
    assert.equal(nodes[0]?.at, 1_000)
    const linkageNode = nodes[1]
    assert.equal(linkageNode?.kind === 'linkage-action' && linkageNode.reason, '磁盘满')
  })

  it('时间线只有探测那一个节点时也不报错（新事件的常态）', () => {
    const nodes = alertTimeline(view({ at: 5_000 }), [])
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.kind, 'detected')
    assert.equal(nodes[0]?.kind === 'detected' && nodes[0].approximate, false)
  })
})

describe('Related 分组（规格 §13.2）', () => {
  const deviceA = view({ id: 'a', deviceId: 'dev-1', kind: 'localAlarm', at: 10_000 })
  const sameDevice = view({ id: 'b', deviceId: 'dev-1', kind: 'deviceDetect', at: 10_000 })
  const sameKind = view({ id: 'c', deviceId: 'dev-2', kind: 'localAlarm', at: 11_000 })
  const nearby = view({ id: 'd', deviceId: 'dev-3', kind: 'linkageAlarm', at: 10_000 + 60_000 })
  const far = view({ id: 'e', deviceId: 'dev-4', kind: 'linkageAlarm', at: 10_000 + 20 * 60_000 })

  it('三组：同设备 / 同种类 / 前后 10 分钟，且都不含自己', () => {
    const groups = relatedGroups(deviceA, [deviceA, sameDevice, sameKind, nearby, far])
    const byId = new Map(groups.map((group) => [group.id, group]))
    assert.deepEqual(byId.get('same-device')?.ids, ['b'])
    assert.deepEqual(byId.get('same-kind')?.ids, ['c'])
    assert.deepEqual(byId.get('time-window')?.ids, ['b', 'c', 'd'])
    for (const group of groups) {
      assert.equal(group.ids.includes('a'), false, '相关性分组把自己算进去了')
    }
  })

  it('时间窗口是**闭区间**：正好 10 分钟算相关，超过就不算', () => {
    const exactly = view({ id: 'f', at: 10_000 + RELATED_TIME_WINDOW_MS })
    const oneMore = view({ id: 'g', at: 10_000 + RELATED_TIME_WINDOW_MS + 1 })
    const groups = relatedGroups(deviceA, [exactly, oneMore])
    const window = groups.find((group) => group.id === 'time-window')
    assert.deepEqual(window?.ids, ['f'])
  })

  it('只有这一条事件时三组都是空的（界面据此说"没有相关的其它事件"）', () => {
    const groups = relatedGroups(deviceA, [deviceA])
    assert.equal(groups.length, 3)
    for (const group of groups) assert.deepEqual(group.ids, [])
  })

  it('分组带标签键（渲染层用它翻译，不自己拼文案）', () => {
    for (const group of relatedGroups(deviceA, [])) {
      assert.match(group.labelKey, /^eventsUi\.related/, `${group.id} 的标签键不对`)
    }
  })
})
