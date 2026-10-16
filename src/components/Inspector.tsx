import { useAppStore } from '../appStore'
import { paramOptionsFor, useGraphStore } from '../store'
import { PORT_COLORS } from '../theme'
import type { ParamDef, SubgraphPort } from '../types'
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

function InterfaceEditor({
  subId,
  list,
  kind,
}: {
  subId: string
  list: SubgraphPort[]
  kind: 'params' | 'returns'
}) {
  const editSubInterface = useGraphStore((s) => s.editSubInterface)
  const label = kind === 'params' ? '输入参数' : '返回值'
  const update = (idx: number, patch: Partial<SubgraphPort>) =>
    editSubInterface(subId, { [kind]: list.map((p, i) => (i === idx ? { ...p, ...patch } : p)) })
  return (
    <div className="iface-editor">
      <div className="inspector-ports-label">{label}</div>
      {list.map((p, i) => (
        <div className="iface-row" key={i}>
          <input
            className="bp-input"
            value={p.name}
            placeholder="名称"
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <select
            className="bp-input"
            value={p.type}
            onChange={(e) => update(i, { type: e.target.value as SubgraphPort['type'] })}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
          <button
            className="btn danger-ghost small"
            onClick={() => editSubInterface(subId, { [kind]: list.filter((_, j) => j !== i) })}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn small"
        onClick={() =>
          editSubInterface(subId, {
            [kind]: [...list, { name: `arg${list.length + 1}`, type: 'string' }],
          })
        }
      >
        ＋ 添加
      </button>
    </div>
  )
}

export function Inspector() {
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId)
  const nodes = useGraphStore((s) => s.nodes)
  const updateParam = useGraphStore((s) => s.updateParam)
  const deleteNode = useGraphStore((s) => s.deleteNode)
  const vars = useGraphStore((s) => s.vars)
  const ui = useGraphStore((s) => s.working?.ui ?? null)
  const working = useGraphStore((s) => s.working)
  const activeGraphId = useGraphStore((s) => s.activeGraphId)
  const getDef = useGraphStore((s) => s.getDef)
  const assets = useAppStore((s) => s.assets)

  const node = nodes.find((n) => n.id === selectedNodeId)
  const def = node ? getDef(node.data.defId) : undefined
  const activeSub =
    activeGraphId !== 'main'
      ? working?.subgraphs.find((s) => s.id === activeGraphId)
      : undefined

  const optionsFor = (p: ParamDef) => paramOptionsFor(p, { vars, nodes, assets, ui })

  return (
    <div className="inspector-body">
      {activeSub && (
        <div className="sub-iface">
          <div className="inspector-head">
            <span className="inspector-title cat-subgraph">子蓝图：{activeSub.name}</span>
          </div>
          <div className="inspector-desc">接口改动会同步到主图的调用节点端口</div>
          <InterfaceEditor subId={activeSub.id} list={activeSub.params} kind="params" />
          <InterfaceEditor subId={activeSub.id} list={activeSub.returns} kind="returns" />
          <div className="divider-line" />
        </div>
      )}
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
                  options={optionsFor(p)}
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
