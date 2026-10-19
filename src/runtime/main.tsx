/**
 * 运行窗口入口（T1.6 · runtime.html · PLAN §12）
 *
 * URL：runtime.html?project=<项目文件夹名>&ui=<资产路径>&mode=main|current
 *   - mode=main（编辑器 F5）：ui 缺省时读 project.json.mainUI；
 *   - mode=current（编辑器 F6）：编辑器把当前 UI tab 路径拼进 ui。
 *
 * 启动顺序：主题 token（theme.css，runtime.css 全部引用其变量）→ RuntimeApp
 * （解析参数 → fetch /api/file → parseUIAsset → renderUI 运行态渲染，错误态全屏中文提示）。
 */
import '@/shell/theme/theme.css'
import '@/shell/theme/base.css'
import '@/shell/ui/ui.css'
import '@fontsource-variable/inter'
import './runtime.css'
import { createRoot } from 'react-dom/client'
import RuntimeApp from './RuntimeApp'

createRoot(document.getElementById('root')!).render(<RuntimeApp />)
