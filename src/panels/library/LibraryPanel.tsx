/**
 * 资源库面板（v3 T11.5 最小版）
 *
 * 两页签（内置库 | 项目库）× 三类（元素/样式/函数）+ 条目详情/新建/重命名/删除。
 * 内置库走 /api/library/*（T11.4）；项目库直接读项目文件目录（ui/elements、ui/styles、
 * library/functions）。导出/导入按钮随 T11.6（服务端端点已具备）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { openAssetPanel } from '@/shell/dock/assetPanelModel'
import { createLibraryEntry, deleteLibraryEntry, listLibraryEntries, renameLibraryEntry, watchLibrary } from './api'

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
  if (kind === 'elements') {
    return JSON.stringify(
      {
        version: 3,
        kind: 'element',
        name,
        props: [],
        events: [],
        traits: [],
        styles: [],
        root: {
          id: 'element_root',
          name: 'root',
          type: 'vbox',
          layout: { size: { w: 320, h: 160 } },
          container: { direction: 'column', gap: 4 },
          transform: { position: { x: 0, y: 0 }, size: { w: 320, h: 160 }, rotation: 0 },
          theme: {},
          props: {},
          children: [],
        },
        graphs: { event: { kind: 'event', nodes: [], edges: [], comments: [] } },
        variables: [],
      },
      null,
      2,
    )
  }
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

  useEffect(() => watchLibrary(() => void load()), [load])

  const onCreate = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    setBusy(true)
    try {
      if (scope === 'builtin') {
        await createLibraryEntry(kind, n, shellOf(kind, n))
      } else if (project) {
        const file = `${PROJECT_DIR[kind]}/${n}${kind === 'elements' ? '.elem.json' : kind === 'styles' ? '.uss.json' : '.fn.json'}`
        await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: `${project.path}/${file}`, content: shellOf(kind, n) }),
        })
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
    if (!selected || selected.path.startsWith('@library/') === false) return
    const to = window.prompt(`重命名「${selected.name}」为：`, selected.name)
    if (!to || to === selected.name) return
    setBusy(true)
    try {
      await renameLibraryEntry(selected.kind, selected.name, to.trim())
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
    if (selected.path.startsWith('@library/') && selected.kind === 'styles') {
      window.alert('样式表编辑器随 T11.5 完整版接入；元素/函数可直接打开。')
      return
    }
    if (selected.kind === 'elements') openAssetPanel('element', selected.path)
    else if (selected.kind === 'styles') window.alert('样式表编辑器随 T11.5 完整版接入。')
    else openAssetPanel('function', selected.path)
  }

  const onExport = async (): Promise<void> => {
    if (!selected || !selected.path.startsWith('@library/')) {
      setError('请选择内置库条目后导出（项目库请直接复制文件）')
      return
    }
    try {
      const r = await fetch(
        `/api/library/export?kind=${encodeURIComponent(selected.kind)}&name=${encodeURIComponent(selected.name)}&format=zip`,
      )
      if (!r.ok) throw new Error(`导出失败：HTTP ${r.status}`)
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${selected.kind}-${selected.name}.zip`
      a.click()
      URL.revokeObjectURL(a.href)
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
        body: JSON.stringify({ zipBase64, policy: 'skip' }),
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
        <button type="button" className="library-btn" onClick={() => importRef.current?.click()} title="导入库 zip（冲突跳过）">
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
              <div className="library-detail-actions">
                <button type="button" className="library-btn" onClick={onOpen}>
                  打开
                </button>
                {selected.path.startsWith('@library/') ? (
                  <button type="button" className="library-btn" onClick={() => void onRename()} disabled={busy}>
                    重命名
                  </button>
                ) : null}
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
