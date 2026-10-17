/**
 * Blueprint Studio v2 —— 运行时蓝图观察·叠加层状态（T5.4，编辑器侧纯函数）
 *
 * 无 React / DOM / CSS 运行时依赖（仅 type import），node:test 直接单测。
 * 职责：
 *  1. 事件批折叠（applyDebugEvents）：WS debug.batch → 叠加状态增量——
 *     节点高亮（nodeEnter/nodeExit → 时间戳）、exec 流动（nodeEnter → 该节点
 *     入向 exec 边）、端口实时值（pinValue → 'nodeId:pinId' 键，只保留最新值）、
 *     节点错误（nodeError → 红色描边标记）。
 *  2. 惰性衰减（decayOverlay）：不挂 timeout 大军——过期条目在下次折叠 /
 *     渲染时按时间戳清掉（叠加层以 250ms 扫描 tick 驱动重渲染）。
 *  3. 视图映射（applyNodeOverlay / applyEdgeOverlay）：把新鲜状态写进受控
 *     nodes/edges 的 data（debugHighlight / flowing）——纯视图层，不经命令栈；
 *     无新鲜条目时返回原数组引用（React memo 直接跳过，性能优先）。
 *
 * 衰减时间：高亮 2s / 流动 0.8s / 端口值 5s / 错误标红 5s（任务卡 DoD）。
 */
import type { DebugEvent } from '../../runtime/interpreter/types';
import type { FlowEdge, FlowNode } from '../../blueprint/view/model';

/* ============================================================
 * 1. 状态与衰减参数
 * ============================================================ */

/** 节点高亮衰减（nodeEnter/nodeExit 后 2s 内描边脉冲） */
export const HIGHLIGHT_TTL_MS = 2000;
/** exec 流动动画清除（离开节点后 800ms） */
export const FLOW_TTL_MS = 800;
/** 端口实时值消隐（5s 未更新消失） */
export const PIN_TTL_MS = 5000;
/** 节点错误标红衰减 */
export const ERROR_TTL_MS = 5000;

/** 叠加层状态（任务卡契约的超集：值附时间戳以支持惰性衰减） */
export interface DebugOverlayState {
  /** 节点高亮：nodeId → 最近一次 nodeEnter/nodeExit 时间戳 */
  nodeHighlight: Map<string, number>;
  /** exec 流动：edgeId → 触发时间戳（nodeEnter 写入，800ms 衰减） */
  flowingEdges: Map<string, number>;
  /** 端口实时值：'nodeId:pinId' → 最新值 + 时间戳（每引脚只留最新） */
  pinValues: Map<string, { value: unknown; ts: number }>;
  /** 节点错误：nodeId → 最近一次 nodeError 时间戳（红色描边） */
  nodeErrors: Map<string, number>;
  /** 最近一批事件到达时间（叠加层「实时中」指示） */
  lastBatchAt: number;
}

/** 空状态（单例：空 Map 恒定返回新对象，避免调用方互相污染） */
export function emptyOverlayState(): DebugOverlayState {
  return {
    nodeHighlight: new Map(),
    flowingEdges: new Map(),
    pinValues: new Map(),
    nodeErrors: new Map(),
    lastBatchAt: 0,
  };
}

/** 叠加状态是否为空（全空 = 无需渲染叠加） */
export function isOverlayEmpty(state: DebugOverlayState): boolean {
  return (
    state.nodeHighlight.size === 0 &&
    state.flowingEdges.size === 0 &&
    state.pinValues.size === 0 &&
    state.nodeErrors.size === 0
  );
}

/* ============================================================
 * 2. 事件批折叠（每批一次，配对 hook 的单次 setState）
 * ============================================================ */

/** 折叠上下文 */
export interface FoldContext {
  /** 折叠时刻（epoch 毫秒；时间戳基准，测试可注入） */
  now: number;
  /**
   * 当前图的「节点 → 入向 exec 边 id 列表」映射（nodeEnter → flowing 的拓扑依据）。
   * 只需当前画布图的边——子图事件（graph != 当前图）不做边映射（节点高亮不受影响）。
   * 缺省 = 不映射流动（仍折叠高亮 / 端口值）。
   */
  inExecEdges?: ReadonlyMap<string, readonly string[]>;
  /** 流动边映射限定的事件源图名（nodeEnter.graph === 此值才映射；缺省不限） */
  graphName?: string;
}

/**
 * 折叠一批调试事件 → 新状态（不改入参；每批调用一次，调用方随即 setState 一次）。
 * emit 事件（事件总线观察，T5.2 面板职责）在此忽略。
 */
export function applyDebugEvents(
  prev: DebugOverlayState,
  events: readonly DebugEvent[],
  ctx: FoldContext,
): DebugOverlayState {
  const nodeHighlight = new Map(prev.nodeHighlight);
  const flowingEdges = new Map(prev.flowingEdges);
  const pinValues = new Map(prev.pinValues);
  const nodeErrors = new Map(prev.nodeErrors);
  for (const ev of events) {
    const ts = typeof ev.ts === 'number' ? ev.ts : ctx.now;
    switch (ev.kind) {
      case 'nodeEnter': {
        if (!ev.nodeId) break;
        nodeHighlight.set(ev.nodeId, ts);
        // exec 流动：进入节点 → 该节点的入向 exec 边亮起（刚流过的那一段）
        if (ctx.inExecEdges && (ctx.graphName === undefined || ev.graph === ctx.graphName)) {
          for (const edgeId of ctx.inExecEdges.get(ev.nodeId) ?? []) {
            flowingEdges.set(edgeId, ts);
          }
        }
        break;
      }
      case 'nodeExit': {
        if (!ev.nodeId) break;
        nodeHighlight.set(ev.nodeId, ts); // 脉冲时间戳刷新（离开后 2s 衰减）
        break;
      }
      case 'pinValue': {
        if (!ev.nodeId || !ev.pinId) break;
        pinValues.set(`${ev.nodeId}:${ev.pinId}`, { value: ev.value, ts }); // 每引脚只留最新
        break;
      }
      case 'nodeError': {
        if (!ev.nodeId) break;
        nodeErrors.set(ev.nodeId, ts);
        break;
      }
      default:
        break; // emit：编辑器叠加层不用（事件面板 T5.2 职责）
    }
  }
  return { nodeHighlight, flowingEdges, pinValues, nodeErrors, lastBatchAt: ctx.now };
}

/**
 * 惰性衰减：清掉时间戳过期的条目（高亮 2s / 流动 0.8s / 端口值 5s / 错误 5s）。
 * 无过期条目返回原引用（调用方可据此跳过重渲染）。
 */
export function decayOverlay(state: DebugOverlayState, now: number): DebugOverlayState {
  let changed = false;
  const nodeHighlight = filterFresh(state.nodeHighlight, now, HIGHLIGHT_TTL_MS, () => (changed = true));
  const flowingEdges = filterFresh(state.flowingEdges, now, FLOW_TTL_MS, () => (changed = true));
  const pinValues = filterFresh(
    state.pinValues,
    now,
    PIN_TTL_MS,
    () => (changed = true),
    (v) => v.ts,
  );
  const nodeErrors = filterFresh(state.nodeErrors, now, ERROR_TTL_MS, () => (changed = true));
  if (!changed) return state;
  return { nodeHighlight, flowingEdges, pinValues, nodeErrors, lastBatchAt: state.lastBatchAt };
}

/** 按时间戳过滤过期键（值为 number 或 {ts}）；无变化返回原 Map 引用 */
function filterFresh<V>(
  map: ReadonlyMap<string, V>,
  now: number,
  ttlMs: number,
  onChange: () => void,
  tsOf?: (v: V) => number,
): Map<string, V> {
  let out: Map<string, V> | null = null;
  for (const [key, value] of map) {
    const ts = tsOf ? tsOf(value) : (value as unknown as number);
    if (now - ts > ttlMs) {
      if (!out) out = new Map(map);
      out.delete(key);
      onChange();
    }
  }
  return out ?? (map as Map<string, V>);
}

/* ============================================================
 * 3. 视图映射（受控 nodes/edges 的 data 注入；纯函数）
 * ============================================================ */

/** 节点叠加标记（写入 FlowNode.data.debugHighlight；BPNode 读它加 class） */
export type DebugHighlightKind = 'active' | 'error';

/**
 * 把新鲜的节点高亮 / 错误标记写进受控节点数组：
 * - 只为「有新鲜标记或刚过期的节点」创建新对象（其余保持原引用，React memo 跳过）；
 * - 无任何视觉变化的整批 → 返回原数组引用（叠加空闲时零开销）。
 */
export function applyNodeOverlay(
  nodes: readonly FlowNode[],
  state: DebugOverlayState,
  now: number,
): FlowNode[] {
  let out: FlowNode[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const hl = state.nodeHighlight.get(node.id);
    const err = state.nodeErrors.get(node.id);
    const kind: DebugHighlightKind | undefined = err !== undefined && now - err <= ERROR_TTL_MS
      ? 'error'
      : hl !== undefined && now - hl <= HIGHLIGHT_TTL_MS
        ? 'active'
        : undefined;
    const prevKind = (node.data as { debugHighlight?: DebugHighlightKind }).debugHighlight;
    if (kind === prevKind) continue; // 该节点视觉不变：保持原对象
    if (!out) out = nodes.slice();
    out[i] = {
      ...node,
      data: { ...node.data, debugHighlight: kind } as FlowNode['data'],
    };
  }
  return out ?? (nodes as FlowNode[]);
}

/**
 * 把新鲜的 exec 流动标记写进受控连线数组（data.flowing → .bp-edge--flow 动画）：
 * 只改流动集内的边；空闲时返回原数组引用。
 */
export function applyEdgeOverlay(
  edges: readonly FlowEdge[],
  flowing: ReadonlyMap<string, number>,
  now: number,
): FlowEdge[] {
  if (flowing.size === 0) return edges as FlowEdge[];
  let out: FlowEdge[] | null = null;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const ts = flowing.get(edge.id);
    const fresh = ts !== undefined && now - ts <= FLOW_TTL_MS;
    if (Boolean(edge.data?.flowing) === fresh) continue;
    if (!out) out = edges.slice();
    out[i] = {
      ...edge,
      data: { ...edge.data!, flowing: fresh },
    };
  }
  return out ?? (edges as FlowEdge[]);
}

/* ============================================================
 * 4. 辅助：入向 exec 边表（从受控边构建，panel 调 useMemo 缓存）
 * ============================================================ */

/** 受控边数组 → nodeId → 入向 exec 边 id 列表（nodeEnter → flowing 的拓扑依据） */
export function buildInExecEdges(edges: readonly FlowEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.data?.kind !== 'exec') continue;
    const list = out.get(e.target);
    if (list) list.push(e.id);
    else out.set(e.target, [e.id]);
  }
  return out;
}
