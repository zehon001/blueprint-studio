/**
 * 插件管理面板 API 层（T6.2）
 *
 * 端点契约（对端：server/plugins/registry.ts = T6.1 已交付、server/plugins/executor.ts
 * = T6.3 并行开发中；本文件不 import 服务端代码，仅按定案契约走 HTTP）：
 *  - GET  /api/plugins?project=<项目>                 → { ok, manifests, warnings }
 *      manifest.source ∈ builtin | project | static；manifests[i].nodes 为配套节点。
 *  - POST /api/plugins/:id/detect?project=<项目>      → { ok, installed, version?, latest?, updatable, message?, cmd? }
 *  - GET  /api/plugins/:id/install?project=<项目>&action=install|update → SSE 流
 *      data:{"type":"log","line"} / {"type":"done",...} / {"type":"error","message"}
 *
 * project 传 null = 未打开项目（不带 project 参数，服务端只列内置 + 静态目录）。
 * fetch 注入式：createPluginApi(fetchLike) 便于测试 mock；默认实例走全局 fetch
 * （开发期 vite 将 /api 代理到本地服务，生产构建同源托管）。
 * SSE 消费不用 EventSource：统一 fetch 流解析（见 sse.ts，可携带 AbortSignal 取消）。
 */
import type { PluginManifest } from '@/ir/types'
import { consumeSseBody, type InstallOutcome, type InstallStreamEvent } from './sse'
import type { DetectResult } from './model'

export type { DetectResult }

/** 带 HTTP 状态码的 API 错误（message 为服务端 / 网络层的中文提示） */
export class PluginApiError extends Error {
  /** HTTP 状态码；0 = 网络层失败（本地服务未启动等） */
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'PluginApiError'
    this.status = status
  }
}

/** 统一错误文案（toast / 状态徽标 tooltip 共用） */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** GET /api/plugins 的返回（清单 + 警告） */
export interface PluginsListResult {
  manifests: PluginManifest[]
  /** 清单损坏 / 校验失败等告警（列表顶部警告条展示） */
  warnings: string[]
}

/** 安装流回调集合 */
export interface InstallHandlers {
  /** 每个流事件（log / done / error） */
  onEvent: (ev: InstallStreamEvent) => void
}

export interface PluginApi {
  /** 拉取三源合并清单（project = 项目文件夹名；null = 不带参数） */
  list(project: string | null): Promise<PluginsListResult>
  /** 单插件检测（T6.3 契约；HTTP/ok 失败抛 PluginApiError，由调用方按未安装处理） */
  detect(pluginId: string, project: string | null): Promise<DetectResult>
  /**
   * 发起安装 / 更新并消费 SSE 流（resolve 于流结束：done / error / aborted / closed）。
   * signal 用于「停止」按钮（AbortController）；HTTP 非 200 或 body 缺失抛错。
   */
  startInstall(opts: {
    pluginId: string
    action: 'install' | 'update'
    project: string | null
    signal: AbortSignal
  } & InstallHandlers): Promise<InstallOutcome>
}

function projectQuery(project: string | null): string {
  return project ? `?project=${encodeURIComponent(project)}` : ''
}

async function request<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch {
    throw new PluginApiError(0, '无法连接本地服务（请先启动：npx tsx server/index.ts）')
  }
  let payload: { ok?: boolean; message?: string } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    /* 非 JSON 响应：按状态码处理 */
  }
  if (!res.ok || payload.ok === false) {
    throw new PluginApiError(res.status, payload.message ?? `请求失败（HTTP ${res.status}）`)
  }
  return payload as T
}

/** 创建 API 实例（fetch 可注入便于测试） */
export function createPluginApi(fetchImpl: FetchLike = (...args) => fetch(...args)): PluginApi {
  return {
    async list(project) {
      const r = await request<{ ok: true; manifests: PluginManifest[]; warnings?: string[] }>(
        fetchImpl,
        `/api/plugins${projectQuery(project)}`,
      )
      return { manifests: Array.isArray(r.manifests) ? r.manifests : [], warnings: Array.isArray(r.warnings) ? r.warnings : [] }
    },

    async detect(pluginId, project) {
      return request<DetectResult>(
        fetchImpl,
        `/api/plugins/${encodeURIComponent(pluginId)}/detect${projectQuery(project)}`,
        { method: 'POST' },
      )
    },

    async startInstall({ pluginId, action, project, signal, onEvent }) {
      const url = `/api/plugins/${encodeURIComponent(pluginId)}/install${project ? `${projectQuery(project)}&` : '?'}action=${action}`
      let res: Response
      try {
        res = await fetchImpl(url, { signal })
      } catch (e) {
        if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) return 'aborted'
        throw new PluginApiError(0, '无法连接本地服务（请先启动：npx tsx server/index.ts）')
      }
      if (!res.ok) throw new PluginApiError(res.status, `安装请求失败（HTTP ${res.status}）`)
      return consumeSseBody(res.body, onEvent, signal)
    },
  }
}

/** 面板默认实例 */
export const defaultPluginApi: PluginApi = createPluginApi()
