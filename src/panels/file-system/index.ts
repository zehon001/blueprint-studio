/**
 * 文件系统面板出口（T0.7；现在作为独立 dock 面板注册，默认与控制台并排）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { FileSystemPanel } from './FileSystemPanel'

export const FILE_SYSTEM_PANEL_ID = 'file-system'

/** 注册文件系统 dock 面板 */
export function registerFileSystemPanel(): PanelApi {
  return registerPanel({
    id: FILE_SYSTEM_PANEL_ID,
    title: '文件系统',
    component: FileSystemPanel,
    defaultArea: 'bottom',
  })
}

export { FileSystemPanel } from './FileSystemPanel'
export { Menu } from './Menu'
export type { MenuItem } from './Menu'
export { defaultFsApi, createFsApi, FsApiError } from './api'
export * from './paths'
export * from './tree-model'
export * from './commands'
