/**
 * Agent 网关（平台注册表 + 通知路由 + 完成等待）
 *
 * - 平台注册表：dsh = DshOrchestratorAdapter（真实连接）；codex / claude = 预留
 *   （返回固定中文提示的失败，能力表 connected:false）。
 * - 通知路由：sessionId → project（创建会话时登记），经 broadcast 回调投递给
 *   订阅该项目的运行窗口（agent.notification WS 帧）。
 * - 完成等待：sendMessage(waitForCompletion) 时登记 sessionId → resolver，
 *   收到 kind='completed'（或首个 message 全量回复）后以最终回复 resolve。
 */
import type {
  AgentCapabilities,
  AgentNotification,
  AgentPlatform,
  AgentSessionValue,
  OrchestratorAdapter,
} from './types'
import { AGENT_PLATFORMS } from './types'
import { DshOrchestratorAdapter } from './dsh'

/** 广播回调（server/plugins/executor.ts 的 PluginPushHub.broadcast 注入） */
export type AgentBroadcastFn = (project: string, message: Record<string, unknown>) => void

/** 预留平台（未连接）适配器：全部动作返回中文提示 */
class ReservedAdapter implements OrchestratorAdapter {
  readonly platform: AgentPlatform

  constructor(platform: AgentPlatform, private readonly label: string) {
    this.platform = platform
  }

  private unavailable(): Error {
    return new Error(`${this.label} 平台为预留能力，尚未连接（dsh 已支持）`)
  }

  async ensureConnected(): Promise<void> {
    throw this.unavailable()
  }

  async capabilities(): Promise<AgentCapabilities> {
    return { platform: this.platform, connected: false, models: [], reasoningLevels: [], permissions: [] }
  }

  async createSession(): Promise<AgentSessionValue> {
    throw this.unavailable()
  }

  async sendMessage(): Promise<void> {
    throw this.unavailable()
  }

  onNotification(): void {
    /* 预留平台无通知流 */
  }

  dispose(): void {
    /* 无连接 */
  }
}

/** 能力缓存 TTL（毫秒；避免每次打开检视器都打 orchestrator） */
const CAPABILITIES_TTL_MS = 15000

export class AgentGateway {
  private readonly adapters = new Map<AgentPlatform, OrchestratorAdapter>()
  /** sessionId → project（通知路由；创建会话时登记，永续保存在进程内） */
  private readonly sessionProjects = new Map<string, string>()
  /** sessionId → resolver（waitForCompletion 登记；completed 通知触发） */
  private readonly pendingCompletions = new Map<string, { resolve: (n: AgentNotification) => void; timer: NodeJS.Timeout }>()
  private readonly capabilitiesCache = new Map<AgentPlatform, { at: number; value: AgentCapabilities }>()

  constructor(broadcast: AgentBroadcastFn) {
    const dsh = new DshOrchestratorAdapter()
    dsh.onNotification((n) => this.routeNotification(n))
    this.adapters.set('dsh', dsh)
    this.adapters.set('codex', new ReservedAdapter('codex', 'Codex'))
    this.adapters.set('claude', new ReservedAdapter('claude', 'Claude'))
    this.broadcast = broadcast
  }

  private readonly broadcast: AgentBroadcastFn

  adapter(platform: AgentPlatform): OrchestratorAdapter {
    const a = this.adapters.get(platform)
    if (!a) throw new Error(`未知 Agent 平台：${platform}（支持 ${AGENT_PLATFORMS.join(' / ')}）`)
    return a
  }

  /** 平台能力（缓存 15s；未连接平台返回 connected:false） */
  async capabilities(platform: AgentPlatform): Promise<AgentCapabilities> {
    const cached = this.capabilitiesCache.get(platform)
    if (cached && Date.now() - cached.at < CAPABILITIES_TTL_MS) return cached.value
    const value = await this.adapter(platform).capabilities()
    this.capabilitiesCache.set(platform, { at: Date.now(), value })
    return value
  }

  /** 创建会话（title 空 = DSH 自动生成标题；登记 sessionId → project 路由） */
  async createSession(platform: AgentPlatform, project: string, title?: string): Promise<AgentSessionValue> {
    const session = await this.adapter(platform).createSession({ title: title ?? '' })
    this.sessionProjects.set(session.sessionId, project)
    return session
  }

  /**
   * 发送消息。waitForCompletion=false：受理即返回（reply 空）；
   * true：等待该会话的 completed 通知（timeoutSec 超时返回已收到的最后回复，可能为空）。
   */
  async sendMessage(opts: {
    platform: AgentPlatform
    project: string
    sessionId: string
    message: string
    model?: string
    reasoning?: string
    permissions?: string
    waitForCompletion?: boolean
    timeoutSec?: number
  }): Promise<{ reply: string }> {
    const adapter = this.adapter(opts.platform)
    await adapter.sendMessage({
      sessionId: opts.sessionId,
      message: opts.message,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    })
    this.sessionProjects.set(opts.sessionId, opts.project)
    if (opts.waitForCompletion !== true) return { reply: '' }

    // 登记最后回复（message 通知持续覆盖；completed 时取走）
    let lastReply = ''
    const sessionId = opts.sessionId
    const handler = (n: AgentNotification): void => {
      if (n.sessionId === sessionId && n.kind === 'message') lastReply = n.content || lastReply
    }
    // 临时挂接 message 跟踪（经 routeNotification 广播前的回调）
    this.trackers.add(handler)
    try {
      const notification = await new Promise<AgentNotification>((resolve) => {
        const timer = setTimeout(
          () => resolve({ sessionId, platform: opts.platform, kind: 'timeout', content: lastReply, ts: Date.now() }),
          Math.max(1, opts.timeoutSec ?? 600) * 1000,
        )
        this.pendingCompletions.set(sessionId, { resolve, timer })
      })
      if (notification.content) lastReply = notification.content
    } finally {
      this.trackers.delete(handler)
      const pending = this.pendingCompletions.get(sessionId)
      if (pending) clearTimeout(pending.timer)
      this.pendingCompletions.delete(sessionId)
    }
    return { reply: lastReply }
  }

  /** 测试 / 健康检查用：登记 projectId 路由（外部创建的会话也能收到通知） */
  trackSession(sessionId: string, project: string): void {
    this.sessionProjects.set(sessionId, project)
  }

  dispose(): void {
    for (const a of this.adapters.values()) a.dispose()
    for (const p of this.pendingCompletions.values()) clearTimeout(p.timer)
    this.pendingCompletions.clear()
  }

  /* ---------------- 内部 ---------------- */

  /** message 通知跟踪器（waitForCompletion 的 lastReply 收集） */
  private readonly trackers = new Set<(n: AgentNotification) => void>()

  private routeNotification(n: AgentNotification): void {
    for (const t of this.trackers) t(n)
    if (n.kind === 'completed') {
      const pending = this.pendingCompletions.get(n.sessionId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingCompletions.delete(n.sessionId)
        pending.resolve(n)
      }
    }
    const project = this.sessionProjects.get(n.sessionId)
    const message = {
      type: 'agent.notification',
      sessionId: n.sessionId,
      platform: n.platform,
      kind: n.kind,
      content: n.content,
      ...(n.raw !== undefined ? { raw: n.raw } : {}),
      ts: n.ts,
    }
    if (project) {
      this.broadcast(project, message)
    } else {
      // 未登记会话（编排器侧创建）：广播给全部订阅项目
      this.broadcast('', message)
    }
  }
}
