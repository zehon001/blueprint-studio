/**
 * 运行窗口应用（T1.6 静态渲染闭环 · T2.6 蓝图绑定 + 事件驱动运行 · PLAN §12）
 *
 * 职责：
 *   1. 解析 URL 参数（契约见 src/shell/runtime-launch.ts）：
 *      runtime.html?project=<项目文件夹名>&ui=<资产路径>&mode=main|current
 *   2. 加载状态机：loading → ready | error（全屏居中中文错误 + 重试按钮）；
 *      mode=main 且缺省 ui 时先读 project.json 解析 mainUI（parseMainUI）。
 *   3. 渲染：fetch UIAsset → parseUIAsset（ui-editor/store 共享契约）→
 *      renderUI(asset, { mode: 'runtime', onEvent }) 挂到全屏内容区（渲染唯一真源）。
 *   4. 事件驱动（T2.6）：内建事件 → props.onEvent（调试替身，缺省 console 输出）+
 *      BindingRunner.routeEvent（路由到持有该节点的蓝图 runtime，rt.emit 触发
 *      event.custom 链）；就绪后 BindingRunner 收集 logicAsset 绑定 → 加载 .bp.json
 *      → createRuntime（editorSpecMap + UiHandle + print → 控制台）→ start()。
 *   5. 控制台小面板：顶部细条下的折叠区，承接蓝图 print / 绑定生命周期 / 错误
 *      （上限 200 行，FIFO）；出错误行自动展开。
 *   6. 顶部细条：项目 / 资产 / 模式 + 刷新按钮（只读展示，不做编辑功能）。
 *
 * 可注入点（测试与 T2.6 预留）：props.params（替 URL 参数）、props.fetchImpl
 * （替 fetch）、props.onEvent（替默认 console 事件输出）。
 *
 * 注意：本组件不 import CSS（runtime.css 由入口 main.tsx 引入）——
 * 与 render/style.ts 同理，node:test + tsx 无法加载 css，组件需保持可直接单测。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderUI, updateUI, type UIRenderEvent, type UIRenderHandle } from './render/render'
import { BindingRunner } from './binding'
import { DebugProbe } from './debug-probe'
import type { UIAsset } from '../ir/types'
import { parseUIAsset } from '../ui-editor/store'
import {
  clearPrefabCache,
  findPrefabCycle,
  getCachedPrefab,
  prefetchPrefabs,
  setPrefabLoaderContext,
} from '../ui-editor/prefab'
import { parseMainUI, runtimeWindowTitle, RUNTIME_PROBE_CHANNEL, type RuntimeMode } from '../shell/runtime-launch'
import { CONSOLE_CHANNEL, type ConsoleMessage } from '../panels/console/ConsolePanel'

/** 运行窗口 URL 参数（解析后形态；ui 为 null 表示未传，main 模式经 project.json 解析） */
export interface RuntimeParams {
  project: string
  ui: string | null
  mode: RuntimeMode
}

/** 加载状态机阶段 */
export type RuntimePhase = 'loading' | 'ready' | 'error'

/**
 * 从 URL query 串解析运行参数。
 * mode 缺省或非法按 main 处理（宽松：契约中 mode 只有 main|current 两值）；
 * project 未传返回 null（由 validateParams 给中文错误）。
 */
export function parseRuntimeParams(search: string): RuntimeParams | null {
  const q = new URLSearchParams(search)
  const project = q.get('project')
  if (!project) return null
  const modeRaw = q.get('mode')
  const mode: RuntimeMode = modeRaw === 'current' ? 'current' : 'main'
  const uiRaw = q.get('ui')
  return { project, ui: uiRaw && uiRaw.trim() !== '' ? uiRaw : null, mode }
}

/**
 * 参数校验：mode=current 必须显式传 ui（F6 场景由编辑器拼好）；
 * mode=main 允许缺省（运行窗口读 project.json.mainUI，缺失属加载期错误）。
 */
export function validateRuntimeParams(
  p: RuntimeParams | null,
): { ok: true; params: RuntimeParams } | { ok: false; message: string } {
  if (!p) {
    return { ok: false, message: 'URL 参数不完整：未传 project 参数（应为项目文件夹名）' }
  }
  if (p.mode === 'current' && !p.ui) {
    return { ok: false, message: 'URL 参数不完整：未传 ui 参数（应为 UI 资产路径，如 ui/main.ui.json）' }
  }
  return { ok: true, params: p }
}

/** 本期事件处理：console 输出（T2.6 起事件经 BindingRunner 路由到蓝图 runtime，此处保留兜底输出） */
export function defaultOnEvent(evt: UIRenderEvent): void {
  const payload = evt.payload === undefined ? '' : ` ${JSON.stringify(evt.payload)}`
  console.info(`[事件] ${evt.nodeName} ${evt.event}${payload}`)
}

/** 控制台行数上限（FIFO 丢弃最旧行） */
export const CONSOLE_MAX_LINES = 200

/** /api/file 响应体（server/index.ts readFileSafe 契约的所需子集） */
interface FileResponse {
  ok?: boolean
  content?: unknown
  message?: string
}

/** GET /api/file（相对安全根，首段=项目文件夹名）；失败抛中文错误 */
async function fetchFileText(fetchImpl: typeof fetch, path: string): Promise<string> {
  let res: Response
  try {
    res = await fetchImpl(`/api/file?path=${encodeURIComponent(path)}`)
  } catch (err) {
    throw new Error(`加载失败：无法连接本地服务（${err instanceof Error ? err.message : String(err)}）`)
  }
  let body: FileResponse | null = null
  try {
    body = (await res.json()) as FileResponse
  } catch {
    /* 响应体非 JSON：走下方统一错误 */
  }
  if (!body || body.ok !== true) {
    throw new Error(`加载失败：${body?.message ?? `HTTP ${res.status}`}`)
  }
  return String(body.content ?? '')
}

/** 应用状态（含解析后的 ui 路径与就绪资产） */
interface RuntimeAppState {
  /** 有效参数（参数非法为 null，直接进错误态） */
  params: RuntimeParams | null
  phase: RuntimePhase
  /** 错误信息（phase=error 时全屏展示） */
  message: string
  /** 最终渲染的 ui 路径（main 模式经 project.json 解析后回填；顶栏展示用） */
  uiPath: string | null
  /** 就绪资产（phase=ready 时交给 renderUI） */
  asset: UIAsset | null
}

export interface RuntimeAppProps {
  /** 注入 URL 参数（测试用；缺省从 location.search 解析） */
  params?: RuntimeParams
  /** fetch 替身（测试用） */
  fetchImpl?: typeof fetch
  /** 内建事件回调（T2.6 扩展点：接事件总线；缺省 console 输出） */
  onEvent?: (evt: UIRenderEvent) => void
}

export default function RuntimeApp(props: RuntimeAppProps) {
  // 参数在窗口生命周期内不变：只在首次渲染解析一次
  const initial = useMemo(() => {
    const raw = props.params ?? parseRuntimeParams(typeof location === 'undefined' ? '' : location.search)
    const v = validateRuntimeParams(raw)
    return v.ok
      ? { params: v.params, phase: 'loading' as const, message: '', uiPath: v.params.ui, asset: null }
      : { params: null, phase: 'error' as const, message: v.message, uiPath: null, asset: null }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅取首次 props（窗口参数静态）
  }, [])
  const [app, setApp] = useState<RuntimeAppState>(initial)

  /* —— 控制台小面板（T2.6）：print / 绑定生命周期 / 错误行，FIFO 上限 200 行 —— */
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const consoleBodyRef = useRef<HTMLDivElement | null>(null)

  // propsRef：load / 事件回调读取最新注入替身，避免闭包过期
  const propsRef = useRef(props)
  propsRef.current = props
  // 渲染句柄（重载 / 卸载时销毁，解除全部事件监听）
  const handleRef = useRef<UIRenderHandle | null>(null)
  // 绑定运行器（T2.6）：就绪后创建，重载 / 卸载时 stop
  const runnerRef = useRef<BindingRunner | null>(null)
  // 调试观察探针（T5.4）：就绪后创建，重载 / 卸载时 stop（一键关闭观察通道）
  const probeRef = useRef<DebugProbe | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // 编辑器控制台镜像频道（T1.6 兑现：懒建一次；卸载时关闭）
  const consoleChannelRef = useRef<BroadcastChannel | null>(null)
  // 最新 params（appendConsole 广播读取项目名 / 模式；app state 的镜像）
  const paramsRef = useRef<RuntimeParams | null>(null)
  if (app.params) paramsRef.current = app.params
  // 卸载时关闭镜像频道
  useEffect(() => {
    return () => {
      consoleChannelRef.current?.close()
      consoleChannelRef.current = null
    }
  }, [])

  /** 控制台追加一行（FIFO 上限；错误行自动展开面板）；同时经 BroadcastChannel 推送编辑器控制台（T1.6 兑现） */
  const appendConsole = useCallback((line: string): void => {
    setConsoleLines((prev) => {
      const next = prev.length >= CONSOLE_MAX_LINES ? prev.slice(prev.length - CONSOLE_MAX_LINES + 1) : prev.slice()
      next.push(line)
      return next
    })
    if (line.startsWith('[错误]')) setConsoleOpen(true)
    // 编辑器控制台镜像（T1.6 承诺「运行输出接入编辑器控制台」）：同源广播，编辑器面板实时显示
    try {
      const ch = consoleChannelRef.current ?? (consoleChannelRef.current = new BroadcastChannel(CONSOLE_CHANNEL))
      const msg: ConsoleMessage = {
        type: 'console.line',
        line,
        project: paramsRef.current?.project ?? '',
        mode: paramsRef.current?.mode ?? 'main',
        ts: Date.now(),
      }
      ch.postMessage(msg)
    } catch {
      /* 广播不可用（无 BroadcastChannel 等）静默——运行窗口本地控制台不受影响 */
    }
  }, [])

  // 展开态跟随滚动到底部（最新输出可见）
  useEffect(() => {
    const body = consoleBodyRef.current
    if (consoleOpen && body) body.scrollTop = body.scrollHeight
  }, [consoleLines, consoleOpen])

  // 运行窗口 pong 回报（防双开探测协议）：mount 时主动广播一次自身 url，
  // 之后每次收到 ping 也回 pong——编辑器「open 返回 null 但窗口已开」时据此取消降级
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || typeof location === 'undefined') return
    let ch: BroadcastChannel | null = null
    try {
      ch = new BroadcastChannel(RUNTIME_PROBE_CHANNEL)
    } catch {
      return
    }
    const selfUrl = `${location.pathname}${location.search}`
    const pong = (): void => {
      try {
        ch!.postMessage({ type: 'runtime.pong', url: selfUrl })
      } catch {
        /* 频道已关闭 */
      }
    }
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string } | null
      if (m && m.type === 'runtime.ping') pong()
    }
    pong()
    return () => {
      ch!.close()
    }
  }, [])

  /** 加载一次：解析 ui 路径 → fetch → parse → 置 ready（渲染与绑定在下方 effect 完成） */
  const load = useCallback(async (p: RuntimeParams): Promise<void> => {
    runnerRef.current?.stop()
    runnerRef.current = null
    handleRef.current?.destroy()
    handleRef.current = null
    setConsoleLines([])
    setApp({ params: p, phase: 'loading', message: '', uiPath: p.ui, asset: null })
    const fetchImpl = propsRef.current.fetchImpl ?? fetch
    try {
      let uiPath = p.ui
      if (!uiPath) {
        // mode=main 缺省 ui：读 project.json 解析 mainUI（缺失/非法抛中文错）
        uiPath = parseMainUI(await fetchFileText(fetchImpl, `${p.project}/project.json`))
      }
      const text = await fetchFileText(fetchImpl, `${p.project}/${uiPath}`)
      let asset: UIAsset
      try {
        asset = parseUIAsset(text)
      } catch (err) {
        throw new Error(`解析失败：${err instanceof Error ? err.message : String(err)}`)
      }
      // ADR-009（T7.3）：运行窗口装载 UI 前预取树内全部预制体（含嵌套）——「刷新即重取」，
      // 预制体改动经重跑/刷新反射到运行态；循环引用在渲染前显式报中文错误（带重试）。
      setPrefabLoaderContext({ projectPath: p.project, fetchImpl })
      clearPrefabCache()
      await prefetchPrefabs(asset.root)
      const cycle = findPrefabCycle(asset.root, (path) => getCachedPrefab(path))
      if (cycle) throw new Error(cycle)
      setApp({ params: p, phase: 'ready', message: '', uiPath, asset })
    } catch (err) {
      setApp({
        params: p,
        phase: 'error',
        message: err instanceof Error ? err.message : String(err),
        uiPath: null,
        asset: null,
      })
    }
  }, [])

  // 挂载即加载（重试 / 刷新经 retry 手动触发）；页面卸载（关闭 / 刷新）时停掉绑定运行
  useEffect(() => {
    if (!initial.params) return
    void load(initial.params)
    const onPageHide = (): void => runnerRef.current?.stop()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      runnerRef.current?.stop()
      runnerRef.current = null
      handleRef.current?.destroy()
      handleRef.current = null
    }
  }, [initial, load])

  // 窗口标题（DoD：含运行模式；main 模式不依赖解析结果，挂载即可定）
  useEffect(() => {
    if (!app.params) return
    document.title = runtimeWindowTitle({
      mode: app.params.mode,
      ui: app.params.ui ?? '',
      project: app.params.project,
    })
  }, [app.params])

  // 就绪后渲染 + 绑定运行：renderUI 是编辑态/运行态共用的渲染唯一真源；
  // 内建事件 → props.onEvent（调试替身 / 缺省 console）+ BindingRunner（路由到蓝图 runtime）；
  // runner 异步加载 .bp.json 并 start()，单个蓝图失败只记控制台不阻断渲染。
  useEffect(() => {
    if (app.phase !== 'ready' || !app.asset || !contentRef.current) return
    // 预制体补拉完成回调（T7.3）：重放本 effect 的资产刷新占位。localHandle 先声明后
    // 赋值，闭包经它取到本 effect 的句柄（跨 effect 的 handleRef 可能已被新资产替换）。
    let localHandle: UIRenderHandle | null = null
    localHandle = renderUI(app.asset, {
      mode: 'runtime',
      onEvent: (evt) => {
        ;(propsRef.current.onEvent ?? defaultOnEvent)(evt)
        runnerRef.current?.routeEvent(evt)
      },
      onPrefabLoad: () => {
        if (localHandle && app.asset) updateUI(localHandle, app.asset)
      },
    })
    const handle = localHandle
    contentRef.current.appendChild(handle.el)
    handleRef.current = handle
    const project = app.params?.project
    if (project) {
      // 运行时蓝图观察（T5.4）：一个运行窗口一个探针——各绑定实例的 debug 事件经
      // 150ms 批量经 WS 反向通道送编辑器叠加层（server/ws.ts 路由；无订阅者时服务端
      // 回 debug.mute 自动停发）。probe 随本 effect 创建/销毁（重载 / 卸载 stop）。
      const probe = new DebugProbe({ project })
      probeRef.current = probe
      const runner = new BindingRunner({
        project,
        asset: app.asset,
        renderHandle: handle,
        fetchImpl: propsRef.current.fetchImpl ?? fetch,
        onPrint: appendConsole,
        // 详细错误行已由 onPrint 通道输出（[错误] 前缀行会自动展开）；
        // 这里只负责展开控制台（覆盖不携带 [错误] 前缀的错误路径，如蓝图加载失败）
        onError: () => setConsoleOpen(true),
        debugProbe: probe,
      })
      runnerRef.current = runner
      void runner.loadAndStart()
    }
    return () => {
      runnerRef.current?.stop()
      runnerRef.current = null
      handle.destroy()
      handleRef.current = null
      probeRef.current?.stop()
      probeRef.current = null
    }
  }, [app.phase, app.asset, appendConsole])

  const retry = useCallback((): void => {
    if (app.params) void load(app.params)
  }, [app.params, load])

  const modeLabel = app.params?.mode === 'current' ? '当前' : '主UI'
  const uiName = app.uiPath ?? app.params?.ui ?? '—'
  const canRetry = app.params !== null

  return (
    <div className="runtime-root">
      {app.phase === 'error' ? (
        <div className="runtime-error" role="alert">
          <div className="runtime-error-title">运行失败</div>
          <div className="runtime-error-msg">{app.message}</div>
          <button type="button" className="runtime-btn" onClick={retry} disabled={!canRetry}>
            重试
          </button>
        </div>
      ) : (
        <>
          <div className="runtime-topbar">
            <span className="runtime-topbar-item">项目：{app.params?.project ?? '—'}</span>
            <span className="runtime-topbar-item">资产：{uiName}</span>
            <span className="runtime-topbar-item">模式：{modeLabel}</span>
            <span className="runtime-topbar-spacer" />
            <button type="button" className="runtime-btn" onClick={retry} disabled={!canRetry}>
              刷新
            </button>
          </div>
          {app.phase === 'ready' ? (
            <div className="runtime-console">
              <button
                type="button"
                className="runtime-console-bar"
                title="运行窗口控制台：蓝图 print / 绑定 / 错误输出（上限 200 行）"
                onClick={() => setConsoleOpen((o) => !o)}
              >
                <span className="runtime-console-caret" aria-hidden>
                  {consoleOpen ? '▾' : '▸'}
                </span>
                控制台
                {consoleLines.length > 0 ? (
                  <span className="runtime-console-count">{consoleLines.length}</span>
                ) : null}
              </button>
              {consoleOpen ? (
                <div className="runtime-console-body" ref={consoleBodyRef}>
                  {consoleLines.map((line, i) => (
                    <div
                      key={i}
                      className={line.startsWith('[错误]') ? 'runtime-console-line is-error' : 'runtime-console-line'}
                    >
                      {line}
                    </div>
                  ))}
                  {consoleLines.length === 0 ? <div className="runtime-console-line">（暂无输出）</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="runtime-stage">
            {app.phase === 'loading' ? <div className="runtime-loading">加载中…</div> : null}
            <div className="runtime-content" ref={contentRef} />
          </div>
        </>
      )}
    </div>
  )
}
