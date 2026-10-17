/**
 * 设置面板出口（T7.1 · PLAN §15 快捷键设置）
 *
 * PM 接线（defaultPanels.tsx 中一行注册，id 'settings' 新增，不影响既有布局）：
 * ```ts
 * import { registerSettingsPanel } from '@/panels/settings'
 * registerSettingsPanel()
 * ```
 *
 * 附带注册 settings.open 快捷键（Ctrl+,，VS Code 同款习惯）：走
 * registerDefaultShortcut 记入回放表——设置面板「恢复默认」（resetShortcuts
 * 重建注册表）后该默认键位不丢；面板句柄在注册时捕获，handler 直接调 api.open()。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { registerDefaultShortcut } from '@/shell/keymap/registry'
import { SettingsPanel } from './SettingsPanel'
import './styles.css'

/** 面板 id（dock 布局主键；「面板 ▾」菜单经 registry 自动列出，无需额外接线） */
export const SETTINGS_PANEL_ID = 'settings'

/** 注册设置面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerSettingsPanel(): PanelApi {
  const api = registerPanel({
    id: SETTINGS_PANEL_ID,
    title: '设置',
    component: SettingsPanel,
    defaultArea: 'right',
  })
  // 打开设置的全局快捷键（Ctrl+,）：handler 捕获面板句柄，直接打开 / 激活
  registerDefaultShortcut({
    id: 'settings.open',
    label: '打开设置',
    keys: 'Ctrl+,',
    handler: () => api.open(),
  })
  return api
}

export { SettingsPanel } from './SettingsPanel'
