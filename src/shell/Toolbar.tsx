/**
 * 顶栏（T0.3 · PLAN §6.2 · UI-REDESIGN P5）
 *
 * 左：Logo（Boxes + 字标）+ 项目 chip（点击返回项目管理器切换项目）；
 * 中：运行（实心强调）/ 运行当前（outline）/ 调试（ghost）/ 分隔线 / 保存（附带脏状态点）；
 * 右：撤销 / 重做 IconButton、面板菜单（统一 Menu）、重置布局、设置。
 * F5/F6 快捷键注册在入口 main.tsx（attachKeyboard 已 preventDefault，不触发浏览器刷新）。
 */
import { useState } from 'react'
import {
  Boxes,
  Bug,
  Eye,
  EyeOff,
  LayoutDashboard,
  Package,
  Play,
  PlayCircle,
  Redo2,
  RotateCcw,
  Save,
  Settings,
  Undo2,
} from 'lucide-react'
import {
  redo,
  undo,
  useCanRedo,
  useCanUndo,
  useEditorStore,
  type CommandEntry,
} from '@/shell/commands'
import { getBindings } from '@/shell/keymap/registry'
import { launchRuntimeCurrent, launchRuntimeMain } from '@/shell/runtime-launch'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { usePanels } from '@/shell/dock/registry'
import { useDockStore } from '@/shell/dock/store'
import { findTabsByPanel } from '@/shell/dock/tree'
import { requestClosePanel } from '@/shell/dock/assetPanelModel'
import { openSettings } from '@/shell/settings'
import { Icon } from '@/shell/ui/Icon'
import { IconButton } from '@/shell/ui/IconButton'
import { Menu, type MenuItem } from '@/shell/ui/Menu'

/** 顶栏栈顶命令摘要选择器（tooltip 显示 label 用） */
function topUndo(s: { undoStack: CommandEntry[] }): CommandEntry | undefined {
  return s.undoStack[s.undoStack.length - 1]
}
function topRedo(s: { redoStack: CommandEntry[] }): CommandEntry | undefined {
  return s.redoStack[s.redoStack.length - 1]
}

export default function Toolbar() {
  const projectName = useWorkspaceStore((s) => s.currentProject?.name ?? null)
  const dirty = useWorkspaceStore((s) => s.openTabs.some((t) => t.dirty))
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const undoTop = useEditorStore(topUndo)
  const redoTop = useEditorStore(topRedo)
  const panels = usePanels()
  const resetLayout = useDockStore((s) => s.resetLayout)
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number } | null>(null)

  /** 触发 keymap 注册的 file.save（与 Ctrl+S 同一 handler） */
  const onSave = (): void => {
    getBindings('file.save')[0]?.handler()
  }

  const panelItems: MenuItem[] = panels.map((p) => {
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

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-logo">
          <Icon icon={Boxes} size={16} />
          <span>Blueprint Studio</span>
        </span>
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
        <button
          type="button"
          className="toolbar-btn toolbar-primary"
          onClick={() => launchRuntimeMain()}
          title="运行主 UI（F5）—— 内置运行视图（可拆出独立窗口），ui 取 project.json.mainUI"
        >
          <Icon icon={Play} size={13} />
          运行
          <kbd className="toolbar-kbd">F5</kbd>
        </button>
        <button
          type="button"
          className="toolbar-btn toolbar-outline"
          onClick={() => launchRuntimeCurrent()}
          title="运行当前 UI（F6）—— 内置运行视图运行激活的 .ui.json 资产"
        >
          <Icon icon={PlayCircle} size={13} />
          运行当前
          <kbd className="toolbar-kbd">F6</kbd>
        </button>
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
        <IconButton
          icon={Undo2}
          label={undoTop ? `撤销：${undoTop.label}` : '撤销'}
          shortcut="Ctrl+Z"
          disabled={!canUndo}
          onClick={() => undo()}
        />
        <IconButton
          icon={Redo2}
          label={redoTop ? `重做：${redoTop.label}` : '重做'}
          shortcut="Ctrl+Shift+Z"
          disabled={!canRedo}
          onClick={() => redo()}
        />

        <button
          type="button"
          className="toolbar-btn"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setPanelMenu({ x: Math.max(8, rect.right - 200), y: rect.bottom + 4 })
          }}
          title="打开 / 关闭面板"
          aria-haspopup="menu"
        >
          <Icon icon={LayoutDashboard} size={13} />
          面板
        </button>
        {panelMenu ? (
          <Menu
            x={panelMenu.x}
            y={panelMenu.y}
            items={panelItems}
            onClose={() => setPanelMenu(null)}
          />
        ) : null}

        <IconButton icon={RotateCcw} label="重置布局" onClick={resetLayout} />
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
