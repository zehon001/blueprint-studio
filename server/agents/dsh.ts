/**
 * dsh-plugin-orchestrator 适配器（HTTP REST + SSE，契约见 ./types.ts）
 *
 * - REST 调用：createSession（工作区幂等复用 + 会话创建）、prompt、wait（分片长轮询）、result。
 * - 通知：GET /events（SSE）常驻订阅，断线指数退避重连；事件映射为 AgentNotification。
 * - 服务：插件自建独立回环 HTTP 服务，固定地址 http://127.0.0.1:49301
 *   （BP_DSH_URL 可覆盖，供测试/特殊部署使用）。
 * - 认证：BP_DSH_TOKEN 优先；未设置时读 profile cordis.patch.yml 的插件 apiToken。
 * - 未启动 / 未认证：抛中文错误，invoke 层转为 ok:false（蓝图按降级继续，不崩）。
 */
import type {
  AgentCapabilities,
  AgentCreateSessionOptions,
  AgentModelOption,
  AgentNotification,
  AgentSendMessageOptions,
  AgentSessionValue,
  OrchestratorAdapter,
} from './types'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 编排器地址（插件独立回环服务固定 49301；BP_DSH_URL 覆盖供测试/特殊部署） */
export function dshBaseUrl(): string {
  return process.env.BP_DSH_URL?.trim()?.replace(/\/+$/, '') || 'http://127.0.0.1:49301'
}

/** 编排器 REST 前缀 */
const ORCHESTRATOR_PREFIX = '/api/orchestrator'

/** 单次 wait 长轮询分片（毫秒）：避免宿主/代理对超长请求的头部超时（undici 默认 300s） */
const WAIT_CHUNK_MS = 30_000

/** SSE 断线重连退避上限 */
const SSE_RECONNECT_MAX_MS = 5000

interface OrchestratorError {
  code?: string
  message?: string
}

/** 把底层错误翻译成中文（invoke 层直接展示） */
function chineseError(action: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return new Error(`无法连接 dsh-plugin-orchestrator（${dshBaseUrl()}）：请确认 DSH 已启动且编排插件已加载`)
  }
  return new Error(`${action}失败：${message}`)
}

/* ============================================================
 * DSH 本机配置目录（模型 / 思考强度 / 权限预设的真实来源；零依赖迷你解析）
 * ============================================================ */

/** DSH 根目录（DSH_HOME 覆盖；缺省 ~/.dsh） */
function dshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

/** DSH profile（BP_DSH_PROFILE 覆盖；桌面端缺省 desktop） */
function dshProfile(): string {
  return process.env.BP_DSH_PROFILE?.trim() || 'desktop'
}

/** 编排器 apiToken 缓存（60s；DSH 设置面板改 token 后随缓存过期生效） */
let orchestratorTokenCache: { at: number; token: string } | null = null
const ORCHESTRATOR_TOKEN_TTL_MS = 60_000

/**
 * 编排器 apiToken：BP_DSH_TOKEN 优先；否则读 DSH profile 的 cordis.patch.yml
 * （dsh-plugin-orchestrator 条目下的 config.apiToken）。
 * DSH webServer 端口随重启变化、token 不变，自动读取可免去手动配置环境变量。
 */
function orchestratorApiToken(): string {
  const envToken = process.env.BP_DSH_TOKEN?.trim()
  if (envToken) return envToken
  if (
    orchestratorTokenCache &&
    Date.now() - orchestratorTokenCache.at < ORCHESTRATOR_TOKEN_TTL_MS
  ) {
    return orchestratorTokenCache.token
  }
  let token = ''
  try {
    const text = fs.readFileSync(
      path.join(dshHome(), 'profiles', dshProfile(), 'cordis.patch.yml'),
      'utf8',
    )
    let inEntry = false
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (/^-\s+id:\s*dsh-plugin-orchestrator\s*$/.test(line)) {
        inEntry = true
        continue
      }
      if (inEntry) {
        if (/^-\s+id:/.test(line)) break
        const m = /^apiToken:\s*(.+)$/.exec(line)
        if (m) {
          token = m[1]!.trim().replace(/^['"]|['"]$/g, '')
          break
        }
      }
    }
  } catch {
    /* 配置不可读：token 留空（未配置 apiToken 时回环服务不校验 token） */
  }
  orchestratorTokenCache = { at: Date.now(), token }
  return token
}

/** 配置目录缓存（60s；打开检视器频繁拉取时避免反复读盘） */
interface CatalogCache {
  at: number
  models: AgentModelOption[]
  reasoningLevels: string[]
  permissions: string[]
  defaults: { model: string; reasoning: string; permission: string }
  /** 模型 id → provider（selectModel 必填 provider） */
  providerByModel: Record<string, string>
}
let catalogCache: CatalogCache | null = null
const CATALOG_TTL_MS = 60_000

export class DshOrchestratorAdapter implements OrchestratorAdapter {
  readonly platform = 'dsh' as const

  /** fetch 替身（测试注入；缺省全局 fetch） */
  private readonly fetchImpl: typeof fetch
  /** fetch 是否为注入替身（替身模式跳过本机认证配置要求） */
  private readonly injected: boolean

  private notificationCb: ((n: AgentNotification) => void) | null = null
  private sseAbort: AbortController | null = null
  private sseBackoffMs = 500
  private disposed = false

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch
    this.injected = fetchImpl !== undefined
  }

  onNotification(cb: (n: AgentNotification) => void): void {
    this.notificationCb = cb
    this.ensureSseLoop()
  }

  /** 健康检查（同时校验可达性与认证） */
  async ensureConnected(): Promise<void> {
    try {
      await this.request('GET', '/health')
    } catch (err) {
      throw chineseError('连接 dsh-plugin-orchestrator', err)
    }
  }

  /**
   * 能力目录（GET /capabilities）：模型 / 思考强度 / 权限预设由插件在 DSH 宿主内
   * 解析后经 HTTP 下发，蓝图端不读取 DSH 本地配置文件。
   */
  private async fetchRemoteCatalog(): Promise<CatalogCache | null> {
    try {
      const body = (await this.request('GET', '/capabilities')) as {
        ok?: unknown
        models?: unknown
        reasoningLevels?: unknown
        permissions?: unknown
        defaults?: { model?: unknown; reasoning?: unknown; permission?: unknown }
        at?: unknown
      }
      if (body === null || body.ok !== true || !Array.isArray(body.models)) return null
      const models: AgentModelOption[] = []
      const providerByModel: Record<string, string> = {}
      const efforts = new Set<string>()
      for (const raw of body.models) {
        if (raw === null || typeof raw !== 'object') continue
        const entry = raw as { id?: unknown; name?: unknown; provider?: unknown; efforts?: unknown }
        if (typeof entry.id !== 'string' || entry.id === '') continue
        models.push({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
        })
        if (typeof entry.provider === 'string' && entry.provider !== '') {
          providerByModel[entry.id] = entry.provider
        }
        if (Array.isArray(entry.efforts)) {
          for (const effort of entry.efforts) {
            if (typeof effort === 'string' && effort !== '') efforts.add(effort)
          }
        }
      }
      const reasoningLevels = Array.isArray(body.reasoningLevels)
        ? body.reasoningLevels.filter((x): x is string => typeof x === 'string' && x !== '')
        : [...efforts]
      const permissions = Array.isArray(body.permissions)
        ? body.permissions.filter((x): x is string => typeof x === 'string' && x !== '')
        : []
      const str = (value: unknown): string => (typeof value === 'string' ? value : '')
      return {
        at: typeof body.at === 'number' ? body.at : Date.now(),
        models,
        reasoningLevels,
        permissions,
        defaults: {
          model: str(body.defaults?.model),
          reasoning: str(body.defaults?.reasoning),
          permission: str(body.defaults?.permission),
        },
        providerByModel,
      }
    } catch {
      return null
    }
  }

  /** 能力目录（HTTP /capabilities；60s 缓存） */
  private async loadCatalog(): Promise<CatalogCache> {
    if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache
    const remote = await this.fetchRemoteCatalog()
    if (remote === null) throw new Error('编排器未返回有效的能力目录（GET /capabilities）')
    catalogCache = remote
    return remote
  }

  async capabilities(): Promise<AgentCapabilities> {
    try {
      await this.request('GET', '/health')
      const catalog = await this.loadCatalog()
      return { platform: 'dsh', connected: true, ...catalog }
    } catch {
      return {
        platform: 'dsh',
        connected: false,
        models: [],
        reasoningLevels: [],
        permissions: [],
        defaults: { model: '', reasoning: '', permission: '' },
      }
    }
  }

  async createSession(opts: AgentCreateSessionOptions): Promise<AgentSessionValue> {
    if (!opts.cwd) throw new Error('创建会话需要 cwd（蓝图项目目录）')
    try {
      // 有效设置 = 参数非空项；空项回落 DSH 当前默认（模型目录首个 / 首个思考强度 / defaultPreset）
      const catalog = await this.loadCatalog()
      const effective = {
        model: opts.model?.trim() || catalog.defaults.model,
        reasoning: opts.reasoning?.trim() || catalog.defaults.reasoning,
        permissions: opts.permissions?.trim() || catalog.defaults.permission,
      }
      const ws = (await this.request('POST', '/workspaces', {
        path: opts.cwd,
        // 工作区标题交给 DSH 默认（= 目录名）：会话标题只属于会话，不得污染工作区
        // （首次创建即定格标题；编排器对同路径重复调用不改标题）
      })) as { workspace?: { workspaceId?: unknown } }
      const workspaceId = typeof ws?.workspace?.workspaceId === 'string' ? ws.workspace.workspaceId : ''
      if (!workspaceId) throw new Error('编排器未返回 workspaceId')
      /** 给会话选择模型（宿主 selectModel：对下一次请求生效；失败抛中文错误） */
      const applyModel = async (sessionId: string): Promise<void> => {
        const provider = catalog.providerByModel[effective.model]
        if (!provider) return
        await this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/model`, {
          provider,
          model: effective.model,
          ...(effective.reasoning ? { reasoningEffort: effective.reasoning } : {}),
        })
      }
      // 复用：标题非空时按「标题 + 工作区」搜索既有会话（首个标题命中即复用）。
      // 工作区会话列表不携带 title → 逐个读状态比对（工作区会话数通常为个位数）。
      if (opts.reuse === true && opts.title) {
        const excluded = new Set(opts.excludeSessionIds ?? [])
        const listed = (await this.request(
          'GET',
          `/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
        )) as { sessions?: Array<{ sessionId?: unknown }> }
        for (const item of listed?.sessions ?? []) {
          const sid = typeof item?.sessionId === 'string' ? item.sessionId : ''
          if (!sid || excluded.has(sid)) continue
          try {
            // 状态体：{ ok, status: { title, ... } }（title 嵌套在 status 内）
            const body = (await this.request('GET', `/sessions/${encodeURIComponent(sid)}`)) as {
              status?: { title?: unknown }
              title?: unknown
            }
            const title = typeof body?.status?.title === 'string' ? body.status.title : body?.title
            if (title === opts.title) {
              // 复用同样应用模型设置（用户可能改了内部设置再运行）
              await applyModel(sid)
              return { platform: 'dsh', sessionId: sid, title: opts.title, ...effective }
            }
          } catch {
            /* 单个会话状态读取失败：跳过继续搜索 */
          }
        }
      }
      const created = (await this.request('POST', '/sessions', {
        workspaceId,
        ...(opts.title ? { title: opts.title } : {}),
        // 注意：agentPreset 是 Agent 预设 id（如 "standard"），不是 LLM 模型 id；
        // 模型 / 思考强度经上方 applyModel（宿主 selectModel）对会话下一次请求生效
      })) as { sessionId?: unknown }
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (!sessionId) throw new Error('编排器未返回 sessionId')
      await applyModel(sessionId)
      // 标题留空时回读 DSH 自动生成的标题（状态对象携带 title）
      let title = opts.title ?? ''
      if (!title) {
        try {
          const body = (await this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`)) as {
            status?: { title?: unknown }
            title?: unknown
          }
          const statusTitle = typeof body?.status?.title === 'string' ? body.status.title : body?.title
          if (typeof statusTitle === 'string' && statusTitle) title = statusTitle
        } catch {
          /* 标题回读失败不阻塞创建 */
        }
      }
      return { platform: 'dsh', sessionId, title, ...effective }
    } catch (err) {
      throw chineseError('创建 Agent 会话', err)
    }
  }

  async sendMessage(opts: AgentSendMessageOptions): Promise<{ reply: string }> {
    try {
      // 覆盖设置：宿主 selectModel 对会话下一次请求生效（权限为客户端预设，编排接口无对应能力）
      if (opts.model?.trim()) {
        const catalog = await this.loadCatalog()
        const provider = catalog.providerByModel[opts.model.trim()]
        if (provider) {
          await this.request('POST', `/sessions/${encodeURIComponent(opts.sessionId)}/model`, {
            provider,
            model: opts.model.trim(),
            ...(opts.reasoning?.trim() ? { reasoningEffort: opts.reasoning.trim() } : {}),
          })
        }
      }
      const accepted = (await this.request('POST', `/sessions/${encodeURIComponent(opts.sessionId)}/prompt`, {
        text: opts.message,
      })) as { promptAccepted?: unknown }
      if (accepted?.promptAccepted === false) {
        throw new Error('DSH 未受理该消息（会话可能正忙或已关闭）')
      }
      if (opts.waitForCompletion !== true) return { reply: '' }
      await this.waitIdle(opts.sessionId, Math.max(1, opts.timeoutSec ?? 600) * 1000)
      const reply = await this.readResult(opts.sessionId)
      return { reply }
    } catch (err) {
      throw chineseError('发送 Agent 消息', err)
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const enc = encodeURIComponent(sessionId)
    try {
      // 运行中的回合先取消（未运行 / 已空闲时取消失败不阻塞归档）
      await this.request('POST', `/sessions/${enc}/cancel`).catch(() => undefined)
      await this.request('POST', `/sessions/${enc}/archive`)
    } catch (err) {
      throw chineseError('删除 Agent 会话', err)
    }
  }

  dispose(): void {
    this.disposed = true
    this.sseAbort?.abort()
    this.sseAbort = null
  }

  /* ---------------- 内部：REST ---------------- */

  /** 认证头（插件 apiToken：x-api-token） */
  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = orchestratorApiToken()
    if (token) return { 'x-api-token': token, ...extra }
    if (this.injected) return { ...extra }
    throw new Error('未配置编排器认证：请在 dsh-plugin-orchestrator 配置 apiToken（或设置 BP_DSH_TOKEN）')
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const headers = await this.authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' })
    const res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}${path}`, dshBaseUrl()), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = (await res.json().catch(() => null)) as
      | { ok?: unknown; error?: OrchestratorError }
      | null
    if (!res.ok || !json || json.ok !== true) {
      const code = json?.error?.code ?? `HTTP ${res.status}`
      const message = json?.error?.message ?? res.statusText
      if (res.status === 401 || code === 'unauthorized') {
        throw new Error('编排器认证失败（401）：请检查 dsh-plugin-orchestrator 的 apiToken 配置')
      }
      throw new Error(`${code} ${message}`)
    }
    return json
  }

  /** 分片长轮询等空闲（总超时到点即返回，由调用方回读结果） */
  private async waitIdle(sessionId: string, totalMs: number): Promise<void> {
    const deadline = Date.now() + totalMs
    while (Date.now() < deadline) {
      const chunk = Math.min(WAIT_CHUNK_MS, deadline - Date.now())
      const r = (await this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/wait`, {
        timeoutMs: chunk,
      })) as { idle?: unknown }
      if (r?.idle === true) return
    }
  }

  private async readResult(sessionId: string): Promise<string> {
    const r = (await this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/result`)) as {
      result?: unknown
    }
    return typeof r?.result === 'string' ? r.result : ''
  }

  /* ---------------- 内部：SSE 通知 ---------------- */

  private ensureSseLoop(): void {
    if (this.sseAbort || this.disposed) return
    const controller = new AbortController()
    this.sseAbort = controller
    void this.sseLoop(controller)
  }

  private async sseLoop(controller: AbortController): Promise<void> {
    const decoder = new TextDecoder()
    while (!this.disposed && !controller.signal.aborted) {
      try {
        const headers = await this.authHeaders({ accept: 'text/event-stream' })
        const res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}/events`, dshBaseUrl()), {
          headers,
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        this.sseBackoffMs = 500
        const reader = res.body.getReader()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            this.handleSseFrame(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (err) {
        if (this.disposed || controller.signal.aborted) return
        if (!(err instanceof Error && err.name === 'AbortError')) {
          // 连接失败静默退避重试（DSH 可能尚未就绪）；不向蓝图播错误帧
        }
      }
      const delay = this.sseBackoffMs
      this.sseBackoffMs = Math.min(this.sseBackoffMs * 2, SSE_RECONNECT_MAX_MS)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  private handleSseFrame(frame: string): void {
    const lines = frame.split('\n')
    const eventLine = lines.find((l) => l.startsWith('event: '))
    const dataLine = lines.find((l) => l.startsWith('data: '))
    if (!eventLine || !dataLine || !this.notificationCb) return
    const type = eventLine.slice(7).trim()
    const raw = dataLine.slice(6).trim()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
    if (!sessionId) return
    const mapped = this.mapEvent(type, data)
    if (!mapped) return
    this.notificationCb({
      sessionId,
      platform: 'dsh',
      kind: mapped.kind,
      content: mapped.content,
      raw,
      ts: Date.now(),
    })
  }

  /** SSE 事件 → (kind, content)；未列出的事件忽略 */
  private mapEvent(type: string, data: Record<string, unknown>): { kind: string; content: string } | null {
    const summary = typeof data.summary === 'string' ? data.summary : ''
    switch (type) {
      case 'session.created':
        return { kind: 'created', content: typeof data.title === 'string' ? data.title : '' }
      case 'session.status':
        return { kind: 'status', content: typeof data.status === 'string' ? data.status : '' }
      case 'session.turn-start':
        return { kind: 'turn-start', content: `第 ${String(data.turn ?? '?')} 轮开始` }
      case 'session.turn-end':
        return { kind: 'turn-end', content: `第 ${String(data.turn ?? '?')} 轮结束（${String(data.outcome ?? '')}）` }
      case 'session.completed':
        return { kind: 'completed', content: summary }
      case 'session.interrupted':
        return { kind: 'interrupted', content: summary || String(data.reason ?? '') }
      case 'session.failed': {
        const err = data.error as OrchestratorError | undefined
        return { kind: 'failed', content: err?.message ?? String(data.reason ?? '') }
      }
      default:
        return null
    }
  }
}
