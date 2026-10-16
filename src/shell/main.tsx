/**
 * 主编辑器入口（T0.3 · editor.html）
 *
 * 启动顺序：
 *   1. 主题 token（theme.css，全部 dock 样式经 token 引用）；
 *   2. 快捷键：内置默认表（T0.5）+ F5/F6 运行占位（T1.6 接入 handler）；
 *   3. 面板注册 + 布局装配（defaultPanels 模块副作用注册 → 持久化还原 / 默认布局兜底）；
 *   4. 全局键盘适配（attachKeyboard：命中快捷键 preventDefault，F5 不触发浏览器刷新）；
 *   5. 渲染 DockShell（顶栏 + dock 布局树）。
 */
import '@/shell/theme/theme.css'
import { createRoot } from 'react-dom/client'
import { attachKeyboard, registerDefaultShortcuts, registerShortcut } from '@/shell/keymap/registry'
import { bootstrapDock } from '@/shell/dock/defaultPanels'
import DockShell from '@/shell/dock/DockShell'

registerDefaultShortcuts()
// 运行快捷键占位：handler 由 T1.6 运行窗口接入
registerShortcut({
  id: 'run.main',
  label: '运行（主 UI）',
  keys: 'F5',
  handler: () => console.info('[run] F5 运行主 UI —— T1.6 接入'),
})
registerShortcut({
  id: 'run.current',
  label: '运行当前',
  keys: 'F6',
  handler: () => console.info('[run] F6 运行当前 UI —— T1.6 接入'),
})

// 面板注册（defaultPanels 模块副作用）+ 布局装配（持久化还原 → 默认布局兜底）
bootstrapDock()

attachKeyboard(window)

createRoot(document.getElementById('root')!).render(<DockShell />)
