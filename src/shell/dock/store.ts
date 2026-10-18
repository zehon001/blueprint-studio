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
  movePanel,
  removePanel,
  setGroupActive,
  updateAtPath,
  type DockArea,
  type DockNode,
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

/**
 * 居中区目标组：优先运行视图（默认布局的中央组，v3 T8.1），否则文档序第一个 tabs 组。
 * 注意不能用 firstTabsGroup 作为首选——BFS 在「左右列 + 底部」布局下会先命中底部控制台。
 */
function centerGroupId(root: DockNode | null): string {
  return findTabsByPanel(root, 'runtime')?.node.id ?? firstTabsGroup(root)?.node.id ?? ''
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

    initDockLayout: (defaultRoot, persisted = null, persistedActive = null) => {
      const root = persisted ?? defaultRoot
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
      const target: DropTarget =
        defaultArea === 'center'
          ? { kind: 'group', groupId: centerGroupId(root) }
          : { kind: 'edge', side: defaultArea }
      commit(insertPanel(root, panelId, target), panelId)
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
