/**
 * Blueprint Studio v2 —— 基础节点库唯一注册入口（ADR-003，PLAN §13）
 *
 * 扩展内置节点 = 新增分类模块 + 在下方 BUILTIN_GROUPS 登记一行；
 * 插件节点不经此处（由 src/nodes/dynamic.ts 运行时注入，ADR-004）。
 */
import type { NodeSpec } from '../ir/types';
import { flowNodes } from './flow';
import { eventNodes } from './events';
import { variableNodes } from './variables';
import { mathNodes } from './math';
import { stringNodes } from './string';
import { containerNodes } from './container';
import { convertNodes } from './convert';
import { uiNodes } from './ui';
import { reflectNodes } from './reflect';
import { systemNodes } from './system';

/** 内置节点定义基础设施（defineNode / 帮助函数 / 状态槽 / UiHandle） */
export * from './spec';
export { parseAndroidLogLine, type LogRow } from './convert';
/** 反射节点 + 反射条目生成纯函数（T12.6 节点侧；蓝图右键「设计器」分组后续调用） */
export {
  reflectNodes,
  getProp,
  setProp,
  listReflectableProps,
  reflectionEntries,
  type ReflectableProp,
  type ReflectTargetNode,
  type ReflectionEntry,
} from './reflect';

/** 各分类节点清单（顺序即注册顺序；去重由 builtinSpecMap 兜底） */
const BUILTIN_GROUPS: NodeSpec[][] = [
  flowNodes,
  eventNodes,
  variableNodes,
  mathNodes,
  stringNodes,
  containerNodes,
  convertNodes,
  uiNodes,
  reflectNodes,
  systemNodes,
];

/** 全部内置节点（按分类聚合；id 冲突时后者覆盖前者的告警在注册表层处理） */
export const builtinSpecs: NodeSpec[] = BUILTIN_GROUPS.flat();

/** 内置节点查找表（键 = NodeSpec.id，如 'flow.branch'） */
export const builtinSpecMap: Map<string, NodeSpec> = new Map(
  builtinSpecs.map((spec) => [spec.id, spec]),
);
