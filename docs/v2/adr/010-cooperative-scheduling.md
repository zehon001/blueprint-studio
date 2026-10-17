# ADR-010：协作式调度（多次出脚让出点派发积压事件）+ UI 事件来源节点注入

> 状态：已采纳（2026-10-18）· 发起：Arch（单会话模式）· 影响：T2.5 解释器 / T5.1 事件总线 / T13.1 节点库（event.custom 出脚、event.timer doc）· 增补 ADR-005 §串行队列语义与 ADR-008

## 背景

### 问题 1：无条件循环饿死串行事件队列（实机评估反馈）

用户蓝图「开始 → 定时器（间隔 5s，循环 ✓）」+「按钮 pressed → 打印」：运行窗口点击按钮**永不触发**、也无任何报错。逐段探针定位（DOM → onEvent → 总线 deliver → 实例接收全部正常）后确认根因：

- ADR-005 事件泵为严格串行（一次一条链跑完才取下一条，UE GameThread 同语义）；
- ADR-008 的 timer / whileLoop 走 async generator，`runChain` await 整个 generator 生命周期——**无条件循环的链永不返回**；
- 后果：其它事件（UI pressed / 自定义事件）在 `pending` 队列中无限滞留。ADR-008 曾在 timer 节点 doc 记录为「已知限制」，但实机表现是静默失效，用户无法自诊。

### 问题 2：同一蓝图绑定多控件时无法区分事件来源（实机评估反馈）

用户给两个按钮挂同一份蓝图后，两颗按钮的 pressed 触发同一条链——事件路由（target='node'）只决定「投递给哪个 runtime」，蓝图内部入口只按事件名匹配（`event.custom` 的 `params.eventName`），载荷中不含来源节点名（pressed 无 payload，`routeEvent` 只包 `{value}`）。一份蓝图无法按来源分派，只能每控件一份蓝图。

## 决策

### 1. 协作式调度：unlimitedFires 节点的 yield 边界 = 让出点

解释器 `driveGenerator` 在每次 yield 的出脚子链**完整执行后、向 generator 请求下一 yield 前**，插入协作检查点 `coopDrainPending()`：

- 仅 `spec.unlimitedFires === true` 的节点（timer / whileLoop，ADR-008）触发检查点；有限 generator（forLoop / forEach / sequence）保持旧阻塞语义（迭代确定性不引入事件穿插）。
- 检查点逐条 `shift()` 派发积压事件，`await` 每条事件的目标链**完整执行**——FIFO 保序与「一次一条链」的串行语义不变。
- **嵌套不派发**（`coopDepth` 守卫，仅顶层让出点派发）：被派发事件的链内部再遇让出点不递归，防止「无限链套无限链」的派发栈失控；该场景回落 ADR-008 旧语义（阻塞）。
- 效果：循环运行中，其它事件的最迟派发延迟 ≈ 让出节点的产出间隔（timer 即 interval 秒）；事件不再静默饿死。
- `stop()` 语义不变：清队 + abort，让出点检查 `running` 后即停。

### 2. UI 事件注入来源节点名（`sourceNode`）

- 事件总线 `routeEvent` 在 args 中注入 `sourceNode = 来源 UI 节点名`（可见键，非 `__` 标记键、不剥离——业务蓝图允许按名读取）。
- 解释器 `buildEventOutputs`：`sourceNode` 不参与 arg0~arg2 位置映射（避免挤压业务参数槽位），仅经散键兜底注入同名出脚；`event.listen` 的 `args` 对象自然携带。
- `event.custom` 节点新增静态出脚 `sourceNode: string`（「来源节点」），画布可见可连线；系统 / 插件 / 自定义（event.send）事件源不注入，该脚值为 undefined。
- 用法：同一蓝图绑定子树内多控件时，「来源节点」脚接 `flow.branch` / `switch` 按名分派——单蓝图多按钮各自行为不再需要每控件一份资产。

## 后果

- **正向**：循环定时器 + 交互事件共存可用（用户场景「轮询 + 按钮」成立）；单蓝图多控件分派成立；两类问题均从「静默失效」变为「按预期工作」。
- **代价**：让出点边界引入事件穿插的可能（仅 unlimitedFires 节点的 yield 之间）——依赖「循环期间无其它事件介入」的极特例蓝图行为会变（从饿死变为穿插）；有限循环语义零变化。
- **兼容**：IR / 序列化 / 节点契约零变更（event.custom 新增静态出脚为 spec 层增量，画布旧资产不受影响）；`sourceNode` 为新增可见键，未连线时不产生任何行为差异。
- 已知边界：被让出派发的链本身含无条件循环时，该链仍会阻塞其后的派发（嵌套不派发守卫）——表现为回到旧语义，不产生新故障；如需彻底解决需抢占式调度（另行 ADR）。

## 实现锚点

- `src/runtime/interpreter/interpreter.ts`：`coopDepth` 字段、`coopDrainPending()`、`driveGenerator` 尾部让出点、`buildEventOutputs` sourceNode 排除位置映射。
- `src/runtime/events/markers.ts`：`BUS_SOURCE_NODE_KEY`。
- `src/runtime/events/bus.ts`：`routeEvent` 注入。
- `src/nodes/events.ts`：`event.custom` 出脚 `sourceNode` + timer doc 更新。
