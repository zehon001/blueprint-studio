# Blueprint Studio v2 · 节点开发指南

> 面向扩展开发者：如何定义新的内置节点（`src/nodes/`）。
> 契约真源：`src/ir/types.ts`（NodeSpec / PinSpec / ParamSpec / NodeRunFn）· ADR-003 · **ADR-008（多次出脚）**。
> 基准版本：2026-10-17。示例代码逐条取自现行实现（`src/nodes/flow.ts` 等），可照抄。

---

## 1. 总览

- 节点用**声明式 NodeSpec** 定义，全部内置节点集中在 `src/nodes/` 单目录；`defineNode()` 是唯一定义写法。
- **编辑器与运行窗口共用同一 spec 模块**：编辑器只读 spec 结构（渲染 / 搜索 / 校验），**从不执行 `run`**；`run` 只在运行窗口（IR 解释器 / 脚本沙箱）被调用。
- 现有九分类 78 节点：流程 9 · 事件 5 · 变量 2 · 数学 18 · 字符串 11 · 容器 13 · 转换 8 · 界面 6 · 系统 6（其中 52 个纯节点）。

```
src/nodes/
  index.ts      # 唯一注册入口：BUILTIN_GROUPS 数组登记一行
  spec.ts       # defineNode / 引脚与输入帮助函数 / 状态槽 / 句柄探测
  flow.ts  events.ts  variables.ts  math.ts
  string.ts  container.ts  convert.ts  ui.ts  system.ts
  dynamic.ts    # 插件节点动态注册通道（见《插件开发指南》，不经 index.ts）
```

扩展一个**分类内**的新节点 = 在对应模块加一个 `defineNode` + 挂进该模块的导出数组（零注册行）；**新分类**见 §9。

## 2. NodeSpec 契约

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一。内置节点惯例 `'分类前缀.名称'`（如 `flow.branch`）；插件节点必须带插件前缀 |
| `title` | string | 节点头标题（`IRNode.title` 可按实例覆盖） |
| `category` | string | 头配色 + 右键搜索分组；内置九分类见 `NODE_CATEGORIES`（插件节点恒为「插件」，函数图为「函数」） |
| `keywords?` | string[] | 右键搜索模糊匹配词（中英文都给） |
| `inputs` / `outputs` | PinSpec[] | 引脚（含 exec）；exec 引脚**必须显式** `type: 'exec'` |
| `params?` | ParamSpec[] | 检视器参数（不参与连线） |
| `pure?` | boolean | 纯节点：无 exec 引脚、无副作用；解释器按需 + 记忆化求值，codegen 内联为表达式；**exec 链不得穿过纯节点**（编辑时拦截） |
| `run?` | NodeRunFn | 运行函数（§4）；省略 = 结构节点直通（输出空） |
| `doc?` | string | 节点说明：蓝图检视器与帮助浮层显示（写「无需回连」等新语义时同步改这里） |
| `unlimitedFires?` | boolean | **ADR-008**：合法无限产出的节点声明 `true`（如 whileLoop / timer），解释器跳过 yield 计数死循环保护（§5.2） |

### 2.1 PinSpec（引脚，参与连线）

| 字段 | 说明 |
|---|---|
| `id` | 同节点唯一；exec 入惯例 `'exec'`，多出口按语义命名（`'true'/'false'`、`'body'/'done'`） |
| `type` | 值类型：`exec / bool / int / float / string / object / any`、`T[]` 数组、自定义别名（如 `LogRow[]`、`file[]`） |
| `label?` | 显示名（省略显示 id） |
| `optional?` | 可选引脚未连线不阻塞执行 |
| `multi?` | 允许多条连线汇入，运行时聚合为数组（按边序） |
| `options?` | select 型引脚候选：**规范化决策——`type` 仍写 `'string'`，候选用 `options: {value,label}[]`**（`'select'` 不是类型） |
| `defaultValue?` | 未连线时的内联默认值（画布上可改，存 `IRNode.pinDefaults`） |

### 2.2 ParamSpec（检视器参数，不参与连线）

| 字段 | 说明 |
|---|---|
| `id` / `label` | 参数键（`IRNode.params` 的键）/ 显示名 |
| `type` | 编辑器种类：`number / string / bool / select / color`（扩展新种类须同步检视器并记 ADR） |
| `options?` / `default?` / `group?` | select 候选 / 初值 / 检视器分组 |

**引脚 vs 参数的分工**：引脚可在画布连线 + 内联编辑默认值；参数只在检视器编辑。运行时两者都由解释器合并后提供：输入引脚 → `inputs`；参数 → `ctx.params`（`IRNode.params` 与 `ParamSpec.default` 合并）。

## 3. defineNode 与帮助函数

`spec.ts` 提供速写帮助，减少样板：

```ts
import { defineNode, execIn, execOut, dataIn, dataOut, selectIn, selectParam, opts } from './spec';

export const branch = defineNode({
  id: 'flow.branch',
  title: '分支',
  category: '流程',
  keywords: ['branch', 'if', '条件', '分支', '判断', 'else'],
  doc: '条件为真走「真」出口，否则走「假」出口。',
  inputs: [execIn(), dataIn('cond', 'bool', '条件', false)],
  outputs: [execOut('true', '真'), execOut('false', '假')],
  run: (_ctx, inputs) => ({ next: inputs.cond ? 'true' : 'false', outputs: {} }),
});
```

- 引脚速写：`execIn(id?, label?)` / `execOut(...)` / `dataIn(id, type, label?, defaultValue?, extra?)` / `dataOut(id, type, label?)` / `selectIn(id, options, label?, default?)`。
- select 参数速写：`selectParam(id, label, options, default, group?)`；候选速写 `opts(['value', '标签'], ...)`。
- **输入容错帮助（所有 run 必须容错，缺失 / 类型不对取安全默认值，不抛错）**：`numOf(v, fallback=0)`、`intOf(v, fallback=0)`、`strOf(v)`、`boolOf(v, fallback=false)`（宽松：'true'/'1'/'yes'/'on'）、`arrOf(v)`（非数组 → `[]`，**不**把标量误包成单元素数组）、`objOf(v)`。

**降级纪律**：解释器按运行能力注入钩子（`ui` / `notify` / `clipboardWrite` / `openUrl` / `readProjectFile` / `callPlugin`），节点必须探测缺失并**经 `ctx.print` 提示后安全降级**（放行 exec 链 / 输出默认值），保证蓝图可跑不崩。参考 `spec.ts` 的 `probeUi` / `probeHook` / `warnMissingHook` 与 `ui.ts`、`system.ts` 的写法。

## 4. run 的三种形态（ADR-008）

```ts
type NodeRunFn = (ctx: NodeRunContext, inputs: Record<string, unknown>)
  => NodeRunResult | Promise<NodeRunResult> | AsyncGenerator<NodeRunResult, void, unknown>;
```

`NodeRunResult = { next?: string; outputs: Record<string, unknown> }`：
- `next` = 激活的 exec 出口引脚 id；节点只有一个 exec 出口时可省略；多出口不返回 `next` 会抛错；纯节点忽略 `next`。
- `outputs` 的键 = 输出 PinSpec.id，解释器沿数据边向下游传播（执行节点写入当前帧输出缓存；多次出脚节点每次 yield 都会刷新缓存）。

`inputs` 由解释器组装：已连线取连线传值（纯节点源按需递归求值 + 同一次求值内记忆化；执行节点源读帧缓存）；未连线取 `IRNode.pinDefaults`，缺省回落 `PinSpec.defaultValue`；multi 引脚聚合为数组。

### 4.1 形态一：同步

无 await 的判定型 / 计算型节点。见上例 `flow.branch`。

### 4.2 形态二：Promise（异步节点）

返回 Promise，解释器 await 该节点但**不阻塞其他事件**（串行事件队列 + print / debug 旁路）。典型：`flow.delay`（`await ctx.delay(ms)`，stop 时以 AbortError reject）、`system.readFile`（`await ctx.readProjectFile(path)`）、插件节点（`await ctx.callPlugin(...)`）。

### 4.3 形态三：async generator（多次出脚，ADR-008）

**一次 exec 触发内多次（含异步多次）激活 exec 出脚**。解释器 `driveGenerator` 逐 yield 驱动，语义要点：

1. 每个 yield 的 `NodeRunResult`：先更新输出缓存（下游读到**本次**值，如递增的 index）→ 选出口 → **递归执行该出脚子链并 await 完整跑完** → 才向 generator 请求下一个 yield（与 UE5「循环体执行完才下一迭代」一致；循环体内可安全 await）。
2. generator 走完主链终止；后续出脚完全由 generator 决定。
3. `ctx.signal` 中止（stop）时解释器对 generator 调 `return()` 静默终止；**节点内部也应在每轮循环检查 `ctx.signal.aborted`**。
4. **重入保护**：generator 运行期间该节点实例 exec 入的再触发被解释器忽略（`activeGenerators: Set<nodeId>`）——旧「链尾回连」资产的回连边自动成为 no-op，无需迁移。
5. **仅限有 exec 出口的节点**；纯节点返回 generator 直接抛错。
6. 死循环保护：未声明 `unlimitedFires` 的节点 yield 超过 `maxSteps`（默认 100_000）抛「疑似 exec 死循环」。

最小范本（`flow.forLoop` 节选）：

```ts
run: async function* (ctx, inputs) {
  const step = intOf(inputs.step, 1) || 1;
  let cur = intOf(inputs.from, 0);
  const to = intOf(inputs.to, 9);
  let brk = boolOf(inputs.break);
  while (!stepExceeded(cur, to, step) && !brk) {
    if (ctx.signal.aborted) return;               // stop：静默收链
    yield { next: 'body', outputs: { index: cur } }; // 每迭代等子链跑完才继续
    cur += step;
    if (ctx.reinputs) {                            // break 引脚每迭代重估（§6）
      try { brk = boolOf((await ctx.reinputs()).break); } catch { /* 沿用上次值 */ }
    }
  }
  yield { next: 'done', outputs: { index: cur } };
},
```

写法约束：generator 必须是 `async function*`（`run: async function* (ctx, inputs) {...}`，现库统一写法）或对象方法简写 `async *run(ctx, inputs) {...}`；普通箭头函数写不出 async generator，别用 `run: async (ctx, inputs) => {...}` 的直觉套在多次出脚节点上。

## 5. NodeRunContext 全字段

| 字段 | 说明 | 注入方 |
|---|---|---|
| `nodeId` | 当前节点实例 id（状态槽隔离键 / 调试观察） | 解释器恒注入 |
| `params` | 检视器参数最终值（`IRNode.params` ∪ `ParamSpec.default`） | 恒注入 |
| `getVar(name)` / `setVar(name, v)` | 资产变量读写（函数帧内 `getVar` 先查帧入参；`setVar` 共享资产存储，暴露变量写入同步 UI） | 恒注入 |
| `emit(event, params?)` | 发送事件（入串行队列，处理中调用只排队不递归） | 恒注入 |
| `print(...parts)` | 打印到运行窗口控制台（旁路直调，不入队） | 恒注入 |
| `delay(ms)` | 异步延时（毫秒；stop 时 AbortError reject） | 恒注入 |
| `signal` | 运行中止信号：**长任务 / generator 节点必须响应 `signal.aborted`** | 恒注入 |
| `reinputs?()` | **ADR-008**：重新求值当前节点输入引脚（§6） | 解释器恒注入，缺失时降级用触发时值 |
| `ui?` | UI 访问器 `find/read/write`（作用域 = 绑定节点子树） | 绑定运行时注入；缺失必须降级 |
| `readProjectFile?(path)` | 读项目内文件文本（相对项目根） | 绑定运行时注入 |
| `notify?` / `clipboardWrite?` / `openUrl?` | 系统钩子 | 运行窗口按能力注入；缺失降级 |
| `projectName?` / `callPlugin?` | 插件 CLI 桥（节点 run / 脚本 plugins.* 共用）；约定失败也 resolve（`ok:false`），不 reject | 仅插件节点 run 被包装注入（ADR-005 附加扩展） |

## 6. 状态槽 getStateSlot 的适用场景

**ADR-008 之后，循环 / 序列 / 定时器类节点不再需要状态槽**（forLoop / whileLoop / sequence / timer / forEach 已完全无状态化：迭代进度由 generator 局部变量持有）。状态槽现在只适用于**「单出口但行为依赖历史触发」**的节点——即 UE5 中本就带状态的那些：

| 节点 | 持有的状态 |
|---|---|
| `flow.flipFlop` | 下次走 A 还是 B |
| `flow.doOnce` | 是否已触发过（reset 引脚复位） |
| `flow.multiGate` | 下一个出口序号（loop / reset） |
| `flow.gate` | （open 接变量的数据驱动形态，无槽，仅列作对照） |

用法（按 `ctx.nodeId` 隔离）：

```ts
run: (ctx, inputs) => {
  const slot = getStateSlot<{ next: number }>(ctx.nodeId, () => ({ next: 0 }));
  const cur = slot.next;
  slot.next = (cur + 1) % 4;
  return { next: `out${cur}`, outputs: {} };
},
```

- 复位单个节点：`clearStateSlot(nodeId)`；**运行窗口 stop / 重跑整个资产时解释器会调用 `clearAllStateSlots()` 复位全部**（创建实例时也会复位一次）——节点自身无须处理 stop。
- 状态槽是模块级 Map，节点务必只存可变小对象，不要缓存跨运行有效的句柄。

## 7. unlimitedFires 与 reinputs（ADR-008 配套）

### 7.1 unlimitedFires

`unlimitedFires: true` 声明「本节点合法地可能无限次出脚」，解释器跳过 yield 计数保护。当前使用方：`flow.whileLoop`（条件循环可无限）、`event.timer`（持续 tick）。**新节点只在「确属合法无限产出」时声明**；有限节点（forLoop / sequence / forEach）不声明，让解释器的 yield 计数保护兜底 exec 死循环。无限节点自身必须保证可退出路径：响应 `ctx.signal.aborted`、提供 break / cancel 引脚（每迭代经 reinputs 重估）。

### 7.2 reinputs（输入重估）

generator 节点的 `inputs` 是**触发时**求值的一次性快照；循环期间接在输入引脚上的变量 / 纯链可能已变。`await ctx.reinputs()` 按 spec 输入引脚**重新组装一次 inputs**（独立记忆化上下文：纯链重新执行、执行节点读帧缓存、`var.get` 读最新值），返回 `Record<引脚id, 值>`。当前使用方：

- `flow.whileLoop`：每迭代重估 `cond` / `break`（条件接 `获取变量` 即动态退出）。
- `flow.forLoop` / `array.forEach`：每迭代重估 `break`（`from` / `to` / `step` / 数组本体启动时定型）。
- `event.timer`：每 tick 重估 `interval` / `loop` / `cancel`（接变量可动态调速 / 停止）。

容错写法恒定：`ctx.reinputs` 缺失（理论不发生）或抛错时沿用上次值，不中断循环。

## 8. roundtrip 样例入库义务（门禁）

`npm run roundtrip`（`tests/roundtrip/`）是硬门禁：`IR → codegen(TS) → parse → IR'` 幂等，且「新增内置节点必须补样例入库」——**不补样本也不登记豁免清单，门禁直接红灯**（`auditCoverage` 计数恒等式：总数 = 已测 + 已知跳过）。

新节点入库两步（详见 `tests/roundtrip/README.md`）：

1. **样本构造进 `tests/roundtrip/samples.ts`**：
   - 纯节点（`pure: true`）：**无需动作**——`pureNodeSample(specId)` 自动覆盖（52 个纯节点走此路径）。
   - 执行节点：在 `execNodeSampleDefs` 加一条 `{ id, build, note }` 最小图构造器（事件入口 → 本节点 → `system.print`，按 codegen 映射形态接线；现库 18 条范本可抄）。
2. **无法往返时登记 `KNOWN_UNMAPPED_NODE_IDS`** 并注明原因（当前 8 项：`flow.gate` / `flow.flipFlop` / `flow.doOnce` / `flow.multiGate` / `event.timer`——状态机类，无线性语句形态；`system.notify` / `system.clipboardWrite` / `system.openUrl`——解释器钩子类，脚本视图暂无对应全局）。缺口修复后移出清单并补样本。

门禁红灯排查顺序：`missing`（新节点未入库）→ `stale`（清单陈旧）→ 具体样本的「首差异」JSON 路径。

## 9. 新分类接入步骤

以新增分类「网络」为例：

1. 新建 `src/nodes/net.ts`：`import { defineNode, ... } from './spec';` 逐个 `defineNode`，末尾 `export const netNodes: NodeSpec[] = [ ... ];`。
   - 分类名需加入 `spec.ts` 的 `NodeCategory` 联合类型与 `NODE_CATEGORIES` 数组（决定右键搜索分组顺序；节点头配色 token 在 `src/shell/theme/` 补一类色）。
2. `src/nodes/index.ts`：`import { netNodes } from './net';` 并在 `BUILTIN_GROUPS` 数组登记一行（同 id 冲突由 `builtinSpecMap` 兜底：后注册者覆盖）。
3. 补单测（参考 `src/nodes/nodes.test.ts`：run 输入容错、出口选择、降级路径）。
4. **roundtrip 入库**（§8）：纯节点自动覆盖；执行节点在 `execNodeSampleDefs` 加最小图；暂无法往返登记 `KNOWN_UNMAPPED_NODE_IDS`。
5. 若节点需要新的 ctx 钩子 / 引脚类型 / ParamSpec 种类 → 属契约级变更，先走 `docs/v2/adr/` 落 ADR 再改 `src/ir/types.ts`。普通新增节点**不需要 ADR**。
6. 全量回归：`npm run typecheck && npm test` + `npm run roundtrip`。

## 10. 校验器与编辑器补充 spec（了解即可）

- 保存校验器（`src/ir/validate.ts`）按 spec 检查：`unknown-node`、`duplicate-node-id`、`unconnected-required-input`、`dangling-exec`、`exec-through-pure`、`type-mismatch` / `narrowing-conversion`、`broken-edge`、`event-def-missing`、`event-no-entry`、`unused-variable`。节点的 `optional` 引脚豁免悬空检查。
- 解释器自有三个「图级操作」类型不在节点库（`flow.call` / `func.entry` / `func.return`），由 `src/blueprint/my-blueprint/graph-op-specs.ts` 提供**编辑器补充 spec**（声明 exec 骨架，`run` 省略——解释器走自有分支）。你的节点若声明了 `run` 就会被正常执行，无须关心这套机制。
- 数据引脚类型可赋值规则（`isTypeAssignable`）：同型 / 一侧 any / int→float / 数组同形元素可赋值；其余需显式转换节点（编辑器拖线自动插入）。

## 11. 与 PLAN / ADR 的差异注记

- ADR-005 曾裁定「多出口触发用链尾回连状态机」，**已被 ADR-008 推翻**：`src/nodes/flow.ts` 顶部残留的旧「循环状态机」注释是历史遗留，实际实现（forLoop / whileLoop / sequence 的 generator + timer）以 ADR-008 为准；只有单出口状态节点（gate / flipFlop / doOnce / multiGate）仍用状态槽。
- `tests/roundtrip/samples.ts` 头注释写「17 可往返执行节点」，实际 `execNodeSampleDefs` 已是 18 条（B11 新增 `system.readFile` 后计数注释未同步）——门禁按真实数组计数，不受影响。
- `src/runtime/interpreter/interpreter.ts` 头注释引用的 ADR-005 语义描述同样是历史文本，现行行为以 `driveGenerator` 与本指南 §4.3 为准。
