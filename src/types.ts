export type PortType = 'exec' | 'any' | 'boolean' | 'number' | 'string'
export type NodeCategory =
  | 'event'
  | 'source'
  | 'logic'
  | 'transform'
  | 'data'
  | 'variable'
  | 'asset'
  | 'report'
  | 'output'
  | 'action'

export type ParamType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'text'
  | 'select'
  | 'variable'
  | 'asset'
  | 'source'
  | 'map'

export type PortDef = { id: string; label: string; type: PortType }

export type ParamDef = {
  key: string
  label: string
  valueType: ParamType
  default?: unknown
  options?: { value: string; label: string }[]
  variableType?: 'string' | 'number' | 'boolean'
}

export type Fx =
  | { kind: 'print'; value: string }
  | { kind: 'widget'; widgetId: string; op: string; payload: Record<string, unknown> }

export type RunResult = {
  /** 执行完成后沿哪个 exec 输出端口继续（未设置则结束该链） */
  exec?: string
  /** 副作用：打印 / 更新运行时小组件 */
  fx?: Fx[]
  /** 数据输出端口的值 */
  outputs?: Record<string, unknown>
}

export type NodeEvent = {
  line?: string
  ts?: string
  sourceId?: string
}

export type AssetRecord = {
  name: string
  size: number
  ext: string
  updatedAt: number
}

export type NodeCtx = {
  params: Record<string, unknown>
  /** 蓝图变量（运行时可在图内被 var/set 修改） */
  vars: Record<string, unknown>
  /** 节点私有状态（跨事件保留，如计数器） */
  state: Record<string, unknown>
  /** 触发本次执行的事件数据（如日志行） */
  event?: NodeEvent
  /** 后端资产清单快照 */
  assets: AssetRecord[]
  /** 经主线程转发到后端的 RPC（类似 UE5 的 OnlineSubsystem） */
  rpc(method: string, args: unknown): Promise<unknown>
}

export type NodeRunFn = (
  inputs: Record<string, unknown>,
  ctx: NodeCtx,
) => RunResult | Promise<RunResult>

export type WidgetKind = 'logTree' | 'markdown' | 'flow'

export type NodeDef = {
  id: string
  /** 脚本 DSL 中的别名（蓝图⇄脚本互转用） */
  alias: string
  title: string
  category: NodeCategory
  description: string
  /** 纯节点：没有 exec 端口，输出在被需要时才求值（带缓存） */
  pure?: boolean
  /** 输出类节点对应的运行时小组件类型 */
  widgetKind?: WidgetKind
  inputs: PortDef[]
  outputs: PortDef[]
  params?: ParamDef[]
  run: NodeRunFn
}

export type SerializedNode = {
  id: string
  defId: string
  position: { x: number; y: number }
  params: Record<string, unknown>
}

export type SerializedEdge = {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export type SerializedGraph = {
  nodes: SerializedNode[]
  edges: SerializedEdge[]
}

/** Worker → 主线程 */
export type EngineToUI =
  | { type: 'ready' }
  | { type: 'trace'; nodeId: string }
  | { type: 'fx'; fx: Fx }
  | { type: 'error'; message: string }
  | { type: 'rpc'; id: number; method: string; args: unknown }

/** 主线程 → Worker */
export type UIToEngine =
  | {
      type: 'load'
      graph: SerializedGraph
      vars: Record<string, unknown>
      assets: AssetRecord[]
      autoRun?: boolean
    }
  | {
      type: 'run'
      eventDefId: string
      nodeId?: string
      sourceId?: string
      payload?: Record<string, unknown>
    }
  | { type: 'rpcResult'; id: number; ok: boolean; result: unknown }

export type VariableDef = {
  name: string
  type: 'string' | 'number' | 'boolean'
  default: unknown
}

export type Middleware = {
  id: string
  name: string
  createdAt: number
}

export type PluginRecord = {
  id: string
  middlewareId: string
  name: string
  graph: SerializedGraph
  vars: VariableDef[]
  updatedAt: number
}

/** React Flow 节点 / 边的数据负载（type alias 以满足泛型约束） */
export type BlueprintNodeData = {
  defId: string
  params: Record<string, unknown>
}

export type FlowEdgeData = {
  portType: PortType
}

export function widgetIdOf(kind: WidgetKind, title: unknown): string {
  return `${kind}:${String(title ?? '').trim() || '默认'}`
}
