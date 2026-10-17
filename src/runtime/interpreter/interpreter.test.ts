/**
 * Blueprint Studio v2 —— IR 解释器 v2 单测（T2.5，node:test）
 *
 * 覆盖：exec 链顺序 / branch 走向 / 数据边+默认值 / 纯节点链求值与记忆化 /
 * exec 指向纯节点报错 / 纯节点数据环检测 / flow.call 参数·返回·嵌套 / 递归深度限制 /
 * delay 异步时序 / 事件串行保序+处理中 emit 排队不递归 / print 旁路 /
 * var 读写与初值 / 调试探针 / 节点抛错隔离 / 内置节点库集成（协议咬合） /
 * stop 复位 forLoop 状态（clearAllStateSlots）。
 *
 * 单测使用本地最小 spec（解释器核心不 import 节点库）；仅「集成」用例注入 @/nodes 的
 * builtinSpecMap 验证真实节点协议咬合。事件壳 spec（event.start/event.custom/event.listen）
 * 与 src/nodes/events.ts 的引脚约定逐字对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IREdge, IREventDef, IRGraph, IRNode, IRVariable, NodeSpec } from '@/ir/types';
import { builtinSpecMap } from '@/nodes';
import { createRuntime } from './interpreter';
import type { DebugEvent } from './types';

/* ============================================================
 * 测试工具：IR 构造 / 本地 spec / 录制器
 * ============================================================ */

function n(id: string, type: string, params: Record<string, unknown> = {}, pinDefaults: Record<string, unknown> = {}): IRNode {
  return { id, type, params, pinDefaults, position: { x: 0, y: 0 } };
}

function e(id: string, fromNode: string, fromPin: string, toNode: string, toPin: string, kind: 'exec' | 'data' = 'exec'): IREdge {
  return { id, from: { node: fromNode, pin: fromPin }, to: { node: toNode, pin: toPin }, kind };
}

function g(nodes: IRNode[], edges: IREdge[] = [], extra: Partial<IRGraph> = {}): IRGraph {
  return { nodes, edges, ...extra };
}

function asset(graphs: Record<string, IRGraph>, opts: { entry?: string; variables?: IRVariable[]; events?: IREventDef[] } = {}): IRAsset {
  return {
    version: 2,
    name: '测试资产',
    entry: opts.entry ?? 'main',
    graphs,
    variables: opts.variables ?? [],
    events: opts.events ?? [],
    snippets: [],
    layout: {},
  };
}

interface Recordings {
  prints: { at: number; parts: unknown[] }[];
  errors: { at: number; err: Error; graph: string; nodeId: string }[];
  debug: DebugEvent[];
}

function harness(a: IRAsset, specs: Map<string, NodeSpec>, extra: Record<string, unknown> = {}) {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(a, specs, {
    onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
    onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
    onDebug: (ev) => rec.debug.push(ev),
    ...extra,
  });
  return { rt, rec };
}

function mapOf(list: NodeSpec[]): Map<string, NodeSpec> {
  return new Map(list.map((s) => [s.id, s]));
}

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 所有打印首参的字符串视图（顺序断言用） */
function tags(rec: Recordings): string[] {
  return rec.prints.flatMap((p) => p.parts.map(String));
}

/* ---------------- 本地最小 spec（与 src/nodes 引脚约定对齐） ---------------- */

const execIn = { id: 'exec', type: 'exec' } as const;
const execOut = { id: 'exec', type: 'exec' } as const;

/** 事件壳：开始（与 event.start 对齐） */
const evStart: NodeSpec = {
  id: 'event.start', title: '开始', category: '事件',
  inputs: [], outputs: [execOut],
  run: () => ({ next: 'exec', outputs: {} }),
};

/** 事件壳：自定义事件（与 event.custom 对齐：exec 出 + arg0~arg2 占位数据脚） */
const evCustom: NodeSpec = {
  id: 'event.custom', title: '自定义事件', category: '事件',
  inputs: [],
  outputs: [execOut, { id: 'arg0', type: 'any' }, { id: 'arg1', type: 'any' }, { id: 'arg2', type: 'any' }],
  run: () => ({ next: 'exec', outputs: {} }),
};

/** 事件壳：监听事件（与 event.listen 对齐：无 exec 入，args 数据脚） */
const evListen: NodeSpec = {
  id: 'event.listen', title: '监听事件', category: '事件',
  inputs: [{ id: 'eventName', type: 'string', defaultValue: '' }],
  outputs: [execOut, { id: 'args', type: 'any' }],
  run: () => ({ next: 'exec', outputs: {} }),
};

/** 标记节点：打印检视器参数 tag（链顺序断言用） */
const mark: NodeSpec = {
  id: 't.mark', title: '标记', category: '流程',
  inputs: [execIn], outputs: [execOut],
  params: [{ id: 'tag', label: '标记', type: 'string', default: '' }],
  run: (ctx) => {
    ctx.print(ctx.params.tag);
    return { next: 'exec', outputs: {} };
  },
};

/** 打印输入值节点（数据值断言用） */
const printVal: NodeSpec = {
  id: 't.printVal', title: '打印值', category: '流程',
  inputs: [execIn, { id: 'v', type: 'any', defaultValue: null }], outputs: [execOut],
  run: (ctx, inputs) => {
    ctx.print(inputs.v);
    return { next: 'exec', outputs: {} };
  },
};

/** 延时节点（走 ctx.delay，与 flow.delay 同语义） */
const wait: NodeSpec = {
  id: 't.wait', title: '延时', category: '流程',
  inputs: [execIn, { id: 'ms', type: 'float', defaultValue: 0 }],
  outputs: [{ id: 'done', type: 'exec' }],
  run: async (ctx, inputs) => {
    await ctx.delay(Number(inputs.ms) || 0);
    return { next: 'done', outputs: {} };
  },
};

const baseSpecs = mapOf([evStart, evCustom, evListen, mark, printVal, wait]);

/* ============================================================
 * 1. exec 链按序执行
 * ============================================================ */

test('exec 链按序执行', async () => {
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('x', 't.mark', { tag: 'A' }), n('y', 't.mark', { tag: 'B' }), n('z', 't.mark', { tag: 'C' })],
      [e('e1', 'c1', 'exec', 'x', 'exec'), e('e2', 'x', 'exec', 'y', 'exec'), e('e3', 'y', 'exec', 'z', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, baseSpecs);
  rt.start();
  rt.emit('go');
  await tick(60);
  assert.deepEqual(tags(rec), ['A', 'B', 'C']);
  rt.stop();
});

/* ============================================================
 * 2. branch 分支走向
 * ============================================================ */

const localBranch: NodeSpec = {
  id: 't.branch', title: '分支', category: '流程',
  inputs: [execIn, { id: 'cond', type: 'bool', defaultValue: false }],
  outputs: [{ id: 'true', type: 'exec' }, { id: 'false', type: 'exec' }],
  run: (_ctx, inputs) => ({ next: inputs.cond ? 'true' : 'false', outputs: {} }),
};

test('branch 分支走向（真/假出口各自连通）', async () => {
  const specs = mapOf([...baseSpecs.values(), localBranch]);
  const a = asset({
    main: g(
      [
        n('c1', 'event.custom', { eventName: 'goT' }),
        n('br1', 't.branch', {}, { cond: true }),
        n('mt', 't.mark', { tag: 'T' }),
        n('c2', 'event.custom', { eventName: 'goF' }),
        n('br2', 't.branch', {}, { cond: false }),
        n('mf', 't.mark', { tag: 'F' }),
      ],
      [
        e('e1', 'c1', 'exec', 'br1', 'exec'),
        e('e2', 'br1', 'true', 'mt', 'exec'),
        e('e3', 'c2', 'exec', 'br2', 'exec'),
        e('e4', 'br2', 'false', 'mf', 'exec'),
      ],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('goT');
  rt.emit('goF');
  await tick(60);
  assert.deepEqual(tags(rec), ['T', 'F']);
  rt.stop();
});

/* ============================================================
 * 3. 数据边（执行节点 → 下游）+ 未连线默认值（pinDefaults 覆盖 / spec defaultValue 回落）
 * ============================================================ */

const srcNode: NodeSpec = {
  id: 't.src', title: '源', category: '流程',
  inputs: [execIn], outputs: [execOut, { id: 'v', type: 'int' }],
  run: () => ({ next: 'exec', outputs: { v: 42 } }),
};

const sinkNode: NodeSpec = {
  id: 't.sink', title: '汇', category: '流程',
  inputs: [
    execIn,
    { id: 'w', type: 'int' },
    { id: 'd1', type: 'string', defaultValue: 'spec-def' },
    { id: 'd2', type: 'string', defaultValue: 'spec-def' },
  ],
  outputs: [execOut],
  run: (ctx, inputs) => {
    ctx.print(JSON.stringify(inputs));
    return { next: 'exec', outputs: {} };
  },
};

test('数据边执行节点→下游 + 未连线默认值（pinDefaults 优先，缺省回落 spec defaultValue）', async () => {
  const specs = mapOf([...baseSpecs.values(), srcNode, sinkNode]);
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('s1', 't.src'), n('k1', 't.sink', {}, { d1: 'override' })],
      [e('e1', 'c1', 'exec', 's1', 'exec'), e('e2', 's1', 'exec', 'k1', 'exec'), e('e3', 's1', 'v', 'k1', 'w', 'data')],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  assert.equal(rec.prints.length, 1);
  assert.deepEqual(JSON.parse(String(rec.prints[0].parts[0])), { w: 42, d1: 'override', d2: 'spec-def' });
  rt.stop();
});

/* ============================================================
 * 4. 纯节点链求值（嵌套）+ 同一次求值记忆化
 * ============================================================ */

test('纯节点嵌套求值 + 同一次求值内记忆化（防重复执行）', async () => {
  let counterRuns = 0;
  const counterPure: NodeSpec = {
    id: 't.counter', title: '计数', category: '数学', pure: true,
    inputs: [], outputs: [{ id: 'v', type: 'int' }],
    run: () => ({ outputs: { v: ++counterRuns } }),
  };
  const doublePure: NodeSpec = {
    id: 't.dbl', title: '翻倍', category: '数学', pure: true,
    inputs: [{ id: 'x', type: 'int', defaultValue: 0 }], outputs: [{ id: 'y', type: 'int' }],
    run: (_ctx, inputs) => ({ outputs: { y: (inputs.x as number) * 2 } }),
  };
  const sink3: NodeSpec = {
    id: 't.sink3', title: '汇3', category: '流程',
    inputs: [execIn, { id: 'a', type: 'int' }, { id: 'b', type: 'int' }, { id: 'c', type: 'int' }],
    outputs: [execOut],
    run: (ctx, inputs) => {
      ctx.print(JSON.stringify(inputs));
      return { next: 'exec', outputs: {} };
    },
  };
  const specs = mapOf([...baseSpecs.values(), counterPure, doublePure, sink3]);
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('p', 't.counter'), n('d', 't.dbl'), n('k', 't.sink3')],
      [
        e('e1', 'c1', 'exec', 'k', 'exec'),
        e('d1', 'p', 'v', 'k', 'a', 'data'),
        e('d2', 'p', 'v', 'k', 'b', 'data'),
        e('d3', 'p', 'v', 'd', 'x', 'data'),
        e('d4', 'd', 'y', 'k', 'c', 'data'),
      ],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  // counter 只求值一次（三个消费点记忆化共享），double 求值一次（嵌套纯链）
  assert.equal(counterRuns, 1);
  assert.deepEqual(JSON.parse(String(rec.prints[0].parts[0])), { a: 1, b: 1, c: 2 });
  rt.stop();
});

/* ============================================================
 * 5. exec 边指向纯节点 → 运行时报错（编辑器 T2.8 拦截为主，此处兜底）
 * ============================================================ */

const addPure: NodeSpec = {
  id: 't.add', title: '加', category: '数学', pure: true,
  inputs: [{ id: 'a', type: 'float', defaultValue: 0 }, { id: 'b', type: 'float', defaultValue: 0 }],
  outputs: [{ id: 'y', type: 'float' }],
  run: (_ctx, inputs) => ({ outputs: { y: (inputs.a as number) + (inputs.b as number) } }),
};

test('exec 边指向纯节点：链终止并上报 onError', async () => {
  const specs = mapOf([...baseSpecs.values(), addPure]);
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('p1', 't.add', {}, { a: 1, b: 2 })],
      [e('e1', 'c1', 'exec', 'p1', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0].err.message, /纯节点/);
  assert.equal(rec.errors[0].graph, 'main');
  assert.equal(rec.errors[0].nodeId, 'p1'); // 上下文挂在违规的纯节点上（首抛处优先）
  assert.equal(tags(rec).length, 0); // 纯节点未被当作执行节点跑
  assert.equal(rt.isRunning, true); // 运行实例不受单链错误影响
  rt.stop();
});

/* ============================================================
 * 6. 纯节点数据环检测
 * ============================================================ */

test('纯节点数据链成环：求值抛「循环依赖」', async () => {
  const passthrough: NodeSpec = {
    id: 't.pass', title: '直通', category: '数学', pure: true,
    inputs: [{ id: 'x', type: 'any', optional: true }], outputs: [{ id: 'y', type: 'any' }],
    run: (_ctx, inputs) => ({ outputs: { y: inputs.x } }),
  };
  const specs = mapOf([...baseSpecs.values(), passthrough]);
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('pa', 't.pass'), n('pb', 't.pass'), n('k', 't.printVal')],
      [
        e('e1', 'c1', 'exec', 'k', 'exec'),
        e('d1', 'pb', 'y', 'pa', 'x', 'data'),
        e('d2', 'pa', 'y', 'pb', 'x', 'data'),
        e('d3', 'pa', 'y', 'k', 'v', 'data'),
      ],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  assert.equal(rec.errors.length, 1);
  assert.match(rec.errors[0].err.message, /循环依赖/);
  rt.stop();
});

/* ============================================================
 * 7. flow.call：参数 / 返回 / 嵌套调用
 * ============================================================ */

test('flow.call 参数/返回/嵌套子图调用', async () => {
  const doublePure: NodeSpec = {
    id: 't.dbl', title: '翻倍', category: '数学', pure: true,
    inputs: [{ id: 'x', type: 'float', defaultValue: 0 }], outputs: [{ id: 'y', type: 'float' }],
    run: (_ctx, inputs) => ({ outputs: { y: (inputs.x as number) * 2 } }),
  };
  const specs = mapOf([...baseSpecs.values(), addPure, doublePure]);
  const a = asset(
    {
      main: g(
        [n('c1', 'event.custom', { eventName: 'go' }), n('call1', 'flow.call', { graph: 'outer' }, { x: 3 }), n('p1', 't.printVal')],
        [e('e1', 'c1', 'exec', 'call1', 'exec'), e('e2', 'call1', 'exec', 'p1', 'exec'), e('d1', 'call1', 'r', 'p1', 'v', 'data')],
      ),
      // outer(x) = double(x) + 1 —— 函数内再调函数（嵌套）
      outer: g(
        [n('fe', 'func.entry'), n('call2', 'flow.call', { graph: 'double' }), n('add1', 't.add', {}, { b: 1 }), n('fr', 'func.return')],
        [
          e('e1', 'fe', 'exec', 'call2', 'exec'),
          e('e2', 'call2', 'exec', 'fr', 'exec'),
          e('d1', 'fe', 'x', 'call2', 'x', 'data'),
          e('d2', 'call2', 'r', 'add1', 'a', 'data'),
          e('d3', 'add1', 'y', 'fr', 'r', 'data'),
        ],
        { params: [{ name: 'x', type: 'float' }], returns: [{ name: 'r', type: 'float' }] },
      ),
      double: g(
        [n('fd', 'func.entry'), n('d1', 't.dbl'), n('fdr', 'func.return')],
        [e('e1', 'fd', 'exec', 'fdr', 'exec'), e('d1', 'fd', 'x', 'd1', 'x', 'data'), e('d2', 'd1', 'y', 'fdr', 'r', 'data')],
        { params: [{ name: 'x', type: 'float' }], returns: [{ name: 'r', type: 'float' }] },
      ),
    },
  );
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  // outer(3) = double(3) + 1 = 7
  assert.deepEqual(tags(rec), ['7']);
  rt.stop();
});

/* ============================================================
 * 8. 函数递归深度限制 64
 * ============================================================ */

test('函数递归调用超 64 层被拦截（防栈爆）', async () => {
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('callR', 'flow.call', { graph: 'rec' }), n('m', 't.mark', { tag: 'M' })],
      [e('e1', 'c1', 'exec', 'callR', 'exec'), e('e2', 'callR', 'exec', 'm', 'exec')],
    ),
    rec: g(
      [n('fe', 'func.entry'), n('self', 'flow.call', { graph: 'rec' }), n('fr', 'func.return')],
      [e('e1', 'fe', 'exec', 'self', 'exec'), e('e2', 'self', 'exec', 'fr', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, baseSpecs);
  rt.start();
  rt.emit('go');
  await tick(120);
  assert.ok(rec.errors.length >= 1, '应上报递归超限错误');
  assert.ok(rec.errors.some((x) => /递归/.test(x.err.message)));
  assert.ok(!tags(rec).includes('M'), '外层链应随内层错误终止');
  rt.stop();
});

/* ============================================================
 * 9. callGraph 公共 API（T2.6 接线面）
 * ============================================================ */

test('callGraph 直调函数图并拿到返回值', async () => {
  const specs = mapOf([...baseSpecs.values(), addPure]);
  const a = asset({
    main: g([n('s', 'event.start')], []),
    sum3: g(
      [n('fe', 'func.entry'), n('add', 't.add'), n('fr', 'func.return')],
      [e('e1', 'fe', 'exec', 'fr', 'exec'), e('d1', 'fe', 'a', 'add', 'a', 'data'), e('d2', 'fe', 'b', 'add', 'b', 'data'), e('d3', 'add', 'y', 'fr', 'r', 'data')],
      { params: [{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }], returns: [{ name: 'r', type: 'float' }] },
    ),
  });
  const { rt } = harness(a, specs);
  rt.start();
  assert.deepEqual(await rt.callGraph('sum3', { a: 2, b: 5 }), { r: 7 });
  await assert.rejects(() => rt.callGraph('nope', {}), /不存在/);
  rt.stop();
  await assert.rejects(() => rt.callGraph('sum3', { a: 1, b: 1 }), /未启动/);
});

/* ============================================================
 * 10. delay 异步时序：真实等待且不冻结事件循环（不占事件队列）
 * ============================================================ */

test('delay 异步：真实等待、不阻塞事件循环中的其他定时器', async () => {
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('w', 't.wait', {}, { ms: 40 }), n('m', 't.mark', { tag: 'post' })],
      [e('e1', 'c1', 'exec', 'w', 'exec'), e('e2', 'w', 'done', 'm', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, baseSpecs);
  rt.start();
  const t0 = Date.now();
  // 旁路标记：普通定时器应能在链的 delay 等待期间照常触发（事件循环未被冻结）
  const loopMarks: number[] = [];
  setTimeout(() => loopMarks.push(Date.now()), 5);
  rt.emit('go'); // 同步返回（入队即返）
  await tick(150);
  const post = rec.prints.find((p) => p.parts[0] === 'post');
  assert.ok(post, 'delay 后节点应执行');
  assert.ok(post.at - t0 >= 30, `delay 应真实等待（实际 ${post.at - t0}ms）`);
  assert.ok(loopMarks.length === 1, 'delay 期间事件循环可运行其他定时器');
  assert.ok(loopMarks[0] < post.at, '旁路定时器先于 delay 结束触发');
  rt.stop();
});

/* ============================================================
 * 11. 事件串行保序 + 处理中 emit 排队不递归
 * ============================================================ */

const sendNode: NodeSpec = {
  id: 't.send', title: '发事件', category: '事件',
  inputs: [execIn], outputs: [execOut],
  params: [{ id: 'event', label: '事件名', type: 'string', default: '' }],
  run: (ctx) => {
    ctx.emit(String(ctx.params.event), {});
    return { next: 'exec', outputs: {} };
  },
};

test('事件串行保序；处理中再 emit 只排队不递归', async () => {
  const specs = mapOf([...baseSpecs.values(), sendNode]);
  const a = asset({
    main: g(
      [
        n('c1', 'event.custom', { eventName: 'go' }),
        n('m1', 't.mark', { tag: 'A1' }),
        n('send', 't.send', { event: 'go2' }),
        n('w', 't.wait', {}, { ms: 30 }),
        n('m2', 't.mark', { tag: 'A2' }),
        n('c2', 'event.custom', { eventName: 'go2' }),
        n('mb', 't.mark', { tag: 'B' }),
        n('c3', 'event.custom', { eventName: 'go3' }),
        n('mc', 't.mark', { tag: 'C' }),
      ],
      [
        e('e1', 'c1', 'exec', 'm1', 'exec'),
        e('e2', 'm1', 'exec', 'send', 'exec'),
        e('e3', 'send', 'exec', 'w', 'exec'),
        e('e4', 'w', 'done', 'm2', 'exec'),
        e('e5', 'c2', 'exec', 'mb', 'exec'),
        e('e6', 'c3', 'exec', 'mc', 'exec'),
      ],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  rt.emit('go3'); // 启动前入队：排在 go 之后
  await tick(150);
  // go 的事件链处理中（send 节点）emit 了 go2：go2 必须等 go 整链跑完才执行
  assert.deepEqual(tags(rec), ['A1', 'A2', 'C', 'B']);
  rt.stop();
});

/* ============================================================
 * 12. print 旁路：事件链 await 期间可达（直调回调，不入队）
 * ============================================================ */

test('print 旁路：链 await 期间的打印即时可达（不排队）', async () => {
  const asyncPrinter: NodeSpec = {
    id: 't.asyncPrint', title: '异步打印', category: '流程',
    inputs: [execIn], outputs: [{ id: 'exec', type: 'exec' }],
    run: async (ctx) => {
      ctx.print('during-chain');
      await new Promise((r) => setTimeout(r, 15)); // 链在此 await（队列任务挂起）
      ctx.print('after-await'); // 旁路：不等队列，直接送达
      return { next: 'exec', outputs: {} };
    },
  };
  const specs = mapOf([...baseSpecs.values(), asyncPrinter]);
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('ap', 't.asyncPrint'), n('w', 't.wait', {}, { ms: 20 }), n('m', 't.mark', { tag: 'tail' })],
      [e('e1', 'c1', 'exec', 'ap', 'exec'), e('e2', 'ap', 'exec', 'w', 'exec'), e('e3', 'w', 'done', 'm', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(120);
  const during = rec.prints.find((p) => p.parts[0] === 'during-chain');
  const after = rec.prints.find((p) => p.parts[0] === 'after-await');
  const tail = rec.prints.find((p) => p.parts[0] === 'tail');
  assert.ok(during && after && tail, '三处打印均可达');
  assert.ok(after.at < tail.at, 'await 后的打印先于链尾到达（旁路即时性）');
  rt.stop();
});

/* ============================================================
 * 13. 变量：初值（default / 类型零值 / opts.vars 覆盖）+ var 读写共享存储
 * ============================================================ */

const setVarNode: NodeSpec = {
  id: 't.setVar', title: '写变量', category: '变量',
  inputs: [execIn, { id: 'v', type: 'any', defaultValue: null }], outputs: [execOut],
  params: [{ id: 'name', label: '变量名', type: 'string', default: '' }],
  run: (ctx, inputs) => {
    ctx.setVar(String(ctx.params.name), inputs.v);
    return { next: 'exec', outputs: {} };
  },
};

const getVarNode: NodeSpec = {
  id: 't.getVar', title: '读变量', category: '变量', pure: true,
  inputs: [], outputs: [{ id: 'v', type: 'any' }],
  params: [{ id: 'name', label: '变量名', type: 'string', default: '' }],
  run: (ctx) => ({ outputs: { v: ctx.getVar(String(ctx.params.name)) } }),
};

test('变量初值与读写（default / 零值 / opts.vars 覆盖 / 链内写后读）', async () => {
  const specs = mapOf([...baseSpecs.values(), setVarNode, getVarNode]);
  const a = asset(
    {
      main: g(
        [n('c1', 'event.custom', { eventName: 'go' }), n('sv', 't.setVar', { name: 'score' }, { v: 42 }), n('gv', 't.getVar', { name: 'score' }), n('p', 't.printVal')],
        [e('e1', 'c1', 'exec', 'sv', 'exec'), e('e2', 'sv', 'exec', 'p', 'exec'), e('d1', 'gv', 'v', 'p', 'v', 'data')],
      ),
    },
    { variables: [{ name: 'score', type: 'int', default: 7 }, { name: 'label', type: 'string' }] },
  );
  const { rt, rec } = harness(a, specs, { vars: { score: 99 } });
  // 初值：opts.vars 覆盖 default；未设 default 的 string = 零值 ''；未声明 = undefined
  assert.equal(rt.getVar('score'), 99);
  assert.equal(rt.getVar('label'), '');
  assert.equal(rt.getVar('nope'), undefined);
  rt.start();
  rt.emit('go');
  await tick(60);
  // 链内 set(42) 后经纯节点读回，所有 ctx 共享同一存储
  assert.deepEqual(tags(rec), ['42']);
  assert.equal(rt.getVar('score'), 42);
  rt.setVar('score', 5);
  assert.equal(rt.getVar('score'), 5);
  rt.stop();
});

/* ============================================================
 * 14. 调试探针事件（T5.4 接 WS 的数据面）
 * ============================================================ */

test('调试探针：emit / nodeEnter / pinValue / nodeExit 逐条记录', async () => {
  const a = asset({
    main: g(
      [n('c1', 'event.custom', { eventName: 'go' }), n('s1', 't.src'), n('k1', 't.printVal')],
      [e('e1', 'c1', 'exec', 's1', 'exec'), e('e2', 's1', 'exec', 'k1', 'exec'), e('d1', 's1', 'v', 'k1', 'v', 'data')],
    ),
  });
  const specs = mapOf([...baseSpecs.values(), srcNode]);
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  await tick(60);
  const d = rec.debug;
  assert.ok(d.length > 0);
  assert.ok(d.every((ev) => typeof ev.ts === 'number' && ev.graph === 'main'), '每条带 ts 与 graph');
  const emitEv = d.find((ev) => ev.kind === 'emit' && ev.message === 'go');
  assert.ok(emitEv, 'go 事件出队时发 emit 探针');
  assert.deepEqual(emitEv.value, {});
  const enters = d.filter((ev) => ev.kind === 'nodeEnter').map((ev) => ev.nodeId);
  assert.deepEqual(enters, ['c1', 's1', 'k1']);
  const exits = d.filter((ev) => ev.kind === 'nodeExit').map((ev) => ev.nodeId);
  assert.deepEqual(exits, ['c1', 's1', 'k1']);
  const pin = d.find((ev) => ev.kind === 'pinValue' && ev.nodeId === 's1');
  assert.ok(pin && pin.pinId === 'v' && pin.value === 42, '输出引脚实时值可见');
  rt.stop();
});

/* ============================================================
 * 15. 节点抛错：链终止 + onError 收到 + 队列继续下一事件
 * ============================================================ */

test('节点抛错：链终止、onError 收到、队列继续下一事件', async () => {
  const thrower: NodeSpec = {
    id: 't.throw', title: '抛错', category: '流程',
    inputs: [execIn], outputs: [execOut],
    run: () => {
      throw new Error('boom');
    },
  };
  const specs = mapOf([...baseSpecs.values(), thrower]);
  const a = asset({
    main: g(
      [
        n('c1', 'event.custom', { eventName: 'go' }),
        n('t1', 't.throw'),
        n('m1', 't.mark', { tag: 'never' }),
        n('c2', 'event.custom', { eventName: 'go2' }),
        n('m2', 't.mark', { tag: 'after' }),
      ],
      [e('e1', 'c1', 'exec', 't1', 'exec'), e('e2', 't1', 'exec', 'm1', 'exec'), e('e3', 'c2', 'exec', 'm2', 'exec')],
    ),
  });
  const { rt, rec } = harness(a, specs);
  rt.start();
  rt.emit('go');
  rt.emit('go2');
  await tick(80);
  assert.equal(rec.errors.length, 1);
  assert.equal(rec.errors[0].err.message, 'boom');
  assert.equal(rec.errors[0].graph, 'main');
  assert.equal(rec.errors[0].nodeId, 't1');
  assert.ok(!tags(rec).includes('never'), '抛错节点的后续节点不再执行');
  assert.deepEqual(tags(rec), ['after'], '队列继续处理下一事件');
  assert.ok(rec.debug.some((ev) => ev.kind === 'nodeError' && ev.nodeId === 't1'), 'nodeError 探针可见');
  rt.stop();
});

/* ============================================================
 * 16. 自定义事件路由：event.custom 参数注入（命名 + 位置）+ event.listen args
 * ============================================================ */

test('emit 路由：event.custom 命名/位置参数注入 + event.listen args 注入', async () => {
  const a = asset(
    {
      main: g(
        [
          n('c1', 'event.custom', { eventName: 'loaded' }),
          n('p1', 't.printVal'),
          n('p2', 't.printVal'),
          n('c2', 'event.custom'),
          n('p3', 't.printVal'),
          n('l1', 'event.listen', {}, { eventName: 'loaded' }),
          n('p4', 't.printVal'),
        ],
        [
          e('e1', 'c1', 'exec', 'p1', 'exec'),
          e('e2', 'p1', 'exec', 'p2', 'exec'),
          e('d1', 'c1', 'count', 'p1', 'v', 'data'),
          e('d2', 'c1', 'arg0', 'p2', 'v', 'data'),
          e('e3', 'c2', 'exec', 'p3', 'exec'),
          e('d3', 'c2', 'tag', 'p3', 'v', 'data'),
          e('e4', 'l1', 'exec', 'p4', 'exec'),
          e('d4', 'l1', 'args', 'p4', 'v', 'data'),
        ],
      ),
    },
    { events: [{ name: 'loaded', params: [{ name: 'count', type: 'int' }, { name: 'tag', type: 'string' }] }] },
  );
  // c2 无 params.eventName：靠 title 回退绑定（title 覆盖为事件名）
  a.graphs.main.nodes[3].title = 'loaded';
  const { rt, rec } = harness(a, baseSpecs);
  rt.start();
  rt.emit('loaded', { count: 3, tag: 'x' });
  await tick(80);
  const parts = rec.prints.map((p) => p.parts[0]);
  assert.equal(parts[0], 3, '命名参数 count 注入输出脚');
  assert.equal(parts[1], 3, '位置参数 arg0 注入占位脚');
  assert.equal(parts[2], 'x', 'title 回退绑定的入口同样触发');
  assert.deepEqual(parts[3], { count: 3, tag: 'x' }, 'listen 注入 args 对象');
  rt.stop();
});

/* ============================================================
 * 17. 集成：@/nodes 内置节点库跑「event.start → branch → var.set → print」
 * ============================================================ */

test('集成（builtinSpecMap）：event.start → var.get → branch → var.set → print 协议咬合', async () => {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset(
      {
        main: g(
          [
            n('n1', 'event.start'),
            n('n2', 'var.get', { varName: 'flag' }), // 纯节点：读初值 true
            n('n3', 'flow.branch'), // cond ← n2.value
            n('n4', 'var.set', { varName: 'flag' }, { value: false }), // true 支路：写 false
            n('n6', 'system.print'), // 打印 var.set 透传值
            n('n7', 'var.get', { varName: 'flag' }), // 纯节点：读回 false
            n('n8', 'system.print'), // 打印读回值
          ],
          [
            e('e1', 'n1', 'exec', 'n3', 'exec'),
            e('d1', 'n2', 'value', 'n3', 'cond', 'data'),
            e('e2', 'n3', 'true', 'n4', 'exec'),
            e('e3', 'n4', 'exec', 'n6', 'exec'),
            e('d2', 'n4', 'value', 'n6', 'value', 'data'),
            e('e4', 'n6', 'exec', 'n8', 'exec'),
            e('d3', 'n7', 'value', 'n8', 'value', 'data'),
          ],
        ),
      },
      { variables: [{ name: 'flag', type: 'bool', default: true }] },
    ),
    builtinSpecMap,
    {
      onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start(); // start 事件直接驱动（无需 emit）
  await tick(80);
  assert.equal(rec.errors.length, 0, `不应有错误：${JSON.stringify(rec.errors)}`);
  assert.deepEqual(rec.prints.map((p) => p.parts[0]), [false, false]);
  assert.equal(rt.getVar('flag'), false);
  const enters = rec.debug.filter((ev) => ev.kind === 'nodeEnter').map((ev) => ev.nodeId);
  assert.deepEqual(enters, ['n1', 'n3', 'n2', 'n4', 'n6', 'n8', 'n7']);
  rt.stop();
});

/* ============================================================
 * 18. stop 复位状态机（clearAllStateSlots，ADR-005）：forLoop 中断后重跑从零开始
 * ============================================================ */

test('stop 后 clearAllStateSlots 复位：forLoop 重跑从头迭代', async () => {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset({
      main: g(
        [
          n('n1', 'event.start'),
          n('n2', 'flow.forLoop', {}, { from: 0, to: 5, step: 1 }),
          n('n3', 'flow.delay', {}, { seconds: 0.1 }), // 循环体带延时：给 stop 留出中断窗口
          n('n4', 'system.print'), // 打印 index，链尾回连 forLoop
        ],
        [
          e('e1', 'n1', 'exec', 'n2', 'exec'),
          e('e2', 'n2', 'body', 'n3', 'exec'),
          e('e3', 'n3', 'done', 'n4', 'exec'),
          e('e4', 'n4', 'exec', 'n2', 'exec'), // 链尾回连：循环状态机驱动
          e('d1', 'n2', 'index', 'n4', 'value', 'data'),
        ],
      ),
    }),
    builtinSpecMap,
    {
      onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start();
  await tick(150); // 约完成第 1 次迭代（index 0），第 2 次迭代挂在 delay 上
  rt.stop();
  const firstRun = rec.prints.map((p) => String(p.parts[0]));
  assert.ok(firstRun.every((t) => t === '0'), `第一轮最多推进到 index 0（实际 ${JSON.stringify(firstRun)}）`);
  rec.prints.length = 0;
  rec.debug.length = 0;
  rt.start(); // 重跑：若 stop 未复位状态槽，forLoop 会从 index≥1 续跑
  await tick(900);
  const secondRun = rec.prints.map((p) => String(p.parts[0]));
  assert.deepEqual(secondRun, ['0', '1', '2', '3', '4', '5'], `重跑应从 0 重新迭代（实际 ${JSON.stringify(secondRun)}）`);
  assert.equal(rec.errors.length, 0, `stop 引发的 AbortError 不应上报：${JSON.stringify(rec.errors)}`);
  rt.stop();
});

/* ============================================================
 * ADR-008：多次出脚（async generator）集成
 * ============================================================ */

test('ADR-008 集成：forLoop 一次触发跑完迭代（无回连边，UE5 语义）', async () => {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset({
      main: g(
        [
          n('n1', 'event.start'),
          n('n2', 'flow.forLoop', {}, { from: 0, to: 4, step: 1 }),
          n('n3', 'system.print'),
        ],
        [
          e('e1', 'n1', 'exec', 'n2', 'exec'),
          e('e2', 'n2', 'body', 'n3', 'exec'), // 循环体 → 打印（链尾不回连）
          e('d1', 'n2', 'index', 'n3', 'value', 'data'),
        ],
      ),
    }),
    builtinSpecMap,
    {
      onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start();
  await tick(200);
  rt.stop();
  const outs = rec.prints.map((p) => String(p.parts[0]));
  assert.deepEqual(outs, ['0', '1', '2', '3', '4'], `一次触发应跑完全部迭代（实际 ${JSON.stringify(outs)}）`);
  assert.equal(rec.errors.length, 0, `不应有错误：${JSON.stringify(rec.errors)}`);
});

test('ADR-008 集成：timer loop 自动持续 tick（无需回连）', async () => {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset({
      main: g(
        [
          n('n1', 'event.start'),
          n('n2', 'event.timer', {}, { interval: 0.05, loop: true }),
          n('n3', 'system.print'),
        ],
        [
          e('e1', 'n1', 'exec', 'n2', 'exec'),
          e('e2', 'n2', 'tick', 'n3', 'exec'), // tick → 打印（链尾不回连）
          e('d1', 'n2', 'ticks', 'n3', 'value', 'data'),
        ],
      ),
    }),
    builtinSpecMap,
    {
      onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start();
  await tick(280); // interval 50ms → 应收到 ≥3 次 tick
  rt.stop();
  await tick(20);
  const outs = rec.prints.map((p) => Number(p.parts[0]));
  assert.ok(outs.length >= 3, `应持续 tick ≥3 次（实际 ${JSON.stringify(outs)}）`);
  assert.ok(outs.every((v, i) => v === i + 1), `ticks 应从 1 递增（实际 ${JSON.stringify(outs)}）`);
  assert.equal(rec.errors.length, 0);
});

test('ADR-008 集成：forLoop 循环体内再触发自身被忽略（旧回连边 = no-op，不死循环）', async () => {
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset({
      main: g(
        [
          n('n1', 'event.start'),
          n('n2', 'flow.forLoop', {}, { from: 0, to: 2, step: 1 }),
          n('n3', 'system.print'),
        ],
        [
          e('e1', 'n1', 'exec', 'n2', 'exec'),
          e('e2', 'n2', 'body', 'n3', 'exec'),
          e('e3', 'n3', 'exec', 'n2', 'exec'), // 旧语义回连边：新语义下应为 no-op
          e('d1', 'n2', 'index', 'n3', 'value', 'data'),
        ],
      ),
    }),
    builtinSpecMap,
    {
      onPrint: (...parts) => rec.prints.push({ at: Date.now(), parts }),
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start();
  await tick(200);
  rt.stop();
  const outs = rec.prints.map((p) => String(p.parts[0]));
  assert.deepEqual(outs, ['0', '1', '2'], `回连边应被忽略、迭代不受干扰（实际 ${JSON.stringify(outs)}）`);
  assert.equal(rec.errors.length, 0);
});

test('ADR-008 集成：有限 generator 超 maxSteps 视为死循环（unlimitedFires 豁免 timer）', async () => {
  // 本地最小 spec：有限 generator 连续 yield 50 次（maxStepsPerChain=10 → 应在第 11 次抛死循环）
  const finite: NodeSpec = {
    id: 'test.finite', title: '有限', category: '流程',
    inputs: [{ id: 'exec', type: 'exec' }],
    outputs: [{ id: 'out', type: 'exec' }],
    run: async function* () {
      for (let i = 0; i < 50; i++) yield { next: 'out', outputs: {} };
    },
  };
  const rec: Recordings = { prints: [], errors: [], debug: [] };
  const rt = createRuntime(
    asset({
      main: g([n('n1', 'event.start'), n('n2', 'test.finite')], [e('e1', 'n1', 'exec', 'n2', 'exec')]),
    }),
    mapOf([evStart, finite]),
    {
      maxStepsPerChain: 10,
      onPrint: () => {},
      onError: (err, graph, nodeId) => rec.errors.push({ at: Date.now(), err, graph, nodeId }),
      onDebug: (ev) => rec.debug.push(ev),
    },
  );
  rt.start();
  await tick(80);
  rt.stop();
  assert.equal(rec.errors.length, 1, '有限 generator 超限应上报死循环错误');
  assert.ok(rec.errors[0]!.err.message.includes('死循环'), `错误应含死循环提示：${rec.errors[0]!.err.message}`);
});
