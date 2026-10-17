/**
 * 面板拆出 / 合回（T0.4 · PLAN §3.1 窗口模型 / §6.2）
 *
 * 拆出：popoutPanel(panelId) 以 window.open 打开 /editor.html?panel=<id>&project=<路径>
 *   （命名窗口 bps-panel-<id>，520×680）；被浏览器拦截（返回 null 或瞬时 closed）
 *   → 降级为 _blank 新标签页；再失败 → toast 提示并报告 blocked。
 *   拆出后主窗 dock 中该面板原地显示「已拆出」占位页签（占位组件见 PopoutApp.tsx），
 *   业务状态经 BroadcastChannel 与弹窗保持一致（见 sync.ts / bridge.ts）。
 *
 * 合回：占位页签「合回」按钮 / 页签 ⊟ 按钮 → recallPopout：关闭弹窗窗口并恢复原位；
 *   弹窗自身关闭（beforeunload / pagehide 发 bye）或心跳超时（失联）也会自动合回
 *   （由 bridge.ts 调 handlePopoutClosed / handlePopoutLost）。
 *
 * 状态机（usePopoutsStore，key = panelId）：
 *   无记录（已停靠）→ markOpening('window' | 'tab') → markOpened → popped
 *   popped → markLost（失联提示）→ markDocked（自动合回）
 *   popped → markDocked（手动合回 / 弹窗关闭）
 */
import { getPanel } from '@/shell/dock/registry'
import { useWorkspaceStore } from '@/shell/workspace-store'
import { create } from 'zustand'
import { showToast } from './toast'

/* ---------------- URL 约定 ---------------- */

export const POPOUT_URL_PATH = '/editor.html'
export const POPOUT_WINDOW_NAME_PREFIX = 'bps-panel-'
export const POPOUT_WIDTH = 520
export const POPOUT_HEIGHT = 680

/**
 * 弹窗模式 URL：editor.html 检测 ?panel= 走弹窗模式（PopoutApp）。
 * 使用相对路径以保留当前 origin（开发 / 生产端口自适应）；project 透传项目上下文。
 */
export function buildPopoutUrl(panelId: string, projectPath?: string | null): string {
  const params = new URLSearchParams({ panel: panelId })
  if (projectPath) params.set('project', projectPath)
  return `${POPOUT_URL_PATH}?${params.toString()}`
}

/** 从当前地址解析弹窗模式面板 id（非弹窗模式 / 非浏览器环境返回 null） */
export function popoutPanelIdFromLocation(): string | null {
  if (typeof location === 'undefined') return null
  return new URLSearchParams(location.search).get('panel')
}

/* ---------------- 拆出状态机（主窗 dock 侧） ---------------- */

/** 拆出方式：window = 弹窗；tab = 被拦截后降级的新标签页 */
export type PopoutMode = 'window' | 'tab'

/** 拆出会话状态：opening（打开中）→ popped（已拆出）；lost（失联）为短暂提示态 */
export type PopoutStatus = 'opening' | 'popped' | 'lost'

export interface PopoutSession {
  status: PopoutStatus
  mode: PopoutMode
}

interface PopoutsState {
  /** key = panelId；无记录 = 已停靠 */
  sessions: Record<string, PopoutSession>
  markOpening: (panelId: string, mode: PopoutMode) => void
  markOpened: (panelId: string) => void
  markLost: (panelId: string) => void
  /** 合回（移除记录；幂等） */
  markDocked: (panelId: string) => void
}

export const usePopoutsStore = create<PopoutsState>()((set) => ({
  sessions: {},
  markOpening: (panelId, mode) =>
    set((s) => ({ sessions: { ...s.sessions, [panelId]: { status: 'opening', mode } } })),
  markOpened: (panelId) =>
    set((s) => {
      const cur = s.sessions[panelId]
      if (!cur) return {}
      return { sessions: { ...s.sessions, [panelId]: { ...cur, status: 'popped' } } }
    }),
  markLost: (panelId) =>
    set((s) => {
      const cur = s.sessions[panelId]
      if (!cur) return {}
      return { sessions: { ...s.sessions, [panelId]: { ...cur, status: 'lost' } } }
    }),
  markDocked: (panelId) =>
    set((s) => {
      if (!(panelId in s.sessions)) return {}
      const sessions = { ...s.sessions }
      delete sessions[panelId]
      return { sessions }
    }),
}))

/** 面板当前是否处于拆出态（opening / popped / lost 皆算） */
export function isPoppedOut(panelId: string): boolean {
  return usePopoutsStore.getState().sessions[panelId] !== undefined
}

/* ---------------- 窗口跟踪与打开（降级链） ---------------- */

export interface PopoutWindowLike {
  closed: boolean
  close(): void
  focus?(): void
}

export type OpenWindowFn = (url: string, target?: string, features?: string) => PopoutWindowLike | null

function defaultOpenWindow(url: string, target?: string, features?: string): PopoutWindowLike | null {
  if (typeof window === 'undefined') return null
  return window.open(url, target, features)
}

/** 打开句柄跟踪（主窗主动关窗 / 失联自动关闭 / 已拆出时聚焦复用） */
const popoutWindows = new Map<string, PopoutWindowLike>()

export type PopoutOpenResult =
  | { ok: true; mode: PopoutMode }
  | { ok: false; reason: 'unknown-panel' | 'blocked' }

export interface PopoutOpenOptions {
  /** window.open 替身（测试注入） */
  open?: OpenWindowFn
  /** toast 替身（测试注入） */
  toast?: (message: string) => void
  /** 项目路径（缺省取 workspace-store 当前项目） */
  projectPath?: string | null
}

/**
 * 拆出面板到独立窗口（降级链：弹窗 → _blank 新标签页 → toast + blocked）。
 * 已拆出时聚焦已有窗口，不重复打开。
 */
export function popoutPanel(panelId: string, options: PopoutOpenOptions = {}): PopoutOpenResult {
  const toast = options.toast ?? showToast
  const def = getPanel(panelId)
  if (!def) {
    toast(`拆出失败：未知面板「${panelId}」`)
    return { ok: false, reason: 'unknown-panel' }
  }
  const existing = usePopoutsStore.getState().sessions[panelId]
  if (existing) {
    popoutWindows.get(panelId)?.focus?.()
    return { ok: true, mode: existing.mode }
  }

  const projectPath =
    options.projectPath !== undefined
      ? options.projectPath
      : (useWorkspaceStore.getState().currentProject?.path ?? null)
  const url = buildPopoutUrl(panelId, projectPath)
  const open = options.open ?? defaultOpenWindow

  let win = open(url, POPOUT_WINDOW_NAME_PREFIX + panelId, `width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT}`)
  let mode: PopoutMode = 'window'
  if (!win || win.closed) {
    // 降级：弹出窗口被浏览器拦截 → 新标签页打开
    mode = 'tab'
    win = open(url, '_blank')
  }
  if (!win || win.closed) {
    toast(`浏览器拦截了弹出窗口，无法拆出「${def.title}」`)
    return { ok: false, reason: 'blocked' }
  }

  popoutWindows.set(panelId, win)
  const store = usePopoutsStore.getState()
  store.markOpening(panelId, mode)
  store.markOpened(panelId)
  return { ok: true, mode }
}

/** 关闭跟踪中的弹窗窗口（幂等；close 失败静默——窗口可能已被用户关闭） */
export function closePopoutWindow(panelId: string): void {
  const win = popoutWindows.get(panelId)
  popoutWindows.delete(panelId)
  if (!win) return
  try {
    win.close()
  } catch {
    /* 窗口可能已关闭 */
  }
}

/**
 * 手动合回：关闭弹窗窗口 + 恢复停靠态。
 * 弹窗卸载时会发 bye，主窗 handlePopoutClosed 幂等兜底。
 */
export function recallPopout(panelId: string, options: { toast?: (message: string) => void } = {}): boolean {
  const store = usePopoutsStore.getState()
  if (!store.sessions[panelId]) return false
  closePopoutWindow(panelId)
  store.markDocked(panelId)
  const title = getPanel(panelId)?.title ?? panelId
  ;(options.toast ?? showToast)(`「${title}」已合回主窗`)
  return true
}

/* ---------------- 弹窗侧事件（由 bridge.ts 转调） ---------------- */

/** 弹窗正常关闭（bye / unload）：恢复停靠（幂等） */
export function handlePopoutClosed(panelId: string): void {
  closePopoutWindow(panelId)
  usePopoutsStore.getState().markDocked(panelId)
}

/** 弹窗心跳失联：占位页切「失联」提示 → 关窗 → 自动合回（PLAN §3.1） */
export function handlePopoutLost(panelId: string, options: { toast?: (message: string) => void } = {}): void {
  const store = usePopoutsStore.getState()
  if (!store.sessions[panelId]) return
  store.markLost(panelId)
  closePopoutWindow(panelId)
  store.markDocked(panelId)
  const title = getPanel(panelId)?.title ?? panelId
  ;(options.toast ?? showToast)(`「${title}」弹窗已失联，已自动合回主窗`)
}
