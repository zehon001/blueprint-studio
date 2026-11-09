/**
 * 运行状态（纯蓝图工作流）
 *
 * 单实例：运行按钮只更新 target 与 nonce；RuntimeHost 以隐藏 iframe 承载执行，
 * 输出经 BroadcastChannel 进控制台面板。启动时顺带打开控制台面板，
 * 让运行输出立即可见（运行面板已移除，控制台是唯一输出界面）。
 */
import { create } from 'zustand'
import { useDockStore } from '@/shell/dock/store'

export interface RuntimeTarget {
  /** 项目文件夹名（FS API 安全根首段） */
  project: string
  /** 蓝图资产路径（项目内相对，如 logic/main.bp.json） */
  bp: string
}

interface RuntimeState {
  target: RuntimeTarget | null
  /** 重跑序号：每次打开/刷新自增；面板用它刷新 iframe src */
  nonce: number
  /** 打开/切换运行目标并聚焦运行面板 */
  openTarget: (target: RuntimeTarget) => void
  /** 同一目标重跑（刷新 / 保存后自动重跑） */
  rerun: () => void
  /** 清空目标（卸载隐藏运行宿主，中止运行） */
  clearTarget: () => void
}

export const useRuntimeStore = create<RuntimeState>()((set, get) => ({
  target: null,
  nonce: 0,
  openTarget: (target) => {
    set({ target, nonce: get().nonce + 1 })
    useDockStore.getState().openPanel('console', 'bottom')
  },
  rerun: () => set((s) => ({ nonce: s.nonce + 1 })),
  clearTarget: () => set({ target: null }),
}))
