/**
 * CodeMirror 暗色主题（T3.1 · 全 token 色，禁硬编码）
 *
 * 约定（对齐 src/shell/theme/theme.css 的 T0.8 规范）：
 *  - 所有颜色 / 间距 / 字号一律 `var(--token)` 引用主题 token，不写任何 hex/rgba；
 *  - 装饰器（@tool/@expose/@on）映射紫色 token（--node-head-plugin），与蓝图插件头同源；
 *  - `dark: true` 声明暗色语境（影响 CM 默认选区等内部判断）。
 *
 * 诊断样式（T3.6 接入）暂不实现，避免虚报——lint 扩展位见 ScriptEditor.tsx。
 */
import { EditorView } from '@codemirror/view'
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/** 编辑器骨架主题（面板 / 行号 / 搜索面板 / 补全提示全部走 token） */
export const scriptEditorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--bg-canvas)',
      height: '100%',
      fontSize: 'var(--font-md)',
      fontFamily: 'var(--font-mono)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      lineHeight: '1.55',
      scrollbarColor: 'var(--border-strong) transparent',
    },
    '.cm-content': {
      caretColor: 'var(--accent-hover)',
      padding: 'var(--space-2) 0 var(--space-7)',
    },
    '.cm-line': { padding: '0 var(--space-3)' },
    '.cm-cursor, .cm-dropCursor': { borderLeft: '1.5px solid var(--accent-hover)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--selection)',
    },
    /* 行号槽 */
    '.cm-gutters': {
      backgroundColor: 'var(--bg-panel)',
      color: 'var(--text-disabled)',
      border: 'none',
      borderRight: '1px solid var(--border)',
      userSelect: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--space-2) 0 var(--space-3)',
      minWidth: '40px',
    },
    '.cm-activeLine': { backgroundColor: 'var(--bg-panel)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-disabled)', cursor: 'pointer' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--accent-hover)' },
    /* 括号匹配 / 选区匹配 */
    '.cm-matchingBracket': {
      outline: '1px solid var(--focus-ring)',
      color: 'inherit',
      backgroundColor: 'transparent',
    },
    '.cm-nonmatchingBracket': { color: 'var(--error)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--selection)' },
    /* 搜索面板（Ctrl+F） */
    '.cm-panels': {
      backgroundColor: 'var(--bg-panel-header)',
      color: 'var(--text)',
      zIndex: 1,
    },
    '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-searchMatch': { backgroundColor: 'var(--selection)', outline: '1px solid var(--accent)' },
    '.cm-searchMatch-selected': { backgroundColor: 'var(--accent)' },
    '.cm-textfield': {
      backgroundColor: 'var(--bg-input)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-sm)',
      fontSize: 'var(--font-sm)',
    },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--bg-input)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-sm)',
      fontSize: 'var(--font-sm)',
    },
    /* 自动补全提示（T3.2 类型包补全的承载面） */
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-input)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--text)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-mono)',
      maxHeight: '15em',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: 'var(--selection)',
      color: 'var(--text)',
    },
    '.cm-completionInfo': {
      backgroundColor: 'var(--bg-panel)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    },
  },
  { dark: true },
)

/** 语法高亮（@lezer highlight tags → 主题 token；色值全部 var() 引用） */
export const scriptHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: 'var(--text-dim)' },
  // 装饰器 / 注解（@tool/@expose/@on、Python decorator）→ 插件紫（与蓝图插件头同源）
  { tag: [t.meta, t.documentMeta], color: 'var(--node-head-plugin)' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self], color: 'var(--accent-hover)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--pin-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--pin-float)' },
  { tag: t.bool, color: 'var(--pin-bool)' },
  { tag: t.null, color: 'var(--node-head-plugin)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--pin-int)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--pin-object)' },
  { tag: t.propertyName, color: 'var(--text)' },
  { tag: t.variableName, color: 'var(--text)' },
  { tag: t.labelName, color: 'var(--warning)' },
  { tag: [t.regexp, t.escape], color: 'var(--warning)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.paren, t.brace, t.squareBracket], color: 'var(--text-dim)' },
  { tag: t.invalid, color: 'var(--error)', textDecoration: 'underline wavy' },
])
