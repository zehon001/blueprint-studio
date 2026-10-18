/**
 * v3 资产 roundtrip（T13.3 最小门禁）
 *
 * 覆盖 v3 新增资产形态：UI（flex/内嵌图/变量/事件）、元素、样式表、函数。
 * 逻辑节点 IR 结构未变，节点级 roundtrip 由既有 TA.1 门禁覆盖；这里保证
 * v3 资产 JSON 解析 → 序列化 → 再解析稳定、字段不丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUIAsset } from '../../src/ui-editor/store'
import { parseElementAsset } from '../../src/ui-editor/element'
import { parseStyleSheet } from '../../src/ui-editor/styles'
import { functionGraphOf } from '../../src/runtime/functions'

function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const ui = {
  version: 3,
  kind: 'scene',
  name: 'main',
  styles: ['ui/styles/app.uss.json'],
  root: {
    id: 'root',
    name: 'root',
    type: 'vbox',
    layout: { size: { w: '100%', h: '100%' } },
    container: { direction: 'column', gap: 4 },
    transform: { position: { x: 0, y: 0 }, size: { w: 960, h: 640 }, rotation: 0 },
    theme: {},
    props: {},
    children: [
      {
        id: 'child',
        name: 'child',
        type: 'label',
        layout: { grow: 1, size: { w: 'auto', h: 32 } },
        transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
        theme: {},
        props: { text: 'hi' },
        children: [],
      },
    ],
  },
  graphs: {
    event: {
      kind: 'event',
      nodes: [{ id: 's', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } }],
      edges: [],
      comments: [],
    },
  },
  layout: { event: { zoom: 1, pan: [0, 0] } },
  variables: [{ name: 'count', type: 'int', default: 0, exposed: true }],
  events: [{ name: 'loaded', params: [] }],
}

test('UI v3：解析 → 序列化 → 再解析字段稳定（flex/图/变量/事件）', () => {
  const a = parseUIAsset(JSON.stringify(ui))
  const b = parseUIAsset(JSON.stringify(roundtrip(a)))
  assert.deepEqual(b, a)
  assert.equal(b.root.layout?.size?.w, '100%')
  assert.equal(b.root.container?.gap, 4)
  assert.equal(b.graphs?.event.nodes.length, 1)
  assert.equal(b.variables?.[0].name, 'count')
})

test('元素 v3：kind/root/自定义属性/traits/图 roundtrip', () => {
  const element = {
    version: 3,
    kind: 'element',
    name: 'Card',
    props: [{ id: 'title', type: 'string', default: 'hi' }],
    traits: ['text'],
    styles: ['ui/styles/app.uss.json'],
    root: ui.root,
    graphs: { event: { kind: 'event', nodes: [], edges: [], comments: [] } },
    variables: [],
    layout: {},
  }
  const a = parseElementAsset(JSON.stringify(element), 'card.elem.json')
  const b = parseElementAsset(JSON.stringify(roundtrip(a)), 'card.elem.json')
  assert.deepEqual(b, a)
  assert.equal(b.kind, 'element')
  assert.equal(b.traits?.[0], 'text')
})

test('样式表：类定义 roundtrip（props/layout/container）', () => {
  const sheet = {
    version: 1,
    classes: {
      card: { props: { text: 'x' }, layout: { grow: 1 }, container: { gap: 8 } },
    },
  }
  const a = parseStyleSheet(JSON.stringify(sheet))
  const b = parseStyleSheet(JSON.stringify(roundtrip(a)))
  assert.deepEqual(b, a)
})

test('函数 v3：签名与图 roundtrip（params/returns）', () => {
  const fn = {
    version: 3,
    kind: 'function',
    scope: 'project',
    name: 'fmt',
    params: [{ name: 'x', type: 'int' }],
    returns: [{ name: 'y', type: 'string' }],
    graph: { nodes: [], edges: [] },
  }
  const a = functionGraphOf(JSON.stringify(fn), 'fmt')
  const b = functionGraphOf(JSON.stringify(roundtrip({ ...fn, graph: a })), 'fmt')
  assert.deepEqual(b, a)
  assert.equal(b.params?.[0].name, 'x')
  assert.equal(b.returns?.[0].name, 'y')
})
