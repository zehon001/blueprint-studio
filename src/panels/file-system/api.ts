/**
 * 文件系统面板 API 薄封装（T0.7）
 *
 * 只做三件事：JSON 解析、统一错误（{ ok:false, message } → FsApiError）、类型标注。
 * 契约以 server/index.ts 为准（不 import server 代码，避免跨界依赖）：
 *  - GET    /api/tree?path=            → { ok, tree }
 *  - PUT    /api/file { path, content }→ { path, size }
 *  - DELETE /api/file?path=            → { path, kind }
 *  - POST   /api/move { from, to }     → { path, moved }
 *  - POST   /api/import { targetDir, sourcePath } → { ok, target, files, bytes, renamed }
 *  - GET    /api/projects              → { ok, root, projects }（取安全根绝对路径，供「复制」走服务端本地复制）
 *  - GET    /api/watch?path=           → SSE（浏览器 EventSource 直连，见 watchUrl）
 *
 * 所有 path 参数均为「相对安全根的 posix 相对路径」，首段 = 项目文件夹名。
 * fetch 注入式：createFsApi(fetchLike) 便于测试 mock；默认实例走全局 fetch
 * （开发期 vite 将 /api 代理到本地服务，生产构建由同源托管）。
 */
import type { FsNode } from './tree-model'

/** 带 HTTP 状态码的 API 错误（message 为服务端 / 网络层的中文提示） */
export class FsApiError extends Error {
  /** HTTP 状态码；0 = 网络层失败（本地服务未启动等） */
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FsApiError'
    this.status = status
  }
}

/** 统一错误文案（面板 toast / 命令撤销提示共用） */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** POST /api/import 的返回（与 server/fs.ts 的 ImportResult 对齐） */
export interface ImportResult {
  ok: true
  /** 实际落盘位置（相对安全根，posix；冲突时服务端自动加 " (n)" 后缀） */
  target: string
  files: number
  bytes: number
  renamed: boolean
}

/** DELETE /api/file 的返回 */
export interface DeleteResult {
  path: string
  kind: 'file' | 'dir'
}

/** POST /api/move 的返回 */
export interface MoveResult {
  path: string
  moved: boolean
}

export interface FsApi {
  /** 读目录树（path = 项目文件夹名或项目内目录） */
  readTree(path: string): Promise<{ tree: FsNode }>
  /** 写文本文件（父目录不存在则服务端自动创建；目标为空串以外的文本） */
  writeFile(path: string, content: string): Promise<{ path: string; size: number }>
  /** 删除文件 / 目录（递归）；项目根本身不可删（服务端校验） */
  deletePath(path: string): Promise<DeleteResult>
  /** 移动 / 重命名 */
  move(from: string, to: string): Promise<MoveResult>
  /** 服务端本地导入（sourcePath 为本机绝对路径；targetDir 为项目内目录） */
  importFile(targetDir: string, sourcePath: string): Promise<ImportResult>
  /** 安全根绝对路径（「复制」把项目内文件作为导入源时拼接用；带缓存） */
  projectsRoot(): Promise<string>
  /** SSE watch 地址（EventSource 直连） */
  watchUrl(path: string): string
}

async function request<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch {
    throw new FsApiError(0, '无法连接本地服务（请先启动：npx tsx server/index.ts）')
  }
  let payload: { ok?: boolean; message?: string } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    /* 非 JSON 响应：按状态码处理 */
  }
  if (!res.ok || payload.ok === false) {
    throw new FsApiError(res.status, payload.message ?? `请求失败（HTTP ${res.status}）`)
  }
  return payload as T
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 创建 API 实例（fetch 可注入便于测试） */
export function createFsApi(fetchImpl: FetchLike = (...args) => fetch(...args)): FsApi {
  let rootCache: Promise<string> | null = null
  return {
    async readTree(path: string) {
      const r = await request<{ ok: true; tree: FsNode }>(fetchImpl, `/api/tree?path=${encodeURIComponent(path)}`)
      return { tree: r.tree }
    },

    async writeFile(path: string, content: string) {
      return request<{ path: string; size: number }>(fetchImpl, '/api/file', jsonInit('PUT', { path, content }))
    },

    async deletePath(path: string) {
      return request<DeleteResult>(fetchImpl, `/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    },

    async move(from: string, to: string) {
      return request<MoveResult>(fetchImpl, '/api/move', jsonInit('POST', { from, to }))
    },

    async importFile(targetDir: string, sourcePath: string) {
      return request<ImportResult>(fetchImpl, '/api/import', jsonInit('POST', { targetDir, sourcePath }))
    },

    projectsRoot(): Promise<string> {
      if (!rootCache) {
        rootCache = request<{ ok: true; root: string }>(fetchImpl, '/api/projects')
          .then((r) => r.root)
          .catch((e: unknown) => {
            rootCache = null // 失败不缓存，下次重试
            throw e
          })
      }
      return rootCache
    },

    watchUrl(path: string) {
      return `/api/watch?path=${encodeURIComponent(path)}`
    },
  }
}

/** 面板默认实例 */
export const defaultFsApi: FsApi = createFsApi()
