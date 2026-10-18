/**
 * 设计模式 → 内嵌蓝图模式跳转桥（v3）
 *
 * 检视器 / 事件面板的「跳转」不直接依赖 UITab 内部 state：
 * 派发一个窗口事件，UITab 监听后切到蓝图模式、打开事件图并选中对应事件节点。
 */

export const UI_BLUEPRINT_REQUEST = 'bps:open-ui-blueprint'

export interface UIBlueprintRequestDetail {
  /** UI 资产路径；缺省由当前激活的 UI tab 自行匹配 */
  assetPath?: string
  /** 目标图名（缺省 'event'） */
  graph?: string
  /** 事件名（按 event.custom.params.eventName / title 匹配） */
  eventName?: string
  /** 直接定位节点 id */
  nodeId?: string
}

export function requestUIBlueprint(detail: UIBlueprintRequestDetail): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent<UIBlueprintRequestDetail>(UI_BLUEPRINT_REQUEST, { detail }))
}

export function onUIBlueprintRequest(
  handler: (detail: UIBlueprintRequestDetail) => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const listener = (e: Event): void => {
    handler((e as CustomEvent<UIBlueprintRequestDetail>).detail ?? {})
  }
  window.addEventListener(UI_BLUEPRINT_REQUEST, listener)
  return () => window.removeEventListener(UI_BLUEPRINT_REQUEST, listener)
}
