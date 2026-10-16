/**
 * Blueprint Studio v2 —— 事件总线单测（T5.1 + T5.3 三件套验收，node:test）
 *
 * T5.1（事件总线）：
 *  1. 四类事件源（UI 节点 / 系统 / 插件推送 / 蓝图自定义）统一入队保序
 *  2. 三种 target 路由（node / ui / all）3 实例矩阵各自只达预期实例
 *  3. 环保护：A↔B 互发同名事件 8 跳后截断 + 警告 print（T2.6 遗留）
 *  4. 插件推送 pushPlugin → 蓝图 event.listen 收到（T6.4 CLI 桥咬合点）
 *  5. 具名参数匹配 + 位置式回退（经总线到达 event.custom / event.listen）
 *  6. 处理中入队只排队不递归（跨实例投递同样串行保序）
 *  8. timer 系统事件走总线（target ui）；stop 后队列清空不再投递
 *  9. 旁路：print 在队列等待期即时可达
 * 10. 注册表管理：重复注册覆盖 / 注销不再投递 / 快照
 * 11. start 生命周期事件不广播（T2.6 语义保持）
 * 12. routeEvent：payload 包 { value } / 未绑定节点静默 / target=node 探针
 * 13. push 路由变体：all 跨 UI / ui 分组 / node 按节点名 / node 缺名警告
 *
 * T5.3（事件节点三件套验收，builtinSpecMap + 解释器真实例 E2E）：
 *  7. IREventDef 具名双参数事件：event.send（参数经纯节点求值）→ 总线 →
 *     event.listen 具名输出脚 count/label 消费 → 下游节点断言
 *
 * 运行：npx tsx --test src/runtime/events/events.test.ts
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { IRAsset, IREdge, IRGraph, IRNode } from '../../ir/types'
import { builtinSpecMap } from '../../nodes'
import { createRuntime, type RuntimeHandle } from '../interpreter'
import { createEventBus, runtimeEventSink, BUS_ECHO_KEY } from './index'
import type { BusDebugEvent } from './index'

/* ============================================================
 * 测试工具（与 interpreter.test.ts 同款构造器风格）
 * ============================================================ */

function n(id: string, type: string, params: Record<string, unknown> = {}, pinDefaults: Record<string, unknown> = {}): IRNode {
  return { id, type, params, pinDefaults, position: { x: 0, y: 0 } }
}

function e(id: string, fromNode: string, fromPin: string, toNode: string, toPin: string, kind: 'exec' | 'data' = 'exec'): IREdge {
  return { id, from: { node: fromNode, pin: fromPin }, to: { node: toNode, pin: toPin }, kind }
}

function g(nodes: IRNode[], edges: IREdge[] = [], extra: Partial<IRGraph> = {}): IRGraph {
  return { nodes, edges, ...extra }
}

function asset(graphs: Record<string, IRGraph>, opts: { entry?: string; events?: IRAsset['events'] } = {}): IRAsset {
  return {
    version: 2,
    name: '测试资产',
    entry: opts.entry ?? 'bind',
    graphs,
    variables: [],
    events: opts.events ?? [],
    snippets: [],
    layout: {},
  }
}

async function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await tick(10)
  }
}

/** RuntimeHandle 替身（路由矩阵 / 注册表用：只记录 emit 到达） */
function stubRuntime(): { rt: RuntimeHandle; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const rt: RuntimeHandle = {
    start() {},
    stop() {},
    emit(name: string, args?: Record<string, unknown>) {
      calls.push({ name, args: { ...(args ?? {}) } })
    },
    callGraph: () => Promise.resolve({}),
    getVar: () => undefined,
    setVar: () => {},
    isRunning: true,
  }
  return { rt, calls }
}

/** 建一个接总线的真实解释器实例（builtinSpecMap；prints 收集 print 首参） */
function bridge(
  bus: ReturnType<typeof createEventBus>,
  id: string,
  bp: IRAsset,
  uiId?: string,
  boundNodes?: ReadonlySet<string>,
): { rt: ReturnType<typeof createRuntime>; prints: unknown[][] } {
  const prints: unknown[][] = []
  const rt = createRuntime(bp, builtinSpecMap, {
    onPrint: (...p) => prints.push(p),
    onDebug: runtimeEventSink(id, bus),
  })
  bus.register({ id, assetPath: `${id}.bp.json`, uiId, boundNodes, rt })
  return { rt, prints }
}

/* ══ 1. 四类事件源统一入队保序 ═══════════════════════════════ */

describe('T5.1 事件总线（四类源 / 路由 / 环保护）', () => {
  test('四类事件源统一入队保序（混合 5 条按序到达）', async () => {
    const bus = createEventBus()
    // 接收实例 S：监听 e1~e5 各打印同名 tag（真实解释器 + builtinSpecMap）
    const bp = asset({
      bind: g(
        (['e1', 'e2', 'e3', 'e4', 'e5'] as const).flatMap((name) => [
          n(`l_${name}`, 'event.listen', {}, { eventName: name }),
          n(`p_${name}`, 'system.print', {}, { value: name }),
        ]),
        (['e1', 'e2', 'e3', 'e4', 'e5'] as const).map((name) => e(`x_${name}`, `l_${name}`, 'exec', `p_${name}`, 'exec')),
      ),
    })
    const sink = bridge(bus, 'S', bp, undefined, new Set(['btnGo']))
    sink.rt.start()
    const stubA = stubRuntime()
    bus.register({ id: 'A', assetPath: 'a.bp.json', rt: stubA.rt })

    // 四类源混合入队：① UI 节点 ② 系统 ③ 插件 ④ 蓝图自定义（解释器回灌口）② 系统
    bus.routeEvent({ nodeName: 'btnGo', event: 'e1' })
    bus.pushSystem('e2')
    bus.pushPlugin('phone-log', 'e3', { line: 'x' })
    bus.publishFromRuntime('A', 'e4', { n: 4 })
    bus.pushSystem('e5')
    await waitFor(() => sink.prints.length >= 5, '五条事件按序到达')
    assert.deepEqual(
      sink.prints.map((p) => p[0]),
      ['e1', 'e2', 'e3', 'e4', 'e5'],
      '混合源 FIFO 保序',
    )
    sink.rt.stop()
  })

  /* ══ 2. 三种 target 路由矩阵 ═══════════════════════════════ */

  test('三种 target 路由（node/ui/all）：3 实例矩阵各自只达预期实例', async () => {
    const bus = createEventBus()
    const listens = ['mNode', 'mUi', 'mAll'] as const
    const mkListenerBp = (tag: string): IRAsset =>
      asset({
        bind: g(
          listens.flatMap((name) => [
            n(`l_${name}`, 'event.listen', {}, { eventName: name }),
            n(`p_${name}`, 'system.print', {}, { value: `${tag}:${name}` }),
          ]),
          listens.map((name) => e(`x_${name}`, `l_${name}`, 'exec', `p_${name}`, 'exec')),
        ),
      })
    // 发送实例 R1：start → 三连发（target 引脚分别 node / ui / all）+ 自身三个监听（本地分发即收到）
    const mkRunnerBp = (): IRAsset =>
      asset({
        bind: g(
          [
            n('st', 'event.start'),
            n('s1', 'event.send', {}, { eventName: 'mNode', target: 'node' }),
            n('s2', 'event.send', {}, { eventName: 'mUi', target: 'ui' }),
            n('s3', 'event.send', {}, { eventName: 'mAll', target: 'all' }),
            ...listens.flatMap((name) => [
              n(`l_${name}`, 'event.listen', {}, { eventName: name }),
              n(`p_${name}`, 'system.print', {}, { value: `R1:${name}` }),
            ]),
          ],
          [
            e('g1', 'st', 'exec', 's1', 'exec'),
            e('g2', 's1', 'exec', 's2', 'exec'),
            e('g3', 's2', 'exec', 's3', 'exec'),
            ...listens.map((name) => e(`x_${name}`, `l_${name}`, 'exec', `p_${name}`, 'exec')),
          ],
        ),
      })

    const r1 = bridge(bus, 'R1', mkRunnerBp(), 'w1')
    const r2 = bridge(bus, 'R2', mkListenerBp('R2'), 'w1')
    const r3 = bridge(bus, 'R3', mkListenerBp('R3'), 'w2')
    r2.rt.start()
    r3.rt.start()
    r1.rt.start()
    await waitFor(() => r1.prints.length + r2.prints.length + r3.prints.length >= 6, '全部投递到达')
    await tick(80)
    const tags = (id: 'R1' | 'R2' | 'R3', ps: unknown[][]) => ({ id, got: ps.map((p) => String(p[0])).sort() })
    // node：仅发送实例自身（本地分发）；ui：同 UI 实例组；all：跨 UI 全部
    assert.deepEqual(tags('R1', r1.prints), { id: 'R1', got: ['R1:mAll', 'R1:mNode', 'R1:mUi'] })
    assert.deepEqual(tags('R2', r2.prints), { id: 'R2', got: ['R2:mAll', 'R2:mUi'] })
    assert.deepEqual(tags('R3', r3.prints), { id: 'R3', got: ['R3:mAll'] })
    r1.rt.stop()
    r2.rt.stop()
    r3.rt.stop()
  })

  /* ══ 3. 环保护 ═════════════════════════════════════════════ */

  test('环保护：A↔B 互发同名事件 8 跳后截断 + 警告 print', async () => {
    const warns: string[] = []
    const bus = createEventBus({ onWarn: (m) => warns.push(m) })
    // 中继蓝图：listen(spin) → 分支（args.value ≠ 本机名才转发）→ 打印 → 发送（args=本机名）
    // 事件参数为单值打包 { value: '<stamp>' }（event.send 单值 → {value}），map.get 取出比较，
    // 保证「只转发别家来的事件」——不会自激本地环，纯靠总线在 A↔B 之间往返。
    // 只有 A 带首发 send（start → s0）；B 纯中继——两股初始波叠加会干扰跳数推演。
    const mkRelayBp = (self: string, withInitial: boolean): IRAsset =>
      asset({
        bind: g(
          [
            ...(withInitial ? [n('st', 'event.start'), n('s0', 'event.send', {}, { eventName: 'spin', target: 'all', args: self })] : []),
            n('l', 'event.listen', {}, { eventName: 'spin' }),
            n('mg', 'map.get', {}, { key: 'value' }),
            n('cmp', 'math.compare', { op: '!=' }, { b: self }),
            n('br', 'flow.branch'),
            n('pr', 'system.print', {}, { value: `${self}·send` }),
            n('snd', 'event.send', {}, { eventName: 'spin', target: 'all', args: self }),
          ],
          [
            ...(withInitial ? [e('g1', 'st', 'exec', 's0', 'exec')] : []),
            e('g2', 'l', 'exec', 'br', 'exec'),
            e('d1', 'l', 'args', 'mg', 'map', 'data'),
            e('d2', 'mg', 'value', 'cmp', 'a', 'data'),
            e('d3', 'cmp', 'value', 'br', 'cond', 'data'),
            e('g3', 'br', 'true', 'pr', 'exec'),
            e('g4', 'pr', 'exec', 'snd', 'exec'),
          ],
        ),
      })

    const a = bridge(bus, 'A', mkRelayBp('A', true))
    const b = bridge(bus, 'B', mkRelayBp('B', false))
    b.rt.start()
    a.rt.start()
    await waitFor(() => warns.length >= 1, '环保护警告出现')
    await tick(120)
    const sends = (ps: unknown[][]) => ps.filter((p) => String(p[0]).endsWith('·send')).length
    // 推演：P0(A 首发 hops0)→B 转发(hops1)→A(hops2)→…→B 第 5 次转发(hops9)被截断
    assert.equal(sends(a.prints), 4, 'A 转发 4 次')
    assert.equal(sends(b.prints), 5, 'B 转发 5 次（最后一次的投递被截断）')
    assert.equal(warns.length, 1, '仅截断一次')
    assert.ok(warns[0]!.includes('spin') && warns[0]!.includes('8'), '警告含事件名与跳数上限')
    const before = sends(a.prints) + sends(b.prints)
    await tick(120)
    assert.equal(sends(a.prints) + sends(b.prints), before, '截断后传播链终止（不再增长）')
    a.rt.stop()
    b.rt.stop()
  })

  /* ══ 4. 插件推送 ═══════════════════════════════════════════ */

  test('插件推送 pushPlugin → 蓝图 event.listen 收到（T6.4 咬合点）', async () => {
    const probe: BusDebugEvent[] = []
    const bus = createEventBus({ onDebug: (ev) => probe.push(ev) })
    const bp = asset({
      bind: g(
        [n('l', 'event.listen', {}, { eventName: 'logLine' }), n('p', 'system.print')],
        [e('g1', 'l', 'exec', 'p', 'exec'), e('d1', 'l', 'args', 'p', 'value', 'data')],
      ),
    })
    const sink = bridge(bus, 'B', bp)
    sink.rt.start()
    bus.pushPlugin('phone-log', 'logLine', { line: 'L1', level: 'INFO' })
    await waitFor(() => sink.prints.length >= 1, '插件推送到达蓝图')
    const args = sink.prints[0]![0] as Record<string, unknown>
    assert.equal(args['line'], 'L1', '插件推送参数按名可达')
    assert.equal(args['level'], 'INFO')
    const deliver = probe.find((ev) => ev.kind === 'deliver')
    assert.ok(deliver, '总线探针记录投递')
    assert.equal(deliver!.source.kind, 'plugin')
    assert.equal(deliver!.source.id, 'phone-log')
    assert.equal(deliver!.target, 'ui')
    sink.rt.stop()
  })

  /* ══ 5. 具名参数匹配 + 位置式回退 ══════════════════════════ */

  test('具名参数匹配 + 位置式回退（经总线到达 event.custom / event.listen）', async () => {
    const bus = createEventBus()
    const bp = asset(
      {
        bind: g(
          [
            n('c', 'event.custom', { eventName: 'loaded' }),
            n('p1', 'system.print'), // 具名 count
            n('p2', 'system.print'), // 位置式 arg0
            n('l', 'event.listen', {}, { eventName: 'loaded' }),
            n('p3', 'system.print'), // args 对象
          ],
          [
            e('g1', 'c', 'exec', 'p1', 'exec'),
            e('g2', 'p1', 'exec', 'p2', 'exec'),
            e('g3', 'l', 'exec', 'p3', 'exec'),
            e('d1', 'c', 'count', 'p1', 'value', 'data'),
            e('d2', 'c', 'arg0', 'p2', 'value', 'data'),
            e('d3', 'l', 'args', 'p3', 'value', 'data'),
          ],
        ),
      },
      {
        events: [
          { name: 'loaded', params: [{ name: 'count', type: 'int' }, { name: 'label', type: 'string' }] },
        ],
      },
    )
    const sink = bridge(bus, 'R', bp)
    sink.rt.start()
    const src = stubRuntime()
    bus.register({ id: 'SRC', assetPath: 'src.bp.json', rt: src.rt })
    bus.publishFromRuntime('SRC', 'loaded', { count: 3, label: 'x' })
    await waitFor(() => sink.prints.length >= 3, '三个消费口收到')
    assert.equal(sink.prints[0]![0], 3, 'event.custom 具名参数按名注入输出脚')
    assert.equal(sink.prints[1]![0], 3, '位置式 arg0 回退注入占位脚')
    const args = sink.prints[2]![0] as Record<string, unknown>
    assert.equal(args['count'], 3, 'event.listen args 对象含具名参数')
    assert.equal(args['label'], 'x')
    sink.rt.stop()
  })

  /* ══ 6. 处理中入队只排队不递归 ═════════════════════════════ */

  test('处理中入队只排队不递归（跨实例投递同样串行保序）', async () => {
    const bus = createEventBus()
    const bp = asset({
      bind: g(
        [
          n('l1', 'event.listen', {}, { eventName: 'go' }),
          n('d1', 'flow.delay', {}, { seconds: 0.05 }),
          n('p1', 'system.print', {}, { value: 'go·done' }),
          n('l2', 'event.listen', {}, { eventName: 'mid' }),
          n('p2', 'system.print', {}, { value: 'mid·done' }),
          n('l3', 'event.listen', {}, { eventName: 'tail' }),
          n('p3', 'system.print', {}, { value: 'tail·done' }),
        ],
        [
          e('g1', 'l1', 'exec', 'd1', 'exec'),
          e('g2', 'd1', 'done', 'p1', 'exec'),
          e('g3', 'l2', 'exec', 'p2', 'exec'),
          e('g4', 'l3', 'exec', 'p3', 'exec'),
        ],
      ),
    })
    const sink = bridge(bus, 'S', bp)
    sink.rt.start()
    const src = stubRuntime()
    bus.register({ id: 'X', assetPath: 'x.bp.json', rt: src.rt })
    // 三条连续入队：go 链在 delay 处挂起 50ms，后两条（含跨实例 custom 源）只能排队
    bus.pushSystem('go')
    bus.publishFromRuntime('X', 'mid')
    bus.pushSystem('tail')
    await waitFor(() => sink.prints.length >= 3, '三条按序处理完')
    assert.deepEqual(
      sink.prints.map((p) => String(p[0])),
      ['go·done', 'mid·done', 'tail·done'],
      '不闯入 / 不递归 / 不重复（各恰一次）',
    )
    sink.rt.stop()
  })

  /* ══ 7. T5.3 E2E：具名双参数事件全链路 ═════════════════════ */

  test('T5.3 E2E：具名双参数事件 send（参数纯节点求值）→ 总线 → listen 具名输出脚消费', async () => {
    const probe: BusDebugEvent[] = []
    const bus = createEventBus({ onDebug: (ev) => probe.push(ev) })
    // 发送方 A：events 声明 loaded(count:int, label:string)；
    // count = 1+2（math.add 纯节点求值）→ JSON 拼装 → jsonParse → event.send（target 默认 ui）
    const bpA = asset(
      {
        bind: g(
          [
            n('st', 'event.start'),
            n('add', 'math.add', {}, { a: 1, b: 2 }),
            n('str', 'convert.toString'),
            n('c1', 'string.concat', {}, { a: '{"count":' }),
            n('c2', 'string.concat', {}, { b: ',"label":"x"}' }),
            n('js', 'convert.jsonParse'),
            n('snd', 'event.send', {}, { eventName: 'loaded', target: 'ui' }),
          ],
          [
            e('g1', 'st', 'exec', 'snd', 'exec'),
            e('d1', 'add', 'value', 'str', 'value', 'data'),
            e('d2', 'str', 'value', 'c1', 'b', 'data'),
            e('d3', 'c1', 'value', 'c2', 'a', 'data'),
            e('d4', 'c2', 'value', 'js', 'value', 'data'),
            e('d5', 'js', 'value', 'snd', 'args', 'data'),
          ],
        ),
      },
      {
        events: [
          { name: 'loaded', params: [{ name: 'count', type: 'int' }, { name: 'label', type: 'string' }] },
        ],
      },
    )
    // 接收方 B：event.listen(loaded) → 具名输出脚 count / label 直接连数据边消费
    const bpB = asset({
      bind: g(
        [
          n('l', 'event.listen', {}, { eventName: 'loaded' }),
          n('p1', 'system.print'),
          n('p2', 'system.print'),
        ],
        [
          e('g1', 'l', 'exec', 'p1', 'exec'),
          e('g2', 'p1', 'exec', 'p2', 'exec'),
          e('d1', 'l', 'count', 'p1', 'value', 'data'),
          e('d2', 'l', 'label', 'p2', 'value', 'data'),
        ],
      ),
    })
    const a = bridge(bus, 'A', bpA)
    const b = bridge(bus, 'B', bpB)
    b.rt.start()
    a.rt.start()
    await waitFor(() => b.prints.length >= 2, '接收方消费到具名参数')
    assert.equal(b.prints[0]![0], 3, 'count 具名输出脚（纯节点求值 1+2）')
    assert.equal(b.prints[1]![0], 'x', 'label 具名输出脚')
    const deliver = probe.find((ev) => ev.kind === 'deliver' && ev.name === 'loaded')
    assert.ok(deliver, '总线探针记录 loaded 投递')
    assert.equal(deliver!.source.kind, 'custom')
    assert.equal(deliver!.source.id, 'A')
    assert.equal(deliver!.target, 'ui')
    a.rt.stop()
    b.rt.stop()
  })

  /* ══ 8. timer 系统事件 + stop 清队 ═════════════════════════ */

  test('timer 系统事件走总线（target ui）；stop 后队列清空不再投递', async () => {
    const bus = createEventBus()
    // 发送方 A：listen(kick) → 一次性定时器（到期发布系统事件 'timer'，参数 { ticks }）
    const bpA = asset({
      bind: g(
        [n('l', 'event.listen', {}, { eventName: 'kick' }), n('t', 'event.timer', {}, { interval: 0.01, loop: false })],
        [e('g1', 'l', 'exec', 't', 'exec')],
      ),
    })
    // 接收方 B：监听系统事件 'timer'
    const bpB = asset({
      bind: g(
        [n('l', 'event.listen', {}, { eventName: 'timer' }), n('mg', 'map.get', {}, { key: 'ticks' }), n('p', 'system.print')],
        [e('g1', 'l', 'exec', 'p', 'exec'), e('d1', 'l', 'args', 'mg', 'map', 'data'), e('d2', 'mg', 'value', 'p', 'value', 'data')],
      ),
    })
    const a = bridge(bus, 'A', bpA)
    const b = bridge(bus, 'B', bpB)
    b.rt.start()
    a.rt.start()
    bus.pushSystem('kick')
    await waitFor(() => b.prints.length >= 1, 'timer 系统事件经总线到达')
    bus.pushSystem('kick')
    await waitFor(() => b.prints.length >= 2, '第二次计时到期')
    assert.deepEqual(b.prints.map((p) => p[0]), [1, 1], '每次到期发布 { ticks }（一次性计时 ticks 复位为 1）')
    // stop：实例停机后系统事件不再触达（解释器清队 + emit 静默丢弃）
    a.rt.stop()
    bus.pushSystem('kick')
    await tick(80)
    assert.equal(b.prints.length, 2, 'stop 后不再投递')
    assert.equal(a.rt.isRunning, false)
    b.rt.stop()
  })

  /* ══ 9. print 旁路 ═════════════════════════════════════════ */

  test('旁路：print 在队列等待期即时可达', async () => {
    const bus = createEventBus()
    const bp = asset({
      bind: g(
        [
          n('l1', 'event.listen', {}, { eventName: 'busy' }),
          n('p1', 'system.print', {}, { value: 'during' }),
          n('d', 'flow.delay', {}, { seconds: 0.03 }),
          n('p2', 'system.print', {}, { value: 'after' }),
          n('l2', 'event.listen', {}, { eventName: 'next' }),
          n('p3', 'system.print', {}, { value: 'next' }),
        ],
        [
          e('g1', 'l1', 'exec', 'p1', 'exec'),
          e('g2', 'p1', 'exec', 'd', 'exec'),
          e('g3', 'd', 'done', 'p2', 'exec'),
          e('g4', 'l2', 'exec', 'p3', 'exec'),
        ],
      ),
    })
    const stamped: { at: number; v: unknown }[] = []
    const rt = createRuntime(bp, builtinSpecMap, {
      onPrint: (...p) => stamped.push({ at: Date.now(), v: p[0] }),
    })
    bus.register({ id: 'S', assetPath: 's.bp.json', rt })
    rt.start()
    bus.pushSystem('busy')
    bus.pushSystem('next') // 立即入队：排在 busy 链之后（队列等待期）
    await waitFor(() => stamped.length >= 3, '三条打印可达')
    assert.deepEqual(
      stamped.map((p) => String(p.v)),
      ['during', 'after', 'next'],
      '串行队列：排队事件不闯入',
    )
    assert.ok(stamped[0]!.at < stamped[2]!.at, '等待期内的 print 先于排队事件到达（旁路直调）')
    rt.stop()
  })

  /* ══ 10. 注册表管理 ════════════════════════════════════════ */

  test('注册表管理：重复注册覆盖 / 注销不再投递 / 快照', () => {
    const bus = createEventBus()
    const s1 = stubRuntime()
    const s2 = stubRuntime()
    bus.register({ id: 'R', assetPath: 'x.bp.json', uiId: 'w1', boundNodes: new Set(['btn']), rt: s1.rt })
    bus.register({ id: 'R', assetPath: 'x.bp.json', uiId: 'w1', rt: s2.rt }) // 同 id 重复注册 → 覆盖
    bus.pushSystem('ev', {}, { target: 'ui', uiId: 'w1' })
    assert.equal(s1.calls.length, 0, '旧注册被覆盖，不再收到')
    assert.equal(s2.calls.length, 1, '新注册收到投递')
    bus.unregister('R')
    bus.pushSystem('ev2', {}, { target: 'ui', uiId: 'w1' })
    assert.equal(s2.calls.length, 1, '注销后不再投递')
    assert.doesNotThrow(() => bus.unregister('R'), '注销未知 id 幂等')
    bus.register({ id: 'Q', assetPath: 'q.bp.json', rt: s1.rt })
    assert.deepEqual(
      bus.registrations().map((r) => r.id),
      ['Q'],
      '快照反映注册表当前状态',
    )
  })

  /* ══ 11. start 不广播 ══════════════════════════════════════ */

  test('start 生命周期事件不广播（各实例自行触发，T2.6 语义保持）', async () => {
    const bus = createEventBus()
    const bpA = asset({
      bind: g([n('st', 'event.start'), n('p', 'system.print', {}, { value: 'A·started' })], [e('g', 'st', 'exec', 'p', 'exec')]),
    })
    // B 专门监听 'start'（无 event.start 节点——解释器的 start 内部事件只路由到
    // event.start 节点，B 本地不会自触发）；若总线误广播 A 的 start，B 必然收到
    const bpB = asset({
      bind: g(
        [n('l', 'event.listen', {}, { eventName: 'start' }), n('p', 'system.print', {}, { value: 'B·GOT-START' })],
        [e('g', 'l', 'exec', 'p', 'exec')],
      ),
    })
    const a = bridge(bus, 'A', bpA)
    const b = bridge(bus, 'B', bpB)
    b.rt.start()
    a.rt.start()
    await waitFor(() => a.prints.length >= 1, 'A 本地 start 到达')
    await tick(120)
    assert.deepEqual(b.prints, [], '总线的 start 回灌被跳过：B 的 start 监听不触发')
    assert.ok(a.prints.length >= 1)
    a.rt.stop()
    b.rt.stop()
  })

  /* ══ 12. routeEvent 语义（T2.6 兼容） ══════════════════════ */

  test('routeEvent：payload 包 { value } / 未绑定节点静默 / target=node 探针', async () => {
    const probe: BusDebugEvent[] = []
    const bus = createEventBus({ onDebug: (ev) => probe.push(ev) })
    const bp = asset({
      bind: g(
        [
          n('l1', 'event.listen', {}, { eventName: 'valueChanged' }),
          n('p1', 'system.print'),
          n('l2', 'event.listen', {}, { eventName: 'pressed' }),
          n('p2', 'system.print'),
        ],
        [
          e('g1', 'l1', 'exec', 'p1', 'exec'),
          e('d1', 'l1', 'args', 'p1', 'value', 'data'),
          e('g2', 'l2', 'exec', 'p2', 'exec'),
          e('d2', 'l2', 'args', 'p2', 'value', 'data'),
        ],
      ),
    })
    const sink = bridge(bus, 'S', bp, undefined, new Set(['btnGo']))
    sink.rt.start()
    bus.routeEvent({ nodeName: 'btnGo', nodeType: 'button', event: 'valueChanged', payload: 42 })
    bus.routeEvent({ nodeName: 'btnGo', event: 'pressed' })
    bus.routeEvent({ nodeName: 'ghost', event: 'pressed' }) // 未绑定：静默丢弃
    await waitFor(() => sink.prints.length >= 2, '两条事件到达')
    const withPayload = sink.prints[0]![0] as Record<string, unknown>
    assert.equal(withPayload['value'], 42, 'payload 统一包 { value }（T2.6 契约）')
    const noPayload = sink.prints[1]![0] as Record<string, unknown>
    assert.equal(noPayload['value'], undefined, '无 payload 时不注入 value')
    assert.ok(BUS_ECHO_KEY in noPayload, '投递附带回执令牌（接收实例回灌时防自转发）')
    assert.equal(
      sink.prints.length,
      2,
      '未绑定节点的事件不产生投递（ghost 静默）',
    )
    const deliver = probe.find((ev) => ev.kind === 'deliver' && ev.name === 'valueChanged')
    assert.ok(deliver, '探针记录 UI 事件投递')
    assert.equal(deliver!.source.kind, 'ui')
    assert.equal(deliver!.source.id, 'btnGo')
    assert.equal(deliver!.target, 'node')
    sink.rt.stop()
  })

  /* ══ 13. push 路由变体 ═════════════════════════════════════ */

  test('push 路由变体：all 跨 UI / ui 分组 / node 按节点名 / node 缺名警告', () => {
    const warns: string[] = []
    const bus = createEventBus({ onWarn: (m) => warns.push(m) })
    const r1 = stubRuntime()
    const r2 = stubRuntime()
    const r3 = stubRuntime()
    bus.register({ id: 'R1', assetPath: '1.bp.json', uiId: 'w1', boundNodes: new Set(['n1']), rt: r1.rt })
    bus.register({ id: 'R2', assetPath: '2.bp.json', uiId: 'w1', boundNodes: new Set(['n2']), rt: r2.rt })
    bus.register({ id: 'R3', assetPath: '3.bp.json', uiId: 'default', boundNodes: new Set(['n3']), rt: r3.rt })

    bus.pushPlugin('p', 'ev', {}, { target: 'all' }) // 跨 UI 全部
    bus.pushSystem('ev2', {}, { target: 'ui', uiId: 'w1' }) // 指定 UI 组
    bus.pushSystem('ev3', {}, { target: 'ui' }) // 缺省 'default' 组
    bus.pushSystem('ev4', {}, { target: 'node', node: 'n2' }) // 按节点名
    bus.pushPlugin('p', 'ev5', {}, { target: 'node' }) // 缺节点名 → 丢弃并警告
    bus.pushPlugin('p', 'ev6') // 完全缺省 → target 'ui'（default 组）

    assert.deepEqual(r1.calls.map((c) => c.name), ['ev', 'ev2'], 'R1（w1）：all + ui(w1)')
    assert.deepEqual(r2.calls.map((c) => c.name), ['ev', 'ev2', 'ev4'], 'R2（w1+n2）：all + ui(w1) + node')
    assert.deepEqual(r3.calls.map((c) => c.name), ['ev', 'ev3', 'ev6'], 'R3（default）：all + ui(default)×2')
    assert.equal(warns.length, 1, 'node 缺节点名警告一次')
    assert.ok(warns[0]!.includes('ev5') && warns[0]!.includes('node'), '警告指明事件与原因')
  })
})
