/**
 * Blueprint Studio v2 —— 运行时蓝图观察·编辑器侧公共出口（T5.4）
 *
 * BlueprintEditorPanel 只从这里 import：
 *  - useDebugOverlay：WS 订阅 + 批量折叠 hook；
 *  - DebugPinValues：端口实时值徽标层（画布 children 挂载，须在 ReactFlow 内）；
 *  - applyNodeOverlay / applyEdgeOverlay / buildInExecEdges：受控视图映射纯函数；
 *  - loadObserveEnabled / saveObserveEnabled：观察开关持久化。
 * CSS（debug.css）由面板统一引入（node:test 环境无法加载 .css）。
 */
export { useDebugOverlay } from './use-debug-overlay';
export type { UseDebugOverlayOptions, DebugOverlayApi } from './use-debug-overlay';
export { debugOverlayHandleMessage, ERROR_TOAST_DEDUPE_MS } from './use-debug-overlay';
export { DebugPinValues, formatPinValue } from './DebugPinValues';
export type { DebugPinValuesProps } from './DebugPinValues';
export {
  applyDebugEvents,
  applyNodeOverlay,
  applyEdgeOverlay,
  buildInExecEdges,
  decayOverlay,
  emptyOverlayState,
  isOverlayEmpty,
  HIGHLIGHT_TTL_MS,
  FLOW_TTL_MS,
  PIN_TTL_MS,
  ERROR_TTL_MS,
} from './overlay-state';
export type { DebugOverlayState, DebugHighlightKind, FoldContext } from './overlay-state';
export { loadObserveEnabled, saveObserveEnabled, OBSERVE_STORAGE_KEY } from './observe-toggle';
export type { ObserveStorageLike } from './observe-toggle';
