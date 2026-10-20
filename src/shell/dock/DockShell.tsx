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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import Toolbar from '@/shell/Toolbar'
import { Icon } from '@/shell/ui/Icon'
import { assetIconFor } from '@/shell/ui/icons'
import { CommandPalette } from '@/shell/ui/CommandPalette'
import { Toaster } from 'sonner'
import { Maximize2, Minimize2, X, LayoutDashboard } from 'lucide-react'
import { StatusBar } from '@/shell/StatusBar'
import { computeDropSide, type Rect } from './dropZone'
import { getPanel } from './registry'
import { useDockStore } from './store'
import {
  assetPanelTitle,
  ensureAssetPanelsInLayout,
  parseAssetPanelId,
  requestClosePanel,
  requestClosePanels,
  syncWorkspaceFromDock,
} from './assetPanel'
import { tabIdOf, useWorkspaceStore } from '@/shell/workspace-store'
import {
  MIN_PANE_PX,
  resizeSashSizes,
  type DockNode,
  type DockSplitNode,
  type DockTabsNode,
  type DropTarget,
} from './tree'
import { PopoutPlaceholder } from '@/shell/windows/PopoutApp'
import { popoutPanel, recallPopout, usePopoutsStore } from '@/shell/windows/popout'
import { ToastHost } from '@/shell/windows/toast'
import { SettingsModalHost } from '@/shell/settings'
import './dock.css'
import '@/shell/windows/windows.css'

/** 拖拽启动位移阈值（px）：低于阈值视为点击（仅激活页签） */
const DRAG_THRESHOLD = 5
/** 分隔条视觉厚度（px）：与 dock.css 的 .dock-sash（--space-1 = 4px）保持一致 */
const SASH_PX = 4

/* ---------------- 拖拽状态 ---------------- */

/** 中央并入目标：组 id + 组相对 dock 区的矩形（高亮用）+ 插入下标（标签重排序用）。
 *  带 caret 表示指针仍在标签栏上：只显示插入光标，不点亮整块区域。 */
type DropInfo =
  | { side: 'left' | 'right' | 'top' | 'bottom' }
  | {
      side: 'center'
      groupId: string
      rect: Rect
      index?: number
      caret?: { left: number; top: number; height: number }
    }

interface DragState {
  panelId: string
  fromPoint: { x: number; y: number }
  /** 当前指针位置（拖拽幽灵跟随用） */
  point: { x: number; y: number }
  /** 是否已超过拖拽阈值 */
  moved: boolean
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

  // v3 T8.1：dock 布局是打开资产的真源 → 补注册动态资产面板 + 同步 workspace 注册表
  useEffect(() => {
    const sync = (): void => {
      const { root } = useDockStore.getState()
      ensureAssetPanelsInLayout(root)
      syncWorkspaceFromDock()
    }
    sync()
    return useDockStore.subscribe(sync)
  }, [])

  const beginDrag = useCallback((panelId: string, from: { x: number; y: number }) => {
    dragRef.current = { panelId, fromPoint: from, point: from, moved: false, drop: null }
    setDrag(dragRef.current)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent): void => {
      const st = dragRef.current
      const area = areaRef.current
      if (!st || !area) return
      const moved = st.moved || dist2(st.fromPoint.x, st.fromPoint.y, e.clientX, e.clientY) >= DRAG_THRESHOLD ** 2
      let drop: DropInfo | null = null
      if (moved) {
        const rect = area.getBoundingClientRect()
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        if (inside) {
          const groupEl = findGroupElAt(e.clientX, e.clientY)
          if (groupEl) {
            const g = groupEl.getBoundingClientRect()
            // 指针在任意 tabs 组的 tab 条上 → 合并进该组（含左右侧栏/底部控制台；
            // 否则这些小面板永远落在整树边缘感应带里，无法作为 center 目标）。
            const onTabBar = e.clientY <= g.top + 30 && e.clientY >= g.top
            if (onTabBar) {
              // 计算插入下标（按 tab 中线比较；排除正在拖拽的标签）→ 支持同组重排序
              const tabEls = Array.from(
                groupEl.querySelectorAll<HTMLElement>('.dock-tab'),
              ).filter((el) => !el.classList.contains('dragging'))
              let index = tabEls.length
              for (let i = 0; i < tabEls.length; i += 1) {
                const tr = tabEls[i].getBoundingClientRect()
                if (e.clientX < tr.left + tr.width / 2) {
                  index = i
                  break
                }
              }
              // 插入光标位置（标签左缘 / 末尾标签右缘）
              const lastRect = tabEls.length
                ? tabEls[tabEls.length - 1].getBoundingClientRect()
                : null
              const caretX =
                index < tabEls.length
                  ? tabEls[index].getBoundingClientRect().left
                  : lastRect
                    ? lastRect.right
                    : g.left + 8
              drop = {
                side: 'center',
                groupId: groupEl.dataset.dockTabs ?? '',
                index,
                caret: {
                  left: caretX - rect.left - 1,
                  top: g.top - rect.top + 4,
                  height: 24,
                },
                rect: {
                  left: g.left - rect.left,
                  top: g.top - rect.top,
                  width: g.width,
                  height: g.height,
                },
              }
            }
          }
          if (!drop) {
            const side = computeDropSide(
              { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              e.clientX,
              e.clientY,
            )
            if (side === 'center') {
              const targetGroup = findGroupElAt(e.clientX, e.clientY)
              if (targetGroup) {
                const g = targetGroup.getBoundingClientRect()
                drop = {
                  side: 'center',
                  groupId: targetGroup.dataset.dockTabs ?? '',
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
      }
      dragRef.current = { ...st, point: { x: e.clientX, y: e.clientY }, moved, drop }
      setDrag(dragRef.current)
    }
    const onUp = (): void => {
      const st = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (st?.drop) {
        const target: DropTarget =
          st.drop.side === 'center'
            ? { kind: 'group', groupId: st.drop.groupId, index: st.drop.index }
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

  // 放置高亮：边 = 1/2 悬浮预览区；中央 = 目标 tabs 组矩形（Godot 式蓝色高亮）。
  // 指针仍在标签栏上时只画插入光标（两标签之间的竖线），不点亮整块区域。
  let overlayStyle: CSSProperties | null = null
  let overlayClass = 'dock-drop-overlay'
  if (drag?.drop && areaRef.current) {
    if (drag.drop.side === 'center') {
      if (drag.drop.caret) {
        const c = drag.drop.caret
        overlayStyle = { left: c.left, top: c.top, width: 2, height: c.height }
        overlayClass = 'dock-tab-caret'
      } else {
        const r = drag.drop.rect
        overlayStyle = { left: r.left, top: r.top, width: r.width, height: r.height }
      }
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
          <div className="dock-empty">
            <Icon icon={LayoutDashboard} size={40} className="dock-empty-icon" />
            <div className="dock-empty-title">没有打开的面板</div>
            <div className="dock-empty-desc">从顶栏「面板」菜单重新打开，或按 Ctrl+K 搜索节点与命令。</div>
          </div>
        )}
        {overlayStyle ? <div className={overlayClass} style={overlayStyle} /> : null}
      </div>
      {/* 拖拽幽灵：被拖标签跟随指针（超过阈值才出现） */}
      {drag?.moved ? (
        <div
          className="dock-tab-ghost"
          style={{ left: drag.point.x + 14, top: drag.point.y + 10 }}
        >
          <DockTabLabel
            panelId={drag.panelId}
            fallback={getPanel(drag.panelId)?.title ?? drag.panelId}
          />
        </div>
      ) : null}
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

/** 资产 tab 标题：类型徽标 + 主名 + 脏标记（v3 T8.1；静态面板回退注册标题） */
function DockTabLabel({ panelId, fallback }: { panelId: string; fallback: string }) {
  const ref = parseAssetPanelId(panelId)
  const tabId = ref ? tabIdOf(ref.kind as Parameters<typeof tabIdOf>[0], ref.path) : ''
  const dirty = useWorkspaceStore((s) => (tabId ? s.openTabs.some((t) => t.id === tabId && t.dirty) : false))
  if (!ref) return <span className="dock-tab-label">{fallback}</span>
  const spec = assetIconFor(ref.kind)
  return (
    <span className="dock-tab-label">
      <span className="dock-tab-badge" aria-hidden>
        <Icon icon={spec.icon} size={13} style={{ color: spec.color }} />
      </span>
      <span className="dock-tab-name">{assetPanelTitle(ref.kind, ref.path)}</span>
      {dirty ? (
        <span className="dock-tab-dirty" title="有未保存修改" aria-label="有未保存修改" />
      ) : null}
    </span>
  )
}

/** tab 右键菜单状态（v3 T8.1：关闭 / 关闭其他 / 关闭右侧） */
interface TabMenuState {
  x: number
  y: number
  panelId: string
  groupId: string
}

/** tab 右键菜单：动作按所属 tabs 组计算；资产面板关闭前逐个脏确认 */
function TabContextMenu({
  state,
  panels,
  onClose,
}: {
  state: TabMenuState
  panels: readonly string[]
  onClose: () => void
}) {
  const index = panels.indexOf(state.panelId)
  const right = index >= 0 ? panels.slice(index + 1) : []
  const others = panels.filter((p) => p !== state.panelId)
  const run = (ids: readonly string[]): void => {
    if (requestClosePanels(ids)) onClose()
  }
  return (
    <div
      className="dock-menu"
      style={{ left: state.x, top: state.y }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
    >
      <button type="button" className="dock-menu-item" onClick={() => (requestClosePanel(state.panelId) ? onClose() : undefined)}>
        关闭
      </button>
      <button
        type="button"
        className="dock-menu-item"
        disabled={others.length === 0}
        onClick={() => run(others)}
      >
        关闭其他
      </button>
      <button
        type="button"
        className="dock-menu-item"
        disabled={right.length === 0}
        onClick={() => run(right)}
      >
        关闭右侧
      </button>
    </div>
  )
}

/** tabs 组：页签条（拖动=移动面板 / 点击=激活）+ 操作区（拆出窗口 ⊞ / 合回 ⊟ / 关闭）+ 页面体 */
function TabsView({ node, dragPanelId }: { node: DockTabsNode; dragPanelId: string | null }) {
  const setTabActive = useDockStore((s) => s.setTabActive)
  const focusPanel = useDockStore((s) => s.focusPanel)
  const beginDrag = useContext(DragContext)
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)

  // 菜单外部点击 / Esc 关闭
  useEffect(() => {
    if (!tabMenu) return
    const close = (): void => setTabMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [tabMenu])
  // 已拆出面板集合（T0.4：主窗该页签显示「已拆出」占位，弹窗关闭 / 合回后自动恢复）
  const popoutSessions = usePopoutsStore((s) => s.sessions)
  const poppedPanelIds = useMemo(() => new Set(Object.keys(popoutSessions)), [popoutSessions])

  const activeIdx = Math.min(Math.max(node.active, 0), Math.max(node.panels.length - 1, 0))
  const activePanelId = node.panels[activeIdx]
  const activeDef = activePanelId !== undefined ? getPanel(activePanelId) : undefined
  const activePopped = activePanelId !== undefined && poppedPanelIds.has(activePanelId)

  const onTabDown = (e: ReactPointerEvent<HTMLDivElement>, panelId: string, index: number): void => {
    const prevActive = useDockStore.getState().activePanelId
    setTabActive(node.id, index)
    // 检视器 tab 只切换显示，不夺走「被检视面板」；否则点它自身也会清空内容
    if (panelId === 'inspector' && prevActive && prevActive !== 'inspector') {
      useDockStore.getState().focusPanel(prevActive)
    }
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
          const popped = poppedPanelIds.has(panelId)
          const cls = [
            'dock-tab',
            i === activeIdx ? 'active' : '',
            dragPanelId === panelId ? 'dragging' : '',
            popped ? 'dock-tab-popped' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={panelId}
              className={cls}
              onPointerDown={(e) => onTabDown(e, panelId, i)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setTabMenu({ x: e.clientX, y: e.clientY, panelId, groupId: node.id })
              }}
              title={def ? `${def.title}${popped ? '（已拆出）' : ''}` : panelId}
            >
              <DockTabLabel panelId={panelId} fallback={def?.title ?? panelId} />
            </div>
          )
        })}
        <div className="dock-tabs-actions">
          {activePopped ? (
            <button
              type="button"
              className="dock-btn"
              title={activeDef ? `合回「${activeDef.title}」` : '合回主窗'}
              aria-label="合回主窗"
              onClick={() => {
                if (activePanelId !== undefined) recallPopout(activePanelId)
              }}
            >
              <Icon icon={Minimize2} size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="dock-btn"
              disabled={activePanelId === undefined}
              title={activeDef ? `拆出「${activeDef.title}」到独立窗口` : '拆出窗口'}
              aria-label="拆出窗口"
              onClick={() => {
                if (activePanelId !== undefined) popoutPanel(activePanelId)
              }}
            >
              <Icon icon={Maximize2} size={14} />
            </button>
          )}
          <button
            type="button"
            className="dock-btn"
            disabled={activePanelId === undefined}
            title={activeDef ? `关闭「${activeDef.title}」` : '关闭'}
            aria-label="关闭面板"
            onClick={() => {
              if (activePanelId !== undefined) requestClosePanel(activePanelId)
            }}
          >
            <Icon icon={X} size={14} />
          </button>
        </div>
      </div>
      <div className="dock-tabs-body">
        {node.panels.map((panelId, i) => {
          const def = getPanel(panelId)
          const popped = poppedPanelIds.has(panelId)
          return (
            <div
              key={panelId}
              className="dock-tab-page"
              style={{ display: i === activeIdx ? undefined : 'none' }}
              onPointerDownCapture={() => {
                // 检视器自身不参与「激活面板」竞争：点它不应把 activePanelId 从
                // 正在检视的 UI/蓝图/文件切走（否则内容立即变「未激活」）
                if (panelId !== 'inspector') focusPanel(panelId)
              }}
            >
              {popped ? (
                <PopoutPlaceholder panelId={panelId} />
              ) : def ? (
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
      {tabMenu ? (
        <TabContextMenu state={tabMenu} panels={node.panels} onClose={() => setTabMenu(null)} />
      ) : null}
    </div>
  )
}

/** 编辑器外壳：顶栏 + dock 区（+ T0.4 全局 toast 容器 + P2 命令面板） */
export default function DockShell() {
  return (
    <div className="shell">
      <Toolbar />
      <DockRoot />
      <StatusBar />
      <CommandPalette />
      <Toaster
        theme="dark"
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 'var(--font-sm)',
          },
        }}
      />
      <ToastHost />
      <SettingsModalHost />
    </div>
  )
}
