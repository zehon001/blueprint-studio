/**
 * Blueprint Studio v2 —— 蓝图编辑器公共出口（T2.2 组装）
 *
 * 工作区接入（dock 面板）：
 *   import { BlueprintEditorPanel } from '@/blueprint';
 *   <BlueprintEditorPanel asset={irAsset} assetPath="logic/main.bp.json" onSave={...} />
 *
 * 后续任务接线方式：
 *  - T2.3 结构面板：useBlueprintStore（asset / switchGraph / addNode 生成 Get/Set）；
 *  - T2.4 蓝图检视器：useBlueprintStore.setNodeParams / setPinDefault（已入命令栈）；
 *  - T2.7 注释框：store.addComment 占位 action 落地；
 *  - T6.4 插件节点：useBlueprintStore.getState().setSpecs(合并后的表) 经右键搜索可用。
 */
export {
  BlueprintEditorPanel,
  type BlueprintEditorPanelProps,
} from './interaction/BlueprintEditorPanel';

export {
  // store（T2.3 结构面板 / T2.4 检视器 / T6.4 插件节点接入）
  useBlueprintStore,
  selectCurrentGraph,
  selectSearchEntries,
  selectPinMenuEntries,
  EMPTY_SELECTION,
} from './store/blueprint-store';
export type {
  BlueprintDomainState,
  BlueprintSelection,
  CanvasMenu,
  ToastState,
} from './store/blueprint-store';

// 交互纯函数（suggestConverter / 剪贴板片段 / 对齐 / 搜索匹配；T2.3+ 复用）
export * from './interaction/logic';
export { bpClipboard, readFragment, writeFragment } from './interaction/clipboard';

// 交互组件（T2.3/T2.4 可复用 NodeSearchMenu 挑选列表；T2.7 复用菜单样式）
export {
  NodeSearchMenu,
  EdgeContextMenu,
  PinDragMenu,
  SelectionToolbar,
  ValidationBar,
  useCanvasInteractions,
} from './interaction';
export type {
  NodeSearchMenuProps,
  EdgeContextMenuProps,
  PinDragMenuProps,
  SelectionToolbarProps,
  ValidationBarProps,
  CanvasInteractionApis,
} from './interaction';

// 视图层（T2.1 产物，原样透传）
export {
  BPGraphCanvas,
  BPNode,
  BPDataEdge,
  BPExecEdge,
  bpNodeTypes,
  bpEdgeTypes,
  editorKindOf,
  autoLayoutPositions,
  edgesToIR,
  flowToIR,
  headColorFor,
  headIconFor,
  headVariantFor,
  irToFlow,
  nodeSizeFor,
  nodeSubtitle,
  varDisplayName,
  varOpOf,
  hasPosition,
  DEFAULT_NODE_SIZE,
  LAYOUT_GAP,
  VAR_NODE_SIZE,
  EDGE_DATA_FALLBACK_COLOR,
} from './view';
export type {
  BPEdgeData,
  BPNodeData,
  FlowEdge,
  FlowNode,
  HeadVariant,
  IrToFlowOptions,
} from './view';
export type { BPGraphCanvasProps } from './view/BPGraphCanvas';
