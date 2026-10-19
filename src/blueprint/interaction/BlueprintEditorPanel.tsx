/**
 * Blueprint Studio v2 —— 蓝图编辑器面板（T2.2 组装 / T2.3+T2.4 三栏布局，PLAN §8）
 *
 * 组装：BlueprintEditorPanel = store（命令栈域状态）+ view（T2.1 视觉）+
 * interaction（T2.2 画布交互）+ MyBlueprint（T2.3 左栏结构面板 + 顶部图签）+
 * Details（T2.4 右栏蓝图检视器）。布局对齐 UE5：图区居中，左结构树，右选中详情。
 * 经 src/blueprint/index.ts 导出，工作区接入：
 *
 *   import { BlueprintEditorPanel } from '@/blueprint';
 *   <BlueprintEditorPanel asset={irAsset} assetPath="logic/main.bp.json" onSave={...} />
 *
 * 后续任务接线方式：
 *  - T2.7 注释框：已完成——画布右键「添加注释」（搜索菜单内伪条目拦截）、CommentLayer
 *    挂载为画布 children、注释右键菜单（kind 'comment'）、My Blueprint「注释」分节双击定位；
 *  - T5.4 运行观察：BPEdgeData.flowing 开关；
 *  - T6.4 插件节点：useBlueprintStore.getState().setSpecs(以 editorSpecMap() 为基线合并)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Pause, Play } from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { registerShortcut, unregisterShortcut } from '../../shell/keymap/registry';
import { registerSaveHandler } from '../../shell/workspace/saveRegistry';
import { useWorkspaceStore } from '../../shell/workspace-store';
import { openAssetPanel } from '../../shell/dock/assetPanelModel';
import { serializeIR, validateIR } from '../../ir/validate';
import type { ValidationIssue } from '../../ir/validate';
import type { IRAsset, IRComment, NodeSpec } from '../../ir/types';
import { NODE_CATEGORIES } from '../../nodes';
import { reflectionEntries, type ReflectTargetNode } from '../../nodes/reflect';
import { useSceneTreeDomain } from '../../ui-editor/store';
import { getUISchema, type PropDef } from '../../ui-editor/schema';
import { BPGraphCanvas, headVariantFor, nodeSizeFor } from '../view';
import type { FlowEdge, FlowNode } from '../view';
import { useBlueprintStore, EMPTY_SELECTION } from '../store/blueprint-store';
// T2.3 结构面板（左栏 + 顶部图签）；v3 T8.2：Details 迁入统一检视器，编辑器变两栏
import { MyBlueprint } from '../my-blueprint/MyBlueprint';
import { GraphTabs } from '../my-blueprint/GraphTabs';
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
  loadObserveEnabled,
  saveObserveEnabled,
  useDebugOverlay,
} from '../../shell/debug';
import '../../shell/debug/debug.css';
// T3.7 片段节点：双击展开编辑模态 + 按资产注入片段 spec（ADR-007 §5）
import { SnippetEditModal, saveSnippetEdit } from '../view/SnippetEditModal';
import { setFunctionSignature } from '../view/externalSignatures';
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
  /** 资产路径（如 'logic/main.bp.json'；保存回调透传） */
  assetPath?: string;
  /** 保存回调（Ctrl+S 校验通过后触发；返回 false = 外部校验失败，不提示保存成功） */
  onSave?: (asset: IRAsset, assetPath?: string) => void | boolean | Promise<void | boolean>;
  /** 附加类名（dock 面板内控制尺寸用） */
  className?: string;
  /** 函数资产编辑器：单图契约，不允许再建函数子图 */
  hideFunctionSection?: boolean;
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
  className,
  hideFunctionSection = false,
  panelId,
}: BlueprintEditorPanelProps) {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const interactions = useCanvasInteractions();

  // store 状态订阅（编辑命令经 store action，本组件不直接改状态）
  const menu = useBlueprintStore((s) => s.menu);
  const specs = useBlueprintStore((s) => s.specs);
  const selection = useBlueprintStore((s) => s.selection);
  const dirty = useBlueprintStore((s) => s.dirty);
  const recentSpecIds = useBlueprintStore((s) => s.recentSpecIds);
  const validation = useBlueprintStore((s) => s.validation);
  const toast = useBlueprintStore((s) => s.toast);
  const shakeAt = useBlueprintStore((s) => s.shakeAt);
  const graphName = useBlueprintStore((s) => s.graphName);
  const closeMenu = useBlueprintStore((s) => s.closeMenu);

  /* ---------------- 资产装载 / 最近使用恢复 ---------------- */

  useEffect(() => {
    useBlueprintStore.getState().openAsset(asset, assetPath);
    // 资产 prop（受控）变化时重开：注册命令域 + 重置编辑态
  }, [asset, assetPath]);

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
      st.notify('保存被阻止：引用完整性校验未通过（见检视器/校验条）', 'error');
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

  // 观察开关：默认开（编辑器打开该蓝图视图时自动接入——WS 未连接 / 无运行实例时静默降级）；
  // 状态持久化 localStorage（一键关闭即整链生效：编辑器 unsubscribe → 服务端 → 运行窗口 mute 停发）
  const [observeEnabled, setObserveEnabled] = useState(() => loadObserveEnabled());
  const toggleObserve = useCallback((): void => {
    setObserveEnabled((prev) => {
      saveObserveEnabled(!prev);
      return !prev;
    });
  }, []);

  // nodeEnter → 入向 exec 边 的拓扑表（受控边变化时重建；流动动画的映射依据）
  const inExecEdges = useMemo(() => buildInExecEdges(interactions.edges), [interactions.edges]);

  const overlay = useDebugOverlay({
    enabled: observeEnabled,
    assetPath,
    foldContext: { inExecEdges, graphName },
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
  const { asset: uiAsset } = useSceneTreeDomain();
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
        graph: { nodes: [], edges: [] },
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
    // v3 T12.6：反射条目（图属主自身树节点 × reflect:true 属性；UI 内嵌蓝图时有树）
    const reflectNodes: ReflectTargetNode[] = [];
    const instanceProps: PropDef[] = [
      { id: 'name', label: '名称', type: 'string', group: '行为', reflect: true },
      { id: 'visible', label: '可见', type: 'bool', group: '行为', default: true, reflect: true },
    ];
    const walkUi = (n: NonNullable<typeof uiAsset>['root']): void => {
      const base = getUISchema(n.type)?.props ?? [];
      // 元素/预制体实例：整体只反射 name / visible（内部不透明）
      const props = n.element || n.prefab ? [...base, ...instanceProps] : base;
      reflectNodes.push({ name: n.name, type: n.type, props });
      for (const c of n.children ?? []) walkUi(c);
    };
    if (uiAsset) walkUi(uiAsset.root);
    const reflects: SpecEntry[] = reflectNodes.flatMap((n) =>
      reflectionEntries([n])
        .filter((e) => e.nodeName === n.name)
        .flatMap((e) => [
          {
            spec: {
              id: `reflect:get|${e.nodeName}|${e.propId}`,
              title: `Get ${e.label}`,
              category: '设计器',
              keywords: ['设计器', '反射', 'get', '读取', e.nodeName, e.propId],
              inputs: [],
              outputs: [],
            },
            pin: null,
          },
          {
            spec: {
              id: `reflect:set|${e.nodeName}|${e.propId}`,
              title: `Set ${e.label}`,
              category: '设计器',
              keywords: ['设计器', '反射', 'set', '写入', e.nodeName, e.propId],
              inputs: [],
              outputs: [],
            },
            pin: null,
          },
        ]),
    );
    // 「添加注释」伪条目追加在分类浏览尾部（搜索「注释」可直达；pick 在 searchPick 拦截）
    return [...entries, ...fnEntries, ...externalEntries, ...reflects, { spec: COMMENT_MENU_SPEC, pin: null }];
  }, [specs, asset, externalFns, uiAsset]);

  const commentList = useBlueprintStore(
    (s) => s.asset?.graphs[s.graphName]?.comments ?? NO_COMMENTS,
  );

  /** 右键菜单指向的注释（菜单开着但注释已被删 → 不渲染菜单） */
  const commentOfMenu: IRComment | null =
    menu?.kind === 'comment' ? (commentList.find((c) => c.id === menu.commentId) ?? null) : null;

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
          <GraphTabs allowAdd={!hideFunctionSection} />
          <div className="bp-editor-canvas">
            {/* T5.4 观察开关（画布右上）：默认开，localStorage 记忆；WS 未连接 / 无运行实例静默降级 */}
            <button
              type="button"
              className={`bp-observe-toggle${overlay.active ? ` bp-observe-toggle--on` : ''}`}
              title={
                overlay.active
                  ? overlay.connected
                    ? '观察运行中：节点高亮 / exec 流动 / 端口实时值（点击暂停）'
                    : '观察已开启（WS 未连接，静默等待）——点击暂停'
                  : '观察已暂停——点击开启（运行窗口的节点高亮 / 流动 / 端口值叠加）'
              }
              onClick={toggleObserve}
            >
              <span className="bp-observe-toggle-dot" aria-hidden="true" />
              {overlay.active ? (
                <>
                  <Icon icon={Pause} size={11} /> 观察运行
                </>
              ) : (
                <>
                  <Icon icon={Play} size={11} /> 观察暂停
                </>
              )}
            </button>
            <BPGraphCanvas
              nodes={viewNodes}
              edges={viewEdges}
              {...canvasHandlers}
            >
              {/* T2.7 注释框图层：视口内最底层（ViewportPortal），节点点击 / 框选不受影响 */}
              <CommentLayer />
              {/* T5.4 端口实时值徽标层：选中节点的输出引脚值显示在节点下方 */}
              <DebugPinValues state={overlay.state} tick={overlay.tick} />
            </BPGraphCanvas>
            {menu?.kind === 'search' ? (
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
            {menu?.kind === 'pin' ? (
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
            {menu?.kind === 'edge' ? (
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
              onSave={save}
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
