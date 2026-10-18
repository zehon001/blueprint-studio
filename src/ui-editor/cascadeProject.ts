/**
 * 项目内资产改名的引用级联（v3 T13.1）
 *
 * 编辑器内改名必须同步引用（PLAN §11）：元素路径 / 样式表路径 / 函数名。
 * 服务端只负责文件移动；这里扫描当前项目 JSON 资产并就地改写引用后写回。
 */
import type { IRAsset, UIAsset } from '@/ir/types'
import { renameElementPath } from '@/ir/refactor'

interface TreeLike {
  ok?: boolean
  tree?: { children?: TreeNodeLike[] }
}
interface TreeNodeLike {
  name?: string
  path?: string
  type?: string
  children?: TreeNodeLike[]
}

async function listProjectFiles(
  projectPath: string,
  suffixes: readonly string[],
  fetchImpl: typeof fetch,
): Promise<string[]> {
  try {
    const r = await fetchImpl(`/api/tree?path=${encodeURIComponent(projectPath)}`)
    const j = (await r.json()) as TreeLike
    const out: string[] = []
    const walk = (nodes: TreeNodeLike[]): void => {
      for (const n of nodes) {
        if (n.type === 'file' && typeof n.path === 'string') {
          const lower = n.path.toLowerCase()
          if (suffixes.some((s) => lower.endsWith(s))) out.push(n.path.slice(projectPath.length + 1))
        }
        if (n.children) walk(n.children)
      }
    }
    walk(j.tree?.children ?? [])
    return out
  } catch {
    return []
  }
}

async function readJson<T>(projectPath: string, rel: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const r = await fetchImpl(`/api/file?path=${encodeURIComponent(`${projectPath}/${rel}`)}`)
    const j = (await r.json()) as { ok?: boolean; content?: string }
    if (!j.ok || typeof j.content !== 'string') return null
    return JSON.parse(j.content) as T
  } catch {
    return null
  }
}

async function writeJson(
  projectPath: string,
  rel: string,
  value: unknown,
  fetchImpl: typeof fetch,
): Promise<void> {
  await fetchImpl('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: `${projectPath}/${rel}`, content: JSON.stringify(value, null, 2) }),
  })
}

/** 元素文件重命名 → 更新全部 UI/元素资产里的 element 引用 */
export async function cascadeElementRename(
  projectPath: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let changed = 0
  for (const rel of await listProjectFiles(projectPath, ['.ui.json', '.elem.json'], fetchImpl)) {
    const asset = await readJson<UIAsset>(projectPath, rel, fetchImpl)
    if (!asset) continue
    const next = renameElementPath(asset, from, to)
    if (JSON.stringify(next) === JSON.stringify(asset)) continue
    await writeJson(projectPath, rel, next, fetchImpl)
    changed += 1
  }
  return changed
}

/** 样式表文件重命名 → 更新 asset.styles 引用 */
export async function cascadeStyleRename(
  projectPath: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let changed = 0
  for (const rel of await listProjectFiles(projectPath, ['.ui.json', '.elem.json'], fetchImpl)) {
    const asset = await readJson<UIAsset>(projectPath, rel, fetchImpl)
    if (!asset || !asset.styles?.includes(from)) continue
    asset.styles = asset.styles.map((s) => (s === from ? to : s))
    await writeJson(projectPath, rel, asset, fetchImpl)
    changed += 1
  }
  return changed
}

/** 统计项目资产中对某条目的引用次数（元素/样式路径或函数名；编辑器详情用） */
export async function countProjectReferences(
  projectPath: string,
  kind: 'element' | 'style' | 'function',
  nameOrPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const files = await listProjectFiles(
    projectPath,
    ['.ui.json', '.elem.json', '.fn.json', '.bp.json'],
    fetchImpl,
  )
  const needles =
    kind === 'function'
      ? [`"function": "${nameOrPath}"`, `"function":"${nameOrPath}"`]
      : [nameOrPath]
  let count = 0
  for (const rel of files) {
    try {
      const r = await fetchImpl(`/api/file?path=${encodeURIComponent(`${projectPath}/${rel}`)}`)
      const j = (await r.json()) as { ok?: boolean; content?: string }
      if (!j.ok || typeof j.content !== 'string') continue
      for (const needle of needles) count += j.content.split(needle).length - 1
    } catch {
      /* 单个文件失败忽略 */
    }
  }
  return count
}

/** 项目函数改名 → 更新 flow.call 的 function（project/auto） */
export async function cascadeFunctionRename(
  projectPath: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  let changed = 0
  const files = await listProjectFiles(projectPath, ['.ui.json', '.elem.json', '.fn.json', '.bp.json'], fetchImpl)
  for (const rel of files) {
    const asset = await readJson<IRAsset>(projectPath, rel, fetchImpl)
    if (!asset || !asset.graphs) continue
    let hit = false
    for (const graph of Object.values(asset.graphs)) {
      for (const node of graph.nodes ?? []) {
        if (node.type !== 'flow.call') continue
        const scope = String(node.params?.scope ?? 'auto')
        if (node.params?.function !== from) continue
        if (scope === 'project' || scope === 'auto') {
          node.params = { ...(node.params ?? {}), function: to }
          hit = true
        }
      }
    }
    if (!hit) continue
    await writeJson(projectPath, rel, asset, fetchImpl)
    changed += 1
  }
  return changed
}
