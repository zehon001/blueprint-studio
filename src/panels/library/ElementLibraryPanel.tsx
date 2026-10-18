/**
 * UI 编辑器左栏「元素库」（v3 T11.7 最小版）
 *
 * 分组：基础控件（23 schema）/ 项目元素（ui/elements/*.elem.json）。
 * 点击条目 → 在根节点下追加：基础控件走 commitAddNode；元素追加 __element 实例。
 * 预制体分组与资源库全局管理（内置库/导出导入）随 T11.5/T11.6 服务接入。
 */
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { uiNodeSchemas, NODE_CATEGORIES } from '@/ui-editor/schema'
import { commitAddNode } from '@/ui-editor/viewport/commands'
import { getSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import {
  CONTROL_DRAG_MIME,
  ELEMENT_DRAG_MIME,
  PREFAB_DRAG_MIME,
  insertElementInstance,
  insertPrefabInstance,
} from '@/ui-editor/insertElement'
import { listLibraryEntries, watchLibrary } from './api'
import { useWorkspaceStore } from '@/shell/workspace-store'

export const ELEMENT_DIR = 'ui/elements'
const PREFAB_DIR = 'ui/prefabs'

interface ElementEntry {
  name: string
  path: string
}

/** 从文件树响应中取目录下 .elem.json（只取一层） */
function elementsOf(json: unknown, dir: string): ElementEntry[] {
  const tree = (json as { tree?: { children?: Array<{ name?: string; path?: string; type?: string }> } })?.tree
  const out: ElementEntry[] = []
  for (const c of tree?.children ?? []) {
    if (c.type !== 'file' || typeof c.name !== 'string' || !c.name.toLowerCase().endsWith('.elem.json')) continue
    out.push({ name: c.name.replace(/\.elem\.json$/i, ''), path: `${dir}/${c.name}` })
  }
  return out
}

/** 预制体条目（ui/prefabs/*.ui.json） */
function prefabsOf(json: unknown, dir: string): ElementEntry[] {
  const tree = (json as { tree?: { children?: Array<{ name?: string; path?: string; type?: string }> } })?.tree
  const out: ElementEntry[] = []
  for (const c of tree?.children ?? []) {
    if (c.type !== 'file' || typeof c.name !== 'string' || !c.name.toLowerCase().endsWith('.ui.json')) continue
    out.push({ name: c.name.replace(/\.ui\.json$/i, ''), path: `${dir}/${c.name}` })
  }
  return out
}

export function ElementLibraryPanel({ onCreated }: { onCreated?: () => void } = {}) {
  const project = useWorkspaceStore((s) => s.currentProject)
  const [elements, setElements] = useState<ElementEntry[]>([])
  const [builtinElements, setBuiltinElements] = useState<ElementEntry[]>([])
  const [prefabs, setPrefabs] = useState<ElementEntry[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [libTick, setLibTick] = useState(0)

  useEffect(() => {
    if (!project) return
    let alive = true
    fetch(`/api/tree?path=${encodeURIComponent(`${project.path}/${ELEMENT_DIR}`)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        if (j?.ok) setElements(elementsOf(j, ELEMENT_DIR))
      })
      .catch(() => {
        if (alive) setError('元素目录读取失败')
      })
    fetch(`/api/tree?path=${encodeURIComponent(`${project.path}/${PREFAB_DIR}`)}`)
      .then((r) => r.json())
      .then((j) => {
        if (alive && j?.ok) setPrefabs(prefabsOf(j, PREFAB_DIR))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [project?.path])

  useEffect(() => {
    let alive = true
    listLibraryEntries('elements')
      .then((entries) => {
        if (alive) {
          setBuiltinElements(
            entries.map((e) => ({ name: e.name, path: `@library/elements/${e.name}` })),
          )
        }
      })
      .catch(() => {
        /* 资源库服务未启动：内置元素分组为空 */
      })
    return () => {
      alive = false
    }
  }, [libTick])

  useEffect(() => watchLibrary(() => setLibTick((t) => t + 1)), [])

  const kw = search.trim().toLowerCase()
  const controls = useMemo(
    () =>
      uiNodeSchemas.filter(
        (s) =>
          !kw ||
          s.type.toLowerCase().includes(kw) ||
          s.title.toLowerCase().includes(kw) ||
          (s.keywords ?? []).some((k) => k.toLowerCase().includes(kw)),
      ),
    [kw],
  )

  const addControl = (type: string): void => {
    const a = getSceneTreeDomain().asset
    if (!a) return
    const id = commitAddNode(type, a.root.id, { x: 0, y: 0 })
    if (id) {
      useUIEditorStore.getState().setSelection([id])
      onCreated?.()
    }
  }

  const addElement = (entry: ElementEntry): void => {
    if (insertElementInstance(entry.path, entry.name, { x: 0, y: 0 })) onCreated?.()
  }

  const addPrefab = (entry: ElementEntry): void => {
    if (insertPrefabInstance(entry.path, entry.name, { x: 0, y: 0 })) onCreated?.()
  }

  const dragPayload = (e: DragEvent, mime: string, value: string): void => {
    e.dataTransfer.setData(mime, value)
    e.dataTransfer.setData('text/plain', value)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="element-library">
      <input
        className="element-library-search"
        placeholder="搜索控件 / 元素…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        spellCheck={false}
      />
      <div className="element-library-body">
        {NODE_CATEGORIES.map((cat) => {
          const list = controls.filter((s) => s.category === cat)
          if (list.length === 0) return null
          return (
            <div key={cat} className="element-library-group">
              <div className="element-library-title">{cat}</div>
              <div className="element-library-grid">
                {list.map((s) => (
                  <button
                    key={s.type}
                    type="button"
                    className="element-library-item"
                    title={`添加「${s.title}」（可拖入画布，${s.type}）`}
                    draggable
                    onDragStart={(e) => dragPayload(e, CONTROL_DRAG_MIME, s.type)}
                    onClick={() => addControl(s.type)}
                  >
                    <span className="element-library-icon">{s.icon ?? '▦'}</span>
                    <span className="element-library-name">{s.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
        <div className="element-library-group">
          <div className="element-library-title">内置元素（{builtinElements.length}）</div>
          {builtinElements.length === 0 ? (
            <div className="element-library-empty">内置库暂无元素（资源库面板可新建）。</div>
          ) : (
            <div className="element-library-grid">
              {builtinElements.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className="element-library-item"
                  title={`添加内置元素实例：${e.path}`}
                  draggable
                  onDragStart={(ev) => dragPayload(ev, ELEMENT_DRAG_MIME, e.path)}
                  onClick={() => addElement(e)}
                >
                  <span className="element-library-icon">LIB</span>
                  <span className="element-library-name">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="element-library-group">
          <div className="element-library-title">项目元素（{elements.length}）</div>
          {error ? <div className="element-library-empty">{error}</div> : null}
          {elements.length === 0 ? (
            <div className="element-library-empty">暂无元素（新建 ui/elements/*.elem.json 后出现）</div>
          ) : (
            <div className="element-library-grid">
              {elements
                .filter((e) => !kw || e.name.toLowerCase().includes(kw))
                .map((e) => (
                  <button
                    key={e.path}
                    type="button"
                    className="element-library-item"
                    title={`添加元素实例（可拖入画布）：${e.path}`}
                    draggable
                    onDragStart={(ev) => dragPayload(ev, ELEMENT_DRAG_MIME, e.path)}
                    onClick={() => addElement(e)}
                  >
                    <span className="element-library-icon">EL</span>
                    <span className="element-library-name">{e.name}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
        <div className="element-library-group">
          <div className="element-library-title">预制体（{prefabs.length}）</div>
          {prefabs.length === 0 ? (
            <div className="element-library-empty">暂无预制体（ui/prefabs/*.ui.json）。</div>
          ) : (
            <div className="element-library-grid">
              {prefabs.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className="element-library-item"
                  title={`添加预制体实例（可拖入画布）：${e.path}`}
                  draggable
                  onDragStart={(ev) => dragPayload(ev, PREFAB_DRAG_MIME, e.path)}
                  onClick={() => addPrefab(e)}
                >
                  <span className="element-library-icon">PF</span>
                  <span className="element-library-name">{e.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
