/**
 * Blueprint Studio v2 —— 调试观察 WS 客户端（T5.4，浏览器侧）
 *
 * v1.1 wsClient 思路沿用：长连 + 断线自动重连（指数退避，初始 500ms，
 * 上限 5s——任务卡要求；连接成功即复位）。事件多播：多个消费方（同页多蓝图
 * 面板 / 将来 T6.4 CLI 桥）经 addListener 共享一条连接；连接成功回调 onOpen
 * （订阅方据此重发 debug.subscribe——重连后服务端订阅表已清空，必须重新登记）。
 *
 * 运行窗口（debug-probe，独享实例）与编辑器（sharedDebugWs 单例）共用本实现。
 */
import {
  parseDebugMessage,
  type DebugClientMessage,
  type DebugServerMessage,
} from './protocol';

/** 退避初始间隔（毫秒） */
const BACKOFF_BASE_MS = 500;
/** 退避上限（任务卡：指数退避上限 5s） */
const BACKOFF_MAX_MS = 5000;

export interface DebugWsHandlers {
  /** 收到服务端报文（已 JSON 解析；非 JSON 帧静默忽略） */
  onMessage?: (msg: DebugServerMessage) => void;
  /** 连接建立（含重连成功；订阅方在此重发 subscribe） */
  onOpen?: () => void;
  /** 连接断开（重连排程中） */
  onClose?: () => void;
}

export class DebugWsClient {
  /** 多播订阅者（构造 handlers 也算一个） */
  private readonly listeners = new Set<DebugWsHandlers>();
  private ws: WebSocket | null = null;
  private backoff = BACKOFF_BASE_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** 服务端 WS 地址（缺省同源 /ws；vite dev 经代理转发到本地服务） */
  private readonly url: string;

  constructor(handlers: DebugWsHandlers = {}, url?: string) {
    if (handlers.onMessage || handlers.onOpen || handlers.onClose) {
      this.listeners.add(handlers);
    }
    this.url = url ?? debugWsUrl();
  }

  /** 建立连接（幂等）；断线自动重连（指数退避，上限 5s），close() 手动停止 */
  connect(): void {
    if (this.ws || this.disposed) return;
    // 非 http(s) 页面上下文不连接：浏览器（http/https）正常接入；
    // node:test（Node 22+ 有全局 WebSocket，location 为 happy-dom about:blank /
    // 无 location）下静默不连——防止测试进程被真实 socket + 重试计时器拖住不退出。
    if (typeof location === 'undefined') return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = BACKOFF_BASE_MS; // 连接成功：退避复位
      this.emit('onOpen');
    };
    ws.onmessage = (ev: MessageEvent) => {
      const msg = parseDebugMessage(ev.data);
      if (msg) this.emit('onMessage', msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.disposed) return;
      this.emit('onClose');
      // 重连排程：unref（Node）——重连计时器不单独吊住进程（测试可正常退出；浏览器无此 API，行为不变）
      const t = setTimeout(() => this.connect(), this.backoff);
      (t as unknown as { unref?: () => void }).unref?.();
      this.retryTimer = t;
      this.backoff = Math.min(this.backoff * 1.7, BACKOFF_MAX_MS);
    };
    ws.onerror = () => {
      // onclose 会随后触发（浏览器保证），重连排程统一在 onclose 做
    };
  }

  /** 是否已连接 */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * 登记一个事件消费方（多播）；返回退订函数。
   * 消费方应在 onOpen 里重发自己的 subscribe（重连语义见文件头）。
   */
  addListener(handlers: DebugWsHandlers): () => void {
    this.listeners.add(handlers);
    return () => {
      this.listeners.delete(handlers);
    };
  }

  /** 发送协议报文；未连接返回 false（调用方决定是否缓冲） */
  send(msg: DebugClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** 手动关闭（不再重连） */
  close(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 已关闭：忽略 */
      }
    }
  }

  private emit<K extends keyof DebugWsHandlers>(kind: K, ...args: Parameters<NonNullable<DebugWsHandlers[K]>>): void {
    for (const h of [...this.listeners]) {
      const fn = h[kind] as ((...a: unknown[]) => void) | undefined;
      if (fn) fn(...args);
    }
  }
}

/** 同源 WS 地址（http→ws / https→wss） */
function debugWsUrl(): string {
  if (typeof location === 'undefined') return 'ws://localhost:8790/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/* ============================================================
 * 编辑器侧共享单例（多蓝图面板共用一条连接）
 * ============================================================ */

let shared: DebugWsClient | null = null;

/** 编辑器全局共享客户端：懒建 + 常驻（面板挂载即订阅，卸载即退订） */
export function sharedDebugWs(): DebugWsClient {
  if (!shared) {
    shared = new DebugWsClient();
    shared.connect();
  }
  return shared;
}

/** 测试收尾 / 单测隔离用（生产代码不调用） */
export function resetSharedDebugWsForTest(): void {
  shared?.close();
  shared = null;
}
