/**
 * 2D 视口模块出口（T1.3）
 *
 * - UIEditorPanel：视口面板组件（src/ui-editor/index.ts 再导出，供工作区 tab 挂载）；
 * - geometry：几何纯函数（命中 / 框选 / 坐标换算 / 吸附 / 对齐分布），检视器（T1.5）
 *   的批量对齐等场景可直接复用；
 * - commands：视口命令提交层（移动 / 删除 / 复制 / 添加 / 对齐；全部经 runUICommand
 *   入统一命令栈，label 前缀「视口：」）与树工具（parentMap / 唯一名 / free 布局判定），
 *   UI 树面板（T1.4）的删除 / 复制应复用同一套命令，保证撤销语义一致。
 */
export { UIEditorPanel } from './UIEditorPanel';
export * from './geometry';
export * from './commands';
