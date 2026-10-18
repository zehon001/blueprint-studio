/**
 * 三档函数运行时解析（v3 T12.9 · PLAN §3.4/§9）
 *
 * `flow.call` 的 `params.function` + `params.scope`（缺省 auto）解析顺序：
 * 资产内图（graph）→ 项目库 library/functions/<name>.fn.json → 内置库 @library/functions/<name>。
 * 外部函数加载后以唯一图名注入当前 IRAsset，调用节点的 params.graph 改写为该图名，
 * 解释器沿用既有调用栈语义执行；参数/返回值沿用函数资产的 graph.params/returns。
 */
import type { IRAsset, IRGraph } from '@/ir/types'

export type FunctionScope = 'auto' | 'blueprint' | 'project' | 'global'

export interface ResolvedFunctions {
  asset: IRAsset
  loaded: Array<{ scope: 'project' | 'global'; name: string; graph: string }>
  errors: string[]
}

interface FnAsset {
  version?: number
  kind?: string
  name?: string
  scope?: string
  params?: IRGraph['params']
  returns?: IRGraph['returns']
  graph?: IRGraph
}

/** 解析单个外部函数资产文本 → 图（非法抛中文错误） */
export function functionGraphOf(text: string, name: string): IRGraph {
  let raw: FnAsset
  try {
    raw = JSON.parse(text) as FnAsset
  } catch (err) {
    throw new Error(`函数资产不是合法 JSON：${name}（${err instanceof Error ? err.message : String(err)}）`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`函数资产格式错误：${name}`)
  if (raw.version !== 3) {
    throw new Error(`函数资产版本不兼容：${name}（${String(raw.version)}，v3 仅支持 version 3）`)
  }
  const g = raw.graph ?? { nodes: [], edges: [] }
  return {
    nodes: g.nodes ?? [],
    edges: g.edges ?? [],
    params: raw.params ?? g.params ?? [],
    returns: raw.returns ?? g.returns ?? [],
    ...(g.comments ? { comments: g.comments } : {}),
  }
}

/** 扫描 flow.call 的目标（function 优先，回落 graph） */
export function callTarget(node: { params?: Record<string, unknown> }): string {
  const p = node.params ?? {}
  const f = typeof p.function === 'string' ? p.function : ''
  const g = typeof p.graph === 'string' ? p.graph : ''
  return f || g
}

/** 作用域读取（非法回落 auto） */
export function callScope(node: { params?: Record<string, unknown> }): FunctionScope {
  const s = node.params?.scope
  return s === 'blueprint' || s === 'project' || s === 'global' ? s : 'auto'
}

export interface ResolveFunctionOptions {
  project: string
  fetchImpl?: typeof fetch
  onPrint?: (line: string) => void
}

/**
 * 解析并注入外部函数图（不修改入参；返回新 IRAsset）。
 * 蓝图函数已在资产 graphs 内则不动；缺失/越界记 errors 并保留原调用（运行时将报错）。
 */
export async function resolveExternalFunctions(
  asset: IRAsset,
  opts: ResolveFunctionOptions,
): Promise<ResolvedFunctions> {
  // 深拷贝节点层：改写 params.graph 不得污染入参资产（编辑器 store 仍在用）
  const graphs: Record<string, IRGraph> = Object.fromEntries(
    Object.entries(asset.graphs).map(([k, g]) => [k, { ...g, nodes: (g.nodes ?? []).map((n) => ({ ...n })) }]),
  )
  const loaded: ResolvedFunctions['loaded'] = []
  const errors: string[] = []
  const fetchImpl = opts.fetchImpl ?? fetch
  const loadedKeys = new Set<string>()

  const loadProject = async (name: string): Promise<{ graph: IRGraph; key: string } | null> => {
    const key = `__fn_project_${name}`
    if (graphs[key]) return { graph: graphs[key]!, key }
    try {
      const r = await fetchImpl(
        `/api/file?path=${encodeURIComponent(`${opts.project}/library/functions/${name}.fn.json`)}`,
      )
      const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
      if (!j.ok) return null
      const graph = functionGraphOf(String(j.content ?? ''), name)
      graphs[key] = graph
      return { graph, key }
    } catch {
      return null
    }
  }

  const loadGlobal = async (name: string): Promise<{ graph: IRGraph; key: string } | null> => {
    const key = `__fn_global_${name}`
    if (graphs[key]) return { graph: graphs[key]!, key }
    try {
      const r = await fetchImpl(
        `/api/library/read?kind=functions&name=${encodeURIComponent(name)}`,
      )
      const j = (await r.json()) as { ok?: boolean; content?: string; message?: string }
      if (!j.ok) return null
      const graph = functionGraphOf(String(j.content ?? ''), name)
      graphs[key] = graph
      return { graph, key }
    } catch {
      return null
    }
  }

  for (const [graphName, graph] of Object.entries(graphs)) {
    for (const node of graph.nodes ?? []) {
      if (node.type !== 'flow.call') continue
      const target = callTarget(node)
      if (!target) continue
      const scope = callScope(node)
      // 资产内图直接命中（graph 参数即图名）
      if (graphName && graphs[target]) continue
      if (scope === 'blueprint') {
        if (!graphs[target]) errors.push(`flow.call 目标函数不存在（蓝图）：${target}`)
        continue
      }
      let hit: { graph: IRGraph; key: string; scope: 'project' | 'global' } | null = null
      if (scope === 'auto' || scope === 'project') {
        const p = await loadProject(target)
        if (p) hit = { ...p, scope: 'project' }
      }
      if (!hit && (scope === 'auto' || scope === 'global')) {
        const g = await loadGlobal(target)
        if (g) hit = { ...g, scope: 'global' }
      }
      if (!hit) {
        errors.push(`flow.call 目标函数不存在（${scope}）：${target}`)
        continue
      }
      node.params = { ...node.params, graph: hit.key }
      const id = `${hit.scope}:${target}`
      if (!loadedKeys.has(id)) {
        loadedKeys.add(id)
        loaded.push({ scope: hit.scope, name: target, graph: hit.key })
        opts.onPrint?.(`[函数] 已加载${hit.scope === 'project' ? '全项目' : '全局'}函数 ${target}`)
      }
    }
  }

  return { asset: { ...asset, graphs }, loaded, errors }
}

/** 供编辑器/测试：列出未解析的外部调用（不含加载） */
export function listExternalCalls(asset: IRAsset): Array<{ graph: string; node: string; target: string; scope: FunctionScope }> {
  const out: Array<{ graph: string; node: string; target: string; scope: FunctionScope }> = []
  for (const [graphName, graph] of Object.entries(asset.graphs ?? {})) {
    for (const node of graph.nodes ?? []) {
      if (node.type !== 'flow.call') continue
      const target = callTarget(node)
      if (!target) continue
      if (asset.graphs[target]) continue
      out.push({ graph: graphName, node: node.id, target, scope: callScope(node) })
    }
  }
  return out
}
