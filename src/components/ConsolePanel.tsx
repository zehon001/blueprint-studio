import { useEffect, useRef } from 'react'
import { useAppStore } from '../appStore'

export function ConsolePanel({ compact = false }: { compact?: boolean }) {
  const logs = useAppStore((s) => s.logs)
  const clearLogs = useAppStore((s) => s.clearLogs)
  const wsStatus = useAppStore((s) => s.wsStatus)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.scrollTo({ top: 1e9 })
  }, [logs.length])

  return (
    <div className={`console-wrap${compact ? ' compact' : ''}`}>
      <div className="console-head">
        <span className={`badge ${wsStatus === 'online' ? 'running' : 'stopped'}`}>
          {wsStatus === 'online' ? '后端在线' : '后端离线'}
        </span>
        <button className="btn console-clear" onClick={clearLogs}>
          清空
        </button>
      </div>
      <div className="console" ref={ref}>
        {logs.length === 0 && <div className="log log-system">（暂无日志）</div>}
        {logs.map((l) => (
          <div key={l.id} className={`log log-${l.kind}`}>
            [{l.time}] {l.text}
          </div>
        ))}
      </div>
    </div>
  )
}
