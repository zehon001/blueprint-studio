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
 *   assetRef → 路径文本 + 占位浏览按钮（toast 提示）；logicRef → 逻辑资产选择器（T2.6）：
 *   下拉列出项目 logic/ 下全部 .bp.json（GET /api/tree）+ 手工路径输入 + 清除 + 新建
 *   （PUT 空蓝图模板）；绑定写入 = 单条 runUICommand 双写 UINode.logicAsset（ir 契约位，
 *   模板 / 自定义事件区读取位）与 props.logicAsset（属性行显示位），可撤销。
 *
 * 编辑协议与蓝图检视器控件（src/blueprint/details/param-editors.tsx，T2.4 已交付，风格对齐
 * 但独立实现）一致：文本 / 数字 / 多行 / JSON 类控件走「草稿态 + 提交」（Enter / 失焦），
 * 避免逐键产生命令；布尔 / 下拉 / 取色器为离散值，变更即提交。外部值变化（撤销 / 批量
 * 应用 / 换选）自动同步回编辑框。多选值不同 → 混合态（占位「—」）。
 * 置灰：disabled = true 时控件不可交互（flow 节点的 position 等）。
 *
 * 本文件不 import 样式（node:test 可挂载冒烟）；inspector.css 由 index.ts 引入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Icon } from '@/shell/ui/Icon'
import type { PropDef } from '@/ui-editor/schema'
import type { UIAsset } from '@/ir/types'
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
        <Icon icon={Plus} size={11} /> 添加一项
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

/** 逻辑资产引用（logicRef · T2.6 蓝图绑定 UI 节点）与 schema 注入 */
import { buildLogicAssetOptions, emptyBlueprintAsset, type LogicOption } from '@/runtime/binding'
import { uiNodeSchemas } from '@/ui-editor/schema'
import { findUINodeIn } from './inspector-model'
import { runUICommand, useSceneTreeDomain, useUIEditorStore } from '@/ui-editor/store'

/**
 * 为全部 UI 节点 schema 注入「逻辑资产」属性（T2.6 · 仅编辑器运行时生效）。
 *
 * 背景：logicAsset 是 UINode 的契约字段（src/ir/types.ts 顶层可选字段），但 T1.1 的
 * 各节点 schema 尚未声明 logicRef 属性行，检视器（纯 schema 驱动）因此无处渲染编辑器。
 * 本卡不改 src/ui-editor/schema/（所有权在 T1.1/T2.7），在此做运行时补充：
 * 给每个 schema 追加 { id:'logicAsset', type:'logicRef', group:'节点' }（已声明则跳过，
 * schema 侧将来补声明时本注入自动失效）。node:test 环境（import.meta.env 为 undefined）
 * 不注入，保证既有检视器 / schema 快照断言不受影响。
 */
function ensureLogicBindingProp(): void {
  for (const schema of uiNodeSchemas) {
    if (schema.props.some((p) => p.id === 'logicAsset')) continue
    schema.props.push({
      id: 'logicAsset',
      label: '逻辑资产',
      type: 'logicRef',
      group: '节点',
      default: '',
      placeholder: 'logic/main.bp.json',
      doc: '挂载的逻辑资产（logic/ 下 .bp.json，相对项目根）。运行窗口加载 UI 后由该蓝图驱动本节点子树（ui 访问器作用域 = 绑定节点及其子树）',
    })
  }
}
// vite（编辑器 dev/build）注入 import.meta.env；node:test（tsx）无此全局 → 不注入 schema
if (import.meta.env) ensureLogicBindingProp()

/** 逻辑资产引用（logicRef）：下拉选择 + 手工路径 + 清除 + 新建（T2.6） */
export function LogicRefEditor(props: PropEditorProps) {
  const projectPath = useUIEditorStore((s) => s.projectPath)
  const selection = useUIEditorStore((s) => s.selection)
  const asset = useSceneTreeDomain().asset
  const [options, setOptions] = useState<LogicOption[]>([])
  const [reloadSeq, setReloadSeq] = useState(0)

  /* —— 选中节点（批量 / 顶层字段读取用；与 InspectorPanel 同一选择源） —— */
  const nodes = useMemo(() => {
    if (!asset || selection.length === 0) return []
    return selection
      .map((id) => findUINodeIn(asset.root, id))
      .filter((n): n is NonNullable<typeof n> => n !== null)
  }, [asset, selection])

  /* —— 选项列表：GET /api/tree?path=<project>/logic 递归取 .bp.json —— */
  useEffect(() => {
    if (!projectPath) {
      setOptions([])
      return
    }
    let cancelled = false
    fetch(`/api/tree?path=${encodeURIComponent(`${projectPath}/logic`)}`)
      .then((r) => r.json() as Promise<unknown>)
      .then((j) => {
        if (!cancelled) setOptions(buildLogicAssetOptions(j, projectPath))
      })
      .catch(() => {
        if (!cancelled) setOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [projectPath, reloadSeq])

  /* —— 生效值：顶层 UINode.logicAsset（契约位）优先，回落属性行值（props 位） —— */
  const rowValue = props.mixed || props.value === undefined || props.value === null ? '' : String(props.value)
  const effective =
    !props.mixed && nodes.length === 1
      ? (typeof nodes[0]!.logicAsset === 'string' && nodes[0]!.logicAsset !== ''
          ? (nodes[0]!.logicAsset as string)
          : rowValue)
      : rowValue

  /** 提交绑定：单条命令双写顶层（契约位）+ props（属性行显示位），可撤销（批量一条命令） */
  const commitBinding = (path: string): void => {
    if (nodes.length === 0) return
    const ids = nodes.map((n) => n.id)
    const label = ids.length > 1 ? `检视器：批量修改 逻辑资产 ${ids.length} 个` : '检视器：逻辑资产'
    runUICommand(label, (draft) => {
      const root = (draft as UIAsset).root
      for (const id of ids) {
        const node = findUINodeIn(root, id)
        if (!node) continue
        if (path) {
          node.logicAsset = path
          node.props.logicAsset = path
        } else {
          delete node.logicAsset
          node.props.logicAsset = ''
        }
      }
    })
  }

  /* —— 手工路径输入（草稿态：Enter / 失焦提交） —— */
  const initial = props.mixed ? '' : effective
  const { draft, setDraft, commit: commitDraft } = useDraft(
    initial,
    (d) => d === initial,
    (d) => commitBinding(d.trim()),
  )

  /* —— 新建空蓝图：PUT /api/file → 重载选项 → 绑定 —— */
  const createAsset = async (): Promise<void> => {
    if (!projectPath || props.disabled) return
    const raw = window.prompt('新逻辑资产文件名（logic/ 下，可含子目录）', 'logic/新蓝图.bp.json')
    if (raw === null) return
    const rel = raw.trim().replace(/^\/+|\/+$/g, '')
    if (rel === '') return
    if (!rel.toLowerCase().endsWith('.bp.json')) {
      props.onPlaceholder?.('文件名必须以 .bp.json 结尾（本期新建仅支持蓝图资产）')
      return
    }
    const name = rel.slice(0, -'.bp.json'.length).split('/').pop() || '新蓝图'
    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: `${projectPath}/${rel}`,
          content: JSON.stringify(emptyBlueprintAsset(name), null, 2),
        }),
      })
      const j = (await res.json()) as { ok?: boolean; message?: string }
      if (!j.ok) {
        props.onPlaceholder?.(`创建失败：${j.message ?? `HTTP ${res.status}`}`)
        return
      }
      setReloadSeq((s) => s + 1)
      commitBinding(rel)
      props.onPlaceholder?.(`已创建并绑定：${rel}`)
    } catch (err) {
      props.onPlaceholder?.(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const current = effective
  const known = options.some((o) => o.value === current)
  return (
    <span className="insp-stack">
      <select
        className="insp-select"
        value={current === '' || !known ? '' : current}
        title={props.mixed ? MIXED_TITLE : '选择 logic/ 下的 .bp.json 逻辑资产'}
        disabled={props.disabled}
        onChange={(e) => commitBinding(e.target.value)}
      >
        <option value="" disabled hidden>
          —
        </option>
        {current !== '' && !known ? <option value={current}>{current}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="insp-ref">
        <input
          type="text"
          className="insp-input"
          value={draft}
          placeholder={props.mixed ? '—' : (props.def.placeholder ?? 'logic/main.bp.json')}
          title={props.mixed ? MIXED_TITLE : '手工输入路径（Enter / 失焦提交）'}
          disabled={props.disabled}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitDraft()
              e.currentTarget.blur()
            }
            e.stopPropagation()
          }}
          onBlur={commitDraft}
        />
        <button
          type="button"
          className="insp-btn"
          disabled={props.disabled || effective === ''}
          title="解除绑定（清空逻辑资产）"
          onClick={() => commitBinding('')}
        >
          清除
        </button>
        <button
          type="button"
          className="insp-btn"
          disabled={props.disabled || !projectPath}
          title="在 logic/ 下新建空蓝图（含 event.start 入口）并绑定"
          onClick={() => void createAsset()}
        >
          新建…
        </button>
      </span>
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
