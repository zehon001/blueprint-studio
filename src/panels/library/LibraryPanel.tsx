/**
 * 资源库面板（纯蓝图工作流：仅函数；侧栏两列布局）
 *
 * 条目列表（分类栏 + 列表 = 两列）；选中条目信息直接显示在统一检视器
 * （DetailsHost，与文件系统选中文件一致），面板内不再有详情/预览列。
 * 导入 / 导出 / 冲突处理 / 新建 收纳在顶栏「编辑 → 资源库」菜单（LibraryModals），
 * 面板外改动经 useLibraryUiStore.version 通知本面板重载。
 * 条目右键：打开 / 重命名 / 删除；双击打开函数编辑器。
 */
import { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { openAssetPanel } from '@/shell/dock/assetPanelModel'
import { useSelectionStore } from '@/shell/selection/store'
import { Icon } from '@/shell/ui/Icon'
import { assetIconFor } from '@/shell/ui/icons'
import { Menu, type MenuItem } from '@/panels/file-system/Menu'
import { deleteLibraryEntry, listLibraryEntries, renameLibraryEntry, watchLibrary } from './api'
import { cascadeFunctionRename } from './cascade-fn'
import { useLibraryUiStore } from './ui-store'

type Scope = 'builtin' | 'project'

const PROJECT_DIR = 'library/functions'
const SUFFIX = '.fn.json'

/** 函数条目图标 = 页签同款图标（FunctionSquare），颜色按作用域区分 */
const FN_ICON_SPEC = assetIconFor('function')

interface Entry {
  name: string
  path: string
  size?: number
  mtime?: string
}

export function LibraryPanel() {
  const project = useWorkspaceStore((s) => s.currentProject)
  const [scope, setScope] = useState<Scope>('builtin')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<Entry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** 编辑菜单 / 弹窗改动库内容时自增 → 重载列表 */
  const externalVersion = useLibraryUiStore((s) => s.version)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      if (scope === 'builtin') {
        const list = await listLibraryEntries('functions')
        setEntries(list.map((e) => ({ name: e.name, path: `@library/functions/${e.name}`, size: e.size, mtime: e.mtime })))
      } else {
        if (!project) {
          setEntries([])
          return
        }
        const dir = `${project.path}/${PROJECT_DIR}`
        const r = await fetch(`/api/tree?path=${encodeURIComponent(dir)}`)
        const j = (await r.json()) as { ok?: boolean; tree?: { children?: Array<{ name?: string; path?: string; type?: string }> } }
        const list: Entry[] = []
        for (const c of j.tree?.children ?? []) {
          if (c.type !== 'file' || typeof c.name !== 'string' || !c.name.toLowerCase().endsWith(SUFFIX)) continue
          list.push({
            name: c.name.slice(0, -SUFFIX.length),
            path: `${PROJECT_DIR}/${c.name}`,
          })
        }
        setEntries(list)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [scope, project?.path])

  useEffect(() => {
    void load()
  }, [load, externalVersion])

  /* 资源库条目选择 → 统一检视器显示条目信息 */
  useEffect(() => {
    if (!selected) return
    useSelectionStore.getState().publish({
      source: 'library',
      scope,
      kind: 'function',
      name: selected.name,
      path: selected.path,
    })
  }, [selected, scope])

  useEffect(() => watchLibrary(() => void load()), [load])

  const onOpen = (entry: Entry): void => {
    openAssetPanel('function', entry.path)
  }

  const onRename = async (entry: Entry): Promise<void> => {
    const to = window.prompt(`重命名「${entry.name}」为：`, entry.name)?.trim()
    if (!to || to === entry.name) return
    setBusy(true)
    try {
      const builtin = entry.path.startsWith('@library/')
      if (builtin) {
        await renameLibraryEntry('functions', entry.name, to)
      } else if (project) {
        const from = `${project.path}/${entry.path}`
        const toPath = `${project.path}/${PROJECT_DIR}/${to}${SUFFIX}`
        const r = await fetch('/api/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: toPath }),
        })
        const j = (await r.json()) as { ok?: boolean; message?: string }
        if (!j.ok) throw new Error(j.message ?? '重命名失败')
      }
      // 改名级联当前项目引用
      if (project) {
        await cascadeFunctionRename(project.path, entry.name, to)
      }
      setSelected(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (entry: Entry): Promise<void> => {
    if (!window.confirm(`删除「${entry.name}」？服务端会保留 .history 快照。`)) return
    setBusy(true)
    try {
      if (entry.path.startsWith('@library/')) {
        await deleteLibraryEntry('functions', entry.name)
      } else if (project) {
        await fetch(`/api/file?path=${encodeURIComponent(`${project.path}/${entry.path}`)}`, { method: 'DELETE' })
      }
      setSelected(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rowMenu = (entry: Entry): MenuItem[] => [
    { label: '打开', onSelect: () => onOpen(entry) },
    { label: '重命名…', disabled: busy, onSelect: () => void onRename(entry) },
    { label: '删除', danger: true, disabled: busy, onSelect: () => void onDelete(entry) },
  ]

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
      </div>
      <div className="library-body">
        <div className="library-kinds" role="tablist" aria-label="条目类型">
          <span className="library-kind active">函数</span>
        </div>
        <div className="library-list">
          {entries.length === 0 ? (
            <div className="library-empty">
              {scope === 'project' && !project ? '未打开项目' : '暂无条目（新建见「编辑 → 资源库」）'}
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                type="button"
                className={`library-row${selected?.path === e.path ? ' active' : ''}`}
                onClick={() => setSelected(e)}
                onDoubleClick={() => onOpen(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  setSelected(e)
                  setMenu({ x: ev.clientX, y: ev.clientY, items: rowMenu(e) })
                }}
                title={`${e.name}（双击打开编辑器，右键更多操作）`}
              >
                <Icon
                  icon={FN_ICON_SPEC.icon}
                  size={13}
                  style={{ color: scope === 'builtin' ? 'var(--fn-builtin)' : 'var(--fn-project)' }}
                />
                <span className="library-row-name">{e.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
      {error ? <div className="library-error">{error}</div> : null}
      {menu ? <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}
