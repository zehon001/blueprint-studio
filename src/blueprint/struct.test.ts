/**
 * Blueprint Studio v3.3 —— 结构体编辑链路单测（ADR-019）
 *
 * 覆盖：
 *  1. 类型/字段 CRUD（重名拒绝、自动字段名、可撤销）；
 *  2. 类型改名级联（变量 / 函数接口 / 事件参数 / 结构体字段 / struct 节点）；
 *  3. 字段改名 / 删除级联（struct.make/break 引脚与连线）；
 *  4. 动态引脚连线（connect 预检识别结构体字段）；
 *  5. 视图动态引脚 + 边缘类型着色；
 *  6. 类型选择器选项分组。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset } from '../ir/types';
import { builtinSpecMap } from '../nodes';
import { getDomainState, resetEditorStore, undo } from '../shell/commands';
import { useBlueprintStore } from './store/blueprint-store';
import { irToFlow } from './view/model';
import { isKnownTypeOption, typeOptionGroups, typeOptionLabel } from './type-picker';

/* ---------------- 工具 ---------------- */

function blank(): IRAsset {
  return {
    version: 3,
    name: '结构体资产',
    entry: 'main',
    graphs: { main: { nodes: [], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

function open(asset: IRAsset = blank()): void {
  resetEditorStore();
  useBlueprintStore.getState().openAsset(asset, 'logic/test.bp.json');
}

function domainAsset(): IRAsset {
  return getDomainState<{ asset: IRAsset }>('blueprint').asset;
}

function nodeById(id: string) {
  return domainAsset().graphs.main!.nodes.find((n) => n.id === id);
}

/* ============================================================
 * 1. 类型 / 字段 CRUD
 * ============================================================ */

test('store：新建结构体 / 字段（重名拒绝、自动字段名、可撤销）', () => {
  open();
  const st = useBlueprintStore.getState();
  assert.equal(st.addStructType('Row'), true);
  assert.equal(st.addStructType('row'), false, '类型名大小写不敏感去重');
  assert.equal(st.addStructField('Row', { name: 'level', type: 'string' }), 'level');
  assert.equal(st.addStructField('Row', { type: 'int' }), '字段', '未给名 → 字段');
  assert.deepEqual(
    domainAsset().types?.[0]?.fields.map((f) => [f.name, f.type]),
    [['level', 'string'], ['字段', 'int']],
  );
  undo();
  assert.deepEqual(domainAsset().types?.[0]?.fields.map((f) => f.name), ['level'], '添加字段可撤销');
});

/* ============================================================
 * 2. 类型改名级联
 * ============================================================ */

test('store：结构体改名级联变量 / 函数接口 / 事件参数 / 嵌套字段 / struct 节点', () => {
  const asset = blank();
  asset.variables = [{ name: 'rows', type: 'Row[]' }];
  asset.events = [{ name: 'loaded', params: [{ name: 'row', type: 'Row' }] }];
  asset.types = [
    { name: 'Row', fields: [{ name: 'level', type: 'string' }] },
    { name: 'Wrap', fields: [{ name: 'row', type: 'Row' }, { name: 'rows', type: 'Row[]' }] },
  ];
  asset.graphs.main!.params = [{ name: 'input', type: 'Row' }];
  asset.graphs.main!.nodes = [
    {
      id: 'mk',
      type: 'struct.make',
      params: { typeName: 'Row' },
      pinDefaults: {},
      position: { x: 0, y: 0 },
    },
  ];
  open(asset);
  const st = useBlueprintStore.getState();
  assert.equal(st.renameStructType('Row', 'Record'), true);
  const next = domainAsset();
  assert.equal(next.types?.[0]?.name, 'Record');
  assert.equal(next.variables[0]?.type, 'Record[]');
  assert.equal(next.events[0]?.params[0]?.type, 'Record');
  assert.equal(next.graphs.main?.params?.[0]?.type, 'Record');
  assert.deepEqual(
    next.types?.[1]?.fields.map((f) => f.type),
    ['Record', 'Record[]'],
    '其他结构体字段类型级联',
  );
  assert.equal(next.graphs.main?.nodes[0]?.params?.['typeName'], 'Record', '结构体节点类型级联');
  undo();
  assert.equal(domainAsset().types?.[0]?.name, 'Row', '改名可撤销');
});

/* ============================================================
 * 3. 字段改名 / 删除级联
 * ============================================================ */

test('store：字段改名/删除级联 struct.make/break 引脚与连线', () => {
  open();
  const st = useBlueprintStore.getState();
  st.addStructType('Row');
  st.addStructField('Row', { name: 'level', type: 'string' });
  const makeId = st.insertStructMakeNode('Row');
  const breakId = st.insertStructBreakNode('Row');
  const printId = st.addNode('system.print', { x: 200, y: 0 });
  assert.ok(makeId && breakId && printId);
  assert.equal(nodeById(makeId!)?.params?.['typeName'], 'Row');
  assert.equal(nodeById(breakId!)?.params?.['typeName'], 'Row');

  // 动态引脚连线：make.value → break.value；break.level → print.value
  assert.equal(st.connect({ node: makeId!, pin: 'value' }, { node: breakId!, pin: 'value' }), true);
  assert.equal(st.connect({ node: breakId!, pin: 'level' }, { node: printId!, pin: 'value' }), true);

  st.updateStructField('Row', 0, { name: 'lvl' });
  const renamed = domainAsset().graphs.main!.edges.find(
    (e) => e.from.node === breakId && e.from.pin === 'lvl',
  );
  assert.ok(renamed, '字段改名后 break 输出脚 / 连线同步');
  assert.equal(
    domainAsset().graphs.main!.edges.some((e) => e.from.node === breakId && e.from.pin === 'level'),
    false,
  );

  st.removeStructField('Row', 0);
  assert.equal(
    domainAsset().graphs.main!.edges.some((e) => e.from.node === breakId),
    false,
    '删除字段后该输出脚连线一并移除',
  );
});

/* ============================================================
 * 4. 删除保护
 * ============================================================ */

test('store：结构体仍被节点引用时拒绝删除；移除节点后可删', () => {
  open();
  const st = useBlueprintStore.getState();
  st.addStructType('Row');
  const makeId = st.insertStructMakeNode('Row');
  assert.ok(makeId);
  assert.equal(st.removeStructType('Row'), false, '被 struct 节点引用时拒绝删除');
  st.setSelection({ nodeIds: [makeId!], edgeIds: [] });
  st.deleteSelection();
  assert.equal(st.removeStructType('Row'), true);
  assert.equal(domainAsset().types, undefined, '最后一个类型删除后不保留空 types');
});

/* ============================================================
 * 5. 视图动态引脚
 * ============================================================ */

test('irToFlow：结构体节点动态引脚 + 边缘类型着色', () => {
  const asset = blank();
  asset.types = [
    {
      name: 'Row',
      fields: [
        { name: 'level', type: 'string', default: 'INFO' },
        { name: 'count', type: 'int' },
      ],
    },
  ];
  asset.graphs.main!.nodes = [
    { id: 'mk', type: 'struct.make', params: { typeName: 'Row' }, pinDefaults: {}, position: { x: 0, y: 0 } },
    { id: 'br', type: 'struct.break', params: { typeName: 'Row' }, pinDefaults: {}, position: { x: 240, y: 0 } },
  ];
  asset.graphs.main!.edges = [
    { id: 'd1', from: { node: 'mk', pin: 'value' }, to: { node: 'br', pin: 'value' }, kind: 'data' },
  ];
  const { nodes, edges } = irToFlow(asset, builtinSpecMap);
  const mk = nodes.find((n) => n.id === 'mk')!;
  const br = nodes.find((n) => n.id === 'br')!;
  assert.deepEqual(mk.data.dynamicPins?.inputs.map((p) => p.id), ['level', 'count']);
  assert.equal(mk.data.dynamicPins?.outputs[0]?.type, 'Row');
  assert.deepEqual(br.data.dynamicPins?.outputs.map((p) => p.id), ['level', 'count']);
  assert.equal(br.data.dynamicPins?.inputs[0]?.type, 'Row');
  assert.equal(edges[0]?.data?.pinType, 'Row', '结构体边按结构体类型着色');
});

/* ============================================================
 * 6. 类型选择器
 * ============================================================ */

test('type-picker：数组与结构体（含结构体数组）选项分组', () => {
  const types = [{ name: 'Row', fields: [] }];
  const groups = typeOptionGroups(types);
  assert.ok(groups.some((g) => g.label === '基础类型' && g.options.some((o) => o.value === 'string')));
  assert.ok(groups.some((g) => g.label === '数组' && g.options.some((o) => o.value === 'int[]')));
  assert.ok(groups.some((g) => g.label === '结构体' && g.options.some((o) => o.value === 'Row')));
  assert.ok(groups.some((g) => g.label === '结构体数组' && g.options.some((o) => o.value === 'Row[]')));
  assert.equal(isKnownTypeOption('Row[]', types), true);
  assert.equal(isKnownTypeOption('LogRow', types), false, '未定义别名走自定义兜底');
  assert.equal(typeOptionLabel('Row[]', types), '结构体数组：Row');
});

test('resolvePinRef：结构体字段 / var.get-set 声明类型覆盖静态 any', async () => {
  const { resolvePinRef } = await import('./interaction/logic');
  const types = [{ name: 'Row', fields: [{ name: 'level', type: 'string' }] }];
  const nodes = [
    { id: 'mk', type: 'struct.make', params: { typeName: 'Row' }, pinDefaults: {}, position: { x: 0, y: 0 } },
    { id: 'set1', type: 'var.set', params: { varName: 'name' }, pinDefaults: {}, position: { x: 0, y: 0 } },
    { id: 'get1', type: 'var.get', params: { varName: 'rows' }, pinDefaults: {}, position: { x: 0, y: 0 } },
  ];
  assert.equal(resolvePinRef(builtinSpecMap, nodes, 'mk', 'level', 'in', { types })?.type, 'string');
  assert.equal(resolvePinRef(builtinSpecMap, nodes, 'mk', 'value', 'out', { types })?.type, 'Row');
  const vars = [
    { name: 'name', type: 'string' },
    { name: 'rows', type: 'Row[]' },
  ];
  assert.equal(resolvePinRef(builtinSpecMap, nodes, 'set1', 'value', 'in', { variables: vars })?.type, 'string');
  assert.equal(resolvePinRef(builtinSpecMap, nodes, 'get1', 'value', 'out', { variables: vars })?.type, 'Row[]');
});

test('store：结构体名不能与内置类型冲突', () => {
  open();
  const st = useBlueprintStore.getState();
  assert.equal(st.addStructType('string'), false);
  assert.equal(st.addStructType('LogRow[]'), false);
  assert.equal(st.addStructType('uiHandle'), false);
  assert.equal(st.addStructType('Row'), true);
});
