/**
 * 函数资产视图转换单测（v3 T12.2）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { functionIR, functionTextOf } from './functionAsset'

test('functionIR：.fn.json → IRAsset 单图（params/returns 提取）', () => {
  const ir = functionIR(
    {
      version: 3,
      kind: 'function',
      scope: 'project',
      name: 'fmt',
      params: [{ name: 'ms', type: 'int' }],
      returns: [{ name: 'text', type: 'string' }],
      graph: { nodes: [], edges: [] },
    },
    'fallback',
  )
  assert.equal(ir.name, 'fmt')
  assert.equal(ir.entry, 'main')
  assert.equal(ir.graphs.main.params?.[0].name, 'ms')
  assert.equal(ir.graphs.main.returns?.[0].name, 'text')
})

test('functionTextOf：IRAsset → .fn.json（version 3/kind/scope/签名）', () => {
  const ir = functionIR({ version: 3, name: 'fmt', params: [{ name: 'x', type: 'int' }], returns: [], graph: { nodes: [], edges: [] } }, 'fmt')
  const text = functionTextOf(ir, 'library/functions/fmt.fn.json', 'project')
  const raw = JSON.parse(text) as Record<string, unknown>
  assert.equal(raw.version, 3)
  assert.equal(raw.kind, 'function')
  assert.equal(raw.scope, 'project')
  assert.equal(raw.name, 'fmt')
  assert.deepEqual(raw.params, [{ name: 'x', type: 'int' }])
})
