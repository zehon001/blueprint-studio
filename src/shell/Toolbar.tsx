/**
 * 顶栏（T0.3 · PLAN §6.2 · UI-REDESIGN P5）
 *
 * 左：Logo（Boxes + 字标，点击切换左侧菜单显隐）+ 项目 chip（点击返回项目管理器切换项目）；
 * 中：运行（实心强调，运行当前打开的蓝图）/ 调试（ghost）/ 分隔线 / 保存（附带脏状态点）；
 * 右：编辑菜单（面板 / 撤销 / 重做 / 重置布局 / 资源库导入导出冲突处理新建）、设置。
 * F5/F6 快捷键注册在入口 main.tsx（attachKeyboard 已 preventDefault，不触发浏览器刷新）。
 */
import { useState } from 'react'
import {
  Boxes,
  Bug,
  Eye,
  EyeOff,
  Download,
  FilePlus2,
  GitMerge,
  LayoutDashboard,
  LibraryBig,
  Package,
  PenLine,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Settings,
  Square,
  Undo2,
  Upload,
} from 'lucide-react'
import {
  redo,
  undo,
  useCanRedo,
  useCanUndo,
} from '@/shell/commands'
import { getBindings } from '@/shell/keymap/registry'
import { launchRuntime } from '@/shell/runtime-launch'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { usePanels } from '@/shell/dock/registry'
import { useDockStore } from '@/shell/dock/store'
import { findTabsByPanel } from '@/shell/dock/tree'
import { requestClosePanel } from '@/shell/dock/assetPanelModel'
import { openSettings } from '@/shell/settings'
import { Icon } from '@/shell/ui/Icon'
import { IconButton } from '@/shell/ui/IconButton'
import { Menu, type MenuItem } from '@/shell/ui/Menu'
import { useSidebarStore } from '@/shell/sidebar/sidebar-store'
import { useLibraryUiStore } from '@/panels/library/ui-store'
import { useRuntimeStore } from '@/panels/runtime/store'

export default function Toolbar() {
  const projectName = useWorkspaceStore((s) => s.currentProject?.name ?? null)
  const dirty = useWorkspaceStore((s) => s.openTabs.some((t) => t.dirty))
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const panels = usePanels()
  const resetLayout = useDockStore((s) => s.resetLayout)
  const importPolicy = useLibraryUiStore((s) => s.policy)
  const runtimeTarget = useRuntimeStore((s) => s.target)
  const stopRuntime = useRuntimeStore((s) => s.clearTarget)
  const [editMenu, setEditMenu] = useState<{ x: number; y: number } | null>(null)

  /** 触发 keymap 注册的 file.save（与 Ctrl+S 同一 handler） */
  const onSave = (): void => {
    getBindings('file.save')[0]?.handler()
  }

  const panelItems: MenuItem[] = panels
    .filter((p) => !p.id.startsWith('asset:'))
    .map((p) => {
      const open = findTabsByPanel(useDockStore.getState().root, p.id) !== null
      return {
        label: `${open ? '关闭' : '打开'}「${p.title}」`,
        icon: open ? EyeOff : Eye,
        onSelect: () => {
          if (open) requestClosePanel(p.id)
          else useDockStore.getState().openPanel(p.id, p.defaultArea)
        },
      }
    })

  const setPolicy = (policy: 'skip' | 'overwrite' | 'rename'): void => {
    useLibraryUiStore.getState().setPolicy(policy)
  }

  const editItems: MenuItem[] = [
    { label: '面板', icon: LayoutDashboard, children: panelItems },
    { label: '撤销', icon: Undo2, shortcut: 'Ctrl+Z', disabled: !canUndo, onSelect: () => undo() },
    { label: '重做', icon: Redo2, shortcut: 'Ctrl+Shift+Z', disabled: !canRedo, onSelect: () => redo() },
    { label: '重置布局', icon: RotateCcw, onSelect: resetLayout },
    { separator: true },
    {
      label: '资源库',
      icon: LibraryBig,
      children: [
        {
          label: '导入…',
          icon: Download,
          hint: 'zip',
          onSelect: () => useLibraryUiStore.getState().openModal('import'),
        },
        {
          label: '导出…',
          icon: Upload,
          onSelect: () => useLibraryUiStore.getState().openModal('export'),
        },
        {
          label: '冲突处理',
          icon: GitMerge,
          children: [
            {
              label: '冲突跳过',
              hint: importPolicy === 'skip' ? '当前' : undefined,
              onSelect: () => setPolicy('skip'),
            },
            {
              label: '冲突覆盖',
              hint: importPolicy === 'overwrite' ? '当前' : undefined,
              onSelect: () => setPolicy('overwrite'),
            },
            {
              label: '并存改名',
              hint: importPolicy === 'rename' ? '当前' : undefined,
              onSelect: () => setPolicy('rename'),
            },
          ],
        },
        {
          label: '新建函数…',
          icon: FilePlus2,
          onSelect: () => useLibraryUiStore.getState().openModal('create'),
        },
      ],
    },
  ]

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button
          type="button"
          className="toolbar-logo toolbar-logo-btn"
          title="点击展开 / 收起左侧菜单（文件系统 · 资源库）"
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

      <div className="toolbar-center">
        {runtimeTarget ? (
          <button
            type="button"
            className="toolbar-btn toolbar-stop"
            onClick={stopRuntime}
            title="停止运行：卸载内置运行视图、中止蓝图运行时与定时器"
          >
            <Icon icon={Square} size={12} />
            停止
          </button>
        ) : (
          <button
            type="button"
            className="toolbar-btn toolbar-primary"
          onClick={() => void launchRuntime()}
          title="运行（F5）—— 运行当前打开的蓝图（内置运行视图，可拆出独立窗口）"
          >
            <Icon icon={Play} size={13} />
            运行
            <kbd className="toolbar-kbd">F5</kbd>
          </button>
        )}
        <button type="button" className="toolbar-btn" disabled title="调试开关 —— T5.4 调试观察通道接入">
          <Icon icon={Bug} size={13} />
          调试
        </button>
        <span className="toolbar-divider" aria-hidden />
        <button type="button" className="toolbar-btn" onClick={onSave} title="保存（Ctrl+S）">
          <Icon icon={Save} size={13} />
          保存
          <kbd className="toolbar-kbd">Ctrl+S</kbd>
          <span
            className="toolbar-status-dot"
            data-dirty={dirty || undefined}
            title={dirty ? '有未保存修改' : '已保存'}
            aria-label={dirty ? '有未保存修改' : '已保存'}
          />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-right">
        <button
          type="button"
          className="toolbar-btn"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setEditMenu({ x: Math.max(8, rect.right - 220), y: rect.bottom + 4 })
          }}
          title="编辑：面板 / 撤销 / 重做 / 重置布局 / 资源库"
          aria-haspopup="menu"
        >
          <Icon icon={PenLine} size={13} />
          编辑
        </button>
        {editMenu ? (
          <Menu
            x={editMenu.x}
            y={editMenu.y}
            items={editItems}
            onClose={() => setEditMenu(null)}
          />
        ) : null}

        <IconButton
          icon={Settings}
          label="设置"
          shortcut="Ctrl+,"
          onClick={() => openSettings()}
        />
      </div>
    </div>
  )
}
