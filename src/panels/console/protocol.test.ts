/**
 * 编辑器控制台跨窗口协议单测
 *
 * 覆盖：镜像懒建频道 / 消息形状 / 卸载关闭 / 频道不可用时静默降级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONSOLE_CHANNEL, createConsoleMirror, type ConsoleChannel } from './protocol'

class FakeChannel implements ConsoleChannel {
  readonly sent: unknown[] = []
  closed = false

  constructor(readonly name: string) {}

  postMessage(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
  }
}

test('createConsoleMirror：懒建频道、广播消息并复用频道', () => {
  const channels: FakeChannel[] = []
  const mirror = createConsoleMirror({
    project: 'Demo',
    mode: 'current',
    now: () => 1234,
    channelFactory: (name) => {
      const ch = new FakeChannel(name)
      channels.push(ch)
      return ch
    },
  })

  mirror.post('hello')
  mirror.post('world')

  assert.equal(channels.length, 1, '两条输出复用同一频道')
  assert.equal(channels[0]!.name, CONSOLE_CHANNEL)
  assert.deepEqual(channels[0]!.sent[0], {
    type: 'console.line',
    line: 'hello',
    project: 'Demo',
    mode: 'current',
    ts: 1234,
  })
  assert.equal((channels[0]!.sent[1] as { line: string }).line, 'world')
})

test('createConsoleMirror：close 后断开且不再广播（幂等）', () => {
  const ch = new FakeChannel(CONSOLE_CHANNEL)
  const mirror = createConsoleMirror({
    project: 'P',
    channelFactory: () => ch,
  })

  mirror.post('before')
  mirror.close()
  mirror.close()
  mirror.post('after')

  assert.equal(ch.closed, true)
  assert.equal(ch.sent.length, 1, 'close 后 post 静默丢弃')
})

test('createConsoleMirror：频道不可用时静默降级（不影响运行）', () => {
  const mirror = createConsoleMirror({
    project: 'P',
    channelFactory: () => {
      throw new Error('BroadcastChannel unavailable')
    },
  })

  assert.doesNotThrow(() => mirror.post('line'))
  assert.doesNotThrow(() => mirror.close())
})
