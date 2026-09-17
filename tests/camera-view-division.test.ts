/**
 * 自定义分屏的几何模型（`lib/cameraViewDivision.ts`）。
 *
 * 为什么这些断言值得存在
 *   这一层要保证的是**几何不变量**，而不是「函数返回了东西」：
 *   一套分屏任何时候都必须**恰好铺满、互不重叠**。一旦某次 `Joint` 或拆分的实现把这两条
 *   弄坏，界面上会出现一个永远画不出内容、又没人知道为什么的空洞——而那正是本项目一直
 *   反对的「沉默的空白」。所以每个操作之后都要重新校验一次全集。
 *
 * 手册出处（UD02161B）
 *   - 规格 3×3 / 4×4 / 5×5：p44，1502；最多 5 套：p44，1495。
 *   - `Joint` 合并相邻窗口：p44，1503–1504。
 *   本模块自己加的两条（16 格上限、拆分）写在 `lib/cameraViewDivision.ts` 的文件头里。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import {
  DIVISION_SIZE_CHOICES,
  MAX_CUSTOM_VIEWS,
  MAX_DIVISION_CELLS,
  areJoinable,
  bindViewToDevices,
  createUniformDivision,
  divisionCoverage,
  joinCells,
  normaliseDivision,
  normaliseViews,
  splitCell,
  validateDivision,
  type CameraDivision,
  type CameraView
} from '../src/renderer/src/lib/cameraViewDivision'

/** 铺满的 3×3，供多处复用。 */
const unit3 = (): CameraDivision => createUniformDivision(3)

describe('自定义分屏：单位分屏', () => {
  it('3×3 是 9 格、铺满、合法', () => {
    const division = createUniformDivision(3)
    assert.equal(division.cells.length, 9)
    assert.equal(divisionCoverage(division), 9)
    assert.deepEqual(validateDivision(division).issues, [])
  })

  it('规格超出 3/4/5 会被点名', () => {
    const two = validateDivision(createUniformDivision(2))
    assert.equal(two.ok, false)
    assert.ok(two.issues.includes('size-out-of-range'), JSON.stringify(two.issues))

    const six = validateDivision(createUniformDivision(6))
    assert.equal(six.ok, false)
    assert.ok(six.issues.includes('size-out-of-range'), JSON.stringify(six.issues))
  })

  it('5×5 会被格子总数上限拦下（25 > 16）', () => {
    // 手册的 16 是**回放**窗口数；实时墙沿用同一个数，理由见模块文件头。
    assert.equal(MAX_DIVISION_CELLS, 16)
    const verdict = validateDivision(createUniformDivision(5))
    assert.equal(verdict.ok, false)
    assert.ok(verdict.issues.includes('too-many-cells'), JSON.stringify(verdict.issues))
  })

  it('非正方形被拒，但列数合法时**不**报规格越界', () => {
    // 这一条是回归：第一版断言曾以为 3×4 会同时报 size-out-of-range，其实列数 3 在允许集内。
    const verdict = validateDivision(createUniformDivision(3, 4))
    assert.equal(verdict.ok, false)
    assert.ok(verdict.issues.includes('size-not-square'), JSON.stringify(verdict.issues))
    assert.ok(!verdict.issues.includes('size-out-of-range'), JSON.stringify(verdict.issues))
  })

  it('允许的规格与上限都是手册里的值', () => {
    assert.deepEqual([...DIVISION_SIZE_CHOICES], [3, 4, 5])
    assert.equal(MAX_CUSTOM_VIEWS, 5)
  })
})

describe('自定义分屏：Joint 合并', () => {
  it('左右相邻可合并，合并后仍铺满且无重叠', () => {
    const merged = joinCells(unit3(), 'r0c0', 'r0c1')
    assert.ok(merged)
    assert.equal(merged.cells.length, 8)
    assert.equal(divisionCoverage(merged), 9)
    assert.deepEqual(validateDivision(merged).issues, [])

    const wide = merged.cells.find((cell) => cell.row === 0 && cell.column === 0)
    assert.equal(wide?.rowSpan, 1)
    assert.equal(wide?.columnSpan, 2)
  })

  it('上下相邻可合并', () => {
    const merged = joinCells(unit3(), 'r0c2', 'r1c2')
    assert.ok(merged)
    assert.equal(merged.cells.length, 8)
    assert.equal(divisionCoverage(merged), 9)
    assert.deepEqual(validateDivision(merged).issues, [])
  })

  it('不相邻 / 对角 / 自己 / 不存在的 id 都不能合并', () => {
    const division = unit3()
    assert.equal(joinCells(division, 'r0c0', 'r0c2'), undefined)
    assert.equal(joinCells(division, 'r0c0', 'r1c1'), undefined)
    assert.equal(joinCells(division, 'r0c0', 'r0c0'), undefined)
    assert.equal(joinCells(division, 'r0c0', 'nope'), undefined)
  })

  it('只有共享一整条边的格子才可合并', () => {
    const a = { id: 'a', row: 0, column: 0, rowSpan: 1, columnSpan: 2 }
    // 只有半条边重合（列区间不等）不算相邻
    const halfEdge = { id: 'b', row: 1, column: 1, rowSpan: 1, columnSpan: 2 }
    assert.equal(areJoinable(a, halfEdge), false)
    const fullEdge = { id: 'c', row: 1, column: 0, rowSpan: 1, columnSpan: 2 }
    assert.equal(areJoinable(a, fullEdge), true)
  })

  it('合并保留视觉顺序：结果落在先出现的那个位置', () => {
    const merged = joinCells(unit3(), 'r1c1', 'r1c2')
    assert.ok(merged)
    const joined = merged.cells[4]
    assert.ok(joined)
    assert.equal(joined.row, 1)
    assert.equal(joined.column, 1)
    assert.equal(joined.columnSpan, 2)
  })
})

describe('自定义分屏：拆回', () => {
  it('合并后能拆回原始单位格集合', () => {
    const merged = joinCells(unit3(), 'r0c0', 'r0c1')
    assert.ok(merged)
    const firstCell = merged.cells[0]
    assert.ok(firstCell)
    const back = splitCell(merged, firstCell.id)
    assert.ok(back)
    assert.equal(back.cells.length, 9)
    assert.deepEqual(validateDivision(back).issues, [])
    assert.deepEqual(
      back.cells.map((cell) => cell.id).sort(),
      unit3().cells.map((cell) => cell.id).sort()
    )
  })

  it('单位格不可再拆', () => {
    assert.equal(splitCell(unit3(), 'r1c1'), undefined)
    assert.equal(splitCell(unit3(), 'nope'), undefined)
  })
})

describe('自定义分屏：校验能抓到四种坏几何', () => {
  it('重叠', () => {
    const bad: CameraDivision = {
      columns: 3,
      rows: 3,
      cells: [
        { id: 'a', row: 0, column: 0, rowSpan: 1, columnSpan: 2 },
        { id: 'b', row: 0, column: 1, rowSpan: 1, columnSpan: 2 }
      ]
    }
    assert.ok(validateDivision(bad).issues.includes('overlap'))
  })

  it('空洞', () => {
    const bad: CameraDivision = {
      columns: 3,
      rows: 3,
      cells: [{ id: 'a', row: 0, column: 0, rowSpan: 1, columnSpan: 1 }]
    }
    assert.ok(validateDivision(bad).issues.includes('gap'))
  })

  it('越界', () => {
    const bad: CameraDivision = {
      columns: 3,
      rows: 3,
      cells: [{ id: 'a', row: 2, column: 2, rowSpan: 2, columnSpan: 1 }]
    }
    assert.ok(validateDivision(bad).issues.includes('out-of-bounds'))
  })

  it('非法跨度', () => {
    const bad: CameraDivision = {
      columns: 3,
      rows: 3,
      cells: [{ id: 'a', row: 0, column: 0, rowSpan: 0, columnSpan: 1 }]
    }
    assert.ok(validateDivision(bad).issues.includes('bad-span'))
  })
})

describe('自定义分屏：磁盘值一律当不可信输入', () => {
  it('垃圾值返回 undefined 而不是抛错', () => {
    assert.equal(normaliseDivision(null), undefined)
    assert.equal(normaliseDivision(42), undefined)
    assert.equal(normaliseDivision({ columns: 'x', rows: 3, cells: [] }), undefined)
    assert.equal(normaliseDivision({ columns: 3, rows: 3, cells: 'nope' }), undefined)
  })

  it('结构对但几何不合法（有空洞）时整份丢弃，而不是带病恢复', () => {
    const raw = { columns: 3, rows: 3, cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 1 }] }
    assert.equal(normaliseDivision(raw), undefined)
  })

  it('合法值原样通过，并为缺失 id 的格子补上 id', () => {
    const cells: Array<Record<string, number>> = []
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        cells.push({ row, column, rowSpan: 1, columnSpan: 1 })
      }
    }
    const division = normaliseDivision({ columns: 3, rows: 3, cells })
    assert.ok(division)
    assert.equal(division.cells.length, 9)
    assert.ok(division.cells.every((cell) => cell.id !== ''))
  })
})

describe('自定义分屏：视图列表修补', () => {
  it('最多 5 套', () => {
    const unit = unit3()
    const many = Array.from({ length: 9 }, (_value, index) => ({
      id: `v${index}`,
      name: `x${index}`,
      division: unit,
      bindings: []
    }))
    assert.equal(normaliseViews(many).length, MAX_CUSTOM_VIEWS)
  })

  it('绑定数组对齐格子数：过短补齐、非字符串与空串变 null', () => {
    const views = normaliseViews([
      {
        id: 'v',
        name: 'a',
        division: unit3(),
        bindings: ['fa371:1.2.3.4:80', 42, '', 'mac:aa', null, 'x']
      }
    ])
    assert.equal(views.length, 1)
    const view = views[0]
    assert.ok(view)
    assert.equal(view.bindings.length, 9)
    assert.equal(view.bindings[0], 'fa371:1.2.3.4:80')
    assert.equal(view.bindings[1], null)
    assert.equal(view.bindings[2], null)
    assert.equal(view.bindings[3], 'mac:aa')
  })

  it('绑定过长时截断到格子数', () => {
    const views = normaliseViews([
      { id: 'v', name: 'a', division: unit3(), bindings: Array.from({ length: 40 }, () => 'uid') }
    ])
    const truncated = views[0]
    assert.ok(truncated)
    assert.equal(truncated.bindings.length, 9)
  })

  it('重复 id 会被换掉，坏视图被丢弃', () => {
    const good = { id: 'dup', name: 'a', division: unit3(), bindings: [] }
    const views = normaliseViews([null, 5, { id: 'no-division' }, good, { ...good }])
    assert.equal(views.length, 2)
    const first = views[0]
    const second = views[1]
    assert.ok(first)
    assert.ok(second)
    assert.notEqual(first.id, second.id)
  })
})

describe('自定义分屏：恢复时把 deviceUid 解析回设备', () => {
  /** 造一套 3×3、只有前几格有绑定的视图。 */
  const viewWith = (bindings: Array<string | null>): CameraView => ({
    id: 'v',
    name: '视图',
    division: createUniformDivision(3),
    bindings
  })

  it('解析得到的设备按格子顺序落位，空格保持 null', () => {
    const view = viewWith(['uid-a', null, 'uid-b'])
    const bound = bindViewToDevices(view, (uid) => ({ 'uid-a': 'dev-1', 'uid-b': 'dev-2' })[uid])
    assert.deepEqual(bound.slots, ['dev-1', null, 'dev-2', null, null, null, null, null, null])
    assert.equal(bound.slots.length, view.division.cells.length)
    assert.deepEqual(bound.unresolved, [])
  })

  it('设备已不在时留空并记下 missing（绝不猜一个别的设备顶上）', () => {
    const view = viewWith(['uid-gone', 'uid-here'])
    const bound = bindViewToDevices(view, (uid) => (uid === 'uid-here' ? 'dev-2' : undefined))
    assert.equal(bound.slots[0], null)
    assert.equal(bound.slots[1], 'dev-2')
    assert.deepEqual(bound.unresolved, [{ index: 0, uid: 'uid-gone', reason: 'missing' }])
  })

  it('同一台设备被绑两次时，后面的那格留空并记下 duplicate', () => {
    // 两个不同的 uid 解析到同一台设备（例如相机换了地址后旧 uid 仍在视图里）。
    const view = viewWith(['uid-old', 'uid-new'])
    const bound = bindViewToDevices(view, () => 'dev-1')
    assert.equal(bound.slots[0], 'dev-1')
    assert.equal(bound.slots[1], null)
    assert.deepEqual(bound.unresolved, [{ index: 1, uid: 'uid-new', reason: 'duplicate' }])
  })

  it('同一个 uid 出现两次也只占一格', () => {
    const view = viewWith(['uid-a', 'uid-a'])
    const bound = bindViewToDevices(view, () => 'dev-1')
    assert.equal(bound.slots[0], 'dev-1')
    assert.equal(bound.slots[1], null)
    assert.deepEqual(bound.unresolved.map((entry) => entry.reason), ['duplicate'])
  })

  it('绑定数组比格子短时，多出来的格子是空的而不是 undefined', () => {
    const view = viewWith(['uid-a'])
    const bound = bindViewToDevices(view, () => 'dev-1')
    assert.equal(bound.slots.length, 9)
    assert.ok(bound.slots.slice(1).every((slot) => slot === null))
  })
})
