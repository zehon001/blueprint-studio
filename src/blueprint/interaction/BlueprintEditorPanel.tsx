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
 *  - T2.7 注释框：store.addComment 占位 action 落地 + My Blueprint「注释」分节接入；
 *  - T5.4 运行观察：BPEdgeData.flowing 开关；
 *  - T6.4 插件节点：useBlueprintStore.getState().setSpecs(以 editorSpecMap() 为基线合并)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { registerShortcut } from '../../shell/keymap/registry';
import { serializeIR, validateIR } from '../../ir/validate';
import type { ValidationIssue } from '../../ir/validate';
import type { IRAsset } from '../../ir/types';
import { NODE_CATEGORIES } from '../../nodes';
import { BPGraphCanvas, headVariantFor, nodeSizeFor } from '../view';
import type { FlowEdge, FlowNode } from '../view';
import { useBlueprintStore } from '../store/blueprint-store';
// T2.3 结构面板（左栏 + 顶部图签）与 T2.4 蓝图检视器（右栏）
import { MyBlueprint } from '../my-blueprint/MyBlueprint';
import { GraphTabs } from '../my-blueprint/GraphTabs';
import { Details } from '../details/Details';
// 交互层样式统一在本面板 import（叶子组件不 import，保证 node:test 可挂载冒烟）
import './interaction.css';
import '../my-blueprint/my-blueprint.css';
import '../details/details.css';
import { NodeSearchMenu, EdgeContextMenu } from './NodeSearchMenu';
import { PinDragMenu } from './PinDragMenu';
import { SelectionToolbar } from './SelectionToolbar';
import { ValidationBar } from './ValidationBar';
import { computeAlignedPositions, type AlignEntry, type AlignMode } from './logic';
import { useCanvasInteractions } from './useCanvasInteractions';

export interface BlueprintEditorPanelProps {
  /** 受控资产（本期由工作区传入；文件加载接线属后续任务） */
  asset: IRAsset;
  /** 资产路径（如 'logic/main.bp.json'；保存回调透传） */
  assetPath?: string;
  /** 保存回调（Ctrl+S 校验通过后触发；返回前已 serializeIR，写盘由后续接线） */
  onSave?: (asset: IRAsset, assetPath?: string) => void;
  /** 附加类名（dock 面板内控制尺寸用） */
  className?: string;
}

/** 蓝图编辑器面板：store + view + interactions 组装（自带 ReactFlowProvider） */
export function BlueprintEditorPanel(props: BlueprintEditorPanelProps) {
  return (
    <ReactFlowProvider>
      <BlueprintEditorInner {...props} />
    </ReactFlowProvider>
  );
}

function BlueprintEditorInner({ asset, assetPath, onSave, className }: BlueprintEditorPanelProps) {
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

  /* ---------------- 保存（Ctrl+S 经 keymap 重绑定；PLAN §8.5 保存即校验） ---------------- */

  const save = useCallback((): void => {
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
    // 写盘由后续任务接线（项目文件系统 T0.2 的 FS API）；本期回调 + 控制台留痕
    console.log(`[blueprint] 保存资产 ${st.assetPath ?? '(未命名)'}：${text.length} 字节`);
    onSave?.(st.asset, st.assetPath ?? undefined);
    st.markSaved();
    st.notify('保存成功');
  }, [onSave]);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  useEffect(() => {
    // 重绑定全局 file.save（Ctrl+S 默认空实现）：蓝图面板打开期间由本面板保存
    registerShortcut({
      id: 'file.save',
      label: '保存',
      keys: 'Ctrl+S',
      handler: () => saveRef.current(),
    });
    return () => {
      // 卸载恢复默认空实现（避免悬挂引用已卸载面板的状态）
      registerShortcut({ id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => {} });
    };
  }, []);

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

  /* ---------------- 渲染 ---------------- */

  const searchEntries = useBlueprintStore((s) =>
    [...s.specs.values()].map((spec) => ({ spec, pin: null })),
  );

  return (
    <div className={`bp-editor${shaking ? ' bp-shake' : ''}${className ? ` ${className}` : ''}`}>
      <div className="bp-editor-layout">
        {/* 左栏：My Blueprint 结构面板（T2.3） */}
        <aside className="bp-editor-side bp-editor-side--structure">
          <MyBlueprint />
        </aside>
        {/* 中部：图签 + 画布（叠加层以画布区为定位基准） */}
        <div className="bp-editor-main">
          <GraphTabs />
          <div className="bp-editor-canvas">
            <BPGraphCanvas
              nodes={interactions.nodes}
              edges={interactions.edges}
              {...interactions.handlers}
            />
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
          </div>
        </div>
        {/* 右栏：Details 蓝图检视器（T2.4） */}
        <aside className="bp-editor-side bp-editor-side--details">
          <Details />
        </aside>
      </div>
    </div>
  );
}
