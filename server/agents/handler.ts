/**
 * agent 插件 invoke 处理器（blueprint-studio Agent 会话节点 → AgentGateway）
 *
 * 节点：agent.createSession / agent.sendMessage（action）；agent.sessionEvent 为
 * 事件节点（推送驱动，不经 invoke——服务端直接经 WS 广播 agent.notification 帧）。
 */
import type { InvokePayload } from '../plugins/executor'
import { AGENT_PLATFORMS, type AgentPlatform, type AgentSessionValue } from './types'
import { AgentGateway } from './gateway'
import { pluginPushHub } from '../plugins/executor'
import { ensureProjectsRoot } from '../fs'
import path from 'node:path'

function strArg(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function sessionArg(v: unknown): AgentSessionValue | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const platform = strArg(o.platform) as AgentPlatform
  const sessionId = strArg(o.sessionId)
  if (!sessionId) return null
  return {
    platform: (AGENT_PLATFORMS as readonly string[]).includes(platform) ? platform : 'dsh',
    sessionId,
    title: typeof o.title === 'string' ? o.title : '',
  }
}

/** Agent 网关单例（通知广播接 PluginPushHub；未登记会话广播全部订阅项目） */
export const agentGateway = new AgentGateway((project, message) => {
  if (project) pluginPushHub.broadcast(project, message)
  else pluginPushHub.broadcastAll(message)
})

export async function invokeAgentNode(
  node: string,
  args: Record<string, unknown>,
  deps: { project: string },
): Promise<InvokePayload> {
  const project = deps.project
  try {
    /**
     * 工作区目录解析（创建会话的内部设置「工作区」）：
     *  - 空 → 当前蓝图项目目录；
     *  - 绝对路径 → 原样（DSH 侧校验）；
     *  - 相对路径 → 相对项目目录（安全根内）。
     */
    const resolveWorkspaceDir = (workspace: unknown): string => {
      const projectDir = path.join(ensureProjectsRoot(), project)
      const ws = strArg(workspace)
      if (!ws) return projectDir
      if (path.isAbsolute(ws)) return ws
      return path.join(projectDir, ws)
    }
    if (node === 'agent.createSession' || node.endsWith('.createSession')) {
      const platform = (strArg(args.platform) || 'dsh') as AgentPlatform
      if (!(AGENT_PLATFORMS as readonly string[]).includes(platform)) {
        return { ok: false, message: `platform 必须为：${AGENT_PLATFORMS.join(' | ')}` }
      }
      // 会话工作目录：内部设置「工作区」（空 = 蓝图项目目录；DSH 工作区按路径幂等复用）
      const cwd = resolveWorkspaceDir(args.workspace)
      const session = await agentGateway.createSession(platform, project, {
        ...(strArg(args.title) ? { title: strArg(args.title) } : {}),
        cwd,
        ...(strArg(args.model) ? { model: strArg(args.model) } : {}),
        reuse: args.reuse === true,
      })
      return { ok: true, outputs: { session, sessionId: session.sessionId } }
    }
    if (node === 'agent.deleteSession' || node.endsWith('.deleteSession')) {
      const session = sessionArg(args.session)
      if (!session) {
        return { ok: false, message: '删除 Agent 会话需要 session 输入（会话类型变量，来自创建 Agent 会话节点）' }
      }
      await agentGateway.deleteSession(session.platform, session.sessionId)
      return { ok: true, outputs: {} }
    }
    if (node === 'agent.sendMessage' || node.endsWith('.sendMessage')) {
      const session = sessionArg(args.session)
      if (!session) {
        return { ok: false, message: '发送 Agent 消息需要 session 输入（会话类型变量，来自创建 Agent 会话节点）' }
      }
      const message = typeof args.message === 'string' ? args.message : ''
      if (!message.trim()) {
        return { ok: false, message: '消息内容不能为空（检视器「消息内容」或 message 输入）' }
      }
      const waitForCompletion = args.waitForCompletion !== false
      const timeoutSec = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? args.timeoutSec : 600
      const { reply } = await agentGateway.sendMessage({
        platform: session.platform,
        project,
        sessionId: session.sessionId,
        message,
        waitForCompletion,
        timeoutSec,
      })
      return { ok: true, outputs: { reply, sent: true } }
    }
    return { ok: false, message: `agent 插件未实现节点「${node}」的服务端执行器` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
