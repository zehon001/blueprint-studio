# ADR-012：样式库契约与解析管线（T11.1）

> 2026-10-18 · 状态：已采纳（增量实现）

- `.uss.json`：`{ version:1, classes: Record<string, { props?, layout?, container? }> }`；不支持 `id/name/type/children/events` 与引用字段。
- `UINode.classes: string[]`；合并顺序 = schema 默认 → `styles` 数组顺序 → 表内 classes 声明顺序 → 节点内联 `props/layout/container`。内置表不隐式套用。
- 解析：`src/ui-editor/styles.ts`（parseStyleSheet / mergeStyledNode）；渲染器 `RenderOptions.styles` 在 `effectiveNode` 内合并；编辑视口/运行视图装载时读取 `asset.styles`（项目相对；`@library/*` 由 T11.4 服务解析）。
- 缺失类：`ref-style-missing`（T13.1 `validateUIAssetRefs`）。
- 已知偏差：检视器暂不显示「有效值来源高亮」；类编辑 UI 为最小版。
