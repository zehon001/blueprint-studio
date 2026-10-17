/**
 * 预制体 tab 打开胶水（T7.3 · ADR-009）
 *
 * 「编辑预制体」的统一入口：树面板右键 / 双击实例行、检视器「编辑预制体」按钮都走这里——
 * 经工作区 openAsset 打开该 .ui.json 为新 UI tab（tab 标题取文件主干，如 'list-item'）。
 * 独立成模块避免两个面板互相依赖（只依赖 workspace-store 与 prefab 纯工具）。
 */
import { useWorkspaceStore } from '@/shell/workspace-store'
import { prefabLabelOf } from './prefab'

/** 以 UI 编辑 tab 打开一个预制体（项目内相对路径，如 'ui/prefabs/list-item.ui.json'） */
export function openPrefabTab(assetPath: string): void {
  useWorkspaceStore.getState().openAsset({
    kind: 'ui',
    assetPath,
    title: prefabLabelOf(assetPath),
  })
}
