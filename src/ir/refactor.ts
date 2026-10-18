/**
 * v3 引用改名级联（T13.1）
 *
 * 纯函数：传入资产 + 旧名/新名，返回克隆后的资产（不修改入参），覆盖
 * 变量 / 函数图 / 元素路径 / 样式类 / 事件名 五类引用。UI 层改名动作
 * 可复用这些函数；库文件本身的重命名仍由文件/库服务负责。
 */
import type { IRAsset, UIAsset, UINode } from './types'

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

/** UI 树元素路径改名（项目内元素文件重命名后级联） */
export function renameElementPath(asset: UIAsset, from: string, to: string): UIAsset {
  if (!from || from === to) return asset
  const walk = (n: UINode): UINode => ({
    ...n,
    ...(n.element === from ? { element: to } : {}),
    children: (n.children ?? []).map(walk),
  })
  return { ...asset, root: walk(asset.root) }
}

/** UI 样式类改名：节点 classes（样式表类的键由调用方同步改） */
export function renameClass(asset: UIAsset, from: string, to: string): UIAsset {
  if (!from || from === to) return asset
  const walk = (n: UINode): UINode => ({
    ...n,
    ...(n.classes?.includes(from)
      ? { classes: n.classes.map((c) => (c === from ? to : c)) }
      : {}),
    children: (n.children ?? []).map(walk),
  })
  return { ...asset, root: walk(asset.root) }
}

/** UI 事件名改名：asset.events + UI 树节点 events + 内嵌图 event.custom/send 参数 */
export function renameEvent(asset: UIAsset, from: string, to: string): UIAsset {
  if (!from || from === to) return asset
  const walk = (n: UINode): UINode => ({
    ...n,
    ...(n.events?.includes(from) ? { events: n.events.map((e) => (e === from ? to : e)) } : {}),
    children: (n.children ?? []).map(walk),
  })
  const graphs = Object.fromEntries(
    Object.entries(asset.graphs ?? {}).map(([k, g]) => [
      k,
      {
        ...g,
        nodes: (g.nodes ?? []).map((n) => {
          const params = n.params ?? {}
          const hit = params.eventName === from || (n.type === 'event.custom' && params.eventName === from)
          return hit ? { ...n, params: { ...params, eventName: to } } : n
        }),
      },
    ]),
  )
  return {
    ...asset,
    events: (asset.events ?? []).map((e) => (e.name === from ? { ...e, name: to } : e)),
    graphs,
    root: walk(asset.root),
  }
}
