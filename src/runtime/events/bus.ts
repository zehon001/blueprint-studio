/**
 * Blueprint Studio v2 —— 运行时事件总线（T5.1 · PLAN §11 事件系统）
 *
 * 四类事件源统一入队（FIFO 保序），按目标路由（node / ui / all）投递到注册的
 * 解释器实例；每实例的执行仍走其解释器串行事件队列（总线不并发闯入）：
 *  ① UI 节点事件：routeEvent（renderUI onEvent → BindingRunner）——交付给绑定该
 *     节点名的 runtime（target='node' 语义），payload 统一包 { value }（T2.6 契约）；
 *  ② 系统事件：pushSystem（start 之外的 timer tick / 窗口可见性等；start 由各实例
 *     自行触发，总线不广播）；
 *  ③ 插件推送：pushPlugin（T6.4 CLI 桥接此口）；
 *  ④ 自定义事件：蓝图 ctx.emit / event.send —— 经解释器 onDebug('emit') 回灌
 *     （零侵入，T2.6 hubDebugSink 同模式；见 runtimeEventSink），本实例已在自身
 *     串行队列分发过，总线只向其它实例转发。
 *
 * 目标路由（任务卡 DoD）：
 *  - node：仅「本节点绑定的 runtime」——UI 事件按节点名查注册表 boundNodes；
 *    自定义事件的本节点 = 发送实例自身（其本地分发已发生，总线无需再投）；
 *  - ui：本 UI 实例（同 uiId 的 runtime 组；BindingRunner 一个运行窗口一个 UI 实例）；
 *  - all：全部实例（跨 UI 广播）。
 *
 * 环保护（解决 T2.6 遗留的 A↔B 互 relay 死循环）：
 *  - 回声令牌：总线每次投递注入 BUS_ECHO_KEY 令牌；接收实例出队回灌时令牌被消费、
 *    事件被吞——防止「总线投递 → 实例分发回灌 → 总线再转发」的自激；
 *  - 中继跳数：某实例「刚收到过同名投递又发出同名事件」视为继续同一传播链（+1 跳），
 *    链上同名事件累计超过 maxHops（默认 8）即丢弃并 print 警告；外部源（UI / 系统 /
 *    插件）的新输入视为全新传播链（跳数复位），同名事件的独立发布不受历史计数拖累。
 *
 * 参数规范化：args 按原样透传（T3.2 emit 约定：对象展开 / 数组→{args} / 单值→{value}，
 * 由 event.send 节点完成）；IREventDef 具名参数按名注入输出脚由解释器负责（T2.5 / T5.3）。
 */
import type { DebugEvent, RuntimeHandle } from '../interpreter/types';
import { BUS_TARGET_KEY, BUS_ECHO_KEY, BUS_SOURCE_NODE_KEY } from './markers';

/* ============================================================
 * 对外类型
 * ============================================================ */

/** 路由目标：node=仅本节点绑定的实例；ui=本 UI 实例；all=全部实例（跨 UI 广播） */
export type RouteTarget = 'node' | 'ui' | 'all';

/** 事件源类别（与 PLAN §11 四类源对应） */
export type BusSourceKind = 'ui' | 'system' | 'plugin' | 'custom';

/** 事件源（kind + 源标识：ui=节点名 / system=系统源 / plugin=插件 id / custom=runtime id） */
export interface BusEventSource {
  kind: BusSourceKind;
  id: string;
}

/** 总线调试探针（T5.2 事件面板 / T5.4 调试观察消费；逐条同步回调） */
export interface BusDebugEvent {
  /** enqueue=入队；deliver=投递（to 为空表示无匹配实例）；drop=环保护截断 / 形状丢弃 */
  kind: 'enqueue' | 'deliver' | 'drop';
  /** 事件名 */
  name: string;
  /** 事件源 */
  source: BusEventSource;
  /** 本条解析出的路由目标 */
  target: RouteTarget;
  /** 传播链跳数（0 = 全新传播链） */
  hops: number;
  /** 投递目标实例 id（仅 deliver） */
  to?: string[];
  /** 时间戳（epoch 毫秒） */
  ts: number;
}

/** 解释器实例的注册信息（总线路由依据） */
export interface BusRuntimeRegistration {
  /** 实例 id（总线内唯一；重复注册覆盖） */
  id: string;
  /** 逻辑资产路径（如 'logic/main.bp.json'；观测用，路由不经它） */
  assetPath: string;
  /** 所属 UI 实例 id（同 UI 的实例组；缺省 'default'。BindingRunner 一个窗口一个 UI） */
  uiId?: string;
  /** 绑定的 UI 节点名集合（routeEvent / target='node' 的路由依据） */
  boundNodes?: ReadonlySet<string>;
  /** 解释器运行句柄（总线经 rt.emit 投递，执行仍走该实例的串行事件队列） */
  rt: RuntimeHandle;
}

/** pushSystem / pushPlugin 的路由选项 */
export interface BusPushOptions {
  /** 路由目标（缺省 'ui'） */
  target?: RouteTarget;
  /** target='node' 时的目标 UI 节点名（缺省视为形状不合法，丢弃并警告） */
  node?: string;
  /** target='ui' 时的 UI 实例 id（缺省 'default'） */
  uiId?: string;
}

/** createEventBus 可选项 */
export interface EventBusOptions {
  /** 调试探针（T5.2 / T5.4）：入队 / 投递 / 截断逐条同步回调 */
  onDebug?: (ev: BusDebugEvent) => void;
  /** 警告 print（环保护截断等；缺省静默） */
  onWarn?: (message: string) => void;
  /** 同一事件名单次传播链的最大转发跳数（默认 8；超出丢弃并警告） */
  maxHops?: number;
  /** 「收到投递后多久内再发布同名事件」视为继续同一传播链（中继识别窗口，默认 1000ms） */
  relayWindowMs?: number;
}

/** 注册表快照（T5.2 事件面板 / 调试观察用） */
export interface BusRegistrationSnapshot {
  id: string;
  assetPath: string;
  uiId: string;
  boundNodes: string[];
}

/* ============================================================
 * 内部结构
 * ============================================================ */

/** 默认 UI 实例 id（未显式分组的实例归属） */
const DEFAULT_UI_ID = 'default';
/** 同名事件单次传播链默认最大转发跳数 */
const DEFAULT_MAX_HOPS = 8;
/** 中继识别窗口默认值（毫秒） */
const DEFAULT_RELAY_WINDOW_MS = 1000;
/** 已发出回执令牌的容量上限（FIFO 淘汰；未运行实例不回灌，令牌需有界回收） */
const MAX_ISSUED_TOKENS = 1024;
/** 最近投递时间表的容量上限（超出整体清空，仅影响中继识别的连续性，不影响正确性） */
const MAX_DELIVERY_MEMORY = 4096;

/** 队列条目：一次待投递的事件发布 */
interface Publication {
  name: string;
  args: Record<string, unknown>;
  source: BusEventSource;
  target: RouteTarget;
  /** target='node' 的目标节点名（UI 事件 = 源节点名；插件 / 系统事件经 opts.node 指定） */
  nodeName?: string;
  /** target='ui' 的显式 UI 实例 id（系统 / 插件事件用；自定义事件取源实例的 uiId） */
  uiId?: string;
  /** 传播链跳数（0 = 全新链） */
  hops: number;
}

/** 合法的路由目标值（总线内外一切 target 入口的白名单） */
function normalizeTarget(v: unknown): RouteTarget | undefined {
  return v === 'node' || v === 'ui' || v === 'all' ? v : undefined;
}

/* ============================================================
 * 事件总线
 * ============================================================ */
export class EventBus {
  private readonly opts: EventBusOptions;
  private readonly maxHops: number;
  private readonly relayWindowMs: number;

  /** 实例注册表（键 = 实例 id） */
  private readonly regs = new Map<string, BusRuntimeRegistration>();
  /** 串行投递队列（FIFO；泵动中入队只追加不递归） */
  private readonly pending: Publication[] = [];
  private pumping = false;

  /** 已发出的回执令牌（回声识别；FIFO 淘汰） */
  private readonly issuedTokens = new Set<string>();
  private readonly tokenOrder: string[] = [];
  private tokenSeq = 0;

  /** 各事件名当前传播链的累计跳数（环保护计数；回声不计，外部新输入复位） */
  private readonly chainHops = new Map<string, number>();
  /** 最近一次向某实例投递某事件名的时间（键 = `${rtId}:${name}`；中继识别） */
  private readonly lastDeliveryAt = new Map<string, number>();

  constructor(opts: EventBusOptions = {}) {
    this.opts = opts;
    this.maxHops = Math.max(1, opts.maxHops ?? DEFAULT_MAX_HOPS);
    this.relayWindowMs = Math.max(0, opts.relayWindowMs ?? DEFAULT_RELAY_WINDOW_MS);
  }

  /* ---------------- 注册表 ---------------- */

  /** 登记一个解释器实例（id 重复时覆盖旧注册） */
  register(reg: BusRuntimeRegistration): void {
    this.regs.set(reg.id, {
      ...reg,
      uiId: reg.uiId ?? DEFAULT_UI_ID,
      boundNodes: reg.boundNodes ?? new Set<string>(),
    });
  }

  /** 移除实例（stop 后调用；此后事件不再投递给它） */
  unregister(id: string): void {
    this.regs.delete(id);
  }

  /** 注册表快照（T5.2 事件面板 / 调试观察用） */
  registrations(): BusRegistrationSnapshot[] {
    return [...this.regs.values()].map((r) => ({
      id: r.id,
      assetPath: r.assetPath,
      uiId: r.uiId ?? DEFAULT_UI_ID,
      boundNodes: [...(r.boundNodes ?? [])],
    }));
  }

  /* ---------------- ① UI 节点事件 ---------------- */

  /**
   * UI 节点事件入队（renderUI onEvent → BindingRunner.routeEvent → 这里）：
   * 交付给绑定该节点名的实例（target='node' 语义）；payload 统一包 { value }
   * （T2.6 契约：解释器注入 event.custom 的 value / arg0 输出脚）；并注入
   * sourceNode=来源节点名（ADR-010 §3：同蓝图多控件时按来源分派，出脚同名可见）。
   * 节点名不属于任何绑定 / 事件名空 → 静默丢弃。
   * 参数形状与 renderUI 的 UIRenderEvent 兼容（nodeName / event / payload，nodeType 忽略）。
   */
  routeEvent(evt: { nodeName: string; event: string; nodeType?: string; payload?: unknown }): void {
    const name = typeof evt.event === 'string' ? evt.event : '';
    if (!name || typeof evt.nodeName !== 'string' || evt.nodeName === '') return;
    const args: Record<string, unknown> = evt.payload === undefined ? {} : { value: evt.payload };
    args[BUS_SOURCE_NODE_KEY] = evt.nodeName;
    this.chainHops.set(name, 0); // 外部新输入：全新传播链
    this.enqueue({
      name,
      args,
      source: { kind: 'ui', id: evt.nodeName },
      target: 'node',
      nodeName: evt.nodeName,
      hops: 0,
    });
  }

  /* ---------------- ② 系统事件 ---------------- */

  /**
   * 系统事件入队（timer tick / 窗口可见性等；'start' 由各实例自行触发不经总线）。
   * target 缺省 'ui'：投递给同 UI 实例组的全部实例。
   */
  pushSystem(name: string, args?: Record<string, unknown>, opts?: BusPushOptions): void {
    if (!name) return;
    this.pushExternal('system', 'system', name, args, opts);
  }

  /* ---------------- ③ 插件推送 ---------------- */

  /**
   * 插件推送入队（T6.4 CLI 桥接此口）：插件侧事件流（如 phoneLog.onLine）推给蓝图。
   * target 缺省 'ui'；target='node' 时必须给 opts.node（目标 UI 节点名）。
   */
  pushPlugin(pluginId: string, event: string, args?: Record<string, unknown>, opts?: BusPushOptions): void {
    if (!pluginId || !event) return;
    this.pushExternal('plugin', pluginId, event, args, opts);
  }

  /** 系统 / 插件事件的公共入队（外部源：全新传播链，跳数复位） */
  private pushExternal(
    kind: 'system' | 'plugin',
    sourceId: string,
    name: string,
    args: Record<string, unknown> | undefined,
    opts: BusPushOptions | undefined,
  ): void {
    const target = normalizeTarget(opts?.target) ?? 'ui';
    if (target === 'node' && !(typeof opts?.node === 'string' && opts.node !== '')) {
      this.probe({ kind: 'drop', name, source: { kind, id: sourceId }, target, hops: 0 });
      this.opts.onWarn?.(`[事件总线] 事件「${name}」target=node 需要目标节点名（opts.node），已丢弃（源：${sourceId}）`);
      return;
    }
    this.chainHops.set(name, 0); // 外部新输入：全新传播链
    this.enqueue({
      name,
      args: args && typeof args === 'object' ? { ...args } : {},
      source: { kind, id: sourceId },
      target,
      nodeName: opts?.node,
      uiId: opts?.uiId,
      hops: 0,
    });
  }

  /* ---------------- ④ 自定义事件（解释器回灌） ---------------- */

  /**
   * 运行时事件回灌（零侵入接桥：解释器每次事件出队都发 onDebug({kind:'emit'})，
   * 见 runtimeEventSink；本方法据此把事件纳入总线路由）。
   * - 'start' 是生命周期事件（各实例自行触发）：不广播（T2.6 语义）；
   * - 带未消费回执令牌的回灌 = 本总线投递在接收实例的分发回声：吞掉（防自激）；
   * - 其余视为该实例的对外发布：本实例已在自身队列分发过，只向其它实例转发；
   * - BUS_TARGET_KEY（event.send 的 target 引脚写入）读取后剥离；
   * - 环保护：本实例刚收到过同名投递又再发布 → 跳数 +1，超限丢弃并警告。
   */
  publishFromRuntime(runtimeId: string, name: string, rawArgs?: Record<string, unknown>): void {
    if (!name || name === 'start') return;
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
    // 回声识别：令牌仍在已发集合 → 这是接收实例对总线投递的分发回声，吞掉
    const token = args[BUS_ECHO_KEY];
    if (typeof token === 'string' && this.issuedTokens.delete(token)) return;
    delete args[BUS_ECHO_KEY]; // 令牌已消费 / 过期（容量淘汰）：残留键不外传
    const target = normalizeTarget(args[BUS_TARGET_KEY]) ?? 'ui';
    delete args[BUS_TARGET_KEY];

    // 环保护跳数：本实例「刚收到同名投递又发布同名事件」= 中继续链（+1）；否则全新链（复位）
    const memKey = `${runtimeId}:${name}`;
    const last = this.lastDeliveryAt.get(memKey);
    const hops =
      last !== undefined && Date.now() - last <= this.relayWindowMs
        ? (this.chainHops.get(name) ?? 0) + 1
        : 0;
    this.chainHops.set(name, hops);
    if (hops > this.maxHops) {
      this.probe({ kind: 'drop', name, source: { kind: 'custom', id: runtimeId }, target, hops });
      this.opts.onWarn?.(
        `[事件总线] 事件「${name}」传播超过 ${this.maxHops} 跳已截断（源实例 ${runtimeId}；疑似 A↔B 互发环）`,
      );
      return;
    }
    this.enqueue({ name, args, source: { kind: 'custom', id: runtimeId }, target, hops });
  }

  /* ---------------- 队列泵与投递 ---------------- */

  /** 入队并启动泵（泵动中调用只追加，不递归——与解释器队列同语义） */
  private enqueue(pub: Publication): void {
    this.probe({ kind: 'enqueue', name: pub.name, source: pub.source, target: pub.target, hops: pub.hops });
    this.pending.push(pub);
    this.pump();
  }

  /** 泵：FIFO 逐条投递；已在泵动时直接返回（处理中入队的条目由在动循环继续消费） */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        this.deliver(this.pending.shift()!);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** 投递一条发布：按 target 过滤注册表，向命中实例 rt.emit（执行走其串行队列） */
  private deliver(pub: Publication): void {
    const targets = this.targetsFor(pub);
    if (targets.length === 0) return; // 无匹配实例：静默（与 T2.6 routeEvent 未绑定语义一致）
    const to: string[] = [];
    const now = Date.now();
    for (const reg of targets) {
      // 每个投递独立回执令牌：接收实例分发回灌时逐个消费（防多实例回声互相误判为中继）
      const token = this.mintToken();
      this.lastDeliveryAt.set(`${reg.id}:${pub.name}`, now);
      if (this.lastDeliveryAt.size > MAX_DELIVERY_MEMORY) this.lastDeliveryAt.clear();
      reg.rt.emit(pub.name, { ...pub.args, [BUS_ECHO_KEY]: token });
      to.push(reg.id);
    }
    this.probe({ kind: 'deliver', name: pub.name, source: pub.source, target: pub.target, hops: pub.hops, to });
  }

  /** 按 target 过滤实例（custom 源排除自身——本实例已在自身队列分发过该事件） */
  private targetsFor(pub: Publication): BusRuntimeRegistration[] {
    const excludeId = pub.source.kind === 'custom' ? pub.source.id : undefined;
    const regs = [...this.regs.values()];
    switch (pub.target) {
      case 'node': {
        if (!pub.nodeName) return [];
        return regs.filter((r) => r.boundNodes?.has(pub.nodeName!) ?? false);
      }
      case 'ui': {
        const src = pub.source.kind === 'custom' ? this.regs.get(pub.source.id) : undefined;
        const uiId = pub.uiId ?? src?.uiId ?? DEFAULT_UI_ID;
        return regs.filter((r) => r.uiId === uiId && r.id !== excludeId);
      }
      case 'all':
        return regs.filter((r) => r.id !== excludeId);
    }
  }

  /** 铸造回执令牌（FIFO 容量淘汰：未运行实例不回灌，令牌需有界回收） */
  private mintToken(): string {
    const token = `t${++this.tokenSeq}`;
    this.issuedTokens.add(token);
    this.tokenOrder.push(token);
    while (this.tokenOrder.length > MAX_ISSUED_TOKENS) {
      const stale = this.tokenOrder.shift();
      if (stale !== undefined) this.issuedTokens.delete(stale);
    }
    return token;
  }

  /** 调试探针（逐条同步发出，不排队；批量节流由消费方做） */
  private probe(ev: Omit<BusDebugEvent, 'ts'>): void {
    this.opts.onDebug?.({ ...ev, ts: Date.now() });
  }
}

/* ============================================================
 * 解释器接桥 + 工厂
 * ============================================================ */

/**
 * 构造接总线的解释器 onDebug 回调（createRuntime opts 用；hubDebugSink 的总线版）：
 * 只关心 kind='emit'（事件出队）——message=事件名、value=事件参数，回灌总线做路由。
 */
export function runtimeEventSink(
  runtimeId: string,
  bus: EventBus,
): (ev: DebugEvent) => void {
  return (ev) => {
    if (ev.kind !== 'emit') return;
    const args =
      ev.value && typeof ev.value === 'object' && !Array.isArray(ev.value)
        ? (ev.value as Record<string, unknown>)
        : undefined;
    bus.publishFromRuntime(runtimeId, ev.message ?? '', args);
  };
}

/**
 * 创建事件总线（T5.1 公共入口）。
 * @param opts 调试探针 / 警告 print / 环保护参数，见 EventBusOptions
 */
export function createEventBus(opts: EventBusOptions = {}): EventBus {
  return new EventBus(opts);
}
