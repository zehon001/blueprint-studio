/**
 * Blueprint Studio v2 —— 画布交互钩子（T2.2，PLAN §8.2 交互复刻清单）
 *
 * 把 store（命令栈）与 ReactFlow 回调接线，须在 ReactFlowProvider 内调用：
 *  - 视图同步：IR（域状态镜像）→ FlowNode/FlowEdge；选中集双向同步；
 *  - 连线：isValidConnection 预检（exec↔data 不互吸）→ onConnect 建线 /
 *    自动插转换节点 / 拒绝抖动；
 *  - 引脚拖出松开在空白 → 兼容菜单（PinDragMenu 数据）；
 *  - 节点拖动：普通拖动落 moveNodes 命令；Ctrl+拖拽 = 复制到落点（原位保留）；
 *  - 键盘：Tab 搜索 / Esc / Delete / Ctrl+C/X/V/D/A（undo/redo/Ctrl+S 走全局 keymap）；
 *  - Alt+点击引脚断开全部连线（事件委托，不改 BPNode）；
 *  - undo/redo（subscribeReplay）→ refreshFromDomain 刷新镜像 → 重生成视图。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  type EdgeChange,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnMoveStart,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import { subscribeReplay } from '../../shell/commands';
// 直接取纯模型层（不经 view/index barrel：barrel 含 BPGraphCanvas 及其 .css import，
// 会让 node:test 环境（tsx 无法加载 .css）无法挂载冒烟本钩子
import {
  DEFAULT_NODE_SIZE,
  irToFlow,
} from '../view/model';
import type { FlowEdge, FlowNode } from '../view/model';
import { useBlueprintStore, type BlueprintSelection } from '../store/blueprint-store';
import { isConnectionShapeValid, resolvePinRef } from './logic';
import type { Vec2 } from '../../ir/types';

/** 菜单定位 / 连线结束的事件来源（原生与 React 合成事件统一取坐标） */
type PointerEventLike = MouseEvent | ReactMouseEvent | TouchEvent;

/** 从鼠标 / 触摸事件取屏幕坐标 */
function clientOf(event: PointerEventLike): Vec2 {
  if ('changedTouches' in event && event.changedTouches.length > 0) {
    const touch = event.changedTouches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  if ('touches' in event && event.touches.length > 0) {
    const touch = event.touches[0];
    return { x: touch.clientX, y: touch.clientY };
  }
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  return { x: 0, y: 0 };
}

/** 目标是否为文本输入类元素（快捷键不抢输入框焦点） */
function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function selectionEquals(a: BlueprintSelection, b: BlueprintSelection): boolean {
  return (
    a.nodeIds.length === b.nodeIds.length &&
    a.edgeIds.length === b.edgeIds.length &&
    a.nodeIds.every((id) => b.nodeIds.includes(id)) &&
    a.edgeIds.every((id) => b.edgeIds.includes(id))
  );
}

/** 引脚内联默认值变更 → 命令栈（BPNode 内联编辑框回传；模块级稳定引用） */
function onPinDefaultChange(nodeId: string, pinId: string, value: unknown): void {
  useBlueprintStore.getState().setPinDefault(nodeId, pinId, value);
}

export interface CanvasInteractionApis {
  /** 画布受控节点（irToFlow 产出；拖拽期间本地应用变更） */
  nodes: FlowNode[];
  /** 画布受控连线 */
  edges: FlowEdge[];
  /** ReactFlow 回调包（透传 BPGraphCanvas 扩展 props） */
  handlers: {
    onNodesChange: OnNodesChange<FlowNode>;
    onEdgesChange: OnEdgesChange<FlowEdge>;
    onConnect: OnConnect;
    onConnectEnd: OnConnectEnd;
    onNodeDragStart: OnNodeDrag<FlowNode>;
    onNodeDragStop: OnNodeDrag<FlowNode>;
    onSelectionChange: OnSelectionChangeFunc<FlowNode, FlowEdge>;
    onPaneContextMenu: (event: ReactMouseEvent | MouseEvent) => void;
    onPaneClick: () => void;
    onMoveStart: OnMoveStart;
    onEdgeContextMenu: EdgeMouseHandler<FlowEdge>;
    isValidConnection: IsValidConnection<FlowEdge>;
  };
  /** 校验条跳转：切图 + 选中 + 居中节点 */
  jumpToNode(issueGraphName: string | undefined, nodeId?: string, edgeId?: string): void;
  /** 强制按 IR 重生成视图（Ctrl 拖拽位移过小时复位等场景） */
  syncFromAsset(): void;
}

/**
 * 画布交互钩子（T2.2）。Ctrl+S 保存经 keymap 重绑定（BlueprintEditorPanel 负责）。
 */
export function useCanvasInteractions(): CanvasInteractionApis {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const rfStore = useStoreApi();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  /** Ctrl 拖拽复制：拖拽起点位置表（dragStart 记录，dragStop 计算位移） */
  const ctrlDragRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  /** Shift 加选（§8.2 第 5 条）：Shift 键按住标记（ReactFlow 框选结果改为累加） */
  const shiftHeldRef = useRef(false);
  /** 框选开始前的既有选区快照（ReactFlow 框选默认整体替换，Shift 按住时合并它） */
  const boxBaseRef = useRef<BlueprintSelection | null>(null);

  /* ---------------- IR → 视图同步 ---------------- */

  const syncFromAsset = useCallback((): void => {
    const st = useBlueprintStore.getState();
    const graph = st.asset?.graphs[st.graphName];
    if (!st.asset || !graph) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const built = irToFlow(st.asset, st.specs, st.graphName, { onPinDefaultChange });
    const nodeSel = new Set(st.selection.nodeIds);
    const edgeSel = new Set(st.selection.edgeIds);
    setNodes(built.nodes.map((n) => (nodeSel.has(n.id) ? { ...n, selected: true } : n)));
    setEdges(built.edges.map((e) => (edgeSel.has(e.id) ? { ...e, selected: true } : e)));
  }, []);

  // 域状态镜像 / 图名 / 定义表变化 → 重生成视图（拖拽期间镜像不变，不干扰本地拖拽态）
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const specs = useBlueprintStore((s) => s.specs);
  useEffect(() => {
    syncFromAsset();
  }, [asset, graphName, specs, syncFromAsset]);

  // undo/redo 重放 → 刷新镜像（镜像变化经上方 effect 重生成视图）
  useEffect(
    () =>
      subscribeReplay((notice) => {
        if (notice.domains.includes('blueprint')) {
          useBlueprintStore.getState().refreshFromDomain();
        }
      }),
    [],
  );

  /* ---------------- 选中集双向同步 ---------------- */

  const selection = useBlueprintStore((s) => s.selection);
  useEffect(() => {
    // store 侧选中变化（框选同步 / 校验跳转 / 全选 / 复制）→ 应用到视图标记；
    // 标记已一致时不产生新数组（避免与 onSelectionChange 回环）
    setNodes((prev) => {
      if (prev.every((n) => (n.selected ?? false) === selection.nodeIds.includes(n.id))) return prev;
      const set = new Set(selection.nodeIds);
      return prev.map((n) =>
        set.has(n.id) === (n.selected ?? false) ? n : { ...n, selected: set.has(n.id) },
      );
    });
    setEdges((prev) => {
      if (prev.every((e) => (e.selected ?? false) === selection.edgeIds.includes(e.id))) return prev;
      const set = new Set(selection.edgeIds);
      return prev.map((e) =>
        set.has(e.id) === (e.selected ?? false) ? e : { ...e, selected: set.has(e.id) },
      );
    });
  }, [selection]);

  /** 视图选择变化 → store（框选 / 点选；内容相同不写避免回环） */
  const onSelectionChange = useCallback<OnSelectionChangeFunc<FlowNode, FlowEdge>>(
    ({ nodes: ns, edges: es }) => {
      const st = useBlueprintStore.getState();
      // Shift 框选加选（§8.2 第 5 条）：ReactFlow 框选默认整体替换选区，
      // Shift 按住时改为「框选前快照 ∪ 框选命中」（UE 同款累加语义）
      const base = boxBaseRef.current;
      let next: BlueprintSelection;
      if (base && shiftHeldRef.current) {
        const nodeSet = new Set(base.nodeIds);
        const edgeSet = new Set(base.edgeIds);
        for (const n of ns) nodeSet.add(n.id);
        for (const e of es) edgeSet.add(e.id);
        next = { nodeIds: [...nodeSet], edgeIds: [...edgeSet] };
      } else {
        next = { nodeIds: ns.map((n) => n.id), edgeIds: es.map((e) => e.id) };
      }
      if (selectionEquals(st.selection, next)) return;
      st.setSelection(next);
    },
    [],
  );

  /* ---------------- Shift 框选加选：键态跟踪 + 框选起止快照 ---------------- */

  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftHeldRef.current = true;
    };
    const onUp = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') shiftHeldRef.current = false;
    };
    const onClear = (): void => {
      // 失焦时 Shift 键态可能滞留（如切窗口后松开）：保守清零
      shiftHeldRef.current = false;
      boxBaseRef.current = null;
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onClear);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onClear);
    };
  }, []);

  useEffect(() => {
    // ReactFlow 内部框选矩形：出现（按下）→ 快照既有选区（此刻尚未被重置）；
    // 消失（松开/取消）→ 清快照。普通框选（无 Shift）保持整体替换语义。
    return rfStore.subscribe((state, prev) => {
      if (state.userSelectionRect && !prev.userSelectionRect) {
        boxBaseRef.current = useBlueprintStore.getState().selection;
      } else if (!state.userSelectionRect && prev.userSelectionRect) {
        boxBaseRef.current = null;
      }
    });
  }, [rfStore]);

  /* ---------------- ReactFlow 变更与拖动 ---------------- */

  const onNodesChange = useCallback<OnNodesChange<FlowNode>>(
    (changes: readonly NodeChange<FlowNode>[]) => {
      setNodes((prev) => applyNodeChanges(changes as NodeChange<FlowNode>[], prev));
    },
    [],
  );

  const onEdgesChange = useCallback<OnEdgesChange<FlowEdge>>(
    (changes: readonly EdgeChange<FlowEdge>[]) => {
      setEdges((prev) => applyEdgeChanges(changes as EdgeChange<FlowEdge>[], prev));
    },
    [],
  );

  const onNodeDragStart = useCallback<OnNodeDrag<FlowNode>>(
    (event, _node, dragged) => {
      // Ctrl/⌘ + 拖拽 = 复制（§8.2 第 6 条）：记录拖拽起点，dragStop 时按位移落新节点
      if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey)) {
        ctrlDragRef.current = new Map(
          dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }] as const),
        );
      }
    },
    [],
  );

  const onNodeDragStop = useCallback<OnNodeDrag<FlowNode>>(
    (event, node, dragged) => {
      const starts = ctrlDragRef.current;
      const isCtrl = event instanceof MouseEvent && (event.ctrlKey || event.metaKey);
      ctrlDragRef.current = null;
      const st = useBlueprintStore.getState();
      if (starts && isCtrl) {
        // Ctrl+拖拽复制：新节点落在拖拽终点，原位保留（命令后由镜像同步复位原节点的拖拽视觉位）
        const origin = starts.get(node.id) ?? node.position;
        const delta = { x: node.position.x - origin.x, y: node.position.y - origin.y };
        if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5) {
          syncFromAsset(); // 原位拖拽无意义：放弃并复位视图
          return;
        }
        st.duplicateSelection(delta);
        return;
      }
      // 普通拖动：终点位置写回 IR（单命令，可撤销）
      const moves = dragged.map((n) => ({ id: n.id, position: { x: n.position.x, y: n.position.y } }));
      if (moves.length > 0) st.moveNodes(moves);
    },
    [syncFromAsset],
  );

  /* ---------------- 连线（预检 / 建线 / 自动转换 / 兼容菜单） ---------------- */

  const isValidConnection = useCallback<IsValidConnection<FlowEdge>>(
    (edge) => {
      const st = useBlueprintStore.getState();
      const graph = st.asset?.graphs[st.graphName];
      if (!graph || !edge.source || !edge.target) return false;
      return isConnectionShapeValid(
        st.specs,
        graph.nodes,
        graph.edges,
        { node: edge.source, pin: edge.sourceHandle ?? 'exec' },
        { node: edge.target, pin: edge.targetHandle ?? 'exec' },
      );
    },
    [],
  );

  const onConnect = useCallback<OnConnect>((connection) => {
    if (!connection.source || !connection.target) return;
    useBlueprintStore.getState().connect(
      { node: connection.source, pin: connection.sourceHandle ?? 'exec' },
      { node: connection.target, pin: connection.targetHandle ?? 'exec' },
    );
  }, []);

  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, state: FinalConnectionState) => {
      const fromHandle = state.fromHandle;
      if (!fromHandle) return;
      const st = useBlueprintStore.getState();
      const point = clientOf(event);
      if (!state.toHandle) {
        // 松开在空白 → 兼容节点菜单（§8.2 第 2 条）
        const graph = st.asset?.graphs[st.graphName];
        const dir = fromHandle.type === 'source' ? ('out' as const) : ('in' as const);
        const from = graph
          ? resolvePinRef(st.specs, graph.nodes, fromHandle.nodeId, fromHandle.id ?? '', dir)
          : null;
        if (!from) return;
        st.openMenu({
          kind: 'pin',
          screen: point,
          flow: rf.screenToFlowPosition(point),
          from,
        });
      } else if (state.isValid === false) {
        // 落在不兼容引脚（exec↔data / 同节点 / 重复线）：抖动提示
        st.notify('无法连接：引脚类型不兼容或连线重复', 'error');
        st.shake();
      }
    },
    [rf],
  );

  /* ---------------- 画布菜单 / 平移 ---------------- */

  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      const st = useBlueprintStore.getState();
      const point = clientOf(event);
      st.openMenu({ kind: 'search', screen: point, flow: rf.screenToFlowPosition(point) });
    },
    [rf],
  );

  const onPaneClick = useCallback((): void => {
    useBlueprintStore.getState().closeMenu();
  }, []);

  const onMoveStart = useCallback<OnMoveStart>((): void => {
    useBlueprintStore.getState().closeMenu();
  }, []);

  const onEdgeContextMenu = useCallback<EdgeMouseHandler<FlowEdge>>(
    (event, edge) => {
      event.preventDefault();
      const st = useBlueprintStore.getState();
      const selected = (edge.selected ?? false) || st.selection.edgeIds.includes(edge.id);
      if (!selected) {
        // 右键未选中的连线 → 先选中它（UE/Godot 习惯）
        st.setSelection({ nodeIds: [], edgeIds: [edge.id] });
      }
      const point = clientOf(event);
      st.openMenu({
        kind: 'edge',
        edgeId: edge.id,
        screen: point,
        flow: rf.screenToFlowPosition(point),
      });
    },
    [rf],
  );

  /* ---------------- 键盘（Tab 搜索 / 删除 / 复制粘贴 / 复制 / 全选） ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || isTextTarget(e.target)) return;
      const st = useBlueprintStore.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === 'Tab' && !ctrl) {
        // Tab：在光标处呼出节点搜索（PLAN §8.2）
        e.preventDefault();
        if (!st.asset?.graphs[st.graphName]) return;
        st.openMenu({
          kind: 'search',
          screen: lastMouseRef.current,
          flow: rf.screenToFlowPosition(lastMouseRef.current),
        });
        return;
      }
      if (e.key === 'Escape') {
        st.closeMenu();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl) {
        if (st.selection.nodeIds.length > 0 || st.selection.edgeIds.length > 0) {
          e.preventDefault();
          st.deleteSelection();
        }
        return;
      }
      if (!ctrl) return;
      switch (e.key.toLowerCase()) {
        case 'c':
          e.preventDefault();
          void st.copySelection();
          break;
        case 'x':
          // 剪切 = 复制 + 删除（PLAN §6.3 统一操作习惯）
          e.preventDefault();
          void st.copySelection().then((count) => {
            if (count > 0) useBlueprintStore.getState().deleteSelection();
          });
          break;
        case 'v':
          e.preventDefault();
          void st.paste();
          break;
        case 'd':
          e.preventDefault();
          st.duplicateSelection();
          break;
        case 'a':
          // 全选节点（连线不选，UE 同款）
          e.preventDefault();
          st.setSelection({
            nodeIds: (st.asset?.graphs[st.graphName]?.nodes ?? []).map((n) => n.id),
            edgeIds: [],
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);

  /* ---------------- Alt+点击引脚断开（事件委托，不改 BPNode） ---------------- */

  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      if (!e.altKey || e.defaultPrevented) return;
      const target = e.target as Element | null;
      const handle = target?.closest?.('.react-flow__handle');
      if (!handle || !target?.closest('.bp-canvas')) return;
      const nodeId = handle.getAttribute('data-nodeid');
      const pinId = handle.getAttribute('data-handleid');
      if (!nodeId || !pinId) return;
      e.preventDefault();
      // UE5：Alt+点击引脚 → 断开该引脚全部连线（§8.2 第 4 条）
      const dir = handle.getAttribute('data-handlepos') === 'left' ? ('in' as const) : ('out' as const);
      useBlueprintStore.getState().disconnectPin(nodeId, pinId, dir);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  /* ---------------- 鼠标位置跟踪（Tab 呼出定位） ---------------- */

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  /* ---------------- 校验跳转 ---------------- */

  const jumpToNode = useCallback(
    (issueGraphName: string | undefined, nodeId?: string, edgeId?: string): void => {
      const st = useBlueprintStore.getState();
      if (issueGraphName && st.asset?.graphs[issueGraphName] && issueGraphName !== st.graphName) {
        st.switchGraph(issueGraphName);
      }
      st.setSelection({ nodeIds: nodeId ? [nodeId] : [], edgeIds: edgeId ? [edgeId] : [] });
      if (!nodeId) return;
      // 等切图 / 选中渲染完成后居中（setCenter 用画布坐标，与渲染时序无关）
      requestAnimationFrame(() => {
        const st2 = useBlueprintStore.getState();
        const graph = st2.asset?.graphs[st2.graphName];
        const irNode = graph?.nodes.find((n) => n.id === nodeId);
        if (!irNode) return;
        const measured = rf.getNode(nodeId)?.measured;
        const width = measured?.width ?? DEFAULT_NODE_SIZE.width;
        const height = measured?.height ?? DEFAULT_NODE_SIZE.height;
        void rf.setCenter(irNode.position.x + width / 2, irNode.position.y + height / 2, {
          zoom: 1,
          duration: 300,
        });
      });
    },
    [rf],
  );

  return {
    nodes,
    edges,
    handlers: {
      onNodesChange,
      onEdgesChange,
      onConnect,
      onConnectEnd,
      onNodeDragStart,
      onNodeDragStop,
      onSelectionChange,
      onPaneContextMenu,
      onPaneClick,
      onMoveStart,
      onEdgeContextMenu,
      isValidConnection,
    },
    jumpToNode,
    syncFromAsset,
  };
}
