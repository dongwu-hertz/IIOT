/**
 * 「告警记录 → 一键跳到本机录像」（工作流 ④）的接线守卫。
 *
 * 这一轮的实现横跨四处，而每一处都能"写对了但没接上"：
 *   1. `PlaybackData.startTimeMs` —— 没有它就算不出告警时刻落在片段里的第几毫秒；
 *   2. `RecordingPlayer` 的 `anchorAtMs` / `anchorLeadMs` —— 传了没人用等于没传；
 *   3. `anchorSeek()` 的**差额**——请求 30 秒而只拿到 10 秒时必须说出来；
 *   4. `AlarmsView` 真的把锚点传了下去、且回退量就是手册那个 30 秒。
 *
 * 为什么是源码守卫：抽屉只有在**有告警行**时才渲染，而 GUI 探针用的一次性 profile 里
 * 一条告警也没有（这正是上一轮给探针加 `alarms controls` 的原因）。跳转的**算法**由
 * `tests/playback-timeline.test.ts` 的 `anchorSeek()` 逐条断言（含差额），这里只证明
 * 它被接上了、而且没有第二处自己算的副本。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const player = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/src/components/RecordingPlayer.vue'),
  'utf8'
)
const view = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/src/views/AlarmsView.vue'),
  'utf8'
)
const contract = fs.readFileSync(
  path.join(process.cwd(), 'src/shared/ipc/contract.ts'),
  'utf8'
)
const service = fs.readFileSync(
  path.join(process.cwd(), 'src/main/services/audio/playback-service.ts'),
  'utf8'
)

describe('告警 → 本机录像：跳转接线', () => {
  it('片段带绝对起点，主进程真的填了它', () => {
    assert.ok(
      /startTimeMs:\s*number/.test(contract),
      'PlaybackData 必须带 startTimeMs，否则算不出"告警在片段里的位置"'
    )
    assert.ok(
      /startTimeMs:\s*recording\.startTime/.test(service),
      'playback-service 必须填 startTimeMs（用录音行自己的 start_time）'
    )
  })

  it('播放器暴露锚点两个 prop，并且都有缺省值（录音页不需要它们）', () => {
    assert.ok(/anchorAtMs\?:\s*number \| null/.test(player), '缺 anchorAtMs prop')
    assert.ok(/anchorLeadMs\?:\s*number/.test(player), '缺 anchorLeadMs prop')
    assert.ok(
      /anchorAtMs:\s*null,\s*anchorLeadMs:\s*0/.test(player),
      '两个 prop 必须有缺省（默认从头播，不影响录音文件页）'
    )
  })

  it('跳转位置由纯函数算，组件里没有第二份算术', () => {
    assert.ok(
      player.includes("from '@renderer/lib/playbackTimeline'") && player.includes('anchorSeek('),
      '播放器必须调用 anchorSeek()'
    )
    // 自己算一遍就会与纯函数分叉：这里禁掉那种写法。
    assert.ok(
      !/Math\.min\(wantedMs/.test(player),
      '组件里不该再有第二份夹取算术（它属于 anchorSeek()）'
    )
  })

  it('请求没被满足时**说出来**，而不是静默夹到片段开头', () => {
    assert.ok(player.includes('seek.shortfallMs'), '必须检查差额')
    assert.ok(player.includes("t('playerUi.leadShort'"), '必须把差额渲染出来')
    assert.ok(
      /ANCHOR_SHORTFALL_TOLERANCE_MS/.test(player),
      '要有显示取整的容差，否则"请求 30 / 实际 30"会自相矛盾'
    )
    // 提示必须在界面上有落点，而不是只算不用。
    assert.ok(/v-if="!loading && leadShort"/.test(player), 'leadShort 必须渲染出来')
  })

  it('告警详情把告警时刻当锚点、回退量就是手册的 30 秒', () => {
    assert.ok(
      /const ALARM_JUMP_BACK_MS = 30_000/.test(view),
      '回退量必须是手册的 30 秒（出处写在常量上方）'
    )
    assert.ok(
      view.includes(':anchor-at-ms="detail.timestamp"'),
      '锚点必须是这条告警自己的时刻'
    )
    assert.ok(view.includes(':anchor-lead-ms="ALARM_JUMP_BACK_MS"'), '回退量没传下去')
    // 30 秒这个数字的**归因**必须写在代码里，而且必须是准确的归因：
    // 手册只有「按标签下载前后各 30 秒」，没有规定告警回放要回退多少。
    assert.ok(
      view.includes('手册 §15.11') && view.includes('我们自己的选择'),
      '必须写明：30 秒这个数字借自手册的标签下载窗口，而"告警回放回退 30 秒"是我们自己的选择'
    )
  })

  it('上/下一事件在边界处禁用，并把当前位置说出来', () => {
    assert.ok(view.includes("t('alarmsUi.prevEvent')"), '缺「上一事件」按钮')
    assert.ok(view.includes("t('alarmsUi.nextEvent')"), '缺「下一事件」按钮')
    assert.ok(/:disabled="!canPrevEvent"/.test(view), '「上一事件」必须在第一条禁用')
    assert.ok(/:disabled="!canNextEvent"/.test(view), '「下一事件」必须在最后一条禁用')
    assert.ok(
      view.includes("t('alarmsUi.eventPosition'"),
      '位置必须说出来，否则"下一步"按什么顺序走是个谜'
    )
    assert.ok(
      /function stepEvent\(delta: -1 \| 1\)/.test(view),
      '移动必须走一个函数（按钮不该各自写一份索引算术）'
    )
  })
})
