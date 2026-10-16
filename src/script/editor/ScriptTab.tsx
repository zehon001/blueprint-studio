/**
 * 工作区「脚本编辑」tab 内容（T3.1 · ScriptAgent）
 *
 * 职责（与 BlueprintTab 同构的加载/保存/脏标记链路，PLAN §9/§10）：
 *  1. 加载 .ts/.py（GET /api/file）→ 文本 → 渲染 ScriptEditor（脚本视图）；
 *  2. 编辑草稿：ScriptEditor onChange → createDraftTracker 防抖 300ms →
 *     workspace markDirty（tab ●，只标一次）+ 记录最新文本供保存链取用；
 *  3. Ctrl+S 保存：ScriptEditor 内 Mod-s keymap（编辑器聚焦时）+ 全局 file.save
 *     重绑定（焦点在 tab 其它位置时）→ PUT /api/file → 清脏；
 *  4. [蓝图 | 脚本] 切换条（ViewSwitch）：脚本视图 = CodeMirror 源码；
 *     蓝图视图 = 占位面板（脚本 IR 解析由 T3.6 提供 + @on/@expose 粗扫信息）。
 *     T3.6 交付后的接线点：用 parser-ts.ts 产出 IRAsset，替换 BlueprintPlaceholder
 *     为 <BlueprintEditorPanel asset={ir} assetPath={assetPath} onSave={save} />。
 *
 * PM 接线方式（workspace-store kind 'script' 的 tab 内容，仿 BlueprintTab）：
 *   import { ScriptTab } from '@/script/editor'
 *   // src/shell/dock/placeholderPanels.tsx 的中央工作区 switch 中：
 *   case 'script': return <ScriptTab assetPath={active.assetPath} />
 *
 * 注意：本组件不 import .css（node:test 需直接加载本文件；样式在 index.ts 统一挂）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { registerShortcut } from '@/shell/keymap/registry'
import { useWorkspaceStore, tabIdOf } from '@/shell/workspace-store'
import { BlueprintPlaceholder } from './BlueprintPlaceholder'
import { createDraftTracker, type DraftTracker } from './draft'
import { ScriptEditor } from './ScriptEditor'
import { scriptLanguageOf } from './scan'
import { ViewSwitch, type ScriptViewKind } from './ViewSwitch'

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
  const [view, setView] = useState<ScriptViewKind>('script')
  /** 最近已知文本（加载内容或最新草稿；蓝图视图占位信息源） */
  const [knownText, setKnownText] = useState('')
  const lastTextRef = useRef('')
  const trackerRef = useRef<DraftTracker | null>(null)

  /* 加载 .ts/.py（GET /api/file → 文本） */
  useEffect(() => {
    if (!project) {
      setState({ status: 'error', text: '', message: '未打开项目（从项目管理器进入编辑器）' })
      return
    }
    let alive = true
    setState({ status: 'loading', text: '', message: '' })
    fetch(`/api/file?path=${encodeURIComponent(fullPath(project.path, assetPath))}`)
      .then((r) => r.json())
      .then((json: { ok: boolean; content?: string; message?: string }) => {
        if (!alive) return
        if (!json.ok) {
          const missing = (json.message ?? '').includes('不存在')
          setState({ status: missing ? 'missing' : 'error', text: '', message: json.message ?? '加载失败' })
          return
        }
        setState({ status: 'ready', text: String(json.content ?? ''), message: '' })
      })
      .catch((err: unknown) => {
        if (alive) setState({ status: 'error', text: '', message: `网络错误：${String(err)}` })
      })
    return () => {
      alive = false
    }
  }, [project?.path, assetPath, reloadKey])

  /* 切换资产回到脚本视图（编辑器草稿随重新加载丢弃） */
  useEffect(() => {
    setView('script')
  }, [assetPath, reloadKey])

  /* 草稿跟踪：onChange → 防抖标脏 + 刷新占位信息源（资产/重载变化时重建） */
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

  /* 编辑器草稿变更（同步记最新文本；标脏由 tracker 防抖） */
  const handleEditorChange = useCallback((text: string) => {
    lastTextRef.current = text
    trackerRef.current?.notifyChange(text)
  }, [])

  /* 保存：PUT /api/file → 清脏 + 草稿基线推进（与 BlueprintTab 同构） */
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
        } else {
          console.error('[脚本保存失败]', json.message)
        }
      })
      .catch((err: unknown) => console.error('[脚本保存失败]', err))
  }, [project?.path, assetPath, tabId, clearDirty, state.status])

  /* Ctrl+S 全局重绑定（焦点在编辑器外时兜底；编辑器内由 Mod-s keymap 优先处理） */
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])
  useEffect(() => {
    registerShortcut(
      { id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => saveRef.current() },
      { force: true },
    )
    return () => {
      // 卸载恢复默认空实现（对齐 BlueprintTab，避免悬挂引用已卸载面板状态）
      registerShortcut({ id: 'file.save', label: '保存', keys: 'Ctrl+S', handler: () => {} })
    }
  }, [])

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
      {/* 顶栏：[蓝图|脚本] 切换条 + 资产信息 + 脏标记 + 保存 */}
      <div className="script-tab-bar">
        <ViewSwitch view={view} onChange={setView} scriptDirty={tabDirty} />
        <span className="script-tab-title" title={assetPath}>
          {assetPath}
        </span>
        <span className="script-tab-lang">{language === 'py' ? 'Python' : 'TypeScript'}</span>
        {tabDirty ? (
          <span className="script-tab-dirty" role="status">
            ● 未保存
          </span>
        ) : null}
        <span className="script-tab-bar-fill" />
        <button type="button" className="script-tab-save" onClick={save}>
          保存
        </button>
      </div>
      <div className="script-tab-body">
        {view === 'script' ? (
          <ScriptEditor
            path={assetPath}
            value={state.text}
            onChange={handleEditorChange}
            onSave={save}
            className="script-tab-editor"
          />
        ) : (
          /* T3.6 接线点：解析器交付后替换为 BlueprintEditorPanel 受控渲染 */
          <BlueprintPlaceholder assetPath={assetPath} source={knownText} scriptDirty={tabDirty} />
        )}
      </div>
    </div>
  )
}
