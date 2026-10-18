/**
 * 运行窗口启动链路（T1.6 · PLAN §6.2 顶栏 / §12）
 *
 * URL 契约（T2.6 事件驱动运行沿用同一入口）：
 *   runtime.html?project=<项目文件夹名>&ui=<资产路径,如 ui/main.ui.json>&mode=main|current
 *   - mode=main（F5 运行主 UI）：ui 参数可缺省，运行窗口读 project.json.mainUI；
 *   - mode=current（F6 运行当前）：编辑器把当前 UI tab 的项目内相对路径作为 ui 传入。
 *
 * Toolbar 按钮与 keymap（F5/F6 快捷键）共用本模块的 launchRuntimeMain / launchRuntimeCurrent，
 * 避免两处重复实现。弹窗被浏览器拦截时降级 _blank 新标签页（参照 windows/popout.ts 的
 * 降级写法自写三行，不 import 它）；彻底失败 toast 提示。
 *
 * 本模块保持可在 node:test 下运行：除 UI 侧 toast（可注入替身）外不触碰 DOM。
 */
import { useWorkspaceStore } from './workspace-store'
import { useRuntimeStore } from '@/panels/runtime/store'
import { showToast } from './windows/toast'

/* ---------------- URL 契约 ---------------- */

/** 运行模式：main = 主 UI（F5）；current = 当前 UI 资产（F6） */
export type RuntimeMode = 'main' | 'current'

/** 运行窗口 URL 参数（buildRuntimeUrl 的输入） */
export interface RuntimeUrlParams {
  /** 项目文件夹名（服务端 FS API 安全根的首段） */
  project: string
  /** UI 资产路径（项目内相对路径，如 'ui/main.ui.json'）；mode=main 可缺省 */
  ui?: string
  mode: RuntimeMode
  /** 内置运行视图（iframe）模式：隐藏运行页顶栏/页内控制台 UI（v3 T8.5） */
  embed?: boolean
  /** 重跑 nonce（仅用于刷新 iframe；不参与运行语义） */
  run?: number
}

export const RUNTIME_URL_PATH = '/runtime.html'
/** 命名弹窗尺寸（任务卡指定 980×720） */
export const RUNTIME_WINDOW_FEATURES = 'width=980,height=720'

/** window.open 命名窗口：同模式重复运行复用同一窗口（再次 open 即导航重载） */
export function runtimeWindowName(mode: RuntimeMode): string {
  return `bps-runtime-${mode}`
}

/**
 * 构造运行窗口 URL。project / ui 中的中文与特殊字符经 URLSearchParams
 * 按 UTF-8 百分号编码；URLSearchParams.get 读取时自动解码（往返无损）。
 */
export function buildRuntimeUrl(params: RuntimeUrlParams): string {
  const q = new URLSearchParams()
  q.set('project', params.project)
  if (params.ui !== undefined && params.ui !== '') q.set('ui', params.ui)
  q.set('mode', params.mode)
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

/**
 * 运行窗口标题（DoD：窗口标题含运行模式）：
 *   mode=main    → 「运行 · 主UI <项目名>」
 *   mode=current → 「运行 · <资产文件名> <项目名>」
 */
export function runtimeWindowTitle(params: { mode: RuntimeMode; ui: string; project: string }): string {
  return params.mode === 'main'
    ? `运行 · 主UI ${params.project}`
    : `运行 · ${pathBasename(params.ui)} ${params.project}`
}

/**
 * project.json 文本 → mainUI 路径（运行窗口 mode=main 且缺省 ui 时用）。
 * 结构非法 / 缺 mainUI 字段抛中文错误（运行窗口错误态直接展示该信息）。
 */
export function parseMainUI(projectJsonText: string): string {
  let raw: unknown
  try {
    raw = JSON.parse(projectJsonText)
  } catch (err) {
    throw new Error(`project.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('project.json 格式错误：根节点不是对象')
  const mainUI = (raw as { mainUI?: unknown }).mainUI
  if (typeof mainUI !== 'string' || mainUI.trim() === '') {
    throw new Error('project.json 未配置 mainUI（主 UI）：请在项目 project.json 中设置 mainUI 字段')
  }
  return mainUI
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

/** 探测频道（运行窗口打开后回报 pong，供「open 返回 null 但窗口已开」环境避免双开） */
export const RUNTIME_PROBE_CHANNEL = 'bps-runtime-probe'

/** pong 探测等待时长（ms） */
export const RUNTIME_PROBE_TIMEOUT_MS = 250

/**
 * 探测运行窗口是否真的打开了：广播 ping，等待运行窗口回 pong（按 url 匹配）。
 * 动机（实机缺陷修复）：部分宿主（内嵌浏览器等）window.open 成功打开窗口却返回 null，
 * 旧逻辑误判「被拦截」降级 _blank → 运行窗口双开。探测确认失败才降级。
 */
function probeRuntimeWindow(url: string, timeoutMs = RUNTIME_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === 'undefined') {
      resolve(false)
      return
    }
    let ch: BroadcastChannel | null = null
    try {
      ch = new BroadcastChannel(RUNTIME_PROBE_CHANNEL)
    } catch {
      resolve(false)
      return
    }
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ch!.close()
      } catch {
        /* 已关闭 */
      }
      resolve(ok)
    }
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string; url?: string } | null
      if (m && m.type === 'runtime.pong' && m.url === url) finish(true)
    }
    ch.postMessage({ type: 'runtime.ping', url })
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

/** 当前项目的 URL 参数值（?project= 原值 = 项目文件夹名；未打开项目返回 null） */
export function currentProjectParam(): string | null {
  const p = useWorkspaceStore.getState().currentProject
  if (!p) return null
  return p.path || p.name
}

/**
 * 打开运行窗口（降级链：命名弹窗 → pong 探测确认 → _blank 新标签页 → toast + false）。
 * 命名弹窗返回 null / 瞬时 closed 时先探测 250ms（窗口实际打开会回报 pong），
 * 确认未打开才降级新标签页——避免「宿主不回引用但窗口已开」环境双开。
 */
async function openRuntimeWindow(
  url: string,
  mode: RuntimeMode,
  opts: RuntimeLaunchOptions,
): Promise<boolean> {
  const open: OpenWindowFn =
    opts.open ?? ((u, t, f) => (typeof window === 'undefined' ? null : window.open(u, t, f)))
  let win = open(url, runtimeWindowName(mode), RUNTIME_WINDOW_FEATURES)
  if (!win || win.closed) {
    const actuallyOpened = await probeRuntimeWindow(url)
    if (!actuallyOpened) {
      // 确认被拦截：降级 _blank 新标签页
      win = open(url, '_blank')
      if (!win || win.closed) {
        ;(opts.toast ?? showToast)('浏览器拦截了弹出窗口，无法打开运行窗口')
        return false
      }
    }
  }
  return true
}

/**
 * 打开独立运行窗口（v3 T8.5「拆出独立窗口」/旧 F5/F6 行为保留给弹窗路径）。
 * 降级链同上；测试可注入 open/toast。
 */
export async function openRuntimeWindowExternal(
  url: string,
  mode: RuntimeMode,
  opts: RuntimeLaunchOptions = {},
): Promise<boolean> {
  return openRuntimeWindow(url, mode, opts)
}

/**
 * F5：运行主 UI（v3 T8.5：打开/聚焦内置运行面板并重跑；不再直接开独立窗口）。
 * ui 参数缺省——由运行页读 project.json.mainUI（PLAN §12）。
 */
export async function launchRuntimeMain(opts: RuntimeLaunchOptions = {}): Promise<boolean> {
  const project = currentProjectParam()
  if (!project) {
    ;(opts.toast ?? showToast)('未打开项目，无法运行')
    return false
  }
  useRuntimeStore.getState().openTarget({ project, mode: 'main' })
  return true
}

/**
 * F6：运行当前 UI（v3 T8.5：内置运行面板重跑）。激活 tab 必须是 UI 资产，
 * 否则 toast「当前 tab 不是 UI」且不切换运行目标；ui 参数 = 该项目内相对路径。
 */
export async function launchRuntimeCurrent(opts: RuntimeLaunchOptions = {}): Promise<boolean> {
  const toast = opts.toast ?? showToast
  const project = currentProjectParam()
  if (!project) {
    toast('未打开项目，无法运行')
    return false
  }
  const ws = useWorkspaceStore.getState()
  const tab = ws.openTabs.find((t) => t.id === ws.activeTabId)
  if (!tab || tab.kind !== 'ui') {
    toast('当前 tab 不是 UI，无法运行')
    return false
  }
  useRuntimeStore.getState().openTarget({ project, ui: tab.assetPath, mode: 'current' })
  return true
}
