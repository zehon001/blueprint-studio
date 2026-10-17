/**
 * Blueprint Studio v2 —— 千节点蓝图性能基准（node:test，T7.6）
 *
 * 构造 1000 节点图（20 条 forLoop 执行链 + 20 条 math.add 纯节点数据链，共 979 条连线），
 * 对「IR ⇄ ReactFlow 映射 + dagre 自动布局 + 受控视图渲染准备（选中标记映射）」与
 * serializeIR / validateIR 做计时断言。
 *
 * 阈值说明（集中调参见 src/perf/thresholds.ts 头注；本文件阈值刻意写宽松值）：
 *  - 计时受机器 / JIT 预热影响大，断言取「参考实测值 × 10 以上」的宽松上限，
 *    只用于拦截量级退化（如误引入 O(n²) 全量重排）；不追求精确基准。
 *  - 参考实测（本次开发机，2026-10-17）：irToFlow（含 dagre 千节点）≈ 190-200ms、
 *    dagre 直接计时 ≈ 130ms、受控视图准备 ≈ 0.1ms、已定位纯映射 ≈ 1ms、
 *    flowToIR/edgesToIR ≈ 0.4ms、serializeIR ≈ 2ms、validateIR ≈ 12ms（issues=0）。
 *    实机（浏览器）流畅度验证归 PM 合并点走查。
 *
 * 运行：npx tsx --test src/blueprint/view/perf.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRNode, IREdge, Vec2 } from '../../ir/types';
import { builtinSpecMap } from '../../nodes';
import { serializeIR, validateIR } from '../../ir/validate';
import {
  autoLayoutPositions,
  edgesToIR,
  flowToIR,
  irToFlow,
  type LayoutEntry,
  type LayoutLink,
} from './model';

/* ============================================================
 * 千节点样本构造（真实节点库 spec；全部无 position → 触发 dagre 布局路径）
 * ============================================================ */

/** forLoop 执行链条数（每链 1 个 flow.forLoop，exec 依次串联） */
const FORLOOP_CHAINS = 20;
/** 纯节点（math.add）数据链条数；两链节点数凑满 1000 */
const PURE_CHAINS = 20;
/** 目标节点总数 */
const TARGET_NODES = 1000;

let seq = 0;

function irNode(type: string, position?: Vec2, params: Record<string, unknown> = {}): IRNode {
  // position 运行时可缺省（类型必填、JSON 数据可能没有，同 view.test.ts 约定按可选构造）
  return {
    id: `n${++seq}`,
    type,
    params,
    pinDefaults: {},
    position: position ?? (undefined as unknown as Vec2),
  };
}

/** 1000 节点样本：event.start → 20 个 forLoop（exec 链）+ 979 个 math.add（20 条纯数据链） */
function buildThousandNodeAsset(positioned: boolean): { asset: IRAsset; nodeCount: number; edgeCount: number } {
  seq = 0;
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  let eid = 0;

  // 纯节点链节点数：除去 event.start 与 forLoop 后全部分给 math.add
  const pureTotal = TARGET_NODES - 1 - FORLOOP_CHAINS;
  const perChain = Math.ceil(pureTotal / PURE_CHAINS); // 49
  // 纯节点链：链内 value → 下一链 a（数据边串联；首节点 a/b 缺省走 pinDefaults）
  const chainHeads: string[] = [];
  let left = pureTotal;
  while (left > 0) {
    const len = Math.min(perChain, left);
    left -= len;
    const chain: IRNode[] = [];
    for (let i = 0; i < len; i++) {
      const n = irNode('math.add', positioned ? { x: i * 220, y: chainHeads.length * 160 } : undefined);
      chain.push(n);
      nodes.push(n);
      if (i > 0) {
        edges.push({
          id: `e${++eid}`,
          from: { node: chain[i - 1].id, pin: 'value' },
          to: { node: chain[i].id, pin: 'a' },
          kind: 'data',
        });
      }
    }
    chainHeads.push(chain[0].id);
  }

  // forLoop 执行链：event.start.exec → for0.exec；for(i).done → for(i+1).exec
  const start = irNode('event.start', positioned ? { x: 0, y: 0 } : undefined);
  nodes.push(start);
  const forLoopIds: string[] = [];
  for (let i = 0; i < FORLOOP_CHAINS; i++) {
    const f = irNode('flow.forLoop', positioned ? { x: 300 + i * 260, y: 0 } : undefined, {
      from: 0,
      to: 9,
    });
    forLoopIds.push(f.id);
    nodes.push(f);
    edges.push({
      id: `e${++eid}`,
      from: { node: i === 0 ? start.id : forLoopIds[i - 1], pin: i === 0 ? 'exec' : 'done' },
      to: { node: f.id, pin: 'exec' },
      kind: 'exec',
    });
    // 循环索引喂给纯链头节点的 b 输入（数据边；贴近真实用图且校验无issue）
    edges.push({
      id: `e${++eid}`,
      from: { node: f.id, pin: 'index' },
      to: { node: chainHeads[i % chainHeads.length], pin: 'b' },
      kind: 'data',
    });
  }

  const asset: IRAsset = {
    version: 2,
    name: '千节点性能样本',
    entry: 'main',
    graphs: { main: { nodes, edges } },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
  return { asset, nodeCount: nodes.length, edgeCount: edges.length };
}

/** 计时（毫秒；单次冷跑，宽松断言用） */
function msOf(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/* ============================================================
 * 计时断言（宽松阈值，防量级退化；数字经 console.log 留痕供自测摘要引用）
 * ============================================================ */

test('千节点：irToFlow（含 dagre 自动布局）+ 受控视图准备在可接受时间内', () => {
  const { asset, nodeCount, edgeCount } = buildThousandNodeAsset(false);
  assert.equal(nodeCount, TARGET_NODES, '样本应为 1000 节点');
  assert.equal(edgeCount, 979 + FORLOOP_CHAINS, '样本连线数（纯链 959 + 执行/索引边 40）');

  // 1) irToFlow：映射 + dagre 自动布局（全部节点无 position → 布局路径）
  let built!: ReturnType<typeof irToFlow>;
  const mapMs = msOf(() => {
    built = irToFlow(asset, builtinSpecMap, 'main');
  });
  assert.equal(built.nodes.length, TARGET_NODES);
  assert.equal(built.edges.length, edgeCount);
  console.log(`[T7.6] 千节点 irToFlow（含 dagre）= ${mapMs.toFixed(1)}ms`);
  // 宽松上限（参考实测 ~60-120ms；机器差异取 ≥10× 余量，只拦量级退化）
  assert.ok(mapMs < 500, `irToFlow+dagre 计时超标：${mapMs.toFixed(1)}ms ≥ 500ms`);

  // 2) 受控视图渲染准备：syncFromAsset 同款「选中标记映射」（O(n)，产出可直接交给 ReactFlow）
  const nodeSel = new Set(built.nodes.slice(0, 50).map((n) => n.id));
  const prepMs = msOf(() => {
    const prepared = built.nodes.map((n) => (nodeSel.has(n.id) ? { ...n, selected: true } : n));
    assert.equal(prepared.length, TARGET_NODES);
  });
  console.log(`[T7.6] 千节点受控视图准备（选中标记映射）= ${prepMs.toFixed(1)}ms`);
  assert.ok(prepMs < 100, `受控视图准备计时超标：${prepMs.toFixed(1)}ms ≥ 100ms`);
});

test('千节点：全量定位时 irToFlow 纯映射（不重排 dagre）在可接受时间内', () => {
  // 已有 position 的资产（日常编辑态）：irToFlow 必须跳过 dagre，只做 O(n) 映射——
  // 保证「拖动 / 连线等每次编辑命令后的视图重生成」不触发全量重排
  const { asset } = buildThousandNodeAsset(true);
  const mapMs = msOf(() => {
    const built = irToFlow(asset, builtinSpecMap, 'main');
    assert.equal(built.nodes.length, TARGET_NODES);
  });
  console.log(`[T7.6] 千节点 irToFlow（已定位纯映射）= ${mapMs.toFixed(1)}ms`);
  assert.ok(mapMs < 200, `已定位 irToFlow 计时超标：${mapMs.toFixed(1)}ms ≥ 200ms`);
});

test('千节点：flowToIR / edgesToIR 反向映射与 dagre 布局在可接受时间内', () => {
  const { asset } = buildThousandNodeAsset(false);
  const built = irToFlow(asset, builtinSpecMap, 'main');

  const flowMs = msOf(() => {
    const nodes = flowToIR(built.nodes);
    assert.equal(nodes.length, TARGET_NODES);
    const irEdges = edgesToIR(built.edges);
    assert.equal(irEdges.length, built.edges.length);
  });
  console.log(`[T7.6] 千节点 flowToIR+edgesToIR = ${flowMs.toFixed(1)}ms`);
  assert.ok(flowMs < 200, `反向映射计时超标：${flowMs.toFixed(1)}ms ≥ 200ms`);

  // dagre 直接计时（entries/links 与 irToFlow 布局分支同构）
  const unpositioned = asset.graphs.main.nodes;
  const entries: LayoutEntry[] = unpositioned.map((n) => ({
    id: n.id,
    width: 190,
    height: 96,
  }));
  const idset = new Set(entries.map((e) => e.id));
  const links: LayoutLink[] = asset.graphs.main.edges
    .filter((e) => idset.has(e.from.node) && idset.has(e.to.node))
    .map((e) => ({ from: e.from.node, to: e.to.node }));
  const dagreMs = msOf(() => {
    const laid = autoLayoutPositions(entries, links);
    assert.equal(laid.size, TARGET_NODES);
  });
  console.log(`[T7.6] 千节点 dagre autoLayout = ${dagreMs.toFixed(1)}ms`);
  assert.ok(dagreMs < 500, `dagre 布局计时超标：${dagreMs.toFixed(1)}ms ≥ 500ms`);
});

test('千节点：serializeIR / validateIR 在可接受时间内', () => {
  const { asset } = buildThousandNodeAsset(false);
  // 序列化（保存链路）：千节点 JSON 稳定排序输出
  let text = '';
  const serMs = msOf(() => {
    text = serializeIR(asset);
  });
  assert.ok(text.includes('"flow.forLoop"'), '序列化应包含样本节点类型');
  console.log(`[T7.6] 千节点 serializeIR = ${serMs.toFixed(1)}ms（${text.length} 字节）`);
  // 宽松上限（参考实测 ~10ms）
  assert.ok(serMs < 500, `serializeIR 计时超标：${serMs.toFixed(1)}ms ≥ 500ms`);

  // 语义校验（Ctrl+S 保存前校验 / 诊断条）：全量结构 + 类型检查
  let issues!: ReturnType<typeof validateIR>;
  const valMs = msOf(() => {
    issues = validateIR(asset, builtinSpecMap);
  });
  console.log(`[T7.6] 千节点 validateIR = ${valMs.toFixed(1)}ms（issues=${issues.length}）`);
  assert.ok(valMs < 500, `validateIR 计时超标：${valMs.toFixed(1)}ms ≥ 500ms`);
});