/**
 * 改键持久化（T7.1 · 快捷键设置界面）
 *
 * 键：bps.keymap.v1 —— 与 dock 布局持久化（bps.dockLayout.v2）同前缀约定。
 * 文件格式：{ version: 1, overrides: Record<快捷键id, 组合键串> }；只存「改过的」
 * id（稀疏覆盖），未记录的 id 用注册表默认键位。读取时逐条归一化校验
 * （normalizeKeys），非法条目剔除——默认表演进 / 手改存储都不致崩。
 */
import { normalizeKeys } from './registry'

export const KEYMAP_STORAGE_KEY = 'bps.keymap.v1'

/** 持久化文件格式 */
export interface KeymapFile {
  version: 1
  overrides: Record<string, string>
}

/** 序列化改键覆盖（纯函数，便于测试） */
export function serializeKeymapOverrides(overrides: Record<string, string>): string {
  const file: KeymapFile = { version: 1, overrides }
  return JSON.stringify(file)
}

/**
 * 反序列化改键覆盖：JSON 非法 / 版本不符 / overrides 非对象 → {}；
 * 单条非法（id 空、值非字符串、组合键归一化失败）剔除，其余照常生效。
 */
export function deserializeKeymapOverrides(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const file = parsed as Partial<KeymapFile>
    if (file.version !== 1 || typeof file.overrides !== 'object' || file.overrides === null) return {}
    const out: Record<string, string> = {}
    for (const [id, keys] of Object.entries(file.overrides)) {
      if (id.length === 0 || typeof keys !== 'string') continue
      try {
        out[id] = normalizeKeys(keys)
      } catch {
        /* 非法组合键：剔除该条 */
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 读取持久化改键；无存储环境 / 无记录 / 解析失败返回 {} */
export function loadKeymapOverrides(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEYMAP_STORAGE_KEY)
    if (!raw) return {}
    return deserializeKeymapOverrides(raw)
  } catch {
    return {}
  }
}

/** 写入持久化改键（配额满 / 隐私模式等写入失败静默忽略，不影响运行） */
export function saveKeymapOverrides(overrides: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEYMAP_STORAGE_KEY, serializeKeymapOverrides(overrides))
  } catch {
    /* 存储不可用时忽略：仅丢失「刷新还原」能力 */
  }
}

/** 清除持久化改键（设置面板「恢复默认」时调用，避免下次启动又还原旧改键） */
export function clearKeymapOverrides(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(KEYMAP_STORAGE_KEY)
  } catch {
    /* 同上 */
  }
}
