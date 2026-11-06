# ADR-019：用户自定义结构体与结构体数组（v3.3）

> 2026-10-20 · 状态：已采纳（编辑器 / 校验 / 解释器 / 运行时 / UI 检视器落地）
>
> 关联：ADR-001（IR）、ADR-003（NodeSpec）、ADR-014（内嵌蓝图）、ADR-015（函数作用域）。

## 背景

蓝图类型长期是「原语 + `T[]` 字符串后缀 + 任意别名」：

- 变量 / 函数参数下拉只有 `bool/int/float/string/object/any`（`VARIABLE_TYPES`），
  连数组都选不了；
- 自定义对象（如 `LogRow`）只能是节点库 / 插件里的硬编码 TS interface，
  用户无法在资产内声明字段；
- 列表列定义只能手填字段名字符串，没有结构校验；
- `var.get/set` 引脚恒为 `any`，Set 节点未连线时没有输入框，必须先连线。

结果是「多字段对象的列表」这个最常用的数据形态无法在编辑器里表达。
本 ADR 定义用户自定义结构体、结构体数组、Make/Break 节点与相关编辑体验。

## 决策

### 1. 契约（IR）

```ts
interface IRStructField { name: string; type: IRValueType; default?: unknown }
interface IRStructDef { name: string; fields: IRStructField[]; doc?: string }
```

- `IRAsset.types?: IRStructDef[]`；`UIAsset.types?` / `ElementAsset.types?` 同构
  （内嵌蓝图保存时经 `applyEmbeddedBlueprint` 写回 UI 资产）。
- 类型引用仍是字符串（结构体名 / `结构体名[]`）；`structDefOf(types, type)` 解析
  （数组自动取元素类型）。结构体按资产作用域，不做项目级注册。
- 字段名不可为空，禁用 `__proto__` / `prototype` / `constructor`；字段名唯一。
- 结构体名不可为空、不可与内置类型（原语 / 数组 / `uiHandle`）冲突；类型名唯一。
- 结构体可为空（编辑器允许先建类型后补字段），但 validation 对空类型给 warning。
- **版本不升**：`types` 为可选字段，旧资产读取即无类型；`IR_VERSION` 保持 3
  （与 ADR-006 comments / ADR-009 prefab 的可选字段先例一致）。

### 2. 结构体节点（动态引脚）

新增内置分类「结构体」：

| 节点 | 输入 | 输出 |
|---|---|---|
| `struct.make`（纯） | 字段表（id/type/default = 字段定义） | `value: 结构体名` |
| `struct.break`（纯） | `value: 结构体名` | 字段表 |

- 静态 `NodeSpec` 只声明 `params.typeName`（`type: 'structType'`）与元信息；
  数据引脚由 `src/ir/structs.ts` 的 `structPinsOf(node, types)` 展开。
- 视图 `dynamicPinsFor`、校验 `effectivePinsForNode`、解释器 `inputPinsOf`、
  连线预检 `resolvePinRef` 共用同一展开函数，避免口径漂移。
- `struct.make.run` 返回 `{ value: { ...inputs } }`；
  `struct.break.run` 按 `ctx.types` 的字段表拆值，缺失字段回落字段默认值 / null。
- `NodeRunContext.types` 由解释器注入（可选字段，旧节点不受影响）。

### 3. 编辑器体验

- My Blueprint 新增「类型」分节：新建 / 重命名 / 删除结构体；双击展开字段编辑
  （字段名、类型、删除、添加）；右键插入 Make/Break 节点。
- 统一类型选择器 `src/blueprint/type-picker.tsx`：
  基础类型 / 基础数组 / 结构体 / 结构体数组；用于变量、变量行内类型修改、
  函数入参/返回值、事件参数、结构体字段。
- 变量行类型徽标改为下拉（创建后可改）；变量右键「编辑默认值…」按类型给出
  文本 / 数字 / 布尔 / JSON 编辑器（数组与结构体可直接写样例数据）。
- `var.get/set` 的 spec 引脚仍为 `any`，但视图 / 连线预检 / Details 按变量声明
  类型显示颜色与默认值编辑器；Set 节点未连线时显示输入框，连线后隐藏（UE 同形）。
- 任意数据引脚的未连线默认值编辑扩展到 `object / any / 数组 / 自定义类型`
  （JSON；`any` 非法 JSON 时按纯文本提交）。
- UI 检视器「列定义」增加「从结构体生成列…」：读取 UI 资产与当前蓝图 store
  同资产 types，按字段填 `{ field, title }`，可继续手改颜色/分组/合并。

### 4. 校验

- 结构体定义：重复类型名 / 重复字段名 / 空名 / 保留字段名 / 字段 exec 类型 → error；
  空字段表 → warning（`struct-empty`）。
- 结构体节点：未选类型 / 类型未定义 → error（`struct-type-missing`）。
- 边级：结构体动态引脚参与 broken-edge / 类型可赋值判定；
  `var.get/set` 的 `value` 引脚按变量声明类型参与校验（不再用 any 放行）；
  顺带修复函数 `func.entry/return/flow.call`（资产内目标）动态引脚此前被误报
  broken-edge 的问题；项目/全局函数签名不在资产内时跳过引脚检查（不误报）。
- `isTypeAssignable` 增补：具体值（结构体 / 数组 / 标量）可赋给通用 `object` 引脚；
  反向仍需显式转换。exec 不参与。

### 5. 脚本视图（明确限制）

`struct.make/break` 暂不进入脚本 codegen / parser 往返：codegen 抛
「结构体节点暂不支持脚本视图」的中文 CodegenError，并在
`tests/roundtrip/samples.ts` 的 `KNOWN_UNMAPPED_NODE_IDS` 显式登记；
门禁计数恒等式保持。理由：动态字段引脚 + 多输出拆分需要 `bps.struct.*`
标记协议才能无损往返；先保证「绝不静默丢失节点」，后续单独补。

## 后果 / 边界

- 类型按资产作用域：场景 / 预制体 / 元素 / 独立 `.bp.json` 各自维护；
  跨资产共享（项目级类型库）是后续工作。
- 结构体字段默认值目前只在 Make 节点引脚 / Details 中可编辑；
  类型编辑器暂未提供字段默认值表单（IR 已支持 `field.default`）。
- 结构体节点不出现在「引脚拖出兼容节点菜单」中（静态 spec 无引脚）；
  通过 My Blueprint 类型行右键插入，或右键搜索「结构体」分类。
- 枚举、强类型 Map/Set、Data Table、高阶 filter/map 回调子图不在本 ADR 范围。

## 验证

- `src/ir/structs.test.ts`：动态引脚 / 序列化 / 校验 / object 可赋值 / 保留字段名；
- `src/blueprint/struct.test.ts`：类型 CRUD、改名级联、字段引脚级联、删除保护、
  irToFlow 动态引脚、类型选择器分组；
- `src/runtime/interpreter/interpreter.test.ts`：Make→Break 端到端 + 字段默认值；
- `src/blueprint/details/details.test.ts`：结构体类型参数保持、Make 字段默认值行、
  `var.set` 按变量类型渲染；
- `src/blueprint/view/bpnode-dom.test.ts`：Set 节点内联值编辑（int / any）与连线隐藏；
- `src/blueprint/my-blueprint/my-blueprint.test.ts`：类型分节 DOM、变量默认值编辑；
- 全量 1107 测试绿、typecheck 0 错、构建绿。
