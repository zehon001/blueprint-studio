/**
 * Blueprint Studio v3 —— 反射 get/set 属性节点（PLAN §10.3 / TASKBOARD T12.6）
 *
 * 节点侧职责：
 *  1. `ui.getProp` / `ui.setProp`：落盘为通用节点（params: nodeName + propId），
 *     运行时经 ctx.ui 的 read / write 直读写图属主树节点属性；
 *  2. 反射条目生成纯函数（listReflectableProps / reflectionEntries）：供蓝图
 *     右键「设计器」分组后续按当前树实时生成 `Get <节点>.<属性>` / `Set ...` 条目。
 *
 * 边界（PLAN §10.3 + REVIEW 第 7 条）：反射只作用于图属主**自身树**，元素/预制体
 * 实例内部不透明、不下钻；可反射属性 = schema PropDef 显式 `reflect: true`。
 * 本模块不依赖 src/ui-editor（避免节点库 ↔ 编辑器循环依赖），schema 以结构化
 * 最小接口描述；`reflect` 字段按 ADR-018 约定读取。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataOut,
  strOf,
  probeUi,
  warnMissingHook,
  type NodeRunContext,
} from './spec';

/** 反射读取节点参数（缺失 / 非字符串 → ''，与 pin 的容错口径一致） */
function paramOf(ctx: { params: Record<string, unknown> }, id: string): string {
  return strOf(ctx.params?.[id]);
}

/** ui 句柄缺失时的统一降级提示（不抛错，执行链继续） */
function missingUi(ctx: NodeRunContext, node: string): void {
  warnMissingHook(ctx, 'ui', node);
}

/* ------------------------------------------------------------------ ui.getProp */
export const getProp = defineNode({
  id: 'ui.getProp',
  title: '获取节点属性',
  category: '界面',
  keywords: ['ui', 'getprop', '反射', '读取属性', '设计器', 'get', 'property'],
  doc: '按图属主树节点名 + 属性 id 运行时读取属性值（反射节点，仅 reflect:true 属性；元素/预制体内部不反射）。',
  params: [
    { id: 'nodeName', label: '节点名', type: 'string', default: '' },
    { id: 'propId', label: '属性 id', type: 'string', default: '' },
  ],
  inputs: [execIn()],
  outputs: [execOut(), dataOut('value', 'any', '值')],
  run: (ctx) => {
    const ui = probeUi(ctx);
    if (!ui) {
      missingUi(ctx, 'ui.getProp');
      return { next: 'exec', outputs: { value: null } };
    }
    const nodeName = paramOf(ctx, 'nodeName');
    const propId = paramOf(ctx, 'propId');
    if (!nodeName || !propId) {
      ctx.print('[ui.getProp] 未配置 nodeName / propId 参数，本节点已跳过');
      return { next: 'exec', outputs: { value: null } };
    }
    return { next: 'exec', outputs: { value: ui.read(nodeName, propId) ?? null } };
  },
});

/* ------------------------------------------------------------------ ui.setProp */
export const setProp = defineNode({
  id: 'ui.setProp',
  title: '设置节点属性',
  category: '界面',
  keywords: ['ui', 'setprop', '反射', '写入属性', '设计器', 'set', 'property'],
  doc: '按图属主树节点名 + 属性 id 运行时写入属性值（反射节点，仅 reflect:true 属性；元素/预制体内部不反射）。',
  params: [
    { id: 'nodeName', label: '节点名', type: 'string', default: '' },
    { id: 'propId', label: '属性 id', type: 'string', default: '' },
  ],
  inputs: [execIn(), { id: 'value', type: 'any', label: '值', defaultValue: null }],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) {
      missingUi(ctx, 'ui.setProp');
      return { next: 'exec', outputs: {} };
    }
    const nodeName = paramOf(ctx, 'nodeName');
    const propId = paramOf(ctx, 'propId');
    if (!nodeName || !propId) {
      ctx.print('[ui.setProp] 未配置 nodeName / propId 参数，本节点已跳过');
      return { next: 'exec', outputs: {} };
    }
    ui.write(nodeName, propId, inputs.value ?? null);
    return { next: 'exec', outputs: {} };
  },
});

/* ============================================================
 * 反射条目生成（纯函数，供蓝图右键菜单 T12.6 后续调用）
 * ============================================================ */

/** schema 属性声明的最小结构（PropDef 的结构子集；reflect 字段由 ADR-018 新增） */
export interface ReflectableProp {
  /** 属性 id（UINode.props / transform 的键） */
  id: string;
  /** 属性显示名（缺省回落 id） */
  label?: string;
  /** 是否可反射（仅 true 才生成 Get/Set 条目；默认 false） */
  reflect?: boolean;
}

/** 图属主树中的一个节点（仅反射所需字段；props 即该节点类型的 schema 属性表） */
export interface ReflectTargetNode {
  /** 树内唯一节点名（ui.getProp/setProp 的 nodeName） */
  name: string;
  /** 节点类型 id（如 'button'；元素实例为 '__element'） */
  type: string;
  /** 该节点类型的 schema 属性表；缺省 = 无 schema = 不产生条目 */
  props?: readonly ReflectableProp[] | null;
}

/** 一条反射菜单条目（同一属性供 Get / Set 两个菜单项复用） */
export interface ReflectionEntry {
  /** 目标节点名（落盘为节点 params.nodeName） */
  nodeName: string;
  /** 目标属性 id（落盘为节点 params.propId） */
  propId: string;
  /** 菜单显示名：`<节点名>.<属性显示名>` */
  label: string;
}

/**
 * 过滤出可反射属性：仅保留 `reflect === true` 的声明。
 * 无 schema（undefined / null / 非数组）→ 空数组，调用方无需判空。
 */
export function listReflectableProps<T extends { id: string; label?: string }>(
  schemaProps: readonly T[] | null | undefined,
): T[] {
  if (!Array.isArray(schemaProps)) return [];
  return schemaProps.filter((def) => (def as { reflect?: boolean }).reflect === true);
}

/**
 * 按图属主树节点清单生成反射条目（每节点 × 每个 reflect:true 属性一条）。
 * - 只处理传入清单（图属主自身树）；元素/预制体实例内部的展开由调用方负责
 *   不传入（边界见 PLAN §10.3）；
 * - 节点无 props / props 非数组 / 无 reflect:true → 不产生条目；
 * - 无 nodes（undefined / null / 空数组）→ 空数组。
 */
export function reflectionEntries(
  nodes: readonly ReflectTargetNode[] | null | undefined,
): ReflectionEntry[] {
  if (!Array.isArray(nodes)) return [];
  const entries: ReflectionEntry[] = [];
  for (const node of nodes) {
    if (!node || typeof node.name !== 'string' || node.name === '') continue;
    for (const def of listReflectableProps(node.props)) {
      if (!def || typeof def.id !== 'string' || def.id === '') continue;
      entries.push({
        nodeName: node.name,
        propId: def.id,
        label: `${node.name}.${def.label ?? def.id}`,
      });
    }
  }
  return entries;
}

/** 反射节点清单（注册到 src/nodes/index.ts 的 builtinSpecs） */
export const reflectNodes: NodeSpec[] = [getProp, setProp];
