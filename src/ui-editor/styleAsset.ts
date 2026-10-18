/**
 * 样式表资产（.uss.json）读写与级联（v3 T11.5/T11.7）
 */
import type { UIAsset } from '@/ir/types'
import { parseStyleSheet, type StyleSheet } from './styles'
import { renameClass } from '@/ir/refactor'

export function isLibraryStylePath(path: string): boolean {
  return path.startsWith('@library/styles/')
}

export function styleNameOf(path: string): string {
  if (isLibraryStylePath(path)) return path.slice('@library/styles/'.length)
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.uss\.json$/i, '')
}

export async function loadStyleAsset(
  projectPath: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StyleSheet> {
  const url = isLibraryStylePath(path)
    ? `/api/library/read?kind=styles&name=${encodeURIComponent(styleNameOf(path))}`
    : `/api/file?path=${encodeURIComponent(`${projectPath}/${path}`)}`
  const r = await fetchImpl(url)
  const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
  if (!j.ok || typeof j.content !== 'string') throw new Error(j.message ?? '样式表读取失败')
  return parseStyleSheet(j.content)
}

export async function saveStyleAsset(
  projectPath: string,
  path: string,
  sheet: StyleSheet,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const content = JSON.stringify(sheet, null, 2)
  const r = isLibraryStylePath(path)
    ? await fetchImpl('/api/library/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'styles', name: styleNameOf(path), content }),
      })
    : await fetchImpl('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${projectPath}/${path}`, content }),
      })
  const j = (await r.json()) as { ok?: boolean; message?: string }
  if (!j.ok) throw new Error(j.message ?? '样式表保存失败')
}

/** 当前项目内所有 UI/元素资产（级联样式类改名用） */
async function listProjectUiAssets(
  projectPath: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  try {
    const r = await fetchImpl(`/api/tree?path=${encodeURIComponent(`${projectPath}/ui`)}`)
    const j = (await r.json()) as {
      ok?: boolean
      tree?: { children?: Array<{ name?: string; path?: string; type?: string; children?: unknown[] }> }
    }
    const out: string[] = []
    const walk = (nodes: Array<{ name?: string; path?: string; type?: string; children?: unknown[] }>): void => {
      for (const n of nodes) {
        if (n.type === 'file' && typeof n.path === 'string') {
          const lower = n.path.toLowerCase()
          if (lower.endsWith('.ui.json') || lower.endsWith('.elem.json')) {
            out.push(n.path.slice(projectPath.length + 1))
          }
        }
        if (Array.isArray(n.children)) {
          walk(n.children as Array<{ name?: string; path?: string; type?: string; children?: unknown[] }>)
        }
      }
    }
    walk(j.tree?.children ?? [])
    return out
  } catch {
    return []
  }
}

/** 样式类改名级联到当前项目全部 UI/元素资产（编辑器内改名保证级联） */
export async function cascadeRenameStyleClass(
  projectPath: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!from || from === to) return 0
  const files = await listProjectUiAssets(projectPath, fetchImpl)
  let changed = 0
  for (const path of files) {
    try {
      const r = await fetchImpl(`/api/file?path=${encodeURIComponent(`${projectPath}/${path}`)}`)
      const j = (await r.json()) as { ok?: boolean; content?: string }
      if (!j.ok || typeof j.content !== 'string') continue
      const asset = JSON.parse(j.content) as UIAsset
      const next = renameClass(asset, from, to)
      if (JSON.stringify(next) === JSON.stringify(asset)) continue
      await fetchImpl('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: `${projectPath}/${path}`, content: JSON.stringify(next, null, 2) }),
      })
      changed += 1
    } catch {
      /* 单个资产失败不阻断其它资产 */
    }
  }
  return changed
}
