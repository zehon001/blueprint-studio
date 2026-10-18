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
import {
  displayValue,
  paramEditorKindOf,
  pinEditorKindOf,
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

/** 变量选择器（v3 T12.8）：下拉列出本资产变量（提升标记 ★） */
export function VariableValueEditor(props: {
  value: unknown;
  mixed?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}) {
  const variables = useBlueprintStore((s) => s.asset?.variables ?? []);
  const current = props.mixed || props.value === undefined ? '' : String(props.value);
  return (
    <select
      className={`${props.className ?? 'bp-det-select'}${props.mixed ? ' bp-det-input--mixed' : ''}`}
      value={current}
      aria-label="变量选择器"
      onChange={(e) => props.onCommit(e.target.value)}
    >
      <option value="">{props.mixed ? '—' : '（选择变量）'}</option>
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
    case 'color':
      return <ColorValueEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
    case 'variable':
      return <VariableValueEditor value={props.value} mixed={props.mixed} onCommit={props.onCommit} />;
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
        ) : (
          <ValueEditor
            kind={kind}
            value={value}
            placeholder={props.pin.defaultValue !== undefined ? String(props.pin.defaultValue) : undefined}
            onCommit={props.onCommit}
          />
        )}
      </div>
    </div>
  );
}
