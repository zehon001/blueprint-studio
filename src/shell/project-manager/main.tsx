/**
 * Blueprint Studio v2 —— 项目管理器页入口（T0.6）
 *
 * index.html → /src/shell/project-manager/main.tsx
 * 挂载主题 token（theme.css）与页面样式后渲染项目管理器。
 */
import { createRoot } from 'react-dom/client'
import '../theme/theme.css'
import './project-manager.css'
import ProjectManager from './App'

createRoot(document.getElementById('root')!).render(<ProjectManager />)
