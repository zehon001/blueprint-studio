/**
 * 统一选择协议（v3 T8.2 · PLAN §4.2）
 *
 * 编辑器面板在「激活 + 选择变化」时发布 SelectionDescriptor；检视器按
 * activePanelId + descriptor 分发到适配器。UI/蓝图仍直接读各自编辑器 store
 * 做属性编辑，descriptor 只承担「当前上下文是什么」。
 */
import { create } from 'zustand'

export type SelectionDescriptor =
  | { source: 'ui'; panelId: string; assetPath: string; nodeIds: string[] }
  | {
      source: 'blueprint'
      panelId: string
      assetPath: string
      graph: string
      nodeIds: string[]
      edgeIds: string[]
    }
  | { source: 'file'; path: string; name: string; kind: 'file' | 'dir'; ext: string }
  | {
      source: 'library'
      scope: 'builtin' | 'project'
      kind: 'element' | 'style' | 'function'
      name: string
      /** 库条目引用路径（@library/... 或项目相对路径） */
      path?: string
    }

interface SelectionState {
  selection: SelectionDescriptor | null
  /** 发布选择（编辑器调用） */
  publish: (selection: SelectionDescriptor) => void
  /** 清除（仅当当前 descriptor 来自该 source/panel，避免误清新选择） */
  clear: (source: SelectionDescriptor['source'], panelId?: string) => void
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  selection: null,
  publish: (selection) => set({ selection }),
  clear: (source, panelId) => {
    const cur = get().selection
    if (!cur || cur.source !== source) return
    if (panelIdMismatch(cur, panelId)) return
    set({ selection: null })
  },
}))

/** 判断 descriptor 是否属于指定面板（无 panelId 参数时只按 source） */
function panelIdMismatch(sel: SelectionDescriptor, panelId?: string): boolean {
  if (!panelId) return false
  if (sel.source === 'ui' || sel.source === 'blueprint') return sel.panelId !== panelId
  return false
}

/** 当前 descriptor 是否对应面板（检视器分发用） */
export function selectionOfPanel(
  selection: SelectionDescriptor | null,
  panelId: string | null | undefined,
): SelectionDescriptor | null {
  if (!selection || !panelId) return null
  if (selection.source === 'ui' || selection.source === 'blueprint') {
    return selection.panelId === panelId ? selection : null
  }
  return selection
}
