/**
 * UI DOM 渲染器（T1.2 · PLAN §7.1 / §12）—— 编辑态与运行态共用的唯一渲染真源。
 *
 * 消费方：
 * - T1.3 编辑器 2D 视口：mode='edit'，交互冻结（pointer-events:none + inert + tabindex=-1），
 *   选中 / 悬停 / 变换框由视口在外层叠加；scale 用于视口缩放；
 * - T1.6 运行窗口：mode='runtime'，正常交互，内建事件经 opts.onEvent 上报
 *   （事件名与 schema BuiltInEvent 一致：pressed / toggled / textChanged / submit /
 *   valueChanged / selectedChanged / selectionChanged / doubleClicked …）。
 *
 * 增量更新（updateUI）：按 uid 的 keyed reconcile（lite）——uid 相同且类型不变的节点
 * 复用既有元素就地 patch（引用稳定），子节点按新顺序移动，消失的子节点移除；
 * 结构型内容（list 行 / 树 / 选项）内部再做签名比对，数据不变不重建。
 *
 * 约定：
 * - 根元素 .bps-ui-root；每个节点元素带 data-uid（UINode.id）+ data-node-type（UINode.type）
 *   + data-visible（T1.3 拾取 / 树联动用）；
 * - ADR-005：可编辑属性全部在 UINode.props，UINode.theme 暂不使用；
 * - transform（T1.7）：四种布局语境——
 *   · free（根节点 / panel·scrollBox 内容区）：绝对定位；position 写 left/top（T1.3 包围盒
 *     换算与既有行为锚定于此）；transform 为单属性标准串 `translate(...) rotate(deg)`
 *     （无偏移时省略 translate 段）；w/h 为 0 / 缺省 → 按类型取 schema commonProps 的
 *     defaultSize 补默认（未知类型回落 120×32，与 commonProps 兜底一致）；
 *   · flow（vbox/hbox/grid 内）：position 被容器接管（显式 static），size 0 = 自适应
 *     （flex/grid 基础），expand → flex-grow:1；min-width/min-height:0 保证嵌套容器
 *     尺寸传递不断链（flex 溢出经典问题）；
 *   · fill（tabContainer 页签页）：铺满页体；split（分栏窗格）：比例由 splitContainer
 *     的 postChildren 设置；
 *   · rotation 一律并入 transform 单属性串（rotate(deg)，基点 center，free/flow/fill/split
 *     均生效）；旋转后的选中框 / 命中由 T1.3 的包围盒处理。
 * - anchors（T1.7 简化版锚点）：{ left?, top?, right?, bottom? } ∈ [0,1]，相对 free 语境
 *   父容器尺寸的比例；仅 free 语境生效，渲染期换算为 CSS 百分比（无状态——父容器 resize
 *   天然重排）。left/top 优先于 right/bottom（同轴互斥）；有效锚点接管该轴定位（schema
 *   新建节点的 position 恒为 {0,0} 缺省，若 position 优先锚点将永远无法生效）；
 *   无 anchors → 行为与 T1.2 完全一致（向后兼容）。
 */
import type { UIAsset, UINode, Size2 } from '../../ir/types';
import { getUISchema } from '../../ui-editor/schema';
import { bindNode, clamp, num, type NodeCtx } from './common';
import { rendererFor } from './nodes';
import { ensureRenderStyle } from './style';

/** 渲染事件（onEvent 的载荷；事件名与 src/ui-editor/schema 的 BuiltInEvent 一致） */
export interface UIRenderEvent {
  /** 事件源节点名（UINode.name，ui 访问器查找键） */
  nodeName: string;
  /** 事件源节点类型（UINode.type） */
  nodeType: string;
  /** 内建事件名（如 'pressed'） */
  event: string;
  /** 事件载荷（如 valueChanged 的数值、selectionChanged 的行数据） */
  payload?: unknown;
}

export interface RenderOptions {
  /** 渲染模式：edit = 编辑视口（交互冻结）；runtime = 运行窗口（交互 + 事件上报） */
  mode: 'edit' | 'runtime';
  /** 运行态内建事件回调（编辑态不触发） */
  onEvent?: (evt: UIRenderEvent) => void;
  /** 编辑视口缩放（T1.3 用；作用于 .bps-ui-root 的 scale 变换，默认 1） */
  scale?: number;
}

/** 渲染句柄（renderUI 返回；updateUI / destroy 的凭据） */
export interface UIRenderHandle {
  /** 渲染根元素（.bps-ui-root；调用方自行挂载到目标容器） */
  el: HTMLElement;
  /** 销毁：解除全部事件监听并从 DOM 移除根元素 */
  destroy(): void;
}

interface RenderState {
  opts: RenderOptions;
  rootEl: HTMLElement;
  abort: AbortController;
  ctx: NodeCtx;
}

/** 根元素 → 渲染状态（updateUI / destroy 据此取回内部状态；不污染 handle 公开结构） */
const states = new WeakMap<HTMLElement, RenderState>();

/* ============================================================
 * 布局语义
 * ============================================================ */

/** 子节点布局语义（由父容器类型决定） */
type ChildLayout =
  /** 自由定位：根节点 / panel·scrollBox 内容区（绝对定位） */
  | 'free'
  /** 流式排列：vbox / hbox / grid 子项（忽略 position，expand → flex-grow） */
  | 'flow'
  /** 填充：tabContainer 页签页（铺满页体） */
  | 'fill'
  /** 分栏：splitContainer 窗格（比例在 postChildren 里按 splitPosition 设置） */
  | 'split';

/**
 * 子节点布局语义（由父容器类型决定）。
 * free 判定与 T1.3 视口 isFreeParentType（src/ui-editor/viewport/commands.ts）保持一致：
 * 根（null）/ panel / scrollBox；anchors 亦仅在这三种父容器语境下生效。
 */
function layoutOfParent(parentType: string): ChildLayout {
  switch (parentType) {
    case 'panel':
    case 'scrollBox':
      return 'free';
    case 'vbox':
    case 'hbox':
    case 'grid':
      return 'flow';
    case 'tabContainer':
      return 'fill';
    case 'splitContainer':
      return 'split';
    default:
      return 'flow'; // 未知容器按流式排列（最不意外的降级）
  }
}

/** 公共属性：data-* 标记 + visible（display:none）+ tooltip（title） */
function applyCommon(el: HTMLElement, node: UINode): void {
  el.dataset.uid = node.id;
  el.dataset.nodeType = node.type;
  const visible = node.props?.visible !== false;
  el.dataset.visible = visible ? 'true' : 'false';
  el.style.display = visible ? '' : 'none';
  const tip = node.props?.tooltip;
  if (typeof tip === 'string' && tip) el.setAttribute('title', tip);
  else el.removeAttribute('title');
}

/**
 * 组合标准 transform 字符串（单属性）：固定 `translate(...) rotate(deg)` 顺序，
 * 无值段省略（仅旋转 → 'rotate(15deg)'）。position 经 left/top 表达（见模块头注释），
 * translate 段保留给未来需要的偏移场景；两个值都写时保持该标准顺序，绝不拆成多次赋值。
 */
function composeTransform(tx: number, ty: number, rot: number): string {
  const parts: string[] = [];
  if (tx !== 0 || ty !== 0) parts.push(`translate(${tx}px, ${ty}px)`);
  if (rot !== 0) parts.push(`rotate(${rot}deg)`);
  return parts.join(' ');
}

/**
 * 锚点比例读取（T1.7 简化版锚点）：合法有限数 → 夹取 [0,1]；否则 null（视为未声明）。
 * 宽容解析（数字字符串可用）与非数值降级，与渲染器其它 props 读取策略一致。
 */
function anchorRatio(v: unknown): number | null {
  const n = num(v, Number.NaN);
  return Number.isFinite(n) ? clamp(n, 0, 1) : null;
}

/** 比例 → CSS 百分比（toFixed(6) 清理浮点噪声，如 0.07 → '7%' 而非 7.000000000000001%） */
function pct(r: number): string {
  return `${Number((r * 100).toFixed(6))}%`;
}

/** schema 尺寸默认值形状守卫 */
function isSize2(v: unknown): v is Size2 {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Size2).w === 'number' &&
    typeof (v as Size2).h === 'number'
  );
}

/**
 * free 语境的缺省尺寸（按类型读 schema commonProps 的 size 默认值并缓存）。
 * 未知类型回落 120×32——与 commonProps 无 defaultSize 时的兜底一致。
 */
const sizeDefaultCache = new Map<string, Size2>();
function defaultSizeFor(type: string): Size2 {
  let s = sizeDefaultCache.get(type);
  if (!s) {
    const def = getUISchema(type)?.props.find((p) => p.id === 'size')?.default;
    s = isSize2(def) && def.w > 0 ? { w: def.w, h: def.h } : { w: 120, h: 32 };
    sizeDefaultCache.set(type, s);
  }
  return s;
}

/**
 * 变换应用。先整体重置相关内联样式（节点在 free/flow 容器间移动时无残留），
 * 再按布局语义写入。flow 忽略 position（容器接管）；rotation 在各语境均生效；
 * anchors 仅 free 生效（见模块头注释的简化语义）。
 */
function applyTransform(el: HTMLElement, node: UINode, layout: ChildLayout): void {
  const t = node.transform;
  const x = t?.position?.x ?? 0;
  const y = t?.position?.y ?? 0;
  let w = t?.size?.w ?? 0;
  let h = t?.size?.h ?? 0;
  const rot =
    typeof t?.rotation === 'number' && Number.isFinite(t.rotation) ? t.rotation : 0;
  const an = t?.anchors;
  const st = el.style;
  // —— 重置（防止布局语境切换后残留内联样式；right/bottom 为 T1.7 锚点新增）——
  st.position = '';
  st.left = '';
  st.top = '';
  st.right = '';
  st.bottom = '';
  st.width = '';
  st.height = '';
  st.transform = '';
  st.flexGrow = '';
  st.flexBasis = '';
  st.minWidth = '';
  st.minHeight = '';
  st.overflow = '';
  // —— 按布局写入 ——
  switch (layout) {
    case 'free': {
      st.position = 'absolute';
      // 锚点定位：left/top 优先，right/bottom 次之（同轴互斥），均未声明回落 position 像素。
      // 百分比相对定位父级（panel 内容区 / scrollBox / 根包装层）尺寸，渲染期计算、无状态。
      const al = an ? anchorRatio(an.left) : null;
      const at = an ? anchorRatio(an.top) : null;
      const ar = an ? anchorRatio(an.right) : null;
      const ab = an ? anchorRatio(an.bottom) : null;
      if (al !== null) st.left = pct(al);
      else if (ar !== null) st.right = pct(ar);
      else st.left = `${x}px`;
      if (at !== null) st.top = pct(at);
      else if (ab !== null) st.bottom = pct(ab);
      else st.top = `${y}px`;
      // 尺寸缺省（0 / 缺省）→ 按类型补 schema 默认尺寸（free 语境无容器可依赖，给合理可见尺寸）
      if (!(w > 0)) w = defaultSizeFor(node.type).w;
      if (!(h > 0)) h = defaultSizeFor(node.type).h;
      st.width = `${w}px`;
      st.height = `${h}px`;
      st.transform = composeTransform(0, 0, rot);
      break;
    }
    case 'flow':
      st.position = 'static'; // position 被父容器接管（显式 static，抹掉历史值）
      st.width = w > 0 ? `${w}px` : ''; // size 0 = 自适应（flex/grid 基础 auto）
      st.height = h > 0 ? `${h}px` : '';
      // min 尺寸归零：flex/grid 子项可收缩，嵌套容器尺寸传递不断链（flex 溢出经典问题）
      st.minWidth = '0';
      st.minHeight = '0';
      st.transform = composeTransform(0, 0, rot);
      if (node.props?.expand === true) st.flexGrow = '1';
      break;
    case 'fill':
      st.position = 'absolute';
      st.left = '0px';
      st.top = '0px';
      st.width = '100%';
      st.height = '100%';
      st.minWidth = '0';
      st.minHeight = '0';
      st.transform = composeTransform(0, 0, rot);
      break;
    case 'split':
      st.position = 'static';
      st.minWidth = '0';
      st.minHeight = '0';
      st.overflow = 'hidden';
      st.transform = composeTransform(0, 0, rot); // 窗格旋转与其它语境一致（T1.7 起不再置空）
      break;
  }
}

/* ============================================================
 * keyed reconcile（lite）
 * ============================================================ */

/**
 * 宿主内按 uid 增量重建子节点集合：
 * - uid 相同且类型不变 → 复用元素（patch 就地更新）；
 * - uid 相同但类型变化 → 重建元素；
 * - 新 uid → 创建；消失的 uid → 移除；顺序按 children 数组对齐（仅在需要时搬动 DOM）。
 * 返回与 children 一一对应的元素数组（postChildren 用）。
 */
function reconcileChildren(
  host: HTMLElement,
  children: UINode[],
  parentType: string,
  state: RenderState,
): HTMLElement[] {
  const layout = layoutOfParent(parentType);
  // 现有节点元素索引（宿主内混入的非节点元素一律移除，保持宿主只含渲染节点）
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(host.childNodes)) {
    const el = child as HTMLElement;
    const uid = el.dataset?.uid;
    if (typeof uid === 'string') existing.set(uid, el);
    else host.removeChild(child);
  }

  const kept = new Set<HTMLElement>();
  const ordered: HTMLElement[] = [];
  let cursor: ChildNode | null = null;
  for (const cn of children) {
    let el = existing.get(cn.id);
    if (el && el.dataset.nodeType !== cn.type) {
      el.remove(); // 同 uid 换类型：DOM 骨架不同，重建
      el = undefined;
    }
    if (!el) {
      el = rendererFor(cn.type).create(cn, state.ctx);
      if (state.opts.mode === 'edit') freezeFocus(el);
    }
    // 顺序对齐：cursor 是上一个已就位的兄弟；不在期望位置才搬动
    // 显式标注 ChildNode | null：避免 insertBefore/firstChild 推断环（TS7022）
    const ref: ChildNode | null = cursor ? cursor.nextSibling : host.firstChild;
    if (el !== ref) host.insertBefore(el, ref);
    cursor = el;
    kept.add(el);
    ordered.push(el);
  }
  for (const el of existing.values()) {
    if (!kept.has(el) && el.parentNode === host) host.removeChild(el);
  }

  for (let i = 0; i < ordered.length; i++) {
    patchNodeEl(ordered[i], children[i], layout, state);
  }
  return ordered;
}

/** 单节点就地更新：公共属性 → 变换 → 类型渲染 → 子节点 reconcile → 后处理 */
function patchNodeEl(el: HTMLElement, node: UINode, layout: ChildLayout, state: RenderState): void {
  bindNode(el, node);
  applyCommon(el, node);
  applyTransform(el, node, layout);
  const r = rendererFor(node.type);
  r.patch(el, node, state.ctx);
  if (r.childHost) {
    const host = r.childHost(el);
    const childEls = reconcileChildren(host, node.children ?? [], node.type, state);
    r.postChildren?.(el, node, state.ctx, childEls);
  }
  // 叶子节点（无 childHost 的渲染器）忽略 children——schema 约定叶子 children 为空数组
}

/** 根节点 reconcile：.bps-ui-root 下只保留一个根节点元素（uid+type 相同则复用） */
function reconcileRoot(rootEl: HTMLElement, root: UINode, state: RenderState): void {
  const first = rootEl.firstElementChild as HTMLElement | null;
  let el: HTMLElement | undefined;
  if (first && first.dataset.uid === root.id && first.dataset.nodeType === root.type) {
    el = first;
  } else {
    if (first) first.remove();
    el = rendererFor(root.type).create(root, state.ctx);
    rootEl.appendChild(el);
  }
  patchNodeEl(el, root, 'free', state); // 根节点永远处于自由布局语境
  if (state.opts.mode === 'edit') freezeFocus(el);
}

/* ============================================================
 * 编辑态冻结
 * ============================================================ */

const FOCUSABLE = 'button,input,select,textarea,a[href],[tabindex]';

/** 编辑态冻结焦点链：pointer-events 挡鼠标，tabindex=-1 挡 Tab 键聚焦 */
function freezeFocus(scope: HTMLElement): void {
  if (typeof scope.matches === 'function' && scope.matches(FOCUSABLE)) {
    scope.setAttribute('tabindex', '-1');
  }
  for (const n of Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE))) {
    n.setAttribute('tabindex', '-1');
  }
}

/** 视口缩放（T1.3）：作用于 .bps-ui-root 根包装层，不影响根节点自身的 rotate */
function applyScale(rootEl: HTMLElement, scale: number | undefined): void {
  const s = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
  if (s !== 1) {
    rootEl.style.transform = `scale(${s})`;
    rootEl.style.transformOrigin = '0 0';
  } else {
    rootEl.style.transform = '';
    rootEl.style.transformOrigin = '';
  }
}

/* ============================================================
 * 公开 API
 * ============================================================ */

/**
 * 渲染 UI 资产为 DOM（编辑态 / 运行态共用）。
 * 调用方把返回的 el 挂载到自己的容器（视口画布 / 运行窗口内容区）。
 * 首次调用会向 document.head 注入渲染器结构样式表（幂等，token 引用见 style.ts）。
 */
export function renderUI(asset: UIAsset, opts: RenderOptions): UIRenderHandle {
  const doc = document; // 调用方窗口文档（运行窗口 / 编辑器 / 测试注入的 happy-dom 文档）
  const rootEl = doc.createElement('div');
  rootEl.className = 'bps-ui-root';
  rootEl.dataset.mode = opts.mode;
  if (opts.mode === 'edit') {
    rootEl.classList.add('bps-ui-root--edit');
    rootEl.style.pointerEvents = 'none'; // 内联兜底：宿主样式缺失也能冻结鼠标交互
    rootEl.setAttribute('inert', ''); // 冻结焦点与辅助访问（支持 inert 的环境生效）
  }
  ensureRenderStyle(doc);

  const abort = new AbortController();
  const state: RenderState = {
    opts,
    rootEl,
    abort,
    ctx: {
      mode: opts.mode,
      signal: abort.signal,
      emit: (node, event, payload) => {
        // 编辑态冻结：不上报任何事件（即使测试/脚本直接 dispatchEvent 也不会触发）
        if (state.opts.mode !== 'runtime') return;
        if (payload === undefined) {
          state.opts.onEvent?.({ nodeName: node.name, nodeType: node.type, event });
        } else {
          state.opts.onEvent?.({ nodeName: node.name, nodeType: node.type, event, payload });
        }
      },
    },
  };
  states.set(rootEl, state);

  applyScale(rootEl, opts.scale);
  reconcileRoot(rootEl, asset.root, state);
  if (opts.mode === 'edit') freezeFocus(rootEl);

  return {
    el: rootEl,
    destroy() {
      const s = states.get(rootEl);
      if (!s) return;
      s.abort.abort(); // 解除全部事件监听
      states.delete(rootEl);
      rootEl.remove();
    },
  };
}

/**
 * 增量更新：按 uid 复用 DOM（keyed reconcile lite），props / children 变化就地更新。
 * 已销毁的句柄调用为静默 no-op。scale / mode 等渲染选项沿用 renderUI 时的配置。
 */
export function updateUI(handle: UIRenderHandle, asset: UIAsset): void {
  const state = states.get(handle.el);
  if (!state) return;
  applyScale(state.rootEl, state.opts.scale);
  reconcileRoot(state.rootEl, asset.root, state);
  if (state.opts.mode === 'edit') freezeFocus(state.rootEl);
}
