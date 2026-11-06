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
import {
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  FunctionSquare,
  GripVertical,
  MessageSquare,
  Plus,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import type { IRComment, IRParamSpec, IRStructDef, IRValueType, IRVariable } from '../../ir/types';
import { pinColor } from '../../shell/theme/tokens';
import { Menu } from '../../panels/file-system/Menu';
import type { MenuItem } from '../../panels/file-system/Menu';
import { useBlueprintStore } from '../store/blueprint-store';
import { TypeSelect } from '../type-picker';
import { hasPluginNodes } from '@/nodes/dynamic';
import { useWorkspaceStore } from '../../shell/workspace-store';
import {
  cleanParamRows,
  findEventNode,
  nameExists,
  nameKey,
  nextEventName,
  nextFunctionName,
  nextSequentialName,
  nextVariableName,
  orderedGraphNames,
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
  icon?: LucideIcon;
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
          <Icon icon={props.collapsed ? ChevronRight : ChevronDown} size={12} />
        </span>
        {props.icon ? (
          <span className="bp-mb-section-icon" aria-hidden>
            <Icon icon={props.icon} size={14} />
          </span>
        ) : null}
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
            <Icon icon={Plus} size={12} />
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

/** agent 插件可用性（会话类型变量门禁：未安装该插件时类型下拉不出现会话项） */
function useAgentPluginAvailable(): boolean {
  const project = useWorkspaceStore((s) => s.currentProject?.path ?? null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void hasPluginNodes(project, 'agent')
      .then((ok) => {
        if (alive) setAvailable(ok);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project]);
  return available;
}

/** ＋新建变量：行内命名 + 类型下拉（基础 / 数组 / 自定义结构体 / Agent 会话） */
function AddVariableRow(props: {
  existingNames: readonly string[];
  types?: readonly IRStructDef[];
  sessionAvailable?: boolean;
  onClose: () => void;
}) {
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
      <TypeSelect
        className="bp-mb-type-select"
        value={type}
        ariaLabel="变量类型"
        types={props.types}
        sessionAvailable={props.sessionAvailable}
        onChange={setType}
      />
      <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || draft.trim() === ''} onClick={confirm}>
        <Icon icon={Check} size={13} />
      </button>
      <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
        <Icon icon={X} size={13} />
      </button>
      {duplicate ? <div className="bp-mb-addrow-warn">变量名已存在</div> : null}
    </div>
  );
}

/** ＋新建结构体：行内命名 */
function AddStructTypeRow(props: { types?: readonly IRStructDef[]; onClose: () => void }) {
  const existing = (props.types ?? []).map((t) => t.name);
  const [draft, setDraft] = useState(() => nextSequentialName(existing, '新结构体'));
  const duplicate = existing.some((n) => nameKey(n) === nameKey(draft));
  const confirm = (): void => {
    if (useBlueprintStore.getState().addStructType(draft)) props.onClose();
  };
  return (
    <div className="bp-mb-addrow">
      <input
        className="bp-mb-inline-input"
        value={draft}
        placeholder="结构体名"
        aria-label="结构体名"
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') confirm();
          else if (e.key === 'Escape') props.onClose();
          e.stopPropagation();
        }}
      />
      <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || draft.trim() === ''} onClick={confirm}>
        <Icon icon={Check} size={13} />
      </button>
      <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
        <Icon icon={X} size={13} />
      </button>
      {duplicate ? <div className="bp-mb-addrow-warn">结构体名已存在</div> : null}
    </div>
  );
}

/** 结构体字段编辑（展开在类型行下方）：字段名 / 类型 / 删除 + 添加 */
function StructFieldsEditor(props: { def: IRStructDef; types?: readonly IRStructDef[] }) {
  const st = useBlueprintStore.getState();
  return (
    <div className="bp-mb-struct-fields">
      {props.def.fields.length === 0 ? <div className="bp-mb-empty">暂无字段</div> : null}
      {props.def.fields.map((field, i) => (
        <div key={`${field.name}-${i}`} className="bp-mb-field-row">
          <input
            className="bp-mb-inline-input"
            defaultValue={field.name}
            placeholder={`字段${i + 1}`}
            aria-label={`字段${i + 1}名`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next !== '' && next !== field.name) st.updateStructField(props.def.name, i, { name: next });
            }}
          />
          <TypeSelect
            className="bp-mb-type-select"
            value={field.type}
            types={props.types}
            ariaLabel={`字段${i + 1}类型`}
            onChange={(type) => st.updateStructField(props.def.name, i, { type })}
          />
          <button
            type="button"
            className="bp-mb-btn"
            title="删除字段"
            onClick={() => st.removeStructField(props.def.name, i)}
          >
            <Icon icon={X} size={11} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="bp-mb-btn bp-mb-btn--wide"
        title="添加字段"
        onClick={() => st.addStructField(props.def.name)}
      >
        <Icon icon={Plus} size={11} /> 字段
      </button>
      <div className="bp-mb-hint">默认值在「创建结构体」节点的字段引脚上设置。</div>
    </div>
  );
}

/** 默认值 → 编辑框文本（string 原样；其余 JSON；undefined 为空） */
function formatVariableDefault(value: unknown, type: IRValueType): string {
  if (value === undefined) return '';
  if (type === 'string') return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** 编辑框文本 → 类型化默认值（undefined = 清除） */
function parseVariableDefault(
  text: string,
  type: IRValueType,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (type === 'string') return { ok: true, value: text };
  if (trimmed === '') return { ok: true, value: undefined };
  if (type === 'int') {
    const n = Number(trimmed);
    return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, message: '需要整数' };
  }
  if (type === 'float') {
    const n = Number(trimmed);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, message: '需要数字' };
  }
  if (type === 'bool') return { ok: true, value: trimmed === 'true' };
  if (type === 'any') {
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch {
      return { ok: true, value: text };
    }
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false, message: 'JSON 格式不正确' };
  }
}

/**
 * 变量默认值编辑（右键「编辑默认值…」展开）：
 * bool → 勾选；int/float → 数字；string → 文本；对象/数组/结构体 → JSON。
 * 默认值参与运行时初始化（未设置 = 类型零值），数组/结构体可在这里直接写样例数据。
 */
function VariableDefaultEditor(props: { variable: IRVariable; onClose: () => void }) {
  const { variable } = props;
  const [draft, setDraft] = useState(() => formatVariableDefault(variable.default, variable.type));
  const [error, setError] = useState('');
  const commit = (): void => {
    // bool 由勾选框即改即提交；「应用」不再用陈旧 draft 覆盖
    if (variable.type === 'bool') return;
    const parsed = parseVariableDefault(draft, variable.type);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError('');
    useBlueprintStore.getState().updateVariable(variable.name, {
      default: parsed.value === undefined ? undefined : parsed.value,
    });
  };
  const clear = (): void => {
    setDraft('');
    setError('');
    useBlueprintStore.getState().updateVariable(variable.name, { default: undefined });
    props.onClose();
  };
  const isJson =
    variable.type !== 'bool' &&
    variable.type !== 'int' &&
    variable.type !== 'float' &&
    variable.type !== 'string';
  return (
    <div className="bp-mb-default-editor">
      <div className="bp-mb-default-head">
        <span>默认值</span>
        <span className="bp-mb-default-type">{variable.type}</span>
      </div>
      {variable.type === 'bool' ? (
        <label className="bp-mb-default-bool">
          <input
            type="checkbox"
            checked={variable.default === true}
            onChange={(e) =>
              useBlueprintStore.getState().updateVariable(variable.name, {
                default: e.target.checked,
              })
            }
          />
          真
        </label>
      ) : isJson ? (
        <textarea
          className="bp-mb-default-json"
          rows={4}
          value={draft}
          spellCheck={false}
          placeholder="JSON（对象 / 数组 / 结构体）"
          aria-label={`${variable.name} 默认值`}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError('');
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              commit();
              (e.target as HTMLTextAreaElement).blur();
            }
            e.stopPropagation();
          }}
        />
      ) : (
        <input
          className="bp-mb-default-input"
          type={variable.type === 'int' || variable.type === 'float' ? 'number' : 'text'}
          value={draft}
          placeholder={variable.type === 'string' ? '文本' : '数字'}
          aria-label={`${variable.name} 默认值`}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError('');
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
        />
      )}
      {error ? <div className="bp-mb-default-error">{error}</div> : null}
      <div className="bp-mb-default-actions">
        {variable.type !== 'bool' ? (
          <button
            type="button"
            className="bp-mb-btn bp-mb-btn--wide"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            应用
          </button>
        ) : null}
        <button
          type="button"
          className="bp-mb-btn"
          title="清除默认值（回落类型零值）"
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
        >
          清除
        </button>
        <button
          type="button"
          className="bp-mb-btn"
          title="收起"
          onMouseDown={(e) => e.preventDefault()}
          onClick={props.onClose}
        >
          <Icon icon={X} size={11} />
        </button>
      </div>
    </div>
  );
}

/** ＋新建函数：行内命名（成功后自动打开该函数图） */
function AddFunctionRow(props: {
  existingNames: readonly string[];
  onClose: () => void;
  onCreateScoped?: (scope: 'project' | 'global', name: string) => boolean | Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => nextFunctionName(props.existingNames));
  const [scope, setScope] = useState<'blueprint' | 'project' | 'global'>('blueprint');
  const duplicate = scope === 'blueprint' && nameExists(props.existingNames, draft);
  const confirm = (): void => {
    const st = useBlueprintStore.getState();
    const name = draft.trim();
    if (name === '') return;
    if (scope === 'blueprint') {
      if (st.addFunction(name)) {
        st.switchGraph(name);
        props.onClose();
      }
      return;
    }
    void Promise.resolve(props.onCreateScoped?.(scope, name)).then((ok) => {
      if (ok) props.onClose();
    });
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
      <select
        className="bp-mb-inline-select"
        value={scope}
        aria-label="函数作用域"
        title="函数作用域：蓝图（资产内）/ 全项目 / 全局"
        onChange={(e) => setScope(e.target.value as typeof scope)}
      >
        <option value="blueprint">蓝图</option>
        <option value="project">项目</option>
        <option value="global">全局</option>
      </select>
      <button type="button" className="bp-mb-btn bp-mb-btn--ok" title="确认新建" disabled={duplicate || draft.trim() === ''} onClick={confirm}>
        <Icon icon={Check} size={13} />
      </button>
      <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
        <Icon icon={X} size={13} />
      </button>
      {duplicate ? <div className="bp-mb-addrow-warn">函数名已存在</div> : null}
    </div>
  );
}

/** ＋新建事件：名 + 参数行编辑（增删参数行 / 类型） */
function AddEventForm(props: {
  existingNames: readonly string[];
  types?: readonly IRStructDef[];
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
          <Icon icon={Check} size={13} />
        </button>
        <button type="button" className="bp-mb-btn" title="取消" onClick={props.onClose}>
          <Icon icon={X} size={13} />
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
          <TypeSelect
            className="bp-mb-type-select"
            value={row.type}
            ariaLabel={`参数${i + 1}类型`}
            types={props.types}
            onChange={(type) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, type } : r)))
            }
          />
          <button
            type="button"
            className="bp-mb-btn"
            title="删除参数行"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            <Icon icon={X} size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="bp-mb-btn bp-mb-btn--wide"
        title="添加参数行"
        onClick={() => setRows([...rows, { name: '', type: 'any' }])}
      >
        <Icon icon={Plus} size={12} /> 参数
      </button>
    </div>
  );
}

/* ============================================================
 * 面板本体
 * ============================================================ */

/** 分节键（折叠 / 新建态用） */
type SectionKey = 'vars' | 'types' | 'fns' | 'events' | 'comments';

export function MyBlueprint({
  className,
  onCreateScopedFunction,
  hideFunctions = false,
}: {
  className?: string;
  onCreateScopedFunction?: (scope: 'project' | 'global', name: string) => boolean | Promise<boolean>;
  /** 函数资产编辑器：单图契约，不允许再建子图 */
  hideFunctions?: boolean;
}) {
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>({
    vars: false,
    types: false,
    fns: false,
    events: false,
    comments: false,
  });
  const [adding, setAdding] = useState<SectionKey | null>(null);
  /** 展开字段编辑的结构体名（null = 全部收起） */
  const [expandedType, setExpandedType] = useState<string | null>(null);
  /** 行内重命名中的变量名 */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** 展开默认值编辑的变量名（null = 全部收起） */
  const [editingDefault, setEditingDefault] = useState<string | null>(null);
  /** 行右键菜单（受控渲染） */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const sessionAvailable = useAgentPluginAvailable();

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
    { label: '编辑默认值…', onSelect: () => setEditingDefault(name) },
    { label: '重命名', onSelect: () => setRenaming(name) },
    { label: '复制变量', onSelect: () => void useBlueprintStore.getState().duplicateVariable(name) },
    { label: '删除变量', danger: true, onSelect: () => useBlueprintStore.getState().removeVariable(name) },
  ];

  const functionMenu = (name: string): MenuItem[] => [
    { label: '打开函数图', onSelect: () => jumpToGraph(name) },
    { label: '插入调用到当前图', onSelect: () => void useBlueprintStore.getState().insertFunctionCall(name) },
    {
      label: '重命名函数…',
      onSelect: () => {
        const to = window.prompt(`重命名函数「${name}」为：`, name)?.trim();
        if (to && to !== name) useBlueprintStore.getState().renameFunction(name, to);
      },
    },
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

  const structMenu = (name: string): MenuItem[] => [
    {
      label: '插入「创建结构体」节点',
      onSelect: () => void useBlueprintStore.getState().insertStructMakeNode(name),
    },
    {
      label: '插入「拆分结构体」节点',
      onSelect: () => void useBlueprintStore.getState().insertStructBreakNode(name),
    },
    { separator: true },
    {
      label: '重命名结构体…',
      onSelect: () => {
        const to = window.prompt(`重命名结构体「${name}」为：`, name)?.trim();
        if (to && to !== name) useBlueprintStore.getState().renameStructType(name, to);
      },
    },
    {
      label: '删除结构体',
      danger: true,
      onSelect: () => void useBlueprintStore.getState().removeStructType(name),
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
          icon={Braces}
          count={asset.variables.length}
          addTitle="新建变量"
          collapsed={collapsed.vars}
          onToggle={() => toggleSection('vars')}
          onAdd={() => startAdd('vars')}
        >
          {asset.variables.map((v) => (
            <div key={v.name}>
              <div
                className={`bp-mb-row${v.exposed ? ' bp-mb-row--exposed' : ''}`}
                title="双击重命名；右键插入 Get / Set、编辑默认值、复制、删除"
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
                <TypeSelect
                  className="bp-mb-type bp-mb-type--select"
                  value={v.type}
                  types={asset.types}
                  ariaLabel={`${v.name} 类型`}
                  style={{ '--pin-color': pinColor(v.type) } as CSSProperties}
                  onChange={(type) =>
                    useBlueprintStore.getState().updateVariable(v.name, { type })
                  }
                />
                {v.category ? <span className="bp-mb-cat">{v.category}</span> : null}
                <span
                  className="bp-mb-row-drag"
                  title="拖入图画布生成 Get / Set（本期：右键行 → 插入 Get / Set）"
                  aria-hidden
                  data-drag-todo="T2.3+"
                >
                  <Icon icon={GripVertical} size={12} />
                </span>
              </div>
              {editingDefault === v.name ? (
                <VariableDefaultEditor variable={v} onClose={() => setEditingDefault(null)} />
              ) : null}
            </div>
          ))}
          {adding === 'vars' ? (
            <AddVariableRow
              existingNames={variableNames}
              types={asset.types}
              sessionAvailable={sessionAvailable}
              onClose={closeAdd}
            />
          ) : null}
          {asset.variables.length === 0 && adding !== 'vars' ? (
            <div className="bp-mb-empty">暂无变量</div>
          ) : null}
        </Section>

        {/* ---------------- 类型（用户自定义结构体） ---------------- */}
        <Section
          title="类型"
          icon={Box}
          count={(asset.types ?? []).length}
          addTitle="新建结构体"
          collapsed={collapsed.types}
          onToggle={() => toggleSection('types')}
          onAdd={() => startAdd('types')}
        >
          {(asset.types ?? []).map((def) => (
            <div key={def.name} className="bp-mb-struct">
              <div
                className="bp-mb-row"
                title="双击展开字段编辑；右键插入创建/拆分节点、重命名、删除"
                onDoubleClick={() =>
                  setExpandedType((prev) => (prev === def.name ? null : def.name))
                }
                onContextMenu={(e) => openRowMenu(e, structMenu(def.name))}
              >
                <span className="bp-mb-row-name">{def.name}</span>
                <span className="bp-mb-struct-count">{def.fields.length} 字段</span>
                <span className="bp-mb-row-drag" aria-hidden>
                  <Icon icon={expandedType === def.name ? ChevronDown : ChevronRight} size={12} />
                </span>
              </div>
              {expandedType === def.name ? (
                <StructFieldsEditor def={def} types={asset.types} />
              ) : null}
            </div>
          ))}
          {adding === 'types' ? (
            <AddStructTypeRow types={asset.types} onClose={closeAdd} />
          ) : null}
          {(asset.types ?? []).length === 0 && adding !== 'types' ? (
            <div className="bp-mb-empty">暂无自定义结构体（新建后可在变量/函数参数中使用）</div>
          ) : null}
        </Section>

        {/* ---------------- 函数 ---------------- */}
        <Section
          title="函数"
          icon={FunctionSquare}
          count={functionNames.length}
          addTitle="新建函数"
          collapsed={collapsed.fns}
          onToggle={() => toggleSection('fns')}
          onAdd={hideFunctions ? undefined : () => startAdd('fns')}
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
          {adding === 'fns' && !hideFunctions ? (
            <AddFunctionRow
              existingNames={Object.keys(asset.graphs)}
              onClose={closeAdd}
              onCreateScoped={onCreateScopedFunction}
            />
          ) : null}
          {functionNames.length === 0 && adding !== 'fns' ? (
            <div className="bp-mb-empty">
              {hideFunctions ? '函数资产为单图（签名在统一检视器编辑）' : '暂无函数（双击主图外的图签或点 ＋ 新建）'}
            </div>
          ) : null}
        </Section>

        {/* ---------------- 事件 ---------------- */}
        <Section
          title="事件"
          icon={Zap}
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
            <AddEventForm existingNames={eventNames} types={asset.types} onClose={closeAdd} />
          ) : null}
          {asset.events.length === 0 && adding !== 'events' ? (
            <div className="bp-mb-empty">暂无事件</div>
          ) : null}
        </Section>

        {/* ---------------- 注释（T2.7：当前资产全部图的注释框；双击画布定位） ---------------- */}
        <Section
          title="注释"
          icon={MessageSquare}
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
