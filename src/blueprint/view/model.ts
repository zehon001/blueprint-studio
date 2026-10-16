/**
 * Blueprint Studio v2 —— 蓝图视觉系统·视图模型（T2.1）
 *
 * IR → ReactFlow 视图模型的纯函数层：无 React / CSS 运行时依赖（仅 type import），
 * 可被 node:test 直接单测；React 组件（BPNode / BPEdge / BPGraphCanvas）从本模块取类型与映射。
 *
 * 契约真源：src/ir/types.ts（IRAsset / IRNode / IREdge / NodeSpec / PinSpec）；
 * 取色真源：src/shell/theme/tokens.ts（PIN_COLORS / NODE_HEAD_COLORS / EDGE_COLORS / rawToken），
 * 本文件不出现任何硬编码色值。
 */
import dagre from '@dagrejs/dagre';
import type { Edge, Node, MarkerType } from '@xyflow/react';
import type {
  IRAsset,
  IREdge,
  IRNode,
  IRValueType,
  NodeSpec,
  Vec2,
} from '../../ir/types';
import {
  EDGE_COLORS,
  COLORS,
  NODE_HEAD_COLORS,
  rawToken,
} from '../../shell/theme/tokens';

/* ============================================================
 * 1. 视图模型类型（FlowNode / FlowEdge，T2.2 交互层共用）
 * ============================================================ */

/** 节点头变体（PLAN §8.1：事件红 / 函数蓝 / 纯函数绿 / 流程灰 / 插件紫 / var 无头 / 未知降级） */
export type HeadVariant =
  | 'event'
  | 'function'
  | 'pure'
  | 'flow'
  | 'plugin'
  | 'var'
  | 'unknown';

/** FlowNode.data（node = IR 原始节点，spec 缺失 = 未知节点降级样式）。
 * 用 type 别名而非 interface：@xyflow/react v12 约束 data extends Record<string, unknown>，
 * type 别名才获得隐式字符串索引签名。 */
export type BPNodeData = {
  /** IR 节点实例（唯一真源；拖动等编辑经 flowToIR 写回） */
  node: IRNode;
  /** 节点定义；未知节点类型为 null（渲染灰色降级样式） */
  spec: NodeSpec | null;
  /** 所属图名（头副标题兜底显示） */
  graphName: string;
  /** 头变体（由 headVariantFor 预计算，渲染与测试共用） */
  variant: HeadVariant;
  /** 已连线输入引脚 id 集合（未连线的数据输入引脚渲染内联默认值编辑框） */
  connectedInputs: ReadonlySet<string>;
  /** 未知节点降级：从连线还原的输入引脚 id（按首次出现顺序，类型按 any 渲染） */
  degradedInputs: readonly string[];
  /** 未知节点降级：从连线还原的输出引脚 id */
  degradedOutputs: readonly string[];
  /**
   * 内联默认值变更回调（T2.2/T2.4 接 IR 命令栈；本卡先内部 state 可编辑，仅透传可选回调）。
   * TODO(T2.2/T2.4)：接命令栈后由交互层提供，实现撤销重做。
   */
  onPinDefaultChange?: (nodeId: string, pinId: string, value: unknown) => void;
};

/** FlowEdge.data（pinType 供连线取色；flowing 为 T5.4 流动动画预留开关） */
export type BPEdgeData = {
  /** exec=执行流（白实线）；data=数据流（按引脚色虚线） */
  kind: 'exec' | 'data';
  /** 引脚类型：exec 边恒为 'exec'；data 边取源输出引脚类型（解析失败回落目标输入类型，再回落 'any'） */
  pinType: IRValueType;
  /** 运行时流动动画（T5.4 调试观察通道激活；本卡仅预留 class 钩子 .bp-edge--flow） */
  flowing?: boolean;
};

/** ReactFlow 节点视图模型（type 恒为 'bpNode'，视觉差异由 data.variant 分支） */
export type FlowNode = Node<BPNodeData, 'bpNode'>;

/** ReactFlow 连线视图模型（type：exec → 'bpExec'，data → 'bpData'） */
export type FlowEdge = Edge<BPEdgeData, 'bpExec' | 'bpData'>;

/** irToFlow 可选项 */
export interface IrToFlowOptions {
  /** 内联默认值变更回调（透传到每个 FlowNode.data，T2.2/T2.4 接命令栈） */
  onPinDefaultChange?: (nodeId: string, pinId: string, value: unknown) => void;
}

/* ============================================================
 * 2. 头变体 / 头色 / 图标映射（纯函数，单测断言对象）
 * ============================================================ */

/**
 * 内置节点 id 前缀（src/nodes/ 九分类模块的注册前缀）。
 * 非此前缀表的带点 id（如 'phoneLog.read'）视为插件节点 → 紫头。
 */
const BUILTIN_ID_PREFIXES: ReadonlySet<string> = new Set([
  'flow', 'event', 'var', 'math', 'string', 'array', 'map', 'convert', 'ui', 'system',
]);

/**
 * 节点头变体判定（PLAN §8.1）：
 * 1. spec 缺失 → unknown（灰色 + 警示图标）；
 * 2. id 前缀 'var.' 或分类 '变量' → var（无头紧凑样式）；
 * 3. 分类 '事件' → event（红）；分类 '流程' → flow（灰）；
 * 4. 分类 '插件' 或非内置 id 前缀 → plugin（紫）；
 * 5. spec.pure → pure（绿）；其余 → function（蓝）。
 */
export function headVariantFor(nodeType: string, spec: NodeSpec | null): HeadVariant {
  if (!spec) return 'unknown';
  if (nodeType.startsWith('var.') || spec.category === '变量') return 'var';
  if (spec.category === '事件') return 'event';
  if (spec.category === '流程') return 'flow';
  if (spec.category === '插件') return 'plugin';
  const dot = spec.id.indexOf('.');
  if (dot > 0 && !BUILTIN_ID_PREFIXES.has(spec.id.slice(0, dot))) return 'plugin';
  if (spec.pure) return 'pure';
  return 'function';
}

/** 头底色（CSS var 引用字符串；JS/DOM 侧取色唯一入口，勿硬编码） */
export function headColorFor(variant: HeadVariant): string {
  switch (variant) {
    case 'event': return NODE_HEAD_COLORS.event;
    case 'function': return NODE_HEAD_COLORS.function;
    case 'pure': return NODE_HEAD_COLORS.pure;
    case 'flow': return NODE_HEAD_COLORS.flow;
    case 'plugin': return NODE_HEAD_COLORS.plugin;
    case 'var': return NODE_HEAD_COLORS.varBg;
    case 'unknown': return COLORS.textDisabled;
  }
}

/** 头左上角分类图标（字符 / emoji） */
const HEAD_ICONS: Record<HeadVariant, string> = {
  event: '⚡',
  function: 'ƒ',
  pure: '∑',
  flow: '⇉',
  plugin: '🧩',
  var: '◈',
  unknown: '⚠',
};

export function headIconFor(variant: HeadVariant): string {
  return HEAD_ICONS[variant];
}

/** 头副标题：未知节点给说明，其余给所属分类（spec 无分类回落图名，UE 式小字） */
export function nodeSubtitle(spec: NodeSpec | null, graphName: string): string {
  if (!spec) return '未知节点类型';
  return spec.category || graphName;
}

/** 变量 Get/Set 节点的操作符（var.get / var.set；var.<op>:<变量名> 实例前缀为 T2.3 预留） */
export function varOpOf(nodeType: string): 'get' | 'set' | null {
  if (nodeType === 'var.get' || nodeType.startsWith('var.get:')) return 'get';
  if (nodeType === 'var.set' || nodeType.startsWith('var.set:')) return 'set';
  return null;
}

/** 变量节点显示名（params.varName，缺省回落「变量」） */
export function varDisplayName(node: IRNode): string {
  const name = node.params?.['varName'];
  if (typeof name === 'string' && name.trim() !== '') return name;
  return '变量';
}

/* ============================================================
 * 3. 尺寸常数与 dagre 自动布局
 * ============================================================ */

/** 常规节点布局尺寸常数（实际渲染随引脚数浮动，取近似均值供 dagre 用） */
export const DEFAULT_NODE_SIZE = { width: 190, height: 96 } as const;
/** var Get/Set 无头紧凑节点尺寸常数 */
export const VAR_NODE_SIZE = { width: 150, height: 44 } as const;
/** 自动布局簇与已定位节点包围盒的间距 */
export const LAYOUT_GAP = 80;

/** dagre 布局参数（LR 流向，对齐 UE 蓝图从左到右的执行流向） */
const DAGRE_OPTIONS = {
  rankdir: 'LR',
  nodesep: 36,
  ranksep: 70,
  marginx: 20,
  marginy: 20,
} as const;

/** 按头变体取布局尺寸常数 */
export function nodeSizeFor(variant: HeadVariant): { width: number; height: number } {
  return variant === 'var' ? { ...VAR_NODE_SIZE } : { ...DEFAULT_NODE_SIZE };
}

/** IRNode 是否带有效画布坐标（JSON 数据可能缺 position，类型上必填、运行时按可选处理） */
export function hasPosition(node: IRNode): boolean {
  return Boolean(
    node.position &&
    Number.isFinite(node.position.x) &&
    Number.isFinite(node.position.y),
  );
}

export interface LayoutEntry {
  id: string;
  width: number;
  height: number;
}

export interface LayoutLink {
  from: string;
  to: string;
}

/**
 * dagre 自动布局（纯函数）：对给定节点 / 有向边做 LR 分层布局，
 * 返回各节点左上角坐标（dagre 输出为中心坐标，此处换算并取整）。
 * 两端都参与的边才进布局；悬空端点自动忽略。
 */
export function autoLayoutPositions(
  entries: readonly LayoutEntry[],
  links: readonly LayoutLink[],
): Map<string, Vec2> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ ...DAGRE_OPTIONS });
  g.setDefaultEdgeLabel(() => ({}));
  for (const entry of entries) {
    g.setNode(entry.id, { width: entry.width, height: entry.height });
  }
  for (const link of links) {
    if (g.hasNode(link.from) && g.hasNode(link.to)) {
      g.setEdge(link.from, link.to);
    }
  }
  dagre.layout(g);
  const out = new Map<string, Vec2>();
  for (const entry of entries) {
    const n = g.node(entry.id) as { x: number; y: number; width: number; height: number };
    out.set(entry.id, {
      x: Math.round(n.x - n.width / 2),
      y: Math.round(n.y - n.height / 2),
    });
  }
  return out;
}

/** 包围盒（不重叠判定的最小几何模型） */
interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bboxOf(boxes: ReadonlyArray<{ position: Vec2; size: { width: number; height: number } }>): BBox | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.position.x);
    minY = Math.min(minY, b.position.y);
    maxX = Math.max(maxX, b.position.x + b.size.width);
    maxY = Math.max(maxY, b.position.y + b.size.height);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 把 dagre 布局出的簇整体平移到「已定位节点包围盒」右侧（上缘对齐），
 * 保证自动布局结果与既有手工布局互不重叠；无已定位节点时原样返回。
 */
function offsetAvoidingPositioned(
  laidOut: ReadonlyMap<string, Vec2>,
  entriesById: ReadonlyMap<string, LayoutEntry>,
  positioned: ReadonlyArray<{ position: Vec2; size: { width: number; height: number } }>,
): Map<string, Vec2> {
  const clusterBoxes: Array<{ position: Vec2; size: { width: number; height: number } }> = [];
  for (const [id, p] of laidOut) {
    const entry = entriesById.get(id);
    if (entry) clusterBoxes.push({ position: p, size: entry });
  }
  const cluster = bboxOf(clusterBoxes);
  const fixed = bboxOf(positioned);
  if (!cluster || !fixed) return new Map(laidOut);
  const dx = fixed.maxX + LAYOUT_GAP - cluster.minX;
  const dy = fixed.minY - cluster.minY;
  const out = new Map<string, Vec2>();
  for (const [id, p] of laidOut) {
    out.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
  }
  return out;
}

/* ============================================================
 * 4. irToFlow / flowToIR（T2.2 接线用的双向映射）
 * ============================================================ */

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_ARR: readonly string[] = [];

function pushDegraded(
  degraded: Map<string, { in: string[]; out: string[] }>,
  nodeId: string,
  dir: 'in' | 'out',
  pinId: string,
): void {
  let slot = degraded.get(nodeId);
  if (!slot) {
    slot = { in: [], out: [] };
    degraded.set(nodeId, slot);
  }
  if (!slot[dir].includes(pinId)) slot[dir].push(pinId);
}

/**
 * IR 资产的某张图 → ReactFlow 视图模型。
 * - FlowNode.data = { node, spec(未知类型为 null), graphName, variant, connectedInputs, ... }；
 * - IREdge → FlowEdge：exec 边 type 'bpExec'（白实线 + 三角端头 marker），data 边 type 'bpData'
 *   （data.pinType 记引脚类型供取色：源输出引脚类型 → 目标输入类型 → 'any'）；
 * - 无有效 position 的节点经 dagre 自动布局（只布局缺失者，且整体平移避开已定位节点）。
 */
export function irToFlow(
  asset: IRAsset,
  specs: Map<string, NodeSpec>,
  graphName: string = asset.entry,
  opts: IrToFlowOptions = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const graph = asset.graphs[graphName];
  if (!graph) return { nodes, edges };

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // 1) 连线预扫描：已连线输入引脚集合 + 未知节点的降级引脚（从连线还原）
  const connectedInputs = new Map<string, Set<string>>();
  const degraded = new Map<string, { in: string[]; out: string[] }>();
  for (const e of graph.edges) {
    let set = connectedInputs.get(e.to.node);
    if (!set) {
      set = new Set();
      connectedInputs.set(e.to.node, set);
    }
    set.add(e.to.pin);
    if (!specs.get(nodeById.get(e.from.node)?.type ?? '')) {
      pushDegraded(degraded, e.from.node, 'out', e.from.pin);
    }
    if (!specs.get(nodeById.get(e.to.node)?.type ?? '')) {
      pushDegraded(degraded, e.to.node, 'in', e.to.pin);
    }
  }

  // 2) 节点：有 position 直接用；缺失的先占位、稍后 dagre 补齐
  const unpositionedNodes: IRNode[] = [];
  const positionedIds = new Set<string>();
  for (const n of graph.nodes) {
    const spec = specs.get(n.type) ?? null;
    const variant = headVariantFor(n.type, spec);
    const positioned = hasPosition(n);
    if (positioned) positionedIds.add(n.id);
    else unpositionedNodes.push(n);
    nodes.push({
      id: n.id,
      type: 'bpNode',
      position: positioned ? { x: n.position.x, y: n.position.y } : { x: 0, y: 0 },
      data: {
        node: n,
        spec,
        graphName,
        variant,
        connectedInputs: connectedInputs.get(n.id) ?? EMPTY_SET,
        degradedInputs: degraded.get(n.id)?.in ?? EMPTY_ARR,
        degradedOutputs: degraded.get(n.id)?.out ?? EMPTY_ARR,
        onPinDefaultChange: opts.onPinDefaultChange,
      },
    });
  }

  // 3) dagre 自动布局（仅缺失 position 的节点；整体平移避开已定位节点包围盒）
  if (unpositionedNodes.length > 0) {
    const unpositionedIds = new Set(unpositionedNodes.map((n) => n.id));
    const entriesById = new Map<string, LayoutEntry>();
    const entries: LayoutEntry[] = unpositionedNodes.map((n) => {
      const size = nodeSizeFor(headVariantFor(n.type, specs.get(n.type) ?? null));
      const entry: LayoutEntry = { id: n.id, width: size.width, height: size.height };
      entriesById.set(n.id, entry);
      return entry;
    });
    const links: LayoutLink[] = graph.edges
      .filter((e) => unpositionedIds.has(e.from.node) && unpositionedIds.has(e.to.node))
      .map((e) => ({ from: e.from.node, to: e.to.node }));
    const positionedBoxes = graph.nodes
      .filter((n) => positionedIds.has(n.id))
      .map((n) => ({
        position: n.position,
        size: nodeSizeFor(headVariantFor(n.type, specs.get(n.type) ?? null)),
      }));
    const laidOut = autoLayoutPositions(entries, links);
    const shifted = offsetAvoidingPositioned(laidOut, entriesById, positionedBoxes);
    for (const [id, p] of shifted) {
      const flowNode = nodes.find((n) => n.id === id);
      if (flowNode) flowNode.position = p;
    }
  }

  // 4) 连线：exec → bpExec（白实线 + 三角端头），data → bpData（按 pinType 取色）
  for (const e of graph.edges) {
    let pinType: IRValueType = e.kind === 'exec' ? 'exec' : 'any';
    if (e.kind === 'data') {
      const fromNode = nodeById.get(e.from.node);
      const fromSpec = fromNode ? specs.get(fromNode.type) : undefined;
      const toNode = nodeById.get(e.to.node);
      const toSpec = toNode ? specs.get(toNode.type) : undefined;
      pinType =
        fromSpec?.outputs.find((p) => p.id === e.from.pin)?.type ??
        toSpec?.inputs.find((p) => p.id === e.to.pin)?.type ??
        'any';
    }
    const flowEdge: FlowEdge = {
      id: e.id,
      source: e.from.node,
      sourceHandle: e.from.pin,
      target: e.to.node,
      targetHandle: e.to.pin,
      type: e.kind === 'exec' ? 'bpExec' : 'bpData',
      data: { kind: e.kind, pinType, flowing: false },
    };
    if (e.kind === 'exec') {
      // 三角端头 marker：SVG <marker fill=…> 属性不吃 var()，按 tokens.ts 约定取原始值
      flowEdge.markerEnd = {
        type: 'arrowclosed' as MarkerType,
        width: 14,
        height: 14,
        color: rawToken('--edge-exec'),
      };
    }
    edges.push(flowEdge);
  }

  return { nodes, edges };
}

/**
 * ReactFlow 节点数组 → IR 节点数组（flowToIR 反向）：拖动后的 position 写回
 * IRNode.position，其余字段原样保留（T2.2 在 onNodesChange 后调用入库）。
 */
export function flowToIR(nodes: readonly FlowNode[]): IRNode[] {
  return nodes.map((n) => ({
    ...n.data.node,
    position: { x: n.position.x, y: n.position.y },
  }));
}

/**
 * ReactFlow 边数组 → IR 边数组：连线增删后的反向映射（T2.2 接线用）。
 * type 'bpExec' → kind 'exec'；'bpData' → kind 'data'。
 */
export function edgesToIR(edges: readonly FlowEdge[]): IREdge[] {
  return edges.map((e) => ({
    id: e.id,
    from: { node: e.source, pin: e.sourceHandle ?? 'exec' },
    to: { node: e.target, pin: e.targetHandle ?? 'exec' },
    kind: e.type === 'bpExec' ? 'exec' : 'data',
  }));
}

/** 连线默认色兜底（组件内未提供 pinType 时使用） */
export const EDGE_DATA_FALLBACK_COLOR = EDGE_COLORS.dataDefault;
