/**
 * Blueprint Studio v2 —— T7.6 性能阈值常量（全项目唯一集中点，调参只改这里）
 *
 * 运行时行为阈值（直接影响渲染策略，可按机器/产品需求调整）：
 *  - LIST_VIRTUAL_THRESHOLD / LIST_VIRTUAL_BUFFER / LIST_ROW_HEIGHT / LIST_GROUP_HEIGHT /
 *    LIST_VIRTUAL_VIEWPORT_FALLBACK：src/runtime/render/dataview.ts 的 list 虚拟滚动
 *    （> 阈值行数切换「只渲染可视区 ± 缓冲」的绝对定位行 + 总高占位）。
 *
 * 测试计时阈值不含在本文件：计时断言与图构造耦合、且必须写宽松值容忍机器差异，
 * 阈值与实测数字见 src/blueprint/view/perf.test.ts 与 src/runtime/render/virtual.test.ts 头注。
 */

/** list 虚拟滚动启用阈值：行数超过该值才切换虚拟滚动（≤ 该值保持经典全量渲染，
 * 分组/合并/rowspan 视觉与 T1.2/T1.7 完全一致；超过后走虚拟路径） */
export const LIST_VIRTUAL_THRESHOLD = 200;

/** list 虚拟滚动缓冲：可视区上/下各多渲染的行数（快速滚动预备，避免露白） */
export const LIST_VIRTUAL_BUFFER = 20;

/** list 虚拟模式的统一行高（px）：绝对定位需要确定高度；与 .bps-lcell 单行内容
 * 高度匹配（padding 2px + line-height 1.5 ≈ 24px）。列内容超行高会被单元格
 * overflow:hidden 裁剪（与经典模式的 nowrap 行为一致）。 */
export const LIST_ROW_HEIGHT = 24;

/** list 虚拟模式的组头槽高（px，groupBy 列的组头行） */
export const LIST_GROUP_HEIGHT = 24;

/** list 虚拟模式可视区高度兜底（px）：元素尚未布局（clientHeight=0——首次 patch
 * 时节点还未挂进 DOM / 测试环境无布局）按此估算可视窗口；挂载后首次滚动即自校正 */
export const LIST_VIRTUAL_VIEWPORT_FALLBACK = 320;
