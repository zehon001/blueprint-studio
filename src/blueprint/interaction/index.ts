/**
 * Blueprint Studio v2 —— 画布交互层导出入口（T2.2）
 *
 * - 纯函数（logic）/ 剪贴板桥（clipboard）：node:test 可直接单测；
 * - 组件与钩子：由 BlueprintEditorPanel（src/blueprint/index.ts）组装消费；
 * - T2.3 结构面板 / T2.4 检视器 / T2.7 注释框：复用 store 与 logic，
 *   T6.4 插件节点经 useBlueprintStore.setSpecs 注入搜索与兼容菜单。
 */
export * from './logic';
export { bpClipboard, readFragment, writeFragment } from './clipboard';
export { NodeSearchMenu, EdgeContextMenu, type NodeSearchMenuProps, type EdgeContextMenuProps } from './NodeSearchMenu';
export { PinDragMenu, type PinDragMenuProps } from './PinDragMenu';
export { SelectionToolbar, type SelectionToolbarProps } from './SelectionToolbar';
export { ValidationBar, type ValidationBarProps } from './ValidationBar';
export {
  useCanvasInteractions,
  type CanvasInteractionApis,
} from './useCanvasInteractions';
