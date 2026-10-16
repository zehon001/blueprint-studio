import { useGraphStore } from '../store'

/** 蓝图模式下的图导航：主图 + 子蓝图 tabs */
export function GraphTabs() {
  const working = useGraphStore((s) => s.working)
  const activeGraphId = useGraphStore((s) => s.activeGraphId)
  const switchGraph = useGraphStore((s) => s.switchGraph)
  const addSubgraph = useGraphStore((s) => s.addSubgraph)
  const removeSubgraph = useGraphStore((s) => s.removeSubgraph)
  if (!working) return null

  return (
    <div className="graph-tabs">
      <button
        className={`graph-tab${activeGraphId === 'main' ? ' active' : ''}`}
        onClick={() => switchGraph('main')}
      >
        主图
      </button>
      {working.subgraphs.map((sub) => (
        <button
          key={sub.id}
          className={`graph-tab sub${activeGraphId === sub.id ? ' active' : ''}`}
          onClick={() => switchGraph(sub.id)}
          title={`${sub.id} · 参数 ${sub.params.length} · 返回 ${sub.returns.length}`}
        >
          {sub.name}
          <span
            className="graph-tab-close"
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm(`删除子蓝图「${sub.name}」？主图中的调用节点会一并移除。`)) {
                removeSubgraph(sub.id)
              }
            }}
          >
            ✕
          </span>
        </button>
      ))}
      <button
        className="graph-tab add"
        onClick={() => {
          const name = window.prompt('子蓝图名称：', '新子蓝图')
          if (name !== null) addSubgraph(name)
        }}
      >
        ＋ 子蓝图
      </button>
    </div>
  )
}
