/**
 * Blueprint Studio v2 —— 剪贴板桥（T2.2，PLAN §8.2 复制粘贴）
 *
 * 策略（任务卡约定「navigator.clipboard + 内部 fallback」）：
 *  - 写入：始终先写内存剪贴板（应用内粘贴永远可用），再尽力写系统剪贴板
 *    （navigator.clipboard，跨应用 / 跨资产粘贴可用；非安全上下文或权限不足时静默降级）；
 *  - 读取：优先读系统剪贴板（可拿到外部复制的片段），失败回落内存剪贴板。
 * 片段格式见 logic.ts 的 IRFragment（{ __bps: 'ir-fragment', v: 1, nodes, edges, variables? }）。
 */
import type { IRFragment } from './logic';
import { fragmentToText, parseFragment } from './logic';

/** 内存剪贴板（应用内兜底；系统剪贴板不可用时保证应用内复制粘贴可用） */
let memoryText: string | null = null;

export const bpClipboard = {
  /**
   * 写入剪贴板：总是更新内存剪贴板；尽力同步系统剪贴板。
   * 返回是否成功写入系统剪贴板（内存兜底成功也返回 true 语义由调用方忽略）。
   */
  async writeText(text: string): Promise<boolean> {
    memoryText = text;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 权限受限 / 非安全上下文：静默降级到内存剪贴板
    }
    return false;
  },

  /**
   * 读取剪贴板文本：优先系统剪贴板（拿到外部片段），失败 / 为空回落内存剪贴板。
   * 两处都没有返回 null。
   */
  async readText(): Promise<string | null> {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) return text;
      }
    } catch {
      // 读取被拒绝（浏览器常默认拒绝读剪贴板）：回落内存剪贴板
    }
    return memoryText;
  },

  /** 当前内存剪贴板内容（调试 / 测试用） */
  peekMemory(): string | null {
    return memoryText;
  },

  /** 清空内存剪贴板（测试隔离用） */
  clearMemory(): void {
    memoryText = null;
  },
};

/** 复制片段：写内存 + 尽力写系统剪贴板（应用内永远可粘贴） */
export async function writeFragment(fragment: IRFragment): Promise<void> {
  await bpClipboard.writeText(fragmentToText(fragment));
}

/** 读取片段：系统剪贴板优先，解析失败回落内存剪贴板；都不是片段返回 null */
export async function readFragment(): Promise<IRFragment | null> {
  const text = await bpClipboard.readText();
  const fromSystem = parseFragment(text);
  if (fromSystem) return fromSystem;
  if (text !== memoryText) return null; // 系统剪贴板是别的内容，不误粘
  return parseFragment(memoryText);
}
