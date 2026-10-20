/**
 * UI 节点的「类型显示名」——UI 树行尾与检视器徽标共用同一口径：
 * 元素实例优先显示元素资产的显示名（asset.title），缺省显示元素文件名
 * （去 .elem.json；@library 路径取末段）；普通节点用 schema 中文名。
 */
import type { UINode } from '@/ir/types'
import { getCachedElement } from './element'
import { getUISchema } from './schema'

/** 元素引用 → 显示名（缓存命中时优先 title） */
export function elementLabelOf(ref: string): string {
  const cached = getCachedElement(ref)
  if (cached?.title) return cached.title
  const base = ref.split(/[\\/]/).pop() ?? ref
  return base.replace(/\.elem\.json$/i, '')
}

/** 节点类型显示名（元素实例 → 元素名；普通节点 → schema 标题） */
export function nodeTypeLabel(node: UINode): string {
  if (node.element) return elementLabelOf(node.element)
  return getUISchema(node.type)?.title ?? node.type
}
