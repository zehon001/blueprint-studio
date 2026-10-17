/**
 * 编辑器入口（T0.3 · T0.4 · editor.html）
 *
 * 两种模式（T0.4 多窗口拆合，PLAN §3.1）：
 *   - 弹窗模式（?panel=<面板id>&project=<路径>）：只渲染该面板（PopoutApp），
 *     业务状态经 BroadcastChannel 与主窗按序同步（主窗执行 → 广播 → 弹窗重放）。
 *   - 主窗模式（默认）：装配 dock 布局 + 安装多窗同步桥（主窗是业务状态真源）。
 *
 * 主窗启动顺序：
 *   1. 主题 token（theme.css，全部样式经 token 引用）；
 *   2. 面板注册（defaultPanels 模块副作用——两种模式都需要，弹窗用 registry 找面板组件）；
 *   3. 快捷键：内置默认表（T0.5 + T7.1 全表）+ F5/F6 运行（T1.6，runtime-launch 与顶栏按钮共用 handler）
 *      + 用户改键覆盖（T7.1：localStorage 加载，冲突项跳过）；
 *   4. 布局装配（defaultPanels：持久化还原 / 默认布局兜底）；
 *   5. 多窗同步桥（T0.4：主窗订阅 store 变更广播、执行弹窗转发动作）；
 *   6. 全局键盘适配 + 渲染 DockShell（顶栏 + dock 布局树）。
 */
import '@/shell/theme/theme.css'
import { createRoot } from 'react-dom/client'
import { attachKeyboard, registerDefaultShortcut, registerDefaultShortcuts } from '@/shell/keymap/registry'
import { applyKeymapOverrides } from '@/shell/keymap/customize'
import { loadKeymapOverrides } from '@/shell/keymap/persist'
import { launchRuntimeCurrent, launchRuntimeMain } from '@/shell/runtime-launch'
import { bootstrapDock } from '@/shell/dock/defaultPanels'
import DockShell from '@/shell/dock/DockShell'
import PopoutApp from '@/shell/windows/PopoutApp'
import { installMainBridge } from '@/shell/windows/bridge'
import { popoutPanelIdFromLocation } from '@/shell/windows/popout'

registerDefaultShortcuts()
// 运行快捷键（T1.6）：与顶栏按钮共用 runtime-launch 的启动函数
// （mode=main 的 ui 参数由运行窗口读 project.json.mainUI；current 由 workspace-store 拼 ui）
// T7.1：改用 registerDefaultShortcut —— 记入回放表，设置面板「恢复默认」后 F5/F6 不丢
registerDefaultShortcut({
  id: 'run.main',
  label: '运行（主 UI）',
  keys: 'F5',
  handler: () => launchRuntimeMain(),
})
registerDefaultShortcut({
  id: 'run.current',
  label: '运行当前',
  keys: 'F6',
  handler: () => launchRuntimeCurrent(),
})
// T7.1 改键持久化：应用用户自定义键位（localStorage bps.keymap.v1；冲突 / 失效条目跳过）
applyKeymapOverrides(loadKeymapOverrides())

const popoutPanelId = popoutPanelIdFromLocation()

if (popoutPanelId) {
  // 弹窗模式：只渲染该面板，状态经 BroadcastChannel 与主窗保持一致（T0.4）
  createRoot(document.getElementById('root')!).render(<PopoutApp panelId={popoutPanelId} />)
} else {
  // 主窗模式
  // 面板注册（defaultPanels 模块副作用）+ 布局装配（持久化还原 → 默认布局兜底）
  bootstrapDock()
  // 多窗口同步：主窗为业务状态真源（T0.4 · PLAN §3.1）
  installMainBridge()
  attachKeyboard(window)
  createRoot(document.getElementById('root')!).render(<DockShell />)
}
