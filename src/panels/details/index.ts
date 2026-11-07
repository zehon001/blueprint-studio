/**
 * 检视面板出口（纯蓝图工作流）
 *
 * 注册 dock 面板（id 'details'，默认吸附右列）；蓝图节点 / 图参数由
 * src/blueprint/details/Details 渲染（选中即出现，无需保存）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { DetailsHost } from './DetailsHost'
import '@/blueprint/details/details.css'
import './details-panel.css'

export const DETAILS_PANEL_ID = 'details'

export function registerDetailsPanel(): PanelApi {
  return registerPanel({
    id: DETAILS_PANEL_ID,
    title: '检视',
    component: DetailsHost,
    defaultArea: 'right',
  })
}
