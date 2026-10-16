# ADR-005：NodeRunContext 增补 ui / 系统钩子；循环与高阶节点的落地机制

> 状态：已采纳（2026-10-17）· 发起：Arch（PM 代执行，单会话模式）· 影响：T2.5 解释器 / T13.1 节点库 / T2.6 绑定运行

## 背景

T13.1（节点库）实现中发现两个执行契约缺口（原 ADR-003 未覆盖）：

1. `ui.*` 节点需要访问绑定 UI 子树，但 `NodeRunContext` 没有 UI 访问器。
2. `NodeRunResult.next` 单次只能激活一个 exec 出口，导致 `sequence`/`timer`/循环类节点无法在节点内「一次触发多次下游」。

## 决策

### 1. NodeRunContext 增补（本次采纳）

```ts
ui?: UiHandle            // { find(name): unknown; read(name, attr): unknown; write(name, attr, value): void }
notify?(message): void   // 系统通知钩子
clipboardWrite?(text): void
openUrl?(url): void
```

- 全部**可选**：解释器按运行能力注入（T2.6 绑定 UI 后注入 `ui`）；节点侧缺失时必须经 `ctx.print` 提示并安全降级，**不得抛错**。
- `UiHandle` 类型真源 = `src/ir/types.ts`；`src/nodes/spec.ts` re-export（不得重复声明）。

### 2. 多出口触发：暂不改契约（won't fix）

维持 `next?: string` 单出口语义。循环/多次触发类节点统一用 **「循环状态机」** 落地：节点持有内部状态（`src/nodes/spec.ts` 的状态槽，按 `ctx.nodeId` 隔离），用户把循环体链尾 exec 连回节点 exec 入即持续迭代，完成时走 done/stopped 出口。

- 解释器（T2.5）必须支持「同一节点 exec 入被反复触发」与「重跑/停止时复位节点状态」（复位调 `clearAllStateSlots()`，T13.1 已导出）。
- `sequence` 降级为续接触发语义；`whileLoop`/`gate` 无状态化（条件引脚每次触发重估）。
- 未来如需「一次触发 N 口按序」，走新 ADR 扩展 `next` 或提供解释器级子图回调，并顺带解锁真正的高阶 filter/map。

### 3. 其他裁定（T1.1 上报）

- UI 节点所有可编辑属性统一存 `UINode.props`（含 visible/tooltip）；`UINode.theme` 暂保留不使用，后续样式 token 覆盖需求走新 ADR。
- `splitContainer` 的分割比例属性定名 `splitPosition`（与 transform.position 撞名，禁用 `position`）。
- ADR-002 示例中 list 的内建事件名修正为 `selectionChanged` / `doubleClicked`。

## 变更影响

- T2.5：解释器需支持状态机节点的反复触发与复位；`opts` 预留 `ui` 注入口（T2.6 接线）。
- T13.1：`src/nodes/spec.ts` 的 UiHandle 改为 re-export（已完成）。
- 无存量资产需迁移（IR 未变）。
