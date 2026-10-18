/**
 * 元素 tab 打开胶水（v3 T11.3）
 *
 * 元素资产（.elem.json）复用 UI 编辑器（结构同 UIAsset；kind=element 保留），
 * 保存仍走 UI store 的整资产 PUT。`@library/*` 由资源库服务解析后再打开。
 */
import { openAssetPanel } from '@/shell/dock/assetPanelModel'

export function openElementTab(assetPath: string): void {
  openAssetPanel('element', assetPath)
}
