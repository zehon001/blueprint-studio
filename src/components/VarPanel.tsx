import { useGraphStore } from '../store'

export function VarPanel() {
  const vars = useGraphStore((s) => s.vars)
  const setVar = useGraphStore((s) => s.setVar)
  const addVar = useGraphStore((s) => s.addVar)
  const removeVar = useGraphStore((s) => s.removeVar)

  return (
    <div className="varpanel">
      <div className="varpanel-list">
        {vars.length === 0 && (
          <div className="inspector-empty">还没有变量。包名、环境等公共值建议先定义成变量，节点里下拉选择。</div>
        )}
        {vars.map((v, i) => (
          <div className="var-row" key={i}>
            <input
              className="bp-input"
              value={v.name}
              placeholder="名称"
              onChange={(e) => setVar(i, { name: e.target.value })}
            />
            <select
              className="bp-input"
              value={v.type}
              onChange={(e) => setVar(i, { type: e.target.value as typeof v.type })}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            {v.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={Boolean(v.default)}
                onChange={(e) => setVar(i, { default: e.target.checked })}
              />
            ) : (
              <input
                className="bp-input"
                type={v.type === 'number' ? 'number' : 'text'}
                value={String(v.default ?? '')}
                onChange={(e) =>
                  setVar(i, { default: v.type === 'number' ? Number(e.target.value) || 0 : e.target.value })
                }
              />
            )}
            <button className="btn danger-ghost var-del" onClick={() => removeVar(i)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <button className="btn var-add" onClick={addVar}>
        ＋ 添加变量
      </button>
    </div>
  )
}
