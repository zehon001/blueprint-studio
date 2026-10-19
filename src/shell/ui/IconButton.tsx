/**
 * IconButton —— 图标按钮（UI-REDESIGN §3.1）
 *
 * variant: ghost（默认）/ outline / danger；size: sm(24) / md(28)。
 * 必须提供 label：作为 aria-label 与 Tooltip 文案；可选 shortcut 追加到提示。
 * 交互逻辑由调用方传入 onClick，本组件只负责外观与可访问性。
 */
import type { ButtonHTMLAttributes } from 'react'
import { Tooltip } from 'radix-ui'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'
import './ui.css'

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> {
  icon: LucideIcon
  /** 无障碍名称 / Tooltip 文案 */
  label: string
  /** 快捷键提示（如 'Ctrl+S'），追加在 Tooltip 中 */
  shortcut?: string
  variant?: 'ghost' | 'outline' | 'danger'
  size?: 'sm' | 'md'
  /** 激活态（如面板开关） */
  active?: boolean
  iconSize?: number
}

export function IconButton({
  icon,
  label,
  shortcut,
  variant = 'ghost',
  size = 'sm',
  active = false,
  iconSize,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className={['ui-icon-btn', className].filter(Boolean).join(' ')}
          data-variant={variant}
          data-size={size}
          data-active={active || undefined}
          aria-label={label}
          {...rest}
        >
          <Icon icon={icon} size={iconSize ?? (size === 'md' ? 16 : 14)} />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ui-tooltip" sideOffset={6} collisionPadding={8}>
          <span>{label}</span>
          {shortcut ? <kbd className="ui-tooltip-kbd">{shortcut}</kbd> : null}
          <Tooltip.Arrow className="ui-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
