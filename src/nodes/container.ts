/**
 * Blueprint Studio v2 —— 容器节点（数组 / Map，PLAN §13.1 container）
 *
 * 高阶节点简化说明（T13.1 决策，后续扩展点）：
 * filter / map / sort 的高阶形式（谓词 / 映射以子图回调实现）需要解释器支持
 * 「子图回调」执行模型，本期不做。这里落地为数据驱动的简化版：
 *  - array.filter：field + op + value 条件对象过滤；
 *  - array.pluck：取对象字段数组（替代 map 的最常见用例）；
 *  - array.sort：key + asc/desc 稳定排序。
 * 后续扩展点：解释器 T2.5 落地「子图调用」契约后，可增加真正的
 * array.filterBy / array.mapBy 高阶节点（新增模块 + 注册一行即可）。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataIn,
  dataOut,
  arrOf,
  objOf,
  strOf,
  intOf,
  boolOf,
  getStateSlot,
  opts,
  selectParam,
} from './spec';

/** 循环状态机内部状态（forEach） */
interface ForEachSlot {
  active: boolean;
  index: number;
  items: unknown[];
}

/** 安全读取元素字段：field 为空时读元素本身 */
function readField(el: unknown, field: string): unknown {
  if (field === '') return el;
  return objOf(el)[field];
}

/* ------------------------------------------------------------- array.make */
export const arrayMake = defineNode({
  id: 'array.make', title: '创建数组', category: '容器',
  keywords: ['array', 'make', '数组', '创建数组', '新建数组', '字面量'],
  doc: '把最多 5 个输入合并为数组；尾部未连线的输入自动省略。',
  pure: true,
  inputs: [
    { id: 'in0', type: 'any', label: '0', optional: true },
    { id: 'in1', type: 'any', label: '1', optional: true },
    { id: 'in2', type: 'any', label: '2', optional: true },
    { id: 'in3', type: 'any', label: '3', optional: true },
    { id: 'in4', type: 'any', label: '4', optional: true },
  ],
  outputs: [dataOut('array', 'any[]', '数组')],
  run: (_c, i) => {
    const items = [i.in0, i.in1, i.in2, i.in3, i.in4];
    while (items.length > 0 && items[items.length - 1] === undefined) items.pop();
    return { outputs: { array: items } };
  },
});

/* ----------------------------------------------------------- array.length */
export const arrayLength = defineNode({
  id: 'array.length', title: '数组长度', category: '容器',
  keywords: ['array', 'length', 'count', '数组长度', '元素个数'],
  doc: '数组元素个数；非数组输入返回 0。',
  pure: true,
  inputs: [dataIn('array', 'any[]', '数组', null)],
  outputs: [dataOut('value', 'int', '长度')],
  run: (_c, i) => ({ outputs: { value: arrOf(i.array).length } }),
});

/* -------------------------------------------------------------- array.get */
export const arrayGet = defineNode({
  id: 'array.get', title: '获取数组元素', category: '容器',
  keywords: ['array', 'get', '获取元素', '下标', '索引'],
  doc: '按下标取元素；越界 / 非数组时返回「默认值」输入。',
  pure: true,
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    dataIn('index', 'int', '下标', 0),
    { id: 'default', type: 'any', label: '默认值', optional: true },
  ],
  outputs: [dataOut('value', 'any', '元素')],
  run: (_c, i) => {
    const items = arrOf(i.array);
    const idx = intOf(i.index);
    const ok = idx >= 0 && idx < items.length;
    return { outputs: { value: ok ? (items[idx] === undefined ? null : items[idx]) : (i.default ?? null) } };
  },
});

/* -------------------------------------------------------------- array.set */
export const arraySet = defineNode({
  id: 'array.set', title: '设置数组元素', category: '容器',
  keywords: ['array', 'set', '设置元素', '修改元素'],
  doc: '返回设置了下标元素的新数组（纯，不改原数组）；下标越界时返回原数组的副本。',
  pure: true,
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    dataIn('index', 'int', '下标', 0),
    { id: 'value', type: 'any', label: '新值', defaultValue: null },
  ],
  outputs: [dataOut('array', 'any[]', '新数组')],
  run: (_c, i) => {
    const items = [...arrOf(i.array)];
    const idx = intOf(i.index);
    if (idx >= 0 && idx < items.length) items[idx] = i.value === undefined ? null : i.value;
    return { outputs: { array: items } };
  },
});

/* ------------------------------------------------------------- array.push */
export const arrayPush = defineNode({
  id: 'array.push', title: '追加元素', category: '容器',
  keywords: ['array', 'push', 'append', '追加', '添加元素', '压入'],
  doc: '返回在尾部追加元素后的新数组（纯，不改原数组）。',
  pure: true,
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    { id: 'value', type: 'any', label: '元素', defaultValue: null },
  ],
  outputs: [dataOut('array', 'any[]', '新数组')],
  run: (_c, i) => {
    const items = [...arrOf(i.array)];
    items.push(i.value === undefined ? null : i.value);
    return { outputs: { array: items } };
  },
});

/* ---------------------------------------------------------- array.forEach */
export const arrayForEach = defineNode({
  id: 'array.forEach', title: '遍历数组', category: '容器',
  keywords: ['array', 'foreach', 'each', '遍历', '迭代', '循环'],
  doc: '循环状态机：每次触发走一次迭代（首次触发时快照数组），经「循环体」给出元素与下标；链尾连回 exec 入继续，break 为真或遍历完走「完成」。',
  inputs: [
    execIn(),
    dataIn('array', 'any[]', '数组', null),
    dataIn('break', 'bool', '中断', false),
  ],
  outputs: [
    execOut('body', '循环体'),
    dataOut('element', 'any', '元素'),
    dataOut('index', 'int', '下标'),
    execOut('done', '完成'),
  ],
  run: (_ctx, inputs) => {
    const slot = getStateSlot<ForEachSlot>(_ctx.nodeId, () => ({ active: false, index: 0, items: [] }));
    if (!slot.active) {
      slot.items = arrOf(inputs.array);
      if (slot.items.length === 0) {
        slot.active = false;
        return { next: 'done', outputs: { index: 0 } };
      }
      slot.active = true;
      slot.index = 0;
      return { next: 'body', outputs: { element: slot.items[0] ?? null, index: 0 } };
    }
    if (boolOf(inputs.break) || slot.index + 1 >= slot.items.length) {
      slot.active = false;
      return { next: 'done', outputs: { index: slot.index } };
    }
    slot.index += 1;
    return {
      next: 'body',
      outputs: { element: slot.items[slot.index] ?? null, index: slot.index },
    };
  },
});

/* ---------------------------------------------------------- array.filter */
export const arrayFilter = defineNode({
  id: 'array.filter', title: '过滤数组', category: '容器',
  keywords: ['array', 'filter', '过滤', '筛选', '条件'],
  doc: '按条件（字段 + 比较符 + 值）过滤数组，返回满足条件的元素数组；field 为空时比较元素本身。本期为数据驱动简化版（高阶子图回调版本待解释器支持后扩展）。',
  pure: true,
  params: [
    selectParam('op', '比较符',
      opts(['==', '等于'], ['!=', '不等于'], ['>', '大于'], ['>=', '大于等于'], ['<', '小于'], ['<=', '小于等于'],
        ['contains', '包含'], ['startsWith', '以之开头'], ['endsWith', '以之结尾']),
      '=='),
  ],
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    dataIn('field', 'string', '字段', ''),
    { id: 'value', type: 'any', label: '比较值', defaultValue: null },
  ],
  outputs: [dataOut('array', 'any[]', '结果')],
  run: (ctx, i) => {
    const items = arrOf(i.array);
    const field = strOf(i.field);
    const target = i.value;
    const op = strOf(ctx.params.op) || '==';
    const keep = (el: unknown): boolean => {
      const v = readField(el, field);
      const bothNum = typeof v === 'number' && typeof target === 'number';
      const sv = strOf(v);
      const st = strOf(target);
      switch (op) {
        case '==': return bothNum ? v === target : sv === st;
        case '!=': return bothNum ? v !== target : sv !== st;
        case '>': return bothNum ? (v as number) > (target as number) : sv > st;
        case '>=': return bothNum ? (v as number) >= (target as number) : sv >= st;
        case '<': return bothNum ? (v as number) < (target as number) : sv < st;
        case '<=': return bothNum ? (v as number) <= (target as number) : sv <= st;
        case 'contains': return sv.includes(st);
        case 'startsWith': return sv.startsWith(st);
        case 'endsWith': return sv.endsWith(st);
        default: return true;
      }
    };
    return { outputs: { array: items.filter(keep) } };
  },
});

/* ----------------------------------------------------------- array.pluck */
export const arrayPluck = defineNode({
  id: 'array.pluck', title: '提取字段', category: '容器',
  keywords: ['array', 'pluck', 'map', '提取字段', '取字段', '对象数组'],
  doc: '从对象数组中提取指定字段组成新数组（缺失字段的元素跳过）；替代高阶 map 的最常用场景。',
  pure: true,
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    dataIn('field', 'string', '字段', ''),
  ],
  outputs: [dataOut('array', 'any[]', '结果')],
  run: (_c, i) => {
    const field = strOf(i.field);
    const out: unknown[] = [];
    for (const el of arrOf(i.array)) {
      const v = readField(el, field);
      if (v !== undefined) out.push(v);
    }
    return { outputs: { array: out } };
  },
});

/* ----------------------------------------------------------- array.sort */
export const arraySort = defineNode({
  id: 'array.sort', title: '数组排序', category: '容器',
  keywords: ['array', 'sort', '排序', '升序', '降序', '稳定排序'],
  doc: '按字段排序（元素为对象时按键，否则按元素本身），数值按大小、其余按字符串；稳定排序（相等元素保持原顺序）。',
  pure: true,
  params: [
    selectParam('order', '顺序', opts(['asc', '升序'], ['desc', '降序']), 'asc'),
  ],
  inputs: [
    dataIn('array', 'any[]', '数组', null),
    dataIn('key', 'string', '排序键', ''),
  ],
  outputs: [dataOut('array', 'any[]', '结果')],
  run: (ctx, i) => {
    const items = [...arrOf(i.array)];
    const key = strOf(i.key);
    const desc = strOf(ctx.params.order) === 'desc';
    const cmp = (a: unknown, b: unknown): number => {
      const va = readField(a, key);
      const vb = readField(b, key);
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      const sa = strOf(va);
      const sb = strOf(vb);
      if (sa === sb) return 0;
      return sa < sb ? -1 : 1;
    };
    items.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
    return { outputs: { array: items } };
  },
});

/* ---------------------------------------------------------------- map.* */
export const mapGet = defineNode({
  id: 'map.get', title: '读取键值', category: '容器',
  keywords: ['map', 'get', '字典', '读取键', '键值'],
  doc: '读取 Map（对象）中某键的值；缺失返回「默认值」输入。',
  pure: true,
  inputs: [
    dataIn('map', 'object', 'Map', null),
    dataIn('key', 'string', '键', ''),
    { id: 'default', type: 'any', label: '默认值', optional: true },
  ],
  outputs: [dataOut('value', 'any', '值')],
  run: (_c, i) => {
    const m = objOf(i.map);
    const k = strOf(i.key);
    return { outputs: { value: k in m && m[k] !== undefined ? m[k] : (i.default ?? null) } };
  },
});

export const mapSet = defineNode({
  id: 'map.set', title: '写入键值', category: '容器',
  keywords: ['map', 'set', '字典', '写入键', '赋值'],
  doc: '返回写入键值后的新 Map（纯，不改原对象）。',
  pure: true,
  inputs: [
    dataIn('map', 'object', 'Map', null),
    dataIn('key', 'string', '键', ''),
    { id: 'value', type: 'any', label: '值', defaultValue: null },
  ],
  outputs: [dataOut('map', 'object', '新Map')],
  run: (_c, i) => ({
    outputs: { map: { ...objOf(i.map), [strOf(i.key)]: i.value === undefined ? null : i.value } },
  }),
});

export const mapHas = defineNode({
  id: 'map.has', title: '包含键', category: '容器',
  keywords: ['map', 'has', 'haskey', '字典', '包含键', '存在'],
  doc: '判断 Map（对象）中是否存在某键。',
  pure: true,
  inputs: [
    dataIn('map', 'object', 'Map', null),
    dataIn('key', 'string', '键', ''),
  ],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => {
    const m = objOf(i.map);
    return { outputs: { value: strOf(i.key) in m } };
  },
});

export const mapKeys = defineNode({
  id: 'map.keys', title: '全部键名', category: '容器',
  keywords: ['map', 'keys', '字典', '键名', '键列表'],
  doc: '返回 Map（对象）的全部键名数组。',
  pure: true,
  inputs: [dataIn('map', 'object', 'Map', null)],
  outputs: [dataOut('keys', 'string[]', '键名')],
  run: (_c, i) => ({ outputs: { keys: Object.keys(objOf(i.map)) } }),
});

export const containerNodes: NodeSpec[] = [
  arrayMake, arrayLength, arrayGet, arraySet, arrayPush, arrayForEach,
  arrayFilter, arrayPluck, arraySort,
  mapGet, mapSet, mapHas, mapKeys,
];
