/**
 * 函数资产 ⇄ IRAsset 视图转换单测
 *
 * 覆盖：主图加载 / 局部函数图加载 / 保存回写局部函数 / 旧格式兼容 / 空图骨架。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRGraph } from '../ir/types';
import { functionIR, functionTextOf, type FnAsset } from './functionAsset';

function graph(entry: boolean): IRGraph {
  return {
    kind: 'function',
    nodes: [
      { id: entry ? 'entry_1' : 'entry_h', type: 'func.entry', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
      { id: entry ? 'return_1' : 'return_h', type: 'func.return', params: {}, pinDefaults: {}, position: { x: 280, y: 0 } },
    ],
    edges: [],
    params: [],
    returns: [],
  };
}

function fnAsset(): FnAsset {
  return {
    version: 3,
    kind: 'function',
    name: '主函数',
    params: [{ name: 'text', type: 'string' }],
    returns: [{ name: 'ok', type: 'bool' }],
    graph: graph(true),
    graphs: { helper: graph(false) },
  };
}

test('functionIR：加载主图与局部函数图，主图签名优先生效', () => {
  const ir = functionIR(fnAsset(), 'fallback');
  assert.equal(ir.entry, 'main');
  assert.deepEqual(Object.keys(ir.graphs).sort(), ['helper', 'main']);
  assert.equal(ir.graphs.main?.kind, 'function');
  assert.equal(ir.graphs.main?.params?.[0]?.name, 'text');
  assert.equal(ir.graphs.main?.returns?.[0]?.name, 'ok');
  assert.equal(ir.graphs.helper?.nodes[0]?.id, 'entry_h');
});

test('functionTextOf：主图写入 graph，局部函数写入 graphs；roundtrip 保留图集合', () => {
  const ir = functionIR(fnAsset(), 'fallback');
  const text = functionTextOf(ir, 'library/functions/main.fn.json', 'project');
  const raw = JSON.parse(text) as FnAsset & { graphs?: Record<string, IRGraph> };

  assert.equal(raw.version, 3);
  assert.equal(raw.graph?.nodes[0]?.id, 'entry_1');
  assert.equal(raw.graphs?.helper?.nodes[0]?.id, 'entry_h');
  assert.equal(raw.params?.[0]?.name, 'text');

  const again = functionIR(raw, 'fallback');
  assert.deepEqual(Object.keys(again.graphs).sort(), ['helper', 'main']);
  assert.equal(again.graphs.helper?.nodes[1]?.id, 'return_h');
});

test('functionIR / functionTextOf：旧单图格式兼容，不凭空生成 graphs', () => {
  const legacy: FnAsset = {
    version: 3,
    kind: 'function',
    name: '旧函数',
    graph: graph(true),
  };
  const ir = functionIR(legacy, 'legacy');
  assert.deepEqual(Object.keys(ir.graphs), ['main']);
  const raw = JSON.parse(functionTextOf(ir, 'library/functions/legacy.fn.json', 'global')) as FnAsset;
  assert.equal(raw.graphs, undefined);
});

test('functionIR：空主图 / 空局部函数图补入口出口骨架', () => {
  const ir = functionIR(
    {
      version: 3,
      graph: { nodes: [], edges: [] },
      graphs: { helper: { nodes: [], edges: [] } },
    },
    'empty',
  );
  assert.equal(ir.graphs.main?.nodes.length, 2);
  assert.equal(ir.graphs.main?.nodes[0]?.type, 'func.entry');
  assert.equal(ir.graphs.helper?.nodes.length, 2);
  assert.equal(ir.graphs.helper?.nodes[1]?.type, 'func.return');
});
