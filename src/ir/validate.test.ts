/**
 * Blueprint Studio v2 —— 保存校验器单测（T2.8，node:test）
 *
 * 覆盖：
 *  - 五类错误样本（unknown-node / type-mismatch / dangling-exec / exec-through-pure /
 *    unused-variable）逐条报出且 nodeId / edgeId 正确（蓝图编辑器点击跳转依据）；
 *  - 类型规则：any 兼容、数组⇄元素不兼容、数组同形按元素判定、int→float 放行、
 *    float→int 收窄降级 warning（narrowing-conversion）；
 *  - 附加规则：unconnected-required-input / duplicate-node-id / broken-edge /
 *    event-def-missing / event-no-entry；
 *  - 正确样本（含零 warning 样本）零问题；
 *  - builtinSpecMap 真实节点构造「分支 + 循环 + 变量读写」合法蓝图全链验证；
 *  - .bp.json 往返无损 + normalizeIR 洗字段 / 键序稳定 + deserializeIR 结构错误。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRGraph, IREdge, IRNode, IRValueType, NodeSpec, PinSpec } from './types';
import { builtinSpecMap } from '../nodes/index';
import { deserializeIR, normalizeIR, serializeIR, validateIR, type ValidationIssue } from './validate';

/* ============================================================
 * 样本构造帮助
 * ============================================================ */

function node(id: string, type: string, extra?: Partial<Omit<IRNode, 'id' | 'type'>>): IRNode {
  return { id, type, params: {}, pinDefaults: {}, position: { x: 0, y: 0 }, ...extra };
}

function graph(nodes: IRNode[], edges: IREdge[]): IRGraph {
  return { nodes, edges };
}

function execEdge(id: string, fromNode: string, toNode: string, fromPin = 'exec', toPin = 'exec'): IREdge {
  return { id, from: { node: fromNode, pin: fromPin }, to: { node: toNode, pin: toPin }, kind: 'exec' };
}

function dataEdge(id: string, fromNode: string, fromPin: string, toNode: string, toPin: string): IREdge {
  return { id, from: { node: fromNode, pin: fromPin }, to: { node: toNode, pin: toPin }, kind: 'data' };
}

function asset(graphs: Record<string, IRGraph>, extra?: Partial<Omit<IRAsset, 'graphs'>>): IRAsset {
  return {
    version: 2,
    name: '测试资产',
    entry: 'main',
    graphs,
    variables: [],
    events: [],
    snippets: [],
    layout: {},
    ...extra,
  };
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((i) => i.code);
}

/** 断言某 code 被报出并返回该条（失败时打印实际 codes，便于排查） */
function byCode(issues: ValidationIssue[], code: string): ValidationIssue {
  const hit = issues.find((i) => i.code === code);
  assert.ok(hit, `应报出 ${code}，实际：${JSON.stringify(codes(issues))}`);
  return hit;
}

/** 造一对「输出 outType → 输入 inType」的合成纯节点 spec（隔离类型规则用） */
function pipeSpecs(outType: IRValueType, inType: IRValueType, inExtra?: Partial<PinSpec>): Map<string, NodeSpec> {
  return new Map<string, NodeSpec>([
    ['test.src', {
      id: 'test.src', title: '源节点', category: '测试', pure: true,
      inputs: [], outputs: [{ id: 'out', type: outType }],
    }],
    ['test.dst', {
      id: 'test.dst', title: '目标节点', category: '测试', pure: true,
      inputs: [{ id: 'in', type: inType, ...inExtra }], outputs: [],
    }],
  ]);
}

function pipeAsset(): IRAsset {
  return asset({
    main: graph(
      [node('s', 'test.src'), node('d', 'test.dst')],
      [dataEdge('e1', 's', 'out', 'd', 'in')],
    ),
  });
}

/* ============================================================
 * 五类错误样本（DoD 核心）
 * ============================================================ */

test('未知节点：type 不在 specs → error unknown-node，nodeId 指向该节点', () => {
  const a = asset({ main: graph([node('ghost1', 'plugin.notExist')], []) });
  const issues = validateIR(a, builtinSpecMap);
  const hit = byCode(issues, 'unknown-node');
  assert.equal(hit.severity, 'error');
  assert.equal(hit.nodeId, 'ghost1');
  assert.equal(hit.graphName, 'main');
  assert.match(hit.message, /plugin\.notExist/);
});

test('类型不匹配：int → bool → error type-mismatch（nodeId/edgeId 正确）', () => {
  // string.length 输出 int，flow.branch 的 cond 需要 bool（均为 builtin 真实节点）
  const a = asset({
    main: graph(
      [node('len', 'string.length'), node('br', 'flow.branch'), node('st', 'event.start')],
      [execEdge('e1', 'st', 'br'), dataEdge('e2', 'len', 'value', 'br', 'cond')],
    ),
  });
  const issues = validateIR(a, builtinSpecMap);
  assert.deepEqual(codes(issues), ['type-mismatch']);
  const hit = issues[0];
  assert.equal(hit.severity, 'error');
  assert.equal(hit.edgeId, 'e2');
  assert.equal(hit.nodeId, 'br');
  assert.match(hit.message, /int/);
  assert.match(hit.message, /bool/);
});

test('悬空 exec：非纯节点无 exec 汇入 → warning；连上后消失；事件入口节点豁免', () => {
  const alone = asset({ main: graph([node('d1', 'flow.delay')], []) });
  const hit = byCode(validateIR(alone, builtinSpecMap), 'dangling-exec');
  assert.equal(hit.severity, 'warning');
  assert.equal(hit.nodeId, 'd1');

  const linked = asset({
    main: graph([node('st', 'event.start'), node('d1', 'flow.delay')], [execEdge('e1', 'st', 'd1')]),
  });
  assert.deepEqual(validateIR(linked, builtinSpecMap), []);

  // event.custom / event.listen 没有 exec 输入引脚（事件入口），不应报悬空
  const entries = asset({ main: graph([node('c1', 'event.custom'), node('l1', 'event.listen')], []) });
  assert.deepEqual(codes(validateIR(entries, builtinSpecMap)), []);
});

test('exec 链穿纯节点 → error exec-through-pure（合成带 exec 入的纯节点隔离验证）', () => {
  const specs = new Map(builtinSpecMap);
  specs.set('test.pureExec', {
    id: 'test.pureExec', title: '带exec入的纯节点', category: '测试', pure: true,
    inputs: [{ id: 'exec', type: 'exec' }], outputs: [],
  });
  const a = asset({
    main: graph(
      [node('st', 'event.start'), node('p1', 'test.pureExec')],
      [execEdge('e1', 'st', 'p1')],
    ),
  });
  const issues = validateIR(a, specs);
  assert.deepEqual(codes(issues), ['exec-through-pure']);
  assert.equal(issues[0].nodeId, 'p1');
  assert.equal(issues[0].edgeId, 'e1');
  assert.match(issues[0].message, /纯节点/);
});

test('未使用变量 → warning；被 var.get / var.set 引用后消失；空 varName 不算引用', () => {
  const unused = asset(
    { main: graph([node('g1', 'var.get', { params: { varName: 'used' } })], []) },
    { variables: [{ name: 'used', type: 'int' }, { name: 'ghost', type: 'string' }] },
  );
  const issues = validateIR(unused, builtinSpecMap);
  assert.deepEqual(codes(issues), ['unused-variable']);
  assert.equal(issues[0].message.includes('ghost'), true);

  // var.set 经 params.varName 写入同样算引用
  const written = asset(
    { main: graph([node('s1', 'var.set', { params: { varName: 'ghost' } })], []) },
    { variables: [{ name: 'ghost', type: 'string' }] },
  );
  assert.ok(!codes(validateIR(written, builtinSpecMap)).includes('unused-variable'));

  // varName 为空（默认值）不算引用
  const emptyName = asset(
    { main: graph([node('g1', 'var.get')], []) },
    { variables: [{ name: 'ghost', type: 'string' }] },
  );
  assert.deepEqual(codes(validateIR(emptyName, builtinSpecMap)), ['unused-variable']);
});

test('五类错误样本合并：全部报出', () => {
  const specs = new Map(builtinSpecMap);
  specs.set('test.pureExec', {
    id: 'test.pureExec', title: '带exec入的纯节点', category: '测试', pure: true,
    inputs: [{ id: 'exec', type: 'exec' }], outputs: [],
  });
  const a = asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('ghost1', 'plugin.notExist'),   // ① unknown-node
          node('len', 'string.length'),        // ② type-mismatch（int → bool）
          node('br', 'flow.branch'),
          node('d1', 'flow.delay'),            // ③ dangling-exec
          node('p1', 'test.pureExec'),         // ④ exec-through-pure
        ],
        [
          execEdge('e1', 'st', 'br'),
          dataEdge('e2', 'len', 'value', 'br', 'cond'),
          execEdge('e3', 'st', 'p1'),
        ],
      ),
    },
    { variables: [{ name: 'ghost', type: 'string' }] }, // ⑤ unused-variable
  );
  const found = codes(validateIR(a, specs));
  for (const expected of ['unknown-node', 'type-mismatch', 'dangling-exec', 'exec-through-pure', 'unused-variable']) {
    assert.ok(found.includes(expected), `缺少 ${expected}，实际：${JSON.stringify(found)}`);
  }
});

/* ============================================================
 * 类型连线规则（any / 数组 / 收窄）
 * ============================================================ */

test('收窄转换：float → int → warning narrowing-conversion；int → float 直接放行', () => {
  const narrow = asset({
    main: graph(
      [node('rf', 'math.randomFloat'), node('loop', 'flow.forLoop'), node('st', 'event.start')],
      [execEdge('e1', 'st', 'loop'), dataEdge('e2', 'rf', 'value', 'loop', 'to')],
    ),
  });
  const issues = validateIR(narrow, builtinSpecMap);
  assert.deepEqual(codes(issues), ['narrowing-conversion']);
  assert.equal(issues[0].severity, 'warning');
  assert.equal(issues[0].edgeId, 'e2');
  assert.equal(issues[0].nodeId, 'loop');
  assert.match(issues[0].message, /float/);
  assert.match(issues[0].message, /int/);

  // int → float 是加宽，直接放行（math.random 输出 int → flow.delay.seconds float）
  const widen = asset({
    main: graph(
      [node('ri', 'math.random'), node('delay1', 'flow.delay'), node('st', 'event.start')],
      [execEdge('e1', 'st', 'delay1'), dataEdge('e2', 'ri', 'value', 'delay1', 'seconds')],
    ),
  });
  assert.deepEqual(validateIR(widen, builtinSpecMap), []);
});

test('any 与一切兼容（标量双向 + 数组）', () => {
  // var.get 输出 any → branch.cond(bool)
  const a = asset({
    main: graph(
      [node('g', 'var.get', { params: { varName: 'x' } }), node('br', 'flow.branch'), node('st', 'event.start')],
      [execEdge('e1', 'st', 'br'), dataEdge('e2', 'g', 'value', 'br', 'cond')],
    ),
  });
  assert.deepEqual(validateIR(a, builtinSpecMap), []);

  // any[] → string[]（合成节点）
  const specs = pipeSpecs('any[]', 'string[]');
  assert.deepEqual(validateIR(pipeAsset(), specs), []);
});

test('数组规则：数组⇄元素不兼容；数组同形按元素类型判定', () => {
  const cases: { from: IRValueType; to: IRValueType; expect: 'ok' | 'narrowing-conversion' | 'type-mismatch' }[] = [
    { from: 'string[]', to: 'string', expect: 'type-mismatch' },
    { from: 'string', to: 'string[]', expect: 'type-mismatch' },
    { from: 'int[]', to: 'float[]', expect: 'ok' },
    { from: 'float[]', to: 'int[]', expect: 'narrowing-conversion' },
    { from: 'string[]', to: 'string[]', expect: 'ok' },
    { from: 'string[]', to: 'int[]', expect: 'type-mismatch' },
  ];
  for (const c of cases) {
    const specs = pipeSpecs(c.from, c.to);
    const issues = validateIR(pipeAsset(), specs);
    assert.deepEqual(
      codes(issues),
      c.expect === 'ok' ? [] : [c.expect],
      `${c.from} → ${c.to} 应为 ${c.expect}`,
    );
  }
});

/* ============================================================
 * 附加规则
 * ============================================================ */

test('必需输入未连线且无默认值 → warning；pinDefaults / defaultValue / 连线任一兜底即消失', () => {
  // 基于内置节点表扩展（样本中会用到 event.start）
  const reqSpecs = new Map(builtinSpecMap);
  reqSpecs.set('test.req', {
    id: 'test.req', title: '必需输入节点', category: '测试',
    inputs: [{ id: 'exec', type: 'exec' }, { id: 'need', type: 'string', label: '必填' }],
    outputs: [],
  });
  reqSpecs.set('test.src', {
    id: 'test.src', title: '源节点', category: '测试', pure: true,
    inputs: [], outputs: [{ id: 'out', type: 'string' }],
  });
  const alone = asset({ main: graph([node('r1', 'test.req')], []) });
  const hit = byCode(validateIR(alone, reqSpecs), 'unconnected-required-input');
  assert.equal(hit.severity, 'warning');
  assert.equal(hit.nodeId, 'r1');
  assert.match(hit.message, /必填/);

  // pinDefaults 兜底
  const withDefault = asset({
    main: graph([node('r1', 'test.req', { pinDefaults: { need: 'x' } })], []),
  });
  assert.ok(!codes(validateIR(withDefault, reqSpecs)).includes('unconnected-required-input'));

  // 连线兜底（顺带消掉悬空 exec）
  const wired = asset({
    main: graph(
      [node('st', 'event.start'), node('r1', 'test.req'), node('s1', 'test.src')],
      [execEdge('e1', 'st', 'r1'), dataEdge('e2', 's1', 'out', 'r1', 'need')],
    ),
  });
  assert.deepEqual(validateIR(wired, reqSpecs), []);

  // PinSpec.defaultValue 兜底（内置 event.send 的 eventName 默认 ''，args 可选）
  const builtin = asset({ main: graph([node('s1', 'event.send')], []) });
  assert.deepEqual(codes(validateIR(builtin, builtinSpecMap)), ['dangling-exec']);
});

test('同图节点 id 重复 → error duplicate-node-id', () => {
  const a = asset({ main: graph([node('n1', 'event.start'), node('n1', 'event.start')], []) });
  const issues = validateIR(a, builtinSpecMap);
  assert.deepEqual(codes(issues), ['duplicate-node-id']);
  assert.equal(issues[0].nodeId, 'n1');
  assert.match(issues[0].message, /n1/);
});

test('连线引用不存在的节点 / 引脚 → error broken-edge', () => {
  const ghost = asset({
    main: graph([node('p1', 'system.print')], [execEdge('e1', 'ghost', 'p1')]),
  });
  const hit1 = byCode(validateIR(ghost, builtinSpecMap), 'broken-edge');
  assert.equal(hit1.edgeId, 'e1');
  assert.match(hit1.message, /起点/);
  assert.match(hit1.message, /ghost/);

  const badPin = asset({
    main: graph(
      [node('st', 'event.start'), node('p1', 'system.print')],
      [execEdge('e1', 'st', 'p1', 'exec', 'nope')],
    ),
  });
  const hit2 = byCode(validateIR(badPin, builtinSpecMap), 'broken-edge');
  assert.equal(hit2.edgeId, 'e1');
  assert.equal(hit2.nodeId, 'p1');
  assert.match(hit2.message, /nope/);
});

test('附加事件规则：死事件 / event.custom 引用未定义事件 → warning', () => {
  const dead = asset(
    { main: graph([], []) },
    { events: [{ name: 'loaded', params: [] }] },
  );
  const hit1 = byCode(validateIR(dead, builtinSpecMap), 'event-no-entry');
  assert.equal(hit1.severity, 'warning');
  assert.match(hit1.message, /loaded/);

  const missingDef = asset(
    { main: graph([node('c1', 'event.custom', { params: { eventName: 'missing' } })], []) },
    { events: [{ name: 'loaded', params: [] }] },
  );
  const issues = validateIR(missingDef, builtinSpecMap);
  assert.deepEqual(codes(issues).sort(), ['event-def-missing', 'event-no-entry']);
});

/* ============================================================
 * 正确样本与集成全链
 * ============================================================ */

test('正确样本：零 error 零 warning', () => {
  const a = asset({
    main: graph(
      [node('st', 'event.start'), node('p1', 'system.print', { pinDefaults: { value: '你好' } })],
      [execEdge('e1', 'st', 'p1')],
    ),
  });
  assert.deepEqual(validateIR(a, builtinSpecMap), []);
});

test('集成：分支 + 循环 + 变量读写的合法蓝图（builtinSpecMap）零问题，序列化往返后仍零问题', () => {
  // 主图：开始 → 分支（条件读变量）→ For 循环 → 打印索引 → 循环完成写回变量
  const main = graph(
    [
      node('st', 'event.start'),
      node('br', 'flow.branch'),
      node('loop', 'flow.forLoop'),
      node('readCnt', 'var.get', { params: { varName: 'count' } }),
      node('show', 'system.print', { title: '打印计数' }),
      node('writeCnt', 'var.set', { params: { varName: 'count' } }),
    ],
    [
      execEdge('e1', 'st', 'br'),
      execEdge('e2', 'br', 'loop', 'true', 'exec'),
      execEdge('e3', 'loop', 'show', 'body', 'exec'),
      dataEdge('d1', 'loop', 'index', 'show', 'value'),      // int → any
      dataEdge('d2', 'readCnt', 'value', 'br', 'cond'),      // any → bool
      execEdge('e4', 'loop', 'writeCnt', 'done', 'exec'),
      dataEdge('d3', 'readCnt', 'value', 'writeCnt', 'value'), // any → any
    ],
  );
  // 函数子图风格的事件监听图：监听事件 → 打印参数
  const helper = graph(
    [node('l1', 'event.listen'), node('show2', 'system.print')],
    [execEdge('e5', 'l1', 'show2'), dataEdge('d4', 'l1', 'args', 'show2', 'value')],
  );
  const a = asset(
    { main, helper },
    {
      variables: [{ name: 'count', type: 'int', default: 0 }],
      layout: { main: { zoom: 1, pan: [0, 0] } },
    },
  );
  assert.deepEqual(validateIR(a, builtinSpecMap), []);

  // 全链：保存（serialize）→ 加载（deserialize）→ 再校验，仍零问题且内容规范一致
  const restored = deserializeIR(serializeIR(a));
  assert.deepEqual(validateIR(restored, builtinSpecMap), []);
  assert.deepEqual(restored, normalizeIR(a));
});

/* ============================================================
 * 往返无损与 normalizeIR
 * ============================================================ */

/** 含全特性（多图 / 变量 / 事件 / 片段 / 布局 / pinDefaults / params / 注释 / 函数图接口）的规范形资产 */
const fullAsset: IRAsset = {
  version: 3,
  name: '特性全量资产',
  entry: 'main',
  graphs: {
    calc: {
      nodes: [],
      edges: [],
      params: [{ name: 'x', type: 'int' }],
      returns: [{ name: 'result', type: 'float' }],
    },
    main: {
      nodes: [
        { id: 'start', type: 'event.start', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
        {
          id: 'show',
          type: 'system.print',
          title: '打印结果',
          comment: '调试输出',
          params: { b: 2, a: 1, nested: { y: 2, x: 1 } },
          pinDefaults: { value: 'hi', extra: null },
          position: { x: 120.5, y: -40 },
        },
      ],
      edges: [
        { id: 'e1', from: { node: 'start', pin: 'exec' }, to: { node: 'show', pin: 'exec' }, kind: 'exec' },
        { id: 'e2', from: { node: 'show', pin: 'value' }, to: { node: 'show', pin: 'value' }, kind: 'data' },
      ],
    },
  },
  variables: [
    { name: 'count', type: 'int', default: 0, exposed: true, category: '状态' },
    { name: 'rows', type: 'LogRow[]' },
    { name: 'cfg', type: 'object', default: { b: 1, a: [1, 2] } },
  ],
  events: [{ name: 'loaded', params: [{ name: 'cnt', type: 'int' }] }],
  snippets: [{
    id: 'snip1',
    lang: 'ts',
    code: 'return input.x;',
    pins: [
      { id: 'out0', dir: 'out', type: 'int', label: '结果' },
      { id: 'in0', dir: 'in', type: 'any' },
    ],
  }],
  layout: { main: { zoom: 1.25, pan: [10, -20] }, calc: { zoom: 1, pan: [0, 0] } },
};

test('往返无损：serialize → deserialize 深等于原对象，且 serialize 幂等、键序稳定规范', () => {
  const s1 = serializeIR(fullAsset);
  const restored = deserializeIR(s1);
  assert.deepEqual(restored, fullAsset);
  const s2 = serializeIR(restored);
  assert.equal(s2, s1, 'serializeIR 应幂等（序列化两次字符串相等）');

  // 顶层键序规范
  const parsed = JSON.parse(s1) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed),
    ['version', 'name', 'entry', 'graphs', 'variables', 'events', 'snippets', 'layout'],
  );
  // 记录键字典序稳定（graphs / params / 嵌套参数值）
  const graphs = parsed['graphs'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(graphs), ['calc', 'main']);
  const show = (graphs['main'] as { nodes: Record<string, unknown>[] }).nodes[1];
  assert.deepEqual(
    Object.keys(show),
    ['id', 'type', 'title', 'params', 'pinDefaults', 'comment', 'position'],
  );
  assert.deepEqual(Object.keys(show['params'] as Record<string, unknown>), ['a', 'b', 'nested']);
  assert.deepEqual(
    Object.keys((show['params'] as Record<string, Record<string, unknown>>)['nested']),
    ['x', 'y'],
  );
  // normalizeIR 自身幂等
  assert.deepEqual(normalizeIR(normalizeIR(fullAsset)), normalizeIR(fullAsset));
});

test('normalizeIR 洗字段：剔除 undefined 与空可选容器，非空值原样保留', () => {
  const dirty = {
    version: 2,
    name: '脏资产',
    entry: 'main',
    graphs: {
      main: {
        nodes: [{
          id: 'n1',
          type: 'event.start',
          title: undefined,
          params: { a: undefined, keep: 1 },
          pinDefaults: {},
          position: { x: 1, y: 2 },
        }],
        edges: [],
        params: [],
        returns: [],
      },
    },
    variables: [{ name: 'v', type: 'int', default: undefined, exposed: undefined }],
    events: [],
    snippets: [],
    layout: {},
  } as unknown as IRAsset;

  const clean = normalizeIR(dirty);
  const n1 = clean.graphs['main'].nodes[0];
  assert.equal('title' in n1, false, 'undefined 的 title 应被剔除');
  assert.deepEqual(n1.params, { keep: 1 }, 'params 中 undefined 键应被剔除');
  const mainGraph = clean.graphs['main'];
  assert.equal('params' in mainGraph, false, '空的图级 params 应被剔除');
  assert.equal('returns' in mainGraph, false, '空的图级 returns 应被剔除');
  const v = clean.variables[0];
  assert.equal('default' in v, false);
  assert.equal('exposed' in v, false);

  // 洗字段后序列化幂等（键序稳定）
  assert.equal(serializeIR(dirty), serializeIR(clean));
});

/* ============================================================
 * deserializeIR 结构校验（缺字段给明确中文错误）
 * ============================================================ */

test('deserializeIR：非法输入 / 缺字段 / 版本不识别 → 抛出中文错误', () => {
  assert.throws(() => deserializeIR('这不是JSON'), /IR 反序列化失败/);
  assert.throws(() => deserializeIR('{}'), /version/);
  assert.throws(() => deserializeIR(JSON.stringify({ version: 2 })), /name/);
  assert.throws(() => deserializeIR(JSON.stringify({ version: 2, name: 'x' })), /entry/);
  assert.throws(
    () => deserializeIR(JSON.stringify({
      version: 2, name: 'x', entry: 'main', graphs: {},
      variables: [], events: [], snippets: [], layout: {},
    })),
    /主图/,
  );
  assert.throws(
    () => deserializeIR(JSON.stringify({ ...fullAsset, version: 99 })),
    /不支持的 IR 版本/,
  );

  const base: any = JSON.parse(JSON.stringify(fullAsset));
  // 节点缺 id
  delete base.graphs.main.nodes[0].id;
  assert.throws(() => deserializeIR(JSON.stringify(base)), /缺少 id/);
  // 图缺 edges
  const noEdges: any = JSON.parse(JSON.stringify(fullAsset));
  delete noEdges.graphs.main.edges;
  assert.throws(() => deserializeIR(JSON.stringify(noEdges)), /edges/);
  // 连线缺端点
  const noEndpoint: any = JSON.parse(JSON.stringify(fullAsset));
  delete noEndpoint.graphs.main.edges[0].from;
  assert.throws(() => deserializeIR(JSON.stringify(noEndpoint)), /from/);
});

test('deserializeIR：合法输入通过，缺省的 params/pinDefaults/position 自动补齐', () => {
  const text = JSON.stringify({
    version: 2,
    name: 'x',
    entry: 'main',
    graphs: { main: { nodes: [{ id: 'n1', type: 'event.start' }], edges: [] } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  });
  const ir = deserializeIR(text);
  assert.equal(ir.version, 3);
  assert.deepEqual(ir.graphs['main'].nodes[0], {
    id: 'n1',
    type: 'event.start',
    params: {},
    pinDefaults: {},
    position: { x: 0, y: 0 },
  });
});

/* ============================================================
 * comments（ADR-006，T2.7）：结构校验纳入注释框
 * ============================================================ */

/** 带指定 comments 的资产（comments 结构错误样本的基底） */
function assetWithComments(comments: unknown): IRAsset {
  const a = asset({ main: graph([node('n1', 'event.start')], []) });
  (a.graphs['main'] as unknown as { comments?: unknown }).comments = comments;
  return a;
}

test('comments（ADR-006）：含注释资产 validateIR 不产生任何 issue（纯视觉容器不参与校验）', () => {
  const a = assetWithComments([
    { id: 'c1', text: '初始化逻辑', color: '#4f8cc9', bounds: { x: 0, y: 0, w: 400, h: 300 } },
    { id: 'c2', text: '无颜色注释', bounds: { x: -100, y: -50, w: 200, h: 120 } },
  ]);
  assert.deepEqual(validateIR(a, builtinSpecMap), []);
});

test('deserializeIR：comments 结构错误 → 抛出中文错误（非数组 / 缺 id / 缺 text / bounds 缺字段 / color 非字符串）', () => {
  // comments 非数组
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments('注释'))),
    /IR 结构错误：图「main」的 comments 必须是数组/,
  );
  // 注释缺 id / id 为空
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([{ text: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 } }]))),
    /第 1 条注释缺少 id/,
  );
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([{ id: '', text: 'x', bounds: { x: 0, y: 0, w: 1, h: 1 } }]))),
    /缺少 id/,
  );
  // 缺 text
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([{ id: 'c1', bounds: { x: 0, y: 0, w: 1, h: 1 } }]))),
    /注释「c1」缺少 text/,
  );
  // bounds 缺失 / 四字段不齐（w / h / x / y 逐个验证）
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([{ id: 'c1', text: 'x' }]))),
    /注释「c1」缺少 bounds/,
  );
  for (const key of ['x', 'y', 'w', 'h']) {
    const bad = [{ id: 'c1', text: 'x', bounds: { x: 1, y: 2, w: 3, h: 4 } }];
    delete (bad[0].bounds as Record<string, unknown>)[key];
    assert.throws(
      () => deserializeIR(JSON.stringify(assetWithComments(bad))),
      new RegExp(`bounds\\.${key} 必须是数字`),
      `bounds 缺 ${key} 应被拒绝`,
    );
  }
  // bounds 非对象
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([{ id: 'c1', text: 'x', bounds: [0, 0, 1, 1] }]))),
    /缺少 bounds/,
  );
  // color 非字符串
  assert.throws(
    () => deserializeIR(JSON.stringify(assetWithComments([
      { id: 'c1', text: 'x', color: 42, bounds: { x: 0, y: 0, w: 1, h: 1 } },
    ]))),
    /color 必须是字符串/,
  );
});
