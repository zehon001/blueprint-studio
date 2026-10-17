/**
 * 改键编排（T7.1 · 设置界面的业务逻辑层，node:test 可直接测）
 *
 * 职责（面板组件只做渲染与事件捕获，规则与编排全部收敛在此）：
 *  - applyKeymapOverrides：启动时把持久化的改键覆盖回放到注册表
 *    （main.tsx 调用；默认表演进后失效 / 冲突的条目跳过并告警，不阻塞启动）
 *  - rebindAndPersist：改键 + 持久化（冲突拒绝时不落盘）
 *  - restoreDefaultsAndPersist：清空持久化 + 注册表重建为默认表
 *    （resetShortcuts 会回放内置表与入口级默认项，run.* / settings.open 不丢）
 *  - isBindableCombo：捕获组合键的可绑定判定——全局派发的键会劫持同组合键的
 *    原生行为，故必须含 Ctrl/Alt 修饰，或为 F 功能键 / 非录入类导航键
 */
import { normalizeKeys, rebindShortcut, resetShortcuts, type RegisterResult } from './registry'
import { clearKeymapOverrides, loadKeymapOverrides, saveKeymapOverrides } from './persist'

/** 改键结果（透传 registry 的冲突报告：conflicts 为占用该组合键的快捷键 id） */
export type RebindResult = RegisterResult

/**
 * 可捕获性判定：设置界面「按下组合键即捕获」的护栏。
 * 放行：含 Ctrl 或 Alt 修饰的任意组合 / F1~F24 功能键 / 不产生字符的导航键
 * （Delete/Insert/Home/End/PageUp/PageDown）。
 * 拒绝：裸字母数字标点与 Shift 组合（会劫持文本录入）、Backspace（编辑必需）、
 * Escape（取消监听的保留键）、非法格式。组合键串须已归一化（Ctrl/Alt/Shift 序）。
 */
export function isBindableCombo(combo: string): boolean {
  let normalized: string
  try {
    normalized = normalizeKeys(combo)
  } catch {
    return false
  }
  const parts = normalized.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  if (mods.includes('Ctrl') || mods.includes('Alt')) return true
  if (/^F\d{1,2}$/.test(key)) return true
  return ['Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)
}

/** 启动应用改键覆盖的报告：applied 为生效 id；failed 为跳过项（附冲突占用者 / 失效原因） */
export interface ApplyReport {
  applied: string[]
  failed: Array<{ id: string; keys: string; conflicts: string[] }>
}

/** 应用持久化改键覆盖（启动时调用）：逐条 rebind；失败（默认表演进后冲突 / id 不存在）跳过 */
export function applyKeymapOverrides(overrides: Record<string, string>): ApplyReport {
  const applied: string[] = []
  const failed: ApplyReport['failed'] = []
  for (const [id, keys] of Object.entries(overrides)) {
    try {
      const r = rebindShortcut(id, keys)
      if (r.ok) {
        applied.push(id)
      } else {
        failed.push({ id, keys, conflicts: r.conflicts })
        console.warn(`[keymap] 改键覆盖跳过（冲突：${r.conflicts.join('、')}）：${id} → ${keys}`)
      }
    } catch {
      // 快捷键不存在（默认表演进后的残留条目）：跳过
      failed.push({ id, keys, conflicts: [] })
      console.warn(`[keymap] 改键覆盖跳过（快捷键不存在）：${id} → ${keys}`)
    }
  }
  return { applied, failed }
}

/**
 * 改键并持久化：注册表改键成功才落盘（冲突拒绝时不写存储）；
 * 存储值取归一化形（与 deserialize 的规范化一致）。
 */
export function rebindAndPersist(id: string, keys: string): RebindResult {
  const r = rebindShortcut(id, keys)
  if (!r.ok) return r
  const overrides = { ...loadKeymapOverrides(), [id]: normalizeKeys(keys) }
  saveKeymapOverrides(overrides)
  return r
}

/** 恢复默认表：清空持久化改键 + 注册表重建（内置表 + 入口级默认项回放） */
export function restoreDefaultsAndPersist(): void {
  clearKeymapOverrides()
  resetShortcuts()
}
