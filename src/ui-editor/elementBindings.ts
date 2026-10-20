/**
 * 元素数据绑定（v3.2）——纯函数求值层
 *
 * binding = { target: 元素内部节点 id, attr: UINode.props 键, source: 元素蓝图变量名 }。
 * 求值时机：
 *  - 元素实例展开（含运行时变量变化后的重渲染）；
 *  - 元素编辑器设计预览（变量默认值）；
 *  - 实例变量覆盖变化后，宿主重渲染会重新求值。
 *
 * 约束：
 *  - 单向：变量 → 节点属性；输入控件写回变量仍由元素蓝图事件处理；
 *  - target 用节点 id（重命名安全），attr 只允许业务 props（name/position/size/rotation 除外）；
 *  - 类型不匹配时跳过该条绑定，由元素设置 UI 给出提示，不阻断渲染；
 *  - 展开树必须使用每个实例自己的副本（见 cloneUINode），不能写回元素缓存。
 */
import type {
  ElementAsset,
  ElementBindingDef,
  IRValueType,
  UIAsset,
  UINode,
} from '@/ir/types'
import { isArrayType } from '@/ir/types'
import { getUISchema, type PropDef, type UIPropType } from './schema'

/** 不宜作为绑定目标的结构字段（存在 UINode 顶层 / transform，而非 props） */
const NON_BINDABLE_PROPS: ReadonlySet<string> = new Set(['name', 'position', 'size', 'rotation'])

/* ============================================================
 * 运行时变量镜像（按实例对象区分；编辑器不使用）
 * ============================================================ */

const runtimeVars = new WeakMap<UINode, Record<string, unknown>>()

/** 登记运行时变量的最新镜像（元素实例解释器 setVar 时更新） */
export function setElementRuntimeVars(instance: UINode, vars: Record<string, unknown>): void {
  runtimeVars.set(instance, vars)
}

/** 取运行时变量镜像；未运行 / 非元素实例返回 undefined（回落到实例 vars） */
export function getElementRuntimeVars(instance: UINode): Record<string, unknown> | undefined {
  return runtimeVars.get(instance)
}

export function clearElementRuntimeVars(instance: UINode): void {
  runtimeVars.delete(instance)
}

/* ============================================================
 * 变量默认值 / 节点克隆
 * ============================================================ */

/** IR 变量类型零值（与解释器 zeroValue 同口径） */
export function zeroValueOf(type: IRValueType): unknown {
  switch (type) {
    case 'bool':
      return false
    case 'int':
    case 'float':
      return 0
    case 'string':
      return ''
    case 'object':
      return {}
    default:
      return isArrayType(type) ? [] : null
  }
}

/** 元素变量生效值：声明默认值（省略用类型零值）→ 实例 vars 覆盖 */
export function elementVarValues(
  asset: ElementAsset,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const v of asset.variables ?? []) {
    out[v.name] = v.default !== undefined ? v.default : zeroValueOf(v.type)
  }
  return { ...out, ...(overrides ?? {}) }
}

/** 深拷贝 UINode 子树（展开 / 预览求值必须脱离元素资产缓存） */
export function cloneUINode(node: UINode): UINode {
  return {
    ...node,
    transform: {
      ...node.transform,
      position: { ...node.transform.position },
      size: { ...node.transform.size },
    },
    theme: { ...(node.theme ?? {}) },
    props: { ...(node.props ?? {}) },
    ...(node.layout ? { layout: { ...node.layout } } : {}),
    ...(node.container ? { container: { ...node.container } } : {}),
    ...(node.classes ? { classes: [...node.classes] } : {}),
    ...(node.vars ? { vars: { ...node.vars } } : {}),
    ...(node.events ? { events: [...node.events] } : {}),
    children: (node.children ?? []).map(cloneUINode),
  }
}

export function findNodeById(root: UINode, id: string): UINode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNodeById(c, id)
    if (hit) return hit
  }
  return null
}

/* ============================================================
 * 属性 / 类型
 * ============================================================ */

/** 可绑定属性（排除结构字段；未注册类型返回空） */
export function bindablePropDefs(node: UINode): PropDef[] {
  return (getUISchema(node.type)?.props ?? []).filter((p) => !NON_BINDABLE_PROPS.has(p.id))
}

export function bindingPropDef(node: UINode, attr: string): PropDef | undefined {
  return bindablePropDefs(node).find((p) => p.id === attr)
}

/**
 * 变量类型 → 目标属性类型是否可绑定。
 * 展示类字符串接受标量（int/float/bool 自动格式化）；数值属性只接受数值变量。
 */
export function isBindingCompatible(
  varType: IRValueType,
  propType: UIPropType | undefined,
): boolean {
  if (!propType) return false
  if (varType === 'any') return true
  switch (propType) {
    case 'string':
    case 'textarea':
      return (
        varType === 'string' || varType === 'int' || varType === 'float' || varType === 'bool'
      )
    case 'color':
    case 'select':
    case 'assetRef':
    case 'logicRef':
      return varType === 'string'
    case 'number':
    case 'int':
      return varType === 'int' || varType === 'float'
    case 'bool':
      return varType === 'bool'
    case 'vec2':
    case 'size':
      return varType === 'object'
    case 'listColumns':
    case 'options':
      return isArrayType(varType)
    default:
      return false
  }
}

/** 绑定值转换结果 */
export type BindingCoercion =
  | { ok: true; value: unknown }
  | { ok: false; reason: string }

/** 变量值 → 目标属性值（显示转换；失败时跳过该绑定） */
export function coerceBindingValue(
  value: unknown,
  propType: UIPropType,
): BindingCoercion {
  if (value === undefined) return { ok: false, reason: '变量值为 undefined' }
  switch (propType) {
    case 'string':
    case 'textarea':
      if (typeof value === 'object' && value !== null) {
        return { ok: false, reason: '对象 / 数组不能写入文本属性' }
      }
      return { ok: true, value: value === null ? '' : String(value) }
    case 'color':
    case 'select':
    case 'assetRef':
    case 'logicRef':
      if (typeof value === 'object') return { ok: false, reason: '该属性只接受字符串' }
      return { ok: true, value: value === null ? '' : String(value) }
    case 'number':
    case 'int': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      if (!Number.isFinite(n)) return { ok: false, reason: '变量值不是有效数字' }
      return { ok: true, value: propType === 'int' ? Math.trunc(n) : n }
    }
    case 'bool':
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' }
      return { ok: false, reason: '该属性只接受布尔值' }
    case 'vec2':
      if (typeof value === 'object' && value !== null) {
        const v = value as { x?: unknown; y?: unknown }
        if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
          return { ok: true, value: { x: Number(v.x), y: Number(v.y) } }
        }
      }
      return { ok: false, reason: '该属性需要 {x, y}' }
    case 'size':
      if (typeof value === 'object' && value !== null) {
        const v = value as { w?: unknown; h?: unknown }
        if (Number.isFinite(v.w) && Number.isFinite(v.h)) {
          return { ok: true, value: { w: Number(v.w), h: Number(v.h) } }
        }
      }
      return { ok: false, reason: '该属性需要 {w, h}' }
    case 'listColumns':
    case 'options':
      return Array.isArray(value)
        ? { ok: true, value }
        : { ok: false, reason: '该属性需要数组' }
    default:
      return { ok: true, value }
  }
}

/* ============================================================
 * 求值
 * ============================================================ */

/** 绑定目标在展开树中的有效 id：实例内部节点带 `<实例 id>::` 前缀；预览无前缀 */
function effectiveTargetId(
  elementRootId: string,
  target: string,
  instanceId: string | null,
): string {
  if (instanceId === null) return target
  return target === elementRootId ? instanceId : `${instanceId}::${target}`
}

/**
 * 把绑定写入展开树 / 预览树的副本（就地修改传入副本）。
 * instanceId = null 表示元素编辑器预览（id 不作用域化）。
 */
export function applyElementBindings(
  root: UINode,
  asset: ElementAsset,
  vars: Record<string, unknown>,
  instanceId: string | null,
): void {
  const bindings = asset.bindings ?? []
  if (bindings.length === 0) return
  const byId = new Map<string, UINode>()
  const walk = (node: UINode): void => {
    byId.set(node.id, node)
    for (const c of node.children ?? []) walk(c)
  }
  walk(root)
  for (const b of bindings) {
    const node = byId.get(effectiveTargetId(asset.root.id, b.target, instanceId))
    if (!node) continue
    const def = bindingPropDef(node, b.attr)
    if (!def) continue
    const coerced = coerceBindingValue(vars[b.source], def.type)
    if (!coerced.ok) continue
    node.props = { ...(node.props ?? {}), [b.attr]: coerced.value }
  }
}

/** 元素编辑器设计预览：克隆根并把变量默认值写入绑定目标（不修改资产本体） */
export function previewElementAsset(asset: ElementAsset): UIAsset {
  const root = cloneUINode(asset.root)
  applyElementBindings(root, asset, elementVarValues(asset), null)
  return { ...asset, root }
}

/* ============================================================
 * 校验（元素设置 UI 展示）
 * ============================================================ */

/** 单条绑定的问题（null = 可用）；index 用于重复目标检测 */
export function bindingIssue(
  asset: ElementAsset,
  binding: ElementBindingDef,
  index?: number,
): string | null {
  const node = findNodeById(asset.root, binding.target)
  if (!node) return '目标节点不存在'
  if (!binding.attr) return '未选择目标属性'
  const def = bindingPropDef(node, binding.attr)
  if (!def) return '目标属性不存在或不可绑定'
  if (!binding.source) return '未选择源变量'
  const variable = (asset.variables ?? []).find((v) => v.name === binding.source)
  if (!variable) return '源变量不存在'
  if (!isBindingCompatible(variable.type, def.type)) {
    return `类型不匹配：${variable.type} → ${def.type}`
  }
  if (
    index !== undefined &&
    (asset.bindings ?? []).some(
      (b, i) => i !== index && b.target === binding.target && b.attr === binding.attr,
    )
  ) {
    return '该节点属性已有绑定'
  }
  return null
}
