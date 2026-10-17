/**
 * 检视器纯函数层（T1.5 · PLAN §7.3）
 *
 * 无 React / DOM 依赖（node:test 可直接单测）：
 *  - storeLocation：PropDef → UINode 存储位置映射（ADR-005：可编辑属性统一在 UINode；
 *    name → UINode.name、position/size/rotation → UINode.transform、其余 → UINode.props）；
 *  - readRawProp / readProp / writeProp：按存储位置读写（writeProp 供 runUICommand 的
 *    immer 配方直接改草稿，写出的补丁即入命令栈可撤销）；
 *  - writePropsOnNodes：批量写入（多选「单命令应用到全部节点」的配方体，vec2/size 支持增量合并）；
 *  - intersectPropDefs：多选共同属性（id + 控件类型 + 分组三者都相同才算共同，其余跳过）；
 *  - propRowStates：属性行值状态（值全部相同 → 显示值；任一不同 → 混合态 mixed「—」）；
 *  - filterPropDefs：属性搜索（label / id 包含匹配，大小写不敏感）；
 *  - groupPropRows：按 PropDef.group 分组（组序 PROP_GROUP_ORDER，未列出的分组按出现序排后）；
 *  - effectiveDisabled / findUIParent：disabled 的父级语义——position 在根节点 / 自由容器
 *    （panel / scrollBox）内解锁，位于流式容器内置灰（对应 PropDef.disabled 的注释约定）；
 *  - parseListColumnsJson / parseOptionsLines：listColumns JSON 校验与 options 行解析；
 *  - propCommandLabel：命令 label（前缀「检视器：」，多选「批量修改 <属性> N 个」）。
 *
 * 契约真源：src/ir/types.ts（UINode / UITransform）与 src/ui-editor/schema（PropDef / ListColumn）。
 */
import type { UINode } from '@/ir/types'
import { PROP_GROUP_ORDER, type ColorRule, type ListColumn, type PropDef } from '@/ui-editor/schema'

/* ============================================================
 * 1. PropDef → 存储位置映射（DoD：storeLocation 纯函数）
 * ============================================================ */

/** 属性在 UINode 中的存储位置（ADR-005：可编辑属性全部在 UINode 上） */
export type PropStoreLocation =
  /** UINode.name（树内唯一名） */
  | { kind: 'name' }
  /** UINode.transform 的 position / size / rotation 字段 */
  | { kind: 'transform'; field: 'position' | 'size' | 'rotation' }
  /** UINode.props[def.id]（业务属性与其余公共属性） */
  | { kind: 'props' }

/** transform 直存字段（公共组：position / size / rotation） */
const TRANSFORM_FIELDS: ReadonlySet<string> = new Set(['position', 'size', 'rotation'])

/**
 * PropDef → 存储位置（纯映射，无副作用）：
 * name → UINode.name；position/size/rotation → UINode.transform.<field>；其余 → UINode.props。
 */
export function storeLocation(def: PropDef): PropStoreLocation {
  if (def.id === 'name') return { kind: 'name' }
  if (TRANSFORM_FIELDS.has(def.id)) {
    return { kind: 'transform', field: def.id as 'position' | 'size' | 'rotation' }
  }
  return { kind: 'props' }
}

/** 按存储位置读取「已写入」值（未写入返回 undefined，不回落默认值——合并增量补丁时用） */
export function readRawProp(node: UINode, def: PropDef): unknown {
  const loc = storeLocation(def)
  if (loc.kind === 'name') return node.name
  if (loc.kind === 'transform') return node.transform?.[loc.field]
  return node.props?.[def.id]
}

/** 按存储位置读取生效值（未写入回落 PropDef.default，多选混合态基准与 T2.4 口径一致） */
export function readProp(node: UINode, def: PropDef): unknown {
  const raw = readRawProp(node, def)
  return raw !== undefined ? raw : def.default
}

/** 按存储位置写入（在 runUICommand 的 immer 配方内对草稿节点调用；兼容缺失 transform 的旧资产） */
export function writeProp(node: UINode, def: PropDef, value: unknown): void {
  const loc = storeLocation(def)
  if (loc.kind === 'name') {
    node.name = value as string
  } else if (loc.kind === 'transform') {
    if (!node.transform) {
      node.transform = { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 }
    }
    ;(node.transform as unknown as Record<string, unknown>)[loc.field] = value
  } else {
    node.props[def.id] = value
  }
}

/* ============================================================
 * 2. 批量写入（多选单命令的配方体）
 * ============================================================ */

/**
 * 将一个属性值批量写入 ids 对应的全部节点（runUICommand 配方体内调用）：
 *  - partialMerge = true（vec2 / size）：value 是增量补丁（如 {x: 5}），与各节点当前值合并后
 *    写入——批量改 X 时不覆盖各节点自己的 Y；
 *  - 返回实际写入的节点数（id 不在树内的跳过）。
 */
export function writePropsOnNodes(
  root: UINode,
  ids: readonly string[],
  def: PropDef,
  value: unknown,
  partialMerge = false,
): number {
  let applied = 0
  for (const id of ids) {
    const node = findUINodeIn(root, id)
    if (!node) continue
    let final = value
    if (partialMerge) {
      const cur = readRawProp(node, def)
      final = {
        ...(cur && typeof cur === 'object' ? (cur as Record<string, unknown>) : {}),
        ...(value && typeof value === 'object' ? (value as Record<string, unknown>) : {}),
      }
    }
    writeProp(node, def, final)
    applied += 1
  }
  return applied
}

/** 递归查找节点（与 src/ui-editor/store.ts 的 findUINode 同语义；本层自带避免依赖链） */
export function findUINodeIn(root: UINode, id: string): UINode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findUINodeIn(c, id)
    if (hit) return hit
  }
  return null
}

/** 递归查找某节点的父节点（根节点返回 null） */
export function findUIParent(root: UINode, id: string): UINode | null {
  for (const c of root.children) {
    if (c.id === id) return root
    const hit = findUIParent(c, id)
    if (hit) return hit
  }
  return null
}

/* ============================================================
 * 3. 多选共同属性与混合态
 * ============================================================ */

/** 属性行状态：value 仅在全部选中节点值相同时有效；mixed = true → 控件显示「—」 */
export interface PropRowState {
  def: PropDef
  value: unknown
  mixed: boolean
}

/** JSON 语义深比较（undefined 与 null 同义） */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 多选节点的共同属性定义（DoD：显示共同属性，非共同跳过）：
 *  - 空列表 → []；单列表 → 原样拷贝；
 *  - 以第一个节点的属性表为基准，仅保留**每个**节点 schema 都声明、且
 *    id + 控件类型（type）+ 分组（group）都相同的属性——同名不同型（如 optionButton.value
 *    是 string 而 spinBox.value 是 number）或同名不同组（如 scrollBox.direction 与
 *    separator.direction）语义不同，不作为共同属性混编。
 */
export function intersectPropDefs(lists: readonly (readonly PropDef[])[]): PropDef[] {
  if (lists.length === 0) return []
  if (lists.length === 1) return [...lists[0]!]
  const [first, ...rest] = lists
  const out: PropDef[] = []
  for (const def of first!) {
    const common = rest.every((list) => {
      const other = list.find((d) => d.id === def.id)
      return other !== undefined && other.type === def.type && other.group === def.group
    })
    if (common) out.push(def)
  }
  return out
}

/**
 * 属性行值状态（单选 = mixed 恒 false；多选按值判定）：
 * 生效值 = 已写入值 ?? PropDef.default（与蓝图检视器 T2.4 的 commonParamRows 口径一致）。
 */
export function propRowStates(nodes: readonly UINode[], defs: readonly PropDef[]): PropRowState[] {
  if (nodes.length === 0) return []
  return defs.map((def) => {
    const values = nodes.map((n) => readProp(n, def))
    const mixed = values.some((v) => !jsonEquals(v, values[0]))
    return { def, value: values[0], mixed }
  })
}

/* ============================================================
 * 4. 属性搜索与分组（组头折叠 / 组序 PROP_GROUP_ORDER）
 * ============================================================ */

/**
 * 属性搜索过滤（纯函数）：空关键字返回全部；
 * 匹配规则 = 显示名（label）或属性 id 的包含匹配（大小写不敏感）。
 */
export function filterPropDefs(defs: readonly PropDef[], keyword: string): PropDef[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return [...defs]
  return defs.filter((d) => d.label.toLowerCase().includes(kw) || d.id.toLowerCase().includes(kw))
}

/** 分组后的属性行（组序 = PROP_GROUP_ORDER 在前，未列出的分组按出现序排后） */
export interface PropGroup {
  group: string
  rows: PropRowState[]
}

export function groupPropRows(rows: readonly PropRowState[]): PropGroup[] {
  const order: string[] = []
  const map = new Map<string, PropRowState[]>()
  for (const row of rows) {
    if (!map.has(row.def.group)) {
      map.set(row.def.group, [])
      order.push(row.def.group)
    }
    map.get(row.def.group)!.push(row)
  }
  const known = (PROP_GROUP_ORDER as readonly string[]).filter((g) => map.has(g))
  const extra = order.filter((g) => !(PROP_GROUP_ORDER as readonly string[]).includes(g))
  return [...known, ...extra].map((group) => ({ group, rows: map.get(group)! }))
}

/* ============================================================
 * 5. disabled 的父级语义（flow 节点的 position 按实际父级解锁）
 * ============================================================ */

/** 自由布局父容器（其子节点自由定位 → position 解锁；其余容器为流式 / 页式排列） */
export const FREE_LAYOUT_PARENTS = ['panel', 'scrollBox'] as const

/**
 * 属性是否置灰（DoD：PropDef.disabled 属性置灰，如 flow 型节点的 position）：
 *  - position 特例（PropDef.disabled 注释约定）：根节点或位于自由容器（panel/scrollBox）内
 *    → 解锁；位于流式容器（vbox/hbox/grid/tab/split 等）内 → 置灰；
 *  - 其余属性：按 schema 声明（def.disabled === true）。
 */
export function effectiveDisabled(def: PropDef, parent: UINode | null): boolean {
  if (def.id === 'position') {
    if (!parent) return false
    return !(FREE_LAYOUT_PARENTS as readonly string[]).includes(parent.type)
  }
  return def.disabled === true
}

/** 多选行置灰判定：任一选中节点该属性被置灰 → 整行置灰（保守，防误改被接管的属性） */
export function anyRowDisabled(def: PropDef, nodes: readonly UINode[], root: UINode): boolean {
  return nodes.some((n) => effectiveDisabled(def, findUIParent(root, n.id)))
}

/* ============================================================
 * 6. 命令 label（前缀「检视器：」；多选标注批量与数量）
 * ============================================================ */

/** 检视器命令 label：单选「检视器：<属性名>」；多选「检视器：批量修改 <属性> N 个」 */
export function propCommandLabel(def: PropDef, count: number): string {
  return count <= 1 ? `检视器：${def.label}` : `检视器：批量修改 ${def.label} ${count} 个`
}

/* ============================================================
 * 7. 结构化值解析（listColumns JSON 校验 / options 行解析）
 * ============================================================ */

export type ListColumnsParse = { ok: true; value: ListColumn[] } | { ok: false; message: string }

/**
 * listColumns JSON 文本校验（列定义编辑器的提交门槛）：
 * 必须是数组；每列 field / title 必填为非空字符串；width 数值；groupBy / mergeDuplicates 布尔；
 * colorRules 数组且每条 op 合法、value 非空、color 形如 #RGB/#RRGGBB/#RRGGBBAA。
 */
export function parseListColumnsJson(text: string): ListColumnsParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, message: '列定义必须是数组（[ { field, title, … } ]）' }
  if (parsed.length === 0) return { ok: false, message: '至少需要一列' }
  for (let i = 0; i < parsed.length; i += 1) {
    const col = parsed[i] as Partial<ListColumn> | null
    const where = `第 ${i + 1} 列`
    if (!col || typeof col !== 'object') return { ok: false, message: `${where}不是对象` }
    if (typeof col.field !== 'string' || col.field.trim().length === 0) {
      return { ok: false, message: `${where}缺少 field（字段名）` }
    }
    if (typeof col.title !== 'string' || col.title.trim().length === 0) {
      return { ok: false, message: `${where}缺少 title（列标题）` }
    }
    if (col.width !== undefined && (typeof col.width !== 'number' || !Number.isFinite(col.width))) {
      return { ok: false, message: `${where}的 width 必须是数值` }
    }
    if (col.groupBy !== undefined && typeof col.groupBy !== 'boolean') {
      return { ok: false, message: `${where}的 groupBy 必须是布尔值` }
    }
    if (col.mergeDuplicates !== undefined && typeof col.mergeDuplicates !== 'boolean') {
      return { ok: false, message: `${where}的 mergeDuplicates 必须是布尔值` }
    }
    if (col.colorRules !== undefined) {
      if (!Array.isArray(col.colorRules)) return { ok: false, message: `${where}的 colorRules 必须是数组` }
      for (let j = 0; j < col.colorRules.length; j += 1) {
        const rule = col.colorRules[j] as Partial<ColorRule> | null
        const rw = `${where}的 colorRules[${j}]`
        if (!rule || typeof rule !== 'object') return { ok: false, message: `${rw}不是对象` }
        if (!(['eq', 'contains', 'gt', 'lt'] as readonly string[]).includes(String(rule.op))) {
          return { ok: false, message: `${rw}的 op 必须是 eq / contains / gt / lt` }
        }
        if (typeof rule.value !== 'string' || rule.value.length === 0) {
          return { ok: false, message: `${rw}缺少 value（比较目标值）` }
        }
        if (typeof rule.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(rule.color)) {
          return { ok: false, message: `${rw}的 color 必须是 #RRGGBB 等颜色值` }
        }
      }
    }
  }
  return { ok: true, value: parsed as ListColumn[] }
}

/** options（字符串数组）编辑文本 → 数组：按行拆分、去首尾空白、丢弃空行 */
export function parseOptionsLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/* ============================================================
 * 8. 常量
 * ============================================================ */

/** 混合态悬浮说明（控件 title） */
export const MIXED_TITLE = '多个选中节点的值不同（混合态）'

/** 控件覆盖清单（UIPropType 全部成员；未知类型回落文本框） */
export const PROPTYPE_COVERAGE = [
  'number',
  'int',
  'string',
  'bool',
  'select',
  'color',
  'textarea',
  'vec2',
  'size',
  'listColumns',
  'assetRef',
  'logicRef',
  'options',
] as const

/** PropType → 类型徽标文案（属性行的小字类型提示） */
export const PROPTYPE_LABELS: Readonly<Record<string, string>> = {
  number: '数字',
  int: '整数',
  string: '文本',
  bool: '布尔',
  select: '选择',
  color: '颜色',
  textarea: '多行',
  vec2: '向量',
  size: '尺寸',
  listColumns: '列定义',
  assetRef: '资源',
  logicRef: '逻辑',
  options: '选项列表',
}
