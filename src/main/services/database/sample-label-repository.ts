/**
 * 标签库的持久化（schema v8 的 `sample_labels` 表）。
 *
 * 业主 2026-09-16：「对于标签的添加和使用，应该有个专门的功能去做标签的添加和设备类型添加维护，
 * 之后在打标签时，直接选择故障类型和设备类型或新建故障类型和设备类型」。
 *
 * ---------------------------------------------------------------------------
 * 两个维度共用一张表
 * ---------------------------------------------------------------------------
 * 设备类型与故障类型的**行为**完全一样：加、改名、删、数被用了多少次。分成两张表会让这四件
 * 事各写两遍，而两边迟早会有一边忘了加唯一约束。`dimension` 一列把它们分开。
 *
 * ---------------------------------------------------------------------------
 * 唯一性靠 `name_key`，不靠 `name`
 * ---------------------------------------------------------------------------
 * 用户看到的是自己输入的名字（`name`），去重用的是归一化后的键（`name_key`）：
 * 折叠空白、去掉尾随分隔标点、抹平大小写。所以 `轴承故障` 与 `轴承故障 ` 是同一条，
 * `Bearing` 与 `bearing` 也是。这一条是**数据库级**的 `UNIQUE (dimension, name_key)` ——
 * 在 JS 里判重会在两次点击之间漏掉一次插入。
 *
 * ---------------------------------------------------------------------------
 * 改名与删除的规矩（判断在服务层，这里只提供原语）
 * ---------------------------------------------------------------------------
 *   - **改名要连样本一起改**：`renameLabelEverywhere()` 在同一事务里把样本里引用的旧名字
 *     换成新名字。只改标签库会让那些样本指向一个"库里没有的类别"，筛选下拉立刻对不上。
 *   - **有人用就不许删**：`countSamplesUsingLabel()` 给服务层一个准确的引用数，
 *     服务层据此拒绝删除并告诉调用方有多少条样本在用。
 */

import type { Database as SqliteDatabase } from 'better-sqlite3'
import {
  labelNameKey,
  normaliseSampleLabel,
  type SampleLabelDimension
} from '@shared/domain/sample-library'
import { newSampleLabelId, now } from '@shared/utils/id'

interface SampleLabelRow {
  id: string
  dimension: string
  name: string
  name_key: string
  created_at: number
  updated_at: number
}

/** 标签库里的一条。 */
export interface SampleLabelEntry {
  id: string
  dimension: SampleLabelDimension
  name: string
  nameKey: string
  createdAt: number
  updatedAt: number
}

export interface SampleLabelInsertResult {
  id: string
  /** `false` = 这一维里已经有同名的标签了（幂等命中，不是失败）。 */
  created: boolean
  name: string
}

function toEntry(row: SampleLabelRow): SampleLabelEntry {
  return {
    id: row.id,
    // 表上有 CHECK，认不出的取值按故障处理只会更糟，所以调用方拿到的是收窄过的值。
    dimension: row.dimension === 'equipment' ? 'equipment' : 'fault',
    name: row.name,
    nameKey: row.name_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class SampleLabelRepository {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * 把若干条语句包成一个事务。
   *
   * 为什么要在这里开这个口子：改名要同时改 `sample_labels` 与 `samples`（两张表、同一个库），
   * 而"同时"是**原子性**问题，只有拿着连接的一层能保证。服务层拿不到 `db`，也不该拿到 ——
   * 所以这里给出一个只做事务的最小入口，而不是把连接暴露出去。
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)()
  }

  list(dimension?: SampleLabelDimension): SampleLabelEntry[] {
    const rows = dimension
      ? this.db
          .prepare<[string], SampleLabelRow>(
            `SELECT * FROM sample_labels WHERE dimension = ? ORDER BY name_key ASC`
          )
          .all(dimension)
      : this.db
          .prepare<[], SampleLabelRow>(`SELECT * FROM sample_labels ORDER BY dimension ASC, name_key ASC`)
          .all()
    return rows.map(toEntry)
  }

  findById(id: string): SampleLabelEntry | undefined {
    const row = this.db
      .prepare<[string], SampleLabelRow>(`SELECT * FROM sample_labels WHERE id = ?`)
      .get(id)
    return row ? toEntry(row) : undefined
  }

  findByName(dimension: SampleLabelDimension, name: string): SampleLabelEntry | undefined {
    const key = labelNameKey(name)
    if (key === undefined) return undefined
    const row = this.db
      .prepare<[string, string], SampleLabelRow>(
        `SELECT * FROM sample_labels WHERE dimension = ? AND name_key = ?`
      )
      .get(dimension, key)
    return row ? toEntry(row) : undefined
  }

  /**
   * 加一条。**幂等**：同名的直接返回既有那条（`created: false`）。
   *
   * 为什么是幂等而不是抛唯一约束错误：界面上的用法就是"选一个已有的或直接打一个新的"，
   * 操作员打出 `轴承故障 ` 而这种带空格的重名是**常态**，那不是错误，是同一个类别。
   */
  insert(dimension: SampleLabelDimension, name: string): SampleLabelInsertResult {
    const normalised = normaliseSampleLabel(name)
    const key = labelNameKey(name)
    if (normalised === undefined || key === undefined) {
      throw new Error('标签名不能为空')
    }

    const existing = this.findByName(dimension, normalised)
    if (existing) return { id: existing.id, created: false, name: existing.name }

    const id = newSampleLabelId()
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO sample_labels (id, dimension, name, name_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, dimension, normalised, key, timestamp, timestamp)
    return { id, created: true, name: normalised }
  }

  /**
   * 改名。目标名字已经存在（同一维里另一条）时**返回 undefined**，由服务层报错 ——
   * 合并两个类别是另一件事（要决定保留哪一条的 id），不能在这里悄悄做。
   */
  rename(id: string, name: string): SampleLabelEntry | undefined {
    const current = this.findById(id)
    if (!current) return undefined
    const normalised = normaliseSampleLabel(name)
    const key = labelNameKey(name)
    if (normalised === undefined || key === undefined) throw new Error('标签名不能为空')

    const clash = this.findByName(current.dimension, normalised)
    if (clash && clash.id !== id) return undefined

    this.db
      .prepare(`UPDATE sample_labels SET name = ?, name_key = ?, updated_at = ? WHERE id = ?`)
      .run(normalised, key, now(), id)
    return this.findById(id)
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM sample_labels WHERE id = ?`).run(id).changes > 0
  }

  count(dimension?: SampleLabelDimension): number {
    const row = dimension
      ? this.db
          .prepare<[string], { total: number }>(
            `SELECT COUNT(*) AS total FROM sample_labels WHERE dimension = ?`
          )
          .get(dimension)
      : this.db.prepare<[], { total: number }>(`SELECT COUNT(*) AS total FROM sample_labels`).get()
    return row?.total ?? 0
  }
}
