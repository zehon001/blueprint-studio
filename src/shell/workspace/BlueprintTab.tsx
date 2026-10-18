/**
 * 工作区「蓝图编辑」tab 内容（PM 集成胶水 · T2.2 × T0.7 × 命令栈）
 *
 * 职责：按 workspace-store 的项目上下文 + tab assetPath 加载 .bp.json
 * （GET /api/file → deserializeIR），渲染 BlueprintEditorPanel；
 * Ctrl+S（面板内 file.save 重绑定）校验通过后 → serializeIR → PUT /api/file 落盘 → 清脏。
 * 脏标记来源：命令栈 undoStack 增长（domain='blueprint' 的新命令）与 undo/redo 重放。
 */
import { useCallback, useEffect, useState } from 'react'
import { BlueprintEditorPanel } from '@/blueprint'
import { deserializeIR, serializeIR } from '@/ir/validate'
import type { IRAsset } from '@/ir/types'
import { peekUndo, subscribeReplay, useEditorStore } from '@/shell/commands'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { useDockStore } from '@/shell/dock/store'
import { assetPanelId } from '@/shell/dock/assetPanelModel'
import { useSelectionStore } from '@/shell/selection/store'

interface LoadState {
  status: 'loading' | 'ready' | 'missing' | 'error'
  asset: IRAsset | null
  message: string
}

/** 项目内相对路径 → 服务端安全根路径（首段=项目文件夹名） */
function fullPath(projectPath: string, assetPath: string): string {
  return `${projectPath}/${assetPath}`
}

function emptyBlueprint(name: string): IRAsset {
  return {
    version: 2,
    name,
    entry: 'bind',
    graphs: { bind: { nodes: [], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

export function BlueprintTab({ assetPath, panelId }: { assetPath: string; panelId?: string }) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const clearDirty = useWorkspaceStore((s) => s.clearDirty)
  const tabId = tabIdOf('blueprint', assetPath)
  const [state, setState] = useState<LoadState>({ status: 'loading', asset: null, message: '' })
  const [reloadKey, setReloadKey] = useState(0)
  /* v3 T8.2：统一选择协议——本面板激活且就绪时发布蓝图选中节点/图名 */
  const uid = panelId ?? assetPanelId('blueprint', assetPath)
  const activePanelId = useDockStore((s) => s.activePanelId)
  const bpSelection = useBlueprintStore((s) => s.selection)
  const bpGraph = useBlueprintStore((s) => s.graphName)
  const publishSelection = useSelectionStore((s) => s.publish)
  const clearSelection = useSelectionStore((s) => s.clear)
  useEffect(() => {
    if (state.status !== 'ready' || activePanelId !== uid) return
    publishSelection({
      source: 'blueprint',
      panelId: uid,
      assetPath,
      graph: bpGraph,
      nodeIds: bpSelection.nodeIds,
      edgeIds: bpSelection.edgeIds,
    })
  }, [state.status, activePanelId, uid, assetPath, bpGraph, bpSelection, publishSelection])
  useEffect(
    () => () => {
      clearSelection('blueprint', uid)
    },
    [clearSelection, uid],
  )

  /* 加载 .bp.json */
  useEffect(() => {
    if (!project) {
      setState({ status: 'error', asset: null, message: '未打开项目（从项目管理器进入编辑器）' })
      return
    }
    let alive = true
    setState((s) => ({ ...s, status: 'loading', asset: null, message: '' }))
    fetch(`/api/file?path=${encodeURIComponent(fullPath(project.path, assetPath))}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; content?: string; message?: string }) => {
        if (!alive) return
        if (!json.ok) {
          const missing = (json.message ?? '').includes('不存在')
          setState({ status: missing ? 'missing' : 'error', asset: null, message: json.message ?? '加载失败' })
          return
        }
        try {
          setState({ status: 'ready', asset: deserializeIR(String(json.content ?? '')), message: '' })
        } catch (err) {
          setState({ status: 'error', asset: null, message: `解析失败：${err instanceof Error ? err.message : String(err)}` })
        }
      })
      .catch((err: unknown) => {
        if (alive) setState({ status: 'error', asset: null, message: `网络错误：${String(err)}` })
      })
    return () => {
      alive = false
    }
  }, [project?.path, assetPath, reloadKey])

  /* 脏标记：命令栈新蓝图命令 / undo / redo */
  useEffect(() => {
    let lastLen = useEditorStore.getState().undoStack.length
    const unsubStore = useEditorStore.subscribe((s) => {
      if (s.undoStack.length > lastLen) {
        const top = peekUndo()
        if (top?.domain === 'blueprint') markDirty(tabId)
      }
      lastLen = s.undoStack.length
    })
    const unsubReplay = subscribeReplay((notice) => {
      if (notice.domains.includes('blueprint')) markDirty(tabId)
    })
    return () => {
      unsubStore()
      unsubReplay()
    }
  }, [tabId, markDirty])

  /* 保存：serializeIR → PUT → 清脏 */
  const save = useCallback(
    (asset: IRAsset) => {
      if (!project) return
      fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath(project.path, assetPath), content: serializeIR(asset) }),
      })
        .then((r) => r.json())
        .then((json: { ok: boolean; message?: string }) => {
          if (json.ok) clearDirty(tabId)
          else console.error('[蓝图保存失败]', json.message)
        })
        .catch((err: unknown) => console.error('[蓝图保存失败]', err))
    },
    [project?.path, assetPath, tabId, clearDirty],
  )

  /* 新建空蓝图（empty 项目里 tab 指向的资产还不存在时） */
  const createEmpty = useCallback(() => {
    if (!project) return
    fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: fullPath(project.path, assetPath),
        content: serializeIR(emptyBlueprint(assetPath.replace(/.*\//, '').replace(/\.bp\.json$/, ''))),
      }),
    })
      .then(() => setReloadKey((k) => k + 1))
      .catch((err: unknown) => console.error('[创建蓝图失败]', err))
  }, [project?.path, assetPath])

  if (state.status === 'loading') {
    return <div className="workspace-tab-loading">加载中…</div>
  }
  if (state.status === 'missing') {
    return (
      <div className="workspace-tab-loading">
        <div>资产不存在：{assetPath}</div>
        <button type="button" className="workspace-tab-create" onClick={createEmpty}>
          创建空蓝图
        </button>
      </div>
    )
  }
  if (state.status === 'error' || !state.asset) {
    return <div className="workspace-tab-loading workspace-tab-error">{state.message || '加载失败'}</div>
  }
  return (
    <BlueprintEditorPanel
      asset={state.asset}
      assetPath={assetPath}
      onSave={save}
      className="workspace-bp-panel"
    />
  )
}
