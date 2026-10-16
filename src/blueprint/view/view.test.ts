/**
 * Blueprint Studio v2 —— 蓝图视觉系统单测（node:test，T2.1）
 *
 * 覆盖（任务卡 T2.1 五项）：
 *  1. irToFlow：节点/边数量与映射正确；exec/data 分型（bpExec / bpData + pinType 供取色）
 *  2. 分类→头色映射：事件红 / 函数蓝 / 纯函数绿 / 流程灰 / 插件紫 / var 无头 / 未知灰
 *  3. 引脚→颜色映射：exec/bool/int/float/string/object/any + 数组类型展开（string[] → 元素色）
 *  4. dagre 自动布局：无 position 节点全部赋坐标且包围盒互不相交（含与已定位节点不重叠）
 *  5. 未知节点类型 → 降级样式标记（spec null / variant unknown / 从连线还原的降级引脚）
 *
 * 样本用 builtinSpecs 的真实节点（event.start / flow.branch / math.add / string.concat /
 * var.get / system.print）+ 一个未注册类型（phoneLog.read）构造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRNode, NodeSpec, Vec2 } from '../../ir/types';
import { builtinSpecMap } from '../../nodes';
import { pinColor } from '../../shell/theme/tokens';
import {
  autoLayoutPositions,
  edgesToIR,
  flowToIR,
  headColorFor,
  headVariantFor,
  irToFlow,
  nodeSizeFor,
  varDisplayName,
  varOpOf,
  type FlowNode,
  type HeadVariant,
} from './model';

/* ============================================================
 * 样本构造（builtinSpecs 真实节点）
 * ============================================================ */

/** 构造 IRNode；运行时允许缺 position（类型必填，此处按可缺省构造） */
function irNode(
  id: string,
  type: string,
  position?: Vec2,
  params: Record<string, unknown> = {},
): IRNode {
  return {
    id,
    type,
    params,
    pinDefaults: {},
    position: position ?? (undefined as unknown as Vec2),
  };
}

/** 测试样本资产：2 个已定位节点 + 4 个无 position 节点（含 1 个未知类型） */
function sampleAsset(): IRAsset {
  return {
    version: 2,
    name: '测试资产',
    entry: 'bind',
    graphs: {
      bind: {
        nodes: [
          irNode('ev', 'event.start', { x: 0, y: 0 }),
          irNode('br', 'flow.branch'),
          irNode('add', 'math.add'),
          irNode('concat', 'string.concat'),
          irNode('vget', 'var.get', { x: 420, y: 40 }, { varName: 'packageName' }),
          irNode('unk', 'phoneLog.read'),
        ],
        edges: [
          { id: 'e1', from: { node: 'ev', pin: 'exec' }, to: { node: 'br', pin: 'exec' }, kind: 'exec' },
          { id: 'e2', from: { node: 'br', pin: 'true' }, to: { node: 'unk', pin: 'exec' }, kind: 'exec' },
          { id: 'e3', from: { node: 'add', pin: 'value' }, to: { node: 'br', pin: 'cond' }, kind: 'data' },
          { id: 'e4', from: { node: 'concat', pin: 'value' }, to: { node: 'unk', pin: 'text' }, kind: 'data' },
          { id: 'e5', from: { node: 'unk', pin: 'rows' }, to: { node: 'concat', pin: 'a' }, kind: 'data' },
        ],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

/** 插件节点样例（非内置 id 前缀 → 紫头） */
const pluginSpec: NodeSpec = {
  id: 'phoneLog.read',
  title: '读取手机日志',
  category: '手机日志',
  inputs: [],
  outputs: [],
};

/** 包围盒 + 容差重叠判定（tol=1px 视为不相交） */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxesOverlap(a: Box, b: Box, tol = 1): boolean {
  return (
    a.x < b.x + b.w - tol &&
    b.x < a.x + a.w - tol &&
    a.y < b.y + b.h - tol &&
    b.y < a.y + a.h - tol
  );
}

function nodeBox(n: FlowNode): Box {
  const size = nodeSizeFor(n.data.variant);
  return { x: n.position.x, y: n.position.y, w: size.width, h: size.height };
}

/* ============================================================
 * 1. irToFlow：数量 / 映射 / exec-data 分型
 * ============================================================ */

test('irToFlow：节点与边数量正确，data 字段映射完整', () => {
  const { nodes, edges } = irToFlow(sampleAsset(), builtinSpecMap);
  assert.equal(nodes.length, 6);
  assert.equal(edges.length, 5);

  const ev = nodes.find((n) => n.id === 'ev')!;
  assert.equal(ev.type, 'bpNode');
  assert.equal(ev.data.graphName, 'bind');
  assert.equal(ev.data.spec, builtinSpecMap.get('event.start'));
  assert.equal(ev.data.variant, 'event');
  assert.deepEqual(ev.position, { x: 0, y: 0 });

  // connectedInputs：br 收到 exec 入 + cond 数据入；vget 无输入
  const br = nodes.find((n) => n.id === 'br')!;
  assert.ok(br.data.connectedInputs.has('exec'));
  assert.ok(br.data.connectedInputs.has('cond'));
  const vget = nodes.find((n) => n.id === 'vget')!;
  assert.equal(vget.data.connectedInputs.size, 0);
});

test('irToFlow：exec 边 → bpExec（白实线 + 三角端头），data 边 → bpData（pinType 取源引脚）', () => {
  const { edges } = irToFlow(sampleAsset(), builtinSpecMap);
  const byId = new Map(edges.map((e) => [e.id, e]));

  const e1 = byId.get('e1')!;
  assert.equal(e1.type, 'bpExec');
  assert.equal(e1.data?.kind, 'exec');
  assert.equal(e1.data?.pinType, 'exec');
  assert.equal(e1.source, 'ev');
  assert.equal(e1.sourceHandle, 'exec');
  assert.equal(e1.target, 'br');
  assert.equal(e1.targetHandle, 'exec');
  assert.ok(e1.markerEnd, 'exec 边应带三角端头 marker');

  const e3 = byId.get('e3')!;
  assert.equal(e3.type, 'bpData');
  assert.equal(e3.data?.kind, 'data');
  assert.equal(e3.data?.pinType, 'float', 'data 边 pinType 应取源输出引脚类型（math.add.value=float）');
  assert.equal(e3.markerEnd, undefined, '数据边不带端头');

  const e4 = byId.get('e4')!;
  assert.equal(e4.data?.pinType, 'string', 'string.concat.value=string');

  // 源引脚类型不可知时回落目标输入类型（unk 无 spec → concat.a=string）
  const e5 = byId.get('e5')!;
  assert.equal(e5.data?.pinType, 'string', '源为未知节点时回落目标输入引脚类型');
});

test('irToFlow：未传图名时默认用 asset.entry，图名不存在返回空', () => {
  const asset = sampleAsset();
  const { nodes } = irToFlow(asset, builtinSpecMap);
  assert.equal(nodes.length, 6);

  const empty = irToFlow(asset, builtinSpecMap, 'notExists');
  assert.deepEqual(empty, { nodes: [], edges: [] });
});

/* ============================================================
 * 2. 分类 → 头色映射（§8.1 逐项）
 * ============================================================ */

test('头变体映射：事件红/函数蓝/纯函数绿/流程灰/插件紫/var 无头/未知灰', () => {
  const specOf = (id: string): NodeSpec | null => builtinSpecMap.get(id) ?? null;
  const cases: Array<[string, NodeSpec | null, HeadVariant, string]> = [
    ['event.start', specOf('event.start'), 'event', 'var(--node-head-event)'],
    ['system.print', specOf('system.print'), 'function', 'var(--node-head-function)'],
    ['math.add', specOf('math.add'), 'pure', 'var(--node-head-pure)'],
    ['flow.branch', specOf('flow.branch'), 'flow', 'var(--node-head-flow)'],
    ['phoneLog.read', pluginSpec, 'plugin', 'var(--node-head-plugin)'],
    ['var.get', specOf('var.get'), 'var', 'var(--node-var-bg)'],
    ['some.unknownType', null, 'unknown', 'var(--text-disabled)'],
  ];
  for (const [type, spec, variant, color] of cases) {
    assert.equal(headVariantFor(type, spec), variant, `headVariantFor(${type})`);
    assert.equal(headColorFor(variant), color, `headColorFor(${variant})`);
  }
});

test('头变体映射：插件识别兼容分类「插件」与内置前缀表外的 id', () => {
  const byCategory: NodeSpec = { ...pluginSpec, id: 'custom.node', category: '插件' };
  assert.equal(headVariantFor('custom.node', byCategory), 'plugin');

  const byPrefix: NodeSpec = { ...pluginSpec, id: 'feishu.send', category: '其他' };
  assert.equal(headVariantFor('feishu.send', byPrefix), 'plugin');

  // 内置前缀 + 纯节点优先级：非插件分支不受影响
  assert.equal(headVariantFor('math.add', builtinSpecMap.get('math.add') ?? null), 'pure');
});

test('var 节点辅助：varOpOf / varDisplayName', () => {
  assert.equal(varOpOf('var.get'), 'get');
  assert.equal(varOpOf('var.set'), 'set');
  assert.equal(varOpOf('var.get:hp'), 'get', 'T2.3 暴露变量实例前缀预留');
  assert.equal(varOpOf('flow.branch'), null);
  assert.equal(varDisplayName(irNode('v', 'var.get', undefined, { varName: 'packageName' })), 'packageName');
  assert.equal(varDisplayName(irNode('v', 'var.get')), '变量');
});

/* ============================================================
 * 3. 引脚 → 颜色映射（tokens.pinColor）
 * ============================================================ */

test('pinColor：UE5 标准引脚色全表 + 数组展开为元素色 + 未知类型回落 any', () => {
  assert.equal(pinColor('exec'), 'var(--pin-exec)');
  assert.equal(pinColor('bool'), 'var(--pin-bool)');
  assert.equal(pinColor('int'), 'var(--pin-int)');
  assert.equal(pinColor('float'), 'var(--pin-float)');
  assert.equal(pinColor('string'), 'var(--pin-string)');
  assert.equal(pinColor('object'), 'var(--pin-object)');
  assert.equal(pinColor('any'), 'var(--pin-any)');

  assert.equal(pinColor('string[]'), 'var(--pin-string)', '数组引脚继承元素色');
  assert.equal(pinColor('int[]'), 'var(--pin-int)');
  assert.equal(pinColor('LogRow[]'), 'var(--pin-any)', '自定义对象数组回落 any 灰');
  assert.equal(pinColor('LogRow'), 'var(--pin-any)', '自定义对象类型回落 any 灰');
});

/* ============================================================
 * 4. dagre 自动布局
 * ============================================================ */

test('autoLayoutPositions：全部节点赋坐标且包围盒互不相交', () => {
  const size = { width: 190, height: 96 };
  const entries = [
    { id: 'a', ...size },
    { id: 'b', ...size },
    { id: 'c', ...size },
    { id: 'd', ...size },
  ];
  const links = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'd' },
  ];
  const positions = autoLayoutPositions(entries, links);
  assert.equal(positions.size, 4);
  for (const p of positions.values()) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  const boxes: Box[] = entries.map((e) => {
    const p = positions.get(e.id)!;
    return { x: p.x, y: p.y, w: e.width, h: e.height };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(
        !boxesOverlap(boxes[i], boxes[j]),
        `节点 ${entries[i].id} 与 ${entries[j].id} 包围盒不应重叠`,
      );
    }
  }
});

test('irToFlow：无 position 节点全部被 dagre 赋坐标，且与已定位节点互不重叠', () => {
  const { nodes } = irToFlow(sampleAsset(), builtinSpecMap);
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.position.x) && Number.isFinite(n.position.y), `${n.id} 应有坐标`);
  }
  const boxes = nodes.map(nodeBox);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(
        !boxesOverlap(boxes[i], boxes[j]),
        `节点 ${nodes[i].id} 与 ${nodes[j].id} 包围盒不应重叠（含手工定位节点）`,
      );
    }
  }
  // 布局方向：dagre LR，起点的 exec 链应从左往右（ev 在最左）
  const ev = nodes.find((n) => n.id === 'ev')!;
  const br = nodes.find((n) => n.id === 'br')!;
  assert.ok(br.position.x > ev.position.x, 'exec 链应从左到右布局');
});

test('flowToIR：拖动后的 position 写回 IRNode，其余字段原样保留', () => {
  const { nodes } = irToFlow(sampleAsset(), builtinSpecMap);
  const dragged = nodes.map((n) =>
    n.id === 'br' ? { ...n, position: { x: 123, y: 45 } } : n,
  );
  const irNodes = flowToIR(dragged);
  assert.equal(irNodes.length, nodes.length);
  const br = irNodes.find((n) => n.id === 'br')!;
  assert.deepEqual(br.position, { x: 123, y: 45 });
  assert.equal(br.type, 'flow.branch');
  assert.deepEqual(br.pinDefaults, {});
  // 未拖动的节点位置不变
  const ev = irNodes.find((n) => n.id === 'ev')!;
  assert.deepEqual(ev.position, { x: 0, y: 0 });
});

test('edgesToIR：FlowEdge 反向映射回 IREdge（与样本边等价，T2.2 接线用）', () => {
  const { edges } = irToFlow(sampleAsset(), builtinSpecMap);
  const irEdges = edgesToIR(edges);
  assert.deepEqual(irEdges, sampleAsset().graphs.bind.edges);
});

/* ============================================================
 * 5. 未知节点 → 降级样式标记
 * ============================================================ */

test('未知节点类型：spec=null + variant=unknown + 从连线还原降级引脚', () => {
  const { nodes } = irToFlow(sampleAsset(), builtinSpecMap);
  const unk = nodes.find((n) => n.id === 'unk')!;
  assert.equal(unk.data.spec, null);
  assert.equal(unk.data.variant, 'unknown');
  assert.deepEqual(
    [...unk.data.degradedInputs],
    ['exec', 'text'],
    '降级输入引脚应从连线还原（按首次出现顺序）',
  );
  assert.deepEqual([...unk.data.degradedOutputs], ['rows'], '降级输出引脚应从连线还原');
  assert.equal(headColorFor(unk.data.variant), 'var(--text-disabled)', '降级头为灰色');
  assert.equal(headVariantFor('⚠', null), 'unknown');

  // 已知节点不受影响：无降级引脚
  const br = nodes.find((n) => n.id === 'br')!;
  assert.equal(br.data.degradedInputs.length, 0);
  assert.equal(br.data.degradedOutputs.length, 0);
});
