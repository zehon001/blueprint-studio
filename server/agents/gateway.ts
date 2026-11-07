/**
 * Agent 网关（平台注册表 + 通知路由）
 *
 * - 平台注册表：dsh = DshOrchestratorAdapter（真实连接）；codex / claude = 预留
 *   （返回固定中文提示的失败，能力表 connected:false）。
 * - 通知路由：sessionId → project（创建会话时登记），经 broadcast 回调投递给
 *   订阅该项目的运行窗口（agent.notification WS 帧）；未登记会话广播全部订阅项目。
 * - 完成等待：由适配器内部实现（DSH：wait 长轮询 + result 回读）。
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
import { getArchivedSessionIds, markSessionArchived } from './ledger'

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
    return {
      platform: this.platform,
      connected: false,
      models: [],
      reasoningLevels: [],
      permissions: [],
      defaults: { model: '', reasoning: '', permission: '' },
    }
  }

  async createSession(): Promise<AgentSessionValue> {
    throw this.unavailable()
  }

  async sendMessage(): Promise<{ reply: string }> {
    throw this.unavailable()
  }

  async deleteSession(): Promise<void> {
    throw this.unavailable()
  }

  onNotification(): void {
    /* 预留平台无通知流 */
  }

  dispose(): void {
    /* 无连接 */
  }
}

/** 能力缓存 TTL（毫秒；避免每次打开检视器都打编排器） */
const CAPABILITIES_TTL_MS = 15000

export class AgentGateway {
  private readonly adapters = new Map<AgentPlatform, OrchestratorAdapter>()
  /** sessionId → project（通知路由；创建会话时登记，永续保存在进程内） */
  private readonly sessionProjects = new Map<string, string>()
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

  /** 创建会话（title 空 = DSH 自动生成标题；cwd 用于创建/复用工作区；登记路由） */
  async createSession(
    platform: AgentPlatform,
    project: string,
    opts: { title?: string; cwd?: string; model?: string; reasoning?: string; permissions?: string; reuse?: boolean } = {},
  ): Promise<AgentSessionValue> {
    const session = await this.adapter(platform).createSession({
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      ...(opts.reuse !== undefined ? { reuse: opts.reuse } : {}),
      ...(opts.reuse === true ? { excludeSessionIds: this.archivedSessionIds() } : {}),
    })
    this.sessionProjects.set(session.sessionId, project)
    return session
  }

  /**
   * 发送消息。waitForCompletion=false：受理即返回（reply 空）；
   * true：适配器内阻塞等待完成（wait 长轮询 + result 回读）。
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
    this.sessionProjects.set(opts.sessionId, opts.project)
    return await this.adapter(opts.platform).sendMessage({
      sessionId: opts.sessionId,
      message: opts.message,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      ...(opts.waitForCompletion !== undefined ? { waitForCompletion: opts.waitForCompletion } : {}),
      ...(opts.timeoutSec !== undefined ? { timeoutSec: opts.timeoutSec } : {}),
    })
  }

  /** 归档会话（删除会话节点；平台取会话值自带字段，无需额外缓存） */
  async deleteSession(platform: AgentPlatform, sessionId: string): Promise<void> {
    await this.adapter(platform).deleteSession(sessionId)
    markSessionArchived(sessionId)
  }

  /** 服务端归档台账（删除会话登记；复用搜索据此跳过已归档会话） */
  private archivedSessionIds(): string[] {
    return getArchivedSessionIds()
  }

  /** 外部创建的会话也能收到通知（登记路由） */
  trackSession(sessionId: string, project: string): void {
    this.sessionProjects.set(sessionId, project)
  }

  dispose(): void {
    for (const a of this.adapters.values()) a.dispose()
  }

  /* ---------------- 内部 ---------------- */

  private routeNotification(n: AgentNotification): void {
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
