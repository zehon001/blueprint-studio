import { useAppStore } from '../appStore'
import { UIRenderer, type UIRenderCtx } from './UIRenderer'
import { ConsolePanel } from './ConsolePanel'

export function RuntimePanel() {
  const running = useAppStore((s) => s.runtime.running)
  const pluginName = useAppStore((s) => s.runtime.pluginName)
  const ui = useAppStore((s) => s.runtime.ui)
  const uiState = useAppStore((s) => s.runtime.uiState)
  const rerunRuntime = useAppStore((s) => s.rerunRuntime)
  const closeRuntime = useAppStore((s) => s.closeRuntime)
  const onUIInput = useAppStore((s) => s.onUIInput)
  const onUIClick = useAppStore((s) => s.onUIClick)

  const ctx: UIRenderCtx = {
    mode: 'run',
    selectedId: null,
    onSelect: () => {},
    uiState,
    onInput: onUIInput,
    onClick: onUIClick,
  }

  return (
    <div className="runtime-panel">
      <div className="runtime-panel-head">
        <span className="runtime-title">
          {running ? '▶' : '⏹'} {pluginName}
        </span>
        <div className="toolbar-group">
          <button className="btn small" onClick={rerunRuntime}>
            ↻ 重新运行
          </button>
          <button className="btn small run" onClick={closeRuntime}>
            关闭
          </button>
        </div>
      </div>
      <div className="runtime-ui">
        {ui ? <UIRenderer root={ui} ctx={ctx} /> : <div className="uil-empty">（无 UI）</div>}
      </div>
      <ConsolePanel compact />
    </div>
  )
}
