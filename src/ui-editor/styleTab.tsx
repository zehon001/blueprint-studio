/**
 * 样式表资产编辑器（v3 T11.5/T11.7）
 *
 * 最小但完整的类编辑器：类列表 + 新建/重命名/删除 + props/layout/container JSON 编辑。
 * 重命名类会级联当前项目全部 UI/元素资产的 classes（§11 改名级联）。
 */
import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { tabIdOf, useWorkspaceStore } from '@/shell/workspace-store'
import { registerSaveHandler } from '@/shell/workspace/saveRegistry'
import {
  cascadeRenameStyleClass,
  isLibraryStylePath,
  loadStyleAsset,
  saveStyleAsset,
  styleNameOf,
} from './styleAsset'
import type { StyleSheet } from './styles'

function pretty(v: unknown): string {
  return v === undefined ? '' : JSON.stringify(v, null, 2)
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const raw = text.trim()
  if (raw === '') return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function StyleTab({ path, panelId }: { path: string; panelId?: string }) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const tabId = tabIdOf('style', path)
  const markDirty = useWorkspaceStore((s) => s.markDirty)
  const clearDirty = useWorkspaceStore((s) => s.clearDirty)
  const [sheet, setSheet] = useState<StyleSheet | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [className, setClassName] = useState('')
  const [propsText, setPropsText] = useState('')
  const [layoutText, setLayoutText] = useState('')
  const [containerText, setContainerText] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!project) return
    let alive = true
    loadStyleAsset(project.path, path)
      .then((s) => {
        if (!alive) return
        setSheet(s)
        const first = Object.keys(s.classes)[0] ?? null
        setSelected(first)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [project?.path, path])

  useEffect(() => {
    if (!sheet || !selected) {
      setClassName('')
      setPropsText('')
      setLayoutText('')
      setContainerText('')
      return
    }
    const def = sheet.classes[selected]
    setClassName(selected)
    setPropsText(pretty(def?.props))
    setLayoutText(pretty(def?.layout))
    setContainerText(pretty(def?.container))
  }, [sheet, selected])

  const mutateClass = (next: StyleSheet): void => {
    setSheet(next)
    markDirty(tabId)
    setMessage('')
  }

  /** 把右侧 JSON 编辑区写回 sheet；返回更新后的 sheet（失败 null） */
  const applyEditor = (): StyleSheet | null => {
    if (!sheet || !selected) return sheet
    const p = parseJson(propsText)
    const l = parseJson(layoutText)
    const c = parseJson(containerText)
    if (!p.ok) {
      setError(`props：${p.message}`)
      return null
    }
    if (!l.ok) {
      setError(`layout：${l.message}`)
      return null
    }
    if (!c.ok) {
      setError(`container：${c.message}`)
      return null
    }
    setError('')
    const def = {
      ...(p.value && typeof p.value === 'object' ? { props: p.value as Record<string, unknown> } : {}),
      ...(l.value && typeof l.value === 'object' ? { layout: l.value as never } : {}),
      ...(c.value && typeof c.value === 'object' ? { container: c.value as never } : {}),
    }
    const next = { ...sheet, classes: { ...sheet.classes, [selected]: def } }
    mutateClass(next)
    return next
  }

  const addClass = (): void => {
    if (!sheet) return
    let n = Object.keys(sheet.classes).length + 1
    let name = `class-${n}`
    while (sheet.classes[name]) {
      n += 1
      name = `class-${n}`
    }
    mutateClass({ ...sheet, classes: { ...sheet.classes, [name]: { props: {} } } })
    setSelected(name)
  }

  const deleteClass = (): void => {
    if (!sheet || !selected) return
    const next = { ...sheet.classes }
    delete next[selected]
    mutateClass({ ...sheet, classes: next })
    setSelected(Object.keys(next)[0] ?? null)
  }

  const renameClass = async (): Promise<void> => {
    if (!sheet || !selected || !className.trim() || className.trim() === selected) return
    const applied = applyEditor()
    if (!applied) return
    const to = className.trim()
    if (applied.classes[to]) {
      setError(`类名已存在：${to}`)
      return
    }
    const next: StyleSheet = { ...applied, classes: { ...applied.classes, [to]: applied.classes[selected]! } }
    delete next.classes[selected]
    mutateClass(next)
    setSelected(to)
    if (project) {
      const changed = await cascadeRenameStyleClass(project.path, selected, to)
      setMessage(`已重命名 .${selected} → .${to}；级联更新 ${changed} 个资产`)
    }
  }

  const save = async (): Promise<void> => {
    if (!sheet || !project) return
    const next = applyEditor()
    if (!next) return
    try {
      await saveStyleAsset(project.path, path, next)
      clearDirty(tabId)
      setMessage('已保存')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!panelId) return
    return registerSaveHandler(panelId, () => save())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId, sheet, path, project?.path])

  if (error && !sheet) return <div className="workspace-tab-loading workspace-tab-error">{error}</div>
  if (!sheet) return <div className="workspace-tab-loading">加载样式表…</div>

  return (
    <div className="style-editor">
      <div className="style-editor-head">
        <span className="style-editor-title">
          {isLibraryStylePath(path) ? `@library/styles/${styleNameOf(path)}` : path}
        </span>
        <span className="style-editor-hint">类选择器 · props / layout / container</span>
        <button type="button" className="insp-btn" onClick={() => void save()}>
          保存（Ctrl+S）
        </button>
      </div>
      {message ? <div className="style-editor-msg">{message}</div> : null}
      {error ? <div className="style-editor-err">{error}</div> : null}
      <div className="style-editor-body">
        <aside className="style-editor-list">
          <div className="style-editor-list-head">
            <span>类（{Object.keys(sheet.classes).length}）</span>
            <button type="button" className="insp-btn" onClick={addClass} aria-label="新建样式类">
              <Icon icon={Plus} size={12} />
            </button>
          </div>
          {Object.keys(sheet.classes).map((name) => (
            <button
              key={name}
              type="button"
              className={`style-editor-class${selected === name ? ' active' : ''}`}
              onClick={() => {
                applyEditor()
                setSelected(name)
              }}
            >
              .{name}
            </button>
          ))}
        </aside>
        <div className="style-editor-form">
          {selected ? (
            <>
              <div className="insp-flex-row">
                <span className="insp-flex-label">类名</span>
                <span className="insp-flex-control">
                  <input
                    className="insp-flex-text"
                    value={className}
                    onChange={(e) => setClassName(e.target.value)}
                    onBlur={() => void renameClass()}
                  />
                  <button type="button" className="insp-btn" title="删除类" aria-label="删除类" onClick={deleteClass}>
                    <Icon icon={X} size={12} />
                  </button>
                </span>
              </div>
              <div className="insp-flex-row style-editor-block">
                <span className="insp-flex-label">props</span>
                <textarea
                  className="insp-textarea"
                  rows={8}
                  value={propsText}
                  spellCheck={false}
                  onChange={(e) => setPropsText(e.target.value)}
                />
              </div>
              <div className="insp-flex-row style-editor-block">
                <span className="insp-flex-label">layout</span>
                <textarea
                  className="insp-textarea"
                  rows={6}
                  value={layoutText}
                  spellCheck={false}
                  onChange={(e) => setLayoutText(e.target.value)}
                />
              </div>
              <div className="insp-flex-row style-editor-block">
                <span className="insp-flex-label">container</span>
                <textarea
                  className="insp-textarea"
                  rows={6}
                  value={containerText}
                  spellCheck={false}
                  onChange={(e) => setContainerText(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="insp-note">选择或新建一个样式类。</div>
          )}
        </div>
      </div>
    </div>
  )
}
