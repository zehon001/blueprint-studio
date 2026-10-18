/**
 * 内置运行视图出口（v3 T8.5）
 *
 * 组件文件不 import CSS（node:test 可加载 store / URL 纯函数）；样式在入口引入。
 * defaultPanels 以 `runtime` id 注册（与默认布局中央组一致）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { RuntimePanel } from './RuntimePanel'
import { RUNTIME_PANEL_ID } from './store'
import './runtime-panel.css'

/** 注册内置运行面板（id 与默认布局中央组一致；重复调用覆盖） */
export function registerRuntimePanel(): PanelApi {
  return registerPanel({
    id: RUNTIME_PANEL_ID,
    title: '运行',
    component: RuntimePanel,
    defaultArea: 'center',
  })
}

export { RuntimePanel, buildEmbedRuntimeUrl, buildExternalRuntimeUrl } from './RuntimePanel'
export {
  useRuntimeStore,
  RUNTIME_PANEL_ID,
  type RuntimeMode,
  type RuntimeTarget,
} from './store'
