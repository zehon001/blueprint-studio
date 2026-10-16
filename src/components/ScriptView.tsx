import { useMemo, useState } from 'react'
import { parseScript, serializeScript } from '../script'
import { useGraphStore } from '../store'
import { useAppStore } from '../appStore'

export function ScriptView() {
  const open = useGraphStore((s) => s.scriptOpen)
  const toggleScript = useGraphStore((s) => s.toggleScript)
  const working = useGraphStore((s) => s.working)
  const applyScriptParts = useGraphStore((s) => s.applyScriptParts)
  const middlewares = useAppStore((s) => s.middlewares)
  const log = useAppStore((s) => s.log)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')

  const current = useMemo(() => {
    const s = useGraphStore.getState()
    if (!s.working) return ''
    const mwName =
      middlewares.find((m) => m.id === s.working!.meta.middlewareId)?.name ?? '未分组'
    return serializeScript({
      name: s.working.meta.name,
      middlewareName: mwName,
      vars: s.working.vars,
      graph: s.working.graph,
      subgraphs: s.working.subgraphs,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, middlewares, open])

  if (!open || !working) return null

  const text = draft ?? current

  const apply = () => {
    try {
      const parsed = parseScript(text)
      applyScriptParts(parsed.graph, parsed.subgraphs, parsed.vars)
      setDraft(null)
      setError('')
      log('system', '脚本已应用回蓝图（子蓝图段落一并更新）')
      toggleScript(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="script-view">
      <div className="script-head">
        <span className="script-title">蓝图脚本（双向互转，含子蓝图段落）</span>
        <span className="script-hint">
          语法：plugin / var / node 别名(参数) / edge a.port -&gt; b.port / sub id 名 (参数) -&gt; (返回)
        </span>
        <div className="script-actions">
          <button
            className="btn"
            onClick={() => {
              setDraft(null)
              setError('')
            }}
          >
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
