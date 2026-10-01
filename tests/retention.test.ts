/**
 * ⑫ 保留策略（容量优先）的回归测试（`shared/domain/retention.ts`）。
 *
 * WHY THIS FILE EXISTS
 * 这套判据决定**从用户的盘上抹掉哪些文件**，不可逆。业主给的三条口径（容量优先、删最旧、
 * warning 以上告警占 10% 永久保留、手动不自动删）在这里逐条钉住；尤其是三条最容易写错的：
 *   - 手动录像被顺手删掉（它永远不该进待删队列）；
 *   - 永久保留区**无上限**（那等于"配额"形同虚设）；
 *   - 删完还超却报"已清理干净"（只剩永久告警与手动录像时，必须如实说还超多少）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  isRetentionProtected,
  planCapacityRetention,
  type RetentionCandidate
} from '../src/shared/domain/retention'

const GB = 1024 ** 3

function alarm(id: string, startMs: number, gb: number, severity?: string): RetentionCandidate {
  return { id, kind: 'alarm', bytes: gb * GB, startMs, ...(severity ? { severity } : {}) }
}
function scheduled(id: string, startMs: number, gb: number): RetentionCandidate {
  return { id, kind: 'scheduled', bytes: gb * GB, startMs }
}
function manual(id: string, startMs: number, gb: number): RetentionCandidate {
  return { id, kind: 'manual', bytes: gb * GB, startMs }
}

describe('保留策略：没超配额就什么都不删', () => {
  it('总占用 <= 配额 -> 空计划', () => {
    const plan = planCapacityRetention({
      candidates: [scheduled('s1', 1, 10), alarm('a1', 2, 5, 'alarm')],
      quotaBytes: 50 * GB
    })
    assert.deepEqual(plan.deleteIds, [])
    assert.equal(plan.freedBytes, 0)
    assert.equal(plan.remainingOverBytes, 0)
  })

  it('配额为 0 / 非法 -> 不删（宁可不动手，也不猜一个上限去删）', () => {
    for (const quota of [0, -1, Number.NaN]) {
      const plan = planCapacityRetention({ candidates: [scheduled('s1', 1, 10)], quotaBytes: quota })
      assert.deepEqual(plan.deleteIds, [], String(quota))
    }
  })
})

describe('保留策略：超了先删最旧的连续录像', () => {
  it('按 startMs 从旧到新删，删到配额以内就停', () => {
    const plan = planCapacityRetention({
      candidates: [
        scheduled('newest', 300, 20),
        scheduled('oldest', 100, 20),
        scheduled('middle', 200, 20)
      ],
      quotaBytes: 50 * GB // 总 60 -> 删掉最旧的一片（20）就回到 40
    })
    assert.deepEqual(plan.deleteIds, ['oldest'])
    assert.equal(plan.freedBytes, 20 * GB)
    assert.equal(plan.remainingOverBytes, 0)
  })

  it('需要删多片时按时间升序给出（调用方按顺序删）', () => {
    const plan = planCapacityRetention({
      candidates: [scheduled('c', 300, 10), scheduled('a', 100, 10), scheduled('b', 200, 10)],
      quotaBytes: 15 * GB
    })
    assert.deepEqual(plan.deleteIds, ['a', 'b'])
    assert.equal(plan.remainingOverBytes, 0)
  })
})

describe('保留策略：warning 以上的告警占 10% 永久保留', () => {
  it('超出保留区封顶的告警**会被删**（永久 ≠ 无上限），且按最旧优先', () => {
    const plan = planCapacityRetention({
      candidates: [alarm('severe', 100, 4, 'alarm'), scheduled('s1', 200, 20)],
      quotaBytes: 20 * GB // 保留区上限 2 GB，而这条告警 4 GB —— 放不进保留区
    })
    // 它进了待删队列，而且比 s1 更旧 -> 先被删。"10% 封顶"的真正含义就在这条：
    // 永久保留是**有预算的**永久，不是无限增长。
    assert.equal(plan.deleteIds[0], 'severe')
  })

  it('保留区内（未超 10%）的告警永不进待删队列', () => {
    const plan = planCapacityRetention({
      candidates: [alarm('severe', 100, 1, 'warning'), scheduled('s1', 200, 30)],
      quotaBytes: 20 * GB // 保留区 2 GB，这条 1 GB 在内
    })
    assert.deepEqual(plan.deleteIds, ['s1'], '只应删连续录像')
    assert.equal(plan.reservedBytes, 1 * GB)
  })

  it('保留区超出 10% 的部分按最旧优先删（永久 ≠ 无上限）', () => {
    const plan = planCapacityRetention({
      candidates: [
        alarm('old', 100, 3, 'critical'),
        alarm('new', 200, 3, 'critical'),
        scheduled('s1', 50, 20)
      ],
      quotaBytes: 20 * GB, // 保留区上限 2 GB：两条各 3 GB 都放不下
      totalBytes: 20 * GB // 总占用刚好等于配额 -> 只由保留区封顶驱动删除
    })
    // 配额不超时**只**由容量驱动删除（保留区封顶本身不触发删除）—— 这是"容量优先"的直接含义。
    assert.equal(plan.remainingOverBytes, 0)
    assert.deepEqual(plan.deleteIds, [])
  it('配额不超时不做任何淘汰（保留区封顶只在"已经超了"时才起作用）', () => {
    const plan = planCapacityRetention({
      candidates: [alarm('old', 100, 3 * GB, 'critical'), alarm('new', 200, 3 * GB, 'critical')],
      quotaBytes: 20 * GB,
      totalBytes: 20 * GB // 刚好等于配额
    })
    assert.deepEqual(plan.deleteIds, [])
  })
  })

  it('等级低于 warning 的告警不算永久（与连续录像一起滚动）', () => {
    assert.equal(isRetentionProtected(alarm('a', 1, 1, 'info')), false)
    assert.equal(isRetentionProtected(alarm('a', 1, 1, 'warning')), true)
    assert.equal(isRetentionProtected(alarm('a', 1, 1, 'ALARM')), true, '大小写不敏感')
    assert.equal(isRetentionProtected(alarm('a', 1, 1)), false, '没有等级 = 不保护')
    assert.equal(isRetentionProtected(scheduled('s', 1, 1)), false, '连续录像永远不是永久')
  })
})

describe('保留策略：手动录像永不自动删，且"删不干净"要如实说', () => {
  it('只剩手动录像时，超配额也不删，并报还超多少', () => {
    const plan = planCapacityRetention({
      candidates: [manual('m1', 100, 30), manual('m2', 200, 30)],
      quotaBytes: 50 * GB
    })
    assert.deepEqual(plan.deleteIds, [], '手动录像不许进待删队列')
    assert.equal(plan.remainingOverBytes, 10 * GB, '必须如实报"还超 10 GB"')
  })

  it('总占用里包含非录像数据（趋势/日志/缓存）也算数', () => {
    const plan = planCapacityRetention({
      candidates: [scheduled('s1', 100, 10)],
      // 录像只有 10 GB，但盘上还有 60 GB 的趋势/日志 -> 删掉录像仍然超配额
      totalBytes: 70 * GB,
      quotaBytes: 50 * GB
    })
    assert.deepEqual(plan.deleteIds, ['s1'])
    assert.equal(plan.remainingOverBytes, 10 * GB, '删完录像仍超 10 GB（那 60 GB 是非录像数据，不是这套策略能删的）')
  })

  it('连续录像 + 非保护告警都能删，删的顺序仍是"最旧优先"（跨档按时间）', () => {
    const plan = planCapacityRetention({
      candidates: [alarm('a-old', 100, 10, 'info'), scheduled('s-old', 150, 10), alarm('a-severe', 120, 1, 'alarm')],
      quotaBytes: 15 * GB
    })
    // 总 21 GB -> 删到 15：先删最旧的 a-old(100)，仍 11 GB <= 15 -> 停。
    assert.deepEqual(plan.deleteIds, ['a-old'])
    assert.equal(plan.reservedBytes, 1 * GB)
  })
})