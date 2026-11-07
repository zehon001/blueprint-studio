/**
 * Blueprint Studio v2 —— 蓝图检视器·值编辑控件（T2.4，PLAN §8.4）
 *
 * ParamSpec / PinSpec 驱动的紧凑暗色控件：number / string / bool / select / color，
 * 外加混合态（多选值不同 → 空 + 占位「—」）。控件风格与检视器面板（T1.5）观感
 * 一致，但蓝图域独立实现、不共用代码。
 *
 * 文本 / 数字编辑采用「草稿态 + 提交」（Enter / 失焦提交），避免逐键入命令栈；
 * 布尔 / 下拉 / 颜色为离散值，变更即提交。外部值变化（撤销 / 批量应用 / 换选）
 * 自动同步回编辑框。本组件不 import 样式（node:test 可挂载冒烟）。
 */
import { useEffect, useRef, useState } from 'react';
import type { ParamOption, ParamSpec, PinSpec } from '../../ir/types';
import { useBlueprintStore } from '../store/blueprint-store';
import { DirectoryValueEditor } from './directory-picker';
import {
  displayValue,
  jsonEquals,
  paramEditorKindOf,
  pinEditorKindOf,
  pinJsonStrict,
  type EditorKind,
} from './details-model';

/** 混合态标题文案 */
export const MIXED_TITLE = '多个选中节点的值不同（混合）';

/** 草稿态文本编辑钩子：外部值变化自动同步；返回 [草稿, 设草稿, 提交] */
function useDraft(initial: string, isSame: (draft: string) => boolean, submit: (draft: string) => void) {
  const [draft, setDraft] = useState(initial);
  const committedRef = useRef(initial);
  useEffect(() => {
    if (committedRef.current === initial) return;
    committedRef.current = initial;
    setDraft(initial);
  }, [initial]);
  const commit = (): void => {
    if (isSame(draft)) return;
    committedRef.current = draft;
    submit(draft);
  };
  return { draft, setDraft, commit };
}

/** 文本编辑框（string 参数 / text 引脚默认值；混合态显示「—」占位） */
export function TextValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  placeholder?: string;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const initial = props.mixed
    ? ''
    : props.value === undefined || props.value === null
      ? ''
      : String(props.value);
  const { draft, setDraft, commit } = useDraft(initial, (d) => d === initial, props.onCommit);
  return (
    <input
      type="text"
      className={`${props.className ?? 'bp-det-input'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={draft}
      placeholder={props.mixed ? '—' : props.placeholder}
      title={props.mixed ? MIXED_TITLE : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

/** 数字编辑框（number 参数 / int·float 引脚默认值；空 → 0，非法不提交并回退） */
export function NumberValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  placeholder?: string;
  className?: string;
  onCommit: (value: number) => void;
}) {
  const initial = props.mixed ? '' : props.value === undefined ? '' : String(props.value);
  const { draft, setDraft, commit } = useDraft(
    initial,
    (d) => d === initial,
    (d) => {
      const text = d.trim();
      if (text === '') {
        setDraft('0');
        props.onCommit(0);
        return;
      }
      const n = Number(text);
      if (Number.isFinite(n)) {
        props.onCommit(n);
      } else {
        setDraft(initial); // 非法输入：回退显示（不产生命令）
      }
    },
  );
  return (
    <input
      type="number"
      step="any"
      className={`${props.className ?? 'bp-det-input'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={draft}
      placeholder={props.mixed ? '—' : props.placeholder}
      title={props.mixed ? MIXED_TITLE : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

/** 布尔勾选框（bool 参数 / 引脚默认值；变更即提交；混合态 indeterminate） */
export function BoolValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  className?: string;
  onCommit: (value: boolean) => void;
}) {
  const checked = props.value === true;
  return (
    <input
      type="checkbox"
      ref={(el) => {
        if (el) el.indeterminate = props.mixed === true;
      }}
      className={`${props.className ?? 'bp-det-check'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      checked={checked}
      title={props.mixed ? MIXED_TITLE : String(checked)}
      onChange={(e) => props.onCommit(e.target.checked)}
    />
  );
}

/** 下拉选择（select 参数 / select 型引脚；混合态显示「—」占位项） */
export function SelectValueEditor(props: {
  value: unknown;
  options: readonly ParamOption[];
  mixed?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const current = props.mixed || props.value === undefined ? '' : String(props.value);
  const known = props.options.some((o) => o.value === current);
  return (
    <select
      className={`${props.className ?? 'bp-det-select'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={current}
      title={props.mixed ? MIXED_TITLE : undefined}
      onChange={(e) => props.onCommit(e.target.value)}
    >
      {current === '' || !known ? (
        <option value="" disabled hidden>
          —
        </option>
      ) : null}
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 颜色选择器（color 参数；混合态显示「—」文本）；变更即提交 */
export function ColorValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  if (props.mixed) {
    return (
      <span className="bp-det-mixed-mark" title={MIXED_TITLE}>
        —
      </span>
    );
  }
  const hex = typeof props.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(props.value) ? props.value : '#000000';
  return (
    <input
      type="color"
      className={props.className ?? 'bp-det-color'}
      value={hex}
      title={hex}
      onChange={(e) => props.onCommit(e.target.value)}
    />
  );
}

/** 把任意值格式化为 JSON 编辑框文本（undefined → 空；字符串保留引号以区分纯文本） */
function formatJsonValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * JSON 值编辑器（object / any / 数组 / 自定义结构体引脚默认值）：
 * - strict = true：必须为合法 JSON，非法时就地报错且不提交；
 * - strict = false（any）：合法 JSON 按 JSON 解析，否则按纯文本提交。
 * 文本编辑采用草稿态 + 失焦 / Ctrl(⌘)+Enter 提交，避免逐键入命令栈。
 */
export function JsonValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  strict: boolean;
  placeholder?: string;
  className?: string;
  onCommit: (value: unknown) => void;
}) {
  const initial = props.mixed ? '' : formatJsonValue(props.value);
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(initial);
    setError('');
  }, [initial]);
  const commit = (): void => {
    const text = draft.trim();
    if (text === '') {
      if (props.strict) {
        setError('请输入 JSON 值（对象 / 数组 / 结构体）');
        return;
      }
      setError('');
      if (!jsonEquals(props.value, '')) props.onCommit('');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      setError('');
      if (!jsonEquals(props.value, parsed)) props.onCommit(parsed);
    } catch {
      if (!props.strict) {
        setError('');
        if (!jsonEquals(props.value, draft)) props.onCommit(draft);
        return;
      }
      setError('JSON 格式不正确');
    }
  };
  return (
    <div className={`bp-det-json${props.className ? ` ${props.className}` : ''}`}>
      <textarea
        className={`bp-det-input bp-det-json-input${props.mixed ? ' bp-det-input--mixed' : ''}`}
        rows={3}
        value={draft}
        placeholder={props.mixed ? '—' : props.placeholder}
        title={error || (props.mixed ? MIXED_TITLE : 'JSON / 文本值；Ctrl(⌘)+Enter 提交')}
        aria-invalid={error ? true : undefined}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError('');
        }}
        onBlur={() => {
          focusedRef.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            commit();
            (e.target as HTMLTextAreaElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {error ? <span className="bp-det-json-error">{error}</span> : null}
    </div>
  );
}

/** 结构体类型选择器（struct.make / struct.break 的 typeName 参数） */
export function StructTypeEditor(props: {
  value: unknown;
  mixed?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const types = useBlueprintStore((s) => s.asset?.types ?? []);
  const current = props.mixed || props.value === undefined ? '' : String(props.value);
  const missing = current !== '' && !types.some((t) => t.name === current);
  return (
    <select
      className={`${props.className ?? 'bp-det-select'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={current}
      aria-label="结构体类型"
      onChange={(e) => props.onCommit(e.target.value)}
    >
      {/* 仅在未选类型时显示占位项：已有类型时不让下拉意外回落到空值 */}
      {current === '' ? <option value="">{props.mixed ? '—' : '（选择结构体）'}</option> : null}
      {missing ? <option value={current}>{current}（未定义）</option> : null}
      {types.map((t) => (
        <option key={t.name} value={t.name}>
          {t.name}（{t.fields.length} 字段）
        </option>
      ))}
    </select>
  );
}

/** 变量选择器（v3 T12.8）：下拉列出本资产变量（提升标记 ★） */
export function VariableValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const variables = useBlueprintStore((s) => s.asset?.variables ?? []);
  const isFunctionGraph = useBlueprintStore((s) => {
    const a = s.asset;
    const g = a?.graphs[s.graphName];
    return !!g && (g.kind === 'function' || s.graphName !== a?.entry);
  });
  const current = props.mixed || props.value === undefined ? '' : String(props.value);
  const emptyLabel =
    variables.length === 0 && isFunctionGraph ? '（函数图无资产变量）' : '（选择变量）';
  return (
    <select
      className={`${props.className ?? 'bp-det-select'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={current}
      aria-label="变量选择器"
      onChange={(e) => props.onCommit(e.target.value)}
    >
      <option value="">{props.mixed ? '—' : emptyLabel}</option>
      {variables.map((v) => (
        <option key={v.name} value={v.name}>
          {v.name}
          {v.type ? ` : ${v.type}` : ''}
          {v.exposed ? ' ★' : ''}
        </option>
      ))}
    </select>
  );
}

/** 按控件种类分发（ParamSpec / PinSpec 共用的值编辑入口） */
export function ValueEditor(props: {
  kind: EditorKind;
  value: unknown;
  mixed?: boolean;
  options?: readonly ParamOption[];
  /** 文本 / 数字框的占位提示（引脚默认值回落 PinSpec.defaultValue 时显示） */
  placeholder?: string;
  onCommit: (value: unknown) => void;
}) {
  switch (props.kind) {
    case 'bool':
      return <BoolValueEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
    case 'number':
      return (
        <NumberValueEditor
          value={props.value}
          mixed={props.mixed}
          placeholder={props.placeholder}
          onCommit={props.onCommit}
        />
      );
    case 'select':
      return (
        <SelectValueEditor
          value={props.value}
          options={props.options ?? []}
          mixed={props.mixed}
          onCommit={props.onCommit}
        />
      );
    case 'directory':
      return <DirectoryValueEditor value={props.value} onCommit={props.onCommit} />;
    case 'color':
      return <ColorValueEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
    case 'variable':
      return <VariableValueEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
    case 'structType':
      return <StructTypeEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
    case 'json':
      return (
        <JsonValueEditor
          value={props.value}
          mixed={props.mixed}
          strict
          placeholder={props.placeholder}
          onCommit={props.onCommit}
        />
      );
    default:
      return (
        <TextValueEditor
          value={props.value}
          mixed={props.mixed}
          placeholder={props.placeholder}
          onCommit={props.onCommit}
        />
      );
  }
}

/* ============================================================
 * 检视器行（标签 + 控件 / 状态文案）
 * ============================================================ */

/** 节点参数行（ParamSpec 驱动） */
export function ParamFieldRow(props: {
  param: ParamSpec;
  value: unknown;
  mixed?: boolean;
  onCommit: (value: unknown) => void;
}) {
  const kind = paramEditorKindOf(props.param);
  return (
    <div className="bp-det-row">
      <span className="bp-det-label" title={props.param.label}>
        {props.param.label}
      </span>
      <div className="bp-det-control">
        <ValueEditor
          kind={kind}
          value={props.value}
          mixed={props.mixed}
          options={props.param.options}
          onCommit={props.onCommit}
        />
      </div>
    </div>
  );
}

/**
 * 引脚默认值行（未连线数据输入引脚）：
 * 已连线 → 「已连线」置灰；无内联编辑器的类型 → 只读值显示。
 */
export function PinDefaultRow(props: {
  pin: PinSpec;
  /** 已写入的默认值（IRNode.pinDefaults[pin.id]，未写入为 undefined） */
  written: unknown;
  connected: boolean;
  onCommit: (value: unknown) => void;
}) {
  const kind = pinEditorKindOf(props.pin);
  const value = props.written !== undefined ? props.written : props.pin.defaultValue;
  const label = props.pin.label ?? props.pin.id;
  return (
    <div className="bp-det-row">
      <span className="bp-det-label" title={label}>
        {label}
      </span>
      <span className="bp-det-type">{props.pin.type}</span>
      <div className="bp-det-control">
        {props.connected ? (
          <span className="bp-det-linked" title="该引脚已连线，默认值由连线传入">
            已连线
          </span>
        ) : kind === null ? (
          <span className="bp-det-readonly" title="该类型不提供内联默认值编辑">
            {displayValue(value)}
          </span>
        ) : kind === 'json' ? (
          <JsonValueEditor
            value={value}
            strict={pinJsonStrict(props.pin)}
            placeholder={props.pin.defaultValue !== undefined ? displayValue(props.pin.defaultValue) : undefined}
            onCommit={props.onCommit}
          />
        ) : (
          <ValueEditor
            kind={kind}
            value={value}
            options={props.pin.options}
            placeholder={props.pin.defaultValue !== undefined ? String(props.pin.defaultValue) : undefined}
            onCommit={props.onCommit}
          />
        )}
      </div>
    </div>
  );
}
