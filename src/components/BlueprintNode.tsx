import { memo, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { CATEGORY_LABELS, PORT_COLORS } from '../theme'
import { paramOptionsFor, useGraphStore, type GraphNode } from '../store'
import { useAppStore } from '../appStore'
import type { PortDef } from '../types'
import { ParamField } from './ParamEditor'

function PortRow({
  port,
  side,
  pinValue,
}: {
  port: PortDef
  side: 'in' | 'out'
  pinValue?: string
}) {
  const isExec = port.type === 'exec'
  const handleClass = `bp-handle ${side === 'in' ? 'bp-handle-in' : 'bp-handle-out'} ${
    isExec ? 'bp-exec' : 'bp-data'
  }`
  const style = isExec ? undefined : { borderColor: PORT_COLORS[port.type] }
  return (
    <div className={`bp-port-row ${side}`}>
      {side === 'in' ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id={port.id}
            className={handleClass}
            style={style}
            title={pinValue}
          />
          <span className="bp-port-label" title={pinValue}>
            {port.label}
            {pinValue && <span className="bp-pin">{pinValue}</span>}
          </span>
        </>
      ) : (
        <>
          <span className="bp-port-label" title={pinValue}>
            {port.label}
            {pinValue && <span className="bp-pin">{pinValue}</span>}
          </span>
          <Handle
            type="source"
            position={Position.Right}
            id={port.id}
            className={handleClass}
            style={style}
            title={pinValue}
          />
        </>
      )}
    </div>
  )
}

function BlueprintNodeInner({ id, data, selected }: NodeProps<GraphNode>) {
  const def = useGraphStore((s) => (s.working ? s.getDef(data.defId) : undefined))
  const activeGraphId = useGraphStore((s) => s.activeGraphId)
  const flashStamp = useGraphStore((s) => s.flash[`${s.activeGraphId}:${id}`])
  const pinValues = useGraphStore((s) => s.pinValues)
  const updateParam = useGraphStore((s) => s.updateParam)
  const vars = useGraphStore((s) => s.vars)
  const nodes = useGraphStore((s) => s.nodes)
  const ui = useGraphStore((s) => s.working?.ui ?? null)
  const assets = useAppStore((s) => s.assets)
  const flashRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = flashRef.current
    if (!el || !flashStamp) return
    el.classList.remove('bp-flash')
    void el.offsetWidth
    el.classList.add('bp-flash')
  }, [flashStamp])

  if (!def) return null
  const optionCtx = { vars, nodes, assets, ui }
  const pinOf = (portId: string) => pinValues[`${activeGraphId}:${id}:${portId}`]

  return (
    <div ref={flashRef} className={`bp-node cat-${def.category}${selected ? ' selected' : ''}`}>
      <div className="bp-node-header">
        <span className="bp-node-title">{def.title}</span>
        <span className="bp-node-tag">{CATEGORY_LABELS[def.category]}</span>
      </div>
      {def.params && def.params.length > 0 && (
        <div className="bp-params">
          {def.params.map((p) => (
            <ParamField
              key={p.key}
              def={p}
              value={data.params[p.key]}
              options={paramOptionsFor(p, optionCtx)}
              onChange={(v) => updateParam(id, p.key, v)}
            />
          ))}
        </div>
      )}
      <div className="bp-ports">
        <div className="bp-ports-col">
          {def.inputs.map((p) => (
            <PortRow key={p.id} port={p} side="in" pinValue={pinOf(p.id)} />
          ))}
        </div>
        <div className="bp-ports-col">
          {def.outputs.map((p) => (
            <PortRow key={p.id} port={p} side="out" pinValue={pinOf(p.id)} />
          ))}
        </div>
      </div>
      <div className="bp-node-id">{id}</div>
    </div>
  )
}

export const BlueprintNodeComponent = memo(BlueprintNodeInner)
