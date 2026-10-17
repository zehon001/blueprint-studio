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

interface DockState {
  /** 布局树根；null = 空布局（全部面板已关闭，可从「面板」菜单重开） */
  root: DockNode | null
  /** 默认布局（initDockLayout 注入；resetLayout 恢复用） */
  defaultRoot: DockNode | null
  /** 启动装配：注入默认布局与（可选的）持久化还原结果 */
  initDockLayout: (defaultRoot: DockNode, persisted?: DockNode | null) => void
  /** 打开面板：已在树中则仅激活；否则按 defaultArea 插入（center = 并入居中工作区组） */
  openPanel: (panelId: string, defaultArea: DockArea) => void
  /** 关闭面板（从所在 tabs 组移除，空组剪枝） */
  closePanel: (panelId: string) => void
  /** 激活面板所在页；不在树中时先按 defaultArea 打开 */
  activatePanel: (panelId: string, defaultArea: DockArea) => void
  /** 拖放落点应用（DockShell 松手时调用） */
  movePanelTo: (panelId: string, target: DropTarget) => void
  /** 设置 tabs 组激活页 */
  setTabActive: (groupId: string, index: number) => void
  /** 分隔条拖动：按路径整体替换目标 split 的 sizes */
  setSizes: (path: number[], sizes: number[]) => void
  /** 恢复默认布局（顶栏「重置布局」） */
  resetLayout: () => void
}

/** 居中区目标组：优先工作区（workspace）所在组，否则文档序第一个 tabs 组 */
function centerGroupId(root: DockNode | null): string {
  return findTabsByPanel(root, 'workspace')?.node.id ?? firstTabsGroup(root)?.node.id ?? ''
}

export const useDockStore = create<DockState>()((set, get) => {
  /** 统一提交：更新布局并持久化 */
  const commit = (root: DockNode | null): void => {
    saveLayout(root)
    set({ root })
  }
  return {
    root: null,
    defaultRoot: null,

    initDockLayout: (defaultRoot, persisted = null) => {
      const root = persisted ?? defaultRoot
      saveLayout(root)
      set({ defaultRoot, root })
    },

    openPanel: (panelId, defaultArea) => {
      const { root } = get()
      if (findTabsByPanel(root, panelId)) {
        commit(activatePanelIn(root, panelId))
        return
      }
      const target: DropTarget =
        defaultArea === 'center'
          ? { kind: 'group', groupId: centerGroupId(root) }
          : { kind: 'edge', side: defaultArea }
      commit(insertPanel(root, panelId, target))
    },

    closePanel: (panelId) => {
      commit(removePanel(get().root, panelId))
    },

    activatePanel: (panelId, defaultArea) => {
      const { root } = get()
      if (findTabsByPanel(root, panelId)) {
        commit(activatePanelIn(root, panelId))
      } else {
        get().openPanel(panelId, defaultArea)
      }
    },

    movePanelTo: (panelId, target) => {
      commit(movePanel(get().root, panelId, target))
    },

    setTabActive: (groupId, index) => {
      commit(setGroupActive(get().root, groupId, index))
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
      commit(get().defaultRoot)
    },
  }
})
