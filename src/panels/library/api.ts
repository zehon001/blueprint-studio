/**
 * 资源库 REST 客户端（v3 T11.5）
 *
 * 与 server/index.ts /api/library/* 契约对齐；错误统一抛中文 Error。
 */
export type LibraryKind = 'elements' | 'styles' | 'functions'

async function jsonOf<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { ok?: boolean; message?: string } & T
  if (!res.ok || body.ok === false) throw new Error(body.message ?? `请求失败：HTTP ${res.status}`)
  return body
}

export interface LibraryEntrySummary {
  name: string
  size?: number
  mtime?: string
}

export async function listLibraryEntries(kind: LibraryKind): Promise<LibraryEntrySummary[]> {
  const r = await fetch(`/api/library/list?kind=${encodeURIComponent(kind)}`)
  const body = await jsonOf<{ entries?: LibraryEntrySummary[] }>(r)
  return body.entries ?? []
}

export async function createLibraryEntry(kind: LibraryKind, name: string, content: string): Promise<void> {
  await jsonOf(
    await fetch('/api/library/write', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, name, content }),
    }),
  )
}

export async function deleteLibraryEntry(kind: LibraryKind, name: string): Promise<void> {
  await jsonOf(
    await fetch(`/api/library/delete?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  )
}

export async function renameLibraryEntry(kind: LibraryKind, from: string, to: string): Promise<void> {
  await jsonOf(
    await fetch('/api/library/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, from, to }),
    }),
  )
}

/** 订阅库变更 SSE（§7.6）；返回退订函数（EventSource 不可用/失败时静默） */
export function watchLibrary(onChange: () => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  let es: EventSource | null = null
  try {
    es = new EventSource('/api/library/watch')
    es.onmessage = () => onChange()
  } catch {
    es = null
  }
  return () => {
    es?.close()
  }
}
