/**
 * Blueprint Studio v3.3 —— 类型选择器（ADR-019）
 *
 * 变量 / 函数入参 / 函数返回值 / 事件参数共用的类型下拉：
 *  - 基础类型（bool / int / float / string / object / any）；
 *  - 基础类型数组（string[]、int[] …）；
 *  - 资产内用户自定义结构体与结构体数组（IRStructDef[]）。
 *
 * 只依赖 IR 类型，不 import 样式（node:test 可直接挂载冒烟）。
 * 当前值不在选项表内（旧资产里手写的插件类型别名，如 LogRow）时保留一条
 * 「自定义」选项，避免打开资产后类型被下拉框吞掉。
 */
import type { CSSProperties } from 'react';
import type { IRStructDef, IRValueType } from '../ir/types';

/** 一组类型选项（渲染为 <optgroup>） */
export interface TypeOptionGroup {
  label: string;
  options: { value: IRValueType; label: string }[];
}

/** 基础类型（exec 不在变量 / 参数可选范围内） */
const PRIMITIVES: { value: IRValueType; label: string }[] = [
  { value: 'bool', label: '布尔 (bool)' },
  { value: 'int', label: '整数 (int)' },
  { value: 'float', label: '浮点 (float)' },
  { value: 'string', label: '字符串 (string)' },
  { value: 'object', label: '对象 (object)' },
  { value: 'any', label: '任意 (any)' },
];

/** 构建类型选项分组（结构体来自当前资产 types 表） */
export function typeOptionGroups(types?: readonly IRStructDef[]): TypeOptionGroup[] {
  const groups: TypeOptionGroup[] = [
    { label: '基础类型', options: PRIMITIVES },
    {
      label: '数组',
      options: PRIMITIVES.map((p) => ({ value: `${p.value}[]` as IRValueType, label: `${p.label} 数组` })),
    },
  ];
  if (types && types.length > 0) {
    groups.push({
      label: '结构体',
      options: types.map((t) => ({ value: t.name, label: `结构体：${t.name}` })),
    });
    groups.push({
      label: '结构体数组',
      options: types.map((t) => ({ value: `${t.name}[]` as IRValueType, label: `结构体数组：${t.name}` })),
    });
  }
  return groups;
}

/** 某类型是否在可选表中（含当前值兜底判断） */
export function isKnownTypeOption(type: IRValueType, types?: readonly IRStructDef[]): boolean {
  return typeOptionGroups(types).some((g) => g.options.some((o) => o.value === type));
}

/** 类型显示名（选择器 / 徽标 tooltip 共用；未知类型原样） */
export function typeOptionLabel(type: IRValueType, types?: readonly IRStructDef[]): string {
  for (const group of typeOptionGroups(types)) {
    const hit = group.options.find((o) => o.value === type);
    if (hit) return hit.label;
  }
  return String(type);
}

export function TypeSelect(props: {
  value: IRValueType;
  onChange: (type: IRValueType) => void;
  types?: readonly IRStructDef[];
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const groups = typeOptionGroups(props.types);
  const all = groups.flatMap((g) => g.options.map((o) => o.value));
  const current = props.value ?? '';
  const custom = current !== '' && !all.includes(current);
  return (
    <select
      className={props.className}
      style={props.style}
      value={current}
      aria-label={props.ariaLabel ?? '类型'}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as IRValueType)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {current === '' ? <option value="">（选择类型）</option> : null}
      {custom ? <option value={current}>{`自定义：${current}`}</option> : null}
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
