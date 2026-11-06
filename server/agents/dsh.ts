/**
 * dsh-plugin-orchestrator 适配器（WebSocket JSON-RPC，见 ./types.ts 契约）
 *
 * 懒连接 + 指数退避重连；未连接时 capabilities 返回缺省表（connected:false），
 * createSession / sendMessage 抛中文错误（invoke 层转为 ok:false，蓝图可跑不崩）。
 */
import WebSocket from 'ws'
import type {
  AgentCapabilities,
  AgentCreateSessionOptions,
  AgentNotification,
  AgentSendMessageOptions,
  AgentSessionValue,
  OrchestratorAdapter,
} from './types'

/** dsh-plugin-orchestrator 缺省地址（BP_DSH_ORCHESTRATOR_URL 覆盖） */
export function dshOrchestratorUrl(): string {
  return process.env.BP_DSH_ORCHESTRATOR_URL?.trim() || 'ws://127.0.0.1:8791'
}

/** 能力缺省表（orchestrator 未连接 / 未实现 capabilities 时的兜底） */
export const DSH_DEFAULT_CAPABILITIES: AgentCapabilities = {
  platform: 'dsh',
  connected: false,
  models: ['dsh-default'],
  reasoningLevels: ['off', 'low', 'medium', 'high'],
  permissions: ['fs.read', 'net', 'shell'],
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class DshOrchestratorAdapter implements OrchestratorAdapter {
  readonly platform = 'dsh' as const

  private ws: WebSocket | null = null
  private seq = 0
  private readonly pending = new Map<string, PendingRpc>()
  private notificationCb: ((n: AgentNotification) => void) | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private backoffMs = 500
  private closed = false

  constructor(private readonly url: string = dshOrchestratorUrl()) {}

  onNotification(cb: (n: AgentNotification) => void): void {
    this.notificationCb = cb
  }

  ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.closed) return Promise.reject(new Error('dsh-plugin-orchestrator 连接已释放'))
    return new Promise((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          ws.terminate()
          reject(new Error(`无法连接 dsh-plugin-orchestrator（${this.url}）：请确认 DSH 与编排插件已启动`))
        }
      }, 3000)
      ws.on('open', () => {
        clearTimeout(timer)
        this.ws = ws
        this.backoffMs = 500
        if (!settled) {
          settled = true
          resolve()
        }
      })
      ws.on('message', (data) => this.handleMessage(String(data)))
      ws.on('error', () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new Error(`dsh-plugin-orchestrator 连接失败（${this.url}）`))
        }
      })
      ws.on('close', () => {
        this.ws = null
        this.failPending(new Error('dsh-plugin-orchestrator 连接已断开'))
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`无法连接 dsh-plugin-orchestrator（${this.url}）`))
        }
        this.scheduleReconnect()
      })
    })
  }

  async capabilities(): Promise<AgentCapabilities> {
    try {
      await this.ensureConnected()
      const result = (await this.rpc('agent.capabilities', {}, 3000)) as Partial<AgentCapabilities> | null
      return {
        platform: 'dsh',
        connected: true,
        models: Array.isArray(result?.models) && result.models.length > 0 ? result.models.map(String) : DSH_DEFAULT_CAPABILITIES.models,
        reasoningLevels:
          Array.isArray(result?.reasoningLevels) && result.reasoningLevels.length > 0
            ? result.reasoningLevels.map(String)
            : DSH_DEFAULT_CAPABILITIES.reasoningLevels,
        permissions:
          Array.isArray(result?.permissions) && result.permissions.length > 0
            ? result.permissions.map(String)
            : DSH_DEFAULT_CAPABILITIES.permissions,
      }
    } catch {
      return { ...DSH_DEFAULT_CAPABILITIES }
    }
  }

  async createSession(opts: AgentCreateSessionOptions): Promise<AgentSessionValue> {
    await this.ensureConnected()
    const result = (await this.rpc('agent.createSession', { title: opts.title ?? '' })) as {
      sessionId?: unknown
      title?: unknown
    }
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : ''
    if (!sessionId) throw new Error('dsh-plugin-orchestrator 未返回 sessionId（创建会话失败）')
    return { platform: 'dsh', sessionId, title: typeof result?.title === 'string' ? result.title : '' }
  }

  async sendMessage(opts: AgentSendMessageOptions): Promise<void> {
    await this.ensureConnected()
    await this.rpc('agent.sendMessage', {
      sessionId: opts.sessionId,
      message: opts.message,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    })
  }

  dispose(): void {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.failPending(new Error('dsh-plugin-orchestrator 连接已释放'))
    this.ws?.close()
    this.ws = null
  }

  /* ---------------- 内部 ---------------- */

  private handleMessage(text: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.type === 'rpc.result' && typeof frame.id === 'string') {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      this.pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.ok === true) entry.resolve(frame.result)
      else entry.reject(new Error(typeof frame.error === 'string' && frame.error ? frame.error : 'dsh-plugin-orchestrator 调用失败'))
      return
    }
    if (frame.type === 'agent.notification') {
      const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : ''
      if (!sessionId || !this.notificationCb) return
      this.notificationCb({
        sessionId,
        platform: 'dsh',
        kind: typeof frame.kind === 'string' ? frame.kind : 'message',
        content: typeof frame.content === 'string' ? frame.content : '',
        ...(typeof frame.raw === 'string' ? { raw: frame.raw } : {}),
        ts: Date.now(),
      })
    }
  }

  private rpc(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('dsh-plugin-orchestrator 未连接'))
    }
    const id = `rpc-${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dsh-plugin-orchestrator 调用超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'rpc', id, method, params }))
    })
  }

  private failPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.ensureConnected().catch(() => {
        /* 重连失败继续退避 */
      })
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, 5000)
  }
}
