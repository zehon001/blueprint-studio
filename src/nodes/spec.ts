/**
 * Blueprint Studio v2 —— 节点定义基础设施（ADR-003，PLAN §13）
 *
 * 所有内置节点（src/nodes/*.ts）与插件节点一律经 defineNode() 声明，
 * 类型真源在 src/ir/types.ts（本文件只做帮助函数与再导出，不重复声明契约）。
 *
 * 规范化决策（Arch 广播，T13.1 遵守）：
 *  ① exec 引脚显式写 type: 'exec'；
 *  ② select 型引脚 = type: 'string' + options: [{ value, label }]；
 *  ③ 数值类型用 'int' / 'float'，不用 'number'。
 */
import type {
  NodeSpec,
  PinSpec,
  ParamSpec,
  ParamOption,
  NodeRunContext,
  NodeRunResult,
  NodeRunFn,
  IRValueType,
  UiHandle,
} from '../ir/types';

export type {
  NodeSpec,
  PinSpec,
  ParamSpec,
  ParamOption,
  NodeRunContext,
  NodeRunResult,
  NodeRunFn,
  IRValueType,
  UiHandle,
};

/** 内置节点分类（节点头配色 + 右键搜索分组；与 PLAN §13.1 目录一一对应） */
export type NodeCategory =
  | '流程'
  | '事件'
  | '变量'
  | '数学'
  | '字符串'
  | '容器'
  | '转换'
  | '界面'
  | '系统';

/** 全部分类（蓝图右键菜单分组顺序即此数组顺序） */
export const NODE_CATEGORIES: readonly NodeCategory[] = [
  '流程',
  '事件',
  '变量',
  '数学',
  '字符串',
  '容器',
  '转换',
  '界面',
  '系统',
];

/**
 * 定义一个节点（声明式 NodeSpec 的唯一写法）。
 * 当前仅透传做类型收口；后续可在此统一注入校验 / 文档前缀等。
 */
export function defineNode(spec: NodeSpec): NodeSpec {
  return spec;
}

/* ============================================================
 * 引脚速写帮助（减少分类模块的样板）
 * ============================================================ */

/** exec 输入引脚（id 惯例 'exec'） */
export function execIn(id = 'exec', label?: string): PinSpec {
  return { id, type: 'exec', label };
}

/** exec 输出引脚 */
export function execOut(id = 'exec', label?: string): PinSpec {
  return { id, type: 'exec', label };
}

/** 数据输入引脚 */
export function dataIn(
  id: string,
  type: IRValueType,
  label?: string,
  defaultValue?: unknown,
  extra?: Partial<PinSpec>,
): PinSpec {
  return { id, type, label, defaultValue, ...extra };
}

/** 数据输出引脚 */
export function dataOut(id: string, type: IRValueType, label?: string): PinSpec {
  return { id, type, label };
}

/** select 型输入引脚（规范化决策②：type = string + options） */
export function selectIn(
  id: string,
  options: ParamOption[],
  label?: string,
  defaultValue?: string,
): PinSpec {
  return { id, type: 'string', label, options, defaultValue };
}

/** select 型检视器参数 */
export function selectParam(
  id: string,
  label: string,
  options: ParamOption[],
  defaultValue: string,
  group?: string,
): ParamSpec {
  return { id, label, type: 'select', options, default: defaultValue, group };
}

/** 布尔选项（select 引脚常用） */
export function opts(...pairs: [value: string, label: string][]): ParamOption[] {
  return pairs.map(([value, label]) => ({ value, label }));
}

/* ============================================================
 * 输入取值与容错帮助（所有 run 必须容错：缺失/类型不对 → 安全默认值）
 * ============================================================ */

/** 取数值输入（int/float 通用；非法 → fallback = 0） */
export function numOf(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return fallback;
}

/** 取整数输入（非法 → fallback = 0） */
export function intOf(v: unknown, fallback = 0): number {
  return Math.trunc(numOf(v, fallback));
}

/** 取字符串输入（null/undefined → ''，其余 String()） */
export function strOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** 取布尔输入（宽松语义：'true'/'1'/'yes'/'on' → true，数字非 0 → true） */
export function boolOf(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  }
  return fallback;
}

/** 取数组输入（非数组 → 包一层单元素？否：返回空数组，避免误包标量） */
export function arrOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 取对象输入（Record 兜底；非对象 → {}） */
export function objOf(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/* ============================================================
 * 节点运行期内部状态槽
 *
 * 循环 / 触发型节点（forLoop / whileLoop / forEach / flipFlop / doOnce /
 * multiGate / timer / sequence）在 NodeRunFn「单次 run = 单个 next 出口」
 * 契约下无法在节点内自行多次触发下游，统一改用「循环状态机」实现：
 * 每次被触发走一次迭代并给出当前迭代的出口；状态按节点实例 id 隔离存放。
 * 运行窗口停止时应调用 clearAllStateSlots() 复位（由解释器 T2.5 接入）。
 * ============================================================ */

const stateSlots = new Map<string, unknown>();

/** 取（或初始化）某节点实例的内部状态对象 */
export function getStateSlot<T>(nodeId: string, init: () => T): T {
  let slot = stateSlots.get(nodeId);
  if (slot === undefined) {
    slot = init();
    stateSlots.set(nodeId, slot);
  }
  return slot as T;
}

/** 复位某节点实例的内部状态（reset 引脚 / 循环自然结束时调用） */
export function clearStateSlot(nodeId: string): void {
  stateSlots.delete(nodeId);
}

/** 复位全部内部状态（运行窗口停止 / 重跑整个资产时由运行器调用） */
export function clearAllStateSlots(): void {
  stateSlots.clear();
}

/* ============================================================
 * 可选运行时句柄探测（ui / 通知 / 剪贴板 / openUrl）
 *
 * 契约现状：NodeRunContext 目前只有 getVar/setVar/emit/print/delay/signal，
 * 没有 ui 访问器与系统钩子。为不改 src/ir/types.ts（契约级变更须走 ADR），
 * 这里以「结构化可选句柄」探测：解释器注入则用，缺失则 ctx.print 提示并
 * 安全降级（保证蓝图可跑、不抛错）。缺口已上报 PM 协调（见 T13.1 汇报）。
 * ============================================================ */

/**
 * 期望由解释器（T2.5）注入到 ctx.ui 的最小访问器接口（结构化，鸭子类型探测）。
 * 名称语义对齐 UI 资产 UINode：name 为树内唯一名（ui.<name> 查找键）。
 */
// UiHandle 已升格为契约类型（ADR-005），真源在 src/ir/types.ts，经上方 export type 再导出。

/** 探测 ctx.ui（缺失返回 null，由调用方决定降级行为） */
export function probeUi(ctx: NodeRunContext): UiHandle | null {
  const ui = (ctx as unknown as { ui?: UiHandle }).ui;
  if (ui && typeof ui.find === 'function' && typeof ui.write === 'function') return ui;
  return null;
}

/** 统一降级：缺句柄时经 ctx.print 输出提示（不抛错，保证蓝图可跑） */
export function warnMissingHook(ctx: NodeRunContext, hook: string, node: string): void {
  ctx.print(`[${node}] 运行上下文未提供 ${hook} 句柄，本节点已跳过（需解释器注入，见 T13.1 汇报）`);
}

/** 探测通用系统钩子（如 ctx.notify / ctx.clipboard / ctx.openUrl） */
export function probeHook(ctx: NodeRunContext, hook: string): ((...args: unknown[]) => unknown) | null {
  const fn = (ctx as unknown as Record<string, unknown>)[hook];
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}
