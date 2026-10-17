/**
 * 快捷键注册框架（T0.5 · T7.1 · PLAN §6.3 / §15）
 *
 * - 归一化：大小写 / 修饰键顺序不敏感，规范形如 'Ctrl+Shift+Z'、'F5'；
 *   Ctrl 与 Meta/Cmd 等价（mac 习惯），Alt 与 Option 等价
 * - 冲突检测：同一组合键默认只允许一个快捷键 id 占用；冲突时 registerShortcut
 *   返回 { ok:false, conflicts } 且不注册；{ force:true } 可强制共存，
 *   getConflicts() 持续汇报冲突供设置界面提示
 * - 事件适配：attachKeyboard(container) 监听 keydown，映射到已注册快捷键执行
 *   handler；已处理的键 preventDefault + stopPropagation；内层组件已处理过的
 *   事件（defaultPrevented === true）跳过，避免与 CodeMirror 等双重响应
 * - 上下文键（T7.1）：画布族操作（复制/剪切/粘贴/删除等）由内层交互自行派发
 *   （自带文本编辑区守卫），注册仅为设置界面展示与改键冲突保护；
 *   attachKeyboard 派发时跳过 contextual 项，不拦截事件（画布现状不受影响）
 * - 改键（T7.1）：rebindShortcut 冲突预检后整组替换绑定；registerDefaultShortcut
 *   供入口级默认项（run.* / settings.open）记入回放表，resetShortcuts 重建默认表
 * - 内置默认注册：edit.undo（Ctrl+Z）、edit.redo（Ctrl+Shift+Z 与 Ctrl+Y
 *   双绑定同 id，互不冲突）、file.save（Ctrl+S，handler 暂为空实现待接线）、
 *   复制粘贴族上下文键（PLAN §6.3/§15 全表，handler 待「编辑上下文」接线）
 */
import type { CommandDomain } from '../commands'
import { redo as commandRedo, undo as commandUndo } from '../commands'

/** 快捷键定义 */
export interface ShortcutDef {
  /** 稳定 id（如 'edit.undo'），设置界面与默认表以此为主键 */
  id: string
  /** 展示名（如「撤销」） */
  label: string
  /** 组合键串（如 'Ctrl+Z' / 'Ctrl+Shift+Z' / 'F5'，大小写与顺序不敏感） */
  keys: string
  /** 所属命令域（可选，仅用于设置界面分组 / 上下文启用，不参与冲突判定） */
  domain?: CommandDomain
  /**
   * 上下文键标记（T7.1）：画布等内层交互自行派发的操作（复制/剪切/粘贴/删除等，
   * 它们自带文本编辑区守卫，全局拦截会破坏输入框 / CodeMirror 的原生编辑）。
   * 注册仅为设置界面展示与改键冲突保护；attachKeyboard 派发时跳过本类项。
   * 缺省 false = 全局派发。
   */
  contextual?: boolean
  /** 触发回调 */
  handler: () => void
}

/** 注册结果：冲突时 ok=false 并给出占用该组合键的既有快捷键 id 列表 */
export type RegisterResult = { ok: true } | { ok: false; conflicts: string[] }

/** 一处组合键冲突（多个 id 共用同一组合键，经 force 注册产生） */
export interface ShortcutConflict {
  keys: string
  ids: string[]
}

/** 设置界面用的快捷键汇总条目（一个 id 可绑定多个组合键） */
export interface ShortcutGroup {
  id: string
  label: string
  domain?: CommandDomain
  /** 规范化的组合键列表（如 ['Ctrl+Shift+Z', 'Ctrl+Y']） */
  bindings: string[]
  /** 上下文键标记（设置界面展示「上下文」徽标，见 ShortcutDef.contextual） */
  contextual?: boolean
}

/** 键盘事件子集（与 DOM KeyboardEvent 结构兼容，测试可用普通对象） */
export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
}

/* ---------------- 组合键归一化 ---------------- */

/** 修饰键别名 → 规范名（meta/cmd/win/super 与 ctrl 等价，option 与 alt 等价） */
const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  meta: 'Ctrl',
  cmd: 'Ctrl',
  command: 'Ctrl',
  win: 'Ctrl',
  super: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}
/** 规范修饰键展示顺序：Ctrl → Alt → Shift */
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift']

/** 常用键名别名 → 规范名（定义串与 event.key 均先转小写再查此表，统一大小写） */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  tab: 'Tab',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  space: 'Space',
  ' ': 'Space',
  plus: '+',
  minus: '-',
  comma: ',',
  period: '.',
  slash: '/',
}

/** 归一化单个键名：字母大写 / F 键规范 / 常用别名；修饰键名返回 ''（不是主键） */
function normalizeKeyPart(raw: string): string {
  const lower = raw.toLowerCase()
  if (MODIFIER_ALIASES[lower] !== undefined) return ''
  const alias = KEY_ALIASES[lower]
  if (alias !== undefined) return alias
  if (/^f\d{1,2}$/.test(lower)) return 'F' + lower.slice(1)
  if (raw.length === 1) return raw.toUpperCase()
  return raw // 其余命名键（Enter/Escape/Home…）保持原样
}

/**
 * 归一化组合键字符串：'z+ctrl'、'CTRL + Z'、'meta+z' → 'Ctrl+Z'
 * 格式非法（无主键 / 多个主键）抛错；主键为 '+' 需写作 'Ctrl+Plus'
 */
export function normalizeKeys(keys: string): string {
  const parts = keys
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) throw new Error(`快捷键格式非法：「${keys}」`)
  const mods: string[] = []
  let key: string | null = null
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod !== undefined) {
      if (!mods.includes(mod)) mods.push(mod)
      continue
    }
    if (key !== null) throw new Error(`快捷键格式非法（出现多个主键）：「${keys}」`)
    key = normalizeKeyPart(part)
  }
  if (key === null || key.length === 0) throw new Error(`快捷键缺少主键：「${keys}」`)
  return [...MODIFIER_ORDER.filter((m) => mods.includes(m)), key].join('+')
}

/** 从键盘事件构造规范组合键；纯修饰键按下返回 null */
export function comboFromEvent(e: KeyEventLike): string | null {
  const key = normalizeKeyPart(e.key)
  if (key.length === 0) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl') // Meta（mac Cmd）与 Ctrl 等价
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/* ---------------- 注册表 ---------------- */

/** id → 该快捷键的全部绑定（同 id 可绑多个组合键，如 edit.redo） */
const defsById = new Map<string, ShortcutDef[]>()
/** 规范组合键 → 绑定列表（force 注册时可能含多个不同 id） */
const defsByCombo = new Map<string, ShortcutDef[]>()

/** 摘除某 id 在指定组合键上的旧绑定（幂等重注册用） */
function unbindCombo(id: string, combo: string): void {
  const byId = defsById.get(id)
  if (byId) {
    const rest = byId.filter((d) => normalizeKeys(d.keys) !== combo)
    if (rest.length > 0) defsById.set(id, rest)
    else defsById.delete(id)
  }
  const byCombo = defsByCombo.get(combo)
  if (byCombo) {
    const rest = byCombo.filter((d) => d.id !== id)
    if (rest.length > 0) defsByCombo.set(combo, rest)
    else defsByCombo.delete(combo)
  }
}

/**
 * 注册快捷键。同一组合键已被其它 id 占用时返回冲突报告（不注册）；
 * { force: true } 强制共存（getConflicts 可查）。同 id 同组合键重复注册为幂等替换。
 */
export function registerShortcut(def: ShortcutDef, opts: { force?: boolean } = {}): RegisterResult {
  if (typeof def.id !== 'string' || def.id.length === 0) throw new Error('快捷键定义缺少 id')
  if (typeof def.label !== 'string' || def.label.length === 0) throw new Error(`快捷键 ${def.id} 缺少 label`)
  if (typeof def.handler !== 'function') throw new Error(`快捷键 ${def.id} 缺少 handler`)
  const combo = normalizeKeys(def.keys)

  unbindCombo(def.id, combo) // 先摘除本 id 在该组合键上的旧绑定（幂等重注册）
  const occupied = defsByCombo.get(combo) ?? []
  const conflicts = [...new Set(occupied.map((d) => d.id))]
  if (conflicts.length > 0 && !opts.force) {
    return { ok: false, conflicts }
  }
  defsById.set(def.id, [...(defsById.get(def.id) ?? []), def])
  defsByCombo.set(combo, [...occupied, def])
  return { ok: true }
}

/** 注销快捷键的全部绑定；返回是否存在过 */
export function unregisterShortcut(id: string): boolean {
  const defs = defsById.get(id)
  if (!defs) return false
  for (const def of defs) {
    const combo = normalizeKeys(def.keys)
    const rest = (defsByCombo.get(combo) ?? []).filter((d) => d.id !== id)
    if (rest.length > 0) defsByCombo.set(combo, rest)
    else defsByCombo.delete(combo)
  }
  defsById.delete(id)
  return true
}

/* ---------------- 冲突与查询（设置界面 T7.1 用） ---------------- */

/** 冲突预检（不注册）：返回占用该组合键的既有快捷键 id */
export function checkConflicts(keys: string, ignoreId?: string): string[] {
  const combo = normalizeKeys(keys)
  return [...new Set((defsByCombo.get(combo) ?? []).map((d) => d.id))].filter((id) => id !== ignoreId)
}

/** 当前全部组合键冲突（force 注册的共存项会在此汇报） */
export function getConflicts(): ShortcutConflict[] {
  const out: ShortcutConflict[] = []
  for (const [combo, defs] of defsByCombo) {
    const ids = [...new Set(defs.map((d) => d.id))]
    if (ids.length > 1) out.push({ keys: combo, ids })
  }
  return out
}

/** 取快捷键主绑定（第一个组合键）；不存在返回 undefined */
export function getShortcut(id: string): ShortcutDef | undefined {
  return defsById.get(id)?.[0]
}

/** 取快捷键全部绑定 */
export function getBindings(id: string): ShortcutDef[] {
  return defsById.get(id) ?? []
}

/** 汇总全部快捷键（设置界面 T7.1 用） */
export function listShortcuts(): ShortcutGroup[] {
  const groups: ShortcutGroup[] = []
  for (const [id, defs] of defsById) {
    groups.push({
      id,
      label: defs[0].label,
      ...(defs[0].domain !== undefined ? { domain: defs[0].domain } : {}),
      bindings: defs.map((d) => normalizeKeys(d.keys)),
      ...(defs[0].contextual ? { contextual: true } : {}),
    })
  }
  return groups
}

/**
 * 改键（T7.1 设置界面用）：把 id 的全部绑定替换为单一新组合键。
 * 冲突预检（checkConflicts，忽略自身）不过则拒绝并返回占用者列表，注册表不动；
 * 元数据（label / handler / domain / contextual）沿用原首个绑定。多绑定 id
 * （如 edit.redo）改键后收拢为单组合键，「恢复默认表」（resetShortcuts）可还原。
 */
export function rebindShortcut(id: string, keys: string): RegisterResult {
  const defs = defsById.get(id)
  if (defs === undefined || defs.length === 0) throw new Error(`快捷键不存在：${id}`)
  const combo = normalizeKeys(keys)
  const conflicts = checkConflicts(combo, id)
  if (conflicts.length > 0) return { ok: false, conflicts }
  const base = defs[0]
  unregisterShortcut(id)
  registerShortcut({ ...base, keys: combo })
  return { ok: true }
}

/* ---------------- 键盘事件适配 ---------------- */

/**
 * 把容器的 keydown 映射到已注册快捷键：命中即执行 handler 并
 * preventDefault + stopPropagation；返回解绑函数。
 */
export function attachKeyboard(container: HTMLElement | Window): () => void {
  const target: EventTarget = container
  const listener = (ev: Event): void => {
    const e = ev as KeyboardEvent
    if (e.defaultPrevented) return // 内层组件已处理（如 CodeMirror），不重复响应
    const combo = comboFromEvent(e)
    if (combo === null) return
    const defs = defsByCombo.get(combo)
    if (defs === undefined || defs.length === 0) return
    // 上下文键不入全局派发（T7.1）：由画布等内层交互自行处理，此处仅占表做冲突保护
    const dispatchable = defs.filter((d) => !d.contextual)
    if (dispatchable.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    for (const def of dispatchable) {
      try {
        def.handler()
      } catch (err) {
        console.error(`[keymap] 快捷键 ${def.id} 处理失败`, err)
      }
    }
  }
  target.addEventListener('keydown', listener)
  return () => target.removeEventListener('keydown', listener)
}

/* ---------------- 内置默认快捷键 ---------------- */

/** 上下文键默认表（T7.1 · PLAN §6.3/§15「复制粘贴」族；画布派发自有文本编辑区守卫，此处仅入表） */
const CONTEXT_DEFAULTS: ReadonlyArray<{ id: string; label: string; keys: string[] }> = [
  { id: 'edit.copy', label: '复制', keys: ['Ctrl+C'] },
  { id: 'edit.cut', label: '剪切', keys: ['Ctrl+X'] },
  { id: 'edit.paste', label: '粘贴', keys: ['Ctrl+V'] },
  { id: 'edit.duplicate', label: '复制副本', keys: ['Ctrl+D'] },
  { id: 'edit.selectAll', label: '全选', keys: ['Ctrl+A'] },
  { id: 'edit.delete', label: '删除选中', keys: ['Delete', 'Backspace'] },
]

/** 入口级默认注册回放表：resetShortcuts 重建默认表时按此恢复（内置表之外、各入口自行注册的默认项） */
const entryDefaults: { def: ShortcutDef; opts: { force?: boolean } }[] = []

/**
 * 注册「默认表级」快捷键（T7.1）：内置表之外的入口注册（main.tsx 的 run.*、
 * 设置面板的 settings.open 等）改用本函数——立即生效，并记入回放表，
 * resetShortcuts（设置面板「恢复默认」）重建时自动还原，入口默认键位不丢。
 * 同 id 重复注册替换回放项（重放语义 = 最后注册者为准）。
 */
export function registerDefaultShortcut(def: ShortcutDef, opts: { force?: boolean } = {}): RegisterResult {
  const result = registerShortcut(def, opts)
  if (result.ok) {
    const i = entryDefaults.findIndex((e) => e.def.id === def.id)
    if (i >= 0) entryDefaults.splice(i, 1)
    entryDefaults.push({ def, opts })
  }
  return result
}

/** 注册内置默认快捷键（幂等：重复调用按同 id 同组合键替换） */
export function registerDefaultShortcuts(): void {
  registerShortcut({
    id: 'edit.undo',
    label: '撤销',
    keys: 'Ctrl+Z',
    handler: () => commandUndo(),
  })
  // 重做双绑定：Ctrl+Shift+Z（Godot/Win 习惯）与 Ctrl+Y，同 id 不构成冲突
  registerShortcut({
    id: 'edit.redo',
    label: '重做',
    keys: 'Ctrl+Shift+Z',
    handler: () => commandRedo(),
  })
  registerShortcut({
    id: 'edit.redo',
    label: '重做',
    keys: 'Ctrl+Y',
    handler: () => commandRedo(),
  })
  // 保存当前编辑目标（tab 脏标记 ● + 序列化）待接：T0.7 文件面板 / M1 保存链路
  registerShortcut({
    id: 'file.save',
    label: '保存',
    keys: 'Ctrl+S',
    handler: () => {
      /* 待接：保存当前编辑目标 */
    },
  })
  // 复制粘贴族上下文键入表（T7.1 全表）：handler 待「编辑上下文」接线卡接
  // （画布现状由 useCanvasInteractions 自行派发，attachKeyboard 不派发本组，行为不变）
  for (const ctx of CONTEXT_DEFAULTS) {
    for (const keys of ctx.keys) {
      registerShortcut({
        id: ctx.id,
        label: ctx.label,
        keys,
        contextual: true,
        handler: () => {
          /* 待接：编辑上下文派发（复制/剪切/粘贴/删除/副本/全选） */
        },
      })
    }
  }
}

/** 清空注册表并恢复默认表（应用启动 / 测试重置 / 设置面板「恢复默认」用）：
 *  内置默认 + 入口级默认项回放（registerDefaultShortcut 记录者，如 run.* / settings.open） */
export function resetShortcuts(): void {
  defsById.clear()
  defsByCombo.clear()
  registerDefaultShortcuts()
  for (const { def, opts } of entryDefaults) registerShortcut(def, opts)
}
