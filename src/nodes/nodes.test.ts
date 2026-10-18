/**
 * Blueprint Studio v2 —— 基础节点库单测（node:test，T13.1）
 *
 * 覆盖：注册表完整性、规范化决策、branch / forLoop / forEach / delay /
 * var.get+set / math / string.format / array.sort 稳定性 / map.* /
 * convert（含 androidLogParse 两种格式 + 失败行）/ ui.* mock ctx /
 * event.send mock ctx.emit / timer / system 钩子降级。
 *
 * 循环状态机节点的测法：连续调用 run 模拟「链尾回连 exec 入」的再触发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeRunContext, NodeRunResult, PinSpec } from '../ir/types';
import {
  builtinSpecs,
  builtinSpecMap,
  NODE_CATEGORIES,
  clearAllStateSlots,
  listReflectableProps,
  reflectionEntries,
} from './index';

/* ============================================================
 * Mock：NodeRunContext 与运行帮助
 * ============================================================ */

interface CtxExtras {
  logs: string[];
  emitted: { event: string; params?: Record<string, unknown> }[];
  vars: Map<string, unknown>;
}

type MockCtx = NodeRunContext & CtxExtras;

interface UiMock {
  find(name: string): unknown;
  read(name: string, attr: string): unknown;
  write(name: string, attr: string, value: unknown): void;
}

interface UiMockRecorder {
  ui: UiMock;
  writes: { name: string; attr: string; value: unknown }[];
  reads: { name: string; attr: string }[];
}

function makeUiMock(nodes: Record<string, Record<string, unknown>>): UiMockRecorder {
  const writes: UiMockRecorder['writes'] = [];
  const reads: UiMockRecorder['reads'] = [];
  return {
    writes,
    reads,
    ui: {
      find: (name) => (name in nodes ? { name, ...nodes[name] } : null),
      read: (name, attr) => {
        reads.push({ name, attr });
        return nodes[name]?.[attr];
      },
      write: (name, attr, value) => {
        writes.push({ name, attr, value });
      },
    },
  };
}

let ctxSeq = 0;

function makeCtx(opts: {
  params?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  ui?: UiMockRecorder | null;
  hooks?: Record<string, unknown>;
  /** mock delay 是否真实等待（默认真实） */
  realDelay?: boolean;
} = {}): MockCtx {
  ctxSeq += 1;
  const logs: string[] = [];
  const emitted: CtxExtras['emitted'] = [];
  const vars = new Map<string, unknown>(Object.entries(opts.vars ?? {}));
  const delay = opts.realDelay === false
    ? async () => undefined
    : (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const ctx = {
    nodeId: `test_${ctxSeq}`,
    params: opts.params ?? {},
    getVar: (name: string) => vars.get(name),
    setVar: (name: string, value: unknown) => {
      vars.set(name, value);
    },
    emit: (event: string, params?: Record<string, unknown>) => {
      emitted.push({ event, params });
    },
    print: (...parts: unknown[]) => {
      logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p) ?? String(p))).join(' '));
    },
    delay,
    signal: new AbortController().signal,
    logs,
    emitted,
    vars,
  } as MockCtx;
  if (opts.ui) (ctx as unknown as Record<string, unknown>).ui = opts.ui.ui;
  if (opts.hooks) {
    for (const [k, v] of Object.entries(opts.hooks)) (ctx as unknown as Record<string, unknown>)[k] = v;
  }
  return ctx;
}

/** 同步/单出口节点运行助手（断言结果不是 generator；generator 节点用 runGen） */
async function run(
  id: string,
  ctx: NodeRunContext,
  inputs: Record<string, unknown> = {},
): Promise<NodeRunResult> {
  const s = builtinSpecMap.get(id);
  assert.ok(s, `节点 ${id} 未注册`);
  assert.ok(s.run, `节点 ${id} 缺少 run 实现`);
  const out: unknown = await s.run(ctx, inputs);
  assert.ok(
    !(out && typeof out === 'object' && Symbol.asyncIterator in (out as object)),
    `节点 ${id} 返回了 async generator——请用 runGen（ADR-008）`,
  );
  return out as NodeRunResult;
}

/** ADR-008 多次出脚节点运行助手（断言返回 generator） */
async function runGen(
  id: string,
  ctx: NodeRunContext,
  inputs: Record<string, unknown> = {},
): Promise<AsyncGenerator<NodeRunResult, void, unknown>> {
  const s = builtinSpecMap.get(id);
  assert.ok(s, `节点 ${id} 未注册`);
  assert.ok(s.run, `节点 ${id} 缺少 run 实现`);
  const out: unknown = await s.run(ctx, inputs);
  assert.ok(
    !!out && typeof out === 'object' && Symbol.asyncIterator in (out as object),
    `节点 ${id} 未返回 async generator（ADR-008）`,
  );
  return out as AsyncGenerator<NodeRunResult, void, unknown>;
}

/** ADR-008：收干多次出脚节点（async generator）的全部产出（单测辅助，仅限有限产出节点） */
async function drain(
  gen: AsyncGenerator<NodeRunResult, void, unknown>,
): Promise<{ next?: string; outputs: Record<string, unknown> }[]> {
  const fires: { next?: string; outputs: Record<string, unknown> }[] = [];
  for await (const r of gen) fires.push({ next: r.next, outputs: r.outputs ?? {} });
  return fires;
}

/* ============================================================
 * 注册表完整性与规范化决策
 * ============================================================ */

test('注册表：全部内置节点 id 唯一且元数据齐全', () => {
  assert.ok(builtinSpecs.length >= 70, `内置节点应 ≥70，实际 ${builtinSpecs.length}`);
  assert.equal(builtinSpecMap.size, builtinSpecs.length, 'builtinSpecMap 不应有重复 id');
  for (const s of builtinSpecs) {
    assert.ok(s.id.includes('.'), `节点 id 应为 分类.名称：${s.id}`);
    assert.ok(s.title.length > 0, `${s.id} 缺 title`);
    assert.ok(NODE_CATEGORIES.includes(s.category as never), `${s.id} 分类非法：${s.category}`);
    assert.ok(s.keywords && s.keywords.length > 0, `${s.id} 缺 keywords`);
    assert.ok(s.doc && s.doc.length > 0, `${s.id} 缺 doc`);
    assert.ok(Array.isArray(s.inputs) && Array.isArray(s.outputs), `${s.id} 引脚缺失`);
    assert.ok(s.run, `${s.id} 缺 run`);
  }
});

test('规范化决策：exec 引脚显式 type=exec；select 引脚=string+options；纯节点无 exec', () => {
  const pins = (s: (typeof builtinSpecs)[number]): PinSpec[] => [...s.inputs, ...s.outputs];
  for (const s of builtinSpecs) {
    for (const p of pins(s)) {
      assert.notEqual(p.type, 'number', `${s.id}.${p.id} 禁用 number 类型（应 int/float）`);
      if (p.id === 'exec' || p.label === undefined) {
        // exec 引脚必须显式声明 'exec' 类型
        if (p.id === 'exec') assert.equal(p.type, 'exec', `${s.id}.${p.id} 应为 exec 类型`);
      }
      assert.notEqual(p.type, 'select', `${s.id}.${p.id} select 不是值类型（应为 string+options）`);
      if (p.options) assert.ok(p.options.every((o) => typeof o.value === 'string' && typeof o.label === 'string'));
    }
    if (s.pure) {
      assert.ok(!pins(s).some((p) => p.type === 'exec'), `纯节点 ${s.id} 不得有 exec 引脚`);
    }
    // 纯节点全部声明 pure: true（math/string 等）
    if (s.id.startsWith('math.') || s.id.startsWith('string.')) assert.equal(s.pure, true, `${s.id} 应为纯节点`);
  }
});

test('分类统计：九大分类各有节点', () => {
  const counts = new Map<string, number>();
  for (const s of builtinSpecs) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  for (const c of NODE_CATEGORIES) {
    assert.ok((counts.get(c) ?? 0) > 0, `分类 ${c} 没有节点`);
  }
});

/* ============================================================
 * flow
 * ============================================================ */

test('flow.branch：真假两分支与缺省', async () => {
  const ctx = makeCtx();
  assert.equal((await run('flow.branch', ctx, { cond: true })).next, 'true');
  assert.equal((await run('flow.branch', ctx, { cond: false })).next, 'false');
  assert.equal((await run('flow.branch', ctx, {})).next, 'false');
});

test('flow.forLoop：一次触发跑完全部迭代（ADR-008，无需回连）', async () => {
  const ctx = makeCtx();
  const fires = await drain(await runGen('flow.forLoop', ctx, { from: 0, to: 4 }));
  assert.equal(fires.length, 6, '5 次 body + 1 次 done');
  assert.deepEqual(
    fires.slice(0, 5).map((f) => f.outputs.index),
    [0, 1, 2, 3, 4],
  );
  assert.equal(fires[5]!.next, 'done');

  // 负步长：5..3 递减
  const ctx3 = makeCtx();
  const down = await drain(await runGen('flow.forLoop', ctx3, { from: 5, to: 3, step: -1 }));
  assert.equal(down.length, 4);
  assert.deepEqual(down.slice(0, 3).map((f) => f.outputs.index), [5, 4, 3]);
  assert.equal(down[3]!.next, 'done');

  // 起点越界：直接 done
  const ctx4 = makeCtx();
  const empty = await drain(await runGen('flow.forLoop', ctx4, { from: 5, to: 3 }));
  assert.equal(empty.length, 1);
  assert.equal(empty[0]!.next, 'done');

  // break 每迭代重估：首迭代后 reinputs 返回 break=true → 提前 done（ADR-008 动态 break）
  let calls = 0;
  const ctx5 = makeCtx({
    hooks: {
      reinputs: async () => {
        calls += 1;
        return { break: calls >= 1 };
      },
    },
  });
  const early = await drain(await runGen('flow.forLoop', ctx5, { from: 0, to: 9 }));
  assert.equal(early[0]!.next, 'body');
  assert.equal(early[0]!.outputs.index, 0);
  assert.equal(early[1]!.next, 'done', '首迭代后 break 重估为真 → 提前结束');
});

test('flow.delay：异步等待后走完成口', async () => {
  const ctx = makeCtx();
  const r = await run('flow.delay', ctx, { seconds: 0.01 });
  assert.equal(r.next, 'done');
});

test('flow.doOnce / flipFlop / multiGate / gate / whileLoop / sequence', async () => {
  clearAllStateSlots();
  // doOnce：首次通过，后续拦截，reset 复位
  const c1 = makeCtx();
  assert.equal((await run('flow.doOnce', c1)).next, 'out');
  assert.equal((await run('flow.doOnce', c1)).next, 'blocked');
  await run('flow.doOnce', c1, { reset: true });
  assert.equal((await run('flow.doOnce', c1)).next, 'out');

  // flipFlop：A/B 交替 + isA
  const c2 = makeCtx();
  const f1 = await run('flow.flipFlop', c2);
  const f2 = await run('flow.flipFlop', c2);
  const f3 = await run('flow.flipFlop', c2);
  assert.equal(f1.next, 'a');
  assert.equal(f2.next, 'b');
  assert.equal(f3.next, 'a');
  assert.equal(f1.outputs.isA, true);
  assert.equal(f2.outputs.isA, false);

  // multiGate：out0→out3 轮转，loop 默认循环
  const c3 = makeCtx();
  const seq: (string | undefined)[] = [];
  for (let i = 0; i < 6; i++) seq.push((await run('flow.multiGate', c3, { loop: true })).next);
  assert.deepEqual(seq, ['out0', 'out1', 'out2', 'out3', 'out0', 'out1']);
  // 非循环模式：走完后吞掉触发
  clearAllStateSlots();
  const c3b = makeCtx();
  const seqB: (string | undefined)[] = [];
  for (let i = 0; i < 5; i++) seqB.push((await run('flow.multiGate', c3b, { loop: false })).next);
  assert.deepEqual(seqB, ['out0', 'out1', 'out2', 'out3', undefined]);

  // gate：数据引脚驱动通断
  const c4 = makeCtx();
  assert.equal((await run('flow.gate', c4, { open: true })).next, 'out');
  assert.equal((await run('flow.gate', c4, { open: false })).next, 'closed');

  // whileLoop（ADR-008）：条件假直接 done；条件真每迭代重估，动态变假后退出
  const c5 = makeCtx();
  const doneFire = await drain(await runGen('flow.whileLoop', c5, { cond: false }));
  assert.equal(doneFire.length, 1);
  assert.equal(doneFire[0]!.next, 'done');

  let round = 0;
  const c5c = makeCtx({
    hooks: {
      reinputs: async () => {
        round += 1;
        return { cond: round < 3, break: false };
      },
    },
  });
  const looped = await drain(await runGen('flow.whileLoop', c5c, { cond: true, break: false }));
  assert.deepEqual(looped.map((f) => f.next), ['body', 'body', 'body', 'done'], '条件每迭代重估：真3次（启动+2次重估）后退出');

  // sequence（ADR-008）：一次触发按序 out0→out3，无需回连
  const c6 = makeCtx();
  const seqFires = await drain(await runGen('flow.sequence', c6));
  assert.deepEqual(seqFires.map((f) => f.next), ['out0', 'out1', 'out2', 'out3']);
});

/* ============================================================
 * variables
 * ============================================================ */

test('var.get / var.set：经 ctx.getVar/setVar 读写', async () => {
  const ctx = makeCtx({ params: { varName: 'count' }, vars: { count: 5 } });
  const r = await run('var.set', ctx, { value: 42 });
  assert.equal(r.next, 'exec');
  assert.equal(r.outputs.value, 42);
  assert.equal(ctx.vars.get('count'), 42);

  const g = await run('var.get', ctx, {});
  assert.equal(g.outputs.value, 42);
  // 未声明变量 → null
  const g2 = await run('var.get', makeCtx({ params: { varName: 'nope' } }));
  assert.equal(g2.outputs.value, null);
});

/* ============================================================
 * math / string 抽样
 * ============================================================ */

test('math：四则（含除零保护）、比较、逻辑、取整、钳制', async () => {
  const ctx = makeCtx();
  assert.equal((await run('math.add', ctx, { a: 2, b: 3 })).outputs.value, 5);
  assert.equal((await run('math.sub', ctx, { a: 2.5, b: 0.5 })).outputs.value, 2);
  assert.equal((await run('math.mul', ctx, { a: 3, b: 4 })).outputs.value, 12);
  assert.equal((await run('math.div', ctx, { a: 6, b: 0 })).outputs.value, 0);
  assert.equal((await run('math.div', ctx, { a: 7, b: 2 })).outputs.value, 3.5);
  assert.equal((await run('math.mod', ctx, { a: 7, b: 3 })).outputs.value, 1);
});

test('math.compare：op 六种比较符', async () => {
  const c1 = makeCtx({ params: { op: '==' } });
  assert.equal((await run('math.compare', c1, { a: 5, b: 5 })).outputs.value, true);
  const c2 = makeCtx({ params: { op: '>=' } });
  assert.equal((await run('math.compare', c2, { a: 5, b: 4 })).outputs.value, true);
  const c3 = makeCtx({ params: { op: '<' } });
  assert.equal((await run('math.compare', c3, { a: '10', b: '9' })).outputs.value, true); // 字典序
  const c4 = makeCtx({ params: { op: '!=' } });
  assert.equal((await run('math.compare', c4, { a: 1, b: 2 })).outputs.value, true);
});

test('math：逻辑 / 随机固定区间 / 取整 / 钳制 / 最值', async () => {
  const ctx = makeCtx();
  assert.equal((await run('math.and', ctx, { a: true, b: false })).outputs.value, false);
  assert.equal((await run('math.or', ctx, { a: true, b: false })).outputs.value, true);
  assert.equal((await run('math.not', ctx, { a: true })).outputs.value, false);
  const rnd = (await run('math.random', ctx, { min: 5, max: 5 })).outputs.value as number;
  assert.equal(rnd, 5);
  assert.equal((await run('math.floor', ctx, { value: 2.7 })).outputs.value, 2);
  assert.equal((await run('math.ceil', ctx, { value: 2.1 })).outputs.value, 3);
  assert.equal((await run('math.round', ctx, { value: 2.5 })).outputs.value, 3);
  assert.equal((await run('math.clamp', ctx, { value: 5, min: 0, max: 3 })).outputs.value, 3);
  assert.equal((await run('math.min', ctx, { a: 1, b: 2 })).outputs.value, 1);
  assert.equal((await run('math.max', ctx, { a: 1, b: 2 })).outputs.value, 2);
  assert.equal((await run('math.abs', ctx, { a: -3 })).outputs.value, 3);
});

test('string.format：{0}{1} 占位 + 参数数组（multi）', async () => {
  const ctx = makeCtx();
  const r = await run('string.format', ctx, { template: '{0} 用了 {1}ms', args: ['编译', 123] });
  assert.equal(r.outputs.value, '编译 用了 123ms');
  const r2 = await run('string.format', ctx, { template: '{0}-{9}', args: ['a'] });
  assert.equal(r2.outputs.value, 'a-');
});

test('string：concat/split/replace/contains/length/trim/upper/lower/regex', async () => {
  const ctx = makeCtx();
  assert.equal((await run('string.concat', ctx, { a: 'ab', b: 'cd' })).outputs.value, 'abcd');
  assert.deepEqual((await run('string.split', ctx, { value: 'a,b,c', sep: ',' })).outputs.value, ['a', 'b', 'c']);
  assert.equal((await run('string.replace', ctx, { value: 'aXa', from: 'X', to: 'Y' })).outputs.value, 'aYa');
  assert.equal((await run('string.contains', ctx, { value: 'hello', search: 'ell' })).outputs.value, true);
  assert.equal((await run('string.length', ctx, { value: '日志' })).outputs.value, 2);
  assert.equal((await run('string.trim', ctx, { value: '  x ' })).outputs.value, 'x');
  assert.equal((await run('string.upper', ctx, { value: 'ab' })).outputs.value, 'AB');
  assert.equal((await run('string.lower', ctx, { value: 'AB' })).outputs.value, 'ab');
  assert.equal((await run('string.regexMatch', ctx, { value: 'e1=x', pattern: 'e\\d' })).outputs.value, true);
  assert.equal(
    (await run('string.regexExtract', ctx, { value: 'err x=42 y=7', pattern: 'x=(\\d+)', group: 1 })).outputs.value,
    '42',
  );
  assert.equal(
    (await run('string.regexExtract', ctx, { value: 'no match', pattern: 'x=(\\d+)', group: 1 })).outputs.value,
    '',
  );
});

/* ============================================================
 * container
 * ============================================================ */

test('array.make：尾部未连线输入自动省略', async () => {
  const ctx = makeCtx();
  const r = await run('array.make', ctx, { in0: 'a', in1: 'b', in2: undefined, in3: undefined, in4: undefined });
  assert.deepEqual(r.outputs.array, ['a', 'b']);
});

test('array.get/set/push：越界默认值与纯语义（不改原数组）', async () => {
  const ctx = makeCtx();
  const src = [1, 2, 3];
  assert.equal((await run('array.get', ctx, { array: src, index: 1 })).outputs.value, 2);
  assert.equal((await run('array.get', ctx, { array: src, index: 9, default: 'x' })).outputs.value, 'x');
  const s = await run('array.set', ctx, { array: src, index: 0, value: 99 });
  assert.deepEqual(s.outputs.array, [99, 2, 3]);
  assert.deepEqual(src, [1, 2, 3], '原数组不得被修改');
  const p = await run('array.push', ctx, { array: src, value: 4 });
  assert.deepEqual(p.outputs.array, [1, 2, 3, 4]);
  assert.deepEqual(src, [1, 2, 3]);
  assert.equal((await run('array.length', ctx, { array: src })).outputs.value, 3);
});

test('array.forEach：一次触发遍历完 + break 动态重估（ADR-008）', async () => {
  const ctx = makeCtx();
  const fires = await drain(await runGen('array.forEach', ctx, { array: ['x', 'y', 'z'] }));
  const bodies = fires.filter((f) => f.next === 'body');
  assert.deepEqual(bodies.map((f) => f.outputs.element), ['x', 'y', 'z']);
  assert.deepEqual(bodies.map((f) => f.outputs.index), [0, 1, 2]);
  assert.equal(fires[fires.length - 1].next, 'done');

  // 空数组：直接 done
  const ctx2 = makeCtx();
  const empty = await drain(await runGen('array.forEach', ctx2, { array: [] }));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].next, 'done');

  // break 启动时为真：直接 done（无 body）
  const ctx3 = makeCtx();
  const early = await drain(await runGen('array.forEach', ctx3, { array: [1, 2, 3], break: true }));
  assert.equal(early.length, 1);
  assert.equal(early[0].next, 'done');

  // break 每迭代重估：首迭代后 break 变真 → 提前 done
  let round = 0;
  const ctx4 = makeCtx({
    hooks: {
      reinputs: async () => {
        round += 1;
        return { break: round >= 1 };
      },
    },
  });
  const dynamic = await drain(await runGen('array.forEach', ctx4, { array: [1, 2, 3] }));
  assert.equal(dynamic.filter((f) => f.next === 'body').length, 1, '首迭代后 break 重估为真 → 仅 1 次 body');
  assert.equal(dynamic[dynamic.length - 1].next, 'done');
});

test('array.filter / pluck：字段条件过滤与字段提取', async () => {
  const ctx = makeCtx();
  const items = [
    { level: 'W', msg: 'a' },
    { level: 'E', msg: 'b' },
    { level: 'W', msg: 'c' },
  ];
  const f = await run('array.filter', ctx, { array: items, field: 'level', value: 'W' }, );
  assert.deepEqual(f.outputs.array, [items[0], items[2]]);
  const p = await run('array.pluck', ctx, { array: items, field: 'msg' });
  assert.deepEqual(p.outputs.array, ['a', 'b', 'c']);
});

test('array.sort：稳定排序（相等元素保持原顺序）', async () => {
  const ctx = makeCtx({ params: { order: 'asc' } });
  const items = [
    { k: 'b', i: 1 },
    { k: 'a', i: 2 },
    { k: 'a', i: 1 },
    { k: 'c', i: 9 },
  ];
  const r = await run('array.sort', ctx, { array: items, key: 'k' });
  assert.deepEqual(r.outputs.array, [
    { k: 'a', i: 2 },
    { k: 'a', i: 1 },
    { k: 'b', i: 1 },
    { k: 'c', i: 9 },
  ]);
  assert.deepEqual(items.map((x) => x.i), [1, 2, 1, 9], '原数组不得被修改');
});

test('map.get/set/has/keys', async () => {
  const ctx = makeCtx();
  const m = { a: 1 };
  assert.equal((await run('map.get', ctx, { map: m, key: 'a' })).outputs.value, 1);
  assert.equal((await run('map.get', ctx, { map: m, key: 'z', default: 7 })).outputs.value, 7);
  const s = await run('map.set', ctx, { map: m, key: 'b', value: 2 });
  assert.deepEqual(s.outputs.map, { a: 1, b: 2 });
  assert.deepEqual(m, { a: 1 });
  assert.equal((await run('map.has', ctx, { map: m, key: 'a' })).outputs.value, true);
  assert.equal((await run('map.has', ctx, { map: m, key: 'z' })).outputs.value, false);
  assert.deepEqual((await run('map.keys', ctx, { map: m })).outputs.keys, ['a']);
});

/* ============================================================
 * convert
 * ============================================================ */

test('convert：toNumber/toString/toBool/parseInt/json', async () => {
  const ctx = makeCtx();
  assert.equal((await run('convert.toNumber', ctx, { value: '3.14' })).outputs.value, 3.14);
  assert.equal((await run('convert.toNumber', ctx, { value: 'abc' })).outputs.value, 0);
  assert.equal((await run('convert.toNumber', ctx, { value: true })).outputs.value, 1);
  assert.equal((await run('convert.toString', ctx, { value: null })).outputs.value, '');
  assert.equal((await run('convert.toBool', ctx, { value: 'yes' })).outputs.value, true);
  assert.equal((await run('convert.toBool', ctx, { value: 0 })).outputs.value, false);
  assert.equal((await run('convert.parseInt', ctx, { value: '12abc' })).outputs.value, 12);
  assert.deepEqual((await run('convert.jsonParse', ctx, { value: '{"a":1}' })).outputs.value, { a: 1 });
  assert.equal((await run('convert.jsonParse', ctx, { value: 'nope' })).outputs.value, null);
  assert.equal((await run('convert.jsonStringify', ctx, { value: { a: 1 } })).outputs.value, '{\n  "a": 1\n}');
});

test('convert.timeFormat：令牌 YYYY/MM/DD/HH/mm/SS', async () => {
  const ctx = makeCtx({ params: { format: 'YYYY-MM-DD HH:mm:SS' } });
  const d = new Date(2026, 9, 17, 8, 9, 5);
  const r = await run('convert.timeFormat', ctx, { epoch: d.getTime() });
  assert.equal(r.outputs.value, '2026-10-17 08:09:05');
  // 默认格式 MM-DD HH:mm:SS
  const c2 = makeCtx();
  const r2 = await run('convert.timeFormat', c2, { epoch: d.getTime() });
  assert.equal(r2.outputs.value, '10-17 08:09:05');
});

test('convert.androidLogParse：logcat -v time 格式', async () => {
  const ctx = makeCtx();
  const line = '10-17 14:23:01.123 D/MyTag( 1234): hello world';
  const r = await run('convert.androidLogParse', ctx, { lines: line });
  const rows = r.outputs.rows as { ts: number; level: string; tag: string; pid: number; msg: string; raw: string }[];
  assert.equal(r.outputs.count, 1);
  assert.equal(rows.length, 1);
  const expectTs = new Date(new Date().getFullYear(), 9, 17, 14, 23, 1, 123).getTime();
  assert.equal(rows[0].ts, expectTs);
  assert.equal(rows[0].level, 'D');
  assert.equal(rows[0].tag, 'MyTag');
  assert.equal(rows[0].pid, 1234);
  assert.equal(rows[0].msg, 'hello world');
  assert.equal(rows[0].raw, line);
});

test('convert.androidLogParse：epoch 格式 + 失败行保留 raw + 多行', async () => {
  const ctx = makeCtx();
  const text = [
    '1699999999000 E/System (  42): boom',
    '这一行不是日志',
    '10-01 00:00:00.999 W/Tag2(7): warn msg',
    '',
  ].join('\n');
  const r = await run('convert.androidLogParse', ctx, { lines: text });
  const rows = r.outputs.rows as { ts: number; level: string; tag: string; pid: number; msg: string; raw: string }[];
  assert.equal(r.outputs.count, 3);
  assert.equal(rows[0].ts, 1699999999000);
  assert.equal(rows[0].level, 'E');
  assert.equal(rows[0].tag, 'System');
  assert.equal(rows[0].pid, 42);
  assert.equal(rows[0].msg, 'boom');
  // 失败行：ts=0，raw 保留
  assert.equal(rows[1].ts, 0);
  assert.equal(rows[1].raw, '这一行不是日志');
  assert.equal(rows[1].msg, '');
  const expectTs2 = new Date(new Date().getFullYear(), 9, 1, 0, 0, 0, 999).getTime();
  assert.equal(rows[2].ts, expectTs2);
  assert.equal(rows[2].level, 'W');
});

/* ============================================================
 * ui（mock ctx.ui）
 * ============================================================ */

test('ui.get / ui.setValue / ui.getValue：走 mock ctx.ui', async () => {
  const um = makeUiMock({ title: { text: '旧文本' }, list: { items: [] } });
  const ctx = makeCtx({ ui: um });
  const g = await run('ui.get', ctx, { name: 'title' });
  assert.deepEqual(g.outputs.object, { name: 'title', text: '旧文本' });

  const s = await run('ui.setValue', ctx, { name: 'title', value: '新文本', attr: 'text' });
  assert.equal(s.next, 'exec');
  assert.deepEqual(um.writes, [{ name: 'title', attr: 'text', value: '新文本' }]);

  const gv = await run('ui.getValue', ctx, { name: 'title', attr: 'text' });
  assert.equal(gv.outputs.value, '旧文本');
  assert.deepEqual(um.reads, [{ name: 'title', attr: 'text' }]);

  const ls = await run('ui.listSetItems', ctx, { name: 'list', items: [1, 2] });
  assert.equal(ls.next, 'exec');
  assert.deepEqual(um.writes[1], { name: 'list', attr: 'items', value: [1, 2] });

  const v = await run('ui.setVisible', ctx, { name: 'list', visible: false });
  assert.equal(v.next, 'exec');
  assert.deepEqual(um.writes[2], { name: 'list', attr: 'visible', value: false });

  const t = await run('ui.setTitle', ctx, { name: 'title', value: '日志分析' });
  assert.equal(t.next, 'exec');
  assert.deepEqual(um.writes[3], { name: 'title', attr: 'title', value: '日志分析' });
});

test('ui.*：ctx 无 ui 句柄时降级打印提示并放行执行链', async () => {
  const ctx = makeCtx({ ui: null });
  const s = await run('ui.setValue', ctx, { name: 'title', value: 'x' });
  assert.equal(s.next, 'exec');
  assert.ok(ctx.logs.length === 1 && ctx.logs[0].includes('ui'), '应经 ctx.print 提示');
  const g = await run('ui.get', ctx, { name: 'title' });
  assert.equal(g.outputs.object, null);
});

/* ============================================================
 * ui 反射节点（T12.6）与类型化节点族（T12.7 节点侧）
 * ============================================================ */

test('ui.getProp / ui.setProp：按 params nodeName+propId 运行时反射读写', async () => {
  const um = makeUiMock({ title: { text: '旧文本' } });
  const ctx = makeCtx({ params: { nodeName: 'title', propId: 'text' }, ui: um });

  const g = await run('ui.getProp', ctx);
  assert.equal(g.next, 'exec');
  assert.equal(g.outputs.value, '旧文本');
  assert.deepEqual(um.reads, [{ name: 'title', attr: 'text' }]);

  const s = await run('ui.setProp', ctx, { value: '新文本' });
  assert.equal(s.next, 'exec');
  assert.deepEqual(um.writes, [{ name: 'title', attr: 'text', value: '新文本' }]);

  // 不存在的属性 → null（不抛错）
  const g2 = await run('ui.getProp', makeCtx({ params: { nodeName: 'title', propId: 'nope' }, ui: um }));
  assert.equal(g2.outputs.value, null);

  // 反射节点参数声明为 string（nodeName + propId，落盘即通用节点）
  const spec = builtinSpecMap.get('ui.getProp');
  assert.deepEqual(spec?.params?.map((p) => [p.id, p.type]), [
    ['nodeName', 'string'],
    ['propId', 'string'],
  ]);
});

test('ui.getProp / ui.setProp：缺 ui 句柄降级打印且不抛错', async () => {
  const ctx = makeCtx({ params: { nodeName: 'title', propId: 'text' }, ui: null });
  const g = await run('ui.getProp', ctx);
  assert.equal(g.next, 'exec');
  assert.equal(g.outputs.value, null);
  const s = await run('ui.setProp', ctx, { value: 'x' });
  assert.equal(s.next, 'exec');
  assert.equal(ctx.logs.length, 2);
  assert.ok(ctx.logs[0].includes('ui.getProp'), 'getProp 应经 ctx.print 提示');
  assert.ok(ctx.logs[1].includes('ui.setProp'), 'setProp 应经 ctx.print 提示');
});

test('ui.setText：新节点存在、写 text 属性且 value 保持 any 兼容', async () => {
  const spec = builtinSpecMap.get('ui.setText');
  assert.ok(spec, 'ui.setText 应注册');
  assert.equal(spec!.category, '界面');
  assert.deepEqual(spec!.traits, ['text'], 'ui.setText 应声明 text trait');
  assert.equal(spec!.inputs.find((p) => p.id === 'value')?.type, 'any', 'value 入参保持 any 兼容');

  const um = makeUiMock({ title: {} });
  const ctx = makeCtx({ ui: um });
  const r = await run('ui.setText', ctx, { name: 'title', value: '新文本' });
  assert.equal(r.next, 'exec');
  assert.deepEqual(um.writes, [{ name: 'title', attr: 'text', value: '新文本' }]);

  // any 兼容：非字符串按原值写入（不强制转 string）
  await run('ui.setText', ctx, { name: 'title', value: 42 });
  assert.equal(um.writes[1].value, 42);
});

test('类型化 trait 元数据：setValue / listSetItems / setTitle 声明所需 trait', () => {
  assert.deepEqual(builtinSpecMap.get('ui.setValue')?.traits, ['value']);
  assert.deepEqual(builtinSpecMap.get('ui.listSetItems')?.traits, ['items']);
  assert.deepEqual(builtinSpecMap.get('ui.setTitle')?.traits, ['text']);
  // 未声明 traits 的旧节点行为不变
  assert.equal(builtinSpecMap.get('ui.get')?.traits, undefined);
});

test('反射过滤：listReflectableProps 仅保留 reflect:true，无 schema 返回空', () => {
  assert.deepEqual(listReflectableProps(undefined), []);
  assert.deepEqual(listReflectableProps(null), []);
  assert.deepEqual(listReflectableProps([]), []);

  const props = [
    { id: 'text', label: '文本', reflect: true },
    { id: 'internal', label: '内部字段' },
    { id: 'value', label: '值', reflect: false },
    { id: 'items', label: '列表项', reflect: true },
  ];
  assert.deepEqual(listReflectableProps(props).map((p) => p.id), ['text', 'items']);
});

test('反射条目：reflectionEntries 按节点 × reflect:true 属性生成，无 schema 空', () => {
  assert.deepEqual(reflectionEntries(undefined), []);
  assert.deepEqual(reflectionEntries([]), []);

  const entries = reflectionEntries([
    {
      name: 'title',
      type: 'label',
      props: [
        { id: 'text', label: '文本', reflect: true },
        { id: 'internal', label: '内部字段' },
      ],
    },
    { name: 'list', type: 'list', props: [{ id: 'items', label: '列表项', reflect: true }] },
    { name: 'box', type: 'vbox' }, // 无 schema → 不产生条目
    { name: 'card', type: '__element', props: null },
  ]);
  assert.deepEqual(entries, [
    { nodeName: 'title', propId: 'text', label: 'title.文本' },
    { nodeName: 'list', propId: 'items', label: 'list.列表项' },
  ]);
});

/* ============================================================
 * events
 * ============================================================ */

test('event.start / event.custom / event.listen：入口节点走 exec 出口', async () => {
  const ctx = makeCtx();
  assert.equal((await run('event.start', ctx)).next, 'exec');
  assert.equal((await run('event.custom', ctx)).next, 'exec');
  assert.equal((await run('event.listen', ctx, { eventName: 'loaded' })).next, 'exec');
});

test('event.custom：声明 eventName 检视器参数（运行时绑定键 params.eventName 必须可编辑）', () => {
  const spec = builtinSpecMap.get('event.custom');
  const p = spec?.params?.find((x) => x.id === 'eventName');
  assert.ok(p, 'event.custom 应声明 eventName 参数');
  assert.equal(p!.type, 'string');
  assert.equal(p!.default, '');
});

test('event.send：mock ctx.emit（对象展开 / 数组打包 / 单值打包 / 空名防护）', async () => {
  const ctx = makeCtx();
  await run('event.send', ctx, { eventName: 'loaded', args: { count: 3 } });
  assert.deepEqual(ctx.emitted, [{ event: 'loaded', params: { count: 3 } }]);

  const ctx2 = makeCtx();
  await run('event.send', ctx2, { eventName: 'rows', args: [1, 2] });
  assert.deepEqual(ctx2.emitted[0].params, { args: [1, 2] });

  const ctx3 = makeCtx();
  await run('event.send', ctx3, { eventName: 'ping', args: 42 });
  assert.deepEqual(ctx3.emitted[0].params, { value: 42 });

  const ctx4 = makeCtx();
  await run('event.send', ctx4, { eventName: '' });
  assert.equal(ctx4.emitted.length, 0);
  assert.ok(ctx4.logs.length > 0, '空事件名应经 ctx.print 提示');
});

test('event.timer（ADR-008）：一次触发自动持续 tick；单次模式走结束；cancel 走结束', async () => {
  // loop=false：一次延时后直接 stopped（ticks=1）
  const ctx = makeCtx();
  const single = await drain(await runGen('event.timer', ctx, { interval: 0.005, loop: false }));
  assert.equal(single.length, 1);
  assert.equal(single[0]!.next, 'stopped');
  assert.equal(single[0]!.outputs.ticks, 1);

  // loop=true（默认）：持续 tick——手动取 3 次后 return()（无限产出不可 drain）
  const ctx2 = makeCtx();
  const gen = await runGen('event.timer', ctx2, { interval: 0.005, loop: true });
  const f1 = await gen.next();
  const f2 = await gen.next();
  const f3 = await gen.next();
  assert.equal(f1.value!.next, 'tick');
  assert.equal(f1.value!.outputs.ticks, 1);
  assert.equal(f2.value!.next, 'tick');
  assert.equal(f2.value!.outputs.ticks, 2, 'ticks 跨 tick 累积');
  assert.equal(f3.value!.next, 'tick');
  await gen.return(undefined as never);

  // cancel=true（启动时求值）：直接 stopped ticks=0
  const ctx3 = makeCtx();
  const c = await drain(await runGen('event.timer', ctx3, { interval: 0.005, cancel: true }));
  assert.equal(c.length, 1);
  assert.equal(c[0]!.next, 'stopped');
  assert.equal(c[0]!.outputs.ticks, 0);

  // interval/cancel 每 tick 重估（reinputs，含首轮）：首轮 cancel=false 正常 tick，
  // tick 子链完成后第二轮重估 cancel=true → 走 stopped
  let reRound = 0;
  const ctx4 = makeCtx({
    hooks: {
      reinputs: async () => {
        reRound += 1;
        return { interval: 0.005, loop: true, cancel: reRound >= 2 };
      },
    },
  });
  const gen2 = await runGen('event.timer', ctx4, { interval: 0.005, loop: true });
  const first = await gen2.next();
  assert.equal(first.value!.next, 'tick', '首轮重估 cancel=false → 正常 tick');
  const second = await gen2.next();
  assert.equal(second.value!.next, 'stopped', '第二轮重估 cancel=true → 结束');
  await gen2.return(undefined as never);
});

/* ============================================================
 * system
 * ============================================================ */

test('system.print：ctx.print 旁路 + 值透传', async () => {
  const ctx = makeCtx();
  const r = (await run('system.print', ctx, { value: 'hi' })) as NodeRunResult;
  assert.equal(r.next, 'exec');
  assert.deepEqual(ctx.logs, ['hi']);
  assert.equal(r.outputs.value, 'hi');
});

test('system.notify / openUrl：有钩子用钩子，无钩子打印提示不抛错', async () => {
  const notified: unknown[] = [];
  const ctx = makeCtx({ hooks: { notify: (m: unknown) => notified.push(m) } });
  const r = await run('system.notify', ctx, { message: '完成' });
  assert.equal(r.next, 'exec');
  assert.deepEqual(notified, ['完成']);

  const ctx2 = makeCtx();
  await run('system.notify', ctx2, { message: '降级' });
  assert.ok(ctx2.logs[0].includes('降级'));

  const ctx3 = makeCtx();
  const r3 = await run('system.openUrl', ctx3, { url: 'https://example.com' });
  assert.equal(r3.next, 'exec');
  assert.ok(ctx3.logs[0].includes('https://example.com'));

  const opened: unknown[] = [];
  const ctx4 = makeCtx({ hooks: { openUrl: (u: unknown) => opened.push(u) } });
  await run('system.openUrl', ctx4, { url: 'https://example.com' });
  assert.deepEqual(opened, ['https://example.com']);
});

test('system.clipboardWrite：clipboardWrite 钩子 / clipboard.write 对象 / 缺失降级', async () => {
  const written: unknown[] = [];
  const ctx = makeCtx({ hooks: { clipboardWrite: (t: unknown) => written.push(t) } });
  await run('system.clipboardWrite', ctx, { text: 'A' });
  assert.deepEqual(written, ['A']);

  const written2: unknown[] = [];
  const ctx2 = makeCtx({ hooks: { clipboard: { write: (t: unknown) => written2.push(t) } } });
  await run('system.clipboardWrite', ctx2, { text: 'B' });
  assert.deepEqual(written2, ['B']);

  const ctx3 = makeCtx();
  const r = await run('system.clipboardWrite', ctx3, { text: 'C' });
  assert.equal(r.next, 'exec');
  assert.ok(ctx3.logs[0].includes('剪贴板'));
});

test('system.readFile：readProjectFile 钩子读取 / 缺失与失败降级', async () => {
  const ctx = makeCtx({ hooks: { readProjectFile: async (p: string) => `内容:${p}` } });
  const r = (await run('system.readFile', ctx, { path: 'assets/sample.log' })) as NodeRunResult;
  assert.equal(r.next, 'exec');
  assert.equal(r.outputs.text, '内容:assets/sample.log');

  const ctx2 = makeCtx();
  const r2 = (await run('system.readFile', ctx2, { path: 'a.txt' })) as NodeRunResult;
  assert.equal(r2.outputs.text, '');
  assert.ok(ctx2.logs[0].includes('文件钩子'));

  const ctx3 = makeCtx({ hooks: { readProjectFile: async () => { throw new Error('HTTP 404'); } } });
  const r3 = (await run('system.readFile', ctx3, { path: 'nope.txt' })) as NodeRunResult;
  assert.equal(r3.outputs.text, '');
  assert.ok(ctx3.logs[0].includes('HTTP 404'));
});

test('system.now：当前 epoch 毫秒（纯节点）', async () => {
  const ctx = makeCtx();
  const before = Date.now();
  const r = (await run('system.now', ctx)) as NodeRunResult;
  assert.ok((r.outputs.epoch as number) >= before);
  const s = builtinSpecMap.get('system.now');
  assert.equal(s?.pure, true);
});
