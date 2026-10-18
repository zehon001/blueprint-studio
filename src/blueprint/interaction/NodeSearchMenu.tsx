/**
 * Blueprint Studio v2 —— 右键节点搜索菜单（T2.2，PLAN §8.2 第 1 条）
 *
 * UE5 同款：画布空白右键 / Tab 在光标处呼出；模糊匹配（title/id/keywords 子串 +
 * ASCII 词首字母）+ 分类浏览 + 最近使用（LRU ≤ 8）；Enter 确认 / Esc 关闭 / ↑↓ 导航。
 * 本组件同时是通用节点挑选列表：PinDragMenu（引脚拖出兼容菜单）复用同一 UI。
 * 注意：不 import 样式（node:test 环境 tsx 无法加载 .css）；interaction.css 由
 * BlueprintEditorPanel 统一引入（shell/panels/Menu.tsx 同款约定）。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { Vec2 } from '../../ir/types';
// 纯模型层直取（不经 view/index barrel：barrel 含 BPGraphCanvas 及其 .css import，
// 会让 node:test 环境无法挂载本组件冒烟）
import { headColorFor, headVariantFor } from '../view/model';
import {
  clampMenuPosition,
  groupEntriesByCategory,
  searchSpecEntries,
  type SpecEntry,
} from './logic';

/** 分类分组顺序（与节点库 NODE_CATEGORIES 对齐；经 props 传入避免反向依赖） */
export interface NodeSearchMenuProps {
  /** 菜单屏幕坐标（fixed 定位；自动收敛到视口内） */
  screen: Vec2;
  /** 全量候选条目（搜索菜单 = 全部 spec；兼容菜单 = 已过滤的兼容节点） */
  entries: readonly SpecEntry[];
  /** 最近使用 spec id（LRU；仅无搜索词时显示「最近使用」分组） */
  recentIds: readonly string[];
  /** 分类展示顺序（节点库 NODE_CATEGORIES） */
  categoryOrder: readonly string[];
  /** 标题（右键搜索「添加节点」/ 引脚菜单「可连接节点」） */
  title: string;
  /** 选中条目回调（specId；兼容菜单由调用方继续建节点+连线） */
  onPick: (specId: string) => void;
  onClose: () => void;
}

/** 菜单近似尺寸（视口收敛用） */
const MENU_WIDTH = 300;
const MENU_HEIGHT = 380;

/** 展开后的扁平列表项（带所属分组标题，渲染时对分组变化插入节头） */
interface FlatItem {
  entry: SpecEntry;
  section: string;
}

/**
 * 节点搜索菜单（右键搜索 / 引脚兼容菜单共用 UI）。
 * 键盘：输入框聚焦时 Enter 确认 / Esc 关闭 / ↑↓ 导航（preventDefault，阻断全局快捷键）。
 */
export function NodeSearchMenu({
  screen,
  entries,
  recentIds,
  categoryOrder,
  title,
  onPick,
  onClose,
}: NodeSearchMenuProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // 无搜索词：最近使用 + 分类浏览；有搜索词：扁平搜索结果
  const flat = useMemo<FlatItem[]>(() => {
    const q = query.trim();
    if (q !== '') {
      return searchSpecEntries(entries, q).map((entry) => ({ entry, section: '搜索结果' }));
    }
    const byId = new Map(entries.map((e) => [e.spec.id, e] as const));
    const items: FlatItem[] = [];
    for (const id of recentIds) {
      const entry = byId.get(id);
      if (entry) items.push({ entry, section: '最近使用' });
    }
    for (const group of groupEntriesByCategory(entries, categoryOrder)) {
      for (const entry of group.entries) items.push({ entry, section: group.category });
    }
    return items;
  }, [entries, recentIds, categoryOrder, query]);

  // 高亮越界收敛（搜索结果变化时保持有效）
  const active = Math.min(highlight, Math.max(flat.length - 1, 0));
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // 高亮项滚入可视区
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const pick = (index: number): void => {
    const item = flat[index];
    if (item) onPick(item.entry.spec.id);
    else onClose();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setHighlight((h) => Math.min(h + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const pos = clampMenuPosition(screen, MENU_WIDTH, MENU_HEIGHT);
  let lastSection = '';

  return (
    <div ref={rootRef} className="bp-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <div className="bp-menu-header">{title}</div>
      <input
        ref={inputRef}
        className="bp-menu-search"
        autoFocus
        placeholder="搜索节点（名称 / 关键词 / 首字母）"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
      <div className="bp-menu-list">
        {flat.length === 0 ? (
          <div className="bp-menu-empty">没有匹配的节点</div>
        ) : (
          flat.map((item, index) => {
            const showSection = item.section !== lastSection;
            lastSection = item.section;
            const spec = item.entry.spec;
            const isActive = index === active;
            return (
              <div key={`${item.section}:${spec.id}`}>
                {showSection ? <div className="bp-menu-section">{item.section}</div> : null}
                <button
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  role="menuitem"
                  className={`bp-menu-item${isActive ? ' bp-menu-item--active' : ''}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => pick(index)}
                >
                  <span
                    className="bp-menu-dot"
                    style={{ background: headColorFor(headVariantFor(spec.id, spec)) }}
                    aria-hidden="true"
                  />
                  <span className="bp-menu-item-texts">
                    <span className="bp-menu-item-title">
                      {item.entry.pin
                        ? `${spec.title}（接「${item.entry.pin.label ?? item.entry.pin.id}」）`
                        : spec.title}
                    </span>
                    <span className="bp-menu-item-sub">
                      {item.entry.pin ? `${spec.id} → ${item.entry.pin.id}` : spec.id}
                      {item.entry.badge ? (
                        <span className="bp-menu-badge">{item.entry.badge}</span>
                      ) : null}
                      {item.entry.note ? (
                        <span className="bp-menu-note">{item.entry.note}</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ============================================================
 * 连线右键菜单（§8.2 第 4 条：断开）
 * ============================================================ */

export interface EdgeContextMenuProps {
  screen: Vec2;
  /** 右键的连线是否已在选中集内 */
  edgeSelected: boolean;
  /** 当前选中连线数（>1 时提供批量断开） */
  selectedEdgeCount: number;
  /** 断开右键的单条连线 */
  onDisconnectOne: () => void;
  /** 断开全部选中连线（仅 edgeSelected 且 selectedEdgeCount > 1 时可点） */
  onDisconnectSelected: () => void;
  onClose: () => void;
}

/** 连线右键菜单：「断开」单条 /「断开选中」批量（Ctrl+点击已选连线批量断开配合） */
export function EdgeContextMenu({
  screen,
  edgeSelected,
  selectedEdgeCount,
  onDisconnectOne,
  onDisconnectSelected,
  onClose,
}: EdgeContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pos = clampMenuPosition(screen, 200, 90);
  return (
    <div ref={rootRef} className="bp-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <div className="bp-menu-header">连线</div>
      <button
        type="button"
        role="menuitem"
        className="bp-menu-item bp-menu-item--danger"
        onClick={onDisconnectOne}
      >
        断开
      </button>
      {edgeSelected && selectedEdgeCount > 1 ? (
        <button
          type="button"
          role="menuitem"
          className="bp-menu-item bp-menu-item--danger"
          onClick={onDisconnectSelected}
        >
          断开选中连线（{selectedEdgeCount} 条）
        </button>
      ) : null}
    </div>
  );
}
