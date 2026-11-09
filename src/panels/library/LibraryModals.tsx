/**
 * 资源库操作弹窗（编辑菜单接线）
 *
 * 顶栏「编辑 → 资源库」的 导入 / 导出 / 新建 三个动作在本组件弹窗内完成：
 *   - 导入：选择库 zip + 冲突策略 → POST /api/library/import；
 *   - 导出：勾选内置库函数（多选）→ 逐个下载依赖闭包 zip；
 *   - 新建：函数名 + 作用域（内置库 / 项目库）→ 创建并打开编辑器。
 * 由 DockShell 常驻挂载，经 useLibraryUiStore 驱动。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog } from '@/shell/ui/Dialog'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { openAssetPanel } from '@/shell/dock/assetPanelModel'
import { createLibraryEntry, listLibraryEntries } from './api'
import { useLibraryUiStore } from './ui-store'
import { functionShellOf } from './templates'

/* ---------------- 新建函数 ---------------- */

function CreateModal(props: { onClose: () => void }) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'builtin' | 'project'>('builtin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()

  const onCreate = async (): Promise<void> => {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      if (scope === 'builtin') {
        await createLibraryEntry('functions', trimmed, functionShellOf(trimmed))
        openAssetPanel('function', `@library/functions/${trimmed}`)
      } else {
        if (!project) throw new Error('未打开项目，无法新建项目库函数')
        const file = `library/functions/${trimmed}.fn.json`
        const r = await fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: `${project.path}/${file}`, content: functionShellOf(trimmed) }),
        })
        const j = (await r.json()) as { ok?: boolean; message?: string }
        if (!j.ok) throw new Error(j.message ?? '新建失败')
        openAssetPanel('function', file)
      }
      useLibraryUiStore.getState().bump()
      toast.success(`已新建函数「${trimmed}」`)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="新建函数"
      width={420}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={!trimmed || busy}
            onClick={() => void onCreate()}
          >
            创建
          </button>
        </>
      }
    >
      <label className="fs-modal-label" htmlFor="lib-create-name">
        函数名
      </label>
      <input
        id="lib-create-name"
        className="fs-modal-input mono"
        value={name}
        placeholder="如 fmt-print"
        spellCheck={false}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onCreate()
        }}
      />
      <label className="fs-modal-label" htmlFor="lib-create-scope">
        作用域
      </label>
      <select
        id="lib-create-scope"
        className="fs-modal-input"
        value={scope}
        onChange={(e) => setScope(e.target.value as typeof scope)}
      >
        <option value="builtin">内置库（全局可用）</option>
        <option value="project" disabled={!project}>
          项目库（仅当前项目）{project ? '' : '—— 未打开项目'}
        </option>
      </select>
      {error ? <div className="library-error">{error}</div> : null}
    </Dialog>
  )
}

/* ---------------- 导出（内置库多选） ---------------- */

function ExportModal(props: { onClose: () => void }) {
  const [entries, setEntries] = useState<Array<{ name: string }>>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    listLibraryEntries('functions')
      .then((list) => {
        if (alive) setEntries(list.map((e) => ({ name: e.name })))
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const onExport = async (): Promise<void> => {
    if (checked.size === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      for (const name of checked) {
        const r = await fetch(`/api/library/export?kind=functions&name=${encodeURIComponent(name)}&format=zip`)
        if (!r.ok) throw new Error(`导出失败：HTTP ${r.status}`)
        const blob = await r.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `functions-${name}.zip`
        a.click()
        URL.revokeObjectURL(a.href)
      }
      toast.success(`已导出 ${checked.size} 个函数`)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="导出函数"
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={checked.size === 0 || busy}
            onClick={() => void onExport()}
          >
            导出（{checked.size}）
          </button>
        </>
      }
    >
      <div className="fs-modal-label">勾选要导出的内置库函数（导出为依赖闭包 zip）</div>
      {entries.length === 0 ? (
        <div className="library-empty">{error ?? '内置库暂无函数'}</div>
      ) : (
        <div className="lib-modal-list">
          {entries.map((e) => (
            <label key={e.name} className="lib-modal-row">
              <input
                type="checkbox"
                checked={checked.has(e.name)}
                onChange={(ev) => {
                  setChecked((prev) => {
                    const next = new Set(prev)
                    if (ev.target.checked) next.add(e.name)
                    else next.delete(e.name)
                    return next
                  })
                }}
              />
              <span>{e.name}</span>
            </label>
          ))}
        </div>
      )}
      {error && entries.length > 0 ? <div className="library-error">{error}</div> : null}
    </Dialog>
  )
}

/* ---------------- 导入（zip + 冲突策略） ---------------- */

function ImportModal(props: { onClose: () => void }) {
  const policy = useLibraryUiStore((s) => s.policy)
  const setPolicy = useLibraryUiStore((s) => s.setPolicy)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onImport = async (): Promise<void> => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const b of buf) binary += String.fromCharCode(b)
      const r = await fetch('/api/library/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zipBase64: btoa(binary), policy }),
      })
      const j = (await r.json()) as { ok?: boolean; message?: string; imported?: number; skipped?: number }
      if (!j.ok) throw new Error(j.message ?? '导入失败')
      useLibraryUiStore.getState().bump()
      toast.success(`导入完成：新增 ${j.imported ?? 0}，跳过 ${j.skipped ?? 0}`)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="导入函数"
      width={420}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={props.onClose}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn"
            data-variant="primary"
            disabled={!file || busy}
            onClick={() => void onImport()}
          >
            导入
          </button>
        </>
      }
    >
      <label className="fs-modal-label" htmlFor="lib-import-file">
        库 zip（资源库导出的依赖闭包包）
      </label>
      <input
        id="lib-import-file"
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <label className="fs-modal-label" htmlFor="lib-import-policy">
        冲突策略
      </label>
      <select
        id="lib-import-policy"
        className="fs-modal-input"
        value={policy}
        onChange={(e) => setPolicy(e.target.value as typeof policy)}
      >
        <option value="skip">冲突跳过</option>
        <option value="overwrite">冲突覆盖</option>
        <option value="rename">并存改名</option>
      </select>
      {error ? <div className="library-error">{error}</div> : null}
    </Dialog>
  )
}

/** 弹窗宿主（DockShell 常驻挂载；按 store 状态渲染对应弹窗） */
export function LibraryModals() {
  const modal = useLibraryUiStore((s) => s.modal)
  const closeModal = useLibraryUiStore((s) => s.closeModal)
  if (modal === 'create') return <CreateModal onClose={closeModal} />
  if (modal === 'export') return <ExportModal onClose={closeModal} />
  if (modal === 'import') return <ImportModal onClose={closeModal} />
  return null
}
