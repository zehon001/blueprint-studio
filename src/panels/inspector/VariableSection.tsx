/**
 * 检视器「变量」区（v3 T10.4 / 需求 8 后半）
 *
 * 只显示内嵌蓝图里 `exposed: true` 的提升变量；场景自身直接改默认值。
 * 元素/预制体实例的覆盖值（UINode.vars）在 M11 元素系统接入后复用本区。
 */
import { findUINode, runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { useUIEditorStore } from '@/ui-editor/store'
import type { IRVariable, UIAsset, UINode } from '@/ir/types'

function valueText(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

/** 按类型把输入串转回值（布尔 / 数字 / JSON；失败保留字符串） */
function parseValue(raw: string, type: string): unknown {
  if (type === 'bool') return raw === 'true'
  if (type === 'int') {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'float') {
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

export function VariableSection({ node }: { node?: UINode }) {
  const asset = useSceneTreeDomain().asset
  const selection = useUIEditorStore((s) => s.selection)
  const vars = (asset?.variables ?? []).filter((v) => v && v.exposed === true)
  if (!asset || vars.length === 0) return null

  /** 场景自身：改 root 图变量默认值；实例（M11）：写覆盖 vars */
  const update = (name: string, raw: string, type: string): void => {
    runUICommand(`检视器：变量 ${name}`, (draft) => {
      const a = draft as UIAsset
      const target = node && selection.length === 1 ? findUINode(a.root, node.id) : null
      if (target) {
        target.vars = { ...(target.vars ?? {}), [name]: parseValue(raw, type) }
        return
      }
      const v = a.variables?.find((x) => x.name === name)
      if (v) v.default = parseValue(raw, type)
    })
  }

  return (
    <div className="insp-group insp-vars-group">
      <div className="insp-group-head insp-flex-head">
        <span className="insp-caret">▾</span>
        <span className="insp-group-title">变量（提升）</span>
        <span className="insp-count">{vars.length}</span>
      </div>
      <div className="insp-group-body">
        {vars.map((v: IRVariable) => {
          const override = node?.vars?.[v.name]
          return (
            <div key={v.name} className="insp-flex-row">
              <span className="insp-flex-label" title={`${v.name} : ${v.type}`}>
                {v.name}
              </span>
              <span className="insp-flex-control">
                <input
                  className="insp-flex-text"
                  type="text"
                  aria-label={`变量 ${v.name}`}
                  defaultValue={valueText(override !== undefined ? override : v.default)}
                  title={override !== undefined ? '实例覆盖（清空回落默认值）' : '默认值'}
                  onBlur={(e) => update(v.name, e.target.value, v.type)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <span className="insp-vars-type">{v.type}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
