/**
 * Blueprint Studio v3.3 —— 结构体节点（ADR-019）
 *
 * 与 UE 的 Make / Break Struct 对应：
 *  - `struct.make`：按资产 types 表动态生成字段输入脚，输出结构体对象；
 *  - `struct.break`：输入结构体对象，按字段表动态生成输出脚。
 * 引脚由 `params.typeName` + `IRAsset.types` 在视图 / 校验 / 解释器侧共同展开
 * （见 src/ir/structs.ts），本文件的静态 spec 只声明参数与节点元信息。
 */
import type { NodeSpec } from '../ir/types';
import { defineNode, objOf } from './spec';

/* --------------------------------------------------------- struct.make */
export const structMake = defineNode({
  id: 'struct.make',
  title: '创建结构体',
  category: '结构体',
  keywords: ['struct', 'make', 'structure', '结构体', '创建结构体', '构造', '对象'],
  doc: '按选定的自定义结构体创建对象：输入引脚 = 结构体字段；未连线字段使用字段默认值。',
  pure: true,
  params: [
    {
      id: 'typeName',
      label: '结构体类型',
      type: 'structType',
      default: '',
      group: '结构体',
    },
  ],
  inputs: [],
  outputs: [],
  run: (_ctx, inputs) => ({ outputs: { value: { ...inputs } } }),
});

/* -------------------------------------------------------- struct.break */
export const structBreak = defineNode({
  id: 'struct.break',
  title: '拆分结构体',
  category: '结构体',
  keywords: ['struct', 'break', 'structure', '结构体', '拆分结构体', '拆解', '字段'],
  doc: '把结构体对象拆成字段：输出引脚 = 结构体字段；缺失字段回落字段默认值（再回落 null）。',
  pure: true,
  params: [
    {
      id: 'typeName',
      label: '结构体类型',
      type: 'structType',
      default: '',
      group: '结构体',
    },
  ],
  inputs: [],
  outputs: [],
  run: (ctx, inputs) => {
    const typeName = typeof ctx.params?.['typeName'] === 'string' ? ctx.params['typeName'] : '';
    const def = ctx.types?.find((t) => t.name === typeName);
    if (!def) return { outputs: {} };
    const obj = objOf(inputs.value);
    const outputs: Record<string, unknown> = {};
    for (const field of def.fields) {
      const value = obj[field.name];
      outputs[field.name] = value === undefined ? (field.default ?? null) : value;
    }
    return { outputs };
  },
});

export const structNodes: NodeSpec[] = [structMake, structBreak];
