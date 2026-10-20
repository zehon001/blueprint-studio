/**
 * Blueprint Studio v2 —— 项目管理器页 API 薄封装（T0.6）
 *
 * 只做三件事：JSON 解析、统一错误（{ ok:false, message } → ApiError）、类型标注。
 * 契约以 server/index.ts 为准：
 *  - GET  /api/projects                    → { ok, root, projects: ProjectSummary[] }
 *  - POST /api/projects                    → { ok, project }（body: { name, template }）
 *  - DELETE /api/projects?path=<folder>    → { ok, path }（永久删除磁盘项目目录）
 *  - POST /api/projects/import-folder      → { ok, project, files, bytes, renamed, scaffolded }
 *    （body: { sourcePath, name? }，T0.6 新增端点）
 */

/** 带 HTTP 状态码的 API 错误（message 为服务端 / 网络层的中文提示） */
export class ApiError extends Error {
  /** HTTP 状态码；0 = 网络层失败（服务未启动等） */
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 服务端项目摘要（与 fs.ts 的 ProjectSummary 对齐） */
export interface ProjectSummary {
  /** 显示名（project.json.name；损坏时回落为文件夹名） */
  name: string
  /** 项目文件夹名（相对安全根） */
  path: string
  mainUI: string | null
  engineVersion: string | null
  mtime: string | null
  broken?: boolean
}

/** 整文件夹导入结果（与 fs.ts 的 ImportFolderResult 对齐） */
export interface ImportFolderResult {
  ok: true
  project: ProjectSummary
  files: number
  bytes: number
  renamed: boolean
  scaffolded: boolean
}

/** 统一请求：非 2xx 或 ok:false 时抛 ApiError(message) */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError(0, '无法连接本地服务（请先启动：npx tsx server/index.ts）')
  }
  let payload: { ok?: boolean; message?: string } = {}
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    /* 非 JSON 响应：按状态码处理 */
  }
  if (!res.ok || payload.ok === false) {
    throw new ApiError(res.status, payload.message ?? `请求失败（HTTP ${res.status}）`)
  }
  return payload as T
}

function post<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 项目管理器用到的三个端点 */
export const projectsApi = {
  /** 列出安全根内的全部项目 */
  list(): Promise<{ ok: true; root: string; projects: ProjectSummary[] }> {
    return request('/api/projects')
  },

  /** 从模板新建项目（template：'empty' | 'log-analyzer'） */
  create(name: string, template: string): Promise<{ ok: true; project: ProjectSummary }> {
    return post('/api/projects', { name, template })
  },

  /** 永久删除磁盘项目（path = 项目文件夹名，不可撤销） */
  remove(path: string): Promise<{ ok: true; path: string }> {
    return request(`/api/projects?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  },

  /** 导入本地文件夹为新项目（sourcePath 为绝对路径；name 可选重命名） */
  importFolder(sourcePath: string, name?: string): Promise<ImportFolderResult> {
    return post('/api/projects/import-folder', name ? { sourcePath, name } : { sourcePath })
  },
}
