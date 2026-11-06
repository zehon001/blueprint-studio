/**
 * 内置运行视图状态（纯蓝图工作流）
 *
 * 单实例：运行按钮只更新 target 与 nonce，并把 `runtime` 面板打开/聚焦到中央组；
 * 面板以 iframe 承载（embed=1），nonce 变化即重跑（更新 iframe src，不双开）。
 */
import { create } from 'zustand'
import { useDockStore } from '@/shell/dock/store'

export interface RuntimeTarget {
  /** 项目文件夹名（FS API 安全根首段） */
  project: string
  /** 蓝图资产路径（项目内相对，如 logic/main.bp.json） */
  bp: string
}

export const RUNTIME_PANEL_ID = 'runtime'

interface RuntimeState {
  target: RuntimeTarget | null
  /** 重跑序号：每次打开/刷新自增；面板用它刷新 iframe src */
  nonce: number
  /** 打开/切换运行目标并聚焦运行面板 */
  openTarget: (target: RuntimeTarget) => void
  /** 同一目标重跑（刷新 / 保存后自动重跑） */
  rerun: () => void
  /** 清空目标（关闭运行面板内容；面板本身可保留） */
  clearTarget: () => void
}

export const useRuntimeStore = create<RuntimeState>()((set, get) => ({
  target: null,
  nonce: 0,
  openTarget: (target) => {
    set({ target, nonce: get().nonce + 1 })
    useDockStore.getState().openPanel(RUNTIME_PANEL_ID, 'center')
  },
  rerun: () => set((s) => ({ nonce: s.nonce + 1 })),
  clearTarget: () => set({ target: null }),
}))
