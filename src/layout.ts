import dagre from '@dagrejs/dagre'
import { registryById } from './nodeRegistry'
import type { GraphEdge, GraphNode } from './store'

/** 用 dagre 做 LR 分层布局，返回每个节点的左上角坐标 */
export function computeLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 48, ranksep: 120, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  const width = 210
  for (const node of nodes) {
    const def = registryById[node.data.defId]
    const rows = Math.max(def?.inputs.length ?? 1, def?.outputs.length ?? 1, 1)
    const height = 34 + rows * 20 + (def?.params?.length ?? 0) * 34 + 12
    g.setNode(node.id, { width, height })
  }
  for (const edge of edges) g.setEdge(edge.source, edge.target)

  dagre.layout(g)

  const positions: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) {
    const placed = g.node(node.id)
    if (placed) positions[node.id] = { x: placed.x - width / 2, y: placed.y - placed.height / 2 }
  }
  return positions
}
