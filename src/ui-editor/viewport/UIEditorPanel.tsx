/**
 * 2D 视口面板（T1.3 · PLAN §7.2）
 *
 * 结构：UIEditorPanel = 画布区（surface > canvas[transform] > renderUI 的 el + overlay）+
 * 浮动工具条（缩放百分比 / 重置视图 / 吸附开关）+ 多选对齐工具条 + 右键菜单 + 提示。
 *
 * - 渲染：renderUI(asset, { mode: 'edit' }) 挂在 canvas 包装层内；缩放/平移由包装层
 *   transform: translate+scale 承担（不用 renderUI 的 scale 参数——缩放不必重放整棵树，
 *   且 node 包围盒换算回画布坐标后与缩放无关）。渲染器编辑态 pointer-events:none，
 *   命中 / 悬停 / 框选一律由本组件在事件层做几何拾取（data-uid 委托）。
 * - 坐标：画布坐标 = UI 根节点坐标系。screen → canvas = (screen - origin - pan) / scale，
 *   全部经 geometry.ts 纯函数；节点包围盒由 DOM getBoundingClientRect 换算回画布坐标。
 * - 命令：移动 / 微调 / 删除 / 复制 / 对齐 / 添加节点全部经 commands.ts 入统一命令栈
 *   （label 前缀「视口：」），可撤销；拖动为一次手势一条命令（拖动中仅 DOM 预览）。
 * - 键盘：画布级监听挂在本面板（tabIndex=0，聚焦生效），不注册全局 keymap，
 *   避免与蓝图 / 脚本编辑器冲突（Ctrl+D 未注册全局，无冲突检测需求）。
 *
 * 工作区接线（PM）：
 *   await useUIEditorStore.getState().openUIAsset(project.path, 'ui/main.ui.json');
 *   <UIEditorPanel />
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UIAsset, UINode, Vec2 } from '../../ir/types';
import { renderUI, updateUI, type UIRenderHandle } from '../../runtime/render/render';
import { NODE_CATEGORIES, searchUISchemas, type UINodeSchema } from '../schema';
import { collectPrefabPaths, getCachedPrefab, prefabLabelOf, primePrefabCache } from '../prefab';
import { findUINode, newUINodeId, useSceneTreeDomain, useUIEditorStore } from '../store';
import {
  buildParentMap,
  commitAddNode,
  commitAddPrefab,
  commitDelete,
  commitDuplicate,
  commitMoves,
  isNodeFreelyPositionable,
  readNodePosition,
  resolveAddParent,
  type NodeMove,
} from './commands';
import {
  clientRectToCanvas,
  computeAlignment,
  hitTest,
  MAX_SCALE,
  MIN_SCALE,
  normalizeRect,
  offsetRect,
  resolveSnap,
  screenToCanvas,
  selectByRect,
  SNAP_THRESHOLD,
  unionRects,
  zoomAt,
  type PickEntry,
  type Rect,
  type SnapLine,
  type ViewAlignMode,
  type ViewTransform,
} from './geometry';
import { ensureViewportStyle } from './style';

/** 拖动位移死区（画布 px；低于该值视为点击） */
const DRAG_DEAD_ZONE = 2;

/** 框选激活死区（画布 px） */
const MARQUEE_DEAD_ZONE = 3;

/** 拖动状态（window 级监听句柄 + 手势数据） */
interface DragState {
  kind: 'pan' | 'marquee' | 'move';
  ac: AbortController;
}

/** 右键菜单状态（screen = surface 内坐标；canvas = 画布坐标；targetId = 命中节点） */
interface CanvasMenuState {
  screen: Vec2;
  canvas: Vec2;
  targetId: string | null;
}

/** 视口提示（at 用于同一文案重复提示时重启自动消失计时） */
interface HintState {
  text: string;
  at: number;
}

/** 对齐工具条动作清单（分布需 ≥ 3 个可自由定位节点） */
const ALIGN_ACTIONS: Array<{ mode: ViewAlignMode; label: string; title: string; min: number }> = [
  { mode: 'left', label: '⇤ 左对齐', title: '左对齐', min: 2 },
  { mode: 'hcenter', label: '⇔ 水平居中', title: '水平居中对齐', min: 2 },
  { mode: 'right', label: '⇥ 右对齐', title: '右对齐', min: 2 },
  { mode: 'top', label: '⇧ 顶对齐', title: '顶对齐', min: 2 },
  { mode: 'vcenter', label: '⇕ 垂直居中', title: '垂直居中对齐', min: 2 },
  { mode: 'bottom', label: '⇩ 底对齐', title: '底对齐', min: 2 },
  { mode: 'distribute-h', label: '↔ 水平等距', title: '水平等距分布', min: 3 },
  { mode: 'distribute-v', label: '↕ 垂直等距', title: '垂直等距分布', min: 3 },
];

/** Flow 布局提示文案（移动被拒） */
const FLOW_HINT = '容器布局节点由父容器排列';

/* ============================================================
 * DOM 量测（编辑态渲染树 → 画布坐标包围盒）
 * ============================================================ */

/**
 * 量测画布内全部节点包围盒（按 DOM 前序遍历序 = 命中测试所需的层叠序）。
 * 可见性 data-visible=false 与零面积元素（display:none / 未量出）跳过。
 */
function measureCanvasBoxes(
  surface: HTMLElement,
  canvas: HTMLElement,
  view: ViewTransform,
): PickEntry[] {
  const rect = surface.getBoundingClientRect();
  const origin: Vec2 = { x: rect.left, y: rect.top };
  const out: PickEntry[] = [];
  const els = canvas.querySelectorAll<HTMLElement>('[data-uid]');
  for (const el of els) {
    if (el.dataset.visible === 'false') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    out.push({
      id: el.dataset.uid as string,
      rect: clientRectToCanvas(r, view, origin),
    });
  }
  return out;
}

/** 覆盖层盒子的定位样式（画布坐标） */
function rectStyle(r: Rect): Record<string, string> {
  return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` };
}

/* ============================================================
 * 组件
 * ============================================================ */

export function UIEditorPanel() {
  /* —— 共享 store（契约见 src/ui-editor/store.ts）—— */
  const { asset } = useSceneTreeDomain();
  const selection = useUIEditorStore((s) => s.selection);
  const status = useUIEditorStore((s) => s.status);
  const message = useUIEditorStore((s) => s.message);
  const setSelection = useUIEditorStore((s) => s.setSelection);
  const addSelection = useUIEditorStore((s) => s.addSelection);
  const clearSelection = useUIEditorStore((s) => s.clearSelection);
  /** v3 T11.1：已应用样式表（变化时重建渲染句柄以刷新合并结果） */
  const styleSheets = useUIEditorStore((s) => s.styleSheets);
  const stylesRef = useRef(styleSheets);

  /* —— 视口状态 —— */
  const [view, setView] = useState<ViewTransform>({ x: 0, y: 0, scale: 1 });
  const [snapOn, setSnapOn] = useState(true);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [hint, setHint] = useState<HintState | null>(null);
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dragKind, setDragKind] = useState<DragState['kind'] | null>(null);
  const [boxes, setBoxes] = useState<PickEntry[]>([]);
  // 预制体补拉计数（T7.3 · ADR-009）：渲染期异步补拉成功的占位刷新信号
  const [prefabTick, setPrefabTick] = useState(0);

  /* —— refs（事件处理器内取最新值）—— */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<UIRenderHandle | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const snapOnRef = useRef(snapOn);
  snapOnRef.current = snapOn;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const assetRef = useRef(asset);
  assetRef.current = asset;
  const spaceRef = useRef(spaceHeld);
  spaceRef.current = spaceHeld;

  /** 量测当前画布节点包围盒（事件时点实时量测，保证命中/框选准确） */
  const measure = useCallback((): PickEntry[] => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    if (!surface || !canvas || !assetRef.current) return [];
    return measureCanvasBoxes(surface, canvas, viewRef.current);
  }, []);

  const showHint = useCallback((text: string): void => {
    setHint({ text, at: Date.now() });
  }, []);

  const closeMenu = useCallback((): void => setMenu(null), []);

  /* —— 样式注入 + 挂载聚焦（Delete 等画布级快捷键立即可用）—— */
  useEffect(() => {
    ensureViewportStyle(document);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /* —— 渲染同步：资产变化（或预制体补拉完成）→ renderUI / updateUI —— */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!asset) {
      handleRef.current?.destroy();
      handleRef.current = null;
      setBoxes([]);
      return;
    }
    // 样式表变化 → 重建句柄（RenderOptions 不可变，updateUI 不会重新读样式）
    if (handleRef.current && stylesRef.current !== styleSheets) {
      handleRef.current.destroy();
      handleRef.current = null;
      stylesRef.current = styleSheets;
    }
    if (!handleRef.current) {
      // onPrefabLoad（ADR-009）：渲染期补拉成功的占位刷新——bump prefabTick 让本 effect
      // 重跑（updateUI 增量更新；回调存于渲染 state，updateUI 沿用同一回调）。
      const h = renderUI(asset, {
        mode: 'edit',
        onPrefabLoad: () => setPrefabTick((t) => t + 1),
        styles: styleSheets,
      });
      handleRef.current = h;
      canvas.insertBefore(h.el, canvas.firstChild); // 渲染层在下，overlay 在上
    } else {
      updateUI(handleRef.current, asset);
    }
    if (!dragRef.current || dragRef.current.kind !== 'move') {
      // 清除拖拽预览残留（translate 为纯视觉层，不进资产）
      for (const el of canvas.querySelectorAll<HTMLElement>('[data-uid]')) {
        el.style.removeProperty('translate');
      }
    }
    setBoxes(measure());
  }, [asset, measure, prefabTick, styleSheets]);

  /* —— 卸载清理 —— */
  useEffect(
    () => () => {
      dragRef.current?.ac.abort();
      dragRef.current = null;
      handleRef.current?.destroy();
      handleRef.current = null;
    },
    [],
  );

  /* —— Space 抬起（面板失焦也要复位平移模式）—— */
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === ' ') setSpaceHeld(false);
    };
    const onBlur = (): void => setSpaceHeld(false);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /* —— 滚轮：Ctrl+滚轮以光标为中心缩放（0.25~4）；滚轮平移 —— */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = surface.getBoundingClientRect();
      const pt: Vec2 = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        setView((v) => zoomAt(pt, v, Math.exp(-e.deltaY * 0.0015)));
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, []);

  /* —— 提示自动消失 —— */
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), 2600);
    return () => window.clearTimeout(timer);
  }, [hint?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  /* —— 选集中的可自由定位节点（对齐工具条 / 移动资格）—— */
  const movableSelected = useMemo(() => {
    if (!asset) return [] as string[];
    const pmap = buildParentMap(asset.root);
    return selection.filter((id) => {
      const parent = pmap.get(id);
      if (parent === undefined) return false;
      const node = findUINode(asset.root, id);
      return node ? isNodeFreelyPositionable(node, parent) : false;
    });
  }, [asset, selection]);

  const hoverBox = useMemo(
    () => (hoverId && !selection.includes(hoverId) ? boxes.find((b) => b.id === hoverId) : undefined),
    [boxes, hoverId, selection],
  );
  const selectedBoxes = useMemo(
    () => boxes.filter((b) => selection.includes(b.id)),
    [boxes, selection],
  );

  /* ============================================================
   * 指针交互（命中 / 框选 / 移动 / 平移；渲染器 pointer-events:none，几何拾取）
   * ============================================================ */

  /** 事件 → surface 内屏幕坐标 */
  const screenOf = (e: { clientX: number; clientY: number }): Vec2 => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  /** 事件 → 画布坐标 */
  const canvasOf = (e: { clientX: number; clientY: number }): Vec2 => {
    return screenToCanvas(screenOf(e), viewRef.current);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (dragRef.current || !assetRef.current) return;
    const pt = canvasOf(e);
    const live = measure();
    setHoverId(hitTest(pt, live));
    setBoxes(live); // 悬停/选中覆盖层与实时几何保持一致（画布坐标，与缩放无关）
  };

  const onPointerLeave = (): void => setHoverId(null);

  /** 开始平移（中键 / 空格+左键拖拽；screen 为按下时 surface 内坐标） */
  const startPan = (screen: Vec2): void => {
    const startPanValue = { x: viewRef.current.x, y: viewRef.current.y };
    const ac = new AbortController();
    dragRef.current = { kind: 'pan', ac };
    setDragKind('pan');
    // 拖拽监听挂 document（松开在面板外也能结束手势）
    document.addEventListener(
      'pointermove',
      (ev) => {
        const rect = surfaceRef.current?.getBoundingClientRect();
        const dx = ev.clientX - (rect?.left ?? 0) - screen.x;
        const dy = ev.clientY - (rect?.top ?? 0) - screen.y;
        setView((v) => ({ ...v, x: startPanValue.x + dx, y: startPanValue.y + dy }));
      },
      { signal: ac.signal },
    );
    const finish = (): void => {
      ac.abort();
      dragRef.current = null;
      setDragKind(null);
    };
    document.addEventListener('pointerup', finish, { signal: ac.signal });
    document.addEventListener('pointercancel', finish, { signal: ac.signal });
  };

  /** 开始拖动移动（ids = 本次手势要移动的节点；free 型生效，flow 型提示被拒） */
  const startMoveDrag = (start: Vec2, liveBoxes: PickEntry[], ids: string[]): void => {
    const assetNow = assetRef.current;
    const canvas = canvasRef.current;
    if (!assetNow || !canvas) return;
    const pmap = buildParentMap(assetNow.root);
    const movableIds: string[] = [];
    let flowCount = 0;
    for (const id of ids) {
      const parent = pmap.get(id);
      if (parent === undefined) continue;
      const node = findUINode(assetNow.root, id);
      if (node && isNodeFreelyPositionable(node, parent)) movableIds.push(id);
      else flowCount++;
    }
    const boxOf = new Map(liveBoxes.map((b) => [b.id, b.rect]));
    const others = liveBoxes.filter((b) => !ids.includes(b.id)).map((b) => b.rect);
    const items = movableIds.flatMap((id) => {
      const box = boxOf.get(id);
      const node = findUINode(assetNow.root, id);
      const el = canvas.querySelector<HTMLElement>(`[data-uid="${id}"]`);
      if (!box || !node || !el) return [];
      return [{ id, el, box, startPos: readNodePosition(node) }];
    });
    if (items.length === 0 && flowCount === 0) return;

    const ac = new AbortController();
    dragRef.current = { kind: 'move', ac };
    setDragKind('move');
    const gesture = { moved: false, dx: 0, dy: 0 };

    document.addEventListener(
      'pointermove',
      (ev) => {
        const pt = canvasOf(ev);
        const rawDx = pt.x - start.x;
        const rawDy = pt.y - start.y;
        if (!gesture.moved && Math.abs(rawDx) < DRAG_DEAD_ZONE && Math.abs(rawDy) < DRAG_DEAD_ZONE) {
          return;
        }
        gesture.moved = true;
        let dx = rawDx;
        let dy = rawDy;
        const lines: SnapLine[] = [];
        if (snapOnRef.current && items.length > 0) {
          const movingUnion = unionRects(items.map((it) => offsetRect(it.box, dx, dy)));
          if (movingUnion) {
            const snap = resolveSnap(movingUnion, others, SNAP_THRESHOLD);
            dx += snap.dx;
            dy += snap.dy;
            lines.push(...snap.lines);
          }
        }
        gesture.dx = dx;
        gesture.dy = dy;
        setSnapLines(lines);
        if (flowCount > 0) showHint(FLOW_HINT);
        for (const it of items) {
          it.el.style.setProperty('translate', `${dx}px ${dy}px`);
        }
      },
      { signal: ac.signal },
    );
    const finish = (commit: boolean): void => {
      ac.abort();
      for (const it of items) it.el.style.removeProperty('translate');
      setSnapLines([]);
      dragRef.current = null;
      setDragKind(null);
      if (!commit || !gesture.moved || items.length === 0) return;
      commitMoves(
        items.map((it) => ({
          id: it.id,
          position: { x: it.startPos.x + gesture.dx, y: it.startPos.y + gesture.dy },
        })),
      );
    };
    document.addEventListener('pointerup', () => finish(true), { signal: ac.signal });
    document.addEventListener('pointercancel', () => finish(false), { signal: ac.signal });
  };

  /** 开始框选（空白处左键拖；Shift 框选加选；命中根节点也走框选——根不可拖体移动） */
  const startMarqueeDrag = (start: Vec2, additive: boolean): void => {
    const ac = new AbortController();
    dragRef.current = { kind: 'marquee', ac };
    setDragKind('marquee');
    const gesture = { active: false, rect: null as Rect | null };
    document.addEventListener(
      'pointermove',
      (ev) => {
        const pt = canvasOf(ev);
        if (!gesture.active && Math.abs(pt.x - start.x) < MARQUEE_DEAD_ZONE && Math.abs(pt.y - start.y) < MARQUEE_DEAD_ZONE) {
          return;
        }
        gesture.active = true;
        gesture.rect = normalizeRect(start, pt);
        setMarquee(gesture.rect);
      },
      { signal: ac.signal },
    );
    const finish = (): void => {
      ac.abort();
      dragRef.current = null;
      setDragKind(null);
      setMarquee(null);
      if (!gesture.active || !gesture.rect) {
        if (!additive) clearSelection();
        return;
      }
      const live = measure();
      const rootId = assetRef.current?.root.id;
      const ids = selectByRect(live, gesture.rect)
        .map((b) => b.id)
        .filter((id) => id !== rootId); // 根节点不参与框选（点击可选中根）
      if (ids.length === 0) {
        if (!additive) clearSelection();
        return;
      }
      if (additive) addSelection(ids);
      else setSelection(ids);
    };
    document.addEventListener('pointerup', finish, { signal: ac.signal });
    document.addEventListener('pointercancel', finish, { signal: ac.signal });
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    closeMenu();
    const surface = surfaceRef.current;
    if (!surface) return;
    rootRef.current?.focus({ preventScroll: true });
    if (!assetRef.current) return;

    // 中键 / 空格+左键 → 平移
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      e.preventDefault();
      startPan(screenOf(e));
      return;
    }
    if (e.button !== 0) return;

    const pt = canvasOf(e);
    const live = measure();
    const hit = hitTest(pt, live);
    if (hit) {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+点击：加选 / 减选（不启动拖动）
        const sel = selectionRef.current;
        setSelection(sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit]);
        return;
      }
      if (hit === assetRef.current.root.id) {
        startMarqueeDrag(pt, e.shiftKey); // 点在根节点体上拖拽 = 框选（根移动走微调/对齐）
        return;
      }
      const sel = selectionRef.current;
      const ids = sel.includes(hit) ? sel : [hit];
      if (!sel.includes(hit)) setSelection([hit]);
      startMoveDrag(pt, live, ids);
      return;
    }
    startMarqueeDrag(pt, e.shiftKey); // 空白处按下：候选框选
  };

  const onContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    if (!assetRef.current) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    refreshPrefabItems(); // 预制体清单异步刷新（晚到由 state 更新补渲染）
    const screen = screenOf(e);
    const pt = screenToCanvas(screen, viewRef.current);
    const live = measure();
    const hit = hitTest(pt, live);
    if (hit && !selectionRef.current.includes(hit)) setSelection([hit]);
    const rect = surface.getBoundingClientRect();
    setMenu({
      screen: {
        x: Math.min(screen.x, Math.max(rect.width - 220, 0)),
        y: Math.min(screen.y, Math.max(rect.height - 320, 0)),
      },
      canvas: pt,
      targetId: hit,
    });
  };

  /* —— 预制体实例插入（T7.3 正向实例化 · ADR-009）—— */

  /** 可插入预制体清单（ui/prefabs/*.ui.json；右键菜单打开时刷新） */
  const [prefabItems, setPrefabItems] = useState<{ path: string; label: string }[]>([]);

  const refreshPrefabItems = useCallback((): void => {
    const projectPath = useUIEditorStore.getState().projectPath;
    if (!projectPath) return;
    void fetch(`/api/tree?path=${encodeURIComponent(`${projectPath}/ui/prefabs`)}`)
      .then((r) => r.json())
      .then((j) => {
        const items: { path: string; label: string }[] = [];
        const walk = (node: unknown): void => {
          if (!node || typeof node !== 'object') return;
          const t = node as { name?: unknown; path?: unknown; type?: unknown; children?: unknown };
          if (
            t.type === 'file' &&
            typeof t.path === 'string' &&
            typeof t.name === 'string' &&
            t.name.toLowerCase().endsWith('.ui.json')
          ) {
            items.push({ path: t.path.slice(projectPath.length + 1), label: prefabLabelOf(t.path) });
            return;
          }
          if (Array.isArray(t.children)) t.children.forEach(walk);
        };
        walk((j as { tree?: unknown }).tree);
        setPrefabItems(items);
      })
      .catch(() => setPrefabItems([]));
  }, []);

  /** 插入预制体实例：守卫自引用 → 取预制体根（缓存优先，未命中回读并预热）→ 入命令栈 */
  const insertPrefabPick = (path: string): void => {
    const assetNow = assetRef.current;
    if (!assetNow || !menu) {
      closeMenu();
      return;
    }
    if (useUIEditorStore.getState().assetPath === path) {
      showHint('预制体不能插入自身（会成环）');
      closeMenu();
      return;
    }
    if (collectPrefabPaths(assetNow.root).includes(path)) {
      showHint('当前 UI 已引用该预制体；嵌套同预制体会成环，已阻止');
      closeMenu();
      return;
    }
    const install = (root: UINode | null): void => {
      const menuNow = menu!;
      const parent = resolveAddParent(assetNow.root, menuNow.targetId);
      const pbox = measure().find((b) => b.id === parent.id)?.rect;
      const local: Vec2 = pbox
        ? { x: menuNow.canvas.x - pbox.x, y: menuNow.canvas.y - pbox.y }
        : menuNow.canvas;
      const id = commitAddPrefab(path, root, menuNow.targetId, local);
      closeMenu();
      if (id) setSelection([id]);
    };
    const cached = getCachedPrefab(path);
    if (cached) {
      install(cached.root);
      return;
    }
    const projectPath = useUIEditorStore.getState().projectPath;
    if (!projectPath) {
      showHint('未打开项目，无法读取预制体');
      closeMenu();
      return;
    }
    void fetch(`/api/file?path=${encodeURIComponent(`${projectPath}/${path}`)}`)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; content?: unknown; message?: string };
        if (!j.ok || typeof j.content !== 'string') throw new Error(j.message ?? `HTTP ${r.status}`);
        const prefabAsset = JSON.parse(j.content) as UIAsset;
        primePrefabCache(path, prefabAsset); // 预热：渲染展开免二次回读
        install(prefabAsset.root);
      })
      .catch((err: unknown) => {
        showHint(`预制体加载失败：${err instanceof Error ? err.message : String(err)}`);
        closeMenu();
      });
  };

  /* ============================================================
   * 键盘（画布级：Delete / Ctrl+D / 方向键微调 / Esc；不注册全局）
   * ============================================================ */

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    if (target?.closest?.('button') && (e.key === 'Enter' || e.key === ' ')) return; // 按钮键盘激活
    if (e.key === ' ') {
      setSpaceHeld(true);
      e.preventDefault(); // 防页面滚动；平移模式由 pointerdown 判断
      return;
    }
    if (e.key === 'Escape') {
      closeMenu();
      setMarquee(null);
      setHoverId(null);
      clearSelection();
      return;
    }
    const assetNow = assetRef.current;
    if (!assetNow) return;
    const ids = selectionRef.current;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const deletable = ids.filter((id) => id !== assetNow.root.id);
      if (deletable.length === 0) {
        if (ids.length > 0) showHint('根节点不可删除');
        return;
      }
      e.preventDefault();
      commitDelete(deletable);
      setSelection([]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      nudge(e.key, e.shiftKey);
    }
  };

  /** 方向键微调：1px；Shift+方向键：10px（每按键一条命令） */
  const nudge = (key: string, big: boolean): void => {
    const assetNow = assetRef.current;
    if (!assetNow) return;
    const step = big ? 10 : 1;
    const d: Vec2 =
      key === 'ArrowLeft'
        ? { x: -step, y: 0 }
        : key === 'ArrowRight'
          ? { x: step, y: 0 }
          : key === 'ArrowUp'
            ? { x: 0, y: -step }
            : { x: 0, y: step };
    const pmap = buildParentMap(assetNow.root);
    const moves: NodeMove[] = [];
    let flowCount = 0;
    for (const id of selectionRef.current) {
      const parent = pmap.get(id);
      if (parent === undefined) continue;
      const node = findUINode(assetNow.root, id);
      if (!node || !isNodeFreelyPositionable(node, parent)) {
        flowCount++;
        continue;
      }
      const cur = readNodePosition(node);
      moves.push({ id, position: { x: cur.x + d.x, y: cur.y + d.y } });
    }
    if (flowCount > 0) showHint(FLOW_HINT);
    if (moves.length > 0) commitMoves(moves, '视口：微调节点位置');
  };

  /** Ctrl+D 复制：偏移 20px、子树全换新 id、全树唯一名去重；复制后选中新副本 */
  const duplicateSelection = (): void => {
    const assetNow = assetRef.current;
    if (!assetNow) return;
    const sel = selectionRef.current.filter((id) => id !== assetNow.root.id);
    const pmap = buildParentMap(assetNow.root);
    const top = sel.filter((id) => {
      let p = pmap.get(id) ?? null;
      while (p) {
        if (sel.includes(p.id)) return false; // 祖先也在选中集：整树复制一次
        p = pmap.get(p.id) ?? null;
      }
      return true;
    });
    if (top.length === 0) {
      showHint('根节点不可复制');
      return;
    }
    const reqs = top.map((sourceId) => ({ sourceId, newId: newUINodeId() }));
    commitDuplicate(reqs);
    setSelection(reqs.map((r) => r.newId));
  };

  /* ============================================================
   * 工具条 / 菜单动作
   * ============================================================ */

  const zoomCenter = (factor: number): void => {
    const surface = surfaceRef.current;
    const rect = surface?.getBoundingClientRect();
    const pt: Vec2 = { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
    setView((v) => zoomAt(pt, v, factor));
  };

  const resetView = (): void => setView({ x: 0, y: 0, scale: 1 });

  /** 对齐 / 分布：仅可自由定位节点参与，结果入命令栈 */
  const onAlign = (mode: ViewAlignMode): void => {
    const assetNow = assetRef.current;
    if (!assetNow) return;
    const live = measure();
    const ids = new Set(movableSelected);
    const entries = live
      .filter((b) => ids.has(b.id))
      .flatMap((b) => {
        const node = findUINode(assetNow.root, b.id);
        if (!node) return [];
        return [{ id: b.id, position: readNodePosition(node), box: b.rect }];
      });
    const result = computeAlignment(entries, mode);
    if (result.size === 0) return;
    commitMoves(
      [...result].map(([id, position]) => ({ id, position })),
      `视口：对齐节点 ${result.size} 个`,
    );
  };

  /** 右键「添加节点」：父级局部坐标 = 画布点击点 - 父包围盒原点 */
  const addPick = (schema: UINodeSchema): void => {
    const assetNow = assetRef.current;
    if (!assetNow || !menu) {
      closeMenu();
      return;
    }
    const parent = resolveAddParent(assetNow.root, menu.targetId);
    const pbox = measure().find((b) => b.id === parent.id)?.rect;
    const local: Vec2 = pbox
      ? { x: menu.canvas.x - pbox.x, y: menu.canvas.y - pbox.y }
      : menu.canvas;
    const id = commitAddNode(schema.type, menu.targetId, local);
    closeMenu();
    if (id) setSelection([id]);
  };

  const menuDuplicate = (): void => {
    if (!menu?.targetId) return;
    const assetNow = assetRef.current;
    if (!assetNow) return;
    if (menu.targetId === assetNow.root.id) {
      showHint('根节点不可复制');
      closeMenu();
      return;
    }
    const reqs = [{ sourceId: menu.targetId, newId: newUINodeId() }];
    commitDuplicate(reqs);
    setSelection(reqs.map((r) => r.newId));
    closeMenu();
  };

  const menuDelete = (): void => {
    if (!menu?.targetId) return;
    const rootId = assetRef.current?.root.id;
    if (menu.targetId === rootId) {
      showHint('根节点不可删除');
      closeMenu();
      return;
    }
    commitDelete([menu.targetId]);
    setSelection([]);
    closeMenu();
  };

  /* —— 右键菜单分组（searchUISchemas('') = 全量，按分类顺序分组）—— */
  const menuGroups = useMemo(() => {
    const all = searchUISchemas('');
    return NODE_CATEGORIES.map((category) => ({
      category,
      items: all.filter((s) => s.category === category),
    })).filter((g) => g.items.length > 0);
  }, []);

  /* ============================================================
   * 渲染
   * ============================================================ */

  const surfaceClass = [
    'bps-vp__surface',
    dragKind === 'pan' ? 'bps-vp__surface--panning' : '',
    dragKind === 'marquee' ? 'bps-vp__surface--marquee' : '',
    dragKind === null && spaceHeld ? 'bps-vp__surface--space' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rootRef}
      className="bps-vp"
      tabIndex={0}
      role="application"
      aria-label="UI 视口"
      onKeyDown={onKeyDown}
    >
      <div
        ref={surfaceRef}
        className={surfaceClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onContextMenu={onContextMenu}
      >
        <div
          ref={canvasRef}
          className="bps-vp__canvas"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {/* renderUI 的 el 由 effect 插入本层之前 */}
          <div className="bps-vp__overlay">
            {selectedBoxes.map((b) => (
              <div key={b.id} className="bps-vp__selbox" style={rectStyle(b.rect)} />
            ))}
            {hoverBox ? <div className="bps-vp__hoverbox" style={rectStyle(hoverBox.rect)} /> : null}
            {marquee ? <div className="bps-vp__marquee" style={rectStyle(marquee)} /> : null}
            {snapLines.map((l, i) => (
              <div
                key={`${l.axis}-${l.at}-${i}`}
                className={`bps-vp__snapline bps-vp__snapline--${l.axis}`}
                style={
                  l.axis === 'x'
                    ? { left: `${l.at}px`, top: `${l.from}px`, height: `${l.to - l.from}px` }
                    : { top: `${l.at}px`, left: `${l.from}px`, width: `${l.to - l.from}px` }
                }
              />
            ))}
          </div>
        </div>
      </div>

      {/* 浮动工具条：缩放百分比 / 重置视图 / 吸附开关 */}
      <div className="bps-vp__toolbar" role="toolbar" aria-label="视口工具条">
        <span className="bps-vp__zoom" title={`缩放（范围 ${Math.round(MIN_SCALE * 100)}%~${Math.round(MAX_SCALE * 100)}%，Ctrl+滚轮以光标为中心）`}>
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" className="bps-vp__btn" title="缩小" onClick={() => zoomCenter(1 / 1.2)}>
          －
        </button>
        <button type="button" className="bps-vp__btn" title="放大" onClick={() => zoomCenter(1.2)}>
          ＋
        </button>
        <button type="button" className="bps-vp__btn" title="重置视图（100%，归零平移）" onClick={resetView}>
          重置视图
        </button>
        <button
          type="button"
          className={`bps-vp__btn${snapOn ? ' bps-vp__btn--on' : ''}`}
          title="拖动时的对齐吸附线开关（阈值 6px）"
          aria-pressed={snapOn}
          onClick={() => setSnapOn((v) => !v)}
        >
          吸附{snapOn ? '开' : '关'}
        </button>
      </div>

      {/* 多选对齐工具条（≥2 个可自由定位节点） */}
      {movableSelected.length >= 2 ? (
        <div className="bps-vp__aligntoolbar" role="toolbar" aria-label="对齐工具条">
          <span>已选 {movableSelected.length} 个</span>
          {ALIGN_ACTIONS.map((a) => (
            <button
              key={a.mode}
              type="button"
              className="bps-vp__btn"
              disabled={movableSelected.length < a.min}
              title={a.title}
              onClick={() => onAlign(a.mode)}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}

      {/* 提示（flow 移动被拒 / 根节点限制） */}
      {hint ? (
        <div className="bps-vp__hint" role="status" key={hint.at}>
          {hint.text}
        </div>
      ) : null}

      {/* 右键菜单：节点 → 复制/删除；空白 → 添加节点（schema 驱动） */}
      {menu ? (
        <div
          className="bps-vp__menu"
          style={{ left: `${menu.screen.x}px`, top: `${menu.screen.y}px` }}
          role="menu"
        >
          {menu.targetId ? (
            <>
              <button type="button" className="bps-vp__menu-item" role="menuitem" onClick={menuDuplicate}>
                复制（Ctrl+D）
              </button>
              <button
                type="button"
                className="bps-vp__menu-item bps-vp__menu-item--danger"
                role="menuitem"
                onClick={menuDelete}
              >
                删除（Delete）
              </button>
            </>
          ) : null}
          <div className="bps-vp__menu-group">添加节点</div>
          {prefabItems.length > 0 ? (
            <div>
              <div className="bps-vp__menu-group">预制体（ui/prefabs/）</div>
              {prefabItems.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  className="bps-vp__menu-item"
                  role="menuitem"
                  title={`插入实例：${p.path}`}
                  onClick={() => insertPrefabPick(p.path)}
                >
                  <span className="bps-vp__menu-icon">⧉</span>
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
          {menuGroups.map((g) => (
            <div key={g.category}>
              <div className="bps-vp__menu-group">{g.category}</div>
              {g.items.map((s) => (
                <button
                  key={s.type}
                  type="button"
                  className="bps-vp__menu-item"
                  role="menuitem"
                  title={s.keywords?.join(' · ')}
                  onClick={() => addPick(s)}
                >
                  <span className="bps-vp__menu-icon">{s.icon ?? '·'}</span>
                  {s.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* 空态 / 错误态 */}
      {!asset ? (
        <div className="bps-vp__placeholder">
          {status === 'loading'
            ? '加载中…'
            : status === 'error'
              ? message || '加载失败'
              : '未打开 UI 资产（在文件系统面板双击 *.ui.json 打开）'}
        </div>
      ) : null}
    </div>
  );
}
