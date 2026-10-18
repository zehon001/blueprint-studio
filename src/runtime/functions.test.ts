/**
 * 三档函数解析单测（v3 T12.9）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IRAsset } from '@/ir/types'
import { callScope, callTarget, functionGraphOf, listExternalCalls, resolveExternalFunctions } from './functions'

function asset(): IRAsset {
  return {
    version: 2,
    name: 'main',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          { id: 'c', type: 'flow.call', params: { function: 'f', scope: 'project' }, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

const fnText = JSON.stringify({
  version: 3,
  kind: 'function',
  scope: 'project',
  name: 'f',
  params: [{ name: 'x', type: 'int' }],
  returns: [{ name: 'y', type: 'int' }],
  graph: { nodes: [{ id: 'e', type: 'func.entry', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } }], edges: [] },
})

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const body = routes[String(input)]
    return { ok: true, json: async () => body ?? { ok: false, message: '404' } } as unknown as Response
  }) as unknown as typeof fetch
}

test('callTarget / callScope：function 优先，非法 scope 回落 auto', () => {
  assert.equal(callTarget({ params: { function: 'f', graph: 'g' } }), 'f')
  assert.equal(callTarget({ params: { graph: 'g' } }), 'g')
  assert.equal(callScope({ params: { scope: 'global' } }), 'global')
  assert.equal(callScope({ params: { scope: 'weird' } }), 'auto')
})

test('functionGraphOf：params/returns 与 graph 合并；坏 JSON 中文错误', () => {
  const g = functionGraphOf(fnText, 'f')
  assert.equal(g.params?.[0].name, 'x')
  assert.equal(g.returns?.[0].name, 'y')
  assert.throws(() => functionGraphOf('{bad', 'f'), /不是合法 JSON/)
})

test('resolveExternalFunctions：项目函数注入并改写 call 目标；原资产不变', async () => {
  const ir = asset()
  const r = await resolveExternalFunctions(ir, {
    project: 'P',
    fetchImpl: mockFetch({
      '/api/file?path=P%2Flibrary%2Ffunctions%2Ff.fn.json': { ok: true, content: fnText },
    }),
  })
  assert.equal(r.errors.length, 0)
  assert.equal(r.loaded[0]?.scope, 'project')
  const node = r.asset.graphs.main.nodes[0]
  assert.equal(node.params.graph, '__fn_project_f')
  assert.ok(r.asset.graphs['__fn_project_f'])
  assert.equal(ir.graphs.main.nodes[0].params.graph, undefined, '入参资产不被修改')
})

test('auto：项目缺失 → 全局库；listExternalCalls 列出未解析', async () => {
  const ir = asset()
  const node = ir.graphs.main.nodes[0]
  node.params = { function: 'f', scope: 'auto' }
  const r = await resolveExternalFunctions(ir, {
    project: 'P',
    fetchImpl: mockFetch({
      '/api/library/read?kind=functions&name=f': { ok: true, content: fnText },
    }),
  })
  assert.equal(r.loaded[0]?.scope, 'global')
  assert.equal(r.asset.graphs.main.nodes[0].params.graph, '__fn_global_f')
  const calls = listExternalCalls(ir)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target, 'f')
})

test('显式 scope 缺失 → 记录中文错误且不改目标', async () => {
  const ir = asset()
  ir.graphs.main.nodes[0].params = { function: 'missing', scope: 'project' }
  const r = await resolveExternalFunctions(ir, { project: 'P', fetchImpl: mockFetch({}) })
  assert.match(r.errors[0] ?? '', /目标函数不存在/)
  assert.equal(r.asset.graphs.main.nodes[0].params.graph, undefined)
})
