/**
 * 工作区状态（zustand，T0.3 · PLAN §6.2 中央工作区）
 *
 * 职责：当前项目上下文 + 打开的资产 tabs（UI 编辑 / 蓝图编辑 / 脚本编辑 / 插件管理）。
 * 本期 openAsset 只切 tab、不加载内容（内容加载与保存链路 T0.7 / T1.x 接入）；
 * dirty 脏标记（tab ●）由本 store 承载，Ctrl+S 的 file.save 快捷键本期为空实现（T0.5 注册），
 * 后续保存链路接 clearDirty。
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
  /** 标脏（编辑动作发生时调用） */
  markDirty: (id: string) => void
  /** 清脏（保存成功后调用） */
  clearDirty: (id: string) => void
  /** 关闭项目：清空项目上下文与全部 tabs（T0.6 返回管理器时调用） */
  closeProject: () => void
}

/**
 * 默认占位 tabs（对应 PLAN §6.2 默认布局示意「UI 编辑 / 蓝图编辑」）。
 * T0.6 / T0.7 起将由真实打开的资产替换，此处仅为外壳演示提供内容。
 */
const SEED_TABS: OpenTab[] = [
  { id: tabIdOf('ui', 'ui/main.ui.json'), kind: 'ui', assetPath: 'ui/main.ui.json', title: 'UI 编辑' },
  {
    id: tabIdOf('blueprint', 'logic/main.bp.json'),
    kind: 'blueprint',
    assetPath: 'logic/main.bp.json',
    title: '蓝图编辑',
  },
]

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  currentProject: projectFromLocation(),
  openTabs: SEED_TABS,
  activeTabId: SEED_TABS[0].id,

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
    set((s) => ({ openTabs: s.openTabs.map((t) => (t.id === id ? { ...t, dirty: false } : t)) })),

  closeProject: () => set({ currentProject: null, openTabs: [], activeTabId: null }),
}))
