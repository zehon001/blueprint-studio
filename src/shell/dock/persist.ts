/**
 * 布局持久化（v3 T8.1）
 *
 * 键：bps.dockLayout.v3 —— 项目无关前缀（布局每窗独立，PLAN §3.1）。
 * 文件格式：{ version: 3, root: DockNode | null, activePanelId: string | null }；
 * v2 键（bps.dockLayout.v2）**不迁移**（v3 干净断裂：workspace 虚拟面板已移除），
 * 读取统一经 normalizeDockNode 容错（未知面板剔除 / 空组剪枝 / sizes 修正）。
 *
 * 资产面板（id `asset:<kind>:<path>`）是动态面板：调用方在 normalize 前把布局中
 * 出现的 asset id 加入 knownIds（见 defaultPanels.bootstrapDock），持久化还原即无须
 * 静态注册表预知全部资产。
 */
import { normalizeDockNode, type DockNode } from './tree'

export const DOCK_LAYOUT_STORAGE_KEY = 'bps.dockLayout.v3'
/** v2 布局键（只用于清理说明；v3 不读取） */
export const DOCK_LAYOUT_STORAGE_KEY_V2 = 'bps.dockLayout.v2'

/** 持久化文件格式 */
export interface DockLayoutFile {
  version: 3
  root: DockNode | null
  /** 当前聚焦面板（可缺省；v3 新增） */
  activePanelId: string | null
}

/** 解析后的布局（含激活面板） */
export interface LoadedDockLayout {
  root: DockNode | null
  activePanelId: string | null
}

/** 序列化布局树（纯函数，便于测试） */
export function serializeLayout(root: DockNode | null, activePanelId: string | null = null): string {
  const file: DockLayoutFile = { version: 3, root, activePanelId }
  return JSON.stringify(file)
}

/**
 * 反序列化布局文件；JSON 非法 / 版本不符 / 结构非法返回 null。
 * knownIds 为 undefined 时不校验面板存在性（信任数据）；资产面板需由调用方先并入。
 */
export function parseLayout(json: string, knownIds?: ReadonlySet<string>): LoadedDockLayout | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return null
    const file = parsed as Partial<DockLayoutFile>
    if (file.version !== 3) return null
    const root = normalizeDockNode(file.root, knownIds)
    const activePanelId =
      typeof file.activePanelId === 'string' && file.activePanelId !== '' ? file.activePanelId : null
    return { root, activePanelId }
  } catch {
    return null
  }
}

/** 兼容旧调用：只取布局树（激活面板丢弃） */
export function deserializeLayout(json: string, knownIds?: ReadonlySet<string>): DockNode | null {
  return parseLayout(json, knownIds)?.root ?? null
}

/** 读取原始布局 JSON（bootstrap 需先扫描动态资产面板 id；无记录返回 null） */
export function readLayoutRaw(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    return localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
  } catch {
    return null
  }
}

/** 读取持久化布局（含激活面板）；无存储环境 / 无记录 / 解析失败返回 null */
export function loadPersistedLayoutFile(knownIds?: ReadonlySet<string>): LoadedDockLayout | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    return parseLayout(raw, knownIds)
  } catch {
    return null
  }
}

/** 兼容旧调用：只取布局树 */
export function loadPersistedLayout(knownIds?: ReadonlySet<string>): DockNode | null {
  return loadPersistedLayoutFile(knownIds)?.root ?? null
}

/** 写入持久化布局（配额满 / 隐私模式等写入失败静默忽略，不影响运行） */
export function saveLayout(root: DockNode | null, activePanelId: string | null = null): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, serializeLayout(root, activePanelId))
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
