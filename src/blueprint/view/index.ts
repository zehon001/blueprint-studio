/**
 * Blueprint Studio v2 —— 蓝图视觉系统导出入口（T2.1）
 *
 * 纯函数层（model）与渲染组件层（BPNode / BPEdge / BPGraphCanvas）：
 * - T2.2 画布交互：import { irToFlow, flowToIR, edgesToIR, FlowNode, FlowEdge, bpNodeTypes, bpEdgeTypes }
 * - T2.3 结构面板：import { headVariantFor, headColorFor, varOpOf, varDisplayName }
 * - T2.4 蓝图检视器：import { editorKindOf }（引脚默认值编辑器种类判定）
 */
export {
  autoLayoutPositions,
  edgesToIR,
  flowToIR,
  hasPosition,
  headColorFor,
  headIconFor,
  headVariantFor,
  irToFlow,
  nodeSizeFor,
  nodeSubtitle,
  varDisplayName,
  varOpOf,
  DEFAULT_NODE_SIZE,
  LAYOUT_GAP,
  VAR_NODE_SIZE,
  EDGE_DATA_FALLBACK_COLOR,
} from './model';
export type {
  BPEdgeData,
  BPNodeData,
  FlowEdge,
  FlowNode,
  HeadVariant,
  IrToFlowOptions,
} from './model';
export { BPNode, editorKindOf } from './BPNode';
export { BPDataEdge, BPExecEdge } from './BPEdge';
export {
  BPGraphCanvas,
  bpEdgeTypes,
  bpNodeTypes,
  type BPGraphCanvasProps,
} from './BPGraphCanvas';
// T3.7 片段编辑模态（双击片段节点展开；命令栈接线 saveSnippetEdit 一并导出）
export { SnippetEditModal, saveSnippetEdit, type SnippetEditModalProps } from './SnippetEditModal';
