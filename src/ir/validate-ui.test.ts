/**
 * UIAsset 引用校验单测（v3 T13.1）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { UIAsset, UINode } from './types'
import { validateUIAssetRefs } from './validate-ui'

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

const asset: UIAsset = {
  version: 3,
  name: 'main',
  styles: ['@library/styles/base', 'ui/styles/app.uss.json'],
  root: node({
    id: 'root',
    classes: ['card'],
    children: [
      node({ id: 'a', classes: ['missing'] }),
      node({ id: 'b', type: '__element', element: '@library/elements/StatCard' }),
      node({ id: 'c', type: '__element', element: 'ui/elements/local.elem.json' }),
    ],
  }),
}

test('ref-style-missing：节点挂的类不在已应用样式表集合', () => {
  const issues = validateUIAssetRefs({ asset, styleClasses: new Set(['card']) })
  const missing = issues.filter((i) => i.code === 'ref-style-missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].nodeId, 'a')
  assert.match(missing[0].message, /missing/)
})

test('ref-library-missing：@library 元素/样式缺失；离线省略库清单则跳过', () => {
  const issues = validateUIAssetRefs({
    asset,
    styleClasses: new Set(['card', 'missing']),
    library: { elements: new Set(), styles: new Set() },
  })
  assert.ok(issues.some((i) => i.code === 'ref-library-missing' && /StatCard/.test(i.message)))
  assert.ok(issues.some((i) => i.code === 'ref-library-missing' && /base/.test(i.message)))
  const offline = validateUIAssetRefs({ asset, styleClasses: new Set(['card', 'missing']) })
  assert.equal(offline.some((i) => i.code === 'ref-library-missing'), false)
})

test('图内引用：var/flow.call/ui.get 缺失 → 对应 error 码', () => {
  const graphAsset: UIAsset = {
    ...asset,
    variables: [{ name: 'count', type: 'int' }],
    graphs: {
      event: {
        nodes: [
          { id: 'v', type: 'var.get', params: { varName: 'gone' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'f', type: 'flow.call', params: { function: 'nope', scope: 'project' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'u', type: 'ui.getProp', params: { nodeName: 'ghost', propId: 'text' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'ok', type: 'var.set', params: { varName: 'count' }, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
    },
  }
  const issues = validateUIAssetRefs({
    asset: graphAsset,
    styleClasses: new Set(['card', 'missing']),
    externalFunctions: new Set<string>(),
  })
  assert.ok(issues.some((i) => i.code === 'ref-variable-missing' && i.nodeId === 'v'))
  assert.ok(issues.some((i) => i.code === 'ref-function-missing' && i.nodeId === 'f'))
  assert.ok(issues.some((i) => i.code === 'ref-node-missing' && i.nodeId === 'u'))
  assert.equal(issues.some((i) => i.code === 'ref-variable-missing' && i.nodeId === 'ok'), false)
})

test('v3：auto 函数就近解析 / ui.get target / accessor name / 项目样式与预制体', () => {
  const a: UIAsset = {
    ...asset,
    styles: ['ui/styles/missing.uss.json'],
    root: node({
      id: 'root',
      children: [
        node({ id: 'a', name: 'target' }),
        node({ id: 'p', name: 'pf', prefab: 'ui/prefabs/missing.ui.json' }),
      ],
    }),
    graphs: {
      event: {
        nodes: [
          { id: 'auto-miss', type: 'flow.call', params: { function: 'nope' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'auto-hit', type: 'flow.call', params: { function: 'okFn' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'bp-hit', type: 'flow.call', params: { function: 'localFn' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'get-target', type: 'ui.get', params: { target: 'ghost' }, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'set-name', type: 'ui.setText', params: {}, pinDefaults: { name: 'ghost2' }, position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      localFn: { kind: 'function', nodes: [], edges: [] },
    },
  }
  const issues = validateUIAssetRefs({
    asset: a,
    styleClasses: new Set(),
    projectStyles: new Set<string>(),
    projectPrefabs: new Set<string>(),
    externalFunctions: new Set(['okFn']),
  })
  assert.ok(issues.some((i) => i.code === 'ref-function-missing' && i.nodeId === 'auto-miss'))
  assert.equal(issues.some((i) => i.code === 'ref-function-missing' && i.nodeId === 'auto-hit'), false)
  assert.equal(issues.some((i) => i.code === 'ref-function-missing' && i.nodeId === 'bp-hit'), false)
  assert.ok(issues.some((i) => i.code === 'ref-node-missing' && i.nodeId === 'get-target'))
  assert.ok(issues.some((i) => i.code === 'ref-node-missing' && i.nodeId === 'set-name'))
  assert.ok(issues.some((i) => i.code === 'ref-style-missing' && /missing\.uss/.test(i.message)))
  assert.ok(issues.some((i) => i.code === 'ref-element-boundary' && i.nodeId === 'p'))
})

test('内置库资产引用项目资源 → ref-element-boundary', () => {
  const libAsset: UIAsset = {
    ...asset,
    styles: ['ui/styles/app.uss.json'],
    root: node({
      id: 'root',
      children: [node({ id: 'e', element: 'ui/elements/local.elem.json' })],
    }),
  }
  const issues = validateUIAssetRefs({
    asset: libAsset,
    styleClasses: new Set(),
    scope: 'library',
  })
  assert.ok(issues.some((i) => i.code === 'ref-element-boundary' && /内置元素/.test(i.message)))
  assert.ok(issues.some((i) => i.code === 'ref-element-boundary' && /内置资产不得引用项目样式表/.test(i.message)))
})

test('ref-element-boundary：项目元素路径不在项目元素清单', () => {
  const issues = validateUIAssetRefs({
    asset,
    styleClasses: new Set(['card', 'missing']),
    projectElements: new Set<string>(),
  })
  const bad = issues.filter((i) => i.code === 'ref-element-boundary')
  assert.equal(bad.length, 1)
  assert.equal(bad[0].nodeId, 'c')
})
