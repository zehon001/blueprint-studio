/**
 * 资产面板（v3 T8.1 · PLAN §4.1）—— UI 实现
 *
 * 每个打开的资产 = 一个 dock 面板，面板 id = `asset:<kind>:<路径>`。
 * - 注册是动态的：首次打开资产时按 id 注册一个泛型宿主（组件按 id 解析 kind/path）；
 * - 布局持久化只存 id；启动时 bootstrapDock 扫描布局并调用 ensureAssetPanelFromId；
 * - 拆出窗口（`?panel=asset:…`）启动时同样按 id 注册，PopoutApp 即可渲染；
 * - 纯逻辑（id/显示名/布局扫描/workspace 同步/关闭确认）在 assetPanelModel.ts，
 *   本文件只负责 React 组件与注册，避免 node:test 被动加载各编辑器（含 @xyflow CSS）。
 */
import type { ComponentType } from 'react'
import { getPanel, registerPanel } from './registry'
import { useDockStore } from './store'
import { useWorkspaceStore, type OpenTabKind } from '@/shell/workspace-store'
import { UITab } from '@/shell/workspace/UITab'
import { BlueprintTab } from '@/shell/workspace/BlueprintTab'
import { ScriptTab } from '@/script/editor'
import {
  assetBadge,
  assetPanelId,
  assetPanelTitle,
  collectPanelIdsRaw,
  parseAssetPanelId,
  registeredIds,
  setAssetPanelOpener,
  syncWorkspaceFromDock,
  type AssetPanelKind,
} from './assetPanelModel'

export * from './assetPanelModel'

/** 资产面板宿主：按 id 解析并渲染对应编辑器 */
function AssetPanelHost({ panelId }: { panelId: string }) {
  const ref = parseAssetPanelId(panelId)
  if (!ref) return <div className="dock-panel-placeholder">未知资产面板：{panelId}</div>
  switch (ref.kind) {
    case 'ui':
      return <UITab assetPath={ref.path} />
    case 'blueprint':
      return <BlueprintTab assetPath={ref.path} />
    case 'script':
      return <ScriptTab assetPath={ref.path} />
    default:
      return (
        <div className="dock-panel-placeholder">
          {assetBadge(ref.kind, ref.path)} 编辑器将在 M11/M12 开放：{ref.path}
        </div>
      )
  }
}

/**
 * 确保资产面板已注册；返回面板 id。
 * 已注册时直接复用（重复打开只聚焦，不替换组件身份）。
 */
export function ensureAssetPanel(kind: AssetPanelKind, path: string): string {
  const id = assetPanelId(kind, path)
  if (registeredIds.has(id) || getPanel(id)) {
    registeredIds.add(id)
    return id
  }
  const title = assetPanelTitle(kind, path)
  const Component: ComponentType = () => <AssetPanelHost panelId={id} />
  registerPanel({ id, title, component: Component, defaultArea: 'center' })
  registeredIds.add(id)
  return id
}

/** 按 id 确保注册（布局还原 / 拆出窗口用；非法 id 返回 null） */
export function ensureAssetPanelFromId(panelId: string): string | null {
  const ref = parseAssetPanelId(panelId)
  if (!ref) return null
  return ensureAssetPanel(ref.kind, ref.path)
}

/**
 * 注册布局中的全部资产面板（返回需要并入 knownIds 的 id 集合）。
 * 供 bootstrapDock 在 normalize 前调用。
 */
export function ensureAssetPanelsInLayout(raw: unknown): Set<string> {
  const ids = new Set<string>()
  for (const id of collectPanelIdsRaw(raw)) {
    if (!id.startsWith('asset:')) continue
    if (ensureAssetPanelFromId(id)) ids.add(id)
  }
  return ids
}

/** 实际打开实现（注入 assetPanelModel.openAssetPanel） */
function openAssetPanelImpl(kind: AssetPanelKind, path: string): string {
  const id = ensureAssetPanel(kind, path)
  useWorkspaceStore.getState().openAsset({
    kind: kind as OpenTabKind,
    assetPath: path,
    title: assetPanelTitle(kind, path),
  })
  useDockStore.getState().openPanel(id, 'center')
  syncWorkspaceFromDock()
  return id
}

// 注入纯逻辑入口（openAssetPanel 的 UI 实现）
setAssetPanelOpener(openAssetPanelImpl)
