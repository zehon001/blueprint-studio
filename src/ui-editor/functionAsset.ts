/**
 * 函数资产 ⇄ IRAsset 视图转换（v3 T12.2，纯函数；node:test 可加载）
 */
import type { IRAsset, IRGraph } from '@/ir/types'

export interface FnAsset {
  version?: number
  kind?: string
  scope?: 'global' | 'project'
  name?: string
  params?: IRGraph['params']
  returns?: IRGraph['returns']
  graph?: IRGraph
}

export function isLibraryFunctionPath(path: string): boolean {
  return path.startsWith('@library/functions/')
}

export function fnNameOf(path: string): string {
  if (isLibraryFunctionPath(path)) return path.slice('@library/functions/'.length)
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.fn\.json$/i, '')
}

/** .fn.json → IRAsset 视图 */
export function functionIR(asset: FnAsset, fallbackName: string): IRAsset {
  if (asset.version !== 3) {
    throw new Error(`函数资产版本不识别：${String(asset.version)}（v3 仅支持 version 3）`)
  }
  const graph = asset.graph ?? { nodes: [], edges: [] }
  const main: IRGraph = {
    kind: 'function',
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
    params: asset.params ?? graph.params ?? [],
    returns: asset.returns ?? graph.returns ?? [],
    ...(graph.comments ? { comments: graph.comments } : {}),
  }
  return {
    version: 2,
    name: asset.name ?? fallbackName,
    entry: 'main',
    graphs: { main },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

/** IRAsset 视图 → .fn.json 文本 */
export function functionTextOf(ir: IRAsset, path: string, scope: 'global' | 'project'): string {
  const g = ir.graphs.main ?? { nodes: [], edges: [] }
  return JSON.stringify(
    {
      version: 3,
      kind: 'function',
      scope,
      name: ir.name || fnNameOf(path),
      params: g.params ?? [],
      returns: g.returns ?? [],
      graph: { nodes: g.nodes ?? [], edges: g.edges ?? [], ...(g.comments ? { comments: g.comments } : {}) },
    },
    null,
    2,
  )
}
