/**
 * Blueprint Studio v2 —— WS Hub 正式协议·调试观察通道（T5.4 · PLAN §3.1 / §12）
 *
 * 服务端只做**路由转发**，不做批量（150ms 批量在运行窗口侧 debug-probe 完成）：
 *  - 编辑器（订阅方）：连接后发 debug.subscribe 登记「project + assetPaths」兴趣；
 *    关闭观察 / 面板关闭发 debug.unsubscribe。
 *  - 运行窗口（生产方）：连接后发 debug.attach 声明某个运行实例的 debug 流归属；
 *    之后周期性发 debug.batch，服务端按 project+assetPath 匹配转发给全部订阅者。
 *  - 订阅归零 / 恢复：服务端向生产方连接推 debug.mute / debug.unmute（边沿触发，
 *    各发一次）——运行窗口侧据此停发 / 恢复（「编辑器关闭观察 → 运行窗口停发」）。
 *
 * 报文（JSON，type 判别）：
 *  客户端 → 服务端：
 *    { type:'debug.subscribe', project, assetPaths: string[] }
 *    { type:'debug.unsubscribe', project, assetPaths?: string[] }   // 缺省 = 该 project 全部
 *    { type:'debug.attach', project, assetPath }
 *    { type:'ping' }                                                // 应用层心跳探测
 *  服务端 → 客户端：
 *    { type:'hello', hub, protocol:'debug.v1' }
 *    { type:'debug.batch', project, assetPath, events: DebugEvent[], dropped? }
 *    { type:'debug.mute', project, assetPath } / { type:'debug.unmute', ... }（→ 生产方）
 *    { type:'pong' } / { type:'error', message }
 *
 * 连接生命周期：心跳（ws ping/pong，30s 周期，两轮未回 pong 断开）；连接关闭时
 * 清理该连接的订阅与生产登记，并按边沿规则补发 mute。
 */
import type { WebSocket, WebSocketServer } from 'ws';

/** 通道键（project + assetPath 唯一确定一条 debug 流） */
function channelKey(project: string, assetPath: string): string {
  return `${project}\u0000${assetPath}`;
}

/** 心跳周期（毫秒）；传 null 关闭（测试用） */
export const HEARTBEAT_MS = 30_000;

/** hub 统计快照（健康接口 / 测试断言用） */
export interface WsHubStats {
  /** 存活连接数 */
  connections: number;
  /** 有订阅者的通道数 */
  subscribedChannels: number;
  /** 有生产者的通道数（运行实例数） */
  attachedChannels: number;
}

/** hub 可选项 */
export interface WsDebugHubOptions {
  /** 心跳周期毫秒；null 关闭心跳（测试用）；缺省 HEARTBEAT_MS */
  heartbeatMs?: number | null;
}

/** 连接登记（该连接订阅了哪些通道 / 生产了哪些通道） */
interface ConnState {
  /** 订阅的通道键集合 */
  subscriptions: Set<string>;
  /** 生产（attach）的通道键集合 */
  productions: Set<string>;
  /** 心跳存活标记 */
  alive: boolean;
}

/**
 * 调试观察 WS hub：登记订阅 / 生产、按通道路由 debug.batch、边沿推 mute/unmute。
 * 纯路由器——不解释事件内容，不缓存（离线订阅者不补发）。
 */
export class WsDebugHub {
  private readonly heartbeatMs: number | null;
  private readonly conns = new WeakMap<WebSocket, ConnState>();
  /** 通道 → 订阅者连接集合 */
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  /** 通道 → 生产者连接集合（一个运行窗口可 attach 多个资产） */
  private readonly producers = new Map<string, Set<WebSocket>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WsDebugHubOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs === undefined ? HEARTBEAT_MS : opts.heartbeatMs;
    if (this.heartbeatMs !== null) {
      this.heartbeatTimer = setInterval(() => this.sweepHeartbeat(), this.heartbeatMs);
      // unref：不阻止进程按正常生命周期退出（与 server 整体生命周期一致）
      this.heartbeatTimer.unref?.();
    }
  }

  /** 绑定到既有的 WebSocketServer（server/index.ts 接线；测试可直接调 handleConnection） */
  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws: WebSocket) => this.handleConnection(ws));
  }

  /** 处理一条新连接：登记 + hello + 心跳标记 + 消息分发 */
  handleConnection(ws: WebSocket): void {
    this.conns.set(ws, { subscriptions: new Set(), productions: new Set(), alive: true });
    ws.on('pong', () => {
      const st = this.conns.get(ws);
      if (st) st.alive = true;
    });
    ws.on('message', (raw) => this.handleMessage(ws, raw));
    ws.on('close', () => this.handleClose(ws));
    ws.on('error', () => ws.close());
    this.send(ws, { type: 'hello', hub: 'blueprint-studio-v2', protocol: 'debug.v1' });
  }

  /** 统计快照 */
  stats(): WsHubStats {
    let subscribedChannels = 0;
    for (const set of this.subscribers.values()) if (set.size > 0) subscribedChannels++;
    let attachedChannels = 0;
    for (const set of this.producers.values()) if (set.size > 0) attachedChannels++;
    return { connections: this.countConns(), subscribedChannels, attachedChannels };
  }

  /** 停止心跳（测试收尾 / 优雅关闭用；hub 本体可继续路由） */
  dispose(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* ---------------- 内部 ---------------- */

  private countConns(): number {
    // WeakMap 不可枚举：连接数由各通道集合去重统计（空连接（未订阅未生产）不计——
    // 仅影响健康接口的展示口径，语义为「参与调试观察的连接数」）
    const seen = new Set<WebSocket>();
    for (const set of this.subscribers.values()) for (const ws of set) seen.add(ws);
    for (const set of this.producers.values()) for (const ws of set) seen.add(ws);
    return seen.size;
  }

  /** 心跳清扫：两轮未回 pong 的连接判死断开（close 处理器完成清理） */
  private sweepHeartbeat(): void {
    this.eachConn((ws, st) => {
      if (!st.alive) {
        ws.terminate();
        return;
      }
      st.alive = false;
      try {
        ws.ping();
      } catch {
        /* 已死连接：等 close 事件清理 */
      }
    });
  }

  private eachConn(fn: (ws: WebSocket, st: ConnState) => void): void {
    // WeakMap 不可枚举：经由两个通道集合触达全部活跃连接
    const seen = new Set<WebSocket>();
    const visit = (set: Set<WebSocket> | undefined) => {
      if (!set) return;
      for (const ws of set) {
        if (seen.has(ws)) continue;
        seen.add(ws);
        const st = this.conns.get(ws);
        if (st) fn(ws, st);
      }
    };
    for (const set of this.subscribers.values()) visit(set);
    for (const set of this.producers.values()) visit(set);
  }

  /** 单条消息分发（非 JSON / 形状非法 → error 报文，不断连接） */
  private handleMessage(ws: WebSocket, raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      this.send(ws, { type: 'error', message: '报文不是合法 JSON' });
      return;
    }
    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        return;
      case 'debug.subscribe':
        this.onSubscribe(ws, msg);
        return;
      case 'debug.unsubscribe':
        this.onUnsubscribe(ws, msg);
        return;
      case 'debug.attach':
        this.onAttach(ws, msg);
        return;
      case 'debug.batch':
        this.onBatch(ws, msg);
        return;
      default:
        this.send(ws, { type: 'error', message: `未知报文类型：${String(msg.type)}` });
    }
  }

  /** 订阅：登记该连接对 project+assetPaths 的兴趣（同 project 增量累积，幂等） */
  private onSubscribe(ws: WebSocket, msg: Record<string, unknown>): void {
    const project = strField(msg.project);
    const assetPaths = strArrayField(msg.assetPaths);
    if (!project || assetPaths.length === 0) {
      this.send(ws, { type: 'error', message: 'debug.subscribe 需要 project 与非空 assetPaths' });
      return;
    }
    const st = this.conns.get(ws);
    if (!st) return;
    const becameSubscribed: string[] = [];
    for (const assetPath of assetPaths) {
      const key = channelKey(project, assetPath);
      if (st.subscriptions.has(key)) continue;
      st.subscriptions.add(key);
      let set = this.subscribers.get(key);
      if (!set) {
        set = new Set();
        this.subscribers.set(key, set);
      }
      set.add(ws);
      if (set.size === 1) becameSubscribed.push(key); // 通道从 0 → 1 订阅者：唤醒生产方
    }
    for (const key of becameSubscribed) this.notifyProducers(key, 'debug.unmute');
  }

  /** 退订：assetPaths 缺省 = 退订该 project 全部通道；归零通道向生产方发 mute */
  private onUnsubscribe(ws: WebSocket, msg: Record<string, unknown>): void {
    const project = strField(msg.project);
    if (!project) {
      this.send(ws, { type: 'error', message: 'debug.unsubscribe 需要 project' });
      return;
    }
    const st = this.conns.get(ws);
    if (!st) return;
    // 键过滤（project 前缀匹配，避免同 assetPath 跨项目误删）；
    // assetPaths 缺省 = 退订该 project 全部通道，否则只退订列出的
    const wanted = msg.assetPaths === undefined ? null : strArrayField(msg.assetPaths);
    const dropped: string[] = [];
    for (const key of [...st.subscriptions]) {
      const [p, a] = key.split('\u0000');
      if (p !== project) continue;
      if (wanted !== null && !wanted.includes(a)) continue;
      st.subscriptions.delete(key);
      const set = this.subscribers.get(key);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          this.subscribers.delete(key);
          dropped.push(key); // 通道订阅归零：静默生产方
        }
      }
    }
    for (const key of dropped) this.notifyProducers(key, 'debug.mute');
  }

  /** 生产登记：运行窗口声明某资产的 debug 流归属（重复 attach 幂等） */
  private onAttach(ws: WebSocket, msg: Record<string, unknown>): void {
    const project = strField(msg.project);
    const assetPath = strField(msg.assetPath);
    if (!project || !assetPath) {
      this.send(ws, { type: 'error', message: 'debug.attach 需要 project 与 assetPath' });
      return;
    }
    const st = this.conns.get(ws);
    if (!st) return;
    const key = channelKey(project, assetPath);
    st.productions.add(key);
    let set = this.producers.get(key);
    if (!set) {
      set = new Set();
      this.producers.set(key, set);
    }
    const isNew = !set.has(ws);
    set.add(ws);
    // 晚到的运行窗口补齐订阅现状（mute/unmute 是边沿报文，attach 前的边沿收不到）：
    // 通道已有订阅者 → unmute（开始发）；无订阅者 → mute（观察已关，停发）
    if (isNew) {
      const subscribers = this.subscribers.get(key);
      this.send(ws, {
        type: subscribers && subscribers.size > 0 ? 'debug.unmute' : 'debug.mute',
        project,
        assetPath,
      });
    }
  }

  /**
   * 批量转发：按 project+assetPath 匹配订阅者广播（排除发送连接自身）。
   * 容错：未 attach 的连接直接发 batch → 视为隐式生产登记（attach 报文丢失/乱序时仍可路由）。
   */
  private onBatch(ws: WebSocket, msg: Record<string, unknown>): void {
    const project = strField(msg.project);
    const assetPath = strField(msg.assetPath);
    if (!project || !assetPath || !Array.isArray(msg.events)) {
      this.send(ws, { type: 'error', message: 'debug.batch 需要 project / assetPath / events' });
      return;
    }
    const key = channelKey(project, assetPath);
    const st = this.conns.get(ws);
    if (st && !st.productions.has(key)) {
      st.productions.add(key);
      let set = this.producers.get(key);
      if (!set) {
        set = new Set();
        this.producers.set(key, set);
      }
      set.add(ws);
    }
    const targets = this.subscribers.get(key);
    if (!targets || targets.size === 0) return; // 无订阅者：静默丢弃（mute 报文由边沿逻辑负责）
    const payload = JSON.stringify({
      type: 'debug.batch',
      project,
      assetPath,
      events: msg.events,
      ...(typeof msg.dropped === 'number' && msg.dropped > 0 ? { dropped: msg.dropped } : {}),
    });
    for (const target of targets) {
      if (target === ws || target.readyState !== 1 /* OPEN */) continue;
      target.send(payload);
    }
  }

  /** 连接关闭：清理订阅与生产登记；订阅归零的通道向生产方补发 mute */
  private handleClose(ws: WebSocket): void {
    const st = this.conns.get(ws);
    if (!st) return;
    this.conns.delete(ws);
    const mutedChannels: string[] = [];
    for (const key of st.subscriptions) {
      const set = this.subscribers.get(key);
      if (!set) continue;
      set.delete(ws);
      if (set.size === 0) {
        this.subscribers.delete(key);
        mutedChannels.push(key);
      }
    }
    for (const key of st.productions) {
      const set = this.producers.get(key);
      if (!set) continue;
      set.delete(ws);
      if (set.size === 0) this.producers.delete(key);
    }
    for (const key of mutedChannels) this.notifyProducers(key, 'debug.mute');
  }

  /** 向某通道的全部生产者连接发 mute/unmute（边沿通知；生产方据此停发/恢复） */
  private notifyProducers(key: string, kind: 'debug.mute' | 'debug.unmute'): void {
    const set = this.producers.get(key);
    if (!set) return;
    const [project, assetPath] = key.split('\u0000');
    for (const ws of set) {
      if (ws.readyState !== 1) continue;
      this.send(ws, { type: kind, project, assetPath });
    }
  }

  private send(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* 发送失败交给 close/error 处理 */
    }
  }
}

/* ---------------- 报文字段工具 ---------------- */

function strField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
