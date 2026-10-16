/**
 * Blueprint Studio v2 —— 类型转换节点（PLAN §13.1 convert）
 *
 * 全部为纯节点；解析失败一律安全降级（0 / 空串 / null / 原样行），不抛错。
 * androidLogParse 输出的 LogRow 结构与手机日志插件（PLAN §14.3）共用。
 */
import type { NodeSpec } from '../ir/types';
import { defineNode, dataIn, dataOut, strOf, numOf, boolOf, opts, selectParam } from './spec';

/* 结构化日志行（自定义对象类型别名 'LogRow'，解释器不做结构展开） */
export interface LogRow {
  /** 时间戳（epoch ms；解析失败行为 0） */
  ts: number;
  /** 级别（V/D/I/W/E/F；解析失败行为 ''） */
  level: string;
  /** 标签 */
  tag: string;
  /** 进程号 */
  pid: number;
  /** 消息正文 */
  msg: string;
  /** 原始行 */
  raw: string;
}

/* ------------------------------------------------------- 基础类型转换 */
export const toNumber = defineNode({
  id: 'convert.toNumber', title: '转为数值', category: '转换',
  keywords: ['tonumber', 'float', 'number', '转数值', '转数字', '解析数字'],
  doc: '把输入转为 float；无法解析（含 NaN）时返回 0。',
  pure: true,
  inputs: [dataIn('value', 'any', '值', null)],
  outputs: [dataOut('value', 'float', '数值')],
  run: (_c, i) => {
    if (typeof i.value === 'boolean') return { outputs: { value: i.value ? 1 : 0 } };
    const n = Number(i.value);
    return { outputs: { value: Number.isFinite(n) ? n : 0 } };
  },
});

export const toStringNode = defineNode({
  id: 'convert.toString', title: '转为文本', category: '转换',
  keywords: ['tostring', 'str', '转文本', '转字符串'],
  doc: '把输入转为文本；null / undefined 转为空串。',
  pure: true,
  inputs: [dataIn('value', 'any', '值', null)],
  outputs: [dataOut('value', 'string', '文本')],
  run: (_c, i) => ({ outputs: { value: strOf(i.value) } }),
});

export const toBool = defineNode({
  id: 'convert.toBool', title: '转为布尔', category: '转换',
  keywords: ['tobool', 'boolean', '转布尔', '转真假'],
  doc: '转布尔：数字非 0、字符串 true/1/yes/on 为真，其余为假。',
  pure: true,
  inputs: [dataIn('value', 'any', '值', null)],
  outputs: [dataOut('value', 'bool', '布尔')],
  run: (_c, i) => ({ outputs: { value: boolOf(i.value) } }),
});

export const parseIntNode = defineNode({
  id: 'convert.parseInt', title: '解析整数', category: '转换',
  keywords: ['parseint', 'int', '解析整数', '取整数部分'],
  doc: '按整数解析文本前缀（如 "12abc" → 12）；无法解析返回 0。',
  pure: true,
  inputs: [dataIn('value', 'any', '值', null)],
  outputs: [dataOut('value', 'int', '整数')],
  run: (_c, i) => {
    if (typeof i.value === 'number') return { outputs: { value: Math.trunc(i.value) } };
    const n = Number.parseInt(strOf(i.value).trim(), 10);
    return { outputs: { value: Number.isFinite(n) ? n : 0 } };
  },
});

/* ------------------------------------------------------------ JSON */
export const jsonParse = defineNode({
  id: 'convert.jsonParse', title: 'JSON 解析', category: '转换',
  keywords: ['json', 'parse', '解析', '反序列化'],
  doc: '把 JSON 文本解析为任意值；解析失败返回 null。',
  pure: true,
  inputs: [dataIn('value', 'string', 'JSON文本', '')],
  outputs: [dataOut('value', 'any', '结果')],
  run: (_c, i) => {
    try {
      return { outputs: { value: JSON.parse(strOf(i.value)) as unknown } };
    } catch {
      return { outputs: { value: null } };
    }
  },
});

export const jsonStringify = defineNode({
  id: 'convert.jsonStringify', title: 'JSON 序列化', category: '转换',
  keywords: ['json', 'stringify', '序列化', '转json'],
  doc: '把任意值序列化为 JSON 文本（缩进 2）；序列化失败返回空串。',
  pure: true,
  inputs: [dataIn('value', 'any', '值', null)],
  outputs: [dataOut('value', 'string', 'JSON文本')],
  run: (_c, i) => {
    try {
      return { outputs: { value: JSON.stringify(i.value ?? null, null, 2) } };
    } catch {
      return { outputs: { value: '' } };
    }
  },
});

/* ---------------------------------------------------------- 时间格式化 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

export const timeFormat = defineNode({
  id: 'convert.timeFormat', title: '时间格式化', category: '转换',
  keywords: ['time', 'format', '时间格式化', '日期', '格式化时间', 'date'],
  doc: '把 epoch 毫秒格式化为文本；令牌 YYYY/MM/DD/HH/mm/SS（mm 为分钟）。epoch 未连线或为 0 时取当前时间。',
  pure: true,
  params: [
    { id: 'format', label: '格式', type: 'string', default: 'MM-DD HH:mm:SS', group: '选项' },
  ],
  inputs: [dataIn('epoch', 'float', 'epoch毫秒', 0)],
  outputs: [dataOut('value', 'string', '文本')],
  run: (ctx, i) => {
    const raw = numOf(i.epoch, 0);
    const d = raw > 0 ? new Date(raw) : new Date();
    const fmt = strOf(ctx.params.format) || 'MM-DD HH:mm:SS';
    const out = fmt
      .replace(/YYYY/g, String(d.getFullYear()))
      .replace(/MM/g, pad2(d.getMonth() + 1))
      .replace(/DD/g, pad2(d.getDate()))
      .replace(/HH/g, pad2(d.getHours()))
      .replace(/mm/g, pad2(d.getMinutes()))
      .replace(/SS/g, pad2(d.getSeconds()));
    return { outputs: { value: out } };
  },
});

/* ------------------------------------------------------ Android 日志解析 */
/** 共享尾部：LEVEL/TAG (PID): msg（兼容括号前有无空格） */
const LOG_TAIL = String.raw`([VDIWEF])\/\s*([^(\s]+?)\s*\(\s*(\d+)\s*\)\s*:\s?([\s\S]*)$`;
/** 格式一：logcat -v time —— `MM-DD HH:MM:SS.mmm LEVEL/TAG(PID): msg` */
const RE_TIME_FORMAT = new RegExp(String.raw`^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\s+` + LOG_TAIL);
/** 格式二：epoch 前缀 —— `epoch LEVEL/TAG (PID): msg`（10 位秒 / 13 位毫秒） */
const RE_EPOCH_FORMAT = new RegExp(String.raw`^(\d{10,13})\s+` + LOG_TAIL);

/** 解析单行为 LogRow；失败行保留 raw、ts=0。年份固定用当前年（TODO: 跨年日志需结合文件日期推断，见 T13.1 汇报） */
export function parseAndroidLogLine(line: string, now: Date): LogRow {
  const raw = line;
  let m = RE_TIME_FORMAT.exec(line);
  if (m) {
    const [, mo, dd, hh, mi, ss, mmm, level, tag, pid, msg] = m;
    const ts = new Date(
      now.getFullYear(), Number(mo) - 1, Number(dd),
      Number(hh), Number(mi), Number(ss), mmm ? Number(mmm.padEnd(3, '0')) : 0,
    ).getTime();
    return { ts, level: level.toUpperCase(), tag, pid: Number(pid), msg, raw };
  }
  m = RE_EPOCH_FORMAT.exec(line);
  if (m) {
    const [, epoch, level, tag, pid, msg] = m;
    const n = Number(epoch);
    const ts = epoch.length >= 13 ? n : n * 1000;
    return { ts, level: level.toUpperCase(), tag, pid: Number(pid), msg, raw };
  }
  return { ts: 0, level: '', tag: '', pid: 0, msg: '', raw };
}

export const androidLogParse = defineNode({
  id: 'convert.androidLogParse', title: '解析Android日志', category: '转换',
  keywords: ['android', 'logcat', 'log', '日志解析', '日志', 'adb'],
  doc: '把多行日志文本解析为 LogRow[]（ts/level/tag/pid/msg/raw）；兼容 logcat -v time 与 epoch 两种格式，解析失败行保留 raw、ts=0。',
  pure: true,
  params: [
    selectParam('levelFilter', '级别过滤',
      opts(['', '不过滤'], ['V', 'V'], ['D', 'D'], ['I', 'I'], ['W', 'W'], ['E', 'E'], ['F', 'F']),
      '', '选项'),
  ],
  inputs: [dataIn('lines', 'any', '日志文本', '')],
  outputs: [dataOut('rows', 'LogRow[]', '日志行'), dataOut('count', 'int', '行数')],
  run: (ctx, i) => {
    const now = new Date();
    const src = i.lines;
    const lines = Array.isArray(src)
      ? src.map((l) => strOf(l))
      : strOf(src).split(/\r?\n/);
    const filter = strOf(ctx.params.levelFilter);
    const rows: LogRow[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      const row = parseAndroidLogLine(line, now);
      if (filter && row.level !== filter) continue;
      rows.push(row);
    }
    return { outputs: { rows, count: rows.length } };
  },
});

export const convertNodes: NodeSpec[] = [
  toNumber, toStringNode, toBool, parseIntNode,
  jsonParse, jsonStringify, timeFormat, androidLogParse,
];
