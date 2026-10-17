/**
 * Blueprint Studio v2 —— 片段引脚契约与推导纯函数（T3.7，ADR-007）
 *
 * 本文件是片段（IRSnippet / IRSnippetPin）在「互转 + 运行时 + 视图」三侧共用的纯函数层：
 *  1. exec 引脚约定判定：pins 含 exec 入 → 执行片段（链上语句）；完全无 exec 引脚 →
 *     纯片段（数据引脚求值，pure 语义）。仅声明 exec 出（无 exec 入）的片段无法进入
 *     执行链，codegen 抛错（见 ADR-007 §3）。
 *  2. 引脚推导（parser 折叠初稿用）：基于 ts.createSourceFile 的标识符级分析——
 *    外部读取 → in 引脚；裸赋值目标 / return 值 → out 引脚；环境全局与局部声明排除；
 *    this.X / vars.X 读写规则见 ADR-007 §2。
 *  3. 片段 spec 合成：视图渲染（model.ts）、编辑器校验/搜索/连线（面板合并进
 *    store.specs）、运行时注入（snippet-runtime.ts）共用的 NodeSpec 形状来源。
 *
 * 依赖纪律：只 import ir/types 与 typescript（devDependency），不 import 节点库 /
 * React / codegen，保证三侧（含 node:test）都可加载。
 */
import ts from 'typescript';
import type {
  IRAsset,
  IRSnippet,
  IRSnippetPin,
  IRValueType,
  NodeSpec,
  PinSpec,
} from '../ir/types';
import { SNIPPET_NODE_TYPE, isSafeIdentifier } from './codegen-common';

export { SNIPPET_NODE_TYPE };
/* ============================================================
 * 1. exec 引脚约定（ADR-007 §1）
 * ============================================================ */

/** 运行时局部视图中纯片段节点的改写 type（仅 injectSnippetRuntime 的资产副本内） */
export const SNIPPET_PURE_TYPE = 'script.snippet.pure';

/** 片段是否声明 exec 入脚（有即执行片段，可进入 exec 链） */
export function snippetHasExecIn(pins: readonly IRSnippetPin[]): boolean {
  return pins.some((p) => p && p.dir === 'in' && p.type === 'exec');
}

/** 片段的第一个 exec 出脚（链续接出口；无则 null） */
export function snippetExecOut(pins: readonly IRSnippetPin[]): IRSnippetPin | null {
  return pins.find((p) => p && p.dir === 'out' && p.type === 'exec') ?? null;
}

/** 纯片段判定：完全无 exec 引脚（数据引脚求值；仅 exec 出的片段不算纯——无法进链，codegen 抛错） */
export function snippetIsPure(pins: readonly IRSnippetPin[]): boolean {
  return !pins.some((p) => p && p.type === 'exec');
}

/** 片段节点标题：片段：<id 前 8 位>（蓝图节点头） */
export function snippetTitle(id: string): string {
  return `片段：${(id || '').slice(0, 8) || '未命名'}`;
}

/** 在既有 id 集合约束下分配不重名的片段 id（snip1、snip2…；与 parser 折叠序号同风格） */
export function uniqueSnippetId(existing: readonly string[]): string {
  const used = new Set(existing);
  let n = 1;
  while (used.has(`snip${n}`)) n += 1;
  return `snip${n}`;
}

/** 片段引脚校验（合法标识符 + 不与运行时环境全局重名）；返回 null = 合法，否则为中文原因 */
export function snippetPinIssue(pin: IRSnippetPin): string | null {
  if (!isSafeIdentifier(pin.id)) {
    return `引脚 id「${pin.id}」不是合法的 JS 标识符（运行时按名注入，请改用字母/数字/下划线且不以数字开头、不用保留字）`;
  }
  if (RUNTIME_RESERVED_NAMES.has(pin.id)) {
    return `引脚 id「${pin.id}」与运行时环境全局重名（保留名：${[...RUNTIME_RESERVED_NAMES].join('、')}）`;
  }
  return null;
}

/** 运行时环境全局名单（T3.2 createScriptGlobals 的 10 项；引脚 id 不得与之重名） */
export const RUNTIME_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'ui', 'vars', 'emit', 'onEvent', 'plugins', 'print', 'convert', 'format', 'delay',
]);

/* ============================================================
 * 2. 引脚推导（标识符级分析；ADR-007 §2）
 * ============================================================ */

/** 片段代码分析结果（推导初稿；类型恒 any，实际类型由作者在编辑器中声明） */
export interface SnippetCodeAnalysis {
  /** in 引脚（外部读取；按首次出现序） */
  inPins: { id: string; type: IRValueType }[];
  /** out 引脚（裸赋值目标 / return 值；按首次出现序） */
  outPins: { id: string; type: IRValueType }[];
  /** 代码体是否含 await（运行时编译形态提示） */
  awaits: boolean;
}

/**
 * 环境全局（不推导为引脚）：JS 内建全局 ∪ T3.2 内建 API 全局 ∪ 互转兜底命名空间。
 * 片段代码可直接使用这些名字，运行时经环境注入。
 */
const AMBIENT_GLOBALS: ReadonlySet<string> = new Set([
  // JS 内建
  'Math', 'JSON', 'Date', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Symbol', 'Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'globalThis', 'undefined', 'NaN', 'Infinity', 'arguments', 'this',
  // T3.2 内建 API 全局 + 互转兜底
  ...RUNTIME_RESERVED_NAMES,
  'bps',
]);

/** 赋值类二元运算符（目标 = 写入；复合运算符同时是读取） */
const ASSIGNMENT_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * 标识符遍历器：收集读取 / 写入 / await。
 * name 位置（成员访问、属性键、形参、声明名、标签、导入）不误报；局部声明名从 in 集排除。
 */
class SnippetWalker {
  private readonly reads = new Set<string>();
  private readonly writes = new Set<string>();
  private readonly locals = new Set<string>();
  /** 全部引用名（首次出现序，读写共序） */
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();
  /** 嵌套函数深度（其 return 是局部返回，不推导 out；赋值经闭包仍成立） */
  private fnDepth = 0;

  constructor(private readonly out: SnippetCodeAnalysis) {}

  /** 记录一次引用（in = 读取 / out = 写入） */
  private ref(name: string, dir: 'in' | 'out'): void {
    if (name === '' || AMBIENT_GLOBALS.has(name) || name === 'exec') return;
    (dir === 'in' ? this.reads : this.writes).add(name);
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.order.push(name);
    }
  }

  /** 绑定名（形参 / 声明 / 解构 / catch）→ 局部名 */
  private declareBinding(name: ts.BindingName): void {
    if (ts.isIdentifier(name)) {
      this.locals.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) this.declareBinding(el.name);
    }
  }

  visit(node: ts.Node): void {
    switch (node.kind) {
      /* ---------- 声明：登记局部名 ---------- */
      case ts.SyntaxKind.VariableDeclaration: {
        const d = node as ts.VariableDeclaration;
        this.declareBinding(d.name);
        if (d.initializer) this.visit(d.initializer);
        return;
      }
      case ts.SyntaxKind.Parameter: {
        const p = node as ts.ParameterDeclaration;
        this.declareBinding(p.name);
        if (p.initializer) this.visit(p.initializer);
        return;
      }
      case ts.SyntaxKind.FunctionDeclaration: {
        const f = node as ts.FunctionDeclaration;
        if (f.name) this.locals.add(f.name.text);
        for (const p of f.parameters) this.declareBinding(p.name);
        if (f.body) {
          this.fnDepth += 1;
          this.visit(f.body);
          this.fnDepth -= 1;
        }
        return;
      }
      case ts.SyntaxKind.ClassDeclaration: {
        const c = node as ts.ClassDeclaration;
        if (c.name) this.locals.add(c.name.text);
        // 类体成员名不读：方法体的 return 是局部返回（fnDepth 隔离）
        for (const member of c.members) {
          if (ts.isMethodDeclaration(member) && member.body) {
            for (const p of member.parameters) this.declareBinding(p.name);
            this.fnDepth += 1;
            this.visit(member.body);
            this.fnDepth -= 1;
          } else {
            this.visit(member);
          }
        }
        return;
      }
      case ts.SyntaxKind.CatchClause: {
        const c = node as ts.CatchClause;
        if (c.variableDeclaration) this.declareBinding(c.variableDeclaration.name);
        this.visit(c.block);
        return;
      }
      case ts.SyntaxKind.PropertyDeclaration: {
        const d = node as ts.PropertyDeclaration;
        if (ts.isIdentifier(d.name)) this.locals.add(d.name.text);
        if (d.initializer) this.visit(d.initializer);
        return;
      }
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction: {
        const f = node as ts.FunctionLikeDeclaration;
        for (const p of f.parameters) this.declareBinding(p.name);
        if (f.body) {
          this.fnDepth += 1;
          this.visit(f.body);
          this.fnDepth -= 1;
        }
        return;
      }
      /* ---------- 名称位置：跳过成员名 / 属性键 / 导入 / 标签 ---------- */
      case ts.SyntaxKind.PropertyAssignment: {
        const p = node as ts.PropertyAssignment;
        if (ts.isComputedPropertyName(p.name)) this.visit(p.name);
        this.visit(p.initializer);
        return;
      }
      case ts.SyntaxKind.ShorthandPropertyAssignment: {
        // { a }：短属性名是一次读取（运行时同形）
        const p = node as ts.ShorthandPropertyAssignment;
        if (ts.isIdentifier(p.name)) this.ref(p.name.text, 'in');
        if (p.objectAssignmentInitializer) this.visit(p.objectAssignmentInitializer);
        return;
      }
      case ts.SyntaxKind.SpreadAssignment:
        this.visit((node as ts.SpreadAssignment).expression);
        return;
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.LabeledStatement:
        return; // 导入 / 标签不产生引脚引用
      /* ---------- await 检测 ---------- */
      case ts.SyntaxKind.AwaitExpression:
        this.out.awaits = true;
        this.visit((node as ts.AwaitExpression).expression);
        return;
      case ts.SyntaxKind.ForOfStatement: {
        const f = node as ts.ForOfStatement;
        if (f.awaitModifier) this.out.awaits = true;
        if (ts.isVariableDeclarationList(f.initializer)) {
          for (const d of f.initializer.declarations) this.declareBinding(d.name);
        } else {
          this.visitAssignTarget(f.initializer as unknown as ts.Expression, true);
        }
        this.visit(f.expression);
        this.visit(f.statement);
        return;
      }
      /* ---------- return → out 引脚（嵌套函数内的 return 是局部返回，不推导） ---------- */
      case ts.SyntaxKind.ReturnStatement: {
        const r = node as ts.ReturnStatement;
        const e = r.expression;
        if (this.fnDepth > 0) {
          if (e) this.visit(e);
          return;
        }
        if (!e || e.kind === ts.SyntaxKind.UndefinedKeyword || e.kind === ts.SyntaxKind.VoidKeyword) return;
        if (ts.isObjectLiteralExpression(e)) {
          // return { a, b } → out 引脚 a、b（与运行时出脚映射一致）
          for (const prop of e.properties) {
            if (ts.isPropertyAssignment(prop)) {
              if (ts.isIdentifier(prop.name)) this.ref(prop.name.text, 'out');
              else if (ts.isComputedPropertyName(prop.name)) this.visit(prop.name);
              this.visit(prop.initializer);
            } else if (ts.isShorthandPropertyAssignment(prop)) {
              if (ts.isIdentifier(prop.name)) {
                this.ref(prop.name.text, 'out');
                this.ref(prop.name.text, 'in');
              }
            } else if (ts.isSpreadAssignment(prop)) {
              this.visit(prop.expression);
            }
          }
          return;
        }
        this.ref('result', 'out');
        this.visit(e);
        return;
      }
      /* ---------- 赋值目标 ---------- */
      case ts.SyntaxKind.BinaryExpression: {
        const b = node as ts.BinaryExpression;
        if (ASSIGNMENT_TOKENS.has(b.operatorToken.kind)) {
          this.visitAssignTarget(b.left, b.operatorToken.kind !== ts.SyntaxKind.EqualsToken);
          this.visit(b.right);
          return;
        }
        ts.forEachChild(node, (child) => this.visit(child));
        return;
      }
      case ts.SyntaxKind.PostfixUnaryExpression:
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression;
        if (u.operator === ts.SyntaxKind.PlusPlusToken || u.operator === ts.SyntaxKind.MinusMinusToken) {
          this.visitAssignTarget(u.operand, true);
          return;
        }
        ts.forEachChild(node, (child) => this.visit(child));
        return;
      }
      /* ---------- 属性访问：this.X / vars.X 读取；成员名跳过 ---------- */
      case ts.SyntaxKind.PropertyAccessExpression: {
        const e = node as ts.PropertyAccessExpression;
        const root = this.memberRootOf(e);
        if (root === 'this' || root === 'vars') {
          // this.X / vars.X：一级属性名 = 变量读取（in 引脚）；更深层成员名跳过
          const first = this.firstMemberName(e);
          if (first) this.ref(first, 'in');
          return;
        }
        this.visit(e.expression); // 根标识符照常记录（foo.bar → 读 foo）
        return; // 成员名不记
      }
      /* ---------- 裸标识符：读取（默认路径；name 位置已由上方 case 拦截） ---------- */
      case ts.SyntaxKind.Identifier:
        this.ref((node as ts.Identifier).text, 'in');
        return;
      default:
        ts.forEachChild(node, (child) => this.visit(child));
    }
  }

  /** 赋值目标：裸标识符 = out 引脚（复合再计读）；this./vars. 目标 = 变量副作用（不推导） */
  private visitAssignTarget(target: ts.Expression, alsoRead: boolean): void {
    if (ts.isIdentifier(target)) {
      this.ref(target.text, 'out');
      if (alsoRead) this.ref(target.text, 'in');
      return;
    }
    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      if (ts.isPropertyAccessExpression(target)) {
        const root = this.memberRootOf(target);
        if ((root === 'this' || root === 'vars') && alsoRead) {
          const first = this.firstMemberName(target);
          if (first) this.ref(first, 'in');
        }
      }
      return; // 变量 / 对象属性副作用，非片段输出（ADR-007 §2）
    }
    if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
      // 解构赋值目标 [a, b] = …：元素按裸目标处理
      for (const child of target.getChildren()) {
        if (ts.isIdentifier(child)) {
          this.ref(child.text, 'out');
          if (alsoRead) this.ref(child.text, 'in');
        } else {
          this.visit(child);
        }
      }
      return;
    }
    this.visit(target);
  }

  /** 成员链根：'this' / 'vars' / 其他标识符文本（null = 非标识符根） */
  private memberRootOf(e: ts.PropertyAccessExpression): string | null {
    let cur: ts.Expression = e.expression;
    while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
    if (cur.kind === ts.SyntaxKind.ThisKeyword) return 'this';
    if (ts.isIdentifier(cur)) return cur.text;
    return null;
  }

  /** 成员链第一级属性名（this.a.b → 'a'） */
  private firstMemberName(e: ts.PropertyAccessExpression): string | null {
    let cur: ts.PropertyAccessExpression = e;
    while (ts.isPropertyAccessExpression(cur.expression)) cur = cur.expression;
    return ts.isIdentifier(cur.name) ? cur.name.text : null;
  }

  /** 收口：排除局部名后按首次出现序输出 */
  finish(): void {
    for (const name of this.order) {
      if (this.locals.has(name)) continue;
      if (this.reads.has(name)) this.out.inPins.push({ id: name, type: 'any' });
      if (this.writes.has(name)) this.out.outPins.push({ id: name, type: 'any' });
    }
  }
}

/** 分析 AST 节点并收口（内部共用） */
function analyzeNode(root: ts.Node): SnippetCodeAnalysis {
  const result: SnippetCodeAnalysis = { inPins: [], outPins: [], awaits: false };
  const walker = new SnippetWalker(result);
  walker.visit(root);
  walker.finish();
  return result;
}

/** 片段代码分析（文本入口）：包一层与运行时同构的 async 函数壳后遍历（return 语义一致） */
export function analyzeSnippetCode(code: string): SnippetCodeAnalysis {
  const wrapped = `async function __bps_wrap() {\n${code}\n}`;
  const sf = ts.createSourceFile('snippet.ts', wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === '__bps_wrap',
  );
  if (!fn?.body) return { inPins: [], outPins: [], awaits: false };
  return analyzeNode(fn.body);
}

/** 片段代码分析（AST 节点入口；parser 折叠时直接分析语句/成员节点，避免二次解析） */
export function analyzeSnippetNode(root: ts.Node): SnippetCodeAnalysis {
  return analyzeNode(root);
}

/**
 * 引脚推导（ADR-007 §2）：外部引用 → in；裸赋值目标 / return 值 → out。
 * execSkeleton = true 时前置 exec 入/出骨架引脚（语句级折叠：片段留在 exec 链中）。
 */
export function deriveSnippetPins(code: string, opts?: { execSkeleton?: boolean }): IRSnippetPin[] {
  const { inPins, outPins } = analyzeSnippetCode(code);
  const pins: IRSnippetPin[] = [];
  if (opts?.execSkeleton) {
    pins.push({ id: 'exec', dir: 'in', type: 'exec' }, { id: 'exec', dir: 'out', type: 'exec' });
  }
  for (const p of inPins) pins.push({ id: p.id, dir: 'in', type: 'any' });
  for (const p of outPins) pins.push({ id: p.id, dir: 'out', type: 'any' });
  return pins;
}

/* ============================================================
 * 3. 片段 spec 合成（视图 / 编辑器 / 运行时共用形状）
 * ============================================================ */

/** IRSnippetPin → PinSpec（引脚声明与节点库引脚同构） */
export function snippetPinToSpec(pin: IRSnippetPin): PinSpec {
  const spec: PinSpec = { id: pin.id, type: pin.type };
  if (typeof pin.label === 'string' && pin.label !== '') spec.label = pin.label;
  return spec;
}

/**
 * 按引脚声明合成片段节点的 NodeSpec（ADR-007 §5）：
 * 标题 `片段：<id 前 8 位>`、分类「脚本片段」、pure = 完全无 exec 引脚。
 * 视图渲染、编辑器校验/搜索/连线、运行时注入三方共用，保证形状一致。
 */
export function snippetSpecFromPins(id: string, pins: readonly IRSnippetPin[]): NodeSpec {
  const list = (pins ?? []).filter((p): p is IRSnippetPin => !!p && typeof p.id === 'string');
  return {
    id: SNIPPET_NODE_TYPE,
    title: snippetTitle(id),
    category: '脚本片段',
    keywords: ['snippet', '片段', '脚本片段', '脚本', id],
    inputs: list.filter((p) => p.dir === 'in').map(snippetPinToSpec),
    outputs: list.filter((p) => p.dir === 'out').map(snippetPinToSpec),
    params: [{ id: 'snippet', label: '片段 id', type: 'string', default: '' }],
    pure: snippetIsPure(list),
    doc: '脚本片段节点：保留原生源码 + 声明式引脚。双击节点展开源码与引脚编辑；数据引脚按声明连线，声明 exec 入/出时成为执行节点。',
  };
}

/**
 * 按资产合成「并集」片段 spec（编辑器校验 / 连线用；spec 按类型唯一，引脚取资产全部片段的并集）。
 * 纯片段与执行片段并存时校验侧有 dangling-exec 误报 warning 的残留（ADR-007 §5 已知边界）。
 */
export function snippetSpecForAsset(asset: IRAsset): NodeSpec {
  const snippets = asset?.snippets ?? [];
  const seen = new Set<string>();
  const union: IRSnippetPin[] = [];
  for (const s of snippets) {
    for (const p of s.pins ?? []) {
      if (!p || typeof p.id !== 'string') continue;
      const key = `${p.dir}\u0000${p.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      union.push(p);
    }
  }
  const base = snippetSpecFromPins('', union);
  // 并集 spec 不判 pure（union 混入 exec 引脚时 pure 会触发 exec-through-pure 误报）
  return { ...base, pure: false };
}

/** base specs 合并片段 spec（不改入参；面板挂载 / 资产变化时调用，T6.4 注入被覆盖后重合） */
export function withSnippetSpecs(
  base: ReadonlyMap<string, NodeSpec>,
  asset: IRAsset,
): Map<string, NodeSpec> {
  const merged = new Map(base);
  merged.set(SNIPPET_NODE_TYPE, snippetSpecForAsset(asset));
  return merged;
}

/** 从资产查片段（找不到返回 null） */
export function snippetOfAsset(asset: IRAsset | null | undefined, id: unknown): IRSnippet | null {
  if (typeof id !== 'string' || id === '' || !asset) return null;
  return (asset.snippets ?? []).find((s) => s.id === id) ?? null;
}
