/**
 * UI 树面板（T1.4 · PLAN §7.2「UI 树面板支持拖拽重排父子、右键…」）
 *
 * 功能：
 *  - 树形：数据源 useSceneTreeDomain().asset.root；缩进树 + 展开/折叠（本地 state）；
 *    行 = schema.icon + name + 类型小字；选中高亮由 store.selection 驱动；
 *    store / 视口选中变化 → 自动展开祖先并 scrollIntoView 定位。
 *  - 双击行内重命名（name 树内唯一，重名拒绝中文提示；入命令栈「树：重命名节点」）。
 *  - 拖拽重排父子：拖到其它行的 上方插入 / 下方插入 / 内部成为子节点（三条落区指示）；
 *    拖到自身或自身子树内拒绝；叶子类型（defaultChildPolicy 'none'）不能有子节点；
 *    落定 runUICommand('树：移动节点')——资产变更后视口自动跟随（共享 scene-tree 域）。
 *  - 右键菜单（复用 file-system/Menu）：节点 = 添加子节点（仅容器）/ 复制 / 重命名 /
 *    附加逻辑资产（占位 T2.6）/ 保存为预制体（占位 T7.3）/ 删除（confirm，含子树，
 *    root 不可删）；空白 / 根 = 添加节点浮层（内联搜索 + NODE_CATEGORIES 分组）。
 *
 * 接线：src/panels/scene-tree/index.ts 的 registerSceneTreePanel() 注册进 dock
 * （id 'scene-tree'；PM 在 defaultPanels.tsx 接线）。全部命令经 commands.ts 入栈。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import { schemaIconFor, uiCategoryColor } from '@/shell/ui/icons'
import { Menu, type MenuItem } from '@/panels/file-system/Menu'
import { validateFileName } from '@/panels/file-system/paths'
import { getUISchema, type UINodeSchema } from '@/ui-editor/schema'
import {
  PREFAB_DIR,
  prefabLabelOf,
  primePrefabCache,
  toPrefabRoot,
} from '@/ui-editor/prefab'
import { openPrefabTab } from '@/ui-editor/prefabTab'
import { collectUINodeIds, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'
import type { UIAsset, UINode } from '@/ir/types'
import { AddNodeMenu } from './AddNodeMenu'
import {
  addUINodeCommand,
  deleteUINodeCommand,
  duplicateUINodeCommand,
  moveUINodeCommand,
  renameUINodeCommand,
  saveAsPrefabCommand,
} from './commands'
import {
  ancestorIds,
  checkDrop,
  findUINodeById,
  flattenTree,
  type DropZone,
  type FlatRow,
} from './tree-model'
// 注意：本组件不 import .css（node:test 需直接加载本文件）；
// 样式由 index.ts（registerSceneTreePanel 应用入口）引入 menu.css + styles.css。

/** toast 自动消失时长 */
const TOAST_MS = 4000

interface ToastState {
  kind: 'success' | 'error' | 'info'
  text: string
}

/** 落区指示状态（三条落区：before / after / inside） */
interface DropTarget {
  id: string
  zone: DropZone
}

/** 右键添加浮层（parentId = 新节点的父级，即根 id 或容器节点 id） */
interface AddMenuState {
  x: number
  y: number
  parentId: string
}

/**
 * 由指针在行内的相对位置计算落区：
 * 中带（25%~75%）→ inside（仅可含子节点的类型），否则上半 before / 下半 after。
 * 根节点行由调用方强制 inside（根没有兄弟位）。
 */
function zoneFromPointer(el: HTMLElement, clientY: number, allowsChildren: boolean): DropZone {
  const rect = el.getBoundingClientRect()
  const rel = (clientY - rect.top) / (rect.height || 1)
  if (allowsChildren && rel > 0.25 && rel < 0.75) return 'inside'
  return rel <= 0.5 ? 'before' : 'after'
}

export function SceneTreePanel() {
  const { asset } = useSceneTreeDomain()
  const status = useUIEditorStore((s) => s.status)
  const message = useUIEditorStore((s) => s.message)
  const selection = useUIEditorStore((s) => s.selection)
  const setSelection = useUIEditorStore((s) => s.setSelection)
  const addSelection = useUIEditorStore((s) => s.addSelection)

  /* —— 本地交互态 —— */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; targetId: string } | null>(null)
  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)

  /** 拖拽中的节点 id（ref：dragover 高频路径不能依赖 state 闭包） */
  const dragIdRef = useRef<string | null>(null)
  /** expanded 镜像（effect 内读取最新值） */
  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  /** 资产镜像（effect / 菜单构建内读取最新值） */
  const assetRef = useRef(asset)
  useEffect(() => {
    assetRef.current = asset
  }, [asset])

  const toastTimerRef = useRef<number | null>(null)
  const showToast = useCallback((kind: ToastState['kind'], text: string): void => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ kind, text })
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])
  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    },
    [],
  )

  /* —— 资产切换：重置展开（默认展开根）—— */
  const rootId = asset?.root.id ?? null
  useEffect(() => {
    if (rootId) setExpanded(new Set([rootId]))
  }, [rootId])

  /* —— 选中联动（store / 视口 / 本面板三处来源同一 selection）：
        自动展开选中节点的祖先 + scrollIntoView 定位 —— */
  const selectionKey = selection.join('\u0000')
  useEffect(() => {
    const root = assetRef.current?.root
    if (!root || selection.length === 0) return
    const id = selection[selection.length - 1]
    if (!findUINodeById(root, id)) return
    const anc = ancestorIds(root, id)
    if (anc.some((a) => !expandedRef.current.has(a))) {
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const a of anc) next.add(a)
        return next
      })
    }
    const el = document.querySelector(`[data-node-id="${id}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, rootId, expanded])

  /* ============================================================
   * 交互处理
   * ============================================================ */

  const toggleExpand = useCallback((id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  function selectRow(node: UINode, e: ReactMouseEvent): void {
    if (e.shiftKey || e.ctrlKey || e.metaKey) addSelection([node.id])
    else setSelection([node.id])
  }

  function startRename(node: UINode): void {
    setRenamingId(node.id)
    setRenameDraft(node.name)
  }

  function commitRename(): void {
    const id = renamingId
    if (!id) return
    const r = renameUINodeCommand(id, renameDraft)
    if (r === 'empty') {
      showToast('error', '名称不能为空')
      return // 保留行内编辑态，便于修正
    }
    if (r === 'duplicate') {
      showToast('error', `重命名失败：名称「${renameDraft.trim()}」已存在（name 树内唯一）`)
      return
    }
    setRenamingId(null)
  }

  /** 复制子树：入栈「树：复制节点」并选中新副本 */
  function duplicateNode(node: UINode): void {
    const newId = duplicateUINodeCommand(node.id)
    if (!newId) {
      showToast('error', node.id === asset?.root.id ? '根节点不可复制' : '复制失败')
      return
    }
    setSelection([newId])
    showToast('success', `已复制为「${findUINodeById(assetRef.current!.root, newId)?.name ?? ''}」`)
  }

  /** 删除节点（confirm，含子树；root 不可删） */
  function deleteNode(node: UINode): void {
    const assetNow = assetRef.current
    if (!assetNow) return
    if (node.id === assetNow.root.id) {
      showToast('error', '根节点不可删除')
      return
    }
    const count = collectUINodeIds(node).length - 1
    const msg = count > 0 ? `确定删除「${node.name}」及其 ${count} 个子节点？` : `确定删除「${node.name}」？`
    if (!window.confirm(msg)) return
    const removedIds = new Set(collectUINodeIds(node))
    if (!deleteUINodeCommand(node.id)) return
    setSelection(useUIEditorStore.getState().selection.filter((s) => !removedIds.has(s)))
  }

  /** 添加节点浮层选中 → 入栈「树：添加节点」+ 展开父级 + 选中新节点 */
  function pickAdd(schema: UINodeSchema): void {
    if (!addMenu) return
    const parentId = addMenu.parentId
    setAddMenu(null)
    const newId = addUINodeCommand(schema.type, parentId)
    if (!newId) {
      showToast('error', '添加节点失败')
      return
    }
    setExpanded((prev) => new Set(prev).add(parentId))
    setSelection([newId])
  }

  /* ============================================================
   * 预制体（T7.3 · ADR-009）
   * ============================================================ */

  /** 保存为预制体：确认名 → 子树写出 ui/prefabs/<名>.ui.json → 节点转为实例（可撤销） */
  async function saveAsPrefab(node: UINode): Promise<void> {
    const assetNow = assetRef.current
    const projectPath = useUIEditorStore.getState().projectPath
    if (!assetNow || !projectPath) return
    if (node.id === assetNow.root.id) {
      showToast('error', '根节点不能保存为预制体（整资产没有宿主可引用）')
      return
    }
    const raw = window.prompt(`保存「${node.name}」为预制体（写入 ${PREFAB_DIR}/，输入文件名）`, node.name)
    if (raw === null) return // 取消
    const stem = raw.trim().replace(/\.ui\.json$/i, '')
    if (!stem) {
      showToast('error', '预制体名称不能为空')
      return
    }
    const fileName = `${stem}.ui.json`
    const invalid = validateFileName(fileName)
    if (invalid) {
      showToast('error', invalid)
      return
    }
    const path = `${PREFAB_DIR}/${fileName}`
    // 预制体定义 = 节点子树深拷贝；events/logicAsset 属实例装配，不写入预制体（ADR-009 §5）
    const prefabAsset: UIAsset = { version: 2, name: prefabLabelOf(path), root: toPrefabRoot(node) }
    try {
      const r = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: `${projectPath}/${path}`,
          content: `${JSON.stringify(prefabAsset, null, 2)}\n`,
        }),
      })
      const json = (await r.json()) as { ok?: boolean; message?: string }
      if (!json.ok) {
        showToast('error', `保存预制体失败：${json.message ?? ''}`)
        return
      }
    } catch (err) {
      showToast('error', `保存预制体失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    primePrefabCache(path, prefabAsset) // 本地内容立即可用，免去回读
    if (!saveAsPrefabCommand(node.id, path)) return
    setSelection([node.id])
    showToast('success', `已保存预制体 ${path}；右键实例 → 编辑预制体可继续修改`)
  }

  /* ============================================================
   * 右键菜单
   * ============================================================ */

  function openMenuAt(e: ReactMouseEvent, targetId: string): void {
    setMenu({ x: e.clientX, y: e.clientY, targetId })
  }

  function nodeMenuItems(node: UINode): MenuItem[] {
    const schema = getUISchema(node.type)
    const isContainer = schema?.defaultChildPolicy === 'container'
    // ADR-009：实例节点结构以预制体为准——拒收子节点，菜单按实例/普通分叉
    const items: MenuItem[] = [
      {
        label: '添加子节点',
        disabled: !isContainer || !!node.prefab,
        hint: node.prefab ? '结构以预制体为准' : isContainer ? undefined : '仅容器类型',
        onSelect: () => {
          if (menu) setAddMenu({ x: menu.x, y: menu.y, parentId: node.id })
        },
      },
      { label: '复制', onSelect: () => duplicateNode(node) },
      { label: '重命名', onSelect: () => startRename(node) },
      { label: '附加逻辑资产', onSelect: () => showToast('info', 'T2.6 接入') },
    ]
    if (node.prefab) {
      items.push({
        label: `编辑预制体（${prefabLabelOf(node.prefab)}）`,
        onSelect: () => openPrefabTab(node.prefab as string),
      })
    } else {
      items.push({ label: '保存为预制体', onSelect: () => void saveAsPrefab(node) })
    }
    items.push({ separator: true }, { label: '删除', danger: true, onSelect: () => deleteNode(node) })
    return items
  }

  /* ============================================================
   * 渲染
   * ============================================================ */

  const rows: FlatRow[] = asset ? flattenTree(asset.root, expanded) : []

  function renderRow(row: FlatRow): ReactNode {
    const { node, depth, hasChildren } = row
    const schema = getUISchema(node.type)
    const isRoot = node.id === rootId
    const isRenaming = renamingId === node.id
    const dropZone = drop && drop.id === node.id ? drop.zone : null
    return (
      <Fragment key={node.id}>
        <div
          data-node-id={node.id}
          className={
            `st-row${selection.includes(node.id) ? ' selected' : ''}` +
            `${draggingId === node.id ? ' dragging' : ''}` +
            `${dropZone ? ` drop-${dropZone}` : ''}`
          }
          style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-5))` }}
          title={`${node.name}（${schema?.title ?? node.type}）`}
          draggable={!isRoot && !isRenaming}
          onClick={(e) => {
            if (isRenaming) return
            selectRow(node, e)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (isRenaming) return
            // ADR-009（T7.3）：双击实例节点进入预制体编辑（打开该 .ui.json 为新 tab）；
            // 普通节点保持行内重命名。
            if (node.prefab) openPrefabTab(node.prefab)
            else startRename(node)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            selectRow(node, e)
            if (isRoot) setAddMenu({ x: e.clientX, y: e.clientY, parentId: asset!.root.id })
            else openMenuAt(e, node.id)
          }}
          onDragStart={(e) => {
            if (isRoot) {
              e.preventDefault()
              return
            }
            dragIdRef.current = node.id
            setDraggingId(node.id)
            try {
              e.dataTransfer?.setData('text/plain', node.id)
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
            } catch {
              /* happy-dom 等环境可能不支持 DataTransfer */
            }
          }}
          onDragOver={(e) => {
            const dragId = dragIdRef.current
            if (!dragId || !assetRef.current) return
            const allowsChildren = getUISchema(node.type)?.defaultChildPolicy !== 'none'
            const zone = isRoot ? 'inside' : zoneFromPointer(e.currentTarget as HTMLElement, e.clientY, allowsChildren)
            if (!checkDrop(assetRef.current.root, dragId, node.id, zone).ok) {
              setDrop(null)
              return
            }
            e.preventDefault()
            try {
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            } catch {
              /* 忽略 */
            }
            setDrop((prev) => (prev && prev.id === node.id && prev.zone === zone ? prev : { id: node.id, zone }))
          }}
          onDragLeave={(e) => {
            const related = e.relatedTarget as Node | null
            if (related && (e.currentTarget as HTMLElement).contains(related)) return
            setDrop(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            const dragId = dragIdRef.current
            dragIdRef.current = null
            setDraggingId(null)
            setDrop(null)
            if (!dragId || !assetRef.current) return
            const allowsChildren = getUISchema(node.type)?.defaultChildPolicy !== 'none'
            const zone = isRoot ? 'inside' : zoneFromPointer(e.currentTarget as HTMLElement, e.clientY, allowsChildren)
            if (!moveUINodeCommand(dragId, node.id, zone)) {
              const reason = checkDrop(assetRef.current.root, dragId, node.id, zone).reason
              if (reason) showToast('error', `无法移动：${reason}`)
              return
            }
            if (zone === 'inside') setExpanded((prev) => new Set(prev).add(node.id))
          }}
          onDragEnd={() => {
            dragIdRef.current = null
            setDraggingId(null)
            setDrop(null)
          }}
        >
          {hasChildren ? (
            <span
              className="st-chevron"
              title={expanded.has(node.id) ? '折叠' : '展开'}
              onClick={(e) => {
                e.stopPropagation()
                toggleExpand(node.id)
              }}
            >
              {expanded.has(node.id) ? <Icon icon={ChevronDown} size={12} /> : <Icon icon={ChevronRight} size={12} />}
            </span>
          ) : (
            <span className="st-chevron st-chevron--ghost" aria-hidden />
          )}
          <span className="st-icon" aria-hidden>
            <Icon
              icon={schemaIconFor(node.type, schema?.category)}
              size={14}
              style={{ color: uiCategoryColor(schema?.category) }}
            />
          </span>
          {isRenaming ? (
            <input
              className="st-rename-input"
              value={renameDraft}
              spellCheck={false}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                else if (e.key === 'Escape') setRenamingId(null)
              }}
              onBlur={() => setRenamingId(null)}
            />
          ) : (
            <span className="st-name">{node.name}</span>
          )}
          {node.prefab ? (
            <span className="st-prefab" title={`预制体：${node.prefab}（双击进入编辑）`}>
              ⧉ {prefabLabelOf(node.prefab)}
            </span>
          ) : null}
          <span className="st-type">{schema?.title ?? node.type}</span>
        </div>
      </Fragment>
    )
  }

  return (
    <div
      className="st-panel"
      onContextMenu={(e) => {
        e.preventDefault()
        if (asset) setAddMenu({ x: e.clientX, y: e.clientY, parentId: asset.root.id })
      }}
      onPointerDown={(e) => {
        // 点击空白清除选中（行内已 stopPropagation）
        if (e.target === e.currentTarget) useUIEditorStore.getState().clearSelection()
      }}
    >
      <div className="st-scroll">
        {asset ? (
          rows.map(renderRow)
        ) : (
          <div className="st-empty">
            {status === 'loading'
              ? '加载中…'
              : status === 'error'
                ? message || '加载失败'
                : '未打开 UI（文件面板双击 .ui.json）'}
          </div>
        )}
      </div>
      {menu && asset ? (
        <Menu
          x={menu.x}
          y={menu.y}
          items={nodeMenuItems(findUINodeById(asset.root, menu.targetId) ?? asset.root)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {addMenu ? <AddNodeMenu x={addMenu.x} y={addMenu.y} onPick={pickAdd} onClose={() => setAddMenu(null)} /> : null}
      {toast ? <div className={`st-toast ${toast.kind}`}>{toast.text}</div> : null}
    </div>
  )
}
