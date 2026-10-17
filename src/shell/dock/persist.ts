/**
 * 布局持久化（T0.3）
 *
 * 键：bps.dockLayout.v2 —— 项目无关前缀（布局每窗独立，PLAN §3.1；
 * 项目切换不还原/清空布局，后续多窗口卡 T0.4 沿用本键各自存储）。
 * 文件格式：{ version: 2, root: DockNode | null }；
 * 读取统一经 normalizeDockNode 容错（未知面板剔除 / 空组剪枝 / sizes 修正）。
 */
import { normalizeDockNode, type DockNode } from './tree'

export const DOCK_LAYOUT_STORAGE_KEY = 'bps.dockLayout.v2'

/** 持久化文件格式 */
export interface DockLayoutFile {
  version: 2
  root: DockNode | null
}

/** 序列化布局树（纯函数，便于测试） */
export function serializeLayout(root: DockNode | null): string {
  const file: DockLayoutFile = { version: 2, root }
  return JSON.stringify(file)
}

/** 反序列化布局树；JSON 非法 / 版本不符 / 结构非法返回 null */
export function deserializeLayout(json: string, knownIds?: ReadonlySet<string>): DockNode | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const file = parsed as Partial<DockLayoutFile>
    if (file.version !== 2) return null
    if (file.root === null) return null
    return normalizeDockNode(file.root, knownIds)
  } catch {
    return null
  }
}

/** 读取持久化布局；无存储环境 / 无记录 / 解析失败返回 null */
export function loadPersistedLayout(knownIds?: ReadonlySet<string>): DockNode | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    return deserializeLayout(raw, knownIds)
  } catch {
    return null
  }
}

/** 写入持久化布局（配额满 / 隐私模式等写入失败静默忽略，不影响运行） */
export function saveLayout(root: DockNode | null): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, serializeLayout(root))
  } catch {
    /* 存储不可用时忽略：仅丢失「刷新还原」能力 */
  }
}

/** 清除持久化布局（重置布局时同步清理，避免下次启动又还原旧布局） */
export function clearPersistedLayout(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(DOCK_LAYOUT_STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}
