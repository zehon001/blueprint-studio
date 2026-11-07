/**
 * dsh-plugin-orchestrator 适配器（HTTP REST + SSE，契约见 ./types.ts）
 *
 * - REST 调用：createSession（工作区幂等复用 + 会话创建）、prompt、wait（分片长轮询）、result。
 * - 通知：GET /events（SSE）常驻订阅，断线指数退避重连；事件映射为 AgentNotification。
 * - 认证：BP_DSH_TOKEN（x-api-token 头）优先；否则 BP_DSH_CONNECT_TOKEN 经 /connect 换 Cookie。
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

/** DSH web 宿主地址（BP_DSH_URL 覆盖；桌面端 dsh web 缺省端口见宿主启动日志） */
export function dshBaseUrl(): string {
  return process.env.BP_DSH_URL?.trim()?.replace(/\/+$/, '') || 'http://127.0.0.1:49300'
}

/** 编排器 REST 前缀 */
const ORCHESTRATOR_PREFIX = '/api/orchestrator'

/**
 * 自动探测（BP_DSH_URL 未设置时）：扫描 49300–49999（DSH web 端口在宿主启动时动态
 * 分配于该段），以 health 响应体识别编排器宿主：
 *  - 含 "dsh-plugin-orchestrator" → 命中（认证有效）；
 *  - error.code = unauthorized → 命中（DSH 宿主，认证待配置，后续调用报 401 中文错误）；
 *  - 其余（LLM 代理 proxy_auth / 桥接宿主 not-found / 无响应）→ 跳过。
 */
const DSH_PROBE_RANGE: [number, number] = [49300, 49999]
const DSH_PROBE_CONCURRENCY = 12
const DSH_PROBE_TIMEOUT_MS = 800

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
    const where = process.env.BP_DSH_URL?.trim() ?? `自动探测 127.0.0.1:${DSH_PROBE_RANGE[0]}-${DSH_PROBE_RANGE[1]}`
    return new Error(`无法连接 dsh-plugin-orchestrator（${where}）：请确认 DSH 已启动且编排插件已加载`)
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

/** 模型目录条目（id / 显示名 / 该模型支持的思考强度） */
interface DshModelEntry {
  id: string
  name: string
  efforts: string[]
}

/**
 * 解析 settings.yaml 的模型目录（llm-pi-ai.providers.*.models[]）：
 * 逐行缩进扫描——`models:` 开块，`- id:` 开新条目，条目内收集 name 与
 * reasoningEfforts 的键（低配 YAML，无依赖；解析失败返回空表由调用方兜底）。
 */
export function parseDshModelCatalog(text: string): DshModelEntry[] {
  const out: DshModelEntry[] = []
  let modelsIndent: number | null = null
  let current: DshModelEntry | null = null
  let inEfforts = false
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (modelsIndent === null) {
      if (/^models:\s*$/.test(line)) modelsIndent = indent
      continue
    }
    if (/^-\s+id:\s*(.+)$/.test(line) && indent === modelsIndent + 2) {
      const id = /-\s+id:\s*(.+)$/.exec(line)![1]!.trim()
      current = { id, name: '', efforts: [] }
      inEfforts = false
      out.push(current)
      continue
    }
    if (indent <= modelsIndent) {
      // 离开 models 块（下一 provider / 顶层键）
      if (/^models:\s*$/.test(line)) continue
      modelsIndent = null
      current = null
      inEfforts = false
      continue
    }
    if (!current) continue
    const nameMatch = /^name:\s*(.+)$/.exec(line)
    if (nameMatch && !inEfforts) {
      current.name = nameMatch[1]!.trim()
      continue
    }
    if (/^reasoningEfforts:\s*$/.test(line)) {
      inEfforts = true
      continue
    }
    if (inEfforts) {
      const effortMatch = /^"?([A-Za-z][\w-]*)"?:\s/.exec(line)
      if (effortMatch) {
        current.efforts.push(effortMatch[1]!)
        continue
      }
      inEfforts = false
    }
  }
  return out
}

/**
 * 解析 profile cordis.patch.yml 的权限预设（dsh-permission-presets 条目的 presets
 * 键列表；条目形态两种：`- id: @deepseek-ai/dsh-permission-presets` 或
 * `- id: permission` + `name: "@deepseek-ai/dsh-permission-presets"`）。
 */
export function parseDshPermissionPresets(text: string): string[] {
  const lines = text.split(/\r?\n/)
  let scope = false
  let pendingName = false
  let presetsIndent: number | null = null
  const out: string[] = []
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (!scope) {
      if (/^-\s+id:\s*@deepseek-ai\/dsh-permission-presets\s*$/.test(line)) scope = true
      else if (/^-\s+id:/.test(line)) pendingName = true
      else if (pendingName && /^name:\s*"?.*dsh-permission-presets/.test(line)) scope = true
      else if (line !== '') pendingName = false
      continue
    }
    if (/^-\s+id:/.test(line)) break // 下一插件条目：作用域结束
    if (presetsIndent === null) {
      if (/^presets:\s*$/.test(line)) presetsIndent = indent
      continue
    }
    if (/^defaultPreset:/.test(line)) break
    const key = /^([\w-]+):\s*$/.exec(line)
    if (key && indent === presetsIndent + 2) out.push(key[1]!)
    else if (indent <= presetsIndent) break
  }
  return out
}

/** profile 权限预设配置（presets + defaultPreset；与 parseDshPermissionPresets 同源） */
export function parseDshPermissionConfig(text: string): { presets: string[]; defaultPreset: string } {
  const presets = parseDshPermissionPresets(text)
  let defaultPreset = ''
  for (const raw of text.split(/\r?\n/)) {
    const m = /^defaultPreset:\s*(.+)$/.exec(raw.trim())
    if (m) {
      defaultPreset = m[1]!.trim().replace(/^['"]|['"]$/g, '')
      break
    }
  }
  return { presets, defaultPreset }
}

/** 配置目录缓存（60s；打开检视器频繁拉取时避免反复读盘） */
interface CatalogCache {
  at: number
  models: AgentModelOption[]
  reasoningLevels: string[]
  permissions: string[]
  defaults: { model: string; reasoning: string; permission: string }
}
let catalogCache: CatalogCache | null = null
const CATALOG_TTL_MS = 60_000

/** 读 DSH 本机配置生成真实能力目录（读盘失败各自兜底为空表） */
function readDshCatalog(): CatalogCache {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache
  const models: AgentModelOption[] = []
  const efforts = new Set<string>()
  let entries: { id: string; name: string; efforts: string[] }[] = []
  try {
    entries = parseDshModelCatalog(fs.readFileSync(path.join(dshHome(), 'settings.yaml'), 'utf8'))
    for (const entry of entries) {
      models.push({ id: entry.id, name: entry.name || entry.id })
      for (const e of entry.efforts) efforts.add(e)
    }
  } catch {
    /* settings.yaml 不可读：模型目录留空 */
  }
  let permissions: string[] = []
  let defaultPermission = ''
  try {
    const perm = parseDshPermissionConfig(
      fs.readFileSync(path.join(dshHome(), 'profiles', dshProfile(), 'cordis.patch.yml'), 'utf8'),
    )
    permissions = perm.presets
    defaultPermission = perm.defaultPreset
  } catch {
    /* profile 不可读：权限预设留空 */
  }
  // 默认设置：模型目录首个条目 / 该模型的第一个思考强度 / profile defaultPreset
  const defaultModel = entries[0]?.id ?? ''
  const defaultReasoning = entries[0]?.efforts[0] ?? ''
  const value: CatalogCache = {
    at: Date.now(),
    models,
    reasoningLevels: [...efforts],
    permissions,
    defaults: { model: defaultModel, reasoning: defaultReasoning, permission: defaultPermission },
  }
  catalogCache = value
  return value
}

export class DshOrchestratorAdapter implements OrchestratorAdapter {
  readonly platform = 'dsh' as const

  /** fetch 替身（测试注入；缺省全局 fetch） */
  private readonly fetchImpl: typeof fetch
  /** fetch 是否为注入替身（替身模式跳过本机认证配置要求） */
  private readonly injected: boolean

  /** 换取的 DSH 会话 Cookie（BP_DSH_CONNECT_TOKEN 通道；token 通道不需要） */
  private cookie: string | null = null
  /** 自动探测缓存的宿主地址（BP_DSH_URL 未设置时使用；连接失败后清除重新探测） */
  private resolvedBase: string | null = null
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

  async capabilities(): Promise<AgentCapabilities> {
    try {
      await this.request('GET', '/health')
      const catalog = readDshCatalog()
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
      const catalog = readDshCatalog()
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
        // 注意：agentPreset 是 Agent 预设 id（如 "standard"），不是 LLM 模型 id——
        // 大模型 / 思考强度为记录性设置（编排接口暂不支持下发，勿作为 preset 传递）
      })) as { sessionId?: unknown }
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (!sessionId) throw new Error('编排器未返回 sessionId')
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
      // 覆盖设置随 prompt 请求转发（DSH 当前按会话创建时的设置执行；字段为前向兼容扩展）
      const overrides = {
        ...(opts.model?.trim() ? { model: opts.model.trim() } : {}),
        ...(opts.reasoning?.trim() ? { reasoning: opts.reasoning.trim() } : {}),
        ...(opts.permissions?.trim() ? { permissions: opts.permissions.trim() } : {}),
      }
      const accepted = (await this.request('POST', `/sessions/${encodeURIComponent(opts.sessionId)}/prompt`, {
        text: opts.message,
        ...overrides,
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

  /** 宿主地址：BP_DSH_URL 优先；否则探测候选端口（health 任意 HTTP 响应即命中） */
  private async baseUrl(): Promise<string> {
    const configured = process.env.BP_DSH_URL?.trim()
    if (configured) return configured.replace(/\/+$/, '')
    if (this.resolvedBase) return this.resolvedBase
    const hit = await this.probeOrchestratorPort()
    if (hit !== null) {
      this.resolvedBase = `http://127.0.0.1:${hit}`
      return this.resolvedBase
    }
    throw new Error(
      `无法定位 dsh-plugin-orchestrator 宿主（已探测 127.0.0.1:${DSH_PROBE_RANGE[0]}-${DSH_PROBE_RANGE[1]}）：请确认 DSH 已启动、编排插件已加载，或用 BP_DSH_URL 指定`,
    )
  }

  /** 并发探测端口段；返回首个编排器宿主端口（识别规则见 DSH_PROBE_RANGE 注释） */
  private async probeOrchestratorPort(): Promise<number | null> {
    const token = process.env.BP_DSH_TOKEN?.trim()
    const headers: Record<string, string> = token ? { 'x-api-token': token } : {}
    const ports: number[] = []
    for (let p = DSH_PROBE_RANGE[0]; p <= DSH_PROBE_RANGE[1]; p++) ports.push(p)
    let cursor = 0
    const worker = async (): Promise<number | null> => {
      for (;;) {
        const index = cursor++
        if (index >= ports.length) return null
        const port = ports[index]!
        try {
          const res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}/health`, `http://127.0.0.1:${port}`), {
            headers,
            signal: AbortSignal.timeout(DSH_PROBE_TIMEOUT_MS),
          })
          const body = await res.text()
          if (body.includes('"dsh-plugin-orchestrator"') || body.includes('"code":"unauthorized"')) {
            return port
          }
        } catch {
          /* 该端口无宿主 / 超时：继续 */
        }
      }
    }
    const workers = Array.from({ length: DSH_PROBE_CONCURRENCY }, () => worker())
    const results = await Promise.all(workers)
    return results.find((r): r is number => r !== null) ?? null
  }

  /** 认证头（apiToken 优先；否则 Cookie，需要时惰性经 /connect 换取） */
  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = process.env.BP_DSH_TOKEN?.trim()
    if (token) return { 'x-api-token': token, ...extra }
    if (!this.cookie && !this.injected) {
      const connectToken = process.env.BP_DSH_CONNECT_TOKEN?.trim()
      if (!connectToken) {
        throw new Error('未配置编排器认证：请设置 BP_DSH_TOKEN（插件 apiToken）或 BP_DSH_CONNECT_TOKEN（DSH 启动令牌）')
      }
      const res = await this.fetchImpl(new URL('/connect', await this.baseUrl()), {
        redirect: 'manual',
        ...(extra ? { headers: extra } : {}),
      })
      const headersWithSetCookie = res.headers as Headers & { getSetCookie?: () => string[] }
      const setCookie = headersWithSetCookie.getSetCookie?.()[0] ?? res.headers.get('set-cookie') ?? ''
      if (!setCookie) throw new Error('/connect 未返回 Cookie（启动令牌无效或已过期）')
      this.cookie = setCookie.split(';')[0] ?? ''
    }
    return { cookie: this.cookie ?? '', ...extra }
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const headers = await this.authHeaders(body === undefined ? undefined : { 'content-type': 'application/json' })
    let res: Response
    try {
      res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}${path}`, await this.baseUrl()), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (err) {
      // 宿主可能重启换了端口：清除探测缓存，重探一次
      this.resolvedBase = null
      if (process.env.BP_DSH_URL?.trim()) throw err
      res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}${path}`, await this.baseUrl()), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    }
    const json = (await res.json().catch(() => null)) as
      | { ok?: unknown; error?: OrchestratorError }
      | null
    if (!res.ok || !json || json.ok !== true) {
      const code = json?.error?.code ?? `HTTP ${res.status}`
      const message = json?.error?.message ?? res.statusText
      if (res.status === 401 || code === 'unauthorized') {
        throw new Error('编排器认证失败（401）：请检查 BP_DSH_TOKEN / BP_DSH_CONNECT_TOKEN 是否有效')
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
        const res = await this.fetchImpl(new URL(`${ORCHESTRATOR_PREFIX}/events`, await this.baseUrl()), {
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
