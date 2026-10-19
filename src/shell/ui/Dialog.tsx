/**
 * Dialog —— 通用模态框（UI-REDESIGN P2/P3）
 *
 * portal 到 body、遮罩 + 居中面板、Esc / 点遮罩关闭、初始焦点与焦点圈定。
 * 用于文件面板 PromptModal、命令面板外壳等；交互回调由调用方提供。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Icon } from './Icon'

export interface DialogProps {
  title: string
  /** 可选标题图标 */
  icon?: ReactNode
  /** 面板宽度（默认 400） */
  width?: number
  onClose: () => void
  children: ReactNode
  /** 底部操作区（按钮组） */
  footer?: ReactNode
  /** 关闭按钮 aria-label */
  closeLabel?: string
}

export function Dialog({
  title,
  icon,
  width = 400,
  onClose,
  children,
  footer,
  closeLabel = '关闭',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const focusable = panel?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusable?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const items = [
        ...panel.querySelectorAll<HTMLElement>(
          'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      restoreRef.current?.focus?.()
    }
  }, [onClose])

  return createPortal(
    <div
      className="ui-dialog-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
      >
        <div className="ui-dialog-head">
          {icon ? <span className="ui-dialog-icon">{icon}</span> : null}
          <span className="ui-dialog-title">{title}</span>
          <button type="button" className="ui-dialog-close" aria-label={closeLabel} onClick={onClose}>
            <Icon icon={X} size={14} />
          </button>
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer ? <div className="ui-dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
