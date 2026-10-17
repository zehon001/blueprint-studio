/**
 * Blueprint Studio v2 —— 受控子集解析器：TS → IR（T3.6，PLAN §10 / §9.2）
 *
 * 把 codegen-ts.ts 生成的「受控子集」TS 脚本解析回同一 IRAsset（roundtrip 幂等，
 * 见 roundtrip.test.ts）；超出子集的写法不抛中断——能转多少转多少，无法映射的
 * 语句 / 方法 / 类成员折叠为脚本片段（IRSnippet，绝不丢源码、绝不静默丢弃）
 * 并附行列诊断。
 *
 * 实现基于 TypeScript 编译器 API（ts.createSourceFile，devDependencies 已含）；
 * 诊断行号取自 ts.getLineAndCharacterOfPosition（1 起）。
 *
 * 解析规则（与 codegen-ts.ts 成对，共享常量见 ./codegen-common.ts）：
 *  - @tool / @expose / @on / @onEvent 注解 → 资产名 / 变量 / 事件入口节点；
 *  - 方法体语句 → 节点链：if → branch、for → forLoop、for..of → array.forEach、
 *    while → whileLoop、await delay → flow.delay、emit → event.send、
 *    print → system.print、this/vars 读写 → var.get/set、ui.* → ui 节点、
 *    bps.* → 对应节点、表达式表反向匹配 → 纯节点；
 *  - 表达式 AST → 纯节点树（模板字符串 → string.concat 左折叠、数组字面量 →
 *    array.make、对象字面量（含非常量值）→ map.set 链等）；
 *  - 函数方法 → 函数子图（func.entry / func.return + params/returns，返回值声明
 *    优先读 __bps-returns JSON 注释，缺省从 return 语句推断）；
 *  - __bps-snippet-begin/end 标记对 → 片段节点 + IRSnippet（pins 来自标记行元数据）；
 *    __bps-seq 标记 → flow.sequence 节点重建；__bps-events / __bps-meta 注释
 *    → 孤儿事件表 / 主图名；
 *  - 循环变量 / 方法参数 / __bps_* 别名 / 解构名经作用域映射为引脚引用；
 *    提升的 let（let i = 0; for (i = …)）与循环语句分组消费。
 */
import ts from 'typescript';
import type {
  IRAsset,
  IREdge,
  IREventDef,
  IRGraph,
  IRNode,
  IRParamSpec,
  IRSnippet,
  IRSnippetPin,
  IRVariable,
  NodeSpec,
} from '../ir/types';
import { IR_VERSION } from '../ir/types';
import {
  EVENT_NAME_PARAM,
  EXPR_TABLE_MAP,
  SNIPPET_IN_WIRE_PREFIX,
  SNIPPET_NODE_TYPE,
  SNIPPET_OUT_WIRE_PREFIX,
  SNIPPET_PARAM_KEY,
  SNIPPET_WIRING_PREFIX,
  TYPE_EVENT_CUSTOM,
  TYPE_EVENT_LISTEN,
  TYPE_EVENT_START,
  TYPE_FLOW_CALL,
  TYPE_FUNC_ENTRY,
  TYPE_FUNC_RETURN,
  callArgPlan,
  nodeIdFromBpsCallee,
  parseMetaLine,
  parseOrphanEventsLine,
  parseSequenceMarkerLine,
  parseSnippetBeginLine,
  parseSnippetEndLine,
  specOfType,
  stripSpecDefaults,
  tsAnnotationToIrType,
  typeCommentOf,
} from './codegen-common';
import { analyzeSnippetNode } from './snippet';

/** 解析诊断（行列 1 起；severity = warning 的条目对应折叠为片段等降级说明） */
export interface ParseDiagnostic {
  /** 行号（1 起） */
  line: number;
  /** 列号（1 起） */
  column: number;
  /** 级别：error = 语法错误 / 未解析引用；warning = 已折叠为片段等降级说明 */
  severity: 'error' | 'warning';
  /** 中文说明 */
  message: string;
}

/** parseScriptToIR 选项 */
export interface ParseScriptOptions {
  /** 资产名（缺省取 @tool 注解参数，再缺省为空串） */
  name?: string;
  /** 主图名（缺省取 __bps-meta 注释，再缺省 'main'） */
  entry?: string;
}

/** parseScriptToIR 结果：IR 资产 + 诊断列表（不抛中断） */
export interface ParseScriptResult {
  asset: IRAsset;
  diagnostics: ParseDiagnostic[];
}

/** 表达式求值结果：节点引脚 或 字面量（字面量落为目标节点的 pinDefaults） */
type ValueRef = { kind: 'node'; node: string; pin: string } | { kind: 'literal'; value: unknown };

/** exec 链的延续端点（语句序列的「当前位置」） */
interface ExecSource {
  node: string;
  pin: string;
}

/** 语句流条目（语句 / 片段块 / 序列标记的统一流） */
type BodyItem =
  | { kind: 'stmt'; pos: number; stmt: ts.Statement }
  | { kind: 'snippet'; pos: number; id: string; lang: 'ts' | 'py'; pins: unknown[]; code: string }
  | { kind: 'seq'; pos: number; nodeId: string; pin: string };

/** 表达式不可解析 → 折叠当前语句的内部信号 */
class FoldSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'FoldSignal';
  }
}

/** 字面量提取结果 */
interface LiteralOf {
  ok: boolean;
  value?: unknown;
}

const NOT_LITERAL: LiteralOf = { ok: false };

/**
 * 受控子集解析器（TS → IR）。
 * parseScriptToIR(code, opts) 唯一入口；解析失败不抛中断，折叠 + 诊断。
 */
export function parseScriptToIR(code: string, opts: ParseScriptOptions = {}): ParseScriptResult {
  return new Parser(code, opts).run();
}

class Parser {
  readonly sf: ts.SourceFile;
  readonly diags: ParseDiagnostic[] = [];
  /** 类内声明的变量（字段） */
  readonly variables: IRVariable[] = [];
  /** 事件表（@on/@onEvent 方法签名 + __bps-events 孤儿事件，按出现序去重） */
  readonly events: IREventDef[] = [];
  /** 片段表（标记对重建 + 折叠 + 孤儿，按出现序） */
  readonly snippets: IRSnippet[] = [];
  private readonly snippetIds = new Set<string>();
  /** 函数方法签名（flow.call 入参引脚名映射用，pass1 收集） */
  readonly fnSigs = new Map<string, { params: IRParamSpec[]; returns: IRParamSpec[] }>();
  private foldSeq = 0;
  private readonly eventMethods: { method: ts.MethodDeclaration; kind: string; eventName: string }[] = [];
  private readonly fnMethods: { method: ts.MethodDeclaration; name: string; returns: IRParamSpec[] }[] = [];
  /** loose 片段块覆盖的行区间（1 起闭区间 from=begin 行 / to=end 行；构造器中扫描） */
  private readonly looseRanges: { from: number; to: number }[] = [];

  constructor(
    private readonly code: string,
    private readonly opts: ParseScriptOptions,
  ) {
    this.sf = ts.createSourceFile('asset.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    // loose 标记对行区间扫描（class 外语句折叠时跳过 loose 内容，见 run()）
    const lines = code.split('\n');
    let open: { id: string; from: number } | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      if (!open) {
        const meta = parseSnippetBeginLine(lines[i], 'loose');
        if (meta) open = { id: meta.id, from: i + 1 };
        continue;
      }
      if (parseSnippetEndLine(lines[i], 'loose') === open.id) {
        this.looseRanges.push({ from: open.from, to: i + 1 });
        open = null;
      }
    }
  }

  /* ============================================================
   * 主流程
   * ============================================================ */

  run(): ParseScriptResult {
    const entryName = this.opts.entry ?? parseMetaLine(this.code) ?? 'main';

    /* ---------- 语法诊断（解析继续，尽量多转） ---------- */
    for (const d of ((this.sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [])) {
      const pos = d.start !== undefined ? this.posAt(d.start) : { line: 1, column: 1 };
      this.diags.push({
        ...pos,
        severity: 'error',
        message: `语法错误：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
      });
    }

    /* ---------- 找逻辑类 ---------- */
    const cls = this.sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s));
    if (!cls) {
      this.diags.push({
        line: 1,
        column: 1,
        severity: 'error',
        message: '未找到逻辑类（受控子集要求 @tool class …）——整文件折叠为脚本片段保留',
      });
      this.pushFoldedSnippet(this.code, []);
      return this.finish('', entryName, undefined);
    }

    /* ---------- pass1：类成员（字段 → 变量；方法分类）+ 顶层散件 ---------- */
    const assetName = this.opts.name ?? this.classToolName(cls) ?? '';
    for (const member of cls.members) {
      if (ts.isPropertyDeclaration(member)) {
        this.collectField(member);
      } else if (ts.isMethodDeclaration(member) && member.body) {
        this.collectMethod(member);
      } else {
        this.diags.push({
          ...this.posAt(member.getStart(this.sf)),
          severity: 'warning',
          message: '构造器 / 存取器 / 无体方法等类成员不受受控子集支持，已折叠为脚本片段',
        });
        this.pushFoldedSnippetDerived(member);
      }
    }
    for (const stmt of this.sf.statements) {
      if (stmt === cls) continue;
      // loose 片段块（__bps-loose 标记对）内的语句由 collectLooseSnippets 原样重建，
      // 不再作为顶层散件折叠（否则同一份源码会被收录两次，T3.7 修复）
      const stmtLine = this.posAt(stmt.getStart(this.sf)).line;
      if (this.looseRanges.some((r) => stmtLine > r.from && stmtLine < r.to)) continue;
      this.diags.push({
        ...this.posAt(stmt.getStart(this.sf)),
        severity: 'warning',
        message: '类之外的顶层语句不受受控子集支持，已折叠为脚本片段保留',
      });
      this.pushFoldedSnippetDerived(stmt);
    }

    /* ---------- 事件表：方法签名 + 孤儿事件注释（'start' 是内建事件，不进事件表） ---------- */
    for (const m of this.eventMethods) {
      if (m.eventName === 'start') continue;
      if (!this.events.some((e) => e.name === m.eventName)) {
        // @onEvent 方法的 args 参数是监听节点 args 输出脚的具名引用，不是事件参数
        const sigParams = this.signatureParams(m.method).filter((p) => !(m.kind === TYPE_EVENT_LISTEN && p.name === 'args'));
        this.events.push({ name: m.eventName, params: sigParams });
      }
    }
    for (const line of this.code.split('\n')) {
      const orphans = parseOrphanEventsLine(line);
      if (!orphans) continue;
      for (const raw of orphans) {
        const e = raw as { name?: unknown; params?: unknown };
        if (typeof e.name !== 'string' || this.events.some((x) => x.name === e.name)) continue;
        this.events.push({
          name: e.name,
          params: Array.isArray(e.params) ? (e.params as IRParamSpec[]) : [],
        });
      }
    }

    /* ---------- pass2：方法体 → 节点链 ---------- */
    const graphs: Record<string, IRGraph> = {};
    graphs[entryName] = { nodes: [], edges: [] };
    const entryBuilder = new GraphBuilder(this, entryName, false, []);
    for (const m of this.eventMethods) {
      this.buildEventMethod(entryBuilder, m);
    }
    entryBuilder.resolveSnippetWirings();
    graphs[entryName].nodes = entryBuilder.nodes;
    graphs[entryName].edges = entryBuilder.edges;

    for (const m of this.fnMethods) {
      let graphName = m.name;
      if (graphName in graphs) {
        const renamed = `${graphName}_fn`;
        this.diags.push({
          ...this.posAt(m.method.getStart(this.sf)),
          severity: 'warning',
          message: `方法名「${m.name}」与已有图重名，函数图更名为「${renamed}」`,
        });
        graphName = renamed;
      }
      const params = this.signatureParams(m.method);
      const builder = new GraphBuilder(this, graphName, true, m.returns);
      const entryNode = builder.addNode(TYPE_FUNC_ENTRY);
      for (const p of params) builder.scope.set(p.name, { kind: 'node', node: entryNode.id, pin: p.name });
      builder.buildLoopAwareBody(m.method.body as ts.Block, [{ node: entryNode.id, pin: 'exec' }], null);
      builder.resolveSnippetWirings();
      graphs[graphName] = {
        nodes: builder.nodes,
        edges: builder.edges,
        ...(params.length > 0 ? { params } : {}),
        ...(m.returns.length > 0 ? { returns: m.returns } : {}),
      };
    }

    /* ---------- 孤儿片段（__bps-loose 标记对，文件级） ---------- */
    this.collectLooseSnippets();

    /* ---------- 规范化：剥离等于 spec 默认值的字面量 ---------- */
    for (const g of Object.values(graphs)) {
      for (const n of g.nodes) stripSpecDefaults(n);
    }

    return this.finish(assetName, entryName, graphs);
  }

  private finish(name: string, entryName: string, graphs: Record<string, IRGraph> | undefined): ParseScriptResult {
    const asset: IRAsset = {
      version: IR_VERSION,
      name,
      entry: entryName,
      graphs: graphs ?? { [entryName]: { nodes: [], edges: [] } },
      variables: this.variables,
      events: this.events,
      snippets: this.snippets,
      layout: {},
    };
    return { asset, diagnostics: this.diags };
  }

  /* ============================================================
   * pass1：字段 / 方法收集
   * ============================================================ */

  /** @tool 注解参数（资产名） */
  private classToolName(cls: ts.ClassDeclaration): string | undefined {
    for (const d of ts.getDecorators(cls) ?? []) {
      if (!ts.isCallExpression(d.expression)) continue;
      if (!ts.isIdentifier(d.expression.expression) || d.expression.expression.text !== 'tool') continue;
      const arg = d.expression.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) return arg.text;
    }
    return undefined;
  }

  /** 字段 → IRVariable（@expose 注解 + @bps 类型注释 + 字面量初始化器） */
  private collectField(prop: ts.PropertyDeclaration): void {
    if (!ts.isIdentifier(prop.name)) {
      this.diags.push({
        ...this.posAt(prop.getStart(this.sf)),
        severity: 'warning',
        message: '非标识符字段名不受支持，已折叠为脚本片段',
      });
      this.pushFoldedSnippetDerived(prop);
      return;
    }
    const declText = prop.getText(this.sf);
    let exposed = false;
    let annoDefault: unknown;
    let annoType: string | undefined;
    let category: string | undefined;
    for (const d of ts.getDecorators(prop) ?? []) {
      const expr = d.expression;
      // 裸 @expose（无括号）：仅暴露标记（T3.4 补缺——手工脚本常见形态，与 scan.ts / PLAN §9.2 对齐）
      if (ts.isIdentifier(expr)) {
        if (expr.text === 'expose') exposed = true;
        continue;
      }
      if (!ts.isCallExpression(expr)) continue;
      if (!ts.isIdentifier(expr.expression) || expr.expression.text !== 'expose') continue;
      exposed = true;
      const arg = expr.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          const v = p.initializer;
          if (p.name.text === 'default') {
            const lit = this.exprLiteral(v);
            if (lit.ok) annoDefault = lit.value;
          } else if (p.name.text === 'category' && ts.isStringLiteralLike(v)) {
            category = v.text;
          } else if (p.name.text === 'type' && ts.isStringLiteralLike(v)) {
            annoType = v.text;
          }
          // 注解 type 仅在字段无 TS 类型注解时兜底（见下方类型优先级）
        }
      }
    }
    const commentType = typeCommentOf(declText);
    // 类型优先级：行内 @bps 注释 > TS 类型注解 > @expose type 参数（无 TS 注解时的兜底）> any
    const annoText = prop.type ? tsAnnotationToIrType(prop.type.getText(this.sf)) : undefined;
    const type = commentType ?? annoText ?? annoType ?? 'any';
    const v: IRVariable = { name: prop.name.text, type };
    if (exposed) v.exposed = true;
    if (category !== undefined) v.category = category;
    // 默认值：初始化器优先，@expose default 兜底
    const initLit = prop.initializer ? this.exprLiteral(prop.initializer) : NOT_LITERAL;
    if (initLit.ok) v.default = initLit.value;
    else if (annoDefault !== undefined) v.default = annoDefault;
    this.variables.push(v);
  }

  /** 方法分类：@on / @onEvent → 事件方法；其余 → 函数方法（返回值声明优先读注释） */
  private collectMethod(m: ts.MethodDeclaration): void {
    if (!ts.isIdentifier(m.name)) {
      this.diags.push({
        ...this.posAt(m.getStart(this.sf)),
        severity: 'warning',
        message: '非标识符方法名不受支持，已折叠为脚本片段',
      });
      this.pushFoldedSnippetDerived(m);
      return;
    }
    let eventName: string | undefined;
    let isListen = false;
    for (const d of ts.getDecorators(m) ?? []) {
      if (!ts.isCallExpression(d.expression)) continue;
      if (!ts.isIdentifier(d.expression.expression)) continue;
      const decoName = d.expression.expression.text;
      if (decoName !== 'on' && decoName !== 'onEvent') continue;
      const args = d.expression.arguments;
      // @on('start') / @on(事件名) / @on(节点名, 事件名)（双参形式取第二参，T2.6 语义）
      const evArg = decoName === 'on' && args.length >= 2 ? args[1] : args[0];
      if (evArg && ts.isStringLiteralLike(evArg)) {
        eventName = evArg.text;
        isListen = decoName === 'onEvent';
      }
    }

    if (eventName !== undefined) {
      const kind = eventName === 'start' && !isListen ? TYPE_EVENT_START : isListen ? TYPE_EVENT_LISTEN : TYPE_EVENT_CUSTOM;
      this.eventMethods.push({ method: m, kind, eventName });
      return;
    }

    // 函数方法：返回值声明优先读 __bps-returns JSON 注释，缺省从 return 语句推断
    const returns = this.returnsFromComment(m) ?? this.returnsFromReturnStatements(m);
    this.fnMethods.push({ method: m, name: m.name.text, returns });
    this.fnSigs.set(m.name.text, { params: this.signatureParams(m), returns });
  }

  /** 方法签名 → 参数声明（行内 @bps 类型注释优先于 TS 注解推断） */
  private signatureParams(m: ts.MethodDeclaration): IRParamSpec[] {
    return m.parameters.map((p) => {
      const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText(this.sf);
      const commentType = typeCommentOf(p.getText(this.sf));
      const type = commentType ?? (p.type ? tsAnnotationToIrType(p.type.getText(this.sf)) : 'any');
      return { name, type };
    });
  }

  /** __bps-returns JSON 注释 → 返回值声明 */
  private returnsFromComment(m: ts.MethodDeclaration): IRParamSpec[] | null {
    const fullText = this.sf.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, m.getFullStart()) ?? [];
    for (const r of ranges) {
      const match = /__bps-returns\s+(\[.*\])/.exec(fullText.slice(r.pos, r.end));
      if (!match) continue;
      try {
        const arr = JSON.parse(match[1]) as IRParamSpec[];
        if (Array.isArray(arr)) return arr;
      } catch {
        // 注释损坏 → 回退 return 语句推断
      }
    }
    return null;
  }

  /** 从 return 语句推断返回值声明（对象字面量键序；无注释时的兜底） */
  private returnsFromReturnStatements(m: ts.MethodDeclaration): IRParamSpec[] {
    const out: IRParamSpec[] = [];
    const seen = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        for (const p of node.expression.properties) {
          if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
          const name = ts.isPropertyAssignment(p)
            ? ts.isIdentifier(p.name)
              ? p.name.text
              : ts.isStringLiteral(p.name)
                ? p.name.text
                : null
            : p.name.text;
          if (name === null || seen.has(name)) continue;
          seen.add(name);
          out.push({ name, type: 'any' });
        }
      }
      node.forEachChild(visit);
    };
    if (m.body) visit(m.body);
    return out;
  }

  /* ============================================================
   * pass2：方法体 → 节点链
   * ============================================================ */

  /** 事件方法 → 入口节点 + 语句链（全部并入主图；作用域逐方法隔离） */
  private buildEventMethod(
    builder: GraphBuilder,
    m: { method: ts.MethodDeclaration; kind: string; eventName: string },
  ): void {
    const { method, kind, eventName } = m;
    builder.resetScope();
    let entryNode: IRNode;
    if (kind === TYPE_EVENT_START) {
      if (method.parameters.length > 0) {
        this.diags.push({
          ...this.posAt(method.getStart(this.sf)),
          severity: 'warning',
          message: `@on('start') 方法不应有参数（${method.parameters.length} 个参数被忽略）`,
        });
      }
      entryNode = builder.addNode(TYPE_EVENT_START);
    } else if (kind === TYPE_EVENT_CUSTOM) {
      entryNode = builder.addNode(TYPE_EVENT_CUSTOM, { [EVENT_NAME_PARAM]: eventName });
      const def = this.events.find((e) => e.name === eventName);
      for (const p of def?.params ?? []) {
        builder.scope.set(p.name, { kind: 'node', node: entryNode.id, pin: p.name });
      }
      // 位置式占位脚 arg0~arg2（解释器事件注入约定）
      for (let i = 0; i < 3; i += 1) {
        builder.scope.set(`arg${i}`, { kind: 'node', node: entryNode.id, pin: `arg${i}` });
      }
    } else {
      entryNode = builder.addNode(TYPE_EVENT_LISTEN, {}, { eventName });
      builder.scope.set('args', { kind: 'node', node: entryNode.id, pin: 'args' });
    }
    builder.buildLoopAwareBody(method.body as ts.Block, [{ node: entryNode.id, pin: 'exec' }], null);
  }

  /* ============================================================
   * 小工具（诊断 / 字面量 / 片段）
   * ============================================================ */

  /** 片段引脚元数据 → IRSnippetPin[]（容错；非法条目剔除） */
  normalizeSnippetPins(rawPins: unknown[]): IRSnippetPin[] {
    const pins: IRSnippetPin[] = [];
    for (const raw of rawPins) {
      const pin = raw as { id?: unknown; dir?: unknown; type?: unknown; label?: unknown };
      if (typeof pin.id !== 'string' || pin.id === '') continue;
      const spec: IRSnippetPin = {
        id: pin.id,
        dir: pin.dir === 'out' ? 'out' : 'in',
        type: typeof pin.type === 'string' && pin.type !== '' ? pin.type : 'any',
      };
      if (typeof pin.label === 'string') spec.label = pin.label;
      pins.push(spec);
    }
    return pins;
  }

  /** 文件级 __bps-loose-begin/end 标记对 → 孤儿片段（无节点引用；源码原样保留） */
  private collectLooseSnippets(): void {
    const lines = this.code.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const meta = parseSnippetBeginLine(lines[i], 'loose');
      if (!meta || this.snippetIds.has(meta.id)) continue;
      const codeLines: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (parseSnippetEndLine(lines[j], 'loose') === meta.id) break;
        codeLines.push(lines[j]);
      }
      this.snippetIds.add(meta.id);
      this.snippets.push({
        id: meta.id,
        lang: meta.lang,
        code:
          meta.lang === 'py'
            ? codeLines.map((l) => (l.trim() === '//' ? '' : l.replace(/^\s*\/\/ ?/, ''))).join('\n')
            : codeLines.join('\n'),
        pins: this.normalizeSnippetPins(meta.pins),
      });
    }
  }

  posAt(position: number): { line: number; column: number } {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(position);
    return { line: line + 1, column: character + 1 };
  }

  /** 折叠源码 → 孤儿片段（返回片段 id；调用方负责接线时自行建节点） */
  pushFoldedSnippet(code: string, pins: IRSnippetPin[]): string {
    this.foldSeq += 1;
    let id = `snip${this.foldSeq}`;
    while (this.snippetIds.has(id)) {
      this.foldSeq += 1;
      id = `snip${this.foldSeq}`;
    }
    this.snippetIds.add(id);
    this.snippets.push({ id, lang: 'ts', code, pins });
    return id;
  }

  /** 折叠 AST 节点 → 孤儿片段：引脚自动推导（外部引用 → in、裸赋值目标 / return 值 → out，ADR-007 §2） */
  pushFoldedSnippetDerived(node: ts.Node): string {
    const { inPins, outPins } = analyzeSnippetNode(node);
    const pins: IRSnippetPin[] = [
      ...inPins.map((p) => ({ id: p.id, dir: 'in' as const, type: p.type })),
      ...outPins.map((p) => ({ id: p.id, dir: 'out' as const, type: p.type })),
    ];
    return this.pushFoldedSnippet(node.getText(this.sf), pins);
  }

  /**
   * 语句的片段接线尾注释检测（T3.7，ADR-007 §3）：
   *  - `// __bps-snippet-in(<pin>)`：片段数据入脚别名行（初始化器延迟求值接线）；
   *  - `// __bps-snippet-out(<pin>)`：片段数据出脚别名行（别名 → 最近片段节点出脚）。
   */
  trailingSnippetWire(stmt: ts.Statement): { kind: 'in' | 'out'; pin: string } | null {
    const full = this.sf.getFullText();
    for (const r of ts.getTrailingCommentRanges(full, stmt.end) ?? []) {
      const text = full.slice(r.pos, r.end);
      const mIn = new RegExp(`${SNIPPET_IN_WIRE_PREFIX}\\(([^)]*)\\)`).exec(text);
      if (mIn) return { kind: 'in', pin: mIn[1] };
      const mOut = new RegExp(`${SNIPPET_OUT_WIRE_PREFIX}\\(([^)]*)\\)`).exec(text);
      if (mOut) return { kind: 'out', pin: mOut[1] };
    }
    return null;
  }

  /** 表达式的 JSON 兼容字面量提取（对象 / 数组递归；非常量 → 不 ok） */
  exprLiteral(e: ts.Expression | undefined): LiteralOf {
    if (!e) return NOT_LITERAL;
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return { ok: true, value: Number((e as ts.NumericLiteral).text) };
      case ts.SyntaxKind.StringLiteral:
        return { ok: true, value: (e as ts.StringLiteral).text };
      case ts.SyntaxKind.TrueKeyword:
        return { ok: true, value: true };
      case ts.SyntaxKind.FalseKeyword:
        return { ok: true, value: false };
      case ts.SyntaxKind.NullKeyword:
        return { ok: true, value: null };
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return { ok: true, value: (e as ts.NoSubstitutionTemplateLiteral).text };
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.exprLiteral((e as ts.ParenthesizedExpression).expression);
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = e as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.MinusToken) {
          const inner = this.exprLiteral(u.operand);
          if (inner.ok && typeof inner.value === 'number') return { ok: true, value: -inner.value };
        }
        return NOT_LITERAL;
      }
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const arr: unknown[] = [];
        for (const el of (e as ts.ArrayLiteralExpression).elements) {
          if (ts.isSpreadElement(el)) return NOT_LITERAL;
          const lit = this.exprLiteral(el);
          if (!lit.ok) return NOT_LITERAL;
          arr.push(lit.value);
        }
        return { ok: true, value: arr };
      }
      case ts.SyntaxKind.ObjectLiteralExpression: {
        const rec: Record<string, unknown> = {};
        for (const p of (e as ts.ObjectLiteralExpression).properties) {
          if (!ts.isPropertyAssignment(p)) return NOT_LITERAL;
          const key = ts.isIdentifier(p.name)
            ? p.name.text
            : ts.isStringLiteral(p.name)
              ? p.name.text
              : ts.isNumericLiteral(p.name)
                ? p.name.text
                : null;
          if (key === null) return NOT_LITERAL;
          const lit = this.exprLiteral(p.initializer);
          if (!lit.ok) return NOT_LITERAL;
          rec[key] = lit.value;
        }
        return { ok: true, value: rec };
      }
      default:
        return NOT_LITERAL;
    }
  }
}

/* ============================================================
 * 图构建器（单个方法体 → 节点 + 连线）
 * ============================================================ */

class GraphBuilder {
  readonly nodes: IRNode[] = [];
  readonly edges: IREdge[] = [];
  /** 节点 id → 节点实例（表达式反查节点类型用） */
  private readonly nodesRef = new Map<string, IRNode>();
  /** 标识符 → 引脚引用（方法参数 / 循环变量 / 别名 / 事件参数） */
  scope = new Map<string, ValueRef>();
  private readonly seqNodes = new Map<string, IRNode>();
  private nodeSeq = 0;
  private edgeSeq = 0;
  /** 作用域回滚日志（语句级回滚用） */
  private scopeLog: string[] = [];
  /** 片段入脚标记（已拦截、待最近片段块认领；T3.7 ADR-007 §3） */
  private pendingSnippetIns: { pin: string; expr?: ts.Expression; pos?: number }[] = [];
  /** 已认领待接线的片段入脚（方法体构建完成后统一求值接线） */
  private deferredSnippetIns: { pin: string; nodeId: string; expr?: ts.Expression; pos?: number }[] = [];
  /** 最近创建的片段节点 id（出脚标记 __bps-snippet-out 的绑定目标） */
  private lastSnippetNodeId: string | null = null;

  constructor(
    private readonly p: Parser,
    private readonly graphName: string,
    private readonly isFunction: boolean,
    /** 当前函数图的返回值声明（func.return 简写形态用） */
    private readonly returns: IRParamSpec[],
  ) {}

  /** 事件方法间作用域隔离（参数 / 循环变量不跨方法泄漏） */
  resetScope(): void {
    this.scope = new Map();
    this.scopeLog = [];
    this.lastSnippetNodeId = null;
  }

  /** 源文件（来自宿主 Parser；行列诊断与源码提取共用） */
  private get sf(): ts.SourceFile {
    return this.p.sf;
  }

  /* ---------- 基础 ---------- */

  addNode(type: string, params: Record<string, unknown> = {}, pinDefaults: Record<string, unknown> = {}): IRNode {
    this.nodeSeq += 1;
    const node: IRNode = {
      id: `n${this.nodeSeq}`,
      type,
      params: { ...params },
      pinDefaults: { ...pinDefaults },
      position: { x: 0, y: 0 },
    };
    this.nodes.push(node);
    this.nodesRef.set(node.id, node);
    return node;
  }

  private addEdge(from: { node: string; pin: string }, to: { node: string; pin: string }, kind: 'exec' | 'data'): void {
    this.edgeSeq += 1;
    this.edges.push({ id: `e${this.edgeSeq}`, from, to, kind });
  }

  /** 把求值结果接到目标输入引脚（字面量 → pinDefaults；节点 → 数据边） */
  private connect(target: IRNode, pin: string, ref: ValueRef): void {
    if (ref.kind === 'literal') {
      target.pinDefaults[pin] = ref.value;
    } else {
      this.addEdge({ node: ref.node, pin: ref.pin }, { node: target.id, pin }, 'data');
    }
  }

  private connectExec(source: ExecSource, target: IRNode, pin = 'exec'): void {
    this.addEdge({ node: source.node, pin: source.pin }, { node: target.id, pin }, 'exec');
  }

  private refOf(node: IRNode, pin: string): ValueRef {
    return { kind: 'node', node: node.id, pin };
  }

  private bindScope(name: string, ref: ValueRef): void {
    this.scope.set(name, ref);
    this.scopeLog.push(name);
  }

  /* ---------- 语句流（片段块 / 序列标记 / 语句统一处理） ---------- */

  /**
   * 方法体 / 块的语句流构建。
   * breakTaker 非空 = 循环体：体尾 `if (X) { break; }` 的条件表达式节点交由循环
   * 构建器在体构建完成后再求值接线（此时循环变量 / 体内别名已在作用域中）。
   */
  buildLoopAwareBody(block: ts.Block, sources: ExecSource[], breakTaker: ((expr: ts.Expression) => void) | null): ExecSource[] {
    const items = this.prescanBody(block);
    let pending = sources;

    const breakIf = breakTaker && items.length > 0 && items[items.length - 1].kind === 'stmt'
      ? this.breakIfOf((items[items.length - 1] as { kind: 'stmt'; stmt: ts.Statement }).stmt)
      : null;
    if (breakIf) {
      items.pop();
      breakTaker!(breakIf);
    }

    let i = 0;
    while (i < items.length) {
      const item = items[i];
      if (item.kind === 'seq') {
        pending = this.handleSeqMarker(item, pending);
        i += 1;
        continue;
      }
      if (item.kind === 'snippet') {
        pending = this.handleSnippetBlock(item, pending);
        i += 1;
        continue;
      }
      /* 提升的 let（codegen 循环变量形态）：与紧随的 for / for..of 分组消费 */
      if (ts.isVariableStatement(item.stmt) && this.isHoistedLet(item.stmt)) {
        const lets: ts.VariableStatement[] = [];
        let j = i;
        while (j < items.length && items[j].kind === 'stmt' && ts.isVariableStatement((items[j] as { stmt: ts.Statement }).stmt) && this.isHoistedLet((items[j] as { stmt: ts.Statement }).stmt as ts.VariableStatement)) {
          lets.push((items[j] as { stmt: ts.Statement }).stmt as ts.VariableStatement);
          j += 1;
        }
        const nextItem = items[j];
        const nextStmt = nextItem && nextItem.kind === 'stmt' ? nextItem.stmt : null;
        if (nextStmt && ts.isForStatement(nextStmt) && this.forUsesAnyLet(nextStmt, lets)) {
          pending = this.buildWithRollback(nextStmt, pending, () => this.buildFor(lets, nextStmt, pending));
          i = j + 1;
          continue;
        }
        if (nextStmt && ts.isForOfStatement(nextStmt) && this.forOfUsesAnyLet(nextStmt, lets)) {
          pending = this.buildWithRollback(nextStmt, pending, () => this.buildForOf(lets, nextStmt, pending));
          i = j + 1;
          continue;
        }
        // 不跟循环的 let：逐条折叠（受控子集无局部变量）
        for (const letStmt of lets) {
          pending = this.buildWithRollback(letStmt, pending, () => this.buildVariableStatement(letStmt, pending, [], -1));
        }
        i = j;
        continue;
      }
      pending = this.buildWithRollback(item.stmt, pending, () =>
        this.buildStatement(item.stmt, pending, items, i),
      );
      i += 1;
    }
    return pending;
  }

  /** 单条语句（或 let+for 分组）构建；失败折叠为片段并回滚（节点 / 边 / 作用域） */
  private buildWithRollback(stmt: ts.Statement, pending: ExecSource[], build: () => ExecSource[]): ExecSource[] {
    const markNodes = this.nodes.length;
    const markEdges = this.edges.length;
    const markScope = this.scopeLog.length;
    try {
      return build();
    } catch (err) {
      if (!(err instanceof FoldSignal)) throw err;
      this.nodes.length = markNodes;
      this.edges.length = markEdges;
      for (const name of this.scopeLog.splice(markScope)) this.scope.delete(name);
      const pos = this.p.posAt(stmt.getStart(this.sf));
      this.p.diags.push({
        ...pos,
        severity: 'warning',
        message: `图「${this.graphName}」第 ${pos.line} 行语句无法映射为蓝图节点，已折叠为脚本片段：${err.reason}`,
      });
      return this.foldStatement(stmt, pending);
    }
  }

  /** let 声明判定（codegen 的循环变量提升形态；const / var 不算） */
  private isHoistedLet(stmt: ts.VariableStatement): boolean {
    return stmt.getText(this.sf).startsWith('let ');
  }

  /** for 语句的 init / update 是否使用了提升 let 的名字 */
  private forUsesAnyLet(stmt: ts.ForStatement, lets: ts.VariableStatement[]): boolean {
    const names = new Set<string>();
    for (const s of lets) {
      const d = s.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) names.add(d.name.text);
    }
    const uses = (e: ts.Expression | undefined): boolean =>
      !!e && ts.isIdentifier(e) && names.has(e.text);
    const init = stmt.initializer;
    const initOk = !!init && ((ts.isBinaryExpression(init) && uses(init.left)) || uses(init as unknown as ts.Expression));
    const updateOk = !!stmt.incrementor && (ts.isPostfixUnaryExpression(stmt.incrementor) ? uses(stmt.incrementor.operand) : ts.isBinaryExpression(stmt.incrementor) ? uses(stmt.incrementor.left) : false);
    const condOk = !!stmt.condition && ts.isBinaryExpression(stmt.condition) && uses(stmt.condition.left);
    return initOk && updateOk && condOk;
  }

  /** for..of 是否解构了提升 let 的名字 */
  private forOfUsesAnyLet(stmt: ts.ForOfStatement, lets: ts.VariableStatement[]): boolean {
    const names = new Set<string>();
    for (const s of lets) {
      const d = s.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name)) names.add(d.name.text);
    }
    if (ts.isArrayLiteralExpression(stmt.initializer)) {
      // 提升 let 赋值形：for ([i, el] of …)
      return stmt.initializer.elements.some((el) => ts.isIdentifier(el) && names.has(el.text));
    }
    if (!ts.isVariableDeclarationList(stmt.initializer) || stmt.initializer.declarations.length !== 1) return false;
    const decl = stmt.initializer.declarations[0];
    if (ts.isIdentifier(decl.name)) return names.has(decl.name.text);
    if (ts.isArrayBindingPattern(decl.name)) {
      return decl.name.elements.some((el) => ts.isBindingElement(el) && ts.isIdentifier(el.name) && names.has(el.name.text));
    }
    return false;
  }

  /** 方法体 / 块的统一条目流（语句 ∪ 片段块 ∪ 序列标记，按位置排序） */
  private prescanBody(block: ts.Block): BodyItem[] {
    const items: BodyItem[] = [];
    const fullText = this.sf.getFullText();
    const bodyStart = block.getStart(this.sf);
    const bodyEnd = block.end;

    /* 注释标记扫描（__bps-snippet / __bps-seq；其余注释忽略。
     * seq 标记为括号形 `// __bps-seq(<id>) <pin>`（见 sequenceMarkerLine），snippet 为
     * 连字符形 `__bps-snippet-begin/end(...)`——扫描正则须同时兼容 `[-(]` 两种后随符） */
    const slice = fullText.slice(bodyStart, bodyEnd);
    const markerRe = /^[ \t]*\/\/ __bps-(?:snippet|seq)[-(].*$/gm;
    const markers: { pos: number; text: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(slice)) !== null) {
      markers.push({ pos: bodyStart + m.index, text: m[0] });
    }

    /* 片段块配对（顺序扫描，不嵌套） */
    const snippetRanges: { begin: number; end: number; meta: { id: string; lang: 'ts' | 'py'; pins: unknown[] }; code: string }[] = [];
    for (let i = 0; i < markers.length; ) {
      const meta = parseSnippetBeginLine(markers[i].text, 'snippet');
      if (!meta) {
        i += 1;
        continue;
      }
      let endIdx = -1;
      for (let j = i + 1; j < markers.length; j += 1) {
        if (parseSnippetEndLine(markers[j].text, 'snippet') === meta.id) {
          endIdx = j;
          break;
        }
      }
      if (endIdx === -1) break; // 未配对：其余扫描放弃（正常生成不会出现）
      const beginLineEnd = markers[i].pos + markers[i].text.length;
      const rawLines = fullText.slice(beginLineEnd, markers[endIdx].pos).split('\n');
      if (rawLines.length > 0 && rawLines[0].trim() === '') rawLines.shift();
      if (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
      // 代码行按 begin 标记行的缩进去除前缀（方法体缩进不进入片段源码，往返无损）
      const markerIndent = /^[ \t]*/.exec(markers[i].text)![0];
      const dedent = (l: string): string =>
        l.trim() === '' ? '' : l.startsWith(markerIndent) ? l.slice(markerIndent.length) : l;
      // 片段源码行：剔除出脚声明对（行首/行尾携带 __bps-snippet-wiring 前缀的行，ADR-007 §3）
      const codeLines = rawLines.map(dedent).filter((l) => !l.includes(SNIPPET_WIRING_PREFIX));
      const code =
        meta.lang === 'py'
          ? codeLines.map((l) => (l.trim() === '//' ? '' : l.replace(/^\s*\/\/ ?/, ''))).join('\n')
          : codeLines.join('\n');
      snippetRanges.push({ begin: markers[i].pos, end: markers[endIdx].pos, meta, code });
      i = endIdx + 1;
    }
    for (const r of snippetRanges) {
      items.push({ kind: 'snippet', pos: r.begin, id: r.meta.id, lang: r.meta.lang, pins: r.meta.pins, code: r.code });
    }

    /* 语句（剔除片段块内的语句） */
    const inSnippet = (pos: number): boolean => snippetRanges.some((r) => pos >= r.begin && pos < r.end);
    for (const stmt of block.statements) {
      const pos = stmt.getStart(this.sf);
      if (inSnippet(pos)) continue;
      items.push({ kind: 'stmt', pos, stmt });
    }
    /* 序列标记（独立排序） */
    for (const mk of markers) {
      const seq = parseSequenceMarkerLine(mk.text);
      if (!seq || inSnippet(mk.pos)) continue;
      items.push({ kind: 'seq', pos: mk.pos, nodeId: seq.nodeId, pin: seq.pin });
    }
    items.sort((a, b) => a.pos - b.pos);
    return items;
  }

  /** 序列标记 → flow.sequence 节点（同 id 只建一次；重复出现时把上一段尾端接回 exec 入） */
  private handleSeqMarker(item: { nodeId: string; pin: string }, pending: ExecSource[]): ExecSource[] {
    let seqNode = this.seqNodes.get(item.nodeId);
    if (!seqNode) {
      seqNode = this.addNode('flow.sequence');
      for (const s of pending) this.connectExec(s, seqNode, 'exec');
      this.seqNodes.set(item.nodeId, seqNode);
    } else {
      // 续接触发语义：上一段链尾回连到 sequence 的 exec 入（与解释器状态机一致）
      for (const s of pending) this.connectExec(s, seqNode, 'exec');
    }
    return [{ node: seqNode.id, pin: item.pin }];
  }

  /**
   * 片段块 → 片段节点 + IRSnippet（pins 来自标记行元数据，往返无损）。
   * T3.7：认领块前的数据入脚标记（延迟接线）并记录为「最近片段节点」，
   * 供块后的数据出脚标记（__bps-snippet-out）绑定具名引用（ADR-007 §3）。
   */
  private handleSnippetBlock(
    item: { id: string; lang: 'ts' | 'py'; pins: unknown[]; code: string },
    pending: ExecSource[],
  ): ExecSource[] {
    if (!this.p.snippets.some((s) => s.id === item.id)) {
      this.p.snippets.push({
        id: item.id,
        lang: item.lang,
        code: item.code,
        pins: this.p.normalizeSnippetPins(item.pins),
      });
    }
    const pins = this.p.normalizeSnippetPins(item.pins);
    const node = this.addNode(SNIPPET_NODE_TYPE, { [SNIPPET_PARAM_KEY]: item.id });
    // 认领块前的入脚标记 → 延迟接线（方法体构建完成后统一求值，解纯片段间引用顺序）
    const claimed = this.pendingSnippetIns.splice(0);
    for (const c of claimed) this.deferredSnippetIns.push({ ...c, nodeId: node.id });
    this.lastSnippetNodeId = node.id;
    const execIn = pins.find((x) => x.dir === 'in' && x.type === 'exec');
    if (execIn) {
      for (const s of pending) this.connectExec(s, node, execIn.id);
      const execOut = pins.find((x) => x.dir === 'out' && x.type === 'exec');
      return execOut ? [{ node: node.id, pin: execOut.id }] : [];
    }
    // 无 exec 入（纯片段 / 仅 exec 出）：exec 中立——链 pending 直通（纯片段块不切断执行链）
    return pending;
  }

  /**
   * 延迟接线：方法体构建完成后对已认领的入脚标记统一求值并连数据边。
   * 初始化器此刻求值可命中后续语句绑定的别名/出脚引用（纯片段拓扑序由 codegen 保证）。
   */
  resolveSnippetWirings(): void {
    const deferred = this.deferredSnippetIns.splice(0);
    for (const w of deferred) {
      const node = this.nodesRef.get(w.nodeId);
      if (!node || !w.expr) {
        this.p.diags.push({
          ...this.p.posAt(w.pos ?? 0),
          severity: 'warning',
          message: `片段入脚标记「${w.pin}」缺少片段节点或初始化器，已忽略（源码可能被手工改动）`,
        });
        continue;
      }
      try {
        this.connect(node, w.pin, this.expr(w.expr));
      } catch (err) {
        if (!(err instanceof FoldSignal)) throw err;
        const pos = this.p.posAt(w.pos ?? 0);
        this.p.diags.push({
          ...pos,
          severity: 'warning',
          message: `片段入脚「${w.pin}」的初始化器无法求值，已忽略：${err.reason}`,
        });
      }
    }
    // 悬空入脚标记（后面没有片段块认领）：清理 + 诊断（正常生成不会出现）
    for (const stray of this.pendingSnippetIns.splice(0)) {
      const pos = this.p.posAt(stray.pos ?? 0);
      this.p.diags.push({
        ...pos,
        severity: 'warning',
        message: `片段入脚标记「${stray.pin}」之后没有对应的片段块，已忽略（源码可能被手工改动）`,
      });
    }
  }

  /** 语句折叠：原文进 IRSnippet（exec 骨架 + 推导数据引脚，ADR-007 §2），链在此续接 */
  private foldStatement(stmt: ts.Statement, pending: ExecSource[]): ExecSource[] {
    const derived = analyzeSnippetNode(stmt);
    const id = this.p.pushFoldedSnippet(stmt.getText(this.sf), [
      { id: 'exec', dir: 'in', type: 'exec' },
      { id: 'exec', dir: 'out', type: 'exec' },
      ...derived.inPins.map((p) => ({ id: p.id, dir: 'in' as const, type: p.type })),
      ...derived.outPins.map((p) => ({ id: p.id, dir: 'out' as const, type: p.type })),
    ]);
    const node = this.addNode(SNIPPET_NODE_TYPE, { [SNIPPET_PARAM_KEY]: id });
    for (const s of pending) this.connectExec(s, node, 'exec');
    return [{ node: node.id, pin: 'exec' }];
  }

  /* ============================================================
   * 语句映射
   * ============================================================ */

  private buildStatement(stmt: ts.Statement, pending: ExecSource[], items: BodyItem[], index: number): ExecSource[] {
    switch (stmt.kind) {
      case ts.SyntaxKind.IfStatement:
        return this.buildIf(stmt as ts.IfStatement, pending);
      case ts.SyntaxKind.WhileStatement:
        return this.buildWhile(stmt as ts.WhileStatement, pending);
      case ts.SyntaxKind.ForStatement:
        return this.buildFor([], stmt as ts.ForStatement, pending);
      case ts.SyntaxKind.ForOfStatement:
        return this.buildForOf([], stmt as ts.ForOfStatement, pending);
      case ts.SyntaxKind.ReturnStatement:
        return this.buildReturn(stmt as ts.ReturnStatement, pending);
      case ts.SyntaxKind.ExpressionStatement:
        return this.buildExpressionStatement(stmt as ts.ExpressionStatement, pending);
      case ts.SyntaxKind.VariableStatement:
        return this.buildVariableStatement(stmt as ts.VariableStatement, pending, items, index);
      case ts.SyntaxKind.Block:
        return this.buildLoopAwareBody(stmt as ts.Block, pending, null);
      case ts.SyntaxKind.EmptyStatement:
        return pending;
      default:
        throw new FoldSignal(`不支持的语句形态：${ts.SyntaxKind[stmt.kind]}`);
    }
  }

  /** if → branch（两臂尾端合并为后续语句的执行来源） */
  private buildIf(stmt: ts.IfStatement, pending: ExecSource[]): ExecSource[] {
    const node = this.addNode('flow.branch');
    this.connect(node, 'cond', this.expr(stmt.expression));
    this.wireExec(pending, node);
    const thenTails = this.buildBranchArm(stmt.thenStatement, [{ node: node.id, pin: 'true' }]);
    const elseTails = stmt.elseStatement
      ? this.buildBranchArm(stmt.elseStatement, [{ node: node.id, pin: 'false' }])
      : [];
    return [...thenTails, ...elseTails];
  }

  private buildBranchArm(stmt: ts.Statement, sources: ExecSource[]): ExecSource[] {
    if (ts.isBlock(stmt)) return this.buildLoopAwareBody(stmt, sources, null);
    return this.buildStatement(stmt, sources, [], -1);
  }

  /** while → whileLoop（体尾 if-break 接管 break 引脚） */
  private buildWhile(stmt: ts.WhileStatement, pending: ExecSource[]): ExecSource[] {
    const node = this.addNode('flow.whileLoop');
    this.connect(node, 'cond', this.expr(stmt.expression));
    this.wireExec(pending, node);
    this.buildLoopBody(node, stmt.statement);
    return [{ node: node.id, pin: 'done' }];
  }

  /** for → forLoop（提升 let 分组 或 for (let i…) 内联两种形态） */
  private buildFor(lets: ts.VariableStatement[], stmt: ts.ForStatement, pending: ExecSource[]): ExecSource[] {
    const node = this.addNode('flow.forLoop');

    /* init：i = <起始>（赋值）或 let i = <起始>；起始表达式延迟求值（只求值一次） */
    let loopVar: string | null = null;
    let fromExpr: ts.Expression | null = null;
    const init = stmt.initializer;
    if (init && ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(init.left)) {
      loopVar = init.left.text;
      fromExpr = init.right;
    } else if (init && ts.isVariableDeclarationList(init) && init.declarations.length === 1) {
      const d = init.declarations[0];
      if (ts.isIdentifier(d.name) && d.initializer) {
        loopVar = d.name.text;
        fromExpr = d.initializer;
      }
    }
    /* 提升 let：优先用其初始化器作起始值 */
    for (const letStmt of lets) {
      const d = letStmt.declarationList.declarations[0];
      if (d && ts.isIdentifier(d.name) && d.initializer) {
        if (!loopVar) loopVar = d.name.text;
        if (d.name.text === loopVar) fromExpr = d.initializer;
      }
    }
    if (loopVar === null || fromExpr === null) {
      throw new FoldSignal('for 循环需要 init 形如「i = <起始>」或「let i = <起始>」');
    }
    this.connect(node, 'from', this.expr(fromExpr));

    /* cond：i <= <结束> / i >= <结束>（forLoop 为闭区间） */
    const cond = stmt.condition;
    if (!cond || !ts.isBinaryExpression(cond) || !ts.isIdentifier(cond.left) || cond.left.text !== loopVar) {
      throw new FoldSignal('for 循环条件需要形如「i <= <结束>」（forLoop 含终点）');
    }
    if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken && cond.operatorToken.kind !== ts.SyntaxKind.GreaterThanEqualsToken) {
      throw new FoldSignal('for 循环条件只支持 <= / >=（forLoop 的终点为闭区间）');
    }
    this.connect(node, 'to', this.expr(cond.right));

    /* update：i += <步长> / i -= <字面量> / i++ / i-- */
    const update = stmt.incrementor;
    if (update) {
      if (ts.isPostfixUnaryExpression(update) && ts.isIdentifier(update.operand) && update.operand.text === loopVar) {
        if (update.operator === ts.SyntaxKind.MinusMinusToken) {
          this.connect(node, 'step', { kind: 'literal', value: -1 });
        }
        // i++：步长保持缺省（= 1）
      } else if (ts.isBinaryExpression(update) && ts.isIdentifier(update.left) && update.left.text === loopVar) {
        if (update.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
          this.connect(node, 'step', this.expr(update.right));
        } else if (update.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) {
          const lit = this.p.exprLiteral(update.right);
          if (!lit.ok) throw new FoldSignal('for 循环负步长只支持字面量（i -= N）');
          this.connect(node, 'step', { kind: 'literal', value: -(lit.value as number) });
        } else {
          throw new FoldSignal('for 循环步进只支持 += / -= / ++');
        }
      } else {
        throw new FoldSignal('for 循环步进需要形如「i += <步长>」');
      }
    }

    this.wireExec(pending, node);
    this.bindScope(loopVar, this.refOf(node, 'index'));
    this.buildLoopBody(node, stmt.statement);
    return [{ node: node.id, pin: 'done' }];
  }

  /** for..of → array.forEach（X.entries() 解构或直接元素） */
  private buildForOf(lets: ts.VariableStatement[], stmt: ts.ForOfStatement, pending: ExecSource[]): ExecSource[] {
    const node = this.addNode('array.forEach');
    /* 迭代对象：X.entries() → 取 X；否则原样 */
    let iterExpr: ts.Expression = stmt.expression;
    if (
      ts.isCallExpression(iterExpr) &&
      ts.isPropertyAccessExpression(iterExpr.expression) &&
      iterExpr.expression.name.text === 'entries' &&
      iterExpr.arguments.length === 0
    ) {
      iterExpr = iterExpr.expression.expression;
    }
    this.connect(node, 'array', this.expr(iterExpr));

    /* 循环变量：const [i, el]（绑定形）/ [i, el]（提升 let 赋值形）/ const el / el */
    const declList = stmt.initializer;
    if (ts.isArrayLiteralExpression(declList)) {
      // 提升 let 形态：for ([i, el] of …) —— 元素是外层 let 的赋值目标
      const els = declList.elements;
      if (els.length !== 2 || !els.every((el) => ts.isIdentifier(el))) {
        throw new FoldSignal('for..of 赋值形解构需要形如 [i, el]（下标, 元素）');
      }
      this.bindScope((els[0] as ts.Identifier).text, this.refOf(node, 'index'));
      this.bindScope((els[1] as ts.Identifier).text, this.refOf(node, 'element'));
    } else if (!ts.isVariableDeclarationList(declList) || declList.declarations.length !== 1) {
      throw new FoldSignal('for..of 需要单个循环变量声明');
    } else {
      const decl = declList.declarations[0];
      if (ts.isArrayBindingPattern(decl.name)) {
        const els = decl.name.elements;
        if (
          els.length !== 2 ||
          !ts.isBindingElement(els[0]) ||
          !ts.isBindingElement(els[1]) ||
          !ts.isIdentifier(els[0].name) ||
          !ts.isIdentifier(els[1].name) ||
          els[0].propertyName ||
          els[1].propertyName
        ) {
          throw new FoldSignal('for..of 解构需要形如 [i, el]（下标, 元素），不支持重命名');
        }
        this.bindScope(els[0].name.text, this.refOf(node, 'index'));
        this.bindScope(els[1].name.text, this.refOf(node, 'element'));
      } else if (ts.isIdentifier(decl.name)) {
        if (decl.initializer) throw new FoldSignal('for..of 循环变量不支持默认值');
        this.bindScope(decl.name.text, this.refOf(node, 'element'));
      } else {
        throw new FoldSignal('for..of 循环变量需要标识符或 [i, el] 解构');
      }
    }
    void lets;

    this.wireExec(pending, node);
    this.buildLoopBody(node, stmt.statement);
    return [{ node: node.id, pin: 'done' }];
  }

  /** 循环体：体尾 if-break 由循环节点 break 引脚接管 */
  private buildLoopBody(loopNode: IRNode, bodyStmt: ts.Statement): void {
    if (ts.isBlock(bodyStmt)) {
      let breakExpr: ts.Expression | null = null;
      const tails = this.buildLoopAwareBody(bodyStmt, [{ node: loopNode.id, pin: 'body' }], (expr) => {
        breakExpr = expr;
      });
      // break 引脚在体构建后接线（体内别名 / 循环变量此时已在作用域）
      if (breakExpr) this.connect(loopNode, 'break', this.expr(breakExpr));
      for (const t of tails) this.connectExec(t, loopNode, 'exec');
      return;
    }
    const bi = this.breakIfOf(bodyStmt);
    if (bi) {
      this.connect(loopNode, 'break', this.expr(bi));
      return;
    }
    const tails = this.buildStatement(bodyStmt, [{ node: loopNode.id, pin: 'body' }], [], -1);
    for (const t of tails) this.connectExec(t, loopNode, 'exec');
  }

  /** `if (X) { break; }` / `if (X) break;` 模式识别（无 else、无标签） */
  private breakIfOf(stmt: ts.Statement): ts.Expression | null {
    if (!ts.isIfStatement(stmt) || stmt.elseStatement) return null;
    if (ts.isBlock(stmt.thenStatement)) {
      const inner = stmt.thenStatement.statements;
      if (inner.length === 1 && ts.isBreakStatement(inner[0]) && !inner[0].label) {
        return stmt.expression;
      }
      return null;
    }
    if (ts.isBreakStatement(stmt.thenStatement) && !stmt.thenStatement.label) return stmt.expression;
    return null;
  }

  /** return → func.return（对象字面量按键展开为返回值引脚） */
  private buildReturn(stmt: ts.ReturnStatement, pending: ExecSource[]): ExecSource[] {
    if (!this.isFunction) {
      throw new FoldSignal('return 仅支持在函数方法内（事件方法让链自然结束即可）');
    }
    const node = this.addNode(TYPE_FUNC_RETURN);
    this.wireExec(pending, node);
    const e = stmt.expression;
    if (!e || e.kind === ts.SyntaxKind.UndefinedKeyword) return [];
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p)) {
          const name = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : null;
          if (name === null) throw new FoldSignal('return 对象的键需要是标识符或字符串字面量');
          this.connect(node, name, this.expr(p.initializer));
        } else if (ts.isShorthandPropertyAssignment(p)) {
          this.connect(node, p.name.text, this.expr(p.name));
        } else {
          throw new FoldSignal('return 对象不支持展开 / 方法属性');
        }
      }
      return [];
    }
    // 非对象返回：单返回值函数的简写形态
    if (this.returns.length === 1) {
      this.connect(node, this.returns[0].name, this.expr(e));
      return [];
    }
    throw new FoldSignal('return 需要对象字面量（键 = 函数返回值名）');
  }

  /** 表达式语句：print / emit / delay / 函数调用 / 赋值 / 纯调用 */
  private buildExpressionStatement(stmt: ts.ExpressionStatement, pending: ExecSource[]): ExecSource[] {
    let e: ts.Expression = stmt.expression;
    if (ts.isAwaitExpression(e)) e = e.expression;

    /* 函数调用语句 */
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      if (ts.isIdentifier(callee)) {
        switch (callee.text) {
          case 'print': {
            if (e.arguments.length !== 1) throw new FoldSignal('print 需要 1 个参数');
            const node = this.addNode('system.print');
            this.connect(node, 'value', this.expr(e.arguments[0]));
            this.wireExec(pending, node);
            return [{ node: node.id, pin: 'exec' }];
          }
          case 'emit': {
            if (e.arguments.length > 2) throw new FoldSignal('emit 最多 2 个参数（事件名, 参数）');
            const node = this.addNode('event.send');
            const nameArg = e.arguments[0] ?? ts.factory.createNull();
            this.connect(node, 'eventName', this.expr(nameArg));
            if (e.arguments.length === 2) this.connect(node, 'args', this.expr(e.arguments[1]));
            this.wireExec(pending, node);
            return [{ node: node.id, pin: 'exec' }];
          }
          case 'delay': {
            const node = this.addNode('flow.delay');
            this.connect(node, 'seconds', this.delaySecondsRef(e.arguments[0]));
            this.wireExec(pending, node);
            return [{ node: node.id, pin: 'done' }];
          }
          case 'onEvent':
            throw new FoldSignal('onEvent 全局调用不受支持——事件监听请使用 @on / @onEvent 方法');
          default:
            break;
        }
      }
      if (this.isThisMethodCall(callee)) {
        const node = this.buildFlowCall(e);
        this.wireExec(pending, node);
        return [{ node: node.id, pin: 'exec' }];
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'ui' &&
        callee.name.text === 'write'
      ) {
        // ui.write(n, attr, v) → 按属性名反查写值节点（visible→setVisible；title→setTitle；
        // 其余 text/value/checked/placeholder/动态属性 → setValue）
        if (e.arguments.length !== 3) throw new FoldSignal('ui.write 需要 3 个参数（节点名, 属性, 值）');
        const attrLit = this.p.exprLiteral(e.arguments[1]);
        const attr = attrLit.ok && typeof attrLit.value === 'string' ? attrLit.value : null;
        let node: IRNode;
        if (attr === 'visible') {
          node = this.addNode('ui.setVisible');
          this.connect(node, 'name', this.expr(e.arguments[0]));
          this.connect(node, 'visible', this.expr(e.arguments[2]));
        } else {
          node = this.addNode(this.uiWriteTypeForAttr(attr));
          this.connect(node, 'name', this.expr(e.arguments[0]));
          this.connect(node, 'attr', this.expr(e.arguments[1]));
          this.connect(node, 'value', this.expr(e.arguments[2]));
        }
        this.wireExec(pending, node);
        return [{ node: node.id, pin: 'exec' }];
      }
      // 其余调用形态按表达式求值（纯调用语句 → 悬空节点，保持往返）
      this.expr(e);
      return pending;
    }

    /* 赋值语句 */
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = e.left;
      if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isIdentifier(target.name)) {
        const node = this.addNode('var.set', { varName: target.name.text });
        this.connect(node, 'value', this.expr(e.right));
        this.wireExec(pending, node);
        return [{ node: node.id, pin: 'exec' }];
      }
      if (ts.isElementAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const nameLit = this.p.exprLiteral(target.argumentExpression);
        if (!nameLit.ok || typeof nameLit.value !== 'string') throw new FoldSignal('this[<键>] 赋值需要字符串字面量键');
        const node = this.addNode('var.set', { varName: nameLit.value });
        this.connect(node, 'value', this.expr(e.right));
        this.wireExec(pending, node);
        return [{ node: node.id, pin: 'exec' }];
      }
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'vars' && ts.isIdentifier(target.name)) {
        const node = this.addNode('var.set', { varName: target.name.text });
        this.connect(node, 'value', this.expr(e.right));
        this.wireExec(pending, node);
        return [{ node: node.id, pin: 'exec' }];
      }
      if (
        ts.isPropertyAccessExpression(target) &&
        ts.isIdentifier(target.name) &&
        ts.isPropertyAccessExpression(target.expression) &&
        ts.isIdentifier(target.expression.expression) &&
        target.expression.expression.text === 'ui'
      ) {
        return this.buildUiWrite(target.expression.name.text, target.name.text, e.right, pending);
      }
      throw new FoldSignal('不支持的赋值目标（受控子集支持 this.<变量> / vars.<变量> / ui.<节点>.<属性>）');
    }

    /* 其他：按表达式求值（悬空纯节点 / 折叠） */
    this.expr(e);
    return pending;
  }

  /**
   * ui 写值属性 → 节点类型反查（attr 值域语义见 src/nodes/ui.ts）：
   * visible → ui.setVisible（显隐节点专用属性）；items → ui.listSetItems（列表项）；
   * title → ui.setTitle（ATTR_TITLE 缺省属性）；其余（text/value/checked/placeholder、
   * 动态属性）→ ui.setValue（ATTR_VALUE 通用写值）。
   */
  private uiWriteTypeForAttr(attr: string | null): string {
    if (attr === 'visible') return 'ui.setVisible';
    if (attr === 'items') return 'ui.listSetItems';
    if (attr === 'title') return 'ui.setTitle';
    return 'ui.setValue';
  }

  /** ui.<节点>.<属性> = v → ui.setValue / ui.setVisible / ui.listSetItems / ui.setTitle */
  private buildUiWrite(nodeName: string, attr: string, valueExpr: ts.Expression, pending: ExecSource[]): ExecSource[] {
    let node: IRNode;
    if (attr === 'visible') {
      node = this.addNode('ui.setVisible');
      this.connect(node, 'name', { kind: 'literal', value: nodeName });
      this.connect(node, 'visible', this.expr(valueExpr));
    } else if (attr === 'items') {
      node = this.addNode('ui.listSetItems');
      this.connect(node, 'name', { kind: 'literal', value: nodeName });
      this.connect(node, 'items', this.expr(valueExpr));
    } else {
      // 按属性名反查节点类型（title → ui.setTitle；其余值域 → ui.setValue；见 uiWriteTypeForAttr）
      node = this.addNode(this.uiWriteTypeForAttr(attr));
      this.connect(node, 'name', { kind: 'literal', value: nodeName });
      this.connect(node, 'attr', { kind: 'literal', value: attr });
      this.connect(node, 'value', this.expr(valueExpr));
    }
    this.wireExec(pending, node);
    return [{ node: node.id, pin: 'exec' }];
  }

  /** 变量声明：__bps 别名 / 调用解构；其余折叠（受控子集无局部变量） */
  private buildVariableStatement(
    stmt: ts.VariableStatement,
    pending: ExecSource[],
    items: BodyItem[],
    index: number,
  ): ExecSource[] {
    const decls = stmt.declarationList.declarations;

    /* 片段接线别名行（T3.7 ADR-007 §3）：尾注释 __bps-snippet-in / -out 标记 */
    if (decls.length === 1) {
      const wire = this.p.trailingSnippetWire(stmt);
      const decl = decls[0];
      if (wire && ts.isIdentifier(decl.name)) {
        if (wire.kind === 'in') {
          // 入脚别名行：初始化器延迟求值（resolveSnippetWirings 统一接线）
          this.pendingSnippetIns.push({
            pin: wire.pin,
            ...(decl.initializer ? { expr: decl.initializer } : {}),
            pos: stmt.getStart(this.sf),
          });
          return pending;
        }
        // 出脚别名行：别名 → 最近片段节点的出脚（初始化器不求值）
        if (!this.lastSnippetNodeId) {
          throw new FoldSignal(`片段出脚标记「${wire.pin}」之前没有对应的片段块`);
        }
        this.bindScope(decl.name.text, { kind: 'node', node: this.lastSnippetNodeId, pin: wire.pin });
        return pending;
      }
    }

    if (decls.length !== 1) throw new FoldSignal('一条声明语句只支持一个声明');
    const decl = decls[0];

    /* 解构接函数返回值：const { rows } = await this.f(...) */
    if (ts.isObjectBindingPattern(decl.name)) {
      const init = decl.initializer;
      const call = init
        ? ts.isAwaitExpression(init)
          ? ts.isCallExpression(init.expression)
            ? init.expression
            : null
          : ts.isCallExpression(init)
            ? init
            : null
        : null;
      if (!call) throw new FoldSignal('解构声明的初始化需要是（await 的）函数调用');
      const node = this.buildFlowCall(call);
      for (const el of decl.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name) || el.propertyName) {
          throw new FoldSignal('解构需要形如 { rows, errs }，不支持重命名');
        }
        this.bindScope(el.name.text, this.refOf(node, el.name.text));
      }
      this.wireExec(pending, node);
      return [{ node: node.id, pin: 'exec' }];
    }
    if (!ts.isIdentifier(decl.name)) throw new FoldSignal('声明名需要是标识符');
    const name = decl.name.text;
    if (!name.startsWith('__bps_')) {
      throw new FoldSignal(`局部变量「${name}」不受支持（受控子集无局部变量；中间值请用节点链表达）`);
    }
    const init = decl.initializer;
    if (!init) throw new FoldSignal('别名声明缺少初始化器');

    /* 别名 = (this.x = expr) → var.set + 透传引脚别名 */
    if (
      ts.isParenthesizedExpression(init) &&
      ts.isBinaryExpression(init.expression) &&
      init.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const assign = init.expression;
      if (
        ts.isPropertyAccessExpression(assign.left) &&
        assign.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(assign.left.name)
      ) {
        const setNode = this.addNode('var.set', { varName: assign.left.name.text });
        this.connect(setNode, 'value', this.expr(assign.right));
        this.wireExec(pending, setNode);
        this.bindScope(name, this.refOf(setNode, 'value'));
        return [{ node: setNode.id, pin: 'exec' }];
      }
      throw new FoldSignal('别名赋值形态需要 this.<变量> = <值>');
    }

    /* 别名 = <expr>; print(<别名>) // __bps-print-passthrough 相邻模式 → print 值出口别名
     *（无尾标记的 print(别名) 是「打印共享纯链」的普通别名形态，不走透传） */
    const next = index >= 0 && index + 1 < items.length ? items[index + 1] : undefined;
    const nextIsPassthroughPrint =
      next &&
      next.kind === 'stmt' &&
      ts.isExpressionStatement(next.stmt) &&
      next.stmt.getText(this.sf).includes('__bps-print-passthrough');
    if (next && nextIsPassthroughPrint && ts.isExpressionStatement(next.stmt)) {
      const ne = next.stmt.expression;
      const call = ts.isCallExpression(ne) ? ne : null;
      if (
        call &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === 'print' &&
        call.arguments.length === 1 &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === name
      ) {
        const printNode = this.addNode('system.print');
        this.connect(printNode, 'value', this.expr(init));
        this.wireExec(pending, printNode);
        this.bindScope(name, this.refOf(printNode, 'value'));
        return [{ node: printNode.id, pin: 'exec' }];
      }
    }

    /* 通用别名：const __bps_vN = <纯链>（不产生执行节点；引用该别名的语句接其引脚） */
    const ref = this.expr(init);
    this.bindScope(name, ref);
    return pending;
  }

  /** 执行流接线（来源端点 → 节点 exec 入） */
  private wireExec(pending: ExecSource[], node: IRNode, pin = 'exec'): void {
    for (const s of pending) this.connectExec(s, node, pin);
  }

  /** this.<fn>(...) 调用形态判定 */
  private isThisMethodCall(callee: ts.Expression): boolean {
    return ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword;
  }

  /** this.<fn>(args) → flow.call（入参按目标函数参数名接线；两遍法：签名已在 pass1 收集） */
  private buildFlowCall(call: ts.CallExpression): IRNode {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) throw new FoldSignal('函数调用需要 this.<函数名>(...) 形态');
    const fnName = callee.name.text;
    const sig = this.p.fnSigs.get(fnName);
    if (!sig) {
      throw new FoldSignal(`未定义的函数「${fnName}」（flow.call 需要同类中已声明的函数方法）`);
    }
    if (call.arguments.length > sig.params.length) {
      throw new FoldSignal(`函数「${fnName}」只接受 ${sig.params.length} 个参数，传入了 ${call.arguments.length} 个`);
    }
    const node = this.addNode(TYPE_FLOW_CALL, { graph: fnName });
    sig.params.forEach((p, i) => {
      const arg = call.arguments[i];
      if (arg !== undefined) this.connect(node, p.name, this.expr(arg));
    });
    return node;
  }

  /** await delay(X)：X*1000 剥离（秒 → 毫秒约定，见 codegen emitDelay） */
  private delaySecondsRef(arg: ts.Expression | undefined): ValueRef {
    if (!arg) throw new FoldSignal('delay 需要 1 个参数');
    if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      // expr * 1000 / 1000 * expr
      const litL = this.p.exprLiteral(arg.left);
      const litR = this.p.exprLiteral(arg.right);
      if (litL.ok && litL.value === 1000) return this.expr(arg.right);
      if (litR.ok && litR.value === 1000) return this.expr(arg.left);
      throw new FoldSignal('delay 的参数需要形如 <秒> * 1000 或字面量毫秒');
    }
    const lit = this.p.exprLiteral(arg);
    if (lit.ok && typeof lit.value === 'number') {
      return { kind: 'literal', value: lit.value / 1000 };
    }
    // 标识符 / 表达式：按秒解释（生成代码恒为字面量毫秒或 ×1000 形态）
    return this.expr(arg);
  }

  /* ============================================================
   * 表达式 → 纯节点树（表达式表反向匹配）
   * ============================================================ */

  private expr(e: ts.Expression): ValueRef {
    switch (e.kind) {
      case ts.SyntaxKind.NumericLiteral:
        return { kind: 'literal', value: Number((e as ts.NumericLiteral).text) };
      case ts.SyntaxKind.StringLiteral:
        return { kind: 'literal', value: (e as ts.StringLiteral).text };
      case ts.SyntaxKind.TrueKeyword:
        return { kind: 'literal', value: true };
      case ts.SyntaxKind.FalseKeyword:
        return { kind: 'literal', value: false };
      case ts.SyntaxKind.NullKeyword:
        return { kind: 'literal', value: null };
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return { kind: 'literal', value: (e as ts.NoSubstitutionTemplateLiteral).text };
      case ts.SyntaxKind.Identifier: {
        const name = (e as ts.Identifier).text;
        if (name === 'undefined') return { kind: 'literal', value: undefined };
        const ref = this.scope.get(name);
        if (ref) return ref;
        throw new FoldSignal(`未解析的标识符「${name}」`);
      }
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.expr((e as ts.ParenthesizedExpression).expression);
      case ts.SyntaxKind.AsExpression:
        return this.expr((e as ts.AsExpression).expression);
      case ts.SyntaxKind.NonNullExpression:
        return this.expr((e as ts.NonNullExpression).expression);
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.propAccess(e as ts.PropertyAccessExpression);
      case ts.SyntaxKind.ElementAccessExpression:
        return this.elemAccess(e as ts.ElementAccessExpression);
      case ts.SyntaxKind.CallExpression:
        return this.callExpr(e as ts.CallExpression);
      case ts.SyntaxKind.TemplateExpression:
        return this.templateExpr(e as ts.TemplateExpression);
      case ts.SyntaxKind.ArrayLiteralExpression:
        return this.arrayLit(e as ts.ArrayLiteralExpression);
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.objectLit(e as ts.ObjectLiteralExpression);
      case ts.SyntaxKind.PrefixUnaryExpression:
        return this.prefixUnary(e as ts.PrefixUnaryExpression);
      case ts.SyntaxKind.BinaryExpression:
        return this.binaryExpr(e as ts.BinaryExpression);
      default:
        throw new FoldSignal(`不支持的表达式形态：${ts.SyntaxKind[e.kind]}`);
    }
  }

  /** 属性访问：this.x / vars.x → var.get；ui.x → ui.get；ui.x.y → ui.getValue；(a).length → string.length */
  private propAccess(e: ts.PropertyAccessExpression): ValueRef {
    const name = e.name.text;
    // 剥掉括号（(x).length 与 x.length 同形；括号在表达式树中透明）
    while (ts.isParenthesizedExpression(e.expression)) {
      e = ts.factory.createPropertyAccessExpression(e.expression.expression, e.name);
    }
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(e.expression) && e.expression.text === 'vars')) {
      const node = this.addNode('var.get', { varName: name });
      return this.refOf(node, 'value');
    }
    if (ts.isIdentifier(e.expression) && e.expression.text === 'ui') {
      if (name === 'find' || name === 'read' || name === 'write') {
        throw new FoldSignal(`ui.${name} 需要以调用形态使用`);
      }
      const node = this.addNode('ui.get', {}, { name });
      return this.refOf(node, 'object');
    }
    if (
      ts.isPropertyAccessExpression(e.expression) &&
      ts.isIdentifier(e.expression.expression) &&
      e.expression.expression.text === 'ui'
    ) {
      const node = this.addNode('ui.getValue', {}, { name: e.expression.name.text, attr: name });
      return this.refOf(node, 'value');
    }
    /* convert.androidLogParse(x).length → count 输出脚（多输出特例：直接调用 / 共享别名两种形态） */
    if (name === 'length') {
      if (ts.isCallExpression(e.expression)) {
        const chain = this.memberChainOf(e.expression.expression);
        if (chain && chain.join('.') === 'convert.androidLogParse') {
          const inner = this.callExpr(e.expression);
          if (inner.kind === 'node' && inner.pin === 'rows') {
            return { kind: 'node', node: inner.node, pin: 'count' };
          }
        }
      } else if (ts.isIdentifier(e.expression)) {
        const ref = this.scope.get(e.expression.text);
        if (ref && ref.kind === 'node' && ref.pin === 'rows') {
          const src = this.nodesRef.get(ref.node);
          if (src && src.type === 'convert.androidLogParse') {
            return { kind: 'node', node: ref.node, pin: 'count' };
          }
        }
      }
    }
    /* 成员属性：.length → string.length */
    const entry = EXPR_TABLE_MAP.get('string.length');
    if (entry && entry.form.kind === 'member' && entry.form.prop === name) {
      const node = this.addNode('string.length');
      this.connect(node, 'value', this.expr(e.expression));
      return this.refOf(node, 'value');
    }
    throw new FoldSignal(`不支持的属性访问「.${name}」`);
  }

  /** 下标访问：this['x'] → var.get；ui['x'] → ui.get；a[i] → array.get */
  private elemAccess(e: ts.ElementAccessExpression): ValueRef {
    const argLit = this.p.exprLiteral(e.argumentExpression);
    if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
      if (!argLit.ok || typeof argLit.value !== 'string') throw new FoldSignal('this[<键>] 需要字符串字面量键');
      const node = this.addNode('var.get', { varName: argLit.value });
      return this.refOf(node, 'value');
    }
    if (ts.isIdentifier(e.expression) && e.expression.text === 'ui') {
      if (!argLit.ok || typeof argLit.value !== 'string') throw new FoldSignal('ui[<名>] 需要字符串字面量');
      const node = this.addNode('ui.get', {}, { name: argLit.value });
      return this.refOf(node, 'object');
    }
    const node = this.addNode('array.get');
    this.connect(node, 'array', this.expr(e.expression));
    this.connect(node, 'index', this.expr(e.argumentExpression));
    return this.refOf(node, 'value');
  }

  /** 调用：bps.* / convert.* / Math.* / format / String/Number/Boolean / ui.find / ui.read / 成员方法 */
  private callExpr(e: ts.CallExpression): ValueRef {
    const callee = e.expression;

    /* 全局函数 */
    if (ts.isIdentifier(callee)) {
      switch (callee.text) {
        case 'format': {
          if (e.arguments.length === 0) throw new FoldSignal('format 需要至少 1 个参数（模板）');
          const node = this.addNode('string.format');
          // 完整实参交给规划器（模板 + multi 参数展开共用同一实参序约定）
          this.fillPlannedArgs(node, specOfType('string.format')!, e.arguments);
          return this.refOf(node, 'value');
        }
        case 'String': {
          const node = this.addNode('convert.toString');
          this.connect(node, 'value', this.singleArg(e));
          return this.refOf(node, 'value');
        }
        case 'Number': {
          const node = this.addNode('convert.toNumber');
          this.connect(node, 'value', this.singleArg(e));
          return this.refOf(node, 'value');
        }
        case 'Boolean': {
          const node = this.addNode('convert.toBool');
          this.connect(node, 'value', this.singleArg(e));
          return this.refOf(node, 'value');
        }
        case 'print':
        case 'emit':
        case 'delay':
        case 'onEvent':
          throw new FoldSignal(`${callee.text} 只能作为独立语句使用`);
        default:
          throw new FoldSignal(`未知函数「${callee.text}」`);
      }
    }

    /* 成员调用 */
    if (ts.isPropertyAccessExpression(callee)) {
      const chain = this.memberChainOf(callee);
      if (chain) {
        const chainText = chain.map((x) => x.text).join('.');
        const bpsTarget = nodeIdFromBpsCallee(chain.map((x) => x.text));
        if (bpsTarget) return this.buildBpsCall(bpsTarget, e);
        if (EXPR_TABLE_MAP.has(chainText) && chainText.startsWith('convert.')) {
          return this.buildPlannedCall(chainText, e);
        }
        if (chainText === 'Date.now') {
          return this.refOf(this.addNode('system.now'), 'epoch');
        }
        const mathMap: Record<string, string> = {
          'Math.floor': 'math.floor',
          'Math.ceil': 'math.ceil',
          'Math.round': 'math.round',
          'Math.min': 'math.min',
          'Math.max': 'math.max',
          'Math.abs': 'math.abs',
        };
        if (mathMap[chainText]) return this.buildPlannedCall(mathMap[chainText], e);
      }

      /* ui.find(n) / ui.read(n, attr) */
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'ui') {
        if (callee.name.text === 'find') {
          if (e.arguments.length !== 1) throw new FoldSignal('ui.find 需要 1 个参数');
          const node = this.addNode('ui.get');
          this.connect(node, 'name', this.expr(e.arguments[0]));
          return this.refOf(node, 'object');
        }
        if (callee.name.text === 'read') {
          if (e.arguments.length !== 2) throw new FoldSignal('ui.read 需要 2 个参数（节点名, 属性）');
          const node = this.addNode('ui.getValue');
          this.connect(node, 'name', this.expr(e.arguments[0]));
          this.connect(node, 'attr', this.expr(e.arguments[1]));
          return this.refOf(node, 'value');
        }
      }

      /* 成员方法：includes / trim / toUpperCase / toLowerCase / split / replace */
      const method = callee.name.text;
      const methodMap: Record<string, string> = {
        includes: 'string.contains',
        trim: 'string.trim',
        toUpperCase: 'string.upper',
        toLowerCase: 'string.lower',
      };
      if (methodMap[method]) {
        const node = this.addNode(methodMap[method]);
        this.connect(node, 'value', this.expr(callee.expression));
        if (method === 'includes') {
          if (e.arguments.length !== 1) throw new FoldSignal('includes 需要 1 个参数');
          this.connect(node, 'search', this.expr(e.arguments[0]));
        } else if (e.arguments.length !== 0) {
          throw new FoldSignal(`${method} 不接受参数`);
        }
        return this.refOf(node, 'value');
      }
      if (method === 'split' || method === 'replace') {
        // 便捷形态（codegen 恒发 bps 形态；此处为手写便利）
        const nodeId = method === 'split' ? 'string.split' : 'string.replace';
        const node = this.addNode(nodeId);
        this.connect(node, 'value', this.expr(callee.expression));
        e.arguments.forEach((a, i) => {
          const pin = nodeId === 'string.split' ? (i === 0 ? 'sep' : null) : i === 0 ? 'from' : i === 1 ? 'to' : null;
          if (pin) this.connect(node, pin, this.expr(a));
        });
        return this.refOf(node, 'value');
      }
      if (method === 'entries') {
        throw new FoldSignal('entries() 仅用于 for..of 循环');
      }
      throw new FoldSignal(`不支持的成员调用「${callee.getText(this.sf)}」`);
    }

    throw new FoldSignal('不支持的调用形态');
  }

  /** 成员访问链（如 ['Math','floor']；非纯标识符链返回 null） */
  private memberChainOf(e: ts.Expression): ts.Identifier[] | null {
    const parts: ts.Identifier[] = [];
    let cur: ts.Expression = e;
    while (ts.isPropertyAccessExpression(cur)) {
      if (!ts.isIdentifier(cur.name)) return null;
      parts.unshift(cur.name);
      cur = cur.expression;
    }
    if (!ts.isIdentifier(cur)) return null;
    parts.unshift(cur);
    return parts;
  }

  /** bps.<id>(...) → 节点（实参按 callArgPlan 位置填充：数据引脚 + 检视器参数） */
  private buildBpsCall(nodeId: string, e: ts.CallExpression): ValueRef {
    const spec = specOfType(nodeId);
    if (!spec) {
      throw new FoldSignal(`未知的 bps 节点「${nodeId}」（节点库中不存在）`);
    }
    const node = this.addNode(nodeId);
    this.fillPlannedArgs(node, spec, e.arguments);
    return this.refOf(node, this.primaryOutPin(nodeId));
  }

  /** convert.* / Math.* 等表达式表调用 */
  private buildPlannedCall(nodeId: string, e: ts.CallExpression): ValueRef {
    const spec = specOfType(nodeId);
    if (!spec) throw new FoldSignal(`未知节点「${nodeId}」`);
    const node = this.addNode(nodeId);
    this.fillPlannedArgs(node, spec, e.arguments);
    return this.refOf(node, this.primaryOutPin(nodeId));
  }

  /** 表达式表节点的求值输出引脚（表外 = 第一个数据输出脚） */
  private primaryOutPin(nodeId: string): string {
    const entry = EXPR_TABLE_MAP.get(nodeId);
    if (entry) return entry.outPin;
    const spec = specOfType(nodeId);
    const firstData = (spec?.outputs ?? []).find((p) => p.type !== 'exec');
    return firstData ? firstData.id : 'value';
  }

  /** 实参按规划填充：数据引脚（multi 引脚吃掉余下全部实参）→ 检视器参数（仅字面量） */
  private fillPlannedArgs(node: IRNode, spec: NodeSpec, args: readonly ts.Expression[]): void {
    const plan = callArgPlan(spec);
    let argIdx = 0;
    for (const item of plan) {
      if (argIdx >= args.length) break;
      if (item.kind === 'pin') {
        if (item.multi) {
          const rest = args.slice(argIdx);
          const lits = rest.map((a) => this.p.exprLiteral(a));
          if (rest.length > 0 && lits.every((l) => l.ok)) {
            // 全字面量实参 → multi 引脚的内联数组默认值
            node.pinDefaults[item.id] = lits.map((l) => l.value);
          } else if (lits.some((l) => l.ok)) {
            // 混合（字面量 + 表达式）：字面量无法作连线端点，用 array.make 承载
            const mk = this.addNode('array.make');
            rest.forEach((a, i) => this.connect(mk, `in${i}`, this.expr(a)));
            this.addEdge({ node: mk.id, pin: 'array' }, { node: node.id, pin: item.id }, 'data');
          } else {
            for (const a of rest) this.connect(node, item.id, this.expr(a));
          }
          argIdx = args.length;
          break;
        }
        this.connect(node, item.id, this.expr(args[argIdx]));
        argIdx += 1;
      } else {
        const lit = this.p.exprLiteral(args[argIdx]);
        if (!lit.ok) throw new FoldSignal(`检视器参数「${item.id}」只接受字面量（参数不走连线）`);
        node.params[item.id] = lit.value;
        argIdx += 1;
      }
    }
    if (argIdx < args.length) {
      throw new FoldSignal(`实参数量超出节点「${node.type}」的声明`);
    }
  }

  private singleArg(e: ts.CallExpression): ValueRef {
    if (e.arguments.length !== 1) throw new FoldSignal('需要恰好 1 个参数');
    return this.expr(e.arguments[0]);
  }

  /** 模板字符串 → string.concat 左折叠（literal 部件落 pinDefaults，表达式部件落连线） */
  private templateExpr(e: ts.TemplateExpression): ValueRef {
    const parts: ValueRef[] = [];
    if (e.head.text !== '') parts.push({ kind: 'literal', value: e.head.text });
    for (const span of e.templateSpans) {
      parts.push(this.expr(span.expression));
      if (span.literal.text !== '') parts.push({ kind: 'literal', value: span.literal.text });
    }
    if (parts.length === 0) return { kind: 'literal', value: '' };
    let cur: ValueRef = parts[0];
    for (let i = 1; i < parts.length; i += 1) {
      const node = this.addNode('string.concat');
      this.connect(node, 'a', cur);
      this.connect(node, 'b', parts[i]);
      cur = this.refOf(node, 'value');
    }
    return cur;
  }

  /** 数组字面量 → array.make（最多 5 个；元素可为任意求值结果） */
  private arrayLit(e: ts.ArrayLiteralExpression): ValueRef {
    if (e.elements.length > 5) {
      throw new FoldSignal('数组字面量最多 5 个元素（array.make 引脚限制）');
    }
    const node = this.addNode('array.make');
    e.elements.forEach((el, i) => {
      if (ts.isSpreadElement(el)) throw new FoldSignal('数组字面量不支持展开');
      this.connect(node, `in${i}`, this.expr(el));
    });
    return this.refOf(node, 'array');
  }

  /** 对象字面量：全字面量 → 字面量；否则 → map.set 左折叠链 */
  private objectLit(e: ts.ObjectLiteralExpression): ValueRef {
    const lit = this.p.exprLiteral(e);
    if (lit.ok) return { kind: 'literal', value: lit.value };
    let cur: ValueRef = { kind: 'literal', value: {} };
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p)) {
        const key = ts.isIdentifier(p.name) ? p.name.text : ts.isStringLiteral(p.name) ? p.name.text : null;
        if (key === null) throw new FoldSignal('对象字面量的键需要是标识符或字符串');
        const setNode = this.addNode('map.set');
        this.connect(setNode, 'map', cur);
        this.connect(setNode, 'key', { kind: 'literal', value: key });
        this.connect(setNode, 'value', this.expr(p.initializer));
        cur = this.refOf(setNode, 'map');
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const setNode = this.addNode('map.set');
        this.connect(setNode, 'map', cur);
        this.connect(setNode, 'key', { kind: 'literal', value: p.name.text });
        this.connect(setNode, 'value', this.expr(p.name));
        cur = this.refOf(setNode, 'map');
      } else {
        throw new FoldSignal('对象字面量不支持展开 / 方法属性');
      }
    }
    return cur;
  }

  /** 一元运算：!a → math.not；-<数字字面量> → 字面量 */
  private prefixUnary(e: ts.PrefixUnaryExpression): ValueRef {
    if (e.operator === ts.SyntaxKind.ExclamationToken) {
      const node = this.addNode('math.not');
      this.connect(node, 'a', this.expr(e.operand));
      return this.refOf(node, 'value');
    }
    if (e.operator === ts.SyntaxKind.MinusToken) {
      const lit = this.p.exprLiteral(e.operand);
      if (lit.ok && typeof lit.value === 'number') return { kind: 'literal', value: -lit.value };
      throw new FoldSignal('一元负号只支持数字字面量');
    }
    throw new FoldSignal(`不支持的一元运算符：${ts.SyntaxKind[e.operator]}`);
  }

  /** 二元运算 → 表达式表节点（=== / !== 归一为 == / !=） */
  private binaryExpr(e: ts.BinaryExpression): ValueRef {
    const rawOp = e.operatorToken.getText();
    const op = rawOp === '===' ? '==' : rawOp === '!==' ? '!=' : rawOp;
    const arithmetic: Record<string, string> = {
      '+': 'math.add',
      '-': 'math.sub',
      '*': 'math.mul',
      '/': 'math.div',
      '%': 'math.mod',
    };
    if (arithmetic[op]) {
      const node = this.addNode(arithmetic[op]);
      this.connect(node, 'a', this.expr(e.left));
      this.connect(node, 'b', this.expr(e.right));
      return this.refOf(node, 'value');
    }
    if (['>', '>=', '<', '<=', '==', '!='].includes(op)) {
      const node = this.addNode('math.compare', { op });
      this.connect(node, 'a', this.expr(e.left));
      this.connect(node, 'b', this.expr(e.right));
      return this.refOf(node, 'value');
    }
    if (op === '&&' || op === '||') {
      const node = this.addNode(op === '&&' ? 'math.and' : 'math.or');
      this.connect(node, 'a', this.expr(e.left));
      this.connect(node, 'b', this.expr(e.right));
      return this.refOf(node, 'value');
    }
    throw new FoldSignal(`不支持的运算符「${rawOp}」`);
  }
}
