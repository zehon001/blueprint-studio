/**
 * 工作区状态（zustand；v3 T8.1 降级为「资产注册表」）
 *
 * 职责：当前项目上下文 + 打开的资产列表（openTabs / 脏标记 / 激活项）。
 * v3 起 dock 布局是打开资产的持久化真源：assetPanel 在布局变化时同步本 store
 * （启动从布局里的 `asset:` 面板重建 openTabs），本 store 不再渲染中央 tab 条。
 * 保留本 store 的原因：F6 需要「当前 UI 资产」、tab 标题/脏标记、多窗口快照同步。
 *
 * 项目上下文：从 URL ?project=<绝对路径> 初始化（PLAN §3.1 窗口模型；
 * T0.6 项目管理器将统一以该方式进入编辑器）；closeProject 清空并回到空上下文。
 */
import { create } from 'zustand'

/** 资产 tab 类型（与中央工作区占位视图一一对应） */
export type OpenTabKind = 'ui' | 'blueprint' | 'script' | 'plugin-manager'

/** 一个打开的资产 tab */
export interface OpenTab {
  id: string
  kind: OpenTabKind
  /** 项目内相对路径（plugin-manager 为虚拟 tab，空串） */
  assetPath: string
  title: string
  /** 脏标记：有未保存修改（Ctrl+S 保存链路 T1.x 接入） */
  dirty?: boolean
}

/** 当前项目引用（文件夹即项目，PLAN §4.1） */
export interface ProjectRef {
  name: string
  path: string
}

/** tab 稳定 id：同资产同视图视为同一 tab（重复 openAsset 只激活不重复开） */
export function tabIdOf(kind: OpenTabKind, assetPath: string): string {
  return `${kind}:${assetPath}`
}

function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** 从 URL ?project= 初始化项目上下文（非浏览器环境返回 null，便于测试） */
export function projectFromLocation(): ProjectRef | null {
  if (typeof location === 'undefined') return null
  const raw = new URLSearchParams(location.search).get('project')
  if (!raw) return null
  return { name: basename(raw) || raw, path: raw }
}

interface WorkspaceState {
  currentProject: ProjectRef | null
  openTabs: OpenTab[]
  activeTabId: string | null
  /** 打开资产：已开则仅激活；title 缺省取路径末段 */
  openAsset: (input: { kind: OpenTabKind; assetPath: string; title?: string }) => void
  /** 关闭 tab；关闭的是激活 tab 时激活相邻页（右侧优先，无右取左） */
  closeTab: (id: string) => void
  /** 激活 tab（id 不存在时忽略） */
  setActive: (id: string) => void
  /** 保存成功序号（每次 clearDirty 自增；内置运行视图自动重跑订阅它） */
  saveSeq: number
  /** 标脏（编辑动作发生时调用） */
  markDirty: (id: string) => void
  /** 清脏（保存成功后调用） */
  clearDirty: (id: string) => void
  /** 关闭项目：清空项目上下文与全部 tabs（T0.6 返回管理器时调用） */
  closeProject: () => void
}

/** v3：不再预置占位 tab；打开资产由 dock 面板驱动并从布局还原 */
const NO_TABS: OpenTab[] = []

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  currentProject: projectFromLocation(),
  openTabs: NO_TABS,
  activeTabId: null,
  saveSeq: 0,

  openAsset: ({ kind, assetPath, title }) => {
    const id = tabIdOf(kind, assetPath)
    set((s) => {
      if (s.openTabs.some((t) => t.id === id)) return { activeTabId: id }
      const tab: OpenTab = { id, kind, assetPath, title: title ?? (basename(assetPath) || '未命名') }
      return { openTabs: [...s.openTabs, tab], activeTabId: id }
    })
  },

  closeTab: (id) =>
    set((s) => {
      const idx = s.openTabs.findIndex((t) => t.id === id)
      if (idx === -1) return {}
      const openTabs = s.openTabs.filter((t) => t.id !== id)
      if (s.activeTabId !== id) return { openTabs }
      const next = openTabs[Math.min(idx, openTabs.length - 1)]
      return { openTabs, activeTabId: next ? next.id : null }
    }),

  setActive: (id) =>
    set((s) => (s.openTabs.some((t) => t.id === id) ? { activeTabId: id } : {})),

  markDirty: (id) =>
    set((s) => ({ openTabs: s.openTabs.map((t) => (t.id === id ? { ...t, dirty: true } : t)) })),

  clearDirty: (id) =>
    set((s) => ({
      openTabs: s.openTabs.map((t) => (t.id === id ? { ...t, dirty: false } : t)),
      saveSeq: s.saveSeq + 1,
    })),

  closeProject: () => set({ currentProject: null, openTabs: [], activeTabId: null, saveSeq: 0 }),
}))
