/**
 * 工作区「UI 编辑」tab 内容（PM 集成胶水 · T1.3/T1.4/T1.5 × 共享 ui-editor store）
 *
 * 职责：tab 激活时把 .ui.json 载入共享 store（openUIAsset），渲染 UIEditorPanel；
 * Ctrl+S（file.save 重绑定）→ saveUIAsset() → 清脏；脏标记监听 scene-tree 域命令。
 * 切走 tab 时 close()（域状态替换语义，重开安全——见 ui-editor/store.ts 注释）。
 */
import { useEffect, useMemo, useState } from 'react'
import { UIEditorPanel } from '@/ui-editor'
import { BlueprintEditorPanel } from '@/blueprint'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { SceneTreePanel } from '@/panels/scene-tree/SceneTreePanel'
import { ElementLibraryPanel, StyleLibraryPanel } from '@/panels/library'
import { runUICommand, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import { applyEmbeddedBlueprint, embeddedBlueprintOf } from '@/ui-editor/embedded'
import type { IRAsset, UIAsset } from '@/ir/types'
import { peekUndo, subscribeReplay, useEditorStore } from '@/shell/commands'
import { registerShortcut, unregisterShortcut } from '@/shell/keymap/registry'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useDockStore } from '@/shell/dock/store'
import { assetPanelId } from '@/shell/dock/assetPanelModel'
import { useSelectionStore } from '@/shell/selection/store'
// BUG1：UI tab 直接内嵌 SceneTreePanel，入口 index.ts 的 CSS 不会执行；
// 这里显式引入树/右键菜单样式（否则选中底色、拖拽落区、行高全部失效）。
import '@/panels/file-system/menu.css'
import '@/panels/scene-tree/styles.css'

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
  const bpSelection = useBlueprintStore((s) => s.selection)
  const bpGraph = useBlueprintStore((s) => s.graphName)
  const publishSelection = useSelectionStore((s) => s.publish)
  const clearSelection = useSelectionStore((s) => s.clear)
  /** v3 T9.4：左栏三分页（UI 树 / 元素库 / 样式库） */
  const [leftTab, setLeftTab] = useState<'tree' | 'elements' | 'styles'>('tree')
  /** v3 T10.2：设计 / 内嵌蓝图双模式 */
  const [mode, setMode] = useState<'design' | 'blueprint'>('design')
  const asset = useSceneTreeDomain().asset
  /** 蓝图视图（按资产引用缓存，避免每次渲染重置蓝图 store） */
  const blueprintView = useMemo(() => (asset ? embeddedBlueprintOf(asset) : null), [asset])

  /** 内嵌蓝图保存：写回 UI 资产（整资产一次落盘）+ 清脏 */
  const saveEmbedded = (ir: IRAsset): void => {
    runUICommand('编辑内嵌蓝图', (draft) => {
      applyEmbeddedBlueprint(draft as UIAsset, ir)
    })
    void saveUIAsset().then((ok) => {
      if (ok) clearDirty(tabId)
    })
  }

  /**
   * 设计/蓝图切换：蓝图编辑器的未保存节点只存在于 blueprint store。
   * 切回设计前把当前 IR 同步进 UI 资产（命令栈内，标脏），否则面板卸载后
   * 重新 mount 会从旧资产重建，刚加的节点就“消失”了。
   */
  const switchMode = (next: 'design' | 'blueprint'): void => {
    if (next === mode) return
    if (next === 'design' && mode === 'blueprint') {
      const ir = useBlueprintStore.getState().asset
      if (ir && asset) {
        const before = embeddedBlueprintOf(asset)
        if (JSON.stringify(before) !== JSON.stringify(ir)) {
          runUICommand('蓝图：同步到设计资产', (draft) => {
            applyEmbeddedBlueprint(draft as UIAsset, ir)
          })
        }
      }
    }
    setMode(next)
  }

  /* v3 T8.2：统一选择协议——按设计/蓝图模式发布对应选择，让检视器切换内容 */
  useEffect(() => {
    if (status !== 'ready' || activePanelId !== uid) return
    if (mode === 'blueprint') {
      publishSelection({
        source: 'blueprint',
        panelId: uid,
        assetPath,
        graph: bpGraph,
        nodeIds: bpSelection.nodeIds,
        edgeIds: bpSelection.edgeIds,
      })
    } else {
      publishSelection({ source: 'ui', panelId: uid, assetPath, nodeIds: selection })
    }
  }, [
    status,
    activePanelId,
    uid,
    assetPath,
    mode,
    selection,
    bpSelection,
    bpGraph,
    publishSelection,
  ])
  useEffect(
    () => () => {
      clearSelection('ui', uid)
      clearSelection('blueprint', uid)
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

  /* BUG5：多个 UI tab 共享同一 editor store。切回本 tab 时若共享资产已被别的
   * tab 替换，重新载入本资产（否则隐藏 tab 永远停在「加载中」/显示别人的资产）。 */
  const storeAssetPath = useUIEditorStore((s) => s.assetPath)
  useEffect(() => {
    if (!projectPath || activePanelId !== uid) return
    if (storeAssetPath === assetPath) return
    if (projectPathState !== projectPath) useUIEditorStore.getState().close()
    void openUIAsset(projectPath, assetPath)
  }, [activePanelId, uid, storeAssetPath, assetPath, projectPath, projectPathState, openUIAsset])

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
      <div className="ui-editor-modebar" role="tablist" aria-label="编辑器模式">
        <button
          type="button"
          className={`ui-editor-mode${mode === 'design' ? ' active' : ''}`}
          role="tab"
          aria-selected={mode === 'design'}
          onClick={() => switchMode('design')}
        >
          设计
        </button>
        <button
          type="button"
          className={`ui-editor-mode${mode === 'blueprint' ? ' active' : ''}`}
          role="tab"
          aria-selected={mode === 'blueprint'}
          onClick={() => switchMode('blueprint')}
          title="编辑本资产的内嵌蓝图（事件图 / 函数 / 变量）"
        >
          蓝图
        </button>
      </div>
      <div className="ui-editor-workspace">
        {mode === 'blueprint' ? (
          blueprintView ? (
            <BlueprintEditorPanel
              asset={blueprintView}
              assetPath={assetPath}
              onSave={(ir) => saveEmbedded(ir)}
              className="ui-editor-blueprint"
            />
          ) : (
            <div className="dock-panel-placeholder">加载内嵌蓝图…</div>
          )
        ) : (
          <>
            <aside className="ui-editor-left">
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
                ) : leftTab === 'elements' ? (
                  <ElementLibraryPanel onCreated={() => setLeftTab('tree')} />
                ) : (
                  <StyleLibraryPanel />
                )}
              </div>
            </aside>
            <div className="ui-editor-main">
              <UIEditorPanel />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
