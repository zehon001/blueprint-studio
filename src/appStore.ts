import { create } from 'zustand'
import { registryById } from './nodeRegistry'
import {
  deleteMiddlewareById,
  deletePluginById,
  listMiddlewares,
  listPlugins,
  putMiddleware,
  putPlugin,
} from './persistence'
import { buildPlugin, type TemplateId } from './templates'
import { useGraphStore, type LogEntry, type LogKind } from './store'
import { wsClient } from './wsClient'
import { initialWidgetState, reduceWidget, type AnyWidgetState } from './widgets/reducers'
import { widgetIdOf, type AssetRecord, type Middleware, type PluginRecord, type WidgetKind } from './types'

let logSeq = 0
let bootstrapped = false
let engineWorker: Worker | null = null
let tickIntervals: number[] = []
let runId: string | null = null

export type RuntimeWidget = {
  kind: WidgetKind
  title: string
  state: AnyWidgetState
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
    widgets: Record<string, RuntimeWidget>
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
  runtime: { running: false, pluginName: '', widgets: {} },

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

    if (middlewares.length === 0 && plugins.length === 0) {
      // 首次启动：种子数据（类似 UE5 的示例项目）
      const dolphin: Middleware = {
        id: 'mw-dolphin',
        name: 'Dolphin 轮唱SDK',
        createdAt: Date.now(),
      }
      const logviewer = buildPlugin(
        'pl-logviewer',
        dolphin.id,
        '日志查看器',
        'logviewer',
      )
      const report = buildPlugin('pl-report', dolphin.id, '错误报表', 'report')
      try {
        await Promise.all([
          putMiddleware(dolphin),
          putPlugin(logviewer),
          putPlugin(report),
        ])
        middlewares = [dolphin]
        plugins = [logviewer, report]
      } catch {
        // 种子失败则保持空列表
      }
    }

    set({ middlewares, plugins })
    await get().refreshAssets()
    get().log('system', `引擎就绪：${middlewares.length} 个中间件 · ${plugins.length} 个插件`)
  },

  addMiddleware: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const mw: Middleware = { id: `mw-${crypto.randomUUID().slice(0, 8)}`, name: trimmed, createdAt: Date.now() }
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
    const isEditingThis =
      graphStore.bound?.id === plugin.id && get().screen === 'editor'
    const graph = isEditingThis ? graphStore.serialize() : plugin.graph
    const varDefs = isEditingThis ? graphStore.vars : plugin.vars
    const varsRecord: Record<string, unknown> = {}
    for (const v of varDefs) varsRecord[v.name] = v.default

    // 收集输出类节点 → 初始化运行时小组件（PIE 视口）
    const widgets: Record<string, RuntimeWidget> = {}
    for (const n of graph.nodes) {
      const def = registryById[n.defId]
      if (def?.widgetKind) {
        const wid = widgetIdOf(def.widgetKind, n.params?.title)
        if (!widgets[wid]) {
          widgets[wid] = {
            kind: def.widgetKind,
            title: String(n.params?.title ?? '').trim() || def.title,
            state: initialWidgetState(def.widgetKind),
          }
        }
      }
    }

    const worker = new Worker(new URL('./engine/engine.worker.ts', import.meta.url), {
      type: 'module',
    })
    engineWorker = worker
    const rid = `run-${crypto.randomUUID().slice(0, 8)}`
    runId = rid
    worker.onerror = (err) => get().log('error', `引擎错误: ${err.message ?? '未知错误'}`)
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data
      if (msg.type === 'fx') {
        if (msg.fx.kind === 'print') {
          get().log('print', msg.fx.value)
        } else if (msg.fx.kind === 'widget') {
          const current = get().runtime.widgets[msg.fx.widgetId]
          if (current) {
            set({
              runtime: {
                ...get().runtime,
                widgets: {
                  ...get().runtime.widgets,
                  [msg.fx.widgetId]: {
                    ...current,
                    state: reduceWidget(current.kind, current.state, msg.fx.op, msg.fx.payload),
                  },
                },
              },
            })
          }
        }
      } else if (msg.type === 'trace') {
        useGraphStore.getState().flashNode(msg.nodeId)
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
        get().log('system', `→ RPC ${msg.method} #${msg.id}${sent ? '' : '（后端未连接）'}`)
        if (!sent) {
          worker.postMessage({ type: 'rpcResult', id: msg.id, ok: false, result: '后端未连接' })
        }
      }
    }
    worker.postMessage({
      type: 'load',
      graph,
      vars: varsRecord,
      assets: get().assets,
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

    set({ runtime: { running: true, pluginName: plugin.name, widgets } })
    get().log('system', `▶ 开始运行「${plugin.name}」（${sources.length} 个日志源）`)
  },

  stopRuntime: () => {
    for (const t of tickIntervals) window.clearInterval(t)
    tickIntervals = []
    engineWorker?.terminate()
    engineWorker = null
    if (runId) wsClient.send({ type: 'plugin.stop', runId })
    runId = null
    useGraphStore.setState({ flash: {} })
    set((s) => ({ runtime: { ...s.runtime, running: false } }))
    get().log('system', '⏹ 已停止')
  },

  closeRuntime: () => {
    get().stopRuntime()
    set((s) => ({ runtime: { ...s.runtime, widgets: {} } }))
  },

  rerunRuntime: () => {
    get().stopRuntime()
    window.setTimeout(() => get().startRuntime(), 150)
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
      get().log(msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'system' : 'system', msg.message ?? '')
    } else if (msg.type === 'rpc.result') {
      get().log('system', `← RPC 回执 #${msg.id} ok=${msg.ok}`)
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
