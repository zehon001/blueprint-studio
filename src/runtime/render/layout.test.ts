/**
 * 渲染器布局单测（T1.7 · Transform 与容器布局）
 *
 * 覆盖（任务卡单测清单 1–6；第 7 条回归 = render.test.ts 的 13 测试另行运行）：
 * 1. 旋转：free/flow/split 语境 transform 均为单属性标准串（rotate(deg)），基点 center；
 * 2. 尺寸：free 缺省（0 / 单轴缺省）按 schema commonProps defaultSize 补默认（未知类型回落
 *    120×32）；flow 0 = 自适应；expand → flex-grow:1；
 * 3. 容器布局：vbox/hbox 的 spacing/align/padding；grid 列数与单元格对齐；三层嵌套
 *    min-width/min-height:0 链（flex 溢出经典问题）；
 * 4. tabContainer 页名 / activeIndex（含越界钳制）；splitContainer splitPosition / 分隔条类 /
 *    多余窗格隐藏；
 * 5. anchors 简化版：left/top 比例定位、right/bottom 边距、同轴互斥优先 left/top、[0,1] 钳制、
 *    仅 free 语境生效、无 anchors 回归（行为与 T1.2 一致）、anchors 移除后无样式残留；
 * 6. mergeDuplicates 真视觉合并（rowspan）：行体网格化 + 合并单元格 grid-row:span N +
 *    计数徽标与点击展开保留；无合并列不进入合并模式。
 *
 * 运行：npx tsx --test src/runtime/render/layout.test.ts
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
import { defaultPropsFor, type ListColumn } from '../../ui-editor/schema';
import type { UIAsset, UINode } from '../../ir/types';

/* ── 构造辅助（与 render.test.ts 同构；追加 anchors）────────── */

let seq = 0;

/** 按 schema 默认值构造 UINode（公共 name/position/size/rotation 拆入 transform） */
function makeNode(
  type: string,
  opt: {
    id?: string;
    name?: string;
    props?: Record<string, unknown>;
    children?: UINode[];
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    rotation?: number;
    /** T1.7 简化版锚点（写入 transform.anchors；仅 free 语境生效） */
    anchors?: Record<string, number>;
  } = {},
): UINode {
  const all = defaultPropsFor(type);
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === 'name' || k === 'position' || k === 'size' || k === 'rotation') continue;
    props[k] = v;
  }
  Object.assign(props, opt.props ?? {});
  const pos = all.position as { x: number; y: number } | undefined;
  const size = all.size as { w: number; h: number } | undefined;
  return {
    id: opt.id ?? `n${++seq}`,
    name: opt.name ?? String(all.name ?? type),
    type,
    transform: {
      position: { x: opt.x ?? pos?.x ?? 0, y: opt.y ?? pos?.y ?? 0 },
      size: { w: opt.w ?? size?.w ?? 0, h: opt.h ?? size?.h ?? 0 },
      rotation: opt.rotation ?? (all.rotation as number) ?? 0,
      ...(opt.anchors ? { anchors: opt.anchors } : {}),
    },
    theme: {}, // ADR-005：theme 暂不使用
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

/** 内联 style 属性原文（grid/gap 等属性经属性串断言，不依赖 happy-dom 的 CSS 属性映射） */
function styleText(el: HTMLElement): string {
  return el.getAttribute('style') ?? '';
}

/** 注入的渲染器样式表内容（结构样式断言用） */
function renderCss(): string {
  return doc.getElementById('bps-ui-render-style')?.textContent ?? '';
}

/* ── 1. 旋转 ──────────────────────────────────────────────── */

test('旋转：free/flow/split 语境均为单值 transform 串含 rotate，基点 center', () => {
  // free（panel 内）：rotate 单属性串
  const free = makeNode('label', { id: 'r1', x: 10, y: 20, rotation: 30 });
  const h = renderUI(assetOf(makeNode('panel', { id: 'p1', children: [free] })), { mode: 'edit' });
  assert.equal(byUid(h, 'r1').style.transform, 'rotate(30deg)');
  h.destroy();

  // flow（hbox 内）：流式子项 rotation 同样生效
  const flow = makeNode('button', { id: 'r2', rotation: -45 });
  const h2 = renderUI(
    assetOf(makeNode('hbox', { id: 'h1', children: [flow] })),
    { mode: 'runtime' },
  );
  assert.equal(byUid(h2, 'r2').style.transform, 'rotate(-45deg)');
  h2.destroy();

  // split（窗格）：T1.7 起不再置空，与其它语境一致；无旋转时为空串
  const h3 = renderUI(
    assetOf(
      makeNode('splitContainer', {
        id: 'sp',
        children: [
          makeNode('label', { id: 'r3', rotation: 10 }),
          makeNode('label', { id: 'r4' }),
        ],
      }),
    ),
    { mode: 'runtime' },
  );
  assert.equal(byUid(h3, 'r3').style.transform, 'rotate(10deg)');
  assert.equal(byUid(h3, 'r4').style.transform, '');
  h3.destroy();

  // 旋转基点 center：.bps-node 统一 transform-origin:50% 50%（结构样式表，两态共用）
  assert.match(renderCss(), /\.bps-node\{[^}]*transform-origin:50% 50%/);
});

/* ── 2. 尺寸 ──────────────────────────────────────────────── */

test('尺寸：free 缺省按 schema defaultSize 补默认；flow 0=自适应；expand 拉伸', () => {
  // free：w/h 全缺省 → schema label 默认尺寸 160×32
  const h = renderUI(
    assetOf(
      makeNode('panel', {
        id: 'p1',
        children: [
          makeNode('label', { id: 'd1', w: 0, h: 0 }),
          makeNode('label', { id: 'd2', w: 200, h: 0 }), // 单轴缺省：h 补默认
          makeNode('mysteryType', { id: 'd3', w: 0, h: 0 }), // 未知类型回落 120×32
          makeNode('label', { id: 'd4', w: 88, h: 44 }), // 显式尺寸不覆盖
        ],
      }),
    ),
    { mode: 'edit' },
  );
  const d1 = byUid(h, 'd1');
  assert.equal(d1.style.width, '160px', 'label schema 默认宽 160');
  assert.equal(d1.style.height, '32px', 'label schema 默认高 32');
  assert.equal(byUid(h, 'd2').style.width, '200px');
  assert.equal(byUid(h, 'd2').style.height, '32px', '单轴缺省只补该轴');
  assert.equal(byUid(h, 'd3').style.width, '120px', '未知类型回落 120（与 commonProps 兜底一致）');
  assert.equal(byUid(h, 'd3').style.height, '32px');
  assert.equal(byUid(h, 'd4').style.width, '88px');
  assert.equal(byUid(h, 'd4').style.height, '44px');
  h.destroy();

  // flow：0 = 自适应（不写宽高，由 flex/grid 基础决定）
  const h2 = renderUI(
    assetOf(
      makeNode('vbox', {
        id: 'v1',
        children: [
          makeNode('label', { id: 'f1', w: 0, h: 0 }),
          makeNode('label', { id: 'f2', w: 0, h: 0, props: { expand: true } }),
        ],
      }),
    ),
    { mode: 'runtime' },
  );
  const f1 = byUid(h2, 'f1');
  assert.equal(f1.style.width, '', 'flow 子项 size 0 = 自适应');
  assert.equal(f1.style.height, '');
  assert.equal(byUid(h2, 'f2').style.flexGrow, '1', 'expand → flex-grow:1');
  h2.destroy();
});

/* ── 3. 容器布局 ──────────────────────────────────────────── */

test('容器布局：vbox/hbox 间距对齐内边距、grid 列数与单元格对齐、三层嵌套 min 链', () => {
  const grid = makeNode('grid', { id: 'g1', props: { columns: 3, spacing: 4, padding: 2 } });
  const hbox = makeNode('hbox', {
    id: 'h1',
    props: { spacing: 12, padding: 6, align: 'center' },
    children: [grid],
  });
  const vbox = makeNode('vbox', {
    id: 'v1',
    props: { spacing: 10, padding: 4, align: 'start' },
    children: [hbox],
  });
  const h = renderUI(assetOf(vbox), { mode: 'runtime' });

  const v = byUid(h, 'v1');
  assert.match(styleText(v), /gap:\s*10px/, 'vbox spacing → gap');
  assert.match(styleText(v), /padding:\s*4px/, 'vbox padding');
  assert.match(styleText(v), /align-items:\s*flex-start/, 'align:start → flex-start');
  const hb = byUid(h, 'h1');
  assert.match(styleText(hb), /gap:\s*12px/);
  assert.match(styleText(hb), /align-items:\s*center/, 'hbox align:center');
  const g = byUid(h, 'g1');
  assert.match(
    styleText(g),
    /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    'grid columns → N 列自动换行',
  );
  assert.match(styleText(g), /gap:\s*4px/, 'grid 行列间距');
  assert.match(styleText(g), /justify-items:\s*stretch/, 'grid 单元格对齐（主轴拉伸）');
  assert.match(styleText(g), /align-items:\s*stretch/, 'grid 单元格对齐（交叉轴拉伸）');

  // 三层嵌套 min-width/min-height:0 链：flex/grid 子项可收缩，尺寸传递不断链
  assert.equal(hb.style.minHeight, '0', 'vbox 内 hbox min-height:0');
  assert.equal(hb.style.minWidth, '0');
  assert.equal(g.style.minHeight, '0', 'hbox 内 grid min-height:0');
  assert.equal(g.style.minWidth, '0');
  h.destroy();
});

test('scrollBox 方向化 overflow 与 panel 裁剪区分；scrollBox 子节点 free 定位', () => {
  const lbl = makeNode('label', { id: 'x1', x: 10, y: 20 });
  const h = renderUI(
    assetOf(
      makeNode('scrollBox', {
        id: 'sb',
        props: { direction: 'vertical' },
        children: [lbl],
      }),
    ),
    { mode: 'edit' },
  );
  assert.equal(byUid(h, 'x1').style.position, 'absolute', 'scrollBox 内子节点 = free 定位');
  const sb = byUid(h, 'sb');
  assert.match(styleText(sb), /overflow-x:\s*hidden/, '纵向滚动：横向裁剪');
  assert.match(styleText(sb), /overflow-y:\s*auto/, '纵向滚动：纵向溢出滚动');
  // panel 溢出裁剪（overflow:hidden）与 scrollBox 方向化 overflow 区分（结构样式表）
  assert.match(renderCss(), /\.bps-panel\{[^}]*overflow:hidden/);
  h.destroy();
});

/* ── 4. tabContainer / splitContainer ─────────────────────── */

test('tabContainer：页名取子节点 name，activeIndex 指定当前页并钳制越界', () => {
  const pages = [
    makeNode('vbox', { id: 't0', name: '甲页' }),
    makeNode('vbox', { id: 't1', name: '乙页' }),
    makeNode('vbox', { id: 't2', name: '丙页' }),
  ];
  const h = renderUI(
    assetOf(
      makeNode('tabContainer', {
        id: 'tc',
        props: { activeIndex: 1 },
        children: [...pages],
      }),
    ),
    { mode: 'runtime' },
  );
  const tabs = Array.from(h.el.querySelectorAll<HTMLElement>('.bps-tab'));
  assert.deepEqual(
    tabs.map((b) => b.textContent),
    ['甲页', '乙页', '丙页'],
    '页签条页名 = 子节点 name',
  );
  assert.ok(tabs[1]!.classList.contains('bps-tab--active'), 'activeIndex=1 → 第二页签激活');
  assert.equal(byUid(h, 't0').style.display, 'none', '非当前页隐藏');
  assert.notEqual(byUid(h, 't1').style.display, 'none', '当前页显示');
  assert.equal(byUid(h, 't2').style.display, 'none');
  h.destroy();

  // activeIndex 越界 → 钳制到最后一页
  const h2 = renderUI(
    assetOf(
      makeNode('tabContainer', {
        id: 'tc2',
        props: { activeIndex: 99 },
        children: [makeNode('vbox', { id: 'u0' }), makeNode('vbox', { id: 'u1' })],
      }),
    ),
    { mode: 'runtime' },
  );
  const tabs2 = Array.from(h2.el.querySelectorAll<HTMLElement>('.bps-tab'));
  assert.ok(
    tabs2[tabs2.length - 1]!.classList.contains('bps-tab--active'),
    'activeIndex 越界钳制到最后一页',
  );
  h2.destroy();
});

test('splitContainer：splitPosition 比例、第二窗格分隔条类、多余窗格隐藏', () => {
  const h = renderUI(
    assetOf(
      makeNode('splitContainer', {
        id: 'sp1',
        props: { direction: 'horizontal', splitPosition: 30 },
        children: [
          makeNode('vbox', { id: 's0' }),
          makeNode('vbox', { id: 's1' }),
          makeNode('vbox', { id: 's2' }), // 多余窗格
        ],
      }),
    ),
    { mode: 'runtime' },
  );
  assert.equal(byUid(h, 's0').style.flex, '0 0 30%', '第一窗格占 splitPosition%');
  assert.equal(byUid(h, 's1').style.flex, '1 1 0%', '第二窗格吃剩余空间');
  assert.equal(byUid(h, 's2').style.display, 'none', '第三个子节点隐藏');
  assert.ok(
    byUid(h, 's1').classList.contains('bps-split-pane--second'),
    '第二窗格带分隔条类（1px 分隔线视觉）',
  );
  assert.ok(!byUid(h, 's0').classList.contains('bps-split-pane--second'));
  assert.ok(byUid(h, 'sp1').classList.contains('bps-split--horizontal'));
  h.destroy();

  // 上下分栏 + 70% 比例
  const h2 = renderUI(
    assetOf(
      makeNode('splitContainer', {
        id: 'sp2',
        props: { direction: 'vertical', splitPosition: 70 },
        children: [makeNode('vbox', { id: 'w0' }), makeNode('vbox', { id: 'w1' })],
      }),
    ),
    { mode: 'runtime' },
  );
  assert.equal(byUid(h2, 'w0').style.flex, '0 0 70%');
  assert.ok(byUid(h2, 'sp2').classList.contains('bps-split--vertical'));
  assert.ok(byUid(h2, 'w1').classList.contains('bps-split-pane--second'));
  h2.destroy();
});

/* ── 5. anchors（简化版锚点）──────────────────────────────── */

test('anchors：left/top 比例定位、right/bottom 边距、同轴互斥优先 left/top', () => {
  // left/top：比例定位（有效锚点接管该轴，position 不再参与）
  const h = renderUI(
    assetOf(
      makeNode('panel', {
        id: 'p1',
        children: [
          makeNode('label', { id: 'a1', x: 40, y: 50, anchors: { left: 0.5, top: 0.25 } }),
          makeNode('label', { id: 'a2', anchors: { right: 0.1, bottom: 0.75 } }),
          makeNode('label', { id: 'a3', anchors: { left: 0.25, right: 0.9, top: 0.5, bottom: 0.1 } }),
        ],
      }),
    ),
    { mode: 'edit' },
  );
  const a1 = byUid(h, 'a1');
  assert.equal(a1.style.left, '50%', 'left 锚点 → 父容器宽度比例');
  assert.equal(a1.style.top, '25%', 'top 锚点 → 父容器高度比例');
  assert.equal(a1.style.right, '', 'left 生效时 right 不写（同轴互斥）');
  assert.equal(a1.style.bottom, '');

  const a2 = byUid(h, 'a2');
  assert.equal(a2.style.right, '10%', 'right 锚点 → 距右边距比例');
  assert.equal(a2.style.bottom, '75%', 'bottom 锚点 → 距下边距比例');
  assert.equal(a2.style.left, '', '未声明 left → 不写 left');
  assert.equal(a2.style.top, '');

  // 同轴互斥：left/top 优先于 right/bottom
  const a3 = byUid(h, 'a3');
  assert.equal(a3.style.left, '25%');
  assert.equal(a3.style.top, '50%');
  assert.equal(a3.style.right, '');
  assert.equal(a3.style.bottom, '');
  h.destroy();
});

test('anchors：[0,1] 钳制、仅 free 语境生效、无 anchors 回归与移除后无残留', () => {
  // 钳制到 [0,1]
  const h = renderUI(
    assetOf(
      makeNode('panel', {
        id: 'p1',
        children: [makeNode('label', { id: 'c1', anchors: { left: 1.5, top: -3 } })],
      }),
    ),
    { mode: 'edit' },
  );
  const c1 = byUid(h, 'c1');
  assert.equal(c1.style.left, '100%', 'left 1.5 → 钳制 100%');
  assert.equal(c1.style.top, '0%', 'top -3 → 钳制 0%');
  h.destroy();

  // 仅 free 生效：flow 语境 anchors 不产生任何定位样式
  const h2 = renderUI(
    assetOf(
      makeNode('vbox', {
        id: 'v1',
        children: [makeNode('label', { id: 'c2', anchors: { left: 0.5, top: 0.5 } })],
      }),
    ),
    { mode: 'runtime' },
  );
  const c2 = byUid(h2, 'c2');
  assert.equal(c2.style.position, 'static');
  assert.equal(c2.style.left, '', 'flow 语境忽略 anchors');
  assert.equal(c2.style.top, '');
  assert.equal(c2.style.right, '');
  assert.equal(c2.style.bottom, '');
  h2.destroy();

  // 无 anchors 回归：行为与 T1.2 完全一致（position 像素定位）
  const h3 = renderUI(
    assetOf(
      makeNode('panel', {
        id: 'p3',
        children: [makeNode('label', { id: 'c3', x: 40, y: 60 })],
      }),
    ),
    { mode: 'edit' },
  );
  const c3 = byUid(h3, 'c3');
  assert.equal(c3.style.left, '40px');
  assert.equal(c3.style.top, '60px');
  assert.equal(c3.style.right, '');
  assert.equal(c3.style.bottom, '');
  h3.destroy();

  // updateUI 移除 anchors：同元素复用且 right/bottom 无残留
  const h4 = renderUI(
    assetOf(
      makeNode('panel', {
        id: 'p4',
        children: [makeNode('label', { id: 'c4', anchors: { right: 0.5, bottom: 0.5 } })],
      }),
    ),
    { mode: 'edit' },
  );
  const el1 = byUid(h4, 'c4');
  assert.equal(el1.style.right, '50%');
  updateUI(h4, assetOf(makeNode('panel', { id: 'p4', children: [makeNode('label', { id: 'c4', x: 30, y: 40 })] })));
  const el2 = byUid(h4, 'c4');
  assert.ok(el2 === el1, '元素引用复用');
  assert.equal(el2.style.left, '30px', 'anchors 移除后回落 position');
  assert.equal(el2.style.right, '', 'right 无残留');
  assert.equal(el2.style.bottom, '', 'bottom 无残留');
  h4.destroy();
});

/* ── 6. mergeDuplicates 真视觉合并（rowspan）───────────────── */

test('mergeDuplicates 真视觉合并：行体网格化 + 合并单元格 grid-row:span N + 展开保留', () => {
  const columns: ListColumn[] = [
    { field: 'level', title: '级别' },
    { field: 'msg', title: '内容', mergeDuplicates: true },
  ];
  const items = [
    { level: 'INFO', msg: '握手' },
    { level: 'INFO', msg: '握手' },
    { level: 'INFO', msg: '握手' }, // 3 行连值 → 合并区 span 3
    { level: 'ERROR', msg: '崩溃' },
  ];
  const list = makeNode('list', {
    id: 'ls',
    props: { columns, items: JSON.stringify(items) },
  });
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [list] })), {
    mode: 'runtime',
  });
  const lEl = byUid(h, 'ls');
  const body = lEl.querySelector<HTMLElement>('.bps-lbody');
  assert.ok(body, '行体存在');
  assert.ok(body.classList.contains('bps-lbody--grid'), '有合并列 → 行体升级为整体网格');

  // 合并条目：1 个行容器，全部单元格跨 3 行（视觉 rowspan）
  const mergedRow = body.querySelector<HTMLElement>('.bps-lrow[data-merge-key]');
  assert.ok(mergedRow, '合并条目行存在（data-merge-key）');
  const mergedCells = Array.from(mergedRow.querySelectorAll<HTMLElement>('.bps-lcell'));
  assert.equal(mergedCells.length, 2, '合并条目渲染首行数据（2 可见列）');
  for (const cell of mergedCells) {
    assert.ok(cell.classList.contains('bps-lcell--span'), '合并单元格带跨行类');
    assert.match(styleText(cell), /grid-row:\s*span 3/, '单元格 grid-row:span 3');
  }
  const count = mergedRow.querySelector<HTMLElement>('.bps-lcount');
  assert.ok(count, '计数徽标保留');
  assert.equal(count!.textContent, '×3');

  // 非合并条目：单元格不跨行
  const plainRows = body.querySelectorAll('.bps-lrow:not([data-merge-key])');
  assert.equal(plainRows.length, 1, '其余 1 条独立条目');
  const plainCell = plainRows[0]!.querySelector<HTMLElement>('.bps-lcell');
  assert.ok(plainCell, '独立条目单元格存在');
  assert.ok(!plainCell.classList.contains('bps-lcell--span'), '非合并单元格不跨行');
  assert.equal(styleText(plainCell), '', '非合并单元格无 grid-row 内联样式');

  // 计数徽标点击展开被合并的行（v1.1 行为保留）：2 行 × 2 列
  count!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  assert.equal(lEl.querySelectorAll('.bps-lmerged').length, 1, '展开区出现');
  assert.equal(
    lEl.querySelectorAll('.bps-lmerged .bps-lcell').length,
    4,
    '展开 2 条被合并行 × 2 列',
  );
  h.destroy();
});

test('无合并列的 list 不进入合并网格模式（保持行级网格结构）', () => {
  const columns: ListColumn[] = [
    { field: 'level', title: '级别' },
    { field: 'msg', title: '内容' },
  ];
  const list = makeNode('list', {
    id: 'ls2',
    props: { columns, items: JSON.stringify([{ level: 'INFO', msg: '就绪' }]) },
  });
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [list] })), {
    mode: 'runtime',
  });
  const body = byUid(h, 'ls2').querySelector<HTMLElement>('.bps-lbody');
  assert.ok(body, '行体存在');
  assert.ok(!body.classList.contains('bps-lbody--grid'), '无合并列 → 不加网格化类');
  assert.equal(body.querySelectorAll('.bps-lrow').length, 1);
  h.destroy();
});
