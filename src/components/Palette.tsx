import { registry } from '../nodeRegistry'
import { useGraphStore } from '../store'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../theme'
import type { NodeCategory } from '../types'

export function Palette() {
  const addNodeAt = useGraphStore((s) => s.addNodeAt)
  const working = useGraphStore((s) => s.working)
  const activeGraphId = useGraphStore((s) => s.activeGraphId)
  const dynDefs = useGraphStore((s) => s.dynDefs)
  const dynamicDefs = Object.values(dynDefs).filter(
    (d) => d.id !== 'sub/input' && d.id !== 'sub/output',
  )
  const subgraphs = working?.subgraphs ?? []

  const items: { id: string; title: string; description: string; category: NodeCategory }[] = [
    ...registry.filter((n) => n.id !== 'sub/input' && n.id !== 'sub/output'),
    ...dynamicDefs,
  ]

  return (
    <aside className="palette">
      <div className="panel-title">节点库</div>
      {CATEGORY_ORDER.map((cat) => {
        const catItems = items.filter((n) => n.category === cat)
        if (catItems.length === 0) return null
        return (
          <div key={cat} className="palette-group">
            <div className="palette-group-label">
              {CATEGORY_LABELS[cat]}
              {cat === 'subgraph' && subgraphs.length > 0 && ` · ${subgraphs.length}`}
            </div>
            {catItems.map((n) => (
              <div
                key={n.id}
                className="palette-item"
                title={n.description}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/blueprint-node', n.id)}
                onClick={() =>
                  addNodeAt(n.id, { x: 140 + Math.random() * 200, y: 140 + Math.random() * 240 })
                }
              >
                <span className={`palette-dot cat-${n.category}`} />
                {n.title}
              </div>
            ))}
          </div>
        )
      })}
      <div className="palette-hint">
        拖到画布添加 · 点击快捷放置
        <br />
        {activeGraphId === 'main'
          ? '子蓝图分组里是本插件可复用的子图'
          : '当前在子蓝图中编辑（入口/出口不可删）'}
      </div>
    </aside>
  )
}
