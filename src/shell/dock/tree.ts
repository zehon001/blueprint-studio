/**
 * Dock 布局树 —— 纯函数操作集（T0.3 · PLAN §6.2 / §3.1）
 *
 * 布局模型：多叉分裂树（二叉树的自然推广，Godot 式 dock）
 *   DockNode = split（沿 dir 方向切分 children；sizes 为相对权重，flex-grow 语义）
 *            | tabs （一组面板页；panels 为 panelId 列表，active 为当前页下标）
 *   面板叶 = tabs 组中的一个 panelId；tabs 节点带 id 作为组标识（拖放定位 / React key / 持久化）。
 *
 * 约定：
 *   - 全部操作返回新树，不修改入参（可安全用于 zustand setState 与单测断言）；
 *   - 本模块不依赖 DOM / React，可在 node:test 中直接测试；
 *   - removePanel 剪枝空组：被剪组权重并入其后的兄弟（末位则并入前一个），
 *     split 仅剩 1 子时塌缩为该子，整树为空时返回 null（面板可经「面板」菜单重开）；
 *   - 树不变式：panelId 在树中至多出现一次（insertPanel 内置幂等防御）。
 */

/** 分裂方向：h = 左右排列（水平切分），v = 上下排列（垂直切分） */
export type DockDir = 'h' | 'v'

/** 面板默认吸附区（注册面板用；'top' 仅供拖放落点，不在默认区枚举内） */
export type DockArea = 'left' | 'right' | 'bottom' | 'center'

/** 拖放目标：edge = 主窗四边（整树外侧分裂插入）；group = 并入指定 tabs 组 */
export type DropTarget =
  | { kind: 'edge'; side: 'left' | 'right' | 'top' | 'bottom' }
  /** index：插入到该组第 index 个位置（缺省=追加到末尾；同组拖动即标签重排序） */
  | { kind: 'group'; groupId: string; index?: number }

export interface DockSplitNode {
  kind: 'split'
  dir: DockDir
  children: DockNode[]
  /** 相对权重（flex-grow），长度恒等于 children.length */
  sizes: number[]
}

export interface DockTabsNode {
  kind: 'tabs'
  /** 组标识：genTabsId 生成，随布局持久化，供拖放与 React key 定位 */
  id: string
  panels: string[]
  active: number
}

export type DockNode = DockSplitNode | DockTabsNode

/** tabs 组查找结果：node + 从根出发的 children 下标路径 */
export interface DockTabsGroupRef {
  node: DockTabsNode
  path: number[]
}

/** 面板最小尺寸（px）：分隔条拖动与 CSS min-width/min-height 共用此常量 */
export const MIN_PANE_PX = 120

/* ---------------- tabs 组 id ---------------- */

let tabsSeq = 0

/** 生成 tabs 组 id（进程内唯一；持久化后原样保留） */
export function genTabsId(): string {
  tabsSeq += 1
  return `tabs-${Date.now().toString(36)}-${tabsSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 构造 tabs 组节点 */
export function makeTabs(panels: string[], active = 0): DockTabsNode {
  return { kind: 'tabs', id: genTabsId(), panels: [...panels], active }
}

/* ---------------- 归一化 / 校验（反序列化容错） ---------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * 把任意反序列化结果归一化为合法 DockNode；非法/空结构返回 null。
 * - 未知面板 id（不在 knownIds）被剔除；重复 id 去重；active 越界钳制；
 * - split 单子塌缩；sizes 与 children 数不齐或含非正数时回退均分；
 * - knownIds 传 undefined 表示不校验面板存在性（测试 / 信任数据）。
 */
export function normalizeDockNode(raw: unknown, knownIds?: ReadonlySet<string>): DockNode | null {
  if (!isRecord(raw)) return null
  if (raw.kind === 'tabs') {
    const panelsRaw = Array.isArray(raw.panels) ? raw.panels : []
    let panels = panelsRaw.filter((p): p is string => typeof p === 'string')
    if (knownIds) panels = panels.filter((p) => knownIds.has(p))
    panels = [...new Set(panels)]
    if (panels.length === 0) return null
    const activeRaw = typeof raw.active === 'number' && Number.isFinite(raw.active) ? raw.active : 0
    const active = Math.min(Math.max(Math.trunc(activeRaw), 0), panels.length - 1)
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : genTabsId()
    return { kind: 'tabs', id, panels, active }
  }
  if (raw.kind === 'split') {
    if (raw.dir !== 'h' && raw.dir !== 'v') return null
    const childrenRaw = Array.isArray(raw.children) ? raw.children : []
    const children = childrenRaw
      .map((c) => normalizeDockNode(c, knownIds))
      .filter((c): c is DockNode => c !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    const sizesRaw = Array.isArray(raw.sizes) ? raw.sizes : []
    const sizesOk =
      childrenRaw.length === children.length &&
      sizesRaw.length === children.length &&
      sizesRaw.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)
    return {
      kind: 'split',
      dir: raw.dir,
      children,
      sizes: sizesOk ? (sizesRaw as number[]) : children.map(() => 1),
    }
  }
  return null
}

/* ---------------- 查找 ---------------- */

function findTabs(
  root: DockNode | null,
  pred: (node: DockTabsNode) => boolean,
): DockTabsGroupRef | null {
  if (!root) return null
  const queue: { node: DockNode; path: number[] }[] = [{ node: root, path: [] }]
  for (let head = 0; head < queue.length; head += 1) {
    const { node, path } = queue[head]
    if (node.kind === 'tabs') {
      if (pred(node)) return { node, path }
      continue
    }
    node.children.forEach((child, i) => queue.push({ node: child, path: [...path, i] }))
  }
  return null
}

/** 查找包含 panelId 的 tabs 组（文档序 BFS） */
export function findTabsByPanel(root: DockNode | null, panelId: string): DockTabsGroupRef | null {
  return findTabs(root, (n) => n.panels.includes(panelId))
}

/** 按 id 查找 tabs 组 */
export function findTabsById(root: DockNode | null, groupId: string): DockTabsGroupRef | null {
  return findTabs(root, (n) => n.id === groupId)
}

/** 文档序第一个 tabs 组（居中区并入 / 异常兜底用） */
export function firstTabsGroup(root: DockNode | null): DockTabsGroupRef | null {
  return findTabs(root, () => true)
}

/** 按路径取节点；路径越界返回 null */
export function getNodeAtPath(root: DockNode, path: number[]): DockNode | null {
  let cur: DockNode = root
  for (const i of path) {
    if (cur.kind !== 'split' || i < 0 || i >= cur.children.length) return null
    cur = cur.children[i]
  }
  return cur
}

/** 按路径更新节点（不可变：沿途浅拷贝）；路径越界原样返回 */
export function updateAtPath(
  root: DockNode,
  path: number[],
  up: (node: DockNode) => DockNode,
): DockNode {
  if (path.length === 0) return up(root)
  const [head, ...rest] = path
  if (root.kind !== 'split' || head < 0 || head >= root.children.length) return root
  const children = root.children.slice()
  children[head] = updateAtPath(children[head], rest, up)
  return { ...root, children }
}

/* ---------------- 插入 / 移除 / 移动 ---------------- */

/**
 * 插入面板（幂等防御：panelId 已在树中时先摘除再插，保证唯一）。
 * - edge：整树外侧分裂包裹，新组占 1/4（左/上为 [新组, 原树]，右/下为 [原树, 新组]）；
 * - group：并入指定 tabs 组并激活；组 id 悬空时退化为文档序第一个 tabs 组；
 *   整树无 tabs 组时再退化为顶部边插入。
 */
export function insertPanel(root: DockNode | null, panelId: string, target: DropTarget): DockNode {
  const base = removePanel(root, panelId)
  if (target.kind === 'edge') {
    const fresh = makeTabs([panelId])
    if (base === null) return fresh
    const dir: DockDir = target.side === 'left' || target.side === 'right' ? 'h' : 'v'
    const before = target.side === 'left' || target.side === 'top'
    return {
      kind: 'split',
      dir,
      children: before ? [fresh, base] : [base, fresh],
      sizes: before ? [1, 3] : [3, 1],
    }
  }
  const found = findTabsById(base, target.groupId) ?? firstTabsGroup(base)
  if (base !== null && found !== null) {
    return updateAtPath(base, found.path, (n) => {
      const t = n as DockTabsNode
      const panels = [...t.panels]
      const index =
        target.index === undefined
          ? panels.length
          : Math.min(Math.max(Math.trunc(target.index), 0), panels.length)
      panels.splice(index, 0, panelId)
      return { ...t, panels, active: index }
    })
  }
  if (base === null) return makeTabs([panelId])
  // 整树无 tabs 组（异常布局兜底）：作为顶部边插入
  return insertPanel(base, panelId, { kind: 'edge', side: 'top' })
}

function removeRecursive(node: DockNode, panelId: string): DockNode | null {
  if (node.kind === 'tabs') {
    const idx = node.panels.indexOf(panelId)
    if (idx === -1) return node
    const panels = node.panels.filter((_, i) => i !== idx)
    if (panels.length === 0) return null
    let active = node.active
    if (idx < active) active -= 1 // 移除的页在激活页之前：下标前移
    return { ...node, panels, active: Math.min(Math.max(active, 0), panels.length - 1) }
  }
  const children: DockNode[] = []
  const sizes: number[] = []
  let removedWeight = 0
  let firstRemoved = -1
  node.children.forEach((child, i) => {
    const next = removeRecursive(child, panelId)
    if (next === null) {
      removedWeight += node.sizes[i] ?? 0
      if (firstRemoved === -1) firstRemoved = i
      return
    }
    children.push(next)
    sizes.push(node.sizes[i] ?? 0)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  if (removedWeight > 0) {
    // 被剪权重并入其后的兄弟；被剪的是末位时并入前一个
    sizes[Math.min(firstRemoved, children.length - 1)] += removedWeight
  }
  return { kind: 'split', dir: node.dir, children, sizes }
}

/** 移除面板并剪枝空组；树中不含该面板时原样返回（引用相等）；整树空返回 null */
export function removePanel(root: DockNode | null, panelId: string): DockNode | null {
  if (!root) return null
  if (findTabsByPanel(root, panelId) === null) return root
  return removeRecursive(root, panelId)
}

/**
 * 移动面板 = 摘除 + 插入。特例：并入自身所在组时无结构变化，仅激活该页。
 * root 为 null（空布局）时等价于插入。
 */
export function movePanel(root: DockNode | null, panelId: string, target: DropTarget): DockNode {
  if (!root) return insertPanel(root, panelId, target)
  const cur = findTabsByPanel(root, panelId)
  if (cur && target.kind === 'group' && cur.node.id === target.groupId) {
    // 同组：带 index → 标签重排序；不带 → 仅激活（原行为）
    if (target.index === undefined) {
      return setGroupActive(root, cur.node.id, cur.node.panels.indexOf(panelId)) ?? root
    }
    const from = cur.node.panels.indexOf(panelId)
    const rest = cur.node.panels.filter((p) => p !== panelId)
    const index = Math.min(Math.max(Math.trunc(target.index), 0), rest.length)
    if (index === from) return setGroupActive(root, cur.node.id, from) ?? root
    rest.splice(index, 0, panelId)
    return updateAtPath(root, cur.path, (n) => {
      const t = n as DockTabsNode
      return { ...t, panels: rest, active: index }
    })
  }
  return insertPanel(root, panelId, target)
}

/** 激活 panelId 所在页（不改结构；面板不存在时原样返回） */
export function activatePanelIn(root: DockNode | null, panelId: string): DockNode | null {
  if (!root) return null
  const found = findTabsByPanel(root, panelId)
  if (!found) return root
  return setGroupActive(root, found.node.id, found.node.panels.indexOf(panelId))
}

/** 设置 tabs 组激活页（下标钳制；组不存在时原样返回） */
export function setGroupActive(root: DockNode | null, groupId: string, index: number): DockNode | null {
  if (!root) return null
  const found = findTabsById(root, groupId)
  if (!found) return root
  const idx = Number.isFinite(index) ? Math.trunc(index) : 0
  const clamped = Math.min(Math.max(idx, 0), found.node.panels.length - 1)
  return updateAtPath(root, found.path, (n) => {
    const t = n as DockTabsNode
    return { ...t, active: clamped }
  })
}

/* ---------------- 分隔条尺寸（纯计算，供 store / 组件复用） ---------------- */

/**
 * 拖动第 index 个分隔条（位于 sizes[index] 与 sizes[index+1] 之间）：
 * deltaPx 为指针位移（沿分裂方向），totalPx 为该 split 容器在分裂方向上的净像素宽
 * （扣除分隔条自身占用）；权重与像素按 pxPerWeight = totalPx / sum(sizes) 换算，
 * 双侧钳制不小于 minPx 等效权重，总和不变；其余兄弟权重不动；非法 index 原样返回副本。
 */
export function resizeSashSizes(
  sizes: number[],
  index: number,
  deltaPx: number,
  totalPx: number,
  minPx: number = MIN_PANE_PX,
): number[] {
  const out = sizes.slice()
  if (index < 0 || index >= sizes.length - 1) return out
  const sum = sizes.reduce((acc, s) => acc + s, 0)
  if (totalPx <= 0 || sum <= 0) return out
  const pxPerWeight = totalPx / sum
  const floor = minPx / pxPerWeight
  const a = sizes[index]
  const b = sizes[index + 1]
  let na = a + deltaPx / pxPerWeight
  let nb = b - deltaPx / pxPerWeight
  if (na < floor) {
    na = floor
    nb = a + b - floor
  }
  if (nb < floor) {
    nb = floor
    na = a + b - nb
  }
  out[index] = na
  out[index + 1] = nb
  return out
}
