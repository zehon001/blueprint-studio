/**
 * DOM 渲染器 · 预制体实例测试（T7.3 · ADR-009）
 *
 * 覆盖（任务卡「渲染器 prefab 用例」）：
 * 1. 缓存命中：实例按预制体结构渲染（子树 data-uid / data-node-type），
 *    实例 props 浅覆盖生效（label 文本）、实例 name/transform 生效（left/top）、
 *    data-prefab 溯源标记；
 * 2. 缓存未命中：渲染占位（__prefab_placeholder + 中文「加载中」文案）并异步补拉，
 *    成功后回调 onPrefabLoad → 调用方 updateUI → 占位替换为真实内容；
 * 3. 反射：预制体缓存内容更新（改动预制体）后 updateUI 即渲染新内容；
 * 4. 循环引用：占位就地显示中文错误，且不发起补拉（无刷新循环）；
 * 5. 嵌套实例：预制体子树内的实例一并展开。
 *
 * 运行：npx tsx --test src/runtime/render/prefab.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

/* ── happy-dom 环境注入（渲染器经全局 document 创建元素）──────── */
const win = new Window();
const doc = win.document;
(globalThis as Record<string, unknown>).window = win;
(globalThis as Record<string, unknown>).document = doc;

import { renderUI, updateUI, type UIRenderEvent, type UIRenderHandle } from './render';
import {
  clearPrefabCache,
  primePrefabCache,
  setPrefabLoaderContext,
  PREFAB_PLACEHOLDER_TYPE,
} from '../../ui-editor/prefab';
import type { UIAsset, UINode } from '../../ir/types';

/* ── 构造辅助 ─────────────────────────────────────────────── */

function makeNode(opt: Partial<UINode> & { id: string }): UINode {
  return {
    id: opt.id,
    name: opt.name ?? opt.id,
    type: opt.type ?? 'panel',
    transform: {
      position: { x: opt.transform?.position.x ?? 0, y: opt.transform?.position.y ?? 0 },
      size: { w: opt.transform?.size.w ?? 120, h: opt.transform?.size.h ?? 32 },
      rotation: opt.transform?.rotation ?? 0,
    },
    theme: opt.theme ?? {},
    props: opt.props ?? {},
    events: opt.events,
    logicAsset: opt.logicAsset,
    prefab: opt.prefab,
    children: opt.children ?? [],
  };
}

function assetOf(root: UINode, name = '预制体'): UIAsset {
  return { version: 3, name, root };
}

/** happy-dom 与 DOM lib 的类型桥（仅类型通道，无运行时差异）：按 uid 取节点元素（断言存在） */
function byUid<T extends HTMLElement = HTMLElement>(h: UIRenderHandle, uid: string): T {
  const el = h.el.querySelector<HTMLElement>(`[data-uid="${uid}"]`);
  assert.ok(el, `未找到 data-uid="${uid}" 的元素`);
  return el as T;
}

/** 每个用例结束统一清缓存（模块级状态） */
function cleanup(h?: UIRenderHandle): void {
  h?.destroy();
  clearPrefabCache();
  setPrefabLoaderContext(null);
}

/* ── 1. 缓存命中 ─────────────────────────────────────────── */

test('缓存命中：结构以预制体为准 + 实例 props 浅覆盖 + transform/name 保留 + data-prefab 溯源', () => {
  const prefabAsset = assetOf(
    makeNode({
      id: 'p_root',
      name: 'prefab-root',
      type: 'label',
      props: { text: 'prefab 文案' },
      children: [],
    }),
  );
  primePrefabCache('ui/prefabs/row.ui.json', prefabAsset);
  const asset = assetOf(
    makeNode({
      id: 'host',
      name: 'host',
      type: 'panel',
      children: [
        makeNode({
          id: 'inst1',
          name: 'row1',
          type: 'label', // 实例化时刻快照
          transform: { position: { x: 12, y: 34 }, size: { w: 0, h: 0 }, rotation: 0 },
          props: { text: '实例覆盖' },
          children: [makeNode({ id: 'junk', name: 'ignored' })], // 实例 children 被忽略
          prefab: 'ui/prefabs/row.ui.json',
        }),
      ],
    }),
    '宿主',
  );
  let refreshed = 0;
  const h = renderUI(asset, { mode: 'edit', onPrefabLoad: () => refreshed++ });

  const inst = byUid(h, 'inst1');
  assert.equal(inst.dataset.nodeType, 'label', 'type 取预制体根（非实例快照）');
  assert.equal(inst.dataset.prefab, 'ui/prefabs/row.ui.json', 'data-prefab 溯源标记');
  assert.equal(inst.textContent, '实例覆盖', '实例 props 浅覆盖预制体根 props');
  assert.equal(inst.style.left, '12px', '实例 transform 保留（free 语境 left/top）');
  assert.equal(inst.style.top, '34px');
  assert.equal(h.el.querySelectorAll('[data-uid="junk"]').length, 0, '实例自身 children 被忽略');
  assert.equal(refreshed, 0, '缓存命中不触发补拉回调');
  cleanup(h);
});

/* ── 2. 缓存未命中：占位 + 补拉 + 刷新 ───────────────────── */

test('缓存未命中：占位渲染 + 异步补拉成功 → onPrefabLoad → updateUI 替换为真实内容', async () => {
  const files: Record<string, string> = {
    'P/ui/prefabs/late.ui.json': JSON.stringify(
      assetOf(makeNode({ id: 'late_root', type: 'label', props: { text: '补拉到了' } })),
    ),
  };
  const fetchImpl = (async (input: unknown): Promise<Response> => {
    const path = decodeURIComponent(String(input).split('path=')[1] ?? '');
    const ok = path in files;
    return {
      json: async () => (ok ? { ok: true, content: files[path] } : { ok: false, message: 'no file' }),
    } as unknown as Response;
  }) as typeof fetch;
  setPrefabLoaderContext({ projectPath: 'P', fetchImpl });

  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst2', name: 'row2', type: 'label', prefab: 'ui/prefabs/late.ui.json' })],
    }),
    '宿主',
  );
  let refreshed = 0;
  const h = renderUI(asset, { mode: 'edit', onPrefabLoad: () => refreshed++ });

  // 未命中 → 占位（中文加载文案），uid 保留实例 id
  const ph = byUid(h, 'inst2');
  assert.equal(ph.dataset.nodeType, PREFAB_PLACEHOLDER_TYPE);
  assert.match(ph.textContent ?? '', /预制体加载中/);
  assert.match(ph.textContent ?? '', /ui\/prefabs\/late\.ui\.json/);

  // 等待补拉完成（微任务链），断言回调已触发
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(refreshed, 1, '补拉成功回调 onPrefabLoad（调用方借此刷新）');

  // 调用方（视口/运行窗口）按惯例 updateUI 重放资产 → 占位替换为真实内容
  updateUI(h, asset);
  const real = byUid(h, 'inst2');
  assert.equal(real.dataset.nodeType, 'label', '同 uid 换 type → 重建为真实渲染器');
  assert.equal(real.textContent, '补拉到了');
  cleanup(h);
});

test('补拉失败：不回调 onPrefabLoad、占位稳定（无刷新循环）', async () => {
  let fetchCalls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    fetchCalls++;
    return { json: async () => ({ ok: false, message: 'no file' }) } as unknown as Response;
  }) as typeof fetch;
  setPrefabLoaderContext({ projectPath: 'P', fetchImpl });
  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst3', type: 'label', prefab: 'ui/prefabs/gone.ui.json' })],
    }),
  );
  let refreshed = 0;
  const h = renderUI(asset, { mode: 'edit', onPrefabLoad: () => refreshed++ });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(refreshed, 0, '失败不触发刷新回调');
  assert.equal(fetchCalls, 1, '失败集合抑制重试');
  updateUI(h, asset); // 再次渲染：仍占位，不再发请求
  assert.equal(byUid(h, 'inst3').dataset.nodeType, PREFAB_PLACEHOLDER_TYPE);
  assert.equal(fetchCalls, 1);
  cleanup(h);
});

/* ── 3. 反射（预制体改动 → 引用处） ──────────────────────── */

test('反射：缓存中的预制体内容更新后 updateUI 即渲染新内容', () => {
  primePrefabCache(
    'ui/prefabs/row.ui.json',
    assetOf(makeNode({ id: 'p_root', type: 'label', props: { text: 'v1' } })),
  );
  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst4', type: 'label', prefab: 'ui/prefabs/row.ui.json' })],
    }),
  );
  const h = renderUI(asset, { mode: 'edit' });
  assert.equal(byUid(h, 'inst4').textContent, 'v1');

  // 「预制体被编辑并保存」：缓存更新（编辑器路径 = 切回引用 tab 时 openUIAsset 重取）
  primePrefabCache(
    'ui/prefabs/row.ui.json',
    assetOf(
      makeNode({
        id: 'p_root2',
        type: 'vbox',
        props: {},
        children: [makeNode({ id: 'p_lbl', type: 'label', props: { text: 'v2 新结构' } })],
      }),
    ),
  );
  updateUI(h, asset);
  assert.equal(byUid(h, 'inst4').dataset.nodeType, 'vbox', '同 uid 换 type → 重建');
  assert.equal(byUid(h, 'p_lbl').textContent, 'v2 新结构', '改动反射到引用处');
  cleanup(h);
});

/* ── 4. 循环引用 ────────────────────────────────────────── */

test('循环引用：占位就地显示中文错误，且不发起补拉', () => {
  primePrefabCache(
    'a.ui.json',
    assetOf(
      makeNode({
        id: 'ar',
        type: 'vbox',
        props: {},
        children: [makeNode({ id: 'toB', type: 'vbox', prefab: 'b.ui.json' })],
      }),
    ),
  );
  primePrefabCache(
    'b.ui.json',
    assetOf(
      makeNode({
        id: 'br',
        type: 'vbox',
        props: {},
        children: [makeNode({ id: 'toA', type: 'vbox', prefab: 'a.ui.json' })],
      }),
    ),
  );
  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst5', type: 'vbox', prefab: 'a.ui.json' })],
    }),
  );
  let refreshed = 0;
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: unknown): Promise<Response> => {
    fetchCalls.push(String(input));
    return { json: async () => ({ ok: false }) } as unknown as Response;
  }) as typeof fetch;
  setPrefabLoaderContext({ projectPath: 'P', fetchImpl });
  const h = renderUI(asset, { mode: 'edit', onPrefabLoad: () => refreshed++ });

  // a 层正常展开，b 内对 a 的回引是占位（中文错误）
  const inst = byUid(h, 'inst5');
  assert.equal(inst.dataset.nodeType, 'vbox');
  const bLayer = byUid(h, 'toB');
  assert.equal(bLayer.dataset.nodeType, 'vbox');
  const cyclePh = byUid(h, 'toA');
  assert.equal(cyclePh.dataset.nodeType, PREFAB_PLACEHOLDER_TYPE);
  assert.match(cyclePh.textContent ?? '', /检测到预制体循环引用：a\.ui\.json → b\.ui\.json → a\.ui\.json/);
  assert.equal(refreshed, 0, '缓存全命中：无补拉');
  assert.equal(fetchCalls.length, 0, '循环路径不发起请求（无渲染循环）');
  cleanup(h);
});

/* ── 5. 嵌套实例 ────────────────────────────────────────── */

test('嵌套实例：预制体子树内的实例一并展开（props 浅覆盖 + 类型取其预制体根）', () => {
  primePrefabCache(
    'ui/prefabs/inner.ui.json',
    assetOf(makeNode({ id: 'i_root', type: 'label', props: { text: '内层默认' } })),
  );
  primePrefabCache(
    'ui/prefabs/outer.ui.json',
    assetOf(
      makeNode({
        id: 'o_root',
        type: 'vbox',
        props: {},
        children: [
          makeNode({ id: 'o_inst', name: 'nested', type: 'label', props: { text: '外层覆盖' }, prefab: 'ui/prefabs/inner.ui.json' }),
        ],
      }),
    ),
  );
  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst6', type: 'vbox', prefab: 'ui/prefabs/outer.ui.json' })],
    }),
  );
  const h = renderUI(asset, { mode: 'edit' });
  const nested = byUid(h, 'o_inst');
  assert.equal(nested.dataset.nodeType, 'label', '嵌套实例以其预制体根 type 渲染');
  assert.equal(nested.textContent, '外层覆盖', '嵌套实例 props 浅覆盖生效');
  cleanup(h);
});

/* ── 6. 运行态一致性 ────────────────────────────────────── */

test('运行态同构：实例在 runtime 模式同样展开渲染', () => {
  primePrefabCache(
    'ui/prefabs/btn.ui.json',
    assetOf(makeNode({ id: 'b_root', type: 'button', props: { text: '运行态按钮' } })),
  );
  const asset = assetOf(
    makeNode({
      id: 'host',
      type: 'panel',
      children: [makeNode({ id: 'inst7', type: 'button', prefab: 'ui/prefabs/btn.ui.json' })],
    }),
  );
  const events: UIRenderEvent[] = [];
  const h = renderUI(asset, { mode: 'runtime', onEvent: (e) => events.push(e) });
  const btn = byUid(h, 'inst7');
  assert.equal(btn.dataset.nodeType, 'button');
  assert.equal(btn.textContent, '运行态按钮');
  assert.equal(h.el.dataset.mode, 'runtime', '运行态根标记');
  cleanup(h);
});
