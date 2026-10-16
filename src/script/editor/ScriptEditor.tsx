/**
 * CodeMirror 6 编辑器封装（T3.1 · ScriptAgent）
 *
 * 职责：脚本视图的源码编辑面——语言模式（.ts → TS / .py → Python）、基础 IDE
 * 体验（行号 / 括号匹配 / 自动缩进 / 搜索 Ctrl+F / 折叠 / 历史）、暗色主题
 * （editor-theme.ts，全 token）、只读模式（双视图蓝图侧 codegen 只读文本复用）、
 * Ctrl+S（Mod-s keymap → onSave；全局 file.save 重绑定在 ScriptTab，两者共用
 * 同一个保存函数：编辑器聚焦时 CM 先处理并 preventDefault，全局层自然跳过）。
 *
 * 诊断标记（DoD 口径 · 不虚报）：受控子集解析器 T3.6 未交付，本期**没有**
 * 行列诊断——语法诊断扩展位 syntaxDiagnosticsExtension() 返回空数组占位，
 * 编辑器右上角常驻徽标「语法检查：待 T3.6」显式标注；T3.6 交付后在
 * syntaxDiagnosticsExtension 内接入 linter() + 行列定位，徽标随之撤除。
 *
 * 与 T3.2 的接口约定（同批并行）：`@/script/api` 导出
 * `scriptTypesExtension(): LanguageSupport | Extension`——TS 模式挂载其内建
 * 全局（ui/vars/emit/plugins…）补全与类型提示；Python 模式本期不挂（T4.x）。
 *
 * 注意：本组件不 import .css（node:test 需直接加载本文件；样式在 index.ts 统一挂）。
 */
import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  type Command,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import {
  searchKeymap,
  highlightSelectionMatches,
} from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { lintKeymap } from '@codemirror/lint'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
// T3.2 内建 API 类型包（内建全局补全；同批交付，接口见文件头约定）
import { scriptTypesExtension } from '@/script/api'
import { scriptLanguageOf, type ScriptLanguage } from './scan'
import { scriptEditorTheme, scriptHighlightStyle } from './editor-theme'

/** 装饰器/注解在 @lezer 高亮里走 meta tag（editor-theme.ts 映射为插件紫） */

/* ---------------- 诊断标记扩展位（T3.6 接入点 · 本期占位） ---------------- */

/**
 * 语法诊断扩展位：受控子集解析器（T3.6）交付前**没有**行列诊断，返回空数组。
 * TODO(T3.6)：替换为 linter(view => tsParserDiagnostics(view.state.doc)) +
 * lintGutter()，并把编辑器右上角徽标「语法检查：待 T3.6」撤除（见 ScriptEditor）。
 */
export function syntaxDiagnosticsExtension(): Extension[] {
  return []
}

/* ---------------- 命令与扩展装配 ---------------- */

/** 构造 Mod-s 保存命令（供 keymap 与测试复用；吞掉浏览器默认保存对话框） */
export function makeSaveCommand(onSave: () => void): Command {
  return () => {
    onSave()
    return true
  }
}

/** 脚本语言 → 语言扩展（.py 缩进按 PEP8 4 空格；TS 挂 T3.2 类型包补全） */
function languageExtensionOf(lang: ScriptLanguage): Extension[] {
  if (lang === 'py') {
    return [python(), indentUnit.of('    ')]
  }
  const exts: Extension[] = [javascript({ typescript: true })]
  exts.push(scriptTypesExtension()) // T3.2：ui/vars/emit/plugins… 内建全局补全
  return exts
}

/** 扩展装配参数（createScriptState / ScriptEditor 共用） */
export interface ScriptExtensionOptions {
  /** 脚本语言（.py → Python，其余 TS） */
  language: ScriptLanguage
  /** 只读模式（双视图蓝图侧 codegen 只读文本复用） */
  readOnly?: boolean
  /** 草稿文本变更回调（含 undo/redo；ScriptTab 防抖标脏） */
  onChange?: (text: string) => void
  /** Mod-s 保存回调 */
  onSave?: () => void
}

/**
 * 组装 CodeMirror 扩展集（不含 React；node 环境 DOM-free 可复用）。
 * 快捷键层：defaultKeymap + history + search(Ctrl+F) + fold + completion +
 * lint（诊断导航占位）+ indentWithTab + Mod-s 保存。
 */
export function buildScriptExtensions(opts: ScriptExtensionOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(scriptHighlightStyle, { fallback: true }),
    scriptEditorTheme,
    ...languageExtensionOf(opts.language),
    // 诊断标记扩展位（T3.6 接入行列诊断；本期空占位——徽标显式标注）
    ...syntaxDiagnosticsExtension(),
    keymap.of([
      { key: 'Mod-s', run: makeSaveCommand(() => opts.onSave?.()) },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap, // T3.6 诊断接入后的跳转键位（本期无诊断，键位空转）
      indentWithTab,
    ]),
    EditorView.editable.of(opts.readOnly !== true),
    EditorState.readOnly.of(opts.readOnly === true),
    ...(opts.onChange
      ? [EditorView.updateListener.of((u) => { if (u.docChanged) opts.onChange?.(u.state.doc.toString()) })]
      : []),
  ]
}

/** 创建脚本编辑器 EditorState（DOM-free；测试与 EditorView 共用；语言由 path 推导） */
export function createScriptState(
  opts: Omit<ScriptExtensionOptions, 'language'> & { text: string; path: string },
): EditorState {
  return EditorState.create({
    doc: opts.text,
    extensions: buildScriptExtensions({ ...opts, language: scriptLanguageOf(opts.path) }),
  })
}

/* ---------------- React 组件 ---------------- */

export interface ScriptEditorProps {
  /** 资产路径（决定语言模式：.py → Python，其余按 TS） */
  path: string
  /** 初始文本（磁盘确认内容；编辑草稿由编辑器内部持有，经 onChange 上报） */
  value: string
  /** 只读（双视图蓝图侧 codegen 只读文本复用本组件） */
  readOnly?: boolean
  /** 草稿文本变更回调（每次文档变更同步触发；ScriptTab 防抖 300ms 标脏） */
  onChange?: (text: string) => void
  /** Mod-s 保存回调（与 ScriptTab 的全局 file.save 共用同一保存函数） */
  onSave?: () => void
  /** 挂载回调（暴露 EditorView：T3.6 诊断 / T3.8 双视图同步协议接入点） */
  onReady?: (view: EditorView) => void
  /** 附加类名 */
  className?: string
}

/**
 * CodeMirror 脚本编辑器。
 * 值流：props.value 只是**初始/外部确认值**（磁盘内容 / 重载 / T3.8 对侧保存），
 * 编辑草稿在 CM 文档内；外部 value 与内部文档不同时整体替换（标记外部更新，
 * 不回调 onChange 以免误标脏）。右上角徽标「语法检查：待 T3.6」为诊断占位。
 */
export function ScriptEditor({ path, value, readOnly = false, onChange, onSave, onReady, className }: ScriptEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const applyingExternal = useRef(false)
  const changeRef = useRef(onChange)
  const saveRef = useRef(onSave)
  const readyRef = useRef(onReady)
  useEffect(() => {
    changeRef.current = onChange
    saveRef.current = onSave
    readyRef.current = onReady
  })

  /* 创建 EditorView（path/readOnly 变化时重建） */
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: createScriptState({
        text: value,
        path,
        readOnly,
        onChange: (text) => {
          if (!applyingExternal.current) changeRef.current?.(text)
        },
        onSave: () => {
          saveRef.current?.()
        },
      }),
      parent: host,
    })
    viewRef.current = view
    readyRef.current?.(view)
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value 仅作初值，外部更新走下方同步 effect
  }, [path, readOnly])

  /* 外部 value 同步（重载 / T3.8 对侧保存）：整体替换文档，不触发 onChange */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    applyingExternal.current = true
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    } finally {
      applyingExternal.current = false
    }
  }, [value])

  return (
    <div className={`script-editor${className ? ` ${className}` : ''}`}>
      <div ref={hostRef} className="script-editor-host" />
      {/* 诊断占位徽标（不虚报）：T3.6 解析器交付后撤除并接入行列诊断 */}
      <span className="script-editor-lint-badge" title="受控子集解析器（T3.6）交付后在此接入行列诊断">
        语法检查：待 T3.6
      </span>
    </div>
  )
}
