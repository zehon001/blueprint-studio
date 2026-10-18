# ADR-013：元素系统契约（T11.2）

> 2026-10-18 · 状态：已采纳（渲染/实例部分）

- `.elem.json`：`ElementAsset { version:3, kind:'element', name, props?: ElementPropDef[], traits?, styles?, root, graphs?, variables? }`。
- 实例：`UINode { type:'__element', element: string, props: Record<string, unknown>, vars?: Record<string, unknown> }`；结构/type/container 取元素根；id/name/layout/transform 保留实例；props = 元素根 ∪ 自定义属性默认值 ∪ 实例覆盖；`vars` 仅保存（运行时合并随 M11+）。
- 加载：`src/ui-editor/element.ts`（项目相对路径；`@library/elements/<name>` 预留服务解析），预取缓存/并发去重/深度 8 层/循环检测；缺失/循环渲染占位。
- 渲染：`render.effectiveNode` 展开后走现有 23 控件渲染器与 flex;元素实例不提供断开物化。
- 已知偏差：元素自定义属性/事件/trats 的定义界面未做（最小版通过 JSON 编辑）；元素内部事件解释器随 T12.9。
