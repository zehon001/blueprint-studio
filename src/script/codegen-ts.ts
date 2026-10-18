/**
 * Blueprint Studio v2 —— Codegen：IR → TS 受控子集（T3.5，PLAN §10 / §9.2）
 *
 * 把 IRAsset 生成为「受控子集」TS 脚本（@tool 类 + @expose 字段 + @on/@onEvent 方法
 * + 函数图方法），蓝图视图可由 src/script/parser-ts.ts 完整还原（roundtrip 幂等）。
 *
 * 核心约定（与 parser-ts.ts 成对实现，共享常量见 ./codegen-common.ts）：
 *  - 变量 → 类字段（全部生成）；@expose 仅当 IRVariable.exposed；category 进注解参数；
 *    int / 自定义别名类型以行内注释「@bps <irType>」兜底（TS 注解无法往返）。
 *  - 事件入口 → @on('start')（event.start）/ @on(事件名)（event.custom，params.eventName）
 *    / @onEvent(事件名)（event.listen，pinDefaults.eventName）。
 *  - 函数图（params/returns 非空或含 func.entry）→ 同名方法；func.entry → 方法本身，
 *    func.return → return 语句；flow.call → await this.<fn>(...)（返回值按需解构）。
 *  - exec 链 → 语句序列：branch → if/else（空分支保留空块；单臂存活时延续收进该臂）；
 *    forLoop/whileLoop/forEach → 真 for/while 语句（循环变量以 let 预声明提升，支持
 *    循环后引用，最后一次迭代值语义与解释器状态机一致）；sequence → __bps-seq 标记 +
 *    按序内联各出口子链；delay → await delay(ms)；event.send → emit(...)；
 *    var.get/set → this.<name> 读写；ui.* → 属性式访问 / ui.write 调用形态。
 *  - 纯节点链 → 内联表达式（EXPR_TABLE）；出度 >1 的纯节点与执行节点透传输出以
 *    const __bps_vN 别名一次性求值（解析端据别名重建单一节点）；表外纯节点 →
 *    bps.<节点id>(...) 兜底调用；无人引用的纯节点 → bps 调用语句保持往返。
 *  - 片段节点（script.snippet）→ __bps-snippet-begin/end 标记对内原样输出源码；
 *    孤儿片段输出在 class 之外（__bps-loose-*）。
 *  - 不可映射兜底：未知节点类型 / 暂无映射的执行节点 → 抛出带图名与节点 id 的中文
 *    CodegenError（调用方自行降级为蓝图视图），绝不静默丢弃。
 *  - 往返注意：节点/连线实例 id 与 position/layout 不进入脚本文本（roundtrip 比较时
 *    做确定性规范化，见 roundtrip.test.ts）；等于 spec 默认值的显式引脚值会在一次
 *    往返后归一化为缺省（语义不变）。
 */
import type {
  IRAsset,
  IREdge,
  IREndpoint,
  IREventDef,
  IRGraph,
  IRNode,
  IRSnippet,
  IRVariable,
  NodeSpec,
} from '../ir/types';
import {
  EVENT_ENTRY_TYPES,
  EVENT_NAME_PIN,
  EVENT_NAME_PARAM,
  EXPR_TABLE_MAP,
  FUNC_ENTRY_TYPES,
  FUNC_RETURN_TYPES,
  SNIPPET_IN_WIRE_PREFIX,
  SNIPPET_NODE_TYPE,
  SNIPPET_OUT_WIRE_PREFIX,
  SNIPPET_PARAM_KEY,
  SNIPPET_WIRING_PREFIX,
  TYPE_EVENT_CUSTOM,
  TYPE_EVENT_LISTEN,
  TYPE_EVENT_START,
  TYPE_FLOW_CALL,
  TYPE_FUNC_RETURN,
  assetClassName,
  bpsCalleeOf,
  callArgPlan,
  escapeTemplateRaw,
  eventMethodName,
  irTypeToTsType,
  isSafeIdentifier,
  literalToExpr,
  looseSnippetBeginLine,
  looseSnippetEndLine,
  metaLine,
  orphanEventsLine,
  paramSpecsJson,
  sequenceMarkerLine,
  snippetBeginLine,
  snippetEndLine,
  specOfType,
  uniqueName,
  withTypeComment,
} from './codegen-common';
import { snippetExecOut, snippetHasExecIn, snippetIsPure, snippetPinIssue } from './snippet';

/** codegen 失败（含图名与节点 id 定位；调用方应降级为蓝图视图并提示，中文消息） */
export class CodegenError extends Error {
  /** 所在图名（资产级失败时省略） */
  readonly graphName?: string;
  /** 所在节点实例 id */
  readonly nodeId?: string;

  constructor(message: string, graphName?: string, nodeId?: string) {
    super(message);
    this.name = 'CodegenError';
    this.graphName = graphName;
    this.nodeId = nodeId;
  }
}

/** 数据输入求值结果：single = 单值表达式；multi = multi 引脚的多个实参表达式 */
type ValueResult = string | string[];

/** 链尾描述：链停止处的延续信息（到达 stopAt / 汇合点 / 自然终止） */
interface ChainEnd {
  /** 链尾类别：dead = 自然终止；backedge = 回连 stopAt（循环体尾）；join = 到达汇合点 */
  kind: 'dead' | 'backedge' | 'join';
  /** 到达的节点 id（backedge / join 时有效） */
  next?: string;
  /** 到达的端点（含目标节点 exec 入引脚 id） */
  nextEndpoint?: IREndpoint;
  /** 链尾节点的 exec 出口端点（延续发射的起点；臂为空时 = 分支出口引脚） */
  from?: { nodeId: string; pin: string };
}

/** 单节点语句发射结果：链继续沿该 exec 出口推进（省略 = 链终止） */
interface NodeEmit {
  out?: { nodeId: string; pin: string };
}

const EMPTY_CHAIN: ChainEnd = { kind: 'dead' };
const EMPTY_NODE_EMIT: NodeEmit = {};

/** inputLiteral 的「非字面量」哨兵（有连线或完全缺省） */
const NONE: unique symbol = Symbol('bps-none');

const pinKey = (nodeId: string, pin: string): string => `${nodeId}\u0000${pin}`;

/** 单个方法体发射上下文 */
interface MethodCtx {
  graphName: string;
  graph: IRGraph;
  nodesById: Map<string, IRNode>;
  /** exec 链遇到这些节点即停止（循环体回连 / 序列续接） */
  stopAt: ReadonlySet<string>;
  /** 块深度（别名作用域检查：更深层块内声明的别名不得被外层引用） */
  depth: number;
  /** `nodeId\u0000pin` → 具名表达式（方法参数 / 循环变量 / 别名 / 解构名） */
  pinRefs: Map<string, string>;
  /** 别名/具名表达式 → 声明时的块深度 */
  aliasDepth: Map<string, number>;
  /** 语句前置声明（别名 const 等，在下一条语句前冲刷） */
  pending: string[];
  /** 别名序号（每方法独立） */
  tmpSeq: number;
  /** 有数据出边的引脚集合（`nodeId\u0000pin`） */
  consumed: Set<string>;
  /** 节点 → 数据出边数（共享判定） */
  outDegree: Map<string, number>;
  /** 汇合点集合：exec 入边数 ≥ 2 的节点（分支臂到达即停，语句在 if 之后续发） */
  joins: Set<string>;
  /** 本方法内已发射的节点（防重复发射） */
  emitted: Set<string>;
  /** 片段出脚变量名避让集（循环变量 / 局部名命名时不得与片段裸名出脚冲突） */
  reserved: Set<string>;
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * IRAsset → TS 受控子集脚本。
 * 失败抛 CodegenError（未知节点 / 暂无映射的执行节点 / 结构异常），调用方自行降级。
 */
export function codegenTS(asset: IRAsset): string {
  return new Codegen(asset).run();
}

class Codegen {
  private readonly asset: IRAsset;
  private readonly lines: string[] = [];
  /** 类内已占用方法名（函数图名优先占位） */
  private readonly methodNames = new Set<string>();
  /** 已被 @on / @onEvent 方法绑定的事件名（孤儿事件判定） */
  private readonly boundEvents = new Set<string>();
  /** 缓冲区切换（if / 循环块体发射） */
  private buffer: string[] | null = null;

  constructor(asset: IRAsset) {
    this.asset = asset ?? ({} as IRAsset);
  }

  /** 当前输出目标（缓冲区或主输出） */
  private get out(): string[] {
    return this.buffer ?? this.lines;
  }

  private push(line: string): void {
    this.out.push(line);
  }

  /** 在独立缓冲区内发射（返回缓冲内容；用于 if / 循环块体） */
  private capture(fn: () => void): string[] {
    const prev = this.buffer;
    const buf: string[] = [];
    this.buffer = buf;
    try {
      fn();
    } finally {
      this.buffer = prev;
    }
    return buf;
  }

  run(): string {
    const asset = this.asset;
    const entryName = typeof asset.entry === 'string' && asset.entry !== '' ? asset.entry : 'main';
    const graphs = (asset.graphs ?? {}) as Record<string, IRGraph>;
    const entryGraph = graphs[entryName];
    if (!entryGraph) {
      throw new CodegenError(
        `主图「${entryName}」不存在，无法生成脚本（asset.entry = ${JSON.stringify(entryName)}）`,
      );
    }

    /* ---------- 图分类：entry（事件图）/ 函数图 / 其他事件图 ---------- */
    const fnGraphs: [string, IRGraph][] = [];
    const extraGraphs: [string, IRGraph][] = [];
    for (const name of Object.keys(graphs).sort()) {
      if (name === entryName) continue;
      const g = graphs[name];
      if (this.isFunctionGraph(g)) fnGraphs.push([name, g]);
      else extraGraphs.push([name, g]);
    }
    if (entryGraph.nodes.some((n) => FUNC_ENTRY_TYPES.includes(n.type) || FUNC_RETURN_TYPES.includes(n.type))) {
      throw new CodegenError(
        `主图「${entryName}」包含函数入口/出口节点（func.entry / func.return）——主图只能是事件图，函数请放入独立函数图`,
        entryName,
      );
    }
    for (const [name, g] of fnGraphs) {
      if (!isSafeIdentifier(name)) {
        throw new CodegenError(`函数图名「${name}」不是合法的 TS 标识符，无法生成脚本方法`, name);
      }
      for (const p of [...(g.params ?? []), ...(g.returns ?? [])]) {
        if (!isSafeIdentifier(p.name)) {
          throw new CodegenError(`函数图「${name}」的参数 / 返回值名「${p.name}」不是合法的 TS 标识符`, name);
        }
      }
    }

    /* ---------- 悬空检查：所有图从入口出发必须可达（事件图入口 = 事件入口节点；函数图入口 = func.entry） ---------- */
    this.assertNoDanglingExec(entryGraph, entryName);
    for (const [name, g] of extraGraphs) this.assertNoDanglingExec(g, name);
    for (const [name, g] of fnGraphs) this.assertNoDanglingExec(g, name);

    /* ---------- 头部 ---------- */
    this.push(metaLine(entryName));
    this.push('// 由 Blueprint Studio 生成（IR → TS 受控子集）：蓝图视图可完整还原本文件；手工改动可能无法映射回蓝图。');
    this.push('');

    /* ---------- 类壳与字段 ---------- */
    const assetName = typeof asset.name === 'string' ? asset.name : '';
    this.push(`@tool(${JSON.stringify(assetName)})`);
    this.push(`class ${assetClassName(assetName)} extends UILogic {`);
    for (const v of (asset.variables ?? []) as IRVariable[]) {
      if (!isSafeIdentifier(v.name)) {
        throw new CodegenError(`变量名「${v.name}」不是合法的 TS 标识符，无法生成为类字段`);
      }
      this.emitField(v);
    }

    /* ---------- 事件表（@on/@onEvent 绑定之外的事件 → 孤儿标记行） ---------- */
    const events = (asset.events ?? []) as IREventDef[];
    for (const g of [entryGraph, ...extraGraphs.map((e) => e[1])]) {
      for (const n of g.nodes) this.collectBoundEvent(n, events);
    }
    const orphans = events.filter((e) => !this.boundEvents.has(e.name));
    if (orphans.length > 0) {
      this.push(orphanEventsLine(orphans));
    }

    /* ---------- 方法：事件入口（entry 图 + 其他事件图） ---------- */
    for (const n of entryGraph.nodes) {
      if (EVENT_ENTRY_TYPES.includes(n.type)) this.emitEventMethod(n, entryGraph, entryName);
    }
    for (const [name, g] of extraGraphs) {
      for (const n of g.nodes) {
        if (EVENT_ENTRY_TYPES.includes(n.type)) this.emitEventMethod(n, g, name);
      }
    }

    /* ---------- 方法：函数图 ---------- */
    for (const [name] of fnGraphs) {
      this.methodNames.add(name);
    }
    for (const [name, g] of fnGraphs) {
      this.emitFunctionMethod(name, g);
    }

    this.push('}');

    /* ---------- 孤儿片段（无节点引用的 snippet，保持往返） ---------- */
    const referenced = new Set<string>();
    for (const g of Object.values(graphs)) {
      for (const n of g.nodes) {
        if (n.type === SNIPPET_NODE_TYPE) {
          const id = n.params?.[SNIPPET_PARAM_KEY];
          if (typeof id === 'string') referenced.add(id);
        }
      }
    }
    for (const snip of asset.snippets ?? []) {
      if (referenced.has(snip.id)) continue;
      this.push('');
      this.push(looseSnippetBeginLine(snip.id, snip.lang, snip.pins));
      if (snip.lang === 'ts') {
        for (const line of snip.code.split('\n')) this.push(line);
      } else {
        // 非 TS 片段无法直接放入 TS 文件：逐行注释包裹（源码仍原样保留在标记对内）
        for (const line of snip.code.split('\n')) this.push(line === '' ? '//' : `// ${line}`);
      }
      this.push(looseSnippetEndLine(snip.id));
    }

    return `${this.lines.join('\n')}\n`;
  }

  /* ============================================================
   * 图级工具
   * ============================================================ */

  /** 是否为函数图（params/returns 非空，或含 func.entry / func.return 节点） */
  private isFunctionGraph(g: IRGraph): boolean {
    return (
      (g.params?.length ?? 0) > 0 ||
      (g.returns?.length ?? 0) > 0 ||
      g.nodes.some((n) => FUNC_ENTRY_TYPES.includes(n.type) || FUNC_RETURN_TYPES.includes(n.type))
    );
  }

  /** 收集事件入口节点绑定的事件名（孤儿事件判定） */
  private collectBoundEvent(node: IRNode, events: IREventDef[]): void {
    if (node.type === TYPE_EVENT_START) {
      this.boundEvents.add('start');
      return;
    }
    if (node.type === TYPE_EVENT_CUSTOM) {
      let evName = node.params?.[EVENT_NAME_PARAM];
      if (typeof evName !== 'string' || evName === '') {
        // 解释器回退约定：title 命中已定义事件名即视为绑定
        if (typeof node.title === 'string' && events.some((e) => e.name === node.title)) evName = node.title;
      }
      if (typeof evName === 'string' && evName !== '') this.boundEvents.add(evName);
      return;
    }
    if (node.type === TYPE_EVENT_LISTEN) {
      const evName = node.pinDefaults?.[EVENT_NAME_PIN];
      if (typeof evName === 'string' && evName !== '') this.boundEvents.add(evName);
    }
  }

  /* ============================================================
   * 字段 / 方法
   * ============================================================ */

  /** 变量 → 类字段（@expose 仅当 exposed；类型注释兜底 int / 自定义别名） */
  private emitField(v: IRVariable): void {
    const typeText = v.exposed ? irTypeToTsType(v.type) : withTypeComment(irTypeToTsType(v.type), v.type);
    if (v.exposed) {
      const anno: string[] = [`type: ${JSON.stringify(v.type)}`];
      if (v.default !== undefined) anno.push(`default: ${literalToExpr(v.default)}`);
      if (typeof v.category === 'string' && v.category !== '') anno.push(`category: ${JSON.stringify(v.category)}`);
      this.push(`  @expose({ ${anno.join(', ')} })`);
    }
    const init = v.default !== undefined ? ` = ${literalToExpr(v.default)}` : '';
    this.push(`  ${v.name}: ${typeText}${init};`);
  }

  /** 方法体内含 await 源（delay / flow.call / system.readFile 等异步执行节点）的判定 */
  private needsAsync(g: IRGraph): boolean {
    return g.nodes.some((n) => n.type === 'flow.delay' || n.type === TYPE_FLOW_CALL || n.type === 'system.readFile');
  }

  /**
   * 事件入口节点 → @on / @onEvent 方法（body 链整体内联）。
   * 事件方法名由事件名派生（不参与往返语义，重名自动加序号）。
   */
  private emitEventMethod(node: IRNode, graph: IRGraph, graphName: string): void {
    const events = (this.asset.events ?? []) as IREventDef[];
    const ctx = this.makeCtx(graphName, graph);
    let anno: string;
    let evName: string;
    const sigParams: { name: string; type: string }[] = [];

    if (node.type === TYPE_EVENT_START) {
      evName = 'start';
      anno = `@on('start')`;
    } else if (node.type === TYPE_EVENT_CUSTOM) {
      evName = typeof node.params?.[EVENT_NAME_PARAM] === 'string' ? (node.params[EVENT_NAME_PARAM] as string) : '';
      if (evName === '' && typeof node.title === 'string' && events.some((e) => e.name === node.title)) {
        evName = node.title;
      }
      if (evName === '') {
        throw new CodegenError(
          `event.custom 节点「${node.id}」未绑定事件名（params.eventName 缺失且 title 未命中事件表），无法生成脚本`,
          graphName,
          node.id,
        );
      }
      anno = `@on(${JSON.stringify(evName)})`;
      const def = events.find((e) => e.name === evName);
      for (const p of def?.params ?? []) sigParams.push({ name: p.name, type: p.type });
      // 位置式占位脚 arg0~arg2：输出被引用时生成为方法参数
      for (let i = 0; i < 3; i += 1) {
        if (ctx.consumed.has(pinKey(node.id, `arg${i}`))) sigParams.push({ name: `arg${i}`, type: 'any' });
      }
    } else {
      // event.listen：eventName 为内联默认值（连线传入无法静态确定 → 抛错）
      evName =
        typeof node.pinDefaults?.[EVENT_NAME_PIN] === 'string'
          ? (node.pinDefaults[EVENT_NAME_PIN] as string)
          : '';
      if (evName === '') {
        throw new CodegenError(
          `event.listen 节点「${node.id}」的 eventName 不是可静态确定的内联字符串（连线传入暂不支持），无法生成脚本`,
          graphName,
          node.id,
        );
      }
      anno = `@onEvent(${JSON.stringify(evName)})`;
      const def = events.find((e) => e.name === evName);
      for (const p of def?.params ?? []) sigParams.push({ name: p.name, type: p.type });
      // args 输出脚被引用时生成为方法参数
      if (ctx.consumed.has(pinKey(node.id, 'args'))) sigParams.push({ name: 'args', type: 'any' });
    }

    for (const p of sigParams) {
      if (!isSafeIdentifier(p.name)) {
        throw new CodegenError(`事件「${evName}」的参数名「${p.name}」不是合法的 TS 标识符`, graphName, node.id);
      }
    }
    const methodName = eventMethodName(evName, this.methodNames);
    this.methodNames.add(methodName);

    // 入口输出脚 → 方法参数（具名表达式）；执行链从入口节点的 exec 出边开始
    for (const p of sigParams) {
      ctx.pinRefs.set(pinKey(node.id, p.name), p.name);
    }
    const chainStart = this.followExec(ctx, node.id, 'exec');
    const bodyLines = this.capture(() => {
      this.emitPureSnippetPrelude(ctx, graph);
      if (chainStart) this.emitChain(ctx, chainStart, undefined, { stopOnJoin: false });
      this.emitDanglingPure(ctx, graph);
      this.flushPending(ctx);
    });

    const eventAsync = this.needsAsync(graph);
    const asyncPrefix = eventAsync ? 'async ' : '';
    const paramsText = sigParams
      .map((p) => `${p.name}: ${withTypeComment(irTypeToTsType(p.type), p.type)}`)
      .join(', ');
    this.push('');
    this.push(`  ${anno}`);
    this.push(`  ${asyncPrefix}${methodName}(${paramsText}): ${eventAsync ? 'Promise<void>' : 'void'} {`);
    for (const line of bodyLines) this.push(`    ${line}`);
    this.push('  }');
  }

  /** 函数图 → 同名方法（func.entry → 方法本身；func.return → return 语句） */
  private emitFunctionMethod(name: string, graph: IRGraph): void {
    const entryNode = graph.nodes.find((n) => FUNC_ENTRY_TYPES.includes(n.type));
    if (!entryNode) {
      throw new CodegenError(`函数图「${name}」缺少 func.entry 入口节点，无法生成脚本方法`, name);
    }
    const params = graph.params ?? [];
    const returns = graph.returns ?? [];
    for (const p of [...params, ...returns]) {
      if (!isSafeIdentifier(p.name)) {
        throw new CodegenError(`函数「${name}」的参数 / 返回值名「${p.name}」不是合法的 TS 标识符`, name);
      }
    }

    const ctx = this.makeCtx(name, graph);
    for (const p of params) ctx.pinRefs.set(pinKey(entryNode.id, p.name), p.name);
    const fnChainStart = this.followExec(ctx, entryNode.id, 'exec');
    const bodyLines = this.capture(() => {
      this.emitPureSnippetPrelude(ctx, graph);
      if (fnChainStart) this.emitChain(ctx, fnChainStart, undefined, { stopOnJoin: false });
      this.emitDanglingPure(ctx, graph);
      this.flushPending(ctx);
    });

    const asyncPrefix = this.needsAsync(graph) ? 'async ' : '';
    const paramsText = params
      .map((p) => `${p.name}: ${withTypeComment(irTypeToTsType(p.type), p.type)}`)
      .join(', ');
    const retTs =
      returns.length === 0
        ? 'void'
        : returns.length === 1
          ? irTypeToTsType(returns[0].type)
          : `{ ${returns.map((r) => `${r.name}: ${irTypeToTsType(r.type)}`).join('; ')} }`;
    const retType = this.needsAsync(graph) ? `Promise<${retTs}>` : retTs;
    this.push('');
    if (returns.length > 0) {
      // 返回值声明以 JSON 注释携带（TS 注解无法往返 int / 自定义别名）
      this.push(`  /** __bps-returns ${paramSpecsJson(returns)} */`);
    }
    this.push(`  ${asyncPrefix}${name}(${paramsText}): ${retType} {`);
    for (const line of bodyLines) this.push(`    ${line}`);
    this.push('  }');
  }

  /* ============================================================
   * 方法体发射（exec 链 → 语句序列）
   * ============================================================ */

  private makeCtx(graphName: string, graph: IRGraph): MethodCtx {
    const nodesById = new Map<string, IRNode>();
    for (const n of graph.nodes) nodesById.set(n.id, n);
    const consumed = new Set<string>();
    const outDegree = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.kind !== 'data') continue;
      consumed.add(pinKey(e.from.node, e.from.pin));
      outDegree.set(e.from.node, (outDegree.get(e.from.node) ?? 0) + 1);
    }
    // 汇合点：exec 入边 ≥ 2 的节点（循环头 / 分支汇合 / 序列续接）
    const execInCount = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.kind !== 'exec') continue;
      execInCount.set(e.to.node, (execInCount.get(e.to.node) ?? 0) + 1);
    }
    const joins = new Set<string>();
    for (const [nodeId, count] of execInCount) {
      if (count >= 2) joins.add(nodeId);
    }
    // 片段出脚以裸名变量承载（var 提升）：循环变量等局部名需避让
    const reserved = new Set<string>();
    for (const n of graph.nodes) {
      if (n.type !== SNIPPET_NODE_TYPE) continue;
      const snipId = n.params?.[SNIPPET_PARAM_KEY];
      const snip =
        typeof snipId === 'string' ? (this.asset.snippets ?? []).find((s) => s.id === snipId) : undefined;
      for (const p of snip?.pins ?? []) {
        if (p && p.dir === 'out' && p.type !== 'exec') reserved.add(p.id);
      }
    }
    return {
      graphName,
      graph,
      nodesById,
      stopAt: new Set<string>(),
      depth: 0,
      pinRefs: new Map<string, string>(),
      aliasDepth: new Map<string, number>(),
      pending: [],
      tmpSeq: 0,
      consumed,
      outDegree,
      joins,
      emitted: new Set<string>(),
      reserved,
    };
  }

  private nodeOf(ctx: MethodCtx, nodeId: string): IRNode {
    const n = ctx.nodesById.get(nodeId);
    if (!n) {
      throw new CodegenError(`连线引用了不存在的节点「${nodeId}」（图 ${ctx.graphName}）`, ctx.graphName, nodeId);
    }
    return n;
  }

  /** 沿 exec 边找下一目标端点（无边 = undefined） */
  private followExec(ctx: MethodCtx, nodeId: string, pin: string): IREndpoint | undefined {
    const edge = ctx.graph.edges.find(
      (e) => e.kind === 'exec' && e.from.node === nodeId && e.from.pin === pin,
    );
    return edge ? { node: edge.to.node, pin: edge.to.pin } : undefined;
  }

  private dataEdgesInto(ctx: MethodCtx, nodeId: string, pin: string): IREdge[] {
    return ctx.graph.edges.filter((e) => e.kind === 'data' && e.to.node === nodeId && e.to.pin === pin);
  }

  /** 冲刷语句前置声明（别名 const 等）到当前输出 */
  private flushPending(ctx: MethodCtx): void {
    if (ctx.pending.length === 0) return;
    for (const line of ctx.pending) this.push(line);
    ctx.pending = [];
  }

  /** 悬空 exec 检查（图级）：从全部入口出发，exec 不可达的执行节点 → 抛错 */
  private assertNoDanglingExec(graph: IRGraph, graphName: string): void {
    const isEntry = (t: string): boolean =>
      EVENT_ENTRY_TYPES.includes(t) || FUNC_ENTRY_TYPES.includes(t);
    const visited = new Set<string>();
    const walk = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      // 沿全量 exec 边走（片段节点 / 图级节点的 exec 出引脚是动态的，不走 spec）
      for (const e of graph.edges) {
        if (e.kind !== 'exec' || e.from.node !== nodeId) continue;
        walk(e.to.node);
      }
    };
    for (const node of graph.nodes) {
      if (isEntry(node.type)) walk(node.id);
    }
    for (const node of graph.nodes) {
      if (visited.has(node.id) || isEntry(node.type)) continue;
      const spec = specOfType(node.type);
      if (spec && spec.inputs.some((p) => p.type === 'exec') && !spec.pure) {
        throw new CodegenError(
          `图「${graphName}」中的节点「${node.id}」（${node.type}）无法从任何入口沿 exec 链到达——请先在蓝图中连接或删除该节点再生成脚本`,
          graphName,
          node.id,
        );
      }
      // 片段节点：exec 入脚由 IRSnippet.pins 动态声明（spec 骨架为空引脚），单独检查
      if (node.type === SNIPPET_NODE_TYPE && !visited.has(node.id)) {
        const snipId = node.params?.[SNIPPET_PARAM_KEY];
        const snip =
          typeof snipId === 'string' ? (this.asset.snippets ?? []).find((s) => s.id === snipId) : undefined;
        if (snip && snippetHasExecIn(snip.pins)) {
          throw new CodegenError(
            `图「${graphName}」中的片段节点「${node.id}」（片段 ${snipId}）声明了 exec 入脚但无法从任何入口沿 exec 链到达——请先在蓝图中连接或删除该节点再生成脚本`,
            graphName,
            node.id,
          );
        }
      }
    }
  }

  /** 发射无人引用的纯节点（bps 调用语句，保持往返不丢节点） */
  private emitDanglingPure(ctx: MethodCtx, graph: IRGraph): void {
    const dangling = graph.nodes.filter((n) => {
      const spec = specOfType(n.type);
      if (!spec || !spec.pure) return false;
      return (ctx.outDegree.get(n.id) ?? 0) === 0;
    });
    if (dangling.length === 0) return;
    ctx.pending.push('// 未被引用的纯节点（保持往返完整，无副作用）：');
    for (const n of dangling) {
      const spec = specOfType(n.type)!;
      ctx.pending.push(`${this.bpsCallExpr(ctx, n, spec)};`);
    }
  }

  /**
   * 沿 exec 链发射语句序列。
   * 到达 stopAt（循环体尾回连）→ backedge；到达汇合点 → join（仅分支臂停：循环头 /
   * 之后的 if 汇合点由外层 walk 正常发射，嵌套结构与合并续发各自承载）。
   * checkStart = true 时对链头也做停止检查（臂 / 循环体调用；合并续发传 false）。
   */
  private emitChain(
    ctx: MethodCtx,
    start: IREndpoint | undefined,
    from?: { nodeId: string; pin: string },
    opts?: { checkStart?: boolean; stopOnJoin?: boolean },
  ): ChainEnd {
    const checkStart = opts?.checkStart ?? true;
    const stopOnJoin = opts?.stopOnJoin ?? true;
    let lastFrom = from;
    let arriving = start;
    let first = true;
    while (arriving) {
      if (checkStart || !first) {
        const stopKind = this.arrivalStops(ctx, arriving.node, stopOnJoin);
        if (stopKind !== null) {
          return {
            kind: stopKind,
            next: arriving.node,
            nextEndpoint: arriving,
            from: lastFrom,
          };
        }
      }
      first = false;
      const node = this.nodeOf(ctx, arriving.node);
      const emitted = this.emitNodeStatement(ctx, node);
      if (!emitted.out) return EMPTY_CHAIN;
      const nextEndpoint = this.followExec(ctx, emitted.out.nodeId, emitted.out.pin);
      if (!nextEndpoint) return EMPTY_CHAIN;
      lastFrom = emitted.out;
      arriving = nextEndpoint;
    }
    return EMPTY_CHAIN;
  }

  /** 到达检查：stopAt（循环回边）优先于汇合点（stopOnJoin 时）；未命中返回 null */
  private arrivalStops(ctx: MethodCtx, nodeId: string, stopOnJoin: boolean): 'backedge' | 'join' | null {
    if (ctx.stopAt.has(nodeId)) return 'backedge';
    if (stopOnJoin && ctx.joins.has(nodeId) && !ctx.emitted.has(nodeId)) return 'join';
    return null;
  }

  /** 单节点 → 语句（大映射开关） */
  private emitNodeStatement(ctx: MethodCtx, node: IRNode): NodeEmit {
    ctx.emitted.add(node.id);
    switch (node.type) {
      case 'flow.branch':
        return this.emitBranch(ctx, node);
      case 'flow.forLoop':
        return this.emitForLoop(ctx, node);
      case 'flow.whileLoop':
        return this.emitWhile(ctx, node);
      case 'array.forEach':
        return this.emitForEach(ctx, node);
      case 'flow.sequence':
        return this.emitSequence(ctx, node);
      case 'flow.delay':
        return this.emitDelay(ctx, node);
      case 'event.send':
        return this.emitSend(ctx, node);
      case 'var.set':
        return this.emitVarSet(ctx, node);
      case 'system.print':
        return this.emitPrint(ctx, node);
      case 'system.readFile':
        return this.emitReadFile(ctx, node);
      case TYPE_FLOW_CALL:
        return this.emitFlowCall(ctx, node);
      case TYPE_FUNC_RETURN:
        return this.emitFuncReturn(ctx, node);
      case SNIPPET_NODE_TYPE:
        return this.emitSnippetNode(ctx, node);
      case 'ui.setValue':
      case 'ui.setText':
      case 'ui.setVisible':
      case 'ui.listSetItems':
      case 'ui.setTitle':
        return this.emitUiWrite(ctx, node);
      case 'ui.setProp':
        return this.emitUiSetProp(ctx, node);
      case 'ui.getProp':
        // 值出口按 ui.read 表达式内联；执行链本身无语句
        return { out: { nodeId: node.id, pin: 'exec' } };
      default:
        break;
    }
    if (EVENT_ENTRY_TYPES.includes(node.type) || FUNC_ENTRY_TYPES.includes(node.type)) {
      throw new CodegenError(
        `入口节点「${node.id}」（${node.type}）出现在执行链中间——事件/函数入口只能作为链头`,
        ctx.graphName,
        node.id,
      );
    }
    if (FUNC_RETURN_TYPES.includes(node.type)) {
      throw new CodegenError(
        `函数出口节点「${node.id}」（func.return）出现在事件图中——函数出口只能在函数图内`,
        ctx.graphName,
        node.id,
      );
    }
    throw new CodegenError(
      `节点类型「${node.type}」暂无脚本映射（图 ${ctx.graphName} 节点 ${node.id}）——已放弃生成，请改用蓝图视图`,
      ctx.graphName,
      node.id,
    );
  }

  /* ---------- 语句发射器 ---------- */

  /**
   * flow.branch → if/else。臂在汇合点 / 循环回边处停止；延续发射规则：
   *  - 两臂到达同一汇合点 → if{真臂}{假臂} 后从汇合点续发（语句在 if 之后）；
   *  - 单臂到达汇合点（另一臂终止/回边）→ 延续收进存活臂的块内（避免「无条件执行」漂移）；
   *  - 两臂均终止 / 回边 → 仅发射 if 块。
   */
  private emitBranch(ctx: MethodCtx, node: IRNode): NodeEmit {
    const cond = this.expectSingle(ctx, node, 'cond', 'flow.branch');
    this.flushPending(ctx);

    // 臂内到达 stopAt（外层循环回边）→ backedge；到达汇合点 → join（arrivalStops 内建判定）
    let tEnd: ChainEnd = EMPTY_CHAIN;
    const tBuf = this.capture(() => {
      ctx.depth += 1;
      tEnd = this.emitChain(ctx, this.followExec(ctx, node.id, 'true'), { nodeId: node.id, pin: 'true' });
      ctx.depth -= 1;
    });
    let fEnd: ChainEnd = EMPTY_CHAIN;
    const fBuf = this.capture(() => {
      ctx.depth += 1;
      fEnd = this.emitChain(ctx, this.followExec(ctx, node.id, 'false'), { nodeId: node.id, pin: 'false' });
      ctx.depth -= 1;
    });

    const tJoin = tEnd.kind === 'join';
    const fJoin = fEnd.kind === 'join';
    if (tJoin && fJoin) {
      if (tEnd.next !== fEnd.next) {
        throw new CodegenError(
          `分支节点「${node.id}」的 true/false 链汇合到不同节点（${tEnd.next} / ${fEnd.next}），无法线性化为脚本`,
          ctx.graphName,
          node.id,
        );
      }
      this.push(`if (${cond}) {`);
      for (const l of tBuf) this.push(`  ${l}`);
      this.push('} else {');
      for (const l of fBuf) this.push(`  ${l}`);
      this.push('}');
      this.emitChain(ctx, tEnd.nextEndpoint, tEnd.from, { checkStart: false, stopOnJoin: false });
      return EMPTY_NODE_EMIT;
    }
    if (tJoin || fJoin) {
      const liveEnd = tJoin ? tEnd : fEnd;
      this.push(`if (${cond}) {`);
      for (const l of tBuf) this.push(`  ${l}`);
      if (tJoin) {
        // true 臂存活：延续收进 true 块内
        const cont = this.capture(() => {
          this.emitChain(ctx, liveEnd.nextEndpoint, liveEnd.from, { checkStart: false, stopOnJoin: false });
        });
        for (const l of cont) this.push(`  ${l}`);
      }
      this.push('} else {');
      for (const l of fBuf) this.push(`  ${l}`);
      if (fJoin) {
        const cont = this.capture(() => {
          this.emitChain(ctx, liveEnd.nextEndpoint, liveEnd.from, { checkStart: false, stopOnJoin: false });
        });
        for (const l of cont) this.push(`  ${l}`);
      }
      this.push('}');
      return EMPTY_NODE_EMIT;
    }
    this.push(`if (${cond}) {`);
    for (const l of tBuf) this.push(`  ${l}`);
    this.push('} else {');
    for (const l of fBuf) this.push(`  ${l}`);
    this.push('}');
    return EMPTY_NODE_EMIT;
  }

  /** flow.forLoop → 真 for 语句（循环变量 let 提升；字面量负步长用 -= 与 >=） */
  private emitForLoop(ctx: MethodCtx, node: IRNode): NodeEmit {
    const from = this.expectSingle(ctx, node, 'from', 'flow.forLoop');
    const to = this.expectSingle(ctx, node, 'to', 'flow.forLoop');
    const step = this.expectSingle(ctx, node, 'step', 'flow.forLoop');
    const stepLit = this.inputLiteral(ctx, node, 'step');
    const negative = typeof stepLit === 'number' && stepLit < 0;
    const cmp = negative ? '>=' : '<=';
    const stepText = negative ? String(Math.abs(stepLit as number)) : step;

    const varName = uniqueName('i', new Set([...ctx.pinRefs.values(), ...ctx.reserved]));
    ctx.pinRefs.set(pinKey(node.id, 'index'), varName);
    ctx.aliasDepth.set(varName, ctx.depth);

    this.flushPending(ctx);
    this.push(`let ${varName} = 0;`);
    this.push(
      `for (${varName} = ${from}; ${varName} ${cmp} ${to}; ${varName} ${cmp === '>=' ? '-=' : '+='} ${stepText}) {`,
    );
    const bodyBuf = this.capture(() => this.emitLoopBody(ctx, node, 'flow.forLoop'));
    for (const l of bodyBuf) this.push(`  ${l}`);
    this.push('}');
    return { out: { nodeId: node.id, pin: 'done' } };
  }

  /** flow.whileLoop → while 语句 */
  private emitWhile(ctx: MethodCtx, node: IRNode): NodeEmit {
    const cond = this.expectSingle(ctx, node, 'cond', 'flow.whileLoop');
    this.flushPending(ctx);
    this.push(`while (${cond}) {`);
    const bodyBuf = this.capture(() => this.emitLoopBody(ctx, node, 'flow.whileLoop'));
    for (const l of bodyBuf) this.push(`  ${l}`);
    this.push('}');
    return { out: { nodeId: node.id, pin: 'done' } };
  }

  /** array.forEach → for..of（entries 形式；index/element 均 let 提升支持循环后引用） */
  private emitForEach(ctx: MethodCtx, node: IRNode): NodeEmit {
    const arr = this.expectSingle(ctx, node, 'array', 'array.forEach');
    const idxName = uniqueName('i', new Set([...ctx.pinRefs.values(), ...ctx.reserved]));
    const elName = uniqueName('el', new Set([...ctx.pinRefs.values(), ...ctx.reserved, idxName]));
    ctx.pinRefs.set(pinKey(node.id, 'index'), idxName);
    ctx.pinRefs.set(pinKey(node.id, 'element'), elName);
    ctx.aliasDepth.set(idxName, ctx.depth);
    ctx.aliasDepth.set(elName, ctx.depth);

    this.flushPending(ctx);
    this.push(`let ${idxName} = 0;`);
    this.push(`let ${elName} = null;`);
    this.push(`for ([${idxName}, ${elName}] of (${arr}).entries()) {`);
    const bodyBuf = this.capture(() => this.emitLoopBody(ctx, node, 'array.forEach'));
    for (const l of bodyBuf) this.push(`  ${l}`);
    this.push('}');
    return { out: { nodeId: node.id, pin: 'done' } };
  }

  /**
   * 循环体：从 body 出口发射，回连到循环节点即止；break 引脚 → 体尾 if-break。
   * 循环体必须回连（for/while 语义恒迭代）——自然终止的循环体无法用真循环表达，抛错。
   */
  private emitLoopBody(ctx: MethodCtx, node: IRNode, nodeType: string): void {
    const prevStop = ctx.stopAt;
    ctx.stopAt = new Set([...prevStop, node.id]);
    ctx.depth += 1;
    const bodyStart = this.followExec(ctx, node.id, 'body');
    const end: ChainEnd = bodyStart
      ? this.emitChain(ctx, bodyStart, { nodeId: node.id, pin: 'body' }, { stopOnJoin: false })
      : EMPTY_CHAIN;
    if (end.kind !== 'backedge') {
      ctx.depth -= 1;
      ctx.stopAt = prevStop;
      throw new CodegenError(
        `${nodeType} 节点「${node.id}」的循环体没有回连到循环节点（for/while 语义要求体尾回边）——请先在蓝图中把循环体链尾连回循环节点`,
        ctx.graphName,
        node.id,
      );
    }
    const breakExpr = this.breakPinExpr(ctx, node);
    if (breakExpr !== null) {
      this.push(`if (${breakExpr}) {`);
      this.push('  break;');
      this.push('}');
    }
    ctx.depth -= 1;
    ctx.stopAt = prevStop;
  }

  /** break 引脚：有连线或显式置真时生成体尾中断；否则省略（保持缺省形态） */
  private breakPinExpr(ctx: MethodCtx, node: IRNode): string | null {
    const edges = this.dataEdgesInto(ctx, node.id, 'break');
    if (edges.length > 0) return this.sourceExpr(ctx, edges[0].from);
    if (node.pinDefaults?.['break'] === true) return 'true';
    return null;
  }

  /** flow.sequence → __bps-seq 标记 + 按序内联各出口子链（节点由解析端按标记重建） */
  private emitSequence(ctx: MethodCtx, node: IRNode): NodeEmit {
    const spec = specOfType('flow.sequence');
    const outPins = (spec?.outputs ?? []).filter((p) => p.type === 'exec').map((p) => p.id);
    for (const pin of outPins) {
      const next = this.followExec(ctx, node.id, pin);
      if (!next) continue;
      this.flushPending(ctx);
      this.push(sequenceMarkerLine(node.id, pin));
      const prevStop = ctx.stopAt;
      ctx.stopAt = new Set([...prevStop, node.id]);
      this.emitChain(ctx, next, undefined, { stopOnJoin: false });
      ctx.stopAt = prevStop;
    }
    return EMPTY_NODE_EMIT;
  }

  /** flow.delay → await delay(ms)（秒 → 毫秒；字面量直接折叠，表达式 ×1000） */
  private emitDelay(ctx: MethodCtx, node: IRNode): NodeEmit {
    const lit = this.inputLiteral(ctx, node, 'seconds');
    if (lit !== NONE && typeof lit === 'number') {
      this.flushPending(ctx);
      this.push(`await delay(${Math.round(lit * 1000)});`);
      return { out: { nodeId: node.id, pin: 'done' } };
    }
    const sec = this.expectSingle(ctx, node, 'seconds', 'flow.delay');
    this.flushPending(ctx);
    this.push(`await delay((${sec}) * 1000);`);
    return { out: { nodeId: node.id, pin: 'done' } };
  }

  /** event.send → emit(name, args?) */
  private emitSend(ctx: MethodCtx, node: IRNode): NodeEmit {
    const name = this.expectSingle(ctx, node, 'eventName', 'event.send');
    const argParts: string[] = [name];
    if (this.dataEdgesInto(ctx, node.id, 'args').length > 0 || (node.pinDefaults && 'args' in node.pinDefaults)) {
      argParts.push(this.expectSingle(ctx, node, 'args', 'event.send'));
    }
    this.flushPending(ctx);
    this.push(`emit(${argParts.join(', ')});`);
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /** var.set → this.<name> = expr；值出口被引用时以别名 const 承载（解析端还原透传边） */
  private emitVarSet(ctx: MethodCtx, node: IRNode): NodeEmit {
    const varName = node.params?.['varName'];
    if (typeof varName !== 'string' || varName === '') {
      throw new CodegenError(`var.set 节点「${node.id}」缺少 varName 参数`, ctx.graphName, node.id);
    }
    if (!isSafeIdentifier(varName)) {
      throw new CodegenError(`变量名「${varName}」不是合法的 TS 标识符（var.set 节点 ${node.id}）`, ctx.graphName, node.id);
    }
    const value = this.expectSingle(ctx, node, 'value', 'var.set');
    this.flushPending(ctx);
    if (ctx.consumed.has(pinKey(node.id, 'value'))) {
      const alias = this.freshAlias(ctx);
      ctx.pinRefs.set(pinKey(node.id, 'value'), alias);
      ctx.aliasDepth.set(alias, ctx.depth);
      this.push(`const ${alias} = (this.${varName} = ${value});`);
    } else {
      this.push(`this.${varName} = ${value};`);
    }
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /** system.print → print(expr)；值出口被引用时以「const 别名 + print(别名)」承载 */
  private emitPrint(ctx: MethodCtx, node: IRNode): NodeEmit {
    const value = this.expectSingle(ctx, node, 'value', 'system.print');
    this.flushPending(ctx);
    if (ctx.consumed.has(pinKey(node.id, 'value'))) {
      const alias = this.freshAlias(ctx);
      ctx.pinRefs.set(pinKey(node.id, 'value'), alias);
      ctx.aliasDepth.set(alias, ctx.depth);
      this.push(`const ${alias} = ${value};`);
      // 尾标记区分「print 透传别名」与「打印共享纯链别名」两种同形文本（解析端据此还原）
      this.push(`print(${alias}); // __bps-print-passthrough`);
    } else {
      this.push(`print(${value});`);
    }
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

/** system.readFile → const <别名> = await readFile(path)；text 出脚被引用时以别名承载 */
  private emitReadFile(ctx: MethodCtx, node: IRNode): NodeEmit {
    const path = this.expectSingle(ctx, node, 'path', 'system.readFile');
    this.flushPending(ctx);
    const alias = this.freshAlias(ctx);
    ctx.pinRefs.set(pinKey(node.id, 'text'), alias);
    ctx.aliasDepth.set(alias, ctx.depth);
    this.push(`const ${alias} = await readFile(${path});`);
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /** flow.call → await this.<fn>(...)（返回值按需解构；入参按目标函数参数序） */
  private emitFlowCall(ctx: MethodCtx, node: IRNode): NodeEmit {
    const graphName = typeof node.params?.['graph'] === 'string' ? (node.params['graph'] as string) : '';
    if (graphName === '') {
      throw new CodegenError(`flow.call 节点「${node.id}」缺少目标函数名（params.graph）`, ctx.graphName, node.id);
    }
    const graphs = (this.asset.graphs ?? {}) as Record<string, IRGraph>;
    const target = graphs[graphName];
    if (!target) {
      throw new CodegenError(`flow.call 节点「${node.id}」的目标函数图「${graphName}」不存在`, ctx.graphName, node.id);
    }
    if (graphName === this.asset.entry || !this.isFunctionGraph(target)) {
      throw new CodegenError(
        `flow.call 节点「${node.id}」的目标「${graphName}」不是函数图（只能调用函数图）`,
        ctx.graphName,
        node.id,
      );
    }
    const targetParams = target.params ?? [];
    const targetReturns = target.returns ?? [];
    for (const e of ctx.graph.edges) {
      if (e.kind === 'data' && e.to.node === node.id && !targetParams.some((p) => p.name === e.to.pin)) {
        throw new CodegenError(
          `flow.call 节点「${node.id}」的入参引脚「${e.to.pin}」不在目标函数「${graphName}」的参数名单中`,
          ctx.graphName,
          node.id,
        );
      }
      if (e.kind === 'data' && e.from.node === node.id && !targetReturns.some((r) => r.name === e.from.pin)) {
        throw new CodegenError(
          `flow.call 节点「${node.id}」的输出引脚「${e.from.pin}」不在目标函数「${graphName}」的返回值名单中`,
          ctx.graphName,
          node.id,
        );
      }
    }
    const args = targetParams.map((p) => this.expectSingle(ctx, node, p.name, 'flow.call'));
    const usedRets = targetReturns.filter((r) => ctx.consumed.has(pinKey(node.id, r.name)));
    this.flushPending(ctx);
    const callText = `await this.${graphName}(${args.join(', ')})`;
    if (usedRets.length > 0) {
      for (const r of usedRets) {
        ctx.pinRefs.set(pinKey(node.id, r.name), r.name);
        ctx.aliasDepth.set(r.name, ctx.depth);
      }
      this.push(`const { ${usedRets.map((r) => r.name).join(', ')} } = ${callText};`);
    } else {
      this.push(`${callText};`);
    }
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /**
   * func.return → return 语句（返回值对象按 IRGraph.returns 名单展开；
   * 未连线的返回值省略属性；无返回值声明的出口为裸 return）。
   */
  private emitFuncReturn(ctx: MethodCtx, node: IRNode): NodeEmit {
    const graph = (this.asset.graphs ?? {})[ctx.graphName];
    const returns = graph?.returns ?? [];
    const props: string[] = [];
    for (const r of returns) {
      if (this.dataEdgesInto(ctx, node.id, r.name).length === 0) continue;
      props.push(`${JSON.stringify(r.name)}: ${this.expectSingle(ctx, node, r.name, 'func.return')}`);
    }
    this.flushPending(ctx);
    this.push(`return { ${props.join(', ')} };`);
    return EMPTY_NODE_EMIT; // 链终止（func.return 无 exec 出口）
  }

  /**
   * 片段节点 → __bps-snippet 标记对内原样输出源码（T3.7 引脚重建，ADR-007 §3）：
   *  - 数据入脚：块前发射 `const __bps_vN = <expr>; // __bps-snippet-in(<pin>)`
   *    （连线源表达式 / pinDefaults 字面量；解析端按尾注释延迟接线）；
   *  - 数据出脚：块内首部 `// __bps-snippet-wiring: let <out>` + `let <out>;`
   *    （片段代码以裸名赋值出脚），被下游引用的出脚在块后发射
   *    `const __bps_vM = <out>; // __bps-snippet-out(<pin>)` 并登记具名引用；
   *  - exec 出口：按片段引脚声明取第一个 exec 出（无 = 链终止）。
   */
  private emitSnippetNode(ctx: MethodCtx, node: IRNode): NodeEmit {
    const snip = this.snippetOfNode(ctx, node);
    this.flushPending(ctx);
    this.emitSnippetInWireLines(ctx, node, snip);
    this.push(snippetBeginLine(snip.id, snip.lang, snip.pins));
    this.emitSnippetOutDecls(snip);
    if (snip.lang === 'ts') {
      for (const line of snip.code.split('\n')) this.push(line);
    } else {
      for (const line of snip.code.split('\n')) this.push(line === '' ? '//' : `// ${line}`);
    }
    this.push(snippetEndLine(snip.id));
    this.emitSnippetOutWireLines(ctx, node, snip);
    // exec 出口：按片段引脚声明（无 exec 出 = 链终止）
    const execOut = snippetExecOut(snip.pins);
    if (!execOut) return EMPTY_NODE_EMIT;
    return { out: { nodeId: node.id, pin: execOut.id } };
  }

  /** 片段节点引用的 IRSnippet（缺失 / 引脚非法即抛 CodegenError） */
  private snippetOfNode(ctx: MethodCtx, node: IRNode): IRSnippet {
    const snipId = node.params?.[SNIPPET_PARAM_KEY];
    if (typeof snipId !== 'string' || snipId === '') {
      throw new CodegenError(
        `片段节点「${node.id}」缺少 ${SNIPPET_PARAM_KEY} 参数（双击节点填写源码与引脚）`,
        ctx.graphName,
        node.id,
      );
    }
    const snip = (this.asset.snippets ?? []).find((s) => s.id === snipId);
    if (!snip) {
      throw new CodegenError(
        `片段节点「${node.id}」引用的片段「${snipId}」不在资产 snippets 中`,
        ctx.graphName,
        node.id,
      );
    }
    for (const pin of snip.pins ?? []) {
      if (pin.type === 'exec') continue;
      const issue = snippetPinIssue(pin);
      if (issue) {
        throw new CodegenError(`片段「${snipId}」：${issue}（节点 ${node.id}）`, ctx.graphName, node.id);
      }
    }
    if (!snippetHasExecIn(snip.pins) && snippetExecOut(snip.pins)) {
      throw new CodegenError(
        `片段「${snipId}」只声明了 exec 出脚（无 exec 入）——无法进入执行链，请补 exec 入脚或移除 exec 出脚（节点 ${node.id}）`,
        ctx.graphName,
        node.id,
      );
    }
    return snip;
  }

  /** 片段数据入脚的别名行（连线表达式 / pinDefaults 字面量；块前发射，解析端延迟接线）。
   * 求值可能产生新的共享别名声明（ensureAlias → pending），先全部求值再统一冲刷，
   * 保证「别名声明 → 入脚别名行」的文本顺序（纯片段前奏不得前向引用）。 */
  private emitSnippetInWireLines(ctx: MethodCtx, node: IRNode, snip: IRSnippet): void {
    const lines: string[] = [];
    for (const pin of snip.pins ?? []) {
      if (pin.dir !== 'in' || pin.type === 'exec') continue;
      const edges = this.dataEdgesInto(ctx, node.id, pin.id);
      if (edges.length === 0 && !(node.pinDefaults && pin.id in node.pinDefaults)) continue;
      let expr: string;
      if (edges.length > 0) {
        // 纯片段的入脚只能由可内联表达式源供给（ADR-007 §3）：执行节点输出此刻尚无具名承载
        const src = this.nodeOf(ctx, edges[0].from.node);
        const srcSpec = specOfType(src.type);
        const srcIsExec =
          !!srcSpec &&
          !srcSpec.pure &&
          (srcSpec.inputs.some((p) => p.type === 'exec') || src.type === SNIPPET_NODE_TYPE);
        if (srcIsExec && !ctx.pinRefs.has(pinKey(src.id, edges[0].from.pin))) {
          throw new CodegenError(
            `片段节点「${node.id}」的入脚「${pin.id}」来自执行节点输出——纯片段无法在脚本视图中线性承载该连线，请改用声明 exec 入/出的片段或在片段内经 vars 读取变量`,
            ctx.graphName,
            node.id,
          );
        }
        expr = this.sourceExpr(ctx, edges[0].from);
      } else {
        expr = literalToExpr(node.pinDefaults?.[pin.id]);
      }
      const alias = this.freshAlias(ctx);
      lines.push(`const ${alias} = ${expr}; // ${SNIPPET_IN_WIRE_PREFIX}(${pin.id})`);
    }
    this.flushPending(ctx);
    for (const line of lines) this.push(line);
  }

  /** 片段数据出脚的声明行（块内首部；解析端按 SNIPPET_WIRING_PREFIX 剔除）。
   * 用 var 而非 let：多个片段节点（同方法作用域）声明同名出脚时 var 重声明合法，
   * 保证生成码可转译；片段代码以裸名赋值出脚，var 函数域提升与该形态兼容（ADR-007 §3）。 */
  private emitSnippetOutDecls(snip: IRSnippet): void {
    for (const pin of snip.pins ?? []) {
      if (pin.dir !== 'out' || pin.type === 'exec') continue;
      // 声明行成对携带前缀注释（行首或行尾均可被解析端按前缀剔除，见 prescanBody 过滤）
      this.push(`${SNIPPET_WIRING_PREFIX}: let ${pin.id}`);
      this.push(`var ${pin.id}; // ${SNIPPET_WIRING_PREFIX}`);
    }
  }

  /** 片段数据出脚的出口别名行（块后发射；仅被下游引用的出脚） */
  private emitSnippetOutWireLines(ctx: MethodCtx, node: IRNode, snip: IRSnippet): void {
    for (const pin of snip.pins ?? []) {
      if (pin.dir !== 'out' || pin.type === 'exec') continue;
      if (!ctx.consumed.has(pinKey(node.id, pin.id))) continue;
      const alias = this.freshAlias(ctx);
      this.push(`const ${alias} = ${pin.id}; // ${SNIPPET_OUT_WIRE_PREFIX}(${pin.id})`);
      ctx.pinRefs.set(pinKey(node.id, pin.id), alias);
      ctx.aliasDepth.set(alias, ctx.depth);
    }
  }

  /**
   * 纯片段（完全无 exec 引脚）的方法体前奏（ADR-007 §3）：
   * 纯片段块提升到方法体顶部发射（脚本顺序执行语义：先求片段、后消费出值）；
   * 纯片段之间的入脚依赖按数据边拓扑排序（环回退为声明序，解析端可正常重建）。
   */
  private emitPureSnippetPrelude(ctx: MethodCtx, graph: IRGraph): void {
    const pureNodes = graph.nodes.filter((n) => {
      if (n.type !== SNIPPET_NODE_TYPE) return false;
      const snipId = n.params?.[SNIPPET_PARAM_KEY];
      const snip =
        typeof snipId === 'string' ? (this.asset.snippets ?? []).find((s) => s.id === snipId) : undefined;
      return !!snip && snippetIsPure(snip.pins);
    });
    if (pureNodes.length === 0) return;
    for (const node of this.topoPureSnippets(ctx, graph, pureNodes)) {
      const snip = this.snippetOfNode(ctx, node);
      this.flushPending(ctx);
      this.emitSnippetInWireLines(ctx, node, snip);
      this.push(snippetBeginLine(snip.id, snip.lang, snip.pins));
      this.emitSnippetOutDecls(snip);
      if (snip.lang === 'ts') {
        for (const line of snip.code.split('\n')) this.push(line);
      } else {
        for (const line of snip.code.split('\n')) this.push(line === '' ? '//' : `// ${line}`);
      }
      this.push(snippetEndLine(snip.id));
      this.emitSnippetOutWireLines(ctx, node, snip);
    }
  }

  /** 纯片段拓扑序（入脚来自其他纯片段的先发射；存在环 / 外部依赖时回落声明序） */
  private topoPureSnippets(_ctx: MethodCtx, graph: IRGraph, pureNodes: IRNode[]): IRNode[] {
    void _ctx;
    const ids = new Set(pureNodes.map((n) => n.id));
    // 依赖：to 的入脚来自集合内其他纯片段 → from 先于 to
    const deps = new Map<string, Set<string>>();
    for (const n of pureNodes) deps.set(n.id, new Set());
    for (const e of graph.edges) {
      if (e.kind !== 'data') continue;
      if (ids.has(e.from.node) && ids.has(e.to.node) && e.from.node !== e.to.node) {
        deps.get(e.to.node)!.add(e.from.node);
      }
    }
    const done = new Set<string>();
    const out: IRNode[] = [];
    const byId = new Map(pureNodes.map((n) => [n.id, n]));
    let progressed = true;
    while (out.length < pureNodes.length && progressed) {
      progressed = false;
      for (const n of pureNodes) {
        if (done.has(n.id)) continue;
        if (![...deps.get(n.id)!].some((d) => !done.has(d))) {
          done.add(n.id);
          out.push(byId.get(n.id)!);
          progressed = true;
        }
      }
    }
    // 回路兜底：剩余节点按声明序补齐
    for (const n of pureNodes) {
      if (!done.has(n.id)) out.push(n);
    }
    return out;
  }

  /** ui 写值节点 → 属性式 ui.<n>.<attr> = v（名字/属性可静态化时）或 ui.write 调用形态 */
  private emitUiWrite(ctx: MethodCtx, node: IRNode): NodeEmit {
    const valuePin = node.type === 'ui.listSetItems' ? 'items' : node.type === 'ui.setVisible' ? 'visible' : 'value';
    const value = this.expectSingle(ctx, node, valuePin, node.type);
    let attrText: string | null = null; // null = 属性动态，需要调用形态
    if (node.type === 'ui.setVisible') attrText = 'visible';
    else if (node.type === 'ui.listSetItems') attrText = 'items';
    else if (node.type === 'ui.setText') attrText = 'text';
    else {
      const attrLit = this.inputLiteral(ctx, node, 'attr');
      if (attrLit !== NONE && typeof attrLit === 'string') attrText = attrLit;
    }
    const nameLit = this.inputLiteral(ctx, node, 'name');
    this.flushPending(ctx);
    if (attrText !== null && nameLit !== NONE && typeof nameLit === 'string' && isSafeIdentifier(nameLit)) {
      this.push(`ui.${nameLit}.${attrText} = ${value};`);
    } else {
      const attrExpr =
        node.type === 'ui.setVisible' || node.type === 'ui.listSetItems' || node.type === 'ui.setText'
          ? JSON.stringify(attrText ?? '')
          : this.expectSingle(ctx, node, 'attr', node.type);
      this.push(`ui.write(${this.expectSingle(ctx, node, 'name', node.type)}, ${attrExpr}, ${value});`);
    }
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /** v3 反射写值：ui.setProp(nodeName, propId, value) → ui.write(名, 属性id, 值) */
  private emitUiSetProp(ctx: MethodCtx, node: IRNode): NodeEmit {
    const nodeName = typeof node.params?.nodeName === 'string' ? node.params.nodeName : '';
    const propId = typeof node.params?.propId === 'string' ? node.params.propId : '';
    if (!nodeName || !propId) {
      throw new CodegenError(
        `反射节点「${node.id}」（ui.setProp）缺少 nodeName/propId 参数`,
        ctx.graphName,
        node.id,
      );
    }
    const value = this.expectSingle(ctx, node, 'value', node.type);
    this.flushPending(ctx);
    this.push(`ui.write(${JSON.stringify(nodeName)}, ${JSON.stringify(propId)}, ${value});`);
    return { out: { nodeId: node.id, pin: 'exec' } };
  }

  /* ============================================================
   * 数据求值（引脚 → 表达式）
   * ============================================================ */

  /** 单值引脚求值（multi 引脚误用时抛错） */
  private expectSingle(ctx: MethodCtx, node: IRNode, pin: string, nodeType: string): string {
    const v = this.valueForInput(ctx, node, pin);
    if (Array.isArray(v)) {
      throw new CodegenError(`节点「${node.id}」（${nodeType}）的引脚「${pin}」不支持多连线`, ctx.graphName, node.id);
    }
    return v;
  }

  /** 引脚求值：连线 > pinDefaults > PinSpec.defaultValue > undefined；multi 引脚返回实参数组 */
  private valueForInput(ctx: MethodCtx, node: IRNode, pin: string): ValueResult {
    const edges = this.dataEdgesInto(ctx, node.id, pin);
    if (edges.length === 0) {
      if (node.pinDefaults && pin in node.pinDefaults) {
        const inline = node.pinDefaults[pin];
        // multi 引脚的数组内联默认值展开为逐个实参（如 format(tpl, 'a', 'b')）
        if (specOfType(node.type)?.inputs.find((p) => p.id === pin)?.multi && Array.isArray(inline)) {
          return (inline as unknown[]).map((el) => literalToExpr(el));
        }
        return literalToExpr(inline);
      }
      const dv = specOfType(node.type)?.inputs.find((p) => p.id === pin)?.defaultValue;
      return dv === undefined ? 'undefined' : literalToExpr(dv);
    }
    const pinDesc = specOfType(node.type)?.inputs.find((p) => p.id === pin);
    if (pinDesc?.multi) {
      return edges.map((e) => this.sourceExpr(ctx, e.from));
    }
    return this.sourceExpr(ctx, edges[0].from);
  }

  /** 引脚的「字面量有效值」：无连线时 = pinDefaults ?? PinSpec.defaultValue（NONE = 非字面量） */
  private inputLiteral(ctx: MethodCtx, node: IRNode, pin: string): unknown | typeof NONE {
    if (this.dataEdgesInto(ctx, node.id, pin).length > 0) return NONE;
    if (node.pinDefaults && pin in node.pinDefaults) return node.pinDefaults[pin];
    const dv = specOfType(node.type)?.inputs.find((p) => p.id === pin)?.defaultValue;
    return dv === undefined ? NONE : dv;
  }

  /** 数据边源值表达式：已具名引用（入口/执行节点输出）优先 → 纯/数据型节点表达式 → 抛错 */
  private sourceExpr(ctx: MethodCtx, from: IREndpoint): string {
    const src = this.nodeOf(ctx, from.node);
    const named = ctx.pinRefs.get(pinKey(from.node, from.pin));
    if (named !== undefined) {
      this.assertAliasVisible(ctx, named);
      return named;
    }
    // 片段节点：出脚值必须经出口别名行承载（emitSnippetOutWireLines 登记的具名引用）
    if (src.type === SNIPPET_NODE_TYPE) {
      throw new CodegenError(
        `数据连线引用了片段节点「${src.id}」的输出「${from.pin}」，但该出脚未被下游引用登记——请检查片段出脚声明与连线`,
        ctx.graphName,
        src.id,
      );
    }
    // v3 反射读值：ui.getProp 虽有 exec 入/出，但 value 出口可按表达式内联
    if (src.type === 'ui.getProp') return this.uiGetPropExpr(ctx, src);
    const spec = specOfType(src.type);
    const isDataOnly = !!spec && !spec.pure && !spec.inputs.some((p) => p.type === 'exec');
    if ((spec?.pure ?? false) || isDataOnly) {
      if (src.type === 'ui.get') return this.uiGetExpr(ctx, src);
      return this.pureExpr(ctx, src, from.pin);
    }
    throw new CodegenError(
      `数据连线引用了未具名的节点输出（${src.type}#${src.id}.${from.pin}）——执行节点输出需经别名/参数承载`,
      ctx.graphName,
      src.id,
    );
  }

  /** 别名作用域检查：更深层块内声明的别名不得被外层引用 */
  private assertAliasVisible(ctx: MethodCtx, name: string): void {
    const declared = ctx.aliasDepth.get(name);
    if (declared !== undefined && declared > ctx.depth) {
      throw new CodegenError(
        `具名表达式「${name}」声明于更深的控制流块内，不能在外层引用（请检查蓝图连线结构）`,
        ctx.graphName,
      );
    }
  }

  /** 纯节点求值表达式（出度 >1 时走别名，保证解析端重建单一节点） */
  private pureExpr(ctx: MethodCtx, node: IRNode, pin: string): string {
    if ((ctx.outDegree.get(node.id) ?? 0) > 1) {
      return this.ensureAlias(ctx, node, pin);
    }
    return this.pureSingleExpr(ctx, node, pin);
  }

  /** 纯节点单次求值表达式（不含别名分支，供别名声明复用） */
  private pureSingleExpr(ctx: MethodCtx, node: IRNode, pin: string): string {
    if (node.type === 'var.get') return this.varGetExpr(ctx, node);
    if (node.type === 'ui.getValue') return this.uiGetValueExpr(ctx, node);
    if (node.type === 'map.set') {
      const flat = this.tryFlattenMapSet(ctx, node);
      if (flat !== null) return flat;
    }
    const entry = EXPR_TABLE_MAP.get(node.type);
    const spec = specOfType(node.type);
    if (entry && (!entry.guard || entry.guard(node, (p) => this.dataEdgesInto(ctx, node.id, p).length > 0))) {
      return this.buildTableExpr(ctx, node, spec, entry, pin);
    }
    return this.bpsCallExpr(ctx, node, spec, pin);
  }

  /**
   * map.set 链 → 对象字面量（可读性优先）：
   * 链尾向基座回溯（基座为显式 {} 字面量或单消费者的 map.set），键全为字符串字面量，
   * 且至少一个值来自连线（全字面量链不扁平化——字面量对象会被解析端还原为 pinDefault，
   * 丢失节点）。失败返回 null（退回 bps.map.set 嵌套形态）。
   */
  private tryFlattenMapSet(ctx: MethodCtx, node: IRNode): string | null {
    const props: { key: string; valueThunk: () => string; hasNodeRef: boolean }[] = [];
    let cur = node;
    for (;;) {
      const keyLit = this.inputLiteral(ctx, cur, 'key');
      if (typeof keyLit !== 'string') return null;
      const valueEdges = this.dataEdgesInto(ctx, cur.id, 'value');
      if (valueEdges.length > 1) return null;
      const curNode = cur; // 闭包按次捕获，避免循环变量共享
      props.unshift({
        key: keyLit,
        valueThunk: () => this.expectSingle(ctx, curNode, 'value', 'map.set'),
        hasNodeRef: valueEdges.length === 1,
      });
      const baseEdges = this.dataEdgesInto(ctx, cur.id, 'map');
      if (baseEdges.length === 1) {
        const src = this.nodeOf(ctx, baseEdges[0].from.node);
        if (src.type !== 'map.set' || (ctx.outDegree.get(src.id) ?? 0) > 1) return null;
        cur = src;
        continue;
      }
      if (baseEdges.length === 0) {
        // 基座必须是显式 {} 字面量（缺省 null 走 bps 形态，保证解析端不引入 pinDefaults.map = {}）
        const baseLit = this.inputLiteral(ctx, cur, 'map');
        if (baseLit === NONE) return null;
        if (baseLit !== null && typeof baseLit === 'object' && !Array.isArray(baseLit) && Object.keys(baseLit).length === 0) break;
        return null;
      }
      return null; // multi
    }
    if (!props.some((p) => p.hasNodeRef)) return null;
    const parts = props.map((p) => `${JSON.stringify(p.key)}: ${p.valueThunk()}`);
    return `{ ${parts.join(', ')} }`;
  }

  /** var.get → this.<name>（不安全标识符走下标形态，解析端同样支持） */
  private varGetExpr(_ctx: MethodCtx, node: IRNode): string {
    const varName = node.params?.['varName'];
    if (typeof varName !== 'string' || varName === '') {
      throw new CodegenError(`var.get 节点「${node.id}」缺少 varName 参数`, _ctx.graphName, node.id);
    }
    return isSafeIdentifier(varName) ? `this.${varName}` : `this[${JSON.stringify(varName)}]`;
  }

  /** ui.get → 属性式 ui.<name>（字面量名）或 ui.find(expr)（连线名） */
  private uiGetExpr(ctx: MethodCtx, node: IRNode): string {
    const nameLit = this.inputLiteral(ctx, node, 'name');
    if (nameLit !== NONE && typeof nameLit === 'string') {
      return isSafeIdentifier(nameLit) ? `ui.${nameLit}` : `ui[${JSON.stringify(nameLit)}]`;
    }
    return `ui.find(${this.expectSingle(ctx, node, 'name', 'ui.get')})`;
  }

  /** v3 反射读值：ui.getProp → ui.read(nodeName, propId) */
  private uiGetPropExpr(ctx: MethodCtx, node: IRNode): string {
    const nodeName = typeof node.params?.nodeName === 'string' ? node.params.nodeName : '';
    const propId = typeof node.params?.propId === 'string' ? node.params.propId : '';
    if (!nodeName || !propId) {
      throw new CodegenError(
        `反射节点「${node.id}」（ui.getProp）缺少 nodeName/propId 参数`,
        ctx.graphName,
        node.id,
      );
    }
    return `ui.read(${JSON.stringify(nodeName)}, ${JSON.stringify(propId)})`;
  }

  /** ui.getValue → 属性式 ui.<name>.<attr>（名字/属性均可静态化）或 ui.read(n, attr) 调用形态 */
  private uiGetValueExpr(ctx: MethodCtx, node: IRNode): string {
    const nameLit = this.inputLiteral(ctx, node, 'name');
    const attrLit = this.inputLiteral(ctx, node, 'attr');
    if (nameLit !== NONE && typeof nameLit === 'string' && attrLit !== NONE && typeof attrLit === 'string') {
      const base = isSafeIdentifier(nameLit) ? `ui.${nameLit}` : `ui[${JSON.stringify(nameLit)}]`;
      return isSafeIdentifier(attrLit) ? `${base}.${attrLit}` : `${base}[${JSON.stringify(attrLit)}]`;
    }
    return `ui.read(${this.expectSingle(ctx, node, 'name', 'ui.getValue')}, ${this.expectSingle(ctx, node, 'attr', 'ui.getValue')})`;
  }

  /** 为（节点，引脚）生成一次性求值别名（出度 >1 的共享纯链 / 执行节点透传输出） */
  private ensureAlias(ctx: MethodCtx, node: IRNode, pin: string): string {
    const key = pinKey(node.id, pin);
    const existing = ctx.pinRefs.get(key);
    if (existing !== undefined) {
      this.assertAliasVisible(ctx, existing);
      return existing;
    }
    // androidLogParse 的 count 引脚复用 rows 别名（.length 形态）——
    // 避免两份调用表达式让解析端重建出第二个节点
    if (node.type === 'convert.androidLogParse' && pin === 'count') {
      const rowsAlias = this.ensureAlias(ctx, node, 'rows');
      const name = this.freshAlias(ctx);
      ctx.pending.push(`const ${name} = (${rowsAlias}).length;`);
      ctx.pinRefs.set(key, name);
      ctx.aliasDepth.set(name, ctx.depth);
      return name;
    }
    const name = this.freshAlias(ctx);
    const expr = this.pureSingleExpr(ctx, node, pin);
    ctx.pending.push(`const ${name} = ${expr};`);
    ctx.pinRefs.set(key, name);
    ctx.aliasDepth.set(name, ctx.depth);
    return name;
  }

  private freshAlias(ctx: MethodCtx): string {
    ctx.tmpSeq += 1;
    return `__bps_v${ctx.tmpSeq}`;
  }

  /* ---------- 表达式表合成 ---------- */

  /** 按表达式表条目合成表达式（实参 = 数据引脚 + 检视器参数，按声明序） */
  private buildTableExpr(
    ctx: MethodCtx,
    node: IRNode,
    spec: NodeSpec | undefined,
    entry: NonNullable<ReturnType<typeof EXPR_TABLE_MAP.get>>,
    pin: string,
  ): string {
    const plan = callArgPlan(spec ?? ({ inputs: [], params: [] } as unknown as NodeSpec));
    const form = entry.form;
    switch (form.kind) {
      case 'binary':
        return `(${this.planArg(ctx, node, plan, 0)} ${form.op} ${this.planArg(ctx, node, plan, 1)})`;
      case 'binary-compare': {
        const op = typeof node.params?.['op'] === 'string' && node.params['op'] !== ''
          ? (node.params['op'] as string)
          : '>';
        return `(${this.planArg(ctx, node, plan, 0)} ${op} ${this.planArg(ctx, node, plan, 1)})`;
      }
      case 'prefix':
        return `(${form.op}${this.planArg(ctx, node, plan, 0)})`;
      case 'global-call': {
        const parts = this.spreadArgs(ctx, node, plan, 0);
        return `${form.callee}(${parts.join(', ')})`;
      }
      case 'member-call': {
        const receiver = this.planArg(ctx, node, plan, 0);
        const parts = this.spreadArgs(ctx, node, plan, 1);
        return `(${receiver}).${form.method}(${parts.join(', ')})`;
      }
      case 'member':
        return `(${this.planArg(ctx, node, plan, 0)}).${form.prop}`;
      case 'element':
        return `(${this.planArg(ctx, node, plan, 0)}[${this.planArg(ctx, node, plan, 1)}])`;
      case 'array-literal': {
        const parts: string[] = [];
        for (let i = 0; i < plan.length; i += 1) {
          const v = this.planValue(ctx, node, plan, i);
          parts.push(v === null ? 'undefined' : Array.isArray(v) ? `[${v.join(', ')}]` : v);
        }
        while (parts.length > 0 && parts[parts.length - 1] === 'undefined') parts.pop();
        return `[${parts.join(', ')}]`;
      }
      case 'template': {
        // string.concat：左脊柱展平（a 输入若来自单一消费者的 concat 则递归并入）
        const parts = this.concatParts(ctx, node);
        if (!parts.some((p) => p.expr !== undefined)) {
          // 纯字面量拼接退回 bps 形态（无插值的模板在解析端无法重建节点）
          return this.bpsCallExpr(ctx, node, spec, pin);
        }
        let text = '`';
        for (const p of parts) {
          text += p.raw !== undefined ? escapeTemplateRaw(p.raw) : `\${${p.expr}}`;
        }
        return `${text}\``;
      }
      case 'count-suffix': {
        // convert.androidLogParse：rows = 调用表达式；count = 调用表达式.length
        const args = this.spreadArgs(ctx, node, plan, 0);
        const call = `convert.androidLogParse(${args.join(', ')})`;
        return pin === 'count' ? `(${call}).length` : call;
      }
      default:
        return this.bpsCallExpr(ctx, node, spec, pin);
    }
  }

  /** 从 plan 的 start 位起收集实参（multi 引脚展开；缺省尾参省略） */
  private spreadArgs(ctx: MethodCtx, node: IRNode, plan: ReturnType<typeof callArgPlan>, start: number): string[] {
    const parts: string[] = [];
    for (let i = start; i < plan.length; i += 1) {
      const v = this.planValue(ctx, node, plan, i);
      if (v === null) continue;
      if (Array.isArray(v)) parts.push(...v);
      else parts.push(v);
    }
    return parts;
  }

  /** 模板拼接的部件序列（raw = 字面量文本；expr = 子表达式；左脊柱展平） */
  private concatParts(ctx: MethodCtx, node: IRNode): { raw?: string; expr?: string }[] {
    const side = (pin: 'a' | 'b', flatten: boolean): { raw?: string; expr?: string }[] => {
      const edges = this.dataEdgesInto(ctx, node.id, pin);
      if (edges.length === 0) {
        const lit = this.inputLiteral(ctx, node, pin);
        const s = lit === NONE || lit === undefined ? '' : String(lit);
        return s === '' ? [] : [{ raw: s }];
      }
      const from = edges[0].from;
      const src = this.nodeOf(ctx, from.node);
      if (flatten && src.type === 'string.concat' && (ctx.outDegree.get(src.id) ?? 0) <= 1) {
        return this.concatParts(ctx, src);
      }
      return [{ expr: this.sourceExpr(ctx, from) }];
    };
    return [...side('a', true), ...side('b', false)];
  }

  /** 规划项实参文本（缺省项抛错——二元 / 成员形态要求实参齐全） */
  private planArg(ctx: MethodCtx, node: IRNode, plan: ReturnType<typeof callArgPlan>, index: number): string {
    const v = this.planValue(ctx, node, plan, index);
    if (v === null) {
      throw new CodegenError(
        `节点「${node.id}」的第 ${index + 1} 个实参（${plan[index]?.id ?? index}）缺省，无法合成表达式`,
        ctx.graphName,
        node.id,
      );
    }
    return Array.isArray(v) ? `[${v.join(', ')}]` : v;
  }

  /**
   * 规划项实参值：有连线 / 设置 → 表达式或字面量；完全缺省 → null（调用形态省略尾参）。
   */
  private planValue(
    ctx: MethodCtx,
    node: IRNode,
    plan: ReturnType<typeof callArgPlan>,
    index: number,
  ): ValueResult | null {
    const item = plan[index];
    if (!item) return null;
    if (item.kind === 'pin') {
      const edges = this.dataEdgesInto(ctx, node.id, item.id);
      if (edges.length > 0) {
        if (item.multi) return edges.map((e) => this.sourceExpr(ctx, e.from));
        return this.sourceExpr(ctx, edges[0].from);
      }
      if (node.pinDefaults && item.id in node.pinDefaults) {
        const inline = node.pinDefaults[item.id];
        if (item.multi && Array.isArray(inline)) {
          return (inline as unknown[]).map((el) => literalToExpr(el));
        }
        return literalToExpr(inline);
      }
      const dv = specOfType(node.type)?.inputs.find((p) => p.id === item.id)?.defaultValue;
      return dv === undefined ? null : literalToExpr(dv);
    }
    // 检视器参数
    if (node.params && item.id in node.params) return literalToExpr(node.params[item.id]);
    const dp = specOfType(node.type)?.params?.find((p) => p.id === item.id)?.default;
    return dp === undefined ? null : literalToExpr(dp);
  }

  /** bps.* 万能兜底：bps.<节点id>(数据引脚实参…, 检视器参数…)（中段缺省补 spec 默认值） */
  private bpsCallExpr(ctx: MethodCtx, node: IRNode, spec: NodeSpec | undefined, _pin?: string): string {
    void _pin;
    const plan = callArgPlan(spec ?? ({ inputs: [], params: [] } as unknown as NodeSpec));
    const values = plan.map((_item, i) => this.planValue(ctx, node, plan, i));
    let lastUsed = -1;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] !== null) lastUsed = i;
    }
    const parts: string[] = [];
    for (let i = 0; i <= lastUsed; i += 1) {
      const v = values[i];
      if (v === null) {
        // 中段缺省：补 spec 默认值字面量（解析端按 spec 默认值剥离，往返等价）
        const item = plan[i];
        const fallback =
          item.kind === 'pin'
            ? specOfType(node.type)?.inputs.find((p) => p.id === item.id)?.defaultValue
            : specOfType(node.type)?.params?.find((p) => p.id === item.id)?.default;
        parts.push(fallback === undefined ? 'undefined' : literalToExpr(fallback));
        continue;
      }
      if (Array.isArray(v)) parts.push(`[${v.join(', ')}]`);
      else parts.push(v);
    }
    return `${bpsCalleeOf(node.type)}(${parts.join(', ')})`;
  }
}
