import { useMemo, useState } from 'react'
import { parseScript, serializeScript } from '../script'
import { useGraphStore } from '../store'
import { useAppStore } from '../appStore'

export function ScriptView() {
  const open = useGraphStore((s) => s.scriptOpen)
  const toggleScript = useGraphStore((s) => s.toggleScript)
  const bound = useGraphStore((s) => s.bound)
  const replaceGraph = useGraphStore((s) => s.replaceGraph)
  const middlewares = useAppStore((s) => s.middlewares)
  const log = useAppStore((s) => s.log)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const current = useMemo(() => {
    if (!bound) return ''
    const mwName = middlewares.find((m) => m.id === bound.middlewareId)?.name ?? '未分组'
    return serializeScript({ name: bound.name, middlewareName: mwName, vars: useGraphStore.getState().vars, graph: useGraphStore.getState().serialize() })
  }, [bound, middlewares, open])

  if (!open || !bound) return null

  const text = draft ?? current

  const apply = () => {
    try {
      const parsed = parseScript(text)
      replaceGraph(parsed.graph, parsed.vars)
      setDraft(null)
      setError('')
      log('system', '脚本已应用回蓝图（保留已有节点位置，新节点排在左侧）')
      toggleScript(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="script-view">
      <div className="script-head">
        <span className="script-title">蓝图脚本（双向互转）</span>
        <span className="script-hint">语法：plugin / var / node 别名(参数) / edge a.port -&gt; b.port</span>
        <div className="script-actions">
          <button className="btn" onClick={() => { setDraft(null); setError('') }}>
            还原
          </button>
          <button className="btn primary" onClick={apply}>
            应用到蓝图
          </button>
          <button className="btn" onClick={() => toggleScript(false)}>
            关闭
          </button>
        </div>
      </div>
      {error && <div className="script-error">✕ {error}</div>}
      <textarea
        className="script-textarea nodrag"
        spellCheck={false}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
      />
    </div>
  )
}
