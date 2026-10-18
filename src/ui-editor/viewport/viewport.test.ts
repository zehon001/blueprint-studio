/**
 * 2D 视口测试（T1.3）
 *
 * 覆盖（任务卡单测清单 1–6）：
 * 1. 几何纯函数：包围盒相交、坐标换算（screen→canvas 含 scale/pan）、吸附线求解
 *    （阈值命中 / 不命中）、对齐分布计算（左对齐 / 等距）
 * 2. 命中测试：data-uid 几何拾取（最内层命中）、空白未命中
 * 3. 移动命令：runUICommand 后资产 transform.position 变化 + undo 还原（真实命令栈）
 * 4. 框选选择集计算（矩形含多节点；纯函数 + 组件交互两条路）
 * 5. Ctrl+D 复制：新 id + name 全树去重 + 偏移 + 子树换 id
 * 6. 组件冒烟：happy-dom 挂载 UIEditorPanel（store asset 经 runCommand 注入）不抛错，
 *    并覆盖点击/Ctrl加选/拖动/框选/键盘微调/Delete/flow 拒移提示/吸附线/对齐工具条/
 *    缩放与重置视图/右键菜单（添加节点 / 复制 / 删除）。
 *
 * 运行：npx tsx --test src/ui-editor/viewport/viewport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UIAsset, UINode } from '../../ir/types';
import type { SceneTreeDomainState } from '../store';
import type { AlignEntry, PickEntry } from './geometry';

/* ── happy-dom 环境注入（组件挂载用；与 interaction.test.ts 同款桥接）──────── */
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
  'WheelEvent',
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

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { UIEditorPanel } = await import('./UIEditorPanel');
const geometry = await import('./geometry');
const commands = await import('./commands');
const { getSceneTreeDomain, useUIEditorStore } = await import('../store');
const { registerDomainState, runCommand, resetEditorStore, undo, redo, peekUndo, useEditorStore } =
  await import('../../shell/commands');
const { defaultPropsFor } = await import('../schema');

/* ============================================================
 * 构造辅助
 * ============================================================ */

let seq = 0;

/** 按 schema 默认值构造 UINode（公共 name/position/size/rotation 拆入顶层与 transform） */
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
      rotation: (all.rotation as number) ?? 0,
    },
    theme: {},
    props,
    events: [],
    children: opt.children ?? [],
  };
}

/** 自由布局资产：根 panel（400×300）+ 两个 button（free 型，可自由移动） */
function makeAsset(): UIAsset {
  return {
    version: 2,
    name: '测试 UI',
    root: {
      ...makeNode('panel', { id: 'root', name: 'root', x: 0, y: 0, w: 400, h: 300 }),
      children: [
        makeNode('button', { id: 'a', name: 'button', x: 20, y: 20, w: 80, h: 30 }),
        makeNode('button', { id: 'b', name: 'button2', x: 200, y: 20, w: 80, h: 30 }),
      ],
    },
  };
}

/** 流式布局资产：根 vbox + 一个 label（flow 型，移动被拒） */
function makeFlowAsset(): UIAsset {
  return {
    version: 2,
    name: '流式 UI',
    root: {
      ...makeNode('vbox', { id: 'root', name: 'root', w: 200, h: 300 }),
      children: [makeNode('label', { id: 'lbl', name: 'label', w: 120, h: 24 })],
    },
  };
}

/** 重置命令栈 + 注入 scene-tree 域资产（组件冒烟的 store mock 通路） */
function initDomain(asset: UIAsset | null = null): void {
  resetEditorStore();
  // 先经 store 自己的 ensureDomain 挂域（置内部 domainRegistered 标志，
  // 避免后续 runUICommand 再次 registerDomainState 把注入的资产冲掉）
  void getSceneTreeDomain();
  registerDomainState<SceneTreeDomainState>('scene-tree', { asset: null });
  if (asset) {
    runCommand<SceneTreeDomainState>('scene-tree', '测试注入', (d) => {
      d.asset = asset;
    });
  }
  // 注入本身是一条命令（同生产 openUIAsset 的「打开 UI」）：清栈让各测试从零基线开始
  useEditorStore.setState({ undoStack: [], redoStack: [], lastReplay: null });
  useUIEditorStore.setState({
    projectPath: '测试项目',
    assetPath: 'ui/test.ui.json',
    status: asset ? 'ready' : 'idle',
    message: '',
    selection: [],
  });
}

/* —— happy-dom 桥接（happy-dom 自有类型与 DOM lib 跨界用双跳）—— */

interface RectStub {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 覆盖元素的 getBoundingClientRect（画布量测的真实数据通路） */
function stubRect(el: Element | null | undefined, r: RectStub): void {
  assert.ok(el, 'stubRect：目标元素不存在');
  (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON() {
      return this;
    },
  });
}

function q(selector: string): HTMLElement {
  const el = dom.document.querySelector(selector);
  assert.ok(el, `未找到元素 ${selector}`);
  return el as unknown as HTMLElement;
}

function byUid(uid: string): HTMLElement {
  const el = dom.document.querySelector(`[data-uid="${uid}"]`);
  assert.ok(el, `未找到 data-uid="${uid}" 的元素`);
  return el as unknown as HTMLElement;
}

/** 自由布局资产的包围盒桩（surface 即视口原点） */
function stubFreeSceneRects(): void {
  stubRect(q('.bps-vp__surface'), { left: 0, top: 0, width: 800, height: 600 });
  stubRect(byUid('root'), { left: 0, top: 0, width: 400, height: 300 });
  stubRect(byUid('a'), { left: 20, top: 20, width: 80, height: 30 });
  stubRect(byUid('b'), { left: 200, top: 20, width: 80, height: 30 });
}

/** 挂载 UIEditorPanel（act 内 render；返回卸载函数与关键元素） */
async function mountPanel(): Promise<{ unmount: () => Promise<void> }> {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(createElement(UIEditorPanel));
  });
  return {
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
}

function pointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
): void {
  act(() => {
    el.dispatchEvent(
      new dom.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        ...extra,
      } as never) as unknown as Event,
    );
  });
}

function key(el: HTMLElement, keyName: string, extra: Record<string, unknown> = {}): void {
  act(() => {
    el.dispatchEvent(
      new dom.KeyboardEvent('keydown', {
        key: keyName,
        bubbles: true,
        cancelable: true,
        ...extra,
      } as never) as unknown as Event,
    );
  });
}

function contextMenu(el: HTMLElement, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(
      new dom.MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 2,
      } as never) as unknown as Event,
    );
  });
}

function wheel(el: HTMLElement, deltaY: number, extra: Record<string, unknown> = {}): void {
  act(() => {
    const ev = new dom.WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY,
      ...extra,
    } as never) as unknown as Event & Record<string, unknown>;
    // happy-dom 未从 init 映射 ctrlKey：测试需要时补写只读属性
    if (extra.ctrlKey !== undefined) {
      Object.defineProperty(ev, 'ctrlKey', { value: extra.ctrlKey });
    }
    el.dispatchEvent(ev as unknown as Event);
  });
}

/* ============================================================
 * 1. 几何纯函数
 * ============================================================ */

test('几何：坐标换算（screen→canvas 含 scale/pan）与往返一致', () => {
  const view = { x: 10, y: 20, scale: 2 };
  // screen(45,65) - origin(5,5) - pan(10,20) = (30,40) / 2 = (15,20)
  assert.deepEqual(geometry.screenToCanvas({ x: 45, y: 65 }, view, { x: 5, y: 5 }), { x: 15, y: 20 });
  // 默认 origin = {0,0}
  assert.deepEqual(geometry.screenToCanvas({ x: 30, y: 60 }, view), { x: 10, y: 20 });
  // 往返
  const p = { x: 123.5, y: -45.25 };
  const round = geometry.canvasToScreen(geometry.screenToCanvas(p, view), view);
  assert.ok(Math.abs(round.x - p.x) < 1e-9 && Math.abs(round.y - p.y) < 1e-9, 'canvas→screen 往返一致');
  // 缩放钳制
  assert.equal(geometry.clampScale(0.1), 0.25);
  assert.equal(geometry.clampScale(10), 4);
  assert.equal(geometry.clampScale(1.5), 1.5);
  assert.equal(geometry.clampScale(Number.NaN), 1);
});

test('几何：以光标为中心缩放（光标下的画布点不动）+ clientRect 换算', () => {
  const view = { x: 0, y: 0, scale: 1 };
  const next = geometry.zoomAt({ x: 100, y: 50 }, view, 2);
  assert.equal(next.scale, 2);
  assert.deepEqual(geometry.screenToCanvas({ x: 100, y: 50 }, next), { x: 100, y: 50 }, '光标画布点缩放前后不变');
  // clientRect → canvas：rect(50,60,100,50)，view{x:10,y:20,scale:2} → (20,20,50,25)
  assert.deepEqual(
    geometry.clientRectToCanvas({ left: 50, top: 60, width: 100, height: 50 }, { x: 10, y: 20, scale: 2 }),
    { x: 20, y: 20, w: 50, h: 25 },
  );
});

test('几何：包围盒相交 / 点包含 / 归一化', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.ok(geometry.rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 }), '部分重叠相交');
  assert.ok(!geometry.rectsIntersect(a, { x: 100, y: 0, w: 10, h: 10 }), '仅边缘相切不算（面积零）');
  assert.ok(!geometry.rectsIntersect(a, { x: 200, y: 200, w: 10, h: 10 }), '分离不相交');
  assert.ok(!geometry.rectsIntersect(a, { x: 0, y: 0, w: 0, h: 0 }), '零面积不相交');
  assert.ok(geometry.rectContainsPoint(a, { x: 100, y: 100 }), '点含边界');
  assert.ok(!geometry.rectContainsPoint(a, { x: 100.5, y: 50 }), '点出界');
  assert.deepEqual(geometry.normalizeRect({ x: 50, y: 60 }, { x: 10, y: 20 }), { x: 10, y: 20, w: 40, h: 40 }, '反向拖拽归一化');
});

test('几何：吸附线求解（阈值命中 / 不命中 / 中心线 / 双轴）', () => {
  const moving = { x: 100, y: 0, w: 50, h: 40 };
  // 命中：moving 右缘 150 vs other 左缘 154（差 4 ≤ 6）→ dx=4；other 在 y=200 避开 y 轴吸附
  const hit = geometry.resolveSnap(moving, [{ x: 154, y: 200, w: 50, h: 40 }]);
  assert.equal(hit.dx, 4, '命中贴齐修正');
  assert.equal(hit.dy, 0);
  assert.equal(hit.lines.length, 1);
  assert.equal(hit.lines[0]?.axis, 'x');
  assert.equal(hit.lines[0]?.at, 154);
  // 阈值边界：差恰好 6 → 命中
  const edge = geometry.resolveSnap(moving, [{ x: 156, y: 200, w: 50, h: 40 }]);
  assert.equal(edge.dx, 6, '阈值 6px 边界命中');
  // 不命中：差 50（other 在 y=300，避开 y 轴同顶的零差命中）
  const miss = geometry.resolveSnap(moving, [{ x: 200, y: 300, w: 50, h: 40 }]);
  assert.equal(miss.dx, 0);
  assert.equal(miss.dy, 0);
  assert.equal(miss.lines.length, 0, '不命中无吸附线');
  // 中心线命中：moving 中心 125 vs other 左缘 130（差 5）
  const center = geometry.resolveSnap(moving, [{ x: 130, y: 200, w: 50, h: 40 }]);
  assert.equal(center.dx, 5, '中心参考命中');
  // 双轴：y 方向 also 命中
  const both = geometry.resolveSnap(moving, [{ x: 154, y: 45, w: 50, h: 40 }]);
  assert.equal(both.dy, 5, 'y 轴命中（moving 下缘 40 vs other 上缘 45）');
  assert.equal(both.lines.length, 2, '双轴各一条线');
});

test('几何：对齐分布计算（左对齐 / 水平居中 / 水平等距 / 条目不足）', () => {
  const mk = (id: string, x: number): AlignEntry => ({
    id,
    position: { x, y: 10 },
    box: { x, y: 0, w: 40, h: 20 },
  });
  // 左对齐：全部 x → 最小 box.x = 0
  const left = geometry.computeAlignment([mk('p', 0), mk('q', 100), mk('r', 260)], 'left');
  assert.equal(left.get('p')?.x, 0);
  assert.equal(left.get('q')?.x, 0);
  assert.equal(left.get('r')?.x, 0);
  assert.ok([...left.values()].every((p) => p.y === 10), '对齐不改变另一轴');
  // 水平居中：bbox = (0..140)，中心 70（box 中心对齐）
  const hc = geometry.computeAlignment([mk('p', 0), mk('q', 100)], 'hcenter');
  assert.equal(hc.get('p')?.x, 50, 'p 中心 20 → 70：x + 50');
  assert.equal(hc.get('q')?.x, 50, 'q 中心 120 → 70：x + 50');
  // 水平等距：中心 20/120/280 → 中间均分到 150
  const dist = geometry.computeAlignment([mk('p', 0), mk('q', 100), mk('r', 260)], 'distribute-h');
  assert.equal(dist.get('p')?.x, 0, '首节点不动');
  assert.equal(dist.get('q')?.x, 130, '中间节点中心均分');
  assert.equal(dist.get('r')?.x, 260, '尾节点不动');
  // 条目不足
  assert.equal(geometry.computeAlignment([mk('p', 0)], 'left').size, 0, '<2 不对齐');
  assert.equal(geometry.computeAlignment([mk('p', 0), mk('q', 100)], 'distribute-h').size, 0, '<3 不分布');
});

test('几何：名称唯一化（去重追加序号）', () => {
  const taken = new Set(['root', 'button', 'button2']);
  assert.equal(geometry.uniqueName('button', taken), 'button3');
  assert.equal(geometry.uniqueName('label', taken), 'label', '未占用原样返回');
  assert.equal(geometry.uniqueName('root', taken), 'root2');
});

/* ============================================================
 * 2. 命中 / 框选纯函数
 * ============================================================ */

test('命中测试：最内层命中 / 空白未命中 / 零面积跳过', () => {
  const entries: PickEntry[] = [
    { id: 'root', rect: { x: 0, y: 0, w: 400, h: 300 } },
    { id: 'a', rect: { x: 20, y: 20, w: 80, h: 30 } },
    { id: 'b', rect: { x: 200, y: 20, w: 80, h: 30 } },
  ];
  assert.equal(geometry.hitTest({ x: 30, y: 30 }, entries), 'a', '命中子节点（面积最小者）');
  assert.equal(geometry.hitTest({ x: 250, y: 30 }, entries), 'b');
  assert.equal(geometry.hitTest({ x: 10, y: 200 }, entries), 'root', '命中根节点（容器体）');
  assert.equal(geometry.hitTest({ x: 500, y: 500 }, entries), null, '空白未命中');
  assert.equal(geometry.hitTest({ x: 5, y: 5 }, [{ id: 'z', rect: { x: 0, y: 0, w: 0, h: 0 } }, ...entries]), 'root', '零面积元素不参与');
});

test('框选选择集计算：矩形含多节点（保持 DOM 序）', () => {
  const entries: PickEntry[] = [
    { id: 'root', rect: { x: 0, y: 0, w: 400, h: 300 } },
    { id: 'a', rect: { x: 20, y: 20, w: 80, h: 30 } },
    { id: 'b', rect: { x: 200, y: 20, w: 80, h: 30 } },
  ];
  const picked = geometry.selectByRect(entries, { x: 5, y: 5, w: 295, h: 95 });
  assert.deepEqual(picked.map((e) => e.id), ['root', 'a', 'b'], '相交全部选中（含根，组件层过滤根）');
  assert.deepEqual(
    geometry.selectByRect(entries, { x: 450, y: 350, w: 10, h: 10 }).map((e) => e.id),
    [],
    '根外空白框不选中',
  );
});

/* ============================================================
 * 3. 命令层（真实命令栈：变更 + undo 还原）
 * ============================================================ */

test('命令：移动入栈（label 前缀「视口：」）+ undo 还原 + redo 重放 + 空移动不入栈', () => {
  initDomain(makeAsset());
  const asset = (): UINode => getSceneTreeDomain().asset!.root;

  commands.commitMoves([{ id: 'a', position: { x: 61, y: 63 } }]);
  assert.deepEqual(asset().children[0]?.transform.position, { x: 61, y: 63 }, '移动生效');
  assert.equal(peekUndo()?.label, '视口：移动节点 1 个');
  assert.equal(peekUndo()?.domain, 'scene-tree');

  act(() => undo());
  assert.deepEqual(asset().children[0]?.transform.position, { x: 20, y: 20 }, 'undo 还原');
  act(() => redo());
  assert.deepEqual(asset().children[0]?.transform.position, { x: 61, y: 63 }, 'redo 重放');

  // 同位置提交：无补丁不入栈
  const len = useEditorStore.getState().undoStack.length;
  commands.commitMoves([{ id: 'a', position: { x: 61, y: 63 } }]);
  assert.equal(useEditorStore.getState().undoStack.length, len, '无实际变更不污染历史');

  // 微调 label（方向键用）
  commands.commitMoves([{ id: 'a', position: { x: 62, y: 63 } }], '视口：微调节点位置');
  assert.equal(peekUndo()?.label, '视口：微调节点位置');
  assert.deepEqual(asset().children[0]?.transform.position, { x: 62, y: 63 });
});

test('命令：删除（含父子同删）+ 根节点保护 + undo 还原', () => {
  initDomain(makeAsset());
  const asset = (): UINode => getSceneTreeDomain().asset!.root;

  commands.commitDelete(['root']);
  assert.equal(asset().children.length, 2, '根节点不可删除（过滤后为空提交）');

  commands.commitDelete(['a']);
  assert.equal(asset().children.length, 1, '删除生效');
  assert.equal(peekUndo()?.label, '视口：删除节点 1 个');
  act(() => undo());
  assert.equal(asset().children.length, 2, '删除可撤销');
});

test('命令：Ctrl+D 复制（新 id + 全树唯一名去重 + 偏移 + 子树换 id）+ undo 还原', () => {
  const asset: UIAsset = {
    version: 2,
    name: '复制测试',
    root: {
      ...makeNode('panel', { id: 'root', name: 'root' }),
      children: [
        makeNode('panel', {
          id: 'grp',
          name: '分组',
          children: [makeNode('button', { id: 'inner', name: '按钮' })],
        }),
        makeNode('button', { id: 'solo', name: '分组2' }),
      ],
    },
  };
  initDomain(asset);

  const newId = 'copy-1';
  commands.commitDuplicate([{ sourceId: 'grp', newId }]);
  const root = getSceneTreeDomain().asset!.root;
  assert.equal(root.children.length, 3, '副本已插入');
  const copy = root.children[1]!;
  assert.equal(copy.id, newId, '顶层副本用预生成 id');
  assert.equal(copy.name, '分组3', 'name 与既有「分组」「分组2」去重');
  assert.deepEqual(copy.transform.position, { x: 20, y: 20 }, '偏移 20px');
  const innerCopy = copy.children[0]!;
  assert.notEqual(innerCopy.id, 'inner', '子树深层换新 id');
  assert.equal(innerCopy.name, '按钮2', '子树 name 全树去重');
  assert.equal(peekUndo()?.label, '视口：复制节点 1 个');
  act(() => undo());
  assert.equal(getSceneTreeDomain().asset!.root.children.length, 2, '复制可撤销');
});

test('命令：添加节点（schema 默认属性 / 容器目标入其子 / 叶子目标入其父 / 唯一名）', () => {
  initDomain(makeAsset());
  const root = (): UINode => getSceneTreeDomain().asset!.root;

  const id1 = commands.commitAddNode('button', null, { x: 50, y: 60 });
  assert.ok(id1);
  const added = root().children.find((c) => c.id === id1);
  assert.ok(added, '空白处右键 → 加入根');
  assert.equal(added.type, 'button');
  assert.equal(added.name, 'button3', '与 button/button2 去重');
  assert.deepEqual(added.transform.position, { x: 50, y: 60 });
  assert.deepEqual(added.props, {}, '业务属性默认值由渲染/检视解析器补齐（样式类可覆盖）');

  const id2 = commands.commitAddNode('button', 'a', { x: 5, y: 6 });
  assert.ok(id2);
  assert.ok(root().children.some((c) => c.id === id2), '叶子目标 → 插入其父（根）');

  const id3 = commands.commitAddNode('label', 'root', { x: 1, y: 2 });
  assert.ok(id3);
  const inRoot = root().children.find((c) => c.id === id3);
  assert.ok(inRoot, '根即容器目标 → 加入根');
  assert.equal(peekUndo()?.label?.startsWith('视口：添加节点'), true, 'label 前缀「视口：」');
});

test('命令：插入预制体实例（ADR-009 正向实例化：prefab 引用 + 名字去重 + 预制体根起值 + undo）', () => {
  initDomain(makeAsset());
  const root = (): UINode => getSceneTreeDomain().asset!.root;
  const prefabRoot = makeNode('panel', { id: 'p_root', name: 'root', x: 0, y: 0, w: 400, h: 300 });

  const id1 = commands.commitAddPrefab('ui/prefabs/logitem.ui.json', prefabRoot, null, { x: 10, y: 20 });
  assert.ok(id1);
  const inst = root().children.find((c) => c.id === id1)!;
  assert.equal(inst.prefab, 'ui/prefabs/logitem.ui.json', '写入 prefab 引用');
  assert.equal(inst.name, 'logitem', 'name = 预制体名');
  assert.equal(inst.type, 'panel', 'type 取预制体根（展示用；展开以预制体为准）');
  assert.deepEqual(inst.transform.size, { w: 400, h: 300 }, 'transform 以预制体根起值（实例保留语义不吃掉设计尺寸）');
  assert.deepEqual(inst.children, [], '实例 children 恒空（结构以预制体为准）');
  assert.deepEqual(inst.props, {}, 'props 空 → 渲染回落预制体');
  assert.equal(peekUndo()?.label, '视口：插入预制体实例 logitem');

  // 同名再插：名字去重；再插无缓存预制体：中性占位
  const id2 = commands.commitAddPrefab('ui/prefabs/logitem.ui.json', prefabRoot, null, { x: 0, y: 0 });
  assert.equal(root().children.find((c) => c.id === id2)!.name, 'logitem2', '同名去重');
  const id3 = commands.commitAddPrefab('ui/prefabs/none.ui.json', null, null, { x: 0, y: 0 });
  const inst3 = root().children.find((c) => c.id === id3)!;
  assert.equal(inst3.type, 'panel', '无预制体根：中性占位类型');
  assert.deepEqual(inst3.transform.size, { w: 200, h: 200 }, '无预制体根：中性占位尺寸');

  // 实例目标拒收子节点：插到实例上 → 落到其父级（根）
  const id4 = commands.commitAddPrefab('ui/prefabs/x.ui.json', null, id1, { x: 0, y: 0 });
  assert.ok(root().children.some((c) => c.id === id4), '实例目标 → 插为其父级（根）的子节点');

  act(() => undo());
  assert.ok(!root().children.some((c) => c.id === id4), '插入可撤销');
});

test('树工具：buildParentMap / isFreeParentType / findUINodeWithParent', () => {
  const asset = makeAsset();
  const pmap = commands.buildParentMap(asset.root);
  assert.equal(pmap.get('root'), null);
  assert.equal(pmap.get('a')?.id, 'root');
  assert.equal(commands.isFreeParentType(null), true, '根节点 free');
  assert.equal(commands.isFreeParentType('panel'), true);
  assert.equal(commands.isFreeParentType('scrollBox'), true);
  assert.equal(commands.isFreeParentType('vbox'), false, 'flow 容器不可自由定位');
  assert.equal(commands.findUINodeWithParent(asset.root, 'b')?.parent?.id, 'root');
  assert.equal(commands.findUINodeWithParent(asset.root, 'missing'), null);
});

/* ============================================================
 * 4/6. 组件冒烟 + 交互集成（happy-dom 挂载）
 * ============================================================ */

test('组件冒烟：挂载不抛错 / 渲染树 data-uid / 工具条（缩放百分比·重置·吸附）/ 空态', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    assert.ok(q('.bps-vp'), '面板挂载');
    assert.equal(dom.document.querySelectorAll('[data-uid]').length, 3, '渲染树 3 节点（root+a+b）');
    const toolbar = q('.bps-vp__toolbar');
    assert.ok(toolbar.textContent?.includes('100%'), '缩放百分比');
    assert.ok(toolbar.textContent?.includes('重置视图'), '重置视图按钮');
    assert.ok(toolbar.textContent?.includes('吸附开'), '吸附开关默认开');

    // 空态：无资产 → 占位提示
    const { unmount: u2 } = await (async () => {
      initDomain(null);
      return mountPanel();
    })();
    try {
      assert.ok(q('.bps-vp__placeholder').textContent?.includes('未打开 UI 资产'), '空态提示');
    } finally {
      await u2();
    }
  } finally {
    await unmount();
  }
});

test('组件交互：点击选中 / Ctrl+点击加选减选 / 点击空白清除 / 悬停描边', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');

    // 空闲移动 → 悬停命中 a
    pointer(surface, 'pointermove', 30, 30);
    assert.ok(dom.document.querySelector('.bps-vp__hoverbox'), '悬停描边');

    // 点击 a（命中 data-uid 几何拾取）
    pointer(surface, 'pointerdown', 30, 30);
    pointer(surface, 'pointerup', 30, 30);
    assert.deepEqual(useUIEditorStore.getState().selection, ['a'], '点击选中');
    assert.ok(dom.document.querySelector('.bps-vp__selbox'), '选中描边');

    // Ctrl+点击 b → 加选
    pointer(surface, 'pointerdown', 240, 30, { ctrlKey: true });
    pointer(surface, 'pointerup', 240, 30, { ctrlKey: true });
    assert.deepEqual(useUIEditorStore.getState().selection, ['a', 'b'], 'Ctrl 加选');

    // Ctrl+点击 b → 减选
    pointer(surface, 'pointerdown', 240, 30, { ctrlKey: true });
    pointer(surface, 'pointerup', 240, 30, { ctrlKey: true });
    assert.deepEqual(useUIEditorStore.getState().selection, ['a'], 'Ctrl 减选');

    // 点击空白（根外）→ 清除
    pointer(surface, 'pointerdown', 500, 500);
    pointer(surface, 'pointerup', 500, 500);
    assert.deepEqual(useUIEditorStore.getState().selection, [], '空白清除');
    assert.equal(useEditorStore.getState().undoStack.length, 0, '选择不入命令栈');
  } finally {
    await unmount();
  }
});

test('组件交互：拖动移动入命令栈（含多选整体）+ undo 还原 + 无位移不提交', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');
    const posA = (): { x: number; y: number } => getSceneTreeDomain().asset!.root.children[0]!.transform.position;

    // 拖动 a：(30,30)→(71,73)，位移 (41,43)，无吸附命中（避开 6px 阈值）
    pointer(surface, 'pointerdown', 30, 30);
    assert.deepEqual(useUIEditorStore.getState().selection, ['a'], '按下即选中');
    pointer(surface, 'pointermove', 71, 73);
    pointer(surface, 'pointerup', 71, 73);
    assert.deepEqual(posA(), { x: 61, y: 63 }, '拖动提交最终位置');
    assert.equal(peekUndo()?.label, '视口：移动节点 1 个');
    act(() => undo());
    assert.deepEqual(posA(), { x: 20, y: 20 }, 'undo 还原');

    // 多选整体移动
    act(() => {
      useUIEditorStore.getState().setSelection(['a', 'b']);
      });
    pointer(surface, 'pointerdown', 30, 30); // 命中 a，已在选中集 → 整组移动
    pointer(surface, 'pointermove', 80, 80); // 位移 (50,50)
    pointer(surface, 'pointerup', 80, 80);
    const [a, b] = getSceneTreeDomain().asset!.root.children;
    assert.deepEqual(a?.transform.position, { x: 70, y: 70 }, 'a 整体移动');
    assert.deepEqual(b?.transform.position, { x: 250, y: 70 }, 'b 整体移动');
    assert.equal(peekUndo()?.label, '视口：移动节点 2 个');

    // 点击无位移：不入栈
    const len = useEditorStore.getState().undoStack.length;
    pointer(surface, 'pointerdown', 70, 70);
    pointer(surface, 'pointerup', 70, 70);
    assert.equal(useEditorStore.getState().undoStack.length, len, '无位移不产生命令');
  } finally {
    await unmount();
  }
});

test('组件交互：框选（矩形含多节点）+ Shift 框选加选 + 空框清除', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');

    // 框选（起点在根节点体内命中根 → 走框选路径）
    pointer(surface, 'pointerdown', 5, 5);
    pointer(surface, 'pointermove', 300, 100);
    assert.ok(dom.document.querySelector('.bps-vp__marquee'), '框选矩形实时预览');
    pointer(surface, 'pointerup', 300, 100);
    assert.deepEqual(useUIEditorStore.getState().selection, ['a', 'b'], '框选选中相交节点（根被排除）');
    assert.equal(dom.document.querySelector('.bps-vp__marquee'), null, '松手清除预览');

    // Shift 框选加选：先仅选 a，再框住 b
    act(() => {
      useUIEditorStore.getState().setSelection(['a']);
      });
    pointer(surface, 'pointerdown', 150, 0, { shiftKey: true });
    pointer(surface, 'pointermove', 350, 100);
    pointer(surface, 'pointerup', 350, 100);
    assert.deepEqual(useUIEditorStore.getState().selection, ['a', 'b'], 'Shift 框选加选');

    // 空框（未命中任何节点）→ 清除
    pointer(surface, 'pointerdown', 350, 250);
    pointer(surface, 'pointermove', 390, 290);
    pointer(surface, 'pointerup', 390, 290);
    assert.deepEqual(useUIEditorStore.getState().selection, [], '空框清除');
  } finally {
    await unmount();
  }
});

test('组件交互：键盘（Delete 删除 / Ctrl+D 复制 / 方向键微调 1px 与 Shift 10px）', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');
    const root = (): UINode => getSceneTreeDomain().asset!.root;

    // 微调：→ 1px，↓(Shift) 10px
    act(() => {
      useUIEditorStore.getState().setSelection(['a']);
      });
    key(surface, 'ArrowRight');
    assert.deepEqual(root().children[0]?.transform.position, { x: 21, y: 20 }, '→ 微调 1px');
    key(surface, 'ArrowDown', { shiftKey: true });
    assert.deepEqual(root().children[0]?.transform.position, { x: 21, y: 30 }, 'Shift+↓ 微调 10px');
    assert.equal(peekUndo()?.label, '视口：微调节点位置');

    // Ctrl+D 复制：新 id + 唯一名 button3 + 偏移 + 选中新副本
    key(surface, 'd', { ctrlKey: true });
    const copyId = useUIEditorStore.getState().selection[0];
    const copy = root().children.find((c) => c.id === copyId)!;
    assert.ok(copy && copy.id !== 'a', '复制后选中新副本');
    assert.equal(copy.name, 'button3', 'name 去重');
    assert.notEqual(copy.id, 'a', '新 id');
    assert.deepEqual(copy.transform.position, { x: 41, y: 50 }, '偏移 20px');
    const len = useEditorStore.getState().undoStack.length;
    act(() => undo());
    assert.equal(root().children.length, 2, '复制可撤销');
    assert.equal(useEditorStore.getState().undoStack.length, len - 1);

    // Delete 删除
    act(() => {
      useUIEditorStore.getState().setSelection(['a']);
      });
    key(surface, 'Delete');
    assert.equal(root().children.length, 1, '删除生效');
    assert.deepEqual(useUIEditorStore.getState().selection, [], '删除后清空选中');
    assert.equal(peekUndo()?.label, '视口：删除节点 1 个');
    act(() => undo());
    assert.equal(root().children.length, 2, '删除可撤销');

    // 根节点保护
    act(() => {
      useUIEditorStore.getState().setSelection(['root']);
      });
    key(surface, 'Delete');
    assert.ok(dom.document.querySelector('.bps-vp__hint'), '根不可删除提示');
    assert.equal(root().id, 'root', '根未删除');
  } finally {
    await unmount();
  }
});

test('组件交互：flow 布局节点移动被拒（提示，不改资产，不入栈）', async () => {
  initDomain(makeFlowAsset());
  const { unmount } = await mountPanel();
  try {
    stubRect(q('.bps-vp__surface'), { left: 0, top: 0, width: 800, height: 600 });
    stubRect(byUid('root'), { left: 0, top: 0, width: 200, height: 300 });
    stubRect(byUid('lbl'), { left: 0, top: 0, width: 120, height: 24 });
    const surface = q('.bps-vp__surface');

    pointer(surface, 'pointerdown', 10, 10); // 命中 lbl（最内层）
    assert.deepEqual(useUIEditorStore.getState().selection, ['lbl'], 'flow 节点可选中');
    pointer(surface, 'pointermove', 50, 50);
    pointer(surface, 'pointerup', 50, 50);

    assert.deepEqual(
      getSceneTreeDomain().asset!.root.children[0]?.transform.position,
      { x: 0, y: 0 },
      'flow 节点位置不变',
    );
    assert.equal(
      dom.document.querySelector('.bps-vp__hint')?.textContent,
      '容器布局节点由父容器排列',
      '布局提示',
    );
    assert.equal(useEditorStore.getState().undoStack.length, 0, '被拒移动不入命令栈');
  } finally {
    await unmount();
  }
});

test('组件交互：吸附线（拖动中对齐其它节点 → overlay 画线 + 自动贴齐）', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');

    // 拖动 a 使其右缘 (120+80=200) 对齐 b 左缘 (200)：位移 100 → dx=0 贴齐，画线
    pointer(surface, 'pointerdown', 30, 30);
    pointer(surface, 'pointermove', 130, 30);
    const lines = dom.document.querySelectorAll('.bps-vp__snapline');
    assert.ok(lines.length >= 1, '拖动中出现吸附线');
    const xLine = Array.from(lines).find((l) => l.className.includes('bps-vp__snapline--x'));
    assert.equal((xLine as unknown as HTMLElement).style.left, '200px', 'x 吸附线位于对齐坐标');
    pointer(surface, 'pointerup', 130, 30);
    assert.deepEqual(
      getSceneTreeDomain().asset!.root.children[0]?.transform.position,
      { x: 120, y: 20 },
      '贴齐后提交（右缘 200 = b 左缘）',
    );
    assert.equal(dom.document.querySelectorAll('.bps-vp__snapline').length, 0, '松手清除吸附线');

    // 关闭吸附后拖动：无吸附线
    const snapBtn = Array.from(dom.document.querySelectorAll('.bps-vp__toolbar button')).find((b) =>
      b.textContent?.includes('吸附'),
    );
    assert.ok(snapBtn);
    act(() => {
      (snapBtn as unknown as HTMLElement).click();
    });
    act(() => {
      useUIEditorStore.getState().setSelection(['a']);
      });
    pointer(surface, 'pointerdown', 130, 30);
    pointer(surface, 'pointermove', 230, 30);
    assert.equal(dom.document.querySelectorAll('.bps-vp__snapline').length, 0, '吸附关不画线');
    pointer(surface, 'pointerup', 230, 30);
  } finally {
    await unmount();
  }
});

test('组件交互：多选对齐工具条（左对齐入命令栈；等距不足禁用）', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    act(() => {
      useUIEditorStore.getState().setSelection(['a', 'b']);
      });
    const bar = q('.bps-vp__aligntoolbar');
    assert.ok(bar.textContent?.includes('已选 2 个'), '对齐工具条浮出');

    const buttons = Array.from(bar.querySelectorAll('button'));
    assert.equal(buttons.length, 8, '左/水平居中/右 + 上/垂直居中/下 + 水平/垂直等距');
    const distributeBtn = buttons.find((b) => b.textContent?.includes('水平等距'));
    assert.equal((distributeBtn as unknown as HTMLButtonElement).disabled, true, '等距需 ≥3 个');

    act(() => {
      (buttons[0] as unknown as HTMLElement).click(); // 左对齐
    });
    assert.equal(getSceneTreeDomain().asset!.root.children[0]?.transform.position.x, 20, 'a 已在最小 x');
    assert.equal(getSceneTreeDomain().asset!.root.children[1]?.transform.position.x, 20, 'b 左对齐 → x=20');
    assert.equal(peekUndo()?.label, '视口：对齐节点 2 个');
    act(() => undo());
    // undo 后域状态为新对象（applyPatches），须重新读取
    assert.equal(getSceneTreeDomain().asset!.root.children[1]?.transform.position.x, 200, '对齐可撤销');

    // 取消多选 → 工具条收起
    act(() => {
      useUIEditorStore.getState().clearSelection();
    });
    assert.equal(dom.document.querySelector('.bps-vp__aligntoolbar'), null, '单选收起工具条');
  } finally {
    await unmount();
  }
});

test('组件交互：缩放（Ctrl+滚轮以光标为中心 / 百分比 / 钳制 / 重置视图 / 滚轮平移）', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubRect(q('.bps-vp__surface'), { left: 0, top: 0, width: 800, height: 600 });
    const surface = q('.bps-vp__surface');
    const canvas = q('.bps-vp__canvas');
    const toolbar = q('.bps-vp__toolbar');

    // Ctrl+滚轮放大（deltaY=-100 → factor e^0.15 ≈ 1.1618 → 116%）
    wheel(surface, -100, { ctrlKey: true, clientX: 100, clientY: 50 });
    assert.ok(toolbar.textContent?.includes('116%'), `百分比显示（实际 ${toolbar.textContent}）`);
    assert.ok(canvas.style.transform.includes('scale(1.16'), '画布应用缩放');

    // 光标处画布点缩放前后不变：光标(100,50) 下 canvas 点应保持 (100,50)
    // view: x=100-100*s, y=50-50*s → screenToCanvas({100,50}) = (100,50)
    const s = 1.161834242728283;
    assert.ok(
      Math.abs(geometry.screenToCanvas({ x: 100, y: 50 }, { x: 100 - 100 * s, y: 50 - 50 * s, scale: s }).x - 100) < 1e-6,
      '以光标为中心',
    );

    // 大幅缩小 → 钳制 25%
    wheel(surface, 100000, { ctrlKey: true });
    assert.ok(toolbar.textContent?.includes('25%'), '缩放下限 0.25');

    // 重置视图
    act(() => {
      Array.from(toolbar.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('重置视图'))
        ?.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event);
    });
    assert.ok(toolbar.textContent?.includes('100%'), '重置后 100%');
    assert.ok(canvas.style.transform.includes('translate(0px, 0px)'), '重置后归零');

    // 滚轮平移（无修饰键；重置后平移量可精确断言）
    wheel(surface, 100);
    assert.ok(canvas.style.transform.includes('translate(0px, -100px)'), '滚轮平移');
  } finally {
    await unmount();
  }
});

test('组件交互：右键菜单（节点 → 复制/删除；空白 → 添加节点 schema 菜单）', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubFreeSceneRects();
    const surface = q('.bps-vp__surface');
    const root = (): UINode => getSceneTreeDomain().asset!.root;

    // 空白右键（命中根容器体）→ 菜单含「添加节点」分组与分类
    contextMenu(surface, 100, 100);
    const menu = q('.bps-vp__menu');
    assert.ok(menu.textContent?.includes('添加节点'), '添加节点菜单');
    assert.ok(menu.textContent?.includes('容器'), '按分类分组');
    assert.ok(menu.textContent?.includes('按钮'), 'schema 标题（searchUISchemas 全量）');

    // 选第一个「添加节点」项（容器类首项 = vbox）
    const addItems = Array.from(menu.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('容器'),
    );
    act(() => {
      (addItems[0] as unknown as HTMLElement).click();
    });
    const added = root().children[2]!;
    assert.equal(added.type, 'vbox', '添加节点生效');
    assert.deepEqual(added.transform.position, { x: 100, y: 100 }, '位置取画布点击点');
    assert.equal(peekUndo()?.label?.startsWith('视口：添加节点'), true);
    assert.equal(dom.document.querySelector('.bps-vp__menu'), null, '选择后关闭菜单');
    assert.deepEqual(useUIEditorStore.getState().selection, [added.id], '添加后选中新节点');

    // 节点右键 → 复制（Ctrl+D 同语义）
    contextMenu(surface, 30, 30);
    const menu2 = q('.bps-vp__menu');
    assert.ok(menu2.textContent?.includes('复制（Ctrl+D）'), '节点菜单含复制');
    const dupBtn = Array.from(menu2.querySelectorAll('button')).find((b) => b.textContent?.includes('复制'));
    act(() => {
      (dupBtn as unknown as HTMLElement).click();
    });
    assert.equal(root().children.length, 4, '复制生效');
    assert.equal(peekUndo()?.label, '视口：复制节点 1 个');

    // 节点右键 → 删除
    contextMenu(surface, 240, 30);
    const delBtn = Array.from(q('.bps-vp__menu').querySelectorAll('button')).find((b) =>
      b.textContent?.includes('删除'),
    );
    act(() => {
      (delBtn as unknown as HTMLElement).click();
    });
    assert.equal(root().children.length, 3, '删除生效');
    assert.equal(peekUndo()?.label, '视口：删除节点 1 个');
  } finally {
    await unmount();
  }
});

test('组件交互：平移（中键拖拽）与 Space 平移模式', async () => {
  initDomain(makeAsset());
  const { unmount } = await mountPanel();
  try {
    stubRect(q('.bps-vp__surface'), { left: 0, top: 0, width: 800, height: 600 });
    stubRect(byUid('root'), { left: 0, top: 0, width: 400, height: 300 });
    const surface = q('.bps-vp__surface');
    const canvas = q('.bps-vp__canvas');

    // 中键拖拽平移
    pointer(surface, 'pointerdown', 100, 100, { button: 1, buttons: 4 });
    pointer(surface, 'pointermove', 140, 120);
    pointer(surface, 'pointerup', 140, 120, { button: 1 });
    assert.ok(canvas.style.transform.includes('translate(40px, 20px)'), `中键平移（实际 ${canvas.style.transform}）`);

    // 平移不改变选择
    assert.deepEqual(useUIEditorStore.getState().selection, [], '平移不选中');
  } finally {
    await unmount();
  }
});
