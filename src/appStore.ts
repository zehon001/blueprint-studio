import { create } from 'zustand'
import { makeSubgraphNodeDef, registryById } from './nodeRegistry'
import {
  deleteMiddlewareById,
  deletePluginById,
  listMiddlewares,
  listPlugins,
  putMiddleware,
  putPlugin,
} from './persistence'
import { buildPlugin, type TemplateId } from './templates'
import { sanitizeGraph, useGraphStore } from './store'
import { wsClient } from './wsClient'
import type {
  AssetRecord,
  EngineToUI,
  Middleware,
  PluginRecord,
  SerializedGraph,
  UIComponent,
} from './types'

let logSeq = 0
let bootstrapped = false
let engineWorker: Worker | null = null
let tickIntervals: number[] = []
let runId: string | null = null
let pinBuffer: Record<string, string> = {}
let pinFlushTimer: number | null = null

export type LogKind = 'print' | 'error' | 'system'
type LogEntry = { id: number; time: string; kind: LogKind; text: string }

/** 从 UI 文档推导各组件的初始运行时值 */
function initialUiState(ui: UIComponent | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!ui) return out
  const visit = (c: UIComponent) => {
    switch (c.kind) {
      case 'text':
      case 'markdown':
        out[c.id] = String(c.props.text ?? '')
        break
      case 'input':
      case 'textarea':
        out[c.id] = ''
        break
      case 'select': {
        const first = String(c.props.options ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)[0]
        out[c.id] = first ?? ''
        break
      }
      case 'switch':
        out[c.id] = false
        break
      case 'list':
        out[c.id] = []
        break
      default:
        break
    }
    for (const child of c.children ?? []) visit(child)
  }
  visit(ui)
  return out
}

/** 旧版本插件（widget 输出节点 / 无 UI 文档）自动迁移到新模板 */
function migratePlugin(p: PluginRecord): PluginRecord {
  const usesLegacyWidgets = p.graph.nodes.some((n) => n.defId.startsWith('output/'))
  const missingUi = !p.ui
  if (!usesLegacyWidgets && !missingUi && p.subgraphs) return p
  const template: TemplateId =
    p.name.includes('日志') ? 'logviewer' : p.name.includes('报表') ? 'report' : 'blank'
  return { ...buildPlugin(p.id, p.middlewareId, p.name, template), updatedAt: p.updatedAt }
}

interface AppStore {
  screen: 'home' | 'editor'
  middlewares: Middleware[]
  plugins: PluginRecord[]
  activePluginId: string | null
  assets: AssetRecord[]
  wsStatus: 'online' | 'offline'
  logs: LogEntry[]
  runtime: {
    running: boolean
    pluginName: string
    ui: UIComponent | null
    uiState: Record<string, unknown>
  }

  bootstrap(): Promise<void>
  addMiddleware(name: string): Promise<void>
  removeMiddleware(id: string): Promise<void>
  createPlugin(middlewareId: string, name: string, templateId: TemplateId): Promise<void>
  deletePlugin(id: string): Promise<void>
  openPlugin(id: string): void
  goHome(): void

  refreshAssets(): Promise<void>
  uploadAsset(name: string, base64: string): Promise<{ ok: boolean; message: string }>

  log(kind: LogKind, text: string): void
  clearLogs(): void

  startRuntime(): void
  stopRuntime(): void
  closeRuntime(): void
  rerunRuntime(): void
  /** 运行中的 UI 交互（输入/切换/点击），由 RuntimeView 调用 */
  onUIInput(compId: string, value: unknown): void
  onUIClick(compId: string): void
  handleServerMessage(msg: unknown): void
}

export const useAppStore = create<AppStore>()((set, get) => ({
  screen: 'home',
  middlewares: [],
  plugins: [],
  activePluginId: null,
  assets: [],
  wsStatus: 'offline',
  logs: [],
  runtime: { running: false, pluginName: '', ui: null, uiState: {} },

  bootstrap: async () => {
    if (bootstrapped) return
    bootstrapped = true
    wsClient.handlers = {
      onMessage: (msg) => get().handleServerMessage(msg),
      onStatus: (status) => {
        set({ wsStatus: status })
        if (status === 'offline' && get().runtime.running) {
          get().stopRuntime()
          get().log('error', '与后端的连接断开，运行已停止')
        }
      },
    }
    wsClient.connect()

    let middlewares: Middleware[] = []
    let plugins: PluginRecord[] = []
    try {
      ;[middlewares, plugins] = await Promise.all([listMiddlewares(), listPlugins()])
    } catch {
      get().log('error', '本地数据库不可用（隐私模式？），插件将无法保存')
    }

    if (middlewares.length === 0) {
      const dolphin: Middleware = {
        id: 'mw-dolphin',
        name: 'Dolphin 轮唱SDK',
        createdAt: Date.now(),
      }
      try {
        await putMiddleware(dolphin)
        middlewares = [dolphin]
      } catch {
        // 写入失败则保持空列表
      }
    }

    if (plugins.length === 0 && middlewares.length > 0) {
      // 首次启动 / 插件被清空：种子示例插件（类似 UE5 的示例项目）
      const mwId = middlewares[0].id
      const logviewer = buildPlugin('pl-logviewer', mwId, '日志查看器', 'logviewer')
      const report = buildPlugin('pl-report', mwId, '错误报表', 'report')
      try {
        await Promise.all([putPlugin(logviewer), putPlugin(report)])
        plugins = [logviewer, report]
      } catch {
        // 种子失败则保持空列表
      }
    } else {
      // 旧版本插件迁移
      const migrated = plugins.map(migratePlugin)
      const changed = migrated.some((p, i) => p !== plugins[i])
      if (changed) {
        plugins = migrated
        await Promise.all(migrated.map((p) => putPlugin(p)))
        get().log('system', '已把旧版插件升级到 UI 编辑器版本')
      }
    }

    set({ middlewares, plugins })
    await get().refreshAssets()
    get().log('system', `引擎就绪：${middlewares.length} 个中间件 · ${plugins.length} 个插件`)
  },

  addMiddleware: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const mw: Middleware = {
      id: `mw-${crypto.randomUUID().slice(0, 8)}`,
      name: trimmed,
      createdAt: Date.now(),
    }
    await putMiddleware(mw)
    set((s) => ({ middlewares: [...s.middlewares, mw] }))
    get().log('system', `已添加中间件「${trimmed}」`)
  },

  removeMiddleware: async (id) => {
    const mw = get().middlewares.find((m) => m.id === id)
    if (!mw) return
    const pluginIds = get().plugins.filter((p) => p.middlewareId === id).map((p) => p.id)
    await deleteMiddlewareById(id)
    await Promise.all(pluginIds.map((pid) => deletePluginById(pid)))
    set((s) => ({
      middlewares: s.middlewares.filter((m) => m.id !== id),
      plugins: s.plugins.filter((p) => p.middlewareId !== id),
    }))
    get().log('system', `已删除中间件「${mw.name}」及其 ${pluginIds.length} 个插件`)
  },

  createPlugin: async (middlewareId, name, templateId) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = `pl-${crypto.randomUUID().slice(0, 8)}`
    const plugin = buildPlugin(id, middlewareId, trimmed, templateId)
    await putPlugin(plugin)
    set((s) => ({ plugins: [plugin, ...s.plugins] }))
    get().log('system', `已创建插件「${trimmed}」`)
  },

  deletePlugin: async (id) => {
    await deletePluginById(id)
    if (get().activePluginId === id) {
      set({ activePluginId: null, screen: 'home' })
    }
    set((s) => ({ plugins: s.plugins.filter((p) => p.id !== id) }))
    get().log('system', '插件已删除')
  },

  openPlugin: (id) => {
    const plugin = get().plugins.find((p) => p.id === id)
    if (!plugin) return
    useGraphStore.getState().bindPlugin(plugin)
    set({ screen: 'editor', activePluginId: id })
  },

  goHome: () => {
    if (get().runtime.running) get().stopRuntime()
    set({ screen: 'home', activePluginId: null })
  },

  refreshAssets: async () => {
    try {
      const res = await fetch('/api/manifest')
      if (!res.ok) throw new Error(String(res.status))
      const assets = (await res.json()) as AssetRecord[]
      set({ assets })
    } catch {
      // 后端未启动时保持空清单
    }
  },

  uploadAsset: async (name, base64) => {
    try {
      const res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, contentBase64: base64 }),
      })
      const data = (await res.json()) as { ok?: boolean; message?: string }
      await get().refreshAssets()
      return { ok: Boolean(data.ok), message: data.message ?? '' }
    } catch {
      return { ok: false, message: '上传失败：后端不可达' }
    }
  },

  log: (kind, text) =>
    set((s) => ({
      logs: [
        ...s.logs,
        {
          id: ++logSeq,
          time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          kind,
          text,
        },
      ].slice(-300),
    })),

  clearLogs: () => set({ logs: [] }),

  startRuntime: () => {
    const plugin = get().plugins.find((p) => p.id === get().activePluginId)
    if (!plugin) return
    if (get().runtime.running) get().stopRuntime()

    const graphStore = useGraphStore.getState()
    const isEditingThis = graphStore.working?.meta.id === plugin.id && get().screen === 'editor'
    // 编辑中的图可能未保存：强制写回并组装最新快照
    let graph: SerializedGraph = plugin.graph
    let subgraphs = plugin.subgraphs
    let ui: UIComponent = plugin.ui
    let vars = plugin.vars
    if (isEditingThis) {
      graphStore.markDirty()
      const w = graphStore.working
      if (w) {
        // markDirty 是防抖的，这里手动同步当前画布
        const current = graphStore.nodes
        const edges = graphStore.edges
        const serialize = (ns: typeof current, es: typeof edges) => ({
          nodes: ns.map((n) => ({
            id: n.id,
            defId: n.data.defId,
            position: { x: n.position.x, y: n.position.y },
            params: { ...n.data.params },
          })),
          edges: es.map((e) => ({
            id: e.id,
            source: e.source,
            sourcePort: e.sourceHandle ?? '',
            target: e.target,
            targetPort: e.targetHandle ?? '',
          })),
        })
        const active = graphStore.activeGraphId
        if (active === 'main') w.graph = serialize(current, edges)
        else {
          const sub = w.subgraphs.find((s) => s.id === active)
          if (sub) sub.graph = serialize(current, edges)
        }
        graph = w.graph
        subgraphs = w.subgraphs
        ui = w.ui
        vars = w.vars
      }
    }

    const varsRecord: Record<string, unknown> = {}
    for (const v of vars) varsRecord[v.name] = v.default
    const uiState = initialUiState(ui)

    // 净化：丢弃引用不存在节点/端口的连线（旧数据兼容）
    const resolveDef = (defId: string) => {
      const staticDef = registryById[defId]
      if (staticDef) return staticDef
      const sub = subgraphs.find((s) => `sub/${s.id}` === defId)
      return sub ? makeSubgraphNodeDef(sub) : undefined
    }
    graph = sanitizeGraph(graph, resolveDef)

    const worker = new Worker(new URL('./engine/engine.worker.ts', import.meta.url), {
      type: 'module',
    })
    engineWorker = worker
    const rid = `run-${crypto.randomUUID().slice(0, 8)}`
    runId = rid
    worker.onerror = (err) => get().log('error', `引擎错误: ${err.message ?? '未知错误'}`)
    worker.onmessage = (ev: MessageEvent<EngineToUI>) => {
      const msg = ev.data
      if (msg.type === 'fx') {
        const fx = msg.fx
        if (fx.kind === 'print') {
          get().log('print', fx.value)
        } else {
          const { compId, op, value, row } = fx
          set((s) => {
            const state = { ...s.runtime.uiState }
            if (op === 'set') state[compId] = value
            else if (op === 'clear') state[compId] = []
            else if (op === 'listAdd') {
              const rows = Array.isArray(state[compId]) ? [...(state[compId] as unknown[])] : []
              rows.push(row)
              state[compId] = rows
            }
            return { runtime: { ...s.runtime, uiState: state } }
          })
        }
      } else if (msg.type === 'trace') {
        useGraphStore.getState().flashNode(msg.graphId, msg.nodeId)
      } else if (msg.type === 'traceEdge') {
        useGraphStore.getState().flashEdge(msg.graphId, msg.edgeId)
      } else if (msg.type === 'pinValue') {
        // 高频消息：缓冲后批量刷新，避免渲染风暴
        pinBuffer[`${msg.graphId}:${msg.nodeId}:${msg.portId}`] =
          `${msg.portKind === 'in' ? '→ ' : '← '}${msg.value}`
        if (pinFlushTimer === null) {
          pinFlushTimer = window.setTimeout(() => {
            pinFlushTimer = null
            const batch = pinBuffer
            pinBuffer = {}
            useGraphStore.getState().setPinValues(batch)
          }, 150)
        }
      } else if (msg.type === 'ready') {
        get().log('system', '执行引擎已就绪（Web Worker）')
      } else if (msg.type === 'error') {
        get().log('error', msg.message)
      } else if (msg.type === 'rpc') {
        const sent = wsClient.send({
          type: 'rpc',
          id: msg.id,
          method: msg.method,
          args: msg.args,
        })
        if (!sent) {
          worker.postMessage({ type: 'rpcResult', id: msg.id, ok: false, result: '后端未连接' })
        }
      }
    }
    worker.postMessage({
      type: 'load',
      graph,
      subgraphs,
      vars: varsRecord,
      assets: get().assets,
      uiState,
      autoRun: true,
    })

    // 定时事件（onTick）
    for (const n of graph.nodes.filter((x) => x.defId === 'event/onTick')) {
      const ms = Math.max(100, Number(n.params?.intervalMs) || 1000)
      tickIntervals.push(
        window.setInterval(() => {
          engineWorker?.postMessage({ type: 'run', eventDefId: 'event/onTick', nodeId: n.id })
        }, ms),
      )
    }

    // 被事件节点引用的日志源 → 后端启动适配器
    const sources: { id: string; kind: string; params: Record<string, unknown> }[] = []
    for (const n of graph.nodes.filter((x) => x.defId === 'event/onLogLine')) {
      const srcNode = graph.nodes.find((x) => x.id === n.params?.source)
      const srcDef = srcNode ? registryById[srcNode.defId] : undefined
      if (!srcNode || !srcDef) continue
      const params: Record<string, unknown> = {}
      for (const p of srcDef.params ?? []) {
        let v = srcNode.params?.[p.key] ?? p.default
        if (p.valueType === 'variable') v = varsRecord[String(v)] ?? ''
        params[p.key] = v
      }
      sources.push({ id: srcNode.id, kind: srcDef.id.split('/')[1], params })
    }
    wsClient.send({ type: 'plugin.run', runId: rid, sources })

    set({ runtime: { running: true, pluginName: plugin.name, ui, uiState } })
    get().log('system', `▶ 开始运行「${plugin.name}」（${sources.length} 个日志源）`)
  },

  stopRuntime: () => {
    for (const t of tickIntervals) window.clearInterval(t)
    tickIntervals = []
    if (pinFlushTimer !== null) {
      window.clearTimeout(pinFlushTimer)
      pinFlushTimer = null
    }
    pinBuffer = {}
    engineWorker?.terminate()
    engineWorker = null
    if (runId) wsClient.send({ type: 'plugin.stop', runId })
    runId = null
    useGraphStore.setState({ flash: {}, edgeFlash: {}, pinValues: {} })
    set((s) => ({ runtime: { ...s.runtime, running: false } }))
    get().log('system', '⏹ 已停止')
  },

  closeRuntime: () => {
    get().stopRuntime()
    set((s) => ({ runtime: { ...s.runtime, ui: null, uiState: {} } }))
  },

  rerunRuntime: () => {
    get().stopRuntime()
    window.setTimeout(() => get().startRuntime(), 150)
  },

  onUIInput: (compId, value) => {
    if (!get().runtime.running || !engineWorker) return
    set((s) => ({
      runtime: { ...s.runtime, uiState: { ...s.runtime.uiState, [compId]: value } },
    }))
    engineWorker.postMessage({ type: 'uiState', values: { [compId]: value } })
    engineWorker.postMessage({
      type: 'run',
      eventDefId: 'event/uiChange',
      payload: { component: compId, value },
    })
  },

  onUIClick: (compId) => {
    if (!get().runtime.running || !engineWorker) return
    engineWorker.postMessage({
      type: 'run',
      eventDefId: 'event/uiClick',
      payload: { component: compId },
    })
  },

  handleServerMessage: (msgRaw) => {
    const msg = msgRaw as {
      type: string
      sourceId?: string
      ts?: string
      line?: string
      level?: string
      message?: string
      id?: number
      ok?: boolean
      result?: unknown
    }
    if (msg.type === 'source.event' && engineWorker && msg.sourceId) {
      engineWorker.postMessage({
        type: 'run',
        eventDefId: 'event/onLogLine',
        sourceId: msg.sourceId,
        payload: { line: msg.line, ts: msg.ts },
      })
    } else if (msg.type === 'source.status') {
      get().log(
        msg.level === 'error' ? 'error' : 'system',
        msg.message ?? '',
      )
    } else if (msg.type === 'rpc.result') {
      engineWorker?.postMessage({
        type: 'rpcResult',
        id: Number(msg.id),
        ok: Boolean(msg.ok),
        result: msg.result,
      })
    } else if (msg.type === 'error') {
      get().log('error', msg.message ?? '后端错误')
    }
  },
}))
