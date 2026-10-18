/**
 * 内嵌蓝图运行单测（v3 T10.3）
 *
 * BindingRunner 给出 embedded 时不再走 logicAsset / fetch，整棵树绑定到类级图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import type { IRAsset, UIAsset } from '@/ir/types'

const win = new Window()
;(globalThis as Record<string, unknown>).window = win
;(globalThis as Record<string, unknown>).document = win.document

const { renderUI } = await import('./render/render')
const { BindingRunner } = await import('./binding')

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
      children: [],
    },
  }
}

function embedded(): IRAsset {
  return {
    version: 2,
    name: 'main',
    entry: 'event',
    graphs: {
      event: {
        nodes: [
          { id: 's', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          { id: 'p', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 200, y: 0 } },
        ],
        edges: [{ id: 'e1', from: { node: 's', pin: 'exec' }, to: { node: 'p', pin: 'exec' }, kind: 'exec' }],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

test('embedded：不发起 fetch，event.start 执行内嵌图并输出 print', async () => {
  const asset = uiAsset()
  const handle = renderUI(asset, { mode: 'runtime' })
  const printed: string[] = []
  const debugPaths: string[] = []
  let fetched = 0
  const runner = new BindingRunner({
    project: 'P',
    asset,
    embedded: embedded(),
    debugAssetPath: 'ui/main.ui.json',
    debugProbe: { push: (path) => debugPaths.push(path) },
    renderHandle: handle,
    fetchImpl: (async () => {
      fetched++
      throw new Error('should not fetch')
    }) as unknown as typeof fetch,
    onPrint: (line) => printed.push(line),
  })
  await runner.loadAndStart()
  await new Promise((r) => setTimeout(r, 30))
  runner.stop()
  handle.destroy()
  assert.equal(fetched, 0)
  assert.ok(printed.some((l) => l.includes('内嵌蓝图')), '应打印内嵌蓝图加载日志')
  assert.ok(printed.some((l) => l.includes('[蓝图:main]')), '解释器 print 应走内嵌图通道')
  assert.ok(debugPaths.length > 0, '调试观察应有事件')
  assert.ok(debugPaths.every((p) => p === 'ui/main.ui.json'), '内嵌图调试通道应使用 UI 资产路径（编辑器叠加层匹配依据）')
})
