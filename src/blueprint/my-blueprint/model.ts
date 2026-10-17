/**
 * Blueprint Studio v2 —— My Blueprint 结构面板·纯函数层（T2.3，PLAN §8.3）
 *
 * 无 React / DOM 依赖（node:test 可直接单测）：命名规则 / 类型清单 /
 * 事件入口节点定位等面板共用逻辑。资产级修改一律走 useBlueprintStore 的
 * 资产 action（内部入命令栈），本模块只做纯计算。
 */
import type { IRAsset, IRParamSpec, IRValueType } from '../../ir/types';

/* ============================================================
 * 1. 变量类型清单（＋新建的类型下拉；IR 内置原语去掉 exec）
 * ============================================================ */

/** 变量可用类型（bool/int/float/string/object/any；exec 只允许出现在引脚上） */
export const VARIABLE_TYPES: readonly IRValueType[] = [
  'bool',
  'int',
  'float',
  'string',
  'object',
  'any',
];

/** 类型中文标签（列表徽标 tooltip / 下拉显示） */
export const VARIABLE_TYPE_LABELS: Readonly<Record<string, string>> = {
  bool: '布尔',
  int: '整数',
  float: '浮点',
  string: '字符串',
  object: '对象',
  any: '任意',
};

/** 类型显示名（未知类型原样显示） */
export function variableTypeLabel(type: IRValueType): string {
  return VARIABLE_TYPE_LABELS[type] ?? String(type);
}

/* ============================================================
 * 2. 命名规则（唯一性比较大小写不敏感，对齐 UE 习惯）
 * ============================================================ */

/** 名字归一键（trim + 小写；唯一性比较用） */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** 是否为空名（trim 后为空） */
export function isBlankName(name: string): boolean {
  return name.trim() === '';
}

/** 名字是否已存在（exclude 按原值排除自身——重命名场景） */
export function nameExists(names: readonly string[], name: string, exclude?: string): boolean {
  const key = nameKey(name);
  return names.some((n) => n !== exclude && nameKey(n) === key);
}

/**
 * 顺序取名：「基础名」可用直接用；否则追加序号（新变量 / 新变量2 / 新变量3…）。
 * 追加序号直接拼数字（UE 的「新变量 2」习惯，无分隔符）。
 */
export function nextSequentialName(existing: readonly string[], base: string): string {
  const keys = new Set(existing.map(nameKey));
  if (!keys.has(nameKey(base))) return base;
  let n = 2;
  while (keys.has(nameKey(`${base}${n}`))) n += 1;
  return `${base}${n}`;
}

/** 下一个默认变量名（新变量 / 新变量2 …） */
export function nextVariableName(existing: readonly string[]): string {
  return nextSequentialName(existing, '新变量');
}

/** 下一个默认函数名（新函数 / 新函数2 …） */
export function nextFunctionName(existing: readonly string[]): string {
  return nextSequentialName(existing, '新函数');
}

/** 下一个默认事件名（新事件 / 新事件2 …） */
export function nextEventName(existing: readonly string[]): string {
  return nextSequentialName(existing, '新事件');
}

/** 复制取名：`名_Copy`，冲突时 `名_Copy2`、`名_Copy3` …（UE 的 Copy 后缀习惯） */
export function nextCopyName(existing: readonly string[], base: string): string {
  const keys = new Set(existing.map(nameKey));
  const trimmed = base.trim();
  let candidate = `${trimmed}_Copy`;
  let n = 1;
  while (keys.has(nameKey(candidate))) {
    n += 1;
    candidate = `${trimmed}_Copy${n}`;
  }
  return candidate;
}

/* ============================================================
 * 3. 图 / 事件定位（双击跳转用）
 * ============================================================ */

/** 是否为主图（资产入口图；主图不可删除、图签置首） */
export function isEntryGraph(asset: IRAsset, graphName: string): boolean {
  return graphName === asset.entry;
}

/** 图签顺序：主图置首，其余按 graphs 键序（新建函数追加在尾部） */
export function orderedGraphNames(asset: IRAsset): string[] {
  const names = Object.keys(asset.graphs);
  return [asset.entry, ...names.filter((n) => n !== asset.entry)].filter(
    (n, i, arr) => n in asset.graphs && arr.indexOf(n) === i,
  );
}

/**
 * 定位自定义事件的事件入口节点（event.custom）：
 * params.eventName 精确匹配优先；未写 eventName 的实例按节点 title 兜底
 * （与解释器 T2.5 的绑定回退约定一致）。找不到返回 null。
 */
export function findEventNode(
  asset: IRAsset,
  eventName: string,
): { graphName: string; nodeId: string } | null {
  for (const [graphName, graph] of Object.entries(asset.graphs)) {
    for (const node of graph.nodes) {
      if (node.type !== 'event.custom') continue;
      const bound = node.params?.['eventName'];
      const hit =
        typeof bound === 'string' && bound !== ''
          ? bound === eventName
          : (node.title ?? '') === eventName;
      if (hit) return { graphName, nodeId: node.id };
    }
  }
  return null;
}

/** 事件参数行清洗：trim 名 + 丢掉空名行（提交给 store 前的统一出口） */
export function cleanParamRows(rows: readonly IRParamSpec[]): IRParamSpec[] {
  return rows
    .map((p) => ({ name: p.name.trim(), type: p.type }))
    .filter((p) => p.name !== '');
}
