/**
 * 占位面板组件（T0.3）
 *
 * 默认布局中的面板本期均为占位：每个组件一句话标注由哪张任务卡实现，
 * 后续卡落地时在 defaultPanels.tsx 改对应 registerPanel 的 component 即可
 * （id 保持不变 → 用户已有布局与持久化无缝继承）。
 * 工作区（WorkspacePanel）为半真实面板：资产 tabs 已接 workspace-store，
 * tab 内容区仍为占位（内容加载 T0.7 / T1.x 接入）。
 */
import { useWorkspaceStore, type OpenTabKind } from '@/shell/workspace-store'
import { BlueprintTab } from '@/shell/workspace/BlueprintTab'
import { UITab } from '@/shell/workspace/UITab'

/** 通用占位块 */
function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="dock-panel-placeholder">
      <div className="dock-panel-placeholder-title">{title}</div>
      <div>{note}</div>
    </div>
  )
}

/** 文件系统面板 —— 由 T0.7 实现（树 / 右键增删改重命名 / 拖入导入） */
export function FileSystemPanelPlaceholder() {
  return (
    <Placeholder
      title="文件系统"
      note="项目资产树、右键增删改重命名、拖入导入 —— 由 T0.7 文件系统面板实现（本占位可关闭，经顶栏「面板」菜单重开）。"
    />
  )
}

/** UI 树面板 —— 由 T1.4 实现（树形 / 拖拽重排父子 / 右键菜单） */
export function UiTreePanelPlaceholder() {
  return (
    <Placeholder
      title="UI 树"
      note="当前 UI 的节点树、拖拽重排父子、右键菜单 —— 由 T1.4 UI 树面板实现。"
    />
  )
}

/** 检视器 —— 由 T1.5 实现（分组 / 搜索 / 类型编辑器 / 多选混合态） */
export function InspectorPanelPlaceholder() {
  return (
    <Placeholder
      title="检视器"
      note="选中 UI 节点的属性编辑（schema 驱动自动生成） —— 由 T1.5 检视器实现。"
    />
  )
}

/** 事件面板 —— 由 T5.2 实现（内建 + 自定义事件列表 / 双击创建跳转） */
export function EventsPanelPlaceholder() {
  return (
    <Placeholder
      title="事件面板"
      note="选中节点的内建事件与逻辑资产自定义事件列表，双击创建 / 跳转事件节点 —— 由 T5.2 事件面板实现。"
    />
  )
}

/** 控制台 —— 由 T1.6（运行窗口）起接入日志输出，T5.4 调试观察扩展 */
export function ConsolePanelPlaceholder() {
  return (
    <Placeholder
      title="控制台"
      note="运行输出 / 插件日志 / 调试信息 —— 由 T1.6 运行窗口接入日志输出，T5.4 调试观察扩展。"
    />
  )
}

/** 工作区各 tab 类型的内容占位说明 */
const KIND_NOTES: Record<OpenTabKind, string> = {
  ui: 'UI 编辑视口（选择 / 框选 / 移动 / 对齐吸附）—— 由 T1.2 DOM 渲染器、T1.3 2D 视口实现。',
  blueprint: 'UE5 风格蓝图编辑器 —— 由 T2.1 蓝图视觉系统、T2.2 画布交互实现。',
  script: '脚本编辑器（CodeMirror 6 · TS/Python）—— 由 T3.1 脚本编辑器实现。',
  'plugin-manager': '插件列表 / 状态徽标 / 安装更新 —— 由 T6.2 插件管理子界面实现。',
}

/** 工作区面板（默认布局中央固定项）：内部渲染资产 tabs，dock tabs 组仍可容纳其它面板 */
export function WorkspacePanel() {
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  const setActive = useWorkspaceStore((s) => s.setActive)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const active = openTabs.find((t) => t.id === activeTabId) ?? null
  return (
    <div className="workspace">
      <div className="workspace-tabs">
        {openTabs.map((tab) => (
          <div
            key={tab.id}
            className={`workspace-tab${tab.id === activeTabId ? ' active' : ''}`}
            onPointerDown={() => setActive(tab.id)}
            title={tab.assetPath || tab.title}
          >
            {tab.dirty ? <span className="workspace-dirty">●</span> : null}
            <span>{tab.title}</span>
            <button
              type="button"
              className="workspace-tab-close"
              title={`关闭「${tab.title}」`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        {openTabs.length === 0 ? (
          <div className="workspace-empty-tabs">暂无打开的资产（T0.7 文件面板双击打开）</div>
        ) : null}
      </div>
      <div className="workspace-body">
        {active ? (
          active.kind === 'blueprint' ? (
            <BlueprintTab assetPath={active.assetPath} />
          ) : active.kind === 'ui' ? (
            <UITab assetPath={active.assetPath} />
          ) : (
            <Placeholder title={active.title} note={KIND_NOTES[active.kind]} />
          )
        ) : (
          <div className="dock-panel-placeholder">双击文件系统中的资产打开。</div>
        )}
      </div>
    </div>
  )
}
