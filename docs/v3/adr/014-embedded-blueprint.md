# ADR-014：UIAsset v3 内嵌蓝图与事件路由（T10.1/T10.3）

> 2026-10-18 · Arch-Agent · 状态：已采纳（类级图增量落地）

## 契约

- `UIAsset.graphs`: `Record<string, IRGraph & { kind:'event'|'function' }>`；恰有一张 `kind:'event'`（entry），其余函数图必须带 `params/returns`。
- `UIAsset.variables/events/layout`：内嵌蓝图变量 / 自定义事件 / 图视图状态（键 = 图名）。
- `logicAsset` 与 `UINode.logicAsset` 不再作为 v3 逻辑挂载方式；v2 资产仍按旧路径运行（兼容层），v3 资产有 `graphs` 时优先内嵌图。
- 保存 = 整资产一次落盘（树 + 图 + 变量 + 图视图）；`applyEmbeddedBlueprint` 写回时置 `version:3`。
- 编辑器：UI tab 顶栏「设计 | 蓝图」；蓝图模式复用 `BlueprintEditorPanel`，保存经 `applyEmbeddedBlueprint` + `saveUIAsset`。
- 运行时：`BindingRunner` 新增可选 `embedded: IRAsset`；给出时不再收集/加载 `logicAsset`，整棵 UI 树路由到该类级图（事件名 → `event.custom` 照旧）。无 `graphs` 时保持 v2 路径。

## 事件路由（当前实现范围）

- 根图解释器：`event.start/timer/custom` 按现有解释器语义执行；UI 内建事件经 `routeEvent` 投递到根图。
- 元素/预制体实例的解释器与 `sourceNode` 注入在 M11 元素系统（T11.2/T11.3）接入；本 ADR 先固定资产级契约。
- 变量提升：`IRVariable.exposed` 的变量出现在 UI 检视器「变量（提升）」区；场景改默认值；实例 `vars` 覆盖在 M11 消费。

## 影响与验证

- 新增 `src/ui-editor/embedded.ts`（⇄ IR 视图）、`VariableSection`、UI tab 双模式。
- 测试：`embedded.test.ts`（空图/写回）、`binding-embedded.test.ts`（不 fetch、start→print）。
- 回归：既有 959 测试全绿；v2 `.bp.json` 路径不变。
