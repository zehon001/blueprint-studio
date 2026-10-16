import { registryById } from '../nodeRegistry'
import type {
  AssetRecord,
  EngineToUI,
  NodeCtx,
  NodeEvent,
  PortDef,
  RunResult,
  SerializedEdge,
  SerializedGraph,
  SerializedNode,
  SubgraphDef,
} from '../types'

const MAX_STEPS = 5000
const RPC_TIMEOUT_MS = 15000
const PIN_VALUE_MAX = 100

type Emit = (message: EngineToUI) => void

/** 一个可执行的图命名空间：主图或某个子蓝图 */
type Scope = {
  graphId: string
  nodesById: Map<string, SerializedNode>
  edgesBySource: Map<string, SerializedEdge[]>
  edgesByTarget: Map<string, SerializedEdge[]>
}

function indexGraph(graphId: string, graph: SerializedGraph): Scope {
  const scope: Scope = {
    graphId,
    nodesById: new Map(),
    edgesBySource: new Map(),
    edgesByTarget: new Map(),
  }
  for (const node of graph.nodes) scope.nodesById.set(node.id, node)
  for (const edge of graph.edges) {
    const sKey = `${edge.source}:${edge.sourcePort}`
    const tKey = `${edge.target}:${edge.targetPort}`
    scope.edgesBySource.set(sKey, [...(scope.edgesBySource.get(sKey) ?? []), edge])
    scope.edgesByTarget.set(tKey, [...(scope.edgesByTarget.get(tKey) ?? []), edge])
  }
  return scope
}

export interface InterpreterOptions {
  vars: Record<string, unknown>
  assets: AssetRecord[]
  uiState: Record<string, unknown>
  emit: Emit
}

/**
 * 图解释器：蓝图式「控制流 + 数据流」混合执行。
 * - 控制流：沿 exec 边推进，节点返回下一个 exec 端口
 * - 数据流：数据引脚按需求值；纯节点递归求值并缓存，不纯节点读「最后一次执行的值」
 * - 子蓝图：`sub/<id>` 调用节点 → 作用域栈递归进入子图，入口/出口节点特判
 * - 可观测性：trace（节点）/ traceEdge（exec 连线流动）/ pinValue（端口实时值）
 * 纯 TS、无 DOM 依赖：Worker 与服务端可共用同一份代码。
 */
export class Interpreter {
  private scopes = new Map<string, Scope>()
  private scopeStack: Scope[] = []
  private lastOutputs = new Map<string, Record<string, unknown>>()
  private nodeState = new Map<string, Record<string, unknown>>()
  private pureCache = new Map<string, Record<string, unknown>>()
  private pureInProgress = new Set<string>()
  private vars: Record<string, unknown>
  private assets: AssetRecord[]
  private ui: Record<string, unknown>
  private emit: Emit
  private subgraphDefs: SubgraphDef[]
  private currentEvent: NodeEvent | undefined
  private rpcSeq = 0
  private rpcPending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  /** 子蓝图调用帧：参数与返回值 */
  private subStack: { args: Record<string, unknown>; returns: Record<string, unknown> }[] = []

  constructor(graph: SerializedGraph, subgraphs: SubgraphDef[], opts: InterpreterOptions) {
    this.vars = { ...opts.vars }
    this.assets = opts.assets
    this.ui = { ...opts.uiState }
    this.emit = opts.emit
    this.subgraphDefs = subgraphs
    this.scopes.set('main', indexGraph('main', graph))
    for (const sub of subgraphs) this.scopes.set(sub.id, indexGraph(sub.id, sub.graph))
    this.scopeStack = [this.scopes.get('main')!]
  }

  private get scope(): Scope {
    return this.scopeStack[this.scopeStack.length - 1]
  }

  private key(nodeId: string): string {
    return `${this.scope.graphId}:${nodeId}`
  }

  /** RPC 回执（由 Worker 胶水层转发） */
  resolveRpc(id: number, ok: boolean, result: unknown) {
    const pending = this.rpcPending.get(id)
    if (!pending) return
    this.rpcPending.delete(id)
    if (ok) pending.resolve(result)
    else pending.reject(new Error(String(result)))
  }

  /** UI 组件值变化（主线程镜像同步） */
  setUiState(values: Record<string, unknown>) {
    Object.assign(this.ui, values)
  }

  /** 触发某类事件节点（可按 nodeId 精确触发） */
  async runEvent(defId: string, payload?: Record<string, unknown>, nodeId?: string) {
    const scope = this.scopes.get('main')!
    const targets = nodeId
      ? [scope.nodesById.get(nodeId)].filter((n): n is SerializedNode => !!n && n.defId === defId)
      : [...scope.nodesById.values()].filter((n) => n.defId === defId)
    for (const node of targets) await this.fireNode('main', node.id, payload)
  }

  /** 日志源事件：只触发绑定了该源的「日志行」事件节点 */
  async runSourceEvent(sourceId: string, payload: Record<string, unknown>) {
    const scope = this.scopes.get('main')!
    for (const node of scope.nodesById.values()) {
      if (node.defId === 'event/onLogLine' && node.params?.source === sourceId) {
        await this.fireNode('main', node.id, { ...payload, sourceId })
      }
    }
  }

  /** UI 事件：按组件过滤并触发（uiClick / uiChange） */
  async runUIEvent(kind: 'uiClick' | 'uiChange', compId: string, value?: unknown) {
    const defId = kind === 'uiClick' ? 'event/uiClick' : 'event/uiChange'
    const scope = this.scopes.get('main')!
    for (const node of scope.nodesById.values()) {
      if (node.defId === defId && node.params?.component === compId) {
        await this.fireNode('main', node.id, { component: compId, value })
      }
    }
  }

  private async fireNode(graphId: string, eventNodeId: string, payload?: Record<string, unknown>) {
    this.pureCache.clear()
    this.currentEvent = payload as NodeEvent | undefined
    let current: string | undefined = eventNodeId
    let steps = 0
    while (current) {
      if (++steps > MAX_STEPS) {
        throw new Error(`执行超过 ${MAX_STEPS} 步已中止：检测到疑似死循环`)
      }
      const result = await this.executeNode(graphId, current)
      if (!result?.exec) break
      const next = this.nextOf(graphId, current, result.exec)
      current = next?.nodeId
    }
    this.currentEvent = undefined
  }

  private nextOf(graphId: string, source: string, portId: string) {
    const scope = this.scopes.get(graphId)!
    const edge = scope.edgesBySource.get(`${source}:${portId}`)?.[0]
    // result.exec 一定是 exec 端口，直接做连线流动高亮
    if (edge) this.emit({ type: 'traceEdge', graphId, edgeId: edge.id })
    return edge ? { nodeId: edge.target } : undefined
  }

  private ctxFor(node: SerializedNode): NodeCtx {
    const k = this.key(node.id)
    let state = this.nodeState.get(k)
    if (!state) {
      state = {}
      this.nodeState.set(k, state)
    }
    return {
      params: node.params ?? {},
      vars: this.vars,
      state,
      event: this.currentEvent,
      assets: this.assets,
      ui: this.ui,
      rpc: (method, args) => this.doRpc(method, args),
    }
  }

  private doRpc(method: string, args: unknown): Promise<unknown> {
    const id = ++this.rpcSeq
    return new Promise((resolve, reject) => {
      this.rpcPending.set(id, { resolve, reject })
      this.emit({ type: 'rpc', id, method, args })
      setTimeout(() => {
        if (this.rpcPending.has(id)) {
          this.rpcPending.delete(id)
          reject(new Error(`RPC 超时: ${method}`))
        }
      }, RPC_TIMEOUT_MS)
    })
  }

  private async executeNode(graphId: string, nodeId: string): Promise<RunResult | undefined> {
    const scope = this.scopes.get(graphId)!
    const node = scope.nodesById.get(nodeId)
    if (!node) throw new Error(`节点不存在: ${nodeId}`)
    const def = registryById[node.defId]

    // 子蓝图调用节点：不在静态注册表（sub/input、sub/output 是系统节点，走下方常规分支）
    if (!def && node.defId.startsWith('sub/')) {
      this.emit({ type: 'trace', graphId, nodeId })
      const inputPorts: PortDef[] = [
        { id: 'exec', label: '', type: 'exec' },
        ...(this.subById(node.defId.slice(4))?.params ?? []).map((p) => ({
          id: p.name,
          label: p.name,
          type: p.type as PortDef['type'],
        })),
      ]
      const inputs = await this.resolveInputs(graphId, node, inputPorts)
      const outputs = await this.runSubgraph(node.defId.slice(4), inputs)
      this.lastOutputs.set(`${graphId}:${nodeId}`, outputs)
      this.emitPins(graphId, node, inputs, outputs)
      return { exec: 'exec', outputs }
    }

    if (!def) throw new Error(`未知节点类型: ${node.defId}`)
    this.emit({ type: 'trace', graphId, nodeId })

    // 子图入口：直接返回调用方传入的参数（端口由子蓝图接口决定）
    if (node.defId === 'sub/input') {
      const frame = this.subStack[this.subStack.length - 1]
      const outputs = frame?.args ?? {}
      this.emitPins(graphId, node, {}, outputs)
      return { exec: 'exec', outputs }
    }

    // 子图出口：按子蓝图返回值定义解析输入，记录并结束当前链
    if (node.defId === 'sub/output') {
      const sub = this.subgraphDefs.find((s) => s.id === this.scope.graphId)
      const outPorts: PortDef[] = [
        { id: 'exec', label: '', type: 'exec' },
        ...(sub?.returns ?? []).map((p) => ({
          id: p.name,
          label: p.name,
          type: p.type as PortDef['type'],
        })),
      ]
      const inputs = await this.resolveInputs(graphId, node, outPorts)
      const frame = this.subStack[this.subStack.length - 1]
      if (frame) frame.returns = { ...inputs }
      this.emitPins(graphId, node, inputs, undefined)
      return {}
    }

    const inputs = await this.resolveInputs(graphId, node, def.inputs)

    const result = await def.run(inputs, this.ctxFor(node))
    if (result?.outputs) this.lastOutputs.set(`${graphId}:${nodeId}`, result.outputs)
    this.emitPins(graphId, node, inputs, result?.outputs)
    for (const fx of result?.fx ?? []) this.emit({ type: 'fx', fx })
    return result
  }

  private emitPins(
    graphId: string,
    node: SerializedNode,
    inputs: Record<string, unknown>,
    outputs?: Record<string, unknown>,
  ) {
    const def = registryById[node.defId]
    if (!def) return
    const trunc = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return s.length > PIN_VALUE_MAX ? `${s.slice(0, PIN_VALUE_MAX)}…` : s
    }
    for (const [k, v] of Object.entries(inputs)) {
      this.emit({ type: 'pinValue', graphId, nodeId: node.id, portId: k, portKind: 'in', value: trunc(v) })
    }
    for (const [k, v] of Object.entries(outputs ?? {})) {
      this.emit({ type: 'pinValue', graphId, nodeId: node.id, portId: k, portKind: 'out', value: trunc(v) })
    }
  }

  private async runSubgraph(subId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const subScope = this.scopes.get(subId)
    if (!subScope) throw new Error(`子蓝图不存在: ${subId}`)
    const inputNode = [...subScope.nodesById.values()].find((n) => n.defId === 'sub/input')
    if (!inputNode) throw new Error(`子蓝图缺少入口节点: ${subId}`)
    const frame = { args, returns: {} }
    this.subStack.push(frame)
    this.scopeStack.push(subScope)
    try {
      await this.fireNode(subId, inputNode.id)
    } finally {
      this.scopeStack.pop()
      this.subStack.pop()
    }
    return frame.returns
  }

  private subById(subId: string): SubgraphDef | undefined {
    return this.subgraphDefs.find((s) => s.id === subId)
  }

  private async resolveInputs(
    graphId: string,
    node: SerializedNode,
    ports: PortDef[],
  ): Promise<Record<string, unknown>> {
    const scope = this.scopes.get(graphId)!
    const inputs: Record<string, unknown> = {}
    for (const port of ports) {
      if (port.type === 'exec') continue
      const edge = scope.edgesByTarget.get(`${node.id}:${port.id}`)?.[0]
      inputs[port.id] = edge
        ? await this.readPortValue(graphId, edge.source, edge.sourcePort, port.type, port.label)
        : undefined
    }
    return inputs
  }

  private async readPortValue(
    graphId: string,
    sourceId: string,
    sourcePortId: string,
    expected: PortDef['type'],
    consumerLabel: string,
  ): Promise<unknown> {
    const scope = this.scopes.get(graphId)!
    const sourceNode = scope.nodesById.get(sourceId)
    if (!sourceNode) throw new Error(`连线指向不存在的节点: ${sourceId}`)

    // 子图入口作为数据源：直接读调用帧参数（端口由接口动态决定）
    if (sourceNode.defId === 'sub/input') {
      const frame = this.subStack[this.subStack.length - 1]
      return frame?.args?.[sourcePortId]
    }

    let sourceDef = registryById[sourceNode.defId]
    if (!sourceDef && sourceNode.defId.startsWith('sub/')) {
      // 子蓝图调用节点作为数据源：输出端口 = 返回值定义
      const sub = this.subgraphDefs.find((s) => s.id === sourceNode.defId.slice(4))
      if (sub) {
        sourceDef = {
          id: sourceNode.defId,
          alias: '',
          title: sub.name,
          category: 'subgraph',
          description: '',
          inputs: [],
          outputs: [
            { id: 'exec', label: '', type: 'exec' },
            ...sub.returns.map((p) => ({
              id: p.name,
              label: p.name,
              type: p.type as PortDef['type'],
            })),
          ],
          run: () => ({}),
        }
      }
    }
    const outPort = sourceDef?.outputs.find((p) => p.id === sourcePortId)
    if (!outPort) throw new Error(`找不到输出端口: ${sourceNode.defId}.${sourcePortId}`)
    const compatible =
      outPort.type === expected ||
      outPort.type === 'any' ||
      expected === 'any' ||
      (outPort.type === 'number' && expected === 'string')
    if (!compatible) {
      throw new Error(
        `类型不匹配：${sourceDef!.title}.${outPort.label}(${outPort.type}) → ${consumerLabel}(${expected})`,
      )
    }
    let value: unknown
    if (sourceNode.defId === 'sub/input') {
      const frame = this.subStack[this.subStack.length - 1]
      value = frame?.args?.[sourcePortId]
    } else if (sourceDef!.pure) {
      value = (await this.evaluatePure(graphId, sourceNode))[sourcePortId]
    } else {
      value = this.lastOutputs.get(`${graphId}:${sourceId}`)?.[sourcePortId]
    }
    if (outPort.type === 'any' || expected === 'any') {
      if (expected === 'number') value = Number(value) || 0
      else if (expected === 'boolean') value = Boolean(value)
      else if (expected === 'string') value = value == null ? '' : String(value)
    } else if (outPort.type === 'number' && expected === 'string') {
      value = String(value)
    }
    return value
  }

  private async evaluatePure(
    graphId: string,
    node: SerializedNode,
  ): Promise<Record<string, unknown>> {
    const k = `${graphId}:${node.id}`
    const cached = this.pureCache.get(k)
    if (cached) return cached
    if (this.pureInProgress.has(k)) {
      throw new Error(`纯节点求值存在循环依赖: ${node.defId}`)
    }
    this.pureInProgress.add(k)
    try {
      const def = registryById[node.defId]!
      const inputs = await this.resolveInputs(graphId, node, def.inputs)
      const result = await def.run(inputs, this.ctxFor(node))
      const outputs = result?.outputs ?? {}
      this.pureCache.set(k, outputs)
      return outputs
    } finally {
      this.pureInProgress.delete(k)
    }
  }
}
