/**
 * 运行启动链路（纯蓝图工作流）
 *
 * URL 契约：
 *   runtime.html?project=<项目文件夹名>&bp=<蓝图路径,如 blueprint/main.bp.json>&run=<nonce>&embed=1
 *   - bp 参数可缺省：运行窗口读 project.json.mainBlueprint；
 *   - embed=1 为内置运行视图（iframe）模式：隐藏运行页顶栏。
 *
 * Toolbar 运行按钮与 keymap（F5）共用本模块的 launchRuntime，
 * 避免两处重复实现。弹窗被浏览器拦截时降级 _blank 新标签页。
 *
 * 本模块保持可在 node:test 下运行：除 UI 侧 toast（可注入替身）外不触碰 DOM。
 */
import { useWorkspaceStore } from './workspace-store'
import { useRuntimeStore } from '@/panels/runtime/store'
import { showToast } from './windows/toast'

/* ---------------- URL 契约 ---------------- */

/** 运行窗口 URL 参数（buildRuntimeUrl 的输入） */
export interface RuntimeUrlParams {
  /** 项目文件夹名（服务端 FS API 安全根的首段） */
  project: string
  /** 蓝图资产路径（项目内相对路径，如 'blueprint/main.bp.json'）；缺省读 project.json.mainBlueprint */
  bp?: string
  /** 内置运行视图（iframe）模式：隐藏运行页顶栏/页内控制台 UI */
  embed?: boolean
  /** 重跑 nonce（仅用于刷新 iframe；不参与运行语义） */
  run?: number
}

export const RUNTIME_URL_PATH = '/runtime.html'
/** 命名弹窗尺寸（沿用 v3 的 980×720） */
export const RUNTIME_WINDOW_FEATURES = 'width=980,height=720'

/** window.open 命名窗口：重复运行复用同一窗口（再次 open 即导航重载） */
export function runtimeWindowName(): string {
  return 'bps-runtime-blueprint'
}

/**
 * 构造运行窗口 URL。project / bp 中的中文与特殊字符经 URLSearchParams
 * 按 UTF-8 百分比编码；URLSearchParams.get 读取时自动解码（往返无损）。
 */
export function buildRuntimeUrl(params: RuntimeUrlParams): string {
  const q = new URLSearchParams()
  q.set('project', params.project)
  if (params.bp !== undefined && params.bp !== '') q.set('bp', params.bp)
  if (params.embed) q.set('embed', '1')
  if (params.run !== undefined) q.set('run', String(params.run))
  return `${RUNTIME_URL_PATH}?${q.toString()}`
}

/** 路径末段（资产文件名，标题/顶栏展示用；兼容 / 与 \ 分隔符） */
export function pathBasename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** 运行窗口标题 */
export function runtimeWindowTitle(params: { bp: string; project: string }): string {
  return `运行 · ${pathBasename(params.bp)} ${params.project}`
}

/* ---------------- 启动（编辑器侧：Toolbar / keymap 共用） ---------------- */

/** window.open 兼容签名（测试注入替身用；返回值只需 closed 字段） */
export type OpenWindowFn = (url: string, target?: string, features?: string) => { closed: boolean } | null

/** 运行启动选项（测试注入；生产调用省略） */
export interface RuntimeLaunchOptions {
  /** window.open 替身（测试注入） */
  open?: OpenWindowFn
  /** toast 替身（测试注入；缺省走全局 showToast） */
  toast?: (message: string) => void
}

/** 当前项目的 URL 参数值（?project= 原值 = 项目文件夹名；未打开项目返回 null） */
export function currentProjectParam(): string | null {
  const p = useWorkspaceStore.getState().currentProject
  if (!p) return null
  return p.path || p.name
}

/**
 * 运行当前打开的蓝图（内置运行面板重跑）。激活 tab 必须是蓝图资产，
 * 否则 toast「当前打开的不是蓝图」且不切换运行目标；bp 参数 = 该项目内相对路径。
 */
export async function launchRuntime(opts: RuntimeLaunchOptions = {}): Promise<boolean> {
  const toast = opts.toast ?? showToast
  const project = currentProjectParam()
  if (!project) {
    toast('未打开项目，无法运行')
    return false
  }
  const ws = useWorkspaceStore.getState()
  const tab = ws.openTabs.find((t) => t.id === ws.activeTabId)
  if (!tab || tab.kind !== 'blueprint') {
    toast('当前打开的不是蓝图，无法运行')
    return false
  }
  useRuntimeStore.getState().openTarget({ project, bp: tab.assetPath })
  return true
}

/**
 * 打开独立运行窗口（拆出独立窗口 / 弹窗路径）。测试可注入 open/toast。
 */
export async function openRuntimeWindowExternal(
  url: string,
  opts: RuntimeLaunchOptions = {},
): Promise<boolean> {
  const open: OpenWindowFn =
    opts.open ?? ((u, t, f) => (typeof window === 'undefined' ? null : window.open(u, t, f)))
  let win = open(url, runtimeWindowName(), RUNTIME_WINDOW_FEATURES)
  if (!win || win.closed) {
    // 确认被拦截：降级 _blank 新标签页
    win = open(url, '_blank')
    if (!win || win.closed) {
      ;(opts.toast ?? showToast)('浏览器拦截了弹出窗口，无法打开运行窗口')
      return false
    }
  }
  return true
}
