/**
 * 内置面板注册 + 默认布局 + 启动装配（T0.3；v3 T8.1 修订）
 *
 * 后续卡替换面板实现：改本文件对应 registerPanel 的 component（id 不变）；
 * 新增静态面板：加一行 registerPanel（≤10 行 DoD），需要默认可见时加进 buildDefaultLayout。
 *
 * 默认布局（文件系统/资源库移入左侧菜单、运行面板移除后）：
 * ┌ 顶栏 ──────────────────────────────────────────────┐
 * ├ [左侧菜单(非 dock)] ┬ 中央[资产面板] ┬ 右列[检视器] ┤
 * ├ 底部[控制台] ──────────────────────────────────────┘
 *
 * 中央组不再有固定「工作区」面板：资产打开时以 `asset:<kind>:<path>` 动态注册并
 * 并入中央组；运行视图 `runtime` 作为中央初始页（F5 前的空态）。
 */
import { registerFsDomain, startFsUndoSync } from '@/panels/file-system'
import { parseLayout, readLayoutRaw } from './persist'
import { listPanels } from './registry'
import { useDockStore } from './store'
import { makeTabs, type DockNode } from './tree'
import { registerConsolePanel } from '@/panels/console'
import { registerDetailsPanel } from '@/panels/details'
import { ensureAssetPanelsInLayout, syncWorkspaceFromDock } from './assetPanel'

/* 内置面板 id（跨卡契约：替换实现时保持 id 不变） */
export const PANEL_ID_CONSOLE = 'console'
export const PANEL_ID_DETAILS = 'details'

/* 文件系统命令域 + undo/redo 磁盘补偿（面板移入左侧菜单，域注册与补偿仍需启动） */
registerFsDomain()
startFsUndoSync()

/* 面板注册（模块副作用；每面板一行） */
registerConsolePanel() // T1.6 控制台（id: 'console'）
registerDetailsPanel() // 检视（蓝图节点 / 图参数；id: 'details'）

/** 单面板 tabs 组 */
function oneTabs(panelId: string): DockNode {
  return makeTabs([panelId])
}

/** 默认布局：中央编辑区（初始空态）、右列检视器、底部控制台 */
export function buildDefaultLayout(): DockNode {
  return {
    kind: 'split',
    dir: 'v',
    sizes: [4, 1],
    children: [
      {
        kind: 'split',
        dir: 'h',
        sizes: [3, 1],
        children: [makeTabs([]), makeTabs([PANEL_ID_DETAILS])],
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
    .initDockLayout(
      buildDefaultLayout(),
      restored ? restored.root : undefined,
      restored?.activePanelId ?? null,
    )
  syncWorkspaceFromDock()
}
