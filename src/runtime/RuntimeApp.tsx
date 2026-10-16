/**
 * 运行窗口应用（T1.6 · PLAN §12 运行窗口 v1）
 *
 * 职责（本期 = 静态渲染闭环）：
 *   1. 解析 URL 参数（契约见 src/shell/runtime-launch.ts）：
 *      runtime.html?project=<项目文件夹名>&ui=<资产路径>&mode=main|current
 *   2. 加载状态机：loading → ready | error（全屏居中中文错误 + 重试按钮）；
 *      mode=main 且缺省 ui 时先读 project.json 解析 mainUI（parseMainUI）。
 *   3. 渲染：fetch UIAsset → parseUIAsset（ui-editor/store 共享契约）→
 *      renderUI(asset, { mode: 'runtime', onEvent }) 挂到全屏内容区（渲染唯一真源）。
 *   4. 事件：本期 onEvent 仅 console 输出「[事件] 节点名 事件名 payload」；
 *      事件驱动接线（IR 解释器 / 蓝图绑定）属 T2.6，经 props.onEvent 扩展点接入。
 *   5. 顶部细条：项目 / 资产 / 模式 + 刷新按钮（只读展示，不做编辑功能）。
 *
 * 可注入点（测试与 T2.6 预留）：props.params（替 URL 参数）、props.fetchImpl
 * （替 fetch）、props.onEvent（替默认 console 事件输出）。
 *
 * 注意：本组件不 import CSS（runtime.css 由入口 main.tsx 引入）——
 * 与 render/style.ts 同理，node:test + tsx 无法加载 css，组件需保持可直接单测。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderUI, type UIRenderEvent, type UIRenderHandle } from './render/render'
import type { UIAsset } from '../ir/types'
import { parseUIAsset } from '../ui-editor/store'
import { parseMainUI, runtimeWindowTitle, type RuntimeMode } from '../shell/runtime-launch'

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

/** 本期事件处理：console 输出（事件驱动接线属 T2.6，经 props.onEvent 替换） */
export function defaultOnEvent(evt: UIRenderEvent): void {
  const payload = evt.payload === undefined ? '' : ` ${JSON.stringify(evt.payload)}`
  console.info(`[事件] ${evt.nodeName} ${evt.event}${payload}`)
}

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

  // propsRef：load / 事件回调读取最新注入替身，避免闭包过期
  const propsRef = useRef(props)
  propsRef.current = props
  // 渲染句柄（重载 / 卸载时销毁，解除全部事件监听）
  const handleRef = useRef<UIRenderHandle | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  /** 加载一次：解析 ui 路径 → fetch → parse → 置 ready（渲染在下方 effect 完成） */
  const load = useCallback(async (p: RuntimeParams): Promise<void> => {
    handleRef.current?.destroy()
    handleRef.current = null
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

  // 挂载即加载（重试 / 刷新经 retry 手动触发）
  useEffect(() => {
    if (!initial.params) return
    void load(initial.params)
    return () => {
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

  // 就绪后渲染：renderUI 是编辑态/运行态共用的渲染唯一真源；句柄销毁由本组件管理
  useEffect(() => {
    if (app.phase !== 'ready' || !app.asset || !contentRef.current) return
    const handle = renderUI(app.asset, {
      mode: 'runtime',
      onEvent: (evt) => (propsRef.current.onEvent ?? defaultOnEvent)(evt),
    })
    contentRef.current.appendChild(handle.el)
    handleRef.current = handle
    return () => {
      handle.destroy()
      handleRef.current = null
    }
  }, [app.phase, app.asset])

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
          <div className="runtime-stage">
            {app.phase === 'loading' ? <div className="runtime-loading">加载中…</div> : null}
            <div className="runtime-content" ref={contentRef} />
          </div>
        </>
      )}
    </div>
  )
}
