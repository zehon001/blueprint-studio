/**
 * 视口命令提交层（T1.3 · PLAN §6.3 / §7.2）
 *
 * 一切资产修改经 runUICommand（scene-tree 域，label 前缀「视口：」）入统一命令栈，
 * 产生可重放的 immer 补丁（undo/redo 由命令栈负责，本层不手工写逆命令）：
 * - commitMoves：拖动 / 微调 / 对齐的批量位移（一次手势一条命令）；
 * - commitDelete：删除选中（根节点不删，调用方过滤）；
 * - commitDuplicate：Ctrl+D 复制（子树全部换新 id、全树唯一名去重、偏移 20px、
 *   插到原节点之后；根节点不可复制）；
 * - commitAddNode：右键「添加节点」（schema 默认属性 + 位置取画布点击点的父局部坐标）；
 * - commitAddPrefab：右键「添加节点 → 预制体」插入实例（T7.3 正向实例化 · ADR-009：
 *   prefab 引用 + 名字去重 + type/transform 以预制体根起值，结构/属性渲染期回落预制体）。
 *
 * 树工具：buildParentMap / findUINodeWithParent / collectNames / isFreeParentType
 * （free = 根 / panel·scrollBox 内容区，与渲染器 layoutOfParent 的自由布局语义一致）。
 */
import type { UIAsset, UINode, Vec2 } from '../../ir/types';
import { defaultPropsFor, getUISchema } from '../schema';
import { prefabLabelOf } from '../prefab';
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

/**
 * v3 T9.3：节点是否可自由定位。
 * - 有 layout 时以 layout.position 为准（absolute = 自由；relative = 流式被拒）；
 * - 无 layout（v2 兼容）沿用父容器类型判定。
 */
export function isNodeFreelyPositionable(node: UINode, parent: UINode | null): boolean {
  if (node.layout) return node.layout.position === 'absolute';
  return isFreeParentType(parent?.type ?? null);
}

/** 读节点位置（v3 absolute layout 优先；否则 v2 transform） */
export function readNodePosition(node: UINode): Vec2 {
  const l = node.layout;
  if (l && l.position === 'absolute') {
    return {
      x: typeof l.left === 'number' ? l.left : 0,
      y: typeof l.top === 'number' ? l.top : 0,
    };
  }
  return { x: node.transform.position.x, y: node.transform.position.y };
}

/** 写节点位置（v3 absolute 写 layout.left/top；否则写 transform.position） */
export function writeNodePosition(node: UINode, pos: Vec2): void {
  const l = node.layout;
  if (l && l.position === 'absolute') {
    l.left = pos.x;
    l.top = pos.y;
    return;
  }
  node.transform.position = { x: pos.x, y: pos.y };
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
      const cur = readNodePosition(node);
      if (cur.x === m.position.x && cur.y === m.position.y) continue;
      writeNodePosition(node, m.position);
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
 * 解析「添加节点」的父级：null → 根；目标即根 → 根；容器目标 → 目标自身；
 * 叶子目标 / 预制体实例目标（ADR-009：实例结构以预制体为准，自身 children 渲染期被忽略）
 * → 其父级（插为兄弟）。
 * 导出供组件侧换算父级局部坐标（与 commitAddNode 内部保持同一解析规则）。
 */
export function resolveAddParent(root: UINode, targetId: string | null): UINode {
  if (!targetId) return root;
  const found = findUINodeWithParent(root, targetId);
  if (!found) return root;
  if (!found.parent) return root; // 目标即根节点
  if (found.node.prefab) return found.parent; // 实例拒收子节点（与树面板 / 渲染语义一致）
  if (getUISchema(found.node.type)?.defaultChildPolicy === 'container') return found.node;
  return found.parent;
}

/**
 * 插入预制体实例（T7.3 正向实例化，ADR-009 §2）：
 * 实例节点 = { prefab: path, name = 预制体名（全树唯一去重）, type/transform 取预制体根
 * （实例 transform 保留语义 → 直接以预制体根起值，避免占位尺寸覆盖设计尺寸）,
 * props/theme/events/logicAsset 全空 → 渲染展开时回落预制体 }；children 恒空（结构以预制体为准）。
 * prefabRoot = 调用方已取到的预制体根（缓存命中 / 回读；缺省给中性占位——展开时结构仍以预制体为准）。
 * 父级解析与 commitAddNode 同规则。返回新节点 id；无资产返回 null（不发命令）。
 */
export function commitAddPrefab(
  prefabPath: string,
  prefabRoot: UINode | null,
  parentId: string | null,
  at: Vec2,
): string | null {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return null;
  const parent = resolveAddParent(asset.root, parentId);
  const root = prefabRoot;
  const newId = newUINodeId();
  const label = prefabLabelOf(prefabPath);
  const node: UINode = {
    id: newId,
    name: uniqueName(label, collectNames(asset.root)),
    type: root?.type ?? 'panel',
    transform: {
      position: { x: at.x, y: at.y },
      size: root
        ? { ...root.transform.size }
        : { w: 200, h: 200 },
      rotation: root?.transform.rotation ?? 0,
    },
    theme: {},
    props: {},
    events: [],
    children: [],
    prefab: prefabPath,
  };
  runUICommand(`视口：插入预制体实例 ${label}`, (raw) => {
    const draftRoot = (raw as UIAsset).root;
    const draftParent = parent.id === draftRoot.id ? draftRoot : findUINode(draftRoot, parent.id);
    if (!draftParent) return;
    draftParent.children.push(node);
  });
  return newId;
}
