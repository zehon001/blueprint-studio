/**
 * Blueprint Studio v2 —— IR 解释器 v2（T2.5，关键路径卡）
 *
 * 蓝图式「exec 控制流 + 数据流」混合执行，语义真源：
 *  - ADR-001 / ADR-003：IR 结构与 NodeRunFn 执行契约（inputs 组装 / next 选口 / 异步 / 纯节点）；
 *  - ADR-005：循环状态机（循环/sequence/timer 节点靠「链尾 exec 回连节点 exec 入」驱动，
 *    解释器支持同一节点 exec 入被反复触发；stop/创建时 clearAllStateSlots() 复位）；
 *  - PLAN §11 / §12 与 v1.1 参考实现（b8f6fca src/engine/interpreter.ts + engine.worker.ts）：
 *    串行事件队列（FIFO 保序、处理中再 emit 排队不递归）+ 旁路防死锁（print / 调试探针 /
 *    onError 直调回调不入队；delay 用内部 Promise 定时器，不占事件队列）。
 *
 * 结构说明：
 *  - 解释器核心不 import 任何具体内置节点：NodeSpec 全部由参数注入（T2.6 / T5.1 按需传
 *    builtinSpecMap 或插件合并表）；唯一例外是 ADR-005 要求的状态机复位 clearAllStateSlots()
 *    （来自 @/nodes/spec，节点定义基础设施，非节点本体）。
 *  - 少数「图级操作」类型是解释器自有约定（不在节点库中，specs 缺失也照常工作）：
 *      flow.call（params.graph=图名，函数调用） / func.entry|flow.entry（子图入口，输出=入参） /
 *      func.return|flow.return（子图出口，输入=返回值，链终止）。其中 func.entry / func.return
 *      与 ADR-001 示例对齐，flow.entry / flow.return 与任务卡约定对齐，两套 id 等价支持。
 *  - 事件入口约定（与 src/nodes/events.ts 对齐）：event.start 为启动入口（start() 触发）；
 *    event.custom 的实例经 params.eventName 绑定事件名（无该参数时回退：节点 title 命中
 *    IREventDef.name 即视为绑定）；event.listen 经 eventName 输入引脚（内联默认值或纯节点链）
 *    绑定。事件参数注入：IREventDef.params 按名 + 位置式 arg0~arg2（占位脚），custom /
 *    listen 的具名输出脚按名注入，listen 另注入 args 对象（T5.3 起两者一致）。
 */
import type {
  IRAsset,
  IREdge,
  IREndpoint,
  IREventDef,
  IRGraph,
  IRNode,
  IRValueType,
  NodeRunContext,
  NodeRunResult,
  NodeSpec,
} from '@/ir/types';
import { clearAllStateSlots } from '@/nodes/spec';
import { BUS_SOURCE_NODE_KEY } from '../events/markers';
import type { DebugEvent, RuntimeHandle, RuntimeOptions } from './types';

/* ============================================================
 * 解释器自有类型约定（图级操作，非节点库成员）
 * ============================================================ */

/** 函数调用节点（caller 侧）：params.graph = 目标图名；输出 = 子图返回值（键 = returns 名） */
const TYPE_FLOW_CALL = 'flow.call';
/** 子图入口节点（callee 侧，ADR-001 示例约定） */
const TYPE_FUNC_ENTRY = 'func.entry';
/** 子图入口节点（与 flow.call / flow.return 配套的等价 id） */
const TYPE_FLOW_ENTRY = 'flow.entry';
/** 子图出口节点（ADR-001 示例约定） */
const TYPE_FUNC_RETURN = 'func.return';
/** 子图出口节点（任务卡约定，等价支持） */
const TYPE_FLOW_RETURN = 'flow.return';

/** 解释器自有类型集合（specs 中无需存在；作为数据源时按输出缓存读取） */
const OWNED_TYPES: ReadonlySet<string> = new Set([
  TYPE_FLOW_CALL,
  TYPE_FUNC_ENTRY,
  TYPE_FLOW_ENTRY,
  TYPE_FUNC_RETURN,
  TYPE_FLOW_RETURN,
]);

/* 事件入口节点的类型 id（与 src/nodes/events.ts 的节点 id 对应；节点本体走注入 specs 正常执行） */
const TYPE_EVENT_START = 'event.start';
const TYPE_EVENT_CUSTOM = 'event.custom';
const TYPE_EVENT_LISTEN = 'event.listen';

/** start() 触发的内部事件名（只路由到 event.start 节点，BeginPlay 同义） */
const START_EVENT = 'start';

/** 函数递归调用深度限制（防栈爆） */
const MAX_CALL_DEPTH = 64;
/** 单链默认最大执行步数（死循环保护） */
const DEFAULT_MAX_STEPS = 100_000;

/* ============================================================
 * 内部结构
 * ============================================================ */

/** 一张图的运行期索引（节点与连线的双向查找表） */
interface IndexedGraph {
  /** 图名（键 = IRAsset.graphs 的键） */
  name: string;
  /** 原始 IR 图 */
  ref: IRGraph;
  /** 节点实例查找表（键 = IRNode.id） */
  nodesById: Map<string, IRNode>;
  /** 出边索引（键 = `nodeId:pinId`） */
  edgesBySource: Map<string, IREdge[]>;
  /** 入边索引（键 = `nodeId:pinId`） */
  edgesByTarget: Map<string, IREdge[]>;
}

/**
 * 执行帧：一段执行链的数据上下文。
 * - 事件链启动时创建基帧（缓存按事件链生命周期）；
 * - flow.call / callGraph 为子图压独立帧（函数图独立栈帧，ADR-003 数据不串帧）。
 * 帧不放进共享栈（异步链会在 await 点交错，栈只能靠 async 调用嵌套表达）；
 * 递归深度由 depth 参数沿调用链传递。
 */
interface Frame {
  graphName: string;
  graph: IndexedGraph;
  /** 函数入参（仅函数帧；图内 var 作用域：ctx.getVar 先查此处再查资产变量） */
  args: Record<string, unknown>;
  /** flow.return 收集的返回值（invokeGraph 的返回值来源） */
  returns: Record<string, unknown>;
  /** 执行节点输出缓存（键 = 节点实例 id；数据边从执行节点取值即读此处） */
  cache: Map<string, Record<string, unknown>>;
}

/** 一次求值（一个节点的 inputs 组装过程）的纯节点记忆化上下文 */
interface Assembly {
  /** 已求值纯节点的输出（同一次求值内记忆化） */
  memo: Map<string, Record<string, unknown>>;
  /** 求值中的纯节点（防循环：再次进入即抛错） */
  inProgress: Set<string>;
}

/** inputs 组装用的引脚描述（PinSpec 的最小子集；解释器自有类型按 IRGraph.params/returns 动态合成） */
interface InputPinDesc {
  id: string;
  type?: IRValueType;
  multi?: boolean;
  defaultValue?: unknown;
}

/** 串行事件队列的条目 */
interface QueuedEvent {
  name: string;
  args: Record<string, unknown>;
}

/** 事件分发目标（一个入口节点实例 = 一条执行链） */
interface EventTarget {
  graph: IndexedGraph;
  nodeId: string;
  /** 注入入口节点输出缓存的事件参数（事件参数 → 输出数据脚） */
  seed?: Record<string, unknown>;
}

/* ============================================================
 * 小工具
 * ============================================================ */

function strOf(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** 类型零值（IRVariable.default 省略时的起值） */
function zeroValue(type: IRValueType): unknown {
  switch (type) {
    case 'bool':
      return false;
    case 'int':
    case 'float':
      return 0;
    case 'string':
      return '';
    case 'object':
      return {};
    default:
      // any / 自定义对象别名 / 数组
      return typeof type === 'string' && type.endsWith('[]') ? [] : null;
  }
}

/** 是否为函数子图（声明了 params / returns 即视为函数图） */
function isFunctionGraph(g: IRGraph): boolean {
  return (g.params?.length ?? 0) > 0 || (g.returns?.length ?? 0) > 0;
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function makeAbortError(): Error {
  const e = new Error('运行已停止（AbortError）');
  e.name = 'AbortError';
  return e;
}

/**
 * 给错误挂上首次抛出处的图 / 节点上下文（最深层优先，且只挂一次）。
 * 节点错误沿 async 链向上传播，最终在「事件目标边界 / callGraph 调用方」统一收口上报。
 */
function withCtx(err: unknown, graphName: string, nodeId: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const rec = e as Error & { __graph?: string; __nodeId?: string };
  if (rec.__graph === undefined) {
    rec.__graph = graphName;
    rec.__nodeId = nodeId;
  }
  return e;
}

function errGraph(err: unknown): string | undefined {
  return (err as { __graph?: string }).__graph;
}

function errNodeId(err: unknown): string | undefined {
  return (err as { __nodeId?: string }).__nodeId;
}

/** 建立一张图的运行期索引 */
function indexGraph(name: string, ref: IRGraph): IndexedGraph {
  const nodesById = new Map<string, IRNode>();
  const edgesBySource = new Map<string, IREdge[]>();
  const edgesByTarget = new Map<string, IREdge[]>();
  for (const node of ref.nodes ?? []) nodesById.set(node.id, node);
  const push = (m: Map<string, IREdge[]>, key: string, edge: IREdge) => {
    const arr = m.get(key);
    if (arr) arr.push(edge);
    else m.set(key, [edge]);
  };
  for (const edge of ref.edges ?? []) {
    push(edgesBySource, `${edge.from.node}:${edge.from.pin}`, edge);
    push(edgesByTarget, `${edge.to.node}:${edge.to.pin}`, edge);
  }
  return { name, ref, nodesById, edgesBySource, edgesByTarget };
}

/**
 * 事件参数 → 入口节点输出缓存（event.custom 的输出脚动态扩展）：
 * 1. 命名注入：IREventDef.params 名单（未声明事件则用 args 的键）；
 * 2. 位置注入：按参数顺序映射到占位脚 arg0 / arg1 / arg2（与节点库静态占位脚对齐）；
 * 3. 散键兜底：args 中不在名单内的键也按名注入（命名优先于位置，避免 arg0 这类同名参数被覆盖）。
 * sourceNode（ADR-010 §3 来源节点名）不占位置脚：只经散键兜底注入同名出脚，
 * 避免挤压业务参数的 arg0~arg2 槽位。
 */
function buildEventOutputs(def: IREventDef | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const outs: Record<string, unknown> = {};
  const entries: [string, unknown][] = def
    ? def.params.map((p) => [p.name, args[p.name]] as [string, unknown])
    : Object.entries(args).filter(([key]) => key !== BUS_SOURCE_NODE_KEY);
  for (const [name, value] of entries) {
    if (value !== undefined) outs[name] = value;
  }
  entries.forEach(([, value], i) => {
    const pos = `arg${i}`;
    if (outs[pos] === undefined) outs[pos] = value;
  });
  for (const [key, value] of Object.entries(args)) {
    if (!(key in outs)) outs[key] = value;
  }
  return outs;
}

/* ============================================================
 * 运行时主体
 * ============================================================ */

class BlueprintRuntime implements RuntimeHandle {
  private readonly asset: IRAsset;
  private readonly specs: Map<string, NodeSpec>;
  private readonly opts: RuntimeOptions;
  private readonly graphs: Map<string, IndexedGraph>;
  private readonly maxSteps: number;

  /** 资产变量存储（所有 ctx 共享同一份；创建时按声明起值，opts.vars 覆盖） */
  private readonly vars = new Map<string, unknown>();

  private running = false;
  private controller: AbortController = new AbortController();
  /** 串行事件队列（FIFO 数组 + drain 泵；处理中再 emit 只是追加，不递归） */
  private readonly pending: QueuedEvent[] = [];
  private draining = false;
  /** ADR-008：正在产出多次出脚的节点实例 id（generator 运行期间再触发 = 忽略，旧回连边安全降级为 no-op） */
  private readonly activeGenerators = new Set<string>();
  /** ADR-010：协作式派发深度（0 = 顶层让出点；>0 = 让出派发中，嵌套链的让出点不再派发） */
  private coopDepth = 0;

  constructor(asset: IRAsset, specs: Map<string, NodeSpec>, opts: RuntimeOptions) {
    this.asset = asset;
    this.specs = specs;
    this.opts = opts;
    this.maxSteps = Math.max(1, opts.maxStepsPerChain ?? DEFAULT_MAX_STEPS);
    this.graphs = new Map(
      Object.entries(asset.graphs ?? {}).map(([name, graph]) => [name, indexGraph(name, graph)]),
    );
    // 变量初始化：声明默认值起值（省略 = 类型零值）→ opts.vars 覆盖
    for (const v of asset.variables ?? []) {
      this.vars.set(v.name, v.default !== undefined ? v.default : zeroValue(v.type));
    }
    if (opts.vars) {
      for (const [name, value] of Object.entries(opts.vars)) this.vars.set(name, value);
    }
    // ADR-005：创建时复位全部节点状态槽（重跑同一资产时循环/触发状态从零开始）
    clearAllStateSlots();
  }

  /* ---------------- 生命周期 ---------------- */

  get isRunning(): boolean {
    return this.running;
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.running) throw new Error('运行已启动：请先 stop() 再重新 start()');
    this.running = true;
    this.activeGenerators.clear(); // 新纪元：无活跃 generator（保险，正常 stop 已清）
    this.controller = new AbortController();
    // 触发 start 事件（BeginPlay 同义）：走串行事件队列，与后续事件保持同样语义
    this.pending.push({ name: START_EVENT, args: {} });
    void this.drain();
  }

  stop(): void {
    if (!this.running) return; // 幂等
    this.running = false;
    this.pending.length = 0; // 清队：未处理的事件全部丢弃
    this.controller.abort(); // 挂起的 ctx.delay 以 AbortError reject，节点容错
    this.activeGenerators.clear(); // ADR-008：清活跃 generator（运行中的 run* 由 chainSignal 检查中止）
    // ADR-005：复位循环 / sequence / timer 状态机（状态槽按节点实例 id 全局隔离）
    clearAllStateSlots();
  }

  /* ---------------- 串行事件队列（PLAN §11，v1.1 语义对齐） ---------------- */

  emit(name: string, args?: Record<string, unknown>): void {
    if (!this.running) return; // 未启动 / 已停止：静默丢弃
    this.pending.push({ name, args: args ? { ...args } : {} });
    void this.drain();
  }

  /** 读资产变量（未声明且未写入过 = undefined；与所有 ctx 共享同一存储） */
  getVar(name: string): unknown {
    return this.vars.get(name);
  }

  /** 写资产变量（未声明变量名也会写入，之后可读） */
  setVar(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  /** 事件泵：FIFO 逐条消费；已在泵动时只入队不递归（处理中再 emit 排队等待） */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running && this.pending.length > 0) {
        const ev = this.pending.shift()!;
        try {
          await this.dispatchQueued(ev);
        } catch (err) {
          // 兜底收口（正常情况下节点错误已在各目标边界上报）
          const e = err instanceof Error ? err : new Error(String(err));
          this.reportError(e, errGraph(e) ?? this.asset.entry, errNodeId(e) ?? '');
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * ADR-010 协作式调度·让出点：多次出脚节点（unlimitedFires）的 yield 边界上派发
   * 串行队列积压事件——无条件循环（timer/whileLoop）不再把后续事件饿死在队列里。
   * 约束：
   *  - 仅顶层让出点派发（coopDepth 守卫）：被派发事件的链内部再遇让出点不嵌套，
   *    防止「无限链套无限链」的派发栈失控（嵌套场景回落 ADR-008 旧语义 = 阻塞）；
   *  - 逐条 shift 派发、await 完整链：FIFO 保序与「一次一条链」的串行语义不变；
   *  - 让出延迟上限 ≈ 让出节点的产出间隔（如 timer 的 interval 秒）。
   */
  private async coopDrainPending(): Promise<void> {
    if (this.coopDepth > 0) return;
    while (this.running && this.pending.length > 0) {
      const ev = this.pending.shift()!;
      this.coopDepth += 1;
      try {
        await this.dispatchQueued(ev);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.reportError(e, errGraph(e) ?? this.asset.entry, errNodeId(e) ?? '');
      } finally {
        this.coopDepth -= 1;
      }
    }
  }

  /** 消费一条事件：定位入口节点，逐目标开链执行（目标间相互隔离，单链失败不影响后续目标） */
  private async dispatchQueued(ev: QueuedEvent): Promise<void> {
    this.debug({ kind: 'emit', graph: this.asset.entry, message: ev.name, value: ev.args });
    const targets =
      ev.name === START_EVENT ? this.startTargets() : await this.findEventTargets(ev);
    for (const target of targets) {
      if (!this.running) return; // stop 清队后不再启动新链
      try {
        await this.runChain(this.makeFrame(target.graph), target.nodeId, target.seed, 0);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.reportError(e, errGraph(e) ?? target.graph.name, errNodeId(e) ?? target.nodeId);
      }
    }
  }

  /** start 事件目标：所有非函数图中的 event.start 节点 */
  private startTargets(): EventTarget[] {
    const targets: EventTarget[] = [];
    for (const g of this.graphs.values()) {
      if (isFunctionGraph(g.ref)) continue;
      for (const node of g.ref.nodes ?? []) {
        if (node.type === TYPE_EVENT_START) targets.push({ graph: g, nodeId: node.id });
      }
    }
    return targets;
  }

  /** 自定义事件目标：event.custom（params.eventName 绑定，title 命中已声明事件名回退）+ event.listen（eventName 引脚绑定） */
  private async findEventTargets(ev: QueuedEvent): Promise<EventTarget[]> {
    const def = (this.asset.events ?? []).find((e) => e.name === ev.name);
    const targets: EventTarget[] = [];
    for (const g of this.graphs.values()) {
      for (const node of g.ref.nodes ?? []) {
        if (node.type === TYPE_EVENT_CUSTOM) {
          if (this.customEventName(node) === ev.name) {
            targets.push({ graph: g, nodeId: node.id, seed: buildEventOutputs(def, ev.args) });
          }
        } else if (node.type === TYPE_EVENT_LISTEN) {
          if ((await this.resolveListenName(g, node)) === ev.name) {
            // 具名参数注入（T5.3）：与 event.custom 同语义，IREventDef.params 按名扩展输出脚
            // （如 count / label 可直接连数据边）；args 输出脚保持「完整参数对象」语义
            //（同名冲突以 args 对象优先，未声明事件由散键兜底）。
            targets.push({
              graph: g,
              nodeId: node.id,
              seed: { ...buildEventOutputs(def, ev.args), args: { ...ev.args } },
            });
          }
        }
      }
    }
    return targets;
  }

  /** event.custom 实例绑定的事件名：params.eventName 优先，回退「title 命中已声明事件名」 */
  private customEventName(node: IRNode): string {
    const p = node.params?.eventName;
    if (typeof p === 'string' && p !== '') return p;
    const title = node.title;
    if (title && (this.asset.events ?? []).some((e) => e.name === title)) return title;
    return '';
  }

  /**
   * event.listen 实例绑定的事件名：内联默认值优先；连线时仅支持纯节点链求值
   * （事件路由发生在链启动前，无执行帧可读执行节点缓存——建议 eventName 用内联默认值）。
   */
  private async resolveListenName(g: IndexedGraph, node: IRNode): Promise<string> {
    const inline = node.pinDefaults?.eventName;
    if (typeof inline === 'string' && inline !== '') return inline;
    const spec = this.specs.get(node.type);
    const edge = (g.edgesByTarget.get(`${node.id}:eventName`) ?? []).find((e) => e.kind === 'data');
    if (edge) {
      const src = g.nodesById.get(edge.from.node);
      const srcSpec = src ? this.specs.get(src.type) : undefined;
      if (src && srcSpec?.pure) {
        const outs = await this.evaluatePure(
          this.makeFrame(g),
          src,
          { memo: new Map(), inProgress: new Set() },
        );
        return strOf(outs[edge.from.pin]);
      }
      return '';
    }
    return strOf(spec?.inputs.find((p) => p.id === 'eventName')?.defaultValue ?? '');
  }

  /* ---------------- 函数调用 ---------------- */

  callGraph(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.running) {
      return Promise.reject(new Error('运行未启动：请先 start()（callGraph 随调随执行，不经事件队列）'));
    }
    // 旁路直调：压独立帧执行（与进行中的事件链仅在 await 点交错，符合潜伏节点语义）；
    // 错误只 reject 给调用方（不在内部上报——若处于某条事件链内，错误会沿链在目标边界统一上报）。
    return this.invokeGraph(name, args ?? {}, 0);
  }

  /** 执行一个函数图：压帧 → 从入口节点开链 → 返回 flow.return 收集的返回值记录 */
  private async invokeGraph(
    graphName: string,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<Record<string, unknown>> {
    if (depth > MAX_CALL_DEPTH) {
      throw new Error(`函数递归调用深度超过 ${MAX_CALL_DEPTH}：${graphName}（疑似无限递归）`);
    }
    const g = this.graphs.get(graphName);
    if (!g) throw new Error(`函数图不存在: ${graphName}`);
    const frame = this.makeFrame(g);
    // 图参数 → 帧入参（图内 var 作用域：函数内 ctx.getVar 先读到此处；只收 IRGraph.params 名单内的键）
    for (const p of g.ref.params ?? []) {
      if (args[p.name] !== undefined) frame.args[p.name] = args[p.name];
    }
    const entry = this.findFunctionEntry(g);
    await this.runChain(frame, entry, undefined, depth);
    return frame.returns;
  }

  /** 找函数图入口节点：func.entry / flow.entry 优先；回退「有 exec 出口且 exec 入未连线」的第一个节点 */
  private findFunctionEntry(g: IndexedGraph): string {
    for (const node of g.ref.nodes ?? []) {
      if (node.type === TYPE_FUNC_ENTRY || node.type === TYPE_FLOW_ENTRY) return node.id;
    }
    const withExecOut = (g.ref.nodes ?? []).filter((node) => {
      const spec = this.specs.get(node.type);
      return !!spec && spec.outputs.some((p) => p.type === 'exec');
    });
    const noExecIn = withExecOut.find((node) => {
      const spec = this.specs.get(node.type)!;
      return !spec.inputs.some(
        (p) => p.type === 'exec' && g.edgesByTarget.has(`${node.id}:${p.id}`),
      );
    });
    if (noExecIn) return noExecIn.id;
    if (withExecOut[0]) return withExecOut[0].id;
    throw new Error(`函数图缺少入口节点: ${g.name}（约定 func.entry / flow.entry）`);
  }

  /* ---------------- exec 链执行 ---------------- */

  private makeFrame(g: IndexedGraph): Frame {
    return { graphName: g.name, graph: g, args: {}, returns: {}, cache: new Map() };
  }

  /**
   * 沿 exec 边逐节点执行一条链（异步函数；await 潜伏节点时让出事件循环）。
   * 节点错误不在此捕获（挂上下文后向上抛），由「事件目标边界 / callGraph 调用方」收口；
   * 链头持有本纪元的 AbortSignal，stop() 后链不再推进（挂起的 delay 已 reject）。
   *
   * ADR-005：同一节点 exec 入可被反复触发（循环/sequence/timer 的链尾回连走本 while 循环，
   * 状态由节点状态槽持有，与解释器解耦）。
   */
  private async runChain(
    frame: Frame,
    startNodeId: string,
    seed: Record<string, unknown> | undefined,
    depth: number,
  ): Promise<void> {
    const chainSignal = this.signal;
    let current: string | undefined = startNodeId;
    let steps = 0;
    while (current) {
      if (chainSignal.aborted) return; // stop：静默终止链
      if (++steps > this.maxSteps) {
        throw withCtx(
          new Error(`单链执行超过 ${this.maxSteps} 步已中止：疑似 exec 死循环（图 ${frame.graphName}，节点 ${current}）`),
          frame.graphName,
          current,
        );
      }
      const node = frame.graph.nodesById.get(current);
      if (!node) throw withCtx(new Error(`节点不存在: ${current}`), frame.graphName, current);
      const owned = OWNED_TYPES.has(node.type);
      const spec = this.specs.get(node.type);
      if (!spec && !owned) {
        throw withCtx(new Error(`未知节点类型: ${node.type}（节点 ${node.id}）`), frame.graphName, node.id);
      }
      if (spec?.pure) {
        // 运行时兜底（编辑器校验器 T2.8 为主）：exec 链不能穿过纯节点
        throw withCtx(
          new Error(`exec 边不允许指向纯节点: ${node.type}(${node.id})——纯节点应由数据边按需求值`),
          frame.graphName,
          node.id,
        );
      }

      this.debug({ kind: 'nodeEnter', graph: frame.graphName, nodeId: node.id });
      const assembly: Assembly = { memo: new Map(), inProgress: new Set() };
      let outputs: Record<string, unknown> = {};
      let nextPin: string | undefined;
      try {
        if (node.type === TYPE_FLOW_CALL) {
          // 函数调用：params.graph 定位子图，输入引脚 = IRGraph.params 名单，压独立帧执行
          const graphName = strOf(node.params?.graph);
          const target = this.graphs.get(graphName);
          if (!target) throw new Error(`函数图不存在: ${graphName}（flow.call 节点 ${node.id}）`);
          const argPins: InputPinDesc[] = (target.ref.params ?? []).map((p) => ({ id: p.name, type: p.type }));
          const args = await this.resolveInputs(frame, node, argPins, assembly);
          outputs = await this.invokeGraph(graphName, args, depth + 1);
          nextPin = 'exec';
        } else if (node.type === TYPE_FUNC_ENTRY || node.type === TYPE_FLOW_ENTRY) {
          // 子图入口：输出 = 调用方传入的参数（专用上下文；引脚由 IRGraph.params 动态决定）
          outputs = { ...frame.args };
          nextPin = 'exec';
        } else if (node.type === TYPE_FUNC_RETURN || node.type === TYPE_FLOW_RETURN) {
          // 子图出口：按 IRGraph.returns 名单解析输入 → 记入帧返回值；链终止
          const retPins: InputPinDesc[] = (frame.graph.ref.returns ?? []).map((p) => ({ id: p.name, type: p.type }));
          const rets = await this.resolveInputs(frame, node, retPins, assembly);
          Object.assign(frame.returns, rets);
          nextPin = undefined;
        } else {
          // 常规节点：组装 inputs → run → 缓存输出 → next 选口
          const inputs = await this.resolveInputs(frame, node, spec!.inputs, assembly);
          const ctx = this.ctxFor(frame, node, spec!);
          const result = await this.invokeRun(spec!, ctx, inputs);
          if (isAsyncGenerator(result)) {
            // ADR-008 多次出脚：逐 yield 更新缓存并驱动出脚子链；generator 全权决定所有出脚
            await this.driveGenerator(frame, node, spec!, result, chainSignal, depth);
            outputs = {};
            nextPin = undefined;
          } else {
            outputs = result.outputs ?? {};
            nextPin = pickNext(spec!, node, result);
          }
        }
      } catch (err) {
        throw withCtx(err, frame.graphName, node.id);
      }

      // 事件入口节点：事件参数覆盖注入输出缓存（seed 仅对链首节点生效）
      const merged =
        current === startNodeId && seed ? { ...outputs, ...seed } : outputs;
      frame.cache.set(node.id, merged);
      for (const [pinId, value] of Object.entries(merged)) {
        this.debug({ kind: 'pinValue', graph: frame.graphName, nodeId: node.id, pinId, value });
      }
      this.debug({ kind: 'nodeExit', graph: frame.graphName, nodeId: node.id });
      current = nextPin === undefined ? undefined : this.followExec(frame, node, nextPin);
    }
  }

  /** 沿 exec 边找下一节点（无连线 / 出口无边 = 链自然结束；目标合法性由链头校验） */
  private followExec(frame: Frame, node: IRNode, pin: string): string | undefined {
    const edges = frame.graph.edgesBySource.get(`${node.id}:${pin}`) ?? [];
    const execEdge = edges.find((e) => e.kind === 'exec');
    return execEdge ? execEdge.to.node : undefined;
  }

  /**
   * ADR-008：驱动多次出脚节点（async generator）——逐 yield 更新输出缓存并执行出脚子链，
   * 每条子链完整执行后才请求下一个 yield（与 UE5「循环体执行完才下一迭代」一致）。
   * 重入（activeGenerators 已含该节点）直接返回：旧「链尾回连」边安全降级为 no-op。
   * yield 产出超过 maxSteps 视为疑似死循环并抛错；中止/异常时 return() 关闭 generator。
   */
  private async driveGenerator(
    frame: Frame,
    node: IRNode,
    spec: NodeSpec,
    gen: AsyncGenerator<NodeRunResult, void, unknown>,
    chainSignal: AbortSignal,
    depth: number,
  ): Promise<void> {
    if (this.activeGenerators.has(node.id)) return;
    this.activeGenerators.add(node.id);
    let fires = 0;
    try {
      for (;;) {
        if (chainSignal.aborted) return;
        const step = await gen.next();
        if (step.done) return;
        // 产出上限：未声明 unlimitedFires 的节点超 maxSteps 视为疑似死循环
        // （timer/whileLoop 等合法无限产出声明 unlimitedFires 跳过，ADR-008）
        if (!spec.unlimitedFires && ++fires > this.maxSteps) {
          throw withCtx(
            new Error(
              `节点 ${spec.id}(${node.id}) 多次出脚超过 ${this.maxSteps} 次已中止：疑似 exec 死循环（ADR-008）`,
            ),
            frame.graphName,
            node.id,
          );
        }
        const outs = step.value.outputs ?? {};
        frame.cache.set(node.id, { ...outs });
        for (const [pinId, value] of Object.entries(outs)) {
          this.debug({ kind: 'pinValue', graph: frame.graphName, nodeId: node.id, pinId, value });
        }
        const nextPin = pickNext(spec, node, step.value);
        const downstream = nextPin === undefined ? undefined : this.followExec(frame, node, nextPin);
        if (downstream) await this.runChain(frame, downstream, undefined, depth);
        // ADR-010：unlimitedFires 节点（timer/whileLoop）的 yield 边界 = 让出点，
        // 出脚子链完整执行后、下次计时/迭代前，把队列积压事件派发掉（顶层一次）
        if (spec.unlimitedFires) await this.coopDrainPending();
      }
    } finally {
      this.activeGenerators.delete(node.id);
      try {
        await gen.return(undefined as never);
      } catch {
        /* generator 已自行结束 / 关闭失败忽略 */
      }
    }
  }

  /* ---------------- 数据流（按需求值） ---------------- */

  /**
   * 组装节点输入（ADR-003 §3.1）：
   * - 已连线：取连线传值（multi 引脚按边序聚合为数组）；
   * - 未连线：IRNode.pinDefaults → PinSpec.defaultValue；
   * - 源为纯节点：递归按需求值（一次求值内记忆化 + 防环）；源为执行节点：读当前帧输出缓存。
   */
  private async resolveInputs(
    frame: Frame,
    node: IRNode,
    pins: readonly InputPinDesc[],
    assembly: Assembly,
  ): Promise<Record<string, unknown>> {
    const inputs: Record<string, unknown> = {};
    for (const pin of pins) {
      if (pin.type === 'exec') continue;
      const edges = (frame.graph.edgesByTarget.get(`${node.id}:${pin.id}`) ?? []).filter(
        (e) => e.kind === 'data',
      );
      if (edges.length === 0) {
        const inline = node.pinDefaults?.[pin.id];
        inputs[pin.id] =
          inline !== undefined
            ? inline
            : pin.multi
              ? Array.isArray(pin.defaultValue)
                ? pin.defaultValue
                : []
              : pin.defaultValue;
      } else if (pin.multi) {
        const values: unknown[] = [];
        for (const edge of edges) values.push(await this.readSource(frame, edge.from, assembly));
        inputs[pin.id] = values;
      } else {
        inputs[pin.id] = await this.readSource(frame, edges[0].from, assembly);
      }
    }
    return inputs;
  }

  /** 读一条数据边的源值：纯节点递归求值；执行节点读最近一次执行的输出缓存（当前帧） */
  private async readSource(frame: Frame, from: IREndpoint, assembly: Assembly): Promise<unknown> {
    const src = frame.graph.nodesById.get(from.node);
    if (!src) throw new Error(`连线指向不存在的节点: ${from.node}`);
    const srcSpec = this.specs.get(src.type);
    if (srcSpec?.pure) {
      const outs = await this.evaluatePure(frame, src, assembly);
      return outs[from.pin];
    }
    if (!srcSpec && !OWNED_TYPES.has(src.type)) {
      throw new Error(`未知节点类型: ${src.type}（节点 ${src.id}）`);
    }
    const cached = frame.cache.get(src.id);
    return cached ? cached[from.pin] : undefined;
  }

  /**
   * 纯节点按需求值：同节点在同一次求值中记忆化；求值中再进入自身 = 数据链成环，抛错。
   * 求值过程同样发 nodeEnter / pinValue / nodeExit 探针（调试观察纯链）。
   */
  private async evaluatePure(
    frame: Frame,
    node: IRNode,
    assembly: Assembly,
  ): Promise<Record<string, unknown>> {
    const memoed = assembly.memo.get(node.id);
    if (memoed) return memoed;
    if (assembly.inProgress.has(node.id)) {
      throw new Error(`纯节点求值存在循环依赖: ${node.type}(${node.id})`);
    }
    assembly.inProgress.add(node.id);
    try {
      const spec = this.specs.get(node.type);
      if (!spec) throw new Error(`未知节点类型: ${node.type}（节点 ${node.id}）`);
      this.debug({ kind: 'nodeEnter', graph: frame.graphName, nodeId: node.id });
      const inputs = await this.resolveInputs(frame, node, spec.inputs, assembly);
      const ctx = this.ctxFor(frame, node, spec);
      const result = await this.invokeRun(spec, ctx, inputs);
      if (isAsyncGenerator(result)) {
        // 纯节点无 exec 出口，契约禁止 generator（ADR-008）；按空输出处理不中断求值
        throw new Error(`纯节点不允许返回多次出脚 generator: ${spec.id}（节点 ${node.id}，ADR-008）`);
      }
      const outputs = result.outputs ?? {};
      assembly.memo.set(node.id, outputs);
      for (const [pinId, value] of Object.entries(outputs)) {
        this.debug({ kind: 'pinValue', graph: frame.graphName, nodeId: node.id, pinId, value });
      }
      this.debug({ kind: 'nodeExit', graph: frame.graphName, nodeId: node.id });
      return outputs;
    } finally {
      assembly.inProgress.delete(node.id);
    }
  }

  /* ---------------- ctx / 运行原语 ---------------- */

  /** 构造 NodeRunContext（契约见 src/ir/types.ts；ADR-005 句柄按运行能力透传，缺失即 undefined） */
  private ctxFor(frame: Frame, node: IRNode, spec: NodeSpec): NodeRunContext {
    const params: Record<string, unknown> = {};
    for (const p of spec.params ?? []) {
      if (p.default !== undefined) params[p.id] = p.default;
    }
    Object.assign(params, node.params ?? {});
    const self = this;
    return {
      nodeId: node.id,
      params,
      // 图内 var 作用域：函数帧入参（IRGraph.params）先于资产变量；其余读写共享资产变量存储
      getVar: (name) =>
        Object.prototype.hasOwnProperty.call(frame.args, name)
          ? frame.args[name]
          : self.vars.get(name),
      setVar: (name, value) => {
        self.vars.set(name, value);
      },
      // 发送事件：入串行队列（处理中调用只排队，不递归）
      emit: (event, p) => {
        self.emit(event, p);
      },
      // 打印旁路：直调回调不入队（事件链 await 期间也能输出）
      print: (...parts) => {
        self.opts.onPrint?.(...parts);
      },
      // 异步延时：内部 Promise 定时器，不占事件队列；stop 时以 AbortError reject
      delay: (ms) => self.delay(ms),
      // ADR-008：重新求值当前节点输入（独立 Assembly → 纯链重执行、变量读最新值）
      reinputs: async () => {
        const fresh: Assembly = { memo: new Map(), inProgress: new Set() };
        return await self.resolveInputs(frame, node, spec.inputs, fresh);
      },
      signal: self.signal,
      ui: self.opts.ui,
      readProjectFile: self.opts.readProjectFile,
      notify: self.opts.notify,
      clipboardWrite: self.opts.clipboardWrite,
      openUrl: self.opts.openUrl,
    };
  }

  /** 异步延时（不阻塞其他事件；stop 时 reject AbortError，由节点容错） */
  private delay(ms: number): Promise<void> {
    const signal = this.signal;
    if (signal.aborted) return Promise.reject(makeAbortError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(timer);
        reject(makeAbortError());
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /* ---------------- 错误与调试 ---------------- */

  /** 统一错误收口：调试探针 nodeError + onError 旁路直调（AbortError = stop 的生命周期产物，一律静默） */
  private reportError(error: Error, graphName: string, nodeId: string): void {
    if (isAbortError(error)) return;
    this.debug({ kind: 'nodeError', graph: graphName, nodeId: nodeId || undefined, message: error.message });
    this.opts.onError?.(error, graphName, nodeId);
  }

  /** 调试探针：逐条同步发出（不排队；批量节流由消费方做，T5.4） */
  private debug(ev: Omit<DebugEvent, 'ts'>): void {
    this.opts.onDebug?.({ ...ev, ts: Date.now() });
  }

  /** 执行节点 run（未定义 run = 结构节点直通；run 未返回按空结果处理；generator 由 runChain 分支驱动） */
  private async invokeRun(
    spec: NodeSpec,
    ctx: NodeRunContext,
    inputs: Record<string, unknown>,
  ): Promise<NodeRunResult | AsyncGenerator<NodeRunResult, void, unknown>> {
    if (!spec.run) return { outputs: {} };
    return (await spec.run(ctx, inputs)) ?? { outputs: {} };
  }
}

/** ADR-008：识别多次出脚节点（async generator 返回值；同步/Promise 结果原样执行） */
function isAsyncGenerator(v: unknown): v is AsyncGenerator<NodeRunResult, void, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/** exec 出口选择（模块级：runChain 与 pickNextFor 共用） */
function pickNext(spec: NodeSpec, node: IRNode, result: NodeRunResult): string | undefined {  const execOuts = spec.outputs.filter((p) => p.type === 'exec');
  const chosen = result.next ?? (execOuts.length === 1 ? execOuts[0].id : undefined);
  if (chosen === undefined) {
    if (execOuts.length === 0) return undefined; // 无 exec 出口：链自然结束
    throw new Error(
      `节点 ${spec.id}(${node.id}) 有 ${execOuts.length} 个 exec 出口但 run 未返回 next`,
    );
  }
  if (!execOuts.some((p) => p.id === chosen)) {
    throw new Error(`节点 ${spec.id}(${node.id}) 返回了未知 exec 出口: ${chosen}`);
  }
  return chosen;
}

/* ============================================================
 * 工厂
 * ============================================================ */

/**
 * 创建 IR 解释器运行实例（T2.5 公共入口）。
 * @param asset 逻辑资产 IR（.bp.json 反序列化结果）
 * @param specs 节点规格表（键 = NodeSpec.id；由调用方注入 builtinSpecMap / 插件合并表，
 *              解释器不硬编码任何具体内置节点）
 * @param opts  调试回调 / print 旁路 / ADR-005 句柄 / 变量初值等，见 RuntimeOptions
 */
export function createRuntime(
  asset: IRAsset,
  specs: Map<string, NodeSpec>,
  opts: RuntimeOptions = {},
): RuntimeHandle {
  return new BlueprintRuntime(asset, specs, opts);
}
