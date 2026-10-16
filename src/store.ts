import { create } from 'zustand'
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange, XYPosition } from '@xyflow/react'
import { registryById } from './nodeRegistry'
import { putPlugin } from './persistence'
import type {
  BlueprintNodeData,
  FlowEdgeData,
  ParamDef,
  PluginRecord,
  PortDef,
  PortType,
  SerializedGraph,
  VariableDef,
} from './types'

export type GraphNode = Node<BlueprintNodeData, 'blueprint'>
export type GraphEdge = Edge<FlowEdgeData, 'flow'>

export type LogKind = 'print' | 'error' | 'system'
export type LogEntry = { id: number; time: string; kind: LogKind; text: string }

let saveTimer: number | undefined

function serializeGraph(nodes: GraphNode[], edges: GraphEdge[]): SerializedGraph {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      defId: n.data.defId,
      position: { x: n.position.x, y: n.position.y },
      params: { ...n.data.params },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourcePort: e.sourceHandle ?? '',
      target: e.target,
      targetPort: e.targetHandle ?? '',
    })),
  }
}

function hydrate(graph: SerializedGraph): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  for (const n of graph.nodes) {
    const def = registryById[n.defId]
    if (!def) continue
    const params: Record<string, unknown> = {}
    for (const p of def.params ?? []) params[p.key] = n.params?.[p.key] ?? p.default
    for (const [k, v] of Object.entries(n.params ?? {})) if (!(k in params)) params[k] = v
    nodes.push({
      id: n.id,
      type: 'blueprint',
      position: n.position,
      data: { defId: n.defId, params },
      selected: false,
    })
  }
  const ids = new Set(nodes.map((n) => n.id))
  const edges: GraphEdge[] = []
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    const sourceDef = registryById[graph.nodes.find((x) => x.id === e.source)?.defId ?? '']
    const portType: PortType =
      sourceDef?.outputs.find((p) => p.id === e.sourcePort)?.type ?? 'exec'
    edges.push({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourcePort,
      target: e.target,
      targetHandle: e.targetPort,
      type: 'flow',
      data: { portType },
      selected: false,
    })
  }
  return { nodes, edges }
}

export function portsCompatible(sourcePort?: PortDef, targetPort?: PortDef): boolean {
  if (!sourcePort || !targetPort) return false
  if (sourcePort.type === 'exec' || targetPort.type === 'exec') {
    return sourcePort.type === 'exec' && targetPort.type === 'exec'
  }
  if (sourcePort.type === 'any' || targetPort.type === 'any') return true
  if (sourcePort.type === targetPort.type) return true
  return sourcePort.type === 'number' && targetPort.type === 'string'
}

export function isValidConnection(
  c: Pick<Edge, 'source' | 'sourceHandle' | 'target' | 'targetHandle'>,
): boolean {
  const { nodes } = useGraphStore.getState()
  const sNode = nodes.find((n) => n.id === c.source)
  const tNode = nodes.find((n) => n.id === c.target)
  if (!sNode || !tNode) return false
  const sDef = registryById[sNode.data.defId]
  const tDef = registryById[tNode.data.defId]
  if (!sDef || !tDef) return false
  return portsCompatible(
    sDef.outputs.find((p) => p.id === c.sourceHandle),
    tDef.inputs.find((p) => p.id === c.targetHandle),
  )
}

interface GraphStore {
  nodes: GraphNode[]
  edges: GraphEdge[]
  vars: VariableDef[]
  selectedNodeId: string | null
  flash: Record<string, number>
  scriptOpen: boolean
  /** 当前绑定的插件（编辑对象，含自动保存） */
  bound: PluginRecord | null

  bindPlugin(plugin: PluginRecord): void
  serialize(): SerializedGraph
  markDirty(): void

  onNodesChange(changes: NodeChange<GraphNode>[]): void
  onEdgesChange(changes: EdgeChange<GraphEdge>[]): void
  onConnect(connection: Connection): void
  onSelectionChange(nodeIds: string[]): void
  addNodeAt(defId: string, position: XYPosition): void
  updateParam(nodeId: string, key: string, value: unknown): void
  deleteNode(nodeId: string): void
  applyLayout(positions: Record<string, XYPosition>): void

  setVar(index: number, patch: Partial<VariableDef>): void
  addVar(): void
  removeVar(index: number): void

  toggleScript(open: boolean): void
  /** 从脚本应用回蓝图（保留已有节点位置） */
  replaceGraph(graph: SerializedGraph, vars: VariableDef[]): void

  flashNode(nodeId: string): void
}

export const useGraphStore = create<GraphStore>()((set, get) => ({
  nodes: [],
  edges: [],
  vars: [],
  selectedNodeId: null,
  flash: {},
  scriptOpen: false,
  bound: null,

  bindPlugin: (plugin) => {
    const { nodes, edges } = hydrate(plugin.graph)
    set({
      nodes,
      edges,
      vars: plugin.vars.map((v) => ({ ...v })),
      selectedNodeId: null,
      flash: {},
      scriptOpen: false,
      bound: { ...plugin },
    })
  },

  serialize: () => serializeGraph(get().nodes, get().edges),

  markDirty: () => {
    const bound = get().bound
    if (!bound) return
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      const plugin: PluginRecord = {
        ...get().bound!,
        graph: serializeGraph(get().nodes, get().edges),
        vars: get().vars,
        updatedAt: Date.now(),
      }
      set({ bound: plugin })
      void putPlugin(plugin)
    }, 700)
  },

  onNodesChange: (changes) => {
    set((s) => ({ nodes: applyNodeChanges(changes, s.nodes) }))
    if (changes.some((c) => c.type !== 'select' && c.type !== 'dimensions')) get().markDirty()
  },
  onEdgesChange: (changes) => {
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }))
    if (changes.some((c) => c.type !== 'select')) get().markDirty()
  },

  onConnect: (connection) => {
    const { source, sourceHandle, target, targetHandle } = connection
    if (!source || !target || !sourceHandle || !targetHandle) return
    if (!isValidConnection(connection)) return

    const { nodes, edges } = get()
    const sourceDef = registryById[nodes.find((n) => n.id === source)!.data.defId]!
    const portType = sourceDef.outputs.find((p) => p.id === sourceHandle)!.type

    let next = edges.filter((e) => !(e.target === target && e.targetHandle === targetHandle))
    if (portType === 'exec') {
      // exec 输出端口单连线：替换旧连线（蓝图同款语义）
      next = next.filter((e) => !(e.source === source && e.sourceHandle === sourceHandle))
    }

    const id = `e-${source}-${sourceHandle}-${target}-${targetHandle}`
    if (next.some((e) => e.id === id)) return
    set({
      edges: [
        ...next,
        { id, source, sourceHandle, target, targetHandle, type: 'flow', data: { portType } },
      ],
    })
    get().markDirty()
  },

  onSelectionChange: (nodeIds) => set({ selectedNodeId: nodeIds[0] ?? null }),

  addNodeAt: (defId, position) => {
    const def = registryById[defId]
    if (!def) return
    const params: Record<string, unknown> = {}
    for (const p of def.params ?? []) params[p.key] = p.default
    const id = `n-${crypto.randomUUID().slice(0, 8)}`
    set((s) => ({
      nodes: [...s.nodes, { id, type: 'blueprint', position, data: { defId, params } }],
      selectedNodeId: id,
    }))
    get().markDirty()
  },

  updateParam: (nodeId, key, value) => {
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, params: { ...n.data.params, [key]: value } } }
          : n,
      ),
    }))
    get().markDirty()
  },

  deleteNode: (nodeId) => {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== nodeId),
      edges: s.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
    }))
    get().markDirty()
  },

  applyLayout: (positions) => {
    set((s) => ({
      nodes: s.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
    }))
    get().markDirty()
  },

  setVar: (index, patch) => {
    set((s) => ({ vars: s.vars.map((v, i) => (i === index ? { ...v, ...patch } : v)) }))
    get().markDirty()
  },
  addVar: () => {
    set((s) => ({
      vars: [...s.vars, { name: `var${s.vars.length + 1}`, type: 'string', default: '' }],
    }))
    get().markDirty()
  },
  removeVar: (index) => {
    set((s) => ({ vars: s.vars.filter((_, i) => i !== index) }))
    get().markDirty()
  },

  toggleScript: (open) => set({ scriptOpen: open }),

  replaceGraph: (graph, vars) => {
    const current = get().serialize()
    const prevPositions = new Map(current.nodes.map((n) => [n.id, n.position]))
    let newY = 20
    const { nodes, edges } = hydrate({
      ...graph,
      nodes: graph.nodes.map((n) => {
        const prev = prevPositions.get(n.id)
        if (prev) return { ...n, position: prev }
        const position = { x: 20, y: newY }
        newY += 110
        return { ...n, position }
      }),
    })
    set({ nodes, edges, vars, selectedNodeId: null })
    get().markDirty()
  },

  flashNode: (nodeId) => {
    set((s) => ({ flash: { ...s.flash, [nodeId]: Date.now() } }))
    window.setTimeout(() => {
      set((s) => {
        if (!s.flash[nodeId]) return s
        const next = { ...s.flash }
        delete next[nodeId]
        return { flash: next }
      })
    }, 700)
  },
}))

/** 属性面板/节点面板共用的参数候选值（变量 / 资产 / 日志源） */
export function paramOptionsFor(
  param: ParamDef,
  ctx: {
    vars: VariableDef[]
    nodes: GraphNode[]
    assets: { name: string }[]
  },
): { value: string; label: string }[] | undefined {
  if (param.valueType === 'variable') {
    return ctx.vars
      .filter((v) => !param.variableType || v.type === param.variableType)
      .map((v) => ({ value: v.name, label: v.name }))
  }
  if (param.valueType === 'asset') {
    return ctx.assets.map((a) => ({ value: a.name, label: a.name }))
  }
  if (param.valueType === 'source') {
    return ctx.nodes
      .map((n) => ({ node: n, def: registryById[n.data.defId] }))
      .filter((x) => x.def?.category === 'source')
      .map((x) => ({ value: x.node.id, label: `${x.def!.title} (${x.node.id})` }))
  }
  return undefined
}

export type { ParamDef }
