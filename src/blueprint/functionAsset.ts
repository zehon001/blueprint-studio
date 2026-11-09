/**
 * 函数资产 ⇄ IRAsset 视图转换（v3 T12.2，纯函数；node:test 可加载）
 *
 * .fn.json 的主图保存在 graph；函数内部局部函数保存在可选 graphs（键 = 函数名）。
 * 旧文件只有 graph，读取时按单图资产兼容；保存时仅在存在局部函数时写出 graphs。
 */
import type { IRAsset, IRGraph, IRNode } from '@/ir/types'

export interface FnAsset {
  version?: number
  kind?: string
  scope?: 'global' | 'project'
  name?: string
  /** 主图键（缺省 main；兼容未来自定义入口） */
  entry?: string
  params?: IRGraph['params']
  returns?: IRGraph['returns']
  /** 主图（.fn.json 的既有字段） */
  graph?: IRGraph
  /** 函数资产内部局部函数图（键 = 局部函数名；主图不重复放这里） */
  graphs?: Record<string, IRGraph>
}

export function isLibraryFunctionPath(path: string): boolean {
  return path.startsWith('@library/functions/')
}

export function fnNameOf(path: string): string {
  if (isLibraryFunctionPath(path)) return path.slice('@library/functions/'.length)
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.fn\.json$/i, '')
}

/** 函数图骨架（与蓝图 store addFunction 一致）：函数入口 + 函数出口节点 */
export function functionSkeletonNodes(): IRNode[] {
  return [
    { id: 'entry_1', type: 'func.entry', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
    { id: 'return_1', type: 'func.return', params: {}, pinDefaults: {}, position: { x: 280, y: 0 } },
  ]
}

/** 函数图规范化：空图补入口 / 出口骨架，保留签名与注释 */
function normalizeFunctionGraph(graph: IRGraph | undefined): IRGraph {
  const g = graph ?? { nodes: [], edges: [] }
  return {
    kind: 'function',
    nodes: (g.nodes ?? []).length > 0 ? g.nodes : functionSkeletonNodes(),
    edges: g.edges ?? [],
    params: g.params ?? [],
    returns: g.returns ?? [],
    ...(g.comments ? { comments: g.comments } : {}),
  }
}

/** .fn.json → IRAsset 视图 */
export function functionIR(asset: FnAsset, fallbackName: string): IRAsset {
  if (asset.version !== 3) {
    throw new Error(`函数资产版本不识别：${String(asset.version)}（v3 仅支持 version 3）`)
  }
  const entry = typeof asset.entry === 'string' && asset.entry ? asset.entry : 'main'
  const graphs: Record<string, IRGraph> = {}
  for (const [name, graph] of Object.entries(asset.graphs ?? {})) {
    if (name === entry) continue
    graphs[name] = normalizeFunctionGraph(graph)
  }
  const rawMain = asset.graph ?? asset.graphs?.[entry]
  const main = normalizeFunctionGraph(rawMain)
  main.params = asset.params ?? main.params ?? []
  main.returns = asset.returns ?? main.returns ?? []
  graphs[entry] = main
  return {
    version: 2,
    name: asset.name ?? fallbackName,
    entry,
    graphs,
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

/** IRAsset 视图 → .fn.json 文本 */
export function functionTextOf(ir: IRAsset, path: string, scope: 'global' | 'project'): string {
  const entry = ir.entry in ir.graphs ? ir.entry : Object.keys(ir.graphs)[0] ?? 'main'
  const g = ir.graphs[entry] ?? { nodes: [], edges: [] }
  const localGraphs: Record<string, IRGraph> = {}
  for (const [name, graph] of Object.entries(ir.graphs)) {
    if (name === entry) continue
    localGraphs[name] = {
      kind: 'function',
      nodes: graph.nodes ?? [],
      edges: graph.edges ?? [],
      params: graph.params ?? [],
      returns: graph.returns ?? [],
      ...(graph.comments ? { comments: graph.comments } : {}),
    }
  }
  return JSON.stringify(
    {
      version: 3,
      kind: 'function',
      scope,
      name: ir.name || fnNameOf(path),
      ...(entry !== 'main' ? { entry } : {}),
      params: g.params ?? [],
      returns: g.returns ?? [],
      graph: { nodes: g.nodes ?? [], edges: g.edges ?? [], ...(g.comments ? { comments: g.comments } : {}) },
      ...(Object.keys(localGraphs).length > 0 ? { graphs: localGraphs } : {}),
    },
    null,
    2,
  )
}
