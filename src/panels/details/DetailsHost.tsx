/**
 * 检视面板宿主（纯蓝图工作流）
 *
 * 按激活面板分发：
 *  - 蓝图 / 函数资产（或蓝图 store 已有资产）→ 蓝图 Details（节点 / 图参数检视）；
 *  - 脚本等其它资产 → 资产基本信息；
 *  - 左侧文件系统选择 → 文件基本信息
 *    （按最后选择发布：在侧栏选中条目即显示，点回蓝图画布则切回蓝图检视）。
 */
import { useEffect, type ReactNode } from 'react'
import { Details } from '@/blueprint/details/Details'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import { useDockStore } from '@/shell/dock/store'
import { assetBadge, assetPanelTitle, parseAssetPanelId } from '@/shell/dock/assetPanelModel'
import { selectionOfPanel, useSelectionStore } from '@/shell/selection/store'
import { useWorkspaceStore } from '@/shell/workspace-store'

function InfoRow({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="insp-info-row">
      <span className="insp-info-label">{label}</span>
      <span className={`insp-info-value${mono ? ' mono' : ''}`} title={typeof value === 'string' ? value : undefined}>
        {value}
      </span>
    </div>
  )
}

function InfoShell({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <div className="insp-panel">
      <div className="insp-header">
        <span className="insp-title" title={title}>
          {title}
        </span>
        {badge ? <span className="insp-badge">{badge}</span> : null}
      </div>
      <div className="insp-body insp-info-body">{children}</div>
    </div>
  )
}

function AssetInfo({ panelId }: { panelId: string }) {
  const ref = parseAssetPanelId(panelId)
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.kind === ref?.kind && t.assetPath === ref?.path))
  const project = useWorkspaceStore((s) => s.currentProject)
  if (!ref) return null
  return (
    <InfoShell title={assetPanelTitle(ref.kind, ref.path)} badge={assetBadge(ref.kind, ref.path)}>
      <InfoRow label="名称" value={assetPanelTitle(ref.kind, ref.path)} />
      <InfoRow label="类型" value={assetBadge(ref.kind, ref.path)} />
      <InfoRow label="路径" value={ref.path} mono />
      <InfoRow label="项目" value={project?.name ?? '—'} />
      <InfoRow label="修改状态" value={tab?.dirty ? '未保存' : '已保存'} />
    </InfoShell>
  )
}

export function DetailsHost() {
  const activePanelId = useDockStore((s) => s.activePanelId)
  const selection = useSelectionStore((s) => s.selection)
  const hasBlueprintAsset = useBlueprintStore((s) => s.asset !== null)
  const ref = activePanelId ? parseAssetPanelId(activePanelId) : null
  const context = activePanelId ? selectionOfPanel(selection, activePanelId) : null

  // 激活资产面板切换（打开 / 切页签）时，侧栏选择让位给资产检视（最近激活的资产优先）
  useEffect(() => {
    if (!activePanelId) return
    const sel = useSelectionStore.getState().selection
    if (sel && (sel.source === 'file' || sel.source === 'library')) {
      useSelectionStore.getState().clear(sel.source)
    }
  }, [activePanelId])

  // 蓝图画布选中（最后发布者优先）→ 蓝图检视
  if (context?.source === 'blueprint') {
    return (
      <div className="insp-panel insp-blueprint-host">
        <Details />
      </div>
    )
  }
  // 左侧文件系统选中 → 文件基本信息
  if (selection?.source === 'file') {
    const file = selection
    return (
      <InfoShell title={file.name} badge={file.ext ? file.ext.toUpperCase() : '文件'}>
        <InfoRow label="名称" value={file.name} />
        <InfoRow label="类型" value={file.kind === 'dir' ? '文件夹' : '文件'} />
        <InfoRow label="路径" value={file.path} mono />
        {file.kind === 'file' && file.ext ? <InfoRow label="扩展名" value={`.${file.ext}`} /> : null}
      </InfoShell>
    )
  }
  // 资产面板：蓝图 / 函数 → 蓝图检视；脚本等 → 基本信息
  if (ref?.kind === 'blueprint' || ref?.kind === 'function') {
    return (
      <div className="insp-panel insp-blueprint-host">
        <Details />
      </div>
    )
  }
  if (ref) return <AssetInfo panelId={activePanelId ?? ''} />
  if (hasBlueprintAsset) {
    return (
      <div className="insp-panel insp-blueprint-host">
        <Details />
      </div>
    )
  }
  const project = useWorkspaceStore.getState().currentProject
  return (
    <InfoShell title="检视">
      <div className="insp-info-hint">打开蓝图资产并点击节点以检视参数。</div>
      <InfoRow label="项目" value={project?.name ?? '未打开项目'} />
    </InfoShell>
  )
}
