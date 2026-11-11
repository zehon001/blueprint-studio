/**
 * Blueprint Studio v2 —— 蓝图编辑器面板（T2.2 组装 / T2.3+T2.4 三栏布局，PLAN §8）
 *
 * 组装：BlueprintEditorPanel = store（命令栈域状态）+ view（T2.1 视觉）+
 * interaction（T2.2 画布交互）+ MyBlueprint（T2.3 左栏结构面板 + 顶部图签）+
 * Details（T2.4 右栏蓝图检视器）。布局对齐 UE5：图区居中，左结构树，右选中详情。
 * 经 src/blueprint/index.ts 导出，工作区接入：
 *
 *   import { BlueprintEditorPanel } from '@/blueprint';
 *   <BlueprintEditorPanel asset={irAsset} assetPath="blueprint/main.bp.json" onSave={...} />
 *
 * 后续任务接线方式：
 *  - T2.7 注释框：已完成——画布右键「添加注释」（搜索菜单内伪条目拦截）、CommentLayer
 *    挂载为画布 children、注释右键菜单（kind 'comment'）、My Blueprint「注释」分节双击定位；
 *  - T5.4 运行观察：BPEdgeData.flowing 开关；
 *  - T6.4 插件节点：useBlueprintStore.getState().setSpecs(以 editorSpecMap() 为基线合并)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Play, Save, Square } from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { registerShortcut, unregisterShortcut } from '../../shell/keymap/registry';
import { registerSaveHandler } from '../../shell/workspace/saveRegistry';
import { useWorkspaceStore } from '../../shell/workspace-store';
import { launchRuntime } from '../../shell/runtime-launch';
import { useRuntimeStore } from '../../panels/runtime/store';
import { openAssetPanel } from '../../shell/dock/assetPanelModel';
import { serializeIR, validateIR } from '../../ir/validate';
import type { ValidationIssue } from '../../ir/validate';
import type { IRAsset, IRComment, NodeSpec } from '../../ir/types';
import { NODE_CATEGORIES } from '../../nodes';
import { useStatusStore } from '../../shell/status-store';
import { useDockStore } from '../../shell/dock/store';
import { BPGraphCanvas, headVariantFor, nodeSizeFor } from '../view';
import type { FlowEdge, FlowNode } from '../view';
import { useBlueprintStore, EMPTY_SELECTION } from '../store/blueprint-store';
// T2.3 结构面板（左栏）；中栏为编辑器内部图签 + 画布
import { MyBlueprint } from '../my-blueprint/MyBlueprint';
import { GraphTabs, type GraphTabsScope } from '../my-blueprint/GraphTabs';
// T2.7 注释框（图层 + 右键菜单 + 选中 id 换算）
import {
  CommentContextMenu,
  CommentLayer,
  COMMENT_SELECTION_PREFIX,
  commentSelectionId,
} from '../comment';
// 交互层样式统一在本面板 import（叶子组件不 import，保证 node:test 可挂载冒烟）
import './interaction.css';
import '../my-blueprint/my-blueprint.css';
import '../details/details.css';
import '../comment/comment.css';
import { NodeSearchMenu, EdgeContextMenu } from './NodeSearchMenu';
import { PinDragMenu } from './PinDragMenu';
import { SelectionToolbar } from './SelectionToolbar';
import { ValidationBar } from './ValidationBar';
import { computeAlignedPositions, type AlignEntry, type AlignMode, type SpecEntry } from './logic';
import { useCanvasInteractions } from './useCanvasInteractions';
// T5.4 运行时蓝图观察：WS 订阅 + 叠加层（节点高亮 / exec 流动 / 端口实时值）
import {
  DebugPinValues,
  applyEdgeOverlay,
  applyNodeOverlay,
  buildInExecEdges,
  useDebugOverlay,
} from '../../shell/debug';
import '../../shell/debug/debug.css';
// T3.7 片段节点：双击展开编辑模态 + 按资产注入片段 spec（ADR-007 §5）
import { SnippetEditModal, saveSnippetEdit } from '../view/SnippetEditModal';
import { setFunctionSignature } from '../view/externalSignatures';
import { functionSkeletonNodes } from '../functionAsset';
import {
  SNIPPET_NODE_TYPE,
  snippetOfAsset,
  snippetSpecForAsset,
  withSnippetSpecs,
} from '../../script/snippet';
import { SNIPPET_PARAM_KEY, stableStringify } from '../../script/codegen-common';
import type { IRSnippetPin } from '../../ir/types';

export interface BlueprintEditorPanelProps {
  /** 受控资产（本期由工作区传入；文件加载接线属后续任务） */
  asset: IRAsset;
  /** 资产路径（如 'blueprint/main.bp.json'；保存回调透传） */
  assetPath?: string;
  /** 保存回调（Ctrl+S 校验通过后触发；返回 false = 外部校验失败，不提示保存成功） */
  onSave?: (asset: IRAsset, assetPath?: string) => void | boolean | Promise<void | boolean>;
  /**
   * 最新内存资产快照回调：本面板激活且 store 正持有本资产时触发。
   * 宿主用它同步受控 asset prop，避免页签切走再切回时用旧快照覆盖 store。
   */
  onAssetChange?: (asset: IRAsset) => void;
  /** 附加类名（dock 面板内控制尺寸用） */
  className?: string;
  /** 隐藏函数分节并禁止新建局部函数（单图嵌入场景） */
  hideFunctionSection?: boolean;
  /** 图签主入口类型（蓝图 / 内置库函数 / 项目库函数；缺省蓝图） */
  graphScope?: GraphTabsScope;
  /** dock 面板 id（活动面板保存分发；缺省回落全局 file.save） */
  panelId?: string;
}

/* ---------------- T2.7：画布右键搜索菜单里的「添加注释」伪条目 ---------------- */

/** 伪条目 spec id（仅存在于右键搜索菜单；searchPick 拦截，不进节点库与最近使用） */
const COMMENT_PICK_ID = 'comment.add';

/** 「添加注释」伪条目（UE5：右键菜单含 Add Comment；用伪 spec 复用搜索菜单 UI） */
const COMMENT_MENU_SPEC: NodeSpec = {
  id: COMMENT_PICK_ID,
  title: '添加注释',
  category: '注释',
  keywords: ['comment', '注释', '框'],
  inputs: [],
  outputs: [],
};

/** 空注释列表常量（选择器恒定返回同引用，避免无谓重渲染） */
const NO_COMMENTS: IRComment[] = [];

/** 蓝图编辑器面板：store + view + interactions 组装（自带 ReactFlowProvider） */
export function BlueprintEditorPanel(props: BlueprintEditorPanelProps) {
  return (
    <ReactFlowProvider>
      <BlueprintEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function BlueprintEditorInner({
  asset,
  assetPath,
  onSave,
  onAssetChange,
  className,
  hideFunctionSection = false,
  graphScope = 'blueprint',
  panelId,
}: BlueprintEditorPanelProps) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  // 状态栏只读同步：画布缩放
  useEffect(() => {
    useStatusStore.getState().setZoom(rf.getZoom());
    return () => useStatusStore.getState().setZoom(null);
  }, [rf]);

  // 首次可见时重新 fitView：dock 页签隐藏期间挂载的编辑器画布尺寸为 0，
  // ReactFlow 初始 fitView 会落到 minZoom（20%）。容器首次获得实际尺寸后补一次取景。
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let fitted = false;
    const ro = new ResizeObserver(() => {
      if (fitted || el.clientWidth < 120 || el.clientHeight < 120) return;
      fitted = true;
      void rf.fitView({ padding: 0.2, duration: 0 });
      ro.disconnect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rf]);
  const activePanelId = useDockStore((s) => s.activePanelId);
  /** dock 页签里只有激活面板可以响应全局快捷键 / 渲染全局菜单（菜单状态是单例） */
  const isActiveEditor = !panelId || activePanelId === panelId;
  const interactions = useCanvasInteractions({ active: isActiveEditor });

  // store 状态订阅（编辑命令经 store action，本组件不直接改状态）
  const menu = useBlueprintStore((s) => s.menu);
  const specs = useBlueprintStore((s) => s.specs);
  const storeAsset = useBlueprintStore((s) => s.asset);
  const storeAssetPath = useBlueprintStore((s) => s.assetPath);
  const selection = useBlueprintStore((s) => s.selection);
  const dirty = useBlueprintStore((s) => s.dirty);
  const runtimeTarget = useRuntimeStore((s) => s.target);
  const runtimeNonce = useRuntimeStore((s) => s.nonce);
  const projectParam = useWorkspaceStore((s) => {
    const project = s.currentProject;
    return project ? project.path || project.name : null;
  });
  const isRunnableAsset = assetPath?.endsWith('.bp.json') === true;
  const runningThisAsset =
    isRunnableAsset && runtimeTarget?.bp === assetPath && runtimeTarget.project === projectParam;
  const recentSpecIds = useBlueprintStore((s) => s.recentSpecIds);
  const validation = useBlueprintStore((s) => s.validation);
  const toast = useBlueprintStore((s) => s.toast);
  const shakeAt = useBlueprintStore((s) => s.shakeAt);
  const graphName = useBlueprintStore((s) => s.graphName);
  const closeMenu = useBlueprintStore((s) => s.closeMenu);

  /* ---------------- 资产装载 / 最近使用恢复 ---------------- */

  useEffect(() => {
    // 面板激活（或无 dock 上下文）时才把本面板资产写入全局蓝图 store：
    // BlueprintEditorPanel 同时服务 main 蓝图 / 函数资产等多面板——store 是全局单例，
    // 不跟随激活面板同步会让后打开的资产覆盖先打开的（切回标签显示成别的资产）。
    // 同资产跳过：重开会以「磁盘快照 prop」覆盖 store，冲掉未保存的内存编辑
    // （如函数图加参后检视器 ↔ 画布往返）；仅跨资产切换才重开。
    if (panelId && useDockStore.getState().activePanelId !== panelId) return;
    if (panelId && useBlueprintStore.getState().assetPath === assetPath) return;
    useBlueprintStore.getState().openAsset(asset, assetPath);
    // 资产 prop（受控）变化 / 面板激活切换时重开：注册命令域 + 重置编辑态
  }, [asset, assetPath, panelId]);

  useEffect(() => {
    if (!panelId || activePanelId !== panelId) return;
    if (useBlueprintStore.getState().assetPath === assetPath) return;
    useBlueprintStore.getState().openAsset(asset, assetPath);
  }, [activePanelId, panelId, asset, assetPath]);

  useEffect(() => {
    if (!isActiveEditor) useBlueprintStore.getState().closeMenu();
  }, [isActiveEditor]);

  // 把最新内存资产回传给宿主：多蓝图页签共享同一个 store，宿主缓存的 asset prop
  // 若停留在首次读盘快照，切回该页签时会用旧快照覆盖当前节点。
  useEffect(() => {
    if (!onAssetChange || !storeAsset) return;
    if (storeAssetPath !== (assetPath ?? null)) return;
    onAssetChange(storeAsset);
  }, [onAssetChange, storeAsset, storeAssetPath, assetPath]);

  // 面板关闭 / 布局移除时释放 store 归属：同路径重开（历史快照恢复重开页签等）才能重新读盘
  useEffect(() => {
    if (!panelId) return;
    return () => {
      const st = useBlueprintStore.getState();
      if (st.assetPath === assetPath) {
        useBlueprintStore.setState({ asset: null, assetPath: null });
      }
    };
  }, [panelId, assetPath]);

  // 插件能力表自愈：能力注入失败（编排器瞬时不可达 → 模型 / 思考强度 / 权限变输入框）时，
  // 同资产激活不再走 openAsset，在此按需重试注入（成功后 loadPluginSpecs 记忆化，不再重复 fetch）
  useEffect(() => {
    if (panelId && activePanelId !== panelId) return;
    useBlueprintStore.getState().refreshPluginSpecs();
  }, [panelId, activePanelId]);

  useEffect(() => {
    useBlueprintStore.getState().loadRecentSpecs();
  }, []);

  /* ---------------- T3.7：片段节点 spec 注入（ADR-007 §5） ----------------
   * 片段引脚按 IRSnippet.pins 动态声明，静态 spec 无法如实声明——挂载与资产变化时
   * 把按资产合成的片段 spec（引脚并集）合并进 store.specs，校验 / 连线 / 搜索 /
   * 新建「脚本片段」即走常规机制。T6.4 插件注入覆盖后，本 effect 于渲染时重合。 */
  useEffect(() => {
    const st = useBlueprintStore.getState();
    if (!st.asset) return;
    const wanted = snippetSpecForAsset(st.asset);
    const cur = st.specs.get(SNIPPET_NODE_TYPE);
    if (
      cur &&
      stableStringify([cur.inputs, cur.outputs]) === stableStringify([wanted.inputs, wanted.outputs])
    ) {
      return;
    }
    st.setSpecs(withSnippetSpecs(st.specs, st.asset));
  }, [asset, specs]);

  /* ---------------- T3.7：片段节点双击展开编辑（模态） ---------------- */

  /** 打开中的片段编辑（nodeId + 打开时的图名；模态保存/取消后清空） */
  const [snippetEdit, setSnippetEdit] = useState<{ nodeId: string; graphName: string } | null>(null);

  const onNodeDoubleClick = useCallback(
    (_event: ReactMouseEvent, node: FlowNode): void => {
      if (node.data.node.type !== SNIPPET_NODE_TYPE) return;
      setSnippetEdit({ nodeId: node.id, graphName: useBlueprintStore.getState().graphName });
    },
    [],
  );

  // 模态指向的片段节点（store 订阅：undo/重做后节点仍在则保持打开，已删则自动关闭）
  const snippetEditNode = useBlueprintStore((s) => {
    if (!snippetEdit) return null;
    return s.asset?.graphs[snippetEdit.graphName]?.nodes.find((n) => n.id === snippetEdit.nodeId) ?? null;
  });
  useEffect(() => {
    if (snippetEdit && !snippetEditNode) setSnippetEdit(null);
  }, [snippetEdit, snippetEditNode]);

  /* ---------------- 保存（Ctrl+S 经 keymap 重绑定；PLAN §8.5 保存即校验） ---------------- */

  const save = useCallback(async (): Promise<void> => {
    const st = useBlueprintStore.getState();
    if (!st.asset) return;
    const issues = validateIR(st.asset, st.specs);
    st.setValidation(issues);
    const errors = issues.filter((i) => i.severity === 'error').length;
    if (errors > 0) {
      st.notify(`保存被阻止：${errors} 个错误（见底部明细）`, 'error');
      return;
    }
    const text = serializeIR(st.asset);
    // 写盘由外部 onSave 接线（UI 内嵌蓝图会追加 v3 引用完整性校验）
    console.log(`[blueprint] 保存资产 ${st.assetPath ?? '(未命名)'}：${text.length} 字节`);
    const result = await onSave?.(st.asset, st.assetPath ?? undefined);
    if (result === false) {
      st.notify('保存失败：写盘或引用完整性校验未通过（见校验条 / 控制台）', 'error');
      return;
    }
    st.markSaved();
    st.notify('保存成功');
  }, [onSave]);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    if (panelId) {
      // v3：按 dock 面板注册保存，全局 file.save 投递给 activePanelId
      return registerSaveHandler(panelId, () => saveRef.current());
    }
    // 无 dock 上下文（组件单测 / 嵌入方未传 id）：兼容旧行为
    registerShortcut({
      id: 'file.save',
      label: '保存',
      keys: 'Ctrl+S',
      handler: () => saveRef.current(),
    });
    return () => unregisterShortcut('file.save');
  }, [panelId]);

  /* ---------------- 轻提示自动消失 / 抖动动画 ---------------- */

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => useBlueprintStore.getState().dismissToast(), 2600);
    return () => window.clearTimeout(timer);
  }, [toast?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const [shaking, setShaking] = useState(false);
  useEffect(() => {
    if (!shakeAt) return;
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 320);
    return () => window.clearTimeout(timer);
  }, [shakeAt]);

  /* ---------------- 菜单动作 ---------------- */

  const searchPick = useCallback((specId: string): void => {
    const st = useBlueprintStore.getState();
    if (st.menu?.kind !== 'search') return;
    if (specId === COMMENT_PICK_ID) {
      // T2.7：右键菜单「添加注释」→ 在光标处创建默认尺寸注释框
      st.addComment(st.menu.flow);
      st.closeMenu();
      return;
    }
    if (specId.startsWith('reflect:')) {
      const [, rest] = specId.split(':', 2);
      const [kind, nodeName, propId] = (rest ?? '').split('|');
      const id = st.addNode(kind === 'set' ? 'ui.setProp' : 'ui.getProp', st.menu.flow);
      if (id) st.setNodeParams(id, { nodeName, propId });
      st.closeMenu();
      return;
    }
    if (specId.startsWith('fncall:')) {
      const parts = specId.split(':');
      const id = st.addNode('flow.call', st.menu.flow);
      if (id) {
        if (parts.length >= 3) st.setNodeParams(id, { function: parts[2], scope: parts[1] });
        else st.setNodeParams(id, { graph: parts[1] });
      }
      st.closeMenu();
      return;
    }
    st.addNode(specId, st.menu.flow);
    st.closeMenu();
  }, []);

  const pinPick = useCallback((specId: string): void => {
    const st = useBlueprintStore.getState();
    if (st.menu?.kind !== 'pin') return;
    st.addNodeConnected(specId, st.menu.flow, st.menu.from);
    // PinDragMenu 选中后自行回调 onClose
  }, []);

  const edgeDisconnectOne = useCallback((): void => {
    const st = useBlueprintStore.getState();
    if (st.menu?.kind !== 'edge') return;
    st.disconnectEdges([st.menu.edgeId]);
    st.closeMenu();
  }, []);

  const edgeDisconnectSelected = useCallback((): void => {
    const st = useBlueprintStore.getState();
    if (st.menu?.kind !== 'edge') return;
    st.disconnectEdges(st.selection.edgeIds);
    st.closeMenu();
  }, []);

  /* ---------------- 对齐 / 分布（§8.2 第 5 条，吸附 10px 网格） ---------------- */

  const onAlign = useCallback(
    (mode: AlignMode): void => {
      const st = useBlueprintStore.getState();
      const graph = st.asset?.graphs[st.graphName];
      if (!graph) return;
      const selected = new Set(st.selection.nodeIds);
      const entries: AlignEntry[] = graph.nodes
        .filter((n) => selected.has(n.id))
        .map((n) => {
          const estimated = nodeSizeFor(headVariantFor(n.type, st.specs.get(n.type) ?? null));
          const measured = rf.getNode(n.id)?.measured;
          return {
            id: n.id,
            position: n.position,
            size: {
              width: measured?.width ?? estimated.width,
              height: measured?.height ?? estimated.height,
            },
          };
        });
      const positions = computeAlignedPositions(entries, mode);
      if (positions.size === 0) return;
      const moves = [...positions].map(([id, position]) => ({ id, position }));
      st.moveNodes(moves);
    },
    [rf],
  );

  /* ---------------- 校验条跳转（issue 点击 → 切图 + 选中 + 居中） ---------------- */

  const onIssueJump = useCallback(
    (issue: ValidationIssue): void => {
      interactions.jumpToNode(issue.graphName, issue.nodeId, issue.edgeId);
    },
    [interactions],
  );

  /* ---------------- T2.7：My Blueprint「注释」双击 → 切图 + 选中 + 居中定位 ---------------- */

  const focusComment = useBlueprintStore((s) => s.focusComment);
  useEffect(() => {
    if (!focusComment) return;
    const st = useBlueprintStore.getState();
    const comment = st.asset?.graphs[focusComment.graphName]?.comments?.find(
      (c) => c.id === focusComment.commentId,
    );
    if (!comment) return;
    if (st.graphName !== focusComment.graphName) st.switchGraph(focusComment.graphName);
    st.setSelection({ nodeIds: [commentSelectionId(comment.id)], edgeIds: [] });
    const { bounds } = comment;
    void rf.setCenter(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, {
      zoom: Math.max(rf.getZoom(), 1),
      duration: 300,
    });
  }, [focusComment, rf]);

  /* ---------------- T5.4：运行时蓝图观察（WS 反向通道叠加层） ---------------- */

  // nodeEnter → 入向 exec 边 的拓扑表（受控边变化时重建；流动动画的映射依据）
  const inExecEdges = useMemo(() => buildInExecEdges(interactions.edges), [interactions.edges]);

  const overlay = useDebugOverlay({
    enabled: true,
    assetPath,
    foldContext: { inExecEdges, graphName },
    runActive: runningThisAsset,
    runKey:
      runtimeTarget && runningThisAsset
        ? `${runtimeTarget.project}:${runtimeTarget.bp}:${runtimeNonce}`
        : 'idle',
  });

  // 受控视图叠加映射（纯视图层 state，不经命令栈；空闲时返回原数组引用，React memo 跳过）
  const [overlayNow, setOverlayNow] = useState(() => Date.now());
  const viewNodes = useMemo(
    () => (overlay.active ? applyNodeOverlay(interactions.nodes, overlay.state, overlayNow) : interactions.nodes),
    [interactions.nodes, overlay.active, overlay.state, overlayNow],
  );
  const viewEdges = useMemo(
    () =>
      overlay.active
        ? applyEdgeOverlay(interactions.edges, overlay.state.flowingEdges, overlayNow)
        : interactions.edges,
    [interactions.edges, overlay.active, overlay.state.flowingEdges, overlayNow],
  );

  // 衰减 tick（250ms 扫描）→ 渲染映射的 now 基准推进（过期高亮 / 流动 / 徽标随之消失）
  useEffect(() => {
    setOverlayNow(Date.now());
  }, [overlay.tick]);

  /* ---------------- 渲染 ---------------- */

  /* v3 T12.3：项目库/内置库函数清单（进入「函数」分组检索） */
  const [externalFns, setExternalFns] = useState<Array<{ name: string; scope: 'project' | 'global' }>>([]);
  const projectPath = useWorkspaceStore((s) => s.currentProject?.path ?? null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      const out: Array<{ name: string; scope: 'project' | 'global' }> = [];
      const loadSignature = async (
        scope: 'project' | 'global',
        name: string,
        url: string,
      ): Promise<void> => {
        try {
          const j = (await (await fetch(url)).json()) as { ok?: boolean; content?: string };
          if (!j.ok || typeof j.content !== 'string') return;
          const raw = JSON.parse(j.content) as {
            params?: unknown;
            returns?: unknown;
            graph?: { params?: unknown; returns?: unknown };
          };
          setFunctionSignature(scope, name, {
            params: (raw.params ?? raw.graph?.params ?? []) as never,
            returns: (raw.returns ?? raw.graph?.returns ?? []) as never,
          });
        } catch {
          /* 单个签名加载失败：该调用节点暂不显示动态引脚 */
        }
      };
      if (projectPath) {
        try {
          const r = await fetch(`/api/tree?path=${encodeURIComponent(`${projectPath}/library/functions`)}`);
          const j = (await r.json()) as {
            ok?: boolean;
            tree?: { children?: Array<{ name?: string; type?: string; path?: string }> };
          };
          for (const c of j.tree?.children ?? []) {
            if (c.type === 'file' && typeof c.name === 'string' && c.name.toLowerCase().endsWith('.fn.json')) {
              const name = c.name.replace(/\.fn\.json$/i, '');
              out.push({ name, scope: 'project' });
              await loadSignature(
                'project',
                name,
                `/api/file?path=${encodeURIComponent(`${projectPath}/library/functions/${c.name}`)}`,
              );
            }
          }
          const lr = await fetch('/api/library/list?kind=functions');
          const lj = (await lr.json()) as { ok?: boolean; entries?: Array<{ name?: string }> };
          for (const e of lj.entries ?? []) {
            if (!e.name) continue;
            out.push({ name: e.name, scope: 'global' });
            await loadSignature(
              'global',
              e.name,
              `/api/library/read?kind=functions&name=${encodeURIComponent(e.name)}`,
            );
          }
        } catch {
          /* 库不可用时仅显示资产内函数 */
        }
      }
      if (alive) setExternalFns(out);
    };
    void load();
    return () => {
      alive = false;
    };
  }, [projectPath]);

  /** v3 T12.2①：新建项目/全局函数（蓝图作用域仍由 store.addFunction 处理） */
  const createScopedFunction = async (
    scope: 'project' | 'global',
    name: string,
  ): Promise<boolean> => {
    if (!projectPath) {
      window.alert('未打开项目，无法新建项目/全局函数');
      return false;
    }
    if (externalFns.some((f) => f.scope === scope && f.name === name)) {
      window.alert(`同名${scope === 'project' ? '项目' : '全局'}函数已存在`);
      return false;
    }
    const content = JSON.stringify(
      {
        version: 3,
        kind: 'function',
        scope,
        name,
        params: [],
        returns: [],
        graph: { nodes: functionSkeletonNodes(), edges: [] },
      },
      null,
      2,
    );
    try {
      const r =
        scope === 'project'
          ? await fetch('/api/file', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                path: `${projectPath}/library/functions/${name}.fn.json`,
                content,
              }),
            })
          : await fetch('/api/library/write', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ kind: 'functions', name, content }),
            });
      const j = (await r.json()) as { ok?: boolean; message?: string };
      if (!j.ok) {
        window.alert(`新建函数失败：${j.message ?? '未知错误'}`);
        return false;
      }
      setExternalFns((prev) => [...prev, { name, scope }]);
      openAssetPanel(
        'function',
        scope === 'project' ? `library/functions/${name}.fn.json` : `@library/functions/${name}`,
      );
      return true;
    } catch (err) {
      window.alert(`新建函数失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const searchEntries = useMemo<SpecEntry[]>(() => {
    const entries: SpecEntry[] = [...specs.values()].map((spec) => ({ spec, pin: null }));
    // v3 T12.3：本资产函数图作为「函数」分组伪条目（pick 时建 flow.call 并预填 graph）
    const blueprintNames = new Set(
      Object.keys(asset.graphs ?? {}).filter((name) => name !== asset.entry),
    );
    const fnEntries: SpecEntry[] = [...blueprintNames].map((name) => ({
      spec: {
        id: `fncall:${name}`,
        title: `调用 ${name}`,
        category: '函数',
        keywords: ['函数', 'call', '调用', name],
        inputs: [],
        outputs: [],
      },
      pin: null,
      badge: '蓝图',
    }));
    const projectNames = new Set(externalFns.filter((f) => f.scope === 'project').map((f) => f.name));
    const externalEntries: SpecEntry[] = externalFns.map((f) => ({
      spec: {
        id: `fncall:${f.scope}:${f.name}`,
        title: `${f.scope === 'project' ? '全项目' : '全局'} · ${f.name}`,
        category: '函数',
        keywords: ['函数', 'call', '调用', f.name],
        inputs: [],
        outputs: [],
      },
      pin: null,
      badge: f.scope === 'project' ? '项目' : '全局',
      note:
        f.scope === 'project' && blueprintNames.has(f.name)
          ? '同名蓝图函数优先（auto）'
          : f.scope === 'global' && (blueprintNames.has(f.name) || projectNames.has(f.name))
            ? '同名函数优先（auto）'
            : undefined,
    }));
    // 「添加注释」伪条目追加在分类浏览尾部（搜索「注释」可直达；pick 在 searchPick 拦截）
    return [...entries, ...fnEntries, ...externalEntries, { spec: COMMENT_MENU_SPEC, pin: null }];
  }, [specs, asset, externalFns]);

  const commentList = useBlueprintStore(
    (s) => s.asset?.graphs[s.graphName]?.comments ?? NO_COMMENTS,
  );

  /** 右键菜单指向的注释（菜单开着但注释已被删 → 不渲染菜单） */
  const commentOfMenu: IRComment | null =
    menu?.kind === 'comment' ? (commentList.find((c) => c.id === menu.commentId) ?? null) : null;

  /** 图签栏右侧操作（运行 / 保存）：水平位置沿用原画布右上浮层 */
  const graphActions = (
    <>
      {isRunnableAsset ? (
        runningThisAsset ? (
          <button
            type="button"
            className="bp-canvas-action bp-canvas-action--stop"
            title="停止运行：中止当前蓝图"
            onClick={() => useRuntimeStore.getState().clearTarget()}
          >
            <Icon icon={Square} size={11} /> 停止
          </button>
        ) : (
          <button
            type="button"
            className="bp-canvas-action bp-canvas-action--run"
            title="运行（F5）—— 运行当前蓝图"
            onClick={() => void launchRuntime()}
          >
            <Icon icon={Play} size={11} /> 运行
          </button>
        )
      ) : null}
      <button
        type="button"
        className="bp-canvas-action"
        title="保存（Ctrl+S）"
        onClick={() => void save()}
      >
        <Icon icon={Save} size={11} /> 保存
        {dirty ? <span className="bp-canvas-action-dot" aria-hidden="true" /> : null}
      </button>
    </>
  );

  /**
   * T2.7：画布 handlers 包装——注释选择 RF 不感知，空白单击时补齐「取消注释选中」
   * （UE 同款：点空白取消全部选中；节点 / 连线取消由交互钩子的 onSelectionChange 负责）。
   */
  const canvasHandlers = {
    ...interactions.handlers,
    onNodeDoubleClick,
    onPaneClick: () => {
      interactions.handlers.onPaneClick();
      const st = useBlueprintStore.getState();
      if (st.selection.nodeIds.some((id) => id.startsWith(COMMENT_SELECTION_PREFIX))) {
        st.setSelection(EMPTY_SELECTION);
      }
    },
  };

  return (
    <div className={`bp-editor${shaking ? ' bp-shake' : ''}${className ? ` ${className}` : ''}`}>
      <div className="bp-editor-layout">
        {/* 左栏：My Blueprint 结构面板（T2.3） */}
        <aside className="bp-editor-side bp-editor-side--structure">
          <MyBlueprint
            onCreateScopedFunction={createScopedFunction}
            hideFunctions={hideFunctionSection}
          />
        </aside>
        {/* 中部：图签 + 画布（叠加层以画布区为定位基准） */}
        <div className="bp-editor-main">
          <GraphTabs
            allowAdd={!hideFunctionSection}
            scope={graphScope}
            actions={graphActions}
          />
          <div className="bp-editor-canvas" ref={canvasRef}>
            <BPGraphCanvas
              nodes={viewNodes}
              edges={viewEdges}
              onViewportChange={(zoom) => useStatusStore.getState().setZoom(zoom)}
              {...canvasHandlers}
            >
              {/* T2.7 注释框图层：视口内最底层（ViewportPortal），节点点击 / 框选不受影响 */}
              <CommentLayer />
              {/* T5.4 端口实时值徽标层：选中节点的输出引脚值显示在节点下方 */}
              <DebugPinValues state={overlay.state} tick={overlay.tick} />
            </BPGraphCanvas>
            {isActiveEditor && menu?.kind === 'search' ? (
              <NodeSearchMenu
                screen={menu.screen}
                entries={searchEntries}
                recentIds={recentSpecIds}
                categoryOrder={NODE_CATEGORIES}
                title="添加节点"
                onPick={searchPick}
                onClose={closeMenu}
              />
            ) : null}
            {isActiveEditor && menu?.kind === 'pin' ? (
              <PinDragMenu
                screen={menu.screen}
                flow={menu.flow}
                from={menu.from}
                specs={specs}
                recentIds={recentSpecIds}
                categoryOrder={NODE_CATEGORIES}
                onPick={pinPick}
                onClose={closeMenu}
              />
            ) : null}
            {isActiveEditor && menu?.kind === 'edge' ? (
              <EdgeContextMenu
                screen={menu.screen}
                edgeSelected={selection.edgeIds.includes(menu.edgeId)}
                selectedEdgeCount={selection.edgeIds.length}
                onDisconnectOne={edgeDisconnectOne}
                onDisconnectSelected={edgeDisconnectSelected}
                onClose={closeMenu}
              />
            ) : null}
            {menu?.kind === 'comment' && commentOfMenu ? (
              <CommentContextMenu
                comment={commentOfMenu}
                screen={menu.screen}
                onClose={closeMenu}
              />
            ) : null}
            <SelectionToolbar nodeCount={selection.nodeIds.length} onAlign={onAlign} />
            <ValidationBar
              issues={validation}
              dirty={dirty}
              graphName={graphName}
              onJump={onIssueJump}
            />
            {toast ? (
              <div
                key={toast.at}
                className={`bp-toast${toast.kind === 'error' ? ' bp-toast--error' : ''}`}
                role="status"
              >
                {toast.text}
              </div>
            ) : null}
            {/* T3.7 片段编辑模态（双击片段节点展开；保存入命令栈，可撤销） */}
            {snippetEdit && snippetEditNode && snippetEditNode.type === SNIPPET_NODE_TYPE ? (
              <SnippetEditModal
                snippet={snippetOfAsset(asset, snippetEditNode.params?.[SNIPPET_PARAM_KEY])}
                title={
                  typeof snippetEditNode.params?.[SNIPPET_PARAM_KEY] === 'string' &&
                  snippetEditNode.params[SNIPPET_PARAM_KEY] !== ''
                    ? `片段：${String(snippetEditNode.params[SNIPPET_PARAM_KEY])}`
                    : '新建脚本片段'
                }
                onSave={(code: string, pins: IRSnippetPin[]) => {
                  saveSnippetEdit(snippetEdit.graphName, snippetEdit.nodeId, code, pins);
                  setSnippetEdit(null);
                  useBlueprintStore.getState().notify('片段已保存');
                }}
                onCancel={() => setSnippetEdit(null)}
              />
            ) : null}
          </div>
        </div>
        {/* v3 T8.2：检视器在 dock「检视器」面板（统一检视器），此处不再有右栏 */}
      </div>
    </div>
  );
}
