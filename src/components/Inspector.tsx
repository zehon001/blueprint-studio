import { registryById } from '../nodeRegistry'
import { paramOptionsFor, useGraphStore } from '../store'
import { useAppStore } from '../appStore'
import { PORT_COLORS } from '../theme'
import { ParamField } from './ParamEditor'

function PortList({
  title,
  ports,
}: {
  title: string
  ports: { id: string; label: string; type: string }[]
}) {
  return (
    <div className="inspector-ports">
      <div className="inspector-ports-label">{title}</div>
      {ports.length === 0 && <div className="inspector-port muted">（无）</div>}
      {ports.map((p) => (
        <div className="inspector-port" key={p.id}>
          <i style={{ background: PORT_COLORS[p.type as keyof typeof PORT_COLORS] }} />
          <span>{p.label || 'exec'}</span>
          <em>{p.type}</em>
        </div>
      ))}
    </div>
  )
}

export function Inspector() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const updateParam = useGraphStore((s) => s.updateParam)
  const deleteNode = useGraphStore((s) => s.deleteNode)
  const vars = useGraphStore((s) => s.vars)
  const graphNodes = useGraphStore((s) => s.nodes)
  const assets = useAppStore((s) => s.assets)

  const node = nodes.find((n) => n.id === selectedNodeId)
  const def = node ? registryById[node.data.defId] : undefined

  return (
    <div className="inspector-body">
      {!node || !def ? (
        <div className="inspector-empty">选中画布中的节点查看属性</div>
      ) : (
        <>
          <div className="inspector-head">
            <span className={`inspector-title cat-${def.category}`}>{def.title}</span>
            <span className="inspector-defid">{def.id}</span>
          </div>
          <div className="inspector-desc">{def.description}</div>
          {def.params && def.params.length > 0 && (
            <div className="inspector-params">
              {def.params.map((p) => (
                <ParamField
                  key={p.key}
                  def={p}
                  value={node.data.params[p.key]}
                  options={paramOptionsFor(p, { vars, nodes: graphNodes, assets })}
                  onChange={(v) => updateParam(node.id, p.key, v)}
                />
              ))}
            </div>
          )}
          <PortList title="输入端口" ports={def.inputs} />
          <PortList title="输出端口" ports={def.outputs} />
          <button className="btn danger-ghost inspector-delete" onClick={() => deleteNode(node.id)}>
            删除节点
          </button>
        </>
      )}
    </div>
  )
}
