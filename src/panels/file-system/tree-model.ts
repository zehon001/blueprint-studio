/**
 * 文件系统面板 —— 目录树纯函数（T0.7）
 *
 * 职责：树节点结构、排序（目录优先 + zh 数字 collator，与服务端 buildTreeNode 同规则）、
 * 按 SSE watch 事件（add / unlink / change）对树做增量合并、拖拽移动落点校验。
 * 全部为纯函数，单测覆盖：
 *  - add 已存在幂等（替换不重复）、父目录级联补齐；
 *  - unlink 移除节点（目录随子列表整棵移除）、目标已随父目录删除时忽略；
 *  - change 不改变结构（返回原引用，调用方据此跳过刷新）；
 *  - checkFsMove：仅允许移入目录，拒绝项目根 / 自身 / 自身子树 / 同名冲突。
 *
 * 事件 path 相对监视目录（= 项目根，见 server/index.ts handleWatch）；
 * 树根节点 path = 项目文件夹名（相对安全根），事件换算成全路径后再合并。
 */
import { baseName, extOf, joinPosix, normalizePosix, parentOf } from './paths'

/** 目录树节点（与 server/fs.ts 的 TreeNode 结构逐字段对齐） */
export interface FsNode {
  name: string
  /** 相对安全根的 posix 路径 */
  path: string
  type: 'dir' | 'file'
  /** 小写扩展名（不含点；目录为 ''） */
  ext: string
  children: FsNode[]
}

/** 服务端 SSE watch 事件（与 server/fs.ts 的 FsChangeEvent 对齐；path 相对监视目录） */
export interface FsChangeEvent {
  type: 'add' | 'unlink' | 'change'
  path: string
  kind?: 'file' | 'dir'
}

/** 与 server/fs.ts 相同的排序器：中文拼音 + 数字按值 + 大小写不敏感 */
export const TREE_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/** 兄弟节点排序：目录优先，各自按 collator */
export function sortNodes(nodes: readonly FsNode[]): FsNode[] {
  const dirs = nodes.filter((n) => n.type === 'dir').sort((a, b) => TREE_COLLATOR.compare(a.name, b.name))
  const files = nodes.filter((n) => n.type === 'file').sort((a, b) => TREE_COLLATOR.compare(a.name, b.name))
  return [...dirs, ...files]
}

/** 全树重排（加载 / 整体刷新后调用；增量合并路径上已局部排序，无需重复） */
export function sortTree(node: FsNode): FsNode {
  return { ...node, children: sortNodes(node.children).map(sortTree) }
}

/**
 * 隐藏项目库目录（PLAN §3.7：全项目函数不显示在文件系统，由资源库面板管理）。
 * 仅过滤项目根下的 `library/`。
 */
export function hideProjectLibrary(root: FsNode): FsNode {
  return {
    ...root,
    children: sortNodes(root.children)
      .filter((c) => !(c.type === 'dir' && c.name === 'library'))
      .map(sortTree),
  }
}

/** 按 path 查找节点（逐段下探；找不到返回 null） */
export function findNode(root: FsNode, path: string): FsNode | null {
  const target = normalizePosix(path)
  const rootPath = normalizePosix(root.path)
  if (target === rootPath) return root
  const prefix = rootPath === '' ? '' : `${rootPath}/`
  if (rootPath !== '' && !target.startsWith(prefix)) return null
  let cur: FsNode = root
  for (const seg of target.slice(prefix.length).split('/').filter(Boolean)) {
    const next = cur.children.find((c) => c.name === seg)
    if (!next) return null
    cur = next
  }
  return cur
}

/**
 * 沿 dirPath 克隆节点链（写时复制），使后续对父 children 的变更不触碰原树：
 * - create = true：缺失的祖先按目录补齐（add 事件的父目录级联）；
 * - create = false：任一祖先缺失或不是目录时返回 null（unlink 语义：不凭空造目录）。
 */
function cloneChain(root: FsNode, dirPath: string, create: boolean): FsNode | null {
  const target = normalizePosix(dirPath)
  const rootPath = normalizePosix(root.path)
  if (target === rootPath) return { ...root, children: [...root.children] }
  const prefix = rootPath === '' ? '' : `${rootPath}/`
  if (rootPath !== '' && !target.startsWith(prefix)) return null
  const segs = target.slice(prefix.length).split('/').filter(Boolean)
  const clone: FsNode = { ...root, children: [...root.children] }
  let cur: FsNode = clone
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const path = `${prefix}${segs.slice(0, i + 1).join('/')}`
    const existing = cur.children.find((c) => c.name === seg)
    if (existing && existing.type === 'dir') {
      // 目录已存在：克隆后沿它继续（保持其在兄弟中的位置不变）
      const next: FsNode = { ...existing, children: [...existing.children] }
      cur.children = cur.children.map((c) => (c.name === seg ? next : c))
      cur = next
    } else if (create) {
      const next: FsNode = { name: seg, path, type: 'dir', ext: '', children: [] }
      cur.children = sortNodes([...cur.children.filter((c) => c.name !== seg), next])
      cur = next
    } else {
      return null
    }
  }
  return clone
}

/**
 * 合并一批 watch 事件到树（增量、纯函数）。
 * 返回 undefined 表示无法安全增量合并（树为空壳 / 事件缺 kind / 监视根被删），
 * 调用方应整体重载 GET /api/tree。
 */
export function applyFsEvents(root: FsNode, events: readonly FsChangeEvent[]): FsNode | undefined {
  let tree: FsNode = root
  let changed = false
  for (const ev of events) {
    const rel = normalizePosix(ev.path)
    if (rel === '') return undefined // 监视目录自身（如被删除的 unlink）→ 整体重载
    if (ev.type === 'change') continue // 内容变更不改结构（编辑器侧处理）
    const full = normalizePosix(root.path) === '' ? rel : `${normalizePosix(root.path)}/${rel}`
    const parent = parentOf(full)
    const name = baseName(full)

    if (ev.type === 'add') {
      if (ev.kind !== 'file' && ev.kind !== 'dir') return undefined
      const withChain = cloneChain(tree, parent, true)
      if (!withChain) return undefined
      const parentNode = findNode(withChain, parent)
      if (!parentNode || parentNode.type !== 'dir') return undefined
      const node: FsNode =
        ev.kind === 'dir'
          ? { name, path: full, type: 'dir', ext: '', children: [] }
          : { name, path: full, type: 'file', ext: extOf(name), children: [] }
      // 幂等：同名已存在则替换（目录→文件等极端竞态也归于此分支）
      parentNode.children = sortNodes([...parentNode.children.filter((c) => c.name !== name), node])
      tree = withChain
      changed = true
    } else {
      const withChain = cloneChain(tree, parent, false)
      if (!withChain) continue // 父目录已不在树中（随整目录删除）→ 忽略
      const parentNode = findNode(withChain, parent)
      if (!parentNode || parentNode.type !== 'dir') continue
      if (!parentNode.children.some((c) => c.name === name)) continue // 已被移除（幂等）
      parentNode.children = parentNode.children.filter((c) => c.name !== name)
      tree = withChain
      changed = true
    }
  }
  return changed ? tree : root
}

/* ============================================================
 * 拖拽移动（仅调整所属目录，不支持排序）
 * ============================================================ */

/** 文件树拖拽落点检查结果（不合法时给中文原因，供 toast 提示） */
export interface FsMoveCheck {
  ok: boolean
  /** 不合法原因 */
  reason?: string
  /** 合法时的目标路径（目标目录 + 原名称） */
  to?: string
}

/**
 * 文件树拖拽只能「移动到某个目录内」——不像 UI 树有 before / after 排序落区。
 * 拒绝：项目根、移动到自身、目录移入自身子树、目标非目录、目标目录已有同名条目；
 * 已在目标目录中视为无操作（不亮落点、不产生命令）。
 */
export function checkFsMove(root: FsNode, fromPath: string, toDirPath: string): FsMoveCheck {
  const rootPath = normalizePosix(root.path)
  const from = normalizePosix(fromPath)
  const toDir = normalizePosix(toDirPath)
  if (from === rootPath) return { ok: false, reason: '项目根不可移动' }
  const source = findNode(root, from)
  if (!source) return { ok: false, reason: '源文件或文件夹不存在' }
  if (from === toDir) return { ok: false, reason: '不能移动到自身' }
  const target = findNode(root, toDir)
  if (!target) return { ok: false, reason: '目标文件夹不存在' }
  if (target.type !== 'dir') return { ok: false, reason: '只能移动到文件夹' }
  if (parentOf(from) === toDir) return { ok: false, reason: '已在目标文件夹中' }
  if (source.type === 'dir' && toDir.startsWith(`${from}/`)) {
    return { ok: false, reason: '不能把文件夹移动到其自身内部' }
  }
  if (target.children.some((c) => c.name.toLowerCase() === source.name.toLowerCase())) {
    return { ok: false, reason: `目标文件夹中已存在「${source.name}」` }
  }
  return { ok: true, to: joinPosix(toDir, source.name) }
}
