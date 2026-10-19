/**
 * 底部状态栏（UI-REDESIGN P5）
 *
 * 左：后端连接状态点 + 文案 + 项目名；中：当前活动资产路径（等宽）；
 * 右：节点 / 连线计数 + 缩放百分比（订阅现有 store，只读）。
 * 高 24px，固定在应用底部；dock 区 flex:1 min-height:0 不受影响。
 */
import { useEffect, useState } from 'react'
import { Package } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { parseAssetPanelId } from '@/shell/dock/assetPanelModel'
import { useDockStore } from '@/shell/dock/store'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { collectUINodeIds, useSceneTreeDomain } from '@/ui-editor/store'
import { useStatusStore } from './status-store'

type BackendState = 'checking' | 'online' | 'offline'

/** 健康检查间隔 */
const HEALTH_INTERVAL_MS = 15000

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.currentProject)
  const activePanelId = useDockStore((s) => s.activePanelId)
  const blueprintAsset = useBlueprintStore((s) => s.asset)
  const graphName = useBlueprintStore((s) => s.graphName)
  const uiDomain = useSceneTreeDomain()
  const zoom = useStatusStore((s) => s.zoom)
  const [backend, setBackend] = useState<BackendState>('checking')

  useEffect(() => {
    let alive = true
    const check = async (): Promise<void> => {
      try {
        const res = await fetch('/api/health')
        if (!alive) return
        setBackend(res.ok ? 'online' : 'offline')
      } catch {
        if (alive) setBackend('offline')
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), HEALTH_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const ref = activePanelId ? parseAssetPanelId(activePanelId) : null
  const isBlueprint = ref?.kind === 'blueprint'
  const graph = isBlueprint && blueprintAsset ? blueprintAsset.graphs[graphName] : null
  const nodeCount = graph
    ? graph.nodes.length
    : uiDomain.asset
      ? collectUINodeIds(uiDomain.asset.root).length
      : 0
  const edgeCount = graph?.edges.length ?? 0
  const assetPath = ref?.path ?? '未打开资产'

  const backendLabel = backend === 'online' ? '已连接' : backend === 'offline' ? '离线' : '连接中'
  const backendTitle =
    backend === 'online'
      ? '本地服务已连接（http://localhost:8790）'
      : backend === 'offline'
        ? '本地服务不可达：请运行 npm run server'
        : '正在检测本地服务…'

  return (
    <div className="statusbar" role="status" aria-label="状态栏">
      <div className="statusbar-left">
        <span className={`statusbar-dot statusbar-dot--${backend}`} title={backendTitle} aria-hidden />
        <span className="statusbar-backend" title={backendTitle}>
          {backendLabel}
        </span>
        <span className="statusbar-divider" aria-hidden />
        <Icon icon={Package} size={11} />
        <span className="statusbar-project" title={project?.path ?? undefined}>
          {project?.name ?? '未打开项目'}
        </span>
      </div>
      <div className="statusbar-center" title={assetPath}>
        {assetPath}
      </div>
      <div className="statusbar-right">
        <span className="statusbar-stat" title="当前图 / 资产的节点与连线数">
          {nodeCount} 节点
          {isBlueprint ? ` · ${edgeCount} 连线` : ''}
        </span>
        <span className="statusbar-stat statusbar-zoom" title="画布缩放">
          {zoom === null ? '—' : `${Math.round(zoom * 100)}%`}
        </span>
      </div>
    </div>
  )
}
