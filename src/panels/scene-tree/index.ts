/**
 * UI 树面板出口（T1.4）
 *
 * PM 接线（defaultPanels.tsx 或工作区装配处）：
 * ```ts
 * import { registerSceneTreePanel } from '@/panels/scene-tree'
 * registerSceneTreePanel() // id 'scene-tree'，默认吸附左列（与文件系统面板同区 tab）
 * ```
 *
 * 对齐 registerFileSystemPanel 模式：内部一行 registerPanel，返回 open / close /
 * toggle / activate / isOpen 句柄。命令域（scene-tree）由共享 store（@/ui-editor/store）
 * 在首次使用时自动挂载，本出口无需额外注册。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { SceneTreePanel } from './SceneTreePanel'
// 样式统一在应用入口引入（组件文件不 import .css，保证 node:test 可直接加载）：
// 通用右键菜单样式（Menu 组件使用）+ 本面板样式，全部引用 theme.css token。
import '@/panels/file-system/menu.css'
import './styles.css'

/** 面板 id（dock 布局主键） */
export const SCENE_TREE_PANEL_ID = 'scene-tree'

/** 注册 UI 树面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerSceneTreePanel(): PanelApi {
  return registerPanel({
    id: SCENE_TREE_PANEL_ID,
    title: 'UI 树',
    component: SceneTreePanel,
    defaultArea: 'left',
  })
}

export { SceneTreePanel } from './SceneTreePanel'
export { AddNodeMenu } from './AddNodeMenu'
export * from './tree-model'
export * from './commands'
