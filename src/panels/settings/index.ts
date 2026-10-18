/**
 * 快捷键设置面板出口（v2 T7.1 · v3 T8.3 迁入设置模态）
 *
 * v3 起不再注册 dock 面板：组件由 `src/shell/settings/SettingsModal.tsx` 的「快捷键」分区复用。
 * 本文件只负责引入样式并导出组件（保持既有测试/引用路径不变）。
 */
import { SettingsPanel } from './SettingsPanel'
import './styles.css'

export { SettingsPanel }
