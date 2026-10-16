import { useMemo } from 'react'
import { marked } from 'marked'
import type { MarkdownState, FlowState } from './reducers'

export function MarkdownWidget({ title, state }: { title: string; state: MarkdownState }) {
  const html = useMemo(() => marked.parse(state.content || '（等待内容…）', { async: false }) as string, [state.content])
  return (
    <div className="widget markdown">
      <div className="widget-head">
        <span className="widget-title">{title}</span>
      </div>
      <div className="markdown-body md-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

export function FlowWidget({ title, state }: { title: string; state: FlowState }) {
  return (
    <div className="widget flow">
      <div className="widget-head">
        <span className="widget-title">{title}</span>
      </div>
      <div className="flow-body">
        {state.nodes.length === 0 && <div className="lt-empty">（空流程图）</div>}
        {state.nodes.map((n, i) => {
          const row = Math.floor(i / 3)
          const col = i % 3
          return (
            <div
              key={n.id}
              className={`flow-node${state.activeId === n.id ? ' active' : ''}`}
              style={{ top: 24 + row * 88, left: 24 + col * 176 }}
            >
              {n.label}
            </div>
          )
        })}
        {state.nodes.length > 0 && (
          <svg className="flow-svg" xmlns="http://www.w3.org/2000/svg">
            {state.edges.map((e, i) => {
              const fromIdx = state.nodes.findIndex((n) => n.id === e.from)
              const toIdx = state.nodes.findIndex((n) => n.id === e.to)
              if (fromIdx < 0 || toIdx < 0) return null
              const pos = (idx: number) => ({
                x: 24 + (idx % 3) * 176 + 72,
                y: 24 + Math.floor(idx / 3) * 88 + 18,
              })
              const a = pos(fromIdx)
              const b = pos(toIdx)
              const active = state.activeId === e.from || state.activeId === e.to
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={active ? '#5b9dd9' : '#4a4f60'}
                  strokeWidth={active ? 2.2 : 1.4}
                />
              )
            })}
          </svg>
        )}
      </div>
    </div>
  )
}
