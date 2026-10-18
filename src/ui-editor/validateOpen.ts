/**
 * 打开/保存 UI 资产时的引用完整性校验装载（v3 T13.1）
 *
 * 收集项目元素/样式/预制体清单、项目/全局函数名与内置库清单，然后调用
 * validateUIAssetRefs。库服务不可用时不误报 ref-library-missing，改为一条 warning。
 */
import type { UIAsset, ElementAsset } from '@/ir/types'
import type { ValidationIssue } from '@/ir/validate'
import { validateUIAssetRefs, type LibraryManifestLite } from '@/ir/validate-ui'
import type { StyleSheet } from './styles'

interface TreeResponse {
  ok?: boolean
  tree?: { children?: Array<{ name?: string; type?: string }> }
}

/** 项目/库清单短缓存（编辑时 300ms 防抖校验，避免每次输入都发 4+ 请求） */
const CACHE_MS = 4000
const cache = new Map<string, { at: number; value: unknown }>()

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}

export function invalidateValidationCache(): void {
  cache.clear()
}

async function listDirFiles(
  projectPath: string,
  dir: string,
  suffix: string,
): Promise<string[] | null> {
  try {
    const r = await fetch(`/api/tree?path=${encodeURIComponent(`${projectPath}/${dir}`)}`)
    const j = (await r.json()) as TreeResponse
    if (!j.ok) return null
    return (j.tree?.children ?? [])
      .filter((c) => c.type === 'file' && typeof c.name === 'string' && c.name.toLowerCase().endsWith(suffix))
      .map((c) => `${dir}/${c.name}`)
  } catch {
    return null
  }
}

async function listLibrary(kind: 'elements' | 'styles' | 'functions'): Promise<string[] | null> {
  try {
    const r = await fetch(`/api/library/list?kind=${kind}`)
    const j = (await r.json()) as { ok?: boolean; entries?: Array<{ name?: string }> }
    if (!j.ok) return null
    return (j.entries ?? []).map((e) => e.name ?? '').filter((n) => n.length > 0)
  } catch {
    return null
  }
}

export interface OpenAssetValidation {
  issues: ValidationIssue[]
  libraryOffline: boolean
}

/** 校验当前打开 UI/元素资产（异步收集跨文件清单） */
export async function validateOpenUIAsset(input: {
  projectPath: string | null
  asset: UIAsset | ElementAsset
  assetPath?: string | null
  styleSheets: readonly StyleSheet[]
}): Promise<OpenAssetValidation> {
  const { projectPath, asset, assetPath, styleSheets } = input
  const scope: 'project' | 'library' =
    assetPath && assetPath.startsWith('@library/') ? 'library' : 'project'
  const dirCache = (dir: string, suffix: string) =>
    cached(`dir:${projectPath}:${dir}:${suffix}`, () => listDirFiles(projectPath!, dir, suffix))
  const projectElements = projectPath ? ((await dirCache('ui/elements', '.elem.json')) ?? undefined) : undefined
  const projectStyles = projectPath ? ((await dirCache('ui/styles', '.uss.json')) ?? undefined) : undefined
  const projectPrefabs = projectPath ? ((await dirCache('ui/prefabs', '.ui.json')) ?? undefined) : undefined
  const projectFunctions = projectPath
    ? ((await dirCache('library/functions', '.fn.json')) ?? undefined)
    : undefined

  const [libElements, libStyles, libFunctions] = await Promise.all([
    cached('lib:elements', () => listLibrary('elements')),
    cached('lib:styles', () => listLibrary('styles')),
    cached('lib:functions', () => listLibrary('functions')),
  ])
  const libraryOffline = libElements === null || libStyles === null || libFunctions === null
  const library: LibraryManifestLite | undefined = libraryOffline
    ? undefined
    : { elements: libElements!, styles: libStyles!, functions: libFunctions! }

  const externalFunctions = [
    ...(projectFunctions ?? []).map((p) => {
      const name = p.slice(p.lastIndexOf('/') + 1)
      return name.replace(/\.fn\.json$/i, '')
    }),
    ...(libFunctions ?? []),
  ]

  const styleClasses = new Set<string>()
  for (const sheet of styleSheets) {
    for (const name of Object.keys(sheet.classes)) styleClasses.add(name)
  }

  const issues = validateUIAssetRefs({
    asset: asset as UIAsset,
    styleClasses,
    projectElements,
    projectStyles,
    projectPrefabs,
    library,
    externalFunctions,
    scope,
  })
  if (libraryOffline) {
    issues.push({
      code: 'library-manifest-unavailable',
      severity: 'warning',
      message: '库清单不可用：已跳过内置库缺失校验',
      graphName: '',
    })
  }
  return { issues, libraryOffline }
}
