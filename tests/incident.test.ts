/**
 * Incident 的领域规则（规格 §2.1 / §13.2 / §14.2 的 V1）。
 *
 * WHY THIS FILE EXISTS
 * 这一层里有两处**我们自己的**判据（规格没给数），它们必须能被单独钉住，否则会在某次
 * 顺手改动里悄悄变掉：
 *   1. **草稿校验**：标题必填、长度上限（`INCIDENT_TITLE_MAX_LENGTH` 是我们定的；
 *      规格只写了"人工创建"）。对话框与主进程共用这一个函数 —— 两处各判一次迟早分叉，
 *      而分叉的表现是"界面说可以、点下去被拒绝"。
 *   2. **建议卡的阈值**（`INCIDENT_SUGGESTION_MIN_ALERTS`）：规格 §13.2 说"当相关性达到
 *      阈值时"，**阈值本身手册未说明**。我们取 2，理由写在常量上。
 *
 * 相关分组本身（`relatedGroups()`）在 `tests/event-view.test.ts` 里测；这里只测
 * "从分组到建议"这一步，用的是手工构造的分组（不重复测分组算法）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DEFAULT_INCIDENT_THRESHOLD,
  INCIDENT_NOTE_MAX_LENGTH,
  INCIDENT_THRESHOLD_CHOICES,
  INCIDENT_TITLE_MAX_LENGTH,
  incidentSuggestion,
  incidentSuggestedTitleParams,
  parseIncidentThreshold,
  sortIncidentsDesc,
  validateIncidentDraft
} from '../src/shared/domain/incident'
import type { IncidentView } from '../src/shared/domain/incident'
import type { RelatedGroup } from '../src/shared/domain/event-view'

function groups(sameDevice: string[]): RelatedGroup[] {
  return [
    { id: 'same-device', labelKey: 'eventsUi.relatedSameDevice', ids: sameDevice },
    { id: 'same-kind', labelKey: 'eventsUi.relatedSameKind', ids: [] },
    { id: 'time-window', labelKey: 'eventsUi.relatedTimeWindow', ids: [] }
  ]
}

describe('Incident 草稿校验（对话框与主进程共用一处）', () => {
  it('标题两端空格去掉；没有备注时不带 note 字段', () => {
    const result = validateIncidentDraft({ title: '  1 号风机异常  ' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ok && result.draft, { title: '1 号风机异常' })
  })

  it('备注也去空格；空备注等于没有备注', () => {
    assert.deepEqual(validateIncidentDraft({ title: 'A', note: '  说明  ' }), {
      ok: true,
      draft: { title: 'A', note: '说明' }
    })
    assert.deepEqual(validateIncidentDraft({ title: 'A', note: '   ' }), {
      ok: true,
      draft: { title: 'A' }
    })
  })

  it('空标题 / 非字符串标题一律拒绝（reason = title-required）', () => {
    for (const title of ['', '   ', undefined, null, 42, {}]) {
      const result = validateIncidentDraft({ title })
      assert.equal(result.ok, false)
      assert.equal(result.ok === false && result.reason, 'title-required')
    }
  })

  it('超长标题与超长备注各自有自己的 reason（界面要能分别说）', () => {
    const longTitle = validateIncidentDraft({ title: 'x'.repeat(INCIDENT_TITLE_MAX_LENGTH + 1) })
    assert.equal(longTitle.ok === false && longTitle.reason, 'title-too-long')

    const longNote = validateIncidentDraft({
      title: 'A',
      note: 'y'.repeat(INCIDENT_NOTE_MAX_LENGTH + 1)
    })
    assert.equal(longNote.ok === false && longNote.reason, 'note-too-long')
  })

  it('**恰好**等于上限是合法的（上限是闭区间，不是"小于"）', () => {
    const exactTitle = validateIncidentDraft({ title: 'x'.repeat(INCIDENT_TITLE_MAX_LENGTH) })
    assert.equal(exactTitle.ok, true)
    const exactNote = validateIncidentDraft({
      title: 'A',
      note: 'y'.repeat(INCIDENT_NOTE_MAX_LENGTH)
    })
    assert.equal(exactNote.ok, true)
  })
})

describe('「潜在关联 Incident」建议（规格 §13.2）', () => {
  it('同设备上只有它自己 → 不给建议（一条孤立的告警没什么可建议的）', () => {
    assert.equal(DEFAULT_INCIDENT_THRESHOLD, 2)
    assert.equal(incidentSuggestion({ id: 'alarm:1' }, groups([])), undefined)
  })

  it('同设备上还有一条 → 建议里**含当前这一条**，条数是 2', () => {
    const suggestion = incidentSuggestion({ id: 'alarm:1' }, groups(['alarm:2']))
    assert.ok(suggestion)
    assert.equal(suggestion.groupId, 'same-device')
    assert.deepEqual(suggestion.entryIds, ['alarm:1', 'alarm:2'])
    assert.equal(suggestion.alertCount, 2)
    assert.equal(suggestion.threshold, DEFAULT_INCIDENT_THRESHOLD, '建议里要带上这次用的阈值')
  })

  it('建议只**给初值**：它不改任何东西，entryIds 就是分组里的那几条 + 当前这条', () => {
    const suggestion = incidentSuggestion({ id: 'alarm:9' }, groups(['alarm:8', 'alarm:7']))
    assert.deepEqual(suggestion?.entryIds, ['alarm:9', 'alarm:8', 'alarm:7'])
    assert.equal(suggestion?.alertCount, 3)
  })

  it('没有 same-device 那一组（相关性关闭/数据里没有）→ 不给建议，而不是崩', () => {
    assert.equal(incidentSuggestion({ id: 'alarm:1' }, []), undefined)
    const onlyKind: RelatedGroup[] = [
      { id: 'same-kind', labelKey: 'eventsUi.relatedSameKind', ids: ['alarm:2', 'alarm:3'] }
    ]
    assert.equal(
      incidentSuggestion({ id: 'alarm:1' }, onlyKind),
      undefined,
      '同类型不算"一台设备上的现实问题"，不能拿它当建议依据'
    )
  })
})

/**
 * 阈值是**可调的**（业主 2026-09-18：「可以设置为可调整的」）。
 *
 * 规格 §13.2 只说"当相关性达到阈值时"，**阈值本身手册未说明** —— 所以它是我们的取值，
 * 而且要能被操作员改。这一组钉住三件事：档位是一小组离散值、默认是最小那档、
 * 坏输入一律回落到默认（纯函数不该因为一个参数是 `NaN` 就悄悄改行为）。
 */
describe('建议阈值：可调的离散档位', () => {
  it('档位是离散的、升序、最小档就是默认档', () => {
    assert.deepEqual([...INCIDENT_THRESHOLD_CHOICES], [...INCIDENT_THRESHOLD_CHOICES].sort((a, b) => a - b))
    assert.equal(INCIDENT_THRESHOLD_CHOICES[0], DEFAULT_INCIDENT_THRESHOLD)
    for (const choice of INCIDENT_THRESHOLD_CHOICES) {
      assert.ok(Number.isInteger(choice) && choice >= 2, `档位 ${choice} 不是一个合理的条数`)
    }
  })

  it('同一条数据在阈值 2 下给建议、在阈值 3 下不给（这就是"可调"的意义）', () => {
    const data = groups(['alarm:2'])
    assert.ok(incidentSuggestion({ id: 'alarm:1' }, data, 2), '阈值 2 时应当给建议')
    assert.equal(incidentSuggestion({ id: 'alarm:1' }, data, 3), undefined, '阈值 3 时不该给建议')
  })

  it('阈值恰好等于条数时**给**建议（阈值是闭区间，不是"大于"）', () => {
    const data = groups(['alarm:2', 'alarm:3'])
    assert.ok(incidentSuggestion({ id: 'alarm:1' }, data, 3), '刚好 3 条，阈值 3 应当给建议')
    assert.equal(incidentSuggestion({ id: 'alarm:1' }, data, 5), undefined)
  })

  it('解析磁盘/界面来的值：合法档位原样用，别的（含字符串数字）回落到默认', () => {
    assert.equal(parseIncidentThreshold(2), 2)
    assert.equal(parseIncidentThreshold('5'), 5, '下拉框给的是字符串')
    for (const bad of [undefined, null, '', 'abc', 0, 1, 2.5, 4, 999, -1, {}]) {
      assert.equal(
        parseIncidentThreshold(bad),
        DEFAULT_INCIDENT_THRESHOLD,
        `${String(bad)} 应当回落到默认档`
      )
    }
  })

  it('传进去一个坏阈值也不会让建议"消失或全给"：一律按默认档判', () => {
    const data = groups(['alarm:2'])
    // @ts-expect-error 故意传一个界面不该给的值，验证纯函数自己守得住。
    assert.ok(incidentSuggestion({ id: 'alarm:1' }, data, Number.NaN))
    // 3 条相关告警、坏阈值 → 按默认档 2 判 → 给建议。
    const more = groups(['alarm:2', 'alarm:3'])
    // @ts-expect-error 同上。
    assert.ok(incidentSuggestion({ id: 'alarm:1' }, more, 'x'))
  })
})

describe('建议标题与列表顺序', () => {
  it('标题参数用设备名；设备名是空的时给一个占位（不产生" 异常情况"这种半句）', () => {
    assert.deepEqual(incidentSuggestedTitleParams('  AE08  '), { device: 'AE08' })
    assert.deepEqual(incidentSuggestedTitleParams('   '), { device: '—' })
  })

  it('Incident 列表按创建时间倒序（与 Activity 同一口径）', () => {
    const view = (id: string, createdAt: number): IncidentView => ({
      id,
      title: id,
      createdAt,
      createdBy: 'admin',
      alertCount: 1
    })
    const sorted = sortIncidentsDesc([view('a', 1), view('c', 3), view('b', 2)])
    assert.deepEqual(sorted.map((item) => item.id), ['c', 'b', 'a'])
    // 不改原数组（纯函数）。
    const original = [view('a', 1), view('c', 3)]
    sortIncidentsDesc(original)
    assert.deepEqual(original.map((item) => item.id), ['a', 'c'])
  })
})
