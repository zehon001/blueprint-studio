/**
 * 人员页 UI 原语：Aurabot 风格的下拉、开关、复选、头像、卡片与确认弹窗。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { Dialog } from '@/shell/ui/Dialog'

export interface PpOption {
  value: string
  label: string
  hint?: string
}

export function PpSelect(props: {
  value: string
  options: PpOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  width?: number
}) {
  const { value, options, onChange, placeholder, disabled, ariaLabel, width } = props
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openMenu = (): void => {
    if (disabled) return
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (option: PpOption): void => {
    onChange(option.value)
    setOpen(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        openMenu()
        return
      }
      setHighlight((h) => {
        const delta = e.key === 'ArrowDown' ? 1 : -1
        return (h + delta + options.length) % Math.max(1, options.length)
      })
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (open && options[highlight]) pick(options[highlight])
      else openMenu()
    }
  }

  return (
    <div
      className={`pp-select${open ? ' open' : ''}`}
      ref={rootRef}
      style={width ? { minWidth: width } : undefined}
    >
      <button
        type="button"
        className="pp-select-btn"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`pp-select-value${current ? '' : ' empty'}`}>
          {current?.label ?? placeholder ?? '请选择'}
        </span>
        <ChevronDown size={13} className="pp-select-chev" />
      </button>
      {open ? (
        <div className="pp-select-pop" role="listbox" aria-label={ariaLabel}>
          {options.length === 0 ? <div className="pp-select-empty">暂无选项</div> : null}
          {options.map((option, index) => (
            <button
              key={option.value || `empty-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`pp-select-opt${option.value === value ? ' on' : ''}${
                index === highlight ? ' act' : ''
              }`}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(option)}
            >
              <span className="pp-select-check">
                {option.value === value ? <Check size={12} /> : null}
              </span>
              <span className="pp-select-text">
                <span>{option.label}</span>
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function PpTextField(props: {
  value: string
  onCommit: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const { value, onCommit, placeholder, disabled, className, ariaLabel } = props
  const [draft, setDraft] = useState(value)
  const committed = useRef(value)
  useEffect(() => {
    if (committed.current === value) return
    committed.current = value
    setDraft(value)
  }, [value])
  const commit = (): void => {
    if (draft === committed.current) return
    committed.current = draft
    onCommit(draft)
  }
  return (
    <input
      type="text"
      className={`pp-input${className ? ` ${className}` : ''}`}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
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

export function PpSwitch(props: {
  on: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.ariaLabel}
      className={`pp-switch${props.on ? ' on' : ''}`}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      <span />
    </button>
  )
}

export function PpCheckbox(props: {
  checked: boolean
  onChange: (value: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`pp-check${props.disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span className="pp-check-box">{props.checked ? <Check size={11} /> : null}</span>
      <span>{props.label}</span>
    </label>
  )
}

export function PersonAvatar(props: { name: string; src?: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const size = props.size ?? 36
  useEffect(() => setFailed(false), [props.src])
  const initial = Array.from(props.name.trim())[0] ?? '人'
  return (
    <span className="pp-avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {props.src && !failed ? (
        <img src={props.src} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{initial.toUpperCase()}</span>
      )}
    </span>
  )
}

export function PpSectionCard(props: {
  title?: ReactNode
  desc?: ReactNode
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`pp-card${props.className ? ` ${props.className}` : ''}`}>
      {props.title || props.right ? (
        <div className="pp-card-head">
          <div className="pp-card-heading">
            {props.title ? <h3>{props.title}</h3> : null}
            {props.desc ? <p>{props.desc}</p> : null}
          </div>
          {props.right ? <div className="pp-card-right">{props.right}</div> : null}
        </div>
      ) : null}
      {props.children}
    </section>
  )
}

export function PpRow(props: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="pp-row">
      <div className="pp-row-label">
        <b>{props.label}</b>
        {props.hint ? <small>{props.hint}</small> : null}
      </div>
      <div className="pp-row-control">{props.children}</div>
    </div>
  )
}

export function PpStatus(props: {
  tone: 'idle' | 'running' | 'success' | 'error' | 'warning'
  label: string
}) {
  return (
    <span className={`pp-status pp-status-${props.tone}`}>
      <i />
      {props.label}
    </span>
  )
}

export function PpSpinner() {
  return <Loader2 size={13} className="pp-spin" />
}

export function ConfirmDialog(props: {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      title={props.title}
      width={440}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="pp-btn ghost" onClick={props.onClose} disabled={props.busy}>
            取消
          </button>
          <button
            type="button"
            className={`pp-btn ${props.danger ? 'danger' : 'primary'}`}
            onClick={props.onConfirm}
            disabled={props.busy}
          >
            {props.busy ? '处理中…' : props.confirmLabel ?? '确定'}
          </button>
        </>
      }
    >
      <div className="pp-confirm-text">{props.message}</div>
    </Dialog>
  )
}
