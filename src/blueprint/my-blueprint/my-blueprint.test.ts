/**
 * Blueprint Studio v2 —— My Blueprint 结构面板单测（node:test，T2.3）
 *
 * 覆盖（任务卡 T2.3 测试清单）：
 *  1. 纯函数：命名规则（顺序取名 / Copy 后缀 / 唯一性大小写不敏感）、事件入口定位、
 *     图签排序、事件参数行清洗
 *  2. store 资产编辑（全部走真实 runCommand，undo/redo 还原）：
 *     - 变量增删改重命名 + exposed 切换（含重名拒绝 / 删除级联 Get·Set 节点与连线）
 *     - 新建函数图结构（func.entry / func.return 存在、边为空、接口为空）
 *     - 插入调用节点（flow.call，params.graph 正确）
 *     - 事件新建 / 参数行编辑 / 改名级联 event.custom
 *     - 插入变量 Get/Set、事件入口节点
 *  3. 保存校验联动（PLAN §8.5）：函数图与 flow.call 不再被判 unknown-node
 *  4. DOM 冒烟（happy-dom）：My Blueprint 分节列表 + 暴露勾选 + 新建/重命名/
 *     右键菜单删除；GraphTabs 切图 + ＋函数新建
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRNode, Vec2 } from '../../ir/types';
import { validateIR } from '../../ir/validate';
import {
  getDomainState,
  peekUndo,
  redo,
  resetEditorStore,
  subscribeReplay,
  undo,
} from '../../shell/commands';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  VARIABLE_TYPES,
  cleanParamRows,
  findEventNode,
  isBlankName,
  nameExists,
  nextCopyName,
  nextEventName,
  nextFunctionName,
  nextSequentialName,
  nextVariableName,
  orderedGraphNames,
  variableTypeLabel,
} from './model';

/* ============================================================
 * 样本构造
 * ============================================================ */

function irNode(id: string, type: string, position?: Vec2, params: Record<string, unknown> = {}): IRNode {
  return { id, type, params, pinDefaults: {}, position: position ?? { x: 0, y: 0 } };
}

function sampleAsset(): IRAsset {
  return {
    version: 2,
    name: '样本资产',
    entry: 'main',
    graphs: {
      main: { nodes: [irNode('ev', 'event.start', { x: 0, y: 0 })], edges: [] },
    },
    variables: [{ name: 'hp', type: 'int', default: 10 }],
    events: [],
    snippets: [],
    layout: {},
  };
}

/** 带变量节点 / 函数图 / 事件的完整样本（级联与跳转测试用） */
function completeAsset(): IRAsset {
  return {
    version: 2,
    name: '完整样本',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          irNode('ev', 'event.start', { x: 0, y: 0 }),
          irNode('get1', 'var.get', { x: 200, y: 0 }, { varName: 'hp' }),
          irNode('set1', 'var.set', { x: 400, y: 0 }, { varName: 'mp' }),
          irNode('cev', 'event.custom', { x: 600, y: 0 }, { eventName: 'loaded' }),
          irNode('call1', 'flow.call', { x: 800, y: 0 }, { graph: 'calc' }),
        ],
        edges: [
          { id: 'e1', from: { node: 'ev', pin: 'exec' }, to: { node: 'set1', pin: 'exec' }, kind: 'exec' },
        ],
      },
      calc: {
        nodes: [
          irNode('entry_1', 'func.entry', { x: 0, y: 0 }),
          irNode('return_1', 'func.return', { x: 280, y: 0 }),
        ],
        edges: [],
        params: [{ name: 'a', type: 'float' }],
        returns: [{ name: 'sum', type: 'float' }],
      },
    },
    variables: [
      { name: 'hp', type: 'int', default: 10, exposed: true },
      { name: 'mp', type: 'float' },
    ],
    events: [{ name: 'loaded', params: [{ name: 'count', type: 'int' }] }],
    snippets: [],
    layout: {},
  };
}

/** 打开资产（注册命令域；每次测试重置命令栈） */
function open(asset: IRAsset = sampleAsset()): void {
  resetEditorStore();
  useBlueprintStore.getState().openAsset(asset, 'logic/test.bp.json');
}

/** 域状态资产（唯一文档真源） */
function domainAsset(): IRAsset {
  return getDomainState<{ asset: IRAsset }>('blueprint').asset;
}

/** 镜像刷新挂载（与 useCanvasInteractions 的 subscribeReplay 接线等价；返回解绑） */
function attachMirrorRefresh(): () => void {
  return subscribeReplay((notice) => {
    if (notice.domains.includes('blueprint')) useBlueprintStore.getState().refreshFromDomain();
  });
}

/* ============================================================
 * 1. 纯函数：命名规则与定位
 * ============================================================ */

test('model：nextSequentialName / 变量函数事件默认名（唯一性大小写不敏感）', () => {
  assert.equal(nextSequentialName([], '新变量'), '新变量');
  assert.equal(nextSequentialName(['新变量'], '新变量'), '新变量2');
  assert.equal(nextSequentialName(['新变量', '新变量2'], '新变量'), '新变量3');
  assert.equal(nextSequentialName(['HP'], 'hp'), 'hp2', '大小写不敏感占用');
  assert.equal(nextVariableName([]), '新变量');
  assert.equal(nextFunctionName(['main', '新函数']), '新函数2');
  assert.equal(nextEventName(['新事件']), '新事件2');
});

test('model：nextCopyName 复制名后缀（_Copy / _Copy2 …）', () => {
  assert.equal(nextCopyName(['hp'], 'hp'), 'hp_Copy');
  assert.equal(nextCopyName(['hp', 'hp_Copy'], 'hp'), 'hp_Copy2');
  assert.equal(nextCopyName(['hp', 'hp_Copy', 'hp_COPY2'], 'hp'), 'hp_Copy3', '比较忽略大小写');
  assert.equal(nextCopyName([], 'hp'), 'hp_Copy');
});

test('model：nameExists / isBlankName / variableTypeLabel', () => {
  assert.equal(nameExists(['hp', 'mp'], 'HP'), true);
  assert.equal(nameExists(['hp', 'mp'], 'HP', 'hp'), false, '排除自身');
  assert.equal(nameExists(['hp'], 'mp'), false);
  assert.equal(isBlankName('  '), true);
  assert.equal(isBlankName('hp'), false);
  assert.equal(variableTypeLabel('int'), '整数');
  assert.equal(variableTypeLabel('LogRow'), 'LogRow', '未知类型原样');
  assert.deepEqual([...VARIABLE_TYPES], ['bool', 'int', 'float', 'string', 'object', 'any']);
});

test('model：findEventNode（params.eventName 优先 / title 兜底 / 未命中 null）', () => {
  const asset = completeAsset();
  assert.deepEqual(findEventNode(asset, 'loaded'), { graphName: 'main', nodeId: 'cev' });
  const titled: IRAsset = {
    ...asset,
    events: [{ name: '轰', params: [] }],
    graphs: {
      main: { nodes: [irNode('t1', 'event.custom', { x: 0, y: 0 }, {}, ), irNode('t2', 'event.custom', { x: 0, y: 0 })], edges: [] },
    },
  };
  titled.graphs.main.nodes[0]!.title = '轰';
  assert.deepEqual(findEventNode(titled, '轰'), { graphName: 'main', nodeId: 't1' }, 'title 兜底');
  assert.equal(findEventNode(titled, '无'), null);
});

test('model：orderedGraphNames 主图置首 + cleanParamRows 清洗', () => {
  const asset = completeAsset();
  assert.deepEqual(orderedGraphNames(asset), ['main', 'calc']);
  assert.deepEqual(cleanParamRows([{ name: ' a ', type: 'int' }, { name: '  ', type: 'any' }]), [
    { name: 'a', type: 'int' },
  ]);
});

/* ============================================================
 * 2. store：变量编辑（入命令栈，undo/redo 还原）
 * ============================================================ */

test('store 变量：新建（含暴露/分类）入栈 + 重名拒绝 + 撤销重做', () => {
  open();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    assert.equal(st.addVariable({ name: 'score', type: 'float', exposed: true, category: '战斗', default: 1.5 }), true);
    const v = domainAsset().variables.find((x) => x.name === 'score');
    assert.ok(v, '变量已入资产');
    assert.equal(v!.type, 'float');
    assert.equal(v!.exposed, true);
    assert.equal(v!.category, '战斗');
    assert.equal(v!.default, 1.5);
    assert.equal(peekUndo()?.label, '变量：新建');

    assert.equal(st.addVariable({ name: 'HP', type: 'int' }), false, '重名拒绝（大小写不敏感）');
    assert.equal(st.addVariable({ name: '  ', type: 'int' }), false, '空名拒绝');
    assert.equal(domainAsset().variables.length, 2);

    undo();
    assert.equal(domainAsset().variables.length, 1, '撤销还原');
    redo();
    assert.equal(domainAsset().variables.length, 2, '重做恢复');
    assert.equal(useBlueprintStore.getState().asset!.variables.length, 2, '镜像同步');
  } finally {
    detach();
  }
});

test('store 变量：重命名级联全部图的 var.get/var.set，可撤销', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    assert.equal(st.renameVariable('hp', '生命值'), true);
    assert.equal(domainAsset().variables.find((v) => v.name === '生命值')?.type, 'int');
    const get1 = domainAsset().graphs['main']!.nodes.find((n) => n.id === 'get1')!;
    assert.equal(get1.params['varName'], '生命值', '引用节点级联改名');
    assert.equal(peekUndo()?.label, '变量：重命名');

    assert.equal(st.renameVariable('生命值', 'MP'), false, '与其他变量重名拒绝');
    assert.equal(st.renameVariable('生命值', ' '), false, '空名拒绝');
    assert.equal(st.renameVariable('不存在', 'x'), false);

    undo();
    assert.equal(domainAsset().variables.some((v) => v.name === 'hp'), true, '撤销还原变量名');
    assert.equal(
      domainAsset().graphs['main']!.nodes.find((n) => n.id === 'get1')!.params['varName'],
      'hp',
      '引用节点还原',
    );
    assert.equal(useBlueprintStore.getState().asset!.graphs['main']!.nodes[1]!.params['varName'], 'hp', '镜像同步');
  } finally {
    detach();
  }
});

test('store 变量：删除级联引用节点与连线，可撤销', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.removeVariable('mp');
    const asset = domainAsset();
    assert.equal(asset.variables.some((v) => v.name === 'mp'), false, '定义已删');
    assert.ok(!asset.graphs['main']!.nodes.some((n) => n.id === 'set1'), '引用节点级联删除');
    assert.equal(asset.graphs['main']!.edges.length, 0, '挂接连线级联删除');
    assert.ok(asset.graphs['main']!.nodes.some((n) => n.id === 'get1'), '其他变量节点不受影响');
    assert.equal(peekUndo()?.label, '变量：删除');

    undo();
    const restored = domainAsset();
    assert.ok(restored.graphs['main']!.nodes.some((n) => n.id === 'set1'), '节点还原');
    assert.equal(restored.graphs['main']!.edges.length, 1, '连线还原');
  } finally {
    detach();
  }
});

test('store 变量：exposed 暴露勾选切换（DoD 核心）可撤销', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.updateVariable('mp', { exposed: true });
    assert.equal(domainAsset().variables.find((v) => v.name === 'mp')?.exposed, true);
    assert.equal(peekUndo()?.label, '变量：编辑');
    st.updateVariable('mp', { exposed: false });
    assert.equal(domainAsset().variables.find((v) => v.name === 'mp')?.exposed, false);
    st.updateVariable('mp', { type: 'string' });
    assert.equal(domainAsset().variables.find((v) => v.name === 'mp')?.type, 'string');

    undo(); // 类型还原
    undo(); // exposed false 还原为 true
    undo(); // exposed true 还原为 undefined
    const v = domainAsset().variables.find((x) => x.name === 'mp');
    assert.equal(v!.type, 'float');
    assert.equal(v!.exposed, undefined);
  } finally {
    detach();
  }
});

test('store 变量：复制为 名_Copy（冲突递增），可撤销', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    const copy1 = st.duplicateVariable('hp');
    assert.equal(copy1, 'hp_Copy');
    assert.equal(domainAsset().variables.find((v) => v.name === 'hp_Copy')?.default, 10, '属性随复制');
    const copy2 = st.duplicateVariable('hp');
    assert.equal(copy2, 'hp_Copy2', '冲突递增');
    assert.equal(st.duplicateVariable('不存在'), null);
    assert.equal(peekUndo()?.label, '变量：复制');

    undo();
    undo();
    assert.equal(domainAsset().variables.length, 2);
  } finally {
    detach();
  }
});

/* ============================================================
 * 3. store：函数图 / 调用节点
 * ============================================================ */

test('store 函数：新建函数图（入口/出口节点、无边、空接口）+ 重名拒绝 + 撤销', () => {
  open();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    assert.equal(st.addFunction('计算伤害'), true);
    const g = domainAsset().graphs['计算伤害']!;
    assert.ok(g, '函数图已建');
    assert.deepEqual(
      g.nodes.map((n) => n.type).sort(),
      ['func.entry', 'func.return'],
      '入口/出口节点存在',
    );
    assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['entry_1', 'return_1']);
    assert.equal(g.edges.length, 0, '边为空');
    assert.deepEqual(g.params, [], '入参声明为空');
    assert.deepEqual(g.returns, [], '返回值声明为空');
    assert.equal(peekUndo()?.label, '函数：新建');

    assert.equal(st.addFunction('计算伤害'), false, '重名拒绝');
    assert.equal(st.addFunction('MAIN'), false, '与主图重名（大小写不敏感）');
    assert.equal(st.addFunction('  '), false, '空名拒绝');

    undo();
    assert.ok(!domainAsset().graphs['计算伤害'], '撤销删除函数图');
    redo();
    assert.ok(domainAsset().graphs['计算伤害'], '重做恢复');
  } finally {
    detach();
  }
});

test('store 函数：插入调用节点（flow.call，params.graph 正确）+ 删除函数级联', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    // 样本已含 call1（graph: 'calc'）；再插一个验证 params.graph
    const id = st.insertFunctionCall('calc', { x: 120, y: 80 });
    assert.ok(id);
    const node = domainAsset().graphs['main']!.nodes.find((n) => n.id === id)!;
    assert.equal(node.type, 'flow.call');
    assert.equal(node.params['graph'], 'calc', 'params.graph = 目标图名');
    assert.equal(node.position, useBlueprintStore.getState().asset!.graphs['main']!.nodes.find((n) => n.id === id)!.position, '镜像同步');
    assert.equal(peekUndo()?.label, '插入函数调用节点');
    assert.equal(st.insertFunctionCall('missing'), null, '不存在的函数拒绝');

    // 删除函数图：级联删 flow.call；主图不可删
    assert.equal(st.removeGraph('main'), false, '主图不可删除');
    assert.equal(st.removeGraph('calc'), true);
    const after = domainAsset().graphs['main']!;
    assert.ok(!after.nodes.some((n) => n.type === 'flow.call'), '调用节点级联删除');
    assert.ok(after.edges.some((e) => e.id === 'e1'), '无关连线保留');
    assert.equal(peekUndo()?.label, '函数：删除');

    undo();
    assert.ok(domainAsset().graphs['calc'], '撤销恢复函数图');
    assert.equal(domainAsset().graphs['main']!.nodes.filter((n) => n.type === 'flow.call').length, 2, '两个调用节点都还原');
  } finally {
    detach();
  }
});

/* ============================================================
 * 4. store：变量 / 事件节点插入
 * ============================================================ */

test('store 插入：变量 Get/Set（params.varName；未定义变量拒绝）', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    const getId = st.insertVariableNode('hp', 'get');
    assert.ok(getId);
    const getNode = domainAsset().graphs['main']!.nodes.find((n) => n.id === getId)!;
    assert.equal(getNode.type, 'var.get');
    assert.equal(getNode.params['varName'], 'hp');

    const setId = st.insertVariableNode('hp', 'set');
    assert.ok(setId);
    const setNode = domainAsset().graphs['main']!.nodes.find((n) => n.id === setId)!;
    assert.equal(setNode.type, 'var.set');
    assert.equal(setNode.params['varName'], 'hp');
    assert.equal(setNode.pinDefaults['value'], null, 'set 的 value 脚取 spec 默认值');

    assert.equal(st.insertVariableNode('nope', 'get'), null, '未定义变量拒绝');
    assert.equal(peekUndo()?.label, '插入变量 Set 节点');
    assert.deepEqual(useBlueprintStore.getState().selection.nodeIds, [setId], '选中切到新节点');

    undo();
    undo();
    const nodes = domainAsset().graphs['main']!.nodes;
    assert.ok(!nodes.some((n) => n.id === getId) && !nodes.some((n) => n.id === setId), '插入可撤销');
  } finally {
    detach();
  }
});

test('store 插入：事件入口节点（event.custom，params.eventName）', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    const id = st.insertEventNode('loaded');
    assert.ok(id);
    const node = domainAsset().graphs['main']!.nodes.find((n) => n.id === id)!;
    assert.equal(node.type, 'event.custom');
    assert.equal(node.params['eventName'], 'loaded');
    assert.equal(st.insertEventNode('nope'), null);
    assert.equal(peekUndo()?.label, '插入事件节点');

    undo();
    assert.ok(!domainAsset().graphs['main']!.nodes.some((n) => n.id === id));
  } finally {
    detach();
  }
});

/* ============================================================
 * 5. store：事件定义
 * ============================================================ */

test('store 事件：新建 / 参数行编辑 / 改名级联 event.custom / 重名拒绝', () => {
  open(completeAsset());
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    assert.equal(st.addEvent({ name: 'saved', params: [{ name: 'ok', type: 'bool' }] }), true);
    assert.deepEqual(domainAsset().events.at(-1), { name: 'saved', params: [{ name: 'ok', type: 'bool' }] });
    assert.equal(peekUndo()?.label, '事件：新建');
    assert.equal(st.addEvent({ name: 'LOADED', params: [] }), false, '重名拒绝');
    assert.equal(st.addEvent({ name: ' ', params: [] }), false, '空名拒绝');

    // 参数行编辑（增行）
    assert.equal(
      st.updateEvent('saved', {
        params: [{ name: 'ok', type: 'bool' }, { name: 'path', type: 'string' }],
      }),
      true,
    );
    assert.equal(domainAsset().events.find((e) => e.name === 'saved')!.params.length, 2);

    // 改名级联：completeAsset 中 cev 绑定 'loaded'
    assert.equal(st.updateEvent('loaded', { name: '加载完成' }), true);
    assert.equal(domainAsset().events[0]!.name, '加载完成');
    const cev = domainAsset().graphs['main']!.nodes.find((n) => n.id === 'cev')!;
    assert.equal(cev.params['eventName'], '加载完成', 'event.custom 级联改名');
    assert.equal(st.updateEvent('加载完成', { name: 'SAVED' }), false, '与其他事件重名拒绝');
    assert.equal(peekUndo()?.label, '事件：编辑');

    undo(); // 改名还原
    assert.equal(domainAsset().events[0]!.name, 'loaded');
    assert.equal(
      domainAsset().graphs['main']!.nodes.find((n) => n.id === 'cev')!.params['eventName'],
      'loaded',
      '级联还原',
    );
  } finally {
    detach();
  }
});

/* ============================================================
 * 6. store：图接口与批量参数（Details 用）
 * ============================================================ */

test('store：setGraphParams / setGraphReturns 编辑函数接口，可撤销', () => {
  open();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    assert.equal(st.addFunction('calc'), true);
    st.setGraphParams('calc', [{ name: 'a', type: 'float' }, { name: 'b', type: 'float' }]);
    assert.deepEqual(domainAsset().graphs['calc']!.params, [
      { name: 'a', type: 'float' },
      { name: 'b', type: 'float' },
    ]);
    assert.equal(peekUndo()?.label, '编辑函数入参');
    st.setGraphReturns('calc', [{ name: 'total', type: 'float' }]);
    assert.deepEqual(domainAsset().graphs['calc']!.returns, [{ name: 'total', type: 'float' }]);
    assert.equal(peekUndo()?.label, '编辑函数返回值');

    undo();
    assert.deepEqual(domainAsset().graphs['calc']!.returns, [], 'returns 还原为空声明');
    undo();
    assert.deepEqual(domainAsset().graphs['calc']!.params, [], 'params 还原为空声明');
    st.setGraphParams('missing', [{ name: 'x', type: 'int' }]);
    assert.equal(peekUndo()?.label, '函数：新建', '不存在的图不产生命令（栈顶仍是前一条）');
  } finally {
    detach();
  }
});

test('store：setNodesParams 批量参数（单命令，一次撤销）', () => {
  const asset = completeAsset();
  asset.graphs['main']!.nodes.push(
    irNode('c1', 'math.compare', { x: 0, y: 100 }, { op: '>' }),
    irNode('c2', 'math.compare', { x: 0, y: 200 }, { op: '>=' }),
  );
  open(asset);
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.setNodesParams(['c1', 'c2'], { op: '<' });
    const nodes = domainAsset().graphs['main']!.nodes;
    assert.equal(nodes.find((n) => n.id === 'c1')!.params['op'], '<');
    assert.equal(nodes.find((n) => n.id === 'c2')!.params['op'], '<');
    assert.equal(peekUndo()?.label, '批量设置节点参数');

    undo();
    const restored = domainAsset().graphs['main']!.nodes;
    assert.equal(restored.find((n) => n.id === 'c1')!.params['op'], '>', '一次撤销全部还原');
    assert.equal(restored.find((n) => n.id === 'c2')!.params['op'], '>=');
    st.setNodesParams([], { op: '<' });
    assert.equal(peekUndo(), null, '空集合不产生命令');
  } finally {
    detach();
  }
});

/* ============================================================
 * 7. 保存校验联动（PLAN §8.5）：函数图不再报 unknown-node
 * ============================================================ */

test('校验联动：store.specs 含 graph-op 补充 spec，函数子图与 flow.call 可过校验', () => {
  open(completeAsset());
  const st = useBlueprintStore.getState();
  assert.equal(st.specs.get('flow.call')?.title, '调用函数');
  assert.equal(st.specs.get('func.entry')?.title, '函数入口');
  assert.equal(st.specs.get('func.return')?.title, '函数出口');
  const issues = validateIR(st.asset!, st.specs);
  assert.equal(
    issues.some((i) => i.code === 'unknown-node'),
    false,
    'func.entry/func.return/flow.call 不再判未知节点',
  );
});

/* ============================================================
 * 8. DOM 冒烟（happy-dom：MyBlueprint / GraphTabs 挂载与交互）
 * ============================================================ */
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://localhost/' });

function setGlobal(key: string, value: unknown): void {
  try {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    /* 只读全局（如 Node 的 navigator）：跳过 */
  }
}

for (const key of [
  'window',
  'document',
  'Event',
  'CustomEvent',
  'EventTarget',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLSelectElement',
  'HTMLButtonElement',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = (dom as unknown as Record<string, unknown>)[key];
  if (value !== undefined) setGlobal(key, value);
}
setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MyBlueprint } = await import('./MyBlueprint');
const { GraphTabs } = await import('./GraphTabs');

/** React 元素挂载到 happy-dom body（返回卸载函数） */
function mount(node: ReturnType<typeof createElement>): () => Promise<void> {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root.render(node);
  });
  return () =>
    act(async () => {
      root.unmount();
      container.remove();
    });
}

/** React 受控输入框设值（native setter + input 事件，绕过 React 值追踪去重） */
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}

/** 派发键盘事件到元素 */
function pressKey(el: Element, key: string): void {
  el.dispatchEvent(
    new dom.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as unknown as Event,
  );
}

/** 找到文本匹配的菜单项 */
function findMenuItem(text: string): HTMLButtonElement | undefined {
  return [...dom.document.querySelectorAll('.fs-menu-item')].find(
    (el) => el.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

test('DOM 冒烟：MyBlueprint 分节列表 + 变量行（暴露勾选 / 类型徽标）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    assert.equal(dom.document.querySelectorAll('.bp-mb-section').length, 4, '变量/函数/事件/注释四分节');
    assert.equal(dom.document.querySelector('.bp-mb-header-title')?.textContent, 'My Blueprint');
    assert.equal(dom.document.querySelector('.bp-mb-header-sub')?.textContent, '完整样本');

    const names = [...dom.document.querySelectorAll('.bp-mb-row-name')].map((el) => el.textContent);
    assert.ok(names.includes('hp') && names.includes('mp'), '变量列表渲染');
    assert.ok(names.includes('calc'), '函数列表渲染');
    assert.ok(names.includes('loaded'), '事件列表渲染');
    assert.ok(dom.document.body.textContent?.includes('暂无注释'), '注释分节占位');

    const exposed = dom.document.querySelector('.bp-mb-exposed') as unknown as HTMLInputElement;
    assert.equal(exposed.checked, true, 'hp 默认暴露');
    assert.ok(dom.document.querySelector('.bp-mb-type'), '类型徽标渲染');
    assert.ok(dom.document.querySelector('.bp-mb-meta')?.textContent?.includes('参数'), '函数参数数渲染');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：MyBlueprint 暴露勾选切换 → 资产更新（入命令栈）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    // mp 未暴露：第二行的勾选框
    const checkboxes = [...dom.document.querySelectorAll('.bp-mb-exposed')] as unknown as HTMLInputElement[];
    assert.equal(checkboxes.length, 2);
    const mpBox = checkboxes[1]!;
    assert.equal(mpBox.checked, false);
    act(() => {
      mpBox.click();
    });
    assert.equal(
      domainAsset().variables.find((v) => v.name === 'mp')?.exposed,
      true,
      '勾选 → updateVariable(exposed: true)',
    );
    assert.equal(peekUndo()?.label, '变量：编辑');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：MyBlueprint 新建变量（行内命名 + 类型下拉）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    const addBtn = dom.document.querySelector('.bp-mb-add') as unknown as HTMLButtonElement;
    act(() => {
      addBtn.click();
    });
    const input = dom.document.querySelector('.bp-mb-addrow .bp-mb-inline-input') as unknown as HTMLInputElement;
    assert.ok(input, '行内新建表单出现');
    act(() => {
      setControlledValue(input, 'stamina');
    });
    act(() => {
      pressKey(input, 'Enter');
    });
    const added = domainAsset().variables.find((v) => v.name === 'stamina');
    assert.ok(added, '变量已建');
    assert.equal(added!.type, 'int', '默认类型 int');
    assert.equal(peekUndo()?.label, '变量：新建');
    assert.equal(dom.document.querySelector('.bp-mb-addrow'), null, '表单已关闭');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：MyBlueprint 双击重命名（级联引用节点）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    const nameSpan = [...dom.document.querySelectorAll('.bp-mb-row-name')].find(
      (el) => el.textContent === 'hp',
    )!;
    act(() => {
      nameSpan.dispatchEvent(
        new dom.MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
    });
    const input = dom.document.querySelector('.bp-mb-row .bp-mb-inline-input') as unknown as HTMLInputElement;
    assert.ok(input, '行内重命名输入框出现');
    act(() => {
      setControlledValue(input, '生命值');
    });
    act(() => {
      pressKey(input, 'Enter');
    });
    assert.ok(domainAsset().variables.some((v) => v.name === '生命值'), '重命名生效');
    assert.equal(
      domainAsset().graphs['main']!.nodes.find((n) => n.id === 'get1')!.params['varName'],
      '生命值',
      '引用节点级联',
    );
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：MyBlueprint 变量行右键菜单（插入 Get / 删除）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    const row = [...dom.document.querySelectorAll('.bp-mb-row')].find(
      (el) => el.querySelector('.bp-mb-row-name')?.textContent === 'hp',
    )!;
    act(() => {
      row.dispatchEvent(
        new dom.MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const menuEl = dom.document.querySelector('.fs-menu');
    assert.ok(menuEl, '右键菜单（portal）出现');

    // 插入 Get 节点
    act(() => {
      (findMenuItem('插入 Get 节点')! as unknown as HTMLButtonElement).click();
    });
    assert.ok(
      domainAsset().graphs['main']!.nodes.some(
        (n) => n.type === 'var.get' && n.params['varName'] === 'hp' && n.id !== 'get1',
      ),
      '菜单插入 Get 节点',
    );
    assert.equal(dom.document.querySelector('.fs-menu'), null, '选择后菜单关闭');

    // 右键 → 删除变量
    const row2 = [...dom.document.querySelectorAll('.bp-mb-row')].find(
      (el) => el.querySelector('.bp-mb-row-name')?.textContent === 'hp',
    )!;
    act(() => {
      row2.dispatchEvent(
        new dom.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      (findMenuItem('删除变量')! as unknown as HTMLButtonElement).click();
    });
    assert.ok(!domainAsset().variables.some((v) => v.name === 'hp'), '菜单删除变量');
    assert.equal(peekUndo()?.label, '变量：删除');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：MyBlueprint 新建事件（名 + 参数行）', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(MyBlueprint, {}));
  try {
    const addBtns = [...dom.document.querySelectorAll('.bp-mb-add')] as unknown as HTMLButtonElement[];
    act(() => {
      addBtns[2]!.click(); // 事件分节的 ＋
    });
    const form = dom.document.querySelector('.bp-mb-addrow--event');
    assert.ok(form, '事件新建表单出现');
    const nameInput = form!.querySelector('.bp-mb-inline-input') as unknown as HTMLInputElement;
    act(() => {
      setControlledValue(nameInput, '刷新');
    });
    // 加一个参数行
    const addParam = [...form!.querySelectorAll('button')].find((b) => b.textContent === '＋参数')! as unknown as HTMLButtonElement;
    act(() => {
      addParam.click();
    });
    const paramInput = dom.document.querySelector(
      '.bp-mb-addrow--event [aria-label="参数1名"]',
    ) as unknown as HTMLInputElement;
    act(() => {
      setControlledValue(paramInput, 'count');
    });
    const confirm = [...dom.document.querySelectorAll('.bp-mb-addrow--event button')].find(
      (b) => b.textContent === '✓',
    )!;
    act(() => {
      (confirm as unknown as HTMLButtonElement).click();
    });
    const ev = domainAsset().events.find((e) => e.name === '刷新');
    assert.ok(ev, '事件已建');
    assert.deepEqual(ev!.params, [{ name: 'count', type: 'any' }], '参数行随事件提交');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：GraphTabs 切图 + ＋函数新建并自动切图', async () => {
  dom.document.body.innerHTML = '';
  open(completeAsset());
  const unmount = mount(createElement(GraphTabs, {}));
  try {
    const tabs = [...dom.document.querySelectorAll('.bp-mb-tab')];
    assert.equal(tabs.length, 3, 'main + calc + ＋函数');
    assert.equal(tabs[0]!.textContent, 'main', '主图置首');
    assert.ok(tabs[0]!.className.includes('bp-mb-tab--entry'), '主图标识');
    assert.ok(tabs[0]!.getAttribute('aria-selected') === 'true', '当前图高亮');

    // 点击函数 tab 切图
    act(() => {
      (tabs[1]! as unknown as HTMLButtonElement).click();
    });
    assert.equal(useBlueprintStore.getState().graphName, 'calc', '切图生效');

    // ＋函数 → 行内输入 → Enter
    const addTab = dom.document.querySelector('.bp-mb-tab--add') as unknown as HTMLButtonElement;
    act(() => {
      addTab.click();
    });
    const input = dom.document.querySelector('.bp-mb-tabs-add-input') as unknown as HTMLInputElement;
    assert.ok(input, '新建函数输入框出现');
    act(() => {
      setControlledValue(input, '结算');
    });
    act(() => {
      pressKey(input, 'Enter');
    });
    assert.ok(domainAsset().graphs['结算'], '函数图已建');
    assert.equal(useBlueprintStore.getState().graphName, '结算', '新建后自动切图');
    assert.ok(peekUndo()?.label === '函数：新建');
  } finally {
    await unmount();
  }
});
