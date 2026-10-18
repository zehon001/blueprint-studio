/**
 * UI 节点库注册表与查询 API（T1.1 · PLAN §7.1）
 *
 * 消费方式：
 * - T1.4 UI 树面板 / 右键添加菜单：按 NODE_CATEGORIES 分组遍历 uiNodeSchemas；
 *   searchUISchemas(keyword) 做模糊搜索；新建节点用 defaultPropsFor(type) 初始化：
 *
 *     const all = defaultPropsFor(type);            // 公共组 + 业务属性（深拷贝，可放心改写）
 *     const { name, position, size, rotation, ...props } = all;
 *     const node: UINode = {
 *       id, name, type,
 *       transform: { position, size, rotation },
 *       theme: {}, props, events: [], children: [],
 *     };
 *     // name 只是类型名初值（如 'button'），树内唯一化（重名追加序号）由树面板负责。
 *
 * - T1.5 检视器：getUISchema(type).props 按 group 分组（顺序参考 PROP_GROUP_ORDER）渲染编辑器；
 *   isCommonProp 区分公共组 / 业务属性；PropDef.disabled 置灰（flow 节点的 position
 *   可按实际父级解锁）；defaultPropsFor 提供多选混合态的基准值。
 * - T1.2 渲染器：uiSchemaMap 查 schema；defaultPropsFor 补全缺省 props；expand 等公共
 *   props 参与布局；List/Tree 数据结构见 types.ts 的 ListColumn / UITreeItem。
 */
import type { PropDef, UINodeSchema } from './types';
import { CONTAINER_SCHEMAS } from './containers';
import { DISPLAY_SCHEMAS } from './display';
import { INPUT_SCHEMAS } from './inputs';
import { DATA_SCHEMAS } from './data';

export * from './types';

/** 节点分类常量（顺序：容器 / 显示 / 输入 / 数据——树面板与添加菜单的分组顺序） */
export const NODE_CATEGORIES = ['容器', '显示', '输入', '数据'] as const;

/**
 * v3 T12.4：23 种基础控件的对外 trait。
 * text = 可设置文本；value = 可读写值；items = 列表/树/表格数据；
 * 容器类不声明（元素实例可通过 ElementAsset.traits 自行声明）。
 */
export const UI_TYPE_TRAITS: Readonly<Record<string, readonly string[]>> = {
  label: ['text'],
  richText: ['text'],
  markdown: ['text'],
  button: ['text'],
  checkBox: ['text', 'value'],
  lineEdit: ['text', 'value'],
  textArea: ['text', 'value'],
  spinBox: ['value'],
  slider: ['value'],
  progressBar: ['value'],
  list: ['items'],
  tree: ['items'],
  table: ['items'],
  comboBox: ['value', 'items', 'text'],
  optionButton: ['value', 'items', 'text'],
};

/** 按类型取 trait 列表（未声明 = 空） */
export function uiTraitsForType(type: string): string[] {
  return [...(UI_TYPE_TRAITS[type] ?? [])];
}

/** 全部 UI 节点 schema 注册表（PLAN §7.1 四类 23 种，顺序 = 分类顺序 → 定义顺序） */
export const uiNodeSchemas: UINodeSchema[] = [
  ...CONTAINER_SCHEMAS,
  ...DISPLAY_SCHEMAS,
  ...INPUT_SCHEMAS,
  ...DATA_SCHEMAS,
];
for (const schema of uiNodeSchemas) {
  if (!schema.traits) schema.traits = uiTraitsForType(schema.type);
}

/**
 * v3 T12.6：可反射属性白名单（右键「设计器」Get/Set 条目来源）。
 * 只暴露内容/值/数据类属性；布局/内部生命周期字段不反射。
 */
export const UI_REFLECT_PROPS: Readonly<Record<string, readonly string[]>> = {
  label: ['text'],
  richText: ['text'],
  markdown: ['text'],
  button: ['text'],
  checkBox: ['text', 'checked'],
  lineEdit: ['text', 'value', 'placeholder'],
  textArea: ['text', 'value', 'placeholder'],
  spinBox: ['value'],
  slider: ['value'],
  progressBar: ['value'],
  list: ['items'],
  tree: ['items'],
  table: ['items'],
  comboBox: ['value', 'items'],
  optionButton: ['value', 'items'],
};
for (const schema of uiNodeSchemas) {
  const reflect = UI_REFLECT_PROPS[schema.type] ?? [];
  for (const def of schema.props) {
    if (!def.reflect && reflect.includes(def.id)) def.reflect = true;
  }
}

/** type → schema 映射（渲染器 / 检视器热路径查询用） */
export const uiSchemaMap: ReadonlyMap<string, UINodeSchema> = new Map(
  uiNodeSchemas.map((s) => [s.type, s]),
);

/** 按类型查 schema；未注册类型返回 undefined */
export function getUISchema(type: string): UINodeSchema | undefined {
  return uiSchemaMap.get(type);
}

/** PropDef 未声明 default 时的类型零值（兜底；内置 schema 全部显式声明了默认值） */
function zeroPropValue(def: PropDef): unknown {
  switch (def.type) {
    case 'number':
    case 'int':
      return 0;
    case 'string':
    case 'textarea':
    case 'color':
    case 'assetRef':
    case 'logicRef':
      return '';
    case 'bool':
      return false;
    case 'select':
      return def.options?.[0]?.value ?? '';
    case 'vec2':
      return { x: 0, y: 0 };
    case 'size':
      return { w: 0, h: 0 };
    case 'listColumns':
    case 'options':
      return [];
    default:
      return null;
  }
}

/**
 * 生成新建节点的完整默认属性（公共组 + 业务属性；含公共组）。
 * 每次调用返回全新深拷贝，调用方可直接改写（如 name 唯一化）而互不影响。
 * 返回值需按 types.ts 头部注释拆分：name / position / size / rotation 进 UINode 顶层
 * 与 transform，其余进 UINode.props。未知类型返回空对象。
 */
export function defaultPropsFor(type: string): Record<string, unknown> {
  const schema = getUISchema(type);
  const out: Record<string, unknown> = {};
  if (!schema) return out;
  for (const def of schema.props) {
    out[def.id] = def.default !== undefined ? structuredClone(def.default) : zeroPropValue(def);
  }
  // name 给类型名初值（如新建 button → 'button'）；树内唯一化由 UI 树面板负责
  if (out.name === '') out.name = schema.type;
  return out;
}

/**
 * 右键添加面板的模糊搜索：匹配 type / title / keywords / category（大小写不敏感的包含匹配）。
 * 空白关键字返回全部 schema（按注册表顺序）。
 */
export function searchUISchemas(keyword: string): UINodeSchema[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [...uiNodeSchemas];
  return uiNodeSchemas.filter(
    (s) =>
      s.type.toLowerCase().includes(kw) ||
      s.title.toLowerCase().includes(kw) ||
      s.category.toLowerCase().includes(kw) ||
      (s.keywords ?? []).some((k) => k.toLowerCase().includes(kw)),
  );
}
