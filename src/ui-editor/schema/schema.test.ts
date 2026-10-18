/**
 * UI 节点库 schema 测试（T1.1）
 *
 * 覆盖（任务卡 DoD / 单测清单）：
 * 1. PLAN §7.1 表全部 23 个节点类型已注册且分类正确
 * 2. 每个节点至少 1 个业务属性 + name/transform 公共组存在
 * 3. defaultPropsFor 生成值类型与 PropDef.type 匹配（全量校验，强于抽样）
 * 4. 内建事件清单：输入/数据类非空；容器/显示类显式声明（允许空数组）
 * 5. list 列定义（ListColumn）结构校验
 * 另含查询 API 行为与 commonProps 契约。
 *
 * 运行：npx tsx --test src/ui-editor/schema/schema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NODE_CATEGORIES,
  defaultPropsFor,
  getUISchema,
  searchUISchemas,
  uiNodeSchemas,
  uiSchemaMap,
  type ListColumn,
  type PropDef,
} from './index';
import { PROP_GROUP_ORDER, commonProps, isCommonProp } from './types';

/** PLAN §7.1 表：type → 期望分类（23 种） */
const EXPECTED_NODES: readonly (readonly [string, string])[] = [
  ['vbox', '容器'],
  ['hbox', '容器'],
  ['grid', '容器'],
  ['panel', '容器'],
  ['scrollBox', '容器'],
  ['tabContainer', '容器'],
  ['splitContainer', '容器'],
  ['label', '显示'],
  ['richText', '显示'],
  ['markdown', '显示'],
  ['image', '显示'],
  ['separator', '显示'],
  ['progressBar', '显示'],
  ['button', '输入'],
  ['checkBox', '输入'],
  ['lineEdit', '输入'],
  ['textEdit', '输入'],
  ['optionButton', '输入'],
  ['slider', '输入'],
  ['spinBox', '输入'],
  ['list', '数据'],
  ['table', '数据'],
  ['tree', '数据'],
];

/** 公共属性 id → 期望编辑器类型 */
const COMMON_TYPES: Record<string, string> = {
  name: 'string',
  position: 'vec2',
  size: 'size',
  rotation: 'number',
  visible: 'bool',
  tooltip: 'string',
  expand: 'bool',
};

/** 公共属性 id → 期望检视器分组 */
const COMMON_GROUPS: Record<string, string> = {
  name: '节点',
  visible: '节点',
  tooltip: '节点',
  position: '布局',
  size: '布局',
  rotation: '外观',
  expand: '布局',
};

/** 任务卡规定的内建事件清单（type → 事件名集合；未列出的节点不作集合断言） */
const EXPECTED_EVENTS: Record<string, readonly string[]> = {
  button: ['pressed'],
  checkBox: ['toggled'],
  lineEdit: ['textChanged', 'submit'],
  textEdit: ['textChanged'],
  optionButton: ['selectedChanged'],
  slider: ['valueChanged'],
  spinBox: ['valueChanged'],
  list: ['selectionChanged', 'doubleClicked'],
  table: ['selectionChanged', 'doubleClicked'],
  tree: ['selectionChanged', 'doubleClicked'],
  panel: ['mouseEnter', 'mouseLeave'],
};

/** ListColumn 结构校验（字段/标题必填，规则字段类型正确，颜色映射 op 与颜色合法） */
function assertListColumn(col: unknown, where: string): void {
  const c = col as ListColumn;
  assert.equal(typeof c.field, 'string', `${where}.field 为字符串`);
  assert.ok(c.field.length > 0, `${where}.field 非空`);
  assert.equal(typeof c.title, 'string', `${where}.title 为字符串`);
  assert.ok(c.title.length > 0, `${where}.title 非空`);
  if (c.width !== undefined) assert.equal(typeof c.width, 'number', `${where}.width 为数值`);
  if (c.groupBy !== undefined) assert.equal(typeof c.groupBy, 'boolean', `${where}.groupBy 为布尔`);
  if (c.mergeDuplicates !== undefined) {
    assert.equal(typeof c.mergeDuplicates, 'boolean', `${where}.mergeDuplicates 为布尔`);
  }
  if (c.colorRules !== undefined) {
    assert.ok(Array.isArray(c.colorRules), `${where}.colorRules 为数组`);
    c.colorRules.forEach((rule, i) => {
      const rw = `${where}.colorRules[${i}]`;
      assert.ok(['eq', 'contains', 'gt', 'lt'].includes(rule.op), `${rw}.op 为合法算子`);
      assert.equal(typeof rule.value, 'string', `${rw}.value 为字符串`);
      assert.ok(rule.value.length > 0, `${rw}.value 非空`);
      assert.equal(typeof rule.color, 'string', `${rw}.color 为字符串`);
      assert.match(rule.color, /^#[0-9a-fA-F]{3,8}$/, `${rw}.color 为颜色值`);
    });
  }
}

/** defaultPropsFor 生成值与 PropDef.type 的匹配校验 */
function assertValueMatchesType(def: PropDef, value: unknown, where: string): void {
  switch (def.type) {
    case 'number':
      assert.equal(typeof value, 'number', where);
      break;
    case 'int':
      assert.equal(typeof value, 'number', where);
      assert.ok(Number.isInteger(value), `${where}（int 须为整数）`);
      break;
    case 'string':
    case 'textarea':
    case 'color':
    case 'assetRef':
    case 'logicRef':
      assert.equal(typeof value, 'string', where);
      break;
    case 'bool':
      assert.equal(typeof value, 'boolean', where);
      break;
    case 'select':
      assert.equal(typeof value, 'string', where);
      assert.ok(
        def.options?.some((o) => o.value === value),
        `${where}（select 值必须在 options 内）`,
      );
      break;
    case 'vec2': {
      const v = value as { x?: unknown; y?: unknown } | null;
      assert.equal(typeof v?.x, 'number', `${where}.x`);
      assert.equal(typeof v?.y, 'number', `${where}.y`);
      break;
    }
    case 'size': {
      const v = value as { w?: unknown; h?: unknown } | null;
      assert.equal(typeof v?.w, 'number', `${where}.w`);
      assert.equal(typeof v?.h, 'number', `${where}.h`);
      break;
    }
    case 'listColumns': {
      assert.ok(Array.isArray(value), `${where} 为数组`);
      (value as unknown[]).forEach((col, i) => assertListColumn(col, `${where}[${i}]`));
      break;
    }
    case 'options': {
      assert.ok(Array.isArray(value), `${where} 为数组`);
      (value as unknown[]).forEach((it, i) => assert.equal(typeof it, 'string', `${where}[${i}]`));
      break;
    }
  }
}

/* ── 1. 注册表完整性 ─────────────────────────────────────────── */

test('§7.1 表全部 23 个节点类型已注册且分类正确', () => {
  assert.equal(uiNodeSchemas.length, EXPECTED_NODES.length, '注册表恰好含 §7.1 的 23 种节点');
  assert.deepEqual([...NODE_CATEGORIES], ['容器', '显示', '输入', '数据'], '分类常量顺序正确');
  assert.equal(uiSchemaMap.size, EXPECTED_NODES.length, 'uiSchemaMap 与注册表一致');

  const types = new Set(uiNodeSchemas.map((s) => s.type));
  assert.equal(types.size, uiNodeSchemas.length, '节点 type 不得重复');

  for (const [type, category] of EXPECTED_NODES) {
    const schema = getUISchema(type);
    assert.ok(schema, `节点 ${type} 已注册`);
    assert.equal(schema?.category, category, `节点 ${type} 分类为「${category}」`);
    assert.ok(schema?.title.length, `节点 ${type} 有中文标题`);
    assert.ok(schema?.icon, `节点 ${type} 有图标`);
    assert.ok(schema?.defaultChildPolicy, `节点 ${type} 显式声明 defaultChildPolicy`);
  }

  for (const schema of uiNodeSchemas) {
    assert.ok(
      (NODE_CATEGORIES as readonly string[]).includes(schema.category),
      `${schema.type} 分类 ${schema.category} 属于四类之一`,
    );
    assert.ok(
      schema.defaultChildPolicy === 'none' || schema.defaultChildPolicy === 'container',
      `${schema.type} defaultChildPolicy 合法`,
    );
  }
});

/* ── 2. 属性声明完整性 ───────────────────────────────────────── */

test('每个节点至少 1 个业务属性 + name/transform 公共组存在', () => {
  const commonIds = ['name', 'position', 'size', 'rotation', 'visible', 'tooltip', 'expand'];
  for (const schema of uiNodeSchemas) {
    const ids = schema.props.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, `${schema.type} 属性 id 不重复`);

    // 公共组：id 齐全、类型与分组正确
    for (const id of commonIds) {
      const def = schema.props.find((p) => p.id === id);
      assert.ok(def, `${schema.type} 含公共属性 ${id}`);
      assert.equal(def?.type, COMMON_TYPES[id], `${schema.type}.${id} 编辑器类型正确`);
      assert.equal(def?.group, COMMON_GROUPS[id], `${schema.type}.${id} 分组正确`);
      assert.ok(def?.label.length, `${schema.type}.${id} 有显示名`);
    }

    // 业务属性：至少 1 个（公共组之外的属性）
    const business = schema.props.filter((p) => !isCommonProp(p.id));
    assert.ok(business.length >= 1, `${schema.type} 至少 1 个业务属性`);

    // 每个属性：显示名 / 分组 / 默认值齐全；分组在推荐顺序内；select 有选项；数值默认值在界内
    for (const def of schema.props) {
      const where = `${schema.type}.${def.id}`;
      assert.ok(def.label.length > 0, `${where} 有显示名`);
      assert.ok(def.group.length > 0, `${where} 有分组`);
      assert.ok(
        (PROP_GROUP_ORDER as readonly string[]).includes(def.group),
        `${where} 分组「${def.group}」在推荐顺序表内`,
      );
      assert.ok(def.default !== undefined, `${where} 有默认值`);
      assert.ok(def.doc && def.doc.length > 0, `${where} 有悬浮说明`);
      if (def.type === 'select') {
        assert.ok((def.options?.length ?? 0) > 0, `${where}（select）有选项`);
      }
      if (
        (def.type === 'number' || def.type === 'int') &&
        typeof def.default === 'number'
      ) {
        if (def.min !== undefined) assert.ok(def.default >= def.min, `${where} 默认值 ≥ min`);
        if (def.max !== undefined) assert.ok(def.default <= def.max, `${where} 默认值 ≤ max`);
      }
    }
  }

  // 容器类（free）position 默认可编辑；非容器（flow）position 默认置灰（流式布局接管）
  for (const schema of uiNodeSchemas) {
    const pos = schema.props.find((p) => p.id === 'position');
    if (schema.category === '容器') {
      assert.notEqual(pos?.disabled, true, `容器 ${schema.type} 的 position 默认可编辑`);
    } else {
      assert.equal(pos?.disabled, true, `非容器 ${schema.type} 的 position 默认置灰`);
    }
  }
});

/* ── 3. defaultPropsFor ──────────────────────────────────────── */

test('defaultPropsFor 生成值类型与 PropDef.type 全量匹配', () => {
  for (const schema of uiNodeSchemas) {
    const props = defaultPropsFor(schema.type);
    assert.equal(
      Object.keys(props).length,
      schema.props.length,
      `${schema.type} 默认属性覆盖全部声明（含公共组）`,
    );
    for (const def of schema.props) {
      assertValueMatchesType(def, props[def.id], `${schema.type}.${def.id}(${def.type})`);
    }
  }
});

test('defaultPropsFor 深拷贝隔离 + name 初值 + 未知类型', () => {
  // name 初值 = 类型名（树内唯一化由 UI 树面板负责）
  assert.equal(defaultPropsFor('button').name, 'button');

  // 深拷贝：改动返回值不影响后续调用（嵌套对象 / 数组均隔离）
  const a = defaultPropsFor('list');
  (a.columns as ListColumn[])[0].field = 'MUTATED';
  (a.position as { x: number }).x = 999;
  const b = defaultPropsFor('list');
  assert.equal((b.columns as ListColumn[])[0].field, 'level');
  assert.equal((b.position as { x: number }).x, 0);
  assert.equal(b.items, '[]');

  // 未知类型返回空对象
  assert.deepEqual(defaultPropsFor('no-such-node'), {});
});

/* ── 4. 内建事件清单 ─────────────────────────────────────────── */

test('内建事件清单：输入/数据类非空，容器/显示类显式声明，与任务卡一致', () => {
  for (const schema of uiNodeSchemas) {
    assert.ok(Array.isArray(schema.events), `${schema.type} events 显式声明（可为空数组）`);
    for (const ev of schema.events) {
      assert.ok(ev.name.length > 0 && ev.label.length > 0, `${schema.type} 事件含 name/label`);
    }
    if (schema.category === '输入' || schema.category === '数据') {
      assert.ok(schema.events.length >= 1, `${schema.type}（${schema.category}）事件清单非空`);
    }
    const expected = EXPECTED_EVENTS[schema.type];
    if (expected) {
      assert.deepEqual(
        schema.events.map((e) => e.name).sort(),
        [...expected].sort(),
        `${schema.type} 内建事件与任务卡一致`,
      );
    }
  }
  // 容器类显式为空（panel 除外：任务卡规定其拥有 mouseEnter/mouseLeave）
  for (const schema of uiNodeSchemas.filter((s) => s.category === '容器')) {
    if (schema.type !== 'panel') {
      assert.equal(schema.events.length, 0, `容器 ${schema.type} 无内建事件（显式空数组）`);
    }
  }
});

/* ── 5. list 列定义结构 ──────────────────────────────────────── */

test('list 列定义结构校验（ListColumn 继承 v1.1 亮点）', () => {
  const list = getUISchema('list');
  assert.ok(list, 'list 已注册');

  // columns 属性存在且为 listColumns 型
  const colDef = list?.props.find((p) => p.id === 'columns');
  assert.ok(colDef, 'list 有 columns 属性');
  assert.equal(colDef?.type, 'listColumns');
  assert.equal(colDef?.group, '数据');

  // 默认列定义结构完整（含颜色映射列 + 合并列）
  const cols = colDef?.default as ListColumn[];
  assert.ok(Array.isArray(cols) && cols.length >= 2, 'list 默认列定义非空');
  cols.forEach((col, i) => assertListColumn(col, `list.columns[${i}]`));

  // groupBy / mergeDuplicates 至多一列（渲染器只取第一个命中列，v1.1 语义）
  assert.ok(cols.filter((c) => c.groupBy).length <= 1, 'groupBy 至多一列');
  assert.ok(cols.filter((c) => c.mergeDuplicates).length <= 1, 'mergeDuplicates 至多一列');

  // 颜色映射规则（v1.1 亮点：值→颜色徽标）
  const levelCol = cols.find((c) => c.field === 'level');
  assert.ok(levelCol?.colorRules && levelCol.colorRules.length >= 1, '默认含值→颜色映射规则');
  const mergeCol = cols.find((c) => c.field === 'message');
  assert.equal(mergeCol?.mergeDuplicates, true, '默认含合并重复列');

  // 行数据样例：JSON 数组文本，可解析
  const itemsDef = list?.props.find((p) => p.id === 'items');
  assert.ok(itemsDef, 'list 有 items 属性');
  assert.equal(itemsDef?.type, 'textarea');
  const rows = JSON.parse(itemsDef?.default as string) as unknown[];
  assert.ok(Array.isArray(rows), 'list.items 默认值为 JSON 数组文本');

  // table / tree 的内容属性约定
  const table = getUISchema('table');
  assert.ok(table?.props.some((p) => p.id === 'columns'), 'table 有列定义');
  assert.equal(table?.props.find((p) => p.id === 'columns')?.type, 'listColumns');
  const tableRows = JSON.parse(table?.props.find((p) => p.id === 'items')?.default as string);
  assert.ok(Array.isArray(tableRows), 'table.items 为 JSON 数组文本');

  const tree = getUISchema('tree');
  assert.ok(!tree?.props.some((p) => p.id === 'columns'), 'tree 无列定义（用 items 嵌套结构）');
  const treeItems = JSON.parse(
    tree?.props.find((p) => p.id === 'items')?.default as string,
  ) as { label?: unknown; children?: unknown }[];
  assert.ok(Array.isArray(treeItems) && treeItems.length >= 1, 'tree.items 默认值可解析');
  for (const item of treeItems) {
    assert.equal(typeof item.label, 'string', 'tree 项有 label 字段');
    if (item.children !== undefined) assert.ok(Array.isArray(item.children), 'children 为数组');
  }
});

/* ── 6. 查询 API 行为 ────────────────────────────────────────── */

test('查询 API：getUISchema / searchUISchemas / commonProps', () => {
  assert.equal(getUISchema('no-such-node'), undefined);
  assert.equal(uiSchemaMap.get('vbox')?.type, 'vbox');

  // 搜索：空串返回全量；中文标题 / type / 关键词 / 分类可命中；大小写不敏感
  assert.equal(searchUISchemas('').length, EXPECTED_NODES.length);
  assert.ok(searchUISchemas('按钮').some((s) => s.type === 'button'), '中文标题可检索');
  assert.ok(searchUISchemas('vbox').some((s) => s.type === 'vbox'), 'type 可检索');
  assert.ok(searchUISchemas('VBOX').some((s) => s.type === 'vbox'), '搜索大小写不敏感');
  assert.ok(searchUISchemas('日志').some((s) => s.type === 'list'), '关键词可检索');
  assert.ok(searchUISchemas('数据').every((s) => s.category === '数据'), '分类可检索');
  assert.equal(searchUISchemas('不存在的节点xyz').length, 0);

  // commonProps 契约：flow 置灰 position；free 不置灰；defaultSize 生效
  const flow = commonProps('flow');
  assert.equal(flow.find((p) => p.id === 'position')?.disabled, true, 'flow 的 position 置灰');
  const free = commonProps('free', { w: 400, h: 300 });
  assert.notEqual(free.find((p) => p.id === 'position')?.disabled, true, 'free 的 position 可编辑');
  assert.deepEqual(free.find((p) => p.id === 'size')?.default, { w: 400, h: 300 });
  assert.ok(isCommonProp('name'), 'name 为公共属性');
  assert.ok(!isCommonProp('text'), 'text 非公共属性');
});
