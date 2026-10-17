/**
 * 数据类节点渲染（T1.2 · PLAN §7.1 数据 3 种：list / table / tree）
 *
 * list 继承 v1.1 UIRenderer 的亮点设计（见 git show b8f6fca:src/components/UIRenderer.tsx）：
 * - ListColumn 列定义渲染表头 + 行（宽度 px / 其余自动分配，表头行与数据行共用同一
 *   grid-template 保证列对齐）；
 * - colorRules（eq / contains / gt / lt）按序匹配命中即给单元格上「徽标底色」；
 * - groupBy 分组列：值变化新起一个组头（空值继承上一组，全表至多一列生效，该列不进表头/单元格）；
 * - mergeDuplicates 合并列：组内相邻同值行合并为一条并显示 ×N 计数，点击计数徽标可展开
 *   被合并的行（v1.1 语义）。T1.7 起为真视觉合并（rowspan）：有合并列时行体整体网格化，
 *   合并条目的单元格 grid-row:span N 跨行占位、内容垂直居中（结构见 renderListBody，
 *   样式见 style.ts 的 .bps-lbody--grid 区块）；计数徽标 + 点击展开行为保留。
 *
 * 行数据来源：props.items（编辑态 JSON 文本 / 运行态数组，见 common.parseRows）。
 * 全部行内容经 textContent 写入（数据不走 innerHTML，天然免疫注入）；
 * 结构重建以「签名比对」做增量：数据没变不重建 DOM（保滚动位置与选中态）。
 *
 * T7.6 大数据虚拟滚动：行数超过 LIST_VIRTUAL_THRESHOLD（见 src/perf/thresholds.ts，
 * 默认 200）时切换虚拟模式——先把「组头 / 数据行 / 合并块 / 合并展开行」扁平化为
 * 定高槽位计划（plan），body 只放总高占位（position:relative + 显式 height），DOM 仅
 * 挂载可视区 ±LIST_VIRTUAL_BUFFER 行（绝对定位按槽位 top 排布）；滚动事件按 scrollTop
 * 二分求可视窗口增量重建。签名比对仍在全量数据上做（patchList 不变），DOM 只建可视行。
 * ≤ 阈值时走经典全量路径，分组/合并/rowspan 视觉与 T1.2/T1.7 完全一致。
 */
import type { UINode } from '../../ir/types';
import type { ListColumn, UITreeItem } from '../../ui-editor/schema';
import {
  LIST_GROUP_HEIGHT,
  LIST_ROW_HEIGHT,
  LIST_VIRTUAL_BUFFER,
  LIST_VIRTUAL_THRESHOLD,
  LIST_VIRTUAL_VIEWPORT_FALLBACK,
} from '../../perf/thresholds';
import { clearChildren, div, nodeOf, parseRows, px, span, str, type NodeCtx } from './common';

/* ============================================================
 * list（重点：列定义 / 颜色 / 分组 / 合并 / T7.6 虚拟滚动）
 * ============================================================ */

interface ListEntry {
  /** 该合并项首行在 rows 中的全局索引（事件 payload / 选中跟踪用） */
  firstIdx: number;
  /** 被合并的全部行（count = rows.length） */
  rows: Record<string, unknown>[];
}

interface ListGroup {
  key: string;
  entries: ListEntry[];
}

/**
 * T7.6 虚拟滚动的扁平可视计划槽位（展开/折叠后的「视觉行」序列）：
 * - 'group'：组头行（LIST_GROUP_HEIGHT）；
 * - 'row'：普通数据行，或合并块未展开时的整块占位行（高 = 行数 × LIST_ROW_HEIGHT，
 *   内容垂直居中 + ×N 计数徽标，视觉等价 T1.7 rowspan）；
 * - 'merged'：合并块展开后的第 subIdx 行（≥1，虚线样式）。
 */
interface VirtualSlot {
  kind: 'group' | 'row' | 'merged';
  /** 槽顶相对 body 的 y 偏移（px；槽位按生成顺序递增） */
  top: number;
  /** 槽高（px） */
  height: number;
  /** 对应聚合条目（group 槽为 null） */
  entry: ListEntry | null;
  /** merged 展开行在被合并行数组中的下标（其余槽为 0） */
  subIdx: number;
  /** 组头 key（group 槽） */
  groupKey: string;
  /** 合并展开 key（合并块及其首行槽；点击徽标切换展开） */
  mergeKey: string;
  /** 展示计数：group 槽 = 组内条目数；row/merged 槽 = 被合并行数 */
  count: number;
}

interface ListState {
  /** 上次渲染的结构签名（columns + items 原始值），未变化则不重建 DOM */
  sig: string;
  columns: ListColumn[];
  rows: Record<string, unknown>[];
  /** 选中行全局索引（-1 = 未选；数据重建后失效） */
  selected: number;
  /** 折叠的分组 key（组头点击切换） */
  collapsed: Set<string>;
  /** 展开的合并项 key（`组key::合并值`，计数徽标点击切换） */
  expanded: Set<string>;
  /** T7.6：行数超过 LIST_VIRTUAL_THRESHOLD 时为 true（虚拟滚动路径） */
  virtual: boolean;
  /** T7.6：虚拟模式的扁平槽位计划（随数据 / 折叠 / 展开重建；经典路径为空） */
  slots: VirtualSlot[];
  /** T7.6：上次渲染的窗口下标 [winStart, winEnd)（滚动时窗口未变则跳过重建） */
  winStart: number;
  winEnd: number;
}

const listStates = new WeakMap<HTMLElement, ListState>();

/** 列宽 → grid-template-columns（有 width 用 px，其余自动分配剩余宽度） */
function gridTemplate(cols: ListColumn[]): string {
  return cols
    .map((c) => (typeof c.width === 'number' && c.width > 0 ? `${c.width}px` : 'minmax(0,1fr)'))
    .join(' ');
}

/** colorRules 按序匹配；gt/lt 优先数值化比较，失败回落字符串比较（与 v1.1 语义一致的结构化版） */
function matchColorRule(col: ListColumn, text: string): string | null {
  for (const rule of col.colorRules ?? []) {
    switch (rule.op) {
      case 'eq':
        if (text === rule.value) return rule.color;
        break;
      case 'contains':
        if (text.includes(rule.value)) return rule.color;
        break;
      case 'gt': {
        const a = Number(text);
        const b = Number(rule.value);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          if (a > b) return rule.color;
        } else if (text.localeCompare(rule.value) > 0) {
          return rule.color;
        }
        break;
      }
      case 'lt': {
        const a = Number(text);
        const b = Number(rule.value);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          if (a < b) return rule.color;
        } else if (text.localeCompare(rule.value) < 0) {
          return rule.color;
        }
        break;
      }
    }
  }
  return null;
}

/**
 * 徽标文字色：按规则色亮度选深/浅文字。
 * 值走 token（--bg-app 深底 / --text 浅字），不硬编码颜色——规则色本身是 props 数据。
 */
function badgeTextColor(bg: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(bg.trim());
  if (!m) return 'var(--text)';
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 140 ? 'var(--bg-app)' : 'var(--text)';
}

/** 单元格：命中 colorRules 渲染为徽标（底色 = 规则色），否则纯文本 */
function cellEl(col: ListColumn, row: Record<string, unknown>): HTMLSpanElement {
  const cell = span('bps-lcell');
  const text = str(row[col.field]);
  const color = matchColorRule(col, text);
  if (color) {
    const badge = span('bps-lbadge');
    badge.textContent = text;
    badge.style.background = color;
    badge.style.color = badgeTextColor(color);
    cell.appendChild(badge);
  } else {
    cell.textContent = text;
  }
  return cell;
}

/** 分组 + 相邻合并聚合（空组值继承上一组；合并值须非空才参与合并，v1.1 语义）。
 * 无分组列时全表视为单一分组——合并列按「相邻行」独立生效（ListColumn 文档语义，
 * T1.7 修正：此前无分组列时每行各成一组，合并永远不触发）。 */
function aggregateList(
  rows: Record<string, unknown>[],
  groupCol: ListColumn | undefined,
  mergeCol: ListColumn | undefined,
): ListGroup[] {
  const groups: ListGroup[] = [];
  let inherited = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let gkey = groupCol ? str(row[groupCol.field]) : '';
    if (groupCol && !gkey) gkey = inherited;
    else if (groupCol) inherited = gkey;
    let g = groups[groups.length - 1];
    if (!g || (groupCol && g.key !== gkey)) {
      g = { key: gkey, entries: [] };
      groups.push(g);
    }
    const mval = mergeCol ? str(row[mergeCol.field]) : '';
    const last = g.entries[g.entries.length - 1];
    if (mergeCol && mval && last && str(last.rows[0][mergeCol.field]) === mval) {
      last.rows.push(row);
    } else {
      g.entries.push({ firstIdx: i, rows: [row] });
    }
  }
  return groups;
}

/** 槽位计划总高（虚拟模式的 body 占位高度） */
function planHeight(slots: readonly VirtualSlot[]): number {
  const last = slots[slots.length - 1];
  return last ? last.top + last.height : 0;
}

/**
 * T7.6 虚拟滚动的可视窗口计算（纯函数，node:test 直接断言）：
 * 返回与 [scrollTop - bufferPx, scrollTop + viewHeight + bufferPx] 相交的槽位下标区间
 * [start, end)（二分求首个 bottom > viewTop 的槽，再线性扫到首个 top ≥ viewBottom）。
 * 参数取结构化最小面（top/height），便于测试以普通对象构造等价槽位。
 */
export function computeVirtualWindow(
  slots: ReadonlyArray<{ top: number; height: number }>,
  scrollTop: number,
  viewHeight: number,
  bufferPx: number,
): { start: number; end: number } {
  const viewTop = scrollTop - bufferPx;
  const viewBottom = scrollTop + viewHeight + bufferPx;
  let lo = 0;
  let hi = slots.length; // 二分：首个 top+height > viewTop 的槽
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].top + slots[mid].height > viewTop) hi = mid;
    else lo = mid + 1;
  }
  let end = lo;
  while (end < slots.length && slots[end].top < viewBottom) end++;
  return { start: lo, end };
}

/**
 * 由聚合结果构建虚拟槽位计划（折叠 / 展开状态已计入；与经典路径的视觉序列一一对应）：
 * 组头（可折叠）→ 条目（相邻合并块未展开 = 整块一个定高槽；展开 = 首行 + N-1 条 merged 槽）。
 */
function buildVirtualPlan(
  state: ListState,
  groupCol: ListColumn | undefined,
  mergeCol: ListColumn | undefined,
): VirtualSlot[] {
  const slots: VirtualSlot[] = [];
  let top = 0;
  const push = (slot: Omit<VirtualSlot, 'top'>): void => {
    slots.push({ ...slot, top });
    top += slot.height;
  };
  for (const g of aggregateList(state.rows, groupCol, mergeCol)) {
    if (groupCol) {
      push({
        kind: 'group',
        height: LIST_GROUP_HEIGHT,
        entry: null,
        subIdx: 0,
        groupKey: g.key,
        mergeKey: '',
        count: g.entries.length,
      });
      if (state.collapsed.has(g.key)) continue; // 组折叠：跳过行（与经典路径一致）
    }
    for (const entry of g.entries) {
      const mergeKey =
        mergeCol && entry.rows.length > 1 ? `${g.key}::${str(entry.rows[0][mergeCol.field])}` : '';
      if (mergeKey && state.expanded.has(mergeKey)) {
        // 展开的合并块：首行（带徽标）+ 其余被合并行（merged 虚线槽）
        push({ kind: 'row', height: LIST_ROW_HEIGHT, entry, subIdx: 0, groupKey: '', mergeKey, count: entry.rows.length });
        for (let r = 1; r < entry.rows.length; r++) {
          push({ kind: 'merged', height: LIST_ROW_HEIGHT, entry, subIdx: r, groupKey: '', mergeKey, count: entry.rows.length });
        }
      } else {
        // 普通行 / 未展开合并块（整块一个槽，高 = 行数 × 行高，视觉等价 rowspan）
        push({
          kind: 'row',
          height: entry.rows.length > 1 && mergeCol ? entry.rows.length * LIST_ROW_HEIGHT : LIST_ROW_HEIGHT,
          entry,
          subIdx: 0,
          groupKey: '',
          mergeKey,
          count: entry.rows.length,
        });
      }
    }
  }
  return slots;
}

/** 虚拟槽位 → DOM 行（绝对定位按 top 排布；内容写法与经典路径一致，经 textContent） */
function virtualSlotEl(
  state: ListState,
  slot: VirtualSlot,
  visible: ListColumn[],
  tpl: string,
  mergeCol: ListColumn | undefined,
): HTMLElement {
  if (slot.kind === 'group') {
    const gh = div('bps-lgroup');
    gh.style.top = px(slot.top);
    gh.style.height = px(slot.height);
    gh.dataset.gkey = slot.groupKey;
    gh.appendChild(span('bps-lcaret')).textContent = state.collapsed.has(slot.groupKey) ? '▸' : '▾';
    gh.appendChild(span()).textContent = slot.groupKey || '（未分组）';
    gh.appendChild(span('bps-lgmeta')).textContent = `${slot.count} 条`;
    return gh;
  }
  const entry = slot.entry!;
  if (slot.kind === 'merged') {
    // 合并展开行（虚线只读区，与经典路径 .bps-lmerged 内容一致）
    const box = div('bps-lmerged bps-lgrid');
    box.style.gridTemplateColumns = tpl;
    box.style.top = px(slot.top);
    box.style.height = px(slot.height);
    const row = entry.rows[slot.subIdx];
    for (const c of visible) {
      box.appendChild(span('bps-lcell')).textContent = str(row[c.field]);
    }
    return box;
  }
  const rowEl = div('bps-lrow bps-lgrid');
  rowEl.style.gridTemplateColumns = tpl;
  rowEl.style.top = px(slot.top);
  rowEl.style.height = px(slot.height);
  rowEl.dataset.ridx = String(entry.firstIdx);
  if (slot.mergeKey) rowEl.dataset.mergeKey = slot.mergeKey;
  if (state.selected === entry.firstIdx) rowEl.classList.add('bps-lrow--sel');
  const isMergedBlock = entry.rows.length > 1 && mergeCol !== undefined;
  const row = entry.rows[slot.subIdx];
  for (const c of visible) {
    const cell = cellEl(c, row);
    if (isMergedBlock) cell.classList.add('bps-lcell--span');
    if (c === mergeCol && isMergedBlock && slot.subIdx === 0) {
      const badge = span('bps-lcount');
      badge.textContent = `×${entry.rows.length}`;
      badge.title = '点击展开合并的行';
      cell.appendChild(badge);
    }
    rowEl.appendChild(cell);
  }
  return rowEl;
}

/**
 * T7.6：按当前 scrollTop 重算并渲染可视窗口（滚动路径；窗口未变则零开销跳过）。
 * force=true 时先清空 body（数据 / 折叠 / 展开等全量重建后的首次灌装）。
 * clientHeight=0（未布局 / 测试环境）按 LIST_VIRTUAL_VIEWPORT_FALLBACK 兜底估算。
 */
function renderVirtualWindow(el: HTMLElement, state: ListState, force: boolean): void {
  const body = el.querySelector<HTMLElement>('.bps-lbody');
  if (!body || !state.virtual || state.slots.length === 0) return;
  const viewH = el.clientHeight > 0 ? el.clientHeight : LIST_VIRTUAL_VIEWPORT_FALLBACK;
  const { start, end } = computeVirtualWindow(
    state.slots,
    el.scrollTop,
    viewH,
    LIST_VIRTUAL_BUFFER * LIST_ROW_HEIGHT,
  );
  if (!force && start === state.winStart && end === state.winEnd) return;
  state.winStart = start;
  state.winEnd = end;
  const groupCol = state.columns.find((c) => c.groupBy);
  const mergeCol = state.columns.find((c) => c.mergeDuplicates && c !== groupCol);
  const visible = state.columns.filter((c) => c !== groupCol);
  const tpl = gridTemplate(visible);
  clearChildren(body);
  for (let i = start; i < end; i++) {
    body.appendChild(virtualSlotEl(state, state.slots[i], visible, tpl, mergeCol));
  }
}

/** 渲染表头 + 分组行体（全量重建 body/head 内容；数据驱动，经 textContent 写入） */
function renderListBody(el: HTMLElement, state: ListState): void {
  const head = el.querySelector<HTMLElement>('.bps-lhead');
  const body = el.querySelector<HTMLElement>('.bps-lbody');
  if (!head || !body) return;

  const groupCol = state.columns.find((c) => c.groupBy);
  const mergeCol = state.columns.find((c) => c.mergeDuplicates && c !== groupCol);
  const visible = state.columns.filter((c) => c !== groupCol); // groupBy 列不进表头/单元格
  const tpl = gridTemplate(visible);
  // 真视觉合并（T1.7）：有合并列时行体升级为整体网格——行容器降为 display:contents 参与
  // 同一网格，合并条目的单元格 grid-row:span N 跨行占位（视觉 rowspan）；
  // 无合并列保持 T1.2 行级网格（与 table 同款结构）。
  const rowspan = mergeCol !== undefined;

  // 表头（两态共用）
  clearChildren(head);
  if (visible.length) {
    head.style.display = 'grid';
    head.style.gridTemplateColumns = tpl;
    for (const c of visible) {
      const cell = span('bps-lcell');
      cell.textContent = c.title || c.field;
      head.appendChild(cell);
    }
  } else {
    head.style.display = 'none';
  }

  clearChildren(body);
  if (!state.rows.length) {
    // 空数据：退出虚拟态（类 / 占位高复位），渲染等待提示
    state.virtual = false;
    state.slots = [];
    state.winStart = 0;
    state.winEnd = 0;
    body.classList.remove('bps-lbody--grid', 'bps-lbody--virtual');
    body.style.gridTemplateColumns = '';
    body.style.height = '';
    body.appendChild(span('bps-lempty')).textContent = '（等待数据…）';
    return;
  }

  // T7.6 虚拟滚动：行数超阈值 → 只建可视窗口 DOM（body 为总高占位容器）
  state.virtual = state.rows.length > LIST_VIRTUAL_THRESHOLD;
  body.classList.toggle('bps-lbody--virtual', state.virtual);
  if (state.virtual) {
    body.classList.remove('bps-lbody--grid');
    body.style.gridTemplateColumns = '';
    state.slots = buildVirtualPlan(state, groupCol, mergeCol);
    body.style.height = px(planHeight(state.slots));
    renderVirtualWindow(el, state, true);
    return;
  }

  // 经典路径（≤ 阈值）：全量重建（T1.2/T1.7 原行为；退出虚拟态时复位占位高）
  state.slots = [];
  state.winStart = 0;
  state.winEnd = 0;
  body.style.height = '';
  body.classList.toggle('bps-lbody--grid', rowspan);
  if (rowspan) body.style.gridTemplateColumns = tpl;
  else body.style.gridTemplateColumns = '';
  const groups = aggregateList(state.rows, groupCol, mergeCol);
  for (const g of groups) {
    if (groupCol) {
      const gh = div('bps-lgroup');
      gh.dataset.gkey = g.key;
      gh.appendChild(span('bps-lcaret')).textContent = state.collapsed.has(g.key) ? '▸' : '▾';
      gh.appendChild(span()).textContent = g.key || '（未分组）';
      gh.appendChild(span('bps-lgmeta')).textContent = `${g.entries.length} 条`;
      body.appendChild(gh);
      if (state.collapsed.has(g.key)) continue; // 组折叠：跳过行
    }
    for (const entry of g.entries) {
      const rowEl = div('bps-lrow bps-lgrid');
      rowEl.style.gridTemplateColumns = tpl;
      rowEl.dataset.ridx = String(entry.firstIdx);
      const mergeKey =
        mergeCol && entry.rows.length > 1 ? `${g.key}::${str(entry.rows[0][mergeCol.field])}` : '';
      if (mergeKey) rowEl.dataset.mergeKey = mergeKey;
      if (state.selected === entry.firstIdx) rowEl.classList.add('bps-lrow--sel');
      for (const c of visible) {
        const cell = cellEl(c, entry.rows[0]);
        if (rowspan && entry.rows.length > 1) {
          // 跨行合并单元格（T1.7 视觉 rowspan）：span N 占满合并区，内容垂直居中（style.ts）
          cell.classList.add('bps-lcell--span');
          cell.style.gridRow = `span ${entry.rows.length}`;
        }
        if (c === mergeCol && entry.rows.length > 1) {
          const badge = span('bps-lcount');
          badge.textContent = `×${entry.rows.length}`;
          badge.title = '点击展开合并的行';
          cell.appendChild(badge);
        }
        rowEl.appendChild(cell);
      }
      body.appendChild(rowEl);
      // 合并行展开：首行已显示，追加其余被合并行（虚线区，只读）
      if (mergeKey && state.expanded.has(mergeKey)) {
        const box = div('bps-lmerged bps-lgrid');
        box.style.gridTemplateColumns = tpl;
        for (const r of entry.rows.slice(1)) {
          for (const c of visible) {
            box.appendChild(span('bps-lcell')).textContent = str(r[c.field]);
          }
        }
        body.appendChild(box);
      }
    }
  }
}

/** list 容器点击（事件委托，绑定一次，行重建后依然有效） */
function onListClick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = listStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return;

  const count = t.closest('.bps-lcount');
  const rowEl = t.closest('.bps-lrow');
  const group = t.closest('.bps-lgroup');
  if (count && rowEl) {
    // 计数徽标：展开 / 收起被合并的行（不触发事件）
    const key = (rowEl as HTMLElement).dataset.mergeKey ?? '';
    if (!key) return;
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    renderListBody(el, state);
    return;
  }
  if (group) {
    // 组头：折叠 / 展开
    const key = (group as HTMLElement).dataset.gkey ?? '';
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    renderListBody(el, state);
    return;
  }
  if (rowEl) {
    // 行点击：选中 + 上报 selectionChanged（payload = 行数据）
    const idx = Number((rowEl as HTMLElement).dataset.ridx);
    const row = state.rows[idx];
    if (!row) return;
    state.selected = idx;
    renderListBody(el, state);
    ctx.emit(node, 'selectionChanged', row);
  }
}

/** list 双击：上报 doubleClicked（payload = 行数据） */
function onListDblclick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = listStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return;
  const rowEl = t.closest('.bps-lrow');
  if (!rowEl) return;
  const row = state.rows[Number((rowEl as HTMLElement).dataset.ridx)];
  if (row) ctx.emit(node, 'doubleClicked', row);
}

/** list：创建容器骨架 + 事件委托（patch 阶段再灌数据） */
export function createListNode(_node: UINode, ctx: NodeCtx): HTMLElement {
  const el = div('bps-node bps-list');
  const head = div('bps-lhead bps-lgrid');
  const body = div('bps-lbody');
  el.append(head, body);
  el.addEventListener('click', (e) => onListClick(el, e, ctx), { signal: ctx.signal });
  el.addEventListener('dblclick', (e) => onListDblclick(el, e, ctx), { signal: ctx.signal });
  // T7.6 虚拟滚动：滚动容器是 list 根元素（.bps-list overflow:auto）；滚动时按
  // scrollTop 重算可视窗口增量重建（窗口未变零开销跳过；非虚拟态 no-op）
  el.addEventListener(
    'scroll',
    () => {
      const st = listStates.get(el);
      if (st) renderVirtualWindow(el, st, false);
    },
    { signal: ctx.signal },
  );
  return el;
}

/** list：签名比对增量更新（columns / items 未变则不重建，保选中态与展开态）。
 * 签名比对始终在全量数据上做（T7.6 语义不变）；超阈值行数时 DOM 只建可视窗口。 */
export function patchList(el: HTMLElement, node: UINode, _ctx: NodeCtx): void {
  const columns = Array.isArray(node.props.columns) ? (node.props.columns as ListColumn[]) : [];
  const items = node.props.items;
  const sig = JSON.stringify([columns, items]);
  let state = listStates.get(el);
  if (!state) {
    state = {
      sig: '',
      columns: [],
      rows: [],
      selected: -1,
      collapsed: new Set(),
      expanded: new Set(),
      virtual: false,
      slots: [],
      winStart: 0,
      winEnd: 0,
    };
    listStates.set(el, state);
  }
  if (state.sig === sig) return;
  state.sig = sig;
  state.columns = columns;
  state.rows = parseRows(items);
  state.selected = -1; // 数据重建后按索引的选中态失效（TODO 按行键保持选中）
  renderListBody(el, state);
}

/* ============================================================
 * table（简化表格：字段/标题/宽度 + 行数据；分组与合并不适用）
 * ============================================================ */

interface TableState {
  sig: string;
  columns: ListColumn[];
  rows: Record<string, unknown>[];
  selected: number;
}

const tableStates = new WeakMap<HTMLElement, TableState>();

function renderTableBody(el: HTMLElement, state: TableState): void {
  const head = el.querySelector<HTMLElement>('.bps-lhead');
  const body = el.querySelector<HTMLElement>('.bps-lbody');
  if (!head || !body) return;
  const cols = state.columns;
  const tpl = gridTemplate(cols);

  clearChildren(head);
  head.style.display = 'grid';
  head.style.gridTemplateColumns = tpl;
  for (const c of cols) {
    head.appendChild(span('bps-lcell')).textContent = c.title || c.field;
  }

  clearChildren(body);
  if (!state.rows.length) {
    body.appendChild(span('bps-lempty')).textContent = '（等待数据…）';
    return;
  }
  state.rows.forEach((row, i) => {
    const rowEl = div('bps-lrow bps-lgrid');
    rowEl.style.gridTemplateColumns = tpl;
    rowEl.dataset.ridx = String(i);
    if (state.selected === i) rowEl.classList.add('bps-lrow--sel');
    for (const c of cols) rowEl.appendChild(cellEl(c, row));
    body.appendChild(rowEl);
  });
}

function onTableRowClick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = tableStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  const rowEl = t && typeof t.closest === 'function' ? (t.closest('.bps-lrow') as HTMLElement | null) : null;
  if (!rowEl) return;
  const row = state.rows[Number(rowEl.dataset.ridx)];
  if (!row) return;
  state.selected = Number(rowEl.dataset.ridx);
  renderTableBody(el, state);
  ctx.emit(node, 'selectionChanged', row);
}

function onTableDblclick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = tableStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  const rowEl = t && typeof t.closest === 'function' ? (t.closest('.bps-lrow') as HTMLElement | null) : null;
  if (!rowEl) return;
  const row = state.rows[Number(rowEl.dataset.ridx)];
  if (row) ctx.emit(node, 'doubleClicked', row);
}

export function createTableNode(_node: UINode, ctx: NodeCtx): HTMLElement {
  const el = div('bps-node bps-tableview');
  el.append(div('bps-lhead bps-lgrid'), div('bps-lbody'));
  el.addEventListener('click', (e) => onTableRowClick(el, e, ctx), { signal: ctx.signal });
  el.addEventListener('dblclick', (e) => onTableDblclick(el, e, ctx), { signal: ctx.signal });
  return el;
}

export function patchTable(el: HTMLElement, node: UINode, _ctx: NodeCtx): void {
  const columns = Array.isArray(node.props.columns) ? (node.props.columns as ListColumn[]) : [];
  const items = node.props.items;
  const sig = JSON.stringify([columns, items]);
  let state = tableStates.get(el);
  if (!state) {
    state = { sig: '', columns: [], rows: [], selected: -1 };
    tableStates.set(el, state);
  }
  if (state.sig === sig) return;
  state.sig = sig;
  state.columns = columns;
  state.rows = parseRows(items);
  state.selected = -1;
  renderTableBody(el, state);
}

/* ============================================================
 * tree（UITreeItem 嵌套缩进 + 展开折叠 + 选中）
 * ============================================================ */

interface TreeState {
  sig: string;
  items: UITreeItem[];
  /** 展开覆盖表：path → 是否展开（缺省用 item.expanded ?? true） */
  overrides: Map<string, boolean>;
  /** 选中项 path */
  selected: string | null;
  /** path → 原始 item（事件 payload 用） */
  flat: Map<string, UITreeItem>;
}

const treeStates = new WeakMap<HTMLElement, TreeState>();

/** 宽容解析树数据（JSON 文本 / 数组；非对象包装为 { label }，label 缺省空串） */
function parseTreeItems(v: unknown): UITreeItem[] {
  let arr: unknown = v;
  if (typeof v === 'string') {
    try {
      arr = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const norm = (x: unknown): UITreeItem => {
    if (x === null || typeof x !== 'object') return { label: str(x) };
    const o = x as Record<string, unknown>;
    const item: UITreeItem = { label: str(o.label) };
    if (Array.isArray(o.children)) item.children = o.children.map(norm);
    if (typeof o.expanded === 'boolean') item.expanded = o.expanded;
    if (o.data !== undefined) item.data = o.data;
    return item;
  };
  return arr.map(norm);
}

/** 递归渲染树行（展开的子级跟随其后，缩进 = 深度 × 14px） */
function renderTreeRows(el: HTMLElement, state: TreeState): void {
  clearChildren(el);
  state.flat.clear();
  const walk = (items: UITreeItem[], depth: number, parentPath: string): void => {
    items.forEach((item, i) => {
      const path = parentPath ? `${parentPath}.${i}` : String(i);
      state.flat.set(path, item);
      const hasKids = Array.isArray(item.children) && item.children.length > 0;
      const expanded = state.overrides.get(path) ?? (item.expanded !== false);
      const row = div('bps-treeitem');
      row.dataset.path = path;
      row.style.paddingLeft = `${depth * 14 + 4}px`;
      if (state.selected === path) row.classList.add('bps-treeitem--sel');
      const caret = span('bps-treecaret');
      caret.textContent = hasKids ? (expanded ? '▾' : '▸') : '·';
      row.appendChild(caret);
      row.appendChild(span()).textContent = item.label;
      el.appendChild(row);
      if (hasKids && expanded) walk(item.children!, depth + 1, path);
    });
  };
  walk(state.items, 0, '');
}

function onTreeClick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = treeStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return;
  const rowEl = t.closest('.bps-treeitem') as HTMLElement | null;
  if (!rowEl) return;
  const path = rowEl.dataset.path ?? '';
  const item = state.flat.get(path);
  if (!item) return;
  // caret 点击：展开/折叠（仅运行态可交互；编辑态被 pointer-events 冻结）
  if (t.closest('.bps-treecaret') && Array.isArray(item.children) && item.children.length > 0) {
    const cur = state.overrides.get(path) ?? (item.expanded !== false);
    state.overrides.set(path, !cur);
    renderTreeRows(el, state);
    return;
  }
  state.selected = path;
  renderTreeRows(el, state);
  ctx.emit(node, 'selectionChanged', item);
}

function onTreeDblclick(el: HTMLElement, ev: Event, ctx: NodeCtx): void {
  const state = treeStates.get(el);
  const node = nodeOf(el);
  if (!state || !node) return;
  const t = ev.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return;
  const rowEl = t.closest('.bps-treeitem') as HTMLElement | null;
  if (!rowEl) return;
  const item = state.flat.get(rowEl.dataset.path ?? '');
  if (item) ctx.emit(node, 'doubleClicked', item);
}

export function createTreeNode(_node: UINode, ctx: NodeCtx): HTMLElement {
  const el = div('bps-node bps-tree');
  el.addEventListener('click', (e) => onTreeClick(el, e, ctx), { signal: ctx.signal });
  el.addEventListener('dblclick', (e) => onTreeDblclick(el, e, ctx), { signal: ctx.signal });
  return el;
}

export function patchTree(el: HTMLElement, node: UINode, _ctx: NodeCtx): void {
  const itemsRaw = node.props.items;
  const sig = JSON.stringify(itemsRaw);
  let state = treeStates.get(el);
  if (!state) {
    state = { sig: '', items: [], overrides: new Map(), selected: null, flat: new Map() };
    treeStates.set(el, state);
  }
  if (state.sig === sig) return;
  state.sig = sig;
  state.items = parseTreeItems(itemsRaw);
  renderTreeRows(el, state); // 折叠 / 选中状态按 path 保留（结构相似时基本稳定）
}
