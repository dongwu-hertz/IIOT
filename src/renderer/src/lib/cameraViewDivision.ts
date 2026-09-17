/**
 * 自定义分屏的**几何模型** —— 纯函数、零依赖、零 i18n。
 *
 * 为什么需要它（而不是复用 `CameraWallLayout`）
 *   现有的档位是 `1 | 4 | 9 | 16`，每档只用一个**统一列数**描述（`cameraWallColumns()`）。
 *   而 iVMS 的自定义分屏允许把相邻窗口 `Joint` 合并成一整格（手册 UD02161B p44–45，
 *   `Joint` 在 1503–1504 行），合出来的格子**不等宽也不等高**，一个「列数」表达不了。
 *   所以这里换成显式的矩形模型：每个格子带 `row / column / rowSpan / columnSpan`。
 *
 * 取值出处（都是手册原文，不是我定的）
 *   - 规格只有 **3×3 / 4×4 / 5×5**（p44，1502）；较新的 iVMS 版本另有 6×6（见
 *     `docs/Ivms4200-UX-REFERENCE.md` §15.4 的版本差异）。
 *   - 自定义分屏**最多 5 套**（p44，1495）。
 *   - 回放最多同时 16 窗口，超过 16 窗口的自定义分屏对回放无效（p44–45，1509–1512）。
 *
 * 本模块**自己加的**两条（手册没有，写在这里以免被当成抄来的）
 *   1. `MAX_DIVISION_CELLS = 16`：实时墙的格子总数上限。手册那条 16 是说**回放**窗口数，
 *      我们没有设备侧回放；这里借用同一个数是因为本仓库的档位本来就到 16 为止，
 *      而 5×5 = 25 格在实时墙上既拉不起（并发上限默认 4）也没有意义。
 *   2. `splitCell()`：把一个合并格拆回单位格。手册只有 `Joint`，没有拆；
 *      但一个不可逆的操作在界面上是敌意的（合错了只能整套重建），所以补上。
 *
 * 与设备身份的关系（见 `docs/Ivms4200-UX-REFERENCE.md` §15.12）
 *   视图里绑定的**不是**数据库主键，而是稳定的 `deviceUid`（相机 `fa371:<ip>:<port>`、
 *   盒子 `mac:…`）。`stores/liveWall.ts` 明确不持久化「哪台设备在哪一格」，理由是设备 id
 *   重启后可能对应另一台设备，恢复一个过期 id 会静默拉一路没人要的视频。
 *   这里因此把绑定当成**字符串 uid + 恢复时可校验**的东西：`normaliseViews()` 只做结构修补，
 *   **不解析 uid**（解析要问设备库，属于调用方的事），由调用方在恢复时把解析不到的格子留空。
 */

/** 自定义分屏允许的规格（手册 p44，1502）。 */
export const DIVISION_SIZE_CHOICES: readonly number[] = [3, 4, 5]

/** 自定义分屏最多几套（手册 p44，1495）。 */
export const MAX_CUSTOM_VIEWS = 5

/** 格子总数上限 —— **本模块自定**，理由见文件头。 */
export const MAX_DIVISION_CELLS = 16

/** 一个矩形格子。坐标 0 基，`row + rowSpan` 与 `column + columnSpan` 是**开区间上界**。 */
export interface DivisionCell {
  id: string
  row: number
  column: number
  rowSpan: number
  columnSpan: number
}

/** 一套分屏：网格尺寸 + 若干互不重叠、恰好铺满的矩形。 */
export interface CameraDivision {
  columns: number
  rows: number
  cells: DivisionCell[]
}

/** 一套具名视图：分屏几何 + 每格绑哪台设备（按 `cells` 顺序，`null` = 空）。 */
export interface CameraView {
  id: string
  name: string
  division: CameraDivision
  /** 与 `division.cells` 一一对应；元素是 `deviceUid`，不是数据库主键。 */
  bindings: Array<string | null>
}

export type DivisionIssue =
  | 'size-not-square'
  | 'size-out-of-range'
  | 'too-many-cells'
  | 'no-cells'
  | 'bad-span'
  | 'out-of-bounds'
  | 'overlap'
  | 'gap'

export interface DivisionValidation {
  ok: boolean
  issues: DivisionIssue[]
}

const cellId = (row: number, column: number): string => `r${row}c${column}`

/** 单位格：每个 1×1。`columns`/`rows` 相等时就是手册那种 3×3 / 4×4 / 5×5。 */
export function createUniformDivision(columns: number, rows: number = columns): CameraDivision {
  const width = Math.max(1, Math.floor(columns))
  const height = Math.max(1, Math.floor(rows))
  const cells: DivisionCell[] = []
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      cells.push({ id: cellId(row, column), row, column, rowSpan: 1, columnSpan: 1 })
    }
  }
  return { columns: width, rows: height, cells }
}

/** 矩形面积。 */
export function cellArea(cell: DivisionCell): number {
  return cell.rowSpan * cell.columnSpan
}

/** 所有格子面积之和：铺满时等于 `columns * rows`。 */
export function divisionCoverage(division: CameraDivision): number {
  return division.cells.reduce((total, cell) => total + cellArea(cell), 0)
}

/**
 * 校验一套分屏。
 *
 * 逐条给出**具体**的问题码而不是一个布尔：调用方要能把「哪里不对」说清楚，
 * 而「无效的分屏」这种话在界面上等于什么都没说。
 */
export function validateDivision(division: CameraDivision): DivisionValidation {
  const issues: DivisionIssue[] = []
  const { columns, rows, cells } = division

  if (columns !== rows) issues.push('size-not-square')
  if (!DIVISION_SIZE_CHOICES.includes(columns)) issues.push('size-out-of-range')
  if (cells.length === 0) issues.push('no-cells')
  if (cells.length > MAX_DIVISION_CELLS) issues.push('too-many-cells')

  for (const cell of cells) {
    if (!Number.isInteger(cell.rowSpan) || !Number.isInteger(cell.columnSpan) ||
        cell.rowSpan < 1 || cell.columnSpan < 1) {
      issues.push('bad-span')
      break
    }
  }

  const outOfBounds = cells.some(
    (cell) =>
      cell.row < 0 || cell.column < 0 ||
      cell.row + cell.rowSpan > rows || cell.column + cell.columnSpan > columns
  )
  if (outOfBounds) issues.push('out-of-bounds')

  // 重叠与空洞都用「逐格计数」判：每个单元最多被覆盖一次，且必须都被覆盖。
  const seen = new Map<string, number>()
  for (const cell of cells) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
        const key = cellId(row, column)
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
  }
  let overlapped = false
  let uncovered = 0
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const count = seen.get(cellId(row, column)) ?? 0
      if (count > 1) overlapped = true
      if (count === 0) uncovered += 1
    }
  }
  if (overlapped) issues.push('overlap')
  if (uncovered > 0) issues.push('gap')

  return { ok: issues.length === 0, issues }
}

/** 两个格子是否共享一整条边（`Joint` 的合法前提）。 */
export function areJoinable(a: DivisionCell, b: DivisionCell): boolean {
  // 左右相邻：同一行区间，且 a 的右边就是 b 的左边（或反过来）。
  const sameRows = a.row === b.row && a.rowSpan === b.rowSpan
  if (sameRows && a.column + a.columnSpan === b.column) return true
  if (sameRows && b.column + b.columnSpan === a.column) return true

  // 上下相邻：同一列区间，且一条的底边就是另一条的顶边。
  const sameColumns = a.column === b.column && a.columnSpan === b.columnSpan
  if (sameColumns && a.row + a.rowSpan === b.row) return true
  if (sameColumns && b.row + b.rowSpan === a.row) return true

  return false
}

/**
 * 合并两个相邻格子（`Joint`）。
 *
 * 不合法的合并不抛错而是返回 `undefined`：调用方（界面）本来就要先问 `areJoinable()` 来决定
 * 按钮是否可点，这里再抛一次就变成两处判断同一件事。
 */
export function joinCells(
  division: CameraDivision,
  firstId: string,
  secondId: string
): CameraDivision | undefined {
  const first = division.cells.find((cell) => cell.id === firstId)
  const second = division.cells.find((cell) => cell.id === secondId)
  if (!first || !second || first.id === second.id) return undefined
  if (!areJoinable(first, second)) return undefined

  const row = Math.min(first.row, second.row)
  const column = Math.min(first.column, second.column)
  const rowSpan = Math.max(first.row + first.rowSpan, second.row + second.rowSpan) - row
  const columnSpan = Math.max(first.column + first.columnSpan, second.column + second.columnSpan) - column
  const merged: DivisionCell = { id: cellId(row, column), row, column, rowSpan, columnSpan }

  // 保留原来的顺序位置：把先出现的那个换成合并结果，另一个删掉。
  // 这样格子的**视觉顺序**不会因为一次合并而重排。
  const cells: DivisionCell[] = []
  for (const cell of division.cells) {
    if (cell.id === firstId || cell.id === secondId) {
      if (!cells.some((candidate) => candidate.id === merged.id)) cells.push(merged)
      continue
    }
    cells.push(cell)
  }
  return { columns: division.columns, rows: division.rows, cells }
}

/** 把一个格子拆回单位格（本模块自加，手册只有 `Joint`，见文件头）。 */
export function splitCell(division: CameraDivision, id: string): CameraDivision | undefined {
  const target = division.cells.find((cell) => cell.id === id)
  if (!target) return undefined
  if (target.rowSpan === 1 && target.columnSpan === 1) return undefined // 已经是单位格

  const replacements: DivisionCell[] = []
  for (let row = target.row; row < target.row + target.rowSpan; row += 1) {
    for (let column = target.column; column < target.column + target.columnSpan; column += 1) {
      replacements.push({ id: cellId(row, column), row, column, rowSpan: 1, columnSpan: 1 })
    }
  }

  const cells: DivisionCell[] = []
  for (const cell of division.cells) {
    if (cell.id === id) {
      cells.push(...replacements)
      continue
    }
    cells.push(cell)
  }
  return { columns: division.columns, rows: division.rows, cells }
}

/**
 * 把来自 localStorage 的值修补成一套**合法**的分屏（坏值丢弃，绝不抛错）。
 *
 * 与 `stores/liveWall.ts` 现有的「档位坏值回落到默认档」同一条规矩：记不住偏好不应该
 * 让界面起不来，而磁盘上的东西一律当作不可信输入。
 */
export function normaliseDivision(value: unknown): CameraDivision | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { columns?: unknown; rows?: unknown; cells?: unknown }
  const columns = Number(candidate.columns)
  const rows = Number(candidate.rows)
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return undefined
  if (!Array.isArray(candidate.cells)) return undefined

  const cells: DivisionCell[] = []
  for (const raw of candidate.cells) {
    if (typeof raw !== 'object' || raw === null) continue
    const cell = raw as Record<string, unknown>
    const row = Number(cell.row)
    const column = Number(cell.column)
    const rowSpan = Number(cell.rowSpan)
    const columnSpan = Number(cell.columnSpan)
    if (![row, column, rowSpan, columnSpan].every((n) => Number.isInteger(n))) continue
    if (rowSpan < 1 || columnSpan < 1) continue
    cells.push({
      id: typeof cell.id === 'string' && cell.id !== '' ? cell.id : cellId(row, column),
      row,
      column,
      rowSpan,
      columnSpan
    })
  }

  const division: CameraDivision = { columns: Math.floor(columns), rows: Math.floor(rows), cells }
  return validateDivision(division).ok ? division : undefined
}

/**
 * 把来自 localStorage 的视图列表修补成合法列表：丢坏值、截断到 `MAX_CUSTOM_VIEWS`。
 *
 * **只做结构修补，不解析 `deviceUid`**（见文件头）：解析要查设备库，是调用方的事。
 * 绑定数组长度一律对齐到格子数——过长的截断、过短的补 `null`，否则界面会出现
 * 「第 7 格绑了一台设备，但分屏只有 6 格」这种对不上的状态。
 */
export function normaliseViews(value: unknown, limit = MAX_CUSTOM_VIEWS): CameraView[] {
  if (!Array.isArray(value)) return []
  const views: CameraView[] = []
  const usedIds = new Set<string>()

  for (const raw of value) {
    if (views.length >= limit) break
    if (typeof raw !== 'object' || raw === null) continue
    const candidate = raw as Record<string, unknown>
    const division = normaliseDivision(candidate.division)
    if (!division) continue

    let id = typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : ''
    if (id === '' || usedIds.has(id)) id = `view-${views.length + 1}-${division.cells.length}`
    usedIds.add(id)

    const rawBindings = Array.isArray(candidate.bindings) ? candidate.bindings : []
    const bindings: Array<string | null> = division.cells.map((_cell, index) => {
      const binding = rawBindings[index]
      return typeof binding === 'string' && binding !== '' ? binding : null
    })

    views.push({
      id,
      name: typeof candidate.name === 'string' ? candidate.name : '',
      division,
      bindings
    })
  }
  return views
}

// ---------------------------------------------------------------------------
// 恢复：把存下来的 deviceUid 解析回当前设备
// ---------------------------------------------------------------------------

/** 一格没能恢复的原因。两种原因分开报，因为处置方式不同。 */
export type UnresolvedReason =
  /** 存过这台设备，但现在找不到它了（被删了，或换了地址）。 */
  | 'missing'
  /** 同一台设备在视图里出现了两次——墙的模型不允许一台设备占两格。 */
  | 'duplicate'

export interface UnresolvedBinding {
  index: number
  uid: string
  reason: UnresolvedReason
}

export interface BoundView {
  /** 每个格子的**设备 id**；`null` = 这一格空着（本来就没绑，或原设备已不在）。 */
  slots: Array<string | null>
  /** 需要界面**逐格说明原因**的那些格子。 */
  unresolved: UnresolvedBinding[]
}

/**
 * 把一套视图的绑定解析成「每格放哪台设备」。
 *
 * 为什么解析要交给调用方（`resolveUid`）而不是在这里查设备库
 *   本模块是纯的，不认识设备列表，也不该认识——`stores/liveWall.ts` 才有设备索引。
 *   这里只负责**决定**：解析不到就留空并记下原因，**绝不猜**（把 uid 当 id 用、
 *   或者按索引硬塞一台别的设备，都会让操作员在一个写着 CH3 的格子里看到 CH5 的画面）。
 *
 * 为什么不在这里起流
 *   恢复视图只把绑定画进格子。**是否拉流是另一个决定**（`decideCameraAutoPlay()`，
 *   一次进程一次尝试）。让恢复顺手起流，就会绕过那条「操作员手动停止过就不再自动起」
 *   的规则，也会在启动时静默拉起几路没人要的视频——这正是 `stores/liveWall.ts`
 *   当初决定「格子分配不持久化」时要防的事（见该文件头）。所以本函数只产出绑定，
 *   没有任何副作用，调用方也无从在这里起流。
 */
export function bindViewToDevices(
  view: CameraView,
  resolveUid: (uid: string) => string | undefined
): BoundView {
  const slots: Array<string | null> = []
  const unresolved: UnresolvedBinding[] = []
  const taken = new Set<string>()

  view.division.cells.forEach((_cell, index) => {
    const uid = view.bindings[index] ?? null
    if (uid === null) {
      slots.push(null)
      return
    }
    const deviceId = resolveUid(uid)
    if (deviceId === undefined) {
      slots.push(null)
      unresolved.push({ index, uid, reason: 'missing' })
      return
    }
    if (taken.has(deviceId)) {
      slots.push(null)
      unresolved.push({ index, uid, reason: 'duplicate' })
      return
    }
    taken.add(deviceId)
    slots.push(deviceId)
  })

  return { slots, unresolved }
}
