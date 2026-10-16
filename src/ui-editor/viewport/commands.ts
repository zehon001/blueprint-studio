/**
 * 视口命令提交层（T1.3 · PLAN §6.3 / §7.2）
 *
 * 一切资产修改经 runUICommand（scene-tree 域，label 前缀「视口：」）入统一命令栈，
 * 产生可重放的 immer 补丁（undo/redo 由命令栈负责，本层不手工写逆命令）：
 * - commitMoves：拖动 / 微调 / 对齐的批量位移（一次手势一条命令）；
 * - commitDelete：删除选中（根节点不删，调用方过滤）；
 * - commitDuplicate：Ctrl+D 复制（子树全部换新 id、全树唯一名去重、偏移 20px、
 *   插到原节点之后；根节点不可复制）；
 * - commitAddNode：右键「添加节点」（schema 默认属性 + 位置取画布点击点的父局部坐标）。
 *
 * 树工具：buildParentMap / findUINodeWithParent / collectNames / isFreeParentType
 * （free = 根 / panel·scrollBox 内容区，与渲染器 layoutOfParent 的自由布局语义一致）。
 */
import type { UIAsset, UINode, Vec2 } from '../../ir/types';
import { defaultPropsFor, getUISchema } from '../schema';
import { findUINode, getSceneTreeDomain, newUINodeId, runUICommand } from '../store';
import { uniqueName } from './geometry';

/** 一条位移（commitMoves 的输入；position 为提交后的最终值，非增量） */
export interface NodeMove {
  id: string;
  position: Vec2;
}

/* ============================================================
 * 树工具
 * ============================================================ */

/**
 * 布局语境：free = 可自由定位（根节点 / panel·scrollBox 内容区）；
 * 其余（vbox/hbox/grid/tabContainer/splitContainer 及未知容器）= 容器排列，移动被拒。
 * 与渲染器 layoutOfParent 的 'free' 语义保持一致（fill/split 均不可自由移动）。
 */
export function isFreeParentType(parentType: string | null): boolean {
  return parentType === null || parentType === 'panel' || parentType === 'scrollBox';
}

/** 构建 id → 父节点映射（根节点映射为 null；未挂载资产时返回空 Map） */
export function buildParentMap(root: UINode): Map<string, UINode | null> {
  const map = new Map<string, UINode | null>();
  const walk = (node: UINode, parent: UINode | null): void => {
    map.set(node.id, parent);
    for (const c of node.children) walk(c, node);
  };
  walk(root, null);
  return map;
}

/** 查找节点并携带其父节点（未找到返回 null） */
export function findUINodeWithParent(
  root: UINode,
  id: string,
): { node: UINode; parent: UINode | null } | null {
  if (root.id === id) return { node: root, parent: null };
  for (const c of root.children) {
    if (c.id === id) return { node: c, parent: root };
    const hit = findUINodeWithParent(c, id);
    if (hit) return hit;
  }
  return null;
}

/** 收集全树节点 name（唯一名去重的占用表） */
export function collectNames(root: UINode, out: Set<string> = new Set()): Set<string> {
  out.add(root.name);
  for (const c of root.children) collectNames(c, out);
  return out;
}

/* ============================================================
 * 命令提交（全部经 runUICommand 入栈，可撤销）
 * ============================================================ */

/** 批量位移（拖动提交 / 方向键微调 / 对齐工具条共用；位置不变的节点跳过 → 无补丁不入栈） */
export function commitMoves(moves: readonly NodeMove[], label?: string): void {
  if (moves.length === 0) return;
  const finalLabel = label ?? `视口：移动节点 ${moves.length} 个`;
  runUICommand(finalLabel, (raw) => {
    const root = (raw as UIAsset).root;
    for (const m of moves) {
      const node = findUINode(root, m.id);
      if (!node) continue;
      const cur = node.transform.position;
      if (cur.x === m.position.x && cur.y === m.position.y) continue;
      node.transform.position = { x: m.position.x, y: m.position.y };
    }
  });
}

/** 删除节点（根节点由调用方过滤；父子同删时父删除即覆盖） */
export function commitDelete(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  runUICommand(`视口：删除节点 ${ids.length} 个`, (raw) => {
    const root = (raw as UIAsset).root;
    removeFromTree(root, set);
  });
}

function removeFromTree(node: UINode, ids: ReadonlySet<string>): number {
  let removed = 0;
  node.children = node.children.filter((c) => {
    if (ids.has(c.id)) {
      removed++;
      return false;
    }
    removed += removeFromTree(c, ids);
    return true;
  });
  return removed;
}

/** 复制请求：源节点 → 预生成的新 id（顶层副本 id，供复制后选中） */
export interface DuplicateRequest {
  sourceId: string;
  newId: string;
}

/**
 * 复制节点（Ctrl+D / 右键「复制」）：
 * - 顶层副本插到源节点之后；子树内全部节点换新 id（资产内唯一）；
 * - 全部 name 经全树唯一名去重（复制 button → button2 → button3…）；
 * - 顶层副本 position 偏移 offset（默认 20px；flow 容器内副本由父容器排列，偏移仅存档）；
 * - 根节点（无父级可插入）与已消失的源节点静默跳过。
 */
export function commitDuplicate(
  sources: readonly DuplicateRequest[],
  offset: Vec2 = { x: 20, y: 20 },
): void {
  if (sources.length === 0) return;
  runUICommand(`视口：复制节点 ${sources.length} 个`, (raw) => {
    const root = (raw as UIAsset).root;
    const taken = collectNames(root);
    for (const req of sources) {
      const found = findUINodeWithParent(root, req.sourceId);
      if (!found || !found.parent) continue; // 根节点 / 已删除：跳过
      const clone = deepCloneUINode(found.node);
      reassignSubtree(clone, taken, req.newId);
      clone.transform.position.x += offset.x;
      clone.transform.position.y += offset.y;
      // 副本插到源节点之后（按源 id 在当前子列表中定位）
      const srcIndex = found.parent.children.findIndex((c) => c.id === req.sourceId);
      found.parent.children.splice(
        srcIndex >= 0 ? srcIndex + 1 : found.parent.children.length,
        0,
        clone,
      );
    }
  });
}

/** 结构化深拷贝（UI 树为纯 JSON 数据；draft 读取后拷出普通对象再写入 draft） */
function deepCloneUINode(node: UINode): UINode {
  return JSON.parse(JSON.stringify(node)) as UINode;
}

/** 子树换新 id + 全树唯一名（顶层 id 用预生成的 newId；深层用 newUINodeId） */
function reassignSubtree(node: UINode, taken: Set<string>, topId: string): void {
  node.id = topId;
  node.name = uniqueName(node.name, taken);
  taken.add(node.name);
  for (const c of node.children) reassignSubtree(c, taken, newUINodeId());
}

/**
 * 右键「添加节点」：按 schema 默认属性构造新节点插入目标父级。
 * - parentId = null（空白处右键）→ 插入根节点；
 * - 目标是容器（defaultChildPolicy='container'）→ 插为其子节点；
 * - 目标是叶子 → 插为其父级的子节点（兄弟）；
 * - at 为**父级局部坐标**（组件侧已用包围盒把画布点击点换算到父坐标系）。
 * 返回新节点 id（供选中）；无资产 / 未知类型返回 null（不发命令）。
 */
export function commitAddNode(type: string, parentId: string | null, at: Vec2): string | null {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return null;
  const schema = getUISchema(type);
  if (!schema) return null;

  // 父级解析（以命令前已提交状态为准；草稿内按 id 重新定位）
  const parent = resolveAddParent(asset.root, parentId);
  const newId = newUINodeId();

  // schema 默认属性 → UINode 拆分（公共组映射规则见 schema/types.ts 头部注释）
  const all = defaultPropsFor(type);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'name' || k === 'position' || k === 'size' || k === 'rotation') continue;
    props[k] = v;
  }
  const size = all.size as { w: number; h: number } | undefined;
  const node: UINode = {
    id: newId,
    name: uniqueName(String(all.name ?? type), collectNames(asset.root)),
    type,
    transform: {
      position: { x: at.x, y: at.y },
      size: { w: size?.w ?? 0, h: size?.h ?? 0 },
      rotation: (all.rotation as number) ?? 0,
    },
    theme: {}, // ADR-005：theme 暂不使用
    props,
    events: [],
    children: [],
  };

  runUICommand(`视口：添加节点 ${schema.title}`, (raw) => {
    const root = (raw as UIAsset).root;
    const draftParent = parent.id === root.id ? root : findUINode(root, parent.id);
    if (!draftParent) return;
    draftParent.children.push(node);
  });
  return newId;
}

/**
 * 解析「添加节点」的父级：null → 根；目标即根 → 根；容器目标 → 目标自身；叶子目标 → 其父级。
 * 导出供组件侧换算父级局部坐标（与 commitAddNode 内部保持同一解析规则）。
 */
export function resolveAddParent(root: UINode, targetId: string | null): UINode {
  if (!targetId) return root;
  const found = findUINodeWithParent(root, targetId);
  if (!found) return root;
  if (!found.parent) return root; // 目标即根节点
  if (getUISchema(found.node.type)?.defaultChildPolicy === 'container') return found.node;
  return found.parent;
}
