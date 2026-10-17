/**
 * 面板注册表（T0.3 · DoD：注册一个新面板 ≤10 行代码）
 *
 * 示例（后续真实面板落地时的完整接法，如 T0.7 用真实文件系统面板替换占位）：
 * ```ts
 * // src/panels/console/index.ts
 * import { registerPanel } from '@/shell/dock/registry'
 * import { ConsolePanel } from './ConsolePanel'
 *
 * registerPanel({ id: 'console', title: '控制台', component: ConsolePanel, defaultArea: 'bottom' })
 * ```
 * 注册即返回 api（open / close / toggle / activate / isOpen）；
 * 新 id 默认不在布局中，可经顶栏「面板」菜单打开，或加入 defaultPanels 的默认布局。
 * 顶栏「面板」下拉经 usePanels() 订阅注册表变化（useSyncExternalStore）。
 */
import { useSyncExternalStore, type ComponentType } from 'react'
import { useDockStore } from './store'
import { findTabsByPanel, type DockArea } from './tree'

/** 面板定义（注册的唯一写法） */
export interface PanelDefinition {
  /** 稳定 id：布局树 / 持久化以此为主键，替换实现时保持 id 不变可继承用户布局 */
  id: string
  /** 标题（tab 与「面板」菜单展示，中文） */
  title: string
  /** 可选图标（预留，暂不渲染） */
  icon?: string
  /** 面板内容组件 */
  component: ComponentType
  /** 默认吸附区：菜单打开 / 首次布局放置时使用 */
  defaultArea: DockArea
  /**
   * 单实例面板标记。当前布局模型按 id 唯一（天然单实例），
   * 此字段为未来多实例面板（如多资产编辑器并存）预留，本期无行为。
   */
  singleton?: boolean
}

/** 注册返回的句柄：命令式开关面板 */
export interface PanelApi {
  /** 打开（已开则激活）；按注册的 defaultArea 落位 */
  open(): void
  /** 关闭（从所在 tabs 组移除，可再打开） */
  close(): void
  /** 开关切换 */
  toggle(): void
  /** 激活（未打开时先打开） */
  activate(): void
  /** 是否已打开 */
  isOpen(): boolean
}

const defs = new Map<string, PanelDefinition>()
const listeners = new Set<() => void>()
/** 列表快照缓存：useSyncExternalStore 要求 getSnapshot 返回稳定引用 */
let snapshot: PanelDefinition[] = []

function notify(): void {
  snapshot = [...defs.values()]
  for (const listener of listeners) listener()
}

/**
 * 注册面板（重复 id 覆盖并告警——热更新 / 占位替换场景友好）；
 * 返回该面板的操作句柄。
 */
export function registerPanel(def: PanelDefinition): PanelApi {
  if (typeof def.id !== 'string' || def.id.length === 0) throw new Error('[dock] registerPanel 缺少 id')
  if (typeof def.title !== 'string' || def.title.length === 0) {
    throw new Error(`[dock] 面板 ${def.id} 缺少 title`)
  }
  if (typeof def.component !== 'function') throw new Error(`[dock] 面板 ${def.id} 缺少 component`)
  if (defs.has(def.id)) console.warn(`[dock] 面板重复注册，已覆盖：${def.id}`)
  defs.set(def.id, def)
  notify()
  const api: PanelApi = {
    open: () => useDockStore.getState().openPanel(def.id, def.defaultArea),
    close: () => useDockStore.getState().closePanel(def.id),
    activate: () => useDockStore.getState().activatePanel(def.id, def.defaultArea),
    toggle: () => {
      if (api.isOpen()) api.close()
      else api.open()
    },
    isOpen: () => findTabsByPanel(useDockStore.getState().root, def.id) !== null,
  }
  return api
}

/** 按 id 取面板定义 */
export function getPanel(id: string): PanelDefinition | undefined {
  return defs.get(id)
}

/** 全部已注册面板（注册序） */
export function listPanels(): PanelDefinition[] {
  return snapshot
}

/** 订阅注册表变化（返回解绑函数） */
export function subscribePanels(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React 侧订阅：全部已注册面板列表 */
export function usePanels(): PanelDefinition[] {
  return useSyncExternalStore(subscribePanels, listPanels)
}
