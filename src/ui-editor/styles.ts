/**
 * 样式表（.uss.json）解析与合并（v3 T11.1 · PLAN §3.3）
 *
 * 合并顺序：基础控件默认值（schema）→ 样式类（按 styles 数组顺序、表内声明顺序）
 * → 节点内联 layout/container/props。本模块只做「类 → 节点」的纯合并；默认值与
 * 渲染器由调用方负责。
 */
import type { UIContainer, UILayout, UINode } from '@/ir/types'

export interface StyleClassDef {
  props?: Record<string, unknown>
  layout?: UILayout
  container?: UIContainer
}

export interface StyleSheet {
  version: number
  classes: Record<string, StyleClassDef>
}

/** 解析 .uss.json（宽松：缺字段视为空；非法 JSON 抛中文错误） */
export function parseStyleSheet(text: string): StyleSheet {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`样式表不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('样式表格式错误：根节点不是对象')
  const obj = raw as { version?: unknown; classes?: unknown }
  const classes: Record<string, StyleClassDef> = {}
  if (obj.classes && typeof obj.classes === 'object') {
    for (const [name, def] of Object.entries(obj.classes as Record<string, unknown>)) {
      if (!def || typeof def !== 'object') continue
      const d = def as StyleClassDef
      classes[name] = {
        ...(d.props && typeof d.props === 'object' ? { props: { ...d.props } } : {}),
        ...(d.layout && typeof d.layout === 'object' ? { layout: { ...d.layout } } : {}),
        ...(d.container && typeof d.container === 'object' ? { container: { ...d.container } } : {}),
      }
    }
  }
  return { version: typeof obj.version === 'number' ? obj.version : 1, classes }
}

/**
 * 合并节点样式类（返回新节点；无 classes 时原样返回）。
 * 同一张表内按 classes 声明顺序合并；跨表按 styles 数组顺序。
 */
export function mergeStyledNode(node: UINode, sheets: readonly StyleSheet[]): UINode {
  const classes = node.classes
  if (!classes || classes.length === 0 || sheets.length === 0) return node
  const set = new Set(classes)
  const props: Record<string, unknown> = {}
  let layout: UILayout = {}
  let container: UIContainer = {}
  let hit = false
  for (const sheet of sheets) {
    for (const [name, def] of Object.entries(sheet.classes)) {
      if (!set.has(name)) continue
      hit = true
      if (def.props) Object.assign(props, def.props)
      if (def.layout) layout = { ...layout, ...def.layout }
      if (def.container) container = { ...container, ...def.container }
    }
  }
  if (!hit) return node
  return {
    ...node,
    props: { ...props, ...node.props },
    layout: { ...layout, ...(node.layout ?? {}) },
    container: { ...container, ...(node.container ?? {}) },
  }
}

/** 一次性解析多个样式表文本（顺序 = styles 数组） */
export function mergeStyleSheets(texts: readonly string[]): StyleSheet[] {
  return texts.map((t) => parseStyleSheet(t))
}
