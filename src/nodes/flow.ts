/**
 * Blueprint Studio v2 —— 流程节点（头灰，PLAN §13.1 flow）
 *
 * 运行机制说明（ADR-008 契约）：NodeRunFn 可返回 async generator（多次出脚）——
 * 循环/序列类节点在一次触发内逐迭代 yield 出脚（每迭代等循环体子链完整执行后
 * 继续，UE5 语义，无需链尾回连）；break 等 动态引脚经 ctx.reinputs() 每迭代重估。
 * doOnce / flipFlop / multiGate / gate 为单出口或状态机语义，仍用状态槽（spec.ts）。
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

/** 触发序列状态（multiGate / flipFlop / doOnce） */
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
 * 序列：一次触发的 N 条子链按序执行（ADR-008 多次出脚）。
 * 一次触发按序激活 out0→out3，每条子链完整执行后才激活下一条（与 UE5 Sequence 一致），
 * 用户不再需要把子链链尾回连。reset 引脚保留兼容（新语义下无状态，reset 引脚无效）。
 */
export const sequence = defineNode({
  id: 'flow.sequence',
  title: '序列',
  category: '流程',
  keywords: ['sequence', '序列', '顺序', '按序'],
  doc: '一次触发按序激活 out0→out3：每条子链完整执行完后激活下一条（UE5 Sequence 语义，无需回连）。',
  inputs: [execIn(), dataIn('reset', 'bool', '重置', false)],
  outputs: [execOut('out0', '0'), execOut('out1', '1'), execOut('out2', '2'), execOut('out3', '3')],
  run: async function* (_ctx, inputs) {
    const outs = ['out0', 'out1', 'out2', 'out3'];
    for (const out of outs) {
      yield { next: out, outputs: {} };
    }
    void inputs;
  },
});

/* -------------------------------------------------------------- forLoop */
/**
 * For 循环（ADR-008 多次出脚）：一次触发跑完 from→to（含），每迭代等循环体子链
 * 完整执行后再下一迭代（UE5 ForLoop 语义，循环体无需回连）。break 引脚每迭代经
 * ctx.reinputs 重估——循环体内写变量（接 var.get）可实现提前终止；to/step 启动时定型。
 * 结束（含 break）走 done。
 */
export const forLoop = defineNode({
  id: 'flow.forLoop',
  title: 'For 循环',
  category: '流程',
  keywords: ['for', 'loop', '循环', 'forloop', '计数'],
  doc: '一次触发跑完 from→to（含）：每迭代执行循环体子链后继续（UE5 ForLoop 语义，无需回连）；break 每迭代重估（循环体内写变量可提前终止），结束走 done；step 支持负数。',
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
  run: async function* (ctx, inputs) {
    const step = intOf(inputs.step, 1) || 1;
    let cur = intOf(inputs.from, 0);
    const to = intOf(inputs.to, 9);
    let brk = boolOf(inputs.break);
    while (!stepExceeded(cur, to, step) && !brk) {
      if (ctx.signal.aborted) return;
      yield { next: 'body', outputs: { index: cur } };
      cur += step;
      // break 引脚每迭代重估：循环体内写变量（break 接 var.get）即提前终止
      if (ctx.reinputs) {
        try {
          brk = boolOf((await ctx.reinputs()).break);
        } catch {
          /* 重估失败沿用上次值 */
        }
      }
    }
    yield { next: 'done', outputs: { index: cur } };
  },
});

/* ------------------------------------------------------------ whileLoop */
/**
 * While 循环（ADR-008 多次出脚 + reinputs）：一次触发内循环——每迭代重估条件
 * （条件接 var.get / 表达式时读变量最新值，UE5 WhileLoop 语义，循环体无需回连）；
 * 假或 break 走 done。声明 unlimitedFires：合法无限循环由 stop / break 终止。
 */
export const whileLoop = defineNode({
  id: 'flow.whileLoop',
  title: 'While 循环',
  category: '流程',
  keywords: ['while', 'loop', '循环', '条件循环'],
  doc: '一次触发内循环：每迭代重估条件（接变量可动态退出，无需回连），真执行循环体，假或 break 走 done；运行中止（stop）时结束。',
  unlimitedFires: true,
  inputs: [
    execIn(),
    dataIn('cond', 'bool', '条件', false),
    dataIn('break', 'bool', '中断', false),
  ],
  outputs: [execOut('body', '循环体'), execOut('done', '完成')],
  run: async function* (ctx, inputs) {
    let cur = inputs;
    for (;;) {
      if (ctx.signal.aborted) return;
      if (boolOf(cur.break) || !boolOf(cur.cond)) {
        yield { next: 'done', outputs: {} };
        return;
      }
      yield { next: 'body', outputs: {} };
      // 每迭代重估条件 / break（循环体内写变量即动态退出）
      if (ctx.reinputs) {
        try {
          cur = await ctx.reinputs();
        } catch {
          /* 重估失败沿用上次值 */
        }
      }
    }
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
