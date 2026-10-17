/**
 * 数据列表虚拟滚动测试（node:test + happy-dom，T7.6）
 *
 * 覆盖（任务卡 DoD 3）：
 * 1. 10 万行首次渲染：DOM 行数 ≤ 可视区 + 2×缓冲（内存不炸）；body 总高占位 =
 *    槽位计划总高；虚拟类生效；
 * 2. 模拟滚动：按 scrollTop 求窗（与 computeVirtualWindow 纯函数断言一致性），
 *    滚动后首末行 dataset.ridx / 单元格内容正确；滚到底不越界、滚回顶部正常；
 * 3. 阈值边界：= LIST_VIRTUAL_THRESHOLD 保持经典全量路径（类 / 结构不变），
 *    阈值 +1 进入虚拟；
 * 4. 选中 / 合并展开在虚拟模式下的正确性（点击行上报选中语义、重渲染 / 滚回后
 *    --sel 保留；合并块整块占位 + ×N 徽标 + 点击展开出 merged 行）。
 *
 * 计时说明：断言只写 2s 级宽松拦截（防内存 / 量级炸裂），精确耗时经 console.log
 * 留痕——10 万行每次更新的主要成本在既有全量签名比对（JSON.stringify，任务卡裁定
 * 语义保留），虚拟化消除的是 10 万行 DOM 节点构建。阈值常量集中可调见
 * src/perf/thresholds.ts。
 *
 * 测试技巧：happy-dom 无布局（clientHeight 恒 0）——首渲染走 LIST_VIRTUAL_VIEWPORT_FALLBACK
 * 兜底窗，测试经 Object.defineProperty 固定 clientHeight 后派发 scroll 触发按真实
 * 可视高重算（与浏览器「挂载后首次滚动自校正」同一路径）。
 *
 * 运行：npx tsx --test src/runtime/render/virtual.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

/* ── happy-dom 环境注入（渲染器经全局 document 创建元素）──────── */
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;

import { renderUI, updateUI, type UIRenderHandle } from './render';
import { computeVirtualWindow } from './dataview';
import { defaultPropsFor, type ListColumn } from '../../ui-editor/schema';
import {
  LIST_ROW_HEIGHT,
  LIST_VIRTUAL_BUFFER,
  LIST_VIRTUAL_THRESHOLD,
} from '../../perf/thresholds';
import type { UIAsset, UINode } from '../../ir/types';

/* ── 构造辅助（与 render.test.ts 同构）──────────────────────── */

let seq = 0;

function makeNode(
  type: string,
  opt: {
    id?: string;
    name?: string;
    props?: Record<string, unknown>;
    children?: UINode[];
  } = {},
): UINode {
  const all = defaultPropsFor(type);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'name' || k === 'position' || k === 'size' || k === 'rotation') continue;
    props[k] = v;
  }
  Object.assign(props, opt.props ?? {});
  const pos = all.position as { x: number; y: number };
  const size = all.size as { w: number; h: number };
  return {
    id: opt.id ?? `n${++seq}`,
    name: opt.name ?? String(all.name ?? type),
    type,
    transform: {
      position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      size: { w: size?.w ?? 0, h: size?.h ?? 0 },
      rotation: 0,
    },
    theme: {},
    props,
    events: [],
    children: opt.children ?? [],
  };
}

function assetOf(root: UINode): UIAsset {
  return { version: 2, name: '测试资产', root };
}

/** 按 uid 取节点元素（断言存在） */
function byUid<T extends HTMLElement = HTMLElement>(h: UIRenderHandle, uid: string): T {
  const el = h.el.querySelector<HTMLElement>(`[data-uid="${uid}"]`);
  assert.ok(el, `未找到 data-uid="${uid}" 的元素`);
  return el as T;
}

/** 固定 list 元素可视高度（happy-dom 无布局，clientHeight 恒 0——实例属性覆写） */
function fixViewport(el: HTMLElement, height: number): void {
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}

/** 生成 rows：level 轮转 + msg = `行 i`（虚拟窗口内容断言依据） */
function genRows(count: number): Array<{ level: string; msg: string }> {
  const rows: Array<{ level: string; msg: string }> = [];
  for (let i = 0; i < count; i++) {
    rows.push({ level: i % 3 === 0 ? 'INFO' : i % 3 === 1 ? 'WARN' : 'ERROR', msg: `行 ${i}` });
  }
  return rows;
}

/** 渲染一个行数可控的 list 节点（默认列：level + msg；items 可传数组=运行态形态） */
function renderBigList(
  id: string,
  rowCount: number,
  columns: ListColumn[] = [
    { field: 'level', title: '级别', width: 60 },
    { field: 'msg', title: '内容' },
  ],
  items?: unknown,
): { h: UIRenderHandle; list: HTMLElement; asset: UIAsset; renderMs: number } {
  const list = makeNode('list', {
    id,
    name: 'bigList',
    props: { columns, items: items ?? JSON.stringify(genRows(rowCount)) },
  });
  const asset = assetOf(makeNode('vbox', { id: 'root', children: [list] }));
  const t0 = performance.now();
  const h = renderUI(asset, { mode: 'runtime' });
  const renderMs = performance.now() - t0; // 含全量签名比对 + 首屏虚拟窗口构建
  const listEl = byUid(h, id);
  return { h, list: listEl, asset, renderMs };
}

/** 当前 DOM 行的 ridx 序列 */
function ridxList(list: HTMLElement): number[] {
  return Array.from(list.querySelectorAll<HTMLElement>('.bps-lrow')).map(
    (r) => Number(r.dataset.ridx),
  );
}

/** 滚动到指定位置（置 scrollTop + 派发 scroll 事件——委托监听路径） */
function scrollTo(list: HTMLElement, top: number): void {
  list.scrollTop = top;
  list.dispatchEvent(new win.Event('scroll') as unknown as Event);
}

/** DOM 行数上限（可视 10 行 + 双侧缓冲 + 少量余量） */
const WINDOW_BOUND = Math.ceil(240 / LIST_ROW_HEIGHT) + 2 * LIST_VIRTUAL_BUFFER + 2;

/* ============================================================
 * 1. 10 万行首次渲染：只建可视窗口 + 总高占位
 * ============================================================ */

test('list 虚拟化：10 万行首次渲染 DOM 行数 ≤ 可视区+缓冲，总高占位正确', () => {
  const ROWS = 100000;
  const items = genRows(ROWS); // 运行态数组（listSetItems 写回形态）
  const { h, list, asset, renderMs } = renderBigList('big', ROWS, undefined, items);

  const t0 = performance.now();
  updateUI(h, asset); // 签名未变 → 全量签名比对后零重建（含 10 万行 JSON.stringify）
  const updateMs = performance.now() - t0;

  const body = list.querySelector<HTMLElement>('.bps-lbody')!;
  const domRows = list.querySelectorAll('.bps-lrow').length;
  console.log(
    `[T7.6] 10 万行 list：首屏 DOM 行数=${domRows}（兜底窗），首次渲染=${renderMs.toFixed(1)}ms，` +
      `body 高=${body.style.height}，签名比对 no-op 更新=${updateMs.toFixed(1)}ms`,
  );

  // 虚拟类生效；行数受窗口约束（10 万行绝不全量建 DOM）
  assert.ok(body.classList.contains('bps-lbody--virtual'), '超过阈值应进入虚拟模式');
  assert.ok(domRows > 0, '兜底窗（clientHeight=0）也应有内容');
  assert.ok(domRows <= WINDOW_BOUND + 4, `首渲染 DOM 行数 ${domRows} 超出窗口约束`);

  // 总高占位 = 行数 × 行高（纯行计划，无分组合并）
  assert.equal(body.style.height, `${ROWS * LIST_ROW_HEIGHT}px`);

  // 兜底窗内容：scrollTop=0 → 首行 ridx 0，末行 ≤ 视底 + 下缓冲（内容与 ridx 对应）
  const rids = list.querySelectorAll<HTMLElement>('.bps-lrow');
  assert.equal(rids[0].dataset.ridx, '0');
  assert.ok(rids[0].textContent?.includes('行 0'));
  const lastRidx = Number(rids[rids.length - 1].dataset.ridx);
  assert.ok(lastRidx > 0 && lastRidx <= 34, `兜底窗末行 ridx=${lastRidx} 应在首屏+缓冲内`);
  assert.ok(rids[rids.length - 1].textContent?.includes(`行 ${lastRidx}`));

  // 签名比对 no-op 更新（10 万行全量 stringify 仍在，T7.6 语义保留）宽松拦截
  assert.ok(updateMs < 2000, `重复 patch 耗时异常：${updateMs.toFixed(1)}ms`);

  // 挂载后按真实可视高（240）自校正：首屏窗口 = 10 行可视 + 20 下缓冲
  fixViewport(list, 240);
  scrollTo(list, 0);
  const calibrated = ridxList(list);
  assert.equal(calibrated.length, Math.ceil(240 / LIST_ROW_HEIGHT) + LIST_VIRTUAL_BUFFER);
  assert.equal(calibrated[0], 0);

  h.destroy();
});

/* ============================================================
 * 2. 模拟滚动：窗口更新正确（首末行内容对 / 滚到底不越界 / 纯函数一致性）
 * ============================================================ */

test('list 虚拟化：模拟滚动后行窗口更新正确（首末行内容对）', () => {
  const ROWS = 100000;
  const { h, list } = renderBigList('big', ROWS);
  fixViewport(list, 240);
  const bufferPx = LIST_VIRTUAL_BUFFER * LIST_ROW_HEIGHT; // 480
  const body = list.querySelector<HTMLElement>('.bps-lbody')!;

  // 滚到中段：scrollTop 500000（首滚含真实可视高自校正；计时另计后续滚动帧成本）
  scrollTo(list, 500000);
  const tScroll = performance.now();
  scrollTo(list, 501000); // 计时样本：+1000px 滚动 → 窗口重建
  const scrollMs = performance.now() - tScroll;
  scrollTo(list, 500000); // 回到断言基准位（内容断言全部按 500000 推导）
  console.log(`[T7.6] 10 万行 list：单次滚动窗口重建=${scrollMs.toFixed(2)}ms`);
  const ridx = ridxList(list);
  const expectedStart = Math.ceil((500000 - bufferPx) / LIST_ROW_HEIGHT) - 1; // 20813
  const expectedEnd = Math.floor((500000 + 240 + bufferPx) / LIST_ROW_HEIGHT); // 20863
  assert.equal(ridx[0], expectedStart, `滚动后首行 ridx 应为 ${expectedStart}`);
  assert.equal(ridx[ridx.length - 1], expectedEnd, `滚动后末行 ridx 应为 ${expectedEnd}`);
  assert.ok(ridx.length <= WINDOW_BOUND, `窗口行数 ${ridx.length} 超出约束`);
  // 行内容与 ridx 对应（level 列 + `行 i`）
  const rows = list.querySelectorAll<HTMLElement>('.bps-lrow');
  assert.ok(rows[0].textContent?.includes(`行 ${expectedStart}`));
  assert.ok(rows[rows.length - 1].textContent?.includes(`行 ${expectedEnd}`));
  // 窗口外内容不得残留（首屏的行 0 已被重建掉）
  assert.ok(!ridx.includes(0), '滚动后旧窗口行应被移除');
  // body 总高占位不变（滚动不改变数据）
  assert.equal(body.style.height, `${ROWS * LIST_ROW_HEIGHT}px`);

  // 滚到底：末行 = 最后一行数据，不越界
  scrollTo(list, ROWS * LIST_ROW_HEIGHT - 240);
  const tail = ridxList(list);
  assert.equal(tail[tail.length - 1], ROWS - 1);
  const tailRows = list.querySelectorAll<HTMLElement>('.bps-lrow');
  assert.ok(tailRows[tailRows.length - 1].textContent?.includes(`行 ${ROWS - 1}`));

  // 滚回顶部：窗口回到首屏（双向滚动）
  scrollTo(list, 0);
  assert.equal(ridxList(list)[0], 0);

  // 纯函数一致性：computeVirtualWindow 与 DOM 呈现一致（同 scrollTop / 可视高 / 缓冲）
  const slotsSim = Array.from({ length: ROWS }, (_, i) => ({
    top: i * LIST_ROW_HEIGHT,
    height: LIST_ROW_HEIGHT,
  }));
  const win = computeVirtualWindow(slotsSim, 500000, 240, bufferPx);
  assert.equal(win.start, expectedStart);
  assert.equal(win.end, expectedEnd + 1);

  h.destroy();
});

/* ============================================================
 * 3. 阈值边界：= 阈值经典路径 / 阈值+1 进入虚拟
 * ============================================================ */

test('list 虚拟化：阈值边界（= LIST_VIRTUAL_THRESHOLD 经典全量，+1 行切换虚拟）', () => {
  // 恰为阈值：经典路径（无虚拟类、全量行 DOM、不写占位高）
  const at = renderBigList('at', LIST_VIRTUAL_THRESHOLD);
  const atBody = at.list.querySelector<HTMLElement>('.bps-lbody')!;
  assert.ok(!atBody.classList.contains('bps-lbody--virtual'), '行数 = 阈值应保持经典路径');
  assert.equal(at.list.querySelectorAll('.bps-lrow').length, LIST_VIRTUAL_THRESHOLD);
  assert.equal(atBody.style.height, '', '经典路径不写占位高');
  at.h.destroy();

  // 阈值 + 1：进入虚拟
  const over = renderBigList('over', LIST_VIRTUAL_THRESHOLD + 1);
  const overBody = over.list.querySelector<HTMLElement>('.bps-lbody')!;
  assert.ok(overBody.classList.contains('bps-lbody--virtual'), '行数 > 阈值应进入虚拟模式');
  assert.ok(over.list.querySelectorAll('.bps-lrow').length < LIST_VIRTUAL_THRESHOLD + 1);
  assert.equal(overBody.style.height, `${(LIST_VIRTUAL_THRESHOLD + 1) * LIST_ROW_HEIGHT}px`);
  over.h.destroy();
});

/* ============================================================
 * 4. 选中 / 合并展开在虚拟模式下正确
 * ============================================================ */

test('list 虚拟化：选中与合并展开正确（>200 行 + groupBy + mergeDuplicates）', () => {
  // 260 行：session A（前 130 行 msg 相邻重复 → 合并成 1 块）+ session B（后 130 行各一条）
  const rows = genRows(260).map((r, i) => ({
    level: r.level,
    msg: i < 130 ? '握手' : r.msg,
    session: i < 130 ? 'A' : 'B',
  }));
  const columns: ListColumn[] = [
    { field: 'level', title: '级别', width: 60 },
    { field: 'msg', title: '内容', mergeDuplicates: true },
    { field: 'session', title: '会话', groupBy: true },
  ];
  const { h, list } = renderBigList('grp', rows.length, columns, rows);
  fixViewport(list, 240);
  const body = list.querySelector<HTMLElement>('.bps-lbody')!;

  // 虚拟模式总高占位：组头×2 + 合并块(130 行) + B 组 130 行
  const expectHeight = 2 * LIST_ROW_HEIGHT + 130 * LIST_ROW_HEIGHT + 130 * LIST_ROW_HEIGHT;
  assert.ok(body.classList.contains('bps-lbody--virtual'));
  assert.equal(body.style.height, `${expectHeight}px`);

  // 选中：滚到 B 组头部（A 组块之后），点击 B 组第一行（ridx 130）
  const bTop = 2 * LIST_ROW_HEIGHT + 130 * LIST_ROW_HEIGHT; // B 组首行 top = 3144
  scrollTo(list, bTop - 96);
  const bRow = list.querySelector<HTMLElement>('.bps-lrow[data-ridx="130"]');
  assert.ok(bRow, '滚动后 B 组首行应进入窗口');
  bRow!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  // 点击经 onListClick → 重渲染（虚拟窗口重建），选中类保留
  const selRow = list.querySelector<HTMLElement>('.bps-lrow[data-ridx="130"]');
  assert.ok(selRow?.classList.contains('bps-lrow--sel'), '选中行应有 --sel 类');

  // 滚走再滚回：选中语义保持（重渲染按 selected 索引重新标记）
  scrollTo(list, 0);
  scrollTo(list, bTop - 96);
  const selAgain = list.querySelector<HTMLElement>('.bps-lrow[data-ridx="130"]');
  assert.ok(selAgain?.classList.contains('bps-lrow--sel'), '滚回后选中标记应保留');

  // 合并块：滚回 A 组，应见 ×130 徽标的整块占位行（高 = 130×行高）
  scrollTo(list, LIST_ROW_HEIGHT);
  const mergedRow = list.querySelector<HTMLElement>('.bps-lrow[data-merge-key]');
  assert.ok(mergedRow, 'A 组合并块应渲染为整块占位行');
  assert.equal(mergedRow!.dataset.mergeKey, 'A::握手');
  assert.equal(mergedRow!.style.height, `${130 * LIST_ROW_HEIGHT}px`);
  const badge = mergedRow!.querySelector<HTMLElement>('.bps-lcount');
  assert.equal(badge?.textContent, '×130');

  // 点击徽标展开：窗口内出现 merged 虚线行（内容为被合并行）
  badge!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  const mergedExpanded = Array.from(list.querySelectorAll('.bps-lmerged')) as HTMLElement[];
  assert.ok(mergedExpanded.length > 0, '展开后应出现 merged 行');
  assert.ok(mergedExpanded.length <= 129, 'merged 行只建窗口内可见部分');
  assert.ok(
    mergedExpanded[0].textContent?.includes('握手'),
    'merged 行内容为被合并的行数据',
  );
  // 展开不改变总高（合并块高 = 行数×行高 = 展开后首行+其余行高之和，语义无缝）
  assert.equal(body.style.height, `${expectHeight}px`);

  h.destroy();
});
