/**
 * Blueprint Studio v2 —— 主题 token（JS 侧，T0.8）
 *
 * 与 src/shell/theme/theme.css 一一对应：
 *   - `TOKENS` 是 TS 侧唯一真源：key = CSS 变量名，value = 原始值（hex / px / rgba）。
 *     Canvas 2D 等不支持 var() 的场景直接从这里取原始值（如 `TOKENS['--pin-float']`）。
 *   - 分组常量（COLORS / PIN_COLORS / ...）输出 `var(--xxx)` 引用，
 *     供 ReactFlow 节点、DOM、SVG 内联样式使用。
 *   - theme.test.ts 强制校验：theme.css 中同名 token 的值必须与 TOKENS 完全一致，
 *     修改任何色值请两处同步（CSS 注释里也标了用途与 UE 参考）。
 */

/**
 * 全部 token（key = CSS 变量名，value = 原始值）。
 * 顺序与 theme.css 保持一致，便于对照维护。
 */
export const TOKENS = {
  /* 基础层（Godot 深色编辑器） */
  '--bg-app': '#191919',
  '--bg-panel': '#1e1e1e',
  '--bg-panel-header': '#252525',
  '--bg-input': '#292929',
  '--bg-canvas': '#141414',
  '--border': '#2e2e2e',
  '--border-strong': '#3f3f3f',
  '--text': '#e0e0e0',
  '--text-dim': '#9e9e9e',
  '--text-disabled': '#5c5c5c',
  '--accent': '#4f8cc9',
  '--accent-hover': '#63a0dc',
  '--selection': 'rgba(79, 140, 201, 0.35)',
  '--focus-ring': '#7fb2e5',
  '--success': '#67c06b',
  '--warning': '#e2b34a',
  '--error': '#e05c5c',
  '--space-1': '4px',
  '--space-2': '8px',
  '--space-3': '12px',
  '--space-4': '16px',
  '--space-5': '20px',
  '--space-6': '24px',
  '--space-7': '32px',
  '--space-8': '40px',
  '--radius-sm': '3px',
  '--radius-md': '6px',
  '--font-xs': '11px',
  '--font-sm': '12px',
  '--font-md': '13px',
  '--font-lg': '15px',
  '--font-mono': "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
  '--font-ui': "'Segoe UI', 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  '--panel-header-h': '28px',
  '--toolbar-h': '36px',
  '--tab-h': '30px',

  /* 蓝图层（UE5 蓝图默认配色，PLAN §8.1） */
  '--pin-exec': '#f2f2f2',
  '--pin-bool': '#a41a1a',
  '--pin-int': '#008f8b',
  '--pin-float': '#5cff5c',
  '--pin-string': '#f050f0',
  '--pin-object': '#008cff',
  '--pin-any': '#9a9a9a',
  '--node-head-event': '#b12121',
  '--node-head-function': '#1573d6',
  '--node-head-pure': '#2f9e4f',
  '--node-head-flow': '#6a6a6a',
  '--node-head-plugin': '#8b3fbf',
  '--node-var-bg': '#262626',
  '--node-var-border': '#3d3d3d',
  '--edge-exec': '#f2f2f2',
  '--edge-data-default': '#9a9a9a',
  '--edge-selected': '#d4e157',
  '--bp-grid-dot': '#333333',
  '--bp-comment-bg': 'rgba(150, 150, 150, 0.1)',
  '--bp-comment-border': 'rgba(150, 150, 150, 0.38)',
  '--node-bg': '#1f1f1f',
  '--node-border': '#0f0f0f',
  '--node-selected': '#d8a03f',
  '--node-title-h': '32px',
} as const;

/** token 的 CSS 变量名（'--bg-app' | '--pin-exec' | ...） */
export type TokenName = keyof typeof TOKENS;

/** token 原始值（不经 var()，供 Canvas 2D 等无法使用 CSS 变量的场景） */
export function rawToken(name: TokenName): string {
  return TOKENS[name];
}

/** 引用 CSS 变量（分组常量的构造器） */
const v = (name: TokenName): string => `var(${name})`;

/* ============ 引脚色（UE5 标准，PLAN §8.1） ============ */

// TODO(T0.1): 等 '@/ir/types' 落地后，把 PinTypeName / PinTypeLike 替换为
// IR 的引脚类型（IRValueType），并删除本文件中的本地最小类型定义；
// pinColor 的数组类型展开逻辑保留。
/** 本地最小引脚类型名（对齐 UE5 标准引脚族；IR 类型落地前临时使用） */
export type PinTypeName = 'exec' | 'bool' | 'int' | 'float' | 'string' | 'object' | 'any';

/** 引脚色：key 对应引脚类型名，值为 CSS 变量引用 */
export const PIN_COLORS: Record<PinTypeName, string> = {
  exec: v('--pin-exec'),
  bool: v('--pin-bool'),
  int: v('--pin-int'),
  float: v('--pin-float'),
  string: v('--pin-string'),
  object: v('--pin-object'),
  any: v('--pin-any'),
};

/** pinColor 可接受的类型写法：基本类型、数组类型（如 'string[]'）或任意字符串（回退 any） */
export type PinTypeLike = PinTypeName | `${PinTypeName}[]` | (string & {});

const ARRAY_SUFFIX = '[]';

/**
 * 把引脚类型映射到对应引脚色 token。
 * - 数组类型（'string[]'、'int[][]'…）映射到元素类型的颜色（UE 同款：数组引脚继承元素色）；
 * - 'number' 按 IR 事件参数的历史别名归到 float（PLAN §5 示例）；
 * - 未知类型回退 any（灰，wildcard 语义）。
 */
export function pinColor(type: PinTypeLike): string {
  let base = type.trim();
  while (base.endsWith(ARRAY_SUFFIX)) {
    base = base.slice(0, -ARRAY_SUFFIX.length);
  }
  if (base === 'number') base = 'float';
  const key = (base in PIN_COLORS ? base : 'any') as PinTypeName;
  return PIN_COLORS[key];
}

/* ============ 节点头分类配色（PLAN §8.1） ============ */

/** 节点头分类配色；变量 Get/Set 为无头紧凑样式（varBg / varBorder） */
export const NODE_HEAD_COLORS = {
  event: v('--node-head-event'),
  function: v('--node-head-function'),
  pure: v('--node-head-pure'),
  flow: v('--node-head-flow'),
  plugin: v('--node-head-plugin'),
  varBg: v('--node-var-bg'),
  varBorder: v('--node-var-border'),
} as const;

/* ============ 连线（PLAN §8.1） ============ */

/** 连线颜色：exec 实线白；数据线按引脚色着色（dataDefault 为未着色 / wildcard 兜底） */
export const EDGE_COLORS = {
  exec: v('--edge-exec'),
  dataDefault: v('--edge-data-default'),
  selected: v('--edge-selected'),
} as const;

/* ============ 画布（蓝图） ============ */

/** 蓝图画布元素配色（画布底色见 COLORS.bgCanvas） */
export const CANVAS_COLORS = {
  gridDot: v('--bp-grid-dot'),
  commentBg: v('--bp-comment-bg'),
  commentBorder: v('--bp-comment-border'),
} as const;

/* ============ 节点体 ============ */

/** 节点体配色（节点头高度见 LAYOUT.nodeTitleH） */
export const NODE_COLORS = {
  bg: v('--node-bg'),
  border: v('--node-border'),
  selected: v('--node-selected'),
} as const;

/* ============ 基础层（Godot 深色编辑器） ============ */

/** 基础配色：背景层级 / 边框 / 文本 / 强调选中 / 状态 */
export const COLORS = {
  bgApp: v('--bg-app'),
  bgPanel: v('--bg-panel'),
  bgPanelHeader: v('--bg-panel-header'),
  bgInput: v('--bg-input'),
  bgCanvas: v('--bg-canvas'),
  border: v('--border'),
  borderStrong: v('--border-strong'),
  text: v('--text'),
  textDim: v('--text-dim'),
  textDisabled: v('--text-disabled'),
  accent: v('--accent'),
  accentHover: v('--accent-hover'),
  selection: v('--selection'),
  focusRing: v('--focus-ring'),
  success: v('--success'),
  warning: v('--warning'),
  error: v('--error'),
} as const;

/** 间距标尺（4px 基准）与圆角 */
export const SPACING = {
  space1: v('--space-1'),
  space2: v('--space-2'),
  space3: v('--space-3'),
  space4: v('--space-4'),
  space5: v('--space-5'),
  space6: v('--space-6'),
  space7: v('--space-7'),
  space8: v('--space-8'),
  radiusSm: v('--radius-sm'),
  radiusMd: v('--radius-md'),
} as const;

/** 字号与字体栈 */
export const FONTS = {
  xs: v('--font-xs'),
  sm: v('--font-sm'),
  md: v('--font-md'),
  lg: v('--font-lg'),
  mono: v('--font-mono'),
  ui: v('--font-ui'),
} as const;

/** 布局尺寸 */
export const LAYOUT = {
  panelHeaderH: v('--panel-header-h'),
  toolbarH: v('--toolbar-h'),
  tabH: v('--tab-h'),
  nodeTitleH: v('--node-title-h'),
} as const;
