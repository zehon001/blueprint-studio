/**
 * Blueprint Studio v2 —— 图级操作节点的编辑器补充 spec（T2.3）
 *
 * 背景：flow.call / func.entry / func.return 是解释器自有类型（T2.5 约定，
 * src/runtime/interpreter 的 OWNED_TYPES），不在 src/nodes/ 节点库中。
 * 编辑器侧若不补 spec：保存校验器会把它们判为 unknown-node **error**（新建函数图
 * 即无法 Ctrl+S 保存），画布上也只能以未知节点降级渲染。
 *
 * 本文件提供「编辑器补充 spec」（不进 src/nodes/，不改契约）：
 *  - 只声明 exec 骨架引脚与 flow.call 的目标函数参数，让校验 / 搜索 / 检视器可用；
 *  - 数据引脚（函数入参 / 返回值）由 IRGraph.params / returns **动态决定**，
 *    静态 spec 无法如实声明，本期不放假占位脚（占位脚会连错运行时引脚名），
 *    动态引脚渲染待 view 层后续支持（已汇报）；期间函数出入参在 Details 的
 *    「图接口」区编辑，图内经变量 / 手工连线兜底。
 *  - run 省略：编辑器从不执行节点；解释器对 OWNED_TYPES 走自有分支（不查 spec.run）。
 */
import type { NodeSpec } from '../../ir/types';
import { builtinSpecMap, defineNode, execIn, execOut } from '../../nodes';

/** 调用函数（caller 侧）：params.graph = 目标图名；解释器压独立栈帧执行 */
export const callFunctionSpec = defineNode({
  id: 'flow.call',
  title: '调用函数',
  category: '函数',
  keywords: ['call', 'callfunction', '调用函数', '函数调用', '子图'],
  doc: '调用同资产内的函数图：在检视器「目标函数」填函数名（My Blueprint 的函数列表右键「插入调用」可自动填好）。执行压独立栈帧；入参 / 返回值引脚由目标函数的接口声明动态决定。',
  inputs: [execIn()],
  outputs: [execOut()],
  params: [{ id: 'graph', label: '目标函数', type: 'string', default: '' }],
});

/** 函数子图入口（callee 侧）：输出 = 函数入参（由 IRGraph.params 动态决定） */
export const funcEntrySpec = defineNode({
  id: 'func.entry',
  title: '函数入口',
  category: '函数',
  keywords: ['entry', '函数入口', '入口', '入参'],
  doc: '函数子图入口：输出数据脚 = 函数入参（在无选中时的「图接口」区编辑，运行时由解释器按 IRGraph.params 注入）。',
  inputs: [],
  outputs: [execOut()],
});

/** 函数子图出口（callee 侧）：输入 = 返回值（由 IRGraph.returns 动态决定）；链终止 */
export const funcReturnSpec = defineNode({
  id: 'func.return',
  title: '函数出口',
  category: '函数',
  keywords: ['return', '函数出口', '出口', '返回值'],
  doc: '函数子图出口：输入数据脚 = 函数返回值（在无选中时的「图接口」区编辑，运行时由解释器按 IRGraph.returns 收集并交回调用方）。',
  inputs: [execIn()],
  outputs: [],
});

/** 图级操作节点的补充 spec（T2.5 解释器约定的编辑器侧映射） */
export const GRAPH_OP_SPECS: readonly NodeSpec[] = [callFunctionSpec, funcEntrySpec, funcReturnSpec];

/**
 * 编辑器用节点定义表：内置节点库 ∪ 图级操作补充 spec。
 * useBlueprintStore 默认 specs 与 T6.4 插件节点的合并基线都应使用本表，
 * 保证 flow.call / func.entry / func.return 可被校验、搜索与检视器编辑。
 */
export function editorSpecMap(): Map<string, NodeSpec> {
  const merged = new Map<string, NodeSpec>(builtinSpecMap);
  for (const spec of GRAPH_OP_SPECS) {
    if (!merged.has(spec.id)) merged.set(spec.id, spec);
  }
  return merged;
}
