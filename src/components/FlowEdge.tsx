import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { PORT_COLORS } from '../theme'
import { useGraphStore, type GraphEdge } from '../store'

export function FlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<GraphEdge>) {
  const portType = data?.portType
  const color = portType ? PORT_COLORS[portType] : '#8b90a0'
  const width = portType === 'exec' ? 2.4 : 1.8
  const flowing = useGraphStore((s) => Boolean(s.edgeFlash[`${s.activeGraphId}:${id}`]))
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY })
  return (
    <BaseEdge
      id={id}
      path={path}
      className={flowing ? 'edge-flowing' : undefined}
      style={{ stroke: color, strokeWidth: flowing ? width + 0.8 : width }}
    />
  )
}
