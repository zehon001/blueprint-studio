/**
 * 编辑器控制台纯逻辑单测（T1.6 兑现 · BroadcastChannel 镜像协议）
 *
 * 覆盖：reduceConsoleMessage 追加 / FIFO 上限 / parseConsoleEvent 合法与非法负载。
 * 组件的订阅与渲染不在此测（BroadcastChannel 由实机验收覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONSOLE_MAX_LINES,
  reduceConsoleMessage,
  parseConsoleEvent,
  type ConsoleRow,
} from './ConsolePanel'

function msg(line: string, ts = 1000): Parameters<typeof reduceConsoleMessage>[1] {
  return { type: 'console.line', line, project: 'demo', mode: 'main', ts }
}

test('reduceConsoleMessage：追加行并带时间戳视图', () => {
  const rows: ConsoleRow[] = []
  const r1 = reduceConsoleMessage(rows, msg('[蓝图:log] hi', 1700000000000))
  assert.equal(r1.length, 1)
  assert.equal(r1[0]!.line, '[蓝图:log] hi')
  assert.ok(r1[0]!.time.length > 0)
  assert.notEqual(r1[0]!.key, '')
})

test('reduceConsoleMessage：FIFO 上限（不超过 CONSOLE_MAX_LINES）', () => {
  let rows: ConsoleRow[] = []
  for (let i = 0; i < CONSOLE_MAX_LINES + 50; i++) {
    rows = reduceConsoleMessage(rows, msg(`line-${i}`, 1000 + i))
  }
  assert.equal(rows.length, CONSOLE_MAX_LINES)
  assert.equal(rows[0]!.line, 'line-50', '最早的 50 行被挤出')
  assert.equal(rows[rows.length - 1]!.line, `line-${CONSOLE_MAX_LINES + 49}`)
})

test('parseConsoleEvent：合法消息还原 / 非法负载拒绝', () => {
  const ok = parseConsoleEvent({ type: 'console.line', line: 'x', project: 'p', mode: 'current', ts: 5 })
  assert.ok(ok)
  assert.equal(ok!.mode, 'current')

  assert.equal(parseConsoleEvent(null), null)
  assert.equal(parseConsoleEvent('text'), null)
  assert.equal(parseConsoleEvent({ type: 'other', line: 'x', ts: 1 }), null)
  assert.equal(parseConsoleEvent({ type: 'console.line', line: 42, ts: 1 }), null)
  assert.equal(parseConsoleEvent({ type: 'console.line', line: 'x' }), null, '缺 ts 拒绝')

  // mode 非法值宽松归一为 main；project 缺省为 ''
  const loose = parseConsoleEvent({ type: 'console.line', line: 'x', ts: 1 })
  assert.ok(loose)
  assert.equal(loose!.mode, 'main')
  assert.equal(loose!.project, '')
})
