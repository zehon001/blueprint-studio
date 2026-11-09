/**
 * 统一菜单（UI-REDESIGN P2）
 *
 * 保留 v2 的受控 API（x / y / items / onClose）与 DOM 类名（.fs-menu / .fs-menu-item /
 * .fs-menu-sep，测试依赖），在此之上增加：
 *   - 图标 / 快捷键提示 / 危险项 / 分隔线 / 子菜单
 *   - 键盘导航（↑↓ Home End Enter Esc；子菜单 → / ←）
 *   - portal 到 body + 视口翻转 + 最大高度滚动（不被面板裁剪）
 *
 * 样式：panels/file-system/menu.css（各使用方已 import）；本文件不 import CSS，
 * 保持 node:test 可直接挂载。
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

/** 菜单项（separator: true 时为分隔线，忽略其余字段） */
export interface MenuItem {
  /** 菜单项文本 */
  label?: string
  /** 渲染为分隔线 */
  separator?: boolean
  /** 左侧图标 */
  icon?: LucideIcon
  /** 点击回调（执行后菜单自动关闭） */
  onSelect?: () => void
  /** 置灰禁用 */
  disabled?: boolean
  /** 危险操作（删除等，红色文字） */
  danger?: boolean
  /** 右侧弱化提示（如快捷键） */
  hint?: string
  /** hint 的别名（语义化快捷键） */
  shortcut?: string
  /** 子菜单项 */
  children?: readonly MenuItem[]
}

export interface MenuProps {
  /** 视口坐标（通常取 contextmenu 事件的 clientX / clientY） */
  x: number
  y: number
  items: readonly MenuItem[]
  onClose: () => void
}

/** 视口内边距（菜单翻转时保留的最小间隙） */
const VIEWPORT_GAP = 6
/** 子菜单宽度估算（用于判断向左/右展开） */
const SUBMENU_WIDTH = 180
/** 指针离开菜单项后子菜单延迟关闭（跨 portal 移动指针的缓冲） */
const SUBMENU_CLOSE_DELAY_MS = 150

/** 菜单项按钮（含子菜单展开） */
function MenuEntry({
  item,
  onClose,
  autoFocus,
  depth,
}: {
  item: MenuItem
  onClose: () => void
  autoFocus: boolean
  depth: number
}) {
  const [subOpen, setSubOpen] = useState(false)
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const hasChildren = (item.children?.length ?? 0) > 0

  const cancelSubClose = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  /** 打开子菜单：portal 到 body（菜单列表 overflow 裁剪会吞掉行内子菜单），按按钮矩形定位并视口翻转 */
  const openSub = (): void => {
    if (!hasChildren || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    const flip = rect.right + SUBMENU_WIDTH > window.innerWidth - VIEWPORT_GAP
    setSubPos({
      left: flip ? Math.max(VIEWPORT_GAP, rect.left - SUBMENU_WIDTH - 2) : rect.right + 2,
      top: Math.max(VIEWPORT_GAP, rect.top - 4),
    })
    setSubOpen(true)
  }

  const scheduleSubClose = (): void => {
    if (!hasChildren) return
    cancelSubClose()
    closeTimerRef.current = window.setTimeout(() => setSubOpen(false), SUBMENU_CLOSE_DELAY_MS)
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    },
    [],
  )

  return (
    <div
      className="fs-menu-item-wrap"
      onMouseEnter={() => {
        cancelSubClose()
        openSub()
      }}
      onMouseLeave={scheduleSubClose}
    >
      <button
        ref={btnRef}
        type="button"
        role="menuitem"
        aria-haspopup={hasChildren ? 'menu' : undefined}
        aria-expanded={hasChildren ? subOpen : undefined}
        className={`fs-menu-item${item.danger ? ' danger' : ''}`}
        disabled={item.disabled}
        autoFocus={autoFocus}
        onClick={() => {
          if (item.disabled) return
          if (hasChildren) {
            if (subOpen) scheduleSubClose()
            else openSub()
            return
          }
          item.onSelect?.()
          onClose()
        }}
      >
        <span className="fs-menu-icon" aria-hidden>
          {item.icon ? <Icon icon={item.icon} size={14} /> : null}
        </span>
        <span className="fs-menu-label">{item.label}</span>
        {item.hint || item.shortcut ? (
          <span className="fs-menu-hint">{item.hint ?? item.shortcut}</span>
        ) : null}
        {hasChildren ? (
          <span className="fs-menu-chevron" aria-hidden>
            <Icon icon={ChevronRight} size={12} />
          </span>
        ) : null}
      </button>
      {hasChildren && subOpen ? (
        subPos
          ? createPortal(
              <div
                className="fs-menu fs-submenu"
                role="menu"
                data-depth={depth + 1}
                style={{ position: 'fixed', left: subPos.left, top: subPos.top }}
                onMouseEnter={cancelSubClose}
                onMouseLeave={scheduleSubClose}
              >
                {item.children!.map((child, i) =>
                  child.separator ? (
                    <div key={i} className="fs-menu-sep" role="separator" />
                  ) : (
                    <MenuEntry key={i} item={child} onClose={onClose} autoFocus={false} depth={depth + 1} />
                  ),
                )}
              </div>,
              document.body,
            )
          : null
      ) : null}
    </div>
  )
}

/** 菜单项集合（主菜单 / 子菜单共用） */
function MenuList({
  items,
  onClose,
  depth = 0,
}: {
  items: readonly MenuItem[]
  onClose: () => void
  depth?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const firstIndex = items.findIndex((i) => !i.separator && !i.disabled)

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > .fs-menu-item-wrap > .fs-menu-item') ?? [])].filter(
      (b) => !b.disabled,
    )
    if (buttons.length === 0) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      buttons[(index + 1) % buttons.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      buttons[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      buttons[buttons.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div ref={ref} className="fs-menu-list" onKeyDown={onKeyDown}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="fs-menu-sep" role="separator" />
        ) : (
          <MenuEntry key={i} item={item} onClose={onClose} autoFocus={i === firstIndex && depth === 0} depth={depth} />
        ),
      )}
    </div>
  )
}

export function Menu({ x, y, items, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  // 挂载后测量实际尺寸，越界则向视口内翻转
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx =
      x + rect.width > window.innerWidth - VIEWPORT_GAP
        ? Math.max(VIEWPORT_GAP, window.innerWidth - rect.width - VIEWPORT_GAP)
        : x
    const ny =
      y + rect.height > window.innerHeight - VIEWPORT_GAP
        ? Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP)
        : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: Event): void => {
      const target = e.target
      if (ref.current && target instanceof Node && ref.current.contains(target)) return
      // 子菜单 portal 在 body 下（不在 ref 内）：落在任意 .fs-menu 内的按下都视为菜单内
      if (target instanceof Element && target.closest('.fs-menu')) return
      onClose()
    }
    const onKeyDown = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const style: CSSProperties = { left: pos.x, top: pos.y }
  return createPortal(
    <div ref={ref} className="fs-menu" role="menu" style={style}>
      <MenuList items={items} onClose={onClose} />
    </div>,
    document.body,
  )
}
