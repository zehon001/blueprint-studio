/**
 * 外壳状态栏共享状态（UI-REDESIGN P5）
 *
 * 只读视图状态：当前画布缩放比例由 UI 视口 / 蓝图画布上报，状态栏订阅显示。
 */
import { create } from 'zustand'

interface StatusState {
  /** 当前画布缩放（1 = 100%；null = 当前视图无缩放概念） */
  zoom: number | null
  setZoom: (zoom: number | null) => void
}

export const useStatusStore = create<StatusState>()((set) => ({
  zoom: null,
  setZoom: (zoom) => set({ zoom }),
}))
