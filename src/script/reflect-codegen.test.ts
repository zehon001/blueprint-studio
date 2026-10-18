/**
 * v3 反射/文本节点 codegen（T12.7）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IRAsset } from '@/ir/types'
import { codegenTS } from './codegen-ts'

function asset(): IRAsset {
  return {
    version: 2,
    name: 'r',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          { id: 's', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
          {
            id: 't',
            type: 'ui.setText',
            params: {},
            pinDefaults: { name: 'title', value: 'hi' },
            position: { x: 0, y: 0 },
          },
          {
            id: 'p',
            type: 'ui.setProp',
            params: { nodeName: 'title', propId: 'visible' },
            pinDefaults: { value: true },
            position: { x: 0, y: 0 },
          },
          {
            id: 'g',
            type: 'ui.getProp',
            params: { nodeName: 'title', propId: 'text' },
            pinDefaults: {},
            position: { x: 0, y: 0 },
          },
          { id: 'pr', type: 'system.print', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', from: { node: 's', pin: 'exec' }, to: { node: 't', pin: 'exec' }, kind: 'exec' },
          { id: 'e2', from: { node: 't', pin: 'exec' }, to: { node: 'p', pin: 'exec' }, kind: 'exec' },
          { id: 'e3', from: { node: 'p', pin: 'exec' }, to: { node: 'g', pin: 'exec' }, kind: 'exec' },
          { id: 'e4', from: { node: 'g', pin: 'exec' }, to: { node: 'pr', pin: 'exec' }, kind: 'exec' },
          { id: 'd1', from: { node: 'g', pin: 'value' }, to: { node: 'pr', pin: 'value' }, kind: 'data' },
        ],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

test('ui.setText / ui.setProp / ui.getProp 生成 ui 写读调用', () => {
  const text = codegenTS(asset())
  assert.match(text, /ui\.title\.text = "hi";/)
  assert.match(text, /ui\.write\("title", "visible", true\);/)
  assert.match(text, /ui\.read\("title", "text"\)/)
})
