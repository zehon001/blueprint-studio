/**
 * Blueprint Studio v2 —— 蓝图检视器 Details 单测（node:test，T2.4）
 *
 * 覆盖（任务卡 T2.4 测试清单）：
 *  1. ParamSpec → 控件种类映射全表（number/string/bool/select/color/未知回落）
 *  2. PinSpec → 引脚默认值编辑器种类（exec/对象/any → null；bool/int/float/string/select）
 *  3. 多选混合态计算（都声明才显示；值相同显示值，否则 mixed「—」）
 *  4. 已连线引脚判定（connectedInputPins）+ setPinDefault 未连线可改（入命令栈）
 *  5. 批量参数 setNodesParams / 图接口 setGraphParams·setGraphReturns 可撤销
 *  6. DOM 冒烟（happy-dom）：Details 选中节点渲染参数控件（select 即改即提交）、
 *     引脚默认值数字框（Enter 提交）、已连线置灰、多选混合态、无选中图接口编辑
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRNode, NodeSpec, ParamSpec, PinSpec, Vec2 } from '../../ir/types';
import { builtinSpecMap } from '../../nodes';
import {
  getDomainState,
  peekUndo,
  resetEditorStore,
  subscribeReplay,
  undo,
} from '../../shell/commands';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  commonParamRows,
  connectedInputPins,
  displayValue,
  effectivePinDefault,
  groupParams,
  jsonEquals,
  paramEditorKindOf,
  pinEditorKindOf,
} from './details-model';

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
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

/** openAsset（注册命令域；每次测试重置命令栈） */
function open(asset: IRAsset = sampleAsset()): void {
  resetEditorStore();
  useBlueprintStore.getState().openAsset(asset, 'logic/test.bp.json');
}

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
 * 1. ParamSpec → 控件种类映射（每种 ParamType → 控件类型）
 * ============================================================ */

test('paramEditorKindOf：ParamType → 控件种类全表', () => {
  const p = (type: string, extra: Partial<ParamSpec> = {}): ParamSpec =>
    ({ id: 'p', label: '参数', type, ...extra }) as ParamSpec;
  assert.equal(paramEditorKindOf(p('number')), 'number');
  assert.equal(paramEditorKindOf(p('string')), 'text');
  assert.equal(paramEditorKindOf(p('bool')), 'bool');
  assert.equal(paramEditorKindOf(p('color')), 'color');
  assert.equal(paramEditorKindOf(p('select')), 'text', 'select 无 options 降级 text');
  assert.equal(
    paramEditorKindOf(p('select', { options: [{ value: 'a', label: '甲' }] })),
    'select',
    'select 有 options → 下拉',
  );
  assert.equal(paramEditorKindOf(p('vector3')), 'text', '未知扩展类型回落 text');
});

test('pinEditorKindOf：引脚默认值编辑器种类（与画布 editorKindOf 口径一致）', () => {
  const pin = (type: string, extra: Partial<PinSpec> = {}): PinSpec =>
    ({ id: 'p', type, ...extra }) as PinSpec;
  assert.equal(pinEditorKindOf(pin('exec')), null, 'exec 引脚无默认值编辑');
  assert.equal(pinEditorKindOf(pin('bool')), 'bool');
  assert.equal(pinEditorKindOf(pin('int')), 'number');
  assert.equal(pinEditorKindOf(pin('float')), 'number');
  assert.equal(pinEditorKindOf(pin('string')), 'text');
  assert.equal(pinEditorKindOf(pin('string', { options: [{ value: 'a', label: '甲' }] })), 'select');
  assert.equal(pinEditorKindOf(pin('object')), null, '对象不提供内联编辑');
  assert.equal(pinEditorKindOf(pin('any')), null);
  assert.equal(pinEditorKindOf(pin('string[]')), null, '数组不提供内联编辑');
  assert.equal(pinEditorKindOf(pin('LogRow')), null, '自定义别名不提供内联编辑');
});

/* ============================================================
 * 2. 值比较与显示
 * ============================================================ */

test('jsonEquals / displayValue', () => {
  assert.equal(jsonEquals({ a: 1 }, { a: 1 }), true);
  assert.equal(jsonEquals({ a: 1 }, { a: 2 }), false);
  assert.equal(jsonEquals(undefined, null), true, 'undefined 与 null 同义');
  assert.equal(jsonEquals('x', 'x'), true);
  assert.equal(displayValue(undefined), '—');
  assert.equal(displayValue('文本'), '文本');
  assert.equal(displayValue(5), '5');
  assert.equal(displayValue([1, 2]), '[1,2]');
  assert.equal(displayValue({ k: true }), '{"k":true}');
});

/* ============================================================
 * 3. 多选共同参数（混合态）
 * ============================================================ */

/** math.compare 的参数声明（select op）；cloneParam 便于构造 */
function compareSpec(): NodeSpec {
  return builtinSpecMap.get('math.compare')!;
}

test('commonParamRows：共同参数 + 混合态计算', () => {
  const specs = builtinSpecMap;
  const nodes: IRNode[] = [
    irNode('c1', 'math.compare', undefined, { op: '>' }),
    irNode('c2', 'math.compare', undefined, { op: '>' }),
    irNode('c3', 'math.compare', undefined), // 未写入 params → 用 spec 默认（'>'）
  ];
  const rows = commonParamRows(specs, nodes);
  assert.equal(rows.length, 1, 'compare 只有 op 一个参数');
  assert.equal(rows[0]!.param.id, 'op');
  assert.equal(rows[0]!.mixed, false, '值全同（含默认值回退）');
  assert.equal(rows[0]!.value, '>');

  // 值不同 → 混合
  const diverged = [nodes[0]!, irNode('c4', 'math.compare', undefined, { op: '<' })];
  const rows2 = commonParamRows(specs, diverged);
  assert.equal(rows2[0]!.mixed, true, '值不同 → 混合态');
  assert.equal(rows2[0]!.value, '>', '混合态 value 取首个节点值');

  // 参数声明不同 → 只留交集
  const mixedKinds = [nodes[0]!, irNode('d1', 'flow.delay', undefined, {})];
  assert.deepEqual(commonParamRows(specs, mixedKinds), [], '无共同参数 → 空列表');

  // 未知节点 → 共同参数不可知
  const withUnknown = [nodes[0]!, irNode('u1', 'phoneLog.read', undefined, {})];
  assert.deepEqual(commonParamRows(specs, withUnknown), [], '含未知节点返回空');

  assert.deepEqual(commonParamRows(specs, []), [], '空选区返回空');
  assert.ok(compareSpec(), 'math.compare 在内置节点库中（样本自检）');
});

test('groupParams：按 group 分组（未声明归「默认」，保序）', () => {
  const params: ParamSpec[] = [
    { id: 'a', label: '甲', type: 'string', group: '选项' },
    { id: 'b', label: '乙', type: 'string' },
    { id: 'c', label: '丙', type: 'string', group: '选项' },
  ];
  const groups = groupParams(params);
  assert.deepEqual(
    groups.map((g) => ({ group: g.group, count: g.params.length })),
    [{ group: '选项', count: 2 }, { group: '默认', count: 1 }],
  );
});

/* ============================================================
 * 4. 引脚连线状态 + setPinDefault（入命令栈）
 * ============================================================ */

test('connectedInputPins / effectivePinDefault', () => {
  const asset: IRAsset = {
    version: 2,
    name: '样本',
    entry: 'main',
    graphs: {
      main: {
        nodes: [irNode('br', 'flow.branch'), irNode('add', 'math.add')],
        edges: [
          { id: 'e1', from: { node: 'add', pin: 'value' }, to: { node: 'br', pin: 'cond' }, kind: 'data' },
        ],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
  const graph = asset.graphs['main']!;
  const connected = connectedInputPins(graph, 'br');
  assert.equal(connected.has('cond'), true, '已连线引脚在集合中');
  assert.equal(connected.has('exec'), false, '未连线引脚不在集合中');
  assert.equal(connectedInputPins(graph, 'add').size, 0);
  assert.equal(connectedInputPins(null, 'br').size, 0, '空图返回空集合');

  const branchSpec = builtinSpecMap.get('flow.branch')!;
  const condPin = branchSpec.inputs.find((p) => p.id === 'cond')!;
  const brNode = graph.nodes[0]!;
  assert.equal(effectivePinDefault(condPin, brNode), false, '缺省回落 PinSpec.defaultValue');
  brNode.pinDefaults['cond'] = true;
  assert.equal(effectivePinDefault(condPin, brNode), true, 'pinDefaults 优先');
});

test('store：setPinDefault 未连线可改（入命令栈可撤销）', () => {
  open();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    const addId = st.addNode('flow.delay', { x: 0, y: 0 });
    assert.ok(addId);
    st.setPinDefault(addId!, 'seconds', 2.5);
    const node = domainAsset().graphs['main']!.nodes.find((n) => n.id === addId)!;
    assert.equal(node.pinDefaults['seconds'], 2.5);
    assert.equal(peekUndo()?.label, '设置引脚默认值');
    undo();
    assert.equal(
      domainAsset().graphs['main']!.nodes.find((n) => n.id === addId)!.pinDefaults['seconds'],
      1.0,
      '撤销回落 spec 默认值',
    );
  } finally {
    detach();
  }
});

/* ============================================================
 * 5. 批量参数与图接口（store 层，Details 的提交目标）
 * ============================================================ */

test('store：setNodesParams 批量应用（单命令一次撤销）', () => {
  const asset = sampleAsset();
  asset.graphs['main']!.nodes.push(
    irNode('c1', 'math.compare', undefined, { op: '>' }),
    irNode('c2', 'math.compare', undefined, { op: '<' }),
  );
  open(asset);
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.setNodesParams(['c1', 'c2'], { op: '<=' });
    const nodes = domainAsset().graphs['main']!.nodes;
    assert.equal(nodes.find((n) => n.id === 'c1')!.params['op'], '<=');
    assert.equal(nodes.find((n) => n.id === 'c2')!.params['op'], '<=');
    assert.equal(peekUndo()?.label, '批量设置节点参数');
    undo();
    const restored = domainAsset().graphs['main']!.nodes;
    assert.equal(restored.find((n) => n.id === 'c1')!.params['op'], '>');
    assert.equal(restored.find((n) => n.id === 'c2')!.params['op'], '<', '各自还原到原值');
  } finally {
    detach();
  }
});

test('store：setGraphParams / setGraphReturns 编辑函数接口（可撤销）', () => {
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
    st.setGraphReturns('calc', [{ name: 'sum', type: 'float' }]);
    assert.deepEqual(domainAsset().graphs['calc']!.returns, [{ name: 'sum', type: 'float' }]);
    assert.equal(peekUndo()?.label, '编辑函数返回值');

    undo();
    assert.deepEqual(domainAsset().graphs['calc']!.returns, [], 'returns 还原');
    undo();
    assert.deepEqual(domainAsset().graphs['calc']!.params, [], 'params 还原');
  } finally {
    detach();
  }
});

/* ============================================================
 * 6. DOM 冒烟（happy-dom：Details 挂载与编辑链路）
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
const { Details } = await import('./Details');

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

/** React 受控输入框设值（native setter + input 事件） */
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}

/** React 受控下拉设值（native setter + change 事件） */
function setControlledSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
}

/** Details 样本：比较（select 参数 + 数据输入脚）+ 延时（数字脚）+ 已连线数据脚 */
function detailsAsset(): IRAsset {
  return {
    version: 2,
    name: '检视样本',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          irNode('cmp1', 'math.compare', { x: 0, y: 0 }, { op: '>' }),
          irNode('cmp2', 'math.compare', { x: 0, y: 120 }, { op: '<' }),
          irNode('delay1', 'flow.delay', { x: 300, y: 0 }),
        ],
        edges: [
          // cmp1 输出 → delay 的 seconds 数据脚（制造「已连线」引脚）
          { id: 'e1', from: { node: 'cmp1', pin: 'value' }, to: { node: 'delay1', pin: 'seconds' }, kind: 'data' },
        ],
      },
      calc: {
        nodes: [
          irNode('entry_1', 'func.entry', { x: 0, y: 0 }),
          irNode('return_1', 'func.return', { x: 280, y: 0 }),
        ],
        edges: [],
        params: [{ name: 'a', type: 'float' }],
        returns: [],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

test('DOM 冒烟：Details 选中单节点（标题/徽标/doc/参数控件 + select 即改即提交）', async () => {
  dom.document.body.innerHTML = '';
  open(detailsAsset());
  useBlueprintStore.getState().setSelection({ nodeIds: ['cmp1'], edgeIds: [] });
  const unmount = mount(createElement(Details, {}));
  try {
    assert.equal(dom.document.querySelector('.bp-det-header')?.textContent, 'Details');
    assert.equal(dom.document.querySelector('.bp-det-title')?.textContent, '比较', '节点标题');
    assert.equal(dom.document.querySelector('.bp-det-badge')?.textContent, '数学', '分类徽标');
    assert.ok(dom.document.querySelector('.bp-det-doc')?.textContent?.includes('比较'), 'doc 说明');

    // 参数控件：op 为 select 型
    const select = dom.document.querySelector('.bp-det-select') as unknown as HTMLSelectElement;
    assert.ok(select, 'select 控件渲染');
    assert.equal(select.value, '>', '当前值');
    act(() => {
      setControlledSelect(select, '<');
    });
    assert.equal(
      domainAsset().graphs['main']!.nodes.find((n) => n.id === 'cmp1')!.params['op'],
      '<',
      '改值落库（setNodeParams 入命令栈）',
    );
    assert.equal(peekUndo()?.label, '设置节点参数');

    // 引脚默认值：a / b 两个数据输入脚（未连线）→ number 编辑框
    const numberInputs = [...dom.document.querySelectorAll('.bp-det-input[type="number"]')] as unknown as HTMLInputElement[];
    assert.ok(numberInputs.length >= 2, '引脚默认值数字框渲染');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：Details 引脚默认值编辑（Enter 提交）+ 已连线置灰', async () => {
  dom.document.body.innerHTML = '';
  open(detailsAsset());
  useBlueprintStore.getState().setSelection({ nodeIds: ['delay1'], edgeIds: [] });
  const unmount = mount(createElement(Details, {}));
  try {
    // seconds：样本中被 cmp1 连线 → 显示「已连线」
    const linked = dom.document.querySelector('.bp-det-linked');
    assert.ok(linked, '已连线标记渲染');
    assert.equal(linked!.textContent, '已连线');

    // 改为未连线场景：断开连线后再看编辑框（store 更新须包 act 以同步刷新）
    act(() => {
      useBlueprintStore.getState().disconnectEdges(['e1']);
    });
    const input = dom.document.querySelector('.bp-det-input[type="number"]') as unknown as HTMLInputElement;
    assert.ok(input, '未连线数字框出现');
    act(() => {
      setControlledValue(input, '2.5');
    });
    act(() => {
      input.dispatchEvent(
        new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    const node = domainAsset().graphs['main']!.nodes.find((n) => n.id === 'delay1')!;
    assert.equal(node.pinDefaults['seconds'], 2.5, 'setPinDefault 落库');
    assert.equal(peekUndo()?.label, '设置引脚默认值');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：Details 多选混合态（「—」+ 批量应用）', async () => {
  dom.document.body.innerHTML = '';
  open(detailsAsset());
  useBlueprintStore.getState().setSelection({ nodeIds: ['cmp1', 'cmp2'], edgeIds: [] });
  const unmount = mount(createElement(Details, {}));
  try {
    assert.ok(dom.document.querySelector('.bp-det-title')?.textContent?.includes('已选 2 个节点'));
    const select = dom.document.querySelector('.bp-det-select') as unknown as HTMLSelectElement;
    assert.ok(select, '共同参数 select 渲染');
    assert.ok(select.className.includes('bp-det-input--mixed'), '混合态样式类');
    assert.equal(select.value, '', '混合态不显示具体值');

    // 批量应用：改为 '<=' → 两个节点统一
    act(() => {
      setControlledSelect(select, '<=');
    });
    const nodes = domainAsset().graphs['main']!.nodes;
    assert.equal(nodes.find((n) => n.id === 'cmp1')!.params['op'], '<=');
    assert.equal(nodes.find((n) => n.id === 'cmp2')!.params['op'], '<=');
    assert.equal(peekUndo()?.label, '批量设置节点参数');
  } finally {
    await unmount();
  }
});

test('DOM 冒烟：Details 无选中 → 主图设置 / 函数图接口编辑', async () => {
  dom.document.body.innerHTML = '';
  open(detailsAsset());
  const unmount = mount(createElement(Details, {}));
  try {
    // 主图（entry）：资产名 + 入口说明
    assert.equal(dom.document.querySelector('.bp-det-title')?.textContent, '检视样本');
    assert.equal(dom.document.querySelector('.bp-det-badge')?.textContent, '主图');
    assert.ok(dom.document.body.textContent?.includes('事件入口'), '入口说明');
  } finally {
    await unmount();
  }

  // 切到函数图 calc：入参 / 返回值接口编辑
  dom.document.body.innerHTML = '';
  act(() => {
    useBlueprintStore.getState().switchGraph('calc');
  });
  const unmount2 = mount(createElement(Details, {}));
  try {
    assert.equal(dom.document.querySelector('.bp-det-title')?.textContent, 'calc');
    assert.equal(dom.document.querySelector('.bp-det-badge')?.textContent, '函数');
    const rows = dom.document.querySelectorAll('.bp-det-row--iface');
    assert.equal(rows.length, 1, '入参 a 一行');

    // ＋入参 → 新行 → 填名 → 失焦提交
    const addBtn = [...dom.document.querySelectorAll('.bp-det-btn--wide')].find(
      (b) => b.textContent?.includes('入参'),
    ) as unknown as HTMLButtonElement;
    act(() => {
      addBtn.click();
    });
    const inputs = [...dom.document.querySelectorAll('.bp-det-row--iface .bp-det-input')] as unknown as HTMLInputElement[];
    assert.equal(inputs.length, 2, '新增一行');
    act(() => {
      setControlledValue(inputs[1]!, 'b');
    });
    act(() => {
      // React onBlur 走原生 focusout 委托；Enter 亦可提交，此处派发 focusout
      inputs[1]!.dispatchEvent(
        new dom.FocusEvent('focusout', { bubbles: true }) as unknown as Event,
      );
    });
    const params = domainAsset().graphs['calc']!.params!;
    assert.equal(params.length, 2);
    assert.equal(params[1]!.name, 'b');
    assert.equal(peekUndo()?.label, '编辑函数入参');

    // 类型下拉改 float → int（即改即提交）
    const typeSelects = [...dom.document.querySelectorAll('.bp-det-row--iface .bp-det-select')] as unknown as HTMLSelectElement[];
    act(() => {
      setControlledSelect(typeSelects[1]!, 'int');
    });
    assert.equal(domainAsset().graphs['calc']!.params![1]!.type, 'int');
  } finally {
    await unmount2();
  }
});
