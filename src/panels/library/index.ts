/**
 * 资源库/元素库出口（v3 M11）
 *
 * 组件文件不 import CSS；样式在入口引入。
 */
import { registerPanel, type PanelApi } from '@/shell/dock/registry'
import { LibraryPanel } from './LibraryPanel'
import './library.css'

/** 注册资源库 dock 面板（默认不在布局，「面板 ▾」打开；T11.5） */
export function registerLibraryPanel(): PanelApi {
  return registerPanel({
    id: 'library',
    title: '资源库',
    component: LibraryPanel,
    defaultArea: 'left',
  })
}

export { ElementLibraryPanel, ELEMENT_DIR } from './ElementLibraryPanel'
export { StyleLibraryPanel } from './StyleLibraryPanel'
export { LibraryPanel } from './LibraryPanel'
export type { LibraryKind } from './api'
