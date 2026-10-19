/**
 * Field —— 检视器控件原语（UI-REDESIGN P4）
 *
 * 统一控件规范：28px 行高、--bg-input 底、focus 强调色描边。
 * - NumberField：等宽数字 + 左右拖拽调节（步长 1，Shift×10，Alt×0.1），可直接输入
 * - TextField / CodeField：单行 / 多行文本
 * - SelectField：Radix Select（菜单浮层与统一菜单同观感）
 * - SwitchField：Radix Switch（36×20，开 = 强调色）
 * - ColorField：色块 + hex 文本 + 原生取色器
 * - AssetField：缩略图 + 名称 + 浏览按钮
 *
 * 样式在 ui.css（由入口 main.tsx / inspector index.ts 挂载）；本文件不 import CSS，
 * 保证 node:test 可直接加载检视器组件。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { Icon } from './Icon'

/** 数值合法性：有限数字 */
function clampValue(n: number, min?: number, max?: number): number {
  let v = n
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

export interface NumberFieldProps {
  value: number | undefined
  mixed?: boolean
  min?: number
  max?: number
  /** 拖拽 / 方向键步长（默认 1） */
  step?: number
  /** int 类型提交前取整 */
  integer?: boolean
  disabled?: boolean
  placeholder?: string
  title?: string
  ariaLabel?: string
  onCommit: (value: number) => void
}

/** 数字字段：拖拽调节 + 输入提交（Enter / 失焦） */
export function NumberField({
  value,
  mixed = false,
  min,
  max,
  step = 1,
  integer = false,
  disabled = false,
  placeholder,
  title,
  ariaLabel,
  onCommit,
}: NumberFieldProps) {
  const initial = mixed || value === undefined || !Number.isFinite(value) ? '' : String(value)
  const [draft, setDraft] = useState(initial)
  const committedRef = useRef(initial)
  const dragRef = useRef<{ startX: number; startValue: number; moved: boolean; next: number } | null>(null)

  useEffect(() => {
    if (committedRef.current === initial) return
    committedRef.current = initial
    setDraft(initial)
  }, [initial])

  const commit = (text = draft): void => {
    const trimmed = text.trim()
    if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
      setDraft(initial)
      return
    }
    let n = Number(trimmed)
    if (integer) n = Math.round(n)
    n = clampValue(n, min, max)
    const next = String(n)
    committedRef.current = next
    setDraft(next)
    onCommit(n)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>): void => {
    if (disabled || e.button !== 0) return
    const start = draft === '' || !Number.isFinite(Number(draft)) ? 0 : Number(draft)
    dragRef.current = { startX: e.clientX, startValue: start, moved: false, next: start }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    if (!drag.moved && Math.abs(dx) < 3) return
    drag.moved = true
    const factor = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
    let next = drag.startValue + dx * step * factor
    if (integer) next = Math.round(next)
    else next = Math.round(next * 1000) / 1000
    next = clampValue(next, min, max)
    drag.next = next
    setDraft(String(next))
  }

  const endDrag = (e: ReactPointerEvent<HTMLInputElement>): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag?.moved) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    committedRef.current = String(drag.next)
    onCommit(drag.next)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      commit()
      e.currentTarget.blur()
      e.stopPropagation()
      return
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const cur = draft === '' || !Number.isFinite(Number(draft)) ? 0 : Number(draft)
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
      let next = cur + delta
      if (integer) next = Math.round(next)
      next = clampValue(next, min, max)
      setDraft(String(next))
      committedRef.current = String(next)
      onCommit(next)
    }
    e.stopPropagation()
  }

  return (
    <input
      type="number"
      step={step}
      className="insp-input insp-number"
      value={draft}
      placeholder={mixed ? '—' : placeholder}
      title={mixed ? '多个值（修改将应用到全部选中节点）' : title}
      aria-label={ariaLabel}
      disabled={disabled}
      spellCheck={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={onKeyDown}
    />
  )
}

export interface TextFieldProps {
  value: string
  mixed?: boolean
  disabled?: boolean
  placeholder?: string
  title?: string
  onCommit: (value: string) => void
}

/** 单行文本：Enter / 失焦提交 */
export function TextField({ value, mixed = false, disabled, placeholder, title, onCommit }: TextFieldProps) {
  const [draft, setDraft] = useState(value)
  const committedRef = useRef(value)
  useEffect(() => {
    if (committedRef.current === value) return
    committedRef.current = value
    setDraft(value)
  }, [value])
  const commit = (): void => {
    if (draft === committedRef.current) return
    committedRef.current = draft
    onCommit(draft)
  }
  return (
    <input
      type="text"
      className="insp-input"
      value={draft}
      placeholder={mixed ? '—' : placeholder}
      title={mixed ? '多个值（修改将应用到全部选中节点）' : title}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
    />
  )
}

export interface CodeFieldProps {
  value: string
  disabled?: boolean
  placeholder?: string
  rows?: number
  onCommit: (value: string) => void
}

/** 多行代码 / JSON 文本（等宽） */
export function CodeField({ value, disabled, placeholder, rows = 4, onCommit }: CodeFieldProps) {
  const [draft, setDraft] = useState(value)
  const committedRef = useRef(value)
  useEffect(() => {
    if (committedRef.current === value) return
    committedRef.current = value
    setDraft(value)
  }, [value])
  return (
    <textarea
      className="insp-textarea"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === committedRef.current) return
        committedRef.current = draft
        onCommit(draft)
      }}
    />
  )
}

export interface SelectOption {
  value: string
  label: string
}

export interface SelectFieldProps {
  value: string
  options: readonly SelectOption[]
  mixed?: boolean
  disabled?: boolean
  title?: string
  ariaLabel?: string
  onCommit: (value: string) => void
}

/** 下拉选择（自绘浮层：与统一菜单同观感；mixed 显示「—」占位） */
export function SelectField({
  value,
  options,
  mixed = false,
  disabled = false,
  title,
  ariaLabel,
  onCommit,
}: SelectFieldProps) {
  const known = options.some((o) => o.value === value)
  const selected = options.find((o) => o.value === value)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0, width: 180 })
  const [highlight, setHighlight] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 空字符串选项不被自绘浮层支持：退回原生 select 保证行为不变
  if (options.some((o) => o.value === '')) {
    return (
      <select
        className="insp-select"
        value={value}
        title={mixed ? '多个值' : title}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value)}
      >
        {mixed || !known ? (
          <option value="" disabled hidden>
            —
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  const openMenu = (): void => {
    if (disabled) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    setPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
      y: rect.bottom + 4,
      width: Math.max(rect.width, 180),
    })
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, options.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const option = options[highlight]
        if (option) {
          onCommit(option.value)
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    const onResize = (): void => setOpen(false)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, options, highlight, onCommit])
  useEffect(() => {
    if (!open) return
    const onScroll = (): void => setOpen(false)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="insp-select insp-select-trigger"
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={mixed ? '多个值（修改将应用到全部选中节点）' : title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className="insp-select-value">{mixed || !known ? '—' : (selected?.label ?? '选择…')}</span>
        <span className="insp-select-caret">
          <Icon icon={ChevronDown} size={12} />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={listRef}
              className="insp-select-content"
              role="listbox"
              style={{ left: pos.x, top: pos.y, width: pos.width }}
            >
              <div className="insp-select-viewport">
                {options.map((o, i) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className="insp-select-item"
                    data-highlighted={i === highlight || undefined}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => {
                      onCommit(o.value)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                  >
                    <span>{o.label}</span>
                    {o.value === value ? (
                      <span className="insp-select-check">
                        <Icon icon={Check} size={12} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

export interface SwitchFieldProps {
  checked: boolean
  mixed?: boolean
  disabled?: boolean
  title?: string
  onCommit: (checked: boolean) => void
}

/** 开关（36×20；开 = 强调色；mixed 显示中间态，点击设为开） */
export function SwitchField({ checked, mixed = false, disabled = false, title, onCommit }: SwitchFieldProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={title ?? '开关'}
      className="insp-switch"
      data-state={mixed ? 'mixed' : checked ? 'checked' : 'unchecked'}
      disabled={disabled}
      title={mixed ? '多个值（修改将应用到全部选中节点）' : title}
      onClick={() => onCommit(mixed ? true : !checked)}
    >
      <span className="insp-switch-thumb" />
    </button>
  )
}

export interface ColorFieldProps {
  value: string | undefined
  mixed?: boolean
  disabled?: boolean
  title?: string
  onCommit: (value: string) => void
}

/** 颜色：色块取色器 + hex 文本 */
export function ColorField({ value, mixed = false, disabled, title, onCommit }: ColorFieldProps) {
  const hex = typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'
  const [draft, setDraft] = useState('')
  useEffect(() => setDraft(''), [hex])
  if (mixed) {
    return (
      <span className="insp-mixed-mark" title="多个值（修改将应用到全部选中节点）">
        —
      </span>
    )
  }
  return (
    <span className="insp-ref">
      <input
        type="color"
        className="insp-color"
        value={hex}
        title={title ?? hex}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value)}
      />
      <input
        type="text"
        className="insp-input insp-hex"
        value={draft === '' ? hex : draft}
        placeholder="#RRGGBB"
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const text = (draft || hex).trim()
          if (/^#[0-9a-fA-F]{6}$/.test(text)) onCommit(text)
          else if (/^[0-9a-fA-F]{6}$/.test(text)) onCommit(`#${text}`)
          setDraft('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
            e.stopPropagation()
          }
        }}
      />
    </span>
  )
}

export interface AssetFieldProps {
  name: string
  /** 缩略图（无图时显示类型图标） */
  thumbnail?: ReactNode
  placeholder?: string
  disabled?: boolean
  onBrowse?: () => void
}

/** 资产引用：缩略图 + 名称 + 浏览按钮 */
export function AssetField({ name, thumbnail, placeholder, disabled, onBrowse }: AssetFieldProps) {
  return (
    <span className="insp-asset-field">
      <span className="insp-asset-thumb" aria-hidden>
        {thumbnail}
      </span>
      <span className="insp-asset-name" title={name || placeholder}>
        {name || placeholder || '未选择'}
      </span>
      <button type="button" className="insp-btn" disabled={disabled} onClick={onBrowse}>
        浏览
      </button>
    </span>
  )
}
