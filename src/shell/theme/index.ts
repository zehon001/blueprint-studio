/**
 * Blueprint Studio v2 —— 主题系统统一导出（T0.8）
 *
 * - 样式表 theme.css 由 dock 外壳（T0.3）负责 import 挂载，当前无入口引用属预期；
 * - JS 侧（ReactFlow / Canvas / SVG 内联样式）一律从本目录取 token；
 * - Canvas 2D 等不支持 var() 的场景用 rawToken() / TOKENS 取原始值。
 */
export * from './tokens';
