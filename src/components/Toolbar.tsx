import { useReactFlow } from '@xyflow/react'
import { computeLayout } from '../layout'
import { useAppStore } from '../appStore'
import { useGraphStore } from '../store'

export function Toolbar() {
  const isRunning = useAppStore((s) => s.runtime.running)
  const pluginName = useAppStore((s) => s.runtime.pluginName)
  const startRuntime = useAppStore((s) => s.startRuntime)
  const stopRuntime = useAppStore((s) => s.stopRuntime)
  const goHome = useAppStore((s) => s.goHome)
  const wsStatus = useAppStore((s) => s.wsStatus)
  const bound = useGraphStore((s) => s.working?.meta)
  const editorMode = useGraphStore((s) => s.editorMode)
  const setEditorMode = useGraphStore((s) => s.setEditorMode)
  const scriptOpen = useGraphStore((s) => s.scriptOpen)
  const toggleScript = useGraphStore((s) => s.toggleScript)
  const applyLayout = useGraphStore((s) => s.applyLayout)
  const { fitView } = useReactFlow()

  const autoLayout = () => {
    const { nodes, edges } = useGraphStore.getState()
    const positions = computeLayout(nodes, edges)
    applyLayout(positions)
    window.setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 50)
  }

  return (
    <header className="toolbar">
      <button className="btn" onClick={goHome}>
        ← 项目
      </button>
      <span className="brand">
        <span className="brand-bolt">⚡</span> {bound?.name ?? 'Blueprint Studio'}
      </span>
      <div className="toolbar-group">
        {isRunning ? (
          <button className="btn run" onClick={stopRuntime}>
            ⏹ 停止{pluginName ? `（${pluginName}）` : ''}
          </button>
        ) : (
          <button className="btn run" onClick={startRuntime}>
            ▶ 运行
          </button>
        )}
      </div>
      <div className="toolbar-group">
        <button
          className={`btn${editorMode === 'graph' ? ' active' : ''}`}
          onClick={() => setEditorMode('graph')}
        >
          蓝图
        </button>
        <button
          className={`btn${editorMode === 'ui' ? ' active' : ''}`}
          onClick={() => setEditorMode('ui')}
        >
          UI 编辑
        </button>
        <button
          className="btn"
          disabled={editorMode !== 'graph'}
          onClick={autoLayout}
        >
          ⇄ 自动布局
        </button>
        <button
          className={`btn${scriptOpen ? ' active' : ''}`}
          disabled={editorMode !== 'graph'}
          onClick={() => toggleScript(!scriptOpen)}
        >
          {'{ } 脚本'}
        </button>
      </div>
      <span className={`badge ${wsStatus === 'online' ? 'running' : 'stopped'}`}>
        {wsStatus === 'online' ? '后端在线' : '后端离线'}
      </span>
    </header>
  )
}
