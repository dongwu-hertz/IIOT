/**
 * 告警等级与备注在**界面上**必须成立的三条政策，用源码守卫钉住。
 *
 * 为什么是源码守卫：这一轮真正要防的是「将来某个人顺手加一行 / 漏一行」，
 * 而这几件事都没有便宜的运行时测法（渲染 Vue 页面要拉起 Electron 或一整套 DOM 桩，
 * 本仓库既有的做法就是源码守卫，见 `tests/camera-view-store.test.ts`）：
 *
 *   1. **给 `EventSeverity` 加第五档时，配色类必须跟着加**。等级是靠
 *      `.badge--severity-<level>` 这个**拼出来的类名**上色的，漏一个不会报错、
 *      不会失败，只会让那一档渲染成一个没有背景色的裸徽标——视觉上像是"没有等级"。
 *   2. **筛选器必须真的把 `severity` 发出去**。加了下拉框却忘了写进 query 是这类
 *      筛选器最常见的一处静默失效：选了没反应，看起来像"没有符合条件的记录"。
 *   3. **`saved === false` 必须被说出来**。「写成功但一行都没改到」= 这条告警已经被
 *      保留策略清掉了。把它压成布尔就会让界面把"没保存"显示成"已保存"。
 *
 * 守卫的**边界**（不夸大）：它只证明这些字样存在/不存在，证明不了运行时行为。
 * 等级划分本身由 `tests/alarm-severity.test.ts` 逐条断言。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { EVENT_SEVERITIES } from '../src/shared/domain/event-center'

const view = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/src/views/AlarmsView.vue'),
  'utf8'
)
const store = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/src/stores/alarms.ts'),
  'utf8'
)
const handlers = fs.readFileSync(
  path.join(process.cwd(), 'src/main/ipc/handlers.ts'),
  'utf8'
)

describe('告警等级与备注：界面侧的三条政策', () => {
  it('每一档 EventSeverity 都有自己的配色类，一档都不许漏', () => {
    for (const severity of EVENT_SEVERITIES) {
      assert.ok(
        view.includes(`.badge--severity-${severity}`),
        `缺少 .badge--severity-${severity} 的样式：那一档会渲染成没有背景色的裸徽标`
      )
    }
  })

  it('徽标的类名是**按等级拼出来的**，不是写死几档的 if/else', () => {
    assert.ok(
      view.includes('`badge--severity-${alarm.severity}`'),
      '类名必须由 severity 拼出（写死几档的话，新增一档就会静默漏掉）'
    )
  })

  it('筛选器把 severity 真的写进了 query（否则选了没反应）', () => {
    assert.ok(
      /if \(filters\.severity !== ''\) query\.severity = filters\.severity/.test(view),
      'filters.severity 必须进入 AlarmQuery'
    )
    assert.ok(view.includes("severity: ''"), '筛选初值必须是"全部等级"')
  })

  it('清空筛选时 severity 也回到初值（否则"重置"会留下一半筛选）', () => {
    const reset = /function reset\(\)[\s\S]*?\n}/.exec(view)?.[0] ?? ''
    assert.ok(reset.includes("filters.severity = ''"), 'reset() 必须清掉 severity')
  })

  it('store 的写入方法返回三态，并且不吞掉 saved === false', () => {
    for (const fn of ['setNote', 'setSeverity']) {
      assert.ok(store.includes(`async function ${fn}(`), `store 缺少 ${fn}()`)
    }
    assert.ok(
      store.includes('export type AlarmWriteOutcome'),
      '必须有具名的三态结果类型，否则"没改到任何一行"会被压成布尔'
    )
    assert.ok(
      store.includes('return { ok: true, saved }'),
      '写成功但 saved=false 时也要如实返回，不能一律当成成功'
    )
    assert.ok(
      view.includes("t('alarmsUi.recordMissing')"),
      '界面必须把"这条告警已不在记录中"说出来'
    )
  })

  it('三个新通道都真的被权限守卫拦住（目录里声明过不算数）', () => {
    for (const key of ['ALARM_SET_NOTE', 'ALARM_SET_SEVERITY', 'ALARM_COUNT_BY_SEVERITY']) {
      const start = handlers.indexOf(`IpcChannels.${key}`)
      assert.ok(start >= 0, `handlers.ts 里没有 ${key} 的处理器`)
      const next = handlers.indexOf('ipcMain.handle(', start + 1)
      const block = handlers.slice(start, next === -1 ? handlers.length : next)
      assert.ok(
        block.includes("requirePermission('viewAlarms')"),
        `${key} 的处理器里没有 requirePermission('viewAlarms')`
      )
    }
  })
})
