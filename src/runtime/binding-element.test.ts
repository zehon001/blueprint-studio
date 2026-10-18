/**
 * 元素实例类图运行时（v3 PLAN §8.2）
 *
 * 覆盖：
 *  - 每个元素实例一个解释器（event.start 每实例触发）；
 *  - 内部控件事件按有效节点 id 路由到最近图属主；
 *  - 实例自定义事件上抛为 `<实例路径>.<事件名>`，宿主 event.custom 可接收。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { ElementAsset, IRAsset, UIAsset } from '@/ir/types'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document

const { renderUI } = await import('./render/render')
const { BindingRunner } = await import('./binding')
const { primeElementCache, clearElementCache } = await import('@/ui-editor/element')

const ELEMENT_PATH = 'ui/elements/card.elem.json'

function elementAsset(): ElementAsset {
  return {
    version: 3,
    kind: 'element',
    name: 'Card',
    props: [],
    traits: ['text'],
    root: {
      id: 'e_root',
      name: 'root',
      type: 'vbox',
      transform: { position: { x: 0, y: 0 }, size: { w: 200, h: 100 }, rotation: 0 },
      layout: { size: { w: 200, h: 100 } },
      container: { direction: 'column', gap: 4 },
      theme: {},
      props: {},
      children: [
        {
          id: 'e_btn',
          name: 'btn',
          type: 'button',
          transform: { position: { x: 0, y: 0 }, size: { w: 100, h: 30 }, rotation: 0 },
          theme: {},
          props: {},
          children: [],
        },
      ],
    },
    graphs: {
      event: {
        kind: 'event',
        nodes: [
          { id: 's', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'send', type: 'event.send', params: {}, pinDefaults: { eventName: 'ready' }, position: { x: 160, y: 0 } },
          { id: 'pressed', type: 'event.custom', params: { eventName: 'pressed' }, pinDefaults: {}, position: { x: 0, y: 120 } },
          { id: 'p1', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 160, y: 120 } },
        ],
        edges: [
          { id: 'e1', from: { node: 's', pin: 'exec' }, to: { node: 'send', pin: 'exec' }, kind: 'exec' },
          { id: 'e2', from: { node: 'pressed', pin: 'exec' }, to: { node: 'p1', pin: 'exec' }, kind: 'exec' },
        ],
      },
    },
    variables: [],
    events: [{ name: 'ready', params: [] }],
    layout: {},
  }
}

function uiAsset(): UIAsset {
  return {
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
          id: 'inst',
          name: 'card1',
          type: '__element',
          element: ELEMENT_PATH,
          transform: { position: { x: 0, y: 0 }, size: { w: 200, h: 100 }, rotation: 0 },
          layout: { size: { w: 200, h: 100 } },
          theme: {},
          props: {},
          children: [],
        },
      ],
    },
    graphs: { event: { kind: 'event', nodes: [], edges: [] } },
  }
}

function hostBlueprint(): IRAsset {
  return {
    version: 3,
    name: 'main',
    entry: 'event',
    graphs: {
      event: {
        kind: 'event',
        nodes: [
          {
            id: 'host_ready',
            type: 'event.custom',
            params: { eventName: 'card1.ready' },
            pinDefaults: {},
            position: { x: 0, y: 0 },
          },
          { id: 'host_print', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 180, y: 0 } },
        ],
        edges: [
          {
            id: 'he1',
            from: { node: 'host_ready', pin: 'exec' },
            to: { node: 'host_print', pin: 'exec' },
            kind: 'exec',
          },
        ],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

beforeEach(() => {
  clearElementCache()
  primeElementCache(ELEMENT_PATH, elementAsset())
})

test('元素实例：start 每实例触发、内部控件事件路由、自定义事件路径上抛', async () => {
  const asset = uiAsset()
  let runner!: InstanceType<typeof BindingRunner>
  const handle = renderUI(asset, {
    mode: 'runtime',
    onEvent: (evt) => runner.routeEvent(evt),
  })
  const printed: string[] = []
  runner = new BindingRunner({
    project: 'P',
    asset,
    embedded: hostBlueprint(),
    renderHandle: handle,
    fetchImpl: (async () => {
      throw new Error('元素/内嵌图不应 fetch')
    }) as unknown as typeof fetch,
    onPrint: (line) => printed.push(line),
  })
  await runner.loadAndStart()
  await new Promise((r) => setTimeout(r, 30))

  // 实例解释器已创建 + start 上抛的 ready 事件被宿主接收
  assert.ok(
    printed.some((l) => l.includes('[绑定] 已加载元素实例「card1」')),
    '元素实例解释器应创建',
  )
  assert.ok(printed.some((l) => l.includes('[蓝图:main]')), '宿主应收到 card1.ready 并执行 event.custom')

  // 内部按钮事件 → 最近图属主（元素实例）
  const btn = handle.el.querySelector<HTMLElement>('[data-uid="inst::e_btn"]')
  assert.ok(btn, '元素内部节点 id 已作用域化')
  btn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event)
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(
    printed.some((l) => l.includes('[元素:card1]')),
    '按钮 pressed 应路由到元素实例解释器（而非被静默丢弃）',
  )

  runner.stop()
  handle.destroy()
})
