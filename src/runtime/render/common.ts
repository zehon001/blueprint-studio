/**
 * 渲染器共享基础（T1.2）
 *
 * - props 读取辅助：ADR-005 裁定所有可编辑属性都在 UINode.props（theme 暂不使用），
 *   渲染器一律经这里的类型化辅助读取，容忍缺省 / 类型漂移（容错降级，不抛错）。
 * - NodeCtx：渲染器回调上下文；事件上报经 mode 门控（编辑态冻结、运行态经 onEvent 上报）。
 * - 节点元素 ↔ 最新 UINode 关联：事件监听器在 create 时绑定一次，闭包里不能持旧 node
 *   引用，统一经 nodeOf(el) 读取 updateUI 后的最新节点。
 */
import type { UINode } from '../../ir/types';

/** 值字符串化（null / undefined → 空串；其余 String()） */
export function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** 数值读取（非法值回落 fallback；字符串数字宽容解析） */
export function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/** 布尔读取（严格 === true，schema 布尔属性缺省即 false） */
export function bool(v: unknown): boolean {
  return v === true;
}

/** 整数读取（截断 + 可选范围夹取） */
export function intOf(v: unknown, fallback: number, min?: number, max?: number): number {
  let n = Math.trunc(num(v, fallback));
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}

/** 数值夹取到 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 像素值 → CSS 字符串 */
export function px(v: number): string {
  return `${v}px`;
}

/**
 * 解析行数据（list / table 的 props.items）：
 * - 编辑态：props.items 是 JSON 数组文本（schema 类型 textarea，检视器以文本编辑样例数据）；
 * - 运行态：逻辑资产经 ui 访问器写入的实际数组（ADR-005：属性统一存 props）。
 * 两者都接受；解析失败 / 非数组降级为空列表；原始行包装为 { value } 保证可渲染。
 */
export function parseRows(items: unknown): Record<string, unknown>[] {
  let arr: unknown = items;
  if (typeof items === 'string') {
    try {
      arr = JSON.parse(items);
    } catch {
      return []; // 编辑期半成品 JSON：静默降级为空列表（检视器编辑中的中间态）
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((r) => (r !== null && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r }));
}

/** 解析字符串数组（optionButton 的 props.items；兼容 JSON 文本与数组两种载体） */
export function parseStringList(v: unknown): string[] {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => str(x));
}

/** 渲染器节点回调上下文（render.ts 构造，随 RenderState 存活） */
export interface NodeCtx {
  /** 渲染模式（与 RenderOptions.mode 一致；builders 一般无需直读，事件门控在 emit 内） */
  mode: 'edit' | 'runtime';
  /** 监听器清理信号：destroy() 时 abort，全部事件监听随之解除 */
  signal: AbortSignal;
  /** 内建事件上报（编辑态为 no-op；运行态转发 onEvent，事件名与 schema BuiltInEvent 一致） */
  emit(node: UINode, event: string, payload?: unknown): void;
}

/** 元素 → 该元素当前对应的 UINode（事件监听器经 nodeOf 读取最新节点，避免闭包过期） */
const elNode = new WeakMap<HTMLElement, UINode>();

/** patch 时绑定元素与最新节点（render.ts 的 patchNodeEl 统一调用） */
export function bindNode(el: HTMLElement, node: UINode): void {
  elNode.set(el, node);
}

/** 读元素当前对应的节点 */
export function nodeOf(el: HTMLElement): UINode | undefined {
  return elNode.get(el);
}

/** 创建带 class 的 div（渲染器内部 DOM 构建小助手） */
export function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** 创建带 class 的 span */
export function span(className = ''): HTMLSpanElement {
  const el = document.createElement('span');
  if (className) el.className = className;
  return el;
}

/** 清空元素全部子节点（不使用 innerHTML=''，语义更明确） */
export function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
