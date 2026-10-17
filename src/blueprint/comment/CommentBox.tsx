/**
 * Blueprint Studio v2 —— 注释框单体组件（T2.7 / ADR-006，PLAN §8.1「注释框 Comment」）
 *
 * UE5 同款交互：
 *  - 半透明矩形 + 顶部标题栏；标题栏按下即选中（Shift = 加选切换）；
 *  - 拖标题移动 bounds，**完全包含**在注释内的节点实时预览随动、松手一次命令入库
 *    （store.moveComment：注释 bounds + 节点位置同一命令，撤销一步全还原）；
 *    相交但不完全包含的节点不动；节点本体在注释之上，点击 / 框选不受注释影响
 *    （本体 pointer-events: none，见 comment.css）；
 *  - 拖四角 resize（对角固定、最小尺寸钳制；只改注释框，内含节点不动）；
 *  - 双击标题 → 行内编辑文本（Enter/失焦提交，Esc 取消）；
 *  - 右键标题 → 画布弹出菜单（store.menu kind 'comment'，菜单由 BlueprintEditorPanel 渲染）。
 *
 * 注意：本组件不 import 样式（node:test 环境 tsx 无法加载 .css）；comment.css 由
 * BlueprintEditorPanel 统一引入。渲染位置：CommentLayer 经 ViewportPortal 进入
 * 画布视口层（随平移缩放），层级压在连线 / 节点之下（z-index: -1）。
 */
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { NodeDragItem } from '@xyflow/system';
import type { IRComment, IRNode, NodeSpec, Vec2 } from '../../ir/types';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  commentSelectionId,
  containedNodeIds,
  estimatedNodeSizeOf,
  MIN_COMMENT_SIZE,
  type CommentRect,
  type NodeSizeResolver,
} from './model';

/** resize 手柄方位（四角；字母组合 = 拖动的边） */
type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

/** 拖拽会话快照（pointerdown 采样，pointermove 预览，pointerup 提交） */
interface DragSession {
  kind: 'move' | 'resize';
  handle: ResizeHandle | null;
  /** pointerdown 时的画布坐标（delta 计算基准） */
  startFlow: Vec2;
  /** 注释 bounds 快照（拖拽基准） */
  origin: CommentRect;
  /** 内含节点 id（按下时按「完全包含」判定） */
  contained: string[];
  /** 内含节点起始位置（预览回填用） */
  startPositions: Map<string, Vec2>;
  /** 节点实测尺寸表（提交给 store.moveComment 复算包含判定） */
  sizes: Map<string, { width: number; height: number }>;
  /** 是否发生位移（未位移的 pointerup 不产生命令） */
  moved: boolean;
}

export interface CommentBoxProps {
  /** 注释数据（IR 真源；拖拽预览态由本组件本地 draft 覆盖显示） */
  comment: IRComment;
  /** 是否选中（选中集含 'comment:<id>'） */
  selected: boolean;
}

/** 从 ReactFlow 内部状态采样节点矩形：实测尺寸优先，按头变体估算兜底 */
function sampleNodeRects(
  specs: ReadonlyMap<string, NodeSpec>,
  graphNodes: readonly IRNode[],
  nodeLookup: ReadonlyMap<string, { measured?: { width?: number; height?: number } }>,
): { sizes: Map<string, { width: number; height: number }>; positions: Map<string, Vec2> } {
  const fallback = estimatedNodeSizeOf(specs);
  const sizes = new Map<string, { width: number; height: number }>();
  const positions = new Map<string, Vec2>();
  for (const node of graphNodes) {
    const measured = nodeLookup.get(node.id)?.measured;
    const estimated = fallback(node);
    sizes.set(node.id, {
      width: measured?.width && measured.width > 0 ? measured.width : estimated.width,
      height: measured?.height && measured.height > 0 ? measured.height : estimated.height,
    });
    positions.set(node.id, { x: node.position.x, y: node.position.y });
  }
  return { sizes, positions };
}

/** 右键事件的最小形状（React 合成事件与原生事件共有字段） */
interface ContextMenuEventShim {
  preventDefault(): void;
  stopPropagation(): void;
  clientX: number;
  clientY: number;
}

export function CommentBox({ comment, selected }: CommentBoxProps) {
  const rf = useReactFlow();
  const rfStore = useStoreApi();
  const [draft, setDraft] = useState<CommentRect | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);
  const sessionRef = useRef<DragSession | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const bounds = draft ?? comment.bounds;

  /** pointermove 通用：按会话类别更新 draft + 内含节点预览 */
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const session = sessionRef.current;
    if (!session) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const dx = p.x - session.startFlow.x;
    const dy = p.y - session.startFlow.y;
    if (!session.moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    session.moved = true;

    if (session.kind === 'move') {
      setDraft({
        x: session.origin.x + dx,
        y: session.origin.y + dy,
        w: session.origin.w,
        h: session.origin.h,
      });
      // 内含节点实时预览：updateNodePositions → onNodesChange → 视图本地态（不写 store /
      // 命令栈）；松手由 moveComment 一次命令落库（预览随即被 IR 镜像同步覆盖）
      // 内含节点实时预览：updateNodePositions → onNodesChange → 视图本地态（不写 store /
      // 命令栈）；松手由 moveComment 一次命令落库（预览随即被 IR 镜像同步覆盖）。
      // NodeDragItem 的简化形：updateNodePositions 运行时只读 position（无 parentId 时不读
      // internals/measured），故此处只传 { x, y } 并按形参类型断言。
      const dragItems = new Map<string, NodeDragItem>(
        session.contained.map((id) => {
          const start = session.startPositions.get(id) ?? { x: 0, y: 0 };
          return [id, { x: start.x + dx, y: start.y + dy } as unknown as NodeDragItem];
        }),
      );
      if (dragItems.size > 0) rfStore.getState().updateNodePositions(dragItems, true);
      return;
    }

    // resize：拖角方向决定动哪两条边；最小尺寸钳制时保持对角固定
    const handle = session.handle ?? 'se';
    let x = session.origin.x;
    let y = session.origin.y;
    let w = handle.includes('e') ? session.origin.w + dx : session.origin.w - dx;
    let h = handle.includes('s') ? session.origin.h + dy : session.origin.h - dy;
    if (handle.includes('w')) x = session.origin.x + dx;
    if (handle.includes('n')) y = session.origin.y + dy;
    if (w < MIN_COMMENT_SIZE.w) {
      w = MIN_COMMENT_SIZE.w;
      if (handle.includes('w')) x = session.origin.x + session.origin.w - MIN_COMMENT_SIZE.w;
    }
    if (h < MIN_COMMENT_SIZE.h) {
      h = MIN_COMMENT_SIZE.h;
      if (handle.includes('n')) y = session.origin.y + session.origin.h - MIN_COMMENT_SIZE.h;
    }
    setDraft({ x, y, w, h });
  };

  /** pointerup / cancel：位移过则一次命令入库（move 含节点随动） */
  const endSession = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // 捕获已隐式释放：忽略
    }
    if (!session || !session.moved || !draft) {
      setDraft(null);
      return;
    }
    const st = useBlueprintStore.getState();
    if (session.kind === 'move') st.moveComment(comment.id, draft, session.sizes);
    else st.resizeComment(comment.id, draft);
    setDraft(null);
  };

  /** 标题按下：选中（Shift 加选切换）+ 开始移动会话 */
  const onTitlePointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    const st = useBlueprintStore.getState();
    const selId = commentSelectionId(comment.id);
    const already = st.selection.nodeIds.includes(selId);
    if (e.shiftKey) {
      st.setSelection({
        nodeIds: already
          ? st.selection.nodeIds.filter((id) => id !== selId)
          : [...st.selection.nodeIds, selId],
        edgeIds: st.selection.edgeIds,
      });
    } else if (!already) {
      st.setSelection({ nodeIds: [selId], edgeIds: [] });
    }
    // 采样图节点（store 内为移动前位置）+ 实测尺寸 → 包含判定与预览基准
    const graphNodes = st.asset?.graphs[st.graphName]?.nodes ?? [];
    const { sizes, positions } = sampleNodeRects(st.specs, graphNodes, rfStore.getState().nodeLookup);
    const sizeOf: NodeSizeResolver = (node) => sizes.get(node.id) ?? estimatedNodeSizeOf(st.specs)(node);
    sessionRef.current = {
      kind: 'move',
      handle: null,
      startFlow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      origin: { ...comment.bounds },
      contained: containedNodeIds(comment.bounds, graphNodes, sizeOf),
      startPositions: positions,
      sizes,
      moved: false,
    };
    // 捕获在标题元素上（pointer-events: auto 的可命中元素；root 本体是穿透层）
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** 角部按下：开始 resize 会话（对角固定） */
  const onHandlePointerDown = (handle: ResizeHandle) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || editing) return;
    e.stopPropagation();
    sessionRef.current = {
      kind: 'resize',
      handle,
      startFlow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      origin: { ...comment.bounds },
      contained: [],
      startPositions: new Map(),
      sizes: new Map(),
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** 双击标题 → 行内编辑 */
  const startEdit = (): void => {
    setEditText(comment.text);
    setEditing(true);
  };

  const commitEdit = (): void => {
    if (!editing) return;
    if (useBlueprintStore.getState().setCommentText(comment.id, editText)) {
      setEditing(false); // 空文本被拒时保持编辑态（store 已弹提示）
    }
  };

  const cancelEdit = (): void => {
    setEditing(false);
  };

  /** 右键标题 → 注释菜单（先选中；菜单由面板按 store.menu 渲染） */
  const onContextMenu = (e: ContextMenuEventShim): void => {
    e.preventDefault();
    e.stopPropagation();
    const st = useBlueprintStore.getState();
    const selId = commentSelectionId(comment.id);
    if (!st.selection.nodeIds.includes(selId)) {
      st.setSelection({ nodeIds: [selId], edgeIds: [] });
    }
    st.openMenu({
      kind: 'comment',
      commentId: comment.id,
      screen: { x: e.clientX, y: e.clientY },
      flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    });
  };

  const className = [
    'bp-comment',
    selected ? 'bp-comment--selected' : '',
    comment.color ? 'bp-comment--tinted' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const style: CSSProperties = {
    left: bounds.x,
    top: bounds.y,
    width: bounds.w,
    height: bounds.h,
    ...(comment.color ? ({ '--comment-color': comment.color } as CSSProperties) : {}),
  };

  return (
    <div
      ref={rootRef}
      className={className}
      style={style}
      data-comment-id={comment.id}
      onPointerMove={onPointerMove}
      onPointerUp={endSession}
      onPointerCancel={endSession}
    >
      <div
        className="bp-comment-title"
        title={comment.text}
        onPointerDown={onTitlePointerDown}
        onDoubleClick={startEdit}
        onContextMenu={onContextMenu}
      >
        {editing ? (
          <input
            className="bp-comment-input"
            value={editText}
            autoFocus
            aria-label="注释文本"
            onChange={(e) => setEditText(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitEdit();
              else if (e.key === 'Escape') cancelEdit();
            }}
            onBlur={commitEdit}
          />
        ) : (
          <span className="bp-comment-text">{comment.text}</span>
        )}
      </div>
      {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
        <div
          key={handle}
          className={`bp-comment-handle bp-comment-handle--${handle}`}
          onPointerDown={onHandlePointerDown(handle)}
        />
      ))}
    </div>
  );
}
