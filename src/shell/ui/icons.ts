/**
 * 中央文件类型图标映射（UI-REDESIGN §3.2）
 *
 * 文件树 / 标签页 / 面包屑 / 检视器共用；颜色返回 CSS 变量或固定语义色，
 * 供 <Icon style={{ color }} /> 使用。
 */
import {
  AlignLeft,
  Box,
  Boxes,
  Braces,
  Calculator,
  ChevronsUpDown,
  Columns2,
  Columns3,
  Cpu,
  File,
  FileCode2,
  FileImage,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  FormInput,
  FunctionSquare,
  Gauge,
  GitBranch,
  Hash,
  Image as ImageIcon,
  LayoutGrid,
  List,
  ListTree,
  Minus,
  MousePointerClick,
  Package,
  Palette,
  PanelTop,
  PanelsTopLeft,
  Plug,
  Puzzle,
  RefreshCw,
  Rows3,
  ScrollText,
  SlidersHorizontal,
  SquareCheck,
  Table2,
  Text,
  TextCursorInput,
  Type,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'

export interface FileIconSpec {
  icon: LucideIcon
  /** 图标颜色（CSS 变量或语义色） */
  color: string
}

const DIM = 'var(--text-dim)'
const ACCENT = 'var(--accent)'
const BP = '#f5b544'
const UI = '#3ecf8e'
const CODE = '#5b8cff'
const STYLE = '#b48bff'
const ELEMENT = '#ff9f6e'
const PLUGIN = '#6ee7f9'
const IMAGE = '#3ecf8e'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/i

export interface FileIconOptions {
  isDir?: boolean
  /** 文件夹是否展开（决定 Folder/FolderOpen） */
  expanded?: boolean
}

/**
 * 按文件 / 文件夹名返回图标与颜色。
 * 目录按语义目录名（styles / elements / plugins）给专用图标，其余按文件后缀。
 */
export function fileIconFor(name: string, opts: FileIconOptions = {}): FileIconSpec {
  const { isDir = false, expanded = false } = opts

  if (isDir) {
    switch (name.toLowerCase()) {
      case 'styles':
        return { icon: Palette, color: STYLE }
      case 'elements':
        return { icon: Box, color: ELEMENT }
      case 'plugins':
        return { icon: Plug, color: PLUGIN }
      case 'assets':
        return { icon: FileImage, color: IMAGE }
      default:
        return { icon: expanded ? FolderOpen : Folder, color: DIM }
    }
  }

  if (name === 'project.json') return { icon: FileJson2, color: BP }
  if (name.endsWith('.bp.json')) return { icon: Workflow, color: BP }
  if (name.endsWith('.ui.json')) return { icon: LayoutGrid, color: UI }
  if (IMAGE_RE.test(name)) return { icon: FileImage, color: IMAGE }
  if (CODE_RE.test(name)) return { icon: FileCode2, color: CODE }
  if (/\.md$/i.test(name)) return { icon: FileText, color: DIM }
  if (/\.json$/i.test(name)) return { icon: FileJson2, color: DIM }
  return { icon: File, color: DIM }
}

/** 项目根图标 */
export const PROJECT_ICON: FileIconSpec = { icon: Package, color: ACCENT }

/** 资产面板类型 → 图标（dock 页签 / 检视器信息壳共用） */
export function assetIconFor(kind: string): FileIconSpec {
  switch (kind) {
    case 'ui':
      return { icon: LayoutGrid, color: UI }
    case 'blueprint':
      return { icon: Workflow, color: BP }
    case 'script':
      return { icon: FileCode2, color: CODE }
    case 'style':
      return { icon: Palette, color: STYLE }
    case 'element':
      return { icon: Box, color: ELEMENT }
    case 'function':
      return { icon: FunctionSquare, color: CODE }
    default:
      return { icon: File, color: DIM }
  }
}

/** UI 节点 schema 分类色（节点库 / 树 / 检视器分类块共用） */
export const UI_CATEGORY_COLORS: Readonly<Record<string, string>> = {
  容器: CODE,
  显示: UI,
  输入: BP,
  数据: STYLE,
}

/** 分类色（未知分类回退强调色） */
export function uiCategoryColor(category: string | undefined): string {
  return (category && UI_CATEGORY_COLORS[category]) || ACCENT
}

/** 蓝图节点分类图标（右键菜单 / 命令面板 / 节点库共用） */
export function nodeCategoryIcon(category: string | undefined): LucideIcon {
  switch (category) {
    case '流程':
      return GitBranch
    case '事件':
      return Zap
    case '变量':
      return Braces
    case '数学':
      return Calculator
    case '字符串':
      return Type
    case '容器':
      return Boxes
    case '转换':
      return RefreshCw
    case '界面':
      return LayoutGrid
    case '系统':
      return Cpu
    default:
      return Puzzle
  }
}

/** 蓝图节点分类色（图标块底色；与节点头语义色同族） */
export function nodeCategoryColor(category: string | undefined): string {
  switch (category) {
    case '事件':
      return 'var(--node-head-event)'
    case '数学':
    case '容器':
      return 'var(--node-head-function)'
    case '转换':
      return 'var(--node-head-pure)'
    case '流程':
      return 'var(--node-head-flow)'
    case '字符串':
      return 'var(--pin-string)'
    case '变量':
      return 'var(--pin-any)'
    case '界面':
      return 'var(--pin-object)'
    case '系统':
      return 'var(--node-head-plugin)'
    default:
      return 'var(--accent)'
  }
}

/** UI 节点类型 → Lucide 图标（替代 schema.icon 的 Unicode 字形） */
export function schemaIconFor(type: string, category?: string): LucideIcon {
  switch (type) {
    // 容器
    case 'vbox':
      return Rows3
    case 'hbox':
      return Columns3
    case 'grid':
      return LayoutGrid
    case 'panel':
      return PanelTop
    case 'scrollBox':
      return ScrollText
    case 'tabContainer':
      return PanelsTopLeft
    case 'splitContainer':
      return Columns2
    // 数据
    case 'list':
      return List
    case 'table':
      return Table2
    case 'tree':
      return ListTree
    // 显示
    case 'label':
      return Type
    case 'richText':
      return Text
    case 'markdown':
      return FileText
    case 'image':
      return ImageIcon
    case 'separator':
      return Minus
    case 'progressBar':
      return Gauge
    // 输入
    case 'button':
      return MousePointerClick
    case 'checkbox':
      return SquareCheck
    case 'input':
      return TextCursorInput
    case 'textarea':
      return AlignLeft
    case 'select':
      return ChevronsUpDown
    case 'slider':
      return SlidersHorizontal
    case 'number':
      return Hash
    default:
      break
  }
  switch (category) {
    case '容器':
      return Boxes
    case '数据':
      return ListTree
    case '输入':
      return FormInput
    default:
      return Box
  }
}
