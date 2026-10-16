import { memo, useEffect, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { registryById } from '../nodeRegistry'
import { CATEGORY_LABELS, PORT_COLORS } from '../theme'
import { paramOptionsFor, useGraphStore, type GraphNode } from '../store'
import { useAppStore } from '../appStore'
import type { PortDef } from '../types'
import { ParamField } from './ParamEditor'

function PortRow({ port, side }: { port: PortDef; side: 'in' | 'out' }) {
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
          />
          {port.label && <span className="bp-port-label">{port.label}</span>}
        </>
      ) : (
        <>
          {port.label && <span className="bp-port-label">{port.label}</span>}
          <Handle
            type="source"
            position={Position.Right}
            id={port.id}
            className={handleClass}
            style={style}
          />
        </>
      )}
    </div>
  )
}

function BlueprintNodeInner({ id, data, selected }: NodeProps<GraphNode>) {
  const def = registryById[data.defId]
  const flashStamp = useGraphStore((s) => s.flash[id])
  const updateParam = useGraphStore((s) => s.updateParam)
  const vars = useGraphStore((s) => s.vars)
  const nodes = useGraphStore((s) => s.nodes)
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
  const optionCtx = { vars, nodes, assets }

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
            <PortRow key={p.id} port={p} side="in" />
          ))}
        </div>
        <div className="bp-ports-col">
          {def.outputs.map((p) => (
            <PortRow key={p.id} port={p} side="out" />
          ))}
        </div>
      </div>
      {(def.inputs.length > 0 || def.outputs.length > 0) && (
        <div className="bp-node-id">{id}</div>
      )}
    </div>
  )
}

export const BlueprintNodeComponent = memo(BlueprintNodeInner)
