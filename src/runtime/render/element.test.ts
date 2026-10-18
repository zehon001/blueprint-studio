/**
 * 元素实例渲染单测（v3 T11.2/T11.3）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { UIAsset } from '@/ir/types'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document

const { renderUI } = await import('./render')
const { loadElement, setElementLoaderContext, clearElementCache } = await import('../../ui-editor/element')

const elementJson = JSON.stringify({
  version: 3,
  kind: 'element',
  name: 'Card',
  props: [{ id: 'title', default: '默认标题' }],
  root: {
    id: 'el_root',
    name: 'root',
    type: 'vbox',
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    children: [
      {
        id: 'el_label',
        name: 'label',
        type: 'label',
        transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
        theme: {},
        props: { text: 'Card 内容' },
        children: [],
      },
    ],
  },
})

test('元素实例：预取后渲染元素子树，实例 props 覆盖自定义属性', async () => {
  clearElementCache()
  setElementLoaderContext({
    projectPath: 'P',
    fetchImpl: (async () =>
      ({ ok: true, json: async () => ({ ok: true, content: elementJson }) }) as unknown as Response) as unknown as typeof fetch,
  })
  const asset = await loadElement('ui/elements/card.elem.json')
  assert.ok(asset)
  const ui: UIAsset = {
    version: 3,
    name: 'main',
    root: {
      id: 'root',
      name: 'root',
      type: 'vbox',
      transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
      theme: {},
      props: {},
      children: [
        {
          id: 'card1',
          name: 'card1',
          type: '__element',
          element: 'ui/elements/card.elem.json',
          transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
          theme: {},
          props: { title: '实例标题' },
          children: [],
        },
      ],
    },
  }
  const h = renderUI(ui, { mode: 'runtime' })
  const card = h.el.querySelector<HTMLElement>('[data-uid="card1"]')
  assert.ok(card, '实例应渲染为元素根')
  assert.equal(card.dataset.nodeType, 'vbox')
  assert.equal(card.textContent, 'Card 内容')
  h.destroy()
})
