/**
 * 工作区「UI 编辑」tab 内容（PM 集成胶水 · T1.3/T1.4/T1.5 × 共享 ui-editor store）
 *
 * 职责：tab 激活时把 .ui.json 载入共享 store（openUIAsset），渲染 UIEditorPanel；
 * Ctrl+S（file.save 重绑定）→ saveUIAsset() → 清脏；脏标记监听 scene-tree 域命令。
 * 切走 tab 时 close()（域状态替换语义，重开安全——见 ui-editor/store.ts 注释）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { UIEditorPanel } from '@/ui-editor'
import { BlueprintEditorPanel } from '@/blueprint'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { onUIBlueprintRequest, requestUIBlueprint } from './uiBlueprintBridge'
import { ValidationBar } from '@/blueprint/interaction/ValidationBar'
import type { ValidationIssue } from '@/ir/validate'
import { validateOpenUIAsset } from '@/ui-editor/validateOpen'
import { SceneTreePanel } from '@/panels/scene-tree/SceneTreePanel'
import { ElementLibraryPanel, StyleLibraryPanel } from '@/panels/library'
import { getSceneTreeDomain, runUICommand, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import { applyEmbeddedBlueprint, embeddedBlueprintOf } from '@/ui-editor/embedded'
import type { IRAsset, UIAsset } from '@/ir/types'
import { peekUndo, subscribeReplay, useEditorStore } from '@/shell/commands'
import { registerSaveHandler } from './saveRegistry'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useDockStore } from '@/shell/dock/store'
import { findTabsByPanel } from '@/shell/dock/tree'
import { assetPanelId } from '@/shell/dock/assetPanelModel'
import { useSelectionStore } from '@/shell/selection/store'
// BUG1：UI tab 直接内嵌 SceneTreePanel，入口 index.ts 的 CSS 不会执行；
// 这里显式引入树/右键菜单样式（否则选中底色、拖拽落区、行高全部失效）。
import '@/panels/file-system/menu.css'
import '@/panels/scene-tree/styles.css'
// 设计模式也使用蓝图校验条（引用完整性 v3）
import '@/blueprint/interaction/interaction.css'

export function UITab({
  assetPath,
  panelId,
  kind = 'ui',
}: {
  assetPath: string
  panelId?: string
  kind?: 'ui' | 'element'
}) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const projectPath = project?.path ?? null
  const tabId = tabIdOf(kind, assetPath)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const clearDirty = useWorkspaceStore((s) => s.clearDirty)
  const dirty = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId)?.dirty ?? false)
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
  /** v3 T13.1：引用完整性校验结果（设计/蓝图共用） */
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null)
  const asset = useSceneTreeDomain().asset
  /** 蓝图视图（按资产引用缓存，避免每次渲染重置蓝图 store） */
  const blueprintView = useMemo(() => (asset ? embeddedBlueprintOf(asset) : null), [asset])

  /** v3 T13.1：打开/保存/编辑后收集跨文件引用校验 */
  const runValidation = useCallback(async (): Promise<ValidationIssue[]> => {
    const a = getSceneTreeDomain().asset
    if (!a) return []
    const result = await validateOpenUIAsset({
      projectPath,
      asset: a,
      assetPath,
      styleSheets: useUIEditorStore.getState().styleSheets,
    })
    setIssues(result.issues)
    return result.issues
  }, [projectPath, assetPath])

  /** 设计模式保存：先校验（错误阻止保存），再落盘 + 清脏 */
  const saveDesign = useCallback(async (): Promise<boolean> => {
    const found = await runValidation()
    if (found.some((i) => i.severity === 'error')) return false
    const ok = await saveUIAsset()
    if (ok) clearDirty(tabId)
    return ok
  }, [runValidation, saveUIAsset, clearDirty, tabId])

  /** 内嵌蓝图保存：写回 UI 资产（整资产一次落盘）+ 引用校验 + 清脏 */
  const saveEmbedded = async (ir: IRAsset): Promise<boolean> => {
    runUICommand('编辑内嵌蓝图', (draft) => {
      applyEmbeddedBlueprint(draft as UIAsset, ir)
    })
    const found = await runValidation()
    if (found.some((i) => i.severity === 'error')) return false
    const ok = await saveUIAsset()
    if (ok) clearDirty(tabId)
    return ok
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

  /* v3：检视器/事件面板「跳转」→ 切蓝图模式、打开事件图并选中事件入口节点 */
  useEffect(
    () =>
      onUIBlueprintRequest((detail) => {
        if (detail.assetPath && detail.assetPath !== assetPath) return
        setMode('blueprint')
        window.setTimeout(() => {
          const st = useBlueprintStore.getState()
          const graphName = detail.graph ?? st.asset?.entry ?? 'event'
          if (st.asset?.graphs[graphName]) st.switchGraph(graphName)
          const graph = st.asset?.graphs[graphName]
          if (!graph) return
          const eventName = detail.eventName
          const hit =
            (detail.nodeId ? graph.nodes.find((n) => n.id === detail.nodeId) : null) ??
            (eventName
              ? graph.nodes.find(
                  (n) =>
                    n.type === 'event.custom' &&
                    (String(n.params?.eventName ?? '') === eventName ||
                      String(n.comment ?? '').includes(eventName)),
                )
              : null)
          if (hit) st.setSelection({ nodeIds: [hit.id], edgeIds: [] })
        }, 60)
      }),
    [assetPath],
  )

  /* v3 T13.1：载入/编辑后自动校验（300ms 防抖，命令栈变化触发） */
  useEffect(() => {
    if (status !== 'ready') return
    void runValidation()
    let timer: number | null = null
    let lastLen = useEditorStore.getState().undoStack.length
    const unsub = useEditorStore.subscribe((s) => {
      if (s.undoStack.length === lastLen) return
      lastLen = s.undoStack.length
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void runValidation(), 300)
    })
    return () => {
      unsub()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [status, runValidation])

  /**
   * 本面板是否为自己的 dock 组当前显示的页。
   * 一个 dock 组里的非活动 tab 仍然挂载（display:none）；它们不能调用
   * openUIAsset，否则会与当前页争抢共享 editor store，出现「激活 StatCard
   * 但树/画布是 main」的串台。
   */
  const visibleActive = useDockStore((s) => {
    const hit = findTabsByPanel(s.root, uid)
    return hit ? hit.node.panels[hit.node.active] === uid : false
  })
  const storeAssetPath = useUIEditorStore((s) => s.assetPath)

  /* 卸载即关闭：避免与其它 UI tab 的域状态串台（只在真正卸载时执行） */
  useEffect(
    () => () => {
      if (useUIEditorStore.getState().assetPath === assetPath) useUIEditorStore.getState().close()
    },
    [assetPath],
  )

  /**
   * 打开/切换资产：只由组内当前显示页加载；隐藏 tab 等切到前台再载入。
   * store 已是本资产时不重复加载（loading / ready / error 都保持现状）。
   */
  useEffect(() => {
    if (!projectPath || !visibleActive) return
    if (storeAssetPath === assetPath && status !== 'idle') return
    if (projectPathState !== projectPath) useUIEditorStore.getState().close()
    void openUIAsset(projectPath, assetPath)
  }, [
    projectPath,
    assetPath,
    visibleActive,
    storeAssetPath,
    status,
    projectPathState,
    openUIAsset,
  ])

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

  /* Ctrl+S → 活动面板保存分发（设计模式由本面板处理；蓝图模式注册 BlueprintEditorPanel 的处理函数） */
  useEffect(() => {
    if (mode !== 'design') return
    return registerSaveHandler(uid, saveDesign)
  }, [mode, saveDesign, uid])

  if (status === 'loading') return <div className="workspace-tab-loading">加载中…</div>
  if (status === 'error') return <div className="workspace-tab-loading workspace-tab-error">{message || '加载失败'}</div>
  if (status !== 'ready') {
    return (
      <div className="workspace-tab-loading">
        {projectPath ? '加载中…' : '未打开项目（从项目管理器进入编辑器）'}
      </div>
    )
  }
  const onIssueJump = (issue: ValidationIssue): void => {
    if (issue.graphName && issue.nodeId) {
      requestUIBlueprint({ assetPath, graph: issue.graphName, nodeId: issue.nodeId })
      return
    }
    if (issue.nodeId) useUIEditorStore.getState().setSelection([issue.nodeId])
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
              panelId={uid}
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
      {mode === 'design' ? (
        <ValidationBar
          issues={issues}
          dirty={dirty}
          graphName="event"
          onJump={onIssueJump}
          onSave={() => void saveDesign()}
        />
      ) : null}
    </div>
  )
}
