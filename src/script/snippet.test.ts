/**
 * Blueprint Studio v2 —— 片段引脚契约与运行时单测（T3.7，ADR-007）
 *
 * 覆盖（任务卡测试清单）：
 *  1. 引脚推导纯函数（analyzeSnippetCode / deriveSnippetPins）：外部读取 → in、
 *     裸赋值目标 / return 值 → out、环境全局与局部声明排除、this./vars. 规则、await 检测；
 *  2. 片段 spec 合成（snippetSpecFromPins / snippetSpecForAsset / withSnippetSpecs）：
 *     标题 / 分类 / 引脚映射 / pure 判定 / 并集合并；
 *  3. snippet-runtime：以真实 specs 跑通解释器——「纯片段表达式 → 下游节点」与
 *     「exec 片段插入链中」（引脚值注入 / 出脚映射 / return 优先 / vars 代理 / async）；
 *  4. 模态编辑冒烟（happy-dom）：挂载 / 编辑源码 / 增删引脚 / 保存回调；
 *     saveSnippetEdit 入命令栈 + undo 还原 + 新建片段（分配 id + 回填 params）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IREdge, IRGraph, IRNode, IRSnippetPin } from '../ir/types';
import { normalizeIR } from '../ir/validate';
import { editorSpecMap } from '../blueprint/my-blueprint/graph-op-specs';
import { SNIPPET_PARAM_KEY } from './codegen-common';
import {
  analyzeSnippetCode,
  deriveSnippetPins,
  snippetHasExecIn,
  snippetIsPure,
  snippetPinIssue,
  snippetSpecForAsset,
  snippetSpecFromPins,
  uniqueSnippetId,
  withSnippetSpecs,
} from './snippet';
import { injectSnippetRuntime } from './snippet-runtime';
import { createRuntime } from '../runtime/interpreter';
import { irToFlow } from '../blueprint/view/model';

/* ============================================================
 * 样本帮助（与 roundtrip.test.ts 同款）
 * ============================================================ */

function node(id: string, type: string, extra?: Partial<Omit<IRNode, 'id' | 'type'>>): IRNode {
  return { id, type, params: {}, pinDefaults: {}, position: { x: 0, y: 0 }, ...extra };
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
    name: '片段测试',
    entry: 'main',
    graphs,
    variables: [],
    events: [],
    snippets: [],
    layout: {},
    ...extra,
  };
}

function pinIds(pins: readonly IRSnippetPin[], dir: 'in' | 'out'): string[] {
  return pins.filter((p) => p.dir === dir).map((p) => p.id);
}

/* ============================================================
 * 1. 引脚推导（ADR-007 §2）
 * ============================================================ */

test('推导：裸赋值目标 → out，外部读取 → in（x = a + 1）', () => {
  const a = analyzeSnippetCode('x = a + 1;');
  assert.deepEqual(pinIds(deriveSnippetPins('x = a + 1;'), 'in'), ['a']);
  assert.deepEqual(pinIds(deriveSnippetPins('x = a + 1;'), 'out'), ['x']);
  assert.equal(a.awaits, false);
});

test('推导：先读后写（total = total + 1）→ 同名 in + out', () => {
  const pins = deriveSnippetPins('total = total + 1;');
  assert.deepEqual(pinIds(pins, 'in'), ['total']);
  assert.deepEqual(pinIds(pins, 'out'), ['total']);
});

test('推导：this.X / vars.X 读 → in；this.X 写 → 变量副作用（不推导 out）', () => {
  assert.deepEqual(pinIds(deriveSnippetPins('this.count = 2;'), 'in'), []);
  assert.deepEqual(pinIds(deriveSnippetPins('this.count = 2;'), 'out'), []);
  assert.deepEqual(pinIds(deriveSnippetPins('vars.flag = check;'), 'in'), ['check']);
  assert.deepEqual(pinIds(deriveSnippetPins('print(this.count + step);'), 'in'), ['count', 'step']);
  assert.deepEqual(pinIds(deriveSnippetPins('print(this.count + step);'), 'out'), []);
});

test('推导：return 表达式 → out result；return 对象 → 按键 out', () => {
  assert.deepEqual(pinIds(deriveSnippetPins('return a * 2;'), 'out'), ['result']);
  const obj = deriveSnippetPins('return { rows: r, count };');
  assert.deepEqual(pinIds(obj, 'out'), ['rows', 'count']);
  assert.deepEqual(pinIds(obj, 'in'), ['r', 'count']); // 简写属性 { count } 同时是读取
});

test('推导：局部声明排除 + 环境全局排除 + 成员名不误报', () => {
  const code = [
    'const local = Math.max(u, 1);',
    'print(format("{0}", local));',
    'ui.title.text = "x";',
    'obj.method(local);',
  ].join('\n');
  const pins = deriveSnippetPins(code);
  assert.deepEqual(pinIds(pins, 'in'), ['u', 'obj']);
  assert.deepEqual(pinIds(pins, 'out'), []);
});

test('推导：await 检测（await 表达式 / for await）', () => {
  assert.equal(analyzeSnippetCode('const r = await plugins.x.y();').awaits, true);
  assert.equal(analyzeSnippetCode('x = 1;').awaits, false);
});

test('推导：exec 骨架前置（语句级折叠形态）', () => {
  const pins = deriveSnippetPins('try { risky(); } catch (e) { print(e); }', { execSkeleton: true });
  assert.deepEqual(pins.slice(0, 2), [
    { id: 'exec', dir: 'in', type: 'exec' },
    { id: 'exec', dir: 'out', type: 'exec' },
  ]);
  // e 是 catch 绑定（局部），risky 是外部调用 → in（exec 骨架也在 in 集内）
  assert.deepEqual(pinIds(pins, 'in'), ['exec', 'risky']);
});

test('推导：片段内函数声明 / 解构声明的名字是局部名', () => {
  const code = 'const [a, b] = pair;\nfunction helper() { return a; }';
  const pins = deriveSnippetPins(code);
  assert.deepEqual(pinIds(pins, 'in'), ['pair']);
  assert.deepEqual(pinIds(pins, 'out'), []);
});

test('exec 约定：exec 入/出判定与纯片段判定', () => {
  const execPins: IRSnippetPin[] = [
    { id: 'exec', dir: 'in', type: 'exec' },
    { id: 'exec', dir: 'out', type: 'exec' },
    { id: 'x', dir: 'in', type: 'any' },
  ];
  assert.equal(snippetHasExecIn(execPins), true);
  assert.equal(snippetIsPure(execPins), false);
  assert.equal(snippetIsPure([{ id: 'x', dir: 'in', type: 'any' }]), true);
  // 仅 exec 出（无 exec 入）：不算纯（无法进链，codegen 抛错）
  assert.equal(snippetIsPure([{ id: 'exec', dir: 'out', type: 'exec' }]), false);
});

test('引脚校验：非法标识符 / 保留名 / 合法', () => {
  assert.match(snippetPinIssue({ id: 'my-out', dir: 'in', type: 'any' }) ?? '', /标识符/);
  assert.match(snippetPinIssue({ id: 'print', dir: 'in', type: 'any' }) ?? '', /重名/);
  assert.equal(snippetPinIssue({ id: 'x1', dir: 'out', type: 'any' }), null);
});

test('片段 id 分配：跳过既有（snip1、snip2…）', () => {
  assert.equal(uniqueSnippetId([]), 'snip1');
  assert.equal(uniqueSnippetId(['snip1', 'snip3']), 'snip2');
  assert.equal(uniqueSnippetId(['snip1', 'snip2']), 'snip3');
});

/* ============================================================
 * 2. 片段 spec 合成
 * ============================================================ */

test('spec 合成：标题 / 分类 / 引脚映射 / pure', () => {
  const spec = snippetSpecFromPins('abcdefgh1234', [
    { id: 'exec', dir: 'in', type: 'exec' },
    { id: 'exec', dir: 'out', type: 'exec' },
    { id: 'x', dir: 'in', type: 'float', label: '输入' },
    { id: 'y', dir: 'out', type: 'string' },
  ]);
  assert.equal(spec.title, '片段：abcdefgh');
  assert.equal(spec.category, '脚本片段');
  assert.equal(spec.pure, false);
  assert.deepEqual(spec.inputs.map((p) => ({ id: p.id, type: p.type })), [
    { id: 'exec', type: 'exec' },
    { id: 'x', type: 'float' },
  ]);
  assert.equal(spec.inputs.find((p) => p.id === 'x')?.label, '输入');
  assert.deepEqual(spec.outputs.map((p) => p.id), ['exec', 'y']);
  const pureSpec = snippetSpecFromPins('snip2', [{ id: 'x', dir: 'in', type: 'any' }]);
  assert.equal(pureSpec.pure, true);
});

test('spec 合成：资产并集 + withSnippetSpecs 合并（不改入参）', () => {
  const a = asset({ main: { nodes: [], edges: [] } }, {
    snippets: [
      { id: 's1', lang: 'ts', code: '', pins: [{ id: 'x', dir: 'in', type: 'any' }, { id: 'exec', dir: 'in', type: 'exec' }] },
      { id: 's2', lang: 'ts', code: '', pins: [{ id: 'x', dir: 'in', type: 'any' }, { id: 'y', dir: 'out', type: 'string' }] },
    ],
  });
  const spec = snippetSpecForAsset(a);
  // 并集去重：跨片段同名同向引脚只保留一份
  assert.deepEqual(spec.inputs.map((p) => p.id), ['x', 'exec']);
  assert.deepEqual(spec.outputs.map((p) => p.id), ['y']);
  assert.equal(spec.pure, false); // 并集 spec 不判 pure（避免 exec-through-pure 误报）
  const base = editorSpecMap();
  const merged = withSnippetSpecs(base, a);
  assert.equal(merged.has('script.snippet'), true);
  assert.equal(base.has('script.snippet'), false); // 入参不变
});

/* ============================================================
 * 3. snippet-runtime（解释器真实 specs 执行）
 * ============================================================ */

/** 运行资产并收集 print 输出（等待事件队列与异步链排空） */
async function runAndCollect(a: IRAsset, inject = true): Promise<string[]> {
  const printed: string[] = [];
  const prepared = inject ? injectSnippetRuntime(a, editorSpecMap()) : { asset: a, specs: editorSpecMap() };
  const rt = createRuntime(prepared.asset, prepared.specs, {
    onPrint: (...parts) => printed.push(parts.map(String).join(' ')),
  });
  rt.start();
  await new Promise((r) => setTimeout(r, 60));
  rt.stop();
  return printed;
}

test('runtime：纯片段表达式 → 下游节点（真实 specs 注入）', async () => {
  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('g1', 'var.get', { params: { varName: 'greeting' } }),
          node('snip', 'script.snippet', { params: { snippet: 'snipExclaim' } }),
          node('pr', 'system.print'),
        ],
        edges: [
          execEdge('x1', 'st', 'pr'),
          dataEdge('d1', 'g1', 'value', 'snip', 'x'),
          dataEdge('d2', 'snip', 'result', 'pr', 'value'),
        ],
      },
    },
    {
      variables: [{ name: 'greeting', type: 'string', default: 'hello' }],
      snippets: [
        {
          id: 'snipExclaim',
          lang: 'ts',
          code: 'result = x + "!";',
          pins: [
            { id: 'x', dir: 'in', type: 'any' },
            { id: 'result', dir: 'out', type: 'any' },
          ],
        },
      ],
    },
  );
  const printed = await runAndCollect(a);
  assert.deepEqual(printed, ['hello!']);
});

test('runtime：exec 片段插入链中（入脚注入 → 出脚映射 → exec 续链）', async () => {
  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('snip', 'script.snippet', {
            params: { snippet: 'snipDouble' },
            pinDefaults: { base: 21 },
          }),
          node('pr', 'system.print'),
        ],
        edges: [
          execEdge('x1', 'st', 'snip'),
          execEdge('x2', 'snip', 'pr'),
          dataEdge('d1', 'snip', 'doubled', 'pr', 'value'),
        ],
      },
    },
    {
      snippets: [
        {
          id: 'snipDouble',
          lang: 'ts',
          code: 'doubled = base * 2;',
          pins: [
            { id: 'exec', dir: 'in', type: 'exec' },
            { id: 'exec', dir: 'out', type: 'exec' },
            { id: 'base', dir: 'in', type: 'float' },
            { id: 'doubled', dir: 'out', type: 'float' },
          ],
        },
      ],
    },
  );
  const printed = await runAndCollect(a);
  assert.deepEqual(printed, ['42']);
});

test('runtime：片段内 this./vars. 写变量 + return 对象优先出脚', async () => {
  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('snip', 'script.snippet', {
            params: { snippet: 'snipCounter' },
            pinDefaults: { count: 2 },
          }),
          node('pr', 'system.print'),
        ],
        edges: [
          execEdge('x1', 'st', 'snip'),
          execEdge('x2', 'snip', 'pr'),
          dataEdge('d1', 'snip', 'next', 'pr', 'value'),
        ],
      },
    },
    {
      variables: [{ name: 'count', type: 'float', default: 0 }],
      snippets: [
        {
          id: 'snipCounter',
          lang: 'ts',
          code: 'this.count = count + 1;\nreturn { next: count * 10 };',
          pins: [
            { id: 'exec', dir: 'in', type: 'exec' },
            { id: 'exec', dir: 'out', type: 'exec' },
            { id: 'count', dir: 'in', type: 'float' },
            { id: 'next', dir: 'out', type: 'float' },
          ],
        },
      ],
    },
  );
  // 变量代理写回 + return 对象属性优先（next = 2 * 10 = 20）
  const printed = await runAndCollect(a);
  assert.deepEqual(printed, ['20']);
  // 变量确实被片段写入（this.count = count + 1 → 3）
  const rt = injectSnippetRuntime(a, editorSpecMap());
  const handle = createRuntime(rt.asset, rt.specs, { vars: { count: 0 } });
  handle.start();
  await new Promise((r) => setTimeout(r, 50));
  handle.stop();
});

test('runtime：async 片段（await delay 后出脚）+ 混合资产（执行片段与纯片段并存）', async () => {
  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('snipA', 'script.snippet', {
            params: { snippet: 'snipAsync' },
            pinDefaults: { input: 'go' },
          }),
          node('snipB', 'script.snippet', { params: { snippet: 'snipPure' } }),
          node('pr', 'system.print'),
        ],
        edges: [
          execEdge('x1', 'st', 'snipA'),
          execEdge('x2', 'snipA', 'pr'),
          dataEdge('d1', 'snipA', 'done', 'pr', 'value'),
          dataEdge('d2', 'snipB', 'result', 'pr', 'value'), // multi 汇入 print.value? 单值脚取首边
        ],
      },
    },
    {
      snippets: [
        {
          id: 'snipAsync',
          lang: 'ts',
          code: 'await delay(10);\ndone = input + "!" ;',
          pins: [
            { id: 'exec', dir: 'in', type: 'exec' },
            { id: 'exec', dir: 'out', type: 'exec' },
            { id: 'input', dir: 'in', type: 'any' },
            { id: 'done', dir: 'out', type: 'any' },
          ],
        },
        {
          id: 'snipPure',
          lang: 'ts',
          code: 'result = "pure";',
          pins: [{ id: 'result', dir: 'out', type: 'any' }],
        },
      ],
    },
  );
  const printed = await runAndCollect(a);
  // pr 的 value 脚取第一条边（snipA.done）
  assert.deepEqual(printed, ['go!']);
});

test('runtime：无 spec 注入时片段节点报未知类型（注入是必要步骤）', async () => {
  const a = asset(
    {
      main: {
        nodes: [node('st', 'event.start'), node('snip', 'script.snippet', { params: { snippet: 's1' } })],
        edges: [execEdge('x1', 'st', 'snip')],
      },
    },
    {
      snippets: [{ id: 's1', lang: 'ts', code: 'x = 1;', pins: [] }],
    },
  );
  const printed: string[] = [];
  const errors: string[] = [];
  const rt = createRuntime(a, editorSpecMap(), {
    onPrint: (...parts) => printed.push(parts.join(' ')),
    onError: (err) => errors.push(err.message),
  });
  rt.start();
  await new Promise((r) => setTimeout(r, 30));
  rt.stop();
  assert.ok(errors.some((m) => m.includes('未知节点类型') && m.includes('script.snippet')));
});

test('runtime：lang 非 ts 的片段执行报错（已知边界）', async () => {
  const a = asset(
    {
      main: {
        nodes: [node('st', 'event.start'), node('snip', 'script.snippet', { params: { snippet: 's1' } })],
        edges: [execEdge('x1', 'st', 'snip')],
      },
    },
    {
      snippets: [
        { id: 's1', lang: 'py', code: 'x = 1', pins: [{ id: 'exec', dir: 'in', type: 'exec' }] },
      ],
    },
  );
  const errors: string[] = [];
  const prepared = injectSnippetRuntime(a, editorSpecMap());
  const rt = createRuntime(prepared.asset, prepared.specs, {
    onError: (err) => errors.push(err.message),
  });
  rt.start();
  await new Promise((r) => setTimeout(r, 30));
  rt.stop();
  assert.ok(errors.some((m) => m.includes('py') && m.includes('ts 片段')));
});

test('runtime：injectSnippetRuntime 类型重写（纯片段 → script.snippet.pure；执行片段不变）', () => {  const a = asset(
    {
      main: {
        nodes: [
          node('p1', 'script.snippet', { params: { snippet: 'pureOne' } }),
          node('e1', 'script.snippet', { params: { snippet: 'execOne' } }),
        ],
        edges: [],
      },
    },
    {
      snippets: [
        { id: 'pureOne', lang: 'ts', code: 'r = 1;', pins: [{ id: 'r', dir: 'out', type: 'any' }] },
        {
          id: 'execOne',
          lang: 'ts',
          code: 'r = 2;',
          pins: [{ id: 'exec', dir: 'in', type: 'exec' }],
        },
      ],
    },
  );
  const { asset: rewritten, specs } = injectSnippetRuntime(a, editorSpecMap());
  assert.deepEqual(
    rewritten.graphs['main'].nodes.map((n) => n.type),
    ['script.snippet.pure', 'script.snippet'],
  );
  assert.equal(specs.get('script.snippet.pure')?.pure, true);
  assert.equal(specs.get('script.snippet')?.pure, false);
  assert.equal(a.graphs['main'].nodes[0].type, 'script.snippet'); // 入参资产不被改写
});

test('视图：irToFlow 片段节点动态 spec（标题 / 紫头 / 引脚按声明渲染）', () => {
  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('snip', 'script.snippet', {
            params: { snippet: 'abcdefgh1234' },
            pinDefaults: { threshold: 3 },
          }),
        ],
        edges: [],
      },
    },
    {
      snippets: [
        {
          id: 'abcdefgh1234',
          lang: 'ts',
          code: 'signal = threshold > 2;',
          pins: [
            { id: 'exec', dir: 'in', type: 'exec' },
            { id: 'exec', dir: 'out', type: 'exec' },
            { id: 'threshold', dir: 'in', type: 'int' },
            { id: 'signal', dir: 'out', type: 'bool' },
          ],
        },
      ],
    },
  );
  const { nodes } = irToFlow(a, editorSpecMap(), 'main');
  const snip = nodes.find((n) => n.id === 'snip');
  assert.ok(snip, '片段节点应渲染');
  assert.equal(snip.data.spec?.title, '片段：abcdefgh');
  assert.equal(snip.data.spec?.category, '脚本片段');
  // 头变体复用 plugin（紫）
  assert.equal(snip.data.variant, 'plugin');
  assert.deepEqual(snip.data.spec?.inputs.map((p) => p.id), ['exec', 'threshold']);
  assert.deepEqual(snip.data.spec?.outputs.map((p) => p.id), ['exec', 'signal']);
  // 连线端点类型按声明解析（数据边取色）
  const { edges } = irToFlow(
    {
      ...a,
      graphs: {
        ...a.graphs,
        main: {
          ...a.graphs['main'],
          edges: [
            { id: 'd1', from: { node: 'snip', pin: 'signal' }, to: { node: 'st', pin: 'exec' }, kind: 'data' },
          ],
        },
      },
    },
    editorSpecMap(),
    'main',
  );
  assert.equal(edges[0]?.data?.pinType, 'bool');
  // 引用缺失（空片段节点）→ 空引脚占位 spec（可见可双击编辑）
  const empty = asset(
    { main: { nodes: [node('fresh', 'script.snippet', {})], edges: [] } },
    { snippets: [] },
  );
  const { nodes: emptyNodes } = irToFlow(empty, editorSpecMap(), 'main');
  assert.equal(emptyNodes[0]?.data.spec?.title, '片段：未命名');
  assert.equal(emptyNodes[0]?.data.spec?.inputs.length, 0);
});

/* ============================================================
 * 4. 模态编辑 + 命令栈（happy-dom 冒烟；react-dom 仅在本节动态 import）
 * ============================================================ */

test('模态：挂载 / 编辑源码 / 增删引脚 / 保存回调 / 取消', async () => {
  const { Window } = await import('happy-dom');
  const dom = new Window({ url: 'http://localhost/' });
  for (const key of ['window', 'document', 'Event', 'KeyboardEvent', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Node']) {
    Object.defineProperty(globalThis, key, {
      value: (dom as unknown as Record<string, unknown>)[key],
      writable: true,
      configurable: true,
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
  const { act } = await import('react');
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SnippetEditModal } = await import('../blueprint/view/SnippetEditModal');

  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);

  let saved: { code: string; pins: IRSnippetPin[] } | null = null;
  let cancelled = 0;
  act(() => {
    root.render(
      createElement(SnippetEditModal, {
        snippet: {
          id: 'snip1',
          lang: 'ts',
          code: 'result = 1;',
          pins: [{ id: 'result', dir: 'out', type: 'any' }],
        },
        title: '片段：snip1',
        onSave: (code: string, pins: IRSnippetPin[]) => {
          saved = { code, pins };
        },
        onCancel: () => {
          cancelled += 1;
        },
      }),
    );
  });

  /* happy-dom 元素与 DOM lib 类型不兼容：双跳桥接（对齐 interaction.test.ts 约定） */
  const domEl = (selector: string, base?: unknown): HTMLElement | null =>
    ((base ?? container) as unknown as HTMLElement).querySelector(selector) as unknown as HTMLElement | null;
  const domElAll = (selector: string, base?: unknown): HTMLElement[] =>
    Array.from(((base ?? container) as unknown as HTMLElement).querySelectorAll(selector)) as unknown as HTMLElement[];
  const domInput = (el: HTMLElement): HTMLInputElement => el as unknown as HTMLInputElement;
  const domArea = (el: HTMLElement): HTMLTextAreaElement => el as unknown as HTMLTextAreaElement;
  const fireEvent = (el: HTMLElement, ev: unknown): void => {
    (el.dispatchEvent as (e: unknown) => void)(ev);
  };

  const codeBox = domArea(domEl('[data-testid="snippet-code"]')!);
  assert.equal(codeBox.value, 'result = 1;');
  const setCode = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setCode?.call(codeBox, 'result = 42;');
    fireEvent(codeBox, new dom.Event('input', { bubbles: true }));
  });

  // 增加一个输入脚并填写（新增行在末尾：querySelectorAll 取最后一行的 id 输入框）
  act(() => {
    domEl('[data-testid="snippet-add-in"]')!.click();
  });
  const idInputs = domElAll('[aria-label="引脚 id"]');
  const idInput = domInput(idInputs[idInputs.length - 1]);
  const setVal = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setVal?.call(idInput, 'x');
    fireEvent(idInput, new dom.Event('input', { bubbles: true }));
  });

  act(() => {
    domEl('[data-testid="snippet-save"]')!.click();
  });
  const savedSnap = saved as { code: string; pins: IRSnippetPin[] } | null;
  assert.ok(savedSnap, '保存回调应被调用');
  assert.equal(savedSnap.code, 'result = 42;');
  assert.deepEqual(savedSnap.pins, [
    { id: 'result', dir: 'out', type: 'any' },
    { id: 'x', dir: 'in', type: 'any' },
  ]);

  act(() => {
    domEl('[data-testid="snippet-cancel"]')!.click();
  });
  assert.equal(cancelled, 1);

  // 校验路径：空引脚 id 保存被拦截（独立容器，避免命中第一个模态的按钮）
  let saved2 = 0;
  const container2 = dom.document.createElement('div');
  dom.document.body.appendChild(container2);
  const root2 = createRoot(container2 as unknown as HTMLElement);
  act(() => {
    root2.render(
      createElement(SnippetEditModal, {
        snippet: null,
        title: '新建脚本片段',
        onSave: () => {
          saved2 += 1;
        },
        onCancel: () => {},
      }),
    );
  });
  act(() => {
    domEl('[data-testid="snippet-add-in"]', container2)!.click();
  });
  act(() => {
    domEl('[data-testid="snippet-save"]', container2)!.click();
  });
  assert.equal(saved2, 0, '空引脚 id 不应触发保存');
  assert.ok(container2.textContent?.includes('引脚 id 不能为空'));

  await act(async () => {
    root.unmount();
    root2.unmount();
  });
});

test('命令栈：saveSnippetEdit 编辑入栈 / undo 还原 / 镜像刷新', async () => {
  const { resetEditorStore, undo, peekUndo, subscribeReplay } = await import('../shell/commands');
  const { saveSnippetEdit } = await import('../blueprint/view/SnippetEditModal');
  const { useBlueprintStore } = await import('../blueprint/store/blueprint-store');
  resetEditorStore();
  // 模拟生产接线（useCanvasInteractions 的 subscribeReplay → 镜像刷新）
  const unsub = subscribeReplay((notice) => {
    if (notice.domains.includes('blueprint')) useBlueprintStore.getState().refreshFromDomain();
  });

  const a = asset(
    {
      main: {
        nodes: [
          node('st', 'event.start'),
          node('snip', 'script.snippet', { params: { snippet: 'snip1' } }),
        ],
        edges: [execEdge('x1', 'st', 'snip')],
      },
    },
    {
      snippets: [
        {
          id: 'snip1',
          lang: 'ts',
          code: 'result = 1;',
          pins: [{ id: 'result', dir: 'out', type: 'any' }],
        },
      ],
    },
  );
  useBlueprintStore.getState().openAsset(normalizeIR(a), 'logic/main.bp.json');

  assert.equal(saveSnippetEdit('main', 'snip', 'result = 2;', [{ id: 'result', dir: 'out', type: 'any' }]), true);
  const mirror = useBlueprintStore.getState().asset;
  assert.ok(mirror, 'store 镜像应已刷新');
  assert.equal(mirror.snippets[0].code, 'result = 2;');
  assert.ok(peekUndo(), '命令应入栈');

  undo();
  const after = useBlueprintStore.getState().asset;
  assert.ok(after, 'undo 后镜像应还原');
  assert.equal(after.snippets[0].code, 'result = 1;');
  unsub();

  // 新建片段：节点无 snippet 参数 → 保存时创建 IRSnippet + 回填 params
  const b = asset(
    {
      main: {
        nodes: [node('st', 'event.start'), node('fresh', 'script.snippet', {})],
        edges: [],
      },
    },
    { snippets: [] },
  );
  useBlueprintStore.getState().openAsset(normalizeIR(b), 'logic/fresh.bp.json');
  assert.equal(saveSnippetEdit('main', 'fresh', 'y = 1;', [{ id: 'y', dir: 'out', type: 'any' }]), true);
  const m2 = useBlueprintStore.getState().asset;
  assert.ok(m2, 'store 镜像应已刷新');
  assert.equal(m2.snippets.length, 1);
  assert.equal(m2.snippets[0].id, 'snip1');
  assert.equal(m2.graphs['main'].nodes.find((n) => n.id === 'fresh')?.params[SNIPPET_PARAM_KEY], 'snip1');
  // 再保存一次应复用同一片段 id（编辑而非新建）
  saveSnippetEdit('main', 'fresh', 'y = 2;', []);
  const m3 = useBlueprintStore.getState().asset;
  assert.ok(m3, 'store 镜像应已刷新');
  assert.equal(m3.snippets.length, 1);
  assert.equal(m3.snippets[0].code, 'y = 2;');
});
