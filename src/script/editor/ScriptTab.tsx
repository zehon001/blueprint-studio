/**
 * 工作区「脚本编辑」tab 内容（T3.1 加载/保存链路 + T3.8 双视图同步协议）
 *
 * 职责（PLAN §9/§10，D3 单一资产双视图）：
 *  1. 加载 .ts/.py（GET /api/file）→ 文本 → 渲染 ScriptEditor（脚本视图）；
 *  2. 编辑草稿：ScriptEditor onChange → createDraftTracker 防抖 300ms →
 *     workspace markDirty（tab ●，只标一次）+ 记录最新文本供保存链取用；
 *  3. 脚本视图保存（Ctrl+S / 保存按钮）：PUT /api/file → 清脏 → 同步协议
 *     saveScriptOk（IR 基线更新，蓝图视图基于新 IR 重新解析——保存者胜）；
 *  4. [蓝图 | 脚本] 切换条（ViewSwitch）+ 同步协议状态机（./sync.ts）：
 *     - 蓝图视图 = parseScriptToIR(基准文本) → <BlueprintEditorPanel> 真渲染
 *       （面板经动态 import 懒加载：node:test 无 CSS shim 时降级只读提示）；
 *     - 脚本脏 × 切蓝图 → 提示条「以草稿解析 / 放弃草稿」；
 *       蓝图脏 × 切脚本 → 提示条「应用并覆盖脚本 / 丢弃蓝图修改」；
 *     - 蓝图视图保存（面板 onSave 拿到编辑后 IR）→ codegenTS 生成 TS →
 *       **覆盖写盘 .ts 源码**（D3 魔法：蓝图编辑脚本资产 = 改 IR → codegen 回文本）
 *       → 清脏 → 脚本视图重载 CodeMirror 内容（saveBlueprintOk）；
 *  5. 行列诊断（T3.6 解析器接真）：ScriptTab 顶栏诊断徽标 + 可展开列表，
 *     点击项经 CodeMirror dispatch selection 滚动到行（蓝图视图顶部为
 *     警告条：前 5 条 + 计数，点击无跳转）；解析 error ≥ 1 时蓝图视图降级只读。
 *
 * 保存失败（PUT 409 / 网络 / codegen 失败）→ 草稿与蓝图修改原样保留 + toast
 * （DoD：无脏丢失）；codegen 不可映射时蓝图不写盘，提示改用脚本视图。
 *
 * PM 接线方式（workspace-store kind 'script' 的 tab 内容，仿 BlueprintTab）：
 *   import { ScriptTab } from '@/script/editor'
 *   // src/shell/dock/placeholderPanels.tsx 的中央工作区 switch 中：
 *   case 'script': return <ScriptTab assetPath={active.assetPath} />
 *
 * 注意：本组件不 import .css（node:test 需直接加载本文件；样式在 index.ts 统一挂）。
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, TriangleAlert } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { registerShortcut, unregisterShortcut } from '@/shell/keymap/registry'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { useBlueprintStore } from '@/blueprint/store/blueprint-store'
import type { BlueprintEditorPanelProps } from '@/blueprint'
import { codegenTS } from '../codegen-ts'
import { parseScriptToIR, type ParseDiagnostic } from '../parser-ts'
import type { IRAsset } from '../../ir/types'
import { createDraftTracker, type DraftTracker } from './draft'
import { ScriptEditor } from './ScriptEditor'
import { scriptLanguageOf } from './scan'
import { ViewSwitch } from './ViewSwitch'
import {
  blueprintDirtyPending,
  initSyncState,
  scriptDraftPending,
  viewStateMachine,
  type SyncEffect,
  type SyncEvent,
  type SyncState,
  type SyncView,
} from './sync'

interface ScriptLoadState {
  status: 'loading' | 'ready' | 'missing' | 'error'
  text: string
  message: string
}

/** 项目内相对路径 → 服务端安全根路径（首段=项目文件夹名，与 BlueprintTab 一致） */
function fullPath(projectPath: string, assetPath: string): string {
  return `${projectPath}/${assetPath}`
}

/** 新建空脚本的引导注释头（受控子集写法提示，PLAN §9.2） */
function starterScript(assetPath: string): string {
  const name = assetPath.replace(/.*[/\\]/, '').replace(/\.(ts|py)$/i, '')
  return /\.py$/i.test(assetPath)
    ? `# ${name}.py —— 逻辑资产（受控 Python 子集，PLAN §9.2）\n# @tool('名称') 定义工具 · @expose 暴露变量 · @on 事件 → 蓝图节点\n`
    : `// ${name}.ts —— 逻辑资产（受控 TS 子集，PLAN §9.2）\n// @tool('名称') 定义工具 · @expose 暴露变量 · @on 事件 → 蓝图节点\n`
}

/* ---------------- 蓝图面板懒加载（T3.8 接线点） ---------------- */

/** 蓝图面板组件类型（类型引用在编译期擦除，不会把 @/blueprint 的 .css 拉进 node:test） */
type BlueprintPanelComponent = (props: BlueprintEditorPanelProps) => ReactNode

/**
 * 动态加载 BlueprintEditorPanel（@/blueprint barrel 含 .css import，node:test 环境无
 * CSS shim 时失败）——失败返回 null，蓝图视图降级只读提示（不虚报、不白屏）。
 * 每次进入蓝图视图重试（浏览器 / require 均缓存成功结果；失败不缓存以便重试）。
 */
function loadBlueprintPanel(): Promise<BlueprintPanelComponent | null> {
  return import('@/blueprint')
    .then((m) => m.BlueprintEditorPanel as unknown as BlueprintPanelComponent)
    .catch(() => null)
}

/** 蓝图面板渲染兜底：面板内部异常时不拖垮整个 ScriptTab（降级只读提示） */
class BlueprintPanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.error('[脚本蓝图视图] 蓝图面板渲染失败', err)
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="script-tab-bp-degraded" role="status">
          蓝图面板渲染异常，已降级为只读提示。请切回脚本视图编辑。
        </div>
      )
    }
    return this.props.children
  }
}

/** 解析兜底：解析器异常不拖垮整个 tab（降级为 1:1 错误诊断，蓝图 / 诊断展示层可见） */
function safeParse(text: string): { asset: IRAssetLike | null; diagnostics: ParseDiagnostic[] } {
  try {
    const r = parseScriptToIR(text)
    return { asset: r.asset, diagnostics: r.diagnostics }
  } catch (err) {
    return {
      asset: null,
      diagnostics: [
        {
          line: 1,
          column: 1,
          severity: 'error',
          message: `解析器异常：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }
}

export interface ScriptTabProps {
  /** 资产路径（项目内相对，如 'logic/parser.ts'） */
  assetPath: string
  /** 脏标记防抖毫秒数（默认 300，DoD 口径；测试可调小） */
  dirtyDebounceMs?: number
}

export function ScriptTab({ assetPath, dirtyDebounceMs = 300 }: ScriptTabProps) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const clearDirty = useWorkspaceStore((s) => s.clearDirty)
  const tabId = tabIdOf('script', assetPath)
  const tabDirty = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId)?.dirty ?? false)
  const language = scriptLanguageOf(assetPath)

  const [state, setState] = useState<ScriptLoadState>({ status: 'loading', text: '', message: '' })
  const [reloadKey, setReloadKey] = useState(0)
  /** 同步协议状态机状态（null = 资产未加载完；加载完成后 initSyncState） */
  const [sync, setSync] = useState<SyncState | null>(null)
  /** 编辑器应持有的文本（草稿 / 外部覆写后均在此；ScriptEditor 的 value 只作初值与外部同步） */
  const [editorText, setEditorText] = useState('')
  /** 编辑器整体覆写序号（放弃草稿 / 蓝图写回等动作递增，强制 CodeMirror 重建） */
  const [editorNonce, setEditorNonce] = useState(0)
  /** 最新已知文本（防抖草稿；切换视图 / 以草稿解析时同步为最新，蓝图草稿基 / 诊断源） */
  const [knownText, setKnownText] = useState('')
  /** 蓝图面板（undefined = 加载中；null = 加载失败降级）。组件经对象信封存放：
   *  setState 对函数参数按 updater 处理，直接 setPanel(组件函数) 会把组件当
   *  updater 调用（返回的元素成为状态——React 陷阱，sync.test.ts 曾借此暴露）。 */
  const [panel, setPanel] = useState<{ comp: BlueprintPanelComponent } | null | undefined>(undefined)
  /** 脚本视图诊断列表展开态 */
  const [diagListOpen, setDiagListOpen] = useState(false)
  /** 轻提示（保存失败 / 蓝图保存结果；不丢内容口径的可见反馈） */
  const [toast, setToast] = useState<{ message: string; at: number } | null>(null)
  /** 携带的蓝图编辑成果（blueprintDirty 时进入蓝图视图，用面板 store 里的编辑后 IR，
   *  避免重新解析把未保存修改冲掉——无脏丢失口径） */
  const [carriedBpAsset, setCarriedBpAsset] = useState<IRAssetLike | null>(null)

  const lastTextRef = useRef('')
  const trackerRef = useRef<DraftTracker | null>(null)
  const syncRef = useRef<SyncState | null>(null)
  const editorViewRef = useRef<EditorViewLike | null>(null)
  const saveRef = useRef<() => void>(() => {})
  const applyEffectRef = useRef<(eff: SyncEffect) => void>(() => {})

  /* 加载 .ts/.py（GET /api/file → 文本；加载完成即初始化同步协议状态机） */
  useEffect(() => {
    if (!project) {
      setState({ status: 'error', text: '', message: '未打开项目（从项目管理器进入编辑器）' })
      return
    }
    let alive = true
    setState({ status: 'loading', text: '', message: '' })
    setSync(null)
    syncRef.current = null
    fetch(`/api/file?path=${encodeURIComponent(fullPath(project.path, assetPath))}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; content?: string; message?: string }) => {
        if (!alive) return
        if (!json.ok) {
          const missing = (json.message ?? '').includes('不存在')
          setState({ status: missing ? 'missing' : 'error', text: '', message: json.message ?? '加载失败' })
          return
        }
        const text = String(json.content ?? '')
        const next = initSyncState(text)
        syncRef.current = next
        setState({ status: 'ready', text, message: '' })
        setSync(next)
        setEditorText(text)
        setEditorNonce((n) => n + 1)
        setKnownText(text)
      })
      .catch((err: unknown) => {
        if (alive) setState({ status: 'error', text: '', message: `网络错误：${String(err)}` })
      })
    return () => {
      alive = false
    }
  }, [project?.path, assetPath, reloadKey])

  /* 草稿跟踪：onChange → 防抖标脏 + 刷新已知文本（资产/重载变化时重建） */
  useEffect(() => {
    if (state.status !== 'ready') return
    lastTextRef.current = state.text
    const tracker = createDraftTracker(
      state.text,
      (text) => {
        markDirty(tabId)
        setKnownText(text)
      },
      dirtyDebounceMs,
    )
    trackerRef.current = tracker
    setKnownText(state.text)
    return () => {
      tracker.dispose()
      trackerRef.current = null
    }
  }, [state.status, state.text, tabId, markDirty, dirtyDebounceMs])

  /* 蓝图面板懒加载（进入蓝图视图时发起；失败降级） */
  useEffect(() => {
    if (sync?.view !== 'blueprint') return
    let alive = true
    setPanel(undefined)
    loadBlueprintPanel().then((c) => {
      if (alive) setPanel(c ? { comp: c } : null)
    })
    return () => {
      alive = false
    }
  }, [sync?.view])

  /* 轻提示（2.6s 自动消失，同 BlueprintEditorPanel 口径） */
  const showToast = useCallback((message: string) => {
    setToast({ message, at: Date.now() })
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast?.at])

  /* 同步协议分发：纯状态机转换 + 落地编辑器副作用（不改盘，写盘在 save / 蓝图保存链） */
  const send = useCallback((event: SyncEvent) => {
    const prev = syncRef.current
    if (!prev) return
    const next = viewStateMachine(prev, event)
    syncRef.current = next.state
    setSync(next.state)
    for (const eff of next.effects) applyEffectRef.current(eff)
  }, [])
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  }, [send])

  /* 编辑器覆写落地：setScriptConfirmed = 草稿清零；setScriptDraft = 写回草稿（恢复脏态） */
  const applyEffect = useCallback(
    (eff: SyncEffect) => {
      setEditorText(eff.text)
      setEditorNonce((n) => n + 1)
      if (eff.type === 'setScriptConfirmed') {
        trackerRef.current?.reset(eff.text)
        lastTextRef.current = eff.text
        setKnownText(eff.text)
      } else {
        // 写回草稿：基线仍是磁盘文本 → 编辑器恢复脏态（防抖标脏）
        const baseline = syncRef.current?.savedText ?? ''
        trackerRef.current?.reset(baseline)
        trackerRef.current?.notifyChange(eff.text)
        lastTextRef.current = eff.text
        setKnownText(eff.text)
      }
    },
    [],
  )
  useEffect(() => {
    applyEffectRef.current = applyEffect
  }, [applyEffect])

  /* 编辑器草稿变更：同步记草稿文本（视图往返不丢）+ 上报协议（机器对比基线判脏）
   * + tracker 防抖标脏（workspace tab ●，只标一次） */
  const handleEditorChange = useCallback((text: string) => {
    lastTextRef.current = text
    setEditorText(text)
    trackerRef.current?.notifyChange(text)
    sendRef.current({ type: 'editScript', text })
  }, [])

  /* 保存：PUT /api/file → 清脏 + 同步协议 saveScriptOk（IR 基线推进，保存者胜） */
  const save = useCallback(() => {
    if (!project || state.status !== 'ready') return
    const content = lastTextRef.current
    fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath(project.path, assetPath), content }),
    })
      .then((r) => r.json())
      .then((json: { ok: boolean; message?: string }) => {
        if (json.ok) {
          trackerRef.current?.reset(content)
          lastTextRef.current = content
          setKnownText(content)
          clearDirty(tabId)
          sendRef.current({ type: 'saveScriptOk', text: content })
          showToast('已保存')
        } else {
          sendRef.current({ type: 'saveScriptFail' })
          showToast(`保存失败：${json.message ?? '写入被拒绝'}（草稿已保留，请重试）`)
        }
      })
      .catch((err: unknown) => {
        sendRef.current({ type: 'saveScriptFail' })
        showToast(`保存失败：${String(err)}（草稿已保留，请重试）`)
      })
  }, [project?.path, assetPath, tabId, clearDirty, state.status, showToast])
  /* latest-ref：快捷键 / 保存按钮始终取到最新 save（effect 期同步，React 并发安全） */
  useEffect(() => {
    saveRef.current = save
  }, [save])

  /* 视图切换（同步协议：脏冲突不阻止切换，横幅提示 + 用户选择） */
  const switchTo = useCallback(
    (view: SyncView) => {
      const cur = syncRef.current
      if (!cur || cur.view === view) return
      // 蓝图 → 脚本：捕获蓝图未保存修改（机器标志或面板 store 脏）
      if (cur.view === 'blueprint') {
        const bpState = useBlueprintStore.getState()
        if (cur.blueprintDirty || (bpState.dirty && bpState.asset)) {
          send({ type: 'editBlueprint' })
        }
      }
      // 脚本 → 蓝图：blueprintDirty 时携带面板 store 里的编辑后 IR（重解析会冲掉未保存修改）
      if (view === 'blueprint') {
        if (cur.blueprintDirty) {
          const edited = useBlueprintStore.getState().asset
          setCarriedBpAsset(edited ?? null)
        } else {
          setCarriedBpAsset(null)
        }
      }
      setKnownText(lastTextRef.current) // 切换时同步最新草稿（诊断 / 草稿基解析即时性）
      send({ type: 'switchView', view })
    },
    [send],
  )

  /* 蓝图视图保存（面板 onSave → codegen 覆盖写盘 → 脚本视图重载；失败不丢蓝图修改） */
  const handleBlueprintSave = useCallback(
    (asset: IRAssetLike) => {
      if (!project) return
      send({ type: 'editBlueprint' }) // 标记蓝图脏（失败时切回脚本视图横幅可见）
      let code: string
      try {
        code = codegenTS(asset)
      } catch (err) {
        send({ type: 'saveBlueprintFail' })
        showToast(`蓝图转脚本失败：${err instanceof Error ? err.message : String(err)}（蓝图修改已保留）`)
        return
      }
      fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath(project.path, assetPath), content: code }),
      })
        .then((r) => r.json())
        .then((json: { ok: boolean; message?: string }) => {
          if (json.ok) {
            trackerRef.current?.reset(code)
            lastTextRef.current = code
            setKnownText(code)
            setCarriedBpAsset(null)
            clearDirty(tabId)
            send({ type: 'saveBlueprintOk', text: code }) // 编辑器经 effect 重载为生成文本
            showToast('蓝图已保存：脚本源码已按蓝图重新生成')
          } else {
            send({ type: 'saveBlueprintFail' })
            showToast(`保存失败：${json.message ?? '写入被拒绝'}（蓝图修改已保留，请重试）`)
          }
        })
        .catch((err: unknown) => {
          send({ type: 'saveBlueprintFail' })
          showToast(`保存失败：${String(err)}（蓝图修改已保留，请重试）`)
        })
    },
    [project?.path, assetPath, tabId, clearDirty, send, showToast],
  )

  /* 蓝图修改 → 写回编辑器草稿（应用并覆盖脚本；未写盘，Ctrl+S 确认） */
  const applyBlueprint = useCallback(() => {
    const edited = useBlueprintStore.getState().asset
    if (!edited) {
      showToast('蓝图内容不可用（面板未加载）')
      return
    }
    try {
      const code = codegenTS(edited)
      setCarriedBpAsset(null)
      send({ type: 'applyBlueprintToScript', text: code }) // effect 写回编辑器草稿
      showToast('蓝图修改已写回脚本草稿（未保存，Ctrl+S 确认）')
    } catch (err) {
      showToast(`蓝图转脚本失败：${err instanceof Error ? err.message : String(err)}（蓝图修改已保留）`)
    }
  }, [send, showToast])

  /* 丢弃蓝图修改（蓝图基于已保存版本重新解析） */
  const discardBlueprint = useCallback(() => {
    setCarriedBpAsset(null)
    send({ type: 'discardBlueprintChanges' })
  }, [send])

  /* Ctrl+S 重绑定（按视图接管：脚本视图 = 本面板保存；蓝图视图 = BlueprintEditorPanel 保存）。
   * 注册表按 id 占用组合键：蓝图视图必须先注销 file.save，面板的无 force 注册才能成功；
   * effect 销毁序（面板卸载恢复空实现 → 本 effect 重建真实绑定）保证切回脚本视图可用。 */
  const view = sync?.view ?? 'script'
  useEffect(() => {
    if (view !== 'script') {
      unregisterShortcut('file.save')
      return () => {
        registerShortcut({ id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => {} })
      }
    }
    registerShortcut(
      { id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => saveRef.current() },
      { force: true },
    )
    return () => {
      registerShortcut({ id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => {} })
    }
  }, [view])

  /* 新建空脚本（资产不存在时） */
  const createEmpty = useCallback(() => {
    if (!project) return
    fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath(project.path, assetPath), content: starterScript(assetPath) }),
    })
      .then(() => setReloadKey((k) => k + 1))
      .catch((err: unknown) => console.error('[创建脚本失败]', err))
  }, [project?.path, assetPath])

  /* ---------- 行列诊断（T3.6 解析器接真；.py 待 T4 Python 解析器，不虚报） ---------- */
  const isTs = language === 'ts'
  /** 脚本视图诊断源 = 最新草稿（防抖；切换视图时同步为最新） */
  const knownParsed = useMemo(
    () => (isTs && state.status === 'ready' ? safeParse(knownText) : null),
    [isTs, state.status, knownText],
  )
  /** 蓝图「已保存」基解析（保存者胜协议的基准文本） */
  const savedParsed = useMemo(
    () => (isTs && state.status === 'ready' ? safeParse(sync?.savedText ?? '') : null),
    [isTs, state.status, sync?.savedText],
  )
  const scriptDiags = knownParsed?.diagnostics ?? []
  const diagErrors = scriptDiags.filter((d) => d.severity === 'error').length
  const diagWarnings = scriptDiags.length - diagErrors

  /** 点击诊断项 → CodeMirror dispatch selection 滚动到行列 */
  const jumpToDiagnostic = useCallback((d: ParseDiagnostic) => {
    const v = editorViewRef.current
    if (!v) return
    const lineNo = Math.min(Math.max(d.line, 1), v.state.doc.lines)
    const line = v.state.doc.line(lineNo)
    const pos = Math.min(line.from + Math.max(d.column - 1, 0), line.to)
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
    v.focus()
  }, [])

  /* 蓝图视图解析基准：携带的编辑成果 > 草稿基 > 已保存基（保存者胜协议） */
  const blueprintAsset: IRAssetLike | null = carriedBpAsset ?? (sync?.blueprintBase === 'draft' ? knownParsed?.asset ?? null : savedParsed?.asset ?? null)
  const blueprintDiags: ParseDiagnostic[] = carriedBpAsset
    ? [] // 携带的编辑成果来自面板 store（面板自有校验条），不重复解析
    : sync?.blueprintBase === 'draft'
      ? knownParsed?.diagnostics ?? []
      : savedParsed?.diagnostics ?? []
  const bpErrorCount = blueprintDiags.filter((d) => d.severity === 'error').length

  if (state.status === 'loading') {
    return <div className="workspace-tab-loading">加载中…</div>
  }
  if (state.status === 'missing') {
    return (
      <div className="workspace-tab-loading">
        <div>资产不存在：{assetPath}</div>
        <button type="button" className="workspace-tab-create" onClick={createEmpty}>
          创建空脚本
        </button>
      </div>
    )
  }
  if (state.status === 'error') {
    return <div className="workspace-tab-loading workspace-tab-error">{state.message || '加载失败'}</div>
  }
  return (
    <div className="script-tab">
      {/* 顶栏：[蓝图|脚本] 切换条 + 资产信息 + 诊断徽标 + 脏标记 + 保存（蓝图视图由面板接管） */}
      <div className="script-tab-bar">
        <ViewSwitch view={view} onChange={switchTo} scriptDirty={sync?.scriptDirty ?? false} />
        <span className="script-tab-title" title={assetPath}>
          {assetPath}
        </span>
        <span className="script-tab-lang">{language === 'py' ? 'Python' : 'TypeScript'}</span>
        {isTs && scriptDiags.length > 0 ? (
          <button
            type="button"
            className={`script-tab-diag-badge${diagErrors > 0 ? ' has-error' : ''}`}
            title="受控子集解析诊断（点击展开列表，点击条目跳转到行）"
            onClick={() => setDiagListOpen((o) => !o)}
          >
            {diagErrors > 0 ? `${diagErrors} 错误` : '诊断'}
            {diagWarnings > 0 ? ` · ${diagWarnings} 警告` : ''}
          </button>
        ) : null}
        {tabDirty ? (
          <span className="script-tab-dirty" role="status">
            <span className="script-tab-dirty-dot" aria-hidden /> 未保存
          </span>
        ) : null}
        <span className="script-tab-bar-fill" />
        {view === 'script' ? (
          <button type="button" className="script-tab-save" onClick={() => saveRef.current()}>
            保存
          </button>
        ) : null}
      </div>

      {/* 脚本视图诊断列表（点击条目滚动到行） */}
      {view === 'script' && diagListOpen && scriptDiags.length > 0 ? (
        <ul className="script-tab-diag-list">
          {scriptDiags.slice(0, 50).map((d, i) => (
            <li key={i}>
              <button
                type="button"
                className={`script-tab-diag-item${d.severity === 'error' ? ' has-error' : ''}`}
                onClick={() => jumpToDiagnostic(d)}
              >
                <Icon icon={d.severity === 'error' ? CircleAlert : TriangleAlert} size={12} /> {d.line}:{d.column} {d.message}
              </button>
            </li>
          ))}
          {scriptDiags.length > 50 ? <li className="script-tab-diag-more">…共 {scriptDiags.length} 条</li> : null}
        </ul>
      ) : null}

      <div className="script-tab-body">
        {view === 'script' ? (
          <>
            {/* 蓝图已修改未保存横幅（应用并覆盖脚本 / 丢弃蓝图修改） */}
            {sync && blueprintDirtyPending(sync) ? (
              <div className="script-tab-syncbar" role="status">
                <span>蓝图已修改（未保存）</span>
                <button type="button" className="script-tab-syncbtn" onClick={applyBlueprint}>
                  应用并覆盖脚本
                </button>
                <button type="button" className="script-tab-syncbtn" onClick={discardBlueprint}>
                  丢弃蓝图修改
                </button>
              </div>
            ) : null}
            <ScriptEditor
              key={editorNonce}
              path={assetPath}
              value={editorText}
              onChange={handleEditorChange}
              onSave={() => saveRef.current()}
              onReady={(v) => {
                editorViewRef.current = v
              }}
              className="script-tab-editor"
            />
          </>
        ) : (
          <div className="script-tab-bp">
            {/* 脚本未保存草稿横幅（以草稿解析 / 放弃草稿；保存者胜：缺省按已保存版本渲染） */}
            {sync && scriptDraftPending(sync) ? (
              <div className="script-tab-syncbar" role="status">
                <span>脚本有未保存修改，蓝图将基于已保存版本渲染</span>
                <button
                  type="button"
                  className="script-tab-syncbtn"
                  onClick={() => {
                    setKnownText(lastTextRef.current)
                    send({ type: 'parseScriptDraftAsBlueprint' })
                  }}
                >
                  以草稿解析
                </button>
                <button
                  type="button"
                  className="script-tab-syncbtn"
                  onClick={() => send({ type: 'discardScriptDraft' })}
                >
                  放弃草稿
                </button>
              </div>
            ) : null}

            {/* 蓝图视图诊断警告条（前 5 条 + 计数，点击无跳转） */}
            {blueprintDiags.length > 0 ? (
              <div className="script-tab-bp-diags" role="status">
                {blueprintDiags.slice(0, 5).map((d, i) => (
                  <div key={i} className={`script-tab-bp-diag${d.severity === 'error' ? ' has-error' : ''}`}>
                    <Icon icon={d.severity === 'error' ? CircleAlert : TriangleAlert} size={12} /> {d.line}:{d.column} {d.message}
                  </div>
                ))}
                {blueprintDiags.length > 5 ? (
                  <div className="script-tab-bp-diag">…共 {blueprintDiags.length} 条诊断（前 5 条）</div>
                ) : null}
              </div>
            ) : null}

            {/* 解析 error ≥ 1 → 降级只读提示；面板加载失败 → 降级提示（不虚报不白屏） */}
            {bpErrorCount > 0 ? (
              <div className="script-tab-bp-degraded" role="alert">
                解析存在 {bpErrorCount} 个错误，蓝图视图降级为只读提示。请切回脚本视图修复后重试。
              </div>
            ) : !isTs ? (
              <div className="script-tab-bp-degraded" role="status">
                Python 脚本的蓝图视图将在 Python 解析器（T4.x）交付后提供；当前请使用脚本视图编辑。
              </div>
            ) : panel === undefined ? (
              <div className="script-tab-bp-degraded">蓝图面板加载中…</div>
            ) : panel === null ? (
              <div className="script-tab-bp-degraded" role="status">
                蓝图面板加载失败（开发环境缺样式装载器时可能出现）。请切回脚本视图编辑。
              </div>
            ) : blueprintAsset ? (
              <BlueprintPanelBoundary>
                <BlueprintPanelHost
                  panel={panel.comp}
                  asset={blueprintAsset as IRAsset}
                  assetPath={assetPath}
                  onSave={handleBlueprintSave}
                  className="script-tab-bp-panel"
                />
              </BlueprintPanelBoundary>
            ) : (
              <div className="script-tab-bp-degraded">蓝图数据不可用，请切回脚本视图。</div>
            )}
            {panel ? (
              <div className="script-tab-bp-hint">
                蓝图视图保存（Ctrl+S）：生成脚本源码并覆盖写盘（保存者胜），脚本视图将自动重载。
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* 轻提示（保存结果 / 失败保留提示） */}
      {toast ? (
        <div className="script-tab-toast" role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}

/** 蓝图面板宿主（props 直传，不含额外逻辑；T5.4 若给面板加叠加 props 不受影响） */
function BlueprintPanelHost(props: {
  panel: BlueprintPanelComponent
  asset: IRAsset
  assetPath: string
  onSave: (asset: IRAsset, assetPath?: string) => void
  className?: string
}) {
  const { panel: Panel, ...rest } = props
  return <Panel {...rest} />
}

/** 编辑器视图 / IR 资产的最小结构类型（避免 node:test 拉入 CodeMirror / @xyflow 运行时） */
interface EditorViewLike {
  state: { doc: { lines: number; line(n: number): { from: number; to: number } } }
  dispatch(x: { selection: { anchor: number }; scrollIntoView?: boolean }): void
  focus(): void
}
type IRAssetLike = Parameters<NonNullable<BlueprintEditorPanelProps['onSave']>>[0]
