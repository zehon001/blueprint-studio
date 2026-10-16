/**
 * Blueprint Studio v2 —— 注释框模块导出入口（T2.7 / ADR-006，PLAN §8.1）
 *
 * - model：几何判定（containsNode / rectsIntersect）/ bounds 钳制 / 选中 id 前缀 /
 *   预设色板（node:test 可直接单测）；
 * - CommentLayer：画布视口图层（BlueprintEditorPanel 作为 BPGraphCanvas children 挂载）；
 * - CommentBox：注释单体（标题拖拽移动含节点 / 四角 resize / 双击编辑 / 右键菜单请求）；
 * - CommentContextMenu：注释右键菜单（改颜色 / 大小重置 / 删除，由面板按 store.menu 渲染）。
 *
 * 本 barrel 不引样式；comment.css 由 BlueprintEditorPanel 统一引入
 * （叶子组件可在 node:test 加载的约定，见 interaction/index.ts 同款说明）。
 */
export {
  clampCommentBounds,
  commentIdFromSelectionId,
  commentSelectionId,
  COMMENT_PRESET_COLORS,
  COMMENT_SELECTION_PREFIX,
  commentsOf,
  containedNodeIds,
  containsNode,
  DEFAULT_COMMENT_SIZE,
  estimatedNodeSizeOf,
  MIN_COMMENT_SIZE,
  rectsIntersect,
  staggeredCommentPosition,
} from './model';
export type { CommentPresetColor, CommentRect, NodeSizeResolver } from './model';
export { CommentBox, type CommentBoxProps } from './CommentBox';
export { CommentLayer } from './CommentLayer';
export { CommentContextMenu, type CommentContextMenuProps } from './CommentContextMenu';
