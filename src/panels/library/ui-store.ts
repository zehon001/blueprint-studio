/**
 * 资源库 UI 状态（编辑菜单接线）
 *
 * 导入 / 导出 / 新建弹窗与导入冲突策略收归顶栏「编辑 → 资源库」菜单后，
 * 面板本身不再持有这些操作；本 store 是菜单（Toolbar）、弹窗（LibraryModals）、
 * 面板（LibraryPanel）三方共享的轻量总线：
 *   - modal / policy：弹窗开关与冲突策略；
 *   - version：库内容在面板外被改动（新建 / 重命名 / 删除 / 导入）时自增，
 *     LibraryPanel 订阅后重载列表。
 */
import { create } from 'zustand'

export type LibraryImportPolicy = 'skip' | 'overwrite' | 'rename'
export type LibraryModalKind = 'import' | 'export' | 'create' | null

interface LibraryUiState {
  /** 当前打开的弹窗（null = 关闭） */
  modal: LibraryModalKind
  /** 导入冲突策略（编辑菜单「冲突处理」三级菜单设置；导入弹窗可改） */
  policy: LibraryImportPolicy
  /** 库内容版本号（面板外改动时自增，面板订阅重载） */
  version: number
  openModal: (modal: Exclude<LibraryModalKind, null>) => void
  closeModal: () => void
  setPolicy: (policy: LibraryImportPolicy) => void
  /** 通知面板库内容已变化 */
  bump: () => void
}

export const useLibraryUiStore = create<LibraryUiState>()((set) => ({
  modal: null,
  policy: 'skip',
  version: 0,
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: null }),
  setPolicy: (policy) => set({ policy }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}))
