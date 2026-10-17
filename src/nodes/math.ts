/**
 * Blueprint Studio v2 —— 数学节点（纯函数，PLAN §13.1 math）
 *
 * 全部为纯节点（pure: true，无 exec 引脚）：输入缺失 / 类型不对时取安全
 * 默认值（数值 0），不抛错。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  dataIn,
  dataOut,
  numOf,
  intOf,
  boolOf,
  strOf,
  opts,
  selectParam,
} from './spec';

const A_B_FLOAT = () => [
  dataIn('a', 'float', 'A', 0),
  dataIn('b', 'float', 'B', 0),
];

/** 通用比较：同为数值按数值，同为布尔按布尔，否则按字符串比较（宽松语义） */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  const sa = strOf(a);
  const sb = strOf(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function applyOp(op: string, cmp: number): boolean {
  switch (op) {
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '==': return cmp === 0;
    case '!=': return cmp !== 0;
    default: return false;
  }
}

/* ------------------------------------------------------------ 四则 / 取模 */
const add = defineNode({
  id: 'math.add', title: '加法', category: '数学',
  keywords: ['add', 'plus', '加', '加法', '+', '求和'],
  doc: 'A + B（float）。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '和')],
  run: (_c, i) => ({ outputs: { value: numOf(i.a) + numOf(i.b) } }),
});

const sub = defineNode({
  id: 'math.sub', title: '减法', category: '数学',
  keywords: ['sub', 'minus', '减', '减法', '-'],
  doc: 'A - B（float）。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '差')],
  run: (_c, i) => ({ outputs: { value: numOf(i.a) - numOf(i.b) } }),
});

const mul = defineNode({
  id: 'math.mul', title: '乘法', category: '数学',
  keywords: ['mul', 'multiply', '乘', '乘法', '*'],
  doc: 'A × B（float）。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '积')],
  run: (_c, i) => ({ outputs: { value: numOf(i.a) * numOf(i.b) } }),
});

const div = defineNode({
  id: 'math.div', title: '除法', category: '数学',
  keywords: ['div', 'divide', '除', '除法', '/', '商'],
  doc: 'A ÷ B（float）；B 为 0 时安全返回 0。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '商')],
  run: (_c, i) => {
    const b = numOf(i.b);
    return { outputs: { value: b === 0 ? 0 : numOf(i.a) / b } };
  },
});

const mod = defineNode({
  id: 'math.mod', title: '取模', category: '数学',
  keywords: ['mod', 'modulo', '取模', '取余', '%'],
  doc: 'A % B；B 为 0 时安全返回 0。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '余数')],
  run: (_c, i) => {
    const b = numOf(i.b);
    return { outputs: { value: b === 0 ? 0 : numOf(i.a) % b } };
  },
});

/* ---------------------------------------------------------------- 比较 */
const compare = defineNode({
  id: 'math.compare', title: '比较', category: '数学',
  keywords: ['compare', '比较', '大于', '小于', '等于', '==', '>=', '判断'],
  doc: '按 op 比较两个数值（同为字符串时按字典序），输出布尔。',
  pure: true,
  params: [
    selectParam('op', '比较符',
      opts(['>', '大于'], ['>=', '大于等于'], ['<', '小于'], ['<=', '小于等于'], ['==', '等于'], ['!=', '不等于']),
      '>'),
  ],
  inputs: A_B_FLOAT(),
  outputs: [dataOut('value', 'bool', '结果')],
  run: (ctx, i) => ({
    outputs: { value: applyOp(strOf(ctx.params.op) || '>', compareValues(i.a, i.b)) },
  }),
});

/* ---------------------------------------------------------------- 逻辑 */
const and = defineNode({
  id: 'math.and', title: '且', category: '数学',
  keywords: ['and', '与', '并且', '&&', '逻辑与'],
  doc: 'A 且 B。', pure: true,
  inputs: [dataIn('a', 'bool', 'A', false), dataIn('b', 'bool', 'B', false)],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => ({ outputs: { value: boolOf(i.a) && boolOf(i.b) } }),
});

const or = defineNode({
  id: 'math.or', title: '或', category: '数学',
  keywords: ['or', '或', '或者', '||', '逻辑或'],
  doc: 'A 或 B。', pure: true,
  inputs: [dataIn('a', 'bool', 'A', false), dataIn('b', 'bool', 'B', false)],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => ({ outputs: { value: boolOf(i.a) || boolOf(i.b) } }),
});

const not = defineNode({
  id: 'math.not', title: '非', category: '数学',
  keywords: ['not', '非', '取反', '!', '逻辑非'],
  doc: '对 A 取反。', pure: true,
  inputs: [dataIn('a', 'bool', 'A', false)],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => ({ outputs: { value: !boolOf(i.a) } }),
});

/* ---------------------------------------------------------------- 随机 */
const random = defineNode({
  id: 'math.random', title: '随机整数', category: '数学',
  keywords: ['random', 'int', '随机', '随机整数', '骰子'],
  doc: '[min, max] 闭区间内的随机整数（含两端）。', pure: true,
  inputs: [dataIn('min', 'int', '最小', 0), dataIn('max', 'int', '最大', 100)],
  outputs: [dataOut('value', 'int', '值')],
  run: (_c, i) => {
    let lo = intOf(i.min);
    let hi = intOf(i.max);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { outputs: { value: lo + Math.floor(Math.random() * (hi - lo + 1)) } };
  },
});

const randomFloat = defineNode({
  id: 'math.randomFloat', title: '随机小数', category: '数学',
  keywords: ['random', 'float', '随机', '随机小数'],
  doc: '[min, max) 区间内的随机小数。', pure: true,
  inputs: [dataIn('min', 'float', '最小', 0), dataIn('max', 'float', '最大', 1)],
  outputs: [dataOut('value', 'float', '值')],
  run: (_c, i) => {
    let lo = numOf(i.min);
    let hi = numOf(i.max);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { outputs: { value: lo + Math.random() * (hi - lo) } };
  },
});

/* ---------------------------------------------------------------- 取整 */
const floor = defineNode({
  id: 'math.floor', title: '向下取整', category: '数学',
  keywords: ['floor', '取整', '向下取整', '⌊⌋'],
  doc: '向下取整：float → int。', pure: true,
  inputs: [dataIn('value', 'float', '值', 0)],
  outputs: [dataOut('value', 'int', '整数')],
  run: (_c, i) => ({ outputs: { value: Math.floor(numOf(i.value)) } }),
});

const ceil = defineNode({
  id: 'math.ceil', title: '向上取整', category: '数学',
  keywords: ['ceil', '取整', '向上取整', '⌈⌉'],
  doc: '向上取整：float → int。', pure: true,
  inputs: [dataIn('value', 'float', '值', 0)],
  outputs: [dataOut('value', 'int', '整数')],
  run: (_c, i) => ({ outputs: { value: Math.ceil(numOf(i.value)) } }),
});

const round = defineNode({
  id: 'math.round', title: '四舍五入', category: '数学',
  keywords: ['round', '取整', '四舍五入'],
  doc: '四舍五入取整：float → int。', pure: true,
  inputs: [dataIn('value', 'float', '值', 0)],
  outputs: [dataOut('value', 'int', '整数')],
  run: (_c, i) => ({ outputs: { value: Math.round(numOf(i.value)) } }),
});

/* ------------------------------------------------------- 钳制 / 最值 / 绝对值 */
const clamp = defineNode({
  id: 'math.clamp', title: '钳制', category: '数学',
  keywords: ['clamp', '钳制', '范围', '限制', '夹住'],
  doc: '把 value 夹在 [min, max] 内。', pure: true,
  inputs: [
    dataIn('value', 'float', '值', 0),
    dataIn('min', 'float', '最小', 0),
    dataIn('max', 'float', '最大', 1),
  ],
  outputs: [dataOut('value', 'float', '结果')],
  run: (_c, i) => {
    let lo = numOf(i.min);
    let hi = numOf(i.max);
    if (lo > hi) [lo, hi] = [hi, lo];
    return { outputs: { value: Math.min(Math.max(numOf(i.value), lo), hi) } };
  },
});

const min = defineNode({
  id: 'math.min', title: '最小值', category: '数学',
  keywords: ['min', '最小', '较小'],
  doc: 'A、B 中较小者。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '结果')],
  run: (_c, i) => ({ outputs: { value: Math.min(numOf(i.a), numOf(i.b)) } }),
});

const max = defineNode({
  id: 'math.max', title: '最大值', category: '数学',
  keywords: ['max', '最大', '较大'],
  doc: 'A、B 中较大者。', pure: true,
  inputs: A_B_FLOAT(), outputs: [dataOut('value', 'float', '结果')],
  run: (_c, i) => ({ outputs: { value: Math.max(numOf(i.a), numOf(i.b)) } }),
});

const abs = defineNode({
  id: 'math.abs', title: '绝对值', category: '数学',
  keywords: ['abs', '绝对值', '正值'],
  doc: 'A 的绝对值。', pure: true,
  inputs: [dataIn('a', 'float', 'A', 0)],
  outputs: [dataOut('value', 'float', '结果')],
  run: (_c, i) => ({ outputs: { value: Math.abs(numOf(i.a)) } }),
});

export const mathNodes: NodeSpec[] = [
  add, sub, mul, div, mod, compare,
  and, or, not,
  random, randomFloat,
  floor, ceil, round,
  clamp, min, max, abs,
];
