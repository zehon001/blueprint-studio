/**
 * 蓝图页右上操作（编辑菜单 / 设置）
 *
 * 原顶栏右侧操作迁入蓝图页头，位于编辑器运行/保存按钮上方。
 */
import { useState } from 'react'
import {
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  GitMerge,
  LayoutDashboard,
  LibraryBig,
  PenLine,
  Redo2,
  RotateCcw,
  Settings,
  Undo2,
  Upload,
} from 'lucide-react'
import { redo, undo, useCanRedo, useCanUndo } from '@/shell/commands'
import { usePanels } from '@/shell/dock/registry'
import { useDockStore } from '@/shell/dock/store'
import { findTabsByPanel } from '@/shell/dock/tree'
import { requestClosePanel } from '@/shell/dock/assetPanelModel'
import { openSettings } from '@/shell/settings'
import { Icon } from '@/shell/ui/Icon'
import { IconButton } from '@/shell/ui/IconButton'
import { Menu, type MenuItem } from '@/shell/ui/Menu'
import { useLibraryUiStore } from '@/panels/library/ui-store'

export function BlueprintPageActions() {
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const panels = usePanels()
  const resetLayout = useDockStore((s) => s.resetLayout)
  const importPolicy = useLibraryUiStore((s) => s.policy)
  const [editMenu, setEditMenu] = useState<{ x: number; y: number } | null>(null)

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
    <div className="bp-page-actions">
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
  )
}
