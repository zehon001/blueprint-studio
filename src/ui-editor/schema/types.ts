/**
 * UI 节点库 schema 类型（T1.1 · PLAN §7.1）
 *
 * 本目录是 UI 节点库的声明式 schema 唯一来源：
 * - 检视器（T1.5）按 PropDef 纯 schema 驱动生成分组编辑器，不写任何节点特判；
 * - UI 树面板（T1.4）用 uiNodeSchemas / searchUISchemas 生成「添加节点」右键菜单，
 *   并按 defaultPropsFor 初始化新节点的 name / transform / props；
 * - DOM 渲染器（T1.2）按节点 type 分发渲染；List / Table / Tree 的数据结构约定见本文件；
 * - 事件面板（T5.2）读取 UINodeSchema.events 作为节点的内建事件清单。
 *
 * 存储结构（UINode / UITransform / UIAsset）以 src/ir/types.ts 为唯一真源（改动须走 ADR）；
 * 本文件只描述「有哪些属性、如何编辑、默认值是什么」。
 *
 * 公共属性与 UINode 存储的映射（T1.4 新建节点时按此拆分，见 defaultPropsFor）：
 * - name                        → UINode.name
 * - position / size / rotation  → UINode.transform.position / .size / .rotation
 * - visible / tooltip / expand  → UINode.props（渲染器 T1.2 读取）
 */
import type { ParamOption, Size2 } from '../../ir/types';

/** 下拉选项（复用 IR 契约的 ParamOption：select 型引脚 / 参数 / UI 属性共用同一结构） */
export type PropOption = ParamOption;

/** 属性编辑器种类（检视器 T1.5 据此渲染编辑控件；新增种类须同步检视器实现） */
export type UIPropType =
  /** 浮点数（数字输入框） */
  | 'number'
  /** 整数（数字输入框，步进 1） */
  | 'int'
  /** 单行文本 */
  | 'string'
  /** 布尔（勾选框） */
  | 'bool'
  /** 下拉选择（options 必填） */
  | 'select'
  /** 颜色（取色器，#RRGGBB） */
  | 'color'
  /** 多行文本（textarea） */
  | 'textarea'
  /** 二维向量 {x, y}（位置） */
  | 'vec2'
  /** 宽高 {w, h}（尺寸） */
  | 'size'
  /** 列表列定义（ListColumn[] 结构化编辑器，结构见 ListColumn） */
  | 'listColumns'
  /** 静态资源引用（assets/ 下文件的相对路径，文件选择器） */
  | 'assetRef'
  /** 逻辑资产引用（.bp.json / .ts / .py 相对路径，文件选择器） */
  | 'logicRef'
  /** 字符串数组（字符串列表编辑器，如 optionButton 的 items） */
  | 'options';

/** 单个属性的声明（检视器 T1.5 纯 schema 驱动的最小单元） */
export interface PropDef {
  /** 属性 id（写入 UINode.props / transform 的键；公共属性 id 见 COMMON_PROP_IDS） */
  id: string;
  /** 检视器显示名 */
  label: string;
  /** 编辑器种类 */
  type: UIPropType;
  /** 检视器分组名（展示顺序参考 PROP_GROUP_ORDER） */
  group: string;
  /** 默认值（新建节点初值；缺省由 defaultPropsFor 按类型补零值） */
  default?: unknown;
  /** 数值型最小值（number / int） */
  min?: number;
  /** 数值型最大值（number / int） */
  max?: number;
  /** 数值型步进 */
  step?: number;
  /** select 型选项（type = 'select' 时必填） */
  options?: PropOption[];
  /** 悬浮说明（检视器 tooltip / 帮助浮层） */
  doc?: string;
  /** 输入框占位灰字（string / textarea / assetRef 等） */
  placeholder?: string;
  /**
   * 检视器置灰展示（值可见但不可编辑）。
   * 典型：flow 布局节点的 position——父容器为流式布局时位置由容器接管；
   * schema 里的值只是「默认提示」，检视器应按实际父级（根节点 / 自由容器内）解锁。
   */
  disabled?: boolean;
}

/** 节点内建事件（事件面板 T5.2 展示与跳转；事件到逻辑资产的挂接由 T5.1 / T2.6 落地） */
export interface BuiltInEvent {
  /** 事件名（作为逻辑资产事件入口图的标识，如 'pressed'） */
  name: string;
  /** 显示名（如 '按下'） */
  label: string;
}

/** UI 节点分类（PLAN §7.1 四类；展示顺序见 NODE_CATEGORIES） */
export type UINodeCategory = '容器' | '显示' | '输入' | '数据';

/** UI 节点类型 schema（一个 UI 节点类型的完整声明） */
export interface UINodeSchema {
  /** 节点类型 id（小驼峰，如 'vbox'；UINode.type 的合法值） */
  type: string;
  /** 中文名（树面板 / 检视器 / 添加菜单显示） */
  title: string;
  /** 分类 */
  category: UINodeCategory;
  /** 字符图标（添加菜单 / 树面板前缀展示，emoji 亦可） */
  icon?: string;
  /** 属性声明（公共组 + 业务属性混合存放，检视器按 group 分组展示） */
  props: PropDef[];
  /** 内建事件清单（容器类允许为空数组，但必须显式声明） */
  events: BuiltInEvent[];
  /** 右键「添加子节点」提示策略：none = 叶子节点；container = 容器（可含子节点） */
  defaultChildPolicy?: 'none' | 'container';
  /** 右键搜索的模糊匹配关键词（searchUISchemas 用，可含中英文别名） */
  keywords?: string[];
}

/* ============================================================
 *  List / Table / Tree 的数据结构约定（T1.2 渲染器按此实现）
 * ============================================================ */

/** 值→颜色映射规则（List / Table 列着色；v1.1 'INFO=#3fc1a9' 文本色映射的结构化版本） */
export interface ColorRule {
  /** 比较算子：eq=相等 · contains=包含 · gt=大于 · lt=小于（数值化比较失败时回落字符串比较） */
  op: 'eq' | 'contains' | 'gt' | 'lt';
  /** 比较目标值（与单元格文本比较） */
  value: string;
  /** 命中时的颜色（#RRGGBB 等 CSS 颜色；渲染为徽标底色） */
  color: string;
}

/**
 * 列表列定义（list / table 节点 props.columns 的元素；继承 v1.1 UIListColumn 亮点设计）：
 * - colorRules：按序匹配给单元格着色（徽标样式）；
 * - groupBy：分组列——值变化时新起一个可折叠分组（全表至多一列开启，渲染器取第一个）；
 * - mergeDuplicates：合并列——相邻行该列值相同则合并成一条并计数（至多一列开启）。
 */
export interface ListColumn {
  /** 字段名（取行数据 row[field] 渲染） */
  field: string;
  /** 列标题（表头显示） */
  title: string;
  /** 列宽（px；省略 = 自动分配剩余宽度） */
  width?: number;
  /** 值→颜色映射规则（按序匹配，命中即用） */
  colorRules?: ColorRule[];
  /** 分组列（值变化新起可折叠分组） */
  groupBy?: boolean;
  /** 合并列（相邻重复值合并计数，点击可展开） */
  mergeDuplicates?: boolean;
}

/** 列表 / 表格行数据（props.items JSON 数组的元素；键 = ListColumn.field，值渲染时字符串化） */
export type UIListRow = Record<string, unknown>;

/** 树节点数据（tree 节点 props.items JSON 数组的元素，children 嵌套即层级） */
export interface UITreeItem {
  /** 显示文本 */
  label: string;
  /** 子节点（省略 = 叶子） */
  children?: UITreeItem[];
  /** 是否默认展开（省略 = 展开） */
  expanded?: boolean;
  /** 附加载荷（逻辑资产可读取的任意数据） */
  data?: unknown;
}

/* ============================================================
 *  公共属性组（所有节点 schema 自动包含）
 * ============================================================ */

/** 公共属性 id（commonProps 生成；name/position/size/rotation 映射 UINode 顶层与 transform 字段） */
export const COMMON_PROP_IDS = [
  'name',
  'position',
  'size',
  'rotation',
  'visible',
  'tooltip',
  'expand',
] as const;

/** 公共属性 id 字面量类型 */
export type CommonPropId = (typeof COMMON_PROP_IDS)[number];

/** 是否公共属性（检视器区分「节点公共组 / 业务属性」、T1.4 拆分 transform 用） */
export function isCommonProp(id: string): boolean {
  return (COMMON_PROP_IDS as readonly string[]).includes(id);
}

/** 检视器分组展示顺序（T1.5 按此排序；未列出的分组排在其后按出现序） */
export const PROP_GROUP_ORDER = ['节点', '布局', '内容', '外观', '行为', '数据'] as const;

/** 布局种类：free = 自由定位（根节点 / 自由容器内）；flow = 流式排列（父容器接管位置） */
export type LayoutKind = 'free' | 'flow';

/**
 * 生成公共属性组（每个节点 schema 的 props 头部自动展开）。
 * - kind = 'flow'：position 默认置灰（父容器为 VBox/HBox/Grid 等流式布局时由容器排列；
 *   节点为根或位于自由容器内时，检视器按实际父级解锁编辑）；
 * - expand 对应 v1.1 的 grow：在流式父容器内是否拉伸填充剩余空间，自由定位时无效。
 * @param kind 布局种类
 * @param defaultSize 新建节点默认尺寸（省略 = 120×32）
 */
export function commonProps(kind: LayoutKind, defaultSize?: Size2): PropDef[] {
  return [
    {
      id: 'name',
      label: '名称',
      type: 'string',
      group: '节点',
      default: '',
      doc: '树内唯一名，脚本 / 蓝图的 ui 访问器按键查找（ui.<name>）；新建时由 UI 树面板做唯一化',
    },
    {
      id: 'position',
      label: '位置',
      type: 'vec2',
      group: '布局',
      default: { x: 0, y: 0 },
      disabled: kind === 'flow',
      doc:
        kind === 'flow'
          ? '相对父节点位置（px）；父容器为流式布局（VBox/HBox/Grid 等）时由容器排列，为根节点或位于自由容器内时可编辑'
          : '相对父节点位置（px）',
    },
    {
      id: 'size',
      label: '尺寸',
      type: 'size',
      group: '布局',
      default: defaultSize ? { w: defaultSize.w, h: defaultSize.h } : { w: 120, h: 32 },
      doc: '宽高（px）；流式容器内可能被布局拉伸覆盖',
    },
    {
      id: 'rotation',
      label: '旋转',
      type: 'number',
      group: '布局',
      default: 0,
      min: -360,
      max: 360,
      step: 1,
      doc: '旋转角度（度，顺时针）',
    },
    {
      id: 'visible',
      label: '可见',
      type: 'bool',
      group: '节点',
      default: true,
      doc: '关闭后运行态不渲染（编辑态保留占位以便继续编辑）',
    },
    {
      id: 'tooltip',
      label: '悬停提示',
      type: 'string',
      group: '节点',
      default: '',
      doc: '鼠标悬停时的提示文本（运行态生效）',
    },
    {
      id: 'expand',
      label: '拉伸填充',
      type: 'bool',
      group: '布局',
      default: false,
      doc: '在 VBox/HBox/Grid 等流式父容器内是否拉伸填充剩余空间（对应 v1.1 grow）；自由定位时无效',
    },
  ];
}
