/**
 * v3 引用改名级联（T13.1）
 *
 * 纯函数：传入资产 + 旧名/新名，返回克隆后的资产（不修改入参），覆盖
 * 变量 / 函数图 / 事件名 三类引用。库文件本身的重命名仍由文件/库服务负责。
 */
import type { IRAsset } from './types'

function cloneGraphs(asset: IRAsset): IRAsset {
  const graphs = Object.fromEntries(
    Object.entries(asset.graphs).map(([k, g]) => [
      k,
      { ...g, nodes: (g.nodes ?? []).map((n) => ({ ...n, params: { ...(n.params ?? {}) } })) },
    ]),
  )
  return { ...asset, graphs }
}

function mapNodes(asset: IRAsset, fn: (node: { params: Record<string, unknown> }) => void): IRAsset {
  const next = cloneGraphs(asset)
  for (const g of Object.values(next.graphs)) for (const n of g.nodes ?? []) fn(n as { params: Record<string, unknown> })
  return next
}

/** 变量改名：asset.variables + 图内 var.get/set.params.varName + 事件参数名 */
export function renameVariable(asset: IRAsset, from: string, to: string): IRAsset {
  if (!from || from === to) return asset
  const next = mapNodes(asset, (n) => {
    if (n.params.varName === from) n.params.varName = to
  })
  next.variables = (next.variables ?? []).map((v) => (v.name === from ? { ...v, name: to } : v))
  next.events = (next.events ?? []).map((e) => ({
    ...e,
    params: (e.params ?? []).map((p) => (p.name === from ? { ...p, name: to } : p)),
  }))
  return next
}

/** 函数图改名：graphs 键 + entry/layout + flow.call.params.graph */
export function renameFunction(asset: IRAsset, from: string, to: string): IRAsset {
  if (!from || from === to || !asset.graphs[from]) return asset
  const graphs = { ...asset.graphs, [to]: asset.graphs[from] }
  delete graphs[from]
  const next: IRAsset = {
    ...asset,
    graphs,
    entry: asset.entry === from ? to : asset.entry,
    layout: asset.layout?.[from] ? { ...asset.layout, [to]: asset.layout[from] } : asset.layout,
  }
  if (next.layout) delete next.layout[from]
  return mapNodes(next, (n) => {
    if (n.params.graph === from) n.params.graph = to
  })
}

