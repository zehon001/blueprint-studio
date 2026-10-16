import { useCallback } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import type { Node } from '@xyflow/react'
import { registryById } from '../nodeRegistry'
import { CATEGORY_COLORS } from '../theme'
import { isValidConnection, useGraphStore } from '../store'
import type { BlueprintNodeData } from '../types'
import { BlueprintNodeComponent } from './BlueprintNode'
import { FlowEdgeComponent } from './FlowEdge'

const nodeTypes = { blueprint: BlueprintNodeComponent }
const edgeTypes = { flow: FlowEdgeComponent }

function miniMapNodeColor(node: Node): string {
  const data = node.data as BlueprintNodeData
  const def = registryById[data?.defId]
  return def ? CATEGORY_COLORS[def.category] : '#555'
}

export function Canvas() {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const onNodesChange = useGraphStore((s) => s.onNodesChange)
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange)
  const onConnect = useGraphStore((s) => s.onConnect)
  const onSelectionChange = useGraphStore((s) => s.onSelectionChange)
  const addNodeAt = useGraphStore((s) => s.addNodeAt)
  const { screenToFlowPosition } = useReactFlow()

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const defId = event.dataTransfer.getData('application/blueprint-node')
      if (!defId) return
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      addNodeAt(defId, position)
    },
    [screenToFlowPosition, addNodeAt],
  )

  return (
    <div className="rf-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={(params) => onSelectionChange(params.nodes.map((n) => n.id))}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        snapToGrid
        snapGrid={[16, 16]}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.1}
        maxZoom={2}
        connectionRadius={28}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} color="#232630" />
        <MiniMap
          pannable
          zoomable
          nodeColor={miniMapNodeColor}
          maskColor="rgba(13,14,18,0.72)"
          style={{
            background: '#1b1d24',
            border: '1px solid #2b2f3a',
            borderRadius: 6,
            width: 158,
            height: 108,
          }}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
