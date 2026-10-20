/**
 * UI 内嵌蓝图适配单测（v3 T10.1）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIAsset, UINode } from '@/ir/types'
import {
  applyEmbeddedBlueprint,
  embeddedBlueprintOf,
  emptyEmbeddedBlueprint,
  hasEmbeddedBlueprint,
  runtimeEmbeddedBlueprint,
} from './embedded'

function node(id: string, type = 'vbox'): UINode {
  return {
    id,
    name: id,
    type,
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [],
  }
}

test('无 graphs：embeddedBlueprintOf 生成空事件图；runtimeEmbedded null', () => {
  const asset: UIAsset = { version: 2, name: 'main', root: node('r') }
  assert.equal(hasEmbeddedBlueprint(asset), false)
  assert.equal(runtimeEmbeddedBlueprint(asset), null)
  const bp = embeddedBlueprintOf(asset)
  assert.equal(bp.entry, 'event')
  assert.ok(bp.graphs.event.nodes.some((n) => n.type === 'event.start'))
})

test('已有空事件图：视图自动补 event.start，不修改原资产', () => {
  const asset: UIAsset = {
    version: 3,
    name: 'empty',
    graphs: { event: { kind: 'event', nodes: [], edges: [], comments: [] } },
    root: node('r'),
  }
  const bp = embeddedBlueprintOf(asset)
  assert.equal(bp.graphs.event.nodes[0]?.type, 'event.start')
  assert.equal(asset.graphs!.event.nodes.length, 0, '视图补节点不写回资产')
})

test('applyEmbeddedBlueprint：事件图/函数图/变量/事件写回，版本升 3', () => {
  const asset: UIAsset = { version: 2, name: 'main', root: node('r') }
  const bp = emptyEmbeddedBlueprint('main')
  bp.graphs['format'] = {
    nodes: [],
    edges: [],
    params: [{ name: 'ms', type: 'int' }],
    returns: [{ name: 'text', type: 'string' }],
  }
  bp.variables = [{ name: 'count', type: 'int', default: 0, exposed: true }]
  bp.events = [{ name: 'done', params: [] }]
  applyEmbeddedBlueprint(asset, bp)
  assert.equal(asset.version, 3)
  assert.equal(asset.graphs?.event.kind, 'event')
  assert.equal(asset.graphs?.format.kind, 'function')
  assert.deepEqual(asset.graphs?.format.params, [{ name: 'ms', type: 'int' }])
  assert.equal(asset.variables?.[0].name, 'count')
  assert.equal(asset.events?.[0].name, 'done')
  assert.equal(hasEmbeddedBlueprint(asset), true)
  const view = embeddedBlueprintOf(asset)
  assert.equal(view.entry, 'event')
  assert.equal(view.graphs.format.returns?.[0].name, 'text')
})
