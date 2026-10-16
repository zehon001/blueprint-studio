import { registry } from '../nodeRegistry'
import { useGraphStore } from '../store'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../theme'

export function Palette() {
  const addNodeAt = useGraphStore((s) => s.addNodeAt)
  return (
    <aside className="palette">
      <div className="panel-title">节点库</div>
      {CATEGORY_ORDER.map((cat) => {
        const items = registry.filter((n) => n.category === cat)
        if (items.length === 0) return null
        return (
          <div key={cat} className="palette-group">
            <div className="palette-group-label">{CATEGORY_LABELS[cat]}</div>
            {items.map((n) => (
              <div
                key={n.id}
                className="palette-item"
                title={n.description}
                draggable
                onDragStart={(e) =>
                  e.dataTransfer.setData('application/blueprint-node', n.id)
                }
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
      <div className="palette-hint">拖到画布添加 · 点击快捷放置</div>
    </aside>
  )
}
