/**
 * 元素设置（v3 T11.3）：元素资产自身的自定义属性 / traits / 事件声明。
 *
 * 元素编辑器（UITab，kind=element）里常驻；修改走命令栈可撤销。
 * 复杂默认值（对象/数组）用 JSON 文本编辑，基础类型直接输入。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { Icon } from '@/shell/ui/Icon'
import type { ElementAsset, ElementPropDef, UIAsset } from '@/ir/types'

type ElementAssetDraft = UIAsset & Partial<Pick<ElementAsset, 'props' | 'traits' | 'events'>>

const PROP_TYPES = ['string', 'number', 'int', 'float', 'bool', 'select', 'color', 'textarea'] as const

function defaultText(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

function parseDefault(text: string, type: string): unknown {
  const raw = text.trim()
  if (raw === '') return undefined
  if (type === 'bool') return raw === 'true'
  if (type === 'int') {
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'number' || type === 'float') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  if (type === 'string' || type === 'textarea' || type === 'color' || type === 'select') return text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function ElementSettingsSection() {
  const { asset } = useSceneTreeDomain()
  const [open, setOpen] = useState(true)
  if (!asset || asset.kind !== 'element') return null

  const draft = asset as ElementAssetDraft
  const props = draft.props ?? []
  const traits = draft.traits ?? []
  const events = draft.events ?? []

  const mutate = (label: string, recipe: (a: ElementAssetDraft) => void): void => {
    runUICommand(`元素设置：${label}`, (d) => recipe(d as ElementAssetDraft))
  }

  const updateProp = (index: number, patch: Partial<ElementPropDef>): void => {
    mutate('修改自定义属性', (a) => {
      const list = [...(a.props ?? [])]
      list[index] = { ...list[index]!, ...patch }
      a.props = list
    })
  }

  const addProp = (): void => {
    mutate('新增自定义属性', (a) => {
      const list = [...(a.props ?? [])]
      let n = list.length + 1
      while (list.some((p) => p.id === `prop${n}`)) n += 1
      list.push({ id: `prop${n}`, label: `属性 ${n}`, type: 'string', default: '' })
      a.props = list
    })
  }

  const removeProp = (index: number): void => {
    mutate('删除自定义属性', (a) => {
      a.props = (a.props ?? []).filter((_, i) => i !== index)
    })
  }

  const writeTraits = (text: string): void => {
    const list = text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    mutate('修改 traits', (a) => {
      a.traits = [...new Set(list)]
    })
  }

  const addEvent = (): void => {
    mutate('新增自定义事件', (a) => {
      const list = [...(a.events ?? [])]
      let n = list.length + 1
      while (list.some((e) => e.name === `event${n}`)) n += 1
      list.push({ name: `event${n}`, params: [] })
      a.events = list
    })
  }

  return (
    <div className="insp-group insp-style-group">
      <button
        type="button"
        className="insp-group-head insp-flex-head"
        onClick={() => setOpen((v) => !v)}
        title={open ? '折叠' : '展开'}
      >
        <span className="insp-caret">
          <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
        </span>
        <span className="insp-group-title">元素设置</span>
        <span className="insp-count">{props.length}</span>
      </button>
      {open ? (
        <div className="insp-group-body">
          <div className="insp-style-row">
            <span className="insp-flex-label">traits</span>
            <span className="insp-flex-control">
              <input
                className="insp-flex-text"
                type="text"
                defaultValue={traits.join(', ')}
                placeholder="text, value, items…"
                title="逗号分隔；元素实例对外暴露的能力"
                onBlur={(e) => writeTraits(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </span>
          </div>

          <div className="insp-style-row">
            <span className="insp-flex-label">自定义属性</span>
            <span className="insp-flex-control">
              <button type="button" className="insp-btn" onClick={addProp}>
                <Icon icon={Plus} size={12} /> 属性
              </button>
            </span>
          </div>
          {props.map((p, i) => (
            <div className="insp-flex-row" key={`${p.id}-${i}`}>
              <span className="insp-flex-control">
                <input
                  className="insp-flex-text"
                  value={p.id}
                  title="属性 id（实例 props 键）"
                  onChange={(e) => updateProp(i, { id: e.target.value })}
                />
                <input
                  className="insp-flex-text"
                  value={p.label ?? ''}
                  title="显示名"
                  onChange={(e) => updateProp(i, { label: e.target.value })}
                />
                <select
                  className="insp-flex-select"
                  value={p.type ?? 'string'}
                  aria-label="属性类型"
                  onChange={(e) => updateProp(i, { type: e.target.value })}
                >
                  {PROP_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <input
                  className="insp-flex-text"
                  defaultValue={defaultText(p.default)}
                  title="默认值（对象/数组用 JSON）"
                  onBlur={(e) => updateProp(i, { default: parseDefault(e.target.value, p.type ?? 'string') })}
                />
                <button type="button" className="insp-btn" title="删除属性" onClick={() => removeProp(i)}>
                  <Icon icon={X} size={12} />
                </button>
              </span>
            </div>
          ))}

          <div className="insp-style-row">
            <span className="insp-flex-label">自定义事件</span>
            <span className="insp-flex-control">
              <button type="button" className="insp-btn" onClick={addEvent}>
                <Icon icon={Plus} size={12} /> 事件
              </button>
            </span>
          </div>
          {events.map((e, i) => (
            <div className="insp-flex-row" key={`${e.name}-${i}`}>
              <span className="insp-flex-control">
                <input
                  className="insp-flex-text"
                  value={e.name}
                  title="事件名"
                  onChange={(ev) =>
                    mutate('修改事件名', (a) => {
                      const list = [...(a.events ?? [])]
                      list[i] = { ...list[i]!, name: ev.target.value }
                      a.events = list
                    })
                  }
                />
                <button
                  type="button"
                  className="insp-btn"
                  title="删除事件"
                  onClick={() =>
                    mutate('删除自定义事件', (a) => {
                      a.events = (a.events ?? []).filter((_, idx) => idx !== i)
                    })
                  }
                >
                  <Icon icon={X} size={12} />
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
