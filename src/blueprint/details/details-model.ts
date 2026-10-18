/**
 * Blueprint Studio v2 —— 蓝图检视器·纯函数层（T2.4，PLAN §8.4）
 *
 * 无 React / DOM 依赖（node:test 可直接单测）：
 *  - ParamSpec / PinSpec → 编辑器控件种类的映射；
 *  - 多选共同参数的「混合态」计算（都声明该参数才显示；值全部相同才显示值，否则「—」）；
 *  - 引脚连线状态（已连线 → 显示「已连线」并置灰）与生效默认值解析。
 *
 * 契约真源：src/ir/types.ts（ParamSpec / PinSpec）。控件风格与检视器面板（T1.5）
 * 观感一致，但蓝图域独立实现、不共用代码。
 */
import type { IRGraph, IRNode, NodeSpec, ParamSpec, PinSpec } from '../../ir/types';

/* ============================================================
 * 1. 编辑器控件种类映射
 * ============================================================ */

/** 检视器值编辑器种类（ParamType → 控件；未知种类回落 text） */
export type EditorKind = 'bool' | 'number' | 'text' | 'select' | 'color' | 'variable';

/**
 * ParamSpec → 编辑器控件种类（DoD：number/string/bool/select/color/…）：
 *  - number → 数字输入；bool → 勾选框；select → 下拉（无 options 降级 text）；
 *  - color → 颜色选择器；string / 未知扩展类型 → 文本输入（兜底可编辑）。
 */
export function paramEditorKindOf(param: ParamSpec): EditorKind {
  switch (param.type) {
    case 'number':
      return 'number';
    case 'bool':
      return 'bool';
    case 'select':
      return param.options && param.options.length > 0 ? 'select' : 'text';
    case 'color':
      return 'color';
    case 'string':
      return 'text';
    case 'variable':
      return 'variable';
    default:
      return 'text';
  }
}

/**
 * PinSpec → 引脚默认值编辑器种类（未连线数据输入引脚的内联编辑）：
 *  - exec → null（执行引脚无默认值）；object / any / 数组 / 自定义别名 → null
 *   （与画布 BPNode 的 editorKindOf 口径一致：不提供内联编辑框）；
 *  - bool / int / float / string（含 select 型 string+options）→ 对应控件。
 */
export function pinEditorKindOf(pin: PinSpec): EditorKind | null {
  if (pin.type === 'exec') return null;
  if (pin.type === 'bool') return 'bool';
  if (pin.type === 'int' || pin.type === 'float') return 'number';
  if (pin.type === 'string') return pin.options && pin.options.length > 0 ? 'select' : 'text';
  return null;
}

/* ============================================================
 * 2. 值比较与显示
 * ============================================================ */

/** JSON 语义深比较（undefined 与 null 同义处理） */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 只读值显示：undefined → 「—」，字符串原样，其余 JSON 文本 */
export function displayValue(value: unknown): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  const text = JSON.stringify(value);
  return text ?? '—';
}

/* ============================================================
 * 3. 多选共同参数（混合态）
 * ============================================================ */

/** 多选共同参数行：value 仅在全部选中节点值相同时有效，否则 mixed = true（显示「—」） */
export interface CommonParamRow {
  param: ParamSpec;
  value: unknown;
  mixed: boolean;
}

/**
 * 多选节点的共同参数（DoD：都显示且值相同才显示值，否则混合态「—」）：
 *  - 任一选中节点 spec 缺失（未知节点）→ 返回 []（共同参数不可知）；
 *  - 取第一个节点 spec 参数表为基准，仅保留**每个**选中节点 spec 都声明的参数；
 *  - 生效值 = node.params[id] ?? ParamSpec.default（未写入 params 时用声明默认值）；
 *  - 值两两 JSON 深比较，任一不同 → mixed。
 */
export function commonParamRows(
  specs: ReadonlyMap<string, NodeSpec>,
  nodes: readonly IRNode[],
): CommonParamRow[] {
  if (nodes.length === 0) return [];
  const nodeSpecs = nodes.map((n) => specs.get(n.type));
  if (nodeSpecs.some((s) => !s)) return [];
  const first = nodeSpecs[0]!;
  const rows: CommonParamRow[] = [];
  for (const param of first.params ?? []) {
    let allDeclared = true;
    const values: unknown[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      const declared = nodeSpecs[i]!.params?.find((p) => p.id === param.id);
      if (!declared) {
        allDeclared = false;
        break;
      }
      const written = nodes[i]!.params?.[param.id];
      values.push(written !== undefined ? written : declared.default);
    }
    if (!allDeclared) continue;
    const mixed = values.some((v) => !jsonEquals(v, values[0]));
    rows.push({ param, value: values[0], mixed });
  }
  return rows;
}

/* ============================================================
 * 4. 引脚连线状态与生效默认值
 * ============================================================ */

/** 节点在图中已连线的输入引脚 id 集合（已连线 → Details 显示「已连线」并置灰） */
export function connectedInputPins(graph: IRGraph | null, nodeId: string): ReadonlySet<string> {
  const out = new Set<string>();
  if (!graph) return out;
  for (const e of graph.edges) {
    if (e.to.node === nodeId) out.add(e.to.pin);
  }
  return out;
}

/** 引脚生效默认值：IRNode.pinDefaults 优先，缺省回落 PinSpec.defaultValue */
export function effectivePinDefault(pin: PinSpec, node: IRNode): unknown {
  const written = node.pinDefaults?.[pin.id];
  return written !== undefined ? written : pin.defaultValue;
}

/* ============================================================
 * 5. 参数分组（UE Details 分组折叠观感）
 * ============================================================ */

/** 按 ParamSpec.group 分组（未声明组名归入「默认」；保持声明顺序） */
export function groupParams(params: readonly ParamSpec[]): Array<{ group: string; params: ParamSpec[] }> {
  const order: string[] = [];
  const groups = new Map<string, ParamSpec[]>();
  for (const param of params) {
    const key = param.group ?? '默认';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(param);
  }
  return order.map((group) => ({ group, params: groups.get(group)! }));
}
