/**
 * 事件面板出口（T5.2 · PLAN §11）
 *
 * PM 接线（defaultPanels.tsx 中把事件面板占位那行替换为）：
 * ```ts
 * import { registerEventsPanel } from '@/panels/events'
 * registerEventsPanel() // id 保持 'events' 不变（PANEL_ID_EVENTS），用户已有布局无缝继承
 * ```
 *
 * 本文件负责：styles.css + 通用右键菜单 menu.css 挂载 + 面板注册（id 'events'，
 * 默认吸附右列，与 defaultPanels.tsx 的 PANEL_ID_EVENTS / 默认布局一致）。
 * 不要在本目录之外重复注册（重复 id 会被 dock registry 覆盖并告警）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { EventsPanel } from './EventsPanel'
import '@/panels/file-system/menu.css'
import './styles.css'

/** 面板 id（跨卡契约：与 defaultPanels.tsx 的 PANEL_ID_EVENTS 一致，替换占位时不变） */
export const EVENTS_PANEL_ID = 'events'

/** 注册事件面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerEventsPanel(): PanelApi {
  return registerPanel({
    id: EVENTS_PANEL_ID,
    title: '事件面板',
    component: EventsPanel,
    defaultArea: 'right',
  })
}

export { EventsPanel } from './EventsPanel'
export * from './events-model'
export * from './blueprint-bridge'
