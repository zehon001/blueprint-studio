/**
 * 内置面板注册 + 默认布局 + 启动装配（T0.3；v3 T8.1 修订）
 *
 * 后续卡替换面板实现：改本文件对应 registerPanel 的 component（id 不变）；
 * 新增静态面板：加一行 registerPanel（≤10 行 DoD），需要默认可见时加进 buildDefaultLayout。
 *
 * 默认布局（后台式导航 + 蓝图工作区）：
 * ┌ 顶栏 ──────────────────────────────────────────────┐
 * ├ [左侧导航] ┬ 蓝图页 ┬ 中央[资产面板] ┬ 右列[检视器] ┤
 * │            ├ 底部 [文件系统 | 控制台] ───────────────┤
 * └────────────┴───────────────────────────────────────┘
 *
 * 中央组不再有固定「工作区」面板：资产打开时以 `asset:<kind>:<path>` 动态注册并
 * 并入中央组；运行视图 `runtime` 作为中央初始页（F5 前的空态）。
 */
import {
  FILE_SYSTEM_PANEL_ID,
  registerFileSystemPanel,
  registerFsDomain,
  startFsUndoSync,
} from '@/panels/file-system'
import { parseLayout, readLayoutRaw } from './persist'
import { listPanels } from './registry'
import { useDockStore } from './store'
import { findTabsByPanel, makeTabs, type DockNode } from './tree'
import { registerConsolePanel } from '@/panels/console'
import { registerDetailsPanel } from '@/panels/details'
import { ensureAssetPanelsInLayout, syncWorkspaceFromDock } from './assetPanel'
import { useSidebarStore } from '@/shell/sidebar/sidebar-store'

/* 内置面板 id（跨卡契约：替换实现时保持 id 不变） */
export const PANEL_ID_CONSOLE = 'console'
export const PANEL_ID_DETAILS = 'details'

/** 与 My Blueprint 左栏默认宽度一致（CSS：.bp-editor-side 248px） */
const DEFAULT_FILE_SYSTEM_WIDTH_PX = 248
/** 左侧后台导航宽度（CSS：.app-sidebar 168px） */
const SIDEBAR_WIDTH_PX = 168

/** 底部「文件系统 | 控制台」权重：文件系统初始宽度对齐 My Blueprint */
function defaultBottomSizes(): [number, number] {
  const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth
  const sidebar = useSidebarStore.getState().open ? SIDEBAR_WIDTH_PX : 0
  const contentWidth = Math.max(480, viewport - sidebar)
  const fileSystem = Math.min(DEFAULT_FILE_SYSTEM_WIDTH_PX, Math.floor(contentWidth / 2))
  return [fileSystem, Math.max(1, contentWidth - fileSystem)]
}

/* 文件系统命令域 + undo/redo 磁盘补偿（面板移入左侧菜单，域注册与补偿仍需启动） */
registerFsDomain()
startFsUndoSync()

/* 面板注册（模块副作用；每面板一行） */
registerFileSystemPanel() // 文件系统（id: 'file-system'；默认与控制台并排）
registerConsolePanel() // T1.6 控制台（id: 'console'）
registerDetailsPanel() // 检视（蓝图节点 / 图参数；id: 'details'）

/** 单面板 tabs 组 */
function oneTabs(panelId: string): DockNode {
  return makeTabs([panelId])
}

/**
 * 默认布局：中央编辑区（初始空态）、右列检视器、底部「文件系统 | 控制台」。
 * 底部高度约 1/3；文件系统初始宽度 248px，与上方 My Blueprint 左栏对齐。
 */
export function buildDefaultLayout(): DockNode {
  const bottomSizes = defaultBottomSizes()
  return {
    kind: 'split',
    dir: 'v',
    sizes: [68, 32],
    children: [
      {
        kind: 'split',
        dir: 'h',
        sizes: [3, 1],
        children: [makeTabs([]), makeTabs([PANEL_ID_DETAILS])],
      },
      {
        kind: 'split',
        dir: 'h',
        sizes: bottomSizes,
        children: [oneTabs(FILE_SYSTEM_PANEL_ID), oneTabs(PANEL_ID_CONSOLE)],
      },
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
  // 旧布局（文件系统还在左侧菜单）迁移：首次升级时若布局里没有文件系统 dock 面板，
  // 直接采用新默认布局，让「文件系统 | 控制台」底部并排立即生效。
  const migrationKey = 'bps.dockLayout.fileSystemDock.v1'
  let restoredRoot = restored?.root ?? undefined
  let restoredActive = restored?.activePanelId ?? null
  try {
    if (!localStorage.getItem(migrationKey)) {
      localStorage.setItem(migrationKey, '1')
      if (restoredRoot && findTabsByPanel(restoredRoot, FILE_SYSTEM_PANEL_ID) === null) {
        restoredRoot = undefined
        restoredActive = null
      }
    }
  } catch {
    /* localStorage 不可用：直接使用默认布局 */
  }
  useDockStore
    .getState()
    .initDockLayout(
      buildDefaultLayout(),
      restoredRoot,
      restoredActive,
    )
  syncWorkspaceFromDock()
}
