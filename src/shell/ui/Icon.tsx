/**
 * Icon —— 统一图标渲染（UI-REDESIGN §3.1）
 *
 * 全项目图标一律经此组件渲染：默认 14px、strokeWidth 1.75、currentColor。
 * 尺寸仍可按语义覆盖（面板空态 40px、文件树 14px、菜单 14px…）。
 */
import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface IconProps {
  icon: LucideIcon
  /** 像素尺寸，默认 14 */
  size?: number
  /** 描边宽度，默认 1.75 */
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}

export function Icon({ icon: Glyph, size = 14, strokeWidth = 1.75, className, style }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    />
  )
}
