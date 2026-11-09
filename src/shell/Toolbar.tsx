/**
 * 顶栏（T0.3 · PLAN §6.2）
 *
 * 左：Logo（Boxes + 字标，点击切换左侧菜单显隐）+ 项目 chip（点击返回项目管理器切换项目）；
 * 编辑 / 设置已迁入蓝图页头；运行 / 保存在编辑器图签栏。
 * F5/F6 快捷键注册在入口 main.tsx（attachKeyboard 已 preventDefault，不触发浏览器刷新）。
 */
import { Boxes, Package } from 'lucide-react'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { Icon } from '@/shell/ui/Icon'
import { useSidebarStore } from '@/shell/sidebar/sidebar-store'

export default function Toolbar() {
  const projectName = useWorkspaceStore((s) => s.currentProject?.name ?? null)

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button
          type="button"
          className="toolbar-logo toolbar-logo-btn"
          title="点击展开 / 收起左侧菜单（首页 · 蓝图）"
          onClick={() => useSidebarStore.getState().toggle()}
        >
          <Icon icon={Boxes} size={16} />
          <span>Blueprint Studio</span>
        </button>
        <button
          type="button"
          className="toolbar-project"
          title={projectName ? `当前项目：${projectName}（点击切换项目）` : '未打开项目'}
          onClick={() => {
            window.location.href = '/'
          }}
        >
          <Icon icon={Package} size={13} />
          <span className="toolbar-project-name">{projectName ?? '未打开项目'}</span>
        </button>
      </div>

      <div className="toolbar-spacer" />
    </div>
  )
}
