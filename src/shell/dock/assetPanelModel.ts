/**
 * 资产面板模型（v3 T8.1 · 纯逻辑，无 UI 依赖）
 *
 * 与 assetPanel.tsx 的分工：
 * - 本文件：id 语法 / 显示名 / 徽标 / 布局扫描 / workspace 同步 / 关闭请求 / 打开入口；
 * - assetPanel.tsx：注册 React 组件（会 import 各编辑器，node:test 不应被动拉入）。
 *
 * 打开入口经 setAssetPanelOpener 注入：UI 侧加载 assetPanel.tsx 时注册真实实现；
 * 纯逻辑调用方（如 prefabTab）只依赖本文件，node:test 不会加载 @xyflow/react 样式。
 */
import { getPanel } from './registry'
import { useDockStore } from './store'
import { useWorkspaceStore, tabIdOf, type OpenTabKind } from '@/shell/workspace-store'

export const ASSET_PANEL_PREFIX = 'asset:'

/** 可由 dock 面板承载的资产类型（元素/样式/函数随 M11/M12 接入） */
export type AssetPanelKind = 'ui' | 'blueprint' | 'script' | 'element' | 'style' | 'function'

export interface AssetPanelRef {
  kind: AssetPanelKind
  path: string
}

const ASSET_KINDS: readonly AssetPanelKind[] = ['ui', 'blueprint', 'script', 'element', 'style', 'function']

/** 构造资产面板 id */
export function assetPanelId(kind: AssetPanelKind, path: string): string {
  return `${ASSET_PANEL_PREFIX}${kind}:${path}`
}

/** 解析资产面板 id；非资产面板 / 非法返回 null */
export function parseAssetPanelId(panelId: string): AssetPanelRef | null {
  if (!panelId.startsWith(ASSET_PANEL_PREFIX)) return null
  const rest = panelId.slice(ASSET_PANEL_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const kind = rest.slice(0, sep) as AssetPanelKind
  const path = rest.slice(sep + 1)
  if (!ASSET_KINDS.includes(kind) || path === '') return null
  return { kind, path }
}

/** 路径末段（兼容 / 与 \） */
function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** 资产主名（去双扩展名；脚本保留完整文件名，PLAN §3.7） */
export function assetDisplayName(kind: AssetPanelKind, path: string): string {
  const name = basename(path)
  if (kind === 'ui') return name.replace(/\.ui\.json$/i, '')
  if (kind === 'blueprint') return name.replace(/\.bp\.json$/i, '')
  if (kind === 'element') return name.replace(/\.elem\.json$/i, '')
  if (kind === 'style') return name.replace(/\.uss\.json$/i, '')
  if (kind === 'function') return name.replace(/\.fn\.json$/i, '')
  return name
}

/** 面板标题（主名；脚本为完整文件名） */
export function assetPanelTitle(kind: AssetPanelKind, path: string): string {
  return assetDisplayName(kind, path)
}

/** 类型徽标（dock tab / 文件面板共用口径；PLAN §3.7） */
export function assetBadge(kind: AssetPanelKind, path = ''): string {
  switch (kind) {
    case 'ui':
      return 'UI'
    case 'blueprint':
      return 'BP'
    case 'script':
      return path.toLowerCase().endsWith('.py') ? 'PY' : 'TS'
    case 'element':
      return 'EL'
    case 'style':
      return 'ST'
    case 'function':
      return 'FN'
    default:
      return '?'
  }
}

/* ---------------- 打开入口（UI 侧注入） ---------------- */

export type AssetPanelOpener = (kind: AssetPanelKind, path: string) => string

let opener: AssetPanelOpener | null = null

/** 由 assetPanel.tsx 在模块加载时注入真实打开实现（注册面板 + openPanel） */
export function setAssetPanelOpener(fn: AssetPanelOpener): void {
  opener = fn
}

/**
 * 打开资产（纯逻辑入口）。
 * UI 已加载时走注入实现；否则降级为「workspace 注册 + dock openPanel」
 * （DockShell 会在布局同步时补注册资产面板）。
 */
export function openAssetPanel(kind: AssetPanelKind, path: string): string {
  if (opener) return opener(kind, path)
  const id = assetPanelId(kind, path)
  useWorkspaceStore.getState().openAsset({
    kind: kind as OpenTabKind,
    assetPath: path,
    title: assetPanelTitle(kind, path),
  })
  useDockStore.getState().openPanel(id, 'center')
  return id
}

/* ---------------- 布局扫描 / workspace 同步 ---------------- */

/** 收集布局树中全部面板 id（原始 JSON 也适用） */
export function collectPanelIdsRaw(raw: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const n = node as { kind?: unknown; panels?: unknown; children?: unknown }
    if (n.kind === 'tabs' && Array.isArray(n.panels)) {
      for (const p of n.panels) if (typeof p === 'string') out.push(p)
    } else if (n.kind === 'split' && Array.isArray(n.children)) {
      for (const c of n.children) walk(c)
    }
  }
  walk(raw)
  return out
}

/** 布局中出现的全部资产面板（文档序、去重） */
export function collectAssetPanels(root: unknown): AssetPanelRef[] {
  const seen = new Set<string>()
  const out: AssetPanelRef[] = []
  for (const id of collectPanelIdsRaw(root)) {
    const ref = parseAssetPanelId(id)
    if (!ref || seen.has(id)) continue
    seen.add(id)
    out.push(ref)
  }
  return out
}

/**
 * 从 dock 布局同步资产注册表（openTabs / activeTabId）。
 * 布局是打开资产的唯一真源；静态面板聚焦时保留最近一次资产 tab（F6 仍有目标）。
 */
export function syncWorkspaceFromDock(): void {
  const { root, activePanelId } = useDockStore.getState()
  const panels = collectAssetPanels(root)
  const wanted = new Map<string, AssetPanelRef>()
  for (const ref of panels) wanted.set(tabIdOf(ref.kind as OpenTabKind, ref.path), ref)

  const ws = useWorkspaceStore.getState()
  const nextTabs = ws.openTabs.filter((t) => wanted.has(t.id))
  const existing = new Set(nextTabs.map((t) => t.id))
  for (const [id, ref] of wanted) {
    if (existing.has(id)) continue
    nextTabs.push({
      id,
      kind: ref.kind as OpenTabKind,
      assetPath: ref.path,
      title: assetPanelTitle(ref.kind, ref.path),
    })
  }

  const activeRef = activePanelId ? parseAssetPanelId(activePanelId) : null
  const nextActive = activeRef
    ? tabIdOf(activeRef.kind as OpenTabKind, activeRef.path)
    : nextTabs.some((t) => t.id === ws.activeTabId)
      ? ws.activeTabId
      : (nextTabs[nextTabs.length - 1]?.id ?? null)

  const sameTabs =
    nextTabs.length === ws.openTabs.length &&
    nextTabs.every((t, i) => {
      const old = ws.openTabs[i]
      return old && old.id === t.id && old.title === t.title && old.dirty === t.dirty
    })
  if (sameTabs && nextActive === ws.activeTabId) return

  useWorkspaceStore.setState({ openTabs: nextTabs, activeTabId: nextActive })
}

/* ---------------- 关闭（脏确认） ---------------- */

/** 面板 id → 注册表 tab id（非资产面板返回 ''） */
function tabIdOfPanel(panelId: string): string {
  const ref = parseAssetPanelId(panelId)
  return ref ? tabIdOf(ref.kind as OpenTabKind, ref.path) : ''
}

/** 关闭资产面板前的脏确认（无确认环境视为同意，测试友好） */
export function confirmCloseIfDirty(panelId: string): boolean {
  const tab = useWorkspaceStore.getState().openTabs.find((t) => t.id === tabIdOfPanel(panelId))
  if (!tab?.dirty) return true
  // 显式取 globalThis.window：node:test 注入桩时也能生效（ESM 自由变量不保证绑定全局属性）
  const win = (globalThis as { window?: { confirm?: (message: string) => boolean } }).window
  if (!win || typeof win.confirm !== 'function') return true
  return win.confirm(`「${tab.title}」有未保存的修改，关闭将丢失这些修改，继续？`)
}

/** 请求关闭一个面板（资产面板带脏确认）；返回是否已关闭 */
export function requestClosePanel(panelId: string): boolean {
  if (!confirmCloseIfDirty(panelId)) return false
  useDockStore.getState().closePanel(panelId)
  return true
}

/** 批量请求关闭（关闭其他/右侧）；任一脏确认取消则中止本批 */
export function requestClosePanels(panelIds: readonly string[]): boolean {
  for (const id of panelIds) {
    if (!confirmCloseIfDirty(id)) return false
  }
  for (const id of panelIds) useDockStore.getState().closePanel(id)
  return true
}

/** 面板是否已经注册（避免重复注册告警） */
export function isAssetPanelRegistered(panelId: string): boolean {
  return getPanel(panelId) !== undefined || registeredIds.has(panelId)
}

/** 供 assetPanel.tsx 共享的注册集合（避免重复 registerPanel） */
export const registeredIds = new Set<string>()
