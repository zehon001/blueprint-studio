/**
 * Dock 外壳（T0.3 · PLAN §6 编辑器外壳 / §6.2 主编辑器布局）
 *
 * 组成：顶栏（Toolbar）+ 布局树递归渲染（split → 分隔条 + 子树；tabs → 页签组）。
 * 交互编排（本文件）：面板页签可拖动 → 拖到主窗四边显示 1/2 悬浮高亮、
 * 中央显示并入 tabs 组高亮 → 松手经 store.movePanelTo 落树；
 * split 间分隔条可拖动调宽（最小 120px，计算在 tree.resizeSashSizes）。
 * 纯逻辑（布局树操作 / 落点判定）在 tree.ts / dropZone.ts，均有单测。
 */
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import Toolbar from '@/shell/Toolbar'
import { computeDropSide, type Rect } from './dropZone'
import { getPanel } from './registry'
import { useDockStore } from './store'
import {
  MIN_PANE_PX,
  resizeSashSizes,
  type DockNode,
  type DockSplitNode,
  type DockTabsNode,
  type DropTarget,
} from './tree'
import './dock.css'

/** 拖拽启动位移阈值（px）：低于阈值视为点击（仅激活页签） */
const DRAG_THRESHOLD = 5
/** 分隔条视觉厚度（px）：与 dock.css 的 .dock-sash（--space-1 = 4px）保持一致 */
const SASH_PX = 4

/* ---------------- 拖拽状态 ---------------- */

/** 中央并入目标：组 id + 组相对 dock 区的矩形（高亮用） */
type DropInfo =
  | { side: 'left' | 'right' | 'top' | 'bottom' }
  | { side: 'center'; groupId: string; rect: Rect }

interface DragState {
  panelId: string
  fromPoint: { x: number; y: number }
  drop: DropInfo | null
}

interface DockDragApi {
  /** 页签 pointerdown 后调用：登记待拖面板（移动超阈值才进入拖拽态） */
  beginDrag: (panelId: string, from: { x: number; y: number }) => void
}

const DragContext = createContext<DockDragApi | null>(null)

/** 取指针处的 tabs 组元素（data-dock-tabs 标记） */
function findGroupElAt(x: number, y: number): HTMLElement | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const group = el.closest('[data-dock-tabs]')
    if (group instanceof HTMLElement) return group
  }
  return null
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) ** 2 + (ay - by) ** 2
}

/* ---------------- dock 区根：拖拽生命周期编排 ---------------- */

function DockRoot() {
  const root = useDockStore((s) => s.root)
  const movePanelTo = useDockStore((s) => s.movePanelTo)
  const areaRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragging = drag !== null

  const beginDrag = useCallback((panelId: string, from: { x: number; y: number }) => {
    dragRef.current = { panelId, fromPoint: from, drop: null }
    setDrag(dragRef.current)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const st = dragRef.current
      const area = areaRef.current
      if (!st || !area) return
      let drop: DropInfo | null = null
      if (dist2(st.fromPoint.x, st.fromPoint.y, e.clientX, e.clientY) >= DRAG_THRESHOLD ** 2) {
        const rect = area.getBoundingClientRect()
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        if (inside) {
          const side = computeDropSide(
            { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            e.clientX,
            e.clientY,
          )
          if (side === 'center') {
            const groupEl = findGroupElAt(e.clientX, e.clientY)
            if (groupEl) {
              const g = groupEl.getBoundingClientRect()
              drop = {
                side: 'center',
                groupId: groupEl.dataset.dockTabs ?? '',
                rect: {
                  left: g.left - rect.left,
                  top: g.top - rect.top,
                  width: g.width,
                  height: g.height,
                },
              }
            }
          } else {
            drop = { side }
          }
        }
      }
      dragRef.current = { ...st, drop }
      setDrag(dragRef.current)
    }
    const onUp = (): void => {
      const st = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (st?.drop) {
        const target: DropTarget =
          st.drop.side === 'center'
            ? { kind: 'group', groupId: st.drop.groupId }
            : { kind: 'edge', side: st.drop.side }
        movePanelTo(st.panelId, target)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [dragging, movePanelTo])

  // 出现有效落点后：全局抓取光标 + 禁止选中文本
  const dropping = drag?.drop != null
  useEffect(() => {
    if (!dropping) return
    document.body.classList.add('dock-dragging')
    return () => document.body.classList.remove('dock-dragging')
  }, [dropping])

  // 放置高亮：边 = 1/2 悬浮预览区；中央 = 目标 tabs 组矩形（Godot 式蓝色高亮）
  let overlayStyle: CSSProperties | null = null
  if (drag?.drop && areaRef.current) {
    if (drag.drop.side === 'center') {
      const r = drag.drop.rect
      overlayStyle = { left: r.left, top: r.top, width: r.width, height: r.height }
    } else {
      const w = areaRef.current.clientWidth
      const h = areaRef.current.clientHeight
      const half = { left: 0, top: 0, width: w, height: h }
      if (drag.drop.side === 'left') half.width = w / 2
      else if (drag.drop.side === 'right') {
        half.left = w / 2
        half.width = w / 2
      } else if (drag.drop.side === 'top') half.height = h / 2
      else {
        half.top = h / 2
        half.height = h / 2
      }
      overlayStyle = half
    }
  }

  return (
    <DragContext.Provider value={{ beginDrag }}>
      <div className="dock-area" ref={areaRef}>
        {root ? (
          <DockNodeView node={root} path={[]} dragPanelId={drag?.panelId ?? null} />
        ) : (
          <div className="dock-empty">没有打开的面板 —— 可经顶栏「面板」菜单重新打开。</div>
        )}
        {overlayStyle ? <div className="dock-drop-overlay" style={overlayStyle} /> : null}
      </div>
    </DragContext.Provider>
  )
}

/* ---------------- 布局树渲染 ---------------- */

/** 布局树节点分派 */
function DockNodeView({
  node,
  path,
  dragPanelId,
}: {
  node: DockNode
  path: number[]
  dragPanelId: string | null
}) {
  return node.kind === 'split' ? (
    <SplitView node={node} path={path} dragPanelId={dragPanelId} />
  ) : (
    <TabsView node={node} dragPanelId={dragPanelId} />
  )
}

/** split 节点：子树按 sizes 权重排列，相邻子树之间放可拖动分隔条 */
function SplitView({
  node,
  path,
  dragPanelId,
}: {
  node: DockSplitNode
  path: number[]
  dragPanelId: string | null
}) {
  const setSizes = useDockStore((s) => s.setSizes)

  const onSashDown = (e: ReactPointerEvent<HTMLDivElement>, index: number): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const parent = e.currentTarget.parentElement
    if (!parent) return
    // 指针捕获：快速拖出窗口也能持续收到 pointermove/up（事件仍冒泡到 window）
    e.currentTarget.setPointerCapture(e.pointerId)
    const total = node.dir === 'h' ? parent.clientWidth : parent.clientHeight
    const sashTotal = SASH_PX * (node.children.length - 1)
    const baseSizes = node.sizes.slice()
    const startPos = node.dir === 'h' ? e.clientX : e.clientY
    const sashEl = e.currentTarget
    sashEl.classList.add('dock-sash-active')
    const onMove = (ev: PointerEvent): void => {
      const pos = node.dir === 'h' ? ev.clientX : ev.clientY
      setSizes(path, resizeSashSizes(baseSizes, index, pos - startPos, total - sashTotal, MIN_PANE_PX))
    }
    const onUp = (): void => {
      sashEl.classList.remove('dock-sash-active')
      document.body.classList.remove('dock-resizing', `dock-resizing-${node.dir}`)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    document.body.classList.add('dock-resizing', `dock-resizing-${node.dir}`)
  }

  return (
    <div className={`dock-split dock-split-${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.kind === 'tabs' ? child.id : `split-${i}`}>
          {i > 0 ? (
            <div
              className={`dock-sash dock-sash-${node.dir}`}
              onPointerDown={(e) => onSashDown(e, i - 1)}
            />
          ) : null}
          <div
            className="dock-pane"
            style={{
              flexGrow: node.sizes[i] ?? 1,
              flexBasis: 0,
              minWidth: MIN_PANE_PX,
              minHeight: MIN_PANE_PX,
            }}
          >
            <DockNodeView node={child} path={[...path, i]} dragPanelId={dragPanelId} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

/** tabs 组：页签条（拖动=移动面板 / 点击=激活）+ 操作区（拆出窗口 / 关闭）+ 页面体 */
function TabsView({ node, dragPanelId }: { node: DockTabsNode; dragPanelId: string | null }) {
  const setTabActive = useDockStore((s) => s.setTabActive)
  const closePanel = useDockStore((s) => s.closePanel)
  const beginDrag = useContext(DragContext)

  const activeIdx = Math.min(Math.max(node.active, 0), Math.max(node.panels.length - 1, 0))
  const activePanelId = node.panels[activeIdx]
  const activeDef = activePanelId !== undefined ? getPanel(activePanelId) : undefined

  const onTabDown = (e: ReactPointerEvent<HTMLDivElement>, panelId: string, index: number): void => {
    setTabActive(node.id, index)
    if (e.button === 0) {
      // 指针捕获：快速拖出窗口也能持续收到 pointermove/up（事件仍冒泡到 window）
      e.currentTarget.setPointerCapture(e.pointerId)
      beginDrag?.beginDrag(panelId, { x: e.clientX, y: e.clientY })
    }
  }

  return (
    <div className="dock-tabs" data-dock-tabs={node.id}>
      <div className="dock-tabs-bar">
        {node.panels.map((panelId, i) => {
          const def = getPanel(panelId)
          const cls = [
            'dock-tab',
            i === activeIdx ? 'active' : '',
            dragPanelId === panelId ? 'dragging' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={panelId}
              className={cls}
              onPointerDown={(e) => onTabDown(e, panelId, i)}
              title={def?.title ?? panelId}
            >
              <span className="dock-tab-label">{def?.title ?? panelId}</span>
            </div>
          )
        })}
        <div className="dock-tabs-actions">
          <button type="button" className="dock-btn" disabled title="拆出窗口（T0.4 接入）">
            ⊞
          </button>
          <button
            type="button"
            className="dock-btn"
            disabled={activePanelId === undefined}
            title={activeDef ? `关闭「${activeDef.title}」` : '关闭'}
            onClick={() => {
              if (activePanelId !== undefined) closePanel(activePanelId)
            }}
          >
            ×
          </button>
        </div>
      </div>
      <div className="dock-tabs-body">
        {node.panels.map((panelId, i) => {
          const def = getPanel(panelId)
          return (
            <div
              key={panelId}
              className="dock-tab-page"
              style={{ display: i === activeIdx ? undefined : 'none' }}
            >
              {def ? (
                <def.component />
              ) : (
                <div className="dock-panel-placeholder">未知面板：{panelId}</div>
              )}
            </div>
          )
        })}
        {node.panels.length === 0 ? (
          <div className="dock-panel-placeholder">（空面板组）</div>
        ) : null}
      </div>
    </div>
  )
}

/** 编辑器外壳：顶栏 + dock 区 */
export default function DockShell() {
  return (
    <div className="shell">
      <Toolbar />
      <DockRoot />
    </div>
  )
}
