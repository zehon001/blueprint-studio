/**
 * UI 树面板纯函数模型（T1.4 · PLAN §7.2）
 *
 * 树面板的全部结构操作都在这里以纯函数表达（对传入的 UINode 直接就地变更，
 * 与 immer draft 兼容——runUICommand 的 recipe 拿到的 draft 就是同构普通对象）：
 * - flattenTree：按展开集扁平化为行（缩进树渲染数据源）；
 * - dedupeNodeName / collectTreeNames：name 树内唯一（重名追加 " (n)" 后缀）；
 * - checkDrop / moveUINode：拖拽落点合法性（自身 / 子树 / 叶子拒子 / 根约束）与移动；
 * - buildUINode / cloneSubtree / removeUINode：新建（defaultPropsFor + 唯一名）、
 *   复制（子树深拷贝 + 全新 id + 顺序去重名）、删除（root 不可删）。
 *
 * 命令提交层见 commands.ts（经 runUICommand 入统一命令栈，label 前缀「树：」）。
 */
import type { UINode } from '@/ir/types';
import { defaultPropsFor, getUISchema } from '@/ui-editor/schema';
import { newUINodeId } from '@/ui-editor/store';

/* ============================================================
 * 扁平化（渲染数据源）
 * ============================================================ */

/** 扁平化后的一行（缩进树渲染单元） */
export interface FlatRow {
  /** 节点本体 */
  node: UINode;
  /** 父节点（根为 null） */
  parent: UINode | null;
  /** 缩进层级（根 = 0） */
  depth: number;
  /** 是否有子节点（决定 chevron 展示） */
  hasChildren: boolean;
}

/**
 * 按展开集扁平化 UI 树：根节点始终输出为一行；
 * 已展开（expanded 含其 id）的节点继续输出其子树。
 */
export function flattenTree(root: UINode, expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (node: UINode, parent: UINode | null, depth: number): void => {
    rows.push({ node, parent, depth, hasChildren: node.children.length > 0 });
    if (node.children.length > 0 && expanded.has(node.id)) {
      for (const c of node.children) walk(c, node, depth + 1);
    }
  };
  walk(root, null, 0);
  return rows;
}

/* ============================================================
 * 查找 / 名称唯一化
 * ============================================================ */

/** 查找节点并携带其父节点（未找到返回 null；根的 parent 为 null） */
export function findWithParent(
  root: UINode,
  id: string,
): { node: UINode; parent: UINode | null } | null {
  if (root.id === id) return { node: root, parent: null };
  for (const c of root.children) {
    if (c.id === id) return { node: c, parent: root };
    const hit = findWithParent(c, id);
    if (hit) return hit;
  }
  return null;
}

/** 按 id 查找节点（未找到返回 null） */
export function findUINodeById(root: UINode, id: string): UINode | null {
  return findWithParent(root, id)?.node ?? null;
}

/** node 子树内（不含 node 自身）是否存在 id 节点 */
export function isDescendant(node: UINode, id: string): boolean {
  for (const c of node.children) {
    if (c.id === id || isDescendant(c, id)) return true;
  }
  return false;
}

/** 收集从根到 id 节点的全部祖先 id（不含自身；id 不存在或为根返回 []） */
export function ancestorIds(root: UINode, id: string): string[] {
  const path: string[] = [];
  const walk = (node: UINode, acc: string[]): boolean => {
    if (node.id === id) {
      path.push(...acc);
      return true;
    }
    for (const c of node.children) {
      if (walk(c, [...acc, node.id])) return true;
    }
    return false;
  };
  walk(root, []);
  return path;
}

/** 收集全树节点 name（树内唯一名的占用表） */
export function collectTreeNames(root: UINode, out: Set<string> = new Set()): Set<string> {
  out.add(root.name);
  for (const c of root.children) collectTreeNames(c, out);
  return out;
}

/**
 * 名称去重：与 taken 冲突时追加 " (n)" 后缀（如 'button' → 'button (2)'），
 * 大小写不敏感判定冲突，输出保留 base 原样大小写。
 */
export function dedupeNodeName(taken: ReadonlySet<string>, base: string): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const name = `${base} (${i})`;
    if (!lower.has(name.toLowerCase())) return name;
  }
}

/** name 是否可用（树内唯一；排除 selfId 自身占用；空名不可用） */
export function isNameAvailable(root: UINode, name: string, selfId: string): boolean {
  if (!name.trim()) return false;
  const taken = collectTreeNames(root);
  const self = findUINodeById(root, selfId);
  if (self) taken.delete(self.name);
  return !taken.has(name);
}

/* ============================================================
 * 拖拽落点（上方插入 / 下方插入 / 内部成为子节点）
 * ============================================================ */

/** 拖拽落区：before = 目标上方插入，after = 目标下方插入，inside = 成为目标子节点 */
export type DropZone = 'before' | 'after' | 'inside';

/** 落点合法性检查结果（不合法时给中文原因，供 toast 提示） */
export interface DropCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * 拖拽落点合法性（DoD：拖到自身或自身子树内拒绝；叶子类型不能有子节点；根不可移动）：
 * - 源为根节点：不可移动（根没有父级可插入）；
 * - 目标 = 源自身：三种落区全部拒绝；
 * - 目标在源子树内：拒绝（会成为环）；
 * - before / after 目标为根：拒绝（根没有兄弟位）；
 * - inside 且目标类型 defaultChildPolicy = 'none'：拒绝（叶子不能有子节点）。
 */
export function checkDrop(root: UINode, dragId: string, targetId: string, zone: DropZone): DropCheckResult {
  if (dragId === root.id) return { ok: false, reason: '根节点不可移动' };
  const drag = findWithParent(root, dragId);
  if (!drag) return { ok: false, reason: '源节点不存在' };
  const target = findUINodeById(root, targetId);
  if (!target) return { ok: false, reason: '目标节点不存在' };
  if (targetId === dragId) return { ok: false, reason: '不能拖到自身' };
  if (isDescendant(drag.node, targetId)) return { ok: false, reason: '不能拖到自身子树内' };
  if ((zone === 'before' || zone === 'after') && targetId === root.id) {
    return { ok: false, reason: '不能排列在根节点两侧' };
  }
  if (zone === 'inside') {
    // ADR-009（T7.3）：实例节点的结构以预制体为准，拒收子节点（要改结构先断开预制体）
    if (target.prefab) {
      return { ok: false, reason: '实例节点结构以预制体为准，不能添加子节点（可先断开预制体）' };
    }
    const schema = getUISchema(target.type);
    if (schema?.defaultChildPolicy === 'none') {
      return { ok: false, reason: `「${schema.title}」是叶子节点，不能包含子节点` };
    }
  }
  return { ok: true };
}

/**
 * 就地移动节点（checkDrop 不通过时返回 false 且不产生任何变更）。
 * 实现顺序：先从原父级摘除，再按摘除后的最新索引重新定位目标并插入——
 * 目标是原兄弟节点时索引位移被自然修正。
 */
export function moveUINode(root: UINode, dragId: string, targetId: string, zone: DropZone): boolean {
  if (!checkDrop(root, dragId, targetId, zone).ok) return false;
  const drag = findWithParent(root, dragId)!;
  // 摘除（drag 一定有父级：根节点已在 checkDrop 拒绝）
  const siblings = drag.parent!.children;
  const di = siblings.findIndex((c) => c.id === dragId);
  siblings.splice(di, 1);
  // 摘除后重新定位目标（同一树内，对象引用不变）
  const target = findWithParent(root, targetId)!;
  if (zone === 'inside') {
    target.node.children.push(drag.node);
  } else {
    const list = target.parent!.children;
    const ti = list.findIndex((c) => c.id === targetId);
    list.splice(zone === 'before' ? ti : ti + 1, 0, drag.node);
  }
  return true;
}

/* ============================================================
 * 新建 / 复制 / 删除
 * ============================================================ */

/**
 * 按 schema 构造新节点（defaultPropsFor 拆分规则见 schema/types.ts 头部注释）：
 * - name 取 schema 默认初值（类型名）并按 taken 去重（" (n)" 后缀）；
 * - transform.position / .size / .rotation 取公共组默认值；
 * - 其余属性进 props；未知类型返回 null。
 */
export function buildUINode(type: string, taken: ReadonlySet<string>, id: string = newUINodeId()): UINode | null {
  const schema = getUISchema(type);
  if (!schema) return null;
  const all = defaultPropsFor(type);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'name' || k === 'position' || k === 'size' || k === 'rotation') continue;
    props[k] = v;
  }
  const pos = all.position as { x: number; y: number } | undefined;
  const size = all.size as { w: number; h: number } | undefined;
  return {
    id,
    name: dedupeNodeName(taken, String(all.name ?? type)),
    type,
    transform: {
      position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      size: { w: size?.w ?? 0, h: size?.h ?? 0 },
      rotation: (all.rotation as number) ?? 0,
    },
    theme: {}, // ADR-005：theme 暂不使用
    props,
    events: [],
    children: [],
  };
}

/**
 * 深拷贝子树：全部节点换全新 id（含顶层）、name 按 taken 顺序去重（" (n)" 后缀）
 * 并把新名写入 taken；返回的结构是普通 JSON 深拷贝，与源节点完全独立。
 */
export function cloneSubtree(source: UINode, taken: Set<string>): UINode {
  const clone = JSON.parse(JSON.stringify(source)) as UINode;
  const walk = (node: UINode): void => {
    node.id = newUINodeId();
    node.name = dedupeNodeName(taken, node.name);
    taken.add(node.name);
    for (const c of node.children) walk(c);
  };
  walk(clone);
  return clone;
}

/**
 * 就地删除节点及其子树（root 不可删，返回 null）。
 * 返回被摘除的子树根（调用方可用于 collectUINodeIds 清理选中集）。
 */
export function removeUINode(root: UINode, id: string): UINode | null {
  if (id === root.id) return null;
  const found = findWithParent(root, id);
  if (!found || !found.parent) return null;
  const i = found.parent.children.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [removed] = found.parent.children.splice(i, 1);
  return removed;
}
