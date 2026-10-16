/**
 * 通用右键菜单（T0.7 · PLAN §6.3「右键上下文菜单 everywhere」）
 *
 * 通用化设计：任意面板（UI 树 T1.4 / 蓝图结构面板 T2.3 等）复用。
 * 用法（受控渲染，由调用方持有开合状态）：
 * ```tsx
 * const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
 * <div onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items }) }} />
 * {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
 * ```
 *
 * 行为：portal 渲染到 document.body（不受面板 overflow 裁剪）；视口边缘自动翻转；
 * 点击菜单外（pointerdown）/ Esc / 窗口 resize 关闭；点击菜单项 → onSelect() 后自动关闭。
 *
 * 注意：本文件不 import 样式（node:test 环境 tsx 无法加载 .css）；
 * menu.css 由使用方面板 import（FileSystemPanel.tsx 已引入）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'

/** 菜单项（separator: true 时为分隔线，忽略其余字段） */
export interface MenuItem {
  /** 菜单项文本 */
  label?: string
  /** 渲染为分隔线 */
  separator?: boolean
  /** 点击回调（执行后菜单自动关闭） */
  onSelect?: () => void
  /** 置灰禁用 */
  disabled?: boolean
  /** 危险操作（删除等，红色文字） */
  danger?: boolean
  /** 右侧弱化提示（如快捷键） */
  hint?: string
}

export interface MenuProps {
  /** 视口坐标（通常取 contextmenu 事件的 clientX / clientY） */
  x: number
  y: number
  items: readonly MenuItem[]
  onClose: () => void
}

/** 视口内边距（菜单翻转时保留的最小间隙） */
const VIEWPORT_GAP = 4

export function Menu({ x, y, items, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x, y })

  // 挂载后测量实际尺寸，越界则向视口内翻转
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const nx = x + rect.width > window.innerWidth - VIEWPORT_GAP ? Math.max(VIEWPORT_GAP, window.innerWidth - rect.width - VIEWPORT_GAP) : x
    const ny = y + rect.height > window.innerHeight - VIEWPORT_GAP ? Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (e: Event): void => {
      const target = e.target
      if (ref.current && target instanceof Node && ref.current.contains(target)) return
      onClose()
    }
    const onKeyDown = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Escape') onClose()
    }
    // capture：外部任何按下/按键先关掉；监听 document（事件传播路径必经），resize 挂 window
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const style: CSSProperties = { left: pos.x, top: pos.y }
  return createPortal(
    <div ref={ref} className="fs-menu" role="menu" style={style}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="fs-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`fs-menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect?.()
              onClose()
            }}
          >
            <span className="fs-menu-label">{item.label}</span>
            {item.hint ? <span className="fs-menu-hint">{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
