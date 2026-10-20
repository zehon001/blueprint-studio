/**
 * 元素设置（v3 T11.3 / v3.2 数据绑定）：元素资产自身的 traits / 事件声明 /
 * 数据绑定。自定义属性已废弃（由提升变量 + 数据绑定替代），不再提供编辑入口。
 *
 * 数据绑定：把元素蓝图变量写到内部节点属性（单向，变量 → 属性）；实例通过
 * 「变量（提升）」覆盖 exposed 变量，展开/运行时重渲染时重新求值。
 *
 * 元素编辑器（UITab，kind=element）里常驻；修改走命令栈可撤销。
 * 复杂默认值（对象/数组）用 JSON 文本编辑，基础类型直接输入。
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { getUISchema, type UIPropType } from '@/ui-editor/schema'
import {
  bindablePropDefs,
  bindingIssue,
  isBindingCompatible,
} from '@/ui-editor/elementBindings'
import { Icon } from '@/shell/ui/Icon'
import type {
  ElementAsset,
  ElementBindingDef,
  IRVariable,
  UIAsset,
  UINode,
} from '@/ir/types'

type ElementAssetDraft = UIAsset &
  Partial<Pick<ElementAsset, 'title' | 'traits' | 'events' | 'bindings'>>

/** 内部节点候选项（绑定目标） */
interface InternalNodeOption {
  node: UINode
  id: string
  name: string
  depth: number
  title: string
}

function collectInternalNodes(
  root: UINode,
  depth = 0,
  out: InternalNodeOption[] = [],
): InternalNodeOption[] {
  out.push({
    node: root,
    id: root.id,
    name: root.name,
    depth,
    title: getUISchema(root.type)?.title ?? root.type,
  })
  for (const c of root.children ?? []) collectInternalNodes(c, depth + 1, out)
  return out
}

function attrTypeOf(node: UINode | undefined, attr: string): UIPropType | undefined {
  if (!node) return undefined
  return bindablePropDefs(node).find((p) => p.id === attr)?.type
}

export function ElementSettingsSection() {
  const { asset } = useSceneTreeDomain()
  const [open, setOpen] = useState(true)
  if (!asset || asset.kind !== 'element') return null

  const draft = asset as ElementAssetDraft
  const traits = draft.traits ?? []
  const events = draft.events ?? []
  const bindings = draft.bindings ?? []
  const variables: IRVariable[] = draft.variables ?? []
  const nodes = collectInternalNodes(asset.root)
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const mutate = (label: string, recipe: (a: ElementAssetDraft) => void): void => {
    runUICommand(`元素设置：${label}`, (d) => recipe(d as ElementAssetDraft))
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

  /* ============================================================
   * 数据绑定（变量 → 内部节点属性）
   * ============================================================ */

  const updateBinding = (index: number, patch: Partial<ElementBindingDef>): void => {
    mutate('修改数据绑定', (a) => {
      const list = [...(a.bindings ?? [])]
      const cur = list[index]
      if (!cur) return
      list[index] = { ...cur, ...patch }
      a.bindings = list
    })
  }

  const addBinding = (): void => {
    if (variables.length === 0 || nodes.length === 0) return
    // 默认优先选 text 属性（最常见的展示绑定），再找类型兼容的变量
    const candidates = nodes.flatMap((n) =>
      bindablePropDefs(n.node).map((p) => ({ node: n, prop: p })),
    )
    const picked = candidates.find((c) => c.prop.id === 'text') ?? candidates[0]
    if (!picked) return
    const source =
      variables.find((v) => isBindingCompatible(v.type, picked.prop.type))?.name ??
      variables[0]!.name
    mutate('新增数据绑定', (a) => {
      a.bindings = [
        ...(a.bindings ?? []),
        { target: picked.node.id, attr: picked.prop.id, source },
      ]
    })
  }

  const removeBinding = (index: number): void => {
    mutate('删除数据绑定', (a) => {
      a.bindings = (a.bindings ?? []).filter((_, i) => i !== index)
    })
  }

  /** 换目标节点：属性失效时自动落到该节点第一个可绑定属性 */
  const changeBindingTarget = (index: number, target: string): void => {
    const cur = bindings[index]
    if (!cur) return
    const attrs = bindablePropDefs(nodeById.get(target)?.node ?? asset.root)
    const attr = attrs.some((p) => p.id === cur.attr) ? cur.attr : (attrs[0]?.id ?? '')
    updateBinding(index, { target, attr })
  }

  /** 换目标属性：源变量类型不兼容时清空，逼用户重新选（下拉里灰项也看得到原因） */
  const changeBindingAttr = (index: number, attr: string): void => {
    const cur = bindings[index]
    if (!cur) return
    const type = attrTypeOf(nodeById.get(cur.target)?.node, attr)
    const variable = variables.find((v) => v.name === cur.source)
    const source = variable && isBindingCompatible(variable.type, type) ? variable.name : ''
    updateBinding(index, { attr, source })
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
      </button>
      {open ? (
        <div className="insp-group-body">
          <div className="insp-style-row">
            <span className="insp-flex-label">显示名称</span>
            <span className="insp-flex-control">
              <input
                className="insp-flex-text"
                type="text"
                defaultValue={draft.title ?? ''}
                placeholder={draft.name}
                title="元素在 UI 树 / 元素库中的显示名（留空则显示文件名）"
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  mutate('修改显示名称', (a) => {
                    a.title = v || undefined
                  })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </span>
          </div>

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

          {/* v3.2 数据绑定：变量 → 内部节点属性（单向） */}
          <div className="insp-style-row insp-binding-section">
            <span className="insp-flex-label">数据绑定</span>
            <span className="insp-flex-control">
              <button
                type="button"
                className="insp-btn"
                onClick={addBinding}
                disabled={variables.length === 0 || nodes.length === 0}
                title={
                  variables.length === 0
                    ? '先在「蓝图 → My Blueprint」定义变量'
                    : nodes.length === 0
                      ? '元素没有可绑定节点'
                      : '把元素蓝图变量写到内部节点属性'
                }
              >
                <Icon icon={Plus} size={12} /> 绑定
              </button>
            </span>
          </div>
          {variables.length === 0 ? (
            <div className="insp-note">
              绑定源是元素蓝图变量：先在「蓝图 → My Blueprint」定义变量；勾选「暴露」后实例检视器可覆盖。
            </div>
          ) : null}
          {bindings.map((b, i) => {
            const target = nodeById.get(b.target)
            const attrs = target ? bindablePropDefs(target.node) : []
            const prop = attrs.find((p) => p.id === b.attr)
            const issue = bindingIssue(draft as ElementAsset, b, i)
            return (
              <div className="insp-binding-card" key={`${i}:${b.target}:${b.attr}:${b.source}`}>
                <div className="insp-binding-head">
                  <span className="insp-binding-title">绑定 {i + 1}</span>
                  <button
                    type="button"
                    className="insp-btn"
                    title="删除绑定"
                    aria-label={`删除绑定 ${i + 1}`}
                    onClick={() => removeBinding(i)}
                  >
                    <Icon icon={X} size={12} />
                  </button>
                </div>
                <div className="insp-flex-row">
                  <span className="insp-flex-label">节点</span>
                  <span className="insp-flex-control">
                    <select
                      className="insp-flex-select"
                      aria-label="绑定目标节点"
                      value={b.target}
                      onChange={(e) => changeBindingTarget(i, e.target.value)}
                    >
                      {nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.depth > 0 ? '· '.repeat(n.depth) : ''}
                          {n.name}（{n.title}）
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                <div className="insp-flex-row">
                  <span className="insp-flex-label">属性</span>
                  <span className="insp-flex-control">
                    <select
                      className="insp-flex-select"
                      aria-label="绑定目标属性"
                      value={b.attr}
                      onChange={(e) => changeBindingAttr(i, e.target.value)}
                    >
                      {attrs.length === 0 ? <option value="">无可绑定属性</option> : null}
                      {attrs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}（{p.id}）
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                <div className="insp-flex-row">
                  <span className="insp-flex-label">变量</span>
                  <span className="insp-flex-control">
                    <select
                      className="insp-flex-select"
                      aria-label="绑定源变量"
                      value={b.source}
                      onChange={(e) => updateBinding(i, { source: e.target.value })}
                    >
                      <option value="">选择变量…</option>
                      {variables.map((v) => (
                        <option
                          key={v.name}
                          value={v.name}
                          disabled={!isBindingCompatible(v.type, prop?.type)}
                        >
                          {v.name}（{v.type}
                          {v.exposed ? ' · 外部' : ' · 内部'}）
                        </option>
                      ))}
                    </select>
                  </span>
                </div>
                {issue ? <div className="insp-binding-warning">{issue}</div> : null}
              </div>
            );
          })}
          {bindings.length > 0 ? (
            <div className="insp-note">单向绑定：变量 → 属性；运行时改变量会刷新该节点。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
