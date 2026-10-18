/**
 * UI 编辑器左栏「元素库」（v3 T11.7 最小版）
 *
 * 分组：基础控件（23 schema）/ 项目元素（ui/elements/*.elem.json）。
 * 点击条目 → 在根节点下追加：基础控件走 commitAddNode；元素追加 __element 实例。
 * 预制体分组与资源库全局管理（内置库/导出导入）随 T11.5/T11.6 服务接入。
 */
import { useEffect, useMemo, useState } from 'react'
import { uiNodeSchemas, NODE_CATEGORIES } from '@/ui-editor/schema'
import { collectNames, commitAddNode } from '@/ui-editor/viewport/commands'
import { getSceneTreeDomain, newUINodeId, runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { useWorkspaceStore } from '@/shell/workspace-store'
import type { UINode } from '@/ir/types'

export const ELEMENT_DIR = 'ui/elements'

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

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const n = `${base}${i}`
    if (!used.has(n)) return n
  }
  return base
}

export function ElementLibraryPanel() {
  const project = useWorkspaceStore((s) => s.currentProject)
  const { asset } = useSceneTreeDomain()
  const [elements, setElements] = useState<ElementEntry[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

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
    return () => {
      alive = false
    }
  }, [project?.path])

  const used = useMemo(() => (asset ? collectNames(asset.root) : new Set<string>()), [asset])
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
    commitAddNode(type, a.root.id, { x: 0, y: 0 })
  }

  const addElement = (entry: ElementEntry): void => {
    const a = getSceneTreeDomain().asset
    if (!a) return
    const id = newUINodeId()
    const name = uniqueName(entry.name, used)
    runUICommand(`元素库：添加元素 ${entry.name}`, (draft) => {
      const root = (draft as { root: UINode }).root
      const node: UINode = {
        id,
        name,
        type: '__element',
        element: entry.path,
        transform: { position: { x: 0, y: 0 }, size: { w: 320, h: 120 }, rotation: 0 },
        layout: { size: { w: 320, h: 120 } },
        theme: {},
        props: {},
        children: [],
      }
      root.children.push(node)
    })
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
                    title={`添加「${s.title}」到根节点（${s.type}）`}
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
          <div className="element-library-title">项目元素（{elements.length}）</div>
          {error ? <div className="element-library-empty">{error}</div> : null}
          {elements.length === 0 ? (
            <div className="element-library-empty">暂无元素（新建 ui/elements/*.elem.json 后出现）</div>
          ) : (
            <div className="element-library-grid">
              {elements.map((e) => (
                <button
                  key={e.path}
                  type="button"
                  className="element-library-item"
                  title={`添加元素实例：${e.path}`}
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
          <div className="element-library-title">预制体</div>
          <div className="element-library-empty">预制体分组随 T11.7 完整版接入（当前可用画布右键「预制体」）。</div>
        </div>
      </div>
    </div>
  )
}
