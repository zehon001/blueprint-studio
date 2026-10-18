# ADR-018：类型化元素引用、trait 与反射（T12.4~T12.7）

> 2026-10-18 · 状态：已采纳

## 决策

1. **UiHandle 值类型**
   - `IRValueType` 新增字符串形态 `uiHandle` / `uiHandle<trait[,trait]>`；
   - `isTypeAssignable(from, to)`：目标 trait 必须全部由源提供；裸 `uiHandle`（未声明 trait）
     视为宽松兼容，避免旧资产/`ui.get` 静态输出被误判；
   - 运行时句柄仍是 `UiHandle` 接口（`find/read/write`），类型串只影响连线/菜单过滤。

2. **trait 声明**
   - 23 内置控件在 `src/ui-editor/schema/index.ts` 的 `UI_TYPE_TRAITS` 集中声明
     （text/value/items；容器不声明）；
   - `ElementAsset.traits` 为元素实例对外暴露的能力；元素实例内部不透明；
   - UI 访问器节点入参类型改为 `uiHandle<text|value|items>`（`ui.setText/setTitle`、
     `ui.setValue`、`ui.listSetItems`）；`ui.get` 输出 `uiHandle`。

3. **选择器**
   - `ui.get.target` 与所有 UI 访问器 `name` 引脚使用图属主自身树下拉；
   - 按访问器所需 trait 过滤（元素用 `ElementAsset.traits`，预制体用根类型 traits）；
   - 元素/预制体实例整体可选，内部节点不下钻；无 UI 树（独立 `.bp.json`）退回文本输入；
   - 已选节点删除由 `ref-node-missing` 报错。

4. **反射**
   - `PropDef.reflect` 白名单集中在 `UI_REFLECT_PROPS`（内容/值/数据类属性）；
   - 元素/预制体实例整体暴露 `name/visible`（运行时 `ui.read/write` 特判 name）；
   - 反射节点仍为通用 `ui.getProp/setProp`（nodeName + propId），元素/预制体内部不反射。

5. **连线过滤**
   - PinDrag 菜单按源/目标 trait 过滤；连接类型校验复用 `isTypeAssignable` 的 UiHandle 规则；
   - 自动转换节点不把普通 string 隐式转成 UiHandle（需显式 `ui.get`）。

## 后果

- `ui.setText` 等节点仍接受未声明 trait 的裸 `uiHandle`（兼容旧资产），但菜单会按 trait
  优先列出具 text 的控件；后续可在保存校验中收紧。
