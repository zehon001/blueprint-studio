/**
 * 插件管理面板出口（v2 T6.2 · v3 T8.3 迁入设置模态）
 *
 * v3 起不再注册 dock 面板：组件由 `src/shell/settings/SettingsModal.tsx` 的「插件」分区复用。
 * 本文件只负责引入样式并导出组件/API/纯函数（保持既有测试与引用路径不变）。
 */
import { PluginManagerPanel } from './PluginManagerPanel'
import './styles.css'

export { PluginManagerPanel }
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
