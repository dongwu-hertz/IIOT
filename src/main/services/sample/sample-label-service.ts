/**
 * 标签库服务：两个维度（设备类型 / 故障类型）的维护与使用。
 *
 * 业主 2026-09-16：「应该有个专门的功能去做标签的添加和设备类型添加维护，之后在打标签时，
 * 直接选择故障类型和设备类型或新建故障类型和设备类型」。
 *
 * ---------------------------------------------------------------------------
 * 为什么"维护"要单独一层，而不是在打标签的输入框里就地写
 * ---------------------------------------------------------------------------
 * 打标签那一秒只关心"这一条是什么"，而标签库要维护的是**跨样本的一致性**：
 *   - 同名的两条要合并（`轴承故障` / `轴承故障 ` / `bearing` / `Bearing`）；
 *   - 改名要连**历史样本**一起改，否则筛选下拉与样本对不上；
 *   - 删除要问"还有多少条样本在用"，有人在用就不许删。
 * 这三件事都不是一个输入框能负责的，所以它们在这里，界面只调它们。
 *
 * ---------------------------------------------------------------------------
 * 三条规矩
 * ---------------------------------------------------------------------------
 *  1. **改名会连样本一起改**（一个事务）。只改标签库会让那些样本指向一个库里没有的类别。
 *  2. **有人用就不许删**，并把引用数报回去 —— 一句"删除失败"没法让操作员决定下一步。
 *     "停用"是另一件事（要加一列），今天没有：宁可让操作员看到"3 条样本在用"，
 *     也不要一个删了之后让 3 条样本变成孤儿类别的按钮。
 *  3. **打标签时用到的名字会自动进库**（`ensureLabel`）：操作员在输入框里打一个新故障类型，
 *     那是"新建"而不是"用了一个库里没有的词"。这一条让"或新建"真的成立。
 */

import {
  isSampleLabelDimension,
  normaliseSampleLabel,
  type SampleLabelDimension
} from '@shared/domain/sample-library'
import type {
  SampleLabelEntry as RepositoryLabelEntry,
  SampleLabelRepository
} from '../database/sample-label-repository'
import type { SampleRepository } from '../database/sample-repository'
import type {
  SampleLabelEntry,
  SampleLabelListResult,
  SampleLabelMutationResult
} from '@shared/ipc/contract'

export interface SampleLabelServiceOptions {
  labels: SampleLabelRepository
  samples: SampleRepository
}

export class SampleLabelService {
  private readonly labels: SampleLabelRepository
  private readonly samples: SampleRepository

  constructor(options: SampleLabelServiceOptions) {
    this.labels = options.labels
    this.samples = options.samples
  }

  /**
   * 两个维度各自的清单 + **引用数**。
   *
   * `usedBy` 是现场数出来的（不是存下来的计数器）：一个会漂移的计数比没有计数更糟 ——
   * 界面会拿它当"这一条能不能删"的依据。
   */
  list(): SampleLabelListResult {
    const toView = (entry: RepositoryLabelEntry): SampleLabelEntry => ({
      id: entry.id,
      name: entry.name,
      usedBy: this.samples.countSamplesUsingLabel(entry.dimension, entry.name),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    })
    return {
      equipment: this.labels.list('equipment').map(toView),
      fault: this.labels.list('fault').map(toView)
    }
  }

  /** 加一条。同名幂等（`created: false`），因为操作员打出带空格的重名是常态而不是错误。 */
  add(dimension: unknown, name: unknown): SampleLabelMutationResult {
    const resolved = requireDimension(dimension)
    const result = this.labels.insert(resolved, requireName(name))
    return { ok: true, created: result.created, id: result.id, name: result.name }
  }

  /**
   * 改名 + **把样本里引用的旧名字一起改掉**。
   *
   * 两件事必须同一个事务：只改了标签库的时候，样本里那些旧名字会指向一个不存在的类别，
   * 而界面上的"按故障类型筛选"会立刻列出 0 条 —— 看起来像数据丢了。
   */
  rename(id: string, name: unknown): SampleLabelMutationResult {
    const current = this.labels.findById(id)
    if (!current) return { ok: false, reason: 'not-found' }

    const target = requireName(name)
    /**
     * 冲突检查放在事务**之前**：改名撞上同维已存在的名字时什么都不该动（合并两个类别是
     * 另一件事，要决定保留哪一条的 id，不能在这里悄悄做）。
     */
    const existing = this.labels.findByName(current.dimension, target)
    if (existing && existing.id !== current.id) return { ok: false, reason: 'duplicate' }

    /**
     * 两件事必须同一个事务：只改了标签库的时候，样本里那些旧名字会指向一个不存在的类别，
     * 而界面上的"按故障类型筛选"会立刻列出 0 条 —— 看起来像数据丢了。
     */
    return this.labels.transaction(() => {
      const renamed = this.labels.rename(current.id, target)
      if (!renamed) return { ok: false as const, reason: 'duplicate' as const }

      /**
       * 样本里的标签一律记成**人工**：改名是人的动作，改完还留着原来的 `device` / `ai`
       * 来源就是在说谎（"设备判定"的那个名字已经不存在了）。
       */
      const affected = this.samples.renameLabelEverywhere(
        renamed.dimension,
        current.name,
        renamed.name,
        'human'
      )
      return {
        ok: true as const,
        created: false,
        id: renamed.id,
        name: renamed.name,
        affectedSamples: affected
      }
    })
  }

  /** 删除。**有人用就拒绝**，并把引用数报回去。 */
  remove(id: string): SampleLabelMutationResult {
    const current = this.labels.findById(id)
    if (!current) return { ok: false, reason: 'not-found' }

    const usedBy = this.samples.countSamplesUsingLabel(current.dimension, current.name)
    if (usedBy > 0) return { ok: false, reason: 'in-use', usedBy }

    const deleted = this.labels.delete(current.id)
    if (!deleted) return { ok: false, reason: 'not-found' }
    return { ok: true, created: false, id: current.id, name: current.name }
  }

  /**
   * 打标签时"或新建"这一半：把用到的名字记进库里（幂等），返回库里存的那一份写法。
   *
   * 返回值里的 `name` 可能与传入的不同（折叠空白、去尾随标点）：调用方应该把**库里那一份**
   * 写进样本，否则同一个类别会因为"这一次多打了个空格"而出现两种写法。
   */
  ensureLabel(dimension: SampleLabelDimension, name: string): string {
    return this.labels.insert(dimension, name).name
  }

  /** 库里的**全部**名字（筛选用），按维度给出。 */
  names(dimension: SampleLabelDimension): string[] {
    return this.labels.list(dimension).map((entry) => entry.name)
  }
}

function requireDimension(value: unknown): SampleLabelDimension {
  if (!isSampleLabelDimension(value)) throw new Error(`未知的标签维度: ${String(value)}`)
  return value
}

function requireName(value: unknown): string {
  const name = normaliseSampleLabel(value)
  if (name === undefined) throw new Error('标签名不能为空')
  return name
}
