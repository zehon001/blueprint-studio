/**
 * Blueprint Studio v2 —— 注释框纯函数层（T2.7 / ADR-006，PLAN §8.1「注释框 Comment」）
 *
 * 无 React / DOM 依赖（node:test 可直接单测）：几何判定（containsNode 完全包含 /
 * rectsIntersect 相交）、bounds 钳制、选中 id 前缀换算、预设色板。
 * 组件层（CommentBox / CommentLayer / CommentContextMenu）与 store
 * （blueprint-store 的 comment actions）一律从本模块取纯函数。
 *
 * UE5 行为口径：
 *  - 注释框拖动只迁移「完全包含在注释 bounds 内」的节点（相交但不完全包含的不动）；
 *  - 节点尺寸以「实测尺寸（ReactFlow measured）优先、按节点头变体估算兜底」解析，
 *    由调用方通过 sizeOf 回调注入，本模块不做 DOM 测量。
 *
 * 契约真源：src/ir/types.ts（IRComment / IRCommentBounds）；
 * 取色真源：src/shell/theme/tokens.ts（预设色板由既有 token 值组成，不新增硬编码色）。
 */
import type { IRComment, IRNode, NodeSpec, Vec2 } from '../../ir/types';
import { headVariantFor, nodeSizeFor } from '../view/model';

/** 注释框矩形（与 IRCommentBounds 同构；图坐标） */
export interface CommentRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 新建注释框的默认尺寸（UE 同款「框住一段逻辑」的起步大小） */
export const DEFAULT_COMMENT_SIZE = { w: 360, h: 220 } as const;

/** 注释框最小尺寸（resize 钳制下限；高不小于标题栏） */
export const MIN_COMMENT_SIZE = { w: 120, h: 44 } as const;

/* ============================================================
 * 1. 几何判定（UE5 containment 语义）
 * ============================================================ */

/**
 * 节点矩形是否被注释框「完全包含」（边界相切算包含，UE 同款）。
 * nodeRect = 节点左上角坐标 + 实测/估算宽高。
 */
export function containsNode(comment: CommentRect, nodeRect: { x: number; y: number; w: number; h: number }): boolean {
  return (
    nodeRect.x >= comment.x &&
    nodeRect.y >= comment.y &&
    nodeRect.x + nodeRect.w <= comment.x + comment.w &&
    nodeRect.y + nodeRect.h <= comment.y + comment.h
  );
}

/** 两矩形是否相交（仅重叠面积 > 0；贴边不算相交） */
export function rectsIntersect(a: CommentRect, b: CommentRect): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

/** 节点尺寸解析回调：返回节点的宽高（实测优先；估算兜底） */
export type NodeSizeResolver = (node: IRNode) => { width: number; height: number };

/**
 * 默认尺寸解析器：按节点头变体取估算尺寸（irToFlow 的 dagre 布局同源口径）。
 * 无 spec（未知节点）→ 常规节点尺寸。
 */
export function estimatedNodeSizeOf(specs: ReadonlyMap<string, NodeSpec>): NodeSizeResolver {
  return (node) => nodeSizeFor(headVariantFor(node.type, specs.get(node.type) ?? null));
}

/**
 * 计算被注释框**完全包含**的节点 id 列表（按 graph.nodes 顺序，稳定）。
 * sizeOf 未传时用 estimatedNodeSizeOf 的保守估算（调用方应尽量传实测尺寸）。
 */
export function containedNodeIds(
  bounds: CommentRect,
  nodes: readonly IRNode[],
  sizeOf?: NodeSizeResolver,
): string[] {
  const resolve: NodeSizeResolver = sizeOf ?? estimatedNodeSizeOf(new Map<string, NodeSpec>());
  const out: string[] = [];
  for (const node of nodes) {
    const size = resolve(node);
    if (containsNode(bounds, { x: node.position.x, y: node.position.y, w: size.width, h: size.height })) {
      out.push(node.id);
    }
  }
  return out;
}

/* ============================================================
 * 2. bounds 钳制 / 键序规范化
 * ============================================================ */

/** 数字兜底（非法回落 0） */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 规范化 + 钳制注释 bounds：非法数字回落 0，宽高不小于 MIN_COMMENT_SIZE。
 * 返回新对象（不修改入参）；字段序固定 x/y/w/h。
 */
export function clampCommentBounds(bounds: Partial<CommentRect> | null | undefined): CommentRect {
  const raw = bounds ?? {};
  const w = Math.max(MIN_COMMENT_SIZE.w, num(raw.w) || MIN_COMMENT_SIZE.w);
  const h = Math.max(MIN_COMMENT_SIZE.h, num(raw.h) || MIN_COMMENT_SIZE.h);
  return { x: num(raw.x), y: num(raw.y), w, h };
}

/* ============================================================
 * 3. 选中集 id 前缀（注释与节点共存于 selection.nodeIds 的命名空间）
 * ============================================================ */

/** 注释在选中集中的 id 前缀（'comment:<注释 id>'；与节点实例 id 空间隔离） */
export const COMMENT_SELECTION_PREFIX = 'comment:';

/** 注释 id → 选中集 id（'comment:<id>'） */
export function commentSelectionId(commentId: string): string {
  return `${COMMENT_SELECTION_PREFIX}${commentId}`;
}

/** 选中集 id → 注释 id（非注释 id 返回 null） */
export function commentIdFromSelectionId(selectionId: string): string | null {
  return selectionId.startsWith(COMMENT_SELECTION_PREFIX)
    ? selectionId.slice(COMMENT_SELECTION_PREFIX.length)
    : null;
}

/* ============================================================
 * 4. 预设色板（UE5 注释常用色；取值复用主题 token 的原始值，不自造色值）
 * ============================================================ */

/** 预设色板条目（value 存入 IRComment.color；label 为中文 tooltip） */
export interface CommentPresetColor {
  value: string;
  label: string;
}

/**
 * 预设色板 6 色（DoD 3「预设色板 6 色 + 自定义 color input」）。
 * 原始值取自 theme.css 同名 token（JS 侧经 rawToken，与 CSS 保持同源）。
 */
export const COMMENT_PRESET_COLORS: readonly CommentPresetColor[] = [
  { value: '#4f8cc9', label: '蓝色' }, // --accent
  { value: '#67c06b', label: '绿色' }, // --success
  { value: '#e2b34a', label: '黄色' }, // --warning
  { value: '#e05c5c', label: '红色' }, // --error
  { value: '#8b3fbf', label: '紫色' }, // --node-head-plugin
  { value: '#9e9e9e', label: '灰色' }, // --text-dim
];

/* ============================================================
 * 5. 其他小工具
 * ============================================================ */

/** 当前图的注释列表（无注释返回空数组，不返回 undefined，便于组件直 map） */
export function commentsOf(
  asset: { graphs: Record<string, { comments?: IRComment[] }> } | null,
  graphName: string,
): IRComment[] {
  return asset?.graphs[graphName]?.comments ?? [];
}

/** My Blueprint「＋新建注释」的兜底落点（无光标位置时按注释数错开） */
export function staggeredCommentPosition(count: number): Vec2 {
  const slot = count % 8;
  return { x: 80 + slot * 40, y: 60 + slot * 36 };
}
