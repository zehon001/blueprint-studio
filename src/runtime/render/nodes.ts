/**
 * 23 种 UI 节点类型的 DOM 构建器注册表（T1.2 · PLAN §7.1 节点库）
 *
 * 结构约定：
 * - create(node, ctx)：一次性构建该节点的持久骨架（含事件监听器，经 ctx.signal 随
 *   destroy() 统一清理；监听器经 nodeOf(el) 读最新节点，不闭包旧 node）；
 * - patch(el, node, ctx)：幂等的就地更新（每次 updateUI 全量重放属性；结构型内容用
 *   签名比对跳过无谓重建）。元素本身绝不替换（保证 uid 相同 → el 引用稳定，T1.3/T1.6 依赖）；
 * - childHost(el)：容器类返回承载子节点的宿主元素（核心 reconcile 引擎据此挂子节点）；
 *   叶子类不声明 → 子节点忽略（schema 约定叶子 children 为空）；
 * - postChildren(el, node, ctx, childEls)：子节点 reconcile 之后的处理
 *   （页签激活态、分栏比例等需要按子序号/子可见性改样式的能力）。
 *
 * 布局语义（schema/containers.ts）：
 * - vbox / hbox / grid：流式容器（子项 position 由容器接管）；
 * - panel / scrollBox：自由容器（子项绝对定位）；
 * - tabContainer：每个直接子节点一个页签页（页标题取子节点 name）；
 * - splitContainer：前两个直接子节点为左右 / 上下窗格（splitPosition 百分比）。
 */
import type { UINode } from '../../ir/types';
import {
  clamp,
  clearChildren,
  div,
  intOf,
  nodeOf,
  num,
  parseStringList,
  px,
  span,
  str,
  type NodeCtx,
} from './common';
import { createListNode, createTableNode, createTreeNode, patchList, patchTable, patchTree } from './dataview';
import { markdownToHtml, sanitizeRichText } from './text';

export interface NodeRenderer {
  create(node: UINode, ctx: NodeCtx): HTMLElement;
  patch(el: HTMLElement, node: UINode, ctx: NodeCtx): void;
  childHost?(el: HTMLElement): HTMLElement;
  postChildren?(el: HTMLElement, node: UINode, ctx: NodeCtx, childEls: HTMLElement[]): void;
}

/** 结构型内容的重建签名（richText / markdown / option 选项等：值不变不重建） */
const contentSig = new WeakMap<HTMLElement, string>();

/** 内容 HTML 就地重建（签名相同跳过） */
function setInnerHtml(el: HTMLElement, html: string): void {
  if (contentSig.get(el) === html) return;
  contentSig.set(el, html);
  el.innerHTML = html;
}

/** 对齐枚举 → CSS align-items（cross 轴对齐，stretch = 拉伸填满） */
const ALIGN_CSS: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/* ============================================================
 * 容器（7 种）
 * ============================================================ */

const vboxRenderer: NodeRenderer = {
  create: () => div('bps-node bps-vbox'),
  patch: (el, node) => {
    el.style.gap = px(num(node.props.spacing, 8));
    el.style.padding = px(num(node.props.padding, 0));
    el.style.alignItems = ALIGN_CSS[str(node.props.align)] ?? 'stretch';
  },
  childHost: (el) => el,
};

const hboxRenderer: NodeRenderer = {
  create: () => div('bps-node bps-hbox'),
  patch: (el, node) => {
    el.style.gap = px(num(node.props.spacing, 8));
    el.style.padding = px(num(node.props.padding, 0));
    el.style.alignItems = ALIGN_CSS[str(node.props.align)] ?? 'stretch';
  },
  childHost: (el) => el,
};

const gridRenderer: NodeRenderer = {
  create: () => div('bps-node bps-grid'),
  patch: (el, node) => {
    // N 列自动换行（minmax(0,1fr) 配合子项 min-width:0 防溢出）；gap 同时承担行列间距；
    // 单元格对齐显式声明双向 stretch（子节点无显式尺寸时填满单元格，显式 w/h 优先）。
    el.style.gridTemplateColumns = `repeat(${intOf(node.props.columns, 2, 1)}, minmax(0,1fr))`;
    el.style.gap = px(num(node.props.spacing, 8));
    el.style.padding = px(num(node.props.padding, 0));
    el.style.justifyItems = 'stretch';
    el.style.alignItems = 'stretch';
  },
  childHost: (el) => el,
};

const panelRenderer: NodeRenderer = {
  create: () => {
    const el = div('bps-node bps-panel');
    el.append(div('bps-panel-title'), div('bps-panel-body'));
    return el;
  },
  patch: (el, node) => {
    const title = el.querySelector<HTMLElement>('.bps-panel-title');
    const body = el.querySelector<HTMLElement>('.bps-panel-body');
    const t = str(node.props.title);
    if (title) {
      title.textContent = t;
      title.style.display = t ? '' : 'none'; // 标题留空 = 不显示标题栏
    }
    if (body) body.style.padding = px(num(node.props.padding, 8));
  },
  childHost: (el) => el.querySelector<HTMLElement>('.bps-panel-body') ?? el,
};

const scrollBoxRenderer: NodeRenderer = {
  create: () => div('bps-node bps-scroll'),
  patch: (el, node) => {
    const dir = str(node.props.direction) || 'vertical';
    el.style.overflowX = dir === 'vertical' ? 'hidden' : 'auto';
    el.style.overflowY = dir === 'horizontal' ? 'hidden' : 'auto';
    el.style.padding = px(num(node.props.padding, 0));
  },
  childHost: (el) => el,
};

/* ── tabContainer：页签条 + 页体（页 = 直接子节点，页标题取子节点 name） ── */

interface TabState {
  /** 上次见到的 props.activeIndex（用于判断「资产写回」应清除本地覆盖） */
  propsActive: number;
  /** 运行态页签点击的本地覆盖值（不回写资产——渲染器不悄悄改数据） */
  override: number | null;
}

const tabStates = new WeakMap<HTMLElement, TabState>();

/** 应用页签激活态：页显示/隐藏 + 页签条重建 */
function updateTabs(el: HTMLElement, node: UINode, childEls: HTMLElement[]): void {
  let st = tabStates.get(el);
  if (!st) {
    st = { propsActive: Number.NaN, override: null };
    tabStates.set(el, st);
  }
  const propsActive = intOf(node.props.activeIndex, 0, 0);
  if (propsActive !== st.propsActive) {
    st.override = null; // 资产侧改了 activeIndex → 本地覆盖失效
    st.propsActive = propsActive;
  }
  const active = Math.min(st.override ?? propsActive, Math.max(0, childEls.length - 1));

  const body = el.querySelector<HTMLElement>('.bps-tabbody');
  if (body) {
    childEls.forEach((page, i) => {
      // 页可见性 = 子节点自身 visible 且为当前激活页（applyCommon 已按 visible 置 display，此处叠加页逻辑）
      const visible = node.children?.[i]?.props?.visible !== false;
      page.style.display = visible && i === active ? '' : 'none';
    });
  }
  const bar = el.querySelector<HTMLElement>('.bps-tabbar');
  if (bar) {
    clearChildren(bar);
    (node.children ?? []).forEach((child, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = i === active ? 'bps-tab bps-tab--active' : 'bps-tab';
      tab.dataset.tabIdx = String(i);
      tab.textContent = child.name || `页 ${i + 1}`;
      bar.appendChild(tab);
    });
  }
}

const tabContainerRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const el = div('bps-node bps-tabs');
    el.append(div('bps-tabbar'), div('bps-tabbody'));
    // 运行态点页签切换当前页（本地覆盖，不触发 onEvent——schema 未定义 tab 内建事件，
    // TODO 事件契约扩展后（T5.2）再补 tabChanged 一类事件）
    el.addEventListener(
      'click',
      (e) => {
        const t = e.target as HTMLElement | null;
        const btn =
          t && typeof t.closest === 'function' ? t.closest<HTMLElement>('.bps-tab') : null;
        if (!btn) return;
        const st = tabStates.get(el);
        const idx = Number(btn.dataset.tabIdx);
        if (!st || !Number.isFinite(idx)) return;
        st.override = idx;
        const body = el.querySelector<HTMLElement>('.bps-tabbody');
        const n = nodeOf(el);
        if (n && body) updateTabs(el, n, Array.from(body.children) as HTMLElement[]);
      },
      { signal: ctx.signal },
    );
    return el;
  },
  patch: () => {
    /* 结构在 postChildren 处理（需要子节点顺序） */
  },
  childHost: (el) => el.querySelector<HTMLElement>('.bps-tabbody') ?? el,
  postChildren: (el, node, _ctx, childEls) => updateTabs(el, node, childEls),
};

const splitContainerRenderer: NodeRenderer = {
  create: () => div('bps-node bps-split'),
  patch: (el, node) => {
    const vertical = str(node.props.direction) === 'vertical';
    el.classList.toggle('bps-split--vertical', vertical);
    el.classList.toggle('bps-split--horizontal', !vertical);
  },
  childHost: (el) => el,
  postChildren: (_el, node, _ctx, childEls) => {
    // 仅前两个子节点为窗格：第一个占 splitPosition%，第二个吃剩余空间；
    // 第二窗格带分隔条类（样式表画 1px 分隔线，见 style.ts；拖动分隔条调节不在本卡范围）。
    const pos = clamp(num(node.props.splitPosition, 50), 0, 100);
    childEls.forEach((pane, i) => {
      if (i === 0) pane.style.flex = `0 0 ${pos}%`;
      else if (i === 1) pane.style.flex = '1 1 0%';
      else pane.style.display = 'none'; // 多余子节点隐藏（schema 约定恰好两个窗格）
      pane.classList.toggle('bps-split-pane--second', i === 1);
      pane.style.minWidth = '0';
      pane.style.minHeight = '0';
      pane.style.overflow = 'hidden';
    });
  },
};

/* ============================================================
 * 显示（6 种）
 * ============================================================ */

const labelRenderer: NodeRenderer = {
  create: () => div('bps-node bps-label'),
  patch: (el, node) => {
    const wrap = node.props.wrap === true;
    el.classList.toggle('bps-label--wrap', wrap);
    el.classList.toggle('bps-label--clip', !wrap);
    el.textContent = str(node.props.text);
  },
};

const richTextRenderer: NodeRenderer = {
  create: () => div('bps-node bps-richtext'),
  patch: (el, node) => {
    // HTML 白名单过滤（script / 事件属性 / 危险 URL），白名单外标签降级纯文本
    setInnerHtml(el, sanitizeRichText(str(node.props.text)));
  },
};

const markdownRenderer: NodeRenderer = {
  create: () => div('bps-node bps-md'),
  patch: (el, node) => {
    // 轻量转换（零依赖）：标题/粗斜删/代码/列表/引用/链接；复杂语法降级纯文本（text.ts TODO）
    setInnerHtml(el, markdownToHtml(str(node.props.text)));
  },
};

const imageRenderer: NodeRenderer = {
  create: () => {
    const img = document.createElement('img');
    img.className = 'bps-node bps-img';
    img.setAttribute('draggable', 'false');
    return img;
  },
  patch: (el, node) => {
    const img = el as HTMLImageElement;
    // 只写 data-src：assetRef 由 T1.6 运行窗口解析为托管 URL；编辑器视口同样按需解析
    img.dataset.src = str(node.props.src);
    img.alt = node.name;
    img.style.objectFit = str(node.props.fit) || 'contain';
  },
};

const separatorRenderer: NodeRenderer = {
  create: () => {
    const hr = document.createElement('hr');
    hr.className = 'bps-node bps-sep';
    return hr;
  },
  patch: (el, node) => {
    // 分割线视觉厚度固定 2px，transform.size 只取长度（宽度/高度其一）
    const vertical = str(node.props.direction) === 'vertical';
    const w = node.transform?.size?.w ?? 0;
    const h = node.transform?.size?.h ?? 0;
    el.classList.toggle('bps-sep--v', vertical);
    el.classList.toggle('bps-sep--h', !vertical);
    if (vertical) {
      el.style.width = '2px';
      el.style.height = h > 0 ? `${h}px` : '100%';
    } else {
      el.style.width = w > 0 ? `${w}px` : '100%';
      el.style.height = '2px';
    }
  },
};

const progressBarRenderer: NodeRenderer = {
  create: () => {
    const el = div('bps-node bps-progress');
    el.append(div('bps-progress-fill'), span('bps-progress-text'));
    return el;
  },
  patch: (el, node) => {
    const fill = el.querySelector<HTMLElement>('.bps-progress-fill');
    const text = el.querySelector<HTMLElement>('.bps-progress-text');
    const min = num(node.props.min, 0);
    const max = num(node.props.max, 100);
    const value = clamp(num(node.props.value, 0), min, max);
    const pct = max > min ? (value - min) / (max - min) : 0;
    if (fill) fill.style.width = `${pct * 100}%`;
    if (text) text.textContent = node.props.showPercent !== false ? `${Math.round(pct * 100)}%` : '';
  },
};

/* ============================================================
 * 输入（7 种）
 * ============================================================ */

const BTN_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;

const buttonRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bps-node bps-btn';
    b.addEventListener(
      'click',
      () => {
        const n = nodeOf(b);
        if (n) ctx.emit(n, 'pressed');
      },
      { signal: ctx.signal },
    );
    return b;
  },
  patch: (el, node) => {
    const variant = str(node.props.variant) || 'primary';
    for (const v of BTN_VARIANTS) el.classList.toggle(`bps-btn--${v}`, v === variant);
    el.textContent = str(node.props.text) || '按钮';
  },
};

/** 控件值回写：焦点中的控件不覆盖（运行态用户正在输入时资产回写让步，失焦后下次 update 应用） */
function setControlValue(ctrl: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (ctrl.value === value) return;
  if (ctrl.ownerDocument?.activeElement === ctrl) return;
  ctrl.value = value;
}

const checkBoxRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const label = document.createElement('label');
    label.className = 'bps-node bps-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = span('bps-check-text');
    label.append(input, text);
    input.addEventListener(
      'change',
      () => {
        const n = nodeOf(label);
        if (n) ctx.emit(n, 'toggled', input.checked);
      },
      { signal: ctx.signal },
    );
    return label;
  },
  patch: (el, node) => {
    const input = el.querySelector<HTMLInputElement>('input');
    const text = el.querySelector<HTMLElement>('.bps-check-text');
    if (input) input.checked = node.props.checked === true;
    if (text) text.textContent = str(node.props.text);
  },
};

const lineEditRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bps-node bps-input';
    input.addEventListener(
      'input',
      () => {
        const n = nodeOf(input);
        if (n) ctx.emit(n, 'textChanged', input.value);
      },
      { signal: ctx.signal },
    );
    input.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          const n = nodeOf(input);
          if (n) ctx.emit(n, 'submit', input.value);
        }
      },
      { signal: ctx.signal },
    );
    return input;
  },
  patch: (el, node) => {
    const input = el as HTMLInputElement;
    input.type = node.props.password === true ? 'password' : 'text'; // 密码模式 = 圆点回显
    const ph = str(node.props.placeholder);
    if (ph) input.setAttribute('placeholder', ph);
    else input.removeAttribute('placeholder');
    input.readOnly = node.props.readOnly === true;
    setControlValue(input, str(node.props.text));
  },
};

const textEditRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const ta = document.createElement('textarea');
    ta.className = 'bps-node bps-input bps-textedit';
    ta.addEventListener(
      'input',
      () => {
        const n = nodeOf(ta);
        if (n) ctx.emit(n, 'textChanged', ta.value);
      },
      { signal: ctx.signal },
    );
    return ta;
  },
  patch: (el, node) => {
    const ta = el as HTMLTextAreaElement;
    const ph = str(node.props.placeholder);
    if (ph) ta.setAttribute('placeholder', ph);
    else ta.removeAttribute('placeholder');
    ta.readOnly = node.props.readOnly === true;
    setControlValue(ta, str(node.props.text));
  },
};

const optSig = new WeakMap<HTMLElement, string>();

const optionButtonRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const sel = document.createElement('select');
    sel.className = 'bps-node bps-input bps-select';
    sel.addEventListener(
      'change',
      () => {
        const n = nodeOf(sel);
        if (n) ctx.emit(n, 'selectedChanged', sel.value);
      },
      { signal: ctx.signal },
    );
    return sel;
  },
  patch: (el, node) => {
    const sel = el as HTMLSelectElement;
    const items = parseStringList(node.props.items);
    const value = str(node.props.value);
    const sig = JSON.stringify(items);
    if (optSig.get(el) !== sig) {
      optSig.set(el, sig);
      clearChildren(sel);
      for (const it of items) {
        const opt = document.createElement('option');
        opt.value = it;
        opt.textContent = it;
        sel.appendChild(opt);
      }
    }
    // 当前值不在选项内时补一个选项，保证 select 能正确回显资产值
    let hasValue = false;
    for (const opt of Array.from(sel.querySelectorAll('option'))) {
      if ((opt as HTMLOptionElement).value === value) {
        hasValue = true;
        break;
      }
    }
    if (value && !items.includes(value) && !hasValue) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      sel.insertBefore(opt, sel.firstChild);
    }
    if (sel.value !== value) sel.value = value;
  },
};

const sliderRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'bps-node bps-slider';
    input.addEventListener(
      'input',
      () => {
        const n = nodeOf(input);
        if (n) ctx.emit(n, 'valueChanged', Number(input.value));
      },
      { signal: ctx.signal },
    );
    return input;
  },
  patch: (el, node) => {
    const input = el as HTMLInputElement;
    input.min = String(num(node.props.min, 0));
    input.max = String(num(node.props.max, 100));
    input.step = String(num(node.props.step, 1));
    const v = String(num(node.props.value, 0));
    if (input.value !== v) input.value = v;
  },
};

const spinBoxRenderer: NodeRenderer = {
  create: (_node, ctx) => {
    const el = div('bps-node bps-spin');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'bps-input';
    const suffix = span('bps-spin-suffix');
    el.append(input, suffix);
    input.addEventListener(
      'input',
      () => {
        const n = nodeOf(el);
        if (n) ctx.emit(n, 'valueChanged', Number(input.value));
      },
      { signal: ctx.signal },
    );
    return el;
  },
  patch: (el, node) => {
    const input = el.querySelector<HTMLInputElement>('input');
    const suffix = el.querySelector<HTMLElement>('.bps-spin-suffix');
    if (!input) return;
    input.min = String(num(node.props.min, 0));
    input.max = String(num(node.props.max, 100));
    input.step = String(num(node.props.step, 1));
    const v = String(num(node.props.value, 0));
    if (input.value !== v) input.value = v;
    if (suffix) suffix.textContent = str(node.props.suffix);
  },
};

/* ============================================================
 * 数据（3 种：list / table / tree，实现在 dataview.ts）
 * ============================================================ */

const listRenderer: NodeRenderer = { create: createListNode, patch: patchList };
const tableRenderer: NodeRenderer = { create: createTableNode, patch: patchTable };
const treeRenderer: NodeRenderer = { create: createTreeNode, patch: patchTree };

/* ============================================================
 * 注册表与兜底
 * ============================================================ */

/** 未知类型兜底：显示占位标签（渲染器对新节点类型永不抛错） */
const unknownRenderer: NodeRenderer = {
  create: () => {
    const el = div('bps-node bps-unknown');
    el.appendChild(span('bps-unknown-tag'));
    return el;
  },
  patch: (el, node) => {
    const tag = el.querySelector<HTMLElement>('.bps-unknown-tag');
    if (tag) tag.textContent = `未知节点：${node.type}`;
  },
};

/** 23 种节点渲染器注册表（键 = UINode.type，与 src/ui-editor/schema 注册表一一对应） */
export const nodeRenderers: Readonly<Record<string, NodeRenderer>> = {
  // 容器
  vbox: vboxRenderer,
  hbox: hboxRenderer,
  grid: gridRenderer,
  panel: panelRenderer,
  scrollBox: scrollBoxRenderer,
  tabContainer: tabContainerRenderer,
  splitContainer: splitContainerRenderer,
  // 显示
  label: labelRenderer,
  richText: richTextRenderer,
  markdown: markdownRenderer,
  image: imageRenderer,
  separator: separatorRenderer,
  progressBar: progressBarRenderer,
  // 输入
  button: buttonRenderer,
  checkBox: checkBoxRenderer,
  lineEdit: lineEditRenderer,
  textEdit: textEditRenderer,
  optionButton: optionButtonRenderer,
  slider: sliderRenderer,
  spinBox: spinBoxRenderer,
  // 数据
  list: listRenderer,
  table: tableRenderer,
  tree: treeRenderer,
};

/** 按类型取渲染器；未注册类型回落兜底渲染器（显示「未知节点」占位） */
export function rendererFor(type: string): NodeRenderer {
  return nodeRenderers[type] ?? unknownRenderer;
}
