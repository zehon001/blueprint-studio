/**
 * Blueprint Studio v2 —— My Blueprint 结构面板（T2.3，PLAN §8.3）
 *
 * 蓝图编辑器左栏：变量 / 函数 / 事件 / 注释 分节列表 + 图签联动。
 *  - 变量：名 / 类型徽标 / 分类 / 「暴露」勾选；右键 插入 Get / Set、重命名、复制、删除；
 *    拖拽落图本期简化为右键插入（TODO(T2.3+)：HTML5 drag 拖入画布生成 Get/Set）；
 *  - 函数：名 / 参数数；双击打开函数图；右键 插入调用到当前图 / 删除函数；
 *  - 事件：名 / 参数数；双击跳转事件入口节点；右键 在当前图创建事件节点；
 *  - 注释（T2.7）：全部图的注释框列表；双击定位到画布注释框；右键 删除；＋ 新建。
 *
 * 资产修改全部经 useBlueprintStore 的 action（内部入命令栈，可撤销）。
 * 本组件不 import 样式（node:test 可挂载冒烟）：my-blueprint.css 由
 * BlueprintEditorPanel 引入（含通用菜单 menu.css 的 @import）。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { IRComment, IRParamSpec, IRValueType } from '../../ir/types';
import { pinColor } from '../../shell/theme/tokens';
import { Menu } from '../../panels/file-system/Menu';
import type { MenuItem } from '../../panels/file-system/Menu';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  VARIABLE_TYPES,
  cleanParamRows,
  findEventNode,
  nameExists,
  nextEventName,
  nextFunctionName,
  nextVariableName,
  orderedGraphNames,
  variableTypeLabel,
} from './model';

/* ============================================================
 * 行内命名编辑框（Enter/失焦提交，Esc 取消；提交与取消只触发其一）
 * ============================================================ */

function InlineNameEditor(props: {
  initial: string;
  placeholder?: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const ref = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (): void => {
    if (done.current) return;
    done.current = true;
    props.onCommit(draft);
  };
  const cancel = (): void => {
    if (done.current) return;
    done.current = true;
    props.onCancel();
  };
  return (
    <input
      ref={ref}
      className={props.className ?? 'bp-mb-inline-input'}
      value={draft}
      placeholder={props.placeholder}
      aria-label={props.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') cancel();
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

/* ============================================================
 * 分节容器（UE5 式折叠分节 + ＋ 快捷新建）
 * ============================================================ */

function Section(props: {
  title: string;
  count?: number;
  addTitle?: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`bp-mb-section${props.collapsed ? ' bp-mb-section--collapsed' : ''}`}>
      <div
        className="bp-mb-section-head"
        role="button"
        tabIndex={0}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') props.onToggle();
        }}
      >
        <span className="bp-mb-caret" aria-hidden>
          {props.collapsed ? '▸' : '▾'}
        </span>
        <span className="bp-mb-section-title">{props.title}</span>
        {props.count !== undefined ? <span className="bp-mb-count">{props.count}</span> : null}
        {props.onAdd ? (
          <button
            type="button"
            className="bp-mb-add"
            title={props.addTitle ?? `新建${props.title}`}
            aria-label={props.addTitle ?? `新建${props.title}`}
            onClick={(e) => {
              e.stopPropagation();
              props.onAdd?.();
            }}
          >
            ＋
          </button>
        ) : null}
      </div>
      {props.collapsed ? null : <div className="bp-mb-section-body">{props.children}</div>}
    </section>
  );
}

/* ============================================================
 * ＋新建 的行内表单
 * ============================================================ */

/** ＋新建变量：行内命名 + 类型下拉 */
function AddVariableRow(props: { existingNames: readonly string[]; onClose: () => void }) {
  const [draft, setDraft] = useState(() => nextVariableName(props.existingNames));
  const [type, setType] = useState<IRValueType>('int');
  const duplicate = nameExists(props.existingNames, draft);
  const confirm = (): void => {
    const st = useBlueprintStore.getState();
    if (st.addVariable({ name: draft, type })) props.onClose();
    // 失败（重名 / 空名）：保持输入态，store 已弹提示
  };
  return (
    <div className="bp-mb-addrow">
      <input
        className="bp-mb-inline-input"
        value={draft}
        placeholder="变量名"
        aria-label="变量名"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm();
          else if (e.key === 'Escape') props.onClose();
          e.stopPropagation();
        }}
      />
      <select
        className="bp-mb-type-select"
        value={type}
        aria-label="变量类型"
        onChange={(e) => setType(e.target.value as IRValueType)}
      >
        {VARIABLE_TYPES.map((t) => (
          <option key={t} value={t}>
            {variableTypeLabel(t)}（{t}）
          </option>
        ))}
      </select>
      <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || draft.trim() === ''} onClick={confirm}>
        ✓
      </button>
      <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
        ✕
      </button>
      {duplicate ? <div className="bp-mb-addrow-warn">变量名已存在</div> : null}
    </div>
  );
}

/** ＋新建函数：行内命名（成功后自动打开该函数图） */
function AddFunctionRow(props: { existingNames: readonly string[]; onClose: () => void }) {
  const [draft, setDraft] = useState(() => nextFunctionName(props.existingNames));
  const duplicate = nameExists(props.existingNames, draft);
  const confirm = (): void => {
    const st = useBlueprintStore.getState();
    const name = draft.trim();
    if (name !== '' && st.addFunction(name)) {
      st.switchGraph(name);
      props.onClose();
    }
    // 失败（重名）：保持输入态，store 已弹提示
  };
  return (
    <div className="bp-mb-addrow">
      <input
        className="bp-mb-inline-input"
        value={draft}
        placeholder="函数名"
        aria-label="函数名"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm();
          else if (e.key === 'Escape') props.onClose();
          e.stopPropagation();
        }}
      />
      <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || draft.trim() === ''} onClick={confirm}>
        ✓
      </button>
      <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
        ✕
      </button>
      {duplicate ? <div className="bp-mb-addrow-warn">函数名已存在</div> : null}
    </div>
  );
}

/** ＋新建事件：名 + 参数行编辑（增删参数行 / 类型） */
function AddEventForm(props: {
  existingNames: readonly string[];
  onClose: () => void;
}) {
  const [name, setName] = useState(() => nextEventName(props.existingNames));
  const [rows, setRows] = useState<IRParamSpec[]>([]);
  const duplicate = nameExists(props.existingNames, name);
  const confirm = (): void => {
    const st = useBlueprintStore.getState();
    if (st.addEvent({ name, params: cleanParamRows(rows) })) props.onClose();
  };
  return (
    <div className="bp-mb-addrow bp-mb-addrow--event">
      <div className="bp-mb-addrow-line">
        <input
          className="bp-mb-inline-input"
          value={name}
          placeholder="事件名"
          aria-label="事件名"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || name.trim() === ''} onClick={confirm}>
          ✓
        </button>
        <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {duplicate ? <div className="bp-mb-addrow-warn">事件名已存在</div> : null}
      {rows.map((row, i) => (
        <div key={i} className="bp-mb-addrow-line">
          <input
            className="bp-mb-inline-input"
            value={row.name}
            placeholder={`参数${i + 1}名`}
            aria-label={`参数${i + 1}名`}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
            }
          />
          <select
            className="bp-mb-type-select"
            value={row.type}
            aria-label={`参数${i + 1}类型`}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, type: e.target.value as IRValueType } : r)))
            }
          >
            {VARIABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="bp-mb-btn"
            title="删除参数行"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="bp-mb-btn bp-mb-btn--wide" onClick={() => setRows([...rows, { name: '', type: 'any' }])}>
        ＋参数
      </button>
    </div>
  );
}

/* ============================================================
 * 面板本体
 * ============================================================ */

/** 分节键（折叠 / 新建态用） */
type SectionKey = 'vars' | 'fns' | 'events' | 'comments';

export function MyBlueprint({ className }: { className?: string }) {
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    vars: false,
    fns: false,
    events: false,
    comments: false,
  });
  const [adding, setAdding] = useState<SectionKey | null>(null);
  /** 行内重命名中的变量名 */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 行右键菜单（受控渲染） */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  if (!asset) return null;

  const variableNames = asset.variables.map((v) => v.name);
  const functionNames = orderedGraphNames(asset).filter((n) => n !== asset.entry);
  const eventNames = asset.events.map((e) => e.name);
  // T2.7：全部图的注释框（注释按图存放；分节内跨图列出，双击定位到所在图）
  const commentRows: Array<{ graphName: string; comment: IRComment }> = [];
  for (const [name, graph] of Object.entries(asset.graphs)) {
    for (const comment of graph.comments ?? []) commentRows.push({ graphName: name, comment });
  }

  /* ---------- 跳转 ---------- */

  /** 双击函数 → 打开函数图 */
  const jumpToGraph = (name: string): void => {
    useBlueprintStore.getState().switchGraph(name);
  };

  /** 双击事件 → 跳转到事件入口节点所在图并选中（无入口节点时提示） */
  const jumpToEvent = (name: string): void => {
    const st = useBlueprintStore.getState();
    if (!st.asset) return;
    const hit = findEventNode(st.asset, name);
    if (!hit) {
      st.notify(`事件「${name}」还没有入口节点：右键该事件可「在当前图创建事件节点」`);
      return;
    }
    if (hit.graphName !== st.graphName) st.switchGraph(hit.graphName);
    st.setSelection({ nodeIds: [hit.nodeId], edgeIds: [] });
  };

  /** 双击注释 → 画布定位（面板监听 focusComment：切图 + 选中 + 居中） */
  const jumpToComment = (commentId: string): void => {
    useBlueprintStore.getState().requestCommentFocus(commentId);
  };

  /* ---------- 行右键菜单 ---------- */

  const openRowMenu = (e: ReactMouseEvent, items: MenuItem[]): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const variableMenu = (name: string): MenuItem[] => [
    { label: '插入 Get 节点', onSelect: () => void useBlueprintStore.getState().insertVariableNode(name, 'get') },
    { label: '插入 Set 节点', onSelect: () => void useBlueprintStore.getState().insertVariableNode(name, 'set') },
    { separator: true },
    { label: '重命名', onSelect: () => setRenaming(name) },
    { label: '复制变量', onSelect: () => void useBlueprintStore.getState().duplicateVariable(name) },
    { label: '删除变量', danger: true, onSelect: () => useBlueprintStore.getState().removeVariable(name) },
  ];

  const functionMenu = (name: string): MenuItem[] => [
    { label: '打开函数图', onSelect: () => jumpToGraph(name) },
    { label: '插入调用到当前图', onSelect: () => void useBlueprintStore.getState().insertFunctionCall(name) },
    { separator: true },
    {
      label: '删除函数',
      danger: true,
      onSelect: () => {
        const st = useBlueprintStore.getState();
        if (!st.removeGraph(name)) return;
        // 当前图被删 → 回主图
        if (useBlueprintStore.getState().graphName === name) {
          useBlueprintStore.getState().switchGraph(useBlueprintStore.getState().asset?.entry ?? '');
        }
      },
    },
  ];

  const eventMenu = (name: string): MenuItem[] => [
    { label: '跳转到事件节点', onSelect: () => jumpToEvent(name) },
    { label: '在当前图创建事件节点', onSelect: () => void useBlueprintStore.getState().insertEventNode(name) },
  ];

  const commentMenu = (commentId: string): MenuItem[] => [
    { label: '定位到注释框', onSelect: () => jumpToComment(commentId) },
    {
      label: '删除注释',
      danger: true,
      onSelect: () => useBlueprintStore.getState().removeComments([commentId]),
    },
  ];

  /* ---------- 分节开关（点 ＋ 时顺带展开） ---------- */

  const toggleSection = (key: SectionKey): void =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const startAdd = (key: SectionKey): void => {
    setCollapsed((prev) => ({ ...prev, [key]: false }));
    setAdding(key);
  };

  const closeAdd = (): void => setAdding(null);

  return (
    <div className={`bp-mb${className ? ` ${className}` : ''}`}>
      <div className="bp-mb-header">
        <span className="bp-mb-header-title">My Blueprint</span>
        <span className="bp-mb-header-sub">{asset.name}</span>
      </div>
      <div className="bp-mb-body">
        {/* ---------------- 变量 ---------------- */}
        <Section
          title="变量"
          count={asset.variables.length}
          addTitle="新建变量"
          collapsed={collapsed.vars}
          onToggle={() => toggleSection('vars')}
          onAdd={() => startAdd('vars')}
        >
          {asset.variables.map((v) => (
            <div
              key={v.name}
              className={`bp-mb-row${v.exposed ? ' bp-mb-row--exposed' : ''}`}
              title="双击重命名；右键插入 Get / Set、复制、删除"
              onContextMenu={(e) => openRowMenu(e, variableMenu(v.name))}
            >
              <input
                type="checkbox"
                className="bp-mb-exposed"
                title="暴露：勾选后可在蓝图中生成 Get / Set 节点"
                aria-label={`暴露 ${v.name}`}
                checked={v.exposed === true}
                onChange={(e) =>
                  useBlueprintStore.getState().updateVariable(v.name, { exposed: e.target.checked })
                }
              />
              {renaming === v.name ? (
                <InlineNameEditor
                  initial={v.name}
                  placeholder="变量名"
                  onCommit={(value) => {
                    useBlueprintStore.getState().renameVariable(v.name, value);
                    setRenaming(null);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="bp-mb-row-name" onDoubleClick={() => setRenaming(v.name)}>
                  {v.name}
                </span>
              )}
              <span
                className="bp-mb-type"
                style={{ '--pin-color': pinColor(v.type) } as CSSProperties}
                title={variableTypeLabel(v.type)}
              >
                {v.type}
              </span>
              {v.category ? <span className="bp-mb-cat">{v.category}</span> : null}
              <span
                className="bp-mb-row-drag"
                title="拖入图画布生成 Get / Set（本期：右键行 → 插入 Get / Set）"
                aria-hidden
                data-drag-todo="T2.3+"
              />
            </div>
          ))}
          {adding === 'vars' ? (
            <AddVariableRow existingNames={variableNames} onClose={closeAdd} />
          ) : null}
          {asset.variables.length === 0 && adding !== 'vars' ? (
            <div className="bp-mb-empty">暂无变量</div>
          ) : null}
        </Section>

        {/* ---------------- 函数 ---------------- */}
        <Section
          title="函数"
          count={functionNames.length}
          addTitle="新建函数"
          collapsed={collapsed.fns}
          onToggle={() => toggleSection('fns')}
          onAdd={() => startAdd('fns')}
        >
          {functionNames.map((name) => {
            const paramCount = asset.graphs[name]?.params?.length ?? 0;
            return (
              <div
                key={name}
                className={`bp-mb-row${name === graphName ? ' bp-mb-row--current' : ''}`}
                title="双击打开函数图；右键插入调用 / 删除"
                onDoubleClick={() => jumpToGraph(name)}
                onContextMenu={(e) => openRowMenu(e, functionMenu(name))}
              >
                <span className="bp-mb-row-name">{name}</span>
                <span className="bp-mb-meta">参数 {paramCount}</span>
                {name === graphName ? <span className="bp-mb-current">当前</span> : null}
              </div>
            );
          })}
          {adding === 'fns' ? (
            <AddFunctionRow existingNames={Object.keys(asset.graphs)} onClose={closeAdd} />
          ) : null}
          {functionNames.length === 0 && adding !== 'fns' ? (
            <div className="bp-mb-empty">暂无函数（双击主图外的图签或点 ＋ 新建）</div>
          ) : null}
        </Section>

        {/* ---------------- 事件 ---------------- */}
        <Section
          title="事件"
          count={asset.events.length}
          addTitle="新建事件"
          collapsed={collapsed.events}
          onToggle={() => toggleSection('events')}
          onAdd={() => startAdd('events')}
        >
          {asset.events.map((ev) => (
            <div
              key={ev.name}
              className="bp-mb-row"
              title="双击跳转到事件入口节点；右键在当前图创建事件节点"
              onDoubleClick={() => jumpToEvent(ev.name)}
              onContextMenu={(e) => openRowMenu(e, eventMenu(ev.name))}
            >
              <span className="bp-mb-row-name">{ev.name}</span>
              <span className="bp-mb-meta">参数 {ev.params.length}</span>
            </div>
          ))}
          {adding === 'events' ? (
            <AddEventForm existingNames={eventNames} onClose={closeAdd} />
          ) : null}
          {asset.events.length === 0 && adding !== 'events' ? (
            <div className="bp-mb-empty">暂无事件</div>
          ) : null}
        </Section>

        {/* ---------------- 注释（T2.7：当前资产全部图的注释框；双击画布定位） ---------------- */}
        <Section
          title="注释"
          count={commentRows.length}
          addTitle="新建注释"
          collapsed={collapsed.comments}
          onToggle={() => toggleSection('comments')}
          onAdd={() => void useBlueprintStore.getState().addComment()}
        >
          {commentRows.map((row) => (
            <div
              key={`${row.graphName}:${row.comment.id}`}
              className="bp-mb-row"
              title="双击定位到画布中的注释框；右键删除"
              onDoubleClick={() => jumpToComment(row.comment.id)}
              onContextMenu={(e) => openRowMenu(e, commentMenu(row.comment.id))}
            >
              <span className="bp-mb-row-name">{row.comment.text}</span>
              <span className="bp-mb-meta">{row.graphName === graphName ? '当前图' : row.graphName}</span>
            </div>
          ))}
          {commentRows.length === 0 ? <div className="bp-mb-empty">暂无注释（画布右键 → 添加注释）</div> : null}
        </Section>
      </div>
      {menu ? <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
