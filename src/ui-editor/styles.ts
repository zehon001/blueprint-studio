/**
 * 样式表（.uss.json）解析与合并（v3 T11.1 · PLAN §3.3）
 *
 * 合并顺序（从低到高）：基础控件 schema 默认值 → 样式类（按 styles 数组顺序、
 * 表内声明顺序）→ 节点内联 layout/container/props。
 *
 * v3 修正：v2 资产/旧编辑器会把 schema 默认值物化进 node.props，导致样式类永远
 * 被「默认值」压过。现在：
 *  - 新建节点只写显式值（默认值由解析器补齐）；
 *  - 载入 v3 资产时 stripDefaultProps 去掉与默认值相同的存储值；
 *  - 渲染/检视统一走 resolveNodeStyle，并返回每个值的来源（default/class/inline）。
 */
import type { UIContainer, UILayout, UINode } from '@/ir/types'
import { getUISchema } from './schema'

export interface StyleClassDef {
  props?: Record<string, unknown>
  layout?: UILayout
  container?: UIContainer
}

export interface StyleSheet {
  version: number
  classes: Record<string, StyleClassDef>
}

/** 值来源（检视器「有效值 / 覆盖来源」与样式高亮用） */
export interface StyleSource {
  kind: 'default' | 'class' | 'inline'
  /** kind='class'：命中的类名 */
  className?: string
  /** kind='class'：样式表下标（styles 数组顺序） */
  sheetIndex?: number
}

/** 一次样式解析的结果（有效值 + 来源 + 命中的类） */
export interface StyleResolution {
  props: Record<string, unknown>
  layout: UILayout
  container: UIContainer
  /** 键 = props 属性 id / `layout.<field>` / `container.<field>` */
  sources: Record<string, StyleSource>
  /** 当前节点命中的样式类（按 styles 数组顺序、表内声明顺序） */
  classes: Array<{ className: string; sheetIndex: number; def: StyleClassDef }>
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
  if (obj.version !== undefined && obj.version !== 1) {
    throw new Error(`样式表版本不识别：${String(obj.version)}（仅支持 version 1）`)
  }
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

/* ============================================================
 * schema 默认值
 * ============================================================ */

/** 不落在 props 上的公共字段（name/position/size/rotation 有独立存储位置） */
const NON_PROP_IDS: ReadonlySet<string> = new Set(['name', 'position', 'size', 'rotation'])

function cloneJson<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v)) as T
}

/** 某控件类型的 schema 默认 props（仅落在 UINode.props 的字段；深拷贝） */
export function schemaDefaultProps(type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const schema = getUISchema(type)
  if (!schema) return out
  for (const def of schema.props) {
    if (NON_PROP_IDS.has(def.id)) continue
    if (def.default !== undefined) out[def.id] = cloneJson(def.default)
  }
  return out
}

/** 节点 → 补全 schema 默认 props 的视图（不修改原节点） */
export function withSchemaDefaults(node: UINode): UINode {
  const defaults = schemaDefaultProps(node.type)
  if (Object.keys(defaults).length === 0) return node
  return { ...node, props: { ...defaults, ...(node.props ?? {}) } }
}

/** JSON 语义深比较（default 值与存储值判定） */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 去掉与 schema 默认值相同的存储 props（v3 载入迁移）。
 * 只处理基础控件；元素实例（__element）与未知类型原样保留。递归子树。
 */
export function stripDefaultProps(node: UINode): UINode {
  const defaults = schemaDefaultProps(node.type)
  let props = node.props
  if (Object.keys(defaults).length > 0 && props) {
    const next: Record<string, unknown> = {}
    let changed = false
    for (const [key, value] of Object.entries(props)) {
      if (key in defaults && sameValue(value, defaults[key])) {
        changed = true
        continue
      }
      next[key] = value
    }
    if (changed) props = next
  }
  const children = (node.children ?? []).map(stripDefaultProps)
  const childrenChanged = children.some((c, i) => c !== node.children[i])
  if (!childrenChanged && props === node.props) return node
  return { ...node, ...(props !== node.props ? { props } : {}), children }
}

/* ============================================================
 * 样式解析
 * ============================================================ */

/**
 * 解析节点有效样式：默认值 → 样式类 → 节点内联。
 * 无 classes 时仍返回 schema 默认值（渲染器据此显示默认文本/尺寸等）。
 */
export function resolveNodeStyle(node: UINode, sheets: readonly StyleSheet[]): StyleResolution {
  const props: Record<string, unknown> = {}
  const layout: UILayout = {}
  const container: UIContainer = {}
  const sources: Record<string, StyleSource> = {}
  const hits: Array<{ className: string; sheetIndex: number; def: StyleClassDef }> = []

  // 1) schema 默认值
  for (const [key, value] of Object.entries(schemaDefaultProps(node.type))) {
    props[key] = value
    sources[key] = { kind: 'default' }
  }

  // 2) 样式类（styles 数组顺序 → 表内声明顺序）
  const classSet = new Set(node.classes ?? [])
  sheets.forEach((sheet, sheetIndex) => {
    for (const [className, def] of Object.entries(sheet.classes)) {
      if (!classSet.has(className)) continue
      hits.push({ className, sheetIndex, def })
      if (def.props) {
        for (const [key, value] of Object.entries(def.props)) {
          props[key] = value
          sources[key] = { kind: 'class', className, sheetIndex }
        }
      }
      if (def.layout) {
        for (const [key, value] of Object.entries(def.layout)) {
          ;(layout as Record<string, unknown>)[key] = value
          sources[`layout.${key}`] = { kind: 'class', className, sheetIndex }
        }
      }
      if (def.container) {
        for (const [key, value] of Object.entries(def.container)) {
          ;(container as Record<string, unknown>)[key] = value
          sources[`container.${key}`] = { kind: 'class', className, sheetIndex }
        }
      }
    }
  })

  // 3) 节点内联覆盖
  for (const [key, value] of Object.entries(node.props ?? {})) {
    props[key] = value
    sources[key] = { kind: 'inline' }
  }
  for (const [key, value] of Object.entries(node.layout ?? {})) {
    ;(layout as Record<string, unknown>)[key] = value
    sources[`layout.${key}`] = { kind: 'inline' }
  }
  for (const [key, value] of Object.entries(node.container ?? {})) {
    ;(container as Record<string, unknown>)[key] = value
    sources[`container.${key}`] = { kind: 'inline' }
  }

  return { props, layout, container, sources, classes: hits }
}

/**
 * 合并节点样式类（返回新节点；无 classes 也补 schema 默认值）。
 * 兼容旧 API：渲染器仍调用本函数。
 */
export function mergeStyledNode(node: UINode, sheets: readonly StyleSheet[]): UINode {
  const resolved = resolveNodeStyle(node, sheets)
  return {
    ...node,
    props: resolved.props,
    ...(Object.keys(resolved.layout).length > 0 ? { layout: resolved.layout } : {}),
    ...(Object.keys(resolved.container).length > 0 ? { container: resolved.container } : {}),
  }
}

/**
 * 只应用样式类定义（不补 schema 默认值、不重放内联）。
 * 供元素根使用：元素根仍需参与宿主样式解析，不能提前把默认值物化。
 */
export function applyClassStyles(node: UINode, sheets: readonly StyleSheet[]): UINode {
  const classSet = new Set(node.classes ?? [])
  if (classSet.size === 0 || sheets.length === 0) return node
  const props = { ...(node.props ?? {}) }
  let layout: UILayout = { ...(node.layout ?? {}) }
  let container: UIContainer = { ...(node.container ?? {}) }
  let hit = false
  for (const sheet of sheets) {
    for (const [name, def] of Object.entries(sheet.classes)) {
      if (!classSet.has(name)) continue
      hit = true
      if (def.props) Object.assign(props, def.props)
      if (def.layout) layout = { ...layout, ...def.layout }
      if (def.container) container = { ...container, ...def.container }
    }
  }
  if (!hit) return node
  return { ...node, props, layout, container }
}

/** 一次性解析多个样式表文本（顺序 = styles 数组） */
export function mergeStyleSheets(texts: readonly string[]): StyleSheet[] {
  return texts.map((t) => parseStyleSheet(t))
}
