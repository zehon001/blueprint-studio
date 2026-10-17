/**
 * Blueprint Studio v2 —— 调试观察 WS 协议类型（T5.4，debug.v1）
 *
 * 与 server/ws.ts 的报文一一对应（服务端独立实现路由，此处为浏览器侧类型真源）：
 *  - 编辑器（订阅方）：debug.subscribe / debug.unsubscribe → 收 debug.batch；
 *  - 运行窗口（生产方）：debug.attach → 发 debug.batch → 收 debug.mute / debug.unmute；
 *  - DebugEvent 形状见 src/runtime/interpreter/types.ts（探针事件契约真源）。
 */
import type { DebugEvent } from '../../runtime/interpreter/types';

/** 通道标识（project + assetPath 唯一确定一条 debug 流） */
export interface DebugChannelRef {
  project: string;
  assetPath: string;
}

/** 客户端 → 服务端 */
export type DebugClientMessage =
  | { type: 'debug.subscribe'; project: string; assetPaths: string[] }
  | { type: 'debug.unsubscribe'; project: string; assetPaths?: string[] }
  | { type: 'debug.attach'; project: string; assetPath: string }
  /** 运行窗口批量推送（150ms 合并在客户端完成；服务端只按通道转发） */
  | {
      type: 'debug.batch';
      project: string;
      assetPath: string;
      events: DebugEvent[];
      /** 批量上限合并时丢弃的事件条数（>0 才携带） */
      dropped?: number;
    }
  | { type: 'ping' };

/** 服务端 → 客户端 */
export type DebugServerMessage =
  | { type: 'hello'; hub: string; protocol: string }
  | {
      type: 'debug.batch';
      project: string;
      assetPath: string;
      events: DebugEvent[];
      /** 批量上限合并时丢弃的事件条数（>0 才携带） */
      dropped?: number;
    }
  | { type: 'debug.mute'; project: string; assetPath: string }
  | { type: 'debug.unmute'; project: string; assetPath: string }
  | { type: 'pong' }
  | { type: 'error'; message: string };

/** 报文类型守卫：解析一帧文本 → 协议消息；非 JSON 返回 null（调用方忽略） */
export function parseDebugMessage(raw: unknown): DebugServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as DebugServerMessage;
  } catch {
    return null;
  }
}
