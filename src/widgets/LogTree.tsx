import { useEffect, useRef, useState } from 'react'
import type { LogTreeState } from './reducers'

const FALLBACK_COLORS: Record<string, string> = {
  INFO: '#3fc1a9',
  WARN: '#d9a441',
  ERROR: '#e06c75',
  DEBUG: '#8a94a8',
  FATAL: '#ff5555',
}

function EntryRow({ entry }: { entry: LogTreeState['sessions'][number]['rounds'][number]['entries'][number] }) {
  const [expanded, setExpanded] = useState(false)
  const color = entry.color || FALLBACK_COLORS[entry.tag.toUpperCase()] || '#8b90a0'
  return (
    <div className="lt-entry-wrap">
      <div className="lt-entry" onClick={() => entry.count > 1 && setExpanded(!expanded)}>
        <span className="lt-time">{entry.time}</span>
        {entry.tag && (
          <span className="lt-tag" style={{ background: color }}>
            {entry.tag}
          </span>
        )}
        <span className="lt-text">{entry.text}</span>
        {entry.count > 1 && (
          <span className={`lt-count${expanded ? ' open' : ''}`} title="点击展开合并的日志">
            ×{entry.count}
          </span>
        )}
      </div>
      {expanded && entry.count > 1 && (
        <div className="lt-merged">
          {entry.lines.map((line, i) => (
            <div className="lt-merged-line" key={i}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RoundSection({ round }: { round: LogTreeState['sessions'][number]['rounds'][number] }) {
  const [collapsed, setCollapsed] = useState(false)
  const count = round.entries.length
  return (
    <div className="lt-round">
      <button className="lt-round-head" onClick={() => setCollapsed(!collapsed)}>
        <span className={`lt-caret${collapsed ? '' : ' open'}`}>▸</span>
        <span className="lt-round-label">{round.label}</span>
        <span className="lt-meta">{count} 条</span>
      </button>
      {!collapsed && (
        <div className="lt-round-body">
          {round.entries.length === 0 && <div className="lt-empty">（空轮次）</div>}
          {round.entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </div>
      )}
    </div>
  )
}

function SessionSection({ session }: { session: LogTreeState['sessions'][number] }) {
  const [collapsed, setCollapsed] = useState(false)
  const rounds = session.rounds.length
  const entries = session.rounds.reduce((acc, r) => acc + r.entries.length, 0)
  return (
    <div className="lt-session">
      <button className="lt-session-head" onClick={() => setCollapsed(!collapsed)}>
        <span className={`lt-caret${collapsed ? '' : ' open'}`}>▸</span>
        <span className="lt-session-label">{session.label}</span>
        <span className="lt-meta">
          {rounds} 轮 · {entries} 条
        </span>
      </button>
      {!collapsed && (
        <div className="lt-session-body">
          {session.rounds.map((r) => (
            <RoundSection key={r.id} round={r} />
          ))}
        </div>
      )}
    </div>
  )
}

export function LogTreeWidget({ title, state }: { title: string; state: LogTreeState }) {
  const [autoScroll, setAutoScroll] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && ref.current) {
      ref.current.scrollTo({ top: ref.current.scrollHeight })
    }
  }, [state, autoScroll])

  return (
    <div className="widget logtree">
      <div className="widget-head">
        <span className="widget-title">{title}</span>
        <button
          className={`btn small${autoScroll ? ' active' : ''}`}
          onClick={() => setAutoScroll(!autoScroll)}
        >
          {autoScroll ? '⇩ 自动滚动' : '⏸ 已暂停'}
        </button>
      </div>
      <div className="logtree-body" ref={ref}>
        {state.sessions.length === 0 && (
          <div className="lt-empty">等待日志流入……（检查图中的日志源配置）</div>
        )}
        {state.sessions.map((s) => (
          <SessionSection key={s.id} session={s} />
        ))}
      </div>
    </div>
  )
}
