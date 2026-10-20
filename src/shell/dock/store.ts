/**
 * Dock 布局 store（zustand，T0.3）
 *
 * 布局树唯一真源：所有变更经 tree.ts 纯函数产生新树后整体替换（不可变），
 * 每次提交同步持久化（persist.saveLayout），刷新后由 bootstrapDock 还原。
 * 本 store 不感知面板注册表（registry）——defaultArea 由调用方传入，
 * 保持「store ← registry」单向依赖（registry 持有 PanelApi 调用本 store）。
 */
import { create } from 'zustand'
import { saveLayout } from './persist'
import {
  activatePanelIn,
  findTabsById,
  findTabsByPanel,
  firstTabsGroup,
  getNodeAtPath,
  insertPanel,
  makeTabs,
  movePanel,
  removePanel,
  setGroupActive,
  updateAtPath,
  type DockArea,
  type DockNode,
  type DockTabsNode,
  type DropTarget,
} from './tree'

/** 布局中第一个可激活面板（文档序：首个 tabs 组的 active 页） */
export function firstActivePanel(root: DockNode | null): string | null {
  const group = firstTabsGroup(root)
  if (!group) return null
  const idx = Math.min(Math.max(group.node.active, 0), group.node.panels.length - 1)
  return group.node.panels[idx] ?? null
}

interface DockState {
  /** 布局树根；null = 空布局（全部面板已关闭，可从「面板」菜单重开） */
  root: DockNode | null
  /** 默认布局（initDockLayout 注入；resetLayout 恢复用） */
  defaultRoot: DockNode | null
  /** 当前聚焦面板（资产面板标题/统一检视器/F6 的上下文依据；v3 T8.1） */
  activePanelId: string | null
  /** 启动装配：注入默认布局与（可选的）持久化还原结果 */
  initDockLayout: (defaultRoot: DockNode, persisted?: DockNode | null, persistedActive?: string | null) => void
  /** 打开面板：已在树中则仅激活；否则按 defaultArea 插入（center = 并入居中工作区组） */
  openPanel: (panelId: string, defaultArea: DockArea) => void
  /** 关闭面板（从所在 tabs 组移除，空组剪枝） */
  closePanel: (panelId: string) => void
  /** 激活面板所在页；不在树中时先按 defaultArea 打开 */
  activatePanel: (panelId: string, defaultArea: DockArea) => void
  /** 拖放落点应用（DockShell 松手时调用） */
  movePanelTo: (panelId: string, target: DropTarget) => void
  /** 仅切换全局聚焦面板（点击面板内容时用；不改布局结构） */
  focusPanel: (panelId: string) => void
  /** 设置 tabs 组激活页 */
  setTabActive: (groupId: string, index: number) => void
  /** 分隔条拖动：按路径整体替换目标 split 的 sizes */
  setSizes: (path: number[], sizes: number[]) => void
  /** 恢复默认布局（顶栏「重置布局」） */
  resetLayout: () => void
}

/** 工具型面板（停靠栏/侧栏）：其余一律视为文档面板（资产编辑器、旧 workspace 等） */
const UTILITY_PANELS = new Set([
  'file-system',
  'scene-tree',
  'inspector',
  'events',
  'console',
  'runtime',
  'library',
  'plugin-manager',
])

/** 文档型面板：新文档默认并入其所在的编辑器组 */
function isDocPanel(panelId: string | null): panelId is string {
  return panelId !== null && !UTILITY_PANELS.has(panelId)
}

/** 纯文档组：组内全部是文档面板（不含控制台/运行等工具面板） */
function isPureDocGroup(node: DockTabsNode): boolean {
  return node.panels.length > 0 && node.panels.every((p) => isDocPanel(p))
}

/** 文档序深度优先：找含纯文档面板最多的组（主编辑区）；平局取树序靠前者 */
function findDocGroupId(root: DockNode | null): string | null {
  const best: { value: { id: string; count: number } | null } = { value: null }
  const walk = (node: DockNode): void => {
    if (node.kind === 'tabs') {
      if (!isPureDocGroup(node)) return
      const count = node.panels.length
      if (best.value === null || count > best.value.count) {
        best.value = { id: node.id, count }
      }
      return
    }
    for (const child of node.children) walk(child)
  }
  if (root) walk(root)
  return best.value ? best.value.id : null
}

/** 在指定 tabs 组旁新建分组（主编辑区被关闭后原位重建用；新编辑组占 3/4） */
function insertPanelBeside(
  root: DockNode | null,
  panelId: string,
  anchorGroupId: string,
  side: 'left' | 'right',
): DockNode {
  const base = removePanel(root, panelId)
  if (!base) return makeTabs([panelId])
  const anchor = findTabsById(base, anchorGroupId)
  if (!anchor) return insertPanel(base, panelId, { kind: 'group', groupId: anchorGroupId })
  const fresh = makeTabs([panelId])
  const wrapped: DockNode = {
    kind: 'split',
    dir: 'h',
    sizes: side === 'left' ? [3, 1] : [1, 3],
    children: side === 'left' ? [fresh, anchor.node] : [anchor.node, fresh],
  }
  return updateAtPath(base, anchor.path, () => wrapped)
}

/**
 * 新建文档的落点：
 *   1) 当前聚焦的是文档 → 并入该文档所在组（与 VS Code 的活跃编辑器组一致）；
 *   2) 存在纯文档组（主编辑区）→ 并入文档数最多的组；
 *   3) 主编辑区已随最后一个文档关闭被剪枝 → 在右侧工具组（检视器/事件）左侧
 *      重建编辑组（默认布局中主编辑区的位置），避免把文档塞进底部工具组；
 *   4) 无右侧工具组 → 退回运行视图组 / 文档序首个组。
 * 注意不能只用运行视图组——运行面板可被用户移到底部控制台旁（v3 布局可拖拽）。
 */
function pickCenterTarget(
  root: DockNode | null,
  activePanelId: string | null,
): DropTarget | { kind: 'new-beside'; anchorGroupId: string } {
  if (isDocPanel(activePanelId)) {
    const activeGroup = findTabsByPanel(root, activePanelId)?.node.id
    if (activeGroup) return { kind: 'group', groupId: activeGroup }
  }
  const doc = findDocGroupId(root)
  if (doc) return { kind: 'group', groupId: doc }
  const anchor =
    findTabsByPanel(root, 'inspector')?.node.id ?? findTabsByPanel(root, 'events')?.node.id
  if (anchor) return { kind: 'new-beside', anchorGroupId: anchor }
  const runtime = findTabsByPanel(root, 'runtime')?.node.id
  if (runtime) return { kind: 'group', groupId: runtime }
  const first = firstTabsGroup(root)?.node.id
  return first ? { kind: 'group', groupId: first } : { kind: 'group', groupId: '' }
}

export const useDockStore = create<DockState>()((set, get) => {
  /** 统一提交：更新布局 + 聚焦面板并持久化（active 不在树中时回退首个可激活面板） */
  const commit = (root: DockNode | null, activePanelId: string | null = get().activePanelId): void => {
    const active =
      activePanelId !== null && findTabsByPanel(root, activePanelId) !== null
        ? activePanelId
        : firstActivePanel(root)
    saveLayout(root, active)
    set({ root, activePanelId: active })
  }
  return {
    root: null,
    defaultRoot: null,
    activePanelId: null,

    initDockLayout: (defaultRoot, persisted, persistedActive = null) => {
      // persisted === null = 用户上次关闭了全部面板（尊重空布局）；
      // undefined = 无持久化布局（首次启动 / v2 布局）→ 默认布局。
      const root = persisted === undefined ? defaultRoot : persisted
      const active =
        persistedActive !== null && findTabsByPanel(root, persistedActive) !== null
          ? persistedActive
          : firstActivePanel(root)
      saveLayout(root, active)
      set({ defaultRoot, root, activePanelId: active })
    },

    openPanel: (panelId, defaultArea) => {
      const { root } = get()
      if (findTabsByPanel(root, panelId)) {
        const next = activatePanelIn(root, panelId)
        commit(next, panelId)
        return
      }
      let next: DockNode | null
      if (defaultArea === 'center') {
        const pick = pickCenterTarget(root, get().activePanelId)
        next =
          'anchorGroupId' in pick
            ? insertPanelBeside(root, panelId, pick.anchorGroupId, 'left')
            : insertPanel(root, panelId, pick)
      } else {
        next = insertPanel(root, panelId, { kind: 'edge', side: defaultArea })
      }
      commit(next, panelId)
    },

    closePanel: (panelId) => {
      const next = removePanel(get().root, panelId)
      // 关闭当前聚焦面板时，聚焦回退到布局中的首个可激活面板
      commit(next, get().activePanelId === panelId ? null : get().activePanelId)
    },

    activatePanel: (panelId, defaultArea) => {
      const { root } = get()
      if (findTabsByPanel(root, panelId)) {
        commit(activatePanelIn(root, panelId), panelId)
      } else {
        get().openPanel(panelId, defaultArea)
      }
    },

    movePanelTo: (panelId, target) => {
      commit(movePanel(get().root, panelId, target), panelId)
    },

    focusPanel: (panelId) => {
      const { root, activePanelId } = get()
      if (activePanelId === panelId) return
      if (findTabsByPanel(root, panelId) === null) return
      saveLayout(root, panelId)
      set({ activePanelId: panelId })
    },

    setTabActive: (groupId, index) => {
      const root = setGroupActive(get().root, groupId, index)
      const group = findTabsById(root, groupId)
      const idx = group ? Math.min(Math.max(index, 0), group.node.panels.length - 1) : -1
      commit(root, group && idx >= 0 ? (group.node.panels[idx] ?? null) : get().activePanelId)
    },

    setSizes: (path, sizes) => {
      const { root } = get()
      if (!root) return // 空路径 = 根 split 本身，合法；仅根不存在时忽略
      const node = getNodeAtPath(root, path)
      if (!node || node.kind !== 'split' || node.sizes.length !== sizes.length) return
      commit(
        updateAtPath(root, path, (n) => (n.kind === 'split' ? { ...n, sizes: [...sizes] } : n)),
      )
    },

    resetLayout: () => {
      // 纯函数操作不修改树，直接共享 defaultRoot 引用即可
      commit(get().defaultRoot, firstActivePanel(get().defaultRoot))
    },
  }
})
