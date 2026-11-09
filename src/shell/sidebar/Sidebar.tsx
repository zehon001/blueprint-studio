/**
 * 左侧菜单（UI 改版）
 *
 * 顶栏「Blueprint Studio」区域点击切换显隐；管理后台式左侧菜单：
 * 「文件系统 / 资源库」独立成一列（纵向菜单栏），点选在右侧内容列切换
 * 对应面板；双击蓝图 / 函数条目在中央编辑区打开对应资产。
 * 后续新增界面：在 NAV_ITEMS 追加一项即可（SidebarSection 类型同步扩展）。
 * 各节内容常挂载（隐藏不卸载），避免切换时目录树 / 列表反复重载。
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { FolderTree, LibraryBig } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { FileSystemPanel } from '@/panels/file-system'
import { LibraryPanel } from '@/panels/library'
import { useSidebarStore, type SidebarSection } from './sidebar-store'
import './sidebar.css'

interface NavItem {
  id: SidebarSection
  label: string
  icon: LucideIcon
  content: ComponentType
}

/** 侧栏导航项（新增界面在此追加一项；内容常挂载、隐藏不卸载） */
const NAV_ITEMS: NavItem[] = [
  { id: 'files', label: '文件系统', icon: FolderTree, content: FileSystemPanel },
  { id: 'library', label: '资源库', icon: LibraryBig, content: LibraryPanel },
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
      <div className="app-sidebar-content">
        {NAV_ITEMS.map((item) => {
          const Content = item.content
          return (
            <div
              key={item.id}
              className="app-sidebar-page"
              style={{ display: section === item.id ? undefined : 'none' }}
            >
              <Content />
            </div>
          )
        })}
      </div>
    </aside>
  )
}
