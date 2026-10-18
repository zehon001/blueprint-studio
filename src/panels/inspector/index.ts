/**
 * 检视器面板出口（T1.5 · PLAN §7.3）
 *
 * PM 接线（defaultPanels.tsx 中把检视器占位那行替换为）：
 * ```ts
 * import { registerInspectorPanel } from '@/panels/inspector'
 * registerInspectorPanel() // id 保持 'inspector' 不变，用户已有布局无缝继承
 * ```
 *
 * 本文件负责：inspector.css 挂载 + 面板注册（id 'inspector'，默认吸附右列，
 * 与 defaultPanels.tsx 的 PANEL_ID_INSPECTOR / 默认布局一致）。
 * 不要在本目录之外重复注册（重复 id 会被 dock registry 覆盖并告警）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { InspectorHost } from './InspectorHost'
import '@/blueprint/details/details.css'
import './inspector.css'

/** 面板 id（跨卡契约：与 defaultPanels.tsx 的 PANEL_ID_INSPECTOR 一致，替换实现时不变） */
export const INSPECTOR_PANEL_ID = 'inspector'

/** 注册检视器面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerInspectorPanel(): PanelApi {
  return registerPanel({
    id: INSPECTOR_PANEL_ID,
    title: '检视器',
    component: InspectorHost,
    defaultArea: 'right',
  })
}

export { InspectorPanel } from './InspectorPanel'
export { PropEditor } from './PropEditors'
export type { PropEditorProps } from './PropEditors'
export * from './inspector-model'
