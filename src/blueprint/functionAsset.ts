/**
 * 函数资产 ⇄ IRAsset 视图转换（v3 T12.2，纯函数；node:test 可加载）
 */
import type { IRAsset, IRGraph, IRNode } from '@/ir/types'

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

/** 函数图骨架（与蓝图 store addFunction 一致）：函数入口 + 函数出口节点 */
export function functionSkeletonNodes(): IRNode[] {
  return [
    { id: 'entry_1', type: 'func.entry', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
    { id: 'return_1', type: 'func.return', params: {}, pinDefaults: {}, position: { x: 280, y: 0 } },
  ]
}

/** .fn.json → IRAsset 视图 */
export function functionIR(asset: FnAsset, fallbackName: string): IRAsset {
  if (asset.version !== 3) {
    throw new Error(`函数资产版本不识别：${String(asset.version)}（v3 仅支持 version 3）`)
  }
  const graph = asset.graph ?? { nodes: [], edges: [] }
  // 旧空图兜底：无任何节点时补函数入口/出口骨架（与蓝图内新建函数一致，保存时随资产写回）
  const nodes =
    (graph.nodes ?? []).length > 0
      ? graph.nodes!
      : functionSkeletonNodes()
  const main: IRGraph = {
    kind: 'function',
    nodes,
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
