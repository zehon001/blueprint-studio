/**
 * 预制体 tab 打开胶水（T7.3 · ADR-009；v3 T8.1 改走资产 dock 面板）
 *
 * 「编辑预制体」的统一入口：树面板右键 / 双击实例行、检视器「编辑预制体」按钮都走这里——
 * 经 openAssetPanel 打开该 .ui.json 为独立 UI 资产面板（标题取主名，如 'list-item'）。
 */
import { openAssetPanel } from '@/shell/dock/assetPanelModel'

/** 以 UI 编辑面板打开一个预制体（项目内相对路径，如 'ui/prefabs/list-item.ui.json'） */
export function openPrefabTab(assetPath: string): void {
  openAssetPanel('ui', assetPath)
}
