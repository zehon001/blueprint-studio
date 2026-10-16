/**
 * Blueprint Studio v2 —— 蓝图画布（T2.1，PLAN §8.1 画布项）
 *
 * ReactFlow 包裹层：暗色网格点背景（--bg-canvas + --bp-grid-dot）、
 * 无限平移缩放（minZoom 0.2 / maxZoom 2.5）、selectionOnDrag 框选基础。
 * 交互深化（右键节点搜索 / 引脚拖出菜单 / 复制粘贴 / 命令栈接线）属 T2.2，
 * 经 props 回调接入，本组件保持纯展示 + 受控数据。
 */
import '@xyflow/react/dist/style.css';
import './styles.css';
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ReactFlow,
  type EdgeTypes,
  type NodeTypes,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
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
  /** 节点变更（拖动 / 选择）；T2.2 用 flowToIR 把位置写回 IR */
  onNodesChange?: OnNodesChange<FlowNode>;
  /** 连线变更（选择 / 删除） */
  onEdgesChange?: OnEdgesChange<FlowEdge>;
  /** 拖出连线完成（T2.2 弹兼容节点菜单 / 校验类型） */
  onConnect?: OnConnect;
  /** 附加类名（dock 面板内控制尺寸用） */
  className?: string;
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
        minZoom={0.2}
        maxZoom={2.5}
        zoomOnScroll
        panOnScroll={false}
        selectionOnDrag
        panOnDrag={[1, 2]}
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
