/**
 * 控制台面板轻量 UI 总线
 *
 * 清空按钮已移入 dock 面板标签栏；DockShell 通过 requestClear 通知面板清空显示。
 */
import { create } from 'zustand'

interface ConsoleUiState {
  /** 清空请求序号（每次自增，面板订阅后清空 rows） */
  clearSeq: number
  requestClear: () => void
}

export const useConsoleUiStore = create<ConsoleUiState>()((set) => ({
  clearSeq: 0,
  requestClear: () => set((s) => ({ clearSeq: s.clearSeq + 1 })),
}))
