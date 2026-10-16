/**
 * 检视器属性编辑控件（T1.5 · PLAN §7.3 类型编辑器）
 *
 * UIPropType 全覆盖（13 种声明 + 未知类型回落文本框）：
 *   number / int → 数字输入（min / max / step；int 提交时取整）
 *   string → 单行文本；textarea → 多行文本；bool → 勾选框（即改即提交）
 *   select → 下拉（options）；color → 取色器 + hex 文本（双向编辑）
 *   vec2 → x / y 两输入（position 用）；size → w / h 两输入（提交增量补丁，由面板按节点合并）
 *   options → 字符串数组（每行一项 + 添加按钮）；listColumns → JSON 文本域 + 格式校验
 *   （错误提示就地显示；可视化列编辑标注 T7.x）
 *   assetRef → 路径文本 + 占位浏览按钮（toast 提示）；logicRef → 路径文本（T2.6 接选择器）
 *
 * 编辑协议与蓝图检视器控件（src/blueprint/details/param-editors.tsx，T2.4 已交付，风格对齐
 * 但独立实现）一致：文本 / 数字 / 多行 / JSON 类控件走「草稿态 + 提交」（Enter / 失焦），
 * 避免逐键产生命令；布尔 / 下拉 / 取色器为离散值，变更即提交。外部值变化（撤销 / 批量
 * 应用 / 换选）自动同步回编辑框。多选值不同 → 混合态（占位「—」）。
 * 置灰：disabled = true 时控件不可交互（flow 节点的 position 等）。
 *
 * 本文件不 import 样式（node:test 可挂载冒烟）；inspector.css 由 index.ts 引入。
 */
import { useEffect, useRef, useState } from 'react'
import type { PropDef } from '@/ui-editor/schema'
import { MIXED_TITLE, parseListColumnsJson, parseOptionsLines } from './inspector-model'

/** 编辑控件统一入参（PropEditor 按 def.type 分发） */
export interface PropEditorProps {
  /** 属性声明（类型 / min / max / step / options / placeholder） */
  def: PropDef
  /** 生效值（多选取首个节点值；混合态时仅作展示基准） */
  value: unknown
  /** 混合态（多选且值不同）：控件显示「—」占位 */
  mixed: boolean
  /** 置灰（PropDef.disabled 或 position 的父级接管语义） */
  disabled: boolean
  /** 提交值（标量为全量值；vec2 / size 为增量补丁 {x|y|w|h}，由面板按节点合并） */
  onCommit: (value: unknown) => void
  /** 占位交互回调（浏览按钮等；面板传 toast） */
  onPlaceholder?: (message: string) => void
}

/** 草稿态文本编辑钩子：外部值变化自动同步；返回 [草稿, 设草稿, 提交]（与 T2.4 同构） */
function useDraft(
  initial: string,
  isSame: (draft: string) => boolean,
  submit: (draft: string) => void,
) {
  const [draft, setDraft] = useState(initial)
  const committedRef = useRef(initial)
  useEffect(() => {
    if (committedRef.current === initial) return
    committedRef.current = initial
    setDraft(initial)
  }, [initial])
  const commit = (): void => {
    if (isSame(draft)) return
    committedRef.current = draft
    submit(draft)
  }
  return { draft, setDraft, commit }
}

/* ============================================================
 * 基础控件
 * ============================================================ */

/** 数字输入（number / int；min / max / step；非法输入不提交并回退） */
export function NumberEditor(props: PropEditorProps) {
  const { def } = props
  const initial = props.mixed
    ? ''
    : typeof props.value === 'number' && Number.isFinite(props.value)
      ? String(props.value)
      : ''
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => {
      const text = d.trim()
      if (text === '' || !Number.isFinite(Number(text))) {
        setDraft(initial) // 空 / 非法：回退显示（不产生命令）
        return
      }
      let n = Number(text)
      if (def.type === 'int') n = Math.round(n)
      if (def.min !== undefined) n = Math.max(def.min, n)
      if (def.max !== undefined) n = Math.min(def.max, n)
      props.onCommit(n)
    },
  )
  return (
    <input
      type="number"
      className="insp-input"
      step={def.step ?? 'any'}
      min={def.min}
      max={def.max}
      value={draft}
      placeholder={props.mixed ? '—' : def.placeholder}
      title={props.mixed ? MIXED_TITLE : undefined}
      disabled={props.disabled}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
      onBlur={commit}
    />
  )
}

/** 单行文本（string；未知类型回落至此） */
export function TextEditor(props: PropEditorProps) {
  const initial = props.mixed || props.value === undefined || props.value === null ? '' : String(props.value)
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => props.onCommit(d),
  )
  return (
    <input
      type="text"
      className="insp-input"
      value={draft}
      placeholder={props.mixed ? '—' : props.def.placeholder}
      title={props.mixed ? MIXED_TITLE : undefined}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
      onBlur={commit}
    />
  )
}

/** 多行文本（textarea） */
export function TextareaEditor(props: PropEditorProps) {
  const initial = props.mixed || props.value === undefined || props.value === null ? '' : String(props.value)
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => props.onCommit(d),
  )
  return (
    <textarea
      className="insp-textarea"
      rows={4}
      value={draft}
      placeholder={props.mixed ? '—' : props.def.placeholder}
      title={props.mixed ? MIXED_TITLE : undefined}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
    />
  )
}

/** 布尔勾选框（bool；变更即提交；混合态 indeterminate） */
export function BoolEditor(props: PropEditorProps) {
  const checked = props.value === true
  return (
    <input
      type="checkbox"
      className="insp-check"
      ref={(el) => {
        if (el) el.indeterminate = props.mixed
      }}
      checked={checked}
      title={props.mixed ? MIXED_TITLE : String(checked)}
      disabled={props.disabled}
      onChange={(e) => props.onCommit(e.target.checked)}
    />
  )
}

/** 下拉选择（select；混合态显示「—」占位项） */
export function SelectEditor(props: PropEditorProps) {
  const current = props.mixed || props.value === undefined ? '' : String(props.value)
  const options = props.def.options ?? []
  const known = options.some((o) => o.value === current)
  return (
    <select
      className="insp-select"
      value={current}
      title={props.mixed ? MIXED_TITLE : undefined}
      disabled={props.disabled}
      onChange={(e) => props.onCommit(e.target.value)}
    >
      {current === '' || !known ? (
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

/* ============================================================
 * 颜色（取色器 + hex 文本双向）
 * ============================================================ */

/** hex 文本框：合法（#RRGGBB 或裸 6 位十六进制）才提交，否则回退 */
function HexInput(props: { hex: string; disabled: boolean; onCommit: (value: string) => void }) {
  const initial = props.hex
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => {
      const text = d.trim()
      if (/^[0-9a-fA-F]{6}$/.test(text)) props.onCommit(`#${text}`)
      else if (/^#[0-9a-fA-F]{6}$/.test(text)) props.onCommit(text)
      else setDraft(initial)
    },
  )
  return (
    <input
      type="text"
      className="insp-input"
      value={draft}
      placeholder="#RRGGBB"
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit()
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
      onBlur={commit}
    />
  )
}

/** 颜色（color）：取色器 + hex 文本；变更即提交；混合态显示「—」 */
export function ColorEditor(props: PropEditorProps) {
  if (props.mixed) {
    return (
      <span className="insp-mixed-mark" title={MIXED_TITLE}>
        —
      </span>
    )
  }
  const hex = typeof props.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(props.value) ? props.value : '#000000'
  return (
    <span className="insp-ref">
      <input
        type="color"
        className="insp-color"
        value={hex}
        title={hex}
        disabled={props.disabled}
        onChange={(e) => props.onCommit(e.target.value)}
      />
      <HexInput hex={hex} disabled={props.disabled} onCommit={props.onCommit} />
    </span>
  )
}

/* ============================================================
 * 向量 / 尺寸（双输入，增量补丁提交）
 * ============================================================ */

/** 单轴数字输入（vec2 的 x/y、size 的 w/h 公用；Enter / 失焦提交增量补丁） */
function AxisInput(props: {
  axis: string
  value: unknown
  mixed: boolean
  disabled: boolean
  onCommitNumber: (n: number) => void
}) {
  const initial = props.mixed
    ? ''
    : typeof props.value === 'number' && Number.isFinite(props.value)
      ? String(props.value)
      : ''
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => {
      const text = d.trim()
      if (text === '' || !Number.isFinite(Number(text))) {
        setDraft(initial)
        return
      }
      props.onCommitNumber(Number(text))
    },
  )
  return (
    <label className="insp-axis">
      <span className="insp-axis-label">{props.axis}</span>
      <input
        type="number"
        className="insp-input"
        step="any"
        value={draft}
        placeholder={props.mixed ? '—' : undefined}
        title={props.mixed ? MIXED_TITLE : undefined}
        disabled={props.disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          }
          e.stopPropagation()
        }}
        onBlur={commit}
      />
    </label>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 二维向量（vec2）：x / y 两输入；提交增量补丁（如 {x: 5}），批量时不覆盖另一轴 */
export function Vec2Editor(props: PropEditorProps) {
  const v = asRecord(props.value)
  return (
    <span className="insp-vec">
      <AxisInput
        axis="X"
        value={v['x']}
        mixed={props.mixed}
        disabled={props.disabled}
        onCommitNumber={(n) => props.onCommit({ x: n })}
      />
      <AxisInput
        axis="Y"
        value={v['y']}
        mixed={props.mixed}
        disabled={props.disabled}
        onCommitNumber={(n) => props.onCommit({ y: n })}
      />
    </span>
  )
}

/** 宽高（size）：w / h 两输入；提交增量补丁（如 {w: 5}） */
export function SizeEditor(props: PropEditorProps) {
  const v = asRecord(props.value)
  return (
    <span className="insp-vec">
      <AxisInput
        axis="宽"
        value={v['w']}
        mixed={props.mixed}
        disabled={props.disabled}
        onCommitNumber={(n) => props.onCommit({ w: n })}
      />
      <AxisInput
        axis="高"
        value={v['h']}
        mixed={props.mixed}
        disabled={props.disabled}
        onCommitNumber={(n) => props.onCommit({ h: n })}
      />
    </span>
  )
}

/* ============================================================
 * 字符串数组（options）与列定义（listColumns）
 * ============================================================ */

/** 字符串数组（options）：每行一项的文本域（删行即删项）+ 添加按钮 */
export function OptionsEditor(props: PropEditorProps) {
  const initial = props.mixed
    ? ''
    : Array.isArray(props.value)
      ? (props.value as unknown[]).map((v) => String(v)).join('\n')
      : ''
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => props.onCommit(parseOptionsLines(d)),
  )
  return (
    <span className="insp-stack">
      <textarea
        className="insp-textarea"
        rows={3}
        value={draft}
        placeholder={props.mixed ? '—' : (props.def.placeholder ?? '每行一个选项')}
        title={props.mixed ? MIXED_TITLE : undefined}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      <button
        type="button"
        className="insp-btn"
        disabled={props.disabled}
        title="在列表末尾追加一项（Enter / 失焦后提交）"
        onClick={() => setDraft((d) => (d.length > 0 && !d.endsWith('\n') ? `${d}\n` : d) + '新选项')}
      >
        ＋ 添加一项
      </button>
    </span>
  )
}

/** 列定义（listColumns）：JSON 文本域 + 格式校验（错误就地提示）；可视化编辑 T7.x */
export function ListColumnsEditor(props: PropEditorProps) {
  const initial = props.mixed ? '' : JSON.stringify(Array.isArray(props.value) ? props.value : [], null, 2)
  const [error, setError] = useState<string | null>(null)
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => {
      const r = parseListColumnsJson(d)
      if (r.ok) {
        setError(null)
        props.onCommit(r.value)
      } else {
        setError(r.message)
      }
    },
  )
  // 外部值变化（撤销 / 批量应用）时清掉过期错误提示
  useEffect(() => {
    setError(null)
  }, [initial])
  return (
    <span className="insp-stack">
      <textarea
        className="insp-textarea"
        rows={6}
        value={draft}
        placeholder={props.mixed ? '—' : props.def.placeholder}
        title={props.mixed ? MIXED_TITLE : undefined}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
      {error ? <span className="insp-error">{error}</span> : null}
      <span className="insp-note">JSON 源编辑（失焦提交并校验）· 可视化列编辑将在 T7.x 提供</span>
    </span>
  )
}

/* ============================================================
 * 引用（assetRef / logicRef）
 * ============================================================ */

/** 静态资源引用（assetRef）：路径文本 + 占位浏览按钮（T7.x 资产浏览器接入） */
export function AssetRefEditor(props: PropEditorProps) {
  return (
    <span className="insp-ref">
      <TextEditor {...props} />
      <button
        type="button"
        className="insp-btn"
        disabled={props.disabled}
        title="浏览 assets/ 资产（占位）"
        onClick={() => props.onPlaceholder?.('资产浏览器将在 T7.x 接入（当前可手动输入相对路径）')}
      >
        浏览…
      </button>
    </span>
  )
}

/** 逻辑资产引用（logicRef）：路径文本（选择器 T2.6 蓝图绑定 UI 时接入） */
export function LogicRefEditor(props: PropEditorProps) {
  return (
    <span className="insp-ref">
      <TextEditor
        {...props}
        def={{ ...props.def, placeholder: props.def.placeholder ?? 'logic/main.bp.json' }}
      />
      <button
        type="button"
        className="insp-btn"
        disabled={props.disabled}
        title="选择逻辑资产（占位）"
        onClick={() => props.onPlaceholder?.('逻辑资产选择器将在 T2.6（蓝图绑定 UI）接入')}
      >
        选择…
      </button>
    </span>
  )
}

/* ============================================================
 * 分发入口
 * ============================================================ */

/** 按 PropDef.type 分发编辑控件（13 种全覆盖；未知类型回落单行文本，兜底可编辑） */
export function PropEditor(props: PropEditorProps) {
  switch (props.def.type) {
    case 'number':
    case 'int':
      return <NumberEditor {...props} />
    case 'string':
      return <TextEditor {...props} />
    case 'bool':
      return <BoolEditor {...props} />
    case 'select':
      return <SelectEditor {...props} />
    case 'color':
      return <ColorEditor {...props} />
    case 'textarea':
      return <TextareaEditor {...props} />
    case 'vec2':
      return <Vec2Editor {...props} />
    case 'size':
      return <SizeEditor {...props} />
    case 'options':
      return <OptionsEditor {...props} />
    case 'listColumns':
      return <ListColumnsEditor {...props} />
    case 'assetRef':
      return <AssetRefEditor {...props} />
    case 'logicRef':
      return <LogicRefEditor {...props} />
    default:
      return <TextEditor {...props} />
  }
}
