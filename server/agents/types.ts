/**
 * Agent 平台网关契约（纯蓝图工作流 · Agent 会话插件）
 *
 * 平台：dsh = dsh-plugin-orchestrator（真实连接）；codex / claude = 预留。
 *
 * dsh-plugin-orchestrator 真实接入方式（见插件 README，仓库
 * ~/Project/Common/harness-workspace/dsh-plugin-orchestrator）：插件**不自行监听端口**，
 * REST 网关挂在 DSH web 宿主上（`http://<host>:<port>/api/orchestrator/*`，桌面端默认
 * 端口随 `dsh web`，示例为 49300）；完成通知走 SSE（GET /api/orchestrator/events）。
 *
 * 环境变量：
 *   BP_DSH_URL           DSH web 宿主地址（缺省 http://127.0.0.1:49300）
 *   BP_DSH_TOKEN         插件 apiToken（cordis.patch.yml 配置；请求头 x-api-token）
 *   BP_DSH_CONNECT_TOKEN DSH 启动令牌（无 apiToken 时经 /connect?token= 换取 Cookie）
 *
 * 用到的端点（响应均为 {ok:true,...} / {ok:false,error:{code,message}}）：
 *   GET  /health                         健康检查
 *   POST /workspaces {path,title}        创建/复用工作区（同路径幂等）
 *   POST /sessions {workspaceId,title?,agentPreset?}  创建会话 → {sessionId}
 *   GET  /sessions/:id                   状态（title / status / running）
 *   POST /sessions/:id/prompt {text}     追加用户消息
 *   POST /sessions/:id/wait {timeoutMs}  阻塞等待空闲（超时 {idle:false,timedOut:true}）
 *   GET  /sessions/:id/result            最后一条 assistant 回复 → {result}
 *   POST /sessions/:id/cancel            取消运行
 *   POST /sessions/:id/archive           归档会话（删除会话节点 = 取消 + 归档）
 *   GET  /events（SSE）                  session.status / turn-start / turn-end /
 *                                        completed / interrupted / failed / created
 * 未覆盖的编排端点（relations / hooks / workspaces 管理）留适配器扩展点。
 *
 * 大模型 / 思考强度 / 权限的真实清单：编排器 REST 未暴露目录接口，适配器直接读
 * DSH 本机配置（零依赖迷你 YAML 解析）：
 *   - 模型：~/.dsh/settings.yaml → llm-pi-ai.providers.*.models[]（id / name / reasoningEfforts）
 *   - 权限：~/.dsh/profiles/<profile>/cordis.patch.yml → @deepseek-ai/dsh-permission-presets
 *     的 presets 键（read-only / workspace-write / danger-full-access 等）
 */

/** Agent 平台（DSH 真实连接；Codex / Claude 预留） */
export type AgentPlatform = 'dsh' | 'codex' | 'claude'

export const AGENT_PLATFORMS: readonly AgentPlatform[] = ['dsh', 'codex', 'claude']

/** 会话类型变量的运行时值（IRValueType 'session'） */
export interface AgentSessionValue {
  platform: AgentPlatform
  sessionId: string
  title: string
}

/** Agent 通知（会话事件节点监听的目标；由 SSE 事件映射而来） */
export interface AgentNotification {
  sessionId: string
  platform: AgentPlatform
  /** 通知类型：created / status / turn-start / turn-end / completed / interrupted / failed */
  kind: string
  /** 内容文本（completed = 结果摘要；failed = 错误消息） */
  content: string
  /** 原始 JSON（可选；透传给蓝图 raw 出脚） */
  raw?: string
  ts: number
}

/** 模型条目（DSH 配置目录；value = id，下拉显示 name） */
export interface AgentModelOption {
  id: string
  name: string
}

/** 平台能力（模型 / 思考强度 / 权限来自 DSH 本机配置，见文件头说明） */
export interface AgentCapabilities {
  platform: AgentPlatform
  connected: boolean
  models: AgentModelOption[]
  reasoningLevels: string[]
  permissions: string[]
}

/** 会话创建选项 */
export interface AgentCreateSessionOptions {
  /** 会话标题；空 = 使用 DSH 自动生成的标题 */
  title?: string
  /** 会话工作目录（blueprint-studio 项目目录；用于创建/复用工作区） */
  cwd?: string
  /** Agent 预设（DSH 会话的 agentPreset；创建时生效） */
  model?: string
}

/** 发送消息选项（waitForCompletion / timeoutSec 由适配器内部处理） */
export interface AgentSendMessageOptions {
  sessionId: string
  message: string
  waitForCompletion?: boolean
  timeoutSec?: number
}

/** 平台适配器（dsh 已实现；codex / claude 预留注册） */
export interface OrchestratorAdapter {
  readonly platform: AgentPlatform
  /** 健康检查（不可用时抛中文错误） */
  ensureConnected(): Promise<void>
  /** 平台能力（未连接时返回 connected:false 的空表） */
  capabilities(): Promise<AgentCapabilities>
  /** 创建会话（title 空 = 平台自动生成标题；cwd 用于创建/复用工作区） */
  createSession(opts: AgentCreateSessionOptions): Promise<AgentSessionValue>
  /** 发送消息；waitForCompletion=true 时阻塞等待完成并返回最终回复 */
  sendMessage(opts: AgentSendMessageOptions): Promise<{ reply: string }>
  /** 归档会话（先取消运行中的回合，best-effort；日志保留） */
  deleteSession(sessionId: string): Promise<void>
  /** 通知回调注册（网关注入；SSE 事件映射后回调） */
  onNotification(cb: (n: AgentNotification) => void): void
  /** 释放连接（进程退出 / 测试隔离用） */
  dispose(): void
}
