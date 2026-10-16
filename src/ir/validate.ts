/**
 * Blueprint Studio v2 —— 保存校验器 + .bp.json 序列化（T2.8，PLAN §5 / §8.5）
 *
 * 职责（本文件不修改任何契约，只消费 src/ir/types.ts）：
 *  1. validateIR：对 IRAsset 做语义级校验，返回 ValidationIssue 列表。蓝图编辑器底部
 *     错误 / 警告面板消费该列表，凭 issue.nodeId / issue.edgeId 实现点击跳转（T2.2 接线）。
 *     「编译」= 保存即校验（PLAN §8.5）：保存链路在写盘前调用本函数。
 *  2. normalizeIR：洗字段（剔除 undefined 与空的可选容器）+ 键序稳定化，产出「规范形」。
 *     serializeIR / deserializeIR 与 codegen / 解析器（T3.5 / T3.6）的幂等测试都依赖它。
 *  3. serializeIR / deserializeIR：.bp.json 文本 ⇄ IRAsset（保存链路使用；往返无损）。
 *
 * 校验规则与 issue code 对照（severity / 触发条件）：
 *  - unknown-node               error   节点类型不在 specs 中
 *  - type-mismatch              error   数据连线两端类型不可赋值（any 与一切兼容）
 *  - narrowing-conversion       warning float → int 收窄转换（int → float 直接放行）
 *  - dangling-exec              warning 非 pure 节点有 exec 输入引脚但无 exec 边汇入
 *                                       （事件入口 / 函数入口节点天然无 exec 输入，自动豁免）
 *  - exec-through-pure          error   exec 边的目标节点是纯节点
 *  - unused-variable            warning 变量从未被 var.get / var.set 引用
 *  - unconnected-required-input warning 必需数据输入（optional !== true）既无连线，
 *                                       也无 pinDefaults / PinSpec.defaultValue 兜底
 *  - duplicate-node-id          error   同图内节点 id 重复
 *  - broken-edge                error   连线引用不存在的节点 / 引脚
 *  - event-def-missing          warning event.custom 节点引用的事件未在资产事件表中定义
 *  - event-no-entry             warning 已定义的自定义事件没有任何节点引用（死事件）
 *
 * 事件关联约定（待 T5.x 定案，此处为静态分析的尽力而为）：
 *  - event.custom 节点经 params.eventName 关联事件定义；
 *  - event.send / event.listen 的 eventName 是数据输入引脚，字面量取 pinDefaults.eventName；
 *    经变量 / 连线动态传入的引用无法静态解析，不参与判定。
 *
 * normalizeIR 的规范形约定：
 *  - 顶层与各结构体按契约字段顺序重建；记录型字段（graphs / layout / params /
 *    pinDefaults / 嵌套参数值）的键按字典序排序 —— 与输入顺序无关，保证 serializeIR 幂等；
 *  - undefined 值一律剔除；图级可选容器 params / returns / comments 为空数组时剔除
 *    （空与缺省同义，ADR-006）；
 *    其余字段（含 variables/events/snippets 空数组、params/pinDefaults 空对象）按契约保留；
 *  - 因此「往返无损」对规范形资产（即 normalizeIR 的输出）严格成立。
 */
import {
  IR_VERSION,
  elementType,
  isArrayType,
  isExecType,
  isTypeAssignable,
  migrateIR,
} from './types';
import type {
  IRAsset,
  IRComment,
  IREdge,
  IREndpoint,
  IRGraph,
  IRGraphLayout,
  IRNode,
  IRParamSpec,
  IRSnippet,
  IRSnippetPin,
  IRValueType,
  IRVariable,
  NodeSpec,
  PinSpec,
} from './types';

/* ============================================================
 * 1. 校验结果类型
 * ============================================================ */

/** 问题级别：error 阻断运行 / 保存提示；warning 仅提示 */
export type ValidationSeverity = 'error' | 'warning';

/** 单条校验问题（蓝图编辑器底部错误列表的一条；点击凭 nodeId / edgeId 跳转） */
export interface ValidationIssue {
  /** 级别 */
  severity: ValidationSeverity;
  /** 问题码（见文件头对照表；同一码可能多条） */
  code: string;
  /** 所在图名（资产级问题填主图名，供编辑器切换图签） */
  graphName: string;
  /** 关联节点实例 id（点击跳转依据；资产级问题省略） */
  nodeId?: string;
  /** 关联连线 id（类型/引用问题的跳转依据） */
  edgeId?: string;
  /** 中文描述，含上下文（图 / 节点 / 引脚 / 期望与实际类型） */
  message: string;
}

/* ============================================================
 * 2. 洗字段与键序稳定化（normalizeIR）
 * ============================================================ */

/** 是否为普通对象（排除 null 与数组） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 读字符串字段（非字符串返回 ''） */
function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

/** 读子记录字段（非普通对象返回空记录） */
function readRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = obj[key];
  return isPlainObject(v) ? v : {};
}

/** IRValueType 字段读取（缺失 / 非法回落 'any'） */
function typeField(obj: Record<string, unknown>): IRValueType {
  const v = obj['type'];
  return typeof v === 'string' && v !== '' ? v : 'any';
}

/**
 * 递归剔除 undefined 并稳定嵌套键序：
 * 对象键直接删除；数组槽位以 null 占位（对齐 JSON.stringify 语义，保留位次）。
 */
function pruneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : pruneValue(item)));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) out[key] = pruneValue(item);
    }
    return out;
  }
  return value;
}

/** 记录字段规范化：键字典序排序 + 剔除 undefined 值（空对象保留 —— 契约必填字段） */
function sortPlainRecord(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (value !== undefined) out[key] = pruneValue(value);
  }
  return out;
}

function normalizeNode(raw: unknown): IRNode {
  const n = isPlainObject(raw) ? raw : {};
  const pos = readRecord(n, 'position');
  const title = n['title'];
  const comment = n['comment'];
  return {
    id: strField(n, 'id'),
    type: strField(n, 'type'),
    ...(typeof title === 'string' ? { title } : {}),
    params: sortPlainRecord(n['params']),
    pinDefaults: sortPlainRecord(n['pinDefaults']),
    ...(typeof comment === 'string' ? { comment } : {}),
    position: {
      x: typeof pos['x'] === 'number' ? pos['x'] : 0,
      y: typeof pos['y'] === 'number' ? pos['y'] : 0,
    },
  };
}

function normalizeEndpoint(raw: unknown): IREndpoint {
  const p = isPlainObject(raw) ? raw : {};
  return { node: strField(p, 'node'), pin: strField(p, 'pin') };
}

function normalizeEdge(raw: unknown): IREdge {
  const e = isPlainObject(raw) ? raw : {};
  return {
    id: strField(e, 'id'),
    from: normalizeEndpoint(e['from']),
    to: normalizeEndpoint(e['to']),
    kind: e['kind'] === 'exec' ? 'exec' : 'data',
  };
}

function normalizeParam(raw: unknown): IRParamSpec {
  const p = isPlainObject(raw) ? raw : {};
  return { name: strField(p, 'name'), type: typeField(p) };
}

function normalizeVariable(raw: unknown): IRVariable {
  const v = isPlainObject(raw) ? raw : {};
  const out: IRVariable = { name: strField(v, 'name'), type: typeField(v) };
  if (v['default'] !== undefined) out.default = pruneValue(v['default']);
  if (typeof v['exposed'] === 'boolean') out.exposed = v['exposed'];
  if (typeof v['category'] === 'string') out.category = v['category'];
  return out;
}

function normalizeEvent(raw: unknown): { name: string; params: IRParamSpec[] } {
  const e = isPlainObject(raw) ? raw : {};
  return {
    name: strField(e, 'name'),
    params: (Array.isArray(e['params']) ? (e['params'] as unknown[]) : []).map(normalizeParam),
  };
}

function normalizeSnippetPin(raw: unknown): IRSnippetPin {
  const p = isPlainObject(raw) ? raw : {};
  const label = p['label'];
  return {
    id: strField(p, 'id'),
    dir: p['dir'] === 'out' ? 'out' : 'in',
    type: typeField(p),
    ...(typeof label === 'string' ? { label } : {}),
  };
}

function normalizeSnippet(raw: unknown): IRSnippet {
  const s = isPlainObject(raw) ? raw : {};
  return {
    id: strField(s, 'id'),
    lang: s['lang'] === 'py' ? 'py' : 'ts',
    code: typeof s['code'] === 'string' ? s['code'] : '',
    pins: (Array.isArray(s['pins']) ? (s['pins'] as unknown[]) : []).map(normalizeSnippetPin),
  };
}

function normalizeLayout(raw: unknown): Record<string, IRGraphLayout> {
  const out: Record<string, IRGraphLayout> = {};
  if (!isPlainObject(raw)) return out;
  for (const name of Object.keys(raw).sort()) {
    const l = raw[name];
    if (!isPlainObject(l)) continue;
    const pan = Array.isArray(l['pan']) ? (l['pan'] as unknown[]) : [];
    out[name] = {
      zoom: typeof l['zoom'] === 'number' ? l['zoom'] : 1,
      pan: [
        typeof pan[0] === 'number' ? pan[0] : 0,
        typeof pan[1] === 'number' ? pan[1] : 0,
      ],
    };
  }
  return out;
}

function normalizeComment(raw: unknown): IRComment {
  const c = isPlainObject(raw) ? raw : {};
  const b = readRecord(c, 'bounds');
  const color = c['color'];
  return {
    id: strField(c, 'id'),
    text: strField(c, 'text'),
    ...(typeof color === 'string' ? { color } : {}),
    bounds: {
      x: typeof b['x'] === 'number' ? b['x'] : 0,
      y: typeof b['y'] === 'number' ? b['y'] : 0,
      w: typeof b['w'] === 'number' ? b['w'] : 0,
      h: typeof b['h'] === 'number' ? b['h'] : 0,
    },
  };
}

function normalizeGraph(raw: unknown): IRGraph | null {
  if (!isPlainObject(raw)) return null;
  const nodes = (Array.isArray(raw['nodes']) ? (raw['nodes'] as unknown[]) : []).map(normalizeNode);
  const edges = (Array.isArray(raw['edges']) ? (raw['edges'] as unknown[]) : []).map(normalizeEdge);
  const out: IRGraph = { nodes, edges };
  const params = (Array.isArray(raw['params']) ? (raw['params'] as unknown[]) : []).map(normalizeParam);
  if (params.length > 0) out.params = params; // 空的可选容器剔除（空与缺省同义）
  const returns = (Array.isArray(raw['returns']) ? (raw['returns'] as unknown[]) : []).map(normalizeParam);
  if (returns.length > 0) out.returns = returns;
  // 注释框（ADR-006）：缺省 / 空数组剔除；每条洗 id/text/color/bounds（bounds 缺字段补 0，
  // 结构级缺失由 deserializeIR 的 assertIRStructure 抛错把关）
  const comments = (Array.isArray(raw['comments']) ? (raw['comments'] as unknown[]) : []).map(normalizeComment);
  if (comments.length > 0) out.comments = comments;
  return out;
}

/**
 * 把 IRAsset 洗成「规范形」：
 * - 剔除 undefined 字段与空的可选容器（graph.params / graph.returns 空数组）；
 * - 顶层结构按契约字段顺序重建；记录键（graphs / layout / params / pinDefaults /
 *   嵌套参数值）按字典序排序，保证 serializeIR 幂等与 .bp.json diff 友好；
 * - 容错：缺省 / 非法字段回落零值（节点缺 position 补 {0,0}，缺 params/pinDefaults 补 {}），
 *   结构级缺失由 deserializeIR 抛错把关，本函数不抛错。
 */
export function normalizeIR(asset: IRAsset): IRAsset {
  const raw = (asset ?? ({} as IRAsset)) as unknown as Record<string, unknown>;
  const graphs: Record<string, IRGraph> = {};
  const graphsRaw = readRecord(raw, 'graphs');
  for (const name of Object.keys(graphsRaw).sort()) {
    const g = normalizeGraph(graphsRaw[name]);
    if (g) graphs[name] = g;
  }
  return {
    version: IR_VERSION,
    name: strField(raw, 'name'),
    entry: strField(raw, 'entry'),
    graphs,
    variables: (Array.isArray(raw['variables']) ? (raw['variables'] as unknown[]) : []).map(normalizeVariable),
    events: (Array.isArray(raw['events']) ? (raw['events'] as unknown[]) : []).map(normalizeEvent),
    snippets: (Array.isArray(raw['snippets']) ? (raw['snippets'] as unknown[]) : []).map(normalizeSnippet),
    layout: normalizeLayout(raw['layout']),
  };
}

/* ============================================================
 * 3. .bp.json 序列化 / 反序列化（保存链路）
 * ============================================================ */

/** 序列化 IRAsset 为 .bp.json 文本（先洗字段，稳定键序 + 2 空格缩进） */
export function serializeIR(asset: IRAsset): string {
  return JSON.stringify(normalizeIR(asset), null, 2);
}

/** 连线端点结构校验（缺 node / pin 抛错） */
function assertEndpoint(p: unknown, what: string): void {
  if (!isPlainObject(p)) throw new Error(`IR 结构错误：${what} 必须是 { node, pin } 对象`);
  if (typeof p['node'] !== 'string' || p['node'] === '') throw new Error(`IR 结构错误：${what} 缺少 node`);
  if (typeof p['pin'] !== 'string' || p['pin'] === '') throw new Error(`IR 结构错误：${what} 缺少 pin`);
}

/** 人类可读的类型描述（错误信息用） */
function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 结构完整性校验（deserializeIR 专用；缺必填字段抛出带中文路径的 Error）。
 * 语义级问题（类型不匹配等）不在此查 —— 那是 validateIR 的职责。
 */
function assertIRStructure(raw: unknown): void {
  if (!isPlainObject(raw)) throw new Error('IR 结构错误：资产必须是 JSON 对象');
  if (raw['version'] === undefined) throw new Error(`IR 结构错误：缺少 version 字段（当前 IR 版本为 ${IR_VERSION}）`);
  if (typeof raw['version'] !== 'number') {
    throw new Error(`IR 结构错误：version 必须是数字，实际是 ${describeType(raw['version'])}`);
  }
  if (raw['version'] !== IR_VERSION) {
    throw new Error(`IR 结构错误：不支持的 IR 版本 ${raw['version']}（当前引擎支持 ${IR_VERSION}，请先升级资产）`);
  }
  if (typeof raw['name'] !== 'string') throw new Error('IR 结构错误：缺少 name 字段（资产名）');
  if (typeof raw['entry'] !== 'string' || raw['entry'] === '') throw new Error('IR 结构错误：缺少 entry 字段（主图名）');
  if (!isPlainObject(raw['graphs'])) throw new Error('IR 结构错误：graphs 必须是对象（键 = 图名）');
  if (!Array.isArray(raw['variables'])) throw new Error('IR 结构错误：variables 必须是数组');
  if (!Array.isArray(raw['events'])) throw new Error('IR 结构错误：events 必须是数组');
  if (!Array.isArray(raw['snippets'])) throw new Error('IR 结构错误：snippets 必须是数组');
  if (!isPlainObject(raw['layout'])) throw new Error('IR 结构错误：layout 必须是对象（键 = 图名）');

  const graphs = raw['graphs'] as Record<string, unknown>;
  if (!(raw['entry'] in graphs)) {
    throw new Error(`IR 结构错误：主图「${raw['entry']}」未在 graphs 中定义`);
  }

  for (const [gName, g] of Object.entries(graphs)) {
    if (!isPlainObject(g)) throw new Error(`IR 结构错误：图「${gName}」必须是对象`);
    if (!Array.isArray(g['nodes'])) throw new Error(`IR 结构错误：图「${gName}」缺少 nodes 数组`);
    if (!Array.isArray(g['edges'])) throw new Error(`IR 结构错误：图「${gName}」缺少 edges 数组`);
    if (g['params'] !== undefined && !Array.isArray(g['params'])) {
      throw new Error(`IR 结构错误：图「${gName}」的 params 必须是数组`);
    }
    if (g['returns'] !== undefined && !Array.isArray(g['returns'])) {
      throw new Error(`IR 结构错误：图「${gName}」的 returns 必须是数组`);
    }
    if (g['comments'] !== undefined && !Array.isArray(g['comments'])) {
      throw new Error(`IR 结构错误：图「${gName}」的 comments 必须是数组`);
    }
    ((g['comments'] ?? []) as unknown[]).forEach((c, i) => {
      if (!isPlainObject(c)) throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 条注释必须是对象`);
      if (typeof c['id'] !== 'string' || c['id'] === '') {
        throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 条注释缺少 id`);
      }
      if (typeof c['text'] !== 'string') {
        throw new Error(`IR 结构错误：图「${gName}」注释「${c['id']}」缺少 text`);
      }
      if (!isPlainObject(c['bounds'])) {
        throw new Error(`IR 结构错误：图「${gName}」注释「${c['id']}」缺少 bounds（须为 { x, y, w, h }）`);
      }
      const b = c['bounds'] as Record<string, unknown>;
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        if (typeof b[k] !== 'number') {
          throw new Error(`IR 结构错误：图「${gName}」注释「${c['id']}」的 bounds.${k} 必须是数字`);
        }
      }
      if (c['color'] !== undefined && typeof c['color'] !== 'string') {
        throw new Error(`IR 结构错误：图「${gName}」注释「${c['id']}」的 color 必须是字符串`);
      }
    });
    (g['nodes'] as unknown[]).forEach((n, i) => {
      if (!isPlainObject(n)) throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 个节点必须是对象`);
      if (typeof n['id'] !== 'string' || n['id'] === '') {
        throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 个节点缺少 id`);
      }
      if (typeof n['type'] !== 'string' || n['type'] === '') {
        throw new Error(`IR 结构错误：图「${gName}」节点「${n['id']}」缺少 type`);
      }
    });
    (g['edges'] as unknown[]).forEach((e, i) => {
      if (!isPlainObject(e)) throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 条连线必须是对象`);
      if (typeof e['id'] !== 'string' || e['id'] === '') {
        throw new Error(`IR 结构错误：图「${gName}」第 ${i + 1} 条连线缺少 id`);
      }
      if (e['kind'] !== 'exec' && e['kind'] !== 'data') {
        throw new Error(`IR 结构错误：连线「${e['id']}」的 kind 必须是 'exec' 或 'data'`);
      }
      assertEndpoint(e['from'], `连线「${e['id']}」的起点 from`);
      assertEndpoint(e['to'], `连线「${e['id']}」的终点 to`);
    });
  }

  (raw['variables'] as unknown[]).forEach((v, i) => {
    if (!isPlainObject(v)) throw new Error(`IR 结构错误：variables[${i}] 必须是对象`);
    if (typeof v['name'] !== 'string' || v['name'] === '') throw new Error(`IR 结构错误：variables[${i}] 缺少 name`);
    if (typeof v['type'] !== 'string' || v['type'] === '') throw new Error(`IR 结构错误：变量「${v['name']}」缺少 type`);
  });
  (raw['events'] as unknown[]).forEach((e, i) => {
    if (!isPlainObject(e)) throw new Error(`IR 结构错误：events[${i}] 必须是对象`);
    if (typeof e['name'] !== 'string' || e['name'] === '') throw new Error(`IR 结构错误：events[${i}] 缺少 name`);
    if (!Array.isArray(e['params'])) throw new Error(`IR 结构错误：事件「${e['name']}」缺少 params 数组`);
  });
  (raw['snippets'] as unknown[]).forEach((s, i) => {
    if (!isPlainObject(s)) throw new Error(`IR 结构错误：snippets[${i}] 必须是对象`);
    if (typeof s['id'] !== 'string' || s['id'] === '') throw new Error(`IR 结构错误：snippets[${i}] 缺少 id`);
    if (s['lang'] !== 'ts' && s['lang'] !== 'py') {
      throw new Error(`IR 结构错误：片段「${s['id']}」的 lang 必须是 'ts' 或 'py'`);
    }
    if (typeof s['code'] !== 'string') throw new Error(`IR 结构错误：片段「${s['id']}」缺少 code`);
    if (!Array.isArray(s['pins'])) throw new Error(`IR 结构错误：片段「${s['id']}」缺少 pins 数组`);
  });
}

/**
 * 反序列化 .bp.json 文本为 IRAsset：
 * JSON.parse → migrateIR（版本迁移）→ 结构完整性校验（缺字段抛中文错误）→ normalizeIR。
 */
export function deserializeIR(text: string): IRAsset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`IR 反序列化失败：文本不是合法的 JSON（${reason}）`);
  }
  const migrated = migrateIR(parsed);
  assertIRStructure(migrated);
  return normalizeIR(migrated as IRAsset);
}

/* ============================================================
 * 4. 语义校验（validateIR）
 * ============================================================ */

/** 节点显示名：实例 title 覆盖 → NodeSpec.title → type */
function nodeLabelOf(node: Record<string, unknown>, spec?: NodeSpec): string {
  const title = node['title'];
  if (typeof title === 'string' && title !== '') return title;
  return spec?.title ?? strField(node, 'type');
}

/** 引脚显示名：label 优先，缺省显示 id */
function pinLabelOf(pin: PinSpec): string {
  return pin.label ?? pin.id;
}

/**
 * 数据连线可赋值性三值判定（建立在契约 isTypeAssignable 之上）：
 *  - 'ok'       可直接赋值（相同 / any / int→float / 数组同形可赋值）；
 *  - 'narrowing'收窄转换（float→int，含数组元素级），本期降级为 warning；
 *  - 'mismatch' 不可赋值（数组⇄元素、不同别名等），报 error type-mismatch。
 */
function classifyAssignment(from: IRValueType, to: IRValueType): 'ok' | 'narrowing' | 'mismatch' {
  if (isTypeAssignable(from, to)) return 'ok';
  if (from === 'float' && to === 'int') return 'narrowing';
  if (isArrayType(from) && isArrayType(to)) {
    return classifyAssignment(elementType(from), elementType(to));
  }
  return 'mismatch';
}

/** 该 (节点, 引脚) 是否有任意连线汇入 */
function hasIncomingEdge(edges: unknown[], nodeId: string, pinId: string): boolean {
  return edges.some((e) => {
    if (!isPlainObject(e)) return false;
    const to = e['to'];
    return isPlainObject(to) && to['node'] === nodeId && to['pin'] === pinId;
  });
}

/** 该节点是否有 exec 边汇入（悬空 exec 判定） */
function hasIncomingExecEdge(edges: unknown[], nodeId: string): boolean {
  return edges.some((e) => {
    if (!isPlainObject(e)) return false;
    if (e['kind'] !== 'exec') return false;
    const to = e['to'];
    return isPlainObject(to) && to['node'] === nodeId;
  });
}

/** 读取节点静态引用的事件名（约定见文件头；无则返回 ''） */
function referencedEventNameOf(node: Record<string, unknown>): string {
  const fromParams = readRecord(node, 'params')['eventName'];
  if (typeof fromParams === 'string' && fromParams !== '') return fromParams;
  const fromPinDefaults = readRecord(node, 'pinDefaults')['eventName'];
  if (typeof fromPinDefaults === 'string' && fromPinDefaults !== '') return fromPinDefaults;
  return '';
}

/** 读连线端点（缺失字段回落 ''） */
function endpointOf(v: unknown): { node: string; pin: string } {
  const p = isPlainObject(v) ? v : {};
  return { node: strField(p, 'node'), pin: strField(p, 'pin') };
}

/**
 * IR 语义校验器（保存即校验，PLAN §8.5）。
 *
 * @param asset 待校验资产（容忍缺字段 / 半成品，不抛错）
 * @param specs 节点定义表（内置 builtinSpecMap ∪ 插件节点；T2.2 接线时合并传入）
 * @returns 问题列表（可能为空；顺序：各图节点级 → 各图边级 → 资产级）
 */
export function validateIR(asset: IRAsset, specs: Map<string, NodeSpec>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const raw = (asset ?? ({} as IRAsset)) as unknown as Record<string, unknown>;
  if (!isPlainObject(raw)) {
    issues.push({
      severity: 'error',
      code: 'invalid-asset',
      graphName: '',
      message: 'IR 资产无效：传入值不是对象',
    });
    return issues;
  }

  const entryName = strField(raw, 'entry');
  const graphsRaw = readRecord(raw, 'graphs');

  // 事件定义名集合（资产级）
  const eventDefNames = new Set<string>();
  for (const e of Array.isArray(raw['events']) ? (raw['events'] as unknown[]) : []) {
    if (isPlainObject(e) && typeof e['name'] === 'string' && e['name'] !== '') eventDefNames.add(e['name']);
  }

  // 全图扫描累积：被读写的变量名、被引用的事件名
  const usedVariables = new Set<string>();
  const referencedEvents = new Set<string>();

  for (const graphName of Object.keys(graphsRaw)) {
    const gRaw = graphsRaw[graphName];
    if (!isPlainObject(gRaw)) continue;
    const nodes: unknown[] = Array.isArray(gRaw['nodes']) ? (gRaw['nodes'] as unknown[]) : [];
    const edges: unknown[] = Array.isArray(gRaw['edges']) ? (gRaw['edges'] as unknown[]) : [];
    const nodeById = new Map<string, Record<string, unknown>>();
    const reportedDup = new Set<string>();

    /* ---------- 节点级检查 ---------- */
    for (const nRaw of nodes) {
      if (!isPlainObject(nRaw)) continue; // 结构问题由 deserializeIR 把关
      const nodeId = strField(nRaw, 'id');
      if (nodeId === '') continue;
      // 规则：同图节点 id 重复
      if (nodeById.has(nodeId)) {
        if (!reportedDup.has(nodeId)) {
          reportedDup.add(nodeId);
          issues.push({
            severity: 'error',
            code: 'duplicate-node-id',
            graphName,
            nodeId,
            message: `图「${graphName}」中存在重复的节点 id「${nodeId}」（节点 id 必须同图唯一）`,
          });
        }
        continue; // 重复实例不再做引脚级检查，避免噪声
      }
      nodeById.set(nodeId, nRaw);

      const nodeType = strField(nRaw, 'type');
      const spec = specs.get(nodeType);
      // 规则：未知节点
      if (!spec) {
        issues.push({
          severity: 'error',
          code: 'unknown-node',
          graphName,
          nodeId,
          message: `图「${graphName}」中的节点「${nodeLabelOf(nRaw)}」使用了未知节点类型「${nodeType}」（节点库中不存在，可能是插件未启用或节点已删除）`,
        });
        continue; // 无 spec，引脚级检查无从进行
      }
      const label = nodeLabelOf(nRaw, spec);

      // 规则：必需数据输入既无连线也无默认值（exec 输入由悬空 exec 规则负责）
      for (const pin of spec.inputs) {
        if (!pin || isExecType(pin.type)) continue;
        if (pin.optional === true) continue;
        if (hasIncomingEdge(edges, nodeId, pin.id)) continue;
        if (readRecord(nRaw, 'pinDefaults')[pin.id] !== undefined) continue;
        if (pin.defaultValue !== undefined) continue;
        issues.push({
          severity: 'warning',
          code: 'unconnected-required-input',
          graphName,
          nodeId,
          message: `图「${graphName}」中节点「${label}」的必需输入「${pinLabelOf(pin)}」未连线且未设置默认值`,
        });
      }

      // 规则：悬空 exec（非纯节点有 exec 输入引脚但无 exec 边汇入；事件 / 函数入口节点无 exec 输入，天然豁免）
      const hasExecInput = spec.inputs.some((p) => !!p && isExecType(p.type));
      if (!spec.pure && hasExecInput && !hasIncomingExecEdge(edges, nodeId)) {
        issues.push({
          severity: 'warning',
          code: 'dangling-exec',
          graphName,
          nodeId,
          message: `图「${graphName}」中节点「${label}」没有任何 exec 连线汇入，永远不会被执行`,
        });
      }

      // 变量引用收集（var.get / var.set 经 params.varName）
      if (nodeType === 'var.get' || nodeType === 'var.set') {
        const varName = readRecord(nRaw, 'params')['varName'];
        if (typeof varName === 'string' && varName !== '') usedVariables.add(varName);
      }
      // 事件引用收集与死引用检查
      const evName = referencedEventNameOf(nRaw);
      if (evName !== '') {
        referencedEvents.add(evName);
        if (nodeType === 'event.custom' && !eventDefNames.has(evName)) {
          issues.push({
            severity: 'warning',
            code: 'event-def-missing',
            graphName,
            nodeId,
            message: `图「${graphName}」中的 event.custom 节点「${label}」引用的事件「${evName}」未在资产事件表中定义`,
          });
        }
      }
    }

    /* ---------- 边级检查 ---------- */
    for (const eRaw of edges) {
      if (!isPlainObject(eRaw)) continue;
      const edgeId = strField(eRaw, 'id');
      const from = endpointOf(eRaw['from']);
      const to = endpointOf(eRaw['to']);
      const kind = eRaw['kind'] === 'exec' ? 'exec' : 'data';
      const fromNode = from.node !== '' ? nodeById.get(from.node) : undefined;
      const toNode = to.node !== '' ? nodeById.get(to.node) : undefined;
      // 规则：边引用不存在的节点
      if (!fromNode || !toNode) {
        const side = !fromNode ? '起点' : '终点';
        const ghost = !fromNode ? from.node : to.node;
        issues.push({
          severity: 'error',
          code: 'broken-edge',
          graphName,
          edgeId,
          message: `图「${graphName}」中连线「${edgeId}」的${side}引用了不存在的节点「${ghost}」`,
        });
        continue;
      }
      const fromSpec = specs.get(strField(fromNode, 'type'));
      const toSpec = specs.get(strField(toNode, 'type'));
      if (!fromSpec || !toSpec) continue; // unknown-node 已单独报过，引脚无从查证

      // 规则：exec 链穿纯节点（按目标节点判定，与引脚有效性解耦）
      if (kind === 'exec' && toSpec.pure === true) {
        issues.push({
          severity: 'error',
          code: 'exec-through-pure',
          graphName,
          nodeId: strField(toNode, 'id'),
          edgeId,
          message: `图「${graphName}」中连线「${edgeId}」把 exec 链接入纯节点「${nodeLabelOf(toNode, toSpec)}」：exec 链不能穿过纯节点（纯节点只能经数据连线引用）`,
        });
      }

      const fromPin = fromSpec.outputs.find((p) => !!p && p.id === from.pin);
      const toPin = toSpec.inputs.find((p) => !!p && p.id === to.pin);
      // 规则：边引用不存在的引脚
      if (!fromPin || !toPin) {
        const side = !fromPin ? '起点' : '终点';
        const pinId = !fromPin ? from.pin : to.pin;
        const badNode = !fromPin ? fromNode : toNode;
        const badSpec = !fromPin ? fromSpec : toSpec;
        issues.push({
          severity: 'error',
          code: 'broken-edge',
          graphName,
          edgeId,
          nodeId: strField(badNode, 'id'),
          message: `图「${graphName}」中连线「${edgeId}」的${side}引脚「${pinId}」不是节点「${nodeLabelOf(badNode, badSpec)}」的${side === '起点' ? '输出' : '输入'}引脚`,
        });
        continue;
      }

      if (kind === 'exec') {
        // exec 边两端都必须是 exec 引脚
        if (!isExecType(fromPin.type) || !isExecType(toPin.type)) {
          issues.push({
            severity: 'error',
            code: 'type-mismatch',
            graphName,
            edgeId,
            nodeId: strField(toNode, 'id'),
            message: `图「${graphName}」中连线「${edgeId}」是 exec 边，但两端引脚类型为 ${fromPin.type} / ${toPin.type}（exec 引脚只能用 exec 连线）`,
          });
        }
        continue;
      }
      // 数据边：exec 引脚不可混入
      if (isExecType(fromPin.type) || isExecType(toPin.type)) {
        issues.push({
          severity: 'error',
          code: 'type-mismatch',
          graphName,
          edgeId,
          nodeId: strField(toNode, 'id'),
          message: `图「${graphName}」中连线「${edgeId}」是数据边，但引脚类型为 ${fromPin.type} / ${toPin.type}（exec 引脚只能出现在 exec 边上）`,
        });
        continue;
      }
      // 规则：数据边类型可赋值性（any 兼容；数组⇄元素不兼容；float→int 收窄降级 warning）
      const verdict = classifyAssignment(fromPin.type, toPin.type);
      if (verdict === 'mismatch') {
        issues.push({
          severity: 'error',
          code: 'type-mismatch',
          graphName,
          edgeId,
          nodeId: strField(toNode, 'id'),
          message: `图「${graphName}」中连线「${edgeId}」类型不匹配：节点「${nodeLabelOf(fromNode, fromSpec)}」的输出「${pinLabelOf(fromPin)}」是 ${fromPin.type}，但节点「${nodeLabelOf(toNode, toSpec)}」的输入「${pinLabelOf(toPin)}」需要 ${toPin.type}`,
        });
      } else if (verdict === 'narrowing') {
        issues.push({
          severity: 'warning',
          code: 'narrowing-conversion',
          graphName,
          edgeId,
          nodeId: strField(toNode, 'id'),
          message: `图「${graphName}」中连线「${edgeId}」存在收窄转换：节点「${nodeLabelOf(fromNode, fromSpec)}」的输出「${pinLabelOf(fromPin)}」（${fromPin.type}）赋给节点「${nodeLabelOf(toNode, toSpec)}」的输入「${pinLabelOf(toPin)}」（${toPin.type}）可能丢失精度`,
        });
      }
    }
  }

  /* ---------- 资产级：未使用变量 ---------- */
  for (const vRaw of Array.isArray(raw['variables']) ? (raw['variables'] as unknown[]) : []) {
    if (!isPlainObject(vRaw)) continue;
    const name = vRaw['name'];
    if (typeof name !== 'string' || name === '' || usedVariables.has(name)) continue;
    issues.push({
      severity: 'warning',
      code: 'unused-variable',
      graphName: entryName,
      message: `变量「${name}」从未被 var.get / var.set 读写（可删除或勾选暴露）`,
    });
  }

  /* ---------- 资产级：死事件（定义了却没有任何节点引用） ---------- */
  for (const eRaw of Array.isArray(raw['events']) ? (raw['events'] as unknown[]) : []) {
    if (!isPlainObject(eRaw)) continue;
    const name = eRaw['name'];
    if (typeof name !== 'string' || name === '' || referencedEvents.has(name)) continue;
    issues.push({
      severity: 'warning',
      code: 'event-no-entry',
      graphName: entryName,
      message: `自定义事件「${name}」已定义，但没有任何 event.custom / event.send / event.listen 节点引用它`,
    });
  }

  return issues;
}
