# ADR-008：NodeRunFn 多次出脚（async generator）——循环/定时器/序列恢复 UE5 语义

> 状态：已采纳（2026-10-17）· 发起：Arch（单会话模式）· 影响：T2.5 解释器 / T13.1 节点库 / TA.1 roundtrip（仅 doc 文案）· **推翻 ADR-005 §2「won't fix」裁定**

## 背景

ADR-005 §2 曾裁定「多出口触发暂不改契约（won't fix）」，循环/定时器/序列统一用「循环状态机 + 链尾回连」落地：节点单次 run 只激活一个 exec 出口，用户须把循环体/tick 链尾 exec **连回节点自己的 exec 入**才能持续迭代。

实机验收（PM 浏览器走查 + 用户实际使用反馈）证明该语义存在致命缺陷：

1. **与 UE5 语义完全相反**：UE5 的 ForLoop 一次触发跑完全部迭代、Set Timer 设置后自动周期触发、Sequence 一次触发按序激活全部出口。「链尾回连」要求用户把链拆断再回连，与 UE5 用户肌肉记忆冲突。
2. **契约语义在画布上完全不可见**（只藏在节点 doc）：用户（UE5 背景）按 UE5 习惯搭图——「循环体 → 定时器 → 打印」不回连——结果循环只跑一次、定时器只触发一次，且无任何提示说明原因（用户原话：「不知道是不是用法错了」）。
3. ADR-005 当时的豁免条件是「未来如需一次触发 N 口按序，走新 ADR 扩展」——该未来条件已触发。

## 决策

### 1. NodeRunFn 返回类型扩展（契约变更，向后兼容）

```ts
export type NodeRunFn = (
  ctx: NodeRunContext,
  inputs: Record<string, unknown>,
) => NodeRunResult | Promise<NodeRunResult> | AsyncGenerator<NodeRunResult, void, unknown>;
```

- 返回 `AsyncGenerator` 的节点可在**一次 exec 触发内**多次（含异步多次）激活 exec 出脚。
- 仅限有 exec 出口的节点使用；纯节点（pure）禁止 generator。
- 同步 / Promise 返回的既有节点不受影响（不需要任何迁移）。

### 2. 解释器执行语义（T2.5）

节点 run 返回 generator 时，`runChain` 逐个 yield 驱动：

- 对每个 yield 的 `NodeRunResult`：先更新节点输出缓存（下游数据脚读到**本次**值，如递增的 index）→ `pickNext` → `followExec` → 递归 `runChain` 执行该出脚子链并 **await 其完整执行** → 再向 generator 请求下一个 yield。
- 语义要点：**出脚子链完整执行完才产生下一次出脚**（与 UE5「循环体执行完才下一迭代」一致）；循环体内可以安全地 await（如定时器、延时）。
- generator 走完后主链终止（后续出脚完全由 generator 决定）。
- `AbortSignal` 中止（stop）时对 generator 调 `return()` 并静默终止。
- **死循环保护**：解释器对同一节点的 yield 产出次数计数，超过 `maxSteps` 抛「疑似 exec 死循环」。

### 3. 重入保护（解释器持有，节点无状态化）

generator 运行期间，该节点实例 exec 入的**再触发被忽略**（解释器级 `activeGenerators: Set<nodeId>`，finally 清除）。动机：

- 旧「链尾回连」资产在 generator 一次性跑完的新语义下，回连边会在迭代中再次触发 exec 入——无保护则无限重启循环。忽略后回连边成为 **no-op**，旧资产安全降级，无需迁移。
- UE5 中循环运行期间再触发同样是未定义/忽略行为。

由此 `forLoop` / `whileLoop` / `sequence` / `timer` **不再需要状态槽**（完全无状态化）；`doOnce` / `flipFlop` / `gate` / `multiGate` 保持原样（单出口/状态机本就是其 UE5 语义）。

### 4. 受影响节点语义（T13.1）

| 节点 | 旧语义（回连状态机） | 新语义（generator） |
|---|---|---|
| `flow.forLoop` | 每次触发一迭代，循环体链尾连回 exec 入 | 一次触发跑完 from→to（含），每迭代等循环体子链完成；break 引脚每迭代求值；结束走 done |
| `flow.whileLoop` | 每次触发重新求值条件 | 一次触发内循环：条件真则执行循环体子链（链尾不再需要回连）再重估；假或 break 走 done |
| `flow.sequence` | out0 子链尾回连续接 out1… | 一次触发按序激活 out0→out3，每条子链完整执行后下一条 |
| `event.timer` | tick 链尾连回 exec 入持续计时 | loop=true 时一次触发自动持续 tick（每次 tick 等出脚子链完成）；cancel=true 启动时求值即走 stopped；stop 中止走 stopped |

**已知限制**（记录，后续 ADR 再议）：timer 的 `interval/loop/cancel` 引脚在 exec 触发时求值一次，tick 循环期间动态变化不感知（cancel 动态化需 ctx 增加输入重求值钩子）；timer 无条件循环 + 永不 stop 会持续占用该实例串行事件队列（与 ADR-005 串行语义一致，'timer' 系统事件滞留行为不变）。

### 5. 文案与可见性修复

- 各节点 doc 同步改写为「无需回连」；节点开发指南（T7.5）标注 generator 用法范例。
- 编辑器画布提示：循环节点「每次触发」字样按新语义校对（检视器/帮助浮层随 doc 自动更新，无需额外实现）。

## 变更影响

- `src/ir/types.ts`：NodeRunFn 类型。
- `src/runtime/interpreter/interpreter.ts`：runChain generator 分支、activeGenerators、yield 计数。
- `src/nodes/flow.ts` / `src/nodes/events.ts`：forLoop、whileLoop、sequence、timer 改 `run*`；multiGate/gate/flipFlop/doOnce/delay/branch 不动。
- `src/nodes/nodes.test.ts`：循环/序列/定时器用例按新语义重写；`interpreter.test.ts`：新增 generator 驱动、重入忽略、yield 计数保护用例。
- roundtrip（TA.1）：不受影响（IR 结构未变，仅节点 doc 文案变化）。
