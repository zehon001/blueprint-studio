/**
 * 工作区「UI 编辑」tab 内容（PM 集成胶水 · T1.3/T1.4/T1.5 × 共享 ui-editor store）
 *
 * 职责：tab 激活时把 .ui.json 载入共享 store（openUIAsset），渲染 UIEditorPanel；
 * Ctrl+S（file.save 重绑定）→ saveUIAsset() → 清脏；脏标记监听 scene-tree 域命令。
 * 切走 tab 时 close()（域状态替换语义，重开安全——见 ui-editor/store.ts 注释）。
 */
import { useEffect, useState } from 'react'
import { UIEditorPanel } from '@/ui-editor'
import { SceneTreePanel } from '@/panels/scene-tree/SceneTreePanel'
import { useUIEditorStore } from '@/ui-editor/store'
import { peekUndo, subscribeReplay, useEditorStore } from '@/shell/commands'
import { registerShortcut, unregisterShortcut } from '@/shell/keymap/registry'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useDockStore } from '@/shell/dock/store'
import { assetPanelId } from '@/shell/dock/assetPanelModel'
import { useSelectionStore } from '@/shell/selection/store'

export function UITab({ assetPath, panelId }: { assetPath: string; panelId?: string }) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const projectPath = project?.path ?? null
  const tabId = tabIdOf('ui', assetPath)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const clearDirty = useWorkspaceStore((s) => s.clearDirty)
  const status = useUIEditorStore((s) => (s.assetPath === assetPath ? s.status : 'idle'))
  const message = useUIEditorStore((s) => (s.assetPath === assetPath ? s.message : ''))
  const projectPathState = useUIEditorStore((s) => s.projectPath)
  const openUIAsset = useUIEditorStore((s) => s.openUIAsset)
  const saveUIAsset = useUIEditorStore((s) => s.saveUIAsset)
  const uid = panelId ?? assetPanelId('ui', assetPath)
  const activePanelId = useDockStore((s) => s.activePanelId)
  const selection = useUIEditorStore((s) => s.selection)
  const publishSelection = useSelectionStore((s) => s.publish)
  const clearSelection = useSelectionStore((s) => s.clear)
  /** v3 T9.4：左栏三分页（UI 树 / 元素库 / 样式库） */
  const [leftTab, setLeftTab] = useState<'tree' | 'elements' | 'styles'>('tree')

  /* v3 T8.2：统一选择协议——本面板激活且就绪时发布 UI 选中节点 */
  useEffect(() => {
    if (status !== 'ready' || activePanelId !== uid) return
    publishSelection({ source: 'ui', panelId: uid, assetPath, nodeIds: selection })
  }, [status, activePanelId, uid, assetPath, selection, publishSelection])
  useEffect(
    () => () => {
      clearSelection('ui', uid)
    },
    [clearSelection, uid],
  )

  /* 打开/切换资产（projectPath 与 store 现值不一致或资产不同才重载） */
  useEffect(() => {
    if (!projectPath) return
    if (projectPathState !== projectPath) {
      useUIEditorStore.getState().close()
    }
    void openUIAsset(projectPath, assetPath)
    return () => {
      /* 卸载即关闭：避免与其它 UI tab 的域状态串台 */
      if (useUIEditorStore.getState().assetPath === assetPath) useUIEditorStore.getState().close()
    }
  }, [projectPath, assetPath])

  /* 脏标记：scene-tree 域命令 / undo / redo */
  useEffect(() => {
    let lastLen = useEditorStore.getState().undoStack.length
    const unsubStore = useEditorStore.subscribe((s) => {
      if (s.undoStack.length > lastLen) {
        const top = peekUndo()
        if (top?.domain === 'scene-tree') markDirty(tabId)
      }
      lastLen = s.undoStack.length
    })
    const unsubReplay = subscribeReplay((notice) => {
      if (notice.domains.includes('scene-tree')) markDirty(tabId)
    })
    return () => {
      unsubStore()
      unsubReplay()
    }
  }, [tabId, markDirty])

  /* Ctrl+S → 保存资产（重绑定 file.save，卸载恢复默认空实现） */
  useEffect(() => {
    const reg = registerShortcut(
      {
        id: 'file.save',
        label: '保存',
        keys: 'Ctrl+S',
        handler: () => {
          void saveUIAsset().then((ok) => {
            if (ok) clearDirty(tabId)
          })
        },
      },
      { force: true },
    )
    return () => {
      unregisterShortcut('file.save')
      void reg
    }
  }, [tabId, saveUIAsset, clearDirty])

  if (status === 'loading') return <div className="workspace-tab-loading">加载中…</div>
  if (status === 'error') return <div className="workspace-tab-loading workspace-tab-error">{message || '加载失败'}</div>
  if (status !== 'ready') {
    return (
      <div className="workspace-tab-loading">
        {projectPath ? '加载中…' : '未打开项目（从项目管理器进入编辑器）'}
      </div>
    )
  }
  return (
    <div className="ui-editor-shell">
      <aside className="ui-editor-left">
        <div className="ui-editor-modebar" role="tablist" aria-label="编辑器模式">
          <button type="button" className="ui-editor-mode active" role="tab" aria-selected="true">
            设计
          </button>
          <button type="button" className="ui-editor-mode" role="tab" aria-selected="false" disabled title="M10 接入内嵌蓝图">
            蓝图
          </button>
        </div>
        <div className="ui-editor-left-tabs" role="tablist" aria-label="UI 编辑器左栏">
          {(
            [
              ['tree', 'UI 树'],
              ['elements', '元素库'],
              ['styles', '样式库'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={leftTab === id}
              className={`ui-editor-left-tab${leftTab === id ? ' active' : ''}`}
              onClick={() => setLeftTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ui-editor-left-body">
          {leftTab === 'tree' ? (
            <SceneTreePanel />
          ) : (
            <div className="dock-panel-placeholder">
              {leftTab === 'elements'
                ? '元素库：M11 接入（基础控件 / 内置元素 / 项目元素 / 预制体）'
                : '样式库：M11 接入（应用表 / 类列表 / 查找引用）'}
            </div>
          )}
        </div>
      </aside>
      <div className="ui-editor-main">
        <UIEditorPanel />
      </div>
    </div>
  )
}
