/**
 * 左侧菜单状态（后台式导航：首页 / 蓝图）
 *
 * - open：点击顶栏「Blueprint Studio」区域切换显隐（localStorage 记忆）；
 * - section：当前页面（首页 / 蓝图），切换只影响右侧页面显示。
 */
import { create } from 'zustand'

export type SidebarSection = 'home' | 'blueprint'

const OPEN_KEY = 'bps.sidebar.open'
const SECTION_KEY = 'bps.sidebar.section'

function readSection(): SidebarSection {
  try {
    return localStorage.getItem(SECTION_KEY) === 'home' ? 'home' : 'blueprint'
  } catch {
    return 'blueprint'
  }
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

interface SidebarState {
  /** 侧栏是否可见 */
  open: boolean
  /** 当前页（首页 / 蓝图） */
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
