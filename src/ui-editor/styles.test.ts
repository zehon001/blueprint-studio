/**
 * 样式表解析/合并单测（v3 T11.1）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UINode } from '@/ir/types'
import { mergeStyleSheets, mergeStyledNode, parseStyleSheet, resolveNodeStyle } from './styles'

function node(partial: Partial<UINode> = {}): UINode {
  return {
    id: 'n',
    name: 'n',
    type: 'button',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
    ...partial,
  }
}

test('parseStyleSheet：classes 解析 + 坏 JSON 报错', () => {
  const s = parseStyleSheet('{"version":1,"classes":{"primary":{"props":{"variant":"primary"}}}}')
  assert.equal(s.classes.primary?.props?.variant, 'primary')
  assert.throws(() => parseStyleSheet('{bad'), /不是合法 JSON/)
  assert.throws(() => parseStyleSheet('42'), /根节点不是对象/)
})

test('mergeStyledNode：类按表内声明序合并，内联值最后覆盖', () => {
  const sheets = mergeStyleSheets([
    JSON.stringify({
      version: 1,
      classes: {
        card: { props: { padding: 4, tone: 'card' }, layout: { grow: 0, margin: { t: 2 } } },
        compact: { props: { padding: 2 }, layout: { grow: 1 } },
      },
    }),
  ])
  const n = node({ classes: ['compact', 'card'], props: { padding: 9 } })
  const out = mergeStyledNode(n, sheets)
  assert.equal(out.props.padding, 9, '内联覆盖类')
  assert.equal(out.props.tone, 'card')
  assert.equal(out.layout?.grow, 1, 'compact 声明在 card 之后 → 覆盖')
  assert.deepEqual(out.layout?.margin, { t: 2 })
})

test('mergeStyledNode：跨表按 styles 数组顺序，后表覆盖前表', () => {
  const a = parseStyleSheet(JSON.stringify({ version: 1, classes: { x: { props: { v: 'a', only: 1 } } } }))
  const b = parseStyleSheet(JSON.stringify({ version: 1, classes: { x: { props: { v: 'b' } } } }))
  const out = mergeStyledNode(node({ classes: ['x'] }), [a, b])
  assert.equal(out.props.v, 'b')
  assert.equal(out.props.only, 1)
})

test('v3 三层优先级：schema 默认 < 样式类 < 内联（含来源）', () => {
  const sheet = parseStyleSheet(
    '{"version":1,"classes":{"title":{"props":{"text":"来自样式类"}},"compact":{"layout":{"grow":1}}}}',
  )
  // 无内联：样式类覆盖 schema 默认
  const styled = mergeStyledNode(node({ classes: ['title', 'compact'] }), [sheet])
  assert.equal(styled.props.text, '来自样式类')
  assert.equal(styled.layout?.grow, 1)
  // 内联覆盖样式类
  const inline = mergeStyledNode(node({ classes: ['title'], props: { text: '内联' } }), [sheet])
  assert.equal(inline.props.text, '内联')
  // 无类：默认值
  const plain = mergeStyledNode(node(), [sheet])
  assert.equal(plain.props.text, '按钮')
  // 来源信息（检视器有效值/高亮依据）
  const r = resolveNodeStyle(node({ classes: ['title'] }), [sheet])
  assert.equal(r.sources.text?.kind, 'class')
  assert.equal(r.sources.text?.className, 'title')
  assert.deepEqual(
    r.classes.map((c) => c.className),
    ['title'],
  )
})

test('mergeStyledNode：无 classes 也补 schema 默认值（v3 默认值不物化）', () => {
  const n = node()
  const out = mergeStyledNode(n, [])
  assert.notEqual(out, n, '返回新节点（补默认值）')
  assert.equal(out.props.text, '按钮', 'button.text 默认值由解析器补')
  assert.deepEqual(n.props, {}, '原节点不被修改')
  // 样式表无命中：仍返回默认值解析结果（不改变节点身份语义）
  const miss = node({ classes: ['ghost'] })
  const missOut = mergeStyledNode(miss, [parseStyleSheet('{"version":1,"classes":{"x":{}}}')])
  assert.equal(missOut.props.text, '按钮')
})
