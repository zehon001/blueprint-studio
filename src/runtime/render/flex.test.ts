/**
 * v3 flex 渲染单测（T9.1/T9.2）
 *
 * 覆盖：layout 覆盖 v2 transform（relative/absolute、grow/shrink/basis、size、margin）、
 * container 映射（direction/wrap/justify/align/gap/padding/overflow）、编辑/运行同构、
 * v3 资产 version=3 解析。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { UIAsset, UINode } from '../../ir/types'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document

const { renderUI } = await import('./render')
const { parseUIAsset } = await import('../../ui-editor/store')

function node(partial: Partial<UINode> & { id: string; type: string }): UINode {
  return {
    name: partial.id,
    transform: { position: { x: 0, y: 0 }, size: { w: 0, h: 0 }, rotation: 0 },
    theme: {},
    props: {},
    events: [],
    children: [],
    ...partial,
  } as UINode
}

function asset(root: UINode): UIAsset {
  return { version: 3, name: 'flex', root }
}

function byUid(root: HTMLElement, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-uid="${id}"]`)
  assert.ok(el, `missing ${id}`)
  return el
}

test('v3 container: direction/wrap/justify/align/gap/padding/overflow', () => {
  const root = node({
    id: 'root',
    type: 'vbox',
    container: {
      direction: 'row',
      wrap: 'wrap',
      justify: 'space-between',
      align: 'center',
      gap: 6,
      padding: { t: 4, r: 5, b: 6, l: 7 },
      overflow: 'scroll',
    },
    layout: { size: { w: '100%', h: '100%' } },
    children: [],
  })
  const h = renderUI(asset(root), { mode: 'runtime' })
  const el = byUid(h.el, 'root')
  assert.equal(el.style.display, 'flex')
  assert.equal(el.style.flexDirection, 'row')
  assert.equal(el.style.flexWrap, 'wrap')
  assert.equal(el.style.justifyContent, 'space-between')
  assert.equal(el.style.alignItems, 'center')
  assert.equal(el.style.gap, '6px')
  assert.equal(el.style.paddingTop, '4px')
  assert.equal(el.style.paddingRight, '5px')
  assert.equal(el.style.paddingBottom, '6px')
  assert.equal(el.style.paddingLeft, '7px')
  assert.equal(el.style.overflow, 'auto')
  assert.equal(el.style.width, '100%')
  h.destroy()
})

test('v3 layout: relative child grow/shrink/basis/size/margin/order/alignSelf', () => {
  const root = node({
    id: 'root',
    type: 'vbox',
    container: { direction: 'row' },
    children: [
      node({
        id: 'a',
        type: 'label',
        layout: {
          grow: 2,
          shrink: 0,
          basis: 0,
          size: { w: 'auto', h: 32 },
          margin: { t: 1, r: 2, b: 3, l: 4 },
          order: 2,
          alignSelf: 'center',
        },
      }),
    ],
  })
  const h = renderUI(asset(root), { mode: 'edit' })
  const a = byUid(h.el, 'a')
  assert.equal(a.style.position, 'relative')
  assert.equal(a.style.flexGrow, '2')
  assert.equal(a.style.flexShrink, '0')
  assert.equal(a.style.flexBasis, '0px')
  assert.equal(a.style.width, '')
  assert.equal(a.style.height, '32px')
  assert.equal(a.style.marginTop, '1px')
  assert.equal(a.style.marginLeft, '4px')
  assert.equal(a.style.order, '2')
  assert.equal(a.style.alignSelf, 'center')
  h.destroy()
})

test('v3 layout: absolute child left/top/right/bottom/size', () => {
  const root = node({
    id: 'root',
    type: 'panel',
    container: { direction: 'column' },
    children: [
      node({
        id: 'abs',
        type: 'button',
        layout: { position: 'absolute', left: 10, top: '20%', size: { w: 120, h: 40 } },
      }),
    ],
  })
  const h = renderUI(asset(root), { mode: 'runtime' })
  const el = byUid(h.el, 'abs')
  assert.equal(el.style.position, 'absolute')
  assert.equal(el.style.left, '10px')
  assert.equal(el.style.top, '20%')
  assert.equal(el.style.width, '120px')
  assert.equal(el.style.height, '40px')
  assert.equal(el.style.flexGrow, '')
  h.destroy()
})

test('v3 asset parse: version=3 accepted; unknown version rejected', () => {
  const text = JSON.stringify(asset(node({ id: 'r', type: 'vbox' })))
  const parsed = parseUIAsset(text)
  assert.equal(parsed.version, 3)
  assert.equal(parsed.root.id, 'r')
  assert.throws(() => parseUIAsset('{"version":9,"root":{}}'), /版本不识别/)
})
