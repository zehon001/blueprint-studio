/**
 * 实例展开后的节点 id 作用域化（v3 元素/预制体运行时路由）
 *
 * 同一元素/预制体被多个实例引用时，内部节点 id 完全相同。展开时给内部子树加
 * `<实例 id>::` 前缀，保证 data-uid / 事件路由 / DOM 命中唯一；节点 name 不变，
 * 图内 ui 访问器仍按「图属主自身树」的名字工作。
 */
import type { UINode } from '@/ir/types'

export function prefixSubtreeIds(node: UINode, prefix: string): void {
  node.id = `${prefix}::${node.id}`
  for (const child of node.children ?? []) prefixSubtreeIds(child, prefix)
}

/**
 * 作用域 id → 资产树里可选中的节点 id：
 * 实例内部节点（`<实例 id>::...`）归并到实例本体——元素/预制体在编辑期是整体，
 * 视口命中、框选与右键都必须落在实例节点上，内部节点不可单独选中。
 */
export function ownerNodeId(id: string): string {
  const sep = id.indexOf('::')
  return sep > 0 ? id.slice(0, sep) : id
}
