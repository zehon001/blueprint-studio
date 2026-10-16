import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { UI_COMPONENT_META, type UIComponent, type UIListColumn } from '../types'

export interface UIRenderCtx {
  mode: 'edit' | 'run'
  selectedId: string | null
  onSelect: (id: string | null) => void
  uiState: Record<string, unknown>
  onInput: (compId: string, value: unknown) => void
  onClick: (compId: string) => void
}

function parseColorMap(text: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text ?? '').split('\n')) {
    const idx = line.indexOf('=')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

const str = (v: unknown) => (v == null ? '' : String(v))

// ────────── 列表组件（自定义列 / 分组 / 合并 / 颜色） ──────────

type MergedRow = { row: Record<string, string>; count: number; rows: Record<string, string>[] }

function ListRows({ columns, rows }: { columns: UIListColumn[]; rows: Record<string, string>[] }) {
  const colorMaps = useMemo(
    () => Object.fromEntries(columns.map((c) => [c.key, parseColorMap(c.colorMap)])),
    [columns],
  )
  const groupCol = columns.find((c) => c.group)
  const mergeCol = columns.find((c) => c.merge)
  const visible = columns.filter((c) => !c.group)

  // 分组 + 相邻合并
  const groups: { key: string; merged: MergedRow[] }[] = []
  let currentGroup: { key: string; merged: MergedRow[] } | null = null
  let inheritedSession = ''
  for (const row of rows) {
    let groupKey = groupCol ? str(row[groupCol.key]) : ''
    if (groupCol && !groupKey) groupKey = inheritedSession
    else if (groupCol) inheritedSession = groupKey
    if (!currentGroup || currentGroup.key !== groupKey) {
      currentGroup = { key: groupKey, merged: [] }
      groups.push(currentGroup)
    }
    const mergeKey = mergeCol ? str(row[mergeCol.key]) : ''
    const last = currentGroup.merged[currentGroup.merged.length - 1]
    if (mergeKey && last && str(last.row[mergeCol!.key]) === mergeKey) {
      last.count++
      last.rows.push(row)
    } else {
      currentGroup.merged.push({ row, count: 1, rows: [row] })
    }
  }

  return (
    <>
      {groups.map((g, gi) => (
        <div className="uil-group" key={gi}>
          {groupCol && (
            <div className="uil-group-head">
              <span className="uil-group-caret">▾</span>
              {g.key || '（未分组）'}
              <span className="uil-group-meta">{g.merged.length} 条</span>
            </div>
          )}
          {g.merged.map((m, mi) => (
            <MergedEntry key={mi} merged={m} columns={visible} colorMaps={colorMaps} mergeColKey={mergeCol?.key} />
          ))}
        </div>
      ))}
    </>
  )
}

function MergedEntry({
  merged,
  columns,
  colorMaps,
  mergeColKey,
}: {
  merged: MergedRow
  columns: UIListColumn[]
  colorMaps: Record<string, Record<string, string>>
  mergeColKey?: string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="uil-row-wrap">
      <div
        className="uil-row"
        onClick={() => merged.count > 1 && setExpanded(!expanded)}
        style={merged.count > 1 ? { cursor: 'pointer' } : undefined}
      >
        {columns.map((col) => {
          const value = str(merged.row[col.key])
          const color = colorMaps[col.key]?.[value] ?? colorMaps[col.key]?.[value.toUpperCase()]
          if (color) {
            return (
              <span className="uil-cell uil-badge" key={col.key} style={{ background: color }}>
                {value}
              </span>
            )
          }
          return (
            <span
              className={`uil-cell${col.key === mergeColKey ? ' uil-cell-main' : ''}`}
              key={col.key}
            >
              {value}
            </span>
          )
        })}
        {merged.count > 1 && (
          <span className={`uil-count${expanded ? ' open' : ''}`} title="点击展开合并的行">
            ×{merged.count}
          </span>
        )}
      </div>
      {expanded && merged.count > 1 && (
        <div className="uil-merged">
          {merged.rows.map((r, i) => (
            <div className="uil-merged-line" key={i}>
              {columns.map((c) => str(r[c.key])).join('  ')}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ListComp({ comp, ctx }: { comp: UIComponent; ctx: UIRenderCtx }) {
  const columns = (comp.props.columns as UIListColumn[]) ?? []
  const rows = (ctx.uiState[comp.id] as Record<string, string>[] | undefined) ?? []
  const autoScroll = Boolean(comp.props.autoScroll)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTo({ top: ref.current.scrollHeight })
  }, [rows.length, autoScroll])

  return (
    <div className="uil-list" ref={ref}>
      {columns.length > 0 && (
        <div className="uil-head">
          {columns
            .filter((c) => !c.group)
            .map((c) => (
              <span className="uil-cell uil-head-cell" key={c.key}>
                {c.label}
              </span>
            ))}
        </div>
      )}
      {rows.length === 0 && <div className="uil-empty">（等待数据…）</div>}
      <ListRows columns={columns} rows={rows} />
    </div>
  )
}

// ────────── 组件渲染 ──────────

function CompInner({ comp, ctx }: { comp: UIComponent; ctx: UIRenderCtx }) {
  const { uiState, onInput, onClick } = ctx
  const value = uiState[comp.id]
  const grow = Number(comp.props.grow) || 0

  switch (comp.kind) {
    case 'vbox':
      return (
        <div className="uil vbox" style={{ gap: Number(comp.props.gap) || 8 }}>
          {(comp.children ?? []).map((c) => (
            <Comp key={c.id} comp={c} ctx={ctx} />
          ))}
        </div>
      )
    case 'hbox':
      return (
        <div className="uil hbox" style={{ gap: Number(comp.props.gap) || 8 }}>
          {(comp.children ?? []).map((c) => (
            <Comp key={c.id} comp={c} ctx={ctx} />
          ))}
        </div>
      )
    case 'panel':
      return (
        <div className="uil panel" style={grow ? { flexGrow: grow } : undefined}>
          {str(comp.props.title) && <div className="uil panel-title">{str(comp.props.title)}</div>}
          <div className="uil panel-body">
            {(comp.children ?? []).map((c) => (
              <Comp key={c.id} comp={c} ctx={ctx} />
            ))}
          </div>
        </div>
      )
    case 'text':
      return (
        <div className="uil text" style={grow ? { flexGrow: grow } : undefined}>
          {str(value)}
        </div>
      )
    case 'heading':
      return <div className="uil heading">{str(comp.props.text)}</div>
    case 'markdown': {
      const html = useMemo(
        () => marked.parse(str(value) || '（等待内容…）', { async: false }) as string,
        [value],
      )
      return (
        <div
          className="uil markdown md-body"
          style={grow ? { flexGrow: grow, minHeight: 0, overflow: 'auto' } : undefined}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )
    }
    case 'input':
      return (
        <label className="uil field" style={grow ? { flexGrow: grow } : undefined}>
          {str(comp.props.label) && <span className="uil field-label">{str(comp.props.label)}</span>}
          <input
            className="bp-input"
            placeholder={str(comp.props.placeholder)}
            value={str(value)}
            onChange={(e) => onInput(comp.id, e.target.value)}
          />
        </label>
      )
    case 'textarea':
      return (
        <label className="uil field uil-field-col" style={grow ? { flexGrow: grow } : undefined}>
          {str(comp.props.label) && <span className="uil field-label">{str(comp.props.label)}</span>}
          <textarea
            className="bp-input"
            rows={4}
            placeholder={str(comp.props.placeholder)}
            value={str(value)}
            onChange={(e) => onInput(comp.id, e.target.value)}
          />
        </label>
      )
    case 'select': {
      const options = str(comp.props.options)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      return (
        <label className="uil field">
          {str(comp.props.label) && <span className="uil field-label">{str(comp.props.label)}</span>}
          <select
            className="bp-input"
            value={str(value)}
            onChange={(e) => onInput(comp.id, e.target.value)}
          >
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      )
    }
    case 'button':
      return (
        <button className="btn primary" onClick={() => onClick(comp.id)}>
          {str(comp.props.text) || '按钮'}
        </button>
      )
    case 'switch':
      return (
        <label className="uil field">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onInput(comp.id, e.target.checked)} />
          <span className="uil field-label">{str(comp.props.label)}</span>
        </label>
      )
    case 'list':
      return <ListComp comp={comp} ctx={ctx} />
    case 'divider':
      return <div className="uil divider" />
    default:
      return null
  }
}

function Comp({ comp, ctx }: { comp: UIComponent; ctx: UIRenderCtx }) {
  if (ctx.mode === 'edit') {
    const selected = ctx.selectedId === comp.id
    const meta = UI_COMPONENT_META[comp.kind]
    return (
      <div
        className={`ui-edit-comp${selected ? ' selected' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          ctx.onSelect(comp.id)
        }}
      >
        <div className="ui-edit-tag">
          {meta?.title ?? comp.kind}
          {meta?.hasValue ? <em> · {comp.id}</em> : null}
        </div>
        <div className="ui-edit-body">
          <CompInner comp={comp} ctx={ctx} />
        </div>
      </div>
    )
  }
  return <CompInner comp={comp} ctx={ctx} />
}

export function UIRenderer({ root, ctx }: { root: UIComponent; ctx: UIRenderCtx }) {
  return (
    <div
      className="ui-root"
      onClick={() => ctx.mode === 'edit' && ctx.onSelect(null)}
    >
      <Comp comp={root} ctx={ctx} />
    </div>
  )
}
