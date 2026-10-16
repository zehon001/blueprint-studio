import { useState } from 'react'
import { useAppStore } from '../appStore'
import type { AnyWidgetState } from './reducers'
import { LogTreeWidget } from './LogTree'
import { FlowWidget, MarkdownWidget } from './Widgets'
import { ConsolePanel } from '../components/ConsolePanel'
import type { WidgetKind } from '../types'

function WidgetView({
  title,
  kind,
  state,
}: {
  title: string
  kind: WidgetKind
  state: AnyWidgetState
}) {
  if (kind === 'logTree') return <LogTreeWidget title={title} state={state as never} />
  if (kind === 'markdown') return <MarkdownWidget title={title} state={state as never} />
  return <FlowWidget title={title} state={state as never} />
}

export function RuntimeView() {
  const running = useAppStore((s) => s.runtime.running)
  const pluginName = useAppStore((s) => s.runtime.pluginName)
  const widgets = useAppStore((s) => s.runtime.widgets)
  const stopRuntime = useAppStore((s) => s.closeRuntime)
  const rerunRuntime = useAppStore((s) => s.rerunRuntime)
  const [consoleOpen, setConsoleOpen] = useState(true)

  if (!running && Object.keys(widgets).length === 0) return null

  const entries = Object.entries(widgets)
  const logTrees = entries.filter(([, w]) => w.kind === 'logTree')
  const others = entries.filter(([, w]) => w.kind !== 'logTree')

  return (
    <div className="runtime-overlay">
      <header className="runtime-header">
        <span className="runtime-title">▶ {pluginName}{running ? '（运行中）' : '（已停止）'}</span>
        <div className="toolbar-group">
          <button className="btn" onClick={() => setConsoleOpen(!consoleOpen)}>
            {consoleOpen ? '隐藏控制台' : '显示控制台'}
          </button>
          <button className="btn" onClick={rerunRuntime}>
            ↻ 重新运行
          </button>
          <button className="btn run" onClick={stopRuntime}>
            ⏹ 停止并返回
          </button>
        </div>
      </header>
      <div className="runtime-body">
        <div className="runtime-main">
          {logTrees.length === 0 && others.length === 0 && (
            <div className="lt-empty" style={{ margin: 'auto' }}>
              该插件没有输出类节点，运行结果请看控制台
            </div>
          )}
          {logTrees.map(([id, w]) => (
            <WidgetView key={id} title={w.title} kind={w.kind} state={w.state} />
          ))}
        </div>
        {others.length > 0 && (
          <div className="runtime-side">
            {others.map(([id, w]) => (
              <WidgetView key={id} title={w.title} kind={w.kind} state={w.state} />
            ))}
          </div>
        )}
      </div>
      {consoleOpen && <ConsolePanel compact />}
    </div>
  )
}
