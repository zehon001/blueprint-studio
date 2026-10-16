/**
 * 文件系统面板出口（T0.7）
 *
 * PM 接线（defaultPanels.tsx 中把占位组件那行替换为）：
 * ```ts
 * import { registerFileSystemPanel } from '@/panels/file-system'
 * registerFileSystemPanel() // id 保持 'file-system' 不变，用户已有布局无缝继承
 * ```
 *
 * 本函数同时完成：filesystem 命令域挂载（registerFsDomain）与 undo/redo 磁盘补偿
 * 同步启动（startFsUndoSync，模块级单例，面板关闭时撤销依然落盘）。
 * 不要在本目录之外重复注册（重复 id 会被 dock registry 覆盖并告警）。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { FileSystemPanel } from './FileSystemPanel'
import { registerFsDomain, startFsUndoSync } from './commands'

/** 面板 id（跨卡契约：与 defaultPanels.tsx 的 PANEL_ID_FILE_SYSTEM 一致，替换实现时不变） */
export const FILE_SYSTEM_PANEL_ID = 'file-system'

/** 注册文件系统面板（返回 open / close / toggle / activate / isOpen 句柄） */
export function registerFileSystemPanel(): PanelApi {
  registerFsDomain()
  startFsUndoSync()
  return registerPanel({
    id: FILE_SYSTEM_PANEL_ID,
    title: '文件系统',
    component: FileSystemPanel,
    defaultArea: 'left',
  })
}

export { FileSystemPanel } from './FileSystemPanel'
export { Menu } from './Menu'
export type { MenuItem } from './Menu'
export { defaultFsApi, createFsApi, FsApiError } from './api'
export * from './paths'
export * from './tree-model'
export * from './commands'
