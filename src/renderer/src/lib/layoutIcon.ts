/**
 * 分屏档位图标（1 / 4 / 9 / 16 以及通道墙的 1 / 4 / 8 / 16 的小方格）的几何 ——
 * 纯函数，零依赖。
 *
 * 为什么图标也要有「模型」
 * 图标画错一格，操作员就会点到不是他想要的那个分屏档位：16 分屏的图标画成 4×3，
 * 点下去却是 4×4。所以图标不自己数方块：**格子数与每行列数必须由驱动真实网格的
 * 那两个量传进来**（档位本身，与 `cameraWallColumns()` / `layoutColumns()` 的
 * 返回值），本模块只把它们摊成一组 `<rect>`。任何一档的图标与它选出来的网格，
 * 因此不可能不一致。
 *
 * 坐标系固定是 `0 0 16 16` 的正方形：格子永远是正方形，列数越多越小，与真实网格
 * 的行列比一致（1 档 1×1、4 档 2×2、9 档 3×3、8 档 4×2、16 档 4×4）。
 */

/** 图标的坐标系边长（`<svg viewBox="0 0 16 16">`）。 */
export const LAYOUT_ICON_VIEW_BOX = 16

/** 图标四周的留白与格子之间的间隙（同一个坐标系里的长度）。 */
const ICON_PADDING = 1
const ICON_GAP = 1.5

/** 一个格子的矩形（SVG 用户坐标）。 */
export interface LayoutIconCell {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutIconGeometry {
  columns: number
  rows: number
  cells: LayoutIconCell[]
}

/** 保留两位小数：坐标只给 SVG 用，多余的精度只会让 DOM 变长。 */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把「几格 + 每行几格」摊成棋盘格。
 *
 * `columns` 不能整除 `count` 时退回一列（`count` 行）：宁可画成一排，也不画一个
 * 与真实排布不一致的形状。两面墙的真实档位（相机墙 1/4/9/16 配列数 1/2/3/4，
 * 通道墙 1/4/8/16 配列数 1/2/4/4）永远整除，所以这条分支只是把「调用方传错参数」
 * 变成看得见的一排格子。
 */
export function layoutIconGeometry(count: number, columns: number): LayoutIconGeometry {
  const total = Math.max(1, Math.floor(count))
  const wanted = Math.max(1, Math.floor(columns))
  const cols = total % wanted === 0 ? wanted : 1
  const rows = Math.ceil(total / cols)
  const width = (LAYOUT_ICON_VIEW_BOX - 2 * ICON_PADDING - (cols - 1) * ICON_GAP) / cols
  const height = (LAYOUT_ICON_VIEW_BOX - 2 * ICON_PADDING - (rows - 1) * ICON_GAP) / rows

  const cells: LayoutIconCell[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      cells.push({
        x: round(ICON_PADDING + column * (width + ICON_GAP)),
        y: round(ICON_PADDING + row * (height + ICON_GAP)),
        width: round(width),
        height: round(height)
      })
    }
  }
  return { columns: cols, rows, cells }
}
