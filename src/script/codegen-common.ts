/**
 * Blueprint Studio v2 —— 脚本互转共享契约（T3.5 Codegen ⇄ T3.6 Parser 共用）
 *
 * 本文件只放两卡共用的常量、映射表与纯函数，保证「生成什么就解析什么」自洽：
 *  1. 片段节点挂接约定（T3.7 正式定案前的最小约定）：
 *     图中节点 type = 'script.snippet'，params.snippet = IRSnippet.id；
 *     片段源码在生成脚本中以 __bps-snippet-begin/end 注释标记对原样保留，
 *     begin 行尾携带 { lang, pins } 元数据 JSON（pins 往返无损）；
 *     无节点引用的「孤儿片段」以 __bps-loose-begin/end 标记对落在 class 之外；
 *     解析器折叠不可映射语句时生成 pins=[exec 入, exec 出] 的最小骨架片段。
 *  2. 图级操作节点（解释器自有类型，见 src/runtime/interpreter）：flow.call /
 *     func.entry / func.return（flow.entry / flow.return 为等价 id，互转一律
 *     规范化为 func.*）。互转侧不 import graph-op-specs（其内部走 @/ 别名），
 *     此处只声明 codegen / parser 需要的最小引脚骨架。
 *  3. 纯节点表达式映射表 EXPR_TABLE：codegen 正向合成、parser 反向匹配共用同一份
 *     条目；表外纯节点统一走 bps.* 兜底调用，命名规则 bps.X.Y ↔ 节点 id 'X.Y'。
 *  4. IRValueType ↔ TS 注解映射：int / 自定义别名无法从 TS 注解往返，以行内注释
 *     「@bps <irType>」兜底携带（解析时注释优先于注解推断）。
 *  5. 调用形态实参规划：数据引脚序（跳过 exec）+ 检视器参数序；缺省尾参可省略。
 *  6. spec 默认值剥离：解析器把「与 PinSpec.defaultValue / ParamSpec.default 相等」
 *     的字面量 pinDefaults / params 视为缺省（codegen 对缺省引脚总是发射有效字面量，
 *     剥离规则保证两端对「显式默认值」达成一致的规范形——显式写出且等于默认值的
 *     引脚值会在一次往返后归一化为缺省，语义不变）。
 */
import type { IRNode, NodeSpec, PinSpec } from '../ir/types';
import { builtinSpecMap } from '../nodes';

/* ============================================================
 * 1. 片段节点（IRSnippet）挂接约定
 * ============================================================ */

/** 片段节点在图中的节点 type（params[SNIPPET_PARAM_KEY] = IRSnippet.id） */
export const SNIPPET_NODE_TYPE = 'script.snippet';
/** 片段节点引用 IRSnippet.id 的参数键 */
export const SNIPPET_PARAM_KEY = 'snippet';

/** 片段源码块 begin 标记行（行尾携带 { lang, pins } 元数据 JSON） */
export function snippetBeginLine(id: string, lang: string, pins: unknown): string {
  return `// __bps-snippet-begin(${id}) ${JSON.stringify({ lang, pins })}`;
}

/** 片段源码块 end 标记行 */
export function snippetEndLine(id: string): string {
  return `// __bps-snippet-end(${id})`;
}

/** 孤儿片段（无节点引用）begin 标记行（class 之外，文件级） */
export function looseSnippetBeginLine(id: string, lang: string, pins: unknown): string {
  return `// __bps-loose-begin(${id}) ${JSON.stringify({ lang, pins })}`;
}

/** 孤儿片段 end 标记行 */
export function looseSnippetEndLine(id: string): string {
  return `// __bps-loose-end(${id})`;
}

/** 序列节点（flow.sequence）内联语句段的标记行（往返时用于重建节点） */
export function sequenceMarkerLine(nodeId: string, outPin: string): string {
  return `// __bps-seq(${nodeId}) ${outPin}`;
}

/** 片段标记行解析出的元数据 */
export interface SnippetMarkerMeta {
  /** 片段 id（IRSnippet.id） */
  id: string;
  /** 片段语言 */
  lang: 'ts' | 'py';
  /** 引脚声明（IRSnippetPin[] 形状，容错解析） */
  pins: unknown[];
}

/** 解析 begin 标记行（snippet 与 loose 共用同一格式，仅关键字不同） */
export function parseSnippetBeginLine(line: string, keyword: 'snippet' | 'loose'): SnippetMarkerMeta | null {
  const re = new RegExp(`^\\s*// __bps-${keyword}-begin\\(([^)]*)\\)\\s*(\\{.*)$`);
  const m = re.exec(line);
  if (!m) return null;
  let meta: { lang?: unknown; pins?: unknown } = {};
  try {
    meta = JSON.parse(m[2]) as { lang?: unknown; pins?: unknown };
  } catch {
    return null;
  }
  return {
    id: m[1],
    lang: meta.lang === 'py' ? 'py' : 'ts',
    pins: Array.isArray(meta.pins) ? meta.pins : [],
  };
}

/** 解析 end 标记行 */
export function parseSnippetEndLine(line: string, keyword: 'snippet' | 'loose'): string | null {
  const re = new RegExp(`^\\s*// __bps-${keyword}-end\\(([^)]*)\\)\\s*$`);
  const m = re.exec(line);
  return m ? m[1] : null;
}

/** 序列标记行解析（返回节点 id 与出口引脚） */
export function parseSequenceMarkerLine(line: string): { nodeId: string; pin: string } | null {
  const m = /^\s*\/\/ __bps-seq\(([^)]+)\)\s+(\S+)\s*$/.exec(line);
  return m ? { nodeId: m[1], pin: m[2] } : null;
}

/** 片段块内的接线说明注释行前缀（解析时从片段源码中剔除） */
export const SNIPPET_WIRING_PREFIX = '// __bps-snippet-wiring';

/* ============================================================
 * 2. 图级操作节点（解释器自有类型）
 * ============================================================ */

/** 函数调用节点（caller 侧）：params.graph = 目标图名 */
export const TYPE_FLOW_CALL = 'flow.call';
/** 子图入口（callee 侧，ADR-001 示例约定） */
export const TYPE_FUNC_ENTRY = 'func.entry';
/** 子图出口（链终止） */
export const TYPE_FUNC_RETURN = 'func.return';
/** 子图入口等价 id（任务卡约定；互转规范化为 func.entry） */
export const TYPE_FLOW_ENTRY = 'flow.entry';
/** 子图出口等价 id（互转规范化为 func.return） */
export const TYPE_FLOW_RETURN = 'flow.return';

export const FUNC_ENTRY_TYPES: readonly string[] = [TYPE_FUNC_ENTRY, TYPE_FLOW_ENTRY];
export const FUNC_RETURN_TYPES: readonly string[] = [TYPE_FUNC_RETURN, TYPE_FLOW_RETURN];

/** 事件入口节点类型（codegen 生成 @on / @onEvent 方法；解析器反向还原） */
export const TYPE_EVENT_START = 'event.start';
export const TYPE_EVENT_CUSTOM = 'event.custom';
export const TYPE_EVENT_LISTEN = 'event.listen';
export const EVENT_ENTRY_TYPES: readonly string[] = [
  TYPE_EVENT_START,
  TYPE_EVENT_CUSTOM,
  TYPE_EVENT_LISTEN,
];

/** 事件入口节点绑定事件名的参数键（event.custom.params.eventName） */
export const EVENT_NAME_PARAM = 'eventName';
/** 事件入口节点绑定事件名的引脚键（event.listen.pinDefaults.eventName） */
export const EVENT_NAME_PIN = 'eventName';

/* ============================================================
 * 3. 互转侧节点规格表（内置节点库 ∪ 图级操作节点最小骨架）
 * ============================================================ */

/** 图级操作节点的最小 spec（只声明 exec 骨架与 flow.call 的 graph 参数；run 不需要） */
const OWNED_SPECS: readonly NodeSpec[] = [
  {
    id: TYPE_FLOW_CALL,
    title: '调用函数',
    category: '函数',
    inputs: [{ id: 'exec', type: 'exec' }],
    outputs: [{ id: 'exec', type: 'exec' }],
    params: [{ id: 'graph', label: '目标函数', type: 'string', default: '' }],
  },
  {
    id: TYPE_FUNC_ENTRY,
    title: '函数入口',
    category: '函数',
    inputs: [],
    outputs: [{ id: 'exec', type: 'exec' }],
  },
  {
    id: TYPE_FUNC_RETURN,
    title: '函数出口',
    category: '函数',
    inputs: [{ id: 'exec', type: 'exec' }],
    outputs: [],
  },
];

let interopSpecsCache: Map<string, NodeSpec> | null = null;

/** 互转用节点规格表：内置节点库 ∪ 图级操作节点（flow.entry / flow.return 复用 func.* 形状） */
export function interopSpecMap(): Map<string, NodeSpec> {
  if (!interopSpecsCache) {
    interopSpecsCache = new Map(builtinSpecMap);
    for (const spec of OWNED_SPECS) {
      if (!interopSpecsCache.has(spec.id)) interopSpecsCache.set(spec.id, spec);
    }
    interopSpecsCache.set(TYPE_FLOW_ENTRY, interopSpecsCache.get(TYPE_FUNC_ENTRY)!);
    interopSpecsCache.set(TYPE_FLOW_RETURN, interopSpecsCache.get(TYPE_FUNC_RETURN)!);
    interopSpecsCache.set(SNIPPET_NODE_TYPE, {
      id: SNIPPET_NODE_TYPE,
      title: '脚本片段',
      category: '函数',
      inputs: [],
      outputs: [],
    });
  }
  return interopSpecsCache;
}

/** 节点规格查询（互转表；未知类型返回 undefined） */
export function specOfType(type: string): NodeSpec | undefined {
  return interopSpecMap().get(type);
}

/* ============================================================
 * 4. 纯节点表达式映射表（codegen 正向合成 + parser 反向匹配共用）
 * ============================================================ */

/** 表达式形态（一个条目一种形态；build 与 match 都由形态驱动） */
export type ExprForm =
  /** 二元运算：(a OP b) —— math.add/sub/mul/div/mod、and、or */
  | { kind: 'binary'; op: string }
  /** 比较运算：运算符来自 params.op（'>','>=','<','<=','==','!='），math.compare 专用 */
  | { kind: 'binary-compare' }
  /** 一元前缀：(OP a) —— math.not */
  | { kind: 'prefix'; op: string }
  /** 全局调用：callee(a, b, …) —— convert.* / format / Math.* / Date.now */
  | { kind: 'global-call'; callee: string }
  /** 成员方法调用：(a).method(b, …) —— includes / trim / toUpperCase / toLowerCase */
  | { kind: 'member-call'; method: string }
  /** 成员属性读取：(a).prop —— string.length（数组长度走 bps.array.length，避免歧义） */
  | { kind: 'member'; prop: string }
  /** 下标访问：(a[i]) —— array.get（带默认值引脚时退回 bps 形态） */
  | { kind: 'element' }
  /** 模板字符串：`${a}${b}` —— string.concat（左脊柱展平，解析时左折叠还原） */
  | { kind: 'template' }
  /** 数组字面量：[a, b, …] —— array.make（最多 5 个输入） */
  | { kind: 'array-literal' }
  /** 多输出特例：convert.androidLogParse —— rows = 调用表达式；count = 调用表达式.length */
  | { kind: 'count-suffix' };

/** 表达式映射表条目 */
export interface ExprTableEntry {
  /** 节点 id（'math.add' 等） */
  id: string;
  /** 表达式求值结果对应的节点输出引脚 */
  outPin: string;
  /** 表达式形态 */
  form: ExprForm;
  /**
   * 守卫：不满足时 codegen 退回 bps.* 形态（如 array.get 带默认值引脚时）。
   * hasEdge 用于查询某输入引脚是否有数据连线（pinDefaults 由条目自查节点）。
   */
  guard?: (node: IRNode, hasEdge: (pin: string) => boolean) => boolean;
}

/**
 * 纯节点 → 表达式映射表（DoD：每个条目都有 roundtrip 测试锁定，见 roundtrip.test.ts）。
 * 语义说明：字符串节点的 strOf 宽松转换、数学节点的 numOf 宽松转换在受控子集
 * （引脚类型正确连线）下与原生 JS 运算一致；除零保护（math.div/mod）与
 * array.get 越界默认值等防御性语义在表达式形态下退化为原生行为（见交卡汇报）。
 */
export const EXPR_TABLE: readonly ExprTableEntry[] = [
  // 数学（四则 / 取模 / 比较 / 逻辑）
  { id: 'math.add', outPin: 'value', form: { kind: 'binary', op: '+' } },
  { id: 'math.sub', outPin: 'value', form: { kind: 'binary', op: '-' } },
  { id: 'math.mul', outPin: 'value', form: { kind: 'binary', op: '*' } },
  { id: 'math.div', outPin: 'value', form: { kind: 'binary', op: '/' } },
  { id: 'math.mod', outPin: 'value', form: { kind: 'binary', op: '%' } },
  { id: 'math.compare', outPin: 'value', form: { kind: 'binary-compare' } },
  { id: 'math.and', outPin: 'value', form: { kind: 'binary', op: '&&' } },
  { id: 'math.or', outPin: 'value', form: { kind: 'binary', op: '||' } },
  { id: 'math.not', outPin: 'value', form: { kind: 'prefix', op: '!' } },
  // 数学（取整 / 最值 / 绝对值 —— 原生 Math.*）
  { id: 'math.floor', outPin: 'value', form: { kind: 'global-call', callee: 'Math.floor' } },
  { id: 'math.ceil', outPin: 'value', form: { kind: 'global-call', callee: 'Math.ceil' } },
  { id: 'math.round', outPin: 'value', form: { kind: 'global-call', callee: 'Math.round' } },
  { id: 'math.min', outPin: 'value', form: { kind: 'global-call', callee: 'Math.min' } },
  { id: 'math.max', outPin: 'value', form: { kind: 'global-call', callee: 'Math.max' } },
  { id: 'math.abs', outPin: 'value', form: { kind: 'global-call', callee: 'Math.abs' } },
  // 字符串
  { id: 'string.concat', outPin: 'value', form: { kind: 'template' } },
  { id: 'string.format', outPin: 'value', form: { kind: 'global-call', callee: 'format' } },
  { id: 'string.length', outPin: 'value', form: { kind: 'member', prop: 'length' } },
  { id: 'string.contains', outPin: 'value', form: { kind: 'member-call', method: 'includes' } },
  { id: 'string.trim', outPin: 'value', form: { kind: 'member-call', method: 'trim' } },
  { id: 'string.upper', outPin: 'value', form: { kind: 'member-call', method: 'toUpperCase' } },
  { id: 'string.lower', outPin: 'value', form: { kind: 'member-call', method: 'toLowerCase' } },
  // 容器
  { id: 'array.make', outPin: 'array', form: { kind: 'array-literal' } },
  {
    id: 'array.get',
    outPin: 'value',
    form: { kind: 'element' },
    guard: (node, hasEdge) =>
      !hasEdge('default') && node.pinDefaults?.['default'] === undefined,
  },
  // 转换（convert.* 内建全局与节点 run 单源同语义，见 src/script/api/ts.ts）
  { id: 'convert.toNumber', outPin: 'value', form: { kind: 'global-call', callee: 'convert.toNumber' } },
  { id: 'convert.toString', outPin: 'value', form: { kind: 'global-call', callee: 'convert.toString' } },
  { id: 'convert.toBool', outPin: 'value', form: { kind: 'global-call', callee: 'convert.toBool' } },
  { id: 'convert.parseInt', outPin: 'value', form: { kind: 'global-call', callee: 'convert.parseInt' } },
  { id: 'convert.jsonParse', outPin: 'value', form: { kind: 'global-call', callee: 'convert.jsonParse' } },
  { id: 'convert.jsonStringify', outPin: 'value', form: { kind: 'global-call', callee: 'convert.jsonStringify' } },
  { id: 'convert.timeFormat', outPin: 'value', form: { kind: 'global-call', callee: 'convert.timeFormat' } },
  { id: 'convert.androidLogParse', outPin: 'rows', form: { kind: 'count-suffix' } },
  // 系统
  { id: 'system.now', outPin: 'epoch', form: { kind: 'global-call', callee: 'Date.now' } },
];

/** 表达式表查找（键 = 节点 id） */
export const EXPR_TABLE_MAP: ReadonlyMap<string, ExprTableEntry> = new Map(
  EXPR_TABLE.map((e) => [e.id, e]),
);

/** bps 兜底调用的 callee 文本（bps.X.Y ↔ 节点 id 'X.Y'） */
export function bpsCalleeOf(nodeId: string): string {
  return `bps.${nodeId}`;
}

/** 从 bps 调用的成员链（如 ['bps','math','clamp']）反解节点 id；非 bps 调用返回 null */
export function nodeIdFromBpsCallee(parts: string[]): string | null {
  if (parts.length < 3 || parts[0] !== 'bps') return null;
  return parts.slice(1).join('.');
}

/* ============================================================
 * 5. IRValueType ↔ TS 注解映射（含 @bps 类型注释）
 * ============================================================ */

/** IR 类型 → TS 注解文本（自定义别名一律 unknown，类型由 @bps 注释兜底携带） */
export function irTypeToTsType(t: string): string {
  switch (t) {
    case 'bool':
      return 'boolean';
    case 'int':
    case 'float':
      return 'number';
    case 'string':
      return 'string';
    case 'any':
      return 'unknown';
    case 'object':
      return 'Record<string, unknown>';
    default:
      if (typeof t === 'string' && t.endsWith('[]')) {
        return `${irTypeToTsType(t.slice(0, -2))}[]`;
      }
      return 'unknown';
  }
}

/** 是否需要 @bps 类型注释（TS 注解无法往返的 IR 类型：int 与自定义别名） */
export function needsTypeComment(t: string): boolean {
  if (t === 'int') return true;
  if (typeof t === 'string' && t.endsWith('[]')) {
    return needsTypeComment(t.slice(0, -2));
  }
  return !['bool', 'float', 'string', 'any', 'object'].includes(t);
}

/** TS 注解文本 → IR 类型（无注释时的推断；number 归一化为 float，见 PLAN §5 约定） */
export function tsAnnotationToIrType(text: string): string {
  const t = text.trim();
  switch (t) {
    case 'boolean':
      return 'bool';
    case 'number':
      return 'float';
    case 'string':
      return 'string';
    case 'unknown':
    case 'any':
      return 'any';
    case 'Record<string, unknown>':
      return 'object';
    default:
      if (t.endsWith('[]')) {
        return `${tsAnnotationToIrType(t.slice(0, -2))}[]`;
      }
      return 'any';
  }
}

/** 行内类型注释格式：/* @bps <irType> *​/（写入 TS 注解之前） */
export function withTypeComment(tsType: string, irType: string): string {
  return needsTypeComment(irType) ? `/* @bps ${irType} */ ${tsType}` : tsType;
}

/** 从声明文本中提取 @bps 类型注释（解析时注释优先于注解推断） */
export function typeCommentOf(declText: string): string | null {
  const m = /\/\*\s*@bps\s+([^*]+?)\s*\*\//.exec(declText);
  return m ? m[1].trim() : null;
}

/* ============================================================
 * 6. 字面量 / 标识符小工具
 * ============================================================ */

/** TS 保留字最小集（变量名 / 方法名 / 字段名生成时规避） */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'await', 'async', 'yield',
  'let', 'static', 'get', 'set', 'of', 'as', 'from',
]);

/** 是否为可直接书写的安全标识符 */
export function isSafeIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) && !RESERVED_WORDS.has(s);
}

/** 任意文本 → 合法标识符（非法字符剔除；数字开头加前缀；空串回落 fallback） */
export function sanitizeIdentifier(s: string, fallback: string): string {
  let out = s.replace(/[^A-Za-z0-9_$]/g, '');
  if (/^[0-9]/.test(out)) out = `_${out}`;
  if (out === '' || RESERVED_WORDS.has(out)) out = fallback;
  return out;
}

/** 首字母大写驼峰（事件方法名 on 前缀用） */
export function toPascalCase(s: string): string {
  const clean = sanitizeIdentifier(s, '');
  if (clean === '') return '';
  return clean[0].toUpperCase() + clean.slice(1);
}

/** 在 used 集合约束下取不重名标识符（base、base2、base3…） */
export function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/** 字面量 → TS 表达式文本（JSON 兼容值；undefined 显式书写） */
export function literalToExpr(v: unknown): string {
  if (v === undefined) return 'undefined';
  const json = JSON.stringify(v);
  return json === undefined ? 'null' : json;
}

/** 模板字符串字面量片段转义（反引号 / 反斜杠 / ${） */
export function escapeTemplateRaw(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/* ============================================================
 * 7. 调用形态实参规划与 spec 默认值剥离
 * ============================================================ */

/** 调用实参规划项：pin = 数据输入引脚（按声明序），param = 检视器参数 */
export interface CallArgItem {
  kind: 'pin' | 'param';
  id: string;
  /** multi 引脚（多连线聚合为数组；调用形态展开为多个实参，如 format） */
  multi?: boolean;
}

/**
 * 调用形态实参规划（bps.* 与 convert.* / Math.* 等调用共用的约定）：
 * 数据输入引脚（跳过 exec）按声明序在前，检视器参数按声明序在后；
 * codegen 对「无连线且无 pinDefaults/params」的尾参省略，parser 按位置反向填充。
 */
export function callArgPlan(spec: NodeSpec): CallArgItem[] {
  const plan: CallArgItem[] = [];
  for (const pin of spec.inputs) {
    if (pin && pin.type !== 'exec') plan.push({ kind: 'pin', id: pin.id, multi: pin.multi });
  }
  for (const param of spec.params ?? []) {
    if (param) plan.push({ kind: 'param', id: param.id });
  }
  return plan;
}

/** 节点的数据输入引脚（跳过 exec，保持声明序） */
export function dataPinsOf(spec: NodeSpec | undefined): PinSpec[] {
  return (spec?.inputs ?? []).filter((p) => !!p && p.type !== 'exec');
}

/** 稳定字符串化（键序排序；深等比较与 spec 默认值剥离共用） */
export function stableStringify(v: unknown): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'undefined') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const item = (v as Record<string, unknown>)[k];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${stableStringify(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return String(v);
}

/** 深等（键序无关；undefined 值视同缺失，对齐 normalizeIR 的洗字段语义） */
export function deepEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * 剥离「等于 spec 默认值」的字面量 pinDefaults / params（原地修改）。
 * 约定：codegen 对缺省引脚总是发射有效字面量，解析端据此还原为「未显式设置」，
 * 使显式默认值与未设置两种形态在往返后归一到同一规范形（语义等价）。
 */
export function stripSpecDefaults(node: IRNode): void {
  const spec = specOfType(node.type);
  if (!spec) return;
  for (const key of Object.keys(node.pinDefaults ?? {})) {
    const pin = spec.inputs.find((p) => !!p && p.id === key);
    if (pin && pin.defaultValue !== undefined && deepEquals(pin.defaultValue, node.pinDefaults[key])) {
      delete node.pinDefaults[key];
    }
  }
  for (const key of Object.keys(node.params ?? {})) {
    const param = (spec.params ?? []).find((p) => !!p && p.id === key);
    if (param && param.default !== undefined && deepEquals(param.default, node.params[key])) {
      delete node.params[key];
    }
  }
}

/** 事件方法名：on + 事件名驼峰（不合法时回落 onEventN，保证唯一） */
export function eventMethodName(eventName: string, used: Set<string>): string {
  const pascal = toPascalCase(eventName);
  const base = pascal === '' ? 'onEvent' : `on${pascal}`;
  return uniqueName(base, used);
}

/** 资产名 → 类名（中文 / 非法字符剔除；空回落 Logic） */
export function assetClassName(name: string): string {
  return sanitizeIdentifier(name, 'Logic');
}

/** __bps-meta 头部标记行（携带主图名，保证 parse(codegen(asset)) 自包含往返） */
export function metaLine(entry: string): string {
  return `// __bps-meta ${JSON.stringify({ entry })}`;
}

/** 解析 __bps-meta 标记行（返回 entry；无标记返回 null） */
export function parseMetaLine(code: string): string | null {
  const m = /^\s*\/\/ __bps-meta\s+(\{.*\})\s*$/m.exec(code);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]) as { entry?: unknown };
    return typeof meta.entry === 'string' && meta.entry !== '' ? meta.entry : null;
  } catch {
    return null;
  }
}

/** 孤儿事件表标记行（codegen 把没有被任何 @on/@onEvent 方法绑定的事件写在此处） */
export function orphanEventsLine(events: unknown): string {
  return `  // __bps-events ${JSON.stringify(events)}`;
}

/** 解析孤儿事件表标记行 */
export function parseOrphanEventsLine(line: string): unknown[] | null {
  const m = /^\s*\/\/ __bps-events\s+(\[.*\])\s*$/.exec(line);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]) as unknown;
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** 参数声明（函数入参 / 返回值）的 JSON 序列化（__bps-returns 注释用） */
export function paramSpecsJson(params: { name: string; type: string }[]): string {
  return JSON.stringify(params);
}
