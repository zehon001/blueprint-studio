/**
 * 检视器「布局（flex）」区（v3 T9.5）
 *
 * 直接编辑 UINode.layout / container（v3 契约）；改动经 runUICommand 入命令栈可撤销。
 * v2 节点首次编辑自动补 layout/container（之后渲染器走 flex 引擎）。
 */
import { useState, type ReactNode } from 'react'
import { findUINode, runUICommand, useSceneTreeDomain } from '@/ui-editor/store'
import { getUISchema } from '@/ui-editor/schema'
import type { UIContainer, UILength, UINode } from '@/ir/types'

/** 文本 → UILength（空/auto → auto；纯数字 → px；其余按 % 或原样） */
function parseLength(raw: string): UILength {
  const v = raw.trim()
  if (v === '' || v === 'auto') return 'auto'
  const n = Number(v)
  if (Number.isFinite(n)) return n
  if (/^-?\d+(\.\d+)?%$/.test(v)) return v as UILength
  return 'auto'
}

function lengthText(v: UILength | undefined): string {
  return v === undefined || v === 'auto' ? 'auto' : String(v)
}

function NumberInput(props: { value: number | undefined; onChange: (v: number) => void; title: string; min?: number }) {
  return (
    <input
      className="insp-flex-num"
      type="number"
      step={1}
      min={props.min}
      value={props.value ?? 0}
      title={props.title}
      aria-label={props.title}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) props.onChange(n)
      }}
    />
  )
}

function TextInput(props: { value: string; onChange: (v: string) => void; title: string }) {
  return (
    <input
      className="insp-flex-text"
      type="text"
      value={props.value}
      title={props.title}
      aria-label={props.title}
      spellCheck={false}
      onChange={(e) => props.onChange(e.target.value)}
    />
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="insp-flex-row">
      <span className="insp-flex-label">{label}</span>
      <span className="insp-flex-control">{children}</span>
    </div>
  )
}

/** 编辑当前选中节点（单节点） */
export function FlexLayoutSection({ node }: { node: UINode }) {
  const asset = useSceneTreeDomain().asset
  const isContainer = !!node.container || getUISchema(node.type)?.category === '容器'
  const [collapsed, setCollapsed] = useState(false)

  /** 单命令写入 layout/container（每次控件改动一条，可撤销） */
  const update = (label: string, patch: (n: UINode) => void): void => {
    if (!asset) return
    runUICommand(`检视器：${label}`, (draft) => {
      const n = findUINode((draft as typeof asset).root, node.id)
      if (n) patch(n)
    })
  }

  const l = node.layout
  const c = node.container
  const pos = l?.position ?? 'relative'

  return (
    <div className="insp-group insp-flex-group">
      <button
        type="button"
        className="insp-group-head insp-flex-head"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? '展开' : '折叠'}
      >
        <span className="insp-caret">{collapsed ? '▸' : '▾'}</span>
        <span className="insp-group-title">布局（flex）</span>
      </button>
      {collapsed ? null : (
      <div className="insp-group-body">
        <Row label="位置">
          <select
            className="insp-flex-select"
            value={pos}
            aria-label="定位模式"
            onChange={(e) =>
              update('定位模式', (n) => {
                n.layout = { ...(n.layout ?? {}), position: e.target.value as 'relative' | 'absolute' }
              })
            }
          >
            <option value="relative">relative（流式）</option>
            <option value="absolute">absolute（自由）</option>
          </select>
        </Row>
        {pos === 'relative' ? (
          <>
            <Row label="grow / shrink">
              <NumberInput
                title="flex grow"
                min={0}
                value={l?.grow}
                onChange={(v) =>
                  update('flex grow', (n) => {
                    n.layout = { ...(n.layout ?? {}), grow: Math.max(0, v) }
                  })
                }
              />
              <NumberInput
                title="flex shrink"
                min={0}
                value={l?.shrink}
                onChange={(v) =>
                  update('flex shrink', (n) => {
                    n.layout = { ...(n.layout ?? {}), shrink: Math.max(0, v) }
                  })
                }
              />
            </Row>
            <Row label="basis">
              <TextInput
                title="flex basis（px / % / auto）"
                value={lengthText(l?.basis)}
                onChange={(v) =>
                  update('flex basis', (n) => {
                    n.layout = { ...(n.layout ?? {}), basis: parseLength(v) }
                  })
                }
              />
            </Row>
          </>
        ) : (
          <Row label="left / top">
            <NumberInput
              title="left"
              value={typeof l?.left === 'number' ? l.left : 0}
              onChange={(v) =>
                update('absolute left', (n) => {
                  n.layout = { ...(n.layout ?? {}), position: 'absolute', left: v }
                })
              }
            />
            <NumberInput
              title="top"
              value={typeof l?.top === 'number' ? l.top : 0}
              onChange={(v) =>
                update('absolute top', (n) => {
                  n.layout = { ...(n.layout ?? {}), position: 'absolute', top: v }
                })
              }
            />
          </Row>
        )}
        <Row label="尺寸 w / h">
          <TextInput
            title="width（px / % / auto）"
            value={lengthText(l?.size?.w)}
            onChange={(v) =>
              update('宽度', (n) => {
                n.layout = { ...(n.layout ?? {}), size: { w: parseLength(v), h: n.layout?.size?.h ?? 'auto' } }
              })
            }
          />
          <TextInput
            title="height（px / % / auto）"
            value={lengthText(l?.size?.h)}
            onChange={(v) =>
              update('高度', (n) => {
                n.layout = { ...(n.layout ?? {}), size: { w: n.layout?.size?.w ?? 'auto', h: parseLength(v) } }
              })
            }
          />
        </Row>
        <Row label="margin t/r/b/l">
          {(['t', 'r', 'b', 'l'] as const).map((side) => (
            <NumberInput
              key={side}
              title={`margin ${side}`}
              value={l?.margin?.[side]}
              onChange={(v) =>
                update(`margin ${side}`, (n) => {
                  n.layout = { ...(n.layout ?? {}), margin: { ...(n.layout?.margin ?? {}), [side]: v } }
                })
              }
            />
          ))}
        </Row>

        {isContainer ? (
          <>
            <div className="insp-flex-subtitle">容器</div>
            <Row label="方向 / 换行">
              <select
                className="insp-flex-select"
                value={c?.direction ?? 'column'}
                aria-label="容器方向"
                onChange={(e) =>
                  update('容器方向', (n) => {
                    n.container = { ...(n.container ?? {}), direction: e.target.value as UIContainer['direction'] }
                  })
                }
              >
                <option value="column">column</option>
                <option value="row">row</option>
              </select>
              <select
                className="insp-flex-select"
                value={c?.wrap ?? 'nowrap'}
                aria-label="容器换行"
                onChange={(e) =>
                  update('容器换行', (n) => {
                    n.container = { ...(n.container ?? {}), wrap: e.target.value as UIContainer['wrap'] }
                  })
                }
              >
                <option value="nowrap">nowrap</option>
                <option value="wrap">wrap</option>
                <option value="wrap-reverse">wrap-reverse</option>
              </select>
            </Row>
            <Row label="justify / align">
              <select
                className="insp-flex-select"
                value={c?.justify ?? 'start'}
                aria-label="主轴对齐"
                onChange={(e) =>
                  update('主轴对齐', (n) => {
                    n.container = { ...(n.container ?? {}), justify: e.target.value as UIContainer['justify'] }
                  })
                }
              >
                {['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <select
                className="insp-flex-select"
                value={c?.align ?? 'stretch'}
                aria-label="交叉轴对齐"
                onChange={(e) =>
                  update('交叉轴对齐', (n) => {
                    n.container = { ...(n.container ?? {}), align: e.target.value as UIContainer['align'] }
                  })
                }
              >
                {['start', 'center', 'end', 'stretch', 'baseline'].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="gap / 溢出">
              <NumberInput
                title="gap"
                min={0}
                value={c?.gap}
                onChange={(v) =>
                  update('gap', (n) => {
                    n.container = { ...(n.container ?? {}), gap: Math.max(0, v) }
                  })
                }
              />
              <select
                className="insp-flex-select"
                value={c?.overflow ?? 'visible'}
                aria-label="溢出"
                onChange={(e) =>
                  update('溢出', (n) => {
                    n.container = { ...(n.container ?? {}), overflow: e.target.value as UIContainer['overflow'] }
                  })
                }
              >
                <option value="visible">visible</option>
                <option value="hidden">hidden</option>
                <option value="scroll">scroll</option>
              </select>
            </Row>
            <Row label="padding t/r/b/l">
              {(['t', 'r', 'b', 'l'] as const).map((side) => (
                <NumberInput
                  key={side}
                  title={`padding ${side}`}
                  value={c?.padding?.[side]}
                  onChange={(v) =>
                    update(`padding ${side}`, (n) => {
                      n.container = { ...(n.container ?? {}), padding: { ...(n.container?.padding ?? {}), [side]: v } }
                    })
                  }
                />
              ))}
            </Row>
          </>
        ) : null}
      </div>
      )}
    </div>
  )
}
