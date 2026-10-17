/**
 * 数据类节点 schema（PLAN §7.1 · 数据 3 种）
 *
 * 数据类节点由逻辑资产在运行态写入行数据（ui 访问器），编辑态用 props.items 的
 * JSON 文本作为样例数据供渲染器展示；列结构与树结构约定见 types.ts（ListColumn /
 * UIListRow / UITreeItem）。
 *
 * list 的列定义继承 v1.1 亮点（UIListColumn）并结构化升级：
 * - v1.1 colorMap 文本（'INFO=#3fc1a9'）→ colorRules 结构化规则（op/value/color）；
 * - v1.1 group / merge 布尔 → groupBy / mergeDuplicates（语义不变，至多一列生效）。
 */
import { commonProps, type UINodeSchema } from './types';

export const DATA_SCHEMAS: UINodeSchema[] = [
  {
    type: 'list',
    title: '列表',
    category: '数据',
    icon: '☰',
    defaultChildPolicy: 'none',
    keywords: ['list', 'log', '列表', '日志'],
    props: [
      ...commonProps('flow', { w: 320, h: 240 }),
      {
        id: 'columns',
        label: '列定义',
        type: 'listColumns',
        group: '数据',
        default: [
          {
            field: 'level',
            title: '级别',
            width: 80,
            colorRules: [
              { op: 'eq', value: 'INFO', color: '#3fc1a9' },
              { op: 'eq', value: 'WARN', color: '#e5c07b' },
              { op: 'eq', value: 'ERROR', color: '#e06c75' },
            ],
          },
          { field: 'message', title: '内容', mergeDuplicates: true },
        ],
        doc: '列定义（继承 v1.1 亮点）：字段 / 标题 / 宽度 / 颜色映射 / 分组 / 合并重复，结构见 ListColumn；colorRules 按序匹配命中即着色，groupBy / mergeDuplicates 各至多一列生效',
      },
      {
        id: 'items',
        label: '行数据',
        type: 'textarea',
        group: '数据',
        default: '[]',
        placeholder: '[{"level":"INFO","message":"就绪"}]',
        doc: '行数据 JSON 数组（编辑期样例；每行为 { 字段: 值 } 对象，键对应 columns.field）。运行态由绑定的逻辑资产经 ui 访问器写入',
      },
    ],
    events: [
      { name: 'selectionChanged', label: '选中变更' },
      { name: 'doubleClicked', label: '双击行' },
    ],
  },
  {
    type: 'table',
    title: '表格',
    category: '数据',
    icon: '⊞',
    defaultChildPolicy: 'none',
    keywords: ['table', '表格', '数据表'],
    props: [
      ...commonProps('flow', { w: 400, h: 240 }),
      {
        id: 'columns',
        label: '列定义',
        type: 'listColumns',
        group: '数据',
        default: [
          { field: 'name', title: '名称', width: 160 },
          { field: 'value', title: '值', width: 120 },
        ],
        doc: '列定义（简化版：使用字段 / 标题 / 宽度；分组与合并在表格中不适用），结构见 ListColumn',
      },
      {
        id: 'items',
        label: '行数据',
        type: 'textarea',
        group: '数据',
        default: '[]',
        placeholder: '[{"name":"示例","value":1}]',
        doc: '行数据 JSON 数组（每行为 { 字段: 值 } 对象，键对应 columns.field）；运行态由逻辑资产写入',
      },
    ],
    events: [
      { name: 'selectionChanged', label: '选中变更' },
      { name: 'doubleClicked', label: '双击行' },
    ],
  },
  {
    type: 'tree',
    title: '树',
    category: '数据',
    icon: '🌲',
    defaultChildPolicy: 'none',
    keywords: ['tree', '树形', '层级'],
    props: [
      ...commonProps('flow', { w: 240, h: 240 }),
      {
        id: 'items',
        label: '树数据',
        type: 'textarea',
        group: '数据',
        default: '[{"label":"根节点","children":[{"label":"子节点 1"},{"label":"子节点 2"}]}]',
        placeholder: '[{"label":"节点","children":[…]}]',
        doc: '树数据 JSON 数组，元素结构 { label, children? }（children 嵌套即层级，见 UITreeItem）；运行态由逻辑资产写入',
      },
    ],
    events: [
      { name: 'selectionChanged', label: '选中变更' },
      { name: 'doubleClicked', label: '双击项' },
    ],
  },
];
