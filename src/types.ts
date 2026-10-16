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
  | 'ui'
  | 'subgraph'
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
  | 'uicomponent'

export type PortDef = { id: string; label: string; type: PortType }

export type ParamDef = {
  key: string
  label: string
  valueType: ParamType
  default?: unknown
  options?: { value: string; label: string }[]
  variableType?: 'string' | 'number' | 'boolean'
  /** uicomponent 参数可选的组件类型 */
  componentKinds?: UIComponentKind[]
}

export type Fx =
  | { kind: 'print'; value: string }
  | { kind: 'ui'; compId: string; op: 'set' | 'listAdd' | 'clear'; value?: unknown; row?: unknown }

export type RunResult = {
  /** 执行完成后沿哪个 exec 输出端口继续（未设置则结束该链） */
  exec?: string
  fx?: Fx[]
  outputs?: Record<string, unknown>
}

export type NodeEvent = {
  line?: string
  ts?: string
  sourceId?: string
  component?: string
  value?: unknown
}

export type AssetRecord = {
  name: string
  size: number
  ext: string
  updatedAt: number
}

export type NodeCtx = {
  params: Record<string, unknown>
  vars: Record<string, unknown>
  state: Record<string, unknown>
  event?: NodeEvent
  assets: AssetRecord[]
  /** UI 组件值的运行时镜像（输入框内容 / 选择器选中项…） */
  ui: Record<string, unknown>
  rpc(method: string, args: unknown): Promise<unknown>
}

export type NodeRunFn = (
  inputs: Record<string, unknown>,
  ctx: NodeCtx,
) => RunResult | Promise<RunResult>

export type NodeDef = {
  id: string
  alias: string
  title: string
  category: NodeCategory
  description: string
  /** 纯节点：没有 exec 端口，输出在被需要时才求值（带缓存） */
  pure?: boolean
  inputs: PortDef[]
  outputs: PortDef[]
  params?: ParamDef[]
  run: NodeRunFn
}

// ────────── UI 编辑器（类 UGUI / 预制体） ──────────

export type UIComponentKind =
  | 'vbox'
  | 'hbox'
  | 'panel'
  | 'text'
  | 'heading'
  | 'markdown'
  | 'input'
  | 'select'
  | 'button'
  | 'switch'
  | 'list'
  | 'textarea'
  | 'divider'

export type UIListColumn = {
  key: string
  label: string
  /** 值→颜色（每行 值=颜色），如 INFO=#3fc1a9 */
  colorMap?: string
  /** 值变化时新起一个可折叠分组（如会话） */
  group?: boolean
  /** 连续相同值合并成一条并计数（如高频日志） */
  merge?: boolean
}

export type UIComponent = {
  id: string
  kind: UIComponentKind
  name?: string
  props: Record<string, unknown>
  children?: UIComponent[]
}

export type UIComponentMeta = {
  kind: UIComponentKind
  title: string
  isContainer: boolean
  /** 组件是否有运行时值（可被蓝图读写） */
  hasValue: boolean
}

export const UI_COMPONENT_META: Record<UIComponentKind, UIComponentMeta> = {
  vbox: { kind: 'vbox', title: '垂直容器', isContainer: true, hasValue: false },
  hbox: { kind: 'hbox', title: '水平容器', isContainer: true, hasValue: false },
  panel: { kind: 'panel', title: '面板', isContainer: true, hasValue: false },
  text: { kind: 'text', title: '文本', isContainer: false, hasValue: true },
  heading: { kind: 'heading', title: '标题', isContainer: false, hasValue: false },
  markdown: { kind: 'markdown', title: 'Markdown', isContainer: false, hasValue: true },
  input: { kind: 'input', title: '输入框', isContainer: false, hasValue: true },
  select: { kind: 'select', title: '选择器', isContainer: false, hasValue: true },
  button: { kind: 'button', title: '按钮', isContainer: false, hasValue: false },
  switch: { kind: 'switch', title: '开关', isContainer: false, hasValue: true },
  list: { kind: 'list', title: '列表', isContainer: false, hasValue: true },
  textarea: { kind: 'textarea', title: '多行文本', isContainer: false, hasValue: true },
  divider: { kind: 'divider', title: '分割线', isContainer: false, hasValue: false },
}

// ────────── 图 / 子蓝图 ──────────

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

export type SubgraphPort = { name: string; type: 'string' | 'number' | 'boolean' }

export type SubgraphDef = {
  id: string
  name: string
  params: SubgraphPort[]
  returns: SubgraphPort[]
  graph: SerializedGraph
}

export type PluginRecord = {
  id: string
  middlewareId: string
  name: string
  graph: SerializedGraph
  subgraphs: SubgraphDef[]
  ui: UIComponent
  vars: VariableDef[]
  updatedAt: number
}

// ────────── Worker 协议 ──────────

/** Worker → 主线程 */
export type EngineToUI =
  | { type: 'ready' }
  | { type: 'trace'; graphId: string; nodeId: string }
  | { type: 'traceEdge'; graphId: string; edgeId: string }
  | {
      type: 'pinValue'
      graphId: string
      nodeId: string
      portId: string
      portKind: 'in' | 'out'
      value: string
    }
  | { type: 'fx'; fx: Fx }
  | { type: 'error'; message: string }
  | { type: 'rpc'; id: number; method: string; args: unknown }

/** 主线程 → Worker */
export type UIToEngine =
  | {
      type: 'load'
      graph: SerializedGraph
      subgraphs: SubgraphDef[]
      vars: Record<string, unknown>
      assets: AssetRecord[]
      uiState: Record<string, unknown>
      autoRun?: boolean
    }
  | {
      type: 'run'
      eventDefId: string
      nodeId?: string
      sourceId?: string
      payload?: Record<string, unknown>
    }
  | { type: 'uiState'; values: Record<string, unknown> }
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

/** React Flow 节点 / 边的数据负载（type alias 以满足泛型约束） */
export type BlueprintNodeData = {
  defId: string
  params: Record<string, unknown>
}

export type FlowEdgeData = {
  portType: PortType
}
