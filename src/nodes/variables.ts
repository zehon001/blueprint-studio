/**
 * Blueprint Studio v2 —— 变量节点（无头紧凑，PLAN §13.1 variables / §6 变量）
 *
 * 暴露变量的 Get/Set 节点由编辑器按 IRVariable.exposed 自动生成实例
 * （PLAN §6 / §9.2），本模块只提供按名读写的通用节点本体。
 */
import type { NodeSpec } from '../ir/types';
import { defineNode, execIn, execOut, dataOut, strOf } from './spec';

/* ----------------------------------------------------------------- var.get */
export const get = defineNode({
  id: 'var.get',
  title: '获取变量',
  category: '变量',
  keywords: ['get', 'getvar', '获取变量', '读取', '变量'],
  doc: '按 varName 读取资产变量（未声明变量返回 null）；可在检视器直接填变量名。',
  pure: true,
  params: [{ id: 'varName', label: '变量名', type: 'variable', default: '' }],
  inputs: [],
  outputs: [dataOut('value', 'any', '值')],
  run: (ctx) => {
    const value = ctx.getVar(strOf(ctx.params.varName));
    return { outputs: { value: value === undefined ? null : value } };
  },
});

/* ----------------------------------------------------------------- var.set */
export const set = defineNode({
  id: 'var.set',
  title: '设置变量',
  category: '变量',
  keywords: ['set', 'setvar', '设置变量', '写入', '赋值'],
  doc: '把 value 写入 varName 指定的资产变量，并从 value 出口透传（便于链式书写）。暴露变量的写入会同步到绑定 UI。',
  inputs: [execIn(), { id: 'value', type: 'any', label: '值', defaultValue: null }],
  outputs: [execOut(), dataOut('value', 'any', '值')],
  params: [{ id: 'varName', label: '变量名', type: 'variable', default: '' }],
  run: (ctx, inputs) => {
    const value = inputs.value === undefined ? null : inputs.value;
    ctx.setVar(strOf(ctx.params.varName), value);
    return { next: 'exec', outputs: { value } };
  },
});

export const variableNodes: NodeSpec[] = [get, set];
