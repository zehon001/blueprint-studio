/**
 * 设置模态出口（v3 T8.3）
 *
 * 样式在入口引入（组件文件不 import CSS，保证 node:test 可直接加载 store / 纯函数）。
 */
import './settings.css'

export { SettingsModalHost, openSettings, useSettingsModal } from './SettingsModal'
export type { SettingsSection } from './SettingsModal'
export {
  useSettingsStore,
  loadSettings,
  saveSettings,
  parseSettings,
  validateLibraryRoot,
  loadLastSection,
  saveLastSection,
  isSettingsSection,
  SETTINGS_SECTIONS,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type EditorSettings,
} from './store'
