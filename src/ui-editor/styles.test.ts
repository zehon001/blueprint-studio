/**
 * 样式表解析/合并单测（v3 T11.1）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UINode } from '@/ir/types'
import { mergeStyleSheets, mergeStyledNode, parseStyleSheet } from './styles'

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

test('mergeStyledNode：无 classes / 无命中 → 原引用返回', () => {
  const n = node()
  assert.equal(mergeStyledNode(n, []), n)
  assert.equal(mergeStyledNode(n, [parseStyleSheet('{"version":1,"classes":{}}')]), n)
  const miss = node({ classes: ['ghost'] })
  assert.equal(mergeStyledNode(miss, [parseStyleSheet('{"version":1,"classes":{"x":{}}}')]), miss)
})
