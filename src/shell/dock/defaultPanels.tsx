/**
 * 内置面板注册 + 默认布局 + 启动装配（T0.3 · PLAN §6.2 默认布局）
 *
 * 后续卡替换面板实现：改本文件对应 registerPanel 的 component（id 不变）；
 * 新增面板：加一行 registerPanel（≤10 行 DoD），需要默认可见时加进 buildDefaultLayout。
 *
 * 默认布局（PLAN §6.2）：
 * ┌ 顶栏 ──────────────────────────────────────────────┐
 * ├ 左列[文件系统|UI 树] ┬ 中央[工作区] ┬ 右列[检视器|事件面板] ┤
 * ├ 底部[控制台] ──────────────────────────────────────┘
 */
import { loadPersistedLayout } from './persist'
import { listPanels, registerPanel } from './registry'
import { useDockStore } from './store'
import { makeTabs, type DockNode } from './tree'
import { registerFileSystemPanel } from '@/panels/file-system'
import { registerSceneTreePanel } from '@/panels/scene-tree'
import { registerInspectorPanel } from '@/panels/inspector'
import { registerEventsPanel } from '@/panels/events'
import { registerPluginManagerPanel } from '@/panels/plugin-manager'
import {
  ConsolePanelPlaceholder,
  WorkspacePanel,
} from './placeholderPanels'

/* 内置面板 id（跨卡契约：替换实现时保持 id 不变） */
export const PANEL_ID_FILE_SYSTEM = 'file-system'
export const PANEL_ID_SCENE_TREE = 'scene-tree'
export const PANEL_ID_WORKSPACE = 'workspace'
export const PANEL_ID_INSPECTOR = 'inspector'
export const PANEL_ID_EVENTS = 'events'
export const PANEL_ID_CONSOLE = 'console'

/* 面板注册（模块副作用；每面板一行） */
registerFileSystemPanel() // T0.7 文件系统（id: 'file-system'，与占位一致）
registerSceneTreePanel() // T1.4 UI 树（id: 'scene-tree'）
registerInspectorPanel() // T1.5 检视器（id: 'inspector'）
registerEventsPanel() // T5.2 事件面板（id: 'events'）
registerPluginManagerPanel() // T6.2 插件管理（id: 'plugin-manager'）
registerPanel({ id: PANEL_ID_WORKSPACE, title: '工作区', component: WorkspacePanel, defaultArea: 'center', singleton: true })
registerPanel({ id: PANEL_ID_CONSOLE, title: '控制台', component: ConsolePanelPlaceholder, defaultArea: 'bottom' })

/** 单面板 tabs 组 */
function oneTabs(panelId: string): DockNode {
  return makeTabs([panelId])
}

/** 默认布局（PLAN §6.2）：左列上下分、中央工作区、右列上下分、底部控制台 */
export function buildDefaultLayout(): DockNode {
  return {
    kind: 'split',
    dir: 'v',
    sizes: [4, 1],
    children: [
      {
        kind: 'split',
        dir: 'h',
        sizes: [1, 3, 1],
        children: [
          { kind: 'split', dir: 'v', sizes: [1, 1], children: [oneTabs(PANEL_ID_FILE_SYSTEM), oneTabs(PANEL_ID_SCENE_TREE)] },
          oneTabs(PANEL_ID_WORKSPACE),
          { kind: 'split', dir: 'v', sizes: [1, 1], children: [oneTabs(PANEL_ID_INSPECTOR), oneTabs(PANEL_ID_EVENTS)] },
        ],
      },
      oneTabs(PANEL_ID_CONSOLE),
    ],
  }
}

/**
 * 启动装配（main.tsx 在面板注册后调用一次）：
 * 读持久化布局（经 normalizeDockNode 容错校验，未知面板剔除）→ 失败回退默认布局。
 */
export function bootstrapDock(): void {
  const knownIds = new Set(listPanels().map((p) => p.id))
  useDockStore.getState().initDockLayout(buildDefaultLayout(), loadPersistedLayout(knownIds))
}
