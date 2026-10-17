/**
 * 控制台面板出口（T1.6 兑现：运行窗口日志接入编辑器控制台）
 *
 * PM 接线（defaultPanels.tsx 中把控制台占位注册替换为本注册，id 保持 'console' 不变，
 * 用户已有布局无缝继承）：
 * ```ts
 * import { registerConsolePanel } from '@/panels/console'
 * registerConsolePanel()
 * ```
 *
 * 数据来源：BroadcastChannel 'bps-console'（运行窗口 RuntimeApp.appendConsole 每行推送，
 * 契约见 ./ConsolePanel.tsx 的 ConsoleMessage）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { ConsolePanel } from './ConsolePanel'
import './styles.css'

/** 面板 id（跨卡契约：与 defaultPanels.tsx 的 PANEL_ID_CONSOLE 一致，替换占位时不变） */
export const CONSOLE_PANEL_ID = 'console'

/** 注册控制台面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerConsolePanel(): PanelApi {
  return registerPanel({
    id: CONSOLE_PANEL_ID,
    title: '控制台',
    component: ConsolePanel,
    defaultArea: 'bottom',
  })
}

export { ConsolePanel } from './ConsolePanel'
export { CONSOLE_CHANNEL, CONSOLE_MAX_LINES, reduceConsoleMessage, parseConsoleEvent } from './ConsolePanel'
export type { ConsoleMessage, ConsoleRow } from './ConsolePanel'
