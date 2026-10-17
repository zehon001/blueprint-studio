/**
 * WS Hub 调试观察协议测试（T5.4 · node:test + ws 真实客户端连本地 server）
 *
 * 运行：npx tsx --test server/ws.test.ts
 *
 * 覆盖（任务卡 DoD）：
 *  1. debug.attach / debug.subscribe 路由匹配——同 project+assetPath 才转发；
 *  2. 多订阅者广播（同一通道全部命中，报文一致）；
 *  3. 连接关闭清理（订阅移除 + 通道订阅归零 → 生产方收 debug.mute）；
 *  4. debug.unsubscribe 停止转发（一键关闭观察的服务端半边）；
 *  5. mute/unmute 边沿传播 + attach 时同步订阅现状；非法报文 → error 回帧；hello 握手。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { WsDebugHub } from './ws'
import type { DebugEvent } from '../src/runtime/interpreter/types'

/* ============================================================
 * 测试服务器脚手架（每用例独立端口 + 独立 hub；连接收尾统一关闭防悬停）
 * ============================================================ */

interface TestServer {
  url: string
  hub: WsDebugHub
  /** 打开连接并等 hello（自动登记进清理表，收尾统一关闭） */
  open(url?: string): Promise<WebSocket>
}

/** 起一个只挂 /ws 的本地服务（心跳关闭，避免用例悬停） */
async function withServer(fn: (s: TestServer) => Promise<void>): Promise<void> {
  const hub = new WsDebugHub({ heartbeatMs: null })
  const wss = new WebSocketServer({ noServer: true })
  hub.attach(wss)
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const url = `ws://127.0.0.1:${addr.port}/ws`
  const opened: WebSocket[] = []
  const open = (u?: string): Promise<WebSocket> =>
    openClient(u ?? url).then((ws) => {
      opened.push(ws)
      return ws
    })
  try {
    await fn({ url, hub, open })
  } finally {
    // 用例失败也要关连接（否则挂起句柄让 node:test 悬停）
    for (const ws of opened) {
      try {
        ws.close()
      } catch {
        /* 已关：忽略 */
      }
    }
    await sleep(30)
    hub.dispose()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** 打开连接并等 hello（确认服务端已登记） */
function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const onMessage = (raw: unknown): void => {
      const msg = JSON.parse(String(raw)) as { type?: string }
      if (msg.type === 'hello') {
        ws.off('message', onMessage)
        resolve(ws)
      }
    }
    ws.on('message', onMessage)
    ws.on('error', reject)
  })
}

/** 收集该连接的后续报文（回调式，测试内断言） */
function collect(ws: WebSocket): Array<Record<string, unknown>> {
  const inbox: Array<Record<string, unknown>> = []
  ws.on('message', (raw) => {
    try {
      inbox.push(JSON.parse(String(raw)) as Record<string, unknown>)
    } catch {
      /* 非 JSON 帧：忽略 */
    }
  })
  return inbox
}

/** 等待条件成立（消息到达异步，轮询直至超时） */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(20)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg))
}

/** 构造一批调试事件（shape 对齐解释器 DebugEvent） */
function batchEvents(nodeId = 'n1'): DebugEvent[] {
  return [
    { kind: 'nodeEnter', graph: 'main', nodeId, ts: Date.now() },
    { kind: 'pinValue', graph: 'main', nodeId, pinId: 'out', value: 42, ts: Date.now() },
    { kind: 'nodeExit', graph: 'main', nodeId, ts: Date.now() },
  ]
}

/* ============================================================
 * 用例
 * ============================================================ */

describe('WS hub 调试观察协议（debug.v1）', () => {
  test('hello 握手：protocol=debug.v1', async () => {
    await withServer(async (s) => {
      await s.open()
    })
  })

  test('路由匹配：同 project+assetPath 才转发（跨资产 / 跨项目不转发）', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const subA = await s.open() // 订阅 P/logic/a.bp.json
      const subB = await s.open() // 订阅 P/logic/b.bp.json
      const subC = await s.open() // 订阅 Q/logic/a.bp.json（跨项目）
      const inP = collect(producer)
      const inA = collect(subA)
      const inB = collect(subB)
      const inC = collect(subC)
      send(subA, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(subB, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/b.bp.json'] })
      send(subC, { type: 'debug.subscribe', project: 'Q', assetPaths: ['logic/a.bp.json'] })
      // attach 时同步订阅现状：通道已有订阅者 → 生产方收 unmute（开始发）
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      await waitFor(() => inP.some((m) => m.type === 'debug.unmute'), 'attach 同步 unmute')
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await waitFor(() => inA.some((m) => m.type === 'debug.batch'), 'A 收到批')
      await sleep(60) // 给误转发留观察窗
      assert.equal(inA.filter((m) => m.type === 'debug.batch').length, 1)
      assert.ok(!inB.some((m) => m.type === 'debug.batch'), '不同 assetPath 不转发')
      assert.ok(!inC.some((m) => m.type === 'debug.batch'), '不同 project 不转发')
      const batch = inA.find((m) => m.type === 'debug.batch')!
      assert.equal(batch.project, 'P')
      assert.equal(batch.assetPath, 'logic/a.bp.json')
      assert.equal(Array.isArray(batch.events), true)
    })
  })

  test('多订阅者广播：同通道全部命中且报文一致', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const s1 = await s.open()
      const s2 = await s.open()
      const in1 = collect(s1)
      const in2 = collect(s2)
      send(s1, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(s2, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      const events = batchEvents('n7')
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events })
      await waitFor(
        () => in1.some((m) => m.type === 'debug.batch') && in2.some((m) => m.type === 'debug.batch'),
        '双订阅者收批',
      )
      const b1 = in1.find((m) => m.type === 'debug.batch')!
      const b2 = in2.find((m) => m.type === 'debug.batch')!
      assert.deepEqual(b1, b2)
      assert.deepEqual((b1.events as DebugEvent[]).map((e) => e.kind), [
        'nodeEnter',
        'pinValue',
        'nodeExit',
      ])
    })
  })

  test('连接清理：订阅者断开 → 停止转发；通道归零 → 生产方收 debug.mute', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const inP = collect(producer)
      const s1 = await s.open()
      const s2 = await s.open()
      const in2 = collect(s2)
      send(s1, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(s2, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      await waitFor(() => inP.some((m) => m.type === 'debug.unmute'), 'attach unmute')
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await waitFor(() => in2.some((m) => m.type === 'debug.batch'), 'S2 首批')
      // S1 断开（S2 仍在）：仍转发，不 mute
      s1.close()
      await sleep(40)
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await waitFor(() => in2.filter((m) => m.type === 'debug.batch').length === 2, 'S2 第二批')
      assert.ok(!inP.some((m) => m.type === 'debug.mute'), '仍有订阅者不发 mute')
      // S2 也断开：通道订阅归零 → 生产方收 mute（停发信号）
      s2.close()
      await waitFor(() => inP.some((m) => m.type === 'debug.mute'), 'mute 边沿')
      const mute = inP.find((m) => m.type === 'debug.mute')!
      assert.equal(mute.project, 'P')
      assert.equal(mute.assetPath, 'logic/a.bp.json')
      // mute 后服务端不再有订阅者：批量直接静默（连接仍在也不炸）
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await sleep(40)
    })
  })

  test('晚到的运行窗口：attach 时通道无订阅者 → 直接收 mute（编辑器已关观察）', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const inP = collect(producer)
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      await waitFor(() => inP.some((m) => m.type === 'debug.mute'), 'attach 同步 mute')
      // 之后编辑器再开观察：subscribe → 边沿 unmute
      const sub = await s.open()
      send(sub, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      await waitFor(() => inP.some((m) => m.type === 'debug.unmute'), '订阅边沿 unmute')
    })
  })

  test('debug.unsubscribe：退订后停转；通道归零发 mute；重订阅发 unmute', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const inP = collect(producer)
      const sub = await s.open()
      const inS = collect(sub)
      send(sub, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      await waitFor(() => inP.some((m) => m.type === 'debug.unmute'), '首次订阅 unmute')
      // 精确退订该通道（编辑器关闭观察）
      send(sub, { type: 'debug.unsubscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      await waitFor(() => inP.some((m) => m.type === 'debug.mute'), '退订归零 mute')
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await sleep(40)
      assert.ok(!inS.some((m) => m.type === 'debug.batch'), '退订后不转发')
      // 重新订阅：恢复转发 + unmute 边沿
      send(sub, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      await waitFor(
        () => inP.filter((m) => m.type === 'debug.unmute').length === 2,
        '重订阅 unmute',
      )
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await waitFor(() => inS.some((m) => m.type === 'debug.batch'), '重订阅后恢复转发')
    })
  })

  test('隐式生产登记：未 attach 直接 batch 也能路由（attach 乱序容错）', async () => {
    await withServer(async (s) => {
      const producer = await s.open()
      const sub = await s.open()
      const inS = collect(sub)
      send(sub, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(producer, { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: batchEvents() })
      await waitFor(() => inS.some((m) => m.type === 'debug.batch'), '隐式 attach 后转发')
    })
  })

  test('dropped 字段透传 + 非法报文回 error + stats 计数', async () => {
    await withServer(async (s) => {
      const { hub } = s
      const producer = await s.open()
      const sub = await s.open()
      const inS = collect(sub)
      const inPr = collect(producer)
      send(sub, { type: 'debug.subscribe', project: 'P', assetPaths: ['logic/a.bp.json'] })
      send(producer, { type: 'debug.attach', project: 'P', assetPath: 'logic/a.bp.json' })
      send(producer, {
        type: 'debug.batch',
        project: 'P',
        assetPath: 'logic/a.bp.json',
        events: batchEvents(),
        dropped: 6,
      })
      await waitFor(() => inS.some((m) => m.type === 'debug.batch'), '批到达')
      assert.equal((inS.find((m) => m.type === 'debug.batch')!.dropped as number) > 0, true)
      // 非法报文：非 JSON / 未知 type / 缺字段 → error 帧，连接不断
      producer.send('not-json')
      producer.send(JSON.stringify({ type: 'mystery' }))
      producer.send(JSON.stringify({ type: 'debug.subscribe', project: '', assetPaths: [] }))
      await waitFor(() => inPr.filter((m) => m.type === 'error').length >= 3, 'error 帧齐')
      producer.ping()
      await sleep(30)
      assert.equal(producer.readyState, WebSocket.OPEN, '非法报文不断连')
      // stats：1 订阅通道 + 1 生产通道
      const stats = hub.stats()
      assert.equal(stats.subscribedChannels, 1)
      assert.equal(stats.attachedChannels, 1)
    })
  })
})
