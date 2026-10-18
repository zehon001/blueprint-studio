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
