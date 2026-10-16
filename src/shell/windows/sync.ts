/**
 * 多窗口同步核心（T0.4 · PLAN §3.1 窗口模型：action 广播按序重放）
 *
 * 角色与数据流（主窗是业务状态唯一写者，天然避免多窗写冲突并保序）：
 *   main   主编辑器窗口 —— 业务状态真源。把 store 变更（immer 补丁 / 快照）以单调 seq
 *          广播给全部弹窗；并执行弹窗转发来的业务动作（动作在主窗执行 → 触发广播 →
 *          弹窗按相同顺序重放）。
 *   popout 拆出窗口 —— 不写业务状态：用户动作经 sendToMain 全部转发主窗执行；
 *          接收主窗广播，按 seq 缓存重排后在本地镜像 store 重放（镜像接线见 bridge.ts）。
 *
 * 协议（BroadcastChannel，同源窗口间；消息一律 JSON 序列化传输）：
 *   有序消息 { seq, from, to, kind, payload }（seq 为发送方单调序号）：
 *     snapshot        主窗→弹窗  全量业务状态基线（hello / resync 应答；baseline 重置接收方基线）
 *     workspace-state 主窗→弹窗  workspace 快照（currentProject / openTabs / activeTabId）
 *     domain-patch    主窗→弹窗  命令域 immer 补丁（命令执行 / undo / redo 的正逆补丁）
 *     domain-reset    主窗→弹窗  命令域整体重置（registerDomainState / 移除域）
 *     history         主窗→弹窗  撤销栈长度摘要（弹窗不持有栈，仅供展示与提示）
 *     action          弹窗→主窗  业务动作请求（SyncAction，见下）
 *     resync          弹窗→主窗  镜像重放失败，请求重新全量同步
 *   无序控制消息（seq = -1，旁路投递不参与排序）：hello / ping / pong / bye
 *
 * 保序：接收方按「发送方会话」缓存重排——乱序到达先缓存，期望序号到达后连续补放；
 * 过期 / 重复序号丢弃；snapshot 携带 baseline，接收方以其序号重置期望基线
 * （弹窗中途加入时，主窗已累积的 seq 不会阻塞后续消息）。
 *
 * 心跳：弹窗每 pingIntervalMs（默认 2s）发 ping；主窗超过 lostTimeoutMs（默认 5s）
 * 未收到某弹窗的任何消息 → onPeerLost（UI 提示 + 自动合回，见 popout.ts）；
 * 弹窗超过 popoutLostTimeoutMs（默认 8s）未收到主窗任何消息 → onMainLost（自动关闭）。
 * 主窗对未知会话的 ping 也视为 hello（主窗刷新后弹窗自动重连并重新全量同步）。
 *
 * 本模块只做传输（协议 / 序列化 / 排序 / 心跳），不感知业务 store；
 * 注入 channelFactory 可在 node:test 中以内存总线替代 BroadcastChannel。
 */
import type { CommandDomain } from '@/shell/commands'
import type { OpenTabKind } from '@/shell/workspace-store'

/* ---------------- 角色 / 地址 ---------------- */

export type SyncRole = 'main' | 'popout'

/** 主窗固定地址（弹窗地址 = 自身会话 id） */
export const MAIN_ADDRESS = 'main'
/** 广播地址 */
export const ALL_ADDRESS = 'all'

/* ---------------- 有序业务动作（弹窗 → 主窗） ---------------- */

/**
 * 弹窗可请求的全部业务动作（必须可 JSON 序列化）。
 * 命令域变更以 immer 补丁描述：弹窗在镜像上算出 patches，主窗经命令栈执行
 * （runCommandBy + applyPatches recipe），撤销重做能力与主窗本地方令完全一致。
 */
export type SyncAction =
  | { type: 'workspace.openAsset'; kind: OpenTabKind; assetPath: string; title?: string }
  | { type: 'workspace.closeTab'; id: string }
  | { type: 'workspace.setActive'; id: string }
  | { type: 'workspace.markDirty'; id: string }
  | { type: 'workspace.clearDirty'; id: string }
  | { type: 'workspace.closeProject' }
  | { type: 'cmd.runPatches'; domain: CommandDomain; label: string; patches: Patch[] }
  | { type: 'cmd.undo' }
  | { type: 'cmd.redo' }

/** immer 补丁（类型来自 immer；此处独立声明避免测试环境引入 immer 运行时依赖） */
export type Patch = { op: 'add' | 'replace' | 'remove'; path: (string | number)[]; value?: unknown }

/* ---------------- 消息信封 ---------------- */

/** 有序数据消息 kind（经 seq 重排后投递给 onRemoteState） */
export type SyncDataKind =
  | 'snapshot'
  | 'workspace-state'
  | 'domain-patch'
  | 'domain-reset'
  | 'history'
  | 'action'
  | 'resync'

/** 无序控制消息 kind（旁路投递给 onControl） */
export type SyncControlKind = 'hello' | 'ping' | 'pong' | 'bye'

/** 对端元信息（hello / ping 携带；主窗据此把会话映射到面板） */
export interface PeerMeta {
  panelId?: string
  title?: string
}

export interface SyncMessage {
  /** 发送方单调序号；控制消息固定 -1 */
  seq: number
  from: string
  to: string
  kind: SyncDataKind | SyncControlKind
  payload: unknown
  /** 仅 snapshot 使用：接收方以此消息序号重置期望基线 */
  baseline?: boolean
}

/** 序列化（JSON 文本传输，跨窗口与 mock 总线行为一致） */
export function serializeMessage(msg: SyncMessage): string {
  return JSON.stringify(msg)
}

/** 反序列化 + 结构校验；非法输入返回 null（不抛错，坏消息静默丢弃） */
export function deserializeMessage(raw: unknown): SyncMessage | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const m = parsed as Record<string, unknown>
  if (typeof m.seq !== 'number' || !Number.isFinite(m.seq)) return null
  if (typeof m.from !== 'string' || m.from.length === 0) return null
  if (typeof m.to !== 'string' || m.to.length === 0) return null
  if (typeof m.kind !== 'string' || m.kind.length === 0) return null
  return {
    seq: m.seq,
    from: m.from,
    to: m.to,
    kind: m.kind as SyncMessage['kind'],
    payload: m.payload,
    ...(m.baseline === true ? { baseline: true as const } : {}),
  }
}

function isControlKind(kind: string): kind is SyncControlKind {
  return kind === 'hello' || kind === 'ping' || kind === 'pong' || kind === 'bye'
}

function extractMeta(msg: SyncMessage): PeerMeta | undefined {
  if (msg.kind !== 'hello' && msg.kind !== 'ping') return undefined
  if (typeof msg.payload !== 'object' || msg.payload === null) return undefined
  const rec = msg.payload as Record<string, unknown>
  const meta: PeerMeta = {}
  if (typeof rec.panelId === 'string') meta.panelId = rec.panelId
  if (typeof rec.title === 'string') meta.title = rec.title
  return Object.keys(meta).length > 0 ? meta : undefined
}

/* ---------------- 按序重排（纯逻辑，可独立测试） ---------------- */

export interface SeqDeliverer<T extends { seq: number }> {
  /** 投递一条消息；baseline=true 时以该消息序号重置期望基线 */
  ingest(item: T, baseline?: boolean): void
  /** 当前缓存中的乱序消息数 */
  pendingCount(): number
  /** 下一个期望序号 */
  expected(): number
}

/**
 * 按序投递器：seq === 期望值立即投递并连续补放缓存；seq 更大先缓存；
 * seq 更小（过期 / 重复）丢弃；baseline 重置基线后丢弃早于基线的缓存并补放其余。
 */
export function createSeqDeliverer<T extends { seq: number }>(deliver: (item: T) => void): SeqDeliverer<T> {
  let expected = 1
  const buffered = new Map<number, T>()

  const flush = (): void => {
    while (buffered.has(expected)) {
      const item = buffered.get(expected) as T
      buffered.delete(expected)
      deliver(item)
      expected += 1
    }
  }

  return {
    ingest(item, baseline = false) {
      if (baseline) {
        expected = item.seq
        deliver(item)
        expected = item.seq + 1
        for (const seq of [...buffered.keys()]) {
          if (seq < expected) buffered.delete(seq)
        }
        flush()
        return
      }
      if (item.seq < expected) return
      if (item.seq === expected) {
        deliver(item)
        expected += 1
        flush()
        return
      }
      buffered.set(item.seq, item)
    },
    pendingCount: () => buffered.size,
    expected: () => expected,
  }
}

/* ---------------- 通道抽象（BroadcastChannel 适配 + 测试注入） ---------------- */

/** BroadcastChannel 的最小结构子集（测试用内存总线实现同一接口） */
export interface SyncChannel {
  postMessage(data: unknown): void
  close(): void
  onmessage: ((ev: { data: unknown }) => void) | null
}

/** 默认通道：同源 BroadcastChannel（PLAN D1：浏览器弹出窗口实现多窗口） */
function defaultChannelFactory(name: string): SyncChannel {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannel }).BroadcastChannel
  if (typeof Ctor !== 'function') {
    throw new Error('[windows] 当前环境不支持 BroadcastChannel，无法进行多窗口同步')
  }
  const ch = new Ctor(name)
  const adapter: SyncChannel = {
    postMessage: (data) => {
      ch.postMessage(data)
    },
    close: () => {
      ch.close()
    },
    onmessage: null,
  }
  // 适配 DOM 事件签名：把 MessageEvent 收敛为 { data }
  Object.defineProperty(adapter, 'onmessage', {
    get: () => ch.onmessage,
    set: (handler) => {
      ch.onmessage = (ev) => {
        if (typeof handler === 'function') handler({ data: ev.data })
      }
    },
  })
  return adapter
}

/* ---------------- createWindowSync ---------------- */

export type RemoteStateListener = (kind: SyncDataKind, payload: unknown, from: string) => void
export type ControlListener = (kind: SyncControlKind, payload: unknown, from: string) => void

export interface WindowSyncOptions {
  /** 通道名（默认 'bps-sync'；同组窗口须一致；也可经 createWindowSync 第 2 参传入） */
  channelName?: string
  /** 通道工厂（默认 BroadcastChannel；测试注入内存总线） */
  channelFactory?: (name: string) => SyncChannel
  /** 时钟（默认 Date.now；测试注入） */
  now?: () => number
  /** 弹窗 ping 周期（默认 2000ms，PLAN 口径 2s） */
  pingIntervalMs?: number
  /** 失联巡检周期（默认 1000ms） */
  checkIntervalMs?: number
  /** 主窗判定弹窗失联阈值（默认 5000ms，PLAN 口径 5s） */
  lostTimeoutMs?: number
  /** 弹窗判定主窗失联阈值（默认 8000ms） */
  popoutLostTimeoutMs?: number
  /** 弹窗身份（ping / hello 携带，主窗据此映射会话 → 面板） */
  meta?: PeerMeta
  /** 主窗：某弹窗失联（心跳超时） */
  onPeerLost?: (sessionId: string, meta: PeerMeta | undefined) => void
  /** 弹窗：主窗失联（心跳超时） */
  onMainLost?: () => void
}

export interface WindowSync {
  readonly role: SyncRole
  readonly sessionId: string
  /** 弹窗 → 主窗：转发业务动作（主窗角色为 no-op，主窗自身直接 interpretAction） */
  sendToMain(action: SyncAction): void
  /** 主窗 → 全部弹窗：有序状态广播（弹窗角色为 no-op——主窗是唯一写者） */
  broadcastData(kind: SyncDataKind, payload: unknown, baseline?: boolean): void
  /** 弹窗 → 主窗：有序数据（resync 等请求） */
  sendData(kind: SyncDataKind, payload: unknown): void
  /** 无序控制消息（hello / ping / pong / bye；默认按角色路由对端） */
  sendControl(kind: SyncControlKind, payload?: unknown, to?: string): void
  /** 订阅远端有序消息（重排后投递） */
  onRemoteState(cb: RemoteStateListener): () => void
  /** 订阅远端控制消息 */
  onControl(cb: ControlListener): () => void
  /** 关闭：停心跳、清订阅、关通道 */
  close(): void
}

function safeCall(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error('[windows] 同步回调执行失败', err)
  }
}

export function createWindowSync(role: SyncRole, channelName = 'bps-sync', options: WindowSyncOptions = {}): WindowSync {
  const sessionId = `w-${Math.random().toString(36).slice(2, 10)}`
  // 主窗以固定地址收信；弹窗以自身会话 id 收信（pong / 定向消息可达）
  const myAddress = role === 'main' ? MAIN_ADDRESS : sessionId
  const factory = options.channelFactory ?? defaultChannelFactory
  // 通道名：位置参数与 options.channelName 双形式（后者便于测试 / 桥接层整体透传）
  const channel = factory(options.channelName ?? channelName)
  const now = options.now ?? (() => Date.now())
  const pingIntervalMs = options.pingIntervalMs ?? 2000
  const checkIntervalMs = options.checkIntervalMs ?? 1000
  const lostTimeoutMs = options.lostTimeoutMs ?? 5000
  const popoutLostTimeoutMs = options.popoutLostTimeoutMs ?? 8000

  let seq = 0
  let closed = false
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  const dataListeners = new Set<RemoteStateListener>()
  const controlListeners = new Set<ControlListener>()
  /** 主窗侧：会话 → 最近心跳时间与元信息（任意消息都算心跳） */
  const peers = new Map<string, { lastSeen: number; meta?: PeerMeta }>()
  /** 弹窗侧：最近一次收到主窗消息的时间 */
  let lastMainSeen = now()
  let mainLostFired = false

  const deliverer = createSeqDeliverer<SyncMessage>((msg) => {
    for (const cb of dataListeners) safeCall(() => cb(msg.kind as SyncDataKind, msg.payload, msg.from))
  })

  const sendRaw = (
    kind: SyncMessage['kind'],
    to: string,
    payload: unknown,
    msgOpts?: { seq?: number; baseline?: boolean },
  ): void => {
    if (closed) return
    const msg: SyncMessage = {
      seq: msgOpts?.seq ?? -1,
      from: sessionId,
      to,
      kind,
      payload,
      ...(msgOpts?.baseline ? { baseline: true as const } : {}),
    }
    channel.postMessage(serializeMessage(msg))
  }

  const handle = (raw: unknown): void => {
    if (closed) return
    const msg = deserializeMessage(raw)
    if (!msg || msg.from === sessionId) return
    if (msg.to !== ALL_ADDRESS && msg.to !== myAddress) return

    // 心跳记录：任意消息都刷新对端存活时间
    if (role === 'main') {
      const prev = peers.get(msg.from)
      const meta = extractMeta(msg) ?? prev?.meta
      peers.set(msg.from, { lastSeen: now(), ...(meta ? { meta } : {}) })
    } else {
      lastMainSeen = now()
      mainLostFired = false
    }

    if (isControlKind(msg.kind)) {
      if (role === 'main' && msg.kind === 'ping') {
        sendRaw('pong', msg.from, undefined) // 弹窗失联判定的旁路依据
      }
      for (const cb of controlListeners) safeCall(() => cb(msg.kind as SyncControlKind, msg.payload, msg.from))
      return
    }
    deliverer.ingest(msg, msg.kind === 'snapshot' && msg.baseline === true)
  }

  channel.onmessage = (ev) => handle(ev.data)

  if (role === 'popout') {
    pingTimer = setInterval(() => {
      sendRaw('ping', MAIN_ADDRESS, options.meta ?? {})
    }, pingIntervalMs)
  }

  checkTimer = setInterval(() => {
    if (closed) return
    if (role === 'main') {
      for (const [sid, peer] of [...peers]) {
        if (now() - peer.lastSeen >= lostTimeoutMs) {
          peers.delete(sid) // 只触发一次，弹窗恢复心跳（重新 hello/ping）会再次登记
          options.onPeerLost?.(sid, peer.meta)
        }
      }
    } else if (!mainLostFired && now() - lastMainSeen >= popoutLostTimeoutMs) {
      mainLostFired = true
      options.onMainLost?.()
    }
  }, checkIntervalMs)

  const sync: WindowSync = {
    role,
    sessionId,

    sendToMain: (action) => {
      if (role !== 'popout') return // 主窗是执行方，无「转发主窗」语义
      seq += 1
      sendRaw('action', MAIN_ADDRESS, action, { seq })
    },

    broadcastData: (kind, payload, baseline = false) => {
      if (role !== 'main') return // 弹窗不广播状态：主窗是唯一写者
      seq += 1
      sendRaw(kind, ALL_ADDRESS, payload, { seq, baseline })
    },

    sendData: (kind, payload) => {
      if (role !== 'popout') return
      seq += 1
      sendRaw(kind, MAIN_ADDRESS, payload, { seq })
    },

    sendControl: (kind, payload, to) => {
      sendRaw(kind, to ?? (role === 'popout' ? MAIN_ADDRESS : ALL_ADDRESS), payload)
    },

    onRemoteState: (cb) => {
      dataListeners.add(cb)
      return () => {
        dataListeners.delete(cb)
      }
    },

    onControl: (cb) => {
      controlListeners.add(cb)
      return () => {
        controlListeners.delete(cb)
      }
    },

    close: () => {
      if (closed) return
      closed = true
      if (pingTimer !== null) clearInterval(pingTimer)
      if (checkTimer !== null) clearInterval(checkTimer)
      dataListeners.clear()
      controlListeners.clear()
      peers.clear()
      try {
        channel.close()
      } catch {
        /* 通道可能已关闭 */
      }
    },
  }
  return sync
}
