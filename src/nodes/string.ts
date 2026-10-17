/**
 * Blueprint Studio v2 —— 字符串节点（PLAN §13.1 string）
 *
 * 除 format 等声明为纯节点外全部无副作用；输入缺失按空串处理，不抛错。
 */
import type { NodeSpec } from '../ir/types';
import { defineNode, dataIn, dataOut, strOf, intOf } from './spec';

const IN_STR = (id = 'value', label = '文本') => dataIn(id, 'string', label, '');

/* ---------------------------------------------------------------- concat */
export const concat = defineNode({
  id: 'string.concat', title: '拼接文本', category: '字符串',
  keywords: ['concat', 'join', '拼接', '连接', '合并文本', '+'],
  doc: '把 A、B 两个文本首尾拼接（非字符串自动转文本）。',
  pure: true,
  inputs: [IN_STR('a', 'A'), IN_STR('b', 'B')],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => ({ outputs: { value: strOf(i.a) + strOf(i.b) } }),
});

/* ---------------------------------------------------------------- format */
export const format = defineNode({
  id: 'string.format', title: '格式化文本', category: '字符串',
  keywords: ['format', '格式化', '模板', '占位符', '占位'],
  doc: '把模板中的 {0} {1}… 占位符替换为参数数组（multi 引脚聚合）对应项；缺参替换为空串。',
  pure: true,
  inputs: [
    IN_STR('template', '模板'),
    { id: 'args', type: 'any', label: '参数', optional: true, multi: true },
  ],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => {
    const tpl = strOf(i.template);
    const args = Array.isArray(i.args) ? i.args : [];
    return {
      outputs: {
        value: tpl.replace(/\{(\d+)\}/g, (_m, idx: string) => {
          const n = Number(idx);
          return n >= 0 && n < args.length && args[n] !== undefined && args[n] !== null
            ? strOf(args[n])
            : '';
        }),
      },
    };
  },
});

/* ----------------------------------------------------------------- split */
export const split = defineNode({
  id: 'string.split', title: '分割文本', category: '字符串',
  keywords: ['split', '分割', '拆分', '分隔符'],
  doc: '按分隔符把文本拆成字符串数组；分隔符为空则不拆分（返回单元素数组）。',
  pure: true,
  inputs: [IN_STR(), IN_STR('sep', '分隔符')],
  outputs: [dataOut('value', 'string[]', '数组')],
  run: (_c, i) => {
    const s = strOf(i.value);
    const sep = strOf(i.sep);
    return { outputs: { value: sep === '' ? [s] : s.split(sep) } };
  },
});

/* --------------------------------------------------------------- replace */
export const replace = defineNode({
  id: 'string.replace', title: '替换文本', category: '字符串',
  keywords: ['replace', '替换', '查找替换', '替换全部'],
  doc: '把文本中所有「查找」替换为「替换为」。',
  pure: true,
  inputs: [IN_STR(), IN_STR('from', '查找'), IN_STR('to', '替换为')],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => {
    const s = strOf(i.value);
    const from = strOf(i.from);
    return { outputs: { value: from === '' ? s : s.split(from).join(strOf(i.to)) } };
  },
});

/* -------------------------------------------------------------- contains */
export const contains = defineNode({
  id: 'string.contains', title: '包含文本', category: '字符串',
  keywords: ['contains', 'includes', '包含', '含有', '查找'],
  doc: '判断文本是否包含「查找」。',
  pure: true,
  inputs: [IN_STR(), IN_STR('search', '查找')],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value).includes(strOf(i.search)) } }),
});

/* ---------------------------------------------------------------- length */
export const length = defineNode({
  id: 'string.length', title: '文本长度', category: '字符串',
  keywords: ['length', 'len', '长度', '字符数'],
  doc: '文本长度（UTF-16 码元数）。',
  pure: true,
  inputs: [IN_STR()],
  outputs: [dataOut('value', 'int', '长度')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value).length } }),
});

/* ------------------------------------------------------------------ trim */
export const trim = defineNode({
  id: 'string.trim', title: '去除首尾空白', category: '字符串',
  keywords: ['trim', '去空白', '去空格', '修剪'],
  doc: '去掉文本首尾空白字符。',
  pure: true,
  inputs: [IN_STR()],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value).trim() } }),
});

/* ----------------------------------------------------------- upper/lower */
export const upper = defineNode({
  id: 'string.upper', title: '转大写', category: '字符串',
  keywords: ['upper', 'uppercase', '大写', '转大写'],
  doc: '文本全部转为大写。',
  pure: true,
  inputs: [IN_STR()],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value).toUpperCase() } }),
});

export const lower = defineNode({
  id: 'string.lower', title: '转小写', category: '字符串',
  keywords: ['lower', 'lowercase', '小写', '转小写'],
  doc: '文本全部转为小写。',
  pure: true,
  inputs: [IN_STR()],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value).toLowerCase() } }),
});

/* ------------------------------------------------------------ regexMatch */
export const regexMatch = defineNode({
  id: 'string.regexMatch', title: '正则匹配', category: '字符串',
  keywords: ['regex', 'match', '正则', '匹配', 'test'],
  doc: '判断文本是否匹配正则表达式；正则非法时返回 false。',
  pure: true,
  inputs: [IN_STR(), IN_STR('pattern', '正则')],
  outputs: [dataOut('value', 'bool', '结果')],
  run: (_c, i) => {
    try {
      return { outputs: { value: new RegExp(strOf(i.pattern)).test(strOf(i.value)) } };
    } catch {
      return { outputs: { value: false } };
    }
  },
});

/* ---------------------------------------------------------- regexExtract */
export const regexExtract = defineNode({
  id: 'string.regexExtract', title: '正则提取', category: '字符串',
  keywords: ['regex', 'extract', '正则', '提取', '捕获组', 'group'],
  doc: '按正则提取第一个匹配的指定捕获组（组号 0 为整个匹配）；无匹配或正则非法返回空串。',
  pure: true,
  inputs: [
    IN_STR(),
    IN_STR('pattern', '正则'),
    dataIn('group', 'int', '组号', 0),
  ],
  outputs: [dataOut('value', 'string', '结果')],
  run: (_c, i) => {
    try {
      const m = new RegExp(strOf(i.pattern)).exec(strOf(i.value));
      const g = Math.max(0, intOf(i.group));
      return { outputs: { value: m && m[g] !== undefined ? strOf(m[g]) : '' } };
    } catch {
      return { outputs: { value: '' } };
    }
  },
});

export const stringNodes: NodeSpec[] = [
  concat, format, split, replace, contains, length,
  trim, upper, lower, regexMatch, regexExtract,
];
