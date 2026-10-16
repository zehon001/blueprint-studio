/**
 * Blueprint Studio v2 —— roundtrip 幂等测试（T3.5 / T3.6 共同 DoD；TA.1 的 TS 部分基座）
 *
 * *******************************************************************************************
 *  本文件即 TA.1（roundtrip 幂等测试框架）的 TS 部分雏形：TA.1 落地 `tests/roundtrip/`
 *  时，应把本文件的 roundtripIR / canonicalIR 比较器与样本库原样迁入，并扩展
 *  IR→Py→IR 与片段节点专项样本；`npm run roundtrip` 的 script-check.ts 接线同源。
 * *******************************************************************************************
 *
 * 断言口径（PLAN §10 / §20-2）：
 *  normalizeIR(asset) ≡ normalizeIR(parseScriptToIR(codegenTS(asset)).asset)
 *  —— 深等比较在【确定性规范化】后进行（canonicalIR）：
 *    · 节点 / 连线实例 id：纯节点内联为表达式后 id 无法在代码文本中无损携带，
 *      双侧按「结构精化键（WL 迭代）+ 稳定排序」重命名（n1..nK / e1..eK）；
 *    · position / layout：编辑状态，codegen 不保留，双侧清零；
 *    · events / snippets 数组序：事件表 / 片段表在往返中按「方法序 + 孤儿序」重建，
 *      按名 / id 排序后比较（variables 顺序可无损往返，不排序）。
 *  另做幂等二次验证：对 roundtrip 的输出再跑一轮 codegen→parse，仍与首轮输出等价。
 *
 * 样本（DoD）：
 *  ① 手工构造全特性样本（exposed 变量 / 事件参数 / 函数图 / 分支 / 双循环 / 纯链 /
 *    ui 节点 / 片段节点 / map.set 链 / 透传别名 / 孤儿事件 / 孤儿片段）；
 *  ②③④ 用 src/nodes 真实节点构造的业务样本：条件分支+循环计数、日志分析管线、
 *    字符串处理链；
 *  ⑤⑥ 复用 nodes.test / validate.test 的样本形态（分支+循环+变量读写；
 *    forEach 遍历+break）；
 *  ⑦ 表达式映射表逐条锁定（遍历 builtinSpecs 全部纯节点，逐节点构造样本往返）；
 *  ⑧ esbuild transform 语法校验（全部样本的生成码经 esbuild 转译无错）；
 *  ⑨ 解析器诊断（语法错误的行列 / 不可映射语句折叠）与 codegen 抛错约定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import type { IRAsset, IREdge, IRGraph, IRNode } from '../ir/types';
import { normalizeIR } from '../ir/validate';
import { builtinSpecs } from '../nodes';
import { codegenTS } from './codegen-ts';
import { parseScriptToIR, type ParseDiagnostic } from './parser-ts';
import { interopSpecMap, stableStringify } from './codegen-common';

/* ============================================================
 * 样本构造帮助（与 validate.test.ts 同款）
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

/** 递归找首个差异路径（语义对齐 assert.deepStrictEqual；undefined 值键视同缺失） */
function firstDiff(a: unknown, b: unknown, path = ''): string {
  if (Object.is(a, b)) return '';
  if (
    typeof a !== 'object' || a === null || typeof b !== 'object' || b === null ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return `${path || '(root)'}: ${JSON.stringify(a) ?? String(a)} !== ${JSON.stringify(b) ?? String(b)}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: 数组长度 ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const ka = Object.keys(recA).filter((k) => recA[k] !== undefined);
  const kb = Object.keys(recB).filter((k) => recB[k] !== undefined);
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(recB, k) || recB[k] === undefined) {
      return `${path}.${k} 仅 PARSED 有: ${JSON.stringify(recA[k])?.slice(0, 300)}`;
    }
  }
  for (const k of kb) {
    if (!Object.prototype.hasOwnProperty.call(recA, k) || recA[k] === undefined) {
      return `${path}.${k} 仅 ORIG 有: ${JSON.stringify(recB[k])?.slice(0, 300)}`;
    }
  }
  for (const k of ka) {
    const d = firstDiff(recA[k], recB[k], `${path}.${k}`);
    if (d) return d;
  }
  return '';
}

/** 生成码经 esbuild 转译无语法错（受控子集可编译性的轻量证明；transform 失败时抛错） */
async function assertTranspiles(code: string): Promise<void> {
  try {
    await transform(code, {
      loader: 'ts',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    });
  } catch (err) {
    assert.fail(`esbuild 转译失败：${err instanceof Error ? err.message : String(err)}\n${code}`);
  }
}

function noDiags(diagnostics: ParseDiagnostic[]): void {
  assert.deepEqual(
    diagnostics,
    [],
    `解析不应产生诊断，实际：${diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`).join('；')}`,
  );
}

/* ============================================================
 * 规范形比较器（canonicalIR）
 * ============================================================ */

interface RefinedGraph {
  nodes: IRNode[];
  edges: IREdge[];
}

/** 单图规范化：结构精化键重命名节点（n1..nK），边按结构排序重命名（e1..eK），position 清零 */
function hash32(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
  }
  return h.toString(36);
}

function canonicalGraph(g: IRGraph): RefinedGraph {
  // 初始内容键（哈希压缩——键参与多轮精化，嵌套原文会指数膨胀）
  const keys = new Map<string, string>();
  for (const n of g.nodes) {
    // 精化键只含 type / params / pinDefaults（title / comment 为显示覆盖，不参与比较）
    keys.set(
      n.id,
      hash32(stableStringify({ t: n.type, p: n.params, pd: n.pinDefaults })),
    );
  }
  // WL 精化（邻居哈希参与，至多 12 轮或稳定）
  for (let iter = 0; iter < 12; iter += 1) {
    const next = new Map<string, string>();
    let changed = false;
    for (const n of g.nodes) {
      const inE = g.edges
        .filter((e) => e.to.node === n.id)
        .map((e) => `${keys.get(e.from.node)}|${e.from.pin}|${e.kind}`)
        .sort();
      const outE = g.edges
        .filter((e) => e.from.node === n.id)
        .map((e) => `${keys.get(e.to.node)}|${e.to.pin}|${e.kind}`)
        .sort();
      const k = hash32(stableStringify({ k: keys.get(n.id), i: inE, o: outE }));
      next.set(n.id, k);
      if (k !== keys.get(n.id)) changed = true;
    }
    keys.clear();
    for (const [id, k] of next) keys.set(id, k);
    if (!changed) break;
  }
  // 排序重命名（同键按原 id 决胜——对称结构两侧决胜结果一致）
  const order = [...g.nodes].sort((a, b) => {
    const ka = keys.get(a.id)!;
    const kb = keys.get(b.id)!;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const rename = new Map<string, string>(order.map((n, i) => [n.id, `n${i + 1}`]));
  // title / comment 为显示覆盖（蓝图视图域），代码文本不携带 —— 与 position/layout 一同剔除
  const nodes = order.map((n, i) => ({
    id: `n${i + 1}`,
    type: n.type,
    params: n.params,
    pinDefaults: n.pinDefaults,
    position: { x: 0, y: 0 },
  }));
  const edges = g.edges
    .map((e) => ({
      kind: e.kind,
      from: { node: rename.get(e.from.node) ?? '?', pin: e.from.pin },
      to: { node: rename.get(e.to.node) ?? '?', pin: e.to.pin },
    }))
    .sort((a, b) => (stableStringify(a) < stableStringify(b) ? -1 : 1))
    .map((e, i) => ({ id: `e${i + 1}`, ...e }));
  return { nodes, edges };
}

/** 资产规范化：id / position / layout 剔除语义等价性噪声；events / snippets 排序 */
function canonicalIR(asset: IRAsset): IRAsset {
  const base = normalizeIR(asset);
  const graphs: Record<string, IRGraph> = {};
  for (const name of Object.keys(base.graphs).sort()) {
    const refined = canonicalGraph(base.graphs[name]);
    graphs[name] = { nodes: refined.nodes, edges: refined.edges };
    if (base.graphs[name].params) graphs[name].params = base.graphs[name].params;
    if (base.graphs[name].returns) graphs[name].returns = base.graphs[name].returns;
    if (base.graphs[name].comments) graphs[name].comments = base.graphs[name].comments;
  }
  return {
    ...base,
    graphs,
    layout: {},
    events: [...base.events].sort((a, b) => (a.name < b.name ? -1 : 1)),
    snippets: [...base.snippets].sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

/* ============================================================
 * roundtripIR（TA.1 比较器原型）
 * ============================================================ */

export interface RoundtripResult {
  ok: boolean;
  /** 解析得到的 IR（ok = true 时返回） */
  again?: IRAsset;
  /** 失败原因（codegen 抛错 / 深等差异 / 二次幂等破坏） */
  diff?: string;
  /** 生成码（便于 diff 排查） */
  code?: string;
}

/** IR → TS → IR 幂等比较（含二次幂等验证） */
export function roundtripIR(asset: IRAsset): RoundtripResult {
  let code: string;
  try {
    code = codegenTS(asset);
  } catch (err) {
    return { ok: false, diff: `codegen 抛错：${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = parseScriptToIR(code);
  {
    let same = true;
    try {
      assert.deepStrictEqual(canonicalIR(parsed.asset), canonicalIR(asset));
    } catch {
      same = false;
    }
    if (!same) {
      return {
        ok: false,
        diff: `roundtrip 深等失败，首差异：${firstDiff(canonicalIR(parsed.asset), canonicalIR(asset))}`,
        code,
      };
    }
  }
  // 幂等二次验证：对解析输出再跑一轮仍稳定
  let code2: string;
  try {
    code2 = codegenTS(parsed.asset);
  } catch (err) {
    return { ok: false, diff: `二次 codegen 抛错：${err instanceof Error ? err.message : String(err)}`, code };
  }
  const parsed2 = parseScriptToIR(code2);
  {
    let same = true;
    try {
      assert.deepStrictEqual(canonicalIR(parsed2.asset), canonicalIR(parsed.asset));
    } catch {
      same = false;
    }
    if (!same) {
      return {
        ok: false,
        diff: `二次幂等破坏，首差异：${firstDiff(canonicalIR(parsed2.asset), canonicalIR(parsed.asset))}`,
        code,
      };
    }
  }
  return { ok: true, again: parsed.asset, code };
}

/** 样本断言：roundtrip 全绿 + 生成码可转译 + 解析零诊断 */
async function assertRoundtrip(asset: IRAsset): Promise<string> {
  const r = roundtripIR(asset);
  assert.equal(r.ok, true, `roundtrip 失败：${r.diff ?? ''}\n===== 生成码 =====\n${r.code ?? ''}`);
  noDiags(parseScriptToIR(r.code ?? '').diagnostics);
  await assertTranspiles(r.code ?? '');
  return r.code ?? '';
}

/* ============================================================
 * ① 全特性手工样本
 * ============================================================ */

export const fullFeatureAsset = asset(
  {
    bind: graph(
      [
        node('st', 'event.start'),
        node('cntGet1', 'var.get', { params: { varName: 'count' } }),
        node('add1', 'math.add'),
        node('set1', 'var.set', { params: { varName: 'count' } }),
        node('print1', 'system.print'),
        node('cmp1', 'math.compare', { params: { op: '>=' }, pinDefaults: { b: 5 } }),
        node('br1', 'flow.branch'),
        node('fmt1', 'string.format', { pinDefaults: { template: '计数 {0}' } }),
        node('uiw1', 'ui.setValue', { pinDefaults: { name: 'title' } }),
        node('not1', 'math.not'),
        node('flagGet', 'var.get', { params: { varName: 'flag' } }),
        node('uiv1', 'ui.setVisible', { pinDefaults: { name: 'list' } }),
        node('toGet', 'var.get', { params: { varName: 'count' } }),
        node('loop1', 'flow.forLoop'),
        node('pr1', 'system.print'),
        node('dl1', 'flow.delay', { pinDefaults: { seconds: 0.5 } }),
        node('pr2', 'system.print'),
        node('send1', 'event.send', { pinDefaults: { eventName: 'loaded' } }),
        node('objA', 'map.set', { pinDefaults: { map: {}, key: 'count' } }),
        node('objB', 'map.set', { pinDefaults: { key: 'label' } }),
        node('snipNode', 'script.snippet', { params: { snippet: 'snip1' } }),
        node('gv1', 'ui.getValue', { pinDefaults: { name: 'input' } }),
        node('call1', 'flow.call', { params: { graph: 'parseLog' }, pinDefaults: { minLevel: 'E' } }),
        node('pr4', 'system.print'),
        node('set2', 'var.set', { params: { varName: 'count' } }),
        node('mk1', 'array.make', { pinDefaults: { in0: 'a', in1: 'b' } }),
        node('fe1', 'array.forEach'),
        node('uiw2', 'ui.setValue', { pinDefaults: { name: 'label' } }),
        node('pr3', 'system.print'),
        node('evt1', 'event.custom', { params: { eventName: 'loaded' } }),
        node('fmt2', 'string.format', { pinDefaults: { template: '{1} / {0}' } }),
        node('uiw3', 'ui.setValue', { pinDefaults: { name: 'status' } }),
        node('lst1', 'event.listen', { pinDefaults: { eventName: 'tick' } }),
        node('pr5', 'system.print'),
      ],
      [
        execEdge('x1', 'st', 'set1'),
        execEdge('x3', 'set1', 'print1'),
        execEdge('x4', 'print1', 'br1'),
        execEdge('x6', 'br1', 'uiw1', 'true'),
        execEdge('x8', 'uiw1', 'loop1'),
        execEdge('x9', 'br1', 'uiv1', 'false'),
        execEdge('x10', 'uiv1', 'loop1'),
        execEdge('x11', 'loop1', 'pr1', 'body'),
        execEdge('x11b', 'pr1', 'loop1'),
        execEdge('x12', 'loop1', 'dl1', 'done'),
        execEdge('x12c', 'dl1', 'pr2', 'done'),
        execEdge('x13', 'pr2', 'send1'),
        execEdge('x14', 'send1', 'snipNode'),
        execEdge('x15', 'snipNode', 'call1'),
        execEdge('x16', 'call1', 'pr4'),
        execEdge('x17', 'pr4', 'set2'),
        execEdge('x18', 'set2', 'fe1'),
        execEdge('x19', 'fe1', 'uiw2', 'body'),
        execEdge('x19b', 'uiw2', 'fe1'),
        execEdge('x20', 'fe1', 'pr3', 'done'),
        execEdge('x21', 'evt1', 'uiw3'),
        execEdge('x22', 'lst1', 'pr5'),
        dataEdge('d1', 'cntGet1', 'value', 'add1', 'a'),
        dataEdge('d2', 'add1', 'value', 'set1', 'value'),
        dataEdge('d3', 'set1', 'value', 'print1', 'value'),
        dataEdge('d4', 'cntGet1', 'value', 'cmp1', 'a'),
        dataEdge('d5', 'cmp1', 'value', 'br1', 'cond'),
        dataEdge('d6', 'cntGet1', 'value', 'fmt1', 'args'),
        dataEdge('d7', 'fmt1', 'value', 'uiw1', 'value'),
        dataEdge('d8', 'flagGet', 'value', 'not1', 'a'),
        dataEdge('d9', 'not1', 'value', 'uiv1', 'visible'),
        dataEdge('d10', 'toGet', 'value', 'loop1', 'to'),
        dataEdge('d11', 'loop1', 'index', 'pr1', 'value'),
        dataEdge('d12', 'loop1', 'index', 'pr2', 'value'),
        dataEdge('d13', 'cntGet1', 'value', 'objA', 'value'),
        dataEdge('d14', 'objB', 'map', 'send1', 'args'),
        dataEdge('d15', 'gv1', 'value', 'call1', 'lines'),
        dataEdge('d16', 'call1', 'rows', 'pr4', 'value'),
        dataEdge('d17', 'call1', 'errs', 'set2', 'value'),
        dataEdge('d18', 'mk1', 'array', 'fe1', 'array'),
        dataEdge('d19', 'fe1', 'element', 'uiw2', 'value'),
        dataEdge('d20', 'fe1', 'element', 'pr3', 'value'),
        dataEdge('d21', 'evt1', 'count', 'fmt2', 'args'),
        dataEdge('d22', 'evt1', 'label', 'fmt2', 'args'),
        dataEdge('d23', 'fmt2', 'value', 'uiw3', 'value'),
        dataEdge('d24', 'lst1', 'args', 'pr5', 'value'),
        // objA / objB：map.set 链（objB.map ← objA.map 在 d14 之前……见下）
        { id: 'd14b', from: { node: 'objA', pin: 'map' }, to: { node: 'objB', pin: 'map' }, kind: 'data' },
      ],
    ),
    parseLog: {
      nodes: [
        node('fe', 'func.entry'),
        node('ap1', 'convert.androidLogParse'),
        node('srt1', 'array.sort', { pinDefaults: { key: 'ts' } }),
        node('flt1', 'array.filter', { pinDefaults: { field: 'level' } }),
        node('len1', 'array.length'),
        node('fr', 'func.return'),
      ],
      edges: [
        execEdge('fx1', 'fe', 'fr'),
        dataEdge('fd1', 'fe', 'lines', 'ap1', 'lines'),
        dataEdge('fd2', 'ap1', 'rows', 'srt1', 'array'),
        dataEdge('fd3', 'srt1', 'array', 'flt1', 'array'),
        dataEdge('fd4', 'flt1', 'array', 'len1', 'array'),
        dataEdge('fd5', 'srt1', 'array', 'fr', 'rows'),
        dataEdge('fd6', 'len1', 'value', 'fr', 'errs'),
        dataEdge('fd7', 'fe', 'minLevel', 'flt1', 'value'),
      ],
      params: [
        { name: 'lines', type: 'string[]' },
        { name: 'minLevel', type: 'string' },
      ],
      returns: [
        { name: 'rows', type: 'LogRow[]' },
        { name: 'errs', type: 'int' },
      ],
    },
  },
  {
    name: '日志查看器',
    entry: 'bind',
    variables: [
      { name: 'packageName', type: 'string', default: 'com.demo', exposed: true, category: '配置' },
      { name: 'count', type: 'int', default: 0 },
      { name: 'rows', type: 'LogRow[]' },
      { name: 'flag', type: 'bool' },
    ],
    events: [
      { name: 'loaded', params: [{ name: 'count', type: 'int' }, { name: 'label', type: 'string' }] },
      { name: 'tick', params: [] },
      { name: 'ping', params: [] },
    ],
    snippets: [
      {
        id: 'snip1',
        lang: 'ts',
        code: 'const errCount = 1;\nprint(errCount);',
        pins: [
          { id: 'exec', dir: 'in', type: 'exec' },
          { id: 'exec', dir: 'out', type: 'exec' },
        ],
      },
    ],
  },
);

test('roundtrip ①：全特性手工样本（事件/分支/双循环/函数图/片段/ui/透传别名/孤儿事件）', async () => {
  const code = await assertRoundtrip(fullFeatureAsset);
  // 关键形态抽查（可读性约定锁定）
  assert.match(code, /@tool\("日志查看器"\)/);
  assert.match(code, /@expose\(\{ type: "string", default: "com\.demo", category: "配置" \}\)/);
  assert.match(code, /@on\('start'\)/);
  assert.match(code, /@on\("loaded"\)/);
  assert.match(code, /@onEvent\("tick"\)/);
  assert.match(code, /const \{ rows, errs \} = await this\.parseLog\(ui\.input\.value, "E"\);/);
  assert.match(code, /await delay\(500\);/);
  // 孤儿事件 ping（未被任何 @on 绑定）
  assert.match(code, /__bps-events/);
  // 孤儿片段（snip1 已被节点引用，不应出现 loose 标记）
  assert.doesNotMatch(code, /__bps-loose-begin/);
});

test('roundtrip ①b：事件参数引用 / 片段源码原样保留', async () => {
  const code = codegenTS(fullFeatureAsset);
  // 事件参数在方法体内以参数名引用（evt1 的 count / label 输出脚）
  assert.match(code, /format\("\{1\} \/ \{0\}", count, label\)/);
  // 片段源码原样出现
  assert.match(code, /__bps-snippet-begin\(snip1\)/);
  assert.match(code, /const errCount = 1;/);
  assert.match(code, /__bps-snippet-end\(snip1\)/);
});

/* ============================================================
 * ② 条件分支 + 循环计数（真实节点）
 * ============================================================ */

const counterAsset = asset(
  {
    main: graph(
      [
        node('st', 'event.start'),
        node('cntGet1', 'var.get', { params: { varName: 'count' } }),
        node('cmp1', 'math.compare', { pinDefaults: { b: 3 } }),
        node('br1', 'flow.branch'),
        node('cntGet2', 'var.get', { params: { varName: 'count' } }),
        node('add1', 'math.add'),
        node('set1', 'var.set', { params: { varName: 'count' } }),
        node('print1', 'system.print'),
        node('pr0', 'system.print', { pinDefaults: { value: '跳过' } }),
        node('cntGet3', 'var.get', { params: { varName: 'count' } }),
        node('loop1', 'flow.forLoop'),
        node('pr1', 'system.print'),
        node('pr2', 'system.print'),
      ],
      [
        execEdge('x1', 'st', 'br1'),
        execEdge('x2', 'br1', 'set1', 'true'),
        execEdge('x3', 'set1', 'print1'),
        execEdge('x4', 'print1', 'loop1'),
        execEdge('x5', 'br1', 'pr0', 'false'),
        execEdge('x6', 'pr0', 'loop1'),
        execEdge('x7', 'loop1', 'pr1', 'body'),
        execEdge('x7b', 'pr1', 'loop1'),
        execEdge('x8', 'loop1', 'pr2', 'done'),
        dataEdge('d1', 'cntGet1', 'value', 'cmp1', 'a'),
        dataEdge('d2', 'cmp1', 'value', 'br1', 'cond'),
        dataEdge('d3', 'cntGet2', 'value', 'add1', 'a'),
        dataEdge('d4', 'add1', 'value', 'set1', 'value'),
        dataEdge('d5', 'set1', 'value', 'print1', 'value'),
        dataEdge('d6', 'cntGet3', 'value', 'loop1', 'to'),
        dataEdge('d7', 'loop1', 'index', 'pr1', 'value'),
        dataEdge('d8', 'loop1', 'index', 'pr2', 'value'),
      ],
    ),
  },
  { variables: [{ name: 'count', type: 'int', default: 0 }] },
);

test('roundtrip ②：条件分支 + 循环计数（分支汇合 / 循环后引用索引 / 透传别名）', async () => {
  const code = await assertRoundtrip(counterAsset);
  assert.match(code, /if \(\(this\.count > 3\)\) \{/);
  assert.match(code, /const __bps_v\d+ = \(this\.count = \(this\.count \+ 0\)\);/);
  assert.match(code, /for \(i\d* = 0; i\d* <= this\.count; i\d* \+= 1\) \{/);
});

/* ============================================================
 * ③ 日志分析管线（真实节点：androidLogParse / filter / ui / format）
 * ============================================================ */

const logPipelineAsset = asset(
  {
    main: graph(
      [
        node('st', 'event.start'),
        node('gv', 'ui.getValue', { pinDefaults: { name: 'input' } }),
        node('ap', 'convert.androidLogParse'),
        node('flt', 'array.filter', { pinDefaults: { field: 'level' } }),
        node('minGet', 'var.get', { params: { varName: 'minLevel' } }),
        node('cstr', 'convert.toString'),
        node('uiw', 'ui.listSetItems', { pinDefaults: { name: 'list' } }),
        node('fmt', 'string.format', { pinDefaults: { template: '共 {0} 条错误' } }),
        node('pr', 'system.print'),
      ],
      [
        execEdge('x1', 'st', 'uiw'),
        execEdge('x2', 'uiw', 'pr'),
        dataEdge('d1', 'gv', 'value', 'ap', 'lines'),
        dataEdge('d2', 'ap', 'rows', 'flt', 'array'),
        dataEdge('d3', 'minGet', 'value', 'flt', 'value'),
        dataEdge('d4', 'flt', 'array', 'uiw', 'items'),
        dataEdge('d5', 'ap', 'count', 'cstr', 'value'),
        dataEdge('d6', 'cstr', 'value', 'fmt', 'args'),
        dataEdge('d7', 'fmt', 'value', 'pr', 'value'),
      ],
    ),
  },
  {
    variables: [{ name: 'minLevel', type: 'string', default: 'E' }],
  },
);

test('roundtrip ③：日志分析管线（androidLogParse 双输出别名 + filter + ui.listSetItems）', async () => {
  const code = await assertRoundtrip(logPipelineAsset);
  // androidLogParse 出度 2 → 共享别名；count 输出以 .length 特例承载
  assert.match(code, /const __bps_v\d+ = convert\.androidLogParse\(ui\.input\.value, ""\);/);
  assert.match(code, /const __bps_v\d+ = \(__bps_v\d+\)\.length;/);
  assert.match(code, /convert\.toString\(__bps_v\d+\)/);
  assert.match(code, /ui\.list\.items = bps\.array\.filter\(__bps_v\d+, "level", this\.minLevel, "=="\);/);
});

/* ============================================================
 * ④ 字符串处理链（真实节点：concat/trim/upper/length/json/map/regex）
 * ============================================================ */

const stringChainAsset = asset(
  {
    main: graph(
      [
        node('st', 'event.start'),
        node('rawGet', 'var.get', { params: { varName: 'raw' } }),
        node('trim', 'string.trim'),
        node('upper', 'string.upper'),
        node('c1', 'string.concat', { pinDefaults: { a: '结果: ' } }),
        node('len', 'string.length'),
        node('cfgGet', 'var.get', { params: { varName: 'cfg' } }),
        node('jp', 'convert.jsonParse'),
        node('mg', 'map.get'),
        node('rx', 'string.regexMatch', { pinDefaults: { pattern: '\\d+' } }),
        node('pr1', 'system.print'),
        node('pr2', 'system.print'),
        node('pr3', 'system.print'),
        node('pr4', 'system.print'),
      ],
      [
        execEdge('x1', 'st', 'pr1'),
        execEdge('x2', 'pr1', 'pr2'),
        execEdge('x3', 'pr2', 'pr3'),
        execEdge('x4', 'pr3', 'pr4'),
        dataEdge('d1', 'rawGet', 'value', 'trim', 'value'),
        dataEdge('d2', 'trim', 'value', 'upper', 'value'),
        dataEdge('d3', 'upper', 'value', 'c1', 'b'),
        dataEdge('d4', 'c1', 'value', 'pr1', 'value'),
        dataEdge('d5', 'c1', 'value', 'len', 'value'),
        dataEdge('d6', 'len', 'value', 'pr2', 'value'),
        dataEdge('d7', 'cfgGet', 'value', 'jp', 'value'),
        dataEdge('d8', 'jp', 'value', 'mg', 'map'),
        dataEdge('d9', 'mg', 'value', 'pr3', 'value'),
        dataEdge('d10', 'rawGet', 'value', 'rx', 'value'),
        dataEdge('d11', 'rx', 'value', 'pr4', 'value'),
      ],
    ),
  },
  {
    variables: [
      { name: 'raw', type: 'string', default: '  hello 42  ' },
      { name: 'cfg', type: 'object', default: { a: 1, b: 'x' } },
    ],
  },
);

test('roundtrip ④：字符串处理链（模板拼接 / 共享别名 / json / map.get / regexMatch）', async () => {
  const code = await assertRoundtrip(stringChainAsset);
  // concat 左字面量 + 右子链 → 模板字符串；嵌套 trim→upper 内联；共享节点走别名
  assert.match(code, /const __bps_v\d+ = `结果: \$\{\(\(__bps_v\d+\)\.trim\(\)\)\.toUpperCase\(\)\}`;/);
  assert.match(code, /print\(__bps_v\d+\);/);
  assert.match(code, /print\(\(__bps_v\d+\)\.length\);/);
  assert.match(code, /bps\.map\.get\(convert\.jsonParse\(this\.cfg\), ""\)/);
  assert.match(code, /bps\.string\.regexMatch\(__bps_v\d+, "\\\\d\+"\)/);
});

/* ============================================================
 * ⑤⑥ nodes.test / validate.test 样本形态复用
 * ============================================================ */

/** 形态复用 validate.test.ts「分支+循环+变量读写」集成样本（事件监听并入主图） */
const branchLoopVarAsset = asset(
  {
    main: graph(
      [
        node('st', 'event.start'),
        node('readCnt', 'var.get', { params: { varName: 'count' } }),
        node('br', 'flow.branch'),
        node('loop', 'flow.forLoop'),
        node('show', 'system.print', { title: '打印计数' }),
        node('writeCnt', 'var.set', { params: { varName: 'count' } }),
        node('lst', 'event.listen', { pinDefaults: { eventName: 'tick' } }),
        node('show2', 'system.print'),
      ],
      [
        execEdge('e1', 'st', 'br'),
        execEdge('e2', 'br', 'loop', 'true'),
        execEdge('e3', 'loop', 'show', 'body'),
        execEdge('e4', 'loop', 'writeCnt', 'done'),
        execEdge('e5', 'lst', 'show2'),
        execEdge('e9', 'show', 'loop'),
        dataEdge('d1', 'readCnt', 'value', 'br', 'cond'),
        dataEdge('d2', 'loop', 'index', 'show', 'value'),
        dataEdge('d3', 'readCnt', 'value', 'writeCnt', 'value'),
        dataEdge('d4', 'lst', 'args', 'show2', 'value'),
      ],
    ),
  },
  { variables: [{ name: 'count', type: 'int', default: 0 }], events: [{ name: 'tick', params: [] }] },
);

test('roundtrip ⑤：validate.test 集成样本形态（分支+循环+变量读写+事件监听）', async () => {
  const code = await assertRoundtrip(branchLoopVarAsset);
  // readCnt 出度 2（分支条件 + 出口写入）→ 别名一次性求值
  assert.match(code, /const __bps_v\d+ = this\.count;/);
  assert.match(code, /this\.count = __bps_v\d+;/);
  assert.match(code, /@onEvent\("tick"\)/);
});

/** 形态复用 nodes.test.ts「forEach 逐元素迭代 + break」样本 */
const forEachBreakAsset = asset(
  {
    main: graph(
      [
        node('st', 'event.start'),
        node('mk', 'array.make', { pinDefaults: { in0: 'x', in1: 'y', in2: 'z' } }),
        node('fe', 'array.forEach'),
        node('flagGet', 'var.get', { params: { varName: 'flag' } }),
        node('pr1', 'system.print'),
        node('pr2', 'system.print'),
      ],
      [
        execEdge('x1', 'st', 'fe'),
        execEdge('x2', 'fe', 'pr1', 'body'),
        execEdge('x2b', 'pr1', 'fe'),
        execEdge('x3', 'fe', 'pr2', 'done'),
        dataEdge('d1', 'mk', 'array', 'fe', 'array'),
        dataEdge('d2', 'fe', 'element', 'pr1', 'value'),
        dataEdge('d3', 'flagGet', 'value', 'fe', 'break'),
        dataEdge('d4', 'fe', 'index', 'pr2', 'value'),
      ],
    ),
  },
  { variables: [{ name: 'flag', type: 'bool', default: true }] },
);

test('roundtrip ⑥：nodes.test forEach 形态（遍历 + break 引脚 + 下标输出）', async () => {
  const code = await assertRoundtrip(forEachBreakAsset);
  assert.match(code, /for \(\[i\d*, el\d*\] of \(\["x", "y", "z"\]\)\.entries\(\)\) \{/);
  assert.match(code, /if \(this\.flag\) \{\s*\n\s*break;\s*\n\s*\}/);
});

/* ============================================================
 * ⑦ 表达式映射表逐条锁定（builtinSpecs 全部纯节点）
 * ============================================================ */

/** 为一个纯节点构造最小样本：引脚取 spec 默认值 / 字面量，结果交给 print */
function pureNodeSample(specId: string): IRAsset {
  const spec = interopSpecMap().get(specId);
  assert.ok(spec, `spec ${specId} 应存在`);
  const nd = node('p1', specId);
  // 约定：样本不显式写入「等于 spec 默认值」的引脚值 / 检视器参数（往返后归一为缺省，
  // 语义不变；默认值在生成码中以有效字面量出现，解析端按 spec 默认值剥离）。
  // 几个节点补上更真实的字面量（避免空串模板等退化输出，同时覆盖字面量实参路径）
  if (specId === 'string.concat') {
    nd.pinDefaults['a'] = 'A';
    nd.pinDefaults['b'] = 'B';
  }
  if (specId === 'string.format') {
    nd.pinDefaults['template'] = '{0}';
    nd.pinDefaults['args'] = ['x'];
  }
  if (specId === 'string.split') nd.pinDefaults['sep'] = ',';
  if (specId === 'string.replace') {
    nd.pinDefaults['from'] = 'a';
    nd.pinDefaults['to'] = 'b';
  }
  if (specId === 'string.contains') nd.pinDefaults['search'] = 'a';
  if (specId === 'string.regexMatch' || specId === 'string.regexExtract') nd.pinDefaults['pattern'] = '\\d';
  if (specId === 'array.make') {
    nd.pinDefaults['in0'] = 1;
    nd.pinDefaults['in1'] = 'b';
  }
  if (specId === 'array.set') {
    nd.pinDefaults['index'] = 1;
    nd.pinDefaults['value'] = 9;
  }
  if (specId === 'array.push') nd.pinDefaults['value'] = 9;
  if (specId === 'array.filter') {
    nd.pinDefaults['field'] = 'k';
    nd.pinDefaults['value'] = 1;
  }
  if (specId === 'array.pluck') nd.pinDefaults['field'] = 'k';
  if (specId === 'array.sort') nd.pinDefaults['key'] = 'k';
  if (specId === 'map.get') nd.pinDefaults['key'] = 'k';
  if (specId === 'map.set') {
    nd.pinDefaults['key'] = 'k';
    nd.pinDefaults['value'] = 1;
  }
  if (specId === 'map.has') nd.pinDefaults['key'] = 'k';
  if (specId === 'convert.timeFormat') nd.params['format'] = 'YYYY-MM-DD';
  if (specId === 'var.get') nd.params['varName'] = 'x';
  if (specId === 'ui.getValue') {
    nd.pinDefaults['name'] = 'list';
    nd.pinDefaults['attr'] = 'items';
  }
  if (specId === 'convert.androidLogParse') {
    nd.pinDefaults['lines'] = '10-01 08:00:00.000 I/tag (1): hello';
    nd.params['levelFilter'] = 'I';
  }
  const outPin = spec.outputs.find((p) => p.type !== 'exec')?.id ?? 'value';
  const st = node('st', 'event.start');
  const pr = node('pr', 'system.print');
  return asset(
    {
      main: graph(
        [st, nd, pr],
        [execEdge('x1', 'st', 'pr'), dataEdge('d1', 'p1', outPin, 'pr', 'value')],
      ),
    },
    { entry: 'main' },
  );
}

test('roundtrip ⑦：表达式映射表逐条锁定（全部内置纯节点）', async () => {
  const pureSpecs = builtinSpecs.filter((s) => s.pure === true);
  assert.ok(pureSpecs.length >= 38, `纯节点应不少于 38 个，实际 ${pureSpecs.length}`);
  for (const spec of pureSpecs) {
    const r = roundtripIR(pureNodeSample(spec.id));
    assert.equal(r.ok, true, `纯节点 ${spec.id} 往返失败：${r.diff ?? ''}\n${r.code ?? ''}`);
    noDiags(parseScriptToIR(r.code ?? '').diagnostics);
  }
});

test('roundtrip ⑦b：ui.get / ui.getValue 数据型节点 + var.get 共享别名', async () => {
  const a = asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('gv', 'ui.get', { pinDefaults: { name: 'list' } }),
          node('gvv', 'ui.getValue', { pinDefaults: { name: 'input' } }),
          node('g1', 'var.get', { params: { varName: 'count' } }),
          node('a1', 'math.add'),
          node('b1', 'math.mul'),
          node('pr1', 'system.print'),
          node('pr2', 'system.print'),
          node('pr3', 'system.print'),
        ],
        [
          execEdge('x1', 'st', 'pr1'),
          execEdge('x2', 'pr1', 'pr2'),
          execEdge('x3', 'pr2', 'pr3'),
          dataEdge('d1', 'gv', 'object', 'pr1', 'value'),
          dataEdge('d2', 'g1', 'value', 'a1', 'a'),
          dataEdge('d3', 'g1', 'value', 'b1', 'a'),
          dataEdge('d4', 'a1', 'value', 'pr2', 'value'),
          dataEdge('d5', 'b1', 'value', 'pr3', 'value'),
          dataEdge('d6', 'gvv', 'value', 'a1', 'b'),
        ],
      ),
    },
    { variables: [{ name: 'count', type: 'int', default: 0 }] },
  );
  const code = await assertRoundtrip(a);
  // ui.get 数据型节点走属性式；共享 var.get 别名一次性求值；ui.getValue 属性式读值
  assert.match(code, /print\(ui\.list\);/);
  assert.match(code, /const __bps_v\d+ = this\.count;/);
  assert.match(code, /__bps_v\d+ \+ ui\.input\.value/);
  assert.match(code, /__bps_v\d+ \* 0\)/);
});

/* ============================================================
 * ⑧ esbuild 转译（全样本）
 * ============================================================ */

test('esbuild：全部样本生成码可转译（experimentalDecorators）', async () => {
  for (const sample of [fullFeatureAsset, counterAsset, logPipelineAsset, stringChainAsset, branchLoopVarAsset, forEachBreakAsset]) {
    const code = codegenTS(sample);
    await assertTranspiles(code);
  }
});

/* ============================================================
 * ⑨ 诊断与抛错约定
 * ============================================================ */

test('解析诊断：语法错误给出行列（line/column）', () => {
  const code = [
    "// __bps-meta {\"entry\":\"main\"}",
    "class X {",
    "  @on('start')",
    "  onStart(): void {",
    "    this.count = ;",     // 语法错误
    "  }",
    "}",
  ].join('\n');
  const r = parseScriptToIR(code);
  const syntax = r.diagnostics.filter((d) => d.severity === 'error');
  assert.ok(syntax.length > 0, '应有语法错误诊断');
  assert.ok(syntax[0].line >= 5, `行列诊断应指向第 5 行附近，实际 ${syntax[0].line}:${syntax[0].column}`);
  assert.ok(syntax[0].column >= 1);
});

test('解析诊断：不可映射语句折叠为片段（源码零丢失）+ warning 行列', () => {
  const code = [
    "@tool('诊断样本')",
    'class X {',
    "  @on('start')",
    '  onStart(): void {',
    '    this.count = 1;',
    '    try {',
    '      this.count = 2;',
    '    } catch (e) {',
    '      print(e);',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const r = parseScriptToIR(code);
  const warns = r.diagnostics.filter((d) => d.severity === 'warning');
  assert.ok(warns.length >= 1, '应有折叠 warning');
  assert.equal(warns[0].line, 6, `行列应指向 try 语句（第 6 行），实际 ${warns[0].line}`);
  // 源码零丢失：折叠片段包含 try 原文
  const joined = r.asset.snippets.map((s) => s.code).join('\n');
  assert.match(joined, /try \{[\s\S]*catch \(e\)/);
  // 折叠片段作为节点留在链中（exec 骨架引脚）
  const mainGraph = r.asset.graphs['main'];
  assert.equal(mainGraph.nodes.filter((n) => n.type === 'script.snippet').length, 1);
  // 未折叠语句仍在（try 体内的 var.set 已随折叠片段保留；链上仅剩 count = 1）
  assert.equal(mainGraph.nodes.filter((n) => n.type === 'var.set').length, 1);
});

test('codegen：未知节点类型抛出带节点 id 的中文错误（不静默）', () => {
  const a = asset({
    main: graph(
      [node('st', 'event.start'), node('xx', 'plugin.ghostNode')],
      [execEdge('e1', 'st', 'xx')],
    ),
  });
  assert.throws(() => codegenTS(a), (err: unknown) => {
    const e = err as Error;
    return e instanceof Error && /plugin\.ghostNode/.test(e.message) && /xx/.test(e.message) && /中文|节点|无法/.test(e.message);
  });
});

test('解析：@on 双参形式（UI 内建事件）→ event.custom 绑定事件名（第二参）', () => {
  const code = [
    "@tool('双参')",
    'class X {',
    "  @on('btnFetch', 'pressed')",
    '  async fetch(): Promise<void> {',
    "    print('x');",
    '  }',
    '}',
  ].join('\n');
  const r = parseScriptToIR(code);
  noDiags(r.diagnostics);
  const mainGraph = r.asset.graphs['main'];
  const custom = mainGraph.nodes.find((n) => n.type === 'event.custom');
  assert.ok(custom, '应解析出 event.custom 节点');
  assert.equal((custom.params as Record<string, unknown>)['eventName'], 'pressed');
});

test('解析：孤儿片段（无节点引用）从 loose 标记恢复', async () => {
  // 手工构造：含孤儿片段的资产 → codegen 应把片段输出到 class 之外 → parse 恢复
  const withLoose = asset(
    { main: graph([node('st', 'event.start')], []) },
    {
      snippets: [
        {
          id: 'snipL',
          lang: 'ts',
          code: 'const orphan = 1;',
          pins: [{ id: 'v', dir: 'out', type: 'int' }],
        },
      ],
    },
  );
  const code = codegenTS(withLoose);
  assert.match(code, /__bps-loose-begin\(snipL\)/);
  const r = parseScriptToIR(code);
  const recovered = r.asset.snippets.find((s) => s.id === 'snipL');
  assert.ok(recovered, '孤儿片段应被恢复');
  assert.equal(recovered.code, 'const orphan = 1;');
  assert.deepEqual(recovered.pins, [{ id: 'v', dir: 'out', type: 'int' }]);
});
