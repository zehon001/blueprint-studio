import { create } from 'zustand'
import { applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange, XYPosition } from '@xyflow/react'
import { makeSubgraphNodeDef, registryById } from './nodeRegistry'
import { putPlugin } from './persistence'
import type {
  BlueprintNodeData,
  FlowEdgeData,
  NodeDef,
  ParamDef,
  PluginRecord,
  PortDef,
  PortType,
  SerializedGraph,
  SubgraphDef,
  SubgraphPort,
  UIComponent,
  UIComponentKind,
  VariableDef,
} from './types'

export type GraphNode = Node<BlueprintNodeData, 'blueprint'>
export type GraphEdge = Edge<FlowEdgeData, 'flow'>

let saveTimer: number | undefined

// ────────── 工作副本：主图 + 子蓝图 + UI 文档 ──────────

type WorkingCopy = {
  meta: { id: string; middlewareId: string; name: string }
  graph: SerializedGraph
  subgraphs: SubgraphDef[]
  ui: UIComponent
  vars: VariableDef[]
}

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

function hydrate(
  graph: SerializedGraph,
  getDef: (defId: string) => NodeDef | undefined,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []
  for (const n of graph.nodes) {
    const def = getDef(n.defId)
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
    const sourceDef = getDef(graph.nodes.find((x) => x.id === e.source)?.defId ?? '')
    const targetDef = getDef(graph.nodes.find((x) => x.id === e.target)?.defId ?? '')
    if (!sourceDef || !targetDef) continue
    // 端口有效性校验：丢弃引用不存在端口的幽灵连线
    if (!sourceDef.outputs.some((p) => p.id === e.sourcePort)) continue
    if (!targetDef.inputs.some((p) => p.id === e.targetPort)) continue
    const portType: PortType =
      sourceDef.outputs.find((p) => p.id === e.sourcePort)?.type ?? 'exec'
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

/** 子图中的入口/出口节点端口由子蓝图接口驱动 */
function subIODefs(sub: SubgraphDef): Record<string, NodeDef> {
  return {
    'sub/input': {
      id: 'sub/input',
      alias: '子图.入口',
      title: '子图入口',
      category: 'subgraph',
      description: '子蓝图执行的起点，输出调用方传入的参数',
      inputs: [],
      outputs: [
        { id: 'exec', label: '', type: 'exec' },
        ...sub.params.map((p) => ({ id: p.name, label: p.name, type: p.type as PortType })),
      ],
      run: () => ({ exec: 'exec' }),
    },
    'sub/output': {
      id: 'sub/output',
      alias: '子图.出口',
      title: '子图出口',
      category: 'subgraph',
      description: '结束子蓝图并返回值（可放置多个出口）',
      inputs: [
        { id: 'exec', label: '', type: 'exec' },
        ...sub.returns.map((p) => ({ id: p.name, label: p.name, type: p.type as PortType })),
      ],
      outputs: [],
      run: () => ({}),
    },
  }
}

// ────────── UI 组件树工具 ──────────

function walkComponents(
  root: UIComponent,
  fn: (c: UIComponent, parent: UIComponent | null) => void,
) {
  const visit = (node: UIComponent, parent: UIComponent | null) => {
    fn(node, parent)
    for (const child of node.children ?? []) visit(child, node)
  }
  visit(root, null)
}

function mapTree(root: UIComponent, fn: (c: UIComponent) => UIComponent): UIComponent {
  const next = fn(root)
  return { ...next, children: next.children?.map((c) => mapTree(c, fn)) }
}

function removeFromTree(root: UIComponent, id: string): UIComponent {
  return {
    ...root,
    children: (root.children ?? [])
      .filter((c) => c.id !== id)
      .map((c) => removeFromTree(c, id)),
  }
}

/** targetId 为 null 表示插入根节点；afterId 表示插到该兄弟节点之后 */
function insertIntoTree(
  root: UIComponent,
  targetId: string | null,
  comp: UIComponent,
  afterId?: string,
): UIComponent {
  if (targetId === null || root.id === targetId) {
    const children = [...(root.children ?? [])]
    if (afterId) {
      const idx = children.findIndex((c) => c.id === afterId)
      if (idx >= 0) children.splice(idx + 1, 0, comp)
      else children.push(comp)
    } else {
      children.push(comp)
    }
    return { ...root, children }
  }
  return {
    ...root,
    children: root.children?.map((c) => insertIntoTree(c, targetId, comp, afterId)),
  }
}

function moveInTree(root: UIComponent, id: string, dir: -1 | 1): UIComponent {
  if (root.children?.some((c) => c.id === id)) {
    const children = [...root.children]
    const idx = children.findIndex((c) => c.id === id)
    const target = idx + dir
    if (target >= 0 && target < children.length) {
      ;[children[idx], children[target]] = [children[target], children[idx]]
    }
    return { ...root, children }
  }
  return { ...root, children: root.children?.map((c) => moveInTree(c, id, dir)) }
}

// ────────── 连线类型校验 ──────────

export function portsCompatible(sourcePort?: PortDef, targetPort?: PortDef): boolean {
  if (!sourcePort || !targetPort) return false
  if (sourcePort.type === 'exec' || targetPort.type === 'exec') {
    return sourcePort.type === 'exec' && targetPort.type === 'exec'
  }
  if (sourcePort.type === 'any' || targetPort.type === 'any') return true
  if (sourcePort.type === targetPort.type) return true
  return sourcePort.type === 'number' && targetPort.type === 'string'
}

// ────────── Store ──────────

interface GraphStore {
  nodes: GraphNode[]
  edges: GraphEdge[]
  vars: VariableDef[]
  working: WorkingCopy | null
  /** 动态节点 def（子蓝图调用/入口/出口），入 state 保证 selector 引用稳定 */
  dynDefs: Record<string, NodeDef>
  activeGraphId: string
  selectedNodeId: string | null
  selectedCompId: string | null
  editorMode: 'graph' | 'ui'
  scriptOpen: boolean
  flash: Record<string, number>
  edgeFlash: Record<string, number>
  pinValues: Record<string, string>

  bindPlugin(plugin: PluginRecord): void
  markDirty(): void
  getDef(defId: string): NodeDef | undefined
  dynamicDefs(): NodeDef[]
  switchGraph(graphId: string): void
  addSubgraph(name: string): void
  removeSubgraph(subId: string): void
  editSubInterface(
    subId: string,
    patch: { params?: SubgraphPort[]; returns?: SubgraphPort[] },
  ): void

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

  setEditorMode(mode: 'graph' | 'ui'): void
  toggleScript(open: boolean): void
  selectComponent(compId: string | null): void
  addUIComponent(kind: UIComponentKind): void
  updateUIComp(compId: string, patch: { props?: Record<string, unknown>; name?: string }): void
  removeUIComp(compId: string): void
  moveUIComp(compId: string, dir: -1 | 1): void
  replaceGraph(graph: SerializedGraph, vars: VariableDef[]): void
  /** 脚本视图应用：整体替换主图 + 子蓝图 + 变量 */
  applyScriptParts(
    graph: SerializedGraph,
    subgraphs: SubgraphDef[],
    vars: VariableDef[],
  ): void

  flashNode(graphId: string, nodeId: string): void
  flashEdge(graphId: string, edgeId: string): void
  setPinValues(values: Record<string, string>): void
}

function buildDynamic(working: WorkingCopy, activeGraphId: string): Record<string, NodeDef> {
  const defs: Record<string, NodeDef> = {}
  for (const sub of working.subgraphs) defs[`sub/${sub.id}`] = makeSubgraphNodeDef(sub)
  if (activeGraphId !== 'main') {
    const sub = working.subgraphs.find((s) => s.id === activeGraphId)
    if (sub) Object.assign(defs, subIODefs(sub))
  }
  return defs
}

export const useGraphStore = create<GraphStore>()((set, get) => {
  const writeBack = () => {
    const { working, activeGraphId, nodes, edges } = get()
    if (!working) return
    const serialized = serializeGraph(nodes, edges)
    if (activeGraphId === 'main') working.graph = serialized
    else {
      const sub = working.subgraphs.find((s) => s.id === activeGraphId)
      if (sub) sub.graph = serialized
    }
  }

  const hydrateActive = () => {
    const { working, activeGraphId } = get()
    if (!working) return
    const dynamic = buildDynamic(working, activeGraphId)
    const getDef = (defId: string) => registryById[defId] ?? dynamic[defId]
    const slot =
      activeGraphId === 'main'
        ? working.graph
        : working.subgraphs.find((s) => s.id === activeGraphId)?.graph
    if (!slot) return
    if (activeGraphId !== 'main') {
      if (!slot.nodes.some((n) => n.defId === 'sub/input')) {
        slot.nodes.push({ id: 'in', defId: 'sub/input', position: { x: 0, y: 0 }, params: {} })
      }
      if (!slot.nodes.some((n) => n.defId === 'sub/output')) {
        slot.nodes.push({ id: 'out', defId: 'sub/output', position: { x: 640, y: 0 }, params: {} })
      }
    }
    const { nodes, edges } = hydrate(slot, getDef)
    set({
      nodes,
      edges,
      dynDefs: dynamic,
      selectedNodeId: null,
      flash: {},
      edgeFlash: {},
    })
  }

  const setWorking = (patch: (w: WorkingCopy) => Partial<WorkingCopy>) => {
    const w = get().working
    if (!w) return
    set({ working: { ...w, ...patch(w) } })
  }

  return {
    nodes: [],
    edges: [],
    vars: [],
    working: null,
    dynDefs: {},
    activeGraphId: 'main',
    selectedNodeId: null,
    selectedCompId: null,
    editorMode: 'graph',
    scriptOpen: false,
    flash: {},
    edgeFlash: {},
    pinValues: {},

    bindPlugin: (plugin) => {
      const working: WorkingCopy = {
        meta: { id: plugin.id, middlewareId: plugin.middlewareId, name: plugin.name },
        graph: structuredClone(plugin.graph),
        subgraphs: structuredClone(plugin.subgraphs ?? []),
        ui: structuredClone(plugin.ui ?? { id: 'ui-root', kind: 'vbox', props: {} }),
        vars: plugin.vars.map((v) => ({ ...v })),
      }
      set({
        working,
        vars: working.vars,
        activeGraphId: 'main',
        selectedCompId: null,
        editorMode: 'graph',
        scriptOpen: false,
        pinValues: {},
      })
      hydrateActive()
    },

    markDirty: () => {
      const working = get().working
      if (!working) return
      if (saveTimer) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        writeBack()
        const w = get().working
        if (!w) return
        const plugin: PluginRecord = {
          id: w.meta.id,
          middlewareId: w.meta.middlewareId,
          name: w.meta.name,
          graph: w.graph,
          subgraphs: w.subgraphs,
          ui: w.ui,
          vars: w.vars,
          updatedAt: Date.now(),
        }
        void putPlugin(plugin)
      }, 700)
    },

    getDef: (defId) => {
      const { working, dynDefs } = get()
      if (registryById[defId]) return registryById[defId]
      if (!working) return undefined
      return dynDefs[defId]
    },

    dynamicDefs: () => Object.values(get().dynDefs),

    switchGraph: (graphId) => {
      writeBack()
      set({ activeGraphId: graphId })
      hydrateActive()
    },

    addSubgraph: (name) => {
      const working = get().working
      if (!working) return
      const id = `sg-${crypto.randomUUID().slice(0, 6)}`
      const sub: SubgraphDef = {
        id,
        name: name.trim() || '子蓝图',
        params: [],
        returns: [],
        graph: {
          nodes: [
            { id: 'in', defId: 'sub/input', position: { x: 0, y: 0 }, params: {} },
            { id: 'out', defId: 'sub/output', position: { x: 640, y: 0 }, params: {} },
          ],
          edges: [],
        },
      }
      setWorking((w) => ({ subgraphs: [...w.subgraphs, sub] }))
      get().markDirty()
      set({ activeGraphId: id })
      hydrateActive()
    },

    removeSubgraph: (subId) => {
      const working = get().working
      if (!working) return
      const callIds = new Set(
        working.graph.nodes.filter((n) => n.defId === `sub/${subId}`).map((n) => n.id),
      )
      setWorking((w) => ({
        graph: {
          nodes: w.graph.nodes.filter((n) => n.defId !== `sub/${subId}`),
          edges: w.graph.edges.filter((e) => !callIds.has(e.source) && !callIds.has(e.target)),
        },
        subgraphs: w.subgraphs.filter((s) => s.id !== subId),
      }))
      if (get().activeGraphId === subId) {
        set({ activeGraphId: 'main' })
        hydrateActive()
      } else {
        const w = get().working
        if (w) set({ dynDefs: buildDynamic(w, get().activeGraphId) })
      }
      get().markDirty()
    },

    editSubInterface: (subId, patch) => {
      const working = get().working
      if (!working) return
      const sub = working.subgraphs.find((s) => s.id === subId)
      if (!sub) return
      Object.assign(sub, patch)
      // 接口变化后，移除图中指向失效端口的边
      const validOut = new Set(['exec', ...sub.params.map((p) => p.name)])
      const validIn = new Set(['exec', ...sub.returns.map((p) => p.name)])
      sub.graph.edges = sub.graph.edges.filter((e) => {
        const targetNode = sub.graph.nodes.find((n) => n.id === e.target)
        const sourceNode = sub.graph.nodes.find((n) => n.id === e.source)
        if (targetNode?.defId === 'sub/output') return validIn.has(e.targetPort)
        if (sourceNode?.defId === 'sub/input') return validOut.has(e.sourcePort)
        return true
      })
      setWorking(() => ({}))
      if (get().activeGraphId === subId) hydrateActive()
      get().markDirty()
    },

    onNodesChange: (changes) => {
      const { activeGraphId, nodes } = get()
      // 子图入口/出口节点不可删除
      const blocked = changes.filter((c) => {
        if (c.type !== 'remove' || activeGraphId === 'main') return true
        const node = nodes.find((n) => n.id === c.id)
        return !(node && (node.data.defId === 'sub/input' || node.data.defId === 'sub/output'))
      })
      set((s) => ({ nodes: applyNodeChanges(blocked, s.nodes) }))
      if (blocked.some((c) => c.type !== 'select' && c.type !== 'dimensions')) get().markDirty()
    },
    onEdgesChange: (changes) => {
      set((s) => ({ edges: applyEdgeChanges(changes, s.edges) }))
      if (changes.some((c) => c.type !== 'select')) get().markDirty()
    },

    onConnect: (connection) => {
      const { source, sourceHandle, target, targetHandle } = connection
      if (!source || !target || !sourceHandle || !targetHandle) return
      const { nodes, edges, getDef } = get()
      const sNode = nodes.find((n) => n.id === source)
      const tNode = nodes.find((n) => n.id === target)
      const sDef = sNode ? getDef(sNode.data.defId) : undefined
      const tDef = tNode ? getDef(tNode.data.defId) : undefined
      if (!sDef || !tDef) return
      const sp = sDef.outputs.find((p) => p.id === sourceHandle)
      const tp = tDef.inputs.find((p) => p.id === targetHandle)
      if (!portsCompatible(sp, tp)) return
      const portType = sp!.type

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
      const def = get().getDef(defId)
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
      const node = get().nodes.find((n) => n.id === nodeId)
      if (
        node &&
        get().activeGraphId !== 'main' &&
        (node.data.defId === 'sub/input' || node.data.defId === 'sub/output')
      ) {
        return
      }
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
      setWorking((w) => ({
        vars: w.vars.map((v, i) => (i === index ? { ...v, ...patch } : v)),
      }))
      set({ vars: get().working!.vars })
      get().markDirty()
    },
    addVar: () => {
      setWorking((w) => ({
        vars: [...w.vars, { name: `var${w.vars.length + 1}`, type: 'string', default: '' }],
      }))
      set({ vars: get().working!.vars })
      get().markDirty()
    },
    removeVar: (index) => {
      setWorking((w) => ({ vars: w.vars.filter((_, i) => i !== index) }))
      set({ vars: get().working!.vars })
      get().markDirty()
    },

    setEditorMode: (mode) => set({ editorMode: mode, scriptOpen: false }),
    toggleScript: (open) => set({ scriptOpen: open }),

    selectComponent: (compId) => set({ selectedCompId: compId }),

    addUIComponent: (kind) => {
      const w = get().working
      if (!w) return
      const id = `comp-${crypto.randomUUID().slice(0, 6)}`
      const comp: UIComponent = { id, kind, props: {} }
      const selected = get().selectedCompId
      const found: { comp: UIComponent; parent: UIComponent | null } | null = null
      let sel: { comp: UIComponent; parent: UIComponent | null } | null = found
      if (selected) {
        walkComponents(w.ui, (c, p) => {
          if (c.id === selected) sel = { comp: c, parent: p }
        })
      }
      const isContainer = (c: UIComponent) => ['vbox', 'hbox', 'panel'].includes(c.kind)
      let tree: UIComponent
      if (sel) {
        const picked = sel as { comp: UIComponent; parent: UIComponent | null }
        if (isContainer(picked.comp)) {
          tree = insertIntoTree(w.ui, picked.comp.id, comp)
        } else {
          const parentId = picked.parent && picked.parent.id !== 'ui-root' ? picked.parent.id : null
          tree = insertIntoTree(w.ui, parentId, comp, picked.comp.id)
        }
      } else {
        tree = insertIntoTree(w.ui, null, comp)
      }
      setWorking(() => ({ ui: tree }))
      set({ selectedCompId: id })
      get().markDirty()
    },

    updateUIComp: (compId, patch) => {
      setWorking((w) => ({
        ui: mapTree(w.ui, (c) =>
          c.id === compId
            ? { ...c, name: patch.name ?? c.name, props: { ...c.props, ...(patch.props ?? {}) } }
            : c,
        ),
      }))
      get().markDirty()
    },

    removeUIComp: (compId) => {
      setWorking((w) => ({ ui: removeFromTree(w.ui, compId) }))
      if (get().selectedCompId === compId) set({ selectedCompId: null })
      get().markDirty()
    },

    moveUIComp: (compId, dir) => {
      setWorking((w) => ({ ui: moveInTree(w.ui, compId, dir) }))
      get().markDirty()
    },

    replaceGraph: (graph, vars) => {
      const working = get().working
      if (!working) return
      const current = serializeGraph(get().nodes, get().edges)
      const prevPositions = new Map(current.nodes.map((n) => [n.id, n.position]))
      let newY = 20
      const positioned = {
        ...graph,
        nodes: graph.nodes.map((n) => {
          const prev = prevPositions.get(n.id)
          if (prev) return { ...n, position: prev }
          const position = { x: 20, y: newY }
          newY += 110
          return { ...n, position }
        }),
      }
      if (get().activeGraphId === 'main') working.graph = positioned
      else {
        const sub = working.subgraphs.find((s) => s.id === get().activeGraphId)
        if (sub) sub.graph = positioned
      }
      working.vars = vars
      set({ vars })
      hydrateActive()
      get().markDirty()
    },

    applyScriptParts: (graph, subgraphs, vars) => {
      const working = get().working
      if (!working) return
      const prevPositions = new Map(
        [...working.graph.nodes, ...working.subgraphs.flatMap((s) => s.graph.nodes)].map((n) => [
          n.id,
          n.position,
        ]),
      )
      const positionAll = (g: SerializedGraph): SerializedGraph => {
        let newY = 20
        return {
          ...g,
          nodes: g.nodes.map((n) => {
            const prev = prevPositions.get(n.id)
            if (prev) return { ...n, position: prev }
            const position = { x: 20, y: newY }
            newY += 110
            return { ...n, position }
          }),
        }
      }
      setWorking(() => ({
        graph: positionAll(graph),
        subgraphs: subgraphs.map((s) => ({ ...s, graph: positionAll(s.graph) })),
        vars,
      }))
      set({ activeGraphId: 'main', vars })
      hydrateActive()
      get().markDirty()
    },

    flashNode: (graphId, nodeId) => {
      const key = `${graphId}:${nodeId}`
      set((s) => ({ flash: { ...s.flash, [key]: Date.now() } }))
      window.setTimeout(() => {
        set((s) => {
          if (!s.flash[key]) return s
          const next = { ...s.flash }
          delete next[key]
          return { flash: next }
        })
      }, 700)
    },

    flashEdge: (graphId, edgeId) => {
      const key = `${graphId}:${edgeId}`
      set((s) => ({ edgeFlash: { ...s.edgeFlash, [key]: Date.now() } }))
      window.setTimeout(() => {
        set((s) => {
          if (!s.edgeFlash[key]) return s
          const next = { ...s.edgeFlash }
          delete next[key]
          return { edgeFlash: next }
        })
      }, 700)
    },

    setPinValues: (values) => set((s) => ({ pinValues: { ...s.pinValues, ...values } })),
  }
})

/** 丢弃引用不存在节点/端口的连线（模板与脚本数据也要过这道净化） */
export function sanitizeGraph(
  graph: SerializedGraph,
  resolveDef: (defId: string) => NodeDef | undefined,
): SerializedGraph {
  const nodes = graph.nodes.filter((n) => resolveDef(n.defId))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => {
    if (!ids.has(e.source) || !ids.has(e.target)) return false
    const sDef = resolveDef(graph.nodes.find((x) => x.id === e.source)!.defId)
    const tDef = resolveDef(graph.nodes.find((x) => x.id === e.target)!.defId)
    if (!sDef || !tDef) return false
    return (
      sDef.outputs.some((p) => p.id === e.sourcePort) &&
      tDef.inputs.some((p) => p.id === e.targetPort)
    )
  })
  return { nodes, edges }
}

/** 属性面板/节点面板共用的参数候选值（变量 / 资产 / 日志源 / UI 组件） */
export function paramOptionsFor(
  param: ParamDef,
  ctx: {
    vars: VariableDef[]
    nodes: GraphNode[]
    assets: { name: string }[]
    ui: UIComponent | null
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
  if (param.valueType === 'uicomponent') {
    if (!ctx.ui) return []
    const out: { value: string; label: string }[] = []
    walkComponents(ctx.ui, (c) => {
      const kindOk = !param.componentKinds || param.componentKinds.includes(c.kind)
      if (kindOk) out.push({ value: c.id, label: `${c.id}` })
    })
    return out
  }
  return undefined
}

export type { ParamDef }
