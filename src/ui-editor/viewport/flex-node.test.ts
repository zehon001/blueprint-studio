/**
 * v3 flex 节点视口判定单测（T9.3）
 *
 * relative（流式）节点不可自由拖拽；absolute 节点可拖且位置读写走 layout.left/top。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UINode } from '@/ir/types'
import { isNodeFreelyPositionable, readNodePosition, writeNodePosition } from './commands'

function node(partial: Partial<UINode> & { id: string }): UINode {
  return {
    name: partial.id,
    type: 'label',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
    ...partial,
  } as UINode
}

const parent: UINode = node({ id: 'p', type: 'vbox' })

test('relative 节点：流式不可自由定位（即使父是 free 容器）', () => {
  const n = node({ id: 'a', layout: { position: 'relative', grow: 1 } })
  assert.equal(isNodeFreelyPositionable(n, parent), false)
  assert.equal(isNodeFreelyPositionable(n, node({ id: 'panel', type: 'panel' })), false)
})

test('absolute 节点：可自由定位（父可为任意容器）', () => {
  const n = node({ id: 'b', layout: { position: 'absolute', left: 12, top: 8 } })
  assert.equal(isNodeFreelyPositionable(n, parent), true)
  assert.deepEqual(readNodePosition(n), { x: 12, y: 8 })
  writeNodePosition(n, { x: 30, y: 40 })
  assert.deepEqual(n.layout?.left, 30)
  assert.deepEqual(n.layout?.top, 40)
  assert.deepEqual(n.transform.position, { x: 0, y: 0 })
})

test('v2 节点：沿用父容器类型判定；位置读写走 transform', () => {
  const n = node({ id: 'c' })
  assert.equal(isNodeFreelyPositionable(n, parent), false)
  assert.equal(isNodeFreelyPositionable(n, node({ id: 'panel', type: 'panel' })), true)
  writeNodePosition(n, { x: 5, y: 6 })
  assert.deepEqual(n.transform.position, { x: 5, y: 6 })
  assert.deepEqual(readNodePosition(n), { x: 5, y: 6 })
})
