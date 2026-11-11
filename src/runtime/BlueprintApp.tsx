/**
 * 纯蓝图运行窗口（Blueprint Studio · 纯蓝图工作流）
 *
 * URL：runtime.html?project=<项目>&bp=<蓝图路径>&embed=1&run=<nonce>
 * 加载蓝图 IR → 解析外部函数 → 合并插件节点 specs → 启动解释器 →
 * WS 订阅服务端推送（plugin.push / agent.notification）→ 控制台输出。
 */
import { useEffect, useRef, useState } from 'react'
import { builtinSpecMap } from '@/nodes'
import {
  configurePluginInvoke,
  loadPluginSpecs,
  mergePluginSpecs,
  migratePersonnelDispatchContentToPin,
} from '@/nodes/dynamic'
import { resolveExternalFunctions } from './functions'
import { createEventBus } from './events/bus'
import { createRuntime, type RuntimeHandle } from './interpreter'
import type { NodeSpec } from '@/ir/types'
import { deserializeIR } from '@/ir/validate'
import { DebugWsClient } from '@/shell/debug/debug-ws'
import { DebugProbe } from './debug-probe'
import { createConsoleMirror } from '@/panels/console/protocol'

interface LoadState {
  status: 'loading' | 'running' | 'error'
  message?: string
}

/** 运行窗口主组件（每次 nonce 变化由 iframe 重载，模块级只跑一次） */
export function BlueprintApp() {
  const params = new URLSearchParams(window.location.search)
  const project = params.get('project') ?? ''
  const bpParam = params.get('bp') ?? ''
  const embed = params.get('embed') === '1'

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [lines, setLines] = useState<string[]>([])
  const [title, setTitle] = useState(bpParam)
  const runtimeRef = useRef<RuntimeHandle | null>(null)
  const wsRef = useRef<DebugWsClient | null>(null)
  const probeRef = useRef<DebugProbe | null>(null)
  const linesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const prints: string[] = []
    // 编辑器控制台镜像：隐藏运行宿主没有可见输出，所有 print 必须经频道推送到编辑器控制台
    const mirror = createConsoleMirror({
      project,
      mode: bpParam ? 'current' : 'main',
    })
    const print = (...parts: unknown[]): void => {
      const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p) ?? String(p))).join(' ')
      prints.push(line)
      if (alive) setLines((prev) => [...prev, line])
      mirror.post(line)
    }

    const run = async (): Promise<void> => {
      try {
        if (!project) throw new Error('URL 缺少 project 参数')
        // bp 缺省读 project.json.mainBlueprint（纯蓝图项目的运行入口）
        let bp = bpParam
        if (!bp) {
          const pfRes = await fetch(`/api/file?path=${encodeURIComponent(`${project}/project.json`)}`)
          const pfJson = (await pfRes.json()) as { ok?: boolean; content?: string; message?: string }
          if (!pfJson.ok) throw new Error(pfJson.message ?? '读取 project.json 失败')
          const pf = JSON.parse(String(pfJson.content ?? '{}')) as { mainBlueprint?: string }
          bp = typeof pf.mainBlueprint === 'string' && pf.mainBlueprint ? pf.mainBlueprint : 'blueprint/main.bp.json'
        }
        setTitle(bp)

        const res = await fetch(`/api/file?path=${encodeURIComponent(`${project}/${bp}`)}`)
        const json = (await res.json()) as { ok?: boolean; content?: string; message?: string }
        if (!json.ok) throw new Error(json.message ?? `HTTP ${res.status}`)
        const asset = migratePersonnelDispatchContentToPin(deserializeIR(String(json.content ?? '')))

        const resolved = await resolveExternalFunctions(asset, { project, onPrint: print })
        for (const err of resolved.errors) print(`[函数] ${err}`)

        // 本次运行的唯一 id（每次运行窗口 / 重跑都新建；停止后不复用）
        const blueprintRunId =
          globalThis.crypto?.randomUUID?.() ??
          `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
        configurePluginInvoke({ projectName: project, runId: blueprintRunId, assetPath: bp })

        // 插件节点 specs（含 Agent 会话节点）；基线 = 内置节点库
        const plugin = await loadPluginSpecs(project)
        for (const w of plugin.warnings) print(`[插件] ${w}`)
        const specs: Map<string, NodeSpec> = mergePluginSpecs(builtinSpecMap, plugin.specs)

        // 事件总线：插件推送（流 / Agent 通知）统一入队
        const bus = createEventBus({ onWarn: (m) => print(`[事件总线] ${m}`) })
        // 调试探针（节点高亮 / 端口实时值 → 编辑器叠加层）：一个运行窗口一个实例
        const probe = new DebugProbe({ project })
        probeRef.current = probe

        const rt = createRuntime(resolved.asset, specs, {
          onPrint: print,
          onError: (err, graphName, nodeId) => print(`[错误] ${graphName}/${nodeId}：${err.message}`),
          onDebug: (ev) => probe.push(bp, ev),
          notify: (message) => print(`[通知] ${message}`),
          clipboardWrite: () => print('[剪贴板] 运行窗口暂不支持写入剪贴板，已忽略'),
          openUrl: (url) => print(`[链接] ${url}`),
          readProjectFile: async (path) => {
            const r = await fetch(`/api/file?path=${encodeURIComponent(`${project}/${path}`)}`)
            const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
            if (!j.ok) throw new Error(j.message ?? `HTTP ${r.status}`)
            return String(j.content ?? '')
          },
        })
        runtimeRef.current = rt
        bus.register({ id: 'main', assetPath: bp, uiId: 'default', rt })

        // 服务端推送订阅（plugin.push / agent.notification；断线重连后 onOpen 重发订阅）
        const client = new DebugWsClient({
          onOpen: () => {
            client.send({ type: 'plugin.subscribe', project } as unknown as Parameters<DebugWsClient['send']>[0])
          },
          onMessage: (msg) => {
            const m = msg as unknown as {
              type?: string
              plugin?: unknown
              line?: unknown
              streamId?: unknown
              sessionId?: unknown
              kind?: unknown
              content?: unknown
              raw?: unknown
              personId?: unknown
              taskId?: unknown
              status?: unknown
              result?: unknown
              error?: unknown
              artifacts?: unknown
              source?: unknown
            }
            if (m.type === 'plugin.push' && typeof m.plugin === 'string') {
              bus.pushPlugin(m.plugin, 'line', { line: String(m.line ?? ''), streamId: m.streamId }, { uiId: 'default' })
            } else if (m.type === 'plugin.close' && typeof m.plugin === 'string') {
              bus.pushPlugin(m.plugin, 'close', { streamId: m.streamId }, { uiId: 'default' })
            } else if (m.type === 'agent.notification') {
              bus.pushPlugin(
                'agent',
                'agent.notification',
                {
                  sessionId: String(m.sessionId ?? ''),
                  kind: String(m.kind ?? ''),
                  content: String(m.content ?? ''),
                  ...(typeof m.raw === 'string' ? { raw: m.raw } : {}),
                },
                { uiId: 'default' },
              )
            } else if (m.type === 'personnel.taskEvent') {
              // 运行边界：只消费本次蓝图运行派发的任务事件；无 runId 的旧任务 / 手动任务放行
              let eventSource: { runId?: unknown } = {}
              try {
                eventSource =
                  typeof m.source === 'string'
                    ? (JSON.parse(m.source) as { runId?: unknown })
                    : ((m.source ?? {}) as { runId?: unknown })
              } catch {
                eventSource = {}
              }
              const sourceRunId =
                typeof eventSource.runId === 'string' ? eventSource.runId : ''
              if (sourceRunId && sourceRunId !== blueprintRunId) return
              bus.pushPlugin(
                'personnel',
                'personnel.taskEvent',
                {
                  personId: String(m.personId ?? ''),
                  taskId: String(m.taskId ?? ''),
                  status: String(m.status ?? ''),
                  result: String(m.result ?? ''),
                  error: String(m.error ?? ''),
                  artifacts:
                    typeof m.artifacts === 'string' ? m.artifacts : JSON.stringify(m.artifacts ?? []),
                  source:
                    typeof m.source === 'string' ? m.source : JSON.stringify(m.source ?? {}),
                },
                { uiId: 'default' },
              )
            }
          },
        })
        wsRef.current = client
        client.connect()

        print(`[运行] 蓝图已启动：${project}/${bp}`)
        setState({ status: 'running' })
        rt.start()
      } catch (err) {
        print(`[错误] ${err instanceof Error ? err.message : String(err)}`)
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }

    void run()
    return () => {
      alive = false
      runtimeRef.current?.stop()
      runtimeRef.current = null
      probeRef.current?.stop()
      probeRef.current = null
      wsRef.current?.close()
      wsRef.current = null
      mirror.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onStop = (): void => {
    runtimeRef.current?.stop()
    setLines((prev) => [...prev, '[运行] 已停止'])
  }

  useEffect(() => {
    linesRef.current?.scrollTo({ top: linesRef.current.scrollHeight })
  }, [lines])

  return (
    <div className="bp-runtime">
      {!embed ? (
        <div className="bp-runtime-bar">
          <span className="bp-runtime-title">运行 · {title}</span>
          <span className="bp-runtime-spacer" />
          {state.status === 'running' ? (
            <button type="button" className="bp-runtime-btn" onClick={onStop}>
              停止
            </button>
          ) : null}
        </div>
      ) : null}
      {state.status === 'error' ? <div className="bp-runtime-error">{state.message}</div> : null}
      <div className="bp-runtime-console" ref={linesRef} aria-label="运行控制台">
        {lines.map((line, i) => (
          <div key={i} className={`bp-runtime-line${line.startsWith('[错误]') ? ' is-error' : ''}`}>
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}
