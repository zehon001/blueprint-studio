/**
 * 插件管理面板出口（T6.2 · PLAN §14.2 / ADR-004）
 *
 * PM 接线（一行，不改 defaultPanels.tsx 结构）：
 * ```ts
 * import { registerPluginManagerPanel } from '@/panels/plugin-manager'
 * registerPluginManagerPanel() // id 'plugin-manager'，与占位面板 id 一致，布局无缝继承
 * ```
 *
 * 中央工作区标签页接线（可选，workspace tab kind 'plugin-manager'，虚拟 tab assetPath=''）：
 * ```ts
 * useWorkspaceStore.getState().openAsset({ kind: 'plugin-manager', assetPath: '', title: '插件管理' })
 * ```
 * 面板头部「在编辑器中打开」按钮即走该入口。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { PluginManagerPanel } from './PluginManagerPanel'
// 样式统一在应用入口引入（组件文件不 import .css，保证 node:test 可直接加载）：
// 本面板样式全部引用 theme.css token。
import './styles.css'

/** 面板 id（dock 布局主键；与占位面板 'plugin-manager' 一致） */
export const PLUGIN_MANAGER_PANEL_ID = 'plugin-manager'

/** 注册插件管理面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerPluginManagerPanel(): PanelApi {
  return registerPanel({
    id: PLUGIN_MANAGER_PANEL_ID,
    title: '插件管理',
    component: PluginManagerPanel,
    defaultArea: 'right',
  })
}

export { PluginManagerPanel } from './PluginManagerPanel'
export { createPluginApi, defaultPluginApi, PluginApiError, errorMessage } from './api'
export type { PluginApi, PluginsListResult, DetectResult } from './api'
export {
  BADGE_LABEL,
  compareVersions,
  deriveStatus,
  installCommandText,
  resolveUpdatable,
  runPool,
  strategyLabel,
} from './model'
export type { PluginBadgeState, DetectEntry, DerivedStatus } from './model'
export { consumeSseBody, createSseParser, parseInstallEvent } from './sse'
export type { InstallOutcome, InstallStreamEvent, SseParser } from './sse'
