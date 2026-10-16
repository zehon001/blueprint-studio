/**
 * Blueprint Studio v2 —— 蓝图画布（T2.1 基础 + T2.2 交互扩展，PLAN §8.1 / §8.2）
 *
 * ReactFlow 包裹层：暗色网格点背景（--bg-canvas + --bp-grid-dot）、
 * 无限平移缩放（minZoom 0.2 / maxZoom 2.5）、selectionOnDrag 框选。
 * T2.2 扩展（全部可选、向后兼容）：右键菜单 / 连线结束 / 拖拽起止 / 选择变化 /
 * 连线右键 / 连线预检 / 空格平移（panActivationKeyCode）。实现见 src/blueprint/interaction/。
 */
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ReactFlow,
  type EdgeMouseHandler,
  type EdgeTypes,
  type IsValidConnection,
  type NodeTypes,
  type OnConnect,
  type OnConnectEnd,
  type OnEdgesChange,
  type OnMoveStart,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { EDGE_COLORS, rawToken } from '../../shell/theme/tokens';
import { BPNode } from './BPNode';
import { BPDataEdge, BPExecEdge } from './BPEdge';
import type { FlowEdge, FlowNode } from './model';

/** 自定义 nodeTypes / edgeTypes（模块级常量，避免重渲染重建导致节点重挂载） */
export const bpNodeTypes: NodeTypes = { bpNode: BPNode };
export const bpEdgeTypes: EdgeTypes = { bpExec: BPExecEdge, bpData: BPDataEdge };

export interface BPGraphCanvasProps {
  /** 受控节点（irToFlow 产出；T2.2 起由交互 store 持有） */
  nodes: FlowNode[];
  /** 受控连线（irToFlow 产出） */
  edges: FlowEdge[];
  /** 节点变更（拖动 / 选择）；T2.2 经 useCanvasInteractions 接命令栈 */
  onNodesChange?: OnNodesChange<FlowNode>;
  /** 连线变更（选择 / 删除） */
  onEdgesChange?: OnEdgesChange<FlowEdge>;
  /** 拖出连线完成（T2.2 弹兼容节点菜单 / 校验类型） */
  onConnect?: OnConnect;
  /** 附加类名（dock 面板内控制尺寸用） */
  className?: string;

  /* ---------------- T2.2 交互扩展（全部可选，向后兼容） ---------------- */
  /** 画布空白右键（节点搜索菜单；调用方须 preventDefault） */
  onPaneContextMenu?: (event: ReactMouseEvent | MouseEvent) => void;
  /** 画布空白单击（关闭弹出菜单） */
  onPaneClick?: (event: ReactMouseEvent) => void;
  /** 连线拖出结束（松开空白 → 兼容菜单；落在不兼容引脚 → 抖动） */
  onConnectEnd?: OnConnectEnd;
  /** 节点拖拽开始（Ctrl+拖拽复制检测） */
  onNodeDragStart?: OnNodeDrag<FlowNode>;
  /** 节点拖拽结束（位置落 IR 命令栈 / Ctrl 复制落点） */
  onNodeDragStop?: OnNodeDrag<FlowNode>;
  /** 选择集变化（同步 store 选中集） */
  onSelectionChange?: OnSelectionChangeFunc<FlowNode, FlowEdge>;
  /** 连线右键（断开菜单） */
  onEdgeContextMenu?: EdgeMouseHandler<FlowEdge>;
  /** 视口移动开始（关闭弹出菜单） */
  onMoveStart?: OnMoveStart;
  /** 连线吸附预检（exec↔data 不互吸 / 重复线 / 同节点） */
  isValidConnection?: IsValidConnection<FlowEdge>;
  /** 平移激活键（UE 习惯：按住空格拖拽平移；默认 'Space'） */
  panActivationKeyCode?: string | null;
  /** 加选修饰键（§8.2「Shift 加选」：Shift+点击逐个加选；默认 'Shift'） */
  multiSelectionKeyCode?: string | null;
}

/**
 * 蓝图画布：UE5 风格网格点 + Godot 深底。
 * deleteKeyCode 置空：删除走 T2.2 命令栈（可撤销），防止误删绕过命令栈。
 */
export function BPGraphCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  className,
  onPaneContextMenu,
  onPaneClick,
  onConnectEnd,
  onNodeDragStart,
  onNodeDragStop,
  onSelectionChange,
  onEdgeContextMenu,
  onMoveStart,
  isValidConnection,
  panActivationKeyCode = 'Space',
  multiSelectionKeyCode = 'Shift',
}: BPGraphCanvasProps) {
  return (
    <div className={`bp-canvas${className ? ` ${className}` : ''}`}>
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={bpNodeTypes}
        edgeTypes={bpEdgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneContextMenu={onPaneContextMenu}
        onPaneClick={onPaneClick}
        onConnectEnd={onConnectEnd}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={onSelectionChange}
        onEdgeContextMenu={onEdgeContextMenu}
        onMoveStart={onMoveStart}
        isValidConnection={isValidConnection}
        panActivationKeyCode={panActivationKeyCode}
        minZoom={0.2}
        maxZoom={2.5}
        zoomOnScroll
        panOnScroll={false}
        selectionOnDrag
        // 平移：中键拖拽（button 1）+ 空格+左键（panActivationKeyCode）。
        // 注意不可含 button 2：ReactFlow 在 panOnDrag 含右键时会吞掉画布右键菜单
        // （§8.2 第 1 条「右键呼出节点搜索」依赖 onPaneContextMenu）。
        panOnDrag={[1]}
        multiSelectionKeyCode={multiSelectionKeyCode}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{
          stroke: EDGE_COLORS.dataDefault,
          strokeWidth: 1.8,
          strokeDasharray: '7 5',
        }}
        deleteKeyCode={null}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.6}
          color={rawToken('--bp-grid-dot')}
        />
      </ReactFlow>
    </div>
  );
}
