/**
 * 左侧后台式导航（首页 / 蓝图）
 *
 * 顶栏「Blueprint Studio」区域点击切换显隐；本组件只负责菜单，
 * 页面内容（首页空白 / 蓝图工作区）由 DockShell 根据 section 渲染。
 */
import type { LucideIcon } from 'lucide-react'
import { Home, Workflow } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { useSidebarStore, type SidebarSection } from './sidebar-store'
import './sidebar.css'

interface NavItem {
  id: SidebarSection
  label: string
  icon: LucideIcon
}

/** 侧栏导航项 */
const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '首页', icon: Home },
  { id: 'blueprint', label: '蓝图', icon: Workflow },
]

export function Sidebar() {
  const open = useSidebarStore((s) => s.open)
  const section = useSidebarStore((s) => s.section)
  const setSection = useSidebarStore((s) => s.setSection)
  if (!open) return null
  return (
    <aside className="app-sidebar">
      <nav className="app-sidebar-menu" aria-label="侧栏菜单">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`app-sidebar-item${section === item.id ? ' active' : ''}`}
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => setSection(item.id)}
          >
            <Icon icon={item.icon} size={14} />
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}
