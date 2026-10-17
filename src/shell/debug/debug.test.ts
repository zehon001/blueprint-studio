/**
 * 运行时蓝图观察单测（T5.4 · node:test，纯函数）
 *
 * 运行：npx tsx --test src/shell/debug/debug.test.ts
 *
 * 覆盖（任务卡 DoD）：
 *  1. 探针批量（运行窗口侧）：150ms 窗口合并（计时器一次性冲刷）、
 *     500 条上限合并策略（同主体保最新 + 保留最新段 + dropped 计数）、
 *     mute 停发 / unmute 恢复、stop 一键关闭；
 *  2. 叠加层纯函数（编辑器侧）：事件批 → highlight/pinValues/flowing 状态增量 +
 *     惰性衰减（2s 高亮 / 0.8s 流动 / 5s 端口值）、受控视图映射（引用稳定性）；
 *  3. 观察开关持久化（localStorage 替身 + 缺省开 + 异常降级）；
 *  4. 端口值格式化 / 徽标层数据规则 / 编辑器批处理通道过滤。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { DebugEvent } from '../../runtime/interpreter/types'
import type { DebugOverlayState } from './overlay-state'

/* ── 被测模块（纯函数 / 注入 transport，无 DOM 依赖）────────────── */
const { coalesceBatch, DebugProbe, PROBE_BATCH_MS, PROBE_MAX_BATCH } = await import(
  '../../runtime/debug-probe'
)
const {
  applyDebugEvents,
  decayOverlay,
  applyNodeOverlay,
  applyEdgeOverlay,
  buildInExecEdges,
  emptyOverlayState,
  isOverlayEmpty,
  HIGHLIGHT_TTL_MS,
  FLOW_TTL_MS,
  PIN_TTL_MS,
} = await import('./overlay-state')
const { loadObserveEnabled, saveObserveEnabled, OBSERVE_STORAGE_KEY } = await import(
  './observe-toggle'
)
const { formatPinValue, debugOverlayHandleMessage } = await import('./index')

/* ── 工具 ─────────────────────────────────────────── */

function ev(kind: DebugEvent['kind'], nodeId?: string, extra?: Partial<DebugEvent>): DebugEvent {
  return { kind, graph: 'main', nodeId, ts: 1000, ...extra }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 记录型 transport（收集发送的报文；send 返回值可配置为「未连接」） */
function makeTransport(connected = true) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    send(msg: Record<string, unknown>): boolean {
      sent.push(msg)
      return connected
    },
  }
}

/** 内存 localStorage 替身 */
function makeStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial ?? {}))
  let broken = false
  return {
    getItem: (k: string) => (broken ? (() => { throw new Error('boom') })() : map.get(k) ?? null),
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('boom')
      map.set(k, v)
    },
    break: () => {
      broken = true
    },
    map,
  }
}

/* ============================================================
 * 1. 探针批量（coalesceBatch 纯函数 + DebugProbe 计时器行为）
 * ============================================================ */

describe('T5.4 探针批量（150ms 窗口 / 500 条上限）', () => {
  test('coalesceBatch：未超上限原样透传（保序）', () => {
    const events = [ev('nodeEnter', 'a'), ev('pinValue', 'a', { pinId: 'out', value: 1 }), ev('nodeExit', 'a')]
    const { events: out, dropped } = coalesceBatch(events, PROBE_MAX_BATCH)
    assert.equal(dropped, 0)
    assert.deepEqual(out.map((e: DebugEvent) => e.kind), ['nodeEnter', 'pinValue', 'nodeExit'])
  })

  test('coalesceBatch：超限先按主体合并——pinValue 保每引脚最新、nodeEnter 每节点一条', () => {
    const events: DebugEvent[] = []
    for (let i = 0; i < 300; i++) {
      events.push(ev('pinValue', 'a', { pinId: 'out', value: i })) // 同引脚 300 次 → 只留最新
      events.push(ev('nodeEnter', 'a')) // 同节点反复进入 → 只留一条
      events.push(ev('pinValue', 'b', { pinId: 'v', value: `s${i}` }))
    }
    assert.ok(events.length > 500, '前置：样本确实超限')
    const { events: out, dropped } = coalesceBatch(events, 500)
    // 合并阶段即收敛：主体只有 a:out / a:nodeEnter / b:v 三键，全部保最新。
    // dropped 语义 = 上限截断彻底丢弃的条数；去重保最新不损失观察信息，不计入
    assert.equal(out.length, 3)
    assert.equal(dropped, 0)
    const pvA = out.filter((e: DebugEvent) => e.kind === 'pinValue' && e.nodeId === 'a')
    const enterA = out.filter((e: DebugEvent) => e.kind === 'nodeEnter')
    assert.equal(pvA.length, 1, '同引脚只留最新')
    assert.equal((pvA[0] as DebugEvent).value, 299, '保留最新值')
    assert.equal(enterA.length, 1)
  })

  test('coalesceBatch：合并后仍超 → 保留最新段并计 dropped（nodeEnter 合并不丢节点）', () => {
    const events: DebugEvent[] = []
    for (let i = 0; i < 800; i++) events.push(ev('pinValue', `n${i}`, { pinId: 'out', value: i })) // 800 个不同引脚
    const { events: out, dropped } = coalesceBatch(events, 500)
    assert.equal(out.length, 500)
    assert.equal(dropped, 300)
    // 保留的是最新 500 条（n300..n799），时间戳序不乱
    assert.equal((out[0] as DebugEvent).nodeId, 'n300')
    assert.equal((out[499] as DebugEvent).nodeId, 'n799')
  })

  test('DebugProbe：150ms（测试用 30ms）窗口内多次 push 合并为一批发送', async () => {
    const t = makeTransport()
    const probe = new DebugProbe({ project: 'P', transport: t, batchMs: 30 })
    for (let i = 0; i < 50; i++) {
      probe.push('logic/a.bp.json', ev('pinValue', 'a', { pinId: 'out', value: i }))
    }
    // 窗口内：只有 attach 已发出，批未发
    await sleep(5)
    assert.equal(t.sent.filter((m) => m.type === 'debug.batch').length, 0)
    assert.equal(t.sent[0].type, 'debug.attach', '首推懒 attach')
    await sleep(45) // 越过 30ms 窗口
    const batches = t.sent.filter((m) => m.type === 'debug.batch')
    assert.equal(batches.length, 1, '窗口合并为一批')
    const batch = batches[0] as { project: string; assetPath: string; events: DebugEvent[] }
    assert.equal(batch.project, 'P')
    assert.equal(batch.assetPath, 'logic/a.bp.json')
    assert.equal(batch.events.length, 50, '未超上限不丢')
    probe.stop()
  })

  test('DebugProbe：mute 停发并清缓冲，unmute 恢复（观察开关传播）', async () => {
    const t = makeTransport()
    const probe = new DebugProbe({ project: 'P', transport: t, batchMs: 20 })
    probe.push('logic/a.bp.json', ev('nodeEnter', 'a'))
    probe.onServerMessage({ type: 'debug.mute', project: 'P', assetPath: 'logic/a.bp.json' })
    await sleep(40)
    assert.equal(t.sent.filter((m) => m.type === 'debug.batch').length, 0, 'mute 期间不发送')
    probe.push('logic/a.bp.json', ev('nodeEnter', 'b')) // mute 中继续 push 也丢弃
    probe.onServerMessage({ type: 'debug.unmute', project: 'P', assetPath: 'logic/a.bp.json' })
    probe.push('logic/a.bp.json', ev('nodeEnter', 'c'))
    await sleep(40)
    const batches = t.sent.filter((m) => m.type === 'debug.batch')
    assert.equal(batches.length, 1, 'unmute 后恢复且只发恢复后的缓冲')
    assert.equal(((batches[0] as { events: DebugEvent[] }).events[0]).nodeId, 'c')
    // 其它 project / 通道的 mute 不串扰
    probe.onServerMessage({ type: 'debug.mute', project: 'Q', assetPath: 'logic/a.bp.json' })
    probe.onServerMessage({ type: 'debug.mute', project: 'P', assetPath: 'logic/z.bp.json' })
    probe.push('logic/a.bp.json', ev('nodeEnter', 'd'))
    await sleep(40)
    assert.equal(t.sent.filter((m) => m.type === 'debug.batch').length, 2, '无关 mute 不影响本通道')
    probe.stop()
  })

  test('DebugProbe：stop 一键关闭（清缓冲停计时器，push 静默丢弃）', async () => {
    const t = makeTransport()
    const probe = new DebugProbe({ project: 'P', transport: t, batchMs: 20 })
    probe.push('logic/a.bp.json', ev('nodeEnter', 'a'))
    probe.stop()
    probe.push('logic/a.bp.json', ev('nodeEnter', 'b')) // stop 后静默
    await sleep(40)
    assert.equal(t.sent.filter((m) => m.type === 'debug.batch').length, 0)
    probe.stop() // 幂等
  })

  test('默认参数：150ms 批量窗 / 500 条上限（DoD 常量冻结）', () => {
    assert.equal(PROBE_BATCH_MS, 150)
    assert.equal(PROBE_MAX_BATCH, 500)
  })
})

/* ============================================================
 * 2. 叠加层纯函数（状态增量 + 惰性衰减 + 视图映射）
 * ============================================================ */

/** 最小受控视图模型（形状对齐 FlowNode / FlowEdge，测试免建 ReactFlow 对象） */
type TestNode = {
  id: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}
type TestEdge = {
  id: string
  source: string
  target: string
  data: Record<string, unknown>
}

describe('T5.4 叠加层状态（事件批折叠 + 惰性衰减）', () => {
  test('applyDebugEvents：nodeEnter/nodeExit 高亮、nodeError 标红、emit 忽略', () => {
    const s0 = emptyOverlayState()
    const s1 = applyDebugEvents(
      s0,
      [
        ev('nodeEnter', 'a', { ts: 100 }),
        ev('emit', undefined, { message: 'pressed', value: { value: 1 }, ts: 101 }),
        ev('nodeError', 'b', { message: 'boom', ts: 102 }),
      ],
      { now: 200 },
    )
    assert.equal(s1.nodeHighlight.get('a'), 100)
    assert.equal(s1.nodeErrors.get('b'), 102)
    assert.equal(s1.lastBatchAt, 200)
    assert.ok(isOverlayEmpty(s0), '入参未改（纯函数）')
  })

  test('applyDebugEvents：pinValue 键 nodeId:pinId，每引脚只留最新值', () => {
    const s = applyDebugEvents(
      emptyOverlayState(),
      [
        ev('pinValue', 'a', { pinId: 'out', value: 1, ts: 10 }),
        ev('pinValue', 'a', { pinId: 'out', value: 2, ts: 20 }),
        ev('pinValue', 'a', { pinId: 'other', value: 'x', ts: 15 }),
      ],
      { now: 30 },
    )
    assert.deepEqual(s.pinValues.get('a:out'), { value: 2, ts: 20 })
    assert.deepEqual(s.pinValues.get('a:other'), { value: 'x', ts: 15 })
  })

  test('applyDebugEvents：nodeEnter → 入向 exec 边流动（限定当前图），data 边不亮', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b', data: { kind: 'exec' } },
      { id: 'e2', source: 'a', target: 'b', data: { kind: 'data' } },
      { id: 'e3', source: 'c', target: 'b', data: { kind: 'exec' } },
    ]
    const inExec = buildInExecEdges(edges as never)
    assert.deepEqual([...inExec.get('b')!], ['e1', 'e3'], '只收 exec 入边')
    const s = applyDebugEvents(emptyOverlayState(), [ev('nodeEnter', 'b', { ts: 5 })], {
      now: 10,
      inExecEdges: inExec,
      graphName: 'main',
    })
    assert.equal(s.flowingEdges.get('e1'), 5)
    assert.equal(s.flowingEdges.get('e3'), 5)
    // 子图事件不映射流动（graph != 当前图）但保留高亮
    const s2 = applyDebugEvents(
      s,
      [ev('nodeEnter', 'b', { graph: 'sub', ts: 12 })],
      { now: 20, inExecEdges: inExec, graphName: 'main' },
    )
    assert.equal(s2.nodeHighlight.get('b'), 12)
    assert.equal(s2.flowingEdges.get('e1'), 5, '子图不新增流动')
  })

  test('decayOverlay：高亮 2s / 流动 0.8s / 端口值 5s 惰性过期；无过期返回原引用', () => {
    let s = applyDebugEvents(
      emptyOverlayState(),
      [
        ev('nodeEnter', 'a', { ts: 0 }),
        ev('nodeEnter', 'b', { ts: 700 }),
        ev('pinValue', 'a', { pinId: 'out', value: 1, ts: 0 }),
      ],
      { now: 10 },
    )
    const flowingId = 'e1'
    s.flowingEdges.set(flowingId, 0)
    assert.equal(decayOverlay(s, 500), s, '全部新鲜：原引用')
    const d1 = decayOverlay(s, 850) // e1（0ms + 800）过期，b（700ms）高亮仍新
    assert.ok(d1 !== s)
    assert.ok(!d1.flowingEdges.has(flowingId))
    assert.ok(d1.nodeHighlight.has('b'))
    assert.ok(d1.nodeHighlight.has('a'), 'a 高亮 2s 未过期')
    const d2 = decayOverlay(d1, 2100) // a 高亮（0+2000）过期；端口值 5s 未过期；b 高亮（700+2000=2700）仍新
    assert.ok(!d2.nodeHighlight.has('a'))
    assert.ok(d2.pinValues.has('a:out'), '端口值 5s 未到仍在')
    assert.ok(d2.nodeHighlight.has('b'))
    const d3 = decayOverlay(d2, 5100) // 端口值（0+5000）过期；b 高亮（2700）也过期
    assert.equal(d3.pinValues.size, 0)
    assert.ok(!d3.nodeHighlight.has('b'))
    assert.equal(HIGHLIGHT_TTL_MS, 2000)
    assert.equal(FLOW_TTL_MS, 800)
    assert.equal(PIN_TTL_MS, 5000)
  })
})

describe('T5.4 受控视图映射（data 注入 + 引用稳定）', () => {
  test('applyNodeOverlay：新鲜高亮写 data.debugHighlight；过期回落 undefined；无关节点保持原引用', () => {
    const nodes: TestNode[] = [
      { id: 'a', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', position: { x: 10, y: 0 }, data: {} },
    ]
    const state = applyDebugEvents(
      emptyOverlayState(),
      [ev('nodeEnter', 'a', { ts: 0 }), ev('nodeError', 'b', { ts: 0 })],
      { now: 100 },
    )
    const out = applyNodeOverlay(nodes as never, state, 500) as unknown as TestNode[]
    assert.equal(out[0]!.data.debugHighlight, 'active')
    assert.equal(out[1]!.data.debugHighlight, 'error')
    // 过期（>2s）：回落无 class；error 5s 内仍红
    const out2 = applyNodeOverlay(nodes as never, state, 2600) as unknown as TestNode[]
    assert.equal(out2[0]!.data.debugHighlight, undefined)
    assert.equal(out2[1]!.data.debugHighlight, 'error')
    // 空状态：原数组引用（零开销跳过重渲染）
    assert.equal(applyNodeOverlay(nodes as never, emptyOverlayState(), 0), nodes)
  })

  test('applyEdgeOverlay：流动集内的 exec 边 data.flowing=true；过期清除；空闲返回原引用', () => {
    const edges: TestEdge[] = [
      { id: 'e1', source: 'a', target: 'b', data: { kind: 'exec', flowing: false } },
      { id: 'e2', source: 'b', target: 'c', data: { kind: 'exec', flowing: false } },
    ]
    const flowing = new Map([['e1', 100]])
    const out = applyEdgeOverlay(edges as never, flowing, 500) as unknown as TestEdge[]
    assert.equal(out[0]!.data.flowing, true)
    assert.equal(out[1]!.data.flowing, false)
    assert.equal(out[1], edges[1], '未变化边保持原引用')
    const out2 = applyEdgeOverlay(edges as never, flowing, 1000) as unknown as TestEdge[] // 800ms 已过
    assert.equal(out2[0]!.data.flowing, false)
    assert.equal(applyEdgeOverlay(edges as never, new Map(), 0), edges, '无流动：原数组引用')
  })
})

/* ============================================================
 * 3. 观察开关持久化 + 徽标值格式化 + 编辑器批处理过滤
 * ============================================================ */

describe('T5.4 观察开关持久化 / 徽标 / 批处理过滤', () => {
  test('开关：缺省开、roundtrip、异常存储降级', () => {
    const store = makeStorage()
    assert.equal(loadObserveEnabled(store as never), true, '未存过 = 默认开（自动接入）')
    saveObserveEnabled(false, store as never)
    assert.equal(store.map.get(OBSERVE_STORAGE_KEY), '0')
    assert.equal(loadObserveEnabled(store as never), false)
    saveObserveEnabled(true, store as never)
    assert.equal(loadObserveEnabled(store as never), true)
    store.break()
    assert.equal(loadObserveEnabled(store as never), true, '存储异常回落默认开')
    assert.equal(loadObserveEnabled(null, true), true, '无存储（node:test）安全')
  })

  test('formatPinValue：字符串 / 数字 / 对象 JSON / 截断', () => {
    assert.equal(formatPinValue(42), '42')
    assert.equal(formatPinValue('abc'), 'abc')
    assert.equal(formatPinValue(true), 'true')
    assert.equal(formatPinValue({ a: 1 }), '{"a":1}')
    const long = 'x'.repeat(60)
    assert.equal(formatPinValue(long).length, 42)
    assert.ok(formatPinValue(long).endsWith('…'))
    assert.equal(formatPinValue(undefined), '—')
  })

  test('编辑器批处理：本面板通道才折叠；nodeError 触发 toast（2s 去重）', async () => {
    const { useBlueprintStore } = await import('../../blueprint/store/blueprint-store')
    const store = useBlueprintStore.getState()
    useBlueprintStore.setState({ toast: null })
    const updates: DebugOverlayState[] = []
    const setState = (updater: (prev: DebugOverlayState) => DebugOverlayState): void => {
      updates.push(updater(emptyOverlayState()))
    }
    const toasts: Array<Record<string, unknown>> = []
    const lastToastAt = new Map<string, number>()
    const origNotify = useBlueprintStore.getState().notify
    useBlueprintStore.setState({ notify: (text, kind) => toasts.push({ text, kind }) })

    // 通道匹配：project+assetPath 命中 → 折叠一次
    debugOverlayHandleMessage(
      { type: 'debug.batch', project: 'P', assetPath: 'logic/a.bp.json', events: [ev('nodeEnter', 'a', { ts: 1 })] },
      setState,
      lastToastAt,
      'P',
      ['logic/a.bp.json'],
    )
    // 通道不匹配（其它资产 / 其它项目）→ 忽略
    debugOverlayHandleMessage(
      { type: 'debug.batch', project: 'P', assetPath: 'logic/b.bp.json', events: [ev('nodeEnter', 'x')] },
      setState,
      lastToastAt,
      'P',
      ['logic/a.bp.json'],
    )
    assert.equal(updates.length, 1)
    assert.ok(updates[0]!.nodeHighlight.has('a'))
    // nodeError → toast + 2s 去重
    debugOverlayHandleMessage(
      {
        type: 'debug.batch',
        project: 'P',
        assetPath: 'logic/a.bp.json',
        events: [ev('nodeError', 'a', { message: 'boom', ts: 2 })],
      },
      setState,
      lastToastAt,
      'P',
      ['logic/a.bp.json'],
    )
    debugOverlayHandleMessage(
      {
        type: 'debug.batch',
        project: 'P',
        assetPath: 'logic/a.bp.json',
        events: [ev('nodeError', 'a', { message: 'boom', ts: 3 })],
      },
      setState,
      lastToastAt,
      'P',
      ['logic/a.bp.json'],
    )
    assert.equal(updates.length, 3, '每批一次 setState（不逐事件）')
    assert.equal(toasts.length, 1, '同节点同消息 2s 去重')
    assert.equal(toasts[0]!.kind, 'error')
    assert.ok(String(toasts[0]!.text).includes('boom'))
    useBlueprintStore.setState({ notify: origNotify, toast: store.toast })
  })
})
