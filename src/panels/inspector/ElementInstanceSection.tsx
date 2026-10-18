/**
 * 元素实例检视区（v3 T11.3 · PLAN §3.2/§5.4/§8.3）
 *
 * 元素实例 = 引用 + 覆盖：
 *  - props：元素自定义属性（ElementAsset.props）的实例覆盖；
 *  - vars：元素内嵌图中 exposed=true 变量的实例覆盖（清空即回落类默认值）；
 *  - traits / events：元素资产对外声明的能力与事件。
 * 结构以元素资产为准，不做断开物化（PLAN §5.4）。
 */
import { runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { getUISchema, type PropDef, type UIPropType } from '@/ui-editor/schema'
import type { ElementAsset, ElementPropDef, UINode } from '@/ir/types'
import { PropEditor } from './PropEditors'
import { requestUIBlueprint } from '@/shell/workspace/uiBlueprintBridge'

const PROP_TYPES: ReadonlySet<string> = new Set([
  'number',
  'int',
  'string',
  'bool',
  'select',
  'color',
  'textarea',
  'vec2',
  'size',
  'listColumns',
  'assetRef',
  'logicRef',
  'options',
])

function toPropDef(def: ElementPropDef): PropDef {
  const type = def.type && PROP_TYPES.has(def.type) ? (def.type as UIPropType) : 'string'
  return {
    id: def.id,
    label: def.label ?? def.id,
    type,
    group: '元素',
    default: def.default,
    doc: def.doc,
  }
}

function parseValue(raw: string, type: string): unknown {
  if (type === 'bool') return raw === 'true'
  if (type === 'int') {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'float' || type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (type.startsWith('string') || type === 'any') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function valueText(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export function ElementInstanceSection(props: { node: UINode; asset: ElementAsset }) {
  const { node, asset } = props
  const domain = useSceneTreeDomain()
  const exposedVars = (asset.variables ?? []).filter((v) => v.exposed === true)
  const traits = asset.traits ?? []
  const events = asset.events ?? []

  const writeProp = (def: PropDef, value: unknown): void => {
    if (!domain.asset) return
    runUICommand(`检视器：元素属性 ${def.label}`, (draft) => {
      const target = findNode((draft as { root: UINode }).root, node.id)
      if (target) target.props = { ...(target.props ?? {}), [def.id]: value }
    })
  }

  const resetProp = (def: PropDef): void => {
    runUICommand(`检视器：重置元素属性 ${def.label}`, (draft) => {
      const target = findNode((draft as { root: UINode }).root, node.id)
      if (target?.props) delete target.props[def.id]
    })
  }

  const writeVar = (name: string, raw: string, type: string): void => {
    runUICommand(`检视器：元素变量 ${name}`, (draft) => {
      const target = findNode((draft as { root: UINode }).root, node.id)
      if (!target) return
      const vars = { ...(target.vars ?? {}) }
      if (raw.trim() === '') delete vars[name]
      else vars[name] = parseValue(raw, type)
      target.vars = vars
    })
  }

  if ((asset.props ?? []).length === 0 && exposedVars.length === 0 && traits.length === 0 && events.length === 0) {
    return null
  }

  return (
    <div className="insp-group insp-style-group">
      <div className="insp-group-head insp-flex-head">
        <span className="insp-caret">▾</span>
        <span className="insp-group-title">元素</span>
        <span className="insp-count">{(asset.props ?? []).length}</span>
      </div>
      <div className="insp-group-body">
        {(asset.props ?? []).length > 0 ? (
          <>
            <div className="insp-style-row">
              <span className="insp-flex-label">自定义属性</span>
              <span className="insp-note">值写为实例覆盖（清空回落元素默认值）</span>
            </div>
            {(asset.props ?? []).map((rawDef) => {
              const def = toPropDef(rawDef)
              const hasOverride = node.props?.[def.id] !== undefined
              const value = hasOverride ? node.props?.[def.id] : def.default
              return (
                <div className="insp-row" key={def.id}>
                  <span className="insp-label" title={def.doc ?? def.label}>
                    {def.label}
                  </span>
                  <span className="insp-control">
                    <PropEditor
                      def={def}
                      value={value}
                      mixed={false}
                      disabled={false}
                      onCommit={(v) => writeProp(def, v)}
                      onPlaceholder={() => {}}
                    />
                    {hasOverride ? (
                      <button
                        type="button"
                        className="insp-btn"
                        title="移除实例覆盖，回落元素默认值"
                        onClick={() => resetProp(def)}
                      >
                        ↺
                      </button>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </>
        ) : null}

        {exposedVars.length > 0 ? (
          <>
            <div className="insp-style-row">
              <span className="insp-flex-label">变量（提升）</span>
              <span className="insp-note">清空输入框即回落类默认值</span>
            </div>
            {exposedVars.map((v) => {
              const override = node.vars?.[v.name]
              return (
                <div className="insp-flex-row" key={v.name}>
                  <span className="insp-flex-label" title={`${v.name} : ${v.type}`}>
                    {v.name}
                  </span>
                  <span className="insp-flex-control">
                    <input
                      className="insp-flex-text"
                      type="text"
                      aria-label={`元素变量 ${v.name}`}
                      defaultValue={valueText(override !== undefined ? override : v.default)}
                      title={override !== undefined ? '实例覆盖（清空回落默认值）' : '类默认值'}
                      onBlur={(e) => writeVar(v.name, e.target.value, v.type)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      }}
                    />
                    <span className="insp-vars-type">{v.type}</span>
                    {override !== undefined ? (
                      <button
                        type="button"
                        className="insp-btn"
                        title="移除实例覆盖"
                        onClick={() => writeVar(v.name, '', v.type)}
                      >
                        ↺
                      </button>
                    ) : null}
                  </span>
                </div>
              )
            })}
          </>
        ) : null}

        {traits.length > 0 ? (
          <div className="insp-style-row">
            <span className="insp-flex-label">traits</span>
            <span className="insp-style-sheets">
              {traits.map((t) => (
                <span key={t} className="insp-chip">
                  {t}
                </span>
              ))}
            </span>
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="insp-style-row">
            <span className="insp-flex-label">自定义事件</span>
            <span className="insp-style-sheets">
              {events.map((e) => (
                <button
                  key={e.name}
                  type="button"
                  className="insp-chip"
                  title="在元素蓝图中查看"
                  onClick={() =>
                    requestUIBlueprint({ assetPath: node.element, graph: 'event', eventName: e.name })
                  }
                >
                  {e.name}
                </button>
              ))}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function findNode(root: UINode, id: string): UINode | null {
  if (root.id === id) return root
  for (const c of root.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/** 供外部（检视器）判断元素资产是否有可编辑内容；避免重复 schema 查询 */
export function elementHasInstanceUi(asset: ElementAsset): boolean {
  return (
    (asset.props ?? []).length > 0 ||
    (asset.variables ?? []).some((v) => v.exposed === true) ||
    (asset.traits ?? []).length > 0 ||
    (asset.events ?? []).length > 0
  )
}

/** 元素资产根类型对应的基础 schema（检视器头部图标/标题用；无则 undefined） */
export function elementRootSchema(asset: ElementAsset): ReturnType<typeof getUISchema> {
  return getUISchema(asset.root.type)
}
