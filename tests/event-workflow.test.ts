/**
 * 事件的**处置工作流**：仓储（`event_status` + `event_activity`）与服务层的规则。
 *
 * ---------------------------------------------------------------------------
 * 这一组断言在守什么
 * ---------------------------------------------------------------------------
 * 处置动作会**写库**，而写库的错法有两种，都很安静：
 *   1. **状态变了、流水没写**（或者反过来）—— 事后完全无法解释"谁在什么时候把它关掉的"。
 *      所以仓储把两件事放在**一个事务**里，测试直接读两张表核对。
 *   2. **答应了自己做不到的事** —— 相机的检测日志没有确认接口，若还能被标成「已确认」，
 *      界面就在替设备撒谎。服务层必须**拒绝**，而不是静默降级。
 *
 * 另外两条是领域规则，值得单独钉住：
 *   - 迁移合法性（`canTransitionStatus`）由服务层判定，非法迁移必须带**允许的目标**回话；
 *   - `reopen` 必须留下原因（规格 §2.2 明说），空原因的重开在事后无法解释。
 *
 * 仓储用的是**真 SQLite**（`:memory:` + 真迁移），不是假实现：要断言的正是"落库的形状"。
 */

import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import type { Database as SqliteDatabase } from 'better-sqlite3'

import { openDatabase } from '../src/main/services/database/schema'
import { EventStatusRepository } from '../src/main/services/database/event-status-repository'
import { IncidentRepository } from '../src/main/services/database/incident-repository'
import { EventCenterService } from '../src/main/services/events/event-center-service'
import {
  deviceDetectEntryId,
  linkageEntryId,
  localAlarmEntryId
} from '../src/shared/domain/event-center'
import { ALERT_STATUS_TRANSITIONS, canTransitionStatus } from '../src/shared/domain/event-view'

let db: SqliteDatabase
let statuses: EventStatusRepository
/** Incident 仓储（schema v14）：这一份测的是处置动作，所以它只是服务的一个必需依赖。 */
let incidents: IncidentRepository

beforeEach(() => {
  db = openDatabase({ file: ':memory:' })
  statuses = new EventStatusRepository(db)
  incidents = new IncidentRepository(db)
})

describe('EventStatusRepository：状态与流水在同一个事务里', () => {
  it('写一条状态变更：状态行与 Activity 都落库，且**读回来**的就是写下去的那个状态', () => {
    const result = statuses.setStatus({
      entryId: 'alarm:alm-1',
      status: 'investigating',
      actor: 'admin',
      note: '现场看一下',
      at: 1_700_000_000_000
    })
    assert.equal(result.row.status, 'investigating')
    assert.equal(result.row.entryId, 'alarm:alm-1')
    assert.equal(result.activity.kind, 'status')
    assert.equal(result.activity.fromStatus, 'new')
    assert.equal(result.activity.toStatus, 'investigating')
    assert.equal(result.activity.actor, 'admin')
    assert.equal(result.activity.note, '现场看一下')

    // 读回（不是信任返回值）：两张表里各有一行，且内容一致。
    const stored = statuses.find('alarm:alm-1')
    assert.equal(stored?.status, 'investigating')
    const activity = statuses.activity('alarm:alm-1')
    assert.equal(activity.length, 1)
    assert.equal(activity[0]?.toStatus, 'investigating')
  })

  it('第二条变更记下**前一个状态**（这正是"谁把它关掉的"要回答的东西）', () => {
    statuses.setStatus({ entryId: 'alarm:alm-2', status: 'acknowledged', actor: 'admin', at: 10 })
    statuses.setStatus({
      entryId: 'alarm:alm-2',
      status: 'resolved',
      actor: 'operator',
      note: '已处理',
      at: 20
    })
    const activity = statuses.activity('alarm:alm-2')
    assert.equal(activity.length, 2)
    // 新的在前。
    assert.equal(activity[0]?.fromStatus, 'acknowledged')
    assert.equal(activity[0]?.toStatus, 'resolved')
    assert.equal(activity[1]?.fromStatus, 'new')
    assert.equal(activity[1]?.toStatus, 'acknowledged')
    assert.equal(statuses.find('alarm:alm-2')?.status, 'resolved')
  })

  it('只改指派人：状态不变、流水记成 `assign`，而且**不会把状态退回 new**', () => {
    // 这一条事件的来源侧已经确认过（界面显示「已确认」），但库里还没有状态行。
    const result = statuses.setStatus({
      entryId: 'alarm:alm-3',
      assignee: 'zhang',
      fromStatus: 'acknowledged',
      actor: 'admin',
      at: 30
    })
    assert.equal(result.row.status, 'acknowledged', '指派把状态退回了 new')
    assert.equal(result.row.assignee, 'zhang')
    assert.equal(result.activity.kind, 'assign')
    assert.equal(result.activity.assignee, 'zhang')
    assert.equal(result.activity.fromStatus, undefined, '指派不该记状态迁移')
    assert.equal(statuses.find('alarm:alm-3')?.status, 'acknowledged')
  })

  it('已经有状态行时，后续指派不改状态（`COALESCE` 只在不给出状态时生效）', () => {
    statuses.setStatus({ entryId: 'alarm:alm-4', status: 'investigating', actor: 'admin', at: 40 })
    statuses.setStatus({ entryId: 'alarm:alm-4', assignee: 'li', actor: 'admin', at: 41 })
    assert.equal(statuses.find('alarm:alm-4')?.status, 'investigating')
    assert.equal(statuses.find('alarm:alm-4')?.assignee, 'li')
  })

  it('actor 是空串时落 `unknown`（不写空字符串：流水里"谁做的"不能是一格空白）', () => {
    const result = statuses.setStatus({
      entryId: 'alarm:alm-5',
      status: 'closed',
      actor: '  ',
      at: 50
    })
    assert.equal(result.activity.actor, 'unknown')
  })

  it('一批事件的状态一次查出来（页面合并用），没写过的那些不在结果里', () => {
    statuses.setStatus({ entryId: 'alarm:a', status: 'resolved', actor: 'admin', at: 1 })
    statuses.setStatus({ entryId: 'alarm:b', status: 'muted', actor: 'admin', at: 2 })
    const map = statuses.statusMap(['alarm:a', 'alarm:b', 'alarm:c', ''])
    assert.equal(map.size, 2)
    assert.equal(map.get('alarm:a')?.status, 'resolved')
    assert.equal(map.get('alarm:b')?.status, 'muted')
    assert.equal(map.has('alarm:c'), false, '没动过的事件被凭空造了一个状态')
  })

  it('Activity 的条数按事件分组统计（列表用，不逐条查）', () => {
    statuses.setStatus({ entryId: 'alarm:a', status: 'acknowledged', actor: 'admin', at: 1 })
    statuses.setStatus({ entryId: 'alarm:a', status: 'investigating', actor: 'admin', at: 2 })
    statuses.setStatus({ entryId: 'alarm:b', status: 'acknowledged', actor: 'admin', at: 3 })
    const counts = statuses.activityCounts(['alarm:a', 'alarm:b', 'alarm:c'])
    assert.equal(counts.get('alarm:a'), 2)
    assert.equal(counts.get('alarm:b'), 1)
    assert.equal(counts.has('alarm:c'), false)
  })

  it('超过一批（400）的事件也查得回来 —— 分块查询不是装饰', () => {
    const ids: string[] = []
    for (let index = 0; index < 450; index += 1) {
      const id = `alarm:bulk-${index}`
      ids.push(id)
      statuses.setStatus({ entryId: id, status: 'acknowledged', actor: 'admin', at: index })
    }
    const map = statuses.statusMap(ids)
    assert.equal(map.size, 450)
    assert.equal(map.get('alarm:bulk-449')?.status, 'acknowledged')
  })
})

// ---------------------------------------------------------------------------
// 服务层的规则
// ---------------------------------------------------------------------------

interface ServiceFixture {
  service: EventCenterService
  statuses: EventStatusRepository
}

/**
 * 一个**内存里的联动待处理列表**。
 *
 * 为什么需要它：`acknowledge` 这一个动作会**同时落到来源侧**（见服务里的第 3 条规则），
 * 而来源侧只认它自己那份列表里的记录 —— 空列表会得到"来源侧没有确认这一条"，
 * 那是**正确的**行为，只是测试得先把记录放进去。
 */
function linkageFake(eventIds: readonly string[]) {
  const items = eventIds.map((eventId, index) => ({
    eventId,
    deviceId: 'cam-1',
    deviceName: 'Camera one',
    at: 1_700_000_000_000 + index,
    observedAt: 1_700_000_000_000 + index,
    source: 'poll' as const,
    actions: [],
    acknowledged: false
  }))
  return {
    pendingSnapshot: () => ({ items, dropped: 0 }),
    acknowledge: (ids: readonly string[]) => {
      for (const item of items) {
        if (ids.includes(item.eventId)) item.acknowledged = true
      }
      return { items, dropped: 0 }
    }
  }
}

function createService(linkageIds: readonly string[] = []): ServiceFixture {
  const service = new EventCenterService({
    listDevices: () => [],
    detectLibrary: {
      async list() {
        return { deviceId: 'cam-1', logsCount: 0, paging: 'none' as const, items: [] }
      },
      async download() {
        throw new Error('不该被调用')
      }
    },
    linkage: linkageFake(linkageIds),
    alarms: {
      query: () => ({ items: [], total: 0, limit: 50, offset: 0 }),
      acknowledge: () => 1
    },
    recordings: { findById: () => undefined, listByDevice: () => [] },
    images: {
      async serveImages(_directory, names) {
        return {
          files: names.map((name) => ({ name, url: `http://127.0.0.1:9/${name}` })),
          close: () => undefined
        }
      }
    },
    storage: { resolve: (storedPath) => storedPath },
    statuses,
    incidents,
    now: () => 1_700_000_000_000
  })
  return { service, statuses }
}

describe('EventCenterService.changeStatus：动作 → 状态 + 写库', () => {
  it('`investigate`：从 new 走到 investigating，返回值是**读回**的那一行', async () => {
    const { service } = createService()
    const entryId = linkageEntryId('evt-1')
    const result = await service.changeStatus({ entryId, action: 'investigate', actor: 'admin' })
    assert.equal(result.fromStatus, 'new')
    assert.equal(result.status, 'investigating')
    assert.equal(result.activity.kind, 'status')
    assert.equal(statuses.find(entryId)?.status, 'investigating')
  })

  it('非法迁移被拒绝，且消息里带着**允许的目标**（界面才能提示能做什么）', async () => {
    const { service } = createService(['evt-2'])
    const entryId = linkageEntryId('evt-2')
    // 走完整条主线到 closed：new → acknowledged → investigating → resolved → closed。
    await service.changeStatus({ entryId, action: 'acknowledge', actor: 'admin' })
    await service.changeStatus({ entryId, action: 'investigate', actor: 'admin' })
    await service.changeStatus({ entryId, action: 'resolve', actor: 'admin' })
    await service.changeStatus({ entryId, action: 'close', actor: 'admin' })
    assert.equal(statuses.activity(entryId).length, 4)

    await assert.rejects(
      () => service.changeStatus({ entryId, status: 'investigating', actor: 'admin' }),
      (error: unknown) => {
        const message = String((error as { message?: string }).message ?? error)
        assert.match(message, /不能从 closed 直接变成 investigating/)
        assert.match(message, /reopened/, '消息里没有列出允许的目标')
        return true
      }
    )
    // 被拒绝的那一次**不许**留下任何痕迹。
    assert.equal(statuses.activity(entryId).length, 4, '被拒绝的迁移也写了流水')
  })

  it('`reopen` 必须给原因（规格 §2.2）；给了原因就通过', async () => {
    const { service } = createService(['evt-3'])
    const entryId = linkageEntryId('evt-3')
    // new → acknowledged → resolved（`new → resolved` 不在状态图里）。
    await service.changeStatus({ entryId, action: 'acknowledge', actor: 'admin' })
    await service.changeStatus({ entryId, action: 'resolve', actor: 'admin' })
    await assert.rejects(
      () => service.changeStatus({ entryId, action: 'reopen', actor: 'admin' }),
      /必须填写原因/
    )
    const reopened = await service.changeStatus({
      entryId,
      action: 'reopen',
      note: '又响了',
      actor: 'admin'
    })
    assert.equal(reopened.status, 'reopened')
    assert.equal(reopened.activity.note, '又响了')
  })

  it('既没给动作也没给状态：拒绝，而不是默默什么都不做', async () => {
    const { service } = createService()
    await assert.rejects(
      () => service.changeStatus({ entryId: linkageEntryId('evt-4'), actor: 'admin' }),
      /既没有给动作/
    )
  })

  it('认不出来的 entry id 前缀：拒绝（宁可不写，也不能写到一个来历不明的键上）', async () => {
    const { service } = createService()
    await assert.rejects(
      () => service.changeStatus({ entryId: 'whatever:1', action: 'investigate', actor: 'admin' }),
      /认不出这条事件/
    )
    assert.equal(statuses.activity('whatever:1').length, 0)
  })

  it('`assign`：状态不变、指派人落库、流水是 assign', async () => {
    const { service } = createService()
    const entryId = localAlarmEntryId('alm-9')
    const result = await service.changeStatus({
      entryId,
      action: 'assign',
      assignee: 'zhang',
      actor: 'admin'
    })
    assert.equal(result.status, 'new')
    assert.equal(result.assignee, 'zhang')
    assert.equal(result.activity.kind, 'assign')
  })

  it('`assign` 不给账户名：拒绝', async () => {
    const { service } = createService()
    await assert.rejects(
      () =>
        service.changeStatus({
          entryId: localAlarmEntryId('alm-10'),
          action: 'assign',
          actor: 'admin'
        }),
      /必须给出账户名/
    )
  })

  it('相机检测日志不能「确认」：来源侧没有这个接口，服务层直接拒绝', async () => {
    const { service } = createService()
    const entryId = deviceDetectEntryId('cam-1', 7, 1_700_000_000)
    await assert.rejects(
      () => service.changeStatus({ entryId, action: 'acknowledge', actor: 'admin' }),
      /没有确认接口/
    )
    assert.equal(statuses.find(entryId), undefined, '被拒绝的确认仍然写了状态')
  })

  it('相机检测日志可以「开始调查」：状态机是本机工作流，不依赖设备', async () => {
    const { service } = createService()
    const entryId = deviceDetectEntryId('cam-1', 7, 1_700_000_000)
    const result = await service.changeStatus({ entryId, action: 'investigate', actor: 'admin' })
    assert.equal(result.status, 'investigating')
  })

  it('一次处置落到**组内每一条**（聚合告警）：状态与流水各写 N 条，且同一个事务', () => {
    const result = statuses.setStatus({
      entryId: 'alarm:g1',
      entryIds: ['alarm:g2', 'alarm:g3'],
      status: 'investigating',
      actor: 'admin',
      at: 7
    })
    assert.equal(result.appliedTo, 3)
    for (const id of ['alarm:g1', 'alarm:g2', 'alarm:g3']) {
      assert.equal(statuses.find(id)?.status, 'investigating', `${id} 没有被一起处置`)
      const activity = statuses.activity(id)
      assert.equal(activity.length, 1, `${id} 的流水不是一条`)
      assert.equal(activity[0]?.toStatus, 'investigating')
      assert.equal(activity[0]?.actor, 'admin')
    }
  })

  it('组里重复的 id 只写一次（界面可能把代表也放进 members）', () => {
    const result = statuses.setStatus({
      entryId: 'alarm:h1',
      entryIds: ['alarm:h1', 'alarm:h2', 'alarm:h2', '  '],
      status: 'closed',
      actor: 'admin',
      at: 8
    })
    assert.equal(result.appliedTo, 2)
    assert.equal(statuses.activity('alarm:h1').length, 1)
    assert.equal(statuses.activity('alarm:h2').length, 1)
  })

  it('`activity()` 拒绝空的 entry id（一次查询不该变成"把所有事件的流水都读出来"）', () => {
    const { service } = createService()
    assert.throws(() => service.activity('   '), /缺少事件标识/)
  })
})

describe('状态机本身（规格 §2.2）', () => {
  it('七个状态都在表里，且每个状态都至少有一个目标（没有死路）', () => {
    for (const [from, targets] of Object.entries(ALERT_STATUS_TRANSITIONS)) {
      assert.ok(targets.length > 0, `${from} 没有任何可以去的状态`)
      for (const target of targets) {
        assert.notEqual(target, from, `${from} 允许迁移到自己（那不算迁移）`)
      }
    }
  })

  it('主线与两条分叉都在：new→ack→investigating→resolved→closed，以及 muted / reopened', () => {
    assert.ok(canTransitionStatus('new', 'acknowledged'))
    assert.ok(canTransitionStatus('acknowledged', 'investigating'))
    assert.ok(canTransitionStatus('investigating', 'resolved'))
    assert.ok(canTransitionStatus('resolved', 'closed'))
    assert.ok(canTransitionStatus('new', 'muted'))
    assert.ok(canTransitionStatus('resolved', 'reopened'))
    assert.ok(canTransitionStatus('reopened', 'investigating'))
    // 已关闭的不能直接回到调查中：要动它必须留下"重新开启"这条记录。
    assert.equal(canTransitionStatus('closed', 'investigating'), false)
    assert.equal(canTransitionStatus('closed', 'resolved'), false)
    // 静默不是终点：要能回到工作状态。
    assert.ok(canTransitionStatus('muted', 'acknowledged'))
    assert.equal(canTransitionStatus('resolved', 'muted'), false)
  })
})
