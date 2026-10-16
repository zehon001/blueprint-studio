/**
 * 2D 视口几何纯函数（T1.3 · PLAN §7.2）
 *
 * 全部为无副作用纯函数，供 UIEditorPanel（交互）与 viewport.test.ts（单测）共用：
 * - 坐标换算：screen ⇄ canvas（含缩放 scale 与平移 pan，画布坐标系 = UI 根节点坐标系）；
 * - 框选 / 命中：矩形相交、点命中（命中取面积最小的最内层节点，同面积取 DOM 序靠后者）；
 * - 对齐吸附：拖动时以其它节点包围盒（左/中/右、上/中/下）与画布中心为吸附目标，
 *   阈值内自动贴齐并产出吸附线（overlay 绘制）；
 * - 对齐分布：左/水平居中/右、上/垂直居中/下对齐 + 水平/垂直等距分布（按包围盒中心均分）；
 * - 名称唯一化：树内唯一名去重（复制 / 新建节点用）。
 *
 * 依赖注入：Vec2 复用全局契约 src/ir/types.ts（蓝图画布坐标与 UI 节点位置共用）。
 */
import type { Vec2 } from '../../ir/types';

/** 视口缩放范围（PLAN §7.2：0.25 ~ 4） */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/** 对齐吸附线触发阈值（画布 px；任务卡：阈值 6px 画线） */
export const SNAP_THRESHOLD = 6;

/** 轴对齐矩形（画布坐标；x/y 为左上角） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 视口变换：画布 → 屏幕 = translate(x, y) ∘ scale(s)（transform-origin 0 0） */
export interface ViewTransform {
  /** 平移 x（屏幕 px） */
  x: number;
  /** 平移 y（屏幕 px） */
  y: number;
  /** 缩放倍率 */
  scale: number;
}

/** 命中测试 / 框选的条目（id = UINode.id，rect = 画布坐标包围盒） */
export interface PickEntry {
  id: string;
  rect: Rect;
}

/** 吸附线（画布坐标；axis='x' 为竖直线 at=线 x 坐标，from/to 为线段纵轴范围） */
export interface SnapLine {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

/** 对齐 / 分布模式（视口对齐工具条；distribute 按包围盒中心均分） */
export type ViewAlignMode =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'vcenter'
  | 'bottom'
  | 'distribute-h'
  | 'distribute-v';

/** 对齐计算的输入条目：position = 节点 transform.position（提交写回目标），box = 画布包围盒 */
export interface AlignEntry {
  id: string;
  position: Vec2;
  box: Rect;
}

/* ============================================================
 * 视图变换（缩放 / 平移 / 坐标换算）
 * ============================================================ */

/** 缩放钳制到 [MIN_SCALE, MAX_SCALE]（非有限值回落 1） */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 屏幕 → 画布坐标换算：canvas = (screen - origin - pan) / scale。
 * origin 为视口容器左上角的屏幕坐标（测试可传 {0,0}；默认 {0,0}）。
 */
export function screenToCanvas(
  p: Vec2,
  view: ViewTransform,
  origin: Vec2 = { x: 0, y: 0 },
): Vec2 {
  return {
    x: (p.x - origin.x - view.x) / view.scale,
    y: (p.y - origin.y - view.y) / view.scale,
  };
}

/** 画布 → 屏幕坐标换算（screenToCanvas 的逆） */
export function canvasToScreen(
  p: Vec2,
  view: ViewTransform,
  origin: Vec2 = { x: 0, y: 0 },
): Vec2 {
  return {
    x: origin.x + view.x + p.x * view.scale,
    y: origin.y + view.y + p.y * view.scale,
  };
}

/**
 * 以光标为中心缩放：光标下的画布点缩放前后屏幕位置不变。
 * factor 为缩放系数（>1 放大），结果 scale 钳制在 [MIN_SCALE, MAX_SCALE]。
 */
export function zoomAt(screenPt: Vec2, view: ViewTransform, factor: number): ViewTransform {
  const scale = clampScale(view.scale * (Number.isFinite(factor) ? factor : 1));
  const canvasPt = {
    x: (screenPt.x - view.x) / view.scale,
    y: (screenPt.y - view.y) / view.scale,
  };
  return {
    scale,
    x: screenPt.x - canvasPt.x * scale,
    y: screenPt.y - canvasPt.y * scale,
  };
}

/** DOM clientRect（屏幕坐标）→ 画布坐标矩形（origin = 视口容器左上角屏幕坐标） */
export function clientRectToCanvas(
  r: { left: number; top: number; width: number; height: number },
  view: ViewTransform,
  origin: Vec2 = { x: 0, y: 0 },
): Rect {
  const p0 = screenToCanvas({ x: r.left, y: r.top }, view, origin);
  const p1 = screenToCanvas({ x: r.left + r.width, y: r.top + r.height }, view, origin);
  return normalizeRect(p0, p1);
}

/* ============================================================
 * 矩形基础
 * ============================================================ */

/** 点是否在矩形内（含边界） */
export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** 两矩形是否相交（重叠面积为正；仅边缘相切不算，零面积矩形不相交） */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.w > 0 &&
    b.w > 0 &&
    a.h > 0 &&
    b.h > 0 &&
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/** 两点归一化为矩形（左上角 + 宽高；支持反向拖拽） */
export function normalizeRect(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** 矩形平移（返回新矩形） */
export function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
}

/** 矩形并集（空数组返回 null） */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ============================================================
 * 命中 / 框选
 * ============================================================ */

/**
 * 点命中测试：返回命中的节点 id（无命中返回 null）。
 * 多个包围盒同时包含该点时取面积最小者（最内层节点）；
 * 面积并列取数组序靠后者（DOM 前序遍历中靠后 = 更深层/更上层渲染）。
 * 零面积矩形（display:none / 未量出尺寸）不参与命中。
 * entries 需按 DOM 遍历序传入（视口 measure 产物即该顺序）。
 */
export function hitTest(point: Vec2, entries: readonly PickEntry[]): string | null {
  let best: { id: string; area: number; index: number } | null = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.rect.w <= 0 || e.rect.h <= 0) continue;
    if (!rectContainsPoint(e.rect, point)) continue;
    const area = e.rect.w * e.rect.h;
    if (best === null || area <= best.area) best = { id: e.id, area, index: i };
  }
  return best ? best.id : null;
}

/** 框选：返回与 rect 相交的全部条目（保持传入顺序；零面积条目不参与） */
export function selectByRect(entries: readonly PickEntry[], rect: Rect): PickEntry[] {
  return entries.filter((e) => rectsIntersect(e.rect, rect));
}

/* ============================================================
 * 对齐吸附线
 * ============================================================ */

interface SnapBest {
  diff: number;
  at: number;
  ref: number;
  from: number;
  to: number;
}

/**
 * 对齐吸附求解（纯函数）：拖动中的包围盒 moving 与其它包围盒 others 求解吸附。
 * - 参考点：moving 的 左/中心/右（x 轴）、上/中心/下（y 轴）；
 * - 吸附目标：others 的 左/中心/右、上/中心/下（调用方把「画布中心」以根节点包围盒
 *   形式并入 others 即可获得画布中心吸附）；
 * - 每轴取 |差| 最小且 ≤ threshold 的一条吸附（dx = 目标 - 参考值），并产出吸附线
 *   （线段纵向覆盖 moving 与命中目标的并集范围）。
 * 返回 { dx, dy, lines }：dx/dy 为贴齐修正量（叠加到拖动位移），lines 供 overlay 绘制。
 */
export function resolveSnap(
  moving: Rect,
  others: readonly Rect[],
  threshold: number = SNAP_THRESHOLD,
): { dx: number; dy: number; lines: SnapLine[] } {
  const lines: SnapLine[] = [];
  const snapAxis = (axis: 'x' | 'y'): number => {
    const m0 = axis === 'x' ? moving.x : moving.y;
    const m1 = axis === 'x' ? moving.x + moving.w : moving.y + moving.h;
    const mc = (m0 + m1) / 2;
    const refs = [m0, mc, m1];
    let best: SnapBest | null = null;
    for (const o of others) {
      if (o.w <= 0 || o.h <= 0) continue;
      const o0 = axis === 'x' ? o.x : o.y;
      const o1 = axis === 'x' ? o.x + o.w : o.y + o.h;
      const oc = (o0 + o1) / 2;
      for (const ref of refs) {
        for (const cand of [o0, oc, o1]) {
          const diff = Math.abs(cand - ref);
          if (diff > threshold) continue;
          if (best === null || diff < best.diff) {
            best = {
              diff,
              at: cand,
              ref,
              from: Math.min(m0, o0),
              to: Math.max(m1, o1),
            };
          }
        }
      }
    }
    if (!best) return 0;
    lines.push({ axis, at: best.at, from: best.from, to: best.to });
    return best.at - best.ref;
  };
  const dx = snapAxis('x');
  const dy = snapAxis('y');
  return { dx, dy, lines };
}

/* ============================================================
 * 对齐 / 分布（视口对齐工具条）
 * ============================================================ */

/**
 * 对齐 / 分布位置计算（纯函数）：
 * - left/right/top/bottom：取选中包围盒并集的对应边缘对齐；
 * - hcenter/vcenter：对齐并集的中心线；
 * - distribute-h/v：按包围盒中心排序后首尾不动、中间等距分布（< 3 个返回空 Map）。
 * 结果 = 调整后的 transform.position（用 box 与 position 的差量平移，兼容旋转包围盒）。
 * 条目 < 2 时返回空 Map（无可对齐目标）。
 */
export function computeAlignment(
  entries: readonly AlignEntry[],
  mode: ViewAlignMode,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (entries.length < 2) return out;
  const bbox = unionRects(entries.map((e) => e.box));
  if (!bbox) return out;

  if (mode === 'left' || mode === 'right' || mode === 'hcenter') {
    const target =
      mode === 'left' ? bbox.x : mode === 'right' ? bbox.x + bbox.w : bbox.x + bbox.w / 2;
    for (const e of entries) {
      const ref =
        mode === 'left' ? e.box.x : mode === 'right' ? e.box.x + e.box.w : e.box.x + e.box.w / 2;
      out.set(e.id, { x: e.position.x + (target - ref), y: e.position.y });
    }
    return out;
  }
  if (mode === 'top' || mode === 'bottom' || mode === 'vcenter') {
    const target =
      mode === 'top' ? bbox.y : mode === 'bottom' ? bbox.y + bbox.h : bbox.y + bbox.h / 2;
    for (const e of entries) {
      const ref =
        mode === 'top' ? e.box.y : mode === 'bottom' ? e.box.y + e.box.h : e.box.y + e.box.h / 2;
      out.set(e.id, { x: e.position.x, y: e.position.y + (target - ref) });
    }
    return out;
  }

  // 等距分布：按包围盒中心排序，首尾不动、中间均匀（< 3 个不分布）
  const axis = mode === 'distribute-h' ? 'x' : 'y';
  if (entries.length < 3) return out;
  const centerOf = (e: AlignEntry): number =>
    axis === 'x' ? e.box.x + e.box.w / 2 : e.box.y + e.box.h / 2;
  const sorted = [...entries].sort((a, b) => centerOf(a) - centerOf(b));
  const first = centerOf(sorted[0]);
  const last = centerOf(sorted[sorted.length - 1]);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const target = first + ((last - first) * i) / (sorted.length - 1);
    const delta = target - centerOf(e);
    out.set(
      e.id,
      axis === 'x'
        ? { x: e.position.x + delta, y: e.position.y }
        : { x: e.position.x, y: e.position.y + delta },
    );
  }
  return out;
}

/* ============================================================
 * 名称唯一化（复制 / 新建节点）
 * ============================================================ */

/**
 * 树内唯一名去重：base 未被占用则原样返回；否则追加序号（base2、base3…）。
 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const name = `${base}${i}`;
    if (!taken.has(name)) return name;
  }
}
