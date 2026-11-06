/**
 * Agent 平台网关契约（纯蓝图工作流 · Agent 会话插件）
 *
 * 平台：dsh = dsh-plugin-orchestrator 插件（真实连接）；codex / claude = 预留
 * （注册即可见，未连接时 invoke 返回中文提示，不炸蓝图）。
 *
 * dsh-plugin-orchestrator 连接契约（JSON over WebSocket，可经 BP_DSH_ORCHESTRATOR_URL
 * 覆盖，缺省 ws://127.0.0.1:8791）：
 *   请求  { type: 'rpc', id, method, params }
 *   响应  { type: 'rpc.result', id, ok, result? , error? }
 *   推送  { type: 'agent.notification', sessionId, kind, content, raw? }
 * 方法：
 *   agent.capabilities → { models: string[], reasoningLevels: string[], permissions: string[] }
 *   agent.createSession({ title? }) → { sessionId, title }
 *   agent.sendMessage({ sessionId, message, model?, reasoning?, permissions? }) → { accepted: true }
 * 契约对齐 dsh-plugin-orchestrator 实际实现后如需调整，只改本文件与本目录适配器。
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

/** Agent 通知（会话事件节点监听的目标） */
export interface AgentNotification {
  sessionId: string
  platform: AgentPlatform
  /** 通知类型：message（回复增量/完整回复）/ tool_call / status / error / completed 等，由 DSH 决定 */
  kind: string
  /** 内容文本 */
  content: string
  /** 原始 JSON（可选；透传给蓝图 raw 出脚） */
  raw?: string
  ts: number
}

/** 平台能力（模型 / 思考强度 / 权限域；节点检视器下拉的真实来源） */
export interface AgentCapabilities {
  platform: AgentPlatform
  connected: boolean
  models: string[]
  reasoningLevels: string[]
  permissions: string[]
}

/** 会话创建选项 */
export interface AgentCreateSessionOptions {
  /** 会话标题；空 = 使用 DSH 自动生成的标题 */
  title?: string
}

/** 发送消息选项（waitForCompletion 由网关层处理，不透传适配器） */
export interface AgentSendMessageOptions {
  sessionId: string
  message: string
  model?: string
  reasoning?: string
  permissions?: string
}

/** 平台适配器（dsh 已实现；codex / claude 预留注册） */
export interface OrchestratorAdapter {
  readonly platform: AgentPlatform
  /** 懒建立连接（幂等）；不可用时抛中文错误 */
  ensureConnected(): Promise<void>
  /** 平台能力（未连接时返回 connected:false 的缺省表） */
  capabilities(): Promise<AgentCapabilities>
  /** 创建会话（title 空 = 平台自动生成标题） */
  createSession(opts: AgentCreateSessionOptions): Promise<AgentSessionValue>
  /** 发送消息（立即返回受理结果；完成通知经通知流回推） */
  sendMessage(opts: AgentSendMessageOptions): Promise<void>
  /** 通知回调注册（网关注入；适配器在收到 agent.notification 帧时回调） */
  onNotification(cb: (n: AgentNotification) => void): void
  /** 释放连接（进程退出 / 测试隔离用） */
  dispose(): void
}
