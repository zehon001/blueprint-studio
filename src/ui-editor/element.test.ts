/**
 * 元素资产展开单测（v3 T11.2）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ElementAsset, UINode } from '@/ir/types'
import { expandElementNode, findElementCycle, parseElementAsset } from './element'

function node(partial: Partial<UINode> & { id: string }): UINode {
  return {
    name: partial.id,
    type: 'vbox',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
    ...partial,
  }
}

function element(name: string, root: UINode, defs: ElementAsset['props'] = []): ElementAsset {
  return { version: 3, kind: 'element', name, props: defs, root }
}

test('parseElementAsset：kind/root 校验', () => {
  assert.equal(parseElementAsset('{"version":3,"kind":"element","name":"x","root":{"id":"r"}}', 'x').name, 'x')
  assert.throws(() => parseElementAsset('{"version":3,"kind":"scene","root":{}}', 'x'), /kind 无效/)
  assert.throws(() => parseElementAsset('{"version":3,"kind":"element"}', 'x'), /缺少 root/)
})

test('expandElementNode：结构取元素根、props 三层合并、实例 layout 保留', () => {
  const root = node({
    id: 'el_root',
    type: 'vbox',
    props: { padding: 4, title: 'default' },
    layout: { grow: 1 },
    children: [node({ id: 'el_child', type: 'label', props: { text: 'hi' } })],
  })
  const asset = element('Card', root, [{ id: 'title', default: 'hello' }])
  const instance = node({
    id: 'card1',
    type: '__element',
    element: 'ui/elements/card.elem.json',
    name: 'card1',
    props: { title: 'override' },
    layout: { position: 'absolute', left: 10, top: 20 },
  })
  const out = expandElementNode(instance, (p) => (p === instance.element ? asset : undefined))
  assert.equal(out.node.id, 'card1')
  assert.equal(out.node.name, 'card1')
  assert.equal(out.node.type, 'vbox')
  assert.equal(out.node.layout?.position, 'absolute')
  assert.equal(out.node.layout?.left, 10)
  assert.equal(out.node.props.title, 'override')
  assert.equal(out.node.props.padding, 4)
  assert.equal(out.node.children.length, 1)
  assert.equal(out.node.children[0].props.text, 'hi')
})

test('expandElementNode：缺失 → 占位；循环 → 中文错误', () => {
  const inst = node({ id: 'a', type: '__element', element: 'missing.elem.json' })
  const miss = expandElementNode(inst, () => undefined)
  assert.match(String(miss.node.props.__element_placeholder_text), /元素未加载/)

  const self = element('Self', node({ id: 'r', type: '__element', element: 'self.elem.json' }))
  const cyc = expandElementNode(
    node({ id: 'c', type: '__element', element: 'self.elem.json' }),
    () => self,
  )
  assert.match(cyc.error ?? '', /循环引用/)
  assert.match(String(cyc.node.props.__element_placeholder_text), /循环引用/)
})

test('findElementCycle：正常嵌套 null；自引用检出', () => {
  const leaf = element('Leaf', node({ id: 'l' }))
  const ok = findElementCycle(
    node({ id: 'a', element: 'leaf.elem.json' }),
    (p) => (p === 'leaf.elem.json' ? leaf : undefined),
  )
  assert.equal(ok, null)
  const self = element('Self', node({ id: 's', element: 'self.elem.json' }))
  assert.match(findElementCycle(node({ id: 'x', element: 'self.elem.json' }), () => self) ?? '', /循环引用/)
})
