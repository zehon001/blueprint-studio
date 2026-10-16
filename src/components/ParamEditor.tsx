import type { ParamDef } from '../types'

export function ParamField({
  def,
  value,
  options,
  onChange,
}: {
  def: ParamDef
  value: unknown
  options?: { value: string; label: string }[]
  onChange: (value: unknown) => void
}) {
  const label = <span className="bp-param-label">{def.label}</span>

  if (def.valueType === 'boolean') {
    return (
      <label className="bp-param">
        {label}
        <input
          type="checkbox"
          className="nodrag"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    )
  }
  if (def.valueType === 'number') {
    return (
      <label className="bp-param">
        {label}
        <input
          type="number"
          className="nodrag bp-input"
          value={value == null ? 0 : Number(value)}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
      </label>
    )
  }
  if (def.valueType === 'text' || def.valueType === 'map') {
    return (
      <label className="bp-param bp-param-col">
        {label}
        <textarea
          className="nodrag bp-input"
          rows={def.valueType === 'map' ? 4 : 2}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    )
  }
  if (def.valueType === 'select') {
    return (
      <label className="bp-param">
        {label}
        <select
          className="nodrag bp-input"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    )
  }
  // variable / asset / source / uicomponent：从上下文取候选
  if (
    def.valueType === 'variable' ||
    def.valueType === 'asset' ||
    def.valueType === 'source' ||
    def.valueType === 'uicomponent'
  ) {
    return (
      <label className="bp-param">
        {label}
        <select
          className="nodrag bp-input"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">（未选择）</option>
          {(options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label className="bp-param">
      {label}
      <input
        type="text"
        className="nodrag bp-input"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
