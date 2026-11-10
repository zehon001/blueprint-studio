/**
 * 人员页 API 客户端。
 *
 * 服务端路由见 server/personnel.ts；统一 { ok, ... } / { ok:false, message } 契约。
 */
import type {
  PersonDetail,
  PersonMemory,
  PersonModelSettings,
  PersonQueueState,
  PersonSummary,
  PersonType,
  PersonWorkspaceSettings,
  RoleCard,
} from '@/shared/personnel'

export class PersonnelApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'PersonnelApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    throw new PersonnelApiError(0, '无法连接本地服务，请确认 npm run server 已启动')
  }
  const payload = (await res.json().catch(() => null)) as
    | { ok?: boolean; message?: string }
    | null
  if (!res.ok || !payload || payload.ok === false) {
    throw new PersonnelApiError(
      res.status,
      payload?.message || `请求失败（HTTP ${res.status}）`,
    )
  }
  return payload as T
}

function idPath(id: string, suffix = ''): string {
  return `/api/personnel/${encodeURIComponent(id)}${suffix}`
}

export interface PersonListPayload {
  ok: true
  people: PersonSummary[]
  types: PersonType[]
}

export interface PersonPayload {
  ok: true
  person: PersonDetail
}

export interface WorkspaceBuildPayload {
  ok: true
  workspaceDir: string
  moved: string[]
  skipped: string[]
  builtAt: number
}

export interface PersonQueuePayload {
  ok: true
  queue: PersonQueueState
}

export interface PersonMemoryPayload {
  ok: true
  memory: PersonMemory
}

export interface PersonUpdatePatch {
  name?: string
  typeId?: string
  task?: string
  cards?: RoleCard[]
  norms?: string
  model?: Partial<PersonModelSettings>
  workspace?: Partial<PersonWorkspaceSettings>
}

export interface PersonCapabilities {
  connected: boolean
  models: Array<{ id: string; name: string }>
  reasoningLevels: string[]
  permissions: string[]
  defaults: { model: string; reasoning: string; permission: string }
}

export const personnelApi = {
  list: () => request<PersonListPayload>('/api/personnel'),
  get: (id: string) => request<PersonPayload>(idPath(id)),
  create: (input: { name: string; typeId?: string }) =>
    request<PersonPayload>('/api/personnel', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: PersonUpdatePatch) =>
    request<PersonPayload>(idPath(id), {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) => request<{ ok: true }>(idPath(id), { method: 'DELETE' }),
  saveTypes: (types: PersonType[]) =>
    request<{ ok: true; types: PersonType[] }>('/api/personnel/types', {
      method: 'PUT',
      body: JSON.stringify({ types }),
    }),
  uploadAvatar: (id: string, dataUrl: string) =>
    request<{ ok: true; avatarUrl: string }>(idPath(id, '/avatar'), {
      method: 'POST',
      body: JSON.stringify({ dataUrl }),
    }),
  buildWorkspace: (id: string) =>
    request<WorkspaceBuildPayload>(idPath(id, '/workspace/build'), { method: 'POST' }),
  resetWorkspace: (id: string) =>
    request<WorkspaceBuildPayload>(idPath(id, '/workspace/reset'), { method: 'POST' }),
  addTask: (id: string, input: { title?: string; content: string }) =>
    request<PersonPayload>(idPath(id, '/tasks'), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteTask: (id: string, taskId: string) =>
    request<PersonPayload>(idPath(id, `/tasks/${encodeURIComponent(taskId)}`), {
      method: 'DELETE',
    }),
  moveTask: (id: string, taskId: string, direction: 'up' | 'down') =>
    request<PersonPayload>(idPath(id, `/tasks/${encodeURIComponent(taskId)}/move`), {
      method: 'POST',
      body: JSON.stringify({ direction }),
    }),
  retryTask: (id: string, taskId: string) =>
    request<PersonPayload>(idPath(id, `/tasks/${encodeURIComponent(taskId)}/retry`), {
      method: 'POST',
    }),
  run: (id: string) => request<PersonQueuePayload>(idPath(id, '/run'), { method: 'POST' }),
  stop: (id: string) => request<PersonQueuePayload>(idPath(id, '/stop'), { method: 'POST' }),
  clearMemory: (id: string) =>
    request<PersonMemoryPayload>(idPath(id, '/memory/clear'), { method: 'POST' }),
  capabilities: async (): Promise<PersonCapabilities | null> => {
    try {
      const res = await fetch('/api/agents/capabilities?platform=dsh')
      const body = (await res.json()) as {
        ok?: boolean
        capabilities?: PersonCapabilities
      }
      return body.ok && body.capabilities ? body.capabilities : null
    } catch {
      return null
    }
  },
  selectDirectory: async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/dialog/select-directory', { method: 'POST' })
      const body = (await res.json()) as { ok?: boolean; path?: string }
      return body.ok && body.path ? body.path : null
    } catch {
      return null
    }
  },
}
