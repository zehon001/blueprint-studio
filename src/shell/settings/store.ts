/**
 * 编辑器设置（v3 T8.3 · PLAN §4.3）
 *
 * 持久化键：bps.settings.v1（与 keymap 的 bps.keymap.v1 分开，避免改键重置波及设置）。
 * 字段：
 *  - libraryRoot：内置资源库根；空串 = 服务端默认（%USERPROFILE%\.blueprint-studio\library\）。
 *    M8 只做前端格式校验；服务端安全根/越权校验由 T11.4 接管。
 *  - autoRerun：Ctrl+S 保存成功后自动重跑内置运行视图（默认开；T8.5 消费）。
 *
 * 本模块不依赖 React，可在 node:test 中用内存 localStorage 桩直接测。
 */
import { create } from 'zustand'

export const SETTINGS_STORAGE_KEY = 'bps.settings.v1'

/** 设置弹窗分区（T8.3） */
export type SettingsSection = 'general' | 'shortcuts' | 'plugins' | 'about'

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: '通用' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'plugins', label: '插件' },
  { id: 'about', label: '关于' },
]

const SECTION_STORAGE_KEY = 'bps.settings.section'

/** 上次分区持久化键（仅供 UI 习惯；不进设置文件） */
export function isSettingsSection(v: unknown): v is SettingsSection {
  return v === 'general' || v === 'shortcuts' || v === 'plugins' || v === 'about'
}

/** 上次分区（无 localStorage / 非法值 → general） */
export function loadLastSection(): SettingsSection {
  if (typeof localStorage === 'undefined') return 'general'
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY)
    return isSettingsSection(raw) ? raw : 'general'
  } catch {
    return 'general'
  }
}

export function saveLastSection(section: SettingsSection): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SECTION_STORAGE_KEY, section)
  } catch {
    /* 忽略 */
  }
}

export interface EditorSettings {
  /** 内置库根（空 = 服务端默认；绝对路径） */
  libraryRoot: string
  /** 保存成功后自动重跑运行视图 */
  autoRerun: boolean
}

export const DEFAULT_SETTINGS: EditorSettings = {
  libraryRoot: '',
  autoRerun: true,
}

/** 宽松读取：未知字段忽略、类型不符回落默认（旧版本/手改文件容错） */
export function parseSettings(raw: unknown): EditorSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const obj = raw as Record<string, unknown>
  return {
    libraryRoot: typeof obj.libraryRoot === 'string' ? obj.libraryRoot : DEFAULT_SETTINGS.libraryRoot,
    autoRerun: typeof obj.autoRerun === 'boolean' ? obj.autoRerun : DEFAULT_SETTINGS.autoRerun,
  }
}

/** 读取设置（无 localStorage / 无记录 / 坏 JSON → 默认值） */
export function loadSettings(): EditorSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return parseSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 写入设置（配额满等失败静默；仅丢失下一次启动的还原） */
export function saveSettings(settings: EditorSettings): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* 忽略：设置仍在本会话内存生效 */
  }
}

/**
 * 库根前端校验（M8 范围）：空 = 用默认；否则必须是绝对路径，且不能与当前项目根重叠。
 * 返回中文错误或 null（通过）。
 */
export function validateLibraryRoot(raw: string, projectPath?: string | null): string | null {
  const value = raw.trim()
  if (!value) return null
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/')
  if (!absolute) return '请输入绝对路径（如 C:\\Users\\you\\.blueprint-studio\\library）'
  if (/[\u0000-\u001f]/.test(value)) return '路径包含非法控制字符'
  const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = norm(value)
  const project = projectPath ? norm(projectPath) : ''
  if (project && (root === project || root.startsWith(`${project}/`) || project.startsWith(`${root}/`))) {
    return '库路径不能与当前项目目录重叠'
  }
  return null
}

interface SettingsState extends EditorSettings {
  /** 更新一个或多个设置并持久化 */
  update: (patch: Partial<EditorSettings>) => void
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  ...loadSettings(),
  update: (patch) => {
    const next: EditorSettings = {
      libraryRoot: patch.libraryRoot ?? get().libraryRoot,
      autoRerun: patch.autoRerun ?? get().autoRerun,
    }
    saveSettings(next)
    set(next)
  },
}))
