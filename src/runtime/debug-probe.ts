/**
 * Blueprint Studio v2 —— 运行窗口调试探针（T5.4 · 运行窗口侧，PLAN §12）
 *
 * 职责：把 BindingRunner 各运行实例的 DebugEvent 经 WS 反向通道送到编辑器叠加层。
 *  - 接线（T5.4 最小改动，见 binding.ts composeDebugSink）：onDebug → probe.push(assetPath, ev)；
 *  - **150ms 批量**：按通道（assetPath）缓冲，计时器合并发送（v1.1 pinBuffer 同思路）；
 *    单批上限 500 条防大图风暴——超出先按「同主体保最新」合并（pinValue 保留每引脚
 *    最新值、nodeEnter/Exit 每节点一条、emit 每事件名一条），仍超保留最新 500 条，
 *    丢弃数随批上报（dropped 字段，叠加层不依赖）；
 *  - **观察开关传播**：编辑器关闭观察 / 断开 → 服务端路由订阅归零 → 本侧收
 *    debug.mute 停发（缓冲清空）；恢复订阅收 debug.unmute 继续发；probe.stop() 一键关闭。
 *  - 懒 attach：某资产首个事件 push 时自动发 debug.attach（BindingRunner 无需额外接线）。
 *
 * 可注入：transport（测试替身 / 自定义发送）、batchMs / maxBatch（测试用小值）。
 * 不依赖 DOM；浏览器 WebSocket 经 DebugWsClient（断线重连指数退避上限 5s）。
 */
import type { DebugEvent } from './interpreter/types';
import { DebugWsClient } from '../shell/debug/debug-ws';
import type { DebugClientMessage } from '../shell/debug/protocol';

/** 默认批量窗口（任务卡 DoD：150ms） */
export const PROBE_BATCH_MS = 150;
/** 默认单批上限（防大图风暴） */
export const PROBE_MAX_BATCH = 500;
/** 断线期间缓冲上限（4 批；超出丢最旧——观察通道允许丢帧，不允许拖垮运行窗口） */
const MAX_BUFFER_MULTIPLIER = 4;

/**
 * 批量合并（纯函数，单测 2）：
 * - 总量 ≤ maxBatch：原样透传（保序）；
 * - 超限：先按合并键去重保最新（pinValue → graph:nodeId:pinId；nodeEnter/nodeExit →
 *   graph:nodeId；emit → graph:message；nodeError → graph:nodeId:message），
 *   仍超 maxBatch → 保留最新 maxBatch 条（时间序靠后优先），返回丢弃数。
 */
export function coalesceBatch(
  events: readonly DebugEvent[],
  maxBatch: number = PROBE_MAX_BATCH,
): { events: DebugEvent[]; dropped: number } {
  if (events.length <= maxBatch) return { events: [...events], dropped: 0 };
  const keep = new Map<string, DebugEvent>();
  for (const ev of events) keep.set(coalesceKey(ev), ev); // 后写覆盖 = 同主体保最新
  let merged = [...keep.values()];
  let dropped = 0;
  if (merged.length > maxBatch) {
    dropped = merged.length - maxBatch;
    merged = merged.slice(merged.length - maxBatch); // 保留最新段
  }
  return { events: merged, dropped };
}

/** 合并键（同键事件保最新一条） */
function coalesceKey(ev: DebugEvent): string {
  switch (ev.kind) {
    case 'pinValue':
      return `pv:${ev.graph}:${ev.nodeId ?? ''}:${ev.pinId ?? ''}`;
    case 'nodeEnter':
    case 'nodeExit':
      return `${ev.kind}:${ev.graph}:${ev.nodeId ?? ''}`;
    case 'emit':
      return `emit:${ev.graph}:${ev.message ?? ''}`;
    case 'nodeError':
      return `err:${ev.graph}:${ev.nodeId ?? ''}:${ev.message ?? ''}`;
    default:
      return `${String((ev as { kind?: unknown }).kind)}:${ev.ts}`; // 未知种类：按事件本身保留
  }
}

/** 发送通道抽象（测试替身；真实实现 = DebugWsClient.send） */
export interface DebugProbeTransport {
  /** 返回 false = 未连接（事件继续缓冲，重连后随下一批发出） */
  send(msg: DebugClientMessage): boolean;
}

/** DebugProbe 可选项 */
export interface DebugProbeOptions {
  /** 项目名（attach / batch 报文首段标识） */
  project: string;
  /** 发送通道；缺省自建 DebugWsClient（断线自动重连） */
  transport?: DebugProbeTransport;
  /** 批量窗口毫秒（缺省 150） */
  batchMs?: number;
  /** 单批上限（缺省 500） */
  maxBatch?: number;
}

/** 通道缓冲（每 assetPath 独立缓冲 + 计时器；mute 时清空停发） */
interface ProbeChannel {
  assetPath: string;
  /** 已向服务端 attach（懒触发，一次） */
  attached: boolean;
  /** 服务端要求停发（订阅归零）：清缓冲、停计时，push 直接丢弃 */
  muted: boolean;
  buffer: DebugEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 运行窗口调试探针：一个运行窗口一个实例（多资产多通道），窗口关闭 stop()。
 * 生命周期：首次 push 懒连接 + attach → 150ms 批量发送 → stop() 清理并断开。
 */
export class DebugProbe {
  private readonly transport: DebugProbeTransport;
  private readonly ownsTransport: boolean;
  private readonly batchMs: number;
  private readonly maxBatch: number;
  /** 项目名（attach / batch 报文首段标识） */
  private readonly project: string;
  /** 自建客户端（transport 注入时为 undefined） */
  private ownedClient?: DebugWsClient;
  private readonly channels = new Map<string, ProbeChannel>();
  private stopped = false;

  constructor(opts: DebugProbeOptions) {
    this.project = opts.project;
    this.batchMs = Math.max(1, opts.batchMs ?? PROBE_BATCH_MS);
    this.maxBatch = Math.max(1, opts.maxBatch ?? PROBE_MAX_BATCH);
    if (opts.transport) {
      this.transport = opts.transport;
      this.ownsTransport = false;
    } else {
      // 自建客户端：懒连接（首次 send 时 connect，无绑定的运行窗口不开 WS），stop 时一并关闭
      const client = new DebugWsClient();
      this.transport = client;
      this.ownsTransport = true;
      this.ownedClient = client;
    }
  }

  /**
   * 推入一条调试事件（BindingRunner onDebug 接线；逐条同步调用，内部批量）。
   * stop 后静默丢弃；mute 通道丢弃（订阅归零，编辑器本就看不到）。
   */
  push(assetPath: string, ev: DebugEvent): void {
    if (this.stopped || !assetPath) return;
    const ch = this.ensureChannel(assetPath);
    if (ch.muted) return;
    ch.buffer.push(ev);
    // 断线积压保护：超过 4 批容量丢最旧（连接恢复后发的是「最新视图」，观察语义允许）
    const cap = this.maxBatch * MAX_BUFFER_MULTIPLIER;
    if (ch.buffer.length > cap) {
      ch.buffer.splice(0, ch.buffer.length - cap);
    }
    if (ch.timer === null) {
      ch.timer = setTimeout(() => {
        ch.timer = null;
        this.flushChannel(ch);
      }, this.batchMs);
    }
  }

  /**
   * 服务端报文入口（观察开关传播）：mute=停发清缓冲；unmute=恢复发送。
   * 只处理本 probe project 的通道（防串扰）。
   */
  onServerMessage(msg: { type?: string; project?: unknown; assetPath?: unknown }): void {
    if (!msg || (msg.type !== 'debug.mute' && msg.type !== 'debug.unmute')) return;
    if (typeof msg.assetPath !== 'string' || msg.project !== this.project) return;
    const ch = this.channels.get(msg.assetPath);
    if (!ch) return;
    if (msg.type === 'debug.mute') {
      ch.muted = true;
      this.clearChannelBuffer(ch);
    } else {
      ch.muted = false;
    }
  }

  /** 一键关闭（观察开关 / 窗口卸载）：清全部通道 + 关闭自建客户端。幂等。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const ch of this.channels.values()) this.clearChannelBuffer(ch);
    this.channels.clear();
    if (this.ownsTransport) this.ownedClient?.close();
  }

  /* ---------------- 内部 ---------------- */

  private ensureChannel(assetPath: string): ProbeChannel {
    let ch = this.channels.get(assetPath);
    if (!ch) {
      ch = { assetPath, attached: false, muted: false, buffer: [], timer: null };
      this.channels.set(assetPath, ch);
    }
    if (!ch.attached) {
      ch.attached = true;
      this.sendNow({
        type: 'debug.attach',
        project: this.project,
        assetPath,
      });
    }
    return ch;
  }

  /** 计时器到点：合并 + 发送（未连接则保留缓冲等下一窗口） */
  private flushChannel(ch: ProbeChannel): void {
    if (this.stopped || ch.muted || ch.buffer.length === 0) return;
    const { events, dropped } = coalesceBatch(ch.buffer, this.maxBatch);
    if (events.length === 0) {
      ch.buffer = [];
      return;
    }
    const sent = this.sendNow({
      type: 'debug.batch',
      project: this.project,
      assetPath: ch.assetPath,
      events,
      ...(dropped > 0 ? { dropped } : {}),
    });
    if (sent) ch.buffer = []; // 未发出（断线）：保留缓冲，随下一窗口重试
  }

  /** 立即发送（transport 未连接返回 false；自建客户端先尝试连接） */
  private sendNow(msg: DebugClientMessage): boolean {
    if (this.ownsTransport) this.ownedClient?.connect(); // 懒连接（幂等）
    return this.transport.send(msg);
  }

  private clearChannelBuffer(ch: ProbeChannel): void {
    ch.buffer = [];
    if (ch.timer !== null) {
      clearTimeout(ch.timer);
      ch.timer = null;
    }
  }
}

/* ---------------- 构造便利 ---------------- */

/** 常用入口：new DebugProbe({ project, ...opts }) 的简写 */
export function createDebugProbe(project: string, opts?: Omit<DebugProbeOptions, 'project'>): DebugProbe {
  return new DebugProbe({ project, ...opts });
}
