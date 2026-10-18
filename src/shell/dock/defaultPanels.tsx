/**
 * 内置面板注册 + 默认布局 + 启动装配（T0.3；v3 T8.1 修订）
 *
 * 后续卡替换面板实现：改本文件对应 registerPanel 的 component（id 不变）；
 * 新增静态面板：加一行 registerPanel（≤10 行 DoD），需要默认可见时加进 buildDefaultLayout。
 *
 * v3 默认布局（PLAN §4.1）：
 * ┌ 顶栏 ──────────────────────────────────────────────┐
 * ├ 左列[文件系统|UI 树] ┬ 中央[资产面板|运行] ┬ 右列[检视器|事件面板] ┤
 * ├ 底部[控制台] ──────────────────────────────────────┘
 *
 * 中央组不再有固定「工作区」面板：资产打开时以 `asset:<kind>:<path>` 动态注册并
 * 并入中央组；运行视图 `runtime` 作为中央初始页（F5 前的空态）。
 */
import { parseLayout, readLayoutRaw } from './persist'
import { listPanels } from './registry'
import { useDockStore } from './store'
import { makeTabs, type DockNode } from './tree'
import { registerFileSystemPanel } from '@/panels/file-system'
import { registerSceneTreePanel } from '@/panels/scene-tree'
import { registerInspectorPanel } from '@/panels/inspector'
import { registerEventsPanel } from '@/panels/events'
import { registerConsolePanel } from '@/panels/console'
import { registerRuntimePanel } from '@/panels/runtime'
import { ensureAssetPanelsInLayout, syncWorkspaceFromDock } from './assetPanel'

/* 内置面板 id（跨卡契约：替换实现时保持 id 不变） */
export const PANEL_ID_FILE_SYSTEM = 'file-system'
export const PANEL_ID_SCENE_TREE = 'scene-tree'
export const PANEL_ID_RUNTIME = 'runtime'
export const PANEL_ID_INSPECTOR = 'inspector'
export const PANEL_ID_EVENTS = 'events'
export const PANEL_ID_CONSOLE = 'console'

/* 面板注册（模块副作用；每面板一行） */
registerFileSystemPanel() // T0.7 文件系统（id: 'file-system'）
registerSceneTreePanel() // T1.4 UI 树（id: 'scene-tree'；T9.4 内嵌进 UI 编辑器后移除）
registerInspectorPanel() // T1.5 / T8.2 统一检视器（id: 'inspector'）
registerEventsPanel() // T5.2 事件面板（id: 'events'）
registerConsolePanel() // T1.6 控制台（id: 'console'）
registerRuntimePanel() // T8.5 内置运行视图（iframe + embed；id: 'runtime'）

/** 单面板 tabs 组 */
function oneTabs(panelId: string): DockNode {
  return makeTabs([panelId])
}

/** 默认布局（PLAN §4.1）：左列上下分、中央运行/资产、右列上下分、底部控制台 */
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
          oneTabs(PANEL_ID_RUNTIME),
          { kind: 'split', dir: 'v', sizes: [1, 1], children: [oneTabs(PANEL_ID_INSPECTOR), oneTabs(PANEL_ID_EVENTS)] },
        ],
      },
      oneTabs(PANEL_ID_CONSOLE),
    ],
  }
}

/**
 * 启动装配（main.tsx 在面板注册后调用一次）：
 * 1. 读原始布局 → 扫描 `asset:` 面板并注册（动态面板）；
 * 2. 用「静态面板 + 动态资产面板」knownIds 做 normalize（未知静态面板剔除）；
 * 3. 注入默认布局 / 还原布局 + activePanelId；
 * 4. 从布局重建 workspace 注册表（openTabs/activeTabId）。
 */
export function bootstrapDock(): void {
  const raw = readLayoutRaw()
  const unfiltered = raw ? parseLayout(raw) : null
  const assetIds = unfiltered ? ensureAssetPanelsInLayout(unfiltered.root) : new Set<string>()
  const knownIds = new Set<string>([...listPanels().map((p) => p.id), ...assetIds])
  const restored = raw ? parseLayout(raw, knownIds) : null
  useDockStore
    .getState()
    .initDockLayout(buildDefaultLayout(), restored?.root ?? null, restored?.activePanelId ?? null)
  syncWorkspaceFromDock()
}
