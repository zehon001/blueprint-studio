/**
 * 检视面板宿主（纯蓝图工作流）
 *
 * 按激活面板分发：
 *  - 蓝图 / 函数资产（或蓝图 store 已有资产）→ 蓝图 Details（节点 / 图参数检视）；
 *  - 脚本等其它资产 → 资产基本信息；
 *  - 资源库 / 文件系统选择 → 条目 / 文件基本信息。
 */
import type { ReactNode } from 'react'
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

  if (context?.source === 'blueprint' || ref?.kind === 'blueprint' || ref?.kind === 'function') {
    return (
      <div className="insp-panel insp-blueprint-host">
        <Details />
      </div>
    )
  }
  if (activePanelId === 'library') {
    const lib = selectionOfPanel(selection, activePanelId)
    if (lib?.source === 'library') {
      return (
        <InfoShell title={lib.name} badge="函数">
          <InfoRow label="名称" value={lib.name} />
          <InfoRow label="来源" value={lib.scope === 'builtin' ? '内置库' : '项目库'} />
          {lib.path ? <InfoRow label="路径" value={lib.path} mono /> : null}
          <div className="insp-info-hint">在资源库面板中双击条目可打开编辑器。</div>
        </InfoShell>
      )
    }
    return (
      <InfoShell title="资源库">
        <div className="insp-info-hint">在资源库面板中选择条目以查看信息。</div>
      </InfoShell>
    )
  }
  if (activePanelId === 'file-system') {
    const file = selectionOfPanel(selection, activePanelId)
    if (file?.source === 'file') {
      return (
        <InfoShell title={file.name} badge={file.ext ? file.ext.toUpperCase() : '文件'}>
          <InfoRow label="名称" value={file.name} />
          <InfoRow label="类型" value={file.kind === 'dir' ? '文件夹' : '文件'} />
          <InfoRow label="路径" value={file.path} mono />
          {file.kind === 'file' && file.ext ? <InfoRow label="扩展名" value={`.${file.ext}`} /> : null}
        </InfoShell>
      )
    }
    return (
      <InfoShell title="文件系统">
        <div className="insp-info-hint">在文件系统面板中选择文件或文件夹以查看基本信息。</div>
      </InfoShell>
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
