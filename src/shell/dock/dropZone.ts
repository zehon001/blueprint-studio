/**
 * 拖放落点判定（T0.3 · Godot 式吸附手感）
 *
 * 纯几何计算，不依赖 DOM：主窗四边为「边缘感应带」（厚度 = min(宽,高)/4，下限 32px），
 * 带内命中对应边（角落取深入量更小的方向，先横后纵）；中央区并入 tabs 组。
 * 落点视觉反馈（1/2 悬浮预览高亮）由 DockShell 渲染，本模块只输出 side。
 */

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** 边缘感应带最小厚度（px）：小窗口下保证可命中 */
const MIN_BAND_PX = 32

/**
 * 判定指针在容器内的落点：
 * - 中心带（四边均深入 ≥ band）→ 'center'；
 * - 边缘带 → 距哪条边最近命中哪条（角落先横后纵）；
 * - 指针越界（负深入）→ 取最近边（拖出窗口边缘时吸附该侧）。
 */
export function computeDropSide(rect: Rect, x: number, y: number): DropSide {
  const band = Math.max(Math.min(rect.width, rect.height) / 4, MIN_BAND_PX)
  const dxLeft = x - rect.left
  const dxRight = rect.left + rect.width - x
  const dyTop = y - rect.top
  const dyBottom = rect.top + rect.height - y
  if (dxLeft >= band && dxRight >= band && dyTop >= band && dyBottom >= band) return 'center'
  const min = Math.min(dxLeft, dxRight, dyTop, dyBottom)
  if (min === dxLeft) return 'left'
  if (min === dxRight) return 'right'
  if (min === dyTop) return 'top'
  return 'bottom'
}
