/**
 * Blueprint Studio v3.3 —— 结构体节点引脚解析（ADR-019）
 *
 * `struct.make` / `struct.break` 的引脚由资产 `types` 表 + 节点 `params.typeName`
 * 动态决定（与函数入口/出口的签名引脚同构）。本模块只做纯计算，供视图、校验、
 * 解释器与脚本生成共用，避免各处重复展开字段表。
 */
import type { IRNode, IRStructDef, PinSpec } from './types';
import { isArrayType, isPrimitiveType, structDefOf } from './types';

/** 结构体字段禁用名（避免对象字面量 / 属性访问触达原型链） */
export const RESERVED_STRUCT_FIELD_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);

/** 字段名是否安全（非空且不是原型链保留名） */
export function isSafeStructFieldName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && !RESERVED_STRUCT_FIELD_NAMES.has(trimmed);
}

/** 结构体名是否与内置类型 / 数组冲突（冲突会让类型选择器出现重复值） */
export function isReservedStructTypeName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === '') return true;
  // 'session' 为 Agent 会话类型（agent 插件），结构体不得占用该名
  return isPrimitiveType(trimmed) || isArrayType(trimmed) || trimmed === 'session';
}

export interface StructPins {
  inputs: PinSpec[];
  outputs: PinSpec[];
}

/** 字段表 → 数据引脚（id / label = 字段名；默认值 = 字段默认值） */
function fieldPins(def: IRStructDef): PinSpec[] {
  return def.fields.map((field) => ({
    id: field.name,
    label: field.name,
    type: field.type,
    ...(field.default !== undefined ? { defaultValue: field.default } : {}),
  }));
}

/**
 * 结构体节点 -> 动态引脚：
 *  - `struct.make`：输入 = 字段；输出 = value（类型 = 结构体名）；
 *  - `struct.break`：输入 = value（类型 = 结构体名）；输出 = 字段。
 * 未选类型 / 类型不存在 → undefined（视图只显示参数，校验器报错）。
 */
export function structPinsOf(
  node: Pick<IRNode, 'type' | 'params'>,
  types: readonly IRStructDef[] | undefined,
): StructPins | undefined {
  if (node.type !== 'struct.make' && node.type !== 'struct.break') return undefined;
  const typeName = node.params?.['typeName'];
  if (typeof typeName !== 'string' || typeName === '') return undefined;
  const def = structDefOf(types, typeName);
  if (!def) return undefined;
  if (node.type === 'struct.make') {
    return {
      inputs: fieldPins(def),
      outputs: [{ id: 'value', label: '结构体', type: typeName }],
    };
  }
  return {
    inputs: [{ id: 'value', label: '结构体', type: typeName }],
    outputs: fieldPins(def),
  };
}

/** 合并静态引脚与动态引脚（同 id 以静态为准；与视图 BPNode.mergePins 同口径） */
export function mergePinLists(base: readonly PinSpec[], extra: readonly PinSpec[] | undefined): PinSpec[] {
  if (!extra || extra.length === 0) return [...base];
  const seen = new Set(base.map((p) => p.id));
  return [...base, ...extra.filter((p) => !seen.has(p.id))];
}
