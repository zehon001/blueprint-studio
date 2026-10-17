# ADR-003：NodeSpec（节点定义与运行契约）

| 状态 | 日期 | 关联卡 | 影响范围 |
|---|---|---|---|
| 已接受 | 2026-10-17 | T0.1 | `src/nodes/`（T2.x / Nodes-Agent）、`src/blueprint/`（渲染 / 校验）、`src/runtime/interpreter/`（T2.5）、`src/script/`（codegen / 沙箱） |

## 1. 决策内容

- 节点用**声明式 NodeSpec** 定义（PLAN §13.2，继承 v1.1 注册表模式），全部内置节点集中 `src/nodes/` 单目录：`spec.ts` 放类型与帮助函数，各分类模块（flow / events / math / …）定义节点，`index.ts` 唯一注册入口。扩展节点 = 新增分类模块 + 注册一行。
- **编辑器与运行窗口共用同一 NodeSpec 定义模块**：
  - 编辑器只读取 spec 结构（分类配色、引脚、参数、关键词）用于渲染与校验，**不执行 run**；
  - 运行窗口（IR 解释器 / 脚本沙箱）执行 `run`。
- 插件节点与内置节点**完全同权**：同一 NodeSpec 结构（加 `kind` 标记），运行时经 `src/nodes/dynamic.ts` 注册（见 ADR-004）。
- 对 PLAN §13.2 / §14.1 示意的两处**规范化**（本契约为准）：
  1. `PinSpec.type` 必填，exec 引脚显式写 `"type": "exec"`（示意中省略的写法无效）；
  2. select 型引脚：`type` 仍是值类型（通常 `"string"`），候选值用 `options: { value, label }[]` 表达——`"select"` 不是值类型，只是引脚上的 UI 呈现方式。

## 2. 结构定义

类型真源：[src/ir/types.ts](../../../src/ir/types.ts)。

| 类型 | 用途 |
|---|---|
| `NodeSpec` | 节点定义：id / title / category / keywords / inputs / outputs / params / pure / run / doc |
| `PinSpec` | 引脚：id / type / label / optional / multi / options / defaultValue |
| `ParamSpec` | 检视器参数（不参与连线）：id / label / type / options / default / group |
| `ParamType` | 检视器编辑器种类：number / string / bool / select / color（可扩展，须同步检视器实现） |
| `NodeRunFn` / `NodeRunContext` / `NodeRunResult` | 运行契约（见下） |

引脚 vs 参数的分工：**引脚**（`PinSpec`）参与连线，可在画布上内联编辑默认值（未连线时生效，初值 = `defaultValue`，运行值以 `IRNode.pinDefaults` 为准）；**参数**（`ParamSpec`）不参与连线，只在检视器编辑（运行值 = `IRNode.params`）。

## 3. 运行契约（NodeRunFn）

```ts
type NodeRunFn = (ctx: NodeRunContext, inputs: Record<string, unknown>) => NodeRunResult | Promise<NodeRunResult>;
```

执行语义（解释器 T2.5 按此实现）：

1. **inputs 组装**：已连线输入引脚取连线传值；未连线引脚取 `IRNode.pinDefaults[pin]`，缺省回落 `PinSpec.defaultValue`；`multi` 引脚把多条连线聚合为数组。
2. **ctx.params**：`IRNode.params` 与 `ParamSpec.default` 合并后的最终值。
3. **exec 出口选择**：`NodeRunResult.next` = 激活的 exec 出口引脚 id（如分支节点的 `'true' / 'false'`）；节点只有一个 exec 出口时可省略，解释器取唯一出口；纯节点忽略 `next`。
4. **异步支持**：返回 Promise 即异步节点（延时 / 插件调用 / CLI 桥）；解释器 `await` 该节点，但**不阻塞其他事件**（串行事件队列 + 旁路语义见 T2.5 / PLAN §11）。
5. **输出传播**：`NodeRunResult.outputs` 的键 = 输出 `PinSpec.id`，解释器据此沿数据边向下游传播。
6. **中止**：运行窗口关闭 / 手动停止时 `ctx.signal` 置位，长任务节点应响应并尽快返回。
7. **纯节点**：无 exec 引脚、无副作用（`pure: true`），解释器按需求值（可内联为表达式，codegen T3.5 依赖该性质）；exec 链不得穿过纯节点（编辑时拦截，校验器 T2.8 兜底）。

### 示例

```ts
// src/nodes/flow.ts（示意：分支节点）
import type { NodeSpec } from '../ir/types';

export const branch: NodeSpec = {
  id: 'flow.branch',
  title: '分支',
  category: '流程',
  keywords: ['if', '条件'],
  inputs: [
    { id: 'exec', type: 'exec' },
    { id: 'cond', type: 'bool', label: '条件', defaultValue: false },
  ],
  outputs: [
    { id: 'true',  type: 'exec', label: '真' },
    { id: 'false', type: 'exec', label: '假' },
  ],
  run: (_ctx, inputs) => ({ next: inputs.cond ? 'true' : 'false', outputs: {} }),
};
```

```ts
// src/nodes/string.ts（示意：select 型引脚 + 内联默认值 + 检视器参数）
import type { NodeSpec } from '../ir/types';

export const formatText: NodeSpec = {
  id: 'string.format',
  title: '格式化文本',
  category: '字符串',
  keywords: ['format', '拼接'],
  inputs: [{ id: 'exec', type: 'exec' }, { id: 'value', type: 'any', optional: true }],
  outputs: [{ id: 'exec', type: 'exec' }, { id: 'text', type: 'string' }],
  params: [
    { id: 'case', label: '大小写', type: 'select', group: '选项',
      options: [{ value: 'none', label: '不变' }, { value: 'upper', label: '全大写' }, { value: 'lower', label: '全小写' }],
      default: 'none' },
  ],
  run: (ctx, inputs) => ({ outputs: { text: String(inputs.value ?? '') /* 应用 ctx.params.case */ } }),
};
```

## 4. 变更流程

- **新增内置节点不需要 ADR**：按《节点开发指南》（T7.5）在 `src/nodes/` 新增分类模块 + `index.ts` 注册即可。
- 以下情况属于契约级变更，必须走 ADR：`NodeSpec` / `PinSpec` / `ParamSpec` 字段增删或语义修改、`NodeRunFn` 执行契约修改、`IRValueType` 值类型系统修改。
- 流程同 ADR-001 §4：Arch-Agent 落 ADR → PM 知会 → 修改 `src/ir/types.ts` → 受影响卡（蓝图渲染 / 解释器 / codegen / 校验器）跟进。

**遗留 / 预留（后续 ADR 扩展）**：

- `ParamType` 当前内置五种，扩展新编辑器种类（如向量、资源引用）须同步检视器实现并记 ADR。
- `multi` 引脚的运行时聚合细则（去重 / 展开 / 嵌套数组）由解释器 T2.5 定案。
- 事件型节点（`kind: 'event'`，见 ADR-004）的触发协议（事件总线 → 节点执行）由 T5.1 / T5.3 细化，不改本契约结构。
