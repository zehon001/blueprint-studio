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
} from '../types'

/** 防御死循环：单次事件触发允许的最大执行步数 */
const MAX_STEPS = 5000
/** RPC 超时 */
const RPC_TIMEOUT_MS = 15000

type Emit = (message: EngineToUI) => void

export interface InterpreterOptions {
  vars: Record<string, unknown>
  assets: AssetRecord[]
  emit: Emit
}

/**
 * 图解释器：蓝图式「控制流 + 数据流」混合执行。
 * - 控制流：沿 exec 边推进，节点返回下一个 exec 端口
 * - 数据流：数据引脚按需求值；纯节点递归求值并缓存，
 *   不纯节点读取其「最后一次执行」的输出值（蓝图同款语义）
 * - 节点可异步（延时 / 后端 RPC），事件之间串行排队保证日志顺序
 * 纯 TS、无 DOM 依赖：Worker 与服务端可共用同一份代码。
 */
export class Interpreter {
  private nodesById = new Map<string, SerializedNode>()
  private edgesBySource = new Map<string, SerializedEdge[]>()
  private edgesByTarget = new Map<string, SerializedEdge[]>()
  private lastOutputs = new Map<string, Record<string, unknown>>()
  private pureCache = new Map<string, Record<string, unknown>>()
  private pureInProgress = new Set<string>()
  private nodeState = new Map<string, Record<string, unknown>>()
  private vars: Record<string, unknown>
  private assets: AssetRecord[]
  private emit: Emit
  private currentEvent: NodeEvent | undefined
  private rpcSeq = 0
  private rpcPending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()

  constructor(graph: SerializedGraph, opts: InterpreterOptions) {
    this.vars = { ...opts.vars }
    this.assets = opts.assets
    this.emit = opts.emit
    for (const node of graph.nodes) this.nodesById.set(node.id, node)
    for (const edge of graph.edges) {
      const sKey = `${edge.source}:${edge.sourcePort}`
      const tKey = `${edge.target}:${edge.targetPort}`
      this.edgesBySource.set(sKey, [...(this.edgesBySource.get(sKey) ?? []), edge])
      this.edgesByTarget.set(tKey, [...(this.edgesByTarget.get(tKey) ?? []), edge])
    }
  }

  /** RPC 回执（由 Worker 胶水层转发） */
  resolveRpc(id: number, ok: boolean, result: unknown) {
    const pending = this.rpcPending.get(id)
    if (!pending) return
    this.rpcPending.delete(id)
    if (ok) pending.resolve(result)
    else pending.reject(new Error(String(result)))
  }

  /** 触发某类事件节点（可指定 nodeId 只触发该节点，如 onTick） */
  async runEvent(defId: string, payload?: Record<string, unknown>, nodeId?: string) {
    const targets = nodeId
      ? [this.nodesById.get(nodeId)].filter((n): n is SerializedNode => !!n && n.defId === defId)
      : [...this.nodesById.values()].filter((n) => n.defId === defId)
    for (const node of targets) await this.fireNode(node.id, payload)
  }

  /** 日志源事件：只触发绑定了该源的「日志行」事件节点 */
  async runSourceEvent(sourceId: string, payload: Record<string, unknown>) {
    for (const node of this.nodesById.values()) {
      if (node.defId === 'event/onLogLine' && node.params?.source === sourceId) {
        await this.fireNode(node.id, { ...payload, sourceId })
      }
    }
  }

  private async fireNode(eventNodeId: string, payload?: Record<string, unknown>) {
    this.pureCache.clear()
    this.currentEvent = payload as NodeEvent | undefined
    let current: string | undefined = eventNodeId
    let steps = 0
    while (current) {
      if (++steps > MAX_STEPS) {
        throw new Error(`执行超过 ${MAX_STEPS} 步已中止：检测到疑似死循环`)
      }
      const result = await this.executeNode(current)
      current = result?.exec ? this.nextNodeId(current, result.exec) : undefined
    }
    this.currentEvent = undefined
  }

  private ctxFor(node: SerializedNode): NodeCtx {
    let state = this.nodeState.get(node.id)
    if (!state) {
      state = {}
      this.nodeState.set(node.id, state)
    }
    return {
      params: node.params ?? {},
      vars: this.vars,
      state,
      event: this.currentEvent,
      assets: this.assets,
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

  private async executeNode(nodeId: string): Promise<RunResult | undefined> {
    const node = this.nodesById.get(nodeId)
    if (!node) throw new Error(`节点不存在: ${nodeId}`)
    const def = registryById[node.defId]
    if (!def) throw new Error(`未知节点类型: ${node.defId}`)
    this.emit({ type: 'trace', nodeId })
    const inputs = await this.resolveInputs(node, def.inputs)
    const result = await def.run(inputs, this.ctxFor(node))
    if (result?.outputs) this.lastOutputs.set(nodeId, result.outputs)
    for (const fx of result?.fx ?? []) this.emit({ type: 'fx', fx })
    return result
  }

  private nextNodeId(source: string, portId: string): string | undefined {
    return this.edgesBySource.get(`${source}:${portId}`)?.[0]?.target
  }

  private async resolveInputs(node: SerializedNode, ports: PortDef[]) {
    const inputs: Record<string, unknown> = {}
    for (const port of ports) {
      if (port.type === 'exec') continue
      const edge = this.edgesByTarget.get(`${node.id}:${port.id}`)?.[0]
      inputs[port.id] = edge
        ? await this.readPortValue(edge.source, edge.sourcePort, port.type, port.label)
        : undefined
    }
    return inputs
  }

  private async readPortValue(
    sourceId: string,
    sourcePortId: string,
    expected: PortDef['type'],
    consumerLabel: string,
  ): Promise<unknown> {
    const sourceNode = this.nodesById.get(sourceId)
    if (!sourceNode) throw new Error(`连线指向不存在的节点: ${sourceId}`)
    const sourceDef = registryById[sourceNode.defId]
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
    if (sourceDef!.pure) {
      value = (await this.evaluatePure(sourceNode))[sourcePortId]
    } else {
      value = this.lastOutputs.get(sourceId)?.[sourcePortId]
    }
    // 隐式转换 / any 装载
    if (outPort.type === 'any' || expected === 'any') {
      if (expected === 'number') value = Number(value) || 0
      else if (expected === 'boolean') value = Boolean(value)
      else if (expected === 'string') value = value == null ? '' : String(value)
    } else if (outPort.type === 'number' && expected === 'string') {
      value = String(value)
    }
    return value
  }

  private async evaluatePure(node: SerializedNode): Promise<Record<string, unknown>> {
    const cached = this.pureCache.get(node.id)
    if (cached) return cached
    if (this.pureInProgress.has(node.id)) {
      throw new Error(`纯节点求值存在循环依赖: ${node.defId}`)
    }
    this.pureInProgress.add(node.id)
    try {
      const def = registryById[node.defId]!
      const inputs = await this.resolveInputs(node, def.inputs)
      const result = await def.run(inputs, this.ctxFor(node))
      const outputs = result?.outputs ?? {}
      this.pureCache.set(node.id, outputs)
      return outputs
    } finally {
      this.pureInProgress.delete(node.id)
    }
  }
}
