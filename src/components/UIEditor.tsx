import { useGraphStore } from '../store'
import { UI_COMPONENT_META, type UIComponent, type UIListColumn } from '../types'
import { UIRenderer, type UIRenderCtx } from './UIRenderer'

function OutlineTree({
  comp,
  depth = 0,
}: {
  comp: UIComponent
  depth?: number
}) {
  const selectedCompId = useGraphStore((s) => s.selectedCompId)
  const selectComponent = useGraphStore((s) => s.selectComponent)
  return (
    <div className="outline-node" style={{ paddingLeft: depth * 12 }}>
      <div
        className={`outline-row${selectedCompId === comp.id ? ' selected' : ''}`}
        onClick={() => selectComponent(comp.id)}
      >
        <span className="outline-kind">{UI_COMPONENT_META[comp.kind]?.title ?? comp.kind}</span>
        <span className="outline-name">{comp.name || comp.id}</span>
      </div>
      {(comp.children ?? []).map((c) => (
        <OutlineTree key={c.id} comp={c} depth={depth + 1} />
      ))}
    </div>
  )
}

function ColumnsEditor({
  value,
  onChange,
}: {
  value: UIListColumn[]
  onChange: (next: UIListColumn[]) => void
}) {
  const update = (idx: number, patch: Partial<UIListColumn>) =>
    onChange(value.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  return (
    <div className="cols-editor">
      <div className="cols-head">
        <span>字段</span>
        <span>标题</span>
        <span>颜色映射</span>
        <span>分组</span>
        <span>合并</span>
        <span />
      </div>
      {value.map((col, i) => (
        <div className="cols-row" key={i}>
          <input
            className="bp-input"
            value={col.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <input
            className="bp-input"
            value={col.label}
            onChange={(e) => update(i, { label: e.target.value })}
          />
          <input
            className="bp-input"
            value={col.colorMap ?? ''}
            placeholder="INFO=#3fc1a9"
            onChange={(e) => update(i, { colorMap: e.target.value })}
          />
          <input
            type="checkbox"
            checked={Boolean(col.group)}
            onChange={(e) => update(i, { group: e.target.checked })}
          />
          <input
            type="checkbox"
            checked={Boolean(col.merge)}
            onChange={(e) => update(i, { merge: e.target.checked })}
          />
          <button
            className="btn danger-ghost small"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn small"
        onClick={() => onChange([...value, { key: `field${value.length + 1}`, label: '新列' }])}
      >
        ＋ 添加列
      </button>
    </div>
  )
}

function PropsEditor({ comp }: { comp: UIComponent }) {
  const updateUIComp = useGraphStore((s) => s.updateUIComp)
  const removeUIComp = useGraphStore((s) => s.removeUIComp)
  const moveUIComp = useGraphStore((s) => s.moveUIComp)
  const set = (key: string, value: unknown) =>
    updateUIComp(comp.id, { props: { ...comp.props, [key]: value } })
  const field = (label: string, node: React.ReactNode) => (
    <label className="bp-param bp-param-col">
      <span className="bp-param-label">{label}</span>
      {node}
    </label>
  )
  const text = (label: string, key: string, placeholder = '') =>
    field(
      label,
      <input
        className="bp-input"
        value={String(comp.props[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value)}
      />,
    )
  const num = (label: string, key: string) =>
    field(
      label,
      <input
        type="number"
        className="bp-input"
        value={Number(comp.props[key] ?? 0)}
        onChange={(e) => set(key, Number(e.target.value) || 0)}
      />,
    )

  return (
    <div className="props-editor">
      <div className="props-head">
        <span className={`inspector-title cat-ui`}>{UI_COMPONENT_META[comp.kind]?.title ?? comp.kind}</span>
        <span className="inspector-defid">{comp.id}</span>
      </div>
      <label className="bp-param bp-param-col">
        <span className="bp-param-label">备注名（蓝图引用显示）</span>
        <input
          className="bp-input"
          value={comp.name ?? ''}
          onChange={(e) => updateUIComp(comp.id, { name: e.target.value })}
        />
      </label>
      {comp.kind === 'panel' && text('标题', 'title')}
      {comp.kind === 'heading' && text('文本', 'text')}
      {(comp.kind === 'vbox' || comp.kind === 'hbox') && num('间距', 'gap')}
      {comp.kind === 'text' && text('初始文本', 'text')}
      {comp.kind === 'markdown' &&
        field(
          '初始内容',
          <textarea
            className="bp-input"
            rows={4}
            value={String(comp.props.text ?? '')}
            onChange={(e) => set('text', e.target.value)}
          />,
        )}
      {comp.kind === 'input' && (
        <>
          {text('标签', 'label')}
          {text('占位符', 'placeholder', '请输入…')}
        </>
      )}
      {comp.kind === 'textarea' && (
        <>
          {text('标签', 'label')}
          {text('占位符', 'placeholder', '请输入…')}
        </>
      )}
      {comp.kind === 'select' && (
        <>
          {text('标签', 'label')}
          {field(
            '选项（每行一个）',
            <textarea
              className="bp-input"
              rows={3}
              value={String(comp.props.options ?? '')}
              onChange={(e) => set('options', e.target.value)}
            />,
          )}
        </>
      )}
      {comp.kind === 'button' && text('按钮文字', 'text')}
      {comp.kind === 'switch' && text('标签', 'label')}
      {comp.kind === 'list' && (
        <>
          {field(
            '自动滚动',
            <input
              type="checkbox"
              checked={Boolean(comp.props.autoScroll)}
              onChange={(e) => set('autoScroll', e.target.checked)}
            />,
          )}
          {field(
            '列定义（字段 ← 蓝图写入的 JSON 键名）',
            <ColumnsEditor
              value={(comp.props.columns as UIListColumn[]) ?? []}
              onChange={(next) => set('columns', next)}
            />,
          )}
        </>
      )}
      {comp.kind !== 'divider' && comp.kind !== 'list' && comp.kind !== 'heading' && num('伸缩(grow)', 'grow')}
      <div className="props-actions">
        <button className="btn small" onClick={() => moveUIComp(comp.id, -1)}>
          ↑ 上移
        </button>
        <button className="btn small" onClick={() => moveUIComp(comp.id, 1)}>
          ↓ 下移
        </button>
        <button
          className="btn danger-ghost small"
          disabled={comp.id === 'ui-root'}
          onClick={() => removeUIComp(comp.id)}
        >
          删除组件
        </button>
      </div>
    </div>
  )
}

export function UIEditor() {
  const working = useGraphStore((s) => s.working)
  const selectedCompId = useGraphStore((s) => s.selectedCompId)
  const selectComponent = useGraphStore((s) => s.selectComponent)
  const addUIComponent = useGraphStore((s) => s.addUIComponent)

  const ctx: UIRenderCtx = {
    mode: 'edit',
    selectedId: selectedCompId,
    onSelect: selectComponent,
    uiState: {},
    onInput: () => {},
    onClick: () => {},
  }

  let selected: UIComponent | null = null
  if (working && selectedCompId) {
    const visit = (c: UIComponent): boolean => {
      if (c.id === selectedCompId) {
        selected = c
        return true
      }
      return (c.children ?? []).some(visit)
    }
    if (working.ui) visit(working.ui)
  }

  const kinds = Object.values(UI_COMPONENT_META)

  return (
    <div className="ui-editor">
      <aside className="ui-palette">
        <div className="panel-title">组件</div>
        {kinds.map((m) => (
          <div
            key={m.kind}
            className="palette-item"
            title={m.isContainer ? '容器：点击后新组件将放入其中' : '点击添加到选中组件之后'}
            onClick={() => addUIComponent(m.kind)}
          >
            <span className={`palette-dot cat-${m.isContainer ? 'ui' : 'action'}`} />
            {m.title}
          </div>
        ))}
        <div className="palette-hint">先点选容器再添加，可构建层级</div>
      </aside>
      <div className="ui-canvas">
        <div className="ui-canvas-hint">所见即所得 · 点击组件选中，右侧编辑属性</div>
        {working && <UIRenderer root={working.ui} ctx={ctx} />}
      </div>
      <aside className="ui-side">
        <div className="panel-title">层级</div>
        {working && (
          <div className="outline-tree">
            <OutlineTree comp={working.ui} />
          </div>
        )}
        <div className="panel-title">属性</div>
        {selected ? (
          <PropsEditor comp={selected} />
        ) : (
          <div className="inspector-empty">选中画布中的组件编辑属性</div>
        )}
      </aside>
    </div>
  )
}
