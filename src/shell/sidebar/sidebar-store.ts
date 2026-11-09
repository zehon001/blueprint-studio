/**
 * 左侧菜单状态（UI 改版：文件系统 / 资源库收纳入侧栏）
 *
 * - open：点击顶栏「Blueprint Studio」区域切换显隐（localStorage 记忆）；
 * - section：侧栏当前节（文件系统 / 资源库）；蓝图编辑页签（GraphTabs）
 *   也按该节区分显示内容（文件系统 → 蓝图文件与局部函数；资源库 → 库函数）。
 */
import { create } from 'zustand'

export type SidebarSection = 'files' | 'library'

const OPEN_KEY = 'bps.sidebar.open'
const SECTION_KEY = 'bps.sidebar.section'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function readSection(): SidebarSection {
  try {
    return localStorage.getItem(SECTION_KEY) === 'library' ? 'library' : 'files'
  } catch {
    return 'files'
  }
}

interface SidebarState {
  /** 侧栏是否可见 */
  open: boolean
  /** 当前节：文件系统 / 资源库 */
  section: SidebarSection
  /** 显隐切换（顶栏 Logo 点击） */
  toggle: () => void
  /** 切换节 */
  setSection: (section: SidebarSection) => void
}

export const useSidebarStore = create<SidebarState>()((set, get) => ({
  open: readOpen(),
  section: readSection(),
  toggle: () => {
    const open = !get().open
    set({ open })
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      /* 无 localStorage：仅内存态 */
    }
  },
  setSection: (section) => {
    set({ section })
    try {
      localStorage.setItem(SECTION_KEY, section)
    } catch {
      /* 无 localStorage：仅内存态 */
    }
  },
}))
