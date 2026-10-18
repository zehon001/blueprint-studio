/**
 * 元素资产加载/实例展开（v3 T11.2/T11.3 · PLAN §3.2/§7.2）
 *
 * UINode.element 指向 .elem.json（项目相对）或 @library/elements/<name>（资源库）。
 * 实例 = 引用 + 覆盖：结构/type/container 取元素根，id/name/layout/transform 保留实例，
 * props = 元素根 ∪ 自定义属性默认值 ∪ 实例覆盖；vars 暂只随实例保存（运行时 M11+）。
 * 与 ADR-009 预制体机制同构：预取缓存、循环检测、缺失占位、补拉刷新。
 */
import type { ElementAsset, UINode } from '@/ir/types'

export const ELEMENT_PLACEHOLDER_TYPE = '__element_placeholder'
export const ELEMENT_PLACEHOLDER_TEXT = '__element_placeholder_text'
export const ELEMENT_MAX_DEPTH = 8

export interface ElementLoaderContext {
  projectPath: string
  fetchImpl?: typeof fetch
}

let loaderContext: ElementLoaderContext | null = null
const cache = new Map<string, ElementAsset>()
const pending = new Map<string, Promise<ElementAsset | null>>()

export function setElementLoaderContext(ctx: ElementLoaderContext | null): void {
  loaderContext = ctx
}

export function clearElementCache(): void {
  cache.clear()
  pending.clear()
}

export function getCachedElement(path: string): ElementAsset | undefined {
  return cache.get(path)
}

/** 元素引用 → 读取地址（项目内相对 / @library 暂不支持读取，返回 null） */
function elementUrl(path: string): string | null {
  if (path.startsWith('@library/')) return null
  const ctx = loaderContext
  if (!ctx) return null
  return `/api/file?path=${encodeURIComponent(`${ctx.projectPath}/${path}`)}`
}

/** 解析元素 JSON（宽松：kind 必须 element；root 必须对象） */
export function parseElementAsset(text: string, path: string): ElementAsset {
  const raw = JSON.parse(text) as Partial<ElementAsset>
  if (!raw || typeof raw !== 'object') throw new Error(`元素资产格式错误：${path} 根节点不是对象`)
  if (raw.kind !== 'element') throw new Error(`元素资产 kind 无效：${path}`)
  if (!raw.root || typeof raw.root !== 'object') throw new Error(`元素资产缺少 root：${path}`)
  return raw as ElementAsset
}

/** 拉取一个元素（缓存 + 并发去重；失败返回 null 并缓存占位） */
export async function loadElement(path: string, fetchImpl?: typeof fetch): Promise<ElementAsset | null> {
  const hit = cache.get(path)
  if (hit) return hit
  const running = pending.get(path)
  if (running) return running
  const url = elementUrl(path)
  if (!url) return null
  const task = (async (): Promise<ElementAsset | null> => {
    try {
      const f = fetchImpl ?? loaderContext?.fetchImpl ?? fetch
      const r = await f(url)
      const json = (await r.json()) as { ok?: boolean; content?: string }
      if (!json.ok) return null
      const asset = parseElementAsset(String(json.content ?? ''), path)
      cache.set(path, asset)
      return asset
    } catch {
      return null
    } finally {
      pending.delete(path)
    }
  })()
  pending.set(path, task)
  return task
}

/** 预取树内全部元素（含嵌套元素内部） */
export async function prefetchElements(root: UINode, fetchImpl?: typeof fetch): Promise<void> {
  const walk = async (node: UINode, depth: number): Promise<void> => {
    if (depth > ELEMENT_MAX_DEPTH) return
    if (node.element) {
      const asset = await loadElement(node.element, fetchImpl)
      if (asset) {
        await walk(asset.root, depth + 1)
      }
    }
    for (const c of node.children ?? []) await walk(c, depth)
  }
  await walk(root, 0)
}

/** 循环 / 深度检测（展开前调用；返回中文错误或 null） */
export function findElementCycle(root: UINode, resolver: (path: string) => ElementAsset | undefined): string | null {
  const walk = (node: UINode, chain: string[]): string | null => {
    if (!node.element) {
      for (const c of node.children ?? []) {
        const err = walk(c, chain)
        if (err) return err
      }
      return null
    }
    const path = node.element
    if (chain.includes(path)) return `元素循环引用：${[...chain, path].join(' → ')}`
    if (chain.length >= ELEMENT_MAX_DEPTH) return `元素嵌套超过最大深度（${ELEMENT_MAX_DEPTH}）：${[...chain, path].join(' → ')}`
    const asset = resolver(path)
    if (!asset) return null // 缺失由占位处理
    return walk(asset.root, [...chain, path])
  }
  return walk(root, [])
}

/** 构造缺失占位（保留实例 id/name/layout） */
export function elementPlaceholder(instance: UINode, text: string): UINode {
  return {
    id: instance.id,
    name: instance.name,
    type: 'panel',
    ...(instance.layout ? { layout: instance.layout } : {}),
    ...(instance.classes ? { classes: instance.classes } : {}),
    transform: instance.transform,
    theme: {},
    props: { [ELEMENT_PLACEHOLDER_TEXT]: text },
    children: [],
  }
}

/** 展开元素实例（结构取元素根；props 三层合并；子树递归展开） */
export function expandElementNode(
  instance: UINode,
  resolver: (path: string) => ElementAsset | undefined,
  chain: string[] = [],
): { node: UINode; error: string | null } {
  const path = instance.element
  if (!path) return { node: instance, error: null }
  if (chain.includes(path)) {
    const msg = `元素循环引用：${[...chain, path].join(' → ')}`
    return { node: elementPlaceholder(instance, msg), error: msg }
  }
  if (chain.length >= ELEMENT_MAX_DEPTH) {
    const msg = `元素嵌套超过最大深度（${ELEMENT_MAX_DEPTH}）：${[...chain, path].join(' → ')}`
    return { node: elementPlaceholder(instance, msg), error: msg }
  }
  const asset = resolver(path)
  if (!asset) {
    return { node: elementPlaceholder(instance, `元素未加载：${path}`), error: null }
  }
  const root = asset.root
  // 元素根自身又是元素实例 → 视为嵌套链；形成环时占位报错
  if (root.element && (root.element === path || chain.includes(root.element))) {
    const msg = `元素循环引用：${[...chain, path, root.element].join(' → ')}`
    return { node: elementPlaceholder(instance, msg), error: msg }
  }
  const defaults: Record<string, unknown> = {}
  for (const p of asset.props ?? []) {
    if (p?.id) defaults[p.id] = p.default
  }
  const node: UINode = {
    id: instance.id,
    name: instance.name,
    type: root.type,
    transform: instance.transform,
    ...(instance.layout ?? root.layout ? { layout: instance.layout ?? root.layout } : {}),
    ...(root.container ? { container: root.container } : {}),
    ...(instance.classes ?? root.classes ? { classes: instance.classes ?? root.classes } : {}),
    theme: { ...root.theme },
    props: { ...root.props, ...defaults, ...instance.props },
    events: instance.events ?? [],
    prefab: undefined,
    children: [],
  }
  let error: string | null = null
  node.children = (root.children ?? []).map((c) => {
    const r = expandElementNode(c, resolver, [...chain, path])
    if (r.error && !error) error = r.error
    return r.node
  })
  return { node, error }
}
