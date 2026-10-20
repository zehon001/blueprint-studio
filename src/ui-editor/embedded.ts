/**
 * UI 资产内嵌蓝图适配（v3 T10.1/T10.2/T10.3）
 *
 * UIAsset.graphs/variables/events 是 v3 的唯一 UI 逻辑挂载方式（logicAsset 退役）。
 * 蓝图编辑器仍以 IRAsset 为输入：本模块做 UIAsset ⇄ IRAsset 的视图转换。
 * - 事件图：key 'event' 或 kind:'event'（entry）
 * - 函数图：其余图（params/returns）
 * - 视图状态：asset.layout（键 = 图名）
 */
import type { IRAsset, IRGraph, UIAsset } from '@/ir/types'

/** 空事件图（含 event.start 入口，便于新建资产直接连线） */
export function emptyEmbeddedGraph(): IRGraph {
  return {
    nodes: [
      {
        id: 'n_start',
        type: 'event.start',
        params: {},
        pinDefaults: {},
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    comments: [],
  }
}

/** 建立空的 UI 内嵌蓝图（IRAsset 视图） */
export function emptyEmbeddedBlueprint(name: string): IRAsset {
  return {
    version: 3,
    name,
    entry: 'event',
    graphs: { event: emptyEmbeddedGraph() },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  }
}

/** 资产是否有内嵌图（v3 或已迁移） */
export function hasEmbeddedBlueprint(asset: UIAsset): boolean {
  return !!asset.graphs && Object.keys(asset.graphs).length > 0
}

/**
 * UIAsset → IRAsset 视图（蓝图编辑器/运行期解释器共用）。
 * 无 graphs 时返回带空事件图的视图（不修改原资产）。
 */
export function embeddedBlueprintOf(asset: UIAsset): IRAsset {
  const graphs = asset.graphs ?? {}
  const keys = Object.keys(graphs)
  const eventKey =
    keys.find((k) => graphs[k]?.kind === 'event') ?? (keys.includes('event') ? 'event' : keys[0]) ?? 'event'
  const cleaned: Record<string, IRGraph> = {}
  for (const [key, g] of Object.entries(graphs)) {
    cleaned[key] = {
      nodes: g.nodes ?? [],
      edges: g.edges ?? [],
      ...(g.params ? { params: g.params } : {}),
      ...(g.returns ? { returns: g.returns } : {}),
      ...(g.comments ? { comments: g.comments } : {}),
    }
  }
  // 空事件图（老资产 / 早期模板）在视图层补 event.start：打开蓝图即可连线，
  // 保存时由 applyEmbeddedBlueprint 落盘；不修改传入资产。
  const eventGraph = cleaned[eventKey]
  if (!eventGraph) cleaned[eventKey] = emptyEmbeddedGraph()
  else if ((eventGraph.nodes ?? []).length === 0) {
    cleaned[eventKey] = { ...eventGraph, nodes: emptyEmbeddedGraph().nodes }
  }
  return {
    version: 3,
    name: asset.name,
    entry: eventKey,
    graphs: cleaned,
    variables: asset.variables ?? [],
    events: asset.events ?? [],
    snippets: [],
    layout: asset.layout ?? {},
  }
}

/** IRAsset 视图 → 写回 UIAsset（保存蓝图时调用；资产升 version=3） */
export function applyEmbeddedBlueprint(asset: UIAsset, ir: IRAsset): void {
  const graphs: Record<string, IRGraph & { kind: 'event' | 'function' }> = {}
  for (const [key, g] of Object.entries(ir.graphs)) {
    const isEvent = key === ir.entry
    graphs[key] = {
      nodes: g.nodes,
      edges: g.edges,
      ...(isEvent ? {} : { params: g.params ?? [], returns: g.returns ?? [] }),
      ...(g.comments ? { comments: g.comments } : {}),
      kind: isEvent ? 'event' : 'function',
    }
  }
  asset.graphs = graphs
  asset.variables = ir.variables.map((v) => ({ ...v }))
  asset.events = ir.events.map((e) => ({ ...e }))
  asset.layout = { ...ir.layout }
  asset.version = 3
  if (!asset.kind) asset.kind = 'scene'
}

/** 运行期：UI 资产内嵌蓝图（无图时返回 null，保持 v2 logicAsset 路径） */
export function runtimeEmbeddedBlueprint(asset: UIAsset): IRAsset | null {
  return hasEmbeddedBlueprint(asset) ? embeddedBlueprintOf(asset) : null
}

/** 图属主最小形状（UIAsset / ElementAsset 共用） */
export interface GraphOwnerLike {
  name: string
  graphs?: Record<string, IRGraph & { kind?: 'event' | 'function' }>
  variables?: IRAsset['variables']
  events?: IRAsset['events']
  layout?: IRAsset['layout']
}

/**
 * 任意图属主（UI 资产 / 元素 / 预制体）→ IRAsset 视图。
 * 无 graphs 返回 null（无图零成本）。
 */
export function graphOwnerBlueprint(owner: GraphOwnerLike): IRAsset | null {
  if (!owner.graphs || Object.keys(owner.graphs).length === 0) return null
  return embeddedBlueprintOf({
    version: 3,
    name: owner.name,
    graphs: owner.graphs,
    variables: owner.variables ?? [],
    events: owner.events ?? [],
    layout: owner.layout ?? {},
  } as UIAsset)
}
