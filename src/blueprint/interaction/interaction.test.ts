/**
 * Blueprint Studio v2 —— 画布交互纯函数单测（node:test，T2.2）
 *
 * 覆盖（任务卡 T2.2 测试清单）：
 *  1. suggestConverter 全表（string↔number / number→bool / bool→string / 可赋值不转换 / 数组与别名拒绝）
 *  2. 连线合法性预检 checkConnection + isConnectionShapeValid（复用 isTypeAssignable）
 *  3. 兼容节点过滤 compatibleSpecEntries / bestTargetPin（exec / 数据 / any / 数组）
 *  4. 剪贴板片段：collect / build / 文本往返 / 实例化（新 id + 连线重映射 + 变量补齐）
 *  5. 对齐 / 分布计算（吸附 10px 网格）
 *  6. 最近使用 LRU（去重 / 置顶 / 上限 8）
 *  7. 模糊搜索（子串 + 首字母 + 排序）与分类分组
 *  8. 新建节点初值（params / pinDefaults 取 spec 默认值）+ id 分配器
 *  9. duplicateSelection 使用的实例化路径（偏移 + id 重生成，与粘贴共用）
 * 10. store ↔ 命令栈接线（§8.2 第 9 条：openAsset 注册域 / 编辑动作入栈 /
 *     undo-redo 重放刷新镜像 / 跨图粘贴；全部走真实 runCommand）
 * 11. DOM 冒烟（happy-dom）：叶子交互组件挂载 + useCanvasInteractions 钩子接线
 *     （Tab/Esc/Ctrl+A/Delete/undo 链路、Alt+点击引脚断开的事件委托），
 *     UI 交互不强测——本节仅证明挂载与接线可用
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRGraph, IRNode, IRVariable, NodeSpec, Vec2 } from '../../ir/types';
import { NODE_CATEGORIES, builtinSpecMap } from '../../nodes';
import {
  getDomainState,
  peekUndo,
  peekRedo,
  redo,
  resetEditorStore,
  subscribeReplay,
  undo,
} from '../../shell/commands';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  bestTargetPin,
  buildFragment,
  collectFragment,
  compatibleSpecEntries,
  computeAlignedPositions,
  createIdAllocator,
  checkConnection,
  fragmentToText,
  groupEntriesByCategory,
  initialsOf,
  initialParams,
  initialPinDefaults,
  instancePrefixOf,
  instantiateFragment,
  isConnectionShapeValid,
  parseFragment,
  pushRecent,
  searchSpecEntries,
  snapToGrid,
  suggestConverter,
  GRID_SIZE,
  RECENT_LIMIT,
  type AlignEntry,
  type AlignMode,
  type PinRef,
} from './logic';
import { bpClipboard, readFragment, writeFragment } from './clipboard';

/* ============================================================
 * 样本构造
 * ============================================================ */

function irNode(id: string, type: string, position?: Vec2, params: Record<string, unknown> = {}): IRNode {
  return {
    id,
    type,
    params,
    pinDefaults: {},
    position: position ?? { x: 0, y: 0 },
  };
}

/** 连线预检样本：event.start → flow.branch → …（用 builtinSpecMap 解析引脚类型） */
function sampleNodes(): IRNode[] {
  return [
    irNode('ev', 'event.start', { x: 0, y: 0 }),
    irNode('br', 'flow.branch', { x: 200, y: 0 }),
    irNode('add', 'math.add', { x: 400, y: 0 }),
    irNode('add2', 'math.add', { x: 400, y: 160 }),
    irNode('len', 'string.length', { x: 200, y: 160 }),
    irNode('unk', 'phoneLog.read', { x: 600, y: 0 }),
  ];
}

const SPEC = builtinSpecMap;

/* ============================================================
 * 1. suggestConverter 全表
 * ============================================================ */

test('suggestConverter：可赋值组合返回 null（无需转换）', () => {
  assert.equal(suggestConverter('float', 'float'), null);
  assert.equal(suggestConverter('int', 'float'), null, 'int→float 数值加宽直接放行');
  assert.equal(suggestConverter('any', 'string'), null, 'any 双向可赋值');
  assert.equal(suggestConverter('string', 'any'), null);
  assert.equal(suggestConverter('string[]', 'string[]'), null, '数组同形可赋值');
  assert.equal(suggestConverter('int[]', 'float[]'), null, '数组元素级加宽');
  assert.equal(suggestConverter('exec', 'exec'), null, 'exec 连线不走转换节点');
});

test('suggestConverter：string↔number / number→bool / bool→string 全表', () => {
  // → string
  assert.equal(suggestConverter('int', 'string'), 'convert.toString');
  assert.equal(suggestConverter('float', 'string'), 'convert.toString');
  assert.equal(suggestConverter('bool', 'string'), 'convert.toString');
  assert.equal(suggestConverter('object', 'string'), 'convert.toString');
  // → float / int
  assert.equal(suggestConverter('string', 'float'), 'convert.toNumber');
  assert.equal(suggestConverter('bool', 'float'), 'convert.toNumber');
  assert.equal(suggestConverter('string', 'int'), 'convert.parseInt');
  assert.equal(suggestConverter('float', 'int'), 'convert.parseInt', '收窄走解析整数');
  assert.equal(suggestConverter('bool', 'int'), 'convert.parseInt');
  // → bool
  assert.equal(suggestConverter('string', 'bool'), 'convert.toBool');
  assert.equal(suggestConverter('int', 'bool'), 'convert.toBool');
  assert.equal(suggestConverter('float', 'bool'), 'convert.toBool');
});

test('suggestConverter：数组 / 自定义别名 / 未知方向无转换器（拒绝）', () => {
  assert.equal(suggestConverter('string[]', 'float'), null, '数组→标量不做自动转换');
  assert.equal(suggestConverter('float', 'string[]'), null);
  assert.equal(suggestConverter('LogRow', 'string'), null, '自定义别名保守拒绝');
  assert.equal(suggestConverter('object', 'int'), null);
});

test('suggestConverter：any→数组可赋值（isTypeAssignable 语义对齐）', () => {
  assert.equal(suggestConverter('any', 'any[]'), null, 'any→any[] 可赋值无需转换');
});

/* ============================================================
 * 2. 连线合法性预检
 * ============================================================ */

test('checkConnection：exec 连线 ok；数据线可赋值 ok；int→float ok', () => {
  const nodes = sampleNodes();
  const exec = checkConnection(SPEC, nodes, { node: 'ev', pin: 'exec' }, { node: 'br', pin: 'exec' });
  assert.equal(exec.verdict, 'ok');
  assert.equal(exec.kind, 'exec');

  const data = checkConnection(SPEC, nodes, { node: 'add', pin: 'value' }, { node: 'add2', pin: 'a' });
  assert.equal(data.verdict, 'ok');
  assert.equal(data.kind, 'data');

  const widen = checkConnection(SPEC, nodes, { node: 'len', pin: 'value' }, { node: 'add2', pin: 'b' });
  assert.equal(widen.verdict, 'ok', 'string.length 输出 int → float 可赋值');
});

test('checkConnection：类型不符 → 建议转换节点；无法转换 → 拒绝', () => {
  const nodes = sampleNodes();
  // float → bool：插 convert.toBool
  const conv = checkConnection(SPEC, nodes, { node: 'add', pin: 'value' }, { node: 'br', pin: 'cond' });
  assert.equal(conv.verdict, 'converter');
  assert.ok(conv.verdict === 'converter' && conv.converterId === 'convert.toBool');

  // string → bool：插 convert.toBool
  const conv2 = checkConnection(
    SPEC,
    [...nodes, irNode('cat', 'string.concat', { x: 0, y: 0 })],
    { node: 'cat', pin: 'value' },
    { node: 'br', pin: 'cond' },
  );
  assert.ok(conv2.verdict === 'converter' && conv2.converterId === 'convert.toBool');

  // 数组 → 标量：无转换器，拒绝
  const bad = checkConnection(
    SPEC,
    [...nodes, irNode('log', 'convert.androidLogParse', { x: 0, y: 300 })],
    { node: 'log', pin: 'rows' },
    { node: 'add2', pin: 'a' },
  );
  assert.equal(bad.verdict, 'reject');
  assert.ok(bad.verdict === 'reject' && bad.reason === 'incompatible');
  assert.ok(bad.message.includes('不兼容'), '拒绝信息面向用户（中文）');
});

test('checkConnection：exec 与数据互连 / 同节点 / 端点缺失 → 拒绝', () => {
  const nodes = sampleNodes();
  // exec 出 → 数据入
  const execToData = checkConnection(SPEC, nodes, { node: 'ev', pin: 'exec' }, { node: 'add2', pin: 'a' });
  assert.ok(execToData.verdict === 'reject' && execToData.reason === 'exec-vs-data');
  // 数据出 → exec 入
  const dataToExec = checkConnection(SPEC, nodes, { node: 'add', pin: 'value' }, { node: 'br', pin: 'exec' });
  assert.ok(dataToExec.verdict === 'reject' && dataToExec.reason === 'exec-vs-data');
  // 同节点
  const self = checkConnection(SPEC, nodes, { node: 'add', pin: 'value' }, { node: 'add', pin: 'a' });
  assert.ok(self.verdict === 'reject' && self.reason === 'same-node');
  // 端点缺失（节点不存在）
  const ghost = checkConnection(SPEC, nodes, { node: 'ghost', pin: 'exec' }, { node: 'br', pin: 'exec' });
  assert.ok(ghost.verdict === 'reject' && ghost.reason === 'unknown-endpoint');
});

test('checkConnection：未知节点降级按 any（允许接线，T2.1 降级样式可锚定）', () => {
  const nodes = sampleNodes();
  const v = checkConnection(SPEC, nodes, { node: 'unk', pin: 'rows' }, { node: 'add2', pin: 'a' });
  assert.equal(v.verdict, 'ok', '未知节点引脚类型按 any 处理');
});

test('isConnectionShapeValid：exec↔data 不互吸 / 同节点 / 重复线 → false', () => {
  const nodes = sampleNodes();
  const edges = [
    { id: 'e1', from: { node: 'ev', pin: 'exec' }, to: { node: 'br', pin: 'exec' }, kind: 'exec' as const },
  ];
  assert.equal(isConnectionShapeValid(SPEC, nodes, edges, { node: 'ev', pin: 'exec' }, { node: 'br', pin: 'exec' }), false, '重复连线');
  assert.equal(isConnectionShapeValid(SPEC, nodes, edges, { node: 'ev', pin: 'exec' }, { node: 'add2', pin: 'a' }), false, 'exec↔data');
  assert.equal(isConnectionShapeValid(SPEC, nodes, edges, { node: 'add', pin: 'value' }, { node: 'add', pin: 'a' }), false, '同节点');
  assert.equal(isConnectionShapeValid(SPEC, nodes, edges, { node: 'add', pin: 'value' }, { node: 'add2', pin: 'a' }), true, '数据线放行（转换决策在 onConnect）');
  // 数据类型不符也放行（isValidConnection 不做可赋值判定，转换节点在 onConnect 插入）
  assert.equal(isConnectionShapeValid(SPEC, nodes, edges, { node: 'add', pin: 'value' }, { node: 'br', pin: 'cond' }), true);
});

/* ============================================================
 * 3. 兼容节点过滤（引脚拖出菜单）
 * ============================================================ */

function outRef(nodeType: string, pinId: string, type: PinRef['type']): PinRef {
  return { nodeId: `__${nodeType}`, pinId, dir: 'out', type };
}
function inRef(nodeType: string, pinId: string, type: PinRef['type']): PinRef {
  return { nodeId: `__${nodeType}`, pinId, dir: 'in', type };
}

test('bestTargetPin：精确类型 > any > 可赋值；exec 只挑 exec', () => {
  const branch = SPEC.get('flow.branch')!;
  assert.equal(bestTargetPin(branch.inputs, 'exec')?.id, 'exec', 'exec 引脚优先惯例 id');
  assert.equal(bestTargetPin(branch.inputs, 'bool')?.id, 'cond');
  assert.equal(bestTargetPin(branch.inputs, 'float'), null, 'float→bool 菜单严格模式不接（转换走连线流程）');
  const add = SPEC.get('math.add')!;
  assert.equal(bestTargetPin(add.inputs, 'float')?.id, 'a', '同分取首个');
  assert.equal(bestTargetPin(add.outputs, 'string'), null, '输出组无兼容项');
  const getVar = SPEC.get('var.get')!;
  assert.equal(bestTargetPin(getVar.outputs, 'float')?.id, 'value', 'any 输出可接');
});

test('兼容菜单：exec 输出只列有 exec 输入的节点（纯节点排除）', () => {
  const entries = compatibleSpecEntries(SPEC, outRef('event.start', 'exec', 'exec'));
  const ids = new Set(entries.map((e) => e.spec.id));
  assert.ok(ids.has('flow.branch'), '分支有 exec 输入');
  assert.ok(ids.has('var.set'), 'Set 变量有 exec 输入');
  assert.ok(ids.has('flow.delay'), '延时节点有 exec 输入');
  assert.ok(!ids.has('math.add'), '纯节点无 exec 输入，排除');
  assert.ok(!ids.has('var.get'), 'Get 变量无输入，排除');
  assert.ok(!ids.has('event.start'), '事件入口无输入，排除');
  for (const entry of entries) {
    assert.ok(entry.pin && entry.pin.type === 'exec', '推荐接入引脚必为 exec');
  }
});

test('兼容菜单：float 输出只列可接入的数据节点（assignable / any）', () => {
  const entries = compatibleSpecEntries(SPEC, outRef('math.add', 'value', 'float'));
  const ids = new Set(entries.map((e) => e.spec.id));
  assert.ok(ids.has('math.add'), '同类型节点可拖出再连（新实例）');
  assert.ok(ids.has('convert.toNumber'), 'any 输入可接 float');
  assert.ok(ids.has('convert.androidLogParse'), 'lines 输入 any');
  assert.ok(!ids.has('string.upper'), 'string 输入不接 float（严格模式，转换走连线流程）');
  assert.ok(!ids.has('flow.branch'), 'bool 输入不接 float');
  assert.ok(!ids.has('array.length'), 'any[] 输入不接 float（数组形不兼容）');
  for (const entry of entries) {
    assert.ok(entry.pin && entry.pin.type !== 'exec', '数据拖出菜单不推荐 exec 引脚');
  }
});

test('兼容菜单：trait 交集过滤（v3 T12.4）', () => {
  const from: PinRef = { nodeId: 'x', pinId: 'value', dir: 'out', type: 'string', traits: ['value'] };
  const ids = new Set(compatibleSpecEntries(SPEC, from).map((e) => e.spec.id));
  assert.ok(ids.has('ui.setValue'), 'value trait 保留');
  assert.ok(!ids.has('ui.setText'), 'text trait 被过滤');
  assert.ok(!ids.has('ui.listSetItems'), 'items trait 被过滤');
  assert.ok(ids.has('system.print'), '未声明 trait 的节点不受限制');
});

test('兼容菜单：string / any 输出与数组输出', () => {
  const fromString = compatibleSpecEntries(SPEC, outRef('string.concat', 'value', 'string'));
  const ids = new Set(fromString.map((e) => e.spec.id));
  assert.ok(ids.has('string.upper'));
  assert.ok(ids.has('system.print'), 'print 的 text 输入 string');
  assert.ok(!ids.has('math.add'), '数值输入不接 string');

  const fromAny = compatibleSpecEntries(SPEC, outRef('var.get', 'value', 'any'));
  const anyIds = new Set(fromAny.map((e) => e.spec.id));
  assert.ok(anyIds.has('math.add'), 'any→float 可赋值');
  assert.ok(anyIds.has('array.length'), 'any→any[] 可赋值（any 双向）');
  assert.ok(anyIds.has('flow.branch'), 'any→bool 可赋值');

  const fromRows = compatibleSpecEntries(SPEC, outRef('convert.androidLogParse', 'rows', 'LogRow[]'));
  const rowIds = new Set(fromRows.map((e) => e.spec.id));
  assert.ok(rowIds.has('array.length'), 'LogRow[] → any[]（元素 any）可赋值');
  assert.ok(!rowIds.has('math.add'), 'LogRow[] 不接 float');
});

test('兼容菜单：从输入引脚反拖（列出输出可接入的节点）', () => {
  // float 输入 ← 谁能供给：输出 float / any / int 的节点
  const entries = compatibleSpecEntries(SPEC, inRef('math.add', 'a', 'float'));
  const ids = new Set(entries.map((e) => e.spec.id));
  assert.ok(ids.has('math.add'), 'add 输出 float');
  assert.ok(ids.has('var.get'), 'get 输出 any');
  assert.ok(ids.has('string.length'), 'length 输出 int（int→float 可赋值）');
  assert.ok(ids.has('convert.androidLogParse'), 'count 输出 int 可接');
  assert.ok(!ids.has('flow.branch'), 'branch 输出仅 exec');

  // exec 输入 ← 有 exec 出口的节点
  const execEntries = compatibleSpecEntries(SPEC, inRef('flow.branch', 'exec', 'exec'));
  const execIds = new Set(execEntries.map((e) => e.spec.id));
  assert.ok(execIds.has('event.start'));
  assert.ok(execIds.has('flow.sequence'));
  assert.ok(execIds.has('var.set'));
  assert.ok(!execIds.has('math.add'), '纯节点无 exec 出口');
});

/* ============================================================
 * 4. 搜索与分组
 * ============================================================ */

test('initialsOf：camelCase / 点分 / 空格分词提取首字母', () => {
  assert.equal(initialsOf('convert.toNumber'), 'ctn');
  assert.equal(initialsOf('get ui'), 'gu');
  assert.equal(initialsOf('解析Android日志'), 'a', 'ASCII 词才取首字母（中文不计）');
});

test('searchSpecEntries：子串 / 首字母 / 关键词匹配与排序', () => {
  const entries = [...SPEC.values()].map((spec) => ({ spec, pin: null }));
  assert.equal(entries.length, SPEC.size);

  // 中文子串（标题）
  const zh = searchSpecEntries(entries, '分支');
  assert.equal(zh[0]?.spec.id, 'flow.branch', '精确标题排最前');

  // ASCII 子串（id / 关键词）
  const en = searchSpecEntries(entries, 'branch');
  assert.ok(en.some((e) => e.spec.id === 'flow.branch'));

  // 关键词
  assert.ok(searchSpecEntries(entries, '加法').some((e) => e.spec.id === 'math.add'));

  // 首字母子序列：'cn' → convert.toNumber（convert + toNumber 首字母 ctn）
  const initials = searchSpecEntries(entries, 'cn');
  assert.ok(initials.some((e) => e.spec.id === 'convert.toNumber'), '首字母匹配');

  // camelCase 词首字母：'tn' → convert.toNumber
  assert.ok(searchSpecEntries(entries, 'tn').some((e) => e.spec.id === 'convert.toNumber'));

  // 无匹配
  assert.deepEqual(searchSpecEntries(entries, 'zzzz不存在的节点'), []);

  // 空查询：原样返回（分类浏览）
  assert.equal(searchSpecEntries(entries, '').length, entries.length);
  assert.equal(searchSpecEntries(entries, '  ').length, entries.length);
});

test('groupEntriesByCategory：按节点库分类顺序分组，未知分类排最后', () => {
  const branch = SPEC.get('flow.branch')!;
  const add = SPEC.get('math.add')!;
  const custom: NodeSpec = { id: 'x.y', title: 'X', category: '自定义', inputs: [], outputs: [] };
  const groups = groupEntriesByCategory(
    [
      { spec: add, pin: null },
      { spec: custom, pin: null },
      { spec: branch, pin: null },
    ],
    NODE_CATEGORIES,
  );
  assert.deepEqual(
    groups.map((g) => g.category),
    ['流程', '数学', '自定义'],
    '按 NODE_CATEGORIES 顺序，未知分类垫底',
  );
  assert.deepEqual(groups[0].entries.map((e) => e.spec.id), ['flow.branch']);
});

/* ============================================================
 * 5. 剪贴板片段（复制粘贴 / 跨图跨资产）
 * ============================================================ */

/** 片段样本：A(event) → B(branch)，V(var.get:hp) → B.cond，M(add) 连到外部 X */
function fragmentSample(): { graph: IRGraph; variables: IRVariable[] } {
  const graph: IRGraph = {
    nodes: [
      irNode('A', 'event.start', { x: 0, y: 0 }),
      irNode('B', 'flow.branch', { x: 200, y: 0 }),
      irNode('V', 'var.get', { x: 0, y: 200 }, { varName: 'hp' }),
      irNode('M', 'math.add', { x: 400, y: 0 }),
      irNode('X', 'system.print', { x: 600, y: 0 }),
    ],
    edges: [
      { id: 'ex1', from: { node: 'A', pin: 'exec' }, to: { node: 'B', pin: 'exec' }, kind: 'exec' },
      { id: 'da1', from: { node: 'V', pin: 'value' }, to: { node: 'B', pin: 'cond' }, kind: 'data' },
      { id: 'exOut', from: { node: 'B', pin: 'true' }, to: { node: 'M', pin: 'exec' }, kind: 'exec' },
      { id: 'daOut', from: { node: 'M', pin: 'value' }, to: { node: 'X', pin: 'text' }, kind: 'data' },
    ],
  };
  const variables: IRVariable[] = [
    { name: 'hp', type: 'float', default: 100 },
    { name: 'mp', type: 'float' },
  ];
  return { graph, variables };
}

test('collectFragment：只带走选区节点与选区内部连线（外部连线不带走）', () => {
  const { graph } = fragmentSample();
  const picked = collectFragment(graph, new Set(['A', 'B', 'V']));
  assert.deepEqual(picked.nodes.map((n) => n.id).sort(), ['A', 'B', 'V']);
  assert.deepEqual(picked.edges.map((e) => e.id).sort(), ['da1', 'ex1'], '连到 M/X 的边不进片段');
});

test('剪贴板片段：build → text → parse 往返无损；非法文本拒绝', () => {
  const { graph, variables } = fragmentSample();
  const picked = collectFragment(graph, new Set(['A', 'B', 'V']));
  const fragment = buildFragment(picked.nodes, picked.edges, variables);
  assert.equal(fragment.__bps, 'ir-fragment');
  assert.equal(fragment.v, 1);
  assert.deepEqual(fragment.variables, [{ name: 'hp', type: 'float', default: 100 }], '引用变量定义入片段');

  const text = fragmentToText(fragment);
  const back = parseFragment(text);
  assert.deepEqual(back, fragment, '文本往返无损');

  assert.equal(parseFragment('不是 JSON'), null);
  assert.equal(parseFragment('{"__bps":"别的格式","v":1,"nodes":[],"edges":[]}'), null);
  assert.equal(parseFragment('{"__bps":"ir-fragment","v":2,"nodes":[],"edges":[]}'), null, '版本不符拒绝');
  assert.equal(parseFragment('{"__bps":"ir-fragment","v":1}'), null, '缺 nodes/edges 拒绝');
  assert.equal(parseFragment(null), null);
  assert.equal(parseFragment(''), null);
});

test('实例化片段：新 id 重生成 + 连线端点重映射 + 位置偏移（duplicateSelection / paste 共用路径）', () => {
  const { graph, variables } = fragmentSample();
  const picked = collectFragment(graph, new Set(['A', 'B', 'V']));
  const fragment = buildFragment(picked.nodes, picked.edges, variables);

  const inst = instantiateFragment(fragment, ['start_1', 'branch_1', 'X'], [], { x: 20, y: 20 });
  // 新 id：前缀取 spec 尾词 + 序号，避开既有 id
  const newIds = inst.nodes.map((n) => n.id);
  assert.ok(!newIds.includes('branch_1'), '与既有 id 冲突的自动跳号');
  assert.ok(newIds.some((id) => id.startsWith('start_')), 'event.start → start_*');
  assert.ok(newIds.some((id) => id.startsWith('branch_')), 'flow.branch → branch_*');
  assert.ok(newIds.every((id) => !['A', 'B', 'V'].includes(id)), '旧 id 全部重生成');

  // 位置偏移 20px（实例化保持片段节点顺序，按下标对应）
  assert.equal(inst.nodes.length, fragment.nodes.length);
  inst.nodes.forEach((node, i) => {
    const old = fragment.nodes[i];
    assert.equal(node.position.x, old.position.x + 20, `节点 ${old.id} 偏移 x`);
    assert.equal(node.position.y, old.position.y + 20, `节点 ${old.id} 偏移 y`);
  });

  // 连线重映射：内部连线保留且端点换新 id；越界连线剔除
  assert.equal(inst.edges.length, 2, 'exOut / daOut 不在选区，不带入');
  for (const e of inst.edges) {
    assert.ok(newIds.includes(e.from.node) && newIds.includes(e.to.node), '连线端点全部指向新节点');
  }
  const execEdge = inst.edges.find((e) => e.kind === 'exec')!;
  const dataEdge = inst.edges.find((e) => e.kind === 'data')!;
  assert.equal(execEdge.kind, 'exec');
  assert.equal(dataEdge.kind, 'data');
  assert.notEqual(execEdge.id, dataEdge.id, '连线 id 重新分配');
  // 端点重映射正确：exec 边 A.exec→B.exec 应映射为 start_*→branch_*
  assert.ok(execEdge.from.node.startsWith('start_') && execEdge.to.node.startsWith('branch_'));
  // 数据边 V.value→B.cond 应映射为 get_*→branch_*
  assert.ok(dataEdge.from.node.startsWith('get_') && dataEdge.to.node.startsWith('branch_'));
});

test('实例化片段：引用变量缺失 → 合并定义；已存在 → 不重复', () => {
  const { graph, variables } = fragmentSample();
  const picked = collectFragment(graph, new Set(['A', 'B', 'V']));
  const fragment = buildFragment(picked.nodes, picked.edges, variables);

  // 目标资产没有 hp → 合并定义
  const merged = instantiateFragment(fragment, [], [], { x: 0, y: 0 });
  assert.deepEqual(merged.variables, [{ name: 'hp', type: 'float', default: 100 }]);

  // 目标资产已有 hp → 不重复；且目标中无引用时为空
  const same = instantiateFragment(fragment, [], variables, { x: 0, y: 0 });
  assert.deepEqual(same.variables, [], '目标已存在同名变量不重复合并');
});

test('id 分配器：跳过既有 id，同前缀连续分配', () => {
  const alloc = createIdAllocator(['start_1', 'branch_1', 'e_2']);
  assert.equal(alloc.next('branch'), 'branch_2');
  assert.equal(alloc.next('branch'), 'branch_3');
  assert.equal(alloc.next('start'), 'start_2', '既有 start_1 跳过');
  assert.equal(alloc.next('e'), 'e_1');
  assert.equal(alloc.next('e'), 'e_3', '既有 e_2 跳过');
  const alloc2 = createIdAllocator([]);
  assert.equal(alloc2.next('node'), 'node_1');
});

test('instancePrefixOf / snapToGrid', () => {
  assert.equal(instancePrefixOf('flow.branch'), 'branch');
  assert.equal(instancePrefixOf('var.get'), 'get');
  assert.equal(instancePrefixOf('phoneLog.read'), 'read');
  assert.equal(instancePrefixOf('custom'), 'custom');
  assert.equal(snapToGrid(123, GRID_SIZE), 120);
  assert.equal(snapToGrid(127, GRID_SIZE), 130);
  assert.equal(snapToGrid(-3, GRID_SIZE), 0);
});

/* ============================================================
 * 6. 对齐 / 分布（吸附 10px 网格）
 * ============================================================ */

function alignEntry(id: string, x: number, y: number): AlignEntry {
  return { id, position: { x, y }, size: { width: 10, height: 10 } };
}

test('对齐：左对齐取最小 x，上对齐取最小 y，全部吸附 10px 网格', () => {
  const entries = [alignEntry('a', 23, 40), alignEntry('b', 55, 10), alignEntry('c', 102, 80)];
  const left = computeAlignedPositions(entries, 'left');
  assert.deepEqual([...left.values()].map((p) => p.x), [20, 20, 20], '最小 x=23 吸附到 20');
  assert.equal(left.get('a')?.y, 40, '非对齐轴不动');
  const top = computeAlignedPositions(entries, 'top');
  assert.deepEqual([...top.values()].map((p) => p.y), [10, 10, 10]);
  assert.equal(top.get('b')?.x, 60, 'x=55 吸附到 60');
});

test('分布：三点水平 / 垂直均匀分布（首尾不动，等分间距）', () => {
  const entries = [alignEntry('a', 0, 0), alignEntry('b', 100, 30), alignEntry('c', 300, 60)];
  const distH = computeAlignedPositions(entries, 'distribute-h');
  assert.equal(distH.get('a')?.x, 0);
  assert.equal(distH.get('b')?.x, 150, '首尾间等分：0→300 三点间距 150');
  assert.equal(distH.get('c')?.x, 300);
  assert.equal(distH.get('b')?.y, 30, '另一轴不动');

  const distV = computeAlignedPositions(entries, 'distribute-v');
  assert.equal(distV.get('b')?.y, 30, 'y 0→60 中点 30（吸附不变）');
  assert.equal(distV.get('a')?.y, 0);
  assert.equal(distV.get('c')?.y, 60);
});

test('分布：少于 3 个 → 仅吸附；分布时非分布轴同样吸附', () => {
  const two = [alignEntry('a', 0, 0), alignEntry('b', 100, 0)];
  const out = computeAlignedPositions(two, 'distribute-h');
  assert.equal(out.size, 2);
  assert.equal(out.get('b')?.x, 100, '两点不分布');

  const rows = [alignEntry('a', 0, 5), alignEntry('b', 50, 5), alignEntry('c', 100, 5)];
  const out2 = computeAlignedPositions(rows, 'distribute-h');
  assert.equal(out2.get('b')?.x, 50, 'x 已均匀则不变');
  assert.equal(out2.get('a')?.y, 10, '非分布轴 y=5 吸附到 10');
});

/* ============================================================
 * 7. 最近使用 LRU
 * ============================================================ */

test('pushRecent：置顶 + 去重 + 上限 8', () => {
  assert.equal(RECENT_LIMIT, 8);
  let list: string[] = [];
  for (const id of ['a', 'b', 'c']) list = pushRecent(list, id);
  assert.deepEqual(list, ['c', 'b', 'a']);
  list = pushRecent(list, 'a');
  assert.deepEqual(list, ['a', 'c', 'b'], '重复置顶不重复');
  for (let i = 0; i < 10; i++) list = pushRecent(list, `n${i}`);
  assert.equal(list.length, 8, '上限截断');
  assert.deepEqual(list[0], 'n9');
  assert.deepEqual(pushRecent(['x'], 'x'), ['x'], '等值去重后仍保留');
});

/* ============================================================
 * 8. 新建节点初值
 * ============================================================ */

test('initialParams / initialPinDefaults：取 spec 默认值；undefined 不写入', () => {
  assert.deepEqual(initialParams(SPEC.get('convert.timeFormat')!), { format: 'MM-DD HH:mm:SS' });
  assert.deepEqual(initialParams(SPEC.get('flow.branch')!), {}, '无参数节点为空');
  assert.deepEqual(initialPinDefaults(SPEC.get('flow.branch')!), { cond: false }, 'bool 条件默认 false');
  assert.deepEqual(initialPinDefaults(SPEC.get('var.set')!), { value: null });
  assert.deepEqual(initialPinDefaults(SPEC.get('var.get')!), {}, '无输入引脚为空');
  assert.deepEqual(initialParams(SPEC.get('math.add')!), {});
});

/* ============================================================
 * 9. 剪贴板桥（内存兜底路径；node 环境无 navigator）
 * ============================================================ */

test('bpClipboard：内存兜底写入 / 读取，片段往返（系统剪贴板不可用时应用内粘贴可用）', async () => {
  bpClipboard.clearMemory();
  const { graph, variables } = fragmentSample();
  const picked = collectFragment(graph, new Set(['A', 'B', 'V']));
  const fragment = buildFragment(picked.nodes, picked.edges, variables);

  await writeFragment(fragment);
  assert.ok(bpClipboard.peekMemory()?.includes('"ir-fragment"'), '内存剪贴板持有片段文本');

  const back = await readFragment();
  assert.deepEqual(back, fragment, '读回片段一致（跨图 / 跨资产粘贴的载体）');

  // 非片段文本不应被误认为片段
  await bpClipboard.writeText('普通文本');
  assert.equal(await readFragment(), null);
});

/* ============================================================
 * 10. store ↔ 命令栈接线（§8.2 第 9 条：所有编辑动作入栈可撤销）
 * ============================================================ */

/** store 接线样本资产：main（事件+分支+变量节点）/ aux（空函数子图） */
function sampleAsset(): IRAsset {
  return {
    version: 2,
    name: '样本',
    entry: 'main',
    graphs: {
      main: {
        nodes: [
          irNode('ev', 'event.start', { x: 0, y: 0 }),
          { ...irNode('br', 'flow.branch', { x: 200, y: 0 }), pinDefaults: { cond: false } },
          irNode('v1', 'var.get', { x: 0, y: 200 }, { varName: 'hp' }),
        ],
        edges: [],
      },
      aux: { nodes: [], edges: [] },
    },
    variables: [{ name: 'hp', type: 'float' }],
    events: [],
    snippets: [],
    layout: {},
  };
}

/** 按钩子的方式接镜像刷新（useCanvasInteractions 同款订阅；隔离测试用） */
function attachMirrorRefresh(): () => void {
  return subscribeReplay((notice) => {
    if (notice.domains.includes('blueprint')) {
      useBlueprintStore.getState().refreshFromDomain();
    }
  });
}

function domainGraph(): IRGraph {
  const domain = getDomainState<{ asset: IRAsset }>('blueprint');
  return domain.asset.graphs[useBlueprintStore.getState().graphName]!;
}

test('store 接线：openAsset 注册命令域；addNode 经 runCommand 入栈，undo/redo 真实还原', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.openAsset(sampleAsset(), 'logic/main.bp.json');
    assert.ok(useBlueprintStore.getState().asset, 'openAsset 后 store 有资产');
    assert.equal(useBlueprintStore.getState().graphName, 'main', 'entry 图为当前图');

    const id = st.addNode('math.add', { x: 123, y: 47 });
    assert.ok(id, 'addNode 返回新节点 id');
    assert.ok(domainGraph().nodes.some((n) => n.id === id), '命令已落域状态');
    assert.equal(domainGraph().nodes.find((n) => n.id === id)?.position, useBlueprintStore.getState().asset!.graphs['main']!.nodes.find((n) => n.id === id)?.position, '镜像与域状态同步');
    assert.equal(useBlueprintStore.getState().asset, getDomainState<{ asset: IRAsset }>('blueprint').asset, '镜像与域状态同引用');
    const undoMeta = peekUndo();
    assert.ok(undoMeta && undoMeta.domain === 'blueprint' && undoMeta.label === '添加节点', '命令入统一栈（域 blueprint）');

    const notice = undo();
    assert.ok(notice && notice.domains.includes('blueprint'), 'undo 返回重放报告');
    assert.ok(!domainGraph().nodes.some((n) => n.id === id), 'undo 后域状态还原');
    assert.ok(!useBlueprintStore.getState().asset!.graphs['main']!.nodes.some((n) => n.id === id), 'undo 后镜像经 subscribeReplay 刷新');
    assert.ok(peekRedo()?.label === '添加节点');

    redo();
    assert.ok(domainGraph().nodes.some((n) => n.id === id), 'redo 恢复');
  } finally {
    detach();
  }
});

test('store 接线：数据线类型不符 → 自动插转换节点为单命令（撤销一次全还原）', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.openAsset(sampleAsset());
    const addId = st.addNode('math.add', { x: 0, y: 0 });
    const brId = st.addNode('flow.branch', { x: 200, y: 0 });
    assert.ok(addId && brId);

    const ok = st.connect({ node: addId, pin: 'value' }, { node: brId, pin: 'cond' });
    assert.equal(ok, true, 'float→bool 自动转换建线成功');
    const graph = domainGraph();
    const conv = graph.nodes.find((n) => n.type === 'convert.toBool');
    assert.ok(conv, '转换节点入图');
    assert.equal(
      graph.edges.filter((e) => e.kind === 'data' && (e.from.node === conv!.id || e.to.node === conv!.id)).length,
      2,
      '转换节点两端各一条数据线',
    );
    assert.ok(peekUndo()?.label === '自动插入转换节点');

    undo();
    const after = domainGraph();
    assert.ok(!after.nodes.some((n) => n.type === 'convert.toBool'), '一次撤销连转换节点一起还原');
    assert.equal(after.edges.length, 0, '两条连线同命令还原');
  } finally {
    detach();
  }
});

test('store 接线：删除 / 断开 / 移动 / 引脚默认值 / 复制粘贴全部落栈可撤销', async () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.openAsset(sampleAsset());
    // 删除选中（含挂接连线）
    st.setSelection({ nodeIds: ['ev'], edgeIds: [] });
    st.deleteSelection();
    assert.ok(peekUndo()?.label === '删除选中');
    undo();
    assert.equal(domainGraph().nodes.filter((n) => n.id === 'ev').length, 1, '删除可撤销');
    // 移动
    st.moveNodes([{ id: 'ev', position: { x: 30, y: 40 } }]);
    assert.ok(peekUndo()?.label === '移动节点');
    assert.equal(domainGraph().nodes.find((n) => n.id === 'ev')?.position.x, 30);
    undo();
    assert.equal(domainGraph().nodes.find((n) => n.id === 'ev')?.position.x, 0, '移动可撤销');
    // 引脚默认值
    st.setPinDefault('br', 'cond', true);
    assert.ok(peekUndo()?.label === '设置引脚默认值');
    assert.equal(domainGraph().nodes.find((n) => n.id === 'br')?.pinDefaults['cond'], true);
    undo();
    assert.equal(domainGraph().nodes.find((n) => n.id === 'br')?.pinDefaults['cond'], false, '引脚默认值可撤销');
    // 连线 + 右键断开 + Alt 引脚断开
    assert.ok(st.connect({ node: 'ev', pin: 'exec' }, { node: 'br', pin: 'exec' }));
    const edgeId = domainGraph().edges[0]!.id;
    st.disconnectEdges([edgeId]);
    assert.ok(peekUndo()?.label === '断开连线');
    undo();
    assert.equal(domainGraph().edges.length, 1, '断开可撤销');
    st.disconnectPin('br', 'exec', 'in');
    assert.ok(peekUndo()?.label?.startsWith('断开引脚连线'));
    undo();
    assert.equal(domainGraph().edges.length, 1, '引脚断开可撤销');
    // 复制 / 粘贴（同图偏移 20px 新 id）
    st.setSelection({ nodeIds: ['v1'], edgeIds: [] });
    const copied = await st.copySelection();
    assert.equal(copied, 1, '复制返回节点数');
    const pasted = await st.paste();
    assert.equal(pasted, 1, '粘贴返回节点数');
    const graph = domainGraph();
    const pastedNode = graph.nodes[graph.nodes.length - 1]!;
    assert.ok(pastedNode.id !== 'v1', '粘贴生成新 id');
    assert.equal(pastedNode.position.x, graph.nodes.find((n) => n.id === 'v1')!.position.x + 20, '同图粘贴偏移 20px');
    assert.ok(peekUndo()?.label === '粘贴节点');
    undo();
    assert.ok(!domainGraph().nodes.some((n) => n.params['varName'] === 'hp' && n.id !== 'v1'), '粘贴可撤销');
    // Ctrl+D 复制选中（duplicateSelection 与拖拽复制共用）
    st.setSelection({ nodeIds: ['br'], edgeIds: [] });
    assert.equal(st.duplicateSelection(), 1);
    assert.ok(peekUndo()?.label === '复制节点');
    undo();
  } finally {
    detach();
  }
});

test('store 接线：复制 → 切图 → 粘贴跨图可用（片段独立于当前图）', async () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    const st = useBlueprintStore.getState();
    st.openAsset(sampleAsset());
    st.setSelection({ nodeIds: ['v1'], edgeIds: [] });
    await st.copySelection();
    st.switchGraph('aux');
    assert.equal(useBlueprintStore.getState().graphName, 'aux', '切图生效');
    const pasted = await st.paste();
    assert.equal(pasted, 1, '跨图粘贴成功');
    const aux = getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['aux']!;
    assert.equal(aux.nodes.length, 1, '节点落在目标图');
    assert.equal(aux.nodes[0]!.type, 'var.get');
    undo();
    assert.equal(getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['aux']!.nodes.length, 0, '跨图粘贴可撤销');
  } finally {
    detach();
  }
});

/* ============================================================
 * 11. DOM 冒烟（happy-dom：叶子交互组件挂载 + 交互钩子接线）
 *
 * 约定：叶子组件不 import .css（见各组件头注释），本节才得以在 node:test 挂载；
 * BlueprintEditorPanel / BPGraphCanvas 含 .css import，冒烟属浏览器 dev 链路。
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
  'PointerEvent',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
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

const { act } = await import('react');
const { createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ReactFlowProvider } = await import('@xyflow/react');
const { NodeSearchMenu, EdgeContextMenu } = await import('./NodeSearchMenu');
const { PinDragMenu } = await import('./PinDragMenu');
const { SelectionToolbar } = await import('./SelectionToolbar');
const { ValidationBar } = await import('./ValidationBar');
const { useCanvasInteractions } = await import('./useCanvasInteractions');

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

/** 派发键盘事件（window 级，钩子与组件监听一致） */
function pressKey(key: string, init: Record<string, unknown> = {}): void {
  (dom.window as unknown as { dispatchEvent(e: Event): void }).dispatchEvent(
    new dom.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init } as never) as unknown as Event,
  );
}

/** React 受控输入框设值（native setter + input 事件，绕过 React 值追踪去重） */
function setControlledValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}

/* ---------------- NodeSearchMenu（§8.2 第 1 条 UI） ---------------- */

test('DOM 冒烟：NodeSearchMenu 挂载 / 最近使用分组 / 搜索过滤 / 键盘与点击回调', async () => {
  dom.document.body.innerHTML = '';
  const picked: string[] = [];
  let closed = 0;
  const unmount = mount(
    createElement(NodeSearchMenu, {
      screen: { x: 20, y: 20 },
      entries: [...SPEC.values()].map((spec) => ({ spec, pin: null })),
      recentIds: ['math.add'],
      categoryOrder: NODE_CATEGORIES,
      title: '添加节点',
      onPick: (id: string) => picked.push(id),
      onClose: () => {
        closed += 1;
      },
    }),
  );
  try {
    const menuEl = dom.document.querySelector('.bp-menu');
    assert.ok(menuEl, '菜单挂载');
    const sections = dom.document.querySelectorAll('.bp-menu-section');
    assert.ok(sections.length >= 2, '有分组标题');
    assert.equal(sections[0]?.textContent, '最近使用', '最近使用分组在首位');
    assert.ok(dom.document.querySelector('.bp-menu-search') === dom.document.activeElement, '搜索框自动聚焦');

    // 搜索过滤：'分支' 精确命中 flow.branch
    const input = dom.document.querySelector('.bp-menu-search') as unknown as HTMLInputElement;
    act(() => {
      setControlledValue(input, '分支');
    });
    const items = dom.document.querySelectorAll('.bp-menu-item');
    assert.ok(items.length > 0, '有搜索结果');
    assert.ok(items[0]?.textContent?.includes('分支'), '首个结果为分支');

    // 键盘：↓ + Enter 确认
    act(() => {
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }) as unknown as Event);
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event);
    });
    assert.deepEqual(picked, ['flow.branch'], 'Enter 选中高亮项');

    // Esc 关闭 + 点击外部关闭
    act(() => {
      input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    });
    assert.equal(closed, 1, 'Esc 关闭');
    act(() => {
      (dom.document.body as unknown as HTMLElement).dispatchEvent(
        new dom.MouseEvent('pointerdown', { bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.equal(closed, 2, '点击外部关闭');

    // 无匹配提示
    act(() => {
      setControlledValue(input, 'zzz不存在的节点');
    });
    assert.ok(dom.document.querySelector('.bp-menu-empty'), '无匹配提示出现');
  } finally {
    await unmount();
  }
});

/* ---------------- PinDragMenu（§8.2 第 2 条 UI） ---------------- */

test('DOM 冒烟：PinDragMenu 只列兼容节点并显示接入引脚', async () => {
  dom.document.body.innerHTML = '';
  const unmount = mount(
    createElement(PinDragMenu, {
      screen: { x: 10, y: 10 },
      flow: { x: 100, y: 100 },
      from: { nodeId: 'ev', pinId: 'exec', dir: 'out', type: 'exec' },
      specs: SPEC,
      recentIds: [],
      categoryOrder: NODE_CATEGORIES,
      onPick: () => {},
      onClose: () => {},
    }),
  );
  try {
    const items = dom.document.querySelectorAll('.bp-menu-item');
    assert.ok(items.length > 0, 'exec 输出拖出列出兼容节点');
    const titles = [...items].map((el) => el.textContent ?? '').join('\n');
    assert.ok(titles.includes('分支'), '含 flow.branch（有 exec 输入）');
    assert.ok(!titles.includes('加法'), '纯节点（math.add 无 exec 输入）被排除');
    assert.ok(dom.document.querySelector('.bp-menu-header')?.textContent?.includes('exec'), '标题带拖出引脚类型');
  } finally {
    await unmount();
  }
});

/* ---------------- SelectionToolbar（§8.2 第 5 条 UI） ---------------- */

test('DOM 冒烟：SelectionToolbar 少于 2 个不渲染；分布按钮按节点数启停；点击回调', async () => {
  dom.document.body.innerHTML = '';
  const modes: string[] = [];
  const props = {
    onAlign: (mode: AlignMode) => {
      modes.push(mode);
    },
  };
  const unmount1 = mount(createElement(SelectionToolbar, { nodeCount: 1, ...props }));
  assert.equal(dom.document.querySelector('.bp-sel-toolbar'), null, '单选不渲染');
  await unmount1();

  const unmount2 = mount(createElement(SelectionToolbar, { nodeCount: 2, ...props }));
  const btns2 = dom.document.querySelectorAll('.bp-sel-btn');
  assert.equal(btns2.length, 4, '四个对齐/分布按钮');
  assert.equal((btns2[2] as unknown as HTMLButtonElement).disabled, true, '两点时分布禁用');
  act(() => {
    (btns2[0] as unknown as HTMLButtonElement).dispatchEvent(
      new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
    );
  });
  assert.deepEqual(modes, ['left'], '点击执行左对齐');
  await unmount2();

  const unmount3 = mount(createElement(SelectionToolbar, { nodeCount: 3, ...props }));
  const btns3 = dom.document.querySelectorAll('.bp-sel-btn');
  assert.equal((btns3[3] as unknown as HTMLButtonElement).disabled, false, '三点时垂直分布可用');
  await unmount3();
});

/* ---------------- ValidationBar（§8.2 第 8 条 UI） ---------------- */

test('DOM 冒烟：ValidationBar 状态文案 / 错误自动展开 / 点击条目跳转 / 保存回调', async () => {
  dom.document.body.innerHTML = '';
  let jumps = 0;
  let saves = 0;
  const base = {
    dirty: false,
    graphName: 'main',
    onJump: () => {
      jumps += 1;
    },
    onSave: () => {
      saves += 1;
    },
  };
  const unmount0 = mount(
    createElement(ValidationBar, { issues: null, ...base }),
  );
  assert.ok(dom.document.querySelector('.bp-valbar-text')?.textContent?.includes('已保存'), '未校验且干净 → 已保存');
  assert.equal(dom.document.querySelector('.bp-valbar-row'), null, '无明细');
  await unmount0();

  const unmount = mount(
    createElement(ValidationBar, {
      issues: [
        { severity: 'error', code: 'x', graphName: 'main', nodeId: 'br', message: '引脚类型不匹配' },
        { severity: 'warning', code: 'y', graphName: 'aux', message: '空图' },
      ],
      ...base,
    }),
  );
  try {
    const text = dom.document.querySelector('.bp-valbar-text')?.textContent ?? '';
    assert.ok(text.includes('1 个错误') && text.includes('保存被阻止'), '错误汇总文案');
    const rows = dom.document.querySelectorAll('.bp-valbar-row');
    assert.equal(rows.length, 2, '错误时明细自动展开');
    act(() => {
      (rows[0] as unknown as HTMLElement).dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.equal(jumps, 1, '点击错误条目跳转');
    assert.ok(dom.document.querySelector('.bp-valbar-graph')?.textContent?.includes('aux'), '跨图 issue 显示来源图');
    act(() => {
      (dom.document.querySelector('.bp-valbar-btn') as unknown as HTMLButtonElement).dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.equal(saves, 1, '保存按钮回调');
  } finally {
    await unmount();
  }
});

/* ---------------- EdgeContextMenu（§8.2 第 4 条 UI） ---------------- */

test('DOM 冒烟：EdgeContextMenu 断开回调 / 批量断开 / Esc 关闭', async () => {
  dom.document.body.innerHTML = '';
  const calls: string[] = [];
  let closed = 0;
  const unmount = mount(
    createElement(EdgeContextMenu, {
      screen: { x: 5, y: 5 },
      edgeSelected: true,
      selectedEdgeCount: 3,
      onDisconnectOne: () => calls.push('one'),
      onDisconnectSelected: () => calls.push('selected'),
      onClose: () => {
        closed += 1;
      },
    }),
  );
  try {
    const btns = dom.document.querySelectorAll('.bp-menu-item');
    assert.equal(btns.length, 2, '断开 + 断开选中（3 条连线已选）');
    act(() => {
      (btns[1] as unknown as HTMLButtonElement).dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.deepEqual(calls, ['selected'], '批量断开回调');
    act(() => {
      (dom.document.body as unknown as HTMLElement).dispatchEvent(
        new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
    assert.equal(closed, 1, 'Esc 关闭');
  } finally {
    await unmount();
  }
});

/* ---------------- useCanvasInteractions 钩子接线（ReactFlowProvider 内） ---------------- */

test('DOM 冒烟：交互钩子接线——Tab/Esc/Ctrl+A/Delete/undo 链路与 Alt+点击引脚断开', async () => {
  dom.document.body.innerHTML = '';
  resetEditorStore();
  useBlueprintStore.getState().openAsset(sampleAsset(), 'logic/main.bp.json');

  const holder: { api?: import('./useCanvasInteractions').CanvasInteractionApis } = {};
  function HookProbe(): ReturnType<typeof createElement> {
    holder.api = useCanvasInteractions();
    return createElement('div', { className: 'bp-canvas' });
  }
  const unmount = mount(
    createElement(ReactFlowProvider, null, createElement(HookProbe)),
  );
  try {
    assert.ok(holder.api);
    assert.equal(holder.api.nodes.length, 3, 'IR → 视图镜像（3 节点）');

    // Tab：光标处呼出搜索菜单（store.menu）
    act(() => {
      pressKey('Tab');
    });
    assert.equal(useBlueprintStore.getState().menu?.kind, 'search', 'Tab 呼出搜索菜单');
    // Esc：关闭
    act(() => {
      pressKey('Escape');
    });
    assert.equal(useBlueprintStore.getState().menu, null, 'Esc 关闭菜单');

    // Ctrl+A 全选 → Delete 删除（入命令栈）
    act(() => {
      pressKey('a', { ctrlKey: true });
    });
    assert.deepEqual(useBlueprintStore.getState().selection.nodeIds.sort(), ['br', 'ev', 'v1'], 'Ctrl+A 全选');
    act(() => {
      pressKey('Delete');
    });
    assert.equal(getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['main']!.nodes.length, 0, 'Delete 入命令栈删除');
    assert.equal(holder.api!.nodes.length, 0, '删除后视图镜像同步');
    assert.ok(peekUndo()?.label === '删除选中');

    // undo（全局栈）→ 钩子经 subscribeReplay 刷新 → 视图恢复（§8.2 第 9 条端到端）
    act(() => {
      undo();
    });
    assert.equal(holder.api!.nodes.length, 3, 'undo 后镜像经 subscribeReplay 刷新');

    // Alt+点击引脚断开（事件委托：.bp-canvas 内 .react-flow__handle）
    assert.ok(useBlueprintStore.getState().connect({ node: 'ev', pin: 'exec' }, { node: 'br', pin: 'exec' }));
    assert.equal(getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['main']!.edges.length, 1);
    const canvas = dom.document.createElement('div');
    canvas.className = 'bp-canvas';
    const handle = dom.document.createElement('div');
    handle.className = 'react-flow__handle';
    handle.setAttribute('data-nodeid', 'br');
    handle.setAttribute('data-handleid', 'exec');
    handle.setAttribute('data-handlepos', 'left');
    canvas.appendChild(handle);
    dom.document.body.appendChild(canvas);
    act(() => {
      (handle as unknown as HTMLElement).dispatchEvent(
        new dom.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }) as unknown as Event,
      );
    });
    assert.equal(
      getDomainState<{ asset: IRAsset }>('blueprint').asset.graphs['main']!.edges.length,
      0,
      'Alt+点击输入引脚 → 断开该脚全部连线',
    );
    handle.remove();
    canvas.remove();
  } finally {
    await unmount();
    resetEditorStore();
  }
});
