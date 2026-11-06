/**
 * 改名级联单测（v3 T13.1）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IRAsset } from './types'
import { renameFunction, renameVariable } from './refactor'

function ir(): IRAsset {
  return {
    version: 2,
    name: 'x',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          { id: 'v', type: 'var.get', params: { varName: 'old' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'c', type: 'flow.call', params: { graph: 'fn' }, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      fn: { nodes: [], edges: [] },
    },
    variables: [{ name: 'old', type: 'int' }],
    events: [{ name: 'loaded', params: [{ name: 'old', type: 'int' }] }],
    snippets: [],
    layout: { fn: { zoom: 1, pan: [0, 0] } },
  }
}

test('renameVariable：变量/图节点/事件参数级联，入参不变', () => {
  const a = ir()
  const b = renameVariable(a, 'old', 'next')
  assert.equal(b.variables?.[0].name, 'next')
  assert.equal(b.graphs.main.nodes[0].params.varName, 'next')
  assert.equal(b.events?.[0].params?.[0].name, 'next')
  assert.equal(a.variables?.[0].name, 'old')
})

test('renameFunction：graph 键/entry/layout/调用参数级联', () => {
  const b = renameFunction(ir(), 'fn', 'renamed')
  assert.ok(b.graphs.renamed)
  assert.equal(b.graphs.fn, undefined)
  assert.equal(b.entry, 'main')
  assert.equal(b.graphs.main.nodes[1].params.graph, 'renamed')
  assert.ok(b.layout?.renamed)
})

