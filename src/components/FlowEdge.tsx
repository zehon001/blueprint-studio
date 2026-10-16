import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { PORT_COLORS } from '../theme'
import type { GraphEdge } from '../store'

export function FlowEdgeComponent({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<GraphEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY })
  const portType = data?.portType
  const color = portType ? PORT_COLORS[portType] : '#8b90a0'
  const width = portType === 'exec' ? 2.4 : 1.8
  return <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: width }} />
}
