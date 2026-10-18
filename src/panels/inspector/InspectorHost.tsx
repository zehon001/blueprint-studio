/**
 * 统一检视器宿主（v3 T8.2 · PLAN §4.2）
 *
 * 按 dock 当前激活面板分发四类内容：
 *  - asset:ui        → 现有 UI 节点检视器（能力不回退）
 *  - asset:blueprint → 蓝图 Details（从蓝图编辑器右栏迁出）
 *  - file-system     → 文件基本信息
 *  - 其它资产        → 资产基本信息（脚本/元素/样式/函数；无属性资产只显示基本信息）
 *  - library         → 资源库条目占位（M11 填充）
 *
 * UI/蓝图仍由各自组件直接读编辑器 store；SelectionDescriptor 记录当前上下文，
 * 文件/库条目走 descriptor。
 */
import type { ReactNode } from 'react'
import { Details } from '@/blueprint/details/Details'
import { useDockStore } from '@/shell/dock/store'
import { parseAssetPanelId, assetBadge, assetPanelTitle } from '@/shell/dock/assetPanelModel'
import { useSelectionStore, selectionOfPanel } from '@/shell/selection/store'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { InspectorPanel } from './InspectorPanel'

/** 基本信息行 */
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

function FileInfo({ path, name, kind, ext }: { path: string; name: string; kind: 'file' | 'dir'; ext: string }) {
  return (
    <InfoShell title={name} badge={kind === 'dir' ? '目录' : ext ? ext.toUpperCase() : '文件'}>
      <InfoRow label="名称" value={name} />
      <InfoRow label="类型" value={kind === 'dir' ? '文件夹' : '文件'} />
      <InfoRow label="路径" value={path} mono />
      {kind === 'file' ? <InfoRow label="扩展名" value={ext ? `.${ext}` : '（无）'} /> : null}
    </InfoShell>
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
      <div className="insp-info-hint">该资产类型暂无属性检视项（M11/M12 随契约补齐）。</div>
    </InfoShell>
  )
}

/** 统一检视器：按 activePanelId 分发 */
export function InspectorHost() {
  const activePanelId = useDockStore((s) => s.activePanelId)
  const selection = useSelectionStore((s) => s.selection)
  const ref = activePanelId ? parseAssetPanelId(activePanelId) : null

  if (ref?.kind === 'ui') return <InspectorPanel />
  if (ref?.kind === 'blueprint') {
    return (
      <div className="insp-panel insp-blueprint-host">
        <Details />
      </div>
    )
  }
  if (activePanelId === 'file-system') {
    const file = selectionOfPanel(selection, activePanelId)
    if (file?.source === 'file') {
      return <FileInfo path={file.path} name={file.name} kind={file.kind} ext={file.ext} />
    }
    return (
      <InfoShell title="文件系统">
        <div className="insp-info-hint">在文件系统面板中选择文件或文件夹以查看基本信息。</div>
      </InfoShell>
    )
  }
  if (activePanelId === 'library') {
    const lib = selectionOfPanel(selection, activePanelId)
    return (
      <InfoShell title="资源库" badge="M11">
        <div className="insp-info-hint">
          {lib?.source === 'library' ? `条目：${lib.name}（${lib.kind}）` : '资源库条目详情将在 M11 接入。'}
        </div>
      </InfoShell>
    )
  }
  if (ref) return <AssetInfo panelId={activePanelId ?? ''} />

  const project = useWorkspaceStore.getState().currentProject
  return (
    <InfoShell title="检视器">
      <div className="insp-info-hint">未激活可检视的面板。</div>
      <InfoRow label="项目" value={project?.name ?? '未打开项目'} />
    </InfoShell>
  )
}
