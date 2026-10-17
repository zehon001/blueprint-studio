/**
 * Blueprint Studio v2 —— 系统节点（PLAN §13.1 system / §9.2 内建全局）
 *
 * ctx 钩子缺失时的统一策略：经 ctx.print 输出提示，不抛错（保证蓝图可跑）。
 * 期望的解释器钩子（可选注入，见 T13.1 汇报）：notify(message) / clipboardWrite(text)
 * 或 clipboard.write(text) / openUrl(url)。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataIn,
  dataOut,
  strOf,
  probeHook,
} from './spec';

/* ------------------------------------------------------------ system.print */
export const print = defineNode({
  id: 'system.print', title: '打印', category: '系统',
  keywords: ['print', 'log', '打印', '输出', '控制台', '日志'],
  doc: '把值打印到运行窗口控制台（ctx.print，对应脚本全局 print），并透传该值。',
  inputs: [execIn(), { id: 'value', type: 'any', label: '值', defaultValue: null }],
  outputs: [execOut(), dataOut('value', 'any', '值')],
  run: (ctx, inputs) => {
    const value = inputs.value === undefined ? null : inputs.value;
    ctx.print(value);
    return { next: 'exec', outputs: { value } };
  },
});

/* ----------------------------------------------------------- system.notify */
export const notify = defineNode({
  id: 'system.notify', title: '通知', category: '系统',
  keywords: ['notify', 'toast', '通知', '弹提示', '提醒'],
  doc: '弹出运行时通知（解释器注入 notify 钩子时），否则退化为控制台打印。',
  inputs: [execIn(), dataIn('message', 'string', '消息', '')],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const message = strOf(inputs.message);
    const hook = probeHook(ctx, 'notify');
    if (hook) hook(message);
    else ctx.print(`[notify] ${message}`);
    return { next: 'exec', outputs: {} };
  },
});

/* --------------------------------------------------- system.clipboardWrite */
export const clipboardWrite = defineNode({
  id: 'system.clipboardWrite', title: '写入剪贴板', category: '系统',
  keywords: ['clipboard', 'copy', '剪贴板', '复制', '写入剪贴板'],
  doc: '写文本到系统剪贴板（解释器注入 clipboardWrite 或 clipboard.write 钩子时），否则打印提示忽略。',
  inputs: [execIn(), dataIn('text', 'string', '文本', '')],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const text = strOf(inputs.text);
    const hook = probeHook(ctx, 'clipboardWrite');
    if (hook) {
      hook(text);
      return { next: 'exec', outputs: {} };
    }
    const clip = (ctx as unknown as Record<string, unknown>).clipboard;
    if (clip && typeof (clip as { write?: unknown }).write === 'function') {
      (clip as { write: (t: string) => void }).write(text);
      return { next: 'exec', outputs: {} };
    }
    ctx.print('[system.clipboardWrite] 运行上下文未提供剪贴板钩子，已忽略');
    return { next: 'exec', outputs: {} };
  },
});

/* ---------------------------------------------------------- system.openUrl */
export const openUrl = defineNode({
  id: 'system.openUrl', title: '打开链接', category: '系统',
  keywords: ['openurl', 'url', '链接', '打开', '浏览器'],
  doc: '用系统默认方式打开 URL（解释器注入 openUrl 钩子时），否则打印提示忽略。',
  inputs: [execIn(), dataIn('url', 'string', '链接', '')],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const url = strOf(inputs.url);
    const hook = probeHook(ctx, 'openUrl');
    if (hook) hook(url);
    else ctx.print(`[system.openUrl] 运行上下文未提供 openUrl 钩子，已忽略：${url}`);
    return { next: 'exec', outputs: {} };
  },
});

/* -------------------------------------------------------------- system.now */
export const now = defineNode({
  id: 'system.now', title: '当前时间', category: '系统',
  keywords: ['now', 'time', '当前时间', '时间戳', 'epoch'],
  doc: '当前时刻的 epoch 毫秒数。',
  pure: true,
  inputs: [],
  outputs: [dataOut('epoch', 'int', 'epoch毫秒')],
  run: () => ({ outputs: { epoch: Date.now() } }),
});

/* ----------------------------------------------------------- system.readFile */
/**
 * 读项目内文件（ADR-005 附加扩展：ctx.readProjectFile 由 BindingRunner 注入，
 * 经 GET /api/file）。path 为项目内相对路径（如 'assets/sample.log'）。
 * 钩子缺失 / 读取失败经 ctx.print 降级提示（text 输出空串），不抛错。
 */
export const readFile = defineNode({
  id: 'system.readFile', title: '读取文件', category: '系统',
  keywords: ['read', 'file', '读文件', '读取文件', '打开文件', '文本'],
  doc: '读项目内文件文本（path 相对项目根，如 assets/sample.log）；内容经「文本」出脚。运行上下文未提供文件钩子时降级提示。',
  inputs: [execIn(), dataIn('path', 'string', '路径', '')],
  outputs: [execOut(), dataOut('text', 'string', '文本')],
  run: async (ctx, inputs) => {
    const path = strOf(inputs.path);
    if (!path) {
      ctx.print('[读取文件] 路径为空，未读取');
      return { next: 'exec', outputs: { text: '' } };
    }
    const hook = (ctx as { readProjectFile?: (p: string) => Promise<string> }).readProjectFile;
    if (!hook) {
      ctx.print('[读取文件] 运行上下文未提供文件钩子，已忽略');
      return { next: 'exec', outputs: { text: '' } };
    }
    try {
      const text = await hook(path);
      return { next: 'exec', outputs: { text } };
    } catch (err) {
      ctx.print(`[读取文件] 读取失败（${path}）：${err instanceof Error ? err.message : String(err)}`);
      return { next: 'exec', outputs: { text: '' } };
    }
  },
});

export const systemNodes: NodeSpec[] = [print, notify, clipboardWrite, openUrl, readFile, now];
