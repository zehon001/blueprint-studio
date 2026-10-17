/**
 * UI 树面板命令提交层（T1.4 · PLAN §7.2；T7.3 增补预制体命令 · ADR-009）
 *
 * 一切资产修改经 runUICommand（scene-tree 域，label 前缀「树：」）入统一命令栈
 * （与视口 T1.3 / 检视器 T1.5 同一资产同一域，undo/redo 由命令栈的 immer 补丁负责）：
 * - addUINodeCommand：添加节点（defaultPropsFor + newUINodeId + name 树内去重）；
 * - moveUINodeCommand：拖拽重排父子（上方 / 下方 / 内部三种落区）；
 * - renameUINodeCommand：重命名（name 树内唯一，重名拒绝并给中文原因）；
 * - duplicateUINodeCommand：复制子树（深拷贝 + 全新 id + 去重名，插到源节点之后）；
 * - deleteUINodeCommand：删除节点（含子树；root 不可删）；
 * - saveAsPrefabCommand：节点转为预制体实例（prefab 指向已落盘的预制体文件；
 *   文件写出由面板在命令前完成——文件系统操作不走 UI 树命令域，ADR-009 §5）；
 * - detachPrefabCommand：断开预制体（物化：以有效值冻结实例 + 预制体子树换新 id/名，
 *   删除 prefab 引用；撤销完整还原引用）。
 *
 * 树工具复用 tree-model.ts 的纯函数（对 draft 就地变更，immer 自动产出补丁）。
 */
import type { UIAsset, UINode } from '@/ir/types';
import { getUISchema } from '@/ui-editor/schema';
import {
  getCachedPrefab,
  materializePrefabNode,
  type PrefabResolver,
} from '@/ui-editor/prefab';
import { findUINode, getSceneTreeDomain, newUINodeId, runUICommand } from '@/ui-editor/store';
import {
  buildUINode,
  checkDrop,
  cloneSubtree,
  collectTreeNames,
  findWithParent,
  moveUINode,
  removeUINode,
  type DropZone,
} from './tree-model';

/**
 * 添加节点：插到 parentId 节点的子节点列表末尾（parentId 不存在时回落到根）。
 * 返回新节点 id（供选中）；无资产 / 未知类型返回 null（不发命令）。
 */
export function addUINodeCommand(type: string, parentId: string): string | null {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return null;
  const schema = getUISchema(type);
  if (!schema) return null;
  const newId = newUINodeId();
  runUICommand(`树：添加节点 ${schema.title}`, (raw) => {
    const root = (raw as UIAsset).root;
    const parent = findUINode(root, parentId) ?? root;
    const node = buildUINode(type, collectTreeNames(root), newId);
    if (!node) return;
    parent.children.push(node);
  });
  return newId;
}

/**
 * 拖拽移动节点（三种落区）。合法性与资产当前状态现场校验：
 * 不合法返回 false（不发命令、可 toast 提示原因）；合法经 runUICommand 入栈
 * （label 固定「树：移动节点」；无实际变更时空配方不入栈）。
 */
export function moveUINodeCommand(dragId: string, targetId: string, zone: DropZone): boolean {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return false;
  if (!checkDrop(asset.root, dragId, targetId, zone).ok) return false;
  runUICommand('树：移动节点', (raw) => {
    moveUINode((raw as UIAsset).root, dragId, targetId, zone);
  });
  return true;
}

/** 重命名结果（组件据此给中文 toast） */
export type RenameResult = 'ok' | 'empty' | 'duplicate' | 'missing';

/**
 * 重命名节点：name 树内唯一（排除自身旧名占用）；与原名相同视为无变化（ok，不入栈）。
 */
export function renameUINodeCommand(id: string, rawName: string): RenameResult {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return 'missing';
  const name = rawName.trim();
  if (!name) return 'empty';
  const node = findUINode(asset.root, id);
  if (!node) return 'missing';
  if (name === node.name) return 'ok';
  const taken = collectTreeNames(asset.root);
  taken.delete(node.name);
  if (taken.has(name)) return 'duplicate';
  runUICommand('树：重命名节点', (raw) => {
    const draft = findUINode((raw as UIAsset).root, id);
    if (draft) draft.name = name;
  });
  return 'ok';
}

/**
 * 复制子树：深拷贝 + 全树换新 id + name「xxx (2)」式顺序去重，插到源节点之后。
 * 返回顶层副本 id（供选中）；无资产 / 源为根（无父级可插入）/ 源不存在返回 null。
 */
export function duplicateUINodeCommand(id: string): string | null {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return null;
  const src = findWithParent(asset.root, id);
  if (!src || !src.parent) return null; // 根节点 / 已不存在：不复制
  const newId = newUINodeId();
  runUICommand(`树：复制节点 ${src.node.name}`, (raw) => {
    const root = (raw as UIAsset).root;
    const draft = findWithParent(root, id);
    if (!draft || !draft.parent) return;
    const taken = collectTreeNames(root);
    const clone = cloneSubtree(draft.node, taken);
    clone.id = newId;
    const si = draft.parent.children.findIndex((c) => c.id === id);
    draft.parent.children.splice(si >= 0 ? si + 1 : draft.parent.children.length, 0, clone);
  });
  return newId;
}

/**
 * 删除节点及其子树（root 不可删）。返回是否已入栈命令；
 * 选中集清理由调用方用 collectUINodeIds 完成。
 */
export function deleteUINodeCommand(id: string): boolean {
  const asset = getSceneTreeDomain().asset;
  if (!asset || id === asset.root.id) return false;
  const node = findUINode(asset.root, id);
  if (!node) return false;
  runUICommand(`树：删除节点 ${node.name}`, (raw) => {
    removeUINode((raw as UIAsset).root, id);
  });
  return true;
}

/* ============================================================
 * 预制体命令（T7.3 · ADR-009 §5）
 * ============================================================ */

/**
 * 节点转为预制体实例（「保存为预制体」的资产侧半步）：
 * 预制体文件须已由调用方落盘（PUT /api/file）并经 primePrefabCache 入缓存。
 * 资产侧变更（单命令可撤销）：children/props 清空（属性交由预制体承载，实例覆盖再写回）、
 * 写入 prefab 引用；id/name/transform/events/logicAsset/type 保留实例自身值。
 * 已是实例 / 节点不存在返回 false（不发命令）。
 */
export function saveAsPrefabCommand(id: string, prefabPath: string): boolean {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return false;
  const node = findUINode(asset.root, id);
  if (!node || node.prefab) return false;
  runUICommand(`树：保存为预制体 ${node.name}`, (raw) => {
    const draft = findUINode((raw as UIAsset).root, id);
    if (!draft || draft.prefab) return;
    draft.children = [];
    draft.props = {};
    draft.prefab = prefabPath;
  });
  return true;
}

/** 断开预制体结果（组件据此给中文 toast） */
export type DetachPrefabResult = 'ok' | 'no-asset' | 'not-instance' | 'prefab-missing';

/**
 * 断开预制体（物化，ADR-009 §5）：以「当前有效节点」冻结实例——
 * type/props/theme/events/logicAsset 取展开后的有效值，children = 预制体根子树深拷贝
 * （全新 id + 树内唯一名，嵌套实例保留自身 prefab 引用），删除 prefab 字段。
 * 单命令入栈（label「检视器：断开预制体」，检视器入口），撤销完整还原引用。
 * 预制体未缓存（如文件已删 / 缓存未预热）返回 'prefab-missing' 拒绝（不产生半物化）。
 */
export function detachPrefabCommand(id: string, resolver: PrefabResolver = getCachedPrefab): DetachPrefabResult {
  const asset = getSceneTreeDomain().asset;
  if (!asset) return 'no-asset';
  const node = findUINode(asset.root, id);
  if (!node || !node.prefab) return 'not-instance';
  const prefabRoot = resolver(node.prefab)?.root ?? null;
  if (!prefabRoot) return 'prefab-missing';
  // 名字占用基线 = 全树现名（物化子树的名字将对其去重）；实例自身子树即将被整体替换，
  // 其占用的名字先释放，物化后的子树可以复用这些名。
  const taken = collectTreeNames(asset.root);
  const freeSubtreeNames = (n: UINode): void => {
    taken.delete(n.name);
    for (const c of n.children) freeSubtreeNames(c);
  };
  for (const c of node.children) freeSubtreeNames(c);
  runUICommand('检视器：断开预制体', (raw) => {
    const draft = findUINode((raw as UIAsset).root, id);
    if (!draft || !draft.prefab) return;
    // 每次执行用全新占用表副本（防御性：命令配方按约定单次执行，保持纯函数边界）
    const materialized = materializePrefabNode(draft, prefabRoot, new Set(taken), newUINodeId);
    draft.type = materialized.type;
    draft.transform = materialized.transform;
    draft.theme = materialized.theme;
    draft.props = materialized.props;
    draft.events = materialized.events;
    draft.logicAsset = materialized.logicAsset;
    draft.children = materialized.children;
    delete draft.prefab;
  });
  return 'ok';
}
