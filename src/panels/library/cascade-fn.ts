/**
 * 函数条目引用级联与引用计数（纯蓝图工作流）
 *
 * 项目内函数改名必须同步引用：扫描当前项目 .bp.json / .fn.json 资产并
 * 就地改写 flow.call 引用后写回；引用计数供资源库详情展示。
 */
import type { IRAsset } from '@/ir/types'

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

/** 统计项目资产中对某函数名的引用次数（flow.call 引用；资源库详情用） */
export async function countFunctionReferences(
  projectPath: string,
  fnName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const files = await listProjectFiles(projectPath, ['.bp.json', '.fn.json'], fetchImpl)
  let count = 0
  for (const rel of files) {
    try {
      const r = await fetchImpl(`/api/file?path=${encodeURIComponent(`${projectPath}/${rel}`)}`)
      const j = (await r.json()) as { ok?: boolean; content?: string }
      if (!j.ok || typeof j.content !== 'string') continue
      for (const needle of [`"function": "${fnName}"`, `"function":"${fnName}"`]) {
        count += j.content.split(needle).length - 1
      }
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
  const files = await listProjectFiles(projectPath, ['.bp.json', '.fn.json'], fetchImpl)
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
