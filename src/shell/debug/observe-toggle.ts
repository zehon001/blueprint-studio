/**
 * Blueprint Studio v2 —— 「观察运行」开关状态持久化（T5.4，纯函数）
 *
 * DoD：编辑器打开蓝图视图时自动接入（默认开），用户可一键关闭；状态存
 * localStorage（key：bp.observe.enabled）。localStorage 不可用（隐私模式 /
 * node:test 无 DOM）时按缺省值降级，不抛错。
 */

/** localStorage 键 */
export const OBSERVE_STORAGE_KEY = 'bp.observe.enabled';

/** 最小存储接口（window.localStorage 的结构子集；测试注入内存替身） */
export interface ObserveStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** 读开关状态：未存过 / 存储不可用 → true（默认开——打开视图自动接入） */
export function loadObserveEnabled(
  storage?: ObserveStorageLike | null,
  fallback = true,
): boolean {
  const store = storage ?? defaultStorage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(OBSERVE_STORAGE_KEY);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

/** 写开关状态（存储不可用时静默） */
export function saveObserveEnabled(enabled: boolean, storage?: ObserveStorageLike | null): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(OBSERVE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* 配额 / 隐私模式：静默降级（开关仍可用，只是不跨会话记忆） */
  }
}

/** 浏览器 localStorage（不可用返回 null；node:test 无 window 亦安全） */
function defaultStorage(): ObserveStorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}
