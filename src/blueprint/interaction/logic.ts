/**
 * Blueprint Studio v2 —— 画布交互纯函数层（T2.2，PLAN §8.2 交互复刻清单）
 *
 * 无 React / DOM 依赖（node:test 可直接单测），组件层（本目录 *.tsx）与
 * store（src/blueprint/store/）一律从本模块取纯函数：
 *  - suggestConverter        数据线拖到类型不符引脚 → 自动转换节点建议（§8.2 第 3 条）
 *  - checkConnection         连线合法性预检（复用 ir/types 的 isTypeAssignable）
 *  - compatibleSpecEntries   引脚拖出 → 兼容节点菜单过滤（§8.2 第 2 条）
 *  - searchSpecEntries       右键搜索模糊匹配（子串 + ASCII 词首字母，§8.2 第 1 条）
 *  - IRFragment 一族         复制粘贴剪贴板片段（跨图 / 跨资产，§8.2 第 6 条）
 *  - computeAlignedPositions 对齐 / 分布（吸附 10px 网格，§8.2 第 5 条）
 *  - pushRecent              最近使用 LRU（上限 8，localStorage 由组件层负责）
 *
 * 契约真源：src/ir/types.ts（isTypeAssignable / isExecType 等，不得复制其逻辑）。
 */
import {
  isArrayType,
  isExecType,
  isTypeAssignable,
} from '../../ir/types';
import type {
  IREdge,
  IRGraph,
  IRNode,
  IRValueType,
  IRVariable,
  NodeSpec,
  PinSpec,
  Vec2,
} from '../../ir/types';

/** 网格吸附步长（新建节点 / 对齐分布共用；PLAN §8.2「吸附到最近网格 10px」） */
export const GRID_SIZE = 10;

/** 坐标吸附到最近网格（-0 归一为 0，保证 JSON / 比较语义干净） */
export function snapToGrid(v: number, grid: number = GRID_SIZE): number {
  const snapped = Math.round(v / grid) * grid;
  return snapped === 0 ? 0 : snapped;
}

/** 位置吸附到最近网格 */
export function snapPosition(pos: Vec2, grid: number = GRID_SIZE): Vec2 {
  return { x: snapToGrid(pos.x, grid), y: snapToGrid(pos.y, grid) };
}

/* ============================================================
 * 1. 自动转换节点建议（§8.2 第 3 条）
 * ============================================================ */

/** 剥掉数组后缀（数组类型不参与自动转换） */
function baseType(t: IRValueType): string {
  return isArrayType(t) ? t.slice(0, -2) : t;
}

/**
 * 建议 (from → to) 的转换节点（返回 NodeSpec.id；无需或无转换器返回 null）：
 *  - 可直接赋值（相同 / any / int→float / 数组同形）→ null（无需转换）；
 *  - →string：int / float / bool / object → convert.toString；
 *  - →float：string / bool → convert.toNumber；
 *  - →int：string / float / bool → convert.parseInt；
 *  - →bool：string / int / float → convert.toBool；
 *  - 数组类型、自定义别名（LogRow 等）、exec → null（拒绝连接，shake 提示）。
 */
export function suggestConverter(from: IRValueType, to: IRValueType): string | null {
  if (isExecType(from) || isExecType(to)) return null;
  if (isTypeAssignable(from, to)) return null; // 可直接赋值，无需转换节点
  if (isArrayType(from) || isArrayType(to)) return null; // 数组不做自动转换
  const f = baseType(from);
  const t = baseType(to);
  if (t === 'string' && (f === 'int' || f === 'float' || f === 'bool' || f === 'object')) {
    return 'convert.toString';
  }
  if (t === 'float' && (f === 'string' || f === 'bool')) return 'convert.toNumber';
  if (t === 'int' && (f === 'string' || f === 'float' || f === 'bool')) return 'convert.parseInt';
  if (t === 'bool' && (f === 'string' || f === 'int' || f === 'float')) return 'convert.toBool';
  return null;
}

/* ============================================================
 * 2. 引脚引用解析 + 连线合法性预检（§8.2 第 4 条 / onConnect 预检）
 * ============================================================ */

/** 引脚引用（画布交互层的端点；type = null 表示未知节点降级，按 any 处理） */
export interface PinRef {
  /** 所在节点实例 id */
  nodeId: string;
  /** 引脚 id（PinSpec.id） */
  pinId: string;
  /** 方向：in=输入引脚（target）/ out=输出引脚（source） */
  dir: 'in' | 'out';
  /** 引脚类型（未知节点 / 未知引脚为 null） */
  type: IRValueType | null;
  /** v3 T12.4：源节点声明的 traits（用于拖出兼容菜单过滤；缺省 = 不限制） */
  traits?: readonly string[];
}

/** 从 spec 取引脚类型（未找到返回 null） */
export function pinTypeOf(
  spec: NodeSpec | undefined,
  pinId: string,
  dir: 'in' | 'out',
): IRValueType | null {
  if (!spec) return null;
  const pin = dir === 'in' ? spec.inputs : spec.outputs;
  return pin.find((p) => p.id === pinId)?.type ?? null;
}

/** 解析画布端点为 PinRef（未知节点降级为 any 语义：type 'any'） */
export function resolvePinRef(
  specs: ReadonlyMap<string, NodeSpec>,
  graphNodes: readonly IRNode[],
  nodeId: string,
  pinId: string,
  dir: 'in' | 'out',
): PinRef | null {
  const node = graphNodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const spec = specs.get(node.type);
  const type = pinTypeOf(spec, pinId, dir);
  return {
    nodeId,
    pinId,
    dir,
    type: type ?? (spec ? null : 'any'),
    ...(spec?.traits?.length ? { traits: [...spec.traits] } : {}),
  };
}

/** 连线预检结论 */
export type ConnectionVerdict =
  | { verdict: 'ok'; kind: 'exec' | 'data'; from: PinRef; to: PinRef }
  | { verdict: 'converter'; kind: 'data'; converterId: string; from: PinRef; to: PinRef }
  | { verdict: 'reject'; reason: 'unknown-endpoint' | 'same-node' | 'exec-vs-data' | 'incompatible'; message: string };

/**
 * 连线合法性预检（onConnect / isValidConnection / 引脚菜单建线共用）：
 *  - 两端可解析；不同节点；exec 与数据引脚不互连；
 *  - 数据线：可赋值 → ok；有转换器 → converter；否则 reject（UI 层 shake 提示）。
 */
export function checkConnection(
  specs: ReadonlyMap<string, NodeSpec>,
  graphNodes: readonly IRNode[],
  source: { node: string; pin: string },
  target: { node: string; pin: string },
): ConnectionVerdict {
  const from = resolvePinRef(specs, graphNodes, source.node, source.pin, 'out');
  const to = resolvePinRef(specs, graphNodes, target.node, target.pin, 'in');
  if (!from || !to) {
    return { verdict: 'reject', reason: 'unknown-endpoint', message: '无法连接：连线端点不存在（节点或引脚无效）' };
  }
  if (from.nodeId === to.nodeId) {
    return { verdict: 'reject', reason: 'same-node', message: '无法连接：连线两端不能是同一个节点' };
  }
  const fromType = from.type ?? 'any';
  const toType = to.type ?? 'any';
  if (isExecType(fromType) || isExecType(toType)) {
    if (isExecType(fromType) && isExecType(toType)) {
      return { verdict: 'ok', kind: 'exec', from, to };
    }
    return { verdict: 'reject', reason: 'exec-vs-data', message: '无法连接：exec 引脚只能用 exec 连线（白色实线），不能与数据引脚互连' };
  }
  if (isTypeAssignable(fromType, toType)) {
    return { verdict: 'ok', kind: 'data', from, to };
  }
  const converterId = suggestConverter(fromType, toType);
  if (converterId) {
    return { verdict: 'converter', kind: 'data', converterId, from, to };
  }
  return {
    verdict: 'reject',
    reason: 'incompatible',
    message: `无法连接：数据类型 ${fromType} → ${toType} 不兼容，且没有可用的转换节点`,
  };
}

/**
 * ReactFlow isValidConnection 快速判定（拖拽过程中的吸附预检）：
 * 同节点 / exec 与数据互连 / 重复连线 → false；数据类型不匹配放行
 * （由 onConnect 决定插转换节点或拒绝），未知节点降级按 any 放行。
 */
export function isConnectionShapeValid(
  specs: ReadonlyMap<string, NodeSpec>,
  graphNodes: readonly IRNode[],
  existingEdges: readonly IREdge[],
  source: { node: string; pin: string },
  target: { node: string; pin: string },
): boolean {
  const from = resolvePinRef(specs, graphNodes, source.node, source.pin, 'out');
  const to = resolvePinRef(specs, graphNodes, target.node, target.pin, 'in');
  if (!from || !to) return false;
  if (from.nodeId === to.nodeId) return false;
  const fromType = from.type ?? 'any';
  const toType = to.type ?? 'any';
  if (isExecType(fromType) !== isExecType(toType)) return false; // exec 与数据引脚不互吸
  // 重复连线（同端点）不允许
  const dup = existingEdges.some(
    (e) =>
      e.from.node === from.nodeId && e.from.pin === from.pinId &&
      e.to.node === to.nodeId && e.to.pin === to.pinId,
  );
  if (dup) return false;
  return true;
}

/* ============================================================
 * 3. 引脚拖出 → 兼容节点菜单（§8.2 第 2 条）
 * ============================================================ */

/** 兼容菜单条目：spec + 推荐接入的目标引脚（建立连线用） */
export interface SpecEntry {
  spec: NodeSpec;
  /** 从输出拖出 → 推荐的输入引脚；从输入拖出 → 推荐的输出引脚 */
  pin: PinSpec | null;
}

/**
 * 在引脚组里挑「最优接入引脚」（方向可感知）：
 *  - targetDir 'in'（默认）：candidates 为输入引脚（从输出拖出），按 assignable(fromType → pin) 判定；
 *  - targetDir 'out'：candidates 为输出引脚（从输入反拖），按 assignable(pin → fromType) 判定。
 * 打分：精确同类型 > any > 可赋值（allowConverter 时再考虑可自动转换）> 无；
 * exec 与数据引脚分开挑（exec 只与 exec 配，惯例优先 id 'exec'）。
 * 菜单过滤 / 建线均用严格模式（allowConverter = false）：菜单只列可直接接入的节点。
 */
export function bestTargetPin(
  pins: readonly PinSpec[],
  fromType: IRValueType,
  options: { targetDir?: 'in' | 'out'; allowConverter?: boolean } = {},
): PinSpec | null {
  const targetDir = options.targetDir ?? 'in';
  const allowConverter = options.allowConverter ?? false;
  const fromIsExec = isExecType(fromType);
  const assignable = (from: IRValueType, to: IRValueType): boolean =>
    targetDir === 'in' ? isTypeAssignable(from, to) : isTypeAssignable(to, from);
  const convertible = (from: IRValueType, to: IRValueType): string | null =>
    targetDir === 'in' ? suggestConverter(from, to) : suggestConverter(to, from);
  let best: PinSpec | null = null;
  let bestScore = 0;
  for (const pin of pins) {
    const pinIsExec = isExecType(pin.type);
    if (pinIsExec !== fromIsExec) continue; // exec 与数据引脚不混挑
    let score = 0;
    if (fromIsExec) {
      score = pin.id === 'exec' ? 4 : 3;
    } else if (assignable(fromType, pin.type)) {
      score = pin.type === fromType ? 3 : pin.type === 'any' ? 2 : 1;
    } else if (allowConverter && convertible(fromType, pin.type)) {
      score = 1;
    }
    if (score > bestScore) {
      best = pin;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 引脚拖出 → 兼容节点过滤（§8.2 第 2 条「只列兼容节点」）：
 *  - 从输出引脚拖出：列出「该引脚类型可接入其输入」的节点（可赋值 / any / 可自动转换）；
 *    exec 引脚只列有 exec 输入的节点（纯节点无 exec 输入，天然被排除）；
 *  - 从输入引脚拖出：列出「其输出可接入该引脚」的节点（只按可赋值 / any，不插转换）；
 *  - 无需排除拖出节点自身——菜单选中会创建**新实例**，永不构成自连。
 * 分组排序由 groupEntriesByCategory 负责，这里保持 specs 遍历序。
 */
export function compatibleSpecEntries(
  specs: ReadonlyMap<string, NodeSpec>,
  from: PinRef,
): SpecEntry[] {
  const entries: SpecEntry[] = [];
  const fromType = from.type ?? 'any';
  // 从输出拖出 → 候选是输入引脚；从输入反拖 → 候选是输出引脚（方向感知）
  const targetDir = from.dir === 'out' ? ('in' as const) : ('out' as const);
  for (const spec of specs.values()) {
    // v3 T12.4：源/目标都声明 trait 时须有交集；任一方未声明 = 不限制（向后兼容）
    if (from.traits?.length && spec.traits?.length && !spec.traits.some((t) => from.traits!.includes(t))) {
      continue;
    }
    const pins = from.dir === 'out' ? spec.inputs : spec.outputs;
    const pin = bestTargetPin(pins, fromType, { targetDir });
    if (pin) entries.push({ spec, pin });
  }
  return entries;
}

/** 分类浏览分组（按节点库分类顺序；未知分类排最后按名字排） */
export function groupEntriesByCategory(
  entries: readonly SpecEntry[],
  categoryOrder: readonly string[],
): Array<{ category: string; entries: SpecEntry[] }> {
  const groups = new Map<string, SpecEntry[]>();
  for (const entry of entries) {
    const key = entry.spec.category || '其他';
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  const known = categoryOrder.filter((c) => groups.has(c));
  const unknown = [...groups.keys()]
    .filter((c) => !categoryOrder.includes(c))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return [...known, ...unknown].map((category) => ({
    category,
    entries: (groups.get(category) ?? []).slice().sort((a, b) => a.spec.title.localeCompare(b.spec.title, 'zh-Hans-CN')),
  }));
}

/* ============================================================
 * 4. 右键搜索：模糊匹配（子串 + ASCII 词首字母，§8.2 第 1 条）
 * ============================================================ */

/** 搜索条目（pin 仅兼容菜单模式使用） */
export interface SearchEntry extends SpecEntry {}

/** 提取 ASCII 词首字母串（camelCase / 点分 / 空格分词均拆开；如 'convert.toNumber' → 'ctn'） */
export function initialsOf(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  let out = '';
  for (const word of words) {
    const subWords = word.split(/(?<=[a-z0-9])(?=[A-Z])/);
    for (const sub of subWords) out += sub[0].toLowerCase();
  }
  return out;
}

/** query 是否为 text 的子序列（按字符顺序出现即可） */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

/** 单条搜索评分（越大越靠前；-1 = 不匹配） */
function searchScore(entry: SearchEntry, query: string): number {
  const spec = entry.spec;
  const title = spec.title.toLowerCase();
  const id = spec.id.toLowerCase();
  const keywords = (spec.keywords ?? []).map((k) => k.toLowerCase());
  if (title === query) return 100;
  if (title.startsWith(query)) return 90;
  if (title.includes(query)) return 80;
  if (keywords.some((k) => k === query)) return 70;
  if (id.includes(query)) return 60;
  if (keywords.some((k) => k.includes(query))) return 50;
  // 首字母子序列匹配（如 'cn' → convert.toNumber；拼音不要求，ASCII 词首字母）
  const initials = initialsOf(`${spec.id} ${(spec.keywords ?? []).join(' ')} ${spec.title}`);
  if (query.length >= 2 && isSubsequence(query, initials)) return 30;
  return -1;
}

/**
 * 右键搜索模糊匹配：query 为空原样返回（分类浏览模式）；
 * 否则按「精确 > 前缀 > 包含 > 关键词 > id > 首字母」评分排序（稳定，不匹配的剔除）。
 */
export function searchSpecEntries(entries: readonly SearchEntry[], query: string): SearchEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  for (const entry of entries) {
    const score = searchScore(entry, q);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score); // Array.prototype.sort 稳定（ES2019+）
  return scored.map((s) => s.entry);
}

/* ============================================================
 * 5. 复制粘贴：剪贴板 IR 片段（跨图 / 跨资产，§8.2 第 6 条）
 * ============================================================ */

/** 剪贴板片段魔数（任务卡约定格式 `{ __bps: 'ir-fragment', v: 1, nodes, edges, variables? }`） */
export const FRAGMENT_MAGIC = 'ir-fragment';

/** 剪贴板片段（蓝图节点 + 内部连线 + 引用的变量定义；跨图 / 跨资产可用） */
export interface IRFragment {
  __bps: typeof FRAGMENT_MAGIC;
  v: 1;
  nodes: IRNode[];
  edges: IREdge[];
  /** 片段中 var.get / var.set 引用的变量定义（跨资产粘贴时合并缺失项） */
  variables?: IRVariable[];
}

/** 从图中收集选中节点 + 仅存在于选区内部的连线（外部连线不带走） */
export function collectFragment(
  graph: IRGraph,
  nodeIds: ReadonlySet<string>,
): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes = graph.nodes.filter((n) => nodeIds.has(n.id));
  const edges = graph.edges.filter(
    (e) => nodeIds.has(e.from.node) && nodeIds.has(e.to.node),
  );
  return { nodes, edges };
}

/** 片段中 var.get / var.set 节点引用的变量名（去重，保持首次出现序） */
export function referencedVariableNames(nodes: readonly IRNode[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'var.get' && node.type !== 'var.set') continue;
    const name = node.params?.['varName'];
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 组装片段（variables = 片段节点引用的变量定义，无引用时省略） */
export function buildFragment(
  nodes: readonly IRNode[],
  edges: readonly IREdge[],
  variables: readonly IRVariable[],
): IRFragment {
  const names = referencedVariableNames(nodes);
  const defs = names
    .map((name) => variables.find((v) => v.name === name))
    .filter((v): v is IRVariable => v !== undefined);
  const fragment: IRFragment = {
    __bps: FRAGMENT_MAGIC,
    v: 1,
    nodes: nodes.map((n) => structuredCloneJson(n)),
    edges: edges.map((e) => structuredCloneJson(e)),
  };
  if (defs.length > 0) fragment.variables = defs.map((v) => structuredCloneJson(v));
  return fragment;
}

/** JSON 安全深拷贝（IR 为纯 JSON 数据；拷贝失败按原值返回兜底） */
function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 片段 → 剪贴板文本 */
export function fragmentToText(fragment: IRFragment): string {
  return JSON.stringify(fragment);
}

/** 剪贴板文本 → 片段（非片段格式 / 结构缺失返回 null，不抛错） */
export function parseFragment(text: string | null | undefined): IRFragment | null {
  if (!text || text.length > 4_000_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj['__bps'] !== FRAGMENT_MAGIC || obj['v'] !== 1) return null;
  if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) return null;
  const variables = Array.isArray(obj['variables']) ? (obj['variables'] as IRVariable[]) : undefined;
  const fragment: IRFragment = {
    __bps: FRAGMENT_MAGIC,
    v: 1,
    nodes: (obj['nodes'] as IRNode[]).filter((n) => n && typeof n.id === 'string' && typeof n.type === 'string'),
    edges: (obj['edges'] as IREdge[]).filter(
      (e) => e && typeof e.id === 'string' && e.from && e.to && typeof e.kind === 'string',
    ),
  };
  if (variables && variables.length > 0) fragment.variables = variables;
  return fragment;
}

/* ---------- id 分配（复制粘贴 / 新建节点共用，确定性便于单测） ---------- */

export interface IdAllocator {
  /** 分配一个不与已有 id 冲突的 `前缀_序号` id */
  next(prefix: string): string;
}

/**
 * 创建 id 分配器（基于既有 id 集合；NodeSpec.id 取点分尾词作实例前缀，如
 * 'flow.branch' → 'branch_1'；连线前缀惯例 'e'）。
 */
export function createIdAllocator(existing: Iterable<string>): IdAllocator {
  const used = new Set(existing);
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      let n = counters.get(prefix) ?? 1;
      let id = `${prefix}_${n}`;
      while (used.has(id)) {
        n += 1;
        id = `${prefix}_${n}`;
      }
      counters.set(prefix, n);
      used.add(id);
      return id;
    },
  };
}

/** NodeSpec.id → 实例 id 前缀（取点分尾词；无点用全串） */
export function instancePrefixOf(specId: string): string {
  const dot = specId.lastIndexOf('.');
  return dot >= 0 ? specId.slice(dot + 1) : specId;
}

/** 实例化片段：新 id 重生成 + 连线端点重映射 + 位置偏移 + 缺失变量补齐 */
export function instantiateFragment(
  fragment: IRFragment,
  existingNodeIds: Iterable<string>,
  existingVariables: readonly IRVariable[],
  offset: Vec2,
): { nodes: IRNode[]; edges: IREdge[]; variables: IRVariable[] } {
  const alloc = createIdAllocator(existingNodeIds);
  const idMap = new Map<string, string>();
  const nodes = fragment.nodes.map((node) => {
    const id = alloc.next(instancePrefixOf(node.type) || 'node');
    idMap.set(node.id, id);
    const base = node.position ?? { x: 0, y: 0 };
    return {
      ...structuredCloneJson(node),
      id,
      position: { x: base.x + offset.x, y: base.y + offset.y },
    };
  });
  const inFragment = new Set(fragment.nodes.map((n) => n.id));
  const edges = fragment.edges
    .filter((e) => inFragment.has(e.from.node) && inFragment.has(e.to.node))
    .map((e) => ({
      ...structuredCloneJson(e),
      id: alloc.next('e'),
      from: { node: idMap.get(e.from.node) ?? e.from.node, pin: e.from.pin },
      to: { node: idMap.get(e.to.node) ?? e.to.node, pin: e.to.pin },
    }));
  // 变量补齐：片段引用且目标资产缺失的定义合并进来；缺定义的按 any 合成
  const existingNames = new Set(existingVariables.map((v) => v.name));
  const variables: IRVariable[] = [];
  for (const name of referencedVariableNames(fragment.nodes)) {
    if (existingNames.has(name)) continue;
    const def = fragment.variables?.find((v) => v.name === name);
    variables.push(def ? structuredCloneJson(def) : { name, type: 'any' });
  }
  return { nodes, edges, variables };
}

/* ============================================================
 * 6. 对齐 / 分布（§8.2 第 5 条，吸附 10px 网格）
 * ============================================================ */

export type AlignMode = 'left' | 'top' | 'distribute-h' | 'distribute-v';

/** 对齐计算条目（id + 当前位置 + 近似尺寸） */
export interface AlignEntry {
  id: string;
  position: Vec2;
  size: { width: number; height: number };
}

/**
 * 对齐 / 分布位置计算（纯函数，吸附最近网格）：
 *  - left / top：取包围盒最小 x / y 对齐全部；
 *  - distribute-h / v：按当前坐标排序，首尾不动、中间均匀分布（节点数 < 3 或坐标全等则原样）。
 * 返回 Map<节点 id, 新位置>；返回前统一吸附到 gridSize。
 */
export function computeAlignedPositions(
  entries: readonly AlignEntry[],
  mode: AlignMode,
  grid: number = GRID_SIZE,
): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  if (entries.length === 0) return out;
  const snap = (v: number): number => snapToGrid(v, grid);

  if (mode === 'left' || mode === 'top') {
    const target =
      mode === 'left'
        ? Math.min(...entries.map((e) => e.position.x))
        : Math.min(...entries.map((e) => e.position.y));
    for (const e of entries) {
      out.set(
        e.id,
        mode === 'left'
          ? { x: snap(target), y: snap(e.position.y) }
          : { x: snap(e.position.x), y: snap(target) },
      );
    }
    return out;
  }

  // 分布：水平按 x 排 / 垂直按 y 排
  const axis = mode === 'distribute-h' ? 'x' : 'y';
  const sorted = [...entries].sort((a, b) => a.position[axis] - b.position[axis]);
  const first = sorted[0].position[axis];
  const last = sorted[sorted.length - 1].position[axis];
  const span = last - first;
  if (sorted.length < 3 || Math.abs(span) < 1e-6) {
    // 无法分布（少于 3 个 / 已在同一直线）：仅吸附
    for (const e of entries) out.set(e.id, snapPosition(e.position, grid));
    return out;
  }
  sorted.forEach((e, i) => {
    const v = first + (span * i) / (sorted.length - 1);
    const pos = snapPosition(e.position, grid); // 非分布轴同样吸附网格
    pos[axis] = snap(v);
    out.set(e.id, pos);
  });
  return out;
}

/* ============================================================
 * 7. 最近使用 LRU（§8.2 第 1 条，上限 8；localStorage 由组件层负责）
 * ============================================================ */

/** 最近使用条目上限 */
export const RECENT_LIMIT = 8;

/** 最近使用 LRU：置顶 + 去重 + 截断（返回新数组，不改入参） */
export function pushRecent(list: readonly string[], id: string, limit: number = RECENT_LIMIT): string[] {
  const next = [id, ...list.filter((x) => x !== id)];
  return next.slice(0, limit);
}

/* ============================================================
 * 8. 新建节点初始值（params / pinDefaults 取 spec 默认值）
 * ============================================================ */

/** 节点参数初值（ParamSpec.default；undefined 不写入） */
export function initialParams(spec: NodeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of spec.params ?? []) {
    if (p.default !== undefined) out[p.id] = structuredCloneJson(p.default);
  }
  return out;
}

/** 引脚默认值初值（PinSpec.defaultValue；undefined 不写入） */
export function initialPinDefaults(spec: NodeSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of spec.inputs) {
    if (p.defaultValue !== undefined) out[p.id] = structuredCloneJson(p.defaultValue);
  }
  return out;
}

/** 菜单弹出位置收敛到视口内（尺寸为菜单近似尺寸；SSR / 测试环境原样返回） */
export function clampMenuPosition(pos: Vec2, width: number, height: number): Vec2 {
  if (typeof window === 'undefined') return pos;
  const margin = 8;
  const x = Math.min(Math.max(pos.x, margin), Math.max(window.innerWidth - width - margin, margin));
  const y = Math.min(Math.max(pos.y, margin), Math.max(window.innerHeight - height - margin, margin));
  return { x, y };
}
