/**
 * 顶栏（T0.3 · PLAN §6.2）
 *
 * 左：logo「Blueprint Studio」+ 当前项目名（workspace-store，?project= 初始化）；
 * 中：运行(F5) / 运行当前(F6)（runtime-launch，T1.6）、调试开关（占位 disabled，T5.4 接入）、
 *     保存(Ctrl+S)——触发 keymap 注册的 file.save（本期空实现，dirty 标记在 workspace-store）；
 * 右：撤销/重做（命令栈，tooltip 显示最近命令 label）、「面板 ▾」下拉（列出全部注册面板）、
 *     「重置布局」（恢复默认布局）。
 * F5/F6 快捷键注册在入口 main.tsx（attachKeyboard 已 preventDefault，不触发浏览器刷新）。
 */
import { useEffect, useRef, useState } from 'react'
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
import { openSettings } from '@/shell/settings'

/** 顶栏栈顶命令摘要选择器（tooltip 显示 label 用） */
function topUndo(s: { undoStack: CommandEntry[] }): CommandEntry | undefined {
  return s.undoStack[s.undoStack.length - 1]
}
function topRedo(s: { redoStack: CommandEntry[] }): CommandEntry | undefined {
  return s.redoStack[s.redoStack.length - 1]
}

export default function Toolbar() {
  const projectName = useWorkspaceStore((s) => s.currentProject?.name ?? null)
  const canUndo = useCanUndo()
  const canRedo = useCanRedo()
  const undoTop = useEditorStore(topUndo)
  const redoTop = useEditorStore(topRedo)
  const panels = usePanels()
  const root = useDockStore((s) => s.root)
  const openPanel = useDockStore((s) => s.openPanel)
  const closePanel = useDockStore((s) => s.closePanel)
  const resetLayout = useDockStore((s) => s.resetLayout)

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 菜单打开时点击外部关闭
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [menuOpen])

  /** 触发 keymap 注册的 file.save（与 Ctrl+S 同一 handler；本期空实现） */
  const onSave = (): void => {
    getBindings('file.save')[0]?.handler()
  }

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <span className="toolbar-logo">Blueprint Studio</span>
        <span className="toolbar-project" title="当前项目（?project= 初始化，T0.6 项目管理器接入）">
          {projectName ?? '未打开项目'}
        </span>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-center">
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => launchRuntimeMain()}
          title="运行主 UI（F5）—— 独立窗口，ui 取 project.json.mainUI"
        >
          ▶ 运行(F5)
        </button>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => launchRuntimeCurrent()}
          title="运行当前 UI（F6）—— 独立窗口运行激活的 .ui.json 资产"
        >
          ▶ 运行当前(F6)
        </button>
        <button type="button" className="toolbar-btn" disabled title="调试开关 —— T5.4 调试观察通道接入">
          调试
        </button>
        <button type="button" className="toolbar-btn" onClick={onSave} title="保存（Ctrl+S）—— 保存链路 T0.7 / T1.x 接入">
          保存(Ctrl+S)
        </button>
      </div>

      <div className="toolbar-spacer" />

      <div className="toolbar-right">
        <button
          type="button"
          className="toolbar-btn"
          disabled={!canUndo}
          onClick={() => undo()}
          title={undoTop ? `撤销：${undoTop.label}` : '撤销（无可撤销命令）'}
        >
          ↶ 撤销
        </button>
        <button
          type="button"
          className="toolbar-btn"
          disabled={!canRedo}
          onClick={() => redo()}
          title={redoTop ? `重做：${redoTop.label}` : '重做（无可重做命令）'}
        >
          ↷ 重做
        </button>

        <div className="toolbar-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => setMenuOpen((v) => !v)}
            title="打开 / 关闭面板"
          >
            面板 ▾
          </button>
          {menuOpen ? (
            <div className="toolbar-menu">
              {panels.map((p) => {
                const open = findTabsByPanel(root, p.id) !== null
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="toolbar-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      if (open) closePanel(p.id)
                      else openPanel(p.id, p.defaultArea)
                    }}
                    title={open ? `关闭「${p.title}」` : `打开「${p.title}」`}
                  >
                    <span className={`toolbar-menu-dot${open ? ' on' : ''}`} />
                    {p.title}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>

        <button type="button" className="toolbar-btn" onClick={resetLayout} title="恢复默认布局">
          重置布局
        </button>
        <button
          type="button"
          className="toolbar-btn toolbar-gear"
          onClick={() => openSettings()}
          title="设置（Ctrl+,）"
          aria-label="设置"
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
