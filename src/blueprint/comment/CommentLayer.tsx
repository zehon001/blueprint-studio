/**
 * Blueprint Studio v2 —— 注释框图层（T2.7 / ADR-006，PLAN §8.1「注释框 Comment」）
 *
 * 经 @xyflow/react 的 ViewportPortal 渲染进画布视口（随平移缩放同步），
 * 图层 z-index 压在连线 / 节点之下（.bp-comment-layer，见 comment.css）——
 * 注释是画布最底层的视觉容器，节点点击 / 框选不受其影响（UE5 同款）。
 *
 * 由 BlueprintEditorPanel 作为 BPGraphCanvas 的 children 挂载
 * （须在 ReactFlow 内部才能拿到视口上下文）。
 */
import { ViewportPortal } from '@xyflow/react';
import { useBlueprintStore } from '../store/blueprint-store';
import { commentsOf, commentSelectionId } from './model';
import { CommentBox } from './CommentBox';

/** 注释框图层（当前图的全部注释） */
export function CommentLayer() {
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const selectionNodeIds = useBlueprintStore((s) => s.selection.nodeIds);
  const comments = commentsOf(asset, graphName);
  const selectedIds = new Set(selectionNodeIds);
  return (
    <ViewportPortal>
      <div className="bp-comment-layer">
        {comments.map((comment) => (
          <CommentBox
            key={comment.id}
            comment={comment}
            selected={selectedIds.has(commentSelectionId(comment.id))}
          />
        ))}
      </div>
    </ViewportPortal>
  );
}
