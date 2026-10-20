/**
 * 资源库面板（v3 T11.5）
 *
 * 两页签（内置库 | 项目库）× 三类（元素/样式/函数）+ 条目详情/引用数/最近修改/新建/重命名/删除。
 * 内置库走 /api/library/*（T11.4）；项目库直接读项目文件目录（ui/elements、ui/styles、
 * library/functions）。导出（多选 zip）/导入（跳过/覆盖/并存改名）已接入。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { openAssetPanel } from '@/shell/dock/assetPanelModel'
import { elementAssetTemplate } from '@/panels/file-system/paths'
import { useSelectionStore } from '@/shell/selection/store'
import { createLibraryEntry, deleteLibraryEntry, listLibraryEntries, renameLibraryEntry, watchLibrary } from './api'
import {
  cascadeElementRename,
  cascadeFunctionRename,
  cascadeStyleRename,
  countProjectReferences,
} from '@/ui-editor/cascadeProject'

type Scope = 'builtin' | 'project'
type Kind = 'elements' | 'styles' | 'functions'

const KIND_LABEL: Record<Kind, string> = {
  elements: '元素',
  styles: '样式',
  functions: '函数',
}

const PROJECT_DIR: Record<Kind, string> = {
  elements: 'ui/elements',
  styles: 'ui/styles',
  functions: 'library/functions',
}

interface Entry {
  kind: Kind
  name: string
  path: string
  size?: number
  mtime?: string
}

function shellOf(kind: Kind, name: string): string {
  // 元素骨架与文件面板新建一致（含 event.start 入口）
  if (kind === 'elements') return elementAssetTemplate(name)
  if (kind === 'styles') {
    return JSON.stringify({ version: 1, classes: { [`${name}-class`]: { props: {} } } }, null, 2)
  }
  return JSON.stringify(
    {
      version: 3,
      kind: 'function',
      scope: 'global',
      name,
      params: [],
      returns: [],
      graph: { nodes: [], edges: [] },
    },
    null,
    2,
  )
}

export function LibraryPanel() {
  const project = useWorkspaceStore((s) => s.currentProject)
  const [scope, setScope] = useState<Scope>('builtin')
  const [kind, setKind] = useState<Kind>('elements')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<Entry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [importPolicy, setImportPolicy] = useState<'skip' | 'overwrite' | 'rename'>('skip')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [refCount, setRefCount] = useState<number | null>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      if (scope === 'builtin') {
        const list = await listLibraryEntries(kind)
        setEntries(list.map((e) => ({ kind, name: e.name, path: `@library/${kind}/${e.name}`, size: e.size, mtime: e.mtime })))
      } else {
        if (!project) {
          setEntries([])
          return
        }
        const dir = `${project.path}/${PROJECT_DIR[kind]}`
        const r = await fetch(`/api/tree?path=${encodeURIComponent(dir)}`)
        const j = (await r.json()) as { ok?: boolean; tree?: { children?: Array<{ name?: string; path?: string; type?: string }> } }
        const suffix = kind === 'elements' ? '.elem.json' : kind === 'styles' ? '.uss.json' : '.fn.json'
        const list: Entry[] = []
        for (const c of j.tree?.children ?? []) {
          if (c.type !== 'file' || typeof c.name !== 'string' || !c.name.toLowerCase().endsWith(suffix)) continue
          list.push({
            kind,
            name: c.name.slice(0, -suffix.length),
            path: `${PROJECT_DIR[kind]}/${c.name}`,
          })
        }
        setEntries(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [scope, kind, project?.path])

  useEffect(() => {
    void load()
  }, [load])

  /* v3 T8.2：资源库条目选择 → 统一检视器条目信息 */
  useEffect(() => {
    if (!selected) return
    useSelectionStore.getState().publish({
      source: 'library',
      scope,
      kind: selected.kind === 'elements' ? 'element' : selected.kind === 'styles' ? 'style' : 'function',
      name: selected.name,
      path: selected.path,
    })
  }, [selected, scope])

  /* 引用数（扫描当前项目 UI/元素/函数资产；项目未打开时显示 —） */
  useEffect(() => {
    setRefCount(null)
    if (!selected || !project) return
    let alive = true
    const kind = selected.kind === 'elements' ? 'element' : selected.kind === 'styles' ? 'style' : 'function'
    void countProjectReferences(project.path, kind, selected.path.startsWith('@library/') ? selected.path : kind === 'function' ? selected.name : selected.path)
      .then((n) => {
        if (alive) setRefCount(n)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [selected?.path, project?.path])

  useEffect(() => watchLibrary(() => void load()), [load])

  const onCreate = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    setBusy(true)
    try {
      if (scope === 'builtin') {
        await createLibraryEntry(kind, n, shellOf(kind, n))
        // D4：内置条目创建后直接进入同款编辑器（元素=UI 编辑器 / 样式=样式编辑器 / 函数=函数编辑器）
        openAssetPanel(
          kind === 'elements' ? 'element' : kind === 'styles' ? 'style' : 'function',
          `@library/${kind}/${n}`,
        )
      } else if (project) {
        const file = `${PROJECT_DIR[kind]}/${n}${kind === 'elements' ? '.elem.json' : kind === 'styles' ? '.uss.json' : '.fn.json'}`
        const r = await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: `${project.path}/${file}`, content: shellOf(kind, n) }),
        })
        const j = (await r.json()) as { ok?: boolean; message?: string }
        if (!j.ok) throw new Error(j.message ?? '新建失败')
        openAssetPanel(
          kind === 'elements' ? 'element' : kind === 'styles' ? 'style' : 'function',
          file,
        )
      }
      setName('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRename = async (): Promise<void> => {
    if (!selected) return
    const to = window.prompt(`重命名「${selected.name}」为：`, selected.name)?.trim()
    if (!to || to === selected.name) return
    setBusy(true)
    try {
      const builtin = selected.path.startsWith('@library/')
      if (builtin) {
        await renameLibraryEntry(selected.kind, selected.name, to)
      } else if (project) {
        const suffix = selected.kind === 'elements' ? '.elem.json' : selected.kind === 'styles' ? '.uss.json' : '.fn.json'
        const dir = PROJECT_DIR[selected.kind]
        const from = `${project.path}/${selected.path}`
        const toPath = `${project.path}/${dir}/${to}${suffix}`
        const r = await fetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: toPath }),
        })
        const j = (await r.json()) as { ok?: boolean; message?: string }
        if (!j.ok) throw new Error(j.message ?? '重命名失败')
      }
      // v3 T13.1：改名级联当前项目引用
      if (project) {
        const suffix = selected.kind === 'elements' ? '.elem.json' : selected.kind === 'styles' ? '.uss.json' : '.fn.json'
        const dir = PROJECT_DIR[selected.kind]
        const oldPath = builtin
          ? `@library/${selected.kind}/${selected.name}`
          : selected.path
        const newPath = builtin
          ? `@library/${selected.kind}/${to}`
          : `${dir}/${to}${suffix}`
        if (selected.kind === 'elements') await cascadeElementRename(project.path, oldPath, newPath)
        else if (selected.kind === 'styles') await cascadeStyleRename(project.path, oldPath, newPath)
        else await cascadeFunctionRename(project.path, selected.name, to)
      }
      setSelected(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (): Promise<void> => {
    if (!selected || !window.confirm(`删除「${selected.name}」？服务端会保留 .history 快照。`)) return
    setBusy(true)
    try {
      if (selected.path.startsWith('@library/')) {
        await deleteLibraryEntry(selected.kind, selected.name)
      } else if (project) {
        await fetch(`/api/file?path=${encodeURIComponent(`${project.path}/${selected.path}`)}`, { method: 'DELETE' })
      }
      setSelected(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onOpen = (): void => {
    if (!selected) return
    if (selected.kind === 'elements') openAssetPanel('element', selected.path)
    else if (selected.kind === 'styles') openAssetPanel('style', selected.path)
    else openAssetPanel('function', selected.path)
  }

  const onExport = async (): Promise<void> => {
    const targets =
      checked.size > 0 ? entries.filter((e) => checked.has(e.path)) : selected ? [selected] : []
    if (targets.length === 0 || targets.some((e) => !e.path.startsWith('@library/'))) {
      setError('请勾选内置库条目后导出（项目库请直接复制文件）')
      return
    }
    try {
      for (const e of targets) {
        const r = await fetch(
          `/api/library/export?kind=${encodeURIComponent(e.kind)}&name=${encodeURIComponent(e.name)}&format=zip`,
        )
        if (!r.ok) throw new Error(`导出失败：HTTP ${r.status}`)
        const blob = await r.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${e.kind}-${e.name}.zip`
        a.click()
        URL.revokeObjectURL(a.href)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onImportFile = async (file: File): Promise<void> => {
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const b of buf) binary += String.fromCharCode(b)
      const zipBase64 = btoa(binary)
      const r = await fetch('/api/library/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zipBase64, policy: importPolicy }),
      })
      const j = (await r.json()) as { ok?: boolean; message?: string; imported?: number; skipped?: number }
      if (!j.ok) throw new Error(j.message ?? '导入失败')
      setError(null)
      window.alert(`导入完成：新增 ${j.imported ?? 0}，跳过 ${j.skipped ?? 0}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="library-panel">
      <div className="library-header">
        <span className="library-title">资源库</span>
        <div className="library-scope" role="tablist" aria-label="库范围">
          {(['builtin', 'project'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              className={`library-scope-btn${scope === s ? ' active' : ''}`}
              onClick={() => setScope(s)}
            >
              {s === 'builtin' ? '内置库' : '项目库'}
            </button>
          ))}
        </div>
        <button type="button" className="library-btn" onClick={() => void load()} title="刷新">
          刷新
        </button>
        <button type="button" className="library-btn" onClick={() => void onExport()} title="导出所选内置库条目（依赖闭包 zip）">
          导出
        </button>
        <select
          className="library-input"
          value={importPolicy}
          aria-label="导入冲突策略"
          title="导入冲突策略"
          onChange={(e) => setImportPolicy(e.target.value as typeof importPolicy)}
        >
          <option value="skip">冲突跳过</option>
          <option value="overwrite">冲突覆盖</option>
          <option value="rename">并存改名</option>
        </select>
        <button type="button" className="library-btn" onClick={() => importRef.current?.click()} title="导入库 zip">
          导入
        </button>
        <input
          ref={importRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void onImportFile(f)
          }}
        />
      </div>
      <div className="library-body">
        <div className="library-kinds" role="tablist" aria-label="条目类型">
          {(['elements', 'styles', 'functions'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`library-kind${kind === k ? ' active' : ''}`}
              onClick={() => {
                setKind(k)
                setSelected(null)
              }}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="library-list">
          {entries.length === 0 ? (
            <div className="library-empty">{scope === 'project' && !project ? '未打开项目' : '暂无条目'}</div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`library-row${selected?.path === e.path ? ' active' : ''}`}
                onClick={() => setSelected(e)}
                onDoubleClick={onOpen}
              >
                <input
                  type="checkbox"
                  className="library-row-check"
                  checked={checked.has(e.path)}
                  title="勾选后导出（多选）"
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => {
                    const on = ev.target.checked
                    setChecked((prev) => {
                      const next = new Set(prev)
                      if (on) next.add(e.path)
                      else next.delete(e.path)
                      return next
                    })
                  }}
                />
                <span className="library-row-name">{e.name}</span>
                <span className="library-row-meta">
                  {e.kind === 'elements' ? 'EL' : e.kind === 'styles' ? 'ST' : 'FN'}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="library-detail">
          {selected ? (
            <>
              <div className="library-detail-title">{selected.name}</div>
              <div className="library-detail-path">{selected.path}</div>
              {selected.mtime ? (
                <div className="library-detail-path" title="最近修改">
                  最近修改：{selected.mtime}
                </div>
              ) : null}
              <div className="library-detail-path" title="当前项目中的引用次数">
                引用数：{refCount === null ? '—' : refCount}
              </div>
              <div className="library-detail-actions">
                <button type="button" className="library-btn" onClick={onOpen}>
                  打开
                </button>
                <button type="button" className="library-btn" onClick={() => void onRename()} disabled={busy}>
                  重命名
                </button>
                <button type="button" className="library-btn danger" onClick={() => void onDelete()} disabled={busy}>
                  删除
                </button>
              </div>
            </>
          ) : (
            <div className="library-empty">选择条目查看详情 / 双击打开</div>
          )}
          <div className="library-create">
            <input
              className="library-input"
              placeholder={`新建${KIND_LABEL[kind]}名…`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onCreate()
              }}
            />
            <button type="button" className="library-btn primary" onClick={() => void onCreate()} disabled={busy || !name.trim()}>
              新建
            </button>
          </div>
          {error ? <div className="library-error">{error}</div> : null}
        </div>
      </div>
    </div>
  )
}
