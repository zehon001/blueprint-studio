/**
 * Blueprint Studio v2 —— 事件节点（头红，PLAN §13.1 events / §11 事件系统）
 *
 * 事件型节点的路由（哪个事件投递到哪个节点实例）由解释器 / 事件总线（T2.5 / T5.x）
 * 负责；本模块只声明引脚与降级 run。事件参数的注入约定（ADR-003 遗留项）：
 * 解释器触发事件节点时，把 IREventDef.params 按名写入对应输出数据脚。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataIn,
  dataOut,
  strOf,
  boolOf,
  numOf,
  getStateSlot,
} from './spec';

/** 把任意 args 值规范化为 emit 的参数对象（按事件参数名的匹配留给解释器 / 用户约定） */
function normalizeArgs(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object' && !Array.isArray(v)) {
    return { ...(v as Record<string, unknown>) };
  }
  if (Array.isArray(v)) return { args: v };
  return { value: v };
}

/* ------------------------------------------------------------ event.start */
export const start = defineNode({
  id: 'event.start',
  title: '开始',
  category: '事件',
  keywords: ['start', 'begin', '开始', '启动', 'beginplay', '入口'],
  doc: '资产启动（BeginPlay 同义）时由运行器触发一次，执行链从此出发。',
  inputs: [],
  outputs: [execOut()],
  run: () => ({ next: 'exec', outputs: {} }),
});

/* ----------------------------------------------------------- event.custom */
export const custom = defineNode({
  id: 'event.custom',
  title: '自定义事件',
  category: '事件',
  keywords: ['custom event', '自定义事件', '事件定义', '入口'],
  doc: '自定义事件的入口节点：静态定义提供 arg0~arg2 占位数据脚；运行时由解释器按 IREventDef.params 注入同名参数到输出数据脚（T5.x）。',
  inputs: [],
  outputs: [
    execOut(),
    dataOut('arg0', 'any', '参数1'),
    dataOut('arg1', 'any', '参数2'),
    dataOut('arg2', 'any', '参数3'),
  ],
  run: () => ({ next: 'exec', outputs: {} }),
});

/* ------------------------------------------------------------- event.send */
export const send = defineNode({
  id: 'event.send',
  title: '发送事件',
  category: '事件',
  keywords: ['emit', 'send', '发送事件', '触发事件', '广播'],
  doc: '发送自定义事件：args 传对象时按键展开为事件参数，数组打包为 args，单值打包为 value。',
  inputs: [
    execIn(),
    dataIn('eventName', 'string', '事件名', ''),
    dataIn('args', 'any', '参数', null, { optional: true }),
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const name = strOf(inputs.eventName);
    if (!name) {
      ctx.print('[event.send] 事件名为空，事件未发送');
      return { next: 'exec', outputs: {} };
    }
    ctx.emit(name, normalizeArgs(inputs.args));
    return { next: 'exec', outputs: {} };
  },
});

/* ----------------------------------------------------------- event.listen */
export const listen = defineNode({
  id: 'event.listen',
  title: '监听事件',
  category: '事件',
  keywords: ['on', 'listen', '监听事件', '绑定', '订阅'],
  doc: '声明监听某事件：eventName 引脚（可连线）指明目标事件；事件到达时由解释器激活本节点 exec 并把参数注入 args 数据脚（T5.x）。',
  inputs: [dataIn('eventName', 'string', '事件名', '')],
  outputs: [execOut(), dataOut('args', 'any', '事件参数')],
  run: () => ({ next: 'exec', outputs: {} }),
});

/* ------------------------------------------------------------ event.timer */
/**
 * 定时器（契约内实现）：单次 run 只能激活一个出口，故「每 tick 触发」采用
 * 与循环节点相同的链尾回连机制——loop 为真时把 tick 链尾 exec 连回本节点
 * exec 入即持续计时；loop 为假则一次延时后走「结束」。cancel 引脚置真、
 * 或 ctx.signal 中止时走「结束」并清零计数。
 */
export const timer = defineNode({
  id: 'event.timer',
  title: '定时器',
  category: '事件',
  keywords: ['timer', '定时', 'interval', '间隔', '循环计时'],
  doc: '每隔 interval 秒触发一次 tick 出口（loop 为真时把 tick 链尾连回 exec 入持续计时）；cancel 为真或运行中止时走「结束」。',
  inputs: [
    execIn(),
    dataIn('interval', 'float', '间隔秒', 1.0),
    dataIn('loop', 'bool', '循环', true),
    dataIn('cancel', 'bool', '取消', false),
  ],
  outputs: [execOut('tick', '每次触发'), dataOut('ticks', 'int', '已触发次数'), execOut('stopped', '结束')],
  run: async (ctx, inputs) => {
    const slot = getStateSlot<{ ticks: number }>(ctx.nodeId, () => ({ ticks: 0 }));
    if (boolOf(inputs.cancel)) {
      slot.ticks = 0;
      return { next: 'stopped', outputs: { ticks: 0 } };
    }
    const ms = Math.max(0, Math.round(numOf(inputs.interval, 1) * 1000));
    await ctx.delay(ms);
    if (ctx.signal.aborted) {
      slot.ticks = 0;
      return { next: 'stopped', outputs: { ticks: 0 } };
    }
    slot.ticks += 1;
    const fired = slot.ticks;
    if (!boolOf(inputs.loop, true)) {
      slot.ticks = 0;
      return { next: 'stopped', outputs: { ticks: fired } };
    }
    return { next: 'tick', outputs: { ticks: fired } };
  },
});

export const eventNodes: NodeSpec[] = [start, custom, send, listen, timer];
