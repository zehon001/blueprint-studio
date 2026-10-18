# ADR-011：IR v3 flex 布局契约（T9.1）

> 2026-10-18 · Arch-Agent · 状态：已采纳（增量落地，v2 字段保留为兼容层）

## 背景

v2 UINode 用 `transform`（position/size/rotation/anchors）+ `theme` + 容器 `props.spacing/align` 描述布局；v3 要求 Unity UIToolkit 式 flex 布局，编辑态与运行态同引擎。为控制回归面，本 ADR 采用**增量契约**：v3 字段（`layout`/`container`/`classes`）为真源，v2 `transform`/`theme` 保留为装载兼容层，渲染器以 layout 覆盖 transform。

## 契约

### UINode.layout（可选）

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| position | `relative \| absolute` | relative | relative 参与父 flex 流；absolute 脱离流 |
| grow | number | 0 | CSS flex-grow |
| shrink | number | 1 | CSS flex-shrink |
| basis | `number \| 'auto' \| '<n>%'` | auto | CSS flex-basis |
| alignSelf | auto/start/center/end/stretch | auto | CSS align-self |
| order | number | 0 | CSS order（仅流式） |
| size | `{w,h: number\|auto\|%}` | auto | 首选/绝对尺寸 |
| margin | `{t,r,b,l}` px | 0 | 外边距 |
| left/top/right/bottom | number/% | — | 仅 absolute；成对可拉伸 |

### UINode.container（可选，容器节点/元素根）

`direction(row|column，缺省 column)`、`wrap`、`justify(start|center|end|space-between|space-around|space-evenly)`、`align(start|center|end|stretch|baseline)`、`gap`(px)、`padding`、`overflow(visible|hidden|scroll→auto)`。容器自动 `display:flex; position:relative`（absolute 子项定位参照）。

### 渲染映射

- 编辑态/运行态共用 `renderUI`；layout/container 在 `applyContainer`/`applyFlexLayout` 写入内联样式，晚于 v2 渲染器 patch，保证覆盖。
- v2 节点（无 layout）行为不变（现有 23 控件/虚拟滚动/预制体展开回归全绿）。
- `classes` 仅保存，样式解析由 ADR-012（T11.1）接管。

## 版本与门禁

- 新资产 `version:3`；`parseUIAsset` 过渡期接受 2/3。
- **v2 拒载门禁**（项目/资产打开时明确报错）随 T13.2 模板重制收口——避免在模板仍为 v2 时提前锁死开发环境；`T13.2` 必须把 parse 收紧为只接受 3。
- `project.json.engineVersion` 主版本门禁同样在 T13.2 落地。

## 影响

- `src/ir/types.ts` 新增 `UILayout/UIContainer/UIEdges/UILength`，`UINode` 增加可选字段，`UIAsset` version 2|3 + v3 可选字段。
- 视口：`isNodeFreelyPositionable`/`readNodePosition`/`writeNodePosition` 按 layout 判定；relative 节点拒绝自由拖拽，absolute 节点可拖。
- 预制体展开保留实例 layout / 预制体 container / classes。
- 测试：`src/runtime/render/flex.test.ts` 4 项；既有 render/layout/prefab/viewport 55 项回归绿。
