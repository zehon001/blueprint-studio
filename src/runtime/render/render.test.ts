/**
 * DOM 渲染器测试（T1.2）
 *
 * 覆盖（任务卡单测清单 1–8）：
 * 1. 23 种节点类型全部可渲染不抛错（遍历 schema 构造默认 UINode）
 * 2. 容器嵌套结构正确（vbox>hbox>label 层级 + data-uid 传递）
 * 3. props 应用抽样（text/placeholder/value/checked/percent/variant/…）
 * 4. list：表头列数、colorRules 着色、groupBy 分组头、mergeDuplicates 行为
 * 5. transform：free 绝对定位 vs flow 忽略 position；rotation
 * 6. visible=false / tooltip / expand
 * 7. updateUI 增量：元素引用复用（el === 旧 el）、文本就地更新、子节点增删
 * 8. 运行态事件上报（pressed/textChanged/…）；编辑态冻结（pointer-events + 不上报）
 * 另含：richText 白名单过滤、markdown 轻量转换、两态结构一致、destroy 清理。
 *
 * 运行：npx tsx --test src/runtime/render/render.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// HappyElement/HappyNode：happy-dom 自有类型。render.ts 公开类型（h.el 等）是 DOM lib 类型，
// 与 happy-dom 的 appendChild/getComputedStyle 参数互不兼容，跨边界传参时用双跳桥接（仅类型通道，无运行时差异）。
import { Window, type Element as HappyElement, type Node as HappyNode } from 'happy-dom';

/* ── happy-dom 环境注入（渲染器经全局 document 创建元素）──────── */
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;

import { renderUI, updateUI, type UIRenderEvent, type UIRenderHandle } from './render';
import { defaultPropsFor, uiNodeSchemas, type ListColumn } from '../../ui-editor/schema';
import type { UIAsset, UINode } from '../../ir/types';

/* ── 构造辅助 ─────────────────────────────────────────────── */

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
      position: { x: opt.x ?? pos?.x ?? 0, y: opt.y ?? pos?.y ?? 0 },
      size: { w: opt.w ?? size?.w ?? 0, h: opt.h ?? size?.h ?? 0 },
      rotation: opt.rotation ?? (all.rotation as number) ?? 0,
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

/** 事件收集器（取最后一条，断言存在） */
function makeCollector() {
  const events: UIRenderEvent[] = [];
  return {
    events,
    onEvent: (e: UIRenderEvent) => events.push(e),
    last(): UIRenderEvent {
      const e = events[events.length - 1];
      assert.ok(e, '事件列表为空');
      return e;
    },
  };
}

/* ── 1. 23 种类型全渲染 ────────────────────────────────────── */

test('23 种节点类型全部可渲染且带 data-uid / data-node-type', () => {
  assert.equal(uiNodeSchemas.length, 23, '前置：schema 注册 23 种');
  const children = uiNodeSchemas.map((s) => makeNode(s.type));
  const root = makeNode('vbox', { id: 'root', name: 'root', children });
  const h = renderUI(assetOf(root), { mode: 'runtime' });

  assert.ok(h.el.classList.contains('bps-ui-root'), '根元素为 .bps-ui-root');
  assert.equal(h.el.dataset.mode, 'runtime');
  // 根节点 + 23 个子节点，全部带 data-uid
  assert.equal(h.el.querySelectorAll('[data-uid]').length, 24);
  for (const s of uiNodeSchemas) {
    const node = children.find((c) => c.type === s.type)!;
    const el = byUid(h, node.id);
    assert.equal(el.dataset.nodeType, s.type, `${s.type} 的 data-node-type 正确`);
    assert.equal(el.dataset.visible, 'true');
  }
  h.destroy();
});

/* ── 2. 容器嵌套 ──────────────────────────────────────────── */

test('容器嵌套：vbox > hbox > label 的 DOM 层级与 data-uid 传递', () => {
  const label = makeNode('label', { id: 'l1', props: { text: '嵌套文本' } });
  const hbox = makeNode('hbox', { id: 'h1', children: [label] });
  const vbox = makeNode('vbox', { id: 'v1', children: [hbox] });
  const h = renderUI(assetOf(vbox), { mode: 'runtime' });

  const vEl = byUid(h, 'v1');
  const hEl = byUid(h, 'h1');
  const lEl = byUid(h, 'l1');
  assert.equal(vEl.parentElement, h.el, '根节点直接挂在 .bps-ui-root 下');
  assert.equal(hEl.parentElement, vEl);
  assert.equal(lEl.parentElement, hEl);
  assert.ok(vEl.classList.contains('bps-vbox'));
  assert.ok(hEl.classList.contains('bps-hbox'));
  assert.equal(lEl.textContent, '嵌套文本');
  assert.equal(lEl.dataset.nodeType, 'label');
  h.destroy();
});

/* ── 3. props 应用抽样 ────────────────────────────────────── */

test('props 应用：text/placeholder/value/checked/percent/variant/fit 抽样断言', () => {
  const children = [
    makeNode('label', { id: 'e0', props: { text: '标签A' } }),
    makeNode('lineEdit', { id: 'e1', props: { text: 'abc', placeholder: '请输入', password: true, readOnly: true } }),
    makeNode('checkBox', { id: 'e2', props: { text: '同意', checked: true } }),
    makeNode('optionButton', { id: 'e3', props: { items: ['甲', '乙'], value: '乙' } }),
    makeNode('slider', { id: 'e4', props: { min: 10, max: 90, step: 5, value: 40 } }),
    makeNode('spinBox', { id: 'e5', props: { value: 7, suffix: 'px' } }),
    makeNode('progressBar', { id: 'e6', props: { value: 25, min: 0, max: 200, showPercent: true } }),
    makeNode('button', { id: 'e7', props: { text: '点我', variant: 'danger' } }),
    makeNode('image', { id: 'e8', props: { src: 'assets/a.png', fit: 'cover' } }),
  ];
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children })), { mode: 'runtime' });

  assert.equal(byUid(h, 'e0').textContent, '标签A');

  const input = byUid<HTMLInputElement>(h, 'e1');
  assert.equal(input.value, 'abc');
  assert.equal(input.getAttribute('placeholder'), '请输入');
  assert.equal(input.type, 'password');
  assert.equal(input.readOnly, true);

  const check = byUid(h, 'e2');
  const cb = check.querySelector<HTMLInputElement>('input');
  assert.ok(cb, 'checkBox 含 input[type=checkbox]');
  assert.equal(cb.checked, true);
  assert.match(check.textContent ?? '', /同意/, '勾选框文本联动');

  const sel = byUid<HTMLSelectElement>(h, 'e3');
  assert.equal(sel.value, '乙');
  assert.equal(sel.querySelectorAll('option').length, 2);

  const slider = byUid<HTMLInputElement>(h, 'e4');
  assert.equal(slider.type, 'range');
  assert.equal(slider.value, '40');
  assert.equal(slider.min, '10');
  assert.equal(slider.max, '90');
  assert.equal(slider.step, '5');

  const spinEl = byUid(h, 'e5');
  const spin = spinEl.querySelector<HTMLInputElement>('input');
  assert.ok(spin);
  assert.equal(spin.type, 'number');
  assert.equal(spin.value, '7');
  const suffix = spinEl.querySelector<HTMLElement>('.bps-spin-suffix');
  assert.equal(suffix?.textContent, 'px');

  const prog = byUid(h, 'e6');
  const fill = prog.querySelector<HTMLElement>('.bps-progress-fill');
  assert.equal(fill?.style.width, '12.5%', '进度条按 min/max 换算（25/200）');
  assert.equal(prog.querySelector<HTMLElement>('.bps-progress-text')?.textContent, '13%');

  const btn = byUid<HTMLButtonElement>(h, 'e7');
  assert.equal(btn.textContent, '点我');
  assert.ok(btn.classList.contains('bps-btn--danger'));

  const img = byUid<HTMLImageElement>(h, 'e8');
  assert.equal(img.dataset.src, 'assets/a.png', '渲染器只写 data-src（URL 解析归 T1.6）');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.style.objectFit, 'cover');

  h.destroy();
});

/* ── 4. list（列定义 / 颜色 / 分组 / 合并）──────────────────── */

test('list：表头列数 / colorRules 着色 / groupBy 分组头 / mergeDuplicates', () => {
  const columns: ListColumn[] = [
    { field: 'level', title: '级别', width: 60, colorRules: [{ op: 'eq', value: 'ERROR', color: '#e06c75' }] },
    { field: 'msg', title: '内容', mergeDuplicates: true },
    { field: 'session', title: '会话', groupBy: true },
  ];
  const items = [
    { level: 'INFO', msg: '握手', session: 'S1' },
    { level: 'ERROR', msg: '握手', session: 'S1' },
    { level: 'ERROR', msg: '崩溃', session: 'S2' },
    { level: 'WARN', msg: '慢查询', session: 'S2' },
  ];
  const list = makeNode('list', { id: 'ls', name: 'logList', props: { columns, items: JSON.stringify(items) } });
  const c = makeCollector();
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [list] })), {
    mode: 'runtime',
    onEvent: c.onEvent,
  });
  const lEl = byUid(h, 'ls');

  // 表头：groupBy 列不进表头（作组头展示），可见列 = 2
  assert.equal(lEl.querySelectorAll('.bps-lhead .bps-lcell').length, 2);

  // 分组头：S1 / S2 各一组，带条数
  const heads = Array.from(lEl.querySelectorAll<HTMLElement>('.bps-lgroup'));
  assert.equal(heads.length, 2);
  assert.ok(heads[0].textContent?.includes('S1'));
  assert.ok(heads[0].textContent?.includes('1 条'), 'S1 组内合并后 1 条');
  assert.ok(heads[1].textContent?.includes('S2'));
  assert.ok(heads[1].textContent?.includes('2 条'));

  // colorRules：ERROR 单元格渲染为徽标且背景 = 规则色
  const badge = Array.from(lEl.querySelectorAll<HTMLElement>('.bps-lbadge')).find(
    (b) => b.textContent === 'ERROR',
  );
  assert.ok(badge, 'ERROR 单元格有徽标');
  assert.match(
    badge!.style.background,
    /224,\s*108,\s*117|#e06c75/i,
    '徽标底色来自 colorRules 规则色',
  );

  // mergeDuplicates：S1 组内相邻同 msg 两行合并为 1 行 + ×2 徽标（S2 两行 msg 不同不合）
  const count = lEl.querySelector<HTMLElement>('.bps-lcount');
  assert.ok(count, '出现合并计数徽标');
  assert.equal(count!.textContent, '×2');
  assert.equal(lEl.querySelectorAll('.bps-lrow').length, 3, '4 行数据合并后 3 行');

  // 点击计数徽标：展开被合并的行（1 行 × 2 列）
  count!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  assert.equal(lEl.querySelectorAll('.bps-lmerged').length, 1);
  assert.equal(lEl.querySelectorAll('.bps-lmerged .bps-lcell').length, 2);

  // 行点击：selectionChanged 带行数据
  let rows = Array.from(lEl.querySelectorAll<HTMLElement>('.bps-lrow'));
  rows[2].dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'selectionChanged');
  assert.equal(c.last().nodeName, 'logList');
  assert.deepEqual(c.last().payload, { level: 'WARN', msg: '慢查询', session: 'S2' });

  // 双击行：doubleClicked 带行数据（选中重渲染替换了行元素，需重查 DOM）
  rows = Array.from(lEl.querySelectorAll<HTMLElement>('.bps-lrow'));
  rows[1].dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'doubleClicked');
  assert.deepEqual(c.last().payload, { level: 'ERROR', msg: '崩溃', session: 'S2' });

  h.destroy();
});

/* ── 5. transform ─────────────────────────────────────────── */

test('transform：free 绝对定位 vs flow 忽略 position；rotation 生效', () => {
  // free：panel（自由容器）内 label → 绝对定位 + 尺寸 + 旋转
  const free = makeNode('label', { id: 'f1', props: { text: '自由' }, x: 40, y: 50, w: 120, h: 40, rotation: 15 });
  const panel = makeNode('panel', { id: 'p1', children: [free], w: 400, h: 300 });
  const h = renderUI(assetOf(panel), { mode: 'edit' });
  const f = byUid(h, 'f1');
  assert.equal(f.style.position, 'absolute');
  assert.equal(f.style.left, '40px');
  assert.equal(f.style.top, '50px');
  assert.equal(f.style.width, '120px');
  assert.equal(f.style.height, '40px');
  assert.equal(f.style.transform, 'rotate(15deg)');
  h.destroy();

  // flow：vbox 内 label → 忽略 position（不产生 left/top），rotation 仍生效
  const flow = makeNode('label', { id: 'f2', props: { text: '流式' }, x: 99, y: 99, rotation: 30 });
  const h2 = renderUI(assetOf(makeNode('vbox', { id: 'v2', children: [flow] })), { mode: 'runtime' });
  const fl = byUid(h2, 'f2');
  assert.equal(fl.style.position, 'static');
  assert.equal(fl.style.left, '', 'flow 子项忽略 position.x');
  assert.equal(fl.style.top, '', 'flow 子项忽略 position.y');
  assert.equal(fl.style.width, '160px', 'size.w 转宽高');
  assert.equal(fl.style.transform, 'rotate(30deg)');
  h2.destroy();
});

/* ── 6. visible / tooltip / expand ────────────────────────── */

test('visible=false / tooltip / expand', () => {
  const hidden = makeNode('label', { id: 'x1', props: { text: '隐藏', visible: false } });
  const tip = makeNode('button', { id: 'x2', props: { text: '提示', tooltip: '我是提示' } });
  const grow = makeNode('label', { id: 'x3', props: { text: '拉伸', expand: true } });
  const h = renderUI(assetOf(makeNode('hbox', { id: 'root', children: [hidden, tip, grow] })), {
    mode: 'runtime',
  });

  const hid = byUid(h, 'x1');
  assert.equal(hid.style.display, 'none', 'visible=false → display:none');
  assert.equal(hid.dataset.visible, 'false', 'data-visible 标记（T1.3 叠加层用）');

  assert.equal(byUid(h, 'x2').getAttribute('title'), '我是提示', 'tooltip → title 属性');

  assert.equal(byUid(h, 'x3').style.flexGrow, '1', 'expand → flex-grow:1（流式父容器）');
  h.destroy();
});

/* ── 7. updateUI 增量 ─────────────────────────────────────── */

test('updateUI 增量：元素引用复用 / 文本就地更新 / 子节点增删与排序', () => {
  const a = makeNode('label', { id: 'a', props: { text: 'A' } });
  const b = makeNode('button', { id: 'b', props: { text: 'B' } });
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [a, b] })), { mode: 'runtime' });

  const aEl1 = byUid(h, 'a');
  const rootEl1 = byUid(h, 'root');
  const bEl1 = byUid(h, 'b');

  // 新资产：删除 b，新增 c，a 改文本（uid/type 不变的新对象）
  const a2 = makeNode('label', { id: 'a', props: { text: 'A2' } });
  const c = makeNode('label', { id: 'c', props: { text: 'C' } });
  updateUI(h, assetOf(makeNode('vbox', { id: 'root', children: [c, a2] })));

  const aEl2 = byUid(h, 'a');
  assert.ok(aEl2 === aEl1, 'uid 相同节点 DOM 引用复用');
  assert.equal(aEl2.textContent, 'A2', 'props 变化就地更新');
  assert.ok(byUid(h, 'root') === rootEl1, '根节点元素同样复用');
  assert.equal(h.el.querySelector('[data-uid="b"]'), null, '删除的子节点 DOM 移除');
  assert.equal(byUid(h, 'c').textContent, 'C', '新增的子节点 DOM 出现');
  const order = Array.from((byUid(h, 'root') as HTMLElement).children).map((e) =>
    e.getAttribute('data-uid'),
  );
  assert.deepEqual(order, ['c', 'a'], 'DOM 顺序与新 children 一致');
  assert.notEqual(bEl1.isConnected, true, '被删元素已脱离文档');

  // 整树换根（uid/type 均变）：旧根移除、新根渲染
  updateUI(h, assetOf(makeNode('panel', { id: 'root2', props: { title: '新根' } })));
  assert.equal(h.el.querySelector('[data-uid="root"]'), null);
  assert.equal(byUid(h, 'root2').querySelector<HTMLElement>('.bps-panel-title')?.textContent, '新根');

  h.destroy();
  // 已销毁句柄：静默 no-op
  assert.doesNotThrow(() => updateUI(h, assetOf(a2)));
});

/* ── 8. 事件上报与编辑态冻结 ──────────────────────────────── */

test('运行态内建事件经 onEvent 上报（事件名与 schema BuiltInEvent 一致）', () => {
  const c = makeCollector();
  const btn = makeNode('button', { id: 'b1', name: 'btnGo', props: { text: '运行' } });
  const line = makeNode('lineEdit', { id: 'l1', name: 'nameInput', props: { text: '' } });
  const check = makeNode('checkBox', { id: 'c1', name: 'agree', props: { checked: false } });
  const opt = makeNode('optionButton', { id: 'o1', name: 'picker', props: { items: ['1', '2'], value: '1' } });
  const slider = makeNode('slider', { id: 's1', name: 'size', props: { value: 0 } });
  const h = renderUI(
    assetOf(makeNode('vbox', { id: 'root', children: [btn, line, check, opt, slider] })),
    { mode: 'runtime', onEvent: c.onEvent },
  );

  byUid<HTMLButtonElement>(h, 'b1').dispatchEvent(
    new win.MouseEvent('click', { bubbles: true }) as unknown as Event,
  );
  assert.deepEqual(c.last(), { nodeName: 'btnGo', nodeType: 'button', event: 'pressed' });

  const input = byUid<HTMLInputElement>(h, 'l1');
  input.value = 'hello';
  input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'textChanged');
  assert.equal(c.last().payload, 'hello');
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'submit');
  assert.equal(c.last().payload, 'hello');

  const cb = byUid(h, 'c1').querySelector<HTMLInputElement>('input')!;
  cb.checked = true;
  cb.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'toggled');
  assert.equal(c.last().payload, true);

  const sel = byUid<HTMLSelectElement>(h, 'o1');
  sel.value = '2';
  sel.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'selectedChanged');
  assert.equal(c.last().payload, '2');

  const rng = byUid<HTMLInputElement>(h, 's1');
  rng.value = '42';
  rng.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  assert.equal(c.last().event, 'valueChanged');
  assert.equal(c.last().payload, 42);

  h.destroy();
});

test('编辑态冻结：pointer-events none + 点击不上报事件', () => {
  const btn = makeNode('button', { id: 'b1', name: 'btnGo', props: { text: '冻结' } });
  const line = makeNode('lineEdit', { id: 'l1', props: { text: '' } });
  const c = makeCollector();
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [btn, line] })), {
    mode: 'edit',
    onEvent: c.onEvent,
  });
  doc.body.appendChild(h.el as unknown as HappyNode); // 挂载后 getComputedStyle 才能反映最终样式

  assert.equal(h.el.dataset.mode, 'edit');
  assert.equal(win.getComputedStyle(h.el as unknown as HappyElement).pointerEvents, 'none', '根元素 pointer-events:none');
  assert.ok(h.el.classList.contains('bps-ui-root--edit'));
  assert.notEqual(h.el.getAttribute('inert'), null, 'inert 冻结焦点链');
  // 焦点链冻结：可聚焦元素 tabindex=-1
  const b = byUid<HTMLButtonElement>(h, 'b1');
  assert.equal(b.getAttribute('tabindex'), '-1');

  // 直接派发点击 / 输入也不触发事件（emit 按 mode 门控）
  b.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
  const input = byUid<HTMLInputElement>(h, 'l1');
  input.value = 'x';
  input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  assert.equal(c.events.length, 0, '编辑态不触发任何内建事件');
  h.destroy();
});

/* ── 补充：安全与一致性 ───────────────────────────────────── */

test('richText 白名单：script 移除、事件属性剔除、样式保留', () => {
  const rt = makeNode('richText', {
    id: 'rt',
    props: {
      text: '<b>粗</b><script>alert(1)</script><span onclick="x()" style="color:#ff0000">红</span><em onmouseover="y()">斜</em>',
    },
  });
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [rt] })), { mode: 'runtime' });
  const el = byUid(h, 'rt');
  assert.ok(el.querySelector('b'), '白名单标签保留');
  assert.equal(el.querySelector('script'), null, 'script 整块移除');
  const spanEl = el.querySelector('span');
  assert.equal(spanEl?.getAttribute('onclick'), null, '事件属性剔除');
  assert.match(spanEl?.getAttribute('style') ?? '', /#ff0000/i, '安全 style 保留');
  const em = el.querySelector('em');
  assert.equal(em?.getAttribute('onmouseover'), null);
  h.destroy();
});

test('markdown 轻量转换：标题/加粗/代码渲染，表格语法降级纯文本', () => {
  const md = makeNode('markdown', {
    id: 'md',
    props: { text: '# 标题\n\n**加粗** 与 `代码`\n\n| 表格 | 降级 |\n|---|---|\n| a | b |' },
  });
  const h = renderUI(assetOf(makeNode('vbox', { id: 'root', children: [md] })), { mode: 'runtime' });
  const el = byUid(h, 'md');
  assert.ok(el.querySelector('h1'), '标题渲染');
  assert.ok(el.querySelector('strong'), '加粗渲染');
  assert.ok(el.querySelector('code'), '行内代码渲染');
  assert.equal(el.querySelector('table'), null, '表格语法不渲染为 table（降级）');
  assert.ok(el.textContent?.includes('| 表格 |'), '表格文本保留（纯文本降级）');
  h.destroy();
});

test('编辑态与运行态渲染结构一致（同一 UI 树两态 DOM 同构）', () => {
  const build = () =>
    makeNode('vbox', {
      id: 'root',
      children: [
        makeNode('panel', { id: 'p', children: [makeNode('button', { id: 'bt' })] }),
        makeNode('list', { id: 'ls', props: { items: '[{"level":"INFO","msg":"就绪"}]' } }),
        makeNode('tree', { id: 'tr' }),
      ],
    });
  const he = renderUI(assetOf(build()), { mode: 'edit' });
  const hr = renderUI(assetOf(build()), { mode: 'runtime' });
  assert.equal(
    he.el.querySelectorAll('[data-uid]').length,
    hr.el.querySelectorAll('[data-uid]').length,
  );
  // 两态同构：忽略模式差异标记（edit 态多 data-visible 由统一 patch 写入，tabindex 为冻结标记）
  const canon = (html: string) =>
    html.replace(/ (data-visible|tabindex)="[^"]*"/g, '');
  assert.equal(canon(he.el.innerHTML), canon(hr.el.innerHTML), '两态 DOM 一致');
  he.destroy();
  hr.destroy();
});

test('destroy 清理：根元素移除、重复销毁安全', () => {
  const h = renderUI(assetOf(makeNode('label', { id: 'only', props: { text: 'x' } })), {
    mode: 'runtime',
  });
  doc.body.appendChild(h.el as unknown as HappyNode);
  assert.ok(h.el.parentElement, '已挂载');
  h.destroy();
  assert.equal(h.el.parentElement, null, '根元素从 DOM 移除');
  assert.doesNotThrow(() => h.destroy(), '重复销毁安全');
});
