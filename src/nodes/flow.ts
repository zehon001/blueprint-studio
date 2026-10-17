/**
 * Blueprint Studio v2 —— 流程节点（头灰，PLAN §13.1 flow）
 *
 * 运行机制说明（NodeRunFn 契约约束）：
 * ADR-003 的 NodeRunResult.next 只支持「单次 run 激活一个 exec 出口」，
 * 节点内无法自行多次触发下游。因此循环类 / 触发类节点统一采用
 * 「循环状态机」实现：每次被触发（包括循环体链尾回连到本节点 exec 入）
 * 走一次迭代，经 body 出口给出当前迭代，完成时走 done 出口。
 * 状态按节点实例 id 隔离（见 spec.ts 状态槽），可用 reset / break 数据引脚
 * （或变量）控制重置与提前终止，与解释器实现解耦。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataIn,
  dataOut,
  intOf,
  boolOf,
  getStateSlot,
} from './spec';

/** 循环状态机的内部状态（forLoop / forEach） */
interface LoopSlot {
  active: boolean;
  index: number;
  items: unknown[];
}

/** 触发序列状态（multiGate / flipFlop / doOnce / sequence / timer） */
interface TriggerSlot {
  next: number;
  armed: boolean;
  ticks: number;
}

/** 判断数值迭代是否越界（支持负步长） */
function stepExceeded(cur: number, to: number, step: number): boolean {
  return step >= 0 ? cur > to : cur < to;
}

/* ---------------------------------------------------------------- branch */
export const branch = defineNode({
  id: 'flow.branch',
  title: '分支',
  category: '流程',
  keywords: ['branch', 'if', '条件', '分支', '判断', 'else'],
  doc: '条件为真走「真」出口，否则走「假」出口。',
  inputs: [execIn(), dataIn('cond', 'bool', '条件', false)],
  outputs: [execOut('true', '真'), execOut('false', '假')],
  run: (_ctx, inputs) => ({ next: boolOf(inputs.cond) ? 'true' : 'false', outputs: {} }),
});

/* -------------------------------------------------------------- sequence */
/**
 * 序列：一次触发的 N 条子链按序执行。
 * 契约限制：单次 run 只能激活一个 exec 出口，故采用「续接触发」状态机——
 * 每条子链执行完后把其链尾 exec 连回本节点 exec 入（即续接触发），
 * 本节点收到后续触发时依次激活 out1、out2…；全部走完自动复位。
 * 全部出口一次触发即按序激活的能力需解释器支持 next 数组，已在汇报中提出。
 */
export const sequence = defineNode({
  id: 'flow.sequence',
  title: '序列',
  category: '流程',
  keywords: ['sequence', '序列', '顺序', '按序'],
  doc: '按序依次激活 out0→out3：out0 子链执行完后，把链尾 exec 连回本节点 exec 入以续接下一条子链。',
  inputs: [execIn(), dataIn('reset', 'bool', '重置', false)],
  outputs: [execOut('out0', '0'), execOut('out1', '1'), execOut('out2', '2'), execOut('out3', '3')],
  run: (_ctx, inputs) => {
    const slot = getStateSlot<TriggerSlot>(_ctx.nodeId, () => ({ next: 0, armed: false, ticks: 0 }));
    if (boolOf(inputs.reset)) {
      slot.next = 0;
      slot.armed = true;
      return { next: 'out0', outputs: {} };
    }
    if (!slot.armed) {
      // 首次触发：激活 out0，等待子链尾续接
      slot.armed = true;
      slot.next = 1;
      return { next: 'out0', outputs: {} };
    }
    if (slot.next < 4) {
      const cur = slot.next;
      slot.next += 1;
      return { next: `out${cur}`, outputs: {} };
    }
    // 全部出口已走完：复位并吞掉链尾续接触发（不激活任何出口）
    slot.armed = false;
    slot.next = 0;
    return { outputs: {} };
  },
});

/* -------------------------------------------------------------- forLoop */
export const forLoop = defineNode({
  id: 'flow.forLoop',
  title: 'For 循环',
  category: '流程',
  keywords: ['for', 'loop', '循环', 'forloop', '计数'],
  doc: '循环状态机：每次触发执行一次迭代，从 from 到 to（含），step 可为负；循环体链尾连回 exec 入继续下一迭代，结束后走「完成」。break 引脚为真时提前结束。',
  inputs: [
    execIn(),
    dataIn('from', 'int', '起始', 0),
    dataIn('to', 'int', '结束', 9),
    dataIn('step', 'int', '步长', 1),
    dataIn('break', 'bool', '中断', false),
  ],
  outputs: [
    execOut('body', '循环体'),
    dataOut('index', 'int', '索引'),
    execOut('done', '完成'),
  ],
  run: (ctx, inputs) => {
    const step = intOf(inputs.step, 1) || 1;
    const from = intOf(inputs.from, 0);
    const to = intOf(inputs.to, 9);
    const brk = boolOf(inputs.break);
    const slot = getStateSlot<LoopSlot>(ctx.nodeId, () => ({ active: false, index: 0, items: [] }));
    if (!slot.active) {
      // 全新启动：本次触发即第一次迭代；起点已越界则直接完成
      if (stepExceeded(from, to, step)) {
        slot.active = false;
        return { next: 'done', outputs: { index: from } };
      }
      slot.active = true;
      slot.index = from;
      return { next: 'body', outputs: { index: slot.index } };
    }
    // 循环体链尾回连触发：检查中断 → 推进 → 判界
    if (brk) {
      slot.active = false;
      return { next: 'done', outputs: { index: slot.index } };
    }
    slot.index += step;
    if (stepExceeded(slot.index, to, step)) {
      slot.active = false;
      return { next: 'done', outputs: { index: slot.index } };
    }
    return { next: 'body', outputs: { index: slot.index } };
  },
});

/* ------------------------------------------------------------ whileLoop */
export const whileLoop = defineNode({
  id: 'flow.whileLoop',
  title: 'While 循环',
  category: '流程',
  keywords: ['while', 'loop', '循环', '条件循环'],
  doc: '每次触发重新求值条件：真走「循环体」（链尾连回 exec 入），假走「完成」。条件恒真会一直循环，可用 break 引脚终止。',
  inputs: [
    execIn(),
    dataIn('cond', 'bool', '条件', false),
    dataIn('break', 'bool', '中断', false),
  ],
  outputs: [execOut('body', '循环体'), execOut('done', '完成')],
  run: (_ctx, inputs) => {
    if (boolOf(inputs.break) || !boolOf(inputs.cond)) {
      return { next: 'done', outputs: {} };
    }
    return { next: 'body', outputs: {} };
  },
});

/* ------------------------------------------------------------------ gate */
/**
 * 门（UE Gate 的契约内适配）：UE 版用 Open/Close/Toggle 独立 exec 入，
 * 但 NodeRunFn 无法区分同一节点的多个 exec 入，故改为 open 数据引脚驱动
 * （可接变量：关门 = setVar(false)，开门 = setVar(true)，Toggle = 取反写回）。
 */
export const gate = defineNode({
  id: 'flow.gate',
  title: '门',
  category: '流程',
  keywords: ['gate', '门', '开关', '放行', '拦截'],
  doc: 'open 为真时触发放行走「通过」，否则走「关闭」；open 通常接变量实现开/关/切换。',
  inputs: [execIn(), dataIn('open', 'bool', '开门', true)],
  outputs: [execOut('out', '通过'), execOut('closed', '关闭')],
  run: (_ctx, inputs) => ({ next: boolOf(inputs.open, true) ? 'out' : 'closed', outputs: {} }),
});

/* -------------------------------------------------------------- flipFlop */
export const flipFlop = defineNode({
  id: 'flow.flipFlop',
  title: 'A/B 切换',
  category: '流程',
  keywords: ['flipflop', '切换', '交替', 'toggle', 'a/b'],
  doc: '每次触发在 A、B 两个出口间交替，并输出本次是否为 A。',
  inputs: [execIn(), dataIn('reset', 'bool', '复位', false)],
  outputs: [execOut('a', 'A'), execOut('b', 'B'), dataOut('isA', 'bool', '本次为A')],
  run: (ctx, inputs) => {
    const slot = getStateSlot<TriggerSlot>(ctx.nodeId, () => ({ next: 0, armed: false, ticks: 0 }));
    if (boolOf(inputs.reset)) slot.next = 0;
    const isA = slot.next % 2 === 0;
    slot.next += 1;
    return { next: isA ? 'a' : 'b', outputs: { isA } };
  },
});

/* ---------------------------------------------------------------- doOnce */
export const doOnce = defineNode({
  id: 'flow.doOnce',
  title: '仅一次',
  category: '流程',
  keywords: ['doonce', 'once', '一次', '只执行一次'],
  doc: '首次触发走「通过」，后续触发走「已触发」；reset 为真时恢复为未触发。',
  inputs: [execIn(), dataIn('reset', 'bool', '复位', false)],
  outputs: [execOut('out', '通过'), execOut('blocked', '已触发'), dataOut('fired', 'bool', '本次通过')],
  run: (ctx, inputs) => {
    const slot = getStateSlot<TriggerSlot>(ctx.nodeId, () => ({ next: 0, armed: false, ticks: 0 }));
    if (boolOf(inputs.reset)) {
      slot.armed = false;
      return { next: 'blocked', outputs: { fired: false } };
    }
    if (slot.armed) return { next: 'blocked', outputs: { fired: false } };
    slot.armed = true;
    return { next: 'out', outputs: { fired: true } };
  },
});

/* ----------------------------------------------------------------- delay */
export const delay = defineNode({
  id: 'flow.delay',
  title: '延时',
  category: '流程',
  keywords: ['delay', 'wait', '延时', '等待', '秒'],
  doc: '异步等待指定秒数后走「完成」（用 ctx.delay，不阻塞其他事件）。',
  inputs: [execIn(), dataIn('seconds', 'float', '秒', 1.0)],
  outputs: [execOut('done', '完成')],
  run: async (ctx, inputs) => {
    const seconds = Math.max(0, Number(inputs.seconds) || 0);
    await ctx.delay(Math.round(seconds * 1000));
    return { next: 'done', outputs: {} };
  },
});

/* ------------------------------------------------------------- multiGate */
export const multiGate = defineNode({
  id: 'flow.multiGate',
  title: '多路复用',
  category: '流程',
  keywords: ['multigate', '多路', '轮流', '复用', 'mux'],
  doc: '每次触发按序激活下一个出口（out0→out3）；loop 为真时循环轮转，reset 为真时回到 out0。',
  inputs: [
    execIn(),
    dataIn('reset', 'bool', '复位', false),
    dataIn('loop', 'bool', '循环', true),
  ],
  outputs: [execOut('out0', '0'), execOut('out1', '1'), execOut('out2', '2'), execOut('out3', '3')],
  run: (ctx, inputs) => {
    const slot = getStateSlot<TriggerSlot>(ctx.nodeId, () => ({ next: 0, armed: false, ticks: 0 }));
    if (boolOf(inputs.reset)) slot.next = 0;
    const loop = boolOf(inputs.loop, true);
    if (!loop && slot.next >= 4) {
      // 非循环模式已走完全部出口：后续触发不激活任何出口（复位需 reset 引脚）
      return { outputs: {} };
    }
    const cur = slot.next;
    slot.next = cur + 1 >= 4 ? (loop ? 0 : 4) : cur + 1;
    return { next: `out${cur}`, outputs: {} };
  },
});

export const flowNodes: NodeSpec[] = [
  branch,
  sequence,
  forLoop,
  whileLoop,
  gate,
  flipFlop,
  doOnce,
  delay,
  multiGate,
];
