/**
 * 运行窗口入口（纯蓝图工作流 · runtime.html）
 *
 * URL：runtime.html?project=<项目文件夹名>&bp=<蓝图路径>&run=<nonce>&embed=1
 */
import { createRoot } from 'react-dom/client'
import { BlueprintApp } from './BlueprintApp'
import './runtime.css'

createRoot(document.getElementById('root')!).render(<BlueprintApp />)
