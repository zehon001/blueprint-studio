/**
 * Blueprint Studio v3.3 —— 用户自定义结构体契约单测（ADR-019）
 *
 * 覆盖：
 *  1. structPinsOf：Make/Break 动态引脚（字段顺序 / 类型 / 默认值 / 未知类型）；
 *  2. 序列化：types 表往返无损，无 types 的旧资产不产生空字段；
 *  3. 校验：结构体边合法、未知类型报错、重名字段报错；
 *  4. 函数动态引脚校验不再误报 broken-edge（顺带锁住 effectivePinsForNode）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRGraph, IRNode, PinSpec } from './types';
import { isTypeAssignable } from './types';
import { structPinsOf } from './structs';
import { deserializeIR, serializeIR, validateIR } from './validate';
import { builtinSpecMap } from '../nodes';
import { editorSpecMap } from '../blueprint/my-blueprint/graph-op-specs';

/* ---------------- 构造工具 ---------------- */

function n(id: string, type: string, params: Record<string, unknown> = {}, pinDefaults: Record<string, unknown> = {}): IRNode {
  return { id, type, params, pinDefaults, position: { x: 0, y: 0 } };
}

function g(nodes: IRNode[], edges: IRGraph['edges'] = [], extra: Partial<IRGraph> = {}): IRGraph {
  return { nodes, edges, ...extra };
}

function structAsset(): IRAsset {
  return {
    version: 3,
    name: '结构体测试',
    entry: 'main',
    types: [
      {
        name: 'Row',
        fields: [
          { name: 'level', type: 'string', default: 'INFO' },
          { name: 'count', type: 'int', default: 0 },
        ],
      },
    ],
    graphs: {
      main: g(
        [n('mk', 'struct.make', { typeName: 'Row' }), n('br', 'struct.break', { typeName: 'Row' })],
        [{ id: 'd1', from: { node: 'mk', pin: 'value' }, to: { node: 'br', pin: 'value' }, kind: 'data' }],
      ),
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

function pinIds(pins: readonly PinSpec[]): string[] {
  return pins.map((p) => p.id);
}

/* ============================================================
 * 1. 动态引脚
 * ============================================================ */

test('structPinsOf：Make 输入 = 字段（含默认值），输出 = value（结构体类型）', () => {
  const pins = structPinsOf(n('m', 'struct.make', { typeName: 'Row' }), structAsset().types);
  assert.ok(pins);
  assert.deepEqual(pinIds(pins!.inputs), ['level', 'count'], '字段顺序即引脚顺序');
  assert.equal(pins!.inputs[0]!.type, 'string');
  assert.equal(pins!.inputs[0]!.defaultValue, 'INFO');
  assert.deepEqual(pins!.outputs, [{ id: 'value', label: '结构体', type: 'Row' }]);
});

test('structPinsOf：Break 输入 = value，输出 = 字段；未知类型返回 undefined', () => {
  const pins = structPinsOf(n('b', 'struct.break', { typeName: 'Row' }), structAsset().types);
  assert.ok(pins);
  assert.deepEqual(pins!.inputs, [{ id: 'value', label: '结构体', type: 'Row' }]);
  assert.deepEqual(pinIds(pins!.outputs), ['level', 'count']);
  assert.equal(pins!.outputs[1]!.type, 'int');
});

test('structPinsOf：未选类型 / 类型不存在 / 非结构体节点 → undefined', () => {
  const types = structAsset().types;
  assert.equal(structPinsOf(n('m', 'struct.make'), types), undefined);
  assert.equal(structPinsOf(n('m', 'struct.make', { typeName: '' }), types), undefined);
  assert.equal(structPinsOf(n('m', 'struct.make', { typeName: 'Ghost' }), types), undefined);
  assert.equal(structPinsOf(n('p', 'system.print'), types), undefined);
});

/* ============================================================
 * 2. 序列化
 * ============================================================ */

test('serializeIR / deserializeIR：types 往返无损；无 types 的旧资产不新增字段', () => {
  const src = structAsset();
  const restored = deserializeIR(serializeIR(src));
  assert.deepEqual(restored.types, src.types);

  const legacy: IRAsset = { ...src, types: undefined };
  delete legacy.types;
  const text = serializeIR(legacy);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(text), 'types'), false, '旧资产不写空 types');
  assert.equal(deserializeIR(text).types, undefined);
});

/* ============================================================
 * 3. 校验
 * ============================================================ */

test('validateIR：结构体节点动态引脚连线合法（不误报 broken-edge）', () => {
  const issues = validateIR(structAsset(), builtinSpecMap);
  assert.deepEqual(
    issues.filter((i) => i.code === 'broken-edge'),
    [],
    'make.value → break.value 应被识别为有效引脚',
  );
  assert.deepEqual(issues.filter((i) => i.severity === 'error'), []);
});

test('validateIR：结构体类型未定义 → struct-type-missing', () => {
  const asset = structAsset();
  asset.graphs.main!.nodes[0]!.params = { typeName: 'Ghost' };
  const hit = validateIR(asset, builtinSpecMap).find((i) => i.code === 'struct-type-missing');
  assert.ok(hit);
  assert.match(hit!.message, /Ghost/);
});

test('validateIR：结构体重名字段 → duplicate-field', () => {
  const asset = structAsset();
  asset.types![0]!.fields.push({ name: 'level', type: 'string' });
  const hit = validateIR(asset, builtinSpecMap).find((i) => i.code === 'duplicate-field');
  assert.ok(hit);
  assert.match(hit!.message, /level/);
});

test('validateIR：函数动态引脚（func.entry 输出）不再误报 broken-edge', () => {
  const asset: IRAsset = {
    version: 3,
    name: 'fn',
    entry: 'main',
    graphs: {
      main: g([n('st', 'event.start')], []),
      fn: g(
        [n('en', 'func.entry'), n('pr', 'system.print')],
        [{ id: 'd1', from: { node: 'en', pin: 'arg0' }, to: { node: 'pr', pin: 'value' }, kind: 'data' }],
        { params: [{ name: 'arg0', type: 'int' }] },
      ),
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
  const issues = validateIR(asset, editorSpecMap());
  assert.deepEqual(issues.filter((i) => i.code === 'broken-edge'), []);
});

test('isTypeAssignable：结构体 / 数组可交给通用 object 引脚；反向不成立', () => {
  assert.equal(isTypeAssignable('Row', 'object'), true);
  assert.equal(isTypeAssignable('Row[]', 'object'), true);
  assert.equal(isTypeAssignable('string[]', 'object'), true);
  assert.equal(isTypeAssignable('object', 'Row'), false, '通用 object 仍需显式转成结构体');
  assert.equal(isTypeAssignable('exec', 'object'), false, 'exec 不能当数据值');
});

test('validateIR：原型链保留字段名 → invalid-field-name', () => {
  const asset = structAsset();
  asset.types![0]!.fields.push({ name: '__proto__', type: 'string' });
  const hit = validateIR(asset, builtinSpecMap).find((i) => i.code === 'invalid-field-name');
  assert.ok(hit);
  assert.match(hit!.message, /__proto__/);
});

test('validateIR：var.get 按变量声明类型参与边级校验', () => {
  const asset: IRAsset = {
    version: 3,
    name: 'var-type',
    entry: 'main',
    graphs: {
      main: g(
        [n('v', 'var.get', { varName: 'name' }), n('br', 'flow.branch')],
        [{ id: 'd1', from: { node: 'v', pin: 'value' }, to: { node: 'br', pin: 'cond' }, kind: 'data' }],
      ),
    },
    variables: [{ name: 'name', type: 'string' }],
    events: [],
    snippets: [],
    layout: {},
  };
  const hit = validateIR(asset, builtinSpecMap).find((i) => i.code === 'type-mismatch');
  assert.ok(hit, 'string 变量接 bool 输入应报类型不匹配');
  assert.match(hit!.message, /string/);
});

test('validateIR：结构体名与内置类型冲突 → invalid-struct-name', () => {
  const asset = structAsset();
  asset.types![0]!.name = 'string';
  const hit = validateIR(asset, builtinSpecMap).find((i) => i.code === 'invalid-struct-name');
  assert.ok(hit);
  assert.match(hit!.message, /string/);
});
