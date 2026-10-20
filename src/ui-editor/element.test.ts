/**
 * 元素资产展开单测（v3 T11.2）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ElementAsset, UINode } from '@/ir/types'
import { expandElementNode, findElementCycle, parseElementAsset } from './element'
import { previewElementAsset } from './elementBindings'

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

/* ============================================================
 * v3.2：展开隔离 + 数据绑定
 * ============================================================ */

function elementInstance(id: string, vars?: Record<string, unknown>): UINode {
  return node({
    id,
    type: '__element',
    element: 'card.elem.json',
    ...(vars ? { vars } : {}),
  })
}

test('expandElementNode：多次展开不污染元素缓存（前缀不叠加）', () => {
  const root = node({
    id: 'el_root',
    children: [node({ id: 'el_child', type: 'label', props: { text: 'hi' } })],
  })
  const asset = element('Card', root)
  const first = expandElementNode(elementInstance('i1'), () => asset)
  const second = expandElementNode(elementInstance('i2'), () => asset)
  assert.equal(first.node.children[0]!.id, 'i1::el_child')
  assert.equal(second.node.children[0]!.id, 'i2::el_child', '第二次展开不能叠加第一次前缀')
  assert.equal(asset.root.children[0]!.id, 'el_child', '缓存节点 id 必须保持原样')
})

test('数据绑定：变量默认值 / 实例 vars 覆盖 / 标量→文本', () => {
  const root = node({
    id: 'el_root',
    children: [node({ id: 'el_label', type: 'label', props: { text: 'hard' } })],
  })
  const asset: ElementAsset = {
    ...element('Card', root),
    variables: [{ name: 'value', type: 'string', default: '0', exposed: true }],
    bindings: [{ target: 'el_label', attr: 'text', source: 'value' }],
  }
  const overridden = expandElementNode(elementInstance('card1', { value: 42 }), () => asset)
  assert.equal(overridden.node.children[0]!.props.text, '42', 'int 实例值格式化为文本')
  const fallback = expandElementNode(elementInstance('card2'), () => asset)
  assert.equal(fallback.node.children[0]!.props.text, '0', '无覆盖回落变量默认值')
  assert.equal(asset.root.children[0]!.props.text, 'hard', '绑定不写回元素缓存')
})

test('数据绑定：类型不兼容跳过，不破坏原属性', () => {
  const root = node({
    id: 'el_root',
    children: [node({ id: 'el_label', type: 'label', props: { text: 'keep' } })],
  })
  const asset: ElementAsset = {
    ...element('Card', root),
    variables: [{ name: 'payload', type: 'object', default: { a: 1 } }],
    bindings: [{ target: 'el_label', attr: 'text', source: 'payload' }],
  }
  const out = expandElementNode(elementInstance('card1'), () => asset)
  assert.equal(out.node.children[0]!.props.text, 'keep')
})

test('预览绑定：clone 后应用默认值，不修改元素资产', () => {
  const root = node({
    id: 'el_root',
    children: [node({ id: 'el_label', type: 'label', props: { text: 'hard' } })],
  })
  const asset: ElementAsset = {
    ...element('Card', root),
    variables: [{ name: 'value', type: 'string', default: 'preview' }],
    bindings: [{ target: 'el_label', attr: 'text', source: 'value' }],
  }
  const preview = previewElementAsset(asset)
  assert.equal((preview.root.children[0] as UINode).props.text, 'preview')
  assert.equal(asset.root.children[0]!.props.text, 'hard')
})
