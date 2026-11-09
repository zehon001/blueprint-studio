/**
 * 文件系统面板出口（T0.7；UI 改版后面板组件由左侧菜单 Sidebar 直接挂载，
 * 不再注册 dock 面板；命令域与 undo/redo 磁盘补偿由 defaultPanels 启动）。
 */
export { FileSystemPanel } from './FileSystemPanel'
export { Menu } from './Menu'
export type { MenuItem } from './Menu'
export { defaultFsApi, createFsApi, FsApiError } from './api'
export * from './paths'
export * from './tree-model'
export * from './commands'
